#!/usr/bin/env sh
# OpenAGI updater. Auto-detects the install mode and updates in-place.
#
#   - Docker compose: docker compose pull + up -d
#   - Docker container (named "openagi"): pull image + recreate
#   - systemd (system or user): git pull + service restart
#   - launchd (macOS): git pull + bootout/bootstrap
#   - bare source: git pull + reminder to restart manually
#
# Use:
#   ./scripts/update.sh
#   curl -fsSL https://raw.githubusercontent.com/Spshulem/openAGI/main/scripts/update.sh | sh
set -eu

PROJECT_DIR="${OPENAGI_INSTALL_DIR:-/opt/openagi}"
COMPOSE_FILE="${PROJECT_DIR}/docker-compose.yml"
LAUNCHD_LABEL="app.openagi.daemon"
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"

color_green() { printf '\033[1;32m%s\033[0m\n' "$1"; }
color_yellow() { printf '\033[1;33m%s\033[0m\n' "$1"; }
color_red() { printf '\033[1;31m%s\033[0m\n' "$1" >&2; }

need_sudo() {
  if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    "$@"
  fi
}

update_docker_compose() {
  color_green "▶ Updating via docker compose"
  (cd "${PROJECT_DIR}" && need_sudo docker compose pull && need_sudo docker compose up -d)
  color_green "✓ Container recreated."
}

update_docker_container() {
  color_green "▶ Updating standalone Docker container 'openagi'"
  IMAGE=$(docker inspect -f '{{.Config.Image}}' openagi)
  need_sudo docker pull "${IMAGE}"
  need_sudo docker stop openagi
  need_sudo docker rm openagi
  # Replay the run with the same image; user is responsible for any extra flags.
  need_sudo docker run -d --name openagi --restart unless-stopped \
    -p 43210:43210 -v openagi-data:/data "${IMAGE}"
  color_green "✓ Container replaced. If you used custom flags, re-run with them manually."
}

update_systemd() {
  color_green "▶ Updating via systemd ($1)"
  if [ ! -d "${PROJECT_DIR}/.git" ]; then
    color_red "${PROJECT_DIR} is not a git checkout — cannot update via git pull."
    exit 1
  fi
  (cd "${PROJECT_DIR}" && need_sudo git fetch origin && need_sudo git pull --ff-only)
  if [ "$1" = "user" ]; then
    systemctl --user restart openagi
  else
    need_sudo systemctl restart openagi
  fi
  color_green "✓ Service restarted."
}

update_launchd() {
  color_green "▶ Updating via launchd"
  if [ ! -d "${PROJECT_DIR}/.git" ]; then
    color_red "${PROJECT_DIR} is not a git checkout — cannot update via git pull."
    exit 1
  fi
  (cd "${PROJECT_DIR}" && git fetch origin && git pull --ff-only)
  launchctl bootout "gui/$(id -u)" "${LAUNCHD_PLIST}" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "${LAUNCHD_PLIST}"
  color_green "✓ Daemon reloaded."
}

# --- detect ---
if command -v docker >/dev/null 2>&1; then
  if [ -f "${COMPOSE_FILE}" ]; then
    update_docker_compose
    exit 0
  fi
  if docker inspect openagi >/dev/null 2>&1; then
    update_docker_container
    exit 0
  fi
fi

# systemd: prefer user service if active, fall back to system service
if command -v systemctl >/dev/null 2>&1; then
  if systemctl --user is-active openagi >/dev/null 2>&1; then
    update_systemd user
    exit 0
  fi
  if systemctl is-active openagi >/dev/null 2>&1; then
    update_systemd system
    exit 0
  fi
fi

# launchd (macOS)
if [ -f "${LAUNCHD_PLIST}" ]; then
  update_launchd
  exit 0
fi

# Bare source fallback
if [ -d "${PROJECT_DIR}/.git" ]; then
  color_yellow "▶ No managed service detected. Doing a bare git pull. Restart the daemon manually."
  (cd "${PROJECT_DIR}" && git pull --ff-only)
  exit 0
fi

color_red "Couldn't auto-detect an OpenAGI install. Set OPENAGI_INSTALL_DIR or update manually."
exit 1
