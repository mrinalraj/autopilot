# Cloud source baseline

The `autopilot-cloud` branch tracks the Go/React application under `cloud/`. This
baseline imports the existing application without changing its behavior. The
earlier Bun/macOS application is preserved at
`5473a457a27272aaabcaa6d7109dbcdd39e2b545` on the `obselete` archival branch
(spelling retained from the requested branch name). It also remains in this
baseline until the separate cleanup task reviews its active consumers.

The imported source consists of 70 files under `cloud/` and the two design
documents `autopilot-cloud-plan.md` and `worktree-ui-and-plugin-interfaces.md`.
Local configuration, credentials, dependencies, build artifacts and unrelated
ignore-file edits are excluded.

## Reproduce the application

Record `git rev-parse HEAD` before testing. Follow [the cloud README](../cloud/README.md)
for dependencies and configuration. From the repository root:

```sh
cd cloud
make build
./bin/autopilot serve
```

The tagged Go build embeds Vite's output; no frontend development server is
needed. The default address is `http://127.0.0.1:4780`. For acceptance testing,
use a temporary `AUTOPILOT_DATA_DIR`, an unused `AUTOPILOT_LISTEN` port and a
matching `AUTOPILOT_ALLOWED_HOSTS` value. Use fake agents and repositories.
The older root `bun run start`, `bun run build` and Homebrew scripts still
select the Bun/macOS application.

Autopilot's scheduler fetches `origin/<repository.defaultBranch>`, then creates
its worker branch from that ref. Register `autopilot-cloud` as the repository's
base branch before scheduling cloud work. Record the resolved full SHA in each
worker handoff: the scheduler currently follows a branch rather than pinning a
source SHA in the task. Existing prepared worktrees are reused, not rebased.

## Baseline validation, 24 October 2026

On macOS arm64 with Go 1.26.2 and Bun 1.3.14:

- `go test -race ./...`, `go vet ./...` and `make build` in `cloud/` pass.
- Root `bun run typecheck` passes after installing the frozen dependencies.
- Root `bun test` reports 166 passes and the two previously documented failures:
  launcher-change migration and Superset nonlocal-host adoption assertions.
- The cloud Playwright suite reports three passes and one failure. The
  workbench workflow reaches its coordinator terminal but receives
  `data-connection="Disconnected"` instead of `Connected` at
  `cloud/web/e2e/workbench.pw.ts:141`. Running that workflow alone passes
  (`bun run test e2e/workbench.pw.ts`). The full-suite connection failure remains
  an unresolved reliability issue; the isolated pass does not erase it.

This establishes source provenance, not a release certification. Docker,
cross-platform runtime behavior, authenticated provider operations and actual
PWA installation are outside this baseline validation.

## Implementation handoff

The audit identified these small cleanup candidates: unused imports in
`main.tsx`, `PluginSettings.tsx` and `Workbench.tsx`; unused canceled/queue
filter state; unused issue-form setters while preserving submitted values;
and the placeholder `embed.FS` declaration in `web/assets.go`. Validate both
tagged and untagged Go builds when removing that placeholder.

The older runtime, root scripts, native wrapper, shared icon artwork and site
preview generator still have active references. The archival branch preserves
their source, but deleting them also requires replacing or retiring those
consumers. Preserve existing installations, data migrations, release links,
the marketing site and its font license.

Local packaging should produce a relocatable cloud executable, document its
runtime dependencies and isolated data paths, and avoid replacing the legacy
`autopilot` command accidentally. Native GUI packaging is separate from the
existing embedded browser UI.

The cloud UI currently has no PWA manifest, service worker or offline page.
Its static handler falls back to HTML for missing assets. PWA work must add
cloud-owned assets included by Vite and Go embedding, correct MIME/cache
headers, explicit missing-asset handling, stable app identity and a small
offline fallback. Keep private API data, CSRF tokens, events and terminal
traffic out of caches, and never replay mutations offline. Check the packaged
binary and an isolated container in addition to the development server.
