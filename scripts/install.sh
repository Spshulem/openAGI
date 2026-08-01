#!/usr/bin/env sh
# OpenAGI one-line installer for Linux SBCs and servers.
#
# Detects OS + architecture and chooses the cleanest install path:
#   - If Docker is present → docker compose with persistent volume
#   - Else on Debian/Ubuntu/Raspberry Pi OS / Armbian → install Node + clone + systemd
#   - Else → print manual steps
#
# Use:
#   curl -fsSL https://raw.githubusercontent.com/Spshulem/openAGI/main/scripts/install.sh | sh
#
# Or with options:
#   curl -fsSL https://raw.githubusercontent.com/Spshulem/openAGI/main/scripts/install.sh | OPENAGI_FORCE=docker sh
#
# Tested on: Raspberry Pi OS (bookworm), Ubuntu 22.04+, Debian 12, Armbian, pamir.ai box.
set -eu

REPO="${OPENAGI_REPO:-https://github.com/Spshulem/openAGI.git}"
INSTALL_DIR="${OPENAGI_INSTALL_DIR:-/opt/openagi}"
MODE="${OPENAGI_FORCE:-auto}"

# Container image. Published to GHCR by .github/workflows/docker.yml, which
# pushes ghcr.io/${GITHUB_REPOSITORY,,} — lowercased, so Spshulem/openAGI
# becomes spshulem/openagi. There is NO official Docker Hub image; the
# openagi/openagi namespace this script used to point at is unclaimed, so that
# install was both broken and a namespace-squat waiting to happen.
IMAGE_REPO="${OPENAGI_IMAGE_REPO:-ghcr.io/spshulem/openagi}"
# Fallback when the GitHub API is unreachable. Bumped by the release process.
DEFAULT_IMAGE_TAG="v0.0.10"

# Resolve a CONCRETE version tag, never :latest. The compose file this writes is
# what scripts/update.sh later runs `docker compose pull` against, unattended —
# a floating tag there means new code lands on the box without anyone deciding
# to. Pinning makes that pull a no-op until the pin is bumped on purpose.
resolve_image_tag() {
  if [ -n "${OPENAGI_IMAGE_TAG:-}" ]; then
    printf '%s' "${OPENAGI_IMAGE_TAG}"
    return 0
  fi
  tag="$(curl -fsSL "https://api.github.com/repos/Spshulem/openAGI/releases/latest" 2>/dev/null \
    | grep -oE '"tag_name":[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"[[:space:]]*$/\1/')"
  case "${tag}" in
    v[0-9]*) printf '%s' "${tag}" ;;
    *) printf '%s' "${DEFAULT_IMAGE_TAG}" ;;
  esac
}

# Set by whichever install path actually ran, so the closing summary can tell
# the truth about where things are (set -u is on — these must exist).
INSTALLED_MODE=""
AUTH_TOKEN=""
COMPOSE_PATH=""
TMP_COMPOSE=""

# 256 bits of CSPRNG output, hex so it is safe unquoted in YAML, shell and URLs.
gen_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif [ -r /dev/urandom ] && command -v od >/dev/null 2>&1; then
    od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
  elif command -v node >/dev/null 2>&1; then
    node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))'
  else
    return 1
  fi
}

color_green() { printf '\033[1;32m%s\033[0m\n' "$1"; }
color_yellow() { printf '\033[1;33m%s\033[0m\n' "$1"; }
color_red() { printf '\033[1;31m%s\033[0m\n' "$1" >&2; }

need_sudo() {
  if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then
      sudo "$@"
    else
      color_red "This step needs root and 'sudo' is not available. Re-run as root."
      exit 1
    fi
  else
    "$@"
  fi
}

detect_arch() {
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) echo amd64 ;;
    aarch64|arm64) echo arm64 ;;
    armv7l) echo armv7 ;;
    *) echo "$arch" ;;
  esac
}

ip_for_user() {
  if command -v hostname >/dev/null 2>&1; then
    hostname -I 2>/dev/null | awk '{print $1}' || true
  else
    ip addr 2>/dev/null | awk '/inet /{print $2}' | head -1 | cut -d/ -f1
  fi
}

