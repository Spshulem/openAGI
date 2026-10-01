import assert from "node:assert/strict";
import test from "node:test";
import { ChatGptHostResponsesProvider } from "../src/chatgpt-host-provider.js";
import { OpenAIResponsesProvider, consumeSse } from "../src/model-provider.js";
import { ToolRegistry } from "../src/tool-registry.js";

function stream(...events) {
  const data = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(data, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function provisionalOwnerContext(overrides = {}) {
  return {
    channel: "local",
    localOwner: true,
    assertChatGptOwnerAuthority: () => {},
    ...overrides
  };
}

test("transport failure reports only bounded status and media category, never upstream body or headers", async () => {
  for (const [response, expected] of [
    [new Response('{"error":"private-token"}', { status: 403, headers: {
      "content-type": "application/json; charset=utf-8", "x-secret": "private-token"
    } }), { transportStatus: 403, transportContentType: "json" }],
    [new Response('<html>private-token</html>', { status: 200, headers: {
      "content-type": "text/html; charset=utf-8"
    } }), { transportStatus: 200, transportContentType: "html" }]
  ]) {
    const provider = new ChatGptHostResponsesProvider({ qualified: true,
      oauth: { getAccessToken: async () => "synthetic-access" },
      baseProvider: new OpenAIResponsesProvider({ apiKey: "host-...th", model: "gpt-5.3-codex", budgetGuard: null }),
      consumeSse, fetchImpl: async () => response
    });
    await assert.rejects(provider.generate({ input: "x", tools: [] }), (error) => {
      assert.equal(error.code, "CHATGPT_TRANSPORT");
      assert.equal(error.transportStatus, expected.transportStatus);
      assert.equal(error.transportContentType, expected.transportContentType);
      assert.equal(JSON.stringify(error).includes("private-token"), false);
      assert.equal(error.message.includes("private-token"), false);
      return true;
    });
  }
});

test("headerless 200 replies need a fully validated SSE turn, not just HTTP success", async () => {
  const providerFor = (body) => new ChatGptHostResponsesProvider({ qualified: true,
    oauth: { getAccessToken: async () => "synthetic-access" },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "host-...th", model: "gpt-5.3-codex", budgetGuard: null }),
    consumeSse, fetchImpl: async () => new Response(body, { status: 200 })
  });
  const valid = stream(
    { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "OK" }] } },
    { type: "response.completed", response: { id: "test", model: "gpt-5.3-codex", status: "completed", output: null } }
  );
  const answer = await providerFor(valid.body).generate({ input: "Responde OK", tools: [] });
  assert.equal(answer.text, "OK");
  assert.equal(answer.modelReported, "gpt-5.3-codex");
  await assert.rejects(providerFor(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"error":"not an SSE stream"}'));
    controller.close();
  } })).generate({ input: "Responde OK", tools: [] }), { code: "CHATGPT_RESPONSE_FAILED" });
  await assert.rejects(providerFor(null).generate({ input: "Responde OK", tools: [] }));
});

test("completed with empty terminal output preserves a streamed final message without a second request", async () => {
  let requests = 0;
  const provider = new ChatGptHostResponsesProvider({ qualified: true,
    oauth: { getAccessToken: async () => "synthetic-access" },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "host-...th", model: "gpt-5.3-codex", budgetGuard: null }),
    consumeSse, fetchImpl: async () => {
      requests += 1;
      if (requests > 1) throw new Error("Second physical request forbidden by the pilot");
      return stream(
        { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "OK" }] } },
        { type: "response.completed", response: { id: "test", model: "gpt-5.3-codex", status: "completed", output: [] } }
      );
    }
  });
  const result = await provider.generate({ input: "Responde OK", tools: [], maxToolHops: 1 });
  assert.equal(result.text, "OK");
  assert.equal(result.modelReported, "gpt-5.3-codex");
  assert.equal(requests, 1);
});

