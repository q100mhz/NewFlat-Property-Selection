import { db, getMeta, setMeta } from '../db.js';
import { config, CATALOG_SECTIONS } from '../config.js';
import { parseListing, parseDetail } from './parser.js';
import { proxied, proxyObject } from '../images.js';

const UA = 'Mozilla/5.0 (compatible; NewFlatSelectionBot/1.0; +' + config.baseUrl + ')';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const siteHost = new URL(config.siteUrl).host;

/** Загрузка страницы сайта с повторами: сайт иногда отдаёт пустой ответ. */
export async function fetchSite(url, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      });
      if (res.status === 404) { const e = new Error('not_found'); e.status = 404; throw e; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      if (text.length < 500) throw new Error('empty response');
      return { html: text, finalUrl: res.url || url };
    } catch (e) {
      lastErr = e;
      if (e.status === 404) throw e;
      await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

const sectionByCategory = Object.fromEntries(CATALOG_SECTIONS.map((s) => [s.category, s]));

export function categoryForUrl(url) {
  const p = new URL(url).pathname;
  // самый длинный подходящий раздел
  const s = [...CATALOG_SECTIONS].sort((a, b) => b.path.length - a.path.length).find((x) => p.startsWith(x.path));
  if (s) return s;
  if (p.includes('/kommercheskaya-nedvizhimost/')) return p.includes('/arenda/') ? sectionByCategory.rent_commercial : sectionByCategory.commercial;
  return null;
}

const upsertStmt = db.prepare(`
INSERT INTO objects (id, url, category, deal, title, address, lat, lng, price, rooms, floor, floors,
  area_total, area_living, area_kitchen, thumb, listed_at, props_json, active, seen_at, search_text)
VALUES (@id, @url, @category, @deal, @title, @address, @lat, @lng, @price, @rooms, @floor, @floors,
  @area_total, @area_living, @area_kitchen, @thumb, @listed_at, @props_json, 1, @seen_at, @search_text)
ON CONFLICT(id) DO UPDATE SET
  url = excluded.url, category = COALESCE(excluded.category, objects.category), deal = COALESCE(excluded.deal, objects.deal),
  title = excluded.title, address = excluded.address,
  lat = COALESCE(excluded.lat, objects.lat), lng = COALESCE(excluded.lng, objects.lng),
  price = COALESCE(excluded.price, objects.price), rooms = COALESCE(excluded.rooms, objects.rooms),
  floor = COALESCE(excluded.floor, objects.floor), floors = COALESCE(excluded.floors, objects.floors),
  area_total = COALESCE(excluded.area_total, objects.area_total), area_living = COALESCE(excluded.area_living, objects.area_living),
  area_kitchen = COALESCE(excluded.area_kitchen, objects.area_kitchen), thumb = COALESCE(excluded.thumb, objects.thumb),
  listed_at = COALESCE(excluded.listed_at, objects.listed_at), props_json = COALESCE(excluded.props_json, objects.props_json),
  active = 1, seen_at = excluded.seen_at, search_text = excluded.search_text
`);

function toRow(item, section, now) {
  const district = item.props?.['Район'] || '';
  return {
    id: item.id,
    url: item.url,
    category: section?.category ?? null,
    deal: section?.deal ?? null,
    title: item.title || null,
    address: item.address || null,
    lat: item.lat ?? null,
    lng: item.lng ?? null,
    price: item.price ?? null,
    rooms: item.rooms ?? null,
    floor: item.floor ?? null,
    floors: item.floors ?? null,
    area_total: item.area_total ?? null,
    area_living: item.area_living ?? null,
    area_kitchen: item.area_kitchen ?? null,
    thumb: item.thumb || null,
    listed_at: item.listed_at || null,
    props_json: item.props ? JSON.stringify(item.props) : null,
    seen_at: now,
    search_text: [item.title, item.address, district, item.id].join(' ').toLowerCase(),
  };
}

let crawling = false;
export const crawlState = { running: false, section: null, page: 0, found: 0, error: null };

/** Полный обход каталога. Объекты, исчезнувшие из полностью пройденного раздела, помечаются неактивными. */
export async function crawlCatalog({ log = console.log } = {}) {
  if (crawling) return { skipped: true };
  crawling = true;
  Object.assign(crawlState, { running: true, error: null, found: 0 });
  const started = Date.now();
  let total = 0;
  let anyIncomplete = false;
  try {
    for (const section of CATALOG_SECTIONS) {
      crawlState.section = section.label;
      const sectionStart = Date.now();
      let page = 1;
      let lastPage = 1;
      let complete = true;
      const seenIds = new Set();
      do {
        crawlState.page = page;
        const url = `${config.siteUrl}${section.path}${page > 1 ? `?PAGEN_1=${page}` : ''}`;
        let parsed;
        try {
          const { html } = await fetchSite(url);
          parsed = parseListing(html, url);
        } catch (e) {
          if (e.status === 404) { complete = page > 1 ? complete : true; break; }
          log(`[crawl] ${section.label} стр.${page}: ${e.message}`);
          complete = false;
          page++;
          await sleep(config.crawlDelayMs);
          continue;
        }
        lastPage = Math.max(lastPage, parsed.lastPage);
        const now = Date.now();
        const tx = db.transaction((items) => {
          for (const it of items) {
            // объект может быть в нескольких разделах — не затираем более точную категорию общим разделом
            if (seenIds.has(it.id)) continue;
            seenIds.add(it.id);
            upsertStmt.run(toRow(it, section, now));
          }
        });
        tx(parsed.items);
        total += parsed.items.length;
        crawlState.found = total;
        if (!parsed.items.length) break;
        page++;
        if (config.crawlMaxPages && page > config.crawlMaxPages) { complete = false; break; }
        await sleep(config.crawlDelayMs);
      } while (page <= lastPage);

      if (!complete && !config.crawlMaxPages) anyIncomplete = true;
      if (complete && seenIds.size > 0) {
        db.prepare('UPDATE objects SET active = 0 WHERE category = ? AND (seen_at IS NULL OR seen_at < ?)')
          .run(section.category, sectionStart);
      }
      log(`[crawl] ${section.label}: ${seenIds.size} объектов${complete ? '' : ' (неполный обход)'}`);
    }
    // при неполном обходе повторяем примерно через 30 минут
    const stamp = anyIncomplete ? Date.now() - config.crawlIntervalHours * 3600e3 + 30 * 60e3 : Date.now();
    setMeta('last_crawl_at', new Date(stamp).toISOString());
    setMeta('last_crawl_total', total);
    log(`[crawl] готово: ${total} карточек за ${Math.round((Date.now() - started) / 1000)} с`);
    return { total };
  } catch (e) {
    crawlState.error = e.message;
    throw e;
  } finally {
    crawling = false;
    crawlState.running = false;
    crawlState.section = null;
  }
}

export function catalogStats() {
  const rows = db.prepare('SELECT category, COUNT(*) AS n FROM objects WHERE active = 1 GROUP BY category').all();
  return {
    lastCrawlAt: getMeta('last_crawl_at'),
    total: rows.reduce((s, r) => s + r.n, 0),
    byCategory: Object.fromEntries(rows.map((r) => [r.category, r.n])),
    crawl: { ...crawlState },
  };
}

export function rowToObject(r) {
  if (!r) return null;
  return {
    id: r.id, url: r.url, category: r.category, categoryLabel: sectionByCategory[r.category]?.label || null,
    deal: r.deal, title: r.title, address: r.address, lat: r.lat, lng: r.lng, price: r.price,
    rooms: r.rooms, floor: r.floor, floors: r.floors, area_total: r.area_total, area_living: r.area_living,
    area_kitchen: r.area_kitchen, thumb: proxied(r.thumb), listed_at: r.listed_at, active: !!r.active,
  };
}

/** Поиск по локальному индексу каталога. */
export function searchCatalog(q = {}) {
  const where = ['active = 1'];
  const params = {};
  if (q.category) {
    const cats = String(q.category).split(',').filter((c) => sectionByCategory[c]);
    if (cats.length) { where.push(`category IN (${cats.map((_, i) => '@c' + i).join(',')})`); cats.forEach((c, i) => { params['c' + i] = c; }); }
  }
  if (q.rooms) {
    const rooms = String(q.rooms).split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 20);
    const exact = rooms.filter((r) => r < 4);
    const parts = [];
    if (exact.length) parts.push(`rooms IN (${exact.join(',')})`);
    if (rooms.some((r) => r >= 4)) parts.push('rooms >= 4');
    if (parts.length) where.push('(' + parts.join(' OR ') + ')');
  }
  const range = (field, minKey, maxKey, mult = 1) => {
    const min = Number(q[minKey]); const max = Number(q[maxKey]);
    if (q[minKey] !== undefined && q[minKey] !== '' && Number.isFinite(min)) { where.push(`${field} >= @${minKey}`); params[minKey] = min * mult; }
    if (q[maxKey] !== undefined && q[maxKey] !== '' && Number.isFinite(max)) { where.push(`${field} <= @${maxKey}`); params[maxKey] = max * mult; }
  };
  range('price', 'priceMin', 'priceMax');
  range('area_total', 'areaMin', 'areaMax');
  if (q.notFirstFloor === '1') where.push('(floor IS NULL OR floor > 1)');
  if (q.notLastFloor === '1') where.push('(floor IS NULL OR floors IS NULL OR floor < floors)');
  if (q.q) {
    const words = String(q.q).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    words.forEach((w, i) => { where.push(`search_text LIKE @w${i}`); params['w' + i] = `%${w.replace(/[%_]/g, '')}%`; });
  }
  const sorts = {
    new: 'seen_at DESC, id DESC', price_asc: 'price IS NULL, price ASC', price_desc: 'price DESC',
    area_asc: 'area_total ASC', area_desc: 'area_total DESC',
  };
  const order = sorts[q.sort] || 'id DESC';
  const limit = Math.min(Math.max(Number(q.limit) || 24, 1), 100);
  const page = Math.max(Number(q.page) || 1, 1);
  const whereSql = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM objects WHERE ${whereSql}`).get(params).n;
  const rows = db.prepare(`SELECT * FROM objects WHERE ${whereSql} ORDER BY ${order} LIMIT ${limit} OFFSET ${(page - 1) * limit}`).all(params);
  return { total, page, limit, items: rows.map(rowToObject) };
}

/** Проверяет, что ссылка ведёт на объект сайта, и нормализует её. */
export function normalizeObjectUrl(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (u.host.replace(/^www\./, '') !== siteHost.replace(/^www\./, '')) return null;
  if (!u.pathname.startsWith('/predlozhenija/')) return null;
  return `${config.siteUrl}${u.pathname.endsWith('/') ? u.pathname : u.pathname + '/'}`;
}

/** Полные данные объекта (фото, характеристики, описание) с кэшированием. */
export async function getObjectDetail({ id, url }, { force = false } = {}) {
  let row = id ? db.prepare('SELECT * FROM objects WHERE id = ?').get(id) : null;
  if (!row && url) row = db.prepare('SELECT * FROM objects WHERE url = ?').get(url);
  const fresh = row?.detail_at && Date.now() - row.detail_at < config.detailTtlHours * 3600e3;
  if (row?.detail_json && fresh && !force) return proxyObject({ ...rowToObject(row), ...JSON.parse(row.detail_json) });

  const targetUrl = row?.url || url;
  if (!targetUrl) return null;
  let detail;
  try {
    const { html, finalUrl } = await fetchSite(targetUrl);
    detail = parseDetail(html, finalUrl);
  } catch (e) {
    if (e.status === 404 && row) {
      db.prepare('UPDATE objects SET active = 0 WHERE id = ?').run(row.id);
      return { ...rowToObject({ ...row, active: 0 }), ...(row.detail_json ? JSON.parse(row.detail_json) : {}), removed: true };
    }
    if (row) return { ...rowToObject(row), ...(row.detail_json ? JSON.parse(row.detail_json) : {}) };
    throw e;
  }
  if (!detail || !(detail.id || row?.id)) {
    if (row) return rowToObject(row);
    return null;
  }
  const objId = row?.id || detail.id;
  const section = categoryForUrl(detail.url) || (row && sectionByCategory[row.category]);
  const now = Date.now();
  upsertStmt.run(toRow({
    ...detail,
    id: objId,
    thumb: row?.thumb || detail.photos[0]?.small || null,
    listed_at: row?.listed_at || null,
    props: detail.props,
  }, section, row?.seen_at || now));
  const detailData = {
    photos: detail.photos, props: detail.props, description: detail.description, price_per_m2: detail.price_per_m2,
    district: detail.props['Район'] || null,
  };
  db.prepare('UPDATE objects SET detail_json = ?, detail_at = ? WHERE id = ?').run(JSON.stringify(detailData), now, objId);
  const updated = db.prepare('SELECT * FROM objects WHERE id = ?').get(objId);
  return proxyObject({ ...rowToObject(updated), ...detailData });
}

export function getObjectRow(id) {
  return db.prepare('SELECT * FROM objects WHERE id = ?').get(id);
}

let timer = null;
export function scheduleCrawls({ log = console.log } = {}) {
  const tick = async () => {
    const last = getMeta('last_crawl_at');
    const due = !last || Date.now() - Date.parse(last) > config.crawlIntervalHours * 3600e3;
    if (due) {
      try { await crawlCatalog({ log }); } catch (e) { log('[crawl] ошибка: ' + e.message); }
    }
  };
  if (config.crawlOnStart) setTimeout(tick, 3000);
  timer = setInterval(tick, 15 * 60e3);
  timer.unref?.();
}
