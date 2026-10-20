import { CONFIG_PATH, HOME_DIR, LOG_PATH, type Config } from "./config";
import { listRepos } from "./catalog";
import { esc } from "./html";

export interface SettingsData {
  cfg: Config;
  /** "Linear" or "Jira". */
  tracker: string;
  /** Signed-in tracker account, null when signed out. */
  account: { name: string; email: string | null } | null;
  signingIn: boolean;
  /** My teams' (Jira: projects') keys, the default ticket prefixes. */
  teamKeys: string[];
  tokenField: string;
  statuses: { team: string; name: string; type: string }[];
  ghAccounts: string[];
  version: string;
  service: string;
  dismissedTips: number;
  error?: string;
  notice?: string;
}

const checked = (on: boolean) => (on ? " checked" : "");
const selected = (on: boolean) => (on ? " selected" : "");

/** Checkbox list of the tracker's statuses (deduplicated across teams) plus a free-text box for others. */
function statusPicker(name: string, current: string[], statuses: SettingsData["statuses"], hint: string, tracker: string): string {
  const names = [...new Map(statuses.map((s) => [s.name.toLowerCase(), s])).values()];
  const known = new Set(names.map((s) => s.name.toLowerCase()));
  const other = current.filter((c) => !known.has(c.toLowerCase()));
  const boxes = names
    .map((s) => `<label class="opt"><input type="checkbox" name="${name}" value="${esc(s.name)}"${checked(current.some((c) => c.toLowerCase() === s.name.toLowerCase()))}>
      ${esc(s.name)} <span class="muted small">${esc(s.type)}</span></label>`)
    .join("");
  return `${boxes ? `<div class="opts">${boxes}</div>` : `<p class="muted small">Couldn't load your ${esc(tracker)} statuses; type them below.</p>`}
    <input type="text" name="${name}Other" value="${esc(other.join(", "))}" placeholder="Other statuses, comma-separated">
    <div class="muted small" style="margin-top:4px">${hint}</div>`;
}

export function settingsBody(d: SettingsData): string {
  const { cfg, tokenField } = d;
  const repos = listRepos(cfg);
  const launchers: [string, string][] = [
    ["supacode", "Supacode: worktree and Claude tab in Supacode"],
    ["worktrunk", "Worktrunk: wt switch --create (with its hooks), Claude in your terminal"],
    ["git", "git worktree: plain git worktrees, Claude in your terminal"],
    ["vscode", "VS Code: git worktrees opened in VS Code, Claude in its chat panel (or a terminal)"],
    ["cursor", "Cursor: git worktrees opened in Cursor, prompt in its chat panel (or a terminal)"],
  ];
  const t = esc(d.tracker);
  const teams = cfg.tracker === "jira" ? "projects" : "teams";
  const other = cfg.tracker === "jira" ? "Linear" : "Jira";
  const action = (path: string, label: string, busy: string, cls = "") =>
    `<form method="post" action="${path}">${tokenField}<button class="${cls}" data-busy-label="${busy}">${label}</button></form>`;

  return `<div class="top"><div class="brand"><a class="logo" href="/" style="color:#fff;text-decoration:none">L</a><div><h1>Settings</h1>
      <div class="muted small"><a href="/">← Back to tickets</a></div></div></div></div>
    ${d.error ? `<div class="alert" style="margin-top:14px">${esc(d.error)}</div>` : ""}
    ${d.notice ? `<div class="notice">${esc(d.notice)}</div>` : ""}
    <section class="box" style="margin-top:16px"><h3>${t} account</h3>
      ${
        d.signingIn
          ? `<div class="step" id="signin-wait"><span class="spinner"></span><span>Waiting for you to approve in the browser tab that just opened…</span></div>`
          : d.account
            ? `<p style="margin:0 0 12px">Signed in as <strong>${esc(d.account.name)}</strong>${d.account.email ? ` <span class="muted">${esc(d.account.email)}</span>` : ""}</p>`
            : `<p style="margin:0 0 12px">Not signed in. Tickets aren't checked until you sign in.</p>`
      }
      <div class="row">${
        d.account
          ? `${action("/actions/signin", "Switch account", `Opening ${t}…`)}${action("/actions/signout", "Sign out", "Signing out…", "ghost-danger")}`
          : action("/actions/signin", `Sign in to ${t}`, `Opening ${t}…`, "primary")
      }</div>
      <div class="muted small" style="margin-top:8px">Sign-in happens in your browser through ${t}'s own page; credentials stay in the macOS Keychain.</div>
      <form method="post" action="/actions/switch-tracker" class="settings" style="margin-top:14px">${tokenField}
        <div class="pair"><div><label for="tracker">Issue tracker</label>
          <select id="tracker" name="tracker">
            <option value="linear"${selected(cfg.tracker === "linear")}>Linear</option>
            <option value="jira"${selected(cfg.tracker === "jira")}>Jira Cloud</option></select></div>
        <div><label for="jiraSite">Jira site (if you can reach several)</label>
          <input type="text" id="jiraSite" name="jiraSite" value="${esc(cfg.jira.site)}" placeholder="acme.atlassian.net"></div></div>
        <div class="row" style="margin-top:10px"><button type="submit" data-busy-label="Switching…">Save tracker</button></div>
        <div class="muted small" style="margin-top:4px">One tracker at a time; each keeps its own tickets and sign-in, so switching back to ${other} later picks up where it left off.</div>
      </form>
    </section>

    <form method="post" action="/settings" class="settings">${tokenField}
      <section class="box"><h3>${t}</h3>
        <label>Pick up tickets in</label>
        ${statusPicker("pickupStates", cfg.pickupStates, d.statuses, "A ticket assigned to you is triaged when it enters one of these. None ticked = any open status.", d.tracker)}
        <label>Also show my tickets in</label>
        ${statusPicker("importStates", cfg.importStates, d.statuses, "Shown under In progress without triage, linked to their worktree when one exists.", d.tracker)}
        <label class="check"><input type="checkbox" name="importWorktrees"${checked(cfg.importWorktrees)}> Scan worktrees for ticket numbers in branch names and show those tickets</label>
        <label for="ticketPrefixes">Ticket prefixes</label>
        <input type="text" id="ticketPrefixes" name="ticketPrefixes" value="${esc(cfg.ticketPrefixes.join(", "))}" placeholder="${esc(d.teamKeys.join(", ") || "ENG")}">
        <div class="muted small" style="margin-top:4px">Prefixes of ticket numbers in branch and worktree names, e.g. <code>ENG</code> matches <code>fix-tab-eng-4821</code>. Empty = your ${t} ${teams}' keys${d.teamKeys.length ? ` (${esc(d.teamKeys.join(", "))})` : ""}.</div>
      </section>

      <section class="box"><h3>Polling</h3>
        <div class="pair"><div><label for="pollMinutes">Check ${t} every (minutes)</label>
          <input type="number" id="pollMinutes" name="pollMinutes" min="1" max="1440" value="${Math.round(cfg.pollIntervalSeconds / 60)}"></div>
        <div><label for="workMinutes">Check commits and PRs every (minutes)</label>
          <input type="number" id="workMinutes" name="workMinutes" min="1" max="1440" value="${Math.round(cfg.workCheckIntervalSeconds / 60)}"></div></div>
      </section>

      <section class="box"><h3>Launch</h3>
        <label for="launcher">Launcher</label>
        <select id="launcher" name="launcher">${launchers.map(([v, l]) => `<option value="${v}"${selected(cfg.launch.launcher === v)}>${esc(l)}</option>`).join("")}</select>
        <div class="pair"><div><label for="terminal">Terminal for Claude (Worktrunk, git, or editors set to Terminal)</label>
          <select id="terminal" name="terminal">
            <option value="terminal"${selected(cfg.launch.terminal === "terminal")}>Terminal (new tab)</option>
            <option value="iterm"${selected(cfg.launch.terminal === "iterm")}>iTerm (new tab)</option>
            <option value="warp"${selected(cfg.launch.terminal === "warp")}>Warp (new tab; the claude command is copied for you)</option>
            <option value="none"${selected(cfg.launch.terminal === "none")}>None: just create the worktrees</option></select></div>
        <div><label for="worktreesDir">Worktree folder (git, VS Code, Cursor)</label>
          <input type="text" id="worktreesDir" name="worktreesDir" value="${esc(cfg.launch.worktreesDir)}"></div></div>
        <div class="pair"><div><label for="ideSession">Claude in VS Code / Cursor</label>
          <select id="ideSession" name="ideSession">
            <option value="chat"${selected(cfg.launch.ideSession === "chat")}>Chat panel (prompt pre-filled; press Enter)</option>
            <option value="terminal"${selected(cfg.launch.ideSession === "terminal")}>Terminal</option></select></div>
        <div><label for="cursorChat">Cursor's chat panel uses</label>
          <select id="cursorChat" name="cursorChat">
            <option value="cursor"${selected(cfg.launch.cursorChat === "cursor")}>Cursor's own chat</option>
            <option value="claude"${selected(cfg.launch.cursorChat === "claude")}>Claude Code extension</option></select></div></div>
        <div class="pair"><div><label for="base">Base branch</label>
          <input type="text" id="base" name="base" value="${esc(cfg.launch.base)}" placeholder="default branch"></div><div></div></div>
        <label class="check"><input type="checkbox" name="fetch"${checked(cfg.launch.fetch)}> Fetch origin before creating worktrees</label>
        <label class="check"><input type="checkbox" name="background"${checked(cfg.launch.background)}> Open worktrees and sessions in the background</label>
        <label class="check"><input type="checkbox" name="moveToInProgressOnApprove"${checked(cfg.moveToInProgressOnApprove)}> Move the ${t} ticket to In Progress after launching</label>
      </section>

      <section class="box"><h3>Repos</h3>
        <label class="check"><input type="radio" name="repoMode" value="folder"${checked(cfg.repoMode === "folder")}> Every repo in a parent folder</label>
        <input type="text" id="reposRoot" name="reposRoot" value="${esc(cfg.reposRoot)}" aria-label="Parent folder">
        <label class="check" style="margin-top:12px"><input type="radio" name="repoMode" value="list"${checked(cfg.repoMode === "list")}> These repos only (one path per line; they can live anywhere)</label>
        <textarea name="repoPaths" rows="4" placeholder="~/code/api&#10;~/work/web" aria-label="Repo paths">${esc(cfg.repoPaths.join("\n"))}</textarea>
        <div class="muted small" style="margin-top:4px">Descriptions below help triage pick the right repo; save after switching to refresh the list.</div>
        <div class="repos">${repos.length ? repos.map((r) => `<div class="repo">
            <input type="hidden" name="present:${esc(r.name)}" value="1">
            <label class="check" style="margin:0"><input type="checkbox" name="include:${esc(r.name)}"${checked(!r.excluded)}> <strong>${esc(r.name)}</strong></label>
            <input type="text" name="desc:${esc(r.name)}" value="${esc(r.override || r.derived)}" placeholder="What lives in this repo">
          </div>`).join("") : `<p class="muted">No git repos found in this folder.</p>`}</div>
      </section>

      <section class="box"><h3>Triage</h3>
        <div class="pair"><div><label for="provider">LLM backend</label>
          <select id="provider" name="provider">
            <option value="cli"${selected(cfg.llm.provider === "cli")}>Claude Code (claude -p, your login)</option>
            <option value="api"${selected(cfg.llm.provider === "api")}>Anthropic API (ANTHROPIC_API_KEY)</option></select></div>
        <div><label for="model">Model</label><input type="text" id="model" name="model" value="${esc(cfg.llm.model)}"></div></div>
        <label for="lowConfidenceThreshold">Ask for a review when repo confidence is below</label>
        <input type="number" id="lowConfidenceThreshold" name="lowConfidenceThreshold" min="0" max="1" step="0.05" value="${cfg.lowConfidenceThreshold}">
      </section>

      <section class="box"><h3>GitHub</h3>
        <label for="githubUser">Account for PR tracking</label>
        <select id="githubUser" name="githubUser">
          <option value=""${selected(!cfg.githubUser)}>gh's active account</option>
          ${[...new Set([...d.ghAccounts, ...(cfg.githubUser ? [cfg.githubUser] : [])])].map((a) => `<option value="${esc(a)}"${selected(cfg.githubUser === a)}>${esc(a)}</option>`).join("")}
        </select>
        <div class="muted small" style="margin-top:4px">Pin the account that can see your work repos, so switching gh accounts doesn't break tracking.</div>
      </section>

      <div class="savebar"><button class="primary" type="submit" data-busy-label="Saving…">Save settings</button><a class="btn" href="/">Cancel</a></div>
    </form>

    <section class="box" style="margin-top:20px"><h3>Maintenance</h3>
      <div class="actrow">${action("/poll", "↻ Poll now", "Checking…")}<span class="muted small">Check ${t} and refresh PR status now.</span></div>
      <div class="actrow">${action("/actions/reset", "Reset tickets", "Resetting…", "ghost-danger")}<span class="muted small">Clear tickets that haven't been launched and triage everything currently eligible again. Launched tickets are kept.</span></div>
      <form method="post" action="/actions/erase" class="actrow erase">${tokenField}
        <button class="ghost-danger" data-busy-label="Erasing…">Erase all data</button>
        <span class="muted small">Every ticket (launched and imported too), brief and dismissed tip, for Linear and Jira. Sign-ins stay; worktrees and branches aren't touched. Afterwards your current tickets are fetched and triaged again.
          <label class="check" style="margin:6px 0 0"><input type="checkbox" name="resetSettings"> Also reset settings to defaults</label>
          <label class="check" style="margin:4px 0 0"><input type="checkbox" name="confirm" required> Yes, erase everything</label></span>
      </form>
      <div class="actrow">${action("/actions/recheck", "Re-run setup checks", "Checking…")}<span class="muted small">Refresh the setup tips on the home screen.</span></div>
      <div class="actrow">${action("/banners/restore", `Show dismissed tips${d.dismissedTips ? ` (${d.dismissedTips})` : ""}`, "Showing…")}<span class="muted small">Bring back setup tips you dismissed.</span></div>
      <div class="actrow">${action("/actions/check-updates", "Check for updates", "Checking…")}<span class="muted small">Version ${esc(d.version)}.</span></div>
      <div class="actrow">${action("/actions/restart", "Restart", "Restarting…")}<span class="muted small">${esc(d.service)}</span></div>
      <dl class="facts" style="margin-top:14px"><dt>Config</dt><dd><code>${esc(CONFIG_PATH)}</code></dd>
        <dt>Data</dt><dd><code>${esc(HOME_DIR)}</code></dd><dt>Log</dt><dd><code>${esc(LOG_PATH)}</code></dd></dl>
    </section>`;
}
