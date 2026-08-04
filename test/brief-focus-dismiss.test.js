// test/brief-focus-dismiss.test.js
//
// The user's report, verbatim: "'Keep the day intentionally open': why would I
// want to add that as a task? It doesn't seem like there's a way to dismiss it."
//
// A daily-plan focus row that resolves to no task got exactly one action —
// "Add to tasks" — and the planner routinely writes ADVICE into focus, not
// work. Measured on the real install (~/.openagi/plan/2026-08-03.json): both of
// today's focus rows carry `taskId: null` and read "Set priorities for the week"
// and "Protect open time for one meaningful work block". Neither is a to-do,
// neither could be cleared, and the row is PINNED above everything, so it
// squatted the top slot all day.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { composeBrief, dismissFocus } from "../src/daily-brief.js";

// Fixed clock. 17:00Z on 2026-07-29 is still 2026-07-29 in America/Los_Angeles,
// so the local day key the plan artifact is named for is unambiguous here.
const NOW = new Date("2026-07-29T17:00:00.000Z");
const TODAY = "2026-07-29";

function makeRuntime({ tasks = [], plan = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-focusdismiss-"));
  fs.mkdirSync(path.join(dataDir, "proactive", "suggestions"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "skills-suggested"), { recursive: true });
  if (plan) {
    fs.mkdirSync(path.join(dataDir, "plan"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "plan", `${plan.dateISO}.json`), JSON.stringify(plan));
  }
  return {
    dataDir,
    tasks: {
      list: ({ status } = {}) => (status ? tasks.filter((t) => (t.status ?? "pending") === status) : tasks),
      get: (id) => tasks.find((t) => t.id === id) ?? null
    },
    drafts: { list: () => [] },
    clarifications: { list: () => [] },
    suggestionFeedback: { isMuted: () => false, categoryMultipliers: () => ({}) }
  };
}

const ADVICE = "Keep the day intentionally open — no scheduled meetings, deadlines, or carried-over commitments";

function advicePlan(extra = []) {
  return {
    dateISO: TODAY,
    focus: [{ title: ADVICE, taskId: null, why: "nothing is scheduled" }, ...extra]
  };
}

function focusRows(brief) { return brief.items.filter((i) => i.kind === "focus"); }

// ── the offer ──────────────────────────────────────────────────────────────

test("an unbacked focus row can be made to go away — 'Add to tasks' is not the only option", () => {
  const rt = makeRuntime({ plan: advicePlan() });
  const row = focusRows(composeBrief(rt, { now: NOW, limit: 5 }))[0];
  assert.ok(row, "premise: the advice row is pinned");
  const ids = row.actions.map((a) => a.id);
  assert.ok(ids.includes("dismiss"), `no way to clear the row; actions were ${JSON.stringify(ids)}`);
  assert.ok(ids.length > 1, "one action on an unbacked focus is the bug");
});

test("the dismiss action is dispatchable verbatim and names the row it clears", () => {
  const rt = makeRuntime({ plan: advicePlan() });
  const row = focusRows(composeBrief(rt, { now: NOW, limit: 5 }))[0];
  const dismiss = row.actions.find((a) => a.id === "dismiss");
  assert.equal(dismiss.method, "POST");
  assert.equal(dismiss.path, "/brief/focus/dismiss");
  assert.ok(dismiss.body && typeof dismiss.body.key === "string" && dismiss.body.key.length > 0,
    "the key travels in the BODY, so no filename is ever derived from planner prose");
});

test("neither offer on an unbacked focus is styled as the recommended one", () => {
  // "Add to tasks" as `style: primary` is what made the row read as "you should
  // do this". The composer cannot tell advice from work, so it recommends
  // neither and lets the user decide which this is.
  const rt = makeRuntime({ plan: advicePlan() });
  const row = focusRows(composeBrief(rt, { now: NOW, limit: 5 }))[0];
  assert.ok(!row.actions.some((a) => a.style === "primary"),
    "an unbacked focus has no obviously-correct action, so nothing may claim to be one");
});

test("a focus row backed by a real task keeps acting on the task, and gains no dismiss", () => {
  // Done and Snooze already resolve it, and hiding a row while leaving the task
  // alive would be the same "it keeps coming back" bug in a new place.
  const rt = makeRuntime({
    tasks: [{ id: "t9", queue: "user", title: "Ship the brief", bucket: "today", status: "pending", priority: 50, createdAt: "2026-07-29T09:00:00.000Z" }],
    plan: { dateISO: TODAY, focus: [{ title: "Ship the brief", taskId: "t9", why: "biggest lever" }] }
  });
  const row = focusRows(composeBrief(rt, { now: NOW, limit: 5 }))[0];
  assert.deepEqual(row.actions.map((a) => a.id), ["complete", "snooze"]);
});

test("every focus row still carries at least one action", () => {
  // The rule an earlier fix established. Dismiss satisfies it; a silent NOTE
  // with no actions would regress it into a dead row.
  const rt = makeRuntime({ plan: advicePlan([{ title: "Another piece of advice", taskId: null, why: "x" }]) });
  for (const row of focusRows(composeBrief(rt, { now: NOW, limit: 5 }))) {
    assert.ok(row.actions.length > 0, `focus row ${row.id} rendered with no actions`);
  }
});

// ── the dismissal actually sticks ──────────────────────────────────────────

test("dismissing an advice row removes it from the NEXT brief", () => {
  const rt = makeRuntime({ plan: advicePlan() });
  const before = focusRows(composeBrief(rt, { now: NOW, limit: 5 }))[0];
  const key = before.actions.find((a) => a.id === "dismiss").body.key;

  const result = dismissFocus(rt, { key, now: NOW, dataDir: rt.dataDir });
  assert.equal(result.ok, true, JSON.stringify(result));

  const after = composeBrief(rt, { now: NOW, limit: 5 });
  assert.equal(focusRows(after).length, 0, "the row the user dismissed came straight back");
});

test("dismissing the top focus promotes the next one instead of leaving the slot empty", () => {
  const rt = makeRuntime({ plan: advicePlan([{ title: "Protect one meaningful work block", taskId: null, why: "clear calendar" }]) });
  const first = focusRows(composeBrief(rt, { now: NOW, limit: 5 }))[0];
  dismissFocus(rt, { key: first.actions.find((a) => a.id === "dismiss").body.key, now: NOW, dataDir: rt.dataDir });

  const rows = focusRows(composeBrief(rt, { now: NOW, limit: 5 }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Protect one meaningful work block",
    "the plan's second focus should take the freed slot");
});

test("a dismissal is scoped to ONE local day — tomorrow's plan is a fresh claim", () => {
  const rt = makeRuntime({ plan: advicePlan() });
  const key = focusRows(composeBrief(rt, { now: NOW, limit: 5 }))[0].actions.find((a) => a.id === "dismiss").body.key;
  dismissFocus(rt, { key, now: NOW, dataDir: rt.dataDir });

  // Same advice, tomorrow's plan artifact.
  const tomorrow = new Date("2026-07-30T17:00:00.000Z");
  fs.writeFileSync(
    path.join(rt.dataDir, "plan", "2026-07-30.json"),
    JSON.stringify({ dateISO: "2026-07-30", focus: [{ title: ADVICE, taskId: null, why: "still nothing scheduled" }] })
  );
  assert.equal(focusRows(composeBrief(rt, { now: tomorrow, limit: 5 })).length, 1,
    "yesterday's 'not today' must not silence today's plan");
});

test("dismissing writes nothing outside the plan cache dir, whatever the key says", () => {
  const rt = makeRuntime({ plan: advicePlan() });
  const evil = "../../../../etc/openagi-pwned";
  const result = dismissFocus(rt, { key: evil, now: NOW, dataDir: rt.dataDir });
  assert.equal(result.ok, true, "an unknown key is recorded, not rejected — it just hides nothing");
  const record = JSON.parse(fs.readFileSync(path.join(rt.dataDir, "plan", "dismissed", `${TODAY}.json`), "utf8"));
  assert.deepEqual(record.focus, [evil], "the key is DATA inside one per-day file, never a path segment");
});

test("dismissing twice is idempotent, and a second dismissal keeps the first", () => {
  const rt = makeRuntime({ plan: advicePlan([{ title: "Protect one meaningful work block", taskId: null, why: "x" }]) });
  const rows = () => focusRows(composeBrief(rt, { now: NOW, limit: 5 }));
  const k1 = rows()[0].actions.find((a) => a.id === "dismiss").body.key;
  dismissFocus(rt, { key: k1, now: NOW, dataDir: rt.dataDir });
  dismissFocus(rt, { key: k1, now: NOW, dataDir: rt.dataDir });
  const k2 = rows()[0].actions.find((a) => a.id === "dismiss").body.key;
  dismissFocus(rt, { key: k2, now: NOW, dataDir: rt.dataDir });

  const record = JSON.parse(fs.readFileSync(path.join(rt.dataDir, "plan", "dismissed", `${TODAY}.json`), "utf8"));
  assert.deepEqual(record.focus, [k1, k2], "one entry per dismissal, in the order the user made them");
  assert.equal(rows().length, 0);
});

test("a blank key is refused rather than silently recorded", () => {
  const rt = makeRuntime({ plan: advicePlan() });
  assert.equal(dismissFocus(rt, { key: "   ", now: NOW, dataDir: rt.dataDir }).ok, false);
  assert.equal(dismissFocus(rt, { key: null, now: NOW, dataDir: rt.dataDir }).ok, false);
  assert.equal(focusRows(composeBrief(rt, { now: NOW, limit: 5 })).length, 1, "and nothing was hidden");
});

test("an unreadable dismissal record costs the dismissal, never the brief", () => {
  // A corrupt sidecar must not blank the pinned row — the brief still renders,
  // it just cannot honour a suppression it could not read.
  const rt = makeRuntime({ plan: advicePlan() });
  const dir = path.join(rt.dataDir, "plan", "dismissed");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${TODAY}.json`), "{not json");
  const brief = composeBrief(rt, { now: NOW, limit: 5 });
  assert.equal(focusRows(brief).length, 1);
  assert.ok(!brief.degraded.includes("plan"), "a missing suppression is not a broken source");
});
