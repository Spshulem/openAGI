# Phase D: Harden the Spine (Week 4)

> **Read `00-INDEX.md` first** — its Global Constraints, decision gates, and execution protocol apply to every task below.
>
> **Drift rule:** Tasks in this plan share hot files (collision table in `00-INDEX.md`). If a Before-quote fails to match byte-for-byte and the difference is explained by an EARLIER task in this plan having edited that region (e.g. a new entry appended to `MAP` in `src/outreach-mapper.js`), apply the edit by intent — make the same change relative to the current code — and say so in the commit body. If the drift is NOT explained by an earlier plan task, STOP and report; the repo has moved since 2026-07-05.


---

<!-- verified:D1 status=fixed:2 -->
### Task D1: Cron spine hardening — overlap guard, per-job timeout, mid-run boot note
**Week:** 4 · **Size:** L · **Depends on:** none
**User story:** As Spencer (the openAGI owner), I want the cron heartbeat to never stack overlapping ticks, never let one hung job stall every later job, and never let a mid-run daemon death go unnoticed, so that scheduled proactive work keeps firing reliably 24/7 and silent failures become visible outreach items.
**Why (evidence):** The verified "cron-hardening" dossier entry confirms openAGI has no overlap guard (the ticker at src/hosted-interface.js:1406-1413 fires `runtime.tick()` unawaited every 10s; concurrent ticks can double-run a job because `nextRunAt` advances only after the handler resolves in src/cron-scheduler.js:38-47) and no per-job timeout (only a per-API-call abort exists in model-provider.js). The "crash-recovery" entry confirms an in-flight run interrupted by a daemon crash is simply abandoned with no boot-time note — Hermes marks and resumes; openAGI has nothing. Additionally, a throwing job handler currently aborts the whole `runDue` loop (no try/catch at src/cron-scheduler.js:41), leaving the job hot-retrying every 10s and later due jobs unfired.
**Acceptance criteria:**
- `node --test test/cron-overlap-guard.test.js` passes: two concurrent `runtime.tick()` calls never overlap; the second returns `[]`; a skip streak logs exactly one warning line.
- `node --test test/cron-job-timeout.test.js` passes: a never-resolving handler produces `{ failed: true, timedOut: true, error }` after the injected timeout, `nextRunAt` advances normally, later due jobs in the same fire still run, and `runtime.tick()` emits `cron-job-timeout` on the runtime event bus.
- `node --test test/cron-boot-marker.test.js` passes: `cron/jobs.json` carries `running: { runningJobId, startedAt }` while a handler executes and clears it after; a scheduler constructed over a store with a stale marker returns it once from `consumeInterruption()` and clears disk; booting `createHostedInterface` over such a store produces a durable outreach item of type `suggestion` naming the interrupted job.
- `grep -n "export const TIMEOUT_MS" src/cron-scheduler.js` prints one line; `OPENAGI_CRON_JOB_TIMEOUT_MS=banana` (or `-1`, `0`, `Infinity`) falls back to the 10-minute default (covered by test).
- `npm test` passes with zero failures.
- The plan explicitly documents (in a code comment in src/cron-scheduler.js) that `Promise.race` **abandons, not cancels**, the hung handler: it keeps running in the background. This is acceptable v1 because handlers are in-process async work that cannot be killed without worker isolation, and the property being bought is that the *schedule* keeps moving.

**Files:**
- Create: test/cron-overlap-guard.test.js
- Create: test/cron-job-timeout.test.js
- Create: test/cron-boot-marker.test.js
- Modify: src/abi-runtime.js:216 (`this.outputs = [];` in constructor), src/abi-runtime.js:584 (`async tick(now = new Date()) {`), src/abi-runtime.js:731-732 (`}, now);` closing of `runDue` call)
- Modify: src/cron-scheduler.js:1 (imports) and src/cron-scheduler.js:38-47 (`runDue`)
- Modify: src/file-backed-cron-scheduler.js:8-13 (constructor), :15-23 (`load`), :50-54 (`runDue`), :56-62 (`save`)
- Modify: src/hosted-interface.js:58 (`cron-catchup` broadcast line), src/hosted-interface.js:85-87 (`bindOutreachEvents` block)
- Modify: src/outreach-mapper.js:31-38 (last `MAP` entry)

**Interfaces:**
- Consumes (existing, copied from source):
  - `async runDue(handler, now = new Date())` — src/cron-scheduler.js:38 (being extended)
  - `save()` writing `{ version: 1, updatedAt: nowIso(), jobs: this.listJobs() }` — src/file-backed-cron-scheduler.js:56-62
  - `append({ type, sourceRef = null, title, summary = "", needsDecision = false, actions = [] })` — src/outreach-store.js:23 (emits `"outreach"` on `runtime.events`)
  - `runtime.events` — non-enumerable `EventEmitter` defined at src/hosted-interface.js:82-84; `runtime.bindOutreachEvents(events)` — src/abi-runtime.js:738
  - `nowIso()`, `createId(prefix)` — src/utils.js
  - `applyOutreachAction` default case (src/hosted-interface.js:1529-1530) returns silently for unknown `sourceRef.kind`, so a `"cron-job"` sourceRef is safe with `"dismiss"`.
- Produces (new; later tasks may rely on these):
  - `export const TIMEOUT_MS = 10 * 60 * 1000` and `export function resolveJobTimeoutMs(env = process.env)` in src/cron-scheduler.js
  - `async runDue(handler, now = new Date(), options = {})` where `options = { timeoutMs?: number, onTimeout?: (job, timeoutMs) => void }`; a failed fire's result shape is `{ failed: true, timedOut: boolean, error: string }`
  - `FileBackedCronScheduler.noteJobStart(job)`, `.noteJobEnd()`, `.consumeInterruption() → { runningJobId, startedAt, jobName } | null`; `jobs.json` gains optional top-level `running: { runningJobId, startedAt }`
  - Runtime-bus events: `"cron-job-timeout"` payload `{ at, jobId, jobName, timeoutMs }`; `"cron-interrupted"` payload `{ at, jobId, jobName, startedAt }` (both also SSE-broadcast)
  - `AbiRuntime._tickOnce(now)` (former tick body); `tick()` returns `[]` when skipped due to an in-flight tick.

#### Part 1 — Overlap guard

1. [ ] Create `test/cron-overlap-guard.test.js` with exactly this content:

```js
// test/cron-overlap-guard.test.js
// D1 part 1: the hosted-interface ticker fires runtime.tick() every 10s
// without awaiting it. A slow tick (LLM call inside a cron job) must not
// stack a second concurrent run — the runtime carries an in-flight flag
// and skipped ticks log once per streak, not once per skip.
import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultRuntime } from "../src/index.js";

test("second tick returns immediately while the first is still running", async () => {
  const runtime = createDefaultRuntime({ agentHost: false });
  let running = 0;
  let maxConcurrent = 0;
  runtime.cron.runDue = async () => {
    running += 1;
    maxConcurrent = Math.max(maxConcurrent, running);
    await new Promise((resolve) => setTimeout(resolve, 50));
    running -= 1;
    return [{ job: { id: "slow" }, result: { ok: true } }];
  };
  const [first, second] = await Promise.all([runtime.tick(), runtime.tick()]);
  assert.equal(maxConcurrent, 1, "ticks must never overlap");
  assert.equal(first.length, 1, "first tick ran the due jobs");
  assert.deepEqual(second, [], "overlapping tick returns [] without running jobs");
});

test("tick runs again normally after the in-flight tick finishes", async () => {
  const runtime = createDefaultRuntime({ agentHost: false });
  let calls = 0;
  runtime.cron.runDue = async () => {
    calls += 1;
    return [];
  };
  await runtime.tick();
  await runtime.tick();
  assert.equal(calls, 2, "sequential ticks both run");
});

test("skipped ticks log once per streak, not once per skip", { timeout: 5000 }, async () => {
  const runtime = createDefaultRuntime({ agentHost: false });
  let release = null;
  runtime.cron.runDue = () => new Promise((resolve) => { release = () => resolve([]); });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  try {
    const inFlight = runtime.tick();
    await runtime.tick(); // skip 1 — logs
    await runtime.tick(); // skip 2 — silent
    await runtime.tick(); // skip 3 — silent
    release();
    await inFlight;
  } finally {
    console.warn = originalWarn;
  }
  const skipLogs = warnings.filter((w) => w.includes("skipping overlapping tick"));
  assert.equal(skipLogs.length, 1, "one log line for the whole skip streak");
});
```

2. [ ] Run `node --test test/cron-overlap-guard.test.js`. Expect 2 failures: test 1 fails with `AssertionError [ERR_ASSERTION]: ticks must never overlap` (`2 !== 1`), and test 3 fails via its 5-second timeout (`test timed out after 5000ms`) — before the guard exists, the second `runtime.tick()` calls the stubbed `runDue` again, reassigning `release` to the new promise, so the first `await runtime.tick()` never settles; the `{ timeout: 5000 }` option converts that hang into a failure. Test 2 passes even before implementation — that is expected (it pins the non-regression path).

3. [ ] Edit `src/abi-runtime.js` — initialize guard state in the constructor. Replace this exact text (currently at lines 216-217):

```js
    this.outputs = [];
    this.feedback = [];
```

with:

```js
    this.outputs = [];
    this.feedback = [];
    // Overlap guard state for tick(): the hosted-interface ticker fires
    // every 10s without awaiting, so a slow tick must cause later fires
    // to skip instead of stacking concurrent runs of the same jobs.
    this._tickInFlight = false;
    this._tickSkips = 0;
```

