// Conductor sessions from conductor.db, opened read-only. Assistant rows in
// session_messages hold one Claude Agent SDK stream event as JSON; user rows
// hold the plain text the owner typed.

import fs from "node:fs";
import { classifyErrorText } from "../errors.js";
import {
  SUPERVISOR_PREFIX, clampTail, clampTailLines, clampText, cleanCardItem, isPidAlive as defaultIsPidAlive, isSupervisorOwnPrompt, openReadOnlyDb, prRefKey,
  liveCardItems, redactSecrets, repoFromRemote, threadKey, toIso
} from "../contracts.js";
import { liveTasks, peerBlockedOnOwner, readLivePeers } from "./claude.js";

const STATUS_MAP = Object.freeze({ working: "running", waiting: "waiting", idle: "idle", error: "error" });
const TAIL_ROWS = 400;
const MAX_STALE_MANAGER_ROWS = 10;
const MIN_REF_PREFIX = 8;
// The PRs a session created, newest first, at most this many.
const MAX_PRS_CREATED = 12;
// A PR's own link, not a comment or file link inside it.
const PR_URL = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?![\d#/])/;
// The PRs a session created: its gh pr create calls (its own or a
// subagent's, local or over ssh) and the results that answer them, which
// fall out of the tail. Read by LIKE over the session's rows once, then only
// over rows sent since (the (session_id, sent_at) index): the whole of
// cape-town (14,571 rows, 22 MB) takes ~35 ms, every session ~1.8 s.
const PR_CREATE_SQL = `
  SELECT content, sent_at, rowid AS row_id FROM session_messages
  WHERE session_id = ? AND sent_at >= ? AND role = 'assistant'
    AND (content LIKE '%gh pr create%' OR (content LIKE '%"tool_result"%' AND content LIKE '%github.com/%/pull/%'))
  ORDER BY sent_at, rowid`;
const CREATED_CACHE_MAX = 1_000;
const CALLS_KEPT = 200;
// "<db path>\n<session id>" -> { at, atRows, calls, refs }: what was read.
const createdCache = new Map();

const SESSIONS_SQL = `
  SELECT s.id, s.status, s.claude_session_id, s.title, s.model, s.updated_at, s.unread_count,
         w.local_id AS workspace_local_id, w.directory_name, w.branch, w.derived_status, w.workspace_path, w.pr_title, w.active_session_id,
         r.remote_url
  FROM sessions s
  JOIN workspaces w ON w.local_id = s.workspace_id
  LEFT JOIN repos r ON r.id = w.repository_id
  WHERE COALESCE(s.is_hidden, 0) = 0 AND COALESCE(w.state, '') != 'archived'`;

// (session_id, sent_at) is indexed, so these never scan a whole session.
const tailSql = (turnColumn) => `
  SELECT role, content, created_at, sent_at, rowid AS row_id, cancelled_at, sender_session_id, sender_api_key_name, ${turnColumn}
  FROM session_messages WHERE session_id = ? ORDER BY sent_at DESC, rowid DESC LIMIT ?`;
// A turn with hundreds of subagent rows pushes its AskUserQuestion call out
// of the tail. Both reads stay inside the current turn: "+session_id" keeps
// the planner on the turn_id index (it would otherwise walk the whole
// session by sent_at). Only a tool call named AskUserQuestion matches; rows
// that merely mention it (file reads, greps) escape the quote.
export const ASK_SQL = `
  SELECT content, created_at, sent_at, rowid AS row_id FROM session_messages
  WHERE turn_id = ? AND +session_id = ? AND role = 'assistant' AND content LIKE '%"name":"%AskUserQuestion"%'
  ORDER BY sent_at DESC, rowid DESC LIMIT 50`;
export const ASK_CLOSED_SQL = `
  SELECT content FROM session_messages
  WHERE turn_id = ? AND +session_id = ? AND role = 'assistant' AND (sent_at > ? OR (sent_at = ? AND rowid > ?))
    AND (content LIKE ? OR content LIKE '%"subtype":"init"%' OR content LIKE '%"type":"result"%' OR content LIKE '%"type":"error"%')
  ORDER BY sent_at, rowid LIMIT 50`;
// An errored session shows no card, whatever its last rows say.
const CARD_DEAD_STATUSES = new Set(["error"]);
const TASKS_SQL = `
  SELECT content, created_at FROM session_messages
  WHERE session_id = ? AND sent_at >= ? AND role = 'assistant'
    AND (content LIKE '%"subtype":"task_started"%' OR content LIKE '%"subtype":"task_notification"%')
  ORDER BY sent_at, rowid`;

// Conductor's updated_at trigger writes SQLite datetime('now'), which is UTC
// with no zone marker; Date.parse would read it as local time.
function dbTimeToIso(value) {
  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text)) return toIso(`${text.replace(" ", "T")}Z`);
  return toIso(text);
}

