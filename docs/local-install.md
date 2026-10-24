# Local browser and PWA installation

Supported backend targets: macOS arm64/amd64 and Linux arm64/amd64. Windows is not
supported (the backend uses Unix process controls and tmux). The Linux executable
is built without CGO; Git, tmux and `/bin/sh` must still be installed. The browser
can run on a different platform via a private HTTPS connection or SSH tunnel.

## Build and package

From the repository root, with Go **1.26.2**, Bun **1.3.14**, Python 3 and make:

```sh
make build
./cloud/bin/autopilot-cloud version
./cloud/bin/autopilot-cloud start
```

Open **http://127.0.0.1:4780**. The executable embeds the production UI. It can run
from any directory without Bun, Go, the checkout or a frontend development server.
The runtime needs Git and tmux (`brew install git tmux` on macOS, or
`sudo apt install git tmux` on Debian/Ubuntu), plus whichever authenticated agent
CLIs you select. Node/npm is needed only by harnesses installed through npm.

For distributable archives and SHA-256 checksums:

```sh
make package                          # all four supported targets
make package TARGETS=darwin/arm64      # one target; linux/amd64 also supported
```

Archives are in `cloud/dist/`. `BUILD.txt` records the exact source revision,
target and toolchain. Dirty checkouts are labeled `-dirty` and are unsuitable for
a verification handoff. With the same clean revision and toolchain, archives have
stable tar metadata/gzip timestamps and deterministic Go builds. No release is published.
Frontend dependencies use the frozen Bun lockfile; Go uses its module sums in readonly mode.

## Install and start

Choose the archive matching your OS/CPU (`amd64` means Intel/x86-64). For example:

```sh
cd cloud/dist
shasum -a 256 -c SHA256SUMS             # Linux can use sha256sum -c SHA256SUMS
mkdir -p unpacked
tar -xzf autopilot-cloud-darwin-arm64.tar.gz -C unpacked
cd unpacked/autopilot-cloud-darwin-arm64
./install.sh                          # installs ~/.local/bin/autopilot-cloud
# Or: ./install.sh --prefix /absolute/isolated/prefix
"$HOME/.local/bin/autopilot-cloud" start
```

The installer validates the executable checksum and runs its version command
before an atomic replacement. It installs only `autopilot-cloud`, never the older
`autopilot` binary or Homebrew app/formula. Add `$HOME/.local/bin` to PATH to use the
short command. There is no login service or automatic updater. Downloaded macOS
binaries are unsigned/not notarized; source builds do not claim Developer ID signing.

`start` defaults to **host** execution, using your existing Git and agent CLI
configuration. `serve` and Docker's `supervise` default to **isolated** execution.
An explicit `executionEnvironment` in settings or `AUTOPILOT_EXECUTION_ENVIRONMENT`
overrides either default. Review harness profiles before approving work.

Persistent configuration/data is independent of the executable and working directory:

| Platform | Default directory |
| --- | --- |
| macOS | `~/Library/Application Support/Autopilot Cloud` |
| Linux | `$XDG_DATA_HOME/autopilot-cloud`, or `~/.local/share/autopilot-cloud` |
| Docker | `/data` (explicit environment setting) |

This directory contains `settings.json` (optional), `profiles.json`, SQLite,
credentials, managed worktrees and sessions. Missing settings use defaults; there
is no need to copy a configuration file. Existing legacy Bun app data is separate
and is not migrated or deleted. Two servers cannot own the same directory.

For a separate instance or verification, use **all three** overrides:

```sh
AUTOPILOT_DATA_DIR="$PWD/.dev/local-data" \
AUTOPILOT_LISTEN=127.0.0.1:4790 \
AUTOPILOT_ALLOWED_HOSTS=127.0.0.1:4790,localhost:4790 \
  ./cloud/bin/autopilot-cloud start
```

Open http://127.0.0.1:4790 and keep that origin consistent. A startup log reports
the URL, data directory and execution mode only after the listener and app are
initialized; `/healthz` returns `{"status":"ok"}`. Port conflicts, data locks,
missing Git/tmux and invalid settings fail visibly. Correct the reported cause
before retrying; do not kill an unrelated process.

## Stop, backup, upgrade and remove

Press **Ctrl-C** in the terminal running `start` (or send SIGTERM to that exact
process). Closing a browser/PWA does not stop the service. Agent tmux sessions
survive API shutdown and are adopted on restart; stop agents in the UI first if
you want all work stopped. The app never silently treats process exit as completion.

Before an upgrade, stop agents and the server, then privately back up the **entire
data directory**, including settings, credentials, worktrees and conversations.
Keep the previous executable. Build/unpack a new package from the intended clean
revision, verify checksums and run its installer with the same prefix. Restart with
the same data/settings/address, then reload browser windows. Confirm the version
and persisted workspaces. Do not downgrade across incompatible schema migrations
without restoring the matching backup. No harness upgrade is implicit.

To remove the executable, stop it and remove only `<prefix>/bin/autopilot-cloud`.
Remove the PWA using the browser's app menu. Data is deliberately retained; delete
it separately only after backing up any work you want to keep.

## Install the PWA

With the service running, visit the exact local URL in Chrome or Edge, use the
address bar's install icon or the browser menu's **Install Autopilot Cloud** action,
then launch the installed app. It requests a standalone window with a stable app
identity, start URL and bundled regular/maskable icons. Safari on supported macOS
versions offers **File → Add to Dock**; on iOS use **Share → Add to Home Screen**.
Browser menus vary. Firefox desktop can use the ordinary browser UI.

Localhost/loopback is a secure context; a remote installation requires HTTPS
(and private authenticated access). A phone's localhost refers to the phone,
not your computer. Do not expose the unauthenticated local API to a public network.
See [browser installation requirements](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable).

The PWA is a window onto the service, not a bundled backend. When it cannot reach
the server, navigation shows a generic explanation and retry link; an already-open
window reports the lost connection and warns that displayed data may be out of date.
There is no offline task execution, private data cache or mutation queue. After an
ambiguous failed action, reconnect and inspect current state before retrying.

Only the generic offline document is stored by the service worker. API responses,
CSRF tokens, events, terminals and application pages are never stored there. HTML,
manifest, icons and worker are revalidated; fingerprinted assets are immutable.
The offline cache name follows its content hash, and activation removes only old
Autopilot offline caches. Worker updates do not forcibly reload a terminal. Reload
after a server upgrade to load the new UI; an old window may need that reload
before opening a newly loaded terminal chunk. A missing chunk shows a reload action
instead of leaving the view blank; reloading discards unsaved form edits. PWA removal does not delete server data.

## Verification

```sh
make test
make build
cd cloud && go test -tags webassets ./... && cd ..
python3 cloud/tests/local_smoke.py "$PWD/cloud/bin/autopilot-cloud"
cd cloud/web && bunx playwright install chromium && bun run test
```

Browser tests cover manifest/icons, service-worker cache boundaries, offline/recovery,
connection loss and packaged static assets. Actual OS installation and standalone
launch require browser-level acceptance; headless tests alone do not prove those.
Docker build/recovery checks and remaining platform limitations are recorded in
`docs/local-pwa-handoff.md`. For Docker operation, see `cloud/README.md`.
