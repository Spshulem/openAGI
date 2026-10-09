// Codex threads from ~/.codex: the state_5.sqlite catalog, rollout tails,
// PR attachments, writer locks, and LB retry errors from logs_2.sqlite.
// Read-only. Every export degrades to [] instead of throwing.

import fs from "node:fs";
import path from "node:path";
import {
  DEFAULTS, SUPERVISOR_PREFIX, clampTail, clampText, isPidAlive as defaultIsPidAlive, openReadOnlyDb, parseJsonLines, parsePrRef, prRefKey, readTail, redactSecrets, repoFromRemote,
  CONDUCTOR_CODEX_ORIGINATOR, runCommand, shortHash, threadKey, toIso
} from "../contracts.js";
import { asksOwner } from "../classify.js";
import { classifyCodexErrorCode } from "../errors.js";
import { identityToken } from "../ui-delivery.js";

const HOUR = 3_600_000;
const TAIL_BYTES = 1024 * 1024;
const AUTOMATION_SOURCES = new Set(["guardian_review", "subagent", "automation"]);
const HEARTBEAT_PATTERN = /<heartbeat>|<automation_id>/;
// Scheduled sweeps (usage-reset checks, chat watchdogs) run as codex exec;
// their status tables quote other chats' asks.
const EXEC_SOURCE = "exec";
const CHAT_CHECKER_PATTERN = /\bchecking the user['’]s existing agent chats\b/i;
// request_user_input titles are sometimes an encrypted blob ("gAAAAAB...").
const FERNET_PATTERN = /^gAAAAA[A-Za-z0-9_=-]{20,}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/_-]{80,}={0,2}$/;
const SEALED_QUESTION = "Codex asked in the app";
const PR_URL_PATTERN = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/g;
const WRAPPER_TAGS = [
  "environment_context", "in-app-browser-context", "user_instructions", "user_shell_command", "turn_aborted", "subagent_notification"
];
// Codex Desktop writes these when it reopens a thread; no turn runs.
const METADATA_EVENTS = new Set(["thread_settings_applied"]);
const THREAD_COLUMNS = [
  "id", "rollout_path", "updated_at", "updated_at_ms", "source", "model_provider", "cwd", "title", "name",
  "archived", "git_branch", "git_origin_url", "model", "thread_source", "originator"
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

// source "attachment" = the agent attached the PR; "owner" = a link in text the owner typed.
function addPrRefs(summary, text, at, source) {
  for (const match of String(text ?? "").matchAll(PR_URL_PATTERN)) {
    summary.prRefs.push({ ref: prRefKey(`${match[1]}/${match[2]}`, Number(match[3])), at: atMs(at), source, headBranch: null });
  }
}

// Exec-cell tool calls embed attach_artifact inside JavaScript; only the URL
// right after each call counts, not every link in the script.
function addAttachRefs(summary, text, at) {
  const source = String(text ?? "");
  for (let index = source.indexOf("attach_artifact"); index >= 0; index = source.indexOf("attach_artifact", index + 1)) {
    const match = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/.exec(source.slice(index, index + 600));
    if (match) summary.prRefs.push({ ref: prRefKey(`${match[1]}/${match[2]}`, Number(match[3])), at: atMs(at), source: "attachment", headBranch: null });
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
  if (typeof text !== "string" || !text.trim()) return;
  summary.lastAgent = { text, at };
  settleSealedAsk(summary);
}

// A sealed ask the agent talked past, or ended its turn on, was not waiting
// on the owner (#6896: "No additional user input is needed", then done),
// unless the words standing in for it ask something themselves.
function settleSealedAsk(summary) {
  if (summary.pendingQuestion?.sealed && !asksOwner(summary.pendingQuestion.text)) summary.pendingQuestion = null;
}

// Long slash paths fit the base64 alphabet too; a real blob is very long,
// or carries + or = and no path slash.
function isCiphertext(value) {
  if (FERNET_PATTERN.test(value)) return true;
  if (!BASE64_PATTERN.test(value)) return false;
  return value.length >= 200 || (/[+=]/.test(value) && !value.includes("/"));
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
  // Links inside the browser/IDE wrappers are ambient context, not the owner's words.
  const cleaned = cleanCodexUserText(text);
  addPrRefs(summary, cleaned, at, "owner");
  if (cleaned) summary.lastUser = { text: cleaned, at };
}

// fallback: the agent's last words, shown when the title is ciphertext.
// keyText: the raw title, when the text shown is not it. The question is
// keyed on it, so an owner's dismissal outlives a change in the stand-in.
function questionTitle(args, fallback) {
  try {
    const parsed = typeof args === "string" ? JSON.parse(args) : args;
    const first = parsed?.questions?.[0];
    const texts = [first?.title, first?.question].map((value) => String(value ?? "").trim()).filter(Boolean);
    if (!texts.length) return null;
    const text = texts.find((value) => !isCiphertext(value));
    const options = (first.options ?? []).map((option) => typeof option === "string" ? option : option?.label).filter(Boolean);
    // Multiple prompts and free text need the original thread's input surface.
    const supported = parsed.questions.length === 1 && options.length > 0 && options.length <= 4 && options.every((option) => option.length <= 40);
    const raw = text === texts[0] ? {} : { keyText: texts[0] };
    if (!text) return { text: fallback?.trim() || SEALED_QUESTION, options: supported ? options : ["open thread"], sealed: true, ...raw };
    return { text, options: supported ? options : ["open thread"], ...raw };
  } catch {
    return null;
  }
}

function readItem(summary, item, at) {
  if (!item || typeof item !== "object") return;
  if (item.type === "AgentMessage") setAgent(summary, contentText(item.content, ["Text", "text"]), at);
  else if (item.type === "UserMessage") readUserInput(summary, contentText(item.content, ["text", "Text"]), at);
  else if (item.type === "McpToolCall" && item.tool === "attach_artifact") addPrRefs(summary, item.arguments?.url, at, "attachment");
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
      settleSealedAsk(summary);
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
    if (name === "request_user_input_async") {
      // The ask time lets a PR merged after it close the question.
      const asked = questionTitle(payload.arguments, summary.lastAgent?.text);
      if (asked) summary.pendingQuestion = { ...asked, at };
    } else if (name.includes("attach_artifact")) addPrRefs(summary, payload.arguments, at, "attachment");
  } else if (payload.type === "custom_tool_call" && String(payload.input ?? "").includes("attach_artifact")) {
    addAttachRefs(summary, payload.input, at);
  }
}

export function parseRolloutTail(text) {
  const summary = {
    events: 0, lifecycle: null, turnStartedAt: null, lastAgent: null, lastUser: null,
    lastInputHeartbeat: false, lastSupervisorAt: null, pendingQuestion: null, prRefs: [], lastTurnAt: null
  };
  for (const row of parseJsonLines(text)) {
    const payload = row?.payload;
    if (!payload || typeof payload !== "object") continue;
    const at = toIso(row.timestamp);
    if (row.type === "event_msg") {
      summary.events += 1;
      readEvent(summary, payload, at);
      if (at && !METADATA_EVENTS.has(payload.type)) summary.lastTurnAt = at;
    } else if (row.type === "response_item") {
      summary.events += 1;
      readResponseItem(summary, payload, at);
      if (at) summary.lastTurnAt = at;
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
  if (String(row.source ?? "").trim() === EXEC_SOURCE) return "automation";
  const head = String(row.first_user_head ?? "");
  if (HEARTBEAT_PATTERN.test(head) || CHAT_CHECKER_PATTERN.test(head)) return "automation";
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
  // "Try again at 1:11 AM" is relative to when the error was written, not to now.
  const at = Date.parse(lifecycle.at ?? "");
  const classified = classifyCodexErrorCode(code, message, new Date(Number.isFinite(at) ? at : now)) ?? { kind: "other", resetAt: null };
  return { kind: classified.kind, text: clampText(redactSecrets(message), limits.excerptMax), resetAt: classified.resetAt ?? null };
}

function statusFor(summary, mtimeMs, now, limits) {
  const type = summary.lifecycle?.type;
  if (type === "task_complete") return summary.lifecycle.payload.error ? "error" : "idle";
  if (type === "turn_aborted") return "aborted";
  if (type === "error") return "error";
  if (summary.events === 0 || mtimeMs === null) return "unknown";
  // No finished turn after the last start: in progress, or killed mid-turn
  // (an app-server restart ends open turns without writing anything). Timed
  // from the last turn row: opening a dead thread writes settings rows that
  // bump the file, which must not make it look alive again.
  const turnMs = Date.parse(summary.lastTurnAt ?? "");
  return now - (Number.isFinite(turnMs) ? turnMs : mtimeMs) <= limits.runningWindowMs ? "running" : "stalled";
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
  // Settings writes bump the file and catalog times without a turn, so
  // those are only a fallback when the tail holds no turn row.
  thread.lastActivityAt = summary.lastTurnAt ?? toIso(Math.max(mtimeMs, Number.isFinite(updatedMs) ? updatedMs : 0));
  thread.agentStatus = statusFor(summary, mtimeMs, now, limits);
  thread.error = errorFor(summary.lifecycle, now, limits);
  if (summary.lastAgent) {
    thread.lastAgentText = clampTail(redactSecrets(summary.lastAgent.text), limits.excerptMax);
    thread.lastAgentTail = clampTail(redactSecrets(summary.lastAgent.text), limits.reviewTailMax);
    thread.lastAgentAt = summary.lastAgent.at;
  }
  if (summary.lastUser) {
    thread.lastUserText = clampText(redactSecrets(summary.lastUser.text), limits.excerptMax);
    thread.lastUserAt = summary.lastUser.at;
  }
  thread.meta.turnStartedAt = summary.turnStartedAt;
  const aborted = summary.lifecycle?.type === "turn_aborted";
  thread.meta.abortReason = aborted ? (summary.lifecycle.payload.reason ?? null) : null;
  thread.meta.abortedAt = aborted ? summary.lifecycle.at : null;
  thread.meta.lastSupervisorAt = summary.lastSupervisorAt;
  const pending = summary.pendingQuestion;
  // A stand-in from the agent's message ends on the ask, so keep its tail.
  const clampAsk = pending?.sealed ? clampTail : clampText;
  thread.meta.pendingQuestion = pending
    ? { text: clampAsk(redactSecrets(pending.text), limits.bodyMax), options: pending.options.map((option) => clampText(redactSecrets(option), limits.bodyMax)), at: pending.at ?? null }
    : null;
  // The key the raw title gave the ask before it had a stand-in (a hash of
  // the same clamped text), so a dismissal made then still matches.
  if (pending?.keyText) thread.meta.pendingQuestion.key = shortHash(clampText(redactSecrets(pending.keyText), limits.bodyMax));
  // A Codex heartbeat automation already drives this thread; nudging it too
  // would double up.
  if (summary.lastInputHeartbeat) {
    thread.excluded = "automation";
    thread.meta.heartbeat = true;
  }
  return summary.prRefs;
}

// The newest attachment is the thread's PR: a long thread moves on from the
// PR its catalog branch names (#5442 merged, the ask was about #6453). Links
// the owner typed come after every attachment. Same-second ties: own branch,
// then unknown head, then a different head, then the higher PR.
function refTier(entry, branch) {
  if (!entry.headBranch || !branch) return 1;
  return entry.headBranch === branch ? 0 : 2;
}

function orderPrRefs(entries, branch) {
  const ranked = entries.map((entry) => ({
    ...entry, owner: entry.source === "attachment" ? 0 : 1, tier: refTier(entry, branch), number: parsePrRef(entry.ref)?.number ?? 0
  }));
  ranked.sort((a, b) => a.owner - b.owner || b.at - a.at || a.tier - b.tier || b.number - a.number || a.ref.localeCompare(b.ref));
  return [...new Set(ranked.map((entry) => entry.ref))];
}

// A first message as the app shows it: the request after the files list,
// without context blocks (in-app browser, environment), markdown as text.
function shownFirstMessage(title) {
  // The same wrapper cleanup as the transcript reader (every known block,
  // the last request header), then any other paired or stray tag.
  return cleanCodexUserText(title)
    .replace(/<([\w-]{1,60})(?:\s[^>]{0,200})?>[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]{0,200}>/g, " ")
    .replace(/!?\[([^\]]{0,200})\]\([^)\s]{0,500}\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/^#{1,6}\s+/gm, "");
}

function displayTitle(row, limits) {
  return clampText(redactSecrets(row.name || row.title || `Codex ${String(row.id).slice(0, 8)}`), limits.titleMax);
}

// The Codex app labels some named threads (page and sidebar) by their first
// message instead of the name. Null when there is no name or they match, or
// when the rollout is a continuation segment: the app then shows that
// segment's first request, which the catalog does not hold.
function firstMessageTitle(row, limits) {
  if (!row.name || !row.title) return null;
  if (/_[0-9a-f]{8}-[0-9a-f-]{27}\.jsonl$/i.test(String(row.rollout_path ?? ""))) return null;
  const text = clampText(redactSecrets(shownFirstMessage(row.title)), limits.titleMax);
  const token = identityToken(text);
  return token && token !== identityToken(displayTitle(row, limits)) ? text : null;
}

// Title tokens shared by two or more unarchived threads the Codex app shows,
// across the whole catalog: a same-titled thread outside the lookback or the
// cap can still be the one open on screen. labels: every name and first
// message token, with the ids of the threads the app may label with it.
function readSharedTitles(db, limits) {
  const present = new Set(db.prepare("PRAGMA table_info(threads)").all().map((column) => column.name));
  if (!present.has("id")) return { names: new Set(), labels: new Map() };
  const pick = (name) => (present.has(name) ? name : `NULL AS ${name}`);
  const where = present.has("archived") ? " WHERE COALESCE(archived, 0) = 0" : "";
  const counts = new Map();
  const labels = new Map();
  const head = present.has("first_user_message") ? "substr(first_user_message, 1, 400) AS first_user_head" : "NULL AS first_user_head";
  for (const row of db.prepare(`SELECT id, ${pick("name")}, ${pick("title")}, ${pick("rollout_path")}, ${pick("originator")}, ${pick("source")}, ${pick("thread_source")}, ${head} FROM threads${where}`).all()) {
    if (row.originator === CONDUCTOR_CODEX_ORIGINATOR) continue;
    // Automation runs, reviews, heartbeats and subagents never show in the
    // sidebar, so they cannot be mistaken for the thread on screen. The
    // supervisor's own thread does show.
    if (metadataExclusion(row, {}) === "automation") continue;
    const token = identityToken(displayTitle(row, limits));
    if (token) counts.set(token, (counts.get(token) ?? 0) + 1);
    for (const label of [token, identityToken(firstMessageTitle(row, limits))]) {
      if (label) labels.set(label, (labels.get(label) ?? new Set()).add(String(row.id)));
    }
  }
  return { names: new Set([...counts].filter(([, count]) => count > 1).map(([token]) => token)), labels };
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
    title: displayTitle(row, limits),
    cwd: row.cwd ? String(row.cwd) : null,
    repo: repoFromRemote(row.git_origin_url),
    branch: row.git_branch || null,
    workspace: null,
    claudeSessionId: null,
    agentStatus: "unknown",
    lastActivityAt: toIso(updatedMs),
    lastAgentText: "",
    lastAgentTail: "",
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
      // "codex_sdk_ts" = started by Conductor's Codex agent, shown in Conductor.
      originator: row.originator || null,
      // The name set in the Codex app; title is the first prompt when unset.
      catalogName: row.name ? clampText(redactSecrets(row.name), limits.titleMax) : null,
      firstMessageTitle: firstMessageTitle(row, limits),
      file: row.rollout_path || null,
      turnStartedAt: null,
      abortReason: null,
      abortedAt: null,
      lastSupervisorAt: null,
      pendingQuestion: null,
      heartbeat: false
    }
  };
  // Excluded-by-metadata threads (mostly guardian reviews) skip the tail read.
  const rolloutRefs = thread.excluded ? [] : applyRollout(thread, row, context);
  thread.prRefs = orderPrRefs([...(attachments.get(id) ?? []), ...rolloutRefs], thread.branch);
  if (!thread.repo && thread.prRefs.length > 0) thread.repo = parsePrRef(thread.prRefs[0])?.repo ?? null;
  if (!thread.excluded) thread.excluded = scopeExclusion(thread);
  return thread;
}

// One page, newest first. after is the last row of the previous page.
function readThreadRows(db, sinceMs, limit, after = null) {
  const present = new Set(db.prepare("PRAGMA table_info(threads)").all().map((column) => column.name));
  if (!present.has("id") || !present.has("updated_at")) return [];
  const select = THREAD_COLUMNS.map((name) => (present.has(name) ? name : `NULL AS ${name}`));
  select.push(present.has("first_user_message") ? "substr(first_user_message, 1, 400) AS first_user_head" : "NULL AS first_user_head");
  const since = Math.floor(sinceMs / 1000);
  const page = after ? " AND (updated_at < ? OR (updated_at = ? AND id < ?))" : "";
  const params = after ? [since, after.updated_at, after.updated_at, after.id, limit] : [since, limit];
  return db.prepare(`SELECT ${select.join(", ")} FROM threads WHERE updated_at >= ?${page} ORDER BY updated_at DESC, id DESC LIMIT ?`)
    .all(...params);
}

function headBranchOf(row) {
  try {
    const head = JSON.parse(row.payload)?.headBranch;
    return typeof head === "string" && head ? head : null;
  } catch {
    return null;
  }
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
      out.get(row.thread_id).push({ ref, at: Number(row.created_at) * 1000 || 0, source: "attachment", headBranch: headBranchOf(row) });
    }
  } catch { /* older Codex without the attachments table */ }
  return out;
}

