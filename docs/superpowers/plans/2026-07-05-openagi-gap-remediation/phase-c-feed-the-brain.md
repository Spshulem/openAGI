# Phase C: Feed the Brain (Weeks 3-4)

> **Read `00-INDEX.md` first** — its Global Constraints, decision gates, and execution protocol apply to every task below.
>
> **Drift rule:** Tasks in this plan share hot files (collision table in `00-INDEX.md`). If a Before-quote fails to match byte-for-byte and the difference is explained by an EARLIER task in this plan having edited that region (e.g. a new entry appended to `MAP` in `src/outreach-mapper.js`), apply the edit by intent — make the same change relative to the current code — and say so in the commit body. If the drift is NOT explained by an earlier plan task, STOP and report; the repo has moved since 2026-07-05.


---

<!-- verified:C1 status=clean -->
### Task C1: Ambient observations become ABI signals (hourly digest, not firehose)
**Week:** 3 · **Size:** M · **Depends on:** none
**User story:** As Spencer (the openAGI owner), I want the ambient capture stream (app focus + window titles) rolled up into one deterministic ABI signal per hour, so that the Signals→Scrutiny→Memory loop actually runs on my highest-volume sensor instead of the observations sitting inert in a side SQLite store.
**Why (evidence):** Gap G1 (critical, confirmed): POST /observations only calls `runtime.observations.record()` into the FTS side store (src/hosted-interface.js:408-417); the string "ambient-capture" as a taskType appears nowhere in src/ or test/, and `processSignal` is fed only by chat turns (src/agent-host.js:77) and the daily-adaptation-review cron (src/abi-runtime.js:607). The generic ingest path `processIntegrationEvent` (src/abi-runtime.js:475) is never fed by capture, so the live 742MB observation store never touches scrutiny or tiered memory, contradicting docs/scope/ambient-capture.md Phase 1.1.

**Resulting invariant (state this in code comments, do not fight it):** with these low-stakes measured axes (risk 0.1, urgency 0.2, impact 0.4), the scrutiny panel will verdict mid-band — mostly watch/ask, occasionally ignore — and every non-ignore verdict absorbs the digest into tiered memory (`processSignal` only skips memory on "ignore", src/abi-runtime.js:516-546). Act/propagate emerges from repetition alone: propagate requires propagationPressure ≥ 0.72, which repetition = min(1, count/14) reaches only after ~11 same-domain digests within 7 days. The point of this task is that the loop RUNS hourly; it is NOT to force high-scoring signals.

**Privacy rules for this task:** the digest summary and stats carry app names, window-title tokens, and aggregate counts ONLY — never raw OCR text lines (`buildAmbientDigest` must never read frame/texts rows). The live data dir ~/.openagi contains personal data: no step below reads it; all tests seed temp dirs via `fs.mkdtempSync`.

**Acceptance criteria:**
- `node --test test/ambient-digest.test.js` reports 3 passing tests, 0 failing.
- `npm test` (full suite, run from /Users/you/Dev/openAGI) reports no new failures relative to the baseline recorded in step 1.
- `node -e "import('./src/index.js').then(async (m) => { const r = m.createDefaultRuntime(); console.log(r.cron.listJobs().map((j) => j.id).includes('ambient-digest')); process.exit(0); })"` prints `true`.
- `grep -c "ambient-capture" /Users/you/Dev/openAGI/src/abi-runtime.js` prints a number ≥ 1 (the taskType now exists in src/).
- `grep -n "model-provider\|handleMessage\|ocrText\|texts" /Users/you/Dev/openAGI/src/ambient-digest.js` prints nothing (no LLM, no OCR access — deterministic module).
- The privacy test (seeded OCR marker string never appears in the digest JSON) passes as part of the test file.

**Files:**
- Create: src/ambient-digest.js
- Modify: src/index.js:31 (add export next to `export { ObservationStore }`)
- Modify: src/abi-runtime.js:24 (import), src/abi-runtime.js:420-427 (default-cron registration block), src/abi-runtime.js:728-731 (task dispatcher), src/abi-runtime.js:748-752 (new methods after `runOutreachDigest`)
- Test: test/ambient-digest.test.js

**Interfaces:**
- Consumes: `async search({ query, since, until, app, limit = 25 } = {})` on ObservationStore (src/observation-store.js:148) — called with NO `query` so the SQLite path returns activity rows shaped `{ kind: 'activity', app, window, at, event }` (src/observation-store.js:191) and the JSONL fallback returns raw records filtered by `since`/`until` (src/observation-store.js:150-162).
- Consumes: `processIntegrationEvent(source, payload)` (src/abi-runtime.js:475), which routes through the default "abi" integration's `toSignals(payload)` (src/integration-registry.js:69-95) — a single non-array payload is treated as one record, and the record fields `source, type, domain, taskType, summary, content, tags, urgency, impact, novelty, repetition, risk, confidence, specificity, metadata` all pass through to `normalizeSignal` (src/integration-registry.js:30-63).
- Consumes: `addJob(job)` on CronScheduler with `{ id, name, enabled, task, intervalMs }` (src/cron-scheduler.js:8-27) and the `if (job.task === "...")` dispatcher pattern inside `AbiRuntime.tick` (src/abi-runtime.js:605-732).
- Consumes: `this.memory.items` — a `Map` of memory items shaped `{ id, tier, tags: string[], createdAt: ISO-string, ... }` (src/memory-system.js:34-62), present on both `MemorySystem` and `FileBackedMemorySystem` (which extends it, src/file-backed-memory-system.js:7). Chosen over the OutcomeStore for the repetition count because `processSignal` writes a memory item tagged `["signal", signal.domain, signal.taskType, ...]` (src/abi-runtime.js:525-545) but records NOTHING in the OutcomeStore (OutcomeStore entries come only from agent-host replies/tool-calls) — memory is the only durable trace prior digests leave, and iterating the in-RAM Map is zero-I/O.
- Produces: `export async function buildAmbientDigest({ observations, sinceMs, nowMs }) -> Promise<null | { domain: string, summary: string, stats: { windowStart, windowEnd, focusEvents, distinctApps, topApps: Array<{app, count}>, topWindowTokens: string[] } }>` and `export function slugifyApp(app) -> string` (src/ambient-digest.js; `buildAmbientDigest` re-exported from src/index.js).
- Produces: `AbiRuntime.runAmbientDigest({ now }) -> Promise<{skipped, reason} | {fired: 1, domain, action, repetition}>`, `AbiRuntime.countAmbientMemories(domain, nowMs) -> number`, default cron job id `"ambient-digest"` with task `"ambient-digest"` (hourly), and signals with `source: "ambient-digest"`, `taskType: "ambient-capture"`, `domain: "app-<slug>"`. Later tasks may rely on the taskType string `"ambient-capture"` and the domain prefix `"app-"`.

**Steps** (run all commands from /Users/you/Dev/openAGI):

1. [ ] Record the baseline: run `npm test`. Expected: summary counters end with `# fail 0`. If any test fails BEFORE you change anything, write down its name — later steps must not add new failures beyond that pre-existing list.

2. [ ] Write the failing pure-function tests. Create `test/ambient-digest.test.js` with exactly this content:

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAmbientDigest, createDefaultRuntime, ObservationStore } from "../src/index.js";