4. [ ] Edit `src/abi-runtime.js` — wrap the tick. Replace this exact text (currently at lines 584-585):

```js
  async tick(now = new Date()) {
    this.memory.decay(now);
```

with:

```js
  async tick(now = new Date()) {
    // Skip, don't stack: if a previous tick is still awaiting (slow LLM call
    // inside a cron job), this fire returns immediately. Log once per skip
    // streak so a wedged tick is visible without spamming a line every 10s.
    if (this._tickInFlight) {
      this._tickSkips += 1;
      if (this._tickSkips === 1) {
        console.warn("[openagi] cron tick still in flight — skipping overlapping tick(s) until it finishes");
      }
      return [];
    }
    this._tickInFlight = true;
    try {
      return await this._tickOnce(now);
    } finally {
      this._tickInFlight = false;
      this._tickSkips = 0;
    }
  }

  async _tickOnce(now = new Date()) {
    this.memory.decay(now);
```

The rest of the former `tick` body (the catchup check and the `this.cron.runDue(...)` dispatcher) is untouched and now lives in `_tickOnce`.

5. [ ] Run `node --test test/cron-overlap-guard.test.js`. Expect all 3 tests to pass (`# tests 3`, `# fail 0`).

6. [ ] Run `npm test` from `/Users/you/Dev/openAGI`. Expect zero failures (the guard is transparent to every existing `await runtime.tick(...)` test because sequential awaited ticks never see the flag set).

7. [ ] Commit:
```
git add src/abi-runtime.js test/cron-overlap-guard.test.js
git commit -m "feat(cron): overlap guard - skip ticks while one is still in flight, log once per streak"
```

#### Part 2 — Per-job timeout

8. [ ] Create `test/cron-job-timeout.test.js` with exactly this content:

```js
// test/cron-job-timeout.test.js
// D1 part 2: every cron job handler races a per-job timeout so one hung
// handler (stuck LLM call, wedged MCP server) cannot stall the schedule.
// On timeout the fire records as failed, nextRunAt advances normally, and
// the runtime bus emits "cron-job-timeout". NOTE: Promise.race abandons the
// hung promise — it is not cancelled. Acceptable v1: the schedule keeps
// moving, which is the property these tests pin.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CronScheduler, TIMEOUT_MS, resolveJobTimeoutMs } from "../src/cron-scheduler.js";
import { createDefaultRuntime } from "../src/index.js";

test("TIMEOUT_MS defaults to 10 minutes; env override validated finite>0", () => {
  assert.equal(TIMEOUT_MS, 10 * 60 * 1000);
  assert.equal(resolveJobTimeoutMs({}), TIMEOUT_MS);
  assert.equal(resolveJobTimeoutMs({ OPENAGI_CRON_JOB_TIMEOUT_MS: "5000" }), 5000);
  assert.equal(resolveJobTimeoutMs({ OPENAGI_CRON_JOB_TIMEOUT_MS: "banana" }), TIMEOUT_MS);
  assert.equal(resolveJobTimeoutMs({ OPENAGI_CRON_JOB_TIMEOUT_MS: "-1" }), TIMEOUT_MS);
  assert.equal(resolveJobTimeoutMs({ OPENAGI_CRON_JOB_TIMEOUT_MS: "0" }), TIMEOUT_MS);
  assert.equal(resolveJobTimeoutMs({ OPENAGI_CRON_JOB_TIMEOUT_MS: "Infinity" }), TIMEOUT_MS);
});

test("a job that never resolves records a failed fire and the schedule advances", { timeout: 5000 }, async () => {
  const cron = new CronScheduler();
  cron.addJob({
    id: "hung",
    name: "Hung job",
    enabled: true,
    task: "test",
    intervalMs: 60_000,
    nextRunAt: "2026-01-01T00:00:00.000Z"
  });
  const timeouts = [];
  const results = await cron.runDue(
    () => new Promise(() => {}), // never settles
    new Date("2026-01-01T00:00:01.000Z"),
    { timeoutMs: 20, onTimeout: (job, ms) => timeouts.push({ id: job.id, ms }) }
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].result.failed, true);
  assert.equal(results[0].result.timedOut, true);
  assert.match(results[0].result.error, /timed out after 20ms/);
  assert.deepEqual(timeouts, [{ id: "hung", ms: 20 }]);
  const job = cron.listJobs()[0];
  assert.equal(job.lastRunAt, "2026-01-01T00:00:01.000Z");
  assert.equal(job.nextRunAt, "2026-01-01T00:01:01.000Z", "nextRunAt advanced normally");
});

test("a hung job does not block later due jobs in the same fire", { timeout: 5000 }, async () => {
  const cron = new CronScheduler();
  cron.addJob({ id: "hung", name: "Hung", enabled: true, task: "a", intervalMs: 60_000, nextRunAt: "2026-01-01T00:00:00.000Z" });
  cron.addJob({ id: "healthy", name: "Healthy", enabled: true, task: "b", intervalMs: 60_000, nextRunAt: "2026-01-01T00:00:00.500Z" });
  const results = await cron.runDue(
    (job) => (job.id === "hung" ? new Promise(() => {}) : Promise.resolve({ ok: true })),
    new Date("2026-01-01T00:00:01.000Z"),
    { timeoutMs: 20 }
  );
  assert.equal(results.length, 2);
  const healthy = results.find((r) => r.job.id === "healthy");
  assert.deepEqual(healthy.result, { ok: true });
});

test("a throwing handler records a failed fire instead of aborting the loop", async () => {
  const cron = new CronScheduler();
  cron.addJob({ id: "boom", name: "Boom", enabled: true, task: "a", intervalMs: 60_000, nextRunAt: "2026-01-01T00:00:00.000Z" });
  cron.addJob({ id: "after", name: "After", enabled: true, task: "b", intervalMs: 60_000, nextRunAt: "2026-01-01T00:00:00.500Z" });
  const results = await cron.runDue(
    (job) => (job.id === "boom" ? Promise.reject(new Error("handler exploded")) : Promise.resolve({ ok: true })),
    new Date("2026-01-01T00:00:01.000Z")
  );
  assert.equal(results.length, 2);
  const boom = results.find((r) => r.job.id === "boom");
  assert.equal(boom.result.failed, true);
  assert.equal(boom.result.timedOut, false);
  assert.match(boom.result.error, /handler exploded/);
  assert.deepEqual(results.find((r) => r.job.id === "after").result, { ok: true });
});

test("runtime tick emits cron-job-timeout on the event bus for a hung task", { timeout: 5000 }, async () => {
  const runtime = createDefaultRuntime({ agentHost: false });
  runtime.condenser.condense = () => new Promise(() => {}); // hang the handler
  runtime.cron.addJob({
    id: "hung-condense",
    name: "Hung condense",
    enabled: true,
    task: "condense",
    intervalMs: 60_000,
    nextRunAt: new Date(Date.now() - 1000).toISOString()
  });
  const bus = new EventEmitter();
  Object.defineProperty(runtime, "events", { value: bus, enumerable: false });
  const seen = [];
  bus.on("cron-job-timeout", (d) => seen.push(d));
  process.env.OPENAGI_CRON_JOB_TIMEOUT_MS = "25";
  let results;
  try {
    results = await runtime.tick(new Date());
  } finally {
    delete process.env.OPENAGI_CRON_JOB_TIMEOUT_MS;
  }
  const fired = results.find((r) => r.job.id === "hung-condense");
  assert.ok(fired, "hung job appears in tick results");
  assert.equal(fired.result.failed, true);
  assert.equal(fired.result.timedOut, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].jobId, "hung-condense");
  assert.equal(seen[0].jobName, "Hung condense");
  assert.equal(seen[0].timeoutMs, 25);
  assert.ok(seen[0].at, "event carries a timestamp");
});
```

9. [ ] Run `node --test test/cron-job-timeout.test.js`. Expect the whole file to fail at import time with `SyntaxError: The requested module '../src/cron-scheduler.js' does not provide an export named 'TIMEOUT_MS'`. (The `{ timeout: 5000 }` test options exist so that, mid-implementation, a still-hanging fire fails in 5s instead of hanging the runner forever.)

10. [ ] Edit `src/cron-scheduler.js` — add the constants and env parser. Replace this exact text (lines 1-3):

```js
import { createId, nowIso } from "./utils.js";

export class CronScheduler {
```

with:

```js
import { createId, nowIso } from "./utils.js";

// Per-job timeout: one hung handler (a stuck LLM call, a wedged MCP server)
// must not stall every later scheduled job. Each handler invocation in
// runDue() races a timer; on timeout the fire records as failed and
// nextRunAt advances normally. HONEST LIMITATION: Promise.race abandons the
// losing promise — the hung handler keeps running in the background; it is
// NOT cancelled. Acceptable v1 because handlers are in-process async work we
// cannot kill without worker isolation, and the property we need is that the
// schedule keeps moving; the leaked promise is bounded by process lifetime.
export const TIMEOUT_MS = 10 * 60 * 1000;

const TIMED_OUT = Symbol("cron-job-timed-out");

// Env override: OPENAGI_CRON_JOB_TIMEOUT_MS, parsed with Number and only
// honored when finite and > 0; anything else falls back to TIMEOUT_MS.
export function resolveJobTimeoutMs(env = process.env) {
  const raw = env.OPENAGI_CRON_JOB_TIMEOUT_MS;
  if (raw === undefined || raw === null || raw === "") return TIMEOUT_MS;
  const parsed = Number(raw);
  return (Number.isFinite(parsed) && parsed > 0) ? parsed : TIMEOUT_MS;
}

export class CronScheduler {
```

