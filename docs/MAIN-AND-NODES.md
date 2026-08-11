# Main + nodes: run OpenAGI as a hub

OpenAGI's daemon is a headless HTTP server. You can run it on a small always-on
box (a Raspberry Pi, a [Pamir Distiller](https://shop.pamir.ai/), a home
server) as the **main** — the brain that holds every integration, all memory,
the MCP connections, the scheduler — and point your laptop, phone, or other
machines at it as thin **nodes**.

You configure integrations **once**, on the main. Nodes don't need any keys.

### Configure once does not mean copying `.env`

Provider and integration credentials belong on the main. A thin node sends its
work to the main and never receives the OpenAI, Anthropic, search, messaging, or
MCP secrets stored there. Host-specific values (data directories, listen
addresses, capture permissions, iMessage paths, and update preferences) stay on
the machine they configure.

The CLI already follows that model. The Mac app does not yet: as documented
below, it still starts a complete local runtime, so its local provider status is
independent from the main. Do not work around that by copying the main's `.env`
to the Mac. The durable Mac-node design is a thin remote mode with a scoped
per-node credential; raw provider-key replication would create another agent,
another scheduler, and another independent spend ledger.

Until scoped node credentials land, the saved pairing token has the same power
as the main's bearer token. Pair only devices you trust and protect
`<dataDir>/node.json` like any other credential file.

```
   ┌──────────── main (always-on host) ───────────┐
   │  openagi serve --host 0.0.0.0               │
   │  • all API keys / MCP / task sources        │
   │  • memory, scrutiny, propagation, cron      │
   └──────────────────────────────────────────────┘
        ▲                ▲                  ▲
   openagi chat     Mac (screen        phone / SSH
   from laptop      capture → main)    `openagi chat`
```

## 1. Install on the main (over SSH)

The main needs Node 22+. Clone the repo (or copy it over), then:

```sh
# on the device
cd openAGI
npm link            # puts `openagi` on PATH (or: npm i -g .)
openagi serve --host 0.0.0.0
```

`--host 0.0.0.0` makes it reachable from your LAN. The HTTP interface enforces a
bearer token, so this is safe **once setup is done** — `serve` warns if you bind
to the network with no token set.

Finish setup from any device with a browser:

```sh
openagi setup     # prints the wizard URL, e.g. http://main-host.local:43210/setup
```

Open that URL, add a model key, and (the point of this topology) connect your
integrations here — Linear, BuildBetter, calendar, MCP servers. Save the auth
token the wizard shows; nodes need it.

### Keep it running

```sh
sudo ./scripts/install-systemd.sh        # auto-start on boot, restart on crash
# the unit runs `examples/hosted-server.js`; set HOST=0.0.0.0 in <dataDir>/.env
journalctl -u openagi -f                  # logs
```

To expose it beyond your LAN (reach it from your phone on cellular), run a
tunnel on the main: `npm run tunnel` (cloudflared) and use the printed URL as
the remote below.

## 2. Point a node at the main

On your laptop (or any device with the CLI):

```sh
openagi pair http://main-host.local:43210 --token <the-main's-auth-token>
openagi doctor      # verifies it can reach + auth the main
openagi chat        # interactive — talks to the main, uses ITS integrations
openagi status
```

`pair` saves `<dataDir>/node.json`. Undo with `openagi unpair`. You can also set
it ad-hoc per command (`--remote http://… --token …`) or via env
(`OPENAGI_REMOTE`, `OPENAGI_REMOTE_TOKEN`).

Target precedence: `--remote` flag → `OPENAGI_REMOTE` env → saved pairing →
local daemon.

## 3. The Mac app as a node

> Status: the Mac menubar app currently always runs its own local daemon. Pointing
> it at a remote main (so screen-capture observations and Quick Ask feed the
> main, and the dashboard shows the main's state) is the next piece — see
> the "remote main" setting work in progress. Until then, the **CLI** is the way
> to use a node; the Mac app stays a self-contained local install.

## Commands

| Command | What |
|---|---|
| `openagi serve [--host H] [--port P]` | run the daemon (the main) |
| `openagi chat [message]` | message the target; REPL if no message |
| `openagi status` | health, provider, memory, task counts |
| `openagi doctor` | diagnose setup/connection, print fixes |
| `openagi setup` | print the dashboard/setup URL + token |
| `openagi update [--check]` | fast-forward the checkout + restart (or just check) |
| `openagi pair <url> [--token T]` / `unpair` | save / forget a remote main |
| `openagi tick` | fire a scheduler tick |

Global flags: `--remote <url>`, `--token <token>`, `--json`.

## Keeping it current

The daemon updates itself — no manual `git pull` on the device.

- **Manual:** `openagi update` (locally or `--remote` against the main) fast-forwards the git checkout, reinstalls deps if `package.json` changed, and restarts with the new code. `openagi update --check` just reports whether a newer version is available. Fast-forward only — it never clobbers local commits.
- **Automatic (opt-in):** set `OPENAGI_AUTO_UPDATE=1` (and optionally `OPENAGI_AUTO_UPDATE_AT=HH:MM`, default `04:30`) in the main's `.env`. A daily cron job checks for updates and applies + restarts when one ships. Off by default; visible/toggleable in the dashboard's Cron tab.

Both rely on the supervisor (systemd `Restart=always`, launchd, or the Mac app) to respawn after the update — which the install scripts already configure.
