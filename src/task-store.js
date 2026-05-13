// File-backed task store. Two queues: user_tasks (what the user should
// do) and agent_tasks (what the agent assigns itself / will work). Each
// task has a bucket, priority, source attribution, and lifecycle status.
//
// Mirrors autolist's Task model with two simplifications: (1) JSONL +
// in-memory snapshot rather than Postgres, and (2) no sync versioning
// since OpenAGI is local-first.
//
// Storage layout:
//   ~/.openagi/tasks/user.jsonl     — append-only event log (create/update/delete)
//   ~/.openagi/tasks/agent.jsonl    — same, for agent queue
//   ~/.openagi/tasks/snapshot.json  — atomic snapshot, rebuilt on tick

import path from "node:path";
import fs from "node:fs";
import { ensureDir, writeJsonAtomic, readJsonFile } from "./file-utils.js";
import { createId, nowIso } from "./utils.js";

// Story 8: order matters — sort + filter UI traverses this top-to-bottom.
// today / this_week stay at the top, done at the bottom; month/quarter/
// year sit between this_week and someday so longer-horizon work has a
// real home instead of vanishing into the someday graveyard.
export const BUCKETS = ["today", "this_week", "this_month", "this_quarter", "this_year", "someday", "done"];
export const STATUSES = ["pending", "in_progress", "blocked", "completed", "cancelled"];
export const QUEUES = ["user", "agent"];

const TASK_DIR = "tasks";

export class TaskStore {
  constructor(options = {}) {
    this.runtime = options.runtime ?? null;
    this.dataDir = options.dataDir ?? process.env.OPENAGI_DATA_DIR ?? ".openagi";
    this.taskDir = path.join(this.dataDir, TASK_DIR);
    ensureDir(this.taskDir);
    this.tasks = new Map(); // id → task
    this.loadFromDisk();
    // Story 8: one-shot migration. Tasks already in "someday" with a real
    // dueDate get re-bucketed to the right horizon. Pending tasks only —
    // don't touch completed/cancelled ones for archeological integrity.
    this.rebucketFromDueDatesOnce();
  }

  rebucketFromDueDatesOnce() {
    const now = new Date();
    let moved = 0;
    for (const t of this.tasks.values()) {
      if (t.bucket !== "someday") continue;
      if (t.status === "completed" || t.status === "cancelled") continue;
      const target = bucketFromDueDate(t.dueDate, now);
      if (target && target !== "someday") {
        t.bucket = target;
        t.updatedAt = nowIso();
        moved += 1;
      }
    }
    if (moved > 0) this.snapshot();
    return moved;
  }

