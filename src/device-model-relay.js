import crypto from "node:crypto";
import { WebSocketServer } from "ws";

// WS /device/model: the phone app's native model bridge. In phone-only mode
// the daemon runs inside the app, and the only model it has is the phone's
// own (Apple Foundation Models / Gemini Nano), which only native code can
// call. The app holds one socket here; OnDeviceModelProvider sends each
// generation down it and waits for the answer.
//
// Frames (JSON text):
//   app → daemon   { type: "hello", model, contextSize }
//                  { type: "delta", id, text }            visible text so far, appended
//                  { type: "result", id, text?, toolCall?: { name, arguments }, usage? }
//                  { type: "error", id, code, message }
//   daemon → app   { type: "generate", id, system, messages, tools, maxOutputTokens }
//                  { type: "cancel", id }

export const DEVICE_MODEL_PATH = "/device/model";
export const DEVICE_MODEL_UNAVAILABLE = "device-model-unavailable";
const MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_CONTEXT_SIZE = 4096;

function deviceModelError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sameToken(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export class DeviceModelHub {
  constructor() {
    this.socket = null;
    this.info = null;
    this.pending = new Map();
    this.waiters = new Set();
  }

  get connected() {
    return Boolean(this.socket);
  }

  get contextSize() {
    const size = Number(this.info?.contextSize);
    return Number.isSafeInteger(size) && size >= 512 ? size : DEFAULT_CONTEXT_SIZE;
  }

  // At most one device: a newer socket replaces the old one (the app
  // reconnects after a background suspension before the old TCP close lands).
  attach(socket) {
    if (this.socket && this.socket !== socket) {
      this.failPending(deviceModelError(DEVICE_MODEL_UNAVAILABLE, "The phone's model bridge reconnected."));
      try { this.socket.close(4000, "replaced"); } catch { /* already gone */ }
    }
    this.socket = socket;
    this.info = null;
    socket.on("message", (data) => this.receive(socket, data));
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.failPending(deviceModelError(DEVICE_MODEL_UNAVAILABLE, "The phone's model bridge disconnected."));
    });
    socket.on("error", () => { /* close follows */ });
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  receive(socket, data) {
    if (socket !== this.socket) return;
    let frame;
    try { frame = JSON.parse(String(data)); } catch { return; }
    if (!frame || typeof frame !== "object") return;
    if (frame.type === "hello") {
      this.info = { model: String(frame.model ?? "on-device"), contextSize: frame.contextSize };
      return;
    }
    const entry = this.pending.get(frame.id);
    if (!entry) return;
    if (frame.type === "delta") {
      if (typeof frame.text === "string" && frame.text) entry.onDelta?.(frame.text);
      return;
    }
    this.pending.delete(frame.id);
    entry.cleanup();
    if (frame.type === "error") {
      entry.reject(deviceModelError(String(frame.code || "device-model-error"), String(frame.message || "The phone's model failed.")));
    } else if (frame.type === "result") {
      entry.resolve({ text: typeof frame.text === "string" ? frame.text : "", toolCall: normalizeToolCall(frame.toolCall), usage: frame.usage ?? null });
    } else {
      entry.reject(deviceModelError("device-model-error", `Unexpected frame type: ${frame.type}`));
    }
  }

  failPending(error) {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      entry.cleanup();
      entry.reject(error);
    }
  }

  // Resolves once a device socket is attached, or rejects after waitMs. The
  // app is suspended whenever it is backgrounded, so a short wait covers a
  // foreground reconnect without hanging a cron job forever.
  waitForDevice(waitMs, signal) {
    if (this.socket) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (error) => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        signal?.removeEventListener?.("abort", onAbort);
        if (error) reject(error); else resolve();
      };
      const wake = () => done();
      const onAbort = () => done(signal.reason ?? deviceModelError("aborted", "Request cancelled."));
      const timer = setTimeout(() => done(deviceModelError(DEVICE_MODEL_UNAVAILABLE,
        "The phone's on-device model isn't reachable right now. Open the OpenAGI app and try again.")), waitMs);
      this.waiters.add(wake);
      signal?.addEventListener?.("abort", onAbort, { once: true });
    });
  }

  async request(payload, { onDelta, signal, waitMs = 30_000, timeoutMs = 120_000 } = {}) {
    signal?.throwIfAborted?.();
    await this.waitForDevice(waitMs, signal);
    const socket = this.socket;
    const id = `gen_${crypto.randomBytes(8).toString("hex")}`;
    return await new Promise((resolve, reject) => {
      const onAbort = () => {
        if (!this.pending.delete(id)) return;
        cleanup();
        try { socket.send(JSON.stringify({ type: "cancel", id })); } catch { /* gone */ }
        reject(signal.reason ?? deviceModelError("aborted", "Request cancelled."));
      };
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        cleanup();
        try { socket.send(JSON.stringify({ type: "cancel", id })); } catch { /* gone */ }
        reject(deviceModelError("device-model-timeout", "The phone's model took too long to answer."));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
      };
      this.pending.set(id, { resolve, reject, onDelta, cleanup });
      signal?.addEventListener?.("abort", onAbort, { once: true });
      try {
        socket.send(JSON.stringify({ type: "generate", id, ...payload }));
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        reject(deviceModelError(DEVICE_MODEL_UNAVAILABLE, `Couldn't reach the phone's model: ${error.message}`));
      }
    });
  }

  close() {
    this.failPending(deviceModelError(DEVICE_MODEL_UNAVAILABLE, "The daemon is shutting down."));
    try { this.socket?.close(1001, "shutdown"); } catch { /* gone */ }
    this.socket = null;
  }
}

function normalizeToolCall(value) {
  if (!value || typeof value !== "object" || typeof value.name !== "string" || !value.name) return null;
  let args = value.arguments ?? {};
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { args = {}; }
  }
  return { name: value.name, arguments: args && typeof args === "object" && !Array.isArray(args) ? args : {} };
}

// One hub per process: createModelProvider() runs in several places and each
// OnDeviceModelProvider must reach the same socket.
export const deviceModelHub = new DeviceModelHub();

// Upgrade entry in the same shape attachG2SpeechRelay's `upgrades` list
// takes. Loopback only, and only with the daemon's owner token: this socket
// receives every prompt the daemon sends, so a paired node must never hold it.
export function attachDeviceModelRelay({ getAuthToken = () => null, hub = deviceModelHub } = {}) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES });
  const deny = (socket, status) => {
    socket.write(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 404 ? "Not Found" : "Forbidden"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };
  const upgrade = (req, socket, head) => {
    if (req.method !== "GET") return deny(socket, 404);
    if (!isLoopbackAddress(req.socket?.remoteAddress)) return deny(socket, 403);
    const header = String(req.headers.authorization ?? "");
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!sameToken(bearer, getAuthToken())) return deny(socket, 401);
    wss.handleUpgrade(req, socket, head, (client) => hub.attach(client));
  };
  return { path: DEVICE_MODEL_PATH, upgrade, close: () => { hub.close(); wss.close(); } };
}

function isLoopbackAddress(address) {
  const value = String(address ?? "");
  return value === "::1" || value.startsWith("127.") || value.startsWith("::ffff:127.");
}
