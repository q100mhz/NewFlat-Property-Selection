import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `propsel-test-${process.pid}.sqlite`);
process.env.SESSION_SECRET = 'x'.repeat(40);
process.env.B24_CLIENT_ID = 'local.test.1';
process.env.B24_CLIENT_SECRET = 'secret';
process.env.CRAWL_ON_START = '0';

let m;
before(async () => {
  m = {
    session: await import('../src/session.js'),
    bitrix: await import('../src/bitrix.js'),
    sel: await import('../src/selections.js'),
    db: (await import('../src/db.js')).db,
  };
});

test('сессия: подпись и защита от подмены', () => {
  const t = m.session.createSession({ memberId: 'm1', entityType: 'lead', entityId: 5 });
  assert.equal(m.session.readSession(t).entityId, 5);
  const [body, sig] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ memberId: 'm1', entityType: 'lead', entityId: 6, exp: 9e9 })).toString('base64url');
  assert.equal(m.session.readSession(`${forged}.${sig}`), null);
  assert.equal(m.session.readSession(`${body}.x${sig.slice(1)}`), null);
});

test('домены портала: отсекаются локальные и мусорные', () => {
  assert.equal(m.bitrix.validDomain('agency.bitrix24.ru'), 'agency.bitrix24.ru');
  assert.equal(m.bitrix.validDomain('localhost'), null);
  assert.equal(m.bitrix.validDomain('127.0.0.1'), null);
  assert.equal(m.bitrix.validDomain('evil.com/rest'), null);
});

test('REST от имени приложения: токен обновляется при истечении', async () => {
  m.bitrix.savePortal({ memberId: 'm1', domain: 'agency.bitrix24.ru', accessToken: 'old', refreshToken: 'r1', expiresIn: -100 });
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push(String(url));
    if (String(url).startsWith('https://oauth.bitrix.info/')) {
      return new Response(JSON.stringify({ access_token: 'new', refresh_token: 'r2', expires_in: 3600, domain: 'agency.bitrix24.ru' }));
    }
    const body = JSON.parse(opts.body);
    return new Response(JSON.stringify({ result: { auth: body.auth } }));
  };
  try {
    const r = await m.bitrix.callAsApp('m1', 'crm.lead.get', { id: 1 });
    assert.equal(r.result.auth, 'new');
    assert.match(calls[0], /grant_type=refresh_token/);
    assert.match(calls[0], /client_id=local\.test\.1/);
    assert.equal(m.bitrix.getPortal('m1').refresh_token, 'r2');
  } finally {
    global.fetch = realFetch;
  }
});

test('комментарий в таймлайн: группы, причины, экранирование BB-кодов', () => {
  const s = { id: 7, token: 'tok_tok_tok_tok_tok', title: 'Тест', submit_count: 0, member_id: 'm1' };
  const obj = (id, title) => ({ id, url: `https://newflat72.ru/predlozhenija/x/${id}/`, title, price: 5000000 });
  const text = m.sel.buildFeedbackComment(s, [
    { object: obj(1, 'Квартира А'), reaction: 'like', wantViewing: true, reasons: [], clientComment: 'Отлично' },
    { object: obj(2, 'Квартира Б'), reaction: 'dislike', reasons: ['Цена', 'Этаж'], clientComment: 'дорого [URL=x]' },
    { object: obj(3, 'Квартира В'), reaction: null, reasons: [] },
  ]);
  assert.match(text, /👍 Нравится \(1\)/);
  assert.match(text, /хочет на просмотр/);
  assert.match(text, /причины: Цена, Этаж/);
  assert.match(text, /Без оценки \(1\)/);
  assert.ok(!text.includes('[URL=x]'));
});

test('публичная подборка: реакции сохраняются и проверяются', async () => {
  const { db } = m;
  db.prepare(`INSERT OR REPLACE INTO objects (id, url, title, price, active) VALUES (101, 'https://newflat72.ru/predlozhenija/a/', 'Объект', 1000000, 1)`).run();
  const info = db.prepare(`INSERT INTO selections (token, member_id, entity_type, entity_id) VALUES ('AbCdEfGhIjKlMnOpQr', 'm1', 'lead', 5)`).run();
  const item = db.prepare(`INSERT INTO selection_items (selection_id, object_id, snapshot_json) VALUES (?, 101, ?)`)
    .run(info.lastInsertRowid, JSON.stringify({ id: 101, url: 'https://newflat72.ru/predlozhenija/a/', title: 'Объект', price: 1000000 }));
  assert.ok(m.sel.saveReaction('AbCdEfGhIjKlMnOpQr', item.lastInsertRowid, { reaction: 'dislike', reasons: ['Цена', 'Взлом'], comment: 'нет' }));
  const pub = m.sel.getPublicSelection('AbCdEfGhIjKlMnOpQr');
  assert.equal(pub.items[0].reaction, 'dislike');
  assert.deepEqual(pub.items[0].reasons, ['Цена']);
  assert.equal(m.sel.getPublicSelection('wrong-token-value-xx'), null);
  // сотрудник другой сущности не видит подборку
  assert.equal(m.sel.getSelectionForAgent({ memberId: 'm1', entityType: 'lead', entityId: 6 }, info.lastInsertRowid), null);
  assert.ok(m.sel.getSelectionForAgent({ memberId: 'm1', entityType: 'deal', entityId: 9, leadId: 5 }, info.lastInsertRowid));
});
