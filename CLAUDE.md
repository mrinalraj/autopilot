# Repository instructions

The active application is Go + React under `cloud/`. The older Bun/macOS runtime,
including migrations and release tooling, is archived on `obselete` at
`5473a457a27272aaabcaa6d7109dbcdd39e2b545`. Do not modify existing installations.
See `docs/cloud-baseline.md` for provenance and `docs/local-install.md` for distribution.

## Commands and checks

- `make build`: frozen frontend install/typecheck/build and a Go executable with embedded UI.
- `make test`: changelog tests, all Go race tests and vet. Tests use fakes only.
- `make typecheck`: cloud frontend TypeScript check (install its frozen dependencies first).
- `cd cloud/web && bun run test`: browser workflows; requires Chromium, Git and tmux.
- `make package`: reproducible macOS/Linux arm64/amd64 archives and checksums.
- `python3 cloud/tests/local_smoke.py /absolute/path/to/autopilot-cloud`: isolated startup/persistence check.
- Docker regression: build `cloud/Dockerfile`, then run `cloud/tests/docker_smoke.py`.

Keep unit/integration tests beside the Go packages and browser tests in `cloud/web/e2e/*.pw.ts`.
The root Bun package has no runtime dependencies; it only forwards commands and exports changelog notes.

## Boundaries

- Preserve supported cloud `serve`/`supervise` behavior. Local `start` defaults to host
  authentication; explicit settings/environment take precedence. Server mode stays isolated.
- Never test against live data, configured trackers or authenticated agent sessions.
  Set a disposable `AUTOPILOT_DATA_DIR`, unused `AUTOPILOT_LISTEN` and matching `AUTOPILOT_ALLOWED_HOSTS`.
  Stop only processes/tmux sockets created by the test; never broad `pkill`.
- Keep Host/Origin/CSRF/session-generation checks intact. No private API, events,
  terminal data or mutations in browser caches. The service worker caches only a generic
  offline page; Vite versions that cache from its content. Never replay mutations offline.
- Compiled builds embed all UI assets. Source builds may read `cloud/web/dist` from disk.
  Persistent paths must never depend on the checkout, current directory or embedded filesystem.
- Do not replace the legacy `autopilot` command, Homebrew app/formula, Keychain, or data.
  Package installs use `autopilot-cloud`; agent-scoped `autopilot` is managed inside the data directory.
- Preserve the static marketing site, bundled artwork/font license, release history and links.
- Add user-visible changes under Unreleased in CHANGELOG.md. A commit/PR is not release authorization.
- Do not merge, tag, publish or deploy without explicit authorization. Never force-push.
- `private-history` contains private pre-public history; never push it.
- Personal repository: `git@github-personal:mrinalraj/autopilot.git`. Do not change the active gh account.
- Match existing small modules and early-return style. Keep task identifiers out of code comments.
