// Regression: opening the OAuth URL must never crash the daemon. On a headless
// Linux box (a Distiller/Pi main) `xdg-open` is missing, and spawn() reports
// that via an ASYNC 'error' event — which used to be unhandled and took the
// whole process down on every OAuth MCP connect.
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { openInBrowser } from "../src/mcp-oauth.js";

test("headless Linux (no display) skips the browser spawn entirely", () => {
  let spawned = false;
  const spawnFn = () => { spawned = true; return new EventEmitter(); };
  const r = openInBrowser("https://x/authorize", { platform: "linux", env: {}, spawnFn });
  assert.equal(r.opened, false);
  assert.equal(r.reason, "headless");
  assert.equal(spawned, false, "must not even try to spawn a browser on a headless box");
});

test("Linux WITH a display attempts the spawn and attaches an error handler", () => {
  const child = new EventEmitter();
  child.unref = () => {};
  const r = openInBrowser("https://x/authorize", { platform: "linux", env: { DISPLAY: ":0" }, spawnFn: () => child });
  assert.equal(r.opened, true);
  // The async 'error' event (missing binary) must be handled — emitting it
  // with a listener present does NOT throw; without the listener EventEmitter
  // would rethrow and crash the process.
  assert.ok(child.listenerCount("error") >= 1, "error handler must be attached");
  assert.doesNotThrow(() => child.emit("error", Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" })));
});

test("a spawn that throws synchronously degrades gracefully", () => {
  const r = openInBrowser("https://x", { platform: "linux", env: { DISPLAY: ":0" }, spawnFn: () => { throw new Error("nope"); } });
  assert.equal(r.opened, false);
  assert.equal(r.reason, "spawn-threw");
});

test("macOS opens via `open`", () => {
  const calls = [];
  const child = new EventEmitter(); child.unref = () => {};
  const spawnFn = (cmd, args) => { calls.push({ cmd, args }); return child; };
  const r = openInBrowser("https://x", { platform: "darwin", env: {}, spawnFn });
  assert.equal(r.opened, true);
  assert.equal(calls[0].cmd, "open");
  assert.deepEqual(calls[0].args, ["https://x"]);
});

// Headless OAuth completion: the callback port must be pinnable so it can be
// SSH-tunneled from the browser machine to a headless main.
test("OPENAGI_OAUTH_CALLBACK_PORT pins the callback port (else random)", async () => {
  const { startCallbackServer } = await import("../src/mcp-oauth.js");
  const saved = process.env.OPENAGI_OAUTH_CALLBACK_PORT;
  try {
    process.env.OPENAGI_OAUTH_CALLBACK_PORT = "8765";
    const fixed = await startCallbackServer();
    assert.equal(fixed.port, 8765, "fixed port honored");
    fixed.server.close();

    delete process.env.OPENAGI_OAUTH_CALLBACK_PORT;
    const rand = await startCallbackServer();
    assert.ok(rand.port > 0 && rand.port !== 8765, "random port when unset");
    rand.server.close();
  } finally {
    if (saved === undefined) delete process.env.OPENAGI_OAUTH_CALLBACK_PORT;
    else process.env.OPENAGI_OAUTH_CALLBACK_PORT = saved;
  }
});
