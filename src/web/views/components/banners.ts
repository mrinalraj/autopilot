import { esc } from "../escape";
import type { SetupItem } from "../../../app/health";
import type { LogEvent } from "../../../shared/log";
import type { DashboardData, ProgressViewData, UpdateViewData } from "../../models";

/** Setup banners: required ones always show; optional ones until fixed or dismissed. */
export function setupBanners(health: DashboardData["health"], dismissed: ReadonlySet<string>, tokenField: string): string {
  if (!health) return "";
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

export function updateBanner(updater: UpdateViewData | undefined, tokenField: string): string {
  if (!updater) return "";
  const u = updater.info;
  if (updater.status === "updating") return `<div class="update"><div class="spinner"></div><strong>Updating to ${esc(u?.latest)}…</strong></div>`;
  if (updater.status === "restarting") return `<div class="update"><div class="spinner"></div><strong>Restarting into ${esc(u?.latest)}…</strong></div>`;
  const err = updater.status === "error" && updater.error ? `<div class="alert" style="margin-top:14px">Update: ${esc(updater.error)}</div>` : "";
  if (!u?.available) return err;
  const action =
    u.kind === "desktop"
      ? `<span class="small muted">Quit Autopilot, run <code>brew upgrade --cask autopilot</code>, then reopen it. For a manual install, replace the app from the release.</span>`
      : u.kind === "source"
      ? `<span class="small muted">Running from source: <code>git pull</code> and restart</span>`
      : `<form method="post" action="/update">${tokenField}<button class="primary" data-busy-label="Updating…">${u.kind === "homebrew" ? "Update via Homebrew" : "Update now"}</button></form>`;
  return `<div class="update"><div class="grow"><strong>Update available: ${esc(u.latest)}</strong>
      <span class="muted small"> · you have ${esc(u.current)} · <a href="${esc(u.url)}" target="_blank" rel="noreferrer">release notes ↗</a></span></div>
      ${action}</div>${err}`;
}

export function progressBanner(data: ProgressViewData): { html: string } {
  const p = data.progress;
  if (p.total > 0) {
    const pct = Math.round((p.done / p.total) * 100);
    return {
      html: `<div class="progress"><div class="row"><div class="spinner"></div>
        <strong>Triaging ${esc(p.current ?? "")}</strong><span class="muted">${Math.min(p.done + 1, p.total)} of ${p.total} · picking repo, branch and writing the explainer</span></div>
        <div class="bar"><div style="width:${Math.max(pct, 4)}%"></div></div></div>`,
    };
  }
  const activity = data.activity;
  if (activity) {
    return { html: `<div class="progress"><div class="row"><div class="spinner"></div><strong>${esc(activity)}</strong></div></div>` };
  }
  return { html: "" };
}

/** Terminal-style live log, prefilled with recent lines; the page script appends new ones. */
export function logPanel(recent: LogEvent[]): string {
  const line = (e: (typeof recent)[number]) =>
    `<div class="ln ${e.level}"><span class="ts">${esc(new Date(e.at).toTimeString().slice(0, 8))}</span>${esc(e.msg)}</div>`;
  return `<aside id="logs" class="logs" aria-label="Activity log" data-last="${recent.at(-1)?.id ?? 0}">
    <div class="logs-head"><strong>Activity</strong><span class="muted small">live · since the daemon started</span>
      <button type="button" class="x" id="logclose" aria-label="Close log">×</button></div>
    <div class="logs-body" id="logbody">${recent.map(line).join("") || `<div class="ln muted">Nothing yet.</div>`}</div></aside>`;
}
