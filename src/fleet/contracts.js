// Shared shapes, defaults, and small helpers for the fleet supervisor.
// Every fleet module imports from here so the units agree on names and
// limits. Keep this file dependency-free apart from node built-ins.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const THREAD_KINDS = Object.freeze(["codex", "claude", "conductor", "antigravity", "copilot"]);
// The one list every thread-key matcher is built from (server routes, the
// broker's and the phone's allowlists): "kind:id", the id as sources mint it.
export const THREAD_KIND_PATTERN = THREAD_KINDS.join("|");
export const THREAD_KEY_PATTERN = new RegExp(`^(?:${THREAD_KIND_PATTERN}):[A-Za-z0-9_.-]{1,120}$`);

export function isThreadKey(key) {
  return typeof key === "string" && THREAD_KEY_PATTERN.test(key);
}

// What the owner calls each kind's app in questions and labels.
export const KIND_NAMES = Object.freeze({ codex: "Codex", claude: "Claude", conductor: "Conductor", antigravity: "Antigravity", copilot: "Copilot" });

export function kindName(kind) {
  return KIND_NAMES[kind] ?? "Agent";
}

// Provider-level status of the thread's last turn, before PR/infra context.
export const AGENT_STATUS = Object.freeze(["running", "idle", "waiting", "stalled", "aborted", "error", "unknown"]);

// Why a turn ended on an infrastructure problem instead of real work.
export const ERROR_KINDS = Object.freeze([
  "session-limit", "model-limit", "usage-limit", "overloaded", "network", "lb", "logged-out", "disk-full", "other"
]);

// Supervisor-level classification. Order matters: first match wins.
export const STATES = Object.freeze([
  "excluded", "running", "infra-blocked", "stopped", "waiting-ci", "local-verify", "needs-human",
  "asked-in-scope", "pr-not-ready", "ready-needs-human", "done", "idle-no-pr"
]);

export const ACTIONS = Object.freeze(["none", "wait", "nudge", "escalate-manager", "ask-user"]);
export const MODES = Object.freeze(["observe", "propose", "auto"]);
// antigravity-send: agentapi send-message, the Antigravity app's own API.
export const ROUTES = Object.freeze(["codex-exec", "peer-relay", "claude-resume", "computer-use", "antigravity-send"]);
// How supervisor text reaches a thread. "cli" is the original set of routes;
// "computer-use" types into the app that shows the thread and never runs a
// CLI; "computer-use-first" types when computer use is ready, else falls back.
export const DELIVERY_MODES = Object.freeze(["cli", "computer-use", "computer-use-first"]);

// The executor prefixes every message with this. Sources and policy use it
// to tell the supervisor's own sends apart from the owner typing.
export const SUPERVISOR_PREFIX = "[OpenAGI supervisor]";

// The supervisor's own chats: the G2 display thread opens with this prompt
// (g2 agentctl.mjs). They are never watched or nudged (codex:01a0df66 got
// 54 "LB is up" nudges).
const SUPERVISOR_OWN_PROMPTS = [/^\s*You are the Agent Supervisor display\b/i];

export function isSupervisorOwnPrompt(text) {
  const head = String(text ?? "");
  return SUPERVISOR_OWN_PROMPTS.some((pattern) => pattern.test(head));
}

const MIN = 60_000;

