/**
 * Автоматизация стадий лида по ответу клиента на подборку.
 *
 * Работает только для лидов и только когда лид на стадии «Обсуждение вариантов».
 * Решение принимается вместе со сводкой (через N минут тишины после последнего изменения клиента):
 *  - хотя бы один объект «хочу посмотреть вживую» → стадия «Показ» + дело «Согласовать просмотр»;
 *  - все объекты оценены и все «не подходит»      → стадия «Готовлю подбор»;
 *  - иначе ничего не делаем.
 * Состояния подборки (auto_state):
 *  waiting    — лид ещё не на «Обсуждении вариантов», ждём;
 *  active     — лид был на «Обсуждении вариантов», правила применяются;
 *  stopped    — лид увели с «Обсуждения вариантов» (вручную или роботом) — по этой подборке больше не двигаем;
 *  done       — стадия уже изменена автоматически;
 *  superseded — по лиду создана новая подборка, сценарий перешёл к ней.
 */
import { db, getMeta, setMeta } from './db.js';
import { config } from './config.js';
import { callAsApp } from './bitrix.js';
import { emitSelectionChange } from './events.js';
import { localMidnightUtc, localYmd, localHour } from './time.js';
import { bb } from './session.js';

const DEFAULT_NAMES = { discussion: 'Обсуждение вариантов', viewing: 'Показ', rejected: 'Готовлю подбор' };
const STAGES_CACHE_MS = 10 * 60e3;
const stagesCache = new Map();

// ---------- Стадии и правила ----------

/** Стадии лида портала (crm.status.list, ENTITY_ID = STATUS), с кэшем. */
export async function getLeadStages(memberId, { force = false } = {}) {
  if (config.devMode && memberId === 'dev') {
    // режим разработки без Битрикс24: стадии как на портале агентства
    return ['Не обработан', 'Взято в работу', 'Готовлю подбор', 'Обсуждение вариантов', 'Показ', 'Ипотека', 'Бронь / задаток', 'Дозревание']
      .map((name, i) => ({ id: `DEV_${i}`, name, sort: (i + 1) * 10 }));
  }
  const c = stagesCache.get(memberId);
  if (c && !force && Date.now() - c.at < STAGES_CACHE_MS) return c.stages;
  const r = await callAsApp(memberId, 'crm.status.list', { order: { SORT: 'ASC' }, filter: { ENTITY_ID: 'STATUS' } });
  const stages = (r.result || []).map((x) => ({ id: x.STATUS_ID, name: x.NAME, sort: Number(x.SORT) || 0 }))
    .sort((a, b) => a.sort - b.sort);
  stagesCache.set(memberId, { at: Date.now(), stages });
  return stages;
}

const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

/** Находит стадии по названиям (точное совпадение, затем по вхождению). */
export function detectRules(stages) {
  const find = (name) => {
    const n = norm(name);
    return stages.find((s) => norm(s.name) === n) || stages.find((s) => norm(s.name).includes(n));
  };
  const out = {};
  for (const [k, name] of Object.entries(DEFAULT_NAMES)) out[k] = find(name)?.id || null;
  return out;
}

const rulesKey = (memberId) => `stage_rules:${memberId}`;

export function getSavedRules(memberId) {
  try { return JSON.parse(getMeta(rulesKey(memberId)) || 'null'); } catch { return null; }
}

export function saveRules(memberId, { enabled, discussion, viewing, rejected }) {
  const rules = {
    enabled: !!enabled,
    discussion: discussion ? String(discussion).slice(0, 50) : null,
    viewing: viewing ? String(viewing).slice(0, 50) : null,
    rejected: rejected ? String(rejected).slice(0, 50) : null,
  };
  setMeta(rulesKey(memberId), JSON.stringify(rules));
  return rules;
}

/** Действующие правила: сохранённые администратором или найденные по названиям стадий. */
export async function getRules(memberId) {
  const saved = getSavedRules(memberId);
  if (saved) return { ...saved, source: 'saved' };
  const detected = detectRules(await getLeadStages(memberId));
  return { enabled: !!(detected.discussion && detected.viewing && detected.rejected), ...detected, source: 'detected' };
}

// ---------- Решение ----------

/** Чистая функция: что делать по ответам клиента. */
export function decide(items) {
  if (items.some((i) => i.wantViewing)) return 'viewing';
  const relevant = items.filter((i) => !(i.removed && !i.reaction)); // снятые с продажи и не оценённые не учитываем
  if (relevant.length && relevant.every((i) => i.reaction === 'dislike')) return 'rejected';
  return null;
}

/** Срок дела: сегодня до 18:00, а если уже после 17:00 — завтра в 12:00 (по времени агентства). */
export function todoDeadline(now = new Date(), timeZone = config.timezone) {
  const today = localMidnightUtc(localYmd(now, timeZone), timeZone).getTime();
  return localHour(now, timeZone) < 17 ? new Date(today + 18 * 3600e3) : new Date(today + 36 * 3600e3);
}

