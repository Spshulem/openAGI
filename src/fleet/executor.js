// Delivers supervisor text to one agent thread through the routes in the
// spec: codex exec resume, a claude -p SendMessage relay to a live peer,
// claude -p --resume, and computer-use (typed into the app that shows the
// thread, see ui-delivery.js). This is the only fleet unit that writes to
// other processes, so it re-checks every precondition instead of trusting policy.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../file-utils.js";
import { CONDUCTOR_CODEX_ORIGINATOR, DEFAULTS, DEFAULT_RELAY_MODEL, ROUTES, SUPERVISOR_PREFIX, clampText, isPidAlive, parseEnvText, redactSecrets, runCommand, shortHash, uiTargetFor } from "./contracts.js";
import { readWriterLocks } from "./sources/codex.js";
import { classifyErrorText } from "./errors.js";
import { DEADLINE_MARGIN_MS, UI_LOCK, flattenMessage, uiIdentity } from "./ui-delivery.js";

export const MESSAGE_PREFIX = `${SUPERVISOR_PREFIX} `;

const RELAY_TIMEOUT_MS = 180_000;
// A relay cut short can still have delivered (then a retry duplicates it),
// so one is not started for a remote caller with less time than this left.
const RELAY_MIN_MS = 60_000;
// A resumed turn can run for an hour (CI waits, bb-quick). Only the child we
// spawned is ever killed, and only after this ceiling.
const BACKGROUND_TIMEOUT_MS = 2 * 60 * 60 * 1000;
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
export function spawnWithTail(cmd, args = [], { cwd, env, timeoutMs = BACKGROUND_TIMEOUT_MS, killGraceMs = KILL_GRACE_MS } = {}) {
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
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ ...result, tail: tail.slice(-TAIL_CHARS) });
    };
    const timer = setTimeout(() => {
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

// The non-UI route a presence-blocked app send may take instead, if the owner
// allowed it (config.backgroundRoutes) and it cannot fork or queue unseen:
// codex-exec only for a Codex thread no app holds (no writer, so nothing
// moved it since the scan) and Conductor did not start; peer-relay only for
// a Conductor chat whose live Claude session is idle, with no open pick.
export function backgroundRouteFor(thread, config) {
  const allowed = config?.backgroundRoutes ?? [];
  if (!allowed.length || !thread || thread.archived || thread.agentStatus === "running" || thread.meta?.blockedOnOwner === true) return null;
  if (thread.kind === "codex") {
    if (!allowed.includes("codex-exec") || thread.writerLocked || !thread.cwd || thread.meta?.originator === CONDUCTOR_CODEX_ORIGINATOR) return null;
    return "codex-exec";
  }
  if (thread.kind === "conductor" && allowed.includes("peer-relay") && thread.live?.peerName && thread.live?.pid && thread.live.status === "idle" && !thread.meta?.pendingQuestion) return "peer-relay";
  return null;
}

function checkPreconditions(thread, route, message, config, fallback = false) {
  if (!thread?.key) return "no thread";
  if (!ROUTES.includes(route)) return "no delivery route";
  if (!String(message ?? "").trim()) return "empty message";
  if (isSelf(thread, config)) return "the supervisor's own session";
  if (thread.archived) return "archived";
  // On a computer-use-only Mac no send ever runs a CLI, whatever an older
  // proposal or caller asked for.
  if (config?.delivery === "computer-use" && route !== "computer-use" && !(fallback && config.backgroundRoutes?.includes(route))) return "computer-use delivery only: CLI routes are off";
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
    if (!isDirectory(thread.cwd)) return "cwd missing";
  }
  if (route === "peer-relay" && !thread.live?.peerName) return "no live peer";
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
// background route after a presence block needs it for Conductor chats.
export function createExecutor({ config, run, store = null, logDir, spawnBackground, readLivePeers = null, refreshThread = null, ui = null, knownThreads = () => [], uiLock = UI_LOCK } = {}) {
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
        "-p", buildRelayPrompt(peerName, text),
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

  // Synchronous: the result is final when this returns, so there is no done
  // promise and nothing for reopenIfUndelivered to wait on.
  // spentMs: what the caller's request already spent; the lock wait adds to it.
  // deadlineAt: when a remote caller stops waiting (null: no such caller).
  const typeInApp = async (thread, step, base, actionId, text, spentMs, deadlineAt) => {
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
        return await ui.deliver({ thread, text, target, identity, previousUnconfirmed, evidenceName, spentMs: spentMs + (Date.now() - entered), deadlineAt });
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
    const task = Promise.resolve()
      .then(() => background(step.cmd, step.args, { cwd: step.cwd, env, timeoutMs: BACKGROUND_TIMEOUT_MS }))
      .catch((error) => ({ code: null, timedOut: false, error: error?.message ?? String(error) }))
      .then((result) => {
        const ok = !result?.error && !result?.timedOut && result?.code === 0;
        // Spawn errors and non-zero exits never reached the agent; a timeout
        // did. Only the caller knows whether this send was a counted nudge,
        // so it gives the attempt back from done, not the executor.
        if (!ok && !result?.timedOut) reached = false;
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
      })
      .catch(() => { /* journaling is best-effort */ })
      .finally(() => {
        active.delete(thread.key);
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
  async function fallbackRoute(thread, target) {
    const route = backgroundRouteFor(thread, config);
    if (!route) return null;
    // An earlier app send may sit in that composer unconfirmed.
    if (unconfirmed.has(target.targetKey)) return null;
    if (route === "codex-exec") {
      // A lock file a crash left behind holds nothing: who holds it decides,
      // as in the scan.
      if (!paths.codexHome) return null;
      let locked;
      try { locked = await readWriterLocks(config, [thread.id], { run: runner, isPidAlive }); } catch { return null; }
      return locked.has(thread.id) ? null : route;
    }
    if (!readLivePeers || !refreshThread) return null;
    let peers = null;
    try { peers = readLivePeers(config); } catch { return null; }
    const peer = [thread.claudeSessionId, thread.id].map((id) => id && peers?.get(id)).find(Boolean);
    if (!peer?.peerName || peer.status !== "idle" || peer.waitingFor) return null;
    // The chat as it is now: no new pick, prompt, turn or message since the scan.
    let fresh = null;
    try { fresh = await refreshThread(thread); } catch { return null; }
    if (!fresh || fresh.agentStatus === "running" || fresh.meta?.blockedOnOwner === true || fresh.meta?.pendingQuestion) return null;
    if ((Date.parse(fresh.lastActivityAt ?? "") || 0) > (Date.parse(thread.lastActivityAt ?? "") || 0)) return null;
    return { route, live: { ...thread.live, peerName: peer.peerName, pid: peer.pid, status: peer.status } };
  }

  async function deliver({ thread, message, route, dryRun = false, actionId = null, playbook = null, spentMs = 0, deadlineAt = null, fallbackFrom = null } = {}) {
    const blocked = (detail) => {
      if (actionId) journal(actionId, { status: "blocked", detail });
      return { status: "blocked", route: ROUTES.includes(route) ? route : null, detail, actionId };
    };
    const reason = checkPreconditions(thread, route, message, config, Boolean(fallbackFrom));
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
        result = await typeInApp(thread, step, base, actionId, text, spentMs, deadlineAt);
      } finally {
        active.delete(thread.key);
        active.delete(step.target.targetKey);
      }
      // The owner is at the Mac: a route that does not take the screen, if
      // the owner allowed one for this thread. Otherwise it waits for idle.
      if (!isPresenceBlock(result)) return result;
      const fallback = await fallbackRoute(thread, step.target);
      if (!fallback) return result;
      const via = typeof fallback === "object" ? fallback : { route: fallback, live: thread.live };
      return deliver({ thread: { ...thread, live: via.live }, message, route: via.route, actionId: result.actionId ?? actionId, playbook, spentMs, deadlineAt, fallbackFrom: result.detail });
    }
    // A remote caller (deadlineAt) reports failure at its deadline: nothing
    // starts after it, and a relay gets only what is left, less the trip back
    // and the kill grace runCommand adds when the child ignores SIGTERM.
    const left = Number.isFinite(deadlineAt) ? deadlineAt - DEADLINE_MARGIN_MS - Date.now() : Infinity;
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
