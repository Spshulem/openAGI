import { spawn } from "node:child_process";
import { appendJsonLine, ensureDir } from "./file-utils.js";
import path from "node:path";
import { nowIso } from "./utils.js";

const PROTOCOL_VERSION = "2024-11-05";
const SAFE_ENV_KEYS = ["PATH", "HOME", "USER", "USERPROFILE", "LANG", "LC_ALL", "TZ", "TMPDIR", "NODE_PATH"];

export class McpStdioClient {
  constructor(options = {}) {
    this.name = options.name;
    this.command = options.command;
    this.args = options.args ?? [];
    this.env = options.env ?? {};
    this.trustLevel = options.trustLevel ?? "untrusted";
    this.cwd = options.cwd;
    this.logDir = options.logDir;
    this.proc = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.tools = [];
    this.serverInfo = null;
    this.connected = false;
    this.connecting = null;
    this.lastError = null;
  }

  status() {
    return {
      name: this.name,
      command: this.command,
      args: this.args,
      trustLevel: this.trustLevel,
      connected: this.connected,
      tools: this.tools.map((tool) => tool.name),
      serverInfo: this.serverInfo,
      lastError: this.lastError
    };
  }

  async connect() {
    if (this.connected) return { tools: this.tools, serverInfo: this.serverInfo };
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async doConnect() {
    if (!this.command) throw new Error(`MCP server ${this.name} is missing a command.`);
    if (this.logDir) ensureDir(this.logDir);
    this.proc = spawn(this.command, this.args, {
      env: this.buildEnv(),
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.proc.stderr.on("data", (chunk) => this.logStderr(chunk));
    this.proc.on("exit", (code, signal) => this.handleExit(code, signal));
    this.proc.on("error", (error) => {
      this.lastError = error.message;
    });

    try {
      this.serverInfo = await this.request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          clientInfo: { name: "openagi", version: "0.1.0" }
        },
        { timeoutMs: 300000 }
      );
      this.notify("notifications/initialized", {});
      const list = await this.request("tools/list", {}, { timeoutMs: 60000 });
      this.tools = list?.tools ?? [];
      this.connected = true;
      return { tools: this.tools, serverInfo: this.serverInfo };
    } catch (error) {
      this.lastError = error.message;
      this.close();
      throw error;
    }
  }

  async callTool(toolName, args = {}) {
    if (!this.connected) await this.connect();
    const result = await this.request("tools/call", { name: toolName, arguments: args });
    return result;
  }

  async listTools() {
    if (!this.connected) await this.connect();
    const list = await this.request("tools/list", {});
    this.tools = list?.tools ?? this.tools;
    return this.tools;
  }

  request(method, params, options = {}) {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.killed) {
        reject(new Error(`MCP server ${this.name} is not running.`));
        return;
      }
      const id = this.nextId++;
      const message = { jsonrpc: "2.0", id, method, params };
      const timeoutMs = options.timeoutMs ?? 30000;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`MCP request '${method}' timed out`));
      }, timeoutMs);
      const wrapped = { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); }, method };
      this.pending.set(id, wrapped);
      try {
        this.proc.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  notify(method, params) {
    if (!this.proc || this.proc.killed) return;
    const message = { jsonrpc: "2.0", method, params };
    try {
      this.proc.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // best-effort
    }
  }

  handleStdout(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        this.handleMessage(JSON.parse(line));
      } catch (error) {
        this.logStderr(`[bad json] ${line}\n`);
      }
    }
  }

  handleMessage(msg) {
    if (msg.id != null && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message ?? `MCP error in ${pending.method}`));
      else pending.resolve(msg.result);
      return;
    }
    if (this.logDir) {
      appendJsonLine(path.join(this.logDir, `${this.name}.jsonl`), { at: nowIso(), op: "notify", msg });
    }
  }

  logStderr(text) {
    if (!this.logDir) return;
    appendJsonLine(path.join(this.logDir, `${this.name}.jsonl`), { at: nowIso(), op: "stderr", text: String(text).trim() });
  }

  handleExit(code, signal) {
    this.connected = false;
    for (const [, pending] of this.pending) {
      pending.reject(new Error(`MCP server ${this.name} exited (code=${code} signal=${signal})`));
    }
    this.pending.clear();
    if (this.logDir) {
      appendJsonLine(path.join(this.logDir, `${this.name}.jsonl`), { at: nowIso(), op: "exit", code, signal });
    }
  }

  buildEnv() {
    const out = {};
    for (const key of SAFE_ENV_KEYS) {
      if (process.env[key]) out[key] = process.env[key];
    }
    for (const [key, value] of Object.entries(this.env ?? {})) {
      if (typeof key !== "string") continue;
      if (/[^A-Z0-9_]/i.test(key)) continue;
      out[key] = String(value);
    }
    return out;
  }

  close() {
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill();
      } catch {
        // ignore
      }
    }
    this.connected = false;
    for (const [, pending] of this.pending) {
      pending.reject(new Error(`MCP server ${this.name} closed.`));
    }
    this.pending.clear();
  }
}