install_via_mac_dmg() {
  color_green "▶ Installing OpenAGI for macOS"
  if [ "$(uname -s)" != "Darwin" ]; then
    color_red "install_via_mac_dmg only runs on macOS."
    return 1
  fi

  # Pull the latest signed .dmg from the GitHub Release.
  color_yellow "▶ Resolving latest release"
  RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/Spshulem/openAGI/releases/latest" || true)"
  if [ -z "$RELEASE_JSON" ]; then
    color_red "Couldn't reach GitHub API. Check your network and try again."
    return 1
  fi

  DMG_URL="$(printf '%s' "$RELEASE_JSON" | grep -oE '"browser_download_url":[[:space:]]*"[^"]*\.dmg"' | head -1 | sed -E 's/.*"(https[^"]+\.dmg)".*/\1/')"
  if [ -z "$DMG_URL" ]; then
    color_yellow "No .dmg in the latest release yet. Falling back to source build."
    color_yellow "Run:  git clone $REPO && cd openAGI && npm install && ./scripts/build-mac-app.sh"
    return 1
  fi

  TMP="$(mktemp -d)"
  DMG="$TMP/OpenAGI.dmg"
  color_yellow "▶ Downloading $(basename "$DMG_URL")"
  curl -fL --progress-bar -o "$DMG" "$DMG_URL"

  color_yellow "▶ Verifying signature + notarization"
  # Strict: refuse to install a DMG that Gatekeeper can't validate.
  # Override only with OPENAGI_TRUST_UNSIGNED=1 (e.g. for ad-hoc-signed
  # local builds you've sideloaded into a dummy release).
  if ! spctl --assess --type install "$DMG" >/dev/null 2>&1; then
    if [ "${OPENAGI_TRUST_UNSIGNED:-0}" != "1" ]; then
      color_red "  ✗ Gatekeeper rejected the DMG (not signed + notarized by a Developer ID we trust)."
      color_red "  This DMG was downloaded from $DMG_URL"
      color_red "  Refusing to install. To override (only do this if you know what you're doing):"
      color_red "    curl -fsSL openagi.sh | OPENAGI_TRUST_UNSIGNED=1 sh"
      rm -rf "$TMP"
      return 1
    fi
    color_yellow "  ⚠ spctl rejected the DMG, continuing anyway because OPENAGI_TRUST_UNSIGNED=1"
  fi

  color_yellow "▶ Mounting"
  MOUNT_OUT="$(hdiutil attach -nobrowse -readonly "$DMG")"
  MOUNT_PATH="$(printf '%s' "$MOUNT_OUT" | tail -1 | awk -F'\t' '{print $NF}')"
  if [ ! -d "$MOUNT_PATH" ]; then
    color_red "Mount failed. DMG saved at $DMG."
    return 1
  fi

  APP_SOURCE="$MOUNT_PATH/OpenAGI.app"
  if [ ! -d "$APP_SOURCE" ]; then
    color_red "OpenAGI.app not found inside the DMG."
    hdiutil detach "$MOUNT_PATH" -quiet || true
    return 1
  fi

  color_yellow "▶ Copying to /Applications"
  if [ -d "/Applications/OpenAGI.app" ]; then
    rm -rf "/Applications/OpenAGI.app.bak"
    mv "/Applications/OpenAGI.app" "/Applications/OpenAGI.app.bak" || true
  fi
  cp -R "$APP_SOURCE" "/Applications/OpenAGI.app"
  hdiutil detach "$MOUNT_PATH" -quiet || true
  rm -rf "$TMP"

  if spctl --assess --verbose=4 "/Applications/OpenAGI.app" >/dev/null 2>&1; then
    color_green "  ✓ Gatekeeper says: signed + notarized."
  else
    if [ "${OPENAGI_TRUST_UNSIGNED:-0}" != "1" ]; then
      color_red "  ✗ Installed app failed Gatekeeper assessment. Rolling back."
      rm -rf "/Applications/OpenAGI.app"
      if [ -d "/Applications/OpenAGI.app.bak" ]; then
        mv "/Applications/OpenAGI.app.bak" "/Applications/OpenAGI.app"
      fi
      return 1
    fi
    color_yellow "  ⚠ App is installed but not Gatekeeper-validated (OPENAGI_TRUST_UNSIGNED=1). Right-click → Open the first time."
  fi

  color_green "▶ Launching OpenAGI"
  open "/Applications/OpenAGI.app"
  INSTALLED_MODE="mac"
  color_green "✓ Installed. Look in your menu bar — the OpenAGI icon should appear."
  color_yellow "  Setup wizard: http://127.0.0.1:43210/setup"
}

