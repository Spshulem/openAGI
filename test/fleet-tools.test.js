import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tool-registry.js";
import { registerFleetTools } from "../src/fleet/tools.js";
import { createDefaultRuntime } from "../src/index.js";

function row(overrides = {}) {
  return {
    key: "codex:t1", kind: "codex", title: "Fix billing", workspace: null, repo: "acme/app", branch: "spencer/fix",
    agentStatus: "idle", state: "pr-not-ready", health: "yellow", reason: "CI red: verification",
    blockers: ["CI red: verification"],
    pr: { ref: "acme/app#7", url: "https://github.com/acme/app/pull/7", state: "OPEN", title: "Fix", ci: { state: "FAILURE", failing: ["verification"], pending: [] }, unresolvedThreads: 0, mergeState: "UNSTABLE", head: "bbbbbbbbbb" },
    lastActivityAt: "2026-09-26T10:00:00.000Z", lastAgentText: "Pushed the fix. CI is running.",
    error: null, live: false, route: "codex-exec",
    decision: { action: "nudge", playbook: "ci-red", reason: "CI red", notBefore: null },
    ...overrides
  };
}

function fakeSupervisor(state = {}) {
  return {
    getState: () => ({
      mode: "propose", enabled: true, running: false, lastTickAt: "2026-09-26T11:00:00.000Z", lastError: null,
      snapshot: { at: "2026-09-26T11:00:00.000Z", counts: { threads: 0, inScope: 0, byState: {}, needsYou: 0, actions: 0 }, threads: [], infra: {}, sourceErrors: {} },
      questions: [], actions: [], settings: {},
      ...state
    })
  };
}

function registry(supervisor) {
  const tools = new ToolRegistry();
  registerFleetTools(tools, supervisor);
  return tools;
}

test("registers two read-only fleet tools and replaces them on re-register", () => {
  const tools = registry(fakeSupervisor());
  for (const name of ["fleet_status", "fleet_thread"]) {
    const tool = tools.get(name);
    assert.ok(tool, name);
    assert.equal(tool.sideEffects, false);
    assert.equal(tool.needsConfirmation, false);
    assert.equal(tool.source, "integration:fleet-supervisor");
  }
  assert.deepEqual(tools.get("fleet_thread").parameters.required, ["key"]);
  registerFleetTools(tools, fakeSupervisor());
  // The two sending tools register only for a supervisor that can send.
  assert.equal(tools.list().filter((tool) => tool.name.startsWith("fleet_")).length, 2);
  registerFleetTools(tools, null);
  assert.equal(tools.has("fleet_status"), false);
  assert.equal(tools.has("fleet_thread"), false);
});

test("fleet_status lists red, yellow, green, gray, newest first, compact", async () => {
  const threads = [
    row({ key: "a", workspace: "cairo", state: "done", health: "green", lastActivityAt: "2026-09-26T09:00:00.000Z" }),
    row({ key: "b", state: "excluded", health: "gray" }),
    row({ key: "c", state: "needs-human", health: "red", lastActivityAt: "2026-09-26T08:00:00.000Z" }),
    row({ key: "d", state: "idle-no-pr", health: "yellow", pr: null }),
    row({ key: "e", state: "infra-blocked", health: "red", lastActivityAt: "2026-09-26T10:30:00.000Z" }),
    // No health (saved before it existed): derived, not dropped.
    row({ key: "f", state: "running", health: undefined })
  ];
  const questions = [{ id: "fq_1", title: "Merge #7?", body: "long body", options: ["yes", "no"], threadKey: "c", dedupeKey: "k", status: "open" }];
  const tools = registry(fakeSupervisor({ snapshot: { at: "2026-09-26T11:00:00.000Z", counts: { threads: 6 }, threads, sourceErrors: { claude: "boom /Users/secret" } }, questions }));
  const { ok, result } = await tools.invoke("fleet_status", {});
  assert.equal(ok, true);
  assert.equal(result.mode, "propose");
  assert.equal(result.lastTickAt, "2026-09-26T11:00:00.000Z");
  assert.deepEqual(result.counts, { threads: 6 });
  assert.deepEqual(result.byHealth, { red: 2, yellow: 1, green: 2, gray: 1 });
  assert.deepEqual(result.threads.map((t) => t.key), ["e", "c", "d", "f", "a", "b"]);
  assert.deepEqual(result.threads[4], {
    key: "a", name: "cairo", state: "done", health: "green", reason: "CI red: verification",
    pr: { ref: "acme/app#7", state: "OPEN", ci: "FAILURE" }, lastActivityAt: "2026-09-26T09:00:00.000Z"
  });
  assert.equal(result.threads[1].name, "Fix billing");
  assert.equal(result.threads[2].pr, null);
  assert.equal(result.threads[3].health, "green");
  assert.deepEqual(result.questions, [{ id: "fq_1", title: "Merge #7?", options: ["yes", "no"], threadKey: "c" }]);
  // Source names only: source error text can carry paths.
  assert.deepEqual(result.failedSources, ["claude"]);
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /Pushed the fix|\/Users\/secret|long body|dedupeKey/);
});

