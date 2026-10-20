# linear-autopilot

A local macOS daemon that turns Linear tickets into Claude Code sessions, with you approving each one.

It watches Linear for tickets assigned to you in **Ready for Development**. For each one it picks
the repo under `~/code`, plus any other repos the ticket also changes. It proposes a branch,
writes a short explainer, then asks you to approve or reject it on a local web page. When you
approve, Supacode creates a worktree on that branch in every repo involved (its own branch creation
and hooks run). A Claude Code session opens in the primary repo with the other worktrees added, so
the agent can change them all. After that, the page tracks the work until the PRs are merged.

```
Linear (MCP, OAuth) ──▶ newly eligible ticket ──▶ triage: repo + branch, explainer (claude -p)
   ──▶ SQLite row + read-only brief ──▶ macOS notification ──▶ http://localhost:4747
   ──▶ Approve ──▶ per repo: git fetch + supacode repo worktree-new --branch …
   ──▶ supacode tab new -i "claude '<init prompt>' --add-dir <briefs> <other worktrees…>"   (in the primary worktree)
   ──▶ In progress: commits, PR state (git + gh) ──▶ merged
```

## Quick start

Requirements: macOS, [Bun](https://bun.sh), the Supacode app, the Claude Code CLI (logged in), and
`gh` (logged in) for PR tracking.

```sh
bun install
cp config.example.json config.json   # adjust if needed (see Configuration)
bun run login                        # one-time browser OAuth to Linear; tokens go to the Keychain
bun run once                         # one poll in the foreground to check the setup
scripts/install-launchd.sh           # run as a LaunchAgent: starts on login, restarts on crash
open http://localhost:4747
```

On the very first poll, tickets that are *already* eligible are only recorded, not proposed, so
your backlog doesn't flood in. Run `bun run reset` if you do want them triaged.

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
terminal-notifier -title linear-autopilot -message test   # click Allow once
```

If no permission prompt appears, enable it under System Settings → Notifications → terminal-notifier.
Without terminal-notifier, notifications fall back to plain osascript ones that can't open the page.

## Using the page

http://localhost:4747 has three sections.

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
  - with buttons for the PR on GitHub and **Open worktree**, which jumps to it in Supacode.
  - For multi-repo tickets: one line and one PR button per repo. The overall stage ignores repos the
    agent never touched, and the ticket is done once every touched repo's PR is merged or closed.
- **Recent:** merged or closed PRs, rejected tickets, and *dismissed* tickets, meaning ones that
  left Ready for Development or were reassigned before you acted.

While a poll or triage is running, a progress bar shows which ticket is being processed (for
example "Triaging ENG-2417 · 2 of 4"). The page updates itself, but never reloads while a modal is
open. **Poll now** checks Linear and refreshes PR state immediately.

## Commands

| Command | What it does |
| --- | --- |
| `bun run start` | Run the daemon and page in the foreground. Don't run it alongside the LaunchAgent: they share the port. |
| `bun run once` | One poll and triage pass, then exit. |
| `bun run login [--force]` | Browser OAuth to Linear. `--force` discards stored credentials first. |
| `bun run reset` | Clear every ticket that hasn't been launched (pending, failed, rejected, dismissed) and its brief, then queue the tickets eligible right now for a fresh triage. Launched tickets and their PR tracking are kept. Click **Poll now** afterwards to triage straight away. Safe while the daemon runs. |
| `bun test` / `bun run typecheck` | Tests and type check. |
| `scripts/install-launchd.sh` / `scripts/uninstall-launchd.sh` | Install or remove the LaunchAgent `dev.linear-autopilot`. |
| `launchctl kickstart -k gui/$(id -u)/dev.linear-autopilot` | Restart the agent after changing code or config. |

Logs: `logs/autopilot.log` (not rotated). Health check: `curl localhost:4747/healthz`.

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

The repo must exist in the catalog: the git repos under `reposRoot`, each with a description from
`config.json` or derived from its README. The branch must match `<2–5 word slug>-<identifier>`, for
example `fix-chart-zero-division-eng-2203`. An invalid branch name is repaired deterministically.

**State.** SQLite (`state/autopilot.sqlite`) is the single source of truth. Each ticket also gets a
read-only Markdown **brief** (`state/briefs/ENG-1234.md`) rendered from its row: the verbatim
ticket and comments, the explainer, the repo and the branch. It's rewritten when you edit the
repo or branch, and deleted on reject.

**Launch.** Approving saves your edits and rewrites the brief, then:

1. For each extra repo, then the primary: `git fetch origin` with your own git, and
   `supacode repo worktree-new --branch <branch>`, which runs Supacode's branch creation and hooks.
   Extra worktrees are created in the background.
2. The brief is rewritten with every worktree path.
3. `supacode tab new -i "claude '<init prompt>' --add-dir state/briefs <extra worktrees…>"` in the
   primary worktree. Claude runs in normal permission mode. The init prompt tells it to read the
   brief and names the other worktrees, with one PR per repo.

If something fails, the card shows the error and a **Retry launch** button. A retry reuses the
worktree if it was already created.

**Tracking.** Every `workCheckIntervalSeconds` (default 5 minutes), each of a launched ticket's
worktrees is read with `git` (commits ahead, uncommitted files, last commit), and its PR with
`gh pr list --head <branch>`. Both are read-only.

**Restarts.** Tracking state and the poll cursor live in SQLite, so a restart never re-notifies. A
launch interrupted by a restart comes back as `failed`, ready to retry.

## Configuration

`config.json` overrides the defaults in `src/config.ts`. Relative paths are resolved from the
project directory, and `~` is expanded.

| Key | Default | Notes |
| --- | --- | --- |
| `pollIntervalSeconds` | `1200` | Linear poll interval. **Poll now** triggers one immediately. |
| `workCheckIntervalSeconds` | `300` | Commit and PR check interval for launched tickets. |
| `pickupStates` | `["Ready for Development"]` | Linear status names (case-insensitive) that make an assigned ticket eligible. `[]` = any open state. |
| `port` | `4747` | Web page; binds to `127.0.0.1` only. |
| `oauthCallbackPort` | `4748` | Loopback redirect used by `bun run login`. |
| `reposRoot` | `~/code` | Every git repo directly under it is a launch target. |
| `stateDir` / `briefsDir` | `./state` / `./state/briefs` | |
| `linearUserId` | `""` | Empty = the logged-in Linear user. |
| `processExistingOnFirstRun` | `false` | Triage already-eligible tickets on the very first poll. |
| `moveToInProgressOnApprove` | `false` | Moves the Linear issue to its team's started state after launch. Needs the write scope: run `bun run login --force` after enabling it. |
| `lowConfidenceThreshold` | `0.6` | Below this, the card asks for a review before approving. |
| `llm.provider` | `"cli"` | `"cli"` = `claude -p` with your Claude Code login. `"api"` = Anthropic SDK with `ANTHROPIC_API_KEY`. |
| `llm.model` | `"claude-opus-5-5"` | |
| `launch.fetch` | `true` | Run `git fetch origin` (with your git) before creating the worktree. |
| `launch.base` | `""` | Passed to `worktree-new --base`. Empty = Supacode's default. |
| `launch.background` | `false` | Create the worktree and tab without taking focus. |
| `repos.<name>.description` | derived | Repo description used for routing. Worth setting when a README is misleading. |
| `repos.<name>.exclude` | `false` | Leave a repo out of the catalog. |

## Credentials

| What | Where |
| --- | --- |
| Linear OAuth tokens | Keychain, service `linear-autopilot`, account `linear-mcp-oauth`. Written by `bun run login`. |
| Claude (triage) | Your Claude Code login (`llm.provider: "cli"`). |
| `ANTHROPIC_API_KEY` | Only for `llm.provider: "api"`. Taken from the environment, or from the Keychain (service `linear-autopilot`, account `ANTHROPIC_API_KEY`; add it with `security add-generic-password -s linear-autopilot -a ANTHROPIC_API_KEY -w`). |
| GitHub (PR tracking) | Your existing `gh` login. |

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
- **Page not loading after an install or restart:** check `logs/autopilot.log`. A second copy started
  with `bun run start` will fail to bind the port.
- **No notifications:** allow terminal-notifier (see Quick start).
- **A ticket you expected isn't showing:** it must be assigned to you *and* in a `pickupStates`
  status, and it must have *become* eligible after the first poll. `bun run reset` re-queues
  everything eligible right now.

## Development

```sh
bun test            # unit tests plus an end-to-end run with a fake Linear, LLM and supacode binary
bun run typecheck
```

| Path | Role |
| --- | --- |
| `src/main.ts` | Daemon entrypoint: web page, poll loop, work-check loop |
| `src/autopilot.ts` | Detection, triage, approve, reject, launch orchestration |
| `src/linear.ts` | Linear MCP client and Keychain OAuth provider |
| `src/login.ts` / `src/reset.ts` | `bun run login` / `bun run reset` |
| `src/triage.ts` / `src/llm.ts` | Triage prompts and schemas / `claude -p` and API backends |
| `src/branch.ts` | Branch name validation and repair |
| `src/brief.ts` | Brief rendering (DB row → Markdown) |
| `src/launch.ts` | git fetch and the Supacode CLI (deeplink fallback) |
| `src/work.ts` | Commit and PR tracking for launched tickets |
| `src/web.ts` | Approval page, live-update script, `/state`, PWA file routes |
| `public/` | PWA files: manifest, service worker, offline page, icons |
| `src/db.ts` | SQLite schema, migrations and queries |
| `src/catalog.ts` | Repo catalog |
| `src/notify.ts` / `src/keychain.ts` / `src/config.ts` / `src/log.ts` | Helpers |
| `scripts/` | `run.sh` (LaunchAgent entry), launchd install and uninstall |
| `test/` | Tests; `fake-supacode.sh` stands in for the Supacode CLI |
