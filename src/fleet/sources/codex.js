// Codex threads from ~/.codex: the state_5.sqlite catalog, rollout tails,
// PR attachments, writer locks, and LB retry errors from logs_2.sqlite.
// Read-only. Every export degrades to [] instead of throwing.

import fs from "node:fs";
import path from "node:path";
import {
  clampText, openReadOnlyDb, parseJsonLines, parsePrRef, prRefKey, readTail, redactSecrets, repoFromRemote,
  runCommand, threadKey, toIso
} from "../contracts.js";
import { classifyCodexErrorCode } from "../errors.js";

const HOUR = 3_600_000;
const TAIL_BYTES = 1024 * 1024;
const AUTOMATION_SOURCES = new Set(["guardian_review", "subagent", "automation"]);
const HEARTBEAT_PATTERN = /<heartbeat>|<automation_id>/;
const SUPERVISOR_PREFIX = "[OpenAGI supervisor]";
const PR_URL_PATTERN = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/g;
const WRAPPER_TAGS = [
  "environment_context", "in-app-browser-context", "user_instructions", "user_shell_command", "turn_aborted", "subagent_notification"
];
const THREAD_COLUMNS = [
  "id", "rollout_path", "updated_at", "updated_at_ms", "source", "model_provider", "cwd", "title", "name",
  "archived", "git_branch", "git_origin_url", "model", "thread_source"
];

const LB_TARGET = "codex_core::responses_retry";
const LB_WINDOW_MS = HOUR;
const LB_RULES = [
  ["no-accounts", /No available accounts|all upstream accounts are unavailable|no_accounts/i],
  ["auth", /\b401\b|Unauthorized|Incorrect API key|invalid_api_key|Missing (?:environment variable|bearer)|CODEX_LB_API_KEY/i],
  ["usage-limit", /usage limit|usage_limit|usageLimitExceeded/i],
  ["unavailable", /\b50[0234]\b|Service Unavailable|Bad Gateway|Gateway Timeout|draining|cooling down|degraded mode|upstream_unavailable/i],
  ["connection", /Connection failed|error sending request|stream disconnected|timed out|timeout|Connection (?:reset|closed)|Transport error|network error|os error/i]
];

function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// ---------- rollout tail parsing ----------

// Removes the wrappers Codex Desktop puts around typed text: ambient browser
// and environment blocks, and everything before the "## My request" header.
export function cleanCodexUserText(raw) {
  let text = String(raw ?? "");
  const marker = /##\s*My request(?: for Codex)?:\s*/gi;
  let last = null;
  for (let match = marker.exec(text); match; match = marker.exec(text)) last = match;
  if (last) text = text.slice(last.index + last[0].length);
  for (const tag of WRAPPER_TAGS) text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "g"), " ");
  return text.trim();
}

function atMs(at) {
  const ms = Date.parse(at ?? "");
  return Number.isFinite(ms) ? ms : 0;
}

function addPrRefs(summary, text, at) {
  for (const match of String(text ?? "").matchAll(PR_URL_PATTERN)) {
    summary.prRefs.push({ ref: prRefKey(`${match[1]}/${match[2]}`, Number(match[3])), at: atMs(at) });
  }
}

// Exec-cell tool calls embed attach_artifact inside JavaScript; only the URL
// right after each call counts, not every link in the script.
function addAttachRefs(summary, text, at) {
  const source = String(text ?? "");
  for (let index = source.indexOf("attach_artifact"); index >= 0; index = source.indexOf("attach_artifact", index + 1)) {
    const match = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/.exec(source.slice(index, index + 600));
    if (match) summary.prRefs.push({ ref: prRefKey(`${match[1]}/${match[2]}`, Number(match[3])), at: atMs(at) });
  }
}

function contentText(content, types) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && types.includes(part.type) && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function setAgent(summary, text, at) {
  if (typeof text === "string" && text.trim()) summary.lastAgent = { text, at };
}

