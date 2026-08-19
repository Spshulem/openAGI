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

The CLI follows that model. The Mac app still starts a local companion runtime
for host-specific work such as capture and physical computer actions, so its
local provider status remains independent from the main. Once paired and
enrolled, that companion advertises ready capabilities to the main over an
authenticated outbound connection; provider keys are not copied to it. Raw
provider-key replication would create another agent, scheduler, and spend
ledger rather than a node.

The main's bearer token is used only for the initial enrollment. The node then
retains a revocable, node-scoped credential in `<dataDir>/node.json` and erases
the broader pairing credential after enrollment is confirmed. Pair only devices
you trust and protect that file like any other credential file.

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

`--host 0.0.0.0` makes it reachable from your LAN, but bearer authentication
does not encrypt the connection. Put the main behind HTTPS before pairing a
different device. The CLI rejects plain HTTP remote pairing by default; HTTP
remains available on loopback for same-machine development only.

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

Expose it through an authenticated HTTPS reverse proxy or encrypted tunnel and
use that HTTPS origin as the remote below. `npm run tunnel` can start a
cloudflared tunnel for development; use a stable, access-controlled endpoint
for an always-on node.

## 2. Point a node at the main

On your laptop (or any device with the CLI), enter the initial pairing token
through a hidden shell prompt so it never appears in argv or shell history:

```bash
printf 'Main pairing token: ' >&2
IFS= read -rs OPENAGI_REMOTE_TOKEN; printf '\n' >&2
export OPENAGI_REMOTE_TOKEN
openagi pair https://main.example.com
unset OPENAGI_REMOTE_TOKEN

openagi doctor      # verifies it can reach + auth the main
openagi chat        # interactive — talks to the main, uses ITS integrations
openagi status
```

`pair` saves `<dataDir>/node.json`. Undo with `openagi unpair`. You can also set
the target ad hoc with `--remote https://…` or `OPENAGI_REMOTE`; supply secrets
through `OPENAGI_REMOTE_TOKEN`, not a command-line argument.

Pairing and unpairing ask a reachable local daemon to follow its normal restart
path so in-memory routing matches the saved state. Supervised installations
start again automatically; a bare `openagi serve` process must be started again
manually. If the daemon is already stopped, it loads the change on its next
start. If a running daemon cannot accept the restart, the CLI reports that
explicitly instead of claiming the change is active. Switch mains by unpairing
first. A long-running iMessage relay also refuses a target override that
conflicts with its confirmed saved pairing.

Target precedence: `--remote` flag → `OPENAGI_REMOTE` env → saved pairing →
local daemon. `openagi update` is the deliberate exception: without an explicit
`--remote`, it always updates the installation on the device where it is run.

## 3. The Mac app as a node

The Mac menubar app runs a local companion daemon because Screen Recording,
Accessibility, iMessage database access, and signed input helpers must stay on
that Mac. Pair and enroll the installation as above; its outbound worker then
reports only generic capability/status data and accepts scoped work from the
main. Local-only dashboard and capture state still belong to the companion and
should not be mistaken for a copy of the main's memory or credentials.

## Commands

| Command | What |
|---|---|
| `openagi serve [--host H] [--port P]` | run the daemon (the main) |
| `openagi chat [message]` | message the target; REPL if no message |
| `openagi status` | health, provider, memory, task counts |
| `openagi doctor` | diagnose setup/connection, print fixes |
| `openagi setup` | print the dashboard/setup URL + token |
| `openagi update [--check]` | fast-forward this device's checkout + restart (or just check) |
| `openagi pair <https-url>` / `unpair` | enroll with / forget a remote main; read the pairing secret into `OPENAGI_REMOTE_TOKEN` |
| `openagi tick` | fire a scheduler tick |

Global flags: `--remote <url>`, `--token <token>`, `--json`.

## Keeping it current

The daemon updates itself — no manual `git pull` on the device.

- **Manual:** `openagi update` always updates the installation on the device where it is run, even when that device is paired. Use an explicit `openagi update --remote https://main.example.com` (with the admin credential supplied through `OPENAGI_REMOTE_TOKEN`) only when you intend to update another main. `openagi update --check` follows the same targeting rule. Updates are fast-forward only — they never clobber local commits.
- **Automatic (opt-in):** set `OPENAGI_AUTO_UPDATE=1` (and optionally `OPENAGI_AUTO_UPDATE_AT=HH:MM`, default `04:30`) in the main's `.env`. A daily cron job checks for updates and applies + restarts when one ships. Off by default; visible/toggleable in the dashboard's Cron tab.

Both rely on the supervisor (systemd `Restart=always`, launchd, or the Mac app) to respawn after the update — which the install scripts already configure.
