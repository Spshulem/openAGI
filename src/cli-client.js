import fs from "node:fs";
import path from "node:path";
import { resolveDataDir } from "./data-dir.js";
import { pinnedRemoteOrigin } from "./node-control.js";
import { writeJsonAtomic } from "./file-utils.js";

// Client used by the `openagi` CLI to talk to a daemon — either the LOCAL one
// (default) or a REMOTE "main" hub that holds all the integrations. A device
// running only the CLI in remote
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

export function writeNodeConfig({ remote, token, nodeToken = undefined, nodeEnrollmentConfirmed = undefined }, dataDir = resolveDataDir()) {
  const file = nodeConfigPath(dataDir);
  const existing = readNodeConfig(dataDir);
  const sameRemote = sameNormalizedRemote(existing?.remote, remote);
  const nextNodeToken = nodeToken === undefined
    ? (sameRemote ? (existing?.nodeToken ?? null) : null)
    : nodeToken;
  const nextEnrollmentConfirmed = nodeEnrollmentConfirmed === undefined
    ? (sameRemote ? (existing?.nodeEnrollmentConfirmed ?? null) : null)
    : Boolean(nodeEnrollmentConfirmed);
  writeJsonAtomic(file, {
    remote,
    // A confirmed node must never retain the main-wide enrollment credential,
    // including when `pair` is run again against the same main.
    token: nextEnrollmentConfirmed === true ? null : (token ?? null),
    nodeToken: nextNodeToken,
    nodeEnrollmentConfirmed: nextEnrollmentConfirmed
  }, 0o600);
  return file;
}

export function clearNodeConfig(dataDir = resolveDataDir()) {
  try { fs.rmSync(nodeConfigPath(dataDir)); return true; } catch { return false; }
}

// Normalize a host/url into a base URL. Accepts "node.example.test",
// "node.example.test:43210", "http://x", "https://x" — defaults to http and the
// daemon port when missing.
export function normalizeBase(target) {
  let t = String(target).trim();
  if (!/^https?:\/\//.test(t)) t = `http://${t}`;
  const u = new URL(t);
  if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== "/")) {
    throw new Error("target must be an origin without credentials, path, query, or fragment");
  }
  if (!u.port && u.protocol === "http:") u.port = String(DEFAULT_LOCAL_PORT());
  return u.origin;
}

function sameNormalizedRemote(left, right) {
  if (!left || !right) return false;
  try { return normalizeBase(left) === normalizeBase(right); } catch { return false; }
}