export const DEFAULTS = Object.freeze({
  selfFix: Object.freeze({ mode: "propose", concurrency: 1, dailyCap: 3, wallMs: 2 * 60 * MIN, tokenCap: 6_000_000, rounds: 3, replayRetries: 1, reviewWaitMs: 25 * MIN }),
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
  // No playbook nudge this long after the owner's own message in a thread:
  // they are driving it, often on something other than its PR.
  ownerDrivenMs: 3 * 60 * MIN,
  fullVerifyEscalateMs: 30 * MIN,
  // A run holding a verification slot is slow only past this: normal runs
  // finish well inside it, and the verifier kills one at 90 min. The 30-min
  // thread-wait limit above would page about normal runs.
  fullRunSlowMs: 75 * MIN,
  quickVerifyEscalateMs: 15 * MIN,
  waitingTaskMaxMs: 45 * MIN,
  // No transcript row this long: a Conductor "working" turn is hung, and a
  // wait on a background task gets the agent asked for a status.
  silentTurnMs: 60 * MIN,
  // An idle-report nudge only for a turn that stopped within this long.
  idleReportMaxAgeMs: 6 * 60 * MIN,
  gateBlockedEscalateMs: 30 * MIN,
  lbErrorFreshMs: 15 * MIN,
  // Connection/unavailable errors seen in chats alarm only at this count (or
  // across two threads); one dropped stream is routine.
  lbTransientErrorMin: 3,
  managerEscalationCooldownMs: 60 * MIN,
  // An idle thread with no delivery route waits this long before the owner
  // is asked to open it.
  unreachableAskMs: 90 * MIN,
  sessionLimitGraceMs: 2 * MIN,
  overloadBackoffMs: Object.freeze([5 * MIN, 15 * MIN, 30 * MIN]),
  quietHours: Object.freeze({ start: 22, end: 8 }),
  pushPerHour: 3,
  titleMax: 100,
  bodyMax: 220,
  // A question card item's full question and its numbered choices.
  cardBodyMax: 900,
  excerptMax: 600,
  // The agent's whole final message, lines kept, for reading its report.
  fullTextMax: 8000,
  // The self-review reads this much of each thread's last agent message.
  reviewTailMax: 1500,
  maxThreads: 150,
  maxActionsKept: 300,
  // Computer-use delivery: the owner counts as away after this much input
  // idle time; each Open Computer Use call and each whole delivery is capped.
  // A Codex app state read alone takes 11-25 s.
  uiOwnerIdleMs: 2 * MIN,
  uiStepTimeoutMs: 10_000,
  // A presence command that ignores SIGTERM settles this long after its
  // timeout (runCommand's kill grace).
  uiKillGraceMs: 5_000,
  uiReadTimeoutMs: 45_000,
  // Codex: link, two reads, activate, read, focus, type, read, send, confirm,
  // typing included.
  uiDeliveryTimeoutMs: 205_000,
  // After that deadline: the one probe still running (two commands, kill
  // grace included) or readiness, then clearing (up to two reads) and
  // putting the owner's app back in what is left, none past it. Both count
  // from the owner's request start (its probes and the lock wait included),
  // so delivery and this stay under the node broker's 5 min.
  uiCleanupMs: 90_000,
  // Another delivery holding the lock: busy at once, retried next scan (a
  // remote send has no room in the broker's 5 min to wait it out).
  uiLockWaitMs: 0,
  uiNavigateMs: 5_000,
  // Codex can still show the previous thread on the first read after its link.
  uiNavigateSlowMs: 60_000,
  // Bringing the app to the front for the send.
  uiActivateMs: 3_000,
  uiConfirmMs: 8_000,
  uiPollMs: 500
});

// Deployment-specific targets have no built-in value: set them with
// OPENAGI_FLEET_BB3_HOST (ssh destination of the build box),
// OPENAGI_FLEET_LB_URL (base URL of the Codex load balancer) and
// OPENAGI_FLEET_BB3_MANAGER (the session that manages the box). A source whose
// target is unset reports itself as not configured rather than guessing.
export const DEFAULT_BB3_HOST = null;
export const DEFAULT_LB_URL = null;
export const DEFAULT_MANAGER_REF = null;
export const DEFAULT_RELAY_MODEL = "claude-haiku-4-5-20251001";
// Model for the review of the needs-you list, chosen by the owner on
// 2026-09-29 after the eval; OPENAGI_FLEET_REVIEW_MODEL overrides. Since
// 2026-10-13 it is the Claude fallback: the review runs on Codex through
// codex-lb (DEFAULT_REVIEW_CODEX_MODEL) when a provider is configured, and
// on Claude when that call fails. OPENAGI_FLEET_REVIEW_PROVIDER=codex|claude
// pins one.
export const DEFAULT_REVIEW_MODEL = "claude-sonnet-5";
export const DEFAULT_REVIEW_CODEX_MODEL = "gpt-6-luna";
export const REVIEW_PROVIDERS = Object.freeze(["codex", "claude"]);
// The Codex try leaves the Claude fallback its own full timeout.
export const DEFAULT_REVIEW_CODEX_TIMEOUT_MS = 180_000;
export const DEFAULT_REVIEW_MS = 30 * MIN;
// Sonnet took about 3 minutes on 13 questions, mostly thinking.
export const DEFAULT_REVIEW_TIMEOUT_MS = 360_000;
// Storage manager: the Mac's data volume and the SD card (sizes in GB of 2^30).
export const DEFAULT_DATA_MOUNT = "/System/Volumes/Data";
export const DEFAULT_SD_MOUNT = "/Volumes/Xtra";
export const STORAGE_DEFAULTS = Object.freeze({
  lowGb: 100, targetFreeGb: 150, criticalGb: 15, sdLowGb: 50, sdReserveGb: 30,
  // A plan smaller than this is not worth a question.
  askMinGb: 1,
  scanMs: 60 * MIN, scanLowMs: 15 * MIN, scanBudgetMs: 120_000
});

export function defaultPaths(home = os.homedir()) {
  return {
    home,
    codexHome: path.join(home, ".codex"),
    claudeHome: path.join(home, ".claude"),
    // Copilot sessions: session-state/<id>/events.jsonl.
    copilotHome: path.join(home, ".copilot"),
    conductorDb: path.join(home, "Library", "Application Support", "com.conductor.app", "conductor.db"),
    buzzEndpointFile: path.join(home, ".claude", "buzz", "endpoint"),
    codexLbEnvFile: path.join(home, ".codex", "codex-lb.env"),
    bb3WatchState: path.join(home, ".bb3-watch-state"),
    bb3WatchGateState: path.join(home, ".bb3-watch-gate-state"),
    lbWatchLog: path.join(home, "Library", "Logs", "lb-watch.log"),
    relayCwd: path.join(home, ".agent-supervisor", "relay"),
    // Antigravity's data: conversation_summaries.db and conversations/<id>.db.
    antigravityHome: path.join(home, ".gemini", "antigravity")
  };
}

