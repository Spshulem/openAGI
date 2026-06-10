# Remote channels: Twilio SMS + Telegram + tunnel

How to take the local-only daemon and make it reachable from the outside world so SMS and Telegram inbound webhooks actually fire — and proactive sends from autopilot pulses or `send_message` actually leave your machine.

This guide assumes the daemon is up at `http://127.0.0.1:43210/` and `OPENAGI_AUTH_TOKEN` is set (see [auth in README](../../README.md#auth)).

## Step 1 — Public tunnel

Pick one. Both are free for ephemeral URLs.

### Option A: Cloudflare quick tunnel (recommended, no account)

```bash
brew install cloudflared
npm run tunnel
```

You'll see something like:

```
▶ Cloudflare quick tunnel → http://127.0.0.1:43210
…
2026-05-06T20:30:42Z INF +-------------------------------------------------------+
2026-05-06T20:30:42Z INF |  Your quick Tunnel has been created! Visit it at:     |
2026-05-06T20:30:42Z INF |  https://abc-def-ghi.trycloudflare.com               |
2026-05-06T20:30:42Z INF +-------------------------------------------------------+
```

Copy that URL. It rotates per `cloudflared` restart, which is fine for testing. For a stable subdomain you'd set up a [named Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) with your own domain.

### Option B: ngrok (free tier, rotating URL)

```bash
brew install ngrok
ngrok config add-authtoken <your token>
npm run tunnel ngrok
```

Same deal — copy the `https://*.ngrok-free.app` URL.

## Step 2 — Tell the daemon its public URL

This is required for Twilio signature verification (Twilio computes the HMAC over the URL it dialed, and the daemon must reconstruct the same URL).

In `~/.openagi/.env`:

```
OPENAGI_PUBLIC_URL=https://abc-def-ghi.trycloudflare.com
```

Restart the daemon:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/app.openagi.daemon.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.openagi.daemon.plist
```

Or if you're running it foreground: kill + `npm run serve`.

## Step 3 — Twilio (inbound + outbound SMS)

You need a Twilio account, a phone number, and these three keys.

### 3a. Drop creds into `~/.openagi/.env`

```
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+15551234567
```

### 3b. Configure the inbound webhook in Twilio

In the [Twilio console](https://console.twilio.com) → Phone Numbers → Manage → your number → **Messaging Configuration**:

- **A message comes in**: `Webhook`
- URL: `https://abc-def-ghi.trycloudflare.com/channels/twilio/webhook`
- HTTP method: `POST`

Save.

### 3c. Test inbound

Text your Twilio number from your phone:

> remember that my flight to SF is May 14 at 8am

You should see the agent's reply come back as an SMS, and the message + reply land in `/sessions` (visible in the dashboard's Chat tab).

### 3d. Test outbound

In the dashboard's Channels tab, use the **Send SMS test** form, or:

```bash
curl -s -H "authorization: Bearer $OPENAGI_AUTH_TOKEN" \
  -X POST http://127.0.0.1:43210/channels/sms/send \
  -H 'content-type: application/json' \
  -d '{"to":"+15555550123","text":"Hi from OpenAGI"}'
```

### 3e. Schedule a daily SMS check-in

```bash
curl -s -H "authorization: Bearer $OPENAGI_AUTH_TOKEN" \
  -X POST http://127.0.0.1:43210/cron \
  -H 'content-type: application/json' \
  -d '{
    "task":"prompt",
    "name":"morning-brief",
    "dailyAt":"08:00",
    "input":{
      "prompt":"Run skill_morning_brief and summarize.",
      "channel":"sms",
      "target":"+15555550123",
      "agentId":"main"
    }
  }'
```

Or use the Schedule tab in the UI.

## Step 4 — Telegram (optional)

### 4a. Get a bot token

Talk to [@BotFather](https://t.me/BotFather), `/newbot`, copy the token.

### 4b. Set creds

In `~/.openagi/.env`:

```
TELEGRAM_BOT_TOKEN=12345:ABC...
TELEGRAM_WEBHOOK_SECRET=<some random string you choose>
```

Restart the daemon.

### 4c. Register the webhook

```bash
curl -F "url=https://abc-def-ghi.trycloudflare.com/channels/telegram/webhook" \
     -F "secret_token=$TELEGRAM_WEBHOOK_SECRET" \
     "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook"
```

### 4d. Test

DM your bot. You should get a reply.

(Or skip the webhook entirely by setting `TELEGRAM_POLLING=1` in env — the daemon will long-poll Telegram on startup. Useful when you can't tunnel.)

## Step 5 — Make it persist across reboots

```bash
npm run install-launchd
```

Verifies and installs a `launchd` agent that auto-starts at login and restarts on crash. The plist is at `~/Library/LaunchAgents/app.openagi.daemon.plist`. Logs at `.openagi/launchd.{out,err}.log`.

To stop:

```bash
npm run install-launchd uninstall
```

## Verification checklist

- [ ] `curl https://<tunnel>/health` returns 200.
- [ ] `OPENAGI_PUBLIC_URL` is set in `~/.openagi/.env` and the daemon was restarted after.
- [ ] Twilio console webhook points at `<tunnel>/channels/twilio/webhook`.
- [ ] Texting your Twilio number triggers a TwiML reply.
- [ ] `/channels` in the dashboard shows `outboundConfigured: true`.
- [ ] `/audit` no longer reports "Twilio outbound not configured".

## Troubleshooting

- **403 on inbound Twilio**: Twilio signature check failed. Most common cause — `OPENAGI_PUBLIC_URL` doesn't match the URL Twilio actually called. Set it to the exact tunnel URL and restart.
- **Cloudflare URL changes every restart**: that's the quick-tunnel mode. Either restart the daemon + update Twilio webhook each time (annoying), or set up a named Cloudflare Tunnel against your own domain.
- **Tunnel shows up but daemon returns 401 in browser**: that's auth working as intended. Visit `<tunnel>/?token=<your OPENAGI_AUTH_TOKEN>` once to set the cookie.
- **Telegram webhook 401**: secret_token didn't match `TELEGRAM_WEBHOOK_SECRET`. Re-call `setWebhook` with the right value.
