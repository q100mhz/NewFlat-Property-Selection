import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Прокси с дисковым кэшем для фотографий newflat72.ru.
 * Сайт периодически обрывает соединения, поэтому клиент получает фото с нашего сервера.
 */
const CACHE_DIR = path.join(path.dirname(config.dbPath), 'img-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });
const siteHost = new URL(config.siteUrl).host;
const TTL = 14 * 24 * 3600e3;
const inflight = new Map();

function allowed(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && x.host === siteHost && x.pathname.startsWith('/upload/') && /\.(jpe?g|png|webp|gif)$/i.test(x.pathname);
  } catch { return false; }
}

/** Ссылка на фото через прокси (для отдачи клиенту). */
export function proxied(u) {
  if (typeof u === 'string' && u.startsWith('/img?u=')) return u;
  return u && allowed(u) ? `/img?u=${encodeURIComponent(u)}` : u;
}

async function download(u, file) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewFlatSelectionBot/1.0)' }, signal: AbortSignal.timeout(20000) });
      if (res.status === 404) { const e = new Error('404'); e.status = 404; throw e; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const type = res.headers.get('content-type') || '';
      if (!type.startsWith('image/')) throw new Error('not an image');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 15 * 1024 * 1024) throw new Error('too large');
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);
      fs.writeFileSync(file + '.type', type);
      return;
    } catch (e) {
      lastErr = e;
      if (e.status === 404) break;
      await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw lastErr;
}

const MAX_CACHE_BYTES = Number(process.env.IMG_CACHE_MAX_MB || 3000) * 1024 * 1024;

/**
 * Чистка кэша фото: удаляются файлы старше 30 дней, а если кэш превысил лимит
 * (по умолчанию 3 ГБ) — самые давние, пока размер не станет меньше лимита.
 */
function cleanupCache() {
  const limit = Date.now() - 30 * 24 * 3600e3;
  let removed = 0;
  const files = [];
  for (const name of fs.readdirSync(CACHE_DIR)) {
    const file = path.join(CACHE_DIR, name);
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs < limit) { fs.unlinkSync(file); removed++; } else files.push({ file, size: st.size, t: st.mtimeMs });
    } catch { /* файл уже удалён */ }
  }
  let total = files.reduce((a, f) => a + f.size, 0);
  for (const f of files.sort((a, b) => a.t - b.t)) {
    if (total <= MAX_CACHE_BYTES) break;
    try { fs.unlinkSync(f.file); total -= f.size; removed++; } catch { /* ignore */ }
  }
  if (removed) console.log(`[img-cache] удалено устаревших файлов: ${removed}`);
}
setInterval(cleanupCache, 6 * 3600e3).unref();

/** Подменяет ссылки на фото в объекте. */
export function proxyObject(o) {
  if (!o) return o;
  return {
    ...o,
    thumb: proxied(o.thumb),
    ...(Array.isArray(o.photos) ? { photos: o.photos.map((p) => ({ big: proxied(p.big), small: proxied(p.small) })) } : {}),
  };
}

export async function imageHandler(req, res) {
  const u = String(req.query.u || '');
  if (!allowed(u)) return res.status(400).end();
  const file = path.join(CACHE_DIR, crypto.createHash('sha1').update(u).digest('hex'));
  let fresh = false;
  try { fresh = Date.now() - fs.statSync(file).mtimeMs < TTL; } catch { /* нет в кэше */ }
  if (!fresh) {
    if (!inflight.has(file)) inflight.set(file, download(u, file).finally(() => inflight.delete(file)));
    try { await inflight.get(file); } catch (e) {
      if (!fs.existsSync(file)) return res.redirect(302, u); // пусть браузер попробует напрямую
    }
  }
  let type = 'image/jpeg';
  try { type = fs.readFileSync(file + '.type', 'utf8'); } catch { /* по умолчанию */ }
  res.set('Content-Type', type);
  res.set('Cache-Control', 'public, max-age=604800, immutable');
  fs.createReadStream(file).pipe(res);
}