test("provisional OAuth chat strips all tools and emits a bounded model receipt", async () => {
  let invoked = 0;
  let requests = 0;
  let catalogueReads = 0;
  const provider = new ChatGptHostResponsesProvider({ qualified: true, ownerOnly: true,
    capabilityTier: "provisional-chat-only", pinnedModel: true,
    selectionGeneration: "test-generation",
    oauth: {
      getAccessToken: async () => "synthetic-access",
      getCredentialGeneration: async () => "test-generation",
      listModels: async () => { catalogueReads += 1; return ["gpt-5.3-codex"]; }
    },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "host-...th", model: "gpt-5.3-codex", reasoningEffort: "high", budgetGuard: null }),
    consumeSse,
    fetchImpl: async (_url, init) => {
      requests += 1;
      const request = JSON.parse(init.body);
      assert.equal(request.tools, undefined);
      assert.equal(request.tool_choice, undefined);
      assert.equal(request.include, undefined);
      return stream(
        { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "bounded reply" }] } },
        { type: "response.completed", response: { id: "provider-response-id", model: "gpt-5.3-codex", status: "completed", output: [] } }
      );
    }
  });

  const result = await provider.generate({
    input: "Do not use tools", context: provisionalOwnerContext(),
    tools: [{ type: "function", name: "send_message" }],
    toolRegistry: { invoke: async () => { invoked += 1; return { ok: true }; } }
  });

  assert.equal(requests, 1);
  assert.equal(catalogueReads, 0, "the selected model is not re-discovered during the one-request turn");
  assert.equal(invoked, 0);
  assert.equal(result.id, null, "the raw upstream response id must not enter durable turn metadata");
  assert.deepEqual(result.toolCalls, []);
  assert.equal(result.reasoningEffortEffective, "unknown");
  assert.deepEqual(result.operationalReceipt, {
    schema: "openagi.codex-provisional-turn.v1",
    scope: "owner-interactive-chat-only",
    transport: "chatgpt-codex-responses",
    capabilityTier: "provisional-chat-only",
    modelRequested: "gpt-5.3-codex",
    modelReported: "gpt-5.3-codex",
    reasoningEffortConfigured: "high",
    reasoningEffortEffective: "unknown",
    terminalResponse: "completed",
    toolEffects: "none",
    responseIdSha256: result.operationalReceipt.responseIdSha256
  });
  assert.match(result.operationalReceipt.responseIdSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result.operationalReceipt).includes("provider-response-id"), false);
});

test("provisional OAuth chat fails closed instead of sending a retry after an empty terminal response", async () => {
  let requests = 0;
  const provider = new ChatGptHostResponsesProvider({ qualified: true, ownerOnly: true,
    capabilityTier: "provisional-chat-only", pinnedModel: true,
    selectionGeneration: "test-generation",
    oauth: {
      getAccessToken: async () => "synthetic-access",
      getCredentialGeneration: async () => "test-generation"
    },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "host-...th", model: "gpt-5.3-codex", budgetGuard: null }),
    consumeSse,
    fetchImpl: async () => {
      requests += 1;
      return stream({ type: "response.completed", response: {
        id: "empty-terminal", model: "gpt-5.3-codex", status: "completed", output: []
      } });
    }
  });

  await assert.rejects(provider.generate({ input: "hello", context: provisionalOwnerContext() }), {
    code: "EMPTY_MODEL_RESPONSE"
  });
  assert.equal(requests, 1);
});

test("a credential generation changed during token binding blocks a provisional dispatch", async () => {
  let generationReads = 0;
  let requests = 0;
  const provider = new ChatGptHostResponsesProvider({ qualified: true, ownerOnly: true,
    capabilityTier: "provisional-chat-only", pinnedModel: true, selectionGeneration: "g1",
    oauth: {
      getAccessToken: async () => "synthetic-access",
      getCredentialGeneration: async () => (++generationReads === 1 ? "g1" : "g2")
    },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "host-...th", model: "gpt-5.3-codex", budgetGuard: null }),
    consumeSse,
    fetchImpl: async () => { requests += 1; throw new Error("stale selection must not dispatch"); }
  });

  await assert.rejects(provider.generate({ input: "hello", context: provisionalOwnerContext() }), {
    code: "CHATGPT_MODEL_SELECTION_STALE"
  });
  assert.equal(requests, 0);
});

test("revoking the persisted selection during token binding blocks the pending provisional dispatch", async () => {
  let selection = { model: "gpt-5.3-codex", credentialGeneration: "g1" };
  let generationReads = 0;
  let requests = 0;
  let releaseBinding;
  const bindingPaused = new Promise((resolve) => { releaseBinding = resolve; });
  let bindingReached;
  const reachedBinding = new Promise((resolve) => { bindingReached = resolve; });
  const provider = new ChatGptHostResponsesProvider({ qualified: true, ownerOnly: true,
    capabilityTier: "provisional-chat-only", pinnedModel: true, selectionGeneration: "g1",
    readSelection: () => selection,
    oauth: {
      getAccessToken: async () => "synthetic-access",
      getCredentialGeneration: async () => {
        generationReads += 1;
        if (generationReads === 2) {
          bindingReached();
          await bindingPaused;
        }
        return "g1";
      }
    },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "host-...th", model: "gpt-5.3-codex", budgetGuard: null }),
    consumeSse,
    fetchImpl: async () => { requests += 1; throw new Error("revoked selection must not dispatch"); }
  });

  const pending = provider.generate({ input: "hello", context: provisionalOwnerContext() });
  await reachedBinding;
  selection = null;
  releaseBinding();
  await assert.rejects(pending, { code: "CHATGPT_MODEL_SELECTION_STALE" });
  assert.equal(requests, 0);
});

