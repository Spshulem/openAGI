import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FleetSupervisor } from "../src/fleet/supervisor.js";
import { buildSupervisorCard } from "../src/fleet/cards.js";

// A card reply that only queues behind a coding agent's running turn closed
// the owner's card as answered at once. If that queued message then never
// reached the agent (expired after 24 h behind a stuck turn, target archived,
// send failed, or delivery left unconfirmed), the card stayed closed and the
// owner believed the reply was delivered. Now the queued message stays linked
// to its card, and the card is put back, once, with what happened.

const NOW = Date.parse("2026-11-25T16:00:00.000Z");
const HOUR = 3_600_000;

function setup(t, { deliver } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "undelivered-reply-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { now: NOW };
  const calls = [];
  let busy = true;
  const sup = new FleetSupervisor({
    dataDir: dir,
    runtime: { events: { emit() {} } },
    config: { enabled: true, mode: "auto", paseo: { enabled: true, only: true } },
    deps: {
      now: () => clock.now,
      executor: {
        async deliver(opts) {
          calls.push(opts);
          if (busy && opts.queue) return { status: "busy", busy: true, route: "paseo-send", detail: "Session is mid-turn" };
          return deliver ? deliver(opts) : { status: "sent", route: "paseo-send", actionId: "act_1", detail: "Paseo message and turn confirmed" };
        }
      }
    }
  });
  const thread = {
    key: "paseo:srv_1.agent_sales", kind: "paseo", id: "agent_sales", title: "Sales v1 PR review", workspace: "sales",
    agentStatus: "running", archived: false, excluded: null, prRefs: [],
    meta: { serverId: "srv_1", provider: "antigravity", isLocalHost: true }
  };
  sup.lastThreads.set(thread.key, thread);
  const question = sup.store.upsertQuestion({ dedupeKey: "ask:sales:1", kind: "agent-ask", threadKey: thread.key, title: "Sales: merge after verify?", body: "Merge once bb-verify passes?", options: ["yes", "no"] });
  return { sup, clock, calls, thread, question, setIdle: () => { busy = false; } };
}

async function replyQueued(ctx, text = "Yes, merge once bb-verify passes.") {
  const sent = await ctx.sup.sendOwnerMessage(ctx.thread.key, text, { questionId: ctx.question.id, questionAnswer: text });
  assert.equal(sent.delivery.status, "queued");
  assert.equal(ctx.calls.length, 0, "nothing sent into the running turn");
  // As actCard does for a queued reply: the card is answered at once.
  ctx.sup.store.answerQuestion(ctx.question.id, text);
  assert.equal(ctx.sup.store.question(ctx.question.id).status, "answered");
  return text;
}

test("a queued card reply that expires behind a stuck turn puts the card back, without sending", async (t) => {
  const ctx = setup(t);
  await replyQueued(ctx);
  assert.equal(ctx.sup.store.queuedOwnerMessages(ctx.thread.key)[0].questionId, ctx.question.id, "the queued message is linked to its card");
  ctx.clock.now = NOW + 25 * HOUR;
  await ctx.sup.drainQueuedOwnerMessages({ byKey: new Map([[ctx.thread.key, ctx.thread]]), started: ctx.clock.now });
  const q = ctx.sup.store.question(ctx.question.id);
  assert.equal(q.status, "open", "the card is back for the owner");
  assert.match(q.deliveryNote, /never sent\. Nothing reached the agent/);
  assert.equal(ctx.calls.length, 0, "nothing re-sent automatically");
  // Once only.
  await ctx.sup.drainQueuedOwnerMessages({ byKey: new Map([[ctx.thread.key, ctx.thread]]), started: ctx.clock.now + 60_000 });
  const reopenedRecords = (ctx.sup.getState().actions ?? []).filter((a) => /not delivered \(expired\); card reopened/.test(a.detail ?? ""));
  assert.equal(reopenedRecords.length, 1, "reopened and recorded once");
});

test("a queued card reply dropped because its chat was archived puts the card back", async (t) => {
  const ctx = setup(t);
  await replyQueued(ctx);
  const archived = { ...ctx.thread, archived: true };
  await ctx.sup.drainQueuedOwnerMessages({ byKey: new Map([[archived.key, archived]]), started: NOW + 60_000 });
  const q = ctx.sup.store.question(ctx.question.id);
  assert.equal(q.status, "open");
  assert.match(q.deliveryNote, /archived before your queued reply was sent/);
  assert.equal(ctx.calls.length, 0);
});

