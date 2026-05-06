#!/usr/bin/env bash
# Spin a public tunnel to the local OpenAGI daemon (default port 43210).
# Tries cloudflared first (free, ephemeral *.trycloudflare.com URL, no account
# needed), then falls back to ngrok if cloudflared isn't installed.
#
# Usage:
#   ./scripts/tunnel.sh            # auto-pick whichever is installed
#   ./scripts/tunnel.sh cloudflare # force cloudflared
#   ./scripts/tunnel.sh ngrok      # force ngrok
#
# After the tunnel is up:
#   1. Copy the public URL it prints (e.g. https://abc123.trycloudflare.com).
#   2. Set OPENAGI_PUBLIC_URL=<that URL> in .openagi/.env and restart the daemon
#      (so Twilio signature verification can reconstruct the canonical URL).
#   3. Paste <URL>/channels/twilio/webhook into your Twilio number's
#      "A message comes in" webhook field.
#   4. (Optional) For Telegram, register the webhook with:
#        curl -F "url=<URL>/channels/telegram/webhook" \
#             -F "secret_token=$TELEGRAM_WEBHOOK_SECRET" \
#             "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook"
#
set -euo pipefail

PORT="${PORT:-43210}"
HOST="${HOST:-127.0.0.1}"
CHOICE="${1:-auto}"

run_cloudflared() {
  echo "▶ Cloudflare quick tunnel → http://${HOST}:${PORT}"
  echo "  (free, ephemeral subdomain — for a stable URL, set up a named tunnel)"
  echo
  exec cloudflared tunnel --url "http://${HOST}:${PORT}"
}

run_ngrok() {
  echo "▶ ngrok tunnel → http://${HOST}:${PORT}"
  echo "  (free tier rotates the URL per restart; sign in with an authtoken for a stable subdomain on a paid plan)"
  echo
  exec ngrok http "${HOST}:${PORT}"
}

case "${CHOICE}" in
  cloudflare|cloudflared|cf)
    command -v cloudflared >/dev/null 2>&1 || { echo "cloudflared not installed. Install with: brew install cloudflared" >&2; exit 1; }
    run_cloudflared
    ;;
  ngrok)
    command -v ngrok >/dev/null 2>&1 || { echo "ngrok not installed. Install with: brew install ngrok" >&2; exit 1; }
    run_ngrok
    ;;
  auto|*)
    if command -v cloudflared >/dev/null 2>&1; then
      run_cloudflared
    elif command -v ngrok >/dev/null 2>&1; then
      run_ngrok
    else
      cat >&2 <<EOF
No tunnel client installed. Install one of:
  brew install cloudflared    # recommended (no account needed)
  brew install ngrok          # alternative (free, rotating URL)

Then re-run: ./scripts/tunnel.sh
EOF
      exit 1
    fi
    ;;
esac
