import { db } from './db.js';
import { config, DISLIKE_REASONS } from './config.js';
import { newPublicToken } from './session.js';
import { getObjectDetail, getObjectRow } from './catalog/catalog.js';
import { callAsApp, getPortal } from './bitrix.js';
import { proxyObject } from './images.js';
import { emitSelectionChange } from './events.js';
import { startForSelection, checkSelection } from './automation.js';

const MAX_ITEMS = 50;

export const publicLink = (token) => `${config.baseUrl}/s/${token}`;

/** «Подборка на 09.11.2026 14:05» по времени агентства (Тюмень). */
export function defaultTitle(date = new Date(), timeZone = config.timezone) {
  const f = new Intl.DateTimeFormat('ru-RU', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return `Подборка на ${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
}

function snapshotOf(o) {
  return {
    id: o.id, url: o.url, title: o.title, address: o.address, lat: o.lat, lng: o.lng, price: o.price,
    price_per_m2: o.price_per_m2 || null, rooms: o.rooms, floor: o.floor, floors: o.floors,
    area_total: o.area_total, area_living: o.area_living, area_kitchen: o.area_kitchen,
    category: o.category, categoryLabel: o.categoryLabel, deal: o.deal, district: o.district || null,
    thumb: o.thumb || o.photos?.[0]?.small || null, photos: (o.photos || []).slice(0, 30),
    props: o.props || {}, description: o.description || '',
  };
}

/** Создание подборки: подтягиваем актуальные карточки объектов и сохраняем снимок. */
export async function createSelection(session, { title, message, items }) {
  if (!Array.isArray(items) || !items.length) throw Object.assign(new Error('Добавьте хотя бы один объект'), { status: 400 });
  if (items.length > MAX_ITEMS) throw Object.assign(new Error(`Не более ${MAX_ITEMS} объектов в подборке`), { status: 400 });

  const unique = [];
  for (const it of items) {
    const id = Number(it.id);
    if (Number.isInteger(id) && id > 0 && !unique.some((u) => u.id === id)) unique.push({ id, note: String(it.note || '').slice(0, 1000) });
  }
  const objects = [];
  for (const it of unique) {
    const row = getObjectRow(it.id);
    if (!row) throw Object.assign(new Error(`Объект ${it.id} не найден в каталоге`), { status: 400 });
    const detail = await getObjectDetail({ id: it.id }).catch(() => null);
    objects.push({ snapshot: snapshotOf(detail || row), note: it.note });
  }

  const token = newPublicToken();
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO selections (token, member_id, entity_type, entity_id, title, message, created_by_id, created_by_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(token, session.memberId, session.entityType, session.entityId,
      String(title || '').trim().slice(0, 200) || defaultTitle(), String(message || '').slice(0, 3000) || null,
      session.userId || null, session.userName || null);
    const ins = db.prepare('INSERT INTO selection_items (selection_id, object_id, position, snapshot_json, agent_note) VALUES (?, ?, ?, ?, ?)');
    objects.forEach((o, i) => ins.run(info.lastInsertRowid, o.snapshot.id, i, JSON.stringify(o.snapshot), o.note || null));
    return info.lastInsertRowid;
  });
  const id = tx();
  // автоматизация стадий: новая подборка запускает сценарий заново
  const created = db.prepare('SELECT * FROM selections WHERE id = ?').get(id);
  startForSelection(created);
  checkSelection(id).catch((e) => console.warn('[automation]', e.message));
  return getSelectionForAgent(session, id);
}

function itemView(r, { full = false } = {}) {
  const snap = proxyObject(JSON.parse(r.snapshot_json));
  const current = getObjectRow(r.object_id);
  const base = {
    itemId: r.id, objectId: r.object_id, position: r.position, agentNote: r.agent_note,
    reaction: r.reaction, reasons: r.reasons_json ? JSON.parse(r.reasons_json) : [],
    clientComment: r.client_comment, wantViewing: !!r.want_viewing, reactedAt: r.reacted_at,
    removed: current ? !current.active : false,
    currentPrice: current?.price ?? null,
  };
  if (full) return { ...base, object: snap };
  return {
    ...base,
    object: {
      id: snap.id, url: snap.url, title: snap.title, address: snap.address, price: snap.price, thumb: snap.thumb,
      rooms: snap.rooms, floor: snap.floor, floors: snap.floors, area_total: snap.area_total, categoryLabel: snap.categoryLabel,
    },
  };
}

function selectionView(s, items, opts) {
  const its = items.map((r) => itemView(r, opts));
  return {
    id: s.id, token: s.token, link: publicLink(s.token), entityType: s.entity_type, entityId: s.entity_id,
    title: s.title, message: s.message, createdById: s.created_by_id, createdByName: s.created_by_name,
    createdAt: s.created_at, firstViewedAt: s.first_viewed_at, lastViewedAt: s.last_viewed_at, viewCount: s.view_count,
    submittedAt: s.submitted_at, submitCount: s.submit_count, archived: !!s.archived,
    lastActivityAt: s.last_activity_at, digestPending: !!s.digest_pending,
    autoState: s.auto_state, autoNote: s.auto_note,
    stats: {
      total: its.length,
      liked: its.filter((i) => i.reaction === 'like').length,
      disliked: its.filter((i) => i.reaction === 'dislike').length,
      viewing: its.filter((i) => i.wantViewing).length,
    },
    items: its,
  };
}

const itemsOf = (selectionId) => db.prepare('SELECT * FROM selection_items WHERE selection_id = ? ORDER BY position, id').all(selectionId);

/** Доступные сессии сущности: сама сущность и, для сделки, лид-источник. */
export function allowedEntities(session) {
  const list = [{ type: session.entityType, id: session.entityId }];
  if (session.entityType === 'deal' && session.leadId) list.push({ type: 'lead', id: session.leadId });
  return list;
}

function canAccess(session, s) {
  return s && s.member_id === session.memberId && allowedEntities(session).some((e) => e.type === s.entity_type && e.id === s.entity_id);
}

export function listSelectionsForAgent(session) {
  const ents = allowedEntities(session);
  const rows = [];
  for (const e of ents) {
    rows.push(...db.prepare('SELECT * FROM selections WHERE member_id = ? AND entity_type = ? AND entity_id = ?').all(session.memberId, e.type, e.id));
  }
  rows.sort((a, b) => b.id - a.id);
  const selections = rows.map((s) => selectionView(s, itemsOf(s.id)));
  // История реакций по объектам — чтобы при новой подборке видеть, что уже отправляли
  const sentObjects = {};
  for (const s of selections.slice().reverse()) {
    for (const it of s.items) {
      sentObjects[it.objectId] = { selectionId: s.id, reaction: it.reaction, reasons: it.reasons, at: s.createdAt };
    }
  }
  return { selections, sentObjects };
}

export function getSelectionForAgent(session, id) {
  const s = db.prepare('SELECT * FROM selections WHERE id = ?').get(id);
  if (!canAccess(session, s)) return null;
  return selectionView(s, itemsOf(s.id), { full: true });
}

export function setArchived(session, id, archived) {
  const s = db.prepare('SELECT * FROM selections WHERE id = ?').get(id);
  if (!canAccess(session, s)) return false;
  db.prepare('UPDATE selections SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id);
  return true;
}

// ---------- Публичная часть (клиент) ----------

function getByToken(token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ''))) return null;
  return db.prepare('SELECT * FROM selections WHERE token = ?').get(token);
}

export function getPublicSelection(token) {
  const s = getByToken(token);
  if (!s || s.archived) return null;
  const items = itemsOf(s.id).map((r) => {
    const v = itemView(r, { full: true });
    return {
      itemId: v.itemId, agentNote: v.agentNote, reaction: v.reaction, reasons: v.reasons,
      clientComment: v.clientComment, wantViewing: v.wantViewing, removed: v.removed, object: v.object,
    };
  });
  return {
    title: s.title, message: s.message, agentName: s.created_by_name, createdAt: s.created_at,
    submittedAt: s.submitted_at, items,
    agency: { name: config.agencyName, phone: config.agencyPhone, logo: config.agencyLogo, site: config.siteUrl },
    reasons: DISLIKE_REASONS,
  };
}

/** Фиксация просмотра. Первое открытие — уведомление сотруднику. */
export function registerView(token) {
  const s = getByToken(token);
  if (!s || s.archived) return;
  const first = !s.first_viewed_at;
  db.prepare(`UPDATE selections SET view_count = view_count + 1, last_viewed_at = datetime('now'),
    first_viewed_at = COALESCE(first_viewed_at, datetime('now')) WHERE id = ?`).run(s.id);
  emitSelectionChange(s, 'view');
  // пока лид не дошёл до «Обсуждения вариантов», проверяем стадию не чаще раза в 2 минуты
  const checkedAgo = s.auto_checked_at ? Date.now() - Date.parse(s.auto_checked_at.replace(' ', 'T') + 'Z') : Infinity;
  if (s.auto_state === 'waiting' && checkedAgo > 2 * 60e3) {
    checkSelection(s.id).catch((e) => console.warn('[automation]', e.message));
  }
  if (first) {
    notifyAgents(s, `Клиент открыл подборку «${selectionName(s)}» (${entityLink(s)}).`).catch((e) => console.warn('[notify]', e.message));
  }
}

export function saveReaction(token, itemId, { reaction, reasons, comment, wantViewing }) {
  const s = getByToken(token);
  if (!s || s.archived) return null;
  const item = db.prepare('SELECT * FROM selection_items WHERE id = ? AND selection_id = ?').get(Number(itemId), s.id);
  if (!item) return null;
  const r = reaction === 'like' || reaction === 'dislike' ? reaction : null;
  const rs = Array.isArray(reasons) ? reasons.filter((x) => DISLIKE_REASONS.includes(x)).slice(0, DISLIKE_REASONS.length) : [];
  db.prepare(`UPDATE selection_items SET reaction = ?, reasons_json = ?, client_comment = ?, want_viewing = ?, reacted_at = datetime('now') WHERE id = ?`)
    .run(r, r === 'dislike' ? JSON.stringify(rs) : null, String(comment || '').slice(0, 2000) || null, r === 'like' && wantViewing ? 1 : 0, item.id);
  // отметка активности: сводка в таймлайн уйдёт, когда клиент перестанет вносить изменения
  db.prepare(`UPDATE selections SET last_activity_at = datetime('now'), digest_pending = 1 WHERE id = ?`).run(s.id);
  emitSelectionChange(s, 'reaction');
  return true;
}

/**
 * Сводка в таймлайн и уведомление сотрудникам. Отправляется автоматически,
 * когда клиент не вносил изменений digestDelayMin минут; при новых изменениях — повторно.
 */
async function sendDigest(s) {
  // снимаем флаг до отправки, чтобы при параллельном запуске не отправить дважды
  const claimed = db.prepare(`UPDATE selections SET digest_pending = 0, submitted_at = datetime('now'), submit_count = submit_count + 1
    WHERE id = ? AND digest_pending = 1`).run(s.id);
  if (!claimed.changes) return false;
  const items = itemsOf(s.id).map((r) => itemView(r, { full: true }));
  if (!items.some((i) => i.reaction || i.clientComment)) return false;
  try {
    await callAsApp(s.member_id, 'crm.timeline.comment.add', {
      fields: {
        ENTITY_ID: s.entity_id,
        ENTITY_TYPE: s.entity_type,
        COMMENT: buildFeedbackComment(s, items),
        ...(s.created_by_id ? { AUTHOR_ID: s.created_by_id } : {}),
      },
    });
  } catch (e) {
    console.warn('[timeline]', e.message);
  }
  const liked = items.filter((i) => i.reaction === 'like').length;
  const disliked = items.filter((i) => i.reaction === 'dislike').length;
  const viewing = items.filter((i) => i.wantViewing).length;
  const rated = items.filter((i) => i.reaction).length;
  const verb = s.submit_count > 0 ? 'Клиент изменил оценки' : 'Клиент оценил подборку';
  notifyAgents(s, `${verb} «${selectionName(s)}» (${entityLink(s)}): оценено ${rated} из ${items.length}, 👍 ${liked}, 👎 ${disliked}${viewing ? `, на просмотр: ${viewing}` : ''}.`)
    .catch((e) => console.warn('[notify]', e.message));
  emitSelectionChange(s, 'digest');
  try {
    await checkSelection(s.id, { evaluate: true, items });
  } catch (e) {
    console.warn('[automation]', e.message);
  }
  return true;
}

/** Отправляет сводки по подборкам, где клиент затих. */
export async function processPendingDigests(delayMin = config.digestDelayMin) {
  const due = db.prepare(`SELECT * FROM selections WHERE digest_pending = 1 AND archived = 0
    AND last_activity_at <= datetime('now', ?)`).all(`-${Math.max(0, Number(delayMin) || 0) * 60} seconds`);
  let sent = 0;
  for (const s of due) {
    try { if (await sendDigest(s)) sent++; } catch (e) { console.warn('[digest]', e.message); }
  }
  return sent;
}

export function scheduleDigests() {
  const t = setInterval(() => { processPendingDigests().catch((e) => console.warn('[digest]', e.message)); }, 30e3);
  t.unref?.();
}

function selectionName(s) {
  return s.title || `Подборка №${s.id}`;
}

function entityLink(s) {
  const portal = getPortal(s.member_id);
  const label = s.entity_type === 'lead' ? `лид #${s.entity_id}` : `сделка #${s.entity_id}`;
  if (!portal) return label;
  return `[URL=https://${portal.domain}/crm/${s.entity_type}/details/${s.entity_id}/]${label}[/URL]`;
}

const fmtPrice = (p) => (p ? p.toLocaleString('ru-RU') + ' ₽' : 'цена не указана');

export function buildFeedbackComment(s, items) {
  const lines = [];
  lines.push(`[B]Обратная связь по подборке «${selectionName(s)}»[/B]${s.submit_count > 0 ? ' (обновлено)' : ''}`);
  lines.push(`Ссылка: [URL=${publicLink(s.token)}]${publicLink(s.token)}[/URL]`);
  lines.push('');
  const group = (title, filter) => {
    const list = items.filter(filter);
    if (!list.length) return;
    lines.push(`[B]${title} (${list.length}):[/B]`);
    for (const i of list) {
      const o = i.object;
      let line = `• [URL=${o.url}]${o.title}[/URL] — ${fmtPrice(o.price)}`;
      if (i.wantViewing) line += ' — [B]хочет на просмотр[/B]';
      if (i.reasons?.length) line += ` — причины: ${i.reasons.join(', ')}`;
      if (i.clientComment) line += `\n   «${i.clientComment.replace(/\[/g, '(').replace(/\]/g, ')')}»`;
      lines.push(line);
    }
    lines.push('');
  };
  group('👍 Нравится', (i) => i.reaction === 'like');
  group('👎 Не подходит', (i) => i.reaction === 'dislike');
  group('Без оценки', (i) => !i.reaction);
  return lines.join('\n').trim();
}

async function notifyAgents(s, message) {
  const users = new Set();
  if (s.created_by_id) users.add(Number(s.created_by_id));
  try {
    const method = s.entity_type === 'lead' ? 'crm.lead.get' : 'crm.deal.get';
    const r = await callAsApp(s.member_id, method, { id: s.entity_id });
    if (r.result?.ASSIGNED_BY_ID) users.add(Number(r.result.ASSIGNED_BY_ID));
  } catch { /* нет доступа — уведомим только автора */ }
  for (const userId of users) {
    await callAsApp(s.member_id, 'im.notify.system.add', { USER_ID: userId, MESSAGE: message, TAG: `PROPSEL_${s.id}` })
      .catch((e) => console.warn('[notify]', e.message));
  }
}