test("fleet_status caps the thread list and says how many it left out", async () => {
  const threads = Array.from({ length: 75 }, (_, i) => row({ key: `codex:t${i}` }));
  const tools = registry(fakeSupervisor({ snapshot: { at: "x", counts: {}, threads, sourceErrors: {} } }));
  const { result } = await tools.invoke("fleet_status", {});
  assert.equal(result.threads.length, 60);
  assert.equal(result.truncated, 15);
});

test("fleet_status before the first scan says so instead of failing", async () => {
  const tools = registry(fakeSupervisor({ snapshot: null, lastTickAt: null }));
  const { ok, result } = await tools.invoke("fleet_status", {});
  assert.equal(ok, true);
  assert.deepEqual(result.threads, []);
  assert.equal(result.counts, null);
  assert.match(result.note, /No scan yet/);
});

test("fleet_thread returns the full row and that thread's open questions", async () => {
  const target = row({ key: "claude:x", health: undefined, state: "needs-human", error: { kind: "usage-limit", resetAt: null } });
  const questions = [
    { id: "fq_own", title: "Merge #7?", body: "Ready.", options: ["yes", "no"], kind: "agent-ask", threadKey: "claude:x", prRef: "acme/app#7", createdAt: "2026-09-26T10:00:00.000Z", dedupeKey: "k1" },
    { id: "fq_group", title: "3 threads hit the limit", body: "", options: ["added"], kind: "limit", threadKey: "claude:y", threadKeys: ["claude:y", "claude:x"], prRef: null, createdAt: "2026-09-26T10:01:00.000Z" },
    { id: "fq_other", title: "Other", body: "", options: ["ok"], kind: "agent-ask", threadKey: "codex:t1", prRef: null, createdAt: "2026-09-26T10:02:00.000Z" }
  ];
  const tools = registry(fakeSupervisor({ snapshot: { at: "2026-09-26T11:00:00.000Z", threads: [row(), target], sourceErrors: {} }, questions }));
  const { ok, result } = await tools.invoke("fleet_thread", { key: " claude:x " });
  assert.equal(ok, true);
  assert.equal(result.scannedAt, "2026-09-26T11:00:00.000Z");
  assert.equal(result.thread.key, "claude:x");
  assert.equal(result.thread.health, "red");
  assert.equal(result.thread.lastAgentText, "Pushed the fix. CI is running.");
  assert.deepEqual(result.thread.blockers, ["CI red: verification"]);
  assert.equal(result.thread.decision.playbook, "ci-red");
  assert.deepEqual(result.thread.pr.ci.failing, ["verification"]);
  assert.deepEqual(result.questions.map((q) => q.id), ["fq_own", "fq_group"]);
  assert.deepEqual(Object.keys(result.questions[0]).sort(), ["body", "createdAt", "id", "kind", "options", "prRef", "title"]);
});

