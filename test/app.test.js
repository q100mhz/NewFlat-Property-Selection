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

test('автосводка: одна запись в таймлайн после изменений, повтор только после новых изменений', async () => {
  const { db } = m;
  m.bitrix.savePortal({ memberId: 'm2', domain: 'agency.bitrix24.ru', accessToken: 'a', refreshToken: 'r', expiresIn: 3600 });
  db.prepare(`INSERT OR REPLACE INTO objects (id, url, title, price, active) VALUES (202, 'https://newflat72.ru/predlozhenija/b/', 'Объект Б', 2000000, 1)`).run();
  const info = db.prepare(`INSERT INTO selections (token, member_id, entity_type, entity_id, created_by_id) VALUES ('DigestTokenDigestTok', 'm2', 'deal', 8, 3)`).run();
  const item = db.prepare(`INSERT INTO selection_items (selection_id, object_id, snapshot_json) VALUES (?, 202, ?)`)
    .run(info.lastInsertRowid, JSON.stringify({ id: 202, url: 'https://newflat72.ru/predlozhenija/b/', title: 'Объект Б', price: 2000000 }));

  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null });
    return new Response(JSON.stringify({ result: String(url).includes('crm.deal.get') ? { ASSIGNED_BY_ID: 3 } : true }));
  };
  const events = [];
  const { bus } = await import('../src/events.js');
  const onEv = (e) => events.push(e.kind);
  bus.on('selection', onEv);
  try {
    await m.sel.processPendingDigests(0); // сводки, оставшиеся от предыдущих тестов
    calls.length = 0; events.length = 0;
    assert.equal(await m.sel.processPendingDigests(0), 0, 'без изменений клиента сводки нет');
    m.sel.saveReaction('DigestTokenDigestTok', item.lastInsertRowid, { reaction: 'like', comment: 'Нравится' });
    assert.deepEqual(events, ['reaction']);
    assert.equal(await m.sel.processPendingDigests(60), 0, 'клиент ещё активен — ждём');
    assert.equal(await m.sel.processPendingDigests(0), 1);
    const timeline = calls.filter((c) => c.url.includes('crm.timeline.comment.add'));
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].body.fields.ENTITY_TYPE, 'deal');
    assert.equal(timeline[0].body.fields.AUTHOR_ID, 3);
    assert.match(timeline[0].body.fields.COMMENT, /👍 Нравится \(1\)/);
    assert.equal(await m.sel.processPendingDigests(0), 0, 'повторно без новых изменений не отправляется');
    m.sel.saveReaction('DigestTokenDigestTok', item.lastInsertRowid, { reaction: 'dislike', reasons: ['Цена'] });
    assert.equal(await m.sel.processPendingDigests(0), 1);
    const second = calls.filter((c) => c.url.includes('crm.timeline.comment.add'))[1];
    assert.match(second.body.fields.COMMENT, /\(обновлено\)/);
  } finally {
    global.fetch = realFetch;
    bus.off('selection', onEv);
  }
});

test('название по умолчанию: «Подборка на» по тюменскому времени', () => {
  assert.equal(m.sel.defaultTitle(new Date('2026-11-09T09:05:00Z')), 'Подборка на 09.11.2026 14:05');
  assert.equal(m.sel.defaultTitle(new Date('2026-11-09T19:30:00Z')), 'Подборка на 10.11.2026 00:30');
});

test('права: руководитель видит своё подразделение и вложенные, сотрудник — только себя', async () => {
  const { computeScope } = await import('../src/access.js');
  const org = {
    departments: [
      { id: 1, name: 'Компания', parent: null, head: 100 },
      { id: 2, name: 'Отдел продаж', parent: 1, head: 10 },
      { id: 3, name: 'Группа А', parent: 2, head: 20 },
      { id: 4, name: 'Группа Б', parent: 2, head: 30 },
      { id: 5, name: 'Бухгалтерия', parent: 1, head: 40 },
    ],
    users: [
      { id: 10, departments: [2] }, { id: 20, departments: [3] }, { id: 21, departments: [3] },
      { id: 30, departments: [4] }, { id: 31, departments: [4] }, { id: 41, departments: [5] },
    ],
  };
  assert.equal(computeScope(org, 100).all, true, 'руководитель компании видит всё');
  assert.deepEqual(computeScope(org, 10).userIds.sort((a, b) => a - b), [10, 20, 21, 30, 31]);
  assert.deepEqual(computeScope(org, 20).userIds.sort((a, b) => a - b), [20, 21]);
  assert.deepEqual(computeScope(org, 21), { all: false, role: 'employee', userIds: [21], departments: [] });
});

