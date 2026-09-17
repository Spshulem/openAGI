# BuildBetter for Even Realities G2

This workspace contains the implemented phone-hosted Even Realities G2 plugin. It records in-person audio into a durable BuildBetter recording, shows live captions, follows accessible live meetings, and answers workspace or recording questions through BuildBetter's Quick Agent and configured MCP tools.

## Agents voice mode

### Version 0.4.17: native exit confirmation at root

Double-tap on the paired/unpaired home screen, quiet listening root, or
reconnecting root requests Even's native exit dialog using
`shutDownPageContainer(1)`. Cancelling leaves the app, pairing, history and
listening preferences intact. The phone Exit button follows the same path;
cleanup waits for the native system-exit event. Double-tap on child screens
still means Back, discard, or request-cancellation confirmation as appropriate.
Recent remains available by swiping at home. To pause without exiting during
lifelog, swipe down to Listening controls and tap **Pause listening**, or turn
the microphone off on the phone. Quiet lifelog still shows only the recording dot.
The SDK mode and app state are regression-tested; seeing and cancelling the
native dialog still requires the installed Even app and physical G2 glasses.

### Version 0.4.15: lifelog-aware retry

Retry listening now restores the saved lifelog consent before restarting the
microphone when lifelog is enabled. Previously it only enabled ordinary ambient
listening, leaving retention suspended after an error. Return / resume lifelog
also reuses saved consent when no new participant confirmation is supplied.
It never creates a new grant without confirmation. Expired or unverifiable grants
stay paused with a specific phone status; native G2 background and hidden-phone
startup remain blocked. A blocked start renders Paused, not the Ready home screen,
and inbox refresh does not overwrite the stopped-lifelog state with Tap to ask.
Physical repro still required: trigger a speech interruption, Retry, then verify
the recording dot and a newly saved transcript on main. The initial device-side
interruption reported by the user has not been diagnosed from device logs.

### Version 0.4.14: experimental lock-screen lifelog

Under Listen, enable **Keep listening when phone is locked · experimental**,
select live speech (Nova, not buffered), Quiet listening, and start consented
lifelog while the phone is visible. The separate preference defaults off and
survives reopening; changing main or credentials clears it. Only an already-running
live, quiet session can continue when the phone WebView becomes hidden. No hidden
cold starts, consent renewal, wake-triggered agent calls, or new notifications.
Native G2 background/exit still stops capture: this does not keep the plugin alive
after it is closed or force-quit, and does not bypass OS suspension.

The same speech provider receives audio and the same main receives final text.
Consent expiry, explicit Off, native app exit, a broken speech connection, or eight
seconds without PCM stops capture and clears the recording dot. Checks run before
accepting returning audio as well as on a timer: a suspended timer is not evidence
of recording. Late audio is discarded, not uploaded as a catch-up burst. Unlock
to validate saved consent and resume with a fresh stream. The phone shows audio
received while hidden separately from **Saved on main** transcript acknowledgments.

Hardware acceptance (not yet verified): record a baseline phrase, lock the phone
for five minutes and speak a distinct phrase each minute, then switch to another
phone app. Unlock and verify all phrases in saved lifelog on main, not just a dot.
Also check Off, consent expiry, Bluetooth/network interruption, and force-quit.
No claim of uninterrupted background support: Even's background guide and FAQ
disagree about suspension/network behavior. No main update is needed for this
setting; saved-consent restoration still requires the 0.4.12 main-side change.

### Version 0.4.13: upper-right recording dot

Quiet lifelog places its recording dot in a separate 32 × 32 display container
at (540, 4), near the upper-right corner. The existing full-screen container
remains the sole gesture owner; tap, hold/release, double-tap and swipe behavior
is unchanged. Pause, answers, notices and display sleep clear the indicator;
returning to active quiet lifelog restores it. Display updates are serialized
so an older update cannot leave the recording dot on after pause/sleep.
This layout change needs only a G2 update. The included 0.4.12 consent restoration
still requires the corresponding main update. Physical position, readability
and gestures must be checked on glasses after installing.

