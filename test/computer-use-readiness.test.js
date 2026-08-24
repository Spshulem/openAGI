import test from "node:test";
import assert from "node:assert/strict";
import { computerUseReadiness } from "../src/integrations/computer-use.js";

test("computer-use readiness distinguishes disabled, observe-only, and control-ready", async () => {
  const disabled = await computerUseReadiness({ env: {}, fetchImpl: null, toolsRegistered: false });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.toolsRegistered, false);
  assert.equal(disabled.mode, "disabled");
  assert.equal(disabled.nodeConfigured, false);
  assert.equal(disabled.inputAvailable, false);

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
      assert.equal(options.headers.authorization, "Bearer must-not-leak", "health is authenticated with the scoped service token");
      return {
        ok: true,
        json: async () => ({
          capability: {
            id: "computer-use",
            screenshotReady: true,
            inputReady: true,
            operations: ["session.start", "session.end", "screenshot", "click", "drag", "move", "type", "key", "scroll"]
          }
        })
      };
    },
    toolsRegistered: true
  });
  assert.equal(ready.mode, "control-ready");
  assert.equal(ready.screenshot, "live-image");
  assert.equal(ready.inputAvailable, true);
  assert.equal(JSON.stringify(ready).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(ready).includes("computer.example"), false, "status must not expose the private node endpoint");
});

test("a reachable node without verified input permissions is not control-ready", async () => {
  const status = await computerUseReadiness({
    env: {
      OPENAGI_COMPUTER_USE: "1",
      OPENAGI_COMPUTER_NODE: "https://computer.example",
      OPENAGI_COMPUTER_NODE_TOKEN: "scoped"
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ capability: { id: "computer-use", screenshotReady: true, inputReady: false, operations: ["screenshot"] } })
    }),
    toolsRegistered: true
  });
  assert.equal(status.nodeReachable, true);
  assert.equal(status.mode, "permissions-required");
  assert.equal(status.inputAvailable, false);
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
