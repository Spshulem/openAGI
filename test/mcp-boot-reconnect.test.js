// test/mcp-boot-reconnect.test.js
// The daemon reconnects MCP servers on boot, but must do so SILENTLY — an
// OAuth server without a cached token has to fail fast (no browser), leaving
// it "idle" with a Connect button, never blocking startup.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { McpOAuthClient } from "../src/mcp-oauth.js";
import { McpRegistry } from "../src/mcp-registry.js";

const tmp = path.join(os.tmpdir(), `openagi-boot-test-${process.pid}`);

test("ensureToken({interactive:false}) fails fast instead of opening a browser", async () => {
  const client = new McpOAuthClient({ resourceUrl: "https://example.test", dataDir: tmp });
  await assert.rejects(
    () => client.ensureToken({ interactive: false }),
    (e) => e.code === "OAUTH_INTERACTIVE_REQUIRED",
    "must throw the typed interactive-required error, not call authorize()"
  );
});

test("connectAll({silent:true}) leaves an un-authorized OAuth server idle without prompting", async () => {
  const reg = new McpRegistry({ dataDir: tmp, configPath: null });
  reg.registerServer({ name: "rize", url: "https://mcp.rize.io/sse", auth: "oauth", trustLevel: "trusted" });

  // If silent mode were broken, this would hang on a 5-min browser callback.
  const results = await reg.connectAll({ silent: true });
  const rize = results.find((r) => r.name === "rize");
  assert.equal(rize.ok, false);
  assert.equal(rize.code, "OAUTH_INTERACTIVE_REQUIRED");

  // And it must not report as connected.
  const server = reg.listServers().find((s) => s.name === "rize");
  assert.equal(server.connected, false);
});
