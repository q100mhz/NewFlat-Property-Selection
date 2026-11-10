/* Страница приложения: дашборд подборок с правами по оргструктуре */
(function () {
  const { esc, dateTime, toast, debounce, plural } = window.U;
  const BOOT = window.__BOOT__ || {};
  const $app = document.getElementById('app');
  const LS_KEY = 'propsel.dashboard.filters';

  const PERIODS = [['today', 'Сегодня'], ['yesterday', 'Вчера'], ['week', 'Неделя'], ['month', 'Месяц'], ['all', 'Всё время'], ['custom', 'Период']];
  const STATUSES = [['', 'Все статусы'], ['not_opened', 'Не открыта'], ['opened', 'Открыта, без оценок'], ['rated', 'Есть оценки'], ['viewing', 'Хочет на просмотр'], ['external', 'С объектами по ссылке']];

  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { /* хранилище недоступно */ }
  const state = {
    filters: { period: 'week', from: '', to: '', userId: '', status: '', q: '', archived: false, ...saved },
    data: null, page: 1, loading: false, error: null,
    access: null,
    stageRules: null,           // { rules, stages, error }
  };

  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: { Authorization: 'Bearer ' + BOOT.token, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error('Сессия истекла — обновите страницу');
    if (!res.ok) throw new Error(data.error || 'Ошибка ' + res.status);
    return data;
  }

  const hasBX = () => BOOT.inBitrix && window.BX24;
  const fit = debounce(() => { if (hasBX()) try { BX24.fitWindow(); } catch (e) { /* ignore */ } }, 80);

  function saveFilters() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state.filters)); } catch (e) { /* ignore */ }
  }

  let seq = 0;
  async function load(reset = true) {
    if (reset) state.page = 1;
    const f = state.filters;
    const q = new URLSearchParams({ period: f.period, page: state.page, limit: 50 });
    if (f.period === 'custom') { if (f.from) q.set('from', f.from); if (f.to) q.set('to', f.to); }
    if (f.userId) q.set('userId', f.userId);
    if (f.status) q.set('status', f.status);
    if (f.q) q.set('q', f.q);
    if (f.archived) q.set('archived', '1');
    const my = ++seq;
    state.loading = true;
    render();
    try {
      const data = await api('/dashboard?' + q);
      if (my !== seq) return;
      if (!reset && state.data) data.items = state.data.items.concat(data.items);
      state.data = data; state.error = null;
    } catch (e) {
      if (my === seq) state.error = e.message;
    } finally {
      if (my === seq) { state.loading = false; render(); }
    }
  }
  const loadDebounced = debounce(() => load(true), 350);

  // ---------- Рендер ----------
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—');

  function render() {
    const d = state.data;
    const f = state.filters;
    const active = document.activeElement;
    const focus = active && active.name ? { name: active.name, s: active.selectionStart, e: active.selectionEnd } : null;

    let html = `<div class="dash-head">
      <h1>Подборки объектов</h1>
      ${d ? `<span class="scope-chip">Доступ: <b>${esc(d.scope.label)}</b>${d.scope.role === 'head' && d.scope.people ? ` · ${d.scope.people} ${plural(d.scope.people, 'сотрудник', 'сотрудника', 'сотрудников')}` : ''}</span>` : ''}
    </div>`;
    if (d?.scope.warning) html += `<div class="alert">${esc(d.scope.warning)}</div>`;
    if (state.error) html += `<div class="alert">${esc(state.error)}</div>`;

    html += `<div class="panel dash-filters">
      <div class="dash-filters__row">
        <div class="seg">${PERIODS.map(([v, l]) => `<button data-period="${v}" class="${f.period === v ? 'is-on' : ''}">${l}</button>`).join('')}</div>
        ${f.period === 'custom' ? `<input class="input" type="date" name="from" value="${esc(f.from)}" data-f> <span class="muted">—</span> <input class="input" type="date" name="to" value="${esc(f.to)}" data-f>` : ''}
      </div>
      <div class="dash-filters__row">
        ${d && d.users.length > 1 ? `<select class="select" name="userId" data-f>
          <option value="">Все сотрудники</option>
          ${d.users.map((u) => `<option value="${u.id}" ${String(f.userId) === String(u.id) ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
        </select>` : ''}
        <select class="select" name="status" data-f>${STATUSES.map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input class="input" name="q" placeholder="Название, сотрудник или номер лида/сделки" value="${esc(f.q)}" data-f>
        <label class="check small"><input type="checkbox" name="archived" ${f.archived ? 'checked' : ''} data-f> С архивом</label>
      </div>
    </div>`;

    if (!d) {
      html += state.loading ? '<div class="loading"><span class="spinner"></span></div>' : '';
      $app.innerHTML = html; fit(); return;
    }

    const k = d.kpi;
    html += `<div class="kpis">
      <div class="kpi"><b>${k.selections}</b><span>${plural(k.selections, 'подборка', 'подборки', 'подборок')}</span><small>клиентов: ${k.clients}</small></div>
      <div class="kpi"><b>${k.objects}</b><span>объектов отправлено</span></div>
      <div class="kpi"><b>${pct(k.opened, k.selections)}</b><span>открыто клиентами</span><small>${k.opened} из ${k.selections}</small></div>
      <div class="kpi"><b>${pct(k.rated, k.selections)}</b><span>с оценками</span><small>${k.rated} из ${k.selections}</small></div>
      <div class="kpi"><b>👍 ${k.liked} · 👎 ${k.disliked}</b><span>оценки объектов</span></div>
      <div class="kpi"><b>🔑 ${k.viewing}</b><span>хотят на просмотр</span></div>
    </div>`;

    if (d.byUser.length > 1 && !f.userId) {
      html += `<div class="panel"><h3>По сотрудникам</h3><div class="table-wrap"><table class="dtable">
        <thead><tr><th>Сотрудник</th><th class="num">Подборок</th><th class="num">Клиентов</th><th class="num">Открыто</th><th class="num">С оценками</th><th class="num">👍</th><th class="num">👎</th><th class="num">🔑</th></tr></thead>
        <tbody>${d.byUser.map((u) => `<tr>
          <td><button class="link-btn" data-user="${u.userId}">${esc(u.name)}</button></td>
          <td class="num">${u.selections}</td><td class="num">${u.clients}</td>
          <td class="num">${u.opened} <span class="muted small">${pct(u.opened, u.selections)}</span></td>
          <td class="num">${u.rated} <span class="muted small">${pct(u.rated, u.selections)}</span></td>
          <td class="num">${u.liked}</td><td class="num">${u.disliked}</td><td class="num">${u.viewing}</td></tr>`).join('')}</tbody>
      </table></div></div>`;
    }

    html += `<div class="panel"><h3>Реестр подборок <span class="muted small">${d.total}</span></h3><div class="table-wrap"><table class="dtable">
      <thead><tr><th>Подборка</th><th>Карточка</th><th>Создал</th><th>Дата</th><th class="num">Объектов</th><th class="num">Просмотры</th><th>Оценки</th><th>Статус</th></tr></thead>
      <tbody>${d.items.length ? d.items.map(row).join('') : '<tr class="empty-row"><td colspan="8">За выбранный период подборок нет</td></tr>'}</tbody>
    </table></div>
    ${d.items.length < d.total ? `<div class="center"><button class="btn btn-light" data-act="more" ${state.loading ? 'disabled' : ''}>${state.loading ? 'Загрузка…' : 'Показать ещё'}</button></div>` : ''}
    </div>`;

    if (BOOT.user?.isAdmin) html += renderAdmin(d);

    $app.innerHTML = html;
    if (focus) {
      const el = $app.querySelector(`[name="${focus.name}"]`);
      if (el) { el.focus(); try { el.setSelectionRange(focus.s, focus.e); } catch (e) { /* select/date */ } }
    }
    fit();
  }

  function status(r) {
    const ago = r.lastActivityAt ? Date.now() - Date.parse(r.lastActivityAt.replace(' ', 'T') + 'Z') : Infinity;
    if (ago < 3 * 60e3) return '<span class="badge badge-live"><i></i>Оценивает сейчас</span>';
    if (r.viewing) return '<span class="badge badge-info">Хочет на просмотр</span>';
    if (r.liked + r.disliked) return `<span class="badge badge-like">Оценено ${r.liked + r.disliked} из ${r.total}</span>`;
    if (r.viewCount) return '<span class="badge badge-warn">Открыта, без оценок</span>';
    return '<span class="badge">Не открыта</span>';
  }

  function row(r) {
    const entity = `${r.entityType === 'lead' ? 'Лид' : 'Сделка'} #${r.entityId}`;
    return `<tr>
      <td class="wrap">${esc(r.title || 'Подборка №' + r.id)}<a class="muted-link" href="${esc(U.safeUrl(r.link))}" target="_blank" rel="noopener noreferrer" title="Открыть страницу клиента">↗</a>${r.archived ? ' <span class="badge">архив</span>' : ''}</td>
      <td>${r.entityUrl ? `<a href="${esc(U.safeUrl(r.entityUrl))}" target="_top">${entity}</a>` : entity}</td>
      <td>${esc(r.createdByName || '—')}</td>
      <td>${esc(dateTime(r.createdAt))}</td>
      <td class="num">${r.total}</td>
      <td class="num">${r.viewCount}</td>
      <td>${r.liked + r.disliked ? `👍 ${r.liked} · 👎 ${r.disliked}` : '<span class="muted">—</span>'}</td>
      <td>${status(r)}</td>
    </tr>`;
  }

  function renderStageRules() {
    const sr = state.stageRules;
    if (!sr) return '<div class="panel"><h3>Автоматизация стадий лида</h3><span class="spinner"></span></div>';
    const r = sr.rules || {};
    const opt = (name, value) => `<select class="select" name="${name}" data-rule>
      <option value="">— не выбрано —</option>
      ${sr.stages.map((s) => `<option value="${esc(s.id)}" ${s.id === value ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
    </select>`;
    return `<div class="panel">
      <h3>Автоматизация стадий лида</h3>
      ${sr.error ? `<div class="alert">${esc(sr.error)}</div>` : ''}
      <ul class="rules">
        <li>Срабатывает вместе со сводкой — через 5 минут после последнего изменения клиента, только если лид на стадии «обсуждения».</li>
        <li>Клиент отметил «хочу посмотреть» хотя бы один объект → стадия «просмотра» и дело «Согласовать просмотр» ответственному.</li>
        <li>Клиент оценил все объекты и все «не подходит» → возврат на стадию «подбора». В остальных случаях стадия не меняется.</li>
        <li>Если лид перевели с «обсуждения» на другую стадию, по этой подборке автоматизация останавливается. Новая подборка запускает сценарий заново.</li>
      </ul>
      <label class="check"><input type="checkbox" name="enabled" ${r.enabled ? 'checked' : ''} data-rule> Автоматизация включена</label>
      <div class="rule-grid">
        <label><span class="muted small">Стадия обсуждения (условие)</span>${opt('discussion', r.discussion)}</label>
        <label><span class="muted small">Клиент хочет на просмотр →</span>${opt('viewing', r.viewing)}</label>
        <label><span class="muted small">Ничего не подошло →</span>${opt('rejected', r.rejected)}</label>
      </div>
      ${r.source === 'detected' ? '<div class="muted small">Стадии найдены автоматически по названиям. Нажмите «Сохранить», чтобы закрепить настройку.</div>' : ''}
      <button class="btn btn-primary btn-sm" data-act="save-rules">Сохранить</button>
    </div>`;
  }

  function renderAdmin(d) {
    const c = d.catalog;
    const acc = state.access;
    return `<div class="settings-head"><h2>⚙️ Настройки</h2><span class="muted small">видны только администраторам портала и главному администратору приложения</span></div>`
      + renderStageRules() + `<div class="panel">
      <h3>Доступ к подборкам</h3>
      <ul class="rules">
        <li><b>Главный администратор приложения</b>, <b>администраторы портала</b> и <b>руководитель головного подразделения</b> видят все подборки; настройки доступны главному администратору и администраторам портала.</li>
        <li><b>Руководитель подразделения</b> видит свои подборки и подборки сотрудников своего и вложенных подразделений (по структуре компании Битрикс24).</li>
        <li><b>Сотрудник</b> видит только свои подборки.</li>
        <li>Во вкладке «Подборка» в карточке лида или сделки подборки видны всем, у кого есть доступ к этой карточке.</li>
      </ul>
      <div class="small"><b>Полный доступ</b> дополнительно (например, собственнику или РОПу):</div>
      <div class="access-list">${acc ? (acc.length ? acc.map((u) => `<span class="access-user">${esc(u.name)} <button data-remove-access="${u.id}" title="Убрать">✕</button></span>`).join('') : '<span class="muted small">никого</span>') : '<span class="spinner"></span>'}</div>
      <button class="btn btn-light btn-sm" data-act="add-access">+ Выдать полный доступ</button>
    </div>
    <details class="panel">
      <summary>Каталог newflat72.ru — ${c.total.toLocaleString('ru-RU')} объектов</summary>
      <div class="muted small">${c.lastCrawlAt ? 'Последнее обновление: ' + esc(new Date(c.lastCrawlAt).toLocaleString('ru-RU')) : 'Каталог ещё не загружен'}${c.crawl?.running ? ' · идёт обновление…' : ''}</div>
      <div class="kpis kpis--small" style="margin-top:10px">${(BOOT.sections || []).map((s) => `<div class="kpi"><b>${(c.byCategory[s.category] || 0).toLocaleString('ru-RU')}</b><span>${esc(s.label)}</span></div>`).join('')}</div>
      <button class="btn btn-blue btn-sm" data-act="recrawl">Обновить каталог сейчас</button>
    </details>`;
  }

  // ---------- Автоматизация стадий ----------
  async function loadStageRules() {
    if (!BOOT.user?.isAdmin) return;
    try { state.stageRules = await api('/settings/stage-rules'); } catch (e) { state.stageRules = { rules: null, stages: [], error: e.message }; }
    render();
  }

  async function saveStageRules() {
    const get = (n) => $app.querySelector(`[data-rule][name="${n}"]`);
    const body = { enabled: get('enabled').checked, discussion: get('discussion').value, viewing: get('viewing').value, rejected: get('rejected').value };
    if (body.enabled && (!body.discussion || !body.viewing || !body.rejected)) { toast('Выберите все три стадии'); return; }
    try {
      const { rules } = await api('/settings/stage-rules', { method: 'POST', body });
      state.stageRules = { ...state.stageRules, rules: { ...rules, source: 'saved' } };
      render(); toast(rules.enabled ? 'Автоматизация включена' : 'Автоматизация выключена');
    } catch (e) { toast(e.message); }
  }

  // ---------- Доступ ----------
  async function loadAccess() {
    if (!BOOT.user?.isAdmin) return;
    try { state.access = (await api('/settings/full-access')).users; } catch (e) { state.access = []; toast(e.message); }
    render();
  }

  async function saveAccess(list) {
    try {
      state.access = (await api('/settings/full-access', { method: 'POST', body: { users: list } })).users;
      render(); load(true);
      toast('Доступ обновлён');
    } catch (e) { toast(e.message); }
  }

  function pickUsers() {
    if (hasBX() && BX24.selectUsers) {
      BX24.selectUsers((users) => {
        if (!users?.length) return;
        const list = (state.access || []).concat(users.map((u) => ({ id: Number(u.id), name: u.name })));
        saveAccess(list);
      });
      return;
    }
    const id = Number(prompt('ID пользователя Битрикс24'));
    if (id) saveAccess((state.access || []).concat({ id, name: 'Пользователь ' + id }));
  }

  // ---------- События ----------
  $app.addEventListener('click', async (e) => {
    const p = e.target.closest('[data-period]');
    if (p) { state.filters.period = p.dataset.period; saveFilters(); load(true); return; }
    const u = e.target.closest('[data-user]');
    if (u) { state.filters.userId = u.dataset.user; saveFilters(); load(true); return; }
    const rm = e.target.closest('[data-remove-access]');
    if (rm) { saveAccess((state.access || []).filter((x) => String(x.id) !== rm.dataset.removeAccess)); return; }
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'more') { state.page += 1; load(false); }
    if (a.dataset.act === 'add-access') pickUsers();
    if (a.dataset.act === 'save-rules') saveStageRules();
    if (a.dataset.act === 'recrawl') {
      a.disabled = true;
      try { await api('/catalog/recrawl', { method: 'POST' }); toast('Обновление каталога запущено, это займёт несколько минут'); } catch (err) { toast(err.message); }
    }
  });

  $app.addEventListener('input', (e) => {
    const t = e.target;
    if (!t.hasAttribute('data-f') || t.type === 'checkbox' || t.tagName === 'SELECT' || t.type === 'date') return;
    state.filters[t.name] = t.value; saveFilters(); loadDebounced();
  });
  $app.addEventListener('change', (e) => {
    const t = e.target;
    if (t.hasAttribute('data-rule')) { // черновик настройки сохраняется кнопкой, но переживает перерисовку
      if (state.stageRules) state.stageRules.rules = { ...(state.stageRules.rules || {}), [t.name]: t.type === 'checkbox' ? t.checked : t.value };
      return;
    }
    if (!t.hasAttribute('data-f')) return;
    if (t.type === 'checkbox') state.filters[t.name] = t.checked;
    else if (t.tagName === 'SELECT' || t.type === 'date') state.filters[t.name] = t.value;
    else return;
    saveFilters(); load(true);
  });

  // статусы «оценивает сейчас» устаревают — обновляем раз в минуту
  setInterval(() => { if (!document.hidden && document.activeElement?.tagName !== 'INPUT') load(true); }, 60e3);

  const start = () => { load(true); loadAccess(); loadStageRules(); };
  if (hasBX()) BX24.init(start); else start();
})();
