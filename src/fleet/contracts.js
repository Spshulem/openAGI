// Shared shapes, defaults, and small helpers for the fleet supervisor.
// Every fleet module imports from here so the units agree on names and
// limits. Keep this file dependency-free apart from node built-ins.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const THREAD_KINDS = Object.freeze(["codex", "claude", "conductor"]);

// Provider-level status of the thread's last turn, before PR/infra context.
export const AGENT_STATUS = Object.freeze(["running", "idle", "waiting", "stalled", "aborted", "error", "unknown"]);

// Why a turn ended on an infrastructure problem instead of real work.
export const ERROR_KINDS = Object.freeze([
  "session-limit", "model-limit", "usage-limit", "overloaded", "network", "lb", "logged-out", "disk-full", "other"
]);

// Supervisor-level classification. Order matters: first match wins.
export const STATES = Object.freeze([
  "excluded", "running", "infra-blocked", "waiting-ci", "local-verify", "needs-human",
  "asked-in-scope", "pr-not-ready", "ready-needs-human", "done", "idle-no-pr"
]);

export const ACTIONS = Object.freeze(["none", "wait", "nudge", "escalate-manager", "ask-user"]);
export const MODES = Object.freeze(["observe", "propose", "auto"]);
export const ROUTES = Object.freeze(["codex-exec", "peer-relay", "claude-resume"]);

const MIN = 60_000;

export const DEFAULTS = Object.freeze({
  tickMs: 5 * MIN,
  lookbackHours: 48,
  // A transcript written within this window counts as a turn in progress.
  runningWindowMs: 15 * MIN,
  idleBeforeNudgeMs: 15 * MIN,
  nudgeCooldownMs: 12 * MIN,
  maxNudgesWithoutProgress: 3,
  maxSendsPerTick: 4,
  // Leave a thread alone if the owner typed into it this recently.
  ownerRecentMs: 10 * MIN,
  fullVerifyEscalateMs: 30 * MIN,
  quickVerifyEscalateMs: 15 * MIN,
  waitingTaskMaxMs: 45 * MIN,
  gateBlockedEscalateMs: 30 * MIN,
  managerEscalationCooldownMs: 60 * MIN,
  sessionLimitGraceMs: 2 * MIN,
  overloadBackoffMs: Object.freeze([5 * MIN, 15 * MIN, 30 * MIN]),
  quietHours: Object.freeze({ start: 22, end: 8 }),
  pushPerHour: 3,
  titleMax: 100,
  bodyMax: 220,
  excerptMax: 600,
  maxThreads: 150,
  maxActionsKept: 300
});

export const DEFAULT_BB3_HOST = "dev@100.99.3.113";
export const DEFAULT_LB_URL = "http://100.99.3.113:2455";
export const DEFAULT_MANAGER_REF = "0056f770-e054-484b-a712-4cc036dacf6f";
export const DEFAULT_RELAY_MODEL = "claude-haiku-4-5-20251001";

export function defaultPaths(home = os.homedir()) {
  return {
    home,
    codexHome: path.join(home, ".codex"),
    claudeHome: path.join(home, ".claude"),
    conductorDb: path.join(home, "Library", "Application Support", "com.conductor.app", "conductor.db"),
    buzzEndpointFile: path.join(home, ".claude", "buzz", "endpoint"),
    codexLbEnvFile: path.join(home, ".codex", "codex-lb.env"),
    bb3WatchState: path.join(home, ".bb3-watch-state"),
    bb3WatchGateState: path.join(home, ".bb3-watch-gate-state"),
    lbWatchLog: path.join(home, "Library", "Logs", "lb-watch.log"),
    relayCwd: path.join(home, ".agent-supervisor", "relay")
  };
}