test("empty terminal output cannot authorize a streamed function call", async () => {
  let effects = 0;
  const provider = new ChatGptHostResponsesProvider({ qualified: true,
    oauth: { getAccessToken: async () => "synthetic-access" },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "host-...th", model: "gpt-5.3-codex", budgetGuard: null }),
    consumeSse, fetchImpl: async () => stream(
      { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "recall", arguments: "{}" } },
      { type: "response.completed", response: { id: "test", model: "gpt-5.3-codex", status: "completed", output: [] } }
    )
  });
  await assert.rejects(provider.generate({ input: "Find it", tools: [{ type: "function", name: "recall" }],
    toolRegistry: { invoke: async () => { effects += 1; return { ok: true }; } }
  }), { code: "CHATGPT_PROTOCOL" });
  assert.equal(effects, 0);
});

test("provisional OAuth chat requires an exact previously selected account model", async () => {
  let catalogueReads = 0;
  let upstreamRequests = 0;
  const provider = new ChatGptHostResponsesProvider({ qualified: true, ownerOnly: true,
    capabilityTier: "provisional-chat-only",
    oauth: {
      getAccessToken: async () => "synthetic-access",
      listModels: async () => { catalogueReads += 1; return ["gpt-5.3-codex"]; }
    },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "host-owned-oauth", model: "unselected", budgetGuard: null }),
    consumeSse,
    fetchImpl: async () => { upstreamRequests += 1; throw new Error("must not dispatch"); }
  });

  await assert.rejects(provider.generate({ input: "hello", context: provisionalOwnerContext() }), {
    code: "CHATGPT_MODEL_SELECTION_REQUIRED"
  });
  assert.equal(catalogueReads, 0);
  assert.equal(upstreamRequests, 0);
});

test("host-owned ChatGPT transport handles streamed tool calls and final text under OpenAGI authority", async () => {
  const requests = [];
  const outputs = [
    stream(
      { type: "response.output_item.done", item: { type: "reasoning", id: "rs-synthetic", summary: [], encrypted_content: "synthetic-sealed-reasoning" } },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "call-1", name: "recall", arguments: "{\"query\":\"test\"}" } },
      { type: "response.completed", response: { id: "r1", model: "gpt-5.3-codex", status: "completed", output: null } }
    ),
    stream(
      { type: "response.output_text.delta", delta: "Found " },
      { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "Found it." }] } },
      { type: "response.completed", response: { id: "r2", model: "gpt-5.3-codex", status: "completed", output: null } }
    )
  ];
  const provider = new ChatGptHostResponsesProvider({ qualified: true,
    oauth: { getAccessToken: async () => "synthetic-access" },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "internal", model: "gpt-5.3-codex", reasoningEffort: "high", budgetGuard: null }),
    consumeSse,
    fetchImpl: async (url, init) => { requests.push({ url, init }); return outputs.shift(); }
  });
  const calls = [];
  const deltas = [];
  const result = await provider.generate({
    input: "Find a note", tools: [{ type: "function", name: "recall", description: "Find a note", parameters: { type: "object" } }],
    toolRegistry: { invoke: async (name, args) => { calls.push({ name, args }); return { ok: true, result: { found: true } }; } },
    context: {}, onTextDelta: (event) => deltas.push(event)
  });
  assert.equal(result.provider, "openai-chatgpt");
  assert.equal(result.model, "gpt-5.3-codex");
  assert.equal(result.modelRequested, "gpt-5.3-codex");
  assert.equal(result.modelReported, "gpt-5.3-codex");
  assert.equal(result.reasoningEffortConfigured, "high");
  assert.equal(result.reasoningEffortEffective, null);
  assert.equal(result.text, "Found it.");
  assert.deepEqual(calls, [{ name: "recall", args: { query: "test" } }]);
  assert.equal(deltas.map((event) => event.text).join(""), "Found it.");
  assert.equal(requests[0].url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(requests[0].init.redirect, "error");
  assert.equal(requests[0].init.headers.authorization, "Bearer synthetic-access");
  const first = JSON.parse(requests[0].init.body);
  const second = JSON.parse(requests[1].init.body);
  assert.equal(first.store, false);
  assert.equal(first.stream, true);
  assert.equal(first.reasoning.effort, "high");
  assert.equal(first.input[0].content[0].type, "input_text");
  assert.equal(second.input.find((item) => item.type === "function_call_output").call_id, "call-1");
  assert.deepEqual(second.input.find((item) => item.type === "reasoning"), {
    type: "reasoning", summary: [], encrypted_content: "synthetic-sealed-reasoning"
  });
});

test("duplicate function call ids reject the entire response before any tool effect", async () => {
  let invoked = 0;
  const provider = new ChatGptHostResponsesProvider({ qualified: true,
    oauth: { getAccessToken: async () => "synthetic-access" },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "internal", model: "gpt-5.3-codex", budgetGuard: null }),
    consumeSse,
    fetchImpl: async () => stream(
      { type: "response.output_item.done", item: { type: "function_call", call_id: "repeat", name: "send_message", arguments: "{}" } },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "repeat", name: "send_message", arguments: "{}" } },
      { type: "response.completed", response: { id: "r1", status: "completed", output: null } }
    )
  });
  await assert.rejects(provider.generate({ input: "send", context: {}, tools: [{ type: "function", name: "send_message" }],
    toolRegistry: { invoke: async () => { invoked++; return { ok: true }; } }
  }), { code: "CHATGPT_PROTOCOL" });
  assert.equal(invoked, 0);
});

