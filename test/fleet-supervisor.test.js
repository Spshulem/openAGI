import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, resolveFleetConfig, shortHash } from "../src/fleet/contracts.js";
import { FleetSupervisor, groupQuestions, judgeAskKey, judgeCacheKey } from "../src/fleet/supervisor.js";
import { createFleetCapability } from "../src/fleet/remote.js";
import { createFleetRoute } from "../src/fleet/routes.js";
import { DEADLINE_MARGIN_MS, restartMaxMs } from "../src/fleet/ui-delivery.js";

const MIN = 60_000;
const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const HEAD = "b".repeat(40);

function makeThread(overrides = {}) {
  return {
    key: "codex:t1", kind: "codex", id: "t1", title: "Fix billing", cwd: "/work/t1", repo: "acme/app",
    branch: "spencer/fix", workspace: null, claudeSessionId: null, agentStatus: "idle",
    lastActivityAt: ago(60 * MIN), lastAgentText: "Pushed.", lastAgentAt: ago(60 * MIN),
    lastUserText: "continue", lastUserAt: ago(120 * MIN), error: null, openTasks: [], prRefs: ["acme/app#7"],
    live: null, writerLocked: false, archived: false, excluded: null, meta: {}, ...overrides
  };
}

function makePr(overrides = {}) {
  return {
    ref: "acme/app#7", repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7", title: "Fix",
    state: "OPEN", isDraft: false, headRef: "spencer/fix", headOid: HEAD, baseRef: "main", mergeState: "UNSTABLE",
    mergeable: "MERGEABLE", reviewDecision: "APPROVED", ci: { state: "FAILURE", failing: ["verification"], pending: [] },
    unresolvedThreads: 2, codexReview: { reviewedHead: true, sha: "bbbbbbb" }, qa: { required: false, freshOnHead: null, sha: null },
    createdAt: ago(24 * 60 * MIN), updatedAt: ago(0), ...overrides
  };
}

function fixture(t, { threads = [makeThread()], prs = null, mode = "observe", deps = {}, now = () => NOW, limits = {}, deliverStatus = "sent", manager = null, delivery = undefined, review = undefined, env = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-supervisor-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const delivered = [];
  const notified = [];
  const executor = {
    deliver: async (args) => { delivered.push(args); return { status: deliverStatus, route: args.route, detail: "ok", actionId: args.actionId ?? null }; },
    inFlight: () => [],
    whenIdle: async () => {}
  };
  const notifier = { notifyQuestion: async (q) => { notified.push(q); return { outreachId: null, pushed: false, skipped: "push-off" }; } };
  // Storage stays off unless a test asks: it would read the real disks.
  const config = resolveFleetConfig({ OPENAGI_FLEET_STORAGE: "0", ...env }, { home: dataDir, mode, limits: { ...DEFAULTS, ...limits }, managerRef: "none", ...(delivery ? { delivery } : {}), ...(review ? { review } : {}) });
  const prMap = prs ?? new Map([["acme/app#7", makePr()]]);
  // The state-only read (candidates, the check before a send) answers what
  // the full read does, so no test reaches the real gh.
  const fullRead = deps.fetchPrStates ?? (async () => prMap);
  const liteRead = async (refs, ...rest) => {
    const full = await fullRead(refs, ...rest);
    return new Map(refs.filter((ref) => full?.get?.(ref)).map((ref) => [ref, { state: full.get(ref).state }]));
  };
  const supervisor = new FleetSupervisor({
    dataDir,
    config,
    deps: {
      now,
      executor,
      notifier,
      readLivePeers: () => new Map(),
      listCodexThreads: async () => threads.filter((thread) => thread.kind === "codex"),
      listClaudeThreads: async () => threads.filter((thread) => thread.kind === "claude"),
      listConductorThreads: async () => threads.filter((thread) => thread.kind === "conductor"),
      listAntigravityThreads: async () => threads.filter((thread) => thread.kind === "antigravity"),
      readCodexLbErrors: async () => [],
      findLocalHeavyVerification: async () => [],
      readLocalGit: async () => ({ head: HEAD, branch: "spencer/fix", upstream: "origin/spencer/fix", ahead: 0, remote: "acme/app" }),
      findPrForBranch: async () => null,
      fetchPrStates: async () => prMap,
      fetchPrStateLite: liteRead,
      probeBuildBot3: async () => ({ reachable: true, checkedAt: ago(0), gate: { state: "ok", reason: null, since: null }, fullQueue: 0, quickQueue: 0, load: [1, 1, 1], runs: [], timersDead: [], error: null }),
      checkLb: async () => ({ healthy: true, detail: "200", watchLine: null }),
      findManagerSession: () => manager,
      ...deps
    }
  });
  return { supervisor, delivered, notified, dataDir };
}

test("observe records planned actions and never delivers", async (t) => {
  const { supervisor, delivered } = fixture(t);
  const snapshot = await supervisor.tick({ reason: "test" });
  assert.equal(delivered.length, 0);
  assert.equal(snapshot.counts.inScope, 1);
  assert.equal(snapshot.threads[0].state, "pr-not-ready");
  const planned = supervisor.getState().actions.filter((a) => a.status === "planned");
  assert.equal(planned.length, 1);
  assert.equal(planned[0].playbook, "merge-ready");
  // A second tick updates the same planned action instead of stacking copies.
  await supervisor.tick({ reason: "test" });
  assert.equal(supervisor.getState().actions.filter((a) => a.status === "planned").length, 1);
});

test("propose stores a proposed action that sendProposed delivers once", async (t) => {
  const { supervisor, delivered } = fixture(t, { mode: "propose" });
  await supervisor.tick({ reason: "test" });
  const proposed = supervisor.getState().actions.find((a) => a.status === "proposed");
  assert.ok(proposed);
  const result = await supervisor.sendProposed(proposed.id);
  assert.equal(result.delivery.status, "sent");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].route, "codex-exec");
  assert.match(delivered[0].message, /Ready to merge\?/);
  assert.equal(await supervisor.sendProposed("fa_missing"), null);
});

test("auto delivers within maxSendsPerTick and respects cooldown across ticks", async (t) => {
  let now = NOW;
  const threads = [1, 2, 3].map((n) => makeThread({ key: `codex:t${n}`, id: `t${n}`, cwd: `/work/t${n}`, prRefs: ["acme/app#7"] }));
  const { supervisor, delivered } = fixture(t, { mode: "auto", threads, now: () => now, limits: { maxSendsPerTick: 2 } });
  await supervisor.tick({ reason: "test" });
  assert.equal(delivered.length, 2);
  now += 60_000;
  await supervisor.tick({ reason: "test" });
  // Third thread gets its turn; the first two are cooling down.
  assert.equal(delivered.length, 3);
  assert.deepEqual(delivered.map((d) => d.thread.key).sort(), ["codex:t1", "codex:t2", "codex:t3"]);
  now += 60_000;
  await supervisor.tick({ reason: "test" });
  assert.equal(delivered.length, 3);
});

test("a throwing source is recorded and the tick completes", async (t) => {
  const { supervisor } = fixture(t, {
    deps: {
      listClaudeThreads: async () => { throw new Error("boom /Users/secret/path"); },
      probeBuildBot3: async () => { throw new Error("ssh exploded"); }
    }
  });
  const snapshot = await supervisor.tick({ reason: "test" });
  assert.match(snapshot.sourceErrors.claude, /boom/);
  assert.match(snapshot.sourceErrors.bb3, /ssh exploded/);
  assert.equal(snapshot.counts.inScope, 1);
  assert.doesNotThrow(() => JSON.stringify(supervisor.getState()));
});

test("an owner answer to an agent question is delivered even in observe", async (t) => {
  const asking = makeThread({ lastAgentText: "Ready. Want me to merge with --admin or wait for Nikhil's approval?", prRefs: [] });
  const { supervisor, delivered, notified } = fixture(t, { threads: [asking], prs: new Map() });
  await supervisor.tick({ reason: "test" });
  const question = supervisor.getState().questions.find((q) => q.kind === "agent-ask");
  assert.ok(question, "agent question raised");
  assert.ok(notified.some((q) => q.id === question.id));
  const result = await supervisor.answerQuestion(question.id, question.options[0]);
  assert.equal(result.question.status, "answered");
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].message, /^Owner answer: /);
  assert.equal(await supervisor.answerQuestion(question.id, "yes"), null);
});

test("concurrent ticks share one run", async (t) => {
  let calls = 0;
  const { supervisor } = fixture(t, { deps: { listCodexThreads: async () => { calls += 1; return [makeThread()]; } } });
  const [a, b] = await Promise.all([supervisor.tick({ reason: "a" }), supervisor.tick({ reason: "b" })]);
  assert.equal(calls, 1);
  assert.equal(a, b);
});

test("start does nothing when disabled and the constructor touches no disk", (t) => {
  const dataDir = path.join(os.tmpdir(), `fleet-never-${process.pid}-${NOW}`);
  const supervisor = new FleetSupervisor({ dataDir, config: { enabled: false } });
  assert.equal(supervisor.start(), false);
  assert.equal(fs.existsSync(dataDir), false);
  supervisor.stop();
});

test("setMode validates and persists", async (t) => {
  const { supervisor } = fixture(t);
  assert.equal(supervisor.setMode("yolo"), null);
  assert.equal(supervisor.setMode("auto"), "auto");
  assert.equal(supervisor.getState().mode, "auto");
});

test("groupQuestions collapses limit and unreachable bursts and duplicate titles", () => {
  const byKey = new Map([
    ["a", makeThread({ key: "a", workspace: "cairo", prRefs: ["acme/app#1"], error: { kind: "session-limit", resetAt: "2026-09-27T07:00:00.000Z" } })],
    ["b", makeThread({ key: "b", workspace: "apia", prRefs: ["acme/app#2"], error: { kind: "session-limit", resetAt: "2026-09-27T07:00:00.000Z" } })],
    ["c", makeThread({ key: "c", workspace: "milan", prRefs: [] })]
  ]);
  const ask = (threadKey, kind, title, options = kind === "limit" ? ["wait", "added"] : ["yes", "no"]) => ({ threadKey, playbook: null, question: { title, body: "x", options, dedupeKey: `${kind}:${threadKey}`, kind } });
  const grouped = groupQuestions([
    ask("a", "limit", "cairo capped"), ask("b", "limit", "apia capped"), ask("c", "open", "milan stuck"),
    ask("infra:bb3", "infra", "BB3 jammed. Manager offline."), ask("a", "infra", "BB3 jammed. Manager offline.")
  ], byKey);
  assert.equal(grouped.length, 3);
  const limit = grouped.find((q) => q.kind === "limit");
  assert.match(limit.title, /^2 threads capped\. Reset /);
  assert.deepEqual(limit.threadKeys, ["a", "b"]);
  // Repo and PR name the work, as in single questions.
  assert.match(limit.body, /app #1, app #2/);
  assert.equal(grouped.filter((q) => q.title.startsWith("BB3 jammed")).length, 1);
  assert.equal(grouped.find((q) => q.kind === "open").threadKey, "c");
});

test("grouped questions name threads by owner label, never a session id or a prompt", () => {
  const session = "4396b7d2-da42-42e4-97b0-aca39b2d9a45";
  const byKey = new Map([
    [`claude:${session}`, makeThread({ key: `claude:${session}`, kind: "claude", id: session, title: "please fix the login flow and push", cwd: "/Users/me/Dev/g2", repo: null, prRefs: [] })],
    ["codex:01a0e850", makeThread({ key: "codex:01a0e850", id: "01a0e850-c6b0-7911", title: "Current local time: 2026-09-28. Do not retry a chat", cwd: null, repo: null, prRefs: [] })],
    ["conductor:c1", makeThread({ key: "conductor:c1", kind: "conductor", id: "c1", title: "Setup Flow Redesign", workspace: "cape-town", prRefs: ["acme/app#6817"] })]
  ]);
  const asks = [...byKey.keys()].map((threadKey) => ({ threadKey, playbook: null, question: { title: "stuck", body: "x", options: ["opened", "skip"], dedupeKey: `open:${threadKey}`, kind: "open" } }));
  const [group] = groupQuestions(asks, byKey);
  assert.equal(group.dedupeKey, "open:group");
  assert.equal(group.body, "No live session to message: g2, Codex chat, app #6817.");
  assert.doesNotMatch(group.body, /4396b7d2|01a0e850|login flow|Current local time|Setup Flow/);
});

test("groupQuestions keeps distinct agent questions sharing a display title", () => {
  const asks = ["a", "b"].map((threadKey) => ({
    threadKey, playbook: null,
    question: { kind: "agent-ask", title: "madrid asks", body: `Answer ${threadKey}?`, options: ["yes", "no"], dedupeKey: `agent-ask:${threadKey}` }
  }));
  const grouped = groupQuestions(asks, new Map());
  assert.equal(grouped.length, 2);
  assert.deepEqual(grouped.map((q) => q.body), ["Answer a?", "Answer b?"]);
});

test("skip on a grouped unreachable question mutes every thread in it", async (t) => {
  const threads = ["t1", "t2"].map((id) => makeThread({ key: `conductor:${id}`, kind: "conductor", id, workspace: id, live: null, lastActivityAt: ago(300 * MIN), lastAgentAt: ago(300 * MIN), agentStatus: "idle" }));
  const { supervisor } = fixture(t, { threads });
  await supervisor.tick({ reason: "test" });
  const group = supervisor.getState().questions.find((q) => q.dedupeKey === "open:group");
  assert.ok(group, "grouped unreachable question");
  await supervisor.answerQuestion(group.id, "skip");
  const snapshot = await supervisor.tick({ reason: "test" });
  assert.ok(snapshot.threads.every((row) => row.decision.reason === "muted by owner"));
  assert.equal(supervisor.getState().questions.some((q) => q.dedupeKey === "open:group"), false);
});

const READY_PR = () => makePr({ ci: { state: "SUCCESS", failing: [], pending: [] }, unresolvedThreads: 0, mergeState: "CLEAN" });

function makeManager(overrides = {}) {
  return makeThread({
    key: "conductor:mgr", kind: "conductor", id: "mgr", title: "Remote dev setup", workspace: "remote-dev", cwd: "/work/mgr",
    prRefs: [], live: { peerName: "remote-dev", pid: 4242 }, excluded: "manager", ...overrides
  });
}

function blockedGate() {
  return async () => ({
    reachable: true, checkedAt: ago(0), gate: { state: "blocked", reason: "10 full verifies queued", since: ago(40 * MIN) },
    fullQueue: 10, quickQueue: 0, load: [9, 9, 9], runs: [], timersDead: [], error: null
  });
}

for (const close of ["later", "dismiss"]) {
  test(`a question closed with '${close}' is not re-asked or re-pushed while its condition holds`, async (t) => {
    let now = NOW;
    const { supervisor, notified } = fixture(t, { prs: new Map([["acme/app#7", READY_PR()]]), now: () => now });
    await supervisor.tick({ reason: "test" });
    const first = supervisor.getState().questions.find((q) => q.kind === "ready");
    assert.ok(first, "ready question raised");
    assert.equal(notified.length, 1);
    await supervisor.answerQuestion(first.id, close);
    for (let i = 0; i < 2; i += 1) {
      now += 5 * MIN;
      await supervisor.tick({ reason: "test" });
    }
    assert.deepEqual(supervisor.getState().questions, []);
    assert.equal(notified.length, 1);
    assert.equal(supervisor.store.question(first.id).status, close === "dismiss" ? "dismissed" : "answered");
  });
}

test("answerQuestion accepts only the question's own options or dismiss", async (t) => {
  const asking = makeThread({ lastAgentText: "Ready. Want me to merge with --admin or wait for Nikhil's approval?", prRefs: [] });
  const { supervisor, delivered } = fixture(t, { threads: [asking], prs: new Map() });
  await supervisor.tick({ reason: "test" });
  const question = supervisor.getState().questions.find((q) => q.kind === "agent-ask");
  assert.ok(question, "agent question raised");
  assert.equal(await supervisor.answerQuestion(question.id, "merge with --admin now and skip CI"), null);
  assert.equal(await supervisor.answerQuestion(question.id, ""), null);
  assert.equal(delivered.length, 0);
  assert.equal(supervisor.store.question(question.id).status, "open");
  const dismissed = await supervisor.answerQuestion(question.id, "dismiss");
  assert.equal(dismissed.question.status, "dismissed");
  assert.equal(delivered.length, 0);
});

test("a muted thread gets no infra-recovered nudge when the LB comes back", async (t) => {
  const blocked = makeThread({ agentStatus: "aborted", error: { kind: "lb" }, prRefs: [] });
  const { supervisor, delivered } = fixture(t, { mode: "auto", threads: [blocked], prs: new Map() });
  supervisor.store.setInfraDown("lb", true);
  supervisor.store.mute("codex:t1", NOW + 60 * MIN);
  const snapshot = await supervisor.tick({ reason: "test" });
  assert.equal(delivered.length, 0);
  assert.equal(snapshot.threads[0].decision.action, "none");
  assert.equal(snapshot.threads[0].decision.reason, "muted by owner");
  assert.equal(snapshot.counts.actions, 0);
});

test("threads blocked while the LB is down are remembered until the recovery tick", async (t) => {
  let now = NOW;
  let healthy = false;
  const threads = [makeThread({ agentStatus: "aborted", error: { kind: "lb" }, prRefs: [] })];
  const { supervisor } = fixture(t, { threads, prs: new Map(), now: () => now, deps: { checkLb: async () => ({ healthy, detail: healthy ? "200" : "503", watchLine: null }) } });
  await supervisor.tick({ reason: "test" });
  assert.deepEqual(supervisor.store.infraBlocked("lb"), ["codex:t1"]);
  assert.deepEqual(supervisor.store.infraBlocked("bb3"), []);

  // The first thread's error row aged out; a second one hit the outage.
  threads[0] = makeThread({ agentStatus: "aborted", error: null, prRefs: [] });
  threads.push(makeThread({ key: "codex:t2", id: "t2", cwd: "/work/t2", agentStatus: "aborted", error: { kind: "lb" }, prRefs: [] }));
  now += 5 * MIN;
  await supervisor.tick({ reason: "test" });
  assert.deepEqual(supervisor.store.infraBlocked("lb").sort(), ["codex:t1", "codex:t2"]);

  healthy = true;
  now += 5 * MIN;
  await supervisor.tick({ reason: "test" });
  assert.deepEqual(supervisor.store.infraBlocked("lb"), []);
});

test("LB recovery resumes a remembered thread even after its error rows aged out", async (t) => {
  // Needs policy.recoveryNudges to honor blockedKeys (shared interface I4).
  const stalled = makeThread({ agentStatus: "aborted", error: null, prRefs: [] });
  const { supervisor, delivered } = fixture(t, { mode: "auto", threads: [stalled], prs: new Map() });
  supervisor.store.setInfraDown("lb", true);
  supervisor.store.setInfraBlocked("lb", ["codex:t1"]);
  const snapshot = await supervisor.tick({ reason: "test" });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].playbook, "infra-recovered");
  assert.equal(snapshot.threads[0].state, "stopped");
  assert.equal(snapshot.threads[0].decision.action, "nudge");
  assert.equal(snapshot.threads[0].decision.playbook, "infra-recovered");
});

test("snapshot rows show the decision that acts, not a trailing none or wait", async (t) => {
  const { supervisor } = fixture(t);
  const thread = makeThread();
  const classified = { state: "idle-no-pr", reason: "no PR", blockers: [] };
  const base = { threadKey: thread.key, state: "idle-no-pr", playbook: null, message: null, blockers: [], question: null, route: null, notBefore: null };
  const decisions = [
    { ...base, action: "nudge", playbook: "infra-recovered", reason: "Codex LB is up", route: "codex-exec", message: "go" },
    { ...base, action: "none", reason: "no PR" }
  ];
  const snapshot = supervisor.buildSnapshot({
    reason: "test", started: NOW, finished: NOW, mode: "auto", threads: [thread], inScope: [thread],
    items: [{ thread, classified, pr: null }], decisions, infra: {}, sourceErrors: {}, manager: null
  });
  assert.equal(snapshot.threads[0].decision.action, "nudge");
  assert.equal(snapshot.threads[0].decision.playbook, "infra-recovered");
  const waitOnly = supervisor.buildSnapshot({
    reason: "test", started: NOW, finished: NOW, mode: "auto", threads: [thread], inScope: [thread],
    items: [{ thread, classified, pr: null }], decisions: [{ ...base, action: "wait", reason: "cooldown" }, { ...base, action: "none", reason: "no PR" }],
    infra: {}, sourceErrors: {}, manager: null
  });
  assert.equal(waitOnly.threads[0].decision.action, "wait");
});

test("snapshot rows carry a health colour, and an older saved snapshot gets one on read", async (t) => {
  const { supervisor } = fixture(t);
  const snapshot = await supervisor.tick({ reason: "test" });
  assert.equal(snapshot.threads[0].state, "pr-not-ready");
  assert.equal(snapshot.threads[0].health, "yellow");
  const errored = makeThread({ agentStatus: "aborted", error: { kind: "usage-limit", resetAt: null } });
  const erroredSnapshot = supervisor.buildSnapshot({
    reason: "test", started: NOW, finished: NOW, mode: "observe", threads: [errored], inScope: [errored],
    items: [{ thread: errored, classified: { state: "idle-no-pr", reason: "no PR", blockers: [] }, pr: null }],
    decisions: [], infra: {}, sourceErrors: {}, manager: null
  });
  assert.equal(erroredSnapshot.threads[0].health, "red");
  // Saved by a build without health: the phone still gets a colour.
  supervisor.store.recordSnapshot({ at: ago(0), threads: [{ key: "codex:old", state: "needs-human", error: null }, { key: "codex:new", state: "done", health: "green" }] });
  assert.deepEqual(supervisor.getState().snapshot.threads.map((row) => row.health), ["red", "green"]);
  assert.equal(supervisor.store.snapshot.threads[0].health, undefined, "the stored snapshot is not rewritten");
});

test("a failed infra escalation starts the cooldown under its incident key", async (t) => {
  let now = NOW;
  const manager = makeManager();
  const { supervisor, delivered } = fixture(t, {
    mode: "auto", threads: [], prs: new Map(), now: () => now, deliverStatus: "failed", manager,
    deps: { probeBuildBot3: blockedGate() }
  });
  await supervisor.tick({ reason: "test" });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].thread.key, "conductor:mgr");
  assert.equal(supervisor.store.lastEscalation("infra:bb3"), new Date(NOW).toISOString());
  now += 5 * MIN;
  await supervisor.tick({ reason: "test" });
  assert.equal(delivered.length, 1, "no retry every tick");
});

test("thread-level manager escalations record the shared incident key", async (t) => {
  const waiting = makeThread({
    key: "conductor:w1", kind: "conductor", id: "w1", workspace: "apia", cwd: "/work/w1", agentStatus: "waiting",
    lastAgentText: "bb-quick is running.", openTasks: [{ id: "task1", description: "bb-quick on BuildBot3", startedAt: ago(20 * MIN) }]
  });
  const { supervisor, delivered } = fixture(t, { mode: "auto", threads: [waiting], manager: makeManager() });
  await supervisor.tick({ reason: "test" });
  const escalation = delivered.find((d) => d.playbook === "manager-bb3");
  assert.ok(escalation, "bb-quick escalation sent");
  assert.equal(escalation.thread.key, "conductor:mgr");
  assert.equal(supervisor.store.lastEscalation("infra:bb3"), new Date(NOW).toISOString());

  const at = new Date(NOW).toISOString();
  supervisor.recordSend({ threadKey: "codex:x", kind: "escalate-manager", playbook: "manager-lb", route: "peer-relay" }, { status: "failed" });
  assert.equal(supervisor.store.lastEscalation("infra:lb"), at);
  supervisor.recordSend({ threadKey: "codex:y", kind: "nudge", playbook: "merge-ready", route: "codex-exec" }, { status: "failed" });
  supervisor.recordSend({ threadKey: "infra:bb3", kind: "escalate-manager", playbook: "manager-bb3", route: "peer-relay" }, { status: "blocked" });
  assert.equal(supervisor.store.lastEscalation("codex:y"), null);
  assert.equal(supervisor.store.lastEscalation("infra:bb3"), at);
});

test("a background nudge that never reached the agent leaves no sent hash behind", async (t) => {
  const { supervisor } = fixture(t);
  let reached = null;
  const done = new Promise((resolve) => { reached = resolve; });
  supervisor.recordSend({ threadKey: "codex:t1", kind: "nudge", playbook: "merge-ready", route: "codex-exec", messageHash: "abc", progressMark: { head: "h1" } }, { status: "sent", route: "codex-exec", done });
  // The owner said "keep going" while the child ran, and an owner message landed after it.
  supervisor.store.resetAttempts("codex:t1");
  supervisor.store.recordNudge("codex:t1", { playbook: "owner-message", route: "computer-use", status: "owner-answer" });
  reached(false);
  await new Promise((resolve) => setImmediate(resolve));
  const nudges = supervisor.store.ledgerFor("codex:t1").nudges;
  assert.equal(nudges.find((nudge) => nudge.messageHash === "abc").status, "failed");
  assert.equal(nudges.at(-1).status, "owner-answer");
  assert.equal(supervisor.store.ledgerFor("codex:t1").attemptsWithoutProgress, 0);
  // It also lifts the policy's hold on an answered nudge.
  assert.ok(Number.isFinite(Date.parse(supervisor.store.ledgerFor("codex:t1").keepGoingAt)));
});

test("a recent infra escalation holds back a thread-level one to the same manager", async (t) => {
  // Needs decideThread to read escalationLedger (shared interface I3).
  const waiting = makeThread({
    key: "conductor:w1", kind: "conductor", id: "w1", workspace: "apia", cwd: "/work/w1", agentStatus: "waiting",
    lastAgentText: "bb-quick is running.", openTasks: [{ id: "task1", description: "bb-quick on BuildBot3", startedAt: ago(20 * MIN) }]
  });
  const { supervisor, delivered } = fixture(t, { mode: "auto", threads: [waiting], manager: makeManager() });
  supervisor.store.recordEscalation("infra:bb3", ago(5 * MIN));
  await supervisor.tick({ reason: "test" });
  assert.equal(delivered.filter((d) => d.playbook === "manager-bb3").length, 0);
});

test("forceMode overrides the mode the owner persisted", async (t) => {
  const { supervisor, delivered, dataDir } = fixture(t, { mode: "auto" });
  supervisor.store.setMode("auto");
  const forced = new FleetSupervisor({ dataDir, config: supervisor.config, deps: supervisor.deps, forceMode: "observe" });
  assert.equal(forced.mode, "observe");
  assert.equal(forced.getState().mode, "observe");
  await forced.tick({ reason: "test" });
  assert.equal(delivered.length, 0);
  assert.equal(forced.getState().actions.filter((a) => a.status === "planned").length, 1);
  assert.equal(new FleetSupervisor({ dataDir, config: supervisor.config, forceMode: "yolo" }).mode, "auto");
});

test("fleet-scan CLI can never send or push, whatever the saved mode or env", async (t) => {
  const { buildScanSupervisor } = await import("../scripts/fleet-scan.mjs");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-scan-cli-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dataDir, "fleet"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "fleet", "state.json"), JSON.stringify({ mode: "auto" }));
  const supervisor = buildScanSupervisor({ dataDir, env: { OPENAGI_FLEET_PUSH: "buzzkit", OPENAGI_FLEET_MODE: "auto" } });
  assert.equal(supervisor.store.mode, "auto");
  assert.equal(supervisor.mode, "observe");
  assert.equal(supervisor.config.push, null);
  assert.equal(supervisor.config.enabled, false);
  const delivery = await supervisor.executor.deliver({ thread: makeThread(), message: "go", route: "codex-exec", playbook: "resume" });
  assert.equal(delivery.status, "dry-run");
});

test("retry on a logged-out question resumes the thread, and owner answers never spend the nudge budget", async (t) => {
  const loggedOut = makeThread({ agentStatus: "error", error: { kind: "logged-out", text: "Not logged in · Please run /login", resetAt: null } });
  const { supervisor, delivered, dataDir } = fixture(t, { threads: [loggedOut] });
  await supervisor.tick({ reason: "test" });
  const question = supervisor.getState().questions.find((q) => q.kind === "infra" && q.options.includes("retry"));
  assert.ok(question, "logged-out question raised");
  const result = await supervisor.answerQuestion(question.id, "retry");
  assert.equal(result.delivery.status, "sent");
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].message, /Retry: continue where you stopped/);
  const ledger = supervisor.store.ledgerFor(loggedOut.key);
  assert.equal(ledger.attemptsWithoutProgress, 0);
  assert.ok(ledger.lastNudgeAt, "the answer still starts the cooldown");
  assert.ok(dataDir);
});

test("model-limit questions keep their own buttons instead of joining the account-cap group", () => {
  const byKey = new Map([
    ["a", makeThread({ key: "a", workspace: "cairo" })],
    ["b", makeThread({ key: "b", workspace: "apia" })]
  ]);
  const model = (key) => ({ threadKey: key, playbook: null, question: { title: `${key}: Fable capped. Switch model?`, body: "x", options: ["switched", "wait"], dedupeKey: `limit:${key}:model`, kind: "limit" } });
  const grouped = groupQuestions([model("a"), model("b")], byKey);
  assert.equal(grouped.length, 2);
  assert.ok(grouped.every((q) => q.options.includes("switched")));
});

test("added on a grouped cap question resumes every reachable thread and closes the outreach item", async (t) => {
  const resolved = [];
  const capped = ["t1", "t2"].map((id) => makeThread({
    key: `codex:${id}`, id, cwd: `/work/${id}`, agentStatus: "error",
    error: { kind: "session-limit", text: "You've hit your weekly limit", resetAt: new Date(NOW + 30 * 60 * MIN).toISOString() }
  }));
  const { supervisor, delivered } = fixture(t, { threads: capped });
  supervisor.runtime = { outreach: { resolve: (id, decision, opts) => resolved.push([id, decision, opts.status]) } };
  await supervisor.tick({ reason: "test" });
  const group = supervisor.getState().questions.find((q) => q.dedupeKey === "limit:group");
  assert.ok(group, "grouped cap question");
  supervisor.store.markQuestionNotified(group.id, { outreachId: "out_1" });
  const result = await supervisor.answerQuestion(group.id, "added");
  assert.equal(result.delivery.status, "sent");
  assert.equal(delivered.length, 2);
  assert.ok(delivered.every((d) => /added account capacity/.test(d.message)));
  assert.deepEqual(resolved, [["out_1", "added", "acted"]]);
});

test("fleet-scan --data-dir reads a copy and never writes the source store", async (t) => {
  const { scratchCopy } = await import("../scripts/fleet-scan.mjs");
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-scan-src-"));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  fs.mkdirSync(path.join(source, "fleet"));
  const original = JSON.stringify({ version: 1, mode: "auto", questions: [] });
  fs.writeFileSync(path.join(source, "fleet", "state.json"), original);
  const scratch = scratchCopy(source);
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  assert.notEqual(scratch, source);
  fs.writeFileSync(path.join(scratch, "fleet", "state.json"), "{}");
  assert.equal(fs.readFileSync(path.join(source, "fleet", "state.json"), "utf8"), original);
});

test("unreachable and failed owner answers stay open until delivered", async (t) => {
  const thread = makeThread({ writerLocked: true, meta: { pendingQuestion: { text: "Which plan?", options: ["Starter", "Business annual (recommended)"] } } });
  const { supervisor, delivered } = fixture(t, { threads: [thread] });
  await supervisor.tick();
  const question = supervisor.getState().questions.find((q) => q.kind === "agent-ask");
  assert.deepEqual(question.options, ["Starter", "Business annual (recommended)"]);
  assert.equal((await supervisor.answerQuestion(question.id, question.options[1])).question.status, "open");
  assert.equal(delivered.length, 0);
  thread.writerLocked = false;
  await supervisor.tick();
  assert.equal((await supervisor.answerQuestion(question.id, question.options[1])).question.status, "answered");
  assert.match(delivered[0].message, /Business annual \(recommended\)/);

  const failed = fixture(t, { threads: [thread], deliverStatus: "failed" });
  await failed.supervisor.tick();
  const q = failed.supervisor.getState().questions[0];
  assert.equal((await failed.supervisor.answerQuestion(q.id, q.options[0])).question.status, "open");
});

test("partial grouped recovery retains unanswered threads without resending successful ones", async (t) => {
  const threads = ["a", "b"].map((id) => makeThread({ key: `codex:${id}`, id, writerLocked: id === "b" }));
  const { supervisor, delivered } = fixture(t, { threads });
  await supervisor.tick();
  const q = supervisor.store.upsertQuestion({ kind: "limit", dedupeKey: "cap", title: "Add capacity?", options: ["added"], threadKeys: threads.map((x) => x.key) });
  assert.equal((await supervisor.answerQuestion(q.id, "added")).question.status, "open");
  supervisor.lastThreads.get("codex:b").writerLocked = false;
  assert.equal((await supervisor.answerQuestion(q.id, "added")).question.status, "answered");
  assert.deepEqual(delivered.map((x) => x.thread.key), ["codex:a", "codex:b"]);
});

test("observe mode invalidates proposed sends", async (t) => {
  const { supervisor, delivered } = fixture(t, { mode: "propose" });
  await supervisor.tick();
  const action = supervisor.getState().actions.find((x) => x.status === "proposed");
  supervisor.setMode("observe");
  assert.equal(await supervisor.sendProposed(action.id), null);
  assert.equal(delivered.length, 0);
  assert.equal(supervisor.store.action(action.id).status, "stale");
});

test("login recovery keeps a retry for each stopped thread", async (t) => {
  const threads = ["a", "b"].map((id) => makeThread({ key: `codex:${id}`, id, agentStatus: "error", error: { kind: "logged-out" } }));
  const { supervisor, delivered } = fixture(t, { threads });
  await supervisor.tick();
  const questions = supervisor.getState().questions.filter((q) => q.options.includes("retry"));
  assert.equal(questions.length, 2);
  for (const q of questions) await supervisor.answerQuestion(q.id, "retry");
  assert.equal(delivered.length, 2);
});

test("branch discovery reaches new branches before refreshing expired negative lookups", async (t) => {
  let now = NOW;
  const lookedUp = [];
  const { supervisor } = fixture(t, { now: () => now, deps: { findPrForBranch: async (_, branch) => { lookedUp.push(branch); return null; } } });
  const threads = Array.from({ length: 65 }, (_, i) => makeThread({ cwd: `/work/b${i}`, branch: `branch-${i}`, prRefs: [] }));
  for (let i = 0; i < 9; i++) {
    await supervisor.resolvePrRefs(threads, new Map(), supervisor.config, null, {});
    now += 5 * MIN;
  }
  assert.equal(new Set(lookedUp).size, 65);
});

test("free text questions send no invented answer", async (t) => {
  const { supervisor, delivered } = fixture(t, { threads: [makeThread({ meta: { pendingQuestion: { text: "What should it be called?", options: ["open thread"] } } })] });
  await supervisor.tick();
  const q = supervisor.getState().questions[0];
  assert.deepEqual(q.options, ["open thread"]);
  assert.equal((await supervisor.answerQuestion(q.id, "open thread")).question.status, "open");
  assert.equal(delivered.length, 0);
});

