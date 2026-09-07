# Conversation lifelog

Build a main-owned daily conversation history alongside the existing screen history. G2 remains a capture/display node, not an independent agent or authority.

Acceptance scope:
- Persist final utterances with capture times, source, stream-scoped speaker IDs, consent boundaries and explicit gaps. No raw audio storage; interim words are display-only.
- Group utterances into searchable moments by consent/stream changes, silence, explicit meeting/conversation cues and bounded duration. Mark speaker turns and possible decisions, commitments and topic changes as evidence, not facts about identity or successful completion.
- Offer editable moment titles, topics, speaker labels, split/merge corrections, date/text/person/topic search, export and a daily digest with original excerpts.
- Run an opt-in second-pass semantic review only on changed, settled moments, using an explicitly selected model, existing provider budget guard, a daily call cap and no tools. Keep facts/relationships linked to validated source excerpts; show pending/error states and never treat transcript instructions as authority.
- Track proposed/confirmed/completed/dismissed follow-ups. Creating a user task requires confirmation; reminders appear through the existing quiet/rate-limited G2 inbox. No automatic messages, session nudges or computer actions.
- Link moments to nearby screen activity only through a separate opt-in read at review time; temporal proximity is context, not identity or causal proof. Avoid duplicating screen content into the lifelog.
- Pause, retention and deletion must invalidate in-flight analysis and remove derived data. Accepted user tasks survive source deletion with no transcript copy. Recording consent stays separate from analysis and notification consent.
- Share the main-hosted lifelog page from phone/desktop, and supply scoped recall to G2 through the same authenticated node route. Do not expand unauthenticated routes or enrollments.

Delivery is one reviewed PR and one coherent client build. No live recording, deployment, external actions or physical glasses validation is implied by automated tests. Continuous foreground capture is supported; all-day/background reliability and speaker accuracy require device testing.

References: https://www.limitless.ai/developers and https://github.com/BasedHardware/omi (MIT). This implementation reuses OpenAGI infrastructure; no upstream code or hosted Omi dependencies are imported.
