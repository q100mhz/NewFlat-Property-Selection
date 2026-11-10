import crypto from 'node:crypto';
import { config } from './config.js';

const secret = () => {
  if (config.sessionSecret) return config.sessionSecret;
  if (!config.devMode) throw new Error('SESSION_SECRET не задан');
  return 'dev-only-secret-dev-only-secret-dev-only';
};

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', secret()).update(data).digest('base64url');

/** Подписанная сессия сотрудника: портал, пользователь, сущность CRM, срок действия. */
export function createSession(payload, ttlSec = 12 * 3600) {
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  return `${body}.${sign(body)}`;
}

export function readSession(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = sign(body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now() / 1000) return null;
    return data;
  } catch { return null; }
}

export function requireSession(req, res, next) {
  const h = req.get('authorization') || '';
  const s = readSession(h.startsWith('Bearer ') ? h.slice(7) : null);
  if (!s) return res.status(401).json({ error: 'Unauthorized' });
  req.session = s;
  next();
}

/** Публичный токен ссылки на подборку: 128 бит случайности. */
export function newPublicToken() {
  return crypto.randomBytes(16).toString('base64url');
}

/** Текст для BB-кодов Битрикс24: квадратные скобки из данных не превращаются в разметку. */
export const bb = (s) => String(s ?? '').replace(/\[/g, '(').replace(/\]/g, ')');

/** Ссылка для BB-кода [URL=…]: только http(s) и без символов, ломающих разметку. */
export const bbUrl = (u) => (/^https?:\/\/[^\s\[\]]+$/i.test(String(u || '')) ? u : '');

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
