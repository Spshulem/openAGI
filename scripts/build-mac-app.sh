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
# Version resolution, in priority order:
#   1. $VERSION env var (CI passes this from the git tag — never override)
#   2. Latest git tag matching v* (so local builds match the latest release
#      without anyone having to remember to bump package.json after every tag)
#   3. package.json (last-resort fallback)
if [[ -z "${VERSION:-}" ]]; then
  GIT_TAG="$(cd "${ROOT}" && git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)"
  if [[ -n "${GIT_TAG}" ]]; then
    VERSION="${GIT_TAG#v}"
  else
    VERSION="$(node -p "require('${ROOT}/package.json').version")"
  fi
fi
# Build number must use the SAME scheme as CI (release-mac.yml stamps
# `date -u +%y%m%d%H%M`). A local epoch-seconds value (~1.78e9) is numerically
# smaller than any YYMMDDHHMM value (~2.6e9 in 2026), so Sparkle would treat a
# locally-built app as forever older than every CI release of the same version
# and nag to "update" to it endlessly. Keep both schemes identical.
BUILD_NUM="${BUILD_NUM:-$(date -u +%y%m%d%H%M)}"
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

# Toolchain sanity: a bare CommandLineTools install can't provide the macOS
# platform SDK swift-build needs ("unable to lookup item 'PlatformPath'").
# When the active toolchain is broken and a full Xcode exists, use it via
# DEVELOPER_DIR instead of failing — no sudo/xcode-select required.
if [[ -z "${DEVELOPER_DIR:-}" ]] && ! xcrun --sdk macosx --show-sdk-platform-path >/dev/null 2>&1; then
  for XC in /Applications/Xcode.app /Applications/Xcode-beta.app; do
    if [[ -d "${XC}/Contents/Developer" ]]; then
      export DEVELOPER_DIR="${XC}/Contents/Developer"
      echo "▶ Active toolchain can't build for macOS — using ${XC} (DEVELOPER_DIR)"
      break
    fi
  done
  if [[ -z "${DEVELOPER_DIR:-}" ]]; then
    echo "ERROR: the active developer toolchain ($(xcode-select -p)) can't provide the macOS SDK and no Xcode.app was found." >&2
    echo "Fix with: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer (after installing Xcode)" >&2
    exit 1
  fi
fi

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

# Icons. Auto-build them if the inputs are present but the outputs are stale,
# so a fresh clone or an icon-source change picks them up automatically.
if [[ -f "${MAC_DIR}/Resources/icon-sources/AppIcon-source.png" ]]; then
  if [[ ! -f "${MAC_DIR}/Resources/AppIcon.icns" \
        || "${MAC_DIR}/Resources/icon-sources/AppIcon-source.png" -nt "${MAC_DIR}/Resources/AppIcon.icns" \
        || "${MAC_DIR}/Resources/icon-sources/MenuIcon-source.png" -nt "${MAC_DIR}/Resources/MenuIcon.png" ]]; then
    echo "▶ Rebuilding icons from sources"
    "${ROOT}/scripts/build-icons.sh"
  fi