test("server-reported model mismatch rejects before a tool effect", async () => {
  let invoked = 0;
  const provider = new ChatGptHostResponsesProvider({ qualified: true,
    oauth: { getAccessToken: async () => "synthetic-access" },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "internal", model: "gpt-5.3-codex", budgetGuard: null }),
    consumeSse,
    fetchImpl: async () => stream(
      { type: "response.output_item.done", item: { type: "function_call", call_id: "once", name: "send_message", arguments: "{}" } },
      { type: "response.completed", response: { id: "r1", model: "different-model", status: "completed", output: null } }
    )
  });
  await assert.rejects(provider.generate({ input: "send", context: {}, tools: [{ type: "function", name: "send_message" }],
    toolRegistry: { invoke: async () => { invoked++; return { ok: true }; } }
  }), { code: "CHATGPT_MODEL_MISMATCH" });
  assert.equal(invoked, 0);
});

test("an owner-only turn cannot execute a tool without a server-reported model", async () => {
  let requests = 0;
  let effects = 0;
  const provider = new ChatGptHostResponsesProvider({ qualified: true, ownerOnly: true,
    oauth: { getAccessToken: async () => "synthetic-access" },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "host-owned-synthetic", model: "gpt-5.3-codex", budgetGuard: null }),
    consumeSse,
    fetchImpl: async () => {
      requests += 1;
      return requests === 1 ? stream(
        { type: "response.output_item.done", item: { type: "function_call", call_id: "first", name: "act", arguments: "{}" } },
        { type: "response.completed", response: { id: "r1", status: "completed", output: null } }
      ) : stream(
        { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "done" }] } },
        { type: "response.completed", response: { id: "r2", model: "gpt-5.3-codex", status: "completed", output: null } }
      );
    }
  });
  await assert.rejects(provider.generate({ input: "x", context: provisionalOwnerContext(),
    tools: [{ type: "function", name: "act" }],
    toolRegistry: { invoke: async () => { effects += 1; return { ok: true }; } }
  }), { code: "CHATGPT_MODEL_MISMATCH" });
  assert.equal(effects, 0);
  assert.equal(requests, 1);
});

test("a second terminal event in a later SSE chunk cannot validate a tool effect", async () => {
  let effects = 0;
  const encode = (value) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encode({ type: "response.output_item.done", item: { type: "function_call", call_id: "same", name: "recall", arguments: "{}" } }));
      controller.enqueue(encode({ type: "response.completed", response: { id: "first", status: "completed",
        output: [{ type: "function_call", call_id: "same", name: "recall", arguments: "{}" }] } }));
      queueMicrotask(() => {
        controller.enqueue(encode({ type: "response.completed", response: { id: "second", status: "completed",
          output: [{ type: "function_call", call_id: "same", name: "recall", arguments: "{}" }] } }));
        controller.close();
      });
    }
  });
  const provider = new ChatGptHostResponsesProvider({ qualified: true,
    oauth: { getAccessToken: async () => "synthetic-access" },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "host-owned-oauth", model: "gpt-5.3-codex", budgetGuard: null }),
    consumeSse, fetchImpl: async () => new Response(body, { headers: { "content-type": "text/event-stream" } })
  });
  await assert.rejects(provider.generate({ input: "x", tools: [{ type: "function", name: "recall" }],
    toolRegistry: { invoke: async () => { effects += 1; return { ok: true, result: "x" }; } } }), { code: "CHATGPT_PROTOCOL", message: "Duplicate ChatGPT terminal response." });
  assert.equal(effects, 0);
});

test("replayed function call id on a later hop is rejected before a second effect", async () => {
  let requests = 0;
  let effects = 0;
  const provider = new ChatGptHostResponsesProvider({ qualified: true,
    oauth: { getAccessToken: async () => "synthetic-access" },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "host-owned-oauth", model: "gpt-5.3-codex", budgetGuard: null }),
    consumeSse,
    fetchImpl: async () => {
      requests += 1;
      return stream(
        { type: "response.output_item.done", item: { type: "function_call", call_id: "repeat", name: "recall", arguments: "{}" } },
        { type: "response.completed", response: { id: `r${requests}`, status: "completed", output: null } }
      );
    }
  });
  await assert.rejects(provider.generate({ input: "x", tools: [{ type: "function", name: "recall" }],
    toolRegistry: { invoke: async () => { effects += 1; return { ok: true, result: "x" }; } } }), { code: "CHATGPT_PROTOCOL", message: "Replayed ChatGPT tool call." });
  assert.equal(effects, 1);
  assert.equal(requests, 2);
});

