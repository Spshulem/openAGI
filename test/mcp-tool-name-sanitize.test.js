// MCP tools are exposed to the model as `mcp_<server>_<tool>`. OpenAI rejects
// the whole tools[] array if any name violates ^[a-zA-Z0-9_-]+$, which breaks
// every tool-bearing call. A server name with a space (e.g. "BB Staging") used
// to leak the space into the tool name; both segments must be sanitized.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { McpRegistry } from "../src/mcp-registry.js";

const tmp = path.join(os.tmpdir(), `openagi-toolname-${process.pid}`);
const VALID = /^[a-zA-Z0-9_-]+$/;

test("a server name with a space yields OpenAI-valid tool names", () => {
  const reg = new McpRegistry({ dataDir: tmp, configPath: null });
  reg.registerServer({ name: "BB Staging", url: "https://mcp-staging.buildbetter.app/sse", auth: "oauth", trustLevel: "trusted" });
  // Simulate a connected client exposing a tool whose name also has a dash.
  reg.clients.set("BB Staging", {
    connected: true,
    tools: [{ name: "get-call-transcript", description: "x", inputSchema: {} }],
    callTool: async () => ({})
  });

  const listed = reg.listTools().find((t) => t.server === "BB Staging");
  assert.ok(VALID.test(listed.registeredName), `registeredName not API-valid: ${listed.registeredName}`);
  assert.equal(listed.registeredName, "mcp_BB_Staging_get_call_transcript");

  // exposeAsTools must register under the same sanitized, valid name.
  const registered = [];
  reg.toolRegistry = { tools: new Map(), register: (t) => registered.push(t.name), unregister: () => {} };
  reg.exposeAsTools("BB Staging");
  assert.ok(registered.every((n) => VALID.test(n)), `exposed names not API-valid: ${registered.join(", ")}`);
  assert.ok(registered.includes("mcp_BB_Staging_get_call_transcript"));
});
