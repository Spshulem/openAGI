import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemorySystem } from "../src/memory-system.js";
import { FileBackedMemorySystem } from "../src/file-backed-memory-system.js";
import { ToolRegistry, registerCoreTools } from "../src/tool-registry.js";
import { getStartedStatus } from "../src/get-started-status.js";

test("a correction replaces the saved preference even when newer summaries dominate recall", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onboarding-correction-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const memory = new FileBackedMemorySystem({ dir });
  const original = memory.remember({ content: "The user prefers checklists with exactly three bullets.", tags: ["tool:remember", "preference", "style", "communication"], scope: "main" }, { tier: "medium", strength: 0.2 });
  const unrelated = memory.remember({ content: "The user prefers a dark editor.", tags: ["tool:remember", "preference"], scope: "main" });
  for (let i = 0; i < 8; i++) memory.remember({ content: `Session ${i}: checklist format preference. The user prefers checklists with exactly three bullets. Decision: act.`, tags: ["agent-turn"], source: "agent-host", scope: "main" }, { tier: "short", strength: 1 });
  const before = original.metadata.recallCount;
  const corrected = memory.correct({ query: "checklist format preference", content: "The user prefers checklists with exactly two bullets.", scope: "main" });
  assert.equal(original.metadata.supersededBy, corrected.item.id);
  assert.equal(original.metadata.recallCount, before, "correction search is not a recall event");
  assert.equal(unrelated.metadata.supersededBy, undefined);
  const restored = new FileBackedMemorySystem({ dir });
  const hits = restored.retrieve("checklist format preference", { limit: 20 });
  assert.equal(hits[0].item.content, corrected.item.content);
  assert.ok(!hits.some(({ item }) => item.content.includes("three bullets")), "automatic quotations do not keep the old preference alive");
  const next = restored.correct({ query: "checklist format preference", content: "The user prefers checklists with exactly one bullet." });
  assert.equal(restored.items.get(corrected.item.id).metadata.supersededBy, next.item.id);
});

test("a stronger automatic fact wins over an unrelated saved preference during correction", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onboarding-correction-target-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const prefix of ["Acme", "Acme weekly", "Acme weekly engineering project"]) {
    const caseDir = path.join(dir, prefix);
    const memory = new FileBackedMemorySystem({ dir: caseDir });
    const preference = memory.remember({ content: `${prefix} review meeting notes should be short.`, tags: ["tool:remember", "preference"] });
    const stale = memory.remember({ content: `${prefix} review meeting time is 3pm.`, source: "agent-host" });
    const corrected = memory.correct({ query: `${prefix} review meeting time`, content: `${prefix} review meeting time is 4pm.` });
    assert.deepEqual(corrected.superseded.map(item => item.id), [stale.id]);
    assert.equal(preference.metadata.supersededBy, undefined);
    assert.equal(stale.metadata.supersededBy, corrected.item.id);

    const restored = new FileBackedMemorySystem({ dir: caseDir });
    const recalled = restored.retrieve(`${prefix} review meeting time`, { limit: 20 });
    assert.ok(recalled.some(({ item }) => item.id === corrected.item.id));
    assert.ok(recalled.some(({ item }) => item.id === preference.id));
    assert.ok(!recalled.some(({ item }) => item.id === stale.id), "the stale 3pm fact must not survive restart");
  }
});

test("saved-memory priority does not discard a stronger earlier correction", () => {
  const memory = new MemorySystem();
  const preference = memory.remember({ content: "Acme review meeting notes should be short.", tags: ["tool:remember"] });
  const previous = memory.correct({ content: "Acme review meeting time is 3pm." });
  const corrected = memory.correct({ query: "Acme review meeting time", content: "Acme review meeting time is 4pm." });
  assert.deepEqual(corrected.superseded.map(item => item.id), [previous.item.id]);
  assert.equal(preference.metadata.supersededBy, undefined);
});

