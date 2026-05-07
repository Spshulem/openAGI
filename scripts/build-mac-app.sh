#!/usr/bin/env bash
# Build OpenAGI.app — a self-contained macOS menubar app that bundles:
#   - the Swift menubar binary
#   - a Node 22 runtime (downloaded if missing)
#   - the OpenAGI JS source
#
# Usage:
#   ./scripts/build-mac-app.sh                      # release build, no signing
#   SIGN_IDENTITY="Developer ID Application: ..." ./scripts/build-mac-app.sh
#   SIGN_IDENTITY="..." NOTARIZE=1 ./scripts/build-mac-app.sh
#
# Output:
#   build/OpenAGI.app
#   build/OpenAGI-<version>.dmg (when DMG=1)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAC_DIR="${ROOT}/mac"
BUILD_DIR="${ROOT}/build"
APP="${BUILD_DIR}/OpenAGI.app"
VERSION="${VERSION:-$(node -p "require('${ROOT}/package.json').version")}"
BUILD_NUM="${BUILD_NUM:-$(date +%s)}"
NODE_VERSION="${NODE_VERSION:-22.21.1}"

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) NODE_ARCH=arm64 ;;
  x86_64) NODE_ARCH=x64 ;;
  *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;;
esac
NODE_DIST="node-v${NODE_VERSION}-darwin-${NODE_ARCH}"
NODE_TGZ="${BUILD_DIR}/cache/${NODE_DIST}.tar.gz"

echo "▶ OpenAGI.app build · version ${VERSION} · ${NODE_ARCH}"

mkdir -p "${BUILD_DIR}/cache"

# 1. Compile the Swift menubar binary
echo "▶ Compiling Swift binary"
(cd "${MAC_DIR}" && swift build -c release --product OpenAGI)
BIN="$(cd "${MAC_DIR}" && swift build -c release --product OpenAGI --show-bin-path)/OpenAGI"
[[ -x "${BIN}" ]] || { echo "Build failed: ${BIN} not found" >&2; exit 1; }

# 2. Fetch Node 22 runtime if not cached
if [[ ! -f "${NODE_TGZ}" ]]; then
  echo "▶ Downloading Node ${NODE_VERSION} (${NODE_ARCH})"
  curl -fL -o "${NODE_TGZ}" "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIST}.tar.gz"
fi

# 3. Assemble the app bundle
echo "▶ Assembling ${APP}"
rm -rf "${APP}"
mkdir -p "${APP}/Contents/MacOS" "${APP}/Contents/Resources"

cp "${BIN}" "${APP}/Contents/MacOS/OpenAGI"
chmod +x "${APP}/Contents/MacOS/OpenAGI"

# Add @executable_path/../Frameworks to rpath so dyld finds Sparkle.framework
# inside the bundle. Idempotent: ignore the "already present" error on re-runs.
install_name_tool -add_rpath "@executable_path/../Frameworks" \
  "${APP}/Contents/MacOS/OpenAGI" 2>/dev/null || true

# Info.plist with placeholders substituted
sed -e "s/__VERSION__/${VERSION}/g" -e "s/__BUILD__/${BUILD_NUM}/g" \
  "${MAC_DIR}/Resources/Info.plist" > "${APP}/Contents/Info.plist"

# Bundle Node
NODE_DEST="${APP}/Contents/Resources/node"
mkdir -p "${NODE_DEST}"
tar -xzf "${NODE_TGZ}" -C "${NODE_DEST}" --strip-components=1
# Keep only what we need
rm -rf "${NODE_DEST}/include" "${NODE_DEST}/share/doc" "${NODE_DEST}/share/man" "${NODE_DEST}/share/systemtap" 2>/dev/null || true

# Bundle the JS runtime
JS_DEST="${APP}/Contents/Resources/openAGI"
mkdir -p "${JS_DEST}"
rsync -a --exclude '.openagi' --exclude '.git' --exclude 'node_modules' --exclude 'mac' --exclude 'build' \
  --exclude 'docs/verification' --exclude 'logs' --exclude 'test' \
  "${ROOT}/src" "${ROOT}/examples" "${ROOT}/package.json" "${JS_DEST}/"

# Sparkle framework — copy from SPM build artifacts
SPARKLE_FW=$(find "${MAC_DIR}/.build" -name "Sparkle.framework" -type d 2>/dev/null | head -1 || true)
if [[ -n "${SPARKLE_FW}" && -d "${SPARKLE_FW}" ]]; then
  echo "▶ Embedding Sparkle.framework"
  mkdir -p "${APP}/Contents/Frameworks"
  cp -R "${SPARKLE_FW}" "${APP}/Contents/Frameworks/"
fi

