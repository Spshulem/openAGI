// Prompt-cache stability: the system prompt must be byte-identical across
// turns (so the Anthropic cache_control prefix actually hits), and everything
// that changes per turn (memory hits, scrutiny) must travel in a [context]
// block prepended to the latest user message instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDefaultInstructions,
  buildTurnContext,
  AnthropicProvider,
  OpenAIResponsesProvider
} from "../src/model-provider.js";

const agent = { id: "main", name: "Main Agent" };

const hitsA = [
  { score: 0.91, item: { id: "mem_1", tier: "short", content: "Spencer prefers espresso" } }
];
const hitsB = [
  { score: 0.42, item: { id: "mem_2", tier: "long", content: "Weekly review is on Sundays" } }
];

test("buildDefaultInstructions is byte-identical regardless of per-turn inputs", () => {
  const first = buildDefaultInstructions({ agent, memoryHits: hitsA, scrutiny: { action: "act" } });
  const second = buildDefaultInstructions({ agent, memoryHits: hitsB, scrutiny: { action: "watch" } });
  assert.equal(first, second, "system text must not vary with memory hits or scrutiny");
  assert.doesNotMatch(first, /Spencer prefers espresso/);
  assert.doesNotMatch(first, /Top memory hits/);
  assert.doesNotMatch(first, /Current scrutiny action/);
});

test("buildTurnContext carries memory hits verbatim and the scrutiny action", () => {
  const block = buildTurnContext({ scrutiny: { action: "watch" }, memoryHits: hitsA });
  assert.match(block, /^\[context\]\n/);
  assert.match(block, /\[\/context\]$/);
  assert.match(block, /Current scrutiny action: watch\./);
  assert.ok(block.includes("- [short] Spencer prefers espresso"), "memory hit must appear verbatim");
});

test("buildTurnContext returns an empty string when there is nothing per-turn", () => {
  assert.equal(buildTurnContext(), "");
  assert.equal(buildTurnContext({}), "");
  assert.equal(buildTurnContext({ memoryHits: [] }), "");
});

test("Anthropic path: static system block keeps cache_control; per-turn context rides the user turn", async () => {
  const provider = new AnthropicProvider({ apiKey: "test-key", maxToolHops: 1 });
  const sentBodies = [];
  provider.postMessages = async (body) => {
    sentBodies.push(JSON.parse(JSON.stringify(body)));
    return { id: "msg_1", content: [{ type: "text", text: "ok" }] };
  };

  await provider.generate({ input: "first question", agent, memoryHits: hitsA, scrutiny: { action: "act" }, messages: [] });
  await provider.generate({ input: "second question", agent, memoryHits: hitsB, scrutiny: { action: "watch" }, messages: [] });

  const [first, second] = sentBodies;
  assert.equal(first.system[0].text, second.system[0].text, "cached system prefix must be byte-stable across turns");
  assert.deepEqual(first.system[0].cache_control, { type: "ephemeral" }, "cache marker must survive the split");
  assert.doesNotMatch(first.system[0].text, /Spencer prefers espresso/);

  const lastUser1 = first.messages.at(-1);
  assert.equal(lastUser1.role, "user");
  assert.match(lastUser1.content, /^\[context\]/);
  assert.ok(lastUser1.content.includes("- [short] Spencer prefers espresso"));
  assert.ok(lastUser1.content.endsWith("first question"));

  const lastUser2 = second.messages.at(-1);
  assert.ok(lastUser2.content.includes("- [long] Weekly review is on Sundays"));
  assert.ok(lastUser2.content.endsWith("second question"));
});

test("Anthropic path: an explicit turnContext wins over the fallback", async () => {
  const provider = new AnthropicProvider({ apiKey: "test-key", maxToolHops: 1 });
  let sent = null;
  provider.postMessages = async (body) => {
    sent = JSON.parse(JSON.stringify(body));
    return { id: "msg_1", content: [{ type: "text", text: "ok" }] };
  };
  await provider.generate({
    input: "hello",
    agent,
    instructions: "STATIC SYSTEM TEXT",
    turnContext: "[context]\ncustom block\n[/context]",
    memoryHits: hitsA,
    messages: []
  });
  assert.equal(sent.system[0].text, "STATIC SYSTEM TEXT");
  assert.equal(sent.messages.at(-1).content, "[context]\ncustom block\n[/context]\n\nhello");
});

