import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tool-registry.js";
import { AgentHost } from "../src/agent-host.js";
import { registerSubagentTools } from "../src/subagent-tools.js";

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
    assert.equal((await registry.invoke("web_search", {}, args.context)).ok, true);
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
