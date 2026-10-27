// Claude Code threads from transcript tails (~/.claude/projects/<slug>/<id>.jsonl)
// plus the live peer registry (~/.claude/sessions/<pid>.json). Read-only.
// Conductor sessions also write transcripts here; mergeThreads folds them
// into their Conductor thread by claudeSessionId.

import fs from "node:fs";
import path from "node:path";
import { classifyErrorText } from "../errors.js";
import {
  SUPERVISOR_PREFIX, clampTail, clampTailLines, clampText, isPidAlive as defaultIsPidAlive, isSupervisorOwnPrompt, parseJsonLines, parsePrRef, prRefKey,
  readTail, redactSecrets, threadKey, toIso
} from "../contracts.js";

const DEFAULT_TAIL_BYTES = 2 * 1024 * 1024;
const MIN_TEXT_TURNS = 5;
const TURN_END_STOPS = new Set(["end_turn", "stop_sequence"]);
const TMP_ROOTS = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
const NON_OWNER_ORIGINS = new Set(["task-notification", "peer"]);
const NON_OWNER_TURNS = new Set(["task_notification", "peer", "system", "scheduled"]);
const STOP_TOOLS = new Set(["TaskStop", "KillShell", "KillBash"]);
// Starting new agent work moves on from an agent limit report; reading a
// log or checking state does not.
const AGENT_LAUNCH_TOOLS = new Set(["Workflow", "Agent", "Task"]);
const PR_URL = /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/;
// A transcript's opening prompt is read from its first bytes once the tail
// no longer holds it, and kept per session: it never changes.
const FIRST_PROMPT_BYTES = 256 * 1024;
const FIRST_PROMPTS_KEPT = 2000;
const firstPrompts = new Map();
// ps lstart can trail the registry's startedAt by a few seconds, never by more.
const PROC_START_SKEW_MS = 10 * 60_000;
// Account limits: one agent's limit stops every agent on the account.
const ACCOUNT_LIMITS = new Set(["session-limit", "usage-limit"]);

function safeAlive(isPidAlive, pid) {
  try { return Boolean(isPidAlive(pid)); } catch { return false; }
}

function isUnder(dir, root) {
  return Boolean(dir && root) && (dir === root || dir.startsWith(`${root.replace(/\/+$/, "")}/`));
}

function laterIso(current, next) {
  if (!next) return current;
  return !current || Date.parse(next) > Date.parse(current) ? next : current;
}

// When the peer's process started. The registry's startedAt (ms) is written a
// few seconds after launch; procStart (ps lstart in UTC, 1 s precision) is
// exact, so it wins when the two agree.
function processStartIso(entry) {
  const registered = Number(entry.startedAt);
  if (!Number.isFinite(registered) || registered <= 0) return null;
  const lstart = typeof entry.procStart === "string" ? Date.parse(`${entry.procStart} UTC`) : NaN;
  const exact = Number.isFinite(lstart) && lstart <= registered && registered - lstart <= PROC_START_SKEW_MS;
  return toIso(exact ? lstart : registered);
}

// A registry "waiting" status or waitingFor means the process sits on a
// permission prompt or dialog that only the owner can answer.
export function peerBlockedOnOwner(peer) {
  return Boolean(peer) && (peer.status === "waiting" || Boolean(peer.waitingFor));
}

// Background tasks die with their Claude process: none without a live peer,
// and none that started before the current process did.
export function liveTasks(tasks, peer) {
  if (!peer) return [];
  const since = Date.parse(peer.startedAt ?? "");
  if (!Number.isFinite(since)) return [...tasks];
  return tasks.filter((task) => !(Date.parse(task.startedAt ?? "") < since));
}