11. [ ] Edit `src/cron-scheduler.js` — replace `runDue`. Replace this exact text (currently lines 38-47):

```js
  async runDue(handler, now = new Date()) {
    const results = [];
    for (const job of this.dueJobs(now)) {
      const result = await handler(job);
      job.lastRunAt = (now instanceof Date ? now : new Date(now)).toISOString();
      job.nextRunAt = this.computeNextRun(job, new Date(job.lastRunAt)).toISOString();
      results.push({ job, result });
    }
    return results;
  }
```

with:

```js
  async runDue(handler, now = new Date(), options = {}) {
    const timeoutMs = options.timeoutMs ?? resolveJobTimeoutMs();
    const results = [];
    for (const job of this.dueJobs(now)) {
      // Mid-run marker hook: FileBackedCronScheduler persists a
      // { runningJobId, startedAt } note so a daemon death mid-job is
      // visible on the next boot. No-op on the in-memory scheduler.
      this.noteJobStart?.(job);
      let result;
      let timer = null;
      try {
        const raced = await Promise.race([
          handler(job),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
            timer.unref?.();
          })
        ]);
        if (raced === TIMED_OUT) {
          result = {
            failed: true,
            timedOut: true,
            error: `Job ${job.id} timed out after ${timeoutMs}ms (handler abandoned, not cancelled)`
          };
          options.onTimeout?.(job, timeoutMs);
        } else {
          result = raced;
        }
      } catch (error) {
        // A throwing handler used to abort the whole runDue loop, leaving
        // this job due again next tick (hot retry every 10s) and later due
        // jobs unfired. Record the failure and keep the schedule moving.
        result = { failed: true, timedOut: false, error: error?.message ?? String(error) };
      } finally {
        if (timer) clearTimeout(timer);
        this.noteJobEnd?.(job);
      }
      job.lastRunAt = (now instanceof Date ? now : new Date(now)).toISOString();
      job.nextRunAt = this.computeNextRun(job, new Date(job.lastRunAt)).toISOString();
      results.push({ job, result });
    }
    return results;
  }
```

(`noteJobStart` / `noteJobEnd` do not exist yet anywhere — the `?.()` calls are deliberate no-ops until Part 3 defines them on `FileBackedCronScheduler`.)

12. [ ] Edit `src/file-backed-cron-scheduler.js` — thread `options` through so a durable runtime's `tick()` timeout wiring is not silently dropped. Replace this exact text (currently lines 50-54):

```js
  async runDue(handler, now = new Date()) {
    const results = await super.runDue(handler, now);
    if (results.length > 0) this.save();
    return results;
  }
```

with:

```js
  async runDue(handler, now = new Date(), options = {}) {
    const results = await super.runDue(handler, now, options);
    if (results.length > 0) this.save();
    return results;
  }
```

13. [ ] Edit `src/abi-runtime.js` — emit the timeout event from the tick dispatcher. Replace this exact text (the closing of the `this.cron.runDue(...)` call, currently at lines 731-732, now inside `_tickOnce`):

```js
      return { skipped: true, reason: `No handler for task ${job.task}` };
    }, now);
```

with:

```js
      return { skipped: true, reason: `No handler for task ${job.task}` };
    }, now, {
      onTimeout: (job, timeoutMs) => {
        this.events?.emit?.("cron-job-timeout", {
          at: nowIso(),
          jobId: job.id,
          jobName: job.name,
          timeoutMs
        });
      }
    });
```

14. [ ] Edit `src/hosted-interface.js` — SSE-broadcast the new event so the dashboard/Mac app can see it. Replace this exact text (line 58):

```js
  events.on("cron-catchup", (data) => broadcast("cron-catchup", data));
```

with:

```js
  events.on("cron-catchup", (data) => broadcast("cron-catchup", data));
  events.on("cron-job-timeout", (data) => broadcast("cron-job-timeout", data));
```

15. [ ] Run `node --test test/cron-job-timeout.test.js`. Expect all 5 tests to pass (`# tests 5`, `# fail 0`).

16. [ ] Run `npm test`. Expect zero failures. (Existing cron tests pass handlers that resolve quickly, so the 10-minute default race never fires; the race timer is cleared in `finally` and `unref`ed, so no test lingers.)

17. [ ] Commit:
```
git add src/cron-scheduler.js src/file-backed-cron-scheduler.js src/abi-runtime.js src/hosted-interface.js test/cron-job-timeout.test.js
git commit -m "feat(cron): per-job timeout with failed-fire recording and cron-job-timeout event; schedule advances past hung or throwing jobs"
```

#### Part 3 — Mid-run boot note

18. [ ] Create `test/cron-boot-marker.test.js` with exactly this content:

```js
// test/cron-boot-marker.test.js
// D1 part 3: while a job handler runs, the file-backed scheduler persists a
// { runningJobId, startedAt } marker into cron/jobs.json. If the daemon dies
// mid-run, the next boot consumes the marker, emits "cron-interrupted", and
// the outreach mapper turns it into a durable feed item so the silent death
// is visible.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { FileBackedCronScheduler } from "../src/file-backed-cron-scheduler.js";
import { OutreachStore } from "../src/outreach-store.js";
import { OutreachMapper } from "../src/outreach-mapper.js";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

function tempStorePath(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(dir, "jobs.json");
}

test("runDue persists the running marker during the handler and clears it after", async () => {
  const storePath = tempStorePath("cron-marker-");
  const cron = new FileBackedCronScheduler({ storePath });
  cron.addJob({
    id: "digest",
    name: "Outreach digest",
    enabled: true,
    task: "outreach-digest",
    intervalMs: 3_600_000,
    nextRunAt: "2026-01-01T00:00:00.000Z"
  });
  let markerDuringRun = null;
  await cron.runDue(async (job) => {
    markerDuringRun = JSON.parse(fs.readFileSync(storePath, "utf8")).running ?? null;
    return { ok: true, jobId: job.id };
  }, new Date("2026-01-01T00:00:01.000Z"));
  assert.ok(markerDuringRun, "marker on disk while the handler runs");
  assert.equal(markerDuringRun.runningJobId, "digest");
  assert.ok(markerDuringRun.startedAt, "marker carries startedAt");
  const after = JSON.parse(fs.readFileSync(storePath, "utf8"));
  assert.equal(after.running ?? null, null, "marker cleared after the fire");
});

test("consumeInterruption returns the stale marker once and clears it", () => {
  const storePath = tempStorePath("cron-boot-");
  fs.writeFileSync(storePath, JSON.stringify({
    version: 1,
    jobs: [{
      id: "digest",
      name: "Outreach digest",
      enabled: true,
      task: "outreach-digest",
      intervalMs: 3_600_000,
      nextRunAt: "2026-01-01T01:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastRunAt: null
    }],
    running: { runningJobId: "digest", startedAt: "2026-01-01T00:00:00.000Z" }
  }));
  const cron = new FileBackedCronScheduler({ storePath });
  const marker = cron.consumeInterruption();
  assert.deepEqual(marker, {
    runningJobId: "digest",
    startedAt: "2026-01-01T00:00:00.000Z",
    jobName: "Outreach digest"
  });
  assert.equal(cron.consumeInterruption(), null, "second consume returns null");
  const onDisk = JSON.parse(fs.readFileSync(storePath, "utf8"));
  assert.equal(onDisk.running ?? null, null, "marker cleared on disk");
});

test("consumeInterruption returns null after a clean shutdown", () => {
  const storePath = tempStorePath("cron-clean-");
  const first = new FileBackedCronScheduler({ storePath });
  first.addJob({ id: "j1", name: "J1", enabled: true, task: "t", intervalMs: 60_000 });
  const second = new FileBackedCronScheduler({ storePath });
  assert.equal(second.consumeInterruption(), null);
});

test("cron-interrupted maps to a durable outreach suggestion naming the job", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-map-"));
  const events = new EventEmitter();
  const store = new OutreachStore({ dir, runtime: { events } });
  const mapper = new OutreachMapper({ store, events });
  mapper.attach();
  events.emit("cron-interrupted", {
    at: "2026-07-05T08:00:00.000Z",
    jobId: "weekly-harsh-review",
    jobName: "Weekly harsh review",
    startedAt: "2026-07-04T20:00:05.000Z"
  });
  const items = store.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "suggestion");
  assert.deepEqual(items[0].sourceRef, { kind: "cron-job", id: "weekly-harsh-review" });
  assert.match(items[0].title, /Weekly harsh review/);
  assert.equal(items[0].needsDecision, false);
  assert.ok(items[0].actions.includes("dismiss"));
});

test("boot emits cron-interrupted and the outreach feed shows the interrupted job", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-boot-app-"));
  process.env.OPENAGI_AUTH_TOKEN = "";
  const storePath = path.join(dataDir, "cron", "jobs.json");
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify({
    version: 1,
    jobs: [{
      id: "weekly-harsh-review",
      name: "Weekly harsh review",
      enabled: true,
      task: "autopilot",
      intervalMs: 7 * 24 * 60 * 60 * 1000,
      nextRunAt: "2099-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastRunAt: null
    }],
    running: { runningJobId: "weekly-harsh-review", startedAt: "2026-07-04T20:00:05.000Z" }
  }));
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, tickerMs: 0 });
  await app.listen();
  try {
    const items = runtime.outreach.list();
    const hit = items.find((i) => i.sourceRef?.kind === "cron-job" && i.sourceRef?.id === "weekly-harsh-review");
    assert.ok(hit, "durable outreach item exists for the interrupted job");
    assert.equal(hit.type, "suggestion");
    assert.match(hit.title, /Weekly harsh review/);
    const onDisk = JSON.parse(fs.readFileSync(storePath, "utf8"));
    assert.equal(onDisk.running ?? null, null, "marker cleared after boot");
  } finally {
    await app.close();
  }
});
```

