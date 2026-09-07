import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { G2Proactive } from "../src/g2-proactive.js";
import { moments, lifelogState, reviewLifelog } from "../src/conversation-lifelog.js";
import { lifelogPage } from "../src/lifelog-page.js";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lifelog-test-")); let now = Date.parse("2026-09-07T12:00:00Z");
  const tasks = [], runtime = { tasks: { list: () => tasks, add: x => { const row = { ...x, id: `task-${tasks.length}` }; tasks.push(row); return row; } } };
  const store = new G2Proactive({ dir, runtime, now: () => now });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = body => store.dispatch("fixture-node", body), n = store.node("fixture-node");
  let consent = call({ op: "consent", enabled: true, recordingConsent: true }).consent.id;
  const capture = (value, speaker = 0) => call({ op: "capture", consentId: consent, batchId: crypto.randomUUID(), texts: [value],
    segments: [{ at: now - 3000, endAt: now, streamId: "fixture-stream", speaker }] });
  return { dir, store, call, n, runtime, tasks, capture, now: () => now, advance: ms => { now += ms; }, renew: () => { consent = call({ op: "consent", enabled: true, recordingConsent: true }).consent.id; } };
}

test("moments group conversations, preserve timed speakers and mark meaningful beats", t => {
  const f = fixture(t); f.capture("I'll send the proposal tomorrow."); f.advance(16000); f.capture("We agreed to launch next week.", 1);
  let ms = moments(f.n); assert.equal(ms.length, 1); assert.equal(ms[0].speakers.length, 2);
  assert.ok(ms[0].beats.some(b => b.kind === "commitment")); assert.ok(ms[0].beats.some(b => b.kind === "decision"));
  f.advance(360000); f.capture("New conversation about the design.");
  ms = moments(f.n); assert.equal(ms.length, 2); assert.match(ms[1].boundary, /gap/);
  f.advance(16000); f.renew(); f.capture("Different recording session."); assert.equal(moments(f.n).length, 3);
  assert.equal(f.tasks.length, 0);
});

test("search, labels, split/merge, topics and export share canonical evidence", t => {
  const f = fixture(t); f.capture("Review the launch."); f.advance(16000); f.capture("We agreed to use blue.", 1);
  const first = f.n.segments[0], second = f.n.segments[1];
  f.call({ op: "lifelog-label", speakerKey: first.speakerKey, label: "Alex" });
  assert.equal(f.call({ op: "lifelog", query: "Alex", date: "2026-09-07" }).total, 1);
  f.call({ op: "lifelog-edit", id: second.id, boundary: "split" }); assert.equal(moments(f.n).length, 2);
  f.call({ op: "lifelog-edit", id: second.id, boundary: "merge" }); assert.equal(moments(f.n).length, 1);
  f.call({ op: "lifelog-edit", id: first.id, title: "Design review", topics: ["Launch"] });
  const result = f.call({ op: "lifelog-export", query: "Launch" }); assert.equal(result.moments[0].title, "Design review");
  assert.equal(result.moments[0].segments[0].text, "Review the launch.");
  const restored = new G2Proactive({ dir: f.dir, now: f.now }); assert.equal(moments(restored.node("fixture-node"))[0].title, "Design review"); restored.close();
  assert.equal(fs.statSync(f.store.file).mode & 0o777, 0o600);
});