test("buildAmbientDigest rolls an hour of activity into domain + aggregate stats", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-ambient-"));
  const store = new ObservationStore({ dir });
  await store.ready;
  await store.record([
    { kind: "activity", at: "2026-07-01T09:05:00Z", app: "Cursor", window: "Cursor · openagi roadmap", event: "focus" },
    { kind: "activity", at: "2026-07-01T09:10:00Z", app: "Cursor", window: "Cursor · openagi roadmap", event: "focus" },
    { kind: "activity", at: "2026-07-01T09:20:00Z", app: "Cursor", window: "Cursor · ambient digest", event: "focus" },
    { kind: "activity", at: "2026-07-01T09:30:00Z", app: "Slack", window: "Slack · #general", event: "focus" },
    { kind: "frame", at: "2026-07-01T09:15:00Z", app: "Cursor", window: "Cursor · openagi roadmap", frameId: "f1", ocrText: "SECRET_OCR_LINE must never leak into a digest", confidence: 0.9 }
  ]);
  const nowMs = Date.parse("2026-07-01T10:00:00Z");
  const digest = await buildAmbientDigest({ observations: store, sinceMs: nowMs - 60 * 60 * 1000, nowMs });
  assert.ok(digest, "expected a digest for a window with activity");
  assert.equal(digest.domain, "app-cursor");
  assert.equal(digest.stats.focusEvents, 4);
  assert.equal(digest.stats.distinctApps, 2);
  assert.deepEqual(digest.stats.topApps, [
    { app: "Cursor", count: 3 },
    { app: "Slack", count: 1 }
  ]);
  assert.deepEqual(digest.stats.topWindowTokens, ["cursor", "openagi", "roadmap", "ambient", "digest"]);
  assert.match(digest.summary, /4 focus events across 2 apps/);
  assert.match(digest.summary, /Cursor \(3\)/);
  // Privacy invariant: raw OCR text never enters the digest (summary OR stats).
  assert.ok(!JSON.stringify(digest).includes("SECRET_OCR_LINE"));
});

test("buildAmbientDigest returns null when the window has no activity rows", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-ambient-idle-"));
  const store = new ObservationStore({ dir });
  await store.ready;
  // Activity exists, but only before the window opens — the digest must stay quiet.
  await store.record([
    { kind: "activity", at: "2026-07-01T07:00:00Z", app: "Cursor", window: "Cursor · early", event: "focus" }
  ]);
  const nowMs = Date.parse("2026-07-01T10:00:00Z");
  const digest = await buildAmbientDigest({ observations: store, sinceMs: nowMs - 60 * 60 * 1000, nowMs });
  assert.equal(digest, null);
});
```

3. [ ] Run `node --test test/ambient-digest.test.js`. Expected FAILURE: the run aborts with `SyntaxError: The requested module '../src/index.js' does not provide an export named 'buildAmbientDigest'` and the summary shows `# fail 1`. Do not proceed until you see exactly this failure mode.

4. [ ] Create `src/ambient-digest.js` with exactly this content:

```js
// Ambient digest — deterministically rolls a window of ambient observations
// (app focus events + window titles) into one compact digest the runtime
// feeds into the Signals→Scrutiny→Memory loop as an "ambient-capture" ABI
// signal (see AbiRuntime.runAmbientDigest). One digest per hour, not a
// firehose: G1's fix is that the loop RUNS on the capture stream at all.
//
// No LLM anywhere in this module. Privacy: the digest carries app names,
// window-title tokens, and aggregate counts only — raw OCR text never enters
// the summary or stats. Only `activity` rows are read; frame/OCR rows are
// deliberately excluded (the sqlite no-query search path never returns them,
// and the JSONL fallback rows are filtered out by kind below).
//
// Returns null when the window contains no activity rows so the hourly cron
// job stays completely quiet while the machine is idle: no signal, no memory
// write, no output record.

const MAX_ROWS = 2000; // far above any real single-hour activity volume
const TOP_APP_LIMIT = 3;
const TOP_TOKEN_LIMIT = 5;
const MIN_TOKEN_LENGTH = 3;

export function slugifyApp(app) {
  const slug = String(app ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unknown";
}

export async function buildAmbientDigest({ observations, sinceMs, nowMs = Date.now() } = {}) {
  if (!observations || typeof observations.search !== "function") return null;
  const windowEndMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const windowStartMs = Number.isFinite(sinceMs) ? sinceMs : windowEndMs - 60 * 60 * 1000;
  const since = new Date(windowStartMs).toISOString();
  const until = new Date(windowEndMs).toISOString();

  // No `query` → the sqlite path returns activity-table rows only; the JSONL
  // fallback returns every record kind, so filter to activity explicitly.
  const rows = await observations.search({ since, until, limit: MAX_ROWS });
  const activity = rows.filter((r) => r.kind === "activity");
  if (activity.length === 0) return null;

  const appCounts = new Map();
  const tokenCounts = new Map();
  let focusEvents = 0;
  for (const row of activity) {
    const app = row.app ? String(row.app) : "unknown";
    // record() defaults a missing event to "focus" on the sqlite path; the
    // JSONL fallback keeps the raw record, so treat an absent event the same.
    if ((row.event ?? "focus") === "focus") {
      focusEvents += 1;
      appCounts.set(app, (appCounts.get(app) ?? 0) + 1);
    }
    for (const token of String(row.window ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length < MIN_TOKEN_LENGTH) continue;
      if (/^[0-9]+$/.test(token)) continue;
      tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
    }
  }
  // Activity rows with zero focus events would leave no dominant app to
  // derive a domain from — treat that window as idle too.
  if (focusEvents === 0) return null;

  const topApps = [...appCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_APP_LIMIT)
    .map(([app, count]) => ({ app, count }));
  const topWindowTokens = [...tokenCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_TOKEN_LIMIT)
    .map(([token]) => token);

  const domain = `app-${slugifyApp(topApps[0].app)}`;
  const stats = {
    windowStart: since,
    windowEnd: until,
    focusEvents,
    distinctApps: appCounts.size,
    topApps,
    topWindowTokens
  };
  const appLine = topApps.map((a) => `${a.app} (${a.count})`).join(", ");
  const tokenLine = topWindowTokens.length > 0 ? ` Top window terms: ${topWindowTokens.join(", ")}.` : "";
  const summary = `Ambient activity ${since} to ${until}: ${focusEvents} focus events across ${stats.distinctApps} app${stats.distinctApps === 1 ? "" : "s"}. Top apps: ${appLine}.${tokenLine}`;

  return { domain, summary, stats };
}
```

5. [ ] Export the module from the package index. In `src/index.js`, replace exactly this line (currently line 31):

```js
export { ObservationStore } from "./observation-store.js";
```

with:

```js
export { ObservationStore } from "./observation-store.js";
export { buildAmbientDigest } from "./ambient-digest.js";
```

6. [ ] Run `node --test test/ambient-digest.test.js`. Expected PASS: `# tests 2`, `# pass 2`, `# fail 0`.

7. [ ] Run the full suite: `npm test`. Expected: same results as the step-1 baseline plus the 2 new passing tests (no new failures).

8. [ ] Commit the pure module (plain-text message, no backticks):
`git add src/ambient-digest.js src/index.js test/ambient-digest.test.js && git commit -m "feat(ambient): deterministic hourly ambient digest module (buildAmbientDigest)" && git push`

9. [ ] Write the failing dispatcher test. Append exactly this to the END of `test/ambient-digest.test.js`:

