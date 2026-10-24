# Autopilot Cloud

A Go + React implementation of the [Autopilot Cloud plan](../docs/autopilot-cloud-plan.md), with a local browser/PWA distribution and Docker server mode. The older application is archived on `obselete`. It provides a horizontal issue board, approved task plans, isolated Git worktrees, and persistent agent terminals for a single trusted operator.

## Run locally

Requires Go 1.26, Bun 1.3, Git, and tmux. Build an executable with the UI embedded:

```sh
cd cloud
make build
./bin/autopilot-cloud start
```

Open **http://127.0.0.1:4780**. Persistent state is stored outside the checkout:

- macOS: `~/Library/Application Support/Autopilot Cloud`
- Linux: `$XDG_DATA_HOME/autopilot-cloud`, or `~/.local/share/autopilot-cloud`
- Docker: `/data` in its named volume

`AUTOPILOT_DATA_DIR` overrides these defaults. The data directory holds `settings.json`, the database, secrets, session files, tools and managed workspaces/worktrees. Existing repo-local data is not automatically imported.

Create a workspace, attach or clone repositories, create an issue, and save and approve a plan. Workers start when dependencies and concurrency limits allow. The workspace settings choose orchestrator and worker harnesses independently.

**Import workspace** in the sidebar opens an existing directory on the machine running Autopilot. Scan it, select the Git repositories to register, and import. The scan includes the directory itself if it is a repository and its immediate Git subdirectories; files stay in place. Empty directories can be imported too. Duplicate registrations are rejected without leaving a partial workspace.

**Remove workspace** on the Workspace page deletes its local tracking records and integration credentials after confirmation. Finish or cancel runs and stop agent sessions first. Repository directories, worktrees (including uncommitted files) and external tracker issues remain intact; pending outbound actions are discarded. The folder can be imported again later.

For frontend development, run `make dev` in `cloud/` and `bun run dev` in `cloud/web/`. Vite serves port 5174 and proxies the Go API and terminal connections.

To test with Git and agent CLIs already configured on your Mac or Linux machine, use `start`, set `"executionEnvironment": "host"` in your data directory's `settings.json`, or start with:

```sh
AUTOPILOT_EXECUTION_ENVIRONMENT=host ./bin/autopilot-cloud start
```

