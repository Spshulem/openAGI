// test/web-search-tools.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tool-registry.js";
import { registerWebSearchTools } from "../src/integrations/web-search.js";

function fakeProvider(name, behavior) {
  return { name, isConfigured: () => true, search: behavior };
}

test("web_search uses explicit provider and normalizes", async () => {
  const tools = new ToolRegistry();
  registerWebSearchTools({ tools }, {
    providers: [fakeProvider("exa", async () => [{ title: "A", url: "u", snippet: "s" }])]
  });
  const { result } = await tools.invoke("web_search", { query: "hi", provider: "exa" });
  assert.equal(result.provider, "exa");
  assert.equal(result.results[0].title, "A");
});

test("web_search falls back to the next configured provider on error", async () => {
  const tools = new ToolRegistry();
  registerWebSearchTools({ tools }, {
    providers: [
      fakeProvider("exa", async () => { throw new Error("boom"); }),
      fakeProvider("tavily", async () => [{ title: "B", url: "u", snippet: "s" }])
    ]
  });
  const { result } = await tools.invoke("web_search", { query: "hi" });
  assert.equal(result.provider, "tavily");
  assert.equal(result.results[0].title, "B");
});

test("web_search returns a clear error when nothing is configured", async () => {
  const tools = new ToolRegistry();
  registerWebSearchTools({ tools }, {
    providers: [{ name: "exa", isConfigured: () => false, search: async () => [] }]
  });
  const { result } = await tools.invoke("web_search", { query: "hi" });
  assert.match(result.error, /no web search provider/i);
});
