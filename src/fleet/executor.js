// Delivers supervisor text to one agent thread through the three routes in
// the spec: codex exec resume, a claude -p SendMessage relay to a live peer,
// and claude -p --resume. This is the only fleet unit that writes to other
// processes, so it re-checks every precondition instead of trusting policy.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../file-utils.js";
import { DEFAULT_RELAY_MODEL, ROUTES, SUPERVISOR_PREFIX, clampText, parseEnvText, redactSecrets, runCommand, shortHash } from "./contracts.js";
import { classifyErrorText } from "./errors.js";

export const MESSAGE_PREFIX = `${SUPERVISOR_PREFIX} `;

const RELAY_TIMEOUT_MS = 180_000;
// A resumed turn can run for an hour (CI waits, bb-quick). Only the child we
// spawned is ever killed, and only after this ceiling.
const BACKGROUND_TIMEOUT_MS = 2 * 60 * 60 * 1000;
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
export function spawnWithTail(cmd, args = [], { cwd, env, timeoutMs = BACKGROUND_TIMEOUT_MS } = {}) {
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
    const keep = (chunk) => {
      tail += chunk.toString("utf8");
      if (tail.length > TAIL_CHARS * 2) tail = tail.slice(-TAIL_CHARS);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, tail: tail.slice(-TAIL_CHARS) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
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

function checkPreconditions(thread, route, message, config) {
  if (!thread?.key) return "no thread";
  if (!ROUTES.includes(route)) return "no delivery route";
  if (!String(message ?? "").trim()) return "empty message";
  if (isSelf(thread, config)) return "the supervisor's own session";
  if (thread.archived) return "archived";
  if (route === "codex-exec") {
    if (thread.kind !== "codex") return "codex-exec needs a codex thread";
    if (thread.writerLocked) return "writer-locked: the thread is open in another Codex writer";
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

export function createExecutor({ config, run, store = null, logDir, spawnBackground } = {}) {
  const runner = run ?? runCommand;
  // An injected run (tests, dry harnesses) also serves the background routes.
  const background = spawnBackground ?? (run ? run : spawnWithTail);
  const logsDir = logDir ?? (store?.dir ? path.join(store.dir, "logs") : null);
  const bins = config?.bins ?? {};
  const paths = config?.paths ?? {};
  const active = new Set();
  const pending = new Set();

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

  const relay = async (thread, step, base, actionId, env) => {
    try { ensureDir(step.cwd); } catch { /* the runner surfaces a real failure */ }
    let result;
    try {
      result = await runner(step.cmd, step.args, { cwd: step.cwd, env, timeoutMs: RELAY_TIMEOUT_MS });
    } catch (error) {
      result = { code: null, stdout: "", stderr: "", timedOut: false, error: error?.message ?? String(error) };
    }
    const stdout = String(result?.stdout ?? "").trim();
    const output = `${stdout} ${result?.stderr ?? ""}`.trim();
    let detail = null;
    if (result?.timedOut) {
      detail = `relay timed out after ${RELAY_TIMEOUT_MS / 1000}s`;
    } else if (result?.error || result?.code !== 0) {
      detail = `relay failed: ${summariseRelayFailure(output, step.cwd) || firstLine(result?.error) || firstLine(result?.stderr) || `exit ${result?.code}`}`;
    } else {
      const refusal = summariseRelayFailure(stdout, step.cwd);
      if (refusal) detail = `relay failed: ${refusal}`;
      else if (!/\bDONE\b/i.test(stdout)) detail = `relay did not confirm delivery: ${detailText(stdout) || "(no output)"}`;
    }
    const status = detail ? "failed" : "sent";
    const finalDetail = detail ? detailText(detail) : `relayed to ${thread.live.peerName}`;
    const id = journal(actionId, { ...base, status, detail: finalDetail, finishedAt: new Date().toISOString() });
    return { status, route: base.route, detail: finalDetail, actionId: id };
  };

  const launch = (thread, step, base, actionId, env) => {
    const id = journal(actionId, { ...base, status: "sent", running: true, detail: "started", startedAt: new Date().toISOString() });
    const task = Promise.resolve()
      .then(() => background(step.cmd, step.args, { cwd: step.cwd, env, timeoutMs: BACKGROUND_TIMEOUT_MS }))
      .catch((error) => ({ code: null, timedOut: false, error: error?.message ?? String(error) }))
      .then((result) => {
        const ok = !result?.error && !result?.timedOut && result?.code === 0;
        // Spawn errors and non-zero exits never reached the agent, so they
        // must not count toward "N nudges without progress". A timeout did.
        if (!ok && !result?.timedOut) {
          try { store?.undoAttempt?.(thread.key); } catch { /* best-effort */ }
        }
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
    return { status: "sent", route: base.route, detail: "started in background", actionId: id };
  };

  async function deliver({ thread, message, route, dryRun = false, actionId = null, playbook = null } = {}) {
    const blocked = (detail) => {
      if (actionId) journal(actionId, { status: "blocked", detail });
      return { status: "blocked", route: ROUTES.includes(route) ? route : null, detail, actionId };
    };
    const reason = checkPreconditions(thread, route, message, config);
    if (reason) return blocked(reason);
    if (active.has(thread.key)) return blocked("in flight: a send to this thread has not finished");
    const text = withPrefix(message);
    const step = plan(thread, route, text);
    if (dryRun) return { status: "dry-run", route, detail: `would run ${step.describe}`, actionId };

    const base = { threadKey: thread.key, route, playbook, messageHash: shortHash(text) };
    active.add(thread.key);
    const env = childEnv(route);
    if (step.background) return launch(thread, step, base, actionId, env);
    try {
      return await relay(thread, step, base, actionId, env);
    } finally {
      active.delete(thread.key);
    }
  }

  return {
    deliver,
    inFlight: () => [...active],
    // Resolves once every background send has finished and been journaled.
    whenIdle: async () => {
      while (pending.size) await Promise.allSettled([...pending]);
    }
  };
}
