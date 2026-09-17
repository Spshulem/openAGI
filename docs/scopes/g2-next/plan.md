# Implementation plan

## Technical context and safety gates

Worktree: `/Users/shooby/Dev/openagi-pr101-rollout`, branch `codex/g2-experience-redesign`. Baseline: `08b80e194d3643ae1e9ca20a69c17d8560996648` (0.4.17 code plus approved scope).

Use existing TypeScript/DOM/Vite/Even SDK client and Node hosted interface. No new frontend framework, model worker, database service, public auth bypass, or automatic provider selection. Project constitution/template files are absent at the inspected standard locations; this plan follows the existing architecture and supplied safety instructions. BuildBetter customer artifacts are not applicable: evidence is the user's G2 feedback and linked source scope.

## Implementation

1. Finish rollback checkpoint and design contracts before source changes.
2. Add owner-only file-backed request receipts with injected temp-directory tests. Bound admission, lifetime, payload, response size, and execution; preserve an unconfirmed receipt after process interruption. Never persist audio or credentials.
3. Add an exact G2-scoped endpoint for capabilities, requests and conversation history. Reuse existing route authentication/CORS gates. Old ask/listen endpoints are unchanged.
4. Add capability-negotiated client request recovery. Save request identifiers before submission; reattach/read before offering another send. Explicit cancellation is separate from document visibility.
5. Improve phone structure using a separable layout/view model and a Classic switch. Keep existing selectors/actions where possible to avoid rewriting stable audio/consent code.
6. Add guided connection transfer and readiness, clearer Lifelog controls and history, typed primary-action state, draft-safe Back, and truthful public activity.
7. Use a reproducible OpenAGI-only build entry with pinned shared adapter inputs, while retaining the existing generic/base integration. Package one 0.4.18 candidate.
8. Verify focused tests locally; production build and package on BuildBot3 against committed source. Inspect/range-scan before a normal fast-forward push/PR. Leave physical acceptance unchecked.

## Rollback

The old source and artifact remain immutable. A user can choose Classic for a UI comparison without resetting storage. New APIs are additive; 0.4.17 stays a compatible rollback client. New data records live in a separate main data subdirectory and are not a migration of existing chat/credential stores. Reverting a source commit or reinstalling a client does not undo completed external actions.

Record scope still incomplete, test failures, deployment and device gates honestly; do not mark the entire design delivered just because an interface compiles.
