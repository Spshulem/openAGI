import { spawn } from "node:child_process";

// A private stdio connection, not an unrestricted MCP registration. No tool
// arguments, screenshots, stderr, or provider credentials enter daemon logs.
export class OcuTransport {
  constructor(command, { spawnImpl = spawn, timeoutMs = 10_000 } = {}) {
    this.command = command;
    this.spawn = spawnImpl;
    this.timeoutMs = timeoutMs;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = "";
  }
  async connect(signal) {
    if (this.proc) return;
    signal?.throwIfAborted();
    const env = Object.fromEntries(["HOME", "USER", "PATH", "LANG", "TMPDIR"]
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    env.OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS = "0";
    const child = this.spawn(this.command, ["mcp"], { stdio: ["pipe", "pipe", "pipe"], env });
    this.proc = child;
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 16 * 1024 * 1024) return this.close();
      let end;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        let value;
        try { value = JSON.parse(line); } catch { this.close(); return; }
        const pending = this.pending.get(value.id);
        if (!pending) continue;
        if (value.error || !Object.hasOwn(value, "result")) pending.reject(new Error("Open Computer Use rejected the request."));
        else pending.resolve(value.result);
      }
    });
    child.on("error", () => this.close());
    child.on("exit", () => { if (this.proc === child) this.close(); });
    child.stdin.on("error", () => this.close());
    const result = await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "openagi-computer-node", version: "1" } }, signal);
    if (!result?.serverInfo) { this.close(); throw new Error("Invalid Open Computer Use initialization."); }
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  }
  request(method, params, signal) {
    signal?.throwIfAborted();
    if (!this.proc) return Promise.reject(new Error("Open Computer Use is disconnected."));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const finish = (error, value) => {
        clearTimeout(timer); signal?.removeEventListener("abort", abort); this.pending.delete(id);
        error ? reject(error) : resolve(value);
      };
      const abort = () => this.close();
      const timer = setTimeout(abort, this.timeoutMs);
      this.pending.set(id, { resolve: value => finish(null, value), reject: error => finish(error) });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async call(name, args, signal) {
    await this.connect(signal);
    const result = await this.request("tools/call", { name, arguments: args }, signal);
    if (result?.isError !== false || !Array.isArray(result.content)) {
      throw new Error("Open Computer Use could not complete the action. Check its permissions and take a new screenshot; do not retry blindly.");
    }
    return result;
  }
  close() {
    const child = this.proc; this.proc = null; this.buffer = "";
    child?.kill("SIGKILL");
    for (const pending of [...this.pending.values()]) pending.reject(new Error("Open Computer Use stopped, timed out, or disconnected; delivery is unconfirmed."));
  }
}