function readUserInput(summary, raw, at) {
  const text = String(raw ?? "");
  if (!text.trim()) return;
  summary.pendingQuestion = null;
  if (text.trimStart().startsWith(SUPERVISOR_PREFIX)) {
    summary.lastSupervisorAt = at;
    return;
  }
  if (HEARTBEAT_PATTERN.test(text)) {
    summary.lastInputHeartbeat = true;
    return;
  }
  summary.lastInputHeartbeat = false;
  addPrRefs(summary, text, at);
  const cleaned = cleanCodexUserText(text);
  if (cleaned) summary.lastUser = { text: cleaned, at };
}

function questionTitle(args) {
  try {
    const parsed = typeof args === "string" ? JSON.parse(args) : args;
    const first = parsed?.questions?.[0];
    return String(first?.title ?? first?.question ?? "").trim() || null;
  } catch {
    return null;
  }
}

function readItem(summary, item, at) {
  if (!item || typeof item !== "object") return;
  if (item.type === "AgentMessage") setAgent(summary, contentText(item.content, ["Text", "text"]), at);
  else if (item.type === "UserMessage") readUserInput(summary, contentText(item.content, ["text", "Text"]), at);
  else if (item.type === "McpToolCall" && item.tool === "attach_artifact") addPrRefs(summary, item.arguments?.url, at);
}

function readEvent(summary, payload, at) {
  switch (payload.type) {
    case "task_started":
      summary.lifecycle = { type: "task_started", payload, at };
      summary.turnStartedAt = toIso(payload.started_at) ?? at;
      break;
    case "task_complete":
      summary.lifecycle = { type: "task_complete", payload, at };
      setAgent(summary, payload.last_agent_message, at);
      break;
    case "turn_aborted":
    case "error":
      summary.lifecycle = { type: payload.type, payload, at };
      break;
    case "agent_message":
      setAgent(summary, payload.message, at);
      break;
    case "user_message":
      readUserInput(summary, payload.message, at);
      break;
    case "item_completed":
      readItem(summary, payload.item, at);
      break;
    default:
      break;
  }
}

// response_item user rows are mostly injected context (environment,
// AGENTS.md), so only event_msg rows count as owner input.
function readResponseItem(summary, payload, at) {
  if (payload.type === "message" && payload.role === "assistant") {
    setAgent(summary, contentText(payload.content, ["output_text"]), at);
  } else if (payload.type === "function_call") {
    const name = String(payload.name ?? "");
    if (name === "request_user_input_async") summary.pendingQuestion = questionTitle(payload.arguments) ?? summary.pendingQuestion;
    else if (name.includes("attach_artifact")) addPrRefs(summary, payload.arguments, at);
  } else if (payload.type === "custom_tool_call" && String(payload.input ?? "").includes("attach_artifact")) {
    addAttachRefs(summary, payload.input, at);
  }
}

export function parseRolloutTail(text) {
  const summary = {
    events: 0, lifecycle: null, turnStartedAt: null, lastAgent: null, lastUser: null,
    lastInputHeartbeat: false, lastSupervisorAt: null, pendingQuestion: null, prRefs: []
  };
  for (const row of parseJsonLines(text)) {
    const payload = row?.payload;
    if (!payload || typeof payload !== "object") continue;
    const at = toIso(row.timestamp);
    if (row.type === "event_msg") {
      summary.events += 1;
      readEvent(summary, payload, at);
    } else if (row.type === "response_item") {
      summary.events += 1;
      readResponseItem(summary, payload, at);
    }
  }
  return summary;
}

// ---------- thread assembly ----------

function sourceIsSubagent(source) {
  if (!source || !String(source).trim().startsWith("{")) return false;
  try {
    const parsed = JSON.parse(source);
    return Boolean(parsed && typeof parsed === "object" && "subagent" in parsed);
  } catch {
    return false;
  }
}

function metadataExclusion(row, config) {
  if (Number(row.archived) === 1) return "archived";
  if (AUTOMATION_SOURCES.has(row.thread_source) || sourceIsSubagent(row.source)) return "automation";
  if (HEARTBEAT_PATTERN.test(String(row.first_user_head ?? ""))) return "automation";
  if ((config.selfSessionIds ?? []).includes(String(row.id))) return "self";
  return null;
}