```js
test("ambient-digest cron job feeds observation digests into processIntegrationEvent", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-ambient-cron-"));
  // Isolate every file-backed store to the temp dir — the default dirs would
  // share the real ~/.openagi stores (same trap the pattern-miner test notes).
  const runtime = createDefaultRuntime({
    dataDir,
    observationOptions: { dir: path.join(dataDir, "observations") },
    outcomeOptions: { dir: path.join(dataDir, "outcomes") },
    vectorStoreOptions: { dir: path.join(dataDir, "vectors") }
  });
  await runtime.observations.ready;
  await runtime.observations.record([
    { kind: "activity", at: "2026-07-01T09:10:00Z", app: "Cursor", window: "Cursor · openagi", event: "focus" },
    { kind: "activity", at: "2026-07-01T09:20:00Z", app: "Cursor", window: "Cursor · openagi", event: "focus" }
  ]);

  const calls = [];
  const original = runtime.processIntegrationEvent.bind(runtime);
  runtime.processIntegrationEvent = (source, payload) => {
    calls.push({ source, payload });
    return original(source, payload);
  };

  // Make only ambient-digest due; push every other default job out a day.
  const now = new Date("2026-07-01T10:00:00Z");
  for (const job of runtime.cron.listJobs()) {
    runtime.cron.updateJob(job.id, {
      nextRunAt: job.id === "ambient-digest"
        ? now.toISOString()
        : new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
    });
  }

  const first = await runtime.tick(now);
  assert.equal(first.length, 1);
  assert.equal(first[0].job.id, "ambient-digest");
  assert.equal(first[0].result.fired, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, "abi");
  assert.equal(calls[0].payload.taskType, "ambient-capture");
  assert.equal(calls[0].payload.domain, "app-cursor");
  assert.notEqual(calls[0].payload.domain, "general");
  assert.equal(calls[0].payload.risk, 0.1);
  assert.equal(calls[0].payload.urgency, 0.2);
  assert.equal(calls[0].payload.impact, 0.4);
  assert.equal(calls[0].payload.confidence, 0.7);
  assert.equal(calls[0].payload.specificity, 0.6);
  assert.equal(calls[0].payload.repetition, 0);
  assert.equal(calls[0].payload.novelty, 1);

  // The signal went through the full Signals→Scrutiny→Memory loop and absorbed:
  // only an "ignore" verdict skips memory, and these axes score well above the
  // panel's ignore band.
  const ambientOutputs = runtime.outputs.filter((o) => o.signal.taskType === "ambient-capture");
  assert.equal(ambientOutputs.length, 1);
  assert.ok(ambientOutputs[0].memory, "digest signal should absorb into tiered memory");
  assert.ok(ambientOutputs[0].memory.tags.includes("ambient-capture"));
  assert.ok(ambientOutputs[0].memory.tags.includes("app-cursor"));

  // Second hour: repetition is measured from the memory the first digest left.
  await runtime.observations.record([
    { kind: "activity", at: "2026-07-01T10:30:00Z", app: "Cursor", window: "Cursor · openagi", event: "focus" }
  ]);
  await runtime.tick(new Date("2026-07-01T11:00:00Z"));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].payload.repetition, 0.071); // min(1, 1/14) rounded to 3dp
  assert.equal(calls[1].payload.novelty, 0.929);

  // Idle hour: no activity rows in the 11:00-12:00 window → no signal at all.
  await runtime.tick(new Date("2026-07-01T12:00:00Z"));
  assert.equal(calls.length, 2);
});
```

10. [ ] Run `node --test test/ambient-digest.test.js`. Expected FAILURE: the first two tests pass, the new test fails at `assert.equal(first.length, 1)` with `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:` / `0 !== 1` (no `ambient-digest` job exists yet, so nothing is due). Summary: `# pass 2`, `# fail 1`.

11. [ ] Add the import to `src/abi-runtime.js`. Replace exactly this line (currently line 24):

```js
import { ObservationStore } from "./observation-store.js";
```

with:

```js
import { ObservationStore } from "./observation-store.js";
import { buildAmbientDigest } from "./ambient-digest.js";
```

12. [ ] Register the default cron job. In `src/abi-runtime.js`, inside the `if (options.registerDefaults !== false) {` block, replace exactly this (currently lines 420-427):

```js
      this.cron.addJob({
        id: "outreach-digest",
        name: `Outreach digest every ${this.outreachConfig.cadenceHours}h`,
        enabled: this.outreachConfig.enabled,
        task: "outreach-digest",
        intervalMs: this.outreachConfig.cadenceHours * 60 * 60 * 1000
      });
      registerCoreTools(this.tools, this);
```

with:

```js
      this.cron.addJob({
        id: "outreach-digest",
        name: `Outreach digest every ${this.outreachConfig.cadenceHours}h`,
        enabled: this.outreachConfig.enabled,
        task: "outreach-digest",
        intervalMs: this.outreachConfig.cadenceHours * 60 * 60 * 1000
      });
      // G1: hourly rollup of the ambient observation stream into ONE ABI
      // signal (see runAmbientDigest). Deterministic, no LLM, and quiet when
      // idle — buildAmbientDigest returns null when the window has no
      // activity rows, so an idle machine produces no signal and no memory
      // write.
      this.cron.addJob({
        id: "ambient-digest",
        name: "Hourly ambient observation digest",
        enabled: true,
        task: "ambient-digest",
        intervalMs: 60 * 60 * 1000
      });
      registerCoreTools(this.tools, this);
```

13. [ ] Add the dispatcher branch. In `src/abi-runtime.js`, inside `tick()`'s `runDue` handler, replace exactly this (currently lines 728-731):

```js
      if (job.task === "outreach-digest") {
        return this.runOutreachDigest({ now });
      }
      return { skipped: true, reason: `No handler for task ${job.task}` };
```

with:

```js
      if (job.task === "outreach-digest") {
        return this.runOutreachDigest({ now });
      }
      if (job.task === "ambient-digest") {
        return this.runAmbientDigest({ now });
      }
      return { skipped: true, reason: `No handler for task ${job.task}` };
```

14. [ ] Add the runtime methods. In `src/abi-runtime.js`, replace exactly this (the complete `runOutreachDigest` method, currently lines 748-752):

```js
  runOutreachDigest({ now = new Date() } = {}) {
    if (!this.outreachConfig?.enabled) return { skipped: true, reason: "outreach disabled" };
    const item = composeDigest(this.outreach, this.outreachConfig, { now });
    return item ? { ok: true, digestId: item.id, title: item.title } : { ok: true, empty: true };
  }
```

with:

