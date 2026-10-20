// Delivers supervisor text to one agent thread through the routes in the
// spec: codex exec resume, a claude -p SendMessage relay to a live peer,
// claude -p --resume, computer-use (typed into the app that shows the
// thread, see ui-delivery.js), and agentapi send-message for Antigravity. This is the only fleet unit that writes to
// other processes, so it re-checks every precondition instead of trusting policy.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../file-utils.js";
import { CONDUCTOR_CODEX_ORIGINATOR, DEFAULTS, DEFAULT_RELAY_MODEL, ROUTES, SUPERVISOR_PREFIX, clampText, codexAppOwned, codexExecBarred, isPidAlive, parseEnvText, redactSecrets, runCommand, shortHash, uiTargetFor } from "./contracts.js";
import { runStatusOf, findLanguageServer as findAntigravityServer } from "./sources/antigravity.js";
import { readWriterLocks } from "./sources/codex.js";
import { classifyErrorText } from "./errors.js";
import { DEADLINE_MARGIN_MS, UI_LOCK, flattenMessage, uiIdentity } from "./ui-delivery.js";

export const MESSAGE_PREFIX = `${SUPERVISOR_PREFIX} `;

const RELAY_TIMEOUT_MS = 180_000;
// A relay cut short can still have delivered (then a retry duplicates it),
// so one is not started for a remote caller with less time than this left.
const RELAY_MIN_MS = 60_000;
// The send-time re-read of a chat before a background relay, at most.
const REFRESH_MAX_MS = 20_000;
// The send-time read of a Conductor chat's tasks (send now or queue).
const BUSY_REFRESH_MS = 8_000;
// agentapi send-message answers at once; the app runs the turn after.
const AGENTAPI_TIMEOUT_MS = 30_000;
const AGENTAPI_MIN_MS = 10_000;
// The block title Antigravity shows above a delivered message.
const AGENTAPI_TITLE = "OpenAGI supervisor";
// A remote caller with less left than this gets no background fallback: its
// checks (a lock read, at most 10 s) and the launch must fit.
const FALLBACK_MIN_MS = 15_000;

// Settles with promise, or rejects once ms pass.
function within(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
// A resumed turn can run for hours (CI waits, a full verify). Past this
// ceiling the send stops waiting on it and leaves it running: killing it
// killed a live Codex turn (019fe344, 21:08Z).
const BACKGROUND_TIMEOUT_MS = 2 * 60 * 60 * 1000;
// A turn left running past the ceiling holds its thread this much longer at
// most. One that never exits (a stalled network read, a prompt nobody sees)
// would otherwise block every later send to it until the supervisor
// restarted; it is still never killed.
const DETACHED_RELEASE_MS = 4 * 60 * 60 * 1000;
// After the ceiling, SIGTERM gets this long before SIGKILL settles the send.
const KILL_GRACE_MS = 10_000;
// Codex exec echoes everything it runs (logs reached 168 MB), so only the
// tail is kept in memory and on disk.
const TAIL_CHARS = 64 * 1024;
const DETAIL_MAX = 200;

// Children run agents under bypassPermissions, so they get an allowlisted env
// (same rule as codingChildEnv in builtin-coding-supervisor.js), never the
// daemon's .env: API keys, the OpenAGI auth token, and messaging tokens.
const CHILD_ENV_KEYS = ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "LANG", "TMPDIR", "TERM", "CODEX_HOME", "CCODEX_HOME", "CLAUDE_CONFIG_DIR"];
const SECRET_ENV_NAME = /^(?:ANTHROPIC|OPENAI|OPENAGI|TELEGRAM|TWILIO|BUILDBETTER)_|_(?:TOKEN|SECRET|KEY)$/i;
// A launchd daemon's PATH can be bare; the ccodex shim and hooks need node.
const BASE_PATH_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

function childPath(envPath, bins) {
  const binDirs = Object.values(bins ?? {})
    .filter((bin) => typeof bin === "string" && path.isAbsolute(bin))
    .map((bin) => path.dirname(bin));
  const dirs = [...String(envPath ?? "").split(path.delimiter), ...binDirs, path.dirname(process.execPath), ...BASE_PATH_DIRS];
  return [...new Set(dirs.filter(Boolean))].join(path.delimiter);
}

export function fleetChildEnv(env = process.env, { bins } = {}) {
  const out = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === undefined || SECRET_ENV_NAME.test(key)) continue;
    if (CHILD_ENV_KEYS.includes(key) || key.startsWith("LC_")) out[key] = String(value);
  }
  out.PATH = childPath(env?.PATH, bins);
  return out;
}

// The relay is a claude -p that exits once the message is delivered, so an
// answer sent back to it lands on a closed socket (9 of 16 relays: "ENOENT
// /tmp/cc-socks/..."). The agent answers in its own chat, where the
// supervisor reads its transcript.
export const RELAY_REPLY_NOTE = "Answer in your own chat as a normal reply, not with SendMessage: this sender exits right after delivering, so a reply sent to it is lost.";

