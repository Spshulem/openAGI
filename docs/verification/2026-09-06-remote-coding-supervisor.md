# Remote coding supervisor verification

## Implemented and installed

- Main-side approval-gated coding tools and Coding Agents dashboard.
- An independently enrolled Mac background node using authenticated outbound
  node-control polling. No inbound port or owner credential on the node.
- Exact node/session approval binding, node-side durable replay protection,
  managed workspace setup, start/reply, owned-process Stop and reconciliation.
- Optional discovery of existing external coding sessions. Existing desktop
  sessions remain read-only without a configured safe delivery bridge.
- Existing G2 enrollment, phone bundle and model configuration were preserved.
- Deployed main and Mac capability source hashes were checked against source.

## Verified

- 71 focused supervisor, node-control, G2 and outreach tests passed.
- The three node/HTTP tests passed again after the remote lifecycle fixes.
- Actual authenticated Codex CLI: disposable start and same-session follow-up
  both completed idle with the expected harmless marker; no tools requested.
- Actual authenticated Claude Code CLI: disposable start and same-session
  follow-up both completed idle with the expected marker; no tools requested.
- Those provider tests ran locally through the built-in supervisor, not through
  the live main's HTTP approval flow. They did not touch existing coding chats.

## Initial live verification blocker (subsequently repaired)

The deployed main returned 503 for coding setup, then stopped answering even
its local health endpoint. Its process consumed almost one CPU core. A short
CPU profile sampled `AgentHost.handleMessageNow` → `appendMessage` →
`saveSession` → `writeJsonAtomic`, predominantly serializing/writing JSON.
A metadata-only size check found one saved session of 247,943,277 bytes.
The main again failed health checks after restarting. This is evidence of a
history-saving bottleneck, not proof of the root cause of that history growth.

At that stage no history had been changed and the first live smoke stopped before
starting a provider. The owner subsequently approved the preservation/recovery
plan below. G2 hardware remains outside the automated smoke-test coverage.

## Authorized history repair follow-up

After owner approval, the stopped main's oversized history was copied and its
SHA-256 verified before alteration. The complete 248,100,750-byte original was
retained in an owner-only recovery directory. The working copy now retains the
latest 1,000 messages (398,777 bytes immediately after repair), with a recovery
reference for the remaining 406,449 messages. Further structural inspection
showed mixed background/application history going back to June, not exclusively
autopilot messages. No individual transcript contents were printed.

File-backed sessions now rotate old messages into private content-addressed
archives after 2,000 messages, retain the latest 1,000 in the active file, and
refuse oversized reads/writes rather than freezing the server. Archive failure
preserves the previous active file. Focused retention and privacy-migration tests
passed twice; the combined retention, supervisor HTTP/node and G2 set passed 15 tests.

A second CPU sample showed expensive signal propagation and full-text dedupe
work on requests already destined to fail their model budget check. The latest
500 assistant failures in the structural sample were budget failures. The main
reported $20.0485 against its $20 daily cap. The provider budget check now runs
before signal processing; budget failure text is retained in chat but is not
repeatedly indexed into full-text search. The regression test passed. No spending
limit was increased and no provider or node credential was changed.

## Session discovery repair

The next live test successfully started a disposable Codex session through the
main's approval flow, but session listing returned 503. A metadata-only adapter
check found duplicate targets and an invalid session identifier among discovered
desktop sessions. The managed Codex session itself had completed idle.

Optional external discovery now fails closed independently of managed sessions.
Malformed, ambiguous, or unavailable external lists expose a fixed warning and
retain managed sessions; unsafe external targets cannot be prepared for replies.
The warning propagates across the remote node and is shown in the dashboard.
Fifteen focused supervisor tests passed, followed by four HTTP/node tests. The
node regression passed in both runs. The change was installed on the main and
Mac node without changing the G2 bundle, pairing, or spending cap.

The first remote follow-up was safely rejected before delivery because the
main clock was approximately two seconds ahead of the Mac's clock. Approval
validation now permits at most 30 seconds of future clock skew while retaining
the ten-minute maximum age and durable replay protection. The isolated remote
test covers a two-second difference and rejects a 60-second future timestamp;
all 15 focused supervisor tests passed. The rejected disposable follow-up was
confirmed absent from the managed session before a new approval was requested.

## Final live result

- Main HTTP approval → enrolled Mac node → Codex: start and same-session
  follow-up both verified idle with the expected disposable response markers.
- Main HTTP approval → enrolled Mac node → Claude Code: start and same-session
  follow-up both verified idle with the expected disposable response markers.
- Final list returned two managed sessions, one per provider. No existing desktop
  chat was nudged, and no coding tools or file changes were requested by the tests.
- Main health over Tailscale HTTPS returned 200 in 94 ms.
- Live provider read-back identified `OpenAIResponsesProvider`, `gpt-6-astra`;
  canonical runtime environment retained `OPENAI_REASONING_EFFORT=medium`.
- The last budget read was $20.0485 spent of $20. No cap was changed. The
  G2 → OpenAGI model → supervisor voice workflow remains budget-blocked and was
  not demonstrated on glasses. CLI smoke tests used separate provider sign-ins.
- Existing desktop discovery is degraded and existing-chat delivery has no safe
  bridge configured. This verifies managed disposable sessions, not arbitrary
  control of existing Codex desktop/Claude chats or broad computer actions.
- No new G2 bundle or re-pairing is required for these server/node changes.
- Changes are present in this workspace and installed on the two live services;
  this verification did not commit or push them to GitHub.
