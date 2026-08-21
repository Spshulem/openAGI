// test/node-heartbeat-sender.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { readNodeConfig, writeNodeConfig } from "../src/cli-client.js";

test("a paired instance heartbeats immediately on listen instead of waiting for its interval", async () => {
  // dataDir is passed explicitly to both createDurableRuntime and
  // createHostedInterface's options (not via process.env.OPENAGI_DATA_DIR) —
  // resolveDataDir() memoizes its first result for the whole test process,
  // so switching the env var between the main and node instances here would
  // make the second instance silently resolve to the first one's directory.
  const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-hb-main-"));
  const oneTimePairingCredential = "test-only-pairing-credential";
  const mainRuntime = createDurableRuntime({ dataDir: mainDir });
  const mainApp = createHostedInterface(mainRuntime, {
    host: "127.0.0.1",
    port: 0,
    tickerMs: 0,
    dataDir: mainDir,
    authToken: oneTimePairingCredential
  });
  const mainListened = await mainApp.listen();
  const mainBase = mainListened.url;

  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-hb-node-"));
  writeNodeConfig({ remote: mainBase, token: oneTimePairingCredential }, nodeDir);
  const nodeRuntime = createDurableRuntime({ dataDir: nodeDir });
  const nodeApp = createHostedInterface(nodeRuntime, {
    // Deliberately much longer than this test's deadline. A setInterval-only
    // sender can never pass; the registration must come from the eager send.
    host: "127.0.0.1", port: 0, tickerMs: 0, dataDir: nodeDir, heartbeatIntervalMs: 60_000
  });
  await nodeApp.listen();

  try {
    // The main's roster now includes the main itself, so a bare count can't
    // tell "the node checked in" apart from "only the main is listed" — poll
    // for the row that is not this main, and identify it by nodeId.
    let arrival = null;
    for (let attempt = 0; attempt < 20 && !arrival; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const json = await (await fetch(`${mainBase}/nodes`, {
        headers: { authorization: `Bearer ${oneTimePairingCredential}` }
      })).json();
      arrival = json.nodes.find((n) => !n.self) ?? null;
    }
    assert.ok(arrival, "the node's heartbeat reached the main");
    assert.equal(arrival.role, "node");
    assert.equal(arrival.status, "online");
    // The heartbeat carries the sender's build identity, not just a version.
    assert.equal(typeof arrival.buildSource, "string");
    const paired = readNodeConfig(nodeDir);
    assert.equal(paired.token, null, "the one-time main credential is erased after enrollment");
    assert.match(paired.nodeToken, /^[a-zA-Z0-9_-]{43}$/);
    assert.equal(paired.nodeEnrollmentConfirmed, true);
  } finally {
    await nodeApp.close();
    await mainApp.close();
  }
});

test("paired nodes advertise privacy-safe iMessage bridge reply health", async () => {
  const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-hb-imessage-main-"));
  const credential = "test-only-imessage-pairing";
  const mainRuntime = createDurableRuntime({ dataDir: mainDir });
  const mainApp = createHostedInterface(mainRuntime, {
    host: "127.0.0.1", port: 0, tickerMs: 0, dataDir: mainDir, authToken: credential
  });
  const mainBase = (await mainApp.listen()).url;

  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-hb-imessage-node-"));
  writeNodeConfig({ remote: mainBase, token: credential }, nodeDir);
  const nodeRuntime = createDurableRuntime({ dataDir: nodeDir });
  const bridgeStatus = {
    enabled: true,
    running: true,
    detailCode: "ready",
    lastDecisionCode: "not-allowed"
  };
  const nodeApp = createHostedInterface(nodeRuntime, {
    host: "127.0.0.1",
    port: 0,
    tickerMs: 0,
    dataDir: nodeDir,
    heartbeatIntervalMs: 20,
    serviceEnv: {
      OPENAGI_IMESSAGE_BRIDGE: "1",
      IMESSAGE_TRIGGER: "private-trigger",
      IMESSAGE_ALLOW: "private@example.test"
    },
    imessageBridgeRuntime: {
      start() {},
      stop() {},
      status: () => bridgeStatus
    }
  });
  await nodeApp.listen();

  try {
    let capability = null;
    for (let attempt = 0; attempt < 40 && !capability; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const roster = await (await fetch(`${mainBase}/nodes`, {
        headers: { authorization: `Bearer ${credential}` }
      })).json();
      capability = roster.nodes
        .find((node) => !node.self)?.capabilities
        ?.find((entry) => entry.id === "imessage-bridge" && entry.ready) ?? null;
    }
    assert.deepEqual(capability?.operations, []);
    assert.equal(capability?.detail, "ready:not-allowed");
    assert.doesNotMatch(JSON.stringify(capability), /private-trigger|private@example/);
  } finally {
    await nodeApp.close();
    await mainApp.close();
  }
});

