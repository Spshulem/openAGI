#!/usr/bin/env bash
# Install OpenAGI as a systemd service on Linux. Auto-starts on boot,
# auto-restarts on crash. Works as system service (root) or user service.
#
# Usage:
#   sudo ./scripts/install-systemd.sh             # system-wide
#        ./scripts/install-systemd.sh user        # current user only (rootless)
#        ./scripts/install-systemd.sh uninstall   # remove
#
# After install:
#   journalctl -u openagi -f       # tail logs (system)
#   journalctl --user -u openagi -f # tail logs (user mode)
#
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${OPENAGI_NODE_BIN:-$(command -v node || true)}"
MODE="${1:-system}"

if [[ -z "${NODE_BIN}" ]]; then
  echo "ERROR: node not found on PATH. Install Node 22+ or set OPENAGI_NODE_BIN." >&2
  exit 1
fi

UNIT_NAME="openagi.service"

build_unit() {
  cat <<EOF
[Unit]
Description=OpenAGI agent host
Documentation=https://github.com/Spshulem/openAGI
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${NODE_BIN} ${PROJECT_DIR}/examples/hosted-server.js
WorkingDirectory=${PROJECT_DIR}
EnvironmentFile=-${PROJECT_DIR}/.openagi/.env
Restart=on-failure
RestartSec=10s
StandardOutput=journal
StandardError=journal

# Hardening (skipped in user mode where some are not honored)
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=${PROJECT_DIR}/.openagi

[Install]
WantedBy=${1:-multi-user.target}
EOF
}

if [[ "${MODE}" == "uninstall" ]]; then
  if systemctl --user is-active "${UNIT_NAME}" &>/dev/null; then
    systemctl --user stop "${UNIT_NAME}" || true
    systemctl --user disable "${UNIT_NAME}" || true
    rm -f "$HOME/.config/systemd/user/${UNIT_NAME}"
    systemctl --user daemon-reload
    echo "Removed user service ${UNIT_NAME}."
    exit 0
  fi
  if [[ $EUID -eq 0 ]]; then
    systemctl stop "${UNIT_NAME}" || true
    systemctl disable "${UNIT_NAME}" || true
    rm -f "/etc/systemd/system/${UNIT_NAME}"
    systemctl daemon-reload
    echo "Removed system service ${UNIT_NAME}."
    exit 0
  fi
  echo "Service ${UNIT_NAME} not found; nothing to remove."
  exit 0
fi

if [[ "${MODE}" == "user" ]]; then
  mkdir -p "$HOME/.config/systemd/user"
  build_unit default.target > "$HOME/.config/systemd/user/${UNIT_NAME}"
  systemctl --user daemon-reload
  systemctl --user enable --now "${UNIT_NAME}"
  echo "Installed user service. Tail: journalctl --user -u openagi -f"
  exit 0
fi

# System mode
if [[ $EUID -ne 0 ]]; then
  echo "ERROR: system install requires root. Re-run with sudo, or pass 'user' for a rootless install." >&2
  exit 1
fi

# Create dedicated user if missing
if ! id -u openagi &>/dev/null; then
  useradd --system --shell /usr/sbin/nologin --home-dir "${PROJECT_DIR}" openagi
  echo "Created system user 'openagi'."
fi
chown -R openagi:openagi "${PROJECT_DIR}/.openagi" 2>/dev/null || true

build_unit multi-user.target > "/etc/systemd/system/${UNIT_NAME}"
# Pin User=openagi for system mode by appending — done inline so build_unit stays portable
sed -i '/^\[Service\]/a User=openagi\nGroup=openagi' "/etc/systemd/system/${UNIT_NAME}"

systemctl daemon-reload
systemctl enable --now "${UNIT_NAME}"
echo "Installed system service. Tail: journalctl -u openagi -f"
