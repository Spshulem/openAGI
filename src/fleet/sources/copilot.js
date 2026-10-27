// GitHub Copilot threads (VS Code agent host and Copilot CLI) from session
// logs (~/.copilot/session-state/<id>/events.jsonl, plus workspace.yaml for the
// name and git root). Read-only: Copilot sessions are shown, not driven.

import fs from "node:fs";
import path from "node:path";
import { classifyErrorText } from "../errors.js";
import {
  clampTail, clampTailLines, clampText, isSupervisorOwnPrompt, parseJsonLines, parsePrRef, prRefKey,
  readTail, redactSecrets, threadKey, toIso
} from "../contracts.js";

const DEFAULT_TAIL_BYTES = 2 * 1024 * 1024;
const FIRST_PROMPT_BYTES = 256 * 1024;
const TMP_ROOTS = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
const PR_URL = /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/g;

function isUnder(dir, root) {
  return Boolean(dir && root) && (dir === root || dir.startsWith(`${root.replace(/\/+$/, "")}/`));
}

// workspace.yaml is flat "key: value" lines; no YAML parser needed.
export function parseWorkspaceYaml(text) {
  const out = {};
  for (const line of String(text ?? "").split("\n")) {
    const match = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    out[match[1]] = value;
  }
  return out;
}

