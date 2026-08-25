# Roadmap

Tracking near-term items not yet shipped. Each item lists what's already wired, what's missing, and the rough effort.

---

## Recently shipped (v0.0.11)

- **Nodes view.** Every machine in the installation, with liveness derived at read time rather than replayed from a cached verdict. Machines that do work without being full installs — an iMessage pass-through with no daemon and no heartbeat — appear as service nodes, probed live against a budget that can never hold the page.
- **Daily brief.** A single surface for what changed, with dismissible advice and readable drafts, degrading honestly when a source is unavailable instead of rendering an empty confident page.
- **Multi-horizon workflow mining.** Candidates carry action keys, day/week horizons and a cadence classification, so a weekly routine is no longer indistinguishable from noise. Mining runs hourly with a nightly deep pass; materialized skills retain the observation that produced them.
- **Security.** Path traversal, dashboard XSS and MCP argv injection closed; `/health` no longer over-discloses; the data directory and SQLite files are tightened to owner-only on every boot.
- **Privacy.** Ambient capture honours exclusions for non-frontmost windows, and the README no longer claims data never leaves — prompts go to your LLM, and the docs now say so before asking for Screen Recording.
- **Bounded growth.** Observation retention is scheduled rather than unbounded, after a capture directory reached 1.2GB unattended.

---

## Remote capture streaming (multi-machine setup)

**Status:** Mostly shipped as of v0.0.11 · one real gap left

**Idea:** Run the daemon (the agent itself) on one machine — typically a home Mac mini that's always on — and stream screen captures + activity events from any number of laptops/desktops to that central daemon. Use OpenAGI from your work laptop, your couch laptop, your gaming desktop; the agent on the Mac mini sees them all and answers "what was I doing on the work laptop yesterday at 3pm" alongside "what was I doing on the home Mac last weekend".

### What's already wired

- The Mac app's `CaptureBridge` (`mac/Sources/OpenAGI/Capture/CaptureBridge.swift`) already POSTs batched observations + frames to `/observations` over HTTP with bearer auth. The daemon's `/observations` endpoint accepts these from any source as long as the auth token matches.
- The daemon's observation store (`src/observation-store.js`) treats every observation the same regardless of source — they all flow into the same FTS5 index.
- Bearer auth (`OPENAGI_AUTH_TOKEN`) plus the CSRF gate (`auth.js#checkOrigin`) already secures the endpoint against random network traffic.
- `cloudflared` / `ngrok` tunneling is already supported via `npm run tunnel`, exposing `127.0.0.1:43210` on a public URL.

Shipped since this item was written:

- **Configurable capture destination.** `AppState.captureRemoteURL` + `captureRemoteToken` replace the old hardcoded `127.0.0.1:43210` in the capture path. The token rule is deliberate: when a remote destination is set, only the remote-scoped token is ever sent — the local daemon's own token authenticates to `127.0.0.1` and is never forwarded to another host, so a missing remote token yields an unauthenticated request rather than a leaked one.
- **Per-source attribution.** `sourceMachineId` is carried on every observation (per-observation, falling back to a per-batch value) through `observation-store.js`, so recall can distinguish machines.
- **Node identity, pairing and heartbeats.** Each install generates a stable identity; whichever install receives heartbeats acts as the main and keeps a file-backed registry of the rest.
- **Connection health UX.** The Nodes view reports liveness derived from `lastSeenAt` at read time — never a stored or replayed verdict — and says `unknown` when there is no usable timestamp rather than guessing. Service machines that never heartbeat (like an iMessage pass-through) are probed live against a budget and shown as their own kind.

### What's still missing

- **Capture-only client mode** for the Mac app: a launch flag (or settings panel toggle) that says "I'm a capture client, not a daemon host." In this mode, the bundled Node daemon doesn't start; only the capture pipeline runs, pointed at a remote daemon URL. This is the remaining gap — today every Mac app instance still starts its own bundled daemon, so a laptop pointed at a home Mac mini runs a second daemon it doesn't need.
- **Exponential backoff on a flaky link.** Captures are persisted locally and marked pushed only on success, so a laptop suspending mid-flush doesn't lose data. What's missing is backoff: retries are still paced by the flush interval rather than backing off when a remote is down.

### Effort

Most of the original estimate is spent. What's left is **~1 day**: a settings toggle that suppresses the bundled daemon, plus backoff on the flush retry.

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

## BuildBetter task synchronization

