import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

// Computer-use node service — runs on a Mac with a display (or a virtual
// display) and exposes screen capture + input synthesis over the network so a
// remote OpenAGI "main" can actually drive it. Bearer-token gated; the main
// reaches it through the computer_* tools when OPENAGI_COMPUTER_NODE is set.
//
//   GET  /health                         -> { ok, service: "computer" }
//   POST /screenshot {}                  -> { format, base64, width, height, bytes }
//   POST /click  { x, y, button? }       -> { ok: true }
//   POST /move   { x, y }                -> { ok: true }
//   POST /type   { text }                -> { ok: true }
//   POST /key    { chord }               -> { ok: true }   ("cmd+a", "enter", …)
//   POST /scroll { x, y, deltaX, deltaY }-> 501 (not supported via cliclick)
//
// Real execution: `screencapture` for the image, `cliclick` for input. The
// node process needs macOS Screen Recording (capture) + Accessibility (input)
// permissions — failures surface as explicit errors, never fake success.

export function createComputerServer({ token, run = execFileAsync, screenshot = defaultScreenshot } = {}) {
  return http.createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, "http://x");
    if (url.pathname !== "/health") {
      const auth = req.headers.authorization ?? "";
      const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!token || presented !== token) return send(401, { error: "unauthorized" });
    }
    if (req.method === "GET" && url.pathname === "/health") return send(200, { ok: true, service: "computer" });
    if (req.method !== "POST") return send(404, { error: "not found" });

    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 2e6) req.destroy(); });
    req.on("end", async () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { error: "bad json" }); }
      try {
        switch (url.pathname) {
          case "/screenshot": return send(200, await screenshot(run));
          case "/click": {
            const prefix = body.button === "right" ? "rc" : body.button === "middle" ? "tc" : "c";
            await run("cliclick", [`${prefix}:${int(body.x)},${int(body.y)}`]);
            return send(200, { ok: true });
          }
          case "/move": await run("cliclick", [`m:${int(body.x)},${int(body.y)}`]); return send(200, { ok: true });
          case "/type": await run("cliclick", ["-w", "20", `t:${String(body.text ?? "")}`]); return send(200, { ok: true });
          case "/key": await run("cliclick", keyArgsForChord(body.chord)); return send(200, { ok: true });
          case "/scroll": return send(501, { error: "scroll is not supported on this node (cliclick has no scroll primitive)" });
          default: return send(404, { error: "not found" });
        }
      } catch (error) {
        return send(500, { error: mapError(error) });
      }
    });
  });
}

async function defaultScreenshot(run) {
  const file = path.join(os.tmpdir(), `openagi-cu-${process.pid}-${Math.floor(process.hrtime()[1])}.png`);
  try {
    await run("screencapture", ["-x", "-t", "png", file]);
    const buf = fs.readFileSync(file);
    const dims = pngDims(buf);
    return { format: "png", base64: buf.toString("base64"), width: dims.w, height: dims.h, bytes: buf.length };
  } finally {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
}

// Parse width/height from a PNG IHDR chunk (bytes 16/20, big-endian).
function pngDims(buf) {
  if (buf.length >= 24 && buf.toString("ascii", 12, 16) === "IHDR") {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  return { w: null, h: null };
}

// "cmd+shift+t" / "enter" / "a" -> cliclick argv. Modifiers held around the key;
// named keys use kp:, single printable chars use t:.
export function keyArgsForChord(chord) {
  const parts = String(chord ?? "").toLowerCase().split("+").map((s) => s.trim()).filter(Boolean);
  const MOD = { cmd: "cmd", command: "cmd", ctrl: "ctrl", control: "ctrl", alt: "alt", opt: "alt", option: "alt", shift: "shift", fn: "fn" };
  const NAMED = {
    enter: "return", return: "return", esc: "esc", escape: "esc", tab: "tab", space: "space",
    delete: "delete", backspace: "delete", up: "arrow-up", down: "arrow-down", left: "arrow-left",
    right: "arrow-right", home: "home", end: "end", pageup: "page-up", pagedown: "page-down"
  };
  const mods = [];
  let key = null;
  for (const p of parts) {
    if (MOD[p]) mods.push(MOD[p]);
    else key = p;
  }
  const args = [];
  if (mods.length) args.push(`kd:${[...new Set(mods)].join(",")}`);
  if (key) args.push(NAMED[key] ? `kp:${NAMED[key]}` : `t:${key}`);
  if (mods.length) args.push(`ku:${[...new Set(mods)].join(",")}`);
  return args;
}

function int(v) { return Math.round(Number(v)) || 0; }

function mapError(error) {
  const msg = error?.stderr || error?.message || String(error);
  if (/ENOENT/.test(msg) && /cliclick/.test(msg)) return "cliclick is not installed on the node (brew install cliclick)";
  if (/could not create image from display/i.test(msg)) return "no display to capture — attach a display (or virtual display) on the node";
  if (/not authorized|accessibility|not permitted|operation not permitted/i.test(msg)) {
    return "permission denied — grant Screen Recording (capture) and Accessibility (input) to the node process in System Settings";
  }
  return msg;
}