// Live Claude processes keyed by session id. Only <pid>.json is read: the
// sibling <pid>.<hash>.key files hold secrets.
export function readLivePeers(config, { isPidAlive = defaultIsPidAlive } = {}) {
  const peers = new Map();
  try {
    const dir = path.join(config.paths.claudeHome, "sessions");
    const seenAt = new Map();
    for (const name of fs.readdirSync(dir)) {
      if (!/^\d+\.json$/.test(name)) continue;
      let entry;
      try { entry = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { continue; }
      const pid = Number(entry?.pid);
      const sessionId = typeof entry?.sessionId === "string" ? entry.sessionId : "";
      if (!sessionId || !Number.isInteger(pid) || pid <= 0 || !safeAlive(isPidAlive, pid)) continue;
      // Stale registry rows can share a session id; the newest one is the live process.
      const updatedAt = Number(entry.updatedAt ?? entry.statusUpdatedAt ?? entry.startedAt ?? 0) || 0;
      if (peers.has(sessionId) && seenAt.get(sessionId) >= updatedAt) continue;
      seenAt.set(sessionId, updatedAt);
      peers.set(sessionId, {
        peerName: typeof entry.name === "string" ? entry.name : "",
        pid,
        status: typeof entry.status === "string" ? entry.status : "unknown",
        cwd: typeof entry.cwd === "string" ? entry.cwd : null,
        entrypoint: typeof entry.entrypoint === "string" ? entry.entrypoint : null,
        waitingFor: typeof entry.waitingFor === "string" ? entry.waitingFor : null,
        startedAt: processStartIso(entry)
      });
    }
  } catch {
    // Missing registry: no live peers.
  }
  return peers;
}

// Stat every transcript first so only recent files are tail-read.
function recentTranscripts(projectsDir, cutoffMs) {
  const byId = new Map();
  let dirs = [];
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch (error) {
    // No Claude install is empty; an unreadable one is a source failure.
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const dirPath = path.join(projectsDir, dir.name);
    let entries = [];
    try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const file = path.join(dirPath, entry.name);
      let mtimeMs;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
      if (mtimeMs < cutoffMs) continue;
      const id = entry.name.slice(0, -".jsonl".length);
      // A relocated session can leave a copy under an older slug; keep the newest.
      const current = byId.get(id);
      if (!current || current.mtimeMs < mtimeMs) byId.set(id, { id, file, mtimeMs });
    }
  }
  return [...byId.values()];
}

function blockText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text).join("\n").trim();
}

