#!/bin/bash
# Builds, then installs (or upgrades) linear-autopilot through a local Homebrew tap that points at
# dist/. For use while the GitHub repo is private: Homebrew can't download private release assets.
set -euo pipefail
cd "$(dirname "$0")/.."
TAP="${AUTOPILOT_TAP:-mrinalraj/local}"
bun run build >/dev/null
brew tap "$TAP" >/dev/null 2>&1 || brew tap-new --no-git "$TAP" >/dev/null
TAP_DIR="$(brew --repository "$TAP")"
mkdir -p "$TAP_DIR/Formula"
scripts/brew-formula.sh --local "$TAP_DIR/Formula/linear-autopilot.rb"
if brew list --formula linear-autopilot >/dev/null 2>&1; then
  brew reinstall --formula "$TAP/linear-autopilot"
else
  brew install --formula "$TAP/linear-autopilot"
fi
linear-autopilot version