// A fake background send: "sent" now, whether it reached the agent later.
function backgroundExecutor(reachedFor) {
  const delivered = [];
  return {
    delivered,
    deliver: async (args) => {
      delivered.push(args);
      const sent = { status: "sent", route: args.route, detail: "started in background", actionId: null };
      Object.defineProperty(sent, "done", { value: Promise.resolve(reachedFor(args.thread.key)) });
      return sent;
    },
    inFlight: () => [],
    whenIdle: async () => {}
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("an owner answer reopens when its background send fails after launch", async (t) => {
  const thread = makeThread({ meta: { pendingQuestion: { text: "Which plan?", options: ["Starter", "Business annual (recommended)"] } } });
  const failing = backgroundExecutor(() => false);
  const { supervisor } = fixture(t, { threads: [thread], deps: { executor: failing } });
  await supervisor.tick();
  const question = supervisor.getState().questions.find((q) => q.kind === "agent-ask");
  supervisor.store.markQuestionNotified(question.id, { outreachId: "out_1" });
  const result = await supervisor.answerQuestion(question.id, "Starter");
  assert.equal(result.question.status, "answered");
  await settle();
  const reopened = supervisor.store.question(question.id);
  assert.equal(reopened.status, "open");
  // The overlay copy was resolved as acted, so the notifier posts it again.
  assert.equal(reopened.outreachId, null);
  await supervisor.tick();
  assert.ok(supervisor.getState().questions.some((q) => q.id === question.id));

  const reaching = fixture(t, { threads: [thread], deps: { executor: backgroundExecutor(() => true) } });
  await reaching.supervisor.tick();
  const q = reaching.supervisor.getState().questions.find((x) => x.kind === "agent-ask");
  await reaching.supervisor.answerQuestion(q.id, "Starter");
  await settle();
  assert.equal(reaching.supervisor.store.question(q.id).status, "answered");
});

test("a grouped resume retries only the threads whose background send failed", async (t) => {
  const threads = ["a", "b"].map((id) => makeThread({ key: `codex:${id}`, id }));
  const executor = backgroundExecutor((key) => key !== "codex:b");
  const { supervisor } = fixture(t, { threads, deps: { executor } });
  await supervisor.tick();
  const q = supervisor.store.upsertQuestion({ kind: "limit", dedupeKey: "cap", title: "Add capacity?", options: ["added"], threadKeys: threads.map((x) => x.key) });
  assert.equal((await supervisor.answerQuestion(q.id, "added")).question.status, "answered");
  await settle();
  const reopened = supervisor.store.question(q.id);
  assert.equal(reopened.status, "open");
  assert.deepEqual(reopened.deliveredThreadKeys, ["codex:a"]);
  executor.delivered.length = 0;
  await supervisor.answerQuestion(q.id, "added");
  assert.deepEqual(executor.delivered.map((x) => x.thread.key), ["codex:b"]);
});

// The real executor over a runner whose background child exits non-zero.
function failingRunDeps() {
  return { executor: null, run: async () => ({ code: 1, stdout: "", stderr: "boom", timedOut: false, error: null }) };
}

test("a counted nudge that fails in the background gives back its own attempt", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-undo-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { supervisor } = fixture(t, { mode: "auto", threads: [makeThread({ cwd })], deps: failingRunDeps() });
  await supervisor.tick();
  await supervisor.executor.whenIdle();
  await settle();
  const ledger = supervisor.store.ledgerFor("codex:t1");
  assert.equal(ledger.nudges.length, 1);
  assert.equal(ledger.nudges[0].status, "failed");
  assert.equal(ledger.attemptsWithoutProgress, 0);
  assert.ok(ledger.lastNudgeAt, "a failed send still starts the cooldown");
});

test("an owner answer or escalation that fails in the background leaves earlier counted nudges alone", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-undo-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const counted = (store, key, n) => { for (let i = 0; i < n; i++) store.recordNudge(key, { playbook: "merge-ready", route: "codex-exec", status: "sent" }); };

  // Owner answers are recorded as "owner-answer" and count nothing.
  const asking = makeThread({ cwd, meta: { pendingQuestion: { text: "Which plan?", options: ["Starter", "Business"] } } });
  const answered = fixture(t, { threads: [asking], deps: failingRunDeps() });
  counted(answered.supervisor.store, "codex:t1", 2);
  await answered.supervisor.tick();
  const question = answered.supervisor.getState().questions.find((q) => q.kind === "agent-ask");
  assert.equal((await answered.supervisor.answerQuestion(question.id, "Starter")).delivery.status, "sent");
  await answered.supervisor.executor.whenIdle();
  await settle();
  assert.equal(answered.supervisor.store.ledgerFor("codex:t1").attemptsWithoutProgress, 2);
  assert.equal(answered.supervisor.store.question(question.id).status, "open", "the failed answer is still reopened");

  // An escalation is recorded on the thread that raised it, not on the
  // manager it was delivered to, so the manager's own nudges stay counted.
  const waiting = makeThread({
    key: "conductor:w1", kind: "conductor", id: "w1", workspace: "apia", cwd: "/work/w1", agentStatus: "waiting",
    lastAgentText: "bb-quick is running.", openTasks: [{ id: "task1", description: "bb-quick on BuildBot3", startedAt: ago(20 * MIN) }]
  });
  const manager = makeManager({ key: "codex:mgr", kind: "codex", cwd, live: null });
  const escalated = fixture(t, { mode: "auto", threads: [waiting], manager, deps: failingRunDeps() });
  counted(escalated.supervisor.store, manager.key, 1);
  await escalated.supervisor.tick();
  assert.equal(escalated.supervisor.store.ledgerFor(waiting.key).nudges.at(-1).status, "escalated");
  await escalated.supervisor.executor.whenIdle();
  await settle();
  assert.equal(escalated.supervisor.store.ledgerFor(manager.key).attemptsWithoutProgress, 1);
  assert.equal(escalated.supervisor.store.ledgerFor(manager.key).nudges.at(-1).status, "sent");
});

test("a failed Codex source keeps its proposals and grouped questions open", async (t) => {
  let broken = false;
  const thread = makeThread();
  const { supervisor } = fixture(t, {
    mode: "propose",
    threads: [thread],
    deps: { listCodexThreads: async () => { if (broken) throw new Error("database is locked"); return [thread]; } }
  });
  await supervisor.tick();
  const proposed = supervisor.getState().actions.find((a) => a.status === "proposed");
  assert.ok(proposed);
  const group = supervisor.store.upsertQuestion({ kind: "limit", dedupeKey: "limit:group", title: "2 threads capped", options: ["wait", "added"], threadKeys: [thread.key, "codex:t2"] });
  broken = true;
  const snapshot = await supervisor.tick();
  assert.match(snapshot.sourceErrors.codex, /locked/);
  assert.equal(supervisor.store.action(proposed.id).status, "proposed");
  assert.equal(supervisor.store.question(group.id).status, "open");
  broken = false;
  await supervisor.tick();
  assert.equal(supervisor.store.action(proposed.id).status, "proposed");
});

test("a worktree whose git read failed is never offered as ready to merge", async (t) => {
  const green = makePr({ ci: { state: "SUCCESS", failing: [], pending: [] }, unresolvedThreads: 0, mergeState: "CLEAN" });
  const { supervisor } = fixture(t, { prs: new Map([["acme/app#7", green]]), deps: { readLocalGit: async () => { throw new Error("git timed out"); } } });
  const snapshot = await supervisor.tick();
  assert.equal(snapshot.threads[0].state, "pr-not-ready");
  assert.deepEqual(snapshot.threads[0].blockers, ["local git unknown"]);
  assert.equal(supervisor.getState().questions.length, 0);
});

test("chats sharing one checkout never take its branch's PR", async (t) => {
  // 21 Codex chats in one clone all recorded its branch and were each told
  // to finish that branch's PR. Only a chat alone in its checkout gets it.
  const seen = [];
  const supervisor = { skip: {}, deps: { findPrForBranch: async (repo, branch) => { seen.push(branch); return "acme/app#8091"; } }, branchLookups: new Map(), now: () => NOW };
  const shared = ["a", "b"].map((id) => makeThread({ key: `codex:${id}`, id, cwd: "/work/clone", branch: "feature/canvas", prRefs: [] }));
  const linked = makeThread({ key: "codex:c", id: "c", cwd: "/work/clone", branch: "feature/canvas", prRefs: ["acme/app#7"] });
  const alone = makeThread({ key: "codex:d", id: "d", cwd: "/work/own", branch: "feature/own", prRefs: [] });
  await FleetSupervisor.prototype.resolvePrRefs.call(supervisor, [...shared, linked, alone], new Map(), {}, null, {});
  assert.deepEqual(seen, ["feature/own"]);
  for (const thread of shared) {
    assert.deepEqual(thread.prRefs, [], thread.id);
    assert.notEqual(thread.prLookedUp, true, "unknown, not PR-less");
  }
  assert.deepEqual(linked.prRefs, ["acme/app#7"], "a PR the chat linked itself stays");
  assert.deepEqual(alone.prRefs, ["acme/app#8091"]);
  // Two subfolders of one checkout are the same checkout.
  seen.length = 0;
  const sub = ["/work/mono", "/work/mono/packages/api"].map((cwd, i) => makeThread({ key: `codex:s${i}`, id: `s${i}`, cwd, branch: "feature/mono", prRefs: [] }));
  const git = new Map(sub.map((thread) => [thread.cwd, { root: "/work/mono", branch: "feature/mono", head: null }]));
  await FleetSupervisor.prototype.resolvePrRefs.call(supervisor, sub, git, {}, null, {});
  assert.deepEqual(seen, []);
  assert.ok(sub.every((thread) => thread.prRefs.length === 0));
});

test("branch discovery passes the local head so a reused branch skips its old PR", async (t) => {
  const seen = [];
  const thread = makeThread({ prRefs: [] });
  const { supervisor } = fixture(t, { threads: [thread], deps: { findPrForBranch: async (repo, branch, config, opts) => { seen.push(opts.head); return null; } } });
  await supervisor.tick();
  assert.deepEqual(seen, [HEAD]);
});

// Background sends whose outcome the test settles by hand, per thread.
function heldExecutor() {
  const delivered = [];
  const outcomes = new Map();
  return {
    delivered,
    settle: (key, reached) => outcomes.get(key)(reached),
    deliver: async (args) => {
      delivered.push(args);
      const sent = { status: "sent", route: args.route, detail: "started in background", actionId: null };
      Object.defineProperty(sent, "done", { value: new Promise((resolve) => outcomes.set(args.thread.key, resolve)) });
      return sent;
    },
    inFlight: () => [],
    whenIdle: async () => {}
  };
}

test("one fast failure reopens a grouped resume without waiting for the slow threads", async (t) => {
  const threads = ["a", "b"].map((id) => makeThread({ key: `codex:${id}`, id }));
  const executor = heldExecutor();
  const { supervisor } = fixture(t, { threads, deps: { executor } });
  await supervisor.tick();
  const q = supervisor.store.upsertQuestion({ kind: "limit", dedupeKey: "cap", title: "Add capacity?", options: ["wait", "added"], threadKeys: threads.map((x) => x.key) });
  assert.equal((await supervisor.answerQuestion(q.id, "added")).question.status, "answered");
  executor.settle("codex:b", false);
  await settle();
  assert.equal(supervisor.store.question(q.id).status, "open");
  assert.deepEqual(supervisor.store.question(q.id).deliveredThreadKeys, ["codex:a"]);
  executor.settle("codex:a", true);
});

test("a late send failure never undoes a newer, different owner answer", async (t) => {
  const threads = ["a", "b"].map((id) => makeThread({ key: `codex:${id}`, id, writerLocked: id === "b" }));
  const executor = heldExecutor();
  const { supervisor } = fixture(t, { threads, deps: { executor } });
  await supervisor.tick();
  const q = supervisor.store.upsertQuestion({ kind: "limit", dedupeKey: "cap", title: "Add capacity?", options: ["wait", "added"], threadKeys: threads.map((x) => x.key) });
  assert.equal((await supervisor.answerQuestion(q.id, "added")).question.status, "open");
  assert.equal((await supervisor.answerQuestion(q.id, "wait")).question.status, "answered");
  executor.settle("codex:a", false);
  await settle();
  const stored = supervisor.store.question(q.id);
  assert.equal(stored.status, "answered");
  assert.equal(stored.answer, "wait");
  assert.deepEqual(stored.deliveredThreadKeys, []);
});

test("a grouped retry does not close while an earlier resume failed mid-send", async (t) => {
  const threads = ["a", "b"].map((id) => makeThread({ key: `codex:${id}`, id, writerLocked: id === "b" }));
  const executor = heldExecutor();
  const { supervisor } = fixture(t, { threads, deps: { executor } });
  await supervisor.tick();
  const q = supervisor.store.upsertQuestion({ kind: "limit", dedupeKey: "cap", title: "Add capacity?", options: ["wait", "added"], threadKeys: threads.map((x) => x.key) });
  await supervisor.answerQuestion(q.id, "added");
  supervisor.lastThreads.get("codex:b").writerLocked = false;
  const deliver = executor.deliver;
  // codex:a's first resume fails while codex:b is being sent.
  executor.deliver = async (args) => { executor.settle("codex:a", false); await settle(); return deliver(args); };
  const retry = await supervisor.answerQuestion(q.id, "added");
  assert.equal(retry.question.status, "open");
  assert.equal(retry.delivery.status, "blocked");
  executor.deliver = deliver;
  executor.delivered.length = 0;
  await supervisor.answerQuestion(q.id, "added");
  assert.deepEqual(executor.delivered.map((x) => x.thread.key), ["codex:a"]);
});

test("a failed source keeps its threads in an open grouped question", async (t) => {
  let broken = false;
  const capped = (id, kind = "codex") => makeThread({ key: `${kind}:${id}`, kind, id, cwd: `/work/${id}`, agentStatus: "error", error: { kind: "session-limit", text: "You've hit your weekly limit", resetAt: new Date(NOW + 30 * 60 * MIN).toISOString() } });
  const threads = [capped("a"), capped("b", "claude"), capped("c", "claude")];
  const { supervisor } = fixture(t, {
    threads,
    deps: { listCodexThreads: async () => { if (broken) throw new Error("database is locked"); return threads.filter((x) => x.kind === "codex"); } }
  });
  await supervisor.tick();
  const group = supervisor.getState().questions.find((q) => q.dedupeKey === "limit:group");
  assert.deepEqual(group.threadKeys, ["codex:a", "claude:b", "claude:c"]);
  broken = true;
  await supervisor.tick();
  const kept = supervisor.store.question(group.id);
  assert.equal(kept.status, "open");
  assert.deepEqual(kept.threadKeys, ["codex:a", "claude:b", "claude:c"]);
});

test("a one-tick git failure keeps an open ready question instead of closing and re-asking it", async (t) => {
  let gitBroken = false;
  const green = makePr({ ci: { state: "SUCCESS", failing: [], pending: [] }, unresolvedThreads: 0, mergeState: "CLEAN" });
  const { supervisor } = fixture(t, {
    prs: new Map([["acme/app#7", green]]),
    deps: { readLocalGit: async () => { if (gitBroken) throw new Error("git timed out"); return { head: HEAD, branch: "spencer/fix", upstream: "origin/spencer/fix", ahead: 0, remote: "acme/app" }; } }
  });
  await supervisor.tick();
  const [ready] = supervisor.getState().questions;
  assert.ok(ready);
  gitBroken = true;
  await supervisor.tick();
  assert.equal(supervisor.store.question(ready.id).status, "open");
  gitBroken = false;
  await supervisor.tick();
  assert.deepEqual(supervisor.getState().questions.map((q) => q.id), [ready.id]);
});

test("a new local head is a new PR lookup, not a cached answer", async (t) => {
  let head = HEAD;
  const seen = [];
  const thread = makeThread({ prRefs: [] });
  const { supervisor } = fixture(t, {
    threads: [thread],
    deps: {
      readLocalGit: async () => ({ head, branch: "spencer/fix", upstream: "origin/spencer/fix", ahead: 0, remote: "acme/app" }),
      findPrForBranch: async (repo, branch, config, opts) => { seen.push(opts.head); return null; }
    }
  });
  await supervisor.tick();
  thread.prRefs = [];
  await supervisor.tick();
  assert.deepEqual(seen, [HEAD]);
  head = "f".repeat(40);
  thread.prRefs = [];
  await supervisor.tick();
  assert.deepEqual(seen, [HEAD, "f".repeat(40)]);
});

test("cached PR refs survive a git failure and a spent lookup budget", async (t) => {
  let gitBroken = false;
  let head = HEAD;
  const ids = Array.from({ length: 10 }, (_, i) => `t${i}`);
  const fresh = () => ids.map((id) => makeThread({ key: `codex:${id}`, id, cwd: `/work/${id}`, branch: `spencer/${id}`, prRefs: [] }));
  const prs = new Map(ids.map((id, i) => [`acme/app#${i + 1}`, makePr({ ref: `acme/app#${i + 1}`, number: i + 1, headRef: `spencer/${id}` })]));
  const { supervisor } = fixture(t, {
    prs,
    deps: {
      listCodexThreads: async () => fresh(),
      readLocalGit: async (cwd) => { if (gitBroken) throw new Error("git timed out"); return { head, branch: `spencer/${path.basename(cwd)}`, upstream: null, ahead: 0, remote: "acme/app" }; },
      findPrForBranch: async (repo, branch) => `acme/app#${Number(branch.slice("spencer/t".length)) + 1}`
    }
  });
  await supervisor.tick();
  await supervisor.tick();
  assert.ok((await supervisor.tick()).threads.every((row) => row.pr), "all ten resolved and cached");
  gitBroken = true;
  assert.ok((await supervisor.tick()).threads.every((row) => row.pr), "unknown head keeps the cache");
  gitBroken = false;
  head = "f".repeat(40);
  assert.ok((await supervisor.tick()).threads.every((row) => row.pr), "past the lookup budget the cached ref stays");
});

test("a no-PR thread counts as having no PR only once GitHub answered", async (t) => {
  // Past the lookup budget, or on a failed lookup, a branch's PR is unknown:
  // policy must not read the thread as PR-less (idle-report, error paths).
  const ids = Array.from({ length: 50 }, (_, i) => `n${i}`);
  const seen = [];
  const threads = ids.map((id) => makeThread({ key: `codex:${id}`, id, cwd: `/work/${id}`, branch: `spencer/${id}`, prRefs: [] }));
  const supervisor = { skip: {}, deps: { findPrForBranch: async (repo, branch) => { seen.push(branch); if (branch === "spencer/n1") throw new Error("gh timed out"); return null; } }, branchLookups: new Map(), now: () => NOW };
  const sourceErrors = {};
  await FleetSupervisor.prototype.resolvePrRefs.call(supervisor, threads, new Map(), {}, null, sourceErrors);
  const looked = threads.filter((thread) => thread.prLookedUp === true).map((thread) => thread.id);
  assert.equal(seen.length, 48, "first-lookup budget");
  assert.ok(!looked.includes("n1"), "a failed lookup is unknown");
  assert.ok(looked.length === 47 && !looked.includes("n48") && !looked.includes("n49"), "past the budget is unknown");
  // Known branches refresh eight a scan; past that an expired "no PR" is unknown.
  seen.length = 0;
  for (const thread of threads) delete thread.prLookedUp;
  supervisor.now = () => NOW + 31 * MIN;
  await FleetSupervisor.prototype.resolvePrRefs.call(supervisor, threads, new Map(), {}, null, sourceErrors);
  assert.equal(seen.filter((branch) => !["spencer/n1", "spencer/n48", "spencer/n49"].includes(branch)).length, 8, "refresh budget");
  assert.equal(seen.length, 11, "plus the three never answered");
  supervisor.now = () => NOW;
  // Nothing to look up (trunk, no branch) is known to have no PR.
  const trunk = [makeThread({ key: "codex:m", id: "m", branch: "main", prRefs: [] }), makeThread({ key: "codex:z", id: "z", branch: null, prRefs: [] })];
  await FleetSupervisor.prototype.resolvePrRefs.call(supervisor, trunk, new Map(), {}, null, sourceErrors);
  assert.ok(trunk.every((thread) => thread.prLookedUp === true));
  const noRepo = [makeThread({ key: "codex:r", id: "r", repo: null, branch: "spencer/r", prRefs: [] })];
  await FleetSupervisor.prototype.resolvePrRefs.call(supervisor, noRepo, new Map(), {}, null, sourceErrors);
  assert.notEqual(noRepo[0].prLookedUp, true, "an unreadable repo leaves the PR unknown");
  // A cached "no PR" counts only for the head it was answered for.
  const HEAD2 = "b".repeat(40);
  const cachedSup = { skip: {}, deps: { findPrForBranch: async () => null }, branchLookups: new Map([["acme/app:spencer/c", { ref: null, at: NOW, head: HEAD2 }]]), now: () => NOW };
  const same = [makeThread({ key: "codex:c", id: "c", cwd: "/work/c", branch: "spencer/c", prRefs: [] })];
  await FleetSupervisor.prototype.resolvePrRefs.call(cachedSup, same, new Map([["/work/c", { head: HEAD2, branch: "spencer/c" }]]), {}, null, sourceErrors);
  assert.equal(same[0].prLookedUp, true);
  const gitFailed = [makeThread({ key: "codex:c", id: "c", cwd: "/work/c", branch: "spencer/c", prRefs: [] })];
  await FleetSupervisor.prototype.resolvePrRefs.call(cachedSup, gitFailed, new Map(), {}, null, sourceErrors);
  assert.notEqual(gitFailed[0].prLookedUp, true, "git failed: the cached answer was for a known head");
});

// 10-12 replay: the first scan after a restart spent its eight lookups on
// other chats, so a93b6870 (Feedback portal) was mapped to bb-website#280,
// a PR it created in another repo, not its branch's open #7621, and
// 01a0f89f read as having no PR until #7163 was looked up two scans later.
test("the first scan after a restart looks up every branch, a few at a time", async (t) => {
  const others = Array.from({ length: 30 }, (_, i) => makeThread({ key: `codex:o${i}`, kind: "codex", id: `o${i}`, cwd: `/work/o${i}`, branch: `spencer/o${i}`, prRefs: [] }));
  const portal = makeThread({ key: "conductor:a93b6870", kind: "conductor", id: "a93b6870", title: "Feedback portal & boards", workspace: "portal",
    cwd: "/work/portal", branch: "feature/portal-ai-subdomains", repo: null, prRefs: [], meta: { prCreated: ["buildbetter-app/bb-website#280"] } });
  const audio = makeThread({ key: "codex:01a0f89f", kind: "codex", id: "01a0f89f", cwd: "/work/audio", branch: "codex/bob-adhoc-setting", prRefs: [] });
  const branchPrs = new Map([["feature/portal-ai-subdomains", `${BB}#7621`], ["codex/bob-adhoc-setting", `${BB}#7163`]]);
  const states = new Map([[`${BB}#7621`, "OPEN"], ["buildbetter-app/bb-website#280", "OPEN"], [`${BB}#7163`, "MERGED"]]);
  let inFlight = 0;
  let most = 0;
  const looked = [];
  const { supervisor } = fixture(t, {
    threads: [...others, portal, audio],
    deps: {
      readLocalGit: async (cwd) => {
        const thread = [...others, portal, audio].find((one) => one.cwd === cwd);
        return { head: HEAD, branch: thread.branch, upstream: null, ahead: 0, remote: BB };
      },
      findPrForBranch: async (repo, branch) => {
        looked.push(branch);
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        return branchPrs.get(branch) ?? null;
      },
      fetchPrStates: async (refs) => new Map(refs.filter((ref) => states.get(ref)).map((ref) => [ref, makePr({ ref, repo: ref.split("#")[0], number: Number(ref.split("#")[1]), state: states.get(ref) })]))
    }
  });
  const rows = (await supervisor.tick({ reason: "test" })).threads;
  assert.equal(looked.length, 32, "every unseen branch on the first scan");
  assert.ok(most > 1 && most <= 6, `lookups run a few at a time (${most})`);
  assert.equal(rows.find((row) => row.key === portal.key).pr.ref, `${BB}#7621`);
  assert.equal(rows.find((row) => row.key === audio.key).pr.ref, `${BB}#7163`);
  // The next scan reads the cache, not GitHub.
  looked.length = 0;
  await supervisor.tick({ reason: "test" });
  assert.equal(looked.length, 0);
});

test("a failed source never splits its open group into a second question", async (t) => {
  let broken = false;
  const capped = (id, kind) => makeThread({ key: `${kind}:${id}`, kind, id, cwd: `/work/${id}`, agentStatus: "error", error: { kind: "session-limit", text: "You've hit your weekly limit", resetAt: new Date(NOW + 30 * 60 * MIN).toISOString() } });
  const threads = [capped("a", "codex"), capped("b", "claude")];
  const { supervisor, notified } = fixture(t, {
    threads,
    deps: { listCodexThreads: async () => { if (broken) throw new Error("database is locked"); return threads.filter((x) => x.kind === "codex"); } }
  });
  await supervisor.tick();
  const group = supervisor.getState().questions.find((q) => q.dedupeKey === "limit:group");
  assert.ok(group);
  const before = notified.length;
  broken = true;
  await supervisor.tick();
  assert.deepEqual(supervisor.getState().questions.map((q) => q.id), [group.id]);
  assert.equal(notified.slice(before).some((q) => q.id !== group.id), false);
});

test("a git failure keeps the ready question of a thread whose repo only git knew", async (t) => {
  let gitBroken = false;
  const green = makePr({ ci: { state: "SUCCESS", failing: [], pending: [] }, unresolvedThreads: 0, mergeState: "CLEAN" });
  const { supervisor } = fixture(t, {
    prs: new Map([["acme/app#7", green]]),
    deps: {
      listCodexThreads: async () => [makeThread({ repo: null, prRefs: [] })],
      readLocalGit: async () => { if (gitBroken) throw new Error("git timed out"); return { head: HEAD, branch: "spencer/fix", upstream: "origin/spencer/fix", ahead: 0, remote: "acme/app" }; },
      findPrForBranch: async () => "acme/app#7"
    }
  });
  await supervisor.tick();
  const [ready] = supervisor.getState().questions;
  assert.ok(ready);
  gitBroken = true;
  await supervisor.tick();
  assert.equal(supervisor.store.question(ready.id).status, "open");
});

test("a grouped resume that the tick resolved mid-send is not reported as failed", async (t) => {
  const threads = ["a", "b"].map((id) => makeThread({ key: `codex:${id}`, id }));
  const executor = heldExecutor();
  const { supervisor } = fixture(t, { threads, deps: { executor } });
  await supervisor.tick();
  const q = supervisor.store.upsertQuestion({ kind: "limit", dedupeKey: "cap", title: "Add capacity?", options: ["wait", "added"], threadKeys: threads.map((x) => x.key) });
  const deliver = executor.deliver;
  executor.deliver = async (args) => {
    if (args.thread.key === "codex:b") supervisor.store.resolveQuestion(q.id);
    return deliver(args);
  };
  const result = await supervisor.answerQuestion(q.id, "added");
  assert.equal(result.delivery.status, "sent");
  executor.settle("codex:a", true);
  executor.settle("codex:b", true);
});

test("manager escalations from a thread never spend that thread's nudge budget", async (t) => {
  let now = NOW;
  const waiting = makeThread({
    key: "conductor:w1", kind: "conductor", id: "w1", workspace: "apia", cwd: "/work/w1", agentStatus: "waiting",
    live: { peerName: "apia", pid: 7 }, lastAgentText: "bb-quick is running.",
    openTasks: [{ id: "task1", description: "bb-quick on BuildBot3", startedAt: ago(20 * MIN) }]
  });
  const { supervisor, delivered } = fixture(t, { mode: "auto", threads: [waiting], now: () => now, manager: makeManager() });
  for (let hour = 0; hour < 3; hour += 1) {
    // The agent posts along the way; an hour of silence would get it a status check.
    waiting.lastAgentAt = waiting.lastActivityAt = new Date(now - MIN).toISOString();
    await supervisor.tick({ reason: "test" });
    now += 61 * MIN;
  }
  assert.equal(delivered.filter((d) => d.playbook === "manager-bb3").length, 3);
  assert.equal(supervisor.store.ledgerFor("conductor:w1").attemptsWithoutProgress, 0);
  // bb-quick ends on the same head: the agent gets its first real nudge.
  waiting.openTasks = [];
  waiting.agentStatus = "idle";
  await supervisor.tick({ reason: "test" });
  assert.equal(delivered.at(-1).thread.key, "conductor:w1");
  assert.equal(supervisor.getState().questions.filter((q) => q.kind === "stuck").length, 0);
});

test("a GitHub outage keeps a ready question and proposals open", async (t) => {
  let down = null;
  const green = makePr({ ci: { state: "SUCCESS", failing: [], pending: [] }, unresolvedThreads: 0, mergeState: "CLEAN" });
  const fetchPrStates = (pr) => async (refs, config, opts) => {
    if (down === "throw") throw new Error("gh: 502");
    // "empty": the gh call failed, so GitHub could not answer these refs.
    if (down === "empty") for (const ref of refs) opts.unread.add(ref);
    return down ? new Map() : new Map([["acme/app#7", pr]]);
  };
  const { supervisor } = fixture(t, { deps: { fetchPrStates: fetchPrStates(green) } });
  await supervisor.tick();
  const [ready] = supervisor.getState().questions;
  assert.ok(ready);
  for (const mode of ["empty", "throw"]) {
    down = mode;
    await supervisor.tick();
    assert.equal(supervisor.store.question(ready.id).status, "open");
  }
  down = null;
  await supervisor.tick();
  assert.deepEqual(supervisor.store.openQuestions().map((q) => q.id), [ready.id]);

  const proposing = fixture(t, { mode: "propose", deps: { fetchPrStates: fetchPrStates(makePr()) } });
  await proposing.supervisor.tick();
  const proposed = proposing.supervisor.getState().actions.find((a) => a.status === "proposed");
  assert.ok(proposed);
  down = "empty";
  await proposing.supervisor.tick();
  assert.equal(proposing.supervisor.store.action(proposed.id).status, "proposed");
  down = null;
  await proposing.supervisor.tick();
  assert.deepEqual(proposing.supervisor.getState().actions.filter((a) => a.status === "proposed").map((a) => a.id), [proposed.id]);

  // GitHub answered "no such PR": a real answer, so the question closes.
  down = "notfound";
  await supervisor.tick();
  assert.equal(supervisor.store.question(ready.id).status, "resolved");
});

test("remembered threads past the send cap or in a failed source resume on a later tick", async (t) => {
  let now = NOW;
  let codexFails = false;
  const threads = ["t1", "t2", "t3"].map((id) => makeThread({ key: `codex:${id}`, id, cwd: `/work/${id}`, agentStatus: "aborted", error: null, prRefs: [] }));
  const { supervisor, delivered } = fixture(t, {
    mode: "auto", threads, prs: new Map(), now: () => now, limits: { maxSendsPerTick: 2 },
    deps: { listCodexThreads: async () => { if (codexFails) throw new Error("database is locked"); return threads; } }
  });
  supervisor.store.setInfraDown("lb", true);
  supervisor.store.setInfraBlocked("lb", threads.map((x) => x.key));
  await supervisor.tick({ reason: "test" });
  assert.deepEqual(delivered.map((d) => d.thread.key), ["codex:t1", "codex:t2"]);
  assert.deepEqual(supervisor.store.infraBlocked("lb"), ["codex:t3"]);
  codexFails = true;
  now += 5 * MIN;
  await supervisor.tick({ reason: "test" });
  assert.equal(delivered.length, 2);
  assert.deepEqual(supervisor.store.infraBlocked("lb"), ["codex:t3"]);
  codexFails = false;
  now += 5 * MIN;
  await supervisor.tick({ reason: "test" });
  assert.deepEqual(delivered.map((d) => d.thread.key), ["codex:t1", "codex:t2", "codex:t3"]);
  assert.equal(delivered[2].playbook, "infra-recovered");
  assert.deepEqual(supervisor.store.infraBlocked("lb"), []);
});

test("a remembered thread the owner or agent picked up after recovery gets no late resume", async (t) => {
  let now = NOW;
  const at = (ms) => new Date(ms).toISOString();
  // The owner typed "LB is back, continue" two minutes before recovery.
  const thread = makeThread({ agentStatus: "aborted", error: null, prRefs: [], lastUserAt: at(NOW - 2 * MIN), lastAgentAt: at(NOW - MIN), lastActivityAt: at(NOW - MIN) });
  const { supervisor, delivered } = fixture(t, { mode: "auto", threads: [thread], prs: new Map(), now: () => now });
  supervisor.store.setInfraDown("lb", true);
  supervisor.store.setInfraBlocked("lb", ["codex:t1"]);
  await supervisor.tick({ reason: "test" });
  assert.equal(delivered.length, 0, "owner active: wait");
  assert.deepEqual(supervisor.store.infraBlocked("lb"), []);
  now += 15 * MIN;
  await supervisor.tick({ reason: "test" });
  assert.equal(delivered.length, 0, "no stale resume once the owner window closes");
});

test("a thread hidden by a failed source is remembered for an hour at most", async (t) => {
  let now = NOW;
  let codexFails = true;
  const thread = makeThread({ agentStatus: "aborted", error: null, prRefs: [] });
  const { supervisor, delivered } = fixture(t, {
    mode: "auto", threads: [thread], prs: new Map(), now: () => now,
    deps: { listCodexThreads: async () => { if (codexFails) throw new Error("database is locked"); return [thread]; } }
  });
  supervisor.store.setInfraDown("lb", true);
  supervisor.store.setInfraBlocked("lb", ["codex:t1"]);
  await supervisor.tick({ reason: "test" });
  assert.deepEqual(supervisor.store.infraBlocked("lb"), ["codex:t1"]);
  now += 61 * MIN;
  await supervisor.tick({ reason: "test" });
  assert.deepEqual(supervisor.store.infraBlocked("lb"), []);
  codexFails = false;
  now += 5 * MIN;
  await supervisor.tick({ reason: "test" });
  // The memory is gone, so no infra-recovered note; the interrupted turn
  // itself still gets its plain resume.
  assert.deepEqual(delivered.map((d) => d.playbook), ["resume"]);
});

test("leaving Auto mid-scan stops that tick's sends", async (t) => {
  let supervisor = null;
  const prMap = new Map([["acme/app#7", makePr()]]);
  const built = fixture(t, { mode: "auto", deps: { fetchPrStates: async () => { supervisor.setMode("observe"); return prMap; } } });
  supervisor = built.supervisor;
  await supervisor.tick();
  assert.equal(built.delivered.length, 0);
  assert.equal(supervisor.getState().actions.filter((a) => a.status === "planned").length, 1);
});

test("a group widened while added is sending stays open for the new thread", async (t) => {
  const threads = ["a", "b"].map((id) => makeThread({ key: `codex:${id}`, id }));
  const { supervisor } = fixture(t, { threads });
  await supervisor.tick();
  const q = supervisor.store.upsertQuestion({ kind: "limit", dedupeKey: "cap", title: "Add capacity?", options: ["wait", "added"], threadKeys: ["codex:a"] });
  const deliver = supervisor.executor.deliver;
  supervisor.executor.deliver = async (args) => {
    supervisor.store.upsertQuestion({ kind: "limit", dedupeKey: "cap", title: "Add capacity?", options: ["wait", "added"], threadKeys: ["codex:a", "codex:b"] });
    return deliver(args);
  };
  const result = await supervisor.answerQuestion(q.id, "added");
  assert.equal(result.question.status, "open");
  assert.equal(result.delivery.status, "blocked");
});

// --- computer-use delivery (fake executor and readiness; no real app) -------

const uiMeta = (id, extra = {}) => ({ conductorWorkspaceId: `w-${id}`, conductorSessionId: id, conductorSessionTitle: "Fix billing", conductorWorkspaceSessions: 1, ...extra });
const readyDriver = (ready = true, detail = null) => ({ readiness: async () => ({ ready, detail }) });

test("computer-use mode types into the app for a writer-locked Codex thread and never relays to a terminal one", async (t) => {
  const locked = makeThread({ writerLocked: true, meta: { originator: "Codex Desktop" } });
  const terminal = makeThread({
    key: "claude:c1", kind: "claude", id: "c1", cwd: "/work/c1", live: { peerName: "cli-1", pid: 9, status: "idle" },
    lastAgentAt: ago(3 * 60 * MIN), lastActivityAt: ago(3 * 60 * MIN), meta: {}
  });
  const { supervisor, delivered, notified } = fixture(t, { mode: "auto", delivery: "computer-use", threads: [locked, terminal], deps: { uiDriver: readyDriver() } });
  const snapshot = await supervisor.tick({ reason: "test" });
  assert.deepEqual(delivered.map((d) => [d.thread.key, d.route]), [["codex:t1", "computer-use"]]);
  const rows = Object.fromEntries(snapshot.threads.map((row) => [row.key, row]));
  assert.equal(rows["codex:t1"].route, "computer-use");
  assert.equal(rows["claude:c1"].route, null);
  assert.ok(notified.some((q) => q.dedupeKey === "open:claude:c1"), "the terminal thread takes the open-it path");
  const settings = supervisor.getState().settings;
  assert.equal(settings.delivery, "computer-use");
  assert.equal(settings.deliveryReady, true);
});

test("computer-use not ready: the tick waits and sends nothing; computer-use-first falls back", async (t) => {
  const thread = makeThread({ meta: { originator: "Codex Desktop" } });
  const strict = fixture(t, { mode: "auto", delivery: "computer-use", threads: [thread], deps: { uiDriver: readyDriver(false, "screen locked") } });
  const snapshot = await strict.supervisor.tick({ reason: "test" });
  assert.equal(strict.delivered.length, 0);
  assert.equal(snapshot.threads[0].decision.action, "wait");
  assert.match(snapshot.threads[0].decision.reason, /computer use not ready: screen locked/);
  assert.equal(strict.supervisor.getState().settings.deliveryDetail, "screen locked");
  // A thread codex exec started falls back to it; one the Codex app started
  // waits, since the turn would lock the owner out of it in the app.
  const cli = makeThread({ meta: { originator: "codex_exec" } });
  const first = fixture(t, { mode: "auto", delivery: "computer-use-first", threads: [cli], deps: { uiDriver: readyDriver(false, "screen locked") } });
  await first.supervisor.tick({ reason: "test" });
  assert.deepEqual(first.delivered.map((d) => d.route), ["codex-exec"]);
  const app = fixture(t, { mode: "auto", delivery: "computer-use-first", threads: [thread], deps: { uiDriver: readyDriver(false, "screen locked") } });
  const waiting = await app.supervisor.tick({ reason: "test" });
  assert.equal(app.delivered.length, 0);
  assert.equal(waiting.threads[0].decision.action, "wait");
  assert.match(waiting.threads[0].decision.reason, /computer use not ready: screen locked/);
});

