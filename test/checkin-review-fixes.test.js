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
  sup.store.upsertQuestion({ dedupeKey: "ask:hub", kind: "agent-ask", threadKey: "paseo:s.h", title: "Publish the release notes?", options: ["publish", "hold"],
    contextSnapshot: { threadTitle: "Release notes", recentMessages: [{ role: "user", text: "Draft the v0.0.85 release notes for the blog" }, { role: "assistant", text: "Notes drafted and reviewed. Publishing needs your approval. Publish them, or hold?" }] } });
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

// Spencer's acceptance (2026-11-23): a check-in surfaces only the top 3-4
// verified decisions that need him; none if none qualify; no counts, backlog,
// raw ids, FYIs, routine recovery or unchanged repeats; one line on why.
test("check-in: at most four verified decisions, merges first, nothing else", async (t) => {
  const dir = tmp(t);
  const { msgs, runtime } = chatRuntime();
  let nowMs = NOW;
  const sup = new FleetSupervisor({ dataDir: dir, runtime, config: { enabled: true, mode: "auto", proactiveSupervisorChat: true }, deps: { now: () => nowMs } });
  const ctx = (i, text) => ({ threadTitle: `Workstream ${i}`, recentMessages: [{ role: "user", text: `Please finish workstream ${i} end to end` }, { role: "assistant", text }] });
  for (let i = 0; i < 5; i += 1) {
    sup.store.upsertQuestion({ dedupeKey: `ask:${i}`, kind: "agent-ask", threadKey: `paseo:s.${i}`, title: `Workstream ${i}: pick a path?`, options: ["go", "hold"],
      contextSnapshot: ctx(i, `Built and tested step ${i}. Shipping needs your approval. Go, or hold?`) });
  }
  sup.store.upsertQuestion({ dedupeKey: "ask:merge", kind: "agent-ask", mergeAsk: true, prRef: "acme/app#77", askedHead: "abc1234", threadKey: "paseo:s.m", title: "acme #77: merge?", options: ["merge", "wait"],
    contextSnapshot: { ...ctx("M", "CI is green and the review is resolved. Merging needs your approval. Merge, or wait?"), threadTitle: "Merge train" } });
  // Not decisions, or not verified: never in a check-in.
  sup.store.upsertQuestion({ dedupeKey: "done:x", kind: "completed", threadKey: "paseo:s.x", title: "Docs refresh: finished", options: ["Got it"] });
  sup.store.upsertQuestion({ dedupeKey: "err:y", kind: "session-error", threadKey: "paseo:s.y", title: "Session hit an error", options: ["retry"] });
  sup.store.upsertQuestion({ dedupeKey: "deliver:group", kind: "deliver", threadKey: null, threadKeys: ["paseo:s.a", "paseo:s.b"], title: "2 stopped. Nudges can't get through. Nudge them?", options: ["done", "skip"] });
  sup.store.upsertQuestion({ dedupeKey: "ask:poor", kind: "agent-ask", threadKey: "paseo:s.p", title: "Proceed?", options: ["yes", "no"] });

  await sup.maybePostProactiveSupervisorDigest({ started: nowMs });
  assert.equal(msgs.length, 1);
  const text = msgs[0].text;
  const shown = text.match(/\*\*(?:New|Changed): [^*]+\*\*/g) ?? [];
  assert.equal(shown.length, 4, "never more than four");
  assert.match(shown[0], /Merge train/, "the merge decision comes first");
  assert.match(text, /^\*\*Supervisor check-in: 4 decisions need you\.\*\*\n_Picked because/);
  assert.doesNotMatch(text, /\bfq_[0-9a-f]{6,}|Decisions waiting|Sessions running|tracked goals|more new|Docs refresh|hit an error|Nudges can't get through|Proceed\?/);

  // The two not shown are announced next; nothing shown is repeated.
  nowMs += 60_000;
  await sup.maybePostProactiveSupervisorDigest({ started: nowMs });
  assert.equal(msgs.length, 2);
  assert.equal((msgs[1].text.match(/\*\*(?:New|Changed): /g) ?? []).length, 2);
  for (const name of shown) assert.ok(!msgs[1].text.includes(name), `no repeat of ${name}`);

  // Nothing new that qualifies: no check-in at all.
  nowMs += 60_000;
  const res = await sup.maybePostProactiveSupervisorDigest({ started: nowMs });
  assert.equal(res.posted, false);
  assert.equal(msgs.length, 2);
});

// #366 review P2: options come only from a choices list tied to the
// decision, never from verification bullets.
test("verification bullets are never recovered as decision options", async () => {
  const { buildDecisionContext } = await import("../src/fleet/decision-context.js");
  const ctx = buildDecisionContext({
    question: { kind: "agent-ask", threadKey: "paseo:s.r", title: "Region: needs your call. Answer?", options: [] },
    recentMessages: [{ role: "user", text: "Roll the API out to production" }, { role: "assistant", text: "Verified:\n- Unit tests passed\n- Staging smoke test passed\nBlocked on your decision on the production region." }]
  });
  assert.equal(ctx.options.length, 0, "test results are not choices");
  assert.ok(ctx.missing.includes("decision"), "so the ask is not a verified decision");
  const listed = buildDecisionContext({
    question: { kind: "agent-ask", threadKey: "paseo:s.r", title: "Region: needs your call. Answer?", options: [] },
    recentMessages: [{ role: "assistant", text: "Verified:\n- Unit tests passed\n\nWhich region should production use?\n- us-east\n- eu-west" }]
  });
  assert.deepEqual(listed.options.map((o) => o.label), ["Us-east", "Eu-west"]);
});

// #366 review P2: a resolved decision mentioned in passing must not replace
// the real current ask.
test("a past decision named in an update does not override the current question", async () => {
  const { buildDecisionContext } = await import("../src/fleet/decision-context.js");
  const ctx = buildDecisionContext({
    question: { kind: "agent-ask", threadKey: "paseo:s.d", title: "Approve the production deployment?", options: ["approve", "hold"] },
    recentMessages: [{ role: "assistant", text: "I applied your decision on the EU region. The build passed staging verification. Production deployment still needs your approval." }]
  });
  assert.equal(ctx.decision, "Approve the production deployment?");
});

// Live repro 2026-11-23 ~21:30Z (synthetic text, same structure): a rich
// multi-part ask and a generic yes/no duplicate from the same session, plus a
// session error. The check-in groups the real sub-decisions with the
// recommendation, drops the duplicate and the error, and has no counts.
test("check-in replay: grouped sub-decisions, no duplicate generic ask, no session error, no counts", async (t) => {
  const dir = tmp(t);
  const { msgs, runtime } = chatRuntime();
  const sup = new FleetSupervisor({ dataDir: dir, runtime, config: { enabled: true, mode: "auto", proactiveSupervisorChat: true }, deps: { now: () => NOW } });
  const agent = "…eady say the email is only used to match accounts.\n\n**Decisions I need from you:**\n1. **The video:** will you record the narrated walkthrough and give me a public link? Or should I put screenshots in a public folder? If so, tell me where.\n2. **App Home:** should I add the welcome message so reviewers see it? Or leave the warning?\n\nOnce I have both answers, I'll update the video field and get the submission ready.";
  const snap = { threadTitle: "Marketplace submission", recentMessages: [{ role: "user", text: "Fix the marketplace submission and get it ready to resubmit" }, { role: "assistant", text: agent }], agentSummary: agent };
  sup.store.upsertQuestion({ dedupeKey: "ask:rich", kind: "agent-ask", threadKey: "paseo:s.mkt", title: "Marketplace: choose video and App Home", body: agent, options: ["record narrated video", "use public screenshots", "add welcome message", "leave warning"], contextSnapshot: snap });
  sup.store.upsertQuestion({ dedupeKey: "ask:generic", kind: "agent-ask", threadKey: "paseo:s.mkt2", title: "Marketplace submission: needs your call. Answer?", options: ["yes", "no"], contextSnapshot: { threadTitle: "Marketplace submission" } });
  sup.store.upsertQuestion({ dedupeKey: "err:zs", kind: "session-error", threadKey: "paseo:s.zs", title: "Iteration review: session hit an error", options: ["Got it"] });
  await sup.maybePostProactiveSupervisorDigest({ started: NOW });
  assert.equal(msgs.length, 1);
  const text = msgs[0].text;
  assert.equal((text.match(/\*\*New: /g) ?? []).length, 1, "only the real decision");
  assert.match(text, /\(1\) The video: Record narrated video or Use public screenshots \(2\) App Home: Add welcome message or Leave warning/);
  assert.match(text, /Where it stands:\*\* Once I have both answers, I'll update the video field/);
  assert.doesNotMatch(text, /…eady|Decisions I need from you|needs your call|session hit an error|Got it|waiting on you|\bfq_/);
});

// #366 review P2 (2nd round): "No owner action required" is not a decision.
test("a negated or completed owner action never becomes a 'Do this yourself' decision", async (t) => {
  const { buildDecisionContext } = await import("../src/fleet/decision-context.js");
  for (const text of [
    "The rollout is complete. No owner action required; monitoring continues automatically.",
    "Owner action: none required, the migration was already completed."
  ]) {
    const ctx = buildDecisionContext({ question: { kind: "agent-ask", threadKey: "paseo:s.o", title: "Rollout: needs your call. Answer?", options: [] }, recentMessages: [{ role: "assistant", text }] });
    assert.doesNotMatch(ctx.decision ?? "", /Do this yourself/, text);
    assert.equal(ctx.options.length, 0);
  }
  // Through the check-in path: nothing is announced.
  const dir = tmp(t);
  const { msgs, runtime } = chatRuntime();
  const sup = new FleetSupervisor({ dataDir: dir, runtime, config: { enabled: true, mode: "auto", proactiveSupervisorChat: true }, deps: { now: () => NOW } });
  sup.store.upsertQuestion({ dedupeKey: "ask:noaction", kind: "agent-ask", threadKey: "paseo:s.o", title: "Rollout: needs your call. Answer?", options: [],
    contextSnapshot: { threadTitle: "Rollout", recentMessages: [{ role: "user", text: "Roll out the new cache layer" }, { role: "assistant", text: "The rollout is complete. No owner action required; monitoring continues automatically." }] } });
  const res = await sup.maybePostProactiveSupervisorDigest({ started: NOW });
  assert.equal(res.posted, false);
  assert.equal(msgs.length, 0);
});

// #366 review P2 (2nd round): bulleted status evidence stays in "Where it
// stands"; only choice lists are left out.
test("bulleted results stay in where-it-stands; only choice lists are dropped", async () => {
  const { buildDecisionContext } = await import("../src/fleet/decision-context.js");
  const ctx = buildDecisionContext({
    question: { kind: "agent-ask", threadKey: "paseo:s.rel", title: "Release v2: approve?", options: ["approve", "hold"] },
    recentMessages: [{ role: "user", text: "Cut the v2 release" }, { role: "assistant", text: "- Staging smoke test failed with HTTP 500.\nWaiting for your release approval." }]
  });
  assert.match(ctx.status, /Staging smoke test failed with HTTP 500\./);
  const choices = buildDecisionContext({
    question: { kind: "agent-ask", threadKey: "paseo:s.rel", title: "Region: needs your call. Answer?", options: [] },
    recentMessages: [{ role: "assistant", text: "- Unit tests passed.\n\nWhich region should production use?\n- us-east\n- eu-west" }]
  });
  assert.match(choices.status, /Unit tests passed\./);
  assert.doesNotMatch(choices.status, /us-east|eu-west/);
});

test("tradeoffs are said to be missing when the source states none", async () => {
  const { buildDecisionContext, renderDecisionContext } = await import("../src/fleet/decision-context.js");
  const ctx = buildDecisionContext({ question: { kind: "agent-ask", threadKey: "paseo:s.t", title: "Pick a vendor?", options: ["vendor a", "vendor b"] }, recentMessages: [{ role: "user", text: "Choose a vendor for the pilot" }, { role: "assistant", text: "Both vendors pass the security review. Pick a vendor?" }] });
  assert.match(renderDecisionContext(ctx), /Options: Vendor a; Vendor b\. Tradeoffs: not stated by the agent\./);
});

// #366 review P2 (3rd round): a decision's options are never cut to fit the
// per-decision budget; the decision is shown whole or deferred, never
// marked surfaced with a missing choice.
test("a five-option decision with long tradeoffs keeps every option, or is deferred", async (t) => {
  const dir = tmp(t);
  const { msgs, runtime } = chatRuntime();
  const sup = new FleetSupervisor({ dataDir: dir, runtime, config: { enabled: true, mode: "auto", proactiveSupervisorChat: true }, deps: { now: () => NOW } });
  const why = "because this changes how every regional cluster is rolled and who gets paged overnight during the change window";
  const reply = ["DECISION CONTEXT", "Goal: Roll out the new storage engine to every region", "Assigned: Plan and run the rollout", "Verified: Canary in one region is healthy for 48h", "Blocked: The rollout order needs Spencer's call", "Decision: Which rollout plan should we use?", "Options:",
    ...["Option one all regions at once", "Option two east first", "Option three west first", "Option four canary per region", "Option five final staged weekly"].map((o) => `- ${o} — ${why}`), "Recommendation: Option four canary per region"].join("\n");
  sup.store.upsertQuestion({ dedupeKey: "ask:rollout", kind: "agent-ask", threadKey: "paseo:s.ro", title: "Storage rollout: which plan?", options: ["Option one all regions at once", "Option two east first", "Option three west first", "Option four canary per region", "Option five final staged weekly"],
    contextSnapshot: { threadTitle: "Storage rollout", recentMessages: [{ role: "user", text: "Roll out the new storage engine everywhere" }, { role: "assistant", text: reply }], agentSummary: reply } });
  const res = await sup.maybePostProactiveSupervisorDigest({ started: NOW });
  if (res.posted) {
    assert.match(msgs[0].text, /Option five final staged weekly/, "the fifth option is not cut off");
  } else {
    assert.equal(res.reason, "decision-too-long");
    assert.equal(sup.store.diffSurfacedDecisions(sup.store.openQuestions(), { now: NOW }).deltas.length, 1, "deferred, not marked surfaced");
  }
});

// Live 2026-11-25: the hub's serialized agent review outlasted the node's
// request, the node wrote its own copy of the check-in and re-posted it on
// later ticks. A check-in the hub did not confirm is never written locally.
test("on a paired node, a check-in the hub did not confirm is never written to the node's own chat", async (t) => {
  const dir = tmp(t);
  writeNodeConfig({ remote: "http://100.64.0.9:43210", token: null, nodeToken: "n", ownerProxyToken: "p", nodeEnrollmentConfirmed: true }, dir);
  let nowMs = NOW;
  let hub = "timeout";
  const { msgs, runtime } = chatRuntime();
  const sup = new FleetSupervisor({
    dataDir: dir, runtime,
    config: { enabled: true, mode: "auto", proactiveSupervisorChat: true },
    deps: {
      now: () => nowMs,
      supervisorChatFetch: async () => {
        if (hub === "timeout") throw Object.assign(new Error("aborted"), { name: "AbortError" });
        if (hub === "down") return { ok: false, status: 502 };
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
    }
  });
  sup.store.upsertQuestion({ dedupeKey: "ask:hub2", kind: "agent-ask", threadKey: "paseo:s.h2", title: "Publish the release notes?", options: ["publish", "hold"],
    contextSnapshot: { threadTitle: "Release notes", recentMessages: [{ role: "user", text: "Draft the v0.0.85 release notes for the blog" }, { role: "assistant", text: "Notes drafted and reviewed. Publishing needs your approval. Publish them, or hold?" }] } });
  for (const state of ["timeout", "down"]) {
    hub = state;
    const res = await sup.maybePostProactiveSupervisorDigest({ started: nowMs });
    assert.equal(res.posted, false, state);
    assert.equal(res.reason, "hub-unconfirmed", state);
    assert.equal(msgs.length, 0, `no node-only copy when the hub is ${state}`);
    assert.equal(sup.store.lastProactiveChatAt(), null);
    nowMs += 3 * 3_600_000;
  }
  hub = "up";
  const ok = await sup.maybePostProactiveSupervisorDigest({ started: nowMs });
  assert.equal(ok.deliveredRemote, true);
  assert.equal(sup.store.diffSurfacedDecisions(sup.store.openQuestions(), { now: nowMs }).deltas.length, 0, "surfaced once the hub confirms");
});

// Live 2026-11-25: an agent's context block said "Decision: Not set by me …
// Options: No options were offered … Recommendation: None was made", and the
// card went out as a decision. A stated absence is not a decision.
test("an agent stating there is no decision never produces a verified decision", async () => {
  const { parseAgentSuppliedContext, buildDecisionContext } = await import("../src/fleet/decision-context.js");
  const block = [
    "Work done. DECISION CONTEXT",
    "Goal: Fix device fallback when a chosen mic disconnects.",
    "Assigned: Prepare a separate, reviewable fix from current main.",
    "Verified: Unit tests pass; the build worker is out of disk.",
    "Blocked: The shared build worker needs disk space freed by its owner.",
    "Decision: Not set by me. My last reply asked no explicit question.",
    "Options:",
    "- No options were offered in my last reply.",
    "Recommendation: None was made in my last reply."
  ].join("\n");
  const parsed = parseAgentSuppliedContext(block);
  assert.equal(parsed.decision, null);
  assert.deepEqual(parsed.options, []);
  assert.equal(parsed.recommendation, null);
  assert.match(parsed.blocked, /disk space/);
  const ctx = buildDecisionContext({
    question: { kind: "agent-ask", threadKey: "paseo:s.r", title: "Needs your decision", options: ["continue", "open thread"] },
    recentMessages: [{ role: "user", text: "Fix the device fallback in the recorder" }, { role: "assistant", text: block }]
  });
  assert.ok(ctx.missing.includes("decision"), "no decision to verify");
  assert.doesNotMatch(String(ctx.decision ?? ""), /not set|no options/i);
});

// #383 review P2: "None — keep …" is a real opt-out choice, not an absence.
test("an option or recommendation labeled 'None' with a consequence is kept", async () => {
  const { parseAgentSuppliedContext } = await import("../src/fleet/decision-context.js");
  const parsed = parseAgentSuppliedContext([
    "DECISION CONTEXT",
    "Goal: Choose where the docs site is hosted.",
    "Decision: Move the docs site to the managed host, or keep it self-hosted?",
    "Options:",
    "- Managed host — less upkeep, costs a monthly fee",
    "- None — keep the current self-hosted deployment",
    "Recommendation: None: keep it self-hosted until the traffic doubles."
  ].join("\n"));
  assert.deepEqual(parsed.options.map((o) => o.label), ["Managed host", "None"]);
  assert.match(parsed.options[1].consequence, /self-hosted/);
  assert.match(parsed.recommendation, /^None: keep it self-hosted/);
});