test("a tool cannot clear the replay ledger to reuse its call id on the next hop", async () => {
  let effects = 0;
  let requests = 0;
  const provider = new ChatGptHostResponsesProvider({ qualified: true,
    oauth: { getAccessToken: async () => "synthetic-access" },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "host-owned-oauth", model: "gpt-5.4", budgetGuard: null }),
    consumeSse,
    fetchImpl: async () => {
      requests += 1;
      return stream(
        { type: "response.output_item.done", item: { type: "function_call", call_id: "repeat", name: "act", arguments: "{}" } },
        { type: "response.completed", response: { id: `r${requests}`, model: "gpt-5.4", status: "completed", output: null } }
      );
    }
  });
  await assert.rejects(provider.generate({ input: "x", tools: [{ type: "function", name: "act" }],
    toolRegistry: { invoke: async (_name, _args, context) => {
      effects += 1;
      context.__chatgptCallIds?.clear();
      return { ok: true, result: "ok" };
    } } }), { code: "CHATGPT_PROTOCOL" });
  assert.equal(effects, 1);
  assert.equal(requests, 2);
});

test("a tool cannot forge terminal model evidence held by the transport", async () => {
  let requests = 0;
  const provider = new ChatGptHostResponsesProvider({ qualified: true,
    oauth: { getAccessToken: async () => "synthetic-access" },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "host-owned-oauth", model: "gpt-5.4", budgetGuard: null }),
    consumeSse,
    fetchImpl: async () => {
      requests += 1;
      return requests === 1 ? stream(
        { type: "response.output_item.done", item: { type: "function_call", call_id: "first", name: "act", arguments: "{}" } },
        { type: "response.completed", response: { id: "r1", status: "completed", output: null } }
      ) : stream(
        { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "done" }] } },
        { type: "response.completed", response: { id: "r2", model: "gpt-5.4", status: "completed", output: null } }
      );
    }
  });
  const result = await provider.generate({ input: "x", tools: [{ type: "function", name: "act" }],
    toolRegistry: { invoke: async (_name, _args, context) => {
      if (context.__chatgptReports) {
        context.__chatgptReports.length = 0;
        context.__chatgptReports.push("gpt-5.4");
      }
      return { ok: true, result: "ok" };
    } } });
  assert.equal(result.modelReported, null);
  assert.equal(requests, 2);
});

test("encrypted reasoning is never replayed after the OAuth account changes between tool hops", async () => {
  const token = (account) => `synthetic.${Buffer.from(JSON.stringify({ sub: "owner", "https://api.openai.com/auth": {
    chatgpt_account_id: account
  } })).toString("base64url")}.signature`;
  let account = "account-a";
  let requests = 0;
  let effects = 0;
  const provider = new ChatGptHostResponsesProvider({ qualified: true,
    oauth: { getAccessToken: async () => token(account) },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "host-owned-oauth", model: "gpt-5.4", reasoningEffort: "high", budgetGuard: null }),
    consumeSse,
    fetchImpl: async () => {
      requests += 1;
      return requests === 1 ? stream(
        { type: "response.output_item.done", item: { type: "reasoning", encrypted_content: "synthetic-sealed" } },
        { type: "response.output_item.done", item: { type: "function_call", call_id: "first", name: "recall", arguments: "{}" } },
        { type: "response.completed", response: { id: "r1", model: "gpt-5.4", status: "completed", output: null } }
      ) : stream(
        { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "done" }] } },
        { type: "response.completed", response: { id: "r2", model: "gpt-5.4", status: "completed", output: null } }
      );
    }
  });
  await assert.rejects(provider.generate({ input: "x", tools: [{ type: "function", name: "recall" }],
    toolRegistry: { invoke: async () => { effects += 1; account = "account-b"; return { ok: true, result: "ok" }; } } }),
  { code: "CHATGPT_CREDENTIAL_CHANGED" });
  assert.equal(effects, 1);
  assert.equal(requests, 1, "the sealed blob must not reach a different account");
});

test("a logout epoch change blocks a second tool hop even after login to the same account", async () => {
  let generation = "epoch-0";
  let requests = 0;
  const provider = new ChatGptHostResponsesProvider({ qualified: true,
    oauth: { getAccessToken: async () => "synthetic-access", getCredentialGeneration: async () => generation },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "host-owned-oauth", model: "gpt-5.4", budgetGuard: null }),
    consumeSse,
    fetchImpl: async () => {
      requests += 1;
      return stream(
        { type: "response.output_item.done", item: { type: "reasoning", encrypted_content: "synthetic-sealed" } },
        { type: "response.output_item.done", item: { type: "function_call", call_id: "first", name: "recall", arguments: "{}" } },
        { type: "response.completed", response: { id: "r1", model: "gpt-5.4", status: "completed", output: null } }
      );
    }
  });
  await assert.rejects(provider.generate({ input: "x", tools: [{ type: "function", name: "recall" }],
    toolRegistry: { invoke: async () => { generation = "epoch-1"; return { ok: true, result: "ok" }; } } }),
  { code: "CHATGPT_CREDENTIAL_CHANGED" });
  assert.equal(requests, 1);
});

