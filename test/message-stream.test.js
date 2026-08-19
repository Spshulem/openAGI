import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AnthropicProvider,
  OpenAIResponsesProvider,
  createDefaultRuntime,
  createHostedInterface
} from "../src/index.js";
import { redactFailureDiagnostic } from "../src/agent-failure.js";

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openagi-message-stream-"));
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function parseSse(text) {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "message";
      const data = lines.filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
      return { event, data: data ? JSON.parse(data) : null };
    });
}

function providerSse(events) {
  return new Response(events.map((event) => {
    const name = event.event ?? event.type ?? "message";
    return `event: ${name}\ndata: ${JSON.stringify(event)}\n\n`;
  }).join(""), { headers: { "content-type": "text/event-stream" } });
}

function hangingProviderSse(events, onCancel = () => {}) {
  const bytes = new TextEncoder().encode(events.map((event) => {
    const name = event.event ?? event.type ?? "message";
    return `event: ${name}\ndata: ${JSON.stringify(event)}\n\n`;
  }).join(""));
  return new Response(new ReadableStream({
    start(controller) { controller.enqueue(bytes); },
    cancel() { onCancel(); }
  }), { headers: { "content-type": "text/event-stream" } });
}

async function within(promise, timeoutMs = 1_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`test timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function finalTurn(sessionId = "overlay:user:main") {
  return {
    id: "turn_test",
    createdAt: "2026-08-09T12:00:00.000Z",
    agent: { id: "main", name: "Main Agent", role: "root" },
    session: { id: sessionId, messageCount: 2 },
    reply: "Done.",
    model: { provider: "test", model: "test-model", configured: true },
    output: { id: "out_test" }
  };
}

test("streaming /message sends the persisted session before a slow turn finishes", async () => {
  const finish = deferred();
  const turn = finalTurn();
  const channels = {
    async handleLocalMessage(_body, { onProgress, onTextDelta } = {}) {
      onProgress?.({
        stage: "accepted",
        at: "2026-08-09T12:00:00.000Z",
        session: { id: turn.session.id, messageCount: 1 },
        agent: turn.agent
      });
      onProgress?.({ stage: "thinking", at: "2026-08-09T12:00:01.000Z", sessionId: turn.session.id });
      onTextDelta?.({
        text: "Working ", reset: true, provider: "test", model: "safe-model", hop: 1,
        sessionId: turn.session.id,
        arguments: { secret: "must-not-stream" },
        result: { private: "also-must-not-stream" },
        reasoning: "hidden-chain-of-thought"
      });
      await finish.promise;
      return turn;
    },
    start() {},
    stop() {}
  };
  const app = createHostedInterface(createDefaultRuntime(), {
    port: 0,
    channels,
    dataDir: tempDataDir(),
    tickerMs: 60_000
  });
  const address = await app.listen();

  try {
    const response = await fetch(`${address.url}/message`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        channel: "overlay",
        from: "user",
        text: "do a slow thing",
        metadata: { requestId: "req-stream-text" }
      })
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);

    // Headers and the early lifecycle arrive while the underlying agent turn
    // is still deliberately blocked. This is what prevents the old 60-second
    // opaque wait and gives the client a valid Continue-in-chat destination.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let prefix = "";
    while (!prefix.includes("event: session\n")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, "stream ended before session identity");
      prefix += decoder.decode(chunk.value, { stream: true });
    }
    const early = parseSse(prefix);
    assert.equal(early[0].event, "status");
    assert.equal(early[0].data.stage, "queued");
    const session = early.find((item) => item.event === "session");
    assert.deepEqual(session?.data, {
      id: "overlay:user:main",
      messageCount: 1,
      agent: { id: "main", name: "Main Agent", role: "root" },
      requestId: "req-stream-text"
    });

    finish.resolve();
    let rest = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += decoder.decode(chunk.value, { stream: true });
    }
    rest += decoder.decode();
    const events = parseSse(prefix + rest);
    const final = events.find((item) => item.event === "final");
    assert.deepEqual(final?.data, turn, "final event preserves the legacy JSON response shape");
    const delta = events.find((item) => item.event === "delta");
    assert.deepEqual(delta?.data, {
      text: "Working ",
      reset: true,
      at: delta?.data?.at,
      provider: "test",
      model: "safe-model",
      sessionId: "overlay:user:main",
      hop: 1,
      requestId: "req-stream-text"
    });
    assert.equal(JSON.stringify(delta?.data).includes("must-not-stream"), false);
    assert.equal(JSON.stringify(delta?.data).includes("hidden-chain-of-thought"), false);
  } finally {
    finish.resolve();
    await app.close();
  }
});

test("streaming /message reports a terminal failure after revealing its session", async () => {
  const channels = {
    async handleLocalMessage(_body, { onProgress } = {}) {
      onProgress?.({ stage: "accepted", session: { id: "overlay:user:main", messageCount: 1 } });
      const error = new Error("Daily budget exceeded");
      error.code = "BUDGET_EXCEEDED";
      throw error;
    },
    start() {},
    stop() {}
  };
  const app = createHostedInterface(createDefaultRuntime(), {
    port: 0,
    channels,
    dataDir: tempDataDir(),
    tickerMs: 60_000
  });
  const address = await app.listen();

  try {
    const response = await fetch(`${address.url}/message`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ text: "slow request", metadata: { requestId: "req-stream-failure" } })
    });
    const events = parseSse(await response.text());
    const failure = events.find((item) => item.event === "failure");
    assert.deepEqual(failure?.data, {
      code: "budget",
      error: "Daily budget exceeded",
      sessionId: "overlay:user:main",
      requestId: "req-stream-failure"
    });
    assert.equal(events.some((item) => item.event === "final"), false);
  } finally {
    await app.close();
  }
});

test("legacy JSON /message remains synchronous and auth still gates stream negotiation", async () => {
  let calls = 0;
  const turn = finalTurn("local:test:main");
  const channels = {
    async handleLocalMessage() { calls += 1; return turn; },
    start() {},
    stop() {}
  };
  const app = createHostedInterface(createDefaultRuntime(), {
    port: 0,
    authToken: "stream-secret",
    channels,
    dataDir: tempDataDir(),
    tickerMs: 60_000
  });
  const address = await app.listen();

  try {
    const denied = await fetch(`${address.url}/message`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ text: "no credential" })
    });
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get("content-type") ?? "", /^application\/json/);
    assert.equal(calls, 0, "unauthorized stream request never reaches the agent");

    const legacy = await fetch(`${address.url}/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer stream-secret"
      },
      body: JSON.stringify({ from: "test", text: "legacy request" })
    });
    assert.equal(legacy.status, 200);
    assert.match(legacy.headers.get("content-type") ?? "", /^application\/json/);
    assert.deepEqual(await legacy.json(), turn);
    assert.equal(calls, 1);
  } finally {
    await app.close();
  }
});

