// Scrutiny verdicts have consequences: act/ask/watch/ignore produce different
// tool access, not just a prompt hint. The tool-policy primitive lives in
// ToolRegistry (sideEffects flag + filtered listing + invoke-time gates).
import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry, createDefaultRuntime } from "../src/index.js";
import { AgentHost } from "../src/agent-host.js";

function makeRegistry() {
  const calls = [];
  const registry = new ToolRegistry();
  registry.register({
    name: "lookup_thing",
    sideEffects: false,
    handler: async () => { calls.push("lookup_thing"); return { found: true }; }
  });
  registry.register({
    name: "send_thing",
    handler: async () => { calls.push("send_thing"); return { sent: true }; }
  });
  return { registry, calls };
}

test("sideEffects defaults to true; read-only listing filters", () => {
  const { registry } = makeRegistry();
  assert.equal(registry.get("send_thing").sideEffects, true);
  assert.equal(registry.get("lookup_thing").sideEffects, false);

  assert.deepEqual(registry.list({ readOnly: true }).map((t) => t.name), ["lookup_thing"]);
  assert.deepEqual(registry.toOpenAITools({ readOnly: true }).map((t) => t.name), ["lookup_thing"]);
  assert.equal(registry.toOpenAITools().length, 2, "unfiltered listing unchanged");
});

test("watch policy: invoke hard-blocks side-effecting tools, allows read-only", async () => {
  const { registry, calls } = makeRegistry();
  const ctx = { __scrutinyPolicy: "read-only" };

  const blocked = await registry.invoke("send_thing", {}, ctx);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /watch.*read-only/i);
  assert.ok(!calls.includes("send_thing"), "handler must not run");

  const allowed = await registry.invoke("lookup_thing", {}, ctx);
  assert.equal(allowed.ok, true);
  assert.deepEqual(allowed.result, { found: true });
});

test("ask policy: side-effecting calls divert to the approval queue; read-only runs; approval bypasses", async () => {
  const { registry, calls } = makeRegistry();
  const queued = [];
  registry.bindPendingActions({ enqueue: (a) => { queued.push(a); return { id: "act_1", summary: a.summary }; } });
  const ctx = { __scrutinyPolicy: "confirm", __reason: "scrutiny verdict 'ask' (score 0.42)" };

  const diverted = await registry.invoke("send_thing", {}, ctx);
  assert.equal(diverted.ok, true);
  assert.equal(diverted.result.status, "awaiting_confirmation");
  assert.equal(queued.length, 1);
  assert.equal(queued[0].reason, "scrutiny verdict 'ask' (score 0.42)");
  assert.ok(!calls.includes("send_thing"));

  const readOnly = await registry.invoke("lookup_thing", {}, ctx);
  assert.equal(readOnly.ok, true);
  assert.deepEqual(readOnly.result, { found: true });

  // The approve endpoint re-invokes with __confirmed — must execute directly.
  const approved = await registry.invoke("send_thing", {}, { ...ctx, __confirmed: true });
  assert.equal(approved.ok, true);
  assert.deepEqual(approved.result, { sent: true });
});

test("core read-only tools are flagged; mutating tools are not", () => {
  const runtime = createDefaultRuntime();
  const reg = runtime.tools;
  for (const name of ["recall", "list_tasks", "list_sessions", "get_budget", "daily_plan", "daily_recap"]) {
    assert.equal(reg.get(name)?.sideEffects, false, `${name} should be read-only`);
  }
  for (const name of ["remember", "add_task", "schedule_message", "send_message", "run_mcp_tool"]) {
    assert.equal(reg.get(name)?.sideEffects, true, `${name} should be side-effecting`);
  }
});

