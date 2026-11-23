// One queue per shared device conversation, owned by the hub.
//
// Every message a paired phone or the owner's Mac sends to a shared thread
// with its own turn id (requestId) lands here first, whether it arrived on
// POST /message (streamed) or POST /conversations/:thread/queue (queued from
// a busy client). The hub runs them one at a time, in arrival order, so:
//
// - every device sees the same queue, in the same order, with who sent what;
// - a normal send waits for the turn ahead of it, whichever device sent that;
// - a resend of the same id never queues or runs twice, and a different
//   message never replaces another (an id reused for different text is a
//   conflict, not an overwrite);
// - any device can edit, remove or send-now an item, with a revision check so
//   a stale edit is refused rather than silently winning;
// - the queue is durable: items not yet started survive a hub restart and run
//   afterwards, with the authority of the device that sent them.
//
// An item being edited is held (a renewable lease): the queue waits at it, so
// the old text never runs and nothing passes it. A lease that is not renewed
// lapses, so a device that went away cannot block the queue for long.
//
// Turns run through LiveTurns, so streaming, attach-after-reconnect, replay
// and interrupt (message-turns.js) work exactly as for any named turn.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { STOPPED_TEXT } from "./message-turns.js";

export const QUEUE_LIMIT = 50;
export const HOLD_MS = 90_000;
const TOMBSTONE_LIMIT = 200;
const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
const TEXT_LIMIT = 64 * 1024;

