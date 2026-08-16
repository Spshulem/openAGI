import crypto from "node:crypto";

const DEFAULT_ONLINE_MS = 90_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 20_000;
const MAX_RESULT_BYTES = 12 * 1024 * 1024;
const MAX_COMMAND_BYTES = 256 * 1024;
const MAX_POLL_RESPONSE_BYTES = 256 * 1024;
const MAX_QUEUED_COMMANDS = 20;
const SETTLED_TTL_MS = 15 * 60 * 1000;
const MAX_SETTLED_COMMANDS = 2_000;

const text = (value, max = 120) => (
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null
);

// Capability advertisements are data, never executable configuration. The
// main accepts a small provider-neutral vocabulary and deliberately ignores
// URLs, tokens, commands and every other node-supplied field. A paired node
// receives work only over its authenticated outbound poll connection, so the
// main never turns a heartbeat into an SSRF target.
export function sanitizeNodeCapabilities(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const value of raw.slice(0, 32)) {
    if (!value || typeof value !== "object") continue;
    const id = text(value.id, 64);
    if (!id || !/^[a-z0-9][a-z0-9._-]*$/i.test(id) || seen.has(id)) continue;
    seen.add(id);
    const operations = Array.isArray(value.operations)
      ? [...new Set(value.operations
        .map((entry) => text(entry, 64))
        .filter((entry) => entry && /^[a-z0-9][a-z0-9._-]*$/i.test(entry)))]
        .slice(0, 64)
      : [];
    out.push({
      id,
      ready: value.ready === true,
      operations,
      detail: text(value.detail, 200),
      checkedAt: text(value.checkedAt, 40)
    });
  }
  return out;
}

export class NodeControlBroker {
  constructor({ now = () => Date.now(), onlineMs = DEFAULT_ONLINE_MS, commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
    this.now = now;
    this.onlineMs = onlineMs;
    this.commandTimeoutMs = commandTimeoutMs;
    this.nodes = new Map();
    this.queues = new Map();
    this.polls = new Map();
    this.pending = new Map();
    this.settled = new Map();
  }

  advertise(nodeId, capabilities) {
    const id = text(nodeId, 200);
    if (!id) throw new Error("nodeId is required");
    const record = {
      nodeId: id,
      capabilities: sanitizeNodeCapabilities(capabilities),
      seenAt: this.now()
    };
    this.nodes.set(id, record);
    return record;
  }

  list(capabilityId = null) {
    const now = this.now();
    const out = [];
    for (const record of this.nodes.values()) {
      if (now - record.seenAt > this.onlineMs) continue;
      const capabilities = capabilityId
        ? record.capabilities.filter((capability) => capability.id === capabilityId)
        : record.capabilities;
      if (!capabilities.length) continue;
      out.push({ ...record, capabilities, seenAt: new Date(record.seenAt).toISOString() });
    }
    return out;
  }

  resolve(capabilityId, { nodeId = null, nodeName = null, registry = null } = {}) {
    const candidates = this.list(capabilityId).filter((record) => (
      record.capabilities.some((capability) => capability.ready)
    ));
    const selector = text(nodeId ?? nodeName, 200)?.toLowerCase() ?? null;
    // Implicit routing is safe only when there is exactly one eligible node.
    // A newly paired (or compromised) node must never win control merely by
    // being first in insertion order.
    if (!selector) return candidates.length === 1 ? candidates[0] : null;
    const exactId = candidates.find((record) => record.nodeId.toLowerCase() === selector);
    if (exactId) return exactId;
    const names = new Map(registry?.list?.().map?.((entry) => [entry.nodeId, entry.name]) ?? []);
    const named = candidates.filter((record) => (
      typeof names.get(record.nodeId) === "string" && names.get(record.nodeId).toLowerCase() === selector
    ));
    return named.length === 1 ? named[0] : null;
  }

  async poll(nodeId, capabilities, { timeoutMs = DEFAULT_POLL_MS, signal } = {}) {
    const record = this.advertise(nodeId, capabilities);
    this._pruneSettled();
    const queue = this.queues.get(record.nodeId) ?? [];
    while (queue.length) {
      const queued = queue.shift();
      if (Date.parse(queued.expiresAt) > this.now()) return queued;
      this._rejectCommand(queued.id, "node control command expired before delivery");
    }

    // Only one outstanding poll per node. Replacing an older request is safe:
    // it carried no command, and prevents a reconnect loop from accumulating
    // dormant HTTP responses indefinitely.
    this.polls.get(record.nodeId)?.finish(null);
    return await new Promise((resolve) => {
      let done = false;
      const finish = (command) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
        if (this.polls.get(record.nodeId)?.finish === finish) this.polls.delete(record.nodeId);
        resolve(command);
      };
      const onAbort = () => finish(null);
      const timer = setTimeout(() => finish(null), Math.max(1, timeoutMs));
      signal?.addEventListener?.("abort", onAbort, { once: true });
      this.polls.set(record.nodeId, { finish });
    });
  }

