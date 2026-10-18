// Chat cost controls: the meter bills OpenAI cached input at the cached price,
// gpt-6 variants have their own rows, the tool loop's per-call input is capped,
// one turn cannot spend past OPENAGI_TURN_USD_LIMIT, and reasoning effort can
// be set per task.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BudgetGuard, normalizeUsage } from "../src/budget-guard.js";
import { CreditLedger } from "../src/credit-ledger.js";
import { ModelRouter, renderModelPlan } from "../src/model-router.js";
import { AnthropicProvider, OpenAIResponsesProvider, turnSpendStopMessage } from "../src/model-provider.js";
import { itemChars } from "../src/context-trim.js";
import { classifyAgentFailure } from "../src/agent-failure.js";
import { SkillRegistry } from "../src/skills.js";

function tmpGuard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cost-"));
  const ledger = new CreditLedger({ storePath: path.join(dir, "ledger.jsonl") });
  return { guard: new BudgetGuard({ storePath: path.join(dir, "usage.json"), ledger, dailyUsdLimit: 1000 }), ledger };
}

const agent = { id: "main", name: "Main Agent" };
const toolSchema = [{ type: "function", name: "big_tool", parameters: { type: "object", properties: {} } }];

function callResponse(hop, usage) {
  return {
    id: `resp_${hop}`,
    output: [{ type: "function_call", call_id: `call_${hop}`, name: "big_tool", arguments: "{}" }],
    ...(usage ? { usage } : {})
  };
}

// --- 1. Meter -------------------------------------------------------------

test("Responses usage: cached and cache-write tokens are split out of input_tokens", () => {
  const tokens = normalizeUsage({
    input_tokens: 10_000,
    input_tokens_details: { cached_tokens: 8_000, cache_write_tokens: 1_000 },
    output_tokens: 100,
    output_tokens_details: { reasoning_tokens: 40 }
  });
  assert.deepEqual(tokens, { input: 1_000, output: 100, cacheRead: 8_000, cacheWrite: 1_000 });
});

test("Responses usage on gpt-6-astra bills cached input at the cached price", () => {
  const { guard, ledger } = tmpGuard();
  const res = guard.record({
    input_tokens: 10_000,
    input_tokens_details: { cached_tokens: 8_000, cache_write_tokens: 1_000 },
    output_tokens: 100
  }, "gpt-6-astra");
  // 1k fresh x $10 + 100 out x $50 + 8k cached x $1 + 1k write x $12.5, per 1M.
  assert.ok(Math.abs(res.added - 0.0355) < 1e-9, `got ${res.added}`);
  assert.equal(ledger.query({ days: 1 })[0].tokens.cacheRead, 8_000);
});