// The OpenAGI.app daemon runs with PATH=/usr/bin:/bin:/usr/sbin:/sbin, so
// every child binary is resolved to an absolute path up front.
export function defaultBinaries(home = os.homedir(), exists = fs.existsSync) {
  const pick = (candidates, fallback) => candidates.find((candidate) => exists(candidate)) ?? fallback;
  return {
    gh: pick(["/opt/homebrew/bin/gh", "/usr/local/bin/gh"], "gh"),
    claude: pick([path.join(home, ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"], "claude"),
    codex: pick([path.join(home, ".ccodex", "bin", "codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"], "codex"),
    ssh: pick(["/usr/bin/ssh"], "ssh"),
    git: pick(["/usr/bin/git", "/opt/homebrew/bin/git"], "git"),
    ps: pick(["/bin/ps"], "ps"),
    lsof: pick(["/usr/sbin/lsof"], "lsof")
  };
}

function envFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function envNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Single place that turns env + explicit overrides into the config every
// unit receives. Overrides win over env; env wins over defaults.
export function resolveFleetConfig(env = process.env, overrides = {}) {
  const home = overrides.home ?? os.homedir();
  const mode = MODES.includes(overrides.mode) ? overrides.mode
    : MODES.includes(String(env.OPENAGI_FLEET_MODE ?? "").trim()) ? String(env.OPENAGI_FLEET_MODE).trim()
    : "observe";
  const selfSessionIds = [env.CLAUDE_CODE_SESSION_ID, env.CONDUCTOR_SESSION_ID, ...(overrides.selfSessionIds ?? [])]
    .filter(Boolean);
  return {
    enabled: overrides.enabled ?? envFlag(env.OPENAGI_FLEET_SUPERVISOR),
    mode,
    push: (overrides.push ?? String(env.OPENAGI_FLEET_PUSH ?? "").trim()) || null,
    lookbackHours: overrides.lookbackHours ?? envNumber(env.OPENAGI_FLEET_LOOKBACK_HOURS, DEFAULTS.lookbackHours),
    tickMs: overrides.tickMs ?? envNumber(env.OPENAGI_FLEET_TICK_MS, DEFAULTS.tickMs),
    bb3Host: overrides.bb3Host ?? (String(env.OPENAGI_FLEET_BB3_HOST ?? "").trim() || DEFAULT_BB3_HOST),
    lbUrl: overrides.lbUrl ?? (String(env.OPENAGI_FLEET_LB_URL ?? "").trim() || DEFAULT_LB_URL),
    managerRef: overrides.managerRef ?? (String(env.OPENAGI_FLEET_BB3_MANAGER ?? "").trim() || DEFAULT_MANAGER_REF),
    relayModel: overrides.relayModel ?? (String(env.OPENAGI_FLEET_RELAY_MODEL ?? "").trim() || DEFAULT_RELAY_MODEL),
    publicUrl: overrides.publicUrl ?? (String(env.OPENAGI_PUBLIC_URL ?? "").trim() || null),
    selfSessionIds,
    limits: { ...DEFAULTS, ...(overrides.limits ?? {}) },
    paths: { ...defaultPaths(home), ...(overrides.paths ?? {}) },
    bins: { ...defaultBinaries(home), ...(overrides.bins ?? {}) }
  };
}

// Runs a child process and never throws. Timeouts kill only the child this
// call spawned. Output is capped so a chatty command cannot exhaust memory.
export function runCommand(cmd, args = [], options = {}) {
  const { cwd, env, timeoutMs = 30_000, input, maxBytes = 4 * 1024 * 1024 } = options;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, error: error.message });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { if (stdout.length < maxBytes) stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { if (stderr.length < maxBytes) stderr += chunk.toString("utf8"); });
    child.on("error", (error) => finish({ code: null, stdout, stderr, timedOut, error: error.message }));
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut, error: null }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

// Collapse whitespace and cut to max chars with an ellipsis.
export function clampText(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!max || text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

const SECRET_PATTERNS = [
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}/g, "[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[redacted]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/(https:\/\/ping\.buzzkit\.dev\/)[^\s"')]+/g, "$1[redacted]"],
  [/\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET)=)\S+/g, "$1[redacted]"]
];

// Best-effort scrub before untrusted transcript text is stored or shown.
export function redactSecrets(value) {
  let text = String(value ?? "");
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

export function threadKey(kind, id) {
  return `${kind}:${id}`;
}

export function prRefKey(repo, number) {
  return `${repo}#${number}`;
}

export function parsePrRef(ref) {
  const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(String(ref ?? "").trim());
  return match ? { repo: match[1], number: Number(match[2]) } : null;
}

// Normalizes a GitHub remote URL ("git@github.com:o/r.git", "https://github.com/o/r") to "o/r".
export function repoFromRemote(remote) {
  const match = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(remote ?? "").trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

export function toIso(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = typeof value === "number" ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function msSince(iso, now = Date.now()) {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
}

export function shortHash(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 16);
}

// Reads "export KEY=value" / "KEY=value" lines without touching process.env.
export function parseEnvText(text) {
  const out = {};
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[line.slice(0, index).trim()] = value;
  }
  return out;
}

// Reads at most maxBytes from the end of a file. Transcripts can be
// hundreds of MB, so sources never read whole files.
export function readTail(filePath, maxBytes = 512 * 1024) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    let text = buffer.toString("utf8");
    // Drop the first partial line when the read started mid-file.
    if (length < size) text = text.slice(text.indexOf("\n") + 1);
    return text;
  } catch {
    return "";
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

export function parseJsonLines(text) {
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* partial or corrupt line */ }
  }
  return rows;
}

