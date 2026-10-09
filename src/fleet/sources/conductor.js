// Conductor sessions from conductor.db, opened read-only. Assistant rows in
// session_messages hold one Claude Agent SDK stream event as JSON; user rows
// hold the plain text the owner typed.

import fs from "node:fs";
import { classifyErrorText } from "../errors.js";
import {
  SUPERVISOR_PREFIX, clampTail, clampText, isPidAlive as defaultIsPidAlive, openReadOnlyDb, redactSecrets, repoFromRemote,
  threadKey, toIso
} from "../contracts.js";
import { liveTasks, peerBlockedOnOwner, readLivePeers } from "./claude.js";

const STATUS_MAP = Object.freeze({ working: "running", waiting: "waiting", idle: "idle", error: "error" });
const TAIL_ROWS = 400;
const MAX_STALE_MANAGER_ROWS = 10;
const MIN_REF_PREFIX = 8;

const SESSIONS_SQL = `
  SELECT s.id, s.status, s.claude_session_id, s.title, s.model, s.updated_at, s.unread_count,
         w.local_id AS workspace_local_id, w.directory_name, w.branch, w.derived_status, w.workspace_path, w.pr_title, w.active_session_id,
         r.remote_url
  FROM sessions s
  JOIN workspaces w ON w.local_id = s.workspace_id
  LEFT JOIN repos r ON r.id = w.repository_id
  WHERE COALESCE(s.is_hidden, 0) = 0 AND COALESCE(w.state, '') != 'archived'`;

// (session_id, sent_at) is indexed, so these never scan a whole session.
const TAIL_SQL = `
  SELECT role, content, created_at, cancelled_at, sender_session_id, sender_api_key_name
  FROM session_messages WHERE session_id = ? ORDER BY sent_at DESC, rowid DESC LIMIT ?`;
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

function summarizeTail(rowsNewestFirst) {
  const summary = {
    lastUserText: "", lastUserAt: null, lastAgentText: "", lastAgentAt: null, lastEnd: null, model: null, lastAt: null, turnStartedAt: null,
    pendingAsk: null
  };
  for (const row of [...rowsNewestFirst].reverse()) {
    const at = dbTimeToIso(row.created_at);
    if (row.role === "user") {
      summary.lastAt = latestIso(summary.lastAt, at);
      // Cancelled drafts and messages from other sessions or API keys are not the owner.
      if (row.cancelled_at || row.sender_session_id || row.sender_api_key_name) continue;
      const text = String(row.content ?? "").trim();
      if (text && !text.startsWith(SUPERVISOR_PREFIX)) {
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
      summary.pendingAsk = null;
    }
    else if (event.type === "assistant" && !event.parent_tool_use_id) {
      if (typeof event.message?.model === "string") summary.model = event.message.model;
      const ask = askUserQuestion(event, at);
      if (ask) summary.pendingAsk = ask;
      const text = eventText(event);
      if (text) {
        summary.lastAgentText = text;
        summary.lastAgentAt = at;
      }
    } else if (event.type === "result") {
      const errors = Array.isArray(event.errors) ? event.errors.join("; ") : "";
      // Limit errors arrive as subtype "success" with is_error set.
      const isError = event.is_error === true || event.is_error === 1;
      summary.lastEnd = { isError, text: String(event.result ?? "") || errors, at };
      if (!isError && !summary.lastAgentText && event.result) {
        summary.lastAgentText = String(event.result);
        summary.lastAgentAt = at;
      }
    } else if (event.type === "error") {
      summary.lastEnd = { isError: true, text: String(event.content ?? ""), at };
    } else if (event.type === "user" && summary.pendingAsk && answersTool(event, summary.pendingAsk.id)) {
      summary.pendingAsk = null;
    }
  }
  return summary;
}

// Conductor's AskUserQuestion: the turn waits on the owner's pick while the
// session reads "idle", and the question is in the tool call, not the text.
function askUserQuestion(event, at) {
  const content = Array.isArray(event.message?.content) ? event.message.content : [];
  const call = content.find((block) => block?.type === "tool_use" && /AskUserQuestion$/.test(String(block.name ?? "")));
  const questions = Array.isArray(call?.input?.questions) ? call.input.questions.filter((q) => q && typeof q.question === "string") : [];
  if (!call?.id || !questions.length) return null;
  // The pick is a widget in Conductor: typed text does not answer it, so the
  // choices ride in the text and the owner answers in the app.
  const choices = (q) => (Array.isArray(q.options) ? q.options : [])
    .map((option) => (typeof option === "string" ? option : option?.label))
    .filter((option) => typeof option === "string" && option.trim());
  const text = questions.map((q) => (choices(q).length ? `${q.question.trim()} (${choices(q).join(" / ")})` : q.question.trim())).join(" / ");
  return { id: String(call.id), at, text, options: [] };
}

function answersTool(event, id) {
  const content = Array.isArray(event.message?.content) ? event.message.content : [];
  return content.some((block) => block?.type === "tool_result" && String(block.tool_use_id ?? "") === id);
}

function readRecentMessages(db, sessionId) {
  return db.prepare(TAIL_SQL).all(sessionId, TAIL_ROWS);
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

function buildThread(db, row, { config, now, peers, sinceIso, stale, tabs = null }) {
  const { limits } = config;
  const summary = summarizeTail(readRecentMessages(db, row.id));
  const claudeSessionId = row.claude_session_id || null;
  const peer = peers.get(claudeSessionId ?? row.id) ?? peers.get(row.id) ?? null;
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
  const excluded = selfIds.includes(row.id) || (claudeSessionId && selfIds.includes(claudeSessionId)) ? "self"
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
      blockedOnOwner,
      pendingQuestion: summary.pendingAsk
        ? { text: clampText(redactSecrets(summary.pendingAsk.text), limits.bodyMax), options: summary.pendingAsk.options.map((option) => clampText(redactSecrets(option), limits.bodyMax)), at: summary.pendingAsk.at }
        : null,
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
    const recent = rows.filter((entry) => (only ? only.has(entry.row.id) : entry.updatedMs >= cutoff)).sort(newestFirst).slice(0, config.limits.maxThreads);
    const picked = new Set(recent.map((entry) => entry.row.id));
    // The BuildBot3 manager stays visible for escalation even when it is quiet.
    const manager = only ? [] : rows
      .filter((entry) => !picked.has(entry.row.id)
        && matchesRef(ref, { id: entry.row.id, claudeSessionId: entry.row.claude_session_id, workspace: entry.row.directory_name }))
      .sort(newestFirst)
      .slice(0, MAX_STALE_MANAGER_ROWS);
    const peers = options.peers ?? readLivePeers(config, { isPidAlive });
    const tabs = workspaceTabs(rows);
    const threads = [];
    for (const [list, stale] of [[recent, false], [manager, true]]) {
      for (const { row } of list) {
        // A query failure means the source is unknown this tick. Returning a
        // partial catalog would close questions from sessions we failed to read.
        threads.push(buildThread(db, row, { config, now, peers, sinceIso, stale, tabs: tabs.get(row.workspace_local_id) ?? null }));
      }
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
