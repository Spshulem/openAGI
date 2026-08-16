import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";

const execFileAsync = promisify(execFile);

// Computer-use node service — runs on a Mac with a display (or a virtual
// display) and exposes screen capture + input synthesis over the network so a
// remote OpenAGI "main" can actually drive it. Bearer-token gated; the main
// reaches it through the computer_* tools when OPENAGI_COMPUTER_NODE is set.
//
//   GET  /health                         -> authenticated capability status
//   POST /session/start { sessionId }    -> short-lived node-side lease
//   POST /session/end   { leaseId, ... } -> revoke lease
//   POST /screenshot {}                  -> { format, base64, width, height, scale, ... }
//   POST /click  { x, y, button? }       -> { ok: true }
//   POST /move   { x, y }                -> { ok: true }
//   POST /type   { text }                -> { ok: true }
//   POST /key    { chord }               -> { ok: true }   ("cmd+a", "enter", …)
//   POST /scroll { x, y, deltaX, deltaY }-> real CGEvent via bundled helper
//
// Coordinate model (matches the Anthropic/OpenAI reference loops):
//   * The privacy-filtered native helper returns PIXELS (a Retina/HiDPI
//     window is commonly 2× logical points). CGEvent input uses POINTS.
//   * Vision models are also more accurate on smaller images (~1280px wide).
//   So we downscale the screenshot to OPENAGI_COMPUTER_SCALE_WIDTH (default
//   1280, capped at the display's logical width) and report that as the image
//   the model reasons about. Click/move coords come back in THAT space and we
//   scale them up to logical points before handing them to CGEvent. One factor
//   handles both Retina and the downscale.
//
// The distributed Mac app bundles a signed CGEvent helper for every input
// primitive. Input never falls back to a shell command: typed text and other
// sensitive action data must travel over the helper's stdin, not process argv.

const SCALE_WIDTH = Number(process.env.OPENAGI_COMPUTER_SCALE_WIDTH ?? "1280") || 0; // 0 = no scaling
const INPUT_OPERATIONS = ["click", "move", "type", "key", "scroll"];
const ALL_OPERATIONS = ["session.start", "session.end", "screenshot", ...INPUT_OPERATIONS];
const DEFAULT_IDLE_LEASE_MS = 2 * 60 * 1000;
const DEFAULT_ABSOLUTE_LEASE_MS = 15 * 60 * 1000;
const DEFAULT_FRAME_TTL_MS = 30_000;
const activeHelperChildren = new Set();

