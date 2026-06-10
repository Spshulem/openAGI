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

test("web_search honors WEB_SEARCH_PROVIDER as the default and doesn't double-try it", async () => {
  const calls = [];
  const tools = new ToolRegistry();
  registerWebSearchTools({ tools }, {
    providers: [
      fakeProvider("exa", async () => { calls.push("exa"); throw new Error("exa down"); }),
      fakeProvider("tavily", async () => { calls.push("tavily"); throw new Error("tavily down"); }),
      fakeProvider("brave", async () => { calls.push("brave"); return [{ title: "B", url: "u", snippet: "s" }]; })
    ]
  });
  const prev = process.env.WEB_SEARCH_PROVIDER;
  process.env.WEB_SEARCH_PROVIDER = "tavily";
  try {
    const { result } = await tools.invoke("web_search", { query: "hi" });
    // tavily is tried first (env default), fails, then exa, then brave succeeds.
    assert.equal(calls[0], "tavily", "env-default provider must be tried first");
    assert.equal(result.provider, "brave");
    // tavily appears exactly once despite being both env-default and in the list.
    assert.equal(calls.filter((c) => c === "tavily").length, 1, "env default must not be tried twice");
  } finally {
    if (prev !== undefined) process.env.WEB_SEARCH_PROVIDER = prev; else delete process.env.WEB_SEARCH_PROVIDER;
  }
});

// --- fetch_url SSRF guard ---

function withFetchUrlEnv(fn) {
  // fetch_url uses the real providers; ensure Firecrawl is OFF so the plain
  // (guarded) fetch path runs, and restore global fetch + env after.
  const prevKey = process.env.FIRECRAWL_API_KEY;
  const realFetch = globalThis.fetch;
  delete process.env.FIRECRAWL_API_KEY;
  return Promise.resolve(fn(realFetch)).finally(() => {
    globalThis.fetch = realFetch;
    if (prevKey !== undefined) process.env.FIRECRAWL_API_KEY = prevKey;
  });
}

test("fetch_url blocks loopback / private / metadata hosts and non-http protocols", async () => {
  const tools = new ToolRegistry();
  registerWebSearchTools({ tools });
  await withFetchUrlEnv(async () => {
    let fetched = false;
    globalThis.fetch = async () => { fetched = true; return { ok: true, status: 200, headers: { get: () => null }, text: async () => "INTERNAL" }; };
    const blocked = [
      "http://169.254.169.254/latest/meta-data/iam/security-credentials/role",
      "http://127.0.0.1:8080/admin",
      "http://localhost/",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://[::1]/",
      "file:///etc/passwd"
    ];
    for (const url of blocked) {
      const { result } = await tools.invoke("fetch_url", { url });
      assert.ok(result.error, `expected error for ${url}`);
      assert.match(result.error, /not allowed|must be http|Invalid/i, `unexpected error for ${url}: ${result.error}`);
    }
    assert.equal(fetched, false, "global fetch must never be called for a blocked host");
  });
});

test("fetch_url allows a public host and returns stripped text", async () => {
  const tools = new ToolRegistry();
  registerWebSearchTools({ tools });
  await withFetchUrlEnv(async () => {
    globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => "<p>hello <b>world</b></p>" });
    // Literal public IP: skips safeFetch's DNS-resolution layer so this test
    // stays deterministic in network-restricted CI (no real lookup needed).
    const { result } = await tools.invoke("fetch_url", { url: "https://93.184.216.34/page" });
    assert.equal(result.error, undefined);
    assert.match(result.content, /hello\s+world/);
  });
});

test("fetch_url does not follow a redirect into an internal host", async () => {
  const tools = new ToolRegistry();
  registerWebSearchTools({ tools });
  await withFetchUrlEnv(async () => {
    globalThis.fetch = async (u) => {
      if (String(u).includes("93.184.216.34")) {
        return { ok: false, status: 302, headers: { get: (h) => (h.toLowerCase() === "location" ? "http://169.254.169.254/" : null) }, text: async () => "" };
      }
      // would only be reached if the guard failed to block the redirect target
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => "INTERNAL-SECRET" };
    };
    // Literal public IP start URL: no DNS lookup, deterministic offline.
    const { result } = await tools.invoke("fetch_url", { url: "https://93.184.216.34/redir" });
    assert.ok(result.error, "redirect into an internal host must surface an error");
    assert.ok(!JSON.stringify(result).includes("INTERNAL-SECRET"), "internal body must never be returned");
  });
});
