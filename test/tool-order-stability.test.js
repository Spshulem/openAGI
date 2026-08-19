import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tool-registry.js";

// The advertised tool array is the largest static block in every model request
// (~67k tokens on a live install), so it is the bulk of what prompt caching can
// serve. Caching requires an EXACT prefix match, and the registry is backed by a
// Map — insertion order is the order MCP servers happened to finish connecting.
// When that leaked into the serialized tool list, the prefix changed between
// restarts and the install ran at a 0% cache hit rate on tens of millions of
// input tokens a day. These tests pin the ordering guarantee that fixes it.

const makeSpecs = (n) =>
  Array.from({ length: n }, (_, i) => ({
    name: `tool_${String(i).padStart(3, "0")}`,
    description: `Operation ${i}.`,
    parameters: { type: "object", properties: { q: { type: "string" } } },
    handler: async () => ({ ok: true }),
    source: i % 3 === 0 ? "core" : "mcp",
    metadata: { server: `srv_${i % 5}` }
  }));

const registerIn = (order, specs) => {
  const registry = new ToolRegistry();
  for (const i of order) registry.register(specs[i]);
  return registry;
};

test("advertised tool order does not depend on registration order", () => {
  const specs = makeSpecs(30);
  const forward = [...specs.keys()];
  const reversed = [...forward].reverse();
  const interleaved = [...forward.filter((i) => i % 2), ...forward.filter((i) => !(i % 2))];

  const a = JSON.stringify(registerIn(forward, specs).toOpenAITools());
  const b = JSON.stringify(registerIn(reversed, specs).toOpenAITools());
  const c = JSON.stringify(registerIn(interleaved, specs).toOpenAITools());

  assert.equal(a, b, "reversed registration must serialize identically");
  assert.equal(b, c, "interleaved registration must serialize identically");
});

test("advertised tools are sorted by name", () => {
  const specs = makeSpecs(20);
  const names = registerIn([...specs.keys()].reverse(), specs).toOpenAITools().map((t) => t.name);
  const sorted = [...names].sort((x, y) => x.localeCompare(y, "en"));
  assert.deepEqual(names, sorted);
});

test("ordering stays stable when the tool cap is active", () => {
  const previous = process.env.OPENAGI_MAX_MODEL_TOOLS;
  process.env.OPENAGI_MAX_MODEL_TOOLS = "12";
  try {
    const specs = makeSpecs(40);
    const forward = [...specs.keys()];
    const a = JSON.stringify(registerIn(forward, specs).toOpenAITools());
    const b = JSON.stringify(registerIn([...forward].reverse(), specs).toOpenAITools());
    // The cap picks whole MCP servers smallest-first; equal-sized servers used to
    // be ordered by Map insertion, which is exactly the nondeterminism at issue.
    assert.equal(a, b, "capped selection must not depend on registration order");
    assert.ok(JSON.parse(a).length <= 40);
  } finally {
    if (previous === undefined) delete process.env.OPENAGI_MAX_MODEL_TOOLS;
    else process.env.OPENAGI_MAX_MODEL_TOOLS = previous;
  }
});

test("the Anthropic tool view gets the same ordering guarantee", () => {
  const specs = makeSpecs(24);
  const forward = [...specs.keys()];
  const a = JSON.stringify(registerIn(forward, specs).toAnthropicTools());
  const b = JSON.stringify(registerIn([...forward].reverse(), specs).toAnthropicTools());
  assert.equal(a, b);
});
