# Even Realities G2

OpenAGI can accept a spoken question from an Even Realities G2 and return a
paginated text answer on the glasses. The G2 has no speaker, so this integration
does not claim spoken playback.

The implementation and release boundary is captured in the
[G2 node integration specification](../superpowers/specs/2026-09-02-even-g2-node-integration.md).

## What is implemented

1. The owner generates a six-digit, ten-minute, single-use code in **Nodes**.
2. The G2 phone companion exchanges it for a stable G2 node identity and a
   random node-scoped credential. The owner/admin token never reaches G2.
3. OpenAGI stores only the credential hash in the existing NodeRegistry under
   the resolved data directory. There is no separate G2 credential store.
4. The companion heartbeats every 30 seconds with only `g2-voice-input` and
   `g2-text-display`. The server replaces, rather than trusts, the advertised
   capability set, and the Nodes view shows the wearable with every other node.
5. A tap starts the glasses microphone. A second tap sends at most 30 seconds of
   16 kHz, 16-bit mono PCM WAV using the scoped credential.
6. OpenAGI transiently sends that WAV to its configured OpenAI transcription
   endpoint, then puts only the resulting text into the normal `g2` chat
   session. The normal model/tool/memory policy applies to the text turn.
7. The answer is paginated on the glasses. Later questions retain the session
   until **New conversation** is selected.

## Native “Hey Even” agent

