#!/usr/bin/env bash
# Install the OpenAGI iMessage bridge (+ optional search service) as macOS
# LaunchAgents, so they auto-start on login and restart on crash. Run this on
# the Mac that's signed into iMessage (the "node"); it relays iMessages to a
# remote OpenAGI main you've already paired with (`openagi pair <main>`).
#
# Usage:
#   ./scripts/install-imessage-launchd.sh            # install + load
#   ./scripts/install-imessage-launchd.sh uninstall  # stop + remove
#
# Config (env vars):
#   IMESSAGE_RESPOND   all|allow|trigger|none   reply policy (default: all)
#   IMESSAGE_ALLOW     h1,h2                     sender allowlist (for respond=allow)
#   IMESSAGE_ALLOW_CHATS c1,c2                   group chat ids where ANY member
#                                                can invoke the trigger (chat787…)
#   IMESSAGE_TRIGGER   word                      trigger word (for respond=trigger)
#   IMESSAGE_CAPTURE   none|allow|all            save incoming → memory (default: none)
#   IMESSAGE_NODE_TOKEN  secret                  if set, ALSO install the search
#                                                service so the main can search
#                                                your messages (search_imessages)
#   IMESSAGE_NODE_PORT   port                    search service port (default 43298)
#   OPENAGI_NODE_BIN     /path/to/node           node binary (default: from PATH)
#   OPENAGI_DIR          /path/to/openAGI        checkout (default: ../ of this script)
#
# IMPORTANT — Full Disk Access: launchd-spawned processes need Full Disk Access
# to read ~/Library/Messages/chat.db. After installing, add the node binary
# (printed below) to System Settings → Privacy & Security → Full Disk Access,
# then `launchctl kickstart -k` the agents (or reboot).
set -euo pipefail

OPENAGI_DIR="${OPENAGI_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_BIN="${OPENAGI_NODE_BIN:-$(command -v node || true)}"
BIN="${OPENAGI_DIR}/bin/openagi.js"
LOG_DIR="${HOME}/.openagi"
GUI="gui/$(id -u)"
BRIDGE_LABEL="app.openagi.imessage-bridge"
SERVER_LABEL="app.openagi.imessage-server"
BRIDGE_PLIST="${HOME}/Library/LaunchAgents/${BRIDGE_LABEL}.plist"
SERVER_PLIST="${HOME}/Library/LaunchAgents/${SERVER_LABEL}.plist"

if [[ "${1:-install}" == "uninstall" ]]; then
  for p in "${BRIDGE_PLIST}" "${SERVER_PLIST}"; do
    [[ -f "$p" ]] && launchctl bootout "${GUI}" "$p" 2>/dev/null || true
    rm -f "$p" && echo "Removed $(basename "$p")" || true
  done
  exit 0
fi

[[ -n "${NODE_BIN}" ]] || { echo "ERROR: node not found. Install Node 22+ or set OPENAGI_NODE_BIN." >&2; exit 1; }
[[ -f "${BIN}" ]] || { echo "ERROR: ${BIN} not found. Set OPENAGI_DIR to your openAGI checkout." >&2; exit 1; }
mkdir -p "$(dirname "${BRIDGE_PLIST}")" "${LOG_DIR}"

# Build the bridge argument array.
bridge_args=("imessage-bridge" "--respond" "${IMESSAGE_RESPOND:-all}")
[[ -n "${IMESSAGE_ALLOW:-}" ]]   && bridge_args+=("--allow" "${IMESSAGE_ALLOW}")
[[ -n "${IMESSAGE_ALLOW_CHATS:-}" ]] && bridge_args+=("--allow-chat" "${IMESSAGE_ALLOW_CHATS}")
[[ -n "${IMESSAGE_TRIGGER:-}" ]] && bridge_args+=("--trigger" "${IMESSAGE_TRIGGER}")
[[ -n "${IMESSAGE_CAPTURE:-}" ]] && bridge_args+=("--capture" "${IMESSAGE_CAPTURE}")

emit_plist() {  # $1 label, $2 logname, then ProgramArguments after node+bin
  local label="$1"; local logname="$2"; shift 2
  local args_xml=""
  for a in "$@"; do args_xml+="    <string>${a}</string>"$'\n'; done
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${BIN}</string>
${args_xml}  </array>
  <key>WorkingDirectory</key><string>${OPENAGI_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "${NODE_BIN}"):/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>OPENAGI_IMESSAGE_NODE_TOKEN</key><string>${IMESSAGE_NODE_TOKEN:-}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${LOG_DIR}/${logname}.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/${logname}.log</string>
</dict>
</plist>
EOF
}

emit_plist "${BRIDGE_LABEL}" "imessage-bridge" "${bridge_args[@]}" > "${BRIDGE_PLIST}"
launchctl bootout "${GUI}" "${BRIDGE_PLIST}" 2>/dev/null || true
launchctl bootstrap "${GUI}" "${BRIDGE_PLIST}"
echo "Installed ${BRIDGE_LABEL} (respond=${IMESSAGE_RESPOND:-all}, capture=${IMESSAGE_CAPTURE:-none})."

if [[ -n "${IMESSAGE_NODE_TOKEN:-}" ]]; then
  emit_plist "${SERVER_LABEL}" "imessage-server" \
    "imessage-server" "--token" "${IMESSAGE_NODE_TOKEN}" "--port" "${IMESSAGE_NODE_PORT:-43298}" > "${SERVER_PLIST}"
  launchctl bootout "${GUI}" "${SERVER_PLIST}" 2>/dev/null || true
  launchctl bootstrap "${GUI}" "${SERVER_PLIST}"
  echo "Installed ${SERVER_LABEL} (search service on :${IMESSAGE_NODE_PORT:-43298})."
fi

echo
echo "⚠  Full Disk Access required to read chat.db. Add this binary in"
echo "   System Settings → Privacy & Security → Full Disk Access:"
echo "     ${NODE_BIN}"
echo "   then: launchctl kickstart -k ${GUI}/${BRIDGE_LABEL}"
[[ -n "${IMESSAGE_NODE_TOKEN:-}" ]] && echo "          launchctl kickstart -k ${GUI}/${SERVER_LABEL}"
echo "   Logs: ${LOG_DIR}/imessage-bridge.log"
