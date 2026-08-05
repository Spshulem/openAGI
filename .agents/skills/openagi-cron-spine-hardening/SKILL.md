---
name: openagi-cron-spine-hardening
description: Use when changing openAGI cron scheduling, ABI runtime ticks, cron job timeout behavior, file-backed cron markers, or hosted-interface cron timeout events.
---

# openAGI Cron Spine Hardening

## When to use

Use this skill when work touches `src/cron-scheduler.js`, `src/file-backed-cron-scheduler.js`, `src/abi-runtime.js` tick behavior, `src/hosted-interface.js` cron events, or tests named `test/cron-overlap-guard.test.js`, `test/cron-job-timeout.test.js`, or `test/cron-interruption.test.js`.

Use it for failures containing `TIMEOUT_MS`, `cron-job-timeout`, `cron tick still in flight`, `Promise resolution is still pending but the event loop has already resolved`, `marker on disk while the handler runs`, or `consumeInterruption`.

## Procedure

1. Preserve the three cron-spine properties as one contract.
   - `AbiRuntime.tick()` skips overlapping ticks instead of stacking them.
   - `CronScheduler.runDue()` races each job handler against a per-job timeout so one hung handler cannot stall later jobs.
   - `FileBackedCronScheduler` persists a running marker while a handler is executing and exposes a stale marker once through `consumeInterruption()` after a daemon restart.

2. Keep timeout constants and tests aligned.
   - `src/cron-scheduler.js` exports `TIMEOUT_MS` and `resolveJobTimeoutMs`.
   - `TIMEOUT_MS` is `10 * 60 * 1000`.
   - `resolveJobTimeoutMs` reads `OPENAGI_CRON_JOB_TIMEOUT_MS` and accepts only finite values greater than zero.
   - Tests import these symbols directly from `../src/cron-scheduler.js`.

3. Do not unref the timeout timer that resolves the handler race.
   - The timer inside the `Promise.race` timeout path stays refed.
   - If `timer.unref?.()` is added there, Node can end the subtest before the timeout fires and cancel pending tests.
   - Clear the timer in `finally` so the timer does not outlive the job fire.

4. Thread timeout options through file-backed scheduling.
   - `FileBackedCronScheduler.runDue(handler, now, options)` forwards `options` to `super.runDue(handler, now, options)`.
   - Saving remains tied to actual results so job state and running markers persist after fires.

5. Wire timeout visibility through the runtime and hosted interface.
   - `AbiRuntime` passes `onTimeout` to `cron.runDue` and emits `cron-job-timeout` on `this.events` with `at`, `jobId`, `jobName`, and `timeoutMs`.
   - `hosted-interface.js` broadcasts `cron-job-timeout` alongside existing cron events.

6. Verify focused cron tests before the broad suite.
   - Run `node --test test/cron-overlap-guard.test.js` after tick overlap changes.
   - Run `node --test test/cron-job-timeout.test.js` after timeout or event-bus changes.
   - Run `node --test test/cron-interruption.test.js` after file-backed running marker changes.
   - Run `npm test` when `src/abi-runtime.js`, `src/index.js`, or hosted runtime wiring changed.

## Failure signatures

- `# SyntaxError: The requested module '../src/cron-scheduler.js' does not provide an export named 'TIMEOUT_MS'`: export `TIMEOUT_MS` from `src/cron-scheduler.js`; do not change the test to hide the public contract.
- `error: 'Promise resolution is still pending but the event loop has already resolved'` in `test/cron-job-timeout.test.js` or `test/cron-overlap-guard.test.js`: the timeout timer that resolves the race was probably unrefed or the test left a never-resolving promise without a refed timeout path.
- `not ok ... runDue persists the running marker during the handler and clears it after` with `error: 'marker on disk while the handler runs'`: inspect `FileBackedCronScheduler.runDue`; it must persist `running` before the handler awaits and clear/save it after completion.
- `not ok ... consumeInterruption returns the stale marker once and clears it`: `load()` must stash the persisted `running` marker into `_interrupted`, reset `running`, and `consumeInterruption()` must clear the stale marker after returning it once.
- Full `npm test` fails later with `error: 'database is locked'` at `SessionIndex.init` after cron timeout tests: isolate the cron timeout test first, then apply the SQLite isolation skill only if the focused cron tests pass.

## Verification

- `node --test test/cron-overlap-guard.test.js` passes with the overlapping tick returning `[]` and the skipped-tick warning logged once per streak.
- `node --test test/cron-job-timeout.test.js` passes with timeout constants exported, hung jobs recorded as failed, `nextRunAt` advanced, and `cron-job-timeout` emitted.
- `node --test test/cron-interruption.test.js` passes with running markers persisted during a handler and consumed once after reload.
- `npm test` has no cron-related cancelled subtests and no cron-induced `SessionIndex.init` SQLite lock cascade.