function latestIso(...values) {
  let best = null;
  for (const value of values) if (value && (!best || Date.parse(value) > Date.parse(best))) best = value;
  return best;
}

function parseEvent(content) {
  try {
    const event = JSON.parse(content);
    return event && typeof event === "object" ? event : null;
  } catch {
    return null;
  }
}

function eventText(event) {
  const content = event.message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text).join("\n").trim();
}

// An answer the agent sent back over a session socket with SendMessage (to
// a supervisor relay that has already exited) is its reply too: the
// transcript is where it is read. A message to a subagent is not.
function sentMessageText(event) {
  const content = Array.isArray(event.message?.content) ? event.message.content : [];
  const call = content.find((block) => block?.type === "tool_use" && block.name === "SendMessage" && /^uds:/.test(String(block.input?.to ?? ""))
    && typeof block.input?.message === "string");
  return call ? call.input.message.trim() : "";
}

function summarizeTail(rowsNewestFirst) {
  const summary = {
    lastUserText: "", lastUserAt: null, lastAgentText: "", lastAgentAt: null, lastEnd: null, model: null, lastAt: null, turnStartedAt: null,
    lastSupervisorAt: null, pendingAsks: new Map(), fullText: "", fullAt: null, firstUserText: null
  };
  for (const row of [...rowsNewestFirst].reverse()) {
    const at = dbTimeToIso(row.created_at);
    if (row.role === "user") {
      summary.lastAt = latestIso(summary.lastAt, at);
      // Cancelled drafts and messages from other sessions or API keys are not the owner.
      if (row.cancelled_at || row.sender_session_id || row.sender_api_key_name) continue;
      const text = String(row.content ?? "").trim();
      summary.firstUserText ??= text || null;
      if (text.startsWith(SUPERVISOR_PREFIX)) summary.lastSupervisorAt = at;
      else if (text) {
        summary.lastUserText = text;
        summary.lastUserAt = at;
      }
      continue;
    }
    const event = parseEvent(row.content);
    if (!event) continue;
    // System rows (commands_changed and other state broadcasts) also land
    // on idle tabs; only turn rows are activity.
    if (event.type !== "system") summary.lastAt = latestIso(summary.lastAt, at);
    // Every SDK turn opens with system/init. A new turn after an unanswered
    // AskUserQuestion means the agent moved on without the pick.
    if (event.type === "system" && event.subtype === "init") {
      summary.turnStartedAt = at;
      summary.pendingAsks.clear();
    }
    else if (event.type === "assistant" && event.parent_tool_use_id) {
      // A subagent's card shows to the owner too; its own tool_result closes it.
      const ask = askUserQuestion(event, at);
      if (ask) summary.pendingAsks.set(ask.id, { ...ask, subagent: true });
    }
    else if (event.type === "assistant") {
      if (typeof event.message?.model === "string") summary.model = event.message.model;
      const ask = askUserQuestion(event, at);
      if (ask) summary.pendingAsks.set(ask.id, ask);
      // The answer it relayed beats any preamble text beside it.
      const text = sentMessageText(event) || eventText(event);
      if (text) {
        summary.lastAgentText = text;
        summary.lastAgentAt = at;
        // A "<synthetic>" row (a session limit notice) is not the agent's reply.
        if (event.message?.model !== "<synthetic>") {
          summary.fullText = text;
          summary.fullAt = at;
        }
      }
    } else if (event.type === "result") {
      // The turn ended: no card of it is open any more.
      summary.pendingAsks.clear();
      const errors = Array.isArray(event.errors) ? event.errors.join("; ") : "";
      // Limit errors arrive as subtype "success" with is_error set.
      const isError = event.is_error === true || event.is_error === 1;
      summary.lastEnd = { isError, text: String(event.result ?? "") || errors, at };
      if (!isError && !summary.lastAgentText && event.result) {
        summary.lastAgentText = String(event.result);
        summary.lastAgentAt = at;
        summary.fullText = summary.lastAgentText;
        summary.fullAt = at;
      }
    } else if (event.type === "error") {
      // The process died ("exited with code 143"): its card went with it.
      summary.pendingAsks.clear();
      summary.lastEnd = { isError: true, text: String(event.content ?? ""), at };
    } else if (event.type === "user") {
      for (const id of summary.pendingAsks.keys()) if (answersTool(event, id)) summary.pendingAsks.delete(id);
    }
  }
  return summary;
}

