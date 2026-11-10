import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config, ROOT, CATALOG_SECTIONS, DISLIKE_REASONS, assertProductionConfig } from './config.js';
import { db } from './db.js';
import { installNetwork } from './net.js';
import { imageHandler } from './images.js';
import { bus } from './events.js';
import { resolveScope, getOrgStructure, getFullAccess, setFullAccess } from './access.js';
import { queryDashboard, dashboardUsers } from './dashboard.js';
import { getRules, getLeadStages, saveRules } from './automation.js';
import { addByLink, updateLinkObject, addUploadedPhoto, photoPath } from './external/service.js';
import { createSession, requireSession, escapeHtml } from './session.js';
import {
  baseHeaders, b24Csp, clientCsp, newNonce, inlineAssets, rateLimit, guardEnumeration, notFound, isExternal,
} from './security.js';
import {
  validDomain, callWithToken, savePortal, getPortal, deletePortal, bindPlacements, scheduleTokenRefresh,
} from './bitrix.js';
import {
  searchCatalog, catalogStats, getObjectDetail, normalizeObjectUrl, crawlCatalog, scheduleCrawls,
} from './catalog/catalog.js';
import {
  createSelection, listSelectionsForAgent, getSelectionForAgent, setArchived,
  getPublicSelection, registerView, saveReaction, allowedEntities, scheduleDigests, deleteSelection,
} from './selections.js';

if (!config.devMode) {
  const problems = assertProductionConfig();
  if (problems.length) {
    console.error('Не заданы обязательные параметры в .env: ' + problems.join(', '));
    process.exit(1);
  }
  if (!config.b24AllowedDomains.length) {
    console.warn('ВНИМАНИЕ: B24_ALLOWED_DOMAINS не задан — приложение примет установку с любого портала, где есть его ключ.');
  }
}

if (config.devMode && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(config.baseUrl)) {
  console.error('DEV_MODE=1 разрешён только для локального адреса (BASE_URL=http://localhost:…). Остановка.');
  process.exit(1);
}

installNetwork(); // перебор адресов при подключении (см. src/net.js)

const app = express();
// Чьим заголовкам X-Forwarded-For доверять. В Docker прокси (nginx) приходит из внутренней сети — TRUST_PROXY=uniquelocal
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');
app.disable('x-powered-by');
app.use(baseHeaders);
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

const PUBLIC = path.join(ROOT, 'public');
const readTpl = (rel) => fs.readFileSync(path.join(PUBLIC, rel), 'utf8');
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Страница для Битрикс24: стартовые данные + весь CSS/JS встроены в ответ, строгая CSP с nonce. */
function sendB24Page(res, tpl, boot) {
  const nonce = newNonce();
  const json = JSON.stringify(boot).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, '');
  const html = readTpl(tpl).replace('<!--BOOT-->', `<script>window.__BOOT__ = ${json};</script>`);
  res.set({ 'Content-Security-Policy': b24Csp(nonce), 'Cache-Control': 'no-store' });
  res.type('html').send(inlineAssets(html, nonce));
}

// Публично раздаются только ресурсы страницы клиента; код интерфейса сотрудника встраивается в страницы Битрикс24
const staticOpts = { maxAge: config.devMode ? 0 : '1h', index: false, fallthrough: false };
app.use('/static/client', express.static(path.join(PUBLIC, 'client'), staticOpts));
app.use('/static/shared', express.static(path.join(PUBLIC, 'shared'), staticOpts));
app.get('/img', rateLimit('img', 900, 60e3), imageHandler);
// фото объектов, добавленных по ссылке (хранятся у нас)
app.get('/photo/:id/:file', rateLimit('img', 900, 60e3), (req, res) => {
  const p = photoPath(req.params.id, req.params.file);
  if (!p) return notFound(req, res);
  res.set({
    'Cache-Control': 'public, max-age=604800',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", // SVG-планировки: без скриптов
  });
  res.sendFile(p);
});
// проверка работоспособности — только изнутри сервера (Docker healthcheck), снаружи «не найдено»
app.get('/health', (req, res) => (isExternal(req) ? notFound(req, res) : res.json({ ok: true })));

