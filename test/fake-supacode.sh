#!/bin/bash
# Stand-in for the Supacode CLI: logs argv, prints IDs like the real one.
printf '%s\n' "$*" >> "$FAKE_SC_LOG"
[ -n "$FAKE_SC_FAIL" ] && [ "$1 $2" = "repo worktree-new" ] && { echo "boom: hook failed" >&2; exit 1; }
case "$1 $2" in
  "repo list") printf '%s\n' "${FAKE_SC_REPOS}" ;;
  "repo open") ;;
  "repo worktree-new")
    # Worktree ID: %2Ftmp%2Fwt%2F<repo basename>%2F<branch>%2F
    while [ $# -gt 0 ]; do
      [ "$1" = "--branch" ] && b="$2"
      [ "$1" = "-r" ] && r="$2"
      shift
    done
    repo=$(basename "$(printf '%b' "${r//%/\\x}")")
    printf '%%2Ftmp%%2Fwt%%2F%s%%2F%s%%2F\n' "$repo" "$b" ;;
  "tab new") echo "11111111-2222-3333-4444-555555555555" ;;
esac
