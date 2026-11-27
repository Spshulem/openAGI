import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FleetSupervisor } from "../src/fleet/supervisor.js";
import { createExecutor } from "../src/fleet/executor.js";
import { deliverPaseo } from "../src/fleet/paseo-delivery.js";
import { paseoThread } from "../src/fleet/sources/paseo.js";
import { createFleetRoute } from "../src/fleet/routes.js";
import { createFleetCapability, RemoteFleetSupervisor } from "../src/fleet/remote.js";
import { buildSupervisorCard } from "../src/fleet/cards.js";

// 2026-11-27: answering a Needs You card for a Paseo chat ("approve
// ActionCard spec?" -> "yes, write spec") showed only "Fleet supervisor
// error. Check the daemon log." That string is the fleet route's catch-all:
// something threw instead of saying what became of the answer. Every answer
// now ends in one of four outcomes the card shows: delivered (turn
// confirmed), queued (behind the agent's running turn), refused (with the
// reason; nothing sent), or ambiguous (it may have landed; never re-sent).

const NOW = Date.parse("2026-11-27T14:00:00.000Z");
const ANSWER = "yes, write spec";
const OPTIONS = [ANSWER, "no, keep formats"];

function setup(t, { agent: agentPatch = {}, live = null, paseo: paseoPatch = {}, ref: refPatch = {}, paseoDelivery = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "card-answer-outcome-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scanned = { id: "agent_bilbao", status: "idle", updatedAt: "2026-11-27T13:40:00Z", cwd: "/work/buildbetter", workspaceId: "ws_bb", title: "buildbetter workspace", provider: "claude", ...agentPatch };
  let current = { ...scanned, ...(live ?? {}) };
  const sent = [];
  // Confirms the turn of the last message sent, unless a test overrides it.
  const confirming = async () => ({ agent: current, entries: sent.length ? [
    { item: { type: "user_message", messageId: sent.at(-1).options.messageId }, turnId: "turn-1", seqEnd: 1 },
    { item: { type: "assistant_message", text: "Writing the spec." }, turnId: "turn-1", seqStart: 2 }
  ] : [] });
  const ref = {
    refresh: async () => {},
    current: () => current,
    send: async (text, options) => { sent.push({ text, options }); return refPatch.send ? refPatch.send(text, options) : undefined; },
    timeline: { refetch: (options) => (refPatch.refetch ?? confirming)(options, { sent, current }) }
  };
  const client = { connect: async () => {}, close: async () => {}, hosts: { list: async () => ({ self: { serverId: "srv_bb" }, hosts: [] }) }, agents: { ref: () => ref } };
  const sup = new FleetSupervisor({
    dataDir: dir,
    runtime: { events: { emit() {} } },
    config: { enabled: true, mode: "auto", paseo: { enabled: true, only: true, ...paseoPatch } },
    deps: { now: () => NOW }
  });
  sup.deps.executor = createExecutor({
    config: sup.config,
    store: sup.store,
    paseoDelivery: paseoDelivery ?? ((args) => deliverPaseo({ ...args, factory: () => client }))
  });
  const thread = paseoThread(scanned, "srv_bb");
  sup.lastThreads.set(thread.key, thread);
  const question = sup.store.upsertQuestion({
    dedupeKey: "ask:bb:actioncard", kind: "agent-ask", threadKey: thread.key,
    title: "buildbetter workspace: approve ActionCard spec?", body: "Approve the ActionCard spec, or keep the current formats?", options: OPTIONS
  });
  const route = createFleetRoute({ supervisor: sup });
  return { sup, thread, question, sent, route, setLive: (patch) => { current = { ...current, ...patch }; } };
}

// The Mac app's Needs You buttons post here (FleetConsumer.answer).
async function answerViaQuestions(ctx, answer = ANSWER) {
  const p = `/fleet/api/questions/${ctx.question.id}`;
  return ctx.route("POST", p, new URL(`http://localhost${p}`), async () => ({ answer }), {});
}

// iOS cards post here (fleetActCard).
async function answerViaCard(ctx, value = ANSWER) {
  const p = `/fleet/api/cards/${ctx.question.id}/act`;
  return ctx.route("POST", p, new URL(`http://localhost${p}`), async () => ({ op: "answer", value }), {});
}

const openQuestion = (ctx) => ctx.sup.store.question(ctx.question.id);

test("an idle agent whose turn is confirmed: delivered, and the card closes", async (t) => {
  const ctx = setup(t);
  const res = await answerViaCard(ctx);
  assert.equal(res.status, 200);
  assert.equal(res.body.result.outcome, "delivered");
  assert.equal(res.body.result.delivery.outcome, "delivered");
  assert.equal(ctx.sent.length, 1);
  assert.equal(openQuestion(ctx).status, "answered");
});

test("(a) a running agent with an active turn: the answer is queued behind it, linked to the card, and sent once", async (t) => {
  const ctx = setup(t, { agent: { status: "running", activeTurn: { id: "turn-0" } } });
  const res = await answerViaQuestions(ctx);
  assert.equal(res.status, 200);
  assert.equal(res.body.delivery.status, "queued");
  assert.equal(res.body.delivery.outcome, "queued");
  assert.match(res.body.delivery.detail, /queued and goes to it once that turn ends/);
  assert.equal(ctx.sent.length, 0, "nothing steered into the running turn");
  const [queued] = ctx.sup.store.queuedOwnerMessages(ctx.thread.key);
  assert.equal(queued.questionId, ctx.question.id, "the queued message is linked to its card (#384)");
  assert.equal(queued.questionAnswer, ANSWER);
  assert.equal(openQuestion(ctx).status, "answered");
  // The turn ends: the drain sends it, once, and the card stays answered.
  ctx.setLive({ status: "idle", activeTurn: null });
  const idle = { ...ctx.thread, agentStatus: "idle" };
  const drained = await ctx.sup.drainQueuedOwnerMessages({ byKey: new Map([[idle.key, idle]]), started: NOW + 60_000 });
  assert.equal(drained[0].status, "sent");
  assert.equal(ctx.sent.length, 1);
  assert.match(ctx.sent[0].text, /Owner answer: yes, write spec\./);
  assert.equal(openQuestion(ctx).status, "answered");
});

test("(b) a send that times out before its turn is confirmed: ambiguous, the card stays open saying so, and a second tap sends nothing", async (t) => {
  // Paseo takes the message and never confirms a turn; the request times out.
  const ctx = setup(t, { paseo: { timeoutMs: 1500 }, ref: { refetch: async (_options, { current }) => ({ agent: current, entries: [] }) } });
  const res = await answerViaQuestions(ctx);
  assert.equal(res.status, 200, "a result, not the catch-all");
  assert.equal(res.body.delivery.outcome, "ambiguous");
  assert.equal(res.body.delivery.unconfirmed, true);
  assert.equal(ctx.sent.length, 1);
  const q = openQuestion(ctx);
  assert.equal(q.status, "open");
  assert.match(q.deliveryNote, /may have reached the agent.*not sent again automatically; check the chat/i);
  const card = buildSupervisorCard(q, { now: NOW });
  assert.match(card.summary, /^Your answer "yes, write spec" may have reached the agent/);
  // The owner taps again: the earlier send's own receipt decides, never a resend.
  const again = await answerViaCard(ctx);
  assert.equal(again.status, 200);
  assert.equal(again.body.result.outcome, "ambiguous");
  assert.match(again.body.result.delivery.detail, /not sent again so it cannot arrive twice/);
  assert.equal(ctx.sent.length, 1, "sent exactly once");
});

test("(b) a send Paseo accepted that returns without turn confirmation: ambiguous, never re-sent", async (t) => {
  const ctx = setup(t, {
    ref: {
      send: async () => ({ turnId: "turn-a" }),
      // Its own message is in the timeline, but on another turn: no confirmation.
      refetch: async (_options, { sent, current }) => ({ agent: current, entries: sent.length ? [{ item: { type: "user_message", messageId: sent.at(-1).options.messageId }, turnId: "turn-b", seqEnd: 1 }] : [] })
    }
  });
  const res = await answerViaCard(ctx);
  assert.equal(res.body.result.outcome, "ambiguous");
  assert.equal(res.body.result.ok, false);
  assert.equal(openQuestion(ctx).status, "open");
  await answerViaQuestions(ctx);
  assert.equal(ctx.sent.length, 1, "the second answer was not sent");
});

test("(c) an archived chat: refused with the reason, nothing sent, the card stays open with it", async (t) => {
  const ctx = setup(t, { agent: { archivedAt: "2026-11-27T13:50:00Z" } });
  const res = await answerViaCard(ctx);
  assert.equal(res.status, 200);
  assert.equal(res.body.result.outcome, "refused");
  assert.match(res.body.result.detail, /archived/);
  assert.equal(ctx.sent.length, 0);
  const q = openQuestion(ctx);
  assert.equal(q.status, "open");
  assert.match(q.deliveryNote, /^Your answer "yes, write spec" was not sent: .*archived/);
});

test("(c) a chat archived since the scan: refused with Paseo's reason", async (t) => {
  const ctx = setup(t, { live: { archivedAt: "2026-11-27T13:59:00Z" } });
  const res = await answerViaQuestions(ctx);
  assert.equal(res.status, 200);
  assert.equal(res.body.delivery.outcome, "refused");
  assert.match(res.body.delivery.detail, /closed, or unavailable/);
  assert.equal(ctx.sent.length, 0);
  assert.equal(openQuestion(ctx).status, "open");
});

test("(d) a Paseo client that throws out of the delivery: a structured ambiguous result, not 'Fleet supervisor error'", async (t) => {
  let calls = 0;
  const ctx = setup(t, { paseoDelivery: async () => { calls += 1; throw new Error("socket hang up"); } });
  for (const answer of [answerViaQuestions, answerViaCard]) {
    const res = await answer(ctx);
    assert.equal(res.status, 200, `${answer.name}: ${JSON.stringify(res.body.error ?? "")}`);
    const delivery = res.body.delivery ?? res.body.result.delivery;
    assert.equal(delivery.outcome, "ambiguous");
    assert.match(delivery.detail, /socket hang up.*may have reached the agent/);
    assert.ok(delivery.actionId, "the failure leaves a receipt");
  }
  assert.equal(calls, 2, "each tap is one attempt; nothing retries on its own");
  const q = openQuestion(ctx);
  assert.equal(q.status, "open");
  assert.match(q.deliveryNote, /may have reached the agent/);
  assert.ok(ctx.sup.getState().actions.some((a) => a.questionId === ctx.question.id && a.playbook === "owner-answer"));
});

test("(d) a Paseo client that throws before anything is sent: refused", async (t) => {
  const ctx = setup(t, { paseoDelivery: (args) => deliverPaseo({ ...args, factory: () => { throw new Error("no Paseo client"); } }) });
  const res = await answerViaCard(ctx);
  assert.equal(res.body.result.outcome, "refused");
  assert.match(res.body.result.detail, /no Paseo client/);
  assert.equal(openQuestion(ctx).status, "open");
});

// The main reaches the fleet computer over the node broker
// (RemoteFleetSupervisor). Its answer path rethrew every failure there, so
// any of them reached the main's catch-all.
function remoteSetup(t, ctx, { dispatch = null } = {}) {
  const capability = createFleetCapability(ctx.sup);
  let calls = 0;
  const runtime = { nodeCapabilities: { dispatch: async (...args) => { calls += 1; return dispatch ? dispatch(args, capability) : capability.invoke(args[2], args[3]); } } };
  const remote = new RemoteFleetSupervisor({ runtime, nodeId: "mac-node" });
  const route = createFleetRoute({ supervisor: remote });
  const post = (p, body) => route("POST", p, new URL(`http://localhost${p}`), async () => body, {});
  return { remote, route, post, calls: () => calls };
}

test("main: a card the fleet computer already closed (closed stale) is refused with that reason, not 'Fleet supervisor error'", async (t) => {
  const ctx = setup(t);
  const main = remoteSetup(t, ctx);
  await main.remote.refresh();
  assert.ok(main.remote.getState().questions.some((q) => q.id === ctx.question.id), "the main shows the card");
  // Meanwhile the computer's own review closes that copy.
  ctx.sup.store.resolveQuestion(ctx.question.id, "closed stale");
  const res = await main.post(`/fleet/api/questions/${ctx.question.id}`, { answer: ANSWER });
  assert.equal(res.status, 200, JSON.stringify(res.body.error ?? ""));
  assert.equal(res.body.delivery.outcome, "refused");
  assert.match(res.body.delivery.detail, /no longer has this question open/);
  assert.equal(ctx.sent.length, 0);
});

test("main: an answer the fleet computer took but never answered for is ambiguous and is not sent again", async (t) => {
  const ctx = setup(t);
  const main = remoteSetup(t, ctx, {
    dispatch: async (args, capability) => {
      if (args[3]?.method === "POST") throw Object.assign(new Error("command timed out"), { nodeAcknowledged: true });
      return capability.invoke(args[2], args[3]);
    }
  });
  await main.remote.refresh();
  const before = main.calls();
  const res = await main.post(`/fleet/api/cards/${ctx.question.id}/act`, { op: "answer", value: ANSWER });
  assert.equal(res.status, 200, JSON.stringify(res.body.error ?? ""));
  assert.equal(res.body.result.outcome, "ambiguous");
  assert.match(res.body.result.detail, /Not sent again so it cannot arrive twice/);
  assert.equal(main.calls() - before, 1, "one attempt, no automatic resend");
  const card = (main.remote.getState().cards ?? []).find((c) => c.questionId === ctx.question.id);
  assert.match(card?.deliveryNote ?? "", /may have reached the agent/);
});

test("main: a fleet computer out of reach refuses the answer (nothing was sent)", async (t) => {
  const ctx = setup(t);
  let online = true;
  const main = remoteSetup(t, ctx, {
    dispatch: async (args, capability) => {
      if (!online) throw new Error("node offline");
      return capability.invoke(args[2], args[3]);
    }
  });
  await main.remote.refresh();
  online = false;
  const res = await main.post(`/fleet/api/questions/${ctx.question.id}`, { answer: ANSWER });
  assert.equal(res.status, 200, JSON.stringify(res.body.error ?? ""));
  assert.equal(res.body.delivery.outcome, "refused");
  assert.match(res.body.delivery.detail, /Fleet computer unavailable/);
  assert.match(main.remote.getState().questions.find((q) => q.id === ctx.question.id)?.deliveryNote ?? "", /was not sent/);
});

test("main: a delivered answer passes through with its outcome", async (t) => {
  const ctx = setup(t);
  const main = remoteSetup(t, ctx);
  await main.remote.refresh();
  const res = await main.post(`/fleet/api/questions/${ctx.question.id}`, { answer: ANSWER });
  assert.equal(res.status, 200);
  assert.equal(res.body.delivery.outcome, "delivered");
  assert.equal(ctx.sent.length, 1);
});