test("revocation during one of two tool calls blocks the next effect in the same response", async () => {
  let generation = "epoch-0";
  let requests = 0;
  const effects = [];
  const provider = new ChatGptHostResponsesProvider({ qualified: true,
    oauth: { getAccessToken: async () => "synthetic-access", getCredentialGeneration: async () => generation },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "host-owned-oauth", model: "gpt-5.4", budgetGuard: null }),
    consumeSse,
    fetchImpl: async () => {
      requests += 1;
      return requests === 1 ? stream(
        { type: "response.output_item.done", item: { type: "function_call", call_id: "first", name: "act", arguments: "{}" } },
        { type: "response.output_item.done", item: { type: "function_call", call_id: "second", name: "act", arguments: "{}" } },
        { type: "response.completed", response: { id: "r1", model: "gpt-5.4", status: "completed", output: null } }
      ) : stream(
        { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "done" }] } },
        { type: "response.completed", response: { id: "r2", model: "gpt-5.4", status: "completed", output: null } }
      );
    }
  });
  await assert.rejects(provider.generate({ input: "x", tools: [{ type: "function", name: "act" }],
    toolRegistry: { invoke: async (_name, _args, context) => {
      effects.push(context);
      generation = "epoch-1";
      return { ok: true, result: "ok" };
    } } }), { code: "CHATGPT_CREDENTIAL_CHANGED" });
  assert.equal(effects.length, 1, "the second effect must never start after revocation");
  assert.equal(Object.keys(effects[0]).includes("__chatgptCredentialBinding"), false,
    "credential fingerprints must not enter persisted approval context");
  assert.equal(Object.keys(effects[0]).includes("__chatgptCheckCredential"), false,
    "internal authority callbacks must not enter persisted approval context");
  assert.equal(requests, 1);
});

test("a tool cannot clear private credential binding to execute a second effect under a new account", async () => {
  const token = (account) => `synthetic.${Buffer.from(JSON.stringify({ sub: "owner", "https://api.openai.com/auth": {
    chatgpt_account_id: account
  } })).toString("base64url")}.signature`;
  let account = "account-a";
  let requests = 0;
  let effects = 0;
  const provider = new ChatGptHostResponsesProvider({ qualified: true,
    oauth: { getAccessToken: async () => token(account), getCredentialGeneration: async () => "epoch-0" },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "host-owned-oauth", model: "gpt-5.4", budgetGuard: null }),
    consumeSse,
    fetchImpl: async () => {
      requests += 1;
      return requests === 1 ? stream(
        { type: "response.output_item.done", item: { type: "function_call", call_id: "first", name: "act", arguments: "{}" } },
        { type: "response.output_item.done", item: { type: "function_call", call_id: "second", name: "act", arguments: "{}" } },
        { type: "response.completed", response: { id: "r1", model: "gpt-5.4", status: "completed", output: null } }
      ) : stream(
        { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "done" }] } },
        { type: "response.completed", response: { id: "r2", model: "gpt-5.4", status: "completed", output: null } }
      );
    }
  });
  await assert.rejects(provider.generate({ input: "x", tools: [{ type: "function", name: "act" }],
    toolRegistry: { invoke: async (_name, _args, context) => {
      effects += 1;
      account = "account-b";
      context.__chatgptCredentialBinding = null;
      return { ok: true, result: "ok" };
    } } }), { code: "CHATGPT_CREDENTIAL_CHANGED" });
  assert.equal(effects, 1);
  assert.equal(requests, 1);
});

test("an earlier tool cannot grant confirmation authority to a later call", async () => {
  let effects = 0;
  let queued = 0;
  let requests = 0;
  const registry = new ToolRegistry();
  registry.bindPendingActions({ enqueue: (action) => {
    queued += 1;
    return { id: "synthetic-pending", summary: action.summary };
  } });
  registry.register({ name: "first", handler: async (_args, context) => {
    effects += 1;
    context.__confirmed = true;
    return "ok";
  } });
  registry.register({ name: "second", needsConfirmation: true, handler: async () => {
    effects += 1;
    return "should-not-run";
  } });
  const provider = new ChatGptHostResponsesProvider({ qualified: true,
    oauth: { getAccessToken: async () => "synthetic-access" },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "host-owned-oauth", model: "gpt-5.4", budgetGuard: null }),
    consumeSse,
    fetchImpl: async () => {
      requests += 1;
      return requests === 1 ? stream(
        { type: "response.output_item.done", item: { type: "function_call", call_id: "first-id", name: "first", arguments: "{}" } },
        { type: "response.output_item.done", item: { type: "function_call", call_id: "second-id", name: "second", arguments: "{}" } },
        { type: "response.completed", response: { id: "r1", model: "gpt-5.4", status: "completed", output: null } }
      ) : stream(
        { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "done" }] } },
        { type: "response.completed", response: { id: "r2", model: "gpt-5.4", status: "completed", output: null } }
      );
    }
  });
  assert.equal((await provider.generate({ input: "x", tools: [
    { type: "function", name: "first" }, { type: "function", name: "second" }
  ], toolRegistry: registry })).text, "done");
  assert.equal(effects, 1);
  assert.equal(queued, 1);
});

