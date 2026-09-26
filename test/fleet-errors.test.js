import test from "node:test";
import assert from "node:assert/strict";
import { classifyCodexErrorCode, classifyErrorText, parseResetAt } from "../src/fleet/errors.js";

const now = new Date(2026, 8, 26, 1, 0, 0); // Sep 26 2026 01:00 local

test("classifies real Claude error strings", () => {
  assert.equal(classifyErrorText("You've hit your session limit · resets 12am (America/Los_Angeles)", now).kind, "session-limit");
  assert.equal(classifyErrorText("You've hit your weekly limit · resets Sep 28 at 9am (America/Los_Angeles)", now).kind, "session-limit");
  assert.equal(classifyErrorText("You've reached your Fable limit. Switch to another model to continue.", now).kind, "model-limit");
  assert.equal(classifyErrorText("You're out of usage credits. Run /usage-credits", now).kind, "usage-limit");
  assert.equal(classifyErrorText("API Error: 529 Overloaded. try again in a moment", now).kind, "overloaded");
  assert.equal(classifyErrorText("API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)", now).kind, "network");
  assert.equal(classifyErrorText("Not logged in · Please run /login", now).kind, "logged-out");
  assert.equal(classifyErrorText("ENOSPC: no space left on device, open '/private/tmp/x'", now).kind, "disk-full");
  assert.equal(classifyErrorText("All green. Pushed 1a2b3c.", now), null);
  assert.equal(classifyErrorText("", now), null);
});

test("classifies real Codex and codex-lb error strings", () => {
  assert.equal(classifyErrorText("unexpected status 503 Service Unavailable: No available accounts. Service is operating in degraded mode", now).kind, "lb");
  assert.equal(classifyErrorText("unexpected status 502 Bad Gateway: Previous response owner account is unavailable; retry later.", now).kind, "lb");
  assert.equal(classifyErrorText("{\"message\":\"Invalid `previous_response_id`.\"}", now).kind, "lb");
  assert.equal(classifyErrorText("Missing environment variable: `CODEX_LB_API_KEY`.", now).kind, "lb");
  assert.equal(classifyErrorText("Selected model is at capacity. Please try a different model.", now).kind, "model-limit");
  assert.equal(classifyErrorText("stream disconnected before completion: stream closed before response.completed", now).kind, "network");
  const usage = classifyErrorText("You've hit your usage limit. Try again at Sep 27th, 2026 6:22 PM.", now);
  assert.equal(usage.kind, "usage-limit");
  assert.equal(usage.resetAt, new Date(2026, 8, 27, 18, 22).toISOString());
});

test("parseResetAt handles bare times rolling to tomorrow", () => {
  assert.equal(parseResetAt("resets 12am (America/Los_Angeles)", now), new Date(2026, 8, 27, 0, 0).toISOString());
  assert.equal(parseResetAt("resets 8:10pm (America/Los_Angeles)", now), new Date(2026, 8, 26, 20, 10).toISOString());
  assert.equal(parseResetAt("resets Sep 28 at 9am (America/Los_Angeles)", now), new Date(2026, 8, 28, 9, 0).toISOString());
  assert.equal(parseResetAt("no time here", now), null);
});

test("classifyCodexErrorCode maps codes and falls back to text", () => {
  assert.equal(classifyCodexErrorCode("usage_limit_exceeded", "You've hit your usage limit. Try again at 1:11 AM.", now).kind, "usage-limit");
  assert.equal(classifyCodexErrorCode("server_overloaded", "Selected model is at capacity", now).kind, "model-limit");
  assert.equal(classifyCodexErrorCode("other", "unexpected status 503 Service Unavailable: No available accounts", now).kind, "lb");
  assert.equal(classifyCodexErrorCode("other", "weird thing", now).kind, "other");
  assert.equal(classifyCodexErrorCode(null, "", now), null);
});
