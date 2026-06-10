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
// Two-tier privacy: the action TYPE + reasoning is always logged; the
// action ARGS (e.g. what string was typed) are also logged but can be
// surfaced redacted in the dashboard if the action is flagged sensitive
// (typing into a password field).
//
// Schema for a session:
//   { id, goal, status, startedAt, decidedBy, endedAt?, actions: [actionId, ...] }
// Schema for an action:
//   { id, sessionId, kind, args, reasoning, status, createdAt, executedAt?, result?, error? }

export class ComputerUseLog {
  constructor({ dir } = {}) {
    this.dir = dir ?? path.join(resolveDataDir(), "computer-use");
    ensureDir(this.dir);
    this.sessions = new Map();
    this.actions = new Map();
    this.events = null;
    this._loadSnapshot();
    this._replayJournal();
  }

  bindEvents(events) {
    this.events = events;
  }

  listSessions({ status } = {}) {
    const all = [...this.sessions.values()];
    const filtered = status ? all.filter((s) => s.status === status) : all;
    return filtered.sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1));
  }

  getSession(id) {
    return this.sessions.get(id) ?? null;
  }

  listActions({ sessionId, limit = 200 } = {}) {
    const all = [...this.actions.values()];
    const filtered = sessionId ? all.filter((a) => a.sessionId === sessionId) : all;
    return filtered.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1)).slice(0, limit);
  }

  /// Start a new computer-use session. Records the user-stated goal +
  /// who approved it. Returns the session record.
  startSession({ goal, approvedBy }) {
    const session = {
      id: createId("cus"),
      goal: String(goal ?? "").slice(0, 500),
      approvedBy: approvedBy ?? "user",
      status: "active",
      startedAt: nowIso(),
      endedAt: null,
      actionIds: []
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
    session.endedAt = nowIso();
    session.endReason = reason ?? null;
    this._appendJournal({ op: "session-end", id, status, endedAt: session.endedAt, reason });
    this.events?.emit?.("computer-use", { kind: "session-end", session });
    return session;
  }

  /// Log an action the agent is about to take (or, in stub mode, would
  /// have taken). Stores intent + reasoning before we attempt execution
  /// so even a crash mid-spawn leaves a paper trail.
  recordAction({ sessionId, kind, args, reasoning }) {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "active") {
      throw new Error(`Cannot record action: session '${sessionId}' is not active.`);
    }
    const action = {
      id: createId("act"),
      sessionId,
      kind,
      args: args ?? {},
      reasoning: reasoning ?? null,
      status: "pending",
      createdAt: nowIso(),
      executedAt: null,
      result: null,
      error: null
    };
    this.actions.set(action.id, action);
    session.actionIds.push(action.id);
    this._appendJournal({ op: "action-record", action });
    this.events?.emit?.("computer-use", { kind: "action-record", action });
    return action;
  }

  markActionResult(id, { result, error, status = "executed" }) {
    const action = this.actions.get(id);
    if (!action) return null;
    action.status = error ? "failed" : status;
    action.executedAt = nowIso();
    if (result !== undefined) action.result = result;
    if (error !== undefined) action.error = error;
    this._appendJournal({ op: "action-result", id, status: action.status, executedAt: action.executedAt, result, error });
    this.events?.emit?.("computer-use", { kind: "action-result", action });
    return action;
  }

  stats() {
    const sessions = [...this.sessions.values()];
    return {
      sessions: sessions.length,
      active: sessions.filter((s) => s.status === "active").length,
      ended: sessions.filter((s) => s.status === "ended").length,
      aborted: sessions.filter((s) => s.status === "aborted").length,
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
    for (const a of snap.actions ?? []) this.actions.set(a.id, a);
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
        this.actions.set(event.action.id, event.action);
      } else if (event.op === "action-result" && event.id) {
        const a = this.actions.get(event.id);
        if (a) {
          a.status = event.status;
          a.executedAt = event.executedAt;
          if (event.result !== undefined) a.result = event.result;
          if (event.error !== undefined) a.error = event.error;
        }
      }
    }
  }

  _appendJournal(event) {
    appendJsonLine(this._journalPath(), event);
  }
}
