#!/usr/bin/env bash
# Generate AppIcon.icns and MenuIcon@x.png from the source PNGs in
# mac/Resources/icon-sources/. Idempotent — safe to re-run.
#
# Inputs (committed):
#   mac/Resources/icon-sources/AppIcon-source.png   (square, 1024+ px, opaque ok)
#   mac/Resources/icon-sources/MenuIcon-source.png  (square, alpha required, black-on-clear)
#
# Outputs:
#   mac/Resources/AppIcon.icns          (referenced by Info.plist)
#   mac/Resources/MenuIcon.png          (22x22, template)
#   mac/Resources/MenuIcon@2x.png       (44x44, template)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${ROOT}/mac/Resources/icon-sources"
OUT_DIR="${ROOT}/mac/Resources"

APP_SRC="${SRC_DIR}/AppIcon-source.png"
MENU_SRC="${SRC_DIR}/MenuIcon-source.png"

[[ -f "${APP_SRC}" ]] || { echo "Missing ${APP_SRC}" >&2; exit 1; }
[[ -f "${MENU_SRC}" ]] || { echo "Missing ${MENU_SRC}" >&2; exit 1; }

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

# === MenuIcon (template) ==================================================
# macOS template images use the alpha channel only — RGB is ignored — so we
# only need the source to have transparent background. The build is a simple
# downscale to 22pt (1x) and 44pt (2x).
echo "▶ Building MenuIcon"
# Auto-crop transparent padding so the glyph fills its bounding box, then
# downscale. Without this step macOS shows ~15% empty padding around the
# logo and it reads as smaller than every other menu bar item.
CROPPED="$(mktemp -t menuicon-cropped).png"
python3 - "${MENU_SRC}" "${CROPPED}" <<'PY'
import sys
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
img = Image.open(src).convert("RGBA")
bbox = img.getbbox()
if bbox: img = img.crop(bbox)
# Re-square so menu bar centers it correctly.
w, h = img.size
side = max(w, h)
canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
canvas.paste(img, ((side - w) // 2, (side - h) // 2))
canvas.save(dst, "PNG")
PY
# 28pt @1x / 56px @2x — pushes the glyph to the top of the menu bar slot.
sips --setProperty format png --resampleHeightWidth 28 28 \
     "${CROPPED}" --out "${OUT_DIR}/MenuIcon.png" >/dev/null
sips --setProperty format png --resampleHeightWidth 56 56 \
     "${CROPPED}" --out "${OUT_DIR}/MenuIcon@2x.png" >/dev/null
rm -f "${CROPPED}"

echo "▶ Done."
ls -lh "${OUT_DIR}/AppIcon.icns" "${OUT_DIR}/MenuIcon.png" "${OUT_DIR}/MenuIcon@2x.png"
