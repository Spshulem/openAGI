// The owner can ask the chat agent (Peri) to change ITS OWN reasoning effort
// from the current chat: "set your reasoning effort to extra high". The
// change is scoped to that one chat session, applies from the next message,
// is owner-only, and is read back from the persisted session.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDurableRuntime } from "../src/index.js";
import { registerCoreTools } from "../src/tool-registry.js";
import { ownerPrincipal, intentCovers } from "../src/owner-authority.js";
import { AnthropicProvider, OpenAIResponsesProvider } from "../src/model-provider.js";
import { ChatGPTPlanProvider } from "../src/chatgpt-provider.js";
import { CodexCliProvider } from "../src/cli-subscription-providers.js";
import { OfflineFallbackProvider } from "../src/offline-fallback-provider.js";
import { normalizeReasoningEffort, providerReasoningEffortSupport } from "../src/session-reasoning-effort.js";

function makeRuntime(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-chat-effort-"));
  const prevDataDir = process.env.OPENAGI_DATA_DIR;
  process.env.OPENAGI_DATA_DIR = dataDir;
  const runtime = createDurableRuntime({ dataDir, registerDefaults: false, integrations: false, skills: false, autoConnectMcp: false });
  registerCoreTools(runtime.tools, runtime);
  t.after(async () => {
    await runtime?.sessionIndex?.ready?.catch?.(() => {});
    for (const store of [runtime?.observations, runtime?.vectorStore, runtime?.sessionIndex]) store?.db?.close?.();
    if (prevDataDir === undefined) delete process.env.OPENAGI_DATA_DIR;
    else process.env.OPENAGI_DATA_DIR = prevDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return runtime;
}

// A real OpenAI Responses provider whose HTTP call is replaced: the first
// owner turn calls chat_reasoning_effort, every other call just answers.
function scriptedOpenAI(script) {
  const provider = new OpenAIResponsesProvider({ apiKey: "sk-test-0000000000000000", model: "gpt-6-luna", reasoningEffort: null });
  const bodies = [];
  provider.postResponses = async (body) => {
    bodies.push(structuredClone(body));
    const step = script.shift();
    if (step) return { id: `resp_${bodies.length}`, output: [{ type: "function_call", call_id: `call_${bodies.length}`, name: step.name, arguments: JSON.stringify(step.args) }] };
    return { id: `resp_${bodies.length}`, output_text: "ok", output: [] };
  };
  // Never reach the network, streamed or not.
  provider.postResponsesStream = (body, context) => provider.postResponses(body, context);
  provider.fetchImpl = async () => { throw new Error("network disabled in test"); };
  return { provider, bodies };
}

test("effort names normalize, including 'extra high'", () => {
  assert.equal(normalizeReasoningEffort("extra high"), "xhigh");
  assert.equal(normalizeReasoningEffort("Extra-High"), "xhigh");
  assert.equal(normalizeReasoningEffort("XHIGH"), "xhigh");
  assert.equal(normalizeReasoningEffort(" high "), "high");
  assert.equal(normalizeReasoningEffort("ultra"), null);
  assert.equal(normalizeReasoningEffort(""), null);
});

test("owner intent to change this chat's effort is recognized; questions and unrelated asks are not", () => {
  assert.equal(intentCovers("set your reasoning effort to extra high", "chat_reasoning_effort"), true);
  assert.equal(intentCovers("Peri, please raise your thinking level to high", "chat_reasoning_effort"), true);
  assert.equal(intentCovers("think harder on this", "chat_reasoning_effort"), true);
  assert.equal(intentCovers("reset your effort", "chat_reasoning_effort"), true);
  assert.equal(intentCovers("what is your reasoning effort?", "chat_reasoning_effort"), false);
  assert.equal(intentCovers("add $25 to my budget", "chat_reasoning_effort"), false);
});

test("owner sets Peri's own effort from chat: persisted, read back, sent on the next chat turn of that session only", async (t) => {
  const runtime = makeRuntime(t);
  const { provider, bodies } = scriptedOpenAI([{ name: "chat_reasoning_effort", args: { action: "set", effort: "extra high" } }]);
  runtime.agentHost.modelProvider = provider;
  const owner = ownerPrincipal("phone", "node-peri");

  const first = await runtime.agentHost.handleMessage(
    { text: "set your reasoning effort to extra high", sessionId: "peri-chat", channel: "local", routeTo: false },
    { principal: owner }
  );
  assert.ok(first.reply.length > 0);
  assert.equal(bodies[0].reasoning, undefined, "the turn that asks keeps the old effort");

  const call = runtime.agentHost.store.getSession("peri-chat").messages
    .flatMap((m) => m.metadata?.toolCalls ?? []).find((c) => c.name === "chat_reasoning_effort");
  assert.equal(call?.ok, true, "the owner's own words ran the change without a code");
  const saved = runtime.agentHost.store.getSession("peri-chat").metadata.reasoningEffort;
  assert.equal(saved.effort, "xhigh");
  assert.equal(saved.setBy, "owner:phone");

  const before = bodies.length;
  await runtime.agentHost.handleMessage({ text: "now think about the plan", sessionId: "peri-chat", channel: "local", routeTo: false }, { principal: owner });
  assert.deepEqual(bodies[before].reasoning, { effort: "xhigh" }, "next chat turn sends xhigh");

  const other = bodies.length;
  await runtime.agentHost.handleMessage({ text: "hello", sessionId: "another-chat", channel: "local", routeTo: false }, { principal: owner });
  assert.equal(bodies[other].reasoning, undefined, "another chat keeps the default");

  const auto = bodies.length;
  await runtime.agentHost.handleMessage({ text: "work the queue", sessionId: "peri-chat", channel: "autopilot", origin: "autopilot", routeTo: false });
  assert.equal(bodies[auto].reasoning, undefined, "background autopilot work in the same session is not changed");

  const read = await runtime.tools.invoke("chat_reasoning_effort", { action: "get" }, { sessionId: "peri-chat", agentId: "main" });
  assert.equal(read.ok, true);
  assert.equal(read.result.sessionOverride, "xhigh");
  assert.equal(read.result.effective, "xhigh");
  assert.equal(read.result.scope, "this chat session only");
  assert.ok(read.result.options.includes("xhigh"));

  const cleared = await runtime.tools.invoke("chat_reasoning_effort", { action: "clear" }, { sessionId: "peri-chat", agentId: "main", __owner: owner, __turn: { intent: "reset your effort" } });
  assert.equal(cleared.ok, true, JSON.stringify(cleared));
  assert.equal(cleared.result.sessionOverride, null);
  assert.equal(cleared.result.previous, "xhigh");
  assert.equal(runtime.agentHost.store.getSession("peri-chat").metadata.reasoningEffort, undefined);
});

test("a non-owner change is queued for the owner's approval and not applied", async (t) => {
  const runtime = makeRuntime(t);
  runtime.agentHost.modelProvider = scriptedOpenAI([]).provider;
  const queued = await runtime.tools.invoke("chat_reasoning_effort", { action: "set", effort: "xhigh" }, { sessionId: "peri-chat", agentId: "main", channel: "imessage" });
  assert.equal(queued.ok, true);
  assert.equal(queued.result.status, "awaiting_confirmation");
  assert.equal(runtime.agentHost.store.getSession("peri-chat").metadata?.reasoningEffort, undefined);
});

test("the handler itself refuses a change without owner authority", async (t) => {
  const runtime = makeRuntime(t);
  runtime.agentHost.modelProvider = scriptedOpenAI([]).provider;
  const tool = runtime.tools.get("chat_reasoning_effort");
  await assert.rejects(tool.handler({ action: "set", effort: "xhigh" }, { sessionId: "peri-chat" }), /Only the owner/);
  assert.equal(runtime.agentHost.store.getSession("peri-chat").metadata?.reasoningEffort, undefined);
});

test("unsupported providers report why and refuse to pretend a change took effect", async (t) => {
  const runtime = makeRuntime(t);
  runtime.agentHost.modelProvider = new AnthropicProvider({ apiKey: "sk-ant-test", model: "claude-opus-5-5" });
  const owner = ownerPrincipal("phone", "node-peri");
  const read = await runtime.tools.invoke("chat_reasoning_effort", { action: "get" }, { sessionId: "peri-chat" });
  assert.equal(read.result.supported, false);
  assert.match(read.result.unavailableReason, /does not expose/);
  const set = await runtime.tools.invoke("chat_reasoning_effort", { action: "set", effort: "high" }, { sessionId: "peri-chat", __owner: owner, __turn: { intent: "set your reasoning effort to high" } });
  assert.equal(set.ok, false);
  assert.match(set.error, /does not expose/);
  assert.equal(runtime.agentHost.store.getSession("peri-chat").metadata?.reasoningEffort, undefined);

  const bad = await runtime.tools.invoke("chat_reasoning_effort", { action: "set", effort: "ultra" }, { sessionId: "peri-chat", __owner: owner });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /not a reasoning effort/);
});

test("ChatGPT plan, phone offline wrapper, and Codex CLI expose and honor the per-turn effort", async () => {
  const chatgpt = new ChatGPTPlanProvider({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "openagi-cg-")), model: "gpt-6-luna" });
  const support = providerReasoningEffortSupport(chatgpt);
  assert.equal(support.supported, true);
  assert.equal(support.provider, "chatgpt");
  assert.ok(support.options.includes("xhigh"));

  const wrapped = new OfflineFallbackProvider(new OpenAIResponsesProvider({ apiKey: "sk-test-0000000000000000" }), { generate: async () => ({ text: "x" }) });
  assert.equal(providerReasoningEffortSupport(wrapped).supported, true);
  assert.equal(providerReasoningEffortSupport(new OfflineFallbackProvider(new AnthropicProvider({ apiKey: "k" }), {})).supported, false);

  const runs = [];
  const codex = new CodexCliProvider({
    bin: "/usr/bin/codex",
    env: {},
    run: async (bin, args, opts) => {
      runs.push(args);
      const out = args[args.indexOf("-o") + 1];
      fs.writeFileSync(out, JSON.stringify({ reply: "done", tool_calls: [] }));
      return { code: 0, stdout: "", stderr: "" };
    }
  });
  assert.equal(providerReasoningEffortSupport(codex).supported, true);
  await codex.generate({ input: "hi", reasoningEffort: "xhigh" });
  const i = runs[0].indexOf("-c");
  assert.ok(i > 0, "passes a -c override");
  assert.equal(runs[0][i + 1], 'model_reasoning_effort="xhigh"');
  await codex.generate({ input: "hi" });
  assert.equal(runs[1].includes("-c"), false, "no override keeps the CLI default");
  await codex.generate({ input: "hi", reasoningEffort: "none" });
  assert.equal(runs[2].includes("-c"), false, "values Codex does not accept are not sent");
});