function scopeExclusion(thread) {
  if (!thread.cwd || !fs.existsSync(thread.cwd)) return "no-repo";
  if (!thread.repo && !thread.branch && thread.prRefs.length === 0) return "no-repo";
  return null;
}

// Codex stores structured errors under several shapes: a snake/camel string
// or an object keyed by the code ({ http_connection_failed: {...} }).
function errorCode(info) {
  if (typeof info === "string") return info;
  if (info && typeof info === "object") return Object.keys(info)[0] ?? null;
  return null;
}

function errorFor(lifecycle, now, limits) {
  const { type, payload } = lifecycle ?? {};
  let source = null;
  if (type === "task_complete" && payload.error) source = payload.error;
  else if (type === "error") source = payload;
  if (!source) return null;
  const message = typeof source === "string" ? source : String(source.message ?? "");
  const code = typeof source === "string" ? null : errorCode(source.codex_error_info ?? source.codexErrorInfo);
  const classified = classifyCodexErrorCode(code, message, new Date(now)) ?? { kind: "other", resetAt: null };
  return { kind: classified.kind, text: clampText(redactSecrets(message), limits.excerptMax), resetAt: classified.resetAt ?? null };
}

function statusFor(summary, mtimeMs, now, limits) {
  const type = summary.lifecycle?.type;
  if (type === "task_complete") return summary.lifecycle.payload.error ? "error" : "idle";
  if (type === "turn_aborted") return "aborted";
  if (type === "error") return "error";
  if (summary.events === 0 || mtimeMs === null) return "unknown";
  // No finished turn after the last start: in progress, or killed mid-turn.
  return now - mtimeMs <= limits.runningWindowMs ? "running" : "stalled";
}

function applyRollout(thread, row, context) {
  const { config, now, tailBytes } = context;
  const limits = config.limits;
  let mtimeMs = null;
  try {
    mtimeMs = fs.statSync(row.rollout_path).mtimeMs;
  } catch {
    return [];
  }
  const summary = parseRolloutTail(readTail(row.rollout_path, tailBytes));
  const updatedMs = Date.parse(thread.lastActivityAt ?? "");
  thread.lastActivityAt = toIso(Math.max(mtimeMs, Number.isFinite(updatedMs) ? updatedMs : 0));
  thread.agentStatus = statusFor(summary, mtimeMs, now, limits);
  thread.error = errorFor(summary.lifecycle, now, limits);
  if (summary.lastAgent) {
    thread.lastAgentText = clampText(redactSecrets(summary.lastAgent.text), limits.excerptMax);
    thread.lastAgentAt = summary.lastAgent.at;
  }
  if (summary.lastUser) {
    thread.lastUserText = clampText(redactSecrets(summary.lastUser.text), limits.excerptMax);
    thread.lastUserAt = summary.lastUser.at;
  }
  thread.meta.turnStartedAt = summary.turnStartedAt;
  thread.meta.abortReason = summary.lifecycle?.type === "turn_aborted" ? (summary.lifecycle.payload.reason ?? null) : null;
  thread.meta.lastSupervisorAt = summary.lastSupervisorAt;
  thread.meta.pendingQuestion = summary.pendingQuestion
    ? clampText(redactSecrets(summary.pendingQuestion), limits.bodyMax)
    : null;
  // A Codex heartbeat automation already drives this thread; nudging it too
  // would double up.
  if (summary.lastInputHeartbeat) {
    thread.excluded = "automation";
    thread.meta.heartbeat = true;
  }
  return summary.prRefs;
}

function orderPrRefs(entries) {
  const sorted = [...entries].sort((a, b) => b.at - a.at);
  return [...new Set(sorted.map((entry) => entry.ref))];
}