### Version 0.4.12: remember enabled lifelog across reopening

**Keep lifelog on** saves the user's preference and the current consent ID and
original expiry in the existing paired-phone store. Backgrounding, closing the
app, and recoverable failures suspend recording without clearing that preference.
On foreground return or a fresh boot after exit/crash, the app checks the saved
grant against the main's authenticated `settings` response before opening the
microphone. No new grant is generated by resuming. Raw audio and unsent transcripts
are not replayed. The checkbox represents enabled preference; status reports
whether the microphone/retention session is actually active.

Explicit Off (including Pause listening or disabling the microphone), consent
withdrawal, disconnect and main/credential changes prevent auto-resumption. The
same four-hour consent expiry still applies, and participant changes require fresh
consent. Expired/revoked/mismatched grants, unavailable mains, and older mains
without grant verification leave the microphone off with a status explanation.
The main must include this PR's scoped consent field in `settings` for automatic
resumption. Install the new client and updated main together. This is foreground
resumption, not background or phone-lock recording. Physical crash/reopen and
foreground-switching tests are still required.

### Version 0.4.11: paced live speech and bounded lifelog recovery

Live PCM is split into at most 640-byte chunks and paced at 32 KB/s, with at
most 100 ms of catch-up credit and a two-second combined audio backlog limit.
Stop drains queued PCM before requesting final words. Invalid frames and stale
queues fail explicitly; incomplete manual questions never auto-send or replay.

A recoverable speech backlog/disconnection during consented lifelog pauses the
microphone, shows **Audio gap · reconnecting**, and starts a fresh stream after
1/2/4-second delays, capped at three reconnect attempts per minute. Activity
records the gap; finalized text already queued for main is preserved, not replayed.
The gap notice is local Activity, not a new durable server gap record. New stream
IDs prevent client-side transcript coalescing across the gap. The first utterance
after recovery is not used for a wake/question trigger because it may be clipped.

Recovery never renews retention consent. Pause, background, exit, consent expiry
or withdrawal, and main/credential changes cancel it. Authentication, malformed
PCM and provider-configuration errors remain explicit failures. Recovery applies
to lifelog, not interrupted manual questions or unconsented wake listening.

The client handles the older main's combined PCM error. The matching optional
main update distinguishes invalid PCM, incoming rate overflow, and provider upload
backlog with machine-readable codes, without weakening limits or authentication.
Physical sustained-listening and network-interruption tests remain required.

### Version 0.4.10: optional hold-to-talk during lifelog

In Listen → Talk, speech and activity settings, select **Hold to talk / release
to finish**. The preference survives reopening and leaves auto-send unchanged.
While lifelog is active, quick taps no longer start a question (the optional
tap-to-mark-moment action still works). Hold until Listening appears, speak,
then release to send or review according to the auto-send setting. The same
hold gesture starts a follow-up from an answer while lifelog remains active.

Requires hold/release events from the Even app/firmware, using pinned SDK
0.0.15. Releases are matched to their input source. Missing source information
is ignored; early release, cancellation, backgrounding and a 30-second missing
release timeout never auto-send the held question. Tap mode and explicit phone
Ask remain available if the hardware does not deliver these gestures. Physical
testing is required on glasses and ring; SDK declarations alone are not proof
of firmware support. No main-server update is required.

### Version 0.4.9: quiet lifelog and resume

Quiet lifelog shows only `●` while the microphone and retention session are
active. Tap to ask (or mark a moment if configured); double-tap from an answer
returns to the active lifelog. Double-tap on the dot pauses the microphone.
On the paused screen, tap Resume, then tap to confirm current participant
consent and restart lifelog; double-tap cancels. Returning from the background
does not silently restart recording or renew consent.

On the phone, Listen → Return / resume lifelog returns to an active session
without reopening the microphone or renewing consent. A paused/expired session
requires the participant-consent checkbox before resuming. Lifelog remains
foreground-only. This client patch uses the existing main APIs; no server
update is required. Physical glasses gesture and dot rendering tests remain
required for each device build.

