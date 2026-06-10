// BuildBetter endpoints are env-overridable for staging environments:
// BUILDBETTER_API_URL (GraphQL), BUILDBETTER_APP_URL (deep links),
// BUILDBETTER_MCP_URL (MCP server in the catalog). All read live.
import assert from "node:assert/strict";
import test from "node:test";
import { BuildBetterTaskSource } from "../src/integrations/buildbetter-tasks.js";
import { MCP_CATALOG } from "../src/mcp-catalog.js";

// async-aware: `await fn()` so the env stays overridden for the whole async
// body, not just until the first suspension point.
async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test("BUILDBETTER_API_URL routes GraphQL queries to staging", async () => {
  await withEnv({ BUILDBETTER_API_URL: "https://api.staging.buildbetter.app/v1/graphql" }, async () => {
    const fetched = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => { fetched.push(String(url)); return { ok: true, json: async () => ({ data: {} }) }; };
    try {
      const source = new BuildBetterTaskSource({ runtime: {}, apiKey: "bb_test" });
      await source.query("query { __typename }");
      assert.equal(fetched[0], "https://api.staging.buildbetter.app/v1/graphql");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

test("BUILDBETTER_MCP_URL overrides the catalog register URL, read lazily", async () => {
  const entry = MCP_CATALOG.find((e) => e.id === "buildbetter");
  assert.equal(entry.register.url, "https://mcp.buildbetter.app/sse", "prod default");
  await withEnv({ BUILDBETTER_MCP_URL: "https://mcp.staging.buildbetter.app/sse" }, () => {
    assert.equal(entry.register.url, "https://mcp.staging.buildbetter.app/sse", "env read at access time, not import time");
  });
  assert.equal(entry.register.url, "https://mcp.buildbetter.app/sse", "back to default after env cleared");
});

test("catalog register spread captures the overridden URL", async () => {
  await withEnv({ BUILDBETTER_MCP_URL: "https://mcp.staging.buildbetter.app/sse" }, () => {
    const entry = MCP_CATALOG.find((e) => e.id === "buildbetter");
    // mcp-registry does `{ name, ...entry.register }` — the spread must
    // capture the staging value.
    const spec = { name: "buildbetter", ...entry.register };
    assert.equal(spec.url, "https://mcp.staging.buildbetter.app/sse");
    assert.equal(spec.transport, "http");
  });
});