export function createComputerExecutor({
  run = execFileAsync,
  screenshot = null,
  geometry = defaultGeometry,
  helperPath = process.env.OPENAGI_COMPUTER_HELPER ?? null,
  helperRun = runComputerHelper,
  now = () => Date.now(),
  idleLeaseMs = DEFAULT_IDLE_LEASE_MS,
  absoluteLeaseMs = DEFAULT_ABSOLUTE_LEASE_MS,
  frameTtlMs = DEFAULT_FRAME_TTL_MS,
  capabilityStatus = null
} = {}) {
  const leases = new Map();
  const leasesBySession = new Map();
  const helperControllers = new Set();

  const abortLeaseHelpers = (lease) => {
    for (const controller of lease?.helperControllers ?? []) controller.abort();
    lease?.helperControllers?.clear?.();
  };

  const runForLease = async (lease, fn) => {
    const controller = new AbortController();
    lease.helperControllers.add(controller);
    helperControllers.add(controller);
    try {
      return await fn(controller.signal);
    } finally {
      lease.helperControllers.delete(controller);
      helperControllers.delete(controller);
    }
  };

  const inspect = async () => {
    if (typeof capabilityStatus === "function") return normalizeCapabilityStatus(await capabilityStatus());
    if (helperPath) {
      try {
        const { stdout } = await helperRun(helperPath, "status", null, { timeoutMs: 3_000, maxStdoutBytes: 128 * 1024 });
        return normalizeCapabilityStatus(JSON.parse(String(stdout)));
      } catch (error) {
        return normalizeCapabilityStatus({ detail: mapError(error) });
      }
    }
    return normalizeCapabilityStatus({
      screenshotReady: false,
      inputReady: false,
      operations: [],
      detail: "the signed OpenAGI computer helper is unavailable"
    });
  };

  const purgeExpired = () => {
    const at = now();
    for (const [id, lease] of leases) {
      if (at > lease.expiresAt || at - lease.lastUsedAt > idleLeaseMs) {
        abortLeaseHelpers(lease);
        leases.delete(id);
        if (leasesBySession.get(lease.sessionId) === id) leasesBySession.delete(lease.sessionId);
      }
    }
  };

  const startLease = async (payload) => {
    purgeExpired();
    const sessionId = validId(payload?.sessionId, "sessionId");
    const goalHash = typeof payload?.goalHash === "string" && /^[a-f0-9]{64}$/.test(payload.goalHash)
      ? payload.goalHash
      : null;
    if (!goalHash) throw new Error("goalHash must be a SHA-256 hex digest");
    const existingId = leasesBySession.get(sessionId);
    const existing = existingId ? leases.get(existingId) : null;
    if (existing) {
      if (existing.goalHash !== goalHash) throw new Error("session id already belongs to a different approved goal");
      return leasePublic(existing);
    }
    const status = await inspect();
    const supported = ["session.end", ...(status.screenshotReady ? ["screenshot"] : []), ...status.operations];
    const requested = Array.isArray(payload?.allowedOperations)
      ? payload.allowedOperations.filter((operation) => supported.includes(operation))
      : supported;
    const allowedOperations = [...new Set(requested)];
    if (!allowedOperations.includes("session.end")) allowedOperations.push("session.end");
    const requestedMax = Number(payload?.maxActions);
    const maxActions = Number.isSafeInteger(requestedMax) ? Math.max(1, Math.min(500, requestedMax)) : 200;
    const startedAt = now();
    const requestedExpiry = Date.parse(payload?.expiresAt ?? "");
    const expiresAt = Math.min(
      startedAt + absoluteLeaseMs,
      Number.isFinite(requestedExpiry) ? requestedExpiry : startedAt + absoluteLeaseMs
    );
    if (expiresAt <= startedAt) throw new Error("computer-use session approval has expired");
    const lease = {
      id: `culease_${crypto.randomUUID().replaceAll("-", "")}`,
      sessionId,
      goalHash,
      startedAt,
      lastUsedAt: startedAt,
      expiresAt,
      lastSequence: 0,
      maxActions,
      allowedOperations,
      frames: new Map(),
      results: new Map(),
      helperControllers: new Set(),
      executing: 0
    };
    leases.set(lease.id, lease);
    leasesBySession.set(sessionId, lease.id);
    return leasePublic(lease);
  };

  const withLease = async (operation, payload, perform) => {
    purgeExpired();
    const leaseId = validId(payload?.leaseId, "leaseId");
    const actionId = validId(payload?.actionId, "actionId");
    const sequence = Number(payload?.sequence);
    const lease = leases.get(leaseId);
    if (!lease) throw new Error("computer-use node lease is missing or expired");
    const signature = actionSignature(operation, payload);
    const cached = lease.results.get(actionId);
    if (cached) {
      if (cached.sequence !== sequence || cached.operation !== operation || cached.signature !== signature) {
        throw new Error("computer-use action id was reused with different input");
      }
      if (cached.error) {
        const failure = new Error(cached.error);
        failure.nodeSequenceConsumed = true;
        throw failure;
      }
      return cached.result;
    }
    if (!Number.isSafeInteger(sequence) || sequence !== lease.lastSequence + 1) {
      throw new Error(`computer-use action sequence must be ${lease.lastSequence + 1}`);
    }
    if (operation !== "session.end" && lease.lastSequence >= lease.maxActions) {
      throw new Error("computer-use node lease action limit reached");
    }
    if (!lease.allowedOperations.includes(operation)) throw new Error(`operation ${operation} is outside this approved lease`);
    if (operation !== "session.end" && lease.executing > 0) {
      throw new Error("another computer-use action is still executing");
    }
    lease.lastSequence = sequence;
    lease.lastUsedAt = now();
    lease.executing += 1;
    try {
      const result = await perform(lease);
      if (operation !== "session.end" && leases.get(lease.id) !== lease) {
        throw new Error("computer-use node lease was revoked during the action");
      }
      lease.results.set(actionId, { sequence, operation, signature, result });
      trimResults(lease.results);
      return result;
    } catch (error) {
      // A helper must never turn typed content into an HTTP/node-control error.
      const message = operation === "type" ? "computer type action failed" : mapError(error);
      lease.results.set(actionId, { sequence, operation, signature, error: message });
      trimResults(lease.results);
      const failure = new Error(message);
      failure.nodeSequenceConsumed = true;
      throw failure;
    } finally {
      lease.executing = Math.max(0, lease.executing - 1);
    }
  };

  const endLease = (payload) => {
    purgeExpired();
    const leaseId = validId(payload?.leaseId, "leaseId");
    const lease = leases.get(leaseId);
    // Revocation is authenticated by the surrounding node transport and is
    // intentionally idempotent. It must not depend on action sequencing:
    // Stop can race an in-flight event whose sequence has not settled yet.
    if (!lease) return { ok: true, alreadyEnded: true };
    leases.delete(lease.id);
    if (leasesBySession.get(lease.sessionId) === lease.id) leasesBySession.delete(lease.sessionId);
    abortLeaseHelpers(lease);
    lease.frames.clear();
    return { ok: true };
  };

  const invoke = async (operation, payload = {}) => {
    if (operation === "session.start") return await startLease(payload);
    if (operation === "session.end") return endLease(payload);
    return withLease(operation, payload, async (lease) => {
      if (operation === "screenshot") {
        const status = await inspect();
        if (!status.screenshotReady) throw new Error(status.detail || "live screenshot is not currently available");
        const shot = await runForLease(lease, async (signal) => (
          screenshot
            ? await screenshot(run, await geometry(run), { signal })
            : await screenshotFromHelper(helperRun, helperPath, { signal })
        ));
        const frameId = `cuframe_${crypto.randomUUID().replaceAll("-", "")}`;
        const focus = normalizePrivateFocus(shot.focus);
        const { focus: _privateFocus, ...publicShot } = shot;
        lease.frames.clear();
        lease.frames.set(frameId, {
          width: Number(shot.width), height: Number(shot.height), scale: Number(shot.scale) || 1,
          offsetX: Number(shot.offsetX) || 0, offsetY: Number(shot.offsetY) || 0,
          focus,
          createdAt: now()
        });
        return { ...publicShot, frameId };
      }
      if (!INPUT_OPERATIONS.includes(operation)) throw new Error("unsupported computer-use operation");
      const status = await inspect();
      if (!status.inputReady || !status.operations.includes(operation)) {
        throw new Error(status.detail || `${operation} is not currently available`);
      }
      const action = normalizeInputPayload(operation, payload, lease, now(), frameTtlMs);
      if (helperPath) {
        // Typed text goes through stdin, never argv: command arguments are
        // visible to other local processes via ps even when the audit log is
        // properly redacted.
        await runForLease(lease, (signal) => helperRun(helperPath, operation, action, {
          timeoutMs: 10_000,
          maxStdoutBytes: 128 * 1024,
          signal
        }));
        lease.frames.clear();
        return { ok: true };
      }
      throw new Error("computer input requires the signed OpenAGI computer helper");
    });
  };

  return {
    async health() {
      const status = await inspect();
      return {
        ok: status.screenshotReady && status.inputReady,
        service: "computer",
        capability: {
          id: "computer-use",
          ready: status.screenshotReady && status.inputReady,
          operations: ALL_OPERATIONS.filter((operation) => (
            !INPUT_OPERATIONS.includes(operation) || status.operations.includes(operation)
          )),
          screenshotReady: status.screenshotReady,
          inputReady: status.inputReady,
          detail: status.detail,
          checkedAt: new Date(now()).toISOString()
        }
      };
    },
    invoke,
    cancelSession(sessionId) {
      const leaseId = leasesBySession.get(sessionId);
      const lease = leaseId ? leases.get(leaseId) : null;
      if (lease) {
        leases.delete(leaseId);
        abortLeaseHelpers(lease);
      }
      leasesBySession.delete(sessionId);
      return Boolean(lease);
    },
    async close() {
      for (const controller of helperControllers) controller.abort();
      leases.clear();
      leasesBySession.clear();
      helperControllers.clear();
    }
  };
}