fi
[[ -f "${MAC_DIR}/Resources/AppIcon.icns" ]]    && cp "${MAC_DIR}/Resources/AppIcon.icns"    "${APP}/Contents/Resources/AppIcon.icns"
[[ -f "${MAC_DIR}/Resources/MenuIcon.png" ]]    && cp "${MAC_DIR}/Resources/MenuIcon.png"    "${APP}/Contents/Resources/MenuIcon.png"
[[ -f "${MAC_DIR}/Resources/MenuIcon@2x.png" ]] && cp "${MAC_DIR}/Resources/MenuIcon@2x.png" "${APP}/Contents/Resources/MenuIcon@2x.png"

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

  # All codesign calls below pass --timestamp so the signature includes
  # an Apple-issued secure timestamp. Notarization rejects signatures
  # without it.
  CS_FLAGS=(--force --options runtime --timestamp --sign "${SIGN_IDENTITY}")

  # Sign Sparkle's nested helpers FIRST — Sparkle.framework ships with
  # pre-signed inner binaries (Updater.app / Autoupdate / Downloader.xpc /
  # Installer.xpc) that aren't tied to our Developer ID. Notarization
  # rejects those without re-signing. Order matters: deepest first, then
  # parent bundles, then the framework itself.
  SPARKLE_FW="${APP}/Contents/Frameworks/Sparkle.framework"
  if [[ -d "${SPARKLE_FW}" ]]; then
    SP="${SPARKLE_FW}/Versions/B"
    [[ -e "${SP}/Autoupdate" ]] && \
      codesign "${CS_FLAGS[@]}" "${SP}/Autoupdate"
    [[ -e "${SP}/Updater.app/Contents/MacOS/Updater" ]] && \
      codesign "${CS_FLAGS[@]}" "${SP}/Updater.app/Contents/MacOS/Updater"
    [[ -d "${SP}/Updater.app" ]] && \
      codesign "${CS_FLAGS[@]}" "${SP}/Updater.app"
    [[ -e "${SP}/XPCServices/Downloader.xpc/Contents/MacOS/Downloader" ]] && \
      codesign "${CS_FLAGS[@]}" "${SP}/XPCServices/Downloader.xpc/Contents/MacOS/Downloader"
    [[ -d "${SP}/XPCServices/Downloader.xpc" ]] && \
      codesign "${CS_FLAGS[@]}" "${SP}/XPCServices/Downloader.xpc"
    [[ -e "${SP}/XPCServices/Installer.xpc/Contents/MacOS/Installer" ]] && \
      codesign "${CS_FLAGS[@]}" "${SP}/XPCServices/Installer.xpc/Contents/MacOS/Installer"
    [[ -d "${SP}/XPCServices/Installer.xpc" ]] && \
      codesign "${CS_FLAGS[@]}" "${SP}/XPCServices/Installer.xpc"
    codesign "${CS_FLAGS[@]}" "${SPARKLE_FW}"
  fi

  # Sign the bundled Node binary with its own entitlements that allow
  # JIT — V8 requires writeable+executable memory pages and macOS hardened
  # runtime kills it with SIGTRAP otherwise.
  NODE_BINARY="${APP}/Contents/Resources/node/bin/node"
  if [[ -f "${NODE_BINARY}" ]]; then
    codesign --force --options runtime --timestamp \
      --entitlements "${MAC_DIR}/Resources/node-entitlements.plist" \
      --sign "${SIGN_IDENTITY}" "${NODE_BINARY}"
  fi
  # Sign other nested executables (npm/npx are scripts; just sign anything binary).
  find "${APP}/Contents/Resources/node" -type f -perm +111 ! -path "*/node" -exec \
    codesign "${CS_FLAGS[@]}" {} \; 2>/dev/null || true

  # Sign the main executable + bundle WITHOUT --deep so we don't clobber
  # the special entitlements we just put on Node. Sign explicitly above.
  codesign --force --options runtime --timestamp --sign "${SIGN_IDENTITY}" \
    --entitlements "${MAC_DIR}/Resources/entitlements.plist" \
    "${APP}/Contents/MacOS/OpenAGI"
  codesign --force --options runtime --timestamp --sign "${SIGN_IDENTITY}" \
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

    # Codesign the DMG container itself. Without this, even a stapled
    # notarization ticket won't satisfy Gatekeeper: spctl says
    # "source=no usable signature" because the .dmg file has no embedded
    # signature of its own. Apple's docs require this for distributable
    # disk images.
    if [[ -n "${SIGN_USED:-}" ]]; then
      echo "▶ Codesigning DMG container"
      codesign --force --timestamp --sign "${SIGN_IDENTITY}" "${DMG_PATH}"
      codesign --verify --verbose=2 "${DMG_PATH}" 2>&1 | tail -3
    fi
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

  # Capture submit output so we can parse status + submission id.
  NOTARY_LOG="${BUILD_DIR}/notarize-submit.log"
  xcrun notarytool submit "${TARGET}" \
    --apple-id "${AC_USERNAME}" \
    --password "${AC_PASSWORD}" \
    --team-id "${AC_TEAM_ID}" \
    --wait 2>&1 | tee "${NOTARY_LOG}"

  STATUS="$(grep -E '^[[:space:]]*status:' "${NOTARY_LOG}" | tail -1 | awk -F': ' '{print $2}' | tr -d '[:space:]')"
  SUBMISSION_ID="$(grep -E '^[[:space:]]*id:' "${NOTARY_LOG}" | tail -1 | awk -F': ' '{print $2}' | tr -d '[:space:]')"

  if [[ "${STATUS}" != "Accepted" ]]; then
    echo "" >&2
    echo "✗ Notarization status: ${STATUS:-unknown}" >&2
    echo "✗ Submission id: ${SUBMISSION_ID:-unknown}" >&2
    if [[ -n "${SUBMISSION_ID}" ]]; then
      echo "" >&2
      echo "▶ Fetching Apple's notarization log:" >&2
      xcrun notarytool log "${SUBMISSION_ID}" \
        --apple-id "${AC_USERNAME}" \
        --password "${AC_PASSWORD}" \
        --team-id "${AC_TEAM_ID}" >&2 || true
    fi
    exit 1
  fi

  echo "▶ Stapling notarization ticket"
  # stapler accepts both .app directories and .dmg files.
  xcrun stapler staple "${TARGET}"
fi

echo "▶ Done. ${APP}"
