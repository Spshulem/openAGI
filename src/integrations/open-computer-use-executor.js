import fs from "node:fs";
import path from "node:path";
import { createComputerExecutor, runComputerHelper } from "./computer-server.js";
import { OcuTransport } from "./ocu-transport.js";

export const OCU_VERSION = "0.3.3";
const OPERATIONS = ["list_apps", "activate_app", "click", "click_element", "drag", "move", "type", "key", "scroll", "set_value", "scroll_element"];
const sameFocus = (a, b) => ["windowID", "processIdentifier", "bundleIdentifier", "title", "x", "y", "width", "height"].every(key => a?.[key] === b?.[key]);

// OCU supplies state and app-targeted actions. The native helper remains the
// privacy/focus gate and handles operations absent from upstream 0.3.3.
export function createOpenComputerUseExecutor({ binaryPath, helperPath = process.env.OPENAGI_COMPUTER_HELPER,
  helperRun = runComputerHelper, transportFactory = () => new OcuTransport(binaryPath),
  binaryReady = file => { try { fs.accessSync(file, fs.constants.X_OK); return path.isAbsolute(file); } catch { return false; } },
  ...options } = {}) {
  let transport = null, snapshot = null, activeFrame = null, busy = false;
  const reset = () => { transport?.close(); transport = null; snapshot = null; activeFrame = null; };
  const native = async (operation, payload, opts) => {
    if (!helperPath) throw new Error("OpenAGI's signed privacy helper is required.");
    return helperRun(helperPath, operation, payload, opts);
  };
  const capture = async signal => JSON.parse(String((await native("screenshot", null,
    { signal, maxStdoutBytes: 16 * 1024 * 1024 })).stdout));
  const executor = createComputerExecutor({ ...options, helperPath: helperPath || "unavailable",
    geometry: async () => ({}),
    capabilityStatus: async () => {
      if (!binaryReady(binaryPath) || !helperPath) return { operations: [], inputReady: false, screenshotReady: false,
        detail: "Install Open Computer Use 0.3.3 and configure the signed OpenAGI privacy helper." };
      try {
        const status = JSON.parse(String((await native("status", null, { timeoutMs: 3000 })).stdout));
        return { ...status, operations: OPERATIONS, detail: "Experimental Open Computer Use 0.3.3; upstream permissions are verified on use. Native privacy and lease checks remain enforced." };
      } catch { return { operations: [], inputReady: false, screenshotReady: false, detail: "OpenAGI privacy/permission checks are unavailable." }; }
    },
    screenshot: async (_run, _geometry, { signal }) => {
      reset();
      const before = await capture(signal); // fail closed on excluded/locked windows
      transport = transportFactory();
      const result = await transport.call("get_app_state", { app: before.focus.bundleIdentifier, text_limit: 16000 }, signal);
      const after = await capture(signal);
      if (!sameFocus(before.focus, after.focus)) throw new Error("The focused window changed during capture.");
      const state = parseOcuState(result, before.focus);
      snapshot = { ...state, focus: before.focus };
      return { ...state, format: "png", scale: 1, offsetX: 0, offsetY: 0, focus: before.focus };
    },
    helperRun: async (_file, operation, payload, opts) => {
      if (["list_apps", "activate_app"].includes(operation)) return native(operation, payload, opts);
      if (!snapshot || !transport || !sameFocus(snapshot.focus, payload.focus)) throw new Error("Take a new Open Computer Use screenshot.");
      const current = await capture(opts.signal);
      if (!sameFocus(current.focus, snapshot.focus)) throw new Error("The target window changed; no input was sent.");
      // Native-only operations still require native coordinates and exact focus.
      if (["move", "scroll"].includes(operation)) return native(operation, { ...payload,
        x: payload.x * snapshot.focus.width / snapshot.width,
        y: payload.y * snapshot.focus.height / snapshot.height }, opts);
      const { name, args } = ocuAction(operation, payload);
      await transport.call(name, { app: snapshot.focus.bundleIdentifier, ...args }, opts.signal);
      return { stdout: Buffer.from("{}") };
    }
  });
  return { ...executor,
    async invoke(operation, payload = {}) {
      if (operation === "session.end") {
        const result = await executor.invoke(operation, payload); reset(); return result;
      }
      if (busy) throw new Error("Another computer action is in progress.");
      busy = true;
      try {
        if (!["session.start", "screenshot", "list_apps", "activate_app"].includes(operation) && payload.frameId !== activeFrame) {
          throw new Error("The engine frame is stale; take a new screenshot.");
        }
        const result = await executor.invoke(operation, payload);
        if (operation === "screenshot") activeFrame = result.frameId;
        else if (operation !== "session.start" && operation !== "list_apps") reset();
        return result;
      } catch (error) { reset(); throw error; }
      finally { busy = false; }
    },
    cancelSession(id) { const cancelled = executor.cancelSession(id); if (cancelled) reset(); return cancelled; },
    async close() { reset(); await executor.close(); }
  };
}

