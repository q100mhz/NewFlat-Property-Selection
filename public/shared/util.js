/* Общие утилиты интерфейса */
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const price = (p) => (p ? Math.round(p).toLocaleString('ru-RU') + ' ₽' : 'Цена по запросу');

  const roomsLabel = (r, cat) => {
    if (r === 0) return 'Студия';
    if (r == null) return '';
    return r + '-комн.';
  };

  // дата из SQLite (UTC "YYYY-MM-DD HH:MM:SS") → локальная
  const parseDb = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z') : null);
  const dateTime = (s) => {
    const d = parseDb(s);
    if (!d) return '';
    return d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };
  const dateOnly = (s) => {
    const d = parseDb(s);
    return d ? d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  };

  const shortSpecs = (o) => {
    const parts = [];
    const r = roomsLabel(o.rooms);
    if (r) parts.push(r);
    if (o.area_total) parts.push(String(o.area_total).replace('.', ',') + ' м²');
    if (o.floor) parts.push(o.floors ? `${o.floor}/${o.floors} эт.` : `${o.floor} эт.`);
    return parts.join(' · ');
  };

  let toastTimer;
  const toast = (msg) => {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-on'), 2600);
  };

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
      return ok;
    }
  };

  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  const plural = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  };

  window.U = { esc, price, roomsLabel, dateTime, dateOnly, shortSpecs, toast, copyText, debounce, plural };
})();