test("an unconfirmed queued reply puts the card back saying to check the chat, and is not re-sent", async (t) => {
  const ctx = setup(t, { deliver: () => ({ status: "unknown", unconfirmed: true, route: "paseo-send", detail: "turn confirmation timed out" }) });
  await replyQueued(ctx);
  ctx.setIdle();
  const idle = { ...ctx.thread, agentStatus: "idle" };
  await ctx.sup.drainQueuedOwnerMessages({ byKey: new Map([[idle.key, idle]]), started: NOW + 60_000 });
  assert.equal(ctx.calls.length, 1, "one attempt");
  const q = ctx.sup.store.question(ctx.question.id);
  assert.equal(q.status, "open");
  assert.match(q.deliveryNote, /may have reached the agent.*Check the chat before sending it again/);
  await ctx.sup.drainQueuedOwnerMessages({ byKey: new Map([[idle.key, idle]]), started: NOW + 120_000 });
  assert.equal(ctx.calls.length, 1, "never sent a second time");
});

test("a queued card reply that is delivered leaves the card answered", async (t) => {
  const ctx = setup(t);
  await replyQueued(ctx);
  ctx.setIdle();
  const idle = { ...ctx.thread, agentStatus: "idle" };
  const drained = await ctx.sup.drainQueuedOwnerMessages({ byKey: new Map([[idle.key, idle]]), started: NOW + 60_000 });
  assert.equal(drained[0].status, "sent");
  const q = ctx.sup.store.question(ctx.question.id);
  assert.equal(q.status, "answered");
  assert.equal(q.deliveryNote, undefined);
});

test("a newer, different answer from the owner stands: an old undelivered reply does not reopen the card", async (t) => {
  const ctx = setup(t);
  await replyQueued(ctx);
  // The owner answered again differently (e.g. on another device).
  ctx.sup.store.reopenQuestion(ctx.question.id, [], { answer: null });
  ctx.sup.store.answerQuestion(ctx.question.id, "No, hold the merge.");
  ctx.clock.now = NOW + 25 * HOUR;
  await ctx.sup.drainQueuedOwnerMessages({ byKey: new Map([[ctx.thread.key, ctx.thread]]), started: ctx.clock.now });
  const q = ctx.sup.store.question(ctx.question.id);
  assert.equal(q.status, "answered");
  assert.equal(q.answer, "No, hold the merge.");
});

// Review fix (#384): an expired reply pruned from the queue, then a restart
// before the next drain, lost its recovery record: the queued message was
// already gone, so the card was never put back.
test("a restart between the expiry and the next drain still puts the card back", async (t) => {
  const ctx = setup(t);
  await replyQueued(ctx);
  ctx.clock.now = NOW + 25 * HOUR;
  assert.equal(ctx.sup.store.queuedOwnerMessages(ctx.thread.key).length, 0, "the expired message was pruned");
  // Restart: a fresh supervisor over the same data directory.
  const restarted = new FleetSupervisor({
    dataDir: ctx.sup.dataDir,
    runtime: { events: { emit() {} } },
    config: { enabled: true, mode: "auto", paseo: { enabled: true, only: true } },
    deps: { now: () => ctx.clock.now, executor: { async deliver() { throw new Error("must not send"); } } }
  });
  await restarted.drainQueuedOwnerMessages({ byKey: new Map([[ctx.thread.key, ctx.thread]]), started: ctx.clock.now });
  const q = restarted.store.question(ctx.question.id);
  assert.equal(q.status, "open");
  assert.match(q.deliveryNote, /never sent/);
});

// Review fix (#384): the note was stored but shown nowhere, so an owner
// could re-answer an unconfirmed reply that had already landed.
test("the reopened card says what happened to the reply before anything else", async (t) => {
  const ctx = setup(t, { deliver: () => ({ status: "unknown", unconfirmed: true, route: "paseo-send", detail: "turn confirmation timed out" }) });
  await replyQueued(ctx);
  ctx.setIdle();
  const idle = { ...ctx.thread, agentStatus: "idle" };
  await ctx.sup.drainQueuedOwnerMessages({ byKey: new Map([[idle.key, idle]]), started: NOW + 60_000 });
  const card = buildSupervisorCard(ctx.sup.store.question(ctx.question.id), { now: NOW + 60_000 });
  assert.match(card.deliveryNote, /Check the chat before sending it again/);
  assert.match(card.summary, /^Your queued reply may have reached the agent/);
});

