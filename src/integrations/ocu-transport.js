import { spawn, execFile } from "node:child_process";

// appAgentProxy: true lets the engine hand work to the Open Computer Use.app
// agent, which holds its own Accessibility and Screen Recording grants (the
// fleet uses this; the daemon's node binary lacks both). The default keeps
// the engine inside this process tree, under the caller's permissions.
// agentNamespace gives the caller its own app agent, so its engines never
// share (or take down) the one the owner's other sessions use.
function engineEnvironment({ appAgentProxy = false, agentNamespace = null } = {}) {
  const env = Object.fromEntries(["HOME", "USER", "PATH", "LANG", "TMPDIR"]
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  env.OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS = "0";
  if (!appAgentProxy) env.OPEN_COMPUTER_USE_DISABLE_APP_AGENT_PROXY = "1";
  if (agentNamespace) env.OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE = agentNamespace;
  return env;
}

// An app-agent engine killed mid-request takes the shared agent down with
// it, so a closed one gets this long to finish before SIGKILL.
export const OCU_CLOSE_GRACE_MS = 30_000;

export function readOcuPermissions(command, run = execFile, { appAgentProxy = false, agentNamespace = null, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    run(command, ["doctor"], { env: engineEnvironment({ appAgentProxy, agentNamespace }), timeout: timeoutMs,
      maxBuffer: 16 * 1024, killSignal: "SIGKILL", encoding: "utf8" }, (error, stdout) => {
      if (error) reject(new Error("Open Computer Use permission probe failed."));
      else resolve(stdout);
    });
  });
}

// A private stdio connection, not an unrestricted MCP registration. No tool
// arguments, screenshots, stderr, or provider credentials enter daemon logs.
export class OcuTransport {
  constructor(command, { spawnImpl = spawn, timeoutMs = 10_000, appAgentProxy = false, agentNamespace = null, closeGraceMs = OCU_CLOSE_GRACE_MS } = {}) {
    this.command = command;
    this.spawn = spawnImpl;
    this.timeoutMs = timeoutMs;
    this.appAgentProxy = appAgentProxy;
    this.agentNamespace = agentNamespace;
    this.closeGraceMs = closeGraceMs;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = "";
  }
  async connect(signal) {
    if (this.proc) return;
    signal?.throwIfAborted();
    // v0.3.3 otherwise proxies even the native executable to a shared,
    // LaunchServices-owned app agent. Killing that proxy does NOT cancel the
    // app agent's input. Own the actual dispatcher and its snapshot cache.
    // Callers that opt into the app agent accept that trade for its grants.
    const env = engineEnvironment({ appAgentProxy: this.appAgentProxy, agentNamespace: this.agentNamespace });
    const child = this.spawn(this.command, ["mcp"], { stdio: ["pipe", "pipe", "pipe"], env });
    this.proc = child;
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      if (this.proc !== child) return;
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 16 * 1024 * 1024) return this.close();
      let end;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        let value;
        try { value = JSON.parse(line); } catch { this.close(); return; }
        if (!value || typeof value !== "object" || Array.isArray(value) || value.jsonrpc !== "2.0") {
          this.close(); return;
        }
        const pending = this.pending.get(value.id);
        if (!pending) continue;
        if (value.error || !Object.hasOwn(value, "result")) pending.reject(new Error("Open Computer Use rejected the request."));
        else pending.resolve(value.result);
      }
    });
    child.on("error", () => { if (this.proc === child) this.close(); });
    child.on("exit", () => { if (this.proc === child) this.close(); });
    child.stdin.on("error", () => { if (this.proc === child) this.close(); });
    const result = await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "openagi-computer-node", version: "1" } }, signal);
    if (!result?.serverInfo) { this.close(); throw new Error("Invalid Open Computer Use initialization."); }
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }
  request(method, params, signal, timeoutMs = this.timeoutMs) {
    signal?.throwIfAborted();
    if (!this.proc) return Promise.reject(new Error("Open Computer Use is disconnected."));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const finish = (error, value) => {
        clearTimeout(timer); signal?.removeEventListener("abort", abort); this.pending.delete(id);
        error ? reject(error) : resolve(value);
      };
      const abort = () => this.close();
      // An app-agent engine outlives a slow call: only that call fails, and
      // its late answer is dropped (its id is gone). An owned engine is
      // killed, which is what cancels its input.
      const expire = () => this.appAgentProxy
        ? finish(new Error(`Open Computer Use timed out after ${Math.round(timeoutMs / 1000)}s on ${params?.name ?? method}`))
        : this.close();
      const timer = setTimeout(expire, timeoutMs);
      this.pending.set(id, { resolve: value => finish(null, value), reject: error => finish(error) });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async call(name, args, signal, { timeoutMs } = {}) {
    await this.connect(signal);
    const result = await this.request("tools/call", { name, arguments: args }, signal, timeoutMs);
    if (result?.isError !== false || !Array.isArray(result.content)) {
      throw new Error("Open Computer Use could not complete the action. Check its permissions and take a new screenshot; do not retry blindly.");
    }
    return result;
  }
  close() {
    const child = this.proc; this.proc = null; this.buffer = "";
    if (child && this.appAgentProxy && this.closeGraceMs > 0) {
      // End of input lets the engine finish its request and exit on its own.
      try { child.stdin.end(); } catch { /* already closed */ }
      setTimeout(() => child.kill("SIGKILL"), this.closeGraceMs).unref?.();
    } else child?.kill("SIGKILL");
    for (const pending of [...this.pending.values()]) pending.reject(new Error("Open Computer Use stopped, timed out, or disconnected; delivery is unconfirmed."));
  }
}
