# CLAUDE.md

autopilot (formerly linear-autopilot) is a local macOS daemon in Bun + TypeScript. It watches a
tracker (Linear, or Jira Cloud) for tickets assigned to the user in their pickup statuses, triages
each one with `claude -p` (repo, extra repos, branch, explainer), and asks for approval on a local
page. On approval it creates a worktree per repo through the chosen launcher (Supacode, Superset, Worktrunk,
git, VS Code or Cursor) and starts a Claude Code session with a ticket brief. It then tracks commits
and PRs until they're merged. README.md is the user-facing picture.

## Commands

```sh
bun test                 # must pass before you finish; fakes only, never real Linear/Jira/Supacode/Superset/gh
bun run typecheck        # tsc --noEmit
bun run start            # dev daemon on http://localhost:4800 (data in the project folder)
bun run once             # one real poll (needs a sign-in)
bun run build            # standalone binaries + tarballs + checksums.txt in dist/
AUTOPILOT_HOME=$PWD/.dev/fresh bun src/cli.ts start   # a throwaway home: walks first-run setup
```

`src/cli.ts` is the single entry point, from source and as the compiled binary (`start`, `once`,
`login [--force]`, `reset`, `update [--check]`, `open`, `service install|uninstall|restart|status`,
`paths`, `version`).

- **Installed app:** Homebrew (`brew install mrinalraj/tap/autopilot`) under `brew services`
  (label `sh.brew.autopilot`) on http://localhost:4747. Its data is in
  `~/Library/Application Support/autopilot/`, and its logs are at
  `$(brew --prefix)/var/log/autopilot.log`.
- **From source:** the default port is 4800, so `bun run start` runs alongside the installed app.
  Data lives in the project folder, and tracker sign-ins use their own Keychain entries
  (`<account>-dev`, see `oauthAccount`). Use `AUTOPILOT_HOME` for extra throwaway homes; `.dev/` is
  git-ignored for that.
- **Never `pkill -f "src/cli.ts start"`:** it also matches a real daemon started from source. Stop
  the specific process instead.

Config, state and logs live under `HOME_DIR` (`src/config/config.ts`):
- `AUTOPILOT_HOME` if set
- otherwise `~/Library/Application Support/autopilot` in the compiled binary. A
  `linear-autopilot` folder there is renamed on first start.
- otherwise the project folder when running from source.

Never derive paths from `import.meta.dir` elsewhere: inside the binary it's Bun's virtual filesystem.

## Architecture

See [docs/architecture.md](docs/architecture.md) for dependency boundaries and edit recipes.
Paths below are relative to `src/`.

| Module | Role |
| --- | --- |
| `app/autopilot.ts` / `app/daemon.ts` | Ticket workflows / composition and timers |
| `app/login.ts` / `app/reset.ts` / `app/health.ts` / `app/steps.ts` | Login workflow / reset / setup checks / live launch progress |
| `domain/` | Pure ticket/work rules and shared types; no I/O dependencies |
| `storage/db.ts` | SQLite schema, migrations and queries (single source of truth) |
| `trackers/` | Tracker interface/specs, clients, MCP session, Keychain OAuth provider |
| `triage/` | LLM integration, prompts, branch validation, brief writes; pure rendering in `brief-template.ts` |
| `repos/` | Catalog, worktree import and folder suggestions |
| `workspaces/` | Launchers, terminals, IDE chat, commits and PR inspection |
| `config/` | Defaults, migration, paths, settings validation and writes |
| `platform/` | Environment, Keychain, notifications, LaunchAgent, GitHub and folder-picker adapters |
| `updates/` / `shared/log.ts` | Release checks/installs and update state / logging |
| `web/server.ts` / `web/routes/` | HTTP security/composition / page and action handlers |
| `web/presenters/` / `web/models.ts` | Build display snapshots / view data contracts |
| `web/views/` / `web/assets/` | Pure HTML templates / CSS and browser scripts |
| `web/setup.ts` / `web/oauth-callback.ts` | Pure setup-step helpers / loopback OAuth HTTP adapter |
| `web/pwa.ts` / `web/static.ts` / `web/http.ts` | Manifest and embedded assets / static routes / HTTP response helpers |

