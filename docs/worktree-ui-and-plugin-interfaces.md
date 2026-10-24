# Worktree navigation and plugin settings

Status: cloud implementation delivered, 23 October 2026. The implementation checkpoint below distinguishes the working cloud features from remaining desktop/provider extensions. It supersedes the session-first navigation, run-owned worktree lifecycle, generic integration form, and fixed tracker polling in the [original plan](autopilot-cloud-plan.md). Shared Go/React architecture, horizontal issue board, plans, Docker packaging and separate orchestrator/worker roles remain.

## 1. Product model

Autopilot is a place to manage repositories, worktrees, issues and coding agents. Opening the application must make the user's code and current work immediately understandable.

**A worktree exists independently of an agent, issue, plan or run.** Users can create one manually, work in it themselves, start a shell or agent, stop that process, and return later. Orchestration operates on the same worktrees as manual work. It is optional for manual development.

An approved plan can still dispatch workers. An orchestrator can still propose and coordinate work. Neither is required to browse a repository or create a worktree. Queue intake does not automatically approve a plan or start agents.

## 2. Navigation and worktree screen

Use the supplied repository/worktree sidebar screenshot as the structural reference:

```text
autopilot
[ tilda ▾ ]                       [+]

Issues
Plans

REPOSITORIES                 [+ Add]
▾ ash-nazg                       [+]
    ◇ (default) main
    ● ENG-7955 completion
    ! ENG-7899 query fix
    ✓ training-management
▾ cleopatra                     [+]
    ◇ (default) main
    ○ local-experiment
▸ linear-autopilot               [+]

Settings
```

- Keep workspace selection at the top. Its menu includes create, import and workspace management; avoid another permanent navigation item for each operation.
- Keep Issues and Plans. Remove Agent sessions, Needs attention and the duplicate Projects → All issues navigation. Project filtering remains inside Issues; label the page **Issues**.
- Show each repository, its primary checkout, and all linked Git worktrees, including ones created outside Autopilot and worktrees without running processes. Persist expansion and selected worktree by ID.
- Repository `+` opens **New worktree**, already scoped to that repository. Repository overflow provides fetch, rescan, settings and unregister actions.
- Worktree rows show name, branch on hover/details, and status. Long names truncate with full text accessible on hover/focus; rows do not grow into multiline cards. Selection is distinct from status.
- Use shape plus accessible text, not color alone: neutral checkout icon for no agent, running indicator, attention exclamation, completed check, failed indicator. Reduced-motion users get a static running icon.
- Worktree and session status remain separate. A live but idle agent is **Waiting**, a stopped session is **Stopped**, and an exited process alone is never **Finished**. A worktree can have a live shell without a coding agent.
- If several sessions exist, show the most urgent agent state (attention/error before running/waiting), plus a count. Preserve detailed states in the worktree view. Old completed runs do not override a newer active or failed attempt.
- Keep every worktree selectable regardless of state. Status filters are optional controls above the tree, not replacement destinations. Non-worktree errors such as tracker authentication appear on Settings with a badge and relevant inline error.
- The selected worktree opens a full main-pane view: repository/worktree breadcrumb, branch/base, linked issue and PR/MR when available, **Terminal**, **Changes**, and **Activity** tabs. Start agent and New terminal are explicit actions. Terminal tab selection never implicitly launches an agent.
- Multiple terminal sessions appear as tabs within that worktree. Preserve sessions on navigation; reconnect to the chosen session. A terminal remains usable without an issue or run.
- Workspace-level orchestrator, when started, appears as an optional pinned coordinator row with the same status vocabulary. Worker sessions remain under their worktrees.
- On narrow screens, use a collapsible navigation drawer with the same repository tree and workspace selector. Preserve keyboard navigation, focus, active row indication and accessible status labels.

## 3. Manual worktree creation, discovery and lifecycle

**New worktree** fields:

1. Repository (prefilled from repository `+`).
2. Worktree name.
3. Base branch: searchable local/remote branches with the repository default preselected when valid. Show the exact ref; fetch is an explicit action with progress/errors.
4. New branch: derived from the name, editable with a preview. Display destination path in managed storage outside the source checkout; advanced location selection can follow later.
5. Optional linked issue. Creating the worktree does not require one.

Primary action: **Create worktree**. Agent startup remains a separate action after creation, with harness and optional prompt. No plan approval is required for a manual session; scheduled task execution still follows approved-plan rules.

