#!/usr/bin/env bash
# Install a weekly auto-update timer (Linux systemd).
# Runs scripts/update.sh every Sunday at 04:00.
#
#   sudo ./scripts/install-update-timer.sh                # system-wide
#        ./scripts/install-update-timer.sh user           # rootless
#        ./scripts/install-update-timer.sh uninstall      # remove
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-system}"

build_service() {
  cat <<EOF
[Unit]
Description=OpenAGI auto-update
After=network-online.target

[Service]
Type=oneshot
ExecStart=${PROJECT_DIR}/scripts/update.sh
WorkingDirectory=${PROJECT_DIR}
EOF
}

build_timer() {
  cat <<EOF
[Unit]
Description=OpenAGI weekly auto-update

[Timer]
OnCalendar=Sun *-*-* 04:00:00
Persistent=true
RandomizedDelaySec=1800

[Install]
WantedBy=timers.target
EOF
}

if [[ "${MODE}" == "uninstall" ]]; then
  for unit in openagi-update.timer openagi-update.service; do
    if [[ $EUID -eq 0 ]]; then
      systemctl disable --now "${unit}" 2>/dev/null || true
      rm -f "/etc/systemd/system/${unit}"
    else
      systemctl --user disable --now "${unit}" 2>/dev/null || true
      rm -f "$HOME/.config/systemd/user/${unit}"
    fi
  done
  ([[ $EUID -eq 0 ]] && systemctl daemon-reload) || systemctl --user daemon-reload
  echo "Removed update timer."
  exit 0
fi

if [[ "${MODE}" == "user" ]]; then
  mkdir -p "$HOME/.config/systemd/user"
  build_service > "$HOME/.config/systemd/user/openagi-update.service"
  build_timer > "$HOME/.config/systemd/user/openagi-update.timer"
  systemctl --user daemon-reload
  systemctl --user enable --now openagi-update.timer
  echo "Installed user-mode timer. Next run:"
  systemctl --user list-timers openagi-update.timer | head -3
  exit 0
fi

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: system install requires root. Re-run with sudo, or pass 'user'." >&2
  exit 1
fi

build_service > /etc/systemd/system/openagi-update.service
build_timer > /etc/systemd/system/openagi-update.timer
systemctl daemon-reload
systemctl enable --now openagi-update.timer
echo "Installed system-wide timer. Next run:"
systemctl list-timers openagi-update.timer | head -3
