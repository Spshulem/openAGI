import assert from "node:assert/strict";
import test from "node:test";
import { createModelProvider } from "../src/model-provider.js";
import { ChatGptHostResponsesProvider } from "../src/chatgpt-host-provider.js";

test("the host-owned subscription is selected only by its separate explicit provider id", async () => {
  const oauth = { getAccessToken: async () => { throw new Error("not logged in"); } };
  const selected = createModelProvider({
    preferred: "openai-chatgpt", chatgptOAuth: oauth,
    openai: { apiKey: "synthetic-key" }, anthropic: { apiKey: "synthetic-key" }
  });
  assert.ok(selected instanceof ChatGptHostResponsesProvider);
  assert.equal(selected.model, "unselected", "a provisional owner chat cannot silently pick the account's first model");
  assert.equal(selected.reasoningEffort, "medium");
  assert.equal(selected.isConfigured(), false, "an OAuth object is not an inference qualification");
  await assert.rejects(selected.generate({ input: "must not dispatch" }), { code: "CHATGPT_NOT_QUALIFIED" });
  await assert.rejects(selected.postResponses({ model: selected.model, input: [] }), { code: "CHATGPT_TRANSPORT_PRIVATE" });
  await assert.rejects(selected.postResponsesStream({ model: selected.model, input: [] }), { code: "CHATGPT_TRANSPORT_PRIVATE" });
  assert.equal(selected.base, undefined, "the raw Responses loop must not be externally reachable");
  assert.notEqual(createModelProvider({ preferred: "auto", chatgptOAuth: oauth, openai: { apiKey: "synthetic-key" } }).constructor.name, "ChatGptHostResponsesProvider");
});

test("ChatGPT subscription never inherits API-key model task pins", () => {
  const original = process.env.OPENAI_MODEL_TASK_SCHEDULED;
  process.env.OPENAI_MODEL_TASK_SCHEDULED = "api-only-model";
  try {
    const selected = createModelProvider({ preferred: "openai-chatgpt", chatgptOAuth: { getAccessToken: async () => "synthetic" } });
    assert.equal(selected.model, "unselected");
  } finally {
    if (original === undefined) delete process.env.OPENAI_MODEL_TASK_SCHEDULED;
    else process.env.OPENAI_MODEL_TASK_SCHEDULED = original;
  }
});
