import { imageHistoryPreview } from "./message-attachments.js";
import { createHash, randomUUID } from "node:crypto";
import { lifelogState, moments } from "./conversation-lifelog.js";

// One conversation per thread for every paired device (phones and G2s). The
// session ids are fixed and never derived from anything a client sends, so a
// device can join the shared thread but can never address the owner's own
// dashboard chat or inherit a computer-use lease approved there.
export const SHARED_THREADS = Object.freeze(["agent", "supervisor"]);
const CONVERSATION_ID = /^(?:main|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const DEVICE_SESSION = /^devices:(agent|supervisor):(main|[0-9a-f-]{36})$/;
const WEB_SESSION = /^local:browser(?:-[^:\x00]{1,180})?:main$/;
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
export function sharedSessionId(thread, conversationId = "main") {
  if (!isSharedThread(thread)) throw fail("invalid_thread", 400, "thread must be \"agent\" or \"supervisor\".");
  if (!CONVERSATION_ID.test(conversationId)) throw fail("invalid_conversation", 400, "Choose a valid conversation.");
  return `devices:${thread}:${conversationId}`;
}
export function sharedThreadForSession(sessionId) { return DEVICE_SESSION.exec(sessionId)?.[1] ?? null; }
export function sharedConversationForSession(sessionId) { return DEVICE_SESSION.exec(sessionId)?.[2] ?? null; }
export function sharedHistoryThread(pathname) { return HISTORY_PATH.exec(String(pathname ?? ""))?.[1] ?? null; }

// Paired owner phones can read human-visible web chat, but never address its
// session on /message. Continuing makes a separate shared-device session;
// authority, tool calls, approvals and computer-use leases are not copied.
function webID(sessionId) { return `web-${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`; }
function webSessions(store) { return store.listSessions({ prefix: "local:browser", limit: 100 }).filter(s => WEB_SESSION.test(s.id)); }
function visibleSessionID(store, thread, conversationId) {
  if (typeof conversationId === "string" && /^web-[a-f0-9]{32}$/.test(conversationId) && thread === "agent") {
    const found = webSessions(store).find(s => webID(s.id) === conversationId);
    if (!found) throw fail("unknown_conversation", 404, "That conversation is no longer available.");
    return found.id;
  }
  return sharedSessionId(thread, conversationId);
}

export function sharedConversations(store) {
  const sessions = [
    ...SHARED_THREADS.map(thread => ({ id: sharedSessionId(thread), thread, conversationId: "main" })),
    ...store.listSessions({ prefix: "devices:", limit: 100 }).flatMap(s => {
      const match = DEVICE_SESSION.exec(s.id);
      return match && match[2] !== "main" && CONVERSATION_ID.test(match[2])
        ? [{ id: s.id, thread: match[1], conversationId: match[2] }] : [];
    }),
    ...webSessions(store).map(s => ({ id: s.id, thread: "agent", conversationId: webID(s.id), readOnly: true }))
  ];
  return { conversations: sessions.map(item => {
    const session = store.getSession(item.id);
    const messages = session.messages.filter(m => ["user", "assistant"].includes(m.role) && typeof m.content === "string");
    return { id: item.conversationId, thread: item.thread, readOnly: item.readOnly === true,
      title: messages.find(m => m.role === "user")?.content.slice(0, 80) || (item.conversationId === "main" ? `Shared ${item.thread} chat` : "New chat"),
      preview: messages.at(-1)?.content.slice(0, 180) || "Start a conversation",
      updatedAt: session.updatedAt, messageCount: messages.length };
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
}

export function createSharedConversation(store, { thread, sourceId } = {}) {
  if (!isSharedThread(thread)) throw fail("invalid_thread", 400, "Choose Agent or Supervisor.");
  const source = sourceId === undefined ? null : store.getSession(visibleSessionID(store, thread, sourceId));
  const id = randomUUID();
  const sessionId = sharedSessionId(thread, id);
  store.saveSession({ id: sessionId, createdAt: new Date().toISOString(), messages: [], metadata: { thread } });
  for (const message of (source?.messages ?? []).filter(m => ["user", "assistant"].includes(m.role) && typeof m.content === "string").slice(-50)) {
    store.appendMessage(sessionId, { role: message.role, content: message.content,
      metadata: { thread, ...(message.role === "user" && message.metadata?.attachments?.length ? { attachments: message.metadata.attachments } : {}) } });
  }
  return sharedConversations(store).conversations.find(c => c.id === id);
}

// Same projection as the G2 history view: user and assistant text only, never
// tool calls, tool results or private metadata. Oldest-first; `before` pages
// toward older messages and `nextBefore` is the cursor for the next page.
export function sharedThreadHistory(store, thread, { before, limit, conversationId = "main" } = {}) {
  if (!store?.getSession) throw fail("history_unavailable", 503, "Main history is not configured.");
  const sessionId = visibleSessionID(store, thread, conversationId);
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
    sourceName: user && typeof m.metadata?.sourceName === "string" ? m.metadata.sourceName : null,
    ...(user && m.metadata?.attachments?.length ? { attachments: imageHistoryPreview(m.metadata.attachments) } : {})
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
      try { onUpdate({ thread, conversationId: sharedConversationForSession(sessionId), messageId: session?.messages?.at(-1)?.id ?? null }); } catch { /* a listener never fails a turn */ }
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