  dispatch(nodeId, capability, operation, payload, { timeoutMs = this.commandTimeoutMs, sessionId = null } = {}) {
    const record = this.list(capability).find((entry) => entry.nodeId === nodeId);
    const advertised = record?.capabilities.find((entry) => entry.id === capability && entry.ready);
    if (!advertised) return Promise.reject(new Error("selected node capability is not ready"));
    if (!advertised.operations.includes(operation)) {
      return Promise.reject(new Error(`selected node does not support ${operation}`));
    }
    const timeout = Math.max(1, Math.min(5 * 60 * 1000, Number(timeoutMs) || this.commandTimeoutMs));
    const command = {
      id: `ncmd_${crypto.randomUUID().replaceAll("-", "")}`,
      nodeId,
      capability,
      operation,
      payload: payload ?? {},
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + timeout).toISOString(),
      ...(typeof sessionId === "string" && sessionId ? { sessionId: sessionId.slice(0, 240) } : {})
    };
    try {
      if (Buffer.byteLength(JSON.stringify(command), "utf8") > MAX_COMMAND_BYTES) {
        return Promise.reject(new Error("node control command exceeded the transport limit"));
      }
    } catch {
      return Promise.reject(new Error("node control command is not serializable"));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._removeQueued(command.id);
        this.pending.delete(command.id);
        this._rememberSettled(command.id, nodeId);
        reject(new Error("node control command timed out"));
      }, timeout);
      this.pending.set(command.id, { nodeId, sessionId: command.sessionId ?? null, resolve, reject, timer });
      const poll = this.polls.get(nodeId);
      if (poll) poll.finish(command);
      else {
        const queue = this.queues.get(nodeId) ?? [];
        queue.push(command);
        while (queue.length > MAX_QUEUED_COMMANDS) {
          const dropped = queue.shift();
          const stranded = this.pending.get(dropped?.id);
          if (!stranded) continue;
          this._rejectCommand(dropped.id, "node control queue is full");
        }
        this.queues.set(nodeId, queue);
      }
    });
  }

  deliver(nodeId, commandId, { result, error } = {}) {
    const pending = this.pending.get(commandId);
    if (!pending) {
      // Auth already binds this result to nodeId. ACK an unknown/previously
      // settled id so a node whose first 200 response was lost does not retry
      // forever or re-execute the command after a reconnect.
      return true;
    }
    if (pending.nodeId !== nodeId) return false;
    this.pending.delete(commandId);
    clearTimeout(pending.timer);
    this._rememberSettled(commandId, nodeId);
    if (error) {
      const failure = new Error(text(error, 120) ?? "node command failed");
      failure.nodeAcknowledged = true;
      pending.reject(failure);
    }
    else pending.resolve(result ?? {});
    return true;
  }

  cancelSession(sessionId, reason = "computer-use session was stopped") {
    let cancelled = 0;
    for (const [commandId, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      this._rejectCommand(commandId, reason);
      cancelled += 1;
    }
    return cancelled;
  }

  removeNode(nodeId, reason = "node credential was revoked") {
    this.polls.get(nodeId)?.finish(null);
    this.polls.delete(nodeId);
    for (const [commandId, pending] of this.pending) {
      if (pending.nodeId === nodeId) this._rejectCommand(commandId, reason);
    }
    this.queues.delete(nodeId);
    this.nodes.delete(nodeId);
  }

  _removeQueued(commandId) {
    for (const [nodeId, queue] of this.queues) {
      const next = queue.filter((command) => command.id !== commandId);
      if (next.length) this.queues.set(nodeId, next);
      else this.queues.delete(nodeId);
    }
  }

  _rejectCommand(commandId, reason) {
    this._removeQueued(commandId);
    const pending = this.pending.get(commandId);
    if (!pending) return false;
    this.pending.delete(commandId);
    clearTimeout(pending.timer);
    this._rememberSettled(commandId, pending.nodeId);
    pending.reject(new Error(reason));
    return true;
  }

  _rememberSettled(commandId, nodeId) {
    this.settled.set(commandId, { nodeId, at: this.now() });
    this._pruneSettled();
  }

  _pruneSettled() {
    const cutoff = this.now() - SETTLED_TTL_MS;
    for (const [id, record] of this.settled) {
      if (record.at < cutoff || this.settled.size > MAX_SETTLED_COMMANDS) this.settled.delete(id);
    }
  }

  close() {
    for (const poll of this.polls.values()) poll.finish(null);
    this.polls.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("node control broker closed"));
    }
    this.pending.clear();
    this.queues.clear();
    this.settled.clear();
  }
}

