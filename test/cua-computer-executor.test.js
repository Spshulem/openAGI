import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cuaDriverChildEnv,
  createConfiguredComputerExecutor,
  createCuaComputerExecutor
} from "../src/integrations/cua-computer-executor.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function fakeCua({ permissions = { accessibility: true, screen_recording: true, source: { attribution: "driver-daemon" } } } = {}) {
  const calls = [];
  const run = async (binary, args, payload) => {
    calls.push({ binary, args, payload });
    if (args[0] === "permissions") return { stdout: Buffer.from(JSON.stringify(permissions)), stderr: Buffer.alloc(0) };
    if (args[1] === "list_windows") {
      return {
        stdout: Buffer.from(JSON.stringify({ windows: [{
          pid: 42,
          window_id: 7,
          title: "Editor",
          z_index: 9,
          is_on_screen: true,
          bounds: { x: 10, y: 20, width: 200, height: 100 }
        }] })),
        stderr: Buffer.alloc(0)
      };
    }
    if (args[1] === "get_window_state") {
      fs.writeFileSync(payload.screenshot_out_file, PNG);
      return {
        stdout: Buffer.from(JSON.stringify({
          screenshot_width: 100,
          screenshot_height: 50,
          screenshot_mime_type: "image/png"
        })),
        stderr: Buffer.alloc(0)
      };
    }
    return { stdout: Buffer.from(JSON.stringify({ effect: "confirmed", route: "test" })), stderr: Buffer.alloc(0) };
  };
  return { calls, run };
}

async function start(executor) {
  return await executor.invoke("session.start", {
    sessionId: "chat:cua",
    goalHash: "a".repeat(64),
    allowedOperations: ["session.end", "screenshot", "click", "move", "type", "key", "scroll"]
  });
}

async function invoke(executor, lease, sequence, operation, payload = {}) {
  return await executor.invoke(operation, {
    ...payload,
    leaseId: lease.leaseId,
    actionId: `action_${sequence}`,
    sequence
  });
}

test("Cua backend preserves OpenAGI leases and maps fresh-frame desktop actions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-cua-test-"));
  const cua = fakeCua();
  const executor = createCuaComputerExecutor({
    binaryPath: "/opt/reviewed/cua-driver",
    binaryReady: () => true,
    run: cua.run,
    tempRoot: dir
  });
  try {
    const health = await executor.health();
    assert.equal(health.capability.ready, true);
    assert.deepEqual(health.capability.operations, ["session.start", "session.end", "screenshot", "click", "move", "type", "key", "scroll"]);

    const lease = await start(executor);
    let shot = await invoke(executor, lease, 1, "screenshot");
    assert.equal(shot.width, 100);
    assert.equal(shot.scale, 2);
    await invoke(executor, lease, 2, "click", { frameId: shot.frameId, x: 10, y: 5, button: "left" });
    shot = await invoke(executor, lease, 3, "screenshot");
    await invoke(executor, lease, 4, "type", { frameId: shot.frameId, text: "private typed text" });
    shot = await invoke(executor, lease, 5, "screenshot");
    await invoke(executor, lease, 6, "key", { frameId: shot.frameId, chord: "cmd+shift+t" });
    shot = await invoke(executor, lease, 7, "screenshot");
    await invoke(executor, lease, 8, "scroll", { frameId: shot.frameId, x: 20, y: 10, deltaX: 0, deltaY: -3 });

    const click = cua.calls.find((call) => call.args[1] === "click");
    assert.deepEqual(click.payload.target, { kind: "window", pid: 42, window_id: 7 });
    assert.deepEqual([click.payload.x, click.payload.y], [20, 10], "OpenAGI frame scaling is preserved");
    const typed = cua.calls.find((call) => call.args[1] === "type_text");
    assert.equal(typed.payload.text, "private typed text");
    assert.doesNotMatch(JSON.stringify(typed.args), /private typed text/, "typed text never enters process argv");
    const hotkey = cua.calls.find((call) => call.args[1] === "hotkey");
    assert.deepEqual(hotkey.payload.keys, ["command", "shift", "t"]);
    const scroll = cua.calls.find((call) => call.args[1] === "scroll");
    assert.equal(scroll.payload.direction, "down");
    assert.equal(scroll.payload.amount, 3);
    assert.deepEqual(await invoke(executor, lease, 99, "session.end"), { ok: true });
  } finally {
    await executor.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Cua readiness fails closed without an absolute executable or permissions", async () => {
  const missing = createCuaComputerExecutor({ binaryPath: "cua-driver", binaryReady: () => true });
  assert.equal((await missing.health()).capability.ready, false);

  const cua = fakeCua({ permissions: { accessibility: false, screen_recording: true, source: { attribution: "driver-daemon" } } });
  const denied = createCuaComputerExecutor({
    binaryPath: "/opt/reviewed/cua-driver",
    binaryReady: () => true,
    run: cua.run
  });
  const status = (await denied.health()).capability;
  assert.equal(status.ready, false);
  assert.equal(status.screenshotReady, true);
  assert.equal(status.inputReady, false);
  await assert.rejects(() => start(denied).then((lease) => invoke(denied, lease, 1, "type", { text: "no" })), /frame|outside|failed/);
});

test("configured executor defaults to native and opts into Cua explicitly", async () => {
  const native = createConfiguredComputerExecutor({ env: {} });
  assert.match((await native.health()).capability.detail, /signed OpenAGI computer helper/);

  const cua = fakeCua();
  const configured = createConfiguredComputerExecutor({
    env: {
      OPENAGI_COMPUTER_BACKEND: "cua",
      OPENAGI_CUA_DRIVER_PATH: "/opt/reviewed/cua-driver"
    },
    binaryReady: () => true,
    run: cua.run
  });
  assert.equal((await configured.health()).capability.ready, true);
});

test("Cua subprocess receives desktop runtime variables but never OpenAGI secrets", () => {
  const child = cuaDriverChildEnv({
    HOME: "/tmp/home",
    PATH: "/usr/bin",
    DISPLAY: ":0",
    XDG_RUNTIME_DIR: "/tmp/runtime",
    CUA_DRIVER_PERMISSION_MODE: "bounded",
    OPENAI_API_KEY: "never-forward",
    OPENAGI_AUTH_TOKEN: "never-forward",
    BUILDBETTER_API_KEY: "never-forward"
  });
  assert.deepEqual(child, {
    HOME: "/tmp/home",
    PATH: "/usr/bin",
    DISPLAY: ":0",
    XDG_RUNTIME_DIR: "/tmp/runtime",
    CUA_DRIVER_PERMISSION_MODE: "bounded"
  });
});