test("agent/provider progress exposes model and tool hops without arguments or results", async () => {
  const provider = new OpenAIResponsesProvider({ apiKey: "test", model: "gpt-test", maxToolHops: 1 });
  let responseCount = 0;
  provider.postResponses = async () => {
    responseCount += 1;
    if (responseCount === 1) {
      return {
        output: [{ type: "function_call", call_id: "call_1", name: "safe_tool", arguments: JSON.stringify({ secret: "must-not-stream" }) }]
      };
    }
    return { id: "resp_1", output_text: "Finished", output: [] };
  };
  const progress = [];
  const result = await provider.generate({
    input: "do it",
    agent: { name: "Agent" },
    maxToolHops: 2,
    tools: [{ type: "function", name: "safe_tool", description: "", parameters: { type: "object" } }],
    toolRegistry: { invoke: async () => ({ ok: true, result: { private: "also-not-streamed" } }) },
    onProgress: (event) => progress.push(event)
  });

  assert.equal(result.text, "Finished");
  assert.deepEqual(progress, [
    { stage: "model", provider: "openai", model: "gpt-test", hop: 1, maxToolHops: 2 },
    { stage: "tool", provider: "openai", model: "gpt-test", hop: 1, tool: "safe_tool" },
    { stage: "model", provider: "openai", model: "gpt-test", hop: 2, maxToolHops: 2 }
  ]);
  assert.equal(JSON.stringify(progress).includes("must-not-stream"), false);
  assert.equal(JSON.stringify(progress).includes("also-not-streamed"), false);
});

