#!/bin/bash
# Generate a cask using release URLs, or --local <out.rb> for a local development tap.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(bun -e 'console.log(require("./package.json").version)')
REPO=$(bun -e 'console.log(require("./package.json").repository)')
ARM="autopilot-${VERSION}-macos-arm64.zip"
X64="autopilot-${VERSION}-macos-x64.zip"
for asset in "$ARM" "$X64"; do
  [ -f "dist/$asset" ] || { echo "dist/$asset missing: run bun run build:app first" >&2; exit 1; }
done
if [ "${1:-}" = "--local" ]; then
  BASE=$(bun -e 'console.log(require("node:url").pathToFileURL(process.cwd() + "/dist").href)')
  OUT="${2:?usage: brew-cask.sh --local <out.rb>}"
elif [ "$#" -eq 0 ]; then
  BASE="https://github.com/${REPO}/releases/download/v#{version}"
  OUT="packaging/Casks/autopilot.rb"
else
  echo "usage: brew-cask.sh [--local <out.rb>]" >&2; exit 1
fi
mkdir -p "$(dirname "$OUT")"
ARM_SHA=$(shasum -a 256 "dist/$ARM" | cut -d' ' -f1)
X64_SHA=$(shasum -a 256 "dist/$X64" | cut -d' ' -f1)
cat > "$OUT" <<RUBY
cask "autopilot" do
  arch arm: "arm64", intel: "x64"

  version "${VERSION}"
  sha256 arm:   "${ARM_SHA}",
         intel: "${X64_SHA}"

  url "${BASE}/autopilot-#{version}-macos-#{arch}.zip"
  name "Autopilot"
  desc "Triage tracker tickets and launch Claude Code sessions"
  homepage "https://github.com/${REPO}"

  depends_on formula: "gh"
  depends_on macos: :ventura

  app "Autopilot.app"
  binary "#{appdir}/Autopilot.app/Contents/Helpers/autopilot"

  uninstall quit: "dev.autopilot.app"

  zap trash: [
    "~/Library/Application Support/autopilot",
    "~/Library/Logs/Autopilot",
    "~/Library/Preferences/dev.autopilot.app.plist",
    "~/Library/Saved Application State/dev.autopilot.app.savedState",
  ]

  caveats <<~EOS
    Open Autopilot from Applications to finish setup. It manages its own worker.
    Enable Autopilot > Open at Login to start it when you sign in.
    Claude Code must be installed and logged in.

    macOS may block the first launch of an unnotarized beta. After trying to open it,
    use System Settings > Privacy & Security > Open Anyway and confirm.
    Signing status and instructions: https://github.com/${REPO}/releases/tag/v${VERSION}

    Migrating from the formula: stop its service and uninstall the formula first:
      brew services stop autopilot
      brew uninstall --formula autopilot
    Your settings, tickets and Keychain sign-in are preserved.
  EOS
end
RUBY
echo "wrote $OUT"