export function parseOcuState(result, focus) {
  const text = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
  if (!text.startsWith(`App=${focus.bundleIdentifier} (pid ${focus.processIdentifier})\n`)
    || !text.includes(`Window: ${JSON.stringify(focus.title)},`)) throw new Error("Upstream did not capture the approved app/window.");
  const image = result.content.find(item => item.type === "image" && item.mimeType === "image/png");
  if (!image || typeof image.data !== "string" || image.data.length > 12 * 1024 * 1024) throw new Error("Upstream did not return a bounded PNG screenshot.");
  const png = Buffer.from(image.data, "base64");
  if (png.length < 24 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new Error("Invalid upstream PNG.");
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  if (!width || !height || width > 16384 || height > 16384) throw new Error("Invalid upstream screenshot dimensions.");
  const elements = [];
  // Keep upstream IDs private: OpenAGI indices reference this captured tree only.
  const accessibility = text.replace(/^(\s*)(\d+) (\S+)(.*)$/gm, (_line, indent, id, role, rest) => {
    if (elements.length >= 2000) throw new Error("Upstream element limit exceeded.");
    const index = elements.length;
    elements.push({ index, upstreamId: id, role, actions: [] });
    return `${indent}${index} ${role}${rest}`;
  });
  if (Buffer.byteLength(accessibility) > 96 * 1024) throw new Error("Upstream tree limit exceeded.");
  return { base64: image.data, width, height, bytes: png.length, accessibility, elements };
}

export function ocuAction(operation, payload) {
  const element = () => {
    if (!/^\d+$/.test(payload.locator?.upstreamId ?? "")) throw new Error("Invalid upstream element reference.");
    return payload.locator.upstreamId;
  };
  if (operation === "click") return { name: "click", args: { x: payload.x, y: payload.y, mouse_button: payload.button, click_count: payload.count, click_method: "app_post" } };
  if (operation === "click_element") return { name: "click", args: { element_index: element(), click_method: "accessibility" } };
  if (operation === "drag") {
    if (payload.button !== "left") throw new Error("Upstream drag supports only the left button.");
    return { name: "drag", args: { from_x: payload.fromX, from_y: payload.fromY, to_x: payload.toX, to_y: payload.toY } };
  }
  if (operation === "type") return { name: "type_text", args: { text: payload.text } };
  if (operation === "key") return { name: "press_key", args: { key: payload.chord.split("+").map(key =>
    ({ cmd: "super", command: "super", option: "alt", control: "ctrl", enter: "Return", return: "Return", esc: "Escape", tab: "Tab", backspace: "BackSpace" })[key.toLowerCase()] || key).join("+") } };
  if (operation === "set_value") return { name: "set_value", args: { element_index: element(), value: payload.text } };
  if (operation === "scroll_element") return { name: "scroll", args: { element_index: element(), direction: payload.direction, pages: payload.pages } };
  throw new Error("Unsupported upstream action.");
}