test("OpenAI reserves a no-tools final answer after exhausting tool hops", async () => {
  const provider = new OpenAIResponsesProvider({ apiKey: "test", model: "gpt-test", maxToolHops: 2 });
  const bodies = [];
  const responses = [
    { output: [{ type: "function_call", call_id: "call_1", name: "safe_tool", arguments: "{}" }] },
    { output: [{ type: "function_call", call_id: "call_2", name: "safe_tool", arguments: "{}" }] },
    { id: "resp_final", output_text: "Finished after two tools.", output: [] }
  ];
  provider.postResponses = async (body) => {
    bodies.push(body);
    return responses.shift();
  };
  const invoked = [];
  const result = await provider.generate({
    input: "use all the tools",
    agent: { name: "Agent" },
    tools: [{ type: "function", name: "safe_tool", description: "", parameters: { type: "object" } }],
    toolRegistry: {
      invoke: async (_name, _args) => {
        invoked.push("called");
        return { ok: true, result: { done: true } };
      }
    }
  });

  assert.equal(result.text, "Finished after two tools.");
  assert.equal(invoked.length, 2, "the final answer retry must not repeat a tool");
  assert.equal(bodies.length, 3);
  assert.ok(Array.isArray(bodies[0].tools));
  assert.ok(Array.isArray(bodies[1].tools));
  assert.equal("tools" in bodies[2], false, "the synthesis request must not advertise tools");
  assert.match(bodies[2].instructions, /Return a user-visible final answer now/);
});

test("OpenAI retries an empty terminal response once without tools, then fails explicitly", async () => {
  const provider = new OpenAIResponsesProvider({ apiKey: "test", model: "gpt-test", maxToolHops: 1 });
  const bodies = [];
  provider.postResponses = async (body) => {
    bodies.push(body);
    return { id: `empty_${bodies.length}`, output: [] };
  };

  await assert.rejects(
    provider.generate({ input: "answer me", agent: { name: "Agent" }, tools: [{ name: "unused" }] }),
    (error) => error?.code === "EMPTY_MODEL_RESPONSE"
  );
  assert.equal(bodies.length, 2);
  assert.equal("tools" in bodies[1], false);
});

test("OpenAI attaches computer screenshots as native image inputs", async () => {
  const provider = new OpenAIResponsesProvider({ apiKey: "test", model: "gpt-test", maxToolHops: 1 });
  const bodies = [];
  const responses = [
    {
      id: "resp_tool",
      output: [{ type: "function_call", call_id: "call_screen", name: "computer_screenshot", arguments: "{}" }]
    },
    { id: "resp_final", output_text: "I can see the screen.", output: [] }
  ];
  provider.postResponses = async (body) => {
    bodies.push(body);
    return responses.shift();
  };

  const result = await provider.generate({
    input: "inspect the screen",
    agent: { name: "Agent" },
    tools: [{ type: "function", name: "computer_screenshot", description: "", parameters: { type: "object" } }],
    toolRegistry: {
      invoke: async () => ({
        ok: true,
        result: { image: "cG5nLWJ5dGVz", format: "png", width: 1280, height: 800, frameId: "frame_1" }
      })
    }
  });

  assert.equal(result.text, "I can see the screen.");
  const imageTurn = bodies[1].input.find((item) => item?.role === "user" && Array.isArray(item.content));
  assert.ok(imageTurn);
  assert.deepEqual(imageTurn.content[1], {
    type: "input_image",
    image_url: "data:image/png;base64,cG5nLWJ5dGVz"
  });
  const toolOutput = bodies[1].input.find((item) => item?.type === "function_call_output");
  assert.match(toolOutput.output, /attached as image below/);
  assert.equal(toolOutput.output.includes("cG5nLWJ5dGVz"), false,
    "base64 is not duplicated into the textual result");
});

test("Anthropic honors a per-turn tool-hop override and still reserves a no-tools final answer", async () => {
  const provider = new AnthropicProvider({ apiKey: "test", model: "claude-test", maxToolHops: 1 });
  const bodies = [];
  const responses = [
    { id: "msg_tool", content: [{ type: "tool_use", id: "tool_1", name: "safe_tool", input: {} }] },
    { id: "msg_tool_2", content: [{ type: "tool_use", id: "tool_2", name: "safe_tool", input: {} }] },
    { id: "msg_final", content: [{ type: "text", text: "Finished safely." }] }
  ];
  provider.postMessages = async (body) => {
    bodies.push(body);
    return responses.shift();
  };
  let invoked = 0;
  const result = await provider.generate({
    input: "use the tool",
    agent: { name: "Agent" },
    maxToolHops: 2,
    toolRegistry: {
      toAnthropicTools: () => [{ name: "safe_tool", description: "", input_schema: { type: "object" } }],
      invoke: async () => {
        invoked += 1;
        return { ok: true, result: { done: true } };
      }
    }
  });

  assert.equal(result.text, "Finished safely.");
  assert.equal(invoked, 2);
  assert.equal(bodies.length, 3);
  assert.ok(Array.isArray(bodies[0].tools));
  assert.ok(Array.isArray(bodies[1].tools));
  assert.equal("tools" in bodies[2], false);
});

