// Работа с датами в часовом поясе агентства

/** Смещение часового пояса (минуты) для момента времени. */
export function tzOffsetMin(date, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - date.getTime()) / 60e3);
}

/** Начало суток (полночь по часовому поясу агентства) для даты YYYY-MM-DD, в UTC. */
export function localMidnightUtc(ymd, timeZone) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d));
  return new Date(guess.getTime() - tzOffsetMin(guess, timeZone) * 60e3);
}

export function localYmd(date, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}


/** Локальные часы (0–23) в часовом поясе. */
export function localHour(date, timeZone) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit' }).format(date));
}
