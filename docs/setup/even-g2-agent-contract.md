# Even G2 agent contract

The **Agents** Even G2 app can talk to OpenAGI or another compatible agent
without a dedicated wearable app. Each user supplies their main's HTTPS origin and either a pairing code or a scoped bearer token. The default package has no server address. Explicit build-time origins remain available for restricted distributions.

## Required endpoints

Both endpoints accept JSON, require `Authorization: Bearer <scoped-token>`,
return JSON, refuse redirects, and support cross-origin `OPTIONS` requests from
the Even Hub phone webview. Tokens should be independently revocable and grant
no authority beyond this voice contract.

### `POST /nodes/g2/ask`

Request:

```json
{
  "audioBase64": "<16 kHz 16-bit mono PCM WAV as base64>",
  "conversationId": "<stable UUID for the current phone conversation>",
  "language": "en"
}
```

Successful response:

```json
{
  "question": "What is on my calendar?",
  "reply": "You have a planning call at 2 PM.",
  "sessionId": "<agent-selected opaque session id>"
}
```

### `POST /nodes/g2/listen`

This is used only for buffered speech after the user enables foreground always-listening. The app
segments audio locally and sends one bounded utterance per request.

```json
{
  "audioBase64": "<16 kHz 16-bit mono PCM WAV as base64>",
  "conversationId": "<stable UUID>",
  "language": "en",
  "wakePhrase": "open agi",
  "triggerMode": "wake_only",
  "forceAnswer": false
}
```

`triggerMode` is `wake_only` or `wake_or_question`. A non-triggering response
returns the transcript without an answer:

```json
{ "question": "The room is quiet.", "triggered": false, "armed": false, "reason": "no_trigger" }
```

A wake phrase with no question returns `armed: true`; the app then sends the
next utterance with `forceAnswer: true` for eight seconds. A triggered response
adds `reply` and `sessionId` and sets `triggered: true`.

### Optional live speech and streaming answers

OpenAGI also accepts `{ "text": "<final question>", "conversationId": "<UUID>" }`
on `/nodes/g2/ask`, mutually exclusive with audio, at most 4000 characters.
The client sends `Accept: application/x-ndjson` for progress, public answer
deltas, heartbeat, and a terminal result/error. `text` input must retain the
same node/conversation authorization as audio. Healthy streams must not be
cut off by an upload-style total deadline; the client instead enforces an
idle timeout. Cancel aborts the turn signal but cannot undo completed actions.

For standard speech keys, implement the default WebSocket relay at
`/nodes/g2/speech?model=nova-3&wakePhrase=<phrase>`. The browser offers subprotocols
`["openagi-g2-speech", "<existing G2-scoped token>"]`; the server must validate
the token/platform **before** accepting an upgrade and echo only
`openagi-g2-speech`. Do not put credentials in query strings. An upgrade bypasses
normal HTTP route authentication and must self-authenticate.

Open a fixed Deepgram Listen connection with the main's private key. Send
`{ "type": "Ready", "transport": "relay" }` only once the upstream is open.
Accept binary PCM16 (16 kHz mono) plus only `KeepAlive` and `CloseStream` JSON
controls. Forward sanitized Deepgram Results/UtteranceEnd/SpeechStarted events;
never forward provider account metadata, credentials or raw errors. After
CloseStream, drain final words then close with code 1000; use non-normal closure
and a bounded, safe `Error` message on failure. Recheck enrolled-node authority,
bound audio rate/buffers/connections, and stop the provider stream on disconnect
or revocation. This uses normal speech keys without any grant permission.

For optional direct Deepgram recognition, implement authenticated
`POST /nodes/g2/speech-token` with `{ "model": "nova-3" }` (or `nova-2`). Return
`{ "accessToken": "<temporary voice JWT>", "expiresIn": 30, "model": "nova-3" }`
with `Cache-Control: no-store`. Enforce G2-scoped authentication even when the
main is otherwise unauthenticated, validate the model, and rate-limit grants.
The permanent Deepgram key stays on the server. The phone streams PCM directly
to Deepgram and submits only finalized text to `/nodes/g2/ask`. This endpoint
is optional; servers without it remain usable with explicit OpenAI buffered
speech selection. See [live speech setup and validation](even-g2.md#live-speech-source-implementation-physical-validation-required).

Restricted packages declare HTTPS and WSS for both their selected main and
the optional Deepgram destination. Package schema acceptance alone does not verify the
Even phone webview's direct WebSocket access; test it on the installed app.

## Limits and safety

- Accept at most 30 seconds of WAV audio per request and reject malformed audio.
- Use explicit request timeouts and return stable JSON errors without secrets.
- Never treat `conversationId` as authorization or as permission to select an
  owner session. Bind it to the scoped token's identity on the server.
- Do not persist raw audio unless the user and agent have a separate, explicit
  recording agreement. The current OpenAGI bridge transcribes it transiently.
- CORS permission is not authentication. Validate the bearer token before
  bypassing same-origin checks.
- The G2 has no speaker. `reply` is paginated as text on the glasses.

Package compatible origins with:

```bash
pnpm package:agents -- https://agent-one.example.com https://agent-two.example.com
```

## Generic package verification

The default build starts without an address and declares network permission with an empty whitelist, which the official packager accepts. Runtime access to user-entered HTTPS servers and store acceptance still need verification in Even Hub; packager acceptance alone does not establish either. Do not claim universal server support until this device check passes. No wildcard syntax is assumed.
