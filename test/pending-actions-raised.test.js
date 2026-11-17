// A chat card the agent asks for again is reused through its dedupe key.
// It keeps its createdAt, but raisedAt moves to the new request, so "since
// your latest message" (bare "yes", the phone's inline card) still finds it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PendingActionStore } from "../src/pending-actions.js";

test("a re-raised chat card keeps createdAt, moves raisedAt, and survives a reload", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-raised-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = Date.parse("2026-11-17T10:00:00.000Z");
  const store = new PendingActionStore({ dir, now: () => now });
  const request = { toolName: "send_email", args: { to: "alex@example.com" }, context: { sessionId: "devices:agent:main" }, summary: "Email Alex", mode: "chat", announce: false };

  const first = store.enqueue(request);
  assert.equal(first.raisedAt, first.createdAt);

  now += 10 * 60 * 1000;
  const asked = new Date(now - 1000).toISOString();
  assert.deepEqual(store.chatCandidates("devices:agent:main", asked), [], "before asking again it is an older card");

  const again = store.enqueue(request);
  assert.equal(again.id, first.id, "the same card is reused");
  assert.equal(again.createdAt, "2026-11-17T10:00:00.000Z");
  assert.equal(again.raisedAt, "2026-11-17T10:10:00.000Z");
  assert.deepEqual(store.chatCandidates("devices:agent:main", asked).map((a) => a.id), [first.id]);
  assert.deepEqual(store.chatCandidates("devices:agent:other", asked), [], "still scoped to its own chat");

  const reloaded = new PendingActionStore({ dir, now: () => now });
  assert.equal(reloaded.get(first.id).raisedAt, "2026-11-17T10:10:00.000Z");
});

test("asking again renews the approval window; a request from another chat leaves the card alone", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-raised-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = Date.parse("2026-11-17T10:00:00.000Z");
  const store = new PendingActionStore({ dir, now: () => now });
  const ttlMs = 10 * 60 * 1000;
  const card = store.enqueue({ toolName: "fleet_send", args: { text: "hi" }, context: { sessionId: "devices:agent:main" },
    dedupeKey: "fleet:send:hi", ttlMs, mode: "chat", announce: false });
  assert.equal(card.expiresAt, "2026-11-17T10:10:00.000Z");

  now += 9 * 60 * 1000 + 50 * 1000;
  store.enqueue({ toolName: "fleet_send", args: { text: "hi" }, context: { sessionId: "devices:agent:main" },
    dedupeKey: "fleet:send:hi", ttlMs, mode: "chat", announce: false });
  assert.equal(store.get(card.id).expiresAt, "2026-11-17T10:19:50.000Z", "a fresh request gets a fresh window");
  now += 30 * 1000;
  assert.equal(store.get(card.id).status, "pending", "still approvable after the original window");

  const before = store.get(card.id).raisedAt;
  now += 60 * 1000;
  store.enqueue({ toolName: "fleet_send", args: { text: "hi" }, context: { sessionId: "devices:agent:other" },
    dedupeKey: "fleet:send:hi", ttlMs, mode: "chat", announce: false });
  assert.equal(store.get(card.id).raisedAt, before, "another chat's request does not re-raise this one");

  const reloaded = new PendingActionStore({ dir, now: () => now });
  assert.equal(reloaded.get(card.id).expiresAt, "2026-11-17T10:19:50.000Z");
});

test("asking again with different arguments re-raises the card but keeps its original deadline", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-raised-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = Date.parse("2026-11-17T10:00:00.000Z");
  const store = new PendingActionStore({ dir, now: () => now });
  const ttlMs = 10 * 60 * 1000;
  // Like reply_to_coding_agent: a fixed dedupe key, and args stamped with
  // their own preparedAt that the handler refuses after ten minutes.
  const ask = () => store.enqueue({ toolName: "reply_to_coding_agent", args: { text: "ship it", preparedAt: now },
    context: { sessionId: "devices:agent:main" }, dedupeKey: "coding:reply:thread-1", ttlMs, mode: "chat", announce: false });
  const card = ask();
  now += 9 * 60 * 1000 + 50 * 1000;
  ask();
  const after = store.get(card.id);
  assert.equal(after.raisedAt, "2026-11-17T10:09:50.000Z", "it is this turn's request again");
  assert.equal(after.args.preparedAt, Date.parse("2026-11-17T10:00:00.000Z"), "the card keeps its original arguments");
  assert.equal(after.expiresAt, "2026-11-17T10:10:00.000Z", "so its deadline stays with them");
});