### Version 0.4.4: proactive inbox and optional conversation memory

Requires the matching main-side proactive routes. Both new features default
off. In Proactive inbox, enable sources and Save; the client refreshes every
60 seconds while visible without model calls. Swipe up from Home to read the
inbox (tap next item, swipe pages, double-tap back). Phone cards support
dismiss/snooze. Quiet hours and a 3/hour default cap bound idle interruptions;
active recordings, requests, answers and sleeping displays are not replaced.
Email/calendar depend on existing connected sources reaching OpenAGI outreach;
this is not a new mailbox/calendar connector or a guarantee of background alerts.

For memory: enable always-listening, acknowledge participants' recording consent,
then enable Retain final transcripts. Memory is separate from wake listening,
lasts at most 4 hours, and pauses on listening stop, app hide/exit or upload error.
Final text batches go to main every 30 seconds; there is no durable upload queue
or replay. Storage caps at 200 segments of at most 1000 characters per device,
then pauses with an explanation. Retention is 1 day by default (7/30 optional).
No raw audio is stored. Providers' speech processing policies still apply.

Task suggestions use conservative commitment-phrase matching, not a general
LLM analyzer. Speakers/dates are unverified. Review evidence before accepting;
accept creates a user task once, not an agent action. Delete removes retained
text and suggestions; already accepted tasks remain. The authenticated main
page at `/g2/proactive` exposes the same inbox, transcripts and controls, linked
from the phone without an owner token. Deletion/expiry removes application
records; it cannot erase operating-system backups or external provider copies.

Install the main update before this bundle. No recording consent is enabled
by installation. Physical foreground behavior, layout and battery impact still
need testing on G2; native foreground events and document visibility both pause
memory, but phone-lock/background delivery is not claimed.

### Version 0.4.3: review before send and glasses activity

Manual questions: tap to record, tap to stop and send by default. Turn off
"Send automatically when I stop talking" to review the transcript, then tap
to send. The preference survives reopening and disconnecting. Swipe through longer transcripts; double-tap discards without sending.
The phone also offers Send, Re-record and Discard. Deepgram streams speech live;
OpenAI buffered mode transcribes after Stop, using the existing transcribe-only
listen route when confirmation is enabled. With auto-send on, buffered audio
uses a single ask request and live speech sends finalized text. Optional
wake listening keeps its explicitly enabled automatic-trigger behavior.

While working, Thinking and a bounded timestamped tool/stage trail replace the
empty-answer placeholder. Tap switches between partial text and activity; swipe
reads pages or older activity. Double-tap opens Stop confirmation: tap stops,
double-tap keeps waiting. Completed actions cannot be undone. This shows public
progress and tool names only, never private reasoning or raw tool payloads.

The pinned Even SDK 0.0.13 has no press/release events, so hold-to-talk is not
advertised. The supported tap flow is deliberate, not a simulated long press.
No pairing migration or new server endpoint is required for this client patch.

### Version 0.3.0: conversations and progress

### Version 0.4.0: separate speech from work; readable, interruptible answers

Requires the matching main update. Ambient requests now use `transcribeOnly`
on `/nodes/g2/listen`: they transcribe and classify the wake/question trigger,
but do not wait for agent work. A triggered prompt starts a separate streamed
text question on `/nodes/g2/ask`. Speech segments continue to be transcribed
while that turn runs; additional triggers are not silently queued as actions.
This is still buffered OpenAI speech transcription after pauses, not a
word-by-word Deepgram stream. No Deepgram credential is bundled or inferred.

Streaming uses a 60-second no-data watchdog reset by events, not a fixed
75/180-second total request deadline. Heartbeats mean only transport liveness.
Tool names and stage timestamps are visible without tool arguments, results,
or hidden reasoning. Cancel on the phone aborts the response, propagates to
provider fetches, and stops subsequent model tool calls; it cannot undo actions
already executed, and a running tool may finish if it does not support abort.
There is no automatic request replay. Partial text is saved as incomplete.