// The Antigravity app's language server: its agent API, and the process the
// running instance's loopback port and csrf token are read from.
export const ANTIGRAVITY_LS = "/Applications/Antigravity.app/Contents/Resources/bin/language_server";

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
    lsof: pick(["/usr/sbin/lsof"], "lsof"),
    lsappinfo: pick(["/usr/bin/lsappinfo"], "lsappinfo"),
    ioreg: pick(["/usr/sbin/ioreg"], "ioreg"),
    open: pick(["/usr/bin/open"], "open"),
    du: pick(["/usr/bin/du"], "du"),
    df: pick(["/bin/df"], "df"),
    ditto: pick(["/usr/bin/ditto"], "ditto"),
    diskutil: pick(["/usr/sbin/diskutil"], "diskutil"),
    rm: pick(["/bin/rm"], "rm"),
    // A shim that runs the app's language server with "agentapi". The server
    // binary itself is how the running instance is found in ps.
    agentapi: pick([path.join(home, ".gemini", "antigravity", "bin", "agentapi")], null),
    antigravityLs: pick([ANTIGRAVITY_LS, path.join(home, "Applications", "Antigravity.app", "Contents", "Resources", "bin", "language_server")], ANTIGRAVITY_LS)
  };
}

const OCU_NAME = "open-computer-use";
const OCU_NATIVE = ["dist", "Open Computer Use.app", "Contents", "MacOS", "OpenComputerUse"];

// The standalone Open Computer Use binary the fleet drives apps with. The npm
// "open-computer-use" command is a node launcher: a launchd PATH may lack
// node, and killing the launcher would orphan the engine, so the bundled
// native executable next to it is used instead when present. The app starts
// the daemon with its own node and a bare PATH (after a reboot, say), so the
// usual per-user install dirs are searched too, newest nvm node first.
export function resolveOcuPath(env = process.env, { exists = fs.existsSync, realpath = fs.realpathSync, execPath = process.execPath, readdir = fs.readdirSync, home = env?.HOME || os.homedir() } = {}) {
  const explicit = String(env?.OPENAGI_FLEET_OCU_PATH ?? "").trim();
  let nvm = [];
  try {
    const versions = path.join(home, ".nvm", "versions", "node");
    nvm = readdir(versions).filter((name) => /^v\d/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((name) => path.join(versions, name, "bin", OCU_NAME));
  } catch { /* no nvm */ }
  const candidates = explicit ? [explicit] : [
    ...String(env?.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, OCU_NAME)),
    path.join(path.dirname(execPath), OCU_NAME),
    `/opt/homebrew/bin/${OCU_NAME}`,
    `/usr/local/bin/${OCU_NAME}`,
    ...nvm,
    // pnpm's global bin is a generated shell launcher (needs node on PATH,
    // and does not lead to the native engine), so it is not searched.
    ...[".volta/bin", ".npm-global/bin", ".local/bin", ".bun/bin"].map((dir) => path.join(home, dir, OCU_NAME))
  ];
  const found = candidates.find((candidate) => path.isAbsolute(candidate) && exists(candidate));
  if (!found) return explicit || null;
  let real = found;
  try { real = realpath(found); } catch { /* keep the path as given */ }
  const native = path.join(path.dirname(real), "..", ...OCU_NATIVE);
  return exists(native) ? path.normalize(native) : real;
}

// Non-UI routes a computer-use send may fall back to while the owner is at
// the Mac (so nothing takes the screen). claude-resume is never one: it
// forks a session behind Conductor.
export const BACKGROUND_ROUTES = Object.freeze(["codex-exec", "peer-relay", "antigravity-send"]);

export function parseBackgroundRoutes(value) {
  const names = String(value ?? "").split(/[\s,]+/).map((part) => part.trim().toLowerCase()).filter(Boolean);
  return [...new Set(names.filter((name) => BACKGROUND_ROUTES.includes(name)))];
}

export function parseDeliveryMode(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return DELIVERY_MODES.includes(text) ? text : "cli";
}

// OPENAGI_FLEET_REVIEW_PROVIDER: "codex" or "claude"; anything else is auto (null).
export function parseReviewProvider(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return REVIEW_PROVIDERS.includes(text) ? text : null;
}

function envFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function envOff(value) {
  return /^(0|false|no|off)$/i.test(String(value ?? "").trim());
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
  // OPENAGI_FLEET_SELF_SESSION_IDS: more of the supervisor's own sessions
  // (comma or space separated), for ones no prompt marker names.
  const configuredSelf = String(env.OPENAGI_FLEET_SELF_SESSION_IDS ?? "").split(/[\s,]+/);
  const selfSessionIds = [env.CLAUDE_CODE_SESSION_ID, env.CONDUCTOR_SESSION_ID, ...configuredSelf, ...(overrides.selfSessionIds ?? [])]
    .filter(Boolean);
  const enabled = overrides.enabled ?? envFlag(env.OPENAGI_FLEET_SUPERVISOR);
  return {
    enabled,
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
    selfFix: {
      ...DEFAULTS.selfFix,
      runtimeImprovements: envFlag(env.OPENAGI_RUNTIME_IMPROVEMENTS),
      mode: envOff(env.OPENAGI_FLEET_SELF_FIX) ? "off" : (["off", "propose", "auto"].includes(env.OPENAGI_FLEET_SELF_FIX) ? env.OPENAGI_FLEET_SELF_FIX : "propose"),
      dailyCap: Math.min(3, envNumber(env.OPENAGI_FLEET_SELF_FIX_DAILY_CAP, 3)),
      wallMs: Math.min(DEFAULTS.selfFix.wallMs, envNumber(env.OPENAGI_FLEET_SELF_FIX_WALL_MS, DEFAULTS.selfFix.wallMs)),
      tokenCap: Math.min(DEFAULTS.selfFix.tokenCap, envNumber(env.OPENAGI_FLEET_SELF_FIX_TOKEN_CAP, DEFAULTS.selfFix.tokenCap)),
      rounds: Math.min(3, envNumber(env.OPENAGI_FLEET_SELF_FIX_ROUNDS, 3)),
      ...overrides.selfFix
    },
    // repo -> UI path prefixes that make visual QA required; github.js has
    // a built-in default for buildbetter-app/buildbetter.
    uiPathPrefixes: overrides.uiPathPrefixes ?? {},
    // repo -> checks that must pass on the exact head before a PR is ready
    // (names, or {name, label}); github.js requires the BuildBot3 full run
    // for buildbetter-app/buildbetter.
    requiredChecks: overrides.requiredChecks ?? {},
    delivery: DELIVERY_MODES.includes(overrides.delivery) ? overrides.delivery : parseDeliveryMode(env.OPENAGI_FLEET_DELIVERY),
    // Off unless listed: OPENAGI_FLEET_BACKGROUND_ROUTES=codex-exec,peer-relay.
    backgroundRoutes: Array.isArray(overrides.backgroundRoutes) ? parseBackgroundRoutes(overrides.backgroundRoutes.join(",")) : parseBackgroundRoutes(env.OPENAGI_FLEET_BACKGROUND_ROUTES),
    // The watcher that sends app deliveries soon after the owner steps away,
    // instead of at the next scheduled scan. On unless OPENAGI_FLEET_IDLE_DRAIN=0.
    idleDrain: {
      enabled: overrides.idleDrain?.enabled ?? !envOff(env.OPENAGI_FLEET_IDLE_DRAIN),
      pollMs: overrides.idleDrain?.pollMs ?? envNumber(env.OPENAGI_FLEET_IDLE_POLL_MS, 15_000)
    },
    // The supervisor's review of its own needs-you list: on with the
    // supervisor unless OPENAGI_FLEET_REVIEW=0.
    review: {
      enabled: overrides.review?.enabled ?? (Boolean(enabled) && !envOff(env.OPENAGI_FLEET_REVIEW)),
      // null: codex when the Codex config names a provider (codex-lb),
      // else claude (resolved in review.js). model null: that provider's default.
      provider: overrides.review?.provider ?? parseReviewProvider(env.OPENAGI_FLEET_REVIEW_PROVIDER),
      model: overrides.review?.model ?? (String(env.OPENAGI_FLEET_REVIEW_MODEL ?? "").trim() || null),
      intervalMs: overrides.review?.intervalMs ?? envNumber(env.OPENAGI_FLEET_REVIEW_MS, DEFAULT_REVIEW_MS),
      timeoutMs: overrides.review?.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
      codexTimeoutMs: overrides.review?.codexTimeoutMs ?? DEFAULT_REVIEW_CODEX_TIMEOUT_MS
    },
    // The nudge judge (judge.js): a model reads the chat before an automatic
    // nudge. Off unless OPENAGI_FLEET_JUDGE=1 and a model is named.
    judge: {
      enabled: Boolean(overrides.judge?.enabled ?? envFlag(env.OPENAGI_FLEET_JUDGE)) && Boolean(overrides.judge?.model ?? String(env.OPENAGI_FLEET_JUDGE_MODEL ?? "").trim()),
      model: overrides.judge?.model ?? (String(env.OPENAGI_FLEET_JUDGE_MODEL ?? "").trim() || null),
      timeoutMs: overrides.judge?.timeoutMs ?? 40_000
    },
    // Disk space: safe cleanup, archive to the SD card, and asks. On with
    // the supervisor unless OPENAGI_FLEET_STORAGE=0.
    storage: {
      ...STORAGE_DEFAULTS,
      lowGb: envNumber(env.OPENAGI_FLEET_STORAGE_LOW_GB, STORAGE_DEFAULTS.lowGb),
      targetFreeGb: envNumber(env.OPENAGI_FLEET_STORAGE_TARGET_GB, STORAGE_DEFAULTS.targetFreeGb),
      criticalGb: envNumber(env.OPENAGI_FLEET_STORAGE_CRITICAL_GB, STORAGE_DEFAULTS.criticalGb),
      sdLowGb: envNumber(env.OPENAGI_FLEET_STORAGE_SD_LOW_GB, STORAGE_DEFAULTS.sdLowGb),
      sdReserveGb: envNumber(env.OPENAGI_FLEET_STORAGE_SD_RESERVE_GB, STORAGE_DEFAULTS.sdReserveGb),
      dataMount: DEFAULT_DATA_MOUNT,
      sdMount: String(env.OPENAGI_FLEET_STORAGE_SD ?? "").trim() || DEFAULT_SD_MOUNT,
      ...(overrides.storage ?? {}),
      enabled: overrides.storage?.enabled ?? (Boolean(enabled) && !envOff(env.OPENAGI_FLEET_STORAGE))
    },
    // Antigravity conversations: read, and sent to with agentapi, unless
    // OPENAGI_FLEET_ANTIGRAVITY=0. No data dir means no threads.
    antigravity: {
      enabled: overrides.antigravity?.enabled ?? !envOff(env.OPENAGI_FLEET_ANTIGRAVITY)
    },
    // GitHub Copilot sessions (VS Code agent host, Copilot CLI): read only,
    // unless OPENAGI_FLEET_COPILOT=0.
    copilot: {
      enabled: overrides.copilot?.enabled ?? !envOff(env.OPENAGI_FLEET_COPILOT)
    },
    limits: { ...DEFAULTS, ...(overrides.limits ?? {}) },
    paths: { ...defaultPaths(home), ...(overrides.paths ?? {}) },
    bins: { ...defaultBinaries(home), ocu: resolveOcuPath(env, { home }), ...(overrides.bins ?? {}) }
  };
}