export function createComputerServer({ token, executor = null, ...executorOptions } = {}) {
  const computer = executor ?? createComputerExecutor(executorOptions);
  return http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, "http://x");
    if (!authorized(req, token)) return send(401, { error: "unauthorized" });
    if (req.method === "GET" && url.pathname === "/health") {
      return computer.health().then((body) => send(200, body), (error) => send(500, { error: mapError(error) }));
    }
    if (req.method !== "POST") return send(404, { error: "not found" });

    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 2e6) req.destroy(); });
    req.on("end", async () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { error: "bad json" }); }
      try {
        const operation = operationForPath(url.pathname);
        if (!operation) return send(404, { error: "not found" });
        return send(200, await computer.invoke(operation, body));
      } catch (error) {
        return send(500, {
          error: mapError(error),
          sequenceConsumed: error?.nodeSequenceConsumed === true
        });
      }
    });
  });
}

function operationForPath(pathname) {
  return ({
    "/session/start": "session.start",
    "/session/end": "session.end",
    "/screenshot": "screenshot",
    "/click": "click",
    "/move": "move",
    "/type": "type",
    "/key": "key",
    "/scroll": "scroll"
  })[pathname] ?? null;
}

function authorized(req, token) {
  if (typeof token !== "string" || !token) return false;
  const auth = req.headers.authorization ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeCapabilityStatus(raw = {}) {
  const operations = Array.isArray(raw.operations)
    ? raw.operations.filter((operation) => INPUT_OPERATIONS.includes(operation))
    : (raw.inputReady === true ? [...INPUT_OPERATIONS] : []);
  return {
    screenshotReady: typeof raw.screenshotReady === "boolean" ? raw.screenshotReady : raw.screenRecording === true,
    inputReady: (typeof raw.inputReady === "boolean" ? raw.inputReady : raw.accessibility === true)
      && INPUT_OPERATIONS.every((operation) => operations.includes(operation)),
    operations,
    detail: typeof raw.detail === "string" ? raw.detail.slice(0, 300) : null
  };
}

function leasePublic(lease) {
  return {
    leaseId: lease.id,
    sessionId: lease.sessionId,
    expiresAt: new Date(lease.expiresAt).toISOString(),
    nextSequence: lease.lastSequence + 1,
    allowedOperations: lease.allowedOperations,
    maxActions: lease.maxActions
  };
}

function validId(value, label) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9:_-]{1,240}$/.test(value)) {
    throw new Error(`${label} is required and malformed`);
  }
  return value;
}

