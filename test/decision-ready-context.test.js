// Decision-ready context on every owner ask: Needs You cards, outreach/phone
// notifications, scheduled Supervisor check-ins, and Active Work follow-ups all
// carry (1) the goal and what the item is, (2) the assignment, (3) verified /
// changed / blocked and why, (4) the decision, options with consequences, and
// the recommendation. Recovered from evidence only; gaps are requested from the
// owning agent before a new ask surfaces.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildSupervisorCard } from "../src/fleet/cards.js";
import { resolveFleetConfig } from "../src/fleet/contracts.js";
import {
  buildDecisionContext,
  classifyAsk,
  decisionContextFromQuestion,
  parseAgentSuppliedContext,
  renderDecisionContext,
  stripInternalIds
} from "../src/fleet/decision-context.js";
import { createNotifier } from "../src/fleet/notify.js";
import { FleetStore } from "../src/fleet/store.js";
import { FleetSupervisor } from "../src/fleet/supervisor.js";

const INTERNAL_ID_RE = /\b(?:fq|ftw|tw|out)_[0-9a-z]{4,}\b|paseo:srv_|\bsess_[a-z]/i;

function tempDir(t, prefix = "openagi-decision-context-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeOutreach() {
  const items = new Map();
  let seq = 0;
  const calls = { append: 0, update: 0 };
  return {
    calls,
    items,
    seed(item) { items.set(item.id, { status: "unseen", ...item }); return items.get(item.id); },
    append(spec) {
      if (spec.dedupeOpen && spec.sourceRef?.id) {
        const open = [...items.values()].find((i) => ["unseen", "seen"].includes(i.status) && i.sourceRef?.kind === spec.sourceRef.kind && i.sourceRef?.id === spec.sourceRef.id);
        if (open) return open;
      }
      calls.append += 1;
      const item = { id: `out_new_${++seq}`, status: "unseen", ...spec };
      items.set(item.id, item);
      return item;
    },
    update(id, patch) { calls.update += 1; Object.assign(items.get(id) ?? {}, patch); return items.get(id); },
    get(id) { return items.get(id) ?? null; },
    reopen() {}
  };
}

// An old, already-pushed ask whose stored wording was context-poor: an internal
// id in the title and a bare "Answer?" body. Its source chat and PR say more.
const OLD_ASKED_AT = "2026-11-21T22:00:00.000Z";
const NOW = Date.parse("2026-11-22T18:00:00.000Z");
const oldUnansweredQuestion = {
  id: "fq_0ld0000000000001",
  dedupeKey: "ask:paseo:srv_local.sess_recorder:license",
  kind: "agent-ask",
  threadKey: "paseo:srv_local.sess_recorder",
  prRef: "Spshulem/bb-recorder#88",
  title: "fq_0ld0000000000001 · sess_recorder: needs your call. Answer?",
  body: "Answer?",
  options: ["rotate key", "hold"],
  status: "open",
  createdAt: OLD_ASKED_AT,
  updatedAt: OLD_ASKED_AT,
  outreachId: "out_old_1",
  pushedAt: OLD_ASKED_AT,
  contextSnapshot: {
    threadTitle: "bb-recorder TestFlight upload",
    repo: "Spshulem/bb-recorder",
    agentSummary: "Built and signed the macOS app; notarization verified locally. The TestFlight upload is blocked: the App Store Connect API key expired and rotating it needs owner approval. Rotate the key, or hold?",
    recentMessages: [
      { role: "user", text: "Get the bb-recorder macOS build onto TestFlight before Friday's customer demo.", at: "2026-11-21T19:00:00.000Z" },
      { role: "user", text: "continue", at: "2026-11-21T20:00:00.000Z" },
      { role: "assistant", text: "Built and signed the macOS app; notarization verified locally. The TestFlight upload is blocked: the App Store Connect API key expired and rotating it needs owner approval. Rotate the key, or hold?", at: "2026-11-21T21:59:00.000Z" }
    ],
    pr: { ref: "Spshulem/bb-recorder#88", url: "https://github.com/Spshulem/bb-recorder/pull/88", title: "Release pipeline: notarize and upload macOS build", state: "OPEN", ciState: "SUCCESS", additions: 120, deletions: 14 }
  }
};

