// Codex threads from ~/.codex: the state_5.sqlite catalog, rollout tails,
// PR attachments, writer locks, and LB retry errors from logs_2.sqlite.
// Read-only. Every export degrades to [] instead of throwing.

import fs from "node:fs";
import path from "node:path";
import {
  CARD_DROP_MS, CARD_EXCLUSIONS, DEFAULTS, SUPERVISOR_PREFIX, clampTail, clampTailLines, clampText, cleanCardItem, isPidAlive as defaultIsPidAlive, openReadOnlyDb, parseJsonLines, parsePrRef, prRefKey, readTail, redactSecrets, repoFromRemote,
  CONDUCTOR_CODEX_ORIGINATOR, isSupervisorOwnPrompt, runCommand, shortHash, threadKey, toIso
} from "../contracts.js";
import { asksOwner } from "../classify.js";
import { classifyCodexErrorCode } from "../errors.js";
import { identityToken } from "../ui-delivery.js";

const HOUR = 3_600_000;
const TAIL_BYTES = 1024 * 1024;
const AUTOMATION_SOURCES = new Set(["guardian_review", "subagent", "automation"]);
const NEVER_ASKS = new Set(["guardian_review", "subagent"]);
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

// Who wrote a user message: a reply from a question card, the supervisor
// (Desktop may wrap its text), a heartbeat automation, injected context, or
// the owner.
export function userInputKind(raw) {
  const text = String(raw ?? "");
  if (parseCardReply(text)) return "reply";
  if (text.trimStart().startsWith(SUPERVISOR_PREFIX)) return "supervisor";
  if (HEARTBEAT_PATTERN.test(text)) return "heartbeat";
  const cleaned = cleanCodexUserText(text);
  if (cleaned.startsWith(SUPERVISOR_PREFIX)) return "supervisor";
  return cleaned ? "owner" : "context";
}

function readUserInput(summary, raw, at, turnId = null) {
  const text = String(raw ?? "");
  if (!text.trim()) return;
  const kind = userInputKind(text);
  // The supervisor's own words never answer an ask.
  if (kind === "supervisor") {
    summary.lastSupervisorAt = at;
    return;
  }
  if (kind === "reply") {
    // It closes the items it names, and the items of their card asked
    // before it. It is still the owner at work.
    const ids = new Set(parseCardReply(text));
    summary.cardReplies.push({ ids, order: summary.rows });
    if (summary.pendingQuestion && [...ids].some((id) => id.startsWith(`${summary.pendingQuestion.callId}:`))) summary.pendingQuestion = null;
    summary.lastUser = { text: "Answered a question card.", at };
    return;
  }
  summary.pendingQuestion = null;
  if (kind === "heartbeat") {
    summary.lastInputHeartbeat = true;
    return;
  }
  summary.lastInputHeartbeat = false;
  if (kind === "context") return;
  // The owner typed a new turn instead of answering: asks of earlier turns
  // are closed (a steer inside the ask's own turn leaves them open).
  // Older rollouts carry no turn id on the message: one typed after the
  // last turn ended starts the next turn, whatever turn the tail last saw.
  const turn = turnId ?? (summary.turnEnded ? null : summary.turnId);
  summary.cardAsks = summary.cardAsks.filter((ask) => turn && ask.turnId === turn);
  // Links inside the browser/IDE wrappers are ambient context, not the owner's words.
  const cleaned = cleanCodexUserText(text);
  addPrRefs(summary, cleaned, at, "owner");
  summary.lastUser = { text: cleaned, at };
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

function readItem(summary, item, at, turnId = null) {
  if (!item || typeof item !== "object") return;
  // An async card's item repeats the ask; it is not the agent's last words
  // (a card ending "- Continue" must not read as an in-scope ask).
  if (item.type === "AgentMessage" && item.delivery === "async") addCardAsk(summary, item.id, item, at, turnId);
  else if (item.type === "AgentMessage") setAgent(summary, contentText(item.content, ["Text", "text"]), at);
  else if (item.type === "UserMessage") readUserInput(summary, contentText(item.content, ["text", "Text"]), at, turnId);
  else if (item.type === "McpToolCall" && item.tool === "attach_artifact") addPrRefs(summary, item.arguments?.url, at, "attachment");
}

function readEvent(summary, payload, at) {
  switch (payload.type) {
    case "task_started":
      summary.lifecycle = { type: "task_started", payload, at };
      summary.turnStartedAt = toIso(payload.started_at) ?? at;
      summary.turnId = payload.turn_id ?? payload.turn_attribution?.turn_id ?? null;
      summary.turnEnded = false;
      break;
    case "task_complete":
      summary.lifecycle = { type: "task_complete", payload, at };
      summary.turnEnded = true;
      setAgent(summary, payload.last_agent_message, at);
      settleSealedAsk(summary);
      break;
    case "turn_aborted":
    case "error":
      summary.lifecycle = { type: payload.type, payload, at };
      if (payload.type === "turn_aborted") summary.turnEnded = true;
      break;
    case "agent_message":
      // Older rollouts write the async card as this event: it is the card,
      // not the agent's last words (its call row carries the ask).
      if (payload.delivery === "async") addCardAsk(summary, payload.call_id ?? payload.id, payload, at, payload.turn_id ?? null);
      else setAgent(summary, payload.message, at);
      break;
    case "user_message":
      readUserInput(summary, payload.message, at);
      break;
    case "item_completed":
      readItem(summary, payload.item, at, payload.turn_id ?? null);
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
      if (asked) summary.pendingQuestion = { ...asked, at, callId: payload.call_id ?? null };
      addCardAsk(summary, payload.call_id, parseArgs(payload.arguments), at, payload.internal_chat_message_metadata_passthrough?.turn_id ?? null);
    } else if (name.includes("attach_artifact")) addPrRefs(summary, payload.arguments, at, "attachment");
  } else if (payload.type === "custom_tool_call" && String(payload.input ?? "").includes("attach_artifact")) {
    addAttachRefs(summary, payload.input, at);
  }
}

