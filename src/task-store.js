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
import { resolveDataDir } from "./data-dir.js";

// Story 8: order matters — sort + filter UI traverses this top-to-bottom.
// today / this_week stay at the top, done at the bottom; month/quarter/
// year sit between this_week and someday so longer-horizon work has a
// real home instead of vanishing into the someday graveyard.
export const BUCKETS = ["today", "this_week", "this_month", "this_quarter", "this_year", "someday", "done"];
export const STATUSES = ["pending", "in_progress", "blocked", "completed", "cancelled"];
export const QUEUES = ["user", "agent"];

const TASK_DIR = "tasks";

// Story 11: Goal record. A Goal is a parent that tasks can hang off,
// has its own due date and status, and rolls up child task progress
// into a single completion percentage. Goals can nest (a goal can have
// a parentGoalId pointing at another goal — useful for quarter→year).
export const GOAL_STATUSES = ["active", "completed", "cancelled", "deferred"];

// ─── Agent-queue leasing ───────────────────────────────────────────────
//
// The agent queue had two opposite failure modes in production, both from
// the same root cause: agentPickNext() returned the top pending task and
// did NOT claim it.
//
//   1. The re-draft treadmill. The 30-min autopilot pulse picked a task,
//      drafted it, and — if the model forgot to call complete_task —
//      the next pulse got the SAME task and drafted it again. Measured on
//      the real install: 97 pending drafts, 69 of them belonging to a task
//      that already had one; worst offender drafted 7 times.
//   2. The wedged queue. Anything that DID get set to in_progress (by the
//      proactive observer, by the user, by a half-finished pulse) left the
//      agent queue forever, invisibly. Measured: 10 agent + 16 user tasks
//      stuck in_progress, some untouched for six weeks.
//
// So a claim can't be permanent and a pick can't be free. Claims are
// LEASES: time-boxed, counted, and self-expiring. An expired lease returns
// the task to the queue (fixes #2); a lease plus an open draft keeps it off
// the queue while the human still owes a review (fixes #1); and a task that
// burns through its attempts parks in a *visible* blocked state rather than
// looping or vanishing.

// One lease ≈ one autopilot pulse. Backoff is linear in attempts, so the
// nth claim holds the task for n * AGENT_LEASE_MS — a task that keeps
// failing gets progressively less of the queue's attention.
export const AGENT_LEASE_MS = 30 * 60 * 1000;

// How many pulses may claim a task without it reaching a terminal state or
// producing a draft. On the 3rd exhausted lease it is parked as blocked.
export const AGENT_MAX_ATTEMPTS = 3;

// An in_progress task with no lease at all was claimed by something other
// than the queue (the observer's "user is actively on this" heuristic, a
// pre-lease build, a hand edit). We only reclaim it once it's clearly
// abandoned — a week of no updatedAt movement — so we never race a signal
// that's still live.
export const AGENT_STALE_IN_PROGRESS_MS = 7 * 24 * 60 * 60 * 1000;

// Draft states that still "belong" to the task. A pending draft is awaiting
// review, an approved/sent one is finished work — in none of those cases
// should the agent produce the same artifact a second time. Only a
// DISCARDED draft frees the task for another attempt, because discarding is
// the user saying "not this".
const OPEN_DRAFT_STATUSES = new Set(["pending", "approved", "sent"]);