test("cache-write tokens on a row with no cache-write rate bill as normal input, not free", () => {
  const { guard } = tmpGuard();
  const usage = { input_tokens: 100_000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 100_000 }, output_tokens: 0 };
  assert.ok(Math.abs(guard.costOf(usage, "gpt-5.5") - 0.5) < 1e-9, `got ${guard.costOf(usage, "gpt-5.5")}`);
  // Rows with a published write rate still use it.
  assert.ok(Math.abs(guard.costOf(usage, "gpt-6-astra") - 1.25) < 1e-9);
  const custom = new BudgetGuard({ storePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cost-")), "u.json"), prices: { "my-model": { in: 2, out: 0, cacheRead: 0.2 } } });
  assert.ok(Math.abs(custom.costOf(usage, "my-model") - 0.2) < 1e-9, "a row without cacheWrite bills at input, not NaN");
});

test("Chat Completions usage: cached prompt tokens are not double-counted", () => {
  const tokens = normalizeUsage({ prompt_tokens: 5_000, prompt_tokens_details: { cached_tokens: 4_000 }, completion_tokens: 10 });
  assert.deepEqual(tokens, { input: 1_000, output: 10, cacheRead: 4_000, cacheWrite: 0 });
  assert.deepEqual(normalizeUsage({ prompt_tokens: 300, completion_tokens: 0 }), { input: 300, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("Anthropic usage keeps input separate from cache reads/writes", () => {
  const tokens = normalizeUsage({ input_tokens: 100, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 200, output_tokens: 10 });
  assert.deepEqual(tokens, { input: 100, output: 10, cacheRead: 5_000, cacheWrite: 200 });
});

test("OpenAI fresh input never goes below zero on inconsistent usage", () => {
  const tokens = normalizeUsage({ input_tokens: 100, input_tokens_details: { cached_tokens: 500 }, output_tokens: 1 });
  assert.equal(tokens.input, 0);
  assert.equal(tokens.cacheRead, 500);
});

test("priceFor: gpt-6-astra and gpt-6-luna each bill at their own rate, including dated variants", () => {
  const { guard } = tmpGuard();
  assert.deepEqual(guard.priceFor("gpt-6-astra"), { in: 10, out: 50, cacheRead: 1, cacheWrite: 12.5 });
  assert.deepEqual(guard.priceFor("gpt-6-luna"), { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 });
  assert.equal(guard.priceFor("gpt-6-luna-2026-10-01").in, 0.1, "luna snapshot must not bill at astra");
  assert.equal(guard.priceFor("gpt-6-astra-2026-10-01").in, 10, "astra snapshot must not bill at luna");
});

test("provider passes Responses usage (non-streamed and streamed) to the meter intact", async () => {
  const { guard, ledger } = tmpGuard();
  const usage = { input_tokens: 2_000, input_tokens_details: { cached_tokens: 1_500, cache_write_tokens: 0 }, output_tokens: 20 };
  const final = { id: "r1", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage };
  const provider = new OpenAIResponsesProvider({
    apiKey: "k",
    model: "gpt-6-luna",
    budgetGuard: guard,
    fetchImpl: async (_url, init) => {
      const streamed = JSON.parse(init.body).stream === true;
      if (!streamed) return new Response(JSON.stringify(final), { status: 200, headers: { "content-type": "application/json" } });
      const sse = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n` +
        `data: ${JSON.stringify({ type: "response.completed", response: final })}\n\n`;
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
  });
  await provider.generate({ input: "hi", agent, messages: [] });
  await provider.generate({ input: "hi", agent, messages: [], onTextDelta: () => {} });
  const rows = ledger.query({ days: 1 });
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.model, "gpt-6-luna");
    assert.deepEqual(row.tokens, { input: 500, output: 20, cacheRead: 1_500, cacheWrite: 0 });
  }
});

// --- 2. Context cap -------------------------------------------------------

function loopProvider({ hops, outputChars, maxInputTokens, extra = {} }) {
  const provider = new OpenAIResponsesProvider({ apiKey: "k", model: "gpt-6-luna", maxToolHops: hops + 1, maxInputTokens, turnUsdLimit: 0, ...extra });
  const bodies = [];
  provider.postResponses = async (body) => {
    bodies.push(JSON.parse(JSON.stringify(body)));
    const hop = bodies.length;
    if (hop > hops) return { id: "done", output_text: "done", output: [] };
    return callResponse(hop);
  };
  const toolRegistry = { invoke: async () => ({ ok: true, result: { data: "x".repeat(outputChars) } }) };
  return { provider, bodies, toolRegistry };
}

function assertPairsMatched(input) {
  const calls = input.filter((item) => item.type === "function_call").map((item) => item.call_id);
  const outputs = input.filter((item) => item.type === "function_call_output").map((item) => item.call_id);
  assert.deepEqual(outputs, calls, "every function_call keeps its function_call_output");
}

test("a huge single tool output is clipped with a note", async () => {
  const { provider, bodies, toolRegistry } = loopProvider({ hops: 1, outputChars: 50_000, maxInputTokens: 1_000_000 });
  await provider.generate({ input: "go", agent, messages: [], tools: toolSchema, toolRegistry });
  const output = bodies[1].input.find((item) => item.type === "function_call_output").output;
  assert.ok(output.length < 20_200, `clipped to ~20k, got ${output.length}`);
  assert.match(output, /\[tool output clipped: big_tool 50011 chars, first 20000 kept\]$/);
});

test("older tool outputs beyond the most recent few become stubs; pairing stays intact", async () => {
  const { provider, bodies, toolRegistry } = loopProvider({ hops: 8, outputChars: 2_000, maxInputTokens: 1_000_000 });
  await provider.generate({ input: "go", agent, messages: [], tools: toolSchema, toolRegistry });
  const last = bodies.at(-1).input;
  const outputs = last.filter((item) => item.type === "function_call_output").map((item) => item.output);
  assert.equal(outputs.length, 8);
  assert.equal(outputs[0], "[tool output trimmed: big_tool 2011 chars]");
  assert.ok(outputs.at(-1).length === 2_011, "latest output is intact");
  assert.ok(outputs.filter((o) => o.startsWith("[tool output trimmed")).length >= 3);
  assertPairsMatched(last);
  assert.equal(last.find((item) => item.role === "user").content, "go");
});

test("trimming is batched: the sent prefix is not rewritten every hop", async () => {
  const { provider, bodies, toolRegistry } = loopProvider({ hops: 12, outputChars: 2_000, maxInputTokens: 1_000_000 });
  await provider.generate({ input: "go", agent, messages: [], tools: toolSchema, toolRegistry });
  let rewrites = 0;
  for (let i = 1; i < bodies.length; i += 1) {
    const prev = JSON.stringify(bodies[i - 1].input).slice(0, -1);
    if (!JSON.stringify(bodies[i].input).startsWith(prev)) rewrites += 1;
  }
  assert.ok(rewrites > 0, "trimming happened");
  assert.ok(rewrites <= 3, `prefix rewritten on ${rewrites} of ${bodies.length - 1} hops`);
});

test("hard input cap: stubs old tool outputs, then drops oldest turns, never the latest message or instructions", async () => {
  const maxInputTokens = 4_000;
  const { provider, bodies, toolRegistry } = loopProvider({ hops: 4, outputChars: 3_000, maxInputTokens });
  const messages = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i} ${"h".repeat(2_500)}` }));
  const instructions = "STATIC SYSTEM";
  await provider.generate({ input: "latest ask", agent, instructions, messages, tools: toolSchema, toolRegistry });
  for (const body of bodies) {
    assert.equal(body.instructions, instructions);
    assert.equal(body.input.filter((item) => item.content === "latest ask").length, 1, "latest user message kept");
    assertPairsMatched(body.input);
    const chars = instructions.length + JSON.stringify(toolSchema).length + body.input.reduce((n, item) => n + itemChars(item), 0);
    assert.ok(chars <= maxInputTokens * 4, `call over cap: ${chars} chars`);
  }
  const last = bodies.at(-1).input;
  assert.ok(!last.some((item) => typeof item.content === "string" && item.content.startsWith("turn 0 ")), "oldest turn dropped first");
  assert.match(last.find((item) => item.type === "function_call_output").output, /^\[tool output trimmed: big_tool/);
});

test("old screenshots are stubbed too, without breaking the turn shape", async () => {
  const provider = new OpenAIResponsesProvider({ apiKey: "k", model: "gpt-6-luna", maxToolHops: 9, turnUsdLimit: 0 });
  const bodies = [];
  provider.postResponses = async (body) => {
    bodies.push(JSON.parse(JSON.stringify(body)));
    return bodies.length > 8 ? { id: "done", output_text: "done", output: [] } : callResponse(bodies.length);
  };
  const toolRegistry = { invoke: async () => ({ ok: true, result: { width: 10, height: 10, format: "png", image: "A".repeat(200_000) } }) };
  await provider.generate({ input: "go", agent, messages: [], tools: toolSchema, toolRegistry });
  const last = bodies.at(-1).input;
  const images = last.filter((item) => item.role === "user" && item.content !== "go");
  assert.equal(images.length, 8);
  assert.match(images[0].content, /^\[tool output trimmed: big_tool \d+ chars\]$/);
  assert.equal(images.at(-1).content[1].type, "input_image");
  assertPairsMatched(last);
});

// --- 3. Per-turn spend stop -----------------------------------------------

// 150k fresh input on gpt-6-astra = $1.50 per call.
const pricey = { input_tokens: 150_000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 0 };

test("turn spend stop: the loop stops past the limit with a plain message and pending calls are not run", async () => {
  const { guard } = tmpGuard();
  const provider = new OpenAIResponsesProvider({ apiKey: "k", model: "gpt-6-astra", budgetGuard: guard, turnUsdLimit: 2, maxToolHops: 10 });
  let calls = 0;
  provider.postResponses = async () => { calls += 1; return callResponse(calls, pricey); };
  let invoked = 0;
  const toolRegistry = { invoke: async () => { invoked += 1; return { ok: true, result: { ok: 1 } }; } };
  const result = await provider.generate({ input: "fix it", agent, messages: [], tools: toolSchema, toolRegistry });
  assert.equal(calls, 2, "no call after the limit is crossed, not even the summary call");
  assert.equal(invoked, 1, "the over-limit hop's tool calls are not executed");
  assert.equal(result.stoppedAtUsdLimit, true);
  assert.equal(result.text, turnSpendStopMessage(3, 2, { toolCalls: result.toolCalls, unrunCalls: ["big_tool"] }));
  assert.match(result.text, /\$3\.00/);
});

test("turn spend stop: a skill tool's nested model calls share the turn's one total", async () => {
  const { guard } = tmpGuard();
  const provider = new OpenAIResponsesProvider({ apiKey: "k", model: "gpt-6-astra", budgetGuard: guard, turnUsdLimit: 2, maxToolHops: 10 });
  let calls = 0;
  provider.postResponses = async (body) => {
    calls += 1;
    const name = body.instructions.includes("diagnose") ? "big_tool" : "skill_diagnose";
    return { id: `r${calls}`, output: [{ type: "function_call", call_id: `c${calls}`, name, arguments: "{}" }], usage: pricey };
  };
  const toolRegistry = {
    toOpenAITools: () => toolSchema,
    invoke: async (name, args, context) => (name === "skill_diagnose"
      ? { ok: true, result: await skills.run("diagnose", { input: "why" }, context) }
      : { ok: true, result: {} })
  };
  const skills = new SkillRegistry({ runtime: { agentHost: { modelProvider: provider } } });
  skills.runtime.tools = toolRegistry;
  skills.skills.set("diagnose", { name: "diagnose", description: "diagnose tool errors", body: "{{input}}", systemPrompt: "" });
  const context = { channel: "node" };
  const result = await provider.generate({ input: "fix it", agent, messages: [], tools: toolSchema, toolRegistry, context });
  // Parent hop ($1.50) runs the skill; the skill's first hop ($1.50) crosses
  // the one $2 limit, so the skill stops and the parent stops right after it.
  assert.equal(calls, 2, "no second $2 for the nested call, no parent hop after it");
  assert.equal(result.stoppedAtUsdLimit, true);
  assert.equal(result.turnUsd, 3);
  assert.match(result.text, /^I stopped this turn at \$3\.00/);
  assert.match(result.text, /Done so far: skill_diagnose \(ok\)/);
  assert.equal(context.__turnSpend, undefined, "the caller's context is not changed");
});

test("turn spend stop: calls later in the same batch are not run once a skill crosses the limit", async () => {
  const { guard } = tmpGuard();
  const provider = new OpenAIResponsesProvider({ apiKey: "k", model: "gpt-6-astra", budgetGuard: guard, turnUsdLimit: 2, maxToolHops: 10 });
  let calls = 0;
  const cheap = { input_tokens: 10_000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 0 };
  provider.postResponses = async (body) => {
    calls += 1;
    // The parent asks for a skill and then a side-effecting tool in one reply.
    if (!body.instructions.includes("diagnose")) {
      return { id: `r${calls}`, output: [
        { type: "function_call", call_id: "c_skill", name: "skill_diagnose", arguments: "{}" },
        { type: "function_call", call_id: "c_send", name: "send_message", arguments: "{}" }
      ], usage: cheap };
    }
    return { id: `r${calls}`, output: [{ type: "message", content: [{ type: "output_text", text: "diagnosed" }] }], usage: { ...pricey, input_tokens: 250_000 } };
  };
  const invoked = [];
  const toolRegistry = {
    toOpenAITools: () => toolSchema,
    invoke: async (name, args, context) => {
      invoked.push(name);
      return name === "skill_diagnose" ? { ok: true, result: await skills.run("diagnose", { input: "why" }, context) } : { ok: true, result: { sent: true } };
    }
  };
  const skills = new SkillRegistry({ runtime: { agentHost: { modelProvider: provider } } });
  skills.runtime.tools = toolRegistry;
  skills.skills.set("diagnose", { name: "diagnose", description: "diagnose tool errors", body: "{{input}}", systemPrompt: "" });
  const result = await provider.generate({ input: "fix it", agent, messages: [], tools: toolSchema, toolRegistry, context: { channel: "node" } });
  assert.deepEqual(invoked, ["skill_diagnose"], "the send after the over-limit skill never runs");
  assert.equal(result.stoppedAtUsdLimit, true);
  assert.match(result.text, /Not run yet: send_message/);
});

test("turn spend stop: Anthropic skips the rest of a batch past the limit too", async () => {
  const { guard } = tmpGuard();
  const provider = new AnthropicProvider({ apiKey: "k", model: "claude-opus-4-7", budgetGuard: guard, turnUsdLimit: 2, maxToolHops: 10 });
  provider.postMessages = async () => ({ id: "m1", content: [
    { type: "tool_use", id: "t1", name: "spendy", input: {} },
    { type: "tool_use", id: "t2", name: "send_message", input: {} }
  ], usage: { input_tokens: 1_000, output_tokens: 0 } });
  const invoked = [];
  const toolRegistry = {
    toAnthropicTools: () => [],
    invoke: async (name, args, context) => {
      invoked.push(name);
      // A nested call that spends the limit, on the shared total.
      if (name === "spendy") context.__turnSpend.usd += 5;
      return { ok: true, result: {} };
    }
  };
  const result = await provider.generate({ input: "go", agent, messages: [], toolRegistry });
  assert.deepEqual(invoked, ["spendy"]);
  assert.match(result.text, /Not run yet: send_message/);
});

test("turn spend stop: Anthropic tools share the total with nested calls too", async () => {
  const { guard } = tmpGuard();
  const provider = new AnthropicProvider({ apiKey: "k", model: "claude-opus-4-7", budgetGuard: guard, turnUsdLimit: 2, maxToolHops: 10 });
  let calls = 0;
  provider.postMessages = async () => {
    calls += 1;
    return { id: `m${calls}`, content: [{ type: "tool_use", id: `t${calls}`, name: "nested", input: {} }], usage: { input_tokens: 100_000, output_tokens: 0 } };
  };
  const toolRegistry = {
    toAnthropicTools: () => [],
    invoke: async (name, args, context) => ({ ok: true, result: (await provider.generate({ input: "inner", agent, messages: [], toolRegistry, context })).text })
  };
  const result = await provider.generate({ input: "go", agent, messages: [], toolRegistry });
  assert.equal(calls, 2);
  assert.match(result.text, /stopped this turn at \$3\.00/);
});

test("turn spend stop text lists the tools already run and the ones not run, so continue has the progress", async () => {
  const { guard } = tmpGuard();
  const provider = new OpenAIResponsesProvider({ apiKey: "k", model: "gpt-6-astra", budgetGuard: guard, turnUsdLimit: 2, maxToolHops: 10 });
  let calls = 0;
  provider.postResponses = async () => {
    calls += 1;
    const output = calls === 1
      ? [
          { type: "function_call", call_id: "a", name: "fleet_screen", arguments: "{}" },
          { type: "function_call", call_id: "b", name: "fleet_screen", arguments: "{}" },
          { type: "function_call", call_id: "c", name: "computer_click", arguments: "{}" }
        ]
      : [{ type: "function_call", call_id: "d", name: "fleet_thread", arguments: "{}" }];
    return { id: `r${calls}`, output, usage: pricey };
  };
  const toolRegistry = { invoke: async (name) => (name === "computer_click" ? { ok: false, error: "denied" } : { ok: true, result: {} }) };
  const result = await provider.generate({ input: "fix it", agent, messages: [], tools: toolSchema, toolRegistry });
  assert.ok(result.text.startsWith([
    "I stopped this turn at $3.00 of model spend (the per-turn limit is $2.00).",
    "Done so far: fleet_screen (ok) x2, computer_click (failed).",
    "Not run yet: fleet_thread."
  ].join("\n")));
  assert.match(result.text, /"tool":"computer_click","arguments":\{\},"result":\{"ok":false,"error":"denied"\}/);
  assert.ok(result.text.endsWith('Say "continue" and I\'ll keep going.'));
  assert.match(
    turnSpendStopMessage(2.5, 2, { toolCalls: [{ name: "send", result: { ok: true, result: { status: "awaiting_confirmation" } } }] }),
    /Done so far: send \(awaiting approval\)\./
  );
});

test("both providers reject oversized protected input before any paid request", async () => {
  for (const Provider of [OpenAIResponsesProvider, AnthropicProvider]) {
    for (const streaming of [false, true]) {
      for (const field of ["input", "instructions", "schema"]) {
        let paidCalls = 0;
        const provider = new Provider({ apiKey: "test", maxInputTokens: 100, fetchImpl: async () => { paidCalls += 1; throw new Error("must not send"); } });
        const schema = [{ type: "function", name: "tool", description: "x".repeat(1000) }];
        await assert.rejects(provider.generate({
          input: field === "input" ? "x".repeat(1000) : "go",
          instructions: field === "instructions" ? "x".repeat(1000) : "short",
          turnContext: "", agent,
          tools: field === "schema" ? schema : [],
          toolRegistry: { toAnthropicTools: () => field === "schema" ? schema : [] },
          ...(streaming ? { onTextDelta() {} } : {})
        }), (error) => error.code === "INPUT_CONTEXT_TOO_LARGE" && classifyAgentFailure(error).code === "input-limit");
        assert.equal(paidCalls, 0);
      }
    }
  }
});

test("Anthropic caps long tool loops, preserves every tool pair, and trims old screenshots", async () => {
  for (const screenshots of [false, true]) {
    const bodies = [];
    const provider = new AnthropicProvider({ apiKey: "test", maxInputTokens: 5000, maxToolHops: 10, turnUsdLimit: 0 });
    provider.postMessages = async (body) => {
      bodies.push(structuredClone(body));
      const hop = bodies.length;
      return { id: `r${hop}`, content: hop > 8 ? [{ type: "text", text: "done" }] : [{ type: "tool_use", id: `t${hop}`, name: "big_tool", input: {} }] };
    };
    const toolRegistry = {
      toAnthropicTools: () => [],
      invoke: async () => ({ ok: true, result: screenshots ? { image: "a".repeat(100_000), format: "png" } : { data: "x".repeat(8000) } })
    };
    await provider.generate({ input: "latest ask", instructions: "static", turnContext: "", agent,
      messages: Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `old ${i} ${"h".repeat(4000)}` })), toolRegistry });
    for (const body of bodies) {
      assert.ok(body.messages.some((message) => message.content === "latest ask"));
      const uses = body.messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((block) => block.type === "tool_use").map((block) => block.id) : []);
      const results = body.messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((block) => block.type === "tool_result") : []);
      assert.deepEqual(results.map((block) => block.tool_use_id), uses);
      const chars = JSON.stringify(body.system).length + 2 + body.messages.reduce((sum, message) => sum + (Array.isArray(message.content) && message.content[0]?.type === "tool_result" ? message.content.reduce((n, block) => n + itemChars(block), 0) : itemChars(message)), 0);
      assert.ok(chars <= 20_000, `request exceeds cap: ${chars}`);
    }
    const results = bodies.at(-1).messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((block) => block.type === "tool_result") : []);
    assert.match(results[0].content, /^\[tool output trimmed:/);
    assert.equal(typeof results.at(-1).content, screenshots ? "object" : "string");
  }
});

test("final no-tools calls obey the input cap on both providers", async () => {
  for (const Provider of [OpenAIResponsesProvider, AnthropicProvider]) {
    const provider = new Provider({ apiKey: "test", maxInputTokens: 35, maxToolHops: 1 });
    let calls = 0;
    provider.postResponses = provider.postMessages = async () => { calls += 1; return { id: "empty", output: [], content: [] }; };
    await assert.rejects(provider.generate({ input: "go", instructions: "short", turnContext: "", agent }), { code: "INPUT_CONTEXT_TOO_LARGE" });
    assert.equal(calls, 1, "the final summary must not exceed the cap");
  }
});

test("spend stops retain bounded arguments and results without screenshot payloads", () => {
  const text = turnSpendStopMessage(2.5, 2, { toolCalls: [{ name: "send_message", arguments: { to: "test-recipient", body: "x".repeat(20_000) }, result: { ok: true, result: { id: "receipt-123", status: "sent", imageBase64: "private-image-payload" } } }] });
  assert.match(text, /"to":"test-recipient"/);
  assert.match(text, /receipt-123/);
  assert.match(text, /do not repeat successful side effects/);
  assert.doesNotMatch(text, /private-image-payload/);
  assert.ok(text.length < 1500);
});

test("spend-stop receipts omit configuration credentials and fit the delivered message limit", () => {
  const credential = "credential-fixture-must-stay-private";
  const text = turnSpendStopMessage(2.5, 2, { toolCalls: Array.from({ length: 12 }, (_, i) => ({
    name: "connect_catalog_mcp", arguments: { id: `server-${i}`, apiKey: credential, config: { password: credential, env: { CUSTOM: credential }, args: ["--key", credential], headers: { Authorization: credential } } },
    result: { ok: true, result: { id: `receipt-${i}`, token: credential, nested: Array.from({ length: 8 }, () => ({ data: "x".repeat(2000) })) } }
  })) });
  assert.doesNotMatch(text, new RegExp(credential));
  assert.ok(text.length <= 3800, `reply grew to ${text.length} characters`);
  assert.match(text, /receipt-11/);
  assert.ok(text.endsWith('Say "continue" and I\'ll keep going.'));
});

test("OpenAI's final reply excludes unsent tool schemas from its input cap", async () => {
  const provider = new OpenAIResponsesProvider({ apiKey: "test", maxInputTokens: 500, maxToolHops: 1 });
  const bodies = [];
  provider.postResponses = async (body) => {
    bodies.push(structuredClone(body));
    return bodies.length === 1 ? callResponse(1) : { id: "done", output_text: "finished", output: [] };
  };
  const result = await provider.generate({ input: "go", instructions: "short", turnContext: "", agent,
    tools: [{ ...toolSchema[0], description: "x".repeat(1200) }], toolRegistry: { invoke: async () => ({ ok: true, result: "r".repeat(900) }) } });
  assert.equal(result.text, "finished");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].tools, undefined);
  assert.ok(bodies[1].instructions.length + bodies[1].input.reduce((sum, item) => sum + itemChars(item), 0) <= 2000);
});