export function parseRolloutTail(text) {
  const summary = {
    events: 0, lifecycle: null, turnStartedAt: null, turnId: null, turnEnded: false, lastAgent: null, lastUser: null,
    lastInputHeartbeat: false, lastSupervisorAt: null, pendingQuestion: null, prRefs: [], lastTurnAt: null,
    cardAsks: [], cardReplies: [], rows: 0
  };
  for (const row of parseJsonLines(text)) {
    const payload = row?.payload;
    if (!payload || typeof payload !== "object") continue;
    summary.rows += 1;
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
  const { pendingQuestion } = summary;
  if (pendingQuestion) delete pendingQuestion.callId;
  return summary;
}

// ---------- question cards ----------

// The tagged list the Codex app sends when the owner answers card items:
// <send_user_message_question_reply>[{"questionItemId":
// "[\"request_user_input_async\",\"call_x\",0]", ...}]</send_user_message_question_reply>.
// Item ids ("call_x:0"), or null when the text is not one: the app only
// counts a message that is the tagged list and nothing else.
const REPLY_PATTERN = /^\s*<send_user_message_question_reply>([\s\S]*)<\/send_user_message_question_reply>\s*$/;

export function parseCardReply(text) {
  const match = REPLY_PATTERN.exec(String(text ?? ""));
  if (!match) return null;
  let list;
  try { list = JSON.parse(match[1]); } catch { return []; }
  const ids = [];
  for (const entry of Array.isArray(list) ? list : []) {
    try {
      const [kind, callId, index] = JSON.parse(entry?.questionItemId);
      if (kind === "request_user_input_async" && callId) ids.push(`${callId}:${Number(index) || 0}`);
    } catch { /* not an item id */ }
  }
  return ids;
}

function parseArgs(args) {
  try {
    return typeof args === "string" ? JSON.parse(args) : args ?? null;
  } catch {
    return null;
  }
}

// The function call and the card item carry the same ask; the first one counts.
function addCardAsk(summary, callId, payload, at, turnId) {
  if (!callId || summary.cardAsks.some((ask) => ask.callId === callId)) return;
  summary.cardAsks.push({ callId: String(callId), turnId: turnId ?? summary.turnId ?? null, payload, at, order: summary.rows });
}

// One ask's items. A call with no questions asks its own text, free text only.
function askItems(ask) {
  const questions = Array.isArray(ask.payload?.questions) && ask.payload.questions.length ? ask.payload.questions : [{ title: ask.payload?.text }];
  return questions.map((question, index) => {
    const raw = String(question?.title ?? question?.question ?? "").trim();
    const options = (Array.isArray(question?.options) ? question.options : [])
      .map((option) => (typeof option === "string" ? option : option?.label))
      .filter((option) => typeof option === "string" && option.trim());
    return {
      itemId: `${ask.callId}:${index}`, header: null, question: raw && !isCiphertext(raw) ? raw : SEALED_QUESTION,
      options, multiSelect: false, freeText: true, at: ask.at
    };
  });
}

// The open card: every still-open ask turn's items no reply closed (a
// supervisor turn between two asks closes neither). Its id is the newest
// ask turn, so one card keeps one id while the agent adds to it. The app
// sends one reply per Send: an item it skips (Skip is local only) was asked
// before that reply, so a reply naming any item of a turn closes every item
// of that turn asked before it. order: the row's place (rollout ordinal or tail row).
function buildCard(asks, replies, limits) {
  if (!asks.length) return null;
  const turnId = asks.at(-1).turnId;
  const all = asks.flatMap((ask) => askItems(ask).map((item) => ({ ...item, order: ask.order, turnId: ask.turnId }))).map((item, index) => ({ ...item, index }));
  const closed = new Set();
  for (const reply of replies) {
    const turns = new Set(all.filter((item) => reply.ids.has(item.itemId)).map((item) => item.turnId));
    if (!turns.size) continue;
    for (const item of all) if (reply.ids.has(item.itemId) || (turns.has(item.turnId) && item.order < reply.order)) closed.add(item.itemId);
  }
  const items = all.filter((item) => !closed.has(item.itemId));
  if (!items.length) return null;
  return {
    app: "codex", cardId: String(turnId ?? asks.find((ask) => ask.turnId === turnId).callId), at: items[0].at, count: all.length,
    items: items.map((item) => cleanCardItem(item, limits))
  };
}

const HISTORY_TABLES = {
  thread_items: ["thread_id", "turn_id", "item_id", "rollout_ordinal", "created_at_ms", "item_json", "item_type"],
  thread_turns: ["thread_id", "turn_id", "rollout_ordinal"],
  thread_history_projection_state: ["thread_id", "next_rollout_byte_offset"]
};
const CARD_USER_ROWS = 60;
const CARD_ASK_ROWS = 60;
// At most this many items back from the newest are scanned for asks: a
// card item past CARD_DROP_MS is dropped anyway.
const CARD_SCAN_ROWS = 4000;
// A projection this close to the rollout's size is caught up; one further
// behind (or past the end) leaves the newest asks and replies to the tail.
const PROJECTION_SLACK_BYTES = 64 * 1024;
// Pages past the in-scope stop scanned for open cards, down to the lookback.
const CARD_SCAN_PAGES = 20;
const UNINDEXED_CARD_ROWS = /request_user_input_async|"delivery":"async"|"type":"user_message"|"type":"UserMessage"/;
// A continuation segment (<id>_<segment id>.jsonl) is indexed under the
// segment's id; the thread's own projection stopped with the older file.
const SEGMENT_PATTERN = /_([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i;

// Codex Desktop's own index of every thread item (thread_history_1.sqlite).
// It holds every card and reply however big the rollout grows. Null when it
// is missing, unreadable, or not the shape this reader knows.
export async function openThreadHistory(codexHome) {
  const db = await openReadOnlyDb(path.join(codexHome, "thread_history_1.sqlite"));
  if (!db) return null;
  try {
    for (const [table, columns] of Object.entries(HISTORY_TABLES)) {
      const present = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
      if (!columns.every((name) => present.has(name))) throw new Error(`thread history: no ${table}`);
    }
    return {
      db,
      projection: db.prepare("SELECT next_rollout_byte_offset AS offset, next_rollout_ordinal AS ordinal FROM thread_history_projection_state WHERE thread_id = ?"),
      users: db.prepare(`SELECT turn_id, rollout_ordinal, item_json FROM thread_items
        WHERE thread_id = ? AND item_type = 'userMessage' ORDER BY rollout_ordinal DESC LIMIT ${CARD_USER_ROWS}`),
      // Every user row the ask scan covers, when the newest ones hold no owner turn.
      usersFrom: db.prepare(`SELECT turn_id, rollout_ordinal, item_json FROM thread_items
        WHERE thread_id = ? AND item_type = 'userMessage' AND rollout_ordinal >= ? AND created_at_ms >= ? ORDER BY rollout_ordinal DESC`),
      turnStart: db.prepare("SELECT rollout_ordinal FROM thread_turns WHERE thread_id = ? AND turn_id = ?"),
      // created_at_ms is checked first: it sits before the large item_json.
      asks: db.prepare(`SELECT turn_id, item_id, item_json, rollout_ordinal, created_at_ms FROM thread_items
        WHERE thread_id = ? AND rollout_ordinal >= ? AND created_at_ms >= ? AND item_type = 'agentMessage' AND item_json LIKE '%"delivery":"async"%'
        ORDER BY rollout_ordinal DESC LIMIT ${CARD_ASK_ROWS}`)
    };
  } catch {
    try { db.close(); } catch { /* already closed */ }
    return null;
  }
}

function itemText(json) {
  const item = parseArgs(json);
  return contentText(item?.content, ["text", "Text"]);
}

// A thread's open card from the history index, null when none, or undefined
// when the index cannot say (no projection of the rollout file, or one not
// caught up with it): the rollout tail decides then. Only rows from the
// owner's newest typed turn on, and from the last two days, are read.
export function readHistoryCard(history, id, { bytes = null, rolloutPath = null, limits = null, now = Date.now() } = {}) {
  try {
    const indexed = SEGMENT_PATTERN.exec(String(rolloutPath ?? ""))?.[1] ?? id;
    const state = history.projection.get(indexed);
    if (!state || (Number.isFinite(bytes) && Math.abs(bytes - Number(state.offset)) > PROJECTION_SLACK_BYTES)) return undefined;
    // Rows the projection has not reached yet that add an ask, answer one,
    // or start an owner turn leave the card to the tail.
    const lag = Number.isFinite(bytes) ? bytes - Number(state.offset) : 0;
    if (lag > 0 && UNINDEXED_CARD_ROWS.test(readTail(rolloutPath, lag + 1))) return undefined;
    const bound = (Number(state.ordinal) || 0) - CARD_SCAN_ROWS;
    const cutoff = now - CARD_DROP_MS;
    let replies = [];
    let owner = null;
    const readUsers = (rows) => {
      replies = [];
      owner = null;
      for (const row of rows) {
        const text = itemText(row.item_json);
        const kind = userInputKind(text);
        if (kind === "reply") replies.push({ ids: new Set(parseCardReply(text)), order: Number(row.rollout_ordinal) });
        else if (kind === "owner" && !owner) owner = row;
      }
    };
    const users = history.users.all(indexed);
    readUsers(users);
    // The newest rows are all supervisor, heartbeat, context or reply rows:
    // none closes an ask, so the whole bounded scan is read for the owner's
    // turn and the replies instead of treating the oldest of them as one.
    if (!owner && users.length >= CARD_USER_ROWS) readUsers(history.usersFrom.all(indexed, Math.max(0, bound), cutoff));
    const ownerFrom = owner ? Number(history.turnStart.get(indexed, owner.turn_id)?.rollout_ordinal ?? owner.rollout_ordinal) : 0;
    const from = Math.max(ownerFrom, bound);
    const asks = [];
    for (const row of history.asks.all(indexed, from, cutoff)) {
      const item = parseArgs(row.item_json);
      if (item?.delivery !== "async") continue;
      asks.unshift({ callId: String(row.item_id), turnId: row.turn_id, payload: item, at: toIso(Number(row.created_at_ms)), order: Number(row.rollout_ordinal) });
    }
    return buildCard(asks, replies, limits);
  } catch {
    return undefined;
  }
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
  // The supervisor's own display thread, named by its opening prompt.
  if (isSupervisorOwnPrompt(head) || isSupervisorOwnPrompt(row.title)) return "self";
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
  let size = null;
  try {
    ({ mtimeMs, size } = fs.statSync(row.rollout_path));
  } catch {
    return [];
  }
  const summary = parseRolloutTail(readTail(row.rollout_path, tailBytes));
  thread.meta.pendingCard = readCard(row, context, size, summary);
  const updatedMs = Date.parse(thread.lastActivityAt ?? "");
  // Settings writes bump the file and catalog times without a turn, so
  // those are only a fallback when the tail holds no turn row.
  thread.lastActivityAt = summary.lastTurnAt ?? toIso(Math.max(mtimeMs, Number.isFinite(updatedMs) ? updatedMs : 0));
  thread.agentStatus = statusFor(summary, mtimeMs, now, limits);
  thread.error = errorFor(summary.lifecycle, now, limits);
  if (summary.lastAgent) {
    thread.lastAgentText = clampTail(redactSecrets(summary.lastAgent.text), limits.excerptMax);
    thread.lastAgentTail = clampTail(redactSecrets(summary.lastAgent.text), limits.reviewTailMax);
    thread.lastAgentFull = clampTailLines(redactSecrets(summary.lastAgent.text), limits.fullTextMax);
    thread.lastAgentFullAt = summary.lastAgent.at;
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

// The thread's open question card: from the history index when it covers
// this thread, else from the rollout tail (parsed here when not given).
function readCard(row, context, size = undefined, summary = null) {
  const limits = context.config.limits;
  let bytes = size;
  if (bytes === undefined) {
    try { bytes = fs.statSync(row.rollout_path).size; } catch { bytes = null; }
  }
  const indexed = context.history
    ? readHistoryCard(context.history, String(row.id), { bytes, rolloutPath: row.rollout_path, limits, now: context.now })
    : undefined;
  if (indexed !== undefined) return indexed;
  if (bytes === null) return null;
  let tail = summary;
  if (!tail) {
    // Most excluded threads never ask: skip the parse when the tail holds no card.
    const text = readTail(row.rollout_path, context.tailBytes);
    if (!text.includes("request_user_input_async") && !text.includes('"delivery":"async"')) return null;
    tail = parseRolloutTail(text);
  }
  return buildCard(tail.cardAsks, tail.cardReplies, limits);
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
    lastAgentFull: "",
    lastAgentFullAt: null,
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
      // "vscode" = an app's thread, "exec" = codex exec, "cli" = the Codex CLI.
      source: row.source || null,
      // The name set in the Codex app; title is the first prompt when unset.
      catalogName: row.name ? clampText(redactSecrets(row.name), limits.titleMax) : null,
      firstMessageTitle: firstMessageTitle(row, limits),
      file: row.rollout_path || null,
      turnStartedAt: null,
      abortReason: null,
      abortedAt: null,
      lastSupervisorAt: null,
      pendingQuestion: null,
      pendingCard: null,
      heartbeat: false
    }
  };
  // Excluded-by-metadata threads (mostly guardian reviews) skip the tail
  // read. Automation threads still get their question cards read: those wait
  // on the owner like any other. Guardian reviews and subagents never ask.
  const skipped = thread.excluded;
  const rolloutRefs = skipped ? [] : applyRollout(thread, row, context);
  if (skipped === "automation" && !NEVER_ASKS.has(row.thread_source) && !sourceIsSubagent(row.source)) thread.meta.pendingCard = readCard(row, context);
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

// Any thread with an open card (in scope, automation, or no-repo) is kept
// past the cap: it must not drop a question the owner has not seen.
function capThreads(threads, max) {
  const carded = (thread) => (!thread.excluded || CARD_EXCLUSIONS.has(thread.excluded)) && thread.meta?.pendingCard?.items?.length > 0;
  const inScope = threads.filter((thread) => !thread.excluded).slice(0, max);
  const room = Math.max(0, max - inScope.length);
  const rest = threads.filter((thread) => thread.excluded && !carded(thread)).slice(0, room);
  const keep = new Set([...inScope, ...threads.filter(carded), ...rest]);
  return threads.filter((thread) => keep.has(thread));
}

// Threads past the paging stop with an open card, paged to the lookback
// boundary (at most CARD_SCAN_PAGES pages): from the history index, or the
// bounded rollout tail when the index is missing or cannot say for a row.
// Every row whose card the index settled (read, or one that never asks)
// joins cardScanned.
function readCardedRows(db, history, after, { config, now, cutoff, pageSize, tailBytes, cardScanned }) {
  const carded = [];
  for (let page = 0; after && page < CARD_SCAN_PAGES; page += 1) {
    const rows = readThreadRows(db, cutoff, pageSize, after);
    carded.push(...rows.filter((row) => {
      const key = threadKey("codex", String(row.id));
      if (Number(row.archived) === 1 || NEVER_ASKS.has(row.thread_source) || sourceIsSubagent(row.source)) {
        cardScanned?.add(key);
        return false;
      }
      let bytes = null;
      try { bytes = fs.statSync(row.rollout_path).size; } catch { return false; }
      // A history index that does not cover the rollout (undefined) leaves
      // the card unknown: the tail may still show one.
      const indexed = history ? readHistoryCard(history, String(row.id), { bytes, rolloutPath: row.rollout_path, limits: config.limits, now }) : undefined;
      if (indexed !== undefined) cardScanned?.add(key);
      const card = indexed !== undefined ? indexed : readCard(row, { config, now, history: null, tailBytes }, bytes);
      return card?.items?.length > 0;
    }));
    after = rows.length < pageSize ? null : rows.at(-1);
  }
  const attachments = readPrAttachments(db, carded.map((row) => String(row.id)));
  return carded.map((row) => buildThread(row, { config, now, attachments, history, tailBytes }))
    .filter((thread) => Date.parse(thread.lastActivityAt ?? "") >= cutoff);
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
  // options.cardScanned (a Set): the keys of threads whose open card this
  // scan settled. One missing from the capped result has no card open.
  const cardScanned = options.cardScanned instanceof Set ? options.cardScanned : null;
  // A history index that will not open leaves every card to the tails.
  const history = options.history === undefined ? await openThreadHistory(config.paths.codexHome) : options.history;
  try {
    // Guardian reviews, automation, and settings-only rows fill pages too,
    // so read on until maxThreads in-scope threads are found or the
    // lookback window runs out; no fixed row cap hides an older real thread.
    let unread = null;
    for (let after = null, inScope = 0; ;) {
      const rows = readThreadRows(db, cutoff, pageSize, after);
      const attachments = readPrAttachments(db, rows.map((row) => String(row.id)));
      const context = { config, now, attachments, history, tailBytes: options.tailBytes ?? TAIL_BYTES };
      for (const row of rows) {
        const thread = buildThread(row, context);
        // The catalog query lets settings-only writes through; the last turn decides.
        if (Date.parse(thread.lastActivityAt ?? "") < cutoff) continue;
        built.push(thread);
        if (cardScanned) {
          try {
            const bytes = fs.statSync(row.rollout_path).size;
            const indexed = history ? readHistoryCard(history, String(row.id), { bytes, rolloutPath: row.rollout_path, limits, now }) : undefined;
            // An incomplete tail cannot establish that an older card closed.
            if (indexed !== undefined || bytes <= context.tailBytes) cardScanned.add(thread.key);
          } catch { /* unreadable coverage leaves the card unknown */ }
        }
        if (!thread.excluded) inScope += 1;
      }
      if (rows.length < pageSize) break;
      after = rows.at(-1);
      // Stopped by the cap with rows left: those are scanned for cards below.
      if (inScope >= limits.maxThreads) {
        unread = after;
        break;
      }
    }
    // capThreads keeps any thread with an open card, so the older rows the
    // loop stopped before are checked for one too, page by page to the
    // lookback: in the history index, else in the bounded rollout tail.
    if (unread) built.push(...readCardedRows(db, history, unread, { config, now, cutoff, pageSize, tailBytes: options.tailBytes ?? TAIL_BYTES, cardScanned }));
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
    if (options.history === undefined) try { history?.db.close(); } catch { /* already closed */ }
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