// ---------------------------------------------------------------------------
// Computer-use delivery targets. Pure: policy asks "which app shows this
// thread?" without I/O. Only these bundle ids are ever driven.

export const UI_APPS = Object.freeze({
  conductor: Object.freeze({ app: "conductor", name: "Conductor", bundleId: "com.conductor.app" }),
  codex: Object.freeze({ app: "codex", name: "Codex", bundleId: "com.openai.codex" })
});

// How the owner opens an Antigravity conversation: { app, url, label, note },
// the shape of the other apps' open-chat links. The app registers
// antigravity:// but handles only antigravity://teleport/ai_studio, and the
// /c/<id> page its window shows is a loopback URL on a random port that opens
// a browser tab, not the app. No link opens one conversation, so url is null.
export function antigravityOpenChat(thread) {
  return openChatFor(thread);
}

// Codex threads started by Conductor's Codex agent carry this originator;
// they show in Conductor, not in the Codex app.
export const CONDUCTOR_CODEX_ORIGINATOR = "codex_sdk_ts";

// Threads the Codex app started carry this originator. codex exec on one
// takes its writer lock for the whole turn, often hours (a CI wait, a full
// verify), and the app then refuses to open it ("open in another app"). So
// they are only ever typed into the app, never resumed in the background.
export const CODEX_DESKTOP_ORIGINATOR = "Codex Desktop";
const CODEX_APP_ORIGINATORS = new Set([CODEX_DESKTOP_ORIGINATOR, "codex_work_desktop"]);

// A thread an app started. Older catalogs leave originator null, but still
// record source "vscode" for the app's threads (codex exec writes "exec",
// the CLI "cli").
export function codexAppOwned(thread) {
  return CODEX_APP_ORIGINATORS.has(thread?.meta?.originator) || thread?.meta?.source === "vscode";
}

// A Codex thread codex exec must not resume: Conductor's (it would fork) or
// the Codex app's (it would lock the owner out of it).
export function codexExecBarred(thread) {
  return thread?.meta?.originator === CONDUCTOR_CODEX_ORIGINATOR || codexAppOwned(thread);
}

// sessionTitle: the Conductor tab title (null when untitled); sessionCount:
// visible sessions in the workspace; titleShared: another tab there has the
// same title. They decide whether the workspace name alone proves the tab.
function conductorTarget({ workspaceId, sessionId, workspace = null, title = null, sessionCount = null, titleShared = false }) {
  const id = String(workspaceId);
  const session = String(sessionId);
  return {
    ...UI_APPS.conductor,
    targetKey: `conductor-session:${session}`,
    deepLink: `conductor://workspace?id=${encodeURIComponent(id)}&session=${encodeURIComponent(session)}`,
    workspaceId: id,
    sessionId: session,
    workspace: workspace ?? null,
    title: title ?? null,
    sessionCount: Number.isInteger(sessionCount) ? sessionCount : null,
    titleShared: titleShared === true
  };
}

function conductorFields(thread) {
  const meta = thread.meta ?? {};
  return {
    workspaceId: meta.conductorWorkspaceId,
    sessionId: meta.conductorSessionId,
    workspace: thread.workspace ?? null,
    // The source's own tab title when it read one; older rows fall back to the thread title.
    title: Object.hasOwn(meta, "conductorSessionTitle") ? meta.conductorSessionTitle : (thread.title ?? null),
    sessionCount: meta.conductorWorkspaceSessions ?? null,
    titleShared: meta.conductorTitleShared === true
  };
}

