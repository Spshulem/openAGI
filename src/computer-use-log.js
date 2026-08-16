import path from "node:path";
import fs from "node:fs";
import { ensureDir, writeJsonAtomic, readJsonFile, appendJsonLine } from "./file-utils.js";
import { createId, nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

// Persistent record of every computer-use action the agent intends to take,
// alongside the reasoning the model supplied for it. Each action belongs
// to a session (one user-approved goal). Same JSONL+snapshot pattern as
// TaskStore / PendingActionStore so a crash mid-loop doesn't lose history.
//
// Typed text is NEVER persisted. A type action stores only byte/character
// counts. We intentionally do not keep a digest: user-entered secrets often
// come from small enough spaces that a hash becomes a dictionary oracle.
//
// Schema for a session:
//   { id, goal, status, startedAt, decidedBy, endedAt?, actions: [actionId, ...] }
// Schema for an action:
//   { id, sessionId, kind, args, reasoning, status, createdAt, executedAt?, result?, error? }

export class ComputerUseLog {
  constructor({ dir, now = () => Date.now(), idleMs = 2 * 60 * 1000, absoluteMs = 15 * 60 * 1000 } = {}) {
    this.dir = dir ?? path.join(resolveDataDir(), "computer-use");
    ensureDir(this.dir);
    this.sessions = new Map();
    this.actions = new Map();
    this.events = null;
    this.now = now;
    this.idleMs = idleMs;
    this.absoluteMs = absoluteMs;
    this._migrateSensitiveHistory();
    this._loadSnapshot();
    this._replayJournal();
    this._revokeRecoveredSessions();
  }

  bindEvents(events) {
    this.events = events;
  }

  listSessions({ status } = {}) {
    this._expireSessions();
    const all = [...this.sessions.values()];
    const filtered = status ? all.filter((s) => s.status === status) : all;
    return filtered.sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1));
  }

  getSession(id) {
    this._expireSessions();
    return this.sessions.get(id) ?? null;
  }

  activeSessionFor(sourceSessionId) {
    if (typeof sourceSessionId !== "string" || !sourceSessionId) return null;
    this._expireSessions();
    return this.listSessions({ status: "active" }).find((session) => session.sourceSessionId === sourceSessionId) ?? null;
  }

  listActions({ sessionId, limit = 200 } = {}) {
    const all = [...this.actions.values()];
    const filtered = sessionId ? all.filter((a) => a.sessionId === sessionId) : all;
    return filtered.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1)).slice(0, limit);
  }

  /// Start a new computer-use session. Records the user-stated goal +
  /// who approved it. Returns the session record.
  startSession({ goal, approvedBy, approvalActionId, sourceSessionId, targetNodeId = null, capability = "computer-use" }) {
    if (typeof sourceSessionId !== "string" || !sourceSessionId) {
      throw new Error("Computer-use approval must be bound to a source chat session.");
    }
    const cleanGoal = String(goal ?? "").trim().slice(0, 500);
    if (!cleanGoal) throw new Error("Computer-use session goal is required.");
    const existing = this.activeSessionFor(sourceSessionId);
    if (existing) {
      if (existing.goal !== cleanGoal || existing.targetNodeId !== targetNodeId || existing.capability !== capability) {
        throw new Error("This chat already has a different active computer-use session.");
      }
      return existing;
    }
    const startedMs = this.now();
    const startedAt = new Date(startedMs).toISOString();
    const session = {
      id: createId("cus"),
      goal: cleanGoal,
      approvedBy: approvedBy ?? "user",
      approvalActionId: approvalActionId ?? null,
      sourceSessionId,
      targetNodeId,
      capability,
      status: "active",
      startedAt,
      lastActiveAt: startedAt,
      idleExpiresAt: new Date(startedMs + this.idleMs).toISOString(),
      expiresAt: new Date(startedMs + this.absoluteMs).toISOString(),
      endedAt: null,
      actionIds: [],
      nextSequence: 1
    };
    this.sessions.set(session.id, session);
    this._appendJournal({ op: "session-start", session });
    this.events?.emit?.("computer-use", { kind: "session-start", session });
    return session;
  }

  endSession(id, { reason, status = "ended" } = {}) {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.status !== "active") return session;
    session.status = status;
    session.endedAt = new Date(this.now()).toISOString();
    session.endReason = reason ?? null;
    this._appendJournal({ op: "session-end", id, status, endedAt: session.endedAt, reason });
    this.events?.emit?.("computer-use", { kind: "session-end", session });
    return session;
  }

  /// Log an action the agent is about to take (or, in stub mode, would
  /// have taken). Stores intent + reasoning before we attempt execution
  /// so even a crash mid-spawn leaves a paper trail.
  recordAction({ sessionId, kind, args, reasoning }) {
    this._expireSessions();
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "active") {
      throw new Error(`Cannot record action: session '${sessionId}' is not active.`);
    }
    const safeArgs = sanitizeActionArgs(kind, args ?? {});
    const safeReasoning = sanitizeReasoning(reasoning, kind, args ?? {});
    const sequence = Number.isSafeInteger(session.nextSequence) ? session.nextSequence : session.actionIds.length + 1;
    const action = {
      id: createId("act"),
      sessionId,
      kind,
      args: safeArgs,
      reasoning: safeReasoning,
      sequence,
      status: "pending",
      createdAt: new Date(this.now()).toISOString(),
      executedAt: null,
      result: null,
      error: null
    };
    this.actions.set(action.id, action);
    session.actionIds.push(action.id);
    session.nextSequence = sequence + 1;
    session.lastActiveAt = action.createdAt;
    session.idleExpiresAt = new Date(this.now() + this.idleMs).toISOString();
    this._appendJournal({ op: "action-record", action });
    this.events?.emit?.("computer-use", { kind: "action-record", action });
    return action;
  }

  markActionResult(id, { result, error, status = "executed" }) {
    const action = this.actions.get(id);
    if (!action) return null;
    if (action.kind === "type") {
      result = { redacted: true, outcome: error ? "failed" : String(status).slice(0, 40) };
      error = error === undefined || error === null ? undefined : "type-action-failed";
    }
    action.status = error ? "failed" : status;
    action.executedAt = new Date(this.now()).toISOString();
    if (result !== undefined) action.result = result;
    if (error !== undefined) action.error = error;
    this._appendJournal({ op: "action-result", id, status: action.status, executedAt: action.executedAt, result, error });
    this.events?.emit?.("computer-use", { kind: "action-result", action });
    return action;
  }

  stats() {
    this._expireSessions();
    const sessions = [...this.sessions.values()];
    return {
      sessions: sessions.length,
      active: sessions.filter((s) => s.status === "active").length,
      ended: sessions.filter((s) => s.status === "ended").length,
      aborted: sessions.filter((s) => s.status === "aborted").length,
      expired: sessions.filter((s) => s.status === "expired").length,
      actions: this.actions.size
    };
  }

  // ─── Persistence (JSONL + periodic snapshot) ───────────────────────

  _journalPath() {
    return path.join(this.dir, "journal.jsonl");
  }

  snapshot() {
    writeJsonAtomic(path.join(this.dir, "snapshot.json"), {
      version: 1,
      writtenAt: nowIso(),
      sessions: [...this.sessions.values()],
      actions: [...this.actions.values()]
    });
  }

  _loadSnapshot() {
    const snap = readJsonFile(path.join(this.dir, "snapshot.json"), null);
    if (!snap) return;
    for (const s of snap.sessions ?? []) this.sessions.set(s.id, s);
    for (const a of snap.actions ?? []) this.actions.set(a.id, sanitizeLoadedAction(a));
  }

  _replayJournal() {
    const file = this._journalPath();
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { return; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.op === "session-start" && event.session) {
        this.sessions.set(event.session.id, event.session);
      } else if (event.op === "session-end" && event.id) {
        const s = this.sessions.get(event.id);
        if (s) { s.status = event.status; s.endedAt = event.endedAt; s.endReason = event.reason; }
      } else if (event.op === "action-record" && event.action) {
        const action = sanitizeLoadedAction(event.action);
        this.actions.set(action.id, action);
        const session = this.sessions.get(action.sessionId);
        if (session) {
          session.actionIds ??= [];
          if (!session.actionIds.includes(action.id)) session.actionIds.push(action.id);
          session.nextSequence = Math.max(session.nextSequence ?? 1, (action.sequence ?? session.actionIds.length) + 1);
        }
      } else if (event.op === "action-result" && event.id) {
        const a = this.actions.get(event.id);
        if (a) {
          a.status = event.status;
          a.executedAt = event.executedAt;
          if (a.kind === "type") {
            a.result = { redacted: true, outcome: event.error ? "failed" : String(event.status ?? "executed").slice(0, 40) };
            a.error = event.error === undefined || event.error === null ? null : "type-action-failed";
          } else {
            if (event.result !== undefined) a.result = event.result;
            if (event.error !== undefined) a.error = event.error;
          }
        }
      }
    }
  }

  _appendJournal(event) {
    appendJsonLine(this._journalPath(), event);
  }

  _migrateSensitiveHistory() {
    const snapshotPath = path.join(this.dir, "snapshot.json");
    const snapshot = readJsonFile(snapshotPath, null);
    if (snapshot && Array.isArray(snapshot.actions)) {
      const sanitized = snapshot.actions.map(sanitizeLoadedAction);
      if (JSON.stringify(sanitized) !== JSON.stringify(snapshot.actions)) {
        writeJsonAtomic(snapshotPath, { ...snapshot, actions: sanitized });
      }
    }
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return; }
    for (const name of names) {
      if (!/^journal(?:[-.].*)?\.jsonl(?:\..*)?$/.test(name)) continue;
      const file = path.join(this.dir, name);
      let raw;
      try { raw = fs.readFileSync(file, "utf8"); } catch { continue; }
      const parsed = raw.split("\n").filter((line) => line.trim()).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      const typeIds = new Set(parsed
        .filter((event) => event.op === "action-record" && event.action?.kind === "type")
        .map((event) => event.action.id));
      let changed = parsed.length !== raw.split("\n").filter((line) => line.trim()).length;
      const safeEvents = parsed.map((event) => {
        if (event.op === "action-record" && event.action?.kind === "type") {
          const action = sanitizeLoadedAction(event.action);
          if (JSON.stringify(action) !== JSON.stringify(event.action)) changed = true;
          return { ...event, action };
        }
        if (event.op === "action-result" && typeIds.has(event.id)) {
          const safe = {
            ...event,
            result: { redacted: true, outcome: event.error ? "failed" : String(event.status ?? "executed").slice(0, 40) },
            error: event.error === undefined || event.error === null ? undefined : "type-action-failed"
          };
          if (JSON.stringify(safe) !== JSON.stringify(event)) changed = true;
          return safe;
        }
        return event;
      });
      if (!changed) continue;
      const temp = `${file}.redact-${process.pid}-${Date.now()}`;
      fs.writeFileSync(temp, safeEvents.map((event) => JSON.stringify(event)).join("\n") + (safeEvents.length ? "\n" : ""), { mode: 0o600 });
      fs.renameSync(temp, file);
    }
  }

  _expireSessions() {
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (session.status !== "active") continue;
      const absolute = Date.parse(session.expiresAt ?? session.startedAt);
      const idle = Date.parse(session.idleExpiresAt ?? session.lastActiveAt ?? session.startedAt);
      if ((Number.isFinite(absolute) && now > absolute) || (Number.isFinite(idle) && now > idle)) {
        session.status = "expired";
        session.endedAt = new Date(now).toISOString();
        session.endReason = "computer-use approval lease expired";
        this._appendJournal({
          op: "session-end", id: session.id, status: session.status,
          endedAt: session.endedAt, reason: session.endReason
        });
        this.events?.emit?.("computer-use", { kind: "session-end", session });
      }
    }
  }

  _revokeRecoveredSessions() {
    const endedAt = new Date(this.now()).toISOString();
    for (const session of this.sessions.values()) {
      if (session.status !== "active") continue;
      session.status = "aborted";
      session.endedAt = endedAt;
      session.endReason = "daemon restarted; computer-use approval must be renewed";
      this._appendJournal({
        op: "session-end", id: session.id, status: session.status,
        endedAt, reason: session.endReason
      });
    }
  }
}

