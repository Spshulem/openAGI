import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { G2Requests } from "../src/g2-requests.js";

function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "g2-receipts-"));
  let now = Date.now(), enrolled = true, calls = 0, finish;
  const channel = {
    assertEnrolled() { if (!enrolled) throw Object.assign(new Error("revoked"), { status: 403 }); },
    sessionIdFor: () => "test-session",
    ask: async (_body, _node, options) => {
      calls++; options.onProgress({ stage: "thinking", secret: "never save" });
      return new Promise(resolve => { finish = resolve; });
    },
  };
  const options = { dir, channel, now: () => now, sweepMs: 0, ...extra };
  const store = new G2Requests(options);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, options, id: () => `${now}_${randomUUID()}`, body: { text: "hello", conversationId: "test-conversation" },
    calls: () => calls, tick: ms => { now += ms; store.sweep(); }, revoke: () => { enrolled = false; store.sweep(); },
    finish: () => finish({ question: "hello", reply: "done", sessionId: "test-session" }) };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test("durable claim deduplicates simultaneous/reconnected submissions and rejects changes", async t => {
  const f = fixture(t); const id = f.id();
  assert.equal(f.store.submit("a", id, f.body).state, "accepted");
  f.store.submit("a", id, f.body);
  assert.throws(() => f.store.submit("a", id, { ...f.body, text: "different" }), { code: "request_conflict" });
  await flush(); assert.equal(f.calls(), 1);
  assert.throws(() => f.store.get("b", id), { code: "request_not_found" });
  f.finish(); await flush();
  assert.equal(f.store.get("a", id).result.reply, "done");
  assert.equal(f.store.submit("a", id, f.body).state, "completed");
  assert.equal(f.calls(), 1);
  const file = path.join(f.dir, fs.readdirSync(f.dir)[0]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, "utf8").includes("never save"), false);
});

test("restart never replays an interrupted claim; expired ids cannot become new work", async t => {
  const f = fixture(t); const id = f.id(); f.store.submit("a", id, f.body); await flush();
  const restored = new G2Requests(f.options); t.after(() => restored.close());
  assert.equal(restored.get("a", id).state, "unconfirmed");
  assert.equal(restored.submit("a", id, f.body).state, "unconfirmed");
  assert.equal(f.calls(), 1);
  f.tick(25 * 60 * 60 * 1000);
  assert.throws(() => f.store.submit("a", id, f.body), { code: "request_expired" });
  assert.throws(() => f.store.submit("a", "not-an-id", f.body), { code: "invalid_request_id" });
});

test("admission is bounded; cancel and deadline ignore late success", async t => {
  const f = fixture(t); const id = f.id(); f.store.submit("a", id, f.body); await flush();
  assert.throws(() => f.store.submit("a", f.id(), f.body), { code: "request_busy" });
  assert.equal(f.store.cancel("a", id).state, "cancelled");
  f.finish(); await flush(); assert.equal(f.store.get("a", id).state, "cancelled");
  const next = f.id(); f.store.submit("a", next, f.body); await flush(); f.tick(301_000);
  assert.equal(f.store.get("a", next).state, "unconfirmed");
  f.finish(); await flush(); assert.equal(f.store.get("a", next).state, "unconfirmed");
});

test("revocation aborts active work and denies reads; a failed claim write never executes", async t => {
  const f = fixture(t); const id = f.id(); f.store.submit("a", id, f.body); await flush();
  f.revoke(); assert.throws(() => f.store.get("a", id), { status: 403 });
  const broken = fixture(t, { write: () => { throw new Error("disk full"); } });
  assert.throws(() => broken.store.submit("a", broken.id(), broken.body), { code: "request_storage_unavailable" });
  await flush(); assert.equal(broken.calls(), 0);
});

test("immediate cancellation releases admission slots without starting the agent", async t => {
  const f = fixture(t);
  for (let i = 0; i < 20; i++) {
    const id = f.id(); f.store.submit("a", id, f.body); f.store.cancel("a", id); await flush();
    assert.equal(f.store.running.size, 0);
  }
  assert.equal(f.calls(), 0);
});

test("restart reconciles an already persisted public reply without repeating work", async t => {
  const f = fixture(t), id = f.id(); f.store.submit("a", id, f.body); await flush();
  f.options.channel.agentHost = { store: { getSession: () => ({ messages: [{ role: "assistant", channel: "g2", content: "Already done", metadata: { requestId: id } }] }) } };
  const restored = new G2Requests(f.options); t.after(() => restored.close());
  assert.equal(restored.get("a", id).state, "completed");
  assert.equal(restored.submit("a", id, f.body).result.reply, "Already done");
  assert.equal(f.calls(), 1);
});