Lifecycle requirements:

- Enumerate actual Git worktrees, including the primary checkout, using the repository service. Branch names alone are not worktree identity; canonical repository/common-directory and worktree paths establish identity, then assign stable app IDs.
- Validate branch refs, existing checkout conflicts, destination collisions and base-ref existence before creation. Serialize mutations per repository and make duplicate requests idempotent. Failed creation must not leave an app entry that claims success; reconcile any Git side effects.
- Reconcile on repository import, explicit rescan and periodic refresh. Register existing worktrees without moving files or starting sessions. Handle detached HEAD and missing directories explicitly.
- Manual and externally discovered worktrees are retained until the user removes them. Automatic retention can apply only to eligible managed task worktrees; do not automatically delete primary checkouts, manual/external worktrees, pinned worktrees, or worktrees with active terminals/agents.
- Separate **Unregister** (app metadata) from **Remove worktree** (Git/filesystem mutation). Removal previews path/branch and blocks active sessions, dirty/unpushed work and primary-checkout deletion. Branch deletion is a separate explicit option.
- Preserve existing imported repositories and run worktrees through the data migration; this redesign does not require another reset.

Data changes:

- Add a durable `Worktree` resource: ID, repository ID, display name, canonical path, branch/detached commit, base ref when known, primary flag, origin (`manual`, `discovered`, `run`), pinned flag and filesystem status. Base information may be unknown for existing worktrees; do not fabricate it.
- Runs reference worktree IDs through a relation supporting multiple repositories. Migrate existing inline `Run.Worktrees` entries without recreating Git worktrees; retain execution snapshots for history.
- Sessions have an optional run ID, a primary worktree ID plus optional additional worktree references, and a kind (`shell`, `agent`). Agent role/harness apply only to agent sessions. Coordinator sessions can instead have workspace scope.
- Issue/worktree links support multiple worktrees for one issue and explicit disambiguation. Queue entries are distinct from issues and runs.
- Add service/API operations for list/discover worktrees, list branches, create/adopt/unregister/remove, and start/open a shell or agent for an existing worktree. Extend snapshots/events to keep the tree current across tabs and restarts.

## 4. Settings and plugin discovery

Replace the generic Integrations destination with **Settings**. The initial sections are General, Workspace, Plugins, Agents and Terminal. Adding tracker/version-control connections creates named sections beneath their categories, e.g. **Trackers → Linear · Product** and **Version control → GitHub · Work**.

Plugins page groups cards into **Trackers**, **Version control**, **Agents**, and **Launchers**. Each card has recognizable identity, a brief purpose, a capability-appropriate status, and its own action:

| Plugin state/type | Card action | Destination |
|---|---|---|
| External tracker/provider not configured | Add / `+` | That plugin's connection/setup screen |
| Configured tracker/provider | Configure; overflow Add account | Named connection settings |
| Native tracker | Configure | Native issue/workflow settings; no sign-in |
| Available agent harness | Configure | Harness defaults and profiles |
| Missing agent harness | Setup | Installation/authentication instructions with actual availability |
| Built-in terminal | Configure | Terminal settings; already enabled |
| Desktop launcher | Enable / Configure | Launcher-specific options |

Remove the global **Connect integration** button and generic provider selector from connection setup. A GitHub card opens GitHub setup; a Linear card opens Linear setup. Card actions are keyboard accessible. Support multiple accounts/connections without duplicating plugin definitions.

Do not show the same green dot for bundled, executable found, authenticated and working. Distinguish **Available**, **Not configured**, **Connected**, **Sign-in required**, **Unavailable**, **Sync error**, and **Disabled** where appropriate. Harness executable detection does not prove login.

Shared manifest contract: stable ID/type/version, compatible distributions/platforms, display metadata, configuration fields/defaults, declared operations, available auth methods, prerequisites and health checks. Pair the shared settings shell with type-specific forms and plugin-specific fields. The Go backend validates configuration/capabilities and stores secret references; frontend hiding alone is insufficient.

## 5. Tracker interface and settings

Each connection exposes these settings:

- **Account and scope:** identity, server/site where applicable, workspace binding, Linear teams/projects or Jira projects/filter, assignee/label filters. Use provider-native labels and status IDs.
- **Intake:** statuses to watch and queue rules. Distinguish statuses included in synchronization from statuses that trigger queue entry. Show current matches and a preview before enabling intake.
- **Synchronization:** configurable poll interval (initial default 60 seconds), pause, sync now, last/next sync, errors/retry-after. Optional webhook setup includes endpoint, secret, registration/verification status, test delivery and fallback reconciliation polling. Offer it only when the adapter supports it and the server is reachable by the provider.
- **Existing work:** Discover tickets from worktrees scans branch names and optional PR/MR references for provider-recognized keys, resolves candidates and previews links. Require confirmation for ambiguous matches. Linking historical worktrees must not silently queue or relaunch their tickets.
- **Workflow:** valid transitions/status mappings, comment behavior and optional configured transitions on explicit lifecycle events. Jira transitions and Linear status updates stay adapter-specific. Native issues do not display irrelevant webhook/account controls.
- **Authentication:** OAuth sign-in is enabled only in the **desktop/non-cloud distribution**, as requested. Cloud offers supported server credentials. Running the cloud distribution locally with host credentials does not change its distribution flag or enable desktop OAuth.

Proposed capability contracts (context/connection scope and typed errors apply to every call):

| Group | Operations |
|---|---|
| Identity and scope | `ValidateConnection`, `CurrentUser`, `ListScopes`, `ListStatuses` |
| Read/discover | `QueryIssues(filter, cursor)`, `GetIssue(idOrKey)`, `ListComments`, `ResolveWorktreeCandidates` |
| Write, when supported | `CreateIssue`, `UpdateIssue`, `ListTransitions`, `TransitionIssue`, `AddComment` |
| Webhooks, when supported | `RegisterWebhook`, `VerifyWebhook`, `NormalizeWebhookEvent`, `RemoveWebhook` |
| Authentication | `AuthMethods`, `BeginSignIn`, `CompleteSignIn`, `RefreshAuth`, `Disconnect` |

Split optional operations into capabilities/subinterfaces; no fake implementation of unsupported methods. Normalize shared issue fields and keep provider metadata, transition IDs, pagination and rate-limit details. Provider adapters own API/CLI specifics; the core owns durable queueing, deduplication and scheduling.

Polling and webhooks feed the same idempotent ingestion pipeline. Deduplicate deliveries and queue entry by connection + issue + intake rule + eligible transition/version, not every poll. Ignore stale/out-of-order updates and avoid replaying the initial baseline into execution. A repeated webhook must never launch another worker. Removing eligibility withdraws pending intake; active work is surfaced for user review. Queue arrival is distinct from execution approval.

## 6. Version-control interface and settings

Use **Version control** in the UI; retain a provider-neutral Git service for clone/fetch/push/worktree operations. GitHub/GitLab/Bitbucket are adapters, and `gh` is only a possible GitHub adapter transport.

Connection settings cover:

- Authentication method supported by that adapter/distribution: OAuth, provider CLI account, or server token. Show provider host, verified user, scopes/capabilities and connection health. Tracker-specific desktop-only OAuth policy does not silently become a global provider policy; provider OAuth must be explicitly declared and configured for the distribution before being offered.
- Per-workspace provider account selection, with explicit repository override if needed. Git transport identity and Git author identity are displayed separately from the API account; validate both where applicable.
- CLI executable/config/account selection, credential test, remote/repository association, polling/webhook behavior for PR/MR and CI updates.
- PR/MR status, CI summary, comments/reviews, mergeability/conflicts and merged/closed state. Unknown or pending mergeability remains unknown; closed-unmerged is not merged.

Proposed operations: `ValidateAccount`, `CurrentUser`, `ResolveRepository`, `FindChangeRequest`, `GetChangeRequest`, `CreateChangeRequest`, `ListChecks`, `ListComments`, `ListReviews`, `AddComment`, `GetMergeability`, `GetMergeStatus`. Optional merge operation is a distinct capability with explicit human confirmation if exposed later; status checks alone never authorize merging.

Every operation receives an explicit account/credential reference plus workspace/repository scope. Never run a global CLI account-switch command before an operation: simultaneous workspaces must not race over the machine's active account. Use an isolated CLI configuration/environment or per-invocation credentials. If a CLI cannot safely select the required account, show that limitation and use an available API transport. Git/SSH credential selection must follow the same workspace account boundary. OAuth secrets stay on the machine/server that executes the operation.

Initial implemented providers remain GitHub and GitLab. Bitbucket continues to support generic Git; its PR/CI/comment adapter is separately scheduled and must not appear fully connected until implemented and verified.

