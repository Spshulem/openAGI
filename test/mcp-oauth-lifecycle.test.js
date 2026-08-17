import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpRegistry } from "../src/mcp-registry.js";
import { createDurableRuntime } from "../src/abi-runtime.js";
import { createHostedInterface } from "../src/hosted-interface.js";
import { McpOAuthClient, startCallbackServer } from "../src/mcp-oauth.js";

test("exact legacy catalog endpoints migrate while custom registrations stay untouched", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mcp-migrate-"));
  const configPath = path.join(dataDir, "mcp.json");
  fs.writeFileSync(configPath, JSON.stringify({ servers: {
    rize: { url: "https://mcp.rize.io/sse", transport: "http", auth: "oauth" },
    buildbetter: { url: "https://mcp.buildbetter.app/sse", transport: "http", auth: "oauth" },
    "custom-rize": { url: "https://mcp.rize.io/sse", transport: "http", auth: "oauth" }
  } }));
  const saved = process.env.BUILDBETTER_MCP_URL;
  delete process.env.BUILDBETTER_MCP_URL;
  try {
    const registry = new McpRegistry({ dataDir, configPath });
    registry.loadConfigFile(configPath);
    const servers = new Map(registry.listServers().map((server) => [server.name, server]));
    assert.equal(servers.get("rize").url, "https://mcp.rize.io/mcp");
    assert.equal(servers.get("buildbetter").url, "https://mcp.buildbetter.app");
    assert.equal(servers.get("custom-rize").url, "https://mcp.rize.io/sse");
    const persisted = JSON.parse(fs.readFileSync(configPath, "utf8")).servers;
    assert.equal(persisted.rize.url, "https://mcp.rize.io/mcp");
    assert.equal(persisted.buildbetter.url, "https://mcp.buildbetter.app");
    assert.equal(persisted["custom-rize"].url, "https://mcp.rize.io/sse");
  } finally {
    if (saved === undefined) delete process.env.BUILDBETTER_MCP_URL;
    else process.env.BUILDBETTER_MCP_URL = saved;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a saved token suppresses stale OAuth-required UI and Forget login removes it", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mcp-forget-"));
  const runtime = createDurableRuntime({ dataDir });
  runtime.mcp.registerServer({
    name: "rize",
    url: "https://mcp.rize.io/mcp",
    transport: "http",
    auth: "oauth",
    trustLevel: "trusted"
  });
  const authDir = path.join(dataDir, "mcp", "auth");
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, "rize.json"), JSON.stringify({
    access_token: "test-only",
    refresh_token: "test-refresh",
    expires_at: Date.now() + 600_000
  }));
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, dataDir, authToken: "" });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  try {
    runtime.mcp.onOauthRequired({ name: "rize", url: "https://example.test/authorize?state=test" });
    let response = await fetch(`${base}/mcp`);
    let server = (await response.json()).find((item) => item.name === "rize");
    assert.equal(server.authenticated, true);
    assert.equal(server.pendingAuthUrl, null, "a completed login must hide the stale auth URL");

    response = await fetch(`${base}/mcp/clear-auth/rize`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.equal(fs.existsSync(path.join(authDir, "rize.json")), false);
    server = (await (await fetch(`${base}/mcp`)).json()).find((item) => item.name === "rize");
    assert.equal(server.authenticated, false);
    assert.equal(server.connected, false);
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("disconnect invalidates an in-flight connect before it can expose tools", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mcp-cancel-"));
  let resolveConnect;
  let closeCount = 0;
  const toolRegistry = {
    tools: new Map(),
    register(tool) { this.tools.set(tool.name, tool); },
    unregister(name) { this.tools.delete(name); }
  };
  const registry = new McpRegistry({ dataDir, toolRegistry });
  registry.registerServer({ name: "race", url: "https://example.test/mcp", transport: "http", auth: "none" });
  registry.clients.set("race", {
    tools: [{ name: "late", description: "must never register" }],
    connect: () => new Promise((resolve) => { resolveConnect = resolve; }),
    close: async () => { closeCount += 1; },
    status: () => ({ connected: true, tools: ["late"] })
  });

  try {
    const attempt = registry.connect("race");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(registry.isConnecting("race"), true);
    await registry.disconnect("race");
    assert.equal(registry.isConnecting("race"), false);
    resolveConnect();
    await assert.rejects(attempt, (error) => error?.code === "MCP_CONNECT_CANCELLED");
    assert.equal(toolRegistry.tools.size, 0);
    assert.ok(closeCount >= 1);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("an OAuth callback listener can be cancelled immediately", async () => {
  const { server, callback, cancel } = await startCallbackServer();
  cancel("login forgotten");
  await assert.rejects(callback, (error) => error?.code === "OAUTH_CANCELLED");
  await new Promise((resolve) => server.once("close", resolve));
  assert.equal(server.listening, false);
});

test("forgetting OAuth during discovery prevents a later callback or token write", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mcp-early-cancel-"));
  let resolveDiscovery;
  let authUrls = 0;
  const client = new McpOAuthClient({
    name: "early-cancel",
    resourceUrl: "https://example.test",
    dataDir,
    printAuthUrlFn: () => { authUrls += 1; }
  });
  client.discover = () => new Promise((resolve) => { resolveDiscovery = resolve; });
  client.registerClient = async () => ({ client_id: "must-not-be-used" });

  try {
    const attempt = client.ensureToken();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.cancelAuthorization("login forgotten"), false);
    resolveDiscovery({
      resourceMeta: { resource: "https://example.test" },
      serverMeta: {
        authorization_endpoint: "https://example.test/authorize",
        token_endpoint: "https://example.test/token"
      }
    });
    await assert.rejects(attempt, (error) => error?.code === "OAUTH_CANCELLED");
    assert.equal(authUrls, 0);
    assert.equal(fs.existsSync(client.cachePath), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
