import { createHash } from "node:crypto";
import { lifelogState, moments } from "./conversation-lifelog.js";

// One conversation per thread for every paired device (phones and G2s). The
// session ids are fixed and never derived from anything a client sends, so a
// device can join the shared thread but can never address the owner's own
// dashboard chat or inherit a computer-use lease approved there.
export const SHARED_THREADS = Object.freeze(["agent", "supervisor"]);
const SESSION_IDS = new Map(SHARED_THREADS.map(thread => [`devices:${thread}:main`, thread]));
const HISTORY_PATH = /^\/conversations\/(agent|supervisor)\/messages$/;
const MESSAGE_ID = /^[\w-]{1,200}$/;

// Same { code, status } shape as G2ChannelError so both transports can map it.
export class SharedConversationError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = "SharedConversationError";
    this.code = code;
    this.status = status;
  }
}
const fail = (code, status, message) => new SharedConversationError(code, status, message);

export function isSharedThread(value) { return SHARED_THREADS.includes(value); }
export function sharedSessionId(thread) {
  if (!isSharedThread(thread)) throw fail("invalid_thread", 400, "thread must be \"agent\" or \"supervisor\".");
  return `devices:${thread}:main`;
}
export function sharedThreadForSession(sessionId) { return SESSION_IDS.get(sessionId) ?? null; }
export function sharedHistoryThread(pathname) { return HISTORY_PATH.exec(String(pathname ?? ""))?.[1] ?? null; }

// Same projection as the G2 history view: user and assistant text only, never
// tool calls, tool results or private metadata. Oldest-first; `before` pages
// toward older messages and `nextBefore` is the cursor for the next page.
export function sharedThreadHistory(store, thread, { before, limit } = {}) {
  if (!store?.getSession) throw fail("history_unavailable", 503, "Main history is not configured.");
  const sessionId = sharedSessionId(thread);
  const size = limit === undefined || limit === null ? 50 : limit;
  if (!Number.isSafeInteger(size) || size < 1 || size > 100) throw fail("invalid_history", 400, "limit must be 1 to 100.");
  if (before !== undefined && before !== null && (typeof before !== "string" || !MESSAGE_ID.test(before)))
    throw fail("invalid_history", 400, "before must be a message id.");
  const isVisible = m => ["user", "assistant"].includes(m?.role) && typeof m.content === "string" && typeof m.id === "string";
  const session = store.getSession(sessionId);
  let visible = session.messages.filter(isVisible);
  let end = before ? visible.findIndex(m => m.id === before) : visible.length;
  // Older turns rotate into the store's archive; read it only when this page
  // reaches past the active tail, then page through it the same way.
  if ((end < 0 || end - size <= 0) && session.metadata?.historyArchived === true && typeof store.archivedMessages === "function") {
    const active = new Set(visible.map(m => m.id));
    const archived = store.archivedMessages(sessionId).filter(m => isVisible(m) && !active.has(m.id));
    visible = [...archived, ...visible];
    end = before ? visible.findIndex(m => m.id === before) : visible.length;
  }
  if (end < 0) throw fail("unknown_message", 404, "That message is no longer in this thread's history.");
  const start = Math.max(0, end - size);
  return { thread, messages: visible.slice(start, end).map(projectMessage), nextBefore: start > 0 ? visible[start].id : null };
}

function projectMessage(m) {
  const user = m.role === "user";
  return {
    id: m.id, role: m.role, text: m.content.slice(0, 16000), at: m.createdAt,
    sourceNodeId: user && typeof m.metadata?.sourceNodeId === "string" ? m.metadata.sourceNodeId : null,
    sourceName: user && typeof m.metadata?.sourceName === "string" ? m.metadata.sourceName : null
  };
}

// Tells subscribers which shared thread changed after each stored message
// (the user turn, then the reply or its failure record), whatever transport
// wrote it. Wraps the one store instance; the returned function unwraps it.
export function observeSharedThreads(store, onUpdate) {
  if (typeof store?.appendMessage !== "function") return () => {};
  const original = store.appendMessage;
  const wrapped = function appendMessage(sessionId, message) {
    const session = original.call(this, sessionId, message);
    const thread = sharedThreadForSession(sessionId);
    if (thread) {
      try { onUpdate({ thread, messageId: session?.messages?.at(-1)?.id ?? null }); } catch { /* a listener never fails a turn */ }
    }
    return session;
  };
  store.appendMessage = wrapped;
  return () => { if (store.appendMessage === wrapped) store.appendMessage = original; };
}

export function parseLifelogMomentsQuery(params) {
  const date = params.get("date") || null, query = params.get("query") ?? "", rawLimit = params.get("limit");
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw fail("invalid_date", 400, "date must be YYYY-MM-DD.");
  if (query.length > 200) throw fail("invalid_query", 400, "Search is limited to 200 characters.");
  const limit = rawLimit === null ? 50 : /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : NaN;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fail("invalid_limit", 400, "limit must be 1 to 100.");
  return { date, query, limit };
}

// Read-only moments across every enrolled G2, newest first. Reads the
// proactive store's retained segments without adding an entry for a device
// that never captured anything (G2Proactive.node() would); the
// date filter uses each device's own configured time zone, like the owner view.
export function lifelogMoments(proactive, devices, { date = null, query = "", limit = 50 } = {}) {
  proactive.prune();
  const needle = query.toLowerCase(), result = [];
  for (const device of devices) {
    const n = proactive.nodes?.[createHash("sha256").update(device.nodeId).digest("hex")];
    if (!n?.segments?.length) continue;
    const labels = lifelogState(n).labels;
    const day = date ? new Intl.DateTimeFormat("en-CA", { timeZone: n.settings?.timeZone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }) : null;
    for (const m of moments(n)) {
      if (day && day.format(m.at) !== date) continue;
      const lines = m.segments.map(s => (labels[s.speakerKey] ? `${labels[s.speakerKey]}: ${s.text}` : s.text));
      if (needle && ![m.title, ...m.topics, ...lines].join(" ").toLowerCase().includes(needle)) continue;
      result.push({ id: m.id, nodeId: device.nodeId, deviceName: device.name || "Even G2",
        at: new Date(m.at).toISOString(), endAt: new Date(m.endAt).toISOString(), title: m.title,
        summary: m.review?.summary || null, transcript: lines.join("\n").slice(0, 16000) });
    }
  }
  return { moments: result.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit) };
}
