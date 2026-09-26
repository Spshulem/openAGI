// Claude Code threads from transcript tails (~/.claude/projects/<slug>/<id>.jsonl)
// plus the live peer registry (~/.claude/sessions/<pid>.json). Read-only.
// Conductor sessions also write transcripts here; mergeThreads folds them
// into their Conductor thread by claudeSessionId.

import fs from "node:fs";
import path from "node:path";
import { classifyErrorText } from "../errors.js";
import {
  SUPERVISOR_PREFIX, clampTail, clampText, isPidAlive as defaultIsPidAlive, parseJsonLines, parsePrRef, prRefKey, readTail,
  redactSecrets, threadKey, toIso
} from "../contracts.js";

const DEFAULT_TAIL_BYTES = 2 * 1024 * 1024;
const MIN_TEXT_TURNS = 5;
const TURN_END_STOPS = new Set(["end_turn", "stop_sequence"]);
const TMP_ROOTS = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
const NON_OWNER_ORIGINS = new Set(["task-notification", "peer"]);
const NON_OWNER_TURNS = new Set(["task_notification", "peer", "system", "scheduled"]);
const STOP_TOOLS = new Set(["TaskStop", "KillShell", "KillBash"]);
const PR_URL = /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/;

function safeAlive(isPidAlive, pid) {
  try { return Boolean(isPidAlive(pid)); } catch { return false; }
}

function isUnder(dir, root) {
  return Boolean(dir && root) && (dir === root || dir.startsWith(`${root.replace(/\/+$/, "")}/`));
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
        waitingFor: typeof entry.waitingFor === "string" ? entry.waitingFor : null
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
  try { dirs = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch { return []; }
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

function isOwnerText(row, text) {
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
    lastAgentText: "", lastAgentAt: null, lastUserText: "", lastUserAt: null, turnStartedAt: null,
    apiError: null, retryError: null,
    toolDescriptions: new Map(), tasks: new Map()
  };
}

// A finished task is announced as a <task-notification> user row, or, while
// the agent is busy, as a queue-operation / queued_command attachment.
function closeNotifiedTasks(summary, text) {
  if (typeof text !== "string" || !text.includes("<task-notification>")) return;
  for (const match of text.matchAll(/<task-id>([^<]+)<\/task-id>/g)) summary.tasks.delete(match[1].trim());
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
  if (text.startsWith("[Request interrupted")) {
    summary.phase = "interrupted";
    return;
  }
  // Local slash commands (/login, /model) never start a model turn.
  if (/^<(command-name|local-command-)/.test(text)) return;
  summary.phase = "in-progress";
  summary.turnStartedAt = toIso(row.timestamp);
  if (isOwnerText(row, text)) {
    summary.lastUserText = text;
    summary.lastUserAt = toIso(row.timestamp);
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
    if (block.id) summary.toolDescriptions.set(block.id, clampText(block.input?.description ?? block.name ?? "", 120));
    if (STOP_TOOLS.has(block.name)) {
      const taskId = block.input?.task_id ?? block.input?.shell_id ?? block.input?.bash_id;
      if (taskId) summary.tasks.delete(String(taskId));
    }
  }
  if (text) {
    summary.lastAgentText = text;
    summary.lastAgentAt = toIso(row.timestamp);
    summary.textTurns += 1;
  }
  summary.phase = TURN_END_STOPS.has(message.stop_reason) && !usesTool ? "turn-end" : "in-progress";
}

function summarizeTranscript(rows) {
  const summary = emptySummary();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
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

function exclusionReason(id, summary, prRefs, config) {
  if (summary.sidechain) return "sidechain";
  if ((config.selfSessionIds ?? []).includes(id)) return "self";
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
  // Background tasks die with their process, so they only count while live.
  const openTasks = peer ? [...summary.tasks.values()] : [];
  const agentStatus = agentStatusFor(summary, { recent: now - mtimeMs <= limits.runningWindowMs, peer, openTasks });
  const errorSource = agentStatus === "error" ? summary.apiError : agentStatus === "stalled" ? summary.retryError : null;
  const prRefs = newestFirstUnique(summary.prRefs);
  const excerpt = (text) => clampText(redactSecrets(text), limits.excerptMax);
  const cwd = summary.cwd;
  const title = summary.customTitle ?? summary.aiTitle ?? summary.agentName ?? (summary.lastUserText || id);
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
    lastActivityAt: toIso(mtimeMs),
    lastAgentText: clampTail(redactSecrets(summary.lastAgentText), limits.excerptMax),
    lastAgentAt: summary.lastAgentAt,
    lastUserText: excerpt(summary.lastUserText),
    lastUserAt: summary.lastUserAt,
    error: threadError(errorSource, now, limits.excerptMax),
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
      abortReason: summary.phase === "interrupted" ? "interrupted" : null,
      entrypoint: summary.entrypoint,
      conductorHosted: Boolean(cwd && (cwd.includes("/conductor/workspaces/") || cwd.includes("/.conductor/")))
        || summary.entrypoint === "sdk-ts",
      peerStatus: peer?.status ?? null,
      waitingFor: peer?.waitingFor ?? null
    }
  };
}

export async function listClaudeThreads(config, options = {}) {
  try {
    const { now = Date.now(), isPidAlive = defaultIsPidAlive, tailBytes = DEFAULT_TAIL_BYTES } = options;
    const cutoff = now - config.lookbackHours * 3_600_000;
    const files = recentTranscripts(path.join(config.paths.claudeHome, "projects"), cutoff)
      .sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id))
      .slice(0, config.limits.maxThreads);
    if (!files.length) return [];
    const peers = options.peers ?? readLivePeers(config, { isPidAlive });
    const threads = [];
    for (const entry of files) {
      try {
        const summary = summarizeTranscript(parseJsonLines(readTail(entry.file, tailBytes)));
        threads.push(buildThread(entry, summary, { config, now, peers }));
      } catch {
        // One unreadable transcript never hides the rest.
      }
    }
    return threads;
  } catch {
    return [];
  }
}