test("a blocked app send spends no attempt and no cooldown, but backs off before trying again", async (t) => {
  let now = NOW;
  const { supervisor, delivered } = fixture(t, { mode: "auto", delivery: "computer-use", deliverStatus: "blocked", now: () => now, deps: { uiDriver: readyDriver() } });
  await supervisor.tick({ reason: "test" });
  const ledger = supervisor.store.ledgerFor("codex:t1");
  assert.equal(ledger.attemptsWithoutProgress ?? 0, 0);
  assert.equal(ledger.lastNudgeAt ?? null, null);
  assert.equal(ledger.undelivered.count, 1);
  now += MIN;
  await supervisor.tick({ reason: "test" });
  assert.equal(delivered.length, 1, "backing off: 5 min after the first block");
  now += 5 * MIN;
  await supervisor.tick({ reason: "test" });
  assert.equal(delivered.length, 2);
});

test("a Conductor tab and the Codex thread it hosts get one typed message per tick", async (t) => {
  const tab = makeThread({ key: "conductor:s9", kind: "conductor", id: "s9", claudeSessionId: "t9", workspace: "madrid", cwd: "/work/s9", meta: uiMeta("s9") });
  const hosted = makeThread({ key: "codex:t9", id: "t9", cwd: "/work/t9", meta: { originator: "codex_sdk_ts" } });
  const { supervisor, delivered } = fixture(t, { mode: "auto", delivery: "computer-use", threads: [tab, hosted], deps: { uiDriver: readyDriver() } });
  const snapshot = await supervisor.tick({ reason: "test" });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].route, "computer-use");
  const routes = Object.fromEntries(snapshot.threads.map((row) => [row.key, row.route]));
  assert.deepEqual(routes, { "conductor:s9": "computer-use", "codex:t9": "computer-use" });
});

test("a grouped resume types once into a Conductor tab shared by two thread keys", async (t) => {
  const tab = makeThread({ key: "conductor:s9", kind: "conductor", id: "s9", claudeSessionId: "t9", workspace: "madrid", cwd: "/work/s9", meta: uiMeta("s9") });
  const hosted = makeThread({ key: "codex:t9", id: "t9", cwd: "/work/t9", meta: { originator: "codex_sdk_ts" } });
  const { supervisor, delivered } = fixture(t, { mode: "observe", delivery: "computer-use", threads: [tab, hosted], deps: { uiDriver: readyDriver() } });
  await supervisor.tick();
  const count = delivered.length;
  const q = supervisor.store.upsertQuestion({ kind: "limit", dedupeKey: "cap", title: "Add capacity?", options: ["added"], threadKeys: [tab.key, hosted.key] });
  assert.equal((await supervisor.answerQuestion(q.id, "added")).question.status, "answered");
  assert.equal(delivered.length - count, 1);
  assert.deepEqual([...supervisor.store.question(q.id).deliveredThreadKeys].sort(), ["codex:t9", "conductor:s9"]);
});

test("owner answers are typed into the app; blocked ones stay open with the reason", async (t) => {
  const asking = makeThread({ writerLocked: true, meta: { originator: "Codex Desktop", pendingQuestion: { text: "Which plan?", options: ["Starter", "Business"] } } });
  const typed = fixture(t, { delivery: "computer-use", threads: [asking], deps: { uiDriver: readyDriver() } });
  await typed.supervisor.tick();
  const question = typed.supervisor.getState().questions.find((q) => q.kind === "agent-ask");
  const answered = await typed.supervisor.answerQuestion(question.id, "Business");
  assert.equal(answered.question.status, "answered");
  assert.equal(typed.delivered[0].route, "computer-use");
  assert.equal(typed.supervisor.store.ledgerFor("codex:t1").nudges.at(-1).status, "owner-answer");

  const blocked = fixture(t, { delivery: "computer-use", threads: [asking], deliverStatus: "blocked", deps: { uiDriver: readyDriver() } });
  await blocked.supervisor.tick();
  const open = blocked.supervisor.getState().questions.find((q) => q.kind === "agent-ask");
  const result = await blocked.supervisor.answerQuestion(open.id, "Starter");
  assert.equal(result.question.status, "open");
  assert.equal(result.delivery.status, "blocked");

  const notReady = fixture(t, { delivery: "computer-use", threads: [asking], deps: { uiDriver: readyDriver(false, "Codex is not running") } });
  await notReady.supervisor.tick();
  const waiting = notReady.supervisor.getState().questions.find((q) => q.kind === "agent-ask");
  const held = await notReady.supervisor.answerQuestion(waiting.id, "Starter");
  // The owner decided; only the typing waits, so the answer is kept.
  assert.equal(held.question.status, "answered");
  assert.equal(held.delivery.status, "queued");
  assert.match(held.delivery.detail, /^Saved\. .*computer use not ready: Codex is not running/);
  assert.equal(notReady.delivered.length, 0);

  const terminal = makeThread({ key: "claude:c1", kind: "claude", id: "c1", live: { peerName: "cli-1", pid: 9, status: "idle" }, meta: { pendingQuestion: { text: "Which plan?", options: ["Starter", "Business"] } } });
  const cli = fixture(t, { delivery: "computer-use", threads: [terminal], deps: { uiDriver: readyDriver() } });
  await cli.supervisor.tick();
  const ask = cli.supervisor.getState().questions.find((q) => q.kind === "agent-ask");
  assert.ok(ask, "a terminal thread still gets its question");
  const none = await cli.supervisor.answerQuestion(ask.id, ask.options[0]);
  assert.equal(none.question.status, "open");
  assert.match(none.delivery.detail, /no app shows this thread/);
  assert.equal(cli.delivered.length, 0);
});

test("a grouped resume types into one app thread at a time", async (t) => {
  const capped = ["t1", "t2", "t3"].map((id) => makeThread({
    key: `codex:${id}`, id, title: `Fix ${id}`, cwd: `/work/${id}`, agentStatus: "error", writerLocked: true, meta: { originator: "Codex Desktop" },
    error: { kind: "session-limit", text: "You've hit your weekly limit", resetAt: new Date(NOW + 30 * 60 * MIN).toISOString() }
  }));
  let running = 0;
  let most = 0;
  const routes = [];
  const spent = [];
  const deadlines = [];
  const executor = {
    deliver: async (args) => {
      running += 1;
      most = Math.max(most, running);
      routes.push(args.route);
      spent.push(args.spentMs);
      deadlines.push(args.deadlineAt);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return { status: "sent", route: args.route, detail: "typed into Codex", actionId: null };
    },
    inFlight: () => [],
    whenIdle: async () => {}
  };
  const { supervisor } = fixture(t, { delivery: "computer-use", threads: capped, deps: { executor, uiDriver: readyDriver() } });
  await supervisor.tick({ reason: "test" });
  const group = supervisor.getState().questions.find((q) => q.dedupeKey === "limit:group");
  assert.ok(group);
  const deadlineAt = Date.now() + 100_000;
  const result = await supervisor.answerQuestion(group.id, "added", { deadlineAt });
  assert.equal(result.delivery.status, "sent");
  assert.equal(result.question.status, "answered");
  assert.deepEqual(routes, ["computer-use", "computer-use", "computer-use"]);
  assert.deepEqual(deadlines, [deadlineAt, deadlineAt, deadlineAt], "a remote caller's deadline reaches every send");
  assert.equal(most, 1);
  // Each send counts its time from the owner's request, earlier sends included,
  // so the whole request stays inside the broker's 5 min.
  assert.ok(spent.every(Number.isFinite), String(spent));
  // Ms wall-clock readings: each 5 ms send can read as less, but it grows.
  assert.ok(spent[1] > spent[0] && spent[2] > spent[1], String(spent));
});

test("a grouped resume starts no member past the caller's deadline: the rest are reported not sent", async (t) => {
  const capped = ["t1", "t2", "t3"].map((id) => makeThread({
    key: `codex:${id}`, id, title: `Fix ${id}`, cwd: `/work/${id}`, agentStatus: "error", writerLocked: true, meta: { originator: "Codex Desktop" },
    error: { kind: "session-limit", text: "You've hit your weekly limit", resetAt: new Date(NOW + 30 * 60 * MIN).toISOString() }
  }));
  const delivered = [];
  const executor = {
    // The first send uses up what the broker had left.
    deliver: async (args) => {
      delivered.push(args.thread.key);
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { status: "sent", route: args.route, detail: "typed into Codex", actionId: null };
    },
    inFlight: () => [],
    whenIdle: async () => {}
  };
  const { supervisor } = fixture(t, { delivery: "computer-use", threads: capped, deps: { executor, uiDriver: readyDriver() } });
  await supervisor.tick({ reason: "test" });
  const group = supervisor.getState().questions.find((q) => q.dedupeKey === "limit:group");
  assert.ok(group);
  const result = await supervisor.answerQuestion(group.id, "added", { deadlineAt: Date.now() + DEADLINE_MARGIN_MS + 30 });
  assert.equal(delivered.length, 1, "no member started after the deadline");
  assert.equal(result.delivery.status, "blocked");
  assert.equal(result.delivery.detail, "1 resumed, 0 not reachable, 2 not sent (out of time); open the thread and retry if needed");
  assert.equal(result.question.status, "open", "still actionable");
});

test("a Scan now through the node broker types into no app: those wait for the next tick, CLI sends still go", async (t) => {
  let now = NOW;
  const app = makeThread();
  const cli = makeThread({ key: "claude:c1", kind: "claude", id: "c1", cwd: "/work/c1", branch: "spencer/other", prRefs: [], agentStatus: "stalled", lastAgentAt: ago(40 * MIN), lastActivityAt: ago(40 * MIN), live: { peerName: "cli-1", pid: 9, status: "idle" } });
  const { supervisor, delivered } = fixture(t, { mode: "auto", delivery: "computer-use-first", threads: [app, cli], now: () => now, deps: { uiDriver: readyDriver() } });
  const capability = createFleetCapability(supervisor);
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  const scanned = await capability.invoke("request", { method: "POST", path: "/fleet/api/scan" }, { expiresAt });
  assert.equal(scanned.response.status, 200);
  assert.deepEqual(delivered.map((d) => d.route), ["peer-relay"], "the CLI send goes; the app send waits");
  const row = scanned.state.snapshot.threads.find((r) => r.key === app.key);
  assert.match(row.decision.reason, /deferred: remote scan$/);
  // The next scheduled tick types it.
  now += 5 * MIN;
  await supervisor.tick({ reason: "interval" });
  assert.deepEqual(delivered.map((d) => d.route), ["peer-relay", "computer-use"]);
  // A local Scan now (the Mac's own page) types as before.
  const local = fixture(t, { mode: "auto", delivery: "computer-use-first", threads: [app], deps: { uiDriver: readyDriver() } });
  await createFleetRoute({ supervisor: local.supervisor })("POST", "/fleet/api/scan", null, async () => ({}));
  assert.deepEqual(local.delivered.map((d) => d.route), ["computer-use"]);
});

test("a Scan now arriving mid-tick defers app sends only if every scan waiting on it came through the broker", async (t) => {
  for (const [callers, routes] of [[["remote"], []], [["remote", "local"], ["computer-use"]], [["local", "remote"], ["computer-use"]]]) {
    let release = null;
    const gate = new Promise((resolve) => { release = resolve; });
    let reads = 0;
    // The running tick sees no thread (it sends nothing); the follow-up does.
    const listCodexThreads = async () => { reads += 1; if (reads === 1) { await gate; return []; } return [makeThread()]; };
    const { supervisor, delivered } = fixture(t, { mode: "auto", delivery: "computer-use", deps: { uiDriver: readyDriver(), listCodexThreads } });
    const first = supervisor.tick({ reason: "interval" });
    const waiting = callers.map((caller) => supervisor.tick({ reason: "owner-scan", ...(caller === "remote" ? { deferUi: true } : {}) }));
    release();
    await first;
    await Promise.all(waiting);
    assert.deepEqual(delivered.map((d) => d.route), routes, callers.join(","));
  }
});

test("an answer blocked because the Mac could not tell the front app is kept, not handed back", async (t) => {
  const asking = makeThread({ writerLocked: true, meta: { originator: "Codex Desktop", pendingQuestion: { text: "Merge?", options: ["yes", "no"] } } });
  const executor = { deliver: async (args) => ({ status: "blocked", route: args.route, detail: "front app unknown", actionId: null }), inFlight: () => [], whenIdle: async () => {} };
  const { supervisor } = fixture(t, { mode: "auto", delivery: "computer-use", threads: [asking], deps: { executor, uiDriver: readyDriver() } });
  await supervisor.tick();
  const q = supervisor.getState().questions.find((x) => x.kind === "agent-ask");
  const result = await supervisor.answerQuestion(q.id, "yes");
  assert.equal(result.delivery.status, "queued");
  assert.match(result.delivery.detail, /front app unknown/);
});

test("a kept answer waits out a Scan now through the node broker when it would be typed", async (t) => {
  let now = NOW;
  let ready = false;
  const asking = makeThread({ writerLocked: true, meta: { originator: "Codex Desktop", pendingQuestion: { text: "Merge?", options: ["yes", "no"] } } });
  const driver = { readiness: async () => (ready ? { ready: true, detail: null } : { ready: false, detail: "screen locked" }) };
  const { supervisor, delivered } = fixture(t, { mode: "auto", delivery: "computer-use", threads: [asking], now: () => now, deps: { uiDriver: driver } });
  await supervisor.tick();
  const q = supervisor.getState().questions.find((x) => x.kind === "agent-ask");
  assert.equal((await supervisor.answerQuestion(q.id, "yes")).delivery.status, "queued");
  ready = true;
  now += 5 * MIN;
  await createFleetCapability(supervisor).invoke("request", { method: "POST", path: "/fleet/api/scan" });
  assert.equal(delivered.filter((d) => d.playbook === "owner-answer").length, 0);
  assert.equal(supervisor.store.queuedAnswers().length, 1);
  now += 5 * MIN;
  await supervisor.tick();
  assert.equal(delivered.filter((d) => d.playbook === "owner-answer").length, 1);
});

test("a remote send with no time left skips the readiness probe and waits", async (t) => {
  let probes = 0;
  const driver = { readiness: async () => { probes += 1; return { ready: true, detail: null }; } };
  const { supervisor, delivered } = fixture(t, { mode: "auto", delivery: "computer-use", threads: [makeThread({ meta: { originator: "Codex Desktop" } })], deps: { uiDriver: driver } });
  await supervisor.tick();
  const before = { probes, sent: delivered.length };
  const result = await supervisor.sendOwnerMessage("codex:t1", "Rebase on main.", { deadlineAt: Date.now() + DEADLINE_MARGIN_MS - 1 });
  assert.equal(result.delivery.status, "blocked");
  assert.equal(probes, before.probes, "no readiness probe past the deadline");
  assert.equal(delivered.length, before.sent);
});

test("the owner's own message to a thread goes through the supervisor's delivery", async (t) => {
  const { supervisor, delivered } = fixture(t, { threads: [makeThread()] });
  await supervisor.tick();
  const result = await supervisor.sendOwnerMessage("codex:t1", "  Rebase on main.  ");
  assert.equal(result.delivery.status, "sent");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].message, "Rebase on main.");
  assert.equal(delivered[0].playbook, "owner-message");
  assert.ok(delivered[0].spentMs >= 0, "its probes count toward the request's time");
  assert.equal(delivered[0].deadlineAt, null);
  await supervisor.sendOwnerMessage("codex:t1", "Rebase again.", { deadlineAt: 1234 });
  assert.equal(delivered[1].deadlineAt, 1234, "a remote caller's deadline reaches the send");
  assert.equal((await supervisor.sendOwnerMessage("codex:missing", "hi")).delivery.status, "blocked");
  assert.equal((await supervisor.sendOwnerMessage("codex:t1", "   ")).delivery.status, "blocked");
  await supervisor.sendOwnerMessage("codex:t1", "After your tasks.", { queue: true });
  assert.equal(delivered.at(-1).queue, true, "asked to queue: passed to the delivery");
  await supervisor.sendOwnerMessage("codex:t1", "Now.");
  assert.equal(delivered.at(-1).queue, false);
});

test("the ledger keeps the route a send actually took, not the one it was asked for", async (t) => {
  const { supervisor } = fixture(t, { threads: [makeThread()], delivery: "computer-use", deps: { uiDriver: readyDriver() } });
  await supervisor.tick();
  // The app send waited on the owner and went by a background route instead.
  supervisor.deps.executor.deliver = async (args) => ({ status: "sent", route: "codex-exec", detail: "started in background", actionId: null, asked: args.route });
  supervisor._executor = null;
  await supervisor.sendOwnerMessage("codex:t1", "Rebase on main.");
  assert.equal(supervisor.store.ledgerFor("codex:t1").nudges.at(-1).route, "codex-exec");
});

test("a question whose thread left the scan closes itself", async (t) => {
  let threads = [makeThread({ meta: { pendingQuestion: { text: "Which plan?", options: ["Starter", "Business"] } } })];
  const { supervisor } = fixture(t, { deps: { listCodexThreads: async () => threads } });
  await supervisor.tick();
  const [question] = supervisor.getState().questions;
  assert.ok(question);
  threads = [];
  await supervisor.tick();
  assert.equal(supervisor.store.question(question.id).status, "resolved");
});

test("a question stays open when its thread was only pushed out by the scan cap", async (t) => {
  const asking = makeThread({ meta: { pendingQuestion: { text: "Which plan?", options: ["Starter", "Business"] } } });
  const newer = (n) => makeThread({ key: `codex:n${n}`, id: `n${n}`, title: `Newer ${n}`, prRefs: [], lastActivityAt: ago(n) });
  let threads = [asking];
  const { supervisor } = fixture(t, { limits: { maxThreads: 2 }, deps: { listCodexThreads: async () => threads } });
  await supervisor.tick();
  const [question] = supervisor.getState().questions;
  assert.ok(question);
  threads = [newer(1), newer(2)];
  await supervisor.tick();
  assert.equal(supervisor.store.question(question.id).status, "open");
});

test("excluded Antigravity rows do not make a missing conversation look capped", async (t) => {
  let threads = [makeThread({ key: "antigravity:asking", kind: "antigravity", id: "asking", prRefs: [], meta: { pendingQuestion: { text: "Which plan?", options: ["Starter", "Business"] } } })];
  const { supervisor } = fixture(t, { limits: { maxThreads: 2 }, deps: { listAntigravityThreads: async () => threads } });
  await supervisor.tick();
  const [question] = supervisor.getState().questions;
  assert.ok(question);
  threads = [1, 2].map((n) => makeThread({ key: `antigravity:loose-${n}`, kind: "antigravity", id: `loose-${n}`, prRefs: [], excluded: "no-repo" }));
  supervisor.uiBlockedSince.set("antigravity:asking", NOW - MIN);
  supervisor.trackUiBlocked([], { mode: "auto", delivery: { ready: false }, threads, sourceErrors: {}, started: NOW, config: supervisor.config });
  assert.equal(supervisor.uiBlockedSince.has("antigravity:asking"), false);
  await supervisor.tick();
  assert.equal(supervisor.store.question(question.id).status, "resolved");
});

test("an open agent question closes itself once its PR merges after the ask, and stays for an ask made after the merge", async (t) => {
  const resolved = [];
  const pending = { text: "Start a solo huddle and send a screenshot?", options: ["open thread"], at: ago(60 * MIN) };
  const asker = makeThread({ lastAgentText: "Start a solo huddle and send a screenshot?", lastAgentAt: ago(55 * MIN), meta: { pendingQuestion: pending } });
  const prs = new Map([["acme/app#7", makePr()]]);
  const { supervisor } = fixture(t, { threads: [asker], prs });
  supervisor.runtime = { outreach: { resolve: (id, decision, opts) => resolved.push([id, decision, opts.status]) } };
  await supervisor.tick();
  const [question] = supervisor.getState().questions;
  assert.equal(question?.threadKey, "codex:t1");
  supervisor.store.markQuestionNotified(question.id, { outreachId: "out_1" });
  prs.set("acme/app#7", makePr({ state: "MERGED", mergedAt: ago(10 * MIN), closedAt: ago(10 * MIN) }));
  await supervisor.tick();
  assert.deepEqual(supervisor.getState().questions, []);
  assert.deepEqual(resolved, [["out_1", "resolved", "dismissed"]]);

  // Asked after the merge: a QA offer on the merged PR is still the owner's call.
  const qa = makeThread({ key: "codex:t2", id: "t2", cwd: "/work/t2", lastAgentText: "PR #7 is merged. Should I cut a staging release and QA it there?", lastAgentAt: ago(5 * MIN) });
  const later = fixture(t, { threads: [qa], prs: new Map([["acme/app#7", makePr({ state: "MERGED", mergedAt: ago(10 * MIN), closedAt: ago(10 * MIN) })]]) });
  await later.supervisor.tick();
  await later.supervisor.tick();
  assert.deepEqual(later.supervisor.getState().questions.map((q) => q.threadKey), ["codex:t2"]);
});

// Audit 2026-10-12: questions from Oct 9-11 never expired, refreshed by
// every scan that asked them again.
test("a ready question asked every tick keeps one id, expires a day after it was first asked, and is not asked anew", async (t) => {
  let now = NOW;
  const green = makePr({ ci: { state: "SUCCESS", failing: [], pending: [] }, unresolvedThreads: 0, mergeState: "CLEAN" });
  const { supervisor, notified } = fixture(t, { prs: new Map([["acme/app#7", green]]), now: () => now });
  await supervisor.tick();
  const [ready] = supervisor.getState().questions;
  assert.ok(ready);
  now += 12 * 60 * MIN;
  await supervisor.tick();
  assert.deepEqual(supervisor.getState().questions.map((q) => q.id), [ready.id]);
  now += 13 * 60 * MIN;
  await supervisor.tick();
  assert.deepEqual(supervisor.getState().questions, []);
  assert.equal(supervisor.store.question(ready.id).status, "expired");
  assert.equal(supervisor.getState().snapshot.counts.needsYou, 0);
  assert.ok(notified.every((q) => q.id === ready.id), "no new question for the same ask");
});

// Audit 2026-10-12: 89 of 99 questions closed when their thread's state
// changed; #7352's merge ask closed twice on a waiting-ci flicker.
test("a ready question stays open while its thread's state flickers, and closes when the PR merges", async (t) => {
  const calls = [];
  let now = NOW;
  let thread = makeThread();
  let pr = makePr({ ci: { state: "SUCCESS", failing: [], pending: [] }, unresolvedThreads: 0, mergeState: "CLEAN" });
  const { supervisor, notified } = fixture(t, { now: () => now, deps: { listCodexThreads: async () => [thread], fetchPrStates: async () => new Map([["acme/app#7", pr]]) } });
  supervisor.runtime = { outreach: {
    resolve: (id, decision, opts) => calls.push(["resolve", id, decision, opts.status]),
    reopen: (id) => calls.push(["reopen", id])
  } };
  await supervisor.tick();
  const [ready] = supervisor.getState().questions;
  assert.match(ready.dedupeKey, /^ready:/);
  supervisor.store.markQuestionNotified(ready.id, { outreachId: "out_1", pushedAt: new Date(NOW).toISOString() });

  // A turn running, then CI re-running on the same head: still the owner's merge.
  for (const [next, nextPr] of [[makeThread({ agentStatus: "running" }), pr], [makeThread(), { ...pr, ci: { state: "PENDING", failing: [], pending: ["ci"] } }], [makeThread(), pr]]) {
    thread = next;
    pr = nextPr;
    now += 5 * MIN;
    await supervisor.tick();
    assert.deepEqual(supervisor.getState().questions.map((q) => q.id), [ready.id]);
  }
  assert.deepEqual(calls, []);
  assert.ok(notified.every((q) => q.id === ready.id));

  pr = { ...pr, state: "MERGED", mergedAt: new Date(now).toISOString() };
  now += 5 * MIN;
  await supervisor.tick();
  assert.deepEqual(supervisor.getState().questions, []);
  assert.equal(supervisor.store.question(ready.id).resolveReason, "#7 merged");
  assert.deepEqual(calls, [["resolve", "out_1", "resolved", "dismissed"]]);
});

test("a ready question closes once the PR head moves past the asked head", async (t) => {
  let now = NOW;
  let pr = makePr({ ci: { state: "SUCCESS", failing: [], pending: [] }, unresolvedThreads: 0, mergeState: "CLEAN" });
  const { supervisor } = fixture(t, { now: () => now, deps: { fetchPrStates: async () => new Map([["acme/app#7", pr]]) } });
  await supervisor.tick();
  const [ready] = supervisor.getState().questions;
  assert.equal(ready.askedHead, HEAD);
  pr = { ...pr, headOid: "c".repeat(40), ci: { state: "PENDING", failing: [], pending: ["ci"] } };
  now += 5 * MIN;
  await supervisor.tick();
  assert.equal(supervisor.store.question(ready.id).status, "resolved");
  assert.equal(supervisor.store.question(ready.id).resolveReason, `PR head moved past ${HEAD.slice(0, 10)}`);
});

test("an expired question closes its outreach copy", async (t) => {
  const calls = [];
  let now = NOW;
  const asking = makeThread({ meta: { pendingQuestion: { text: "Which plan?", options: ["Starter", "Business"] } } });
  const newer = (n) => makeThread({ key: `codex:n${n}`, id: `n${n}`, title: `Newer ${n}`, prRefs: [], lastActivityAt: ago(n) });
  let threads = [asking];
  const { supervisor } = fixture(t, { now: () => now, limits: { maxThreads: 2 }, deps: { listCodexThreads: async () => threads } });
  supervisor.runtime = { outreach: { resolve: (id, decision, opts) => calls.push([id, decision, opts.status]) } };
  await supervisor.tick();
  const [question] = supervisor.getState().questions;
  supervisor.store.markQuestionNotified(question.id, { outreachId: "out_1" });
  // Only pushed out by the scan cap, so nothing resolves it: it expires.
  threads = [newer(1), newer(2)];
  now += 25 * 60 * MIN;
  await supervisor.tick();
  assert.equal(supervisor.store.question(question.id).status, "expired");
  assert.deepEqual(calls, [["out_1", "expired", "dismissed"]]);
});

test("a question that expires on a state read, with no tick running, closes its outreach copy once", async (t) => {
  const calls = [];
  let now = NOW;
  const asking = makeThread({ meta: { pendingQuestion: { text: "Which plan?", options: ["Starter", "Business"] } } });
  const { supervisor } = fixture(t, { threads: [asking], now: () => now });
  supervisor.runtime = { outreach: { resolve: (id, decision, opts) => calls.push([id, decision, opts.status]) } };
  await supervisor.tick();
  const [question] = supervisor.getState().questions;
  supervisor.store.markQuestionNotified(question.id, { outreachId: "out_1" });
  // Ticks stopped (the Mac asleep); the /fleet page or the main reads state.
  now += 25 * 60 * MIN;
  assert.deepEqual(supervisor.getState().questions, []);
  assert.deepEqual(calls, [["out_1", "expired", "dismissed"]]);
  supervisor.getState();
  assert.equal(calls.length, 1);
});

// Review 1: a failed PR read after a merge settled an ask must not bring
// the ask back, before or after a restart.
test("a failed PR read after a merge settled an ask neither reopens it nor raises it anew", async (t) => {
  let now = NOW;
  let failing = false;
  let prs = new Map([["acme/app#7", makePr()]]);
  const fetchPrStates = async (refs, _config, { unread }) => {
    if (!failing) return prs;
    for (const ref of refs) unread.add(ref);
    return new Map();
  };
  const threads = [makeThread({ lastAgentText: "Want me to cut the production release?", lastAgentAt: ago(55 * MIN) })];
  const { supervisor, notified } = fixture(t, { threads, now: () => now, deps: { fetchPrStates } });
  await supervisor.tick();
  const [question] = supervisor.getState().questions;
  assert.equal(question?.kind, "agent-ask");

  prs = new Map([["acme/app#7", makePr({ state: "MERGED", mergedAt: ago(10 * MIN), closedAt: ago(10 * MIN) })]]);
  now += 5 * MIN;
  await supervisor.tick();
  assert.equal(supervisor.store.question(question.id).status, "resolved");

  // GitHub fails inside the reopen window and past it: the last merged read holds.
  failing = true;
  for (const step of [5 * MIN, 2 * 60 * MIN]) {
    now += step;
    const snapshot = await supervisor.tick();
    assert.equal(snapshot.threads[0].state, "done");
    assert.deepEqual(supervisor.getState().questions, []);
  }
  // A restart remembers no PR: the ask the supervisor closed waits for GitHub.
  supervisor.settledPrs = new Map();
  now += 5 * MIN;
  await supervisor.tick();
  assert.deepEqual(supervisor.getState().questions, []);
  assert.equal(supervisor.store.question(question.id).status, "resolved");
  assert.equal(notified.length, 1);

  // A new ask on a thread GitHub cannot read is still raised.
  threads.push(makeThread({ key: "codex:t2", id: "t2", cwd: "/work/t2", lastAgentText: "Should I email the customer about the outage?", lastAgentAt: ago(5 * MIN) }));
  now += 5 * MIN;
  await supervisor.tick();
  assert.deepEqual(supervisor.getState().questions.map((q) => q.threadKey), ["codex:t2"]);

  failing = false;
  now += 5 * MIN;
  await supervisor.tick();
  assert.deepEqual(supervisor.getState().questions.map((q) => q.threadKey), ["codex:t2"]);
  assert.equal(supervisor.store.question(question.id).status, "resolved");
});

// ─── the supervisor's review of its own needs-you list ─────────────────────

const REVIEW_ON = { enabled: true };
const MERGE_ASK = "Ready. Want me to merge with --admin or wait for Nikhil's approval?";
const asking = (overrides = {}) => makeThread({ lastAgentText: MERGE_ASK, prRefs: [], ...overrides });

// A fake model: decide(entries) returns the verdicts; every request is kept.
function fakeModel(decide) {
  const calls = [];
  const runModel = async (request) => {
    const entries = JSON.parse(request.prompt.split("<questions>\n")[1].split("\n</questions>")[0]);
    calls.push({ ...request, entries });
    return { reviews: decide(entries) };
  };
  return { runModel, calls };
}

function fakeOutreach() {
  const calls = [];
  let next = 0;
  return {
    calls,
    append: (item) => { calls.push(["append", item.title, item.actions]); next += 1; return { id: `out_${next}` }; },
    update: (id, patch) => { calls.push(["update", id, patch.title, patch.actions]); return { id }; },
    resolve: (id, decision, opts) => { calls.push(["resolve", id, decision, opts?.status]); return { id }; },
    reopen: (id) => { calls.push(["reopen", id]); return { id }; }
  };
}

const reviewActions = (supervisor) => supervisor.getState().actions.filter((action) => action.kind === "review");

test("review closes a stale question before it reaches the owner", async (t) => {
  const model = fakeModel((entries) => entries.map((e) => ({ id: e.id, decision: "close", category: "stale", reason: "PR merged 2h ago" })));
  const { supervisor, notified } = fixture(t, { threads: [asking()], prs: new Map(), review: REVIEW_ON, deps: { runModel: model.runModel } });
  const outreach = fakeOutreach();
  supervisor.runtime = { outreach };
  await supervisor.tick();
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0].entries[0].threads[0].key, "codex:t1");
  assert.deepEqual(supervisor.getState().questions, []);
  assert.equal(notified.length, 0, "never pushed or posted");
  const [closed] = supervisor.getState().reviewClosed;
  assert.equal(closed.status, "resolved");
  assert.equal(closed.resolvedBy, "review");
  assert.equal(closed.resolveReason, "review: stale: PR merged 2h ago");
  assert.equal(closed.reviewCategory, "stale");
  assert.deepEqual(outreach.calls, [], "no copy was ever posted");
  const actions = reviewActions(supervisor);
  assert.ok(actions.some((a) => a.questionId === closed.id && /^closed stale: /.test(a.reason)));
  assert.deepEqual(actions.find((a) => Array.isArray(a.decisions)).decisions.map((d) => [d.id, d.decision, d.category]), [[closed.id, "close", "stale"]]);
  assert.equal((await supervisor.tick()).counts.needsYou, 0);
});

test("review keeps a live question and rewords it in place on the same outreach copy", async (t) => {
  let now = NOW;
  let title = "acme: admin merge or wait for Nikhil?";
  const model = fakeModel((entries) => entries.map((e) => ({ id: e.id, decision: "keep", category: "live", reason: "agent waits on the owner", title, options: ["admin merge", "wait for Nikhil"] })));
  const { supervisor, delivered } = fixture(t, { threads: [asking()], prs: new Map(), now: () => now, review: REVIEW_ON, deps: { runModel: model.runModel, notifier: undefined } });
  const outreach = fakeOutreach();
  supervisor.runtime = { outreach };
  await supervisor.tick();
  const [question] = supervisor.getState().questions;
  assert.equal(question.title, title);
  assert.deepEqual(question.options, ["admin merge", "wait for Nikhil"]);
  assert.equal(question.reviewCategory, "live");
  assert.ok(question.reviewFingerprint);
  assert.deepEqual(outreach.calls[0], ["append", title, ["admin merge", "wait for Nikhil", "dismiss"]], "posted already reworded");

  // The next ask repeats the policy's wording; the review's wording stays.
  now += 5 * MIN;
  await supervisor.tick();
  assert.equal(model.calls.length, 1, "unchanged: not reviewed again");
  assert.equal(supervisor.getState().questions[0].title, title);

  // The interval passes and the review words it differently: same record, same copy.
  title = "acme: merge now with --admin?";
  now += 31 * MIN;
  await supervisor.tick();
  assert.equal(model.calls.length, 2);
  const [again] = supervisor.getState().questions;
  assert.equal(again.id, question.id);
  assert.equal(again.dedupeKey, question.dedupeKey);
  assert.equal(again.title, title);
  assert.deepEqual(outreach.calls.filter((c) => c[0] === "append").length, 1);
  assert.deepEqual(outreach.calls.at(-1), ["update", "out_1", title, ["admin merge", "wait for Nikhil", "dismiss"]]);

  // The new choices are what the owner answers with.
  const result = await supervisor.answerQuestion(question.id, "admin merge");
  assert.equal(result.question.status, "answered");
  assert.match(delivered[0].message, /^Owner answer: admin merge\./);
});

test("review keeps a duplicate on another thread: that agent needs its own answer", async (t) => {
  const threads = [
    asking(),
    asking({ key: "codex:t2", id: "t2", cwd: "/work/t2", lastAgentText: "Merge it with --admin now, or wait for review?" })
  ];
  let firstId = null;
  const model = fakeModel((entries) => {
    firstId = entries.find((e) => e.threads[0].key === "codex:t1").id;
    return entries.map((e) => (e.id === firstId
      ? { id: e.id, decision: "keep", category: "live", reason: "real ask" }
      : { id: e.id, decision: "close", category: "duplicate", reason: "same merge ask", duplicateOf: firstId }));
  });
  const { supervisor, notified } = fixture(t, { threads, prs: new Map(), review: REVIEW_ON, deps: { runModel: model.runModel } });
  await supervisor.tick();
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0].entries.length, 2, "one batched call sees both");
  // Closed, t2's answer would never reach t2 once t1's is answered.
  const open = supervisor.getState().questions;
  assert.deepEqual(open.map((q) => q.threadKey).sort(), ["codex:t1", "codex:t2"]);
  assert.equal(open.find((q) => q.threadKey === "codex:t2").reviewReason, "same merge ask");
  assert.deepEqual(supervisor.getState().reviewClosed, []);
  assert.equal(notified.length, 2);
});