// Ошибка входа через Битрикс24: пользователю — нейтральный текст, подробности — только в лог
class AccessError extends Error {
  constructor(logMessage) { super('Не удалось открыть приложение. Обратитесь к администратору портала.'); this.status = 403; this.log = logMessage; }
}

// ---------------- Битрикс24: установка ----------------

function authFromRequest(req) {
  const b = req.body || {};
  const q = req.query || {};
  return {
    accessToken: b.AUTH_ID || b.auth?.access_token,
    refreshToken: b.REFRESH_ID || b.auth?.refresh_token,
    expiresIn: b.AUTH_EXPIRES || b.auth?.expires_in,
    memberId: b.member_id || b.auth?.member_id,
    domain: validDomain(q.DOMAIN || b.auth?.domain),
    clientEndpoint: b.auth?.client_endpoint,
  };
}

/** Проверяем, что токен выдан именно нашему приложению на этом портале. */
async function verifyAppToken(domain, token) {
  const info = await callWithToken(domain, 'app.info', {}, token);
  const code = info.result?.CODE || info.result?.CLIENT_ID;
  if (config.b24ClientId && code !== config.b24ClientId) {
    throw Object.assign(new Error('Токен выдан другому приложению'), { status: 403 });
  }
  return info.result;
}

/**
 * Сохраняет доступ к порталу и регистрирует вкладки. Вызывается при установке и при первом открытии.
 * Принимается только ключ администратора портала: иначе сотрудник мог бы подменить служебный доступ приложения своим.
 */
async function installPortal(a, reason = 'install') {
  try {
    await verifyAppToken(a.domain, a.accessToken);
    const me = (await callWithToken(a.domain, 'user.current', {}, a.accessToken)).result;
    if (!me?.ADMIN) throw new Error(`пользователь ${me?.ID} не администратор портала`);
  } catch (e) {
    throw new AccessError(`[install] ${a.domain}: отказ (${reason}): ${e.message}`);
  }
  savePortal({ ...a });
  const results = await bindPlacements(a.domain, a.accessToken);
  console.log(`[install] ${a.domain} (${reason})`, JSON.stringify(results));
  return results;
}

const b24Limit = rateLimit('b24', 120, 60e3);

app.post('/b24/install', b24Limit, asyncH(async (req, res) => {
  const a = authFromRequest(req);
  if (!a.domain || !a.accessToken || !a.memberId) return notFound(req, res);
  const results = await installPortal(a);
  const failed = results.filter((r) => !r.ok);
  const nonce = newNonce();
  res.set({ 'Content-Security-Policy': b24Csp(nonce), 'Cache-Control': 'no-store' });
  res.type('html').send(inlineAssets(`<!doctype html><html lang="ru"><head><meta charset="utf-8">
<script src="https://api.bitrix24.com/api/v1/"></script>
<link rel="stylesheet" href="/static/shared/base.css"></head>
<body class="b24-page"><div class="install-box">
<h2>Приложение «Подборка» установлено</h2>
<p>В карточках лидов и сделок появилась вкладка <b>«Подборка»</b>.</p>
${failed.length ? `<p class="warn">Не удалось зарегистрировать: ${failed.map((f) => escapeHtml(`${f.placement || f.event}: ${f.error}`)).join('; ')}</p>` : ''}
</div>
<script>BX24.init(function(){ BX24.installFinish(); });</script></body></html>`, nonce));
}));

