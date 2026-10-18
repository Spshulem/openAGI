import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tool-registry.js";
import { AgentHost } from "../src/agent-host.js";
import { registerSubagentTools } from "../src/subagent-tools.js";
import { AbiRuntime } from "../src/abi-runtime.js";
import { MemorySystem } from "../src/memory-system.js";

function fixture() {
  const registry = new ToolRegistry();
  registry.register({ name: "web_search", sideEffects: false, handler: () => ({ sources: ["https://example.com"] }) });
  registry.register({ name: "send_message", handler: () => { throw Error("must not send"); } });
  registry.register({ name: "remember", handler: () => { throw Error("must not write"); } });
  let captured;
  const runtime = { tools: registry, memory: { remember() {} },
    processSignal(signal, options) {
      assert.equal(options.allowPropagation, false);
      return { id: "output-fixture", scrutiny: { action: "act", score: 0.6, reasons: [], dimensions: { novelty: 0.4, risk: 0.3, repetition: 0.3 } }, customContext: [], propagation: { created: false } };
    }
  };
  runtime.agentHost = new AgentHost({ runtime, modelProvider: { isConfigured: () => true, async generate(args) {
    captured = args;
    assert.equal(args.context.__owner, undefined);
    assert.equal((await registry.invoke("send_message", {}, args.context)).ok, false);
    assert.equal((await registry.invoke("remember", {}, args.context)).ok, false);
    assert.equal((await registry.invoke("run_subagent", { task: "nested" }, args.context)).ok, false);
    assert.equal((await registry.invoke("web_search", {}, args.context)).ok, args.context.__allowedTools.includes("web_search"));
    return { text: "Fixture findings with a source: https://example.com", toolCalls: [] };
  } } });
  registerSubagentTools(registry, runtime);
  return { registry, runtime, get captured() { return captured; } };
}
test("explicit subagent tasks return findings, enforce read-only tools and prevent recursive delegation", async () => {
  const f = fixture();
  const result = await f.registry.invoke("run_subagent", { task: "Research a fixture option", tools: ["web_search"] }, { sessionId: "owner-fixture" });
  assert.equal(result.ok, true, result.error);
  assert.match(result.result.reply, /Fixture findings/);
  assert.deepEqual(f.captured.tools.map(tool => tool.name), ["web_search"]);
  assert.deepEqual(f.captured.context.__allowedTools, ["web_search"]);
  assert.equal(f.captured.context.__subagentDepth, 1);
});
test("subagents cannot expand parent scope, choose mutating tools, or accept unbounded tasks", async () => {
  const f = fixture();
  for (const [args, context] of [[{ task: "read", tools: ["send_message"] }, {}], [{ task: "read", tools: ["web_search"] }, { __allowedTools: [] }], [{ task: "nested" }, { __subagentDepth: 1 }], [{ task: "x".repeat(4001) }, {}]]) assert.equal((await f.registry.invoke("run_subagent", args, context)).ok, false);
});
test("bounded delegation does not read or include the owner's ambient screen context", async () => {
  const f = fixture();
  let reads = 0;
  f.runtime.observations = { async getRecentContext() {
    reads++;
    return { apps: [{ app: "Private app", n: 1 }], snippets: [{ app: "Private app", text: "PRIVATE_SCREEN_FIXTURE", at: "2026-10-18T00:00:00Z" }] };
  } };
  const result = await f.registry.invoke("run_subagent", { task: "Research the supplied public fixture", tools: ["web_search"] }, { sessionId: "owner-fixture" });
  assert.equal(result.ok, true, result.error);
  assert.equal(reads, 0);
  assert.equal(f.captured.turnContext.includes("PRIVATE_SCREEN_FIXTURE"), false);
  assert.equal(f.captured.turnContext.includes("Private app"), false);
});

test("delegation with no tools reads no owner memory or principles and creates no shared memories", async () => {
  const f = fixture();
  const memory = new MemorySystem();
  const item = memory.remember({ content: "fixture research PRIVATE_OWNER_MEMORY_FIXTURE", scope: "main" }, { strength: 0.9 });
  // Ordinary specialist retrieval deliberately includes main memory. The
  // bounded delegate must opt out rather than relying on its unique scope.
  assert.equal(memory.retrieve("fixture research", { scope: "specialist:delegate-fixture" })[0].item.id, item.id);
  let memoryReads = 0, memoryWrites = 0, vectorReads = 0;
  const retrieve = memory.retrieve.bind(memory), remember = memory.remember.bind(memory);
  memory.retrieve = (...args) => { memoryReads++; return retrieve(...args); };
  memory.remember = (...args) => { memoryWrites++; return remember(...args); };
  Object.assign(f.runtime, {
    memory,
    vectorStore: { async search() { vectorReads++; return [{ id: item.id, text: "PRIVATE_OWNER_PRINCIPLE_FIXTURE", score: 1 }]; } },
    workflows: { select: () => null },
    scrutiny: { evaluate: ({ memories }) => ({ action: "act", score: 0.6, reasons: memories.map(hit => hit.item.content), dimensions: { novelty: 0.4, risk: 0.3, repetition: 0.3 } }) },
    propagation: { shouldPropagate: () => ({ decision: false }) },
    outputs: [], feedback: [],
    processSignal: (...args) => AbiRuntime.prototype.processSignal.call(f.runtime, ...args)
  });
  const result = await f.registry.invoke("run_subagent", { task: "fixture research", tools: [] }, {});
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(f.captured.tools, []);
  assert.deepEqual(f.captured.memoryHits, []);
  assert.equal(f.captured.turnContext.includes("PRIVATE_OWNER_"), false);
  assert.equal(memoryReads, 0); assert.equal(memoryWrites, 0); assert.equal(vectorReads, 0);
  assert.equal(memory.items.size, 1);
});
