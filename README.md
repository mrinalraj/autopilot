# autopilot

A local macOS daemon that turns Linear or Jira tickets into Claude Code sessions, with you approving each one.

[Changelog](CHANGELOG.md) · [Maintaining and reusing release notes](docs/changelog.md)

It watches your tracker (Linear, or Jira Cloud) for tickets assigned to you in **Ready for Development**. For each one it picks
the repo among the ones you picked (parent folders and/or individual repos), plus any other repos the ticket also changes. It proposes a branch,
writes a short explainer, then asks you to approve or reject it on a local web page. When you
approve, the launcher selected in Settings creates a worktree on that branch in every repo involved.
Its own worktree creation and lifecycle hooks run. A Claude Code session opens in the primary repo with the other worktrees added, so
the agent can change them all. After that, the page tracks the work until the PRs are merged.

```
Linear or Jira (MCP, OAuth) ──▶ newly eligible ticket ──▶ triage: repo + branch, explainer (claude -p)
   ──▶ SQLite row + read-only brief ──▶ macOS notification ──▶ http://localhost:4747
   ──▶ Approve ──▶ per repo: selected launcher creates or reuses a worktree
   ──▶ selected launcher opens Claude in the primary worktree, with the brief and other worktrees
   ──▶ In progress: commits, PR state (git + gh) ──▶ merged
```

## Install (Homebrew)

```sh
brew install mrinalraj/tap/autopilot
brew services start autopilot   # runs at login, restarts on crash
open http://localhost:4747      # first-run setup
```

The first visit walks through setup, and nothing is checked until it's done:

1. **Repos:** parent folders (every git repo directly inside) and/or individual repos. Folders in
   your home that hold repos are suggested, and **Choose in Finder** opens the macOS folder picker.
2. **GitHub:** the `gh` account that can see your work repos. `gh` is required for tracking commits
   and PRs; if it's missing or signed out, a button opens Terminal with `brew install gh` /
   `gh auth login`.
3. **Tracker:** Linear or Jira Cloud, signed in through the tracker's own page.
4. **Statuses:** which statuses mean "pick this up", and which count as work already under way.
5. **How it works:** a short overview, then **Start Autopilot**.

Settings → Maintenance → **Run setup again** goes through it again; `autopilot login` signs in from
the terminal. Upgrading from `linear-autopilot` keeps
your data, settings and sign-in: they move to the new name on first start.

The formula pulls in `terminal-notifier` and `gh`. `launchd` and `osascript` are part
of macOS. Under `brew services`, logs go to `$(brew --prefix)/var/log/autopilot.log`.

To install your own build instead, run `scripts/brew-install-local.sh` (builds, then installs from
a local tap).

## Quick start

Requirements: macOS, your selected launcher, the Claude Code CLI (logged in), and `gh` (logged in) for
PR tracking.

With the standalone binary (from a release, or `bun run build`):

```sh
autopilot login              # one-time browser OAuth to your tracker; tokens go to the Keychain
autopilot once               # one poll in the foreground to check the setup
autopilot service install    # LaunchAgent: starts at login, restarts on crash
autopilot open
```

The binary keeps its config, state and logs in `~/Library/Application Support/autopilot/`
(`autopilot paths` shows them). Copy `config.example.json` there as `config.json` to
customise it.

From source, which needs [Bun](https://bun.sh) and keeps everything in the project folder:

```sh
bun install
cp config.example.json config.json
bun run login && bun run once
bun run cli service install
```

On the very first poll, the tickets already waiting in your pickup statuses are triaged straight
away. If that's a big backlog, set `processExistingOnFirstRun` to `false` first: they're then only
recorded, and only tickets that arrive later are proposed.

### Install as an app (PWA)

The page is an installable web app, with its own window and Dock icon.

- **Chrome:** open http://localhost:4747 and click the install icon in the address bar (or ⋮ → Cast,
  save and share → Install page as app).
- **Safari:** File → Add to Dock.

Use `localhost`, not `127.0.0.1`: the installed app is tied to the exact address. Once installed:

- the Dock icon shows a badge with the number of tickets awaiting approval
- if the daemon is down, the app shows a short "isn't running" page with the restart command and
  reconnects on its own.

For notifications that open the page when clicked:

```sh
brew install terminal-notifier
terminal-notifier -title autopilot -message test   # click Allow once
```

If no permission prompt appears, enable it under System Settings → Notifications → terminal-notifier.
Without terminal-notifier, notifications fall back to plain osascript ones that can't open the page.

