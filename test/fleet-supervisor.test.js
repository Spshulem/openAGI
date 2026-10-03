import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, resolveFleetConfig } from "../src/fleet/contracts.js";
import { FleetSupervisor, groupQuestions } from "../src/fleet/supervisor.js";
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
  const config = resolveFleetConfig(env, { home: dataDir, mode, limits: { ...DEFAULTS, ...limits }, managerRef: "none", ...(delivery ? { delivery } : {}), ...(review ? { review } : {}) });
  const prMap = prs ?? new Map([["acme/app#7", makePr()]]);
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
      readCodexLbErrors: async () => [],
      findLocalHeavyVerification: async () => [],
      readLocalGit: async () => ({ head: HEAD, branch: "spencer/fix", upstream: "origin/spencer/fix", ahead: 0, remote: "acme/app" }),
      findPrForBranch: async () => null,
      fetchPrStates: async () => prMap,
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
  const threads = Array.from({ length: 65 }, (_, i) => makeThread({ branch: `branch-${i}`, prRefs: [] }));
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
  const first = fixture(t, { mode: "auto", delivery: "computer-use-first", threads: [thread], deps: { uiDriver: readyDriver(false, "screen locked") } });
  await first.supervisor.tick({ reason: "test" });
  assert.deepEqual(first.delivered.map((d) => d.route), ["codex-exec"]);
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

test("a ready question asked every tick keeps one id past a day", async (t) => {
  let now = NOW;
  const green = makePr({ ci: { state: "SUCCESS", failing: [], pending: [] }, unresolvedThreads: 0, mergeState: "CLEAN" });
  const { supervisor } = fixture(t, { prs: new Map([["acme/app#7", green]]), now: () => now });
  await supervisor.tick();
  const [ready] = supervisor.getState().questions;
  assert.ok(ready);
  for (const hours of [12, 13]) {
    now += hours * 60 * MIN;
    await supervisor.tick();
  }
  assert.deepEqual(supervisor.getState().questions.map((q) => q.id), [ready.id]);
});

test("a one-tick blip reopens the same question and outreach copy instead of a new ask", async (t) => {
  const calls = [];
  let now = NOW;
  let thread = makeThread();
  const green = makePr({ ci: { state: "SUCCESS", failing: [], pending: [] }, unresolvedThreads: 0, mergeState: "CLEAN" });
  const { supervisor, notified } = fixture(t, { prs: new Map([["acme/app#7", green]]), now: () => now, deps: { listCodexThreads: async () => [thread] } });
  supervisor.runtime = { outreach: {
    resolve: (id, decision, opts) => calls.push(["resolve", id, decision, opts.status]),
    reopen: (id) => calls.push(["reopen", id])
  } };
  await supervisor.tick();
  const [ready] = supervisor.getState().questions;
  assert.match(ready.dedupeKey, /^ready:/);
  supervisor.store.markQuestionNotified(ready.id, { outreachId: "out_1", pushedAt: new Date(NOW).toISOString() });

  // One tick mid-turn closes it, and the reason is kept.
  thread = makeThread({ agentStatus: "running" });
  now += 5 * MIN;
  await supervisor.tick();
  assert.deepEqual(supervisor.getState().questions, []);
  assert.equal(supervisor.store.question(ready.id).resolveReason, "running: turn in progress");

  thread = makeThread();
  now += 5 * MIN;
  await supervisor.tick();
  assert.deepEqual(supervisor.getState().questions.map((q) => q.id), [ready.id]);
  assert.deepEqual(calls, [["resolve", "out_1", "resolved", "dismissed"], ["reopen", "out_1"]]);
  assert.equal(notified.at(-1).id, ready.id);
  assert.equal(notified.at(-1).outreachId, "out_1");
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
  // A changed ask is a new question, reviewed before it is pushed.
  verdict = "keep";
  thread = asking({ lastAgentText: "Should I email the customer about the outage?" });
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
  // 0, 5 (backoff 5), 15 (backoff 10), then 30+ min in with 3 failures: ask.
  assert.equal(delivered.length, 3);
  const asks = supervisor.store.openQuestions().filter((q) => q.kind === "deliver");
  assert.equal(asks.length, 1);
  assert.equal(asks[0].dedupeKey, "deliver:group", "one grouped question, even for one thread");
  assert.match(asks[0].body, /ambiguous: two threads share this title/);
  assert.match(asks[0].body, /rename or archive one/);
  // One question, kept while it stays true (the notifier dedupes the push).
  assert.equal(new Set(notified.filter((q) => q.kind === "deliver").map((q) => q.id)).size, 1);
  assert.equal(supervisor.store.ledgerFor("codex:t1").undelivered.count, 3);
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