Glasses pages are plain text, 260 characters each, with no tail clipping.
Partial pages support scrolling and retain the selected page as more text
arrives. In 0.4.2, tap a completed answer to record a follow-up in the same
conversation; tap again to send. The previous answer stays in Recent. Swipe
to read pages and double-tap to go back without starting the microphone.
Use phone Ask, Previous/Next page, Last answer, and Recent answers. No historical
answers are backfilled from the main. Foreground microphone limits still apply.

The phone stores the latest 30 answers in Even native storage. Reopening restores
the most recent answer in the selected conversation. Select a recent answer on
the phone to resume that thread, swipe glasses pages, and tap for a follow-up.
New conversation starts a separate thread. Disconnecting or switching main
clears the phone history; earlier versions' answers are not backfilled.

The updated main supports opt-in `Accept: application/x-ndjson` on the existing
authenticated `/nodes/g2/ask` route. Events are `progress`, `delta`, `heartbeat`,
`result`, and `error`. Only transcription text, public answer text, and stage
labels are exposed, never tool arguments or hidden reasoning. Old clients still
receive JSON; the new client also accepts JSON from older mains. Voice requests
are never automatically replayed after a stream interruption. The phone shows
elapsed time, partial answers, and terminal errors. Ambient mode retains its
existing non-streaming transport, but completed ambient answers enter history.

Deploy the matching main changes for streaming and the G2-only concise-answer
instruction (about 60 words by default, expandable by asking for more detail).
No pairing reset is required. Device acceptance: ask, observe progress, reopen,
select an older answer, ask a follow-up, and explicitly start a new conversation.

The same G2 shell can be packaged as a generic private **Agents** client. Tap once to
start the glasses microphone, speak for up to 30 seconds, and tap again. The
question is transcribed by the OpenAI key on your OpenAGI daemon, sent through
the normal OpenAGI agent/tool loop, and paginated on the glasses display. G2
has no speaker, so answers are visual.

No dashboard token or model-provider key is bundled. OpenAGI issues a one-time
enrollment code and stores only a hash of the resulting node-scoped token in
its existing NodeRegistry. G2 heartbeats as a constrained wearable node.
Question audio is held in memory for the request, sent to transcription, and
not persisted by the bridge.

For simulator development:

```bash
cp .env.example .env.local
# Set VITE_G2_MODE=openagi and the VITE_AGENT_* origins in .env.local.
pnpm dev:openagi
# In a second terminal:
pnpm simulate
```

For a device package, every reachable exact HTTPS origin is mandatory because
Even Hub network permissions are compile-time allowlisted (maximum 16):

```bash
pnpm package:agents
```

Start/restart the matching OpenAGI branch with `OPENAI_API_KEY` and
`OPENAGI_PUBLIC_URL` configured. In **Nodes**, either generate an enrollment
code or generate a one-time agent URL + scoped token. The latter can be pasted
into the Agents phone companion without an OpenAGI-specific client build, as
long as its exact origin is in the package allowlist. Tokens stay in the app's
Even's native app storage and are never bundled. Version 0.2.3 restores the URL,
node credential, and preferences across embedded browser sessions, migrating
older browser storage when it is still available. If the old credential has
already been lost, one final enrollment is required. Verify on a phone by
pairing, fully closing and reopening Agents, then asking a question without
entering another code. Native storage write failures are reported rather than
claiming that the connection was saved. Direct connections are revoked from
the Nodes row; disconnecting in the phone app only forgets the local copy.

The phone companion also offers an opt-in **Always listening while this app is
open** mode. It segments foreground microphone audio locally, transiently
transcribes each spoken utterance, and answers only after the configured wake
phrase (default `open agi`) or an optionally detected question. A wake phrase by
itself arms the next utterance for eight seconds. Tap the glasses to pause. This
does not claim background or phone-lock operation; those behaviors, microphone
thresholds, and battery impact require testing on physical G2 hardware.

## Run it

```bash
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm check
pnpm dev
# In a second terminal:
pnpm simulate
```

The production package is created with `pnpm package`. `app.json` contains only the G2 microphone and BuildBetter network permissions; device credentials are minted through the pairing flow and stored in the versioned recovery store, never in the bundle.

