#!/usr/bin/env bash
# Install OpenAGI as a macOS LaunchAgent so it auto-starts on login and
# restarts on crash. Local-only (127.0.0.1); pair with a tunnel if you
# want remote access.
#
# Usage:
#   ./scripts/install-launchd.sh            # install + load
#   ./scripts/install-launchd.sh uninstall  # stop + remove
#
set -euo pipefail

LABEL="app.openagi.daemon"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${PROJECT_DIR}/.openagi"
NODE_BIN="${OPENAGI_NODE_BIN:-$(command -v node || true)}"

if [[ -z "${NODE_BIN}" ]]; then
  echo "ERROR: node not found on PATH. Install Node 22+ or set OPENAGI_NODE_BIN=/path/to/node" >&2
  exit 1
fi

if [[ "${1:-install}" == "uninstall" ]]; then
  if [[ -f "${PLIST}" ]]; then
    launchctl bootout "gui/$(id -u)" "${PLIST}" 2>/dev/null || true
    rm -f "${PLIST}"
    echo "Removed ${PLIST}."
  else
    echo "Nothing to remove."
  fi
  exit 0
fi

mkdir -p "$(dirname "${PLIST}")" "${LOG_DIR}"

cat > "${PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${PROJECT_DIR}/examples/hosted-server.js</string>
  </array>
  <!-- WARNING: this launchd agent runs the dev daemon from ${PROJECT_DIR}/.openagi/.env
       which has its OWN auth token. If you also run OpenAGI.app, you'll have two
       daemons fighting over port 43210 with mismatched tokens. Pick one path. -->
  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
    <key>Crashed</key>
    <true/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/launchd.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(dirname "${NODE_BIN}"):/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
EOF

# Reload (bootout is fine if not loaded — we suppress the error).
launchctl bootout "gui/$(id -u)" "${PLIST}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "${PLIST}"
launchctl enable "gui/$(id -u)/${LABEL}"

echo
echo "Installed and started ${LABEL}."
echo "  plist:  ${PLIST}"
echo "  out:    ${LOG_DIR}/launchd.out.log"
echo "  err:    ${LOG_DIR}/launchd.err.log"
echo
echo "Stop:    launchctl bootout gui/\$(id -u) ${PLIST}"
echo "Start:   launchctl bootstrap gui/\$(id -u) ${PLIST}"
echo "Logs:    tail -f ${LOG_DIR}/launchd.err.log"
