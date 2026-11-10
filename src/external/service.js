/**
 * Объекты, добавленные по ссылке с любых сайтов (застройщики, ЦИАН, Авито и т. п.).
 *  - хранятся в общей таблице objects с source = 'link' и id от 1 000 000 000;
 *  - фото скачиваются и хранятся у нас (data/photos/<id>/), клиент не видит их исходных адресов;
 *  - контакты чужих продавцов/агентств/отделов продаж вычищаются из описания;
 *  - если сайт не отдаёт данные (антибот-защита), создаётся черновик для ручного заполнения;
 *  - правки сотрудника сохраняются в объекте и видны во всех подборках.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { domainToUnicode } from 'node:url';
import { db } from '../db.js';
import { config } from '../config.js';
import { safeFetch, checkUrl, FetchBlocked } from './fetcher.js';
import { extractListing, imageSize, isContentImage } from './extract.js';

export const EXTERNAL_ID_BASE = 1_000_000_000;
export const PHOTO_DIR = path.resolve(path.dirname(config.dbPath), 'photos');
const MAX_PHOTOS = 40;
const EXT_BY_TYPE = { png: 'png', jpg: 'jpg', webp: 'webp', svg: 'svg' };

// ---------- Чистка контактов ----------

const PHONE = /(?:\+7|8)[\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}|\b\d{3}[\s\-]\d{2}[\s\-]\d{2}\b/g;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const URLS = /(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:ru|рф|com|net|org|su|online|site)\b\S*/gi;
const CONTACT_LINE = /(звоните|звонит[еь]|позвоните|пишите|напишите|whatsapp|ватсап|вотсап|viber|вайбер|telegram|телеграм|тг\b|контакт|отдел\s+продаж|менеджер|агентств|риелтор|риэлтор|собственник|без\s+посредник|комисси|наш\s+офис|приезжайте|запишитесь|напрямую\s+от\s+застройщика|от\s+застройщика)/i;

export function cleanContacts(text) {
  return String(text || '')
    .split(/(?<=[.!?…])\s+|\n+/)
    .filter((sentence) => !CONTACT_LINE.test(sentence))
    .join(' ')
    .replace(PHONE, '')
    .replace(EMAIL, '')
    .replace(URLS, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,!?])/g, '$1')
    .trim()
    .slice(0, 5000);
}

// ---------- Вспомогательное ----------

const TRACKING = /^(utm_|yclid|gclid|fbclid|_openstat|from|context|mlSearchSessionGuid|searchSessionGuid|ref|roistat)/i;

export function normalizeLink(input) {
  const u = checkUrl(input);
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  return u.toString();
}

const hostLabel = (url) => { try { return domainToUnicode(new URL(url).hostname.replace(/^www\./, '')); } catch { return null; } };

/** Понятное имя источника для сотрудника (по известным площадкам или названию сайта). */
function sourceName(url, siteName) {
  const h = hostLabel(url) || '';
  const known = [[/avito\./, 'Авито'], [/cian\./, 'ЦИАН'], [/domclick\./, 'ДомКлик'], [/realty\.ya|yandex\..*realty/, 'Яндекс Недвижимость'], [/etagi\./, 'Этажи'], [/n1\.ru/, 'N1']];
  const k = known.find(([re]) => re.test(h));
  if (k) return k[1];
  const name = (siteName || '').replace(/\s*(сайт\s+застройщика|официальный\s+сайт)\s*/gi, ' ').trim();
  return (name || h).slice(0, 60);
}

function nextId() {
  const r = db.prepare('SELECT MAX(id) AS m FROM objects WHERE id >= ?').get(EXTERNAL_ID_BASE);
  return Math.max(EXTERNAL_ID_BASE, (r.m || EXTERNAL_ID_BASE - 1) + 1);
}

