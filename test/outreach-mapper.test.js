// test/outreach-mapper.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { OutreachStore } from "../src/outreach-store.js";
import { OutreachMapper } from "../src/outreach-mapper.js";

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-map-"));
  const events = new EventEmitter();
  const store = new OutreachStore({ dir, runtime: { events } });
  const mapper = new OutreachMapper({ store, events });
  mapper.attach();
  return { events, store };
}

test("draft-created maps to a digest item (needsDecision=false)", () => {
  const { events, store } = harness();
  events.emit("draft-created", { id: "draft_1", title: "Reply to Acme", kind: "reply" });
  const items = store.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "draft");
  assert.equal(items[0].needsDecision, false);
  assert.deepEqual(items[0].sourceRef, { kind: "draft", id: "draft_1" });
  assert.ok(items[0].actions.includes("approve"));
});

test("pending-action maps to a live decision (needsDecision=true)", () => {
  const { events, store } = harness();
  events.emit("pending-action", { id: "act_1", summary: "Connect MCP: github" });
  const item = store.list()[0];
  assert.equal(item.type, "pending-action");
  assert.equal(item.needsDecision, true);
  assert.ok(item.actions.includes("do") && item.actions.includes("dismiss"));
});

test("proactive-suggestion maps to a digest suggestion", () => {
  const { events, store } = harness();
  events.emit("proactive-suggestion", { id: "prop_1", title: "Connect GitHub", category: "mcp", rationale: "seen often" });
  const item = store.list()[0];
  assert.equal(item.type, "suggestion");
  assert.equal(item.needsDecision, false);
  assert.equal(item.sourceRef.id, "prop_1");
});

test("unknown events are ignored (no item created)", () => {
  const { events, store } = harness();
  events.emit("miner-result", { source: "task-sweep" });
  assert.equal(store.list().length, 0);
});

test("attach is idempotent — calling attach twice yields one item per event", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-idem-"));
  const events = new EventEmitter();
  const store = new OutreachStore({ dir, runtime: { events } });
  const mapper = new OutreachMapper({ store, events });
  mapper.attach();
  mapper.attach(); // second attach must NOT double-subscribe
  events.emit("draft-created", { id: "draft_idem", title: "Once" });
  assert.equal(store.list().filter((i) => i.sourceRef?.id === "draft_idem").length, 1);
});