Templates accept data, never `Autopilot`, `Store`, launchers or action callbacks. Backend services
must not import the web layer; `app/` is allowed to compose it. Pure rules shared with views go
in `domain/`, not in a service. `test/architecture.test.ts` checks these runtime boundaries.
Type-only imports for data contracts are permitted.

### Data

SQLite (`src/storage/db.ts`) is the single source of truth.

- **`issues`:** one row per ticket. Status is `pending | approved | rejected | running | failed`.
  - `triage_source` is `automatic | manual | null`; null marks imported summaries awaiting triage.
    Manual triage of open tickets without worktrees moves them to approval and bypasses pickup-state
    filtering, but reassignment or closing still dismisses them. Existing worktrees keep their ownership.
  - `approved` means a launch is in flight. A launch can't survive a restart, so those become
    `failed` on start.
  - Dismissed tickets are `rejected`, with an `error` starting with `Dismissed:`.
  - `repo` / `repo_path` / `worktree_id` belong to the primary repo. `extra_repos_json` holds the
    others (`ExtraRepo[]`, read with `Store.extras(row)`), each with its own `worktree_id` and
    optional branch override for imported worktrees.
  - `work_json` is `RepoWork[]`, primary first; read it with `Autopilot.work(row)`.
  - `worktree_id` is a provider-independent percent-encoded path (`worktreeId` / `pathFromId`).
  - `launcher` records the last adapter to adopt a worktree. It never overrides the selected launcher.
  - `linear_id`, `linear_state` and `linear_state_type` hold the *active tracker's* ID and status,
    Jira's too. The column names are historical.
- **`assignments`:** eligibility tracking. Despite its name, `assigned = 1` means *currently
  eligible* (assigned to me and in a pickup status), and `handled = 0` means queued for triage.
- **`meta`:** `poll_cursor`, `tracking_version` (bump it, with a migration in the `Store`
  constructor, if the meaning of `assignments` changes), `csrf_token`, `dismissed_banners`, and
  `github_account` (the account the last work check ran as).
- **New columns:** add them with an `ALTER TABLE` guard in the `Store` constructor.
- **Briefs** (`<stateDir>/briefs/*.md`) are a read-only projection of a row, regenerated whole by
  `writeBrief`. Never edit them in place. VS Code/Cursor launches also copy the brief into the
  worktree's git-excluded `.autopilot/` folder: the Claude extension won't run in an untrusted
  workspace, and App Support isn't trusted.
- **Triage editing:** `saveTriage` changes only `explainer_json` and refreshes the brief. Compare the
  submitted original explainer to reject stale forms; refuse edits during ticket actions. Preserve
  `triage_source` because it controls eligibility. Brief writes use an atomic replacement, and an
  unsuccessful write rolls back the database edit. The browser retains drafts when saving fails.
  The existing triage box is the edit form; its Update button saves only triage. Modal launch
  controls share that form, and `approve` saves submitted triage before transitioning or launching.

### Polling

`poll` runs these steps in order:

1. **`detectAssignments`.** On the first run (no cursor) it records what's eligible. With
   `processExistingOnFirstRun` (default true) those tickets are queued for triage; otherwise they're
   only recorded. After that, `updatedSince(cursor - 5 min)` picks up changes.
