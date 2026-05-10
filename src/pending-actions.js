import path from "node:path";
import fs from "node:fs";
import { ensureDir, writeJsonAtomic, readJsonFile, appendJsonLine } from "./file-utils.js";
import { createId, nowIso } from "./utils.js";

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
  constructor({ dir } = {}) {
    this.dir = dir ?? path.join(process.cwd(), ".openagi", "pending-actions");
    ensureDir(this.dir);
    this.actions = new Map();
    this.events = null;
    this._loadSnapshot();
    this._replayJournal();
  }

  /// Late-bound: hosted-interface creates the event bus, then calls this
  /// so subsequent enqueue/decide calls broadcast over SSE → Mac app.
  bindEvents(events) {
    this.events = events;
  }

  list({ status } = {}) {
    const all = [...this.actions.values()];
    const filtered = status ? all.filter((a) => a.status === status) : all;
    return filtered.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
  }

  get(id) {
    return this.actions.get(id) ?? null;
  }

  enqueue({ toolName, args, context, summary, reason }) {
    const action = {
      id: createId("act"),
      toolName,
      args: args ?? {},
      context: serializableContext(context),
      summary: summary ?? `Run ${toolName}`,
      reason: reason ?? null,
      status: "pending",
      createdAt: nowIso(),
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

  decide(id, { decision, decidedBy, result, error }) {
    const action = this.actions.get(id);
    if (!action) return null;
    if (action.status !== "pending") return action;
    action.status = decision === "approve" ? "approved" : "denied";
    action.decidedAt = nowIso();
    action.decidedBy = decidedBy ?? "user";
    if (result !== undefined) action.result = result;
    if (error !== undefined) action.error = error;
    this.actions.set(id, action);
    this._appendJournal({ op: "decide", id, status: action.status, decidedAt: action.decidedAt, decidedBy: action.decidedBy, result, error });
    return action;
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
      }
    }
  }

  _appendJournal(event) {
    appendJsonLine(this._journalPath(), event);
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
    target: ctx.target ?? null
  };
}