function svgSize(buf) {
  const head = buf.toString('utf8', 0, Math.min(buf.length, 4000));
  if (!/<svg[\s>]/i.test(head)) return null;
  const vb = head.match(/viewBox\s*=\s*["'][\d.\-]+[\s,]+[\d.\-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  const w = Number((head.match(/\swidth\s*=\s*["']([\d.]+)/i) || [])[1]) || Number(vb?.[1]);
  const h = Number((head.match(/\sheight\s*=\s*["']([\d.]+)/i) || [])[1]) || Number(vb?.[2]);
  return w && h ? { w, h, type: 'svg' } : null;
}

/** Проверка и нормализация картинки: только настоящие изображения нужного размера. */
export function inspectImage(buf, { minSide = true } = {}) {
  let size = imageSize(buf);
  if (!size) {
    size = svgSize(buf);
    // SVG сохраняем только «чистыми»: без скриптов, обработчиков и внешних ссылок
    if (size && /<script|\bon[a-z]+\s*=|javascript:|<foreignObject|href\s*=\s*["']https?:/i.test(buf.toString('utf8'))) return null;
  }
  if (!size) return null;
  if (minSide && size.type !== 'svg' && !isContentImage(size, buf.length)) return null;
  if (size.type === 'svg' && (size.w < 200 || size.h < 150)) return null;
  return size;
}

function savePhoto(objectId, n, buf, type) {
  const dir = path.join(PHOTO_DIR, String(objectId));
  fs.mkdirSync(dir, { recursive: true });
  const file = `${n}.${EXT_BY_TYPE[type] || 'jpg'}`;
  fs.writeFileSync(path.join(dir, file), buf);
  return `/photo/${objectId}/${file}`;
}

async function downloadPhotos(objectId, candidates, referer) {
  const saved = [];
  const hashes = new Set();
  let n = 0;
  const queue = candidates.slice(0, 60);
  const worker = async () => {
    while (queue.length && saved.length < MAX_PHOTOS) {
      const url = queue.shift();
      try {
        const r = await safeFetch(url, { kind: 'image', referer });
        if (r.status !== 200) continue;
        const size = inspectImage(r.body);
        if (!size) continue;
        const h = crypto.createHash('sha1').update(r.body).digest('hex');
        if (hashes.has(h)) continue;
        hashes.add(h);
        const order = candidates.indexOf(url);
        saved.push({ order, src: savePhoto(objectId, `${order}-${n++}`, r.body, size.type) });
      } catch { /* картинка недоступна — пропускаем */ }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return saved.sort((a, b) => a.order - b.order).map((p) => ({ big: p.src, small: p.src }));
}

const BLOCK_PAGE = /(captcha|капч|доступ ограничен|проверка безопасности|подозрительн|are you a robot|access denied|qrator|ddos-guard)/i;

function searchText(o) {
  return [o.title, o.address, o.complex, o.source_name, o.id].filter(Boolean).join(' ').toLowerCase();
}

function upsertRow(o) {
  db.prepare(`
    INSERT INTO objects (id, url, category, deal, title, address, price, rooms, floor, floors, area_total, area_living, area_kitchen,
      thumb, detail_json, detail_at, active, seen_at, search_text, source, source_name, created_by, needs_edit, edited_at)
    VALUES (@id, @url, 'external', 'sale', @title, @address, @price, @rooms, @floor, @floors, @area_total, @area_living, @area_kitchen,
      @thumb, @detail_json, @detail_at, 1, @seen_at, @search_text, 'link', @source_name, @created_by, @needs_edit, @edited_at)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, address = excluded.address, price = excluded.price, rooms = excluded.rooms,
      floor = excluded.floor, floors = excluded.floors, area_total = excluded.area_total, area_living = excluded.area_living,
      area_kitchen = excluded.area_kitchen, thumb = excluded.thumb, detail_json = excluded.detail_json, search_text = excluded.search_text,
      needs_edit = excluded.needs_edit, edited_at = excluded.edited_at
  `).run(o);
}

// ---------- Площадки, закрытые от автоматического чтения ----------

/** Авито, ЦИАН и ДомКлик блокируют чтение страниц: не обращаемся к ним (чтобы не попасть под блокировку IP сервера). */
const CLOSED_PLATFORMS = /(^|\.)(avito\.ru|cian\.ru|domclick\.ru)$/i;
export const isClosedPlatform = (url) => { try { return CLOSED_PLATFORMS.test(new URL(url).hostname); } catch { return false; } };

/** Что можно понять из самой ссылки (у Авито в адресе есть комнаты и площадь). */
export function hintsFromUrl(url) {
  const out = {};
  let path = '';
  try { path = decodeURIComponent(new URL(url).pathname).toLowerCase(); } catch { return out; }
  const avito = path.match(/\/(?:(\d+)-k\._kvartira|(studiya|kvartira-studiya))[_.]*([\d,]+)_m/);
  if (avito) {
    out.rooms = avito[2] ? 0 : Number(avito[1]);
    out.area_total = Number(String(avito[3]).replace(',', '.')) || null;
  }
  if (/sale__flat|\/sale\/flat|kvartiry/.test(path) && out.rooms == null) out.kind = 'квартира';
  if (out.area_total) out.title = `${out.rooms === 0 ? 'Студия' : out.rooms ? `${out.rooms}-к квартира` : 'Квартира'}, ${String(out.area_total).replace('.', ',')} м²`;
  return out;
}

// ---------- Добавление по ссылке ----------

/**
 * Создаёт объект по ссылке. Если ссылка уже добавлялась — возвращает существующий объект
 * (с правками сотрудников), не перечитывая сайт.
 */
export async function addByLink(input, session) {
  const url = normalizeLink(input);
  const existing = db.prepare("SELECT id, needs_edit, edited_at FROM objects WHERE url = ? AND source = 'link'").get(url);
  // уже добавленный объект возвращаем как есть (с правками); нетронутый черновик — пробуем прочитать заново
  if (existing && !(existing.needs_edit && !existing.edited_at)) return { id: existing.id, existed: true };

  const id = existing?.id || nextId();
  let data = null;
  let reason = null;
  const hints = hintsFromUrl(url);
  if (isClosedPlatform(url)) {
    reason = `${sourceName(url)} закрывает объявления от автоматического чтения. Заполните карточку и загрузите фото (например, сохранённые с объявления).`;
  } else try {
    const page = await safeFetch(url, { kind: 'page' });
    const html = page.body.toString('utf8');
    if (page.status >= 400 || BLOCK_PAGE.test(html.slice(0, 20000)) && html.length < 60000) {
      reason = 'Сайт не отдаёт объявление автоматически (защита от роботов). Заполните карточку вручную.';
    } else if (!/text\/html|xhtml/i.test(page.type)) {
      reason = 'По ссылке не страница сайта. Заполните карточку вручную.';
    } else {
      data = extractListing(html, page.url);
      if (!data.price && !data.area_total) reason = 'На странице не найдены цена и площадь. Проверьте и заполните карточку.';
    }
  } catch (e) {
    if (e instanceof FetchBlocked) throw Object.assign(new Error(e.message), { status: 400 });
    reason = 'Сайт не ответил. Заполните карточку вручную.';
  }

  if (existing && reason) return { id, existed: true, warning: reason }; // повторная попытка не удалась — черновик остаётся
  const photos = data?.images?.length ? await downloadPhotos(id, data.images, url) : [];
  const src = sourceName(url, data?.siteName);
  const o = {
    id, url,
    title: data?.title || hints.title || `Объект с ${src}`,
    address: data?.address || null,
    price: data?.price || null,
    rooms: data?.rooms ?? hints.rooms ?? null,
    floor: data?.floor || null,
    floors: data?.floors || null,
    area_total: data?.area_total || hints.area_total || null,
    area_living: data?.area_living || null,
    area_kitchen: data?.area_kitchen || null,
    thumb: photos[0]?.small || null,
    detail_json: JSON.stringify({
      photos, description: cleanContacts(data?.description), complex: data?.complex || null, props: {}, district: null,
    }),
    detail_at: Date.now(),
    seen_at: Date.now(),
    source_name: src,
    created_by: session?.userId || null,
    needs_edit: reason ? 1 : 0,
    edited_at: null,
    complex: data?.complex || null,
  };
  o.search_text = searchText(o);
  delete o.complex;
  upsertRow({ ...o });
  console.log(`[link] ${src}: объект ${id}, фото ${photos.length}${reason ? ' — черновик' : ''}`);
  return { id, existed: false, warning: reason };
}

// ---------- Правка сотрудником ----------

const num = (v, { int = false, min = 0, max = 1e10 } = {}) => {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return int ? Math.round(n) : Math.round(n * 100) / 100;
};
const str = (v, len) => (v == null ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, len) || null);

export function getLinkObject(id) {
  const row = db.prepare("SELECT * FROM objects WHERE id = ? AND source = 'link'").get(Number(id));
  if (!row) return null;
  return { row, detail: row.detail_json ? JSON.parse(row.detail_json) : { photos: [] } };
}

export function updateLinkObject(id, patch, session) {
  const cur = getLinkObject(id);
  if (!cur) return null;
  const { row, detail } = cur;
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
  const next = {
    title: has('title') ? str(patch.title, 200) || row.title : row.title,
    address: has('address') ? str(patch.address, 300) : row.address,
    price: has('price') ? num(patch.price, { int: true, max: 5e9 }) : row.price,
    rooms: has('rooms') ? num(patch.rooms, { int: true, max: 20 }) : row.rooms,
    floor: has('floor') ? num(patch.floor, { int: true, max: 200 }) : row.floor,
    floors: has('floors') ? num(patch.floors, { int: true, max: 200 }) : row.floors,
    area_total: has('area_total') ? num(patch.area_total, { max: 100000 }) : row.area_total,
    area_living: has('area_living') ? num(patch.area_living, { max: 100000 }) : row.area_living,
    area_kitchen: has('area_kitchen') ? num(patch.area_kitchen, { max: 10000 }) : row.area_kitchen,
  };
  const d = { ...detail };
  if (has('description')) d.description = String(patch.description || '').slice(0, 5000);
  if (has('complex')) d.complex = str(patch.complex, 100);
  if (Array.isArray(patch.photos)) {
    // только фото, которые уже есть у объекта (порядок задаёт сотрудник)
    const own = new Set((detail.photos || []).map((p) => p.big));
    d.photos = patch.photos.filter((p) => own.has(p)).map((p) => ({ big: p, small: p }));
  }
  const o = {
    id: row.id, url: row.url, ...next,
    thumb: d.photos?.[0]?.small || null,
    detail_json: JSON.stringify(d), detail_at: row.detail_at || Date.now(), seen_at: row.seen_at || Date.now(),
    source_name: row.source_name, created_by: row.created_by, needs_edit: 0,
    edited_at: new Date().toISOString(),
  };
  o.search_text = searchText({ ...o, complex: d.complex });
  upsertRow(o);
  console.log(`[link] объект ${row.id} изменён пользователем ${session?.userId}`);
  return true;
}

/** Фото, загруженное сотрудником (с компьютера или из галереи телефона). */
export function addUploadedPhoto(id, buf) {
  const cur = getLinkObject(id);
  if (!cur) return { error: 'not_found' };
  if ((cur.detail.photos || []).length >= 60) return { error: 'Не больше 60 фото у объекта' };
  const size = inspectImage(buf, { minSide: false });
  if (!size || size.type === 'svg') return { error: 'Нужна фотография в формате JPG, PNG или WEBP' };
  const src = savePhoto(id, `u${Date.now()}`, buf, size.type);
  const d = { ...cur.detail, photos: [...(cur.detail.photos || []), { big: src, small: src }] };
  db.prepare('UPDATE objects SET detail_json = ?, thumb = COALESCE(thumb, ?) WHERE id = ?').run(JSON.stringify(d), src, id);
  return { photo: src };
}

/** Отдача фото: только файлы из папки объекта с безопасными именами. */
export function photoPath(objectId, file) {
  if (!/^\d{10,}$/.test(objectId) || !/^[a-z0-9-]{1,40}\.(jpg|png|webp|svg)$/i.test(file)) return null;
  const p = path.join(PHOTO_DIR, objectId, file);
  return p.startsWith(PHOTO_DIR + path.sep) && fs.existsSync(p) ? p : null;
}
