import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpRegistry } from "../src/mcp-registry.js";
import { createDurableRuntime } from "../src/abi-runtime.js";
import { createHostedInterface } from "../src/hosted-interface.js";

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
