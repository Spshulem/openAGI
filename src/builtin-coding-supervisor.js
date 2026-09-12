import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { readJsonFile, writeJsonAtomic, ensureDir } from "./file-utils.js";

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const PROVIDERS = ["codex", "claude"];
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,99}$/;
const ID = /^[a-f0-9-]{36}$/;
const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_RUN_MS = 10 * 60_000;

export function codingChildEnv(env = process.env) {
  return Object.fromEntries(["HOME", "USER", "PATH", "LANG", "TMPDIR", "CODEX_HOME"]
    .filter(key => env[key] !== undefined).map(key => [key, env[key]]));
}

export function findCodingExecutable(provider, env = process.env) {
  if (!PROVIDERS.includes(provider)) return null;
  const dirs = [...String(env.PATH || "").split(path.delimiter), path.join(os.homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const dir of dirs.filter(path.isAbsolute)) {
    const file = path.join(dir, provider);
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return fs.realpathSync(file); } catch { /* next */ }
  }
  return null;
}

// Fixed argument vectors, never a shell command. Task text travels on stdin.
// Claude retains its manual provider gate. Codex is explicitly read-only;
// broader coding permissions are not silently inherited from user config.
export function codingArguments(provider, { nativeId, model, effort } = {}) {
  if (!PROVIDERS.includes(provider)) throw new Error("Unknown coding provider.");
  if (model && !MODEL.test(model)) throw new Error("Invalid model identifier.");
  if (nativeId && !ID.test(nativeId)) throw new Error("Invalid provider session identifier.");
  if (effort && !["low", "medium", "high"].includes(effort)) throw new Error("Unsupported reasoning effort.");
  if (provider === "codex") return ["exec", "--json", "--color", "never", "--sandbox", "read-only", "--ignore-user-config",
    ...(model ? ["--model", model] : []), ...(effort ? ["-c", `model_reasoning_effort=${JSON.stringify(effort)}`] : []),
    ...(nativeId ? ["resume", nativeId] : []), "-"];
  return ["--print", "--verbose", "--output-format", "stream-json", "--permission-mode", "manual",
    "--permission-prompts", "none", "--setting-sources", "", "--settings", '{"disableAllHooks":true}',
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    ...(nativeId ? ["--resume", nativeId] : []), ...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : [])];
}

export class BuiltinCodingSupervisor {
  constructor({ dataDir, spawnImpl = spawn, findExecutable = findCodingExecutable, timeoutMs = MAX_RUN_MS, killGraceMs = 2000, onChange = () => {} }) {
    this.dir = path.join(dataDir, "coding-supervisor", "builtin");
    this.configFile = path.join(this.dir, "config.json");
    this.config = readJsonFile(this.configFile, { enabled: false, workspaces: [] });
    this.spawn = spawnImpl;
    this.findExecutable = findExecutable;
    this.timeoutMs = timeoutMs;
    this.killGraceMs = killGraceMs;
    this.onChange = onChange;
    this.children = new Map();
    this.records = new Map();
    const saved = readJsonFile(path.join(this.dir, "sessions.json"), []);
    for (const row of Array.isArray(saved) ? saved.slice(-100) : []) {
      if (!ID.test(row.id || "") || !PROVIDERS.includes(row.provider)) continue;
      // A saved PID is never authority to kill or resume another process.
      if (row.status === "working") row.status = "interrupted";
      this.records.set(row.id, row);
    }
  }

  configure({ enabled, workspaces }) {
    if (this.children.size) throw new Error("Stop managed sessions before changing configuration.");
    // Omission keeps the owner's saved selection; an explicit list replaces it.
    if (workspaces === undefined) workspaces = this.config.workspaces.map(w => w.path);
    if (typeof enabled !== "boolean" || !Array.isArray(workspaces) || workspaces.length > 20) throw new Error("Choose up to 20 workspace folders.");
    if (enabled && workspaces.length === 0) throw new Error("Choose at least one Git project folder before enabling.");
    const selected = workspaces.map(value => {
      if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("Workspace folders must be absolute paths.");
      const real = fs.realpathSync(value);
      if (!fs.statSync(real).isDirectory() || real === path.parse(real).root || real === os.homedir()) throw new Error("Choose a project folder, not a home or filesystem root.");
      if (!fs.existsSync(path.join(real, ".git"))) throw new Error("Choose an existing Git project folder.");
      return { id: hash(real), path: real, label: path.basename(real) };
    });
    if (new Set(selected.map(w => w.id)).size !== selected.length) throw new Error("Choose each workspace once.");
    this.config = { enabled, workspaces: selected };
    ensureDir(this.dir);
    writeJsonAtomic(this.configFile, this.config);
    return this.setup();
  }

