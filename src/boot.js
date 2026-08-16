import fs from "node:fs";
import path from "node:path";
import { createDurableRuntime, createHostedInterface } from "./index.js";
import { checkBindSafety } from "./auth.js";
import { hardenDataDir, loadEnvFile } from "./file-utils.js";
import { resolveDataDir, _resetDataDirCache } from "./data-dir.js";

// Read a single var from an env file WITHOUT importing the rest of its keys.
function peekEnvVar(file, key) {
  try {
    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i <= 0 || line.slice(0, i).trim() !== key) continue;
      let v = line.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      return v;
    }
  } catch { /* no file */ }
  return null;
}

// Resolve the data dir and load env files in the correct precedence, exactly
// as the hosted-server example does. Shared so the CLI (`openagi serve`), the
// example, and any other entry point boot identically.
//
// A cwd .env may set OPENAGI_DATA_DIR, which must be known BEFORE the data dir
// is resolved (resolveDataDir memoizes). We must NOT bulk-load the cwd .env
// first: its blank sample entries (OPENAI_API_KEY=, …) would shadow the real
// values in the canonical <dataDir>/.env, since loadEnvFile is first-wins. So:
// peek only OPENAGI_DATA_DIR, resolve, load the canonical file (authoritative),
// then let the cwd .env fill any remaining gaps.
export function loadBootEnv() {
  const cwdDataDir = peekEnvVar(".env", "OPENAGI_DATA_DIR");
  if (cwdDataDir && !process.env.OPENAGI_DATA_DIR) process.env.OPENAGI_DATA_DIR = cwdDataDir;
  _resetDataDirCache();
  const dataDir = resolveDataDir();
  loadEnvFile(path.join(dataDir, ".env")); // canonical — authoritative (first-wins)
  loadEnvFile(".env");                       // cwd .env fills only keys the canonical didn't set
  return dataDir;
}

// A misconfigured, unreachable, or reauth-needed MCP server rejects
// asynchronously during connect — a 401 (expired/invalid token), an OAuth
// callback timeout, a DNS failure. Those are recoverable: the server just needs
// to be reconnected or re-authed, and it already records its own lastError +
// surfaces "needs auth" via status/SSE. But Node 15+ TERMINATES the process on
// any unhandled rejection, so without a top-level guard one stray MCP error
// takes down the whole agent — and the supervisor restarts it straight into the
// same failure (a crash loop). Log and keep running instead. Installed once,
// before the runtime/MCP connects, so it covers every daemon launch (the CLI,
// this example, systemd, the Mac DaemonController) identically.
let crashGuardsInstalled = false;
export function installCrashGuards() {
  if (crashGuardsInstalled) return;
  crashGuardsInstalled = true;
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    console.error(`[openagi] unhandled rejection ${livenessNote()}: ${err.stack || err.message}`);
  });
  // An uncaught synchronous exception can leave state undefined, but for a
  // supervised, always-on daemon staying up beats crash-looping; the error is
  // logged loudly so it's still diagnosable in daemon.log / journald.
  process.on("uncaughtException", (err) => {
    console.error(`[openagi] uncaught exception ${livenessNote()}: ${err?.stack || err}`);
  });
}

// ─── Startup failures must be non-zero ────────────────────────────────────
//
// "Kept alive" is only true once there is something alive to keep. Before the
// interface is listening these guards were a trap: a corrupt snapshot threw out
// of the runtime constructor, the guard logged it, nothing was left on the event
// loop, and the process exited 0. launchd's KeepAlive{SuccessfulExit=false}
// reads exit 0 as "it meant to stop" and never restarts — a silently, and
// permanently, dead assistant. `openagi serve` reached the same place by a
// different road: main() catches, returns 1, and then skips process.exit for
// the serve command.
//
// So instead of trying to intercept every route out, we assert the invariant at
// the only place they all converge: if the process is exiting and the server
// never came up, the exit code is wrong and we correct it. The supervisor then
// restarts, which is the right answer for a transient fault and a visible,
// throttled crash-loop for a permanent one — either beats dying quietly.
let bootPhase = "idle"; // idle → starting → running
let startupExitGuardInstalled = false;

function livenessNote() {
  return bootPhase === "starting" ? "(during startup — fatal)" : "(kept alive)";
}

function armStartupExitGuard() {
  bootPhase = "starting";
  if (startupExitGuardInstalled) return;
  startupExitGuardInstalled = true;
  process.on("exit", (code) => {
    if (bootPhase === "running" || code !== 0) return;
    console.error(
      "[openagi] FATAL: the server never finished starting — exiting 1 so launchd/systemd " +
      "restarts it. (Exit 0 here would be read as a clean, intentional stop and the daemon " +
      "would stay dead until the next login.)"
    );
    process.exitCode = 1;
  });
}

// Boot env + start the hosted interface. Returns the listen address.
// host/port fall back to HOST/PORT env then sane defaults; callers (the CLI)
// can override.
//
// Binding to a non-loopback address is safe ONLY when OPENAGI_AUTH_TOKEN is
// set. It is not otherwise: checkAuth() treats an unset token as "auth
// disabled" and serves everything. The Docker image sets HOST=0.0.0.0 and the
// Linux installer used to set no token, which is precisely that hole — so this
// is enforced here, fatally, rather than warned about.
export async function startServer({ host, port } = {}) {
  installCrashGuards();
  armStartupExitGuard();
  const dataDir = loadBootEnv();
  // Screen OCR, message-derived content, transcripts, memory and scheduled
  // prompts all live here, and every install created before this shipped has
  // 0755 directories and 0644 SQLite databases on disk. Tighten in place on
  // each boot — best-effort, mode bits only, idempotent. See hardenDataDir().
  hardenDataDir(dataDir);
  const resolvedHost = host ?? process.env.HOST ?? "127.0.0.1";
  const resolvedPort = Number.parseInt(String(port ?? process.env.PORT ?? "43210"), 10);

  // FAIL CLOSED. process.exit rather than throw, deliberately. A throw here
  // takes a long way round: installCrashGuards() swallows it as an unhandled
  // rejection, `openagi serve` catches it and then skips process.exit for the
  // serve command, and it is only the startup exit guard above that finally
  // corrects the code — printing a "restarts it" message that is wrong for
  // this fault, since restarting a misconfigured bind just repeats it. This is
  // a configuration refusal, not a crash: say so once and stop.
  const safety = checkBindSafety({ host: resolvedHost, token: process.env.OPENAGI_AUTH_TOKEN });
  if (!safety.ok) {
    console.error(safety.message);
    process.exit(1);
  }

  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: resolvedHost, port: resolvedPort });
  const address = await app.listen();
  let shuttingDown = false;
  const originalClose = app.close.bind(app);
  const onSignal = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const force = setTimeout(() => process.exit(1), 5_000);
    originalClose()
      .then(() => { clearTimeout(force); process.exit(0); })
      .catch(() => { clearTimeout(force); process.exit(1); });
  };
  const onTerm = () => onSignal("SIGTERM");
  const onInt = () => onSignal("SIGINT");
  process.once("SIGTERM", onTerm);
  process.once("SIGINT", onInt);
  app.close = async () => {
    process.removeListener("SIGTERM", onTerm);
    process.removeListener("SIGINT", onInt);
    return await originalClose();
  };
  bootPhase = "running"; // boot survived; from here on an exit 0 is a real one
  return { app, runtime, address, dataDir, host: resolvedHost, port: resolvedPort };
}
