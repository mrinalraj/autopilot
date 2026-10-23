#!/bin/bash
# Writes the Homebrew formula for the tarballs in dist/.
#   scripts/brew-formula.sh                      → release URLs on GitHub (for a tap repo)
#   scripts/brew-formula.sh --local <out.rb>     → file:// URLs to dist/ (local install)
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(bun -e 'console.log(require("./package.json").version)')
REPO=$(bun -e 'console.log(require("./package.json").repository)')
sha() { grep " $1\$" dist/checksums.txt | cut -d' ' -f1; }
ARM="autopilot-${VERSION}-darwin-arm64.tar.gz"
X64="autopilot-${VERSION}-darwin-x64.tar.gz"
[ -f "dist/$ARM" ] || { echo "dist/$ARM missing: run bun run build first" >&2; exit 1; }

if [ "${1:-}" = "--local" ]; then
  BASE="file://$PWD/dist"
  OUT="${2:?usage: brew-formula.sh --local <out.rb>}"
else
  BASE="https://github.com/${REPO}/releases/download/v${VERSION}"
  OUT="packaging/autopilot.rb"
fi

mkdir -p "$(dirname "$OUT")"
cat > "$OUT" <<RUBY
class Autopilot < Formula
  desc "Triage Linear tickets and launch Claude Code sessions in worktrees"
  homepage "https://github.com/${REPO}"
  version "${VERSION}"

  on_arm do
    url "${BASE}/${ARM}"
    sha256 "$(sha "$ARM")"
  end
  on_intel do
    url "${BASE}/${X64}"
    sha256 "$(sha "$X64")"
  end

  depends_on :macos
  depends_on "terminal-notifier"
  depends_on "gh"

  def install
    bin.install "autopilot"
  end

  service do
    run [opt_bin/"autopilot", "start"]
    keep_alive true
    process_type :background
    log_path var/"log/autopilot.log"
    error_log_path var/"log/autopilot.log"
  end

  def caveats
    <<~EOS
      Needs Claude Code (the \`claude\` CLI, logged in) and, for the default launcher, Supacode.
      Other launchers (Worktrunk, git, VS Code, Cursor) can be picked in Settings.

      First run:
        autopilot login              # once, in the browser
        brew services start autopilot
        open http://localhost:4747
    EOS
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/autopilot version").strip
  end
end
RUBY
echo "wrote $OUT"
