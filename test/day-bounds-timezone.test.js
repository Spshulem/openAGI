// test/day-bounds-timezone.test.js
// The third member of the family that includes plan-cache-timezone.test.js and
// brief-carried-over-timezone.test.js, and the one furthest upstream.
//
//   localDayBounds() is documented to return the UTC instants bounding the
//   user's local day, and its two return values are the ONLY window the daily
//   planner and the evening recap ever look at: startISO/endISO are handed to
//   calendar_events_between, and every pull* filter compares timestamps against
//   them. What it actually returned was local midnight RELABELLED as UTC --
//
//       const startLocal = new Date(`${y}-${m}-${d}T00:00:00`); // PROCESS tz
//       const off = startLocal.getTimezoneOffset();             // PROCESS tz
//       new Date(startLocal.getTime() - off * 60_000);          // cancels out
//
//   -- i.e. always exactly YYYY-MM-DDT00:00:00Z for the local date, whatever
//   the user's zone. In America/Los_Angeles that names 17:00 the previous
//   afternoon, so "today's plan" spanned 5pm yesterday to 5pm today: it pulled
//   in last night's calendar and dropped tonight's, and the brief then pinned a
//   focus row off that window. The human-facing `label` was wrong by a whole
//   day for the same reason ("Your day -- Wednesday, July 29" on Thursday).
//
//   UTC is the one zone where the relabelling is a no-op, which is exactly why
//   every pre-existing test passed: they all pass timezone: "UTC" or run under
//   TZ=UTC. This file therefore pins zones on BOTH sides of the meridian, and
//   asserts against instants computed from the zone's real offset rather than
//   against whatever the implementation happens to produce.
//
// TZ must be set before anything reads the clock; node --test gives each file
// its own process, so a module-scope assignment is enough (asserted below
// rather than assumed). It is deliberately set to a zone that is NEITHER of
// the zones under test: localDayBounds takes its zone as an argument, so a
// correct implementation cannot care what the process zone is.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.TZ = "America/New_York";

const { localDayBounds, planDateKey } = await import("../src/daily-planner.js");
const { computeDailyRecap } = await import("../src/daily-recap.js");

// 2026-07-30T16:00:00Z is 09:00 in Los Angeles (UTC-7, PDT) and 01:00 the NEXT
// calendar day in Tokyo (UTC+9) -- one instant, two local dates, neither of
// them the UTC one for part of the day.
const NOW = new Date("2026-07-30T16:00:00Z");

test("the test process zone is a third zone (guards the premise of this file)", () => {
  assert.equal(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    "America/New_York",
    "setting process.env.TZ at module scope must reach Intl, or these tests prove nothing"
  );
  // The zone argument, not the process zone, is what decides the local date.
  assert.equal(planDateKey(NOW, "America/Los_Angeles"), "2026-07-30");
  assert.equal(planDateKey(NOW, "Asia/Tokyo"), "2026-07-31");
});

test("localDayBounds: west of UTC, the window is the user's local day", () => {
  const { startISO, endISO, label } = localDayBounds(NOW, "America/Los_Angeles");
  // 2026-07-30 00:00 PDT (UTC-7) == 07:00Z; the day closes 24h later.
  assert.equal(startISO, "2026-07-30T07:00:00.000Z", "start is local midnight, not 00:00Z");
  assert.equal(endISO, "2026-07-31T07:00:00.000Z", "end is the next local midnight");
  // The label must name the day the user is actually living.
  assert.equal(label, "Thursday, July 30");
});

test("localDayBounds: east of UTC, the window is the user's local day", () => {
  const { startISO, endISO, label } = localDayBounds(NOW, "Asia/Tokyo");
  // In Tokyo it is already the 31st; midnight of the 31st JST (UTC+9) was
  // 2026-07-30T15:00Z -- an hour before NOW, and a different UTC date.
  assert.equal(startISO, "2026-07-30T15:00:00.000Z", "start is local midnight, not 00:00Z");
  assert.equal(endISO, "2026-07-31T15:00:00.000Z", "end is the next local midnight");
  assert.equal(label, "Friday, July 31");
});

test("localDayBounds: UTC is unchanged (the case the old code got right)", () => {
  const { startISO, endISO, label } = localDayBounds(NOW, "UTC");
  assert.equal(startISO, "2026-07-30T00:00:00.000Z");
  assert.equal(endISO, "2026-07-31T00:00:00.000Z");
  assert.equal(label, "Thursday, July 30");
});

test("localDayBounds: the bounds bracket the instant they were derived from", () => {
  // The property that actually matters, stated without arithmetic: whatever
  // "now" is, "now" is inside today. The old code violated this every day
  // after 17:00 local in Los Angeles and before 09:00 local in Tokyo.
  for (const tz of ["America/Los_Angeles", "Asia/Tokyo", "UTC", "Europe/Berlin", "Asia/Kolkata"]) {
    for (const hourZ of [0, 6, 12, 16, 23]) {
      const at = new Date(Date.UTC(2026, 6, 30, hourZ, 30));
      const { startISO, endISO } = localDayBounds(at, tz);
      assert.ok(
        +new Date(startISO) <= +at && +at < +new Date(endISO),
        `${tz} @ ${at.toISOString()}: ${startISO}..${endISO} does not contain it`
      );
      // ...and the window is the day it claims to be.
      assert.equal(planDateKey(new Date(startISO), tz), planDateKey(at, tz), `${tz} @ ${at.toISOString()}: start is a different local day`);
    }
  }
});

