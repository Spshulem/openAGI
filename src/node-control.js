import crypto from "node:crypto";

const DEFAULT_ONLINE_MS = 90_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 20_000;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_COMMAND_BYTES = 256 * 1024;
const MAX_POLL_RESPONSE_BYTES = 256 * 1024;
const MAX_QUEUED_COMMANDS = 20;
const MAX_IN_FLIGHT_COMMANDS = 16;
const MAX_IN_FLIGHT_REVOCATIONS = 1;
// Node-side computer-use leases are capped at 15 minutes. Keep an undelivered
// revocation addressable for at least that whole window even when the caller's
// short acknowledgement deadline has elapsed.
const REVOCATION_DELIVERY_TTL_MS = 20 * 60 * 1000;
// A timed-out revocation remains queued until its delivery TTL. Retain its
// settled ownership for at least as long so a late authenticated ACK can remove
// that queued copy instead of allowing another delivery after execution.
const SETTLED_TTL_MS = REVOCATION_DELIVERY_TTL_MS;
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

  async poll(nodeId, capabilities, {
    timeoutMs = DEFAULT_POLL_MS,
    signal,
    revocationsOnly = false
  } = {}) {
    const record = this.advertise(nodeId, capabilities);
    this._pruneSettled();
    const queue = this.queues.get(record.nodeId) ?? [];
    for (let index = 0; index < queue.length;) {
      const queued = queue[index];
      if (Date.parse(queued.expiresAt) <= this.now()) {
        queue.splice(index, 1);
        this._rejectCommand(queued.id, "node control command expired before delivery", {
          keepQueued: true
        });
        continue;
      }
      if (revocationsOnly && queued.operation !== "session.end") {
        index += 1;
        continue;
      }
      queue.splice(index, 1);
      if (!queue.length) this.queues.delete(record.nodeId);
      const pending = this.pending.get(queued.id);
      if (pending) pending.delivered = true;
      return queued;
    }
    if (!queue.length) this.queues.delete(record.nodeId);

    // Only one outstanding poll per node. Replacing an older request is safe:
    // it carried no command, and prevents a reconnect loop from accumulating
    // dormant HTTP responses indefinitely.
    this.polls.get(record.nodeId)?.finish(null);
    return await new Promise((resolve) => {
      let done = false;
      const finish = (command) => {
        if (done) return false;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
        if (this.polls.get(record.nodeId)?.finish === finish) this.polls.delete(record.nodeId);
        resolve(command);
        return true;
      };
      const onAbort = () => finish(null);
      const timer = setTimeout(() => finish(null), Math.max(1, timeoutMs));
      signal?.addEventListener?.("abort", onAbort, { once: true });
    this.polls.set(record.nodeId, {
      finish,
      accepts: (command) => !revocationsOnly || command.operation === "session.end"
    });
    });
  }

  dispatch(nodeId, capability, operation, payload, { timeoutMs = this.commandTimeoutMs, sessionId = null } = {}) {
    const record = this.list(capability).find((entry) => entry.nodeId === nodeId);
    const advertised = record?.capabilities.find((entry) => entry.id === capability);
    // Revocation remains available when capture/input readiness drops (locked
    // screen, Secure Input, permission change, or a newly excluded window).
    // Those states must disable actions, never disable Stop.
    if (!advertised || (operation !== "session.end" && !advertised.ready)) {
      return Promise.reject(new Error("selected node capability is not ready"));
    }
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
      expiresAt: new Date(this.now() + (
        operation === "session.end" ? Math.max(timeout, REVOCATION_DELIVERY_TTL_MS) : timeout
      )).toISOString(),
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
        const pending = this.pending.get(command.id);
        if (operation === "session.end") this._retainRevocation(command);
        this._rejectCommand(command.id, "node control command timed out", {
          nodeAcknowledged: pending?.delivered === true,
          nodeSequenceConsumed: pending?.delivered === true,
          // The dashboard should not wait indefinitely for an offline/busy
          // node, but revocation itself remains queued as a detached,
          // authenticated command. A later poll can still tear down the lease.
          keepQueued: operation === "session.end"
        });
      }, timeout);
      const pending = {
        nodeId,
        sessionId: command.sessionId ?? null,
        resolve,
        reject,
        timer,
        delivered: false
      };
      this.pending.set(command.id, pending);
      const poll = this.polls.get(nodeId);
      if (poll?.accepts?.(command) && poll.finish(command)) pending.delivered = true;
      else {
        const queue = this.queues.get(nodeId) ?? [];
        if (operation === "session.end") queue.unshift(command);
        else queue.push(command);
        while (queue.length > MAX_QUEUED_COMMANDS) {
          // Ordinary work may be shed under pressure; it must never displace a
          // revocation that is waiting to stop physical input.
          let dropIndex = queue.findIndex((queued) => queued.operation !== "session.end");
          if (dropIndex < 0) dropIndex = queue.length - 1;
          const [dropped] = queue.splice(dropIndex, 1);
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
      const settled = this.settled.get(commandId);
      if (settled?.nodeId === nodeId) this._removeQueued(commandId);
      return !settled || settled.nodeId === nodeId;
    }
    if (pending.nodeId !== nodeId) return false;
    this.pending.delete(commandId);
    clearTimeout(pending.timer);
    this._removeQueued(commandId);
    this._rememberSettled(commandId, nodeId);
    if (error) {
      const failure = new Error(text(error, 120) ?? "node command failed");
      failure.nodeAcknowledged = true;
      failure.nodeSequenceConsumed = ![
        "node-command-expired-or-mismatched",
        "node-capability-command-rejected"
      ].includes(error);
      pending.reject(failure);
    }
    else pending.resolve(result ?? {});
    return true;
  }

  cancelSession(sessionId, reason = "computer-use session was stopped") {
    let cancelled = 0;
    let delivered = 0;
    for (const [commandId, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      if (pending.delivered) delivered += 1;
      this._rejectCommand(commandId, reason, {
        nodeAcknowledged: pending.delivered,
        nodeSequenceConsumed: pending.delivered
      });
      cancelled += 1;
    }
    return { cancelled, delivered };
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

  _retainRevocation(command) {
    const queue = this.queues.get(command.nodeId) ?? [];
    if (!queue.some((queued) => queued.id === command.id)) queue.unshift(command);
    while (queue.length > MAX_QUEUED_COMMANDS) {
      const ordinary = queue.findIndex((queued) => queued.operation !== "session.end");
      const dropIndex = ordinary >= 0 ? ordinary : queue.length - 1;
      const [dropped] = queue.splice(dropIndex, 1);
      if (dropped?.id === command.id) break;
      if (this.pending.has(dropped?.id)) {
        this._rejectCommand(dropped.id, "node control queue is full");
      }
    }
    if (queue.some((queued) => queued.id === command.id)) this.queues.set(command.nodeId, queue);
  }

  _rejectCommand(commandId, reason, {
    nodeAcknowledged = false,
    nodeSequenceConsumed = false,
    keepQueued = false
  } = {}) {
    if (!keepQueued) this._removeQueued(commandId);
    const pending = this.pending.get(commandId);
    if (!pending) return false;
    this.pending.delete(commandId);
    clearTimeout(pending.timer);
    this._rememberSettled(commandId, pending.nodeId);
    const failure = new Error(reason);
    if (nodeAcknowledged) failure.nodeAcknowledged = true;
    if (nodeSequenceConsumed) failure.nodeSequenceConsumed = true;
    pending.reject(failure);
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
  const controllers = new Set();
  const executionControllers = new Set();
  let loopPromise = null;
  const completed = new Map();
  const inFlight = new Map();
  const revocationsInFlight = new Set();
  const sessionTails = new Map();
  const resultQueue = [];
  const queuedResultIds = new Set();
  let wakeResultSender = null;
  let wakeRevocationWaiter = null;
  const retryWakeups = new Set();
  const base = pinnedRemoteOrigin(remote, { allowInsecureRemote });
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    "x-openagi-node-id": nodeId
  };

  const sleep = (ms) => new Promise((resolve) => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      retryWakeups.delete(finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    retryWakeups.add(finish);
  });
  const post = async (path, body, timeout, consume) => {
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeout);
    timer.unref?.();
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        redirect: "manual",
        signal: controller.signal
      });
      return await consume(response);
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  };

  const enqueueResult = (envelope) => {
    if (queuedResultIds.has(envelope.commandId)) return;
    resultQueue.push(envelope);
    queuedResultIds.add(envelope.commandId);
    const wake = wakeResultSender;
    wakeResultSender = null;
    wake?.();
  };

  const rememberCompleted = (commandId, envelope) => {
    completed.set(commandId, envelope);
    while (completed.size > 100) completed.delete(completed.keys().next().value);
  };

  const executeCommand = async (command) => {
    let envelope;
    const commandExpiry = Date.parse(command.expiresAt);
    if (command.nodeId !== nodeId || !Number.isFinite(commandExpiry) || commandExpiry <= Date.now()) {
      envelope = { nodeId, commandId: command.id, error: "node-command-expired-or-mismatched" };
    } else {
      let result = null;
      let error = null;
      const executionController = new AbortController();
      executionControllers.add(executionController);
      try {
        result = await execute(command, { signal: executionController.signal });
        if (commandExpiry <= Date.now()) {
          throw Object.assign(new Error("node command expired during execution"), { code: "node-command-expired" });
        }
        if (Buffer.byteLength(JSON.stringify(result ?? {})) > MAX_RESULT_BYTES) {
          throw Object.assign(new Error("node command result exceeded the transport limit"), {
            nodeSequenceConsumed: true
          });
        }
      } catch (caught) {
        error = publicNodeError(caught);
      } finally {
        executionControllers.delete(executionController);
      }
      envelope = {
        nodeId,
        commandId: command.id,
        ...(error ? { error } : { result })
      };
    }
    rememberCompleted(command.id, envelope);
    enqueueResult(envelope);
  };

  const scheduleCommand = (command) => {
    const cached = completed.get(command.id);
    if (cached) {
      enqueueResult(cached);
      return;
    }
    if (inFlight.has(command.id)) return;
    if (command.operation === "session.end"
        && revocationsInFlight.size >= MAX_IN_FLIGHT_REVOCATIONS) {
      throw new Error("revocation execution lane is full");
    }

    const run = () => executeCommand(command);
    let task;
    // A stop command must be able to revoke its lease and abort a helper while
    // the preceding physical action is still running. Other commands from one
    // approved session remain ordered even though the worker keeps polling so
    // it can receive that stop.
    if (command.operation === "session.end" || !command.sessionId) {
      task = run();
    } else {
      const previous = sessionTails.get(command.sessionId) ?? Promise.resolve();
      task = previous.catch(() => {}).then(run);
      sessionTails.set(command.sessionId, task);
    }
    inFlight.set(command.id, task);
    if (command.operation === "session.end") revocationsInFlight.add(command.id);
    task.catch(() => {}).finally(() => {
      inFlight.delete(command.id);
      revocationsInFlight.delete(command.id);
      if (command.sessionId && sessionTails.get(command.sessionId) === task) {
        sessionTails.delete(command.sessionId);
      }
    });
  };

  const pollLoop = async () => {
    while (!stopped) {
      try {
        // Do not accept a second Stop while the reserved revocation lane is
        // occupied. A slow provider health check must not turn the priority
        // exemption into unbounded concurrent work.
        if (revocationsInFlight.size >= MAX_IN_FLIGHT_REVOCATIONS) {
          const active = [...revocationsInFlight]
            .map((commandId) => inFlight.get(commandId))
            .filter(Boolean);
          if (active.length) {
            await Promise.race([
              Promise.race(active.map((task) => task.catch(() => {}))),
              new Promise((resolve) => { wakeRevocationWaiter = resolve; })
            ]);
            wakeRevocationWaiter = null;
          }
          else revocationsInFlight.clear();
          continue;
        }
        // Keep a small revocation-only long poll alive even when all ordinary
        // execution slots are occupied. `session.end` is deliberately exempt
        // from that cap so Stop can cancel one of those operations; accepting
        // any other command here would defeat the resource bound.
        const ordinaryInFlight = inFlight.size - revocationsInFlight.size;
        const revocationsOnly = ordinaryInFlight >= MAX_IN_FLIGHT_COMMANDS;
        const effectivePollMs = revocationsOnly ? Math.min(pollMs, 1_000) : pollMs;
        const advertised = sanitizeNodeCapabilities(await capabilities());
        // `capabilities()` may itself wait on a helper health probe. Stop can
        // run while that probe is pending, after its controller-abort sweep;
        // never create a fresh long-poll once shutdown has begun.
        if (stopped) break;
        const body = await post("/nodes/control/poll", {
          nodeId,
          capabilities: advertised,
          timeoutMs: effectivePollMs,
          ...(revocationsOnly ? { revocationsOnly: true } : {})
        }, effectivePollMs + 5_000, async (response) => {
          if (!response.ok) throw new Error(`control poll rejected: ${response.status}`);
          return await readJsonResponseLimited(response, MAX_POLL_RESPONSE_BYTES);
        });
        const command = body?.command;
        if (!command || typeof command.id !== "string") continue;
        if (revocationsOnly && command.operation !== "session.end") {
          throw new Error("revocation-only poll returned ordinary work");
        }
        scheduleCommand(command);
      } catch (error) {
        if (stopped) break;
        await sleep(retryMs);
      }
    }
  };

  const resultLoop = async () => {
    while (!stopped) {
      if (!resultQueue.length) {
        await new Promise((resolve) => { wakeResultSender = resolve; });
        continue;
      }
      const envelope = resultQueue[0];
      try {
        const { accepted, status } = await post("/nodes/control/result", envelope, 10_000, async (delivered) => {
          const outcome = { accepted: delivered.ok, status: delivered.status };
          try { await delivered.body?.cancel?.(); } catch { /* the ACK body is intentionally ignored */ }
          return outcome;
        });
        if (!accepted) throw new Error(`control result rejected: ${status}`);
        resultQueue.shift();
        queuedResultIds.delete(envelope.commandId);
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
      loopPromise = Promise.all([pollLoop(), resultLoop()]);
    },
    async stop() {
      stopped = true;
      const executions = [...inFlight.values()];
      for (const controller of controllers) controller.abort();
      for (const controller of executionControllers) controller.abort();
      const wake = wakeResultSender;
      wakeResultSender = null;
      wake?.();
      const wakeRevocation = wakeRevocationWaiter;
      wakeRevocationWaiter = null;
      wakeRevocation?.();
      for (const finish of retryWakeups) finish();
      await loopPromise?.catch?.(() => {});
      if (executions.length) {
        let settleTimer;
        await Promise.race([
          Promise.allSettled(executions),
          new Promise((resolve) => { settleTimer = setTimeout(resolve, 1_000); })
        ]);
        clearTimeout(settleTimer);
      }
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
  if (/^[a-z0-9_-]+$/i.test(code)) return code;
  return error?.nodeSequenceConsumed === true
    ? "node-capability-command-failed"
    : "node-capability-command-rejected";
}
