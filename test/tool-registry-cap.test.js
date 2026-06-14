// The model tool list is bounded so a few large MCP servers can't push the
// array past the provider's limit (which makes OpenAI reject EVERY call).
// Core tools are always advertised; MCP servers fill the rest, smallest first;
// overflow stays reachable via run_mcp_tool.
import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tool-registry.js";

function regCore(reg, n) {
  for (let i = 0; i < n; i++) reg.register({ name: `core_${i}`, handler: async () => ({}) });
}
function regMcp(reg, server, n) {
  for (let i = 0; i < n; i++) reg.register({ name: `mcp_${server}_${i}`, source: "mcp", metadata: { server }, handler: async () => ({}) });
}

test("under the cap, every tool is advertised", () => {
  process.env.OPENAGI_MAX_MODEL_TOOLS = "128";
  const reg = new ToolRegistry();
  regCore(reg, 20);
  regMcp(reg, "airtable", 16);
  assert.equal(reg.toOpenAITools().length, 36);
});

test("over the cap: core always kept, small MCP servers win, giant ones overflow", () => {
  process.env.OPENAGI_MAX_MODEL_TOOLS = "100";
  const reg = new ToolRegistry();
  regCore(reg, 50);
  regMcp(reg, "airtable", 16);
  regMcp(reg, "linear", 46);
  regMcp(reg, "posthog", 118);
  const names = reg.toOpenAITools().map((t) => t.name);
  // budget = 100 - 50 core = 50 → airtable(16) fits; linear(46) would be 62 > 50; posthog never.
  assert.ok(names.length <= 100, `advertised ${names.length} must be <= cap`);
  assert.ok(names.filter((n) => n.startsWith("core_")).length === 50, "all core tools kept");
  assert.ok(names.some((n) => n.startsWith("mcp_airtable_")), "small server advertised");
  assert.ok(!names.some((n) => n.startsWith("mcp_posthog_")), "giant server overflowed");
  delete process.env.OPENAGI_MAX_MODEL_TOOLS;
});
