// #347 review: check-in dedupe must not hide genuinely new decisions, drop
// decisions it marks surfaced, or treat a local fallback as hub delivery.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeNodeConfig } from "../src/cli-client.js";
import { FleetStore, actionableDecisionMaterialHash } from "../src/fleet/store.js";
import { FleetSupervisor } from "../src/fleet/supervisor.js";

const NOW = Date.parse("2026-11-22T18:00:00.000Z");
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "checkin-rev-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

function chatRuntime() {
  const msgs = [];
  const store = {
    sessions: new Map(),
    getSession(id) { return this.sessions.get(id) ?? null; },
    appendMessage(id, m) { const s = this.sessions.get(id) ?? { id, messages: [] }; this.sessions.set(id, s); s.messages.push({ id: m.id, content: m.content ?? m.text }); msgs.push({ ...m, text: m.text ?? m.content }); return s; }
  };
  return { msgs, runtime: { events: { emit() {} }, agentHost: { store } } };
}

test("grouped decisions: a different session's blocker is material, a count change is not", () => {
  const base = { kind: "deliver", dedupeKey: "deliver:group", threadKey: null, options: ["done", "skip"] };
  const a = actionableDecisionMaterialHash({ ...base, title: "1 stopped. Nudge it?", threadKeys: ["paseo:s.a"] });
  const b = actionableDecisionMaterialHash({ ...base, title: "1 stopped. Nudge it?", threadKeys: ["paseo:s.b"] });
  const aAgain = actionableDecisionMaterialHash({ ...base, title: "1 stopped. Nudge it?", threadKeys: ["paseo:s.a"], body: "Sends keep failing: a (2 tries)" });
  assert.notEqual(a, b);
  assert.equal(a, aAgain);
});

test("a requested duration is material; wait-time churn is not", () => {
  const q = (title) => actionableDecisionMaterialHash({ kind: "agent-ask", threadKey: "paseo:s.x", title, options: ["approve", "deny"] });
  assert.notEqual(q("Approve taking production offline for 5 minutes?"), q("Approve taking production offline for 60 minutes?"));
  assert.equal(q("Still waiting 5 min on review. Approve?"), q("Still waiting 7 min on review. Approve?"));
});

test("legacy upgrade seeds only questions with evidence of delivery", (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({
    version: 1,
    questions: [
      { id: "fq_delivered01", dedupeKey: "k1", kind: "agent-ask", threadKey: "paseo:s.a", title: "Ship it?", options: ["yes", "no"], status: "open", createdAt: "2026-11-22T17:00:00.000Z", outreachId: "out_1" },
      { id: "fq_neverseen01", dedupeKey: "k2", kind: "agent-ask", threadKey: "paseo:s.b", title: "Rotate key?", options: ["yes", "no"], status: "open", createdAt: "2026-11-22T17:30:00.000Z" }
    ],
    supervisorChatNotices: { "ftw:paseo:s.z:abc": { at: "2026-11-22T17:10:00.000Z", summary: "unrelated follow-through report" } }
  }));
  const store = new FleetStore({ dir, now: () => NOW });
  const { deltas } = store.diffSurfacedDecisions(store.openQuestions(), { now: NOW });
  assert.deepEqual(deltas.map((d) => d.question.id), ["fq_neverseen01"]);
});

test("a recurring report gets a new message id after its cooldown instead of being silently dropped", async (t) => {
  const dir = tmp(t);
  let nowMs = NOW;
  const { msgs, runtime } = chatRuntime();
  const sup = new FleetSupervisor({ dataDir: dir, runtime, config: { enabled: false, mode: "auto" }, deps: { now: () => nowMs } });
  const first = await sup.postSupervisorChatUpdate("Session X is blocked again.", { dedupeKey: "ftw:paseo:s.x:h1", minGapMs: 10 * 60_000 });
  nowMs += 11 * 60_000;
  const second = await sup.postSupervisorChatUpdate("Session X is blocked again.", { dedupeKey: "ftw:paseo:s.x:h1", minGapMs: 10 * 60_000 });
  assert.equal(first.posted, true);
  assert.equal(second.posted, true);
  assert.notEqual(first.messageId, second.messageId);
  assert.equal(msgs.length, 2, "both occurrences reach the chat");
});