// Mirrors relayToPeer in g2 scripts/agent-supervisor/attach.mjs so the relay
// model sees the same, already-proven instruction.
export function buildRelayPrompt(peerName, text) {
  const name = String(peerName ?? "").replace(/["\r\n]/g, "");
  return [
    `Use the SendMessage tool to send a message to the peer named "${name}".`,
    "Send the message below exactly as written, changing nothing and adding nothing.",
    "Then reply with only the word DONE.",
    "",
    "--- message starts ---",
    text,
    "--- message ends ---"
  ].join("\n");
}

// Same failure names as g2 summariseRelayFailure.
export function summariseRelayFailure(output, relayCwd = "the relay directory") {
  const text = String(output ?? "");
  if (/usage credits|usage limit|rate limit|out of credits/i.test(text)) {
    return "the Claude account is out of usage credits, so the relay could not run";
  }
  if (/not (?:a )?trusted|trust this (?:folder|directory)/i.test(text)) {
    return `the relay directory is not trusted; run claude once in ${relayCwd} and accept the prompt`;
  }
  if (/no such (?:peer|agent)|could not find/i.test(text)) {
    return "the peer was not found; it may have exited since the scan";
  }
  return null;
}

// Names the common reasons a background resume exits non-zero.
export function summariseExecFailure(output) {
  const text = String(output ?? "");
  if (/active writer/i.test(text)) return "writer-locked: the thread is open in another Codex writer";
  if (/is archived/i.test(text)) return "archived: unarchive the thread first";
  const infra = classifyErrorText(text);
  return infra ? `infra: ${infra.kind}` : null;
}

function detailText(value) {
  return clampText(redactSecrets(value), DETAIL_MAX);
}

function lastLine(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length ? detailText(lines[lines.length - 1]) : "";
}

function firstLine(text) {
  const line = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return line ? detailText(line) : "";
}

function isDirectory(dir) {
  if (!dir) return false;
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function withPrefix(message) {
  const text = String(message ?? "").trim();
  return text.startsWith(MESSAGE_PREFIX.trim()) ? text : `${MESSAGE_PREFIX}${text}`;
}

// Spawns a long-running child without holding its whole output. Never throws.
// detach: at timeoutMs the promise settles ({ detached: true }) and the
// child keeps running (an agent turn is never killed); its output is still
// drained so it never blocks, and onExit gets its result when it ends.
export function spawnWithTail(cmd, args = [], { cwd, env, timeoutMs = BACKGROUND_TIMEOUT_MS, killGraceMs = KILL_GRACE_MS, detach = false, onExit = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: null, tail: "", timedOut: false, error: error.message });
      return;
    }
    let tail = "";
    let timedOut = false;
    let settled = false;
    let killTimer = null;
    const keep = (chunk) => {
      tail += chunk.toString("utf8");
      if (tail.length > TAIL_CHARS * 2) tail = tail.slice(-TAIL_CHARS);
    };
    let detached = false;
    const finish = (result) => {
      if (detached) {
        detached = false;
        try { onExit?.({ ...result, tail: tail.slice(-TAIL_CHARS) }); } catch { /* best-effort */ }
        return;
      }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ ...result, tail: tail.slice(-TAIL_CHARS) });
    };
    const timer = setTimeout(() => {
      if (detach) {
        // The turn may still be working: stop waiting, never kill it.
        settled = true;
        detached = true;
        resolve({ code: null, timedOut: false, detached: true, error: null, tail: tail.slice(-TAIL_CHARS) });
        return;
      }
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      // A child that ignores SIGTERM, or a descendant still holding the
      // pipes, must not leave the thread "in flight" forever.
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({ code: null, timedOut: true, error: null });
      }, killGraceMs);
    }, timeoutMs);
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (error) => finish({ code: null, timedOut, error: error.message }));
    child.on("close", (code) => finish({ code, timedOut, error: null }));
  });
}

function isSelf(thread, config) {
  const self = config?.selfSessionIds ?? [];
  return [thread.id, thread.claudeSessionId].some((id) => id && self.includes(id));
}

// An app send blocked only because the owner is at the Mac. A send that left
// our text in the composer ("...; our text is left as a draft") is not one:
// a second route would duplicate it.
export const PRESENCE_BLOCK = /^(?:owner using [^;]+|waiting for idle: [^;]+)$/;

export function isPresenceBlock(delivery) {
  return delivery?.status === "blocked" && PRESENCE_BLOCK.test(String(delivery.detail ?? ""));
}

// A Codex app send that could not prove which thread is open: a title two
// threads share, or the app still on another thread after the id link.
// Codex shows no thread id on screen, so only codex exec, addressed by the
// thread's id, can reach it (#5557's approved ping was blocked twice so).
// Nothing was typed: these blocks come before the composer.
const CODEX_UNVERIFIED = /^(?:ambiguous: two threads share this title|could not verify thread: )/;

export function isCodexIdentityBlock(thread, delivery) {
  if (thread?.kind !== "codex" || delivery?.status !== "blocked" || delivery.unconfirmed) return false;
  const detail = String(delivery.detail ?? "");
  return CODEX_UNVERIFIED.test(detail) && !/left as a draft/.test(detail);
}

// Added to such a block when codex exec cannot take over either: the Codex
// app holds the thread's writer lock, as it does for every thread it has
// loaded (019fe344, #5557: lock held by "codex app-server"). Opening a thread
// by its link loads it, so the threads that hit identity blocks are the
// locked ones. Only the owner can send there; policy asks them sooner.
export const CODEX_APP_HOLDS = "Codex holds the thread open, so codex exec cannot reach it";

