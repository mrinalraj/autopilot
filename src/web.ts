import { randomBytes, timingSafeEqual } from "node:crypto";
import { esc, page } from "./html";
import { eventsSince } from "./log";
import { mkdirSync } from "node:fs";
import { launchSteps } from "./steps";
import { launcherFor, pathFromId } from "./launch";
import { loadConfig, LOG_PATH } from "./config";
import { ICONS, MANIFEST, offlinePage, SERVICE_WORKER } from "./pwa";
import { Autopilot, phaseOf } from "./autopilot";
import type { IssueRow, IssueStatus } from "./db";
import { log } from "./log";
import { Store } from "./db";
import { atRisk, isSettled, overallStage, stage, type RepoWork, type WorkStage } from "./work";
import type { Updater } from "./updater";
import type { Health, SetupItem } from "./health";
import { githubAccounts, resetSettingsFile, saveSettings, saveTracker } from "./settings";
import { openTracker } from "./connect";
import { settingsBody } from "./settings-page";
import { managedByLaunchd } from "./update";
import { resetTickets } from "./reset";
import { serviceStatus } from "./service";
import { version as APP_VERSION } from "../package.json";

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

export function startWeb(ap: Autopilot, extras: { updater?: Updater; health?: Health; reschedule?: () => void } = {}) {
  const { updater, health, reschedule } = extras;
  const port = ap.cfg.port;
  // Kept in the database so pages stay valid across restarts and updates (per install, never sent elsewhere).
  const csrf = ap.store.getMeta("csrf_token") ?? randomBytes(24).toString("hex");
  ap.store.setMeta("csrf_token", csrf);
  // Changes on every start; open pages reload when it does, picking up new UI after an update.
  const bootId = randomBytes(6).toString("hex");
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
           <button class="primary" data-busy-label="Launching…">${r.status === "failed" ? "Retry launch" : "Approve"}</button></form>`;
    const actions = actionable(r)
      ? `<div class="actions">${approve}<form method="post" action="${actionBase(r)}/reject">${tokenField}<button class="ghost-danger" data-busy-label="Rejecting…">Reject</button></form></div>`
      : "";
    return `<article class="card s-${r.status}">
      <div class="cardhead">${badge(r.status, r.error)}<span class="ident">${esc(r.identifier)}</span>${confidence(r)}</div>
      <a class="title" href="#${id}">${esc(r.title)}</a>
      <div class="pills">${repoPills(r)}${ex.size ? `<span class="pill">size ${esc(ex.size)}</span>` : ""}<span class="pill mono">${esc(r.branch)}</span></div>
      <div class="summary">${esc(ex.summary)}</div>
      ${r.status === "failed" && r.error ? `<div class="alert">${esc(r.error)}</div>` : ""}
      ${r.status === "approved" || launchSteps.has(r.identifier) ? stepLine(r) : noteLine(r)}
      ${actions}
    </article>`;
  }

  /** Opens a worktree in the tool that made it (Supacode, VS Code, Cursor); null for terminal launchers. */
  const linkFor = (r: IssueRow, path: string) => launcherFor(ap.cfg, r.launcher ?? "supacode").link(path);
  const worktreeLink = (r: IssueRow) => (r.worktree_id ? linkFor(r, pathFromId(r.worktree_id)) : null);

  /** Live step of a launch or background action on this ticket. */
  const stepLine = (r: IssueRow) =>
    `<div class="step"><span class="spinner"></span><span data-step="${esc(r.identifier)}">${esc(launchSteps.get(r.identifier) ?? "Starting…")}</span></div>`;
  /** Result of the ticket's last background action (e.g. a refused delete). */
  const noteLine = (r: IssueRow) => {
    const n = ap.notes.get(r.identifier);
    return n?.level === "error" ? `<div class="alert">${esc(n.msg)}</div>` : "";
  };

  function workCard(r: IssueRow) {
    const list = Autopilot.work(r);
    const st = list ? overallStage(list) : "working";
    const wt = worktreeLink(r);
    const multi = (list?.length ?? 0) > 1;
    const prs = (list ?? []).filter((w) => w.pr);
    const linearState = r.linear_state ? `<span class="pill linear" title="Linear status">${esc(r.linear_state)}</span>` : "";
    const summary = r.worktree_id ? workSummary(list) : `<div class="workline">No worktree found for this ticket; showing its ${esc(ap.trackerLabel)} status only.</div>`;
    return `<article class="card w-${st}">
      <div class="cardhead">${r.worktree_id ? stageBadge(st) : ""}<span class="ident">${esc(r.identifier)}</span>${linearState}</div>
      <a class="title" href="#${modalId(r.identifier)}">${esc(r.title)}</a>
      <div class="pills">${r.repo ? repoPills(r) : ""}<span class="pill mono">${esc(r.branch)}</span></div>
      ${summary}
      ${launchSteps.has(r.identifier) ? stepLine(r) : noteLine(r)}
      <div class="actions">${prs.map((w) => `<a class="btn primary" href="${esc(w.pr!.url)}" target="_blank" rel="noreferrer">${multi ? `${esc(w.repo)} ` : ""}PR #${w.pr!.number} ↗</a>`).join("")}
        ${wt ? `<a class="btn" href="${esc(wt)}">Open worktree</a>` : ""}${resendButton(r)}</div>
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
      const wt = linkFor(r, w.worktreePath);
      return `<dl class="facts">
        <dt>Repo</dt><dd><strong>${esc(w.repo)}</strong> ${stageBadge(stage(w))}</dd>
        <dt>Pull request</dt><dd>${w.pr ? `<a href="${esc(w.pr.url)}" target="_blank" rel="noreferrer">#${w.pr.number} ${esc(w.pr.title)}</a> · ${esc(prState(w.pr))}` : "none yet"}</dd>
        <dt>Commits</dt><dd>${w.commitsAhead ?? "?"} ahead of base${w.lastCommitAt ? ` · last ${esc(ago(w.lastCommitAt))}` : ""}</dd>
        <dt>Uncommitted</dt><dd>${w.dirtyFiles ?? "?"} file${w.dirtyFiles === 1 ? "" : "s"}</dd>
        <dt>Worktree</dt><dd>${w.missing ? "removed" : wt ? `<a href="${esc(wt)}">Open</a>` : ""} <code>${esc(w.worktreePath)}</code></dd>
      </dl>${w.error ? `<div class="alert" style="margin-top:8px">${esc(w.error)}</div>` : ""}`;
    };
    return `<div class="box"><h3>Progress · checked ${esc(ago(list[0].checkedAt))}</h3>
      <div class="cardhead" style="margin-bottom:10px">${stageBadge(overallStage(list))}</div>
      ${list.map(repoFacts).join("")}</div>`;
  }

  /** For VS Code/Cursor chat launches: re-send the prompt (e.g. after trusting the folder). */
  function resendButton(r: IssueRow) {
    if (!r.worktree_id || (r.launcher !== "vscode" && r.launcher !== "cursor") || ap.cfg.launch.ideSession !== "chat") return "";
    return `<form method="post" action="${actionBase(r)}/resend-prompt">${tokenField}<button data-busy-label="Sending…" title="Send the prompt to the editor's chat again">Send prompt to chat</button></form>`;
  }

  /** "Send back to approval…": undo a launch (removes what's left of its worktrees), keeping triage. */
  function sendBackBox(r: IssueRow) {
    if ((r.status !== "running" && r.status !== "failed") || !r.repo) return "";
    if (launchSteps.has(r.identifier)) return `<div class="box">${stepLine(r)}</div>`;
    const risks = (Autopilot.work(r) ?? []).flatMap((w) => atRisk(w).map((x) => `${w.repo}: ${x}`));
    return `<details class="danger"><summary>Send back to approval…</summary>
      <p class="small muted" style="margin:8px 0 4px">Moves this ticket back to Awaiting approval with its current repo, branch and explainer, so you can approve it again. Any of its worktrees that still exist are removed first (closing their Claude session); its branches are kept and reused.</p>
      ${risks.length ? `<div class="alert">At the last check this would lose: ${esc(risks.join(", "))}. It's re-checked first.</div>` : ""}
      <form method="post" action="${actionBase(r)}/send-back">${tokenField}
        <label class="check"><input type="checkbox" name="force" value="1"> Remove worktrees anyway, even with uncommitted or unpushed work</label>
        <button class="ghost-danger" type="submit" data-busy-label="Sending back…">Send back to approval</button></form>
    </details>`;
  }

  /** "Delete worktrees…" for launched tickets, listing what would be lost from the latest check. */
  function deleteBox(r: IssueRow) {
    if (r.status !== "running" && r.status !== "failed") return "";
    if (launchSteps.has(r.identifier)) return "";
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
        <button class="ghost-danger" type="submit" data-busy-label="Deleting…">Delete worktree${live.length === 1 ? "" : "s"}</button></form>
    </details>`;
  }

  /** Setup banners: required ones always show; optional ones until fixed or dismissed. */
  function setupBanners(): string {
    if (!health) return "";
    const dismissed = ap.store.dismissedBanners();
    const show = health.items.filter((i) => i.level === "required" || !dismissed.has(i.id));
    const hidden = health.items.filter((i) => i.level !== "required" && dismissed.has(i.id)).length;
    const link = (i: SetupItem) => (i.link ? ` <a href="${esc(i.link.href)}" target="_blank" rel="noreferrer">${esc(i.link.label)} ↗</a>` : "");
    const dismissForm = (i: SetupItem) =>
      `<form method="post" action="/banners/${encodeURIComponent(i.id)}/dismiss">${tokenField}<button class="x" title="Dismiss" aria-label="Dismiss ${esc(i.title)}" data-busy-label="">×</button></form>`;
    const tip = (i: SetupItem) =>
      i.level === "hint"
        ? `<div class="tip hint"><span class="body"><strong>${esc(i.title)}</strong> <span class="muted">${esc(i.detail)}</span>${link(i)}</span>${dismissForm(i)}</div>`
        : `<div class="tip ${i.level}${i.browserOnly ? " browser-only" : ""}"><span class="dot"></span>
      <div class="body"><strong>${esc(i.title)}</strong><span class="muted">${esc(i.detail)}</span>${link(i)}${i.command ? `<br><code>${esc(i.command)}</code>` : ""}
        ${i.action ? `<form method="post" action="${esc(i.action.path)}" style="margin-top:8px">${tokenField}<button class="primary" data-busy-label="${esc(i.action.busy)}">${esc(i.action.label)}</button></form>` : ""}</div>
      ${i.level !== "required" ? dismissForm(i) : ""}</div>`;
    const restore = hidden
      ? `<form class="restore" method="post" action="/banners/restore">${tokenField}<button data-busy-label="Showing…">Show ${hidden} dismissed tip${hidden === 1 ? "" : "s"}</button></form>`
      : "";
    return show.length || restore ? `<div class="setup">${show.map(tip).join("")}${restore}</div>` : "";
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
        : `<form method="post" action="/update">${tokenField}<button class="primary" data-busy-label="Updating…">${u.kind === "homebrew" ? "Update via Homebrew" : "Update now"}</button></form>`;
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
          <div class="actionsbar"><button class="primary" type="submit" data-busy-label="Launching…">${r.status === "failed" ? "Retry launch" : "Approve &amp; launch"}</button>
            <button class="ghost-danger" type="submit" formaction="${actionBase(r)}/reject" data-busy-label="Rejecting…">Reject</button></div>
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
            <div class="small" style="margin-top:4px"><a href="${esc(r.url)}" rel="noreferrer" target="_blank">Open in ${esc(ap.trackerLabel)} ↗</a></div>
          </div><a class="close" href="#" aria-label="Close">×</a></div>
        <div class="body">
          ${r.status === "failed" && r.error ? `<div class="alert" style="margin-bottom:14px"><strong>Launch failed.</strong> ${esc(r.error)}</div>` : ""}
          <div class="cols">
            <div><div class="box"><h3>Ticket description · verbatim, untrusted</h3><pre>${esc(t.description ?? "(empty)")}</pre></div>
              <div class="box"><h3>Comments · verbatim</h3>${comments}</div></div>
            <div>
              <div class="box"><h3>${ex.approach ? `Explainer${ex.size ? ` · size ${esc(ex.size)}` : ""}` : "Summary"}</h3><p style="margin-top:0">${esc(ex.summary)}</p>
                <p><strong>Approach.</strong> ${esc(ex.approach)}</p>
                <strong class="small">Likely areas</strong><ul class="small">${ex.likely_areas.map((a) => `<li><code>${esc(a)}</code></li>`).join("")}</ul></div>
              ${r.status === "running" ? progressBox(r) : ""}
              ${deleteBox(r)}
              ${sendBackBox(r)}
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
    const activity = ap.activity();
    if (activity) {
      return { html: `<div class="progress"><div class="row"><div class="spinner"></div><strong>${esc(activity)}</strong></div></div>` };
    }
    return { html: "" };
  }

  /** Terminal-style live log, prefilled with recent lines; the page script appends new ones. */
  function logPanel(): string {
    const recent = eventsSince(0, 150);
    const line = (e: (typeof recent)[number]) =>
      `<div class="ln ${e.level}"><span class="ts">${esc(new Date(e.at).toTimeString().slice(0, 8))}</span>${esc(e.msg)}</div>`;
    return `<aside id="logs" class="logs" aria-label="Activity log" data-last="${recent.at(-1)?.id ?? 0}">
      <div class="logs-head"><strong>Activity</strong><span class="muted small">live · since the daemon started</span>
        <button type="button" class="x" id="logclose" aria-label="Close log">×</button></div>
      <div class="logs-body" id="logbody">${recent.map(line).join("") || `<div class="ln muted">Nothing yet.</div>`}</div></aside>`;
  }

  /** Changes whenever the set of tickets or their statuses change. */
  function version(): string {
    const v = ap.store.db
      .query<{ n: number; t: string | null }, []>("SELECT COUNT(*) AS n, MAX(updated_at) AS t FROM issues")
      .get();
    const notes = [...ap.notes.entries()].map(([k, n]) => `${k}:${n.level}:${n.msg.length}`).join(",");
    return `${v?.n ?? 0}|${v?.t ?? ""}|${ap.lastPollError ?? ""}|${updater?.status ?? ""}|${updater?.info?.latest ?? ""}|${notes}|${[...launchSteps.keys()].join(",")}`;
  }

  function indexPage(error?: string, notice?: string) {
    const queue = ap.store.listByStatus(["pending", "failed"]);
    const launching = ap.store.listByStatus(["approved"]);
    const running = ap.store.listByStatus(["running"], 300);
    const phase = (r: IssueRow) => phaseOf(r, Autopilot.work(r));
    const inProgress = running.filter((r) => phase(r) === "in-progress");
    const inReview = running.filter((r) => phase(r) === "in-review");
    const completed = running.filter((r) => phase(r) === "completed");
    const rejected = ap.store.listByStatus(["rejected"], 100);
    const prsOpen = [...inProgress, ...inReview].flatMap((r) => Autopilot.work(r) ?? []).filter((w) => w.pr?.state === "OPEN").length;
    const banner = progressBanner();
    const next = ap.lastPollAt ? time(new Date(Date.parse(ap.lastPollAt) + ap.cfg.pollIntervalSeconds * 1000).toISOString()) : null;
    const pollInfo = ap.lastPollAt ? `Last checked ${time(ap.lastPollAt)} · next ${next}` : "Not checked yet";
    const picks = ap.cfg.pickupStates.length ? ap.cfg.pickupStates.join(", ") : "any open state";

    /** First run (nothing signed in, no tickets yet): pick a tracker and sign in, in one click. */
    const connectCard = () => {
      const button = (kind: "linear" | "jira", label: string) =>
        `<form method="post" action="/actions/switch-tracker">${tokenField}<input type="hidden" name="tracker" value="${kind}">
          <input type="hidden" name="signin" value="1"><input type="hidden" name="from" value="home">
          <button class="${ap.cfg.tracker === kind ? "primary" : ""}" data-busy-label="Opening ${label}…">Connect ${label}</button></form>`;
      return `<section class="box connect" style="margin-top:14px"><h3>Connect your issue tracker</h3>
        <p style="margin:0 0 12px">Autopilot watches tickets assigned to you and proposes a Claude Code session for each one you approve. Pick where your tickets live; you sign in on the tracker's own page and the credentials stay in the macOS Keychain.</p>
        <div class="row">${button("linear", "Linear")}${button("jira", "Jira")}</div>
        <div class="muted small" style="margin-top:8px">Jira means Jira Cloud (your site's admin may need to allow Atlassian's MCP server). You can switch later in Settings.</div></section>`;
    };

    return page(
      queue.length ? `(${queue.length}) Autopilot` : "Autopilot",
      `<div class="top"><div class="brand"><div class="logo">A</div><div><h1>Autopilot</h1>
          <div class="muted small">${esc(pollInfo)} · picks up your tickets in <strong>${esc(picks)}</strong></div></div></div>
        <div class="row"><form method="post" action="/poll">${tokenField}<button${ap.polling ? " disabled" : ""} data-busy-label="Checking…">↻ Poll now</button></form>
          <button type="button" class="btn" id="logtoggle" aria-controls="logs" aria-expanded="false">Logs</button>
          <a class="btn gear" href="/settings" title="Settings" aria-label="Settings">⚙</a></div></div>
       <div class="stats"><div class="stat"><b>${queue.length}</b><span>Awaiting</span></div>
         <div class="stat"><b>${inProgress.length}</b><span>In progress</span></div>
         <div class="stat"><b>${inReview.length}</b><span>In review</span></div>
         <div class="stat"><b>${prsOpen}</b><span>PRs open</span></div></div>
       ${setupBanners()}
       ${updateBanner()}
       <div id="live" data-version="${esc(version())}" data-boot="${bootId}" data-awaiting="${queue.length}">${banner.html}</div>
       ${notice ? `<div class="notice">${esc(notice)}</div>` : ""}
       ${
         ap.signingIn && ap.isEmpty()
           ? `<section class="box connect" style="margin-top:14px"><div class="step" id="signin-wait"><span class="spinner"></span><span>Waiting for you to approve ${esc(ap.trackerLabel)} access in the browser tab that just opened…</span></div></section>`
           : ap.lastPollError && /login required/i.test(ap.lastPollError) && ap.isEmpty()
           ? connectCard()
           : ap.lastPollError
           ? `<div class="alert" style="margin-top:14px">Last poll failed: ${esc(ap.lastPollError)}${
               /login required/i.test(ap.lastPollError)
                 ? `<form method="post" action="/actions/signin" style="margin-top:8px">${tokenField}<button class="primary" data-busy-label="Opening ${esc(ap.trackerLabel)}…">Sign in to ${esc(ap.trackerLabel)}</button></form>`
                 : ""
             }</div>`
           : ""
       }
       ${error ? `<div class="alert" style="margin-top:14px">${esc(error)}</div>` : ""}
       <div class="section"><h2>Awaiting approval</h2><span class="count">${queue.length}</span></div>
       ${queue.length ? `<div class="grid">${queue.map(card).join("")}</div>`
         : `<div class="empty"><b>All clear</b>New tickets assigned to you in ${esc(picks)} will show up here.</div>`}
       ${launching.length ? `<div class="section"><h2>Launching</h2><span class="count">${launching.length}</span></div><div class="grid">${launching.map(card).join("")}</div>` : ""}
       ${inProgress.length ? `<div class="section"><h2>In progress</h2><span class="count">${inProgress.length}</span></div><div class="grid">${inProgress.map(workCard).join("")}</div>` : ""}
       ${inReview.length ? `<div class="section"><h2>In review</h2><span class="count">${inReview.length}</span></div><div class="grid">${inReview.map(workCard).join("")}</div>` : ""}
       ${completed.length ? `<details class="fold"><summary>Completed <span class="count">${completed.length}</span></summary><div class="recent">${completed.map(recentItem).join("")}</div></details>` : ""}
       ${rejected.length ? `<details class="fold"><summary>Rejected &amp; dismissed <span class="count">${rejected.length}</span></summary><div class="recent">${rejected.map(recentItem).join("")}</div></details>` : ""}
       ${[...queue, ...launching, ...inProgress, ...inReview, ...completed, ...rejected].map(modal).join("")}
       ${logPanel()}`,
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
        if (!validToken(form.get("csrf"))) {
          return redirect(`/?error=${encodeURIComponent("The page was out of date (the app had restarted), so nothing was done. Try again.")}`);
        }

        if (path === "/poll") {
          void ap.poll().then(() => ap.refreshWork());
          void health?.refresh();
          return redirect("/");
        }
        const dismiss = path.match(/^\/banners\/([a-z-]+)\/dismiss$/);
        if (dismiss) {
          if (health?.items.some((i) => i.id === dismiss[1] && i.level !== "required")) ap.store.dismissBanner(dismiss[1]);
          return redirect("/");
        }
        if (path === "/banners/restore") {
          ap.store.restoreBanners();
          return redirect("/");
        }
        if (path === "/settings") {
          const githubBefore = ap.cfg.githubUser;
          const res = saveSettings(ap.cfg, form);
          if (res.errors.length) return redirect(`/settings?error=${encodeURIComponent(res.errors.join(" "))}`);
          if (ap.cfg.githubUser !== githubBefore) {
            void ap.refreshWork(); // notices the new account and re-checks every ticket
            res.notes.push("Re-checking every ticket's PRs with the new GitHub account.");
          }
          reschedule?.();
          void health?.refresh();
          return redirect(`/settings?notice=${encodeURIComponent(["Saved.", ...res.notes].join(" "))}`);
        }
        if (path === "/actions/reset") {
          try {
            const r = await resetTickets();
            void ap.poll(); // triage the re-queued tickets right away
            return redirect(`/?notice=${encodeURIComponent(`Reset: cleared ${r.cleared.length}, kept ${r.kept.length} launched, triaging ${r.queued.length}.`)}`);
          } catch (err) {
            return redirect(`/settings?error=${encodeURIComponent(`Reset failed: ${(err as Error).message}`)}`);
          }
        }
        if (path === "/actions/erase") {
          if (form.get("confirm") !== "on") return redirect(`/settings?error=${encodeURIComponent('Tick "Yes, erase everything" to confirm.')}`);
          const resetSettings = form.get("resetSettings") === "on";
          const res = await ap.eraseAll(resetSettings ? () => {
            resetSettingsFile();
            Object.assign(ap.cfg, loadConfig());
          } : undefined);
          if (!res.ok) return redirect(`/settings?error=${encodeURIComponent(`Not erased: ${res.error}`)}`);
          ap.store.restoreBanners();
          reschedule?.();
          void health?.refresh();
          void ap.poll();
          return redirect(`/?notice=${encodeURIComponent(`Erased all data${resetSettings ? " and reset settings" : ""}; still signed in. Checking ${ap.trackerLabel} for your tickets now.`)}`);
        }
        if (path === "/actions/signin") {
          const res = ap.startSignIn();
          return redirect(
            res.ok
              ? `/settings?notice=${encodeURIComponent(`${ap.trackerLabel} opened in your browser: approve access there, and this page updates once you're signed in.`)}`
              : `/settings?error=${encodeURIComponent(res.error)}`,
          );
        }
        if (path === "/actions/signout") {
          await ap.signOut();
          return redirect(`/settings?notice=${encodeURIComponent(`Signed out of ${ap.trackerLabel}.`)}`);
        }
        if (path === "/actions/switch-tracker") {
          // Also the first-run "Connect" buttons, which add signin=1.
          const res = saveTracker(form);
          if (!res.ok) return redirect(`/settings?error=${encodeURIComponent(res.error)}`);
          const back = form.get("from") === "home" ? "/" : "/settings";
          const site = form.has("jiraSite") ? String(form.get("jiraSite")).trim() : ap.cfg.jira.site;
          if (res.tracker !== ap.cfg.tracker || site !== ap.cfg.jira.site) {
            Object.assign(ap.cfg, loadConfig());
            const sw = await ap.switchTracker(() => openTracker(ap.cfg).tracker);
            if (!sw.ok) return redirect(`${back}?error=${encodeURIComponent(sw.error)}`);
            health?.refresh().catch(() => {});
          }
          if (form.get("signin")) {
            const si = ap.startSignIn();
            if (!si.ok) return redirect(`${back}?error=${encodeURIComponent(si.error)}`);
            return redirect(`${back}?notice=${encodeURIComponent(`${ap.trackerLabel} opened in your browser: approve access there, and this page updates once you're signed in.`)}`);
          }
          void ap.poll();
          return redirect(`${back}?notice=${encodeURIComponent(`Now using ${ap.trackerLabel}.`)}`);
        }
        if (path === "/actions/trust-folder") {
          // Opening the folder makes the editor ask "Do you trust the authors?"; the choice stays with the user.
          const editorApp = ap.cfg.launch.launcher === "cursor" ? "Cursor" : "Visual Studio Code";
          mkdirSync(ap.cfg.launch.worktreesDir, { recursive: true });
          const r = Bun.spawnSync(["open", "-a", editorApp, ap.cfg.launch.worktreesDir], { stderr: "pipe" });
          if (r.exitCode !== 0) return redirect(`/?error=${encodeURIComponent(`Couldn't open ${editorApp}: ${r.stderr.toString().trim()}`)}`);
          log.info(`opened ${ap.cfg.launch.worktreesDir} in ${editorApp} so it can be trusted`);
          setTimeout(() => void health?.refresh(), 30_000); // hide the tip once trusted
          return redirect(`/?notice=${encodeURIComponent(`Opened ${ap.cfg.launch.worktreesDir} in ${editorApp}. There, click "Manage" in the Restricted Mode bar (or "Restricted Mode" in the status bar) → Trust.`)}`);
        }
        if (path === "/actions/recheck") {
          await health?.refresh();
          return redirect("/settings?notice=" + encodeURIComponent("Setup checks refreshed."));
        }
        if (path === "/actions/check-updates") {
          const info = await updater?.check();
          const msg = !info ? "No releases published yet." : info.available ? `Update available: ${info.latest}.` : `Up to date (${info.current}).`;
          return redirect(`/settings?notice=${encodeURIComponent(msg)}`);
        }
        if (path === "/actions/restart") {
          if (!managedByLaunchd()) return redirect(`/settings?error=${encodeURIComponent("Not running as a service; restart it where you started it.")}`);
          setTimeout(() => process.exit(0), 300); // launchd starts it again
          return redirect("/");
        }
        if (path === "/update") {
          const res = updater ? updater.install() : { ok: false as const, error: "updates are not available here" };
          return redirect(res.ok ? "/" : `/?error=${encodeURIComponent(`Update: ${res.error}`)}`);
        }
        const resend = path.match(/^\/issues\/([^/]+)\/resend-prompt$/);
        if (resend) {
          const identifier = decodeURIComponent(resend[1]);
          const res = await ap.resendPrompt(identifier);
          return redirect(res.ok ? `/?notice=${encodeURIComponent(res.message)}` : `/?error=${encodeURIComponent(`${identifier}: ${res.error}`)}`);
        }
        const back = path.match(/^\/issues\/([^/]+)\/send-back$/);
        if (back) {
          const identifier = decodeURIComponent(back[1]);
          const force = form.get("force") === "1";
          const res = ap.runInBackground(identifier, "Sending back to approval…", () => ap.sendBackToApproval(identifier, force));
          return redirect(
            res.ok
              ? `/?logs=1&notice=${encodeURIComponent(`Sending ${identifier} back to approval in the background; you can close this.`)}`
              : `/?error=${encodeURIComponent(`${identifier}: ${res.error}`)}`,
          );
        }
        const del = path.match(/^\/issues\/([^/]+)\/delete-worktrees$/);
        if (del) {
          const identifier = decodeURIComponent(del[1]);
          const force = form.get("force") === "1";
          const res = ap.runInBackground(identifier, "Deleting worktrees…", () => ap.deleteWorktrees(identifier, force));
          return redirect(
            res.ok
              ? `/?logs=1&notice=${encodeURIComponent(`Deleting ${identifier}'s worktrees in the background; you can close this.`)}`
              : `/?error=${encodeURIComponent(`${identifier}: ${res.error}`)}`,
          );
        }
        const m = path.match(/^\/issues\/([^/]+)\/(approve|reject)$/);
        if (m) {
          const identifier = decodeURIComponent(m[1]);
          const res =
            m[2] === "approve"
              ? ap.approve(identifier, String(form.get("repo") ?? ""), String(form.get("branch") ?? ""), form.getAll("extra").map(String))
              : ap.reject(identifier);
          if (!res.ok) return redirect(`/?error=${encodeURIComponent(`${identifier}: ${res.error}`)}`);
          return redirect(m[2] === "approve" ? "/?logs=1" : "/"); // show the log while it launches
        }
        return new Response("not found", { status: 404 });
      }

      if (path === "/events") {
        return Response.json(eventsSince(Number(url.searchParams.get("since") ?? 0)), { headers: { "Cache-Control": "no-store" } });
      }
      if (path === "/state") {
        const awaiting = ap.store.listByStatus(["pending", "failed"]).length;
        return Response.json(
          { polling: ap.polling, activity: ap.activity(), progress: ap.progress, version: version(), awaiting, launching: Object.fromEntries(launchSteps), boot: bootId, signingIn: ap.signingIn },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      const file = serveStatic(path, port);
      if (file) return file;
      if (path === "/healthz") {
        return Response.json({ ok: true, lastPollAt: ap.lastPollAt, lastPollError: ap.lastPollError, progress: ap.progress });
      }
      if (path === "/settings") {
        const [statuses, ghAccounts, teamKeys, account] = await Promise.all([
          ap.statusOptions(),
          Promise.resolve(githubAccounts()),
          ap.teamKeys(),
          ap.account().catch(() => null),
        ]);
        return page(
          "Settings · Autopilot",
          settingsBody({
            cfg: ap.cfg,
            tracker: ap.trackerLabel,
            account,
            signingIn: ap.signingIn,
            tokenField,
            statuses,
            ghAccounts,
            teamKeys,
            version: APP_VERSION,
            service: serviceStatus(),
            dismissedTips: ap.store.dismissedBanners().size,
            error: url.searchParams.get("error") ?? undefined,
            notice: url.searchParams.get("notice") ?? undefined,
          }),
        );
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