export class TaskStore {
  constructor(options = {}) {
    this.runtime = options.runtime ?? null;
    this.dataDir = options.dataDir ?? resolveDataDir();
    this.taskDir = path.join(this.dataDir, TASK_DIR);
    // Injectable clock so lease expiry and staleness are testable without
    // sleeping. Everything lease-related reads this, never Date.now().
    this.clock = typeof options.clock === "function" ? options.clock : () => Date.now();
    this.leaseMs = Number(options.leaseMs) > 0 ? Number(options.leaseMs) : AGENT_LEASE_MS;
    this.maxAttempts = Number(options.maxAttempts) > 0 ? Number(options.maxAttempts) : AGENT_MAX_ATTEMPTS;
    this.staleInProgressMs = Number(options.staleInProgressMs) > 0
      ? Number(options.staleInProgressMs)
      : AGENT_STALE_IN_PROGRESS_MS;
    ensureDir(this.taskDir);
    this.tasks = new Map(); // id → task
    this.goals = new Map(); // id → goal
    // Story 12: ring buffer of recent unblock events for the daily recap.
    // Kept in-memory only — these are ephemeral and recoverable from the
    // task status history if we ever need to.
    this.recentUnblocks = [];
    this.loadFromDisk();
    // Story 8: one-shot migration. Tasks already in "someday" with a real
    // dueDate get re-bucketed to the right horizon. Pending tasks only —
    // don't touch completed/cancelled ones for archeological integrity.
    this.rebucketFromDueDatesOnce();
    // NOTE: the stuck-task sweep is deliberately NOT run here. Constructing a
    // store must stay read-only: anything that merely *opens* the data dir
    // (the daily brief, a CLI inspection, a test that forgets to pass
    // dataDir and lands on the real ~/.openagi) would otherwise rewrite the
    // user's live task statuses as a side effect of loading. Recovery runs
    // from agentPickNext instead — the autopilot gate calls it every pulse,
    // so wedged state still heals within 30 minutes of an upgrade without
    // anyone hand-editing JSON, and sweepStuckTasks() stays public for an
    // explicit one-shot.
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
      // Story 11: goals persist alongside tasks in the same snapshot.
      // Older snapshots without a `goals` array are forward-compatible.
      for (const g of snap.goals ?? []) this.goals.set(g.id, g);
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
      // Story 11: link to a parent goal so rollup progress works.
      parentGoalId: input.parentGoalId ?? null,
      // Story 12: tasks that block this one. When all deps complete, this
      // task auto-flips from blocked → pending; status fires a "task-
      // unblocked" event the daily recap picks up.
      dependsOn: Array.isArray(input.dependsOn) ? input.dependsOn.filter((id) => typeof id === "string") : [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      completedAt: null,
      completedVia: null
    };
    if (!task.title) throw new Error("task requires a title");
    // Story 12: if any dep is unmet (exists + not completed), flip the
    // initial status to "blocked" so the agent + UI know not to surface
    // this task in pickup queues. The dep-complete handler in complete()
    // unblocks it later.
    if (task.dependsOn.length > 0 && this._anyDepUnmet(task.dependsOn)) {
      task.status = "blocked";
    }
    this.tasks.set(id, task);
    this.appendEvent(queue, { op: "create", task });
    // Snapshot after every add so a fresh load (which short-circuits on
    // snapshot presence) sees the latest state. Pre-existing bug: without
    // this, tasks added after a snapshot write would be invisible on
    // reload — surfaced by Story 11's addGoal+task sequence.
    this.snapshot();
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
    // Story 11: parentGoalId patches let linkTaskToGoal flip the link.
    // null is a meaningful value (unlink), so use 'in patch' rather than
    // an undefined check to allow explicit null.
    if ("parentGoalId" in patch) next.parentGoalId = patch.parentGoalId ?? null;
    if ("dependsOn" in patch) {
      next.dependsOn = Array.isArray(patch.dependsOn) ? patch.dependsOn.filter((id) => typeof id === "string") : [];
    }
    // Any status change out of in_progress ends the agent's claim. This is
    // what makes complete_task / move_task actually release the lease
    // instead of leaving a dead reservation behind for a lease-length.
    this._releaseLeaseOnStatusChange(next);
    next.updatedAt = nowIso();
    this.tasks.set(id, next);
    this.appendEvent(next.queue, { op: "update", id, patch });
    this.snapshot();
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
    // Story 12: auto-unblock dependents. Any task with dependsOn that
    // includes this one — and now has all its deps complete — flips
    // from blocked → pending and fires a "task-unblocked" event the
    // daily recap collects under its "🔓 Unblocked" section.
    if (next) {
      for (const dep of this.tasks.values()) {
        if (dep.status !== "blocked") continue;
        if (!Array.isArray(dep.dependsOn) || !dep.dependsOn.includes(id)) continue;
        if (this._anyDepUnmet(dep.dependsOn)) continue;
        const unblocked = this.update(dep.id, { status: "pending" });
        if (unblocked) {
          const event = { task: unblocked, completedDepId: id, at: nowIso() };
          this.recentUnblocks.push(event);
          // Cap memory — anything older than 24h is irrelevant to the
          // daily recap and we can drop it.
          const cutoff = Date.now() - 86_400_000;
          this.recentUnblocks = this.recentUnblocks.filter((e) => Date.parse(e.at) >= cutoff);
          this.runtime?.events?.emit?.("task-unblocked", event);
        }
      }
    }
    return next;
  }