function buildThread(row, context) {
  const { config, attachments } = context;
  const limits = config.limits;
  const id = String(row.id);
  const updatedMs = Number(row.updated_at_ms) || Number(row.updated_at) * 1000 || null;
  const thread = {
    key: threadKey("codex", id),
    kind: "codex",
    id,
    title: clampText(redactSecrets(row.name || row.title || `Codex ${id.slice(0, 8)}`), limits.titleMax),
    cwd: row.cwd ? String(row.cwd) : null,
    repo: repoFromRemote(row.git_origin_url),
    branch: row.git_branch || null,
    workspace: null,
    claudeSessionId: null,
    agentStatus: "unknown",
    lastActivityAt: toIso(updatedMs),
    lastAgentText: "",
    lastAgentAt: null,
    lastUserText: "",
    lastUserAt: null,
    error: null,
    openTasks: [],
    prRefs: [],
    live: null,
    writerLocked: false,
    archived: Number(row.archived) === 1,
    excluded: metadataExclusion(row, config),
    meta: {
      model: row.model || null,
      provider: row.model_provider || null,
      threadSource: row.thread_source || null,
      file: row.rollout_path || null,
      turnStartedAt: null,
      abortReason: null,
      lastSupervisorAt: null,
      pendingQuestion: null,
      heartbeat: false
    }
  };
  // Excluded-by-metadata threads (mostly guardian reviews) skip the tail read.
  const rolloutRefs = thread.excluded ? [] : applyRollout(thread, row, context);
  thread.prRefs = orderPrRefs([...(attachments.get(id) ?? []), ...rolloutRefs]);
  if (!thread.repo && thread.prRefs.length > 0) thread.repo = parsePrRef(thread.prRefs[0])?.repo ?? null;
  if (!thread.excluded) thread.excluded = scopeExclusion(thread);
  return thread;
}

function readThreadRows(db, sinceMs, limit) {
  const present = new Set(db.prepare("PRAGMA table_info(threads)").all().map((column) => column.name));
  if (!present.has("id") || !present.has("updated_at")) return [];
  const select = THREAD_COLUMNS.map((name) => (present.has(name) ? name : `NULL AS ${name}`));
  select.push(present.has("first_user_message") ? "substr(first_user_message, 1, 400) AS first_user_head" : "NULL AS first_user_head");
  return db.prepare(`SELECT ${select.join(", ")} FROM threads WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT ?`)
    .all(Math.floor(sinceMs / 1000), limit);
}

function prRefFromAttachment(row) {
  try {
    const url = JSON.parse(row.payload)?.url;
    const match = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/.exec(String(url ?? ""));
    if (match) return prRefKey(`${match[1]}/${match[2]}`, Number(match[3]));
  } catch { /* fall through to the identity key */ }
  try {
    const [host, owner, repo, number] = JSON.parse(row.identity_key);
    if (host === "github.com" && owner && repo && Number(number) > 0) return prRefKey(`${owner}/${repo}`, Number(number));
  } catch { /* unknown shape */ }
  return null;
}

