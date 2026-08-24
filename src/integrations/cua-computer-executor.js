import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createComputerExecutor } from "./computer-server.js";

const INPUT_OPERATIONS = ["click", "drag", "move", "type", "key", "scroll"];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function createConfiguredComputerExecutor({ env = process.env, ...options } = {}) {
  const backend = String(env.OPENAGI_COMPUTER_BACKEND ?? "native").trim().toLowerCase();
  if (backend === "native" || backend === "openagi") return createComputerExecutor(options);
  if (backend === "cua") {
    return createCuaComputerExecutor({
      binaryPath: env.OPENAGI_CUA_DRIVER_PATH,
      ...options
    });
  }
  return createComputerExecutor({
    ...options,
    capabilityStatus: async () => ({
      screenshotReady: false,
      inputReady: false,
      operations: [],
      detail: "the configured computer backend is unsupported"
    })
  });
}

export function createCuaComputerExecutor({
  binaryPath,
  run = runCuaDriver,
  binaryReady = defaultBinaryReady,
  tempRoot = os.tmpdir(),
  ...executorOptions
} = {}) {
  const binary = validBinaryPath(binaryPath) ? binaryPath : null;
  const call = async (args, payload = null, options = {}) => {
    if (!binary || !binaryReady(binary)) throw new Error("the configured Cua Driver executable is unavailable");
    return await run(binary, args, payload, options);
  };

  const capabilityStatus = async () => {
    if (!binary || !binaryReady(binary)) {
      return { screenshotReady: false, inputReady: false, operations: [], detail: "Cua Driver is not configured" };
    }
    try {
      const result = await call(["permissions", "status", "--json"], null, {
        timeoutMs: 3_000,
        maxStdoutBytes: 256 * 1024,
        maxStderrBytes: 32 * 1024
      });
      const status = parseJson(result.stdout, "Cua Driver permission status");
      const daemonAttributed = status?.source?.attribution === "driver-daemon";
      const screenshotReady = daemonAttributed && status?.screen_recording === true;
      const inputReady = daemonAttributed && status?.accessibility === true;
      return {
        screenshotReady,
        inputReady,
        operations: inputReady ? [...INPUT_OPERATIONS] : [],
        detail: screenshotReady && inputReady
          ? "Cua Driver coordinate actions are available, but semantic element and app actions are not"
          : "Cua Driver needs Screen Recording and Accessibility permission"
      };
    } catch {
      return { screenshotReady: false, inputReady: false, operations: [], detail: "Cua Driver is not reachable" };
    }
  };

  const screenshot = async (_run, _geometry, { signal } = {}) => {
    const dir = fs.mkdtempSync(path.join(tempRoot, "openagi-cua-frame-"));
    const file = path.join(dir, "frame.png");
    try {
      const windowsResult = await call(["call", "list_windows"], {}, {
        timeoutMs: 5_000,
        maxStdoutBytes: 2 * 1024 * 1024,
        maxStderrBytes: 32 * 1024,
        signal
      });
      const window = selectFrontmostWindow(parseJson(windowsResult.stdout, "Cua Driver window list"));
      const result = await call(["call", "get_window_state"], {
        pid: window.pid,
        window_id: window.windowId,
        session: "openagi",
        screenshot_out_file: file
      }, {
        timeoutMs: 15_000,
        maxStdoutBytes: 512 * 1024,
        maxStderrBytes: 32 * 1024,
        signal
      });
      const state = parseJson(result.stdout, "Cua Driver desktop state");
      const png = fs.readFileSync(file);
      if (png.length === 0 || png.length > 12 * 1024 * 1024 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error("Cua Driver returned an invalid screenshot");
      }
      const width = positiveInteger(state?.screenshot_width, "screenshot width");
      const height = positiveInteger(state?.screenshot_height, "screenshot height");
      return {
        format: "png",
        base64: png.toString("base64"),
        width,
        height,
        bytes: png.length,
        scale: window.width / width,
        offsetX: 0,
        offsetY: 0,
        // This identity stays inside the node executor. Cua revalidates the
        // same pid/window_id on every action, so a focus change after capture
        // cannot redirect input into another application.
        focus: {
          windowID: window.windowId,
          processIdentifier: window.pid,
          bundleIdentifier: `cua.process.${window.pid}`,
          title: window.title,
          x: window.x,
          y: window.y,
          width: window.width,
          height: window.height
        }
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  const helperRun = async (_helperPath, operation, payload, options = {}) => {
    const { tool, args } = cuaAction(operation, payload);
    const result = await call(["call", tool], args, {
      timeoutMs: options.timeoutMs ?? 10_000,
      maxStdoutBytes: 256 * 1024,
      maxStderrBytes: 32 * 1024,
      signal: options.signal
    });
    const outcome = parseJson(result.stdout, "Cua Driver action result");
    if (outcome?.refusal === true || outcome?.status === "refused" || outcome?.effect === "refused") {
      throw new Error("Cua Driver refused the action");
    }
    if (!["confirmed", "partial", "unverifiable"].includes(outcome?.effect)) {
      throw new Error("Cua Driver returned an invalid action result");
    }
    return { stdout: Buffer.from("{}"), stderr: Buffer.alloc(0) };
  };

  return createComputerExecutor({
    ...executorOptions,
    helperPath: binary ?? "cua-driver-unavailable",
    helperRun,
    screenshot,
    capabilityStatus
  });
}

function cuaAction(operation, payload = {}) {
  const focus = payload?.focus;
  const pid = Number(focus?.processIdentifier);
  const windowId = Number(focus?.windowID);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(windowId) || windowId <= 0) {
    throw new Error("Cua Driver action is missing its captured window identity");
  }
  const base = { target: { kind: "window", pid, window_id: windowId }, session: "openagi" };
  if (operation === "click") return { tool: "click", args: { ...base, x: payload.x, y: payload.y, button: payload.button, count: payload.count } };
  if (operation === "drag") return {
    tool: "drag",
    args: {
      ...base,
      from_x: payload.fromX,
      from_y: payload.fromY,
      to_x: payload.toX,
      to_y: payload.toY,
      button: payload.button,
      duration_ms: payload.durationMs
    }
  };
  if (operation === "move") return { tool: "move_cursor", args: { ...base, x: payload.x, y: payload.y } };
  if (operation === "type") return { tool: "type_text", args: { ...base, text: payload.text } };
  if (operation === "key") {
    const keys = String(payload.chord ?? "").split("+").map(normalizeKey).filter(Boolean);
    return keys.length === 1
      ? { tool: "press_key", args: { ...base, key: keys[0] } }
      : { tool: "hotkey", args: { ...base, keys } };
  }
  if (operation === "scroll") {
    const horizontal = Math.abs(payload.deltaX ?? 0) > Math.abs(payload.deltaY ?? 0);
    const delta = horizontal ? Number(payload.deltaX ?? 0) : Number(payload.deltaY ?? 0);
    const direction = horizontal ? (delta < 0 ? "right" : "left") : (delta < 0 ? "down" : "up");
    return {
      tool: "scroll",
      args: { ...base, x: payload.x, y: payload.y, direction, by: "line", amount: Math.max(1, Math.abs(delta)) }
    };
  }
  throw new Error("unsupported Cua Driver computer operation");
}

function normalizeKey(value) {
  return ({ cmd: "command", ctrl: "control", alt: "option", opt: "option", return: "enter", esc: "escape" })[value] ?? value;
}

function validBinaryPath(value) {
  return typeof value === "string" && value.length <= 4096 && path.isAbsolute(value) && !value.includes("\0");
}

function defaultBinaryReady(binary) {
  try {
    fs.accessSync(binary, fs.constants.X_OK);
    return fs.statSync(binary).isFile();
  } catch {
    return false;
  }
}

function parseJson(value, label) {
  try { return JSON.parse(String(value)); } catch { throw new Error(`${label} was malformed`); }
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} was invalid`);
  return number;
}

function selectFrontmostWindow(raw) {
  const windows = Array.isArray(raw?.windows) ? raw.windows : (Array.isArray(raw) ? raw : []);
  const candidates = windows.map((entry) => ({
    pid: Number(entry?.pid),
    windowId: Number(entry?.window_id),
    zIndex: Number(entry?.z_index),
    title: typeof entry?.title === "string" ? entry.title : "",
    x: Number(entry?.bounds?.x),
    y: Number(entry?.bounds?.y),
    width: Number(entry?.bounds?.width),
    height: Number(entry?.bounds?.height),
    onScreen: entry?.is_on_screen !== false
  })).filter((entry) => entry.onScreen
    && Number.isSafeInteger(entry.pid) && entry.pid > 0
    && Number.isSafeInteger(entry.windowId) && entry.windowId > 0
    && Number.isSafeInteger(entry.zIndex)
    && entry.title && Buffer.byteLength(entry.title, "utf8") <= 1_024
    && [entry.x, entry.y, entry.width, entry.height].every(Number.isFinite)
    && entry.width >= 32 && entry.height >= 32);
  if (candidates.length === 0) throw new Error("Cua Driver could not identify an exact frontmost window");
  const highest = Math.max(...candidates.map((entry) => entry.zIndex));
  const frontmost = candidates.filter((entry) => entry.zIndex === highest);
  if (frontmost.length !== 1) throw new Error("Cua Driver frontmost window is ambiguous");
  return frontmost[0];
}

export function runCuaDriver(binary, args, payload = null, {
  timeoutMs = 10_000,
  maxStdoutBytes = 512 * 1024,
  maxStderrBytes = 32 * 1024,
  signal = null
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], env: cuaDriverChildEnv() });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let finished = false;
    let hardKill = null;
    const stop = () => {
      if (child.exitCode != null || child.killed) return;
      child.kill("SIGTERM");
      hardKill = setTimeout(() => child.kill("SIGKILL"), 500);
      hardKill.unref?.();
    };
    const finish = (error, result = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      signal?.removeEventListener?.("abort", onAbort);
      if (error) reject(error); else resolve(result);
    };
    const onAbort = () => { stop(); finish(new Error("Cua Driver command was cancelled")); };
    const timer = setTimeout(() => { stop(); finish(new Error("Cua Driver command timed out")); }, timeoutMs);
    timer.unref?.();
    child.on("error", (error) => finish(new Error(`Cua Driver could not start: ${error.code ?? "spawn-failed"}`)));
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) return onAbort();
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxStderrBytes) return onAbort();
      stderr.push(chunk);
    });
    child.stdin.on("error", () => { /* child exit is authoritative */ });
    child.on("close", (code) => {
      const output = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      if (code === 0) return finish(null, output);
      finish(new Error(`Cua Driver command failed (${Number.isInteger(code) ? code : "signal"})`));
    });
    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.("abort", onAbort, { once: true });
    child.stdin.end(payload == null ? "" : JSON.stringify(payload));
  });
}

export function cuaDriverChildEnv(env = process.env) {
  const allowedExact = new Set([
    "HOME", "PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "USER", "LOGNAME",
    "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS"
  ]);
  return Object.fromEntries(Object.entries(env).filter(([key]) => (
    allowedExact.has(key) || key.startsWith("XDG_") || key.startsWith("CUA_DRIVER_")
  )));
}