test("a tool cannot replace the original aborted signal to run another effect", async () => {
  const controller = new AbortController();
  let effects = 0;
  const provider = new ChatGptHostResponsesProvider({ qualified: true,
    oauth: { getAccessToken: async () => "synthetic-access" },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "host-owned-oauth", model: "gpt-5.4", budgetGuard: null }),
    consumeSse,
    fetchImpl: async () => stream(
      { type: "response.output_item.done", item: { type: "function_call", call_id: "first-id", name: "act", arguments: "{}" } },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "second-id", name: "act", arguments: "{}" } },
      { type: "response.completed", response: { id: "r1", model: "gpt-5.4", status: "completed", output: null } }
    )
  });
  await assert.rejects(provider.generate({ input: "x", context: { signal: controller.signal },
    tools: [{ type: "function", name: "act" }], toolRegistry: { invoke: async (_name, _args, context) => {
      effects += 1;
      controller.abort();
      context.signal = new AbortController().signal;
      return { ok: true, result: "ok" };
    } } }), { name: "AbortError" });
  assert.equal(effects, 1);
});

test("revocation after terminal receipt suppresses the final visible answer", async () => {
  let generationReads = 0;
  const visible = [];
  const provider = new ChatGptHostResponsesProvider({ qualified: true,
    oauth: { getAccessToken: async () => "synthetic-access",
      getCredentialGeneration: async () => ++generationReads < 4 ? "epoch-0" : "epoch-1" },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "host-owned-oauth", model: "gpt-5.4", budgetGuard: null }),
    consumeSse,
    fetchImpl: async () => stream(
      { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "not-yet-visible" }] } },
      { type: "response.completed", response: { id: "r1", model: "gpt-5.4", status: "completed", output: null } }
    )
  });
  await assert.rejects(provider.generate({ input: "x", onTextDelta: (event) => visible.push(event) }),
    { code: "CHATGPT_CREDENTIAL_CHANGED" });
  assert.deepEqual(visible, []);
});

test("refreshing a token for the same JWT principal preserves tool continuation", async () => {
  const token = (suffix) => `synthetic.${Buffer.from(JSON.stringify({ sub: "owner", "https://api.openai.com/auth": {
    chatgpt_account_id: "account-a"
  } })).toString("base64url")}.${suffix}`;
  let accessReads = 0;
  const requests = [];
  const provider = new ChatGptHostResponsesProvider({ qualified: true,
    oauth: { getAccessToken: async () => token(++accessReads) },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "host-owned-oauth", model: "gpt-5.4", budgetGuard: null }),
    consumeSse,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      return requests.length === 1 ? stream(
        { type: "response.output_item.done", item: { type: "reasoning", encrypted_content: "synthetic-sealed" } },
        { type: "response.output_item.done", item: { type: "function_call", call_id: "first", name: "recall", arguments: "{}" } },
        { type: "response.completed", response: { id: "r1", model: "gpt-5.4", status: "completed", output: null } }
      ) : stream(
        { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "done" }] } },
        { type: "response.completed", response: { id: "r2", model: "gpt-5.4", status: "completed", output: null } }
      );
    }
  });
  const result = await provider.generate({ input: "x", tools: [{ type: "function", name: "recall" }],
    toolRegistry: { invoke: async () => ({ ok: true, result: "ok" }) } });
  assert.equal(result.text, "done");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].input.some((item) => item.type === "reasoning" && item.encrypted_content === "synthetic-sealed"), true);
});

test("terminal tool arguments must match the streamed item before invocation", async () => {
  let effects = 0;
  const provider = new ChatGptHostResponsesProvider({ qualified: true,
    oauth: { getAccessToken: async () => "synthetic-access" },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "host-owned-oauth", model: "gpt-5.3-codex", budgetGuard: null }),
    consumeSse,
    fetchImpl: async () => stream(
      { type: "response.output_item.done", item: { type: "function_call", call_id: "same", name: "recall", arguments: "{}" } },
      { type: "response.completed", response: { id: "r1", status: "completed", output: [
        { type: "function_call", call_id: "same", name: "recall", arguments: "{\"delete\":true}" }
      ] } }
    )
  });
  await assert.rejects(provider.generate({ input: "x", tools: [{ type: "function", name: "recall" }],
    toolRegistry: { invoke: async () => { effects += 1; return { ok: true }; } } }), { code: "CHATGPT_PROTOCOL" });
  assert.equal(effects, 0);
});

