// Проверки защиты: сервер в боевом режиме, запросы как от внешнего посетителя (через nginx)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

Object.assign(process.env, {
  NO_LISTEN: '1', DEV_MODE: '0', CRAWL_ON_START: '0',
  DB_PATH: path.join(os.tmpdir(), `propsel-sec-${process.pid}.sqlite`),
  SESSION_SECRET: 's'.repeat(40), B24_CLIENT_ID: 'local.test.1', B24_CLIENT_SECRET: 'secret',
  B24_ALLOWED_DOMAINS: 'agency.bitrix24.ru',
  BASE_URL: 'https://app.example.ru', PUBLIC_URL: 'https://client.example.ru',
});

let server, port, realFetch, bitrix;
const b24 = { admin: false, calls: [] };

before(async () => {
  const { app } = await import('../src/server.js');
  bitrix = await import('../src/bitrix.js');
  // имитация Битрикс24 (сервер обращается к порталу через fetch)
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    b24.calls.push(u);
    if (u.endsWith('/app.info.json')) return new Response(JSON.stringify({ result: { CODE: 'local.test.1' } }));
    if (u.endsWith('/user.current.json')) return new Response(JSON.stringify({ result: { ID: '7', NAME: 'Иван', ADMIN: b24.admin } }));
    if (u.endsWith('/crm.lead.get.json')) return new Response(JSON.stringify({ result: { ID: '55', TITLE: 'Чужой лид', ASSIGNED_BY_ID: '99' } }));
    return new Response(JSON.stringify({ result: true }));
  };
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => { globalThis.fetch = realFetch; server.close(); });

/** Запрос «снаружи»: как его передаёт nginx. */
function req(method, p, { host = 'app.example.ru', body, headers = {}, external = true } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? new URLSearchParams(body).toString() : null;
    const r = http.request({
      host: '127.0.0.1', port, method, path: p,
      headers: {
        Host: host,
        ...(external ? { 'X-Forwarded-For': '203.0.113.' + (headers.ip || 10), 'X-Forwarded-Proto': 'https' } : {}),
        ...(data ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: t }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test('корень сайта и неизвестные адреса — нейтральное «не найдено»', async () => {
  for (const p of ['/', '/nonexistent', '/b24/handler', '/b24/install', '/.env', '/package.json', '/static/', '/dev/placement']) {
    const r = await req('GET', p);
    assert.equal(r.status, 404, p);
    assert.doesNotMatch(r.text, /Битрикс|Bitrix|Cannot GET|Express|Подборк/i, p);
  }
});

test('/health снаружи не отвечает, изнутри сервера — работает', async () => {
  assert.equal((await req('GET', '/health')).status, 404);
  assert.equal((await req('GET', '/health', { external: false })).status, 200);
});

test('код интерфейса сотрудника не раздаётся публично, ресурсы клиента — да', async () => {
  for (const p of ['/static/app/app.js', '/static/app/dashboard.html', '/static/app/dashboard.js', '/static/app/index.html']) {
    assert.equal((await req('GET', p)).status, 404, p);
  }
  assert.equal((await req('GET', '/static/client/client.js')).status, 200);
});

test('заголовки безопасности', async () => {
  const r = await req('GET', '/s/AAAAAAAAAAAAAAAAAAAAAA', { host: 'client.example.ru' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.match(r.headers['strict-transport-security'], /max-age=/);
  assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(r.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(r.headers['x-powered-by'], undefined);
});

test('старая ссылка на служебном адресе переадресуется на адрес для клиентов', async () => {
  const r = await req('GET', '/s/AAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(r.status, 301);
  assert.equal(r.headers.location, 'https://client.example.ru/s/AAAAAAAAAAAAAAAAAAAAAA');
});

test('API без входа: 401 без подробностей', async () => {
  const r = await req('GET', '/api/dashboard');
  assert.equal(r.status, 401);
  assert.deepEqual(JSON.parse(r.text), { error: 'Unauthorized' });
});

test('установку может выполнить только администратор портала', async () => {
  const body = { AUTH_ID: 'tok', REFRESH_ID: 'ref', member_id: 'mem1' };
  b24.admin = false;
  const r1 = await req('POST', '/b24/install?DOMAIN=agency.bitrix24.ru', { body });
  assert.equal(r1.status, 403);
  assert.doesNotMatch(r1.text, /администратор портала\b.*\d|user\.current|app\.info/);
  assert.equal(bitrix.getPortal('mem1'), undefined, 'ключ сотрудника не сохранён');

  b24.admin = true;
  const r2 = await req('POST', '/b24/install?DOMAIN=agency.bitrix24.ru', { body });
  assert.equal(r2.status, 200);
  assert.ok(bitrix.getPortal('mem1'), 'ключ администратора сохранён');
  assert.match(r2.headers['content-security-policy'], /frame-ancestors https:\/\/agency\.bitrix24\.ru/);
  assert.doesNotMatch(r2.text, /src="\/static\//, 'ресурсы встроены в страницу');
});

test('портал не из списка разрешённых — отказ без обращения к нему', async () => {
  b24.calls.length = 0;
  const r = await req('POST', '/b24/install?DOMAIN=evil.example.com', { body: { AUTH_ID: 'x', member_id: 'm' } });
  assert.equal(r.status, 404);
  assert.ok(!b24.calls.some((u) => u.includes('evil.example.com')));
});

test('перебор ссылок подборок блокируется', async () => {
  let last;
  for (let i = 0; i < 35; i++) last = await req('GET', `/api/public/Guess${String(i).padStart(16, 'x')}`, { headers: { ip: 77 } });
  assert.equal(last.status, 429);
  // другой посетитель не затронут
  assert.equal((await req('GET', '/api/public/Guessxxxxxxxxxxxxxxxx1', { headers: { ip: 78 } })).status, 404);
});

test('ссылка из данных с javascript: не попадает в каталог', async () => {
  const { absUrl } = await import('../src/catalog/parser.js');
  assert.equal(absUrl('https://newflat72.ru/', 'javascript:alert(1)'), null);
  assert.equal(absUrl('https://newflat72.ru/', '/upload/a.jpg'), 'https://newflat72.ru/upload/a.jpg');
});

test('BB-коды из данных не становятся разметкой в таймлайне', async () => {
  const { bb, bbUrl } = await import('../src/session.js');
  assert.equal(bb('Квартира [URL=http://evil]тут[/URL]'), 'Квартира (URL=http://evil)тут(/URL)');
  assert.equal(bbUrl('javascript:alert(1)'), '');
  assert.equal(bbUrl('https://newflat72.ru/x/]evil'), '');
});

test('конструктор для лида с дашборда: без сессии — «не найдено», чужой лид — отказ', async () => {
  const { createSession } = await import('../src/session.js');
  assert.equal((await req('POST', '/b24/entity', { body: { leadId: '55' } })).status, 404);
  assert.equal((await req('POST', '/b24/entity', { body: { session: 'подделка', leadId: '55' } })).status, 404);
  const session = createSession({ memberId: 'mem1', userId: 7, userName: 'Иван', isAdmin: false, entityType: null, entityId: null });
  const r = await req('POST', '/b24/entity', { body: { session, leadId: '55' } });
  assert.equal(r.status, 403, 'лид другого сотрудника не открывается');
  assert.doesNotMatch(r.text, /Чужой лид/);
});
