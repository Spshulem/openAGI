import fs from "node:fs";
import path from "node:path";
import { resolveDataDir } from "./data-dir.js";

// Client used by the `openagi` CLI to talk to a daemon — either the LOCAL one
// (default) or a REMOTE "main" hub (e.g. OpenAGI running on a Distiller / Pi
// that holds all the integrations). A device running only the CLI in remote
// mode is a "node": it sends messages/observations to the main and renders
// replies, without configuring any integrations of its own.
//
// Target resolution precedence (first wins):
//   1. explicit { remote, token } (CLI --remote / --token flags)
//   2. env OPENAGI_REMOTE / OPENAGI_REMOTE_TOKEN
//   3. <dataDir>/node.json  { "remote": "...", "token": "..." }  (saved pairing)
//   4. local default: http://127.0.0.1:<PORT|43210> with OPENAGI_AUTH_TOKEN

const DEFAULT_LOCAL_PORT = () => Number.parseInt(process.env.PORT ?? "43210", 10);

export function nodeConfigPath(dataDir = resolveDataDir()) {
  return path.join(dataDir, "node.json");
}

export function readNodeConfig(dataDir = resolveDataDir()) {
  try {
    return JSON.parse(fs.readFileSync(nodeConfigPath(dataDir), "utf8"));
  } catch {
    return null;
  }
}

export function writeNodeConfig({ remote, token }, dataDir = resolveDataDir()) {
  const file = nodeConfigPath(dataDir);
  fs.mkdirSync(dataDir, { recursive: true }); // a fresh node has no ~/.openagi yet
  fs.writeFileSync(file, JSON.stringify({ remote, token: token ?? null }, null, 2) + "\n", { mode: 0o600 });
  return file;
}

export function clearNodeConfig(dataDir = resolveDataDir()) {
  try { fs.rmSync(nodeConfigPath(dataDir)); return true; } catch { return false; }
}