test("localDayBounds: a DST day is 23 or 25 hours long, not 24", () => {
  // 2026-11-01, America/Los_Angeles: clocks fall back at 02:00 PDT, so the
  // local day runs 25 hours. Hard-coding start + 86_400_000 is wrong here in a
  // way no UTC-only test can see.
  const fallBack = localDayBounds(new Date("2026-11-01T18:00:00Z"), "America/Los_Angeles");
  assert.equal(fallBack.startISO, "2026-11-01T07:00:00.000Z", "midnight was still PDT (UTC-7)");
  assert.equal(fallBack.endISO, "2026-11-02T08:00:00.000Z", "next midnight is PST (UTC-8)");
  assert.equal((+new Date(fallBack.endISO) - +new Date(fallBack.startISO)) / 3_600_000, 25);

  // 2026-03-08 is the spring-forward: 23 hours.
  const springForward = localDayBounds(new Date("2026-03-08T18:00:00Z"), "America/Los_Angeles");
  assert.equal(springForward.startISO, "2026-03-08T08:00:00.000Z", "midnight was still PST (UTC-8)");
  assert.equal(springForward.endISO, "2026-03-09T07:00:00.000Z", "next midnight is PDT (UTC-7)");
  assert.equal((+new Date(springForward.endISO) - +new Date(springForward.startISO)) / 3_600_000, 23);
});

// ── the consequence, at the layer the user sees ──────────────────────────────

// The recap's filters are string comparisons against startISO/endISO, so a
// shifted window silently reclassifies real events. This drives the real
// computeDailyRecap over a stub runtime whose only content is three timestamps
// straddling the Los Angeles day boundary.
test("computeDailyRecap: yesterday evening's work is not counted as today's", () => {
  const at = (iso) => new Date(iso).toISOString();
  const runtime = {
    tasks: {
      list: ({ status }) => status === "completed" ? [
        // 21:00 PDT on the 29th -- yesterday. 04:00Z on the 30th, so the old
        // 00:00Z..00:00Z window swallowed it.
        { id: "t_last_night", title: "Last night's task", queue: "user", updatedAt: at("2026-07-30T04:00:00Z") },
        // 09:00 PDT on the 30th -- today, under any reading.
        { id: "t_today", title: "This morning's task", queue: "user", updatedAt: at("2026-07-30T16:00:00Z") },
        // 22:00 PDT on the 30th -- still today locally, but 05:00Z on the 31st,
        // so the old window had already closed on it.
        { id: "t_tonight", title: "Tonight's task", queue: "user", updatedAt: at("2026-07-31T05:00:00Z") }
      ] : []
    },
    outcomes: { recent: () => [] },
    pendingActions: { list: () => [] },
    computerUseLog: { listActions: () => [] },
    observations: { _recentCache: null },
    proactiveObserver: { list: () => [] },
    agentHost: { store: { listSessions: () => [] } }
  };

  // Composed late in the local evening, which is where the old bug bit hardest.
  const recap = computeDailyRecap(runtime, {
    date: new Date("2026-07-31T04:00:00Z"), // 21:00 PDT on the 30th
    timezone: "America/Los_Angeles"
  });

  const ids = recap.completedTasks.map((t) => t.id);
  assert.deepEqual(ids.sort(), ["t_today", "t_tonight"], "the local day, not the UTC day");
  assert.equal(recap.dateISO, "2026-07-30", "the day the user is living");
  assert.equal(recap.date, "Thursday, July 30");
  assert.equal(recap.range.from, "2026-07-30T07:00:00.000Z");
  assert.equal(recap.range.to, "2026-07-31T07:00:00.000Z");
});

// Every timestamp the recap filters is produced by nowIso() (utils.js), i.e.
// Date#toISOString -- always UTC with a trailing Z and always the same width.
// That is the only reason the pull* filters can get away with comparing ISO
// strings lexicographically instead of parsing them, and it stays true after
// the bounds change because the bounds are still toISOString(). Pinned so that
// a future writer emitting a local-offset timestamp ("+09:00") trips here,
// where the cause is written down, rather than as a mystery empty recap.
test("ISO-string ordering is a valid instant ordering for the recap's filters", () => {
  const { startISO, endISO } = localDayBounds(NOW, "Asia/Tokyo");
  for (const iso of [startISO, endISO]) {
    assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "bounds must stay UTC-Z");
  }
  const inside = new Date("2026-07-30T20:00:00Z").toISOString();
  const before = new Date("2026-07-30T14:59:59Z").toISOString();
  const after = new Date("2026-07-31T15:00:00Z").toISOString();
  assert.ok(inside >= startISO && inside < endISO);
  assert.ok(!(before >= startISO));
  assert.ok(!(after < endISO));
});
