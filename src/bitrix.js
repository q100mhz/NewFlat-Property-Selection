import { db } from './db.js';
import { config } from './config.js';

export const PLACEMENTS = [
  { placement: 'CRM_LEAD_DETAIL_TAB', title: 'Подборка' },
  { placement: 'CRM_DEAL_DETAIL_TAB', title: 'Подборка' },
];

export class B24Error extends Error {
  constructor(message, code, status) { super(message); this.code = code; this.status = status; }
}

/** Проверка домена портала, пришедшего в запросе от Битрикс24 (защита от подмены адреса). */
export function validDomain(domain) {
  const d = String(domain || '').toLowerCase().trim();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?$/.test(d)) return null;
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(d)) return null;
  if (config.b24AllowedDomains.length && !config.b24AllowedDomains.includes(d)) return null;
  return d;
}

/** Вызов REST-метода с явным токеном. */
export async function callWithToken(domain, method, params = {}, auth) {
  const d = validDomain(domain);
  if (!d) throw new B24Error('Недопустимый домен портала', 'BAD_DOMAIN', 400);
  if (!/^[a-z0-9_.]+$/i.test(method)) throw new B24Error('Bad method', 'BAD_METHOD', 400);
  const res = await fetch(`https://${d}/rest/${method}.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...params, auth }),
    signal: AbortSignal.timeout(20000),
  });
  let data;
  try { data = await res.json(); } catch { throw new B24Error(`Некорректный ответ портала (HTTP ${res.status})`, 'BAD_RESPONSE', res.status); }
  if (data.error) throw new B24Error(data.error_description || data.error, data.error, res.status);
  return data;
}

export function getPortal(memberId) {
  return db.prepare('SELECT * FROM portals WHERE member_id = ?').get(memberId);
}

export function savePortal({ memberId, domain, accessToken, refreshToken, expiresIn, clientEndpoint }) {
  const expiresAt = Date.now() + (Number(expiresIn) || 3600) * 1000 - 60e3;
  db.prepare(`
    INSERT INTO portals (member_id, domain, client_endpoint, access_token, refresh_token, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(member_id) DO UPDATE SET domain = excluded.domain, client_endpoint = excluded.client_endpoint,
      access_token = excluded.access_token, refresh_token = excluded.refresh_token, expires_at = excluded.expires_at,
      updated_at = datetime('now')
  `).run(memberId, domain, clientEndpoint || `https://${domain}/rest/`, accessToken, refreshToken, expiresAt);
}

export function deletePortal(memberId) {
  db.prepare('DELETE FROM portals WHERE member_id = ?').run(memberId);
}

/** Обновление OAuth-токена приложения через oauth.bitrix.info. */
async function refreshPortalToken(portal) {
  if (!config.b24ClientId || !config.b24ClientSecret) throw new B24Error('Не заданы B24_CLIENT_ID / B24_CLIENT_SECRET', 'NO_CLIENT', 500);
  const url = new URL('https://oauth.bitrix.info/oauth/token/');
  url.search = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.b24ClientId,
    client_secret: config.b24ClientSecret,
    refresh_token: portal.refresh_token,
  }).toString();
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.access_token) {
    throw new B24Error('Не удалось обновить токен: ' + (data.error_description || data.error || res.status), 'REFRESH_FAILED', 401);
  }
  const domain = validDomain(String(data.domain || portal.domain).replace(/^https?:\/\//, '').replace(/\/.*$/, '')) || portal.domain;
  savePortal({
    memberId: portal.member_id,
    domain,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    clientEndpoint: portal.client_endpoint,
  });
  return getPortal(portal.member_id);
}

/** Вызов REST от имени приложения (сохранённые при установке токены), с автообновлением. */
export async function callAsApp(memberId, method, params = {}) {
  let portal = getPortal(memberId);
  if (!portal) throw new B24Error('Портал не установлен', 'NO_PORTAL', 404);
  if (!portal.access_token || !portal.expires_at || Date.now() > portal.expires_at) portal = await refreshPortalToken(portal);
  try {
    return await callWithToken(portal.domain, method, params, portal.access_token);
  } catch (e) {
    if (e.code === 'expired_token' || e.code === 'invalid_token' || e.status === 401) {
      portal = await refreshPortalToken(portal);
      return callWithToken(portal.domain, method, params, portal.access_token);
    }
    throw e;
  }
}

/** Регистрация вкладок в карточках лида и сделки + событие удаления приложения. */
export async function bindPlacements(domain, auth) {
  const handler = `${config.baseUrl}/b24/placement`;
  const results = [];
  for (const p of PLACEMENTS) {
    try { await callWithToken(domain, 'placement.unbind', { PLACEMENT: p.placement, HANDLER: handler }, auth); } catch { /* не было привязки */ }
    try {
      await callWithToken(domain, 'placement.bind', { PLACEMENT: p.placement, HANDLER: handler, TITLE: p.title, LANG_ALL: { ru: { TITLE: p.title } } }, auth);
      results.push({ placement: p.placement, ok: true });
    } catch (e) {
      results.push({ placement: p.placement, ok: false, error: e.message });
    }
  }
  try {
    await callWithToken(domain, 'event.bind', { event: 'ONAPPUNINSTALL', handler: `${config.baseUrl}/b24/events` }, auth);
  } catch (e) {
    if (!/already|уже/i.test(e.message)) results.push({ event: 'ONAPPUNINSTALL', ok: false, error: e.message });
  }
  return results;
}

/** Поддержка refresh-токенов живыми (они истекают через 28 дней без использования). */
export function scheduleTokenRefresh({ log = console.log } = {}) {
  const run = async () => {
    for (const p of db.prepare('SELECT * FROM portals').all()) {
      try { await refreshPortalToken(p); } catch (e) { log(`[b24] обновление токена ${p.domain}: ${e.message}`); }
    }
  };
  const t = setInterval(run, 24 * 3600e3);
  t.unref?.();
}
