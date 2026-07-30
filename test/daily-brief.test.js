// test/daily-brief.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { composeBrief } from "../src/daily-brief.js";

const NOW = new Date("2026-07-29T17:00:00.000Z");

// A runtime stub shaped like the real one: stores expose list(), and
// suggestions come from files that listAllSuggestions() walks. Keeping this a
// plain object (not a real AbiRuntime) is what makes the composer testable —
// it must never reach for HTTP or an LLM.
function makeRuntime({ tasks = [], drafts = [], clarifications = [], suggestions = [], muted = [], plan = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-brief-"));
  const sugDir = path.join(dataDir, "proactive", "suggestions");
  const minedDir = path.join(dataDir, "skills-suggested");
  fs.mkdirSync(sugDir, { recursive: true });
  fs.mkdirSync(minedDir, { recursive: true });
  for (const s of suggestions) {
    const dir = s.id.startsWith("prop_") ? sugDir : minedDir;
    fs.writeFileSync(path.join(dir, `${s.id}.json`), JSON.stringify(s));
  }
  if (plan) {
    const planDir = path.join(dataDir, "plan");
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, `${plan.dateISO}.json`), JSON.stringify(plan));
  }
  return {
    dataDir,
    tasks: { list: () => tasks },
    drafts: { list: () => drafts },
    clarifications: { list: () => clarifications },
    suggestionFeedback: {
      isMuted: (c) => muted.includes(c),
      categoryMultipliers: () => ({}) // the real-world value: nothing resolved in-window
    }
  };
}

function task(over = {}) {
  return {
    id: "t1", queue: "user", title: "A task", bucket: "today", priority: 50,
    status: "pending", dueDate: null, createdAt: "2026-07-29T09:00:00.000Z", source: "manual", ...over
  };
}

function minedSuggestion(over = {}) {
  return {
    id: "sug_1", proposedAt: "2026-07-29T10:00:00.000Z", category: "skill",
    title: "Save this workflow", rationale: "seen often", status: "pending", source: "pattern-miner",
    sequence: { confidence: 0.8, count: 9, distinctDays: 4, cadence: { type: "weekly" } }, ...over
  };
}

test("a huge suggestion backlog still yields at least one suggestion alongside overdue tasks", () => {
  // The regression this whole design exists to prevent: suggestions carry no
  // dueDate/priority, so one global sort lets tasks take every slot.
  const suggestions = Array.from({ length: 1000 }, (_, i) =>
    minedSuggestion({ id: `sug_${i}`, sequence: { confidence: 0.6 + (i % 30) / 100, count: i % 12, distinctDays: i % 6, cadence: { type: "irregular" } } })
  );
  const tasks = [
    task({ id: "t1", title: "Overdue A", dueDate: "2026-07-20T00:00:00.000Z" }),
    task({ id: "t2", title: "Overdue B", dueDate: "2026-07-21T00:00:00.000Z" }),
    task({ id: "t3", title: "Overdue C", dueDate: "2026-07-22T00:00:00.000Z" })
  ];
  const brief = composeBrief(makeRuntime({ tasks, suggestions }), { now: NOW, limit: 5 });
  assert.ok(brief.items.some((i) => i.kind === "suggestion"), "at least one suggestion must survive slot allocation");
  // NOT "tasks are capped at 2": the spec cascades unused slots to task FIRST
  // and suggestion second, so tasks legitimately spill past their slot budget.
  // What matters is that they cannot spill over the reserved suggestion floor.
  assert.ok(
    brief.items.filter((i) => i.kind === "task").length < brief.items.length,
    "tasks must not crowd suggestions out of the brief entirely"
  );
  assert.equal(brief.older.count, 1000 - brief.items.filter((i) => i.kind === "suggestion").length);
});

test("unused slots cascade to task before suggestion (spec order)", () => {
  // The measured case: 8 overdue tasks + 50 suggestions at the default limit.
  // Cascading suggestions first gave 2 tasks + 3 suggestions; the spec's order
  // gives 4 tasks + 1 suggestion — overdue work outranks miner candidates, and
  // the floor still guarantees the agent's own finding a seat.
  const tasks = Array.from({ length: 8 }, (_, i) =>
    task({ id: `t${i}`, title: `Overdue ${i}`, dueDate: `2026-07-${String(10 + i).padStart(2, "0")}T00:00:00.000Z` })
  );
  const suggestions = Array.from({ length: 50 }, (_, i) => minedSuggestion({ id: `sug_${i}` }));
  const brief = composeBrief(makeRuntime({ tasks, suggestions }), { now: NOW, limit: 5 });
  assert.equal(brief.items.filter((i) => i.kind === "task").length, 4, "tasks claim the cascade");
  assert.equal(brief.items.filter((i) => i.kind === "suggestion").length, 1, "the floor is exactly one, not the remainder");
  // Slot rank is also the render order: every task sits above the suggestion.
  assert.equal(brief.items.at(-1).kind, "suggestion");
});

