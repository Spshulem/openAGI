// One agent ask that carries several independent questions is shown as those
// questions and answered one at a time, partial answers allowed. Synthetic
// fixture modelled on a release card that offered only "Answer all questions"
// / "Approve recommended choices" and hid ten decisions in the thread.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSupervisorCard } from "../src/fleet/cards.js";
import { resolveFleetConfig } from "../src/fleet/contracts.js";
import { composeItemsReply, extractQuestionItems, GROUP_OPTION_RE } from "../src/fleet/decision-items.js";
import { FleetSupervisor } from "../src/fleet/supervisor.js";

const NOW = Date.parse("2026-11-27T18:00:00Z");
const ASK = [
  "Nothing has merged yet. Original questions, unchanged:",
  "1. **Reviewers:** who approves #101 and #102/#103?",
  "2. **Certificates:** which clean host produces them? It should run uncached.",
  "3. **Canvas pages:** should a Canvas's pages be pages inside one document, or separate documents? The owner recommends separate documents.",
  "4. **Canvas closed-memory:** is it acceptable to drop the per-browser closed memory?",
  "5. **Canvas E2E:** a synthetic staging account and a clean preview for the browser test.",
  "6. **Mac preflight:** run the signing preflight once in your Mac's GUI session, or name another approved host.",
  "7. **Channel watches:** should pausing alerts and enabling autonomous turns require approval? The audit owner recommends yes for both.",
  "8. **#104 native-history bug:** the audit owner rates it a blocker for the next native build, not for web. Should they open the fix PR?",
  "9. **#105 owner:** restart it, or move it to another model.",
  "10. **Store scope:** is the whole shared store suspect, or only Vite?"
].join("\n");

function groupedQuestion(extra = {}) {
  return {
    id: "fq_release", kind: "agent-ask", status: "open",
    threadKey: "paseo:srv_test.release-coordinator",
    prRef: "example/app#7913",
    title: "example #7913: resolve release decisions",
    body: "…7. Channel watches: should pausing alerts and enabling autonomous turns require approval? …",
    options: ["Answer all questions", "Approve recommended choices", "open thread"],
    askContext: ASK,
    reviewedAt: "2026-11-27T17:00:00Z",
    reviewBrief: {
      context: "Coordinate and ship the scoped release.",
      decision: "Answer the ten unresolved release questions or approve the audit owner's recommended choices.",
      recommendation: "Recommend: Approve the audit owner's recommended choices where stated, then answer the rest in the thread.",
      suggestedReplies: ["Approve requiring approval for channel-watch changes; open the #104 fix PR.", "Approve recommended choices"]
    },
    contextSnapshot: {
      threadTitle: "Release coordinator",
      agentSummary: ASK,
      recentMessages: [{ role: "user", text: "Ship the scoped release" }, { role: "assistant", text: ASK }]
    },
    ...extra
  };
}