test("Anthropic retries an empty terminal response once without tools, then fails explicitly", async () => {
  const provider = new AnthropicProvider({ apiKey: "test", model: "claude-test", maxToolHops: 1 });
  const bodies = [];
  provider.postMessages = async (body) => {
    bodies.push(body);
    return { id: `empty_${bodies.length}`, content: [] };
  };

  await assert.rejects(
    provider.generate({ input: "answer me", agent: { name: "Agent" } }),
    (error) => error?.code === "EMPTY_MODEL_RESPONSE"
  );
  assert.equal(bodies.length, 2);
  assert.equal("tools" in bodies[1], false);
  assert.deepEqual(bodies[1].messages, [{ role: "user", content: "answer me" }]);
});

test("Anthropic attaches computer screenshots as native image tool results", async () => {
  const provider = new AnthropicProvider({ apiKey: "test", model: "claude-test", maxToolHops: 1 });
  const bodies = [];
  const responses = [
    { id: "msg_tool", content: [{ type: "tool_use", id: "tool_screen", name: "computer_screenshot", input: {} }] },
    { id: "msg_final", content: [{ type: "text", text: "I can see the screen." }] }
  ];
  provider.postMessages = async (body) => {
    bodies.push(body);
    return responses.shift();
  };

  const result = await provider.generate({
    input: "inspect the screen",
    agent: { name: "Agent" },
    toolRegistry: {
      toAnthropicTools: () => [{ name: "computer_screenshot", description: "", input_schema: { type: "object" } }],
      invoke: async () => ({
        ok: true,
        result: { image: "cG5nLWJ5dGVz", format: "png", width: 1280, height: 800, frameId: "frame_1" }
      })
    }
  });

  assert.equal(result.text, "I can see the screen.");
  const toolResult = bodies[1].messages.at(-1).content[0];
  assert.equal(toolResult.type, "tool_result");
  assert.deepEqual(toolResult.content[1], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "cG5nLWJ5dGVz" }
  });
  assert.match(toolResult.content[0].text, /attached as image below/);
  assert.equal(toolResult.content[0].text.includes("cG5nLWJ5dGVz"), false,
    "base64 is not duplicated into the textual result");
});

test("OpenAI streams visible text across tool hops without exposing tool data", async () => {
  const sentBodies = [];
  const responses = [
    providerSse([
      { type: "response.output_text.delta", delta: "Checking first" },
      {
        type: "response.completed",
        response: {
          id: "resp_tool",
          output_text: "Checking first",
          output: [
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking first" }] },
            { type: "function_call", call_id: "call_1", name: "safe_tool", arguments: '{"secret":"must-not-stream"}' }
          ],
          usage: { input_tokens: 10, output_tokens: 2 }
        }
      }
    ]),
    providerSse([
      { type: "response.output_text.delta", delta: "Final " },
      { type: "response.output_text.delta", delta: "answer" },
      {
        type: "response.completed",
        response: {
          id: "resp_final",
          output_text: "Final answer",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Final answer" }] }],
          usage: { input_tokens: 12, output_tokens: 3 }
        }
      }
    ])
  ];
  const provider = new OpenAIResponsesProvider({
    apiKey: "test",
    model: "gpt-test",
    maxToolHops: 2,
    fetchImpl: async (_url, options) => {
      sentBodies.push(JSON.parse(options.body));
      return responses.shift();
    }
  });
  const deltas = [];
  const invoked = [];
  const result = await provider.generate({
    input: "use the tool",
    agent: { name: "Agent" },
    tools: [{ type: "function", name: "safe_tool", description: "", parameters: { type: "object" } }],
    toolRegistry: {
      invoke: async (name, args) => {
        invoked.push([name, args]);
        return { ok: true, result: { private: "also-must-not-stream" } };
      }
    },
    onTextDelta: (delta) => deltas.push(delta)
  });

  assert.equal(result.text, "Final answer");
  assert.deepEqual(invoked, [["safe_tool", { secret: "must-not-stream" }]]);
  assert.equal(sentBodies.length, 2);
  assert.equal(sentBodies.every((body) => body.stream === true), true);
  assert.deepEqual(deltas.map(({ text, reset, hop }) => ({ text, reset, hop })), [
    { text: "Checking first", reset: true, hop: 1 },
    { text: "Final ", reset: true, hop: 2 },
    { text: "answer", reset: false, hop: 2 }
  ]);
  assert.equal(JSON.stringify(deltas).includes("must-not-stream"), false);
  assert.equal(JSON.stringify(deltas).includes("also-must-not-stream"), false);
});