test("empty category multipliers never produce NaN scores", () => {
  // categoryMultipliers() returns {} on a real install (nothing resolved in
  // the 30-day window). Without a ?? 1.0 default every score is NaN and the
  // sort order becomes implementation-defined.
  const brief = composeBrief(makeRuntime({ suggestions: [minedSuggestion()] }), { now: NOW, limit: 5 });
  for (const item of brief.items) {
    assert.ok(Number.isFinite(item.score), `score must be finite, got ${item.score} for ${item.id}`);
  }
});

test("muted categories are excluded", () => {
  const rt = makeRuntime({ suggestions: [minedSuggestion({ id: "sug_1", category: "skill" })], muted: ["skill"] });
  const brief = composeBrief(rt, { now: NOW, limit: 5 });
  assert.equal(brief.items.filter((i) => i.kind === "suggestion").length, 0);
});

test("automation suggestions never appear (no server-side accept branch exists)", () => {
  // The id MUST be prop_* : only observer candidates can ever carry
  // category "automation". listAllSuggestions() hardcodes category "skill" for
  // anything under skills-suggested/ (suggestion-feed.js normalize()), so a
  // sug_* fixture would silently arrive as a skill and prove nothing.
  const rt = makeRuntime({ suggestions: [minedSuggestion({ id: "prop_a", category: "automation" })] });
  const brief = composeBrief(rt, { now: NOW, limit: 5 });
  assert.equal(brief.items.length, 0);
});

test("older.count excludes suggestions that could never be rendered", () => {
  // "N older" is a promise about rows the popover COULD show. An automation
  // candidate (no server-side accept branch) and a muted-category one are both
  // filtered before slot allocation, so counting them advertises depth that
  // does not exist.
  const rt = makeRuntime({
    suggestions: [minedSuggestion({ id: "prop_a", category: "automation" }), minedSuggestion({ id: "sug_m" })],
    muted: ["skill"]
  });
  const brief = composeBrief(rt, { now: NOW, limit: 5 });
  assert.equal(brief.items.length, 0, "neither suggestion is renderable");
  assert.equal(brief.older.count, 0, "so neither may be advertised as older");
  assert.equal(brief.older.oldestAt, null, "and there is no oldest older item");
});

test("older.count still counts eligible suggestions that merely did not fit", () => {
  const suggestions = Array.from({ length: 4 }, (_, i) => minedSuggestion({ id: `sug_${i}` }));
  const rt = makeRuntime({ suggestions: [...suggestions, minedSuggestion({ id: "prop_x", category: "automation" })] });
  const brief = composeBrief(rt, { now: NOW, limit: 2 });
  const shown = brief.items.filter((i) => i.kind === "suggestion").length;
  assert.equal(brief.older.count, 4 - shown);
  assert.ok(brief.older.oldestAt, "an eligible-but-unshown suggestion has an age");
});

test("a genuinely empty suggestion store is not degraded", () => {
  const brief = composeBrief(makeRuntime({ tasks: [task()] }), { now: NOW, limit: 5 });
  assert.deepEqual(brief.degraded, [], "an empty queue is a healthy queue");
});

test("an unreadable suggestion store is reported in degraded", () => {
  // listAllSuggestions() catches its own readdir errors and returns [], so the
  // safely() boundary never sees a throw — without an explicit check the brief
  // claims a healthy empty queue while the store is actually gone.
  const rt = makeRuntime({ tasks: [task()] });
  rt.dataDir = path.join(os.tmpdir(), `openagi-brief-missing-${process.pid}-${Date.now()}`);
  const brief = composeBrief(rt, { now: NOW, limit: 5 });
  assert.deepEqual(brief.degraded, ["suggestions"]);
  assert.ok(brief.items.length > 0, "the surviving sources still render");
});

test("a plan focus item is pinned first even though it has no due date", () => {
  const plan = {
    dateISO: "2026-07-29", cachedAt: "2026-07-29T15:00:00.000Z",
    focus: [{ title: "Ship the brief", taskId: null, why: "biggest lever today" }], tasks: []
  };
  const tasks = [task({ id: "t1", title: "Overdue", dueDate: "2026-07-01T00:00:00.000Z" })];
  const brief = composeBrief(makeRuntime({ tasks, plan }), { now: NOW, limit: 5 });
  assert.equal(brief.items[0].kind, "focus");
  assert.equal(brief.items[0].title, "Ship the brief");
  assert.equal(brief.planCachedAt, "2026-07-29T15:00:00.000Z");
});

