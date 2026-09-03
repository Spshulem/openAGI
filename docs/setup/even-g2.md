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

The bridge does not persist question audio. Your configured transcription
provider still receives the audio under that provider's own data policy.

## Server setup

The phone-hosted Even app must reach OpenAGI over an exact public HTTPS origin.
Configure and restart OpenAGI with:

```bash
OPENAI_API_KEY=...
OPENAGI_AUTH_TOKEN=...
OPENAGI_PUBLIC_URL=https://your-openagi-host.example.com
```

`OPENAI_TRANSCRIPTION_MODEL` defaults to `gpt-4o-mini-transcribe`.
`OPENAI_TRANSCRIPTION_BASE_URL` defaults to `OPENAI_BASE_URL`, then to the
OpenAI API. A daemon configured only with Anthropic still needs an OpenAI key
for this speech-to-text step.

## G2 client

The reviewable client overlay lives at
`integration-clients/even-g2-overlay/`. Its paths correspond to the local G2
project. The packaged client contains the chosen server origin but no OpenAGI
dashboard token and no provider key.

After applying the overlay to the G2 project:

```bash
pnpm check
pnpm package:openagi -- https://your-openagi-host.example.com
```

Open OpenAGI's **Nodes** tab, generate the G2 enrollment code, and enter it in
the phone companion. **Remove this G2 node** revokes the NodeRegistry
credential immediately.

## Trust boundary

The one-time exchange route is the only G2 route that bypasses owner auth. It
is single-use, expires after ten minutes, and locks for fifteen minutes after
five failures. After enrollment, every request requires both the node id and
its scoped bearer token. A G2 token may heartbeat, ask by voice, or revoke
itself; it cannot read tasks/integrations/topology, submit generic node
messages, capture memory directly, or poll node-control work. Conversation ids
are only discriminators: the server hashes them with the authenticated node id
and chooses the durable AgentHost session, so a wearable cannot attach itself
to an owner or another node's session.

## Verification boundary

The Even Hub simulator can verify layout, gestures, API state, and packaging.
It cannot prove physical microphone continuity, BLE behavior, phone-lock
survival, battery impact, or real glasses rendering. Those remain physical G2
acceptance checks before calling the integration device-ready.