// The non-UI route a presence-blocked app send may take instead, if the owner
// allowed it (config.backgroundRoutes) and it cannot fork or queue unseen:
// codex-exec only for a Codex thread no app holds (no writer, so nothing
// moved it since the scan) and neither Conductor nor the Codex app started;
// peer-relay only for
// a Conductor chat whose live Claude session is idle, with no open pick.
export function backgroundRouteFor(thread, config) {
  const allowed = config?.backgroundRoutes ?? [];
  if (!allowed.length || !thread || thread.archived || thread.agentStatus === "running" || thread.meta?.blockedOnOwner === true) return null;
  if (thread.kind === "codex") {
    if (!allowed.includes("codex-exec") || thread.writerLocked || !thread.cwd || codexExecBarred(thread)) return null;
    return "codex-exec";
  }
  if (thread.kind === "conductor" && allowed.includes("peer-relay") && thread.live?.peerName && thread.live?.pid && thread.live.status === "idle" && !thread.meta?.pendingQuestion) return "peer-relay";
  return null;
}

function antigravityBusy(thread) {
  return thread.agentStatus === "running" || ["RUNNING", "BUSY", "CANCELING"].includes(runStatusOf(thread.meta?.runStatus)) || thread.meta?.notFullyIdle === true;
}

function checkPreconditions(thread, route, message, config, fallback = false) {
  if (!thread?.key) return "no thread";
  if (!ROUTES.includes(route)) return "no delivery route";
  if (!String(message ?? "").trim()) return "empty message";
  if (isSelf(thread, config)) return "the supervisor's own session";
  if (thread.archived) return "archived";
  // On a computer-use-only Mac no send ever runs a CLI, whatever an older
  // proposal or caller asked for.
  // agentapi is the Antigravity app's own API: it neither forks nor types.
  if (config?.delivery === "computer-use" && route !== "computer-use" && route !== "antigravity-send" && !(fallback && config.backgroundRoutes?.includes(route))) return "computer-use delivery only: CLI routes are off";
  if (route === "computer-use") {
    // A Codex writer lock held by the desktop app is expected here; a running
    // turn is not. The UI re-checks for a Stop button before typing.
    if (!uiTargetFor(thread)) return "no app shows this thread: open it";
    if (thread.agentStatus === "running") return "turn running";
    if (thread.meta?.blockedOnOwner === true) return "waiting on a permission prompt: answer it first (fleet_screen shows its buttons, fleet_click answers it)";
  }
  if (route === "codex-exec") {
    if (thread.kind !== "codex") return "codex-exec needs a codex thread";
    if (thread.writerLocked) return "writer-locked: the thread is open in another Codex writer";
    if (thread.meta?.originator === CONDUCTOR_CODEX_ORIGINATOR) return "conductor-owned: open it in Conductor";
    if (codexAppOwned(thread)) return "codex-app-owned: typed into the Codex app only";
    if (!isDirectory(thread.cwd)) return "cwd missing";
  }
  if (route === "peer-relay" && !thread.live?.peerName) return "no live peer";
  if (route === "antigravity-send") {
    if (thread.kind !== "antigravity") return "antigravity-send needs an Antigravity conversation";
    if (["computer-use", "computer-use-first"].includes(config?.delivery) && !config.backgroundRoutes?.includes(route)) return "Antigravity background delivery is not allowed: enable antigravity-send in backgroundRoutes";
    // A message to a busy conversation queues unseen behind its current work.
    if (antigravityBusy(thread)) return "turn running or background work active";
    if (thread.meta?.blockedOnOwner === true) return "waiting on an approval in Antigravity: answer it in the app";
  }
  if (route === "claude-resume") {
    // Resuming bypasses Conductor's UI and DB, and a live session would fork.
    if (thread.kind === "conductor" || thread.meta?.conductorHosted) return "conductor-owned: open it in Conductor";
    if (thread.kind !== "claude") return "claude-resume needs a claude thread";
    if (thread.live) return "live session: use peer-relay";
    if (!isDirectory(thread.cwd)) return "cwd missing";
  }
  return null;
}

