// test/brief-carried-over-timezone.test.js
// Companion to plan-cache-timezone.test.js, for the SAME class of bug one
// function over.
//
//   carriedOver() decided whether a task predates "today" by comparing its
//   createdAt against setUTCHours(0,0,0,0) -- the start of the UTC day, not the
//   start of the user's day. West of UTC those are different instants for the
//   tail of every local day (17:00 in America/Los_Angeles), so there is a
//   seven-hour window, every single day, where the verdict is simply wrong --
//   in BOTH directions:
//
//     * a task typed at 09:00 this morning is reported as "carried over"
//       once the UTC date rolls over at 17:00 local, and
//     * a task typed at 18:00 last night is NOT reported as carried over by
//       tomorrow morning's brief, because it was already "tomorrow" in UTC
//       when it was created.
//
//   Unlike a scoring wobble this is rendered verbatim: "carried over" lands in
//   the item's `why` string as a factual claim about the user's own day.
//
// TZ must be set before anything reads the clock; node --test gives each file
// its own process, so a module-scope assignment is enough (asserted below
// rather than assumed).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.TZ = "America/Los_Angeles";

const { composeBrief } = await import("../src/daily-brief.js");
const { planDateKey } = await import("../src/daily-planner.js");

// A runtime stub with nothing but tasks: the composer must stay a pure
// function of (stores, clock).
function makeRuntime(tasks) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-carried-tz-"));
  fs.mkdirSync(path.join(dataDir, "proactive", "suggestions"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "skills-suggested"), { recursive: true });
  return { dataDir, tasks: { list: () => tasks } };
}

function task(over = {}) {
  return {
    id: "t1", queue: "user", title: "A task", bucket: "today", priority: 50,
    status: "pending", dueDate: null, source: "manual", ...over
  };
}

function carriedVerdict(tasks, now) {
  const brief = composeBrief(makeRuntime(tasks), { now, limit: 5 });
  const item = brief.items.find((i) => i.id === "task:t1");
  assert.ok(item, "the task under test must be in the brief");
  return { flag: item.scoreBreakdown.carriedOver === 1, why: item.why };
}

test("the test process really is west of UTC (guards the premise of this file)", () => {
  assert.equal(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    "America/Los_Angeles",
    "setting process.env.TZ at module scope must reach Intl, or these tests prove nothing"
  );
  // The disagreement under test: these two instants are the same local day and
  // different UTC days.
  assert.equal(planDateKey(new Date("2026-07-30T09:00:00-07:00")), "2026-07-30");
  assert.equal(planDateKey(new Date("2026-07-30T22:00:00-07:00")), "2026-07-30");
  assert.equal(new Date("2026-07-30T22:00:00-07:00").toISOString().slice(0, 10), "2026-07-31");
});

test("a task created at 18:00 local yesterday IS carried over in this morning's brief", () => {
  // The 17:00-23:59 local window: created after the UTC date had already
  // rolled over, so the UTC-day comparison read it as created "today" and the
  // brief silently stopped calling a genuinely carried-over task carried over.
  const created = "2026-07-30T18:00:00-07:00"; // local Thu evening (= 2026-07-31T01:00Z)
  const now = new Date("2026-07-31T09:00:00-07:00"); // local Fri morning
  const { flag, why } = carriedVerdict([task({ createdAt: created })], now);
  assert.equal(flag, true, "it was created on an earlier LOCAL day, so it is carried over");
  assert.ok(why.includes("carried over"), `why must say so, got: ${why}`);
});

test("a task created at 23:30 local yesterday IS carried over in this morning's brief", () => {
  const created = "2026-07-30T23:30:00-07:00"; // = 2026-07-31T06:30Z
  const now = new Date("2026-07-31T08:00:00-07:00");
  assert.equal(carriedVerdict([task({ createdAt: created })], now).flag, true);
});

test("a task created this morning is NOT carried over in tonight's brief", () => {
  // The other direction of the same bug: after 17:00 local the UTC day is
  // already tomorrow, so every task created earlier the same local day fell
  // before "UTC midnight" and was labelled carried over the day it was typed.
  const created = "2026-07-30T09:00:00-07:00"; // = 2026-07-30T16:00Z
  const now = new Date("2026-07-30T22:00:00-07:00"); // = 2026-07-31T05:00Z
  const { flag, why } = carriedVerdict([task({ createdAt: created })], now);
  assert.equal(flag, false, "same local day: nothing has been carried over yet");
  assert.ok(!why.includes("carried over"), `why must not claim it, got: ${why}`);
});

test("a task created at 19:00 local is NOT carried over an hour later", () => {
  const created = "2026-07-30T19:00:00-07:00";
  const now = new Date("2026-07-30T20:00:00-07:00");
  assert.equal(carriedVerdict([task({ createdAt: created })], now).flag, false);
});

test("carried over still moves the score, so the verdict is not cosmetic", () => {
  const now = new Date("2026-07-31T09:00:00-07:00");
  const carried = carriedVerdict([task({ createdAt: "2026-07-30T18:00:00-07:00" })], now);
  const fresh = carriedVerdict([task({ createdAt: "2026-07-31T08:00:00-07:00" })], now);
  assert.equal(carried.flag, true);
  assert.equal(fresh.flag, false);
});
