import test from "node:test";
import assert from "node:assert/strict";
import { classifyCodexErrorCode, classifyErrorText, parseResetAt, providerAuthDetail } from "../src/fleet/errors.js";

const now = new Date(2026, 8, 26, 1, 0, 0); // Sep 26 2026 01:00 local

test("classifies real Claude error strings", () => {
  assert.equal(classifyErrorText("You've hit your session limit · resets 12am (America/Los_Angeles)", now).kind, "session-limit");
  assert.equal(classifyErrorText("You've hit your weekly limit · resets Sep 28 at 9am (America/Los_Angeles)", now).kind, "session-limit");
  assert.equal(classifyErrorText("You've reached your Fable limit. Switch to another model to continue.", now).kind, "model-limit");
  assert.equal(classifyErrorText("You're out of usage credits. Run /usage-credits", now).kind, "usage-limit");
  // Seen live in Conductor, 2026-09-28: it used to fall through to "other" and never resume.
  const extra = classifyErrorText("You're out of extra usage · resets 12:30pm (America/Los_Angeles)", now);
  assert.equal(extra.kind, "usage-limit");
  assert.ok(extra.resetAt, "reset time parsed");
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

test("a yearless reset date that already passed rolls into next year", () => {
  const dec30 = new Date(2026, 11, 30, 10, 0, 0);
  assert.equal(parseResetAt("resets Jan 2 at 9am (America/Los_Angeles)", dec30), new Date(2027, 0, 2, 9, 0).toISOString());
});

test("Antigravity quota errors are a usage limit with the exact reset", () => {
  // Real ERROR_MESSAGE text and details from an Antigravity step, 2026-10-14.
  const shown = "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 37m19s.";
  const details = '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"QUOTA_EXHAUSTED","metadata":{"model":"gemini-4-argon-high","quotaResetDelay":"37m19.269012167s","quotaResetTimeStamp":"2026-10-14T06:15:03Z"}}]}}';
  const at = new Date("2026-10-14T05:37:43Z");
  // 429 alone reads as overloaded; the quota wording wins.
  assert.deepEqual(classifyErrorText(`${shown}\n${details}`, at), { kind: "usage-limit", resetAt: "2026-10-14T06:15:03.000Z" });
  // Without the details, the delay counts from the error's own time.
  assert.deepEqual(classifyErrorText(shown, at), { kind: "usage-limit", resetAt: "2026-10-14T06:15:02.000Z" });
  assert.equal(classifyErrorText("RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 2h6m11s.", at).resetAt, "2026-10-14T07:43:54.000Z");
  assert.equal(classifyErrorText("You have exhausted your quota on this model.", at).kind, "usage-limit");
  // Escaped JSON (the rpc error details) still gives the stamp.
  assert.equal(parseResetAt('{\\"quotaResetTimeStamp\\":\\"2026-10-14T06:15:03Z\\"}', at), "2026-10-14T06:15:03.000Z");
  assert.equal(parseResetAt("Resets in 45s.", at), "2026-10-14T05:38:28.000Z");
  assert.equal(classifyErrorText("Our servers are experiencing high traffic right now, please try again in a minute.", at).kind, "overloaded");
  assert.equal(classifyErrorText("MODEL_CAPACITY_EXHAUSTED", at).kind, "overloaded");
  // A plain 429 is still overloaded, and Claude's reset wording still parses.
  assert.equal(classifyErrorText("HTTP 429 Too Many Requests", at).kind, "overloaded");
  assert.ok(classifyErrorText("You've hit your session limit · resets 2:50am (America/Los_Angeles)", at).resetAt);
});

// Live Paseo chat, 2026-11-21: the model proxy had no Codex account, and the
// generic 503 rule read it as overloaded, so the supervisor kept resuming it.
const AUTH_NOT_FOUND = "[System Error] unexpected status 503 Service Unavailable: auth_not_found: no auth available (providers=codex, model=gpt-6.2-sol)";

test("explicit auth_not_found is provider-auth, never a generic 503 overload", () => {
  assert.deepEqual(classifyErrorText(AUTH_NOT_FOUND, now), { kind: "provider-auth", resetAt: null });
  assert.equal(classifyErrorText("auth_not_found", now).kind, "provider-auth");
  assert.equal(classifyErrorText("502 Bad Gateway: no auth available for provider", now).kind, "provider-auth");
  // Codex reports the proxy's 503 as server_overloaded; the message's code wins.
  for (const code of ["server_overloaded", "other", null]) assert.equal(classifyCodexErrorCode(code, AUTH_NOT_FOUND, now).kind, "provider-auth", String(code));
  // A real overload or LB outage keeps its own kind.
  assert.equal(classifyErrorText("unexpected status 503 Service Unavailable", now).kind, "overloaded");
  assert.equal(classifyErrorText("unexpected status 503 Service Unavailable: server is overloaded", now).kind, "overloaded");
  assert.equal(classifyErrorText("unexpected status 503 Service Unavailable: No available accounts", now).kind, "lb");
  assert.equal(classifyCodexErrorCode("server_overloaded", "Selected model is at capacity", now).kind, "model-limit");
  // Prose that merely talks about auth is not the structured code.
  assert.equal(classifyErrorText("Fixed the auth not found page in the login flow.", now), null);
});

test("providerAuthDetail keeps only the provider and model names", () => {
  assert.deepEqual(providerAuthDetail(AUTH_NOT_FOUND), { providers: ["codex"], model: "gpt-6.2-sol" });
  assert.deepEqual(providerAuthDetail("auth_not_found: no auth available (providers=codex,claude, model=x-1)"), { providers: ["codex", "claude"], model: "x-1" });
  assert.deepEqual(providerAuthDetail("auth_not_found"), { providers: [], model: null });
  assert.equal(providerAuthDetail("unexpected status 503 Service Unavailable"), null);
  const noisy = providerAuthDetail("auth_not_found: no auth available (providers=codex, model=gpt-6.2-sol) Authorization: Bearer sk-live-abcdef0123456789 account=owner@example.com");
  assert.deepEqual(noisy, { providers: ["codex"], model: "gpt-6.2-sol" });
  assert.doesNotMatch(JSON.stringify(noisy), /sk-live|Bearer|example\.com/);
});
