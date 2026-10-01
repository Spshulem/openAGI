import assert from "node:assert/strict";
import test from "node:test";
import { CodexOAuthProvider, CodexProviderError } from "../src/codex-oauth-provider.js";
import { createModelProvider, DeterministicModelProvider } from "../src/model-provider.js";

test("CodexOAuthProvider runs a chat-only ephemeral turn without advertising tools", async () => {
  const seen = [];
  const deltas = [];
  const client = {
    status: () => ({ readiness: "chat-ready" }),
    async runChatTurn(request) {
      seen.push(request);
      request.onTextDelta?.("Visible ");
      request.onTextDelta?.("answer");
      return {
        turnId: "turn-1",
        text: "Visible answer",
        requestedModel: "gpt-test",
        observedModel: "gpt-test-served",
        requestedEffort: "medium",
        observedEffort: null,
        usage: { inputTokens: 10, outputTokens: 2, quota: null }
      };
    }
  };
  const provider = new CodexOAuthProvider({ client, model: "gpt-test", reasoningEffort: "medium" });

  const result = await provider.generate({
    input: "What is two plus two?",
    context: { channel: "local", localOwner: true },
    instructions: "Answer briefly.",
    messages: [{ role: "user", content: "Earlier question" }],
    turnContext: "[context]\nlocal owner\n[/context]",
    tools: [{ name: "dangerous_tool", description: "must not cross boundary" }],
    onTextDelta: (event) => deltas.push(event)
  });

  assert.equal(provider.isConfigured(), true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ephemeral, true);
  assert.equal(seen[0].approvalPolicy, "never");
  assert.equal(seen[0].sandbox, "read-only");
  assert.equal(Object.hasOwn(seen[0], "tools"), false);
  assert.equal(Object.hasOwn(seen[0], "dynamicTools"), false);
  assert.match(seen[0].developerInstructions, /must not execute tools/i);
  assert.deepEqual(deltas, [
    { text: "Visible ", reset: true, provider: "openai-codex", model: "gpt-test" },
    { text: "answer", reset: false, provider: "openai-codex", model: "gpt-test" }
  ]);
  assert.deepEqual(result, {
    provider: "openai-codex",
    model: "gpt-test-served",
    id: "turn-1",
    text: "Visible answer",
    toolCalls: [],
    usage: {
      billingMode: "chatgpt-subscription",
      usd: null,
      inputTokens: 10,
      outputTokens: 2,
      quota: null
    },
    requestedProvider: "openai-codex",
    requestedModel: "gpt-test",
    requestedEffort: "medium",
    observedProvider: "openai-codex",
    observedModel: "gpt-test-served",
    observedEffort: null
  });
});

