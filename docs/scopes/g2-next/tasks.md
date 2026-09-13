# Tasks

## Checkpoint and foundation

- [x] T001 Preserve current working trees and reviewed source before redesign; record commits in `/Users/shooby/Dev/openagi-pr101-rollout/docs/scopes/g2-next/quickstart.md`.
- [x] T002 Define scoped additive contracts, data model and rollback in `/Users/shooby/Dev/openagi-pr101-rollout/docs/scopes/g2-next/`.
- [ ] T003 Establish a pinned reproducible OpenAGI client build in `/Users/shooby/Dev/openagi-pr101-rollout/integration-clients/even-g2-overlay/`.

## US1 — Request recovery

- [x] T004 [US1] Write admission/replay/expiry/restart/isolation tests in `/Users/shooby/Dev/openagi-pr101-rollout/test/g2-requests.test.js`.
- [x] T005 [US1] Implement bounded durable receipts in `/Users/shooby/Dev/openagi-pr101-rollout/src/g2-requests.js`.
- [x] T006 [US1] Add authenticated experience routing and endpoint tests in `/Users/shooby/Dev/openagi-pr101-rollout/src/hosted-interface.js` and `/Users/shooby/Dev/openagi-pr101-rollout/test/g2-experience.test.js`.
- [x] T007 [US1] Add negotiated resume/cancel and pending request persistence in `/Users/shooby/Dev/openagi-pr101-rollout/integration-clients/even-g2-overlay/src/openagi/api-client.ts` and `store.ts`.

## US2/US3 — Setup and phone experience

- [x] T008 [US2] Add tested connection-card parsing and readiness onboarding in `/Users/shooby/Dev/openagi-pr101-rollout/integration-clients/even-g2-overlay/src/openagi/connection-card.ts`.
- [x] T009 [US2] Add main Connect glasses setup guidance in `/Users/shooby/Dev/openagi-pr101-rollout/src/hosted-interface.js` and `/Users/shooby/Dev/openagi-pr101-rollout/src/setup-wizard.js`.
- [x] T010 [US3] Implement Talk/Inbox/History/Settings with a Classic comparison in `/Users/shooby/Dev/openagi-pr101-rollout/integration-clients/even-g2-overlay/src/ui/phone-experience.ts`.
- [x] T011 [US3] Replace status-string control inference with typed primary-action state in `/Users/shooby/Dev/openagi-pr101-rollout/integration-clients/even-g2-overlay/src/ui/openagi-phone-companion.ts`.

## US4/US5/US6 — Everyday continuity

- [x] T012 [US4] Implement one Lifelog entry and explicit pause preservation in `/Users/shooby/Dev/openagi-pr101-rollout/integration-clients/even-g2-overlay/src/app/openagi-g2-app.ts` and `src/openagi/store.ts`.
- [x] T013 [US5] Add exact scoped history continuation, draft-safe Back and consistent gestures in `/Users/shooby/Dev/openagi-pr101-rollout/src/integrations/g2-channel.js` and the G2 app/renderer.
- [x] T014 [US6] Expose existing capability, privacy, cost and notification controls contextually in the companion and main setup guidance.

## Verification and delivery

- [ ] T015 Expand client/auth/fault tests; run focused backend files twice and G2 tests/typecheck/lint with isolated data.
- [ ] T016 Review exact changes, secret-scan and commit; produce one 0.4.18 artifact on BuildBot3 and record checksum/inputs in `/Users/shooby/Dev/openagi-pr101-rollout/docs/verification/2026-09-12-g2-experience.md`.
- [ ] T017 Compare remote heads, normal fast-forward push and open the scoped PR; check external status once, with no merge/deploy/Hub submission.
- [ ] T018 Physical acceptance: clean pairing, speech, follow-up, Classic switch, pause/reopen, network/Bluetooth recovery, native Exit and lock-screen capture. Requires user hardware; not an automated pass.

Dependencies: checkpoint → contracts → receipts/routes → negotiated client → integrated experience → verification/package/PR → device testing. Independent test-writing/layout work may proceed alongside receipt implementation, but shared app/HTTP files are edited serially. No broad rewrite of unrelated subsystems.