  // Story 12: a dep is "unmet" if any of the referenced tasks still
  // exists and is not in a terminal state (completed/cancelled).
  // Missing dep tasks (deleted) count as met — caller can't be blocked
  // by something that no longer exists.
  _anyDepUnmet(depIds) {
    for (const depId of depIds) {
      const dep = this.tasks.get(depId);
      if (!dep) continue;
      if (dep.status !== "completed" && dep.status !== "cancelled") return true;
    }
    return false;
  }

  remove(id) {
    const task = this.tasks.get(id);
    if (!task) return false;
    this.tasks.delete(id);
    this.appendEvent(task.queue, { op: "delete", id });
    this.runtime?.events?.emit?.("task-updated", { op: "delete", id, task });
    return true;
  }

  // Move a task between the user and agent queues, preserving its id and
  // history. The snapshot is the authoritative load source, so flipping the
  // field + re-snapshotting is enough; we log a "move" event on the target
  // queue for the audit trail. Used by the task-sweep to re-home tasks that
  // were filed in the wrong queue (e.g. an agent-actionable reply that the
  // extractor defaulted into the user queue).
  setQueue(id, queue) {
    if (!QUEUES.includes(queue)) throw new Error(`unknown queue: ${queue}`);
    const task = this.tasks.get(id);
    if (!task || task.queue === queue) return task ?? null;
    const fromQueue = task.queue;
    const next = { ...task, queue, updatedAt: nowIso() };
    this.tasks.set(id, next);
    this.appendEvent(fromQueue, { op: "delete", id });
    this.appendEvent(queue, { op: "create", task: next });
    this.snapshot();
    this.runtime?.events?.emit?.("task-updated", { op: "update", task: next });
    return next;
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

  // ─── Agent queue: peek, claim, sweep ──────────────────────────────────

  /// Peek at the next thing the agent should work on. Read-only with
  /// respect to the *answer* — it never claims — but it first runs the
  /// stuck-task sweep, because this is the method the autopilot gate calls
  /// every pulse and it is the only heartbeat the queue reliably gets. The
  /// sweep is idempotent and writes nothing when nothing changed, so in
  /// steady state this stays a pure read.
  ///
  /// Prefers today bucket + highest priority, same as before. What's new is
  /// what it refuses to hand back:
  ///   - tasks whose deliverable is already sitting in the review queue
  ///     (an open draft) — the work is done, the human owes a decision;
  ///   - tasks under a live lease — someone is on it right now;
  ///   - tasks that already burned their attempts — those are parked
  ///     blocked by the sweep instead.
  agentPickNext({ now = this.clock(), sweep = true } = {}) {
    if (sweep) this.sweepStuckTasks({ now });
    const openDrafts = this._openDraftTaskIds();
    const candidates = [...this.tasks.values()]
      .filter((t) => t.queue === "agent")
      .filter((t) => t.status === "pending")
      .filter((t) => !openDrafts.has(t.id))
      .filter((t) => this._leaseAttempts(t) < this.maxAttempts)
      .filter((t) => !this._leaseIsLive(t, now));
    candidates.sort((a, b) => {
      const ba = BUCKETS.indexOf(a.bucket);
      const bb = BUCKETS.indexOf(b.bucket);
      if (ba !== bb) return ba - bb;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
    });
    return candidates[0] ?? null;
  }

  /// Pick AND claim in one step — what the autopilot pulse actually calls.
  /// The claim is a lease, not a lock: it marks the task in_progress and
  /// stamps an expiry so that a pulse which crashes, times out, or simply
  /// forgets to call complete_task cannot strand the task. Returns the
  /// claimed task, or null when there is nothing eligible.
  agentClaimNext({ now = this.clock() } = {}) {
    const task = this.agentPickNext({ now });
    if (!task) return null;
    const attempts = this._leaseAttempts(task) + 1;
    // Linear backoff: attempt n holds the task for n lease-lengths, so a
    // task that keeps stalling stops eating every single pulse.
    const expiresAt = new Date(now + this.leaseMs * attempts).toISOString();
    return this.update(task.id, {
      status: "in_progress",
      sourceMeta: {
        ...(task.sourceMeta ?? {}),
        agentLease: {
          claimedAt: new Date(now).toISOString(),
          expiresAt,
          attempts
        }
      }
    });
  }

  /// Record that the agent produced the deliverable for a task. Called by
  /// save_draft. The draft — not the pulse — is the unit of progress, so
  /// this resets the attempt counter and drops the live lease, then leaves
  /// the task in_progress: it is genuinely not finished, it is awaiting a
  /// human. agentPickNext won't re-serve it while the draft stays open, and
  /// stalledTasks() reports it so "waiting on you" is visible rather than
  /// looking like agent inactivity.
  noteDraftSaved(taskId, draftId, { now = this.clock() } = {}) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    const meta = { ...(task.sourceMeta ?? {}) };
    delete meta.agentLease;
    meta.awaitingReview = { draftId: draftId ?? null, since: new Date(now).toISOString() };
    return this.update(taskId, { sourceMeta: meta });
  }

