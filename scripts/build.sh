#!/bin/bash
# Builds standalone macOS binaries (arm64 + x64) into dist/, with tarballs and SHA-256 checksums
# in the layout the updater and the Homebrew formula expect.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(bun -e 'console.log(require("./package.json").version)')
rm -rf dist && mkdir -p dist

for arch in arm64 x64; do
  name="autopilot-${VERSION}-darwin-${arch}"
  bun build src/cli.ts --compile --minify --target="bun-darwin-${arch}" --outfile "dist/${name}/autopilot"
  tar -C "dist/${name}" -czf "dist/${name}.tar.gz" autopilot
done

(cd dist && shasum -a 256 ./*.tar.gz | sed 's| \./| |' > checksums.txt)
cat dist/checksums.txt