Version `0.1.1` fixes WebKit/WKWebView `Window.fetch` receiver binding during pairing. Linking against the default production API also requires the backend PR below to be deployed and `even_g2_integration` enabled for the target workspace; until then the app reports that linking is not enabled instead of exposing a raw HTTP or WebKit error.

The corresponding feature-gated server implementation is in [BuildBetter PR #5563](https://github.com/buildbetter-app/buildbetter/pull/5563) on `codex/even-g2-buildbetter` and provides recorder-only device auth, one-time WebSocket tickets, S3 chunk manifests, worker finalization, live STT, wearable Ask, hosted-live transcript following, and the desktop no-bot transcript relay.

## Start here

1. [Product and engineering specification](./specs/g2-buildbetter/spec.md)
2. [Implementation plan](./specs/g2-buildbetter/plan.md)
3. [Dependency-ordered tasks](./specs/g2-buildbetter/tasks.md)
4. [API contract](./specs/g2-buildbetter/contracts/openapi.yaml)
5. [Audio WebSocket protocol](./specs/g2-buildbetter/contracts/audio-websocket.md)
6. [Data model](./specs/g2-buildbetter/data-model.md)
7. [Hardware and release test plan](./specs/g2-buildbetter/test-plan.md)
8. [Developer quickstart](./specs/g2-buildbetter/quickstart.md)
9. [Research and architecture decisions](./specs/g2-buildbetter/research.md)

The earlier [feasibility brief](./G2_BUILDBETTER_SCOPE.md) remains the short decision document. The files above are also the release and physical-hardware acceptance record.

## Local Codex and Claude supervisor

This workspace also includes a read-only monitor for local Codex and Claude Code
sessions. Run `pnpm agents:status` for a snapshot or `pnpm agents:watch -- --notify`
for transition alerts. See [the agent supervisor guide](./docs/agent-supervisor.md)
for status semantics, recovery commands, and persistent-operation instructions.

## Repository boundaries

The work spans three repositories and should be delivered as separate, ordered pull requests:

- `/Users/shooby/Dev/g2`: Even Hub TypeScript plugin.
- `/Users/shooby/Dev/bbapp`: BuildBetter authentication, APIs, durable media ingestion, Ask adapter, database, workers, and device management.
- `/Users/shooby/Dev/bb-recorder`: existing claim-bound publisher for no-bot desktop transcript events; the backend now activates its dormant relay contract.

Do not try to make one atomic cross-repository release. The backend contracts land dark first, then the G2 client is distributed against the feature-gated backend. No BB Recorder source change is required for the relay because its publisher and follower were already implemented behind server-advertised capabilities.

## Generic package verification

The default build starts without an address and declares network permission with an empty whitelist, which the official packager accepts. Runtime access to user-entered HTTPS servers and store acceptance still need verification in Even Hub; packager acceptance alone does not establish either. Do not claim universal server support until this device check passes. No wildcard syntax is assumed.
# 0.4.16: retain failed questions and finish live speech promptly

Live speech completes on Deepgram's CloseStream summary, without waiting for
socket teardown. The matching main relay strips provider metadata and emits only
`SpeechFinished`; an older main still works through normal close handling.
Finalization remains bounded (12 seconds after draining, at most 14 seconds total).
Timeouts and microphone-release errors retain available final and interim words
in an explicit review screen, even with auto-send enabled. Such text may be
incomplete and is never auto-sent. Failed agent delivery retains the question with
a warning that main may already have acted; resending is manual and can repeat
actions. Recovery drafts are held in the current app session, not persisted across
force-quit. Discard removes them. Cancel does not automatically resend.

Phone Activity now distinguishes native Even foreground exit, missing background
PCM packets, and speech connection failure. These changes do not make an OS- or
Even-suspended microphone run in the background. Native exits still stop capture,
and stale audio is not replayed. Test on the actual phone/glasses and report the
exact Activity reason after locking; smaller upload chunks do not restore packets
that never reach the WebView. Participant consent and expiry rules are unchanged.