```js
  runOutreachDigest({ now = new Date() } = {}) {
    if (!this.outreachConfig?.enabled) return { skipped: true, reason: "outreach disabled" };
    const item = composeDigest(this.outreach, this.outreachConfig, { now });
    return item ? { ok: true, digestId: item.id, title: item.title } : { ok: true, empty: true };
  }

  // G1 fix: the core severed hop. Roll the last hour of ambient observations
  // into ONE deterministic ABI signal (no LLM) so the capture stream flows
  // through Signals→Scrutiny→Memory instead of sitting inert in the side
  // SQLite store. Axes are measured, not template constants: repetition
  // grows with how often this domain's digest recurred in the last 7 days,
  // novelty is its complement. Expected steady state: scrutiny verdicts stay
  // mid-band (watch/ask) and the digest absorbs into tiered memory — only an
  // ignore verdict skips memory. Act/propagate emerges from repetition alone
  // (propagate needs pressure >= 0.72, i.e. ~11 same-domain digests in 7d).
  async runAmbientDigest({ now = new Date() } = {}) {
    const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
    const digest = await buildAmbientDigest({
      observations: this.observations,
      sinceMs: nowMs - 60 * 60 * 1000,
      nowMs
    });
    if (!digest) return { skipped: true, reason: "no activity in window" };
    const rawRepetition = Math.min(1, this.countAmbientMemories(digest.domain, nowMs) / 14);
    const repetition = Number(rawRepetition.toFixed(3));
    const novelty = Number((1 - rawRepetition).toFixed(3));
    const outputs = this.processIntegrationEvent("abi", {
      source: "ambient-digest",
      type: "ambient-capture",
      domain: digest.domain,
      taskType: "ambient-capture",
      summary: digest.summary,
      content: digest.summary,
      tags: ["ambient", "digest"],
      urgency: 0.2,
      impact: 0.4,
      novelty,
      repetition,
      risk: 0.1,
      confidence: 0.7,
      specificity: 0.6,
      metadata: { stats: digest.stats }
    });
    const output = outputs[0] ?? null;
    return { fired: 1, domain: digest.domain, action: output ? output.action : null, repetition };
  }

  // Repetition denominator for ambient digests: memory items prior digests
  // left behind for this domain in the last 7 days. Chosen over the outcome
  // store because processSignal writes a memory item tagged with the signal's
  // domain + taskType but records nothing in the OutcomeStore — memory is the
  // only durable trace prior digests leave, and iterating the in-RAM items
  // Map (present on MemorySystem and FileBackedMemorySystem alike) is
  // O(items) with zero I/O.
  countAmbientMemories(domain, nowMs) {
    if (!this.memory?.items) return 0;
    const since = nowMs - 7 * 24 * 60 * 60 * 1000;
    let count = 0;
    for (const item of this.memory.items.values()) {
      if (!Array.isArray(item.tags)) continue;
      if (!item.tags.includes("ambient-capture") || !item.tags.includes(domain)) continue;
      const createdMs = new Date(item.createdAt).getTime();
      if (Number.isFinite(createdMs) && createdMs >= since) count += 1;
    }
    return count;
  }
```

15. [ ] Run `node --test test/ambient-digest.test.js`. Expected PASS: `# tests 3`, `# pass 3`, `# fail 0`.

16. [ ] Run the full suite: `npm test`. Expected: no failures beyond the step-1 baseline list. If a test outside test/ambient-digest.test.js newly fails, re-read your abi-runtime.js edits against the exact before-blocks above before touching anything else — the only behavioral additions must be one import, one cron job, one dispatcher branch, and two new methods.

17. [ ] Verify the job registers on a default runtime: run `node -e "import('./src/index.js').then(async (m) => { const r = m.createDefaultRuntime(); console.log(r.cron.listJobs().map((j) => j.id).includes('ambient-digest')); process.exit(0); })"`. Expected output: `true`. (On the live install, the same default-registration path adds the job to the persisted cron store at next daemon restart — `addJob` no-ops if the id already exists, src/cron-scheduler.js:10-11. Do not restart or touch the live daemon or ~/.openagi as part of this task.)

18. [ ] Commit the wiring (plain-text message, no backticks):
`git add src/abi-runtime.js test/ambient-digest.test.js && git commit -m "feat(ambient): hourly ambient-digest cron feeds observations into the ABI signal loop" && git push`

---

<!-- verified:C2 status=fixed:1 -->
### Task C2: Measured scrutiny axes replace hardcoded constants
**Week:** 3 · **Size:** L · **Depends on:** B3 (its fitter variance guard must be in place before axis distributions shift)
**User story:** As Spencer (the openAGI owner), I want the seven scrutiny axes measured from each message and the runtime's own stores instead of hardcoded constants, so that the scrutiny verdict reflects the actual signal, the fitter trains on inputs that vary, and specialization candidates carry content-derived scopes that mint genuinely different specialists.
**Why (evidence):** G4 (confirmed-partial): `messageToSignal` (src/agent-host.js:261-297) hardcodes specificity=0.65, confidence=0.7, and flips risk 0.35/0.75, repetition 0.35/0.82, novelty 0.4/0.65 on keyword regexes — across 524 live current-pipeline outcomes, risk was 0.35 in 100% of rows and the evidence dimension a single constant 0.697, so the fitter's correlation for it is permanently zero. G2 (confirmed): every internal signal hardcodes domain "general" and one of two taskTypes; the propagation dedupe signature is hash(workflowId, domain, taskType, goal) (src/propagation-controller.js:177-184), so all internal signals collapse to exactly 2 signatures and the live install has exactly 2 catch-all specialists; the content-scoping fields `specialistScope`/`goal`/`successMetric` exist (src/propagation-controller.js:98-104) but no producer ever sets them.
**Acceptance criteria:**
- `cd /Users/you/Dev/openAGI && node --test test/signal-axes.test.js` passes (7 tests, 0 fail).
- `cd /Users/you/Dev/openAGI && node --test test/message-to-signal-axes.test.js` passes (2 tests, 0 fail).
- `cd /Users/you/Dev/openAGI && npm test` passes with no regressions (existing agent-host tests test/verdict-consequences.test.js and test/specialist-bounds.test.js construct stub runtimes without `vectorStore` and with `outcomes: null`, while test/ephemeral-turn.test.js runs handleMessage on createDefaultRuntime — the new code must tolerate both).
- `measureAxes` performs zero LLM calls: only vector-store cosine search (existing embedder), a read-only pass over the memory `items` Map, and `outcomeStore.recent()` — verify by reading src/signal-axes.js: it imports only from ./utils.js.
- Two chat messages with different content produce different `specificity`, `risk`, and `confidence` on their signals (asserted by test/message-to-signal-axes.test.js).
- For taskType "specialization-candidate", the signal carries `specialistScope`, `successMetric` = "outcome quality >= 0.6 over next 10 activations", and a scope-derived `goal`; two candidates with different content words produce different `PropagationController.signature()` hashes (asserted by test).
- Outcomes recorded by agent-host now carry `metadata.signalSummary` (feeds the repetition axis on future turns). Check via test only — never read live `~/.openagi` content.
- Post-land note: axis distributions shift, so scrutiny-fitter auto-apply MUST remain gated by B3's variance guard; do not loosen that guard in this task.
**Files:**
- Create: src/signal-axes.js
- Create: test/signal-axes.test.js
- Create: test/message-to-signal-axes.test.js
- Modify: src/agent-host.js:4 (imports), src/agent-host.js:75 (await), src/agent-host.js:182-184 (outcome metadata), src/agent-host.js:261-297 (messageToSignal)
- Modify: src/index.js:47 (export new module)
**Interfaces:**
- Consumes (existing, copied from source):
  - `export function tokenOverlapScore(query, target)` — src/utils.js:23 (this IS the token-overlap scorer memory-system.js uses at line 81; it already lives in a shared location, so no extraction is needed)
  - `export function tokenize(value)` — src/utils.js:15; `export function clamp(value, min = 0, max = 1)` — src/utils.js:11
  - `async search(namespace, queryText, { limit = 5, minScore = 0.05 } = {})` on VectorStore — src/vector-store.js:49 (returns `[{ id, score, text, payload }]`, `[]` when no embedder or on embed failure)
  - `recent(limit = 50, kind = null)` on OutcomeStore — src/outcome-store.js:73
  - `this.items = new Map()` on MemorySystem — src/memory-system.js:17 (FileBackedMemorySystem extends it, same Map)
  - `signature(signal, workflow)` on PropagationController — src/propagation-controller.js:177-184: `stableHash({ workflow, domain, taskType, goal: signal.goal ?? workflow?.goal ?? "outcome" })` — note `specialistScope` is NOT hashed but `signal.goal` IS, which is why this task also sets `goal` from the scope
  - `boundedScope: summarizeText(signal.specialistScope ?? ...)` and `successMetric: signal.successMetric ?? ...` — src/propagation-controller.js:99-100 (confirms scope/metric flow into the spawned specialist)
