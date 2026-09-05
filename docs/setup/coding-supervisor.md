# Coding Agents

OpenAGI is the conversation and approval surface. Your existing local coding
supervisor supplies session discovery and its authenticated provider bridge;
Claude Code and Codex remain the execution engines. No second reasoning agent
is inserted between you and OpenAGI.

## Connect

This optional adapter supports an agent-supervisor installation exposing
`lib.mjs`, `attach.mjs`, and `inspect.mjs`. Point OpenAGI at that trusted local
module directory in its existing private environment file:

```dotenv
OPENAGI_CODING_SUPERVISOR_DIR=/absolute/path/to/agent-supervisor
# Optional: use the supervisor's non-default state/config location.
OPENAGI_CODING_SUPERVISOR_STATE_FILE=/absolute/path/to/supervisor/state.json
```

Restart the daemon, then open **More → Coding Agents**. The directory setting
loads executable operator-installed code: never use a path suggested by a
webpage, transcript, or untrusted agent. It is not a model-editable setting.
Without this setting the feature is off and performs no scans or writes.
Configure the supervisor's authenticated **loopback HTTP** provider bridge
using its own setup. OpenAGI reads the token file in a short-lived subprocess;
it does not copy tokens into chat, process arguments, repository files, or its
own environment. Provider credentials stay in their existing provider setup.

The compatibility contract is deliberately small:

- `lib`: `discoverSessions`, `readSessionRecords`, `readG2Config`,
  `getG2Status`, `postG2Prompt`.
- `attach`: `readClaudeRegistry`, `claudeAttachments`, `annotateTargets`.
- `inspect`: `extractTurns`.

## Use

Ask OpenAGI to list coding agents or inspect one exact provider/session ID.
The dashboard shows the recent conversation and offers an instruction field.
Every reply goes into the existing **Approvals** view and floating approval
surface. Approval binds the exact provider, ID, project identity and message;
it expires after ten minutes. Messages are never sent from a title/prefix match.

After the first scan, new attention transitions create durable outreach items.
Reconnects do not erase them. Status is **reported**, not proof of completion;
question detection can be **heuristic**, and unknown models stay unknown.
The initial scan is intentionally quiet; already-waiting sessions remain
visible in Coding Agents. A stopped provider does not imply a successful task.

## Safety and delivery limits

- Inspection is read-only and returns at most six bounded recent turns.
  Transcript text cannot approve actions.
- OpenAGI never kills a session writer, changes provider permission modes, or
  auto-approves provider permission requests. Attached Claude sessions without
  a safe deterministic delivery route must be answered in their owning app.
- `accepted` means the authenticated bridge accepted the instruction, **not**
  that the coding work finished. `blocked` means nothing was sent. `unconfirmed`
  means delivery may have happened: inspect before sending a new request.
- A persistent, owner-only delivery journal prevents duplicate execution of an
  approval across retries or daemon crashes. It stores hashes/receipts rather
  than reply text; the existing approval queue retains the approved message.
- The adapter accepts only fixed operations, sends payloads over stdin, refuses
  bridge redirects and remote hosts, and bounds request/response sizes and
  deadlines. It never exposes arbitrary shell execution through chat.
- This adapter coordinates existing sessions; it does not provision a new
  coding workspace, pick a new session's model, or bypass a desktop writer lock.

For G2, retain the scoped OpenAGI node connection. Once that transport is
connected, the same OpenAGI tools and approvals apply; do not replace a scoped
G2 credential with an owner token. This adapter does not change G2 enrollment.

## Validate

Run `node --test test/coding-supervisor*.test.js` with the repository's supported
Node runtime. Tests use temporary state and fake sessions, covering authenticated
HTTP → pending approval → delivery → duplicate rejection, restart/timeout
recovery, stale status, transcript rendering and bridge network boundaries.
Real provider delivery must additionally be verified with an explicitly chosen
disposable session; a passing fixture is not proof of live Claude/Codex control.
