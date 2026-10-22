#!/bin/bash
# Build native macOS apps with an embedded Bun helper. No install or release is performed.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(bun -e 'console.log(require("./package.json").version)')
CORE_VERSION=${VERSION%%-*}
BUILD_NUMBER=${AUTOPILOT_BUILD_NUMBER:-$(date -u +%y%m.%d.%H)}
if ! [[ "$BUILD_NUMBER" =~ ^[1-9][0-9]{0,3}(\.[0-9]{1,2}){0,2}$ ]]; then
  echo "AUTOPILOT_BUILD_NUMBER must be a macOS build version, e.g. 1 or 2610.22.10." >&2
  exit 1
fi
IDENTITY=${AUTOPILOT_SIGN_IDENTITY:--}
ARCHS=(arm64 x64)
if [ "${1:-}" = "--arch" ]; then
  case "${2:-}" in arm64|x64) ARCHS=("$2");; *) echo "usage: build-app.sh [--arch arm64|x64]" >&2; exit 1;; esac
elif [ "$#" -gt 0 ]; then
  echo "usage: build-app.sh [--arch arm64|x64]" >&2; exit 1
fi
if [ -n "${AUTOPILOT_NOTARY_PROFILE:-}" ] && [ "$IDENTITY" = "-" ]; then
  echo "Notarization requires AUTOPILOT_SIGN_IDENTITY (Developer ID Application)." >&2
  exit 1
fi

mkdir -p dist .dev/swift-module-cache
WORK=$(mktemp -d "$PWD/dist/app-build.XXXXXX")
ICONSET="$WORK/Autopilot.iconset"
mkdir -p "$ICONSET"
trap 'rm -rf "$WORK"' EXIT
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" public/icons/icon-512.png --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  doubled=$((size * 2))
  sips -z "$doubled" "$doubled" public/icons/icon-512.png --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o dist/Autopilot.icns

for arch in "${ARCHS[@]}"; do
  native_arch=$arch
  [ "$arch" != "x64" ] || native_arch=x86_64
  APP="$PWD/dist/desktop-${arch}/Autopilot.app"
  ARCHIVE="$PWD/dist/autopilot-${VERSION}-macos-${arch}.zip"
  rm -rf "$APP"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Helpers" "$APP/Contents/Resources"
  xcrun swiftc -swift-version 5 -O -target "${native_arch}-apple-macos13.0" \
    -module-cache-path "$PWD/.dev/swift-module-cache" \
    desktop/macos/main.swift -o "$APP/Contents/MacOS/Autopilot"
  bun build src/cli.ts --compile --minify --target="bun-darwin-${arch}" --outfile "$APP/Contents/Helpers/autopilot"
  cp desktop/macos/Info.plist "$APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $CORE_VERSION" "$APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" "$APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Add :AutopilotReleaseVersion string $VERSION" "$APP/Contents/Info.plist"
  cp dist/Autopilot.icns "$APP/Contents/Resources/Autopilot.icns"
  cp LICENSE "$APP/Contents/Resources/LICENSE"
  SIGN_FLAGS=(--force --options runtime --sign "$IDENTITY")
  [ "$IDENTITY" = "-" ] || SIGN_FLAGS+=(--timestamp)
  codesign "${SIGN_FLAGS[@]}" --entitlements desktop/macos/helper-entitlements.plist "$APP/Contents/Helpers/autopilot"
  codesign "${SIGN_FLAGS[@]}" --entitlements desktop/macos/entitlements.plist "$APP"
  codesign --verify --deep --strict "$APP"
  rm -f "$ARCHIVE"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$ARCHIVE"
  if [ -n "${AUTOPILOT_NOTARY_PROFILE:-}" ]; then
    xcrun notarytool submit "$ARCHIVE" --keychain-profile "$AUTOPILOT_NOTARY_PROFILE" --wait
    xcrun stapler staple "$APP"
    xcrun stapler validate "$APP"
    rm -f "$ARCHIVE"
    ditto -c -k --sequesterRsrc --keepParent "$APP" "$ARCHIVE"
  fi
done
(cd dist && shasum -a 256 "autopilot-${VERSION}-macos-"*.zip > desktop-checksums.txt)
cat dist/desktop-checksums.txt
if [ "$IDENTITY" = "-" ]; then
  echo "Ad-hoc signed; not notarized. Downloaded builds require manual first-launch approval in macOS Privacy & Security."
fi
