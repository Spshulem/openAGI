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

test("coding replies notify for full review without a truncated-preview execution shortcut", () => {
  const { events, store } = harness();
  events.emit("pending-action", { id: "act_coding", toolName: "reply_to_coding_agent", summary: "Truncated instruction" });
  const item = store.list()[0];
  assert.equal(item.type, "coding-approval");
  assert.equal(item.needsDecision, true);
  assert.deepEqual(item.actions, ["dismiss"]);
  assert.match(item.summary, /complete instruction/);
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

test("skill-candidate maps to a durable skill outreach item", () => {
  const { events, store } = harness();
  events.emit("skill-candidate", {
    source: "pattern-miner",
    id: "sug_abc",
    name: "morning-triage",
    description: "Morning triage routine across Slack, Linear, Xcode",
    occurrences: 6,
    judgeBypass: false
  });
  const items = store.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "skill");
  assert.equal(items[0].needsDecision, false);
  assert.deepEqual(items[0].sourceRef, { kind: "skill-candidate", id: "sug_abc" });
  assert.deepEqual(items[0].actions, ["accept", "dismiss"]);
  assert.match(items[0].title, /morning-triage/);
  assert.match(items[0].summary, /Morning triage routine/);
});

test("re-emitting the same skill-candidate does not create a second open item", () => {
  const { events, store } = harness();
  const payload = { source: "session-miner", id: "ses_dup", name: "weekly-report", description: "Recurring weekly report request", occurrences: 3 };
  events.emit("skill-candidate", payload);
  events.emit("skill-candidate", payload);
  assert.equal(store.list().filter((i) => i.sourceRef?.id === "ses_dup").length, 1);
});

test("a resolved skill item does not block a new item for the same candidate", () => {
  const { events, store } = harness();
  const payload = { source: "pattern-miner", id: "sug_res", name: "standup-prep", description: "prep standup notes", occurrences: 4 };
  events.emit("skill-candidate", payload);
  const first = store.list()[0];
  store.resolve(first.id, { action: "dismiss", by: "user" }, { status: "dismissed" });
  events.emit("skill-candidate", payload);
  assert.equal(store.list().filter((i) => i.sourceRef?.id === "sug_res").length, 2);
});

test("mapped items carry outcomeId and digest types offer thumbs actions", () => {
  const { events, store } = harness();
  events.emit("draft-created", { id: "draft_2", title: "With outcome", outcomeId: "out_123" });
  events.emit("proactive-suggestion", { id: "prop_2", title: "Suggests", category: "automation", rationale: "r" });
  const draft = store.list().find((i) => i.sourceRef?.id === "draft_2");
  const suggestion = store.list().find((i) => i.sourceRef?.id === "prop_2");
  assert.equal(draft.outcomeId, "out_123");
  assert.equal(suggestion.outcomeId, null);
  assert.ok(draft.actions.includes("up") && draft.actions.includes("down"));
  assert.ok(suggestion.actions.includes("up") && suggestion.actions.includes("down"));
});
