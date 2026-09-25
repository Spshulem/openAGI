#!/usr/bin/env bash
set -euo pipefail

LINUX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-${HOME}/.config}"
STATE_DIR="${HOME}/.local/state/openagi/linux-companion"
INSTALL_ROOT="${DATA_HOME}/openagi-linux-companion"
RELEASES_DIR="${INSTALL_ROOT}/releases"
CURRENT_LINK="${INSTALL_ROOT}/current"
BIN_DIR="${HOME}/.local/bin"
SYSTEMD_DIR="${CONFIG_HOME}/systemd/user"
KWIN_DIR="${DATA_HOME}/kwin/scripts/openagi-linux-companion"
DESKTOP_FILE="${DATA_HOME}/applications/sh.openagi.LinuxCompanion.desktop"
OPENAGI_DROPIN="${SYSTEMD_DIR}/openagi.service.d/20-linux-companion.conf"
MODE="${1:-install}"

reconfigure_kwin() {
  if command -v qdbus6 >/dev/null 2>&1; then
    qdbus6 org.kde.KWin /KWin reconfigure >/dev/null 2>&1 || true
  elif command -v busctl >/dev/null 2>&1; then
    busctl --user call org.kde.KWin /KWin org.kde.KWin reconfigure >/dev/null 2>&1 || true
  fi
}

show_plan() {
  printf '%s\n' \
    "package=${INSTALL_ROOT}" \
    "commands=${BIN_DIR}/openagi-linux-companion,${BIN_DIR}/openagi-linux-helper" \
    "state=${STATE_DIR}" \
    "systemd=${SYSTEMD_DIR}/openagi-linux-companion.service" \
    "kwin=${KWIN_DIR}" \
    "desktop=${DESKTOP_FILE}" \
    "openagi_dropin=${OPENAGI_DROPIN}"
}

if [[ "${MODE}" == "--dry-run" ]]; then
  show_plan
  if systemctl --user cat openagi.service >/dev/null 2>&1; then
    printf '%s\n' "OpenAGI core user service: present"
  else
    printf '%s\n' "OpenAGI core user service: missing"
  fi
  exit 0
fi

if [[ "${MODE}" == "uninstall" ]]; then
  systemctl --user disable --now openagi-linux-companion.service 2>/dev/null || true
  rm -f "${SYSTEMD_DIR}/openagi-linux-companion.service"
  rm -f "${OPENAGI_DROPIN}"
  rm -f "${DESKTOP_FILE}"
  rmdir "$(dirname "${OPENAGI_DROPIN}")" 2>/dev/null || true
  rm -f "${BIN_DIR}/openagi-linux-companion" "${BIN_DIR}/openagi-linux-helper"
  rm -rf "${INSTALL_ROOT}" "${KWIN_DIR}"
  if command -v kwriteconfig6 >/dev/null 2>&1; then
    kwriteconfig6 --file kwinrc --group Plugins --key openagi-linux-companionEnabled false
  fi
  systemctl --user daemon-reload
  reconfigure_kwin
  printf '%s\n' "OpenAGI Linux companion removed."
  exit 0
fi

ACTIVATE=1
if [[ "${MODE}" == "--stage-only" ]]; then
  ACTIVATE=0
elif [[ "${MODE}" != "install" ]]; then
  printf 'Usage: %s [install|uninstall|--dry-run|--stage-only]\n' "$0" >&2
  exit 2
fi

for command_name in python3 systemctl tesseract; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "${command_name}" >&2
    exit 1
  fi
done

python3 - <<'PY'
import gi

gi.require_version("Gst", "1.0")
from gi.repository import Gst
PY

if [[ "${ACTIVATE}" == "1" ]] && ! systemctl --user cat openagi.service >/dev/null 2>&1; then
  printf '%s\n' \
    "Missing OpenAGI core user service. Install openagi.service from a durable HOME/NVMe checkout before activating the companion." >&2
  exit 1
fi

