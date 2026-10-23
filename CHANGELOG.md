# Changelog

This file is the source of truth for release notes. Add user-visible changes under **Unreleased**
in the same commit as the code. When releasing, move those entries into a versioned, dated section
and leave an empty Unreleased section above it. Committing these notes does not publish a release.

Export a section as Markdown with `bun run changelog`, or as JSON with
`bun run changelog --json`. A version can be supplied, for example
`bun run changelog 0.1.0-beta.9`. See [the changelog workflow](docs/changelog.md).

Earlier history remains in Git commits, tags and GitHub releases; this file starts with
`0.1.0-beta.9`.

## [Unreleased]

### Public beta installation and upgrades

- Install the background service with `brew install --formula mrinalraj/tap/autopilot`, then
  `brew services start autopilot` and `autopilot open`. Add the optional native window with
  `brew install --cask mrinalraj/tap/autopilot` and `open -a Autopilot`.
- Existing formula users: run `brew update`, `brew upgrade --formula autopilot`, then
  `brew services restart autopilot` before adding the app. Keep the formula installed.
- Existing beta.9 cask users: quit Autopilot, run `brew update` and `brew upgrade --cask autopilot`.
  App-only use still works. To add the independent service, install and start the formula before
  reopening the app. Upgrade the cask first so its old CLI link can be handed over to the formula.
- Settings, tickets and Keychain sign-ins are shared and preserved. Use a normal upgrade;
  the old beta.9 cask's `--zap` option deletes shared app data. The new cask's zap rules preserve it.
- Upgrade the formula and cask separately when both are installed. An attached app displays the
  formula daemon's web UI, so upgrading only the app does not upgrade that interface.
- This public beta is **ad-hoc signed and not notarized**. After trying to open a downloaded app,
  use **System Settings → Privacy & Security → Open Anyway** if macOS blocks it, then confirm.
  See [Apple's first-launch instructions](https://support.apple.com/en-us/102445).
- Older releases and their assets remain available for existing installations and download links.
  Beta versions continue to receive update notifications for newer public betas.

### Added

- A dismissible web health banner offers the optional native app, with install/open commands
  and the manual macOS first-launch approval warning. Native windows hide browser installation tips.
- The app connects to a compatible running formula service using the same data, without stopping
  or uninstalling it. It reconnects after service restarts and leaves the service running on Quit.
  With no listener, the app still starts and manages its own worker. Formula versions through
  beta.9 need an upgrade and a normal service restart before accepting app connections.

### Changed

- Installation instructions lead with the Homebrew formula and browser workflow, with the native
  app as an optional addition and an explicit manual first-launch approval warning.
- The cask installs only the app, leaving the CLI to the formula. App uninstall and `--zap` preserve
  shared settings and tickets. Formula updates explicitly select `--formula` when both are installed.
- Web health banners refresh when checks change, even when the ticket queue is unchanged.
- Settings opens without waiting for account, repository or service checks, and groups controls
  into six sections with independent saves, retained drafts and inline validation.
- Dashboard cards use a denser grid with repository, project, age and work summaries. Logs reserve
  their own bottom pane or side column. Headers and Settings navigation stay visible as content scrolls.
- Navigation, dialogs, log panels and saves provide motion and immediate feedback, with reduced-motion
  support, stable loading buttons, keyboard focus containment and improved status/button contrast.

## [0.1.0-beta.9] - 2026-10-22

### Desktop beta installation

- Install on macOS 13 or later with `brew install --cask mrinalraj/tap/autopilot`, then open
  Autopilot from Applications. Apple Silicon and Intel downloads are attached to the release.
- This beta is **ad-hoc signed and not notarized**. After trying to open it, if macOS blocks it,
  use **System Settings → Privacy & Security → Open Anyway** and confirm.
  See [Apple's first-launch instructions](https://support.apple.com/en-us/102445).
- Existing formula users must first run `brew services stop autopilot` and
  `brew uninstall --formula autopilot`. Settings, tickets and Keychain sign-in are preserved.
- Automated native launch and lifecycle checks run on Apple Silicon. Intel builds compile and
  their helpers are checked under Rosetta; Intel hardware and interactive OAuth, notifications
  and Open at Login checks remain pending.

### Added

- Native macOS app with an embedded daemon, WebKit window, Dock badge, menu bar controls,
  notifications and an optional Open at Login setting. Closing the window keeps polling;
  quitting the app stops its worker.
- Apple Silicon and Intel app builds, signing/notarization support and Homebrew cask generation,
  with migration instructions that preserve existing settings, tickets and Keychain sign-in.
- Editable ticket triage: change the summary, approach, likely code areas and size directly in the
  existing box and click Update. Approve & launch saves any current edits first. Saved edits persist
  in the database and brief; stale forms and save errors prevent launch and preserve the draft.
- Superset launcher support for local workspaces, multi-repo tickets, Claude terminals, workspace
  links and worktree cleanup. Configure its executable with `launch.supersetBin`.
- Automatic registration of existing worktrees with the selected launcher, preserving their paths,
  individual branches, uncommitted files and PR tracking. Registration does not run workspace setup
  scripts or start sessions.
- A version-controlled changelog and Markdown/JSON export command for sharing pending changes and
  preparing release notes.

### Changed

- Launchers use a common adapter interface. The launcher selected in Settings controls existing
  and new tickets, including links, launch retries, chat prompts and cleanup; stored launcher names
  track completed registration rather than override the selection.
- Unfinished launcher registration retries automatically every 30 seconds, independently of tracker
  availability. Successful setup is remembered across restarts, with progress and errors on tickets.
- Existing-work discovery uses Git without querying unselected launchers. Changing launchers waits
  for active ticket operations to finish.

### Fixed

- A competing daemon is rejected before opening ticket state, and desktop updates cannot replace
  the bundled executable separately from its signed app.
- Older Supacode worktrees no longer cause Supacode to open after selecting a different launcher.
- Superset connection checks accept a reachable desktop host even when CLI process-status metadata
  is stale. Desktop users no longer see instructions requiring a separate foreground host terminal.
- Invalid launcher configuration no longer falls back to Supacode, and other launchers no longer
  display the Supacode recommendation banner.
- Editor links preserve spaces, Unicode and reserved URL characters in worktree paths. Claude
  commands correctly quote custom executable paths, prompts and additional directories.
- Briefs for imported multi-repo tickets describe each repository's existing branch accurately.