// Normalize a host/url into a base URL. Accepts "distiller.local",
// "distiller.local:43210", "http://x", "https://x" — defaults to http and the
// daemon port when missing.
export function normalizeBase(target) {
  let t = String(target).trim();
  if (!/^https?:\/\//.test(t)) t = `http://${t}`;
  const u = new URL(t);
  if (!u.port && u.protocol === "http:") u.port = String(DEFAULT_LOCAL_PORT());
  return u.origin;
}

export function resolveTarget({ remote, token, dataDir = resolveDataDir() } = {}) {
  // 1. explicit flag
  if (remote) {
    return { url: normalizeBase(remote), token: token ?? process.env.OPENAGI_REMOTE_TOKEN ?? null, source: "flag", remote: true };
  }
  // 2. env
  if (process.env.OPENAGI_REMOTE) {
    return { url: normalizeBase(process.env.OPENAGI_REMOTE), token: token ?? process.env.OPENAGI_REMOTE_TOKEN ?? null, source: "env", remote: true };
  }
  // 3. saved node pairing
  const cfg = readNodeConfig(dataDir);
  if (cfg?.remote) {
    return { url: normalizeBase(cfg.remote), token: token ?? cfg.token ?? null, source: "node.json", remote: true };
  }
  // 4. local default. The token is usually only in <dataDir>/.env (the wizard
  // wrote it there, not into the CLI's environment) — peek it so `openagi
  // status/chat/doctor` work locally right after setup without exporting it.
  return {
    url: normalizeBase(`127.0.0.1:${DEFAULT_LOCAL_PORT()}`),
    token: token ?? process.env.OPENAGI_AUTH_TOKEN ?? peekEnvToken(dataDir),
    source: "local",
    remote: false
  };
}

function peekEnvToken(dataDir) {
  try {
    for (const raw of fs.readFileSync(path.join(dataDir, ".env"), "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith("OPENAGI_AUTH_TOKEN=")) {
        const v = line.slice("OPENAGI_AUTH_TOKEN=".length).trim().replace(/^['"]|['"]$/g, "");
        return v || null;
      }
    }
  } catch { /* no env file */ }
  return null;
}

export class CliClient {
  constructor(target, { fetchImpl = globalThis.fetch, timeoutMs = 60000 } = {}) {
    this.target = target;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  headers(extra = {}) {
    const h = { ...extra };
    if (this.target.token) h.authorization = `Bearer ${this.target.token}`;
    return h;
  }

  async request(method, route, body) {
    const url = this.target.url + route;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: this.headers(body !== undefined ? { "content-type": "application/json" } : {}),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
      return { ok: res.ok, status: res.status, json, text };
    } catch (error) {
      return { ok: false, status: 0, json: null, text: "", error: error.name === "AbortError" ? "timeout" : error.message };
    } finally {
      clearTimeout(timer);
    }
  }

  health() { return this.request("GET", "/health"); }
  status() { return this.request("GET", "/health"); }
  chat(text, { from = "cli", sessionId } = {}) {
    return this.request("POST", "/message", { text, from, sessionId });
  }
  tick() { return this.request("POST", "/tick", {}); }
  tasks() { return this.request("GET", "/tasks"); }
  integrations() { return this.request("GET", "/integrations/status"); }
}

// Run the diagnostic ladder (Hermes-style `doctor`). Returns an array of
// { name, ok, detail, fix? } checks plus an overall ok. Pure aside from the
// client calls, so it's unit-testable with a stubbed client.
export async function runDoctor(client) {
  const checks = [];
  const add = (name, ok, detail, fix) => checks.push({ name, ok, detail, fix });

  const target = client.target;
  add("target", true, `${target.remote ? "remote main" : "local daemon"} → ${target.url} (via ${target.source})`);

  const health = await client.health();
  if (!health.ok) {
    if (health.status === 401) {
      add("daemon", false, "reachable but rejected the token (401)", target.remote
        ? "Pass the main's OPENAGI_AUTH_TOKEN via --token, OPENAGI_REMOTE_TOKEN, or `openagi pair`."
        : "Set OPENAGI_AUTH_TOKEN to the value in <dataDir>/.env, or run `openagi setup`.");
    } else if (health.status === 0) {
      add("daemon", false, `unreachable (${health.error ?? "no response"})`, target.remote
        ? `Is the main up and bound to your LAN? On the main: HOST=0.0.0.0 openagi serve. Check ${target.url}/health.`
        : "Start it with `openagi serve` (or check it's running under systemd/launchd).");
    } else {
      add("daemon", false, `HTTP ${health.status}`, "Check the daemon logs.");
    }
    return { ok: false, checks }; // nothing else is meaningful if the daemon is down
  }
  add("daemon", true, "reachable + authorized");

  const h = health.json ?? {};
  if (h.firstRun) {
    add("setup", false, "first-run — setup has never completed", "Open the dashboard and finish the wizard: `openagi setup`.");
  } else {
    add("setup", true, "setup completed");
  }

  const provider = h.status?.agentHost;
  const deterministic = /deterministic/i.test(provider?.provider ?? "");
  if (provider?.providerConfigured && !deterministic) {
    add("model", true, `provider: ${provider.provider}`);
  } else {
    add("model", false,
      deterministic ? "running the deterministic fallback — no real LLM, replies are canned" : "no LLM provider configured — the agent can't reason",
      "Add a model API key via `openagi setup`.");
  }

  // Task sources (best-effort — needs auth; skip quietly if it 401s).
  const integ = await client.integrations();
  if (integ.ok && Array.isArray(integ.json?.integrations)) {
    const sources = integ.json.integrations.filter((s) => ["linear", "buildbetter"].includes(s.id));
    const connected = sources.filter((s) => (s.paths ?? []).some((p) => p.kind === "api" && p.configured));
    add("task-sources", connected.length > 0,
      connected.length > 0 ? `connected: ${connected.map((s) => s.name).join(", ")}` : "no task sources connected",
      connected.length > 0 ? undefined : "Connect Linear/BuildBetter in the dashboard Integrations tab, or drop files in <dataDir>/inbox.");
  }

  return { ok: checks.every((c) => c.ok), checks };
}