  loadFromDisk() {
    const snapshotPath = path.join(this.taskDir, "snapshot.json");
    const snap = readJsonFile(snapshotPath, null);
    if (snap?.tasks) {
      for (const t of snap.tasks) this.tasks.set(t.id, t);
      return;
    }
    // Replay JSONL if no snapshot.
    for (const queue of QUEUES) {
      const log = path.join(this.taskDir, `${queue}.jsonl`);
      if (!fs.existsSync(log)) continue;
      const lines = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          this.applyEvent(ev, { persist: false });
        } catch { /* skip corrupt line */ }
      }
    }
  }

  add(input, { source = "manual", queue = "user" } = {}) {
    if (!QUEUES.includes(queue)) throw new Error(`unknown queue: ${queue}`);
    const id = createId("task");
    // Story 8: auto-bucket from dueDate when caller didn't pick one.
    // Prevents the "everything is someday" pile-up for tasks with a
    // real future date.
    const autoBucket = input.bucket === undefined && input.dueDate
      ? bucketFromDueDate(input.dueDate)
      : null;
    const task = {
      id,
      queue,
      title: String(input.title ?? "").trim(),
      description: input.description ?? "",
      bucket: BUCKETS.includes(input.bucket) ? input.bucket : (autoBucket ?? "today"),
      priority: clamp(Number(input.priority ?? 50), 0, 100),
      category: input.category ?? null,
      tags: Array.isArray(input.tags) ? input.tags : [],
      source,
      sourceId: input.sourceId ?? null,
      sourceUrl: input.sourceUrl ?? null,
      sourceMeta: input.sourceMeta ?? null,
      status: STATUSES.includes(input.status) ? input.status : "pending",
      dueDate: input.dueDate ?? null,
      scheduledFor: input.scheduledFor ?? null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      completedAt: null,
      completedVia: null
    };
    if (!task.title) throw new Error("task requires a title");
    this.tasks.set(id, task);
    this.appendEvent(queue, { op: "create", task });
    this.runtime?.events?.emit?.("task-updated", { op: "create", task });
    return task;
  }

  update(id, patch) {
    const task = this.tasks.get(id);
    if (!task) return null;
    const next = { ...task };
    if (patch.title !== undefined) next.title = String(patch.title).trim();
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.bucket !== undefined && BUCKETS.includes(patch.bucket)) next.bucket = patch.bucket;
    if (patch.priority !== undefined) next.priority = clamp(Number(patch.priority), 0, 100);
    if (patch.status !== undefined && STATUSES.includes(patch.status)) {
      next.status = patch.status;
      if (patch.status === "completed" && !next.completedAt) {
        next.completedAt = nowIso();
        next.completedVia = patch.completedVia ?? "manual";
        next.bucket = "done";
      }
    }
    if (patch.tags !== undefined) next.tags = Array.isArray(patch.tags) ? patch.tags : [];
    if (patch.dueDate !== undefined) next.dueDate = patch.dueDate;
    if (patch.scheduledFor !== undefined) next.scheduledFor = patch.scheduledFor;
    if (patch.sourceMeta !== undefined) next.sourceMeta = patch.sourceMeta;
    next.updatedAt = nowIso();
    this.tasks.set(id, next);
    this.appendEvent(next.queue, { op: "update", id, patch });
    this.runtime?.events?.emit?.("task-updated", { op: "update", task: next });
    return next;
  }

  complete(id, via = "manual") {
    const next = this.update(id, { status: "completed", completedVia: via });
    // Story 2: completing a task records an outcome with the lineage
    // back to the proactive-suggestion that proposed it (when present).
    // Aggregator can then report "this proposal led to N completed tasks".
    if (next && this.runtime?.outcomes?.record) {
      const suggestionId = next.sourceMeta?.suggestionId ?? null;
      const outcome = this.runtime.outcomes.record({
        kind: "task-completed",
        refId: next.id,
        metadata: {
          task: next.id,
          sourceSuggestionId: suggestionId,
          title: next.title,
          completedVia: via
        }
      });
      // Completed-via-user is the strongest positive signal we have.
      // Auto-complete from observed activity scores slightly lower.
      const score = via === "manual" || via === "user" ? 0.9 : 0.7;
      this.runtime.outcomes.resolve(outcome.id, score, "task-completed");
    }
    return next;
  }

  remove(id) {
    const task = this.tasks.get(id);
    if (!task) return false;
    this.tasks.delete(id);
    this.appendEvent(task.queue, { op: "delete", id });
    this.runtime?.events?.emit?.("task-updated", { op: "delete", id, task });
    return true;
  }

  list({ queue, bucket, status, limit = 50 } = {}) {
    let out = [...this.tasks.values()];
    if (queue) out = out.filter((t) => t.queue === queue);
    if (bucket) out = out.filter((t) => t.bucket === bucket);
    if (status) out = out.filter((t) => t.status === status);
    out.sort((a, b) => {
      // Sort by bucket order, then priority desc, then createdAt asc
      const ba = BUCKETS.indexOf(a.bucket);
      const bb = BUCKETS.indexOf(b.bucket);
      if (ba !== bb) return ba - bb;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
    });
    return out.slice(0, limit);
  }

  get(id) {
    return this.tasks.get(id) ?? null;
  }

  // Agent picks the next thing to work on from the agent_tasks queue.
  // Skips completed/cancelled. Prefers today bucket + highest priority.
  agentPickNext() {
    const candidates = [...this.tasks.values()]
      .filter((t) => t.queue === "agent")
      .filter((t) => t.status === "pending");
    candidates.sort((a, b) => {
      const ba = BUCKETS.indexOf(a.bucket);
      const bb = BUCKETS.indexOf(b.bucket);
      if (ba !== bb) return ba - bb;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
    });
    return candidates[0] ?? null;
  }

  // Roll up summary stats for dashboards / health.
  stats() {
    const out = {
      user: { total: 0, today: 0, this_week: 0, this_month: 0, this_quarter: 0, this_year: 0, someday: 0, done: 0, pending: 0, completed: 0 },
      agent: { total: 0, today: 0, this_week: 0, this_month: 0, this_quarter: 0, this_year: 0, someday: 0, done: 0, pending: 0, completed: 0 }
    };
    for (const t of this.tasks.values()) {
      const slot = out[t.queue];
      if (!slot) continue;
      slot.total += 1;
      if (slot[t.bucket] !== undefined) slot[t.bucket] += 1;
      if (t.status === "pending") slot.pending += 1;
      if (t.status === "completed") slot.completed += 1;
    }
    return out;
  }

  appendEvent(queue, event) {
    const stamped = { at: nowIso(), ...event };
    fs.appendFileSync(path.join(this.taskDir, `${queue}.jsonl`), JSON.stringify(stamped) + "\n");
    // Atomic snapshot every event keeps cold-start cheap. Could batch if
    // this gets hot.
    this.snapshot();
  }

  applyEvent(event, { persist = true } = {}) {
    if (event.op === "create" && event.task) {
      this.tasks.set(event.task.id, event.task);
    } else if (event.op === "update" && event.id) {
      const cur = this.tasks.get(event.id);
      if (cur) this.tasks.set(event.id, { ...cur, ...event.patch });
    } else if (event.op === "delete" && event.id) {
      this.tasks.delete(event.id);
    }
    if (persist) this.snapshot();
  }

  snapshot() {
    writeJsonAtomic(path.join(this.taskDir, "snapshot.json"), {
      writtenAt: nowIso(),
      tasks: [...this.tasks.values()]
    });
  }
}

