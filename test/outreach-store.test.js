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

test("reopen brings back only an item its source resolved, with the same id and seq", () => {
  const dir = tmpDir();
  const s = new OutreachStore({ dir });
  const auto = s.append({ type: "fleet-question", sourceRef: { kind: "fleet", id: "fq_1" }, title: "Merge?" });
  const owner = s.append({ type: "fleet-question", sourceRef: { kind: "fleet", id: "fq_2" }, title: "Open?" });
  const open = s.append({ type: "fleet-question", sourceRef: { kind: "fleet", id: "fq_3" }, title: "Retry?" });
  s.resolve(auto.id, "resolved", { status: "dismissed" });
  s.resolve(owner.id, { action: "dismiss", by: "user" }, { status: "dismissed" });
  assert.equal(s.reopen(auto.id).status, "seen");
  assert.equal(s.reopen(owner.id), null);
  assert.equal(s.reopen(open.id), null);
  assert.equal(s.reopen("out_missing"), null);
  const reloaded = new OutreachStore({ dir });
  assert.deepEqual([reloaded.get(auto.id).status, reloaded.get(auto.id).seq, reloaded.get(auto.id).resolvedAt], ["seen", auto.seq, null]);
  assert.equal(reloaded.get(owner.id).status, "dismissed");
});
