# Roadmap

Tracking near-term items not yet shipped. Each item lists what's already wired, what's missing, and the rough effort.

---

## Remote capture streaming (multi-machine setup)

**Status:** Coming soon · plumbing partially in place

**Idea:** Run the daemon (the agent itself) on one machine — typically a home Mac mini that's always on — and stream screen captures + activity events from any number of laptops/desktops to that central daemon. Use OpenAGI from your work laptop, your couch laptop, your gaming desktop; the agent on the Mac mini sees them all and answers "what was I doing on the work laptop yesterday at 3pm" alongside "what was I doing on the home Mac last weekend".

### What's already wired

- The Mac app's `CaptureBridge` (`mac/Sources/OpenAGI/Capture/CaptureBridge.swift`) already POSTs batched observations + frames to `/observations` over HTTP with bearer auth. The daemon's `/observations` endpoint accepts these from any source as long as the auth token matches.
- The daemon's observation store (`src/observation-store.js`) treats every observation the same regardless of source — they all flow into the same FTS5 index.
- Bearer auth (`OPENAGI_AUTH_TOKEN`) plus the CSRF gate (`auth.js#checkOrigin`) already secures the endpoint against random network traffic.
- `cloudflared` / `ngrok` tunneling is already supported via `npm run tunnel`, exposing `127.0.0.1:43210` on a public URL.

### What's still missing

- **Capture-only client mode** for the Mac app: a launch flag (or settings panel toggle) that says "I'm a capture client, not a daemon host." In this mode, the bundled Node daemon doesn't start; only the capture pipeline runs, pointed at a remote daemon URL.
- **Configurable daemon URL.** Today both `CaptureBridge.swift:33` and `AppState.swift:14` hardcode `http://127.0.0.1:43210`. Need a settings field for the remote daemon URL + the auth token, persisted in UserDefaults.
- **Per-source attribution.** Each observation needs a `sourceMachineId` so recall queries can filter by machine ("what was I doing on the laptop") or aggregate across all machines. Schema migration in `observations/index.db`.
- **Connection health UX.** Capture client needs to show "connected to homemini.local:43210" or "offline, queueing 47 observations" in the menu bar. The existing `tunnelWatcher` plumbing is a model.
- **Robustness for flaky networks.** Right now `CaptureBridge` retries inline on flush. A more durable queue with exponential backoff + offline persistence would handle a laptop suspending mid-flush.

### Effort

Rough estimate: **3–5 days** for v0 if we keep it simple (settings panel + URL field + source attribution column). Could be done in a long weekend.

### Why it's worth doing

The agent's value compounds with how much of your activity it sees. Right now if you do half your work on a laptop and half on a desktop, the agent only knows about whichever one runs the daemon. Centralizing capture means the proactive "I noticed a routine" surfaces span all your machines, the patterns that emerge are richer, and you don't need to keep multiple agents in sync (which is its own cancerous-multiplication problem — see [`WHITEPAPER.md`](../WHITEPAPER.md) on propagation).

---

## reMarkable: covered by the inbox watcher today

A direct reMarkable connector (PDF generation + Dropbox upload + Vision
OCR for round-trip checkmark sync) is not currently shipped. We
deliberately chose a simpler, more general path: the **inbox watcher**
at `.openagi/inbox/`.

Today's reMarkable flow:

1. Set up your reMarkable Cloud → Dropbox sync
2. Point the Dropbox folder at `~/Library/Application Support/OpenAGI/inbox/`
3. Write tasks on your reMarkable using GitHub-style checkboxes:
   ```
   - [ ] Buy milk
   - [x] Ship release
   TODO: call mom
   ```
4. Sync → file lands in inbox folder → OpenAGI's `InboxWatcher` picks
   it up within 30 seconds → tasks appear in the user queue
5. Files move to `inbox/processed/<timestamp>-<name>` after parsing so
   they don't re-import

Same pattern works for Obsidian, Bear, paper notes scanned via the
Notes app, etc. — anything that ends up as a file.

A "full" reMarkable port (PDF round-trip, Vision OCR for checkmark
detection from annotated pages, ~500 lines + 3 native deps) is on the
list if there's demand, but the inbox approach delivers most of the
value with 130 lines and zero deps.

## Other items currently in the README's roadmap

| Item | Effort | Notes |
|------|--------|-------|
| HTTP / SSE MCP transport (richer than stdio) | ~2 days | stdio is in; HTTP+OAuth is in for inbound; outbound HTTP MCP transport is the gap |
| Specialist routing | ~1 day | Today every message goes to `main`; should route to a specialist if its `boundedScope` matches |
| Embeddings-backed memory search | ~3 days | `vectorStore` exists but is underutilized; current retrieve is keyword-overlap |
| Per-channel delivery policies + retry queues | ~2 days | If a Twilio outbound fails, currently dropped silently; should retry w/ backoff |
| Sparkle auto-update polish — staple the .app inside the DMG too | ~30 min | Today the DMG is stapled but the .app inside isn't; works online, fragile offline |
| Synchronous in-loop org/cultural scrutiny gate | ~1–2 days | Today `scrutiny-judge.js` retunes weights weekly; in-loop policy gate is the diagram-2 ideal |

---

[← back to README](../README.md)