function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

// Heuristic: detect "remind me to X", "todo: X", "I need to X" in user
// chat text and extract a task title. Returns null if nothing matched.
// Used by agent-host to auto-create tasks from chat without requiring
// the user to invoke the add_task tool explicitly.
export function detectTaskInChat(text) {
  if (!text || typeof text !== "string") return null;
  const t = text.trim();
  if (t.length < 8 || t.length > 600) return null;

  // "remind me to X" / "remind me about X"
  let m = t.match(/^(?:remind me (?:to|about)|reminder:|todo:?|to do:?|task:)\s+(.+?)\.?$/i);
  if (m) return { title: cleanupTitle(m[1]), trigger: "explicit-prefix" };

  // "I need to X" / "I should X" / "i have to X" — a bit looser
  m = t.match(/^i\s+(?:need to|should|have to|gotta|must)\s+(.+?)\.?$/i);
  if (m && m[1].split(/\s+/).length >= 3) return { title: cleanupTitle(m[1]), trigger: "intent" };

  // "don't forget to X"
  m = t.match(/^don'?t forget(?:\s+to)?\s+(.+?)\.?$/i);
  if (m) return { title: cleanupTitle(m[1]), trigger: "explicit-prefix" };

  return null;
}

function cleanupTitle(s) {
  return s.replace(/\s+/g, " ").trim().slice(0, 200);
}

// Story 8: pick a bucket from a due date. Symmetric with the Linear
// integration's pickBucket but exported so any source can use it.
export function bucketFromDueDate(dueDateIso, now = new Date()) {
  if (!dueDateIso) return null;
  const due = Date.parse(dueDateIso);
  if (!Number.isFinite(due)) return null;
  const days = (due - now.getTime()) / (24 * 3600 * 1000);
  if (days < 1.5) return "today";
  if (days < 7) return "this_week";
  if (days < 35) return "this_month";
  if (days < 95) return "this_quarter";
  if (days < 365) return "this_year";
  return "someday";
}
