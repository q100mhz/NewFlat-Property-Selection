import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `propsel-ext-${process.pid}.sqlite`);
process.env.SESSION_SECRET = 'x'.repeat(40);
process.env.CRAWL_ON_START = '0';

let fx, ex, svc, sel, db;
before(async () => {
  fx = await import('../src/external/fetcher.js');
  ex = await import('../src/external/extract.js');
  svc = await import('../src/external/service.js');
  sel = await import('../src/selections.js');
  db = (await import('../src/db.js')).db;
});
const page = (n) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

test('SSRF: внутренние адреса и опасные ссылки запрещены', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '100.64.1.1', '0.0.0.0', '::1', 'fd00::1', '::ffff:127.0.0.1']) {
    assert.equal(fx.isBlockedIp(ip), true, ip);
  }
  assert.equal(fx.isBlockedIp('217.16.18.181'), false);
  for (const u of ['http://localhost:3200/health', 'http://127.0.0.1/', 'http://[::1]/', 'ftp://example.com/', 'http://user:pw@example.com/', 'http://example.com:3200/', 'javascript:alert(1)']) {
    assert.throws(() => fx.checkUrl(u), fx.FetchBlocked, u);
  }
  // имя, которое указывает на внутренний адрес, отсекается при подключении
  await assert.rejects(() => fx.safeFetch('http://127.0.0.1.nip.io/'), (e) => e instanceof fx.FetchBlocked || /недоступен|ENOTFOUND|EAI_AGAIN/.test(e.message + (e.cause?.message || '')));
  await assert.rejects(() => svc.addByLink('http://127.0.0.1:3200/health', { userId: 1 }), /недоступен|Некорректная|порт/);
});

test('разбор страниц застройщиков: цена, площадь, этаж, без телефонов в заголовке', () => {
  const b = ex.extractListing(page('dev-brusnika.html'), 'https://tyumen.brusnika.ru/flat/48982/');
  assert.equal(b.price, 7690000); assert.equal(b.area_total, 59.1); assert.equal(b.floor, 4); assert.equal(b.floors, 8);
  assert.ok(b.images.some((u) => /flat_image_file.*\.svg/.test(u)), 'планировка найдена');
  const s = ex.extractListing(page('dev-sozdateli.html'), 'https://xn--80ahefirqxn.xn--p1ai/realty/18747497');
  assert.equal(s.price, 6190000); assert.equal(s.rooms, 2); assert.equal(s.floor, 13); assert.equal(s.complex, 'Кедровый берег');
  assert.equal(s.title, '2-к квартира, 47,6 м², ЖК Кедровый берег');
  assert.ok(!s.images.some((u) => /_medium|_small/.test(u)) || new Set(s.images.map((u) => u.match(/[0-9a-f]{24,}/)?.[0])).size === s.images.length, 'варианты размеров склеены');
  const t = ex.extractListing(page('dev-tvorchestvo.html'), 'https://xn--b1aai9acjidf1c.xn--p1ai/zhk/luidzhi/flats/2-komnatnaya-kvartira-70.56m-2');
  assert.equal(t.price, 25942500); assert.equal(t.area_total, 70.56); assert.equal(t.rooms, 2);
  assert.doesNotMatch(t.title, /\+7|телефон/);
  for (const r of [b, s, t]) assert.ok(!r.images.some((u) => /logo|favicon|icon|thumbnail-|\.ico/i.test(u)), 'нет служебных картинок');
});

test('служебная графика отсеивается по размеру и пропорциям', () => {
  assert.equal(ex.isContentImage({ w: 1200, h: 800 }, 200000), true);
  assert.equal(ex.isContentImage({ w: 120, h: 40 }, 5000), false, 'логотип');
  assert.equal(ex.isContentImage({ w: 1920, h: 300 }, 90000), false, 'баннер-полоса');
  assert.equal(ex.isContentImage({ w: 600, h: 600 }, 3000), false, 'почти пустая картинка');
});

test('из описания убираются контакты чужих продавцов и агентств', () => {
  const t = svc.cleanContacts('Светлая квартира с видом на парк. Звоните: +7 (912) 345-67-89, Анна. Пишите в WhatsApp. Агентство «Дом» без комиссии. Почта sale@agency.ru, сайт www.agency.ru. Кухня 12 м².');
  assert.match(t, /Светлая квартира с видом на парк/);
  assert.match(t, /Кухня 12 м²/);
  assert.doesNotMatch(t, /\+7|345-67|WhatsApp|Агентство|@|www\./i);
});

test('SVG-планировки со скриптами не принимаются', () => {
  const okSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"><rect width="800" height="600"/></svg>');
  const badSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" onload="alert(1)"><script>alert(1)</script></svg>');
  assert.ok(svc.inspectImage(okSvg));
  assert.equal(svc.inspectImage(badSvg), null);
  assert.equal(svc.photoPath('1000000000', '../../app.sqlite'), null);
  assert.equal(svc.photoPath('../x', '0.jpg'), null);
});

test('правка объекта по ссылке видна во всех подборках, клиент не видит источник', () => {
  const id = svc.EXTERNAL_ID_BASE + 777;
  db.prepare(`INSERT INTO objects (id, url, category, title, price, active, source, source_name, detail_json)
    VALUES (?, 'https://tyumen.brusnika.ru/flat/1/', 'external', 'Квартира', 5000000, 1, 'link', 'Брусника', '{"photos":[{"big":"/photo/1000000777/0.jpg","small":"/photo/1000000777/0.jpg"}],"description":"Текст"}')`).run(id);
  const mk = (token) => {
    const s = db.prepare(`INSERT INTO selections (token, member_id, entity_type, entity_id) VALUES (?, 'mx', 'lead', 1)`).run(token);
    db.prepare(`INSERT INTO selection_items (selection_id, object_id, snapshot_json) VALUES (?, ?, ?)`).run(s.lastInsertRowid, id, JSON.stringify({ id, title: 'Квартира', price: 5000000, url: 'https://tyumen.brusnika.ru/flat/1/' }));
  };
  mk('ExtTokenAAAAAAAAAAAA'); mk('ExtTokenBBBBBBBBBBBB');
  assert.ok(svc.updateLinkObject(id, { title: '2-к квартира, 59 м²', price: '7 690 000', description: 'Исправлено', photos: [] }, { userId: 5 }));
  for (const t of ['ExtTokenAAAAAAAAAAAA', 'ExtTokenBBBBBBBBBBBB']) {
    const p = sel.getPublicSelection(t);
    const o = p.items[0].object;
    assert.equal(o.title, '2-к квартира, 59 м²');
    assert.equal(o.price, 7690000);
    assert.equal(o.description, 'Исправлено');
    assert.equal(o.url, undefined, 'ссылки на источник у клиента нет');
    assert.equal(o.sourceName, undefined);
    assert.doesNotMatch(JSON.stringify(p), /brusnika/i, 'источник не упоминается нигде в ответе клиенту');
  }
  assert.equal(svc.updateLinkObject(123, { title: 'x' }), null, 'объекты newflat не редактируются');
});