function trimResults(results) {
  while (results.size > 20) results.delete(results.keys().next().value);
}

function actionSignature(operation, payload) {
  const canonical = canonicalJson({ operation, payload });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number`);
  return number;
}

function finiteInteger(value, label) {
  const number = finite(value, label);
  if (!Number.isSafeInteger(number)) throw new Error(`${label} must be an integer`);
  return number;
}

function normalizeInputPayload(operation, payload, lease, at, frameTtlMs) {
  if (operation === "click") {
    const button = payload.button;
    if (!["left", "right", "middle"].includes(button)) throw new Error("button must be left, right, or middle");
    const point = pointInFrame(payload, lease, at, frameTtlMs);
    return { x: scale(point.x, point.frame.scale), y: scale(point.y, point.frame.scale), button, focus: point.frame.focus };
  }
  if (operation === "move") {
    const point = pointInFrame(payload, lease, at, frameTtlMs);
    return { x: scale(point.x, point.frame.scale), y: scale(point.y, point.frame.scale), focus: point.frame.focus };
  }
  if (operation === "type") {
    const frame = requireFreshFrame(payload, lease, at, frameTtlMs);
    if (typeof payload.text !== "string") throw new Error("text is required");
    const value = payload.text;
    if (Buffer.byteLength(value, "utf8") > 16 * 1024 || value.includes("\0")) throw new Error("typed text exceeds 16 KiB or contains NUL");
    return { text: value, focus: frame.focus };
  }
  if (operation === "key") {
    const frame = requireFreshFrame(payload, lease, at, frameTtlMs);
    const chord = String(payload.chord ?? "").toLowerCase().trim();
    const parts = chord.split("+").map((part) => part.trim()).filter(Boolean);
    const modifiers = new Set(["cmd", "command", "ctrl", "control", "alt", "opt", "option", "shift"]);
    const keys = parts.filter((part) => !modifiers.has(part));
    if (!chord || chord.length > 80 || keys.length !== 1 || !/^(?:[a-z0-9`=\-\[\]\\;',./]|enter|return|esc|escape|tab|space|delete|backspace|up|down|left|right|home|end|pageup|pagedown)$/.test(keys[0])) {
      throw new Error("chord must contain supported modifiers and exactly one supported key");
    }
    return { chord, focus: frame.focus };
  }
  const point = pointInFrame(payload, lease, at, frameTtlMs);
  return {
    x: scale(point.x, point.frame.scale),
    y: scale(point.y, point.frame.scale),
    deltaX: boundedScrollDelta(payload.deltaX ?? 0, "deltaX"),
    deltaY: boundedScrollDelta(payload.deltaY ?? 0, "deltaY"),
    focus: point.frame.focus
  };
}