// A gh pr create in any string of a tool call's input (a Bash command, an
// ssh line). Read raw, never as JSON: there a newline is the two characters
// backslash and n, so a gh pr create after a heredoc body has no word
// boundary before it (madrid's #7586 went unseen).
function createsPr(value, depth = 0) {
  if (typeof value === "string") return /\bgh\s+pr\s+create\b/.test(value);
  if (!value || typeof value !== "object" || depth > 4) return false;
  return Object.values(value).some((item) => createsPr(item, depth + 1));
}

// The PRs this session created, newest first: each gh pr create call's
// result, when it names one PR (the new one, or the one its branch already
// has). A PR the chat only viewed, checked, listed, commented on or named
// is not its own: another agent's PR, a stack base, one it reviewed.
// readTo: the newest sent_at the tail already read; every row up to it was
// in this read, so the next one starts there even when none matched.
function readCreatedPrs(db, sessionId, dbPath, readTo = null) {
  const key = `${dbPath ?? ""}\n${sessionId}`;
  const seen = createdCache.get(key) ?? { at: "", atRows: new Set(), calls: [], refs: [] };
  let rows;
  try {
    rows = db.prepare(PR_CREATE_SQL).all(sessionId, seen.at);
  } catch {
    // An older schema or a locked read: what was read before stands.
    return [...seen.refs].reverse();
  }
  const calls = new Set(seen.calls);
  const refs = [...seen.refs];
  let { at, atRows } = seen;
  for (const row of rows) {
    const sentAt = String(row.sent_at ?? "");
    if (sentAt === at && atRows.has(row.row_id)) continue;
    if (sentAt !== at) { at = sentAt; atRows = new Set(); }
    atRows.add(row.row_id);
    const content = parseEvent(row.content)?.message?.content;
    for (const block of Array.isArray(content) ? content : []) {
      if (block?.type === "tool_use" && block.id && createsPr(block.input)) calls.add(block.id);
      if (block?.type !== "tool_result" || !calls.has(block.tool_use_id)) continue;
      const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
      const links = new Set([...text.matchAll(new RegExp(PR_URL.source, "g"))].map((match) => prRefKey(`${match[1]}/${match[2]}`, Number(match[3]))));
      if (links.size !== 1) continue;
      const [ref] = links;
      const index = refs.indexOf(ref);
      if (index >= 0) refs.splice(index, 1);
      refs.push(ref);
    }
  }
  const tailAt = String(readTo ?? "");
  if (tailAt > at) {
    at = tailAt;
    atRows = new Set(rows.filter((row) => String(row.sent_at ?? "") === tailAt).map((row) => row.row_id));
  }
  createdCache.delete(key);
  if (createdCache.size >= CREATED_CACHE_MAX) createdCache.delete(createdCache.keys().next().value);
  createdCache.set(key, { at, atRows, calls: [...calls].slice(-CALLS_KEPT), refs: refs.slice(-MAX_PRS_CREATED) });
  return refs.slice(-MAX_PRS_CREATED).reverse();
}

