#!/bin/bash
# Starts the daemon. Linear auth is OAuth, stored in the Keychain by `bun run login`.
# ANTHROPIC_API_KEY (only for llm.provider "api") comes from the environment, or else from the
# Keychain (service "linear-autopilot", account "ANTHROPIC_API_KEY"); it is never written to disk.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

from_keychain() {
  security find-generic-password -s linear-autopilot -a "$1" -w 2>/dev/null || true
}

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  key="$(from_keychain ANTHROPIC_API_KEY)"
  [ -n "$key" ] && export ANTHROPIC_API_KEY="$key"
fi

exec bun run src/main.ts "$@"
