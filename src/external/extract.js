/**
 * Универсальный разбор страницы объекта недвижимости (сайты застройщиков и любые другие).
 * Источники данных по убыванию надёжности: JSON-LD, meta (og:*), заголовок, текст страницы.
 * Картинки собираются кандидатами; служебная графика (логотипы, иконки, баннеры, соцсети,
 * картинки из шапки/подвала/меню и т. п.) отсеивается уже здесь, остальное — по размеру при скачивании.
 */
import * as cheerio from 'cheerio';

const clean = (s) => String(s ?? '').replace(/[ ​]/g, ' ').replace(/\s+/g, ' ').trim();
const toNum = (s) => {
  if (s == null) return null;
  const n = Number(String(s).replace(/[\s ]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

const SYSTEM_IMG = /(logo|icon|favicon|thumbnail-|\.ico\b|sprite|banner|social|soc[-_]|vk[-_.]|telegram|whatsapp|viber|youtube|rutube|ok[-_]ru|avatar|placeholder|loader|spinner|arrow|btn|button|marker|pin[-_.]|flag|payment|partner|award|qr|badge|emoji|captcha|pixel|counter|metrika|stub|no[-_]?photo|noimage|blank|bg[-_]|background|pattern|decor|shadow|preview-video|play[-_]|watermark-only)/i;
const SYSTEM_CONTAINER = 'header, footer, nav, [class*="header"], [class*="footer"], [class*="menu"], [class*="logo"], [class*="partner"], [class*="social"], [class*="cookie"], [class*="modal"], [class*="popup"], [class*="banner"], [class*="news"], [class*="similar"], [class*="recommend"], [class*="related"]';
// расширение может идти перед параметрами или суффиксом сервиса ресайза: …/photo.jpg@webp, …plan.png@jpg
const IMG_EXT = /\.(jpe?g|png|webp|avif)(\?|$|@|#)/i;
// планировки часто в SVG — берём только если по адресу или подписи видно, что это планировка
const PLAN_SVG = /\.svg(\?|$)/i;
const PLAN_HINT = /(plan|layout|flat_image|flat\d*_image|планир)/i;
const isCandidate = (url, hint = '') => IMG_EXT.test(url) || (PLAN_SVG.test(url) && PLAN_HINT.test(url + ' ' + hint));

function abs(base, href) {
  if (!href) return null;
  try {
    const u = new URL(String(href).trim(), base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch { return null; }
}

/** Ключ для склейки вариантов одной картинки разного размера. */
function imageKey(url) {
  try {
    // сервисы ресайза: …/plain/<исходный адрес>@webp — ключ по исходному файлу
    const inner = url.match(/\/plain\/((?:https?|s3):\/\/[^@?#]+)/);
    if (inner) url = inner[1].replace(/^s3:\/\//, 'https://s3/');
    const hash = url.match(/([0-9a-f]{24,})/i);
    if (hash) return hash[1].toLowerCase();
    const u = new URL(url);
    const file = u.pathname.split('/').pop().replace(/[-_@]?\d{2,4}x\d{2,4}/g, '').replace(/[-_](small|thumb|preview|mini|min|lg|md|sm|xs|xl|big|large|medium)(?=\.)/i, '');
    return u.hostname + '/' + file.toLowerCase();
  } catch { return url; }
}

function largestFromSrcset(srcset) {
  let best = null;
  let bestW = -1;
  for (const part of String(srcset).split(',')) {
    const [url, size] = part.trim().split(/\s+/);
    const w = size ? parseFloat(size) : 1;
    if (url && w > bestW) { best = url; bestW = w; }
  }
  return best;
}

function walkJsonLd(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((n) => walkJsonLd(n, out)); return; }
  out.push(node);
  for (const v of Object.values(node)) if (v && typeof v === 'object') walkJsonLd(v, out);
}

export function extractListing(html, pageUrl) {
  const $ = cheerio.load(html);
  const meta = (name) => clean($(`meta[property="${name}"]`).attr('content') || $(`meta[name="${name}"]`).attr('content'));

  // --- JSON-LD
  const ld = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try { walkJsonLd(JSON.parse($(el).contents().text()), ld); } catch { /* битый JSON-LD */ }
  });
  const ldOffer = ld.find((n) => n.price || n.offers?.price || n.lowPrice);
  const ldItem = ld.find((n) => /Product|Apartment|Residence|House|Accommodation|Offer|RealEstate/i.test([].concat(n['@type'] || []).join(' ')));

  const ogTitle = meta('og:title');
  const title = clean(ogTitle || $('h1').first().text() || $('title').text());
  const siteName = meta('og:site_name') || clean(($('title').text().split(/\s[|—–-]\s/).pop() || '')).slice(0, 60);
  const metaDesc = meta('og:description') || meta('description');

  // текст страницы без служебных блоков
  const $body = cheerio.load(html);
  $body('script, style, noscript, svg, iframe, header, footer, nav, form').remove();
  const bodyText = clean($body('main').text() || $body('body').text()).slice(0, 20000);
  const headText = [title, ogTitle, metaDesc, clean($('title').text()), clean($('h1').first().text())].join(' | ');
  const all = headText + ' | ' + bodyText;

  // --- цена
  let price = toNum(ldOffer?.price ?? ldOffer?.offers?.price ?? ldOffer?.lowPrice);
  if (!price) {
    const m = headText.match(/(\d{1,3}(?:[  ]\d{3}){2,}|\d{6,10})\s*(?:₽|руб|р\.)/i) || bodyText.match(/(\d{1,3}(?:[  ]\d{3}){2,})\s*(?:₽|руб)/i);
    price = m ? toNum(m[1]) : null;
  }
  if (price && (price < 100000 || price > 5e9)) price = null;

  // --- площади
  const areaRe = /(\d{1,4}(?:[.,]\d{1,2})?)\s*(?:м²|м2|м\s?2|кв\.?\s*м)/i;
  let area_total = toNum((headText.match(areaRe) || [])[1]);
  const mTotal = all.match(/(?:общая\s+площадь|площадь\s+общая|площадь)\s*[:\-–]?\s*(\d{1,4}(?:[.,]\d{1,2})?)/i);
  if (!area_total && mTotal) area_total = toNum(mTotal[1]);
  if (!area_total) area_total = toNum((bodyText.match(areaRe) || [])[1]);
  const area_kitchen = toNum((all.match(/(?:площадь\s+)?кухн[яи][^\d]{0,20}(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:м|кв)/i) || [])[1]);
  const area_living = toNum((all.match(/жил(?:ая|ой)\s*(?:площадь)?[^\d]{0,15}(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:м|кв)/i) || [])[1]);

  // --- комнаты
  let rooms = null;
  if (/студи/i.test(headText)) rooms = 0;
  else {
    const m = headText.match(/(\d)\s*-?\s*(?:комн|к\.?\s*кв|-?к\b|комнатн)/i)
      || all.match(/(?:комнат|количество\s+комнат)\s*[:\-–]?\s*(\d)/i)
      || all.match(/(\d)\s*-?\s*комнатн/i);
    rooms = m ? Number(m[1]) : null;
  }

  // --- этаж
  let floor = null;
  let floors = null;
  const fOf = all.match(/этаж\s*[:\-–]?\s*(\d{1,2})\s*(?:из|\/)\s*(\d{1,2})/i) || all.match(/(\d{1,2})\s*\/\s*(\d{1,2})\s*эт/i);
  if (fOf) { floor = Number(fOf[1]); floors = Number(fOf[2]); } else {
    const f = headText.match(/(\d{1,2})\s*этаж/i) || all.match(/этаж\s*[:\-–]?\s*(\d{1,2})\b/i);
    floor = f ? Number(f[1]) : null;
    const fl = all.match(/(?:этажность|этажей\s+в\s+доме|всего\s+этажей)\s*[:\-–]?\s*(\d{1,2})/i);
    floors = fl ? Number(fl[1]) : null;
  }

  // --- ЖК и адрес
  const crumbs = $('[class*="breadcrumb"] a, [class*="breadcrumb"] span, [itemtype*="BreadcrumbList"] [itemprop="name"]').map((_, el) => clean($(el).text())).get();
  const complex = clean((all.match(/ЖК\s*[«"„]?\s*([А-ЯЁA-Z0-9][^,»"“|.]{1,40})/) || [])[1])
    || crumbs.find((c) => /^(ЖК|квартал|жилой)/i.test(c))?.replace(/^ЖК\s*/i, '') || null;
  const ldAddr = ld.find((n) => n.address)?.address;
  let address = typeof ldAddr === 'string' ? ldAddr : clean([ldAddr?.addressLocality, ldAddr?.streetAddress].filter(Boolean).join(', '));
  if (!address) {
    const a = all.match(/((?:г\.\s*)?Тюмень[^|]{0,10}?,?\s*)?((?:ул\.|улица|пр-т|проспект|пер\.|переулок|проезд|тракт|бульвар|б-р|наб\.|набережная)\s+[А-ЯЁA-Za-zа-яё0-9\- .]{2,40}?,?\s*(?:д\.\s*)?\d{1,4}[а-яА-Я]?(?:\/\d+)?(?:\s*(?:к|корп\.?|стр\.?)\s*\d+)?)/);
    address = a ? clean((a[1] || '') + a[2]) : null;
  }

  // --- описание: meta description или самый длинный абзац основного текста
  // описание: абзац с наибольшим числом «квартирных» слов (не новости, не ипотека, не реклама)
  const KEY = /(квартир|комнат|кухн|спальн|гостин|планиров|санузел|балкон|лоджи|окн|вид\s|отделк|ремонт|потолк|этаж|дом\b|двор|паркинг)/gi;
  const NOISE = /(ипотек|новост|акци[яи]|cookie|персональн|скидк|кэшбэк|рассрочк|подписк)/i;
  let description = '';
  let best = 0;
  $body('p, [class*="description"], [class*="desc"], [class*="about"], [class*="text"]').each((_, el) => {
    const t = clean($body(el).text());
    if (t.length < 60 || t.length > 5000 || NOISE.test(t)) return;
    const score = (t.match(KEY) || []).length * 10 + Math.min(t.length, 1500) / 100;
    if (score > best) { best = score; description = t; }
  });
  if (!description || best < 20) description = metaDesc || description;

  // --- картинки-кандидаты
  const seen = new Map();
  const add = (u, weight, hint = '') => {
    const url = abs(pageUrl, u);
    if (!url || !isCandidate(url, hint) || SYSTEM_IMG.test(url)) return;
    const key = imageKey(url);
    const prev = seen.get(key);
    if (!prev || weight > prev.weight) seen.set(key, { url, weight, order: prev?.order ?? seen.size });
  };
  const og = meta('og:image');
  if (og) add(og, 100);
  for (const n of ld) for (const img of [].concat(n.image || []).flat()) add(typeof img === 'string' ? img : img?.url || img?.contentUrl, 90);
  $('img, source').each((_, el) => {
    const $el = $(el);
    if ($el.closest(SYSTEM_CONTAINER).length) return;
    const hint = `${$el.attr('alt') || ''} ${$el.attr('class') || ''} ${$el.attr('id') || ''}`;
    if (SYSTEM_IMG.test(hint)) return;
    const w = Number($el.attr('width')) || 0;
    const h = Number($el.attr('height')) || 0;
    if ((w && w < 200) || (h && h < 150)) return;
    const src = largestFromSrcset($el.attr('srcset') || $el.attr('data-srcset') || '')
      || $el.attr('data-src') || $el.attr('data-lazy') || $el.attr('data-original') || $el.attr('data-full') || $el.attr('src');
    const isGallery = /gallery|slider|swiper|photo|plan|layout|планир|фото/i.test(hint + ($el.parent().attr('class') || ''));
    add(src, PLAN_HINT.test(String(src) + hint) ? 80 : isGallery ? 60 : 40, hint);
  });
  // адреса картинок в атрибутах (style="background-image", data-*) и в данных страницы
  const raw = html.replace(/<(header|footer|nav)\b[\s\S]*?<\/\1>/gi, '');
  for (const m of raw.matchAll(/https?:\/\/[^\s"'()<>\\]+?\.(?:jpe?g|png|webp|avif|svg)(?:@[a-z]+)?(?:\?[^\s"'()<>\\]*)?(?=["'()\s<>\\])/gi)) {
    add(m[0], PLAN_HINT.test(m[0]) ? 75 : 30);
  }
  $('a[href]').each((_, el) => {
    const $el = $(el);
    if ($el.closest(SYSTEM_CONTAINER).length) return;
    const href = $el.attr('href');
    if (IMG_EXT.test(href || '')) add(href, 70); // ссылки на полноразмерные фото в галереях
  });
  const images = [...seen.values()].sort((a, b) => b.weight - a.weight || a.order - b.order).map((x) => x.url).slice(0, 80);

  const roomsTxt = rooms === 0 ? 'Студия' : rooms ? `${rooms}-к квартира` : 'Квартира';
  const builtTitle = area_total ? `${roomsTxt}, ${String(area_total).replace('.', ',')} м²${complex ? `, ЖК ${complex}` : ''}` : null;
  return {
    title: (builtTitle || title.split(/\s[|—–]\s/)[0]).slice(0, 200) || null,
    pageTitle: title.slice(0, 300) || null,
    siteName: siteName || null,
    price: price ? Math.round(price) : null,
    rooms, floor, floors, area_total, area_living, area_kitchen,
    address: address || null,
    complex,
    description: description.slice(0, 5000),
    images,
  };
}

// ---------- Размер картинки по первым байтам (без сторонних библиотек) ----------

export function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG
  if (buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), type: 'png' };
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7), type: 'jpg' };
      }
      i += 2 + len;
    }
    return null;
  }
  // WEBP
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3), type: 'webp' };
    if (chunk === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff, type: 'webp' };
    if (chunk === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1, type: 'webp' };
    }
  }
  return null;
}

/** Фото объекта, а не служебная графика: достаточно крупное и не слишком вытянутое. */
export function isContentImage(size, bytes) {
  if (!size) return false;
  const { w, h } = size;
  if (w < 400 || h < 300) return false;
  const ratio = w / h;
  if (ratio > 3 || ratio < 0.33) return false; // баннеры и полосы
  return bytes > 12 * 1024;
}