// Conductor's AskUserQuestion: the tool call blocks the turn on the owner's
// pick, so the session reads "working" the whole time, and the questions are
// in the call, not the text.
function askUserQuestion(event, at) {
  const content = Array.isArray(event.message?.content) ? event.message.content : [];
  const call = content.find((block) => block?.type === "tool_use" && /AskUserQuestion$/.test(String(block.name ?? "")));
  const questions = Array.isArray(call?.input?.questions) ? call.input.questions.filter((q) => q && typeof q.question === "string") : [];
  if (!call?.id || !questions.length) return null;
  const choices = (q) => (Array.isArray(q.options) ? q.options : [])
    .map((option) => (typeof option === "string" ? option : option?.label))
    .filter((option) => typeof option === "string" && option.trim());
  // The card is a widget: typed text does not answer it. Every question is
  // one item, with its full labels; Conductor always offers "Other" too.
  const items = questions.map((q, index) => ({
    index, itemId: `${call.id}:${index}`, header: typeof q.header === "string" ? q.header : null, question: q.question.trim(),
    options: choices(q), multiSelect: q.multiSelect === true, freeText: true, at
  }));
  // The first question alone, as before cards (executor and older readers).
  const first = items[0];
  const text = first.options.length ? `${first.question} (${first.options.join(" / ")})` : first.question;
  return { id: String(call.id), at, text, options: [], items };
}

function answersTool(event, id) {
  const content = Array.isArray(event.message?.content) ? event.message.content : [];
  return content.some((block) => block?.type === "tool_result" && String(block.tool_use_id ?? "") === id);
}

function readRecentMessages(db, sessionId, turnColumn) {
  return db.prepare(tailSql(turnColumn)).all(sessionId, TAIL_ROWS);
}

// A session's opening prompt, which names a supervisor display chat. The
// tail's earliest prompt is it only while the tail holds the whole session;
// past that it is read once per session (it never changes), so a long
// display chat stays excluded.
const FIRST_PROMPT_SQL = `
  SELECT content FROM session_messages
  WHERE session_id = ? AND role = 'user' AND cancelled_at IS NULL AND sender_session_id IS NULL AND sender_api_key_name IS NULL
  ORDER BY sent_at, rowid LIMIT 1`;
const FIRST_PROMPTS_KEPT = 2000;
const firstPrompts = new Map();

function firstPromptOf(db, sessionId, rows, summary, cache, cacheKey) {
  if (rows.length < TAIL_ROWS) return summary.firstUserText;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const text = String(db.prepare(FIRST_PROMPT_SQL).get(sessionId)?.content ?? "").trim() || null;
  if (cache.size >= FIRST_PROMPTS_KEPT) cache.delete(cache.keys().next().value);
  cache.set(cacheKey, text);
  return text;
}

// The open AskUserQuestion calls (the agent's or a subagent's) of the
// current turn when the tail holds no start or end of that turn (the calls
// fell out of it), oldest first. A later tool_result, init, result or error
// row closes one, as in summarizeTail.
function readOlderAsks(db, sessionId, rows) {
  const turnId = currentTurnId(rows);
  if (!turnId) return [];
  const open = [];
  for (const row of db.prepare(ASK_SQL).all(turnId, sessionId)) {
    const event = parseEvent(row.content);
    if (event?.type !== "assistant") continue;
    const ask = askUserQuestion(event, dbTimeToIso(row.created_at));
    if (!ask) continue;
    const later = db.prepare(ASK_CLOSED_SQL).all(turnId, sessionId, row.sent_at, row.sent_at, row.row_id, `%${ask.id}%`);
    const closed = later.some((other) => {
      const next = parseEvent(other.content);
      if (!next) return false;
      return (next.type === "system" && next.subtype === "init") || next.type === "result" || next.type === "error" || (next.type === "user" && answersTool(next, ask.id));
    });
    if (!closed) open.unshift(event.parent_tool_use_id ? { ...ask, subagent: true } : ask);
  }
  return open;
}

