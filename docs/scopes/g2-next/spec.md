# G2 0.4.18 experience specification

The approved product scope is [the complete UX scope](../2026-09-12-g2-experience-redesign.md). This specification makes its next candidate executable without treating hardware aspirations as delivered capability.

- US1 (P0): After losing a connection, see the same accepted question and result without duplicating agent work. Cancel explicitly; distinguish an interrupted main from an unsent draft.
- US2 (P1): Connect an existing home computer through a pasteable short-lived connection card; new users can open the computer setup guide and preview the interface without recording. Check actual configured capabilities after scoped pairing.
- US3 (P1): Use Talk, Inbox and History with Settings separate. Try Classic without changing pairing, consent, history, or server configuration.
- US4 (P1): Enable Lifelog once, pause intentionally, return while existing consent is valid, and find saved text in History. No new background-recording claim.
- US5 (P1): Resume the correct main-owned chat and see meaningful tool progress on glasses. Root double-tap retains native exit confirmation.
- US6 (P1/P2): Find coding/computer requirements and bounded notification/privacy/cost settings without enabling new permissions or paid work.

Acceptance: focused fault/auth/ownership tests, client gesture/storage/UI tests, TypeScript and production package checks. Physical onboarding, gestures, lock-screen, readability, live latency and actual provider control remain explicit user acceptance gates from the complete scope.

Not authorized in this implementation: live deployment, provider-key changes, live recording or paid model tests, unrestricted computer control, merging PRs, or Even Hub upload/submission.

Candidate boundaries: main history enumerates the 200 most recently updated active G2 conversations, searches question/reply previews, and pages public messages. It is not full-archive semantic search. There is no hosted main service, native installer rewrite, QR scanner, local/offline speech recognizer, or newly guaranteed background capture. These remain separate work from this reversible candidate. Public stage/tool events are shown, never private model reasoning.