export class QueueError extends Error {
  constructor(code, status, message, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

const fail = (code, status, message, extra) => new QueueError(code, status, message, extra);
const fileName = (sessionId) => `${crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}.json`;

// What makes two submissions "the same message": a retry of the same id with
// this digest attaches to it; the same id with another digest is refused.
export function submissionDigest({ text, attachments = [], focusedCardId = null }) {
  const pictures = (attachments ?? []).map((image) => crypto.createHash("sha256").update(String(image?.data ?? "")).digest("hex"));
  return crypto.createHash("sha256").update(JSON.stringify([String(text ?? ""), pictures, focusedCardId ?? null])).digest("hex");
}

export class ConversationQueue {
  // startTurn(item, hooks) runs one item's turn (AgentHost via channels) and
  // returns its promise. mintPrincipal(spec) rebuilds the sender's authority
  // after a restart, or returns null when that sender is no longer allowed.
  constructor({ dir, liveTurns, startTurn, mintPrincipal = () => null, onChange = () => {}, now = () => Date.now(), holdMs = HOLD_MS }) {
    this.holdMs = holdMs;
    this.dir = dir;
    this.liveTurns = liveTurns;
    this.startTurn = startTurn;
    this.mintPrincipal = mintPrincipal;
    this.onChange = onChange;
    this.now = now;
    this.sessions = new Map();
    this.timers = new Map();
    if (dir) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Loads every saved queue and starts what was waiting. An item that was
  // already running when the hub stopped is not run again: its own records
  // (or their absence) say how it ended.
  restore() {
    if (!this.dir) return;
    for (const name of fs.readdirSync(this.dir).filter((entry) => entry.endsWith(".json"))) {
      const saved = readJsonFile(path.join(this.dir, name), null);
      if (!saved?.sessionId || !Array.isArray(saved.items)) continue;
      const state = this.session(saved.sessionId);
      state.revision = Number(saved.revision) || 0;
      state.tombstones = Array.isArray(saved.tombstones) ? saved.tombstones : [];
      for (const item of saved.items) {
        if (item.state === "running") continue;
        const principal = this.mintPrincipal(item.principal);
        if (!principal && item.principal) {
          this.tombstone(state, item.requestId, "not_run", "The device that sent this is no longer paired.");
          continue;
        }
        state.items.push({ ...item, state: "queued", principalObject: principal });
      }
      state.revision += 1;
      this.persist(saved.sessionId);
      for (const item of state.items) this.track(saved.sessionId, item);
      this.dispatch(saved.sessionId);
    }
  }

  session(sessionId) {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { items: [], running: null, revision: 0, tombstones: [], waiters: new Map() };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  find(sessionId, requestId) {
    return this.sessions.get(sessionId)?.items.find((item) => item.requestId === requestId) ?? null;
  }

  // How a removed, stopped-before-running or not-run item ended, so a resend
  // of its id never brings it back.
  tombstoneFor(sessionId, requestId) {
    const state = this.sessions.get(sessionId);
    if (!state) return null;
    const cutoff = this.now() - TOMBSTONE_TTL_MS;
    state.tombstones = state.tombstones.filter((entry) => entry.at >= cutoff);
    return state.tombstones.find((entry) => entry.requestId === requestId) ?? null;
  }

  tombstone(state, requestId, outcome, message) {
    state.tombstones = [...state.tombstones.filter((entry) => entry.requestId !== requestId),
      { requestId, outcome, message, at: this.now() }].slice(-TOMBSTONE_LIMIT);
  }

  // Adds one message. A resend of a queued or running id returns that item
  // (same digest) or is refused (different digest). Returns the LiveTurns
  // turn that runs it.
  submit(item) {
    const { sessionId, requestId } = item;
    const state = this.session(sessionId);
    const existing = this.find(sessionId, requestId);
    if (existing) {
      if (existing.digest !== item.digest) throw fail("request_conflict", 409, "This message id already belongs to a different message.");
      return { turn: this.liveTurns.get(sessionId, requestId), item: existing, duplicate: true };
    }
    if (state.items.length >= QUEUE_LIMIT) throw fail("queue_full", 429, `This conversation already has ${QUEUE_LIMIT} waiting messages.`);
    const at = new Date(this.now()).toISOString();
    const entry = {
      requestId, sessionId, thread: item.thread, conversationId: item.conversationId ?? "main",
      text: String(item.text), body: item.body, digest: item.digest, source: item.source,
      principal: item.principalSpec ?? null, principalObject: item.principal ?? null,
      state: "queued", hold: null, revision: 1, createdAt: at, updatedAt: at
    };
    state.items.push(entry);
    this.changed(sessionId);
    const turn = this.track(sessionId, entry);
    this.dispatch(sessionId);
    return { turn, item: entry, duplicate: false };
  }

  // Registers the item's turn. It waits for its slot, then runs the item's
  // current text; interrupting it while it waits ends it without running.
  track(sessionId, entry) {
    const turn = this.liveTurns.run(sessionId, entry.requestId, async (hooks) => {
      await this.slot(sessionId, entry.requestId, hooks.signal);
      const current = this.find(sessionId, entry.requestId) ?? entry;
      return this.startTurn(current, hooks);
    });
    turn.promise.then(() => this.settled(sessionId, entry.requestId, "complete"),
      (error) => this.settled(sessionId, entry.requestId, error?.code === "OWNER_INTERRUPTED" ? "stopped" : error?.code === "QUEUE_REMOVED" ? "removed" : "failed"));
    return turn;
  }

  slot(sessionId, requestId, signal) {
    const state = this.session(sessionId);
    if (state.running === requestId) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onAbort = () => { state.waiters.delete(requestId); reject(signal.reason); };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      state.waiters.set(requestId, {
        go: () => { signal?.removeEventListener("abort", onAbort); resolve(); },
        drop: (error) => { signal?.removeEventListener("abort", onAbort); reject(error); }
      });
    });
  }

  // Starts the first item when nothing of this queue is running, unless it
  // is held for an edit (the queue waits there).
  dispatch(sessionId) {
    const state = this.session(sessionId);
    if (state.running) return;
    const head = state.items[0];
    if (!head) return;
    if (this.isHeld(head)) {
      this.armHoldTimer(sessionId, head);
      return;
    }
    head.state = "running";
    head.hold = null;
    head.updatedAt = new Date(this.now()).toISOString();
    state.running = head.requestId;
    this.changed(sessionId);
    const waiter = state.waiters.get(head.requestId);
    state.waiters.delete(head.requestId);
    waiter?.go();
  }

  settled(sessionId, requestId, outcome) {
    const state = this.session(sessionId);
    const index = state.items.findIndex((item) => item.requestId === requestId);
    if (index >= 0) {
      const wasRunning = state.items[index].state === "running";
      state.items.splice(index, 1);
      if (!wasRunning && outcome === "stopped") this.tombstone(state, requestId, "stopped", STOPPED_TEXT);
    }
    if (state.running === requestId) state.running = null;
    this.changed(sessionId);
    this.dispatch(sessionId);
  }

  isHeld(item) {
    return Boolean(item.hold && item.hold.until > this.now());
  }

  armHoldTimer(sessionId, item) {
    clearTimeout(this.timers.get(sessionId));
    const timer = setTimeout(() => { this.timers.delete(sessionId); this.dispatch(sessionId); }, Math.max(0, item.hold.until - this.now()) + 5);
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }

  editable(sessionId, requestId, actor, baseRevision) {
    const item = this.find(sessionId, requestId);
    if (!item) {
      const gone = this.tombstoneFor(sessionId, requestId);
      throw fail(gone ? "already_removed" : "already_sent", 409, gone ? "That message was already removed." : "That message was already sent, so it can't be changed.");
    }
    if (item.state === "running") throw fail("already_sent", 409, "That message is already running, so it can't be changed.", { item: this.project(sessionId, item) });
    if (this.isHeld(item) && item.hold.key !== actor.key) {
      throw fail("held", 409, `${item.hold.name} is editing that message.`, { item: this.project(sessionId, item) });
    }
    if (baseRevision !== undefined && baseRevision !== null && Number(baseRevision) !== item.revision) {
      throw fail("conflict", 409, "That message changed on another device. Review it and try again.", { item: this.project(sessionId, item) });
    }
    return item;
  }

  // Edit: hold (open the editor), change the text (Save), release (Cancel).
  // Text needs the revision the editor started from.
  update(sessionId, requestId, actor, { text, hold, baseRevision } = {}) {
    if (text !== undefined && (baseRevision === undefined || baseRevision === null)) {
      throw fail("revision_required", 400, "Send the revision you edited (baseRevision).");
    }
    const item = this.editable(sessionId, requestId, actor, text !== undefined ? baseRevision : undefined);
    if (text !== undefined) {
      const trimmed = String(text).trim();
      if ((!trimmed && !(item.body?.attachments?.length)) || trimmed.includes("\0") || Buffer.byteLength(trimmed, "utf8") > TEXT_LIMIT) {
        throw fail("invalid_text", 400, "A queued message needs text (at most 64 KiB). Remove it instead.");
      }
      const effective = trimmed || "Please describe the attached images.";
      item.text = effective;
      item.body = { ...item.body, text: effective };
      item.revision += 1;
    }
    if (hold === true) item.hold = { key: actor.key, name: actor.name, until: this.now() + this.holdMs };
    else if (hold === false || text !== undefined) item.hold = null;
    item.updatedAt = new Date(this.now()).toISOString();
    this.changed(sessionId);
    this.dispatch(sessionId);
    return this.project(sessionId, item);
  }

  remove(sessionId, requestId, actor, { baseRevision } = {}) {
    const item = this.editable(sessionId, requestId, actor, baseRevision);
    const state = this.session(sessionId);
    this.tombstone(state, requestId, "removed", `Removed from the queue by ${actor.name}.`);
    const waiter = state.waiters.get(requestId);
    state.waiters.delete(requestId);
    state.items = state.items.filter((entry) => entry !== item);
    this.changed(sessionId);
    const removed = new Error(`Removed from the queue by ${actor.name}.`);
    removed.code = "QUEUE_REMOVED";
    waiter?.drop(removed);
    this.dispatch(sessionId);
    return { removed: requestId };
  }

  // Moves one waiting item to the front. Returns the running item's id, if
  // any, for the caller to interrupt (message-turns.js interruptTurn).
  moveToFront(sessionId, requestId, actor) {
    const item = this.editable(sessionId, requestId, actor);
    const state = this.session(sessionId);
    const runningIndex = state.items.findIndex((entry) => entry.state === "running");
    state.items = state.items.filter((entry) => entry !== item);
    state.items.splice(runningIndex >= 0 ? runningIndex + 1 : 0, 0, item);
    item.updatedAt = new Date(this.now()).toISOString();
    this.changed(sessionId);
    return { running: state.running, item: this.project(sessionId, item) };
  }

  changed(sessionId) {
    const state = this.session(sessionId);
    state.revision += 1;
    this.persist(sessionId);
    try { this.onChange({ sessionId, revision: state.revision }); } catch { /* notification is best-effort */ }
  }

  persist(sessionId) {
    if (!this.dir) return;
    const state = this.session(sessionId);
    const items = state.items.map(({ principalObject: _principal, ...item }) => item);
    writeJsonAtomic(path.join(this.dir, fileName(sessionId)), { sessionId, revision: state.revision, items, tombstones: state.tombstones });
  }

  project(sessionId, item, actorKey = null) {
    const state = this.session(sessionId);
    return {
      requestId: item.requestId,
      text: item.text.slice(0, 16_000),
      attachmentCount: item.body?.attachments?.length ?? 0,
      source: { device: item.source?.device ?? null, name: item.source?.name ?? null, nodeId: item.source?.nodeId ?? null },
      ...(actorKey ? { mine: item.source?.key === actorKey } : {}),
      state: item.state === "running" ? "running" : this.isHeld(item) ? "held" : "queued",
      ...(this.isHeld(item) && item.state !== "running" ? {
        heldBy: item.hold.name, heldUntil: new Date(item.hold.until).toISOString(),
        ...(actorKey ? { heldByMe: item.hold.key === actorKey } : {})
      } : {}),
      position: state.items.indexOf(item),
      revision: item.revision,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    };
  }

  // What every device shows. Running item first, then the waiting ones.
  snapshot(sessionId, actorKey = null) {
    const state = this.sessions.get(sessionId);
    if (!state) return { revision: 0, items: [] };
    return { revision: state.revision, items: state.items.map((item) => this.project(sessionId, item, actorKey)) };
  }

  close() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