// The turn of the newest row that has one. A trailing row with no turn_id
// (an older build, a queued user row) or an ambient broadcast (system rows
// such as commands_changed, which land on idle tabs too) does not name it.
function currentTurnId(rowsNewestFirst) {
  for (const row of rowsNewestFirst) {
    if (!row.turn_id || row.cancelled_at) continue;
    if (row.role !== "user") {
      const event = parseEvent(row.content);
      if (event?.type === "system" && event.subtype !== "init") continue;
    }
    return row.turn_id;
  }
  return null;
}

// Every open call of the turn as one card (a subagent's beside the agent's).
function cardOf(asks, limits) {
  if (!asks.length) return null;
  const items = asks.flatMap((ask) => ask.items).map((item, index) => cleanCardItem({ ...item, index }, limits));
  return { app: "conductor", cardId: asks[0].id, at: asks[0].at, count: items.length, items };
}

// Background tasks = task_started with no matching task_notification.
function readOpenTasks(db, sessionId, sinceIso) {
  const open = new Map();
  const rows = db.prepare(TASKS_SQL).all(sessionId, sinceIso);
  for (const row of rows) {
    const event = parseEvent(row.content);
    const taskId = event?.task_id ? String(event.task_id) : "";
    if (!taskId) continue;
    if (event.subtype === "task_started") {
      open.set(taskId, {
        id: taskId,
        description: clampText(redactSecrets(event.description ?? ""), 120),
        kind: String(event.task_type ?? "task"),
        startedAt: dbTimeToIso(row.created_at)
      });
    } else if (event.subtype === "task_notification") {
      open.delete(taskId);
    }
  }
  return [...open.values()];
}

function statusAndError(sessionStatus, lastEnd, now, excerptMax) {
  const agentStatus = STATUS_MAP[sessionStatus] ?? "unknown";
  if (agentStatus !== "idle" && agentStatus !== "error") return { agentStatus, error: null, abortReason: null };
  if (lastEnd?.isError && /^aborted by user$/i.test(lastEnd.text.trim())) {
    return { agentStatus: "aborted", error: null, abortReason: "aborted by user", abortedAt: lastEnd.at ?? null };
  }
  if (lastEnd?.isError) {
    // "resets 12am" is relative to when the error was written, not to now.
    const at = Date.parse(lastEnd.at ?? "");
    const classified = classifyErrorText(lastEnd.text, new Date(Number.isFinite(at) ? at : now)) ?? { kind: "other", resetAt: null };
    const error = { kind: classified.kind, text: clampText(redactSecrets(lastEnd.text), excerptMax), resetAt: classified.resetAt };
    return { agentStatus: "error", error, abortReason: null };
  }
  if (agentStatus === "error") return { agentStatus, error: { kind: "other", text: "session error", resetAt: null }, abortReason: null };
  return { agentStatus, error: null, abortReason: null };
}