test("OpenAI preserves a streamed refusal as the authoritative final reply", async () => {
  const refusal = "I can't help with that request.";
  const provider = new OpenAIResponsesProvider({
    apiKey: "test",
    model: "gpt-test",
    fetchImpl: async () => providerSse([
      { type: "response.refusal.delta", delta: "I can't help " },
      { type: "response.refusal.delta", delta: "with that request." },
      {
        type: "response.completed",
        response: {
          id: "resp_refusal",
          output: [{
            type: "message",
            role: "assistant",
            content: [{ type: "refusal", refusal }]
          }],
          usage: { input_tokens: 4, output_tokens: 7 }
        }
      }
    ])
  });
  const deltas = [];
  const result = await provider.generate({
    input: "unsafe request",
    agent: { name: "Agent" },
    onTextDelta: (delta) => deltas.push(delta)
  });

  assert.equal(deltas.map((delta) => delta.text).join(""), refusal);
  assert.equal(result.text, refusal, "the persisted final reply must match the streamed refusal");
});

test("provider streams stop on terminal events without waiting for HTTP EOF", async () => {
  let openAiCancelled = false;
  const openai = new OpenAIResponsesProvider({
    apiKey: "test",
    model: "gpt-test",
    timeoutMs: 5_000,
    fetchImpl: async () => hangingProviderSse([
      { type: "response.output_text.delta", delta: "Finished" },
      {
        type: "response.completed",
        response: {
          id: "resp_terminal",
          output_text: "Finished",
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Finished" }] }],
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      }
    ], () => { openAiCancelled = true; })
  });
  const openAiResult = await within(openai.generate({
    input: "finish",
    agent: { name: "Agent" },
    onTextDelta: () => {}
  }), 500);
  assert.equal(openAiResult.text, "Finished");
  assert.equal(openAiCancelled, true, "OpenAI body is cancelled after response.completed");

  let anthropicCancelled = false;
  const anthropic = new AnthropicProvider({
    apiKey: "test",
    model: "claude-test",
    timeoutMs: 5_000,
    fetchImpl: async () => hangingProviderSse([
      { type: "message_start", message: { id: "msg_terminal", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Finished" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" }
    ], () => { anthropicCancelled = true; })
  });
  const anthropicResult = await within(anthropic.generate({
    input: "finish",
    agent: { name: "Agent" },
    onTextDelta: () => {}
  }), 500);
  assert.equal(anthropicResult.text, "Finished");
  assert.equal(anthropicCancelled, true, "Anthropic body is cancelled after message_stop");
});

test("provider streams keep an absolute deadline even while chunks arrive", async () => {
  let chunks = 0;
  const provider = new OpenAIResponsesProvider({
    apiKey: "test",
    model: "gpt-test",
    timeoutMs: 80,
    fetchImpl: async (_url, { signal }) => new Response(new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const send = () => {
          chunks += 1;
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        };
        const timer = setInterval(send, 5);
        send();
        signal.addEventListener("abort", () => {
          clearInterval(timer);
          try { controller.error(signal.reason ?? new Error("aborted")); } catch { /* stream already closed */ }
        }, { once: true });
      }
    }), { headers: { "content-type": "text/event-stream" } })
  });

  await within(assert.rejects(provider.generate({
    input: "never finish",
    agent: { name: "Agent" },
    onTextDelta: () => {}
  }), /absolute timeout/i), 1_000);
  assert.ok(chunks > 2, "the upstream was active, so an idle-only timeout would not fire");
});

