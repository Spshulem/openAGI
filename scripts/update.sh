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

# Resolve the install dir: explicit override wins; else, when run as
# ./scripts/update.sh from a real checkout, use THIS script's own repo
# (so non-/opt installs like ~/openAGI on a Pi/Distiller auto-update too);
# else fall back to /opt/openagi for the `curl | sh` case.
if [ -n "${OPENAGI_INSTALL_DIR:-}" ]; then
  PROJECT_DIR="${OPENAGI_INSTALL_DIR}"
else
  SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || true)
  if [ -n "${SELF_DIR}" ] && [ -f "${SELF_DIR}/../package.json" ]; then
    PROJECT_DIR=$(CDPATH= cd -- "${SELF_DIR}/.." && pwd)
  elif command -v systemctl >/dev/null 2>&1 && systemctl --user is-active openagi >/dev/null 2>&1; then
    UNIT_WD=$(systemctl --user show -p WorkingDirectory --value openagi 2>/dev/null || true)
    PROJECT_DIR="${UNIT_WD:-/opt/openagi}"
  elif command -v systemctl >/dev/null 2>&1 && systemctl is-active openagi >/dev/null 2>&1; then
    UNIT_WD=$(systemctl show -p WorkingDirectory --value openagi 2>/dev/null || true)
    PROJECT_DIR="${UNIT_WD:-/opt/openagi}"
  elif [ -f "$HOME/OpenAGI/package.json" ]; then
    PROJECT_DIR="$HOME/OpenAGI"
  elif [ -f "$HOME/openAGI/package.json" ]; then
    PROJECT_DIR="$HOME/openAGI"
  else
    PROJECT_DIR="/opt/openagi"
  fi
fi
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

# This script is designed to run unattended (systemd timer, cron, `openagi
# update`). That makes every `docker pull` here a supply-chain edge: whatever
# the referenced tag points at right now becomes the code running on this box.
# A pinned vX.Y.Z tag is immutable, so the pull is a no-op until someone bumps
# the pin on purpose; a floating tag is not, so say so out loud.
warn_if_floating_tag() {
  case "$1" in
    *:v[0-9]*|*@sha256:*) return 0 ;;
    *)
      color_yellow "⚠ ${1} is a floating tag — this pull can change the running code without you choosing a version."
      color_yellow "  Pin a release tag (e.g. ghcr.io/spshulem/openagi:v0.0.10) to make updates deliberate."
      ;;
  esac
}

update_docker_compose() {
  color_green "▶ Updating via docker compose"
  IMAGE=$(grep -oE '^[[:space:]]*image:[[:space:]]*\S*openagi\S*' "${COMPOSE_FILE}" 2>/dev/null | head -1 | sed -E 's/.*image:[[:space:]]*//')
  [ -n "${IMAGE:-}" ] && warn_if_floating_tag "${IMAGE}"
  (cd "${PROJECT_DIR}" && need_sudo docker compose pull && need_sudo docker compose up -d)
  color_green "✓ Container recreated."
}

update_docker_container() {
  color_green "▶ Updating standalone Docker container 'openagi'"
  IMAGE=$(docker inspect -f '{{.Config.Image}}' openagi)
  warn_if_floating_tag "${IMAGE}"

  # Carry the container's own configuration across the recreate. This used to
  # replay a bare `docker run`, which silently dropped every -e the user had
  # set — including OPENAGI_AUTH_TOKEN and their API keys. That is no longer
  # merely lossy: the daemon refuses to start on a non-loopback bind with no
  # token, so an unattended update would have left the agent down. Allowlisted
  # by prefix so we don't replay PATH/NODE_VERSION out of the image.
  set --
  while IFS= read -r kv; do
    case "${kv}" in
      OPENAGI_*=*|ANTHROPIC_*=*|OPENAI_*=*|TWILIO_*=*|TELEGRAM_*=*|RIZE_*=*|HOST=*|PORT=*)
        set -- "$@" -e "${kv}" ;;
    esac
  done <<CONTAINER_ENV
$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' openagi)
CONTAINER_ENV

  need_sudo docker pull "${IMAGE}"
  need_sudo docker stop openagi
  need_sudo docker rm openagi
  need_sudo docker run -d --name openagi --restart unless-stopped \
    -p 43210:43210 -v openagi-data:/data "$@" "${IMAGE}"
  color_green "✓ Container replaced. Env carried over; if you used custom ports or mounts, re-run with them manually."
}