- Produces (new, later tasks may rely on):
  - src/signal-axes.js: `async function measureAxes({ text, memorySystem = null, vectorStore = null, outcomeStore = null })` → `{ novelty, repetition, risk, impact, specificity, confidence }` (all numbers 0..1); `function measureSpecificity(text)` → number; `function contentWords(text)` → string[]; `function countProperNouns(text)` → number; `function deriveSpecialistScope(text, domain = "general")` → string|null; exported regexes `REMEMBER_RE`, `SCHEDULE_RE`, `SPECIALIZE_RE`, `RISK_KEYWORDS_RE`, `SIDE_EFFECT_VERBS_RE`, `NUMBER_RE`, `URL_RE`, `PATH_RE`
  - `AgentHost.messageToSignal(...)` becomes **async** (returns a Promise; sole call site is agent-host.js:75, updated in this task); signals with taskType "specialization-candidate" may carry `specialistScope`, `successMetric`, `goal`
  - Agent-host outcome records gain `metadata.signalSummary` (first 240 chars of the message — same data class as the session store, which already persists full text)

Design notes the executor must not "fix" differently:
- **Novelty namespace:** the design brief says "the memory namespace", but nothing in the repo ever upserts namespace "memory" — the only writers are `"principle"` (src/memory-condenser.js:71) and `"specialist"` (src/file-backed-propagation-controller.js:22,43). Searching "memory" would return `[]` forever and silently degrade to the fallback. Therefore novelty searches the **"principle"** namespace (the same one agent-host already queries per turn at src/agent-host.js:118, populated on the live install), then falls back to a read-only token-overlap pass over `memorySystem.items` (NOT `memorySystem.retrieve()`, which mutates strength/lastAccessedAt on access), then to the old keyword heuristic.
- **Repetition source:** outcome records do not currently store any signal text (src/outcome-store.js:23-46 — fields are ids/kind/toolCalls only), so this task adds `metadata.signalSummary` at the agent-host record site; the axis reads it from prior outcomes. It stays at the 0.2 floor until history accumulates — with the schedule/automate keyword kept as a 0.82 floor so "every tuesday" still reads as repetition by declaration.
- **Side-effect verbs:** derived from the tools in src/tool-registry.js that do NOT declare `sideEffects: false` (defaulting side-effecting per tool-registry.js:31): send_message (line 353), schedule_message (304), replay_skill (454), run_skill (472), register_mcp_server (523), connect_mcp_server (571), disconnect_mcp_server (588), cancel_cron_job (612), restart_daemon (989), retire_specialist (1008), connect_catalog_mcp (931). Matched as the verb list in `SIDE_EFFECT_VERBS_RE` below.
- **Known non-goals:** `specialistName()` (src/propagation-controller.js:186-190) still names every candidate "general-specialization-candidate-specialist" even when scopes differ — ids and signatures differ, names collide; note it for a later task, do NOT change propagation-controller.js in this task. The cron daily-review job's hardcoded signal (src/cron-scheduler.js:93-115) is likewise out of scope here.

Steps:

1. [ ] Write the failing axis test. Create `/Users/you/Dev/openAGI/test/signal-axes.test.js` with exactly this content:

```js
// C2: scrutiny axes are measured from the message + runtime stores, not
// hardcoded constants. Every heuristic is deterministic — no LLM, no network
// (stores are stubbed here so no data dir is touched).
import assert from "node:assert/strict";
import test from "node:test";
import {
  contentWords,
  countProperNouns,
  deriveSpecialistScope,
  measureAxes,
  measureSpecificity
} from "../src/signal-axes.js";

test("axis table: measured values move with message content", async () => {
  const cases = [
    { text: "remind me every tuesday to file my report", axis: "repetition", min: 0.8 },
    { text: "send the invoice to the client", axis: "risk", min: 0.6 },
    { text: "cancel the production deploy", axis: "risk", min: 0.9 },
    { text: "is the deploy done yet?", axis: "confidence", max: 0.5 },
    { text: "update src/agent-host.js lines 261-297 per https://example.com/spec", axis: "specificity", min: 0.6 },
    { text: "hello", axis: "specificity", max: 0.4 }
  ];
  for (const { text, axis, min, max } of cases) {
    const axes = await measureAxes({ text });
    if (min !== undefined) assert.ok(axes[axis] >= min, `${axis} of "${text}" should be >= ${min}, got ${axes[axis]}`);
    if (max !== undefined) assert.ok(axes[axis] <= max, `${axis} of "${text}" should be <= ${max}, got ${axes[axis]}`);
  }
});

test("repetition: similar past outcome summaries raise the measured value", async () => {
  const outcomeStore = {
    recent: () => Array.from({ length: 8 }, () => ({ metadata: { signalSummary: "reconcile stripe invoices for acme" } }))
  };
  const withHistory = await measureAxes({ text: "reconcile stripe invoices for acme", outcomeStore });
  const noHistory = await measureAxes({ text: "reconcile stripe invoices for acme" });
  assert.equal(withHistory.repetition, 1, "8 similar priors saturate min(1, count/8)");
  assert.equal(noHistory.repetition, 0.2, "no schedule keyword + no history = floor");
});

test("novelty: drops when the vector store already knows the topic", async () => {
  const known = { search: async () => [{ id: "p1", score: 0.9, text: "standup notes" }] };
  const empty = { search: async () => [] };
  const seen = await measureAxes({ text: "summarize the standup notes", vectorStore: known });
  const fallback = await measureAxes({ text: "summarize the standup notes", vectorStore: empty });
  assert.ok(seen.novelty < 0.2, `known topic should be low novelty, got ${seen.novelty}`);
  assert.equal(fallback.novelty, 0.4, "empty store + no keyword = old keyword fallback");
});

test("novelty: read-only memory overlap fallback never reinforces items", async () => {
  const { MemorySystem } = await import("../src/index.js");
  const memory = new MemorySystem();
  memory.remember({ source: "test", content: "weekly invoice reconciliation for acme", tags: [] });
  const before = [...memory.items.values()].map((i) => i.strength);
  const axes = await measureAxes({ text: "weekly invoice reconciliation for acme", memorySystem: memory });
  const after = [...memory.items.values()].map((i) => i.strength);
  assert.ok(axes.novelty < 0.4, `known topic should read as low novelty, got ${axes.novelty}`);
  assert.deepEqual(after, before, "measurement must not mutate memory strength");
});

test("impact: tracks specificity unless a remember/automate keyword fires", async () => {
  const vague = await measureAxes({ text: "hello there" });
  const specific = await measureAxes({ text: "move 3 files into /Users/me/projects/reports and update budget.json" });
  assert.ok(specific.impact > vague.impact, "impact follows measured specificity");
  const kw = await measureAxes({ text: "remember this preference" });
  assert.equal(kw.impact, 0.72, "keyword bump is kept as a floor");
});

test("deriveSpecialistScope: top content-word stems + domain; distinct texts -> distinct scopes", () => {
  const a = deriveSpecialistScope("automate reconciling stripe invoices every week", "general");
  const b = deriveSpecialistScope("automate triaging github issues every week", "general");
  assert.ok(a.includes("stripe"), `scope should carry content words, got "${a}"`);
  assert.ok(b.includes("github"), `scope should carry content words, got "${b}"`);
  assert.ok(a.endsWith("general") && b.endsWith("general"), "domain is appended");
  assert.notEqual(a, b);
  assert.equal(deriveSpecialistScope("", "general"), null, "no content words -> null (caller keeps defaults)");
  assert.equal(deriveSpecialistScope("automate", "general"), null, "trigger words alone -> null");
});

test("helpers: countProperNouns and contentWords behave as specified", () => {
  assert.equal(countProperNouns("Send the report to Spencer at Anthropic. Tomorrow works."), 2,
    "Spencer + Anthropic count; sentence-initial Send/Tomorrow do not");
  assert.deepEqual(contentWords("remind me every tuesday to file my report"), ["tuesday", "file", "report"]);
});
```