test("provider SSE parser bounds frames, undelimited buffers, and total bytes", async () => {
  const invoke = (body, streamLimits) => new OpenAIResponsesProvider({
    apiKey: "test",
    model: "gpt-test",
    streamLimits,
    fetchImpl: async () => new Response(body, { headers: { "content-type": "text/event-stream" } })
  }).generate({ input: "bounded", agent: { name: "Agent" }, onTextDelta: () => {} });

  const oversizedFrame = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(256) })}\n\n`;
  await assert.rejects(
    invoke(oversizedFrame, { maxFrameBytes: 128, maxBufferBytes: 1_024, maxTotalBytes: 2_048 }),
    /SSE frame exceeded 128 bytes/
  );
  await assert.rejects(
    invoke(`data: ${"x".repeat(128)}`, { maxFrameBytes: 512, maxBufferBytes: 64, maxTotalBytes: 1_024 }),
    /SSE buffer exceeded 64 bytes/
  );
  await assert.rejects(
    invoke(": ping\n\n".repeat(20), { maxFrameBytes: 64, maxBufferBytes: 64, maxTotalBytes: 80 }),
    /SSE stream exceeded 80 total bytes/
  );
});

test("Anthropic stream rejects sparse content block indexes", async () => {
  const provider = new AnthropicProvider({
    apiKey: "test",
    model: "claude-test",
    fetchImpl: async () => providerSse([
      { type: "message_start", message: { id: "msg_sparse", role: "assistant", content: [] } },
      { type: "content_block_start", index: 1_000_000_000, content_block: { type: "text", text: "" } }
    ])
  });
  await assert.rejects(provider.generate({
    input: "bounded",
    agent: { name: "Agent" },
    onTextDelta: () => {}
  }), /out-of-range content block index/);
});

test("Anthropic streams text but keeps thinking and incremental tool JSON private", async () => {
  const sentBodies = [];
  const responses = [
    providerSse([
      { type: "message_start", message: { id: "msg_tool", type: "message", role: "assistant", model: "claude-test", content: [], usage: { input_tokens: 8, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hidden-chain-of-thought" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Checking first" } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tool_1", name: "safe_tool", input: {} } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"secret":' } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"must-not-stream"}' } },
      { type: "content_block_stop", index: 2 },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 6 } },
      { type: "message_stop" }
    ]),
    providerSse([
      { type: "message_start", message: { id: "msg_final", type: "message", role: "assistant", model: "claude-test", content: [], usage: { input_tokens: 12, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Final " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: "message_stop" }
    ])
  ];
  const provider = new AnthropicProvider({
    apiKey: "test",
    model: "claude-test",
    maxToolHops: 2,
    fetchImpl: async (_url, options) => {
      sentBodies.push(JSON.parse(options.body));
      return responses.shift();
    }
  });
  const deltas = [];
  const invoked = [];
  const result = await provider.generate({
    input: "use the tool",
    agent: { name: "Agent" },
    toolRegistry: {
      toAnthropicTools: () => [{ name: "safe_tool", description: "", input_schema: { type: "object" } }],
      invoke: async (name, args) => {
        invoked.push([name, args]);
        return { ok: true, result: { private: "also-must-not-stream" } };
      }
    },
    onTextDelta: (delta) => deltas.push(delta)
  });

  assert.equal(result.text, "Final answer");
  assert.deepEqual(invoked, [["safe_tool", { secret: "must-not-stream" }]]);
  assert.equal(sentBodies.length, 2);
  assert.equal(sentBodies.every((body) => body.stream === true), true);
  assert.deepEqual(deltas.map(({ text, reset, hop }) => ({ text, reset, hop })), [
    { text: "Checking first", reset: true, hop: 1 },
    { text: "Final ", reset: true, hop: 2 },
    { text: "answer", reset: false, hop: 2 }
  ]);
  assert.equal(JSON.stringify(deltas).includes("must-not-stream"), false);
  assert.equal(JSON.stringify(deltas).includes("hidden-chain-of-thought"), false);
  assert.equal(JSON.stringify(deltas).includes("also-must-not-stream"), false);
});

test("a failed agent turn is durable and broadcasts terminal state to other chat clients", async () => {
  const runtime = createDefaultRuntime();
  runtime.agentHost.modelProvider = {
    name: "failing-test-provider",
    model: "test-model",
    isConfigured: () => true,
    async generate() { throw new Error("provider unavailable"); }
  };
  const app = createHostedInterface(runtime, {
    port: 0,
    dataDir: tempDataDir(),
    tickerMs: 60_000
  });
  const address = await app.listen();
  let eventsReader = null;

  try {
    const eventResponse = await fetch(`${address.url}/events`);
    eventsReader = eventResponse.body.getReader();
    // Drain the hello frame so the next read is the agent terminal event.
    await eventsReader.read();

    const response = await fetch(`${address.url}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "overlay",
        from: "user",
        text: "please try this",
        metadata: { requestId: "req-test-1" }
      })
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      code: "provider-unavailable",
      error: "The model provider is unavailable. Check its connection and try again.",
      sessionId: "overlay:user:main"
    });

    const session = runtime.agentHost.store.getSession("overlay:user:main");
    assert.equal(session.messages.length, 2);
    assert.equal(session.messages[0].role, "user");
    assert.equal(session.messages[1].role, "assistant");
    assert.match(session.messages[1].content, /model provider is unavailable/i);
    assert.deepEqual(session.messages[1].metadata, {
      status: "failed",
      code: "provider-unavailable",
      requestId: "req-test-1"
    });

    let eventText = "";
    while (!eventText.includes("event: message\n")) {
      const chunk = await eventsReader.read();
      assert.equal(chunk.done, false);
      eventText += new TextDecoder().decode(chunk.value);
    }
    const terminal = parseSse(eventText).find((item) => item.event === "message");
    assert.equal(terminal?.data.sessionId, "overlay:user:main");
    assert.equal(terminal?.data.requestId, "req-test-1");
    assert.equal(terminal?.data.status, "failed");
    assert.equal(terminal?.data.code, "provider-unavailable");
  } finally {
    await eventsReader?.cancel().catch(() => {});
    await app.close();
  }
});

