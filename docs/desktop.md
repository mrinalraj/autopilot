# macOS desktop app

Autopilot.app is a Swift AppKit host with a WKWebView and the compiled Bun CLI embedded at
`Contents/Helpers/autopilot`. No Node, Bun, Rust, Electron or web server installation is needed
on the user's machine. The existing server-rendered UI and loopback HTTP security stay in use.
This is a macOS app wrapper around that UI, not a rewrite of the screens in SwiftUI.

## Build locally

Build on macOS with Xcode Command Line Tools, Bun and installed project dependencies:

```sh
bun install --frozen-lockfile
bun run build:app                  # Apple Silicon and Intel
bun run build:app --arch arm64     # faster local iteration
```

Outputs:

- `dist/desktop-arm64/Autopilot.app`
- `dist/desktop-x64/Autopilot.app`
- `dist/autopilot-<version>-macos-{arm64,x64}.zip`
- `dist/desktop-checksums.txt`

The native host targets macOS 13 or later. Each app contains a matching architecture helper.
The build generates `.icns` from the existing app artwork and signs the helper before signing
the bundle. By default builds use an ad-hoc signature. The current public beta uses this signature
and is not notarized, so a downloaded copy requires manual first-launch approval. Developer ID
signing and Apple notarization are optional build steps. Gatekeeper checks are not disabled.
`CFBundleShortVersionString` is the numeric release core, `AutopilotReleaseVersion` retains the
beta suffix, and `CFBundleVersion` defaults to a UTC `YYMM.DD.HH` build timestamp. A release can set
`AUTOPILOT_BUILD_NUMBER` to its numeric build number (up to four digits, with up to two optional
two-digit components, for example `42` or `2610.22.10`).

## Runtime and migration

Opening the app launches `autopilot desktop` with a pipe held open by the native host. The helper
reports readiness only after its HTTP handlers are installed. It claims the configured loopback
port before opening SQLite, so starting alongside an existing daemon cannot recover or overwrite
the other process's in-flight ticket state. The app displays the conflict and instructions for
stopping the old service; it never stops a service automatically.

Closing the window keeps the worker alive. Dock reopen and the menu bar bring the window back.
Quit closes stdin and terminates only the child owned by that app, with a bounded forced exit
if needed. Losing the host pipe also stops the helper after a host crash. Unexpected worker exits
restart up to three times, then show a retryable error with logs. Settings → Restart asks the host
to restart the worker. Open at Login uses `SMAppService.mainApp` and changes only on user action.

The native host accepts readiness and notification events over the child pipe. It exposes no
JavaScript command bridge. Main-window navigation stays on the configured loopback origin;
clicked external web, mail and supported editor/workspace links open through macOS. Notification
clicks open the relevant local ticket; the Dock badge reads the daemon's pending count even when
the window is closed. WebKit uses an ephemeral data store; settings and tracker tokens live in
the existing backend and Keychain, not browser storage.

The cask links `autopilot` to the bundled helper. Its `open` command opens the app. `start` and
`service` refuse to create a competing bundled daemon; use the app menu to manage startup.
The existing headless CLI and formula remain supported.

Before switching from the formula:

```sh
brew services stop autopilot
brew uninstall --formula autopilot
```

For the standalone LaunchAgent, use its existing binary's `autopilot service uninstall`.
Older installations named `linear-autopilot` should stop that service too. Manual foreground
daemons must be stopped in their own terminals. Keep the Application Support data folder.
Config, SQLite and Keychain accounts are identical to the compiled headless install, including
legacy-name migrations. Desktop logs live at `~/Library/Logs/Autopilot/autopilot.log`;
with `AUTOPILOT_HOME` they live under that override's `logs/` directory.

## Distribution and cask

After merging to main and setting the package/changelog version, build an ad-hoc beta with:

```sh
bun run build:release
bun run cask
```

Clearly label the release **ad-hoc signed and not notarized**. After attempting to open a downloaded
app, users can approve it in **System Settings → Privacy & Security → Open Anyway**, then confirm.
See [Apple's instructions](https://support.apple.com/en-us/102445); managed Macs may restrict this.

For Developer ID signing and notarization, use an installed Developer ID Application identity and
a configured notarytool Keychain profile instead:

```sh
AUTOPILOT_SIGN_IDENTITY='Developer ID Application: Your Name (TEAMID)' \
AUTOPILOT_NOTARY_PROFILE='autopilot-notary' \
bun run build:release
bun run cask
```

The build signs with the hardened runtime, submits each ZIP to notarytool, staples the accepted
ticket to the app, then recreates the ZIP and computes its final checksum. Credentials stay in
the Keychain; no certificates or secrets belong in this repository. Bun's JIT entitlements are
limited to the helper; Apple Events permission supports the existing terminal/editor integration.

Publish both desktop ZIPs and `desktop-checksums.txt` alongside the CLI tarballs and
`checksums.txt` in the version's GitHub Release. Copy generated `packaging/Casks/autopilot.rb`
into `Casks/autopilot.rb` in `mrinalraj/homebrew-tap`, keeping the formula under `Formula/`.
Do not describe an ad-hoc build as Developer ID signed or notarized. A private GitHub release cannot be downloaded
by ordinary Homebrew users; the release assets must be accessible to the intended users.

```sh
brew install --cask mrinalraj/tap/autopilot
open -a Autopilot
```

For local Homebrew testing, `scripts/brew-install-local.sh` builds both architectures and installs
a generated cask pointing at local `file://` ZIPs. It refuses to replace an installed formula
without the explicit migration above. This script installs software; the build scripts do not.

To upgrade a cask install, quit the app, run `brew upgrade --cask autopilot`, then reopen it.
The update banner provides those instructions. The standalone updater refuses to overwrite
anything inside the app bundle because doing so would break its signature. A manual installation
upgrades by replacing the whole app. Normal cask uninstall preserves user data; `--zap` explicitly
removes the data, logs and app preferences. Keychain credentials are not removed by the cask.

## Verification

Run `bun test` and `bun run typecheck`, build both architectures, validate the bundles with
`codesign --verify --deep --strict`, and check each helper's `version` and `paths` in a disposable
`AUTOPILOT_HOME`. Tests cover port conflicts before state mutation, helper shutdown on host EOF,
and refusing a standalone update inside the signed bundle. Existing HTTP tests exercise CSRF,
onboarding, settings and ticket actions through the same server used by WKWebView.

`bun run test:app` runs an automated native launch test in a macOS desktop session. It copies the
built app into a temporary folder and replaces its helper with a compiled fixture using the real
HTTP/UI code and fake services. It verifies that WebKit loads the dashboard and runs its live
script, that the host restarts a crashed worker, and that the worker exits when the host dies.
It never reads tracker credentials or starts real sessions. Successful test artifacts are removed;
failures retain their logs. This does not replace interactive release QA or testing on Intel hardware.

Before promoting the beta to a stable release, test downloaded builds on Apple Silicon and Intel: first launch,
OAuth, folder selection, terminal/editor launches, notifications, Dock reopen, Open at Login,
worker crash/restart, Quit, formula migration, cask upgrade and uninstall. Use fake trackers and
an isolated home for automated checks; do not let smoke tests poll real tickets.

References: [Homebrew Cask Cookbook](https://docs.brew.sh/Cask-Cookbook),
[Bun executable signing](https://bun.com/docs/bundler/executables),
[Apple hardened runtime](https://developer.apple.com/documentation/xcode/configuring-the-hardened-runtime).
