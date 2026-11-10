/* Вкладка «Подборка» в карточке лида/сделки Битрикс24 */
(function () {
  const { esc, price, dateTime, shortSpecs, toast, copyText, debounce, plural } = window.U;
  const BOOT = window.__BOOT__ || {};
  const $app = document.getElementById('app');

  const state = {
    view: 'history',          // history | builder
    meta: null,
    selections: [],
    sentObjects: {},
    showArchived: false,
    expanded: new Set(),
    // конструктор
    filters: { category: 'flat', rooms: [], priceMin: '', priceMax: '', areaMin: '', areaMax: '', q: '', sort: 'new', hideSent: false },
    results: [], total: 0, page: 1, loading: false,
    chosen: [],               // [{id, title, address, price, thumb, rooms, area_total, floor, floors, note}]
    title: '', message: '',
    created: null,
    detail: null,             // объект в модальном окне
    editor: null,             // правка объекта, добавленного по ссылке: { obj, warning, saving }
    flash: new Set(),         // подборки, обновлённые клиентом только что
  };

  // ---------- API ----------
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

  // ---------- Битрикс24 ----------
  const hasBX = () => BOOT.inBitrix && window.BX24;
  function fit() { if (hasBX()) try { BX24.fitWindow(); } catch (e) { /* ignore */ } }
  const fitSoon = debounce(fit, 80);
  if (window.ResizeObserver) new ResizeObserver(fitSoon).observe(document.body);

  function addTimelineComment(sel) {
    if (!hasBX()) return Promise.resolve(false);
    const list = sel.items.map((i, n) => `${n + 1}. [URL=${U.safeUrl(i.object.url)}]${U.bb(i.object.title)}[/URL] — ${price(i.object.price)}`).join('\n');
    const comment = `[B]Отправлена подборка «${U.bb(sel.title || 'Подборка №' + sel.id)}»[/B] (${sel.items.length} ${plural(sel.items.length, 'объект', 'объекта', 'объектов')})\n` +
      `Ссылка для клиента: [URL=${sel.link}]${sel.link}[/URL]\n\n${list}`;
    return new Promise((resolve) => {
      BX24.callMethod('crm.timeline.comment.add', {
        fields: { ENTITY_ID: BOOT.entityId, ENTITY_TYPE: BOOT.entityType, COMMENT: comment },
      }, (r) => resolve(!r.error()));
    });
  }

  // ---------- Загрузка ----------
  async function loadHistory() {
    const data = await api('/selections');
    state.selections = data.selections;
    state.sentObjects = data.sentObjects;
  }

  // ---------- Живые обновления ----------
  // Сервер присылает событие, когда клиент открыл подборку или изменил оценку/комментарий.
  let pendingIds = new Set();
  const refreshFromStream = debounce(async () => {
    const ids = [...pendingIds]; pendingIds = new Set();
    try {
      await loadHistory();
      ids.forEach((id) => state.flash.add(id));
      if (state.view === 'history' && !state.detail && !state.editor) renderKeepFocus();
      setTimeout(() => {
        ids.forEach((id) => state.flash.delete(id));
        document.querySelectorAll('.sel.is-flash').forEach((el) => el.classList.remove('is-flash'));
      }, 2500);
    } catch (e) { /* следующая попытка при следующем событии */ }
  }, 400);

  async function startStream(attempt = 0) {
    try {
      const res = await fetch('/api/selections/stream', { headers: { Authorization: 'Bearer ' + BOOT.token } });
      if (res.status === 401) return; // сессия истекла — вкладку нужно открыть заново
      if (!res.ok || !res.body) throw new Error('stream ' + res.status);
      attempt = 0;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!chunk.includes('event: change') || !data) continue;
          try { pendingIds.add(JSON.parse(data.slice(6)).selectionId); } catch (e) { /* ignore */ }
          refreshFromStream();
        }
      }
    } catch (e) { /* переподключимся */ }
    setTimeout(() => startStream(attempt + 1), Math.min(30000, 2000 * 2 ** attempt));
  }

  // статус «оценивает сейчас» устаревает сам — обновляем историю раз в минуту
  setInterval(() => { if (state.view === 'history' && !state.detail && !state.created && !state.editor) renderKeepFocus(); }, 60e3);

  async function init() {
    try {
      const [meta] = await Promise.all([api('/catalog/meta'), loadHistory()]);
      state.meta = meta;
      if (!state.selections.length) state.view = 'history';
      render();
      startStream();
    } catch (e) {
      $app.innerHTML = `<div class="empty"><h3>Не удалось загрузить</h3><p class="muted">${esc(e.message)}</p></div>`;
    }
  }

  // ---------- Рендер ----------
  function render() {
    $app.innerHTML = state.view === 'builder' ? renderBuilder() : renderHistory();
    if (state.created) $app.insertAdjacentHTML('beforeend', renderCreatedModal());
    if (state.detail) $app.insertAdjacentHTML('beforeend', renderDetailModal());
    if (state.editor) $app.insertAdjacentHTML('beforeend', renderEditor());
    fitSoon();
  }

  function header(title, right) {
    // открыто с дашборда (мобильный Битрикс24) — возврат к списку подборок
    const back = BOOT.fromDashboard ? '<button class="btn btn-light btn-sm" data-act="back-dashboard">← Назад</button>' : '';
    return `<div class="topbar"><div class="topbar__title">${back}${title}</div><div class="topbar__actions">${right}</div></div>`;
  }

  /** Кнопки отправки ссылки клиенту: WhatsApp и СМС — сразу на номер клиента из CRM, если он есть. */
  function shareButtons(sel) {
    const text = `${sel.message ? sel.message.trim() + '\n\n' : 'Здравствуйте! Подобрали для вас варианты — посмотрите и отметьте, что нравится:\n'}${sel.link}`;
    const enc = encodeURIComponent(text);
    const phone = BOOT.clientPhone;
    return `<div class="share">
      <a class="btn btn-sm share__wa" href="${phone ? `https://wa.me/${phone}?text=${enc}` : `https://wa.me/?text=${enc}`}" target="_blank" rel="noopener noreferrer">WhatsApp${phone ? ' клиенту' : ''}</a>
      <a class="btn btn-sm share__tg" href="https://t.me/share/url?url=${encodeURIComponent(sel.link)}&text=${encodeURIComponent(sel.message || 'Подборка объектов для вас')}" target="_blank" rel="noopener noreferrer">Telegram</a>
      <a class="btn btn-sm btn-light" href="sms:${phone ? '+' + phone : ''}?&body=${enc}">СМС</a>
      ${navigator.share ? `<button class="btn btn-sm btn-light" data-act="native-share" data-id="${sel.id}">Ещё…</button>` : ''}
    </div>`;
  }

  function renderHistory() {
    const visible = state.selections.filter((s) => state.showArchived || !s.archived);
    const archivedCount = state.selections.filter((s) => s.archived).length;
    let body;
    if (!state.selections.length) {
      body = `<div class="empty">
        <div class="empty__icon">🏠</div>
        <h3>Подборок пока нет</h3>
        <p class="muted">Соберите объекты с сайта, отправьте клиенту ссылку — его оценки появятся здесь и в таймлайне карточки.</p>
        <button class="btn btn-primary" data-act="new">+ Создать подборку</button>
      </div>`;
    } else {
      body = `<div class="history">${visible.map(renderSelectionCard).join('')}</div>`;
      if (archivedCount) {
        body += `<div class="center"><button class="btn btn-light btn-sm" data-act="toggle-archived">${state.showArchived ? 'Скрыть архив' : `Показать архив (${archivedCount})`}</button></div>`;
      }
    }
    return header(BOOT.fromDashboard && BOOT.entityTitle ? `Подборки: ${esc(BOOT.entityTitle)}` : `Подборки ${BOOT.entityType === 'deal' ? 'по сделке' : 'по лиду'}`,
      state.selections.length ? '<button class="btn btn-primary" data-act="new">+ Новая подборка</button>' : '') + body;
  }

  function statusBadges(s) {
    const b = [];
    const rated = s.stats.liked + s.stats.disliked;
    const activeAgo = s.lastActivityAt ? Date.now() - Date.parse(s.lastActivityAt.replace(' ', 'T') + 'Z') : Infinity;
    if (activeAgo < 3 * 60e3) b.push('<span class="badge badge-live"><i></i>Клиент оценивает сейчас</span>');
    if (rated) b.push(`<span class="badge badge-like">Оценено ${rated} из ${s.stats.total}${s.lastActivityAt ? ' · ' + esc(dateTime(s.lastActivityAt)) : ''}</span>`);
    else if (s.viewCount) b.push(`<span class="badge badge-info">Просмотрена${s.viewCount > 1 ? ` ${s.viewCount} ${plural(s.viewCount, 'раз', 'раза', 'раз')}` : ''}, без оценок</span>`);
    else b.push('<span class="badge">Не открыта</span>');
    if (s.submittedAt && !s.digestPending) b.push(`<span class="badge" title="Сводка с оценками добавлена в таймлайн карточки">Сводка в таймлайне ${esc(dateTime(s.submittedAt))}</span>`);
    const AUTO = {
      waiting: ['badge', 'Авто: ждёт стадию «Обсуждение вариантов»'],
      active: ['badge badge-info', 'Авто: стадия изменится по ответу клиента'],
      done: ['badge badge-like', 'Авто: ' + (s.autoNote || 'стадия изменена')],
      stopped: ['badge badge-warn', 'Авто: остановлена — лид перемещён вручную'],
    }[s.autoState];
    if (AUTO) b.push(`<span class="${AUTO[0]}" title="${esc(s.autoNote || '')}">${esc(AUTO[1])}</span>`);
    if (s.archived) b.push('<span class="badge">В архиве</span>');
    if (s.entityType !== BOOT.entityType) b.push('<span class="badge badge-warn">Из лида</span>');
    return b.join(' ');
  }

  function reactionBadge(i) {
    if (i.reaction === 'like') return `<span class="badge badge-like">👍 Нравится${i.wantViewing ? ' · на просмотр' : ''}</span>`;
    if (i.reaction === 'dislike') return '<span class="badge badge-dislike">👎 Не подходит</span>';
    return '<span class="badge">Без оценки</span>';
  }

  function renderSelectionCard(s) {
    const open = state.expanded.has(s.id);
    const st = s.stats;
    const unrated = st.total - st.liked - st.disliked;
    return `<div class="card sel ${s.archived ? 'is-archived' : ''} ${state.flash.has(s.id) ? 'is-flash' : ''}">
      <div class="sel__head" data-act="expand" data-id="${s.id}">
        <div class="sel__main">
          <div class="sel__title">${esc(s.title || 'Подборка №' + s.id)}</div>
          <div class="sel__meta muted small">${esc(dateTime(s.createdAt))}${s.createdByName ? ' · ' + esc(s.createdByName) : ''} · ${st.total} ${plural(st.total, 'объект', 'объекта', 'объектов')}</div>
          <div class="sel__badges">${statusBadges(s)}</div>
        </div>
        <div class="sel__stats">
          <span class="stat stat-like" title="Нравится">👍 ${st.liked}</span>
          <span class="stat stat-dislike" title="Не подходит">👎 ${st.disliked}</span>
          ${unrated ? `<span class="stat" title="Без оценки">○ ${unrated}</span>` : ''}
          ${st.viewing ? `<span class="stat stat-view" title="Хочет на просмотр">🔑 ${st.viewing}</span>` : ''}
          <span class="chev ${open ? 'is-open' : ''}">›</span>
        </div>
      </div>
      <div class="sel__link">
        <input class="input input-link" readonly value="${esc(s.link)}">
        <button class="btn btn-blue btn-sm" data-act="copy" data-link="${esc(s.link)}">Копировать</button>
        <a class="btn btn-light btn-sm" href="${esc(U.safeUrl(s.link))}" target="_blank" rel="noopener noreferrer">Открыть</a>
      </div>
      ${s.archived ? '' : `<div class="sel__share">${shareButtons(s)}</div>`}
      ${open ? `<div class="sel__items">
        ${s.message ? `<div class="sel__message muted small">Сообщение клиенту: «${esc(s.message)}»</div>` : ''}
        ${s.items.map((i) => `<div class="sel-item">
          <img class="sel-item__img" src="${esc(i.object.thumb || '')}" alt="" loading="lazy" data-broken="hide">
          <div class="sel-item__body">
            <a class="sel-item__title" href="${esc(U.safeUrl(i.object.url))}" target="_blank" rel="noopener noreferrer">${esc(i.object.title)}</a>
            <div class="muted small">${esc(i.object.address || '')}</div>
            ${i.object.source === 'link' ? `<div class="link-tools">${linkTools({ ...i.object, id: i.objectId })}</div>` : ''}
            <div class="small"><b>${price(i.object.price)}</b>${i.currentPrice && i.currentPrice !== i.object.price ? ` <span class="badge badge-warn">сейчас ${price(i.currentPrice)}</span>` : ''}${i.removed ? ' <span class="badge badge-dislike">снят с сайта</span>' : ''}</div>
            ${i.reasons?.length ? `<div class="small reasons">Причины: ${i.reasons.map(esc).join(', ')}</div>` : ''}
            ${i.clientComment ? `<div class="small client-comment">💬 ${esc(i.clientComment)}</div>` : ''}
          </div>
          <div class="sel-item__reaction">${reactionBadge(i)}</div>
        </div>`).join('')}
        <div class="sel__actions">
          <button class="btn btn-primary btn-sm" data-act="based-on" data-id="${s.id}">Новая подборка на основе</button>
          <button class="btn btn-light btn-sm" data-act="archive" data-id="${s.id}" data-archived="${s.archived ? 0 : 1}" title="${s.archived ? '' : 'Ссылка перестанет открываться у клиента; подборку можно вернуть'}">${s.archived ? 'Вернуть из архива' : 'В архив'}</button>
          ${s.archived ? `<button class="btn btn-light btn-sm btn-danger-text" data-act="delete" data-id="${s.id}">Удалить навсегда</button>` : ''}
        </div>
      </div>` : ''}
    </div>`;
  }

  /** Метка «По ссылке: …» и кнопки для объектов не с сайта агентства (видит только сотрудник). */
  function linkTools(o, { edit = true } = {}) {
    if (o.source !== 'link') return '';
    return `<span class="badge badge-warn" title="Добавлен по ссылке — клиент не видит источник">${esc(o.sourceName || 'по ссылке')}</span>
      ${o.url ? `<a class="small" href="${esc(U.safeUrl(o.url))}" target="_blank" rel="noopener noreferrer" title="Открыть оригинал (видит только сотрудник)">Оригинал ↗</a>` : ''}
      ${edit ? `<button class="btn btn-sm btn-light" data-act="edit-obj" data-id="${o.id}" title="Исправить данные объекта">✎ Изменить</button>` : ''}`;
  }

  // ----- Конструктор -----
  function renderBuilder() {
    const f = state.filters;
    const sections = state.meta.sections;
    const roomOpts = [[0, 'Студия'], [1, '1'], [2, '2'], [3, '3'], [4, '4+']];
    const stats = state.meta.stats;
    return header('Новая подборка', '<button class="btn btn-light" data-act="cancel">Отмена</button>') + `
    <div class="builder">
      <div class="builder__catalog">
        <div class="card pad">
          <form class="url-add" data-form="url">
            <input class="input" name="url" placeholder="Ссылка на объект: ${esc(new URL(state.meta.siteUrl).host)}, сайт застройщика, ЦИАН, Авито…" autocomplete="off">
            <button class="btn btn-blue" type="submit">Добавить</button>
          </form>
        </div>
        <div class="card pad filters">
          <div class="filters__row">
            <select class="select" name="category" data-filter>
              <option value="">Все категории</option>
              ${sections.map((s) => `<option value="${s.category}" ${f.category === s.category ? 'selected' : ''}>${esc(s.label)}${stats.byCategory[s.category] ? ` (${stats.byCategory[s.category]})` : ''}</option>`).join('')}
            </select>
            <input class="input" name="q" placeholder="Улица, ЖК, район, ID…" value="${esc(f.q)}" data-filter>
          </div>
          <div class="filters__row">
            <div class="chips">${roomOpts.map(([v, l]) => `<span class="chip ${f.rooms.includes(v) ? 'is-on' : ''}" data-act="room" data-v="${v}">${l}</span>`).join('')}</div>
          </div>
          <div class="filters__row filters__ranges">
            <label class="range"><span class="muted small">Цена, млн ₽</span>
              <span class="range__inputs"><input class="input" name="priceMin" inputmode="decimal" placeholder="от" value="${esc(f.priceMin)}" data-filter><input class="input" name="priceMax" inputmode="decimal" placeholder="до" value="${esc(f.priceMax)}" data-filter></span></label>
            <label class="range"><span class="muted small">Площадь, м²</span>
              <span class="range__inputs"><input class="input" name="areaMin" inputmode="decimal" placeholder="от" value="${esc(f.areaMin)}" data-filter><input class="input" name="areaMax" inputmode="decimal" placeholder="до" value="${esc(f.areaMax)}" data-filter></span></label>
            <label class="range"><span class="muted small">Сортировка</span>
              <select class="select" name="sort" data-filter>
                ${[['new', 'Сначала новые'], ['price_asc', 'Дешевле'], ['price_desc', 'Дороже'], ['area_asc', 'Меньше площадь'], ['area_desc', 'Больше площадь']].map(([v, l]) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
              </select></label>
          </div>
          <label class="check small"><input type="checkbox" name="hideSent" ${f.hideSent ? 'checked' : ''} data-filter> Скрыть уже отправленные этому клиенту</label>
        </div>
        <div class="results-head muted small">${state.loading && !state.results.length ? 'Загрузка…' : `Найдено: ${state.total.toLocaleString('ru-RU')}`}${stats.lastCrawlAt ? ` · каталог обновлён ${esc(new Date(stats.lastCrawlAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}` : ''}${stats.crawl?.running ? ' · идёт обновление…' : ''}</div>
        <div class="results">${visibleResults().map(renderResultCard).join('') || (state.loading ? '' : '<div class="empty small muted">Ничего не найдено. Измените фильтры или добавьте объект по ссылке.</div>')}</div>
        ${state.results.length < state.total ? `<div class="center"><button class="btn btn-light" data-act="more" ${state.loading ? 'disabled' : ''}>${state.loading ? 'Загрузка…' : 'Показать ещё'}</button></div>` : ''}
      </div>
      <div class="builder__chosen">
        <div class="card pad sticky">
          <div class="chosen__title">В подборке: ${state.chosen.length}</div>
          <input class="input" name="title" placeholder="Название подборки" value="${esc(state.title)}" data-field="title">
          <textarea class="textarea" name="message" rows="3" placeholder="Сообщение клиенту, например: «Здравствуйте! Подобрал варианты по вашему запросу — отметьте, что нравится»" data-field="message">${esc(state.message)}</textarea>
          <div class="chosen__list">
            ${state.chosen.length ? state.chosen.map((o, i) => `<div class="chosen-item">
              <img src="${esc(o.thumb || '')}" alt="" data-broken="hide">
              <div class="chosen-item__body">
                <div class="chosen-item__title">${esc(o.title)}</div>
                <div class="muted small">${price(o.price)}</div>
                ${o.source === 'link' ? `<div class="link-tools">${linkTools(o)}</div>` : ''}
                <input class="input input-note" placeholder="Комментарий для клиента" value="${esc(o.note || '')}" data-note="${o.id}">
              </div>
              <div class="chosen-item__tools">
                <button class="btn btn-icon btn-light" data-act="up" data-i="${i}" title="Выше" ${i === 0 ? 'disabled' : ''}>↑</button>
                <button class="btn btn-icon btn-light" data-act="down" data-i="${i}" title="Ниже" ${i === state.chosen.length - 1 ? 'disabled' : ''}>↓</button>
                <button class="btn btn-icon btn-light btn-danger-text" data-act="remove" data-id="${o.id}" title="Убрать">✕</button>
              </div>
            </div>`).join('') : '<div class="muted small chosen__empty">Добавьте объекты из каталога слева или по ссылке</div>'}
          </div>
          <button class="btn btn-primary btn-block" data-act="create" ${state.chosen.length ? '' : 'disabled'}>Создать и получить ссылку</button>
        </div>
      </div>
    </div>`;
  }

  function visibleResults() {
    return state.filters.hideSent ? state.results.filter((o) => !state.sentObjects[o.id]) : state.results;
  }

  function renderResultCard(o) {
    const added = state.chosen.some((c) => c.id === o.id);
    const sent = state.sentObjects[o.id];
    let sentBadge = '';
    if (sent) {
      const r = sent.reaction === 'like' ? '👍' : sent.reaction === 'dislike' ? '👎' : '';
      sentBadge = `<span class="badge ${sent.reaction === 'dislike' ? 'badge-dislike' : sent.reaction === 'like' ? 'badge-like' : 'badge-warn'}" title="${esc((sent.reasons || []).join(', '))}">Уже отправляли ${r}</span>`;
    }
    return `<div class="obj ${added ? 'is-added' : ''}">
      <div class="obj__img" data-act="detail" data-id="${o.id}" style="background-image:url('${esc(o.thumb || '')}')">
        ${o.categoryLabel ? `<span class="obj__cat">${esc(o.categoryLabel)}</span>` : ''}
      </div>
      <div class="obj__body">
        <div class="obj__price">${price(o.price)}</div>
        <div class="obj__title" data-act="detail" data-id="${o.id}">${esc(o.title)}</div>
        <div class="obj__addr muted small">${esc(o.address || '')}</div>
        <div class="obj__specs small">${esc(shortSpecs(o))}</div>
        ${o.source === 'link' ? `<div class="link-tools">${linkTools(o)}</div>` : ''}
        <div class="obj__foot">
          ${sentBadge}
          <button class="btn btn-sm ${added ? 'btn-light' : 'btn-primary'}" data-act="${added ? 'remove' : 'add'}" data-id="${o.id}">${added ? '✓ В подборке' : '+ Добавить'}</button>
        </div>
      </div>
    </div>`;
  }

  function renderCreatedModal() {
    const s = state.created;
    return `<div class="modal"><div class="modal__box">
      <div class="modal__icon">✓</div>
      <h3>Подборка создана</h3>
      <p class="muted">Отправьте ссылку клиенту. Оценки клиента появятся во вкладке и в таймлайне карточки.</p>
      ${shareButtons(s)}
      <div class="sel__link"><input class="input input-link" readonly value="${esc(s.link)}">
        <button class="btn btn-blue btn-sm" data-act="copy" data-link="${esc(s.link)}">Копировать</button></div>
      ${s.timeline === true ? '<p class="small muted">✓ Ссылка добавлена в таймлайн карточки</p>' : s.timeline === false && hasBX() ? '<p class="small warn">Не удалось добавить комментарий в таймлайн</p>' : ''}
      <div class="modal__actions"><button class="btn btn-primary" data-act="close-created">Готово</button></div>
    </div></div>`;
  }

  function renderDetailModal() {
    const o = state.detail;
    if (o.loading) return '<div class="modal" data-act="close-detail"><div class="modal__box center"><span class="spinner"></span></div></div>';
    const added = state.chosen.some((c) => c.id === o.id);
    const props = Object.entries(o.props || {});
    return `<div class="modal" data-act="close-detail"><div class="modal__box modal__box--wide" data-stop>
      <button class="modal__close" data-act="close-detail">✕</button>
      <h3>${esc(o.title)}</h3>
      <div class="muted">${esc(o.address || '')}</div>
      <div class="detail__price">${price(o.price)} ${o.price_per_m2 ? `<span class="muted small">${esc(o.price_per_m2)}</span>` : ''}</div>
      <div class="detail__photos">${(o.photos || []).map((p) => `<a href="${esc(U.safeUrl(p.big))}" target="_blank" rel="noopener noreferrer"><img src="${esc(p.small)}" alt="" loading="lazy"></a>`).join('')}</div>
      ${props.length ? `<dl class="props">${props.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
      ${o.description ? `<div class="detail__descr">${esc(o.description)}</div>` : ''}
      <div class="modal__actions">
        <a class="btn btn-light" href="${esc(U.safeUrl(o.url))}" target="_blank" rel="noopener noreferrer">На сайте</a>
        <button class="btn ${added ? 'btn-light' : 'btn-primary'}" data-act="${added ? 'remove' : 'add'}" data-id="${o.id}">${added ? '✓ В подборке' : '+ Добавить в подборку'}</button>
      </div>
    </div></div>`;
  }

  // ---------- Правка объекта, добавленного по ссылке ----------
  function renderEditor() {
    const { obj: o, warning, saving } = state.editor;
    if (!o) return '<div class="modal"><div class="modal__box center"><span class="spinner"></span></div></div>';
    const f = (name, label, value, attrs = '') => `<label class="ed-field"><span class="muted small">${label}</span><input class="input" name="${name}" value="${esc(value ?? '')}" data-ed ${attrs}></label>`;
    const photos = o.photos || [];
    return `<div class="modal"><div class="modal__box modal__box--wide" data-stop>
      <button class="modal__close" data-act="close-editor">✕</button>
      <h3>Объект по ссылке</h3>
      <div class="muted small">${esc(o.sourceName || '')} · <a href="${esc(U.safeUrl(o.url))}" target="_blank" rel="noopener noreferrer">Оригинал ↗</a> · клиент не увидит источник и эту ссылку. Правки сохранятся для всех подборок.</div>
      ${warning ? `<div class="alert">${esc(warning)}</div>` : ''}
      <div class="ed-grid">
        ${f('title', 'Заголовок', o.title, 'maxlength="200"')}
        ${f('complex', 'ЖК', o.complex, 'maxlength="100"')}
        ${f('address', 'Адрес', o.address, 'maxlength="300"')}
        ${f('price', 'Цена, ₽', o.price, 'inputmode="numeric"')}
        ${f('rooms', 'Комнат (0 — студия)', o.rooms, 'inputmode="numeric"')}
        ${f('area_total', 'Общая площадь, м²', o.area_total, 'inputmode="decimal"')}
        ${f('area_living', 'Жилая, м²', o.area_living, 'inputmode="decimal"')}
        ${f('area_kitchen', 'Кухня, м²', o.area_kitchen, 'inputmode="decimal"')}
        ${f('floor', 'Этаж', o.floor, 'inputmode="numeric"')}
        ${f('floors', 'Этажей в доме', o.floors, 'inputmode="numeric"')}
      </div>
      <label class="ed-field"><span class="muted small">Описание для клиента (контакты продавцов и агентств уже удалены автоматически — проверьте)</span>
        <textarea class="textarea" name="description" rows="6" data-ed>${esc(o.description || '')}</textarea></label>
      <div class="ed-photos-head"><b>Фото (${photos.length})</b>
        <label class="btn btn-light btn-sm">+ Загрузить фото<input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden data-upload></label></div>
      <div class="ed-photos">${photos.map((p, i) => `<div class="ed-photo">
        <img src="${esc(p.small)}" alt="" loading="lazy" data-broken="hide">
        <div class="ed-photo__tools">
          <button class="btn btn-icon btn-light" data-act="ph-left" data-i="${i}" ${i === 0 ? 'disabled' : ''} title="Раньше">←</button>
          <button class="btn btn-icon btn-light btn-danger-text" data-act="ph-del" data-i="${i}" title="Убрать фото">✕</button>
          <button class="btn btn-icon btn-light" data-act="ph-right" data-i="${i}" ${i === photos.length - 1 ? 'disabled' : ''} title="Позже">→</button>
        </div></div>`).join('') || '<div class="muted small">Фото нет — загрузите с компьютера или из галереи телефона.</div>'}</div>
      <div class="modal__actions">
        <button class="btn btn-light" data-act="close-editor">Отмена</button>
        <button class="btn btn-primary" data-act="save-editor" ${saving ? 'disabled' : ''}>${saving ? 'Сохраняем…' : 'Сохранить'}</button>
      </div>
    </div></div>`;
  }

  async function openEditor(id, warning) {
    state.editor = { obj: null, warning };
    render();
    try {
      state.editor = { obj: await api('/catalog/object/' + id), warning };
    } catch (e) { state.editor = null; toast(e.message); }
    render();
  }

  function collectEditor() {
    const o = state.editor.obj;
    $app.querySelectorAll('[data-ed]').forEach((el) => { o[el.name] = el.value; });
    return o;
  }

  /** Обновляет объект во всех местах интерфейса после правки. */
  function applyObject(o) {
    state.chosen = state.chosen.map((c) => (c.id === o.id ? { ...c, ...toChosen(o), note: c.note } : c));
    state.results = state.results.map((r) => (r.id === o.id ? { ...r, ...o } : r));
  }

  async function saveEditor() {
    const o = collectEditor();
    state.editor.saving = true; render();
    try {
      const saved = await api('/objects/' + o.id, {
        method: 'PATCH',
        body: {
          title: o.title, complex: o.complex, address: o.address, price: o.price, rooms: o.rooms, area_total: o.area_total,
          area_living: o.area_living, area_kitchen: o.area_kitchen, floor: o.floor, floors: o.floors,
          description: o.description, photos: (o.photos || []).map((p) => p.big),
        },
      });
      applyObject(saved);
      state.editor = null;
      if (state.view === 'history') await loadHistory();
      render();
      toast('Сохранено — изменения видны во всех подборках');
    } catch (e) { state.editor.saving = false; render(); toast(e.message); }
  }

  async function uploadPhotos(files) {
    const o = collectEditor();
    for (const file of files) {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { toast('Пропущен файл ' + file.name + ': нужен JPG, PNG или WEBP'); continue; }
      try {
        const res = await fetch('/api/objects/' + o.id + '/photos', {
          method: 'POST', headers: { Authorization: 'Bearer ' + BOOT.token, 'Content-Type': file.type }, body: file,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Ошибка ' + res.status);
        o.photos = (o.photos || []).concat({ big: data.photo, small: data.photo });
      } catch (e) { toast(e.message); }
    }
    render();
  }

  // ---------- Поиск ----------
  let searchSeq = 0;
  async function search(reset = true) {
    const f = state.filters;
    if (reset) { state.page = 1; state.results = []; }
    const q = new URLSearchParams();
    if (f.category) q.set('category', f.category);
    if (f.rooms.length) q.set('rooms', f.rooms.join(','));
    const mln = (v) => (v === '' ? '' : String(Math.round(parseFloat(String(v).replace(',', '.')) * 1e6) || ''));
    if (f.priceMin) q.set('priceMin', mln(f.priceMin));
    if (f.priceMax) q.set('priceMax', mln(f.priceMax));
    if (f.areaMin) q.set('areaMin', f.areaMin.replace(',', '.'));
    if (f.areaMax) q.set('areaMax', f.areaMax.replace(',', '.'));
    if (f.q) q.set('q', f.q);
    q.set('sort', f.sort);
    q.set('page', state.page);
    q.set('limit', 24);
    const seq = ++searchSeq;
    state.loading = true;
    renderKeepFocus();
    try {
      const data = await api('/catalog/search?' + q);
      if (seq !== searchSeq) return;
      state.total = data.total;
      state.results = reset ? data.items : state.results.concat(data.items);
    } catch (e) {
      toast(e.message);
    } finally {
      if (seq === searchSeq) { state.loading = false; renderKeepFocus(); }
    }
  }
  const searchDebounced = debounce(() => search(true), 350);

  /** Перерисовка с сохранением фокуса и позиции курсора в полях ввода. */
  function renderKeepFocus() {
    const a = document.activeElement;
    const key = a && (a.name || a.dataset?.note) ? { name: a.name, note: a.dataset.note, start: a.selectionStart, end: a.selectionEnd } : null;
    render();
    if (key) {
      const el = key.note ? $app.querySelector(`[data-note="${key.note}"]`) : $app.querySelector(`[name="${key.name}"]`);
      if (el) { el.focus(); try { el.setSelectionRange(key.start, key.end); } catch (e) { /* select */ } }
    }
  }

  // ---------- Действия ----------
  function toChosen(o) {
    return {
      id: o.id, title: o.title, address: o.address, price: o.price, thumb: o.thumb || o.photos?.[0]?.small, note: '',
      source: o.source, sourceName: o.sourceName, url: o.url,
    };
  }

  function findObject(id) {
    return state.results.find((o) => o.id === id) || (state.detail && state.detail.id === id ? state.detail : null);
  }

  /** «Подборка на 09.11.2026 14:05» по тюменскому времени (часовой пояс задаётся сервером). */
  function defaultTitle() {
    const tz = BOOT.timezone || 'Asia/Yekaterinburg';
    const p = Object.fromEntries(new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(new Date()).map((x) => [x.type, x.value]));
    return `Подборка на ${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
  }

  function openBuilder(prefill) {
    state.view = 'builder';
    state.chosen = prefill || [];
    state.title = defaultTitle();
    state.message = '';
    render();
    search(true);
  }

  async function openDetail(id) {
    state.detail = { id, loading: true };
    render();
    try {
      state.detail = await api('/catalog/object/' + id);
    } catch (e) {
      state.detail = null; toast(e.message);
    }
    render();
  }

  async function createSelection() {
    const btn = $app.querySelector('[data-act="create"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Создаём…'; }
    try {
      const sel = await api('/selections', {
        method: 'POST',
        body: { title: state.title, message: state.message, items: state.chosen.map((c) => ({ id: c.id, note: c.note })) },
      });
      const timeline = await addTimelineComment(sel);
      state.created = { ...sel, timeline };
      await loadHistory();
      state.view = 'history';
      state.expanded = new Set([sel.id]);
      state.chosen = [];
      render();
    } catch (e) {
      toast(e.message);
      if (btn) { btn.disabled = false; btn.textContent = 'Создать и получить ссылку'; }
    }
  }

  $app.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    // клик внутри модального окна не должен закрывать его
    if (el.dataset.act === 'close-detail' && el.classList.contains('modal') && e.target.closest('[data-stop]')) return;
    const id = Number(el.dataset.id);
    switch (el.dataset.act) {
      case 'new': openBuilder(); break;
      case 'cancel': state.view = 'history'; render(); break;
      case 'expand':
        state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
        render(); break;
      case 'toggle-archived': state.showArchived = !state.showArchived; render(); break;
      case 'copy':
        e.stopPropagation();
        toast((await copyText(el.dataset.link)) ? 'Ссылка скопирована' : 'Скопируйте ссылку вручную');
        break;
      case 'archive':
        try {
          const toArchive = el.dataset.archived === '1';
          await api(`/selections/${id}/archive`, { method: 'POST', body: { archived: toArchive } });
          await loadHistory(); render();
          toast(toArchive ? 'Подборка в архиве: ссылка у клиента не открывается. Удалить можно в «Показать архив»' : 'Подборка возвращена из архива');
        } catch (err) { toast(err.message); }
        break;
      case 'delete': {
        const s = state.selections.find((x) => x.id === id);
        if (!confirm(`Удалить подборку «${s?.title || 'Подборка №' + id}» навсегда?\n\nОценки и комментарии клиента будут удалены, ссылка перестанет работать. Отменить это нельзя.`)) break;
        try {
          await api(`/selections/${id}`, { method: 'DELETE' });
          state.expanded.delete(id);
          await loadHistory(); render();
          toast('Подборка удалена');
        } catch (err) { toast(err.message); }
        break;
      }
      case 'based-on': {
        const s = state.selections.find((x) => x.id === id);
        // берём понравившиеся и неоценённые, не снятые с сайта
        const keep = s.items.filter((i) => i.reaction !== 'dislike' && !i.removed).map((i) => ({ ...toChosen(i.object), note: i.agentNote || '' }));
        openBuilder(keep);
        toast(keep.length ? `Перенесено объектов: ${keep.length}` : 'Подходящих объектов не осталось — выберите новые');
        break;
      }
      case 'room': {
        const v = Number(el.dataset.v);
        const r = state.filters.rooms;
        state.filters.rooms = r.includes(v) ? r.filter((x) => x !== v) : r.concat(v);
        search(true); break;
      }
      case 'more': state.page += 1; search(false); break;
      case 'add': {
        const o = findObject(id);
        if (o && !state.chosen.some((c) => c.id === id)) state.chosen.push(toChosen(o));
        render(); break;
      }
      case 'remove': state.chosen = state.chosen.filter((c) => c.id !== id); render(); break;
      case 'up': case 'down': {
        const i = Number(el.dataset.i); const j = el.dataset.act === 'up' ? i - 1 : i + 1;
        if (j >= 0 && j < state.chosen.length) { [state.chosen[i], state.chosen[j]] = [state.chosen[j], state.chosen[i]]; render(); }
        break;
      }
      case 'detail': openDetail(id); break;
      case 'close-detail': state.detail = null; render(); break;
      case 'close-created': state.created = null; render(); break;
      case 'create': createSelection(); break;
      case 'back-dashboard': {
        const f = document.createElement('form');
        f.method = 'post'; f.action = '/b24/home'; f.style.display = 'none';
        const i = document.createElement('input'); i.type = 'hidden'; i.name = 'session'; i.value = BOOT.dashToken || '';
        f.appendChild(i); document.body.appendChild(f); f.submit();
        break;
      }
      case 'native-share': {
        const sel = state.created?.id === id ? state.created : state.selections.find((x) => x.id === id);
        if (sel) navigator.share({ title: sel.title || 'Подборка', text: sel.message || 'Подборка объектов для вас', url: sel.link }).catch(() => {});
        break;
      }
      case 'edit-obj': e.preventDefault(); openEditor(id); break;
      case 'close-editor': state.editor = null; render(); break;
      case 'save-editor': saveEditor(); break;
      case 'ph-left': case 'ph-right': case 'ph-del': {
        const o = collectEditor();
        const i = Number(el.dataset.i);
        const ph = o.photos;
        if (el.dataset.act === 'ph-del') ph.splice(i, 1);
        else { const j = el.dataset.act === 'ph-left' ? i - 1 : i + 1; if (j >= 0 && j < ph.length) [ph[i], ph[j]] = [ph[j], ph[i]]; }
        render(); break;
      }
      default:
    }
  });

  $app.addEventListener('input', (e) => {
    const t = e.target;
    if (t.hasAttribute('data-ed') && state.editor?.obj) { state.editor.obj[t.name] = t.value; return; }
    if (t.dataset.field) { state[t.dataset.field] = t.value; return; }
    if (t.dataset.note) { const c = state.chosen.find((x) => x.id === Number(t.dataset.note)); if (c) c.note = t.value; return; }
    if (t.hasAttribute('data-filter') && t.type !== 'checkbox' && t.tagName !== 'SELECT') {
      state.filters[t.name] = t.value;
      searchDebounced();
    }
  });

  $app.addEventListener('change', (e) => {
    const t = e.target;
    if (t.hasAttribute('data-upload')) { uploadPhotos([...t.files]); return; }
    if (!t.hasAttribute('data-filter')) return;
    if (t.type === 'checkbox') { state.filters[t.name] = t.checked; render(); return; }
    if (t.tagName === 'SELECT') { state.filters[t.name] = t.value; search(true); }
  });

  $app.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-form="url"]');
    if (!form) return;
    e.preventDefault();
    const input = form.elements.url;
    const url = input.value.trim();
    if (!url) return;
    const btn = form.querySelector('button');
    btn.disabled = true; btn.textContent = 'Читаем сайт…';
    try {
      const o = await api('/catalog/resolve', { method: 'POST', body: { url } });
      if (state.chosen.some((c) => c.id === o.id)) toast('Объект уже в подборке');
      else {
        state.chosen.push(toChosen(o));
        toast(o.existed ? 'Объект уже был в базе — добавлен с прежними правками' : 'Добавлено: ' + o.title);
      }
      input.value = '';
      render();
      // по ссылке с другого сайта — сразу показать карточку для проверки (черновик — обязательно)
      if (o.source === 'link' && !o.existed) openEditor(o.id, o.warning || 'Проверьте данные и фото — они взяты со страницы автоматически.');
    } catch (err) {
      toast(err.message);
      btn.disabled = false; btn.textContent = 'Добавить';
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.editor && !state.editor.saving) { state.editor = null; render(); return; }
    if (e.key === 'Escape' && state.detail) { state.detail = null; render(); }
  });

  if (window.BX24 && BOOT.inBitrix) BX24.init(() => { init(); });
  else init();
})();
