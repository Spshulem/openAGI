import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createImessageBridgeRuntime, imessageBridgeConfig } from "../src/integrations/imessage-bridge-runtime.js";
import { writeNodeConfig } from "../src/cli-client.js";

test("integrated bridge is opt-in and cannot answer anyone without an allowlist", () => {
  assert.deepEqual(imessageBridgeConfig({}), {
    enabled: false,
    allowFrom: [],
    allowChats: [],
    respondMode: "none",
    captureMode: "none",
    trigger: "openagi",
    intervalMs: 10_000
  });
  assert.equal(imessageBridgeConfig({ IMESSAGE_SELF_HANDLE: "me@example.test" }).respondMode, "trigger");
});

test("daemon-owned bridge starts and stops once with bounded public status", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-imessage-runtime-"));
  let starts = 0;
  let stops = 0;
  let received = null;
  const bridge = {
    start(options) { starts += 1; received.start = options; },
    stop() { stops += 1; },
    status() {
      return {
        running: starts > stops,
        startedAt: "2026-08-18T00:00:00.000Z",
        lastPollAt: null,
        lastSuccessAt: null,
        lastErrorAt: null,
        detailCode: "starting",
        totals: { processed: 0, replied: 0, captured: 0, skipped: 0, errors: 0 }
      };
    }
  };
  const runtime = createImessageBridgeRuntime({
    dataDir,
    env: {
      OPENAGI_IMESSAGE_BRIDGE: "1",
      IMESSAGE_RESPOND: "allow",
      IMESSAGE_ALLOW: "first@example.test, second@example.test",
      IMESSAGE_CAPTURE: "allow",
      IMESSAGE_INTERVAL_MS: "500"
    },
    clientProvider: () => ({ chat() {}, request() {} }),
    bridgeFactory(options) { received = options; return bridge; }
  });

  runtime.start();
  runtime.start();
  assert.equal(starts, 1);
  assert.equal(received.respondMode, "allow");
  assert.deepEqual(received.allowFrom, ["first@example.test", "second@example.test"]);
  assert.equal(received.start.intervalMs, 2_000, "poll interval is clamped to the safe minimum");
  assert.deepEqual(Object.keys(runtime.status()).sort(), [
    "capture", "detailCode", "enabled", "lastErrorAt", "lastEvent", "lastPollAt",
    "lastSuccessAt", "mode", "running", "startedAt", "totals"
  ]);
  runtime.stop();
  assert.equal(stops, 1);
});

test("paired bridge refuses the broad enrollment credential until scoped enrollment is confirmed", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-imessage-enroll-"));
  writeNodeConfig({
    remote: "https://main.example.test",
    token: "broad-secret",
    nodeToken: "pending-node-secret",
    nodeEnrollmentConfirmed: false
  }, dataDir);
  let bridgeOptions;
  const runtime = createImessageBridgeRuntime({
    dataDir,
    env: { OPENAGI_IMESSAGE_BRIDGE: "true" },
    clientProvider: () => ({ chat() {}, request() {} }),
    bridgeFactory(options) {
      bridgeOptions = options;
      return { start() {}, stop() {}, status: () => ({ running: true, detailCode: "starting" }) };
    }
  });
  runtime.start();
  assert.throws(() => bridgeOptions.clientProvider(), /scoped node enrollment/);
});
