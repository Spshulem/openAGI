# Coding Agents

OpenAGI is the conversation and approval surface. Its built-in supervisor starts
and tracks Claude Code or Codex CLI sessions. No G2 hardware, private supervisor
repository, shared account, or second reasoning agent is required. An existing
supervisor remains an optional compatibility adapter.

## Fresh-install setup (macOS and Linux)

1. Install OpenAGI and the official Claude Code or Codex CLI. Use your own
   provider account: `claude auth login` or `codex login`. OpenAGI finds executables
   on its absolute PATH entries and standard user/package-manager locations.
   A CLI being found does not prove authentication; the first approved run does.
2. Open **More → Coding Agents → Setup and provider requirements**. Enter the
   absolute paths of existing Git project folders, one per line, then choose
   **Save folders and enable**. Saving replaces the selected folder list.
   Home directories, filesystem roots, duplicates and non-Git folders are rejected.
3. Select a provider, workspace, optional model ID and reasoning effort. Enter
   an instruction and choose **Review start approval**. The complete instruction,
   canonical project path, model and permission limits appear in Approvals and
   the floating panel. Nothing starts before approval.
4. Inspect the result in Coding Agents. **Stop managed run** stops only a process
   OpenAGI launched. It does not stop pre-existing terminal or desktop writers.

The initial built-in execution profile is deliberately restricted: Codex runs
read-only with user execution configuration ignored; Claude keeps manual
permission checks, does not auto-answer permission prompts, and disables project
settings/hooks and MCP servers. This is **not unrestricted autonomous coding**.
Denied provider actions need a separate provider decision. CLI version support
is required for the documented flags; incompatibility is a failed run, not success.
No provider API keys are copied into OpenAGI state or child-process arguments.
CLI usage is billed by the selected provider and is not capped or accounted for
by OpenAGI's chat budget. Model selection may change that cost.

Configuration and the most recent six bounded turns per managed session are
stored owner-only under the canonical OpenAGI data directory. At most two runs
execute concurrently, with one managed run per workspace, a ten-minute deadline
and bounded output. This does not lock out unrelated editors or external CLI
processes: choose a dedicated workspace/worktree for each managed agent.

After an unexpected daemon exit, affected workspaces stay quarantined. Stop the
old provider process in its owning app, then explicitly check **I verified the
previous provider process is stopped** and **Release interrupted workspace**.
OpenAGI never uses a saved PID as permission to kill a process. Terminal history
older than the approval window can be retired when the 100-session bound is
reached; working and unreconciled sessions are retained. Disabling the feature
requires stopping managed runs first and preserves the selected folders.

## Optional external adapter

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
Without this setting, use the built-in setup above; it is disabled until enabled.
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
- The external adapter never kills a session writer, changes provider permission modes, or
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

## Main on another computer

The main can delegate to a dedicated coding-supervisor node over the existing
authenticated outbound node-control transport. The node opens no inbound port
and holds only its own scoped node credential, never the main's owner token.
Set `OPENAGI_CODING_SUPERVISOR_NODE` on the main to that enrolled node's exact ID.
Changing the selected node invalidates previously prepared coding approvals.

On the coding computer, run `scripts/coding-supervisor-node.mjs` with an absolute
path to its owner-only (0600) JSON configuration. The configuration contains
`remote` (the HTTPS main origin), `nodeId`, `nodeToken`, `dataDir`, optional `name`,
and optionally `backendDir` / `stateFile` for the external discovery adapter.
`scripts/setup-coding-node.mjs` can provision this configuration with an
operator-selected enrollment helper that receives the new node credential on
stdin and returns the authenticated `/nodes/enroll` receipt. It refuses to
overwrite existing pairing. Run the node with a login/background service using
an absolute Node executable and a PATH containing the authenticated provider CLIs.

The main's Coding Agents view then lists sessions, inspects recent turns, and
queues starts/replies for approval. Workspace selection refers to folders on
the coding computer. Starts, Stop, and interrupted-workspace reconciliation
apply only to runs owned by this supervisor. The node also persists reply
receipts so replaying an approval after a main restart cannot resend it.

Existing external chats can be discovered without a delivery bridge. They are
read-only until their external adapter has a safe configured reply route;
installing this node does not unlock or take over an active Codex/Claude writer.
Managed sessions use the restricted built-in provider profiles above.

## Validate the node path

`node --test test/coding-supervisor-node.test.js test/coding-supervisor-http.test.js`
checks node identity binding, exact-session routing, unsupported-operation
refusal, and two-sided replay protection. Also exercise a real disposable
provider session through main-side start approval, completion, reply approval,
and completion. Fixtures do not establish real account access or G2 hardware.

## Validate the supervisor

Run `node --test test/coding-supervisor*.test.js` with the repository's supported
Node runtime. Tests use temporary state and fake sessions, covering authenticated
HTTP → pending approval → delivery → duplicate rejection, restart/timeout
recovery, stale status, transcript rendering and bridge network boundaries.
Real provider delivery must additionally be verified with an explicitly chosen
disposable session; a passing fixture is not proof of live Claude/Codex control.