// The app that shows this thread, or null (loose Claude terminal sessions,
// Conductor-hosted Codex threads without a Conductor row, archived threads).
export function uiTargetFor(thread) {
  if (!thread || thread.archived) return null;
  const meta = thread.meta ?? {};
  if (thread.kind === "conductor") {
    if (!meta.conductorWorkspaceId || !meta.conductorSessionId) return null;
    return conductorTarget(conductorFields(thread));
  }
  if (thread.kind === "codex" && thread.id) {
    if (meta.originator === CONDUCTOR_CODEX_ORIGINATOR) {
      const host = meta.conductorHost;
      return host?.workspaceId && host?.sessionId ? conductorTarget(host) : null;
    }
    return {
      ...UI_APPS.codex,
      targetKey: `codex-thread:${thread.id}`,
      deepLink: `codex://threads/${encodeURIComponent(thread.id)}`,
      threadId: String(thread.id),
      title: thread.title ?? null,
      // Another unarchived Codex thread anywhere in the catalog has this title.
      titleShared: meta.codexTitleShared === true,
      // The first message, which the app shows instead of some names.
      altTitle: meta.firstMessageTitle ?? null,
      altTitleShared: meta.codexFirstMessageShared === true
    };
  }
  return null;
}

// Links each Conductor-hosted Codex thread to the Conductor session that
// runs it (Conductor stores the Codex thread id as claude_session_id).
// Returns new thread objects; the inputs are left untouched.
export function linkUiHosts(threads) {
  const list = Array.isArray(threads) ? threads : [];
  const hosts = new Map();
  for (const thread of list) {
    if (thread?.kind === "conductor" && !thread.archived && thread.claudeSessionId && thread.meta?.conductorWorkspaceId && thread.meta?.conductorSessionId) {
      hosts.set(thread.claudeSessionId, thread);
    }
  }
  return list.map((thread) => {
    if (thread?.kind !== "codex" || thread.meta?.originator !== CONDUCTOR_CODEX_ORIGINATOR) return thread;
    const host = hosts.get(thread.id);
    const conductorHost = host ? { ...conductorFields(host), key: host.key } : null;
    return { ...thread, meta: { ...(thread.meta ?? {}), conductorHost } };
  });
}

const CHAT_NAME_MAX = 80;
const sameName = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

// How the owner opens one thread's own chat: { app, url, label, note }. url
// is the app's id link, the one computer-use sends navigate by, and they
// check on screen that it lands on exactly that chat (Conductor's page URL
// carries the workspace and session ids, Codex labels the page with the
// thread). A chat no link opens (a Claude Code terminal session, a
// Conductor Codex thread with no Conductor tab, an archived thread) has url
// null; its label names the workspace or folder and the app instead, and
// note says why. Labels tell apart chats that share a workspace name.
export function openChatFor(thread) {
  if (!thread?.kind) return null;
  const name = (value) => clampText(value, CHAT_NAME_MAX);
  const title = name(thread.title);
  const folder = name(String(thread.cwd ?? "").split("/").filter(Boolean).at(-1) ?? "");
  const target = uiTargetFor(thread);
  if (target?.app === "conductor") {
    const workspace = name(target.workspace);
    const tab = name(target.title);
    const shown = [workspace, tab && !sameName(tab, workspace) ? tab : ""].filter(Boolean).join(" · ") || title || "untitled chat";
    return { app: "conductor", url: target.deepLink, label: `${shown} (Conductor)`, note: null };
  }
  if (target?.app === "codex") return { app: "codex", url: target.deepLink, label: `${title || "untitled thread"} (Codex)`, note: null };
  const where = name(thread.workspace) || folder;
  if (thread.kind === "antigravity") return { app: "antigravity", url: null, label: `${[where, title && !sameName(title, where) ? title : ""].filter(Boolean).join(" · ") || "untitled conversation"} (Antigravity)`, note: "Antigravity has no link to one conversation: open it in Antigravity and pick it in the sidebar." };
  if (thread.kind === "copilot") return { app: "copilot", url: null, label: `${[where, title && !sameName(title, where) ? title : ""].filter(Boolean).join(" · ") || "untitled chat"} (GitHub Copilot)`, note: "A GitHub Copilot session: open it in VS Code (Chat view) or run copilot --resume in its folder." };
  if (thread.kind === "conductor") return { app: "conductor", url: null, label: `${[where, title].filter(Boolean).join(" · ") || "untitled chat"} (Conductor)`, note: "Conductor gave no workspace or session id for this chat; open it from the sidebar." };
  if (thread.kind === "codex") {
    const inConductor = thread.meta?.originator === CONDUCTOR_CODEX_ORIGINATOR;
    return {
      app: inConductor ? "conductor" : "codex", url: null,
      label: `${[where, title].filter(Boolean).join(" · ") || "untitled thread"} (${inConductor ? "Conductor" : "Codex"})`,
      note: thread.archived ? "Archived in Codex: unarchive it to open." : inConductor ? `No Conductor tab shows this Codex thread now; open ${where || "its workspace"} in Conductor.` : "No link opens this thread."
    };
  }
  return { app: "claude", url: null, label: `${[where, title].filter(Boolean).join(" · ") || "untitled session"} (Claude Code)`, note: `A Claude Code terminal session${folder ? ` in ${folder}` : ""}: no app link opens it; open it in its terminal.` };
}