test("the grouped release card shows each question with its choices, recommendation and what it unblocks", () => {
  const card = buildSupervisorCard(groupedQuestion(), { now: NOW });
  const items = card.questionItems;
  assert.equal(items.length, 10);
  assert.deepEqual(items.map((i) => i.index), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(items[0].label, "Reviewers");
  assert.match(items[0].question, /who approves #101/);
  assert.deepEqual(items[2].choices, ["Pages inside one document", "Separate documents"]);
  assert.match(items[2].recommendation, /recommends separate documents/);
  assert.deepEqual(items[6].choices, ["Yes", "No"]);
  assert.match(items[6].recommendation, /recommends yes for both/);
  assert.match(items[7].unblocks, /blocker for the next native build/);
  assert.deepEqual(items[8].choices, ["Restart it", "Move it to another model"]);
  assert.ok(items.every((i) => i.freeText === true && i.state.status === "unanswered"));
  assert.equal(card.questionItemsSummary.open, 10);

  // "Review 10 questions" starts a walkthrough; no canned group answer anywhere.
  assert.equal(card.primaryAction.op, "review_items");
  assert.equal(card.primaryAction.label, "Review 10 questions");
  const actions = [card.primaryAction, card.secondaryAction, ...card.extraActions].filter(Boolean);
  assert.ok(actions.every((a) => !GROUP_OPTION_RE.test(a.label) && a.op !== "answer"), JSON.stringify(actions));
  assert.ok(card.options.every((o) => !GROUP_OPTION_RE.test(o)));
  assert.deepEqual(card.suggestedReplies, []);
  assert.deepEqual(card.decisionView.decision.options, []);
  assert.equal(card.decisionView.recommendation.option, null);
  assert.doesNotMatch(card.decisionView.recommendation.why, /approve the audit owner/i);
  assert.equal(card.decisionAction.op, "review_items");
});

test("a single-question card keeps its own answer actions and has no walkthrough", () => {
  const card = buildSupervisorCard({
    id: "fq_single", kind: "agent-ask", status: "open", threadKey: "paseo:s.single",
    title: "Deploy or hold?", options: ["deploy", "hold"],
    contextSnapshot: { recentMessages: [{ role: "user", text: "Ship the fix" }, { role: "assistant", text: "CI is green. Deploy or hold?" }] }
  }, { now: NOW });
  assert.equal(card.questionItems, undefined);
  assert.equal(card.primaryAction.op, "answer");
  assert.deepEqual(card.options, ["deploy", "hold"]);
});

test("a completed acknowledgment is an update, not an owner ask", () => {
  const card = buildSupervisorCard({
    id: "fq_done", kind: "completed", status: "open", threadKey: "paseo:s.done",
    title: "Release notes: finished", options: ["Got it"], askContext: ASK,
    contextSnapshot: { recentMessages: [{ role: "assistant", text: ASK }] }
  }, { now: NOW });
  assert.equal(card.askType, "fyi");
  assert.equal(card.questionItems, undefined);
});

test("only plain answers are composed: group answers are dropped, skipped questions named, no approval implied", () => {
  const items = extractQuestionItems(ASK);
  const out = composeItemsReply(items, {
    answers: [
      { itemId: items[2].itemId, answer: "Separate documents" },
      { itemId: items[6].itemId, answer: "Approve recommended choices" }
    ],
    skipped: [items[0].itemId]
  });
  assert.match(out.text, /3\. Canvas pages: Separate documents/);
  assert.doesNotMatch(out.text, /Approve recommended choices/);
  assert.match(out.text, /Not answered yet \(still open.*\): 1 Reviewers/);
  assert.match(out.text, /do not approve any merge, deploy, permission/);
  assert.deepEqual(out.answered, [items[2].itemId]);
});

test("walkthrough answers: partial send, skip, resume, failed delivery kept, closes only when all are delivered", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "items-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sup = new FleetSupervisor({ dataDir: dir, config: resolveFleetConfig({}, { enabled: true, mode: "propose" }), deps: { now: () => NOW } });
  const sent = [];
  let delivery = "sent";
  sup.sendOwnerMessage = async (threadKey, text) => { sent.push({ threadKey, text }); return { delivery: { status: delivery, detail: delivery === "failed" ? "host offline" : null } }; };
  let precedents = 0;
  const memory = sup.precedentMemory;
  const record = memory.recordOwnerDecision.bind(memory);
  memory.recordOwnerDecision = (...args) => { precedents += 1; return record(...args); };
  const q = sup.store.upsertQuestion({ dedupeKey: "ask:release", ...groupedQuestion(), id: undefined });
  const cardOf = () => sup.getState().cards.find((c) => c.questionId === q.id);
  const items = cardOf().questionItems;
  assert.equal(items.length, 10);

  // "Review 10 questions" opens the walkthrough; nothing is sent.
  const review = await sup.actCard(q.id, { op: "primary" });
  assert.equal(review.kind, "review_items");
  assert.equal(sent.length, 0);

  // A blanket answer is refused and never sent.
  const blanket = await sup.actCard(q.id, { op: "answer", value: "Approve recommended choices" });
  assert.equal(blanket.ok, false);
  assert.equal(sent.length, 0);

  // Two answers and one skip: one plain reply, the rest stay open.
  const first = await sup.actCard(q.id, { op: "answer_items", items: [
    { itemId: items[2].itemId, answer: "Separate documents" },
    { itemId: items[8].itemId, answer: "Restart it" }
  ], skip: [items[0].itemId] });
  assert.equal(first.ok, true);
  assert.equal(first.status, "delivered");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /3\. Canvas pages: Separate documents\n9\. #105 owner: Restart it/);
  assert.equal(sup.store.question(q.id).status, "open", "partial answers keep the card open");
  const resumed = cardOf();
  const byId = Object.fromEntries(resumed.questionItems.map((i) => [i.itemId, i.state]));
  assert.equal(byId[items[2].itemId].status, "delivered");
  assert.equal(byId[items[2].itemId].answer, "Separate documents");
  assert.equal(byId[items[0].itemId].status, "skipped");
  assert.equal(resumed.questionItemsSummary.open, 8);
  assert.equal(resumed.primaryAction.label, "Review 8 questions");

  // A failed delivery keeps the answer to retry, marked failed.
  delivery = "failed";
  const failed = await sup.actCard(q.id, { op: "answer_items", items: [{ itemId: items[3].itemId, answer: "Yes" }] });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, "failed");
  const afterFail = Object.fromEntries(cardOf().questionItems.map((i) => [i.itemId, i.state]));
  assert.equal(afterFail[items[3].itemId].status, "failed");
  assert.equal(afterFail[items[3].itemId].answer, "Yes");

  // Answering every remaining question closes it.
  delivery = "sent";
  const rest = cardOf().questionItems.filter((i) => i.state.status !== "delivered").map((i) => ({ itemId: i.itemId, answer: i.choices[0] ?? "Use the default" }));
  const last = await sup.actCard(q.id, { op: "answer_items", items: rest });
  assert.equal(last.ok, true);
  assert.equal(sup.store.question(q.id).status, "answered");
  assert.equal(precedents, 0, "item answers never become owner precedents");
  assert.ok(sent.every((m) => /do not approve any merge, deploy, permission/.test(m.text)));
  assert.ok(sent.every((m) => !/Approve recommended choices/i.test(m.text)));
});

