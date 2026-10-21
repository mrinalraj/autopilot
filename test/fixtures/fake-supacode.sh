#!/bin/bash
# Stand-in for the Supacode CLI: logs argv, prints IDs like the real one.
printf '%s\n' "$*" >> "$FAKE_SC_LOG"
[ -n "$FAKE_SC_FAIL" ] && [ "$1 $2" = "repo worktree-new" ] && { echo "boom: hook failed" >&2; exit 1; }
root="${FAKE_SC_WT_ROOT:-/tmp/wt}"
decode() { printf '%b' "${1//%/\\x}"; }
case "$1 $2" in
  "repo list") printf '%s\n' "${FAKE_SC_REPOS}" ;;
  "repo open") ;;
  "repo worktree-new")
    # Worktree ID: <root>/<repo basename>/<branch>/, percent-encoded
    while [ $# -gt 0 ]; do
      [ "$1" = "--branch" ] && b="$2"
      [ "$1" = "-r" ] && r="$2"
      shift
    done
    path="$root/$(basename "$(decode "$r")")/$b/"
    printf '%s\n' "${path//\//%2F}" ;;
  "worktree delete")
    # Only ever removes directories under the test's worktree root.
    while [ $# -gt 0 ]; do [ "$1" = "-w" ] && w="$2"; shift; done
    p=$(decode "$w")
    [ -n "$FAKE_SC_WT_ROOT" ] && [[ "$p" == "$FAKE_SC_WT_ROOT"/* ]] && rm -rf "$p" ;;
  "tab new") echo "11111111-2222-3333-4444-555555555555" ;;
esac
