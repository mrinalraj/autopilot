# Autopilot: shared core, cloud runner, and pluggable integrations

**Latest product revision:** [Worktree navigation and plugin settings](worktree-ui-and-plugin-interfaces.md). It supersedes the session-first navigation, run-owned worktree lifecycle, generic connection UI and fixed tracker polling below. Worktrees become independently navigable resources; orchestration remains available, while manual worktree creation and terminals require no issue or plan. The execution checkpoint below describes the existing implementation, not completion of the revised design.

## 1. Product direction

Build an independent **Go + React application** whose core can serve both cloud and future desktop distributions.

The first distribution is a **Docker application for one trusted operator on a Linux server**. All cloud agents run in interactive terminal sessions. Users select an agent harness—Claude Code, Codex, Antigravity CLI (`agy`), OpenCode, or a custom CLI profile. Cloud has no IDE launcher picker.

Support two independently configured agent roles:

- **Orchestrator:** triages issues, proposes implementation plans, delegates approved tasks, monitors workers, and coordinates follow-up.
- **Worker:** implements a focused task, runs checks, and produces a pull request or merge request.

This matches AO’s distinction between supervision and implementation; each role can use a different harness and model. [AO role guide](https://docs.orchestrator.inc/guides/per-role-agents/)

Users approve a plan once. The orchestrator may dispatch its approved workers within the plan’s scope and limits. Additional tasks or repositories require a revised approval. Human review and merging remain on the Git hosting provider.

## 2. Terminology and domain model

Use these terms consistently in the UI, API, configuration, and documentation:

| Term | Meaning |
|---|---|
| **Workspace** | A named development environment rooted in a directory containing one or more repositories |
| **Repository** | An individual Git repository registered within a workspace |
| **Project** | A planning initiative within a workspace, containing issues |
| **Issue** | A native task or a synchronized external issue |
| **Plan** | Proposed tasks, dependencies, repositories, harness choices, and acceptance criteria |
| **Plan execution** | Execution of one approved plan revision |
| **Run** | One worker attempt at an approved task |
| **Run directory** | The isolated directory containing that run’s repository worktrees |
| **Session** | A live or recoverable orchestrator/worker conversation and terminal process |
| **Harness** | The coding-agent CLI, such as Claude Code or Codex |
| **Launcher** | The integration that starts and exposes a session; cloud uses tmux |

An issue retains its history across multiple runs. Sessions have a role, harness, launch generation, native conversation ID, and optional worker-run association. Orchestrator sessions belong to a workspace and can supervise multiple plan executions.

**Repository onboarding**

- Offer **Create workspace**, **Clone repository**, **Attach repository**, and **Attach workspace**.
- Clone from an HTTPS or SSH Git URL into the selected workspace. Git cloning does not require a supported hosting integration.
- Attaching a workspace scans its direct child repositories and lets the user choose which to register.
- Cloud paths refer to server/container storage; a later desktop distribution can use a native directory picker.
- Repository identity uses stable IDs and canonical remotes, not folder names. Keep machine-specific paths separate from logical workspace configuration.
- Git operations and worktree ownership belong to the shared repository service, independently of launchers.

## 3. Shared core and bundled plugins

Use one repository containing the Go domain/services, Go server, React UI, and bundled integration packages. The future desktop application will package the same server and UI with a native shell.

Keep tracker synchronization, planning, scheduling, repository management, approval rules, persistence, and lifecycle reconciliation in the shared core.

Ship four plugin types:

| Type | Responsibility | Initial implementations |
|---|---|---|
| **Tracker** | Read issues, discover statuses, publish explicit transitions/comments | Native, Linear, Jira Cloud |
| **Agent** | Harness configuration, launch arguments, prompt delivery, status hooks, conversation recovery | Claude Code, Codex, `agy`, OpenCode, generic CLI |
| **Launcher** | Start, inspect, attach, send input, interrupt, and stop sessions | tmux |
| **Git provider** | Repository metadata, PR/MR creation and discovery, checks, reviews, merge state | GitHub, GitLab |

Each plugin declares:

- Stable ID, type, version, and contract version.
- Supported distributions: `cloud`, `desktop`, or both.
- Supported operating systems and architectures.
- Configuration schema, prerequisites, and health checks.
- Capabilities, such as terminal attachment, exact conversation resume, or review-comment retrieval.

Use typed Go interfaces and a registry. **Plugins are bundled in v1**; no dynamic loading, marketplace, or native shared-library ABI. Custom CLI profiles remain configuration of the generic agent plugin.

The core validates capabilities before offering an operation. An unsupported resume or terminal attachment must be shown explicitly rather than simulated.

For a future desktop release, add launcher packages and native services for directory selection, credential storage, and notifications. Desktop launcher code must not enter cloud builds. UI visibility and backend validation both use plugin compatibility metadata.

**Interfaces and storage**

- SQLite with migrations, foreign keys, WAL, durable events, and outbound-action queues.
- Versioned `/api/v1` resources for workspaces, repositories, projects, issues, plans, executions, runs, sessions, and integrations.
- SSE for state updates; WebSocket for terminal input/output.
- Idempotency keys for launch/delegation requests and revision checks for plan approval.
- Capture the resolved harness settings and approved scope with each execution so later settings changes do not alter active work.

## 4. Workflow and provider behavior

**Issue UI**

- Use a Jira/Linear-style Kanban board with workflow columns arranged horizontally and issue cards stacked within each column, replacing the current vertically stacked status sections. Keep columns horizontally scrollable on narrow screens and provide an accessible status selector alongside drag-and-drop.

**Orchestration**

1. A native or synchronized issue enters the planning queue.
2. The workspace orchestrator inspects its context and proposes tasks, dependencies, repository assignments, worker harnesses, and acceptance checks.
3. The user edits and approves the plan revision.
4. The scheduler dispatches eligible tasks; each worker receives its own run directory and worktrees.
5. Workers report progress and create PRs/MRs through Autopilot’s provider-neutral CLI.
6. The orchestrator receives worker outcomes and CI/review events and requests bounded follow-up work.
7. Humans review and merge on the hosting provider.

Expose structured coordination commands through an `autopilot` CLI backed by the same application services: propose a plan, request dispatch, inspect runs, send a follow-up, report a result, and create a change request. Do not infer delegation by parsing terminal prose.

The **Go scheduler remains authoritative** for approvals, dependencies, deduplication, concurrency, and retry limits. Workers cannot delegate additional workers through the application API. An orchestrator crash does not erase approved work or stop existing workers.

Defaults: three concurrent workers and one concurrent orchestrator per installation; waiting sessions count against their role’s limit. Dependency tasks start after predecessor changes merge or the predecessor receives explicit manual acceptance. Reject dependency cycles.

**Git hosting**

- Use Git for clone/fetch/push/worktrees and provider APIs for PR/MR operations. `gh` is not a core dependency.
- Ship GitHub and GitLab integrations first, including configurable GitLab base URLs.
- Normalize provider data internally while displaying native terminology: GitHub **Pull request**, GitLab **Merge request**. Both expose dedicated APIs. [GitHub](https://docs.github.com/en/rest/pulls/pulls), [GitLab](https://docs.gitlab.com/api/merge_requests/)
- Generic Git—including Bitbucket repositories—supports cloning, execution, and pushing. Unsupported review/check integrations remain visibly unavailable.
- Defer Bitbucket’s provider plugin and GitHub Enterprise certification. GitLab Issues intake is separate from GitLab hosting support and is not included initially.

**Tracker synchronization**

- Native issues remain locally authoritative. Linked Linear/Jira issues remain externally authoritative.
- Mirror external issue fields; retain local plans, execution history, and private notes separately.
- Allow explicit upstream status changes and comments through a durable outbound queue. Use provider status mappings and valid Jira transitions.
- Poll every 60 seconds with pagination, incremental checkpoints, and periodic reconciliation. Show pending writes, authentication failures, and stale synchronization.
- Reconcile uncertain comment delivery before retrying. External cancellation blocks queued work and alerts on active work.

**Sessions, reactions, and completion**

- Cloud uses tmux plus a Go PTY bridge and xterm.js. Browser disconnect detaches without stopping the agent. Support multiple viewers and one active input controller.
- Prefer native harness signals; treat screen inactivity as uncertain. Fence events by session launch generation.
- Persist CI/review reactions and delivery state. Both orchestration requests and automatic reactions use one deduplicated action queue.
- Default to two automatic repair turns per worker run. Deliver prompts only when the harness confirms safe input readiness; permission prompts require human action.
- Adopt surviving sessions after an application restart. After container/host restart, resume only an exact saved conversation; otherwise show **Resume required**.
- Native issues finish after required PRs/MRs merge or explicit manual acceptance. Process exit, closed-unmerged changes, and missing worktrees are not success.
- Preserve repository instruction files. Supply briefs separately.
- Before cleanup, check for uncommitted/unpushed work, stop the session, then recheck. Default safe-worktree retention is seven days.

## 5. Docker delivery and verification

**Distribution**

- Publish versioned Linux `amd64` and `arm64` images containing the Go application, embedded UI, bundled plugins, Git, SSH tooling, tmux, and required CLI runtimes.
- Provide one documented `docker compose up -d` deployment with persistent `/data`. No external database, queue, or Docker socket is required.
- Setup installs the user-selected harness versions into persistent tool storage. Pin tested versions and make upgrades explicit; unavailable architecture combinations fail preflight.
- Persist SQLite, repositories, worktrees, agent homes, and credentials across container replacement.
- Supervise the application separately from tmux inside the container so an application-process restart can preserve sessions. Whole-container replacement uses conversation recovery.
- Run as a non-root user. Use normal agent permissions and private Tailscale/SSH access, with Host/Origin and CSRF checks.
- Deliver backup/restore and upgrade instructions. Desktop packaging and standalone systemd distribution are deferred.

**Implementation sequence**

1. Shared core, plugin registry, workspace cloning/attachment, native tracker.
2. Terminal runner, harness selection, browser supervision, durable recovery.
3. Orchestrator/worker roles, approved-plan execution, dependency scheduling.
4. Linear/Jira synchronization and GitHub/GitLab review workflows.
5. Docker release, notifications, cleanup, backup/restore, and installation verification.

**Acceptance tests**

- Mixed-harness orchestrator/workers; duplicate dispatch; unapproved task rejection; dependency ordering; orchestrator restart.
- Clone/attach workflows across multiple repositories, duplicate folder names, private SSH/HTTPS remotes, and generic Git hosts.
- GitHub PR and GitLab MR workflows, with no `gh` requirement.
- Plugin distribution/platform filtering and explicit handling of missing capabilities.
- Terminal reconnect, resize, input ownership, stale hooks, application restart, container replacement, and unsupported resume.
- Tracker conflicts, pagination, rate limits, revoked credentials, and uncertain outbound delivery.
- Deduplicated CI/review feedback, permission-blocked sessions, repair limits, and guarded cleanup.
- Fresh Docker installation completes an approved multi-worker plan through human-reviewed merges while the laptop is offline.

## 6. Execution checkpoint — 23 October 2026

The first executable implementation lives in [`cloud/`](../cloud/README.md), alongside the existing application. It includes the Go/SQLite core, bundled integration contracts, React Kanban board, workspace clone/attach, tmux terminals, approved-plan scheduler, separate orchestrator/worker roles, durable event/outbound queues, provider adapters, Docker packaging, and backup/cleanup commands.

Verified locally with isolated fake agents and mock providers: concurrent approval deduplication and rollback; dependency ordering; immutable harness snapshots; scoped API operations; stale-generation rejection; permission-aware bounded follow-ups; real tmux prompt delivery/adoption; browser board/approval/input/reconnect and single-controller ownership; GitHub/GitLab normalization and tracker pagination/transitions; Docker non-root execution, two harness profiles, API-process crash survival, whole-container exact-conversation recovery, database backup, and manual acceptance. Linux amd64 and arm64 binaries compile. Browser layouts were checked at desktop and mobile viewport sizes.

Release work still open:

- Live acceptance with authenticated harnesses, private remotes, and real GitHub/GitLab/Linear/Jira accounts, including the offline-laptop workflow through human-reviewed merges.
- Native readiness adapters for Codex, agy, and OpenCode. These harnesses currently support terminal launch, explicit sending, and exact-ID resume; automatic follow-ups require Claude's native hooks.
- In-browser harness installation/login and a pinned, live-tested harness compatibility matrix. The current CLI installer requires explicit versions; agy installation uses a versioned vendor binary.
- External deletion/archive reconciliation and optional external-comment mirroring. Uncertain outbound delivery currently requires operator verification before retry.
- Published multi-architecture release artifacts and real mobile-device testing.

The full plan remains the target. This checkpoint records implemented behavior and validation limits; it does not mark the entire release complete.

Existing-application regression check: typecheck passed; Bun reported 166 passed and two Superset-related failures. The same two failures reproduced from an untouched `HEAD` archive. Cloud tests, browser workflow, and Docker recovery smoke tests passed independently.

Current testing setup: native macOS at `http://localhost:4780`, with `executionEnvironment: "host"` to reuse installed Git/agent CLIs, the existing user home, and SSH agent. Local test data has been reset and moved outside the checkout to `~/Library/Application Support/Autopilot Cloud`; Linux defaults to its XDG data directory, while Docker explicitly uses `/data`. Docker is stopped with its persistent volume retained; server deployment remains a later testing step.

Workspace management now includes an import flow that scans an existing directory and atomically registers selected Git repositories. Removal deletes local tracking data and workspace credentials, preserves repository directories and worktrees, and refuses while runs or agent sessions are active. The UI exposes Import workspace in the sidebar and Remove workspace on the Workspace page.
