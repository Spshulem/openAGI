// test/mcp-boot-reconnect.test.js
// The daemon reconnects MCP servers on boot, but must do so SILENTLY — an
// OAuth server without a cached token has to fail fast (no browser), leaving
// it "idle" with a Connect button, never blocking startup.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { McpOAuthClient } from "../src/mcp-oauth.js";
import { McpRegistry } from "../src/mcp-registry.js";

const tmp = path.join(os.tmpdir(), `openagi-boot-test-${process.pid}`);

function writeTokenCache(name, cache) {
  const dir = path.join(tmp, "mcp", "auth");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(cache));
}

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

test("hasOAuthToken reflects a SILENTLY USABLE cached token on disk", () => {
  const reg = new McpRegistry({ dataDir: tmp, configPath: null });
  assert.equal(reg.hasOAuthToken("nope-no-cache"), false);
  // A refresh token can always mint a new access token silently.
  writeTokenCache("hbtrefresh", { refresh_token: "r" });
  assert.equal(reg.hasOAuthToken("hbtrefresh"), true);
  // A live access token (unexpired) counts.
  writeTokenCache("hbtlive", { access_token: "a", expires_at: Date.now() + 600_000 });
  assert.equal(reg.hasOAuthToken("hbtlive"), true);
  // An expired (or unknown-expiry) access token with no refresh token does NOT:
  // silentTokenFor() can't use it, so reporting "configured" would ack webhooks
  // and then silently drop them.
  writeTokenCache("hbtexpired", { access_token: "a", expires_at: Date.now() - 1000 });
  assert.equal(reg.hasOAuthToken("hbtexpired"), false);
  writeTokenCache("hbtcache", { access_token: "a" });
  assert.equal(reg.hasOAuthToken("hbtcache"), false);
});

test("silentTokenFor returns a cached, unexpired token without a browser", async () => {
  const reg = new McpRegistry({ dataDir: tmp, configPath: null });
  reg.registerServer({ name: "bb", url: "https://mcp.buildbetter.app/sse", auth: "oauth", trustLevel: "trusted" });
  writeTokenCache("bb", { access_token: "live-token", expires_at: Date.now() + 600_000 });
  assert.equal(await reg.silentTokenFor("bb"), "live-token");
});

test("silentTokenFor returns null for an un-authorized / unknown server (never prompts)", async () => {
  const reg = new McpRegistry({ dataDir: tmp, configPath: null });
  reg.registerServer({ name: "bb2", url: "https://mcp.buildbetter.app/sse", auth: "oauth", trustLevel: "trusted" });
  assert.equal(await reg.silentTokenFor("bb2"), null);   // registered, no token cached
  assert.equal(await reg.silentTokenFor("ghost"), null); // not registered at all
});

test("an interactive connect is not swallowed by an in-flight silent connect", async () => {
  const reg = new McpRegistry({ dataDir: tmp, configPath: null });
  reg.registerServer({ name: "x", url: "https://mcp.x.test/sse", auth: "oauth", trustLevel: "trusted" });
  const calls = [];
  reg.doConnect = async (_name, { silent }) => {
    calls.push(silent);
    if (silent) { const e = new Error("need browser"); e.code = "OAUTH_INTERACTIVE_REQUIRED"; throw e; }
    return { connected: true };
  };
  // Silent boot attempt in-flight, then a user clicks Connect (interactive).
  const silentP = reg.connect("x", { silent: true });
  const interactiveP = reg.connect("x", { silent: false });
  const [silentR, interactiveR] = await Promise.allSettled([silentP, interactiveP]);
  assert.equal(silentR.status, "rejected", "silent attempt fails fast");
  assert.equal(interactiveR.status, "fulfilled", "interactive attempt still runs");
  assert.deepEqual(interactiveR.value, { connected: true });
  assert.deepEqual(calls, [true, false], "both attempts ran; interactive was not handed the silent failure");
});