test("a backlog past the batch cap is reviewed oldest first and never calls the model every tick", async (t) => {
  let now = NOW;
  const threads = Array.from({ length: 20 }, (_, i) => asking({
    key: `codex:t${i}`, id: `t${i}`, cwd: `/work/t${i}`, lastAgentText: `Ready. Want me to merge #${i} with --admin or wait for Nikhil's approval?`
  }));
  const model = fakeModel((entries) => entries.map((e) => ({ id: e.id, decision: "keep", category: "live", reason: "waits on the owner" })));
  const { supervisor, notified } = fixture(t, { threads, prs: new Map(), now: () => now, review: REVIEW_ON, deps: { runModel: model.runModel } });
  await supervisor.tick();
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0].entries.length, 15);
  // The five it could not fit wait for the next review, off every surface.
  assert.equal(notified.length, 15);
  assert.equal(supervisor.getState().questions.length, 15);
  const first = new Set(model.calls[0].entries.map((e) => e.id));
  now += 5 * MIN;
  await supervisor.tick();
  assert.equal(model.calls.length, 2, "a new question never waits for the gap");
  assert.equal(model.calls[1].entries.length, 5);
  assert.ok(model.calls[1].entries.every((e) => !first.has(e.id)));
  // The notifier is called each tick (it skips what it already posted).
  assert.deepEqual(new Set(notified.map((q) => q.id)).size, 20);
  // Two hours of ticks: each question re-checked on its interval, which
  // doubles while nothing changes; at most one call per ten minutes.
  const at = [];
  for (let minute = 10; minute <= 120; minute += 5) {
    now = NOW + minute * MIN;
    const before = model.calls.length;
    await supervisor.tick();
    if (model.calls.length > before) at.push([minute, model.calls.at(-1).entries.length]);
  }
  assert.deepEqual(at, [[30, 15], [40, 5], [90, 15], [100, 5]]);
  // The first batch comes back first, the oldest review first.
  assert.deepEqual(new Set(model.calls[2].entries.map((e) => e.id)), first);
});

test("a mass close is capped: the rest stay held and are reviewed on the next tick", async (t) => {
  let now = NOW;
  let verdict = "close";
  const threads = Array.from({ length: 12 }, (_, i) => asking({
    key: `codex:t${i}`, id: `t${i}`, cwd: `/work/t${i}`, lastAgentText: `Ready. Want me to merge #${i} with --admin or wait for Nikhil's approval?`
  }));
  const model = fakeModel((entries) => entries.map((e) => ({ id: e.id, decision: verdict, category: verdict === "close" ? "junk" : "live", reason: "status line" })));
  const { supervisor, notified } = fixture(t, { threads, prs: new Map(), now: () => now, review: REVIEW_ON, deps: { runModel: model.runModel } });
  await supervisor.tick();
  assert.equal(supervisor.getState().reviewClosed.length, 3);
  assert.equal(supervisor.getState().questions.length, 0, "the deferred nine are still unreviewed");
  assert.equal(notified.length, 0);
  assert.match(reviewActions(supervisor).find((a) => Array.isArray(a.decisions)).reason, /reviewed 3: 3 closed, 0 kept, 9 closes deferred/);
  verdict = "keep";
  now += 5 * MIN;
  await supervisor.tick();
  assert.equal(model.calls.length, 2);
  assert.equal(model.calls[1].entries.length, 9);
  assert.equal(supervisor.getState().questions.length, 9);
  assert.equal(notified.length, 9);
});

test("a review close is checked again after its hold; an unreadable PR does not strand it", async (t) => {
  let now = NOW;
  const thread = asking({ prRefs: ["acme/app#7"] });
  const model = fakeModel((entries) => entries.map((e) => ({ id: e.id, decision: "close", category: "stale", reason: "optional offer" })));
  const { supervisor, notified } = fixture(t, {
    threads: [thread], now: () => now, review: REVIEW_ON,
    deps: { runModel: model.runModel, fetchPrStates: async (refs, config, { unread }) => { for (const ref of refs) unread.add(ref); return new Map(); } }
  });
  await supervisor.tick();
  assert.equal(model.calls.length, 1);
  for (let hour = 1; hour <= 30; hour += 1) {
    now = NOW + hour * 60 * MIN;
    await supervisor.tick();
  }
  // Re-raised and re-reviewed every six hours, never pushed while the
  // review still closes it, and always reopenable.
  assert.equal(model.calls.length, 6);
  assert.equal(notified.length, 0);
  const cleared = supervisor.getState().reviewClosed;
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].lastAskedAt, new Date(now).toISOString());
});

test("an owner answer in flight wins over a review that closes the question", async (t) => {
  let release = null;
  const sent = [];
  const executor = {
    deliver: (args) => new Promise((resolve) => { sent.push(args); release = () => resolve({ status: "sent", route: args.route, detail: "ok", actionId: null }); }),
    inFlight: () => [],
    whenIdle: async () => {}
  };
  let holder = null;
  let answering = null;
  const model = fakeModel((entries) => {
    answering = holder.answerQuestion(entries[0].id, entries[0].options[0]);
    return entries.map((e) => ({ id: e.id, decision: "close", category: "stale", reason: "moot" }));
  });
  const { supervisor } = fixture(t, { threads: [asking()], prs: new Map(), review: REVIEW_ON, deps: { runModel: model.runModel, executor } });
  holder = supervisor;
  await supervisor.tick();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  release();
  const result = await answering;
  assert.equal(sent.length, 1);
  assert.equal(result.question.status, "answered");
  assert.equal(result.question.resolvedBy, undefined);
  assert.deepEqual(supervisor.getState().reviewClosed, []);
});

test("the review sees the agent message an ask came from and when it was sent", async (t) => {
  const tail = "I can update the shared pr-verification skill so it syncs to GitHub. Want me to make that edit?";
  const model = fakeModel((entries) => entries.map((e) => ({ id: e.id, decision: "keep", category: "live", reason: "waits" })));
  const { supervisor } = fixture(t, {
    threads: [asking({ lastAgentText: tail, lastAgentTail: tail, lastAgentAt: ago(20 * MIN) })], prs: new Map(), review: REVIEW_ON, deps: { runModel: model.runModel }
  });
  await supervisor.tick();
  const [entry] = model.calls[0].entries;
  assert.equal(entry.askContext, tail);
  assert.equal(entry.askedAt, ago(20 * MIN));
});

test("a review close holds while the same ask repeats, is never revived as a blip, and a new ask is new", async (t) => {
  let now = NOW;
  let thread = asking();
  let verdict = "close";
  const model = fakeModel((entries) => entries.map((e) => ({ id: e.id, decision: verdict, category: verdict === "close" ? "junk" : "live", reason: "status line, no ask" })));
  const { supervisor, notified } = fixture(t, { prs: new Map(), now: () => now, review: REVIEW_ON, deps: { runModel: model.runModel, listCodexThreads: async () => [thread] } });
  const outreach = fakeOutreach();
  supervisor.runtime = { outreach };
  await supervisor.tick();
  const [closed] = supervisor.getState().reviewClosed;
  assert.ok(closed);
  // Asked for hours more: held, not reviewed again, never pushed.
  for (let i = 0; i < 3; i += 1) {
    now += 60 * MIN;
    await supervisor.tick();
  }
  assert.deepEqual(supervisor.getState().questions, []);
  assert.equal(model.calls.length, 1);
  assert.equal(notified.length, 0);
  // A turn in between, then the same ask inside the reopen window: still closed.
  thread = asking({ agentStatus: "running" });
  now += 5 * MIN;
  await supervisor.tick();
  thread = asking();
  now += 5 * MIN;
  await supervisor.tick();
  assert.deepEqual(supervisor.getState().questions, []);
  assert.equal(supervisor.store.question(closed.id).status, "resolved");
  assert.equal(outreach.calls.some((c) => c[0] === "reopen"), false);
  // A new ask (a newer agent message) is a new question, reviewed before it is pushed.
  verdict = "keep";
  thread = asking({ lastAgentText: "Should I email the customer about the outage?", lastAgentAt: new Date(now).toISOString() });
  now += 5 * MIN;
  await supervisor.tick();
  const [fresh] = supervisor.getState().questions;
  assert.ok(fresh && fresh.id !== closed.id);
  assert.equal(model.calls.length, 2);
  assert.deepEqual(notified.map((q) => q.id), [fresh.id]);
});

test("the owner reopens a review-closed question; pinned, the review keeps it", async (t) => {
  let now = NOW;
  const model = fakeModel((entries) => entries.map((e) => ({ id: e.id, decision: "close", category: "stale", reason: "optional offer" })));
  const { supervisor } = fixture(t, { threads: [asking()], prs: new Map(), now: () => now, review: REVIEW_ON, deps: { runModel: model.runModel } });
  const outreach = fakeOutreach();
  supervisor.runtime = { outreach };
  await supervisor.tick();
  const [closed] = supervisor.getState().reviewClosed;
  // As if a copy had been posted before the review closed it.
  supervisor.store.markQuestionNotified(closed.id, { outreachId: "out_9" });
  outreach.calls.length = 0;

  const reopened = supervisor.reopenReviewed(closed.id);
  assert.equal(reopened.id, closed.id);
  assert.equal(reopened.status, "open");
  assert.equal(reopened.pinned, true);
  assert.deepEqual(outreach.calls, [["reopen", "out_9"]]);
  assert.deepEqual(supervisor.getState().reviewClosed, []);
  assert.ok(reviewActions(supervisor).some((a) => /^owner reopened: /.test(a.reason)));
  assert.equal(supervisor.reopenReviewed(closed.id), null, "only a review close reopens");

  // The interval passes and the model says close again: pinned, it stays.
  now += 31 * MIN;
  await supervisor.tick();
  assert.equal(model.calls.length, 2);
  assert.equal(model.calls[1].entries[0].pinned, true);
  assert.deepEqual(supervisor.getState().questions.map((q) => q.id), [closed.id]);
  assert.equal(supervisor.store.question(closed.id).status, "open");
});

test("a failed review fails open: the question goes out and the failure is logged", async (t) => {
  let now = NOW;
  let failing = true;
  let calls = 0;
  const runModel = async () => {
    calls += 1;
    if (failing) throw new Error("review timed out after 150s");
    return { reviews: [] };
  };
  const { supervisor, notified } = fixture(t, { threads: [asking()], prs: new Map(), now: () => now, review: REVIEW_ON, deps: { runModel } });
  await supervisor.tick();
  assert.equal(calls, 1);
  assert.equal(supervisor.getState().questions.length, 1);
  assert.equal(notified.length, 1, "pushed as without the review");
  const failed = reviewActions(supervisor).find((a) => a.status === "failed");
  assert.match(failed.detail, /timed out/);
  assert.match(supervisor.getState().settings.review.lastError, /timed out/);
  // Not retried every tick.
  now += 5 * MIN;
  await supervisor.tick();
  assert.equal(calls, 1);
  failing = false;
  now += 15 * MIN;
  await supervisor.tick();
  assert.equal(calls, 2);
  assert.equal(supervisor.getState().settings.review.lastError, null);
  assert.equal(supervisor.getState().questions[0].reviewReason, "no verdict from the review");
});

test("settings show the review's provider, model, Claude fallback and which ran last", async (t) => {
  const runModel = async () => {
    runModel.lastRun = { provider: "claude", model: "claude-sonnet-5", fallbackReason: "codex: timed out after 180s" };
    return { reviews: [] };
  };
  Object.assign(runModel, { provider: "codex", model: "gpt-6-luna", fallbackModel: "claude-sonnet-5", lastRun: null });
  const { supervisor } = fixture(t, { threads: [asking()], prs: new Map(), review: REVIEW_ON, deps: { runModel } });
  const before = supervisor.getState().settings.review;
  assert.deepEqual([before.provider, before.model, before.fallbackModel, before.lastRun, before.lastError], ["codex", "gpt-6-luna", "claude-sonnet-5", null, null]);
  await supervisor.tick();
  assert.deepEqual(supervisor.getState().settings.review.lastRun, { provider: "claude", model: "claude-sonnet-5", fallbackReason: "codex: timed out after 180s" });
});

test("a failed review clears the last run it no longer reflects", async (t) => {
  let now = NOW;
  let failing = false;
  const runModel = async () => {
    if (failing) {
      runModel.lastRun = null;
      throw new Error("codex: timed out after 180s; claude fallback: usage limit");
    }
    runModel.lastRun = { provider: "codex", model: "gpt-6-luna", fallbackReason: null };
    return { reviews: [] };
  };
  Object.assign(runModel, { provider: "codex", model: "gpt-6-luna", fallbackModel: "claude-sonnet-5", lastRun: null });
  const { supervisor } = fixture(t, { threads: [asking()], prs: new Map(), now: () => now, review: REVIEW_ON, deps: { runModel } });
  await supervisor.tick();
  assert.equal(supervisor.getState().settings.review.lastRun?.provider, "codex");
  failing = true;
  now += 31 * MIN;
  await supervisor.tick();
  const review = supervisor.getState().settings.review;
  assert.match(review.lastError, /timed out/);
  assert.equal(review.lastRun, null);
});

test("a new question stays off the shared state until the review has seen it", async (t) => {
  let holder = null;
  let seen = null;
  const runModel = async () => {
    seen = holder.getState().questions.length;
    return { reviews: [] };
  };
  const { supervisor } = fixture(t, { threads: [asking()], prs: new Map(), review: REVIEW_ON, deps: { runModel } });
  holder = supervisor;
  await supervisor.tick();
  assert.equal(seen, 0, "the main cannot mirror it mid-review");
  assert.equal(supervisor.getState().questions.length, 1);
});

test("an unchanged question is not reviewed again until it changes or the interval passes", async (t) => {
  let now = NOW;
  let thread = asking();
  const model = fakeModel((entries) => entries.map((e) => ({ id: e.id, decision: "keep", category: "live", reason: "waits on the owner" })));
  const { supervisor } = fixture(t, { prs: new Map(), now: () => now, review: REVIEW_ON, deps: { runModel: model.runModel, listCodexThreads: async () => [thread] } });
  await supervisor.tick();
  assert.equal(model.calls.length, 1);
  now += 5 * MIN;
  await supervisor.tick();
  assert.equal(model.calls.length, 1);
  // The thread moved: reviewed again, but not sooner than the gap after the last one.
  thread = asking({ lastActivityAt: new Date(now - 30 * MIN).toISOString() });
  now += 2 * MIN;
  await supervisor.tick();
  assert.equal(model.calls.length, 1);
  now += 5 * MIN;
  await supervisor.tick();
  assert.equal(model.calls.length, 2);
  now += 31 * MIN;
  await supervisor.tick();
  assert.equal(model.calls.length, 3);
});

test("OPENAGI_FLEET_REVIEW=0 turns the review off; it is on with the supervisor", async (t) => {
  const off = fakeModel(() => []);
  const disabled = fixture(t, { threads: [asking()], prs: new Map(), env: { OPENAGI_FLEET_SUPERVISOR: "1", OPENAGI_FLEET_REVIEW: "0" }, deps: { runModel: off.runModel } });
  await disabled.supervisor.tick();
  assert.equal(off.calls.length, 0);
  assert.equal(disabled.notified.length, 1);
  assert.equal(disabled.supervisor.getState().settings.review.enabled, false);

  const on = fakeModel(() => []);
  const enabled = fixture(t, { threads: [asking()], prs: new Map(), env: { OPENAGI_FLEET_SUPERVISOR: "1" }, deps: { runModel: on.runModel } });
  await enabled.supervisor.tick();
  assert.equal(on.calls.length, 1);
  assert.equal(enabled.supervisor.getState().settings.review.enabled, true);
  assert.equal(enabled.supervisor.config.storage.enabled, false, "never reads the real disks");
});

// ─── the owner's private playbooks: account switch ─────────────────────────

