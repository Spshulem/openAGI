// The re-draft treadmill, and its mirror image (the permanently-wedged queue).
//
// Measured on the real install before the fix:
//   - 97 pending drafts, 69 of which belong to a task that has MORE THAN ONE
//     pending draft (24 such tasks; worst offender drafted 7 times).
//   - task_7d758c61ed194ddb ("Compare Frontier vs SAIL Internet options") sat
//     status=pending in the agent queue from 2026-06-15 with updatedAt never
//     changing, and produced 4 drafts.
//   - Simultaneously 10 agent tasks + 16 user tasks were stuck in_progress:
//     claimed (by the observer or by hand) and then never resolved.
//
// Cause: agentPickNext() returned the highest-priority PENDING agent task and
// did not claim it. The 30-minute autopilot pulse drafted it; if the model
// never called complete_task/move_task, the next pulse got the same task back.
//
// These tests pin BOTH failure modes: no second draft for a task that already
// has one, and no task handed out forever without progress.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore, AGENT_LEASE_MS, AGENT_MAX_ATTEMPTS } from "../src/task-store.js";
import { DraftStore } from "../src/draft-store.js";
import { ToolRegistry, registerCoreTools } from "../src/tool-registry.js";

const MINUTE = 60 * 1000;

function makeEnv({ clock } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-queue-"));
  const runtime = { events: { emit() {} } };
  const tasks = new TaskStore({ dataDir, runtime, clock });
  const drafts = new DraftStore({ dir: path.join(dataDir, "drafts"), runtime });
  runtime.tasks = tasks;
  runtime.drafts = drafts;
  const registry = new ToolRegistry();
  registerCoreTools(registry, runtime);
  return { dataDir, runtime, tasks, drafts, registry };
}

// One 30-minute autopilot pulse, exactly as AGENT_PULSE_PROMPT drives it:
// agent_pick_next, then save_draft for a draft-only task. The model does NOT
// call complete_task — that omission is the bug we are defending against.
async function lazyPulse(registry, { body = "draft body" } = {}) {
  const { result: picked } = await registry.invoke("agent_pick_next", {});
  if (!picked?.task) return { picked: null, draft: null };
  const { result: draft } = await registry.invoke("save_draft", {
    title: `Draft for ${picked.task.title}`,
    body,
    kind: "doc",
    taskId: picked.task.id
  });
  return { picked: picked.task, draft };
}

test("re-draft treadmill: a second pulse does not create a second draft for the same task", async () => {
  const { tasks, drafts, registry } = makeEnv();
  const task = tasks.add(
    { title: "Compare Frontier vs SAIL Internet options", tags: ["draft-only"], priority: 60 },
    { queue: "agent", source: "proactive-observer" }
  );

  const first = await lazyPulse(registry);
  assert.equal(first.picked?.id, task.id, "pulse 1 should pick the queued agent task");
  assert.equal(drafts.list({ status: "pending" }).length, 1, "pulse 1 produces exactly one draft");

  // Pulse 2, 30 minutes later. The task was never completed. It must NOT come
  // back around: its deliverable is already sitting in the review queue.
  const second = await lazyPulse(registry);
  assert.equal(second.picked, null, "pulse 2 must not re-serve a task whose draft is awaiting review");
  assert.equal(
    drafts.list({ status: "pending" }).length,
    1,
    "pulse 2 must not create a second pending draft"
  );

  // Belt and braces: even a model that calls save_draft twice inside ONE pulse
  // (so the queue filter never gets a say) must not stack drafts on the task.
  const { result: dupe } = await registry.invoke("save_draft", {
    title: "Compare Frontier vs SAIL Internet options (again)",
    body: "second attempt at the same thing",
    taskId: task.id
  });
  assert.equal(dupe.duplicate, true, "save_draft should report the existing draft, not mint a new one");
  assert.equal(dupe.draftId, first.draft.draftId, "it should hand back the draft that already exists");
  assert.equal(drafts.list({ status: "pending" }).length, 1, "still exactly one pending draft for the task");
});

test("wedge guard: a task cannot be picked forever without progress", async () => {
  let now = Date.parse("2026-06-15T19:00:00.000Z");
  const { tasks } = makeEnv({ clock: () => now });
  const task = tasks.add({ title: "Never finishes", priority: 70 }, { queue: "agent" });

  // Simulate pulses that claim the task and then die without resolving it.
  const claims = [];
  for (let pulse = 0; pulse < 12; pulse += 1) {
    const claimed = tasks.agentClaimNext({ now });
    if (claimed?.id === task.id) claims.push(claimed);
    now += 6 * 60 * MINUTE; // six hours later — well past any lease
  }

  assert.ok(
    claims.length <= AGENT_MAX_ATTEMPTS,
    `task was handed out ${claims.length} times; the cap is ${AGENT_MAX_ATTEMPTS}`
  );

  // And it must be VISIBLY stuck, not silently dropped on the floor.
  const after = tasks.get(task.id);
  assert.equal(after.status, "blocked", "an exhausted task parks in a visible blocked state");
  assert.equal(after.sourceMeta?.agentStall?.reason, "no-progress");
  assert.equal(after.sourceMeta?.agentStall?.attempts, AGENT_MAX_ATTEMPTS);
  const stalled = tasks.stalledTasks({ now });
  assert.ok(
    stalled.some((s) => s.task.id === task.id && s.reason === "no-progress"),
    "stalledTasks() must surface it for the user"
  );
});