// Lock files are 0-byte flock targets with no pid inside, so the holder
// comes from one batched lsof. Codex removes them on release; when lsof
// cannot answer, a present lock file is treated as held.
export async function readWriterLocks(config, ids, { run, isPidAlive }) {
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
  const file = path.join(config.paths.codexHome, "state_5.sqlite");
  // No Codex install is an empty catalog. An unreadable one throws, so the
  // supervisor records a source error instead of seeing zero threads.
  if (!fs.existsSync(file)) return [];
  const db = await openReadOnlyDb(file);
  if (!db) throw new Error("Codex state database unavailable");
  const cutoff = now - config.lookbackHours * HOUR;
  const pageSize = limits.maxThreads * 5;
  const built = [];
  try {
    // Guardian reviews, automation, and settings-only rows fill pages too,
    // so read on until maxThreads in-scope threads are found or the
    // lookback window runs out; no fixed row cap hides an older real thread.
    for (let after = null, inScope = 0; inScope < limits.maxThreads;) {
      const rows = readThreadRows(db, cutoff, pageSize, after);
      const attachments = readPrAttachments(db, rows.map((row) => String(row.id)));
      const context = { config, now, attachments, tailBytes: options.tailBytes ?? TAIL_BYTES };
      for (const row of rows) {
        const thread = buildThread(row, context);
        // The catalog query lets settings-only writes through; the last turn decides.
        if (Date.parse(thread.lastActivityAt ?? "") < cutoff) continue;
        built.push(thread);
        if (!thread.excluded) inScope += 1;
      }
      if (rows.length < pageSize) break;
      after = rows.at(-1);
    }
    // A failed title scan marks nothing shared; identity checks still see
    // every thread the supervisor retained.
    let shared = { names: new Set(), labels: new Map() };
    try { shared = readSharedTitles(db, limits); } catch { /* older schema */ }
    for (const thread of built) {
      // Another thread labelled by its first message can show our name too.
      const name = identityToken(thread.title);
      if (shared.names.has(name) || [...(shared.labels.get(name) ?? [])].some((id) => id !== thread.id)) thread.meta.codexTitleShared = true;
      const alt = identityToken(thread.meta.firstMessageTitle);
      if (alt && [...(shared.labels.get(alt) ?? [])].some((id) => id !== thread.id)) thread.meta.codexFirstMessageShared = true;
    }
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
  const threads = capThreads(built, limits.maxThreads);
  const locked = await readWriterLocks(config, threads.map((thread) => thread.id), { run, isPidAlive });
  for (const thread of threads) thread.writerLocked = locked.has(thread.id);
  return threads;
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
  // The policy corroborates a transient error with rows from this window
  // only; an hour's total would count errors long since recovered from.
  const freshSec = (now - (config.limits?.lbErrorFreshMs ?? DEFAULTS.lbErrorFreshMs)) / 1000;
  const file = path.join(config.paths.codexHome, "logs_2.sqlite");
  // No log database is no errors; one that exists but cannot be read is
  // unknown, so the LB is never declared recovered on missing evidence.
  if (!fs.existsSync(file)) return [];
  const db = await openReadOnlyDb(file);
  if (!db) throw new Error("Codex retry log unreadable");
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
    const group = groups.get(kind) ?? { kind, count: 0, lastAtSec: 0, threadIds: new Set(), freshCount: 0, freshThreadIds: new Set() };
    const ts = Number(row.ts) || 0;
    group.count += 1;
    group.lastAtSec = Math.max(group.lastAtSec, ts);
    const id = retryThreadId(row);
    if (id) group.threadIds.add(id);
    // A row with no readable time cannot be aged out, as in the policy.
    if (!ts || ts >= freshSec) {
      group.freshCount += 1;
      if (id) group.freshThreadIds.add(id);
    }
    groups.set(kind, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || b.lastAtSec - a.lastAtSec)
    .map((group) => ({
      kind: group.kind, count: group.count, lastAt: group.lastAtSec ? toIso(group.lastAtSec) : null, threadIds: [...group.threadIds],
      freshCount: group.freshCount, freshThreadIds: [...group.freshThreadIds]
    }));
}
