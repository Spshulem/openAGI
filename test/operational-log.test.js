import test from "node:test";
import assert from "node:assert/strict";
import { logOperationalEvent, validRequestId } from "../src/operational-log.js";

test("operational logs filter levels and omit payloads and unsafe metadata", (t) => {
  const oldWrite = process.stderr.write;
  const oldLevel = process.env.OPENAGI_LOG_LEVEL;
  let output = "";
  process.stderr.write = (text) => { output += text; return true; };
  t.after(() => {
    process.stderr.write = oldWrite;
    if (oldLevel === undefined) delete process.env.OPENAGI_LOG_LEVEL;
    else process.env.OPENAGI_LOG_LEVEL = oldLevel;
  });
  process.env.OPENAGI_LOG_LEVEL = "info";
  logOperationalEvent("http-request", { route: "/message" }, "debug");
  assert.equal(output, "");
  logOperationalEvent("agent-turn-completed", { requestId: "request-1", sessionId: "PRIVATE_SESSION_LABEL", durationMs: 8, body: "private-note", authorization: "private-token", model: "secret\nline" });
  const record = JSON.parse(output.slice("[openagi] ".length));
  assert.equal(record.requestId, "request-1");
  assert.equal(record.durationMs, 8);
  assert.equal(record.level, "info");
  assert.ok(Number.isFinite(Date.parse(record.at)));
  assert.equal(record.sessionId, undefined);
  assert.doesNotMatch(output, /private|secret/i);
  process.env.OPENAGI_LOG_LEVEL = "debug";
  logOperationalEvent("sse-open", { route: "/events" }, "debug");
  assert.match(output, /sse-open/);
});

test("request IDs cannot carry headers, query strings or unbounded content", () => {
  assert.equal(validRequestId("overlay:request-123"), "overlay:request-123");
  for (const value of [null, {}, "x\r\nAuthorization: secret", "?token=secret", "a".repeat(201)]) assert.equal(validRequestId(value), null);
});