function ownerPlaybook(dataDir, id, text) {
  const dir = path.join(dataDir, "skills", "fleet-supervisor", "playbooks");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.md`), text);
}

function fakeRestarter(result = { ok: true, detail: "restarted Conductor" }) {
  const calls = [];
  return { calls, restart: async (app) => { calls.push(app); return result; } };
}

const cappedTab = (id, extra = {}) => makeThread({ key: `conductor:${id}`, kind: "conductor", id, workspace: id, cwd: `/work/${id}`, agentStatus: "error", error: { kind: "usage-limit", resetAt: null }, meta: uiMeta(id), ...extra });

test("after an account switch, the owner's playbook restarts Conductor once, then asks each capped chat to retry", async (t) => {
  const restarter = fakeRestarter();
  const threads = [cappedTab("s1"), cappedTab("s2")];
  const { supervisor, delivered, dataDir } = fixture(t, { mode: "auto", delivery: "computer-use", threads, deps: { uiDriver: readyDriver(), appRestarter: restarter } });
  ownerPlaybook(dataDir, "account-switched", "---\nid: account-switched\nrestart_apps: conductor\n---\nretry\n");
  await supervisor.tick();
  const before = delivered.length;
  const q = supervisor.store.upsertQuestion({ kind: "limit", dedupeKey: "cap", title: "2 threads capped. Add acct?", options: ["wait", "added"], threadKeys: threads.map((thread) => thread.key) });
  const result = await supervisor.answerQuestion(q.id, "added");
  assert.equal(result.question.status, "answered", result.delivery?.detail);
  assert.deepEqual(restarter.calls, ["conductor"]);
  const sent = delivered.slice(before);
  assert.deepEqual(sent.map((d) => d.message), ["retry", "retry"]);
  assert.ok(supervisor.getState().actions.some((action) => action.kind === "restart" && action.status === "done"));
});

test("a remote answer too close to its deadline does not start a restart", async (t) => {
  const restarter = fakeRestarter();
  const threads = [cappedTab("s1")];
  const { supervisor, delivered, dataDir } = fixture(t, { mode: "auto", delivery: "computer-use", threads, deps: { uiDriver: readyDriver(), appRestarter: restarter } });
  ownerPlaybook(dataDir, "account-switched", "---\nid: account-switched\nrestart_apps: conductor\n---\nretry\n");
  await supervisor.tick();
  const before = delivered.length;
  const q = supervisor.store.upsertQuestion({ kind: "limit", dedupeKey: "cap", title: "Capped. Add acct?", options: ["wait", "added"], threadKeys: ["conductor:s1"] });
  const result = await supervisor.answerQuestion(q.id, "added", { deadlineAt: Date.now() + restartMaxMs() });
  assert.equal(result.delivery.status, "blocked");
  assert.match(result.delivery.detail, /no time left in this request to restart Conductor/);
  assert.deepEqual(restarter.calls, []);
  assert.equal(delivered.length, before);
  assert.equal(supervisor.store.question(q.id).status, "open");
  // With room for the restart, it goes ahead.
  const again = await supervisor.answerQuestion(q.id, "added", { deadlineAt: Date.now() + restartMaxMs() + DEADLINE_MARGIN_MS + 60_000 });
  assert.deepEqual(restarter.calls, ["conductor"], again.delivery?.detail);
});

test("no restart while another Conductor chat is running, or when the bundled playbook asks for none", async (t) => {
  const restarter = fakeRestarter();
  const running = makeThread({ key: "conductor:busy", kind: "conductor", id: "busy", workspace: "busy", cwd: "/work/busy", agentStatus: "running", meta: uiMeta("busy") });
  const threads = [cappedTab("s1"), running];
  const { supervisor, delivered, dataDir } = fixture(t, { mode: "auto", delivery: "computer-use", threads, deps: { uiDriver: readyDriver(), appRestarter: restarter } });
  ownerPlaybook(dataDir, "account-switched", "---\nid: account-switched\nrestart_apps: conductor\n---\nretry\n");
  await supervisor.tick();
  const before = delivered.length;
  const q = supervisor.store.upsertQuestion({ kind: "limit", dedupeKey: "cap", title: "Capped. Add acct?", options: ["wait", "added"], threadKeys: ["conductor:s1"] });
  const result = await supervisor.answerQuestion(q.id, "added");
  assert.equal(result.delivery.status, "blocked");
  assert.match(result.delivery.detail, /1 chats still running in Conductor/);
  assert.deepEqual(restarter.calls, []);
  assert.equal(delivered.length, before, "nothing sent before the restart could happen");
  assert.equal(supervisor.store.question(q.id).status, "open");

  // The bundled playbook restarts nothing and keeps the generic message.
  const plain = fakeRestarter();
  const other = fixture(t, { mode: "auto", delivery: "computer-use", threads: [cappedTab("s3")], deps: { uiDriver: readyDriver(), appRestarter: plain } });
  await other.supervisor.tick();
  const q2 = other.supervisor.store.upsertQuestion({ kind: "limit", dedupeKey: "cap", title: "Capped. Add acct?", options: ["wait", "added"], threadKeys: ["conductor:s3"] });
  await other.supervisor.answerQuestion(q2.id, "added");
  assert.deepEqual(plain.calls, []);
  assert.match(other.delivered.at(-1).message, /Owner added account capacity/);
});

test("a failed restart leaves the question open to answer again", async (t) => {
  const restarter = fakeRestarter({ ok: false, detail: "Conductor did not quit" });
  const { supervisor, delivered, dataDir } = fixture(t, { mode: "auto", delivery: "computer-use", threads: [cappedTab("s1")], deps: { uiDriver: readyDriver(), appRestarter: restarter } });
  ownerPlaybook(dataDir, "account-switched", "---\nid: account-switched\nrestart_apps: conductor\n---\nretry\n");
  await supervisor.tick();
  const before = delivered.length;
  const q = supervisor.store.upsertQuestion({ kind: "limit", dedupeKey: "cap", title: "Capped. Add acct?", options: ["wait", "added"], threadKeys: ["conductor:s1"] });
  const result = await supervisor.answerQuestion(q.id, "added");
  assert.match(result.delivery.detail, /did not quit; answer again to retry/);
  assert.equal(delivered.length, before);
  assert.equal(supervisor.store.question(q.id).status, "open");
});

test("threads that cannot be reached never starve a stopped one: blocked tries use no send slot", async (t) => {
  // Five merge-ready threads tried more recently than the stopped one, all blocked.
  const busy = Array.from({ length: 5 }, (_, i) => makeThread({ key: `codex:b${i}`, id: `b${i}`, cwd: `/work/b${i}` }));
  const stopped = makeThread({ key: "codex:dead", id: "dead", cwd: "/work/dead", agentStatus: "stalled", prRefs: [], lastAgentAt: ago(40 * MIN), lastActivityAt: ago(40 * MIN) });
  const { supervisor, delivered } = fixture(t, {
    mode: "auto", threads: [...busy, stopped],
    deps: {
      executor: {
        deliver: async (args) => { delivered.push(args); return { status: args.thread.key === "codex:dead" ? "sent" : "blocked", route: args.route, detail: "could not verify thread", actionId: null }; },
        inFlight: () => [], whenIdle: async () => {}
      }
    }
  });
  await supervisor.tick({ reason: "test" });
  assert.equal(delivered[0].thread.key, "codex:dead", "a resume goes first");
  assert.equal(delivered[0].playbook, "resume");
  // Blocked tries are bounded (twice the send cap) and spend no slot.
  assert.equal(delivered.length, 1 + Math.min(busy.length, DEFAULTS.maxSendsPerTick * 2 - 1));
});

test("a computer-use send that times out defers the tick's other app sends", async (t) => {
  const many = Array.from({ length: 3 }, (_, i) => makeThread({ key: `codex:u${i}`, id: `u${i}`, cwd: `/work/u${i}`, title: `Thread ${i}`, writerLocked: true, meta: { originator: "Codex Desktop" } }));
  for (const detail of ["Open Computer Use timed out after 45s on get_app_state; nothing typed", "Open Computer Use stopped, timed out, or disconnected; delivery is unconfirmed.; nothing typed", "delivery timed out; nothing typed",
    // An input call that may still be running in the shared app agent, and a send refused until it has settled.
    "Open Computer Use timed out on input; unconfirmed: check the thread before retrying",
    "Open Computer Use timed out on input earlier; waiting for it to finish; nothing typed"]) {
    const delivered = [];
    const executor = { deliver: async (args) => { delivered.push(args); return { status: "failed", route: args.route, detail, actionId: null }; }, inFlight: () => [], whenIdle: async () => {} };
    const { supervisor } = fixture(t, { mode: "auto", delivery: "computer-use", threads: many, deps: { executor, uiDriver: readyDriver() } });
    const snapshot = await supervisor.tick({ reason: "test" });
    assert.equal(delivered.length, 1, detail);
    assert.equal(delivered[0].route, "computer-use");
    assert.equal(snapshot.threads.filter((row) => /deferred: Open Computer Use stalled/.test(row.decision?.reason ?? "")).length, 2);
  }
  // Any other failure lets the rest go on.
  const delivered = [];
  const executor = { deliver: async (args) => { delivered.push(args); return { status: "failed", route: args.route, detail: "could not focus the composer; nothing typed", actionId: null }; }, inFlight: () => [], whenIdle: async () => {} };
  const { supervisor } = fixture(t, { mode: "auto", delivery: "computer-use", threads: many, deps: { executor, uiDriver: readyDriver() } });
  await supervisor.tick({ reason: "test" });
  assert.equal(delivered.length, 3);
});

test("sends past the cap are marked deferred, not dropped silently", async (t) => {
  const many = Array.from({ length: DEFAULTS.maxSendsPerTick + 2 }, (_, i) => makeThread({ key: `codex:m${i}`, id: `m${i}`, cwd: `/work/m${i}` }));
  const { supervisor, delivered } = fixture(t, { mode: "auto", threads: many });
  const snapshot = await supervisor.tick({ reason: "test" });
  assert.equal(delivered.length, DEFAULTS.maxSendsPerTick);
  const deferred = snapshot.threads.filter((row) => /deferred: send cap/.test(row.decision?.reason ?? ""));
  assert.equal(deferred.length, 2);
});

test("a thread nudges keep failing to reach backs off, then the owner is told once with the reason", async (t) => {
  let now = NOW;
  const stopped = makeThread({ agentStatus: "stalled", prRefs: [], lastAgentAt: ago(40 * MIN), lastActivityAt: ago(40 * MIN) });
  const { supervisor, delivered, notified } = fixture(t, {
    mode: "auto", threads: [stopped], now: () => now,
    deps: {
      executor: {
        deliver: async (args) => { delivered.push(args); return { status: "blocked", route: args.route, detail: "ambiguous: two threads share this title", actionId: null }; },
        inFlight: () => [], whenIdle: async () => {}
      }
    }
  });
  for (let i = 0; i < 12; i += 1) {
    await supervisor.tick({ reason: "test" });
    now += 5 * MIN;
  }
  // 0, 5 (backoff 5), then a Codex title the app cannot tell apart is the
  // owner's on its second failure: no third send.
  assert.equal(delivered.length, 2);
  const asks = supervisor.store.openQuestions().filter((q) => q.kind === "deliver");
  assert.equal(asks.length, 1);
  assert.equal(asks[0].dedupeKey, "deliver:group", "one grouped question, even for one thread");
  assert.match(asks[0].body, /ambiguous: two threads share this title/);
  assert.match(asks[0].body, /rename or archive one/);
  // One question, kept while it stays true (the notifier dedupes the push).
  assert.equal(new Set(notified.filter((q) => q.kind === "deliver").map((q) => q.id)).size, 1);
  assert.equal(supervisor.store.ledgerFor("codex:t1").undelivered.count, 2);
});

test("the owner at the keyboard or a running turn does not count as a failed send", async (t) => {
  const store = new (await import("../src/fleet/store.js")).FleetStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "fleet-ledger-")), now: () => NOW });
  store.recordNudge("codex:a", { playbook: "resume", status: "blocked", detail: "owner using Codex" });
  store.recordNudge("codex:a", { playbook: "resume", status: "blocked", detail: "turn running (Stop is visible)" });
  store.recordNudge("codex:a", { playbook: "resume", status: "blocked", detail: "waiting for idle: Codex must be in front to type" });
  store.recordNudge("codex:a", { playbook: "resume", status: "blocked", detail: "screen saver on" });
  assert.equal(store.ledgerFor("codex:a").undelivered, null);
  // A presence probe that keeps failing is a failure the owner should hear about.
  store.recordNudge("codex:a", { playbook: "resume", status: "blocked", detail: "front app unknown" });
  store.recordNudge("codex:a", { playbook: "resume", status: "blocked", detail: "presence check too slow" });
  store.recordNudge("codex:a", { playbook: "resume", status: "blocked", detail: "could not verify thread: \"x\" is not the open thread" });
  store.recordNudge("codex:a", { playbook: "resume", status: "failed", detail: "Open Computer Use stopped, timed out, or disconnected" });
  assert.equal(store.ledgerFor("codex:a").undelivered.count, 4);
  store.recordNudge("codex:a", { playbook: "resume", status: "sent" });
  assert.equal(store.ledgerFor("codex:a").undelivered, null);
});

test("the review never clears the supervisor's own can't-deliver finding", async (t) => {
  let now = NOW;
  const model = fakeModel((entries) => entries.map((e) => ({ id: e.id, decision: "close", category: "junk", reason: "looks like a status line" })));
  const stopped = makeThread({ agentStatus: "stalled", prRefs: [], lastAgentAt: ago(40 * MIN), lastActivityAt: ago(40 * MIN) });
  const { supervisor } = fixture(t, {
    mode: "auto", threads: [stopped], now: () => now, review: REVIEW_ON,
    deps: {
      runModel: model.runModel,
      executor: { deliver: async (args) => ({ status: "blocked", route: args.route, detail: "could not verify thread", actionId: null }), inFlight: () => [], whenIdle: async () => {} }
    }
  });
  for (let i = 0; i < 12; i += 1) { await supervisor.tick({ reason: "test" }); now += 5 * MIN; }
  const ask = supervisor.store.openQuestions().find((q) => q.kind === "deliver");
  assert.ok(ask, "still open");
  assert.ok(model.calls.every((call) => call.entries.every((entry) => entry.id !== ask.id)), "never sent to the review");
});

test("the pause clock starts only when a nudge waits, not when the screen merely locked hours ago", async (t) => {
  let now = NOW;
  let stalled = false;
  const thread = () => makeThread({ agentStatus: stalled ? "stalled" : "running", prRefs: [], lastAgentAt: ago(40 * MIN), lastActivityAt: ago(40 * MIN) });
  const driver = { readiness: async () => ({ ready: false, detail: "screen locked" }) };
  const { supervisor } = fixture(t, { mode: "auto", delivery: "computer-use", now: () => now, deps: { uiDriver: driver, listCodexThreads: async () => [thread()] } });
  await supervisor.tick({ reason: "test" });
  now += 3 * 60 * MIN;
  stalled = true;
  await supervisor.tick({ reason: "test" });
  assert.equal(supervisor.store.openQuestions().find((q) => q.dedupeKey === "infra:computer-use"), undefined);
  now += 31 * MIN;
  await supervisor.tick({ reason: "test" });
  assert.match(supervisor.store.openQuestions().find((q) => q.dedupeKey === "infra:computer-use").body, /for 31m/);
});

test("computer-use-first: a thread with no CLI fallback waiting on the UI counts toward the pause alert", async (t) => {
  let now = NOW;
  const locked = makeThread({ writerLocked: true, agentStatus: "stalled", prRefs: [], lastAgentAt: ago(40 * MIN), lastActivityAt: ago(40 * MIN), meta: { originator: "Codex Desktop" } });
  const driver = { readiness: async () => ({ ready: false, detail: "secure input is on: BuildBetter Staging has a password field focused" }) };
  const { supervisor } = fixture(t, { mode: "auto", delivery: "computer-use-first", threads: [locked], now: () => now, deps: { uiDriver: driver } });
  await supervisor.tick({ reason: "test" });
  now += 31 * MIN;
  await supervisor.tick({ reason: "test" });
  assert.ok(supervisor.store.openQuestions().find((q) => q.dedupeKey === "infra:computer-use"));
});

test("computer use unable to type for 30 min tells the owner once why, and the question closes when typing works", async (t) => {
  let now = NOW;
  let ready = false;
  const stopped = makeThread({ agentStatus: "stalled", prRefs: [], lastAgentAt: ago(40 * MIN), lastActivityAt: ago(40 * MIN) });
  const driver = { readiness: async () => (ready ? { ready: true, detail: null } : { ready: false, detail: "secure input is on: BuildBetter Staging has a password field focused" }) };
  const { supervisor } = fixture(t, { mode: "auto", delivery: "computer-use", threads: [stopped], now: () => now, deps: { uiDriver: driver } });
  await supervisor.tick({ reason: "test" });
  const paused = () => supervisor.store.openQuestions().find((q) => q.dedupeKey === "infra:computer-use");
  assert.equal(paused(), undefined, "not yet: under 30 minutes");
  now += 31 * MIN;
  await supervisor.tick({ reason: "test" });
  const q = paused();
  assert.ok(q);
  assert.equal(q.kind, "paused");
  assert.match(q.body, /BuildBetter Staging has a password field focused\. 1 threads wait on a nudge/);
  ready = true;
  now += 5 * MIN;
  await supervisor.tick({ reason: "test" });
  assert.equal(supervisor.store.question(q.id).status, "resolved");
});

test("threads nudges can't reach are always one grouped question, so an answer holds as the set changes", () => {
  const byKey = new Map([["codex:a", makeThread({ key: "codex:a", id: "a" })], ["codex:b", makeThread({ key: "codex:b", id: "b", prRefs: ["acme/app#8"] })]]);
  const ask = (key) => ({ threadKey: key, action: "ask-user", playbook: "resume", question: { kind: "deliver", dedupeKey: `deliver:${key}`, title: "x stopped. Can't nudge it. Nudge it?", body: "3 sends failed", options: ["done", "skip"] } });
  const out = groupQuestions([ask("codex:a"), ask("codex:b")], byKey);
  assert.equal(out.length, 1);
  assert.equal(out[0].dedupeKey, "deliver:group");
  assert.deepEqual(out[0].threadKeys, ["codex:a", "codex:b"]);
  assert.match(out[0].title, /^2 stopped/);
  // One thread left keeps the same key, so an owner answer still covers it.
  const one = groupQuestions([{ ...ask("codex:b"), reason: "can't deliver: could not verify thread. The app would not show this thread." }], byKey);
  assert.equal(one.length, 1);
  assert.equal(one[0].dedupeKey, "deliver:group");
  assert.match(one[0].title, /^1 stopped\. .* Nudge it\?$/);
  assert.match(one[0].body, /\(could not verify thread\. The app would not show this thread\.\)/);
});

test("the owner's skip on the delivery group holds after one of its threads recovers", async (t) => {
  let now = NOW;
  const a = makeThread({ key: "codex:a", id: "a", cwd: "/work/a", agentStatus: "stalled", prRefs: [], lastAgentAt: ago(40 * MIN), lastActivityAt: ago(40 * MIN) });
  const b = makeThread({ key: "codex:b", id: "b", cwd: "/work/b", agentStatus: "stalled", prRefs: [], lastAgentAt: ago(40 * MIN), lastActivityAt: ago(40 * MIN) });
  const threads = [a, b];
  const { supervisor, notified } = fixture(t, {
    mode: "auto", threads, now: () => now,
    deps: {
      listCodexThreads: async () => threads,
      executor: { deliver: async (args) => ({ status: "blocked", route: args.route, detail: "could not verify thread", actionId: null }), inFlight: () => [], whenIdle: async () => {} }
    }
  });
  for (let i = 0; i < 12; i += 1) { await supervisor.tick({ reason: "test" }); now += 5 * MIN; }
  const group = supervisor.store.openQuestions().find((q) => q.dedupeKey === "deliver:group");
  assert.deepEqual([...group.threadKeys].sort(), ["codex:a", "codex:b"]);
  await supervisor.answerQuestion(group.id, "skip");
  // Thread a recovers; b still fails. No new question for b.
  threads.splice(0, 1, { ...a, agentStatus: "running", lastActivityAt: new Date(now).toISOString(), lastAgentAt: new Date(now).toISOString() });
  const before = new Set(notified.map((q) => q.id));
  for (let i = 0; i < 3; i += 1) { await supervisor.tick({ reason: "test" }); now += 5 * MIN; }
  assert.equal(supervisor.store.openQuestions().filter((q) => q.kind === "deliver").length, 0);
  assert.equal(notified.filter((q) => !before.has(q.id) && q.kind === "deliver").length, 0);
});

test("a group answer covers only its threads: a new thread's delivery trouble is asked about on its own", async (t) => {
  let now = NOW;
  const stalled = (key) => makeThread({ key, id: key.split(":")[1], cwd: `/work/${key}`, agentStatus: "stalled", prRefs: [], lastAgentAt: ago(40 * MIN), lastActivityAt: ago(40 * MIN) });
  const threads = [stalled("codex:a")];
  const { supervisor } = fixture(t, {
    mode: "auto", now: () => now,
    deps: {
      listCodexThreads: async () => threads,
      executor: { deliver: async (args) => ({ status: "blocked", route: args.route, detail: "could not verify thread", actionId: null }), inFlight: () => [], whenIdle: async () => {} }
    }
  });
  for (let i = 0; i < 12; i += 1) { await supervisor.tick({ reason: "test" }); now += 5 * MIN; }
  const first = supervisor.store.openQuestions().find((q) => q.dedupeKey === "deliver:group");
  await supervisor.answerQuestion(first.id, "skip");
  // a recovers for good; b starts failing later.
  threads.splice(0, 1, { ...threads[0], agentStatus: "running", lastActivityAt: new Date(now).toISOString(), lastAgentAt: new Date(now).toISOString() });
  threads.push({ ...stalled("codex:b"), lastAgentAt: new Date(now - 40 * MIN).toISOString(), lastActivityAt: new Date(now - 40 * MIN).toISOString() });
  for (let i = 0; i < 12; i += 1) { await supervisor.tick({ reason: "test" }); now += 5 * MIN; }
  const second = supervisor.store.openQuestions().find((q) => q.kind === "deliver");
  assert.ok(second, "b is asked about");
  assert.notEqual(second.id, first.id);
  assert.deepEqual(second.threadKeys, ["codex:b"]);
});

test("the pause alert is for Auto only, and a failed scan does not reset it", async (t) => {
  let now = NOW;
  let codexFails = false;
  const stopped = makeThread({ agentStatus: "stalled", prRefs: [], lastAgentAt: ago(40 * MIN), lastActivityAt: ago(40 * MIN) });
  const driver = { readiness: async () => ({ ready: false, detail: "screen locked" }) };
  const observe = fixture(t, { mode: "observe", delivery: "computer-use", threads: [stopped], now: () => now, deps: { uiDriver: driver } });
  await observe.supervisor.tick({ reason: "test" });
  now += 40 * MIN;
  await observe.supervisor.tick({ reason: "test" });
  assert.equal(observe.supervisor.store.openQuestions().find((q) => q.dedupeKey === "infra:computer-use"), undefined, "observe never sends, so nothing is paused");

  now = NOW;
  const auto = fixture(t, {
    mode: "auto", delivery: "computer-use", now: () => now,
    deps: { uiDriver: driver, listCodexThreads: async () => { if (codexFails) throw new Error("database is locked"); return [stopped]; } }
  });
  await auto.supervisor.tick({ reason: "test" });
  now += 31 * MIN;
  await auto.supervisor.tick({ reason: "test" });
  const q = auto.supervisor.store.openQuestions().find((x) => x.dedupeKey === "infra:computer-use");
  assert.ok(q);
  codexFails = true;
  now += 5 * MIN;
  await auto.supervisor.tick({ reason: "test" });
  assert.equal(auto.supervisor.store.question(q.id).status, "open", "a failed scan keeps the alert");
  codexFails = false;
  now += 5 * MIN;
  await auto.supervisor.tick({ reason: "test" });
  assert.equal(auto.supervisor.store.question(q.id).status, "open");
  assert.match(auto.supervisor.store.question(q.id).body, /for 41m/, "the clock kept running");
});

test("the pause age is that of a nudge still waiting: a new thread starts its own clock", async (t) => {
  let now = NOW;
  let aStuck = true;
  let bStuck = false;
  const stalled = (key, stuck) => makeThread({ key, id: key.split(":")[1], cwd: `/work/${key}`, agentStatus: stuck ? "stalled" : "running", prRefs: [], lastAgentAt: ago(40 * MIN), lastActivityAt: ago(40 * MIN) });
  const driver = { readiness: async () => ({ ready: false, detail: "screen locked" }) };
  const { supervisor } = fixture(t, { mode: "auto", delivery: "computer-use", now: () => now, deps: { uiDriver: driver, listCodexThreads: async () => [stalled("codex:a", aStuck), stalled("codex:b", bStuck)] } });
  await supervisor.tick({ reason: "test" });
  now += 29 * MIN;
  aStuck = false;
  bStuck = true;
  await supervisor.tick({ reason: "test" });
  now += 2 * MIN;
  await supervisor.tick({ reason: "test" });
  assert.equal(supervisor.store.openQuestions().find((q) => q.dedupeKey === "infra:computer-use"), undefined, "b has waited 2 minutes, not 31");
});

test("an answer to one failure streak does not cover the next one after the thread worked", async (t) => {
  let now = NOW;
  let lastAt = ago(40 * MIN);
  const thread = () => makeThread({ agentStatus: "stalled", prRefs: [], lastAgentAt: lastAt, lastActivityAt: lastAt });
  const { supervisor } = fixture(t, {
    mode: "auto", now: () => now,
    deps: {
      listCodexThreads: async () => [thread()],
      executor: { deliver: async (args) => ({ status: "blocked", route: args.route, detail: "could not verify thread", actionId: null }), inFlight: () => [], whenIdle: async () => {} }
    }
  });
  for (let i = 0; i < 12; i += 1) { await supervisor.tick({ reason: "test" }); now += 5 * MIN; }
  const first = supervisor.store.openQuestions().find((q) => q.kind === "deliver");
  await supervisor.answerQuestion(first.id, "skip");
  assert.ok(supervisor.store.ledgerFor("codex:t1").undelivered.ackedAt);
  // The owner nudged it by hand; it worked, then stopped again.
  lastAt = new Date(now - 20 * MIN).toISOString();
  for (let i = 0; i < 14; i += 1) { await supervisor.tick({ reason: "test" }); now += 5 * MIN; }
  assert.equal(supervisor.store.ledgerFor("codex:t1").undelivered.ackedAt, null, "a new streak");
  assert.ok(supervisor.store.openQuestions().find((q) => q.kind === "deliver"), "asked about the new incident");
});

test("the paused-nudge clock survives a restart", async (t) => {
  let now = NOW;
  const stopped = makeThread({ agentStatus: "stalled", prRefs: [], lastAgentAt: ago(40 * MIN), lastActivityAt: ago(40 * MIN) });
  const driver = { readiness: async () => ({ ready: false, detail: "screen locked" }) };
  const first = fixture(t, { mode: "auto", delivery: "computer-use", threads: [stopped], now: () => now, deps: { uiDriver: driver } });
  await first.supervisor.tick({ reason: "test" });
  now += 20 * MIN;
  // Same data dir, new process.
  const again = new FleetSupervisor({ dataDir: first.dataDir, config: first.supervisor.config, deps: { ...first.supervisor.deps, now: () => now } });
  now += 11 * MIN;
  await again.tick({ reason: "test" });
  assert.match(again.store.openQuestions().find((q) => q.dedupeKey === "infra:computer-use").body, /for 31m/);
});

test("more than 50 unreachable threads split into several stored groups", () => {
  const keys = Array.from({ length: 60 }, (_, i) => `codex:t${i}`);
  const byKey = new Map(keys.map((key) => [key, makeThread({ key, id: key.split(":")[1] })]));
  const asks = keys.map((key) => ({ threadKey: key, action: "ask-user", playbook: "resume", reason: "can't deliver: could not verify thread.", question: { kind: "deliver", dedupeKey: `deliver:${key}`, title: "x", body: "y", options: ["done", "skip"] } }));
  const groups = groupQuestions(asks, byKey);
  assert.deepEqual(groups.map((g) => [g.dedupeKey, g.threadKeys.length]), [["deliver:group", 50], ["deliver:group:2", 10]]);
});

test("an answer kept while the Mac could not type is sent once it can, and leaves every list at once", async (t) => {
  let now = NOW;
  let ready = false;
  const asking = makeThread({ writerLocked: true, meta: { originator: "Codex Desktop", pendingQuestion: { text: "Merge despite behavior changes?", options: ["yes", "no"] } } });
  const driver = { readiness: async () => (ready ? { ready: true, detail: null } : { ready: false, detail: "secure input is on: BuildBetter Staging has a password field focused" }) };
  const { supervisor, delivered } = fixture(t, { mode: "auto", delivery: "computer-use", threads: [asking], now: () => now, deps: { uiDriver: driver } });
  await supervisor.tick();
  const q = supervisor.getState().questions.find((x) => x.kind === "agent-ask");
  const result = await supervisor.answerQuestion(q.id, "yes");
  assert.equal(result.delivery.status, "queued");
  assert.equal(supervisor.getState().questions.some((x) => x.id === q.id), false, "off the owner's list");
  now += 5 * MIN;
  await supervisor.tick();
  assert.equal(delivered.filter((d) => d.playbook === "owner-answer").length, 0, "still cannot type");
  ready = true;
  now += 5 * MIN;
  await supervisor.tick();
  const sent = delivered.filter((d) => d.playbook === "owner-answer");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message, "Owner answer: yes. Continue with that.");
  assert.equal(supervisor.store.question(q.id).deliveredAnswer, "sent");
  assert.equal(supervisor.store.queuedAnswers().length, 0);
});

test("a kept answer the owner overtook in the thread is dropped, not sent", async (t) => {
  let now = NOW;
  let ready = false;
  let lastUserAt = ago(120 * MIN);
  const asking = () => makeThread({ writerLocked: true, lastUserAt, lastUserText: "no, wait for Nikhil", meta: { originator: "Codex Desktop", pendingQuestion: { text: "Merge?", options: ["yes", "no"] } } });
  const driver = { readiness: async () => (ready ? { ready: true, detail: null } : { ready: false, detail: "screen locked" }) };
  const { supervisor, delivered } = fixture(t, { mode: "auto", delivery: "computer-use", now: () => now, deps: { uiDriver: driver, listCodexThreads: async () => [asking()] } });
  await supervisor.tick();
  const q = supervisor.getState().questions.find((x) => x.kind === "agent-ask");
  await supervisor.answerQuestion(q.id, "yes");
  lastUserAt = new Date(now + MIN).toISOString();
  ready = true;
  now += 5 * MIN;
  await supervisor.tick();
  assert.equal(delivered.filter((d) => d.playbook === "owner-answer").length, 0);
  assert.equal(supervisor.store.question(q.id).deliveredAnswer, "superseded");
});

test("a kept answer is never sent once the agent no longer asks that question", async (t) => {
  let now = NOW;
  let ready = false;
  let asking = true;
  const thread = () => makeThread({ writerLocked: true, meta: { originator: "Codex Desktop", pendingQuestion: asking ? { text: "Merge despite behavior changes?", options: ["yes", "no"] } : null } });
  const driver = { readiness: async () => (ready ? { ready: true, detail: null } : { ready: false, detail: "screen locked" }) };
  const { supervisor, delivered } = fixture(t, { mode: "auto", delivery: "computer-use", now: () => now, deps: { uiDriver: driver, listCodexThreads: async () => [thread()] } });
  await supervisor.tick();
  const q = supervisor.getState().questions.find((x) => x.kind === "agent-ask");
  await supervisor.answerQuestion(q.id, "yes");
  asking = false;
  ready = true;
  now += 5 * MIN;
  await supervisor.tick();
  assert.equal(delivered.filter((d) => d.playbook === "owner-answer").length, 0, "no stale yes");
  assert.equal(supervisor.store.question(q.id).deliveredAnswer, "superseded");
});

test("a kept answer that cannot be sent within a day goes back to the owner", async (t) => {
  let now = NOW;
  const asking = makeThread({ writerLocked: true, meta: { originator: "Codex Desktop", pendingQuestion: { text: "Merge?", options: ["yes", "no"] } } });
  const driver = { readiness: async () => ({ ready: false, detail: "screen locked" }) };
  const { supervisor } = fixture(t, { mode: "auto", delivery: "computer-use", threads: [asking], now: () => now, deps: { uiDriver: driver } });
  await supervisor.tick();
  const q = supervisor.getState().questions.find((x) => x.kind === "agent-ask");
  await supervisor.answerQuestion(q.id, "yes");
  for (let hour = 0; hour < 25; hour += 1) { now += 60 * MIN; await supervisor.tick(); }
  assert.equal(supervisor.store.question(q.id).status, "open");
  assert.equal(supervisor.store.question(q.id).deliveredAnswer, "dropped");
  assert.equal(supervisor.store.openQuestions().filter((x) => x.dedupeKey === q.dedupeKey).length, 1);
});

test("only a typing wait keeps an answer: a CLI fallback that fails leaves the question open", async (t) => {
  const asking = makeThread({ meta: { originator: "Codex Desktop", pendingQuestion: { text: "Merge?", options: ["yes", "no"] } } });
  const driver = { readiness: async () => ({ ready: false, detail: "screen locked" }), appRunning: async () => true };
  const { supervisor } = fixture(t, {
    mode: "auto", delivery: "computer-use-first", threads: [asking],
    deps: { uiDriver: driver, executor: { deliver: async (args) => ({ status: "failed", route: args.route, detail: "exit 1: out of credits", actionId: null }), inFlight: () => [], whenIdle: async () => {} } }
  });
  await supervisor.tick();
  const q = supervisor.getState().questions.find((x) => x.kind === "agent-ask");
  const result = await supervisor.answerQuestion(q.id, "yes");
  assert.equal(result.question.status, "open");
  assert.equal(supervisor.store.queuedAnswers().length, 0);
});

test("a kept answer sent by a background CLI child settles only when it reached the agent", async (t) => {
  let now = NOW;
  let ready = false;
  let reached = null;
  const asking = makeThread({ meta: { originator: "Codex Desktop", pendingQuestion: { text: "Merge?", options: ["yes", "no"] } } });
  const driver = { readiness: async () => (ready ? { ready: true, detail: null } : { ready: false, detail: "screen locked" }) };
  const deliveries = [];
  const { supervisor } = fixture(t, {
    mode: "auto", delivery: "computer-use", threads: [asking], now: () => now,
    deps: { uiDriver: driver, executor: { deliver: async (args) => { deliveries.push(args); return { status: "sent", route: args.route, detail: "started", actionId: null, done: new Promise((resolve) => { reached = resolve; }) }; }, inFlight: () => [], whenIdle: async () => {} } }
  });
  await supervisor.tick();
  const q = supervisor.getState().questions.find((x) => x.kind === "agent-ask");
  await supervisor.answerQuestion(q.id, "yes");
  ready = true;
  now += 5 * MIN;
  await supervisor.tick();
  const answers = () => deliveries.filter((d) => d.playbook === "owner-answer").length;
  assert.equal(answers(), 1);
  assert.equal(supervisor.store.queuedAnswers().length, 1, "kept until the child reports");
  reached(false);
  await new Promise((resolve) => setImmediate(resolve));
  now += 5 * MIN;
  await supervisor.tick();
  assert.equal(answers(), 2, "the child failed: sent again");
  reached(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(supervisor.store.question(q.id).deliveredAnswer, "sent");
});

test("a thread that just got a kept answer gets no automatic nudge the same tick, and pending answers are never pruned", async (t) => {
  let now = NOW;
  let ready = false;
  // Asks and has a PR that would also get a merge-ready nudge.
  const asking = makeThread({ writerLocked: true, meta: { originator: "Codex Desktop", pendingQuestion: { text: "Merge?", options: ["yes", "no"] } } });
  const driver = { readiness: async () => (ready ? { ready: true, detail: null } : { ready: false, detail: "screen locked" }) };
  const { supervisor, delivered } = fixture(t, { mode: "auto", delivery: "computer-use", threads: [asking], now: () => now, deps: { uiDriver: driver } });
  await supervisor.tick();
  const q = supervisor.getState().questions.find((x) => x.kind === "agent-ask");
  await supervisor.answerQuestion(q.id, "yes");
  for (let i = 0; i < 260; i += 1) supervisor.store.upsertQuestion({ dedupeKey: `junk:${i}`, kind: "infra", title: `t${i}`, options: ["ok"] }) && supervisor.store.dismissQuestion(supervisor.store.openQuestions().find((x) => x.dedupeKey === `junk:${i}`).id);
  assert.ok(supervisor.store.question(q.id)?.pendingDelivery, "kept through pruning");
  ready = true;
  now += 5 * MIN;
  const before = delivered.length;
  await supervisor.tick();
  const sent = delivered.slice(before).filter((d) => d.thread.key === "codex:t1");
  assert.deepEqual(sent.map((d) => d.playbook), ["owner-answer"]);
});

test("a kept retry after a login or disk fix is sent even though that blocker is no longer asked", async (t) => {
  let now = NOW;
  let ready = false;
  let fixed = false;
  const thread = () => makeThread({ writerLocked: true, agentStatus: fixed ? "idle" : "error", error: fixed ? null : { kind: "disk-full", resetAt: null }, meta: { originator: "Codex Desktop" } });
  const driver = { readiness: async () => (ready ? { ready: true, detail: null } : { ready: false, detail: "screen locked" }) };
  const { supervisor, delivered } = fixture(t, { mode: "observe", delivery: "computer-use", now: () => now, deps: { uiDriver: driver, listCodexThreads: async () => [thread()] } });
  await supervisor.tick();
  const q = supervisor.store.upsertQuestion({ kind: "infra", dedupeKey: "infra:disk:codex:t1", threadKey: "codex:t1", title: "Disk full. Retry?", options: ["retry", "later"] });
  const result = await supervisor.answerQuestion(q.id, "retry");
  assert.equal(result.delivery.status, "queued");
  fixed = true;
  ready = true;
  now += 5 * MIN;
  await supervisor.tick();
  assert.equal(delivered.filter((d) => d.playbook === "owner-answer").length, 1);
});

test("a kept answer past its day goes back to the owner even while its source cannot be read", async (t) => {
  let now = NOW;
  let codexFails = false;
  const asking = makeThread({ writerLocked: true, meta: { originator: "Codex Desktop", pendingQuestion: { text: "Merge?", options: ["yes", "no"] } } });
  const driver = { readiness: async () => ({ ready: false, detail: "screen locked" }) };
  const { supervisor } = fixture(t, { mode: "auto", delivery: "computer-use", now: () => now, deps: { uiDriver: driver, listCodexThreads: async () => { if (codexFails) throw new Error("database is locked"); return [asking]; } } });
  await supervisor.tick();
  const q = supervisor.getState().questions.find((x) => x.kind === "agent-ask");
  await supervisor.answerQuestion(q.id, "yes");
  codexFails = true;
  now += 25 * 60 * MIN;
  await supervisor.tick();
  assert.equal(supervisor.store.question(q.id).deliveredAnswer, "dropped");
  assert.equal(supervisor.store.queuedAnswers().length, 0);
});

test("a kept answer whose send stalls Open Computer Use stops the tick's other typing", async (t) => {
  let now = NOW;
  let ready = false;
  const asking = Array.from({ length: 3 }, (_, i) => makeThread({ key: `codex:k${i}`, id: `k${i}`, cwd: `/work/k${i}`, title: `Ask ${i}`, writerLocked: true, meta: { originator: "Codex Desktop", pendingQuestion: { text: `Merge ${i}?`, options: ["yes", "no"] } } }));
  const stopped = makeThread({ key: "codex:dead", id: "dead", cwd: "/work/dead", title: "Stopped", writerLocked: true, agentStatus: "stalled", prRefs: [], lastAgentAt: ago(40 * MIN), lastActivityAt: ago(40 * MIN), meta: { originator: "Codex Desktop" } });
  const delivered = [];
  const executor = { deliver: async (args) => { delivered.push(args); return { status: "failed", route: args.route, detail: "Open Computer Use timed out after 45s on get_app_state; nothing typed", actionId: null }; }, inFlight: () => [], whenIdle: async () => {} };
  const driver = { readiness: async () => (ready ? { ready: true, detail: null } : { ready: false, detail: "screen locked" }) };
  const { supervisor } = fixture(t, { mode: "auto", delivery: "computer-use", threads: [...asking, stopped], now: () => now, deps: { uiDriver: driver, executor } });
  await supervisor.tick();
  for (const q of supervisor.getState().questions.filter((x) => x.kind === "agent-ask")) await supervisor.answerQuestion(q.id, "yes");
  assert.equal(supervisor.store.queuedAnswers().length, 3);
  delivered.length = 0;
  ready = true;
  now += 5 * MIN;
  const snapshot = await supervisor.tick();
  assert.equal(delivered.length, 1, "one stalled send, then nothing else types this tick");
  assert.equal(delivered[0].playbook, "owner-answer");
  assert.equal(supervisor.store.queuedAnswers().length, 3, "the others wait for the next tick");
  assert.ok(snapshot.threads.some((row) => row.key === "codex:dead" && /deferred: Open Computer Use stalled/.test(row.decision?.reason ?? "")));
});

test("kept answers share the tick's send cap; the rest wait for the next tick", async (t) => {
  let now = NOW;
  let ready = false;
  const threads = Array.from({ length: DEFAULTS.maxSendsPerTick + 2 }, (_, i) => makeThread({ key: `codex:k${i}`, id: `k${i}`, cwd: `/work/k${i}`, writerLocked: true, meta: { originator: "Codex Desktop", pendingQuestion: { text: `Merge ${i}?`, options: ["yes", "no"] } } }));
  const driver = { readiness: async () => (ready ? { ready: true, detail: null } : { ready: false, detail: "screen locked" }) };
  const { supervisor, delivered } = fixture(t, { mode: "auto", delivery: "computer-use", threads, now: () => now, deps: { uiDriver: driver } });
  await supervisor.tick();
  for (const q of supervisor.getState().questions.filter((x) => x.kind === "agent-ask")) await supervisor.answerQuestion(q.id, "yes");
  ready = true;
  now += 5 * MIN;
  await supervisor.tick();
  assert.equal(delivered.length, DEFAULTS.maxSendsPerTick);
  assert.equal(supervisor.store.queuedAnswers().length, 2);
  now += 5 * MIN;
  await supervisor.tick();
  assert.equal(supervisor.store.queuedAnswers().length, 0);
});

test("a kept retry the agent overtook (it spoke since) is dropped, not sent", async (t) => {
  let now = NOW;
  let ready = false;
  let lastAgentAt = ago(60 * MIN);
  const thread = () => makeThread({ writerLocked: true, lastAgentAt, meta: { originator: "Codex Desktop" } });
  const driver = { readiness: async () => (ready ? { ready: true, detail: null } : { ready: false, detail: "screen locked" }) };
  const { supervisor, delivered } = fixture(t, { mode: "observe", delivery: "computer-use", now: () => now, deps: { uiDriver: driver, listCodexThreads: async () => [thread()] } });
  await supervisor.tick();
  const q = supervisor.store.upsertQuestion({ kind: "infra", dedupeKey: "infra:login:codex:t1", threadKey: "codex:t1", title: "Logged out. Retry?", options: ["retry", "later"] });
  await supervisor.answerQuestion(q.id, "retry");
  lastAgentAt = new Date(now + MIN).toISOString();
  ready = true;
  now += 5 * MIN;
  await supervisor.tick();
  assert.equal(delivered.filter((d) => d.playbook === "owner-answer").length, 0);
  assert.equal(supervisor.store.question(q.id).deliveredAnswer, "superseded");
});

test("an answer is only reported saved if it was stored", async (t) => {
  const asking = makeThread({ writerLocked: true, meta: { originator: "Codex Desktop", pendingQuestion: { text: "Merge?", options: ["yes", "no"] } } });
  let supervisorRef = null;
  let questionId = null;
  // The question closes while the answer is being handled (a tick resolved it).
  const driver = { readiness: async () => { if (questionId) supervisorRef.store.resolveQuestion(questionId, "condition gone"); return { ready: false, detail: "screen locked" }; } };
  const { supervisor } = fixture(t, { mode: "auto", delivery: "computer-use", threads: [asking], deps: { uiDriver: driver } });
  supervisorRef = supervisor;
  await supervisor.tick();
  const q = supervisor.getState().questions.find((x) => x.kind === "agent-ask");
  questionId = q.id;
  const result = await supervisor.answerQuestion(q.id, "yes");
  assert.notEqual(result.delivery.status, "queued");
  assert.equal(supervisor.store.queuedAnswers().length, 0);
});

test("Scan now rechecks every open question with the review, not only new or due ones", async (t) => {
  let now = NOW;
  const model = fakeModel((entries) => entries.map((e) => ({ id: e.id, decision: "keep", category: "live", reason: "still waits on the owner" })));
  const { supervisor } = fixture(t, { threads: [asking()], prs: new Map(), now: () => now, review: REVIEW_ON, deps: { runModel: model.runModel } });
  await supervisor.tick({ reason: "interval" });
  assert.equal(model.calls.length, 1, "a new question is reviewed");
  now += 11 * MIN;
  await supervisor.tick({ reason: "interval" });
  assert.equal(model.calls.length, 1, "unchanged and not due: no review on a scheduled scan");
  await supervisor.tick({ reason: "owner-scan" });
  assert.equal(model.calls.length, 2, "the owner's Scan now rechecks it");
  assert.equal(model.calls[1].entries.length, 1);
});

test("Scan now reviews every open question even past one batch, and an overlapping scan gets its own", async (t) => {
  const threads = Array.from({ length: 20 }, (_, i) => asking({ key: `codex:q${i}`, id: `q${i}`, cwd: `/work/q${i}`, lastAgentText: `Want me to merge #${i} now or wait for review?` }));
  const model = fakeModel((entries) => entries.map((e) => ({ id: e.id, decision: "keep", category: "live", reason: "waits" })));
  const { supervisor } = fixture(t, { threads, prs: new Map(), review: REVIEW_ON, deps: { runModel: model.runModel } });
  await supervisor.tick({ reason: "owner-scan" });
  const reviewed = new Set(model.calls.flatMap((call) => call.entries.map((e) => e.id)));
  assert.equal(reviewed.size, supervisor.store.openQuestions().filter((q) => q.kind === "agent-ask").length);
  assert.ok(model.calls.length >= 2, "more than one batch");
  // An owner scan that lands while a scan runs is run again, forced, after it.
  const calls = model.calls.length;
  const first = supervisor.tick({ reason: "interval" });
  const second = supervisor.tick({ reason: "owner-scan" });
  await first; await second;
  assert.ok(model.calls.length > calls, "the follow-up forced a review");
});

test("a thread waiting on a permission card: one screen read, its buttons as options, and a tap clicks that button", async (t) => {
  const card = { text: "Run npm test in s1?", buttons: ["Allow once", "Deny"], stateId: "0123456789abcdef" };
  const reads = [];
  const clicks = [];
  const driver = {
    readiness: async () => ({ ready: true, detail: null }),
    inspect: async (request) => { reads.push(request); return { status: "read", detail: "read Conductor", screen: { prompt: card, running: false, resume: [], draft: false, text: "" } }; },
    clickLabel: async (request) => { clicks.push(request); return { status: "sent", detail: "clicked Allow once in Conductor" }; }
  };
  const waiting = makeThread({ key: "conductor:s1", kind: "conductor", id: "s1", workspace: "s1", cwd: "/work/s1", agentStatus: "waiting", prRefs: [], meta: { ...uiMeta("s1"), blockedOnOwner: true } });
  const { supervisor } = fixture(t, { threads: [waiting], prs: new Map(), mode: "propose", delivery: "computer-use", deps: { uiDriver: driver } });
  await supervisor.tick();
  assert.equal(reads.length, 1, "one read for the card's labels");
  assert.equal(reads[0].target.app, "conductor");
  assert.equal(reads[0].navigate, false, "Propose reads only a thread already on screen");
  const question = supervisor.getState().questions.find((q) => q.kind === "prompt");
  assert.deepEqual(question.options, ["Allow once", "Deny", "later"]);
  assert.equal(question.dedupeKey, "prompt:conductor:s1:0123456789abcdef");
  assert.deepEqual(question.meta, { promptStateId: "0123456789abcdef" });
  assert.deepEqual(supervisor.getState().snapshot.threads[0].prompt.buttons, ["Allow once", "Deny"]);
  await supervisor.tick();
  assert.equal(reads.length, 1, "a known card is not read again");

  const answered = await supervisor.answerQuestion(question.id, "Allow once");
  assert.equal(answered.delivery.status, "sent");
  assert.equal(answered.question.status, "answered");
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0].label, "Allow once");
  assert.equal(clicks[0].stateId, "0123456789abcdef");
  assert.ok(supervisor.getState().actions.some((action) => action.kind === "click" && action.status === "sent"));
  assert.equal(supervisor.livePrompt(waiting), null, "the clicked card is forgotten");
});

test("a click the app refuses leaves the prompt question open", async (t) => {
  const card = { text: "Run it?", buttons: ["Allow", "Deny"], stateId: "fedcba9876543210" };
  const driver = {
    readiness: async () => ({ ready: true, detail: null }),
    inspect: async () => ({ status: "read", detail: "read", screen: { prompt: card } }),
    clickLabel: async () => ({ status: "blocked", detail: "prompt changed; read again" })
  };
  const waiting = makeThread({ key: "conductor:s1", kind: "conductor", id: "s1", workspace: "s1", agentStatus: "waiting", prRefs: [], meta: { ...uiMeta("s1"), blockedOnOwner: true } });
  const { supervisor } = fixture(t, { threads: [waiting], prs: new Map(), mode: "propose", delivery: "computer-use", deps: { uiDriver: driver } });
  await supervisor.tick();
  const question = supervisor.getState().questions.find((q) => q.kind === "prompt");
  const result = await supervisor.answerQuestion(question.id, "Allow");
  assert.equal(result.delivery.status, "blocked");
  assert.equal(supervisor.store.question(question.id).status, "open");
});

test("tick screen reads: none in Observe, and a read that finds no card is not repeated until the thread moves", async (t) => {
  let now = NOW;
  const reads = [];
  const driver = {
    readiness: async () => ({ ready: true, detail: null }),
    inspect: async (request) => { reads.push(request); return { status: "read", detail: "read Conductor", screen: { prompt: null, running: false, resume: [], draft: false, text: "Should I push?" } }; }
  };
  let waiting = makeThread({ key: "conductor:s1", kind: "conductor", id: "s1", workspace: "s1", cwd: "/work/s1", agentStatus: "waiting", prRefs: [], meta: { ...uiMeta("s1"), blockedOnOwner: true } });
  const observed = fixture(t, { threads: [waiting], prs: new Map(), delivery: "computer-use", deps: { uiDriver: driver } });
  for (let tick = 0; tick < 4; tick += 1) await observed.supervisor.tick();
  assert.equal(reads.length, 0, "Observe drives no app, reads included");

  const threads = [waiting];
  const { supervisor } = fixture(t, { threads, prs: new Map(), mode: "propose", now: () => now, delivery: "computer-use",
    deps: { uiDriver: driver, listConductorThreads: async () => threads } });
  for (let tick = 0; tick < 3; tick += 1) { await supervisor.tick(); now += 5 * MIN; }
  assert.equal(reads.length, 1, "no card found: not read again while the thread has not moved");
  now += 20 * MIN;
  await supervisor.tick();
  assert.equal(reads.length, 2, "after the backoff, one more read");
  now += 20 * MIN;
  await supervisor.tick();
  assert.equal(reads.length, 2, "the backoff doubles for a thread still unmoved");
  waiting = { ...waiting, lastAgentAt: new Date(now).toISOString() };
  threads[0] = waiting;
  await supervisor.tick();
  assert.equal(reads.length, 3, "a thread that moved is read again");
});

test("Conductor unreadable for a while: one restart question, a restart that pins its chats, then each stopped chat resumes once", async (t) => {
  let now = NOW;
  const delivered = [];
  const executor = {
    deliver: async (args) => { delivered.push(args); return { status: "sent", route: args.route, detail: "typed into Conductor", actionId: null }; },
    inFlight: () => [], whenIdle: async () => {}
  };
  const restarts = [];
  const appController = { restart: async (app) => { restarts.push(app); return { ok: true, detail: "restarted Conductor" }; } };
  const unreadable = { status: "blocked", detail: "can't read Conductor: Open Computer Use finds no window (cgWindowNotFound); nothing typed", code: "appUnreadable" };
  const driver = { readiness: async () => ({ ready: true, detail: null }), inspect: async () => unreadable };
  let busy = makeThread({ key: "conductor:s2", kind: "conductor", id: "s2", workspace: "amman", cwd: "/work/s2", agentStatus: "running", prRefs: [], lastUserAt: ago(5 * 60 * MIN), meta: uiMeta("s2") });
  const idle = makeThread({ key: "conductor:s1", kind: "conductor", id: "s1", workspace: "madrid", cwd: "/work/s1", agentStatus: "idle", prRefs: [], meta: uiMeta("s1") });
  const threads = [idle, busy];
  const { supervisor } = fixture(t, { threads, prs: new Map(), now: () => now, delivery: "computer-use", deps: { uiDriver: driver, executor, appController,
    listConductorThreads: async () => threads.map((thread) => (thread.key === busy.key ? busy : thread)) } });
  await supervisor.tick();
  await supervisor.screenThread("conductor:s1");
  await supervisor.screenThread("conductor:s1");
  await supervisor.tick();
  assert.equal(supervisor.getState().questions.filter((q) => q.kind === "infra").length, 0, "too soon: under ten minutes");
  now += 11 * MIN;
  await supervisor.screenThread("conductor:s1");
  await supervisor.tick();
  const question = supervisor.getState().questions.find((q) => q.dedupeKey === "infra:unreadable:conductor");
  assert.ok(question, "asked after three failures over two ticks and ten minutes");
  assert.equal(question.title, "Computer use can't read Conductor. Restart it?");
  assert.deepEqual(question.options, ["restart", "later"]);
  assert.match(question.body, /Running in Conductor: amman/);
  assert.deepEqual(question.meta, { app: "conductor", runningKeys: ["conductor:s2"] });

  // Another chat starting since the question was asked blocks the restart.
  const more = await supervisor.appAction("conductor", "restart", { expectRunning: [] });
  assert.equal(more.ok, false);
  assert.match(more.detail, /1 more chats running in Conductor than approved/);
  assert.deepEqual(restarts, []);

  const answered = await supervisor.answerQuestion(question.id, "restart");
  assert.equal(answered.delivery.status, "sent", answered.delivery.detail);
  assert.deepEqual(restarts, ["conductor"]);
  assert.deepEqual(supervisor.store.appRestart("conductor").threadKeys, ["conductor:s2"]);
  assert.ok(supervisor.store.restartedAt("conductor"), "the restart time is kept in the store");

  // Next tick: the stopped chat (idle now) gets its one resume, in observe mode too.
  busy = { ...busy, agentStatus: "idle" };
  now += MIN;
  const before = delivered.length;
  await supervisor.tick();
  const resumed = delivered.slice(before).filter((args) => args.playbook === "app-restarted");
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].thread.key, "conductor:s2");
  assert.match(resumed[0].message, /owner restarted Conductor/);
  assert.equal(supervisor.store.appRestart("conductor"), null);
  now += 20 * MIN;
  await supervisor.tick();
  assert.equal(delivered.filter((args) => args.playbook === "app-restarted").length, 1, "once");
  assert.equal(supervisor.getState().questions.filter((q) => q.dedupeKey === "infra:unreadable:conductor").length, 0, "a good restart clears the question");
});

test("quit and restart re-read running chats first: a turn started after the last scan blocks them", async (t) => {
  const restarts = [];
  const appController = { restart: async (app) => { restarts.push(app); return { ok: true, detail: "restarted Conductor" }; }, quit: async (app) => { restarts.push(`quit:${app}`); return { ok: true, detail: "quit Conductor" }; } };
  let a = makeThread({ key: "conductor:a", kind: "conductor", id: "a", workspace: "a", agentStatus: "idle", prRefs: [], meta: uiMeta("a") });
  let failing = false;
  const { supervisor } = fixture(t, { prs: new Map(), delivery: "computer-use", deps: { uiDriver: readyDriver(), appController,
    listCodexThreads: async () => [], listConductorThreads: async () => { if (failing) throw new Error("db locked"); return [a]; } } });
  await supervisor.tick();
  a = { ...a, agentStatus: "running" };
  for (const action of ["restart", "quit"]) {
    const refused = await supervisor.appAction("conductor", action, { expectRunning: [] });
    assert.equal(refused.ok, false, action);
    assert.match(refused.detail, /1 more chats running in Conductor than approved/);
  }
  assert.deepEqual(restarts, []);
  failing = true;
  const unknown = await supervisor.appAction("conductor", "restart", { expectRunning: ["conductor:a"] });
  assert.equal(unknown.ok, false);
  assert.match(unknown.detail, /could not read which chats are running in Conductor/);
  assert.deepEqual(restarts, []);
  failing = false;
  const ran = await supervisor.appAction("conductor", "restart", { expectRunning: ["conductor:a"] });
  assert.equal(ran.ok, true);
  assert.deepEqual(ran.running, ["conductor:a"]);
  assert.deepEqual(supervisor.store.appRestart("conductor").threadKeys, ["conductor:a"], "the fresh turn gets its resume");
});

test("the chats a quit or restart would stop are read live, out-of-scope chats included", async (t) => {
  const appController = { restart: async () => ({ ok: true, detail: "restarted Conductor" }) };
  let a = makeThread({ key: "conductor:a", kind: "conductor", id: "a", workspace: "a", agentStatus: "idle", prRefs: [], meta: uiMeta("a") });
  const b = makeThread({ key: "conductor:b", kind: "conductor", id: "b", workspace: "b", agentStatus: "running", prRefs: [], excluded: "no-repo", meta: uiMeta("b") });
  const { supervisor } = fixture(t, { prs: new Map(), delivery: "computer-use", deps: { uiDriver: readyDriver(), appController,
    listCodexThreads: async () => [], listConductorThreads: async () => [a, b] } });
  await supervisor.tick();
  assert.equal((supervisor.getState().snapshot.threads ?? []).some((row) => row.key === "conductor:b"), false, "the scan leaves b out");
  a = { ...a, agentStatus: "running" };
  const running = await supervisor.runningInApp("conductor");
  assert.deepEqual(running.map((row) => row.key).sort(), ["conductor:a", "conductor:b"]);
  assert.equal((await supervisor.appAction("conductor", "restart", { expectRunning: running.map((row) => row.key) })).ok, true);
});