export function createNodeControlWorker({
  remote,
  token,
  nodeId,
  capabilities,
  execute,
  fetchImpl = globalThis.fetch,
  pollMs = DEFAULT_POLL_MS,
  retryMs = 1_000,
  allowInsecureRemote = false
}) {
  if (!remote || !token || !nodeId || typeof execute !== "function") {
    throw new Error("remote, token, nodeId and execute are required");
  }
  let stopped = true;
  let controller = null;
  let loopPromise = null;
  let unsentEnvelope = null;
  const completed = new Map();
  const base = pinnedRemoteOrigin(remote, { allowInsecureRemote });
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    "x-openagi-node-id": nodeId
  };

  const sleep = (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  const post = async (path, body, timeout) => {
    controller = new AbortController();
    const timer = setTimeout(() => controller?.abort(), timeout);
    timer.unref?.();
    try {
      return await fetchImpl(`${base}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        redirect: "manual",
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
      controller = null;
    }
  };
  const loop = async () => {
    while (!stopped) {
      try {
        if (unsentEnvelope) {
          const delivered = await post("/nodes/control/result", unsentEnvelope, 10_000);
          if (!delivered.ok) throw new Error(`control result rejected: ${delivered.status}`);
          unsentEnvelope = null;
          continue;
        }
        const advertised = sanitizeNodeCapabilities(await capabilities());
        const response = await post("/nodes/control/poll", {
          nodeId,
          capabilities: advertised,
          timeoutMs: pollMs
        }, pollMs + 5_000);
        if (!response.ok) throw new Error(`control poll rejected: ${response.status}`);
        const body = await readJsonResponseLimited(response, MAX_POLL_RESPONSE_BYTES);
        const command = body?.command;
        if (!command || typeof command.id !== "string") continue;
        const cached = completed.get(command.id);
        if (cached) {
          unsentEnvelope = cached;
          continue;
        }
        let envelope;
        const commandExpiry = Date.parse(command.expiresAt);
        if (command.nodeId !== nodeId || !Number.isFinite(commandExpiry) || commandExpiry <= Date.now()) {
          envelope = { nodeId, commandId: command.id, error: "node-command-expired-or-mismatched" };
        } else {
          let result = null;
          let error = null;
          try {
            result = await execute(command);
            if (commandExpiry <= Date.now()) {
              throw Object.assign(new Error("node command expired during execution"), { code: "node-command-expired" });
            }
            if (Buffer.byteLength(JSON.stringify(result ?? {})) > MAX_RESULT_BYTES) {
              throw new Error("node command result exceeded the transport limit");
            }
          } catch (caught) {
            error = publicNodeError(caught);
          }
          envelope = {
            nodeId,
            commandId: command.id,
            ...(error ? { error } : { result })
          };
        }
        completed.set(command.id, envelope);
        while (completed.size > 100) completed.delete(completed.keys().next().value);
        unsentEnvelope = envelope;
      } catch (error) {
        if (stopped) break;
        await sleep(retryMs);
      }
    }
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      loopPromise = loop();
    },
    async stop() {
      stopped = true;
      controller?.abort();
      await loopPromise?.catch?.(() => {});
      loopPromise = null;
    }
  };
}

export function pinnedRemoteOrigin(remote, { allowInsecureRemote = false } = {}) {
  let url;
  try { url = new URL(String(remote)); } catch { throw new Error("remote must be an absolute http(s) origin"); }
  if (!["http:", "https:"].includes(url.protocol)
      || url.username || url.password || url.search || url.hash
      || (url.pathname && url.pathname !== "/")) {
    throw new Error("remote must be an absolute http(s) origin without credentials, path, query, or fragment");
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname) && allowInsecureRemote !== true) {
    throw new Error("remote node control requires HTTPS outside loopback (or an explicitly asserted encrypted tunnel)");
  }
  return url.origin;
}

function isLoopbackHost(hostname) {
  const host = String(hostname).replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const match = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  return Boolean(match && Number(match[1]) === 127 && match.slice(1).every((part) => Number(part) <= 255));
}

async function readJsonResponseLimited(response, maxBytes) {
  const declared = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("control poll response exceeded the transport limit");
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) throw new Error("control poll response exceeded the transport limit");
        chunks.push(value);
      }
    } catch (error) {
      try { await reader.cancel(); } catch { /* best effort */ }
      throw error;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  // Injectable test clients may provide only text()/json(). Production fetch
  // takes the streaming branch above, where the pre-parse bound is enforced.
  if (typeof response?.text === "function") {
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > maxBytes) throw new Error("control poll response exceeded the transport limit");
    return JSON.parse(raw);
  }
  const parsed = await response.json();
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > maxBytes) throw new Error("control poll response exceeded the transport limit");
  return parsed;
}

function publicNodeError(error) {
  const code = typeof error?.code === "string" ? error.code.slice(0, 64) : "";
  return /^[a-z0-9_-]+$/i.test(code) ? code : "node-capability-command-failed";
}
