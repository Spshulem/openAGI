import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, resolveFleetConfig } from "../src/fleet/contracts.js";
import { FleetSupervisor, groupQuestions } from "../src/fleet/supervisor.js";

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
    updatedAt: ago(0), ...overrides
  };
}

function fixture(t, { threads = [makeThread()], prs = null, mode = "observe", deps = {}, now = () => NOW, limits = {}, deliverStatus = "sent", manager = null } = {}) {
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
  const config = resolveFleetConfig({}, { home: dataDir, mode, limits: { ...DEFAULTS, ...limits }, managerRef: "none" });
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
  const ask = (threadKey, kind, title) => ({ threadKey, playbook: null, question: { title, body: "x", options: ["yes", "no"], dedupeKey: `${kind}:${threadKey}`, kind } });
  const grouped = groupQuestions([
    ask("a", "limit", "cairo capped"), ask("b", "limit", "apia capped"), ask("c", "open", "milan stuck"),
    ask("infra:bb3", "infra", "BB3 jammed. Manager offline."), ask("a", "infra", "BB3 jammed. Manager offline.")
  ], byKey);
  assert.equal(grouped.length, 3);
  const limit = grouped.find((q) => q.kind === "limit");
  assert.match(limit.title, /^2 threads capped\. Reset /);
  assert.deepEqual(limit.threadKeys, ["a", "b"]);
  assert.match(limit.body, /cairo #1, apia #2/);
  assert.equal(grouped.filter((q) => q.title.startsWith("BB3 jammed")).length, 1);
  assert.equal(grouped.find((q) => q.kind === "open").threadKey, "c");
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
  assert.equal(snapshot.threads[0].state, "idle-no-pr");
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
