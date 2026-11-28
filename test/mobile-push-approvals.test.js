// test/mobile-push-approvals.test.js
// Approval alerts on the iOS push pipe: a pending action that needs the owner
// becomes one sealed "approval" alert per phone that said it can act on one,
// once per card, and the question alert gains canReply for the Reply field.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { MobilePush, PUSH_TIMING, approvalNeedsOwner, buildAlert, buildApproval } from "../src/mobile-push.js";
import { MobilePushStore, validatePushRegistration } from "../src/mobile-push-store.js";
import { openPushEnvelope } from "../src/mobile-push-envelope.js";
import { PendingActionStore } from "../src/pending-actions.js";
const FULL = { previews: "full" };

const T0 = Date.parse("2026-11-21T12:00:00.000Z");
const NODE = "mobile:phone-1";
const KEY = crypto.randomBytes(32).toString("base64url");

const chatCard = (extra = {}) => ({
  toolName: "send_email", args: { to: "alex@example.com" }, context: { sessionId: "devices:agent:main" },
  summary: "Email Alex the notes", mode: "chat", announce: false, ...extra
});

function harness(t, { supervisor = null, approvals = true, alerts = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-push-approvals-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = T0;
  const pendingActions = new PendingActionStore({ dir: path.join(dir, "pending"), now: () => now });
  const store = new MobilePushStore({ dir });
  store.put(NODE, { pass: "p1.pass-one", key: KEY, env: "sandbox", approvals, alerts, previews: "full" });
  const events = new EventEmitter();
  pendingActions.bindEvents(events);

  let seq = 0;
  const due = new Map();
  const timers = {
    setTimeout(fn, ms) { seq += 1; due.set(seq, { at: now + ms, fn }); return seq; },
    clearTimeout(id) { due.delete(id); }
  };
  const sent = [];
  const fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const make = (pushStore) => new MobilePush({
    store: pushStore, supervisor, pendingActions, events, relayUrl: "https://relay.test", fetch, now: () => now, timers, log: () => {}
  });
  const push = make(store);
  push.start();
  t.after(() => push.stop());
  return {
    push, store, pendingActions, events, sent, dir,
    make,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...due.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        due.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await push.flushing;
      }
      now = end;
    }
  };
}

test("approval plaintext: id, capped summary with a fallback, the spoken code", () => {
  const plain = buildApproval({ id: "act_1", toolName: "send_email", summary: `  ${"S".repeat(300)} `, confirmCode: "42" }, FULL);
  assert.deepEqual(Object.keys(plain), ["actionId", "summary", "code"]);
  assert.equal(plain.actionId, "act_1");
  assert.equal(plain.summary.length, 220);
  assert.ok(plain.summary.endsWith("…"));
  assert.equal(plain.code, "42");
  assert.deepEqual(buildApproval({ id: "act_2", toolName: "register_mcp_server", summary: " ", confirmCode: null }, FULL),
    { actionId: "act_2", summary: "Run register_mcp_server", code: null });
});

test("only a pending queue or chat card needs the owner; an owner-mode record already ran", () => {
  assert.equal(approvalNeedsOwner({ id: "a", status: "pending", mode: "queue" }), true);
  assert.equal(approvalNeedsOwner({ id: "a", status: "pending", mode: "chat" }), true);
  assert.equal(approvalNeedsOwner({ id: "a", status: "pending" }), true, "a card from before modes is a queued one");
  assert.equal(approvalNeedsOwner({ id: "a", status: "executing", mode: "owner" }), false);
  assert.equal(approvalNeedsOwner({ id: "a", status: "pending", mode: "owner" }), false);
  assert.equal(approvalNeedsOwner({ id: "a", status: "approved", mode: "queue" }), false);
  assert.equal(approvalNeedsOwner({ id: "", status: "pending" }), false);
});

test("question alerts say when the answer route takes typed text, and never offer an 'Answer question' button", () => {
  assert.equal(buildAlert({ id: "fq1", title: "t", options: ["yes"], canReply: true }, FULL).canReply, true);
  assert.equal(buildAlert({ id: "fq2", title: "t", options: ["yes"] }, FULL).canReply, false);
  const suggestion = buildAlert({ id: "fq3", kind: "suggestion", title: "t", options: ["Approve", "Answer question", "Skip"] }, FULL);
  assert.equal(suggestion.canReply, true);
  assert.deepEqual(suggestion.options, ["Approve", "Skip"]);
  assert.equal(buildAlert({ id: "fq4", kind: "agent-ask", title: "t", options: ["Answer question"] }, FULL).canReply, false);
});

test("the phone opts in to approval alerts; anything but a boolean is refused", () => {
  const base = { pass: "p1.x", key: KEY, env: "sandbox" };
  assert.equal(validatePushRegistration(base).value.approvals, false, "an older app never asked for them");
  assert.equal(validatePushRegistration({ ...base, approvals: true }).value.approvals, true);
  assert.equal(validatePushRegistration({ ...base, approvals: "yes" }).ok, false);
});