test("lease: a claimed task is off the queue until the lease expires, then comes back", async () => {
  let now = Date.parse("2026-06-15T19:00:00.000Z");
  const { tasks } = makeEnv({ clock: () => now });
  const task = tasks.add({ title: "Leased work", priority: 70 }, { queue: "agent" });

  const claimed = tasks.agentClaimNext({ now });
  assert.equal(claimed.id, task.id);
  assert.equal(claimed.status, "in_progress", "claiming marks the task in_progress");
  assert.equal(claimed.sourceMeta.agentLease.attempts, 1);

  now += 5 * MINUTE;
  assert.equal(tasks.agentPickNext({ now }), null, "a live lease keeps the task off the queue");

  now += AGENT_LEASE_MS;
  assert.equal(
    tasks.agentPickNext({ now })?.id,
    task.id,
    "an expired lease returns the task to the queue instead of wedging it in_progress"
  );
});

test("lease: completing or moving a task releases the claim", async () => {
  let now = Date.parse("2026-06-15T19:00:00.000Z");
  const { tasks } = makeEnv({ clock: () => now });
  const a = tasks.add({ title: "Gets completed", priority: 70 }, { queue: "agent" });
  const b = tasks.add({ title: "Gets deferred", priority: 60 }, { queue: "agent" });

  tasks.agentClaimNext({ now });
  const done = tasks.complete(a.id, "agent");
  assert.equal(done.status, "completed");
  assert.equal(done.sourceMeta?.agentLease?.expiresAt ?? null, null, "completion clears the lease");

  tasks.agentClaimNext({ now });
  const moved = tasks.update(b.id, { status: "pending", bucket: "this_week" });
  assert.equal(moved.sourceMeta?.agentLease?.expiresAt ?? null, null, "move_task clears the lease");
  assert.equal(
    tasks.agentPickNext({ now })?.id,
    b.id,
    "a deferred task is immediately eligible again — no waiting on a dead lease"
  );
});

test("recovery: pre-existing stuck in_progress tasks are reconciled without hand-editing JSON", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-queue-recover-"));
  fs.mkdirSync(path.join(dataDir, "tasks"), { recursive: true });
  const old = "2026-06-17T00:00:00.000Z";
  // Shape lifted straight from the user's live snapshot: in_progress, no lease,
  // updatedAt frozen weeks ago.
  fs.writeFileSync(
    path.join(dataDir, "tasks", "snapshot.json"),
    JSON.stringify({
      writtenAt: old,
      tasks: [
        { id: "task_agent_stuck", queue: "agent", title: "Triage the open PRs", bucket: "today", priority: 60, status: "in_progress", tags: [], dependsOn: [], sourceMeta: {}, createdAt: old, updatedAt: old },
        { id: "task_user_stuck", queue: "user", title: "Finish Apple developer registration", bucket: "today", priority: 50, status: "in_progress", tags: [], dependsOn: [], sourceMeta: {}, createdAt: old, updatedAt: old }
      ],
      goals: []
    })
  );

  const now = Date.parse("2026-07-30T00:00:00.000Z");
  const tasks = new TaskStore({ dataDir, clock: () => now });

  // Loading must NOT mutate — opening the store is something the daily brief,
  // the CLI, and stray tests all do against the real data dir.
  assert.equal(tasks.get("task_agent_stuck").status, "in_progress", "construction is read-only");

  // Recovery happens on the first queue check, which the autopilot gate makes
  // every pulse. No hand-editing, no separate migration command.
  assert.equal(tasks.agentPickNext({ now })?.id, "task_agent_stuck", "and it is workable again");

  const agentTask = tasks.get("task_agent_stuck");
  assert.equal(agentTask.status, "pending", "an abandoned agent claim is returned to the queue");
  assert.equal(agentTask.sourceMeta.agentReconcile.from, "in_progress");

  const userTask = tasks.get("task_user_stuck");
  assert.equal(userTask.status, "in_progress", "the user's own in_progress tasks are NOT silently rewritten");
  assert.ok(userTask.sourceMeta.stalledSince, "but they are flagged so the user can see them");
  assert.ok(
    tasks.stalledTasks({ now }).some((s) => s.task.id === "task_user_stuck" && s.reason === "stale-in-progress"),
    "stalledTasks() surfaces the user's wedged work too"
  );

  // Idempotent: a second load + sweep must not churn the same records again.
  const reloaded = new TaskStore({ dataDir, clock: () => now });
  reloaded.sweepStuckTasks({ now });
  assert.equal(reloaded.get("task_agent_stuck").status, "pending");
  assert.equal(reloaded.get("task_user_stuck").sourceMeta.stalledSince, userTask.sourceMeta.stalledSince);
});