  setup() {
    return { builtin: true, enabled: this.config.enabled === true,
      workspaces: (this.config.workspaces || []).map(({ id, label }) => ({ id, label })),
      providers: PROVIDERS.map(provider => ({ provider, installed: Boolean(this.findExecutable(provider)),
        authentication: "Sign in with the provider CLI; the first approved run verifies the account.",
        loginCommand: provider === "codex" ? "codex login" : "claude auth login" })),
      limitation: "Codex runs read-only. Claude keeps manual permissions; denied actions require review in Claude Code. No provider permissions are approved automatically. CLI usage is billed by your provider and is not capped by OpenAGI's chat budget." };
  }

  workspace(id) {
    const workspace = this.config.workspaces?.find(w => w.id === id);
    if (!this.config.enabled || !workspace || fs.realpathSync(workspace.path) !== workspace.path
      || !fs.existsSync(path.join(workspace.path, ".git"))) throw new Error("The approved workspace is no longer available.");
    return workspace;
  }

  prepare(args) {
    if (process.platform === "win32") throw new Error("The built-in supervisor currently supports macOS and Linux.");
    if (!PROVIDERS.includes(args.provider)) throw new Error("Choose Claude Code or Codex.");
    const workspace = this.workspace(args.workspaceId);
    if (!this.findExecutable(args.provider)) throw new Error("Install and sign in to the selected coding CLI first.");
    codingArguments(args.provider, args);
    if (typeof args.message !== "string" || !args.message.trim() || args.message.length > 4000 || args.message.includes("\0")) throw new Error("Enter an instruction of 1–4000 characters.");
    return { provider: args.provider, workspaceId: workspace.id, project: workspace.path, message: args.message,
      model: args.model || null, effort: args.effort || null, sessionId: crypto.randomUUID(), preparedAt: Date.now() };
  }

  save() { ensureDir(this.dir); writeJsonAtomic(path.join(this.dir, "sessions.json"), [...this.records.values()]); }
  notify() { try { this.onChange(); } catch { /* UI events cannot break process supervision. */ } }
  list() {
    return { sessions: [...this.records.values()].map(row => ({ provider: row.provider, sessionId: row.id, project: row.project,
      model: row.model, status: row.status, attentionBasis: "heuristic", fingerprint: row.fingerprint,
      replyAvailable: this.config.enabled && !this.children.has(row.id) && row.status !== "interrupted" && Boolean(row.nativeId),
      route: "builtin-cli", lastActivityAt: row.updatedAt })) };
  }
  target(args) {
    const row = this.records.get(args.sessionId);
    if (!row || row.provider !== args.provider) throw new Error("Unknown managed coding session.");
    return row;
  }
  inspect(args) { return { turns: this.target(args).turns.slice(-6) }; }