export function isOwnerText(row, text) {
  if (NON_OWNER_ORIGINS.has(row.origin?.kind)) return false;
  if (NON_OWNER_TURNS.has(row.turnOrigin)) return false;
  if (row.promptSource === "system") return false;
  return !/^(<|Caveat|\[Request interrupted)/.test(text) && !text.startsWith(SUPERVISOR_PREFIX);
}

function prRefFromRow(row) {
  const number = Number(row.prNumber);
  if (typeof row.prRepository === "string" && Number.isInteger(number) && number > 0) {
    const ref = prRefKey(row.prRepository, number);
    if (parsePrRef(ref)) return ref;
  }
  const match = PR_URL.exec(String(row.prUrl ?? ""));
  return match ? prRefKey(match[1], Number(match[2])) : null;
}

function emptySummary() {
  return {
    cwd: null, branch: null, entrypoint: null, sidechain: false,
    customTitle: null, aiTitle: null, agentName: null,
    prRefs: [], textTurns: 0, phase: null, model: null,
    lastAgentText: "", lastAgentAt: null, lastUserText: "", lastUserAt: null, turnStartedAt: null, lastSupervisorAt: null,
    lastTurnAt: null, abortedAt: null, apiError: null, retryError: null, workflowLimit: null, firstUserText: null,
    toolDescriptions: new Map(), tasks: new Map()
  };
}

// A finished task is announced as a <task-notification> user row, or, while
// the agent is busy, as a queue-operation / queued_command attachment.
function closeNotifiedTasks(summary, text) {
  if (typeof text !== "string" || !text.includes("<task-notification>")) return;
  for (const match of text.matchAll(/<task-id>([^<]+)<\/task-id>/g)) summary.tasks.delete(match[1].trim());
}

// A workflow's or subagents' report (a <task-notification> with <usage> or
// <failures>) where every agent failed on an account limit, as
// "[build] failed: You've hit your session limit · resets 10pm (...)": the
// session can do nothing until the reset, even when the main agent still
// answers (another model's cap) or the report is its last row. Returns
// { text, at } for that limit, or null (a report with a finished agent or any
// other failure says nothing about the account).
export function workflowLimitOf(text, at) {
  const failures = /<failures>([\s\S]*?)<\/failures>/.exec(text)?.[1];
  if (!failures) return null;
  if (Number(/<agents_done>(\d+)<\/agents_done>/.exec(text)?.[1] ?? 0) > 0) return null;
  const lines = failures.split("\n").map((line) => line.trim()).filter(Boolean);
  // "resets 10pm" is relative to when the report was written.
  const when = new Date(Number.isFinite(Date.parse(at ?? "")) ? Date.parse(at) : Date.now());
  const classified = lines.map((line) => ({ line, error: classifyErrorText(line, when) }));
  if (!classified.length || !classified.every(({ error }) => ACCOUNT_LIMITS.has(error?.kind))) return null;
  const pick = classified.find(({ error }) => error.resetAt) ?? classified[0];
  return { text: pick.line, at: at ?? null };
}

function onUser(summary, row) {
  const content = row.message?.content;
  const toolResult = Array.isArray(content) ? content.find((block) => block?.type === "tool_result") : null;
  if (toolResult) {
    summary.phase = "in-progress";
    const taskId = row.toolUseResult?.backgroundTaskId;
    if (taskId) {
      summary.tasks.set(String(taskId), {
        id: String(taskId),
        description: summary.toolDescriptions.get(toolResult.tool_use_id) ?? "",
        kind: "local_bash",
        startedAt: toIso(row.timestamp)
      });
    }
    return;
  }
  if (row.isMeta || row.isCompactSummary) return;
  const text = blockText(content);
  if (!text) return;
  closeNotifiedTasks(summary, text);
  // A later agent report replaces the limit one: limited again, or not.
  if (text.includes("<task-notification>") && /<(?:usage|failures)>/.test(text)) summary.workflowLimit = workflowLimitOf(text, row.timestamp ?? null);
  if (text.startsWith("[Request interrupted")) {
    summary.phase = "interrupted";
    summary.abortedAt = toIso(row.timestamp);
    return;
  }
  // Local slash commands (/login, /model) never start a model turn.
  if (/^<(command-name|local-command-)/.test(text)) return;
  summary.phase = "in-progress";
  summary.turnStartedAt = toIso(row.timestamp);
  // The first prompt read names a supervisor display chat (firstPromptOf
  // reads the real one when the tail starts mid-session).
  summary.firstUserText ??= text;
  // A new prompt (the owner's, or the supervisor's resume) starts work again.
  if (isOwnerText(row, text)) {
    summary.lastUserText = text;
    summary.lastUserAt = toIso(row.timestamp);
    summary.workflowLimit = null;
  } else if (text.startsWith(SUPERVISOR_PREFIX) || ((NON_OWNER_TURNS.has(row.turnOrigin) || row.promptSource === "system" || NON_OWNER_ORIGINS.has(row.origin?.kind)) && text.includes(SUPERVISOR_PREFIX))) {
    summary.lastSupervisorAt = toIso(row.timestamp);
    summary.workflowLimit = null;
  }
}

function onAssistant(summary, row) {
  const message = row.message ?? {};
  const blocks = Array.isArray(message.content) ? message.content : [];
  const text = blockText(blocks);
  // Synthetic API error rows ("You've hit your session limit") end the turn
  // and are not real agent output.
  if (row.isApiErrorMessage) {
    summary.phase = "api-error";
    summary.apiError = { text: text || String(row.error ?? "API error"), at: row.timestamp ?? null };
    return;
  }
  summary.apiError = null;
  summary.retryError = null;
  if (typeof message.model === "string" && message.model !== "<synthetic>") summary.model = message.model;
  let usesTool = false;
  for (const block of blocks) {
    if (block?.type !== "tool_use") continue;
    usesTool = true;
    if (AGENT_LAUNCH_TOOLS.has(block.name)) summary.workflowLimit = null;
    if (block.id) summary.toolDescriptions.set(block.id, clampText(block.input?.description ?? block.name ?? "", 120));
    if (STOP_TOOLS.has(block.name)) {
      const taskId = block.input?.task_id ?? block.input?.shell_id ?? block.input?.bash_id;
      if (taskId) summary.tasks.delete(String(taskId));
    }
  }
  // An answer sent back over a session socket with SendMessage (to a
  // supervisor relay that has already exited) is the agent's reply too, and
  // beats any preamble text beside it ("I'll send the status now"); a
  // message to a subagent is not.
  const relayed = blocks.find((block) => block?.type === "tool_use" && block.name === "SendMessage" && /^uds:/.test(String(block.input?.to ?? ""))
    && typeof block.input?.message === "string")?.input.message.trim();
  const said = relayed || text;
  // A finished reply that no longer reports the cap supersedes the report.
  if (summary.workflowLimit && said && TURN_END_STOPS.has(message.stop_reason) && !ACCOUNT_LIMITS.has(classifyErrorText(said)?.kind) && !/session limit|usage limit|quota|account cap/i.test(said)) summary.workflowLimit = null;
  if (said) {
    summary.lastAgentText = said;
    summary.lastAgentAt = toIso(row.timestamp);
    summary.textTurns += 1;
  }
  summary.phase = TURN_END_STOPS.has(message.stop_reason) && !usesTool ? "turn-end" : "in-progress";
}

// Claude appends cost-state, last-prompt, queue-operation and attachment rows
// on session load or exit; only turn rows say the agent or owner did work.
function isTurnRow(row) {
  return row.type === "user" || row.type === "assistant" || (row.type === "system" && row.subtype === "api_error");
}

function summarizeTranscript(rows) {
  const summary = emptySummary();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (isTurnRow(row)) summary.lastTurnAt = laterIso(summary.lastTurnAt, toIso(row.timestamp));
    if (typeof row.cwd === "string" && row.cwd) summary.cwd = row.cwd;
    if (typeof row.gitBranch === "string") summary.branch = row.gitBranch || null;
    if (typeof row.entrypoint === "string") summary.entrypoint = row.entrypoint;
    if ((row.type === "user" || row.type === "assistant") && typeof row.isSidechain === "boolean") summary.sidechain = row.isSidechain;
    if (row.type === "user") onUser(summary, row);
    else if (row.type === "assistant") onAssistant(summary, row);
    else if (row.type === "system" && row.subtype === "api_error") {
      summary.retryError = { text: String(row.error?.formatted ?? row.error?.message ?? "API error"), at: row.timestamp ?? null };
    } else if (row.type === "queue-operation") {
      closeNotifiedTasks(summary, row.content);
    } else if (row.type === "attachment" && row.attachment?.type === "queued_command") {
      closeNotifiedTasks(summary, row.attachment.prompt);
    } else if (row.type === "pr-link") {
      const ref = prRefFromRow(row);
      if (ref) summary.prRefs.push(ref);
    } else if (row.type === "custom-title" && row.customTitle) summary.customTitle = String(row.customTitle);
    else if (row.type === "ai-title" && row.aiTitle) summary.aiTitle = String(row.aiTitle);
    else if (row.type === "agent-name" && row.agentName) summary.agentName = String(row.agentName);
  }
  return summary;
}