// Review fix (#384): the card put back because its chat was archived was
// closed again at once by reconciliation ("session archived"), so the owner
// never saw that the reply went nowhere.
test("reconciliation keeps a card that is back because its archived chat never got the reply", async (t) => {
  const ctx = setup(t);
  await replyQueued(ctx);
  const archived = { ...ctx.thread, archived: true };
  ctx.sup.lastThreads.set(archived.key, archived);
  await ctx.sup.drainQueuedOwnerMessages({ byKey: new Map([[archived.key, archived]]), started: NOW + 60_000 });
  assert.equal(ctx.sup.store.question(ctx.question.id).status, "open");
  await ctx.sup.reconcileOpenQuestions({ force: true });
  const q = ctx.sup.store.question(ctx.question.id);
  assert.equal(q.status, "open", "still in front of the owner");
  assert.match(q.deliveryNote, /archived before your queued reply was sent/);
  // An ordinary card on an archived chat is still closed.
  const plain = ctx.sup.store.upsertQuestion({ dedupeKey: "ask:sales:plain", kind: "agent-ask", threadKey: archived.key, title: "Another ask", body: "?", options: ["yes"] });
  await ctx.sup.reconcileOpenQuestions({ force: true });
  assert.notEqual(ctx.sup.store.question(plain.id).status, "open");
  // A new answer clears the note.
  ctx.sup.store.answerQuestion(ctx.question.id, "Fine, drop it.");
  assert.equal(ctx.sup.store.question(ctx.question.id).deliveryNote, undefined);
});

// Review fix (#384): more than 50 linked replies expiring before a drain
// lost the oldest recovery records, so those cards stayed closed.
test("every expired reply gets its card back, however many expire at once", async (t) => {
  const ctx = setup(t);
  const ids = [];
  for (let i = 0; i < 60; i += 1) {
    const q = ctx.sup.store.upsertQuestion({ dedupeKey: `ask:bulk:${i}`, kind: "agent-ask", threadKey: ctx.thread.key, title: `Ask ${i}`, body: "?", options: ["yes"] });
    const text = `Reply number ${i}`;
    const sent = await ctx.sup.sendOwnerMessage(ctx.thread.key, text, { questionId: q.id, questionAnswer: text });
    assert.equal(sent.delivery.status, "queued");
    ctx.sup.store.answerQuestion(q.id, text);
    ids.push(q.id);
  }
  ctx.clock.now = NOW + 25 * HOUR;
  assert.equal(ctx.sup.store.queuedOwnerMessages().length, 0, "all expired");
  await ctx.sup.drainQueuedOwnerMessages({ byKey: new Map([[ctx.thread.key, ctx.thread]]), started: ctx.clock.now });
  const reopened = ids.filter((id) => ctx.sup.store.question(id).status === "open");
  assert.equal(reopened.length, ids.length, "none lost");
  assert.equal(ctx.calls.length, 0);
});

// Review fix (#384): identical replies from two cards to the same chat merge
// into one queued message; only the first card was linked, so if it never
// landed the second stayed answered with no warning.
test("identical replies from two cards share one queued message, and both cards come back", async (t) => {
  const ctx = setup(t);
  const other = ctx.sup.store.upsertQuestion({ dedupeKey: "ask:sales:2", kind: "agent-ask", threadKey: ctx.thread.key, title: "Sales: also tag the release?", body: "Tag too?", options: ["yes", "no"] });
  const text = "Yes, go ahead.";
  for (const q of [ctx.question, other]) {
    const sent = await ctx.sup.sendOwnerMessage(ctx.thread.key, text, { questionId: q.id, questionAnswer: text });
    assert.equal(sent.delivery.status, "queued");
    ctx.sup.store.answerQuestion(q.id, text);
  }
  assert.equal(ctx.sup.store.queuedOwnerMessages(ctx.thread.key).length, 1, "one message, not two");
  ctx.clock.now = NOW + 25 * HOUR;
  await ctx.sup.drainQueuedOwnerMessages({ byKey: new Map([[ctx.thread.key, ctx.thread]]), started: ctx.clock.now });
  for (const q of [ctx.question, other]) {
    const back = ctx.sup.store.question(q.id);
    assert.equal(back.status, "open", q.title);
    assert.match(back.deliveryNote, /never sent/);
  }
  assert.equal(ctx.calls.length, 0);
});
