#!/bin/sh
set -eu
prefix=${HOME:?HOME must be set}/.local
if [ "$#" -eq 2 ] && [ "$1" = "--prefix" ]; then
  prefix=$2
elif [ "$#" -ne 0 ]; then
  echo 'Usage: ./install.sh [--prefix /absolute/install/path]' >&2
  exit 2
fi
case "$prefix" in /*) ;; *) echo 'Installation prefix must be absolute' >&2; exit 2;; esac
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$source_dir"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c SHA256SUMS
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 -c SHA256SUMS
else
  echo 'Install sha256sum or shasum to verify this package.' >&2
  exit 1
fi
# Refuse the wrong architecture before changing the installed executable.
./bin/autopilot-cloud version
mkdir -p "$prefix/bin"
next=$(mktemp "$prefix/bin/.autopilot-cloud.XXXXXX")
trap 'rm -f "$next"' EXIT HUP INT TERM
cp ./bin/autopilot-cloud "$next"
chmod 755 "$next"
mv -f "$next" "$prefix/bin/autopilot-cloud"
printf 'Installed %s/bin/autopilot-cloud\nStart with: "%s/bin/autopilot-cloud" start\n' "$prefix" "$prefix"