function boundedScrollDelta(value, label) {
  const number = finiteInteger(value, label);
  if (Math.abs(number) > 1_000) throw new Error(`${label} must be between -1000 and 1000`);
  return number;
}

function pointInFrame(payload, lease, at, frameTtlMs) {
  const frame = requireFreshFrame(payload, lease, at, frameTtlMs);
  const x = finiteInteger(payload.x, "x");
  const y = finiteInteger(payload.y, "y");
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
    throw new Error("coordinates are outside the referenced screenshot frame");
  }
  return { x: x + (frame.offsetX / frame.scale), y: y + (frame.offsetY / frame.scale), frame };
}

function requireFreshFrame(payload, lease, at, frameTtlMs) {
  const frameId = validId(payload?.frameId, "frameId");
  const frame = lease.frames.get(frameId);
  const ttl = Math.max(1_000, Math.min(DEFAULT_FRAME_TTL_MS, Number(frameTtlMs) || DEFAULT_FRAME_TTL_MS));
  if (!frame || (at - frame.createdAt) > ttl) {
    lease.frames.delete(frameId);
    throw new Error("frameId is unknown, stale, or expired; take a new screenshot before acting");
  }
  return frame;
}

function normalizePrivateFocus(raw) {
  const focus = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  const windowID = Number(focus?.windowID);
  const processIdentifier = Number(focus?.processIdentifier);
  const bundleIdentifier = typeof focus?.bundleIdentifier === "string" ? focus.bundleIdentifier : "";
  const title = typeof focus?.title === "string" ? focus.title : "";
  const x = Number(focus?.x);
  const y = Number(focus?.y);
  const width = Number(focus?.width);
  const height = Number(focus?.height);
  if (!Number.isSafeInteger(windowID) || windowID <= 0
      || !Number.isSafeInteger(processIdentifier) || processIdentifier <= 0
      || !bundleIdentifier || Buffer.byteLength(bundleIdentifier, "utf8") > 512
      || !title || Buffer.byteLength(title, "utf8") > 1_024
      || ![x, y, width, height].every(Number.isFinite)
      || width < 32 || height < 32) {
    throw new Error("computer helper did not bind the screenshot to an exact focused window");
  }
  return { windowID, processIdentifier, bundleIdentifier, title, x, y, width, height };
}

export function runComputerHelper(helperPath, operation, payload = null, {
  timeoutMs = 10_000,
  maxStdoutBytes = 128 * 1024,
  maxStderrBytes = 32 * 1024,
  signal = null
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, [operation], { stdio: ["pipe", "pipe", "pipe"] });
    activeHelperChildren.add(child);
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let finished = false;
    let terminationError = null;
    let hardKillTimer = null;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      activeHelperChildren.delete(child);
      clearTimeout(timer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      signal?.removeEventListener?.("abort", onAbort);
      if (error) reject(error);
      else resolve(result);
    };
    const terminateCooperatively = (error) => {
      if (finished || terminationError) return;
      terminationError = error;
      child.kill("SIGTERM");
      hardKillTimer = setTimeout(() => {
        if (!finished) child.kill("SIGKILL");
      }, 500);
      hardKillTimer.unref?.();
    };
    const onAbort = () => terminateCooperatively(new Error("computer helper was cancelled"));
    const overflow = (stream) => {
      terminateCooperatively(new Error(`computer helper ${stream} exceeded its limit`));
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) return overflow("stdout");
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxStderrBytes) return overflow("stderr");
      stderr.push(chunk);
    });
    child.stdin.on("error", (error) => {
      // A helper may exit or be cancelled before the bounded stdin payload is
      // flushed. Consume EPIPE here so it cannot become an uncaught process
      // error; preserve the cancellation reason when one already exists.
      if (finished || terminationError) return;
      finish(error);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr);
      if (terminationError) return finish(terminationError);
      if (code === 0) return finish(null, { stdout: out, stderr: err });
      const failure = new Error(`computer helper failed (${signal || code || "unknown"})`);
      failure.stderr = err.toString("utf8").slice(0, maxStderrBytes);
      finish(failure);
    });
    const timer = setTimeout(() => {
      terminateCooperatively(new Error("computer helper timed out"));
    }, Math.max(1, timeoutMs));
    timer.unref?.();
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    try {
      child.stdin.end(payload == null ? undefined : JSON.stringify(payload));
    } catch (error) {
      child.kill("SIGKILL");
      finish(error);
    }
  });
}

