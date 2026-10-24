# Local packaging and PWA implementation handoff

## Source and scope

Implemented on scheduler branch `autopilot/de0b6c79acc1` from verified cloud baseline
`8fd2bf1341b8457d3be3d2e90c18a2a0ddae7b8d`, after reading
[the completed baseline audit](cloud-baseline.md). The worktree was initially clean.
The primary checkout at `5473a45` was not used as the source and no other worktree
or live installation was edited. Local and remote `obselete` both preserve
`5473a457a27272aaabcaa6d7109dbcdd39e2b545` including legacy migrations and build tooling.

Use the exact implementation commit reported in the Autopilot run, not `main` or
an assumed branch tip. `git rev-parse HEAD`, each archive's `BUILD.txt`, and
`autopilot-cloud version` identify the revision. Rebuilding a dirty checkout labels
its artifacts `-dirty`. The resulting commit is supplied in the run report because
a file cannot embed the hash of its own containing commit.

## Changed-file rationale

| Paths | Reference evidence and resulting change |
| --- | --- |
| Root `src/`, legacy `test/` except changelog tests, `desktop/` | Bun CLI/runtime, tracker/launcher/web code and Swift wrapper were consumed by the old root commands/builds. They are superseded on this branch by `cloud/cmd/autopilot`, `cloud/internal` and `cloud/web`. No cloud import refers to them; all are retained in `obselete`. |
| Root `package.json`, `bun.lock`, `tsconfig.json`, `config.example.json` | The old package pointed its binary and commands at `src/cli.ts`, with Anthropic/MCP dependencies used only by that runtime. Removed the dependencies, obsolete lock/config/TS scope and binary mapping. Root commands now forward to cloud builds/checks. |
| `scripts/build*`, `scripts/brew-*`, `scripts/test-app.ts` | Compiled/distributed only the deleted Bun entrypoint and native wrapper. Retired; local cloud packaging has its own scripts and distinct executable name. Existing Homebrew releases/tap are unchanged. |
| `scripts/generate-site-previews.ts`, `docs/website.md` | The generator imported deleted templates and test fixtures. Retired with explicit archived regeneration instructions. The deployed static site, existing screenshots/video, font files/license and release URLs remain unchanged. |
| `public/icons` → `cloud/web/public/icons` | Shared brand artwork remains byte-for-byte intact, now included by Vite and Go embedding. No active old runtime consumer remains. |
| `README.md`, `CLAUDE.md`, legacy architecture/desktop/release-plan docs | Replaced active instructions with the new app's commands. Retired obsolete implementation docs; historical release records link to their archived sources. Preserved changelog/exporter/tests and design documents. |
| `cloud/web/src/{main,Workbench,PluginSettings}.tsx`, `web/assets.go` | Removed audit-listed unused imports, dead queue/canceled controls, unused form setters (retaining values) and placeholder embed declaration. Tagged and untagged Go builds remain supported. |
| `cloud/scripts`, Makefiles, `cmd/autopilot`, `internal/app` | Deterministic archives/checksums, checksum-verified atomic local installer, embedded revision, explicit local host default, retained server isolated default and actionable startup errors. |
| HTTP static handler, web manifest/worker/offline page, `pwa.ts`, `api.ts`, `AppBoundary.tsx` | Correct asset types/errors/cache policy, installable identity, private-data-free offline fallback, visible connection loss and recovery from removed lazy chunks. |
| Focused Go, Python and Playwright tests | Exercise static delivery/security headers, config precedence, relocated installation/upgrades, startup/locking, persistence and PWA lifecycle/recovery. |

## Behavior and targets

[Local instructions](local-install.md) cover build/package/install/start/stop/upgrade,
persistent data, isolated verification, runtime dependencies and browser installation.
`autopilot-cloud start` serves the bundled UI at `http://127.0.0.1:4780`, defaults to
host CLI configuration, and does not modify the legacy `autopilot` command.
`serve`/`supervise` keep isolated server mode. Explicit configuration wins over defaults.
Cloud Docker files and supervisor remain supported; only build-output exclusion changed.

Supported package targets: macOS arm64/amd64 and Linux arm64/amd64. Build tooling:
Go 1.26.2, Bun 1.3.14, Python 3 and make. Runtime: Git, tmux, a Unix shell and selected
agent CLIs; no frontend development server, Bun or Go required. Native Windows,
a native macOS wrapper, automatic login services and release publication are outside scope.

