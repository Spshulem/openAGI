#!/usr/bin/env bash
# Downloads the embedded Node runtime for phone-only mode into Vendor/
# (gitignored) and installs the daemon's one npm dependency. Without it the
# app still builds and runs, but only as a client paired to a Mac.
#
# Pinned by version and SHA-256. Today this is the alzhuravlev/nodejs-mobile
# prebuilt (Node 22.18, no ICU); the phone-only spec replaces it with our own
# ICU build.
set -euo pipefail

VERSION="v22.18.0-ios-1"
URL="https://github.com/alzhuravlev/nodejs-mobile/releases/download/${VERSION}/nodejs-mobile-ios-v22.18.0-1.zip"
SHA256="d6ad1538e3582594b00489932b6d220dff58177347ed3634de7aae08dfe03f9b"

here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
vendor="$here/Vendor"
stamp="$vendor/NodeMobile.version"

if [[ -f "$stamp" && "$(cat "$stamp")" == "$VERSION" && -d "$vendor/NodeMobile.xcframework" ]]; then
  echo "NodeMobile $VERSION already in Vendor/"
else
  mkdir -p "$vendor"
  zip="$(mktemp -t nodemobile).zip"
  trap 'rm -f "$zip"' EXIT
  curl -fL --retry 3 -o "$zip" "$URL"
  echo "$SHA256  $zip" | shasum -a 256 -c -
  rm -rf "$vendor/NodeMobile.xcframework" "$vendor/include"
  unzip -q "$zip" 'NodeMobile.xcframework/*' -d "$vendor"
  echo "$VERSION" > "$stamp"
  echo "NodeMobile $VERSION installed in Vendor/"
fi

# The daemon's only runtime dependency (ws), bundled next to src/.
if [[ ! -d "$repo/node_modules/ws" ]]; then
  (cd "$repo" && npm ci --omit=dev --ignore-scripts)
fi