test("the agent's own headline decision leads the questions and is never hidden", () => {
  const withContext = [
    "DECISION CONTEXT",
    "Goal: Ship the scoped release.",
    "Assigned: Coordinate the owners and cut the release.",
    "Verified: Nothing has merged.",
    "Blocked: The certificate host must be one the owner accepts as clean.",
    "Decision: Should the build box count again as clean infrastructure?",
    "Options:",
    "- Accept it as clean — owners rerun certificates there",
    "- Keep it excluded — name another clean host",
    "Recommendation: Rule on the build box explicitly.",
    "",
    "Original questions, unchanged:",
    ASK.split("\n").slice(1).join("\n")
  ].join("\n");
  const card = buildSupervisorCard(groupedQuestion({ askContext: withContext, contextSnapshot: { agentSummary: withContext, recentMessages: [{ role: "user", text: "Ship it" }, { role: "assistant", text: withContext }] } }), { now: NOW });
  const [main, ...rest] = card.questionItems;
  assert.equal(main.label, "Main decision");
  assert.match(main.question, /count again as clean infrastructure/);
  assert.deepEqual(main.choices, ["Accept it as clean", "Keep it excluded"]);
  assert.equal(main.recommendation, "Rule on the build box explicitly.");
  assert.equal(rest.length, 10);
  assert.equal(card.primaryAction.label, "Review 11 questions");
});