## 7. Launcher and agent contracts

Preserve the older application's launcher behaviors from [`src/workspaces/types.ts`](../src/workspaces/types.ts):

| Existing operation | Shared-core/adapter responsibility |
|---|---|
| `ensureWorktree(repoPath, branch, background)` | Compatibility facade delegates to repository service; extend request with name and explicit base ref |
| `adoptWorktree(repoPath, worktreePath, branch)` | Register an existing worktree without recreation or session startup |
| `openSession(request)` | Open the chosen terminal/tool with primary and additional worktrees, prompt, brief and background preference |
| Optional `resendPrompt(request)` | Expose only if launcher/harness supports it |
| `removeWorktree(repoPath, path, branch, force)` | Delegate to guarded repository lifecycle; no implicit force |
| `link(worktreePath)` | Optional tool deep link; absence is explicit |

Existing adapter inventory: Git/terminal, Worktrunk, Superset, Supacode, VS Code and Cursor (`src/workspaces/launch.ts`). Preserve behavioral compatibility while porting adapters; do not imply the existing TypeScript implementations already run inside the Go application.

The repository service owns creation/discovery/removal once; launcher adapters must not each create a second worktree. Keep a compatibility facade for older tooling that combines worktree preparation and launch.

Cloud uses the built-in terminal without an IDE picker. Keep tmux lifecycle operations (`Start`, `Inspect`, `Send`, `Interrupt`, `Stop`) and terminal attach/input/resize capabilities behind the runtime interface. Desktop launchers are optional **Open in…** actions with executable/path, foreground/background and tool-specific settings. Embedded terminal is the default even on desktop.

Agent settings remain a separate plugin type: detected command/version, authentication health when observable, profiles/model/options, working-directory behavior, prompt delivery, exact-conversation resume and supported status signals. Workspace defaults for worker and orchestrator are independent; a manual session can override its harness. Launcher choice must not imply Claude or any other harness.

## 8. Implementation order and acceptance

1. **Immediate layout corrections:** fix repository text collapse caused by the full-width select; give adjacent primary/secondary actions explicit spacing. Verify populated repositories with remotes at desktop, intermediate and mobile sizes.
2. **Worktree resource and migration:** discovery, identity, manual create with name/base, branch listing and safe lifecycle; migrate existing runs and preserve user data. Add API tests for repeated creation, branch/path conflicts, detached HEAD, primary checkout protection and external worktrees.
3. **Navigation and terminals:** repository/worktree tree, worktree main view, independent shell/agent sessions and status icons; remove redundant sidebar entries. Verify creating/selecting a worktree without any issue/plan/agent, reconnect, keyboard navigation and multiple tabs.
4. **Settings and plugin catalog:** grouped cards with Add/Configure actions, dynamic connection sections, workspace scoping and honest health states. Wire existing connection features into the new shell before enabling new capability switches.
5. **Tracker settings and intake:** configurable polling, native statuses/transitions, queue rules, ticket discovery, webhook support and desktop-only OAuth. Verify duplicate/out-of-order deliveries, baseline behavior, ambiguous ticket matches, eligibility changes and unsupported capability states.
6. **Version-control accounts and operations:** explicit workspace accounts, PR/MR, CI, comments/reviews, mergeability/status and provider-native authentication. Test two simultaneous workspaces using different accounts on the same host without global CLI mutation.
7. **Desktop launcher parity:** port/bridge the existing contract against the shared repository service; embedded terminal remains first choice. Check cloud/desktop capability enforcement in both UI and API.

The new sidebar is not a cosmetic rename of Agent sessions: accepting it requires discovering actual Git worktrees and navigating them without a run record. The plugin redesign is not a single generic form with different labels: accepting it requires useful settings and operations per plugin type, with unsupported functionality clearly absent or explained.

## 9. Immediate UI review

| Before | After | Why |
|---|---|---|
| Provider select consumes row width; path becomes one character per line | Bounded provider column, flexible repository details, stacked metadata at narrower widths | Repository identity stays readable |
| Adjacent welcome actions touch | Shared flex action group with explicit gap and wrapping | Distinct click targets across viewport sizes |
| Sessions and attention replace repository navigation | Persistent repository/worktree tree with status icons | Navigation follows the user's code, including manual work |
| Generic identical integration cards and global connect action | Grouped plugin cards with Add/Configure and type-specific settings | Setup starts from the service the user chose |
| Duplicate All issues sidebar entry | One Issues destination with in-page filters | Removes redundant navigation without changing the board |

