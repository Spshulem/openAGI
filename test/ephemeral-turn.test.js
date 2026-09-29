// The setup wizard's connectivity test must leave no trace: no session in
// the dashboard, no auto-detected task, no memory items, no outcome record.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultRuntime } from "../src/index.js";
import { ChannelManager } from "../src/channels.js";

test("ephemeral turns leave no session, task, memory, or outcome", async () => {
  const runtime = createDefaultRuntime();
  const memBefore = runtime.memory.items.size;
  const outcomesBefore = runtime.outcomes.recent(100).length;
  // Delta check, not an absolute zero — createDefaultRuntime()'s TaskStore
  // defaults to the real ~/.openagi task store when no dataDir is given, so
  // this must compare before/after like the memory and outcomes checks below
  // rather than assert an absolute count of 0.
  const tasksBefore = runtime.tasks.list({ limit: 50 }).length;

  const turn = await runtime.agentHost.handleMessage({
    from: "setup",
    text: "remind me to check this works", // would normally auto-create a task
    ephemeral: true
  });

  assert.ok(turn.reply.length > 0, "still produces a reply");
  assert.equal(runtime.agentHost.store.listSessions().length, 0, "no session persisted");
  assert.equal(runtime.tasks.list({ limit: 50 }).length, tasksBefore, "no auto-task created");
  assert.equal(runtime.memory.items.size, memBefore, "no memory written (signal or turn)");
  assert.equal(runtime.outcomes.recent(100).length, outcomesBefore, "no outcome recorded");
});

test("normal turns still persist everything", async () => {
  const runtime = createDefaultRuntime();
  await runtime.agentHost.handleMessage({ from: "user", text: "hello there agent" });
  assert.equal(runtime.agentHost.store.listSessions().length, 1);
  assert.ok(runtime.memory.items.size > 0);
});

test("provisional ChatGPT turns retain their session receipt but suppress task, memory, outcome, and propagation effects", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-provisional-no-effects-"));
  const seen = [];
  const modelProvider = {
    providerId: "openai-chatgpt",
    capabilityTier: "provisional-chat-only",
    model: "gpt-5.5",
    isConfigured: () => true,
    generate: async (options) => {
      seen.push(options);
      return {
        provider: "openai-chatgpt",
        model: "gpt-5.5",
        id: null,
        text: "A bounded chat reply.",
        toolCalls: [],
        operationalReceipt: {
          schema: "openagi.codex-provisional-turn.v1",
          scope: "owner-interactive-chat-only",
          transport: "chatgpt-codex-responses",
          capabilityTier: "provisional-chat-only",
          modelRequested: "gpt-5.5",
          modelReported: "gpt-5.5",
          reasoningEffortConfigured: "medium",
          reasoningEffortEffective: "unknown",
          terminalResponse: "completed",
          toolEffects: "none",
          responseIdSha256: "a".repeat(64)
        }
      };
    }
  };
  const runtime = createDefaultRuntime({ dataDir, modelProvider, autoConnectMcp: false });
  const tasksBefore = runtime.tasks.list({ limit: 50 }).length;
  const memoryBefore = runtime.memory.items.size;
  const outcomesBefore = runtime.outcomes.recent(100).length;
  let propagations = 0;
  runtime.scrutiny = { evaluate: () => ({
    action: "act", score: 0.5, reasons: [], dimensions: { novelty: 0.5, risk: 0.2, repetition: 0.3 }
  }) };
  runtime.propagation.shouldPropagate = () => ({ decision: true });
  runtime.propagation.propagate = () => {
    propagations += 1;
    return { created: false, specialist: null };
  };
  try {
    const turn = await runtime.agentHost.handleMessage({
      channel: "local", from: "owner", text: "remind me to prepare the report"
    }, { localOwner: true, assertChatGptOwnerAuthority: () => {} });

    assert.equal(runtime.tasks.list({ limit: 50 }).length, tasksBefore, "no auto-task");
    assert.equal(runtime.memory.items.size, memoryBefore, "no memory write");
    assert.equal(runtime.outcomes.recent(100).length, outcomesBefore, "no outcome write");
    assert.equal(propagations, 0, "no specialist propagation");
    assert.equal(runtime.agentHost.store.listSessions().length, 1, "chat session remains available");
    assert.deepEqual(seen[0].tools, [], "no tool schema reaches the provider");
    assert.equal(seen[0].toolRegistry, null, "no tool registry reaches the provider");
    assert.equal(turn.operationalReceipt?.toolEffects, "none", "the bounded receipt remains available");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("ChannelManager forwards the ephemeral flag", async () => {
  const seen = [];
  const channels = new ChannelManager({ agentHost: { runtime: {}, handleMessage: async (input) => { seen.push(input); return { reply: "ok" }; } } });
  await channels.handleLocalMessage({ text: "hi", ephemeral: true });
  await channels.handleLocalMessage({ text: "hi" });
  assert.equal(seen[0].ephemeral, true);
  assert.equal(seen[1].ephemeral, false);
});
