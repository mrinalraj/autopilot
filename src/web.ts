import { randomBytes, timingSafeEqual } from "node:crypto";
import { LOG_PATH } from "./config";
import { ICONS, MANIFEST, offlinePage, SERVICE_WORKER } from "./pwa";
import { Autopilot } from "./autopilot";
import type { IssueRow, IssueStatus } from "./db";
import { log } from "./log";
import { Store } from "./db";
import { atRisk, isSettled, overallStage, stage, type RepoWork, type WorkStage } from "./work";
import type { Updater } from "./updater";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `
:root { --bg:#f4f4f1; --panel:#ffffff; --raised:#ffffff; --inset:#f7f7f4; --text:#1b1b19; --muted:#6d6d67; --faint:#a3a39c;
  --border:#e4e4de; --border-strong:#d2d2ca; --accent:#4c5fd5; --accent-2:#7b5cd6; --accent-soft:#eef0fc;
  --ok:#2f9e44; --ok-soft:#e8f6ea; --warn:#c25e00; --warn-soft:#fff3e0; --bad:#d6336c; --bad-soft:#fdecf2; --code:#efefea;
  --shadow:0 1px 2px rgba(20,20,10,.06), 0 1px 1px rgba(20,20,10,.04); --shadow-hover:0 8px 24px rgba(20,20,10,.10);
  --backdrop:rgba(18,18,24,.55); }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg:#0f0f0e; --panel:#191917; --raised:#1f1f1d; --inset:#141413; --text:#ededea; --muted:#9b9b94; --faint:#66665f;
  --border:#2a2a27; --border-strong:#3a3a36; --accent:#8b9cff; --accent-2:#b197fc; --accent-soft:#1e2340;
  --ok:#69db7c; --ok-soft:#14261a; --warn:#ffa94d; --warn-soft:#2d2210; --bad:#ff8fab; --bad-soft:#331720; --code:#262624;
  --shadow:none; --shadow-hover:0 10px 30px rgba(0,0,0,.45); --backdrop:rgba(0,0,0,.72); } }
* { box-sizing:border-box; }
html { scroll-behavior:smooth; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif; -webkit-font-smoothing:antialiased; }
body:has(.modal:target) { overflow:hidden; }
main { max-width:1240px; margin:0 auto; padding:28px 16px 72px; }
a { color:var(--accent); text-decoration:none; } a:hover { text-decoration:underline; }
h1 { font-size:20px; margin:0; letter-spacing:-.01em; } h3 { font-size:13px; margin:0 0 10px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
.muted { color:var(--muted); } .small { font-size:12px; }

/* Header */
.top { display:flex; justify-content:space-between; align-items:center; gap:16px; flex-wrap:wrap; }
.brand { display:flex; align-items:center; gap:12px; }
.logo { width:36px; height:36px; border-radius:10px; background:linear-gradient(135deg, var(--accent), var(--accent-2));
  display:grid; place-items:center; color:#fff; font-weight:800; font-size:17px; box-shadow:0 4px 12px rgba(76,95,213,.3); }
.stats { display:flex; gap:8px; flex-wrap:wrap; margin-top:20px; }
.stat { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:8px 14px; min-width:110px; }
.stat b { display:block; font-size:20px; line-height:1.2; }
.stat span { font-size:11.5px; color:var(--muted); text-transform:uppercase; letter-spacing:.06em; }

/* Section headings */
.section { display:flex; align-items:baseline; gap:8px; margin:32px 0 12px; }
.section h2 { font-size:15px; margin:0; letter-spacing:-.005em; }
.count { font-size:12px; color:var(--muted); background:var(--panel); border:1px solid var(--border); border-radius:99px; padding:0 8px; }

/* Cards */
.grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(min(350px, 100%), 1fr)); gap:14px; }
.card { position:relative; background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:16px 16px 14px 20px;
  display:flex; flex-direction:column; gap:10px; box-shadow:var(--shadow); transition:transform .15s, box-shadow .15s, border-color .15s; overflow:hidden; }
.card::before { content:""; position:absolute; left:0; top:0; bottom:0; width:4px; background:var(--stripe, var(--border-strong)); }
.card.s-pending { --stripe:var(--accent); } .card.s-failed { --stripe:var(--bad); } .card.s-approved { --stripe:var(--warn); } .card.s-running { --stripe:var(--ok); }
.card:hover { transform:translateY(-2px); box-shadow:var(--shadow-hover); border-color:var(--border-strong); }
.card .title { color:var(--text); font-weight:650; font-size:15px; line-height:1.35; }
/* Stretched link: the whole card opens the modal; buttons sit above it. */
.card .title::after { content:""; position:absolute; inset:0; z-index:0; }
.card .title:hover { text-decoration:none; }
.card .actions, .card .alert { position:relative; z-index:1; }
.card .summary { color:var(--muted); display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
.card .actions { display:flex; gap:8px; align-items:center; margin-top:auto; padding-top:4px; }
.card .actions form { margin:0; }
.cardhead { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.ident { font:600 12px ui-monospace, SFMono-Regular, Menlo, monospace; color:var(--muted); }
.pills { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
.pill { font-size:12px; padding:2px 9px; border-radius:99px; background:var(--inset); border:1px solid var(--border); color:var(--text); white-space:nowrap; }
.pill.mono { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11.5px; color:var(--muted); max-width:100%; overflow:hidden; text-overflow:ellipsis; }
.conf { display:flex; align-items:center; gap:6px; font-size:11.5px; color:var(--muted); margin-left:auto; }
.meter { width:46px; height:5px; border-radius:99px; background:var(--border); overflow:hidden; }
.meter > i { display:block; height:100%; background:var(--ok); }
.conf.low { color:var(--warn); font-weight:600; } .conf.low .meter > i { background:var(--warn); }

/* Badges & buttons */
.badge { font-size:10.5px; font-weight:700; padding:2px 8px; border-radius:99px; text-transform:uppercase; letter-spacing:.05em; white-space:nowrap; }
.b-pending { color:var(--accent); background:var(--accent-soft); } .b-failed { color:var(--bad); background:var(--bad-soft); }
.b-running { color:var(--ok); background:var(--ok-soft); } .b-approved { color:var(--warn); background:var(--warn-soft); }
.b-rejected { color:var(--muted); background:var(--inset); border:1px solid var(--border); }
button, .btn { font:inherit; font-weight:600; font-size:13px; padding:7px 14px; border-radius:8px; border:1px solid var(--border-strong); cursor:pointer;
  background:var(--panel); color:var(--text); display:inline-flex; align-items:center; gap:6px; transition:filter .12s, background .12s; }
button:hover, .btn:hover { filter:brightness(1.08); text-decoration:none; }
button:disabled { opacity:.5; cursor:default; filter:none; }
.primary { background:linear-gradient(135deg, var(--accent), var(--accent-2)); border-color:transparent; color:#fff; }
.ghost-danger { color:var(--bad); background:transparent; }
.ghost-danger:hover { background:var(--bad-soft); filter:none; }

/* Work stages */
.st-working { color:var(--warn); background:var(--warn-soft); } .st-committed { color:var(--accent); background:var(--accent-soft); }
.st-draft { color:var(--muted); background:var(--inset); border:1px solid var(--border); } .st-pr-open { color:var(--ok); background:var(--ok-soft); }
.st-merged { color:var(--accent-2); background:var(--accent-soft); } .st-pr-closed { color:var(--muted); background:var(--inset); border:1px solid var(--border); }
.st-missing { color:var(--bad); background:var(--bad-soft); }
.card.w-working { --stripe:var(--warn); } .card.w-committed { --stripe:var(--accent); } .card.w-pr-open { --stripe:var(--ok); } .card.w-draft { --stripe:var(--faint); }
.workline { display:flex; gap:14px; flex-wrap:wrap; font-size:12.5px; color:var(--muted); }
.workline b { color:var(--text); font-weight:600; }
.facts { display:grid; grid-template-columns:auto 1fr; gap:6px 14px; font-size:13px; margin:0; }
.facts dt { color:var(--muted); } .facts dd { margin:0; }
.facts + .facts { margin-top:12px; padding-top:12px; border-top:1px solid var(--border); }
.pill.extra { border-style:dashed; }
.checks { display:flex; flex-direction:column; gap:6px; }
.checks label { display:flex; gap:8px; align-items:flex-start; font-weight:500; margin:0; cursor:pointer; }
.checks input { margin-top:3px; accent-color:var(--accent); }

/* Progress */
.progress { background:var(--accent-soft); border:1px solid var(--border); border-radius:12px; padding:12px 16px; margin-top:18px; }
.bar { height:6px; border-radius:99px; background:var(--border); overflow:hidden; margin-top:10px; }
.bar > div { height:100%; background:linear-gradient(90deg, var(--accent), var(--accent-2)); }
.spinner { width:15px; height:15px; border:2px solid var(--border-strong); border-top-color:var(--accent); border-radius:50%; animation:spin .8s linear infinite; flex:none; }
@keyframes spin { to { transform:rotate(360deg); } }
.row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }

/* Collapsible lists, update banner, danger zone */
details.fold { margin-top:28px; }
details.fold > summary { cursor:pointer; list-style:none; display:flex; align-items:baseline; gap:8px; font-weight:650; font-size:15px; }
details.fold > summary::-webkit-details-marker { display:none; }
details.fold > summary::before { content:"▸"; color:var(--muted); font-size:12px; transition:transform .15s; display:inline-block; }
details.fold[open] > summary::before { transform:rotate(90deg); }
details.fold > .recent { margin-top:12px; }
.update { display:flex; align-items:center; gap:12px; flex-wrap:wrap; background:var(--ok-soft); border:1px solid var(--border); border-radius:12px; padding:10px 14px; margin-top:16px; }
.update form { margin:0; } .update .grow { flex:1; min-width:200px; }
.notice { border-radius:10px; padding:8px 12px; background:var(--ok-soft); color:var(--ok); font-size:13px; margin-top:14px; }
details.danger { border:1px solid var(--border); border-radius:12px; padding:12px 16px; background:var(--panel); margin-bottom:14px; }
details.danger > summary { cursor:pointer; color:var(--bad); font-weight:600; font-size:13px; }
details.danger ul { margin:8px 0; }
.check { display:flex; gap:8px; align-items:center; font-size:13px; margin:10px 0; }

/* Misc */
.alert { border-radius:10px; padding:8px 12px; background:var(--bad-soft); color:var(--bad); white-space:pre-wrap; word-break:break-word; font-size:13px; }
.empty { color:var(--muted); background:var(--panel); border:1px dashed var(--border-strong); border-radius:14px; padding:36px; text-align:center; }
.empty b { display:block; color:var(--text); font-size:15px; margin-bottom:4px; }
.recent { background:var(--panel); border:1px solid var(--border); border-radius:14px; overflow:hidden; }
.recent a.item { display:flex; gap:12px; align-items:center; padding:10px 16px; color:var(--text); border-top:1px solid var(--border); }
.recent a.item:first-child { border-top:0; }
.recent a.item:hover { background:var(--inset); text-decoration:none; }
.recent .t { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
pre { background:var(--inset); border:1px solid var(--border); border-radius:10px; padding:12px 14px; white-space:pre-wrap; word-break:break-word;
  font:12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; margin:0 0 12px; }
code { background:var(--code); padding:1px 6px; border-radius:5px; font-size:12.5px; word-break:break-all; }
label, .grouplabel { display:block; font-weight:600; font-size:13px; margin:14px 0 6px; }
select, input[type=text] { width:100%; padding:9px 11px; border-radius:8px; border:1px solid var(--border-strong); background:var(--inset); color:var(--text); font:inherit; }
select:focus, input[type=text]:focus { outline:2px solid var(--accent); outline-offset:1px; }
.lowconf { border:1px solid var(--warn); background:var(--warn-soft); border-radius:10px; padding:12px; }
.warnnote { color:var(--warn); font-size:12.5px; margin:0 0 4px; }
ul { margin:0; padding-left:18px; } li { margin:2px 0; }

/* CSS-only modal: opened by #m-<identifier> in the URL, closed by linking to # (the page allows no scripts). */
.modal { display:none; position:fixed; inset:0; z-index:50; }
.modal:target { display:block; animation:fade .15s ease-out; }
.modal .backdrop { position:absolute; inset:0; background:var(--backdrop); backdrop-filter:blur(8px) saturate(.7); -webkit-backdrop-filter:blur(8px) saturate(.7); cursor:default; }
.modal .panel { position:relative; margin:4vh auto; width:min(1120px, calc(100% - 32px)); max-height:92vh; overflow:auto;
  background:var(--raised); border:1px solid var(--border-strong); border-radius:18px; box-shadow:0 30px 80px rgba(0,0,0,.45); animation:rise .18s ease-out; }
.modal .head { position:sticky; top:0; z-index:2; background:var(--raised); border-bottom:1px solid var(--border); padding:18px 22px 14px;
  display:flex; gap:14px; align-items:flex-start; }
.modal .head .grow { flex:1; min-width:0; }
.modal .head h1 { font-size:18px; line-height:1.3; margin-top:6px; }
.modal .close { flex:none; width:32px; height:32px; border-radius:8px; display:grid; place-items:center; font-size:20px; color:var(--muted); border:1px solid var(--border); }
.modal .close:hover { color:var(--text); background:var(--inset); text-decoration:none; }
.modal .body { padding:18px 22px 22px; }
@keyframes fade { from { opacity:0; } to { opacity:1; } }
@keyframes rise { from { transform:translateY(10px) scale(.99); opacity:.6; } to { transform:none; opacity:1; } }
.cols { display:grid; grid-template-columns:minmax(0,1.25fr) minmax(0,1fr); gap:16px; }
.box { background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:16px; margin-bottom:14px; }
.actionsbar { display:flex; gap:8px; margin-top:18px; }
@media (max-width: 860px) { .cols { grid-template-columns:minmax(0,1fr); } .modal .panel { margin:0; width:100%; max-height:100vh; border-radius:0; } }
`;