  /// The reaper. Idempotent, safe to call on every pulse and at boot.
  ///
  ///   - agent task, lease expired, attempts left  → back to pending
  ///   - agent task, lease expired, attempts spent → blocked + stall record
  ///   - agent task, pending but attempts spent    → blocked + stall record
  ///   - agent task, in_progress with NO lease and untouched for a week
  ///     → back to pending (this is the recovery path for everything the
  ///       pre-lease code wedged)
  ///   - user task, in_progress and untouched for a week → flagged only.
  ///     We do NOT rewrite the user's own status; that's their call. We
  ///     just stamp stalledSince so stalledTasks() can surface it.
  ///
  /// Tasks with an open draft are never swept: they aren't abandoned, they
  /// are waiting on a review.
  sweepStuckTasks({ now = this.clock() } = {}) {
    const openDrafts = this._openDraftTaskIds();
    const report = { requeued: [], stalled: [], flagged: [] };
    for (const task of [...this.tasks.values()]) {
      if (task.status === "completed" || task.status === "cancelled") continue;
      if (openDrafts.has(task.id)) continue;

      if (task.queue !== "agent") {
        if (task.status === "in_progress" && !task.sourceMeta?.stalledSince && this._isStale(task, now)) {
          this.update(task.id, {
            sourceMeta: { ...(task.sourceMeta ?? {}), stalledSince: task.updatedAt ?? new Date(now).toISOString() }
          });
          report.flagged.push(task.id);
        }
        continue;
      }

      const lease = task.sourceMeta?.agentLease ?? null;
      const attempts = this._leaseAttempts(task);
      const leaseExpired = lease?.expiresAt
        ? Number.isFinite(Date.parse(lease.expiresAt)) && now >= Date.parse(lease.expiresAt)
        : false;

      if (attempts >= this.maxAttempts && (task.status === "pending" || leaseExpired)) {
        this._stall(task, attempts, now);
        report.stalled.push(task.id);
        continue;
      }
      if (task.status !== "in_progress") continue;
      if (leaseExpired) {
        this._requeue(task, "lease-expired", now);
        report.requeued.push(task.id);
        continue;
      }
      // No lease at all + long dead: pre-lease wreckage or an observer
      // guess nobody acted on. Reclaim it — with attempts reset, since the
      // queue never actually got a turn at it.
      if (!lease && this._isStale(task, now)) {
        this._requeue(task, "stale-in-progress", now, { resetAttempts: true });
        report.requeued.push(task.id);
      }
    }
    return report;
  }