  start(args) {
    if (!ID.test(args.sessionId || "") || !Number.isFinite(args.preparedAt) || Date.now() - args.preparedAt > 600_000
      || args.preparedAt > Date.now()) throw new Error("Request a fresh start approval.");
    const startHash = hash(JSON.stringify([args.provider, args.workspaceId, args.message, args.model || null, args.effort || null]));
    if (this.records.has(args.sessionId)) {
      if (this.records.get(args.sessionId).startHash !== startHash) throw new Error("Start approval identity was reused for a different instruction.");
      return { provider: args.provider, sessionId: args.sessionId, status: "accepted", note: "This approved session was already started; inspect its recorded status." };
    }
    const workspace = this.workspace(args.workspaceId);
    this.prepare(args);
    // Expired approvals cannot execute again, so older terminal rows may be
    // pruned without losing replay protection. Never prune uncertain owners.
    for (const [id, record] of this.records) {
      if (this.records.size < 100) break;
      if (!["working", "interrupted"].includes(record.status) && !this.children.has(id)
        && Date.now() - Date.parse(record.updatedAt) > 600_000) this.records.delete(id);
    }
    if (this.records.size >= 100) throw new Error("Recent or unreconciled session history is full. Reconcile interrupted runs or wait for the ten-minute approval window to expire.");
    const row = { id: args.sessionId, provider: args.provider, workspaceId: workspace.id, project: workspace.label,
      fingerprint: hash(JSON.stringify([args.provider, args.sessionId, workspace.id])), model: args.model || null,
      effort: args.effort || null, startHash, status: "idle", nativeId: null, turns: [], updatedAt: new Date().toISOString() };
    this.records.set(row.id, row);
    try { return this.launch(row, args.message); }
    catch (error) { row.status = "failed"; this.save(); throw error; }
  }
  reply(args) {
    const row = this.target(args);
    if (row.fingerprint !== args.fingerprint || !row.nativeId || row.status === "interrupted") throw new Error("The session cannot safely be resumed. Inspect it first.");
    return this.launch(row, args.message);
  }
  launch(row, message) {
    const workspace = this.workspace(row.workspaceId);
    if ([...this.records.values()].some(record => record.workspaceId === row.workspaceId && record.status === "interrupted")) throw new Error("An interrupted session may still own this workspace. Reconcile it in the provider before using another workspace.");
    if (this.children.size >= 2 || [...this.children.values()].some(child => child.workspaceId === row.workspaceId)) throw new Error("A writer already owns this workspace or the concurrency limit is reached.");
    if (typeof message !== "string" || !message.trim() || message.length > 4000 || message.includes("\0")) throw new Error("Invalid coding instruction.");
    const executable = this.findExecutable(row.provider);
    if (!executable) throw new Error("The provider CLI is unavailable.");
    row.status = "working";
    row.turns = [...row.turns.slice(-5), { role: "user", text: message }];
    row.updatedAt = new Date().toISOString();
    this.save(); // Persist before launch; a crash must never cause an automatic retry.
    let child;
    try { child = this.spawn(executable, codingArguments(row.provider, row), { cwd: workspace.path, env: codingChildEnv(), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" }); }
    catch { row.status = "failed"; this.save(); throw new Error("Could not start the provider CLI."); }
    const owned = { child, workspaceId: row.workspaceId, stopped: false };
    this.children.set(row.id, owned);
    let text = "", pending = "", bytes = 0, failed = false, denied = false, completed = false, killTimer;
    const decoder = new StringDecoder("utf8");
    const kill = signal => { try {
      if (!Number.isInteger(child.pid) || child.pid <= 0) throw new Error("No owned PID");
      process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
    } catch { child.kill?.(signal); } };
    owned.stop = () => {
      if (owned.stopped) return;
      owned.stopped = true; kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), this.killGraceMs);
    };
    const timer = setTimeout(() => { failed = true; owned.stop(); }, this.timeoutMs);
    const line = value => {
      let event; try { event = JSON.parse(value); } catch { return; }
      if (!event || typeof event !== "object" || Array.isArray(event)) return;
      const id = event.thread_id || event.session_id;
      if (ID.test(id || "")) row.nativeId = id;
      if (event.type === "item.completed" && event.item?.type === "agent_message") text = String(event.item.text || "").slice(-16000);
      if (event.type === "assistant" && Array.isArray(event.message?.content)) text = event.message.content.filter(x => x?.type === "text").map(x => x.text).join("\n").slice(-16000);
      if (event.type === "turn.failed" || event.type === "error" || event.is_error) failed = true;
      if (event.permission_denials?.length || event.subtype === "permission_denied") denied = true;
      if (event.type === "turn.completed" || event.type === "result") completed = true;
      if (event.type === "result" && typeof event.result === "string") text = event.result.slice(-16000);
    };
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) { failed = true; owned.stop(); return; }
      pending += decoder.write(chunk);
      const lines = pending.split("\n"); pending = lines.pop();
      for (const value of lines) line(value);
    });
    child.stderr.resume();
    child.stdin.on("error", () => { failed = true; owned.stop(); });
    child.on("error", () => { failed = true; });
    child.on("close", code => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      pending += decoder.end();
      if (pending) line(pending);
      this.children.delete(row.id);
      // close confirms this owned process exited; only crash-recovered runs
      // stay interrupted, because their process ownership is unknown.
      row.status = owned.stopped || failed || code !== 0 || !completed || !text.trim() ? "failed" : denied || /\?\s*$/.test(text) ? "waiting" : "idle";
      row.updatedAt = new Date().toISOString();
      row.turns.push({ role: "assistant", text: text || "No verified response. Check provider sign-in, version compatibility, permissions, and usage limits before retrying." });
      row.turns = row.turns.slice(-6);
      this.save(); this.notify();
    });
    child.stdin.end(message);
    this.notify();
    return { provider: row.provider, sessionId: row.id, status: "accepted", note: "The managed session started. This receipt is not proof that the coding task completed." };
  }
  cancel(args) { const row = this.target(args); this.children.get(row.id)?.stop(); return { sessionId: row.id, stopping: this.children.has(row.id) }; }
  reconcile(args) {
    const row = this.target(args);
    if (args.confirmedStopped !== true || row.status !== "interrupted" || this.children.has(row.id)) throw new Error("Confirm that the interrupted provider process is stopped before releasing its workspace.");
    row.status = "failed"; row.nativeId = null; row.updatedAt = new Date().toISOString();
    row.turns = [...row.turns.slice(-5), { role: "assistant", text: "Owner confirmed the old process was stopped. Start a new approved session; this run will not be resumed." }];
    this.save(); this.notify(); return { reconciled: true, sessionId: row.id };
  }
  stop() { for (const entry of this.children.values()) entry.stop(); }
  async call(args) {
    if (args.operation === "list") return this.list();
    if (args.operation === "inspect") return this.inspect(args);
    if (args.operation === "reply") return this.reply(args);
    throw new Error("Unsupported managed-session operation.");
  }
}