test("a Conductor tab and the Codex thread it hosts get one resume after a restart", async (t) => {
  let now = NOW;
  const delivered = [];
  const executor = { deliver: async (args) => { delivered.push(args); return { status: "sent", route: args.route, detail: "ok" }; }, inFlight: () => [], whenIdle: async () => {} };
  const appController = { restart: async () => ({ ok: true, detail: "restarted Conductor" }) };
  let tab = makeThread({ key: "conductor:s9", kind: "conductor", id: "s9", claudeSessionId: "t9", workspace: "madrid", cwd: "/work/s9", agentStatus: "running", prRefs: [], meta: uiMeta("s9") });
  let hosted = makeThread({ key: "codex:t9", id: "t9", cwd: "/work/t9", agentStatus: "running", prRefs: [], meta: { originator: "codex_sdk_ts" } });
  const { supervisor } = fixture(t, { prs: new Map(), now: () => now, delivery: "computer-use", deps: { uiDriver: readyDriver(), executor, appController,
    listCodexThreads: async () => [hosted], listConductorThreads: async () => [tab] } });
  await supervisor.tick();
  assert.equal((await supervisor.appAction("conductor", "restart", { expectRunning: ["conductor:s9", "codex:t9"] })).ok, true);
  assert.deepEqual([...supervisor.store.appRestart("conductor").threadKeys].sort(), ["codex:t9", "conductor:s9"]);
  tab = { ...tab, agentStatus: "idle" };
  hosted = { ...hosted, agentStatus: "idle" };
  now += 2 * MIN;
  await supervisor.tick();
  assert.equal(delivered.filter((args) => args.playbook === "app-restarted").length, 1, "one resume per chat on screen");
  assert.equal(supervisor.store.appRestart("conductor"), null, "both keys settled");
  now += 20 * MIN;
  await supervisor.tick();
  assert.equal(delivered.filter((args) => args.playbook === "app-restarted").length, 1);
});

test("a turn the restart killed still reads running for a while: its resume waits, then goes once it reads idle", async (t) => {
  let now = NOW;
  const delivered = [];
  const executor = { deliver: async (args) => { delivered.push(args); return { status: "sent", route: args.route, detail: "ok" }; }, inFlight: () => [], whenIdle: async () => {} };
  const appController = { restart: async () => ({ ok: true, detail: "restarted Codex" }) };
  const before = new Date(NOW - MIN).toISOString();
  let a = makeThread({ key: "conductor:a", kind: "conductor", id: "a", workspace: "a", agentStatus: "running", prRefs: [], lastAgentAt: before, meta: uiMeta("a") });
  let b = makeThread({ key: "conductor:b", kind: "conductor", id: "b", workspace: "b", agentStatus: "running", prRefs: [], lastAgentAt: before, meta: uiMeta("b") });
  const { supervisor } = fixture(t, { prs: new Map(), now: () => now, delivery: "computer-use", deps: { uiDriver: readyDriver(), executor, appController,
    listCodexThreads: async () => [], listConductorThreads: async () => [a, b] } });
  await supervisor.tick();
  assert.equal((await supervisor.appAction("conductor", "restart", { expectRunning: ["conductor:a", "conductor:b"] })).ok, true);
  now += MIN;
  await supervisor.tick();
  assert.equal(delivered.filter((args) => args.playbook === "app-restarted").length, 0, "still reads running: wait");
  assert.ok(supervisor.store.appRestart("conductor"), "the record is kept");
  // b really runs again (the agent wrote after the restart); a's stale turn ends.
  a = { ...a, agentStatus: "idle" };
  b = { ...b, lastAgentAt: new Date(now).toISOString() };
  now += 15 * MIN;
  await supervisor.tick();
  const resumed = delivered.filter((args) => args.playbook === "app-restarted").map((args) => args.thread.key);
  assert.deepEqual(resumed, ["conductor:a"]);
  assert.equal(supervisor.store.appRestart("conductor"), null, "both settled");
});

test("a chat the owner wrote to after the restart, or running again, gets no resume; a quit resumes only after the fleet opens the app", async (t) => {
  let now = NOW;
  const delivered = [];
  const executor = { deliver: async (args) => { delivered.push(args); return { status: "sent", route: args.route, detail: "ok" }; }, inFlight: () => [], whenIdle: async () => {} };
  const appController = { quit: async () => ({ ok: true, detail: "quit Conductor" }), open: async () => ({ ok: true, detail: "opened Conductor" }) };
  let a = makeThread({ key: "conductor:a", kind: "conductor", id: "a", workspace: "a", agentStatus: "running", prRefs: [], meta: uiMeta("a") });
  let b = makeThread({ key: "conductor:b", kind: "conductor", id: "b", workspace: "b", agentStatus: "running", prRefs: [], meta: uiMeta("b") });
  const { supervisor } = fixture(t, { prs: new Map(), now: () => now, delivery: "computer-use", deps: { uiDriver: readyDriver(), executor, appController,
    listCodexThreads: async () => [], listConductorThreads: async () => [a, b] } });
  await supervisor.tick();
  assert.equal((await supervisor.appAction("conductor", "quit", { expectRunning: ["conductor:a", "conductor:b"] })).ok, true);
  a = { ...a, agentStatus: "idle" };
  b = { ...b, agentStatus: "idle", lastUserAt: new Date(now + MIN).toISOString(), lastUserText: "I'll take it from here" };
  now += 2 * MIN;
  await supervisor.tick();
  assert.equal(delivered.filter((args) => args.playbook === "app-restarted").length, 0, "not while the app stays quit");
  assert.equal((await supervisor.appAction("conductor", "open")).ok, true);
  now += MIN;
  await supervisor.tick();
  const resumed = delivered.filter((args) => args.playbook === "app-restarted").map((args) => args.thread.key);
  assert.deepEqual(resumed, ["conductor:a"], "b: the owner wrote since");
});

// --- idle watcher ---------------------------------------------------------------

test("the idle watcher reads idle only while sends wait on the owner, then starts one sends-only scan", async () => {
  let now = Date.parse("2026-10-08T12:00:00Z");
  const reads = [];
  const ticks = [];
  let idle = 0;
  const watcher = {
    mode: "auto", running: null, idleTimer: 1, config: { tickMs: 5 * 60_000, limits: {} }, now: () => now,
    uiDriver: { idleMs: async () => { reads.push(now); return idle; } },
    tick: async (options) => { ticks.push(options); }
  };
  const check = () => FleetSupervisor.prototype.idleCheck.call(watcher);
  assert.equal(await check(), false);
  assert.equal(reads.length, 0, "nothing waits: no idle read at all");
  watcher.idleWorkAt = now;
  idle = 30_000;
  assert.equal(await check(), false, "the owner is still around");
  assert.equal(reads.length, 1);
  // The first scan is taken to reach its sends in 45 s: it starts at 75 s idle.
  idle = 76_000;
  assert.equal(await check(), true);
  assert.deepEqual(ticks, [{ reason: "owner-away" }]);
  assert.equal(watcher.idleWorkAt, null);
  // Re-armed by another presence block: not again within a minute.
  watcher.idleWorkAt = now;
  now += 30_000;
  assert.equal(await check(), false);
  assert.equal(reads.length, 2, "the one-minute gap needs no read");
  // A measured lead moves the start; a scan already running is never doubled.
  now += 60_000;
  watcher.awayLeadMs = 20_000;
  idle = 90_000;
  assert.equal(await check(), false, "with a 20 s lead it waits for 100 s idle");
  watcher.running = Promise.resolve();
  idle = 110_000;
  assert.equal(await check(), false);
  watcher.running = null;
  assert.equal(await check(), true);
  // Not in Auto, or a stale wait from long ago: nothing.
  watcher.idleWorkAt = now;
  now += 120_000;
  watcher.mode = "propose";
  assert.equal(await check(), false);
  watcher.mode = "auto";
  now += 11 * 60_000;
  assert.equal(await check(), false);
  assert.equal(watcher.idleWorkAt, null, "older than two ticks: the next scheduled scan decides");
  // Stopped while the idle read was in flight: no scan after shutdown.
  watcher.idleWorkAt = now;
  watcher.uiDriver = { idleMs: async () => { watcher.idleTimer = null; return 600_000; } };
  const before = ticks.length;
  assert.equal(await check(), false);
  assert.equal(ticks.length, before);
});

test("a scheduled scan during an idle-watcher scan runs after it, with the review", async (t) => {
  const { supervisor } = fixture(t, { mode: "auto" });
  const reasons = [];
  let release;
  supervisor._tick = async (reason) => { reasons.push(reason); if (reason === "owner-away") await new Promise((resolve) => { release = resolve; }); return {}; };
  const away = supervisor.tick({ reason: "owner-away" });
  const interval = supervisor.tick({ reason: "interval" });
  assert.notEqual(interval, away);
  assert.equal(supervisor.tick({ reason: "interval" }), interval, "one follow-up, however many intervals");
  release();
  await interval;
  assert.deepEqual(reasons, ["owner-away", "interval"]);
  // An interval during a normal scan still joins it.
  supervisor._tick = async (reason) => { reasons.push(reason); return {}; };
  const first = supervisor.tick({ reason: "interval" });
  assert.equal(supervisor.tick({ reason: "interval" }), first);
  await first;
  assert.deepEqual(reasons, ["owner-away", "interval", "interval"]);
  // Stopped meanwhile: the follow-up never scans.
  supervisor._tick = async (reason) => { reasons.push(reason); if (reason === "owner-away") await new Promise((resolve) => { release = resolve; }); return {}; };
  supervisor.tick({ reason: "owner-away" });
  const queued = supervisor.tick({ reason: "interval" });
  supervisor.stop();
  release();
  assert.equal(await queued, null);
  assert.deepEqual(reasons, ["owner-away", "interval", "interval", "owner-away"]);
});

test("a presence-blocked app send arms the idle watcher; a watcher scan skips the review", async (t) => {
  const { supervisor } = fixture(t, { mode: "auto", delivery: "computer-use", deliverStatus: "blocked", deps: { uiDriver: readyDriver() } });
  const inner = supervisor.deps.executor.deliver;
  supervisor.deps.executor.deliver = async (args) => ({ ...(await inner(args)), status: "blocked", detail: "owner using Conductor" });
  supervisor._executor = null;
  assert.equal(supervisor.idleWorkAt ?? null, null);
  await supervisor.executor.deliver({ thread: makeThread(), message: "go", route: "computer-use", playbook: "owner-message" });
  assert.equal(supervisor.idleWorkAt ?? null, null, "the owner's own message is not kept: nothing to wait for");
  await supervisor.executor.deliver({ thread: makeThread(), message: "go", route: "computer-use", playbook: "resume" });
  assert.ok(Number.isFinite(supervisor.idleWorkAt));
  // A later block counts from then, not from the first one.
  supervisor.idleWorkAt = 1;
  await supervisor.executor.deliver({ thread: makeThread(), message: "go", route: "computer-use", playbook: "resume" });
  assert.equal(supervisor.idleWorkAt, supervisor.now());
  let reviewed = 0;
  supervisor.reviewOpenQuestions = async () => { reviewed += 1; return new Set(); };
  await supervisor.tick({ reason: "owner-away" });
  assert.equal(reviewed, 0);
  assert.ok(Number.isFinite(supervisor.awayLeadMs));
  await supervisor.tick({ reason: "interval" });
  assert.equal(reviewed, 1);
});

// ---------- question cards ----------

const cardItems = () => [
  { index: 0, itemId: "toolu_card:0", header: "End-of-day count", question: "Where should the end-of-day count be built?", options: ["Chat-analysis worker (Recommended)", "Sales worker + inbox module", "Work-queue only"], multiSelect: false, freeText: true, at: ago(5 * MIN) },
  { index: 1, itemId: "toolu_card:1", header: "Bob's day", question: "What should Bob's end-of-day message cover?", options: ["Did + doing next (Recommended)", "Only what he did", "Only what's next"], multiSelect: false, freeText: true, at: ago(5 * MIN) }
];
const carding = (overrides = {}, items = cardItems()) => makeThread({
  key: "conductor:s1", kind: "conductor", id: "s1", workspace: "montevideo", agentStatus: "running", lastActivityAt: ago(MIN),
  meta: { pendingCard: { app: "conductor", cardId: "toolu_card", at: ago(5 * MIN), count: 2, items } }, ...overrides
});
const cardQuestions = (supervisor) => supervisor.getState().questions.filter((q) => q.kind === "agent-card");

test("a card on a running thread raises one question; 'open thread' relays nothing and picks are refused", async (t) => {
  const threads = [carding()];
  const { supervisor, delivered } = fixture(t, { threads, mode: "auto", delivery: { mode: "computer-use-first" } });
  await supervisor.tick();
  const [first] = cardQuestions(supervisor);
  assert.equal(cardQuestions(supervisor).length, 1);
  assert.equal(first.dedupeKey, "card:conductor:s1:toolu_card:0");
  assert.deepEqual(first.options, ["open thread"]);
  assert.deepEqual(first.meta.labels, ["Chat-analysis worker (Recommended)", "Sales worker + inbox module", "Work-queue only"]);
  assert.match(first.body, /Also open: Bob's day$/);
  // A label is not an answer the supervisor can give yet.
  assert.equal(await supervisor.answerQuestion(first.id, "Chat-analysis worker (Recommended)"), null);
  const opened = await supervisor.answerQuestion(first.id, "open thread");
  assert.equal(opened.question.status, "open");
  assert.equal(opened.delivery.status, "blocked");
  assert.equal(delivered.length, 0);
  // Still running next tick: the card stays asked.
  await supervisor.tick();
  assert.equal(cardQuestions(supervisor).length, 1);
  // Item 0 answered in the app, item 1 still open: a new question.
  threads[0] = carding({}, cardItems().slice(1));
  await supervisor.tick();
  assert.deepEqual(cardQuestions(supervisor).map((q) => q.dedupeKey), ["card:conductor:s1:toolu_card:1"]);
  // Answered in the app: the card is gone and its questions close.
  threads[0] = carding({ meta: { pendingCard: null } });
  await supervisor.tick();
  assert.equal(cardQuestions(supervisor).length, 0);
  assert.equal(delivered.length, 0);
});

test("an automation thread's card is asked without reading its git or PR; the supervisor's own never", async (t) => {
  const gitReads = [];
  const auto = carding({ key: "codex:auto", kind: "codex", id: "auto", cwd: "/work/auto", excluded: "automation", prRefs: [] });
  const self = carding({ key: "codex:self", kind: "codex", id: "self", cwd: "/work/self", excluded: "self", prRefs: [] });
  const { supervisor } = fixture(t, { threads: [auto, self], deps: { readLocalGit: async (cwd) => { gitReads.push(cwd); return null; } } });
  await supervisor.tick();
  const keys = cardQuestions(supervisor).map((q) => q.threadKey);
  assert.deepEqual(keys, ["codex:auto"]);
  assert.deepEqual(gitReads, []);
  // The card closes: so do its questions.
  auto.meta = { pendingCard: null };
  await supervisor.tick();
  assert.equal(cardQuestions(supervisor).length, 0);
});

test("a card past a capped Codex scan closes once that card scan no longer finds it", async (t) => {
  // maxThreads 1: one in-scope thread fills the cap, so Codex reads capped.
  const busy = makeThread({ key: "codex:busy", id: "busy", agentStatus: "running", lastActivityAt: ago(MIN) });
  const auto = carding({ key: "codex:auto", kind: "codex", id: "auto", cwd: "/work/auto", excluded: "automation", prRefs: [] });
  let listed = [busy, auto];
  let scanned = ["codex:busy", "codex:auto"];
  const listCodexThreads = async (config, options) => {
    for (const key of scanned) options.cardScanned?.add(key);
    return listed;
  };
  const { supervisor } = fixture(t, { threads: [], limits: { maxThreads: 1 }, deps: { listCodexThreads } });
  await supervisor.tick();
  assert.deepEqual(cardQuestions(supervisor).map((q) => q.threadKey), ["codex:auto"]);
  // Answered: the source no longer keeps the thread, and the card scan did
  // not read it this time. Capped, so its absence proves nothing yet.
  listed = [busy];
  scanned = ["codex:busy"];
  await supervisor.tick();
  assert.equal(cardQuestions(supervisor).length, 1);
  // The complete card scan read it and found no card open: the question closes.
  scanned = ["codex:busy", "codex:auto"];
  await supervisor.tick();
  assert.equal(cardQuestions(supervisor).length, 0);
});

test("an in-scope thread past the supervisor's cap still has its card asked", async (t) => {
  // maxThreads 1: a newer thread fills the cap; the older one is kept only for its card.
  const busy = makeThread({ key: "codex:busy", id: "busy", agentStatus: "running", lastActivityAt: ago(MIN) });
  const older = carding({ key: "codex:older", kind: "codex", id: "older", cwd: "/work/older", lastActivityAt: ago(60 * MIN) });
  const quiet = makeThread({ key: "codex:quiet", id: "quiet", cwd: "/work/quiet", agentStatus: "idle", lastActivityAt: ago(90 * MIN) });
  const { supervisor } = fixture(t, { threads: [busy, older, quiet], limits: { maxThreads: 1 } });
  await supervisor.tick();
  assert.deepEqual(cardQuestions(supervisor).map((q) => q.threadKey), ["codex:older"]);
  // A thread past the cap with no card is still left out.
  assert.equal(supervisor.getState().snapshot.counts.inScope, 2);
});

test("the review never sees or closes a card question", async (t) => {
  const model = fakeModel((entries) => entries.map((e) => ({ id: e.id, decision: "close", category: "stale", reason: "looks done" })));
  const { supervisor } = fixture(t, { threads: [carding()], prs: new Map(), review: REVIEW_ON, deps: { runModel: model.runModel } });
  await supervisor.tick();
  assert.equal(model.calls.length, 0);
  assert.equal(cardQuestions(supervisor).length, 1);
});

test("a no-repo thread's card is asked; a Codex card is asked beside the thread's resume", async (t) => {
  const codexCard = (callId, msAgo) => ({ app: "codex", cardId: "turn-a", count: 1, items: [{ index: 0, itemId: `${callId}:0`, header: null, question: "Please sign in to the App Store tab.", options: [], multiSelect: false, freeText: true, at: ago(msAgo) }] });
  const loose = makeThread({ key: "codex:loose", id: "loose", cwd: null, repo: null, branch: null, prRefs: [], excluded: "no-repo", agentStatus: "idle", meta: { pendingCard: codexCard("call_loose", 10 * MIN) } });
  // 01a0cae7: a session limit that reset, with a card from before it.
  const capped = makeThread({ key: "codex:capped", id: "capped", agentStatus: "error", error: { kind: "session-limit", text: "limit", resetAt: ago(10 * MIN) },
    lastAgentAt: ago(3 * 60 * MIN), lastActivityAt: ago(3 * 60 * MIN), meta: { pendingCard: codexCard("call_capped", 3 * 60 * MIN) } });
  const { supervisor, delivered } = fixture(t, { threads: [loose, capped], mode: "auto" });
  await supervisor.tick();
  assert.deepEqual(cardQuestions(supervisor).map((q) => q.threadKey).sort(), ["codex:capped", "codex:loose"]);
  assert.deepEqual(delivered.map((item) => [item.thread?.key ?? item.threadKey, item.playbook]), [["codex:capped", "resume"]]);
});

test("a sent nudge keeps its hash, facts and start time, and an answered one is not resent", async (t) => {
  let clock = NOW;
  const thread = makeThread();
  const { supervisor, delivered } = fixture(t, { mode: "auto", threads: [thread], now: () => clock });
  await supervisor.tick({ reason: "test" });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].playbook, "merge-ready");
  const entry = supervisor.store.ledgerFor("codex:t1").nudges[0];
  assert.equal(entry.status, "sent");
  assert.equal(entry.sentAt, new Date(NOW).toISOString());
  assert.match(entry.messageHash, /^[0-9a-f]{16}$/);
  assert.match(entry.factsKey, /^[0-9a-f]{16}$/);
  assert.deepEqual(entry.facts, ["2 open threads", `head ${HEAD.slice(0, 10)}`, "verification failing"]);
  // The agent answered at +5 min; at +40 nothing has changed.
  thread.lastAgentAt = new Date(NOW + 5 * MIN).toISOString();
  thread.lastActivityAt = thread.lastAgentAt;
  clock = NOW + 40 * MIN;
  await supervisor.tick({ reason: "test" });
  assert.equal(delivered.length, 1);
  const decision = supervisor.getState().snapshot.threads.find((item) => item.key === "codex:t1").decision;
  assert.match(decision.reason, /^agent answered the \d\d:\d\d nudge; nothing new$/);
});

// ---------- the nudge judge ----------

function fakeJudge(verdictFor, { enabled = true } = {}) {
  const calls = [];
  return {
    calls,
    enabled,
    judge: async (input) => {
      calls.push(input);
      const verdict = typeof verdictFor === "function" ? verdictFor(input) : verdictFor;
      if (verdict instanceof Error) throw verdict;
      return verdict;
    }
  };
}

const judgeRow = (supervisor, key = "codex:t1") => supervisor.getState().snapshot.threads.find((row) => row.key === key).decision;

test("judge send: its message goes out under the playbook, and the verdict is journaled", async (t) => {
  const judge = fakeJudge({ action: "send", reason: "CI red after the reply", message: "verification failed on head bbbbbbbbbb. Fix it and push." });
  const { supervisor, delivered } = fixture(t, { mode: "auto", deps: { judge } });
  await supervisor.tick({ reason: "test" });
  assert.equal(judge.calls.length, 1);
  assert.equal(judge.calls[0].decision.playbook, "merge-ready");
  assert.match(judge.calls[0].decision.message, /Ready to merge\?/);
  assert.equal(judge.calls[0].pr.ref, "acme/app#7");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].message, "verification failed on head bbbbbbbbbb. Fix it and push.");
  assert.equal(delivered[0].playbook, "merge-ready");
  const entry = supervisor.store.ledgerFor("codex:t1").nudges[0];
  assert.equal(entry.playbook, "merge-ready");
  assert.equal(entry.status, "sent");
  const journal = supervisor.getState().actions.find((action) => action.kind === "judge");
  assert.equal(journal.threadKey, "codex:t1");
  assert.equal(journal.playbook, "merge-ready");
  assert.equal(journal.verdict, "send");
  assert.equal(journal.reason, "CI red after the reply");
});

test("judge wait: nothing sent, no attempt spent, no cooldown", async (t) => {
  const judge = fakeJudge({ action: "wait", reason: "agent said BuildBot3 run is queued" });
  const { supervisor, delivered } = fixture(t, { mode: "auto", deps: { judge } });
  await supervisor.tick({ reason: "test" });
  assert.equal(delivered.length, 0);
  const decision = judgeRow(supervisor);
  assert.equal(decision.action, "wait");
  assert.equal(decision.reason, "judge: agent said BuildBot3 run is queued");
  const ledger = supervisor.store.ledgerFor("codex:t1");
  assert.equal(ledger.nudges?.length ?? 0, 0);
  assert.equal(ledger.lastNudgeAt ?? null, null);
  assert.equal(supervisor.getState().actions.find((action) => action.kind === "judge").verdict, "wait");
});

test("judge ask-owner: an agent-ask question whose answer is relayed to the agent", async (t) => {
  const judge = fakeJudge({ action: "ask-owner", reason: "needs your merge call", question: { title: "Merge with --admin?", body: "Agent asks: --admin or wait for Nikhil.", options: ["merge --admin", "wait for Nikhil"] } });
  const { supervisor, delivered } = fixture(t, { mode: "auto", deps: { judge } });
  await supervisor.tick({ reason: "test" });
  assert.equal(delivered.length, 0);
  const question = supervisor.getState().questions.find((q) => q.kind === "agent-ask");
  assert.ok(question, "question raised");
  assert.equal(question.dedupeKey, judgeAskKey(makeThread(), { body: "Agent asks: --admin or wait for Nikhil.", options: ["merge --admin", "wait for Nikhil"] }));
  assert.match(question.dedupeKey, /^ask:codex:t1:[0-9a-f]{16}:[0-9a-f]{16}$/);
  assert.equal(question.askedBy, "judge");
  assert.equal(question.mergeAsk, true);
  assert.match(question.title, /Merge with --admin\?$/);
  assert.equal(question.body, "Agent asks: --admin or wait for Nikhil.");
  assert.deepEqual(question.options, ["merge --admin", "wait for Nikhil"]);

  assert.equal(question.threadKey, "codex:t1");
  const result = await supervisor.answerQuestion(question.id, "wait for Nikhil");
  assert.equal(result.delivery.status, "sent");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].message, "Owner answer: wait for Nikhil. Continue with that.");
  assert.equal(delivered[0].playbook, "owner-answer");
  // The owner's answer was never judged.
  assert.equal(judge.calls.length, 1);
});

test("judge ask-owner: a merge ask only in the body still holds as a merge ask", async (t) => {
  const judge = fakeJudge({ action: "ask-owner", reason: "needs your call", question: { title: "Approval needed", body: "May I merge the PR?", options: ["yes", "no"] } });
  const { supervisor } = fixture(t, { mode: "auto", deps: { judge } });
  await supervisor.tick({ reason: "test" });
  const question = supervisor.getState().questions.find((q) => q.kind === "agent-ask");
  assert.equal(question.mergeAsk, true);
});

test("judge failure waits, never a blind send", async (t) => {
  const judge = fakeJudge(new Error("codex-lb 502"));
  const { supervisor, delivered } = fixture(t, { mode: "auto", deps: { judge } });
  await supervisor.tick({ reason: "test" });
  assert.equal(delivered.length, 0);
  assert.equal(judgeRow(supervisor).action, "wait");
  assert.equal(judgeRow(supervisor).reason, "judge unavailable: codex-lb 502");
  const journal = supervisor.getState().actions.find((action) => action.kind === "judge");
  assert.equal(journal.verdict, "failed");
  assert.equal(journal.status, "failed");
});

test("a limit-reset resume and owner answers are never judged", async (t) => {
  const judge = fakeJudge({ action: "wait", reason: "x" });
  const capped = makeThread({ key: "codex:capped", id: "capped", prRefs: [], agentStatus: "error", error: { kind: "session-limit", text: "limit", resetAt: ago(10 * MIN) },
    lastAgentAt: ago(3 * 60 * MIN), lastActivityAt: ago(3 * 60 * MIN) });
  const { supervisor, delivered } = fixture(t, { threads: [capped], mode: "auto", prs: new Map(), deps: { judge } });
  await supervisor.tick({ reason: "test" });
  assert.deepEqual(delivered.map((item) => item.playbook), ["resume"]);
  assert.equal(judge.calls.length, 0);
});

test("judge off or not in Auto: the playbook message goes out unchanged", async (t) => {
  const off = fakeJudge({ action: "wait", reason: "x" }, { enabled: false });
  const { supervisor, delivered } = fixture(t, { mode: "auto", deps: { judge: off } });
  await supervisor.tick({ reason: "test" });
  assert.equal(off.calls.length, 0);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].message, /Ready to merge\?/);
  const on = fakeJudge({ action: "wait", reason: "x" });
  const observe = fixture(t, { mode: "observe", deps: { judge: on } });
  await observe.supervisor.tick({ reason: "test" });
  assert.equal(on.calls.length, 0);
  assert.equal(observe.supervisor.getState().actions.find((a) => a.status === "planned").playbook, "merge-ready");
});

test("an unchanged chat is not judged again; the agent speaking is", async (t) => {
  let clock = NOW;
  const thread = makeThread({ lastAgentFull: "Waiting on the full run.", lastAgentFullAt: ago(60 * MIN) });
  const judge = fakeJudge({ action: "wait", reason: "full run queued" });
  const { supervisor, delivered } = fixture(t, { mode: "auto", threads: [thread], now: () => clock, deps: { judge } });
  await supervisor.tick({ reason: "test" });
  clock += 20 * MIN;
  await supervisor.tick({ reason: "test" });
  assert.equal(judge.calls.length, 1);
  assert.equal(judgeRow(supervisor).reason, "judge: full run queued");
  // The agent spoke: read again.
  thread.lastAgentFull = "Full run failed on lint. Fixing.";
  thread.lastAgentFullAt = new Date(clock - 30 * MIN).toISOString();
  thread.lastAgentAt = thread.lastAgentFullAt;
  thread.lastActivityAt = thread.lastAgentFullAt;
  clock += 20 * MIN;
  await supervisor.tick({ reason: "test" });
  assert.equal(judge.calls.length, 2);
  assert.match(judge.calls[1].thread.lastAgentFull, /failed on lint/);
  assert.equal(delivered.length, 0);
});

test("a judged send is not read or resent while its PR, head and blockers stand unanswered", async (t) => {
  let clock = NOW;
  const judge = fakeJudge({ action: "send", reason: "CI red", message: "verification is red on head bbbbbbbbbb. Fix it." });
  const { supervisor, delivered } = fixture(t, { mode: "auto", now: () => clock, deps: { judge } });
  await supervisor.tick({ reason: "test" });
  assert.equal(delivered.length, 1);
  // Past the cooldown, no reply, the same PR, head and blockers: the same
  // nudge whatever words the judge would pick, so the chat is not read again.
  clock += 30 * MIN;
  await supervisor.tick({ reason: "test" });
  assert.equal(judge.calls.length, 1);
  assert.equal(delivered.length, 1);
  assert.match(judgeRow(supervisor).reason, /^same PR, head and blockers as the \d\d:\d\d nudge; no reply since$/);
  clock += 30 * MIN;
  await supervisor.tick({ reason: "test" });
  assert.equal(judge.calls.length, 1);
  assert.equal(delivered.length, 1);
});

test("an infra recovery's resume is read by the judge like any thread nudge", async (t) => {
  // infra-recovered went out unread: it was decided after the judge ran.
  const stalled = makeThread({ agentStatus: "aborted", error: null, prRefs: [] });
  const judge = fakeJudge((input) => (input.decision.playbook === "infra-recovered" ? { action: "wait", reason: "the agent already retried" } : { action: "send", reason: "x", message: "y" }));
  const { supervisor, delivered } = fixture(t, { mode: "auto", threads: [stalled], prs: new Map(), deps: { judge } });
  supervisor.store.setInfraDown("lb", true);
  supervisor.store.setInfraBlocked("lb", ["codex:t1"]);
  await supervisor.tick({ reason: "test" });
  assert.equal(delivered.length, 0);
  assert.equal(judge.calls.length, 1);
  assert.equal(judge.calls[0].decision.playbook, "infra-recovered");
  assert.equal(judgeRow(supervisor).reason, "judge: the agent already retried");
  // A send verdict goes out in the judge's words.
  const sending = fakeJudge({ action: "send", reason: "LB back", message: "The LB is back; retry the failed push." });
  const again = fixture(t, { mode: "auto", threads: [stalled], prs: new Map(), deps: { judge: sending } });
  again.supervisor.store.setInfraDown("lb", true);
  again.supervisor.store.setInfraBlocked("lb", ["codex:t1"]);
  await again.supervisor.tick({ reason: "test" });
  assert.deepEqual(again.delivered.map((item) => [item.playbook, item.message]), [["infra-recovered", "The LB is back; retry the failed push."]]);
});

test("the laptop-verify guard is read by the judge before it goes out", async (t) => {
  // monterrey had just said "Nothing is verifying on the laptop" when the
  // same "Stop. Don't verify locally" went in again.
  const said = "Nothing is verifying on the laptop. The only process running is an ssh session executing a check on BuildBot3 slot 1.";
  const thread = makeThread({ lastAgentText: said, lastAgentFull: said, lastAgentFullAt: ago(60 * MIN) });
  const proc = { pid: 4242, command: "pnpm run build", cwd: "/work/t1", ageSec: 600 };
  const judge = fakeJudge({ action: "wait", reason: "the agent says nothing runs locally" });
  const { supervisor, delivered } = fixture(t, { mode: "auto", threads: [thread], deps: { judge, findLocalHeavyVerification: async () => [proc] } });
  await supervisor.tick({ reason: "test" });
  assert.equal(judge.calls.length, 1);
  assert.equal(judge.calls[0].decision.playbook, "no-local-verify");
  assert.equal(delivered.length, 0);
});

test("at most 6 judge calls per scan; the rest wait for the next", async (t) => {
  const threads = Array.from({ length: 8 }, (_, n) => makeThread({ key: `codex:t${n}`, id: `t${n}`, cwd: `/work/t${n}` }));
  let clock = NOW;
  let running = 0;
  let peak = 0;
  const judge = {
    enabled: true, calls: [],
    judge: async (input) => {
      judge.calls.push(input);
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return { action: "wait", reason: "queued" };
    }
  };
  const { supervisor, delivered } = fixture(t, { mode: "auto", threads, now: () => clock, limits: { maxThreads: 20 }, deps: { judge } });
  await supervisor.tick({ reason: "test" });
  assert.equal(judge.calls.length, 6);
  assert.ok(peak <= 3, `at most 3 at once, saw ${peak}`);
  const rows = supervisor.getState().snapshot.threads;
  assert.equal(rows.filter((row) => /per-scan cap/.test(row.decision?.reason ?? "")).length, 2);
  clock += 5 * MIN;
  await supervisor.tick({ reason: "test" });
  assert.equal(judge.calls.length, 8);
  assert.equal(delivered.length, 0);
});

test("threads the judge keeps failing on do not hold the per-scan cap", async (t) => {
  const threads = Array.from({ length: 8 }, (_, n) => makeThread({ key: `codex:t${n}`, id: `t${n}`, cwd: `/work/t${n}` }));
  let clock = NOW;
  const judge = { enabled: true, calls: [], judge: async (input) => { judge.calls.push(input.thread.key); throw new Error("bad input"); } };
  const { supervisor } = fixture(t, { mode: "auto", threads, now: () => clock, limits: { maxThreads: 20 }, deps: { judge } });
  await supervisor.tick({ reason: "test" });
  assert.equal(judge.calls.length, 6);
  const first = new Set(judge.calls);
  // Past the failure pause: the two never read go first.
  clock += 6 * MIN;
  await supervisor.tick({ reason: "test" });
  const second = judge.calls.slice(6);
  assert.equal(second.length, 6);
  for (const key of ["codex:t0", "codex:t1", "codex:t2", "codex:t3", "codex:t4", "codex:t5", "codex:t6", "codex:t7"].filter((key) => !first.has(key))) {
    assert.ok(second.includes(key), `${key} read on the second scan`);
  }
});

test("a judge question stays open while the judge cannot read the chat, and closes on its wait", async (t) => {
  let clock = NOW;
  const thread = makeThread();
  let verdict = { action: "ask-owner", reason: "needs a call", question: { title: "Which plan?", body: "b", options: ["Starter", "Business"] } };
  const judge = fakeJudge(() => verdict);
  const { supervisor } = fixture(t, { mode: "auto", threads: [thread], now: () => clock, deps: { judge } });
  await supervisor.tick({ reason: "test" });
  const open = () => supervisor.getState().questions.filter((q) => q.askedBy === "judge" && q.status === "open");
  assert.equal(open().length, 1);
  // The agent spoke, and the judge is down: the question holds.
  thread.lastAgentFull = "Still need your call.";
  thread.lastAgentFullAt = new Date(clock).toISOString();
  verdict = new Error("timed out after 90s");
  clock += 20 * MIN;
  await supervisor.tick({ reason: "test" });
  assert.equal(judgeRow(supervisor).reason, "judge unavailable: timed out after 90s");
  assert.equal(open().length, 1);
  // Back up past the pause, and it says wait: the question closes.
  verdict = { action: "wait", reason: "owner answered in chat" };
  clock += 10 * MIN;
  await supervisor.tick({ reason: "test" });
  assert.equal(open().length, 0);
});

test("judge calls in one scan stop at a time cap; the rest wait for the next scan", async (t) => {
  const threads = Array.from({ length: 6 }, (_, n) => makeThread({ key: `codex:c${n}`, id: `c${n}`, cwd: `/work/c${n}` }));
  let clock = NOW;
  const judge = {
    enabled: true, calls: [],
    // Each call takes 40 s of scan time.
    judge: async (input) => { judge.calls.push(input); clock += 40_000; return { action: "wait", reason: "queued" }; }
  };
  const { supervisor } = fixture(t, { mode: "auto", threads, now: () => clock, limits: { maxThreads: 20 }, deps: { judge } });
  await supervisor.tick({ reason: "test" });
  assert.ok(judge.calls.length < 6, `stopped early, made ${judge.calls.length}`);
  const rows = supervisor.getState().snapshot.threads;
  assert.ok(rows.some((row) => /time cap/.test(row.decision?.reason ?? "")));
});

