#!/usr/bin/env bash
# Generate AppIcon.icns from the source PNG in mac/Resources/icon-sources/.
# Idempotent — safe to re-run.
#
# Input (committed):
#   mac/Resources/icon-sources/AppIcon-source.png   (square, 1024+ px, opaque ok)
#
# Output:
#   mac/Resources/AppIcon.icns          (referenced by Info.plist)
#
# The menu bar icon is not built here: it is vector paths drawn in code
# (mac/Sources/OpenAGI/MenuBarIcon.swift), traced from
# icon-sources/MenuIcon-source.png by scripts/trace-menu-icon.py.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${ROOT}/mac/Resources/icon-sources"
OUT_DIR="${ROOT}/mac/Resources"

APP_SRC="${SRC_DIR}/AppIcon-source.png"

[[ -f "${APP_SRC}" ]] || { echo "Missing ${APP_SRC}" >&2; exit 1; }

# === AppIcon.icns =========================================================
# macOS expects an .iconset directory with these specific filenames + sizes.
ICONSET="${OUT_DIR}/AppIcon.iconset"
rm -rf "${ICONSET}"
mkdir -p "${ICONSET}"

declare -a SIZES=(
  "16:icon_16x16.png"
  "32:icon_16x16@2x.png"
  "32:icon_32x32.png"
  "64:icon_32x32@2x.png"
  "128:icon_128x128.png"
  "256:icon_128x128@2x.png"
  "256:icon_256x256.png"
  "512:icon_256x256@2x.png"
  "512:icon_512x512.png"
  "1024:icon_512x512@2x.png"
)

echo "▶ Building AppIcon.iconset"
for spec in "${SIZES[@]}"; do
  size="${spec%%:*}"
  name="${spec##*:}"
  sips --setProperty format png \
       --resampleHeightWidth "${size}" "${size}" \
       "${APP_SRC}" \
       --out "${ICONSET}/${name}" >/dev/null
done

echo "▶ Compiling AppIcon.icns"
iconutil --convert icns --output "${OUT_DIR}/AppIcon.icns" "${ICONSET}"
rm -rf "${ICONSET}"

echo "▶ Done."
ls -lh "${OUT_DIR}/AppIcon.icns"