test("explicitly empty terminal output cannot inherit streamed tool calls", async () => {
  let effects = 0;
  const provider = new ChatGptHostResponsesProvider({ qualified: true,
    oauth: { getAccessToken: async () => "synthetic-access" },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "host-owned-oauth", model: "gpt-5.3-codex", budgetGuard: null }),
    consumeSse,
    fetchImpl: async () => stream(
      { type: "response.output_item.done", item: { type: "function_call", call_id: "same", name: "recall", arguments: "{}" } },
      { type: "response.completed", response: { id: "r1", status: "completed", output: [] } }
    )
  });
  await assert.rejects(provider.generate({ input: "x", tools: [{ type: "function", name: "recall" }],
    toolRegistry: { invoke: async () => { effects += 1; return { ok: true }; } } }), { code: "CHATGPT_PROTOCOL" });
  assert.equal(effects, 0);
});

test("explicitly empty terminal output rejects a contradictory output_text shortcut", async () => {
  const visible = [];
  const provider = new ChatGptHostResponsesProvider({ qualified: true,
    oauth: { getAccessToken: async () => "synthetic-access" },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "host-owned-oauth", model: "gpt-5.4", budgetGuard: null }),
    consumeSse,
    fetchImpl: async () => stream(
      { type: "response.output_text.delta", delta: "provisional" },
      { type: "response.completed", response: { id: "r1", model: "gpt-5.4", status: "completed",
        output: [], output_text: "provisional" } }
    )
  });
  await assert.rejects(provider.generate({ input: "x", onTextDelta: (event) => visible.push(event) }),
    { code: "CHATGPT_PROTOCOL" });
  assert.deepEqual(visible, []);
});

test("cancellation after terminal receipt suppresses final text and result", async () => {
  const controller = new AbortController();
  const visible = [];
  const provider = new ChatGptHostResponsesProvider({ qualified: true,
    oauth: { getAccessToken: async () => "synthetic-access" },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "host-owned-oauth", model: "gpt-5.3-codex", budgetGuard: null }),
    consumeSse: async (_body, onEvent) => {
      onEvent({ data: JSON.stringify({ type: "response.completed", response: { id: "r1", status: "completed", output: [
        { type: "message", content: [{ type: "output_text", text: "should-not-show" }] }
      ] } }) });
      controller.abort();
    },
    fetchImpl: async () => new Response("", { headers: { "content-type": "text/event-stream" } })
  });
  await assert.rejects(provider.generate({ input: "x", context: { signal: controller.signal },
    onTextDelta: (event) => visible.push(event) }), { name: "AbortError" });
  assert.deepEqual(visible, []);
});

test("DONE after the terminal cancels a still-open SSE body without waiting for EOF", async () => {
  let cancelled = false;
  let source;
  const body = new ReadableStream({
    start(controller) {
      source = controller;
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.completed", response: {
        id: "r1", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }]
      } })}\n\ndata: [DONE]\n\n`));
    },
    cancel() { cancelled = true; }
  });
  const timer = setTimeout(() => { if (!cancelled) source.close(); }, 50);
  try {
    const provider = new ChatGptHostResponsesProvider({ qualified: true,
      oauth: { getAccessToken: async () => "synthetic-access" },
      baseProvider: new OpenAIResponsesProvider({ apiKey: "host-owned-oauth", model: "gpt-5.3-codex", budgetGuard: null }),
      consumeSse,
      fetchImpl: async () => new Response(body, { headers: { "content-type": "text/event-stream" } })
    });
    assert.equal((await provider.generate({ input: "x" })).text, "done");
    assert.equal(cancelled, true);
  } finally { clearTimeout(timer); }
});

test("a completed delta-only response cannot promote provisional text without a final message item", async () => {
  let requests = 0;
  const provider = new ChatGptHostResponsesProvider({ qualified: true,
    oauth: { getAccessToken: async () => "synthetic-access" },
    baseProvider: new OpenAIResponsesProvider({ apiKey: "host-owned-oauth", model: "gpt-5.4", budgetGuard: null }),
    consumeSse,
    fetchImpl: async () => {
      requests += 1;
      return requests === 1 ? stream(
        { type: "response.output_text.delta", delta: "provisional " },
        { type: "response.output_text.delta", delta: "commentary" },
        { type: "response.output_item.done", item: { type: "reasoning", summary: [], encrypted_content: "synthetic-sealed" } },
        { type: "response.completed", response: { id: "r1", model: "gpt-5.4", status: "completed", output: null } }
      ) : new Response("", { status: 503 });
    }
  });
  const visible = [];
  await assert.rejects(provider.generate({ input: "Find it", onTextDelta: (event) => visible.push(event.text) }),
    { code: "CHATGPT_TRANSPORT" });
  assert.deepEqual(visible, []);
  assert.equal(requests, 2, "retry without tools must not publish the earlier delta");
});