install -d -m 0700 "${STATE_DIR}"
install -d -m 0700 "${INSTALL_ROOT}" "${RELEASES_DIR}" "${BIN_DIR}" "${SYSTEMD_DIR}" "$(dirname "${OPENAGI_DROPIN}")"
install -d -m 0755 "$(dirname "${DESKTOP_FILE}")"
BUILD_BASE="${TMPDIR:-${HOME}/.cache}"
install -d -m 0700 "${BUILD_BASE}"
BUILD_ROOT="$(mktemp -d "${BUILD_BASE%/}/openagi-linux-build.XXXXXX")"
STAGING_ROOT="$(mktemp -d "${RELEASES_DIR}/release.XXXXXX")"
CURRENT_CANDIDATE=""
cleanup_install_artifacts() {
  rm -rf -- "${BUILD_ROOT}"
  if [[ -n "${STAGING_ROOT}" ]]; then
    rm -rf -- "${STAGING_ROOT}"
  fi
  if [[ -n "${CURRENT_CANDIDATE}" ]]; then
    rm -f -- "${CURRENT_CANDIDATE}"
  fi
}
trap cleanup_install_artifacts EXIT
install -m 0644 "${LINUX_DIR}/pyproject.toml" "${BUILD_ROOT}/pyproject.toml"
install -d -m 0755 "${BUILD_ROOT}/openagi_linux"
for source_file in "${LINUX_DIR}"/openagi_linux/*.py; do
  install -m 0644 "${source_file}" "${BUILD_ROOT}/openagi_linux/$(basename "${source_file}")"
done
STAGING_VENV="${STAGING_ROOT}/venv"
python3 -m venv --system-site-packages "${STAGING_VENV}"
"${STAGING_VENV}/bin/python" -m pip install --disable-pip-version-check "${BUILD_ROOT}"
"${STAGING_VENV}/bin/python" - <<'PY'
import dbus_next
import gi
import PIL
import PySide6

gi.require_version("Gst", "1.0")
gi.require_version("GstApp", "1.0")
from gi.repository import Gst, GstApp
PY
"${STAGING_VENV}/bin/openagi-linux-companion" --version >/dev/null
if [[ "${ACTIVATE}" == "1" ]]; then
  "${STAGING_VENV}/bin/openagi-linux-companion" --doctor
fi

install -m 0644 "${LINUX_DIR}/systemd/openagi-linux-companion.service" "${SYSTEMD_DIR}/openagi-linux-companion.service"
install -m 0644 "${LINUX_DIR}/sh.openagi.LinuxCompanion.desktop" "${DESKTOP_FILE}"
install -d -m 0755 "${KWIN_DIR}/contents/code"
install -m 0644 "${LINUX_DIR}/kwin/metadata.json" "${KWIN_DIR}/metadata.json"
install -m 0644 "${LINUX_DIR}/kwin/contents/code/main.js" "${KWIN_DIR}/contents/code/main.js"

cat >"${OPENAGI_DROPIN}" <<EOF
[Unit]
After=graphical-session.target

[Service]
Environment=OPENAGI_COMPUTER_BACKEND=native
Environment=OPENAGI_COMPUTER_HELPER=${BIN_DIR}/openagi-linux-helper
Environment=OPENAGI_COMPUTER_USE=1
EOF
chmod 0600 "${OPENAGI_DROPIN}"

RELEASE_ROOT="${STAGING_ROOT}"
RELEASE_NAME="${RELEASE_ROOT##*/}"
CURRENT_CANDIDATE="${INSTALL_ROOT}/.current.$$"
ln -s "releases/${RELEASE_NAME}" "${CURRENT_CANDIDATE}"
mv -Tf -- "${CURRENT_CANDIDATE}" "${CURRENT_LINK}"
CURRENT_CANDIDATE=""
STAGING_ROOT=""
ln -sfn "${CURRENT_LINK}/venv/bin/openagi-linux-companion" "${BIN_DIR}/openagi-linux-companion"
ln -sfn "${CURRENT_LINK}/venv/bin/openagi-linux-helper" "${BIN_DIR}/openagi-linux-helper"

if [[ "${ACTIVATE}" == "0" ]]; then
  show_plan
  printf '%s\n' "Staged without changing KWin or systemd runtime state."
  exit 0
fi

if command -v kwriteconfig6 >/dev/null 2>&1; then
  kwriteconfig6 --file kwinrc --group Plugins --key openagi-linux-companionEnabled true
fi
reconfigure_kwin

systemctl --user daemon-reload
systemctl --user enable openagi-linux-companion.service
if systemctl --user is-active openagi-linux-companion.service >/dev/null 2>&1; then
  systemctl --user restart openagi-linux-companion.service
else
  systemctl --user start openagi-linux-companion.service
fi
if systemctl --user is-active openagi.service >/dev/null 2>&1; then
  systemctl --user restart openagi.service
fi

show_plan
printf '%s\n' "Installed. Screen capture and remote control remain disabled until enabled explicitly from the tray."