test("a focus item with an unresolvable taskId still renders, with no task actions", () => {
  const plan = {
    dateISO: "2026-07-29", cachedAt: "2026-07-29T15:00:00.000Z",
    focus: [{ title: "Hallucinated", taskId: "t_does_not_exist", why: "x" }], tasks: []
  };
  const brief = composeBrief(makeRuntime({ plan }), { now: NOW, limit: 5 });
  assert.equal(brief.items[0].kind, "focus");
  assert.deepEqual(brief.items[0].actions, []);
});

test("a task that is already the pinned focus does not also occupy a task slot", () => {
  const plan = {
    dateISO: "2026-07-29", cachedAt: "2026-07-29T15:00:00.000Z",
    focus: [{ title: "The one thing", taskId: "t1", why: "overdue" }], tasks: []
  };
  const tasks = [task({ id: "t1", title: "The one thing" }), task({ id: "t2", title: "Other" })];
  const brief = composeBrief(makeRuntime({ tasks, plan }), { now: NOW, limit: 5 });
  assert.equal(brief.items.filter((i) => i.id === "task:t1").length, 0);
  assert.equal(brief.items.filter((i) => i.id === "focus:t1").length, 1);
});

test("miner suggestions rank on their own evidence, strongest first", () => {
  const weak = minedSuggestion({ id: "sug_weak", sequence: { confidence: 0.55, count: 1, distinctDays: 1, cadence: { type: "irregular" } } });
  const strong = minedSuggestion({ id: "sug_strong", sequence: { confidence: 0.95, count: 12, distinctDays: 6, cadence: { type: "weekly" } } });
  const brief = composeBrief(makeRuntime({ suggestions: [weak, strong] }), { now: NOW, limit: 5 });
  const sugs = brief.items.filter((i) => i.kind === "suggestion");
  assert.equal(sugs[0].id, "suggestion:sug_strong");
});

test("overdue tasks outrank not-yet-due ones", () => {
  const tasks = [
    task({ id: "t_soon", title: "Later", bucket: "this_week", dueDate: "2026-08-20T00:00:00.000Z" }),
    task({ id: "t_late", title: "Overdue", dueDate: "2026-07-01T00:00:00.000Z" })
  ];
  const brief = composeBrief(makeRuntime({ tasks }), { now: NOW, limit: 5 });
  const t = brief.items.filter((i) => i.kind === "task");
  assert.equal(t[0].id, "task:t_late");
});

test("a failing source is isolated and named in degraded", () => {
  const rt = makeRuntime({ suggestions: [minedSuggestion()] });
  rt.tasks = { list: () => { throw new Error("boom"); } };
  const brief = composeBrief(rt, { now: NOW, limit: 5 });
  assert.ok(brief.degraded.includes("tasks"));
  assert.ok(brief.items.length > 0, "the brief still renders without the failed source");
});

test("no plan cache is a normal state, not an error", () => {
  const brief = composeBrief(makeRuntime({ tasks: [task()] }), { now: NOW, limit: 5 });
  assert.equal(brief.planCachedAt, null);
  assert.equal(brief.degraded.includes("plan"), false);
  assert.ok(brief.items.length > 0);
});

test("every item carries declarative actions with an absolute daemon path", () => {
  const tasks = [task({ id: "t1" })];
  const brief = composeBrief(makeRuntime({ tasks, suggestions: [minedSuggestion()] }), { now: NOW, limit: 5 });
  for (const item of brief.items) {
    for (const a of item.actions) {
      assert.ok(a.path.startsWith("/"), `action path must be absolute: ${a.path}`);
      assert.ok(["POST", "PATCH", "DELETE"].includes(a.method));
      assert.ok(a.label.length > 0);
    }
  }
});

test("clarifications and drafts get slots and age-based scores", () => {
  const rt = makeRuntime({
    clarifications: [{ id: "c1", question: "Did you finish X?", status: "pending", createdAt: "2026-07-28T17:00:00.000Z", taskId: "t1" }],
    drafts: [{ id: "d1", title: "Reply to Adam", status: "pending", createdAt: "2026-07-27T17:00:00.000Z", kind: "email" }]
  });
  const brief = composeBrief(rt, { now: NOW, limit: 5 });
  assert.ok(brief.items.some((i) => i.kind === "clarification"));
  assert.ok(brief.items.some((i) => i.kind === "draft"));
  const clar = brief.items.find((i) => i.kind === "clarification");
  assert.equal(clar.actions.length, 4, "one button per valid answer");
});