test("check-in shows only what fits and marks only shown decisions surfaced", async (t) => {
  const dir = tmp(t);
  const { msgs, runtime } = chatRuntime();
  const sup = new FleetSupervisor({ dataDir: dir, runtime, config: { enabled: true, mode: "auto", proactiveSupervisorChat: true }, deps: { now: () => NOW } });
  const long = "detail ".repeat(140);
  for (let i = 0; i < 5; i += 1) {
    const reply = `DECISION CONTEXT\nGoal: Goal ${i} ${long}\nAssigned: Task ${i} ${long}\nVerified: Checked ${i} ${long}\nBlocked: Needs owner ${i} ${long}\nDecision: Pick ${i}?\nOptions:\n- go — ships ${long}\n- hold — waits\nRecommendation: go`;
    sup.store.upsertQuestion({
      dedupeKey: `ask:${i}`, kind: "agent-ask", threadKey: `paseo:s.${i}`, title: `Decision ${i}: pick a path`, body: `Pick ${i}?`, options: ["go", "hold"],
      contextSnapshot: { threadTitle: `Workstream ${i}`, recentMessages: [{ role: "user", text: `Please handle workstream ${i} end to end` }, { role: "assistant", text: reply }], agentSummary: reply }
    });
  }
  const res = await sup.maybePostProactiveSupervisorDigest({ started: NOW });
  assert.equal(res.posted, true);
  const text = msgs[0].text;
  assert.ok(text.length <= 6000, `fits (${text.length})`);
  const shown = (text.match(/\*\*New: Workstream \d/g) ?? []).length;
  assert.ok(shown >= 1 && shown < 5, `some decisions deferred (${shown} shown)`);
  assert.match(text, /\*\*New: Workstream \d/, "the first rendered decision is intact");
  const { deltas } = sup.store.diffSurfacedDecisions(sup.store.openQuestions(), { now: NOW });
  assert.equal(deltas.length, 5 - shown, "deferred decisions stay pending for the next check-in");
});

test("on a paired node, a hub failure keeps decisions pending and the hub is retried", async (t) => {
  const dir = tmp(t);
  writeNodeConfig({ remote: "http://100.64.0.9:43210", token: null, nodeToken: "n", ownerProxyToken: "p", nodeEnrollmentConfirmed: true }, dir);
  let nowMs = NOW;
  let hubUp = false;
  const hubCalls = [];
  const { runtime } = chatRuntime();
  const sup = new FleetSupervisor({
    dataDir: dir, runtime,
    config: { enabled: true, mode: "auto", proactiveSupervisorChat: true },
    deps: { now: () => nowMs, supervisorChatFetch: async (url) => { hubCalls.push(url); return { ok: hubUp, status: hubUp ? 200 : 503 }; } }
  });
  sup.store.upsertQuestion({ dedupeKey: "ask:hub", kind: "agent-ask", threadKey: "paseo:s.h", title: "Publish the release notes?", options: ["publish", "hold"] });
  const first = await sup.maybePostProactiveSupervisorDigest({ started: nowMs });
  assert.equal(first.deliveredRemote, false);
  assert.equal(sup.store.diffSurfacedDecisions(sup.store.openQuestions(), { now: nowMs }).deltas.length, 1, "still pending after a local-only fallback");
  hubUp = true;
  nowMs += 3 * 3_600_000;
  const second = await sup.maybePostProactiveSupervisorDigest({ started: nowMs });
  assert.equal(second.deliveredRemote, true);
  assert.equal(hubCalls.length, 2, "the hub was retried");
  assert.equal(sup.store.diffSurfacedDecisions(sup.store.openQuestions(), { now: nowMs }).deltas.length, 0);
});

test("a reworded merge ask at the same head is not a new decision; a new head is", () => {
  const base = { kind: "agent-ask", mergeAsk: true, prRef: "acme/app#10346", threadKey: "paseo:s.m", options: ["merge", "run mac tests"] };
  const a = actionableDecisionMaterialHash({ ...base, askedHead: "328aeec", title: "#10346: run Mac tests or merge?", body: "CI failing on main-health." });
  const reworded = actionableDecisionMaterialHash({ ...base, askedHead: "328aeec", title: "buildbetter #10346 awaiting merge confirmation", body: "BuildBot3 passed; Mac Swift tests unrun." });
  const newHead = actionableDecisionMaterialHash({ ...base, askedHead: "9f00d1e", title: "#10346: run Mac tests or merge?", body: "CI failing on main-health." });
  assert.equal(a, reworded);
  assert.notEqual(a, newHead);
});