function setState(id, state, note) {
  db.prepare(`UPDATE selections SET auto_state = ?, auto_note = ?, auto_checked_at = datetime('now') WHERE id = ?`).run(state, note ?? null, id);
}

// ---------- Жизненный цикл ----------

/** Новая подборка по лиду: сценарий начинается заново, прежние подборки лида больше не влияют на стадию. */
export function startForSelection(s) {
  if (s.entity_type !== 'lead') return;
  db.prepare(`UPDATE selections SET auto_state = 'superseded', auto_note = 'Создана новая подборка'
    WHERE member_id = ? AND entity_type = 'lead' AND entity_id = ? AND id <> ? AND auto_state IN ('waiting', 'active')`)
    .run(s.member_id, s.entity_id, s.id);
  setState(s.id, 'waiting', null);
}

/**
 * Проверка подборки: обновляет состояние по текущей стадии лида и, если evaluate,
 * применяет правила. items — элементы подборки (reaction, wantViewing, removed, object).
 */
export async function checkSelection(selectionId, { evaluate = false, items = [] } = {}) {
  const s = db.prepare('SELECT * FROM selections WHERE id = ?').get(selectionId);
  if (!s || s.entity_type !== 'lead' || !['waiting', 'active'].includes(s.auto_state)) return null;
  const rules = await getRules(s.member_id);
  if (!rules.enabled || !rules.discussion) return null;

  const lead = (await callAsApp(s.member_id, 'crm.lead.get', { id: s.entity_id })).result;
  if (!lead) return null;
  if (lead.STATUS_ID !== rules.discussion) {
    if (s.auto_state === 'active') {
      setState(s.id, 'stopped', 'Лид переведён с «Обсуждения вариантов» на другую стадию — автоматизация по этой подборке остановлена');
      emitSelectionChange(s, 'automation');
      return 'stopped';
    }
    db.prepare(`UPDATE selections SET auto_checked_at = datetime('now') WHERE id = ?`).run(s.id);
    return 'waiting';
  }
  if (s.auto_state === 'waiting') setState(s.id, 'active', null);
  if (!evaluate) return 'active';

  const decision = decide(items);
  if (!decision) return 'active';
  const target = decision === 'viewing' ? rules.viewing : rules.rejected;
  if (!target) return 'active';

  await callAsApp(s.member_id, 'crm.lead.update', { id: s.entity_id, fields: { STATUS_ID: target } });
  let stageName = target;
  try { stageName = (await getLeadStages(s.member_id)).find((x) => x.id === target)?.name || target; } catch { /* имя не критично */ }

  const title = bb(s.title || `Подборка №${s.id}`);
  const wanted = items.filter((i) => i.wantViewing).map((i) => i.object);
  let todoNote = '';
  if (decision === 'viewing') {
    const responsible = Number(lead.ASSIGNED_BY_ID) || Number(s.created_by_id) || null;
    const list = wanted.map((o) => `• ${o.title}${o.address ? ', ' + o.address : ''} — ${o.url}`).join('\n');
    try {
      await callAsApp(s.member_id, 'crm.activity.todo.add', {
        ownerTypeId: 1, // лид
        ownerId: s.entity_id,
        title: 'Согласовать просмотр',
        description: `Клиент хочет посмотреть вживую (${wanted.length}) по подборке «${title}»:\n${list}`,
        deadline: todoDeadline().toISOString(),
        ...(responsible ? { responsibleId: responsible } : {}),
      });
    } catch (e) {
      console.warn('[automation] дело не создано:', e.message);
      todoNote = '\n[I]Не удалось создать дело «Согласовать просмотр» — создайте его вручную.[/I]';
    }
  }

  const reason = decision === 'viewing'
    ? `клиент хочет посмотреть вживую: ${bb(wanted.map((o) => o.title).join('; '))}`
    : 'клиенту не подошёл ни один объект подборки';
  try {
    await callAsApp(s.member_id, 'crm.timeline.comment.add', {
      fields: {
        ENTITY_ID: s.entity_id, ENTITY_TYPE: 'lead',
        COMMENT: `[B]Лид переведён на стадию «${stageName}»[/B] по подборке «${title}»: ${reason}.${todoNote}`,
        ...(s.created_by_id ? { AUTHOR_ID: s.created_by_id } : {}),
      },
    });
  } catch (e) { console.warn('[automation] комментарий:', e.message); }

  setState(s.id, 'done', `Лид переведён на «${stageName}»: ${decision === 'viewing' ? 'клиент хочет на просмотр' : 'ничего не подошло'}`);
  console.log(`[automation] лид ${s.entity_id}: ${decision} → ${target}`);
  emitSelectionChange(s, 'automation');
  return decision;
}
