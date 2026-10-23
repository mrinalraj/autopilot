#!/bin/bash
# Build and install the desktop cask from a local tap; --formula keeps the headless install.
set -euo pipefail
cd "$(dirname "$0")/.."
TAP="${AUTOPILOT_TAP:-mrinalraj/local}"
KIND=cask
case "${1:-}" in
  --formula) KIND=formula;;
  --cask|"") ;;
  *) echo "usage: brew-install-local.sh [--cask|--formula]" >&2; exit 1;;
esac
if [ "$KIND" = cask ]; then
  bun run build:app
else
  bun run build
fi
brew tap "$TAP" >/dev/null 2>&1 || brew tap-new --no-git "$TAP" >/dev/null
TAP_DIR="$(brew --repository "$TAP")"
if [ "$KIND" = cask ]; then
  scripts/brew-cask.sh --local "$TAP_DIR/Casks/autopilot.rb"
else
  mkdir -p "$TAP_DIR/Formula"
  scripts/brew-formula.sh --local "$TAP_DIR/Formula/autopilot.rb"
fi
if brew list "--$KIND" autopilot >/dev/null 2>&1; then
  brew reinstall "--$KIND" "$TAP/autopilot"
else
  brew install "--$KIND" "$TAP/autopilot"
fi
if [ "$KIND" = formula ]; then autopilot version; fi
