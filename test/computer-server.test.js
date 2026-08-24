import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createComputerExecutor, createComputerServer, runComputerHelper } from "../src/integrations/computer-server.js";

const FULL_INPUT_OPERATIONS = [
  "list_apps", "activate_app", "click", "click_element", "drag", "move", "type", "paste",
  "set_value", "select_text", "secondary_action", "key", "scroll", "scroll_element"
];

const ready = async () => ({
  screenshotReady: true,
  inputReady: true,
  operations: FULL_INPUT_OPERATIONS,
  detail: "ready"
});

const privateFocus = Object.freeze({
  windowID: 7,
  processIdentifier: 42,
  bundleIdentifier: "com.example.Editor",
  title: "Project Notes",
  x: 0,
  y: 0,
  width: 1280,
  height: 800
});

function screenshotResult(overrides = {}) {
  return {
    format: "png", base64: "x", width: 100, height: 100, bytes: 1, scale: 1,
    accessibility: "[0] AXButton \"Save\" actions=AXPress",
    elements: [{
      index: 0, path: [2], role: "AXButton", subrole: null, identifier: "save-button",
      title: "Save", x: 10, y: 20, width: 80, height: 30, actions: ["AXPress", "AXShowMenu"], secure: false
    }],
    focus: privateFocus, ...overrides
  };
}

function executor(opts = {}) {
  return createComputerExecutor({
    capabilityStatus: ready,
    geometry: async () => ({ factor: 1 }),
    ...opts
  });
}