2. [ ] Run the new test and confirm it fails because the module does not exist:
`cd /Users/you/Dev/openAGI && node --test test/signal-axes.test.js`
Expected: exit code 1 with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/you/Dev/openAGI/src/signal-axes.js' imported from /Users/you/Dev/openAGI/test/signal-axes.test.js` and a summary containing `# fail 1`.

3. [ ] Create `/Users/you/Dev/openAGI/src/signal-axes.js` with exactly this content:

```js
import { clamp, tokenize, tokenOverlapScore } from "./utils.js";

// C2: measured scrutiny axes. Deterministic per-signal heuristics computed
// from the message text plus stores the runtime already maintains — the
// vector store (distilled principles), tiered memory, and outcome history.
// No LLM calls; every fallback path is deterministic so tests can assert
// exact values. Replaces the hardcoded constants in
// agent-host.messageToSignal (specificity 0.65, confidence 0.7, risk
// 0.35/0.75 keyword flip, ...) that left the scrutiny fitter training on
// near-constant inputs.

// Keyword baselines kept verbatim from the previous messageToSignal
// heuristic — they remain the fallback when no store is available and the
// floor for axes where declared intent ("every tuesday") outranks history.
export const REMEMBER_RE = /\bremember\b|\bsave\b|\bdon't forget\b/;
export const SCHEDULE_RE = /\bevery\b|\bdaily\b|\bweekly\b|\btomorrow\b|\bremind\b|\bschedule\b/;
export const SPECIALIZE_RE = /\bagent\b|\bspecialist\b|\bsub-?agent\b|\bdo this often\b|\bautomate\b/;
export const RISK_KEYWORDS_RE = /\bdelete\b|\bdeploy\b|\bpayment\b|\bproduction\b|\blegal\b|\bmedical\b|\bsecurity\b/;

// Verbs naming side-effecting tools in src/tool-registry.js (every tool that
// does NOT declare sideEffects: false): send_message, schedule_message,
// replay_skill, run_skill, register_mcp_server, connect_mcp_server,
// connect_catalog_mcp, disconnect_mcp_server, cancel_cron_job,
// restart_daemon, retire_specialist. Naming one of these actions bumps risk.
export const SIDE_EFFECT_VERBS_RE = /\bsend\b|\bschedule\b|\breplay\b|\brestart\b|\bretire\b|\bcancel\b|\bconnect\b|\bdisconnect\b|\bregister\b/;

// Specificity signals. URL_RE is applied first and URLs are stripped before
// path/number matching so one URL is not double-counted as a path.
export const NUMBER_RE = /\b\d[\d,.:]*\b/g;
export const URL_RE = /https?:\/\/[^\s)]+/gi;
export const PATH_RE = /(?:~?\/[\w.-]+(?:\/[\w.-]+)+)|\b[\w-]+\.(?:js|jsx|ts|tsx|py|md|json|swift|sh|yml|yaml|txt|html|css|sql|pdf|csv)\b/g;

// Function/structure words excluded from the content-word set. Schedule
// scaffolding ("every", "remind") is deliberately included so repetition
// matching compares WHAT repeats, not the ask-to-repeat phrasing.
const STOPWORDS = new Set([
  "the", "and", "for", "are", "was", "were", "been", "being", "but", "not",
  "you", "your", "our", "his", "her", "its", "their", "them", "they", "this",
  "that", "these", "those", "with", "from", "into", "onto", "over", "under",
  "out", "off", "have", "has", "had", "can", "could", "should", "would",
  "will", "shall", "may", "might", "must", "does", "did", "doing", "done",
  "what", "which", "who", "whom", "when", "where", "why", "how", "there",
  "here", "then", "than", "too", "very", "just", "also", "about", "please",
  "need", "want", "get", "got", "let", "make", "made", "some", "any", "all",
  "every", "daily", "weekly", "tomorrow", "today", "remind", "reminder",
  "schedule", "each", "per", "yet", "now", "don", "dont"
]);

// Specialization trigger words carry no scope information — every candidate
// message contains one, so they would dominate every derived scope.
const SCOPE_NOISE = new Set(["agent", "specialist", "sub-agent", "subagent", "automate", "often"]);

export function contentWords(text) {
  return tokenize(text).filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

// Capitalized words that are not at a sentence start read as proper nouns.
export function countProperNouns(text) {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  let count = 0;
  for (let i = 1; i < words.length; i += 1) {
    if (/[.!?]$/.test(words[i - 1])) continue; // sentence start, not a proper-noun cue
    if (/^[A-Z][a-z]{2,}/.test(words[i])) count += 1;
  }
  return count;
}

// 0.2..0.95. Baseline 0.3 for plain prose; numbers, file paths, URLs, and
// proper nouns each raise it. Deterministic, text-only.
export function measureSpecificity(text) {
  const raw = String(text ?? "");
  const urls = (raw.match(URL_RE) ?? []).length;
  const withoutUrls = raw.replace(URL_RE, " ");
  const numbers = (withoutUrls.match(NUMBER_RE) ?? []).length;
  const paths = (withoutUrls.match(PATH_RE) ?? []).length;
  const properNouns = countProperNouns(withoutUrls);
  return clamp(0.3 + numbers * 0.08 + paths * 0.15 + urls * 0.15 + properNouns * 0.06, 0.2, 0.95);
}

// Bounded-scope text for a specialization candidate: the top two content-word
// stems by frequency (ties broken by first occurrence), plus the domain.
// Returns null when the message has no scope-bearing content words so the
// caller keeps the existing defaults.
export function deriveSpecialistScope(text, domain = "general") {
  const counts = new Map();
  for (const word of contentWords(text)) {
    if (SCOPE_NOISE.has(word)) continue;
    const stem = word.length > 4 ? word.replace(/(?:ing|ed|es|s)$/, "") : word;
    counts.set(stem, (counts.get(stem) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const stems = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([stem]) => stem);
  return `${stems.join(" ")} ${domain}`;
}

/**
 * Measure the scrutiny axes for a message. All inputs optional except text;
 * absent stores degrade to the previous keyword heuristics, never throw.
 *   novelty    — 1 - best similarity vs what the system already knows:
 *                principle vectors (the only memory-derived namespace with a
 *                writer — memory-condenser.js:71), then read-only token
 *                overlap over memory items (retrieve() would reinforce),
 *                then the old keyword values.
 *   repetition — min(1, similarPastCount / 8) over prior outcomes whose
 *                metadata.signalSummary shares >= 60% of this message's
 *                content-word set; schedule/automate keywords floor at 0.82.
 *   risk       — keyword list floor (0.35/0.75) + 0.25 when a side-effecting
 *                tool verb is named, capped at 0.95.
 *   specificity— measureSpecificity(text).
 *   impact     — max(keyword bump 0.72, 0.3 + 0.3 * specificity).
 *   confidence — 0.7 baseline, 0.5 when the message ends with a question mark.
 */
export async function measureAxes({ text, memorySystem = null, vectorStore = null, outcomeStore = null }) {
  const raw = String(text ?? "");
  const lower = raw.toLowerCase();
  const asksToRemember = REMEMBER_RE.test(lower);
  const asksToSchedule = SCHEDULE_RE.test(lower);
  const asksToSpecialize = SPECIALIZE_RE.test(lower);

  let bestMatch = null;
  if (typeof vectorStore?.search === "function") {
    try {
      const hits = await vectorStore.search("principle", raw, { limit: 1, minScore: 0 });
      if (hits.length > 0) bestMatch = clamp(hits[0].score);
    } catch { /* fall through to the next novelty source */ }
  }
  if (bestMatch === null && memorySystem?.items instanceof Map && memorySystem.items.size > 0) {
    let top = 0;
    for (const item of memorySystem.items.values()) {
      const score = tokenOverlapScore(raw, item.content ?? "");
      if (score > top) top = score;
    }
    bestMatch = clamp(top);
  }
  const novelty = bestMatch === null
    ? (asksToRemember || asksToSpecialize ? 0.65 : 0.4)
    : clamp(1 - bestMatch);

  let similarPastCount = 0;
  if (typeof outcomeStore?.recent === "function") {
    const words = contentWords(raw).join(" ");
    if (words) {
      for (const outcome of outcomeStore.recent(200)) {
        const summary = outcome?.metadata?.signalSummary;
        if (typeof summary !== "string" || summary === "") continue;
        if (tokenOverlapScore(words, contentWords(summary).join(" ")) >= 0.6) similarPastCount += 1;
      }
    }
  }
  const measuredRepetition = Math.min(1, similarPastCount / 8);
  const repetition = Math.max(asksToSchedule || asksToSpecialize ? 0.82 : 0.2, measuredRepetition);

  const baseRisk = RISK_KEYWORDS_RE.test(lower) ? 0.75 : 0.35;
  const risk = SIDE_EFFECT_VERBS_RE.test(lower) ? Math.min(0.95, baseRisk + 0.25) : baseRisk;

  const specificity = measureSpecificity(raw);
  const impact = clamp(Math.max(asksToRemember || asksToSpecialize ? 0.72 : 0, 0.3 + 0.3 * specificity));
  const confidence = /\?\s*$/.test(raw) ? 0.5 : 0.7;

  return { novelty, repetition, risk, impact, specificity, confidence };
}
```