19. [ ] Run `node --test test/cron-boot-marker.test.js`. Expect 5 failures: test 1 fails `marker on disk while the handler runs` (marker is `null` — the Part 2 hooks are no-ops); tests 2, 3 fail with `TypeError: cron.consumeInterruption is not a function`; test 4 fails `assert.equal(items.length, 1)` (`0 !== 1` — no MAP entry); test 5 fails `durable outreach item exists for the interrupted job`.

20. [ ] Edit `src/file-backed-cron-scheduler.js` — constructor state. Replace this exact text (lines 8-13):

```js
  constructor(options = {}) {
    super();
    this.storePath = options.storePath ?? path.join(resolveDataDir(), "cron", "jobs.json");
    ensureDir(path.dirname(this.storePath));
    if (options.autoLoad !== false) this.load();
  }
```

with:

```js
  constructor(options = {}) {
    super();
    this.storePath = options.storePath ?? path.join(resolveDataDir(), "cron", "jobs.json");
    ensureDir(path.dirname(this.storePath));
    // { runningJobId, startedAt } while a job handler is executing; persisted
    // into the store so a mid-run daemon death leaves a visible marker.
    this.running = null;
    // Marker found on disk at load time (previous process died mid-job).
    // Consumed once at boot via consumeInterruption().
    this._interrupted = null;
    if (options.autoLoad !== false) this.load();
  }
```

21. [ ] Edit `src/file-backed-cron-scheduler.js` — pick the marker up in `load()`. Replace this exact text (currently lines 15-23):

```js
  load() {
    const store = readJsonFile(this.storePath, { version: 1, jobs: [] });
    this.jobs = new Map();
    for (const job of store.jobs ?? []) {
      if (!job.id) continue;
      this.jobs.set(job.id, job);
    }
    return this.listJobs();
  }
```

with:

```js
  load() {
    const store = readJsonFile(this.storePath, { version: 1, jobs: [] });
    this.jobs = new Map();
    for (const job of store.jobs ?? []) {
      if (!job.id) continue;
      this.jobs.set(job.id, job);
    }
    // A persisted running marker means the previous process died while this
    // job's handler was executing. Stash it for consumeInterruption().
    this._interrupted = store.running ?? null;
    this.running = null;
    return this.listJobs();
  }
```

22. [ ] Edit `src/file-backed-cron-scheduler.js` — add the hooks + consumer and extend `save()`. Replace this exact text (currently lines 56-62):

```js
  save() {
    writeJsonAtomic(this.storePath, {
      version: 1,
      updatedAt: nowIso(),
      jobs: this.listJobs()
    });
  }
```

with:

```js
  // runDue() hooks (see CronScheduler.runDue): persist the mid-run marker
  // while a handler executes so a daemon death mid-job is visible next boot.
  noteJobStart(job) {
    this.running = { runningJobId: job.id, startedAt: nowIso() };
    this.save();
  }

  noteJobEnd() {
    this.running = null;
    this.save();
  }

  // Boot note: return the marker left by a process that died mid-job (or
  // null after a clean shutdown), clearing it from memory and disk. The
  // hosted interface calls this once at boot and emits "cron-interrupted".
  consumeInterruption() {
    const marker = this._interrupted;
    this._interrupted = null;
    if (!marker) return null;
    this.save();
    const job = marker.runningJobId ? this.jobs.get(marker.runningJobId) : null;
    return { ...marker, jobName: job?.name ?? (marker.runningJobId ?? "unknown") };
  }

  save() {
    writeJsonAtomic(this.storePath, {
      version: 1,
      updatedAt: nowIso(),
      jobs: this.listJobs(),
      ...(this.running ? { running: this.running } : {})
    });
  }
```

23. [ ] Edit `src/outreach-mapper.js` — map the event to a durable item. Replace this exact text (the last `MAP` entry plus the object close, currently lines 31-39):

```js
  "clarification-created": (d) => ({
    type: "clarification",
    sourceRef: { kind: "clarification", id: d.id },
    title: d.question ?? "Quick question",
    summary: d.context ?? "",
    needsDecision: true,
    actions: ["yes", "no", "in_progress", "dropped"]
  })
};
```

with:

```js
  "clarification-created": (d) => ({
    type: "clarification",
    sourceRef: { kind: "clarification", id: d.id },
    title: d.question ?? "Quick question",
    summary: d.context ?? "",
    needsDecision: true,
    actions: ["yes", "no", "in_progress", "dropped"]
  }),
  // A cron job was mid-run when the daemon died (mid-run boot marker).
  // Durable so Spencer SEES the silent death even if no client was
  // connected at boot; type "suggestion" puts it in the digest rollup.
  "cron-interrupted": (d) => ({
    type: "suggestion",
    sourceRef: { kind: "cron-job", id: d.jobId ?? "unknown" },
    title: `Scheduled job interrupted mid-run: ${d.jobName ?? (d.jobId ?? "unknown")}`,
    summary: `The daemon died while this job was running${d.startedAt ? ` (started ${d.startedAt})` : ""}. It will fire again on its normal schedule.`,
    needsDecision: false,
    actions: ["dismiss"]
  })
};
```

24. [ ] Edit `src/hosted-interface.js` — broadcast + consume at boot. First replace this exact text (added in step 14):

```js
  events.on("cron-job-timeout", (data) => broadcast("cron-job-timeout", data));
```

with:

```js
  events.on("cron-job-timeout", (data) => broadcast("cron-job-timeout", data));
  events.on("cron-interrupted", (data) => broadcast("cron-interrupted", data));
```

Then replace this exact text (currently lines 85-87):

```js
  // Proactive outreach mapper subscribes here: it was constructed before the
  // bus existed, so we late-bind the same bus now (mirrors bindEvents above).
  if (runtime.bindOutreachEvents) runtime.bindOutreachEvents(runtime.events);
```

with:

```js
  // Proactive outreach mapper subscribes here: it was constructed before the
  // bus existed, so we late-bind the same bus now (mirrors bindEvents above).
  if (runtime.bindOutreachEvents) runtime.bindOutreachEvents(runtime.events);

  // Mid-run boot note: if the previous process died while a cron job handler
  // was executing, the file-backed scheduler kept a { runningJobId, startedAt }
  // marker. Emit it now (the outreach mapper above is already attached, so it
  // lands as a durable feed item) and clear it. Optional-chained because the
  // in-memory CronScheduler has no marker support.
  const interruptedJob = runtime.cron?.consumeInterruption?.();
  if (interruptedJob) {
    events.emit("cron-interrupted", {
      at: new Date().toISOString(),
      jobId: interruptedJob.runningJobId,
      jobName: interruptedJob.jobName,
      startedAt: interruptedJob.startedAt
    });
  }
```

25. [ ] Run `node --test test/cron-boot-marker.test.js`. Expect all 5 tests to pass (`# tests 5`, `# fail 0`).

26. [ ] Run `npm test`. Expect zero failures. (The existing persistence test at test/abi-runtime.test.js:165-186 still passes: `save()` only adds the `running` key while a handler is mid-flight, and `consumeInterruption` is never called by it.)

27. [ ] Commit:
```
git add src/file-backed-cron-scheduler.js src/outreach-mapper.js src/hosted-interface.js test/cron-boot-marker.test.js
git commit -m "feat(cron): persist mid-run marker, emit cron-interrupted on boot, surface interrupted jobs as durable outreach items"
```

---

