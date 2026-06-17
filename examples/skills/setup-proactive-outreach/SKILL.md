---
name: setup-proactive-outreach
description: Guide configuring proactive outreach so the main reaches out (digest + live decisions) and the Mac app surfaces it with notifications, an overlay list, and inline buttons.
---

Walk the user through turning on proactive outreach: the main (the brain) already DETECTS work (suggestions, drafts, stalled tasks, decisions); this makes it durably SURFACE that to them instead of piling up unseen. Produce copy-pasteable steps; substitute `<main-host>`, `<port>` (default `43210`), `<token>`, and `<bundle-id>`. Never paste a real token into a shared place — treat it like a password.

## 1. (Optional) Configure cadence + quiet hours on the MAIN

Defaults work out of the box (digest every 3h, quiet 22:00–08:00, stalled = 3 days). To tune, create `<dataDir>/outreach.json` on the main (default `<dataDir>` is `~/.openagi`):

```json
{
  "enabled": true,
  "destination": "mac",
  "cadenceHours": 3,
  "quietHours": { "start": "22:00", "end": "08:00" },
  "stalledDays": 3,
  "liveTypes": ["stalled-task", "pending-action", "clarification"],
  "digestTypes": ["draft", "suggestion"]
}
```

- `liveTypes` ping immediately (subject to quiet hours); `digestTypes` are batched into the periodic digest. Move an item type between them to change how loud it is.
- Env overrides: `OPENAGI_OUTREACH_CADENCE_HOURS`, `OPENAGI_OUTREACH_STALLED_DAYS`, `OPENAGI_OUTREACH_DISABLED=1`.
- Restart the main after editing so it reloads config (`openagi update`/restart, or restart the daemon).

The main starts durably recording every proactive event into `<dataDir>/outreach/` immediately — nothing is lost even when no client is connected.

## 2. Make the main reachable from the Mac

The Mac app pulls the feed over HTTP from the main. The main must be reachable at `http://<main-host>:<port>` from the Mac and serving with a bearer token set (`OPENAGI_AUTH_TOKEN`). `<main-host>` is whatever routes to the main — a LAN IP, `something.local`, or a Tailscale MagicDNS name / `100.x` address. Confirm:

```sh
curl -s -H "Authorization: Bearer <token>" http://<main-host>:<port>/outreach/feed | head -c 200
```

If that times out (vs. returns JSON), it's a connectivity/firewall problem, not an outreach problem — open the API port to the network the Mac uses (e.g. allow `<port>` on the main's firewall / Tailscale interface), and make sure no second VPN on the Mac is capturing traffic.

## 3. Point the Mac app at the main

The app reads the remote main from its preferences (a settings field is the goal; until then use `defaults`):

```sh
defaults write <bundle-id> outreachRemoteURL "http://<main-host>:<port>"
defaults write <bundle-id> outreachToken "<token>"
```

`<bundle-id>` is `CFBundleIdentifier` from `mac/Resources/Info.plist`. Restart the app — on launch it starts the consumer, backfills everything pending, then streams live.

## 4. Verify

- Open the overlay (the floating pill): it should backfill the main's pending queue (drafts, suggestions, stalled tasks) — not just new items.
- A live decision (a stalled task or an action needing approval) fires a notification with inline buttons (Close it / Keep, Approve / Dismiss, Do it / Not now).
- Tapping a button resolves it on the main; re-check `GET /outreach/feed` — the item shows `status: "acted"`.
- Typing a reply in the overlay routes through `/outreach/<id>/reply` and the agent interprets it.
- During quiet hours, live decisions don't banner — they wait in the overlay and roll into the next digest.

## Notes to pass along

- **Lossless:** delivery rides a cursor-indexed feed (`?since=<cursor>`), so closing the laptop for hours loses nothing — the app re-pulls everything missed on reconnect.
- **Local vs main:** the menubar app still runs its OWN local daemon for screen capture etc.; this only routes the OUTREACH feed to the remote main. Full "app points entirely at a remote main" is separate, in-progress work.
- **Connectivity caveat:** if the Mac↔main link drops (e.g. a VPN clobbers Tailscale), the consumer shows nothing new but loses nothing — it backfills on reconnect.
- **Telegram/iMessage:** `destination` is `mac` today; other transports are a planned drop-in (the engine is channel-agnostic).

User asked: {{input}}
