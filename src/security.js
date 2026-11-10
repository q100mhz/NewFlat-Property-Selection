/**
 * Защитные механизмы HTTP-уровня:
 *  - заголовки безопасности и политики CSP (отдельно для страниц Битрикс24 и для клиента);
 *  - ограничение частоты запросов и блокировка IP, перебирающих ссылки подборок;
 *  - нейтральные ответы «не найдено», которые не раскрывают устройство сервиса.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './config.js';

const isHttps = (req) => req.secure || req.get('x-forwarded-proto') === 'https';

/** Базовые заголовки для всех ответов. */
export function baseHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  if (isHttps(req)) res.set('Strict-Transport-Security', 'max-age=31536000');
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
}

const siteOrigin = () => new URL(config.siteUrl).origin;
const portalOrigins = () => (config.b24AllowedDomains.length
  ? config.b24AllowedDomains.map((d) => `https://${d}`).join(' ')
  : 'https://*.bitrix24.ru https://*.bitrix24.com');

/** CSP для страниц внутри Битрикс24: только наш код (с одноразовым nonce) и библиотека BX24. */
export function b24Csp(nonce) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' https://api.bitrix24.com`,
    "style-src 'unsafe-inline'",
    `img-src 'self' data: ${siteOrigin()}`,
    "connect-src 'self'",
    `frame-ancestors ${portalOrigins()}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** CSP для страницы клиента: никаких встраиваний в чужие сайты, только свои скрипты. */
export function clientCsp() {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    `img-src 'self' data: ${siteOrigin()}`,
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

export const newNonce = () => crypto.randomBytes(16).toString('base64');

// ---------- Встраивание ресурсов в страницы Битрикс24 ----------
// Код интерфейса сотрудника не раздаётся публично: CSS и JS вставляются прямо в страницу,
// которую получает только авторизованный через Битрикс24 пользователь.

const assetCache = new Map();
function asset(rel) {
  if (!/^(app|shared)\/[a-z0-9_-]+\.(css|js)$/.test(rel)) throw new Error('bad asset ' + rel);
  if (!config.devMode && assetCache.has(rel)) return assetCache.get(rel);
  const text = fs.readFileSync(path.join(ROOT, 'public', rel), 'utf8').replace(/<\/(script|style)/gi, '<\\/$1');
  assetCache.set(rel, text);
  return text;
}

export function inlineAssets(html, nonce) {
  return html
    .replace(/<link rel="stylesheet" href="\/static\/([^"]+)">/g, (_m, rel) => `<style>${asset(rel)}</style>`)
    .replace(/<script src="\/static\/([^"]+)"><\/script>/g, (_m, rel) => `<script nonce="${nonce}">${asset(rel)}</script>`)
    .replace(/<script src="https:\/\/api\.bitrix24\.com\/api\/v1\/"><\/script>/g, `<script nonce="${nonce}" src="https://api.bitrix24.com/api/v1/"></script>`)
    .replace(/<script>/g, `<script nonce="${nonce}">`);
}

// ---------- Ограничение частоты ----------

const buckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
}, 60e3).unref();

/** Не более max запросов за windowMs с одного IP в рамках группы name. */
export function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
    b.n++;
    if (b.n > max) {
      res.set('Retry-After', String(Math.ceil((b.reset - now) / 1000)));
      return res.status(429).json({ error: 'Слишком много запросов, попробуйте позже' });
    }
    next();
  };
}

/**
 * Защита ссылок подборок от перебора: IP, получивший слишком много «не найдено»,
 * блокируется на 30 минут.
 */
const misses = new Map();
const MISS_LIMIT = 30;
const MISS_WINDOW = 10 * 60e3;
const BLOCK_MS = 30 * 60e3;

export function guardEnumeration(req, res, next) {
  const m = misses.get(req.ip);
  const now = Date.now();
  if (m?.blockedUntil > now) return res.status(429).json({ error: 'Слишком много запросов, попробуйте позже' });
  res.on('finish', () => {
    if (res.statusCode !== 404) return;
    let x = misses.get(req.ip);
    if (!x || now - x.start > MISS_WINDOW) { x = { n: 0, start: now, blockedUntil: 0 }; misses.set(req.ip, x); }
    x.n++;
    if (x.n >= MISS_LIMIT) {
      x.blockedUntil = Date.now() + BLOCK_MS;
      console.warn(`[security] ${req.ip}: перебор ссылок подборок — блокировка на 30 минут`);
    }
  });
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, m] of misses) if (now - m.start > MISS_WINDOW && !(m.blockedUntil > now)) misses.delete(ip);
}, 5 * 60e3).unref();

// ---------- Нейтральные ответы ----------

/** «Не найдено» без подробностей о сервисе. */
export function notFound(req, res) {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).type('text/plain').send('Not found');
}

/** Запрос пришёл через внешний прокси (nginx)? Используется, чтобы прятать служебные адреса. */
export const isExternal = (req) => Boolean(req.get('x-forwarded-for') || req.get('x-real-ip'));
