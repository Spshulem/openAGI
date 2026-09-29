// test/outreach-store.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { OutreachStore } from "../src/outreach-store.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "outreach-"));
}

test("append assigns increasing seq and persists across reload", () => {
  const dir = tmpDir();
  const s = new OutreachStore({ dir });
  const a = s.append({ type: "draft", title: "A", needsDecision: false, actions: ["approve"] });
  const b = s.append({ type: "suggestion", title: "B", needsDecision: false, actions: ["accept"] });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.ok(a.id && a.createdAt);

  const reloaded = new OutreachStore({ dir });
  assert.equal(reloaded.list().length, 2);
  assert.equal(reloaded.nextSeq, 3);
});

test("since(cursor) returns only items with a greater seq", () => {
  const dir = tmpDir();
  const s = new OutreachStore({ dir });
  s.append({ type: "draft", title: "A" });
  const b = s.append({ type: "draft", title: "B" });
  s.append({ type: "draft", title: "C" });
  const got = s.since(b.seq);
  assert.deepEqual(got.map((i) => i.title), ["C"]);
});

test("resolve is idempotent and records the decision", () => {
  const dir = tmpDir();
  const s = new OutreachStore({ dir });
  const a = s.append({ type: "stalled-task", title: "X", needsDecision: true, actions: ["close", "keep"] });
  const first = s.resolve(a.id, { action: "close", by: "user" });
  assert.equal(first.status, "acted");
  assert.equal(first.decision.action, "close");
  const second = s.resolve(a.id, { action: "keep", by: "user" });
  assert.equal(second.status, "acted");
  assert.equal(second.decision.action, "close");
});

test("markSeen flips unseen->seen for the given ids", () => {
  const dir = tmpDir();
  const s = new OutreachStore({ dir });
  const a = s.append({ type: "draft", title: "A" });
  s.markSeen([a.id]);
  assert.equal(s.get(a.id).status, "seen");
});

test("list filters by status", () => {
  const dir = tmpDir();
  const s = new OutreachStore({ dir });
  const a = s.append({ type: "draft", title: "A" });
  s.append({ type: "draft", title: "B" });
  s.resolve(a.id, { action: "approve", by: "user" });
  assert.equal(s.list({ status: "acted" }).length, 1);
  assert.equal(s.list({ status: "unseen" }).length, 1);
});

test("reopen brings back only an item its source resolved, same id with a new seq and an event", () => {
  const dir = tmpDir();
  const events = [];
  const s = new OutreachStore({ dir, runtime: { events: { emit: (name, item) => events.push([name, item.id, item.seq]) } } });
  const auto = s.append({ type: "fleet-question", sourceRef: { kind: "fleet", id: "fq_1" }, title: "Merge?" });
  const firstSeq = auto.seq;
  const owner = s.append({ type: "fleet-question", sourceRef: { kind: "fleet", id: "fq_2" }, title: "Open?" });
  const open = s.append({ type: "fleet-question", sourceRef: { kind: "fleet", id: "fq_3" }, title: "Retry?" });
  s.resolve(auto.id, "resolved", { status: "dismissed" });
  s.resolve(owner.id, { action: "dismiss", by: "user" }, { status: "dismissed" });
  const cursor = s.nextSeq - 1;
  events.length = 0;
  const back = s.reopen(auto.id);
  assert.equal(back.status, "seen");
  // Read past a consumer's cursor (the Mac overlay dropped it when resolved).
  assert.ok(back.seq > cursor);
  assert.deepEqual(s.since(cursor).map((i) => i.id), [auto.id]);
  assert.deepEqual(events, [["outreach", auto.id, back.seq]]);
  assert.equal(s.reopen(owner.id), null);
  assert.equal(s.reopen(open.id), null);
  assert.equal(s.reopen("out_missing"), null);
  assert.equal(events.length, 1);
  const reloaded = new OutreachStore({ dir });
  assert.deepEqual([reloaded.get(auto.id).status, reloaded.get(auto.id).resolvedAt], ["seen", null]);
  assert.ok(reloaded.get(auto.id).seq > firstSeq);
  assert.equal(reloaded.get(owner.id).status, "dismissed");
  assert.ok(reloaded.append({ type: "draft", title: "next" }).seq > back.seq);
});

test("update rewords only an open item in place, with a new seq and an outreach-updated event", () => {
  const dir = tmpDir();
  const events = [];
  const s = new OutreachStore({ dir, runtime: { events: { emit: (name) => events.push(name) } } });
  const a = s.append({ type: "fleet-question", sourceRef: { kind: "fleet", id: "fq_1" }, title: "4 stuck", summary: "Four threads", actions: ["retry", "dismiss"] });
  const closed = s.append({ type: "fleet-question", sourceRef: { kind: "fleet", id: "fq_2" }, title: "Merge?" });
  s.markSeen([a.id]);
  s.resolve(closed.id, { action: "merge", by: "user" });
  events.length = 0;

  const firstSeq = a.seq;
  const cursor = s.nextSeq - 1;
  const updated = s.update(a.id, { title: " 5 stuck ", actions: ["retry", "wait", "dismiss"] });
  assert.equal(updated.id, a.id);
  assert.deepEqual([updated.title, updated.summary, updated.actions], ["5 stuck", "Four threads", ["retry", "wait", "dismiss"]]);
  assert.deepEqual([updated.status, updated.createdAt], ["seen", a.createdAt]);
  assert.ok(updated.seq > firstSeq);
  assert.deepEqual(s.since(cursor).map((i) => i.id), [a.id]);
  assert.deepEqual(events, ["outreach-updated"]);
  // Same text again: no new seq and no event, only a refresh time.
  const seq = updated.seq;
  const same = s.update(a.id, { title: "5 stuck", actions: ["retry", "wait", "dismiss"] });
  assert.deepEqual([same.seq, events.length], [seq, 1]);
  assert.ok(Date.parse(same.refreshedAt) >= Date.parse(a.createdAt));

  assert.equal(s.update(closed.id, { title: "Merge now?" }), null);
  assert.equal(s.get(closed.id).title, "Merge?");
  assert.equal(s.update("out_missing", { title: "x" }), null);

  const reloaded = new OutreachStore({ dir });
  assert.equal(reloaded.list().length, 2);
  assert.equal(reloaded.get(a.id).title, "5 stuck");
});