Host mode uses your existing home directory, account identity (including Claude's macOS Keychain lookup), SSH agent, and configured CLI/XDG directories. Git, worktree setup commands, and agent processes use the same environment. Database state and managed worktrees remain under the app data directory. It forwards only these selected configuration variables; parent-session credentials and API keys are not automatically inherited. Harness `secretRefs` can provide an explicitly selected API key when needed.

The `serve`/Docker default `isolated` mode uses `agent-home/` inside the app data directory and is intended for the Docker/server installation. `start` defaults to host mode; explicit settings/environment override this. See [local installation](../docs/local-install.md) for packaging, stopping, upgrades and PWA installation.

## Run with Docker

```sh
cd cloud
docker compose up -d --build
```

The image contains the embedded UI, Go service, Node/npm, Git, OpenSSH, tmux, and a process supervisor. It runs as UID/GID **10001**, with a named volume mounted at `/data`. No Docker socket or external database is used. The Dockerfile supports Linux `amd64` and `arm64`.

The Compose file binds only to localhost. For a remote server, use an SSH tunnel:

```sh
ssh -L 4780:127.0.0.1:4780 your-server
```

Open the same localhost URL on your laptop. Tailscale Serve or an authenticated private reverse proxy can also forward to port 4780; add its exact public hostname and port to `AUTOPILOT_ALLOWED_HOSTS` in Compose. Include `127.0.0.1:4780` for the health check. Preserve the browser's Host/Origin and allow WebSockets and SSE.

This distribution assumes one trusted operator and trusted agent processes with normal user permissions. Host, Origin, CSRF, and session-token checks protect the application API; they are **not filesystem isolation between agents**. There is no public login or multi-tenant authorization layer.

### Install and authenticate harnesses

Install only the harnesses you choose, with an explicit version. Replace `VERSION` with an exact published version such as `major.minor.patch`:

```sh
docker compose exec autopilot autopilot tools install claude VERSION
docker compose exec autopilot autopilot tools install codex VERSION
docker compose exec autopilot autopilot tools install opencode VERSION
```

Tools install under `/data/tools/<harness>` with links under `/data/tools/bin`; upgrades require running the command again. They survive container replacement. The npm installer rejects floating versions. Antigravity (`agy`) uses its vendor's versioned Linux binary: place the correct architecture's executable at `/data/tools/bin/agy`, owned by UID 10001 and executable. It is not downloaded through an unverified installation script.

Complete each chosen CLI's own authentication flow inside the container:

```sh
docker compose exec -it autopilot sh
# HOME is /data/agent-home; run your selected CLI's login flow here.
claude
```

The same persistent home is used by workers, the orchestrator, and Git. Configure Git author identity and SSH keys/known hosts or an HTTPS credential helper there. Tracker/Git-provider API tokens are configured separately in the Integrations screen and are stored under `/data/secrets` with mode 0600. Do not embed credentials in repository URLs.

When using the default isolated mode locally, authenticate inside the data directory's `agent-home/`. Host mode instead uses your existing login as described above. Installed executables can be on the server's PATH.

Supported harnesses launch and resume in permission bypass mode: Claude/Antigravity use `--dangerously-skip-permissions`, Codex uses `--dangerously-bypass-approvals-and-sandbox`, and OpenCode receives inline `permission: "allow"` configuration. Codex also runs with `--no-daemon` so each session receives its own current Autopilot credentials rather than inheriting a shared daemon’s environment. Custom harnesses retain their profile arguments. The Integrations screen reports whether each executable is available; that check does not prove authentication or subscription access.

### Custom profiles and settings

Create `settings.json` in the data directory (`~/Library/Application Support/Autopilot Cloud/settings.json` on macOS; `/data/settings.json` in Docker) and restart the application after editing it:

```json
{
  "maxWorkers": 3,
  "maxOrchestrators": 1,
  "retentionDays": 7,
  "profiles": [
    {
      "id": "codex-review",
      "label": "Codex review",
      "command": "codex",
      "args": [],
      "promptMode": "arg",
      "resumeArgs": ["resume", "{conversation}"],
      "env": {},
      "secretRefs": {}
    }
  ]
}
```

`args` apply to new conversations; `resumeArgs` are the full arguments for exact recovery. Put any required model flags in both. `promptMode: "paste"` starts an interactive CLI and waits for the operator to send the saved prompt. `secretRefs` maps environment variable names to files under `secrets/`; literal secrets should not go in profile JSON. `AUTOPILOT_*` variables are reserved. Profiles are bundled configuration, not downloaded plugins.

Optional `webhookUrl` sends JSON attention notifications (`id`, `message`) to an operator-configured endpoint. It is disabled by default. `AUTOPILOT_DATA_DIR`, `AUTOPILOT_LISTEN`, `AUTOPILOT_ALLOWED_HOSTS`, and `AUTOPILOT_EXECUTION_ENVIRONMENT` override deployment settings.

## Workflow

- **Workspace**: a named directory containing one or more repositories. Attach an existing directory, scan its direct child repositories, or clone an SSH/HTTPS URL. Bitbucket and other generic Git hosts work without a review integration.
- **Project / issue**: native issues have descriptions, acceptance criteria, priority, labels, status, and private notes. The board scrolls horizontally; a status selector provides an alternative to drag-and-drop.
- **Plan**: tasks identify repositories, harness profiles, and dependencies. Saving proposes a draft. Approval snapshots the reviewed revision and harness settings in a transaction. Editing an approved plan requires a new plan.
- **Worker**: each task gets its own worktree per repository. Dependency tasks wait for merged changes or explicit manual acceptance. Process exit alone does not complete a task.
- **Orchestrator**: a separately selected harness proposes plans and coordinates workers through the scoped CLI. The Go scheduler enforces API approvals, task scope, dependency order, active-issue uniqueness, and concurrency. Workers cannot delegate through the API.
- **Review**: GitHub pull requests and GitLab merge requests are created/discovered through provider APIs. Humans review and merge on the provider. Connect a repository to its provider in Workspace settings; Git transport credentials are independent.
- **Attention**: permission prompts, missing conversations, failed preparation, pending follow-ups, and uncertain outbound deliveries remain visible for the operator.

Terminals accept input immediately. Multiple browser tabs can attach and type; there is no Take control step. Closing a tab detaches that client and leaves the process running.

### Harness readiness and recovery

| Harness | Interactive launch | Exact resume | Automatic input |
|---|---|---|---|
| Claude Code | CLI arguments | Captured by native hook | Completed-turn hook, no attached clients, two automatic repair turns per worker |
| Codex | CLI arguments | Saved/reported conversation ID | Explicit operator send |
| Antigravity `agy` | `--prompt-interactive` | Saved/reported conversation ID | Explicit operator send |
| OpenCode | `--prompt` | Saved/reported session ID | Explicit operator send |
| Custom | Arguments or manual paste | Only if configured | Explicit operator send |

Claude hook configuration is written outside repositories and supplied at launch. Working, idle, and permission states are distinguished. Worker follow-ups still require native idle readiness and no attached terminal. Coordinator updates accept an explicit idle report (or native idle hook) after a two-second quiet period; viewing the coordinator does not suspend delivery. Input marks the session working and pauses queued delivery. The coordinator prompt instructs every harness to report idle as its final tool call.

The supervisor restarts a crashed API process without restarting tmux. A new API process adopts surviving sessions. After a whole-container restart, tmux is gone: only sessions with an exact saved conversation ID and resume arguments are recovered automatically. Others show **Resume required**. Launch generations reject stale hooks and session credentials.

### Agent CLI

Agents receive workspace/run-scoped credentials through their environment:

```sh
autopilot snapshot
autopilot events
autopilot plan --file /path/to/plan.json
autopilot report --state working --message "Running checks"
autopilot report --state idle --conversation EXACT_ID --message "Ready for review"
autopilot followup --run RUN_ID --message "Address the review within the approved scope"
autopilot changes create --run RUN_ID --repository REPOSITORY_ID --title TITLE --body DESCRIPTION
```

`plan` and `followup` are coordination operations; workers cannot approve plans or create additional tasks. `changes create` requires an approved repository in that worker's run, a configured provider, and a branch already pushed with Git. Provider-specific `gh`/`glab` commands are not required.

### External trackers

Connect Linear or Jira Cloud in Integrations. Linear uses an API key; Jira uses an account email and API token. Jira's base URL is its site root; a custom GitLab API URL includes `/api/v4`. Empty tracker scope imports issues assigned to the authenticated user. A comma-separated scope selects Linear team keys or Jira project keys.

Sync runs every 60 seconds, follows pagination, overlaps incremental checkpoints, and performs a daily full read. Status mappings are configurable. Linked issue fields remain read-only locally; private notes and execution history are local. Explicit comments and status requests use a persisted outbox. A network ambiguity or restart during delivery never causes an automatic repeat: inspect the tracker, then confirm delivery or explicitly retry. Jira status requests resolve to an available workflow transition.

## Backups, cleanup, and upgrades

Create a consistent SQLite snapshot while the service is running:

```sh
docker compose exec autopilot autopilot backup /data/snapshot.sqlite
```

This backs up the database only. To preserve repositories, worktrees, agent conversations, credentials, and installed tools, back up the **entire volume** while stopped:

```sh
docker compose stop
docker compose run --rm --no-deps --entrypoint tar autopilot -C /data -czf /data/autopilot-backup.tgz --exclude=./autopilot-backup.tgz .
docker compose cp autopilot:/data/autopilot-backup.tgz ./autopilot-backup.tgz
docker compose start
```

Store the archive privately: it contains credentials. To restore, stop the service, copy the archive into the volume, extract it as UID 10001 using the same one-off Compose container, and start the matching application version. Preserve the `/data` path. A restore reuses conversation IDs; it does not recreate live tmux processes. Verify worktrees and CLI authentication before approving new work.

Before upgrading, back up the volume and retain the previous image. Rebuild and run `docker compose up -d --build`. Do not downgrade across incompatible future schema migrations without restoring the matching backup. No automatic harness upgrades occur.

Completed, unpinned run-owned worktrees are eligible for cleanup after seven days. Manual, primary, pinned, externally discovered, and actively used worktrees are protected. Cleanup checks for uncommitted files and commits absent from all remotes, then rechecks before removal. Dirty/unpushed work is retained. Manual cancellation retains worktrees too.

## Verification

```sh
go test -race ./...
go vet ./...
cd web
bun install --frozen-lockfile
bun run build
bunx playwright install chromium
bun run test
cd ..
docker build -t autopilot-cloud:0.1.0 .
python3 tests/docker_smoke.py
```

Unit/integration tests cover transaction rollback, duplicate approvals, immutable settings, dependency ordering, recovery fencing, scoped API access, CSRF/Origin checks, bounded follow-ups, provider pagination/errors/transitions, and guarded cleanup. A real tmux test checks literal prompt delivery and adoption. Playwright exercises the actual API, SQLite, and a fake terminal agent, including reconnect and desktop/mobile board layouts. Docker smoke tests use disposable volumes and fake agents to exercise two harness profiles, API crashes, container restarts, exact recovery, backups, and acceptance.

No test creates real tracker issues, pushes to a provider, starts an authenticated AI session, or merges a change.

The initial verification run passed the cloud race tests, Go vet, frontend build, Playwright workflow, and Linux amd64 Docker smoke test. Linux arm64 was cross-compiled, not runtime-certified. The existing desktop application's typecheck passed; its Bun suite returned 166 passed and two Superset-related failures. Both failures also reproduced from an untouched `HEAD` archive: launcher-migration cleanup accesses a closed database, and a nonlocal-host adoption assertion expects different error text. The cloud browser test uses `.pw.ts` so the existing Bun runner does not collect it.

## Remaining release validation

This is an executable first implementation, not a certified unattended release. Real authenticated harness sessions and private GitHub/GitLab/Linear/Jira accounts still need live acceptance testing. Automatic native readiness for Codex/agy/OpenCode, an in-browser harness installer/login flow, and an external-issue deletion/archive reconciliation policy remain follow-up work. External comments are not mirrored into local notes. Provider adapters have mock coverage but are not live-certified against every tenant/workflow. Real mobile hardware is not yet tested.

Dynamic plugin loading, Bitbucket review APIs, GitLab Issues intake, desktop packaging, and multi-user hosting remain outside this first distribution.

## Code map

| Path | Responsibility |
|---|---|
| `internal/domain` | Shared terminology and validation |
| `internal/storage` | SQLite schema, transactions, durable events |
| `internal/plugins` | Bundled contracts, manifests, harness profiles |
| `internal/agents` | CLI arguments, exact resume, native hooks |
| `internal/runner` | Isolated tmux launcher |
| `internal/repos` | Generic Git, clone/discovery/worktrees/cleanup checks |
| `internal/app` | Approvals, scheduler, orchestration, reconciliation, integrations |
| `internal/providers` | Linear, Jira, GitHub, GitLab APIs |
| `internal/httpapi` | Scoped API, SSE, terminal WebSocket bridge |
| `cmd/autopilot` | Server, supervisor, agent CLI, tool install, backup |
| `web/src` | Shared React interface |

The desktop application can package the same Go services and React UI, supplying native launcher, directory-picker, credential, and notification adapters later.


## Worktrees and plugin settings

The sidebar lists each repository's real Git checkouts, including the default checkout and worktrees created elsewhere. Use the repository **+** to create a named worktree from an existing local or remote branch. Fetch is explicit. Select a worktree to open a shell or start a chosen agent without creating an issue or plan. Terminal tabs persist across navigation/reload; type directly in the terminal. Run controls live under **Activity**; **Changes** shows local changes and an explicit provider status check.

Settings contains grouped plugin cards, workspace defaults, agent command profiles and terminal preferences. Add Linear/Jira/GitHub/GitLab directly from its card. Multiple accounts create separate settings sections. GitHub CLI selection reads the named user's credential and stores it for that connection; it never changes the globally active CLI account. API accounts are workspace-scoped with repository overrides and host checks. Git fetch/push and commit authors still use host Git configuration; they do not inherit the selected API account.

Trackers default to 60-second polling (10–86400 configurable). Watched external statuses feed a durable planning queue after the initial baseline; approval remains explicit. Disabled intake withdraws pending entries. Ticket discovery matches identifiers in branch/worktree names against already synchronized tickets and requires an explicit link action.

Signed webhook setup uses `/hooks/<connection-id>` and a separately stored secret. Configure the matching URL/secret in the provider manually. A local-only server requires an externally reachable HTTPS endpoint for delivery. Linear signatures use HMAC-SHA256 and a one-minute timestamp check; Jira admin webhooks use the configured SHA256 signature. Verified deliveries are deduplicated and request the same authoritative sync used by polling; payloads do not directly execute work. Protocol references: [Linear webhooks](https://linear.app/developers/webhooks), [Jira Cloud webhooks](https://developer.atlassian.com/cloud/jira/platform/webhooks/).

Provider status inspection preserves unknown mergeability and distinguishes closed from merged. References: [GitHub pull requests](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request), [GitLab merge requests](https://docs.gitlab.com/api/merge_requests/). No merge action is exposed.

Desktop OAuth/launcher ports, GitLab CLI selection, automatic webhook registration and per-workspace Git transport credentials remain follow-up work. See the [implementation checkpoint](../docs/worktree-ui-and-plugin-interfaces.md#10-implementation-checkpoint--23-october-2026) for scope and validation.


## Automatic issue flow and terminal navigation

Issues is the default page on each load. New native tickets always enter triage; status/priority controls are absent from creation and manual status edits cannot move the execution board. The board derives Triage, Working (including Planning), Needs you, In review and Done from coordinator claims, linked plans, runs, sessions and provider observations. Plan creation links back to its ticket and moves it to Needs you for approval. Process exit does not imply completion. Projects remain optional metadata under Additional details.

Each workspace has one active coordinator. The first incoming eligible ticket starts it automatically when a repository is registered. Later tickets are queued durably and delivered once per coordinator/issue. An explicitly stopped coordinator stays stopped until reopened. External tickets participate after tracker intake queues them; unrelated synchronized tickets do not populate this execution board. Plans still require approval before workers launch.

Coordinator opens a full terminal screen. Worktree screens have a compact repository/branch breadcrumb, session tabs and bottom launcher bar. Changes and Activity open in a right inspector. Branch icons reflect observed PR/MR open, closed or merged state when a run has a provider connection. Existing shell sessions survive UI/server upgrades.

OpenCode's runtime permission override uses [inline configuration](https://opencode.ai/docs/config/#precedence-order) and its [permission rules](https://opencode.ai/docs/permissions/). Provider/harness credentials are not changed by this setting.
