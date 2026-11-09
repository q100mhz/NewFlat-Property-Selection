import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `propsel-auto-${process.pid}.sqlite`);
process.env.SESSION_SECRET = 'x'.repeat(40);
process.env.B24_CLIENT_ID = 'local.test.1';
process.env.B24_CLIENT_SECRET = 'secret';
process.env.CRAWL_ON_START = '0';

let m;
const STAGES = [
  { STATUS_ID: 'NEW', NAME: 'Не обработан', SORT: 10 },
  { STATUS_ID: 'IN_PROCESS', NAME: 'Взято в работу', SORT: 20 },
  { STATUS_ID: 'UC_PREP', NAME: 'Готовлю подбор', SORT: 30 },
  { STATUS_ID: 'UC_DISC', NAME: 'Обсуждение вариантов', SORT: 40 },
  { STATUS_ID: 'UC_SHOW', NAME: 'Показ', SORT: 50 },
  { STATUS_ID: 'UC_MORT', NAME: 'Ипотека', SORT: 60 },
];
const lead = { STATUS_ID: 'UC_DISC', ASSIGNED_BY_ID: 9 };
let calls = [];
let realFetch;

before(async () => {
  m = {
    db: (await import('../src/db.js')).db,
    bitrix: await import('../src/bitrix.js'),
    sel: await import('../src/selections.js'),
    auto: await import('../src/automation.js'),
  };
  m.bitrix.savePortal({ memberId: 'pa', domain: 'agency.bitrix24.ru', accessToken: 'a', refreshToken: 'r', expiresIn: 3600 });
  realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    const body = opts?.body ? JSON.parse(opts.body) : null;
    calls.push({ method: u.replace(/^.*\/rest\/|\.json$/g, ''), body });
    if (u.includes('crm.status.list')) return new Response(JSON.stringify({ result: STAGES }));
    if (u.includes('crm.lead.get')) return new Response(JSON.stringify({ result: { ...lead } }));
    if (u.includes('crm.lead.update')) { lead.STATUS_ID = body.fields.STATUS_ID; return new Response(JSON.stringify({ result: true })); }
    return new Response(JSON.stringify({ result: true }));
  };
});
after(() => { global.fetch = realFetch; });
beforeEach(() => { calls = []; lead.STATUS_ID = 'UC_DISC'; });

let n = 0;
function makeSelection(objects = 3) {
  n++;
  const { db } = m;
  const info = db.prepare(`INSERT INTO selections (token, member_id, entity_type, entity_id, title, created_by_id) VALUES (?, 'pa', 'lead', 500, ?, 5)`)
    .run(`autoTokenAutoToken${String(n).padStart(4, '0')}`, `Подборка ${n}`);
  const items = [];
  for (let i = 0; i < objects; i++) {
    const oid = 1000 + n * 10 + i;
    db.prepare(`INSERT OR REPLACE INTO objects (id, url, title, active) VALUES (?, ?, ?, 1)`).run(oid, `https://newflat72.ru/predlozhenija/x/${oid}/`, `Квартира ${oid}`);
    items.push(db.prepare(`INSERT INTO selection_items (selection_id, object_id, snapshot_json) VALUES (?, ?, ?)`)
      .run(info.lastInsertRowid, oid, JSON.stringify({ id: oid, url: `https://newflat72.ru/predlozhenija/x/${oid}/`, title: `Квартира ${oid}` })).lastInsertRowid);
  }
  const row = db.prepare('SELECT * FROM selections WHERE id = ?').get(info.lastInsertRowid);
  m.auto.startForSelection(row);
  return { id: row.id, token: row.token, items };
}
const state = (id) => m.db.prepare('SELECT auto_state, auto_note FROM selections WHERE id = ?').get(id);
const methods = () => calls.map((c) => c.method);

test('стадии находятся по названиям', async () => {
  const rules = await m.auto.getRules('pa');
  assert.deepEqual({ ...rules, source: undefined }, { enabled: true, discussion: 'UC_DISC', viewing: 'UC_SHOW', rejected: 'UC_PREP', source: undefined });
});

test('«хочу на просмотр» → стадия «Показ» и дело «Согласовать просмотр»', async () => {
  const s = makeSelection();
  m.sel.saveReaction(s.token, s.items[0], { reaction: 'like', wantViewing: true });
  m.sel.saveReaction(s.token, s.items[1], { reaction: 'dislike', reasons: ['Цена'] });
  await m.sel.processPendingDigests(0);
  const upd = calls.find((c) => c.method === 'crm.lead.update');
  assert.deepEqual(upd.body, { id: 500, fields: { STATUS_ID: 'UC_SHOW' }, auth: 'a' });
  const todo = calls.find((c) => c.method === 'crm.activity.todo.add');
  assert.equal(todo.body.title, 'Согласовать просмотр');
  assert.equal(todo.body.ownerTypeId, 1);
  assert.equal(todo.body.responsibleId, 9);
  assert.match(todo.body.description, /Квартира/);
  assert.ok(calls.some((c) => c.method === 'crm.timeline.comment.add' && /стадию «Показ»/.test(c.body.fields.COMMENT)));
  assert.equal(state(s.id).auto_state, 'done');
});