function readWorkspace(dir) {
  try { return parseWorkspaceYaml(fs.readFileSync(path.join(dir, "workspace.yaml"), "utf8")); } catch { return {}; }
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

function emptySummary() {
  return {
    phase: "unknown", cwd: null, gitRoot: null, branch: null, model: null, clientName: null,
    textTurns: 0, firstUserText: null, lastUserText: "", lastUserAt: null, lastAgentText: "", lastAgentAt: null,
    lastTurnAt: null, turnStartedAt: null, error: null, openPermissions: new Map(), prRefs: [], shutdownAt: null
  };
}

function takeContext(summary, context) {
  if (!context || typeof context !== "object") return;
  if (context.cwd) summary.cwd = context.cwd;
  if (context.gitRoot) summary.gitRoot = context.gitRoot;
  if (context.branch !== undefined) summary.branch = context.branch || null;
}

function collectPrRefs(summary, text) {
  for (const match of String(text ?? "").matchAll(PR_URL)) summary.prRefs.push(prRefKey(match[1], Number(match[2])));
}

// Rows arrive oldest first; the last turn marker decides the phase.
export function summarizeSession(rows) {
  const summary = emptySummary();
  for (const row of rows) {
    const data = row?.data ?? {};
    const at = toIso(row?.timestamp);
    switch (row?.type) {
      case "session.start":
      case "session.resume":
      case "session.context_changed":
        takeContext(summary, data.context);
        if (data.selectedModel) summary.model = data.selectedModel;
        if (row.type === "session.resume") summary.shutdownAt = null;
        break;
      case "session.model_change":
        if (data.newModel ?? data.model) summary.model = data.newModel ?? data.model;
        break;
      case "user.message": {
        const text = String(data.content ?? "");
        if (!text.trim()) break;
        summary.textTurns += 1;
        summary.firstUserText ??= text;
        summary.lastUserText = text;
        summary.lastUserAt = at;
        summary.lastTurnAt = at ?? summary.lastTurnAt;
        // A message sent to a finished or errored session starts a new turn.
        if (summary.phase !== "in-progress") { summary.phase = "in-progress"; summary.turnStartedAt = at; summary.error = null; }
        collectPrRefs(summary, text);
        break;
      }
      case "assistant.turn_start":
        summary.phase = "in-progress";
        summary.turnStartedAt = at;
        summary.error = null;
        summary.lastTurnAt = at ?? summary.lastTurnAt;
        break;
      case "assistant.message": {
        if (data.model) summary.model = data.model;
        const text = String(data.content ?? "");
        // Tool-call-only messages carry no text; keep the last real reply.
        if (text.trim() && !data.parentToolCallId) {
          summary.lastAgentText = text;
          summary.lastAgentAt = at;
          collectPrRefs(summary, text);
        }
        summary.lastTurnAt = at ?? summary.lastTurnAt;
        break;
      }
      case "assistant.turn_end":
        summary.phase = "turn-end";
        summary.openPermissions.clear();
        summary.lastTurnAt = at ?? summary.lastTurnAt;
        break;
      case "permission.requested":
        if (data.requestId) summary.openPermissions.set(data.requestId, { at, text: data.promptRequest?.intention ?? data.permissionRequest?.intention ?? "" });
        break;
      case "permission.completed":
        summary.openPermissions.delete(data.requestId);
        break;
      case "session.error":
        summary.phase = "api-error";
        summary.error = { text: String(data.message ?? data.errorType ?? "error"), at };
        summary.lastTurnAt = at ?? summary.lastTurnAt;
        break;
      case "session.shutdown":
        summary.shutdownAt = at;
        // Ending mid-turn is an abort; ending after a finished turn is not.
        if (summary.phase === "in-progress") summary.phase = "interrupted";
        summary.openPermissions.clear();
        break;
      default:
        break;
    }
  }
  return summary;
}

function agentStatusFor(summary, recent) {
  if (summary.openPermissions.size && summary.phase === "in-progress") return "waiting";
  switch (summary.phase) {
    case "api-error": return "error";
    case "interrupted": return "aborted";
    case "turn-end": return "idle";
    case "in-progress": return recent ? "running" : "stalled";
    default: return "unknown";
  }
}

function exclusionReason(id, summary, config, copilotHome) {
  if ((config.selfSessionIds ?? []).includes(id) || isSupervisorOwnPrompt(summary.firstUserText)) return "self";
  const { cwd } = summary;
  if (cwd && (isUnder(cwd, config.paths.relayCwd) || cwd.includes("/.agent-supervisor/"))) return "relay";
  // Chats without a folder live under ~/.copilot/chats.
  if (!cwd || isUnder(cwd, path.join(copilotHome, "chats"))) return "no-repo";
  if (TMP_ROOTS.some((root) => isUnder(cwd, root))) return "tmp";
  if (!summary.branch && !summary.gitRoot && summary.prRefs.length === 0) return "no-repo";
  if (summary.textTurns < 1) return "too-short";
  return null;
}

function newestFirstUnique(refs) {
  return [...new Set([...refs].reverse())];
}

function threadError(source, now, excerptMax) {
  if (!source) return null;
  const at = Date.parse(source.at ?? "");
  const classified = classifyErrorText(source.text, new Date(Number.isFinite(at) ? at : now)) ?? { kind: "other", resetAt: null };
  return { kind: classified.kind, text: clampText(redactSecrets(source.text), excerptMax), resetAt: classified.resetAt };
}

function buildThread({ id, dir, file, mtimeMs }, summary, workspace, { config, now, copilotHome }) {
  const { limits } = config;
  const agentStatus = agentStatusFor(summary, now - mtimeMs <= limits.runningWindowMs);
  const prRefs = newestFirstUnique(summary.prRefs);
  const excerpt = (text) => clampText(redactSecrets(text), limits.excerptMax);
  const cwd = summary.cwd ?? workspace.cwd ?? null;
  const branch = summary.branch ?? workspace.branch ?? null;
  const title = workspace.name || (path.basename(cwd ?? "") || "Copilot chat");
  const pending = [...summary.openPermissions.values()][0] ?? null;
  return {
    key: threadKey("copilot", id),
    kind: "copilot",
    id,
    title: clampText(redactSecrets(title), limits.titleMax),
    cwd,
    repo: parsePrRef(prRefs[0])?.repo ?? workspace.repository ?? null,
    branch,
    workspace: null,
    claudeSessionId: null,
    agentStatus,
    lastActivityAt: summary.lastTurnAt ?? toIso(mtimeMs),
    lastAgentText: clampTail(redactSecrets(summary.lastAgentText), limits.excerptMax),
    lastAgentTail: clampTail(redactSecrets(summary.lastAgentText), limits.reviewTailMax),
    lastAgentFull: clampTailLines(redactSecrets(summary.lastAgentText), limits.fullTextMax),
    lastAgentFullAt: summary.lastAgentAt,
    lastAgentAt: summary.lastAgentAt,
    lastUserText: excerpt(summary.lastUserText),
    lastUserAt: summary.lastUserAt,
    error: agentStatus === "error" ? threadError(summary.error, now, limits.excerptMax) : null,
    openTasks: [],
    prRefs,
    live: null,
    writerLocked: false,
    archived: false,
    excluded: exclusionReason(id, summary, config, copilotHome),
    meta: {
      model: summary.model,
      file,
      turnStartedAt: summary.turnStartedAt,
      abortReason: agentStatus === "aborted" ? "session-ended" : null,
      abortedAt: agentStatus === "aborted" ? summary.shutdownAt : null,
      clientName: workspace.client_name ?? null,
      gitRoot: summary.gitRoot ?? workspace.git_root ?? null,
      waitingFor: pending ? clampText(redactSecrets(pending.text), limits.excerptMax) || "permission" : null,
      blockedOnOwner: Boolean(pending)
    }
  };
}

// Stat every session first so only recent logs are tail-read.
function recentSessions(stateDir, cutoffMs) {
  let dirs;
  try {
    dirs = fs.readdirSync(stateDir, { withFileTypes: true });
  } catch (error) {
    // No Copilot install is empty; an unreadable one is a source failure.
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const sessions = [];
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(stateDir, entry.name);
    const file = path.join(dir, "events.jsonl");
    let mtimeMs;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
    if (mtimeMs >= cutoffMs) sessions.push({ id: entry.name, dir, file, mtimeMs });
  }
  return sessions;
}

export async function listCopilotThreads(config, options = {}) {
  const copilotHome = config?.paths?.copilotHome;
  if (!copilotHome || config.copilot?.enabled === false) return [];
  const { now = Date.now(), tailBytes = DEFAULT_TAIL_BYTES, only = null } = options;
  const cutoff = now - config.lookbackHours * 3_600_000;
  let sessions = recentSessions(path.join(copilotHome, "session-state"), only ? 0 : cutoff)
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
  if (only) sessions = sessions.filter((entry) => only.includes(entry.id));
  const threads = [];
  let inScope = 0;
  for (const entry of sessions) {
    if (!only && inScope >= config.limits.maxThreads) break;
    try {
      let rows = parseJsonLines(readTail(entry.file, tailBytes));
      // The tail can miss the session's start (cwd, branch, first prompt).
      let size = 0;
      try { size = fs.statSync(entry.file).size; } catch { /* gone */ }
      if (size > tailBytes) rows = [...parseJsonLines(readHead(entry.file, FIRST_PROMPT_BYTES)).slice(0, 5).filter((row) => row?.type === "session.start"), ...rows];
      const summary = summarizeSession(rows);
      const thread = buildThread(entry, summary, readWorkspace(entry.dir), { config, now, copilotHome });
      if (!thread.excluded) inScope += 1;
      threads.push(thread);
    } catch {
      // One unreadable session never hides the rest.
    }
  }
  return threads;
}
