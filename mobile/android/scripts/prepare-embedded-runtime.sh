#!/usr/bin/env bash
# Pinned native runtime and a public-source-only daemon bundle. No .env,
# device files, signing material or developer data enter Android assets.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
version=v22.18.0-1
sha=6f2b9d086c2243249c39d5d6ad4a9c2ddfdabbc0eabb3bb4493c95da13e13698
vendor="$here/Vendor"
if [[ ! -f "$vendor/version" || "$(cat "$vendor/version")" != "$version" ]]; then
  archive="$(mktemp)"
  trap 'rm -f "$archive"' EXIT
  curl -fsSL --retry 3 -o "$archive" "https://github.com/alzhuravlev/nodejs-mobile/releases/download/$version/nodejs-mobile-android-v22.18.0-1.zip"
  echo "$sha  $archive" | shasum -a 256 -c -
  mkdir -p "$vendor"
  unzip -qo "$archive" 'bin/*' -d "$vendor"
  echo "$version" > "$vendor/version"
fi
[[ -d "$repo/node_modules/ws" ]] || (cd "$repo" && npm ci --omit=dev --ignore-scripts)
assets="$here/app/build/generated/daemonAssets/openagi-daemon"
mkdir -p "$assets/bin" "$assets/node_modules" "$assets/examples"
rsync -a --delete --exclude '.DS_Store' "$repo/src/" "$assets/src/"
rsync -a --delete "$repo/examples/skills" "$assets/examples/"
rsync -a --delete "$repo/node_modules/ws" "$assets/node_modules/"
cp "$repo/bin/mobile-entry.mjs" "$assets/bin/"
cp "$repo/package.json" "$assets/"
git -C "$repo" rev-parse HEAD > "$assets/COMMIT"