// Runs a child process and never throws. Timeouts kill only the child this
// call spawned (SIGTERM, then SIGKILL after a grace) and always settle.
// Output is capped so a chatty command cannot exhaust memory.
export function runCommand(cmd, args = [], options = {}) {
  const { cwd, env, timeoutMs = 30_000, input, maxBytes = 4 * 1024 * 1024, killGraceMs = 5_000 } = options;
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
    let killTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      // A child that ignores SIGTERM, or a descendant still holding the
      // pipes, must not keep the caller waiting forever.
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({ code: null, stdout, stderr, timedOut: true, error: null });
      }, killGraceMs);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { if (stdout.length < maxBytes) stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { if (stderr.length < maxBytes) stderr += chunk.toString("utf8"); });
    child.on("error", (error) => finish({ code: null, stdout, stderr, timedOut, error: error.message }));
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut, error: null }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

// ---------- question cards ----------

const CARD_LABEL_MAX = 200;
const CARD_ITEMS_MAX = 20;
// The app's Skip is local, so an item nobody answers may stay open for good:
// past a day it is asked once more, and past two it is dropped.
export const CARD_STALE_MS = 24 * 60 * MIN;
export const CARD_DROP_MS = 48 * 60 * MIN;
// Excluded threads whose open cards still reach the owner (never self or
// archived ones). They are never read for git or PRs.
export const CARD_EXCLUSIONS = new Set(["automation", "no-repo"]);
// One-option acknowledgements ("Okay", "Continue") ask nothing.
const ACK_LABELS = new Set(["ok", "okay", "continue", "got it", "acknowledge", "acknowledged", "understood"]);

// A note with no choices that says it needs nothing ("No input is needed
// from you right now") is one too.
const NOTHING_NEEDED = /\bno (?:input|action|response|reply|decision)\b[^.?!]{0,30}\b(?:needed|required)\b|\bnothing (?:is )?needed from you\b/i;

export function isAckItem(item) {
  const options = Array.isArray(item?.options) ? item.options : [];
  if (!options.length) return NOTHING_NEEDED.test(String(item?.question ?? ""));
  // "Continue (Recommended)": the app's recommendation suffix is not the label.
  const label = String(options[0]).trim().toLowerCase().replace(/\s*\(recommended\)$/, "").replace(/[.!]+$/, "");
  return options.length === 1 && ACK_LABELS.has(label);
}

// The items of an open card the owner is asked about now. Only Codex items
// age out: a Conductor card holds its turn until it is answered.
export function liveCardItems(card, now = Date.now()) {
  const items = Array.isArray(card?.items) ? card.items : [];
  return items.filter((item) => {
    if (isAckItem(item)) return false;
    if (card.app !== "codex") return true;
    const at = Date.parse(item.at ?? "");
    return !Number.isFinite(at) || now - at < CARD_DROP_MS;
  });
}

// Agent text, redacted and bounded; labels stay whole up to CARD_LABEL_MAX.
export function cleanCardItem(item, limits) {
  const max = limits?.cardBodyMax ?? DEFAULTS.cardBodyMax;
  const header = clampText(redactSecrets(item.header ?? ""), limits?.titleMax ?? DEFAULTS.titleMax);
  return {
    index: Number(item.index) || 0,
    itemId: String(item.itemId ?? item.index ?? ""),
    header: header || null,
    question: clampText(redactSecrets(item.question ?? ""), max),
    options: (Array.isArray(item.options) ? item.options : [])
      .map((option) => clampText(redactSecrets(option), CARD_LABEL_MAX)).filter(Boolean).slice(0, CARD_ITEMS_MAX),
    multiSelect: item.multiSelect === true,
    freeText: item.freeText !== false,
    at: item.at ?? null
  };
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
  [/\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET)=)\S+/g, "$1[redacted]"],
  // An Authorization header an agent printed in a curl example.
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}/g, "$1[redacted]"],
  // The Antigravity language server's flags and header (ps args, curl lines).
  [/(--(?:csrf_token|host_bridge_token)[= ])\S+/g, "$1[redacted]"],
  [/(x-codeium-csrf-token["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[redacted]"],
  [/("csrfToken"\s*:\s*")[^"]+/g, "$1[redacted]"]
];

// Keeps the END of a message: agents put their question or wait notice last.
export function clampTail(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!max || text.length <= max) return text;
  return `…${text.slice(text.length - Math.max(0, max - 1)).trimStart()}`;
}