/**
 * Keeps the list live without full-page refreshes (which would close an open modal): polls
 * /state, redraws the progress banner, and reloads only when tickets changed and no modal is open.
 * Runs under a per-response CSP nonce, so nothing inside ticket text can execute.
 */
const LIVE_SCRIPT = `(() => {
  const live = document.getElementById("live");
  if (!live) return;
  let version = live.dataset.version, stale = false;
  const modalOpen = () => location.hash.startsWith("#m-");
  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  const render = (s) => {
    live.replaceChildren();
    const p = s.progress;
    if (!s.polling && !p.total) return;
    const box = el("div", "progress"), row = el("div", "row"), title = el("strong");
    row.append(el("div", "spinner"));
    title.textContent = p.total ? "Triaging " + (p.current || "") : "Checking Linear for new tickets…";
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
  const tick = async () => {
    let busy = false;
    try {
      const s = await (await fetch("/state", { cache: "no-store" })).json();
      busy = s.polling || s.progress.total > 0;
      render(s);
      badge(s.awaiting);
      if (s.version !== version) { if (modalOpen()) stale = true; else return location.reload(); }
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
})();`;

function page(title: string, body: string): Response {
  const nonce = randomBytes(16).toString("base64");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icons/icon.svg" type="image/svg+xml"><link rel="icon" href="/icons/favicon-32.png" sizes="32x32">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-title" content="Autopilot">
<meta name="theme-color" content="#f4f4f1" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0f0f0e" media="(prefers-color-scheme: dark)">
<style>${STYLE}</style></head>
<body><main>${body}</main><script nonce="${nonce}">${LIVE_SCRIPT}</script></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Ticket text is untrusted: only our nonce'd script runs, no external loads, forms post only here.
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self'; manifest-src 'self'; worker-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
      "X-Content-Type-Options": "nosniff",
      // "no-referrer" makes browsers send `Origin: null` on our own form posts.
      "Referrer-Policy": "same-origin",
    },
  });
}