async function lease(computer, sessionId = "chat:one", maxActions = 20) {
  return await computer.invoke("session.start", {
    sessionId,
    goalHash: "a".repeat(64),
    allowedOperations: ["session.end", "screenshot", ...FULL_INPUT_OPERATIONS],
    maxActions
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

test("legacy or malformed helper readiness never invents semantic operations", async () => {
  const computer = createComputerExecutor({
    capabilityStatus: async () => ({ screenshotReady: true, inputReady: true, detail: "legacy helper" })
  });
  const health = await computer.health();
  assert.equal(health.capability.inputReady, false);
  assert.deepEqual(health.capability.operations, ["session.start", "session.end", "screenshot"]);
});

test("a privacy-excluded foreground window keeps app activation ready until screenshots recover", async () => {
  let screenshotReady = false;
  const calls = [];
  const computer = createComputerExecutor({
    capabilityStatus: async () => ({
      screenshotReady,
      inputReady: true,
      operations: FULL_INPUT_OPERATIONS,
      detail: screenshotReady ? "ready" : "OpenAGI is the frontmost privacy-excluded window"
    }),
    helperPath: "/signed/helper",
    helperRun: async (_command, operation) => {
      calls.push(operation);
      if (operation === "list_apps") {
        return { stdout: Buffer.from('{"apps":[{"bundleIdentifier":"com.example.Editor","name":"Editor","running":true}]}'), stderr: Buffer.alloc(0) };
      }
      if (operation === "activate_app") {
        screenshotReady = true;
        return { stdout: Buffer.from('{"bundleIdentifier":"com.example.Editor","name":"Editor","running":true}'), stderr: Buffer.alloc(0) };
      }
      if (operation === "screenshot") {
        return { stdout: Buffer.from(JSON.stringify(screenshotResult())), stderr: Buffer.alloc(0) };
      }
      return { stdout: Buffer.from("{}"), stderr: Buffer.alloc(0) };
    }
  });

  const obscured = await computer.health();
  assert.equal(obscured.capability.ready, true, "the approval overlay must not make the node disappear");
  assert.equal(obscured.capability.screenshotReady, false);
  assert.ok(obscured.capability.operations.includes("screenshot"), "temporary availability does not erase supported operations");

  const active = await computer.invoke("session.start", {
    sessionId: "chat:overlay",
    goalHash: "a".repeat(64),
    allowedOperations: ["session.end", "screenshot", "list_apps", "activate_app"]
  });
  await assert.rejects(() => action(computer, active, 1, "screenshot"), /privacy-excluded/);
  const apps = await action(computer, active, 2, "list_apps");
  assert.equal(apps.apps[0].bundleIdentifier, "com.example.Editor");
  await action(computer, active, 3, "activate_app", { bundleIdentifier: "com.example.Editor" });
  const shot = await action(computer, active, 4, "screenshot");
  assert.equal(typeof shot.frameId, "string");
  assert.deepEqual(calls, ["list_apps", "activate_app", "screenshot"]);
});

test("HTTP wrapper exposes drag and every semantic action route", async () => {
  const calls = [];
  const server = createComputerServer({
    token: "secret",
    executor: {
      health: async () => ({ ok: true }),
      invoke: async (operation, payload) => { calls.push([operation, payload]); return { ok: true }; }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [route, operation] of [
      ["/drag", "drag"], ["/click-element", "click_element"], ["/paste", "paste"],
      ["/set-value", "set_value"], ["/select-text", "select_text"],
      ["/secondary-action", "secondary_action"], ["/scroll-element", "scroll_element"]
    ]) {
      const response = await fetch(`${base}${route}`, {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({ marker: operation })
      });
      assert.equal(response.status, 200, `${route} is reachable`);
    }
    assert.deepEqual(calls.map(([operation]) => operation), [
      "drag", "click_element", "paste", "set_value", "select_text", "secondary_action", "scroll_element"
    ]);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("executor binds coordinates to a screenshot frame and scales them", async () => {
  const calls = [];
  const computer = executor({
    helperPath: "/signed/helper",
    helperRun: async (command, operation, payload) => { calls.push([command, operation, payload]); return { stdout: Buffer.from("{}"), stderr: Buffer.alloc(0) }; },
    screenshot: async () => screenshotResult({ base64: "AAAA", width: 1280, height: 800, bytes: 3, scale: 2 })
  });
  const active = await lease(computer);
  const shot = await action(computer, active, 1, "screenshot");
  assert.equal("focus" in shot, false, "private focus identity never leaves the node executor");
  await action(computer, active, 2, "click", { frameId: shot.frameId, x: 100, y: 50, button: "right", count: 2 });
  const nextShot = await action(computer, active, 3, "screenshot");
  await action(computer, active, 4, "drag", {
    frameId: nextShot.frameId, fromX: 10, fromY: 20, toX: 300, toY: 200, button: "left", durationMs: 500
  });
  const finalShot = await action(computer, active, 5, "screenshot");
  await action(computer, active, 6, "move", { frameId: finalShot.frameId, x: 640, y: 400 });
  const inputCalls = calls.filter(([command]) => command === "/signed/helper");
  assert.deepEqual(inputCalls.at(-3), ["/signed/helper", "click", { x: 200, y: 100, button: "right", count: 2, focus: privateFocus }]);
  assert.deepEqual(inputCalls.at(-2), ["/signed/helper", "drag", {
    fromX: 20, fromY: 40, toX: 600, toY: 400, button: "left", durationMs: 500, focus: privateFocus
  }]);
  assert.deepEqual(inputCalls.at(-1), ["/signed/helper", "move", { x: 1280, y: 800, focus: privateFocus }]);
  await assert.rejects(
    () => action(computer, active, 7, "click", { frameId: finalShot.frameId, x: 1280, y: 5, button: "left" }),
    /unknown, stale, or expired|outside the referenced screenshot/
  );
});

test("executor keeps semantic locators node-private and maps the complete app/element action contract", async () => {
  const calls = [];
  const computer = executor({
    helperPath: "/signed/helper",
    helperRun: async (command, operation, payload) => {
      calls.push([command, operation, payload]);
      if (operation === "list_apps") {
        return { stdout: Buffer.from(JSON.stringify({ apps: [{ bundleIdentifier: "com.example.Editor", name: "Editor", running: true }] })), stderr: Buffer.alloc(0) };
      }
      if (operation === "activate_app") {
        return { stdout: Buffer.from(JSON.stringify({ bundleIdentifier: "com.example.Editor", name: "Editor", running: true })), stderr: Buffer.alloc(0) };
      }
      return { stdout: Buffer.from("{}"), stderr: Buffer.alloc(0) };
    },
    screenshot: async () => screenshotResult()
  });
  const active = await lease(computer, "chat:semantic", 40);
  const apps = await action(computer, active, 1, "list_apps");
  assert.deepEqual(apps.apps, [{ bundleIdentifier: "com.example.Editor", name: "Editor", running: true }]);
  const activated = await action(computer, active, 2, "activate_app", { bundleIdentifier: "com.example.Editor" });
  assert.equal(activated.app.bundleIdentifier, "com.example.Editor");

  const operations = [
    ["click_element", { elementIndex: 0 }],
    ["set_value", { elementIndex: 0, text: "private value" }],
    ["paste", { elementIndex: 0, text: "private paste", format: "md" }],
    ["select_text", { elementIndex: 0, text: "private", prefix: "", suffix: " value", selectionType: "text" }],
    ["secondary_action", { elementIndex: 0, action: "AXShowMenu" }],
    ["scroll_element", { elementIndex: 0, direction: "down", pages: 2 }]
  ];
  let sequence = 3;
  for (const [operation, payload] of operations) {
    const shot = await action(computer, active, sequence++, "screenshot");
    await action(computer, active, sequence++, operation, { ...payload, frameId: shot.frameId });
  }

  const state = await action(computer, active, sequence++, "screenshot");
  assert.equal(state.accessibility.includes("AXButton"), true);
  assert.equal("elements" in state, false, "private locator paths never leave the node executor");
  const semanticCall = calls.find(([, operation]) => operation === "click_element");
  assert.equal(semanticCall[2].locator.identifier, "save-button");
  assert.deepEqual(semanticCall[2].focus, privateFocus);
  await assert.rejects(
    () => action(computer, active, sequence, "click_element", { frameId: state.frameId, elementIndex: 99 }),
    /elementIndex is unknown or stale/
  );
});

test("node lease enforces goal binding, monotonic sequence, expiry and idempotency", async () => {
  let now = 1_000;
  let executions = 0;
  const computer = executor({
    now: () => now,
    idleLeaseMs: 50,
    absoluteLeaseMs: 500,
    screenshot: async () => { executions += 1; return screenshotResult({ width: 40, height: 40 }); }
  });
  const active = await lease(computer, "chat:bound");
  const first = await action(computer, active, 1, "screenshot", {}, "same_action");
  const retry = await action(computer, active, 1, "screenshot", {}, "same_action");
  assert.equal(retry.frameId, first.frameId);
  assert.equal(executions, 1, "idempotent retry does not execute twice");
  await assert.rejects(() => action(computer, active, 3, "screenshot"), /sequence must be 2/);
  await assert.rejects(
    () => computer.invoke("screenshot", {
      leaseId: active.leaseId,
      actionId: "same_action",
      sequence: 1,
      changed: true
    }),
    /reused with different input/
  );
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
    screenshot: async () => screenshotResult()
  });
  const active = await lease(computer);
  const shot = await action(computer, active, 1, "screenshot");
  await action(computer, active, 2, "type", { frameId: shot.frameId, text: "private words" });
  assert.equal(calls.at(-1).operation, "type");
  assert.deepEqual(calls.at(-1).payload, { text: "private words", focus: privateFocus });
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
    screenshot: async () => screenshotResult()
  });
  const active = await lease(computer);
  const shot = await action(computer, active, 1, "screenshot");
  now += 1_001;
  const staleActions = [
    ["click", { frameId: shot.frameId, x: 1, y: 1, button: "left" }],
    ["drag", { frameId: shot.frameId, fromX: 1, fromY: 1, toX: 2, toY: 2, button: "left" }],
    ["move", { frameId: shot.frameId, x: 1, y: 1 }],
    ["type", { frameId: shot.frameId, text: "never sent" }],
    ["key", { frameId: shot.frameId, chord: "enter" }],
    ["scroll", { frameId: shot.frameId, x: 1, y: 1, deltaX: 0, deltaY: -1 }]
  ];
  for (let index = 0; index < staleActions.length; index += 1) {
    const [operation, payload] = staleActions[index];
    await assert.rejects(
      () => action(computer, active, index + 2, operation, payload),
      operation === "type" ? /computer type action failed/ : /unknown, stale, or expired/
    );
  }
});

test("session stop revokes the lease and aborts its in-flight signed helper", async () => {
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const computer = executor({
    helperPath: "/signed/helper",
    helperRun: async (_command, operation, _payload, options) => {
      if (operation !== "click") return { stdout: Buffer.from("{}"), stderr: Buffer.alloc(0) };
      markStarted();
      return await new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("helper cancelled")), { once: true });
      });
    },
    screenshot: async () => screenshotResult()
  });
  const active = await lease(computer, "chat:stop-race");
  const shot = await action(computer, active, 1, "screenshot");
  const pendingClick = action(computer, active, 2, "click", {
    frameId: shot.frameId, x: 10, y: 10, button: "left"
  }).then(() => null, (error) => error);
  await started;
  assert.deepEqual(await action(computer, active, 999, "session.end"), { ok: true });
  assert.match((await pendingClick)?.message || "", /helper cancelled|revoked during the action/);
  assert.deepEqual(await action(computer, active, 1, "session.end"), { ok: true, alreadyEnded: true });
  await assert.rejects(
    () => action(computer, active, 4, "screenshot"),
    /lease is missing or expired/
  );
});

