# Architecture

Autopilot is a Bun/TypeScript daemon with server-rendered HTML. There is no frontend framework,
separate API deployment, or dependency-injection container. The folders separate responsibilities
while keeping the existing CLI, HTTP routes, configuration format and SQLite schema intact.

## Directory map

```text
src/
  cli.ts                  # stable entry point, also compiled for distribution
  app/                    # workflows and composition: daemon, autopilot, login, reset, health
  domain/                 # ticket/work types and pure rules (no I/O)
  config/                 # defaults, paths, validation and settings persistence
  storage/                # SQLite schema, migrations and queries
  trackers/               # Linear/Jira clients, MCP transport and OAuth provider
  triage/                 # LLM routing/explaining, branches, brief files and template
  repos/                  # catalog, existing-work import, folder suggestions
  workspaces/             # launchers and read-only git/GitHub work inspection
  platform/               # macOS, Keychain, environment and external-tool adapters
  updates/                # release checking, installation and update state
  shared/                 # logging
  types/                  # embedded-asset import declarations
  web/
    server.ts             # HTTP composition, Host/Origin allowlists and CSRF
    context.ts            # application dependencies available to request handlers
    routes/               # GET page/data routes and POST action dispatch
    presenters/           # application state -> page snapshots
    models.ts             # data-only view contracts
    views/                # HTML templates, layout and components
    assets/               # styles.css, live.js, service-worker.js
    setup.ts              # pure setup-step definitions and completion rules
    state.ts              # live polling snapshots/version
    http.ts               # CSP, nonce, redirects and Response construction
    oauth-callback.ts     # short-lived loopback callback server
    pwa.ts / static.ts    # embedded assets, manifest and allowlisted static routes
test/                     # mirrors subsystem folders; shared fakes in fixtures/
public/icons/             # static icon sources, embedded in the binary
scripts/                  # build and distribution tooling
```

## The view boundary

For a dashboard request, the path is:

```text
server -> routes/pages -> presenters/dashboard -> views/dashboard -> HTTP response
                              |                      |
                       app/store/services        domain rules
```

The presenter reads tickets, groups their phases, collects progress and notices, resolves worktree
links, and loads the catalog once when tickets exist. The template receives that snapshot, not an
application object. Settings and setup routes likewise gather accounts, repos, paths and statuses
before passing them to their templates.

Views can format strings, choose markup, and use pure domain helpers. They cannot query SQLite,
read files, spawn commands, fetch APIs, or invoke application actions. Type-only imports describe
data contracts without loading services at runtime. CSS and browser scripts are separate files,
imported as text so the distributed binary still embeds them. The live script still runs under the
response's CSP nonce; moving it out of a TypeScript string does not make it a separately served script.

POST requests go through `routes/actions.ts` to the existing application/configuration services.
Templates only emit form URLs and fields. Server-side approval, validation and deletion checks remain
authoritative; hiding a button is never a substitute for those checks.

`domain/` contains shared rules such as `phaseOf`, `atRisk`, work stages, worktree IDs and legacy
work-snapshot decoding. Neither domain rules nor backend services import web templates. The `app/`
composition layer connects backend services and HTTP adapters; it owns orchestration, not markup.

OAuth follows the same split: `app/login.ts` manages the credential flow, `web/oauth-callback.ts`
validates the HTTP callback, and `web/views/auth.ts` renders its response. Ticket briefs use the pure
`triage/brief-template.ts`; `triage/brief.ts` owns writing/removing their read-only files.

## Where to make changes

| Change | Start here |
| --- | --- |
| Ticket layout, wording or modal markup | `web/views/components/tickets.ts` |
| Colors, spacing or responsive layout | `web/assets/styles.css` |
| Browser polling, busy buttons or badge behavior | `web/assets/live.js` |
| Dashboard grouping/data | `web/presenters/dashboard.ts` |
| Ticket phase or deletion-risk rules | `domain/issues.ts`, `domain/work.ts` |
| Approval, polling or launch workflow | `app/autopilot.ts` |
| New HTTP action | `web/routes/actions.ts`, delegating work to the relevant service |
| Settings field | `config/config.ts`, `config/settings.ts`, `web/views/settings.ts` |
| Tracker behavior | `trackers/` |
| Editor/terminal/worktree integration | `workspaces/launch.ts` |
| Brief Markdown layout | `triage/brief-template.ts` |
| SQLite migration/query | `storage/db.ts` |

Do not add a new abstraction for every function. Keep related behavior together, and extract when
there is a real boundary (rendering versus I/O, shared rules versus service calls).

## Compatibility and verification

`src/cli.ts` remains the entry point used by package scripts, service commands and release builds.
Only `config/config.ts` derives the source project root. Running from source still stores data at
the project root unless `AUTOPILOT_HOME` is set; compiled builds still use Application Support.
Moving files must not change these locations, tracker Keychain names, ports or database columns.

Run `bun test` and `bun run typecheck`. Tests are grouped by subsystem and include fake tracker/LLM/
launcher end-to-end scenarios. `test/architecture.test.ts` guards runtime dependency boundaries;
`test/web/views.test.ts` renders snapshots without a database/server; presenter and HTTP tests cover
data preparation and route behavior. `test/config/paths.test.ts` checks source-root resolution.

Use a disposable `AUTOPILOT_HOME` and isolate installed CLIs when testing on a configured Mac;
tests must never reach real trackers, launch sessions or modify the user's data. Do not run `once`
as a smoke test: it performs a real poll. After changes to paths or asset imports, also compile both
macOS targets (`bun run build`) and smoke-test the binary's `version` and `paths` commands with a
temporary home. The build script recreates `dist/`, which contains generated output only.