test("a judge answer kept while the Mac cannot type is delivered, and no playbook nudge goes to its thread", async (t) => {
  let now = NOW;
  let blockAnswers = true;
  const delivered = [];
  const executor = {
    deliver: async (args) => {
      if (args.playbook === "owner-answer" && blockAnswers) return { status: "blocked", route: args.route, detail: "front app unknown", actionId: null };
      delivered.push(args);
      return { status: "sent", route: args.route, detail: "ok", actionId: args.actionId ?? null };
    },
    inFlight: () => [], whenIdle: async () => {}
  };
  const judge = fakeJudge({ action: "ask-owner", reason: "needs your merge call", question: { title: "Merge with --admin?", body: "b", options: ["merge --admin", "wait"] } });
  const thread = makeThread({ meta: { originator: "Codex Desktop" } });
  const { supervisor } = fixture(t, { mode: "auto", delivery: "computer-use", threads: [thread], now: () => now, deps: { judge, executor, uiDriver: { readiness: async () => ({ ready: true, detail: null }) } } });
  await supervisor.tick({ reason: "test" });
  const q = supervisor.getState().questions.find((x) => x.kind === "agent-ask");
  assert.equal((await supervisor.answerQuestion(q.id, "wait")).delivery.status, "queued");
  // Next scan: the judge leaves the thread alone and nothing else goes to it.
  now += 5 * MIN;
  await supervisor.tick({ reason: "test" });
  assert.equal(judge.calls.length, 1);
  assert.equal(delivered.filter((d) => d.playbook === "merge-ready").length, 0, "no playbook nudge over a queued answer");
  assert.equal(judgeRow(supervisor).action, "wait");
  // The Mac can type again: the kept answer goes, not dropped as stale.
  blockAnswers = false;
  now += 5 * MIN;
  await supervisor.tick({ reason: "test" });
  const answers = delivered.filter((d) => d.playbook === "owner-answer");
  assert.equal(answers.length, 1);
  assert.equal(answers[0].message, "Owner answer: wait. Continue with that.");
  assert.equal(supervisor.store.question(q.id).deliveredAnswer, "sent");
  assert.equal(delivered.filter((d) => d.playbook === "merge-ready").length, 0);
});

test("a verdict read before the owner answered is dropped, not sent", async (t) => {
  let clock = NOW;
  const thread = makeThread();
  let supervisor;
  let answerDuringCall = false;
  const judge = fakeJudge(() => ({ action: "ask-owner", reason: "needs a call", question: { title: "Merge now?", body: "b", options: ["merge", "wait"] } }));
  const inner = judge.judge;
  judge.judge = async (input) => {
    const verdict = await inner(input);
    if (answerDuringCall) {
      const q = supervisor.getState().questions.find((x) => x.kind === "agent-ask" && x.status === "open");
      await supervisor.answerQuestion(q.id, "merge");
      return { action: "send", reason: "CI red", message: "verification is red. Fix it." };
    }
    return verdict;
  };
  ({ supervisor } = fixture(t, { mode: "auto", threads: [thread], now: () => clock, deps: { judge } }));
  const sent = () => supervisor.store.actions(50).filter((a) => a.kind === "nudge" && a.status === "sent");
  await supervisor.tick({ reason: "test" });
  // The agent spoke, so the judge reads again; the owner answers mid-call.
  thread.lastAgentFull = "Still need your call.";
  thread.lastAgentFullAt = new Date(clock).toISOString();
  answerDuringCall = true;
  clock += 20 * MIN;
  await supervisor.tick({ reason: "test" });
  assert.equal(judge.calls.length, 2);
  assert.equal(sent().filter((a) => a.playbook === "merge-ready").length, 0, "the stale send never went out");
  assert.equal(judgeRow(supervisor).reason, "owner answered meanwhile; no nudge");
});

test("a verdict read before the owner messaged the thread from OpenAGI is dropped, not sent", async (t) => {
  let clock = NOW;
  const thread = makeThread();
  let supervisor;
  let messageDuringCall = false;
  const judge = fakeJudge(() => ({ action: "wait", reason: "fine", message: null, question: null }));
  judge.judge = async () => {
    judge.calls.push(1);
    if (!messageDuringCall) return { action: "wait", reason: "agent is on it", message: null, question: null };
    await supervisor.sendOwnerMessage(thread.key, "Hold the merge, I am testing.");
    return { action: "send", reason: "CI red", message: "verification is red. Fix it." };
  };
  judge.calls = [];
  ({ supervisor } = fixture(t, { mode: "auto", threads: [thread], now: () => clock, deps: { judge } }));
  // A first scan knows the thread, as the live supervisor always does.
  await supervisor.tick({ reason: "test" });
  thread.lastAgentFull = "Still on it.";
  thread.lastAgentFullAt = new Date(clock).toISOString();
  messageDuringCall = true;
  clock += 20 * MIN;
  await supervisor.tick({ reason: "test" });
  assert.equal(judge.calls.length, 2);
  const nudges = supervisor.store.actions(50).filter((a) => a.kind === "nudge" && a.status === "sent" && a.playbook !== "owner-message");
  assert.equal(nudges.length, 0, "the stale judged nudge never followed the owner's own message");
  assert.equal(judgeRow(supervisor).reason, "owner answered meanwhile; no nudge");
});

test("each judge call gets only the scan's time left; one the cap cuts off is no failure", async (t) => {
  const threads = Array.from({ length: 4 }, (_, n) => makeThread({ key: `codex:b${n}`, id: `b${n}`, cwd: `/work/b${n}` }));
  let clock = NOW;
  const judge = {
    enabled: true, calls: [],
    // Each call starts 25 s after the one before; a capped one times out.
    judge: async (input) => {
      judge.calls.push(input);
      clock += 25_000;
      if (input.timeoutMs < 40_000) throw new Error(`timed out after ${Math.round(input.timeoutMs / 1000)}s`);
      return { action: "wait", reason: "queued" };
    }
  };
  const { supervisor } = fixture(t, { mode: "auto", threads, now: () => clock, limits: { maxThreads: 20 }, deps: { judge } });
  await supervisor.tick({ reason: "test" });
  assert.deepEqual(judge.calls.map((call) => call.timeoutMs), [45_000, 35_000, 10_000], "no call starts with under 10 s left");
  const rows = supervisor.getState().snapshot.threads;
  assert.equal(rows.filter((row) => /time cap/.test(row.decision?.reason ?? "")).length, 3);
  assert.equal(supervisor.getState().actions.filter((a) => a.kind === "judge" && a.verdict === "failed").length, 0);
  assert.equal(supervisor.judgeDownUntil, 0, "cut-off calls never pause the judge");
});

test("a new judge question under an answered title is asked, not hidden", async (t) => {
  let clock = NOW;
  const thread = makeThread();
  let verdict = { action: "ask-owner", reason: "needs a call", question: { title: "Merge now?", body: "CI is green.", options: ["merge", "wait"] } };
  const judge = fakeJudge(() => verdict);
  const { supervisor } = fixture(t, { mode: "auto", threads: [thread], now: () => clock, deps: { judge } });
  await supervisor.tick({ reason: "test" });
  const first = supervisor.getState().questions.find((q) => q.kind === "agent-ask");
  await supervisor.answerQuestion(first.id, "wait");
  thread.lastAgentFull = "Admin merge is the only way; or close it.";
  thread.lastAgentFullAt = new Date(clock).toISOString();
  verdict = { action: "ask-owner", reason: "new choice", question: { title: "Merge now?", body: "Branch protection blocks it.", options: ["merge --admin", "close"] } };
  clock += 20 * MIN;
  await supervisor.tick({ reason: "test" });
  const open = supervisor.getState().questions.filter((q) => q.kind === "agent-ask" && q.status === "open");
  assert.equal(open.length, 1);
  assert.notEqual(open[0].dedupeKey, first.dedupeKey);
  assert.deepEqual(open[0].options, ["merge --admin", "close"]);
});

test("a cached verdict is read again when the PR facts it saw change", () => {
  const thread = makeThread({ lastAgentFull: "Waiting on CI." });
  const decision = { playbook: "status-check", factsKey: null };
  const pending = makePr({ ci: { state: "PENDING", failing: [], pending: ["verification"] } });
  const key = judgeCacheKey(thread, decision, pending, { state: "pr-not-ready" });
  assert.equal(judgeCacheKey(thread, decision, makePr({ ci: { state: "PENDING", failing: [], pending: ["verification"] } }), { state: "pr-not-ready" }), key);
  assert.notEqual(judgeCacheKey(thread, decision, makePr({ ci: { state: "FAILURE", failing: ["verification"], pending: [] } }), { state: "pr-not-ready" }), key);
  assert.notEqual(judgeCacheKey(thread, decision, makePr({ ci: pending.ci, headOid: "c".repeat(40) }), { state: "pr-not-ready" }), key);
  assert.notEqual(judgeCacheKey(thread, decision, makePr({ ci: pending.ci, unresolvedThreads: 0 }), { state: "pr-not-ready" }), key);
  assert.notEqual(judgeCacheKey(thread, decision, pending, { state: "pr-ready" }), key);
});

test("an owner answer during the review holds a judged nudge already decided", async (t) => {
  let clock = NOW;
  const thread = makeThread();
  let verdict = { action: "ask-owner", reason: "needs a call", question: { title: "Merge now?", body: "b", options: ["merge", "wait"] } };
  const judge = fakeJudge(() => verdict);
  const { supervisor, delivered } = fixture(t, { mode: "auto", threads: [thread], now: () => clock, deps: { judge } });
  await supervisor.tick({ reason: "test" });
  const question = supervisor.getState().questions.find((q) => q.kind === "agent-ask" && q.status === "open");
  // The agent spoke, the judge says send; the owner answers while the
  // review runs, after the judge's own after-call check.
  thread.lastAgentFull = "Still need your call.";
  thread.lastAgentFullAt = new Date(clock).toISOString();
  verdict = { action: "send", reason: "CI red", message: "verification is red. Fix it." };
  const review = supervisor.reviewOpenQuestions.bind(supervisor);
  supervisor.reviewOpenQuestions = async (args) => {
    await supervisor.answerQuestion(question.id, "merge");
    return review(args);
  };
  clock += 20 * MIN;
  await supervisor.tick({ reason: "test" });
  assert.equal(judge.calls.length, 2);
  assert.deepEqual(delivered.map((d) => d.playbook), ["owner-answer"], "the stale judged nudge never went out");
  assert.match(judgeRow(supervisor).reason, /held: owner answered$/);
});

test("a switch to Auto mid-scan sends no nudge the judge never read", async (t) => {
  const judge = fakeJudge({ action: "send", reason: "r", message: "judged words" });
  const { supervisor, delivered } = fixture(t, { mode: "propose", deps: { judge } });
  const review = supervisor.reviewOpenQuestions.bind(supervisor);
  supervisor.reviewOpenQuestions = async (args) => {
    supervisor.setMode("auto");
    return review(args);
  };
  await supervisor.tick({ reason: "test" });
  assert.equal(judge.calls.length, 0);
  assert.equal(delivered.length, 0, "the unread playbook nudge stayed");
  assert.match(judgeRow(supervisor).reason, /held: not judged this scan$/);
  // The next scan, in Auto, reads it first and sends the judge's words.
  supervisor.reviewOpenQuestions = review;
  await supervisor.tick({ reason: "test" });
  assert.equal(judge.calls.length, 1);
  assert.deepEqual(delivered.map((d) => d.message), ["judged words"]);
});

test("the judge pause starts when the failures finish, on the current clock", async (t) => {
  let clock = NOW;
  const judge = { enabled: true, calls: [], judge: async (input) => { judge.calls.push(input); clock += 4 * MIN; throw new Error("codex-lb 502"); } };
  const { supervisor } = fixture(t, { mode: "auto", now: () => clock, deps: { judge } });
  await supervisor.tick({ reason: "test" });
  assert.equal(supervisor.judgeDownUntil, clock + 5 * MIN);
  // Seven minutes after the scan began, still within the pause: no call.
  clock += 3 * MIN;
  await supervisor.tick({ reason: "test" });
  assert.equal(judge.calls.length, 1);
  assert.match(judgeRow(supervisor).reason, /^judge unavailable: codex-lb 502/);
});

test("the verdict cache key holds every fact the prompt shows, but not the clock", () => {
  const thread = makeThread({ lastAgentFull: "Waiting.", lastAgentFullAt: ago(10 * MIN) });
  const pr = makePr();
  const classified = { state: "pr-not-ready", reason: "CI red", blockers: ["CI red: verification"] };
  const decision = { playbook: "merge-ready", factsKey: null, reason: "waiting 34m; not ready: CI red", message: "Ready to merge? Check CI." };
  const key = judgeCacheKey(thread, decision, pr, classified);
  assert.notEqual(judgeCacheKey(thread, decision, pr, { ...classified, reason: "local git dirty" }), key);
  assert.notEqual(judgeCacheKey(thread, decision, pr, { ...classified, blockers: ["2 open threads"] }), key);
  assert.notEqual(judgeCacheKey(thread, decision, pr, { state: "pr-not-ready", reason: "CI red", readiness: { blockers: ["QA missing"] } }), judgeCacheKey(thread, decision, pr, { state: "pr-not-ready", reason: "CI red" }));
  assert.notEqual(judgeCacheKey(thread, { ...decision, reason: "waiting 34m; not ready: QA" }, pr, classified), key);
  assert.notEqual(judgeCacheKey(thread, { ...decision, message: "A custom playbook line." }, pr, classified), key);
  // Only the elapsed time moved: same key.
  assert.equal(judgeCacheKey(thread, { ...decision, reason: "waiting 35m; not ready: CI red" }, pr, classified), key);
});

test("the judge cache key changes with the earlier nudges the prompt shows", () => {
  const thread = makeThread();
  const decision = { playbook: "merge-ready", reason: "r", message: "m" };
  const nudgeA = { playbook: "merge-ready", at: "2026-10-11T11:00:00.000Z", message: "A" };
  const nudgeB = { playbook: "infra-recovered", at: "2026-10-11T11:30:00.000Z", message: "B" };
  const key = judgeCacheKey(thread, decision, null, null, [nudgeA]);
  assert.equal(judgeCacheKey(thread, decision, null, null, [{ ...nudgeA }]), key);
  assert.notEqual(judgeCacheKey(thread, decision, null, null, [nudgeA, nudgeB]), key);
  assert.notEqual(judgeCacheKey(thread, decision, null, null, []), key);
  assert.notEqual(judgeCacheKey(thread, decision, null, null, [{ ...nudgeA, message: "A2" }]), key);
});

test("a changed judge question body is a new decision even on the same reply", async (t) => {
  const thread = makeThread({ lastAgentFull: "Merge with --admin or wait for Nikhil?", lastAgentFullAt: ago(10 * MIN) });
  const a = judgeAskKey(thread, { title: "Merge with --admin?", body: "The agent asks: admin or wait.", options: ["merge --admin", "wait"] });
  const b = judgeAskKey(thread, { title: "  merge WITH --admin? ", body: "Branch protection blocks a normal merge.", options: ["Wait", "merge --admin"] });
  assert.notEqual(a, b);
  assert.equal(a, judgeAskKey(thread, { title: " MERGE WITH --admin? ", body: "The agent asks: admin or wait.", options: ["wait", "merge --admin"] }), "case, spacing and option order alone are not a new decision");
  assert.notEqual(a, judgeAskKey(thread, { body: "The agent asks: admin or WAIT.", options: ["merge --admin", "wait"] }), "body case can change an identifier or path");
  assert.notEqual(a, judgeAskKey(thread, { body: "The agent asks: admin or wait.", options: ["merge --ADMIN", "wait"] }), "option case can change a command");
  assert.notEqual(judgeAskKey({ ...thread, lastAgentFull: "Now: close it?", lastAgentFullAt: ago(MIN) }, { title: "Merge with --admin?", options: ["merge --admin", "wait"] }), a, "a new reply may ask anew");
  // A changed body asks the owner to make a fresh decision.
  let clock = NOW;
  let verdict = { action: "ask-owner", reason: "needs a call", question: { title: "Merge with --admin?", body: "The agent asks: admin or wait.", options: ["merge --admin", "wait"] } };
  const prs = new Map([["acme/app#7", makePr()]]);
  const judge = fakeJudge(() => verdict);
  const { supervisor, notified } = fixture(t, { mode: "auto", threads: [thread], prs, now: () => clock, deps: { judge } });
  await supervisor.tick({ reason: "test" });
  const first = supervisor.getState().questions.find((q) => q.kind === "agent-ask");
  // While still open, changed details replace the card instead of piling up.
  prs.set("acme/app#7", makePr({ ci: { state: "FAILURE", failing: ["lint"], pending: [] } }));
  verdict = { action: "ask-owner", reason: "needs a call", question: { title: "Admin merge?", body: "Lint is failing; bypass protection?", options: ["merge --admin", "wait"] } };
  clock += 20 * MIN;
  await supervisor.tick({ reason: "test" });
  const updated = supervisor.getState().questions.filter((q) => q.kind === "agent-ask");
  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, first.id);
  assert.equal(updated[0].body, "Lint is failing; bypass protection?");
  await supervisor.answerQuestion(first.id, "wait");
  // CI moved, so the judge reads the same reply again and words it anew.
  prs.set("acme/app#7", makePr({ ci: { state: "PENDING", failing: [], pending: ["verification"] } }));
  verdict = { action: "ask-owner", reason: "still needs a call", question: { title: "Merge with --admin?", body: "Branch protection blocks it.", options: ["wait", "merge --admin"] } };
  const pings = notified.length;
  clock += 20 * MIN;
  await supervisor.tick({ reason: "test" });
  assert.equal(judge.calls.length, 3);
  assert.equal(supervisor.getState().questions.filter((q) => q.kind === "agent-ask" && q.status === "open").length, 1);
  assert.equal(notified.length, pings + 1, "a different decision needs a fresh answer");
});

test("the snapshot says what each thread is watched for, and keeps when it started across scans", async (t) => {
  let clock = NOW;
  const full = { id: "t1", description: "bb-verify --full --pr 7", kind: "local_bash", startedAt: ago(20 * MIN) };
  const thread = makeThread({ agentStatus: "waiting", openTasks: [full], meta: { turnStartedAt: ago(30 * MIN) } });
  const { supervisor } = fixture(t, { threads: [thread], now: () => clock });
  await supervisor.tick({ reason: "test" });
  let row = supervisor.getState().snapshot.threads[0];
  assert.equal(row.watch.group, "waiting");
  assert.equal(row.watch.waitingOn, "BuildBot3 full run");
  assert.equal(row.watch.since, ago(20 * MIN));
  assert.equal(supervisor.getState().snapshot.counts.byWatch.waiting, 1);
  // Still waiting five minutes later: the start holds.
  clock += 5 * MIN;
  await supervisor.tick({ reason: "test" });
  row = supervisor.getState().snapshot.threads[0];
  assert.equal(row.watch.since, ago(20 * MIN));
  // The run ends and the agent works again: a new group, a new start.
  Object.assign(thread, { agentStatus: "running", openTasks: [], lastActivityAt: new Date(clock).toISOString(), meta: { turnStartedAt: new Date(clock - 2 * MIN).toISOString() } });
  clock += 1 * MIN;
  await supervisor.tick({ reason: "test" });
  row = supervisor.getState().snapshot.threads[0];
  assert.equal(row.watch.group, "working");
  assert.equal(row.watch.since, new Date(clock - 3 * MIN).toISOString());
  // Past the full-run limit the owner is asked: waiting on you, since then.
  Object.assign(thread, { agentStatus: "waiting", openTasks: [{ ...full, startedAt: new Date(clock - 40 * MIN).toISOString() }] });
  clock += 1 * MIN;
  await supervisor.tick({ reason: "test" });
  row = supervisor.getState().snapshot.threads[0];
  assert.equal(row.watch.group, "you");
  const askedAt = new Date(clock).toISOString();
  assert.equal(row.watch.since, askedAt);
  // A daemon restart forgets the tracked starts, and each scan re-stamps the
  // question's lastAskedAt: the wait still dates from when it was asked.
  clock += 4 * MIN;
  supervisor.watchSince.clear();
  await supervisor.tick({ reason: "test" });
  row = supervisor.getState().snapshot.threads[0];
  assert.equal(row.watch.group, "you");
  assert.equal(row.watch.since, askedAt);
});

test("a new turn in the same watch group restarts its clock", async (t) => {
  let clock = NOW;
  const thread = makeThread({ agentStatus: "running", lastActivityAt: ago(1 * MIN), meta: { turnStartedAt: ago(30 * MIN) } });
  const { supervisor } = fixture(t, { threads: [thread], now: () => clock });
  await supervisor.tick({ reason: "test" });
  assert.equal(supervisor.getState().snapshot.threads[0].watch.since, ago(30 * MIN));
  // Turn A ended and turn B began between two scans: still "working", from B.
  clock += 10 * MIN;
  Object.assign(thread, { lastActivityAt: new Date(clock).toISOString(), meta: { turnStartedAt: new Date(clock - 2 * MIN).toISOString() } });
  await supervisor.tick({ reason: "test" });
  const row = supervisor.getState().snapshot.threads[0];
  assert.equal(row.watch.group, "working");
  assert.equal(row.watch.since, new Date(clock - 2 * MIN).toISOString());
});

test("a thread moved into a group with no clock of its own starts there at the move", async (t) => {
  let clock = NOW;
  const thread = makeThread({ agentStatus: "running", lastActivityAt: ago(1 * MIN), meta: { turnStartedAt: ago(5 * MIN) } });
  const { supervisor } = fixture(t, { threads: [thread], now: () => clock });
  await supervisor.tick({ reason: "test" });
  assert.equal(supervisor.getState().snapshot.threads[0].watch.group, "working");
  // The turn ends with the PR not ready: needs a push, from now, not from
  // the thread's last activity before this scan.
  Object.assign(thread, { agentStatus: "idle", lastActivityAt: ago(1 * MIN) });
  clock += 20 * MIN;
  await supervisor.tick({ reason: "test" });
  const row = supervisor.getState().snapshot.threads[0];
  assert.notEqual(row.watch.group, "working");
  assert.equal(row.watch.since, new Date(clock).toISOString());
});

// Audit 2026-10-12: TitansRTS #3 (codex:01a06f6d) got 10 question ids for one
// unchanged ask (agent message at 05:47Z) because the judge reworded it on
// each read.
test("a judge rewording the same agent ask updates one question in place", async (t) => {
  let clock = Date.parse("2026-10-12T19:07:40.000Z");
  const titles = ["restore Unity MCP access", "approve Unity MCP access?", "approve Unity MCP connection?", "allow Unity MCP access?", "enable Unity MCP connection?"];
  let read = 0;
  const judge = fakeJudge(() => ({
    action: "ask-owner", reason: "The agent is blocked on owner approval for the revoked Unity MCP connection.",
    question: { title: titles[read++], body: "Unity MCP approval was revoked; QA cannot go on.", options: ["approved", "open thread"] }
  }));
  const thread = makeThread({
    key: "codex:01a06f6d-df60-7cd3-ae5f-e89337c2112e", id: "01a06f6d-df60-7cd3-ae5f-e89337c2112e", repo: "Spshulem/TitansRTS", prRefs: ["Spshulem/TitansRTS#3"],
    lastAgentText: "QA is blocked: the Unity MCP connection approval was revoked.", lastAgentAt: "2026-10-12T05:47:09.478Z", lastActivityAt: "2026-10-12T05:47:09.478Z",
    lastUserText: "continue", lastUserAt: "2026-10-12T05:00:00.000Z"
  });
  let pr = makePr({ ref: "Spshulem/TitansRTS#3", repo: "Spshulem/TitansRTS", number: 3, url: "https://github.com/Spshulem/TitansRTS/pull/3" });
  const { supervisor, notified } = fixture(t, { mode: "auto", threads: [thread], now: () => clock, deps: {
    judge, fetchPrStates: async () => new Map([["Spshulem/TitansRTS#3", pr]]),
    readLocalGit: async () => ({ head: HEAD, branch: "spencer/fix", upstream: "origin/spencer/fix", ahead: 0, remote: "Spshulem/TitansRTS" })
  } });
  for (let scan = 0; scan < titles.length; scan += 1) {
    // Another check failing each scan: new facts, so the judge reads again.
    pr = { ...pr, ci: { state: "FAILURE", failing: ["verification", ...titles.slice(0, scan).map((_, n) => `check-${n}`)], pending: [] } };
    await supervisor.tick({ reason: "test" });
    clock += 20 * MIN;
  }
  assert.equal(judge.calls.length, titles.length, "read again each scan");
  const asks = supervisor.store.state.questions.filter((q) => q.kind === "agent-ask");
  assert.equal(asks.length, 1);
  assert.equal(asks[0].status, "open");
  assert.equal(asks[0].agentAskedAt, "2026-10-12T05:47:09.478Z");
  assert.match(asks[0].title, /enable Unity MCP connection\?$/);
  assert.deepEqual([...new Set(notified.map((q) => q.id))], [asks[0].id]);
});

// Audit 2026-10-12: #7352's "admin merge ok?" (conductor:9953b207, asked
// 15:07:54Z) closed on "waiting-ci: waiting on bb-quick", came back as a new
// question from the 17:25Z re-ask, and closed again on a background task.
test("an agent's merge ask stays one open question through waits and re-asks until the PR merges", async (t) => {
  let clock = Date.parse("2026-10-12T16:47:33.000Z");
  const base = {
    key: "conductor:9953b207-cf6a-46b3-b602-8eac616290f8", kind: "conductor", id: "9953b207-cf6a-46b3-b602-8eac616290f8", title: "monterrey", workspace: "monterrey",
    cwd: "/work/monterrey", repo: "buildbetter-app/buildbetter", branch: "spencer/waves", prRefs: ["buildbetter-app/buildbetter#7352"],
    lastAgentText: "The waves are running again. Wave 2 is finishing its last fix round and acceptance, then waves 3–6 follow.  Merging still needs your explicit go, and #7352 needs \"admin merge\" because you authored it.",
    lastAgentAt: "2026-10-12T15:07:54.712Z", lastActivityAt: "2026-10-12T15:07:54.967Z", lastUserText: "finish", lastUserAt: "2026-10-12T15:07:15.419Z"
  };
  let thread = makeThread(base);
  const bbQuick = { id: "t1", description: "Run bb-quick on wave 2", kind: "local_bash", startedAt: "2026-10-12T17:00:00.000Z" };
  let pr = makePr({ ref: "buildbetter-app/buildbetter#7352", repo: "buildbetter-app/buildbetter", number: 7352, url: "https://github.com/buildbetter-app/buildbetter/pull/7352", reviewDecision: "REVIEW_REQUIRED", headOid: "9c601accbd".padEnd(40, "0") });
  const { supervisor, notified } = fixture(t, { now: () => clock, deps: {
    listConductorThreads: async () => [thread], listCodexThreads: async () => [],
    fetchPrStates: async () => new Map([["buildbetter-app/buildbetter#7352", pr]])
  } });
  await supervisor.tick();
  const [ask] = supervisor.getState().questions;
  assert.equal(ask.kind, "agent-ask");
  assert.equal(ask.mergeAsk, true);
  // The long bb-quick wait also raises the supervisor's own BuildBot3 question.
  const openIds = () => supervisor.getState().questions.filter((q) => q.kind === "agent-ask").map((q) => q.id);

  // Waiting on bb-quick: a state change, not an answer.
  thread = makeThread({ ...base, agentStatus: "waiting", openTasks: [bbQuick] });
  clock = Date.parse("2026-10-12T17:20:00.000Z");
  await supervisor.tick();
  assert.equal(supervisor.getState().snapshot.threads[0].state, "waiting-ci");
  assert.deepEqual(openIds(), [ask.id]);

  // The agent asks again in a new message: the same question takes it.
  thread = makeThread({ ...base, lastUserText: "finish", lastUserAt: "2026-10-12T17:24:37.815Z", lastAgentAt: "2026-10-12T17:25:12.159Z", lastActivityAt: "2026-10-12T17:25:12.320Z",
    lastAgentText: "Resumed. Wave 2 moves to acceptance, then waves 3–6.\n\n- **Interruptions:** the wave run stops whenever this session ends; send \"finish\" again and I'll resume it from cache.\n- **Merges:** need your explicit go. #7352 also needs \"admin merge\"." });
  clock = Date.parse("2026-10-12T17:54:24.000Z");
  await supervisor.tick();
  assert.deepEqual(openIds(), [ask.id]);
  assert.equal(supervisor.store.question(ask.id).agentAskedAt, "2026-10-12T17:25:12.159Z");

  // A later status message that does not repeat it, on a background task: a merge ask holds.
  thread = makeThread({ ...base, agentStatus: "waiting", openTasks: [bbQuick], lastUserText: "finish all waves", lastUserAt: "2026-10-12T18:51:34.469Z",
    lastAgentAt: "2026-10-12T18:52:44.624Z", lastActivityAt: "2026-10-12T18:52:44.673Z",
    lastAgentText: "Launched a new run (`wf_464755fa-c03`). It closes wave 2's acceptance first, then builds waves 3–6." });
  clock = Date.parse("2026-10-12T18:55:34.000Z");
  await supervisor.tick();
  assert.deepEqual(openIds(), [ask.id]);
  assert.deepEqual([...new Set(notified.filter((q) => q.kind === "agent-ask").map((q) => q.id))], [ask.id], "never asked as a new question");

  pr = { ...pr, state: "MERGED", mergedAt: "2026-10-12T19:30:00.000Z", closedAt: "2026-10-12T19:30:00.000Z" };
  clock = Date.parse("2026-10-12T19:35:00.000Z");
  await supervisor.tick();
  assert.deepEqual(openIds(), []);
  assert.equal(supervisor.store.question(ask.id).resolveReason, "#7352 merged");
});

// Audit 2026-10-12: remote-dev-setup #1 (conductor:0056f770) asked about the
// LB-alert fix at 10:30Z and again at 10:54Z (a second question), then moved on.
test("an agent's ask holds while the thread only flickers, takes a re-ask in place, and closes once the agent moves on", async (t) => {
  let clock = Date.parse("2026-10-12T10:33:33.000Z");
  const base = {
    key: "conductor:0056f770-e054-484b-a712-4cc036dacf6f", kind: "conductor", id: "0056f770-e054-484b-a712-4cc036dacf6f", title: "remote-dev", workspace: "remote-dev",
    cwd: "/work/remote-dev", repo: "buildbetter-app/remote-dev-setup", branch: "spencer/remote-dev", prRefs: [], lastUserText: "1", lastUserAt: "2026-10-12T04:26:08.377Z",
    lastAgentText: "- **Cause:** the supervisor declares the LB down after one probe misses 5 seconds over Tailscale. A single network hiccup is enough.\n\n**Decision for you:** should I fix the openAGI supervisor so it retries once and checks the LB's own watchdog log before alerting? That means a public openAGI PR plus a 0.0.44 release. Yes or no?",
    lastAgentAt: "2026-10-12T10:30:27.740Z", lastActivityAt: "2026-10-12T10:30:27.740Z"
  };
  let thread = makeThread(base);
  const { supervisor, notified } = fixture(t, { now: () => clock, prs: new Map(), deps: { listConductorThreads: async () => [thread], listCodexThreads: async () => [] } });
  await supervisor.tick();
  const [ask] = supervisor.getState().questions;
  assert.equal(ask?.kind, "agent-ask");
  const openIds = () => supervisor.getState().questions.map((q) => q.id);

  // A turn running with nothing new said: the ask stands.
  thread = makeThread({ ...base, agentStatus: "running", lastActivityAt: "2026-10-12T10:40:00.000Z" });
  clock = Date.parse("2026-10-12T10:45:00.000Z");
  await supervisor.tick();
  assert.deepEqual(openIds(), [ask.id]);

  thread = makeThread({ ...base, lastAgentAt: "2026-10-12T10:54:18.107Z", lastActivityAt: "2026-10-12T10:54:18.107Z",
    lastAgentText: "Nothing for you to do. #7586 isn't stuck; it's next in line, and I've told madrid-5b. All 3 slots are busy with live runs, so it should start within 10–30 minutes.\n\nStill need your yes or no on the openAGI supervisor fix for the false LB alerts." });
  clock = Date.parse("2026-10-12T10:58:14.000Z");
  await supervisor.tick();
  assert.deepEqual(openIds(), [ask.id]);
  assert.equal(supervisor.store.question(ask.id).agentAskedAt, "2026-10-12T10:54:18.107Z");

  thread = makeThread({ ...base, lastAgentAt: "2026-10-12T11:10:18.731Z", lastActivityAt: "2026-10-12T11:10:18.731Z",
    lastAgentText: "#7352's full run passed 3 minutes ago (53 minutes, on head `9c601accbd`), and the green status is posted. Nothing to cancel.\n\nNext step for monterrey: run `bb-merge-check --pr 7352` and merge if it says READY." });
  clock = Date.parse("2026-10-12T11:13:16.000Z");
  await supervisor.tick();
  assert.deepEqual(openIds(), []);
  assert.equal(supervisor.store.question(ask.id).resolveReason, "agent moved on: no longer asks");
  assert.deepEqual([...new Set(notified.map((q) => q.id))], [ask.id]);
});

test("a ready question's PR is read after its thread moved to another PR, and its merge closes it", async (t) => {
  let thread = makeThread();
  const green = makePr({ ci: { state: "SUCCESS", failing: [], pending: [] }, unresolvedThreads: 0, mergeState: "CLEAN" });
  const prs = new Map([["acme/app#7", green]]);
  const asked = [];
  const { supervisor } = fixture(t, { deps: { listCodexThreads: async () => [thread], fetchPrStates: async (refs) => { asked.push([...refs]); return prs; } } });
  await supervisor.tick();
  const [ready] = supervisor.getState().questions;
  assert.equal(ready.kind, "ready");
  thread = makeThread({ prRefs: ["acme/app#8"] });
  prs.set("acme/app#7", { ...green, state: "MERGED", mergedAt: ago(0) });
  prs.set("acme/app#8", makePr({ ref: "acme/app#8", number: 8 }));
  await supervisor.tick();
  assert.ok(asked.at(-1).includes("acme/app#7"));
  assert.equal(supervisor.store.question(ready.id).resolveReason, "#7 merged");
});

test("needsYou and the Watching you group count only questions the owner can see", async (t) => {
  const { supervisor } = fixture(t, { threads: [asking()], prs: new Map(), review: REVIEW_ON, deps: { runModel: fakeModel(() => []).runModel } });
  // The idle watcher's scan leaves new questions held for the next review.
  await supervisor.tick({ reason: "owner-away" });
  assert.equal(supervisor.store.openQuestions().length, 1);
  assert.deepEqual(supervisor.getState().questions, []);
  const snapshot = supervisor.getState().snapshot;
  assert.equal(snapshot.counts.needsYou, 0);
  assert.equal(snapshot.counts.byWatch.you, 0);
});

// cape-town: the workspace sat on feature/bob-skills (#6817, merged Sep 27)
// while its chat opened #7063 and #7089 from other branches, so the
// supervisor showed and nudged the merged #6817.
const BB = "buildbetter-app/buildbetter";
function conductorChat(meta, extra = {}) {
  return makeThread({
    key: "conductor:342281f9", kind: "conductor", id: "342281f9", title: "BOB briefs stale data fix", workspace: "cape-town", repo: null,
    cwd: "/work/cape-town", branch: "feature/bob-skills", prRefs: [], meta, ...extra
  });
}
function prMapFixture(t, thread, states, branchPr) {
  const lite = [];
  const fetched = [];
  const made = fixture(t, {
    threads: [thread],
    deps: {
      readLocalGit: async () => ({ head: HEAD, branch: thread.branch, upstream: `origin/${thread.branch}`, ahead: 0, remote: BB }),
      findPrForBranch: async () => branchPr,
      fetchPrStateLite: async (refs) => {
        lite.push(...refs);
        return new Map(refs.map((ref) => [ref, states.has(ref) ? (states.get(ref) ? { state: states.get(ref) } : null) : null]));
      },
      fetchPrStates: async (refs) => {
        fetched.push(...refs);
        return new Map(refs.filter((ref) => states.get(ref)).map((ref) => [ref, makePr({ ref, repo: BB, number: Number(ref.split("#")[1]), state: states.get(ref) })]));
      }
    }
  });
  const row = async () => (await made.supervisor.tick({ reason: "test" })).threads.find((one) => one.key === thread.key);
  return { ...made, lite, fetched, row };
}

test("a chat that created several PRs is mapped to its newest open one, not its branch's merged PR", async (t) => {
  const cape = conductorChat({ prCreated: [`${BB}#7089`, `${BB}#7063`] });
  const states = new Map([[`${BB}#7089`, "OPEN"], [`${BB}#7063`, "OPEN"], [`${BB}#6817`, "MERGED"]]);
  const { supervisor, lite, fetched, row } = prMapFixture(t, cape, states, `${BB}#6817`);
  assert.equal((await row()).pr.ref, `${BB}#7089`);
  assert.deepEqual(fetched, [`${BB}#7089`]);
  assert.ok(lite.includes(`${BB}#6817`), "the branch PR is a candidate too");
  // Merged is final: the next scan does not read #6817 again.
  lite.length = 0;
  await supervisor.tick({ reason: "test" });
  assert.ok(!lite.includes(`${BB}#6817`));

  // Every PR it created merged, its branch PR open: the branch PR.
  states.set(`${BB}#7089`, "MERGED");
  states.set(`${BB}#7063`, "MERGED");
  states.set(`${BB}#6817`, "OPEN");
  assert.equal((await prMapFixture(t, cape, states, `${BB}#6817`).row()).pr.ref, `${BB}#6817`);
});

