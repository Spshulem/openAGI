# OpenAGI on the phone: models, workspace, offline copy

Follows `2026-10-15-openagi-phone-only-design.md`. That spec put the daemon
inside the iPhone app on Apple's on-device model. This one makes it a full
workspace: real models, manageable skills and instructions, and a copy of
the Mac agent that keeps working offline.

Decisions (owner, 2026-10-16): build all of it; order models → workspace →
offline copy; offline work goes back to the Mac as additions only.

## 1. Models and keys

User stories:
- As an owner, I want to give the agent an Anthropic or OpenAI key from the
  phone or the desktop, so it can use a strong model.
- As an owner with ChatGPT Plus or Pro, I want to sign in with ChatGPT, so
  the agent runs on my plan instead of an API key.
- As an owner on a plane, I want the phone agent to fall back to Apple's
  on-device model when the cloud model can't be reached.

Daemon:
- Provider choices: `auto`, `anthropic`, `openai`, `chatgpt`, `on-device`.
  `auto` picks Anthropic, then OpenAI, then ChatGPT sign-in, then (mobile
  profile only) on-device, then the deterministic fallback.
- The phone app no longer forces `OPENAGI_PROVIDER=on-device`; under the
  mobile profile, `auto` with nothing configured is on-device, so a key saved
  later takes effect without a relaunch.
- Under the mobile profile every cloud provider is wrapped in a fallback: a
  network failure (DNS, refused, timeout, offline) retries the turn on the
  on-device model and says so in the reply. Auth and quota errors don't fall
  back; they need fixing.
- With a cloud model the phone agent gets the full tool set (minus what the
  mobile profile disables). Only the on-device model is limited to six tools.
- `GET/POST /settings/models` (owner token, and mobile node): which
  providers are configured (never the keys), the preference and model; set a
  key, clear a key, set the preference and model, test. Keys are written to
  `<dataDir>/.env` exactly like `/setup/save` and applied live.
- Sign in with ChatGPT (`src/chatgpt-auth.js`): OAuth 2.0 authorization
  code with PKCE, per OpenAI's open-source plan-usage program (self-serve
  for open-source, locally hosted apps). A stable `ext_agent_host_id` per
  daemon. Tokens stored in `<dataDir>/chatgpt-auth.json` (0600), refreshed
  before expiry. Requests use the Responses API with `store: false`,
  `stream: true`. Routes: `POST /auth/chatgpt/start` returns the authorize
  URL; `GET /auth/chatgpt/callback` finishes; `POST /auth/chatgpt/signout`.
- The desktop setup page gets the same Sign in with ChatGPT button.

iOS:
- Settings → Model: Apple on-device, Claude (key), OpenAI (key), ChatGPT
  (sign in). Shows which is active and lets the owner test it. The ChatGPT
  sign-in opens in `ASWebAuthenticationSession`.
- Onboarding's phone path offers "Add a key or sign in with ChatGPT" as an
  optional step after naming the agent.
- Works for a paired Mac too: the same screen changes the Mac's model.

## 2. Workspace on the phone

User stories:
- As an owner, I want to see and edit my agent's instructions on the phone.
- As an owner, I want to list, read, write and delete skills on the phone.
- As an owner, I want to see what's scheduled to run and turn jobs on or off.
- As a phone-only owner, I want the Supervisor tab to tell me it needs a Mac
  instead of showing an empty scan.

Daemon (mobile node allowed):
- `GET /persona`, `PUT /persona` (full markdown).
- `GET /skills`, `GET /skills/:name` (SKILL.md text), `PUT /skills/:name`
  (create or replace), `DELETE /skills/:name`. Names are slugs; writes go to
  `<dataDir>/skills/<name>/SKILL.md` and reload the registry.
- `GET /cron`, `POST /cron/:id/enabled` `{enabled}`.

iOS: Settings gets a Workspace section: Model, Instructions, Skills,
Scheduled. Supervisor on the phone shows "Supervisor watches coding agents
on a Mac. Connect a Mac in Settings."

## 3. Offline copy of the Mac agent

User stories:
- As an owner paired to a Mac, I want the phone to keep a copy of my chats,
  memory, instructions, skills and tasks, so the phone agent knows what my
  Mac agent knows.
- As an owner whose Mac is unreachable, I want to continue on the phone
  agent with that context.
- As an owner back online, I want what happened offline to reach my Mac.

Design (additions only, never edits on both sides):
- Mac: `GET /mobile/mirror` (mobile node) returns a snapshot: the shared
  device threads' messages, memory items, persona, skills, open tasks, and a
  cursor.
- Phone: in server mode the app pulls a snapshot on foreground and
  background refresh, starts the embedded daemon if needed, and imports it
  with the owner-only `POST /mirror/import`. Imported data replaces the
  previous mirror; anything created on the phone after the last import is
  journaled as offline work.
- Failover: when the Mac can't be reached (refresh offline, chat send
  fails), the app offers "Continue on this iPhone"; it switches to the phone
  agent, keeping the Mac pairing.
- Return: when the Mac is reachable again, the app offers "Send offline work
  to your Mac": `GET /mirror/offline` on the phone lists new messages, tasks
  and memories since the import; `POST /mobile/offline-import` on the Mac
  appends them (messages into the device threads, tagged as from the phone),
  then the app switches back.

## Out of scope
- Two-way editing of the same item; conflicts can't happen because only
  additions travel back.
- Claude subscription sign-in (no equivalent program known); Claude is
  API-key only.
- Supervisor scanning on the phone.
