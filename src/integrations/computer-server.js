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
//   POST /screenshot {}                  -> { format, base64, width, height, scale, ... }
//   POST /click  { x, y, button? }       -> { ok: true }
//   POST /move   { x, y }                -> { ok: true }
//   POST /type   { text }                -> { ok: true }
//   POST /key    { chord }               -> { ok: true }   ("cmd+a", "enter", …)
//   POST /scroll { x, y, deltaX, deltaY }-> 501 (not supported via cliclick)
//
// Coordinate model (matches the Anthropic/OpenAI reference loops):
//   * `screencapture` returns PIXELS (a Retina/HiDPI display is 2× the logical
//     point size). `cliclick` clicks in POINTS. So raw screenshot coords would
//     be off by the backing-scale factor.
//   * Vision models are also more accurate on smaller images (~1280px wide).
//   So we downscale the screenshot to OPENAGI_COMPUTER_SCALE_WIDTH (default
//   1280, capped at the display's logical width) and report that as the image
//   the model reasons about. Click/move coords come back in THAT space and we
//   scale them up to logical points before handing them to cliclick. One factor
//   handles both Retina and the downscale.
//
// Real execution: `screencapture` for the image, `sips` to resize, `cliclick`
// for input, `osascript` (Finder desktop bounds) for the logical point size.
// The node process needs Screen Recording (capture) + Accessibility (input)
// permissions — failures surface as explicit errors, never fake success.

const SCALE_WIDTH = Number(process.env.OPENAGI_COMPUTER_SCALE_WIDTH ?? "1280") || 0; // 0 = no scaling

export function createComputerServer({ token, run = execFileAsync, screenshot = defaultScreenshot, geometry = defaultGeometry } = {}) {
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
          case "/screenshot": return send(200, await screenshot(run, await geometry(run)));
          case "/click": {
            const g = await geometry(run);
            const prefix = body.button === "right" ? "rc" : body.button === "middle" ? "tc" : "c";
            await run("cliclick", [`${prefix}:${scale(body.x, g.factor)},${scale(body.y, g.factor)}`]);
            return send(200, { ok: true });
          }
          case "/move": {
            const g = await geometry(run);
            await run("cliclick", [`m:${scale(body.x, g.factor)},${scale(body.y, g.factor)}`]);
            return send(200, { ok: true });
          }
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

// Logical (point) size of the main display + the downscale factor we apply.
// factor maps a coordinate in the returned screenshot's space up to display
// points (what cliclick consumes). Source: `system_profiler` "UI Looks like"
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
    const { stdout } = await run("system_profiler", ["SPDisplaysDataType"]);
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

async function defaultScreenshot(run, geo) {
  const file = path.join(os.tmpdir(), `openagi-cu-${process.pid}-${Math.floor(process.hrtime()[1])}.png`);
  try {
    await run("screencapture", ["-x", "-t", "png", file]);
    if (geo?.targetW) await run("sips", ["--resampleWidth", String(geo.targetW), file]); // resize in place, keeps aspect
    const buf = fs.readFileSync(file);
    const dims = pngDims(buf);
    return {
      format: "png",
      base64: buf.toString("base64"),
      width: dims.w,
      height: dims.h,
      bytes: buf.length,
      scale: geo?.factor ?? 1,
      logicalWidth: geo?.logicalW ?? null,
      logicalHeight: geo?.logicalH ?? null
    };
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

function scale(v, factor) { return Math.round(Number(v || 0) * (factor || 1)); }

function mapError(error) {
  const msg = error?.stderr || error?.message || String(error);
  if (/ENOENT/.test(msg) && /cliclick/.test(msg)) return "cliclick is not installed on the node (brew install cliclick)";
  if (/could not create image from display/i.test(msg)) return "no display to capture — attach a display (or virtual display) on the node";
  if (/not authorized|accessibility|not permitted|operation not permitted/i.test(msg)) {
    return "permission denied — grant Screen Recording (capture) and Accessibility (input) to the node process in System Settings";
  }
  return msg;
}