/** PWA routes (an allowlist; nothing else on disk is reachable). Files are embedded when compiled. */
function serveStatic(path: string, port: number): Response | null {
  const plain = { "X-Content-Type-Options": "nosniff" };
  if (path === "/manifest.webmanifest") {
    return Response.json(MANIFEST, { headers: { ...plain, "Content-Type": "application/manifest+json", "Cache-Control": "no-cache" } });
  }
  if (path === "/sw.js") {
    // The worker's own CSP governs its fetches, so it needs 'self' rather than the page's 'none'.
    return new Response(SERVICE_WORKER, {
      headers: { ...plain, "Content-Type": "text/javascript", "Cache-Control": "no-cache", "Content-Security-Policy": "default-src 'self'" },
    });
  }
  if (path === "/offline.html") {
    return new Response(offlinePage(port, LOG_PATH), {
      headers: { ...plain, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" },
    });
  }
  const icon = path.startsWith("/icons/") ? ICONS[path.slice("/icons/".length)] : undefined;
  if (icon) {
    return new Response(Bun.file(icon), {
      headers: { ...plain, "Content-Type": icon.endsWith(".svg") ? "image/svg+xml" : "image/png", "Cache-Control": "max-age=86400" },
    });
  }
  return null;
}

const badge = (s: IssueStatus, error?: string | null) => {
  const label = s === "approved" ? "launching" : s === "rejected" && error?.startsWith("Dismissed:") ? "dismissed" : s;
  return `<span class="badge b-${s}">${label}</span>`;
};
export const modalId = (identifier: string) => `m-${identifier.replace(/[^A-Za-z0-9-]/g, "")}`;
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

const STAGE_LABEL: Record<WorkStage, string> = {
  working: "in progress", committed: "committed", draft: "draft PR", "pr-open": "PR open",
  merged: "merged", "pr-closed": "PR closed", missing: "worktree gone",
};
const stageBadge = (st: WorkStage) => `<span class="badge st-${st}">${STAGE_LABEL[st]}</span>`;

const prState = (pr: NonNullable<RepoWork["pr"]>) => (pr.state === "OPEN" ? (pr.isDraft ? "draft" : "open") : pr.state.toLowerCase());

/** Progress facts for a launched item: one line, or one line per repo when it spans several. */
function workSummary(list: RepoWork[] | null): string {
  if (!list?.length) return `<div class="workline">Checking the worktree…</div>`;
  const multi = list.length > 1;
  const lines = list.map((w) => {
    const parts: string[] = [];
    if (multi) parts.push(`<span><b>${esc(w.repo)}</b></span>`);
    if (w.pr) parts.push(`<span><b>PR #${w.pr.number}</b> ${esc(prState(w.pr))}</span>`);
    if (w.missing) parts.push(`<span>worktree removed</span>`);
    else if (w.commitsAhead !== null) parts.push(`<span><b>${w.commitsAhead}</b> commit${w.commitsAhead === 1 ? "" : "s"}</span>`);
    if (w.dirtyFiles) parts.push(`<span><b>${w.dirtyFiles}</b> uncommitted</span>`);
    if (w.lastCommitAt) parts.push(`<span>last commit ${esc(ago(w.lastCommitAt))}</span>`);
    return `<div class="workline">${parts.join("")}</div>`;
  });
  return `${lines.join("")}<div class="workline"><span>checked ${esc(ago(list[0].checkedAt))}</span></div>`;
}

const repoPills = (r: IssueRow) =>
  `<span class="pill">${esc(r.repo)}</span>${Store.extras(r).map((e) => `<span class="pill extra" title="${esc(e.reason)}">+ ${esc(e.repo)}</span>`).join("")}`;

export function startWeb(ap: Autopilot, updater?: Updater) {
  const port = ap.cfg.port;
  const csrf = randomBytes(24).toString("hex");
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  const tokenField = `<input type="hidden" name="csrf" value="${csrf}">`;

  const validToken = (t: unknown) =>
    typeof t === "string" && t.length === csrf.length && timingSafeEqual(Buffer.from(t), Buffer.from(csrf));

  const redirect = (to: string) => new Response(null, { status: 303, headers: { Location: to } });

  const actionBase = (r: IssueRow) => `/issues/${encodeURIComponent(r.identifier)}`;
  const isLow = (r: IssueRow) => r.confidence < ap.cfg.lowConfidenceThreshold;
  const actionable = (r: IssueRow) => r.status === "pending" || r.status === "failed";

  function confidence(r: IssueRow) {
    return `<span class="conf${isLow(r) ? " low" : ""}" title="Repo confidence">${isLow(r) ? "low " : ""}${Math.round(r.confidence * 100)}%
      <span class="meter"><i style="width:${Math.round(r.confidence * 100)}%"></i></span></span>`;
  }

  function card(r: IssueRow) {
    const ex = Autopilot.explainer(r);
    const id = modalId(r.identifier);
    // Low-confidence items are approved from the modal, where the repo can be changed.
    const approve = isLow(r)
      ? `<a class="btn primary" href="#${id}">Review</a>`
      : `<form method="post" action="${actionBase(r)}/approve">${tokenField}
           <input type="hidden" name="repo" value="${esc(r.repo)}"><input type="hidden" name="branch" value="${esc(r.branch)}">
           ${Store.extras(r).map((e) => `<input type="hidden" name="extra" value="${esc(e.repo)}">`).join("")}
           <button class="primary">${r.status === "failed" ? "Retry launch" : "Approve"}</button></form>`;
    const actions = actionable(r)
      ? `<div class="actions">${approve}<form method="post" action="${actionBase(r)}/reject">${tokenField}<button class="ghost-danger">Reject</button></form></div>`
      : "";
    return `<article class="card s-${r.status}">
      <div class="cardhead">${badge(r.status, r.error)}<span class="ident">${esc(r.identifier)}</span>${confidence(r)}</div>
      <a class="title" href="#${id}">${esc(r.title)}</a>
      <div class="pills">${repoPills(r)}<span class="pill">size ${esc(ex.size)}</span><span class="pill mono">${esc(r.branch)}</span></div>
      <div class="summary">${esc(ex.summary)}</div>
      ${r.status === "failed" && r.error ? `<div class="alert">${esc(r.error)}</div>` : ""}
      ${actions}
    </article>`;
  }

  const worktreeLink = (r: IssueRow) => (r.worktree_id ? `supacode://worktree/${r.worktree_id}` : null);

  function workCard(r: IssueRow) {
    const list = Autopilot.work(r);
    const st = list ? overallStage(list) : "working";
    const wt = worktreeLink(r);
    const multi = (list?.length ?? 0) > 1;
    const prs = (list ?? []).filter((w) => w.pr);
    return `<article class="card w-${st}">
      <div class="cardhead">${stageBadge(st)}<span class="ident">${esc(r.identifier)}</span></div>
      <a class="title" href="#${modalId(r.identifier)}">${esc(r.title)}</a>
      <div class="pills">${repoPills(r)}<span class="pill mono">${esc(r.branch)}</span></div>
      ${workSummary(list)}
      <div class="actions">${prs.map((w) => `<a class="btn primary" href="${esc(w.pr!.url)}" target="_blank" rel="noreferrer">${multi ? `${esc(w.repo)} ` : ""}PR #${w.pr!.number} ↗</a>`).join("")}
        ${wt ? `<a class="btn" href="${esc(wt)}">Open worktree</a>` : ""}</div>
    </article>`;
  }

  function recentItem(r: IssueRow) {
    const list = r.status === "running" ? Autopilot.work(r) : null;
    if (list) {
      const prs = list.filter((w) => w.pr).map((w) => `PR #${w.pr!.number}`).join(", ");
      return `<a class="item" href="#${modalId(r.identifier)}">${stageBadge(overallStage(list))}<span class="ident">${esc(r.identifier)}</span>
        <span class="t">${esc(r.title)}</span><span class="muted small">${prs ? `${esc(prs)} · ` : ""}${esc([r.repo, ...Store.extras(r).map((e) => e.repo)].join(" + "))} · ${esc(time(r.updated_at))}</span></a>`;
    }
    return `<a class="item" href="#${modalId(r.identifier)}">${badge(r.status, r.error)}<span class="ident">${esc(r.identifier)}</span>
      <span class="t">${esc(r.title)}</span>
      <span class="muted small">${r.status === "rejected" && r.error ? `${esc(r.error.replace(/^Dismissed: /, ""))} · ` : ""}${esc(r.repo)} · ${esc(time(r.updated_at))}</span></a>`;
  }

  function progressBox(r: IssueRow) {
    const list = Autopilot.work(r);
    if (!list?.length) return `<div class="box"><h3>Progress</h3><p class="muted" style="margin:0">Not checked yet.</p></div>`;
    const repoFacts = (w: RepoWork) => {
      const wt = `supacode://worktree/${encodeURIComponent(w.worktreePath + "/")}`;
      return `<dl class="facts">
        <dt>Repo</dt><dd><strong>${esc(w.repo)}</strong> ${stageBadge(stage(w))}</dd>
        <dt>Pull request</dt><dd>${w.pr ? `<a href="${esc(w.pr.url)}" target="_blank" rel="noreferrer">#${w.pr.number} ${esc(w.pr.title)}</a> · ${esc(prState(w.pr))}` : "none yet"}</dd>
        <dt>Commits</dt><dd>${w.commitsAhead ?? "?"} ahead of base${w.lastCommitAt ? ` · last ${esc(ago(w.lastCommitAt))}` : ""}</dd>
        <dt>Uncommitted</dt><dd>${w.dirtyFiles ?? "?"} file${w.dirtyFiles === 1 ? "" : "s"}</dd>
        <dt>Worktree</dt><dd>${w.missing ? "removed" : `<a href="${esc(wt)}">Open in Supacode</a>`} <code>${esc(w.worktreePath)}</code></dd>
      </dl>${w.error ? `<div class="alert" style="margin-top:8px">${esc(w.error)}</div>` : ""}`;
    };
    return `<div class="box"><h3>Progress · checked ${esc(ago(list[0].checkedAt))}</h3>
      <div class="cardhead" style="margin-bottom:10px">${stageBadge(overallStage(list))}</div>
      ${list.map(repoFacts).join("")}</div>`;
  }

  /** "Delete worktrees…" for launched tickets, listing what would be lost from the latest check. */
  function deleteBox(r: IssueRow) {
    if (r.status !== "running" && r.status !== "failed") return "";
    const wts = Autopilot.worktrees(r);
    const work = Autopilot.work(r) ?? [];
    const live = wts.filter((w) => !work.find((x) => x.repo === w.repo)?.missing);
    if (!live.length) return "";
    const risks = work.flatMap((w) => atRisk(w).map((x) => `${w.repo}: ${x}`));
    return `<details class="danger"><summary>Delete worktree${live.length === 1 ? "" : "s"}…</summary>
      <p class="small muted" style="margin:8px 0 4px">Removes ${live.length === 1 ? "this worktree" : "these worktrees"} through Supacode, which also closes the Claude session in ${live.length === 1 ? "it" : "them"}. The branch, commits already pushed, and any PR stay; PR tracking carries on.</p>
      <ul class="small">${live.map((w) => `<li><code>${esc(decodeURIComponent(w.worktreeId).replace(/\/$/, ""))}</code></li>`).join("")}</ul>
      ${risks.length ? `<div class="alert">At the last check this would lose: ${esc(risks.join(", "))}. It's re-checked before deleting.</div>` : ""}
      <form method="post" action="${actionBase(r)}/delete-worktrees">${tokenField}
        <label class="check"><input type="checkbox" name="force" value="1"> Delete anyway, even with uncommitted or unpushed work</label>
        <button class="ghost-danger" type="submit">Delete worktree${live.length === 1 ? "" : "s"}</button></form>
    </details>`;
  }

  function updateBanner(): string {
    if (!updater) return "";
    const u = updater.info;
    if (updater.status === "updating") return `<div class="update"><div class="spinner"></div><strong>Updating to ${esc(u?.latest)}…</strong></div>`;
    if (updater.status === "restarting") return `<div class="update"><div class="spinner"></div><strong>Restarting into ${esc(u?.latest)}…</strong></div>`;
    const err = updater.status === "error" && updater.error ? `<div class="alert" style="margin-top:14px">Update: ${esc(updater.error)}</div>` : "";
    if (!u?.available) return err;
    const action =
      u.kind === "source"
        ? `<span class="small muted">Running from source: <code>git pull</code> and restart</span>`
        : `<form method="post" action="/update">${tokenField}<button class="primary">${u.kind === "homebrew" ? "Update via Homebrew" : "Update now"}</button></form>`;
    return `<div class="update"><div class="grow"><strong>Update available: ${esc(u.latest)}</strong>
        <span class="muted small"> · you have ${esc(u.current)} · <a href="${esc(u.url)}" target="_blank" rel="noreferrer">release notes ↗</a></span></div>
        ${action}</div>${err}`;
  }

  function modal(r: IssueRow) {
    const ex = Autopilot.explainer(r);
    const t = Autopilot.ticket(r);
    const low = isLow(r);
    const options = ap
      .catalog()
      .map((c) => `<option value="${esc(c.name)}"${c.name === r.repo ? " selected" : ""}>${esc(c.name)} — ${esc(c.path)}</option>`)
      .join("");

    const form = actionable(r)
      ? `<form method="post" action="${actionBase(r)}/approve">${tokenField}
          <div class="${low ? "lowconf" : ""}">
            ${low ? `<p class="warnnote"><strong>Low confidence (${Math.round(r.confidence * 100)}%).</strong> Check the repo before approving.</p>` : ""}
            <label for="repo-${esc(r.identifier)}" style="margin-top:${low ? "8px" : "0"}">Repo</label><select id="repo-${esc(r.identifier)}" name="repo">${options}</select>
            <div class="muted small" style="margin-top:6px">${esc(r.resolve_reason)}</div>
          </div>
          <div class="grouplabel" id="also-${esc(r.identifier)}">Also change</div>
          <div class="checks" role="group" aria-labelledby="also-${esc(r.identifier)}">${ap
            .catalog()
            .filter((c) => c.name !== r.repo)
            .map((c) => {
              const e = Store.extras(r).find((x) => x.repo === c.name);
              return `<label><input type="checkbox" name="extra" value="${esc(c.name)}"${e ? " checked" : ""}>
                <span>${esc(c.name)}${e?.reason ? ` <span class="muted small">— ${esc(e.reason)}</span>` : ""}</span></label>`;
            })
            .join("")}</div>
          <div class="muted small" style="margin-top:6px">Each repo gets its own worktree on the same branch; the session starts in the primary repo with the others added.</div>
          <label for="branch-${esc(r.identifier)}">Branch</label>
          <input type="text" id="branch-${esc(r.identifier)}" name="branch" value="${esc(r.branch)}" autocomplete="off" spellcheck="false">
          <div class="muted small" style="margin-top:6px">2–5 word kebab slug ending in <code>-${esc(r.identifier.toLowerCase())}</code>. Invalid names are repaired automatically.</div>
          <div class="actionsbar"><button class="primary" type="submit">${r.status === "failed" ? "Retry launch" : "Approve &amp; launch"}</button>
            <button class="ghost-danger" type="submit" formaction="${actionBase(r)}/reject">Reject</button></div>
        </form>`
      : `<p style="margin:0"><strong>Repo:</strong> ${esc(r.repo)} <span class="muted">(${esc(r.repo_path)})</span>
          ${Store.extras(r).map((e) => `<br><strong>Also:</strong> ${esc(e.repo)} <span class="muted">(${esc(e.repo_path)})</span>`).join("")}
          <br><strong>Branch:</strong> <code>${esc(r.branch)}</code>
          ${r.worktree_id ? `<br><strong>Worktree:</strong> <code>${esc(decodeURIComponent(r.worktree_id))}</code>` : ""}</p>
         ${r.error ? `<div class="alert" style="margin-top:10px">${esc(r.error)}</div>` : ""}`;

    const comments = t.comments.length
      ? t.comments.map((c) => `<div class="muted small" style="margin-bottom:4px"><strong>${esc(c.author)}</strong> · ${esc(new Date(c.createdAt).toLocaleString())}</div><pre>${esc(c.body)}</pre>`).join("")
      : `<p class="muted" style="margin:0">No comments.</p>`;

    return `<div class="modal" id="${modalId(r.identifier)}" role="dialog" aria-modal="true" aria-label="${esc(r.identifier)}">
      <a class="backdrop" href="#" aria-label="Close"></a>
      <div class="panel">
        <div class="head"><div class="grow">
            <div class="cardhead">${badge(r.status, r.error)}<span class="ident">${esc(r.identifier)}</span>
              <span class="muted small">${esc(t.state)} · ${esc(t.team)}${t.project ? ` · ${esc(t.project)}` : ""}${t.labels.length ? ` · ${esc(t.labels.join(", "))}` : ""}</span></div>
            <h1>${esc(r.title)}</h1>
            <div class="small" style="margin-top:4px"><a href="${esc(r.url)}" rel="noreferrer" target="_blank">Open in Linear ↗</a></div>
          </div><a class="close" href="#" aria-label="Close">×</a></div>
        <div class="body">
          ${r.status === "failed" && r.error ? `<div class="alert" style="margin-bottom:14px"><strong>Launch failed.</strong> ${esc(r.error)}</div>` : ""}
          <div class="cols">
            <div><div class="box"><h3>Ticket description · verbatim, untrusted</h3><pre>${esc(t.description ?? "(empty)")}</pre></div>
              <div class="box"><h3>Comments · verbatim</h3>${comments}</div></div>
            <div>
              <div class="box"><h3>Explainer · size ${esc(ex.size)}</h3><p style="margin-top:0">${esc(ex.summary)}</p>
                <p><strong>Approach.</strong> ${esc(ex.approach)}</p>
                <strong class="small">Likely areas</strong><ul class="small">${ex.likely_areas.map((a) => `<li><code>${esc(a)}</code></li>`).join("")}</ul></div>
              ${r.status === "running" ? progressBox(r) : ""}
              ${deleteBox(r)}
              <div class="box"><h3>Launch</h3>${form}
                <p class="small muted" style="margin:14px 0 0">Brief for the session: <code>${esc(r.brief_path)}</code></p></div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }

  function progressBanner(): { html: string } {
    const p = ap.progress;
    if (p.total > 0) {
      const pct = Math.round((p.done / p.total) * 100);
      return {
        html: `<div class="progress"><div class="row"><div class="spinner"></div>
          <strong>Triaging ${esc(p.current ?? "")}</strong><span class="muted">${Math.min(p.done + 1, p.total)} of ${p.total} · picking repo, branch and writing the explainer</span></div>
          <div class="bar"><div style="width:${Math.max(pct, 4)}%"></div></div></div>`,
      };
    }
    if (ap.polling) {
      return { html: `<div class="progress"><div class="row"><div class="spinner"></div><strong>Checking Linear for new tickets…</strong></div></div>` };
    }
    return { html: "" };
  }

  /** Changes whenever the set of tickets or their statuses change. */
  function version(): string {
    const v = ap.store.db
      .query<{ n: number; t: string | null }, []>("SELECT COUNT(*) AS n, MAX(updated_at) AS t FROM issues")
      .get();
    return `${v?.n ?? 0}|${v?.t ?? ""}|${ap.lastPollError ?? ""}|${updater?.status ?? ""}|${updater?.info?.latest ?? ""}`;
  }

  function indexPage(error?: string, notice?: string) {
    const queue = ap.store.listByStatus(["pending", "failed"]);
    const launching = ap.store.listByStatus(["approved"]);
    const running = ap.store.listByStatus(["running"], 200);
    const inProgress = running.filter((r) => !isSettled(Autopilot.work(r)));
    const completed = running.filter((r) => isSettled(Autopilot.work(r)));
    const rejected = ap.store.listByStatus(["rejected"], 100);
    const prsOpen = inProgress.flatMap((r) => Autopilot.work(r) ?? []).filter((w) => w.pr?.state === "OPEN").length;
    const banner = progressBanner();
    const next = ap.lastPollAt ? time(new Date(Date.parse(ap.lastPollAt) + ap.cfg.pollIntervalSeconds * 1000).toISOString()) : null;
    const pollInfo = ap.lastPollAt ? `Last checked ${time(ap.lastPollAt)} · next ${next}` : "Not checked yet";
    const picks = ap.cfg.pickupStates.length ? ap.cfg.pickupStates.join(", ") : "any open state";

    return page(
      queue.length ? `(${queue.length}) Linear autopilot` : "Linear autopilot",
      `<div class="top"><div class="brand"><div class="logo">L</div><div><h1>Linear autopilot</h1>
          <div class="muted small">${esc(pollInfo)} · picks up your tickets in <strong>${esc(picks)}</strong></div></div></div>
        <form method="post" action="/poll">${tokenField}<button${ap.polling ? " disabled" : ""}>↻ Poll now</button></form></div>
       <div class="stats"><div class="stat"><b>${queue.length}</b><span>Awaiting</span></div>
         <div class="stat"><b>${inProgress.length}</b><span>In progress</span></div>
         <div class="stat"><b>${prsOpen}</b><span>PRs open</span></div></div>
       ${updateBanner()}
       <div id="live" data-version="${esc(version())}" data-awaiting="${queue.length}">${banner.html}</div>
       ${notice ? `<div class="notice">${esc(notice)}</div>` : ""}
       ${ap.lastPollError ? `<div class="alert" style="margin-top:14px">Last poll failed: ${esc(ap.lastPollError)}</div>` : ""}
       ${error ? `<div class="alert" style="margin-top:14px">${esc(error)}</div>` : ""}
       <div class="section"><h2>Awaiting approval</h2><span class="count">${queue.length}</span></div>
       ${queue.length ? `<div class="grid">${queue.map(card).join("")}</div>`
         : `<div class="empty"><b>All clear</b>New tickets assigned to you in ${esc(picks)} will show up here.</div>`}
       ${launching.length ? `<div class="section"><h2>Launching</h2><span class="count">${launching.length}</span></div><div class="grid">${launching.map(card).join("")}</div>` : ""}
       ${inProgress.length ? `<div class="section"><h2>In progress</h2><span class="count">${inProgress.length}</span></div><div class="grid">${inProgress.map(workCard).join("")}</div>` : ""}
       ${completed.length ? `<details class="fold"><summary>Completed <span class="count">${completed.length}</span></summary><div class="recent">${completed.map(recentItem).join("")}</div></details>` : ""}
       ${rejected.length ? `<details class="fold"><summary>Rejected &amp; dismissed <span class="count">${rejected.length}</span></summary><div class="recent">${rejected.map(recentItem).join("")}</div></details>` : ""}
       ${[...queue, ...launching, ...inProgress, ...completed, ...rejected].map(modal).join("")}`,
    );
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      // Only answer to localhost names, which blocks DNS-rebinding attacks.
      if (!allowedHosts.has(req.headers.get("host") ?? "")) return new Response("forbidden host", { status: 403 });
      const url = new URL(req.url);
      const path = url.pathname;

      if (req.method === "POST") {
        const origin = req.headers.get("origin");
        if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ""))) return new Response("forbidden origin", { status: 403 });
        const form = await req.formData();
        if (!validToken(form.get("csrf"))) return new Response("bad csrf token; reload the page", { status: 403 });

        if (path === "/poll") {
          void ap.poll().then(() => ap.refreshWork());
          return redirect("/");
        }
        if (path === "/update") {
          const res = updater ? updater.install() : { ok: false as const, error: "updates are not available here" };
          return redirect(res.ok ? "/" : `/?error=${encodeURIComponent(`Update: ${res.error}`)}`);
        }
        const del = path.match(/^\/issues\/([^/]+)\/delete-worktrees$/);
        if (del) {
          const identifier = decodeURIComponent(del[1]);
          const res = await ap.deleteWorktrees(identifier, form.get("force") === "1");
          return redirect(res.ok ? `/?notice=${encodeURIComponent(res.message)}` : `/?error=${encodeURIComponent(`${identifier}: ${res.error}`)}#${modalId(identifier)}`);
        }
        const m = path.match(/^\/issues\/([^/]+)\/(approve|reject)$/);
        if (m) {
          const identifier = decodeURIComponent(m[1]);
          const res =
            m[2] === "approve"
              ? ap.approve(identifier, String(form.get("repo") ?? ""), String(form.get("branch") ?? ""), form.getAll("extra").map(String))
              : ap.reject(identifier);
          if (!res.ok) return redirect(`/?error=${encodeURIComponent(`${identifier}: ${res.error}`)}`);
          return redirect("/");
        }
        return new Response("not found", { status: 404 });
      }

      if (path === "/state") {
        const awaiting = ap.store.listByStatus(["pending", "failed"]).length;
        return Response.json({ polling: ap.polling, progress: ap.progress, version: version(), awaiting }, { headers: { "Cache-Control": "no-store" } });
      }
      const file = serveStatic(path, port);
      if (file) return file;
      if (path === "/healthz") {
        return Response.json({ ok: true, lastPollAt: ap.lastPollAt, lastPollError: ap.lastPollError, progress: ap.progress });
      }
      if (path === "/") return indexPage(url.searchParams.get("error") ?? undefined, url.searchParams.get("notice") ?? undefined);
      // Old links: open the item's modal on the list page.
      const m = path.match(/^\/issues\/([^/]+)$/);
      if (m) return redirect(`/#${modalId(decodeURIComponent(m[1]))}`);
      return new Response("not found", { status: 404 });
    },
  });
  log.info(`approval page at http://localhost:${server.port}`);
  return server;
}