app.post('/b24/events', rateLimit('b24events', 20, 60e3), asyncH(async (req, res) => {
  const event = req.body?.event;
  const memberId = req.body?.auth?.member_id;
  if (event === 'ONAPPUNINSTALL' && memberId) {
    const portal = getPortal(memberId);
    if (portal) {
      // убеждаемся, что приложение действительно удалено: сохранённый токен больше не работает
      let stillValid = false;
      try { await callWithToken(portal.domain, 'app.info', {}, portal.access_token); stillValid = true; } catch { /* удалено */ }
      if (!stillValid) { deletePortal(memberId); console.log(`[uninstall] ${portal.domain}`); }
    }
  }
  res.json({ ok: true });
}));

// ---------------- Битрикс24: вкладка в карточке ----------------

async function buildAgentSession(req) {
  const a = authFromRequest(req);
  if (!a.accessToken || !a.memberId) throw Object.assign(new Error('Not found'), { status: 404, silent: true });
  let portal = getPortal(a.memberId);
  if (!portal) {
    // Битрикс24 вызывает адрес установки один раз; если тогда сервер был недоступен —
    // устанавливаемся при первом открытии (только администратором портала)
    if (!a.domain) throw new AccessError(`[install] нет данных портала ${a.memberId}, и в запросе нет DOMAIN`);
    await installPortal(a, 'первое открытие');
    portal = getPortal(a.memberId);
  }
  // запрос идёт только на сохранённый при установке домен портала
  let me;
  try {
    me = (await callWithToken(portal.domain, 'user.current', {}, a.accessToken)).result;
  } catch (e) {
    throw new AccessError(`[auth] ${portal.domain}: ключ пользователя не принят: ${e.message}`);
  }
  // Администратор открыл приложение — обновляем сохранённый доступ к порталу:
  // так подхватываются права, добавленные приложению после установки.
  if (me.ADMIN && a.refreshToken && a.domain === portal.domain) {
    savePortal({ ...a, clientEndpoint: portal.client_endpoint });
  }
  return {
    portal,
    accessToken: a.accessToken,
    base: {
      memberId: portal.member_id,
      userId: Number(me.ID),
      userName: [me.NAME, me.LAST_NAME].filter(Boolean).join(' ') || me.EMAIL || `Пользователь ${me.ID}`,
      isAdmin: !!me.ADMIN || config.appAdminIds.includes(Number(me.ID)),
      isAppAdmin: config.appAdminIds.includes(Number(me.ID)),
    },
  };
}

app.post('/b24/placement', b24Limit, asyncH(async (req, res) => {
  const { portal, accessToken, base } = await buildAgentSession(req);
  const placement = String(req.body.PLACEMENT || '');
  let options = {};
  try { options = JSON.parse(req.body.PLACEMENT_OPTIONS || '{}'); } catch { /* ignore */ }
  const entityType = placement === 'CRM_LEAD_DETAIL_TAB' ? 'lead' : placement === 'CRM_DEAL_DETAIL_TAB' ? 'deal' : null;
  const entityId = Number(options.ID);
  if (!entityType || !entityId) return notFound(req, res);

  // проверка доступа сотрудника к сущности (заодно получаем лид-источник сделки)
  let entity;
  try {
    entity = (await callWithToken(portal.domain, `crm.${entityType}.get`, { id: entityId }, accessToken)).result;
  } catch (e) {
    throw new AccessError(`[auth] нет доступа к ${entityType} ${entityId} у пользователя ${base.userId}: ${e.message}`);
  }
  const leadId = entityType === 'deal' && Number(entity.LEAD_ID) ? Number(entity.LEAD_ID) : null;

  const session = { ...base, entityType, entityId, leadId };
  sendB24Page(res, 'app/index.html', {
    token: createSession(session),
    entityType, entityId, leadId,
    entityTitle: entity.TITLE || '',
    user: { id: base.userId, name: base.userName },
    portalDomain: portal.domain,
    inBitrix: true,
    timezone: config.timezone,
  });
}));

