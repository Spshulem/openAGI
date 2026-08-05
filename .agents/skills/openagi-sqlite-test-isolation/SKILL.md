---
name: openagi-sqlite-test-isolation
description: Prevent and diagnose SQLite database locking failures in openAGI tests and store changes.
---

# openAGI SQLite Test Isolation

## When to use

Use this skill when working in openAGI on tests or code that touches SQLite-backed stores, hosted-interface endpoints, onboarding/health checks, memory/observation flows, runtime initialization, or any failure containing `database is locked`, `ERR_SQLITE_ERROR`, `ObservationStore.init`, or Node `node:test` output around SQLite.

## Procedure

1. Identify every SQLite-backed object the change touches before editing. Search for the store class, constructor, `resolveDataDir`, `node:sqlite`, and tests that instantiate hosted interfaces or runtimes.
2. Run the smallest focused test first, not the full suite. Use the exact test file that covers the changed store or endpoint, then expand only after it passes.
3. Ensure the test uses an isolated temporary data directory. Prefer the repo test helper if one exists; otherwise set a per-test temporary data dir and avoid reusing the developer's default openAGI data directory.
4. Check teardown before changing production code. Every test that creates a runtime, hosted interface, server, store, scheduler, or background loop should close or stop it in `t.after`, `afterEach`, or equivalent cleanup.
5. Avoid hidden parallel writers. If a test starts cron, runtime ticks, memory writes, hosted endpoints, or observation ingestion, verify that background work is stopped before the assertion block exits.
6. When a lock appears, rerun only the failing file with verbose TAP output and inspect the first `database is locked` stack. The first stack usually identifies the unclosed connection or shared data dir; later failures are often cascade noise.
7. Only after the focused file passes, run the package-level verification that the task requires. If the full suite still locks, split by related files to isolate the competing writer before editing unrelated code.

## Failure signatures

- `error: 'database is locked'` with `code: 'ERR_SQLITE_ERROR'`.
- Stack mentions `ObservationStore.init` or another store constructor during endpoint or runtime tests.
- A health, onboarding, memory, recall, or transcript test fails while unrelated earlier SQLite tests passed.
- Full `node --test` fails, but a focused store test passes, suggesting shared state or leaked background work.

## Verification

- Focused `node --test path/to/relevant.test.js` passes twice in a row.
- The test data directory is temporary or unique for the test run.
- Created runtimes, stores, servers, schedulers, and intervals are closed in teardown.
- A broader `node --test` or requested verification command passes, or any remaining lock is tied to a named competing test file.