update_portable_linux_tarball() {
  ARCH_M="$(uname -m)"
  case "${ARCH_M}" in
    aarch64|arm64) ASSET="OpenAGI-Linux-arm64.tar.gz" ;;
    x86_64|amd64) ASSET="OpenAGI-Linux-x64.tar.gz" ;;
    *) color_red "Unsupported Linux architecture for portable tarball update: ${ARCH_M}"; exit 1 ;;
  esac
  color_green "▶ Updating portable Linux install in ${PROJECT_DIR} (${ASSET})"
  TMP_STAGE="$(mktemp -d)"
  trap 'rm -rf "${TMP_STAGE}"' EXIT
  BASE_URL="https://github.com/Spshulem/openAGI/releases/latest/download"
  curl -fL "${BASE_URL}/${ASSET}" -o "${TMP_STAGE}/${ASSET}"
  curl -fL "${BASE_URL}/${ASSET}.sha256" -o "${TMP_STAGE}/${ASSET}.sha256"
  (cd "${TMP_STAGE}" && sha256sum -c "${ASSET}.sha256")
  mkdir -p "${TMP_STAGE}/extracted"
  tar -xzf "${TMP_STAGE}/${ASSET}" -C "${TMP_STAGE}/extracted"
  BUNDLE_DIR="${TMP_STAGE}/extracted/OpenAGI"
  if [ ! -f "${BUNDLE_DIR}/package.json" ]; then
    color_red "Extracted archive missing OpenAGI/package.json"
    exit 1
  fi
  WRITE_CMD=""
  if [ ! -w "${PROJECT_DIR}" ]; then WRITE_CMD="need_sudo"; fi
  for entry in bin src examples scripts assets docs node_modules package.json package-lock.json runtime-manifest.json LICENSE README.md START_HERE.txt start-openagi.sh; do
    if [ -e "${BUNDLE_DIR}/${entry}" ]; then
      ${WRITE_CMD} rm -rf "${PROJECT_DIR}/${entry}.prev"
      if [ -e "${PROJECT_DIR}/${entry}" ]; then
        ${WRITE_CMD} mv "${PROJECT_DIR}/${entry}" "${PROJECT_DIR}/${entry}.prev"
      fi
      ${WRITE_CMD} cp -a "${BUNDLE_DIR}/${entry}" "${PROJECT_DIR}/${entry}"
      ${WRITE_CMD} rm -rf "${PROJECT_DIR}/${entry}.prev"
    fi
  done
  if [ -d "${PROJECT_DIR}/node" ] && [ -d "${BUNDLE_DIR}/node" ]; then
    ${WRITE_CMD} rm -rf "${PROJECT_DIR}/node.prev"
    ${WRITE_CMD} mv "${PROJECT_DIR}/node" "${PROJECT_DIR}/node.prev"
    ${WRITE_CMD} cp -a "${BUNDLE_DIR}/node" "${PROJECT_DIR}/node"
    ${WRITE_CMD} rm -rf "${PROJECT_DIR}/node.prev"
  fi
  rm -rf "${TMP_STAGE}"
  trap - EXIT
}

update_systemd() {
  color_green "▶ Updating via systemd ($1)"
  if [ -d "${PROJECT_DIR}/.git" ]; then
    (cd "${PROJECT_DIR}" && need_sudo git fetch origin && need_sudo git pull --ff-only)
    (cd "${PROJECT_DIR}" && need_sudo npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
  elif [ -f "${PROJECT_DIR}/package.json" ] && [ "$(uname -s)" = "Linux" ]; then
    update_portable_linux_tarball
  else
    color_red "${PROJECT_DIR} is not a git checkout or portable OpenAGI folder."
    exit 1
  fi
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
  (cd "${PROJECT_DIR}" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
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

# Bare source / portable Linux tarball fallback
if [ -d "${PROJECT_DIR}/.git" ]; then
  color_yellow "▶ No managed service detected. Doing a bare git pull. Restart the daemon manually."
  (cd "${PROJECT_DIR}" && git pull --ff-only)
  (cd "${PROJECT_DIR}" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
  exit 0
fi

if [ -f "${PROJECT_DIR}/package.json" ] && [ "$(uname -s)" = "Linux" ]; then
  update_portable_linux_tarball
  if curl -fsS -X POST http://127.0.0.1:43210/control/restart >/dev/null 2>&1; then
    color_green "✓ Updated portable runtime and triggered daemon restart."
  else
    color_green "✓ Updated portable runtime in ${PROJECT_DIR}. Restart your OpenAGI process to load the new version."
  fi
  exit 0
fi

color_red "Couldn't auto-detect an OpenAGI install. Set OPENAGI_INSTALL_DIR or update manually."
exit 1