export async function revokeAndClearNodeConfig({
  dataDir = resolveDataDir(),
  fetchImpl = globalThis.fetch,
  timeoutMs = 5_000,
  force = false,
  allowInsecureRemote = false,
  restartLocal = false
} = {}) {
  const pairing = readNodeConfig(dataDir);
  if (!pairing?.remote) return { removed: false, revoked: false, reason: "not-paired" };

  let revoked = false;
  let forced = false;
  let revokeReason = null;
  if (pairing.nodeToken) {
    const nodeId = readStoredNodeId(dataDir);
    if (!nodeId) {
      if (!force) return { removed: false, revoked: false, reason: "node-identity-unavailable" };
      forced = true;
      revokeReason = "node-identity-unavailable";
    } else {
      let target;
      try {
        // Unpairing is a property of the saved enrollment. Environment and
        // one-shot CLI target overrides must never redirect its revocation.
        target = {
          url: pinnedRemoteOrigin(normalizeBase(pairing.remote), { allowInsecureRemote }),
          token: pairing.nodeToken,
          nodeId,
          source: "node.json",
          remote: true
        };
      } catch {
        if (!force) return { removed: false, revoked: false, reason: "saved-main-invalid" };
        forced = true;
        revokeReason = "saved-main-invalid";
      }
      if (target) {
        const client = new CliClient(target, { fetchImpl, timeoutMs });
        const response = await client.request("POST", "/nodes/revoke", { nodeId });
        if (!response.ok) {
          revokeReason = response.status === 0 ? "main-unreachable" : `revoke-http-${response.status}`;
          if (!force) return { removed: false, revoked: false, reason: revokeReason };
          forced = true;
        } else {
          revoked = true;
        }
      }
    }
  }

  let local = null;
  if (restartLocal) {
    local = await restartLocalDaemon({ dataDir, fetchImpl, timeoutMs });
    // If remote revocation did not succeed, keep the saved pairing whenever a
    // running daemon could not be restarted. Otherwise --force would appear to
    // unpair while the old in-memory credential continued polling the main.
    if (!local.applied && !revoked) {
      return {
        removed: false,
        revoked: false,
        forced,
        local,
        reason: "local-daemon-restart-required"
      };
    }
  }

  const removed = clearNodeConfig(dataDir);
  return {
    removed,
    revoked,
    forced,
    local,
    reason: !removed
      ? "local-config-remove-failed"
      : (local && !local.applied
          ? "local-daemon-restart-required"
          : (revoked ? "revoked" : (forced ? "forced-local-forget" : "not-enrolled"))),
    revokeReason
  };
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
    const nodeId = readStoredNodeId(dataDir);
    // A scoped token is generated and persisted before enrollment so a lost
    // enrollment response can be retried. It is not valid authority until the
    // main confirms enrollment, so one-shot clients must keep using the
    // pairing credential during that short pending window.
    const scopedToken = cfg.nodeEnrollmentConfirmed === true ? cfg.nodeToken : null;
    return {
      url: normalizeBase(cfg.remote),
      token: token ?? scopedToken ?? cfg.token ?? null,
      nodeId: token ? null : (scopedToken ? nodeId : null),
      source: "node.json",
      remote: true
    };
  }
  // 4. local default. The token is usually only in <dataDir>/.env (the wizard
  // wrote it there, not into the CLI's environment) — peek it so `openagi
  // status/chat/doctor` work locally right after setup without exporting it.
  return resolveLocalTarget({ token, dataDir });
}

// Updating is intentionally different from normal CLI target resolution.
// A paired node still owns its local OpenAGI installation, so an unqualified
// `openagi update` must update that local daemon instead of forwarding a
// privileged control request to the paired main. Remote updates require an
// explicit --remote origin; OPENAGI_REMOTE and node.json never opt a machine
// into remotely updating another install.
export function resolveUpdateTarget({ remote, token, dataDir = resolveDataDir() } = {}) {
  if (remote) return resolveTarget({ remote, token, dataDir });
  return resolveLocalTarget({ token, dataDir });
}

// Pairing state is loaded once when a daemon starts. Apply a saved change by
// asking the local authenticated daemon to follow its normal supervised
// restart path. A connection failure means there is no reachable local daemon,
// so the new state will be loaded on its next start; a timeout or HTTP error is
// ambiguous and must be reported instead of claiming the state is active.
export async function restartLocalDaemon({
  dataDir = resolveDataDir(),
  fetchImpl = globalThis.fetch,
  timeoutMs = 5_000
} = {}) {
  const target = resolveUpdateTarget({ dataDir });
  const client = new CliClient(target, { fetchImpl, timeoutMs });
  const response = await client.request("POST", "/control/restart");
  if (response.ok && response.status === 202) {
    return { applied: true, restarted: true, running: true, reason: "restarting" };
  }
  if (response.status === 0 && response.error !== "timeout") {
    return { applied: true, restarted: false, running: false, reason: "not-running" };
  }
  return {
    applied: false,
    restarted: false,
    running: response.status === 0 ? null : true,
    restartRequired: true,
    reason: response.status === 0 ? "restart-timeout" : `restart-http-${response.status}`
  };
}

function resolveLocalTarget({ token, dataDir }) {
  return {
    url: normalizeBase(`127.0.0.1:${DEFAULT_LOCAL_PORT()}`),
    token: token ?? process.env.OPENAGI_AUTH_TOKEN ?? peekEnvToken(dataDir),
    source: "local",
    remote: false
  };
}

