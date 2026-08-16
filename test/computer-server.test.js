import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createComputerExecutor, createComputerServer, runComputerHelper } from "../src/integrations/computer-server.js";

const ready = async () => ({
  screenshotReady: true,
  inputReady: true,
  operations: ["click", "move", "type", "key", "scroll"],
  detail: "ready"
});

function executor(opts = {}) {
  return createComputerExecutor({
    capabilityStatus: ready,
    geometry: async () => ({ factor: 1 }),
    ...opts
  });
}

async function lease(computer, sessionId = "chat:one") {
  return await computer.invoke("session.start", {
    sessionId,
    goalHash: "a".repeat(64),
    allowedOperations: ["session.end", "screenshot", "click", "move", "type", "key", "scroll"],
    maxActions: 20
  });
}

async function action(computer, active, sequence, operation, payload = {}, actionId = `action_${sequence}`) {
  return await computer.invoke(operation, {
    ...payload,
    leaseId: active.leaseId,
    actionId,
    sequence
  });
}

test("health is capability-specific and the HTTP wrapper authenticates every route", async () => {
  const server = createComputerServer({ token: "secret", executor: executor() });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 401);
    const response = await fetch(`${base}/health`, { headers: { authorization: "Bearer secret" } });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.capability.id, "computer-use");
    assert.equal(body.capability.ready, true);
    assert.ok(body.capability.operations.includes("scroll"));
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("executor binds coordinates to a screenshot frame and scales them", async () => {
  const calls = [];
  const computer = executor({
    helperPath: "/signed/helper",
    helperRun: async (command, operation, payload) => { calls.push([command, operation, payload]); return { stdout: Buffer.from("{}"), stderr: Buffer.alloc(0) }; },
    screenshot: async () => ({ format: "png", base64: "AAAA", width: 1280, height: 800, bytes: 3, scale: 2 })
  });
  const active = await lease(computer);
  const shot = await action(computer, active, 1, "screenshot");
  await action(computer, active, 2, "click", { frameId: shot.frameId, x: 100, y: 50, button: "right" });
  const nextShot = await action(computer, active, 3, "screenshot");
  await action(computer, active, 4, "move", { frameId: nextShot.frameId, x: 640, y: 400 });
  const inputCalls = calls.filter(([command]) => command === "/signed/helper");
  assert.deepEqual(inputCalls.at(-2), ["/signed/helper", "click", { x: 200, y: 100, button: "right" }]);
  assert.deepEqual(inputCalls.at(-1), ["/signed/helper", "move", { x: 1280, y: 800 }]);
  await assert.rejects(
    () => action(computer, active, 5, "click", { frameId: nextShot.frameId, x: 1280, y: 5, button: "left" }),
    /unknown, stale, or expired|outside the referenced screenshot/
  );
});

test("node lease enforces goal binding, monotonic sequence, expiry and idempotency", async () => {
  let now = 1_000;
  let executions = 0;
  const computer = executor({
    now: () => now,
    idleLeaseMs: 50,
    absoluteLeaseMs: 500,
    screenshot: async () => { executions += 1; return { format: "png", base64: "x", width: 10, height: 10, bytes: 1, scale: 1 }; }
  });
  const active = await lease(computer, "chat:bound");
  const first = await action(computer, active, 1, "screenshot", {}, "same_action");
  const retry = await action(computer, active, 1, "screenshot", {}, "same_action");
  assert.equal(retry.frameId, first.frameId);
  assert.equal(executions, 1, "idempotent retry does not execute twice");
  await assert.rejects(() => action(computer, active, 3, "screenshot"), /sequence must be 2/);
  await assert.rejects(
    () => computer.invoke("session.start", { sessionId: "chat:bound", goalHash: "b".repeat(64) }),
    /different approved goal/
  );
  now += 51;
  await assert.rejects(() => action(computer, active, 2, "screenshot"), /missing or expired/);
});

test("helper receives typed text on stdin, while strict inputs reject unsafe fallbacks", async () => {
  const calls = [];
  const computer = executor({
    helperPath: "/signed/helper",
    helperRun: async (command, operation, payload) => { calls.push({ command, operation, payload }); return { stdout: Buffer.from("{}"), stderr: Buffer.alloc(0) }; },
    screenshot: async () => ({ format: "png", base64: "x", width: 100, height: 100, bytes: 1, scale: 1 })
  });
  const active = await lease(computer);
  const shot = await action(computer, active, 1, "screenshot");
  await action(computer, active, 2, "type", { frameId: shot.frameId, text: "private words" });
  assert.equal(calls.at(-1).operation, "type");
  assert.deepEqual(calls.at(-1).payload, { text: "private words" });
  assert.equal(JSON.stringify([calls.at(-1).command, calls.at(-1).operation]).includes("private words"), false);
  const nextShot = await action(computer, active, 3, "screenshot");
  await assert.rejects(() => action(computer, active, 4, "key", { frameId: nextShot.frameId, chord: "cmd+not-a-key" }), /supported key/);
  await assert.rejects(() => action(computer, active, 5, "click", { x: 1, y: 2 }), /button|frameId/);
});

test("all input, including type and key, requires a fresh screenshot frame", async () => {
  let now = 1_000;
  const computer = executor({
    now: () => now,
    frameTtlMs: 1_000,
    helperPath: "/signed/helper",
    helperRun: async () => ({ stdout: Buffer.from("{}"), stderr: Buffer.alloc(0) }),
    screenshot: async () => ({ format: "png", base64: "x", width: 100, height: 100, bytes: 1, scale: 1 })
  });
  const active = await lease(computer);
  const shot = await action(computer, active, 1, "screenshot");
  now += 1_001;
  await assert.rejects(
    () => action(computer, active, 2, "type", { frameId: shot.frameId, text: "never sent" }),
    /unknown, stale, or expired/
  );
});

test("helper runner writes payload to stdin, bounds output, and never places it in argv", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-helper-test-"));
  const helper = path.join(dir, "helper.js");
  fs.writeFileSync(helper, `#!/usr/bin/env node\nlet s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({argv:process.argv.slice(2),payload:JSON.parse(s)})));\n`, { mode: 0o700 });
  try {
    const result = await runComputerHelper(helper, "type", { text: "stdin-only-secret" }, { timeoutMs: 2_000 });
    const parsed = JSON.parse(String(result.stdout));
    assert.deepEqual(parsed.argv, ["type"]);
    assert.deepEqual(parsed.payload, { text: "stdin-only-secret" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an install without the signed helper refuses input instead of putting it in argv", async () => {
  const computer = executor({ screenshot: async () => ({ format: "png", base64: "x", width: 10, height: 10, bytes: 1, scale: 1 }) });
  const active = await lease(computer);
  const shot = await action(computer, active, 1, "screenshot");
  await assert.rejects(
    () => action(computer, active, 2, "scroll", { frameId: shot.frameId, x: 1, y: 1, deltaX: 0, deltaY: -3 }),
    /signed OpenAGI computer helper/
  );
});