2. **`importExisting`.** This runs *before* triage so a ticket with an existing worktree is never
   proposed.
   - It imports worktrees whose branch or folder names a ticket (`ticketIdFrom`, using
     `ticketPrefixes`, else the tracker's team or project keys), plus my tickets in `importStates`.
   - Imported rows are `running` and `markAssigned(…, handled = true)`. Some have no worktree
     (`worktree_id` null, `repo` ""); UI and work tracking must cope.
   - A `pending`/`failed` row whose worktree turns up moves to `running`.
3. **`processQueue`.** It triages each queued ticket.

Other polling rules:

- **Phases** (`phaseOf`: in progress / in review / completed) come from the live tracker status
  (refreshed with the work check) plus PR state. The DB status stays `running`.
- **`refreshWork`** re-checks commits and PRs for `running` rows and skips settled ones (merged or
  closed). It re-checks everything when the GitHub account differs from `meta.github_account`
  (Settings change, or gh's active account switching when none is pinned).

### Trackers

- **Interface:** both trackers implement `Tracker` and are reached through their hosted MCP servers
  with OAuth (DCR + PKCE). Tokens live in the Keychain: service `autopilot`, account
  `linear-mcp-oauth` / `jira-mcp-oauth`, with `-dev` appended from source. Old `linear-autopilot`
  service entries move over on first read.
- **No API keys:** many workspaces forbid them. Don't add an API-key or API-token path.
- **Status types:** they use Linear's vocabulary. Jira categories map `new` → `unstarted`,
  `indeterminate` → `started`, `done` → `completed`, and `CLOSED_STATE_TYPES` is shared.
- **Linear** (`https://mcp.linear.app/mcp`): `list_issues` truncates descriptions, so use
  `get_issue`. Writes (moving a ticket to started) need the `write` scope.
- **Jira Cloud** (`https://mcp.atlassian.com/v1/mcp`, verified against a live site). The served
  tool names differ from Atlassian's docs:
  - `getAccessibleAtlassianResources` gives the site's `cloudId`, which every other call needs.
    `cfg.jira.site` picks the site when there are several.
  - Searches use `searchJiraIssuesUsingJql` and paginate with `nextPageToken`.
  - Tickets come from `getJiraIssue`. Comments come through its `comment` field; there's no
    comments tool.
  - Moving to started uses `getTransitionsForJiraIssue` + `transitionJiraIssue`. Projects come from
    `getVisibleJiraProjects`.
  - There's no statuses tool, so status pickers use statuses seen on recent tickets.
- **Jira quirks:**
  - It accepts `responseContentFormat: "markdown"`, but empty fields still arrive as ADF, so
    everything goes through `toMarkdown`.
  - JQL must be bounded.
  - Naming a status the site lacks fails the whole query, so `mineInStates` queries one status at
    a time and skips missing ones.
  - `updatedSince` uses relative minutes plus `assignee WAS currentUser()`, which sidesteps the
    user's timezone and catches unassignment.
- **One tracker at a time:** each tracker has its own state dir (`state/` for Linear, `state/jira/`
  for Jira) and its own pickup/import statuses (`jira.pickupStates`/`importStates`; Linear's are
  top-level). `Autopilot.switchTracker` swaps the store and client live and is refused mid-check,
  launch or sign-in.

### Web

- **Pages:** server-rendered HTML, no framework. Modals are CSS `:target` (`#m-<identifier>`).
- **Live script:** `src/web/assets/live.js`, embedded as one nonce'd inline script by `views/layout.ts`, handles everything
  client-side:
  - polls `/state` for the progress banner, the Dock badge (`setAppBadge`), the live log panel
    (`/events`) and page reloads (`version` or `boot` changing);
  - handles busy buttons (`data-busy-label`);
  - reloads when a sign-in finishes (`#signin-wait`).
- **Security:** a host allowlist (anti DNS rebinding), a same-origin check on POST, and a CSRF
  token kept in `meta` so pages survive restarts. A stale token redirects with "out of date".
- **Redirects:** use `go(to, "error" | "notice", msg)` for banners, since some URLs already have a
  query string.
- **`startWeb` extras:** `updater`, `health`, `reschedule`, `configPath` and `gh`. Every settings
  write goes through `configPath` and gh status through `gh`, so tests never touch the real config
  or gh logins.
- **First-run setup** (`web/setup.ts` and `web/views/setup.ts`, `/setup`): repos → gh account → tracker sign-in →
  statuses → overview. `/` redirects there until `cfg.onboarded`.
  - Nothing polls before then: timers and web actions call `pollIfReady()`, not `poll()`. Tests
    call `poll()` directly.
  - Configs from before setup existed count as onboarded. Settings → Run setup again, or Erase all
    data with Also reset settings, sends you back through it.
  - gh is required: the Homebrew formula depends on it, the gh banners are `required`, and setup
    can't continue without an account. Its buttons open Terminal via `runInTerminal`
    (`gh auth login`, `brew install gh`).
- **Repos:** `repoRoots` (parent folders: every git repo directly inside) plus `repoPaths`
  (individual repos), combined and de-duplicated in `repoSources`. Same-named repos get their
  parent's name prepended. `loadConfig` migrates the old `reposRoot`/`repoMode`. **Choose in
  Finder** runs `choose folder` via osascript (`chooseFolders`); `addPicked` files repos vs parent
  folders.
- **PWA:** the manifest is in `src/web/pwa.ts`, the service worker in `web/assets/service-worker.js`,
  and offline markup in `web/views/offline.ts`; icons are in
  `public/icons` and are embedded with `with { type: "file" }`. Only paths routed in `serveStatic`
  are reachable.
  - The service worker is network-only apart from the cached offline page. Never cache pages,
    `/state` or anything carrying the CSRF token.
  - Bump `CACHE` when changing the offline page or icons.

## Rules that are easy to break

- **Ticket text is untrusted.** HTML-escape everything with `esc()`. Keep triage `claude -p` calls
  tool-less (`--tools "" --strict-mcp-config --setting-sources ""`). Validate model output (repo
  against the catalog, branch via `normalizeBranch`) before use. Quote verbatim text with `fenced()`
  in briefs.
- **CSP:** don't add inline scripts without the response nonce, inline event handlers, or external
  assets. Keep `Referrer-Policy: same-origin`: `no-referrer` makes browsers send `Origin: null`,
  which the same-origin POST check rejects. Don't use `confirm()`/`alert()`; use a required
  checkbox (see Erase all data).
- **Claude launch command:** the prompt must come *before* `--add-dir`, because that option is
  variadic and swallows a following prompt. All directories (the briefs dir, then the extra
  worktrees) follow the one `--add-dir`. Tests in `test/app/e2e.test.ts` pin this.
- **Multi-repo launch order:** all worktrees are created in parallel (`Promise.all`; extras in the
  background), then saved to the row (a retry reuses them via `worktreeForBranch`), then the brief
  is rewritten with their paths, then the session opens.
- **Never pass Supacode's `--fetch`.** Supacode runs `/usr/bin/git`, whose credential helper isn't
  trusted for the github.com Keychain item, so the user gets a Keychain prompt on every launch. The
  daemon fetches with its own `git` instead (`fetchOrigin` in `workspaces/common.ts`).
- **Launcher adapters are interchangeable.** The registry in `workspaces/launch.ts` uses only
  `cfg.launch.launcher`; unknown names never fall back to an app. Adapters implement creation,
  adoption, sessions, cleanup and links. Core workflows never query an unselected provider.
  Changes in Settings and startup adopt existing worktrees in place before recording the new adapter.
  A separate 30-second timer retries unfinished setup even if tracker polling fails; successful setup
  is skipped across restarts. Preserve paths, branches, dirty files and PR tracking; never recreate
  work to migrate it. Tickets have no manual triage, open-session or launcher-setup buttons.
- **Superset** uses its CLI against the local host (`--local` on every host-scoped call). Resolve
  project/workspace UUIDs by local path; keep stored worktree IDs as encoded paths. The adapter
  lives in `workspaces/superset.ts`. Never archive a main checkout or fall back to git on a failed
  archive. Setup-free adoption uses the local authenticated `workspaceCreation.adopt` procedure
  in `workspaces/superset-host.ts`; tokens stay in memory and requests stay on loopback. Imported
  extra repos retain their own branches when changing adapters.
- **Worktrees are created and removed by the selected launcher** (`launcherFor(cfg)`), adopting
  existing work first when needed. Migration failures remain visible and retryable; never call the old app.
  Never `rm -rf` a worktree. Always re-check with `checkWork` and refuse on `atRisk` unless forced;
  unknown state counts as at risk. Erasing data never touches worktrees or branches.
- **Bun reads the environment once at startup.** `Bun.spawn` and `Bun.which` ignore later changes
  to `process.env` (such as `preparePath()` under launchd), so always pass `env: process.env` and
  `{ PATH: process.env.PATH }`. A missing `env` once broke triage on fresh Homebrew installs
  ("Executable not found: claude"); `test/triage/llm.test.ts` guards it.
- **Secrets:** never write tokens or keys to files, logs, briefs or SQLite. Use `keychain.ts`, which
  passes values to `security` over stdin as hex. The GitHub token for a pinned account
  (`ghEnv`) stays in memory.
- **Settings** write `config.json` through `saveSettings` / `patchConfig`, which keep unknown keys
  and apply the change in place (`Object.assign(cfg, loadConfig(path))`). The daemon's timers read
  the live config through `reschedule()`.
- **Page refreshes:** anything that changes a row bumps `updated_at`, which reloads open pages. For
  periodic data (work checks), only bump on a material change (`setWork(…, bump)`).
- **Long ticket actions** (send back, delete worktrees) run through `runInBackground`: the request
  returns at once, the card shows the live step, and the result lands in `notes` and the log.
- **Updates:**
  - Release asset names come from `scripts/build.sh` and `assetName()`; keep them in sync.
  - Every release so far is a GitHub *pre-release*, and `/releases/latest` skips those, so
    `checkForUpdate` picks from the release list with `pickRelease`. Betas follow betas and
    releases; release installs follow releases only.
  - Standalone installs verify the SHA-256 and the new binary's version before swapping. Homebrew
    installs run `brew upgrade autopilot` with `HOMEBREW_AUTO_UPDATE_SECS=0`, so the tap is fresh.
  - Never install without an explicit user action.
- **Renamed app:** keep the migrations (App Support folder, Keychain service, `BREW_LABELS`
  including the old `linear-autopilot` labels, the tap's `formula_renames.json`) until there's a
  reason to drop them.

## Releasing

All releases so far are pre-releases (`0.1.0-beta.N`); the latest is beta.8.

`CHANGELOG.md` is the source of truth for release notes. Include user-visible changes under
`Unreleased` in their implementation commit. Committing or pushing does not authorize a release,
version bump, tag or installation. See [docs/changelog.md](docs/changelog.md) for the workflow;
`bun run changelog [version] [--json]` exports a section for other tools without publishing it.

1. **Branch and PR:** work on a feature branch and open a PR to `main` on GitHub. The PR is
   squash-merged.
2. **Version:** on `main`, move Unreleased notes into a versioned, dated changelog section, leave a
   new Unreleased section, bump `version` in `package.json`, commit, and make an annotated tag
   `v<version>`. Push `main` and the tag. Never retag or force-push a pushed tag; ship the next
   beta instead.
3. **Build:** `bun run build`.
4. **Publish:** export `bun run changelog <version> > /tmp/autopilot-release-notes.md`, then
   `gh release create v<version> --repo mrinalraj/autopilot --prerelease --notes-file /tmp/autopilot-release-notes.md`
   with the two tarballs and `checksums.txt`.
5. **Tap:** `scripts/brew-formula.sh` writes `packaging/autopilot.rb` (git-ignored). Copy it to
   `Formula/autopilot.rb` in github.com/mrinalraj/homebrew-tap and push.
6. **Upgrade:** users get it with `brew update && brew upgrade autopilot && brew services restart
   autopilot`, or through the in-app banner.

GitHub accounts on this machine:

- **`mrinalraj`** (personal) owns the repo and the tap. Git uses the SSH alias `github-personal`,
  with repo-local email raj.mrnl@gmail.com.
- **`mrinalraj1`** is the work account and must stay gh's active account. For gh calls on this
  repo, pass `GH_TOKEN=$(gh auth token -u mrinalraj)` instead of switching. A direnv `.envrc` does
  this in interactive shells, but Claude Code's shell doesn't load it.
- **`private-history`** (local branch) holds the pre-public history with employer details. Never
  push it.

## Environment gotchas (Claude Code's shell)

- Every command prints `setValueForKeyFakeAssocArray: command not found: _encode`. It's gvm's `cd`
  override missing helpers in Claude Code's shell snapshot. It's harmless; filter it with
  `grep -v AssocArray`.
- The shell is zsh: unquoted `$VAR` isn't word-split (use `while read` loops), unquoted heredocs
  expand backticks (quote the delimiter), and `wc -l` pads its output with spaces.

## Conventions

- Match the existing style: small modules, early returns, terse comments that explain *why*.
- Comments: no ticket numbers (no "(ENG-1234)"), and keep them compact before committing.
- Tests live in `test/`. Use the fakes rather than real services:
  - trackers: `FakeLinear` in `e2e.test.ts`, `FakeJira` in `fake-jira.ts`, built from recorded
    Atlassian responses;
  - the LLM: `FakeLLM`;
  - Supacode: `fake-supacode.sh`; Superset: `fake-superset.ts` (copied into a temp repo);
  - web tests: `configPath`/`gh` extras on `startWeb`.

  Set `AUTOPILOT_NOTIFY=off`. Configs in tests use `repoRoots: [...]`, and `onboarded: true`
  wherever `/` must render.
- Commit only when the user asks, and never force-push.
