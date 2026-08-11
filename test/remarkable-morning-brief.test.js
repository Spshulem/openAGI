import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_CATALOG } from "../src/mcp-catalog.js";
import { assertSafeStdioSpec } from "../src/mcp-registry.js";
import { ToolRegistry, registerCoreTools } from "../src/tool-registry.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("reMarkable catalog uses maintained cloud-capable server with token indirection", () => {
  const entry = MCP_CATALOG.find((item) => item.id === "remarkable");
  assert.ok(entry);
  assert.equal(entry.apiKeyEnvVar, "REMARKABLE_TOKEN");
  assert.equal(entry.register.command, "uvx");
  assert.deepEqual(entry.register.env, { REMARKABLE_TOKEN: "${REMARKABLE_TOKEN}" });
  assert.ok(entry.register.args.includes("remarkable-mcp"));
  assert.doesNotThrow(() => assertSafeStdioSpec(entry.register));
});

test("Playwright catalog enables official headless PDF capability in a bounded output directory", () => {
  const entry = MCP_CATALOG.find((item) => item.id === "playwright");
  assert.ok(entry);
  assert.equal(entry.register.command, "npx");
  assert.ok(entry.register.args.includes("@playwright/mcp@latest"));
  assert.ok(entry.register.args.includes("--caps=pdf"));
  assert.ok(entry.register.args.includes("/tmp/openagi-playwright"));
  assert.doesNotThrow(() => assertSafeStdioSpec(entry.register));
});

test("agent catalog connection allowlists API-key env vars for stdio MCPs", async () => {
  const previous = process.env.REMARKABLE_TOKEN;
  process.env.REMARKABLE_TOKEN = "test-token-not-persisted";
  const seen = { allowed: null, spec: null };
  const runtime = {
    mcp: {
      allowEnvKey: (name) => { seen.allowed = name; },
      registerServer: (spec) => { seen.spec = spec; return spec; },
      connect: async () => {},
      listServers: () => [],
      listTools: () => []
    }
  };
  const registry = new ToolRegistry();
  registerCoreTools(registry, runtime);

  await registry.get("connect_catalog_mcp").handler({ catalogId: "remarkable" });

  assert.equal(seen.allowed, "REMARKABLE_TOKEN");
  assert.deepEqual(seen.spec.env, { REMARKABLE_TOKEN: "${REMARKABLE_TOKEN}" });
  if (previous === undefined) delete process.env.REMARKABLE_TOKEN;
  else process.env.REMARKABLE_TOKEN = previous;
});

test("reMarkable morning brief skill encodes immutable delivery and resilient prior-call lookup", () => {
  const skill = fs.readFileSync(path.join(root, "examples", "skills", "remarkable-morning-brief", "SKILL.md"), "utf8");
  assert.match(skill, /@page \{ size: 260\.18pt 462\.55pt/);
  assert.match(skill, /exact attendee email or company domain/);
  assert.match(skill, /Only say "No prior call context found" after all applicable keys were tried/);
  assert.match(skill, /do not overwrite or upload a duplicate/i);
  assert.match(skill, /remarkable_upload/);
  assert.match(skill, /browser_pdf_save/);
});