// PR #394 review findings.
async function itemsSupervisor(t, { delivery = "sent" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "items-rev-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sup = new FleetSupervisor({ dataDir: dir, config: resolveFleetConfig({}, { enabled: true, mode: "propose" }), deps: { now: () => NOW } });
  const sent = [];
  const box = { delivery };
  sup.sendOwnerMessage = async (threadKey, text, opts) => { sent.push({ threadKey, text, opts }); return { delivery: { status: box.delivery } }; };
  const q = sup.store.upsertQuestion({ dedupeKey: "ask:release", ...groupedQuestion(), id: undefined, meta: { hasPlanArtifact: true } });
  const items = () => sup.getState().cards.find((c) => c.questionId === q.id).questionItems;
  return { dir, sup, sent, box, q, items };
}

test("review: queued item answers settle on real delivery and never close the card early", async (t) => {
  const { sup, sent, box, q, items } = await itemsSupervisor(t, { delivery: "queued" });
  const all = items();
  const res = await sup.actCard(q.id, { op: "answer_items", items: all.map((i) => ({ itemId: i.itemId, answer: i.choices[0] ?? "ok" })) });
  assert.equal(res.status, "queued");
  assert.deepEqual(sent[0].opts.questionItemIds.length, 10, "the queued message is linked to its items");
  assert.equal(sup.store.question(q.id).status, "open", "queued is not delivered: the card stays");
  // The queue fails the message: items fail, answers kept.
  sup.settleQuestionItems({ questionId: q.id, itemIds: all.slice(0, 3).map((i) => i.itemId) }, "failed", "never sent");
  const failed = items().slice(0, 3);
  assert.ok(failed.every((i) => i.state.status === "failed" && i.state.answer));
  // The rest are sent from the queue: delivered, and the card still waits on the failed ones.
  sup.settleQuestionItems({ questionId: q.id, itemIds: all.slice(3).map((i) => i.itemId) }, "delivered");
  assert.equal(sup.store.question(q.id).status, "open");
  box.delivery = "sent";
  await sup.actCard(q.id, { op: "answer_items", items: failed.map((i) => ({ itemId: i.itemId, answer: i.state.answer })) });
  assert.equal(sup.store.question(q.id).status, "answered", "closes once every item is delivered");
  // The store keeps the item linkage on a queued entry.
  const entry = sup.store.enqueueOwnerMessage({ threadKey: "paseo:s.x", message: "hi", questionId: q.id, questionItemIds: ["q1-a"] });
  assert.deepEqual(entry.questionLinks[0].itemIds, ["q1-a"]);
});

test("review: a closed multi-question reply is never backfilled as an owner precedent", async (t) => {
  const { dir, sup, q, items } = await itemsSupervisor(t);
  await sup.actCard(q.id, { op: "answer_items", items: items().map((i) => ({ itemId: i.itemId, answer: i.choices[0] ?? "ok" })) });
  assert.equal(sup.store.question(q.id).status, "answered");
  assert.equal(sup.store.question(q.id).noPrecedent, true);
  const fresh = new FleetSupervisor({ dataDir: dir, config: resolveFleetConfig({}, { enabled: true, mode: "propose" }), deps: { now: () => NOW } });
  const memory = fresh.precedentMemory;
  const dump = JSON.stringify(typeof memory.list === "function" ? memory.list() : memory);
  assert.doesNotMatch(dump, /Answers to your questions/);
});

test("review: delivered or queued items can't be re-answered or skipped by a stale device", async (t) => {
  const { sup, sent, q, items } = await itemsSupervisor(t);
  const [a, b] = items();
  await sup.actCard(q.id, { op: "answer_items", items: [{ itemId: a.itemId, answer: "first" }] });
  const stale = await sup.actCard(q.id, { op: "answer_items", items: [{ itemId: a.itemId, answer: "second" }], skip: [a.itemId] });
  assert.equal(stale.ok, false, "nothing left to send");
  assert.equal(sent.length, 1);
  const after = items().find((i) => i.itemId === a.itemId);
  assert.equal(after.state.status, "delivered");
  assert.equal(after.state.answer, "first");
  assert.equal(items().find((i) => i.itemId === b.itemId).state.status, "unanswered");
});

test("review: a rescan keeps the owner's item answers", async (t) => {
  const { sup, q, items } = await itemsSupervisor(t, { delivery: "failed" });
  const [a] = items();
  await sup.actCard(q.id, { op: "answer_items", items: [{ itemId: a.itemId, answer: "keep me" }] });
  sup.store.upsertQuestion({ dedupeKey: "ask:release", ...groupedQuestion(), id: undefined, meta: { hasPlanArtifact: true, wall: "x" } });
  const again = items().find((i) => i.itemId === a.itemId);
  assert.equal(again.state.status, "failed");
  assert.equal(again.state.answer, "keep me");
});

test("review: no surface can send a blanket answer", async (t) => {
  const { sup, sent, q } = await itemsSupervisor(t);
  const res = await sup.answerQuestion(q.id, "Approve recommended choices");
  assert.equal(res, null);
  assert.equal(sent.length, 0);
  assert.equal(sup.store.question(q.id).status, "open");
});
