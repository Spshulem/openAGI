// A phone that loses its /message stream (backgrounded, locked, network
// drop) must be able to send the same turn again without running it twice,
// and to see whether a turn it cannot hear any more is still running.
//
// The client names each turn with its own request id. While that turn runs,
// LiveTurns holds it, so a repeat of the same id attaches to it instead of
// starting another. Once it has ended, its user record and terminal assistant
// record (both carry metadata.requestId) say how it ended, so a repeat
// replays that outcome. Neither path calls the model again.

import { createHash } from "node:crypto";
import { readJsonFile, writeJsonAtomic } from "./file-utils.js";

const STAGE = /^[a-z_-]{1,40}$/;

export class LiveTurns {
  constructor() {
    this.turns = new Map();
  }

  static key(sessionId, requestId) {
    return `${sessionId}\u0000${requestId}`;
  }

  get(sessionId, requestId) {
    return this.turns.get(LiveTurns.key(sessionId, requestId)) ?? null;
  }

  // The turns still running in one session, for its history response.
  list(sessionId) {
    return [...this.turns.values()]
      .filter((turn) => turn.sessionId === sessionId)
      .map(({ requestId, stage, startedAt }) => ({ requestId, stage, startedAt }));
  }

  // Runs start(hooks) as the one live turn for this id. `listener` is
  // subscribed before start runs, so the caller hears even a synchronous
  // first progress event. The turn leaves the registry once it settles.
  run(sessionId, requestId, start, listener = null) {
    const key = LiveTurns.key(sessionId, requestId);
    const turn = { sessionId, requestId, stage: "queued", startedAt: new Date().toISOString(), listeners: new Set() };
    if (listener) turn.listeners.add(listener);
    const emit = (kind, data) => {
      for (const each of turn.listeners) {
        try { each(kind, data); } catch { /* one detached listener must not stop the turn */ }
      }
    };
    this.turns.set(key, turn);
    turn.promise = (async () => {
      try {
        return await start({
          onProgress: (raw) => {
            if (typeof raw?.stage === "string" && STAGE.test(raw.stage)) turn.stage = raw.stage;
            emit("progress", raw);
          },
          onTextDelta: (raw) => emit("delta", raw)
        });
      } finally {
        if (this.turns.get(key) === turn) this.turns.delete(key);
      }
    })();
    return turn;
  }

  subscribe(turn, listener) {
    turn.listeners.add(listener);
    return () => turn.listeners.delete(listener);
  }
}

// How a turn that is no longer running ended, from the session's own
// records: null when this id never reached the session (never accepted).
export function storedTurn(store, sessionId, requestId) {
  if (!store?.getSession || !sessionId || !requestId) return null;
  const messages = store.getSession(sessionId)?.messages ?? [];
  const userIndex = messages.findIndex((m) => m?.role === "user" && m.metadata?.requestId === requestId);
  if (userIndex < 0) return null;
  const reply = messages.slice(userIndex + 1)
    .find((m) => m?.role === "assistant" && m.metadata?.requestId === requestId);
  const messageCount = messages.length;
  if (!reply) return { status: "interrupted", sessionId, messageCount };
  if (reply.metadata?.status === "failed") {
    return { status: "failed", sessionId, messageCount, code: reply.metadata.code ?? "agent_failed", message: reply };
  }
  return { status: "complete", sessionId, messageCount, message: reply };
}

// The /message result a repeat of a finished turn returns: the same shape a
// live turn's `final` carries, marked as a replay.
export function replayedResult(stored) {
  return {
    id: stored.message.id,
    createdAt: stored.message.createdAt,
    agent: { id: stored.message.agentId ?? "main" },
    session: { id: stored.sessionId, messageCount: stored.messageCount },
    reply: stored.message.content,
    replayed: true
  };
}

// The error a repeat of a failed or interrupted turn rethrows, so the
// transport reports it the same way it reports a live failure.
export function replayedFailure(stored, requestId) {
  const error = new Error(stored.status === "interrupted"
    ? "This turn stopped before it finished (OpenAGI restarted). Send it again to retry."
    : String(stored.message?.content ?? "OpenAGI couldn't complete that request."));
  error.code = stored.status === "interrupted" ? "interrupted" : (stored.code ?? "agent_failed");
  error.openagiSessionId = stored.sessionId;
  error.openagiRequestId = requestId;
  error.openagiFailurePersisted = stored.status !== "interrupted";
  error.openagiReplayed = true;
  return error;
}

