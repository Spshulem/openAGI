import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { queryReviewQueue, ReviewQueueQueryError } from "../src/review-queue.js";

const NOW = new Date("2026-08-09T17:00:00.000Z");

function runtime({ tasks = [], drafts = [], suggestions = [], clarifications = [] } = {}) {
  return {
    tasks: {
      list({ queue, status, limit = 50 } = {}) {
        return tasks
          .filter((task) => (!queue || task.queue === queue) && (!status || task.status === status))
          .slice(0, limit);
      },
      get(id) { return tasks.find((task) => task.id === id) ?? null; }
    },
    drafts: { list: ({ status } = {}) => drafts.filter((draft) => !status || draft.status === status) },
    clarifications: { list: ({ status } = {}) => clarifications.filter((item) => !status || item.status === status) },
    proactiveObserver: { dataDir: "/definitely/not/a/live/data-dir" },
    suggestionFeedback: { isMuted: () => false, categoryMultipliers: () => ({}) },
    __suggestions: suggestions
  };
}

function task(id, createdAt) {
  return { id, queue: "user", title: `Task ${id}`, status: "pending", bucket: "today", priority: 50, createdAt };
}

test("review queue shares Quick Ask eligibility, de-duplicates focus tasks, and paginates", () => {
  const tasks = [
    task("a", "2026-05-01T00:00:00.000Z"),
    task("b", "2026-05-02T00:00:00.000Z"),
    task("c", "2026-05-03T00:00:00.000Z")
  ];
  const drafts = Array.from({ length: 4 }, (_, i) => ({
    id: `d${i}`, title: `Draft ${i}`, body: `Body ${i}`, status: "pending", createdAt: `2026-06-0${i + 1}T00:00:00.000Z`
  }));
  const rt = runtime({ tasks, drafts });
  const first = queryReviewQueue(rt, { now: NOW, limit: 3 });
  assert.equal(first.summary.total, 7);
  assert.deepEqual(first.summary.byKind, { tasks: 3, drafts: 4, clarifications: 0, suggestions: 0 });
  assert.equal(first.items.length, 3);
  assert.ok(first.nextCursor);
  const second = queryReviewQueue(rt, { now: NOW, limit: 3, cursor: first.nextCursor });
  const third = queryReviewQueue(rt, { now: NOW, limit: 3, cursor: second.nextCursor });
  const ids = [...first.items, ...second.items, ...third.items].map((item) => `${item.kind}:${item.id}`);
  assert.equal(new Set(ids).size, 7);
  assert.equal(second.total, 7, "cursor changes the page, never the matching total");
});

test("review queue includes the file-backed suggestion backlog and searches past page one", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-review-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const suggestionDir = path.join(dir, "proactive", "suggestions");
  fs.mkdirSync(suggestionDir, { recursive: true });
  for (let i = 0; i < 101; i += 1) {
    fs.writeFileSync(path.join(suggestionDir, `prop_${i}.json`), JSON.stringify({
      id: `prop_${i}`,
      status: "pending",
      category: "skill",
      title: i === 100 ? "Needle beyond the first page" : `Suggestion ${i}`,
      rationale: "A real pending suggestion",
      proposedAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString()
    }));
  }
  const rt = runtime({ tasks: [task("one", "2025-12-01T00:00:00.000Z")] });
  rt.dataDir = dir;
  rt.proactiveObserver = { dataDir: dir };

  const first = queryReviewQueue(rt, { now: NOW, limit: 50, dataDir: dir });
  assert.equal(first.summary.total, 102);
  assert.equal(first.summary.byKind.suggestions, 101);
  assert.equal(first.items.length, 50, "the dashboard never renders the whole backlog at once");
  const found = queryReviewQueue(rt, { now: NOW, q: "needle beyond", kind: "suggestions", dataDir: dir });
  assert.equal(found.total, 1);
  assert.equal(found.items[0].id, "prop_100");
});

