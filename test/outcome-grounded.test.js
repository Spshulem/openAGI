import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OutcomeStore, WORK_KINDS } from "../src/outcome-store.js";

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-grounded-"));
  return { dir, store: new OutcomeStore({ dir }) };
}

function events(dir) {
  return fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

test("ground sets the grounded fields and leaves resolution alone", () => {
  const { store } = tmpStore();
  const o = store.recordWork({ kind: "work-draft", refId: "d1" });
  const g = store.ground(o.id, { score: 1, source: "draft", fate: "approved" });
  assert.equal(g.groundedScore, 1);
  assert.equal(g.groundedSource, "draft");
  assert.equal(g.groundedFate, "approved");
  assert.equal(g.groundedWeak, false);
  assert.ok(g.groundedAt);
  assert.equal(g.resolved, false);
  assert.equal(g.qualityScore, null);
});

test("a later ground replaces the earlier one and reports the previous score", () => {
  const { store } = tmpStore();
  const seen = [];
  store.onGrounded = (outcome, previous) => seen.push([outcome.groundedScore, previous]);
  const o = store.recordWork({ kind: "work-suggestion", refId: "s1" });
  store.ground(o.id, { score: 0.7, source: "suggestion", fate: "accepted" });
  store.ground(o.id, { score: 1, source: "suggestion", fate: "accepted-done" });
  assert.deepEqual(seen, [[0.7, null], [1, 0.7]]);
  assert.equal(store.byWorkRef("work-suggestion", "s1").groundedFate, "accepted-done");
});

test("scores are clamped and null is kept", () => {
  const { store } = tmpStore();
  const a = store.recordWork({ kind: "work-task", refId: "t1" });
  const b = store.recordWork({ kind: "work-task", refId: "t2" });
  assert.equal(store.ground(a.id, { score: 1.7, fate: "x" }).groundedScore, 1);
  assert.equal(store.ground(b.id, { score: null, fate: "silence-undelivered" }).groundedScore, null);
});

test("each ground call appends one event", () => {
  const { dir, store } = tmpStore();
  const o = store.recordWork({ kind: "work-draft", refId: "d2" });
  store.ground(o.id, { score: 0, fate: "discarded" });
  store.ground(o.id, { score: 0.2, fate: "ignored-delivered", weak: true });
  const grounds = events(dir).filter((e) => e.op === "ground");
  assert.equal(grounds.length, 2);
  assert.deepEqual(grounds.map((e) => [e.groundedScore, e.fate, e.weak]), [[0, "discarded", false], [0.2, "ignored-delivered", true]]);
});

test("grounded fields survive a reload from the snapshot", () => {
  const { dir, store } = tmpStore();
  const o = store.recordWork({ kind: "work-draft", refId: "d3", signal: { id: "sig1", scrutinyAction: "act", scrutinyScore: 0.7, scrutinyDimensions: { evidence: 0.5 } } });
  store.ground(o.id, { score: 0.4, fate: "approved-edited", detail: { similarity: 0.1 } });
  const again = new OutcomeStore({ dir }).outcomes.get(o.id);
  assert.equal(again.groundedScore, 0.4);
  assert.equal(again.groundedFate, "approved-edited");
  assert.equal(again.signalId, "sig1");
  assert.deepEqual(again.scrutinyDimensions, { evidence: 0.5 });
  assert.equal(again.metadata.scrutinyScore, 0.7);
  assert.deepEqual(again.metadata.groundedDetail, { similarity: 0.1 });
});

test("resolveSweep never resolves work outcomes", () => {
  const { store } = tmpStore();
  const o = store.recordWork({ kind: "work-suggestion", refId: "s2", at: new Date(Date.now() - 48 * 3600e3).toISOString() });
  store.resolveSweep({ now: new Date() });
  assert.equal(store.outcomes.get(o.id).resolved, false);
});

test("aggregate ignores work outcomes", () => {
  const { store } = tmpStore();
  const reply = store.record({ kind: "agent-reply" });
  store.resolve(reply.id, 0.6);
  const work = store.recordWork({ kind: "work-draft", refId: "d4" });
  store.ground(work.id, { score: 1, fate: "approved" });
  const agg = store.aggregate(7);
  assert.equal(agg.total, 1);
  assert.equal(agg.byKind["work-draft"], undefined);
});

test("recordWork rejects other kinds and groundedStats counts graded work", () => {
  const { store } = tmpStore();
  assert.throws(() => store.recordWork({ kind: "agent-reply" }), /unknown work kind/);
  assert.deepEqual(WORK_KINDS, ["work-draft", "work-suggestion", "work-task"]);
  const a = store.recordWork({ kind: "work-draft", refId: "a" });
  const b = store.recordWork({ kind: "work-suggestion", refId: "b" });
  store.recordWork({ kind: "work-task", refId: "c" });
  store.ground(a.id, { score: 1, fate: "approved" });
  store.ground(b.id, { score: 0.2, fate: "silence-delivered", weak: true });
  const s = store.groundedStats();
  assert.equal(s.total, 3);
  assert.equal(s.graded, 2);
  assert.equal(s.weak, 1);
  assert.equal(s.ungraded, 1);
  assert.deepEqual(s.byFate, { approved: 1, "silence-delivered": 1 });
  assert.equal(s.perWeek.reduce((n, w) => n + w.graded, 0), 1);
});