// Главная страница приложения (пункт в меню «Приложения»)
app.post('/b24/handler', b24Limit, asyncH(async (req, res) => {
  const { portal, base } = await buildAgentSession(req);
  sendB24Page(res, 'app/dashboard.html', {
    token: createSession({ ...base, entityType: null, entityId: null }),
    user: { id: base.userId, name: base.userName, isAdmin: base.isAdmin },
    portalDomain: portal.domain, inBitrix: true, timezone: config.timezone,
    stats: catalogStats(),
    sections: CATALOG_SECTIONS.map((s) => ({ category: s.category, label: s.label })),
  });
}));

// ---------------- API сотрудника ----------------

const api = express.Router();
api.use(requireSession);

const requireEntity = (req, res, next) => {
  if (!req.session.entityType || !req.session.entityId) return res.status(400).json({ error: 'Откройте вкладку из карточки лида или сделки' });
  next();
};

api.get('/catalog/meta', (_req, res) => {
  res.json({
    sections: [...CATALOG_SECTIONS.map((s) => ({ category: s.category, label: s.label, deal: s.deal })),
      { category: 'external', label: 'Добавленные по ссылке (застройщики, ЦИАН, Авито…)', deal: 'sale' }],
    reasons: DISLIKE_REASONS,
    stats: catalogStats(),
    siteUrl: config.siteUrl,
  });
});
api.get('/catalog/search', (req, res) => res.json(searchCatalog(req.query)));
api.get('/catalog/object/:id', asyncH(async (req, res) => {
  const o = await getObjectDetail({ id: Number(req.params.id) });
  if (!o) return res.status(404).json({ error: 'Объект не найден' });
  res.json(o);
}));
const linkLimit = rateLimit('link', 30, 60e3);
api.post('/catalog/resolve', linkLimit, asyncH(async (req, res) => {
  const url = normalizeObjectUrl(req.body?.url);
  if (!url) {
    // любой другой сайт: застройщики, ЦИАН, Авито… — универсальный разбор или черновик для ручного заполнения
    const r = await addByLink(req.body?.url, req.session);
    const o = await getObjectDetail({ id: r.id });
    return res.json({ ...o, existed: r.existed, warning: r.warning || null });
  }
  let o;
  try { o = await getObjectDetail({ url }, { force: true }); } catch (e) {
    return res.status(e.status === 404 ? 404 : 502).json({ error: e.status === 404 ? 'Объект не найден на сайте' : 'Сайт не ответил, попробуйте ещё раз' });
  }
  if (!o?.id) return res.status(404).json({ error: 'По ссылке не найден объект недвижимости' });
  res.json(o);
}));
api.post('/catalog/recrawl', (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Только для администратора портала' });
  crawlCatalog().catch((e) => console.warn('[crawl]', e.message));
  res.json({ started: true });
});

// правка объекта, добавленного по ссылке (объекты с newflat72.ru не редактируются)
api.patch('/objects/:id', (req, res) => {
  const ok = updateLinkObject(Number(req.params.id), req.body || {}, req.session);
  if (!ok) return res.status(404).json({ error: 'Объект не найден или не редактируется' });
  getObjectDetail({ id: Number(req.params.id) }).then((o) => res.json(o));
});
api.post('/objects/:id/photos', rateLimit('upload', 120, 60e3), express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '15mb' }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Нужна фотография JPG, PNG или WEBP' });
  const r = addUploadedPhoto(Number(req.params.id), req.body);
  if (r.error === 'not_found') return res.status(404).json({ error: 'Объект не найден или не редактируется' });
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});

// Живые изменения подборок карточки (Server-Sent Events). Объявлен до /selections/:id.
api.get('/selections/stream', requireEntity, (req, res) => {
  const ents = allowedEntities(req.session);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no', // nginx не буферизует поток
  });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  const onChange = (e) => {
    if (e.memberId !== req.session.memberId) return;
    if (!ents.some((x) => x.type === e.entityType && x.id === e.entityId)) return;
    res.write(`event: change\ndata: ${JSON.stringify({ selectionId: e.selectionId, kind: e.kind })}\n\n`);
  };
  bus.on('selection', onChange);
  const ping = setInterval(() => res.write(': ping\n\n'), 25e3);
  req.on('close', () => { clearInterval(ping); bus.off('selection', onChange); });
});

