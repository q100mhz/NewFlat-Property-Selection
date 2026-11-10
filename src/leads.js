/**
 * Поиск лидов для создания подборки вне карточки (мобильное приложение Битрикс24).
 * Права как на дашборде: сотрудник — свои лиды, руководитель — лиды своего подразделения,
 * администраторы и «полный доступ» — все. Запросы идут от имени приложения с фильтром по ответственным.
 */
import { callAsApp } from './bitrix.js';
import { resolveScope } from './access.js';
import { getLeadStages } from './automation.js';
import { config } from './config.js';

// режим разработки без Битрикс24: демо-лиды
const DEV_LEADS = [
  { ID: '7', TITLE: 'Анна, 2-к до 8 млн', NAME: 'Анна', LAST_NAME: 'Смирнова', PHONE: [{ VALUE: '+7 912 345-67-89' }], STATUS_ID: 'DEV_3', ASSIGNED_BY_ID: '1', DATE_MODIFY: '2026-11-10T12:00:00+05:00' },
  { ID: '8', TITLE: 'Игорь, студия у Гагаринского парка', NAME: 'Игорь', LAST_NAME: 'Петров', PHONE: [{ VALUE: '89221234567' }], STATUS_ID: 'DEV_2', ASSIGNED_BY_ID: '1', DATE_MODIFY: '2026-11-10T10:00:00+05:00' },
  { ID: '9', TITLE: 'Семья Ивановых, дом', NAME: 'Ольга', LAST_NAME: 'Иванова', PHONE: [], STATUS_ID: 'DEV_4', ASSIGNED_BY_ID: '2', DATE_MODIFY: '2026-11-09T18:00:00+05:00' },
];
const isDev = (session) => config.devMode && session.memberId === 'dev';

const SELECT = ['ID', 'TITLE', 'NAME', 'LAST_NAME', 'PHONE', 'STATUS_ID', 'ASSIGNED_BY_ID', 'DATE_MODIFY'];

/** Варианты записи номера для поиска дублей: +7…, 8…, 7… */
export function phoneVariants(q) {
  let d = String(q).replace(/\D/g, '');
  if (d.length < 5) return [];
  if (d.length === 10) d = '7' + d;
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  const out = new Set([d, '+' + d]);
  if (d.length === 11 && d[0] === '7') { out.add('8' + d.slice(1)); out.add(d.slice(1)); }
  return [...out];
}

/** Телефон для WhatsApp/СМС: 7XXXXXXXXXX или null. */
export function waPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 10) d = '7' + d;
  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  return d.length >= 11 && d.length <= 15 ? d : null;
}

export const firstPhone = (entity) => waPhone([].concat(entity?.PHONE || []).find((p) => p?.VALUE)?.VALUE);

function scopeFilter(scope) {
  return scope.all ? {} : { ASSIGNED_BY_ID: scope.userIds };
}

export function canSeeLead(scope, lead) {
  return !!lead && (scope.all || scope.userIds.includes(Number(lead.ASSIGNED_BY_ID)));
}

async function list(memberId, filter, order = { DATE_MODIFY: 'DESC' }) {
  if (config.devMode && memberId === 'dev') {
    return DEV_LEADS.filter((l) => {
      if (filter.ID && ![].concat(filter.ID).map(Number).includes(Number(l.ID))) return false;
      if (filter.ASSIGNED_BY_ID && !filter.ASSIGNED_BY_ID.includes(Number(l.ASSIGNED_BY_ID))) return false;
      const like = Object.entries(filter).find(([k]) => k.startsWith('%'));
      return !like || String(l[like[0].slice(1)] || '').toLowerCase().includes(String(like[1]).toLowerCase());
    });
  }
  const r = await callAsApp(memberId, 'crm.lead.list', { filter, order, select: SELECT, start: 0 });
  return r.result || [];
}

export async function searchLeads(session, q = '') {
  const scope = await resolveScope(session);
  const base = scopeFilter(scope);
  const text = String(q || '').trim().slice(0, 100);
  let rows = [];

  if (!text) {
    try {
      rows = await list(session.memberId, { ...base, STATUS_SEMANTIC_ID: 'P' }); // только лиды в работе
    } catch {
      rows = await list(session.memberId, base);
    }
  } else {
    const tasks = [];
    const phones = phoneVariants(text);
    if (phones.length && isDev(session)) {
      tasks.push(Promise.resolve(DEV_LEADS.filter((l) => l.PHONE.some((p) => phones.includes(waPhone(p.VALUE)) || phones.includes(String(p.VALUE).replace(/\D/g, ''))))));
    } else if (phones.length) {
      tasks.push(callAsApp(session.memberId, 'crm.duplicate.findbycomm', { entity_type: 'LEAD', type: 'PHONE', values: phones })
        .then((r) => {
          const ids = [].concat(r.result?.LEAD || []).map(Number).filter(Boolean);
          return ids.length ? list(session.memberId, { ...base, ID: ids }) : [];
        }).catch(() => []));
    }
    if (/^\d{1,9}$/.test(text)) tasks.push(list(session.memberId, { ...base, ID: Number(text) }).catch(() => []));
    if (/[a-zа-яё]/i.test(text)) {
      for (const field of ['%TITLE', '%LAST_NAME', '%NAME']) tasks.push(list(session.memberId, { ...base, [field]: text }).catch(() => []));
    }
    const seen = new Set();
    for (const part of await Promise.all(tasks)) {
      for (const l of part) if (!seen.has(l.ID)) { seen.add(l.ID); rows.push(l); }
    }
  }

  let stages = [];
  try { stages = await getLeadStages(session.memberId); } catch { /* названия стадий не критичны */ }
  const stageName = (id) => stages.find((s) => s.id === id)?.name || '';
  return rows
    .filter((l) => canSeeLead(scope, l))
    .slice(0, 30)
    .map((l) => ({
      id: Number(l.ID),
      title: l.TITLE || [l.NAME, l.LAST_NAME].filter(Boolean).join(' ') || `Лид #${l.ID}`,
      name: [l.NAME, l.LAST_NAME].filter(Boolean).join(' ') || null,
      phone: firstPhone(l),
      stage: stageName(l.STATUS_ID),
      modified: l.DATE_MODIFY || null,
    }));
}

/** Лид для конструктора: только если он в зоне видимости сотрудника. */
export async function getLeadForSession(session, leadId) {
  const scope = await resolveScope(session);
  const lead = isDev(session) ? DEV_LEADS.find((l) => Number(l.ID) === Number(leadId))
    : (await callAsApp(session.memberId, 'crm.lead.get', { id: Number(leadId) })).result;
  return canSeeLead(scope, lead) ? lead : null;
}
