// test/web-search-providers.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS } from "../src/integrations/web-search-providers.js";

function withMockFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = real; });
}
const jsonResponse = (obj) => ({ ok: true, status: 200, json: async () => obj });

test("exa adapter maps results", async () => {
  const exa = PROVIDERS.find((p) => p.name === "exa");
  await withMockFetch(async (url, init) => {
    assert.equal(url, "https://api.exa.ai/search");
    assert.equal(JSON.parse(init.body).query, "claude api");
    return jsonResponse({ results: [{ title: "Docs", url: "https://x", text: "body", publishedDate: "2026-01-01" }] });
  }, async () => {
    const out = await exa.search("claude api", { numResults: 3, apiKey: "k" });
    assert.equal(out[0].title, "Docs");
    assert.equal(out[0].url, "https://x");
    assert.equal(out[0].content, "body");
  });
});

test("tavily adapter maps results", async () => {
  const tav = PROVIDERS.find((p) => p.name === "tavily");
  await withMockFetch(async (url) => {
    assert.equal(url, "https://api.tavily.com/search");
    return jsonResponse({ results: [{ title: "T", url: "https://t", content: "snip" }] });
  }, async () => {
    const out = await tav.search("q", { apiKey: "k" });
    assert.equal(out[0].snippet, "snip");
  });
});

test("firecrawl maps the v2 data[] array shape and fetch() returns markdown", async () => {
  const fc = PROVIDERS.find((p) => p.name === "firecrawl");
  await withMockFetch(async (url) => {
    assert.equal(url, "https://api.firecrawl.dev/v2/search");
    return jsonResponse({ data: [{ title: "F", url: "https://f", description: "desc", markdown: "# body" }] });
  }, async () => {
    const out = await fc.search("q", { apiKey: "k" });
    assert.equal(out[0].title, "F");
    assert.equal(out[0].snippet, "desc");
    assert.equal(out[0].content, "# body");
  });
  await withMockFetch(async (url) => {
    assert.equal(url, "https://api.firecrawl.dev/v2/scrape");
    return jsonResponse({ data: { markdown: "# page" } });
  }, async () => {
    const md = await fc.fetch("https://f", { apiKey: "k" });
    assert.equal(md, "# page");
  });
});

test("brave maps web.results[] and uses page_age for publishedDate", async () => {
  const br = PROVIDERS.find((p) => p.name === "brave");
  await withMockFetch(async (url) => {
    assert.match(url, /^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?q=/);
    return jsonResponse({ web: { results: [{ title: "B", url: "https://b", description: "d", page_age: "2026-01-02T00:00:00Z", age: "3 days ago" }] } });
  }, async () => {
    const out = await br.search("q", { apiKey: "k" });
    assert.equal(out[0].title, "B");
    assert.equal(out[0].snippet, "d");
    assert.equal(out[0].publishedDate, "2026-01-02T00:00:00Z");
  });
});

test("perplexity returns the answer plus citation rows", async () => {
  const px = PROVIDERS.find((p) => p.name === "perplexity");
  await withMockFetch(async (url) => {
    assert.equal(url, "https://api.perplexity.ai/chat/completions");
    return jsonResponse({ choices: [{ message: { content: "the answer" } }], citations: ["https://c1", "https://c2"] });
  }, async () => {
    const out = await px.search("q", { apiKey: "k", numResults: 5 });
    assert.equal(out[0].title, "Perplexity answer");
    assert.equal(out[0].content, "the answer");
    assert.equal(out[1].url, "https://c1");
  });
});

test("serpapi maps organic_results[] (link -> url)", async () => {
  const sp = PROVIDERS.find((p) => p.name === "serpapi");
  const prev = process.env.SERPAPI_API_KEY;
  process.env.SERPAPI_API_KEY = "serp-key";
  try {
    await withMockFetch(async (url) => {
      assert.match(url, /^https:\/\/serpapi\.com\/search\.json\?engine=google/);
      return jsonResponse({ organic_results: [{ title: "S", link: "https://s", snippet: "sn" }] });
    }, async () => {
      const out = await sp.search("q");
      assert.equal(out[0].url, "https://s");
      assert.equal(out[0].snippet, "sn");
    });
  } finally {
    if (prev !== undefined) process.env.SERPAPI_API_KEY = prev; else delete process.env.SERPAPI_API_KEY;
  }
});

test("serpapi error does NOT leak the api key", async () => {
  const sp = PROVIDERS.find((p) => p.name === "serpapi");
  const prev = process.env.SERPAPI_API_KEY;
  process.env.SERPAPI_API_KEY = "super-secret-key";
  try {
    await withMockFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }), async () => {
      await assert.rejects(
        () => sp.search("q"),
        (err) => {
          assert.ok(!err.message.includes("super-secret-key"), "error message must not contain the api key");
          assert.match(err.message, /\[REDACTED\]/);
          return true;
        }
      );
    });
  } finally {
    if (prev !== undefined) process.env.SERPAPI_API_KEY = prev; else delete process.env.SERPAPI_API_KEY;
  }
});