# 4. Code-sign. Order of preference:
#    1. SIGN_IDENTITY env (explicit override — for distribution builds)
#    2. Any installed "Developer ID Application: …" cert (best for local TCC)
#    3. "OpenAGI Local Signing" self-signed cert
#    4. ad-hoc (TCC will re-prompt on every rebuild — shipped with a warning)
SIGN_USED=""
if [[ -n "${SIGN_IDENTITY:-}" ]]; then
  SIGN_USED="${SIGN_IDENTITY}"
else
  DEV_ID="$(security find-identity -v -p codesigning 2>/dev/null | grep -oE '"Developer ID Application: [^"]+"' | head -1 | tr -d '"')"
  if [[ -n "${DEV_ID}" ]]; then
    SIGN_USED="${DEV_ID}"
    echo "▶ Auto-detected Developer ID: ${SIGN_USED}"
  elif security find-identity -v -p codesigning 2>/dev/null | grep -q "OpenAGI Local Signing"; then
    SIGN_USED="OpenAGI Local Signing"
    echo "▶ Auto-detected local signing cert: ${SIGN_USED}"
  fi
fi

if [[ -n "${SIGN_USED}" ]]; then
  SIGN_IDENTITY="${SIGN_USED}"
  echo "▶ Signing with: ${SIGN_IDENTITY}"

  # Sign the bundled Node binary FIRST with its own entitlements that allow
  # JIT — V8 requires writeable+executable memory pages and macOS hardened
  # runtime kills it with SIGTRAP otherwise.
  NODE_BINARY="${APP}/Contents/Resources/node/bin/node"
  if [[ -f "${NODE_BINARY}" ]]; then
    codesign --force --options runtime \
      --entitlements "${MAC_DIR}/Resources/node-entitlements.plist" \
      --sign "${SIGN_IDENTITY}" "${NODE_BINARY}"
  fi
  # Sign other nested executables (npm/npx are scripts; just sign anything binary).
  find "${APP}/Contents/Resources/node" -type f -perm +111 ! -path "*/node" -exec \
    codesign --force --options runtime --sign "${SIGN_IDENTITY}" {} \; 2>/dev/null || true
  if [[ -d "${APP}/Contents/Frameworks/Sparkle.framework" ]]; then
    codesign --force --options runtime --sign "${SIGN_IDENTITY}" \
      "${APP}/Contents/Frameworks/Sparkle.framework"
  fi
  # Sign the .app bundle WITHOUT --deep so we don't clobber the special
  # entitlements we just put on Node. Sign frameworks and main executable
  # explicitly above.
  codesign --force --options runtime --sign "${SIGN_IDENTITY}" \
    --entitlements "${MAC_DIR}/Resources/entitlements.plist" \
    "${APP}/Contents/MacOS/OpenAGI"
  codesign --force --options runtime --sign "${SIGN_IDENTITY}" \
    --entitlements "${MAC_DIR}/Resources/entitlements.plist" "${APP}"
  codesign --verify --strict --verbose=2 "${APP}" 2>&1 | tail -3
else
  echo "⚠ Building unsigned. macOS will re-prompt for Screen Recording / Accessibility"
  echo "   permissions on every rebuild. Run ./scripts/setup-mac-signing.sh once to fix."
  # Apply ad-hoc signature so the app at least launches under hardened runtime.
  codesign --force --deep --sign - "${APP}" 2>/dev/null || true
fi

# 5. Optional: DMG
if [[ "${DMG:-0}" == "1" ]]; then
  if ! command -v create-dmg >/dev/null 2>&1; then
    echo "create-dmg not installed (brew install create-dmg). Skipping DMG."
  else
    DMG_PATH="${BUILD_DIR}/OpenAGI-${VERSION}.dmg"
    rm -f "${DMG_PATH}"
    create-dmg \
      --volname "OpenAGI ${VERSION}" \
      --window-size 540 360 \
      --app-drop-link 410 200 \
      --icon "OpenAGI.app" 130 200 \
      --hide-extension "OpenAGI.app" \
      "${DMG_PATH}" "${APP}" || true
    echo "▶ DMG: ${DMG_PATH}"
  fi
fi

# 6. Optional: notarize
if [[ "${NOTARIZE:-0}" == "1" ]]; then
  if [[ -z "${AC_USERNAME:-}" || -z "${AC_TEAM_ID:-}" ]]; then
    echo "Set AC_USERNAME, AC_PASSWORD, AC_TEAM_ID env vars to notarize." >&2
    exit 1
  fi
  TARGET="${DMG_PATH:-${APP}}"
  echo "▶ Submitting ${TARGET} for notarization"
  xcrun notarytool submit "${TARGET}" \
    --apple-id "${AC_USERNAME}" \
    --password "${AC_PASSWORD}" \
    --team-id "${AC_TEAM_ID}" \
    --wait
  if [[ -d "${TARGET}" ]]; then xcrun stapler staple "${TARGET}"; fi
fi

echo "▶ Done. ${APP}"