test("review queue searches beyond page one, filters kinds, and never returns a full draft body", () => {
  const longBody = `Needle phrase ${"x".repeat(1_000)}`;
  const drafts = Array.from({ length: 60 }, (_, i) => ({
    id: `d${i}`,
    title: `Draft ${i}`,
    body: i === 59 ? longBody : `ordinary ${i}`,
    status: "pending",
    createdAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString()
  }));
  const result = queryReviewQueue(runtime({ tasks: [task("one", "2026-01-01T00:00:00.000Z")], drafts }), {
    now: NOW,
    q: "needle phrase",
    kind: "drafts",
    limit: 10
  });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].id, "d59");
  assert.ok(result.items[0].preview.length <= 320);
  assert.equal("editValue" in result.items[0], false);
});

test("review queue rejects unknown kinds and malformed cursors", () => {
  const rt = runtime();
  assert.throws(() => queryReviewQueue(rt, { kind: "mysteries", now: NOW }), ReviewQueueQueryError);
  assert.throws(() => queryReviewQueue(rt, { cursor: "%%%", now: NOW }), /invalid review cursor/);
});

test("cursor pagination uses the same case-sensitive ordering as sorting", () => {
  const sameTime = "2026-01-01T00:00:00.000Z";
  const rt = runtime({ tasks: [task("a", sameTime), task("B", sameTime)] });
  const first = queryReviewQueue(rt, { now: NOW, limit: 1 });
  const second = queryReviewQueue(rt, { now: NOW, limit: 1, cursor: first.nextCursor });
  assert.deepEqual([...first.items, ...second.items].map((item) => item.id), ["B", "a"]);
});

test("review enumeration does not hide active tasks after the store's default page", () => {
  const tasks = Array.from({ length: 450 }, (_, i) => task(`t${String(i).padStart(3, "0")}`, "2026-01-01T00:00:00.000Z"));
  const result = queryReviewQueue(runtime({ tasks }), { now: NOW, limit: 10 });
  assert.equal(result.summary.total, 450);
  assert.equal(result.summary.byKind.tasks, 450);
});

test("a task pinned by the daily plan remains searchable by its canonical task record", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-review-focus-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dataDir, "plan"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "plan", "2026-08-09.json"), JSON.stringify({
    dateISO: "2026-08-09",
    cachedAt: "2026-08-09T15:00:00.000Z",
    focus: [{ taskId: "focused", title: "Planner wording", why: "today's focus" }]
  }));
  const actual = {
    ...task("focused", "2026-01-02T00:00:00.000Z"),
    title: "Actual searchable task title",
    description: "Canonical details"
  };
  const result = queryReviewQueue(runtime({ tasks: [actual] }), {
    now: NOW,
    dataDir,
    q: "actual searchable"
  });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].title, actual.title);
  assert.equal(result.items[0].createdAt, actual.createdAt);
  assert.equal(result.items[0].deepLink, "/?tab=tasks&task=focused");
});

test("oldest and newest cursors both exhaust a large queue without gaps or duplicates", () => {
  const tasks = Array.from({ length: 1_005 }, (_, i) => task(
    `row${String(i).padStart(4, "0")}`,
    new Date(Date.UTC(2024, 0, 1, 0, i)).toISOString()
  ));
  const rt = runtime({ tasks });

  const exhaust = (sort) => {
    const rows = [];
    let cursor = null;
    do {
      const page = queryReviewQueue(rt, { now: NOW, sort, cursor, limit: 73 });
      rows.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return rows;
  };

  const oldest = exhaust("oldest");
  const newest = exhaust("newest");
  assert.equal(oldest.length, tasks.length);
  assert.equal(newest.length, tasks.length);
  assert.equal(new Set(oldest.map((item) => item.id)).size, tasks.length);
  assert.deepEqual(newest.map((item) => item.id), oldest.map((item) => item.id).reverse());
});

test("undated rows stay last for both sort directions and paginate after dated rows", () => {
  const rt = runtime({ tasks: [
    task("old", "2026-01-01T00:00:00.000Z"),
    task("new", "2026-02-01T00:00:00.000Z"),
    task("missing", null),
    task("malformed", "not-a-date")
  ] });

  for (const sort of ["oldest", "newest"]) {
    const ids = [];
    let cursor = null;
    do {
      const page = queryReviewQueue(rt, { now: NOW, sort, cursor, limit: 1 });
      ids.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(new Set(ids.slice(-2)), new Set(["missing", "malformed"]));
    assert.equal(ids.length, 4);
  }
});