// Minimal AgentHost harness with a stubbed processSignal so we can force each
// verdict, and a capturing model provider so we can see what tools + context
// the model actually receives.
function makeHost(verdict) {
  const captured = {};
  const { registry } = makeRegistry();
  const runtime = {
    tools: registry,
    memory: { remember: () => ({ id: "m1" }) },
    outcomes: null,
    processSignal: () => ({
      id: "out_1",
      scrutiny: { action: verdict, score: 0.42, reasons: ["stub"], dimensions: { novelty: 0.4, risk: 0.3, repetition: 0.3 } },
      customContext: [],
      propagation: { created: false }
    })
  };
  const host = new AgentHost({
    runtime,
    modelProvider: {
      isConfigured: () => true,
      model: "stub",
      generate: async (args) => {
        captured.tools = args.tools;
        captured.context = args.context;
        captured.instructions = args.instructions;
        return { text: "ok", provider: "stub", model: "stub", id: "r1", toolCalls: [] };
      }
    }
  });
  return { host, captured };
}

test("agent turn under each verdict gets the right tools + enforcement context", async () => {
  const expectations = [
    { verdict: "act", toolNames: ["lookup_thing", "send_thing"], policy: null },
    { verdict: "ask", toolNames: ["lookup_thing", "send_thing"], policy: "confirm" },
    { verdict: "watch", toolNames: ["lookup_thing"], policy: "read-only" },
    { verdict: "ignore", toolNames: [], policy: "none" }
  ];
  for (const { verdict, toolNames, policy } of expectations) {
    const { host, captured } = makeHost(verdict);
    const result = await host.handleMessage({ text: "hello there", channel: "local", from: "u" });
    assert.equal(result.reply, "ok", `${verdict}: user always gets a reply`);
    assert.deepEqual((captured.tools ?? []).map((t) => t.name).sort(), toolNames.sort(), `${verdict}: tool list`);
    assert.equal(captured.context.__scrutinyPolicy, policy, `${verdict}: enforcement policy`);
    if (verdict !== "act" && verdict !== "propagate" && verdict !== "ignore") {
      assert.match(captured.instructions, /This turn:/, `${verdict}: instructions explain the gate`);
    }
  }
});

test("processSignal: 'ignore' skips the memory write and emits an audit event", () => {
  const runtime = createDefaultRuntime();
  const emitted = [];
  runtime.events = { emit: (name, payload) => emitted.push({ name, payload }) };
  runtime.scrutiny = { evaluate: () => ({ action: "ignore", score: 0.1, reasons: ["noise"], dimensions: {} }) };

  const before = runtime.memory.items.size;
  const output = runtime.processSignal({
    id: "sig_noise",
    source: "test",
    type: "event",
    domain: "general",
    taskType: "adaptation-review",
    summary: "low-signal noise",
    content: "nothing to see",
    tags: [],
    novelty: 0.1, repetition: 0.1, risk: 0.1, urgency: 0.1, impact: 0.1,
    confidence: 0.5, specificity: 0.2, ambiguity: 0.5, conflict: 0,
    goalAlignment: 0.5, strategicFit: 0.5, externalPressure: 0.3, internalPressure: 0.3
  });

  assert.equal(output.memory, null, "ignored signals are not committed to memory");
  assert.equal(runtime.memory.items.size, before, "memory count unchanged");
  assert.ok(emitted.some((e) => e.name === "signal-ignored" && e.payload.signalId === "sig_noise"));
});

test("'none' policy (ignore verdict) hard-blocks EVERY tool at invoke, even read-only", async () => {
  const { ToolRegistry } = await import("../src/index.js");
  const reg = new ToolRegistry();
  const ran = [];
  reg.register({ name: "lookup", sideEffects: false, handler: async () => { ran.push("lookup"); return {}; } });
  reg.register({ name: "send", handler: async () => { ran.push("send"); return {}; } });
  const ctx = { __scrutinyPolicy: "none" };
  for (const name of ["lookup", "send"]) {
    const r = await reg.invoke(name, {}, ctx);
    assert.equal(r.ok, false, `${name} must be blocked under 'none'`);
    assert.match(r.error, /ignore.*permits no tools/i);
  }
  assert.equal(ran.length, 0, "no handler runs under an ignore verdict — even read-only");
});
