import path from "node:path";
import fs from "node:fs";
import { ensureDir, writeJsonAtomic, readJsonFile, appendJsonLine } from "./file-utils.js";
import { createId, nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

// File-backed queue of agent-initiated actions awaiting human approval.
// When the agent invokes a tool flagged `needsConfirmation: true`, the
// tool registry intercepts and persists a record here instead of running
// the handler. The dashboard's Suggestions tab surfaces these so the user
// can approve / deny; on approve, the tool registry re-invokes the
// original handler with __confirmed=true to bypass the gate.
//
// Persistence: same JSONL+snapshot pattern as TaskStore so a daemon crash
// mid-action-queue doesn't lose anything.

export class PendingActionStore {
  constructor({ dir, now = () => Date.now() } = {}) {
    this.dir = dir ?? path.join(resolveDataDir(), "pending-actions");
    this.now = now;
    ensureDir(this.dir);
    this.actions = new Map();
    this.events = null;
    // Recovery and expiry happen while the durable runtime is constructed,
    // before createHostedInterface owns/binds the live event bus. Hold those
    // resolutions until bindEvents() so the durable outreach copy is not left
    // actionable after its underlying approval became terminal at startup.
    this.deferredResolutionEvents = [];
    this._loadSnapshot();
    this._replayJournal();
    this._recoverInterruptedExecutions();
    this._recoverInterruptedContinuations();
    this._expirePending();
  }

  /// Late-bound: hosted-interface creates the event bus, then calls this
  /// so subsequent enqueue/decide calls broadcast over SSE → Mac app.
  bindEvents(events) {
    this.events = events;
    const deferred = this.deferredResolutionEvents.splice(0);
    for (const payload of deferred) {
      this.events?.emit?.("pending-action-resolved", payload);
    }
  }

  list({ status } = {}) {
    this._expirePending();
    const all = [...this.actions.values()];
    const filtered = status ? all.filter((a) => a.status === status) : all;
    return filtered.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
  }

  get(id) {
    this._expirePending();
    return this.actions.get(id) ?? null;
  }

  enqueue({ toolName, args, context, summary, reason, dedupeKey, ttlMs = null }) {
    const boundedDedupeKey = typeof dedupeKey === "string" ? dedupeKey.slice(0, 500) : null;
    if (boundedDedupeKey) {
      const existing = this.list({ status: "pending" }).find((candidate) =>
        candidate.toolName === toolName && candidate.dedupeKey === boundedDedupeKey
      );
      if (existing) return existing;
    }
    const createdMs = this.now();
    const createdAt = new Date(createdMs).toISOString();
    const boundedTtlMs = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0
      ? Math.min(Math.trunc(Number(ttlMs)), 24 * 60 * 60 * 1000)
      : null;
    const action = {
      id: createId("act"),
      toolName,
      args: args ?? {},
      context: serializableContext(context),
      summary: summary ?? `Run ${toolName}`,
      reason: reason ?? null,
      dedupeKey: boundedDedupeKey,
      status: "pending",
      createdAt,
      expiresAt: boundedTtlMs ? new Date(createdMs + boundedTtlMs).toISOString() : null,
      decidedAt: null,
      decidedBy: null,
      result: null,
      error: null
    };
    this.actions.set(action.id, action);
    this._appendJournal({ op: "enqueue", action });
    this.events?.emit?.("pending-action", {
      id: action.id,
      toolName: action.toolName,
      summary: action.summary,
      reason: action.reason,
      createdAt: action.createdAt
    });
    return action;
  }

  // Synchronously claim a pending action before its side effect is awaited.
  // Dashboard, overlay, and notification approval surfaces can race; checking
  // `status === pending` in each route is not enough because both requests can
  // pass that check before either handler returns. The persisted executing
  // state makes the claim one-shot and fail-closed across a daemon crash.
  claimForExecution(id, { claimedBy = "user" } = {}) {
    this._expirePending();
    const action = this.actions.get(id);
    if (!action || action.status !== "pending") return null;
    const claimedAt = new Date(this.now()).toISOString();
    const executionId = createId("exec");
    action.status = "executing";
    action.claimedAt = claimedAt;
    action.claimedBy = claimedBy;
    action.executionId = executionId;
    this._appendJournal({ op: "claim", id, status: action.status, claimedAt, claimedBy, executionId });
    return { action, executionId };
  }

  decide(id, { decision, decidedBy, result, error, executionId = null }) {
    this._expirePending();
    const action = this.actions.get(id);
    if (!action) return null;
    const finishingClaim = action.status === "executing"
      && typeof executionId === "string"
      && executionId === action.executionId;
    if (action.status !== "pending" && !finishingClaim) return action;
    action.status = decision === "approve" ? "approved" : "denied";
    action.decidedAt = new Date(this.now()).toISOString();
    action.decidedBy = decidedBy ?? "user";
    if (result !== undefined) action.result = result;
    if (error !== undefined) action.error = error;
    this.actions.set(id, action);
    this._appendJournal({ op: "decide", id, status: action.status, decidedAt: action.decidedAt, decidedBy: action.decidedBy, result, error });
    this._emitResolution(action);
    return action;
  }

  prepareContinuation(id, { requestId, sessionId, resetFailed = false } = {}) {
    const action = this.actions.get(id);
    if (!action || action.status !== "approved" || action.error != null) return null;
    if (action.continuation?.status === "delivered") return action.continuation;
    if (action.continuation && !(resetFailed && action.continuation.status === "failed")) {
      return action.continuation;
    }
    const at = new Date(this.now()).toISOString();
    action.continuation = {
      status: "pending",
      requestId: String(requestId ?? `approval_${id}`).slice(0, 240),
      sessionId: String(sessionId ?? action.context?.sessionId ?? "").slice(0, 500),
      attempts: resetFailed ? 0 : Number(action.continuation?.attempts ?? 0),
      updatedAt: at,
      error: null
    };
    this._appendJournal({ op: "continuation", id, continuation: action.continuation });
    return action.continuation;
  }

  claimContinuation(id, { maxAttempts = 5 } = {}) {
    const action = this.actions.get(id);
    const continuation = action?.continuation;
    if (!action || action.status !== "approved" || action.error != null || !continuation) return null;
    if (!new Set(["pending", "failed"]).has(continuation.status)) return null;
    if (continuation.attempts >= maxAttempts) return null;
    const deliveryId = createId("delivery");
    continuation.status = "delivering";
    continuation.deliveryId = deliveryId;
    continuation.attempts += 1;
    continuation.updatedAt = new Date(this.now()).toISOString();
    continuation.error = null;
    this._appendJournal({ op: "continuation", id, continuation });
    return { action, continuation, deliveryId };
  }

  finishContinuation(id, { deliveryId, delivered, terminal = false, error = null } = {}) {
    const action = this.actions.get(id);
    const continuation = action?.continuation;
    if (!continuation || continuation.status !== "delivering"
        || continuation.deliveryId !== deliveryId) return null;
    continuation.status = delivered ? "delivered" : terminal ? "blocked" : "failed";
    continuation.updatedAt = new Date(this.now()).toISOString();
    continuation.error = delivered ? null : String(error ?? "continuation failed").slice(0, 200);
    delete continuation.deliveryId;
    this._appendJournal({ op: "continuation", id, continuation });
    return continuation;
  }

  recoverableContinuations({ toolName } = {}) {
    return [...this.actions.values()].filter((action) =>
      action.status === "approved"
      && action.error == null
      && (!toolName || action.toolName === toolName)
      && action.context?.sessionId
      && (!action.continuation || ["pending", "failed", "delivering"].includes(action.continuation.status))
    );
  }

  // Persist a snapshot once the journal grows past N entries — keeps
  // replay cost bounded across long uptime.
  snapshot() {
    writeJsonAtomic(path.join(this.dir, "snapshot.json"), {
      version: 1,
      writtenAt: nowIso(),
      actions: [...this.actions.values()]
    });
    // Truncate journal: rename current to .archived-<ts> then start fresh.
    const journalPath = this._journalPath();
    if (fs.existsSync(journalPath)) {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      try {
        fs.renameSync(journalPath, path.join(this.dir, `journal.${ts}.archived`));
      } catch { /* ignore */ }
    }
  }

  _journalPath() {
    return path.join(this.dir, "journal.jsonl");
  }

  _loadSnapshot() {
    const snap = readJsonFile(path.join(this.dir, "snapshot.json"), null);
    if (!snap?.actions) return;
    for (const action of snap.actions) {
      this.actions.set(action.id, action);
    }
  }

  _replayJournal() {
    const file = this._journalPath();
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { return; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.op === "enqueue" && event.action) {
        this.actions.set(event.action.id, event.action);
      } else if (event.op === "decide" && event.id) {
        const a = this.actions.get(event.id);
        if (a) {
          a.status = event.status;
          a.decidedAt = event.decidedAt;
          a.decidedBy = event.decidedBy;
          if (event.result !== undefined) a.result = event.result;
          if (event.error !== undefined) a.error = event.error;
        }
      } else if (event.op === "claim" && event.id) {
        const a = this.actions.get(event.id);
        if (a && a.status === "pending") {
          a.status = "executing";
          a.claimedAt = event.claimedAt;
          a.claimedBy = event.claimedBy;
          a.executionId = event.executionId;
        }
      } else if (event.op === "continuation" && event.id && event.continuation) {
        const a = this.actions.get(event.id);
        if (a) a.continuation = event.continuation;
      }
    }
  }

  _appendJournal(event) {
    appendJsonLine(this._journalPath(), event);
  }

  _expirePending() {
    const atMs = this.now();
    const decidedAt = new Date(atMs).toISOString();
    for (const action of this.actions.values()) {
      if (action.status !== "pending" || !action.expiresAt) continue;
      const expiresAt = Date.parse(action.expiresAt);
      if (!Number.isFinite(expiresAt) || atMs < expiresAt) continue;
      action.status = "expired";
      action.decidedAt = decidedAt;
      action.decidedBy = "system";
      action.error = "Approval expired before it was used.";
      this._appendJournal({
        op: "decide",
        id: action.id,
        status: action.status,
        decidedAt,
        decidedBy: action.decidedBy,
        error: action.error
      });
      this._emitResolution(action);
    }
  }

  _recoverInterruptedExecutions() {
    const decidedAt = new Date(this.now()).toISOString();
    for (const action of this.actions.values()) {
      if (action.status !== "executing") continue;
      action.status = "interrupted";
      action.decidedAt = decidedAt;
      action.decidedBy = "system";
      action.error = "Approval execution was interrupted by a daemon restart; request it again before retrying.";
      this._appendJournal({
        op: "decide",
        id: action.id,
        status: action.status,
        decidedAt,
        decidedBy: action.decidedBy,
        error: action.error
      });
      this._emitResolution(action);
    }
  }

  _recoverInterruptedContinuations() {
    for (const action of this.actions.values()) {
      if (action.continuation?.status !== "delivering") continue;
      action.continuation.status = "pending";
      action.continuation.updatedAt = new Date(this.now()).toISOString();
      action.continuation.error = "delivery interrupted by daemon restart";
      delete action.continuation.deliveryId;
      this._appendJournal({ op: "continuation", id: action.id, continuation: action.continuation });
    }
  }

  _emitResolution(action) {
    const payload = {
      id: action.id,
      toolName: action.toolName,
      status: action.status,
      decidedAt: action.decidedAt,
      decidedBy: action.decidedBy,
      error: action.error ?? null,
      // "approved" records the user's decision. It does not, by itself,
      // prove the confirmed handler succeeded. Consumers must use this field
      // before presenting the linked outreach item as acted.
      executionSucceeded: action.status === "approved" && action.error == null
    };
    if (this.events) {
      this.events.emit?.("pending-action-resolved", payload);
    } else {
      this.deferredResolutionEvents.push(payload);
    }
  }
}

// Strip non-serializable bits from the tool-invocation context. We keep
// only fields we know are safe + useful for replaying the action later.
function serializableContext(ctx) {
  if (!ctx) return null;
  return {
    sessionId: ctx.sessionId ?? null,
    agentId: ctx.agentId ?? null,
    channel: ctx.channel ?? null,
    from: ctx.from ?? null,
    target: ctx.target ?? null,
    origin: ctx.origin === "autopilot" || ctx.origin === "cron" ? ctx.origin : null
  };
}