Even AI supports custom agents through **Settings → Even AI → Agent
Configuration → Add Agent**. Even developer access is required for this menu.
See [Even's custom-agent tutorial](https://support.evenrealities.com/hc/en-us/articles/16280926743695-Tutorial-Bridging-G2-to-OpenClaw-Bring-Your-Own-Agent).

1. Install and finish setup on your OpenAGI main, configure its exact HTTPS
   origin as described below, and connect any calendar or other data you want
   to ask about.
2. Open **Connect glasses** at `<main>/g2/connect` on the authenticated main.
   Choose **Create Even AI connection**.
3. In Even, use the name **OpenAGI**, the full **Agent URL** ending in
   `/nodes/g2/chat/completions`, and the one-time **Token** from that page.
   Save, select, and activate the agent.
4. Say “Hey Even” and ask a question. Your OpenAGI main handles the question
   with its configured model and connected tools. Its model API keys stay on main.

This connection has its own G2-scoped credential. Remove its **Even AI ·
OpenAGI** row in Devices to revoke it. OpenAGI stores only the token hash; a
lost token must be replaced. Duplicate immediate requests share one agent turn.
The adapter accepts one user text message, without streaming or caller-selected
sessions. Native microphone, wake-word and display behavior remain controlled
by Even AI; the companion UI below applies to the separate Agents app.

## Compact status, live cues and optional transcript

The Agents app uses a small upper-right clock with animated **Listening…**,
**Thinking…**, and **Checking…** states. Quiet Lifelog leaves the rest of the
display clear until an answer or cue arrives. **Show transcript / Hide
transcript** is one tap on the phone and does not start or stop recording.

Enable **Live cues** on the phone during consented foreground Lifelog for
brief facts, answers, or task suggestions. A brief appears at the upper left;
tap to expand it, swipe through details, and double-tap to return. A phone cue
list retains up to 30 entries in the current session. Calendar questions use
connected read-only tools and the phone's timezone. A task cue suggests
capturing a task; it does not create one automatically. Cues use only the last
three utterances (at most 3000 characters), check at most every 30 seconds, and
are limited to 20 checks per hour per node. Pause, exit and foreground loss
discard pending cues and clear their rolling context. The separate Lifelog
retention setting still governs saved transcripts.

These interactions take inspiration from
[Even Conversate](https://support.evenrealities.com/hc/en-us/articles/14273795154319-Conversate).
They do not change the SDK's background microphone limits.

### Finding and pairing your main

The phone setup includes installation, network, and pairing steps. **Find /
check my main** checks an entered HTTPS or Tailscale address and remembers the
last main for next time. It checks only explicit/saved addresses, without
credentials or redirects. Even Hub SDK 0.0.16 exposes no Bonjour or Tailscale
peer-browser API, so this is address verification rather than automatic LAN
discovery. Use your computer's HTTPS hostname, not `localhost` on the phone.
After a successful check, generate a pairing code or connection card on main
and paste it into the companion.

## Optional always-listening mode

The phone companion can opt into **Always listening while this app is open**.
The G2 microphone then stays active in the foreground and a local voice-activity
segmenter cuts speech into bounded utterances. Each utterance is transiently
transcribed, but OpenAGI creates an agent turn only when the configured wake
phrase (default `open agi`) is present or when the optional question detector
recognizes a clearly phrased question. Saying only the wake phrase arms the next
utterance for eight seconds. Tap the glasses or clear the phone toggle to pause.

This is intentionally not described as background or screen-lock capture. Even
Hub lifecycle behavior, microphone thresholds, BLE continuity, battery impact,
and phone-lock survival require physical-device validation. Always-listening
also sends more audio to the configured transcription provider than tap-to-talk.

The bridge does not persist question or ambient utterance audio. Your configured transcription
provider still receives the audio under that provider's own data policy.

## Server setup

The phone-hosted Even app must reach OpenAGI over an exact HTTPS origin.
Configure and restart OpenAGI with:

```bash
OPENAI_API_KEY=...
OPENAGI_AUTH_TOKEN=...
OPENAGI_PUBLIC_URL=https://your-openagi-host.example.com
```

### Private remote access with Tailscale

Connect the Mac running OpenAGI and the phone running Even Hub to the same
Tailscale network. Keep OpenAGI bound to loopback and enable private Serve:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:43210
tailscale serve status
```

On macOS, if the CLI is unavailable, invoke
`/Applications/Tailscale.app/Contents/MacOS/Tailscale` instead of `tailscale`.
Use the exact HTTPS URL printed by Serve, including `:8443`, as
`OPENAGI_PUBLIC_URL`, restart OpenAGI, and pass the same origin to
`pnpm package:agents -- <origin>`. Despite the environment variable name,
this URL can be private to the tailnet. Funnel is not required.

Verify `<origin>/health` on the phone with Tailscale connected before pairing;
the certificate must validate without bypasses. Test again on cellular with
Wi-Fi disabled. The Mac must remain awake, online, and running OpenAGI.
Tailscale access does not replace the scoped agent token. To disable this
Serve listener, run `tailscale serve --https=8443 off`.

`OPENAI_TRANSCRIPTION_MODEL` defaults to `gpt-4o-mini-transcribe`.
`OPENAI_TRANSCRIPTION_BASE_URL` defaults to `OPENAI_BASE_URL`, then to the
OpenAI API. A daemon configured only with Anthropic still needs an OpenAI key
for this speech-to-text step.

## G2 client

The reviewable client overlay lives at
`integration-clients/even-g2-overlay/`. Its paths correspond to the local G2
project. The packaged client is the generic **Agents** app. The default package contains no server address or credentials. Users enter their main's HTTPS origin on the phone. Optional explicit origins produce a restricted package.

After applying the overlay to the G2 project:

```bash
pnpm check
pnpm package:agents
```

Open OpenAGI's **Nodes** tab and choose either flow:

- **Generate pairing code** enrolls this G2 into OpenAGI and lets it heartbeat.
- **Generate agent URL + token** shows a scoped credential once. Paste both
  values into the Agents phone companion. The direct connection does not
  heartbeat or self-revoke; remove its visible row in Nodes to revoke it.

In a restricted package the URL must match its configured origins. OpenAGI
stores only the token hash. A newly generated direct credential appears in
Nodes as **unknown / never heard from** until it is used; losing the one-time
token is handled by removing that row and generating another.

Other agent servers can implement the same narrow protocol described in the
[G2 agent contract](even-g2-agent-contract.md), allowing one reviewed Agents
app to talk to multiple compatible agents.

## Trust boundary

The one-time exchange route is the only G2 route that bypasses owner auth. It
is single-use, expires after thirty minutes, and locks for fifteen minutes after
five failures while a code is active. Pairing creates the token on the phone
before exchange, making a lost response safe to retry. Enrolled clients send
both node id and token for heartbeat/self-revocation; compatible direct clients
may omit the node id only on `/nodes/g2/ask`, `/nodes/g2/listen`, and
`/nodes/g2/speech-token`, as well as the scoped native-chat and live-cue routes.
A G2 token
cannot read tasks/integrations/topology, submit generic node
messages, capture memory directly, or poll node-control work. Conversation ids
are only discriminators: the server hashes them with the authenticated node id
and chooses the durable AgentHost session, so a wearable cannot attach itself
to an owner or another node's session.

## Verification boundary

The companion pins **Even Hub SDK 0.0.16** (minimum Even app **2.2.10**).
Source tests cover native request deduplication and scoped authentication,
read-only cue tools and consent, transcript independence, expansion, and stale
cue cancellation. Install the updated main and companion together. Before
claiming device acceptance, test native “Hey Even” with the full URL/token,
a real connected-calendar question, upper-right status readability, cue
expansion, transcript toggling and foreground pause/resume on physical G2.

### Live speech (source implementation; physical validation required)

Store a Deepgram speech-enabled key as `DEEPGRAM_API_KEY` only in your main's
private environment. Install server dependencies with `npm ci` and restart
the main after deploying the matching code. A standard speech key works;
Member permissions are **not** required for the default **Through OpenAGI main**
connection. Select this connection if `/v1/auth/grant` returns
`403 FORBIDDEN: Insufficient permissions`.

On the phone, select **Deepgram Nova 3 · live** (or Nova 2) under Speech
recognition. This changes speech recognition, not OpenAGI's reasoning model.
Existing installations keep OpenAI buffered mode until explicitly switched;
switching does not reset pairing or conversation history. Other agent hosts
without either optional speech endpoint can keep buffered mode.

The default live connection uses `wss://<selected-main>/nodes/g2/speech`.
The phone authenticates using its existing G2-scoped credential in the WebSocket
subprotocol header, never in a URL. The main forwards 16 kHz mono PCM16 packets
to Deepgram immediately and sends back interim/final transcripts. It does not
buffer a complete recording or issue Deepgram tokens. The phone waits for the
provider-ready event before opening the microphone, so setup cannot drop the
first words. This adds a network hop through your main, not a batch upload.

The relay is bounded to one connection per G2, 32 connections overall, and six
connection attempts per node per minute. It rejects other node platforms and
owner credentials even if normal dashboard auth is disabled. Revocation is
checked on every audio/control packet and at least every ten seconds. Socket
closure stops forwarding; server shutdown closes both sides. Provider account
metadata and raw errors are filtered. Your proxy/Tailscale Serve must support
WebSocket upgrades to the main on the same origin as normal G2 requests.

The optional **Direct to Deepgram** connection skips that extra hop, but requires
a key with **Member** permissions (Deepgram → API Keys → Create Key → Advanced).
Only this mode requests a 30-second voice-only JWT using authenticated
`POST /nodes/g2/speech-token` with `{ "model": "nova-3" }`. The no-store response
contains `accessToken`, `expiresIn`, and `model`. The phone immediately opens
`wss://api.deepgram.com/v1/listen` and streams G2's 16 kHz mono PCM16 packets.
Recognition is cloud-based, not on-device. The permanent key never goes to the
phone. The token is held in memory only, not saved or logged. Only text goes
to `/nodes/g2/ask` after Stop or a finalized wake/question trigger. Issuance is
limited to six attempts per minute per enrolled G2; revoked nodes cannot mint
new tokens. Temporary tokens authorize Deepgram voice APIs, not OpenAGI APIs;
they cannot be restricted to a particular model by this endpoint. Revoking a
node does not immediately terminate an already-open direct Deepgram stream.

Interim transcripts update the phone and glasses. Final segments accumulate;
only completed utterances can trigger agent work. Extra triggers during an
active agent request are discarded, not queued. Push-to-talk drains final words
before sending text, with a bounded five-second finalization wait. A network
backlog over two seconds discards stale audio with an explicit gap notice. G2
0.4.11 paces short PCM chunks and can reconnect consented foreground lifelog up to
three times per minute without renewing consent; pause, app hiding or consent
expiry cancels recovery. Manual questions and non-recoverable failures still
require explicit retry. There is no automatic WAV fallback or question replay. Activity
shows speech setup/finalization time and first-answer-text time separately.

Always listening remains opt-in and foreground-only. Deepgram receives all
microphone audio while enabled, not only speech after the wake word. OpenAGI
does not save raw audio; provider retention terms still apply. The client opts
out of Deepgram's model improvement program. This is not a zero-retention claim.

**Blank glasses display** on the phone hides text while retaining the app page.
Double-tap wakes it; at the root it also opens Even's native exit confirmation.
The phone's Wake button wakes without requesting exit. While awake, double-tap
means Back on child screens and native exit confirmation at the root, including
quiet listening. Swipe at home for Recent; swipe down while listening and tap
Pause listening to pause without exiting. Display blanking is not hardware
sleep and does not stop recording or cancel an agent request. Gesture delivery
while blank and battery behavior require testing on actual glasses.

Acceptance check: speak a question and see words **before** pressing Stop;
confirm the agent request contains text only; test wake-only and question
triggers, cancellation, a network interruption, reopening without re-pairing,
and blank/wake while an answer streams. Do not claim a latency improvement
from mocked tests alone. Test the phone's relay WebSocket access in the installed
Even package. If using direct mode, also test its Deepgram WebSocket and the
main's token endpoint.

The Even Hub simulator can verify layout, gestures, API state, and packaging.
It cannot prove physical microphone continuity, BLE behavior, phone-lock
survival, battery impact, or real glasses rendering. Those remain physical G2
acceptance checks before calling the integration device-ready.

## Generic package verification

The default build starts without an address and declares network permission with an empty whitelist, which the official packager accepts. Runtime access to user-entered HTTPS servers and store acceptance still need verification in Even Hub; packager acceptance alone does not establish either. Do not claim universal server support until this device check passes. No wildcard syntax is assumed.
