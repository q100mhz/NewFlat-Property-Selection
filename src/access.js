/**
 * Права на дашборд подборок.
 *  - администратор портала, руководитель головного подразделения и пользователи из списка
 *    «полный доступ» видят все подборки;
 *  - руководитель подразделения видит свои подборки и подборки сотрудников своего
 *    подразделения и всех вложенных;
 *  - остальные сотрудники видят только свои подборки.
 * Оргструктура берётся из Битрикс24 (department.get, user.get) и кэшируется на 10 минут.
 */
import { getMeta, setMeta } from './db.js';
import { callAsApp } from './bitrix.js';

const CACHE_MS = 10 * 60e3;
const cache = new Map(); // memberId -> { at, departments, users, error }

async function listAll(memberId, method, params = {}) {
  const out = [];
  let start = 0;
  for (let guard = 0; guard < 200; guard++) {
    const r = await callAsApp(memberId, method, { ...params, start });
    out.push(...(Array.isArray(r.result) ? r.result : []));
    if (r.next == null) break;
    start = r.next;
  }
  return out;
}

/** Оргструктура портала: подразделения и сотрудники (с кэшем). */
export async function getOrgStructure(memberId, { force = false } = {}) {
  const c = cache.get(memberId);
  if (c && !force && Date.now() - c.at < CACHE_MS) return c;
  try {
    const [departments, users] = await Promise.all([
      listAll(memberId, 'department.get'),
      listAll(memberId, 'user.get', { FILTER: { USER_TYPE: 'employee' } }),
    ]);
    const data = {
      at: Date.now(),
      departments: departments.map((d) => ({ id: Number(d.ID), name: d.NAME, parent: Number(d.PARENT) || null, head: Number(d.UF_HEAD) || null })),
      users: users.map((u) => ({
        id: Number(u.ID),
        name: [u.NAME, u.LAST_NAME].filter(Boolean).join(' ') || u.EMAIL || `Пользователь ${u.ID}`,
        departments: (Array.isArray(u.UF_DEPARTMENT) ? u.UF_DEPARTMENT : [u.UF_DEPARTMENT]).map(Number).filter(Boolean),
        active: u.ACTIVE !== false && u.ACTIVE !== 'N',
      })),
      error: null,
    };
    cache.set(memberId, data);
    return data;
  } catch (e) {
    console.warn('[access] оргструктура недоступна:', e.message);
    const fallback = { at: Date.now() - CACHE_MS + 60e3, departments: [], users: [], error: e.message };
    cache.set(memberId, c && !c.error ? { ...c, at: Date.now() - CACHE_MS + 60e3 } : fallback);
    return cache.get(memberId);
  }
}

/** Чистая функция: какие пользователи видны руководителю по структуре. */
export function computeScope({ departments, users }, userId) {
  const headed = departments.filter((d) => d.head === userId);
  if (!headed.length) return { all: false, role: 'employee', userIds: [userId], departments: [] };
  if (headed.some((d) => !d.parent)) return { all: true, role: 'company_head', departments: headed.map((d) => d.name) };
  const children = new Map();
  for (const d of departments) {
    if (!children.has(d.parent)) children.set(d.parent, []);
    children.get(d.parent).push(d.id);
  }
  const ids = new Set();
  const stack = headed.map((d) => d.id);
  while (stack.length) {
    const id = stack.pop();
    if (ids.has(id)) continue;
    ids.add(id);
    stack.push(...(children.get(id) || []));
  }
  const userIds = new Set([userId]);
  for (const u of users) if (u.departments.some((d) => ids.has(d))) userIds.add(u.id);
  return { all: false, role: 'head', userIds: [...userIds], departments: headed.map((d) => d.name) };
}

// ----- Список «полный доступ» (настраивает администратор портала) -----

const key = (memberId) => `full_access:${memberId}`;

export function getFullAccess(memberId) {
  try { return JSON.parse(getMeta(key(memberId)) || '[]'); } catch { return []; }
}

export function setFullAccess(memberId, list) {
  const clean = [];
  for (const u of Array.isArray(list) ? list : []) {
    const id = Number(u.id);
    if (Number.isInteger(id) && id > 0 && !clean.some((x) => x.id === id)) clean.push({ id, name: String(u.name || '').slice(0, 120) || `Пользователь ${id}` });
  }
  setMeta(key(memberId), JSON.stringify(clean.slice(0, 200)));
  return clean;
}

/** Область видимости для сессии сотрудника. */
export async function resolveScope(session) {
  if (session.isAdmin) return { all: true, role: 'admin' };
  if (getFullAccess(session.memberId).some((u) => u.id === session.userId)) return { all: true, role: 'full_access' };
  const org = await getOrgStructure(session.memberId);
  const scope = computeScope(org, session.userId);
  if (org.error) scope.warning = 'Не удалось загрузить структуру компании — показаны только ваши подборки. Администратору нужно выдать приложению право «Структура компании (department)».';
  return scope;
}
