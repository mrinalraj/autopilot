(() => {
  const shell = document.querySelector('.settings-shell');
  if (!shell) return;
  const forms = [...shell.querySelectorAll('[data-settings-form]')];
  const baseline = new Map();
  const snapshots = (form) => JSON.stringify([...new FormData(form)].filter(([k]) => k !== 'response').sort(([a, av], [b, bv]) => a.localeCompare(b) || String(av).localeCompare(String(bv))));
  const dirty = (form) => snapshots(form) !== baseline.get(form);
  const message = (form, text, error = false) => {
    const state = form.querySelector('.save-state');
    state.textContent = text;
    state.classList.toggle('save-error', error);
  };
  const remember = (form) => { baseline.set(form, snapshots(form)); delete form.dataset.dirty; };
  const hydrate = (form, update) => {
    const original = JSON.parse(baseline.get(form));
    const names = new Set([...form.elements].map((field) => field.name));
    update();
    // New metadata fields join the baseline; already edited controls retain their drafts.
    const added = [...new FormData(form)].filter(([name]) => !names.has(name));
    const remaining = new Set([...form.elements].map((field) => field.name));
    baseline.set(form, JSON.stringify([...original.filter(([name]) => remaining.has(name)), ...added].sort(([a, av], [b, bv]) => a.localeCompare(b) || String(av).localeCompare(String(bv)))));
  };
  forms.forEach((form) => {
    remember(form);
    form.addEventListener('input', () => { form.dataset.dirty = String(dirty(form)); message(form, dirty(form) ? 'Unsaved changes' : 'No unsaved changes'); });
    form.addEventListener('change', () => { form.dataset.dirty = String(dirty(form)); message(form, dirty(form) ? 'Unsaved changes' : 'No unsaved changes'); });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (form.dataset.busy) return;
      const button = event.submitter || form.querySelector('[type=submit]');
      const reset = window.autopilotUI.busy(button);
      form.dataset.busy = '1';
      const error = form.querySelector('.form-error');
      error.hidden = true;
      form.querySelectorAll('.field-error').forEach((n) => n.remove());
      form.querySelectorAll('[aria-invalid]').forEach((n) => { n.removeAttribute('aria-invalid'); n.removeAttribute('aria-describedby'); });
      const data = new FormData(form); data.set('response', 'json');
      const sent = snapshots(form);
      message(form, 'Saving…');
      try {
        const response = await fetch(form.action, { method: 'POST', body: data });
        if (response.redirected) throw new Error('The app restarted. Reload after copying your edits, then try again.');
        const result = await response.json();
        if (!response.ok || !result.ok) {
          for (const [name, text] of Object.entries(result.fields || {})) {
            const field = form.elements.namedItem(name);
            if (!(field instanceof HTMLElement)) continue;
            const hint = document.createElement('p'); hint.className = 'field-error'; hint.id = 'error-' + name; hint.textContent = text;
            field.setAttribute('aria-invalid', 'true'); field.setAttribute('aria-describedby', hint.id); field.after(hint);
          }
          throw new Error(result.error || 'Could not save. Your edits are still here.');
        }
        baseline.set(form, sent);
        form.dataset.dirty = String(dirty(form));
        message(form, dirty(form) ? 'Saved. You have newer unsaved changes.' : result.notice || 'Saved.');
        window.autopilotUI.reveal(form.querySelector('.save-state'));
        if (form.dataset.section === 'repositories' && !dirty(form)) { loaded.delete('repos'); await load('repos'); }
      } catch (err) {
        error.textContent = err.message || 'Could not save. Your edits are still here.'; error.hidden = false;
        message(form, 'Not saved — check the error', true);
        const target = form.querySelector('[aria-invalid]') || error;
        target.closest('details')?.setAttribute('open', ''); target.focus();
      } finally { delete form.dataset.busy; reset(); }
    });
  });

  // Warn only when navigation would actually discard an edited section.
  let leaving = false;
  const hasDraft = (except) => forms.some((f) => f !== except && dirty(f));
  addEventListener('beforeunload', (e) => { if (!leaving && hasDraft()) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    if (!link || link.target === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || link.hash && new URL(link.href).pathname === location.pathname) return;
    if (hasDraft() && !confirm('Leave Settings and discard your unsaved changes?')) { e.preventDefault(); e.stopImmediatePropagation(); }
    else leaving = true;
  }, true);
  document.addEventListener('submit', (e) => {
    if (e.target.matches('[data-settings-form]')) return;
    if (hasDraft() && !confirm('This action leaves Settings. Discard your unsaved changes and continue?')) { e.preventDefault(); e.stopImmediatePropagation(); }
    else leaving = true;
  }, true);
  addEventListener('pageshow', () => { leaving = false; });

  const conditions = () => {
    const launcher = document.getElementById('launcher').value, editor = ['vscode', 'cursor'].includes(launcher);
    const chat = document.getElementById('ideSession').value === 'chat';
    shell.querySelectorAll('[data-launchers]').forEach((node) => {
      node.hidden = !node.dataset.launchers.split(' ').includes(launcher) || node.hasAttribute('data-chat-only') && !chat || node.hasAttribute('data-terminal-only') && editor && chat;
    });
    shell.querySelector('[data-when-tracker]').hidden = document.getElementById('tracker').value !== 'jira';
    shell.querySelector('[data-selected-statuses]').hidden = document.getElementById('pickupMode').value !== 'selected';
  };
  shell.addEventListener('change', conditions); conditions();

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const sectionForm = (section) => forms.find((f) => f.dataset.section === section);
  const loaded = new Set(), pending = new Map();
  const load = (part, force = false) => {
    if (pending.has(part)) return pending.get(part);
    if (loaded.has(part) && !force) return Promise.resolve();
    const work = (async () => {
      const status = shell.querySelector(`[data-check="${part}"]`), retry = shell.querySelector(`[data-retry="${part}"]`);
      retry.hidden = true; status.textContent = 'Checking…';
      try {
        const response = await fetch('/settings/data?part=' + part + (force ? '&refresh=1' : ''), { cache: 'no-store' });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || 'Check unavailable');
        const data = result.data;
        if (part === 'account') {
          status.textContent = data ? `Signed in as ${data.name}${data.email ? ' · ' + data.email : ''}` : 'Not signed in. Connect your tracker to watch tickets.';
          shell.querySelector('form[action="/actions/signin"] button').textContent = data ? 'Switch account' : 'Sign in';
        } else if (part === 'github') {
          const select = document.getElementById('githubUser');
          for (const a of data.accounts) if (![...select.options].some((o) => o.value === a.name)) select.add(new Option(a.name, a.name));
          status.textContent = data.accounts.length ? 'Available accounts from gh' : 'No signed-in GitHub accounts. Run gh auth login in Terminal.';
        } else if (part === 'statuses') {
          hydrate(sectionForm('tickets'), () => {
            shell.querySelectorAll('[data-status-options]').forEach((list) => {
              const existing = new Set([...list.querySelectorAll('input')].map((n) => n.value.toLowerCase()));
              for (const s of data) {
                if (existing.has(s.name.toLowerCase())) continue;
                existing.add(s.name.toLowerCase());
                const label = el('label', 'opt'), input = el('input'); input.type = 'checkbox'; input.name = list.dataset.statusOptions; input.value = s.name;
                label.append(input, document.createTextNode(s.name)); list.append(label);
              }
            });
          });
          status.textContent = data.length ? 'Available statuses from your tracker' : 'Statuses unavailable. Your selected statuses are kept; you can add names manually.';
          retry.hidden = data.length > 0;
        } else if (part === 'repos') {
          const form = sectionForm('repositories');
          const wasClean = !dirty(form);
          // A retry must not overwrite a description edited while the request was in flight.
          hydrate(form, () => {
            const list = shell.querySelector('[data-repo-list]');
            for (const r of data) {
              if ([...list.children].some((n) => n.dataset.repo === r.name)) continue;
              const row = el('div', 'repo'); row.dataset.repo = r.name; row.dataset.search = (r.name + ' ' + r.path).toLowerCase();
              const present = el('input'); present.type = 'hidden'; present.name = 'present:' + r.name; present.value = '1';
              const label = el('label', 'check'), input = el('input'); input.type = 'checkbox'; input.name = 'include:' + r.name; input.checked = !r.excluded;
              label.append(input, el('strong', '', r.name));
              const description = el('input'); description.type = 'text'; description.name = 'desc:' + r.name; description.value = r.override || r.derived; description.setAttribute('aria-label', 'Description of ' + r.name); description.placeholder = 'What lives in this repo';
              row.append(present, label, description, el('span', 'repo-path small muted', r.path)); list.append(row);
            }
            // Remove rows only after their folders were saved, never during an unsaved edit.
            if (wasClean) for (const row of [...list.children]) if (!data.some((r) => r.name === row.dataset.repo)) row.remove();
          });
          status.textContent = `${data.length} repositories found`;
        } else status.textContent = data;
        loaded.add(part);
      } catch (error) { status.textContent = error.message || 'Check unavailable. Your local settings are still editable.'; retry.hidden = false; }
    })().finally(() => pending.delete(part));
    pending.set(part, work); return work;
  };
  const parts = { connections: ['account', 'github'], tickets: ['statuses'], repositories: ['repos'], advanced: ['service'] };
  const scroller = shell.querySelector('.settings-panels'), scrollPositions = new Map();
  let activeSection;
  const chooseSection = () => {
    const requested = location.hash.slice(1) || shell.dataset.initialSection;
    const id = [...shell.querySelectorAll('[data-settings-panel]')].some((n) => n.id === requested) ? requested : 'connections';
    if (activeSection) scrollPositions.set(activeSection, scroller.scrollTop);
    shell.querySelectorAll('[data-settings-panel]').forEach((panel) => {
      const wasHidden = panel.hidden; panel.hidden = panel.id !== id;
      if (wasHidden && !panel.hidden) window.autopilotUI.reveal(panel);
    });
    shell.querySelectorAll('[data-settings-link]').forEach((link) => {
      if (link.dataset.settingsLink === id) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    scroller.scrollTop = scrollPositions.get(id) || 0;
    activeSection = id;
    (parts[id] || []).forEach((part) => load(part));
  };
  shell.classList.add('settings-ready');
  addEventListener('hashchange', chooseSection); chooseSection();
  shell.querySelectorAll('[data-retry]').forEach((button) => button.addEventListener('click', () => load(button.dataset.retry, true)));
  document.getElementById('repo-search').addEventListener('input', (event) => {
    const q = event.target.value.toLowerCase().trim(); shell.querySelectorAll('[data-repo]').forEach((row) => { row.hidden = !row.dataset.search.includes(q); });
  });
  shell.querySelector('[data-pick-folders]').addEventListener('click', async (event) => {
    const button = event.currentTarget; if (button.classList.contains('busy')) return;
    const reset = window.autopilotUI.busy(button), form = button.closest('form');
    const body = new FormData(); body.set('csrf', form.elements.namedItem('csrf').value); body.set('response', 'json');
    try {
      const response = await fetch('/actions/pick-folders', { method: 'POST', body });
      if (response.redirected) throw new Error('The app restarted. Reload after copying your edits.');
      const result = await response.json(); if (!result.ok) throw new Error(result.error);
      for (const folder of result.folders) {
        const input = form.elements.namedItem(folder.repo ? 'repoPaths' : 'repoRoots');
        const paths = input.value.split('\n').map((p) => p.trim()).filter(Boolean); if (!paths.includes(folder.path)) paths.push(folder.path);
        input.value = paths.join('\n');
      }
      form.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (err) { const error = form.querySelector('.form-error'); error.textContent = err.message; error.hidden = false; }
    finally { reset(); }
  });
})();
