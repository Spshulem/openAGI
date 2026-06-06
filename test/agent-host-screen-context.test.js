// test/agent-host-screen-context.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatScreenContextBlock } from "../src/agent-host.js";

test("formats a labeled active-window block from screenContext", () => {
  const block = formatScreenContextBlock({ app: "Safari", window: "Spec — Notion", text: "the deadline is Friday" });
  assert.match(block, /Active window the user is looking at right now \(Safari · Spec — Notion\)/);
  assert.match(block, /the deadline is Friday/);
});

test("returns empty string for missing/empty screenContext", () => {
  assert.equal(formatScreenContextBlock(null), "");
  assert.equal(formatScreenContextBlock({ app: "X" }), "");
  assert.equal(formatScreenContextBlock({ text: "   " }), "");
});

test("truncates very long screen text to 4000 chars", () => {
  const block = formatScreenContextBlock({ app: "X", text: "a".repeat(5000) });
  const body = block.split("\n").find((l) => l.startsWith("aaaa"));
  assert.ok(body.length <= 4000, `body should be <= 4000, got ${body.length}`);
});

test("falls back to 'active window' when app is absent", () => {
  const block = formatScreenContextBlock({ text: "hello" });
  assert.match(block, /\(active window\)/);
});