Only `/offline.html` enters the service-worker cache. API/CSRF/events/terminal traffic,
mutations and the application shell do not. There is no mutation replay. Offline cache
versions follow document content; old app-owned caches are removed without clearing
other caches. Static HTML/worker/manifest/icons revalidate; fingerprinted assets are
immutable. An older window encountering a missing lazy chunk offers reload without
stopping the server's sessions.

## Verification observed on 24 October 2026

All local processes used disposable data directories, unused ports and fake agents.
No test exercised authenticated provider accounts, the live database or real AI sessions.

| Command/check | Observed result |
| --- | --- |
| Before cleanup: root frozen install, `AUTOPILOT_NOTIFY=off bun test`, `bun run typecheck` | 166 pass / 2 known Superset failures, matching audit; typecheck passed. These tests belong to the archived runtime. |
| `make test` | Changelog tests: 2 pass. All cloud `go test -race ./...` packages pass; `go vet ./...` passes. |
| `make build`, `make typecheck` | Frozen frontend install/typecheck/Vite production build and embedded Go build pass. |
| `cd cloud/web && bunx tsc --noEmit --noUnusedLocals --noUnusedParameters` | Passes after audit cleanup. |
| `cd cloud && go test -tags webassets ./... && go build -o /dev/null ./cmd/autopilot` | Tagged tests and untagged build pass. |
| `python3 cloud/tests/local_smoke.py <binary>` | Relocated embedded UI, manifest/icons/worker, missing asset 404, missing dependency/settings/port/lock errors, persistent workspace/issue/config/CSRF and local/server defaults pass. |
| `python3 cloud/scripts/package.py` | All four targets build. Archives include checksums, install script, instructions, license and source/toolchain metadata. |
| `python3 cloud/tests/package_smoke.py cloud/dist/autopilot-cloud-darwin-arm64.tar.gz` | Install/reinstall in a prefix containing spaces, unchanged legacy command, installed-binary persistence smoke, checksum rejection without replacing installed executable pass. |
| `cd cloud/web && bun run test` | Final suite: **6 passed** (24.7s): PWA, upgrade recovery and four existing workflows. Chromium manifest parsing and installability checks return no errors. |
| Earlier browser reliability observation | First full run: 4 pass / 1 fail at `workbench.pw.ts:141`, coordinator disconnected, matching the baseline audit. Isolated workbench passed; next full 5-test run passed; final 6-test run passed. No terminal fix was made, so this remains a known intermittent issue. |
| `git diff --check`, active-consumer search | Pass; active root commands/imports no longer depend on the retired runtime. Historical documentation explicitly references archived source. |
| Docker availability | `docker info` fails: daemon socket `/Users/mrinalraj/.docker/run/docker.sock` is absent. No daemon or live container was started. Docker image/runtime smoke remains unverified in this run. |

Local logs are in `.dev/{legacy-tests,build,checks,package,package-smoke,browser-suite-final}.log`.
Playwright saves offline/update and existing desktop/mobile workflow screenshots under
`cloud/web/test-results/`; selected evidence is copied to `.dev/evidence/`. These are
ignored test outputs, not source dependencies. The run report records final clean-build
checksums/reproducibility evidence alongside the commit.

## Remaining acceptance and handoff

- Actual PWA installation through a browser menu and OS-level standalone launch are for
  the independent acceptance task. Chromium headless installability/offline tests are
  not represented as an actual OS installation. Safari, Edge and physical mobile hardware
  were not exercised.
- macOS arm64 was runtime-tested. Other package targets were cross-compiled; Linux
  container execution and native Intel/arm64 Linux behavior require verification.
- Preserve the known intermittent coordinator connection failure above; a passing rerun
  does not establish that it is fixed. Cleanup warnings (`tmux list-panes: no current target`)
  appeared in browser fixtures during successful workspace cleanup.
- The scheduler repository snapshot has provider `git` and no review integration ID.
  A PR/MR through `autopilot changes create` requires a configured review provider.
  The run report records the attempted command and its result. No provider settings,
  merge, deployment, tag or release publication are authorized by this change.