  /// Everything the user should be able to SEE as stuck, with a reason.
  /// This is the anti-invisibility guarantee: a task that the agent gave up
  /// on, or that is silently waiting on a human, shows up here instead of
  /// quietly rotting in the snapshot.
  stalledTasks({ now = this.clock() } = {}) {
    const openDrafts = this._openDraftTaskIds();
    const out = [];
    for (const task of this.tasks.values()) {
      if (task.status === "completed" || task.status === "cancelled") continue;
      // A stall record only means anything while the task is actually parked.
      const stall = task.status === "blocked" ? task.sourceMeta?.agentStall : null;
      if (stall) {
        out.push({ task, reason: stall.reason ?? "no-progress", since: stall.at ?? null, attempts: stall.attempts ?? null });
        continue;
      }
      if (openDrafts.has(task.id)) {
        out.push({
          task,
          reason: "awaiting-draft-review",
          since: task.sourceMeta?.awaitingReview?.since ?? task.updatedAt ?? null,
          attempts: null
        });
        continue;
      }
      // Once flagged, a task stays visible until its status actually moves —
      // don't let the flagging write (which bumps updatedAt) make it look
      // fresh again and drop it back out of sight.
      if (task.status === "in_progress" && (task.sourceMeta?.stalledSince || this._isStale(task, now))) {
        out.push({
          task,
          reason: "stale-in-progress",
          since: task.sourceMeta?.stalledSince ?? task.updatedAt ?? null,
          attempts: this._leaseAttempts(task) || null
        });
      }
    }
    return out.sort((a, b) => (a.since ?? "").localeCompare(b.since ?? ""));
  }

  _stall(task, attempts, now) {
    const at = new Date(now).toISOString();
    const meta = { ...(task.sourceMeta ?? {}) };
    delete meta.agentLease;
    meta.agentStall = { reason: "no-progress", attempts, at };
    const next = this.update(task.id, { status: "blocked", sourceMeta: meta });
    this.runtime?.events?.emit?.("task-stalled", { task: next, attempts, at });
    return next;
  }

  _requeue(task, reason, now, { resetAttempts = false } = {}) {
    const meta = { ...(task.sourceMeta ?? {}) };
    const attempts = resetAttempts ? 0 : this._leaseAttempts(task);
    delete meta.agentLease;
    if (attempts > 0) meta.agentLease = { attempts };
    meta.agentReconcile = { from: task.status, reason, at: new Date(now).toISOString() };
    return this.update(task.id, { status: "pending", sourceMeta: meta });
  }

  _releaseLeaseOnStatusChange(next) {
    // A task deliberately returned to the queue is no longer stalled. This
    // matters for the dependsOn path: a stalled task whose blocker completes
    // gets auto-unblocked to pending, and it must not keep advertising a
    // stall it has since been released from.
    if (next.status === "pending" && next.sourceMeta?.agentStall) {
      const cleared = { ...next.sourceMeta };
      delete cleared.agentStall;
      delete cleared.agentLease;
      next.sourceMeta = cleared;
    }
    const lease = next.sourceMeta?.agentLease;
    if (!lease?.expiresAt) return;
    if (next.status === "in_progress") return;
    const meta = { ...next.sourceMeta };
    if (next.status === "completed" || next.status === "cancelled") {
      // Terminal: the claim and its history are done with.
      delete meta.agentLease;
      delete meta.awaitingReview;
    } else {
      // Deferred / re-queued by the agent. Drop the reservation but KEEP the
      // attempt count — a model that bounces the same task forever still has
      // to hit the cap.
      meta.agentLease = { attempts: lease.attempts ?? 0 };
    }
    next.sourceMeta = meta;
  }

