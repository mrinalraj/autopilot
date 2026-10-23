(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const curve = 'cubic-bezier(0.23, 1, 0.32, 1)';
  let keyboard = false;
  document.addEventListener('keydown', () => { keyboard = true; document.body.dataset.input = 'keyboard'; }, true);
  document.addEventListener('pointerdown', () => { keyboard = false; document.body.dataset.input = 'pointer'; }, true);
  const animations = new WeakMap();
  const reveal = (node) => {
    if (!node || keyboard || !node.animate) return;
    const running = animations.get(node);
    const opacity = running ? getComputedStyle(node).opacity : '0.4';
    running?.cancel();
    animations.set(node, node.animate([{ opacity }, { opacity: 1 }], { duration: 200, easing: curve }));
  };
  const busyStates = new Map();
  const busy = (button) => {
    if (!button) return () => {};
    if (busyStates.has(button)) return busyStates.get(button);
    const html = button.innerHTML, width = button.style.width, height = button.style.height;
    const bounds = button.getBoundingClientRect();
    button.style.width = bounds.width + 'px'; button.style.height = bounds.height + 'px';
    const label = button.dataset.busyLabel || button.textContent;
    button.classList.add('busy'); button.setAttribute('aria-busy', 'true');
    const text = document.createElement('span'); text.className = 'busy-label'; text.textContent = label; button.replaceChildren(text);
    const reset = () => {
      button.innerHTML = html; button.style.width = width; button.style.height = height;
      button.classList.remove('busy'); button.removeAttribute('aria-busy'); busyStates.delete(button);
    };
    busyStates.set(button, reset); return reset;
  };
  window.autopilotUI = { busy, reveal };

  const navigation = () => { document.body.classList.add('navigating'); document.getElementById('navigation-status').textContent = 'Loading page…'; };
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target === '_blank' || link.hasAttribute('download')) return;
    const url = new URL(link.href);
    if (link.getAttribute('href').startsWith('#')) return;
    if (url.origin !== location.origin || url.pathname === location.pathname && url.search === location.search && url.hash) return;
    try { sessionStorage.setItem('autopilotNavigation', keyboard ? 'keyboard' : 'pointer'); } catch {}
    navigation();
  });
  try {
    const source = sessionStorage.getItem('autopilotNavigation'); sessionStorage.removeItem('autopilotNavigation');
    if (source === 'pointer') reveal(document.getElementById('main-content'));
  } catch {}
  addEventListener('pageshow', () => {
    document.body.classList.remove('navigating'); document.getElementById('navigation-status').textContent = '';
    document.querySelectorAll('form[data-busy]').forEach((form) => delete form.dataset.busy);
    [...busyStates.values()].forEach((reset) => reset());
  });
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (event.defaultPrevented || form.matches('[data-settings-form]')) return;
    if (form.dataset.busy) { event.preventDefault(); return; }
    const button = event.submitter || form.querySelector('button');
    if (!button) return;
    form.dataset.busy = '1'; const reset = busy(button);
    if (form.hasAttribute('data-triage-edit') && !button.hasAttribute('data-skip-triage')) {
      event.preventDefault(); void saveTriage(form, button, reset);
    }
  });
  const saveTriage = async (form, button, reset) => {
    const error = form.querySelector('[data-triage-error]'); error.hidden = true;
    const body = new FormData(form); body.set('response', 'json');
    try {
      const response = await fetch(button.getAttribute('formaction') || form.action, { method: 'POST', body });
      if (response.redirected) throw new Error('The page is out of date. Copy your edits before reloading.');
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Could not save triage. Your edits are still here; try again.');
      const result = await response.json();
      if (result.expected !== undefined) form.elements.namedItem('expected').value = result.expected;
      if (!response.ok || !result.ok) throw new Error(result.error || 'Could not save triage. Try again.');
      history.replaceState(null, '', result.location); location.reload();
    } catch (err) { error.textContent = err.message; error.hidden = false; error.scrollIntoView({ block: 'nearest' }); delete form.dataset.busy; reset(); }
  };

  // Preserve fragment deep links while giving dialogs real keyboard and focus boundaries.
  const dialogs = [...document.querySelectorAll('.modal')];
  let activeDialog = null, returnFocus = null;
  const focusable = (root) => [...root.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')].filter((n) => !n.disabled && n.tabIndex >= 0 && n.getClientRects().length && !n.closest('[inert]'));
  const restoreInert = new Map();
  const isolate = (node) => {
    for (let current = node; current && current !== document.body; current = current.parentElement) {
      for (const sibling of current.parentElement.children) {
        if (sibling === current || sibling.tagName === 'SCRIPT') continue;
        restoreInert.set(sibling, sibling.inert); sibling.inert = true;
      }
    }
  };
  const syncDialog = () => {
    const next = dialogs.find((d) => '#' + d.id === location.hash) || null;
    if (next === activeDialog) return;
    for (const [node, inert] of restoreInert) node.inert = inert; restoreInert.clear();
    const previous = activeDialog; activeDialog = next;
    if (next) {
      if (!previous) returnFocus = document.activeElement;
      isolate(next); next.querySelector('.panel').focus({ preventScroll: true });
    } else if (previous) {
      const fallback = document.querySelector(`a[href="#${CSS.escape(previous.id)}"]`);
      (returnFocus?.isConnected && returnFocus !== document.body ? returnFocus : fallback)?.focus({ preventScroll: true });
    }
  };
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href^="#m-"]'); if (link && !activeDialog) returnFocus = link;
  });
  addEventListener('hashchange', syncDialog); syncDialog();
  addEventListener('keydown', (e) => {
    if (!activeDialog) return;
    if (e.key === 'Escape') { e.preventDefault(); location.hash = ''; }
    if (e.key === 'Tab') {
      const nodes = focusable(activeDialog), first = nodes[0], last = nodes.at(-1);
      if (!first) { e.preventDefault(); return; }
      if (e.shiftKey && (document.activeElement === first || !nodes.includes(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !nodes.includes(document.activeElement))) { e.preventDefault(); first.focus(); }
    }
  });
  document.addEventListener('focusin', (e) => { if (activeDialog && !activeDialog.contains(e.target)) activeDialog.querySelector('.panel').focus(); });

  if (document.getElementById('signin-wait')) {
    const wait = async () => {
      try { const state = await (await fetch('/state', { cache: 'no-store' })).json(); if (!state.signingIn) return location.reload(); } catch {}
      setTimeout(wait, 2000);
    };
    setTimeout(wait, 2000);
  }
  const live = document.getElementById('live'); if (!live) return;
  const version = live.dataset.version; let stale = false;
  const el = (tag, cls) => { const node = document.createElement(tag); if (cls) node.className = cls; return node; };
  const render = (state) => {
    const p = state.progress, visible = !!state.activity || p.total > 0;
    let box = live.querySelector('.progress');
    if (!visible) { if (box) box.hidden = true; return; }
    if (!box) {
      box = el('div', 'progress'); box.setAttribute('role', 'status');
      const row = el('div', 'row'); row.append(el('div', 'spinner'), el('strong'), el('span', 'muted'));
      const bar = el('div', 'bar'); bar.append(el('div')); box.append(row, bar); live.append(box);
    }
    const wasHidden = box.hidden; box.hidden = false;
    const title = p.total ? 'Triaging ' + (p.current || '') : state.activity;
    const set = (node, text) => { if (node.textContent !== text) node.textContent = text; };
    set(box.querySelector('strong'), title);
    set(box.querySelector('.muted'), p.total ? `${Math.min(p.done + 1, p.total)} of ${p.total} · picking repo, branch and writing the explainer` : '');
    const bar = box.querySelector('.bar'); bar.hidden = !p.total;
    if (p.total) bar.firstElementChild.style.transform = `scaleX(${Math.max(.04, p.done / p.total)})`;
    if (wasHidden) reveal(box);
  };
  const logs = document.getElementById('logs'), body = document.getElementById('logbody'), toggle = document.getElementById('logtoggle');
  let lastId = Number(logs?.dataset.last || 0), logAnimation = null, logGeneration = 0;
  let open = false;
  const setOpen = (next, initial = false) => {
    if (!logs) return;
    const generation = ++logGeneration;
    const previousOpacity = logAnimation ? getComputedStyle(logs).opacity : null;
    const previousTransform = logAnimation ? getComputedStyle(logs).transform : null;
    logAnimation?.cancel(); open = next;
    toggle?.setAttribute('aria-expanded', String(next));
    try { localStorage.setItem('logsOpen', next ? '1' : '0'); } catch {}
    if (!next && logs.contains(document.activeElement)) toggle?.focus();
    const finish = () => { if (generation === logGeneration && !open) { document.body.classList.remove('logs-open'); logs.hidden = true; logs.inert = true; } };
    if (next) { logs.hidden = false; logs.inert = false; document.body.classList.add('logs-open'); }
    if (initial || keyboard || !logs.animate) { if (!next) finish(); return; }
    const offset = reduced.matches ? 'none' : matchMedia('(min-width: 1280px)').matches ? 'translateX(16px)' : 'translateY(16px)';
    const start = { opacity: previousOpacity ?? (next ? 0 : 1), transform: previousTransform ?? (next ? offset : 'none') };
    logAnimation = logs.animate([start, { opacity: next ? 1 : 0, transform: next ? 'none' : offset }], { duration: 200, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' });
    if (!next) logAnimation.onfinish = finish;
  };
  let saved; try { saved = localStorage.getItem('logsOpen'); } catch {}
  setOpen(new URLSearchParams(location.search).has('logs') || saved === '1', true);
  toggle?.addEventListener('click', () => setOpen(!open));
  document.getElementById('logclose')?.addEventListener('click', () => setOpen(false));
  if (body) body.scrollTop = body.scrollHeight;
  const pullLogs = async () => {
    if (!body) return;
    const items = await (await fetch('/events?since=' + lastId, { cache: 'no-store' })).json(); if (!items.length) return;
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    for (const event of items) {
      const line = el('div', 'ln ' + event.level), ts = el('span', 'ts'); ts.textContent = new Date(event.at).toTimeString().slice(0, 8);
      line.append(ts, document.createTextNode(event.msg)); body.append(line); lastId = event.id;
    }
    while (body.childElementCount > 400) body.firstElementChild.remove(); if (atBottom) body.scrollTop = body.scrollHeight;
  };
  const badge = (n) => { try { n > 0 ? navigator.setAppBadge?.(n) : navigator.clearAppBadge?.(); } catch {} };
  const tick = async () => {
    let working = false;
    try {
      const state = await (await fetch('/state', { cache: 'no-store' })).json(); working = !!state.activity || state.progress.total > 0;
      render(state);
      for (const [id, text] of Object.entries(state.launching || {})) {
        document.querySelectorAll('[data-step="' + CSS.escape(id) + '"]').forEach((node) => { if (node.textContent !== text) { node.textContent = text; reveal(node); } });
      }
      await pullLogs(); badge(state.awaiting);
      if (state.version !== version || live.dataset.boot && state.boot !== live.dataset.boot) {
        if (activeDialog) stale = true;
        else {
          // Remember only displayed status labels so the next page highlights actual changes.
          try { sessionStorage.setItem('autopilotCards', JSON.stringify(Object.fromEntries([...document.querySelectorAll('[data-card-id]')].map((n) => [n.dataset.cardId, n.querySelector('.badge')?.textContent])))); } catch {}
          return location.reload();
        }
      }
    } catch {}
    setTimeout(tick, working ? 1500 : 10000);
  };
  try {
    const previous = JSON.parse(sessionStorage.getItem('autopilotCards') || '{}'); sessionStorage.removeItem('autopilotCards');
    document.querySelectorAll('[data-card-id]').forEach((card) => { const badge = card.querySelector('.badge'); if (previous[card.dataset.cardId] && badge?.textContent !== previous[card.dataset.cardId]) reveal(badge); });
  } catch {}
  addEventListener('hashchange', () => { if (stale && !activeDialog) location.reload(); });
  badge(Number(live.dataset.awaiting || 0));
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  setTimeout(tick, 1500);
})();
