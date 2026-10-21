import { esc } from "./escape";
import { statusPicker } from "./components/status-picker";
import { STEPS, doneSteps, type SetupData, type StepId } from "../setup";

export function setupBody(d: SetupData): string {
  const done = doneSteps(d);
  const at = STEPS.findIndex((s) => s.id === d.step);
  const nav = STEPS.map((s, i) => {
    const state = s.id === d.step ? "current" : done.has(s.id) ? "done" : "";
    return `<li class="${state}"><a href="/setup?step=${s.id}">${done.has(s.id) && s.id !== d.step ? "✓" : i + 1}. ${esc(s.title)}</a></li>`;
  }).join("");
  const body = { repos, github, tracker, statuses, start }[d.step](d);
  return `<div class="top"><div class="brand"><div class="logo">A</div><div><h1>Set up Autopilot</h1>
      <div class="muted small">Step ${at + 1} of ${STEPS.length}</div></div></div></div>
    <ol class="steps">${nav}</ol>
    ${d.error ? `<div class="alert">${esc(d.error)}</div>` : ""}
    ${d.notice ? `<div class="notice">${esc(d.notice)}</div>` : ""}
    <section class="box setup">${body}</section>`;
}

const back = (step: StepId) => {
  const i = STEPS.findIndex((s) => s.id === step);
  return i > 0 ? `<a class="btn" href="/setup?step=${STEPS[i - 1].id}">Back</a>` : "";
};

function repos(d: SetupData): string {
  const tilde = (p: string) => p.startsWith(d.homeDir + "/") ? `~${p.slice(d.homeDir.length)}` : p;
  const suggested = new Set(d.suggestions.map((s) => s.path));
  const preview = (names: string[]) => esc(names.slice(0, 5).join(", ") + (names.length > 5 ? `, +${names.length - 5} more` : ""));
  const boxes = d.suggestions
    .map((s) => `<label class="opt wide"><input type="checkbox" name="root" value="${esc(s.path)}"${d.cfg.repoRoots.includes(s.path) ? " checked" : ""}>
      <span><strong>${esc(tilde(s.path))}</strong> <span class="muted small">${s.repos.length} repo${s.repos.length === 1 ? "" : "s"}: ${preview(s.repos)}</span></span></label>`)
    .join("");
  const otherRoots = d.cfg.repoRoots.filter((r) => !suggested.has(r));
  return `<h2>Where's your code?</h2>
    <p class="muted">Tickets are routed to these repos. Pick parent folders (every git repo directly inside is included) and/or individual repos.</p>
    <form method="post" action="/setup/repos">${d.tokenField}
      ${boxes ? `<label>Folders with git repos</label><div class="opts col">${boxes}</div>` : `<p class="muted small">No folders with git repos found in your home folder; add them below or with Finder.</p>`}
      <label for="moreRoots">Other parent folders (one per line)</label>
      <textarea id="moreRoots" name="moreRoots" rows="2" placeholder="~/work">${esc(otherRoots.map(tilde).join("\n"))}</textarea>
      <label for="repoPaths">Individual repos, anywhere (one per line)</label>
      <textarea id="repoPaths" name="repoPaths" rows="2" placeholder="~/side/project">${esc(d.cfg.repoPaths.map(tilde).join("\n"))}</textarea>
      ${d.repos.length ? `<p class="muted small">Using ${d.repos.length} repo${d.repos.length === 1 ? "" : "s"}: ${preview(d.repos.map((r) => r.name))}</p>` : ""}
      <div class="row setup-actions"><button class="primary" data-busy-label="Saving…">Continue</button></div>
    </form>
    <form method="post" action="/actions/pick-folders" class="row">${d.tokenField}<input type="hidden" name="from" value="setup">
      <button data-busy-label="Waiting for Finder…">Choose in Finder…</button><span class="muted small">Opens the macOS folder picker; a repo is added on its own, any other folder as a parent folder.</span></form>`;
}

