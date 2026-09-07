# Coding session watches verification

Scope: continuation of the proactive G2 inbox in PR #98, stacked on PR #97. No client bundle or version changes in this increment.

Passed with the packaged Node runtime:

```
node --test test/coding-supervisor.test.js test/coding-supervisor-http.test.js test/g2-proactive.test.js test/coding-supervisor-node.test.js test/builtin-coding-supervisor.test.js test/outreach-endpoints.test.js test/data-dir.test.js test/env-persistence.test.js
```

62 tests passed, zero failures. The focused supervisor tests also passed in the earlier run. Main Coding Agents script and G2 inbox script parse successfully. Tests use fixture sessions, temporary data, and mocked provider transports; no private live sessions were inspected or nudged.

Verified boundaries: opt-in watch creation, existing-session baseline, no automatic model or reply calls, exact coding-node approvals, authenticated owner HTTP/Origin checks, durable restart state, unchanged-event deduplication, missing-session handling, preview read failure, watch removal and shutdown during inspection, 20-watch/four-preview caps, G2 category gating and deduplicated notification claims, and resumed-session alert resolution.

Not verified: deployed main/server behavior, installed G2 version, physical glasses notification presentation, phone handoff, and live provider discovery completeness. The device acceptance sequence is in `docs/coding-session-watches.md`. This increment uses the previously prepared proactive client; no replacement bundle is needed specifically for watches.
