import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultRuntime } from "../src/index.js";
import { CodexExplicitFallbackProvider } from "../src/codex-oauth-provider.js";

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openagi-provider-telemetry-"));
}

test("AgentHost persists non-monetary Codex subscription usage without inventing USD cost", async () => {
  const provider = {
    providerId: "openai-codex",
    model: "gpt-test",
    isConfigured: () => true,
    async generate() {
      return {
        id: "turn-codex",
        text: "Codex reply",
        provider: "openai-codex",
        model: "gpt-test",
        toolCalls: [],
        usage: {
          billingMode: "chatgpt-subscription",
          usd: null,
          inputTokens: 12,
          outputTokens: 3,
          quota: null
        }
      };
    }
  };
  const runtime = createDefaultRuntime({
    dataDir: tempDataDir(),
    modelProvider: provider,
    autoConnectMcp: false
  });

  const result = await runtime.agentHost.handleMessage({
    text: "hello",
    sessionId: "codex-telemetry",
    routeTo: false
  });
  const assistant = runtime.agentHost.store.getSession("codex-telemetry").messages.at(-1);

  assert.deepEqual(result.usage, {
    billingMode: "chatgpt-subscription",
    usd: null,
    inputTokens: 12,
    outputTokens: 3,
    quota: null
  });
  assert.deepEqual(assistant.metadata.usage, result.usage);
});

test("AgentHost persists explicit provider fallback as auditable turn metadata", async () => {
  const fallback = {
    from: "openai-codex",
    to: "openai",
    reason: "CODEX_LOGIN_REQUIRED"
  };
  const provider = {
    providerId: "openai-codex",
    model: "gpt-test",
    isConfigured: () => true,
    async generate() {
      return {
        id: "fallback-turn",
        text: "Fallback reply",
        provider: "openai",
        model: "gpt-api",
        toolCalls: [],
        fallback
      };
    }
  };
  const runtime = createDefaultRuntime({
    dataDir: tempDataDir(),
    modelProvider: provider,
    autoConnectMcp: false
  });

  const result = await runtime.agentHost.handleMessage({
    text: "hello",
    sessionId: "fallback-telemetry",
    routeTo: false
  });
  const assistant = runtime.agentHost.store.getSession("fallback-telemetry").messages.at(-1);

  assert.deepEqual(result.fallback, fallback);
  assert.deepEqual(assistant.metadata.providerFallback, fallback);
});

test("AgentHost persists only the allowlisted provisional Codex operational receipt", async () => {
  const receipt = {
    schema: "openagi.codex-provisional-turn.v1",
    scope: "owner-interactive-chat-only",
    transport: "chatgpt-codex-responses",
    capabilityTier: "provisional-chat-only",
    modelRequested: "gpt-test",
    modelReported: "gpt-test",
    reasoningEffortConfigured: "medium",
    reasoningEffortEffective: "unknown",
    terminalResponse: "completed",
    toolEffects: "none",
    responseIdSha256: "a".repeat(64),
    prompt: "must not be retained",
    output: "must not be retained"
  };
  const provider = {
    providerId: "openai-chatgpt",
    model: "gpt-test",
    isConfigured: () => true,
    async generate() {
      return {
        id: "raw-provider-response-id",
        text: "Provisional reply",
        provider: "openai-chatgpt",
        model: "gpt-test",
        toolCalls: [],
        operationalReceipt: receipt
      };
    }
  };
  const runtime = createDefaultRuntime({ dataDir: tempDataDir(), modelProvider: provider, autoConnectMcp: false });

  const result = await runtime.agentHost.handleMessage({ text: "hello", sessionId: "provisional-receipt", routeTo: false });
  const assistant = runtime.agentHost.store.getSession("provisional-receipt").messages.at(-1);
  const expected = {
    schema: "openagi.codex-provisional-turn.v1",
    scope: "owner-interactive-chat-only",
    transport: "chatgpt-codex-responses",
    capabilityTier: "provisional-chat-only",
    modelRequested: "gpt-test",
    modelReported: "gpt-test",
    reasoningEffortConfigured: "medium",
    reasoningEffortEffective: "unknown",
    terminalResponse: "completed",
    toolEffects: "none",
    responseIdSha256: "a".repeat(64)
  };

  assert.deepEqual(result.operationalReceipt, expected);
  assert.deepEqual(assistant.metadata.operationalReceipt, expected);
  assert.equal(assistant.metadata.responseId, null);
  assert.equal(JSON.stringify(assistant.metadata).includes("raw-provider-response-id"), false);
  assert.equal(JSON.stringify(assistant.metadata).includes("must not be retained"), false);
});

test("An exhausted API fallback budget cannot preflight-reject a Codex subscription turn", async () => {
  let primaryCalls = 0;
  const provider = new CodexExplicitFallbackProvider({
    fallbackId: "openai",
    primary: {
      model: "gpt-test", isConfigured: () => true,
      async generate() {
        primaryCalls += 1;
        return { id: "codex-turn", text: "subscription reply", provider: "openai-codex", model: "gpt-test", toolCalls: [] };
      }
    },
    fallback: {
      isConfigured: () => true,
      budgetGuard: { check() { throw new Error("API budget exhausted"); } },
      async generate() { throw new Error("fallback should not run"); }
    }
  });
  const runtime = createDefaultRuntime({ dataDir: tempDataDir(), modelProvider: provider, autoConnectMcp: false });
  const result = await runtime.agentHost.handleMessage({ text: "hello", routeTo: false, ephemeral: true });
  assert.equal(result.reply, "subscription reply");
  assert.equal(primaryCalls, 1);
});