// node:sqlite ships with Node >= 22.5. Sources open databases read-only and
// degrade to "unavailable" instead of crashing on older runtimes.
let sqliteModule;
export async function openReadOnlyDb(filePath) {
  if (sqliteModule === undefined) {
    try { sqliteModule = await import("node:sqlite"); } catch { sqliteModule = null; }
  }
  if (!sqliteModule || !fs.existsSync(filePath)) return null;
  try {
    return new sqliteModule.DatabaseSync(filePath, { readOnly: true });
  } catch {
    return null;
  }
}

/**
 * @typedef {Object} FleetThread
 * @property {string} key                 "codex:<id>" | "claude:<sessionId>" | "conductor:<sessionId>"
 * @property {"codex"|"claude"|"conductor"} kind
 * @property {string} id
 * @property {string} title
 * @property {string|null} cwd
 * @property {string|null} repo           "owner/name"
 * @property {string|null} branch
 * @property {string|null} workspace      Conductor workspace directory name
 * @property {string|null} claudeSessionId
 * @property {string} agentStatus         one of AGENT_STATUS
 * @property {string|null} lastActivityAt ISO
 * @property {string} lastAgentText       untrusted, redacted, <= excerptMax
 * @property {string|null} lastAgentAt
 * @property {string} lastUserText
 * @property {string|null} lastUserAt
 * @property {{kind: string, text: string, resetAt: string|null}|null} error
 * @property {{id: string, description: string, kind: string, startedAt: string|null}[]} openTasks
 * @property {string[]} prRefs            "owner/name#n", newest first
 * @property {{peerName: string, pid: number, status: string}|null} live
 * @property {boolean} writerLocked
 * @property {boolean} archived
 * @property {string|null} excluded       reason, or null when in scope
 * @property {{model?: string|null, file?: string|null, turnStartedAt?: string|null, abortReason?: string|null}} meta
 */

/**
 * @typedef {Object} FleetPr
 * @property {string} ref                 "owner/name#n"
 * @property {string} repo
 * @property {number} number
 * @property {string} url
 * @property {string} title
 * @property {"OPEN"|"MERGED"|"CLOSED"} state
 * @property {boolean} isDraft
 * @property {string} headRef
 * @property {string} headOid
 * @property {string} baseRef
 * @property {string|null} mergeState     GitHub mergeStateStatus
 * @property {string|null} mergeable
 * @property {string|null} reviewDecision
 * @property {{state: string|null, failing: string[], pending: string[]}} ci
 * @property {number} unresolvedThreads
 * @property {{reviewedHead: boolean|null, sha: string|null}} codexReview
 * @property {{required: boolean|null, freshOnHead: boolean|null, sha: string|null}} qa
 * @property {string|null} updatedAt
 */

/**
 * @typedef {Object} LocalGit
 * @property {string|null} head
 * @property {string|null} branch
 * @property {string|null} upstream
 * @property {number|null} ahead          commits not pushed to upstream
 * @property {string|null} remote         "owner/name"
 */

/**
 * @typedef {Object} FleetInfra
 * @property {{reachable: boolean|null, checkedAt: string|null, gate: {state: string|null, reason: string|null, since: string|null},
 *   fullQueue: number|null, quickQueue: number|null, load: number[]|null,
 *   runs: {pid: number, kind: "full"|"quick", pr: number|null, head: string|null, ageSec: number, owner: string|null}[],
 *   timersDead: string[], error: string|null}} bb3
 * @property {{healthy: boolean|null, detail: string|null, watchLine: string|null,
 *   recentErrors: {kind: string, count: number, lastAt: string|null, threadIds: string[]}[]}} lb
 * @property {{pid: number, command: string, cwd: string|null, ageSec: number, threadKey: string|null}[]} localVerify
 */

/**
 * @typedef {Object} FleetDecision
 * @property {string} threadKey           thread key, or "infra:bb3" / "infra:lb"
 * @property {string} state               one of STATES (or "infra")
 * @property {string} action              one of ACTIONS
 * @property {string|null} playbook       playbook id
 * @property {string|null} message        rendered text to send (nudge / escalate-manager)
 * @property {string} reason              short human-readable why
 * @property {string[]} blockers          short readiness blockers
 * @property {{title: string, body: string, options: string[], dedupeKey: string}|null} question
 * @property {string|null} route          one of ROUTES, or null when undeliverable
 * @property {string|null} notBefore      ISO; do not act before this time
 */