// Per workspace: how many visible sessions (tabs) it has, and how many share
// each tab title. Computer-use delivery needs the tab title to tell tabs apart.
function sessionTitleKey(title) {
  const text = String(title ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return text && text !== "untitled" ? text : null;
}

function workspaceTabs(rows) {
  const out = new Map();
  for (const { row } of rows) {
    const id = row.workspace_local_id;
    if (!id) continue;
    const entry = out.get(id) ?? { count: 0, titles: new Map() };
    entry.count += 1;
    const key = sessionTitleKey(row.title);
    if (key) entry.titles.set(key, (entry.titles.get(key) ?? 0) + 1);
    out.set(id, entry);
  }
  return out;
}

// A call can only still block on the owner while the process that made it
// lives: no live peer, or one started after the call, means it died with it.
function askOutlivedBy(ask, peer) {
  if (!peer) return false;
  const since = Date.parse(peer.startedAt ?? "");
  return !(Number.isFinite(since) && Date.parse(ask.at ?? "") < since);
}

function readCardState(db, row, { limits, now, peers, turnColumn }) {
  const rows = readRecentMessages(db, row.id, turnColumn);
  const summary = summarizeTail(rows);
  const claudeSessionId = row.claude_session_id || null;
  const peer = peers.get(claudeSessionId ?? row.id) ?? peers.get(row.id) ?? null;
  // An errored session lost its card, so it reads as stopped instead. Only a
  // turn whose start and end are both outside the tail can hide one.
  const live = !CARD_DEAD_STATUSES.has(row.status);
  let asks = live ? [...summary.pendingAsks.values()] : [];
  if (live && !summary.turnStartedAt && !summary.lastEnd) {
    // Older calls of the turn join the ones the tail found; a tail card is never dropped.
    const inTail = new Set(asks.map((ask) => ask.id));
    asks = [...readOlderAsks(db, row.id, rows).filter((ask) => !inTail.has(ask.id)), ...asks];
  }
  // Idle is ambiguous. Older Conductor reports an AskUserQuestion wait as
  // idle, but a process that died mid-call leaves the same rows (600a2afc).
  // Only a live process that was already running at the call still holds it.
  if (row.status === "idle") asks = asks.filter((ask) => askOutlivedBy(ask, peer));
  // A process that died mid-card leaves its row "working". A peer started
  // after the call, or none once the turn went silent, means the card died
  // with it; no peer while rows still arrive is unknown, so the card stays.
  else if (row.status === "working" && (peer || now - Date.parse(summary.lastAt ?? "") >= limits.silentTurnMs)) {
    asks = asks.filter((ask) => askOutlivedBy(ask, peer));
  }
  const card = cardOf(asks, limits);
  return { rows, summary, claudeSessionId, peer, asks, card };
}

function buildThread(db, row, { config, now, peers, sinceIso, stale, tabs = null, turnColumn = "NULL AS turn_id", prompts = firstPrompts, dbFile = "", cardState = null }) {
  const { limits } = config;
  const { rows, summary, claudeSessionId, peer, asks, card } = cardState ?? readCardState(db, row, { limits, now, peers, turnColumn });
  summary.firstUserText = firstPromptOf(db, row.id, rows, summary, prompts, `${dbFile}\n${row.id}`);
  // The agent's own call first, as before cards (executor and older readers).
  const pendingAsk = asks.find((ask) => !ask.subagent) ?? asks[0] ?? null;
  // A process on a permission prompt or dialog is mid-turn, whatever the last result said.
  const blockedOnOwner = peerBlockedOnOwner(peer);
  const { agentStatus: reported, error, abortReason, abortedAt = null } = blockedOnOwner
    ? { agentStatus: "waiting", error: null, abortReason: null }
    : statusAndError(row.status, summary.lastEnd, now, limits.excerptMax);
  // Only running or waiting sessions still own background tasks, and only
  // those started by the live process: conductor.db never records the ones
  // killed with an earlier process.
  const openTasks = reported === "waiting" || reported === "running"
    ? liveTasks(readOpenTasks(db, row.id, sinceIso), peer)
    : [];
  // Conductor keeps a hung turn "working" for hours. With no transcript row
  // for that long it is a wait on its tasks, or stalled like a silent Codex turn.
  const silent = reported === "running" && now - Date.parse(summary.lastAt ?? "") >= limits.silentTurnMs;
  const agentStatus = silent ? (openTasks.length ? "waiting" : "stalled") : reported;
  const excerpt = (text) => clampText(redactSecrets(text), limits.excerptMax);
  const title = row.title && row.title !== "Untitled" ? row.title : row.pr_title || row.directory_name || row.id;
  const selfIds = config.selfSessionIds ?? [];
  const ownPrompt = isSupervisorOwnPrompt(row.title) || isSupervisorOwnPrompt(summary.firstUserText);
  const excluded = ownPrompt || selfIds.includes(row.id) || (claudeSessionId && selfIds.includes(claudeSessionId)) ? "self"
    : !row.workspace_path ? "no-repo"
    : stale ? "stale"
    : null;
  return {
    key: threadKey("conductor", row.id),
    kind: "conductor",
    id: row.id,
    title: clampText(redactSecrets(title), limits.titleMax),
    cwd: row.workspace_path || null,
    // repos.remote_url is null for bbapp and points at the wrong repo for
    // others on the owner's machine; the supervisor reads origin from git.
    repo: null,
    branch: row.branch || null,
    workspace: row.directory_name || null,
    claudeSessionId,
    agentStatus,
    // sessions.updated_at moves on any row update (unread count, broadcasts),
    // so it only stands in for a tab with no turn rows.
    lastActivityAt: summary.lastAt ?? dbTimeToIso(row.updated_at),
    lastAgentText: clampTail(redactSecrets(summary.lastAgentText), limits.excerptMax),
    lastAgentTail: clampTail(redactSecrets(summary.lastAgentText), limits.reviewTailMax),
    lastAgentFull: clampTailLines(redactSecrets(summary.fullText), limits.fullTextMax),
    lastAgentFullAt: summary.fullAt,
    lastAgentAt: summary.lastAgentAt,
    lastUserText: excerpt(summary.lastUserText),
    lastUserAt: summary.lastUserAt,
    error,
    openTasks,
    prRefs: [],
    live: peer ? { peerName: peer.peerName, pid: peer.pid, status: peer.status } : null,
    writerLocked: false,
    archived: false,
    excluded,
    meta: {
      model: summary.model ?? row.model ?? null,
      file: null,
      turnStartedAt: summary.turnStartedAt ?? summary.lastUserAt,
      abortReason,
      abortedAt,
      lastSupervisorAt: summary.lastSupervisorAt,
      blockedOnOwner,
      pendingQuestion: pendingAsk
        ? { text: clampText(redactSecrets(pendingAsk.text), limits.bodyMax), options: pendingAsk.options.map((option) => clampText(redactSecrets(option), limits.bodyMax)), at: pendingAsk.at }
        : null,
      pendingCard: card,
      // The PRs the chat created ("owner/repo#n"), newest first. The
      // workspace branch alone goes stale: cape-town sat on merged #6817
      // while its subagents opened #7089, #7343 and #7573 from other branches.
      prCreated: readCreatedPrs(db, row.id, config.paths?.conductorDb, rows[0]?.sent_at ?? null),
      waitingFor: peer?.waitingFor ?? null,
      conductorStatus: row.status ?? null,
      derivedStatus: row.derived_status ?? null,
      unreadCount: Number(row.unread_count) || 0,
      activeTab: row.active_session_id === row.id,
      prTitle: row.pr_title ?? null,
      dbRemote: repoFromRemote(row.remote_url),
      conductorHosted: true,
      // conductor://workspace?id=<workspace local_id>&session=<sessions.id>
      conductorWorkspaceId: row.workspace_local_id || null,
      conductorSessionId: row.id,
      // The tab's own title (null when untitled) and its siblings, so the
      // computer-use route can prove which tab is open.
      conductorSessionTitle: sessionTitleKey(row.title) ? clampText(redactSecrets(row.title), limits.titleMax) : null,
      conductorWorkspaceSessions: tabs?.count ?? null,
      conductorTitleShared: Boolean(sessionTitleKey(row.title) && (tabs?.titles.get(sessionTitleKey(row.title)) ?? 0) > 1)
    }
  };
}

function matchesRef(ref, { id, claudeSessionId, workspace }) {
  if (!ref) return false;
  if (id === ref || claudeSessionId === ref || workspace === ref) return true;
  return ref.length >= MIN_REF_PREFIX && typeof id === "string" && id.startsWith(ref);
}

export async function listConductorThreads(config, options = {}) {
  const file = config?.paths?.conductorDb;
  // No Conductor install is an empty list. An unreadable database throws, so
  // the supervisor records a source error instead of seeing zero threads.
  if (!file || !fs.existsSync(file)) return [];
  const db = await openReadOnlyDb(file);
  if (!db) throw new Error("Conductor database unavailable");
  try {
    const { now = Date.now(), isPidAlive = defaultIsPidAlive } = options;
    const cutoff = now - config.lookbackHours * 3_600_000;
    const sinceIso = new Date(cutoff).toISOString();
    const ref = String(config.managerRef ?? "").trim();
    const rows = db.prepare(SESSIONS_SQL).all().map((row) => ({ row, updatedMs: Date.parse(dbTimeToIso(row.updated_at) ?? "") }));
    const newestFirst = (a, b) => (b.updatedMs || 0) - (a.updatedMs || 0) || String(a.row.id).localeCompare(String(b.row.id));
    // options.only: just these sessions (a send-time re-read), whatever their age.
    const only = Array.isArray(options.only) ? new Set(options.only) : null;
    const ranked = rows.filter((entry) => (only ? only.has(entry.row.id) : entry.updatedMs >= cutoff)).sort(newestFirst);
    const recent = ranked.slice(0, config.limits.maxThreads);
    const picked = new Set(recent.map((entry) => entry.row.id));
    // The BuildBot3 manager stays visible for escalation even when it is quiet.
    const manager = only ? [] : rows
      .filter((entry) => !picked.has(entry.row.id)
        && matchesRef(ref, { id: entry.row.id, claudeSessionId: entry.row.claude_session_id, workspace: entry.row.directory_name }))
      .sort(newestFirst)
      .slice(0, MAX_STALE_MANAGER_ROWS);
    const peers = options.peers ?? readLivePeers(config, { isPidAlive });
    const tabs = workspaceTabs(rows);
    // Older Conductor builds have no turn_id; the tail then stands alone.
    const turnColumn = db.prepare("PRAGMA table_info(session_messages)").all().some((column) => column.name === "turn_id") ? "turn_id" : "NULL AS turn_id";
    const threads = [];
    for (const [list, stale] of [[recent, false], [manager, true]]) {
      for (const { row } of list) {
        // A query failure means the source is unknown this tick. Returning a
        // partial catalog would close questions from sessions we failed to read.
        threads.push(buildThread(db, row, { config, now, peers, sinceIso, stale, tabs: tabs.get(row.workspace_local_id) ?? null, turnColumn, prompts: options.firstPrompts ?? firstPrompts, dbFile: file }));
      }
    }
    // The catalog cap bounds ordinary rows, not questions that still need
    // the owner. Check the remaining sessions inside the same lookback,
    // using the existing current-turn/card-liveness checks. A later answer
    // removes the overflow row again; stale managers are not read twice.
    const included = new Map(threads.map((thread) => [thread.id, thread]));
    if (!only) for (const { row } of ranked.slice(config.limits.maxThreads)) {
      const existing = included.get(row.id);
      if (existing) {
        if (existing.excluded === "stale" && liveCardItems(existing.meta?.pendingCard, now).length) existing.excluded = null;
        continue;
      }
      if (CARD_DEAD_STATUSES.has(row.status)) continue;
      // Probe cards first: ordinary overflow sessions do not read tasks,
      // first-prompt history or created PRs on every Fleet tick.
      const cardState = readCardState(db, row, { limits: config.limits, now, peers, turnColumn });
      if (!liveCardItems(cardState.card, now).length) continue;
      threads.push(buildThread(db, row, { config, now, peers, sinceIso, stale: false, tabs: tabs.get(row.workspace_local_id) ?? null, turnColumn, prompts: options.firstPrompts ?? firstPrompts, dbFile: file, cardState }));
    }
    return threads;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

// Resolves config.managerRef (session id, Claude session id, id prefix, or
// workspace name). Prefers a Conductor thread, then a live one, then the newest.
export function findManagerSession(config, threads) {
  try {
    const ref = String(config?.managerRef ?? "").trim();
    if (!ref || !Array.isArray(threads)) return null;
    const matches = threads.filter((thread) => thread && matchesRef(ref, thread));
    if (!matches.length) return null;
    const rank = (thread) => [thread.kind === "conductor" ? 0 : 1, thread.live ? 0 : 1];
    matches.sort((a, b) => {
      const [ak, al] = rank(a);
      const [bk, bl] = rank(b);
      return ak - bk || al - bl || (Date.parse(b.lastActivityAt ?? "") || 0) - (Date.parse(a.lastActivityAt ?? "") || 0);
    });
    return matches[0];
  } catch {
    return null;
  }
}