test("agent host rejects provider placeholders instead of persisting them as successful answers", async () => {
  const runtime = createDefaultRuntime();
  runtime.agentHost.modelProvider = {
    name: "empty-test-provider",
    model: "test-model",
    isConfigured: () => true,
    async generate() {
      return { id: "empty_response", text: "(no text)", provider: "test", model: "test-model", toolCalls: [] };
    }
  };

  await assert.rejects(
    runtime.agentHost.handleMessage({
      channel: "overlay",
      from: "user",
      text: "please answer",
      metadata: { requestId: "req-empty-1" }
    }),
    (error) => error?.code === "EMPTY_MODEL_RESPONSE"
  );

  const session = runtime.agentHost.store.getSession("overlay:user:main");
  assert.equal(session.messages.length, 2);
  assert.equal(session.messages.some((message) => message.content === "(no text)"), false);
  assert.match(session.messages[1].content, /model returned no answer after retrying/i);
  assert.deepEqual(session.messages[1].metadata, {
    status: "failed",
    code: "provider-empty-response",
    requestId: "req-empty-1"
  });
});

test("provider diagnostics redact credentials, private URLs, and local paths", () => {
  const diagnostic = redactFailureDiagnostic(
    "Bearer secret-token-123 at https://user:pass@example.test/private/route?api_key=secret-value " +
    "from file:///Users/example/OpenAGI/src/provider.js and /private/tmp/openagi/provider.log"
  );
  for (const secret of ["secret-token-123", "user:pass", "/private/route", "secret-value", "/Users/example", "/private/tmp/openagi"]) {
    assert.equal(diagnostic.includes(secret), false, `diagnostic leaked ${secret}`);
  }
  assert.match(diagnostic, /https:\/\/example\.test\/\[REDACTED\]/);
  assert.match(diagnostic, /file:\/\/\/\[LOCAL_PATH\]/);
});

test("a successful agent turn persists the same bounded request id on both sides", async () => {
  const runtime = createDefaultRuntime();
  runtime.agentHost.modelProvider = {
    name: "successful-test-provider",
    model: "test-model",
    isConfigured: () => true,
    async generate() {
      return {
        id: "response_test",
        text: "Finished.",
        provider: "test",
        model: "test-model",
        toolCalls: []
      };
    }
  };
  const longRequestId = `req_${"x".repeat(300)}`;

  const result = await runtime.agentHost.handleMessage({
    channel: "overlay",
    from: "user",
    text: "finish this",
    metadata: { requestId: longRequestId }
  });

  const session = runtime.agentHost.store.getSession(result.session.id);
  assert.equal(session.messages.length, 2);
  assert.equal(session.messages[0].metadata.requestId.length, 200);
  assert.equal(session.messages[1].metadata.requestId, session.messages[0].metadata.requestId);
});

