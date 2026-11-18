import test from "node:test";
import assert from "node:assert/strict";
import { classifyAgentFailure, publicAgentFailure } from "../src/agent-failure.js";

test("on-device failures retain actionable recovery codes without exposing SDK diagnostics", () => {
  const cases = {
    "device-model-download-required": /Download Gemini Nano/,
    "device-model-downloading": /still downloading/,
    "device-model-foreground-required": /phone unlocked/,
    "device-model-input-limit": /new chat/,
    "device-model-busy": /busy/,
    "device-model-quota": /battery/,
    "device-model-system-update": /update/i,
    "device-model-unsupported": /isn't available/,
    "device-model-unavailable": /Chat options/,
    "device-model-timeout": /try again/,
  };
  for (const [code, expected] of Object.entries(cases)) {
    const error = Object.assign(new Error("private SDK diagnostic for a rejected request"), { code });
    const failure = publicAgentFailure(error, "test-session");
    assert.equal(failure.code, code);
    assert.match(failure.error, expected);
    assert.doesNotMatch(failure.error, /private SDK|daemon log/);
  }
});

test("unknown device error codes cannot publish arbitrary model exception text", () => {
  const failure = classifyAgentFailure(Object.assign(new Error("private diagnostic"), { code: "device-model-invented" }));
  assert.equal(failure.code, "agent-error");
  assert.doesNotMatch(failure.message, /private diagnostic/);
});