4. [ ] Export the module from the package index. In `/Users/you/Dev/openAGI/src/index.js`, apply this edit (current line 47 is the last line of the file):

Before:
```js
export { createHostedInterface } from "./hosted-interface.js";
```

After:
```js
export { createHostedInterface } from "./hosted-interface.js";
export { contentWords, countProperNouns, deriveSpecialistScope, measureAxes, measureSpecificity } from "./signal-axes.js";
```

5. [ ] Run the axis test again:
`cd /Users/you/Dev/openAGI && node --test test/signal-axes.test.js`
Expected: `# pass 7`, `# fail 0`, exit code 0.

6. [ ] Run the full suite to prove nothing regressed:
`cd /Users/you/Dev/openAGI && npm test`
Expected: all test files pass, `# fail 0`.

7. [ ] Commit the module:
`cd /Users/you/Dev/openAGI && git add src/signal-axes.js src/index.js test/signal-axes.test.js && git commit -m "feat(scrutiny): measured signal axes module - novelty, repetition, risk, impact, specificity, confidence (G4)"`

8. [ ] Write the failing integration test. Create `/Users/you/Dev/openAGI/test/message-to-signal-axes.test.js` with exactly this content:

```js
// C2: messageToSignal carries measured axes (not constants) and derives a
// content-scoped specialist for specialization candidates, so different
// scopes hash to different propagation dedupe signatures — cracking the
// two-specialist collapse (G2). Signature hashes signal.goal, which is why
// messageToSignal sets goal from the derived scope.
import assert from "node:assert/strict";
import test from "node:test";
import { AgentHost } from "../src/agent-host.js";
import { PropagationController } from "../src/propagation-controller.js";

// Stub runtime in the style of test/verdict-consequences.test.js makeHost():
// no vectorStore, no outcomes — messageToSignal must tolerate absent stores.
function makeHost() {
  const runtime = {
    memory: { remember: () => ({ id: "m1" }) },
    outcomes: null,
    processSignal: () => { throw new Error("processSignal is not exercised by these tests"); }
  };
  return new AgentHost({
    runtime,
    modelProvider: {
      isConfigured: () => true,
      model: "stub",
      generate: async () => ({ text: "ok", provider: "stub", model: "stub", id: "r1", toolCalls: [] })
    }
  });
}

const AGENT = { id: "main", role: "generalist" };
const BASE = { channel: "local", from: "u", agent: AGENT, sessionId: "s1", metadata: {} };

test("two different messages produce different measured axes, not constants", async () => {
  const host = makeHost();
  const a = await host.messageToSignal({ ...BASE, text: "what did I do yesterday?" });
  const b = await host.messageToSignal({ ...BASE, text: "send invoice 4821 from /Users/me/billing/acme.pdf to the client" });
  assert.notEqual(a.specificity, b.specificity, "specificity must vary with content");
  assert.notEqual(a.risk, b.risk, "risk must vary with content");
  assert.notEqual(a.confidence, b.confidence, "confidence must vary with content");
  assert.ok(b.specificity > a.specificity, "numbers + a file path read as more specific");
  assert.ok(b.risk > a.risk, "naming a side-effecting action (send) elevates risk");
  assert.equal(a.confidence, 0.5, "question lowers confidence by 0.2");
  assert.equal(b.confidence, 0.7, "statement keeps the 0.7 baseline");
});

test("specialization candidates carry scope, metric, and a signature-differentiating goal", async () => {
  const host = makeHost();
  const controller = new PropagationController();
  const workflow = {
    id: "specialization-candidate",
    goal: "Decide whether a repeated or high-risk novel task should become a specialist."
  };

  const invoices = await host.messageToSignal({ ...BASE, text: "automate reconciling stripe invoices" });
  const triage = await host.messageToSignal({ ...BASE, text: "automate triaging github issues" });

  assert.equal(invoices.taskType, "specialization-candidate");
  assert.equal(triage.taskType, "specialization-candidate");
  assert.ok(invoices.specialistScope.includes("stripe"), `scope from content, got "${invoices.specialistScope}"`);
  assert.ok(triage.specialistScope.includes("github"), `scope from content, got "${triage.specialistScope}"`);
  assert.equal(invoices.successMetric, "outcome quality >= 0.6 over next 10 activations");
  assert.notEqual(invoices.specialistScope, triage.specialistScope);
  assert.notEqual(
    controller.signature(invoices, workflow),
    controller.signature(triage, workflow),
    "different scopes must hash to different propagation dedupe signatures"
  );

  const adaptation = await host.messageToSignal({ ...BASE, text: "hello there" });
  assert.equal(adaptation.taskType, "adaptation-review");
  assert.equal(adaptation.specialistScope, undefined, "non-candidates keep default scope fields");
  assert.equal(adaptation.goal, undefined, "non-candidates do not override the workflow goal");
});
```