// Codex Desktop records attach_artifact PRs here, so it survives rollouts
// far larger than any tail we read.
function readPrAttachments(db, ids) {
  const out = new Map();
  if (ids.length === 0) return out;
  try {
    const rows = db.prepare(`SELECT thread_id, identity_key, payload, created_at FROM thread_attachments
      WHERE attachment_type = 'pull_request' AND thread_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids));
    for (const row of rows) {
      const ref = prRefFromAttachment(row);
      if (!ref) continue;
      if (!out.has(row.thread_id)) out.set(row.thread_id, []);
      out.get(row.thread_id).push({ ref, at: Number(row.created_at) * 1000 || 0 });
    }
  } catch { /* older Codex without the attachments table */ }
  return out;
}

// Lock files are 0-byte flock targets with no pid inside, so the holder
// comes from one batched lsof. Codex removes them on release; when lsof
// cannot answer, a present lock file is treated as held.
async function readWriterLocks(config, ids, { run, isPidAlive }) {
  const dir = path.join(config.paths.codexHome, "thread-writer-locks");
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return new Set();
  }
  const wanted = new Set(ids);
  const files = names
    .filter((name) => name.endsWith(".lock") && wanted.has(name.slice(0, -5)))
    .map((name) => path.join(dir, name));
  if (files.length === 0) return new Set();
  let result = null;
  try {
    result = await run(config.bins.lsof, ["-F", "pn", "--", ...files], { timeoutMs: 10_000 });
  } catch {
    result = null;
  }
  const locked = new Set();
  if (!result || result.error || result.timedOut || (result.code !== 0 && result.code !== 1)) {
    for (const file of files) locked.add(path.basename(file, ".lock"));
    return locked;
  }
  let pid = null;
  for (const line of String(result.stdout ?? "").split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && Number.isFinite(pid) && isPidAlive(pid)) locked.add(path.basename(line.slice(1), ".lock"));
  }
  return locked;
}

function capThreads(threads, max) {
  const inScope = threads.filter((thread) => !thread.excluded).slice(0, max);
  const room = Math.max(0, max - inScope.length);
  const keep = new Set([...inScope, ...threads.filter((thread) => thread.excluded).slice(0, room)]);
  return threads.filter((thread) => keep.has(thread));
}

export async function listCodexThreads(config, options = {}) {
  const now = options.now ?? Date.now();
  const run = options.run ?? runCommand;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const limits = config.limits;
  try {
    const db = await openReadOnlyDb(path.join(config.paths.codexHome, "state_5.sqlite"));
    if (!db) return [];
    let rows;
    let attachments;
    try {
      // Guardian reviews dominate the catalog; fetch extra so the cap below
      // never drops a real thread in favour of an excluded one.
      rows = readThreadRows(db, now - config.lookbackHours * HOUR, limits.maxThreads * 5);
      attachments = readPrAttachments(db, rows.map((row) => String(row.id)));
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
    const context = { config, now, attachments, tailBytes: options.tailBytes ?? TAIL_BYTES };
    const threads = capThreads(rows.map((row) => buildThread(row, context)), limits.maxThreads);
    const locked = await readWriterLocks(config, threads.map((thread) => thread.id), { run, isPidAlive });
    for (const thread of threads) thread.writerLocked = locked.has(thread.id);
    return threads;
  } catch {
    return [];
  }
}

// ---------- LB retry errors ----------

export function classifyLbError(text) {
  const source = String(text ?? "");
  const index = source.indexOf("error=");
  const detail = index >= 0 ? source.slice(index + "error=".length) : source;
  for (const [kind, pattern] of LB_RULES) if (pattern.test(detail)) return kind;
  return "other";
}

function retryThreadId(row) {
  if (row.thread_id) return String(row.thread_id);
  const match = /thread_id=([0-9a-f][0-9a-f-]{7,})/i.exec(String(row.feedback_log_body ?? ""));
  return match ? match[1] : null;
}

export async function readCodexLbErrors(config, options = {}) {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? LB_WINDOW_MS;
  try {
    const db = await openReadOnlyDb(path.join(config.paths.codexHome, "logs_2.sqlite"));
    if (!db) return [];
    let rows;
    try {
      rows = db.prepare(`SELECT ts, thread_id, feedback_log_body FROM logs
        WHERE ts >= ? AND target = ? ORDER BY ts DESC LIMIT 5000`).all(Math.floor((now - windowMs) / 1000), LB_TARGET);
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
    const groups = new Map();
    for (const row of rows) {
      const kind = classifyLbError(row.feedback_log_body);
      const group = groups.get(kind) ?? { kind, count: 0, lastAtSec: 0, threadIds: new Set() };
      group.count += 1;
      group.lastAtSec = Math.max(group.lastAtSec, Number(row.ts) || 0);
      const id = retryThreadId(row);
      if (id) group.threadIds.add(id);
      groups.set(kind, group);
    }
    return [...groups.values()]
      .sort((a, b) => b.count - a.count || b.lastAtSec - a.lastAtSec)
      .map((group) => ({ kind: group.kind, count: group.count, lastAt: group.lastAtSec ? toIso(group.lastAtSec) : null, threadIds: [...group.threadIds] }));
  } catch {
    return [];
  }
}
