// Conductor sessions from conductor.db, opened read-only. Assistant rows in
// session_messages hold one Claude Agent SDK stream event as JSON; user rows
// hold the plain text the owner typed.

import { classifyErrorText } from "../errors.js";
import { clampText, openReadOnlyDb, redactSecrets, repoFromRemote, threadKey, toIso } from "../contracts.js";
import { SUPERVISOR_PREFIX, defaultIsPidAlive, readLivePeers } from "./claude.js";

const STATUS_MAP = Object.freeze({ working: "running", waiting: "waiting", idle: "idle", error: "error" });
const TAIL_ROWS = 400;
const MAX_STALE_MANAGER_ROWS = 10;
const MIN_REF_PREFIX = 8;

const SESSIONS_SQL = `
  SELECT s.id, s.status, s.claude_session_id, s.title, s.model, s.updated_at, s.unread_count,
         w.directory_name, w.branch, w.derived_status, w.workspace_path, w.pr_title, w.active_session_id,
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
    lastUserText: "", lastUserAt: null, lastAgentText: "", lastAgentAt: null, lastEnd: null, model: null, lastAt: null, turnStartedAt: null
  };
  for (const row of [...rowsNewestFirst].reverse()) {
    const at = toIso(row.created_at);
    summary.lastAt = latestIso(summary.lastAt, at);
    if (row.role === "user") {
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
    // Every SDK turn opens with system/init.
    if (event.type === "system" && event.subtype === "init") summary.turnStartedAt = at;
    else if (event.type === "assistant" && !event.parent_tool_use_id) {
      if (typeof event.message?.model === "string") summary.model = event.message.model;
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
    }
  }
  return summary;
}

function readRecentMessages(db, sessionId) {
  try { return db.prepare(TAIL_SQL).all(sessionId, TAIL_ROWS); } catch { return []; }
}

// Background tasks = task_started with no matching task_notification.
function readOpenTasks(db, sessionId, sinceIso) {
  const open = new Map();
  let rows = [];
  try { rows = db.prepare(TASKS_SQL).all(sessionId, sinceIso); } catch { return []; }
  for (const row of rows) {
    const event = parseEvent(row.content);
    const taskId = event?.task_id ? String(event.task_id) : "";
    if (!taskId) continue;
    if (event.subtype === "task_started") {
      open.set(taskId, {
        id: taskId,
        description: clampText(redactSecrets(event.description ?? ""), 120),
        kind: String(event.task_type ?? "task"),
        startedAt: toIso(row.created_at)
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
    return { agentStatus: "aborted", error: null, abortReason: "aborted by user" };
  }
  if (lastEnd?.isError) {
    const classified = classifyErrorText(lastEnd.text, new Date(now)) ?? { kind: "other", resetAt: null };
    const error = { kind: classified.kind, text: clampText(redactSecrets(lastEnd.text), excerptMax), resetAt: classified.resetAt };
    return { agentStatus: "error", error, abortReason: null };
  }
  if (agentStatus === "error") return { agentStatus, error: { kind: "other", text: "session error", resetAt: null }, abortReason: null };
  return { agentStatus, error: null, abortReason: null };
}

function buildThread(db, row, { config, now, peers, sinceIso, stale }) {
  const { limits } = config;
  const summary = summarizeTail(readRecentMessages(db, row.id));
  const { agentStatus, error, abortReason } = statusAndError(row.status, summary.lastEnd, now, limits.excerptMax);
  // Only running or waiting sessions still own live background tasks.
  const openTasks = agentStatus === "waiting" || agentStatus === "running" ? readOpenTasks(db, row.id, sinceIso) : [];
  const claudeSessionId = row.claude_session_id || null;
  const peer = peers.get(claudeSessionId ?? row.id) ?? peers.get(row.id) ?? null;
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
    lastActivityAt: latestIso(dbTimeToIso(row.updated_at), summary.lastAt),
    lastAgentText: excerpt(summary.lastAgentText),
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
      conductorStatus: row.status ?? null,
      derivedStatus: row.derived_status ?? null,
      unreadCount: Number(row.unread_count) || 0,
      activeTab: row.active_session_id === row.id,
      prTitle: row.pr_title ?? null,
      dbRemote: repoFromRemote(row.remote_url),
      conductorHosted: true
    }
  };
}

function matchesRef(ref, { id, claudeSessionId, workspace }) {
  if (!ref) return false;
  if (id === ref || claudeSessionId === ref || workspace === ref) return true;
  return ref.length >= MIN_REF_PREFIX && typeof id === "string" && id.startsWith(ref);
}

export async function listConductorThreads(config, options = {}) {
  let db = null;
  try {
    const { now = Date.now(), isPidAlive = defaultIsPidAlive } = options;
    db = await openReadOnlyDb(config.paths.conductorDb);
    if (!db) return [];
    const cutoff = now - config.lookbackHours * 3_600_000;
    const sinceIso = new Date(cutoff).toISOString();
    const ref = String(config.managerRef ?? "").trim();
    const rows = db.prepare(SESSIONS_SQL).all().map((row) => ({ row, updatedMs: Date.parse(dbTimeToIso(row.updated_at) ?? "") }));
    const newestFirst = (a, b) => (b.updatedMs || 0) - (a.updatedMs || 0) || String(a.row.id).localeCompare(String(b.row.id));
    const recent = rows.filter((entry) => entry.updatedMs >= cutoff).sort(newestFirst).slice(0, config.limits.maxThreads);
    const picked = new Set(recent.map((entry) => entry.row.id));
    // The BuildBot3 manager stays visible for escalation even when it is quiet.
    const manager = rows
      .filter((entry) => !picked.has(entry.row.id)
        && matchesRef(ref, { id: entry.row.id, claudeSessionId: entry.row.claude_session_id, workspace: entry.row.directory_name }))
      .sort(newestFirst)
      .slice(0, MAX_STALE_MANAGER_ROWS);
    const peers = options.peers ?? readLivePeers(config, { isPidAlive });
    const threads = [];
    for (const [list, stale] of [[recent, false], [manager, true]]) {
      for (const { row } of list) {
        try {
          threads.push(buildThread(db, row, { config, now, peers, sinceIso, stale }));
        } catch {
          // One odd session never hides the rest.
        }
      }
    }
    return threads;
  } catch {
    return [];
  } finally {
    if (db) try { db.close(); } catch { /* ignore */ }
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
