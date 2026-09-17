# G2 0.4.18 candidate verification

## Scope and delivery boundary

This is a reversible next-version candidate, not a deployment or an assertion that every aspiration in the full experience scope is complete. Both main and the G2 client need updating to use durable recovery and main history. An older main keeps the legacy ask path. No main/node deployment, provider configuration, real recording, paid model execution, physical computer control, PR merge, or Even Hub upload/submission occurred.

The client adds Focused Talk / Inbox / History / Settings and a Classic switch; connection-card onboarding and configured-capability guidance; saved drafts and main-owned request recovery; exact G2 chat continuation; persistent intentional Lifelog pause; bounded public tool progress. Native root double-tap exit remains intact. Authentication and persistent-data skill guidance kept the new API node-scoped and receipts private under the configured data directory.

Main history covers the 200 most recently updated active conversations for this G2, preview search and public-message pages. Full archives, a new native installer, automatic HTTPS setup, QR/plugin deep links, local speech recognition, light-theme polish and guaranteed phone-lock recording are not delivered by this candidate. A capability response checks configuration, not a real provider or device connection. Manual text drafts remain until sent/discarded or the connection is removed; raw audio is never persisted for replay. Private model reasoning and tool arguments are not progress text.

## Immutable source and bundle

- Baseline/rollback: `08b80e194d3643ae1e9ca20a69c17d8560996648`, retained as `codex/g2-pre-redesign-0.4.17`.
- Implementation and package input: `f176f8962ae052182e1760bdc3548505e0425996`.
- Backend verified head: `2487564857eddfcec421c9d91d378170f17439a4`; its only change after packaging makes the cancellation test fixture explicitly CommonJS. Client and runtime source are identical to package input.
- Package ID: `sh.agents.even.g2`; manifest version: `0.4.18`; Even SDK: `0.0.15`; minimum Even app: `2.2.6`.
- Artifact: `/Users/shooby/Downloads/OpenAGI-Agent-0.4.18-f176f89.ehpk`, 95,823 bytes.
- SHA-256: `b57b7d72f68a8e393e2b748e8b9e40805d3f56860d9530875eef499c1986b99a`.
- Generic package: no personal main URL or provider key supplied to packaging. Frozen lockfile and shared-source provenance are checked in.

## Automated evidence

- Production verification ran on BuildBot3 from committed `git archive` source, in an owned temporary directory, with Node `22.21.1`, pnpm `10.24.0`, `npm ci --ignore-scripts` and `pnpm install --frozen-lockfile`.
- Full backend suite: **1,181 passed, zero failed, one skipped**, 1,182 total. Full output retained locally at `/Users/shooby/Downloads/OpenAGI-G2-0.4.18-backend-test.log`.
- Client suite: **197 passed**, 19 test files; TypeScript and ESLint passed both locally and remotely.
- Production TypeScript/Vite build, Even packaging, 2 MiB bundle ceiling and packaged-secret scan: passed. Uncompressed production assets: 296,995 bytes.
- Focused local backend G2/auth/history/restart/cancellation/storage/retention checks: **29 passed**, also exercised by the full remote suite.
- Git staged and publication-range secret checks passed before publication; no hook bypass or force push.
- A Node 20 local client invocation could not start its test environment; rerunning with the declared Node 22 runtime passed. This was not counted as a passing run.
- The initial full backend run had one failure: a CommonJS test helper named `.js` inherited `/tmp/package.json` with `type: module`. The fixture is now `.cjs`; the full suite was rerun successfully without production helper changes.
- Read-only sample preview opened and exposed the Focused controls in browser accessibility state. Full visual/responsive screenshot review and physical gesture behavior are **not verified**. The owned preview server was stopped after inspection.

New PR CI verifies the backend and standalone client/package on future changes. GitHub status is separate from the completed remote checks and is checked once after publication, not polled indefinitely. This record precedes PR creation; the final handoff supplies the PR URL/current state.

## Try the design without a live connection

In `integration-clients/even-g2-overlay`, with Node 22.21.1 and pnpm 10.24.0: run `pnpm install --frozen-lockfile`, then `pnpm dev --host 127.0.0.1`. Open `http://127.0.0.1:5173/preview.html`. The preview uses sample content and has no microphone, SDK connection, server credentials or agent execution. The preview entry is excluded from the production package.

## Physical acceptance required before rollout

1. Clean install/pair on a supported phone + Even app + G2 firmware: paste a new card, confirm the main origin, complete one read-only question. Confirm an existing install retains pairing.
2. Compare Focused and Classic while a draft exists. Confirm consent and saved text are unchanged. Check narrow phone width, large text, contrast and page spacing.
3. Ask for 15 seconds, stop/send and interrupt phone networking before/after acceptance. Reopen and check the same request: one agent turn, retained answer, no silent resend. Cancel a deliberately selected read-only task and inspect the result.
4. History → conversation → follow-up stays in the exact main chat. Draft Back preserves text, explicit Discard removes it; answer scrolling never discards the result.
5. Enable Lifelog with participant consent, ask a question, return to the upper-right dot; Pause survives app reopening and Resume does not extend consent. Confirm final text actually appears on main.
6. Native root double-tap opens Even's exit confirmation; cancel it without losing state, then confirm exit stops capture. Verify actual press/release before relying on hold-to-talk.
7. With the existing experimental background option explicitly enabled, separately test lock/unlock and Bluetooth/network interruptions. Check capture **and saved text**, not just the dot. Record phone OS, Even app and glasses firmware. A failed lock-screen test blocks any reliable-background claim.

## Rollback

Use Settings' interface selector to compare Classic without reinstalling or resetting data. For source rollback, use a separate worktree at the baseline or revert the scoped commits; never hard-reset an active checkout. The preserved 0.4.17 bundle and both original-repository checkpoints are listed in `docs/scopes/g2-next/quickstart.md`. Source/UI rollback does not reverse agent actions or extend recording consent.
