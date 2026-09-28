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

function fixture(t, { threads = [makeThread()], prs = null, mode = "observe", deps = {}, now = () => NOW, limits = {}, deliverStatus = "sent", manager = null, delivery = undefined } = {}) {
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
  const config = resolveFleetConfig({}, { home: dataDir, mode, limits: { ...DEFAULTS, ...limits }, managerRef: "none", ...(delivery ? { delivery } : {}) });
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
  assert.match(limit.body, /cairo #1, apia #2/);
  assert.equal(grouped.filter((q) => q.title.startsWith("BB3 jammed")).length, 1);
  assert.equal(grouped.find((q) => q.kind === "open").threadKey, "c");
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
  assert.equal(delivered.length, 0);
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

test("a blocked app send spends no attempt and no cooldown, so the next tick tries again", async (t) => {
  let now = NOW;
  const { supervisor, delivered } = fixture(t, { mode: "auto", delivery: "computer-use", deliverStatus: "blocked", now: () => now, deps: { uiDriver: readyDriver() } });
  await supervisor.tick({ reason: "test" });
  const ledger = supervisor.store.ledgerFor("codex:t1");
  assert.equal(ledger.attemptsWithoutProgress ?? 0, 0);
  assert.equal(ledger.lastNudgeAt ?? null, null);
  now += MIN;
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
  assert.equal(held.question.status, "open");
  assert.match(held.delivery.detail, /computer use not ready: Codex is not running/);
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
  const executor = {
    deliver: async (args) => {
      running += 1;
      most = Math.max(most, running);
      routes.push(args.route);
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
  const result = await supervisor.answerQuestion(group.id, "added");
  assert.equal(result.delivery.status, "sent");
  assert.equal(result.question.status, "answered");
  assert.deepEqual(routes, ["computer-use", "computer-use", "computer-use"]);
  assert.equal(most, 1);
});

test("the owner's own message to a thread goes through the supervisor's delivery", async (t) => {
  const { supervisor, delivered } = fixture(t, { threads: [makeThread()] });
  await supervisor.tick();
  const result = await supervisor.sendOwnerMessage("codex:t1", "  Rebase on main.  ");
  assert.equal(result.delivery.status, "sent");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].message, "Rebase on main.");
  assert.equal(delivered[0].playbook, "owner-message");
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
