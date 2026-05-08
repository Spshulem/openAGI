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
  cat > "${INSTALL_DIR}/docker-compose.yml" <<'YAML'
services:
  openagi:
    image: openagi/openagi:latest
    container_name: openagi
    ports: ["43210:43210"]
    volumes: ["openagi-data:/data"]
    environment:
      OPENAGI_DATA_DIR: /data
      HOST: "0.0.0.0"
    restart: unless-stopped
volumes:
  openagi-data:
YAML
  (cd "${INSTALL_DIR}" && need_sudo docker compose pull && need_sudo docker compose up -d)
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

cat <<EOF

──────────────────────────────────────────────
$(color_green "OpenAGI is up.")

  Open the setup wizard:
    http://${ip:-<your IP>}:43210/setup

  Tail logs:
    journalctl -u openagi -f                                    # systemd
    docker logs -f openagi                                      # docker
    tail -f ~/Library/Application\ Support/OpenAGI/launchd.err.log  # macOS

──────────────────────────────────────────────
EOF
