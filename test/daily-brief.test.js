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
    // Honours the status filter the way task-store.list() does. The composer
    // asks once per active status, so a stub that ignored the filter (the
    // previous one did) would hand every row back twice and hide the dedupe.
    tasks: { list: ({ status } = {}) => (status ? tasks.filter((t) => (t.status ?? "pending") === status) : tasks) },
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

// THE fail-open case the allowlist exists for. The filter used to be a
// blocklist of one ("automation"), so a category nobody had thought about
// rendered a "Yes" that flipped the record to accepted, did nothing, and told
// the user "Suggestion accepted". Verified live with category "reminder"
// before the inversion: it rendered accept + reject.
test("an unknown suggestion category never renders an accept action", () => {
  // prop_* so the observer envelope keeps the category verbatim — anything
  // under skills-suggested/ is normalized to "skill" and would prove nothing.
  const rt = makeRuntime({
    suggestions: [
      minedSuggestion({ id: "prop_reminder", category: "reminder" }),
      minedSuggestion({ id: "prop_digest", category: "digest" }),
      minedSuggestion({ id: "prop_none", category: undefined })
    ]
  });
  const brief = composeBrief(rt, { now: NOW, limit: 5 });
  assert.deepEqual(
    brief.items.flatMap((i) => i.actions.filter((a) => a.id === "accept")),
    [],
    "no row may offer an accept the server has no branch for"
  );
  assert.equal(brief.items.length, 0, "a category with no accept path is hidden, not shown button-less");
  assert.equal(brief.older.count, 0, "and an invisible row is not 'older' either");
});

