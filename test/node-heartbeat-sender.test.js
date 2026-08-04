// test/node-heartbeat-sender.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { writeNodeConfig } from "../src/cli-client.js";

test("a paired instance sends a heartbeat shortly after boot, and the main's registry reflects it", async () => {
  // dataDir is passed explicitly to both createDurableRuntime and
  // createHostedInterface's options (not via process.env.OPENAGI_DATA_DIR) —
  // resolveDataDir() memoizes its first result for the whole test process,
  // so switching the env var between the main and node instances here would
  // make the second instance silently resolve to the first one's directory.
  const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-hb-main-"));
  const mainRuntime = createDurableRuntime({ dataDir: mainDir });
  const mainApp = createHostedInterface(mainRuntime, { host: "127.0.0.1", port: 0, tickerMs: 0, dataDir: mainDir });
  const mainListened = await mainApp.listen();
  const mainBase = mainListened.url;

  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-hb-node-"));
  writeNodeConfig({ remote: mainBase, token: null }, nodeDir);
  const nodeRuntime = createDurableRuntime({ dataDir: nodeDir });
  const nodeApp = createHostedInterface(nodeRuntime, {
    host: "127.0.0.1", port: 0, tickerMs: 0, dataDir: nodeDir, heartbeatIntervalMs: 20
  });
  await nodeApp.listen();

  try {
    // The main's roster now includes the main itself, so a bare count can't
    // tell "the node checked in" apart from "only the main is listed" — poll
    // for the row that is not this main, and identify it by nodeId.
    let arrival = null;
    for (let attempt = 0; attempt < 40 && !arrival; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const json = await (await fetch(`${mainBase}/nodes`)).json();
      arrival = json.nodes.find((n) => !n.self) ?? null;
    }
    assert.ok(arrival, "the node's heartbeat reached the main");
    assert.equal(arrival.role, "node");
    assert.equal(arrival.status, "online");
    // The heartbeat carries the sender's build identity, not just a version.
    assert.equal(typeof arrival.buildSource, "string");
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
