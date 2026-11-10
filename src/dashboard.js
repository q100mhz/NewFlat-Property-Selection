import { db } from './db.js';
import { config } from './config.js';
import { publicLink } from './selections.js';
import { localMidnightUtc, localYmd } from './time.js';

const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const DAY = 24 * 3600e3;
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/** Границы периода [from, to) в формате дат SQLite (UTC). */
export function periodRange({ period, from, to }, now = new Date(), timeZone = config.timezone) {
  const today = localMidnightUtc(localYmd(now, timeZone), timeZone);
  switch (period) {
    case 'today': return { from: sqlTime(today), to: sqlTime(new Date(today.getTime() + DAY)) };
    case 'yesterday': return { from: sqlTime(new Date(today.getTime() - DAY)), to: sqlTime(today) };
    case 'week': return { from: sqlTime(new Date(today.getTime() - 6 * DAY)), to: sqlTime(new Date(today.getTime() + DAY)) };
    case 'month': return { from: sqlTime(new Date(today.getTime() - 29 * DAY)), to: sqlTime(new Date(today.getTime() + DAY)) };
    case 'custom': {
      const f = isYmd(from) ? localMidnightUtc(from, timeZone) : null;
      const t = isYmd(to) ? new Date(localMidnightUtc(to, timeZone).getTime() + DAY) : null;
      return { from: f ? sqlTime(f) : null, to: t ? sqlTime(t) : null };
    }
    default: return { from: null, to: null };
  }
}

const STATUS_HAVING = {
  not_opened: 's.view_count = 0',
  opened: 's.view_count > 0 AND COALESCE(SUM(i.reaction IS NOT NULL), 0) = 0',
  rated: 'COALESCE(SUM(i.reaction IS NOT NULL), 0) > 0',
  viewing: 'COALESCE(SUM(i.want_viewing), 0) > 0',
  external: 'COALESCE(SUM(i.object_id >= 1000000000), 0) > 0', // есть объекты, добавленные по ссылке
};

/**
 * Реестр подборок для дашборда с учётом прав (scope) и фильтров.
 * scope: { all: true } или { userIds: [...] }
 */
export function queryDashboard(memberId, scope, q = {}, portalDomain = '') {
  const where = ['s.member_id = @memberId'];
  const params = { memberId };
  const range = periodRange(q);
  if (range.from) { where.push('s.created_at >= @from'); params.from = range.from; }
  if (range.to) { where.push('s.created_at < @to'); params.to = range.to; }
  if (!scope.all) {
    const ids = (scope.userIds || []).map(Number).filter(Number.isInteger);
    where.push(ids.length ? `s.created_by_id IN (${ids.join(',')})` : '0');
  }
  if (q.userId && Number(q.userId)) { where.push('s.created_by_id = @userId'); params.userId = Number(q.userId); }
  if (q.archived !== '1') where.push('s.archived = 0');
  if (q.q) {
    const term = String(q.q).trim().slice(0, 100);
    const num = Number(term.replace(/\D/g, ''));
    where.push(`(s.title LIKE @q OR s.created_by_name LIKE @q${num ? ' OR s.entity_id = @num' : ''})`);
    params.q = `%${term.replace(/[%_]/g, '')}%`;
    if (num) params.num = num;
  }
  const having = STATUS_HAVING[q.status] ? `HAVING ${STATUS_HAVING[q.status]}` : '';

  const rows = db.prepare(`
    SELECT s.id, s.token, s.title, s.entity_type, s.entity_id, s.created_by_id, s.created_by_name, s.created_at,
      s.view_count, s.first_viewed_at, s.last_activity_at, s.submitted_at, s.archived,
      COUNT(i.id) AS total,
      COALESCE(SUM(i.reaction = 'like'), 0) AS liked,
      COALESCE(SUM(i.reaction = 'dislike'), 0) AS disliked,
      COALESCE(SUM(i.want_viewing), 0) AS viewing
    FROM selections s LEFT JOIN selection_items i ON i.selection_id = s.id
    WHERE ${where.join(' AND ')}
    GROUP BY s.id ${having}
    ORDER BY s.id DESC
  `).all(params);

  const kpi = {
    selections: rows.length,
    objects: 0, opened: 0, rated: 0, liked: 0, disliked: 0, viewing: 0, clients: 0,
  };
  const clients = new Set();
  const byUser = new Map();
  for (const r of rows) {
    const rated = r.liked + r.disliked > 0;
    kpi.objects += r.total;
    if (r.view_count > 0) kpi.opened++;
    if (rated) kpi.rated++;
    kpi.liked += r.liked; kpi.disliked += r.disliked; kpi.viewing += r.viewing;
    clients.add(`${r.entity_type}:${r.entity_id}`);
    const k = r.created_by_id || 0;
    if (!byUser.has(k)) byUser.set(k, { userId: k, name: r.created_by_name || '—', selections: 0, clients: new Set(), opened: 0, rated: 0, liked: 0, disliked: 0, viewing: 0 });
    const u = byUser.get(k);
    u.selections++; u.clients.add(`${r.entity_type}:${r.entity_id}`);
    if (r.view_count > 0) u.opened++;
    if (rated) u.rated++;
    u.liked += r.liked; u.disliked += r.disliked; u.viewing += r.viewing;
  }
  kpi.clients = clients.size;

  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
  const page = Math.max(Number(q.page) || 1, 1);
  const items = rows.slice((page - 1) * limit, page * limit).map((r) => ({
    id: r.id, title: r.title, link: publicLink(r.token),
    entityType: r.entity_type, entityId: r.entity_id,
    entityUrl: portalDomain ? `https://${portalDomain}/crm/${r.entity_type}/details/${r.entity_id}/` : null,
    createdById: r.created_by_id, createdByName: r.created_by_name, createdAt: r.created_at,
    viewCount: r.view_count, lastActivityAt: r.last_activity_at, digestAt: r.submitted_at, archived: !!r.archived,
    total: r.total, liked: r.liked, disliked: r.disliked, viewing: r.viewing,
  }));

  return {
    range, kpi, total: rows.length, page, limit, items,
    byUser: [...byUser.values()].map((u) => ({ ...u, clients: u.clients.size })).sort((a, b) => b.selections - a.selections),
  };
}

/** Сотрудники для фильтра: создатели подборок в зоне видимости + (для руководителя) его команда. */
export function dashboardUsers(memberId, scope, org) {
  const where = scope.all ? '' : `AND created_by_id IN (${(scope.userIds || []).map(Number).filter(Number.isInteger).join(',') || '0'})`;
  const map = new Map(db.prepare(`SELECT created_by_id AS id, MAX(created_by_name) AS name FROM selections
    WHERE member_id = ? AND created_by_id IS NOT NULL ${where} GROUP BY created_by_id`).all(memberId).map((u) => [u.id, u.name]));
  if (!scope.all && org?.users?.length) {
    for (const id of scope.userIds) {
      const u = org.users.find((x) => x.id === id);
      if (u && !map.has(id)) map.set(id, u.name);
    }
  }
  return [...map.entries()].map(([id, name]) => ({ id, name: name || `Пользователь ${id}` })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}