api.get('/selections', requireEntity, (req, res) => res.json(listSelectionsForAgent(req.session)));
api.post('/selections', requireEntity, asyncH(async (req, res) => {
  const sel = await createSelection(req.session, req.body || {});
  res.json(sel);
}));
api.get('/selections/:id', requireEntity, (req, res) => {
  const s = getSelectionForAgent(req.session, Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Подборка не найдена' });
  res.json(s);
});
api.delete('/selections/:id', requireEntity, (req, res) => {
  const r = deleteSelection(req.session, Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Подборка не найдена' });
  if (r === 'not_archived') return res.status(400).json({ error: 'Удалить можно только подборку из архива' });
  if (r === 'forbidden') return res.status(403).json({ error: 'Удалить подборку может её автор или администратор' });
  res.json({ ok: true });
});
api.post('/selections/:id/archive', requireEntity, (req, res) => {
  const ok = setArchived(req.session, Number(req.params.id), !!req.body?.archived);
  if (!ok) return res.status(404).json({ error: 'Подборка не найдена' });
  res.json({ ok: true });
});


// ---------------- Публичная часть для клиента ----------------

const pub = express.Router();
pub.use(guardEnumeration, rateLimit('public', 300, 60e3));
pub.get('/:token', (req, res) => {
  const s = getPublicSelection(req.params.token);
  if (!s) return res.status(404).json({ error: 'Подборка не найдена или больше недоступна' });
  res.set('Cache-Control', 'no-store').json(s);
});
pub.post('/:token/view', (req, res) => { registerView(req.params.token); res.json({ ok: true }); });
pub.post('/:token/items/:itemId', (req, res) => {
  const ok = saveReaction(req.params.token, req.params.itemId, req.body || {});
  if (!ok) return res.status(404).json({ error: 'Не найдено' });
  res.json({ ok: true });
});

// ---------------- Дашборд ----------------

const ROLE_LABELS = {
  app_admin: 'Главный администратор приложения — все подборки и настройки',
  admin: 'Администратор портала — все подборки',
  full_access: 'Полный доступ — все подборки',
  company_head: 'Руководитель компании — все подборки',
  head: 'Руководитель — ваши подборки и подборки сотрудников подразделения',
  employee: 'Ваши подборки',
};

api.get('/dashboard', asyncH(async (req, res) => {
  const s = req.session;
  const scope = await resolveScope(s);
  const portal = getPortal(s.memberId);
  const org = scope.all ? null : await getOrgStructure(s.memberId);
  const result = queryDashboard(s.memberId, scope, req.query, portal?.domain || '');
  res.json({
    scope: {
      role: scope.role, all: !!scope.all, label: ROLE_LABELS[scope.role] || '',
      departments: scope.departments || [], people: scope.all ? null : scope.userIds.length, warning: scope.warning || null,
    },
    users: dashboardUsers(s.memberId, scope, org),
    catalog: catalogStats(),
    ...result,
  });
}));

const requireAdmin = (req, res, next) => (req.session.isAdmin ? next() : res.status(403).json({ error: 'Только для администратора портала' }));
api.get('/settings/full-access', requireAdmin, (req, res) => res.json({ users: getFullAccess(req.session.memberId) }));
api.get('/settings/stage-rules', requireAdmin, asyncH(async (req, res) => {
  try {
    const [rules, stages] = await Promise.all([getRules(req.session.memberId), getLeadStages(req.session.memberId, { force: true })]);
    res.json({ rules, stages });
  } catch (e) {
    res.json({ rules: null, stages: [], error: 'Не удалось получить стадии лидов из Битрикс24: ' + e.message });
  }
}));
api.post('/settings/stage-rules', requireAdmin, (req, res) => res.json({ rules: saveRules(req.session.memberId, req.body || {}) }));
api.post('/settings/full-access', requireAdmin, (req, res) => res.json({ users: setFullAccess(req.session.memberId, req.body?.users) }));

app.use('/api/public', pub);
app.use('/api', api); // после публичного роутера: требует сессию сотрудника

const publicHost = new URL(config.publicUrl).host;
app.get('/s/:token', guardEnumeration, rateLimit('page', 120, 60e3), (req, res) => {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(req.params.token)) return notFound(req, res);
  // старые ссылки на служебном адресе — на адрес для клиентов
  if (isExternal(req) && req.get('host') !== publicHost && config.publicUrl !== config.baseUrl) {
    return res.redirect(301, `${config.publicUrl}/s/${req.params.token}`);
  }
  res.set({ 'Cache-Control': 'no-store', 'Content-Security-Policy': clientCsp() });
  res.type('html').send(readTpl('client/index.html'));
});

// ---------------- Режим разработки ----------------

if (config.devMode) {
  db.prepare(`INSERT OR IGNORE INTO portals (member_id, domain, client_endpoint) VALUES ('dev', 'dev.bitrix24.ru', 'https://dev.bitrix24.ru/rest/')`).run();
  app.get('/dev/placement', (req, res) => {
    const entityType = req.query.entity === 'deal' ? 'deal' : 'lead';
    const entityId = Number(req.query.id) || 1;
    const session = { memberId: 'dev', userId: 1, userName: 'Тестовый Сотрудник', isAdmin: true, entityType, entityId, leadId: null };
    sendB24Page(res, 'app/index.html', {
      token: createSession(session), entityType, entityId, leadId: null, entityTitle: `Тестовый ${entityType} #${entityId}`,
      user: { id: 1, name: session.userName }, portalDomain: 'dev.bitrix24.ru', inBitrix: false, timezone: config.timezone,
    });
  });
  app.get('/dev/dashboard', (req, res) => {
    const isAdmin = req.query.admin !== '0';
    const userId = Number(req.query.user) || 1;
    const base = { memberId: 'dev', userId, userName: `Тестовый пользователь ${userId}`, isAdmin };
    sendB24Page(res, 'app/dashboard.html', {
      token: createSession({ ...base, entityType: null, entityId: null }),
      user: { id: userId, name: base.userName, isAdmin }, portalDomain: 'dev.bitrix24.ru', inBitrix: false, timezone: config.timezone,
      stats: catalogStats(), sections: CATALOG_SECTIONS.map((s) => ({ category: s.category, label: s.label })),
    });
  });
  console.log('DEV: вкладка доступна по адресу /dev/placement?entity=lead&id=1, дашборд — /dev/dashboard');
}

// ---------------- Ошибки ----------------

// всё остальное (в том числе корень сайта) — нейтральное «не найдено»
app.use(notFound);

app.use((err, req, res, _next) => {
  if (err.status === 404 && err.silent) return notFound(req, res);
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: 'Bad request' });
  const status = err.status || 500;
  if (err.log) console.warn(err.log);
  else if (status >= 500) console.error(err);
  const msg = status >= 500 && !err.code ? 'Внутренняя ошибка' : err.message;
  if (req.path.startsWith('/api/')) return res.status(status).json({ error: msg });
  res.status(status).set('Cache-Control', 'no-store').type('html')
    .send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Ошибка</title>
<body style="font:15px/1.5 sans-serif;color:#333;padding:40px 16px;text-align:center"><p>${escapeHtml(msg)}</p></body>`);
});

export { app };

// в тестах сервер запускается отдельно (NO_LISTEN=1)
if (process.env.NO_LISTEN !== '1') app.listen(config.port, config.host, () => {
  console.log(`Подборка: http://${config.host}:${config.port} (приложение ${config.baseUrl}, ссылки для клиентов ${config.publicUrl})`);
  scheduleCrawls();
  scheduleTokenRefresh();
  scheduleDigests();
});