<!-- verified:D2 status=fixed:4 -->
### Task D2: Byte-stable system prompt so the Anthropic prompt cache actually hits
**Week:** 4 · **Size:** M · **Depends on:** none
**User story:** As Spencer (the openAGI owner), I want the daemon's system prompt to be byte-identical on every turn so that the `cache_control: ephemeral` marker actually produces cache reads, cutting per-turn token cost for an always-on agent instead of re-billing the full tool list + persona every message.
**Why (evidence):** Hermes advantage "context-compression" (hermes-advantages.md, docs/superpowers/plans/2026-07-05-openagi-gap-remediation/evidence/): openAGI sets `cache_control: { type: "ephemeral" }` on its system block at src/model-provider.js:232, but `buildDefaultInstructions` (src/model-provider.js:338-363) embeds per-turn memory hits and scrutiny action into that same system text, and the main chat path's `instructionsForAgent` (src/agent-host.js:299-336) embeds the scrutiny verdict, reasons, intuitions, ambient OCR, and screen context — so the cached prefix changes every turn and never matches. A side effect of the current wiring: memory hits passed to the provider from agent-host (src/agent-host.js:141-148) are silently dropped because `instructions` is always provided and `instructionsForAgent` never includes them; this task fixes that by carrying them in the per-turn context block. **Deliberately out of scope:** the 12-message sliding window (`messages.slice(-12)` at src/model-provider.js:88 and :237) stays exactly as-is — no summarization or compression in this task (YAGNI until the window demonstrably binds).
**Acceptance criteria:**
- `node --test test/prompt-cache-stability.test.js` reports 7 passing tests, 0 failing.
- The test asserts `body.system[0].text` is byte-identical across two consecutive Anthropic `generate()` calls that carry *different* `memoryHits`, and that `body.system[0].cache_control` equals `{ type: "ephemeral" }`.
- The test asserts the OpenAI request body's `instructions` string is byte-identical across two calls with different memory hits and that the serialized body contains no `cache_control` key.
- The test asserts the memory-hit content appears verbatim inside a `[context]`-delimited block at the start of the latest user message on both provider paths.
- `grep -c "slice(-12)" /Users/you/Dev/openAGI/src/model-provider.js` still prints `2` (sliding window untouched).
- `npm test` passes with 0 failures from the repo root.
- Manual A/B (steps 15-19): the memory codeword seeded in run A surfaces in run B's recall replies, and in run B `GET /budget` shows `tokens.cacheRead > 0` after the second message of the session.
**Files:**
- Create: test/prompt-cache-stability.test.js
- Modify: src/model-provider.js:79 (OpenAI `generate` signature), src/model-provider.js:84-95 (OpenAI conversation assembly), src/model-provider.js:222 (Anthropic `generate` signature), src/model-provider.js:227-242 (Anthropic system/convo assembly), src/model-provider.js:338-363 (`buildDefaultInstructions`)
- Modify: src/agent-host.js:133-152 (generate call in `handleMessage`), src/agent-host.js:299-336 (`instructionsForAgent` split)
- Modify: test/verdict-consequences.test.js:104-109 and :128-130 (verdict guidance moved to turn context)
**Interfaces:**
- Consumes (exact current signatures, copied from source):
  - `async generate({ input, instructions, messages = [], memoryHits = [], scrutiny, agent, tools = [], toolRegistry, context = {}, model: modelOverride, tier, task })` — OpenAIResponsesProvider, src/model-provider.js:79
  - `async generate({ input, instructions, messages = [], memoryHits = [], scrutiny, agent, toolRegistry, context = {}, model: modelOverride, tier, task })` — AnthropicProvider, src/model-provider.js:222
  - `export function buildDefaultInstructions({ agent, scrutiny, memoryHits })` — src/model-provider.js:338
  - `instructionsForAgent(agent, output, intuitions = [], ambientContext = null, screenContext = null)` — src/agent-host.js:299
  - `function verdictGuidance(action)` — src/agent-host.js:373 (unchanged, reused by the new method)
  - `export function formatScreenContextBlock(screenContext)` — src/agent-host.js:389 (unchanged, reused)
- Produces (later tasks may rely on these):
  - `export function buildDefaultInstructions({ agent })` — static-only; extra properties passed in the object are ignored; return value is byte-identical for the same `agent`.
  - `export function buildTurnContext({ scrutiny, memoryHits } = {})` — returns a `[context]\n...\n[/context]` string, or `""` when there is nothing per-turn.
  - Both providers' `generate` accept a new optional `turnContext` (string). When provided it is prepended to the latest user message as `` `${turnContext}\n\n${input}` ``; when omitted, the provider falls back to `buildTurnContext({ scrutiny, memoryHits })`. All 10 existing non-chat callers (memory-condenser.js:94, daily-planner.js:243, session-miner.js:133, proactive-observer.js:150/:538, task-sweep.js:93, skills.js:97, imessage-extractor.js:86, scrutiny-judge.js:40, pattern-miner.js:172) pass `instructions` plus empty `memoryHits` and no `scrutiny`, so the fallback returns `""` and their requests are byte-for-byte unchanged.
  - `AgentHost.instructionsForAgent(agent)` — static persona + standing instructions only (persona.test.js keeps passing: the old second positional arg is simply ignored).
  - `AgentHost.turnContextForAgent(output, memoryHits = [], intuitions = [], ambientContext = null, screenContext = null)` — new method returning the per-turn `[context]` block.

#### Steps

1. [ ] Record the pre-change commit SHA for the later A/B comparison (run A executes from a worktree pinned here):
   ```bash
   git -C /Users/you/Dev/openAGI rev-parse HEAD > /private/tmp/claude-501/-Users-you-Dev-openAGI/ab270c9b-cb07-44b2-8bf1-ed0a3e4e1270/scratchpad/ab-base-sha.txt
   cat /private/tmp/claude-501/-Users-you-Dev-openAGI/ab270c9b-cb07-44b2-8bf1-ed0a3e4e1270/scratchpad/ab-base-sha.txt
   ```
   Expected: one 40-char hex SHA printed.

2. [ ] Write the failing test file. Create `/Users/you/Dev/openAGI/test/prompt-cache-stability.test.js` with exactly this content:
   ```js
   // Prompt-cache stability: the system prompt must be byte-identical across
   // turns (so the Anthropic cache_control prefix actually hits), and everything
   // that changes per turn (memory hits, scrutiny) must travel in a [context]
   // block prepended to the latest user message instead.
   import { test } from "node:test";
   import assert from "node:assert/strict";
   import {
     buildDefaultInstructions,
     buildTurnContext,
     AnthropicProvider,
     OpenAIResponsesProvider
   } from "../src/model-provider.js";

   const agent = { id: "main", name: "Main Agent" };

   const hitsA = [
     { score: 0.91, item: { id: "mem_1", tier: "short", content: "Spencer prefers espresso" } }
   ];
   const hitsB = [
     { score: 0.42, item: { id: "mem_2", tier: "long", content: "Weekly review is on Sundays" } }
   ];

   test("buildDefaultInstructions is byte-identical regardless of per-turn inputs", () => {
     const first = buildDefaultInstructions({ agent, memoryHits: hitsA, scrutiny: { action: "act" } });
     const second = buildDefaultInstructions({ agent, memoryHits: hitsB, scrutiny: { action: "watch" } });
     assert.equal(first, second, "system text must not vary with memory hits or scrutiny");
     assert.doesNotMatch(first, /Spencer prefers espresso/);
     assert.doesNotMatch(first, /Top memory hits/);
     assert.doesNotMatch(first, /Current scrutiny action/);
   });

   test("buildTurnContext carries memory hits verbatim and the scrutiny action", () => {
     const block = buildTurnContext({ scrutiny: { action: "watch" }, memoryHits: hitsA });
     assert.match(block, /^\[context\]\n/);
     assert.match(block, /\[\/context\]$/);
     assert.match(block, /Current scrutiny action: watch\./);
     assert.ok(block.includes("- [short] Spencer prefers espresso"), "memory hit must appear verbatim");
   });

   test("buildTurnContext returns an empty string when there is nothing per-turn", () => {
     assert.equal(buildTurnContext(), "");
     assert.equal(buildTurnContext({}), "");
     assert.equal(buildTurnContext({ memoryHits: [] }), "");
   });

   test("Anthropic path: static system block keeps cache_control; per-turn context rides the user turn", async () => {
     const provider = new AnthropicProvider({ apiKey: "test-key", maxToolHops: 1 });
     const sentBodies = [];
     provider.postMessages = async (body) => {
       sentBodies.push(JSON.parse(JSON.stringify(body)));
       return { id: "msg_1", content: [{ type: "text", text: "ok" }] };
     };

     await provider.generate({ input: "first question", agent, memoryHits: hitsA, scrutiny: { action: "act" }, messages: [] });
     await provider.generate({ input: "second question", agent, memoryHits: hitsB, scrutiny: { action: "watch" }, messages: [] });

     const [first, second] = sentBodies;
     assert.equal(first.system[0].text, second.system[0].text, "cached system prefix must be byte-stable across turns");
     assert.deepEqual(first.system[0].cache_control, { type: "ephemeral" }, "cache marker must survive the split");
     assert.doesNotMatch(first.system[0].text, /Spencer prefers espresso/);

     const lastUser1 = first.messages.at(-1);
     assert.equal(lastUser1.role, "user");
     assert.match(lastUser1.content, /^\[context\]/);
     assert.ok(lastUser1.content.includes("- [short] Spencer prefers espresso"));
     assert.ok(lastUser1.content.endsWith("first question"));

     const lastUser2 = second.messages.at(-1);
     assert.ok(lastUser2.content.includes("- [long] Weekly review is on Sundays"));
     assert.ok(lastUser2.content.endsWith("second question"));
   });

   test("Anthropic path: an explicit turnContext wins over the fallback", async () => {
     const provider = new AnthropicProvider({ apiKey: "test-key", maxToolHops: 1 });
     let sent = null;
     provider.postMessages = async (body) => {
       sent = JSON.parse(JSON.stringify(body));
       return { id: "msg_1", content: [{ type: "text", text: "ok" }] };
     };
     await provider.generate({
       input: "hello",
       agent,
       instructions: "STATIC SYSTEM TEXT",
       turnContext: "[context]\ncustom block\n[/context]",
       memoryHits: hitsA,
       messages: []
     });
     assert.equal(sent.system[0].text, "STATIC SYSTEM TEXT");
     assert.equal(sent.messages.at(-1).content, "[context]\ncustom block\n[/context]\n\nhello");
   });

   test("OpenAI path: instructions stay byte-stable and context rides the user turn (no cache markers)", async () => {
     const provider = new OpenAIResponsesProvider({ apiKey: "test-key", maxToolHops: 1 });
     const sentBodies = [];
     provider.postResponses = async (body) => {
       sentBodies.push(JSON.parse(JSON.stringify(body)));
       return { id: "resp_1", output_text: "ok", output: [] };
     };

     await provider.generate({ input: "first question", agent, memoryHits: hitsA, scrutiny: { action: "act" }, messages: [] });
     await provider.generate({ input: "second question", agent, memoryHits: hitsB, scrutiny: { action: "watch" }, messages: [] });

     const [first, second] = sentBodies;
     assert.equal(first.instructions, second.instructions, "instructions must be byte-stable across turns");
     assert.equal(JSON.stringify(first).includes("cache_control"), false, "OpenAI path carries no cache markers");
     const lastUser = first.input.at(-1);
     assert.equal(lastUser.role, "user");
     assert.match(lastUser.content, /^\[context\]/);
     assert.ok(lastUser.content.includes("- [short] Spencer prefers espresso"));
     assert.ok(lastUser.content.endsWith("first question"));
   });
   ```