install_via_docker() {
  color_green "▶ Installing OpenAGI via Docker"
  if ! command -v docker >/dev/null 2>&1; then
    color_red "Docker is missing. Install it first: https://docs.docker.com/engine/install/"
    return 1
  fi
  need_sudo mkdir -p "${INSTALL_DIR}"
  need_sudo chown "$(id -un)" "${INSTALL_DIR}" || true

  COMPOSE_PATH="${INSTALL_DIR}/docker-compose.yml"

  # The container binds 0.0.0.0 (it must, for the published port to reach it),
  # so a token is MANDATORY — without one the daemon refuses to boot rather
  # than serving the dashboard, memory, screen recall and MCP registration to
  # everything on the LAN. Reuse the token already in the compose file on a
  # re-run: rotating it would silently break every paired node and saved login.
  AUTH_TOKEN=""
  if [ -f "${COMPOSE_PATH}" ]; then
    # `|| true`: the file is mode 0600 and may be owned by another user. Under
    # `set -e` a failed read here would abort the whole install rather than
    # falling through to generating a fresh token.
    AUTH_TOKEN="$(sed -n 's/^[[:space:]]*OPENAGI_AUTH_TOKEN:[[:space:]]*"\{0,1\}\([A-Za-z0-9._~-]\{16,\}\)"\{0,1\}[[:space:]]*$/\1/p' "${COMPOSE_PATH}" 2>/dev/null | head -1 || true)"
    [ -n "${AUTH_TOKEN}" ] && color_yellow "▶ Reusing the auth token already in ${COMPOSE_PATH}"
  fi
  if [ -z "${AUTH_TOKEN}" ]; then
    AUTH_TOKEN="$(gen_token || true)"
    if [ -z "${AUTH_TOKEN}" ]; then
      color_red "Couldn't generate an auth token (no openssl, /dev/urandom or node)."
      color_red "Install openssl, or set OPENAGI_AUTH_TOKEN yourself and re-run."
      return 1
    fi
  fi

  IMAGE_TAG="$(resolve_image_tag)"
  IMAGE="${IMAGE_REPO}:${IMAGE_TAG}"
  color_green "▶ Image: ${IMAGE}"

  # Staged through a 0600 temp file: the token must never exist in a
  # world-readable file, not even momentarily, and COMPOSE_PATH may already be
  # there root-owned and 0600 from an earlier run — a direct `cat >` would die
  # on "Permission denied" after we had already announced the image.
  #
  # Unquoted heredoc: IMAGE and AUTH_TOKEN must expand. Nothing else in the
  # body uses $, so there is nothing to accidentally interpolate.
  TMP_COMPOSE="$(mktemp)"
  chmod 600 "${TMP_COMPOSE}" 2>/dev/null || true
  cat > "${TMP_COMPOSE}" <<YAML
# Generated by scripts/install.sh — contains a secret; keep it 0600.
# The image tag is pinned deliberately: scripts/update.sh runs
# \`docker compose pull\` unattended, and a floating :latest would let new code
# land here without anyone choosing it. Bump the tag to update.
services:
  openagi:
    image: ${IMAGE}
    container_name: openagi
    ports: ["43210:43210"]
    volumes: ["openagi-data:/data"]
    environment:
      OPENAGI_DATA_DIR: /data
      HOST: "0.0.0.0"
      OPENAGI_AUTH_TOKEN: "${AUTH_TOKEN}"
    restart: unless-stopped
volumes:
  openagi-data:
YAML
  if ! cp "${TMP_COMPOSE}" "${COMPOSE_PATH}" 2>/dev/null; then
    need_sudo cp "${TMP_COMPOSE}" "${COMPOSE_PATH}"
  fi
  rm -f "${TMP_COMPOSE}"
  chmod 600 "${COMPOSE_PATH}" 2>/dev/null || need_sudo chmod 600 "${COMPOSE_PATH}" || true

  if ! (cd "${INSTALL_DIR}" && need_sudo docker compose pull); then
    color_red "Couldn't pull ${IMAGE}."
    color_red "  - Check the tag exists: https://github.com/Spshulem/openAGI/pkgs/container/openagi"
    color_red "  - If it is a private package, log in first: docker login ghcr.io"
    color_red "  - Or pin a different one: OPENAGI_IMAGE_TAG=vX.Y.Z sh install.sh"
    return 1
  fi
  (cd "${INSTALL_DIR}" && need_sudo docker compose up -d)
  INSTALLED_MODE="docker"
  color_green "✓ Container running."
}

