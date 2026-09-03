# Even Realities G2 as an OpenAGI node

## Outcome

An Even Realities G2 can be enrolled by the OpenAGI owner, accept an explicit
tap-to-record voice question, run that question through the owner's normal
AgentHost/tools/memory policy, and render the answer on the glasses. In the
topology and security model, the wearable is a constrained node rather than a
parallel channel-specific account.

## In-scope PR contract

- Owner-authenticated, six-digit node enrollment-code issuance.
- A public but self-authenticating, single-use enrollment exchange for the
  `even_g2` platform, with ten-minute expiry and five-attempt lockout.
- One stable G2 node id plus one random node-scoped token returned once to the
  phone companion. Only its SHA-256 hash and bounded node metadata persist in
  the existing NodeRegistry.
- Thirty-second heartbeat through the existing `/nodes/heartbeat` route.
- Server-owned `g2-voice-input` and `g2-text-display` capabilities; wearable
  input cannot add computer-use or other control capabilities.
- A node-authenticated G2 voice route with strict 16 kHz mono PCM WAV parsing,
  a 30-second/roughly 1 MiB ceiling, transient OpenAI transcription, and no
  audio persistence.
- Durable conversations selected by a server hash of node id plus a client
  conversation discriminator. A client-provided AgentHost session id is never
  accepted.
- Existing node removal and self-revocation semantics. Revocation invalidates
  heartbeat and voice access on the next request.
- A Nodes-tab enrollment control and wearable row; a reviewable Even Hub client
  overlay with microphone, pagination, conversation reset, heartbeat, exact
  origin packaging, and no bundled owner/provider credentials.

## Explicit authority boundary

The G2 credential is accepted only for heartbeat, self-revocation, and the G2
voice request. It is rejected for generic `/message`, topology/tasks/integration
reads, direct memory capture, and node-control poll/result routes. CORS is
enabled only for the enrollment exchange and those three credential-bound
operations. Cross-origin browser POSTs skip the normal same-origin check only
after the exact G2 node id and bearer token authenticate.

## Out of scope and release gates

- No speaker/audio reply: G2 answers are visual.
- No continuous listening or background recording.
- No model key, OpenAGI owner token, or arbitrary OpenAGI capability on G2.
- No changes to the non-Git `/Users/shooby/Dev/g2` workspace in this PR. The
  verified overlay is retained in `integration-clients/even-g2-overlay/` until
  a writable Git-backed G2 repository is supplied.
- Simulator/build verification does not prove physical BLE continuity,
  microphone behavior, phone-lock survival, battery impact, or display
  legibility. Those are required device acceptance checks before release.

## Acceptance evidence

Automated coverage must prove owner-only issuance; expiry, single use, and
lockout; token hashing and node-id binding; fixed heartbeat capabilities;
cross-node and unrelated-route denial; server-bound conversation provenance;
successful transcription/AgentHost delivery; and denial immediately after
revocation. The merged G2 overlay must pass strict TypeScript, focused ESLint,
API-client tests, production Vite build, bundle-size policy, packaged-secret
scan, and exact-origin Even Hub packaging.