3. [ ] Run the new test and confirm it fails for the right reason:
   ```bash
   cd /Users/you/Dev/openAGI && node --test test/prompt-cache-stability.test.js
   ```
   Expected failure: `SyntaxError: The requested module '../src/model-provider.js' does not provide an export named 'buildTurnContext'` (the whole file errors; 0 tests pass).

4. [ ] Edit `/Users/you/Dev/openAGI/src/model-provider.js` — replace `buildDefaultInstructions` and add `buildTurnContext`. Replace this exact current code (lines 338-363):
   ```js
   export function buildDefaultInstructions({ agent, scrutiny, memoryHits }) {
     const memory = (memoryHits ?? [])
       .slice(0, 5)
       .map((hit) => `- [${hit.item.tier}] ${hit.item.content}`)
       .join("\n");
     return `You are ${agent?.name ?? "an OpenAGI agent"}, an always-on local assistant.

   Tools available to you (call them when useful):
   - remember(content, tags?, importance?) — save a durable note
   - recall(query, limit?) — search memory
   - schedule_message(prompt, delaySeconds | intervalSeconds | dailyAt, channel?, target?) — schedule a future prompt that pings the user back
   - list_skills / run_skill — invoke named skill prompts
   - list_mcp_tools / run_mcp_tool — invoke tools from connected MCP servers
   - list_sessions — see recent conversations

   Guidelines:
   - Be concise and conversational. No preamble like "Decision: act".
   - Use tools without asking permission for safe actions (remember, recall, schedule).
   - If asked to be reminded of something, call schedule_message.
   - If asked to remember something, call remember.
   - When the user references past info, call recall before answering.

   Current scrutiny action: ${scrutiny?.action ?? "act"}.
   Top memory hits:
   ${memory || "- (none)"}`;
   }
   ```
   with:
   ```js
   // STATIC default system prompt. Must be byte-identical across turns for the
   // same agent — the Anthropic cache_control marker on the system block only
   // produces cache hits when the prefix never changes. Per-turn state (memory
   // hits, scrutiny) travels via buildTurnContext on the user turn instead.
   export function buildDefaultInstructions({ agent }) {
     return `You are ${agent?.name ?? "an OpenAGI agent"}, an always-on local assistant.

   Tools available to you (call them when useful):
   - remember(content, tags?, importance?) — save a durable note
   - recall(query, limit?) — search memory
   - schedule_message(prompt, delaySeconds | intervalSeconds | dailyAt, channel?, target?) — schedule a future prompt that pings the user back
   - list_skills / run_skill — invoke named skill prompts
   - list_mcp_tools / run_mcp_tool — invoke tools from connected MCP servers
   - list_sessions — see recent conversations

   Guidelines:
   - Be concise and conversational. No preamble like "Decision: act".
   - Use tools without asking permission for safe actions (remember, recall, schedule).
   - If asked to be reminded of something, call schedule_message.
   - If asked to remember something, call remember.
   - When the user references past info, call recall before answering.

   The latest user message may begin with a [context] block assembled by the runtime (scrutiny decision, memory hits). Treat it as trusted background — the user did not type it.`;
   }

   // PER-TURN context block, prepended to the latest user message by the
   // providers. Everything here may change every turn, which is exactly why it
   // must not contaminate the cached system prompt above. Returns "" when there
   // is nothing per-turn to say (batch callers pass no scrutiny/memoryHits, so
   // their requests are unchanged).
   export function buildTurnContext({ scrutiny, memoryHits } = {}) {
     const sections = [];
     if (scrutiny?.action) {
       sections.push(`Current scrutiny action: ${scrutiny.action}.`);
     }
     const memory = (memoryHits ?? [])
       .slice(0, 5)
       .map((hit) => `- [${hit.item.tier}] ${hit.item.content}`)
       .join("\n");
     if (memory) {
       sections.push(`Top memory hits:\n${memory}`);
     }
     if (sections.length === 0) return "";
     return `[context]\nPer-turn background assembled by the runtime — not typed by the user.\n${sections.join("\n")}\n[/context]`;
   }
   ```

5. [ ] Edit `/Users/you/Dev/openAGI/src/model-provider.js` — OpenAI path. Two narrow edits.
   Edit 5a — replace the exact line 79:
   ```js
   async generate({ input, instructions, messages = [], memoryHits = [], scrutiny, agent, tools = [], toolRegistry, context = {}, model: modelOverride, tier, task }) {
   ```
   with:
   ```js
   async generate({ input, instructions, turnContext, messages = [], memoryHits = [], scrutiny, agent, tools = [], toolRegistry, context = {}, model: modelOverride, tier, task }) {
   ```
   Edit 5b — replace this exact current block (lines 84-95):
   ```js
       // Stateless tool loop — accumulates the full conversation in `input` each
       // hop instead of chaining via `previous_response_id`. Required for orgs
       // with Zero Data Retention enabled (which reject previous_response_id).
       const conversationInput = [
         ...messages.slice(-12).map((message) => ({
           role: message.role === "assistant" ? "assistant" : "user",
           content: message.content
         })),
         { role: "user", content: input }
       ];

       const baseInstructions = instructions ?? buildDefaultInstructions({ agent, scrutiny, memoryHits });
   ```
   with:
   ```js
       // Stateless tool loop — accumulates the full conversation in `input` each
       // hop instead of chaining via `previous_response_id`. Required for orgs
       // with Zero Data Retention enabled (which reject previous_response_id).
       // Per-turn context (memory hits, scrutiny) rides the latest user turn so
       // `instructions` stays byte-stable across turns (mirrors the Anthropic
       // path; no cache markers here — OpenAI caching is implicit).
       const contextBlock = turnContext ?? buildTurnContext({ scrutiny, memoryHits });
       const conversationInput = [
         ...messages.slice(-12).map((message) => ({
           role: message.role === "assistant" ? "assistant" : "user",
           content: message.content
         })),
         { role: "user", content: contextBlock ? `${contextBlock}\n\n${input}` : input }
       ];

       const baseInstructions = instructions ?? buildDefaultInstructions({ agent });
   ```

6. [ ] Edit `/Users/you/Dev/openAGI/src/model-provider.js` — Anthropic path. Two narrow edits.
   Edit 6a — replace the exact line 222:
   ```js
   async generate({ input, instructions, messages = [], memoryHits = [], scrutiny, agent, toolRegistry, context = {}, model: modelOverride, tier, task }) {
   ```
   with:
   ```js
   async generate({ input, instructions, turnContext, messages = [], memoryHits = [], scrutiny, agent, toolRegistry, context = {}, model: modelOverride, tier, task }) {
   ```
   Edit 6b — replace this exact current block (lines 227-242):
   ```js
       const tools = toolRegistry?.toAnthropicTools?.() ?? [];
       const system = [
         {
           type: "text",
           text: instructions ?? buildDefaultInstructions({ agent, scrutiny, memoryHits }),
           cache_control: { type: "ephemeral" }
         }
       ];

       const convo = [
         ...messages.slice(-12).map((m) => ({
           role: m.role === "assistant" ? "assistant" : "user",
           content: m.content
         })),
         { role: "user", content: input }
       ];
   ```
   with:
   ```js
       const tools = toolRegistry?.toAnthropicTools?.() ?? [];
       // The system block is STATIC (persona + standing instructions) so this
       // cache_control prefix is byte-identical every turn and actually hits.
       // Per-turn context (memory hits, scrutiny) rides the latest user turn.
       const system = [
         {
           type: "text",
           text: instructions ?? buildDefaultInstructions({ agent }),
           cache_control: { type: "ephemeral" }
         }
       ];

       const contextBlock = turnContext ?? buildTurnContext({ scrutiny, memoryHits });
       const convo = [
         ...messages.slice(-12).map((m) => ({
           role: m.role === "assistant" ? "assistant" : "user",
           content: m.content
         })),
         { role: "user", content: contextBlock ? `${contextBlock}\n\n${input}` : input }
       ];
   ```

7. [ ] Run the new test file — all 6 tests must pass:
   ```bash
   cd /Users/you/Dev/openAGI && node --test test/prompt-cache-stability.test.js
   ```
   Expected: `pass 6`, `fail 0`.

8. [ ] Run the full suite (agent-host still sends its old combined instructions this commit — that is fine: no test inspects the user-message content of chat turns, and the fallback returns "" for all batch callers):
   ```bash
   cd /Users/you/Dev/openAGI && npm test
   ```
   Expected: 0 failures. Then commit:
   ```bash
   cd /Users/you/Dev/openAGI && git add src/model-provider.js test/prompt-cache-stability.test.js && git commit -m "fix(model-provider): keep the cached system prompt byte-stable; per-turn memory and scrutiny ride the user turn" && git push
   ```

