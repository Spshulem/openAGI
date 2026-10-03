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
// Calls that only read. Any other tool is input.
const READ_TOOLS = new Set(["get_app_state", "list_apps"]);
const OCU_TEXT_MAX = 200;

// What Open Computer Use said about a failure ("Apple event error -10005:
// cgWindowNotFound"), so a caller can tell one failure kind from another.
// Bounded, single-line, with token-like strings removed; never logged here.
export function redactedOcuText(value) {
  return String(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abpr])[-_][\w-]{6,}/gi, "[redacted]")
    .replace(/\b(?:bearer|token|key|secret|password)\s*[:=]?\s*\S+/gi, "[redacted]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, "[redacted]")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, OCU_TEXT_MAX);
}

function contentText(result) {
  return (Array.isArray(result?.content) ? result.content : [])
    .filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text).join(" ");
}

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
    // Input calls that timed out or were cut off through the app agent, by
    // id: their engine stays up until each answers late or the engine exits.
    this.late = new Map();
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
    let buffer = "";
    child.stdout.on("data", chunk => {
      const current = this.proc === child;
      // A closed engine is still read while input it ran may answer late.
      if (!current && !this.lateFor(child)) return;
      const broken = () => (current ? this.close() : this.drop(child));
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) return broken();
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let value;
        try { value = JSON.parse(line); } catch { broken(); return; }
        if (!value || typeof value !== "object" || Array.isArray(value) || value.jsonrpc !== "2.0") {
          broken(); return;
        }
        // Any answer, result or error, means the agent finished that input.
        if (this.late.get(value.id)?.child === child) { this.settleLate(value.id, true); continue; }
        if (!current) continue;
        const pending = this.pending.get(value.id);
        if (!pending) continue;
        if (value.error || !Object.hasOwn(value, "result")) {
          pending.reject(Object.assign(new Error("Open Computer Use rejected the request."),
            { ocuText: redactedOcuText(value.error?.message ?? "") }));
        } else pending.resolve(value.result);
      }
    });
    child.on("error", () => { if (this.proc === child) this.close(); });
    child.on("exit", () => {
      // Close first, so input still pending becomes late on this child; then
      // settle it all: input it ran may still be running in the agent.
      if (this.proc === child) this.close();
      for (const [id, late] of [...this.late]) if (late.child === child) this.settleLate(id, false);
    });
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
      // Nothing cancels an app-agent call: ending or killing the proxy leaves
      // the agent's input running. A slow read only fails, and its late
      // answer is dropped (its id is gone); slow input is marked inFlight, as
      // it may still land, with a settled promise for when it provably ended.
      // An owned engine is killed, which cancels its input.
      const entry = { id, child: this.proc, input: this.appAgentProxy && method === "tools/call" && !READ_TOOLS.has(params?.name), sent: false,
        resolve: value => finish(null, value), reject: error => finish(error) };
      const expire = () => this.appAgentProxy
        ? entry.reject(this.inFlight(new Error(`Open Computer Use timed out after ${Math.round(timeoutMs / 1000)}s on ${params?.name ?? method}`), entry))
        : this.close();
      const timer = setTimeout(expire, timeoutMs);
      this.pending.set(id, entry);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      entry.sent = true;
    });
  }
  async call(name, args, signal, { timeoutMs } = {}) {
    await this.connect(signal);
    const result = await this.request("tools/call", { name, arguments: args }, signal, timeoutMs);
    if (result?.isError !== false || !Array.isArray(result.content)) {
      throw Object.assign(new Error("Open Computer Use could not complete the action. Check its permissions and take a new screenshot; do not retry blindly."),
        { ocuText: redactedOcuText(contentText(result)) });
    }
    return result;
  }
  close() {
    const child = this.proc; this.proc = null;
    for (const pending of [...this.pending.values()]) pending.reject(this.inFlight(new Error("Open Computer Use stopped, timed out, or disconnected; delivery is unconfirmed."), pending));
    if (child) this.release(child);
  }
  // An engine with input in flight is neither ended nor killed, so the late
  // answer can arrive: released once the last one settles.
  release(child) {
    if (this.lateFor(child)) return;
    if (this.appAgentProxy && this.closeGraceMs > 0) {
      // End of input lets the engine finish its request and exit on its own.
      try { child.stdin.end(); } catch { /* already closed */ }
      setTimeout(() => child.kill("SIGKILL"), this.closeGraceMs).unref?.();
    } else child.kill("SIGKILL");
  }
  // A closed engine that stops speaking JSON-RPC proves nothing finished.
  drop(child) {
    for (const [id, late] of [...this.late]) if (late.child === child) this.settleLate(id, false);
  }
  lateFor(child) {
    for (const late of this.late.values()) if (late.child === child) return true;
    return false;
  }
  settleLate(id, completed) {
    const late = this.late.get(id);
    if (!late) return;
    this.late.delete(id);
    late.settle({ completed });
    if (late.child && late.child !== this.proc) this.release(late.child);
  }
  inFlight(error, entry) {
    if (!entry.input || !entry.sent) return error;
    error.inFlight = true;
    // Resolves { completed: true } on the late answer, { completed: false }
    // when the engine exits (or breaks) first: the input may still run.
    error.settled = new Promise(resolve => { this.late.set(entry.id, { child: entry.child, settle: resolve }); });
    return error;
  }
}