Only the first two layout corrections are implemented in this planning pass. Remaining sections describe the agreed direction to implement next.


## 10. Implementation checkpoint — 23 October 2026

Implemented in the cloud application:

- Persistent worktrees discovered from Git, including primary and externally created checkouts. Stable IDs and run/session migration retain legacy setup progress. A linked checkout cannot be registered as a second repository.
- Repository/worktree sidebar with status icons, manual name/branch/base creation, explicit fetch/rescan, pin/hide/restore and guarded removal. Manual worktrees are pinned and excluded from automatic run cleanup.
- Full worktree view with independent shell and agent terminals, reconnect, multiple sessions, Changes and Activity. Existing run acceptance/cancel/retry controls remain in Activity. Issues and Plans remain primary destinations; duplicate All issues/session/attention navigation is removed.
- Settings navigation, grouped plugin cards with individual Add/Configure actions, named connection sections, editable agent command profiles and terminal font preferences. Installation limits and native workflow are currently informational.
- Linear/Jira per-connection polling, status mapping, watched-status intake, explicit ticket linking from branch names, connection verification and signed webhook receivers. Initial sync does not queue historical work; duplicate eligible transitions are deduplicated, and disabling intake withdraws pending entries. Queuing does not approve a plan.
- GitHub/GitLab account defaults per workspace and repository overrides, host validation, explicit GitHub CLI username selection without global account switching. PR/MR state, CI, feedback, comments and mergeability can be inspected from Changes. Git transport and author identity remain the separately configured host Git identities.
- Existing local data is migrated in place; managed files remain outside the source repository.

Validation: Go race suite and vet; TypeScript/Vite production build; all three Playwright workflows, including manual worktree/shell/agent flow, approved plans/reconnect, and workspace import/removal. Desktop and mobile-width screenshots were inspected. Provider behavior is mock-tested; no private provider mutation or paid model invocation was used for validation.

Remaining extensions (not represented as working controls): desktop OAuth and native launcher ports/compatibility facade; Bitbucket review APIs and GitLab CLI account transport; per-workspace Git/SSH transport credentials and author settings; automatic provider webhook registration, richer tracker query/filter previews, unsynchronized-ticket resolution and comment mirroring; provider comment creation from the worktree review pane. Desktop adapters remain in the older app until ported. The cloud terminal uses the shared Git lifecycle and tmux launcher contract now.


## 11. Terminal-first refinement — 23 October 2026

This revision supersedes the earlier worktree header, read-only terminal default and manually managed issue board.

| Before | After | Why |
|---|---|---|
| Large worktree heading, path, action row and terminal control bar | Compact workspace/repository/branch breadcrumb, terminal tabs and bottom launcher shortcuts | Keep terminal content in view |
| Coordinator opens a session modal | One workspace coordinator with its own terminal page | Direct access to planning conversations |
| Take control before typing | Input is enabled on attachment, including additional browser tabs | Direct terminal interaction |
| Manual issue status and priority controls | Automatic execution states; new tickets enter triage | Track actual agent progress |
| Projects and queue filters lead the board | Lightweight execution board; optional project metadata is secondary | Keep focus on current work |
| Worktree Changes/Activity as full-page tabs | Optional right-hand inspector tabs | Keep the terminal visible |

Supported coordinator and worker harnesses launch/resume in bypass mode. Agent permission mode does not authorize plan approval or merge operations. Existing exact-resume semantics remain; shell terminals are independent. Automatic triage uses persistent per-issue coordinator assignment and explicit idle readiness, never terminal text guessing. Plan links and workflow state are derived from persisted records; manual status edits do not override execution progress.

Validation covers automatic coordinator pickup and planning of two successive tickets, linked plan review, no premature worker dispatch, multiple terminal clients with immediate input, worktree launch shortcuts, right inspector, default Issues navigation, and isolated workspace coordinators.

Live verification: the existing Codex coordinator resumed the same conversation in bypass mode and successfully reported idle with fresh session credentials. Codex sessions now use `--no-daemon` to keep generation-scoped credentials inside their own process. The one-time migration released the old daemon's idle conversation through the supported archive/unarchive API, retaining its history. The existing issue, draft plan and shell session were preserved; no worker was started or plan approved. The production build, four browser workflows, Go race tests and vet passed.
