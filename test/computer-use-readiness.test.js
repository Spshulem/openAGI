import test from "node:test";
import assert from "node:assert/strict";
import { computerUseReadiness } from "../src/integrations/computer-use.js";

test("computer-use readiness distinguishes disabled, observe-only, and control-ready", async () => {
  const disabled = await computerUseReadiness({ env: {}, fetchImpl: null, toolsRegistered: false });
  assert.deepEqual(disabled, {
    enabled: false,
    toolsRegistered: false,
    mode: "disabled",
    nodeConfigured: false,
    nodeReachable: false,
    screenshot: "disabled",
    inputAvailable: false
  });

  const observeOnly = await computerUseReadiness({
    env: { OPENAGI_COMPUTER_USE: "1" },
    fetchImpl: null,
    toolsRegistered: true
  });
  assert.equal(observeOnly.mode, "observe-only");
  assert.equal(observeOnly.screenshot, "recent-ocr");
  assert.equal(observeOnly.inputAvailable, false);

  const ready = await computerUseReadiness({
    env: {
      OPENAGI_COMPUTER_USE: "true",
      OPENAGI_COMPUTER_NODE: "https://computer.example/",
      OPENAGI_COMPUTER_NODE_TOKEN: "must-not-leak"
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://computer.example/health");
      assert.equal(options.headers.authorization, undefined, "public health probe must not send the node token");
      return { ok: true };
    },
    toolsRegistered: true
  });
  assert.equal(ready.mode, "control-ready");
  assert.equal(ready.screenshot, "live-image");
  assert.equal(ready.inputAvailable, true);
  assert.equal(JSON.stringify(ready).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(ready).includes("computer.example"), false, "status must not expose the private node endpoint");
});

test("an unreachable configured node is explicit, not fake-ready", async () => {
  const status = await computerUseReadiness({
    env: { OPENAGI_COMPUTER_USE: "1", OPENAGI_COMPUTER_NODE: "https://offline.example" },
    fetchImpl: async () => { throw new Error("offline"); },
    toolsRegistered: true
  });
  assert.equal(status.mode, "node-unreachable");
  assert.equal(status.inputAvailable, false);
  assert.equal(status.screenshot, "recent-ocr");
});