// clampTail with the lines kept: spaces collapse, newlines (and one blank
// line between blocks) stay, so lists and sections can still be read.
export function clampTailLines(value, max) {
  const text = String(value ?? "").replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!max || text.length <= max) return text;
  return `…${text.slice(text.length - Math.max(0, max - 1)).trimStart()}`;
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to another user.
    return error?.code === "EPERM";
  }
}

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

// A check that reports main's own health ("main-health", "Reconcile main
// health"): red on every PR while main is red. Shared infra, not the PR's
// work, so no nudge to its agent clears it.
export function isMainHealthCheck(name) {
  return /\bmain[-_ ]?health\b/i.test(String(name ?? ""));
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

// A WAL database another app is writing (Antigravity's) opened as an
// immutable snapshot: no lock, no -shm, nothing written. It misses rows still
// in the WAL, so callers try openReadOnlyDb first.
export async function openImmutableDb(filePath) {
  if (sqliteModule === undefined) {
    try { sqliteModule = await import("node:sqlite"); } catch { sqliteModule = null; }
  }
  if (!sqliteModule || !fs.existsSync(filePath)) return null;
  try {
    const url = pathToFileURL(filePath);
    url.searchParams.set("immutable", "1");
    return new sqliteModule.DatabaseSync(url, { readOnly: true });
  } catch {
    return null;
  }
}

/**
 * @typedef {Object} FleetThread
 * @property {string} key                 "codex:<id>" | "claude:<sessionId>" | "conductor:<sessionId>" | "antigravity:<conversationId>" | "copilot:<sessionId>"
 * @property {"codex"|"claude"|"conductor"|"antigravity"|"copilot"} kind
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
 * @property {string} lastAgentTail       the same message, <= reviewTailMax (self-review only)
 * @property {string} [lastAgentFull]     the last real (not synthetic) agent message, lines kept, <= fullTextMax
 * @property {string|null} [lastAgentFullAt] when that message was written
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
 * @property {Object} meta               source extras: model, file, turnStartedAt, abortReason, heartbeat,
 *   lastSupervisorAt, pendingQuestion, pendingCard, provider, threadSource, conductorHosted, entrypoint, waitingFor,
 *   peerStatus, derivedStatus, dbRemote
 */

/**
 * @typedef {Object} QuestionCard          an open question card (meta.pendingCard)
 * @property {"conductor"|"codex"} app
 * @property {string} cardId              Conductor: the AskUserQuestion tool_use id. Codex: the ask turn id.
 * @property {string|null} at             ISO; the first open item's ask time
 * @property {number} count               items the card asked, answered ones included
 * @property {{index: number, itemId: string, header: string|null, question: string, options: string[],
 *   multiSelect: boolean, freeText: boolean, at: string|null}[]} items   the open ones; index is stable within the card
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
 * @property {string|null} mergedAt
 * @property {string|null} closedAt
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
 *   runs: {pid: number, kind: "full"|"quick", pr: number|null, head: string|null, ageSec: number, owner: string|null,
 *     queued?: boolean}[],
 *   timersDead: string[], error: string|null}} bb3   a full run is queued while it waits for a slot; once admitted its ageSec is from admission
 * @property {{healthy: boolean|null, detail: string|null, watchLine: string|null,
 *   recentErrors: {kind: string, count: number, lastAt: string|null, threadIds: string[],
 *     freshCount?: number, freshThreadIds?: string[]}[]}} lb   fresh*: the rows inside lbErrorFreshMs
 * @property {{pid: number, command: string, cwd: string|null, ageSec: number, threadKey: string|null}[]} localVerify
 */

/**
 * @typedef {Object} FleetDecision
 * @property {string} threadKey           thread key, or "infra:bb3" / "infra:lb"
 * @property {string|null} targetKey      thread that receives the message (the manager for escalate-manager)
 * @property {{head: string|null, unresolved: number|null}|null} progressMark
 * @property {string} state               one of STATES (or "infra")
 * @property {string} action              one of ACTIONS
 * @property {string|null} playbook       playbook id
 * @property {string|null} message        rendered text to send (nudge / escalate-manager)
 * @property {string} reason              short human-readable why
 * @property {string[]} blockers          short readiness blockers
 * @property {{title: string, body: string, options: string[], dedupeKey: string,
 *   kind: "agent-ask"|"agent-card"|"ready"|"stuck"|"limit"|"infra"|"open"}|null} question
 * @property {Object} [cardQuestion]     a Codex question card asked beside this decision (one per card)
 * @property {string|null} route          one of ROUTES, or null when undeliverable
 * @property {string|null} notBefore      ISO; do not act before this time
 */

/**
 * @typedef {Object} FleetPushPreview
 * @property {"nudge"} action
 * @property {string} playbook
 * @property {string} reason
 * @property {string} message             full text Push now sends verbatim
 */

/**
 * @typedef {Object} FleetQuestionView
 * @property {string|null} askContext     redacted agent context, for display only
 * @property {boolean} risky             classify the ask and options, not context
 */

// Supervisor state and thread detail carry pushPreview (FleetPushPreview or
// null) and pushing (a send is in flight). No repeat until the agent replies.
