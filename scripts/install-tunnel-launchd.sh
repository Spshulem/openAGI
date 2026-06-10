#!/usr/bin/env bash
# Install cloudflared as a launchd agent so the OpenAGI public URL is always up.
# Pairs with the OpenAGI tunnel-watcher which auto-updates OPENAGI_PUBLIC_URL
# by parsing the cloudflared log when the URL changes.
#
# Usage:
#   ./scripts/install-tunnel-launchd.sh                # install + start
#   ./scripts/install-tunnel-launchd.sh uninstall      # stop + remove
set -euo pipefail

LABEL="app.openagi.tunnel"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
# Write tunnel.log where the tunnel-watcher looks for it: the OpenAGI data dir
# (OPENAGI_DATA_DIR, default ~/.openagi) — NOT the project dir.
LOG_DIR="${OPENAGI_DATA_DIR:-$HOME/.openagi}"
CFD_BIN="${OPENAGI_CLOUDFLARED:-$(command -v cloudflared || true)}"

if [[ "${1:-install}" == "uninstall" ]]; then
  if [[ -f "${PLIST}" ]]; then
    launchctl bootout "gui/$(id -u)" "${PLIST}" 2>/dev/null || true
    rm -f "${PLIST}"
    echo "Removed ${LABEL}."
  fi
  exit 0
fi

if [[ -z "${CFD_BIN}" ]]; then
  echo "ERROR: cloudflared not found. Install with: brew install cloudflared" >&2
  exit 1
fi

mkdir -p "$(dirname "${PLIST}")" "${LOG_DIR}"

cat > "${PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${CFD_BIN}</string>
    <string>tunnel</string>
    <string>--no-autoupdate</string>
    <string>--url</string>
    <string>http://127.0.0.1:43210</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${LOG_DIR}/tunnel.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/tunnel.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)" "${PLIST}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "${PLIST}"
launchctl enable "gui/$(id -u)/${LABEL}"

echo
echo "Installed ${LABEL}."
echo "  log:  ${LOG_DIR}/tunnel.log"
echo "  Once cloudflared connects, the OpenAGI tunnel-watcher will pick up the URL"
echo "  and auto-write it to OPENAGI_PUBLIC_URL in ${LOG_DIR}/.env."
