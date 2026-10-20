# CLAUDE.md

linear-autopilot is a local macOS daemon in Bun + TypeScript. It polls Linear for tickets assigned
to the user in Ready for Development and triages them with `claude -p`. On approval it launches a
Supacode worktree with a Claude Code session, then tracks commits and the PR. See README.md for the
user-facing picture.

## Commands

```sh
bun test                 # must pass before you finish; the e2e test uses fakes, never real Linear/Supacode
bun run typecheck        # tsc --noEmit
bun run once             # one real poll against Linear (needs `bun run login` done)
bun run cli service restart   # restart the installed daemon (LaunchAgent dev.linear-autopilot) to load changes
bun run build            # standalone binaries + tarballs + checksums.txt in dist/
tail -f logs/autopilot.log
```

The daemon normally runs as a LaunchAgent. Don't also start `bun run start` while it's running:
both bind port 4747. `src/cli.ts` is the single entry point, both from source and as the compiled
binary.

Config, state and logs live under `HOME_DIR` (`config.ts`):
- `AUTOPILOT_HOME` if set
- otherwise `~/Library/Application Support/linear-autopilot` in the compiled binary
- otherwise the project folder when running from source.

Never derive paths from `import.meta.dir` elsewhere: inside the binary it's Bun's virtual filesystem.

## Architecture

- `autopilot.ts` is the orchestrator: detection (`detectAssignments`), triage (`processQueue` →
  `triage`), `approve` / `reject`, `runLaunch`, and `refreshWork`.
- SQLite (`db.ts`) is the single source of truth.
  - `issues`: one row per proposed ticket. Status is `pending | approved | rejected | running | failed`.
    `repo` / `repo_path` / `worktree_id` belong to the primary repo. `extra_repos_json` holds the
    other repos (`ExtraRepo[]`, read with `Store.extras(row)`), each with its own `worktree_id` on
    the same branch. `work_json` is `RepoWork[]`, primary first; read it with `Autopilot.work(row)`,
    which also accepts the older single-object form.
    `approved` means a launch is in flight. Dismissed tickets are `rejected`, with an `error`
    starting with `Dismissed:`.
  - `assignments`: eligibility tracking. Despite its name, `assigned = 1` means *currently eligible*
    (assigned to me + in a pickup state), and `handled = 0` means queued for triage.
  - `meta`: the poll cursor and `tracking_version`. Bump the version, with a migration in the
    `Store` constructor, if the meaning of `assignments` changes.
  - New columns are added with an `ALTER TABLE` guard in the `Store` constructor.
- Briefs (`state/briefs/*.md`) are a read-only projection of an `issues` row, regenerated whole by
  `writeBrief`. Never edit them in place.
- `linear.ts` talks to Linear's hosted MCP server over OAuth (tokens in the Keychain). Many workspaces forbid
  personal API keys, so don't add a `LINEAR_API_KEY` path. Tool results are JSON text; `list_issues`
  truncates descriptions, so use `get_issue` for full text.
- `web.ts` renders server-side HTML. Modals are CSS `:target` (`#m-<identifier>`). One nonce'd
  inline script polls `/state` to update the progress banner, set the Dock badge
  (`setAppBadge(awaiting)`), and reload when the `version` changes.
- The PWA lives in `public/` and is served through the `STATIC` allowlist in `web.ts`. Only listed
  paths are reachable. The service worker (`public/sw.js`) is network-only, apart from the cached
  offline page: never cache pages, `/state` or anything carrying the CSRF token. Bump its `CACHE`
  name when changing the offline page or icons.

## Rules that are easy to break

- **Ticket text is untrusted.** HTML-escape everything with `esc()`. Keep triage `claude -p` calls
  tool-less (`--tools "" --strict-mcp-config --setting-sources ""`). Validate model output (repo
  against the catalog, branch via `normalizeBranch`) before use. Quote verbatim text with `fenced()`
  in briefs.
- **CSP:** don't add inline scripts without the response nonce, inline event handlers, or external
  assets. Keep `Referrer-Policy: same-origin`: `no-referrer` makes browsers send `Origin: null`,
  which the same-origin POST check rejects.
- **Claude launch command:** the prompt must come *before* `--add-dir`, because that option is
  variadic and swallows a following prompt. All directories (the briefs dir, then the extra
  worktrees) follow the one `--add-dir`. Tests in `test/e2e.test.ts` pin this.
- **Multi-repo launch order:** extra worktrees first (in the background, each saved as soon as it's
  made so a retry reuses it), then the primary, then the brief rewrite, then the tab.
- **Never pass Supacode's `--fetch`.** Supacode runs `/usr/bin/git`, whose credential helper isn't
  trusted for the github.com Keychain item, so the user gets a Keychain prompt on every launch. The
  daemon fetches with its own `git` instead (`fetchOrigin` in `launch.ts`).
- **Never call `git worktree add`.** Worktrees are created by Supacode (`repo worktree-new`), so its
  branch creation and hooks run. Read-only git (`worktree list`, `rev-list`, `status`) is fine.
- **`Bun.spawn` doesn't pick up later `process.env` changes.** Pass `env: process.env` explicitly
  when spawning.
- **Secrets:** never write tokens or keys to files, logs, briefs or SQLite. Use `keychain.ts`, which
  passes values to `security` over stdin as hex.
- **Page refreshes:** anything that changes a row bumps `updated_at`, which reloads open pages. For
  periodic data (work checks), only bump on a material change (`setWork(…, bump)`).
- **Deleting worktrees** goes through Supacode (`removeWorktree`). Never `rm -rf` or
  `git worktree remove` it ourselves. Always re-check with `checkWork` and refuse on `atRisk`
  unless forced. Unknown state counts as at risk.
- **Updates:** release asset names come from `scripts/build.sh` and `assetName()` in `update.ts`;
  keep them in sync. Installs verify the SHA-256 and the new binary's reported version before
  swapping, and never run without an explicit user action.
- **Embedded files:** icons are imported `with { type: "file" }` in `src/pwa.ts`, so they ship
  inside the binary. Add new static files the same way and route them in `serveStatic`.

## Conventions

- Match the existing style: small modules, early returns, terse comments that explain *why*.
- Comments: no ticket numbers (e.g. no "(ENG-1234)").
- Tests live in `test/`. Use the fakes there (`FakeLinear`, `FakeLLM`, `fake-supacode.sh`) rather
  than real services. Set `AUTOPILOT_NOTIFY=off` in tests.
- Commit only when the user asks, and never force-push.
