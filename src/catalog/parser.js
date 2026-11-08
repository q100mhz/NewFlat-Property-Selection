import * as cheerio from 'cheerio';

const clean = (s) => (s || '').replace(/[​ ]/g, ' ').replace(/\s+/g, ' ').trim();

export function absUrl(base, href) {
  if (!href) return null;
  try { return new URL(href, base).toString(); } catch { return null; }
}

function num(s) {
  if (s == null) return null;
  const m = String(s).replace(/\s/g, '').replace(',', '.').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function parseCoords(s) {
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr) && arr.length === 2 && arr.every((x) => Number.isFinite(Number(x)))) {
      return { lat: Number(arr[0]), lng: Number(arr[1]) };
    }
  } catch { /* ignore */ }
  return { lat: null, lng: null };
}

function parseRooms(v) {
  if (v == null) return null;
  if (/студ/i.test(v)) return 0;
  return num(v);
}

/** Извлекает числовые поля из пар «название → значение». */
export function normalizeProps(props) {
  const out = {};
  for (const [nameRaw, value] of Object.entries(props)) {
    const name = nameRaw.toLowerCase();
    if (name.includes('количество комнат')) out.rooms = parseRooms(value);
    else if (name.startsWith('этажность')) out.floors = num(value);
    else if (name.startsWith('этаж')) {
      const m = String(value).match(/(\d+)\s*\/\s*(\d+)/);
      if (m) { out.floor = Number(m[1]); out.floors = Number(m[2]); } else out.floor = num(value);
    } else if (name.includes('общ') && name.includes('жил')) {
      const parts = String(value).split('/').map(num);
      out.area_total = parts[0] ?? null; out.area_living = parts[1] || null; out.area_kitchen = parts[2] || null;
    } else if (name.startsWith('общая площадь')) out.area_total = num(value);
    else if (name.startsWith('жилая площадь')) out.area_living = num(value) || null;
    else if (name.startsWith('площадь кухни')) out.area_kitchen = num(value) || null;
    else if (name.startsWith('площадь') && out.area_total == null) out.area_total = num(value);
  }
  return out;
}

/** Разбор страницы списка (раздела каталога). */
export function parseListing(html, pageUrl) {
  const $ = cheerio.load(html);
  const items = [];
  $('.catalog-cards__item').each((_, el) => {
    const $el = $(el);
    const card = $el.find('.catalog-card');
    if (!card.length) return;
    const idAttr = $el.attr('id') || '';
    const id = Number(card.find('[data-id]').attr('data-id') || (idAttr.match(/_(\d+)$/) || [])[1]);
    const link = card.find('a.catalog-card__name').first();
    const href = link.attr('href') || card.find('a.catalog-card__image-w').attr('href');
    if (!id || !href) return;
    const mapLink = card.find('.map-link').first();
    const props = {};
    card.find('.catalog-card__property').each((__, p) => {
      const name = clean($(p).find('.catalog-card__property-name').text()).replace(/:$/, '');
      const value = clean($(p).find('.catalog-card__property-value').text());
      if (name) props[name] = value;
    });
    const priceRaw = card.find('[data-currency-base]').first().attr('data-currency-base');
    items.push({
      id,
      url: absUrl(pageUrl, href),
      title: clean(link.attr('title') || link.text()),
      address: clean(mapLink.attr('data-address') || mapLink.text()),
      ...parseCoords(mapLink.attr('data-coords')),
      price: priceRaw ? Math.round(Number(priceRaw)) || null : null,
      thumb: absUrl(pageUrl, card.find('.catalog-card__image').attr('data-bg')),
      listed_at: clean(card.find('.catalog-card__date').text()) || null,
      props,
      ...normalizeProps(props),
    });
  });

  let lastPage = 1;
  $('a[href*="PAGEN_"]').each((_, a) => {
    const m = ($(a).attr('href') || '').match(/PAGEN_\d+=(\d+)/);
    if (m) lastPage = Math.max(lastPage, Number(m[1]));
  });
  return { items, lastPage };
}

/** Разбор детальной страницы объекта. */
export function parseDetail(html, pageUrl) {
  const $ = cheerio.load(html);
  const title = clean($('h1#pagetitle').text() || $('meta[property="og:title"]').attr('content'));
  if (!title) return null;

  const id = Number($('.image-actions .add2favourites[data-id]').attr('data-id')
    || $('.object-info [data-id]').attr('data-id')
    || $('[data-id]').first().attr('data-id')) || null;

  const photos = [];
  $('.object-gallery-previews figure a[href]').each((_, a) => {
    const big = absUrl(pageUrl, $(a).attr('href'));
    const small = absUrl(pageUrl, $(a).find('img').attr('src') || $(a).find('img').attr('data-src'));
    if (big && !photos.some((p) => p.big === big)) photos.push({ big, small: small || big });
  });

  const props = {};
  let address = '';
  let coords = { lat: null, lng: null };
  $('.object-option .dl_element').each((_, el) => {
    const spans = $(el).children('span');
    const name = clean($(spans[0]).text()).replace(/:$/, '');
    if (!name) return;
    if (name === 'Адрес') {
      const ml = $(el).find('.map-link');
      address = clean(ml.attr('data-address') || ml.text());
      coords = parseCoords(ml.attr('data-coords'));
      return;
    }
    const value = clean($(spans[1]).text());
    if (value && value !== '0 м2' && value !== '0 м 2') props[name] = value;
  });

  const priceRaw = $('.object-price[data-currency-base]').attr('data-currency-base');
  const descriptionHtml = $('.object-text').first().html() || '';
  const description = cheerio.load(`<div>${descriptionHtml.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '</p>\n')}</div>`)('div')
    .text().replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();

  return {
    id,
    url: pageUrl,
    title,
    address: address || clean($('.section-description').first().text()),
    ...coords,
    price: priceRaw ? Math.round(Number(priceRaw)) || null : null,
    price_per_m2: clean($('.object-price_area').first().text()) || null,
    photos,
    props,
    description: description.slice(0, 5000),
    ...normalizeProps(props),
  };
}