// A lite read that times out must not hand the chat back to its branch's
// merged PR over the newer one it created and the last scan picked.
test("a chat keeps its picked PR, not its branch's merged one, when GitHub cannot be read", async (t) => {
  const cape = conductorChat({ prCreated: [`${BB}#7089`, `${BB}#7063`] });
  const states = new Map([[`${BB}#7089`, "OPEN"], [`${BB}#7063`, "OPEN"], [`${BB}#6817`, "MERGED"]]);
  const { supervisor, row } = prMapFixture(t, cape, states, `${BB}#6817`);
  assert.equal((await row()).pr.ref, `${BB}#7089`);
  supervisor.deps.fetchPrStateLite = async () => { throw new Error("github timed out"); };
  assert.equal((await row()).pr.ref, `${BB}#7089`, "the last scan's pick stands");
  // No scan picked yet: the newest PR it created, not the branch PR.
  const fresh = prMapFixture(t, cape, states, `${BB}#6817`);
  fresh.supervisor.deps.fetchPrStateLite = async () => { throw new Error("github timed out"); };
  assert.equal((await fresh.row()).pr.ref, `${BB}#7089`);
});

// meta.prMentions is what the 2026-10-12 build's source read from the same
// transcript (every PR the chat named, viewed or checked); meta.prCreated is
// what it reads now. Neither a stack base nor another agent's PR is the chat's.
test("a PR the chat only named or viewed never becomes its PR, nor beats its own", async (t) => {
  // Its own newest PR merged; #5544 it builds on is still open.
  const merged = conductorChat({ prMentions: ["#5544", "#7580"], prCreated: [`${BB}#7580`] }, { branch: "spencer/mock-chat" });
  const done = await prMapFixture(t, merged, new Map([[`${BB}#5544`, "OPEN"], [`${BB}#7580`, "MERGED"]]), `${BB}#7580`).row();
  assert.equal(done.pr.ref, `${BB}#7580`);
  assert.equal(done.state, "done");
  // No PR of its own yet ("building on top of #5544"): it has no PR.
  const none = await prMapFixture(t, conductorChat({ prMentions: ["#5544"], prCreated: [] }, { branch: "spencer/mock-chat" }), new Map([[`${BB}#5544`, "OPEN"]]), null).row();
  assert.equal(none.pr, null);
  assert.equal(none.state, "idle-no-pr");
  assert.equal(none.reason, "no PR");
  // Another agent's open PR it viewed by URL, beside its own open branch PR
  // and a newer open PR it created: the branch PR leads.
  const viewed = conductorChat({ prMentions: [`${BB}#7010`, `${BB}#7600`, "#7547"], prCreated: [`${BB}#7600`] }, { branch: "spencer/inbox" });
  const fx = prMapFixture(t, viewed, new Map([[`${BB}#7010`, "OPEN"], [`${BB}#7600`, "OPEN"], [`${BB}#7547`, "OPEN"]]), `${BB}#7547`);
  assert.equal((await fx.row()).pr.ref, `${BB}#7547`);
  assert.ok(!fx.lite.includes(`${BB}#7010`));
});

// "issue #4321" in the agent's words kept prRefs = ["repo#4321"] on a branch
// with no PR: "PR state unknown" forever, so idle and promised-work checks
// never ran. A created ref GitHub says is no PR is dropped the same way.
test("a chat whose only candidates are no PR, on a branch with none, has no PR", async (t) => {
  for (const meta of [{ prMentions: ["#4321"], prCreated: [] }, { prCreated: [`${BB}#4321`] }]) {
    const fx = prMapFixture(t, conductorChat(meta, { branch: "spencer/fix-4321" }), new Map([[`${BB}#4321`, null]]), null);
    const row = await fx.row();
    assert.equal(row.pr, null, JSON.stringify(meta));
    assert.equal(row.reason, "no PR", JSON.stringify(meta));
  }
});

// monrovia was told "Ready to merge? ... Left on #7589" 2 s after #7589
// merged: the PR is read again right before the send.
test("a nudge whose PR merged since the scan is not sent", async (t) => {
  const BB = "buildbetter-app/buildbetter";
  const ref = `${BB}#7589`;
  const thread = makeThread({ key: "conductor:f207436c", kind: "conductor", id: "f207436c", workspace: "monrovia", prRefs: [ref],
    live: { peerName: "monrovia-1", pid: 4242, status: "idle" } });
  const scan = (stateAtSend) => fixture(t, {
    mode: "auto", threads: [thread], prs: new Map([[ref, makePr({ ref, repo: BB, number: 7589 })]]),
    deps: { fetchPrStateLite: async (refs) => new Map(refs.map((one) => [one, { state: stateAtSend }])) }
  });
  const open = scan("OPEN");
  await open.supervisor.tick({ reason: "test" });
  assert.equal(open.delivered.length, 1, "still open: sent");
  const merged = scan("MERGED");
  await merged.supervisor.tick({ reason: "test" });
  assert.equal(merged.delivered.length, 0);
  const action = merged.supervisor.getState().actions.find((a) => a.threadKey === "conductor:f207436c" && a.playbook === "merge-ready");
  assert.equal(action.status, "stale");
  assert.equal(action.detail, "not sent: #7589 merged since the scan");
});

// madrid got "#7586's required BuildBot3 full run is now failing" 76 min
// after #7586 merged. A nudge naming a settled PR, or about the PR itself,
// is moot; one about something else still goes, and so does any nudge when
// GitHub cannot answer.
test("the check before a send cancels a nudge about a settled PR only", async (t) => {
  const BB = "buildbetter-app/buildbetter";
  const ref = `${BB}#7586`;
  let answer = async (refs) => new Map(refs.map((one) => [one, { state: "MERGED" }]));
  const { supervisor } = fixture(t, { deps: { fetchPrStateLite: (...args) => answer(...args) } });
  const thread = makeThread({ key: "conductor:cd2c0072", kind: "conductor", id: "cd2c0072", workspace: "madrid", prRefs: [ref] });
  const pr = makePr({ ref, repo: BB, number: 7586, state: "MERGED" });
  const statusCheck = { playbook: "status-check", message: "#7586’s required BuildBot3 full run is now failing. Inspect the failure." };
  assert.equal(await supervisor.prSettledBeforeSend(thread, pr, statusCheck), "#7586 merged");
  assert.equal(await supervisor.prSettledBeforeSend(thread, pr, { playbook: "ci-finished", message: "CI finished on 1dc7949c4c: fail." }), "#7586 merged");
  assert.equal(await supervisor.prSettledBeforeSend(thread, pr, { playbook: "resume", message: "continue — pick up where you stopped." }), null);
  // A laptop-verify stop names the PR but is about the machine: it still goes.
  assert.equal(await supervisor.prSettledBeforeSend(thread, makePr({ ref, repo: BB, number: 7586, state: "MERGED" }), { playbook: "no-local-verify", message: "Stop local verification for #7586 on the laptop." }), null);
  answer = async () => { throw new Error("gh: timeout"); };
  assert.equal(await supervisor.prSettledBeforeSend(thread, makePr({ ref, repo: BB, number: 7586 }), statusCheck), null);
});

test("a proposed nudge whose PR merged before the owner sent it is not sent", async (t) => {
  let state = "OPEN";
  const { supervisor, delivered } = fixture(t, { mode: "propose", deps: { fetchPrStateLite: async (refs) => new Map(refs.map((ref) => [ref, { state }])) } });
  await supervisor.tick({ reason: "test" });
  const proposed = supervisor.getState().actions.find((a) => a.status === "proposed");
  state = "MERGED";
  const result = await supervisor.sendProposed(proposed.id);
  assert.equal(delivered.length, 0);
  assert.equal(result.delivery.status, "blocked");
  assert.equal(result.action.status, "stale");
  assert.equal(result.action.detail, "not sent: #7 merged since the scan");
});

// The PR read right before a send can take up to 10 s: an owner message
// that starts while it runs goes first, and the nudge is held.
test("an owner message that starts during the PR read before a send holds the nudge", async (t) => {
  const thread = makeThread();
  let supervisor = null;
  const lite = async (refs) => {
    supervisor.ownerAnsweredAt.set(thread.key, NOW);
    return new Map(refs.map((ref) => [ref, { state: "OPEN" }]));
  };
  const made = fixture(t, { mode: "auto", threads: [thread], deps: { fetchPrStateLite: lite } });
  supervisor = made.supervisor;
  const snapshot = await supervisor.tick({ reason: "test" });
  assert.deepEqual(made.delivered, []);
  assert.match(snapshot.threads.find((row) => row.key === thread.key).decision.reason, /held: owner answered$/);
});

// A turn that crashed after its PR merged is resumed on purpose: the judge's
// words name the merged PR ("PR: repo#7489 MERGED" is in its prompt), which
// must not make the check before the send cancel it every tick.
test("a judged resume naming the merged PR of a stopped turn is still sent", async (t) => {
  const BB = "buildbetter-app/buildbetter";
  const ref = `${BB}#7489`;
  const thread = makeThread({ key: "codex:t1", prRefs: [ref], agentStatus: "stalled", lastAgentAt: ago(40 * MIN), lastActivityAt: ago(40 * MIN) });
  const merged = makePr({ ref, repo: BB, number: 7489, state: "MERGED", mergedAt: ago(60 * MIN) });
  const judge = fakeJudge({ action: "send", reason: "post-merge cleanup left", message: "#7489 merged; finish the release notes you started, then report." });
  const { supervisor, delivered } = fixture(t, { mode: "auto", threads: [thread], prs: new Map([[ref, merged]]), deps: { judge } });
  await supervisor.tick({ reason: "test" });
  assert.deepEqual(delivered.map((d) => d.playbook), ["resume"]);
  assert.match(delivered[0].message, /#7489 merged/);
  assert.equal(await supervisor.prSettledBeforeSend(thread, merged, { playbook: "infra-recovered", message: "BuildBot3 is up. #7489 merged; continue." }), null);
});

// bb-recorder #279: "ready. Merge?" stayed open from 2026-10-10 after the PR
// stopped being ready on the same head. A rerun still running is no news.
test("a ready question closes once the PR stops being ready on the same head", async (t) => {
  const green = makePr({ ref: "acme/app#7", ci: { state: "SUCCESS", failing: [], pending: [] }, unresolvedThreads: 0, mergeState: "CLEAN" });
  for (const [change, reason] of [
    [{ reviewDecision: "CHANGES_REQUESTED" }, "PR no longer ready: changes requested"],
    [{ mergeState: "DIRTY", mergeable: "CONFLICTING" }, "PR no longer ready: merge conflicts"],
    [{ ci: { state: "FAILURE", failing: ["test"], pending: [] } }, "PR no longer ready: CI red: test"],
    [{ unresolvedThreads: 2 }, "PR no longer ready: 2 open threads"],
    [{ isDraft: true }, "PR no longer ready: draft"],
    // A required gate whose only run was cancelled or timed out is red too.
    [{ gates: [{ name: "verify", label: "verify", state: "CANCELLED" }] }, "PR no longer ready: verify cancelled"],
    [{ gates: [{ name: "verify", label: "verify", state: "TIMED_OUT" }] }, "PR no longer ready: verify timed_out"]
  ]) {
    let pr = green;
    const { supervisor } = fixture(t, { deps: { fetchPrStates: async () => new Map([["acme/app#7", pr]]) } });
    await supervisor.tick();
    const [ready] = supervisor.getState().questions;
    assert.match(ready.dedupeKey, /^ready:acme\/app#7:/);
    pr = { ...green, ci: { state: "PENDING", failing: [], pending: ["test"] } };
    await supervisor.tick();
    assert.equal(supervisor.store.question(ready.id).status, "open", "a rerun running is no news");
    pr = { ...green, ...change };
    await supervisor.tick();
    assert.equal(supervisor.store.question(ready.id).status, "resolved", reason);
    assert.equal(supervisor.store.question(ready.id).resolveReason, reason);
  }
});

// dakar #7317: "main CI red blocks it. Help?" stayed open beside the PR's
// "ready. Merge?" once main went green on the same head.
test("a main-red hold closes once a scan decides its thread without it", async (t) => {
  let pr = makePr({ ci: { state: "FAILURE", failing: ["main-health"], pending: [] }, unresolvedThreads: 0, mergeState: "CLEAN" });
  const { supervisor } = fixture(t, { deps: { fetchPrStates: async () => new Map([["acme/app#7", pr]]) } });
  await supervisor.tick();
  const [held] = supervisor.getState().questions;
  assert.match(held.dedupeKey, /^held:codex:t1:/);
  assert.match(held.title, /main CI red blocks it/);
  pr = { ...pr, ci: { state: "SUCCESS", failing: [], pending: [] } };
  await supervisor.tick();
  assert.equal(supervisor.store.question(held.id).status, "resolved");
  assert.deepEqual(supervisor.getState().questions.map((q) => q.dedupeKey.split(":")[0]), ["ready"]);
});

// Answers the owner gave before the 2026-10-12 build, kept for typing,
// under the keys that build used (ask:<thread>:<text hash>, judge:<...>
// with no askedBy). No scan makes those keys now: both were dropped as
// superseded on the first scan, and the policy's ask was put to the owner
// again.
test("answers kept under keys an older build saved are still typed after the upgrade", async (t) => {
  const askedAt = ago(60 * MIN);
  const desktop = { originator: "Codex Desktop" };
  const asking = makeThread({ writerLocked: true, lastAgentAt: askedAt, meta: { ...desktop, pendingQuestion: { text: "Merge despite behavior changes?", options: ["yes", "no"] } } });
  const judged = makeThread({ key: "codex:t2", id: "t2", cwd: "/work/t2", title: "Fix uploads", writerLocked: true, lastAgentAt: askedAt, lastAgentText: "Should I cut the release now or wait for QA?", meta: desktop });
  const { supervisor, delivered, dataDir } = fixture(t, { mode: "auto", delivery: "computer-use", threads: [asking, judged], deps: { uiDriver: readyDriver() } });
  const kept = (id, dedupeKey, threadKey, message) => ({
    id, dedupeKey, threadKey, kind: "agent-ask", title: "acme #7: needs your call. Answer?", body: "b", options: ["yes", "no"], status: "answered", answer: "yes",
    answeredAt: ago(10 * MIN), createdAt: ago(50 * MIN), updatedAt: ago(10 * MIN), lastAskedAt: ago(15 * MIN), expiresAt: ago(-23 * 60 * MIN),
    askContext: "ctx", agentAskedAt: askedAt, pendingDelivery: { message, since: ago(10 * MIN) }
  });
  fs.mkdirSync(path.join(dataDir, "fleet"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "fleet", "state.json"), JSON.stringify({ version: 1, questions: [
    kept("fq_old_ask", `ask:codex:t1:${shortHash("Merge despite behavior changes?")}`, "codex:t1", "Owner answer: yes. Merge it."),
    kept("fq_old_judge", "judge:codex:t2:5f1c2a9b3d4e6f70", "codex:t2", "Owner answer: yes. Cut it now.")
  ] }));
  await supervisor.tick();
  assert.deepEqual(delivered.filter((d) => d.playbook === "owner-answer").map((d) => [d.thread.key, d.message]).sort(),
    [["codex:t1", "Owner answer: yes. Merge it."], ["codex:t2", "Owner answer: yes. Cut it now."]]);
  assert.equal(supervisor.store.question("fq_old_ask").deliveredAnswer, "sent");
  assert.equal(supervisor.store.question("fq_old_judge").deliveredAnswer, "sent");
  assert.equal(supervisor.store.question("fq_old_judge").askedBy, "judge");
  // The answered ask holds: not put to the owner again under its new key.
  assert.deepEqual(supervisor.getState().questions.filter((q) => q.kind === "agent-ask"), []);
});


test("self-fix sessions, branches and worktrees are never classified for nudges", async (t) => {
  const threads = [makeThread({ id: "own-session", key: "codex:own-session" }), makeThread({ id: "fix-branch", key: "codex:fix-branch", branch: "selffix/fix-one" }), makeThread({ id: "fix-path", key: "codex:fix-path", cwd: "/work/fix-one/subdir" })];
  const { supervisor, delivered } = fixture(t, { threads, mode: "auto" });
  const fix = supervisor.store.queueFix({ title: "Repair", problem: "Failure", acceptance: "Pass", area: "policy" });
  supervisor.store.updateFix(fix.id, { worktree: "/work/fix-one" });
  supervisor.store.addSelfSession("own-session", fix.id);
  await supervisor.tick();
  assert.equal(delivered.length, 0);
  assert.equal(supervisor.store.actions(100).filter((action) => action.kind === "nudge").length, 0);
});

test("a dismissed question takes its row out of Waiting on you at once, not at the next scan (codex:01a13388)", async (t) => {
  let now = NOW;
  const asking = makeThread({ lastAgentText: "The request is ready. Should I call U.S. Bank or the Amazon transition line? Your call.", prRefs: [] });
  const { supervisor } = fixture(t, { threads: [asking], prs: new Map(), now: () => now });
  await supervisor.tick({ reason: "test" });
  const before = supervisor.getState();
  const question = before.questions.find((q) => q.threadKey === "codex:t1");
  assert.ok(question, "the agent's ask is open");
  assert.equal(before.snapshot.threads[0].watch.group, "you");
  assert.equal(before.snapshot.counts.byWatch.you, 1);
  now += 8 * 60 * MIN;
  supervisor.dismissQuestion(question.id);
  // No scan since: the stored snapshot still says "you", the state does not.
  assert.equal(supervisor.store.snapshot.threads[0].watch.group, "you");
  const after = supervisor.getState();
  assert.equal(after.questions.some((q) => q.threadKey === "codex:t1"), false);
  assert.equal(after.snapshot.threads[0].watch.group, "push");
  assert.equal(after.snapshot.threads[0].watch.since, new Date(now).toISOString());
  assert.equal(after.snapshot.counts.byWatch.you, 0);
  assert.equal(after.snapshot.counts.byWatch.push, 1);
  assert.equal(after.snapshot.counts.needsYou, after.questions.length);
});

test("every question card says when the agent asked, in which chat, and where it is answered", async (t) => {
  const asking = makeThread({ title: "Fix billing", lastAgentText: "Ready. Want me to merge with --admin or wait for Nikhil's approval?", prRefs: [] });
  const { supervisor } = fixture(t, { threads: [asking], prs: new Map() });
  await supervisor.tick({ reason: "test" });
  const question = supervisor.getState().questions.find((q) => q.threadKey === "codex:t1");
  assert.equal(question.askedAt, asking.lastAgentAt, "the agent's own ask time");
  assert.equal(question.chatLabel, "Fix billing (Codex)");
  assert.deepEqual(question.openChat, { app: "codex", url: "codex://threads/t1", label: "Fix billing (Codex)", note: null });
  assert.equal(question.answerIn, "here");
  assert.equal(question.risky, true, "a merge ask is read in full first");
  // A question card is answered in the agent's app; it has no agent time, so the supervisor's.
  const card = supervisor.questionView({ id: "fq_c", kind: "agent-card", threadKey: "codex:t1", options: ["open thread"], title: "Which browser?", createdAt: ago(3 * MIN) }, new Map());
  assert.equal(card.answerIn, "agent app");
  assert.equal(card.askedAt, ago(3 * MIN));
  assert.equal(card.openChat.url, "codex://threads/t1");
  assert.equal(card.risky, false);
  // A group names each chat; a thread this process never read uses the row's link.
  const rows = new Map([["conductor:s1", { openChat: { app: "conductor", url: "conductor://workspace?id=w&session=s1", label: "cairo (Conductor)", note: null } }]]);
  const group = supervisor.questionView({ id: "fq_g", kind: "limit", threadKey: null, threadKeys: ["codex:t1", "conductor:s1"], options: ["wait", "added"], title: "2 capped", createdAt: ago(1 * MIN) }, rows);
  assert.equal(group.chatLabel, "Fix billing (Codex) +1 more");
  assert.deepEqual(group.chats.map((chat) => chat.url), ["codex://threads/t1", "conductor://workspace?id=w&session=s1"]);
  assert.equal(group.openChat, null);
  assert.equal(group.answerIn, "here");
});

test("a thread's detail: last agent message, owner's last word, PR, watch, next step, questions and its chat", async (t) => {
  const thread = makeThread({ lastUserText: "please fix the tests", lastUserAt: ago(90 * MIN) });
  const { supervisor } = fixture(t, { threads: [thread] });
  await supervisor.tick({ reason: "test" });
  const detail = supervisor.threadDetail("codex:t1");
  assert.equal(detail.key, "codex:t1");
  assert.deepEqual(detail.lastAgentMessage, { text: "Pushed.", at: thread.lastAgentAt });
  assert.equal(detail.lastOwnerAt, ago(90 * MIN));
  assert.deepEqual(detail.lastOwnerMessage, { text: "please fix the tests", at: ago(90 * MIN) });
  assert.equal(detail.activityTruncated, false);
  assert.equal(detail.pr.ref, "acme/app#7");
  assert.equal(detail.pr.url, "https://github.com/acme/app/pull/7");
  assert.equal(detail.pr.ci.state, "FAILURE");
  assert.equal(detail.pr.head, HEAD.slice(0, 10));
  assert.equal(detail.watch.group, "push");
  assert.equal(detail.decision.action, "nudge");
  assert.equal(detail.decision.playbook, "merge-ready");
  assert.match(detail.decision.message, /Ready to merge\?/);
  assert.deepEqual(detail.questions, []);
  assert.equal(detail.openChat.url, "codex://threads/t1");
  assert.equal(detail.muted, null);
  assert.equal(detail.scannedAt, supervisor.getState().snapshot.at);
  assert.equal(supervisor.threadDetail("codex:nope"), null);
  // The supervisor's own message is no owner word.
  const own = fixture(t, { threads: [makeThread({ lastUserText: "[OpenAGI supervisor] CI is green", lastUserAt: ago(5 * MIN) })] }).supervisor;
  await own.tick({ reason: "test" });
  assert.equal(own.threadDetail("codex:t1").lastOwnerAt, null);
  assert.equal(own.threadDetail("codex:t1").lastOwnerMessage, null);
});

test("thread activity keeps long context bounded and redacts both speakers", async (t) => {
  const text = "Context. ".repeat(2000) + " sk-" + "a".repeat(48);
  const thread = makeThread({ lastAgentText: text, lastUserText: text, lastUserAt: ago(MIN) });
  const { supervisor } = fixture(t, { threads: [thread] });
  await supervisor.tick();
  const detail = supervisor.threadDetail(thread.key);
  for (const message of [detail.lastAgentMessage, detail.lastOwnerMessage]) {
    assert.ok(message.text.length <= 12_000);
    assert.ok(message.text.length > 1200, "detail must provide more than the list excerpt");
    assert.ok(!message.text.includes("sk-" + "a".repeat(48)));
  }
  assert.equal(detail.activityTruncated, true);
});

test("Push now previews a paced row and sends exactly those words once in observe", async (t) => {
  const thread = makeThread({ lastUserAt: ago(MIN) });
  const { supervisor, delivered } = fixture(t, { threads: [thread] });
  await supervisor.tick();
  const row = supervisor.getState().snapshot.threads[0];
  assert.equal(row.watch.group, "push");
  assert.equal(row.decision.action, "wait");
  assert.ok(row.pushPreview.message);
  const result = await supervisor.pushNow(thread.key);
  assert.equal(result.delivery.status, "sent");
  assert.equal(delivered[0].message, row.pushPreview.message);
  assert.equal(result.action.by, "owner");
  assert.equal(supervisor.getState().snapshot.threads[0].pushPreview, null);
  assert.match((await supervisor.pushNow(thread.key)).delivery.detail, /already sent/);
  assert.equal(delivered.length, 1);
});

test("a nudge already delivered automatically cannot be pushed again", async (t) => {
  const { supervisor, delivered } = fixture(t, { mode: "auto" });
  await supervisor.tick();
  assert.equal(delivered.length, 1);
  assert.equal(supervisor.getState().snapshot.threads[0].pushPreview, null);
  assert.match((await supervisor.pushNow("codex:t1")).delivery.detail, /already sent/);
  assert.equal(delivered.length, 1);
});

test("Push now keeps the judge's full preview instead of re-rendering a template", async (t) => {
  const message = "Check these exact details. ".repeat(30);
  const judge = fakeJudge({ action: "send", reason: "needs work", message });
  const { supervisor, delivered } = fixture(t, { mode: "auto", deliverStatus: "blocked", deps: { judge } });
  await supervisor.tick();
  const preview = supervisor.getState().snapshot.threads[0].pushPreview;
  assert.equal(preview.message, message);
  const result = await supervisor.pushNow("codex:t1");
  assert.equal(result.delivery.status, "blocked");
  assert.equal(delivered.at(-1).message, preview.message);
});

test("one Push now holds the thread through delivery across clients", async (t) => {
  let release;
  const { supervisor } = fixture(t, { deps: { executor: {
    deliver: async () => { await new Promise((resolve) => { release = resolve; }); return { status: "sent" }; },
    inFlight: () => [], whenIdle: async () => {}
  } } });
  await supervisor.tick();
  const first = supervisor.pushNow("codex:t1");
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(supervisor.getState().snapshot.threads[0].pushing, true);
  assert.match((await supervisor.pushNow("codex:t1")).delivery.detail, /already being sent/);
  release();
  assert.equal((await first).delivery.status, "sent");
  assert.equal(supervisor.getState().snapshot.threads[0].pushing, false);
});

test("a question held for review blocks Push now and its preview", async (t) => {
  const { supervisor, delivered } = fixture(t);
  await supervisor.tick();
  const question = supervisor.store.upsertQuestion({ dedupeKey: "held", kind: "agent-ask", threadKey: "codex:t1", title: "Merge?", options: ["yes"] });
  supervisor.awaitingReview.add(question.id);
  assert.equal(supervisor.getState().snapshot.threads[0].pushPreview, null);
  assert.match((await supervisor.pushNow("codex:t1")).delivery.detail, /waits on your answer/);
  assert.equal(delivered.length, 0);
});

test("mute immediately removes Waiting on you and snapshot excerpts redact secrets", async (t) => {
  const thread = makeThread({ lastAgentText: "Done. API_KEY=fictional-secret. Want me to deploy to production?" });
  const { supervisor } = fixture(t, { threads: [thread] });
  await supervisor.tick();
  assert.equal(supervisor.getState().snapshot.threads[0].watch.group, "you");
  assert.doesNotMatch(supervisor.getState().snapshot.threads[0].lastAgentText, /fictional-secret/);
  supervisor.muteThread(thread.key);
  const state = supervisor.getState();
  assert.equal(state.snapshot.threads[0].watch.group, "quiet");
  assert.equal(state.snapshot.counts.byWatch.you, 0);
  assert.equal(state.questions.length, 0, "muting hides its open questions immediately");
  supervisor.unmuteThread(thread.key);
  assert.equal(supervisor.getState().snapshot.threads[0].watch.group, "you");
});

test("risky classification reads the ask itself rather than incidental report context", async (t) => {
  const { supervisor } = fixture(t);
  const rows = new Map();
  const question = { kind: "agent-ask", title: "Re-verify?", body: "Run the tests again?", askContext: "The release merged and production deployed.", options: ["run", "wait"] };
  assert.equal(supervisor.questionView(question, rows).risky, false);
  assert.equal(supervisor.questionView({ ...question, title: "Deploy to production?" }, rows).risky, true);
  assert.equal(supervisor.questionView({ ...question, mergeAsk: true }, rows).risky, true);
  assert.equal(supervisor.questionView({ kind: "storage", title: "Remove 2 old projects?", body: "These project folders will be removed.", options: ["Delete 2", "Keep", "Later"] }, rows).risky, true, "storage deletion shows the full warning before approval");
});

test("Push now never goes ahead of an open question or a muted thread, and needs a scan", async (t) => {
  const asking = makeThread({ lastAgentText: "Ready. Want me to merge with --admin or wait for Nikhil's approval?", prRefs: [] });
  const { supervisor, delivered } = fixture(t, { threads: [asking], prs: new Map() });
  assert.match((await supervisor.pushNow("codex:t1")).delivery.detail, /scan first/);
  await supervisor.tick({ reason: "test" });
  const asked = await supervisor.pushNow("codex:t1");
  assert.equal(asked.delivery.status, "blocked");
  assert.match(asked.delivery.detail, /^waits on your answer first: /);
  assert.equal(delivered.length, 0);
  // Answered: an ask is still all policy has for it, so nothing to push.
  const question = supervisor.getState().questions.find((q) => q.threadKey === "codex:t1");
  supervisor.dismissQuestion(question.id);
  assert.match((await supervisor.pushNow("codex:t1")).delivery.detail, /^nothing to push: /);
  // Muted and unmuted.
  const muted = supervisor.muteThread("codex:t1", { hours: 2 });
  assert.equal(muted.until, new Date(NOW + 2 * 60 * MIN).toISOString());
  assert.equal(supervisor.getState().snapshot.threads[0].muted, muted.until);
  assert.match((await supervisor.pushNow("codex:t1")).delivery.detail, /^muted/);
  supervisor.unmuteThread("codex:t1");
  assert.equal(supervisor.getState().snapshot.threads[0].muted, null);
  assert.equal(supervisor.store.mutedKeys().has("codex:t1"), false);
  assert.ok(supervisor.getState().actions.some((action) => action.kind === "mute" && action.by === "owner"));
  assert.equal(delivered.length, 0);
});

test("Push now waits for an owner answer still on its way to the thread", async (t) => {
  const { supervisor, delivered } = fixture(t, { mode: "auto" });
  await supervisor.tick({ reason: "test" });
  const sent = delivered.length;
  supervisor.store.upsertQuestion({ dedupeKey: "ask:codex:t1:x", kind: "agent-ask", threadKey: "codex:t1", title: "Merge?", options: ["yes", "no"] });
  const id = supervisor.store.openQuestions().find((q) => q.dedupeKey === "ask:codex:t1:x").id;
  supervisor.store.queueAnswer(id, "yes", "Owner answer: yes. Continue with that.");
  const result = await supervisor.pushNow("codex:t1");
  assert.equal(result.delivery.status, "blocked");
  assert.match(result.delivery.detail, /still on its way/);
  assert.equal(delivered.length, sent);
});

for (const probe of ["probeDelivery", "prSettledBeforeSend"]) {
  for (const ownerState of ["question", "grouped question", "answer"]) {
    test(`Push now rechecks ${ownerState} after ${probe}`, async (t) => {
      const { supervisor, delivered } = fixture(t);
      await supervisor.tick();
      const original = supervisor[probe].bind(supervisor);
      let release;
      let entered;
      const started = new Promise((resolve) => { entered = resolve; });
      supervisor[probe] = async (...args) => {
        const result = await original(...args);
        entered();
        await new Promise((resolve) => { release = resolve; });
        return result;
      };
      const push = supervisor.pushNow("codex:t1");
      await started;
      const question = supervisor.store.upsertQuestion({ dedupeKey: "during-push", kind: "agent-ask", title: "Which fix?", options: ["A"],
        ...(ownerState === "grouped question" ? { threadKeys: ["codex:t1"] } : { threadKey: "codex:t1" }) });
      if (ownerState === "answer") {
        supervisor.answering.add(question.id);
        supervisor.store.answerQuestion(question.id, "A");
      }
      release();
      const result = await push;
      assert.equal(result.delivery.status, "blocked");
      assert.match(result.delivery.detail, ownerState === "answer" ? /answer to it is still on its way/ : /waits on your answer/);
      assert.equal(result.action, null);
      assert.equal(delivered.length, 0);
      assert.equal(supervisor.pushing.has("codex:t1"), false);
    });
  }
}

test("an Antigravity conversation stopped on its quota resumes through agentapi after the reset", async (t) => {
  const limited = (resetAt) => makeThread({
    key: "antigravity:a1", kind: "antigravity", id: "a1", title: "Data room", cwd: "/work/a1", agentStatus: "error", prRefs: [],
    error: { kind: "usage-limit", text: "Individual quota reached. Resets in 37m19s.", resetAt }, meta: { app: "antigravity" }
  });
  const waiting = fixture(t, { mode: "auto", threads: [limited(new Date(NOW + 30 * MIN).toISOString())] });
  const before = await waiting.supervisor.tick({ reason: "test" });
  assert.equal(waiting.delivered.length, 0);
  assert.equal(before.counts.sources.antigravity, 1);
  const row = before.threads.find((thread) => thread.key === "antigravity:a1");
  assert.equal(row.state, "infra-blocked");
  assert.equal(row.route, "antigravity-send");
  const passed = fixture(t, { mode: "auto", threads: [limited(new Date(NOW - 5 * MIN).toISOString())] });
  await passed.supervisor.tick({ reason: "test" });
  assert.equal(passed.delivered.length, 1);
  assert.equal(passed.delivered[0].route, "antigravity-send");
  assert.equal(passed.delivered[0].thread.key, "antigravity:a1");
  assert.equal(passed.delivered[0].playbook, "resume");
  // A failed Antigravity read is a source error, not zero conversations.
  const broken = fixture(t, { deps: { listAntigravityThreads: async () => { throw new Error("Antigravity database unavailable"); } } });
  const snapshot = await broken.supervisor.tick({ reason: "test" });
  assert.match(snapshot.sourceErrors.antigravity, /unavailable/);
});


test("Antigravity open-chat guidance reaches the public fleet snapshot", async (t) => {
  const openChat = { app: "antigravity", url: null, label: "app · Data room (Antigravity)", note: "Antigravity has no link to one conversation: open it in Antigravity and pick it in the sidebar." };
  const thread = makeThread({ key: "antigravity:a1", kind: "antigravity", id: "a1", title: "Data room", workspace: "app", prRefs: [], meta: { openChat: { app: "claude", url: "https://stale.example", label: "stale" } } });
  const { supervisor } = fixture(t, { threads: [thread] });
  const snapshot = await supervisor.tick({ reason: "test" });
  assert.deepEqual(snapshot.threads[0].openChat, openChat);
  assert.deepEqual((await supervisor.threadDetail(thread.key)).openChat, openChat);
});


test("planned durations invalidate judge cache entries", () => {
  const thread = makeThread();
  const decision = { playbook: "status-check", message: "Run the trial for 5m." };
  assert.notEqual(judgeCacheKey(thread, decision), judgeCacheKey(thread, { ...decision, message: "Run the trial for 60m." }));
});

test("policy silence and empty-wait counters do not spend another judge call", () => {
  const thread = makeThread();
  for (const reason of ["no word in 60m while waiting on bb-verify --full", "waited 60m with nothing visible"]) {
    const decision = { playbook: "status-check", reason, message: "The agent has been silent for 60m." };
    assert.equal(judgeCacheKey(thread, decision), judgeCacheKey(thread, { ...decision, reason: reason.replace("60m", "61m"), message: "The agent has been silent for 61m." }));
  }
});

test("a mute during question review also holds its phone notification", async (t) => {
  const judge = fakeJudge({ action: "ask-owner", reason: "needs a call", question: { title: "Continue?", body: "Choose how to proceed.", options: ["yes", "no"] } });
  const { supervisor, notified } = fixture(t, { mode: "auto", deps: { judge } });
  supervisor.reviewOpenQuestions = async () => {
    await Promise.resolve();
    supervisor.muteThread("codex:t1");
    return new Set();
  };
  await supervisor.tick();
  assert.ok(supervisor.store.openQuestions().length);
  assert.equal(notified.length, 0);
  assert.equal(supervisor.getState().questions.length, 0);
});

test("muting while a PR check is pending cancels automatic and manual pushes", async (t) => {
  for (const mode of ["auto", "propose"]) {
    const { supervisor, delivered } = fixture(t, { mode });
    if (mode === "propose") await supervisor.tick();
    supervisor.prSettledBeforeSend = async () => { supervisor.muteThread("codex:t1"); return null; };
    if (mode === "auto") await supervisor.tick();
    else assert.match((await supervisor.pushNow("codex:t1")).delivery.detail, /muted/);
    assert.equal(delivered.length, 0);
  }
});

test("Push now shares the automatic-send lock through recording its receipt", async (t) => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const executor = { deliver: async () => { entered(); await pending; return { status: "sent", route: "cli" }; }, inFlight: () => [], whenIdle: async () => {} };
  const { supervisor } = fixture(t, { mode: "auto", deps: { executor } });
  const tick = supervisor.tick();
  await started;
  try { assert.match((await supervisor.pushNow("codex:t1")).delivery.detail, /already being sent/); }
  finally { release(); await tick; }
});