test("createModelProvider selects Codex only when explicitly requested and never silently falls back", () => {
  const saved = {
    OPENAGI_PROVIDER: process.env.OPENAGI_PROVIDER,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY
  };
  const codexClient = { status: () => ({ readiness: "login-required" }) };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    process.env.OPENAGI_PROVIDER = "openai-codex";
    const explicit = createModelProvider({ codexClient, dataDir: process.env.TMPDIR });
    assert.ok(explicit instanceof CodexOAuthProvider);
    assert.equal(explicit.isConfigured(), false);

    process.env.OPENAGI_PROVIDER = "auto";
    const automatic = createModelProvider({ codexClient, dataDir: process.env.TMPDIR });
    assert.ok(automatic instanceof DeterministicModelProvider);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("createModelProvider rejects unqualified Codex capability tiers", () => {
  assert.throws(
    () => createModelProvider({
      preferred: "openai-codex",
      codexClient: { status: () => ({ readiness: "protocol-unsupported" }) },
      codex: { capabilityTier: "tools-experimental" },
      dataDir: process.env.TMPDIR
    }),
    (error) => error instanceof CodexProviderError && error.code === "CODEX_CAPABILITY_TIER"
  );
});

test("CodexOAuthProvider delegates the official account lifecycle without exposing a generic request surface", async () => {
  const calls = [];
  const client = {
    status: () => ({ readiness: "login-required" }),
    startLogin: async (options) => { calls.push(["login", options]); return { type: "chatgptDeviceCode", loginId: "one" }; },
    cancelLogin: async (id) => { calls.push(["cancel", id]); return { status: "canceled" }; },
    logout: async () => { calls.push(["logout"]); return { status: "logged-out" }; },
    listModels: async () => [{ id: "gpt-test" }],
    getAccount: async () => ({ account: { type: "chatgpt" }, requiresOpenaiAuth: true }),
    getLimits: async () => ({ quota: null }),
    inspectReadiness: async (options) => {
      calls.push(["qualification", options]);
      return { readiness: "canary-required" };
    }
  };
  const provider = new CodexOAuthProvider({ client });

  assert.deepEqual(await provider.startLogin({ mode: "device" }), { type: "chatgptDeviceCode", loginId: "one" });
  assert.deepEqual(await provider.cancelLogin("one"), { status: "canceled" });
  assert.deepEqual(await provider.logout(), { status: "logged-out" });
  assert.deepEqual(await provider.listModels(), [{ id: "gpt-test" }]);
  assert.deepEqual(await provider.getAccount(), { account: { type: "chatgpt" }, requiresOpenaiAuth: true });
  assert.deepEqual(await provider.getLimits(), { quota: null });
  assert.deepEqual(await provider.inspectReadiness(), { readiness: "canary-required" });
  assert.deepEqual(calls, [["login", { mode: "device" }], ["cancel", "one"], ["logout"], ["qualification", { model: "gpt-5.3-codex" }]]);
  assert.equal(provider.request, undefined);
});

test("CodexOAuthProvider denies scheduled, autopilot, and specialist use before starting a Codex turn", async () => {
  let turns = 0;
  const provider = new CodexOAuthProvider({
    client: {
      status: () => ({ readiness: "chat-ready" }),
      runChatTurn: async () => { turns += 1; return { text: "unexpected" }; }
    }
  });

  await assert.rejects(
    provider.generate({ input: "background", task: "scheduled" }),
    (error) => error?.code === "CODEX_PROVENANCE_DENIED"
  );
  await assert.rejects(
    provider.generate({ input: "autonomous", task: "autopilot" }),
    (error) => error?.code === "CODEX_PROVENANCE_DENIED"
  );
  await assert.rejects(
    provider.generate({ input: "delegated", task: "chat", agent: { role: "specialist" } }),
    (error) => error?.code === "CODEX_PROVENANCE_DENIED"
  );
  await assert.rejects(
    provider.generate({ input: "remote", task: "chat", context: { channel: "telegram", localOwner: false } }),
    (error) => error?.code === "CODEX_PROVENANCE_DENIED"
  );
  await assert.rejects(
    provider.generate({ input: "spoofed", task: "chat", context: { channel: "local", localOwner: false } }),
    (error) => error?.code === "CODEX_PROVENANCE_DENIED"
  );
  assert.equal(turns, 0);
});

test("Codex fallback is opt-in, emits an audit event, and is attached to the result", async () => {
  const progress = [];
  let fallbackCalls = 0;
  const primaryClient = {
    status: () => ({ readiness: "login-required" }),
    close: async () => {}
  };
  const fallbackProvider = {
    providerId: "openai",
    model: "gpt-fallback",
    isConfigured: () => true,
    async generate() {
      fallbackCalls += 1;
      return { id: "fallback-result", text: "fallback reply", provider: "openai", model: "gpt-fallback", toolCalls: [] };
    },
    async close() {}
  };
  const provider = createModelProvider({
    preferred: "openai-codex",
    codexClient: primaryClient,
    codexFallback: "openai",
    codexFallbackProvider: fallbackProvider,
    dataDir: process.env.TMPDIR
  });

  assert.equal(provider.isConfigured(), false, "API fallback must not qualify Codex");
  const result = await provider.generate({ input: "hello", task: "chat", context: { channel: "local", localOwner: true }, onProgress: (event) => progress.push(event) });
  assert.equal(result.text, "fallback reply");
  assert.equal(fallbackCalls, 1);
  assert.deepEqual(result.fallback, {
    from: "openai-codex",
    to: "openai",
    reason: "CODEX_LOGIN_REQUIRED"
  });
  assert.deepEqual(progress, [{
    stage: "provider-fallback",
    from: "openai-codex",
    to: "openai",
    reason: "CODEX_LOGIN_REQUIRED"
  }]);
});

test("An app-server exit after dispatch does not launch an API fallback", async () => {
  let calls = 0;
  const provider = createModelProvider({
    preferred: "openai-codex", codexFallback: "openai",
    codexClient: {
      status: () => ({ readiness: "chat-ready" }),
      async runChatTurn() { throw Object.assign(new Error("child exited"), { code: "CODEX_PROCESS_EXIT" }); }
    },
    codexFallbackProvider: {
      isConfigured: () => true,
      async generate() { calls += 1; return { text: "API response", provider: "openai", model: "api-test", toolCalls: [] }; }
    },
    dataDir: process.env.TMPDIR
  });
  await assert.rejects(provider.generate({ input: "Hello", task: "chat", context: { channel: "local", localOwner: true } }),
    (error) => error?.code === "CODEX_PROCESS_EXIT");
  assert.equal(calls, 0);
});

test("Codex timeout after dispatch never starts an API fallback", async () => {
  let apiCalls = 0;
  const provider = createModelProvider({
    preferred: "openai-codex", codexFallback: "openai",
    codexClient: {
      status: () => ({ readiness: "chat-ready" }),
      async runChatTurn() { throw Object.assign(new Error("indeterminate"), { code: "CODEX_TIMEOUT" }); }
    },
    codexFallbackProvider: {
      isConfigured: () => true,
      async generate() { apiCalls += 1; return { text: "unwanted API call" }; }
    },
    dataDir: process.env.TMPDIR
  });
  await assert.rejects(provider.generate({ input: "Hello", task: "chat", context: { channel: "local", localOwner: true } }),
    (error) => error?.code === "CODEX_TIMEOUT");
  assert.equal(apiCalls, 0);
});

test("A crashed app-server cannot switch providers after visible streaming has begun", async () => {
  let fallbackCalls = 0;
  const provider = createModelProvider({
    preferred: "openai-codex", codexFallback: "openai",
    codexClient: {
      status: () => ({ readiness: "chat-ready" }),
      async runChatTurn(options) {
        options.onTextDelta("partial");
        throw Object.assign(new Error("child exited"), { code: "CODEX_PROCESS_EXIT" });
      }
    },
    codexFallbackProvider: {
      isConfigured: () => true,
      async generate() { fallbackCalls += 1; return { text: "must not run" }; }
    },
    dataDir: process.env.TMPDIR
  });
  await assert.rejects(provider.generate({ input: "Hello", task: "chat", context: { channel: "local", localOwner: true }, onTextDelta: () => {} }),
    (error) => error?.code === "CODEX_PROCESS_EXIT");
  assert.equal(fallbackCalls, 0);
});

test("Codex isolation failures never fall back to another provider", async () => {
  let fallbackCalls = 0;
  const provider = createModelProvider({
    preferred: "openai-codex",
    codexFallback: "openai",
    codexClient: {
      status: () => ({ readiness: "isolation-failed" }),
      close: async () => {}
    },
    codexFallbackProvider: {
      providerId: "openai",
      model: "gpt-fallback",
      isConfigured: () => true,
      generate: async () => {
        fallbackCalls += 1;
        return { text: "must not run" };
      }
    },
    dataDir: process.env.TMPDIR
  });

  await assert.rejects(
    provider.generate({ task: "chat", input: "hello", context: { channel: "local", localOwner: true } }),
    (error) => error instanceof CodexProviderError && error.code === "CODEX_ISOLATION"
  );
  assert.equal(fallbackCalls, 0);
});