test("a chat card raised without an SSE announcement still alerts the phone once, sealed as kind approval", async (t) => {
  const h = harness(t);
  const card = h.pendingActions.enqueue(chatCard());
  await h.advance(PUSH_TIMING.debounceMs);
  assert.equal(h.sent.length, 1);
  const [sent] = h.sent;
  assert.equal(sent.type, "alert");
  assert.equal(sent.collapseId, card.id);
  assert.deepEqual(JSON.parse(openPushEnvelope(KEY, "approval", sent.sealed)),
    { actionId: card.id, summary: "Email Alex the notes", code: card.confirmCode });
  assert.throws(() => openPushEnvelope(KEY, "alert", sent.sealed), "an approval can never be opened as a question alert");
  assert.deepEqual(h.store.get(NODE).approvalsNotified, [card.id]);
});

test("a card re-raised with the same args is the same card: no second alert, not even after a restart", async (t) => {
  const h = harness(t);
  const card = h.pendingActions.enqueue(chatCard());
  await h.advance(PUSH_TIMING.debounceMs);
  const again = h.pendingActions.enqueue(chatCard());
  assert.equal(again.id, card.id);
  h.events.emit("fleet", {});
  await h.advance(PUSH_TIMING.debounceMs);
  assert.equal(h.sent.length, 1);

  h.push.stop();
  const restarted = h.make(new MobilePushStore({ dir: h.dir }));
  await restarted.flush();
  assert.equal(h.sent.length, 1, "push.json remembers what was alerted");

  // A different request is a different card and alerts on its own.
  const other = h.pendingActions.enqueue(chatCard({ args: { to: "sam@example.com" } }));
  await restarted.flush();
  assert.deepEqual(h.sent.map((s) => s.collapseId), [card.id, other.id]);
});

test("a queued approval alerts via its pending-action event; a decided card is pruned", async (t) => {
  const h = harness(t);
  const card = h.pendingActions.enqueue({ toolName: "register_mcp_server", args: { name: "x" }, summary: "Register MCP server x" });
  await h.advance(PUSH_TIMING.debounceMs);
  assert.deepEqual(h.sent.map((s) => s.collapseId), [card.id]);
  h.pendingActions.decide(card.id, { decision: "deny", decidedBy: "user" });
  await h.advance(PUSH_TIMING.debounceMs);
  assert.deepEqual(h.store.get(NODE).approvalsNotified, []);
  assert.equal(h.sent.length, 1);
});

test("owner-mode records, phones without the opt-in, and phones with alerts off get nothing", async (t) => {
  const owner = harness(t);
  owner.pendingActions.recordOwnerApproved({ toolName: "send_email", args: {}, summary: "ran on the owner's word" });
  await owner.push.flush();
  assert.equal(owner.sent.length, 0);

  const old = harness(t, { approvals: false });
  old.pendingActions.enqueue(chatCard());
  await old.push.flush();
  assert.equal(old.sent.length, 0);
  assert.deepEqual(old.store.get(NODE).approvalsNotified, [], "turning it on later still alerts");

  const muted = harness(t, { alerts: false });
  const card = muted.pendingActions.enqueue(chatCard());
  await muted.push.flush();
  assert.equal(muted.sent.length, 0);
  muted.store.put(NODE, { pass: "p1.pass-one", key: KEY, env: "sandbox", approvals: true, alerts: true });
  await muted.push.flush();
  assert.deepEqual(muted.sent.map((s) => s.collapseId), [card.id]);
});

test("an unreadable supervisor costs its own alerts, never the approvals", async (t) => {
  const h = harness(t, { supervisor: { getState() { throw new Error("boom"); } } });
  const card = h.pendingActions.enqueue(chatCard());
  await h.push.flush();
  assert.deepEqual(h.sent.map((s) => `${s.type} ${s.collapseId}`), [`alert ${card.id}`]);
});

test("PendingActionStore.watch hears each new card once, never an owner record, and a throwing listener is ignored", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-watch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new PendingActionStore({ dir });
  const heard = [];
  store.watch(() => { throw new Error("listener bug"); });
  const unwatch = store.watch((action) => heard.push(action.id));
  const card = store.enqueue(chatCard());
  store.enqueue(chatCard());
  store.recordOwnerApproved({ toolName: "send_email", args: { n: 1 }, summary: "owner" });
  assert.deepEqual(heard, [card.id]);
  unwatch();
  store.enqueue(chatCard({ args: { to: "sam@example.com" } }));
  assert.equal(heard.length, 1);
});

test("lock-screen privacy is the default: no card text, options, thread or approval summary leave main", () => {
  const question = { id: "fq9", title: "Merge PR #42 in acme/payroll?", body: "Salary table migration is ready.", options: ["Merge", "Skip"], threadKey: "codex:secret", canReply: true };
  const alert = buildAlert(question);
  assert.deepEqual(alert, { questionId: "fq9", title: "Supervisor needs you", body: "Open OpenAGI to review it.", options: [], threadKey: null, canReply: false, private: true });
  assert.doesNotMatch(JSON.stringify(alert), /payroll|Salary|Merge|secret/);
  const approval = buildApproval({ id: "act_9", toolName: "send_email", summary: "Email Dana the offer letter", confirmCode: "17" });
  assert.doesNotMatch(approval.summary, /Dana|offer/);
  assert.equal(approval.actionId, "act_9");
  assert.equal(validatePushRegistration({ pass: "p1.x", key: KEY, env: "sandbox" }).value.previews, "private");
  assert.equal(validatePushRegistration({ pass: "p1.x", key: KEY, env: "sandbox", previews: "full" }).value.previews, "full");
  assert.equal(validatePushRegistration({ pass: "p1.x", key: KEY, env: "sandbox", previews: "loud" }).ok, false);
});