test("session end remains available after the physical-action limit is reached", async () => {
  const computer = executor({
    screenshot: async () => screenshotResult({ width: 40, height: 40 })
  });
  const active = await lease(computer, "chat:action-limit", 1);
  await action(computer, active, 1, "screenshot");
  assert.deepEqual(await action(computer, active, 2, "session.end"), { ok: true });
  await assert.rejects(() => action(computer, active, 3, "screenshot"), /lease is missing or expired/);
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

test("helper cancellation requests cooperative cleanup before any hard kill", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-helper-cancel-"));
  const helper = path.join(dir, "helper.js");
  const marker = path.join(dir, "cleanup-complete");
  const ready = path.join(dir, "ready");
  fs.writeFileSync(helper, `#!/usr/bin/env node\nconst fs=require('node:fs');process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(marker)},'yes');setTimeout(()=>process.exit(2),20)});fs.writeFileSync(${JSON.stringify(ready)},'yes');process.stdin.resume();setInterval(()=>{},1000);\n`, { mode: 0o700 });
  const controller = new AbortController();
  try {
    const pending = runComputerHelper(helper, "type", { text: "bounded" }, {
      timeoutMs: 2_000,
      signal: controller.signal
    });
    const deadline = Date.now() + 2_000;
    while (!fs.existsSync(ready) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(ready), true, "test helper installed its cleanup handler");
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    assert.equal(fs.readFileSync(marker, "utf8"), "yes");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an already-aborted helper request never writes into a killed child's stdin", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runComputerHelper("/bin/sleep", "1", { text: "x".repeat(16 * 1024) }, {
      timeoutMs: 2_000,
      signal: controller.signal
    }),
    /cancelled/
  );
});

test("an install without the signed helper refuses input instead of putting it in argv", async () => {
  const computer = executor({ screenshot: async () => screenshotResult({ width: 40, height: 40 }) });
  const active = await lease(computer);
  const shot = await action(computer, active, 1, "screenshot");
  await assert.rejects(
    () => action(computer, active, 2, "scroll", { frameId: shot.frameId, x: 1, y: 1, deltaX: 0, deltaY: -3 }),
    /signed OpenAGI computer helper/
  );
});

test("a screenshot without an exact private focus identity fails closed", async () => {
  const computer = executor({
    screenshot: async () => ({ format: "png", base64: "x", width: 100, height: 100, bytes: 1, scale: 1 })
  });
  const active = await lease(computer, "chat:no-focus");
  await assert.rejects(
    () => action(computer, active, 1, "screenshot"),
    /did not bind the screenshot to an exact focused window/
  );
});