**Status:** Discovery complete · API support needed for reliable two-way sync

OpenAGI already imports BuildBetter call action items into its local task
store, and can reuse an existing BuildBetter MCP OAuth connection. BuildBetter's
Tasks screen, however, is backed by the separate Success follow-up queue. The
current integration does not read or update that queue.

BuildBetter's existing REST surface is enough for an experimental snapshot
import and basic create/update/complete actions. Production-grade two-way sync
still needs a general task contract with:

- paginated list, search, single-item lookup, and an incremental sync cursor;
- stable external references and idempotent creates so retries cannot duplicate
  work;
- versioned updates for conflict detection;
- archive, restore, and deletion tombstones;
- timestamps, provenance, and source references in public responses; and
- transactional webhook events for task lifecycle changes.

REST should be the background synchronization plane. Equivalent MCP tools can
then provide interactive list/get/create/update/complete/archive/restore
operations using the same authorization and task semantics. Reconciliation must
also recognize when a Success task and an imported call action item share the
same source, or the two existing BuildBetter task paths will create duplicates.

Open question: Success follow-ups currently belong to a company or person,
whereas OpenAGI tasks may be workspace-wide. The public contract must either
support workspace-scoped tasks or explicitly preserve that account-only
constraint.

## Computer Use

**Status:** Native Mac execution and paired-node relay implemented locally

OpenAGI now has a provider-neutral Computer Use tool set rather than a
provider-specific prompt convention. It includes an explicit, human-approved
session boundary; live action and reasoning logs; a kill switch; screen reads;
and semantic Accessibility state; safe app listing/activation; element or
coordinate clicks (including double-click); drag; type; clipboard-restoring
plain-text, Markdown, or HTML paste; exact value setting and text selection;
exposed secondary Accessibility actions; key; move; and element or coordinate
scroll actions through a node-scoped authenticated relay. When
no node is reachable, screen inspection falls back to recent local OCR and
input calls fail explicitly instead of reporting fake success.

The dashboard reports four distinct readiness states (`disabled`,
`observe-only`, `node-unreachable`, and `control-ready`) and provides a safe
Try in Chat prompt. The main agent is told to start Computer Use only after an
explicit user request, to inspect before acting, and to end the session when
done. Passive screen capture never authorizes control.

The desktop app now bundles a signed CGEvent input helper. A paired node keeps
an authenticated outbound control poll open to its main, so it needs no
inbound service port and the main never trusts a node-supplied URL. The legacy
`openagi computer-server` remains available as an explicit loopback-first
fallback. The execution contract is:

- Screen Recording gates screenshots; Accessibility gates input.
- A visible session-level approval is required before the first action.
- Password fields, secure-input state, excluded apps/windows, and permission
  uncertainty fail closed.
- Every requested action records redacted intent, coordinates/keys, and a
  categorical result. Typed, pasted, assigned, or selected content and its
  free-form rationale are never persisted. Stop immediately rejects queued/new work and kills a local helper;
  a paired node action already executing remains bounded by the native helper
  timeout and is revoked before another action can run.
- Image dimensions, display scale, and a bounded Accessibility tree are part of
  the observation/action loop. Element locators never leave the selected node;
  they are bound to one short-lived screenshot frame, and each action is
  followed by a fresh observation before another action.
- Local execution stays local; remote nodes use a scoped credential and never
  receive provider or integration secrets.

Native scrolling and drag use CGEvent. Drag cancellation always releases the
mouse button, even if focus or readiness changes during movement. Every
coordinate action is bound to a recent screenshot frame, and node leases
enforce the approved goal, selected node, expiry, monotonic sequence, action
limit, and idempotent action id.

An optional Cua Driver backend is available for users who already operate a
reviewed Cua installation. Set `OPENAGI_COMPUTER_BACKEND=cua` and
`OPENAGI_CUA_DRIVER_PATH` to the absolute executable path on that Mac. OpenAGI
does not download, install, update, or expose Cua's MCP tools directly: all Cua
actions stay behind the same OpenAGI approval, fresh-frame, lease, Stop,
redaction, and node-authentication boundary. The current reviewed Cua adapter
advertises coordinate-only capability and is therefore reported as partial,
not control-ready, until it can execute the complete semantic contract. The
signed OpenAGI helper remains the default. Cua's experimental Computer History preview is separate and is
not treated as ambient screen history: it records metadata only for actions
performed through Cua Driver.

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