test("fleet_thread refuses an unknown or missing key with a clear error", async () => {
  const tools = registry(fakeSupervisor({ snapshot: { at: "x", threads: [row()], sourceErrors: {} } }));
  const unknown = await tools.invoke("fleet_thread", { key: "codex:nope" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /No fleet thread with key "codex:nope"\. Call fleet_status/);
  const missing = await tools.invoke("fleet_thread", {});
  assert.equal(missing.ok, false);
  assert.match(missing.error, /Pass a thread key from fleet_status/);
  const noScan = registry(fakeSupervisor({ snapshot: null }));
  assert.match((await noScan.invoke("fleet_thread", { key: "codex:t1" })).error, /No fleet thread/);
});

test("a supervisor that cannot read its state fails without leaking the cause", async () => {
  const tools = registry({ getState() { throw new Error("EACCES: /Users/secret/.openagi/fleet/state.json"); } });
  for (const [name, args] of [["fleet_status", {}], ["fleet_thread", { key: "codex:t1" }]]) {
    const outcome = await tools.invoke(name, args);
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /Fleet supervisor state is unavailable/);
    assert.doesNotMatch(outcome.error, /secret/);
  }
});

test("the runtime registers the fleet tools against its own fleet supervisor", async () => {
  const supervisor = fakeSupervisor({ snapshot: { at: "x", threads: [row()], sourceErrors: {} } });
  const runtime = createDefaultRuntime({ fleetSupervisor: supervisor });
  assert.equal(runtime.fleetSupervisor, supervisor);
  const { ok, result } = await runtime.tools.invoke("fleet_thread", { key: "codex:t1" });
  assert.equal(ok, true);
  assert.equal(result.thread.key, "codex:t1");
  assert.equal(runtime.tools.get("fleet_status").sideEffects, false);
});

test("the send and answer tools need approval and pin the exact target", async () => {
  const sent = [];
  const answered = [];
  const supervisor = {
    ...fakeSupervisor({
      snapshot: { at: "2026-09-26T11:00:00.000Z", counts: {}, threads: [row({ workspace: "apia" })], infra: {}, sourceErrors: {} },
      questions: [{ id: "fq_1", title: "Which plan?", options: ["Starter", "Business", "dismiss"], threadKey: "codex:t1" }]
    }),
    sendOwnerMessage: async (key, message) => { sent.push([key, message]); return { delivery: { status: "sent", route: "computer-use", detail: "typed into Codex" } }; },
    answerQuestion: async (id, answer) => { answered.push([id, answer]); return { question: { status: "answered" }, delivery: { status: "sent", route: "computer-use", detail: "typed into Codex" } }; }
  };
  const tools = registry(supervisor);
  const send = tools.get("fleet_send_message");
  const answer = tools.get("fleet_answer_question");
  assert.equal(send.needsConfirmation, true);
  assert.equal(answer.needsConfirmation, true);
  const target = send.prepareApprovalArgs({ key: "codex:t1", message: "  Rebase on main and push.  " });
  assert.deepEqual(target, { key: "codex:t1", message: "Rebase on main and push.", name: "apia" });
  assert.match(send.summarize(target), /Send to apia \(codex:t1\):\nRebase on main and push\./);
  assert.throws(() => send.prepareApprovalArgs({ key: "codex:nope", message: "hi" }), /No fleet thread/);
  await assert.rejects(send.handler(target, {}), /approval/);
  assert.deepEqual(await send.handler(target, { __confirmed: true }), { status: "sent", route: "computer-use", detail: "typed into Codex" });
  assert.deepEqual(sent, [["codex:t1", "Rebase on main and push."]]);
  assert.throws(() => answer.prepareApprovalArgs({ questionId: "fq_1", answer: "Enterprise" }), /one of: Starter, Business/);
  const pinned = answer.prepareApprovalArgs({ questionId: "fq_1", answer: "Business" });
  assert.equal((await answer.handler(pinned, { __confirmed: true })).questionStatus, "answered");
  assert.deepEqual(answered, [["fq_1", "Business"]]);
  supervisor.sendOwnerMessage = async () => ({ delivery: { status: "blocked", detail: "owner using Codex" } });
  await assert.rejects(tools.get("fleet_send_message").handler(target, { __confirmed: true }), /Not delivered \(blocked\): owner using Codex/);
});