function github(d: SetupData): string {
  const terminal = (cmd: "install" | "login", label: string, cls = "") =>
    `<form method="post" action="/setup/gh-terminal">${d.tokenField}<input type="hidden" name="cmd" value="${cmd}"><button class="${cls}" data-busy-label="Opening Terminal…">${label}</button></form>`;
  const intro = `<h2>GitHub</h2>
    <p class="muted">Autopilot follows each ticket's commits and pull requests with the GitHub CLI (<code>gh</code>), so it's required. Pick the account that can see your work repos.</p>`;
  const recheck = `<a class="btn" href="/setup?step=github">Check again</a>`;
  if (!d.gh.installed) {
    return `${intro}<div class="alert">The GitHub CLI isn't installed.</div>
      <div class="row setup-actions">${terminal("install", "Install and sign in (opens Terminal)", "primary")}${recheck}</div>
      <p class="muted small">Runs <code>brew install gh &amp;&amp; gh auth login</code> in a Terminal window. Come back here when it's done.</p>
      <div class="row setup-actions">${back("github")}</div>`;
  }
  if (!d.gh.accounts.length) {
    return `${intro}<div class="alert">You're not signed in to GitHub in <code>gh</code> yet.</div>
      <div class="row setup-actions">${terminal("login", "Sign in to GitHub (opens Terminal)", "primary")}${recheck}</div>
      <p class="muted small">Runs <code>gh auth login</code>; follow its prompts, then click Check again.</p>
      <div class="row setup-actions">${back("github")}</div>`;
  }
  const selected = d.gh.accounts.some((a) => a.name === d.cfg.githubUser) ? d.cfg.githubUser : d.gh.accounts.find((a) => a.active)?.name ?? d.gh.accounts[0].name;
  const radios = d.gh.accounts
    .map((a) => `<label class="opt wide"><input type="radio" name="githubUser" value="${esc(a.name)}"${a.name === selected ? " checked" : ""} required>
      <span><strong>${esc(a.name)}</strong>${a.active ? ` <span class="muted small">gh's active account</span>` : ""}</span></label>`)
    .join("");
  return `${intro}
    <form method="post" action="/setup/github">${d.tokenField}
      <div class="opts col">${radios}</div>
      <p class="muted small">Pinned, so switching gh's active account later doesn't change what Autopilot sees.</p>
      <div class="row setup-actions">${back("github")}<button class="primary" data-busy-label="Saving…">Continue</button></div>
    </form>
    <div class="row" style="margin-top:12px">${terminal("login", "Add another account")}<span class="muted small">Opens Terminal with <code>gh auth login</code>.</span></div>`;
}

function tracker(d: SetupData): string {
  const intro = `<h2>Your issue tracker</h2>
    <p class="muted">Autopilot reads tickets assigned to you. You sign in on the tracker's own page; the credentials stay in the macOS Keychain.</p>`;
  if (d.signingIn) {
    return `${intro}<div class="step" id="signin-wait"><span class="spinner"></span><span>Waiting for you to approve ${esc(d.trackerLabel)} access in the browser tab that just opened…</span></div>`;
  }
  const connect = (kind: "linear" | "jira", label: string, extra = "") =>
    `<form method="post" action="/actions/switch-tracker" class="connect-option">${d.tokenField}<input type="hidden" name="tracker" value="${kind}">
      <input type="hidden" name="signin" value="1"><input type="hidden" name="from" value="setup">${extra}
      <button class="${d.cfg.tracker === kind ? "primary" : ""}" data-busy-label="Opening ${label}…">${d.account && d.cfg.tracker === kind ? "Use a different account" : `Connect ${label}`}</button></form>`;
  const jiraSite = `<input type="text" name="jiraSite" value="${esc(d.cfg.jira.site)}" placeholder="Jira site, if you have several (acme.atlassian.net)" aria-label="Jira site">`;
  const signedIn = d.account
    ? `<div class="notice">Signed in to ${esc(d.trackerLabel)} as <strong>${esc(d.account.name)}</strong>${d.account.email ? ` (${esc(d.account.email)})` : ""}.</div>`
    : "";
  return `${intro}${signedIn}
    <div class="connect-grid">
      <div><h3>Linear</h3>${connect("linear", "Linear")}</div>
      <div><h3>Jira Cloud</h3>${connect("jira", "Jira", jiraSite)}<p class="muted small">Your site's admin may need to allow Atlassian's MCP server.</p></div>
    </div>
    <div class="row setup-actions">${back("tracker")}${d.account ? `<a class="btn primary" href="/setup?step=statuses">Continue</a>` : ""}</div>`;
}

function statuses(d: SetupData): string {
  if (!d.account) {
    return `<h2>Which tickets?</h2><div class="alert">Sign in to your tracker first, so its statuses can be listed.</div>
      <div class="row setup-actions"><a class="btn primary" href="/setup?step=tracker">Back to the tracker</a></div>`;
  }
  const t = d.trackerLabel;
  return `<h2>Which tickets?</h2>
    <p class="muted">Tickets assigned to you are picked up when they enter one of these ${esc(t)} statuses.</p>
    <form method="post" action="/setup/statuses" class="settings">${d.tokenField}
      <label>Pick up and triage tickets in</label>
      ${statusPicker("pickupStates", d.cfg.pickupStates, d.statuses, "Usually the status that means “ready to start”. None ticked = any open status.", t)}
      <label>Also show my tickets in</label>
      ${statusPicker("importStates", d.cfg.importStates, d.statuses, "Work already under way: shown under In progress without triage, linked to its worktree.", t)}
      <label class="check"><input type="checkbox" name="importWorktrees"${d.cfg.importWorktrees ? " checked" : ""}> Also show tickets named in existing worktree branches</label>
      <div class="row setup-actions">${back("statuses")}<button class="primary" data-busy-label="Saving…">Continue</button></div>
    </form>`;
}

function start(d: SetupData): string {
  const { cfg } = d;
  const minutes = Math.round(cfg.pollIntervalSeconds / 60);
  const picks = cfg.pickupStates.length ? cfg.pickupStates.map((s) => `“${esc(s)}”`).join(" or ") : "any open status";
  const launcher = { supacode: "Supacode", worktrunk: "Worktrunk", git: "git", vscode: "VS Code", cursor: "Cursor" }[cfg.launch.launcher];
  return `<h2>How it works</h2>
    <ol class="how">
      <li><strong>Watches ${esc(d.trackerLabel)}</strong> every ${minutes} minutes for tickets assigned to you in ${picks}.</li>
      <li><strong>Triages each one</strong> with Claude: picks the repo it touches (plus any others), proposes a branch, and writes a short explainer.</li>
      <li><strong>Asks you first.</strong> Each ticket shows up here as a card, with a notification, to approve or reject. Nothing starts without your click.</li>
      <li><strong>Launches on approve:</strong> a worktree per repo with ${esc(launcher)}, and a Claude Code session that starts from the ticket brief.</li>
      <li><strong>Tracks the work:</strong> commits and pull requests (as ${esc(cfg.githubUser || "gh's active account")} on GitHub) until they're merged.</li>
    </ol>
    <p class="muted small">Your ${d.repos.length} repo${d.repos.length === 1 ? "" : "s"}, launcher, terminal and more are in Settings (⚙) whenever you want to change them.</p>
    <form method="post" action="/setup/finish">${d.tokenField}
      <div class="row setup-actions">${back("start")}<button class="primary" data-busy-label="Starting…">Start Autopilot</button></div>
    </form>`;
}
