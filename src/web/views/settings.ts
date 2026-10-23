import type { Config } from "../../config/config";
import { esc } from "./escape";

export interface SettingsData {
  cfg: Config;
  version: string;
  paths: { config: string; home: string; log: string };
  tracker: string;
  signingIn: boolean;
  tokenField: string;
  dismissedTips: number;
  error?: string;
  notice?: string;
  draft?: FormData;
}

export function settingsBody(d: SettingsData): string {
  const { cfg, tokenField, draft } = d;
  const selected = (a: string, b: string) => a === b ? " selected" : "";
  const value = (name: string, fallback: string) => String(draft?.get(name) ?? fallback);
  const text = (name: string, label: string, fallback: string, attrs = "") => `<div class="field"><label for="${name}">${label}</label><input id="${name}" name="${name}" type="text" value="${esc(value(name, fallback))}" ${attrs}></div>`;
  const area = (name: string, label: string, values: string[]) => `<div class="field"><label for="${name}">${label}</label><textarea id="${name}" name="${name}" rows="2">${esc(value(name, values.join("\n")))}</textarea></div>`;
  const number = (name: string, label: string, val: number, attrs: string) => `<div class="field"><label for="${name}">${label}</label><input id="${name}" name="${name}" type="number" value="${esc(value(name, String(val)))}" required ${attrs}></div>`;
  const check = (name: string, label: string, on: boolean, section: string) => `<label class="check"><input type="checkbox" name="${name}"${(draft?.get("section") === section ? draft.has(name) : on) ? " checked" : ""}> ${label}</label>`;
  const select = (name: string, label: string, current: string, options: [string, string][], attrs = "") => `<div class="field" ${attrs}><label for="${name}">${label}</label><select id="${name}" name="${name}">${options.map(([v, l]) => `<option value="${v}"${selected(value(name, current), v)}>${l}</option>`).join("")}</select></div>`;
  const save = (section: string, title: string, content: string) => `<form method="post" action="/settings" data-settings-form data-section="${section}">${tokenField}<input type="hidden" name="section" value="${section}">
    <h2>${title}</h2>${content}<div class="alert form-error" role="alert" tabindex="-1" hidden></div>
    <div class="savebar"><span class="save-state muted small" role="status">No unsaved changes</span><button class="primary" type="submit" data-busy-label="Saving…">Save ${title.toLowerCase()}</button></div></form>`;
  const action = (path: string, label: string, busy: string, cls = "") => `<form method="post" action="${path}">${tokenField}<button class="${cls}" data-busy-label="${busy}">${label}</button></form>`;
  const metadata = (part: string, label: string) => `<div class="metadata-status small muted" data-check="${part}" role="status">${label}</div><button type="button" class="quiet" data-retry="${part}" hidden>Retry check</button>`;
  const statuses = (name: string, current: string[], label: string) => {
    const values = draft?.get("section") === "tickets" ? draft.getAll(name).map(String) : current;
    return `<fieldset class="status-picker"><legend>${label}</legend><div class="opts" data-status-options="${name}">${values.map((s) => `<label class="opt"><input type="checkbox" name="${name}" value="${esc(s)}" checked>${esc(s)}</label>`).join("")}</div>
      <details><summary>Add a custom status</summary>${text(name + "Other", "Status names, separated by commas", "")}</details></fieldset>`;
  };
  const nav: [string, string, string][] = [["connections", "Connections", "Tracker & GitHub"], ["tickets", "Tickets", "What to watch"], ["repositories", "Repositories", "Folders & routing"], ["launch", "Launch", "Workspace & editor"], ["ai", "AI", "Triage & review"], ["advanced", "Advanced", "Diagnostics & data"]];

  return `<div class="top settings-heading"><div class="brand"><a class="logo" href="/" aria-label="Back to tickets">A</a><div><h1>Settings</h1><a class="small" href="/">← Back to tickets</a></div></div><span class="small muted">Autopilot ${esc(d.version)}</span></div>
    ${d.error ? `<div class="alert" role="alert">${esc(d.error)}</div>` : ""}${d.notice ? `<div class="notice" role="status">${esc(d.notice)}</div>` : ""}
    <div class="settings-shell" data-initial-section="${esc(String(draft?.get("section") || "connections"))}">
      <nav class="settings-nav" aria-label="Settings sections">${nav.map(([id, name, hint]) => `<a href="#${id}" data-settings-link="${id}"><strong>${name}</strong><span>${hint}</span></a>`).join("")}</nav>
      <div class="settings-panels" role="region" aria-label="Settings content" tabindex="0">
        <section id="connections" class="settings-panel" data-settings-panel>
          <h2>Connections</h2><p class="muted">Choose where tickets come from and which GitHub account tracks the work.</p>
          <div class="settings-group"><h3>${esc(d.tracker)} account</h3>${metadata("account", "Checking your account…")}
            ${d.signingIn ? `<p id="signin-wait" class="step"><span class="spinner"></span>Waiting for approval in your browser…</p>` : ""}
            <div class="row">${action("/actions/signin", `Sign in to ${esc(d.tracker)}`, "Opening browser…")}${action("/actions/signout", "Sign out", "Signing out…", "ghost-danger")}</div>
          </div>
          <form method="post" action="/actions/switch-tracker" class="settings-group" data-tracker-form>${tokenField}
            ${select("tracker", "Issue tracker", cfg.tracker, [["linear", "Linear"], ["jira", "Jira Cloud"]])}
            <div data-when-tracker="jira">${text("jiraSite", "Jira site (optional)", cfg.jira.site, 'placeholder="acme.atlassian.net"')}</div>
            <p class="small muted">Each tracker keeps its own tickets and account. Switching applies immediately.</p><button data-busy-label="Switching…">Switch tracker</button>
          </form>
          ${save("connections", "GitHub account", `${metadata("github", "Checking GitHub accounts…")}<div class="field"><label for="githubUser">Account for PR tracking</label><select name="githubUser" id="githubUser"><option value="">Use gh's active account</option>${cfg.githubUser ? `<option value="${esc(cfg.githubUser)}" selected>${esc(cfg.githubUser)}</option>` : ""}</select></div><p class="small muted">Pin an account to keep PR tracking consistent when you switch accounts in the terminal.</p>`)}
        </section>
        <section id="tickets" class="settings-panel" data-settings-panel>
          ${save("tickets", "Ticket rules", `<p class="muted">Choose which assigned tickets Autopilot proposes and which existing work it follows.</p>
            ${metadata("statuses", "Loading available statuses…")}
            ${select("pickupMode", "Propose new work from", cfg.pickupStates.length ? "selected" : "any", [["selected", "Selected statuses"], ["any", "Any open status"]])}
            <div data-selected-statuses>${statuses("pickupStates", cfg.pickupStates, "Statuses eligible for triage")}</div>
            ${statuses("importStates", cfg.importStates, "Also follow existing work in these statuses")}
            <p class="small muted">Existing work is shown without starting a new session. Select no statuses to turn this off.</p>
            ${check("importWorktrees", "Discover tickets from existing worktree branches", cfg.importWorktrees, "tickets")}
            ${check("moveToInProgressOnApprove", "Move a ticket to In Progress after launching", cfg.moveToInProgressOnApprove, "tickets")}
            <div class="pair">${number("pollMinutes", "Check for tickets every (minutes)", Math.round(cfg.pollIntervalSeconds / 60), 'min="1" max="1440"')}${number("workMinutes", "Check commits and PRs every (minutes)", Math.round(cfg.workCheckIntervalSeconds / 60), 'min="1" max="1440"')}</div>
            <details class="advanced-options"><summary>Advanced ticket matching</summary>${text("ticketPrefixes", "Ticket prefixes", cfg.ticketPrefixes.join(", "), 'placeholder="ENG, IT"')}<p class="small muted">Leave blank to use your tracker teams or projects.</p></details>`)}
        </section>
        <section id="repositories" class="settings-panel" data-settings-panel>
          ${save("repositories", "Repositories", `<p class="muted">Add folders, choose included repositories, and describe what lives in each one.</p>
            <button type="button" data-pick-folders data-busy-label="Waiting for Finder…">Choose folders in Finder…</button><p class="small muted">Chosen folders are added to this draft. Save when you're ready.</p>
            ${area("repoRoots", "Parent folders (one per line)", cfg.repoRoots)}${area("repoPaths", "Individual repositories (one per line)", cfg.repoPaths)}
            ${metadata("repos", "Loading repositories…")}<label for="repo-search">Find a repository</label><input type="search" id="repo-search" placeholder="Filter by name or path" autocomplete="off">
            <div class="repos" data-repo-list></div><p class="small muted">Save folder changes to discover new repositories. Descriptions help route tickets.</p>`)}
        </section>
        <section id="launch" class="settings-panel" data-settings-panel>
          ${save("launch", "Launch settings", `<p class="muted">Choose where approved tickets open.</p>
            ${select("launcher", "Open work in", cfg.launch.launcher, [["supacode", "Supacode"], ["superset", "Superset"], ["worktrunk", "Worktrunk"], ["git", "Git worktrees"], ["vscode", "VS Code"], ["cursor", "Cursor"]])}
            <p class="small muted" data-launcher-description>Existing worktrees keep their paths, branches and files when you change launchers.</p>
            ${select("ideSession", "Start Claude in", cfg.launch.ideSession, [["chat", "Editor chat"], ["terminal", "Terminal"]], 'data-launchers="vscode cursor"')}
            ${select("cursorChat", "Chat agent", cfg.launch.cursorChat, [["cursor", "Cursor"], ["claude", "Claude Code extension"]], 'data-launchers="cursor" data-chat-only')}
            ${select("terminal", "Terminal", cfg.launch.terminal, [["terminal", "Terminal"], ["iterm", "iTerm"], ["warp", "Warp"], ["none", "None — create worktrees only"]], 'data-launchers="worktrunk git vscode cursor" data-terminal-only')}
            <div data-launchers="git vscode cursor">${text("worktreesDir", "Worktree folder", cfg.launch.worktreesDir)}</div>
            ${check("background", "Open work in the background", cfg.launch.background, "launch")}
            <details class="advanced-options"><summary>Advanced launch options</summary>${text("base", "Base branch", cfg.launch.base, 'placeholder="Repository default"')}${check("fetch", "Fetch origin before creating worktrees", cfg.launch.fetch, "launch")}</details>`)}
        </section>
        <section id="ai" class="settings-panel" data-settings-panel>
          ${save("ai", "AI settings", `<p class="muted">Configure ticket triage and when a repository choice needs your review.</p>
            ${select("provider", "Triage provider", cfg.llm.provider, [["cli", "Claude Code — uses your login"], ["api", "Anthropic API"]])}
            <p class="small muted">Changing provider takes effect after a restart.</p>${text("model", "Model", cfg.llm.model, "required")}
            ${number("lowConfidenceThreshold", "Require repo review below this confidence", cfg.lowConfidenceThreshold, 'min="0" max="1" step="0.05"')}<p class="small muted">0.5 means 50%. Tickets below this threshold must be reviewed before launch.</p>`)}
        </section>
        <section id="advanced" class="settings-panel" data-settings-panel><h2>Advanced</h2><p class="muted">Diagnostics, updates, and local data.</p>
          ${metadata("service", "Checking background service…")}
          <div class="maintenance-grid">${action("/actions/check-updates", "Check for updates", "Checking…")}${action("/actions/recheck", "Refresh setup checks", "Checking…")}${action("/actions/restart", "Restart Autopilot", "Restarting…")}${action("/actions/setup-again", "Run setup again", "Opening…")}${action("/banners/restore", `Show dismissed tips (${d.dismissedTips})`, "Showing…")}</div>
          <details class="advanced-options"><summary>Local files</summary><dl class="facts"><dt>Config</dt><dd><code>${esc(d.paths.config)}</code></dd><dt>Data</dt><dd><code>${esc(d.paths.home)}</code></dd><dt>Log</dt><dd><code>${esc(d.paths.log)}</code></dd></dl></details>
          <details class="danger"><summary>Danger zone — reset or erase data</summary><p class="small muted">Reset clears unlaunched tickets and triages them again. Launched work is kept.</p>${action("/actions/reset", "Reset unlaunched tickets", "Resetting…", "ghost-danger")}
            <form method="post" action="/actions/erase">${tokenField}<p class="small muted">Erase removes every ticket, brief and dismissed tip for both trackers. Sign-ins, worktrees and branches stay.</p><label class="check"><input type="checkbox" name="resetSettings"> Also reset settings</label><label class="check"><input type="checkbox" name="confirm" required> Yes, erase all local ticket data</label><button class="ghost-danger" data-busy-label="Erasing…">Erase all data</button></form>
          </details>
        </section>
      </div>
    </div>`;
}