9. [ ] Run it and confirm it fails against the current constants:
`cd /Users/you/Dev/openAGI && node --test test/message-to-signal-axes.test.js`
Expected: exit code 1, `# fail 2`. Test 1 fails at the first assertion with `AssertionError [ERR_ASSERTION]` (specificity is the constant `0.65` for both messages, so `notEqual(0.65, 0.65)` throws). Test 2 fails with `TypeError: Cannot read properties of undefined (reading 'includes')` (no `specialistScope` is set today).

10. [ ] Wire measured axes into agent-host. Apply these four edits to `/Users/you/Dev/openAGI/src/agent-host.js`.

Edit 10a — imports. Before (lines 3-4):
```js
import { createId, nowIso } from "./utils.js";
import { detectTaskInChat } from "./task-store.js";
```
After:
```js
import { createId, nowIso } from "./utils.js";
import { detectTaskInChat } from "./task-store.js";
import { deriveSpecialistScope, measureAxes, REMEMBER_RE, SCHEDULE_RE, SPECIALIZE_RE } from "./signal-axes.js";
```

Edit 10b — await the now-async messageToSignal (sole call site, line 75). Before:
```js
    const signal = this.messageToSignal({ text, channel, from, agent, sessionId, metadata: input.metadata ?? {} });
```
After:
```js
    const signal = await this.messageToSignal({ text, channel, from, agent, sessionId, metadata: input.metadata ?? {} });
```

Edit 10c — record the signal summary on outcomes so the repetition axis has history to count (lines 182-184). Before:
```js
      metadata: {
        specialistId: agent.role === "specialist" ? agent.id : null,
        scrutinyScore: output.scrutiny.score,
```
After:
```js
      metadata: {
        specialistId: agent.role === "specialist" ? agent.id : null,
        signalSummary: signal.summary,
        scrutinyScore: output.scrutiny.score,
```

Edit 10d — replace the whole messageToSignal function. Before (current lines 261-297, quoted exactly):
```js
  messageToSignal({ text, channel, from, agent, sessionId, metadata }) {
    const lower = text.toLowerCase();
    const asksToRemember = /\bremember\b|\bsave\b|\bdon't forget\b/.test(lower);
    const asksToSchedule = /\bevery\b|\bdaily\b|\bweekly\b|\btomorrow\b|\bremind\b|\bschedule\b/.test(lower);
    const asksToSpecialize = /\bagent\b|\bspecialist\b|\bsub-?agent\b|\bdo this often\b|\bautomate\b/.test(lower);
    const risk = /\bdelete\b|\bdeploy\b|\bpayment\b|\bproduction\b|\blegal\b|\bmedical\b|\bsecurity\b/.test(lower) ? 0.75 : 0.35;
    const repetition = asksToSchedule || asksToSpecialize ? 0.82 : 0.35;
    const novelty = asksToRemember || asksToSpecialize ? 0.65 : 0.4;

    return {
      id: createId("sig"),
      source: channel,
      type: "message",
      domain: "general",
      taskType: asksToSpecialize ? "specialization-candidate" : "adaptation-review",
      summary: text.slice(0, 240),
      content: text,
      citations: [`session:${sessionId}`, `agent:${agent.id}`, `from:${from}`],
      tags: ["message", channel, agent.id],
      urgency: metadata.urgent ? 0.85 : 0.45,
      impact: asksToRemember || asksToSpecialize ? 0.72 : 0.55,
      externalPressure: 0.55,
      internalPressure: asksToSchedule ? 0.7 : 0.5,
      novelty,
      repetition,
      risk,
      ambiguity: 0.35,
      confidence: 0.7,
      specificity: 0.65,
      conflict: 0,
      goalAlignment: 0.75,
      strategicFit: 0.7,
      requiresSpecialist: asksToSpecialize || asksToSchedule,
      receivedAt: nowIso(),
      metadata
    };
  }
```
After (complete replacement function):
```js
  async messageToSignal({ text, channel, from, agent, sessionId, metadata }) {
    const lower = text.toLowerCase();
    const asksToRemember = REMEMBER_RE.test(lower);
    const asksToSchedule = SCHEDULE_RE.test(lower);
    const asksToSpecialize = SPECIALIZE_RE.test(lower);

    // C2: measured axes replace the old per-signal constants. Deterministic
    // heuristics over the text plus the runtime's stores; absent stores
    // degrade to the previous keyword values (see src/signal-axes.js).
    const axes = await measureAxes({
      text,
      memorySystem: this.runtime.memory ?? null,
      vectorStore: this.runtime.vectorStore ?? null,
      outcomeStore: this.runtime.outcomes ?? null
    });

    const taskType = asksToSpecialize ? "specialization-candidate" : "adaptation-review";

    const signal = {
      id: createId("sig"),
      source: channel,
      type: "message",
      domain: "general",
      taskType,
      summary: text.slice(0, 240),
      content: text,
      citations: [`session:${sessionId}`, `agent:${agent.id}`, `from:${from}`],
      tags: ["message", channel, agent.id],
      urgency: metadata.urgent ? 0.85 : 0.45,
      impact: axes.impact,
      externalPressure: 0.55,
      internalPressure: asksToSchedule ? 0.7 : 0.5,
      novelty: axes.novelty,
      repetition: axes.repetition,
      risk: axes.risk,
      ambiguity: 0.35,
      confidence: axes.confidence,
      specificity: axes.specificity,
      conflict: 0,
      goalAlignment: 0.75,
      strategicFit: 0.7,
      requiresSpecialist: asksToSpecialize || asksToSchedule,
      receivedAt: nowIso(),
      metadata
    };

    // C2/G2: specialization candidates carry a content-derived bounded scope
    // and success metric (propagation-controller.js:99-100 consumes them),
    // plus a scope-derived goal — the dedupe signature hashes
    // {workflow, domain, taskType, goal} (propagation-controller.js:177-184),
    // so without a distinct goal every scope would still collapse into one
    // general-specialization-candidate specialist.
    if (taskType === "specialization-candidate") {
      const scope = deriveSpecialistScope(text, signal.domain);
      if (scope) {
        signal.specialistScope = scope;
        signal.successMetric = "outcome quality >= 0.6 over next 10 activations";
        signal.goal = `Handle ${scope} tasks within a bounded scope.`;
      }
    }

    return signal;
  }
```

11. [ ] Run the integration test:
`cd /Users/you/Dev/openAGI && node --test test/message-to-signal-axes.test.js`
Expected: `# pass 2`, `# fail 0`, exit code 0.

12. [ ] Run the full suite (existing handleMessage tests exercise the awaited path with stub runtimes lacking vectorStore/outcomes, and with createDefaultRuntime):
`cd /Users/you/Dev/openAGI && npm test`
Expected: all test files pass, `# fail 0`. If test/ephemeral-turn.test.js or test/verdict-consequences.test.js fails here, the guards in measureAxes (`typeof vectorStore?.search === "function"`, `memorySystem?.items instanceof Map`, `typeof outcomeStore?.recent === "function"`) were altered — restore them exactly as written in step 3.

13. [ ] Run the axis test once more to confirm both new files pass together:
`cd /Users/you/Dev/openAGI && node --test test/signal-axes.test.js test/message-to-signal-axes.test.js`
Expected: `# pass 9`, `# fail 0`.

14. [ ] Commit the integration:
`cd /Users/you/Dev/openAGI && git add src/agent-host.js test/message-to-signal-axes.test.js && git commit -m "feat(scrutiny): messageToSignal measures axes and derives per-scope specialist signatures (G4, G2)"`