test("a failed heartbeat POST does not crash the sender or the process", async () => {
  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-hb-fail-"));
  writeNodeConfig({ remote: "http://127.0.0.1:1", token: null }, nodeDir); // nothing listens on port 1
  const runtime = createDurableRuntime({ dataDir: nodeDir });
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1", port: 0, tickerMs: 0, dataDir: nodeDir, heartbeatIntervalMs: 20
  });
  await app.listen();
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    // If the sender threw, this line is never reached — the process test
    // runner would report an uncaught exception for this file.
    assert.ok(true, "still running after a failed heartbeat attempt");
  } finally { await app.close(); }
});

test("node control revokes a computer-use lease without waiting for a slow health probe", async () => {
  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-stop-health-"));
  writeNodeConfig({
    remote: "http://127.0.0.1:1",
    token: null,
    nodeToken: "n".repeat(43),
    nodeEnrollmentConfirmed: true
  }, nodeDir);
  const runtime = createDurableRuntime({ dataDir: nodeDir });
  let commandDelivered = false;
  let resultEnvelope = null;
  let markRevoked;
  const revoked = new Promise((resolve) => { markRevoked = resolve; });
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1",
    port: 0,
    tickerMs: 0,
    dataDir: nodeDir,
    heartbeatIntervalMs: 60_000,
    nodeControlEnabled: true,
    computerExecutor: {
      async health() {
        if (commandDelivered) await new Promise((resolve) => setTimeout(resolve, 750));
        return { capability: {
          id: "computer-use",
          ready: true,
          operations: ["session.end"]
        } };
      },
      async invoke(operation) {
        assert.equal(operation, "session.end");
        markRevoked();
        return { ok: true };
      }
    },
    nodeControlFetch: async (url, options) => {
      if (url.endsWith("/nodes/heartbeat")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith("/nodes/control/poll")) {
        const body = JSON.parse(options.body);
        if (!commandDelivered) {
          commandDelivered = true;
          return new Response(JSON.stringify({
            command: {
              id: "stop-with-slow-health",
              nodeId: body.nodeId,
              capability: "computer-use",
              operation: "session.end",
              payload: { leaseId: "lease-to-stop" },
              sessionId: "session-to-stop",
              expiresAt: new Date(Date.now() + 5_000).toISOString()
            }
          }), { status: 200 });
        }
        return await new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(Object.assign(new Error("stopped"), {
            name: "AbortError"
          })), { once: true });
        });
      }
      resultEnvelope = JSON.parse(options.body);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
  });
  await app.listen();
  try {
    await Promise.race([
      revoked,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Stop waited for health")), 250))
    ]);
    for (let attempt = 0; attempt < 20 && !resultEnvelope; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(resultEnvelope?.result, { ok: true });
  } finally {
    await app.close();
    fs.rmSync(nodeDir, { recursive: true, force: true });
  }
});

test("a scoped node credential is persisted before the enrollment request can lose its response", async () => {
  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-enroll-persist-"));
  writeNodeConfig({ remote: "http://127.0.0.1:1", token: "main-admin" }, nodeDir);
  const runtime = createDurableRuntime({ dataDir: nodeDir });
  const attempts = [];
  let observeRetry;
  const retried = new Promise((resolve) => { observeRetry = resolve; });
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1",
    port: 0,
    tickerMs: 0,
    dataDir: nodeDir,
    heartbeatIntervalMs: 20,
    nodeControlFetch: async (_url, options) => {
      const sent = JSON.parse(options.body);
      const saved = readNodeConfig(nodeDir);
      attempts.push({ sent, saved });
      if (attempts.length === 1) throw new Error("simulated lost enrollment response");
      observeRetry();
      return { ok: true, status: 200, json: async () => ({ enrolled: true, created: false }) };
    }
  });
  await app.listen();
  try {
    await retried;
    assert.match(attempts[0].sent.nodeToken, /^[a-zA-Z0-9_-]{43}$/);
    assert.equal(attempts[0].saved.nodeToken, attempts[0].sent.nodeToken);
    assert.equal(attempts[0].saved.nodeEnrollmentConfirmed, false);
    assert.equal(attempts[1].sent.nodeToken, attempts[0].sent.nodeToken, "retry reuses the persisted credential");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(readNodeConfig(nodeDir).nodeEnrollmentConfirmed, true);
  } finally { await app.close(); }
});

test("an unpaired instance never starts the heartbeat sender", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-hb-unpaired-"));
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, tickerMs: 0, dataDir, heartbeatIntervalMs: 20 });
  await app.listen();
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(app.__heartbeatHandle, undefined, "no heartbeat interval was created for an unpaired instance");
  } finally { await app.close(); }
});