test("semantic review is opt-in, bounded, uses no tools and rejects invented citations", async t => {
  const f = fixture(t); f.capture("I'll send the proposal tomorrow."); f.advance(120000); let calls = 0;
  const provider = { isConfigured: () => true, generate: async args => {
    calls++; assert.deepEqual(args.tools, []); assert.equal(args.toolRegistry, null); assert.equal(args.model, "test-small-model");
    return { text: JSON.stringify({ title: "Proposal", summary: "A possible commitment", topics: ["Sales"], claims: [
      { kind: "commitment", text: "Send the proposal", segmentId: f.n.segments[0].id, quote: "I'll send the proposal", ownerSpeakerKey: "invented" },
      { kind: "decision", text: "Release approved", segmentId: f.n.segments[0].id, quote: "Ship everything" }] }) };
  } };
  const run = () => reviewLifelog(f.n, { provider, now: f.now(), save: () => f.store.save() });
  await run(); assert.equal(calls, 0);
  f.call({ op: "lifelog-settings", settings: { analysis: true, model: "test-small-model", maxReviewsPerDay: 1 } });
  await run(); assert.equal(calls, 1); const review = moments(f.n)[0].review;
  assert.equal(review.claims.length, 1); assert.equal(review.claims[0].ownerSpeakerKey, null);
  f.advance(360000); await run(); assert.equal(calls, 1); assert.equal(f.tasks.length, 0);
});

test("deletion during review cannot resurrect transcript-derived data", async t => {
  const f = fixture(t); f.capture("I'll send the plan."); f.advance(120000);
  f.call({ op: "lifelog-settings", settings: { analysis: true, model: "test-model" } });
  const provider = { isConfigured: () => true, generate: async () => { f.call({ op: "delete-memory" }); return { text: '{"title":"secret","summary":"secret","topics":[],"claims":[]}' }; } };
  await reviewLifelog(f.n, { provider, now: f.now(), save: () => f.store.save() });
  assert.equal(f.n.segments.length, 0); assert.equal(JSON.stringify(f.n).includes("secret"), false);
});

test("follow-ups and task creation require confirmation, are idempotent and never execute", t => {
  const f = fixture(t); f.capture("I'll send the plan."); const segmentId = f.n.segments[0].id;
  assert.throws(() => f.call({ op: "lifelog-task", segmentId, title: "Send plan" }), /Confirm/);
  const a = f.call({ op: "lifelog-task", segmentId, title: "Send plan", confirm: true });
  assert.equal(f.call({ op: "lifelog-task", segmentId, title: "Send plan", confirm: true }).taskId, a.taskId);
  assert.equal(f.tasks.length, 1);
  f.call({ op: "lifelog-followup", segmentId, title: "Send plan", status: "confirmed", dueAt: new Date(f.now()).toISOString() });
  f.call({ op: "configure", settings: { enabled: true } }); assert.ok(f.call({ op: "feed" }).items.some(i => i.title === "Follow up: Send plan"));
  f.call({ op: "lifelog-delete", id: segmentId }); assert.equal(Object.keys(lifelogState(f.n).followups).length, 0);
  assert.equal(f.tasks.length, 1); assert.equal(f.call({ op: "lifelog" }).total, 0);
});

test("retention cascades through reviews, labels, edits and follow-ups", t => {
  const f = fixture(t); f.capture("Remember to send the plan."); const s = f.n.segments[0];
  f.call({ op: "lifelog-label", speakerKey: s.speakerKey, label: "Alex" });
  f.call({ op: "lifelog-edit", id: s.id, title: "Private conversation" });
  f.advance(86400001); f.store.prune();
  assert.equal(f.call({ op: "lifelog" }).total, 0); assert.deepEqual(lifelogState(f.n).labels, {}); assert.deepEqual(lifelogState(f.n).edits, {});
});

test("screen context is separately opt-in and is not copied into the lifelog", async t => {
  const f = fixture(t); f.capture("Discuss design"); const id = f.n.segments[0].id;
  f.runtime.observations = { searchTextWindow: async () => [{ at: new Date(f.now()).toISOString(), app: "Fixture", text: "screen reference" }] };
  await assert.rejects(f.store.screenContext("fixture-node", id), /Enable/);
  f.call({ op: "lifelog-settings", settings: { screenContext: true } });
  const result = await f.store.screenContext("fixture-node", id); assert.equal(result.items.length, 1);
  assert.equal(JSON.stringify(f.n).includes("screen reference"), false);
});

