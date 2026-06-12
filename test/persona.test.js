// Persona: persona.md sets the main agent's name + system prompt, re-applied
// every boot, and flows into the agent's instructions.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parsePersona, loadPersona, applyPersona } from "../src/persona.js";
import { createDurableRuntime } from "../src/index.js";

test("parsePersona pulls the name from a 'Name:' line", () => {
  const p = parsePersona("# IDENTITY\n\n- **Name:** Peri\n- Vibe: sharp\n\nBe helpful.");
  assert.equal(p.name, "Peri");
  assert.match(p.systemPrompt, /Be helpful/);
});

test("parsePersona falls back to the first heading, then default", () => {
  assert.equal(parsePersona("# Atlas\n\nsome soul").name, "Atlas");
  assert.equal(parsePersona("just text no heading").name, "Main Agent");
  assert.equal(parsePersona("   "), null);
});

test("OPENAGI_AGENT_NAME overrides the parsed name", (t) => {
  const saved = process.env.OPENAGI_AGENT_NAME;
  process.env.OPENAGI_AGENT_NAME = "Override";
  t.after(() => { if (saved === undefined) delete process.env.OPENAGI_AGENT_NAME; else process.env.OPENAGI_AGENT_NAME = saved; });
  assert.equal(parsePersona("- Name: Peri\nsoul").name, "Override");
});

test("loadPersona returns null without a file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-persona-"));
  assert.equal(loadPersona(dir), null);
  fs.rmSync(dir, { recursive: true });
});

test("applyPersona sets the main agent and it reaches the system prompt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-persona-rt-"));
  fs.writeFileSync(path.join(dir, "persona.md"), "# IDENTITY\n- **Name:** Peri\n\nYou are direct, no fluff.");
  const runtime = createDurableRuntime({ dataDir: dir, autoConnectMcp: false });

  const main = runtime.agentHost.store.getAgent("main");
  assert.equal(main.name, "Peri");
  assert.match(main.systemPrompt, /direct, no fluff/);

  // The persona flows into the prompt the model receives.
  const prompt = runtime.agentHost.instructionsForAgent(main, {
    scrutiny: { action: "act", score: 0.6, reasons: [], dimensions: {} }
  });
  assert.match(prompt, /You are direct, no fluff/);
  assert.match(prompt, /You are Peri/);
  // (temp dir left for the OS to reap — the durable runtime keeps SQLite
  // handles open in the background and deleting under it races.)
});

test("editing persona.md + reboot updates the persisted main agent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-persona-edit-"));
  fs.writeFileSync(path.join(dir, "persona.md"), "- Name: Peri\nv1 soul");
  createDurableRuntime({ dataDir: dir, autoConnectMcp: false });
  // edit + reboot
  fs.writeFileSync(path.join(dir, "persona.md"), "- Name: Peri\nv2 soul updated");
  const reboot = createDurableRuntime({ dataDir: dir, autoConnectMcp: false });
  assert.match(reboot.agentHost.store.getAgent("main").systemPrompt, /v2 soul updated/);
});