function newestFirstUnique(refs) {
  return [...new Set([...refs].reverse())];
}

function readHead(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(maxBytes);
    const read = fs.readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// The session's own first prompt, which names a supervisor display chat.
// The tail's earliest prompt is it only while the whole file fits the tail;
// past that it is read from the head once per session, so a long display
// transcript stays excluded.
function firstPromptOf({ id, file }, summary, tailBytes, cache) {
  if (cache.has(id)) return cache.get(id);
  let size;
  try { size = fs.statSync(file).size; } catch { return summary.firstUserText; }
  if (size <= tailBytes) return summary.firstUserText;
  const text = summarizeTranscript(parseJsonLines(readHead(file, FIRST_PROMPT_BYTES))).firstUserText ?? null;
  if (cache.size >= FIRST_PROMPTS_KEPT) cache.delete(cache.keys().next().value);
  cache.set(id, text);
  return text;
}

function exclusionReason(id, summary, prRefs, config) {
  if (summary.sidechain) return "sidechain";
  if ((config.selfSessionIds ?? []).includes(id) || isSupervisorOwnPrompt(summary.firstUserText)) return "self";
  const { cwd } = summary;
  if (cwd && (isUnder(cwd, config.paths.relayCwd) || cwd.includes("/.agent-supervisor/"))) return "relay";
  if (cwd && TMP_ROOTS.some((root) => isUnder(cwd, root))) return "tmp";
  if (!cwd || (!summary.branch && prRefs.length === 0)) return "no-repo";
  if (summary.textTurns < MIN_TEXT_TURNS) return "too-short";
  return null;
}

function agentStatusFor(summary, { recent, peer, openTasks }) {
  switch (summary.phase) {
    case "api-error": return "error";
    case "interrupted": return "aborted";
    case "turn-end": return openTasks.length ? "waiting" : "idle";
    case "in-progress": return recent || peer?.status === "busy" ? "running" : "stalled";
    default: return "unknown";
  }
}

function threadError(source, now, excerptMax) {
  if (!source) return null;
  // "resets 12am" is relative to when the error was written, not to now.
  const at = Date.parse(source.at ?? "");
  const classified = classifyErrorText(source.text, new Date(Number.isFinite(at) ? at : now)) ?? { kind: "other", resetAt: null };
  return { kind: classified.kind, text: clampText(redactSecrets(source.text), excerptMax), resetAt: classified.resetAt };
}

function buildThread({ id, file, mtimeMs }, summary, { config, now, peers }) {
  const { limits } = config;
  const peer = peers.get(id) ?? null;
  const openTasks = liveTasks([...summary.tasks.values()], peer);
  const blockedOnOwner = peerBlockedOnOwner(peer);
  const agentStatus = blockedOnOwner
    ? "waiting"
    : agentStatusFor(summary, { recent: now - mtimeMs <= limits.runningWindowMs, peer, openTasks });
  const errorSource = agentStatus === "error" ? summary.apiError : agentStatus === "stalled" ? summary.retryError : null;
  // Every workflow agent failed on an account limit and the session stopped
  // (no running turn, no owner stop): it waits for the reset like a limit.
  const limitSource = !errorSource && !["running", "aborted"].includes(agentStatus) ? summary.workflowLimit : null;
  const prRefs = newestFirstUnique(summary.prRefs);
  const excerpt = (text) => clampText(redactSecrets(text), limits.excerptMax);
  const cwd = summary.cwd;
  // Untitled: the folder, never the owner's last message or the session id.
  const title = summary.customTitle ?? summary.aiTitle ?? summary.agentName ?? (path.basename(cwd ?? "") || "Claude chat");
  return {
    key: threadKey("claude", id),
    kind: "claude",
    id,
    title: clampText(redactSecrets(title), limits.titleMax),
    cwd,
    repo: parsePrRef(prRefs[0])?.repo ?? null,
    branch: summary.branch,
    workspace: null,
    claudeSessionId: id,
    agentStatus,
    // The file time is only a fallback: metadata rows bump it without a turn.
    lastActivityAt: summary.lastTurnAt ?? toIso(mtimeMs),
    lastAgentText: clampTail(redactSecrets(summary.lastAgentText), limits.excerptMax),
    lastAgentTail: clampTail(redactSecrets(summary.lastAgentText), limits.reviewTailMax),
    // API error rows never reach lastAgentText, so this is a real reply.
    lastAgentFull: clampTailLines(redactSecrets(summary.lastAgentText), limits.fullTextMax),
    lastAgentFullAt: summary.lastAgentAt,
    lastAgentAt: summary.lastAgentAt,
    lastUserText: excerpt(summary.lastUserText),
    lastUserAt: summary.lastUserAt,
    error: threadError(errorSource ?? limitSource, now, limits.excerptMax),
    openTasks,
    prRefs,
    live: peer ? { peerName: peer.peerName, pid: peer.pid, status: peer.status } : null,
    writerLocked: false,
    archived: false,
    excluded: exclusionReason(id, summary, prRefs, config),
    meta: {
      model: summary.model,
      file,
      turnStartedAt: summary.turnStartedAt,
      abortReason: agentStatus === "aborted" ? "interrupted" : null,
      abortedAt: agentStatus === "aborted" ? summary.abortedAt : null,
      lastSupervisorAt: summary.lastSupervisorAt,
      entrypoint: summary.entrypoint,
      conductorHosted: Boolean(cwd && (cwd.includes("/conductor/workspaces/") || cwd.includes("/.conductor/")))
        || summary.entrypoint === "sdk-ts",
      peerStatus: peer?.status ?? null,
      waitingFor: peer?.waitingFor ?? null,
      blockedOnOwner
    }
  };
}

export async function listClaudeThreads(config, options = {}) {
  if (!config?.paths?.claudeHome) return [];
  const { now = Date.now(), isPidAlive = defaultIsPidAlive, tailBytes = DEFAULT_TAIL_BYTES } = options;
  const cutoff = now - config.lookbackHours * 3_600_000;
  // Excluded transcripts (tmp, relay, too short) do not count toward the
  // cap, so keep reading until enough in-scope threads are found.
  const files = recentTranscripts(path.join(config.paths.claudeHome, "projects"), cutoff)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
  if (!files.length) return [];
  const peers = options.peers ?? readLivePeers(config, { isPidAlive });
  const threads = [];
  let inScope = 0;
  for (const entry of files) {
    if (inScope >= config.limits.maxThreads) break;
    try {
      const summary = summarizeTranscript(parseJsonLines(readTail(entry.file, tailBytes)));
      summary.firstUserText = firstPromptOf(entry, summary, tailBytes, options.firstPrompts ?? firstPrompts);
      const thread = buildThread(entry, summary, { config, now, peers });
      // The mtime pre-filter lets metadata-only writes through; the last turn decides.
      if (!(Date.parse(thread.lastActivityAt ?? "") < cutoff)) {
        threads.push(thread);
        if (!thread.excluded) inScope += 1;
      }
    } catch {
      // One unreadable transcript never hides the rest.
    }
  }
  return threads;
}