test("invalid metadata/settings and cross-node reads fail safely; page script parses", t => {
  const f = fixture(t); f.capture("Hello");
  assert.equal(f.store.dispatch("other-node", { op: "lifelog" }).total, 0);
  assert.throws(() => f.call({ op: "lifelog-settings", settings: { analysis: true } }), /model/);
  assert.throws(() => f.call({ op: "lifelog-settings", settings: { maxReviewsPerDay: 999 } }));
  assert.throws(() => f.call({ op: "lifelog-label", speakerKey: "another-speaker", label: "Alex" }));
  for (const [, script] of lifelogPage.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script);
  assert.doesNotMatch(lifelogPage, /innerHTML/);
});

test("cross-moment topic links are evidence references, and deletion removes them", t => {
  const f = fixture(t); f.capture("Discuss launch plan."); const a = f.n.segments[0].id;
  f.advance(360000); f.capture("Continue the launch discussion."); const b = f.n.segments[1].id;
  for (const id of [a, b]) f.call({ op: "lifelog-edit", id, topics: ["Launch"] });
  assert.equal(f.call({ op: "lifelog", id: a }).moments[0].related[0].id, b);
  f.call({ op: "lifelog-delete", id: b });
  assert.deepEqual(f.call({ op: "lifelog", id: a }).moments[0].related, []);
});

test("invalid model output is not automatically retried or allowed to monopolize the daily budget", async t => {
  const f = fixture(t); f.capture("Discuss launch plan."); f.advance(120000); let calls = 0;
  f.call({ op: "lifelog-settings", settings: { analysis: true, model: "fixture-model" } });
  const provider = { isConfigured: () => true, generate: async () => { calls++; return { text: "not json" }; } };
  const run = () => reviewLifelog(f.n, { provider, now: f.now(), save: () => f.store.save() });
  await run(); f.advance(360000); await run(); assert.equal(calls, 1);
  f.call({ op: "lifelog-retry" }); await run(); assert.equal(calls, 2);
});

test("filtered export excludes unrelated labels, followups and related titles; reads do not write", t => {
  const f = fixture(t); f.capture("Public launch plan"); const first = f.n.segments[0];
  f.call({ op: "lifelog-label", speakerKey: first.speakerKey, label: "Alex" });
  f.call({ op: "lifelog-edit", id: first.id, topics: ["Shared"] });
  f.advance(360000); f.renew(); f.capture("Unrelated private discussion", 1); const second = f.n.segments[1];
  f.call({ op: "lifelog-label", speakerKey: second.speakerKey, label: "Private Person" });
  f.call({ op: "lifelog-edit", id: second.id, topics: ["Shared"] });
  f.call({ op: "lifelog-followup", segmentId: second.id, title: "Private followup", status: "confirmed" });
  let writes = 0; f.store.save = () => { writes++; };
  const result = f.call({ op: "lifelog-export", query: "Public" });
  assert.equal(result.moments.length, 1); assert.deepEqual(Object.values(result.labels), ["Alex"]);
  assert.deepEqual(result.followups, []); assert.deepEqual(result.moments[0].related, []);
  f.call({ op: "lifelog" }); assert.equal(writes, 0);
});

test("daily digest covers more than one page and cancellation clears active status", async t => {
  const f = fixture(t);
  for (let i = 0; i < 26; i++) { f.n.segments.push({ id: `segment-${i}`, text: "Meeting", at: f.now() - i * 360000, captureSession: `stream-${i}` }); }
  const result = f.call({ op: "lifelog" }); assert.equal(result.moments.length, 25); assert.equal(result.digest.length, 26);
  f.call({ op: "lifelog-settings", settings: { analysis: true, model: "fixture-model" } });
  await reviewLifelog(f.n, { provider: { isConfigured: () => true, generate: async () => {
    f.call({ op: "lifelog-settings", settings: { analysis: false } }); return { text: "{}" };
  } }, now: f.now(), save: () => f.store.save() });
  assert.equal(lifelogState(f.n).status, "Analysis off");
});