function sanitizeActionArgs(kind, args) {
  if (kind !== "type") return { ...args };
  if (typeof args?.text !== "string" && args?.textRedacted === true) {
    return {
      textRedacted: true,
      characterCount: Number.isSafeInteger(args.characterCount) && args.characterCount >= 0 ? args.characterCount : 0,
      byteCount: Number.isSafeInteger(args.byteCount) && args.byteCount >= 0 ? args.byteCount : 0
    };
  }
  const value = String(args?.text ?? "");
  return {
    textRedacted: true,
    characterCount: [...value].length,
    byteCount: Buffer.byteLength(value, "utf8")
  };
}

function sanitizeReasoning(reasoning, kind, args) {
  // A model's rationale for typing commonly repeats or paraphrases the value.
  // Persist no free-form reasoning for this action class.
  if (kind === "type") return null;
  if (reasoning == null) return null;
  return String(reasoning).slice(0, 500);
}

function sanitizeLoadedAction(action) {
  if (!action || typeof action !== "object") return action;
  if (action.kind !== "type") return action;
  const hadError = action.error !== undefined && action.error !== null;
  return {
    ...action,
    args: sanitizeActionArgs("type", action.args),
    reasoning: null,
    result: action.result == null ? action.result : {
      redacted: true,
      outcome: hadError ? "failed" : String(action.status ?? "executed").slice(0, 40)
    },
    error: hadError ? "type-action-failed" : action.error
  };
}