test("turn spend stop message is plain and says how to continue", () => {
  assert.equal(
    turnSpendStopMessage(2.137, 2),
    'I stopped this turn at $2.14 of model spend (the per-turn limit is $2.00). Say "continue" and I\'ll keep going.'
  );
});

test("turn spend stop: Anthropic loop stops too", async () => {
  const { guard } = tmpGuard();
  const provider = new AnthropicProvider({ apiKey: "k", model: "claude-opus-4-7", budgetGuard: guard, turnUsdLimit: 2, maxToolHops: 10 });
  let calls = 0;
  provider.postMessages = async () => {
    calls += 1;
    return { id: `m${calls}`, content: [{ type: "tool_use", id: `t${calls}`, name: "big_tool", input: {} }], usage: { input_tokens: 100_000, output_tokens: 0 } };
  };
  const toolRegistry = { invoke: async () => ({ ok: true, result: {} }), toAnthropicTools: () => [] };
  const result = await provider.generate({ input: "go", agent, messages: [], toolRegistry });
  assert.equal(calls, 2);
  assert.match(result.text, /stopped this turn at \$3\.00/);
});

test("turn spend stop defaults to $2, 0 disables it, and a throwing meter never breaks the reply", async () => {
  const saved = process.env.OPENAGI_TURN_USD_LIMIT;
  delete process.env.OPENAGI_TURN_USD_LIMIT;
  try {
    assert.equal(new OpenAIResponsesProvider({ apiKey: "k" }).turnUsdLimit, 2);
    process.env.OPENAGI_TURN_USD_LIMIT = "0.5";
    assert.equal(new OpenAIResponsesProvider({ apiKey: "k" }).turnUsdLimit, 0.5);
  } finally {
    if (saved === undefined) delete process.env.OPENAGI_TURN_USD_LIMIT;
    else process.env.OPENAGI_TURN_USD_LIMIT = saved;
  }

  const { guard } = tmpGuard();
  const off = new OpenAIResponsesProvider({ apiKey: "k", model: "gpt-6-astra", budgetGuard: guard, turnUsdLimit: 0, maxToolHops: 4 });
  let calls = 0;
  off.postResponses = async () => { calls += 1; return calls > 3 ? { id: "d", output_text: "done", output: [], usage: pricey } : callResponse(calls, pricey); };
  const toolRegistry = { invoke: async () => ({ ok: true, result: {} }) };
  assert.equal((await off.generate({ input: "go", agent, messages: [], tools: toolSchema, toolRegistry })).text, "done");

  const broken = new OpenAIResponsesProvider({ apiKey: "k", model: "gpt-6-astra", budgetGuard: { check() {}, costOf() { throw new Error("boom"); } }, turnUsdLimit: 2, maxToolHops: 4 });
  calls = 0;
  broken.postResponses = async () => { calls += 1; return calls > 3 ? { id: "d", output_text: "done", output: [] } : callResponse(calls, pricey); };
  assert.equal((await broken.generate({ input: "go", agent, messages: [], tools: toolSchema, toolRegistry })).text, "done");
});

