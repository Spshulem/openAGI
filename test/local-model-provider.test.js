import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalModelProvider } from "../src/local-model-provider.js";
import { createModelProvider } from "../src/model-provider.js";
import { ToolLoopContext, itemChars } from "../src/context-trim.js";

test("explicit local inference never falls through to a configured cloud provider", async () => {
  const provider = createModelProvider({ preferred: "local", anthropic: { apiKey: "cloud" }, local: { model: "" } });
  assert.equal(provider.name, "local");
  assert.equal(provider.isConfigured(), false);
  await assert.rejects(provider.generate({ input: "hi" }), /installed/);
});

test("automatic selection keeps a desktop with only a local model able to chat", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-local-auto-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const options = {
    preferred: "auto", mobile: false,
    anthropic: { apiKey: "" }, openai: { apiKey: "" }, chatgpt: { dataDir },
    local: { model: "local-fixture", fetchImpl: async () => Response.json({ choices: [{ message: { content: "Still connected" } }] }) }
  };
  const provider = createModelProvider(options);
  assert.ok(provider instanceof LocalModelProvider);
  assert.equal((await provider.generate({ input: "hi" })).text, "Still connected");
  assert.equal(createModelProvider({ ...options, anthropic: { apiKey: "configured" } }).constructor.name, "AnthropicProvider");
  assert.equal(createModelProvider({ ...options, local: { model: "" } }).constructor.name, "DeterministicModelProvider");
});

test("keyless local inference uses Chat Completions and does not send cloud credentials", async () => {
  const requests = [];
  const provider = new LocalModelProvider({ model: "llama3.2", fetchImpl: async (url, request) => {
    requests.push({ url, ...request });
    return Response.json({ choices: [{ message: { content: "Hello" } }] });
  } });
  const result = await provider.generate({ input: "hi", agent: { name: "test" } });
  assert.equal(result.text, "Hello");
  assert.equal(requests[0].url, "http://localhost:11434/v1/chat/completions");
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(JSON.parse(requests[0].body).messages.at(-1).content, "hi");
});

test("local tool calls use the normal registry and return results to the model", async () => {
  const requests = [], invoked = [];
  const replies = [
    { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "recall", arguments: '{"query":"style"}' } }] },
    { content: "You prefer short replies." }
  ];
  const provider = new LocalModelProvider({ model: "llama", fetchImpl: async (_url, request) => {
    requests.push(JSON.parse(request.body));
    return Response.json({ choices: [{ message: replies.shift() }] });
  } });
  const context = { approval: "normal-gates" };
  const result = await provider.generate({ input: "How do I work?", context, agent: { name: "test" }, toolRegistry: {
    toOpenAITools: () => [{ name: "recall", parameters: { type: "object" } }],
    invoke: async (...args) => { invoked.push(args); return { ok: true, result: "short replies" }; }
  } });
  assert.equal(result.toolCalls.length, 1);
  assert.deepEqual(invoked[0], ["recall", { query: "style" }, context]);
  assert.equal(requests[1].messages.at(-1).role, "tool");
  assert.equal(requests[1].messages.at(-1).tool_call_id, "call-1");
});

test("failed and empty local responses cannot masquerade as a working model", async () => {
  for (const response of [new Response("down", { status: 503 }), Response.json({ choices: [{ message: { content: "" } }] })]) {
    const provider = new LocalModelProvider({ model: "llama", fetchImpl: async () => response });
    await assert.rejects(provider.generate({ input: "hi", agent: { name: "test" } }), /HTTP 503|no answer/);
  }
});

test("local vision models receive screenshot bytes as an image and preserve tool-call pairing", async () => {
  const image = "A".repeat(40_000);
  const requests = [];
  const replies = [
    { content: null, tool_calls: [
      { id: "screen-1", type: "function", function: { name: "computer_screenshot", arguments: "{}" } },
      { id: "recall-1", type: "function", function: { name: "recall", arguments: "{}" } },
      { id: "screen-2", type: "function", function: { name: "computer_screenshot", arguments: "{}" } }
    ] },
    { content: "I can see the screen." }
  ];
  const provider = new LocalModelProvider({ model: "vision-fixture", fetchImpl: async (_url, request) => {
    requests.push(JSON.parse(request.body));
    return Response.json({ choices: [{ message: replies.shift() }] });
  } });
  await provider.generate({ input: "What is on screen?", toolRegistry: {
    toOpenAITools: () => [{ name: "computer_screenshot" }, { name: "recall" }],
    invoke: async name => ({ ok: true, result: name === "recall" ? "A saved note" : { image, format: "png", width: 1280, height: 900 } })
  } });
  const messages = requests[1].messages;
  assert.deepEqual(messages.map(message => message.role), ["system", "user", "assistant", "tool", "tool", "tool", "user", "user"]);
  assert.deepEqual(messages.filter(message => message.role === "tool").map(message => message.tool_call_id), ["screen-1", "recall-1", "screen-2"]);
  const result = messages.find(message => message.role === "tool");
  assert.equal(result.tool_call_id, "screen-1");
  assert.doesNotMatch(result.content, /AAAA/);
  assert.match(result.content, /attached as image/);
  const vision = messages.at(-1).content;
  assert.equal(vision[1].image_url.url, "data:image/png;base64," + image);
  assert.match(vision[0].text, /1280×900/);
  assert.equal(itemChars(messages.at(-1)), 6_000 + vision[0].text.length, "base64 length must not inflate the context estimate");
});

test("context trimming preserves local tool-call pairing and trims the content field", () => {
  const budget = new ToolLoopContext({ maxInputTokens: 1_000 });
  const old = budget.mark({ role: "tool", tool_call_id: "old-call", content: "x".repeat(10_000) }, { kind: "output", contentKey: "content", tool: "recall", hop: 0 });
  const recent = budget.mark({ role: "tool", tool_call_id: "latest-call", content: "recent" }, { kind: "output", contentKey: "content", tool: "recall", hop: 1 });
  budget.fit([old, recent]);
  assert.match(old.content, /tool output trimmed/);
  assert.equal(old.tool_call_id, "old-call");
  assert.equal(old.output, undefined);
  assert.equal(recent.content, "recent");
});