test("OpenAI path: instructions stay byte-stable and context rides the user turn (no cache markers)", async () => {
  const provider = new OpenAIResponsesProvider({ apiKey: "test-key", maxToolHops: 1 });
  const sentBodies = [];
  provider.postResponses = async (body) => {
    sentBodies.push(JSON.parse(JSON.stringify(body)));
    return { id: "resp_1", output_text: "ok", output: [] };
  };

  await provider.generate({ input: "first question", agent, memoryHits: hitsA, scrutiny: { action: "act" }, messages: [] });
  await provider.generate({ input: "second question", agent, memoryHits: hitsB, scrutiny: { action: "watch" }, messages: [] });

  const [first, second] = sentBodies;
  assert.equal(first.instructions, second.instructions, "instructions must be byte-stable across turns");
  assert.equal(JSON.stringify(first).includes("cache_control"), false, "OpenAI path carries no cache markers");
  const lastUser = first.input.at(-1);
  assert.equal(lastUser.role, "user");
  assert.match(lastUser.content, /^\[context\]/);
  assert.ok(lastUser.content.includes("- [short] Spencer prefers espresso"));
  assert.ok(lastUser.content.endsWith("first question"));
});

test("agent-host: instructionsForAgent is static and turnContextForAgent carries the per-turn state", async () => {
  const { AgentHost } = await import("../src/agent-host.js");
  const host = new AgentHost({
    runtime: { processSignal: () => ({}) },
    modelProvider: { isConfigured: () => true, generate: async () => ({ text: "ok", provider: "stub", model: "stub", toolCalls: [] }) }
  });
  const agentObj = { id: "main", name: "Peri", role: "main", systemPrompt: "Be direct, no fluff." };

  const staticPrompt = host.instructionsForAgent(agentObj);
  assert.equal(staticPrompt, host.instructionsForAgent(agentObj), "static prompt must be byte-identical across calls");
  assert.match(staticPrompt, /Be direct, no fluff\./);
  assert.match(staticPrompt, /You are Peri/);
  assert.doesNotMatch(staticPrompt, /Current decision/);
  assert.doesNotMatch(staticPrompt, /Top memory hits/);

  const output = { scrutiny: { action: "watch", score: 0.4, reasons: ["stub reason"], dimensions: {} } };
  const intuitions = [{ score: 0.5, text: "prefer smaller diffs" }];
  const ctx = host.turnContextForAgent(output, hitsA, intuitions, null, null);
  assert.match(ctx, /^\[context\]\n/);
  assert.match(ctx, /Current decision: watch/);
  assert.match(ctx, /This turn: observation mode/);
  assert.ok(ctx.includes("- [short] Spencer prefers espresso"), "memory hits must appear verbatim in the turn context");
  assert.match(ctx, /prefer smaller diffs/);
  assert.match(ctx, /\[\/context\]$/);
});

test("agent-host: computer-use guidance requires semantic targeting and post-action verification", async () => {
  const { AgentHost } = await import("../src/agent-host.js");
  const host = new AgentHost({
    runtime: { tools: { has: (name) => name === "start_computer_use_session" } },
    modelProvider: { isConfigured: () => true }
  });
  const prompt = host.instructionsForAgent({ id: "main", name: "Peri", role: "main" });
  assert.match(prompt, /Prefer fresh Accessibility element indices over coordinates/);
  assert.match(prompt, /computer_screenshot again after every/);
  assert.match(prompt, /Never guess an element index or Accessibility action/);
  assert.match(prompt, /only when computer_use_status reports list_apps or activate_app/);
  assert.match(prompt, /ask the user to foreground the target app/);
});