// ui: createUiDriver() result ({ deliver }); knownThreads: () => every thread
// the supervisor saw, to spot shared titles; uiLock: one UI send at a time.
// refreshThread: (thread) => the same thread read again now, or null; a
// background route after a presence block needs it for Conductor chats, and
// an Antigravity send for its conversation. findLanguageServer: the running
// Antigravity server ({ address } and its csrf token) agentapi talks to.
export function createExecutor({ config, run, store = null, logDir, spawnBackground, readLivePeers = null, refreshThread = null, ui = null, knownThreads = () => [], uiLock = UI_LOCK, detachedReleaseMs = DETACHED_RELEASE_MS, findLanguageServer = findAntigravityServer } = {}) {
  const runner = run ?? runCommand;
  // An injected run (tests, dry harnesses) also serves the background routes.
  const background = spawnBackground ?? (run ? run : spawnWithTail);
  const logsDir = logDir ?? (store?.dir ? path.join(store.dir, "logs") : null);
  const bins = config?.bins ?? {};
  const paths = config?.paths ?? {};
  const limits = { ...DEFAULTS, ...(config?.limits ?? {}) };
  const active = new Set();
  const pending = new Set();
  // targetKey -> { hash, priorCount } of the last UI send that could not be
  // confirmed. Rebuilt from the action journal so a restart between an
  // uncertain send and its retry does not type the message twice.
  const unconfirmed = new Map();
  const apiUnconfirmed = new Map();
  const apiSeen = new Set();
  for (const action of store?.actions?.(limits.maxActionsKept ?? 500) ?? []) {
    if (action.route !== "antigravity-send" || apiSeen.has(action.threadKey)) continue;
    apiSeen.add(action.threadKey);
    if (action.unconfirmed) apiUnconfirmed.set(action.threadKey, { hash: action.messageHash, at: Date.parse(action.apiStartedAt ?? action.at) });
  }
  try {
    const seen = new Set();
    for (const action of store?.actions?.(limits.maxActionsKept ?? 500) ?? []) {
      const key = action.uiTargetKey;
      if (!key || seen.has(key) || action.route !== "computer-use") continue;
      seen.add(key);
      if (action.unconfirmed === true && action.messageHash) unconfirmed.set(key, { hash: action.messageHash, priorCount: Number.isInteger(action.priorCount) ? action.priorCount : null });
    }
  } catch { /* an unreadable journal only loses the guard */ }

  const journal = (actionId, fields) => {
    try {
      if (actionId) return store?.updateAction?.(actionId, fields)?.id ?? actionId;
      return store?.recordAction?.(fields)?.id ?? null;
    } catch {
      return actionId ?? null;
    }
  };

  const childEnv = (route) => {
    const env = fleetChildEnv(process.env, { bins });
    if (route !== "codex-exec") return env;
    // CODEX_LB_API_KEY goes to the codex child only, and nothing else from the file.
    let text = "";
    try { text = fs.readFileSync(paths.codexLbEnvFile, "utf8"); } catch { /* no LB env on this machine */ }
    const lbKey = parseEnvText(text).CODEX_LB_API_KEY ?? process.env.CODEX_LB_API_KEY;
    return lbKey ? { ...env, CODEX_LB_API_KEY: lbKey } : env;
  };

  const plan = (thread, route, text) => {
    if (route === "computer-use") {
      const target = uiTargetFor(thread);
      const where = target.app === "conductor" ? (target.workspace ?? thread.workspace ?? thread.id) : clampText(target.title ?? thread.id, 60);
      return { ui: true, target, describe: `type into ${target.name}: ${where}` };
    }
    if (route === "codex-exec") {
      return {
        cmd: bins.codex ?? "codex",
        args: ["exec", "resume", thread.id, "--skip-git-repo-check", text],
        cwd: thread.cwd,
        background: true,
        describe: `codex exec resume ${thread.id} in ${thread.cwd}`
      };
    }
    if (route === "antigravity-send") {
      const shim = bins.agentapi;
      const server = bins.antigravityLs;
      const available = (file) => file && path.isAbsolute(file) && fs.existsSync(file);
      const cmd = available(shim) ? shim : available(server) ? server : null;
      return {
        cmd,
        args: [...(cmd === server ? ["agentapi"] : []), "send-message", "--title", AGENTAPI_TITLE, thread.id, text],
        blocked: cmd ? null : "Antigravity delivery unavailable: install Antigravity.app in /Applications or ~/Applications, or restore its agentapi shim",
        api: true,
        background: false,
        describe: `agentapi send-message ${thread.id}`
      };
    }
    if (route === "claude-resume") {
      const sessionId = thread.claudeSessionId ?? thread.id;
      return {
        cmd: bins.claude ?? "claude",
        args: ["-p", "--resume", sessionId, "--permission-mode", "bypassPermissions", text],
        cwd: thread.cwd,
        background: true,
        describe: `claude -p --resume ${sessionId} in ${thread.cwd}`
      };
    }
    const peerName = thread.live.peerName;
    return {
      cmd: bins.claude ?? "claude",
      args: [
        "-p", buildRelayPrompt(peerName, `${text}\n${RELAY_REPLY_NOTE}`),
        // bypassPermissions ignores --allowedTools as a limit, so --tools and
        // --strict-mcp-config leave SendMessage as the only tool.
        "--tools", "SendMessage",
        "--strict-mcp-config",
        "--allowedTools", "SendMessage",
        "--permission-mode", "bypassPermissions",
        "--model", config?.relayModel ?? DEFAULT_RELAY_MODEL
      ],
      cwd: paths.relayCwd,
      background: false,
      describe: `claude -p SendMessage relay to ${peerName}`
    };
  };

  const writeLog = (thread, output) => {
    if (!logsDir || !output) return null;
    try {
      ensureDir(logsDir);
      const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
      const file = path.join(logsDir, `${thread.kind}-${String(thread.id).slice(0, 8)}-${stamp}.log`);
      fs.writeFileSync(file, redactSecrets(output), { mode: 0o600 });
      return file;
    } catch {
      return null;
    }
  };

  const relay = async (thread, step, base, actionId, env, timeoutMs = RELAY_TIMEOUT_MS) => {
    try { ensureDir(step.cwd); } catch { /* the runner surfaces a real failure */ }
    let result;
    try {
      result = await runner(step.cmd, step.args, { cwd: step.cwd, env, timeoutMs });
    } catch (error) {
      result = { code: null, stdout: "", stderr: "", timedOut: false, error: error?.message ?? String(error) };
    }
    const stdout = String(result?.stdout ?? "").trim();
    const output = `${stdout} ${result?.stderr ?? ""}`.trim();
    let detail = null;
    if (result?.timedOut) {
      detail = `relay timed out after ${Math.round(timeoutMs / 1000)}s`;
    } else if (result?.error || result?.code !== 0) {
      detail = `relay failed: ${summariseRelayFailure(output, step.cwd) || firstLine(result?.error) || firstLine(result?.stderr) || `exit ${result?.code}`}`;
    } else {
      const refusal = summariseRelayFailure(stdout, step.cwd);
      if (refusal) detail = `relay failed: ${refusal}`;
      else if (stdout !== "DONE") detail = `relay did not confirm delivery: ${detailText(stdout) || "(no output)"}`;
    }
    const status = detail ? "failed" : "sent";
    const finalDetail = detail ? detailText(detail) : `relayed to ${thread.live.peerName}`;
    const id = journal(actionId, { ...base, status, detail: finalDetail, finishedAt: new Date().toISOString() });
    return { status, route: base.route, detail: finalDetail, actionId: id };
  };

  // agentapi send-message into an Antigravity conversation. The conversation
  // is read again first: one that started a turn, waits on an approval, or
  // moved since the scan is left alone. The server address
  // and csrf token go to this child only, read fresh from the running app.
  const apiSend = async (thread, step, base, actionId, blocked, timeoutMs) => {
    const startedAt = Date.now();
    let fresh = thread;
    if (!refreshThread) return blocked("could not read the conversation again: scan again");
    if (refreshThread) {
      try {
        fresh = await within(Promise.resolve().then(() => refreshThread(thread)), REFRESH_MAX_MS);
      } catch {
        fresh = null;
      }
      if (!fresh) return blocked("could not read the conversation again: scan again");
      if (antigravityBusy(fresh)) return blocked("turn running or background work active");
      if (fresh.meta?.blockedOnOwner === true) return blocked("waiting on an approval in Antigravity: answer it in the app");
      if ((Date.parse(fresh.lastUserAt ?? "") || 0) > (Date.parse(thread.lastUserAt ?? "") || 0)) return blocked("the owner wrote in the conversation since the scan");
    }
    const uncertain = apiUnconfirmed.get(thread.key);
    if (uncertain) {
      if ((Date.parse(fresh.meta?.lastSupervisorAt ?? "") || 0) < uncertain.at) return { ...blocked("earlier agentapi delivery is unconfirmed: inspect the conversation before retrying"), unconfirmed: true };
      apiUnconfirmed.delete(thread.key);
      if (uncertain.hash === base.messageHash) {
        const detail = "earlier delivery confirmed in the conversation";
        const id = journal(actionId, { ...base, status: "sent", unconfirmed: false, detail, finishedAt: new Date().toISOString() });
        return { status: "sent", route: base.route, detail, actionId: id };
      }
    }
    if (["lastAgentAt", "lastActivityAt"].some((field) => (Date.parse(fresh[field] ?? "") || 0) > (Date.parse(thread[field] ?? "") || 0))
      || Number(fresh.meta?.stepCount ?? 0) !== Number(thread.meta?.stepCount ?? 0)) return blocked("the agent replied or did new work since the scan: scan again");
    if (base.playbook === "resume" && thread.error && (!fresh.error || fresh.error.kind !== thread.error.kind || fresh.error.text !== thread.error.text)) return blocked("the original error no longer stands: scan again");
    let server = null;
    try { server = await findLanguageServer(config, { run: runner }); } catch { server = null; }
    if (!server?.address || !server.csrfToken) return blocked("Antigravity is not running: no language server to deliver through");
    const projectId = fresh.meta?.projectId ?? thread.meta?.projectId ?? null;
    const env = {
      ...fleetChildEnv(process.env, { bins }),
      ANTIGRAVITY_LS_ADDRESS: server.address,
      ANTIGRAVITY_CSRF_TOKEN: server.csrfToken,
      ...(projectId ? { ANTIGRAVITY_PROJECT_ID: projectId } : {})
    };
    let result;
    try {
      result = await runner(step.cmd, step.args, { env, timeoutMs });
    } catch (error) {
      result = { code: null, stdout: "", stderr: "", timedOut: false, error: error?.message ?? String(error) };
    }
    let reply = null;
    try { reply = JSON.parse(String(result?.stdout ?? "").trim()); } catch { /* not JSON */ }
    let detail = null;
    if (result?.timedOut) detail = `agentapi timed out after ${Math.round(timeoutMs / 1000)}s; it may have delivered`;
    else if (result?.code === 0 && !result?.error && !reply?.error) detail = null;
    else detail = `agentapi failed: ${firstLine(typeof reply?.error === "string" ? reply.error : "") || firstLine(result?.error) || firstLine(result?.stderr) || firstLine(result?.stdout) || `exit ${result?.code}`}`;
    const status = result?.timedOut ? "blocked" : detail ? "failed" : "sent";
    const extra = result?.timedOut ? { unconfirmed: true, apiStartedAt: new Date(startedAt).toISOString() } : {};
    const finalDetail = detail ? detailText(detail) : "delivered to the Antigravity conversation";
    const id = journal(actionId, { ...base, status, detail: finalDetail, ...extra, finishedAt: new Date().toISOString() });
    if (result?.timedOut) apiUnconfirmed.set(thread.key, { hash: base.messageHash, at: startedAt });
    return { status, route: base.route, detail: finalDetail, actionId: id, ...extra };
  };

  // Synchronous: the result is final when this returns, so there is no done
  // promise and nothing for reopenIfUndelivered to wait on.
  // spentMs: what the caller's request already spent; the lock wait adds to it.
  // deadlineAt: when a remote caller stops waiting (null: no such caller).
  // The Conductor chat a send lands in (the thread itself, or the one a
  // Codex thread is hosted in) is waiting on background tasks.
  // Read again at send time when it can be: a task started after the scan
  // would otherwise queue the message behind it.
  const conductorBusy = async (thread, target) => {
    if (target?.app !== "conductor") return false;
    let chat = thread.kind === "conductor" ? thread : null;
    if (!chat && target.sessionId) {
      let threads = [];
      try { threads = knownThreads() ?? []; } catch { threads = []; }
      chat = threads.find((item) => item?.kind === "conductor" && item.id === target.sessionId) ?? null;
    }
    const sessionId = chat?.id ?? target.sessionId;
    if (refreshThread && sessionId) {
      try {
        const fresh = await within(Promise.resolve().then(() => refreshThread({ kind: "conductor", id: sessionId, key: `conductor:${sessionId}` })), BUSY_REFRESH_MS);
        if (fresh) chat = fresh;
      } catch { /* the scan's reading stands */ }
    }
    return Boolean(chat) && (chat.agentStatus === "waiting" || (chat.openTasks?.length ?? 0) > 0);
  };

  // A Conductor chat waiting on background tasks queues what is sent to it
  // until they end: the supervisor's messages are about now, so they are
  // sent now (⌘↩) unless the caller asked to queue.
  const typeInApp = async (thread, step, base, actionId, text, spentMs, deadlineAt, queue = false) => {
    const busy = await conductorBusy(thread, step.target);
    const target = step.target;
    const entered = Date.now();
    const evidenceName = actionId ?? `${thread.kind}-${String(thread.id).slice(0, 8)}-${Date.now()}`;
    let result;
    const locked = await uiLock.run(async () => {
      let threads = [];
      try { threads = knownThreads() ?? []; } catch { threads = []; }
      const identity = uiIdentity(thread, target, threads);
      const guard = unconfirmed.get(target.targetKey);
      const previousUnconfirmed = guard?.hash === base.messageHash ? { priorCount: guard.priorCount } : false;
      try {
        // busyNow: read again at the final send step (a task can start
        // while the app is opened and the text typed).
        return await ui.deliver({ thread, text, target, identity, previousUnconfirmed, evidenceName, spentMs: spentMs + (Date.now() - entered), deadlineAt, busy, queue, sendNow: busy && !queue, busyNow: () => conductorBusy(thread, target) });
      } catch (error) {
        return { status: "failed", detail: `computer use failed: ${detailText(error?.message ?? error)}; nothing confirmed` };
      }
    }, { waitMs: limits.uiLockWaitMs });
    if (locked.busy) result = { status: "blocked", detail: "busy: another app delivery is running; retry" };
    else result = locked.value ?? { status: "failed", detail: "computer use returned nothing" };
    const status = ["sent", "failed", "blocked"].includes(result.status) ? result.status : "failed";
    const detail = detailText(result.detail || status);
    const priorCount = Number.isInteger(result.priorCount) ? result.priorCount : null;
    if (status === "sent") unconfirmed.delete(target.targetKey);
    else if (result.unconfirmed) unconfirmed.set(target.targetKey, { hash: base.messageHash, priorCount });
    const extra = {};
    if (Array.isArray(result.evidence) && result.evidence.length) extra.evidence = result.evidence;
    if (result.unconfirmed) extra.unconfirmed = true;
    // A permission card the send found, and a failure kind (appUnreadable),
    // for the supervisor to act on.
    if (result.prompt && typeof result.prompt === "object") extra.prompt = result.prompt;
    if (typeof result.code === "string") extra.code = result.code;
    // A blocked UI send typed nothing: journal it only against an existing
    // action, like every other blocked delivery. The target and guard state
    // are journaled so a restarted executor can rebuild the guard.
    let id = actionId;
    const guardFields = { uiTargetKey: target.targetKey, unconfirmed: Boolean(result.unconfirmed), priorCount };
    if (status !== "blocked" || actionId) id = journal(actionId, { ...base, status, detail, ...extra, ...guardFields, finishedAt: new Date().toISOString() });
    return { status, route: base.route, detail, actionId: id ?? null, ...extra };
  };

  const launch = (thread, step, base, actionId, env) => {
    const id = journal(actionId, { ...base, status: "sent", running: true, detail: "started", startedAt: new Date().toISOString() });
    let reached = true;
    // The child's end, journaled: at once, or when a detached turn ends.
    const settle = (result) => {
      const ok = !result?.error && !result?.timedOut && result?.code === 0;
      if (!id) return;
      const output = result?.tail ?? `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
      const detail = ok
        ? lastLine(output) || "finished"
        : summariseExecFailure(output) || (result?.timedOut ? "timed out" : "") || firstLine(result?.error) || lastLine(output) || `exit ${result?.code}`;
      journal(id, {
        status: ok ? "done" : "failed",
        running: false,
        exitCode: result?.code ?? null,
        detail,
        logFile: writeLog(thread, output),
        finishedAt: new Date().toISOString()
      });
    };
    // A turn still running at the ceiling is left running, never killed: the
    // thread stays in flight until it ends, or at most detachedReleaseMs.
    let detached = false;
    let exited = false;
    let released = false;
    let releaseTimer = null;
    const ended = () => active.delete(thread.key);
    const onExit = (result) => {
      exited = true;
      clearTimeout(releaseTimer);
      try { settle(result); } catch { /* journaling is best-effort */ }
      // Released earlier: a newer send may hold the thread now.
      if (!released) ended();
    };
    const release = () => {
      if (exited) return;
      released = true;
      const hours = Math.round((BACKGROUND_TIMEOUT_MS + detachedReleaseMs) / 3_600_000);
      if (id) journal(id, { running: true, detail: `still running after ${hours} h: left running, no longer holds the thread` });
      ended();
    };
    const task = Promise.resolve()
      .then(() => background(step.cmd, step.args, { cwd: step.cwd, env, timeoutMs: BACKGROUND_TIMEOUT_MS, detach: true, onExit }))
      .catch((error) => ({ code: null, timedOut: false, error: error?.message ?? String(error) }))
      .then((result) => {
        if (result?.detached) {
          detached = true;
          if (exited) return;
          if (id) journal(id, { running: true, detail: `still running after ${Math.round(BACKGROUND_TIMEOUT_MS / 60_000)} min: left running, not killed` });
          releaseTimer = setTimeout(release, detachedReleaseMs);
          releaseTimer.unref?.();
          return;
        }
        const ok = !result?.error && !result?.timedOut && result?.code === 0;
        // Spawn errors and non-zero exits never reached the agent; a timeout
        // did. Only the caller knows whether this send was a counted nudge,
        // so it gives the attempt back from done, not the executor.
        if (!ok && !result?.timedOut) reached = false;
        settle(result);
      })
      .catch(() => { /* journaling is best-effort */ })
      .finally(() => {
        if (!detached) ended();
        pending.delete(task);
      });
    pending.add(task);
    const sent = { status: "sent", route: base.route, detail: "started in background", actionId: id };
    // Resolves to whether the child reached the agent. Not enumerable, so the
    // delivery JSON the routes return stays the same.
    Object.defineProperty(sent, "done", { value: task.then(() => reached) });
    return sent;
  };

  // The background route a presence-blocked app send takes, re-checked at
  // send time: the scan's lock, peer and chat reads are up to a tick old.
  // Anything unreadable now means no background route.
  // why.locked: refused because a Codex writer holds the thread.
  async function fallbackRoute(thread, target, deadlineAt, why = {}) {
    const route = backgroundRouteFor(thread, config);
    if (!route) {
      // The Codex app owns its threads even while it has not loaded one.
      if (thread?.kind === "codex" && (thread.writerLocked || codexAppOwned(thread))) why.locked = true;
      return null;
    }
    // An earlier app send may sit in that composer unconfirmed.
    if (unconfirmed.has(target.targetKey)) return null;
    // A remote caller's deadline bounds the checks too, not only the send.
    const left = Number.isFinite(deadlineAt) ? deadlineAt - DEADLINE_MARGIN_MS - Date.now() : Infinity;
    if (left < (route === "peer-relay" ? RELAY_MIN_MS + FALLBACK_MIN_MS : FALLBACK_MIN_MS)) return null;
    if (route === "codex-exec") {
      // A lock file a crash left behind holds nothing: who holds it decides,
      // as in the scan.
      if (!paths.codexHome) return null;
      let locked;
      try { locked = await readWriterLocks(config, [thread.id], { run: runner, isPidAlive }); } catch { return null; }
      if (!locked.has(thread.id)) return route;
      why.locked = true;
      return null;
    }
    if (!readLivePeers || !refreshThread) return null;
    let peers = null;
    try { peers = readLivePeers(config); } catch { return null; }
    const peer = [thread.claudeSessionId, thread.id].map((id) => id && peers?.get(id)).find(Boolean);
    if (!peer?.peerName || peer.status !== "idle" || peer.waitingFor) return null;
    // The chat as it is now: no new pick, prompt, turn or message since the
    // scan, and still the same idle peer.
    let fresh = null;
    try { fresh = await within(Promise.resolve().then(() => refreshThread(thread)), Math.min(REFRESH_MAX_MS, left - RELAY_MIN_MS)); } catch { return null; }
    if (!fresh || fresh.agentStatus === "running" || fresh.meta?.blockedOnOwner === true || fresh.meta?.pendingQuestion) return null;
    if ((Date.parse(fresh.lastActivityAt ?? "") || 0) > (Date.parse(thread.lastActivityAt ?? "") || 0)) return null;
    if (!fresh.live?.peerName || fresh.live.pid !== peer.pid || fresh.live.status !== "idle") return null;
    return { route, live: { ...thread.live, peerName: fresh.live.peerName, pid: fresh.live.pid, status: fresh.live.status } };
  }

  async function deliver({ thread, message, route, dryRun = false, actionId = null, playbook = null, spentMs = 0, deadlineAt = null, fallbackFrom = null, queue = false } = {}) {
    const blocked = (detail) => {
      if (actionId) journal(actionId, { status: "blocked", detail });
      return { status: "blocked", route: ROUTES.includes(route) ? route : null, detail, actionId };
    };
    const reason = checkPreconditions(thread, route, message, config, Boolean(fallbackFrom));
    // Only the app can queue a message behind a Conductor chat's background
    // tasks: a relay or resume would deliver it now.
    if (!reason && queue && route !== "computer-use" && (thread.kind === "conductor" || thread.meta?.conductorHost)) return blocked("queue needs the Conductor app: not sent another way");
    if (reason) return blocked(reason);
    // The scan's liveness is a snapshot; a session opened since then would fork.
    if (route === "claude-resume" && readLivePeers) {
      let peers = null;
      try { peers = readLivePeers(config); } catch { /* unknown below */ }
      if (!peers) return blocked("live-session check failed: scan again");
      if ([thread.id, thread.claudeSessionId].some((id) => id && peers.has(id))) return blocked("live session: use peer-relay");
    }
    if (active.has(thread.key)) return blocked("in flight: a send to this thread has not finished");
    // The composer takes one line; the journaled hash is of what is typed.
    const text = route === "computer-use" ? flattenMessage(withPrefix(message)) : withPrefix(message);
    const step = plan(thread, route, text);
    if (step.blocked) return blocked(step.blocked);
    if (dryRun) return { status: "dry-run", route, detail: step.ui ? `would ${step.describe}` : `would run ${step.describe}`, actionId };

    const base = { threadKey: thread.key, route, playbook, messageHash: shortHash(text), ...(fallbackFrom ? { fallbackFrom } : {}) };
    if (step.ui) {
      if (!ui?.deliver) return blocked("computer use unavailable on this Mac");
      // One Conductor session can be reached through two fleet threads (its
      // own row and the Codex thread it hosts).
      if (active.has(step.target.targetKey)) return blocked("in flight: a send to this thread has not finished");
      active.add(thread.key);
      active.add(step.target.targetKey);
      let result;
      try {
        result = await typeInApp(thread, step, base, actionId, text, spentMs, deadlineAt, queue);
      } finally {
        active.delete(thread.key);
        active.delete(step.target.targetKey);
      }
      // The owner is at the Mac, or the Codex app cannot show which thread is
      // open: a route that does not take the screen, if the owner allowed one
      // for this thread. Otherwise it waits for idle.
      // A send asked to queue never goes another way: a relay arrives now.
      const identity = isCodexIdentityBlock(thread, result);
      if (!(isPresenceBlock(result) || identity) || (queue && step.target?.app === "conductor")) return result;
      const why = {};
      const fallback = await fallbackRoute(thread, step.target, deadlineAt, why);
      if (!fallback && identity && why.locked) {
        const detail = detailText(`${result.detail}; ${CODEX_APP_HOLDS}`);
        if (result.actionId) journal(result.actionId, { detail });
        return { ...result, detail };
      }
      if (!fallback) return result;
      const via = typeof fallback === "object" ? fallback : { route: fallback, live: thread.live };
      return deliver({ thread: { ...thread, live: via.live }, message, route: via.route, actionId: result.actionId ?? actionId, playbook, spentMs, deadlineAt, fallbackFrom: result.detail });
    }
    // A remote caller (deadlineAt) reports failure at its deadline: nothing
    // starts after it, and a relay gets only what is left, less the trip back
    // and the kill grace runCommand adds when the child ignores SIGTERM.
    const left = Number.isFinite(deadlineAt) ? deadlineAt - DEADLINE_MARGIN_MS - Date.now() : Infinity;
    if (step.api) {
      const apiMs = left - DEFAULTS.uiKillGraceMs;
      if (apiMs < AGENTAPI_MIN_MS) return blocked("no time left in this request to deliver; not sent, retry");
      active.add(thread.key);
      try {
        return await apiSend(thread, step, base, actionId, blocked, Math.min(AGENTAPI_TIMEOUT_MS, apiMs));
      } finally {
        active.delete(thread.key);
      }
    }
    const relayMs = left - DEFAULTS.uiKillGraceMs;
    if (step.background ? left <= 0 : relayMs < RELAY_MIN_MS) return blocked("no time left in this request to deliver; not sent, retry");
    active.add(thread.key);
    const env = childEnv(route);
    if (step.background) return launch(thread, step, base, actionId, env);
    try {
      return await relay(thread, step, base, actionId, env, Math.min(RELAY_TIMEOUT_MS, relayMs));
    } finally {
      active.delete(thread.key);
    }
  }

  return {
    deliver,
    inFlight: () => [...active].filter((key) => !/^(conductor-session|codex-thread):/.test(key)),
    // Resolves once every background send has finished and been journaled.
    whenIdle: async () => {
      while (pending.size) await Promise.allSettled([...pending]);
    }
  };
}