test('дашборд: периоды по Тюмени и фильтрация по правам', async () => {
  const { periodRange, queryDashboard } = await import('../src/dashboard.js');
  const now = new Date('2026-11-09T21:00:00Z'); // 10.11 02:00 по Тюмени
  assert.deepEqual(periodRange({ period: 'today' }, now), { from: '2026-11-09 19:00:00', to: '2026-11-10 19:00:00' });
  assert.deepEqual(periodRange({ period: 'week' }, now), { from: '2026-11-03 19:00:00', to: '2026-11-10 19:00:00' });
  assert.deepEqual(periodRange({ period: 'custom', from: '2026-11-01', to: '2026-11-02' }, now), { from: '2026-10-31 19:00:00', to: '2026-11-02 19:00:00' });

  const { db } = m;
  const ins = db.prepare(`INSERT INTO selections (token, member_id, entity_type, entity_id, created_by_id, created_by_name, created_at) VALUES (?, 'dash', 'lead', ?, ?, ?, ?)`);
  ins.run('dashTokenAAAAAAAAAAAA', 1, 20, 'Анна', '2026-11-09 20:00:00');
  ins.run('dashTokenBBBBBBBBBBBB', 2, 21, 'Борис', '2026-11-09 20:30:00');
  ins.run('dashTokenCCCCCCCCCCCC', 3, 30, 'Вера', '2026-11-01 10:00:00');
  assert.equal(queryDashboard('dash', { all: true }, { period: 'all' }).total, 3);
  assert.equal(queryDashboard('dash', { userIds: [20, 21] }, { period: 'all' }).total, 2);
  assert.equal(queryDashboard('dash', { userIds: [21] }, { period: 'all' }).total, 1);
  const byUser = queryDashboard('dash', { all: true }, { period: 'all', userId: '30' });
  assert.equal(byUser.items[0].createdByName, 'Вера');
});

test('первое открытие подборки клиентом: уведомление автору и ответственному', async () => {
  const { db } = m;
  m.bitrix.savePortal({ memberId: 'm3', domain: 'agency.bitrix24.ru', accessToken: 'a', refreshToken: 'r', expiresIn: 3600 });
  db.prepare(`INSERT INTO selections (token, member_id, entity_type, entity_id, created_by_id) VALUES ('ViewTokenViewTokenVi', 'm3', 'lead', 77, 5)`).run();
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null });
    return new Response(JSON.stringify({ result: String(url).includes('crm.lead.get') ? { ASSIGNED_BY_ID: 9 } : true }));
  };
  try {
    m.sel.registerView('ViewTokenViewTokenVi');
    await new Promise((r) => setTimeout(r, 50));
    const notified = calls.filter((c) => c.url.includes('im.notify.system.add')).map((c) => c.body.USER_ID).sort();
    assert.deepEqual(notified, [5, 9]);
    assert.match(calls.find((c) => c.url.includes('im.notify')).body.MESSAGE, /Клиент открыл подборку/);
    calls.length = 0;
    m.sel.registerView('ViewTokenViewTokenVi');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.filter((c) => c.url.includes('im.notify')).length, 0, 'повторное открытие — без уведомления');
  } finally {
    global.fetch = realFetch;
  }
});

test('главный администратор приложения видит все подборки', async () => {
  const { resolveScope } = await import('../src/access.js');
  const { config } = await import('../src/config.js');
  assert.ok(config.appAdminIds.includes(11341));
  assert.deepEqual(await resolveScope({ memberId: 'x', userId: 11341, isAdmin: true, isAppAdmin: true }), { all: true, role: 'app_admin' });
});

test('удаление: только из архива и только автор или администратор', () => {
  const { db } = m;
  const info = db.prepare(`INSERT INTO selections (token, member_id, entity_type, entity_id, created_by_id) VALUES ('DelTokenDelTokenDelT', 'md', 'lead', 3, 50)`).run();
  db.prepare(`INSERT INTO selection_items (selection_id, object_id, snapshot_json) VALUES (?, 1, '{}')`).run(info.lastInsertRowid);
  const id = info.lastInsertRowid;
  const author = { memberId: 'md', entityType: 'lead', entityId: 3, userId: 50, isAdmin: false };
  const other = { ...author, userId: 51 };
  assert.equal(m.sel.deleteSelection(author, id), 'not_archived');
  m.sel.setArchived(author, id, true);
  assert.equal(m.sel.getPublicSelection('DelTokenDelTokenDelT'), null, 'архивная ссылка у клиента не открывается');
  assert.equal(m.sel.deleteSelection(other, id), 'forbidden');
  assert.equal(m.sel.deleteSelection({ ...other, entityId: 4 }, id), null, 'чужая карточка — не найдена');
  assert.equal(m.sel.deleteSelection({ ...other, isAdmin: true }, id), 'ok');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM selection_items WHERE selection_id = ?').get(id).n, 0, 'объекты удалены каскадом');
});

test('лиды: номера телефонов и права на лид', async () => {
  const { phoneVariants, waPhone, canSeeLead } = await import('../src/leads.js');
  assert.deepEqual(phoneVariants('8 (912) 345-67-89').sort(), ['+79123456789', '79123456789', '89123456789', '9123456789'].sort());
  assert.deepEqual(phoneVariants('12'), []);
  assert.equal(waPhone('+7 (912) 345-67-89'), '79123456789');
  assert.equal(waPhone('9123456789'), '79123456789');
  assert.equal(waPhone('123'), null);
  assert.equal(canSeeLead({ all: true }, { ASSIGNED_BY_ID: '5' }), true);
  assert.equal(canSeeLead({ all: false, userIds: [7] }, { ASSIGNED_BY_ID: '7' }), true);
  assert.equal(canSeeLead({ all: false, userIds: [7] }, { ASSIGNED_BY_ID: '8' }), false);
});