9. [ ] Append the agent-host failing test to `/Users/you/Dev/openAGI/test/prompt-cache-stability.test.js` (add at end of file, after the last test):
   ```js
   test("agent-host: instructionsForAgent is static and turnContextForAgent carries the per-turn state", async () => {
     const { AgentHost } = await import("../src/agent-host.js");
     const host = new AgentHost({
       runtime: { processSignal: () => ({}) },
       modelProvider: { isConfigured: () => true, generate: async () => ({ text: "ok", provider: "stub", model: "stub", toolCalls: [] }) }
     });
     const agentObj = { id: "main", name: "Peri", role: "main", systemPrompt: "Be direct, no fluff." };

     const staticPrompt = host.instructionsForAgent(agentObj);
     assert.equal(staticPrompt, host.instructionsForAgent(agentObj), "static prompt must be byte-identical across calls");
     assert.match(staticPrompt, /Be direct, no fluff\./);
     assert.match(staticPrompt, /You are Peri/);
     assert.doesNotMatch(staticPrompt, /Current decision/);
     assert.doesNotMatch(staticPrompt, /Top memory hits/);

     const output = { scrutiny: { action: "watch", score: 0.4, reasons: ["stub reason"], dimensions: {} } };
     const intuitions = [{ score: 0.5, text: "prefer smaller diffs" }];
     const ctx = host.turnContextForAgent(output, hitsA, intuitions, null, null);
     assert.match(ctx, /^\[context\]\n/);
     assert.match(ctx, /Current decision: watch/);
     assert.match(ctx, /This turn: observation mode/);
     assert.ok(ctx.includes("- [short] Spencer prefers espresso"), "memory hits must appear verbatim in the turn context");
     assert.match(ctx, /prefer smaller diffs/);
     assert.match(ctx, /\[\/context\]$/);
   });
   ```

10. [ ] Update `/Users/you/Dev/openAGI/test/verdict-consequences.test.js` to expect the guidance in the turn context. Two narrow edits.
    Edit 10a — replace this exact current code (lines 104-109):
    ```js
          generate: async (args) => {
            captured.tools = args.tools;
            captured.context = args.context;
            captured.instructions = args.instructions;
            return { text: "ok", provider: "stub", model: "stub", id: "r1", toolCalls: [] };
          }
    ```
    with:
    ```js
          generate: async (args) => {
            captured.tools = args.tools;
            captured.context = args.context;
            captured.instructions = args.instructions;
            captured.turnContext = args.turnContext;
            return { text: "ok", provider: "stub", model: "stub", id: "r1", toolCalls: [] };
          }
    ```
    Edit 10b — replace this exact current code (lines 128-130):
    ```js
        if (verdict !== "act" && verdict !== "propagate" && verdict !== "ignore") {
          assert.match(captured.instructions, /This turn:/, `${verdict}: instructions explain the gate`);
        }
    ```
    with:
    ```js
        if (verdict !== "act" && verdict !== "propagate" && verdict !== "ignore") {
          assert.match(captured.turnContext, /This turn:/, `${verdict}: the per-turn context explains the gate`);
          assert.doesNotMatch(captured.instructions, /This turn:/, `${verdict}: static instructions stay verdict-free`);
        }
    ```

11. [ ] Run both test files and confirm the new failures:
    ```bash
    cd /Users/you/Dev/openAGI && node --test test/prompt-cache-stability.test.js test/verdict-consequences.test.js
    ```
    Expected failures: the appended agent-host test fails with `TypeError: Cannot read properties of undefined (reading 'scrutiny')` — the old `instructionsForAgent(agent, output, ...)` dereferences `output.scrutiny.action` and the test passes no `output` (it never even reaches the missing `turnContextForAgent`); the verdict test fails on `captured.turnContext` being `undefined` (assert.match rejects a non-string). The 6 provider tests still pass.

12. [ ] Edit `/Users/you/Dev/openAGI/src/agent-host.js` — split the prompt in `handleMessage`. Replace this exact current code (lines 133-152, up to and including `toolRegistry,`):
    ```js
        const modelResult = await this.modelProvider.generate({
          input: text,
          agent,
          // Route by what the call IS, so model tiering applies: autonomous pulses
          // (autopilot/cron) are cheap "anything to do?" work; everything else is
          // user-facing chat. Both default to the base model until tiers/pins are set.
          task: (channel === "autopilot" || channel === "cron") ? "autopilot" : "chat",
          scrutiny: output.scrutiny,
          memoryHits: output.customContext.map((entry) => ({
            score: entry.score,
            item: {
              id: entry.id,
              tier: entry.tier,
              content: entry.content
            }
          })),
          messages: sessionBefore.messages,
          instructions: this.instructionsForAgent(agent, output, intuitions, ambientContext, input.metadata?.screenContext ?? null),
          tools,
          toolRegistry,
    ```
    with:
    ```js
        const memoryHits = output.customContext.map((entry) => ({
          score: entry.score,
          item: {
            id: entry.id,
            tier: entry.tier,
            content: entry.content
          }
        }));

        const modelResult = await this.modelProvider.generate({
          input: text,
          agent,
          // Route by what the call IS, so model tiering applies: autonomous pulses
          // (autopilot/cron) are cheap "anything to do?" work; everything else is
          // user-facing chat. Both default to the base model until tiers/pins are set.
          task: (channel === "autopilot" || channel === "cron") ? "autopilot" : "chat",
          scrutiny: output.scrutiny,
          memoryHits,
          messages: sessionBefore.messages,
          // Static per-agent prompt (byte-stable, so the provider's prompt cache
          // hits) + per-turn context (scrutiny, memory hits, intuitions,
          // observations) that rides the latest user turn instead.
          instructions: this.instructionsForAgent(agent),
          turnContext: this.turnContextForAgent(output, memoryHits, intuitions, ambientContext, input.metadata?.screenContext ?? null),
          tools,
          toolRegistry,
    ```