test("an old unanswered question is reworked in place with recovered context, without a new ping", async (t) => {
  const home = tempDir(t);
  const fleetDir = path.join(home, "fleet");
  fs.mkdirSync(fleetDir, { recursive: true });
  fs.writeFileSync(path.join(fleetDir, "state.json"), JSON.stringify({ version: 1, mode: "auto", questions: [oldUnansweredQuestion] }), { mode: 0o600 });
  const store = new FleetStore({ dir: fleetDir, now: () => NOW });
  const question = store.question(oldUnansweredQuestion.id);
  assert.ok(question, "the old question is still open");

  // Needs You card.
  const card = buildSupervisorCard(question, { now: NOW });
  const ctx = card.decisionContext;
  assert.equal(card.askType, "decision");
  assert.equal(card.contextStatus, "complete", `missing: ${ctx.missing.join(", ")}`);
  assert.match(ctx.goal, /TestFlight before Friday's customer demo/);
  assert.match(ctx.verified, /CI is green on PR #88/);
  assert.match(ctx.blocked, /needs owner approval/);
  assert.deepEqual(ctx.options.map((o) => o.label), ["Rotate key", "Hold"]);
  assert.match(ctx.options[1].consequence, /stays open/);
  assert.ok(ctx.sources.some((s) => s.url === "https://github.com/Spshulem/bb-recorder/pull/88"));
  assert.doesNotMatch(ctx.text, INTERNAL_ID_RE, "user-facing context never shows internal ids");
  assert.match(card.brief.whatChanged, /needs owner approval/);
  assert.equal(ctx.decision, "Rotate the key, or hold?", "a generic 'Answer?' is replaced by the agent's own question");
  assert.match(card.brief.decision, /Options:\n- Rotate key/);

  // The outreach copy is reworded in place; it was pushed before, so no push.
  const config = resolveFleetConfig({}, { home, push: "buzzkit" });
  fs.mkdirSync(path.dirname(config.paths.buzzEndpointFile), { recursive: true });
  fs.writeFileSync(config.paths.buzzEndpointFile, "https://ping.buzzkit.dev/device\n", { mode: 0o600 });
  const outreach = fakeOutreach();
  outreach.seed({ id: "out_old_1", type: "fleet-question", sourceRef: { kind: "fleet", id: question.id }, title: question.title, summary: "Answer?" });
  const pushes = [];
  const notifier = createNotifier({
    config,
    store,
    runtime: { outreach },
    now: () => new Date(NOW),
    fetchImpl: async (_url, init) => { pushes.push(JSON.parse(init.body)); return { ok: true, status: 200 }; },
    contextFor: (q) => decisionContextFromQuestion(q)
  });
  const result = await notifier.notifyQuestion(question);
  assert.equal(result.pushed, false);
  assert.equal(result.skipped, "already-pushed");
  assert.equal(pushes.length, 0, "rewording an old ask never re-pushes it");
  assert.equal(outreach.calls.append, 0, "no second outreach copy");
  const copy = outreach.get("out_old_1");
  assert.match(copy.summary, /^1\. Goal: bb-recorder TestFlight upload\. Get the bb-recorder macOS build onto TestFlight/m);
  assert.match(copy.summary, /^2\. You asked the agent to:/m);
  assert.match(copy.summary, /^3\. Where it stands: Verified: CI is green on PR #88\./m);
  assert.match(copy.summary, /^4\. Decision now: .*Options: Rotate key; Hold \(Nothing changes now/m);
  assert.doesNotMatch(`${copy.title}\n${copy.summary}`, INTERNAL_ID_RE);

  // And the check-in ledger treats it as already surfaced: no repeat.
  const diff = store.diffSurfacedDecisions(store.openQuestions(), { now: NOW });
  assert.equal(diff.deltas.length, 0, "an unchanged old ask is not re-announced in a check-in");
});

test("a context-poor new card is held while its owning agent supplies context, then surfaces once", async (t) => {
  const dir = tempDir(t);
  let nowMs = NOW;
  const home = path.join(dir, "home");
  fs.mkdirSync(path.join(home, ".claude", "buzz"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "buzz", "endpoint"), "https://ping.buzzkit.dev/device\n", { mode: 0o600 });
  const pushes = [];
  const delivered = [];
  const chat = [];
  const outreach = fakeOutreach();
  const runtime = {
    outreach,
    events: { emit() {} },
    agentHost: {
      store: {
        sessions: new Map(),
        getSession(id) { return this.sessions.get(id) ?? null; },
        appendMessage(id, msg) {
          const sess = this.sessions.get(id) ?? { id, messages: [] };
          this.sessions.set(id, sess);
          sess.messages.push({ id: msg.id, content: msg.content ?? msg.text ?? "" });
          chat.push(msg.content ?? msg.text ?? "");
          return sess;
        }
      }
    }
  };
  const ask = "**Blocked on:** your go-ahead before I continue.\n- proceed\n- hold";
  const thread = (agentText, conversation) => ({
    key: "paseo:srv_local.sess_poor",
    kind: "paseo",
    id: "sess_poor",
    title: "Billing export cleanup",
    workspace: "billing",
    repo: "Spshulem/billing",
    branch: "spencer/billing-export",
    agentStatus: "idle",
    archived: false,
    excluded: null,
    lastActivityAt: new Date(nowMs - 60_000).toISOString(),
    lastAgentAt: new Date(nowMs - 60_000).toISOString(),
    lastAgentText: agentText,
    lastAgentFull: agentText,
    prRefs: [],
    meta: { serverId: "srv_local", provider: "codex", requiresAttention: true, attentionReason: "finished", historyKnown: true, conversation }
  });
  // Context-poor: no request from Spencer in view, no PR, no tracked goal.
  let threads = [thread(ask, [{ role: "assistant", text: ask, at: new Date(nowMs - 60_000).toISOString() }])];

  const sup = new FleetSupervisor({
    dataDir: dir,
    runtime,
    config: {
      enabled: true,
      mode: "auto",
      proactiveSupervisorChat: true,
      push: "buzzkit",
      paths: { home, buzzEndpointFile: path.join(home, ".claude", "buzz", "endpoint") },
      paseo: { enabled: true, only: true },
      review: { enabled: false }
    },
    deps: {
      now: () => nowMs,
      fetchImpl: async (_url, init) => { pushes.push(JSON.parse(init.body)); return { ok: true, status: 200 }; },
      listPaseoThreads: async () => threads,
      fetchPrStates: async () => new Map(),
      executor: {
        deliver: async (args) => { delivered.push(args); return { status: "sent", route: args.route, detail: "sent", actionId: null }; },
        inFlight: () => [],
        whenIdle: async () => {}
      }
    }
  });

  await sup._tick("timer");
  const open = sup.store.openQuestions().filter((q) => q.threadKey === "paseo:srv_local.sess_poor");
  assert.equal(open.length, 1, "the ask is tracked");
  const held = open[0];
  assert.equal(held.contextRequest?.sent, true, "the owning agent was asked for the missing context");
  // No request from Spencer in view, and "Blocked on: your go-ahead" names no
  // concrete decision: those gaps go to the owning agent, not to Spencer.
  assert.deepEqual(held.contextRequest.missing, ["goal", "assignment", "decision"]);
  const request = delivered.find((d) => d.playbook === "context-request");
  assert.ok(request, "context request delivered to the owning session");
  assert.equal(request.thread.key, "paseo:srv_local.sess_poor");
  assert.match(request.message, /DECISION CONTEXT/);
  assert.match(request.message, /not an approval of anything pending/i);
  assert.equal(pushes.length, 0, "not pushed while held");
  assert.equal(outreach.calls.append, 0, "no outreach copy while held");
  assert.equal(chat.length, 0, "no check-in while held");
  const heldCard = sup.getState().cards.find((c) => c.questionId === held.id);
  assert.equal(heldCard?.contextStatus, "requested");
  assert.equal(heldCard?.needsYou, false, "held out of Needs You until context arrives");

  // A second scan with no reply: no second request, still held.
  nowMs += 60_000;
  await sup._tick("timer");
  assert.equal(delivered.filter((d) => d.playbook === "context-request").length, 1, "one request per set of gaps");
  assert.equal(pushes.length, 0);

  // The owning agent answers with the labeled block, then restates its ask.
  nowMs += 60_000;
  const reply = [
    "DECISION CONTEXT",
    "Goal: Spencer wants the nightly billing export to stop double-counting refunds before month-end close.",
    "Assigned: Fix the refund double-count in the export job and prove it on last month's data.",
    "Verified: Re-ran October's export; refund totals now match Stripe to the cent.",
    "Changed: Export job dedupes refunds by charge id.",
    "Blocked: Shipping it rewrites last month's already-sent CSV, which only Spencer can approve.",
    "Decision: Re-send October's corrected CSV to finance, or only fix going forward?",
    "Options:",
    "- proceed — October's CSV is regenerated and re-sent to finance",
    "- hold — only November onward uses the fix; October stays as sent",
    "Recommendation: proceed, because finance closes on the corrected numbers.",
    "",
    ask
  ].join("\n");
  threads = [thread(reply, [
    { role: "assistant", text: ask, at: new Date(nowMs - 120_000).toISOString() },
    { role: "user", text: "[OpenAGI Supervisor] Before your question goes to Spencer…", at: new Date(nowMs - 90_000).toISOString() },
    { role: "assistant", text: reply, at: new Date(nowMs - 30_000).toISOString() }
  ])];
  await sup._tick("timer");

  const surfaced = sup.store.openQuestions().find((q) => q.threadKey === "paseo:srv_local.sess_poor");
  assert.ok(surfaced, "the ask is still open");
  const card = sup.getState().cards.find((c) => c.questionId === surfaced.id);
  assert.equal(card.contextStatus, "complete");
  assert.notEqual(card.needsYou, false, "now in Needs You");
  assert.equal(card.decisionContext.agentSupplied, true);
  assert.match(card.decisionContext.goal, /double-counting refunds/);
  assert.match(card.decisionContext.options[0].consequence, /regenerated and re-sent/);
  assert.equal(pushes.length, 1, "pushed exactly once, after context arrived");
  assert.match(pushes[0].body, /Re-send October's corrected CSV/);
  assert.equal(chat.length, 1, "one check-in for the new decision");
  assert.match(chat[0], /one new decision needs you/i);
  assert.match(chat[0], /1\. \*\*Goal:\*\* .*double-counting refunds/);
  assert.match(chat[0], /2\. \*\*You asked the agent to:\*\* Fix the refund double-count/);
  assert.match(chat[0], /3\. \*\*Where it stands:\*\* Verified: Re-ran October/);
  assert.match(chat[0], /4\. \*\*Decision now:\*\* Re-send October's corrected CSV.*Recommendation: proceed/);
  assert.match(chat[0], /Decisions waiting on you: 1 · Sessions running here: 0 · Unverified tracked goals: 0/);
  assert.doesNotMatch(chat[0], INTERNAL_ID_RE, "check-ins use names, not ids");

  // Unchanged afterwards: nothing repeats.
  for (let i = 0; i < 2; i += 1) {
    nowMs += 60_000;
    await sup._tick("timer");
  }
  assert.equal(pushes.length, 1);
  assert.equal(chat.length, 1);
});

test("FYIs and session errors are kept apart from decisions and never pushed", async (t) => {
  const home = tempDir(t);
  const config = resolveFleetConfig({}, { home, push: "buzzkit" });
  fs.mkdirSync(path.dirname(config.paths.buzzEndpointFile), { recursive: true });
  fs.writeFileSync(config.paths.buzzEndpointFile, "https://ping.buzzkit.dev/device\n", { mode: 0o600 });
  const store = new FleetStore({ dir: path.join(home, "fleet"), now: () => NOW });
  const pushes = [];
  const outreach = fakeOutreach();
  const notifier = createNotifier({ config, store, runtime: { outreach }, now: () => new Date(NOW), fetchImpl: async (_u, init) => { pushes.push(init.body); return { ok: true, status: 200 }; } });
  const done = store.upsertQuestion({ dedupeKey: "done:a", kind: "completed", threadKey: "paseo:srv_local.a", title: "Docs refresh finished", options: ["dismiss"] });
  const crashed = store.upsertQuestion({ dedupeKey: "err:b", kind: "session-error", threadKey: "paseo:srv_local.b", title: "Session hit a provider error", options: ["retry", "dismiss"] });
  assert.equal(classifyAsk(done), "fyi");
  assert.equal(classifyAsk(crashed), "session_error");
  for (const q of [done, crashed]) {
    const res = await notifier.notifyQuestion(q);
    assert.equal(res.pushed, false);
    assert.equal(res.skipped, "not-a-decision");
  }
  assert.equal(pushes.length, 0);
  assert.ok([...outreach.items.values()].every((i) => i.needsDecision === false), "FYI copies are not marked as decisions");
  const card = buildSupervisorCard(crashed, { now: NOW });
  assert.equal(card.askType, "session_error");
  assert.equal(card.contextStatus, "complete", "session errors are not held for decision context");
});

test("an existing open follow-up is reworded with the four-part context without a new notification", async (t) => {
  const dir = tempDir(t);
  const outreach = fakeOutreach();
  const sup = new FleetSupervisor({
    dataDir: dir,
    runtime: { outreach, events: { emit() {} } },
    config: { enabled: true, mode: "auto", paseo: { enabled: true, only: true }, review: { enabled: false } },
    deps: { now: () => NOW, listPaseoThreads: async () => [], fetchPrStates: async () => new Map() }
  });
  const tracked = sup.activeWork.trackWork({
    project: "OpenAGI",
    theme: "Supervisor",
    goal: "Every Supervisor ask explains itself without opening the source chat",
    doneCriteria: "Spencer confirms check-ins are decision-ready",
    nextAction: "Ship the shared decision-context format",
    cadence: { staleAfterHours: 1 }
  });
  const item = sup.activeWork.state.items.find((it) => it.id === (tracked.item?.id ?? tracked.id));
  assert.ok(item, "goal tracked");
  // An old-format copy, raised before this change: internal id, no context.
  const old = outreach.seed({ id: "out_followup_old", type: "fleet-active-work", sourceRef: { kind: "active-work", id: item.id }, title: "Follow-through · OpenAGI / Supervisor", summary: `No meaningful progress for 30h (cadence 1h). (Choices: Assign orphan, Confirm done, Snooze) ${item.id}` });
  item.outreachId = old.id;
  item.lastMeaningfulProgress = { at: "2026-11-21T12:00:00.000Z", summary: "Drafted the context standard; tests not written yet", kind: "manual", ref: null };
  item.lastMeaningfulProgressAt = "2026-11-21T12:00:00.000Z";
  item.createdAt = "2026-11-21T12:00:00.000Z";

  await sup.activeWork.scanInventory({});
  const copy = outreach.get("out_followup_old");
  assert.equal(outreach.calls.append, 0, "no new follow-up copy");
  assert.equal(copy.title, "Tracked goal · OpenAGI / Supervisor", "a tracked goal is labeled as one, not as a running session");
  assert.match(copy.summary, /^1\. Goal: OpenAGI \/ Supervisor\. Every Supervisor ask explains itself/m);
  assert.match(copy.summary, /^2\. You asked the agent to: No session owns this yet: Ship the shared decision-context format; done when Spencer confirms/m);
  assert.match(copy.summary, /^3\. Where it stands: Changed: Last progress: Drafted the context standard.* Blocked: No meaningful progress for 30h/m);
  assert.match(copy.summary, /^4\. Decision now: OpenAGI \/ Supervisor has been idle 30h\. Resume owner, snooze, or confirm done\? Options: Assign orphan \(A session is assigned/m);
  assert.match(copy.summary, /Confirm done \(The goal is marked verified complete/);
  assert.doesNotMatch(copy.summary, INTERNAL_ID_RE);
});

test("agent-supplied context parses, internal ids strip, and gaps are named rather than invented", () => {
  const parsed = parseAgentSuppliedContext("noise\nDECISION CONTEXT\nGoal: A\nAssigned: B\nVerified: C\nBlocked: D\nDecision: E?\nOptions:\n- go — it ships\n- stop: nothing ships\nRecommendation: go");
  assert.equal(parsed.goal, "A");
  assert.equal(parsed.assignment, "B");
  assert.deepEqual(parsed.options, [{ label: "go", consequence: "it ships" }, { label: "stop", consequence: "nothing ships" }]);
  assert.equal(parseAgentSuppliedContext("no block here"), null);

  assert.equal(stripInternalIds("Ask fq_0123456789abcdef from paseo:srv_local.sess_alpha (id 3fa9c1d2-1111-2222-3333-444455556666) about PR #3"), "Ask from about PR #3");

  // "Proceed?" alone is not a decision anyone can make without context.
  const bare = buildDecisionContext({ question: { kind: "agent-ask", title: "Proceed?", options: ["yes", "no"] } });
  assert.equal(bare.complete, false);
  assert.deepEqual(bare.missing, ["goal", "assignment", "progress", "blocked", "decision"]);
  const text = renderDecisionContext(bare);
  assert.match(text, /1\. Goal: Not recoverable from the source chat or current evidence\./);
  assert.doesNotMatch(text, /undefined|null/);
});

test("review fixes: stale agent context, permission approvals, reviewed recommendations, and the decision always survive", () => {
  // An older DECISION CONTEXT block for a merge must not label a newer,
  // different ask in the same chat.
  const oldBlock = "DECISION CONTEXT\nGoal: G\nAssigned: A\nVerified: V\nBlocked: B\nDecision: Merge the PR?\nOptions:\n- merge — it merges\n- wait — nothing";
  const stale = buildDecisionContext({
    question: { kind: "agent-ask", title: "Delete the staging database?", options: ["delete", "keep"] },
    recentMessages: [
      { role: "assistant", text: oldBlock },
      { role: "user", text: "ok" },
      { role: "assistant", text: "The staging database is corrupt. Delete it, or keep it for forensics?" }
    ]
  });
  assert.equal(stale.agentSupplied, false);
  assert.doesNotMatch(stale.decision, /Merge the PR/);
  // Even as the latest message, a block naming other options is ignored.
  const mismatched = buildDecisionContext({
    question: { kind: "agent-ask", title: "Delete the staging database?", options: ["delete", "keep"] },
    recentMessages: [{ role: "assistant", text: oldBlock }]
  });
  assert.equal(mismatched.agentSupplied, false);

  // "Approve" on a tool permission is not a merge.
  const perm = buildDecisionContext({ question: { kind: "prompt", title: "Run npm test?", options: ["Approve", "Deny"] }, permission: { command: "npm test" } });
  assert.match(perm.options[0].consequence, /runs `npm test`/);
  const merge = buildDecisionContext({ question: { kind: "ready", prRef: "o/r#5", title: "PR #5 ready", options: ["Approve", "later"] } });
  assert.match(merge.options[0].consequence, /PR #5 merges/);

  // A reviewed recommendation reaches notifications and check-ins.
  const reviewed = decisionContextFromQuestion({
    kind: "agent-ask", title: "Ship the hotfix?", options: ["ship", "hold"],
    reviewedAt: "2026-11-22T17:00:00.000Z",
    reviewBrief: { recommendation: "Hold until the staging smoke test passes." }
  });
  assert.equal(reviewed.recommendation, "Hold until the staging smoke test passes.");

  // A long context is budgeted so part 4 is never cut off.
  const long = "x".repeat(900);
  const big = buildDecisionContext({
    question: { kind: "agent-ask", title: "Pick a region?", options: ["us-east", "eu-west"] },
    recentMessages: [{ role: "user", text: `Move the database ${long}` }, { role: "assistant", text: `Blocked: needs your call on region ${long}. Pick a region?` }]
  });
  const text = renderDecisionContext(big, { maxChars: 1400 });
  assert.ok(text.length <= 1400, `bounded (${text.length})`);
  assert.match(text, /4\. Decision now: Pick a region\? Options: Us-east; Eu-west\./);
});

test("the hosted hub mirror honors a context hold and shows the four-part summary", async () => {
  const { RemoteFleetSupervisor } = await import("../src/fleet/remote.js");
  const outreach = fakeOutreach();
  outreach.list = () => [...outreach.items.values()];
  outreach.resolve = () => {};
  const base = { status: "open", createdAt: new Date().toISOString(), options: ["proceed", "hold"], kind: "agent-ask" };
  const questions = [
    { ...base, id: "fq_held000001", title: "Held ask", body: "Proceed?", contextRequest: { at: new Date().toISOString(), sent: true, missing: ["goal"] } },
    { ...base, id: "fq_ready00001", title: "Ready ask", body: "Proceed?", contextSnapshot: { recentMessages: [{ role: "user", text: "Ship the onboarding emails before Monday's launch" }, { role: "assistant", text: "Draft is verified in staging. Sending needs your approval. Send now, or hold?" }] } }
  ];
  const fake = { runtime: { outreach }, nodeId: "node1", pendingOutreachDecisions: new Set(), getState: () => ({ questions, preferences: null }) };
  RemoteFleetSupervisor.prototype.mirrorQuestions.call(fake);
  const posted = [...outreach.items.values()];
  assert.deepEqual(posted.map((i) => i.sourceRef.id), ["fq_ready00001"], "the held ask is not mirrored yet");
  assert.match(posted[0].summary, /^1\. Goal: Ship the onboarding emails/m);
  assert.match(posted[0].summary, /^4\. Decision now: Send now, or hold\?/m);
});

// Live bug, 2026-11-22: the Mac (a node paired to the main) posted "0 coding
// sessions are currently running across 0 unfinished goals" while the main's
// Active Work listed 5 unfinished OpenAGI goals. The node counted its own,
// empty Active Work store and rendered "unknown" as zero.
test("check-in counts: goals come from where they are tracked; unknown is never rendered as zero", async (t) => {
  const { writeNodeConfig } = await import("../src/cli-client.js");
  const makeSup = (dir) => new FleetSupervisor({
    dataDir: dir,
    runtime: { events: { emit() {} } },
    config: { enabled: true, mode: "auto", paseo: { enabled: true, only: true }, review: { enabled: false } },
    deps: { now: () => NOW, listPaseoThreads: async () => [], fetchPrStates: async () => new Map() }
  });

  // A node paired to a main, with no goals tracked locally.
  const nodeDir = tempDir(t);
  writeNodeConfig({ remote: "http://100.64.0.1:43210", token: null, nodeToken: "node-token", nodeEnrollmentConfirmed: true }, nodeDir);
  const node = makeSup(nodeDir);
  const onNode = node.trackedGoalSummary();
  assert.equal(onNode.count, null);
  assert.equal(onNode.source, "main");
  assert.doesNotMatch(onNode.text, /: 0\b/, "a node never claims zero goals it does not track");
  assert.match(onNode.text, /tracked on the main/);

  // The machine that tracks the goals: 5 unverified OpenAGI goals, 0 running.
  const mainDir = tempDir(t);
  const main = makeSup(mainDir);
  for (const goal of ["Check-ins explain decisions", "Dictation survives pauses", "Voice mode slice 1", "Budget top-ups", "Paseo settings"]) {
    main.activeWork.trackWork({ project: "OpenAGI", goal, doneCriteria: "Verified live by Spencer" });
  }
  const items = main.activeWork.state.items;
  items[0].state = "blocked";
  items[1].awaitingFollowup = true;
  const onMain = main.trackedGoalSummary();
  assert.equal(onMain.source, "local");
  assert.equal(onMain.count, 5, "all 5 unverified goals are counted, including blocked and awaiting rollout");
  assert.equal(onMain.blocked, 1);
  assert.equal(onMain.awaiting, 1);
  assert.equal(onMain.text, "Unverified tracked goals: 5 (1 blocked, 1 awaiting rollout or verification)");
  assert.equal(main.runningSessionCount({ counts: { byState: { running: 0 } } }), 0, "zero running is a real zero");
  assert.equal(main.runningSessionCount(null), null, "no scan is unknown, not zero");

  // A failed Active Work read is unknown.
  main.activeWork.getActiveWork = () => { throw new Error("disk read failed"); };
  assert.equal(main.trackedGoalSummary().text, "Unverified tracked goals: unknown (Active Work could not be read)");
});