// The other half of the invariant: closing the filter must not close it on the
// categories hosted-interface.js really does materialize (mcp → registerServer,
// task → materializeTaskFromSuggestion, skill → createSkillFrom*, knowledge →
// memory.remember). Hiding those would be its own quiet lie.
test("every category with a real server-side accept branch still renders one", () => {
  for (const category of ["mcp", "task", "skill", "knowledge"]) {
    const rt = makeRuntime({ suggestions: [minedSuggestion({ id: `prop_${category}`, category })] });
    const brief = composeBrief(rt, { now: NOW, limit: 5 });
    const row = brief.items.find((i) => i.id === `suggestion:prop_${category}`);
    assert.ok(row, `${category} suggestions must still reach the brief`);
    const accept = row.actions.find((a) => a.id === "accept");
    assert.ok(accept, `${category} must keep its accept action`);
    assert.equal(accept.path, `/proactive/suggestions/prop_${category}/accept`);
  }
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
  assert.deepEqual(brief.older.byKind, {
    clarifications: 0,
    drafts: 0,
    tasks: 0,
    suggestions: 4 - shown
  });
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

test("a focus item with an unresolvable taskId renders with a working action, never zero", () => {
  // It used to render with actions: [] — a pinned top row with no tap target
  // and no way to clear it. The focus row is the one row the user cannot
  // dismiss, so a dead one squats the slot until tomorrow's plan.
  const plan = {
    dateISO: "2026-07-29", cachedAt: "2026-07-29T15:00:00.000Z",
    focus: [{ title: "Hallucinated", taskId: "t_does_not_exist", why: "x" }], tasks: []
  };
  const brief = composeBrief(makeRuntime({ plan }), { now: NOW, limit: 5 });
  assert.equal(brief.items[0].kind, "focus");
  assert.ok(brief.items[0].actions.length > 0, "a focus row must never render with zero actions");
  const add = brief.items[0].actions[0];
  // The action must not point at the id that does not exist (a 404 button).
  assert.equal(add.method, "POST");
  assert.equal(add.path, "/tasks", "the only honest offer for an unbacked focus is to put it on the list");
  assert.equal(add.body.title, "Hallucinated");
});

test("a focus row whose task is already completed is dropped, not left action-less", () => {
  // The measured case: the user completes their focus task, it leaves the
  // pending list, and the row loses its buttons for the rest of the day.
  const plan = {
    dateISO: "2026-07-29", cachedAt: "2026-07-29T15:00:00.000Z",
    focus: [{ title: "The one thing", taskId: "t1", why: "biggest lever" }], tasks: []
  };
  const rt = makeRuntime({ tasks: [task({ id: "t2", title: "Something else" })], plan });
  // tasks.list() is the PENDING list, which a completed task has left; the
  // store still knows about it.
  rt.tasks.get = (id) => (id === "t1" ? task({ id: "t1", status: "completed", bucket: "done" }) : null);
  const brief = composeBrief(rt, { now: NOW, limit: 5 });
  assert.equal(brief.items.filter((i) => i.kind === "focus").length, 0, "a finished focus needs nothing from the user");
  assert.ok(brief.items.length > 0, "and the rest of the brief still renders");
});

test("a focus item with no taskId binds to a matching pending task and gets its actions", () => {
  const plan = {
    dateISO: "2026-07-29", cachedAt: "2026-07-29T15:00:00.000Z",
    focus: [{ title: "Ship the brief", taskId: null, why: "biggest lever" }], tasks: []
  };
  const rt = makeRuntime({ tasks: [task({ id: "t9", title: "Ship the brief" })], plan });
  const brief = composeBrief(rt, { now: NOW, limit: 5 });
  const focus = brief.items[0];
  assert.equal(focus.kind, "focus");
  assert.deepEqual(focus.actions.map((a) => a.id), ["complete", "snooze"]);
  assert.deepEqual(focus.entityRef, { kind: "task", id: "t9" });
  assert.ok(focus.menuActions.some((a) => a.id.startsWith("move:")), "a task-backed focus can be moved too");
  assert.ok(focus.actions[0].path.includes("t9"), "the buttons act on the task the focus is really about");
  assert.equal(brief.items.filter((i) => i.id === "task:t9").length, 0, "and it does not also take a task slot");
});

test("every focus row carries at least one action", () => {
  const plan = {
    dateISO: "2026-07-29", cachedAt: "2026-07-29T15:00:00.000Z",
    focus: [
      { title: "Narrative focus", taskId: null, why: "no task behind it" },
      { title: "Bad id", taskId: "nope", why: "x" }
    ],
    tasks: []
  };
  const brief = composeBrief(makeRuntime({ plan }), { now: NOW, limit: 5 });
  for (const item of brief.items.filter((i) => i.kind === "focus")) {
    assert.ok(item.actions.length > 0, `focus row ${item.id} rendered with no actions`);
  }
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

test("sub-day lateness is labelled in real units, and the score is untouched", () => {
  // Math.max(1, Math.round(-deltaDays)) called a task that missed a 3pm
  // deadline two hours ago "overdue 1d" — a factual claim about the user's own
  // calendar, and a wrong one. The score saturates at 1.0 either way, so only
  // the sentence was ever at stake.
  const tasks = [
    task({ id: "t_hours", title: "Two hours late", dueDate: "2026-07-29T15:00:00.000Z" }),
    task({ id: "t_days", title: "Weeks late", dueDate: "2026-07-01T17:00:00.000Z" })
  ];
  const brief = composeBrief(makeRuntime({ tasks }), { now: NOW, limit: 5 });
  const hours = brief.items.find((i) => i.id === "task:t_hours");
  const days = brief.items.find((i) => i.id === "task:t_days");
  assert.equal(hours.why.split(" · ")[0], "overdue 2h", `got: ${hours.why}`);
  assert.equal(days.why.split(" · ")[0], "overdue 28d", `got: ${days.why}`);
  assert.equal(hours.scoreBreakdown.dueUrgency, 1.0, "the score still saturates for anything overdue");
  assert.equal(days.scoreBreakdown.dueUrgency, 1.0);
});

test("snooze pushes the deadline forward and never pulls a future one in", () => {
  // Snooze used to PATCH the bucket only, which dueUrgency never reads. It now
  // moves the due date — but a snooze must not turn "due next month" into "due
  // tomorrow", so the push is measured from whichever is later, now or the
  // existing deadline.
  const tasks = [
    task({ id: "t_late", title: "Overdue", dueDate: "2026-07-01T00:00:00.000Z" }),
    task({ id: "t_far", title: "Due next month", bucket: "this_month", dueDate: "2026-09-01T00:00:00.000Z" })
  ];
  const brief = composeBrief(makeRuntime({ tasks }), { now: NOW, limit: 5 });
  for (const id of ["task:t_late", "task:t_far"]) {
    const item = brief.items.find((i) => i.id === id);
    const snooze = item.actions.find((a) => a.id === "snooze");
    assert.ok(snooze.body.dueDate, "snooze must carry a new deadline, not just a bucket");
    const next = new Date(snooze.body.dueDate).getTime();
    assert.ok(next > NOW.getTime(), `${id}: the new deadline must be in the future`);
    const current = new Date(item.dueAt).getTime();
    assert.ok(next > current, `${id}: snooze must move the deadline outward, never inward`);
  }
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

test("task rows expose store identity and backwards-compatible menu-only move actions", () => {
  const brief = composeBrief(makeRuntime({ tasks: [task({ id: "task 1/x", bucket: "this_week" })] }), { now: NOW, limit: 5 });
  const row = brief.items.find((item) => item.kind === "task");
  assert.deepEqual(row.entityRef, { kind: "task", id: "task 1/x" });
  assert.ok(Array.isArray(row.menuActions));
  assert.ok(row.menuActions.length > 0);
  assert.ok(!row.menuActions.some((action) => action.body?.bucket === "this_week"), "the current bucket is not offered");
  assert.ok(!row.menuActions.some((action) => action.body?.bucket === "done"), "Done remains the explicit inline action");
  assert.ok(!row.actions.some((action) => action.id.startsWith("move:")), "old clients never render menu choices inline");
  for (const action of row.menuActions) {
    assert.equal(action.method, "PATCH");
    assert.equal(action.path, "/tasks/task%201%2Fx");
    assert.ok(action.id.startsWith("move:"));
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

// The brief's whole premise is "yes / no / change this". Yes and no shipped;
// this is the third. A draft is the one kind where "change this" is a real
// edit, so the row has to carry an action the client can turn into a text
// field — and the text to put in it.
test("a draft carries a well-formed revise action, ahead of Approve", () => {
  const rt = makeRuntime({
    drafts: [{ id: "d/1 x", title: "Reply to Adam", status: "pending", createdAt: "2026-07-27T17:00:00.000Z", kind: "email", body: "Hi Adam,\n\nHere it is.\n" }]
  });
  const draft = composeBrief(rt, { now: NOW, limit: 5 }).items.find((i) => i.kind === "draft");
  const revise = draft.actions.find((a) => a.id === "revise");
  assert.ok(revise, "a draft must offer a way to change it, not only approve/discard");
  assert.equal(revise.style, "revise", "the client keys 'do not dispatch on tap' off this style");
  assert.equal(revise.method, "PATCH");
  // The id goes through encodeURIComponent, so an id with a slash or a space
  // still addresses one draft instead of a route that does not exist.
  assert.equal(revise.path, "/drafts/d%2F1%20x");
  assert.equal(revise.bodyField, "body", "names the key the typed text is merged in under");
  assert.equal(revise.body, null, "carries no body of its own — the client supplies it");
  assert.ok(
    draft.actions.findIndex((a) => a.id === "revise") < draft.actions.findIndex((a) => a.id === "approve"),
    "'change this' is the decision that comes before 'yes'"
  );
});

// THE dangerous case. `why` is a summary and `title` is a subject line; if the
// client seeds its editor from either and PATCHes that back, the rest of the
// draft is gone. So the seed ships on the item, whole.
test("the revise seed is the draft body verbatim, never a truncated preview", () => {
  const body = [
    "Hi Adam,",
    "",
    Array.from({ length: 40 }, (_, i) => `Paragraph ${i}: something the user would be furious to lose.`).join("\n"),
    "",
    "Best,",
    "Spencer"
  ].join("\n");
  const rt = makeRuntime({
    drafts: [{ id: "d1", title: "Follow-up", status: "pending", createdAt: "2026-07-27T17:00:00.000Z", kind: "email", body }]
  });
  const draft = composeBrief(rt, { now: NOW, limit: 5 }).items.find((i) => i.kind === "draft");
  assert.equal(draft.editValue, body, "the seed must be byte-identical to the stored body");
  assert.equal(draft.editValue.length, body.length, "and must not be capped at any length");
  assert.ok(draft.why.length < body.length, "the row's summary is NOT the seed — that is the whole point");
});

// No seed, no editor. A record we cannot read the body of has nothing safe to
// put in a text field, and an editor that opens empty submits empty.
test("a draft with no readable body offers no revise action at all", () => {
  const rt = makeRuntime({
    drafts: [{ id: "d1", title: "Reply to Adam", status: "pending", createdAt: "2026-07-27T17:00:00.000Z", kind: "email" }]
  });
  const draft = composeBrief(rt, { now: NOW, limit: 5 }).items.find((i) => i.kind === "draft");
  assert.equal(draft.editValue, undefined, "no seed is sent when there is none to send");
  assert.ok(!draft.actions.some((a) => a.id === "revise"), "and no edit is offered without one");
  assert.ok(draft.actions.some((a) => a.id === "approve"), "approve/discard still work");
});

// ─────────────────────────────────────────────────────────────────────────
// The brief used to filter tasks on status "pending". MEASURED on the user's
// real install: 16 of their 17 open user tasks are "in_progress" and exactly
// one is "pending" — so the popover rendered a task-free brief for someone
// with sixteen live commitments, including "Resolve the AI PM Course Vimeo
// checkout error" and "Finish QA on BuildBetter follow-ups flow for PR 4180".
// ─────────────────────────────────────────────────────────────────────────

test("in-progress tasks reach the brief — the install where every open task is one", () => {
  const tasks = [
    task({ id: "t_vimeo", title: "Resolve the AI PM Course Vimeo checkout error", status: "in_progress", createdAt: "2026-06-06T05:39:21.743Z" }),
    task({ id: "t_qa", title: "Finish QA on BuildBetter follow-ups flow for PR 4180", status: "in_progress", createdAt: "2026-06-09T00:00:00.000Z" })
  ];
  const brief = composeBrief(makeRuntime({ tasks }), { now: NOW, limit: 5 });
  assert.deepEqual(
    brief.items.filter((i) => i.kind === "task").map((i) => i.id).sort(),
    ["task:t_qa", "task:t_vimeo"],
    "work the user has already started is the most current work there is"
  );
});

test("a blocked or completed task never reaches the brief", () => {
  // "blocked" is set by task-store precisely so the UI does not surface it,
  // and no button on a one-row popover can unblock one. The status filter
  // going away must not turn the pool into 'every task that exists'.
  const tasks = [
    task({ id: "t_ok", title: "Open", status: "in_progress" }),
    task({ id: "t_blocked", title: "Blocked", status: "blocked" }),
    task({ id: "t_done", title: "Done", status: "completed", bucket: "done" }),
    task({ id: "t_cancelled", title: "Cancelled", status: "cancelled" })
  ];
  const brief = composeBrief(makeRuntime({ tasks }), { now: NOW, limit: 5 });
  assert.deepEqual(brief.items.filter((i) => i.kind === "task").map((i) => i.id), ["task:t_ok"]);
});

test("a store that ignores the status filter does not get every task twice", () => {
  // The composer asks once per active status. A store (or a future one) that
  // returns the same rows for both would otherwise render duplicate rows and
  // double the 'N older' count.
  const rows = [task({ id: "t1", status: "in_progress" }), task({ id: "t2", status: "pending" })];
  const rt = makeRuntime({});
  rt.tasks = { list: () => rows };
  const brief = composeBrief(rt, { now: NOW, limit: 5 });
  assert.deepEqual(brief.items.filter((i) => i.kind === "task").map((i) => i.id), ["task:t1", "task:t2"]);
});

test("an in-progress row says so, and says how long it has been open", () => {
  // "today" (the BUCKET) is what the old why string said about a task the user
  // picked up in June — which they can only read as a deadline. What is
  // actually true is that it is in progress and eight weeks old.
  const tasks = [task({ id: "t1", status: "in_progress", createdAt: "2026-06-06T05:39:21.743Z", source: "proactive-observer" })];
  const brief = composeBrief(makeRuntime({ tasks }), { now: NOW, limit: 5 });
  const row = brief.items.find((i) => i.kind === "task");
  assert.equal(row.why, "in progress · added 8w ago · from proactive-observer", `got: ${row.why}`);
  assert.equal(row.scoreBreakdown.started, 1);
  assert.ok(!row.why.includes("today"), "a bucket name is where the task was filed, not a deadline");
});

// THE trap. updatedAt is the obvious staleness signal and it is the wrong one:
// this install's proactive-observer re-stamps sourceMeta on every in-progress
// task each reconciliation pass (149 of 281 task updates in the live event log
// patch sourceMeta alone; all 16 in-progress tasks were stamped inside the same
// second). A row keyed off it would have said "no update in 6w" yesterday and
// nothing at all today, having learned nothing about the user either time.
test("age comes from createdAt, so a daemon touching the record cannot change it", () => {
  const stamped = task({ id: "t1", status: "in_progress", createdAt: "2026-06-06T05:39:21.743Z", updatedAt: NOW.toISOString(), source: "proactive-observer" });
  const untouched = { ...stamped, id: "t2", updatedAt: "2026-06-06T05:39:21.743Z" };
  const rows = composeBrief(makeRuntime({ tasks: [stamped, untouched] }), { now: NOW, limit: 5 })
    .items.filter((i) => i.kind === "task");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].why, rows[1].why, "a sourceMeta re-stamp is not news about the user");
  assert.ok(rows[0].why.includes("added 8w ago"), `got: ${rows[0].why}`);
  assert.equal(rows[0].score, rows[1].score, "and it must not move the ranking either");
});

test("a just-added in-progress task claims no age at all", () => {
  const tasks = [task({ id: "t1", status: "in_progress", createdAt: "2026-07-29T09:00:00.000Z", source: "manual" })];
  const brief = composeBrief(makeRuntime({ tasks }), { now: NOW, limit: 5 });
  const row = brief.items.find((i) => i.kind === "task");
  assert.equal(row.why, "in progress", "eight hours is not a fact worth reporting");
  assert.ok(row.scoreBreakdown.openAge < 0.03, `and it barely moves the score, got ${row.scoreBreakdown.openAge}`);
});

test("a started task does not bank 'carried over' on top of its age", () => {
  // The same fact counted twice. Both terms are age signals; a started row
  // reports its age as `openAge`, so carriedOver must read 0 or the ceiling
  // that keeps deadlines on top stops holding.
  const tasks = [task({ id: "t1", status: "in_progress", createdAt: "2026-06-01T00:00:00.000Z" })];
  const row = composeBrief(makeRuntime({ tasks }), { now: NOW, limit: 5 }).items.find((i) => i.kind === "task");
  assert.equal(row.scoreBreakdown.carriedOver, 0);
  assert.equal(row.scoreBreakdown.openAge, 1, "premise: it is maximally old, so this is the strongest case");
  assert.ok(!row.why.includes("carried over"), "and the sentence does not claim it either");
});

test("an in-progress task with a real deadline still reports the deadline", () => {
  const tasks = [task({ id: "t1", status: "in_progress", dueDate: "2026-07-27T17:00:00.000Z" })];
  const row = composeBrief(makeRuntime({ tasks }), { now: NOW, limit: 5 }).items.find((i) => i.kind === "task");
  assert.equal(row.why.split(" · ")[0], "in progress");
  assert.ok(row.why.includes("overdue 2d"), `a dueDate is a commitment and must survive, got: ${row.why}`);
});

test("started outranks untouched, but never outranks a real deadline", () => {
  // Both halves matter. The first is why in_progress is scored at all; the
  // second is the cap that stops sixteen in-progress rows from swamping a
  // brief that also contains dated work.
  const started = task({ id: "t_started", title: "Started weeks ago", status: "in_progress", createdAt: "2026-06-01T00:00:00.000Z" });
  const untouched = task({ id: "t_untouched", title: "Never started", status: "pending", createdAt: "2026-06-01T00:00:00.000Z" });
  const dueToday = task({ id: "t_due", title: "Due today", status: "pending", dueDate: "2026-07-29T23:00:00.000Z", createdAt: "2026-07-29T09:00:00.000Z" });

  const ranked = composeBrief(makeRuntime({ tasks: [untouched, started] }), { now: NOW, limit: 5 })
    .items.filter((i) => i.kind === "task").map((i) => i.id);
  assert.deepEqual(ranked, ["task:t_started", "task:t_untouched"], "something you have started beats something you have not");

  const withDeadline = composeBrief(makeRuntime({ tasks: [started, dueToday] }), { now: NOW, limit: 5 })
    .items.filter((i) => i.kind === "task").map((i) => i.id);
  assert.deepEqual(withDeadline, ["task:t_due", "task:t_started"], "a maximally old in-progress task must not outrank a task due today");
});

test("'N older' counts every eligible row that did not fit, not just suggestions", () => {
  // Before in_progress entered the pool there were never unshown tasks on the
  // real install, so a suggestion-only count was accidentally right. With 16
  // in-progress tasks and 2 task slots it became a lie: "1 older" on a brief
  // hiding fourteen tasks and a suggestion.
  const tasks = Array.from({ length: 6 }, (_, i) =>
    task({ id: `t${i}`, title: `In flight ${i}`, status: "in_progress", createdAt: "2026-06-01T00:00:00.000Z" })
  );
  const drafts = [
    { id: "d1", title: "Draft one", status: "pending", createdAt: "2026-07-27T17:00:00.000Z", kind: "email" },
    { id: "d2", title: "Draft two", status: "pending", createdAt: "2026-05-01T17:00:00.000Z", kind: "email" }
  ];
  const suggestions = [minedSuggestion({ id: "sug_a" }), minedSuggestion({ id: "sug_b" })];
  const brief = composeBrief(makeRuntime({ tasks, drafts, suggestions }), { now: NOW, limit: 5 });
  const shown = brief.items.length;
  assert.equal(shown, 5, "premise: the brief is full");
  assert.equal(brief.older.count, 6 + 2 + 2 - shown, "every eligible row the popover could not show is 'older'");
  assert.equal(brief.older.oldestAt, "2026-05-01T17:00:00.000Z", "and oldestAt spans kinds too — the unshown draft is the oldest thing hidden");
});

test("older.byKind truthfully names each kind left behind by slot allocation", () => {
  const clarifications = Array.from({ length: 2 }, (_, i) => ({
    id: `c${i}`,
    question: `Question ${i}?`,
    status: "pending",
    createdAt: "2026-07-28T17:00:00.000Z",
    options: ["Yes", "No"]
  }));
  const drafts = Array.from({ length: 2 }, (_, i) => ({
    id: `d${i}`,
    title: `Draft ${i}`,
    status: "pending",
    createdAt: "2026-07-27T17:00:00.000Z",
    kind: "email"
  }));
  const tasks = Array.from({ length: 6 }, (_, i) => task({ id: `t${i}`, title: `Task ${i}` }));
  const suggestions = Array.from({ length: 2 }, (_, i) => minedSuggestion({ id: `sug_${i}` }));
  const brief = composeBrief(makeRuntime({ clarifications, drafts, tasks, suggestions }), { now: NOW, limit: 5 });
  const totals = { clarification: 2, draft: 2, task: 6, suggestion: 2 };
  const shown = brief.items.reduce((counts, item) => {
    counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    return counts;
  }, {});

  assert.deepEqual(brief.older.byKind, {
    clarifications: totals.clarification - (shown.clarification ?? 0),
    drafts: totals.draft - (shown.draft ?? 0),
    tasks: totals.task - (shown.task ?? 0),
    suggestions: totals.suggestion - (shown.suggestion ?? 0)
  });
  assert.equal(
    Object.values(brief.older.byKind).reduce((sum, count) => sum + count, 0),
    brief.older.count,
    "the additive breakdown and backwards-compatible aggregate cannot drift"
  );
});

// ─────────────────────────────────────────────────────────────────────────
// Rows titled "return-to-zoom-after-auth" / "post-meeting-buildbetter-staging".
// The user: "Is that an idea of what actions it wants me to take? It's not
// very clear what it's trying to do." Two defects: the title was the slug of
// the skill that WOULD be created, and the button said "Yes" without ever
// saying what yes does.
// ─────────────────────────────────────────────────────────────────────────

// Verbatim shape of ~/.openagi/skills-suggested/sug_*.json, which is what
// suggestion-feed.js normalize() reads: title comes from proposal.name (kebab,
// 567/567 measured) and the readable sentence is proposal.description.
function minedCandidateFile(over = {}) {
  return {
    id: "sug_z", source: "pattern-miner", status: "pending", proposedAt: "2026-07-29T10:00:00.000Z",
    fingerprint: "actions:auth→attend-call",
    sequence: { confidence: 0.99, count: 12, distinctDays: 6, cadence: { type: "hourly" } },
    proposal: {
      name: "return-to-zoom-after-auth",
      description: "After completing a macOS SecurityAgent authentication prompt, return to the active Zoom call.",
      body: "When a SecurityAgent prompt appears, finish it and switch straight back to Zoom.",
      scheduleHint: null
    },
    ...over
  };
}

test("a mined candidate renders the sentence on the record, not the skill slug", () => {
  const brief = composeBrief(makeRuntime({ suggestions: [minedCandidateFile()] }), { now: NOW, limit: 5 });
  const row = brief.items.find((i) => i.kind === "suggestion");
  assert.equal(
    row.title,
    "After completing a macOS SecurityAgent authentication prompt, return to the active Zoom call.",
    "proposal.description is prose the miner already wrote; the slug is a filename"
  );
  assert.ok(!/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(row.title), "no row may be titled with a machine id");
});

test("the accept button says what accepting does, per category", () => {
  // Read off the accept branches in hosted-interface.js: skill → SKILL.md,
  // task → materializes a task, mcp → registers + connects, knowledge →
  // memory.remember. A bare "Yes" named the answer, not the consequence.
  const expected = { skill: "Save as skill", task: "Add as task", mcp: "Connect it", knowledge: "Remember it" };
  for (const [category, label] of Object.entries(expected)) {
    const rt = makeRuntime({ suggestions: [minedSuggestion({ id: `prop_${category}`, category, title: "Something the observer noticed" })] });
    const row = composeBrief(rt, { now: NOW, limit: 5 }).items.find((i) => i.id === `suggestion:prop_${category}`);
    const accept = row.actions.find((a) => a.id === "accept");
    assert.equal(accept.label, label, `${category} must say what Yes does`);
    // The id is the contract with the client's outcome reader; only the label moved.
    assert.equal(accept.path, `/proactive/suggestions/prop_${category}/accept`);
    const reject = row.actions.find((a) => a.id === "reject");
    assert.equal(reject.label, "Dismiss");
  }
});

test("an observer suggestion keeps its own prose title untouched", () => {
  // prop_* records already title themselves in a sentence ("Triage PR #4437
  // for ob-website SEO changes") and carry no proposal at all.
  const rt = makeRuntime({
    suggestions: [minedSuggestion({ id: "prop_1", category: "task", title: "Triage PR #4437 for ob-website SEO changes", sequence: undefined })]
  });
  const row = composeBrief(rt, { now: NOW, limit: 5 }).items.find((i) => i.kind === "suggestion");
  assert.equal(row.title, "Triage PR #4437 for ob-website SEO changes");
});

test("a record with nothing human on it shows the slug rather than invented prose", () => {
  // The honest floor. If the miner wrote no description we have no sentence,
  // and de-kebabbing "return-to-zoom-after-auth" into a claim about what the
  // user does would be the composer making something up.
  const raw = minedCandidateFile();
  delete raw.proposal.description;
  const rt = makeRuntime({ suggestions: [raw] });
  const row = composeBrief(rt, { now: NOW, limit: 5 }).items.find((i) => i.kind === "suggestion");
  assert.equal(row.title, "return-to-zoom-after-auth", "the stored id, verbatim — not a sentence we made up");
});

test("a two-sentence description is trimmed to one, and never mid-word", () => {
  const raw = minedCandidateFile();
  raw.proposal.description = "Open Codex after checking Slack. Then join the Zoom call and take notes.";
  const rt = makeRuntime({ suggestions: [raw] });
  const row = composeBrief(rt, { now: NOW, limit: 5 }).items.find((i) => i.kind === "suggestion");
  assert.equal(row.title, "Open Codex after checking Slack.");
});

// ── "Discard" vs "Stop asking" ─────────────────────────────────────────────
//
// The user's report, verbatim: "I hit discard and it keeps coming back. I don't
// know why." The why is that discarding resolves the ARTIFACT and leaves the
// task that produced it in the agent queue — task-store reads a discarded draft
// as "not this one, try again" — so the next pulse drafts it again. Measured on
// the real install: 69 of 97 pending drafts belong to a task that already had
// one, and task_7d758c61ed194ddb had produced four.

/// makeRuntime's task stub is list()-only, matching what the composer needed
/// before. Both of these actions turn on what the GENERATING task is, so the
/// tests that exercise them need get() — added here rather than in the shared
/// stub so no existing test's focus-resolution changes underneath it.
function withTaskGet(rt) {
  rt.tasks.get = (id) => rt.tasks.list().find((t) => t.id === id) ?? null;
  return rt;
}

test("a draft whose task is still live offers BOTH discards, and they differ", () => {
  const rt = withTaskGet(makeRuntime({
    tasks: [task({ id: "t9", queue: "agent", title: "Compare ISPs", status: "pending" })],
    drafts: [{ id: "d1", taskId: "t9", title: "ISP comparison", status: "pending", kind: "doc", body: "…", createdAt: "2026-07-27T17:00:00.000Z" }]
  }));
  const row = composeBrief(rt, { now: NOW, limit: 5 }).items.find((i) => i.kind === "draft");
  const discard = row.actions.find((a) => a.id === "discard");
  const stop = row.actions.find((a) => a.id === "stop_asking");
  assert.ok(discard, "the common case keeps its button");
  assert.ok(stop, "and the deliberate one is offered when there is a task to retire");
  assert.notEqual(discard.path, stop.path, "two decisions, two routes — the server must be able to tell them apart");
  assert.equal(stop.path, "/drafts/d1/stop-asking");
  assert.equal(stop.method, "POST");
  // The style is the client's whole basis for weighting them: BriefSection
  // splits on style == "retire" to move this off the tap row onto its own line.
  assert.equal(stop.style, "retire");
  assert.equal(discard.style, "destructive");
  assert.ok(
    row.actions.findIndex((a) => a.id === "discard") < row.actions.findIndex((a) => a.id === "stop_asking"),
    "Discard is the common case and comes first"
  );
});

test("no live task behind a draft means no 'Stop asking' — there is nothing to stop", () => {
  // MEASURED on the real install: of 52 tasks referenced by a pending draft, 51
  // no longer exist in the task store. Offering to retire a task that is gone
  // would be a button the server has to refuse.
  const rt = withTaskGet(makeRuntime({
    tasks: [],
    drafts: [{ id: "d1", taskId: "gone", title: "Orphan", status: "pending", kind: "doc", body: "…", createdAt: "2026-07-27T17:00:00.000Z" }]
  }));
  const row = composeBrief(rt, { now: NOW, limit: 5 }).items.find((i) => i.kind === "draft");
  assert.ok(!row.actions.some((a) => a.id === "stop_asking"));
  assert.ok(row.actions.some((a) => a.id === "discard"), "the draft is still discardable");
});

test("a COMPLETED generating task is never offered for retirement", () => {
  // Retiring writes status "cancelled". Doing that to a completed task would
  // erase a real outcome the user earned in order to silence a row — the one
  // failure mode this allowlist exists to prevent.
  const rt = withTaskGet(makeRuntime({
    tasks: [task({ id: "t9", queue: "agent", status: "completed" })],
    drafts: [{ id: "d1", taskId: "t9", title: "Done work", status: "pending", kind: "doc", body: "…", createdAt: "2026-07-27T17:00:00.000Z" }]
  }));
  const row = composeBrief(rt, { now: NOW, limit: 5 }).items.find((i) => i.kind === "draft");
  assert.ok(!row.actions.some((a) => a.id === "stop_asking"));
});

test("the row says how many drafts the task has produced — the answer to 'why does it keep coming back'", () => {
  const rt = withTaskGet(makeRuntime({
    tasks: [task({ id: "t9", queue: "agent", status: "pending" })],
    drafts: [
      { id: "d1", taskId: "t9", title: "Attempt 4", status: "pending", kind: "doc", body: "…", createdAt: "2026-07-27T17:00:00.000Z" },
      { id: "d2", taskId: "t9", title: "Attempt 3", status: "discarded", kind: "doc", body: "…", createdAt: "2026-07-20T17:00:00.000Z" },
      { id: "d3", taskId: "t9", title: "Attempt 2", status: "discarded", kind: "doc", body: "…", createdAt: "2026-07-13T17:00:00.000Z" },
      { id: "d4", taskId: "t9", title: "Attempt 1", status: "discarded", kind: "doc", body: "…", createdAt: "2026-07-06T17:00:00.000Z" }
    ]
  }));
  const rows = composeBrief(rt, { now: NOW, limit: 5 }).items.filter((i) => i.kind === "draft");
  assert.equal(rows.length, 1, "only the pending one is a row — the resolved three are history");
  assert.match(rows[0].why, /4 drafts from this task/,
    "the discarded ones ARE the story; counting only pending ones would say nothing");
});

test("one draft from a task says nothing about a count", () => {
  const rt = withTaskGet(makeRuntime({
    tasks: [task({ id: "t9", queue: "agent", status: "pending" })],
    drafts: [{ id: "d1", taskId: "t9", title: "First", status: "pending", kind: "email", body: "…", createdAt: "2026-07-27T17:00:00.000Z" }]
  }));
  const row = composeBrief(rt, { now: NOW, limit: 5 }).items.find((i) => i.kind === "draft");
  assert.equal(row.why, "draft waiting · email");
});

test("a broken draft-history read costs the count, never a degraded claim", () => {
  // The pending list was already read successfully by the time the enrichment
  // runs, so reporting "couldn't read drafts" next to a draft we are rendering
  // would be the louder lie.
  const rt = withTaskGet(makeRuntime({
    tasks: [task({ id: "t9", queue: "agent", status: "pending" })],
    drafts: [{ id: "d1", taskId: "t9", title: "First", status: "pending", kind: "doc", body: "…", createdAt: "2026-07-27T17:00:00.000Z" }]
  }));
  const pending = rt.drafts.list();
  rt.drafts.list = ({ status } = {}) => {
    if (status === null) throw new Error("history unreadable");
    return pending;
  };
  const brief = composeBrief(rt, { now: NOW, limit: 5 });
  assert.ok(!brief.degraded.includes("drafts"));
  const row = brief.items.find((i) => i.kind === "draft");
  assert.ok(row, "and the row still renders");
  assert.equal(row.why, "draft waiting · doc", "just without the count");
  assert.ok(row.actions.some((a) => a.id === "stop_asking"),
    "and the offer stands — it turns on the task store, which is fine");
});
