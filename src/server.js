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
import { createSession, requireSession, escapeHtml } from './session.js';
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

installNetwork(); // перебор адресов при подключении (см. src/net.js)

const app = express();
// Чьим заголовкам X-Forwarded-For доверять. В Docker прокси (nginx) приходит из внутренней сети — TRUST_PROXY=uniquelocal
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

const PUBLIC = path.join(ROOT, 'public');
const readTpl = (rel) => fs.readFileSync(path.join(PUBLIC, rel), 'utf8');
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Вставляет стартовые данные в HTML-шаблон (безопасно для <script>). */
function renderWithBoot(tpl, boot) {
  const json = JSON.stringify(boot).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, '');
  return readTpl(tpl).replace('<!--BOOT-->', `<script>window.__BOOT__ = ${json};</script>`);
}

app.use('/static', express.static(PUBLIC, { maxAge: config.devMode ? 0 : '1h', index: false }));
app.get('/img', imageHandler);
app.get('/health', (_req, res) => res.json({ ok: true }));

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

/** Сохраняет доступ к порталу и регистрирует вкладки. Вызывается при установке и при первом открытии. */
async function installPortal(a, reason = 'install') {
  try {
    await verifyAppToken(a.domain, a.accessToken);
  } catch (e) {
    console.warn(`[install] ${a.domain}: отказ (${reason}): ${e.message}`);
    throw e;
  }
  savePortal({ ...a });
  const results = await bindPlacements(a.domain, a.accessToken);
  console.log(`[install] ${a.domain} (${reason})`, JSON.stringify(results));
  return results;
}

app.all('/b24/install', asyncH(async (req, res) => {
  const a = authFromRequest(req);
  if (!a.domain || !a.accessToken || !a.memberId) {
    return res.status(400).send('Откройте установку из Битрикс24.');
  }
  const results = await installPortal(a);
  const failed = results.filter((r) => !r.ok);
  res.type('html').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8">
<script src="https://api.bitrix24.com/api/v1/"></script>
<link rel="stylesheet" href="/static/shared/base.css"></head>
<body class="b24-page"><div class="install-box">
<h2>Приложение «Подборка» установлено</h2>
<p>В карточках лидов и сделок появилась вкладка <b>«Подборка»</b>.</p>
${failed.length ? `<p class="warn">Не удалось зарегистрировать: ${failed.map((f) => escapeHtml(`${f.placement || f.event}: ${f.error}`)).join('; ')}</p>` : ''}
</div>
<script>BX24.init(function(){ BX24.installFinish(); });</script></body></html>`);
}));

app.post('/b24/events', asyncH(async (req, res) => {
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
  if (!a.accessToken || !a.memberId) throw Object.assign(new Error('Откройте приложение из Битрикс24.'), { status: 400 });
  let portal = getPortal(a.memberId);
  if (!portal) {
    // Битрикс24 вызывает адрес установки один раз; если тогда сервер был недоступен — устанавливаемся сейчас
    if (!a.domain) {
      console.warn(`[install] нет данных портала ${a.memberId}, и в запросе нет DOMAIN`);
      throw Object.assign(new Error('Приложение не установлено на этом портале. Переустановите его.'), { status: 403 });
    }
    await installPortal(a, 'первое открытие');
    portal = getPortal(a.memberId);
  }
  // запрос идёт только на сохранённый при установке домен портала
  const me = (await callWithToken(portal.domain, 'user.current', {}, a.accessToken)).result;
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

app.post('/b24/placement', asyncH(async (req, res) => {
  const { portal, accessToken, base } = await buildAgentSession(req);
  const placement = String(req.body.PLACEMENT || '');
  let options = {};
  try { options = JSON.parse(req.body.PLACEMENT_OPTIONS || '{}'); } catch { /* ignore */ }
  const entityType = placement === 'CRM_LEAD_DETAIL_TAB' ? 'lead' : placement === 'CRM_DEAL_DETAIL_TAB' ? 'deal' : null;
  const entityId = Number(options.ID);
  if (!entityType || !entityId) return res.status(400).send('Неизвестное место встраивания');

  // проверка доступа сотрудника к сущности (заодно получаем лид-источник сделки)
  const entity = (await callWithToken(portal.domain, `crm.${entityType}.get`, { id: entityId }, accessToken)).result;
  const leadId = entityType === 'deal' && Number(entity.LEAD_ID) ? Number(entity.LEAD_ID) : null;

  const session = { ...base, entityType, entityId, leadId };
  res.type('html').send(renderWithBoot('app/index.html', {
    token: createSession(session),
    entityType, entityId, leadId,
    entityTitle: entity.TITLE || '',
    user: { id: base.userId, name: base.userName },
    portalDomain: portal.domain,
    inBitrix: true,
    timezone: config.timezone,
  }));
}));

// Главная страница приложения (пункт в меню «Приложения»)
app.post('/b24/handler', asyncH(async (req, res) => {
  const { portal, base } = await buildAgentSession(req);
  res.type('html').send(renderWithBoot('app/dashboard.html', {
    token: createSession({ ...base, entityType: null, entityId: null }),
    user: { id: base.userId, name: base.userName, isAdmin: base.isAdmin },
    portalDomain: portal.domain, inBitrix: true, timezone: config.timezone,
    stats: catalogStats(),
    sections: CATALOG_SECTIONS.map((s) => ({ category: s.category, label: s.label })),
  }));
}));
app.get('/b24/handler', (_req, res) => res.redirect('/'));

// ---------------- API сотрудника ----------------

const api = express.Router();
api.use(requireSession);

const requireEntity = (req, res, next) => {
  if (!req.session.entityType || !req.session.entityId) return res.status(400).json({ error: 'Откройте вкладку из карточки лида или сделки' });
  next();
};

api.get('/catalog/meta', (_req, res) => {
  res.json({
    sections: CATALOG_SECTIONS.map((s) => ({ category: s.category, label: s.label, deal: s.deal })),
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
api.post('/catalog/resolve', asyncH(async (req, res) => {
  const url = normalizeObjectUrl(req.body?.url);
  if (!url) return res.status(400).json({ error: `Нужна ссылка на объект с ${new URL(config.siteUrl).host}` });
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

// простое ограничение частоты запросов по IP
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip + req.path.split('/').slice(0, 4).join('/');
    const now = Date.now();
    const h = hits.get(key) || { n: 0, t: now };
    if (now - h.t > windowMs) { h.n = 0; h.t = now; }
    h.n++;
    hits.set(key, h);
    if (h.n > max) return res.status(429).json({ error: 'Слишком много запросов, попробуйте позже' });
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.t > 600e3) hits.delete(k); }, 600e3).unref();

const pub = express.Router();
pub.use(rateLimit(240, 60e3));
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

app.get('/s/:token', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.type('html').send(readTpl('client/index.html'));
});

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Подборка объектов</title>
<link rel="stylesheet" href="/static/shared/base.css"><body class="b24-page"><div class="install-box">
<h2>Подборка объектов для Битрикс24</h2><p>Приложение работает внутри портала Битрикс24 — откройте вкладку «Подборка» в карточке лида или сделки.</p></div>`);
});