## Using the page

http://localhost:4747 opens with **setup tips** for anything missing:

| Tip | Type |
| --- | --- |
| Claude Code CLI | required |
| Selected launcher | required (Supacode, Superset, Worktrunk, git, VS Code or Cursor) |
| GitHub CLI login, for PR tracking | optional |
| terminal-notifier, or its notification permission | optional |
| Installing the page as an app | optional |

Required tips stay until fixed. Optional ones can be dismissed with ×, and stay dismissed across
browsers and restarts; "Show N dismissed tips" brings them back. A tip disappears on its own once
the problem is fixed. The checks rerun every 10 minutes and on **Poll now**.

Below the tips, the page has these sections.

Launched tickets, and work found elsewhere (see Importing existing work), are grouped by phase:

| Section | A ticket lands here when |
| --- | --- |
| In progress | it doesn't meet In review or Completed |
| In review | Linear says In Review, or a PR is open |
| Completed (collapsible) | Linear says done or canceled, or every touched repo's PR is merged or closed |

Each card shows the live Linear status. The ⚙ button opens **Settings**.

- **Awaiting approval:** one card per triaged ticket, showing repo, branch, size, a repo-confidence
  meter and a summary.
  - **Approve** launches right away.
  - **Reject** dismisses the ticket.
  - Clicking anywhere else on the card opens a modal with the verbatim ticket and comments, the
    explainer, and editable fields: primary repo, **Also change** checkboxes for other repos
    (pre-ticked with the model's suggestions), and branch. Esc closes it.
  - Extra repos show as dashed `+ repo` pills on the card.
  - Cards with low repo confidence (below 0.6) show **Review** instead of Approve, so you check the
    repo in the modal first.
- **In progress:** tickets you've approved. Each card shows its stage:
  - in progress → committed → draft PR / PR open
  - plus the PR number, commits ahead of `origin/main`, uncommitted files and the time of the last commit
  - with buttons for the PR on GitHub and **Open worktree**, which opens it with your selected launcher.
  - For multi-repo tickets: one line and one PR button per repo. The overall stage ignores repos the
    agent never touched, and the ticket is done once every touched repo's PR is merged or closed.
- **Completed** (collapsible): every launched ticket whose PRs are merged or closed, or whose
  worktrees are gone, with links to its PRs.
- **Rejected & dismissed** (collapsible): rejected tickets, and *dismissed* tickets, meaning ones
  that left Ready for Development or were reassigned before you acted.
- **Delete worktrees…** (in a launched ticket's modal): removes its worktrees through your selected launcher,
  which also closes the Claude session in them. Before deleting, each worktree is re-checked. If
  any has uncommitted files or unpushed commits (or its state can't be read), the delete is refused
  unless you tick "delete anyway". A merged or closed PR counts as safe. The branch and PR are
  kept, and PR tracking carries on.
- **Update available** banner: see Updates.

While a poll or triage is running, a progress bar shows which ticket is being processed (for
example "Triaging ENG-2417 · 2 of 4"). The page updates itself, but never reloads while a modal is
open. **Poll now** checks Linear and refreshes PR state immediately.

## Settings

⚙ opens the settings page. Saving writes `config.json` and applies immediately; only the LLM
backend needs a restart.

| Section | What you can set |
| --- | --- |
| Linear | Statuses that trigger pickup, and statuses to show without triage (picked from your teams' real statuses); the worktree scan on/off; **ticket prefixes** to recognise in branch names (default: your Linear teams' keys) |
| Polling | How often to check Linear, and how often to check commits and PRs |
| Launch | Launcher, terminal, worktree folder, base branch, fetch before creating, open in the background, move the ticket to In Progress |
| Repos | **Parent folders** (every repo directly inside) and/or **individual repos** (anywhere), combined; **Choose in Finder** adds more; per repo, include or exclude it and its description |
| Triage | LLM backend and model; the low-confidence threshold |
| GitHub | The `gh` account used for PR tracking |
| Maintenance | Poll now, Reset tickets (triages again straight away), re-run setup checks, show dismissed tips, check for updates, restart, and where config, data and logs live |

## Launchers

| Launcher | Creates worktrees with | Claude session opens in |
| --- | --- | --- |
| Supacode (default) | `supacode repo worktree-new` (Supacode's hooks run) | a Supacode tab |
| Superset | `superset workspaces create --local` (Superset manages setup and worktrees) | a Superset terminal |
| Worktrunk | `wt switch --create` (Worktrunk's hooks run) | a new terminal tab |
| git | `git worktree add` into `<first repo folder>/wt/<repo>/<branch>` | a new terminal tab |
| VS Code / Cursor | git, as above; opens a new editor window with the ticket's worktrees | the editor's **chat panel** (default) or a new terminal tab |

**Superset:** open the desktop app and sign in. It includes the CLI and starts its local host
automatically, so you don't need to keep a separate terminal open. For a CLI-only installation,
install the [Superset CLI](https://docs.superset.sh/cli/getting-started), sign in, and run
`superset start --daemon` to start the host in the background. Choose **Settings → Launch →
Superset**. Autopilot checks connectivity through the local projects API, since `superset status`
can report a stale process for a working desktop host. It reuses a registered project for each local repo, registering it on
first use if necessary, and creates one local workspace per repo with the exact ticket branch.
The Claude terminal starts in the primary workspace with the brief and extra worktrees available
through `--add-dir`. Background launches leave focus alone; foreground launches open Superset.
Ticket links reopen the matching workspace. Existing worktrees are registered in Superset in place
without rerunning setup scripts. On another machine, use `superset projects setup` to attach an existing
organization project before approving tickets, to avoid registering a duplicate.

`launch.supersetBin` defaults to `superset`; set an absolute CLI path in `config.json` if needed.
The daemon also searches the desktop app's `~/.superset/bin` and the standalone install's
`~/superset/bin`. Superset owns the worktree location and lifecycle scripts. Cleanup uses
`superset workspaces archive --local` after the same unsaved/unpushed-work checks as other launchers;
the branch stays. Changing the launcher also applies to existing tickets.

**Chat panel (VS Code, Cursor):**
- **Workspace:** the editor opens a workspace with the ticket's worktrees plus a small folder holding
  only its brief, so Claude can read it without asking.
- **Prompt:** the chat opens with the init prompt pre-filled; press Enter to start. Neither editor
  allows auto-sending.
- **VS Code** uses the Claude Code extension (`vscode://anthropic.claude-code/open`), so the
  extension must be installed, and a setup tip says so if it isn't.
- **Cursor** uses Cursor's own chat by default (`cursor://anysphere.cursor-deeplink/prompt`), or the
  Claude Code extension (`cursor://anthropic.claude-code/open`, which works in practice but isn't
  documented by Anthropic for Cursor).
- **Timing:** the prompt goes to the editor's focused window, so avoid switching windows for the
  couple of seconds while it opens.

Changing **Settings → Launch → Launcher** also reconfigures existing tickets. Worktrees keep their
paths, branches and files, including uncommitted changes; the selected adapter registers them in
place. Links, new launches, retries and cleanup all use the selection. Failed registration retries
automatically every 30 seconds, even if the issue tracker is unavailable. Successful setup is
remembered across restarts and does not rerun or start sessions. Errors appear on the ticket;
Autopilot never opens the previous tool as a fallback. Open pages refresh when the selection
changes. Existing terminal processes remain where they are. Launcher changes wait until an active
ticket operation finishes.

Terminal tabs start in the primary worktree:

| Terminal | Behavior |
| --- | --- |
| Terminal | Runs `claude`. Opens a new tab via ⌘T, which needs a one-time Accessibility permission; otherwise a new window. |
| iTerm | Runs `claude` in a new tab. |
| Warp | Opens a tab with Warp's own `warp://action/new_tab?path=…`. Warp can't be told to run a command, so the `claude` command is copied to your clipboard and a notification says so. |
| none | Only creates the worktrees. |
- **Selected for every ticket:** **Delete worktrees…** uses the currently selected adapter after
  registering existing worktrees with it when necessary. Supacode, Superset and Worktrunk keep the branch;
  git uses `git worktree remove`.
- **First use of Terminal or iTerm:** macOS asks once whether autopilot may control it.

## Editing triage

In ticket details, edit the summary, approach, likely code areas and size directly in the triage
box. **Update** saves the explanation and session brief. **Approve & launch** also saves the current
edits before launching, so you don't need to click Update first. A failed save prevents launch.
Future launches and prompt resends use the saved text. Existing agent conversations are not changed automatically.
Edits remain in the form if a save fails, and an older form cannot overwrite newer triage.

## Importing existing work

On every poll, two kinds of existing work are added under the phase sections, without triage or LLM
calls:

- **Your tickets in the "also show" statuses** (default *In Development*).
- **Any worktree whose branch or folder names a ticket** of one of your Linear teams, for example
  `fix-tab-eng-4821` or `eng-6150`.

A ticket's worktrees in several repos are grouped into one ticket. A ticket with no worktree still
shows, with its Linear status only. Imported Superset worktrees get Superset links and cleanup;
each extra repo retains its own branch. Worktree discovery reads git without starting other tools;
registration uses only the selected launcher.

Imported tickets retain their tracker status and existing work. Their cards and details show
progress and links without manual triage, session creation or launcher setup controls.

## Commands

`autopilot <command>` (from source: `bun run cli <command>`):

| Command | What it does |
| --- | --- |
| `start` | Run the daemon and page in the foreground (what the service runs). Don't run it alongside the service: they share the port. |
| `once` | One poll and triage pass, then exit. |
| `login [--force]` | Browser OAuth to Linear. `--force` discards stored credentials first. |
| `reset` | Clear every ticket that hasn't been launched (pending, failed, rejected, dismissed) and its brief, then queue the tickets eligible right now for a fresh triage. Launched tickets and their PR tracking are kept. Click **Poll now** afterwards to triage straight away. Safe while the daemon runs. |
| `update [--check]` | Install the latest release (`--check` only reports). |
| `service install` / `uninstall` / `restart` / `status` | Manage the LaunchAgent `dev.autopilot`. Run `install` again after moving the binary. |
| `open` / `paths` / `version` | Open the page; show where config, state and logs live; print the version. |

Development: `bun test`, `bun run typecheck`, `bun run build`.

Logs: `logs/autopilot.log` under the home folder (not rotated). Health check:
`curl localhost:4747/healthz`.

## Updates

The daemon checks GitHub Releases (`repository` in `package.json`) once a day. When a newer
version exists, the page shows an **Update available** banner with the release notes.

- **Standalone binary:** **Update now** downloads this Mac's build and checks its SHA-256 against
  the release's `checksums.txt`. It also confirms the new binary reports the expected version
  before swapping it in place. The service then restarts into it.
- **Homebrew install:** the button runs `brew upgrade autopilot`.
- **Running from source:** the banner just says to `git pull`.

Nothing installs without a click. `autopilot update --check` does the same check from the
command line.

## Building and releasing

`bun run build` (`scripts/build.sh`) compiles standalone binaries for Apple Silicon and Intel into
`dist/`:

- `autopilot-<version>-darwin-{arm64,x64}.tar.gz`, each containing the `autopilot`
  binary with the PWA assets embedded
- `checksums.txt`

To release, bump `version` in `package.json`, build, and attach those three files to a GitHub
release tagged `v<version>`. The updater relies on exactly these names.
Then run `scripts/brew-formula.sh`, which writes `packaging/autopilot.rb` with the release
URLs, and copy it to `Formula/` in the [tap repo](https://github.com/mrinalraj/homebrew-tap).

## How it works

**Linear access.** Linear is read through its hosted MCP server (`https://mcp.linear.app/mcp`) with
OAuth: PKCE plus dynamic client registration. This works in workspaces that don't allow personal API
keys. Tokens live in the macOS Keychain and refresh automatically.

**Detection.** Every `pollIntervalSeconds` (default 20 minutes), the daemon makes one `list_issues`
call for issues updated since the last poll, minus 5 minutes of overlap. A ticket is *eligible* when
it's open, assigned to you, and in one of `pickupStates`. It's proposed when it **becomes**
eligible: either it's assigned to you while already Ready, or one of your tickets moves into Ready.
A pending ticket that stops being eligible is dismissed. Only the state at each poll is compared, so
a ticket that leaves and re-enters within one interval isn't noticed. Use `bun run reset` in that case.

**Triage.** For a newly eligible ticket the daemon fetches the full issue and all comments, then
makes two `claude -p` calls with JSON-schema output:

- **resolve:** the primary repo (where most of the code changes), confidence, any **additional
  repos** that also need code changes (each with a one-line reason; repos that would only be read
  for reference aren't listed), and one branch name used in every repo.
- **explain:** summary, approach, likely areas and size (S/M/L).

The repo must exist in the catalog: the git repos in your parent folders plus the individual ones, each with a description from
`config.json` or derived from its README. The branch must match `<2–5 word slug>-<identifier>`, for
example `fix-chart-zero-division-eng-2203`. An invalid branch name is repaired deterministically.

**State.** SQLite (`state/autopilot.sqlite`) is the single source of truth. Each ticket also gets a
read-only Markdown **brief** (`state/briefs/ENG-1234.md`) rendered from its row: the verbatim
ticket and comments, the explainer, the repo and the branch. It's rewritten when you edit the
repo or branch, and deleted on reject.

**Launch.** Approving saves your edits and rewrites the brief, then:

1. Create the primary and extra worktrees in parallel through the selected adapter, fetching
   with your own git when enabled. Reuse existing branches and worktrees on retry.
2. The brief is rewritten with every worktree path.
3. Open Claude through the selected adapter in the primary worktree. Claude runs in normal
   permission mode. The init prompt tells it to read the
   brief and names the other worktrees, with one PR per repo.

If something fails, the card shows the error and a **Retry launch** button. A retry reuses the
worktree if it was already created.

**Tracking.** Every `workCheckIntervalSeconds` (default 5 minutes), each of a launched ticket's
worktrees is read with `git` (commits ahead, uncommitted files, last commit), and its PR with
`gh pr list --head <branch>`. Both are read-only.

**Restarts.** Tracking state and the poll cursor live in SQLite, so a restart never re-notifies. A
launch interrupted by a restart comes back as `failed`, ready to retry.

## Configuration

`config.json` overrides the defaults in `src/config/config.ts`. Relative paths are resolved from the
project directory, and `~` is expanded.

| Key | Default | Notes |
| --- | --- | --- |
| `tracker` | `"linear"` | `"linear"` or `"jira"` (Jira Cloud). Each keeps its own tickets, briefs and sign-in; switch in Settings. |
| `jira.site` | `""` | Which Jira site, when your Atlassian account reaches several (e.g. `acme.atlassian.net`). |
| `jira.pickupStates` / `jira.importStates` | as below | Jira's own status lists; Jira status names rarely match Linear's. |
| `pollIntervalSeconds` | `1200` | Tracker poll interval. **Poll now** triggers one immediately. |
| `workCheckIntervalSeconds` | `300` | Commit and PR check interval for launched tickets. |
| `pickupStates` | `["Ready for Development"]` | Linear status names (case-insensitive) that make an assigned ticket eligible. `[]` = any open state. |
| `port` | `4747` (`4800` from source) | Web page; binds to `127.0.0.1` only. |
| `oauthCallbackPort` | `4748` | Loopback redirect used by `bun run login`. |
| `repoRoots` | `[]` | Parent folders; every git repo directly inside each is a launch target. Older configs' `reposRoot` / `repoMode` migrate to this. |
| `repoPaths` | `[]` | Individual repos, anywhere; combined with `repoRoots`. |
| `onboarded` | `false` on a new install | Set by first-run setup; nothing is polled before. Configs from before setup existed count as done. |
| `stateDir` / `briefsDir` | `./state` / `./state/briefs` | `./state/jira` for Jira. |
| `githubUser` | `""` | GitHub account used for PR tracking. Empty means `gh`'s active account. Set it if you keep several `gh` logins, so switching accounts doesn't break tracking. When the account changes (here, or gh's active one when this is empty), the next check re-reads every ticket's PRs, completed ones included. |
| `linearUserId` | `""` | Empty = the logged-in Linear user. |
| `processExistingOnFirstRun` | `true` | Triage already-eligible tickets on the very first poll; `false` only records them. |
| `moveToInProgressOnApprove` | `false` | Moves the Linear issue to its team's started state after launch. Needs the write scope: run `bun run login --force` after enabling it. |
| `lowConfidenceThreshold` | `0.6` | Below this, the card asks for a review before approving. |
| `llm.provider` | `"cli"` | `"cli"` = `claude -p` with your Claude Code login. `"api"` = Anthropic SDK with `ANTHROPIC_API_KEY`. |
| `llm.model` | `"claude-opus-5-5"` | |
| `launch.fetch` | `true` | Run `git fetch origin` (with your git) before creating the worktree. |
| `launch.base` | `""` | Base branch for the selected launcher. Empty uses that tool's default. |
| `launch.background` | `false` | Create the worktree and tab without taking focus. |
| `repos.<name>.description` | derived | Repo description used for routing. Worth setting when a README is misleading. |
| `repos.<name>.exclude` | `false` | Leave a repo out of the catalog. |

## Credentials

| What | Where |
| --- | --- |
| Tracker OAuth tokens | Keychain, service `autopilot`, account `linear-mcp-oauth` or `jira-mcp-oauth` (with `-dev` appended when running from source). Written by `autopilot login` or Settings → Sign in. |
| Claude (triage) | Your Claude Code login (`llm.provider: "cli"`). |
| `ANTHROPIC_API_KEY` | Only for `llm.provider: "api"`. Taken from the environment, or from the Keychain (service `autopilot`, account `ANTHROPIC_API_KEY`; add it with `security add-generic-password -s autopilot -a ANTHROPIC_API_KEY -w`). |
| GitHub (PR tracking) | Your `gh` login: the account named in `githubUser` (its token is read with `gh auth token -u` and kept in memory only), or the active account. |

Secrets are never written to config, logs, briefs or SQLite.

## Security

Ticket text is untrusted, and it ends up in front of an agent with shell access.

- **Triage calls** run `claude -p --tools "" --strict-mcp-config --setting-sources ""`, so an
  injected instruction has nothing to act with. The model's repo and branch are validated before
  use.
- **The brief** quotes the ticket verbatim inside code fences longer than any backtick run in it, so
  the text can't break out into the surrounding Markdown. The file is read-only and regenerated from
  the database.
- **The launched session** runs in normal permission mode, and its init prompt says the quoted ticket
  is untrusted.
- **The web page:**
  - HTML-escapes all ticket text.
  - Sends a strict CSP: only the page's own nonce'd script runs, and nothing loads from outside.
  - Answers only to `localhost` Host headers, which blocks DNS rebinding.
  - Requires a per-process CSRF token and a same-origin `Origin` on every POST.

## Troubleshooting

- **Keychain prompt for github.com when a worktree is created.** That comes from a git that isn't
  trusted for the Keychain item. Supacode runs `/usr/bin/git`, whose Xcode credential helper isn't
  on the trusted list. That's why the daemon fetches with your Homebrew git and never passes
  Supacode's `--fetch`.
- **"Linear login required"** on the page or in the log: run `bun run login`.
- **`forbidden origin` or `bad csrf token`:** reload the page. The CSRF token changes whenever the
  daemon restarts.
- **Page not loading after an install or restart:** check the log (`autopilot paths`). A second
  copy started by hand will fail to bind the port; `autopilot service status` shows whether
  the service is running.
- **No notifications:** allow terminal-notifier (see Quick start).
- **A ticket you expected isn't showing:** it must be assigned to you *and* in a `pickupStates`
  status, and it must have *become* eligible after the first poll. `bun run reset` re-queues
  everything eligible right now.

## Development

```sh
bun test            # unit tests plus an end-to-end run with a fake Linear, LLM and supacode binary
bun run typecheck
```

The directory boundaries and common edit paths are explained in [Architecture](docs/architecture.md).

| Path | Role |
| --- | --- |
| `src/cli.ts` | Stable command-line and compiled-binary entry point |
| `src/app/` | Polling, approval/launch orchestration, daemon, login, reset, health |
| `src/domain/` | Ticket/work types and pure rules: phases, risk, worktree identities |
| `src/config/` / `src/storage/` | Configuration validation/persistence / SQLite schema and queries |
| `src/trackers/` | Linear/Jira clients, tracker interface, MCP and OAuth provider |
| `src/triage/` | LLM calls, prompts, branch validation, brief I/O and separate Markdown template |
| `src/repos/` / `src/workspaces/` | Repo discovery/import / launchers, git and PR tracking |
| `src/platform/` / `src/updates/` | macOS and external-tool adapters / release checks and installation |
| `src/web/routes/` | Request handling and action dispatch; no page templates |
| `src/web/presenters/` | Build page data from application state |
| `src/web/views/` | HTML templates and components; no database, filesystem or subprocess access |
| `src/web/assets/` | CSS, browser live-update script and service worker |
| `src/web/server.ts` | HTTP composition, Host/Origin checks and CSRF protection |
| `src/web/pwa.ts` / `src/web/static.ts` | Manifest and embedded assets / allowlisted file responses |
| `src/shared/` / `src/types/` | Logging / asset import declarations |
| `public/icons/` | App icons embedded into the binary |
| `scripts/` | Release builds and Homebrew tooling |
| `test/` | Tests grouped by subsystem; fake services and shared data under `test/fixtures/` |

## License

MIT. See [LICENSE](LICENSE).