install_via_systemd() {
  color_green "▶ Installing OpenAGI from source with systemd"

  if ! command -v node >/dev/null 2>&1 || ! node -v 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])\.'; then
    color_yellow "Node 22+ not found — installing via NodeSource"
    need_sudo sh -c 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -'
    need_sudo apt-get install -y nodejs
  fi

  if ! command -v git >/dev/null 2>&1; then
    need_sudo apt-get update && need_sudo apt-get install -y git
  fi

  if [ ! -d "${INSTALL_DIR}/.git" ]; then
    need_sudo git clone "${REPO}" "${INSTALL_DIR}"
  else
    (cd "${INSTALL_DIR}" && need_sudo git pull --ff-only)
  fi

  need_sudo mkdir -p "${INSTALL_DIR}/.openagi"
  need_sudo touch "${INSTALL_DIR}/.openagi/.env"

  need_sudo bash "${INSTALL_DIR}/scripts/install-systemd.sh"
  INSTALLED_MODE="systemd"
  color_green "✓ systemd service running."
}

# --- main ---
arch="$(detect_arch)"
ip="$(ip_for_user || true)"
color_green "Architecture: ${arch}"

case "${MODE}" in
  docker) install_via_docker ;;
  systemd|source) install_via_systemd ;;
  mac) install_via_mac_dmg ;;
  auto)
    UNAME_S="$(uname -s)"
    if [ "$UNAME_S" = "Darwin" ]; then
      install_via_mac_dmg
    elif command -v docker >/dev/null 2>&1; then
      install_via_docker || install_via_systemd
    elif [ -f /etc/debian_version ]; then
      install_via_systemd
    else
      color_red "Auto-install only supports macOS, Debian-family hosts, or systems with Docker installed."
      color_red "Install Docker first, then re-run this script."
      exit 1
    fi
    ;;
  *) color_red "Unknown OPENAGI_FORCE=${MODE}"; exit 1 ;;
esac

printf '\n──────────────────────────────────────────────\n'
color_green "OpenAGI is up."

case "${INSTALLED_MODE}" in
  docker)
    cat <<EOF

  Open the setup wizard (the ?token= signs you in and sets a cookie):
    http://${ip:-<your IP>}:43210/setup?token=${AUTH_TOKEN}

  Your auth token — this is a SECRET. It is the only thing standing between
  your LAN and this agent's memory, screen recall and message history:
    ${AUTH_TOKEN}

  Stored in ${COMPOSE_PATH} (mode 0600). To read it back later:
    sudo grep OPENAGI_AUTH_TOKEN ${COMPOSE_PATH}

  Pair another device:
    openagi pair http://${ip:-<your IP>}:43210 --token <the token above>

  Tail logs:
    docker logs -f openagi
EOF
    ;;
  systemd)
    cat <<EOF

  The service binds 127.0.0.1 only, so open the wizard ON THIS MACHINE:
    http://127.0.0.1:43210/setup

  To let other devices reach it, set OPENAGI_AUTH_TOKEN in
  ${INSTALL_DIR}/.openagi/.env and HOST=0.0.0.0, then restart. Without a token
  a non-loopback bind is refused rather than served unauthenticated.

  Tail logs:
    journalctl -u openagi -f
EOF
    ;;
  mac)
    cat <<EOF

  Open the setup wizard:
    http://127.0.0.1:43210/setup

  Tail logs:
    tail -f ~/Library/Application\\ Support/OpenAGI/launchd.err.log
EOF
    ;;
  *)
    cat <<EOF

  Open the setup wizard:
    http://${ip:-<your IP>}:43210/setup
EOF
    ;;
esac

printf '\n──────────────────────────────────────────────\n'