// A long-running node service must stop using the one-time/main-wide pairing
// credential as soon as the daemon has enrolled this installation. Normal CLI
// precedence intentionally lets flags/env override node.json; that is useful
// for one-shot commands but unsafe for a relay that can live for days. This
// resolver deliberately checks the confirmed, node-scoped pairing first.
export function resolveEnrolledNodeTarget(dataDir = resolveDataDir()) {
  const cfg = readNodeConfig(dataDir);
  if (!cfg?.remote || cfg.nodeEnrollmentConfirmed !== true) return null;
  const nodeId = readStoredNodeId(dataDir);
  if (typeof cfg.nodeToken !== "string" || !cfg.nodeToken || !nodeId) {
    throw new Error("confirmed node enrollment is missing its scoped credential or identity");
  }
  return {
    url: normalizeBase(cfg.remote),
    token: cfg.nodeToken,
    nodeId,
    source: "node.json",
    remote: true
  };
}

// Produce a fresh CliClient for every operation. Once a confirmed scoped
// credential has been observed, the provider never falls back to a broader
// credential if node.json later disappears or becomes incomplete. The target
// origin is also pinned on first use so a running relay cannot silently switch
// destinations after a config rewrite.
export function createRefreshingNodeClientProvider({
  remote,
  token,
  dataDir = resolveDataDir(),
  fetchImpl = globalThis.fetch,
  timeoutMs = 60000,
  allowInsecureRemote = false,
  onScopedCredential = () => {}
} = {}) {
  let fallbackToken = token;
  let pinnedUrl = null;
  let scopedObserved = false;
  const requestedRemote = remote ?? process.env.OPENAGI_REMOTE ?? null;
  const requestedUrl = requestedRemote
    ? pinnedRemoteOrigin(normalizeBase(requestedRemote), { allowInsecureRemote })
    : null;
  return () => {
    const scoped = resolveEnrolledNodeTarget(dataDir);
    let target;
    if (scoped) {
      target = scoped;
      const scopedUrl = pinnedRemoteOrigin(normalizeBase(scoped.url), { allowInsecureRemote });
      if (requestedUrl && requestedUrl !== scopedUrl) {
        throw new Error("the requested relay target conflicts with the confirmed saved pairing; unpair first or omit the target override");
      }
      if (!scopedObserved) {
        scopedObserved = true;
        fallbackToken = null;
        onScopedCredential();
      }
    } else {
      if (scopedObserved) {
        throw new Error("scoped node pairing is no longer available; restart after repairing the pairing");
      }
      target = resolveTarget({ remote, token: fallbackToken, dataDir });
    }
    // Bearer credentials and private message content must never traverse a
    // non-loopback plaintext connection by accident. The only opt-out is the
    // existing explicit assertion that this HTTP origin is carried inside an
    // encrypted tunnel.
    target.url = pinnedRemoteOrigin(target.url, { allowInsecureRemote });
    if (pinnedUrl === null) pinnedUrl = target.url;
    else if (target.url !== pinnedUrl) {
      throw new Error("paired main changed while the relay was running; restart the relay to use the new main");
    }
    return new CliClient(target, { fetchImpl, timeoutMs });
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

function readStoredNodeId(dataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDir, "identity.json"), "utf8"));
    return typeof value?.nodeId === "string" ? value.nodeId : null;
  } catch { return null; }
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
    if (this.target.nodeId) h["x-openagi-node-id"] = this.target.nodeId;
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
        redirect: "manual",
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

  async health() {
    const response = await this.request("GET", "/health");
    // Public /health intentionally omits provider, memory, and integration
    // detail from callers that hold only a node-scoped credential. Mark that
    // limited-but-valid response so status/doctor do not misreport the main as
    // unconfigured after enrollment erased the one-time admin credential.
    if (response.ok && this.target.nodeId && !response.json?.status) {
      response.json = { ...(response.json ?? {}), access: "node-scoped" };
    }
    return response;
  }
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
  if (h.access === "node-scoped") {
    add("credential", true, "revocable node-scoped credential accepted; private main status is intentionally hidden");
  } else {
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
