#!/usr/bin/env bash
# Xcode build phase: copies the embedded Node runtime and the daemon's
# JavaScript into the app. Both are optional: when Vendor/ has no runtime
# (scripts/fetch-node-runtime.sh was never run, e.g. in CI) nothing is copied
# and the app offers only "Connect to a server".
#
# The runtime is copied and signed here rather than linked: the app loads it
# with dlopen at launch, so a build without it still links.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
xcframework="$here/Vendor/NodeMobile.xcframework"
frameworks="$TARGET_BUILD_DIR/$FRAMEWORKS_FOLDER_PATH"
daemon="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/openagi-daemon"

rm -rf "$frameworks/NodeMobile.framework" "$daemon"
if [[ ! -d "$xcframework" ]]; then
  echo "note: no embedded Node runtime (run mobile/ios/scripts/fetch-node-runtime.sh for phone-only mode)"
  exit 0
fi

case "$PLATFORM_NAME" in
  iphoneos) slice="ios-arm64" ;;
  iphonesimulator) slice="ios-arm64_x86_64-simulator" ;;
  *) echo "error: unsupported platform $PLATFORM_NAME"; exit 1 ;;
esac
mkdir -p "$frameworks"
rsync -a --delete "$xcframework/$slice/NodeMobile.framework" "$frameworks/"
if [[ "${CODE_SIGNING_ALLOWED:-NO}" == "YES" ]]; then
  codesign --force --sign "${EXPANDED_CODE_SIGN_IDENTITY:--}" --timestamp=none --preserve-metadata=identifier,entitlements "$frameworks/NodeMobile.framework"
fi

# The daemon: src/, the mobile entry, package.json (ESM "type" and version),
# built-in skills, and ws. Tests, docs, and the desktop bins stay out.
mkdir -p "$daemon/bin" "$daemon/node_modules" "$daemon/examples"
rsync -a --delete --exclude '.DS_Store' "$repo/src/" "$daemon/src/"
rsync -a --delete --exclude '.DS_Store' "$repo/examples/skills" "$daemon/examples/"
cp "$repo/bin/mobile-entry.mjs" "$daemon/bin/"
cp "$repo/package.json" "$daemon/"
if [[ ! -d "$repo/node_modules/ws" ]]; then
  echo "error: node_modules/ws missing; run mobile/ios/scripts/fetch-node-runtime.sh"
  exit 1
fi
rsync -a --delete "$repo/node_modules/ws" "$daemon/node_modules/"
git -C "$repo" rev-parse HEAD > "$daemon/COMMIT" 2>/dev/null || echo unknown > "$daemon/COMMIT"