test('все объекты «не подходит» → стадия «Готовлю подбор», без дела', async () => {
  const s = makeSelection(2);
  for (const it of s.items) m.sel.saveReaction(s.token, it, { reaction: 'dislike' });
  await m.sel.processPendingDigests(0);
  assert.equal(calls.find((c) => c.method === 'crm.lead.update').body.fields.STATUS_ID, 'UC_PREP');
  assert.ok(!methods().includes('crm.activity.todo.add'));
  assert.equal(state(s.id).auto_state, 'done');
});

test('не все объекты оценены или есть «нравится» → стадию не трогаем', async () => {
  const s = makeSelection(3);
  m.sel.saveReaction(s.token, s.items[0], { reaction: 'dislike' });
  m.sel.saveReaction(s.token, s.items[1], { reaction: 'dislike' });
  await m.sel.processPendingDigests(0);
  assert.ok(!methods().includes('crm.lead.update'));
  m.sel.saveReaction(s.token, s.items[2], { reaction: 'like' });
  await m.sel.processPendingDigests(0);
  assert.ok(!methods().includes('crm.lead.update'));
  assert.equal(state(s.id).auto_state, 'active');
});

test('лид увели с «Обсуждения вариантов» вручную → автоматизация остановлена навсегда для подборки', async () => {
  const s = makeSelection(1);
  await m.auto.checkSelection(s.id); // лид на обсуждении → active
  assert.equal(state(s.id).auto_state, 'active');
  lead.STATUS_ID = 'UC_MORT';
  m.sel.saveReaction(s.token, s.items[0], { reaction: 'like', wantViewing: true });
  await m.sel.processPendingDigests(0);
  assert.equal(state(s.id).auto_state, 'stopped');
  lead.STATUS_ID = 'UC_DISC'; // вернули обратно — по этой подборке уже не двигаем
  m.sel.saveReaction(s.token, s.items[0], { reaction: 'like', wantViewing: true });
  await m.sel.processPendingDigests(0);
  assert.ok(!methods().includes('crm.lead.update'));
});

test('лид ещё не на «Обсуждении вариантов» → ждём; новая подборка запускает сценарий заново', async () => {
  lead.STATUS_ID = 'UC_PREP';
  const s1 = makeSelection(1);
  m.sel.saveReaction(s1.token, s1.items[0], { reaction: 'like', wantViewing: true });
  await m.sel.processPendingDigests(0);
  assert.equal(state(s1.id).auto_state, 'waiting');
  assert.ok(!methods().includes('crm.lead.update'));

  const s2 = makeSelection(1);
  assert.equal(state(s1.id).auto_state, 'superseded');
  lead.STATUS_ID = 'UC_DISC';
  m.sel.saveReaction(s2.token, s2.items[0], { reaction: 'dislike' });
  await m.sel.processPendingDigests(0);
  assert.equal(calls.find((c) => c.method === 'crm.lead.update').body.fields.STATUS_ID, 'UC_PREP');
});

test('автоматизация выключена администратором → стадию не трогаем', async () => {
  m.auto.saveRules('pa', { enabled: false, discussion: 'UC_DISC', viewing: 'UC_SHOW', rejected: 'UC_PREP' });
  const s = makeSelection(1);
  m.sel.saveReaction(s.token, s.items[0], { reaction: 'like', wantViewing: true });
  await m.sel.processPendingDigests(0);
  assert.ok(!methods().includes('crm.lead.update'));
  m.auto.saveRules('pa', { enabled: true, discussion: 'UC_DISC', viewing: 'UC_SHOW', rejected: 'UC_PREP' });
});

test('срок дела: до 17:00 — сегодня 18:00, позже — завтра 12:00 (Тюмень)', () => {
  assert.equal(m.auto.todoDeadline(new Date('2026-11-09T06:00:00Z')).toISOString(), '2026-11-09T13:00:00.000Z'); // 11:00 → 18:00
  assert.equal(m.auto.todoDeadline(new Date('2026-11-09T13:30:00Z')).toISOString(), '2026-11-10T07:00:00.000Z'); // 18:30 → завтра 12:00
});