test("same-session turns are serialized so replies and mutating tools cannot race", async () => {
  const runtime = createDefaultRuntime();
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  runtime.agentHost.modelProvider = {
    name: "serialized-test-provider",
    model: "test-model",
    isConfigured: () => true,
    async generate({ input }) {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls === 1) await firstGate;
      active -= 1;
      return { id: `response_${calls}`, text: `reply:${input}`, provider: "test", model: "test-model", toolCalls: [] };
    }
  };

  const first = runtime.agentHost.handleMessage({ text: "first", sessionId: "shared", metadata: { requestId: "req_1" } });
  while (calls === 0) await new Promise((resolve) => setImmediate(resolve));
  const second = runtime.agentHost.handleMessage({ text: "second", sessionId: "shared", metadata: { requestId: "req_2" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, "the second provider turn waits for the first");
  releaseFirst();
  await Promise.all([first, second]);

  assert.equal(maxActive, 1);
  assert.deepEqual(runtime.agentHost.store.getSession("shared").messages.map((message) => [message.role, message.content]), [
    ["user", "first"], ["assistant", "reply:first"],
    ["user", "second"], ["assistant", "reply:second"]
  ]);
});

test("dashboard stream ownership detaches when the user switches sessions", async (t) => {
  const priorKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-only-not-a-real-key";
  const dataDir = tempDataDir();
  const app = createHostedInterface(createDefaultRuntime(), {
    port: 0,
    dataDir,
    tickerMs: 60_000
  });
  const address = await app.listen();
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorKey;
  });

  const html = await (await fetch(address.url)).text();
  const script = html.match(/<script[^>]*>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script, "dashboard includes its client script");
  const helperSource = script.match(/function chatRequestOwnsVisibleState\([\s\S]*?\n\}/)?.[0];
  assert.ok(helperSource, "dashboard exposes one request-ownership predicate");
  const owns = new Function(`${helperSource}; return chatRequestOwnsVisibleState;`)();

  const current = { tab: "chat", sessionId: "session-a", activeRequestId: "req-a" };
  assert.equal(owns(current, ["session-a", "session-a-canonical"], "req-a"), true);
  current.sessionId = "session-b";
  assert.equal(owns(current, ["session-a", "session-a-canonical"], "req-a"), false, "A cannot mutate B");
  current.sessionId = null;
  current.activeRequestId = null;
  assert.equal(owns(current, ["session-a"], "req-a"), false, "A cannot reopen a new blank chat");
  current.tab = "tasks";
  current.sessionId = "session-a";
  current.activeRequestId = "req-a";
  assert.equal(owns(current, ["session-a"], "req-a"), false, "a detached tab is not visible chat state");

  assert.match(script, /const submittedSessionId = state\.sessionId;[\s\S]*?if \(!ownsVisibleRequest\(\)\) return;/);
  assert.match(script, /if \(ownsVisibleRequest\(\)\) \{\s*requestSessionId = finalSessionId;[\s\S]*?await refreshDetachedSessionList\(\);/);
  assert.ok(
    (script.match(/if \(state\.tab !== "chat" \|\| state\.sessionId !== id\) return false;/g) ?? []).length >= 2,
    "both direct session loads and background refreshes must reject a stale history fetch"
  );

  const liveStagesSource = script.match(/const CHAT_REQUEST_LIVE_STAGES = (\[[^;]+\]);/)?.[1];
  assert.ok(liveStagesSource, "dashboard declares recoverable request stages");
  const liveStages = JSON.parse(liveStagesSource);
  assert.equal(liveStages.includes("disconnected"), true, "a pre-persistence disconnect keeps polling");
  assert.match(
    script,
    /else if \(state\.activeRequestId && CHAT_REQUEST_LIVE_STAGES\.includes\(state\.activeRequestStage\)\) \{[\s\S]*?state\.activeRequestMissingSince \?\?= Date\.now\(\);/,
    "a missing disconnected request starts the bounded stale timer"
  );
  assert.match(
    script,
    /Date\.now\(\) - state\.activeRequestMissingSince > CHAT_REQUEST_STALE_MS[\s\S]*?state\.activeRequestStage = "interrupted";/,
    "recovery polling still stops at the existing stale cutoff"
  );
});
