# G2 proactive inbox and conversation memory

## First implementation

The main owns durable delivery preferences, notification acknowledgements and
opted-in ambient transcripts. G2 is a foreground client, not another scheduler
or model worker. This builds on PR #97's talk settings and progress UI.

- Proactive updates default OFF. Per-node categories: approvals, tasks,
  discoveries, email and calendar. Existing OpenAGI outreach is the source;
  this does not install or credential new email/calendar connectors. Due user
  tasks are also surfaced. Feed reads never invoke a model.
- G2 checks a bounded feed every 60 seconds while visible, plus manual Refresh.
  Notifications never replace manual recording, active requests, answers or a sleeping
  display. An idle indicator offers the inbox; phone cards allow reading,
  dismissing and one-hour snoozing. Quiet hours and hourly interruption limits
  apply; ambient listening permits alerts only after 15 seconds without speech
  updates. Nothing promises phone-lock/background operation.
- Ambient memory is a separate explicit consent, default OFF, valid for one
  foreground listening session. Only final transcripts are submitted, in
  bounded batches. Wake listening alone does not retain ambient text.
- Retention choices: 1, 7 or 30 days, default 1. No raw audio retention. Show
  that speakers are unverified; recording others requires their consent.
  Pause on app hiding/disconnect, no disk-backed upload queue or automatic
  replay. Delete removes retained transcripts and unaccepted suggestions;
  explicitly accepted tasks remain ordinary user tasks.
- Initial task analysis is deterministic and conservative: detect explicit
  commitment phrases, quote source evidence, propose rather than execute.
  No background LLM cost, no agent tools and no inferred speaker identity.
  General semantic/Luna extraction is deferred until quality/cost evaluation;
  the first version must clearly label this limitation.
- Accepting a candidate creates one task in the USER queue, with provenance,
  never the agent execution queue. No approval of computer/coding actions on
  glasses: those link back to the main's existing approval controls.
- Authenticated main page provides the same inbox, transcript review/delete,
  and task acceptance. No owner tokens in links. G2 endpoints require the
  existing enrolled G2 credential even if owner auth is disabled.

## Acceptance gates

Prove per-node isolation/revocation, consent-off and expired-consent rejection,
bounded payloads/storage, duplicate batch/task protection, retention/deletion,
quiet hours/dismiss/snooze, and no agent/model calls during ingestion/feed reads.
Client tests cover opt-in controls, hiding/exit cleanup, no submission without
consent and non-disruptive inbox navigation. Package only after focused tests,
typecheck/build and secret scan. Main deployment, Hub upload, installation,
physical foreground/gesture/battery testing are distinct delivery gates.
