// Bounded means bounded: specialists get a scope-matched tool allowlist at
// spawn (not the whole generalist toolset), the allowlist is enforced at
// invoke time, and routing learns from outcome quality.
import assert from "node:assert/strict";
import test from "node:test";
import { PropagationController, ToolRegistry } from "../src/index.js";
import { selectScopedTools } from "../src/propagation-controller.js";
import { SpecialistRouter } from "../src/specialist-router.js";
import { AgentHost } from "../src/agent-host.js";

const MCP_TOOLS = [
  { name: "calendar_list_events", description: "List events on the user's calendar" },
  { name: "calendar_create_event", description: "Create a calendar event" },
  { name: "stripe_refund_charge", description: "Refund a Stripe payment charge" },
  { name: "github_merge_pr", description: "Merge a GitHub pull request" }
];

test("selectScopedTools keeps scope-matched tools and drops unrelated ones", () => {
  const names = selectScopedTools(MCP_TOOLS, "handle calendar scheduling conflicts and recurring meeting events");
  assert.ok(names.includes("calendar_list_events"));
  assert.ok(names.includes("calendar_create_event"));
  assert.ok(!names.includes("stripe_refund_charge"), "payment tool has no place in a calendar scope");
  assert.ok(!names.includes("github_merge_pr"));
});

test("propagate() assigns a scoped allowlist, not every tool that existed at spawn", () => {
  const controller = new PropagationController();
  const { specialist } = controller.propagate({
    signal: {
      summary: "schedule and reschedule calendar meetings",
      content: "the user keeps manually resolving calendar event conflicts",
      repetition: 0.9,
      domain: "general",
      taskType: "specialization-candidate"
    },
    workflow: { id: "w", goal: "calendar conflict handling" },
    scrutiny: { reasons: [] },
    tools: MCP_TOOLS
  });
  assert.ok(specialist.allowedTools.includes("calendar_create_event"));
  assert.ok(!specialist.allowedTools.includes("stripe_refund_charge"));
  assert.ok(specialist.allowedTools.length < MCP_TOOLS.length);
});

test("invoke() enforces the specialist allowlist", async () => {
  const registry = new ToolRegistry();
  const ran = [];
  for (const name of ["recall", "calendar_create_event", "stripe_refund_charge"]) {
    registry.register({ name, handler: async () => { ran.push(name); return { ok: 1 }; } });
  }
  const ctx = { __allowedTools: ["recall", "calendar_create_event"] };

  assert.equal((await registry.invoke("recall", {}, ctx)).ok, true);
  assert.equal((await registry.invoke("calendar_create_event", {}, ctx)).ok, true);

  const blocked = await registry.invoke("stripe_refund_charge", {}, ctx);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /outside this specialist's bounded scope/);
  assert.ok(!ran.includes("stripe_refund_charge"), "handler must not run");
});

test("a specialist turn sees only core + scoped tools, with the allowlist enforced in context", async () => {
  const registry = new ToolRegistry();
  for (const name of ["recall", "remember", "list_tasks", "agent_pick_next", "complete_task", "move_task", "save_draft", "calendar_create_event", "stripe_refund_charge", "send_message"]) {
    registry.register({ name, handler: async () => ({}) });
  }
  const captured = {};
  const runtime = {
    tools: registry,
    memory: { remember: () => ({ id: "m1" }) },
    outcomes: null,
    processSignal: () => ({
      id: "out_1",
      scrutiny: { action: "act", score: 0.6, reasons: [], dimensions: { novelty: 0.4, risk: 0.3, repetition: 0.3 } },
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
        return { text: "ok", provider: "stub", model: "stub", id: "r1", toolCalls: [] };
      }
    }
  });

  const specialist = {
    id: "agent_cal",
    name: "calendar-conflicts",
    boundedScope: "handle calendar scheduling conflicts",
    parentGoal: "calendar",
    successMetric: "fewer conflicts",
    allowedTools: ["calendar_create_event"]
  };
  host.ensureSpecialistAgent(specialist, "main");

  await host.handleMessage({ text: "resolve the 3pm overlap", channel: "local", from: "u", agentId: "agent_cal", routeTo: false });

  const names = captured.tools.map((t) => t.name);
  assert.ok(names.includes("calendar_create_event"), "scoped tool present");
  assert.ok(names.includes("recall"), "core tool present");
  assert.ok(!names.includes("stripe_refund_charge"), "unscoped tool hidden");
  assert.ok(!names.includes("send_message"), "non-core internal tool hidden");
  assert.ok(Array.isArray(captured.context.__allowedTools), "enforcement allowlist passed to invoke context");
  assert.ok(captured.context.__allowedTools.includes("calendar_create_event"));
  assert.ok(!captured.context.__allowedTools.includes("stripe_refund_charge"));
});

test("the main agent's tools are not filtered", async () => {
  const registry = new ToolRegistry();
  for (const name of ["recall", "send_message"]) registry.register({ name, handler: async () => ({}) });
  const captured = {};
  const runtime = {
    tools: registry,
    memory: { remember: () => ({ id: "m1" }) },
    outcomes: null,
    processSignal: () => ({
      id: "out_1",
      scrutiny: { action: "act", score: 0.6, reasons: [], dimensions: { novelty: 0.4, risk: 0.3, repetition: 0.3 } },
      customContext: [],
      propagation: { created: false }
    })
  };
  const host = new AgentHost({
    runtime,
    modelProvider: {
      isConfigured: () => true,
      model: "stub",
      generate: async (args) => { captured.tools = args.tools; captured.context = args.context; return { text: "ok", provider: "stub", model: "stub", id: "r1", toolCalls: [] }; }
    }
  });
  await host.handleMessage({ text: "hi", channel: "local", from: "u" });
  assert.equal(captured.tools.length, 2);
  assert.equal(captured.context.__allowedTools, null);
});

test("routing learns from outcome quality: struggling specialists repel work", async () => {
  // Partial text match + no tag match, so scores sit below the 1.0 clamp and
  // the quality term can actually separate the candidates.
  const base = {
    boundedScope: "triage calendar scheduling conflicts for meetings",
    name: "calendar-conflicts",
    parentGoal: "calendar",
    status: "available",
    activationCount: 5,
    lastActivatedAt: new Date().toISOString(),
    metadata: {}
  };
  const good = { ...base, id: "sp_good", meanOutcomeQuality: 0.9, outcomeSamples: 10 };
  const bad = { ...base, id: "sp_bad", meanOutcomeQuality: 0.15, outcomeSamples: 10 };
  const fresh = { ...base, id: "sp_fresh", meanOutcomeQuality: 0.1, outcomeSamples: 1 };

  const router = new SpecialistRouter({ threshold: 0.99, mode: "live" });
  const results = await router.search("can you help me sort out my overlapping calendar events this week", [], [good, bad, fresh]);
  const score = (id) => results.find((r) => r.specialist.id === id).score;

  assert.ok(score("sp_good") > score("sp_bad"), "quality separates otherwise-identical specialists");
  assert.equal(results.find((r) => r.specialist.id === "sp_fresh").breakdown.qualityAdjust, 0, "no penalty before 3 samples");
  assert.ok(results.find((r) => r.specialist.id === "sp_good").breakdown.qualityAdjust > 0);
  assert.ok(results.find((r) => r.specialist.id === "sp_bad").breakdown.qualityAdjust < 0);
});
