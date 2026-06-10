// Proposal-first suggestion flow: the observer surfaces task ideas as
// suggestion cards by default (user accepts → task), instead of silently
// materializing tasks. OPENAGI_AUTO_TASKS=1 restores auto-create.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProactiveObserver, materializeTaskFromSuggestion } from "../src/proactive-observer.js";

function makeRuntime() {
  const added = [];
  const events = [];
  return {
    added,
    events,
    tasks: {
      add(input, opts) {
        const task = { id: `task_${added.length + 1}`, ...input, queue: opts?.queue ?? "user", source: opts?.source };
        added.push(task);
        return task;
      },
      list() {
        return added;
      }
    },
    eventsLog: events,
    events: { emit: (name, payload) => events.push({ name, payload }) }
  };
}

function makeObserver(runtime) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-prop-"));
  return new ProactiveObserver({ runtime, dataDir: dir });
}

test("task suggestions are proposals by default — no silent task creation", () => {
  delete process.env.OPENAGI_AUTO_TASKS;
  const runtime = makeRuntime();
  const observer = makeObserver(runtime);

  const { candidate } = observer.persist({
    source: "proactive-observer",
    category: "task",
    title: "Follow up on PR #42",
    rationale: "Seen open for 3 days",
    taskQueue: "user",
    status: "pending"
  });

  assert.equal(runtime.added.length, 0, "no task should be auto-created");
  assert.equal(candidate.status, "pending");
  assert.equal(candidate.taskAutoCreated, undefined);
  const emitted = runtime.eventsLog.map((e) => e.name);
  assert.deepEqual(emitted, ["proactive-suggestion"], "should emit a suggestion event, not task-reminder");
  assert.equal(runtime.eventsLog[0].payload.category, "task");

  // The suggestion file on disk stays pending so the accept endpoint can act on it.
  const file = path.join(observer.suggestDir, `${candidate.id}.json`);
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.status, "pending");
});

test("OPENAGI_AUTO_TASKS=1 restores silent auto-creation", () => {
  process.env.OPENAGI_AUTO_TASKS = "1";
  try {
    const runtime = makeRuntime();
    const observer = makeObserver(runtime);

    const { candidate } = observer.persist({
      source: "proactive-observer",
      category: "task",
      title: "Follow up on PR #42",
      rationale: "Seen open for 3 days",
      taskQueue: "user",
      status: "pending"
    });

    assert.equal(runtime.added.length, 1);
    assert.equal(candidate.status, "accepted");
    assert.equal(candidate.taskAutoCreated, true);
    assert.equal(candidate.taskId, runtime.added[0].id);
    const emitted = runtime.eventsLog.map((e) => e.name);
    assert.deepEqual(emitted, ["task-reminder"]);
  } finally {
    delete process.env.OPENAGI_AUTO_TASKS;
  }
});

test("non-task suggestions emit proactive-suggestion regardless of the flag", () => {
  process.env.OPENAGI_AUTO_TASKS = "1";
  try {
    const runtime = makeRuntime();
    const observer = makeObserver(runtime);
    observer.persist({ source: "proactive-observer", category: "skill", title: "Morning standup draft", status: "pending" });
    assert.equal(runtime.added.length, 0);
    assert.deepEqual(runtime.eventsLog.map((e) => e.name), ["proactive-suggestion"]);
  } finally {
    delete process.env.OPENAGI_AUTO_TASKS;
  }
});

test("materializeTaskFromSuggestion dedups by suggestionId", () => {
  const runtime = makeRuntime();
  const candidate = { id: "prop_x", category: "task", title: "Do thing", taskQueue: "user" };

  const first = materializeTaskFromSuggestion(runtime, candidate);
  assert.ok(first);
  assert.equal(first.sourceMeta.suggestionId, "prop_x");

  const second = materializeTaskFromSuggestion(runtime, candidate);
  assert.equal(second.id, first.id, "accepting twice must not create a duplicate task");
  assert.equal(runtime.added.length, 1);
});

test("agent-queue suggestions carry draft-only guardrails", () => {
  const runtime = makeRuntime();
  const task = materializeTaskFromSuggestion(runtime, {
    id: "prop_y",
    category: "task",
    title: "Draft follow-up email",
    rationale: "Call ended without recap",
    taskQueue: "agent"
  });
  assert.ok(task.description.includes("draft only") || task.description.includes("Produce a draft"));
  assert.ok(task.tags.includes("draft-only"));
  assert.equal(task.queue, "agent");
});

test("materializeTaskFromSuggestion ignores non-task categories", () => {
  const runtime = makeRuntime();
  assert.equal(materializeTaskFromSuggestion(runtime, { id: "p", category: "skill", title: "x" }), null);
  assert.equal(runtime.added.length, 0);
});