// Main's own durable note of each turn a client named, so a repeat of the id
// is recognised even after main restarts or the session's records rotate,
// and a client reconnecting with sends it never heard back about can ask how
// each one stands instead of guessing (and sending them all again).
//
//   queued       accepted; waiting behind another turn in the conversation
//   running      started (the user line may already be stored)
//   done/failed  ended with a reply or a failure record
//   interrupted  main stopped while it ran: never rerun under the same id
//
// A turn still queued when main stopped never started, so its receipt is
// dropped on load: the id reads as unknown and the client may send it again
// under the same id. Receipts are keyed by id, never by text, so two
// intentional sends with the same words stay two turns.
const RECEIPT_STATES = new Set(["queued", "running", "done", "failed", "interrupted"]);
const RECEIPT_LIMIT = 2000;
const RECEIPT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const CLIENT_TURN_ID = /^[A-Za-z0-9_-]{8,128}$/;

// Only to catch a client reusing one id for different words.
export function turnFingerprint(text) {
  return createHash("sha256").update(String(text ?? "").trim(), "utf8").digest("hex").slice(0, 32);
}

export class TurnReceipts {
  constructor(filePath = null, { limit = RECEIPT_LIMIT, maxAgeMs = RECEIPT_MAX_AGE_MS } = {}) {
    this.filePath = filePath;
    this.limit = limit;
    this.maxAgeMs = maxAgeMs;
    this.receipts = new Map();
    if (!filePath) return;
    const saved = readJsonFile(filePath, { receipts: [] });
    let changed = false;
    for (const item of Array.isArray(saved?.receipts) ? saved.receipts : []) {
      if (typeof item?.sessionId !== "string" || typeof item?.requestId !== "string" || !RECEIPT_STATES.has(item.state)) continue;
      if (item.state === "queued") { changed = true; continue; }
      let receipt = item;
      if (item.state === "running") {
        changed = true;
        receipt = { ...item, state: "interrupted", code: "interrupted", updatedAt: new Date().toISOString() };
      }
      this.receipts.set(LiveTurns.key(receipt.sessionId, receipt.requestId), receipt);
    }
    if (changed) this.save();
  }

  get(sessionId, requestId) {
    return this.receipts.get(LiveTurns.key(sessionId, requestId)) ?? null;
  }

  // Written before the turn is handed to the agent, so an acknowledged send
  // is on disk before anything can run.
  accept(sessionId, requestId, fingerprint) {
    const at = new Date().toISOString();
    const receipt = { sessionId, requestId, state: "queued", fingerprint, acceptedAt: at, updatedAt: at };
    this.receipts.set(LiveTurns.key(sessionId, requestId), receipt);
    this.save();
    return receipt;
  }

  mark(sessionId, requestId, state, { code } = {}) {
    const current = this.get(sessionId, requestId);
    if (!current || !RECEIPT_STATES.has(state) || current.state === state) return current;
    const next = { ...current, state, updatedAt: new Date().toISOString(), ...(code ? { code } : {}) };
    this.receipts.set(LiveTurns.key(sessionId, requestId), next);
    this.save();
    return next;
  }

  save() {
    const cutoff = Date.now() - this.maxAgeMs;
    const kept = [...this.receipts.values()]
      .filter((r) => ["queued", "running"].includes(r.state) || Date.parse(r.updatedAt) >= cutoff)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, this.limit);
    if (kept.length !== this.receipts.size) {
      this.receipts = new Map(kept.map((r) => [LiveTurns.key(r.sessionId, r.requestId), r]));
    }
    if (!this.filePath) return;
    try { writeJsonAtomic(this.filePath, { version: 1, receipts: kept }); } catch { /* the session records still answer repeats */ }
  }
}

// How each named turn stands, for a client reconciling its outbox: a live
// turn first, then the session's own records, then main's receipt. "unknown"
// means main never took that id (or dropped it before it started), so the
// client may send it again under the same id.
export function turnStates({ store, liveTurns, receipts, sessionId, requestIds }) {
  return requestIds.map((requestId) => {
    const live = liveTurns?.get(sessionId, requestId);
    if (live) return { requestId, state: live.stage === "queued" ? "queued" : "running", stage: live.stage };
    const stored = storedTurn(store, sessionId, requestId);
    if (stored?.status === "complete") return { requestId, state: "done", replyId: stored.message.id };
    if (stored?.status === "failed") return { requestId, state: "failed", code: stored.code, replyId: stored.message.id };
    if (stored?.status === "interrupted") return { requestId, state: "interrupted", code: "interrupted" };
    const receipt = receipts?.get(sessionId, requestId);
    if (receipt && ["done", "failed", "interrupted"].includes(receipt.state)) {
      return { requestId, state: receipt.state, ...(receipt.code ? { code: receipt.code } : {}) };
    }
    return { requestId, state: "unknown" };
  });
}

// A repeat of a turn main has a receipt for but no records of any more (they
// rotated out): it already ran, so it must not run again.
export function alreadyHandledFailure(sessionId, requestId) {
  const error = new Error("This message was already handled. Its reply is earlier in the conversation.");
  error.code = "already_handled";
  error.openagiSessionId = sessionId;
  error.openagiRequestId = requestId;
  error.openagiReplayed = true;
  return error;
}
