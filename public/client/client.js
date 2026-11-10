/* Публичная страница подборки для клиента */
(function () {
  const { esc, price, dateOnly, shortSpecs, toast, debounce, plural } = window.U;
  const token = location.pathname.split('/').filter(Boolean).pop();
  const root = document.getElementById('root');
  let data = null;
  const open = new Set();      // раскрытые «Подробнее»
  const saving = new Map();    // itemId -> 'saving' | 'saved'
  const dirty = new Set();      // комментарии, которые ещё не сохранены

  async function call(path, body) {
    const res = await fetch(`/api/public/${encodeURIComponent(token)}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'Ошибка соединения');
    return d;
  }

  async function init() {
    try {
      data = await call('');
      document.title = data.title || 'Подборка объектов — ' + data.agency.name;
      render();
      call('/view', {}).catch(() => {});
    } catch (e) {
      root.innerHTML = `<div class="c-empty"><div class="c-empty__icon">🔍</div><h2>Подборка недоступна</h2><p>${esc(e.message)}</p><p>Свяжитесь с вашим специалистом, чтобы получить новую ссылку.</p></div>`;
    }
  }

  const rated = () => data.items.filter((i) => i.reaction).length;

  function render() {
    const total = data.items.length;
    const r = rated();
    const a = data.agency;
    root.innerHTML = `
      <header class="c-header">
        <div class="c-header__inner">
          <a class="c-brand" href="${esc(U.safeUrl(a.site))}" target="_blank" rel="noopener noreferrer">
            ${a.logo ? `<img src="${esc(a.logo)}" alt="" data-broken="remove">` : ''}
            <span>${esc(a.name)}</span>
          </a>
          ${a.phone ? `<a class="c-phone" href="tel:${esc(a.phone.replace(/[^\d+]/g, ''))}">${esc(a.phone)}</a>` : ''}
        </div>
      </header>
      <main class="c-main">
        <section class="c-intro">
          <div class="c-intro__kicker">Подборка от ${esc(dateOnly(data.createdAt))}</div>
          <h1>${esc(data.title || 'Мы подобрали для вас варианты')}</h1>
          ${data.agentName || data.message ? `<div class="c-agent">
            <div class="c-agent__avatar">${esc((data.agentName || a.name).trim().charAt(0))}</div>
            <div class="c-agent__body">
              ${data.agentName ? `<div class="c-agent__name">${esc(data.agentName)} <span>· ваш специалист</span></div>` : ''}
              ${data.message ? `<div class="c-agent__msg">${esc(data.message)}</div>` : ''}
            </div>
          </div>` : ''}
          <p class="c-hint">Отметьте, что вам нравится, а что нет — так мы быстрее найдём подходящий вариант. Если объект не подходит, укажите причину. Ответы сохраняются сами, специалист видит их сразу.</p>
        </section>
        <div class="c-list">${data.items.map(renderItem).join('')}</div>
      </main>
      <div class="c-bar">
        <div class="c-bar__inner">
          <div class="c-bar__progress">
            <div class="c-bar__label">Оценено <b>${r}</b> из ${total}</div>
            <div class="c-progress"><span style="width:${total ? (r / total) * 100 : 0}%"></span></div>
          </div>
          <div class="c-bar__status">${r ? (r === total ? '✓ Все оценки у специалиста' : '✓ Оценки сохранены') : 'Ответы сохраняются автоматически'}</div>
        </div>
      </div>
      <footer class="c-footer">${esc(a.name)} · <a href="${esc(U.safeUrl(a.site))}" target="_blank" rel="noopener noreferrer">${esc(a.site.replace(/^https?:\/\//, ''))}</a></footer>`;
    bindCarousels();
  }

  function renderItem(it, idx) {
    const o = it.object;
    const photos = o.photos?.length ? o.photos : (o.thumb ? [{ small: o.thumb, big: o.thumb }] : []);
    const isOpen = open.has(it.itemId);
    const props = Object.entries(o.props || {}).filter(([k]) => k !== 'Тип объявления');
    const mapUrl = o.lat && o.lng ? `https://yandex.ru/maps/?pt=${o.lng},${o.lat}&z=16&l=map` : `https://yandex.ru/maps/?text=${encodeURIComponent(o.address || '')}`;
    const s = saving.get(it.itemId);
    const specs = [
      o.rooms != null ? [o.rooms === 0 ? 'Студия' : o.rooms, o.rooms === 0 ? 'тип' : plural(o.rooms, 'комната', 'комнаты', 'комнат')] : null,
      o.area_total ? [String(o.area_total).replace('.', ','), 'м² общая'] : null,
      o.area_kitchen ? [String(o.area_kitchen).replace('.', ','), 'м² кухня'] : null,
      o.floor ? [o.floors ? `${o.floor}/${o.floors}` : o.floor, 'этаж'] : null,
    ].filter(Boolean);

    return `<article class="c-card ${it.reaction ? 'is-' + it.reaction : ''} ${it.removed ? 'is-removed' : ''}" id="item-${it.itemId}">
      <div class="c-gallery" data-gallery="${it.itemId}">
        <div class="c-gallery__track">
          ${photos.map((p, i) => `<img src="${esc(p.small)}" data-big="${esc(p.big)}" data-i="${i}" alt="Фото ${i + 1}" loading="${idx < 2 && i < 2 ? 'eager' : 'lazy'}">`).join('') || '<div class="c-gallery__empty">Нет фото</div>'}
        </div>
        ${photos.length > 1 ? `<span class="c-gallery__count"><span data-cur>1</span>/${photos.length}</span>
          <button class="c-gallery__nav c-gallery__nav--prev" data-act="prev" aria-label="Предыдущее фото">‹</button>
          <button class="c-gallery__nav c-gallery__nav--next" data-act="next" aria-label="Следующее фото">›</button>` : ''}
        <span class="c-num">${idx + 1}</span>
        ${it.removed ? '<div class="c-removed">Объект уже снят с продажи</div>' : ''}
      </div>
      <div class="c-card__body">
        ${o.categoryLabel ? `<div class="c-cat">${esc(o.categoryLabel)}</div>` : ''}
        <div class="c-price">${price(o.price)}${o.price_per_m2 ? `<span>${esc(o.price_per_m2)}</span>` : ''}</div>
        <h2 class="c-title">${esc(o.title)}</h2>
        ${o.address || (o.lat && o.lng) ? `<a class="c-addr" href="${esc(U.safeUrl(mapUrl))}" target="_blank" rel="noopener noreferrer">📍 ${esc(o.address || 'Показать на карте')}</a>` : ''}
        ${specs.length ? `<div class="c-specs">${specs.map(([v, l]) => `<div><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('')}</div>` : ''}
        ${it.agentNote ? `<div class="c-note"><span>Комментарий специалиста</span>${esc(it.agentNote)}</div>` : ''}
        <button class="c-more" data-act="more" data-id="${it.itemId}">${isOpen ? 'Скрыть подробности ▲' : 'Подробнее об объекте ▼'}</button>
        ${isOpen ? `<div class="c-details">
          ${props.length ? `<dl>${props.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
          ${o.description ? `<p class="c-descr">${esc(o.description)}</p>` : ''}
          ${o.url ? `<a class="c-site" href="${esc(U.safeUrl(o.url))}" target="_blank" rel="noopener noreferrer">Открыть на сайте →</a>` : ''}
        </div>` : ''}

        <div class="c-react">
          <div class="c-react__q">Как вам этот вариант?</div>
          <div class="c-react__btns">
            <button class="c-rbtn c-rbtn--like ${it.reaction === 'like' ? 'is-on' : ''}" data-act="react" data-r="like" data-id="${it.itemId}">👍 Нравится</button>
            <button class="c-rbtn c-rbtn--dislike ${it.reaction === 'dislike' ? 'is-on' : ''}" data-act="react" data-r="dislike" data-id="${it.itemId}">👎 Не подходит</button>
          </div>
          ${it.reaction === 'like' ? `<label class="c-check"><input type="checkbox" data-act="viewing" data-id="${it.itemId}" ${it.wantViewing ? 'checked' : ''}> Хочу посмотреть вживую</label>` : ''}
          ${it.reaction === 'dislike' ? `<div class="c-reasons"><div class="c-react__sub">Что не подходит? Можно выбрать несколько</div>
            <div class="c-chips">${data.reasons.map((r) => `<button class="chip ${it.reasons.includes(r) ? 'is-on' : ''}" data-act="reason" data-id="${it.itemId}" data-reason="${esc(r)}">${esc(r)}</button>`).join('')}</div></div>` : ''}
          ${it.reaction ? `<textarea class="textarea c-comment" rows="2" data-comment="${it.itemId}" placeholder="${it.reaction === 'like' ? 'Что особенно понравилось? Есть вопросы?' : 'Расскажите подробнее — это поможет подобрать лучше'}">${esc(it.clientComment || '')}</textarea>` : ''}
          <div class="c-saved">${s === 'saving' ? 'Сохраняем…' : s === 'saved' ? '✓ Сохранено' : ''}</div>
        </div>
      </div>
    </article>`;
  }

  // ---------- Сохранение реакции ----------
  const payload = (it) => ({ reaction: it.reaction, reasons: it.reasons, comment: it.clientComment, wantViewing: it.wantViewing });

  async function persist(it) {
    dirty.delete(it.itemId);
    saving.set(it.itemId, 'saving');
    updateSaved(it.itemId);
    try {
      await call(`/items/${it.itemId}`, payload(it));
      saving.set(it.itemId, 'saved');
      updateBar();
    } catch (e) {
      saving.delete(it.itemId);
      toast(e.message);
    }
    updateSaved(it.itemId);
  }
  const persistLater = new Map();
  function persistDebounced(it) {
    if (!persistLater.has(it.itemId)) persistLater.set(it.itemId, debounce(() => persist(it), 600));
    persistLater.get(it.itemId)();
  }
  /** Обновляет нижнюю панель без полной перерисовки (чтобы не сбивать ввод). */
  function updateBar() {
    const r = rated(); const total = data.items.length;
    const label = document.querySelector('.c-bar__label');
    if (label) label.innerHTML = `Оценено <b>${r}</b> из ${total}`;
    const bar = document.querySelector('.c-progress span');
    if (bar) bar.style.width = (total ? (r / total) * 100 : 0) + '%';
    const st = document.querySelector('.c-bar__status');
    if (st) st.textContent = r ? (r === total ? '✓ Все оценки у специалиста' : '✓ Оценки сохранены') : 'Ответы сохраняются автоматически';
  }

  /** При уходе со страницы досылаем несохранённые комментарии. */
  function flushDirty() {
    for (const id of dirty) {
      const it = itemById(id);
      if (!it) continue;
      const body = new Blob([JSON.stringify(payload(it))], { type: 'application/json' });
      if (!navigator.sendBeacon?.(`/api/public/${encodeURIComponent(token)}/items/${id}`, body)) persist(it);
    }
    dirty.clear();
  }
  window.addEventListener('pagehide', flushDirty);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushDirty(); });

  function updateSaved(id) {
    const el = document.querySelector(`#item-${id} .c-saved`);
    const s = saving.get(id);
    if (el) el.textContent = s === 'saving' ? 'Сохраняем…' : s === 'saved' ? '✓ Сохранено' : '';
  }

  /** Перерисовка с сохранением прокрутки относительно карточки. */
  function rerenderKeep(itemId) {
    const el = document.getElementById('item-' + itemId);
    const top = el ? el.getBoundingClientRect().top : null;
    const scrollPositions = {};
    document.querySelectorAll('[data-gallery]').forEach((g) => { scrollPositions[g.dataset.gallery] = g.querySelector('.c-gallery__track').scrollLeft; });
    render();
    document.querySelectorAll('[data-gallery]').forEach((g) => {
      const t = g.querySelector('.c-gallery__track');
      if (scrollPositions[g.dataset.gallery]) t.scrollLeft = scrollPositions[g.dataset.gallery];
    });
    const el2 = document.getElementById('item-' + itemId);
    if (el2 && top != null) window.scrollBy(0, el2.getBoundingClientRect().top - top);
  }

  const itemById = (id) => data.items.find((i) => i.itemId === Number(id));

  root.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) {
      const img = e.target.closest('.c-gallery__track img');
      if (img) openLightbox(img.closest('[data-gallery]').dataset.gallery, Number(img.dataset.i));
      return;
    }
    const it = itemById(el.dataset.id);
    switch (el.dataset.act) {
      case 'react': {
        const r = el.dataset.r;
        it.reaction = it.reaction === r ? null : r;
        if (it.reaction !== 'dislike') it.reasons = [];
        if (it.reaction !== 'like') it.wantViewing = false;
        persist(it);
        rerenderKeep(it.itemId);
        break;
      }
      case 'reason': {
        const r = el.dataset.reason;
        it.reasons = it.reasons.includes(r) ? it.reasons.filter((x) => x !== r) : it.reasons.concat(r);
        el.classList.toggle('is-on');
        persist(it);
        break;
      }
      case 'viewing': it.wantViewing = el.checked; persist(it); break;
      case 'more': open.has(it.itemId) ? open.delete(it.itemId) : open.add(it.itemId); rerenderKeep(it.itemId); break;
      case 'prev': case 'next': {
        const track = el.closest('[data-gallery]').querySelector('.c-gallery__track');
        track.scrollBy({ left: (el.dataset.act === 'next' ? 1 : -1) * track.clientWidth, behavior: 'smooth' });
        break;
      }
      default:
    }
  });

  root.addEventListener('input', (e) => {
    const id = e.target.dataset.comment;
    if (!id) return;
    const it = itemById(id);
    it.clientComment = e.target.value;
    dirty.add(it.itemId);
    persistDebounced(it);
  });

  root.addEventListener('focusout', (e) => {
    const id = Number(e.target.dataset?.comment);
    if (id && dirty.has(id)) persist(itemById(id));
  });

  // ---------- Галерея ----------
  function bindCarousels() {
    document.querySelectorAll('[data-gallery]').forEach((g) => {
      const track = g.querySelector('.c-gallery__track');
      const cur = g.querySelector('[data-cur]');
      if (!cur) return;
      track.addEventListener('scroll', () => {
        cur.textContent = Math.round(track.scrollLeft / track.clientWidth) + 1;
      }, { passive: true });
    });
  }

  function openLightbox(itemId, start) {
    const it = itemById(itemId);
    const photos = it.object.photos?.length ? it.object.photos : [{ big: it.object.thumb }];
    const lb = document.createElement('div');
    lb.className = 'c-lightbox';
    lb.innerHTML = `<button class="c-lightbox__close" aria-label="Закрыть">✕</button>
      <div class="c-lightbox__track">${photos.map((p) => `<div class="c-lightbox__slide"><img src="${esc(p.big)}" alt=""></div>`).join('')}</div>
      <div class="c-lightbox__count"><span>${start + 1}</span>/${photos.length}</div>`;
    document.body.appendChild(lb);
    document.body.style.overflow = 'hidden';
    const track = lb.querySelector('.c-lightbox__track');
    requestAnimationFrame(() => { track.scrollLeft = start * track.clientWidth; });
    track.addEventListener('scroll', () => { lb.querySelector('.c-lightbox__count span').textContent = Math.round(track.scrollLeft / track.clientWidth) + 1; }, { passive: true });
    const close = () => { lb.remove(); document.body.style.overflow = ''; document.removeEventListener('keydown', onKey); };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowRight') track.scrollBy({ left: track.clientWidth, behavior: 'smooth' });
      if (e.key === 'ArrowLeft') track.scrollBy({ left: -track.clientWidth, behavior: 'smooth' });
    };
    lb.querySelector('.c-lightbox__close').onclick = close;
    document.addEventListener('keydown', onKey);
  }

  init();
})();
