// test/plan-cache-timezone.test.js
// Companion to plan-cache-invariant.test.js, which pins the process to UTC so
// it can test the path/shape contract without timezone noise. That choice left
// the timezone axis itself uncovered, and a real bug lived exactly there:
//
//   The plan artifact is named for the user's LOCAL day, but readPlanCache used
//   to build the filename from now.toISOString().slice(0,10) -- the UTC day.
//   West of UTC those disagree for the tail of every day: in America/
//   Los_Angeles the UTC date rolls over at 17:00 local, so from 5pm until
//   midnight the brief looked for TOMORROW's file, found nothing, and silently
//   dropped its focus row while the correct artifact sat on disk. Seven hours a
//   day, on the surface the user reaches for most in the evening, with no error
//   anywhere -- a missing plan file is a legitimate first-run state, so nothing
//   was flagged as degraded.
//
// This file runs west of UTC, at an hour where the two disagree. TZ must be set
// before anything reads the clock; node --test gives each file its own process,
// so a module-scope assignment is enough (asserted below rather than assumed).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.TZ = "America/Los_Angeles";

const { createDurableRuntime, DeterministicModelProvider } = await import("../src/index.js");
const { _resetDataDirCache } = await import("../src/data-dir.js");
const { composeBrief } = await import("../src/daily-brief.js");
const { planDateKey } = await import("../src/daily-planner.js");

// 18:00 PT on the 30th is already 01:00 UTC on the 31st -- the window where the
// old reader went looking for a file the writer had no reason to create.
const EVENING_PT = new Date("2026-07-30T18:00:00-07:00");
const LOCAL_DAY = "2026-07-30";

test("the test process really is west of UTC (guards the premise of this file)", () => {
  assert.equal(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    "America/Los_Angeles",
    "setting process.env.TZ at module scope must reach Intl, or these tests prove nothing"
  );
  assert.equal(planDateKey(EVENING_PT), LOCAL_DAY, "local day");
  assert.equal(
    EVENING_PT.toISOString().slice(0, 10),
    "2026-07-31",
    "and the UTC day is genuinely a day ahead here -- this is the disagreement under test"
  );
});

test("the evening brief still finds the plan written earlier the same local day", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-plancache-tz-"));
  process.env.OPENAGI_DATA_DIR = dataDir;
  _resetDataDirCache();

  const runtime = createDurableRuntime({
    dataDir,
    autoConnectMcp: false,
    modelProvider: new DeterministicModelProvider()
  });
  runtime.tasks.add(
    { title: "Evening focus item", bucket: "today" },
    { queue: "user", source: "manual" }
  );

  await runtime.runDailyPlan({ now: EVENING_PT });

  // The artifact is named for the local day, not the UTC one.
  assert.deepEqual(
    fs.readdirSync(path.join(dataDir, "plan")),
    [`${LOCAL_DAY}.json`],
    "the writer names the artifact for the user's local day"
  );

  // The assertion that fails on the old reader: it would resolve
  // plan/2026-07-31.json, miss, and return a brief with no focus row at all.
  const brief = composeBrief(runtime, { now: EVENING_PT, dataDir });
  assert.ok(
    brief.planCachedAt,
    "the evening brief must resolve the same artifact the morning cron wrote"
  );
  const focus = brief.items.find((i) => i.kind === "focus");
  assert.ok(focus, "the focus row must survive the UTC date rollover");
  assert.equal(focus.title, "Evening focus item");
});
