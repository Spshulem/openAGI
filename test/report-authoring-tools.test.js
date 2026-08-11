import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MCP_CATALOG } from "../src/mcp-catalog.js";
import { assertSafeStdioSpec } from "../src/mcp-registry.js";
import { PendingActionStore } from "../src/pending-actions.js";
import { createSkillFromPrompt } from "../src/skill-materialize.js";
import { ToolRegistry, registerCoreTools } from "../src/tool-registry.js";

test("reMarkable catalog uses maintained upload-capable server with token indirection", () => {
  const entry = MCP_CATALOG.find((item) => item.id === "remarkable");
  assert.ok(entry);
  assert.equal(entry.apiKeyEnvVar, "REMARKABLE_TOKEN");
  assert.equal(entry.register.command, "uvx");
  assert.deepEqual(entry.register.env, { REMARKABLE_TOKEN: "${REMARKABLE_TOKEN}" });
  assert.ok(entry.register.args.includes("remarkable-mcp"));
  assert.doesNotThrow(() => assertSafeStdioSpec(entry.register));
});

test("Playwright catalog exposes the official generic PDF capability", () => {
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

  try {
    await registry.get("connect_catalog_mcp").handler({ catalogId: "remarkable" });
    assert.equal(seen.allowed, "REMARKABLE_TOKEN");
    assert.deepEqual(seen.spec.env, { REMARKABLE_TOKEN: "${REMARKABLE_TOKEN}" });
  } finally {
    if (previous === undefined) delete process.env.REMARKABLE_TOKEN;
    else process.env.REMARKABLE_TOKEN = previous;
  }
});

test("prompt-authored skills use the existing bounded atomic materializer", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-create-skill-"));
  const bundled = path.join(root, "bundled");
  const user = path.join(root, "user");
  fs.mkdirSync(bundled, { recursive: true });
  const runtime = { skills: { dirs: [bundled, user] } };

  try {
    const result = createSkillFromPrompt({
      runtime,
      name: "Weekly Product Report",
      description: "Compose a report from whatever sources are connected.",
      instructions: "List the available MCP tools, gather evidence, and render {{input}}."
    });
    assert.equal(result.slug, "weekly-product-report");
    assert.equal(path.dirname(path.dirname(result.path)), user);
    const text = fs.readFileSync(result.path, "utf8");
    assert.match(text, /name: weekly-product-report/);
    assert.match(text, /createdBy: user-prompt/);
    assert.match(text, /render \{\{input\}\}/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("create_skill is approval-gated and reloads the registry after creation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-create-skill-tool-"));
  const bundled = path.join(root, "bundled");
  const user = path.join(root, "user");
  fs.mkdirSync(bundled, { recursive: true });
  let reloads = 0;
  const runtime = { skills: { dirs: [bundled, user], reload: () => { reloads += 1; } } };
  const registry = new ToolRegistry();
  const pending = new PendingActionStore({ dir: path.join(root, "pending") });
  registry.bindPendingActions(pending);
  registerCoreTools(registry, runtime);
  const tool = registry.get("create_skill");
  const args = {
    name: "Customer Report",
    description: "Create a customer report.",
    instructions: "Use connected tools and return a source receipt."
  };

  try {
    assert.equal(tool.needsConfirmation, true);
    const gated = await registry.invoke("create_skill", args, { sessionId: "test-session" });
    assert.equal(gated.result.status, "awaiting_confirmation");
    assert.equal(reloads, 0);
    assert.equal(fs.existsSync(user), false, "approval must happen before any skill file is written");
    assert.equal(pending.get(gated.result.actionId).args.instructions, args.instructions);

    // PendingActionStore approval dispatch is covered by the shared gate tests;
    // call the handler directly here to verify the tool's approved execution.
    const result = await tool.handler(args);
    assert.equal(result.name, "customer-report");
    assert.equal(reloads, 1);
    assert.ok(fs.existsSync(result.path));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