  _leaseAttempts(task) {
    const n = Number(task?.sourceMeta?.agentLease?.attempts ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  _leaseIsLive(task, now) {
    const expiresAt = task?.sourceMeta?.agentLease?.expiresAt;
    if (!expiresAt) return false;
    const ms = Date.parse(expiresAt);
    return Number.isFinite(ms) && now < ms;
  }

  _isStale(task, now) {
    const ms = Date.parse(task?.updatedAt ?? "");
    if (!Number.isFinite(ms)) return false;
    return now - ms >= this.staleInProgressMs;
  }

  /// Task ids that already have a draft the agent shouldn't duplicate.
  /// Returns an empty set when there is no draft store, so a runtime
  /// without drafts behaves exactly as before.
  _openDraftTaskIds() {
    const out = new Set();
    const drafts = this.runtime?.drafts;
    if (typeof drafts?.list !== "function") return out;
    try {
      for (const d of drafts.list({ status: null }) ?? []) {
        if (d?.taskId && OPEN_DRAFT_STATUSES.has(d.status)) out.add(d.taskId);
      }
    } catch { /* a broken draft store must not wedge the queue */ }
    return out;
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
      tasks: [...this.tasks.values()],
      goals: [...this.goals.values()]
    });
  }

  // ─── Story 11: goals ─────────────────────────────────────────────────

  addGoal(input) {
    const id = createId("goal");
    const goal = {
      id,
      title: String(input.title ?? "").trim(),
      description: input.description ?? "",
      dueDate: input.dueDate ?? null,
      status: GOAL_STATUSES.includes(input.status) ? input.status : "active",
      parentGoalId: input.parentGoalId ?? null,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    if (!goal.title) throw new Error("goal requires a title");
    this.goals.set(id, goal);
    this.appendEvent("goals", { op: "goal-create", goal });
    this.snapshot();
    return goal;
  }

  updateGoal(id, patch) {
    const cur = this.goals.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, id: cur.id, updatedAt: nowIso() };
    if (patch.status !== undefined && !GOAL_STATUSES.includes(patch.status)) {
      throw new Error(`unknown goal status: ${patch.status}`);
    }
    this.goals.set(id, next);
    this.appendEvent("goals", { op: "goal-update", id, patch });
    this.snapshot();
    return next;
  }

  listGoals({ status, parentGoalId } = {}) {
    let out = [...this.goals.values()];
    if (status) out = out.filter((g) => g.status === status);
    if (parentGoalId !== undefined) out = out.filter((g) => g.parentGoalId === parentGoalId);
    return out.sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));
  }

  getGoal(id) {
    return this.goals.get(id) ?? null;
  }

  /// Link a task to a goal (or unlink with goalId=null). Returns the
  /// updated task or null when the task doesn't exist.
  linkTaskToGoal(taskId, goalId) {
    const t = this.tasks.get(taskId);
    if (!t) return null;
    if (goalId && !this.goals.has(goalId)) throw new Error(`unknown goal: ${goalId}`);
    return this.update(taskId, { parentGoalId: goalId ?? null });
  }

  /// Compute rollup progress for a goal: how many child tasks done /
  /// total. Recurses one level into child goals (their rolled-up
  /// totals count too) so a quarter goal can summarize its monthly
  /// children's tasks. Returns null when goal doesn't exist.
  goalProgress(goalId) {
    const goal = this.goals.get(goalId);
    if (!goal) return null;
    const children = [...this.tasks.values()].filter((t) => t.parentGoalId === goalId);
    let total = children.length;
    let done = children.filter((t) => t.status === "completed").length;
    // Sub-goals: count their tasks toward this goal's rollup.
    const subGoals = this.listGoals({ parentGoalId: goalId });
    for (const sub of subGoals) {
      const subRoll = this.goalProgress(sub.id);
      if (subRoll) { total += subRoll.total; done += subRoll.done; }
    }
    return {
      goalId,
      total,
      done,
      percent: total === 0 ? null : Number(((done / total) * 100).toFixed(1)),
      hasSubGoals: subGoals.length > 0
    };
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