// --- 4. Per-task reasoning effort -----------------------------------------

test("router resolves OPENAI_REASONING_EFFORT_TASK_<TASK> and shows it in the plan", () => {
  const router = new ModelRouter({ envPrefix: "OPENAI", baseModel: "gpt-6-luna", env: { OPENAI_REASONING_EFFORT_TASK_CHAT: "high" } });
  assert.equal(router.reasoningEffort("chat"), "high");
  assert.equal(router.reasoningEffort("observer"), null);
  assert.equal(router.describe().find((row) => row.task === "chat").reasoningEffort, "high");
  assert.match(renderModelPlan(router, { provider: "openai" }), /User chat\s+gpt-6-luna  \(effort high\)/);
  const pinned = new ModelRouter({ envPrefix: "OPENAI", baseModel: "x", env: {}, overrides: { reasoningEffort: { chat: "low" } } });
  assert.equal(pinned.reasoningEffort("chat"), "low");
});

test("per-task reasoning effort is trimmed and lowercased; an unknown value falls back to global, warns once, and is flagged", async () => {
  const warn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    const router = new ModelRouter({ envPrefix: "OPENAI", baseModel: "gpt-6-luna", env: { OPENAI_REASONING_EFFORT_TASK_CHAT: " High ", OPENAI_REASONING_EFFORT_TASK_OBSERVER: "hgih" } });
    assert.equal(router.reasoningEffort("chat"), "high");
    assert.equal(router.reasoningEffort("observer"), null);
    assert.equal(router.reasoningEffort("observer"), null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /OPENAI_REASONING_EFFORT_TASK_OBSERVER="hgih"/);
    const plan = renderModelPlan(router, { provider: "openai" });
    assert.match(plan, /User chat\s+gpt-6-luna  \(effort high\)/);
    assert.match(plan, /\(⚠ effort "hgih" is invalid, using global\)/);

    const provider = new OpenAIResponsesProvider({ apiKey: "k", model: "gpt-6-luna", router, reasoningEffort: "medium" });
    const efforts = [];
    provider.postResponses = async (body) => { efforts.push(body.reasoning?.effort ?? null); return { id: "r", output_text: "ok", output: [] }; };
    await provider.generate({ input: "hi", agent, messages: [], task: "observer" });
    await provider.generate({ input: "hi", agent, messages: [], task: "chat" });
    assert.deepEqual(efforts, ["medium", "high"]);
  } finally {
    console.warn = warn;
  }
});

test("provider sends the task's reasoning effort, falling back to the global one", async () => {
  const env = { OPENAI_REASONING_EFFORT_TASK_CHAT: "high" };
  const router = new ModelRouter({ envPrefix: "OPENAI", baseModel: "gpt-6-luna", env });
  const efforts = [];
  const make = (reasoningEffort) => {
    const provider = new OpenAIResponsesProvider({ apiKey: "k", model: "gpt-6-luna", router, reasoningEffort });
    provider.postResponses = async (body) => { efforts.push(body.reasoning?.effort ?? null); return { id: "r", output_text: "ok", output: [] }; };
    return provider;
  };
  const withGlobal = make("medium");
  await withGlobal.generate({ input: "hi", agent, messages: [], task: "chat" });
  await withGlobal.generate({ input: "hi", agent, messages: [], task: "observer" });
  const noGlobal = make(null);
  noGlobal.reasoningEffort = null;
  await noGlobal.generate({ input: "hi", agent, messages: [], task: "observer" });
  await noGlobal.generate({ input: "hi", agent, messages: [], task: "chat" });
  assert.deepEqual(efforts, ["high", "medium", null, "high"]);
});
