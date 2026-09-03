# BuildBetter for Even Realities G2

This workspace contains the implemented phone-hosted Even Realities G2 plugin. It records in-person audio into a durable BuildBetter recording, shows live captions, follows accessible live meetings, and answers workspace or recording questions through BuildBetter's Quick Agent and configured MCP tools.

## OpenAGI voice mode

The same G2 shell can now be packaged as a private OpenAGI client. Tap once to
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
# Set VITE_G2_MODE=openagi and your exact VITE_OPENAGI_ORIGIN in .env.local.
pnpm dev:openagi
# In a second terminal:
pnpm simulate
```

For a device package, the exact HTTPS origin is mandatory because Even Hub
network permissions are compile-time allowlisted:

```bash
pnpm package:openagi -- https://your-openagi-host.example.com
```

Start/restart the matching openAGI branch with `OPENAI_API_KEY` and
`OPENAGI_PUBLIC_URL` configured. In its dashboard, open **Nodes**, generate an
Even G2 enrollment code, enter that code in the phone companion, and then tap
the glasses to talk. **New conversation** clears only the current chat thread;
**Remove this G2 node** revokes the scoped server credential.

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