// ---------------- Режим разработки ----------------

if (config.devMode) {
  db.prepare(`INSERT OR IGNORE INTO portals (member_id, domain, client_endpoint) VALUES ('dev', 'dev.bitrix24.ru', 'https://dev.bitrix24.ru/rest/')`).run();
  app.get('/dev/placement', (req, res) => {
    const entityType = req.query.entity === 'deal' ? 'deal' : 'lead';
    const entityId = Number(req.query.id) || 1;
    const session = { memberId: 'dev', userId: 1, userName: 'Тестовый Сотрудник', isAdmin: true, entityType, entityId, leadId: null };
    res.type('html').send(renderWithBoot('app/index.html', {
      token: createSession(session), entityType, entityId, leadId: null, entityTitle: `Тестовый ${entityType} #${entityId}`,
      user: { id: 1, name: session.userName }, portalDomain: 'dev.bitrix24.ru', inBitrix: false, timezone: config.timezone,
    }));
  });
  app.get('/dev/dashboard', (req, res) => {
    const isAdmin = req.query.admin !== '0';
    const userId = Number(req.query.user) || 1;
    const base = { memberId: 'dev', userId, userName: `Тестовый пользователь ${userId}`, isAdmin };
    res.type('html').send(renderWithBoot('app/dashboard.html', {
      token: createSession({ ...base, entityType: null, entityId: null }),
      user: { id: userId, name: base.userName, isAdmin }, portalDomain: 'dev.bitrix24.ru', inBitrix: false, timezone: config.timezone,
      stats: catalogStats(), sections: CATALOG_SECTIONS.map((s) => ({ category: s.category, label: s.label })),
    }));
  });
  console.log('DEV: вкладка доступна по адресу /dev/placement?entity=lead&id=1, дашборд — /dev/dashboard');
}

// ---------------- Ошибки ----------------

app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  const msg = status >= 500 && !err.code ? 'Внутренняя ошибка' : err.message;
  if (req.path.startsWith('/api/')) return res.status(status).json({ error: msg });
  res.status(status).type('html').send(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/static/shared/base.css">
<body class="b24-page"><div class="install-box"><h3>Ошибка</h3><p>${escapeHtml(msg)}</p></div>`);
});

app.listen(config.port, config.host, () => {
  console.log(`Подборка: http://${config.host}:${config.port} (публичный адрес ${config.baseUrl})`);
  scheduleCrawls();
  scheduleTokenRefresh();
  scheduleDigests();
});
