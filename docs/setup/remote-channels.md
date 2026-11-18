# Remote channels: Sendblue, Telegram and HTTPS

For partner iMessage/SMS, Gmail, Google Calendar and Pebble Index, use the [Connections setup guide](partner-and-integrations.md). The previous Twilio routes were removed; supplying Twilio credentials does not enable SMS.

## Reach the main safely

Keep `OPENAGI_AUTH_TOKEN` configured before exposing the daemon. Set a stable HTTPS `OPENAGI_PUBLIC_URL` for provider webhooks and OAuth callbacks, and keep the daemon running. The dashboard/API require owner authentication; each provider webhook has its own separate authentication. Never give a partner the owner dashboard token.

`npm run tunnel` provides a development tunnel; copy its origin to `OPENAGI_PUBLIC_URL` and restart. When the URL changes, update provider webhooks and OAuth redirect settings too. Keep any tunnel listener pointed at the main daemon's loopback port.

## Phone access without Tailscale

Tailscale is optional. Phones can connect to a main server on the same Wi-Fi, through Tailscale, or through a public HTTPS address. A `*.ts.net` address requires Tailscale to be connected on both the phone and server, with Tailscale DNS enabled; an HTTPS scheme alone does not make a tailnet address public.

For remote access without a VPN, run the main daemon on an always-on home server or VPS. Use a stable HTTPS tunnel or an authenticated HTTPS reverse proxy, keep `OPENAGI_AUTH_TOKEN` enabled, and set `OPENAGI_PUBLIC_URL` to that public origin. Keep the daemon's listener private behind the tunnel or proxy rather than forwarding its plain HTTP port to the internet. The persistent daemon is not a Vercel serverless function.

Generate a phone pairing code on main and use the complete public HTTPS address shown with that code, including any explicit port. Phones use their own enrolled credentials; do not copy the owner token into the phone. Public servers are not announced through Wi-Fi discovery, so paste their address to check the connection. Local-only chat on a supported iPhone does not require a server or Tailscale.

## Telegram owner channel

Create a bot through BotFather, save `TELEGRAM_BOT_TOKEN` in setup, and enable `TELEGRAM_POLLING=1` for long polling without an inbound tunnel. Alternatively register `/channels/telegram/webhook` with Telegram using a configured `TELEGRAM_WEBHOOK_SECRET`; use the same secret when calling Telegram's `setWebhook`.

Request a one-use code through the authenticated `GET /channels/telegram/pairing-code` route, then send `/pair <code>` to the bot. Codes expire in ten minutes. Unknown/unpaired chats are silently ignored; repeated incorrect codes lock pairing for fifteen minutes.

Telegram pairing grants access to the existing owner agent. Use Sendblue partner sharing when another person should have separate memory and restricted tools.

## Check delivery

Inspect `/channels` with owner authentication for configuration state. A configured key or accepted provider request is not proof of a delivered message. Use an explicitly approved test recipient, verify the provider receipt, and check the physical phone. Automated offline QA is available with `npm run qa:capabilities -- --area sharing`.
