(() => {
  // Every action is a form post; show it's working (spinner + label from data-busy) and block double submits.
  document.addEventListener("submit", (e) => {
    const form = e.target;
    if (form.dataset.busy) { e.preventDefault(); return; }
    const btn = e.submitter || form.querySelector("button");
    form.dataset.busy = "1";
    if (!btn) return;
    btn.dataset.label = btn.innerHTML;
    btn.classList.add("busy");
    btn.setAttribute("aria-busy", "true");
    if (btn.dataset.busyLabel !== undefined) btn.textContent = btn.dataset.busyLabel || btn.textContent;
    if (form.hasAttribute("data-triage-edit") && !btn.hasAttribute("data-skip-triage")) {
      e.preventDefault();
      void saveTriage(form, btn);
    }
  });
  // Keep the user's edits in the form when validation, a conflict or a connection fails.
  const saveTriage = async (form, btn) => {
    const error = form.querySelector("[data-triage-error]");
    error.hidden = true;
    const body = new FormData(form);
    body.set("response", "json");
    try {
      const response = await fetch(btn.getAttribute("formaction") || form.action, { method: "POST", body });
      if (response.redirected) throw new Error("The page is out of date. Copy your edits before reloading.");
      if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("Could not save triage. Your edits are still here; try again.");
      const result = await response.json();
      // Saving may succeed before a later launch validation/write fails; keep retries current.
      if (result.expected !== undefined) form.elements.namedItem("expected").value = result.expected;
      if (!response.ok || !result.ok) throw new Error(result.error || "Could not save triage. Try again.");
      history.replaceState(null, "", result.location);
      location.reload();
    } catch (err) {
      error.textContent = err.message || "Could not save triage. Your edits are still here; try again.";
      error.hidden = false;
      error.scrollIntoView({ block: "nearest" });
      delete form.dataset.busy;
      btn.classList.remove("busy");
      btn.removeAttribute("aria-busy");
      btn.innerHTML = btn.dataset.label;
    }
  };
  // Coming back with the Back button restores the page from cache: clear the busy state.
  addEventListener("pageshow", () => {
    document.querySelectorAll("form[data-busy]").forEach((f) => delete f.dataset.busy);
    document.querySelectorAll("button.busy").forEach((b) => {
      b.classList.remove("busy");
      b.removeAttribute("aria-busy");
      if (b.dataset.label !== undefined) b.innerHTML = b.dataset.label;
    });
  });

  // Settings: while a Linear sign-in waits in the browser, reload once it finishes.
  if (document.getElementById("signin-wait")) {
    const wait = async () => {
      try {
        const s = await (await fetch("/state", { cache: "no-store" })).json();
        if (!s.signingIn) return location.reload();
      } catch {}
      setTimeout(wait, 2000);
    };
    setTimeout(wait, 2000);
  }

  const live = document.getElementById("live");
  if (!live) return;
  let version = live.dataset.version, stale = false;
  const modalOpen = () => location.hash.startsWith("#m-");
  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  const render = (s) => {
    live.replaceChildren();
    const p = s.progress;
    if (!s.activity && !p.total) return;
    const box = el("div", "progress"), row = el("div", "row"), title = el("strong");
    row.append(el("div", "spinner"));
    title.textContent = p.total ? "Triaging " + (p.current || "") : s.activity;
    row.append(title);
    if (p.total) {
      const m = el("span", "muted");
      m.textContent = Math.min(p.done + 1, p.total) + " of " + p.total + " · picking repo, branch and writing the explainer";
      row.append(m);
    }
    box.append(row);
    if (p.total) {
      const bar = el("div", "bar"), fill = el("div");
      fill.style.width = Math.max(4, Math.round((p.done / p.total) * 100)) + "%";
      bar.append(fill);
      box.append(bar);
    }
    live.append(box);
  };
  // Live log panel: open/closed is remembered per browser; approving a ticket opens it.
  const logs = document.getElementById("logs"), body = document.getElementById("logbody"), toggle = document.getElementById("logtoggle");
  let lastId = Number(logs?.dataset.last || 0);
  const setOpen = (open) => {
    document.body.classList.toggle("logs-open", open);
    toggle?.setAttribute("aria-expanded", String(open));
    try { localStorage.setItem("logsOpen", open ? "1" : "0"); } catch {}
  };
  let saved = null;
  try { saved = localStorage.getItem("logsOpen"); } catch {}
  setOpen(new URLSearchParams(location.search).has("logs") || saved === "1");
  toggle?.addEventListener("click", () => setOpen(!document.body.classList.contains("logs-open")));
  document.getElementById("logclose")?.addEventListener("click", () => setOpen(false));
  if (body) body.scrollTop = body.scrollHeight;
  const pullLogs = async () => {
    if (!body) return;
    const items = await (await fetch("/events?since=" + lastId, { cache: "no-store" })).json();
    if (!items.length) return;
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
    for (const e of items) {
      const line = el("div", "ln " + e.level), ts = el("span", "ts");
      ts.textContent = new Date(e.at).toTimeString().slice(0, 8);
      line.append(ts, document.createTextNode(e.msg));
      body.append(line);
      lastId = e.id;
    }
    while (body.childElementCount > 400) body.firstElementChild.remove();
    if (atBottom) body.scrollTop = body.scrollHeight;
  };

  const tick = async () => {
    let busy = false;
    try {
      const s = await (await fetch("/state", { cache: "no-store" })).json();
      busy = !!s.activity || s.progress.total > 0;
      render(s);
      for (const [id, msg] of Object.entries(s.launching || {})) {
        const node = document.querySelector('[data-step="' + CSS.escape(id) + '"]');
        if (node) node.textContent = msg;
      }
      await pullLogs();
      badge(s.awaiting);
      // New tickets or statuses, or the app restarted (e.g. after an update): reload once no modal is open.
      if (s.version !== version || (live.dataset.boot && s.boot !== live.dataset.boot)) { if (modalOpen()) stale = true; else return location.reload(); }
    } catch {}
    setTimeout(tick, busy ? 1500 : 10000);
  };
  // Installed as a PWA: the Dock icon shows how many tickets await approval.
  const badge = (n) => { try { n > 0 ? navigator.setAppBadge?.(n) : navigator.clearAppBadge?.(); } catch {} };
  badge(Number(live.dataset.awaiting || 0));
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  addEventListener("hashchange", () => { if (stale && !modalOpen()) location.reload(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && modalOpen()) location.hash = ""; });
  setTimeout(tick, 1500);
})();
