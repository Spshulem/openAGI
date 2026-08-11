# Desktop reliability verification — 2026-08-11

Branch: `codex/openagi-desktop-reliability`

## Automated verification

- Bundled Node full suite: 865 passed, 0 failed, 0 cancelled.
- Focused OAuth, endpoint-migration, and Computer Use suite: 7 passed.
- Review queue suite: 8 passed, including complete oldest/newest pagination of
  1,005 rows without gaps or duplicates.
- Swift package suite: 14 passed, covering brief context, older-count decoding,
  permission policy/migration, and the native SSE parser.
- `git diff --check`: clean.

The bundled Node test runner paused the long `review-queue` worker while running
the aggregate suite on macOS. The worker was continued, after which the exact
aggregate run completed 865/865; the same file also completed 8/8 in isolation.

## Build and live checks

- `scripts/build-mac-app.sh` produced version 0.0.12 for arm64.
- Deep, strict code-signature verification passed.
- Signing authority: Developer ID Application, team `3AVR8P72M4`.
- The rebuilt worktree app was relaunched and its loopback health endpoint
  returned `{ "ok": true, "firstRun": false }`.
- Exact built-in endpoint migration reconnected Rize, BuildBetter production,
  BuildBetter staging, and Linear as both authenticated and connected.
- Computer Use was enabled through the authenticated local API. Readiness is
  `observe-only`: tools are registered, recent OCR is available, no control node
  is configured, and input is correctly reported unavailable.

## Public-repository checks

No API key, OAuth token, private callback, local data path, personal machine
name, or environment-specific service name is added by the implementation.
Built-in endpoint migration is generic and exact-match only. Local OAuth caches
and the opt-in Computer Use setting stay in the user's data directory.