13. [ ] Edit `/Users/you/Dev/openAGI/src/agent-host.js` — replace the whole `instructionsForAgent` method (current lines 299-336, quoted in full below) with the static version plus the new `turnContextForAgent` method. Replace this exact current code:
    ```js
      instructionsForAgent(agent, output, intuitions = [], ambientContext = null, screenContext = null) {
        const intuitionBlock = intuitions.length > 0
          ? `\nIntuitions (distilled long-term principles, may apply):\n${intuitions.map((i) => `- (${i.score.toFixed(2)}) ${i.text}`).join("\n")}\n`
          : "";

        let ambientBlock = "";
        if (ambientContext && (ambientContext.apps?.length || ambientContext.snippets?.length)) {
          const lines = ["", "Recent on-screen activity (last ~10 minutes — opt-in screen capture, on-device OCR):"];
          if (ambientContext.apps?.length) {
            lines.push(`Active apps: ${ambientContext.apps.map((a) => `${a.app} (${a.n})`).join(", ")}`);
          }
          if (ambientContext.snippets?.length) {
            lines.push("Recent screen snippets:");
            for (const s of ambientContext.snippets) {
              const stamp = (s.at || "").slice(11, 16); // HH:MM
              const where = s.window ? `${s.app} · ${s.window}` : s.app;
              lines.push(`- [${stamp} ${where}] ${s.text}`);
            }
          }
          lines.push("Use this to ground your reply in what the user is actually doing. Don't quote the snippets back verbatim — refer to them naturally if relevant.");
          ambientBlock = lines.join("\n") + "\n";
        }

        const screenBlock = formatScreenContextBlock(screenContext);

        return `${agent.systemPrompt ? `${agent.systemPrompt}\n\n` : ""}You are ${agent.name}, an always-on OpenAGI agent.

    Your job is to help through the ABI loop:
    1. Apply directional adaptive scrutiny.
    2. Use memory deliberately. When the user CORRECTS something you previously stored or said (a time, a name, a decision, a preference), call correct_memory with the corrected fact — never just remember a second conflicting version.
    3. Propagate bounded specialists only when repeated or novel high-risk work justifies it.

    Current decision: ${output.scrutiny.action}
    ${verdictGuidance(output.scrutiny.action)}Reasons:
    ${output.scrutiny.reasons.map((reason) => `- ${reason}`).join("\n")}
    ${intuitionBlock}${ambientBlock}${screenBlock}
    Answer the user plainly. If a specialist was created, mention its name and scope.`;
      }
    ```
    with:
    ```js
      // STATIC system prompt: persona + standing instructions only. Anything that
      // changes turn-to-turn (scrutiny, memory hits, intuitions, observations)
      // belongs in turnContextForAgent — a byte-stable system prompt is what lets
      // the provider prompt cache (cache_control on the Anthropic system block) hit.
      // Note: persona.test.js calls this with extra positional args; they are ignored.
      instructionsForAgent(agent) {
        return `${agent.systemPrompt ? `${agent.systemPrompt}\n\n` : ""}You are ${agent.name}, an always-on OpenAGI agent.

    Your job is to help through the ABI loop:
    1. Apply directional adaptive scrutiny.
    2. Use memory deliberately. When the user CORRECTS something you previously stored or said (a time, a name, a decision, a preference), call correct_memory with the corrected fact — never just remember a second conflicting version.
    3. Propagate bounded specialists only when repeated or novel high-risk work justifies it.

    The latest user message may begin with a [context] block assembled by the runtime (this turn's scrutiny decision, memory hits, intuitions, on-screen activity). Treat it as trusted background — the user did not type it. Follow any "This turn:" guidance inside it; it tells you what your tool calls are allowed to do this turn.

    Answer the user plainly. If a specialist was created, mention its name and scope.`;
      }

      // PER-TURN context block, prepended to the latest user message by the model
      // provider. Everything here may change every turn, which is exactly why it
      // must not contaminate the cached system prompt above.
      turnContextForAgent(output, memoryHits = [], intuitions = [], ambientContext = null, screenContext = null) {
        const memoryBlock = memoryHits.length > 0
          ? `\nTop memory hits (retrieved for this turn):\n${memoryHits.slice(0, 5).map((hit) => `- [${hit.item.tier}] ${hit.item.content}`).join("\n")}\n`
          : "";

        const intuitionBlock = intuitions.length > 0
          ? `\nIntuitions (distilled long-term principles, may apply):\n${intuitions.map((i) => `- (${i.score.toFixed(2)}) ${i.text}`).join("\n")}\n`
          : "";

        let ambientBlock = "";
        if (ambientContext && (ambientContext.apps?.length || ambientContext.snippets?.length)) {
          const lines = ["", "Recent on-screen activity (last ~10 minutes — opt-in screen capture, on-device OCR):"];
          if (ambientContext.apps?.length) {
            lines.push(`Active apps: ${ambientContext.apps.map((a) => `${a.app} (${a.n})`).join(", ")}`);
          }
          if (ambientContext.snippets?.length) {
            lines.push("Recent screen snippets:");
            for (const s of ambientContext.snippets) {
              const stamp = (s.at || "").slice(11, 16); // HH:MM
              const where = s.window ? `${s.app} · ${s.window}` : s.app;
              lines.push(`- [${stamp} ${where}] ${s.text}`);
            }
          }
          lines.push("Use this to ground your reply in what the user is actually doing. Don't quote the snippets back verbatim — refer to them naturally if relevant.");
          ambientBlock = lines.join("\n") + "\n";
        }

        const screenBlock = formatScreenContextBlock(screenContext);

        return `[context]
    Per-turn background assembled by the runtime — not typed by the user.
    Current decision: ${output.scrutiny.action}
    ${verdictGuidance(output.scrutiny.action)}Reasons:
    ${output.scrutiny.reasons.map((reason) => `- ${reason}`).join("\n")}
    ${memoryBlock}${intuitionBlock}${ambientBlock}${screenBlock}[/context]`;
      }
    ```
    (The code blocks above sit inside a markdown list, so every line carries a uniform 4-space list indent — strip that when copying. After stripping, method lines have 2 leading spaces and lines inside the backtick template literals start at column 0, exactly as in the current file. In the written file, every line inside a template literal must have no leading spaces; if your exact-match replace fails, re-check that you stripped only the 4-space list indent and nothing else.)

14. [ ] Run the targeted tests, then the full suite:
    ```bash
    cd /Users/you/Dev/openAGI && node --test test/prompt-cache-stability.test.js test/verdict-consequences.test.js test/persona.test.js test/agent-host-screen-context.test.js
    ```
    Expected: all pass (prompt-cache-stability now reports `pass 7`; persona passes because the extra positional arg is ignored; screen-context passes because `formatScreenContextBlock` is unchanged). Then:
    ```bash
    cd /Users/you/Dev/openAGI && npm test
    ```
    Expected: 0 failures. Also verify the sliding window is untouched:
    ```bash
    grep -c "slice(-12)" /Users/you/Dev/openAGI/src/model-provider.js
    ```
    Expected output: `2`. Then commit:
    ```bash
    cd /Users/you/Dev/openAGI && git add src/agent-host.js test/prompt-cache-stability.test.js test/verdict-consequences.test.js && git commit -m "fix(agent-host): split static instructions from per-turn context so the provider prompt cache hits" && git push
    ```

15. [ ] Manual A/B verification — setup. This checks that moving memory/scrutiny context from system to user position did not break memory recall, and that cache reads now occur. Requires a real `ANTHROPIC_API_KEY` exported in the shell. If `printenv ANTHROPIC_API_KEY` prints nothing, STOP this step, ask Spencer to export one, and do not read it out of ~/.openagi/.env (personal data dir). Create scratch data dirs and a worktree pinned to the pre-change SHA from step 1 (the repo has zero npm dependencies, so the worktree runs standalone):
    ```bash
    SCRATCH=/private/tmp/claude-501/-Users-you-Dev-openAGI/ab270c9b-cb07-44b2-8bf1-ed0a3e4e1270/scratchpad
    mkdir -p "$SCRATCH/ab-data-before" "$SCRATCH/ab-data-after"
    git -C /Users/you/Dev/openAGI worktree add "$SCRATCH/ab-base" "$(cat $SCRATCH/ab-base-sha.txt)"
    ```

16. [ ] Run A (pre-change code). Start the old daemon on a throwaway port/data dir, send 3 fixed prompts in one session, capture replies, then stop it (killing this PID is a background dev process we started — allowed):
    ```bash
    SCRATCH=/private/tmp/claude-501/-Users-you-Dev-openAGI/ab270c9b-cb07-44b2-8bf1-ed0a3e4e1270/scratchpad
    OPENAGI_DATA_DIR="$SCRATCH/ab-data-before" PORT=43998 node "$SCRATCH/ab-base/examples/hosted-server.js" > "$SCRATCH/ab-before-server.log" 2>&1 &
    echo $! > "$SCRATCH/ab-before-pid.txt"; sleep 3
    curl -s -X POST http://127.0.0.1:43998/message -H 'content-type: application/json' -d '{"sessionId":"ab-test","text":"Remember: the AB cache test codeword is heliotrope-42."}' > "$SCRATCH/ab-before-1.json"
    curl -s -X POST http://127.0.0.1:43998/message -H 'content-type: application/json' -d '{"sessionId":"ab-test","text":"What is the AB cache test codeword?"}' > "$SCRATCH/ab-before-2.json"
    curl -s -X POST http://127.0.0.1:43998/message -H 'content-type: application/json' -d '{"sessionId":"ab-test","text":"Summarize everything you know about the AB cache test."}' > "$SCRATCH/ab-before-3.json"
    curl -s http://127.0.0.1:43998/budget > "$SCRATCH/ab-before-budget.json"
    kill "$(cat $SCRATCH/ab-before-pid.txt)"
    grep -c "heliotrope-42" "$SCRATCH/ab-before-2.json" "$SCRATCH/ab-before-3.json"
    ```
    Expected: the final grep prints a count of at least 1 for `ab-before-2.json` (the codeword surfaces in the recall reply).

17. [ ] Run B (post-change code). Same 3 prompts against the new code with a fresh data dir:
    ```bash
    SCRATCH=/private/tmp/claude-501/-Users-you-Dev-openAGI/ab270c9b-cb07-44b2-8bf1-ed0a3e4e1270/scratchpad
    OPENAGI_DATA_DIR="$SCRATCH/ab-data-after" PORT=43999 node /Users/you/Dev/openAGI/examples/hosted-server.js > "$SCRATCH/ab-after-server.log" 2>&1 &
    echo $! > "$SCRATCH/ab-after-pid.txt"; sleep 3
    curl -s -X POST http://127.0.0.1:43999/message -H 'content-type: application/json' -d '{"sessionId":"ab-test","text":"Remember: the AB cache test codeword is heliotrope-42."}' > "$SCRATCH/ab-after-1.json"
    curl -s -X POST http://127.0.0.1:43999/message -H 'content-type: application/json' -d '{"sessionId":"ab-test","text":"What is the AB cache test codeword?"}' > "$SCRATCH/ab-after-2.json"
    curl -s -X POST http://127.0.0.1:43999/message -H 'content-type: application/json' -d '{"sessionId":"ab-test","text":"Summarize everything you know about the AB cache test."}' > "$SCRATCH/ab-after-3.json"
    curl -s http://127.0.0.1:43999/budget > "$SCRATCH/ab-after-budget.json"
    kill "$(cat $SCRATCH/ab-after-pid.txt)"
    grep -c "heliotrope-42" "$SCRATCH/ab-after-2.json" "$SCRATCH/ab-after-3.json"
    ```
    Expected: grep count of at least 1 for `ab-after-2.json`.

18. [ ] Compare A vs B and record the verdict. Expected equivalence: reply *wording* will differ (different sampling, different prompt position), but (a) the codeword fact must surface in the recall replies of BOTH runs — that proves memory context moved to the user turn is still consumed by the model — and (b) cache behavior must improve in B:
    ```bash
    SCRATCH=/private/tmp/claude-501/-Users-you-Dev-openAGI/ab270c9b-cb07-44b2-8bf1-ed0a3e4e1270/scratchpad
    python3 -c "import json; b=json.load(open('$SCRATCH/ab-before-budget.json')); a=json.load(open('$SCRATCH/ab-after-budget.json')); print('before cacheRead:', b['tokens']['cacheRead'], 'after cacheRead:', a['tokens']['cacheRead'])"
    ```
    Expected: `after cacheRead` is greater than 0 (turns 2 and 3 read the cached tools+system prefix written by turn 1); `before cacheRead` is 0 or near 0 (the per-turn system text broke the prefix). If `after cacheRead` is 0, the split has a bug — diff `system[0].text` between two consecutive requests by adding a temporary `console.error(JSON.stringify(body.system))` in `postMessages`, re-run, find the varying substring, and move that substring into `turnContextForAgent`; remove the temporary line before committing anything.

19. [ ] Clean up the A/B worktree (removal of the worktree checkout only — it contains no uncommitted work; the scratch data dirs are left for the OS to reap):
    ```bash
    git -C /Users/you/Dev/openAGI worktree remove /private/tmp/claude-501/-Users-you-Dev-openAGI/ab270c9b-cb07-44b2-8bf1-ed0a3e4e1270/scratchpad/ab-base
    ```
    Then re-run the full suite one last time and confirm the tree is clean except for nothing (both commits already pushed):
    ```bash
    cd /Users/you/Dev/openAGI && npm test && git status --short
    ```
    Expected: 0 test failures; `git status --short` prints nothing.
