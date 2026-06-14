// Computer-use node service: auth, screenshot, and input synthesis dispatch to
// cliclick/screencapture. Uses an injected `run` so no real input is sent.
import test from "node:test";
import assert from "node:assert/strict";
import { createComputerServer, keyArgsForChord } from "../src/integrations/computer-server.js";

function start(opts) {
  const server = createComputerServer(opts);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    resolve({ server, base: `http://127.0.0.1:${port}` });
  }));
}

const post = (base, path, body, token = "secret") =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {})
  });

test("rejects requests without the bearer token", async () => {
  const { server, base } = await start({ token: "secret", run: async () => {} });
  try {
    const res = await post(base, "/click", { x: 1, y: 2 }, null);
    assert.equal(res.status, 401);
  } finally { server.close(); }
});

test("/click maps button to the right cliclick verb (factor 1 = no scaling)", async () => {
  const calls = [];
  const { server, base } = await start({
    token: "secret",
    run: async (cmd, args) => { calls.push([cmd, args]); },
    geometry: async () => ({ factor: 1, targetW: 1280, logicalW: 1280 })
  });
  try {
    await post(base, "/click", { x: 10, y: 20 });
    await post(base, "/click", { x: 30, y: 40, button: "right" });
    assert.deepEqual(calls[0], ["cliclick", ["c:10,20"]]);
    assert.deepEqual(calls[1], ["cliclick", ["rc:30,40"]]);
  } finally { server.close(); }
});

test("/click scales screenshot-space coords up to logical points", async () => {
  const calls = [];
  const { server, base } = await start({
    token: "secret",
    run: async (cmd, args) => { calls.push([cmd, args]); },
    // logical 2560 wide, screenshot downscaled to 1280 → factor 2
    geometry: async () => ({ factor: 2, targetW: 1280, logicalW: 2560 })
  });
  try {
    await post(base, "/click", { x: 100, y: 50 });
    await post(base, "/move", { x: 640, y: 400 });
    assert.deepEqual(calls[0], ["cliclick", ["c:200,100"]]);
    assert.deepEqual(calls[1], ["cliclick", ["m:1280,800"]]);
  } finally { server.close(); }
});

test("/type and /key dispatch to cliclick; /screenshot returns the captured image", async () => {
  const calls = [];
  const { server, base } = await start({
    token: "secret",
    run: async (cmd, args) => { calls.push([cmd, args]); },
    screenshot: async () => ({ format: "png", base64: "AAAA", width: 1920, height: 1080, bytes: 3 })
  });
  try {
    await post(base, "/type", { text: "hello world" });
    assert.deepEqual(calls.at(-1), ["cliclick", ["-w", "20", "t:hello world"]]);

    await post(base, "/key", { chord: "cmd+a" });
    assert.deepEqual(calls.at(-1), ["cliclick", ["kd:cmd", "t:a", "ku:cmd"]]);

    const shot = await (await post(base, "/screenshot", {})).json();
    assert.equal(shot.width, 1920);
    assert.equal(shot.base64, "AAAA");
  } finally { server.close(); }
});

test("/scroll is honestly reported as unsupported (501), not faked", async () => {
  const { server, base } = await start({ token: "secret", run: async () => {} });
  try {
    const res = await post(base, "/scroll", { x: 1, y: 1, deltaY: -3 });
    assert.equal(res.status, 501);
  } finally { server.close(); }
});

test("keyArgsForChord handles named keys and multi-modifier chords", () => {
  assert.deepEqual(keyArgsForChord("enter"), ["kp:return"]);
  assert.deepEqual(keyArgsForChord("cmd+shift+t"), ["kd:cmd,shift", "t:t", "ku:cmd,shift"]);
  assert.deepEqual(keyArgsForChord("esc"), ["kp:esc"]);
});
