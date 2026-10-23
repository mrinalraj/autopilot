import { esc } from "./escape";
import { time } from "./components/ticket-shared";
import { ticketComponents } from "./components/tickets";
import { setupBanners, updateBanner, progressBanner, logPanel } from "./components/banners";
import type { DashboardData } from "../models";

export function dashboardBody(data: DashboardData) {
  const { queue, launching, inProgress, inReview, completed, prsOpen, rejected, error, notice, tokenField } = data;
  const { card, workCard, recentItem, modal } = ticketComponents(data);
  const banner = progressBanner(data);
  const next = data.lastPollAt ? time(new Date(Date.parse(data.lastPollAt) + data.cfg.pollIntervalSeconds * 1000).toISOString()) : null;
  const pollInfo = data.lastPollAt ? `Last checked ${time(data.lastPollAt)} · next ${next}` : "Not checked yet";
  const picks = data.cfg.pickupStates.length ? data.cfg.pickupStates.join(", ") : "any open state";

  /** First run (nothing signed in, no tickets yet): pick a tracker and sign in, in one click. */
  const connectCard = () => {
    const button = (kind: "linear" | "jira", label: string) =>
      `<form method="post" action="/actions/switch-tracker">${tokenField}<input type="hidden" name="tracker" value="${kind}">
        <input type="hidden" name="signin" value="1"><input type="hidden" name="from" value="home">
        <button class="${data.cfg.tracker === kind ? "primary" : ""}" data-busy-label="Opening ${label}…">Connect ${label}</button></form>`;
    return `<section class="box connect" style="margin-top:14px"><h3>Connect your issue tracker</h3>
      <p style="margin:0 0 12px">Autopilot watches tickets assigned to you and proposes a Claude Code session for each one you approve. Pick where your tickets live; you sign in on the tracker's own page and the credentials stay in the macOS Keychain.</p>
      <div class="row">${button("linear", "Linear")}${button("jira", "Jira")}</div>
      <div class="muted small" style="margin-top:8px">Jira means Jira Cloud (your site's admin may need to allow Atlassian's MCP server). You can switch later in Settings.</div></section>`;
  };

  return (
    `<div class="dashboard-shell"><div class="dashboard-main"><div class="dashboard-header"><div class="top"><div class="brand"><div class="logo">A</div><div><h1>Autopilot</h1>
        <div class="muted small">${esc(pollInfo)} · picks up your tickets in <strong>${esc(picks)}</strong></div></div></div>
      <div class="row"><form method="post" action="/poll">${tokenField}<button${data.polling ? " disabled" : ""} data-busy-label="Checking…">↻ Poll now</button></form>
        <button type="button" class="btn" id="logtoggle" aria-controls="logs" aria-expanded="false">Logs</button>
        <a class="btn" href="/settings" title="Settings">Settings</a></div></div>
     <div class="stats"><div class="stat"><b>${queue.length}</b><span>Awaiting</span></div>
       <div class="stat"><b>${inProgress.length}</b><span>In progress</span></div>
       <div class="stat"><b>${inReview.length}</b><span>In review</span></div>
       <div class="stat"><b>${prsOpen}</b><span>PRs open</span></div></div>
     </div><div class="dashboard-scroll" role="region" aria-label="Tickets" tabindex="0">
     ${setupBanners(data.health, data.dismissed, tokenField)}
     ${updateBanner(data.updater, tokenField)}
     <div id="live" data-version="${esc(data.version)}" data-boot="${data.bootId}" data-awaiting="${queue.length}">${banner.html}</div>
     ${notice ? `<div class="notice">${esc(notice)}</div>` : ""}
     ${
       data.signingIn && data.empty
         ? `<section class="box connect" style="margin-top:14px"><div class="step" id="signin-wait"><span class="spinner"></span><span>Waiting for you to approve ${esc(data.trackerLabel)} access in the browser tab that just opened…</span></div></section>`
         : data.lastPollError && /login required/i.test(data.lastPollError) && data.empty
         ? connectCard()
         : data.lastPollError
         ? `<div class="alert" style="margin-top:14px">Last poll failed: ${esc(data.lastPollError)}${
             /login required/i.test(data.lastPollError)
               ? `<form method="post" action="/actions/signin" style="margin-top:8px">${tokenField}<button class="primary" data-busy-label="Opening ${esc(data.trackerLabel)}…">Sign in to ${esc(data.trackerLabel)}</button></form>`
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
     </div></div>${logPanel(data.logs)}</div>
     ${[...queue, ...launching, ...inProgress, ...inReview, ...completed, ...rejected].map(modal).join("")}`
  );
}