export function cancelComputerHelperProcesses() {
  for (const child of activeHelperChildren) child.kill("SIGKILL");
}

async function screenshotFromHelper(helperRun, helperPath, { signal = null } = {}) {
  if (!helperPath) throw new Error("the signed OpenAGI computer helper is unavailable");
  const { stdout } = await helperRun(helperPath, "screenshot", null, {
    timeoutMs: 10_000,
    maxStdoutBytes: 12 * 1024 * 1024,
    maxStderrBytes: 32 * 1024,
    signal
  });
  const shot = JSON.parse(String(stdout));
  if (shot?.format !== "png" || typeof shot?.base64 !== "string"
      || !Number.isSafeInteger(shot?.width) || shot.width <= 0
      || !Number.isSafeInteger(shot?.height) || shot.height <= 0
      || Buffer.byteLength(shot.base64, "utf8") > 12 * 1024 * 1024) {
    throw new Error("computer helper returned an invalid screenshot");
  }
  return {
    format: "png",
    base64: shot.base64,
    width: shot.width,
    height: shot.height,
    bytes: Number.isSafeInteger(shot.bytes) ? shot.bytes : Math.floor(shot.base64.length * 0.75),
    scale: Number.isFinite(shot.scale) && shot.scale > 0 ? shot.scale : 1,
    offsetX: Number.isFinite(shot.offsetX) ? shot.offsetX : 0,
    offsetY: Number.isFinite(shot.offsetY) ? shot.offsetY : 0,
    focus: normalizePrivateFocus(shot.focus)
  };
}

// Logical (point) size of the main display + the downscale factor we apply.
// factor maps a coordinate in the returned screenshot's space up to display
// points (what CGEvent consumes). Source: `system_profiler` "UI Looks like"
// (the effective/point resolution) — needs NO TCC permission, unlike asking
// Finder via osascript (which requires Automation/AppleEvents approval).
// Cached briefly since the resolution rarely changes and system_profiler is slow.
let _geoCache = null;
let _geoCacheAt = 0;
async function defaultGeometry(run) {
  if (_geoCache && Date.now() - _geoCacheAt < 30_000) return _geoCache;
  let logicalW = null;
  let logicalH = null;
  try {
    const { stdout } = await run("system_profiler", ["SPDisplaysDataType"], {
      timeout: 5_000, maxBuffer: 1024 * 1024, killSignal: "SIGKILL"
    });
    const m = String(stdout).match(/UI Looks like:\s*(\d+)\s*x\s*(\d+)/i)
      || String(stdout).match(/Resolution:\s*(\d+)\s*x\s*(\d+)/i);
    if (m) { logicalW = parseInt(m[1], 10); logicalH = parseInt(m[2], 10); }
  } catch { /* fall back to no scaling */ }
  const targetW = SCALE_WIDTH && logicalW ? Math.min(SCALE_WIDTH, logicalW) : (logicalW ?? 0);
  const factor = logicalW && targetW ? logicalW / targetW : 1;
  const geo = { logicalW, logicalH, targetW, factor };
  if (logicalW) { _geoCache = geo; _geoCacheAt = Date.now(); } // only cache successful reads
  return geo;
}

function scale(v, factor) { return Math.round(Number(v || 0) * (factor || 1)); }

function mapError(error) {
  const msg = error?.stderr || error?.message || String(error);
  if (/could not create image from display/i.test(msg)) return "no display to capture — attach a display (or virtual display) on the node";
  if (/not authorized|accessibility|not permitted|operation not permitted/i.test(msg)) {
    return "permission denied — grant Screen Recording (capture) and Accessibility (input) to the node process in System Settings";
  }
  return msg;
}
