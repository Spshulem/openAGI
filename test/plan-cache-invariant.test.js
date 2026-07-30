// test/plan-cache-invariant.test.js
// Pins the daily-plan cache contract from BOTH ends at once.
//
// runDailyPlan (src/abi-runtime.js) writes <dataDir>/plan/<dateISO>.json and
// composeBrief (src/daily-brief.js, readPlanCache) reads it back. Nothing else
// in the repo forces those two to agree: they are in different modules, the
// writer builds the path from resolveDataDir() and the reader from its own
// dataDir argument, and each half looks perfectly reasonable in isolation while
// pointing somewhere the other never looks. So the assertions below deliberately
// exercise the real writer and the real reader in one process rather than
// checking either against a hand-written path constant.
//
// Two properties are at risk and are pinned here:
//
//   1. The cache write sits ABOVE the "nothing scheduled" skip guard on purpose.
//      A thin day must still leave an artifact or the Quick Ask brief has no
//      plan to pin all day. That ordering is the kind of thing a later cleanup
//      "tidies" into the happy path — test 1 fails if it moves.
//   2. The reader finds the writer's file. Test 2 runs the cron path and then
//      composes a brief over the same dataDir and requires the brief's
//      planCachedAt to be byte-equal to the cachedAt on disk — that can only
//      hold if directory, filename and field name all still line up.
//
// NO MODEL CALL HAPPENS HERE. runDailyPlan -> computeDailyPlan -> synthesizeWithLLM
// returns null for a DeterministicModelProvider, so the plan comes from
// deterministicPlan(). Both tests assert that rather than trusting it: the
// provider class is checked, a fetch tripwire fails the test on any outbound
// request, and the persisted artifact must carry synthesized:false.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDurableRuntime, DeterministicModelProvider } from "../src/index.js";
import { _resetDataDirCache } from "../src/data-dir.js";
import { composeBrief } from "../src/daily-brief.js";

// The writer keys the filename on the LOCAL day (daily-planner's localDayBounds
// resolves the day in the machine timezone) while the reader keys it on the UTC
// day (readPlanCache slices now.toISOString()). Pinning the process to UTC makes
// those the same day by construction, so this test stays about the path/shape
// contract and does not pass or fail depending on where it is run.
process.env.TZ = "UTC";

const NOW = new Date("2026-07-29T15:00:00.000Z");
const TODAY_FILE = "2026-07-29.json";

// resolveDataDir() memoizes process-wide and runDailyPlan resolves through it
// rather than through any per-runtime field, so the env var must be set and the
// memo dropped for every runtime — otherwise the second runtime in this file
// writes into the first one's directory, or worse, into the real ~/.openagi.
function makeRuntime(prefix) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.OPENAGI_DATA_DIR = dataDir;
  _resetDataDirCache();
  const runtime = createDurableRuntime({
    dataDir,
    autoConnectMcp: false,
    modelProvider: new DeterministicModelProvider()
  });
  assert.equal(
    runtime.agentHost.modelProvider.constructor.name,
    "DeterministicModelProvider",
    "the planner must not reach a real provider: synthesizeWithLLM only bails out for this class"
  );
  return { runtime, dataDir };
}

// Fail loudly on any outbound request instead of silently making one. Both
// provider implementations go through global fetch, and synthesizeWithLLM
// swallows its own errors, so a thrown error alone would be invisible — the
// call count is what the assertion reads.
async function withoutNetwork(fn) {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (...args) => {
    calls += 1;
    throw new Error(`unexpected network call in a provider-less runtime: ${String(args[0])}`);
  };
  try {
    const value = await fn();
    return { value, calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("runDailyPlan caches the plan artifact even on an empty day (the write is above the skip guard)", async () => {
  const { runtime, dataDir } = makeRuntime("openagi-plancache-empty-");

  const { value: result, calls } = await withoutNetwork(() => runtime.runDailyPlan({ now: NOW }));
  assert.equal(calls, 0, "the daily plan must be computed without any model/HTTP call");

  // Empty install: no calendar, no pending tasks. The guard suppresses the
  // morning notification...
  assert.equal(result.skipped, true, "an empty day must not fire a hollow notification");

  // ...but the artifact must exist anyway, at exactly the path readPlanCache
  // rebuilds: <dataDir>/plan/<YYYY-MM-DD>.json.
  const cachePath = path.join(dataDir, "plan", TODAY_FILE);
  assert.ok(
    fs.existsSync(cachePath),
    `a skipped day must still leave ${cachePath}; found: ${JSON.stringify(safeList(path.join(dataDir, "plan")))}`
  );

  const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.equal(cached.dateISO, "2026-07-29", "the filename must match the plan's own dateISO");
  assert.ok(Array.isArray(cached.focus), "the brief reads plan.focus, so it must always be an array");
  assert.ok(
    Number.isFinite(Date.parse(cached.cachedAt)),
    `cachedAt must be a parseable timestamp, got ${JSON.stringify(cached.cachedAt)}`
  );
  assert.equal(cached.synthesized, false, "the deterministic fallback produced this plan, not a model");
});

test("composeBrief pins the focus item from the artifact runDailyPlan just wrote", async () => {
  const { runtime, dataDir } = makeRuntime("openagi-plancache-focus-");
  runtime.tasks.add({ title: "Ship the plan-cache test", bucket: "today" }, { queue: "user", source: "manual" });

  // Before the cron runs there is no artifact, so the brief has no focus row.
  // This baseline is what makes the post-condition meaningful: a "focus" item
  // can only come from the plan cache, never from the task store.
  const before = composeBrief(runtime, { now: NOW, dataDir });
  assert.equal(before.planCachedAt, null, "no plan artifact yet");
  assert.ok(!before.items.some((i) => i.kind === "focus"), "focus rows come only from the plan cache");

  const { calls } = await withoutNetwork(() => runtime.runDailyPlan({ now: NOW }));
  assert.equal(calls, 0, "the daily plan must be computed without any model/HTTP call");

  const after = composeBrief(runtime, { now: NOW, dataDir });
  const focus = after.items.find((i) => i.kind === "focus");
  assert.ok(focus, "the brief must pin today's focus item read back from the plan artifact");
  assert.equal(focus.title, "Ship the plan-cache test");
  assert.equal(focus.source, "daily-plan");

  // The load-bearing assertion: planCachedAt is the reader echoing back a field
  // only the writer produces. Equal values mean both halves resolved the same
  // file — a reader pointed at a different directory or filename would report
  // null here even though the artifact exists on disk.
  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, "plan", TODAY_FILE), "utf8"));
  assert.equal(after.planCachedAt, onDisk.cachedAt);
});

function safeList(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (error) {
    return `unreadable: ${error.code ?? error.message}`;
  }
}