test("corrections retire near-tied saved copies of the winning fact and preserve other preferences", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onboarding-saved-copies-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const strongestIsCorrection of [false, true]) {
    for (const reverse of [false, true]) {
      const caseDir = path.join(dir, `${strongestIsCorrection}-${reverse}`);
      const memory = new FileBackedMemorySystem({ dir: caseDir });
      const facts = ["Acme weekly meeting time is 3pm.", "Acme weekly team meeting time is 3pm."];
      if (reverse) facts.reverse();
      const stale = facts.map(content => strongestIsCorrection && content.includes("team")
        ? memory.correct({ content }).item
        : memory.remember({ content, tags: ["tool:remember"] }));
      const preference = memory.remember({ content: "Acme weekly team meeting notes should be short.", tags: ["tool:remember", "preference"] });
      const corrected = memory.correct({ query: "Acme weekly team meeting time", content: "Acme weekly team meeting time is 4pm." });
      assert.deepEqual(new Set(corrected.superseded.map(item => item.id)), new Set(stale.map(item => item.id)));
      assert.equal(preference.metadata.supersededBy, undefined);

      const restored = new FileBackedMemorySystem({ dir: caseDir });
      const recalled = restored.retrieve("Acme weekly team meeting time", { limit: 20 });
      assert.ok(recalled.some(({ item }) => item.id === corrected.item.id));
      assert.ok(recalled.some(({ item }) => item.id === preference.id));
      assert.ok(!recalled.some(({ item }) => stale.some(previous => previous.id === item.id)), "no saved 3pm copy survives a restart");
    }
  }
});

test("near-tied saved copies remain correction targets for queries with unmatched details", () => {
  for (const extra of ["location owner agenda date schedule", "location owner agenda date schedule room"]) {
    const memory = new MemorySystem();
    const stale = ["Acme weekly meeting time is 3pm.", "Acme weekly team meeting time is 3pm."]
      .map(content => memory.remember({ content, tags: ["tool:remember"] }));
    const corrected = memory.correct({ query: "Acme weekly team meeting time " + extra, content: "Acme weekly team meeting time is 4pm." });
    assert.deepEqual(new Set(corrected.superseded.map(item => item.id)), new Set(stale.map(item => item.id)));
  }
});

test("onboarding progress requires actual activity and cross-chat recall, not guide clicks", async () => {
  const memory = new MemorySystem();
  let messages = [];
  let sessions = [];
  const runtime = { memory, agentHost: { modelProvider: { isConfigured: () => true }, store: {
    listSessions: () => [{ id: "local:browser:main" }], getSession: () => ({ messages })
  } }, codingSupervisor: { builtin: { list: () => ({ sessions }) } } };
  assert.deepEqual(getStartedStatus(runtime), { model: true, chat: false, memory: false, memorySaved: false, agents: false });
  messages = [{ role: "assistant", content: "fallback", metadata: { model: "deterministic", provider: "deterministic" } }];
  assert.equal(getStartedStatus(runtime).chat, false);
  messages = [{ role: "assistant", content: "Your useful answer", metadata: { model: "test-model", provider: "local" } }];
  assert.equal(getStartedStatus(runtime).chat, true);
  const tools = new ToolRegistry(); registerCoreTools(tools, runtime);
  await tools.invoke("remember", { content: "I prefer three checklist bullets", tags: ["preference"] }, { agentId: "main", sessionId: "chat-a" });
  assert.equal(getStartedStatus(runtime).memorySaved, true);
  await tools.invoke("recall", { query: "checklist" }, { agentId: "main", sessionId: "chat-a" });
  assert.equal(getStartedStatus(runtime).memory, false);
  await tools.invoke("recall", { query: "checklist" }, { agentId: "main", sessionId: "chat-b" });
  assert.equal(getStartedStatus(runtime).memory, true);
  assert.equal([...memory.items.values()][0].metadata.recallCount, 2);
  sessions = [{ status: "failed", replyAvailable: true }];
  assert.equal(getStartedStatus(runtime).agents, false);
  sessions = [{ status: "idle", replyAvailable: true }];
  assert.equal(getStartedStatus(runtime).agents, true);
  assert.doesNotMatch(JSON.stringify(getStartedStatus(runtime)), /three checklist|Your useful answer|chat-a/);
});
