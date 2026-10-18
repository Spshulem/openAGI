import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateOpenAIKey } from "../src/provider-credentials.js";
import { OpenAIResponsesProvider } from "../src/model-provider.js";
import { publicAgentFailure } from "../src/agent-failure.js";
import { saveEnv, renderWizard } from "../src/setup-wizard.js";
import { OpenAIEmbedder } from "../src/embeddings.js";
import { G2Channel } from "../src/integrations/g2-channel.js";
import { VoiceSession } from "../src/voice/broker.js";

test("known mismatched keys fail before any provider request, including streaming", async () => {
  for (const streaming of [false, true]) {
    let requests = 0;
    const provider = new OpenAIResponsesProvider({ apiKey: "sk-or-fixture", baseUrl: "https://api.openai.com/v1", fetchImpl: async () => { requests += 1; } });
    await assert.rejects(provider.generate({ input: "hi", agent: { name: "Test" }, ...(streaming ? { onTextDelta() {} } : {}) }), { code: "PROVIDER_CONFIG_MISMATCH" });
    assert.equal(requests, 0);
  }
});

test("pre-model embedding searches reject mismatched credentials before fetching", async (t) => {
  const previous = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; throw new Error("must not send"); };
  t.after(() => { globalThis.fetch = previous; });
  const embedder = new OpenAIEmbedder({ apiKey: "sk-or-fixture", baseUrl: "https://api.openai.com/v1" });
  await assert.rejects(embedder.embed("routing search"), { code: "PROVIDER_CONFIG_MISMATCH" });
  await assert.rejects(embedder.embedMany(["memory", "specialists"]), { code: "PROVIDER_CONFIG_MISMATCH" });
  assert.equal(requests, 0);
});

test("speech consumers also refuse a wrong-provider key before opening a connection", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-provider-speech-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let requests = 0;
  const channel = new G2Channel({ dir, apiKey: "sk-or-fixture", baseUrl: "https://api.openai.com/v1", fetchImpl: async () => { requests += 1; } });
  await assert.rejects(channel.transcribe(Buffer.alloc(44)), { code: "PROVIDER_CONFIG_MISMATCH" });
  assert.throws(() => new VoiceSession({ apiKey: "sk-or-fixture", upstreamFactory: () => { requests += 1; } }), { code: "PROVIDER_CONFIG_MISMATCH" });
  assert.equal(requests, 0);
});

test("setup rejects a mismatched key without changing the saved file or live credentials", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-provider-setup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keys = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL", "OPENAGI_COMPUTER_USE"];
  const previous = keys.map((key) => process.env[key]);
  t.after(() => keys.forEach((key, i) => previous[i] === undefined ? delete process.env[key] : process.env[key] = previous[i]));
  process.env.OPENAI_API_KEY = "existing-fixture";
  process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
  fs.writeFileSync(path.join(dir, ".env"), "OPENAI_API_KEY=existing-fixture\n");
  assert.throws(() => saveEnv({ dataDir: dir, values: { OPENAI_API_KEY: "sk-or-fixture", OPENAI_BASE_URL: "https://api.openai.com/v1" } }), { code: "PROVIDER_CONFIG_MISMATCH" });
  assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), "OPENAI_API_KEY=existing-fixture\n");
  assert.equal(process.env.OPENAI_API_KEY, "existing-fixture");
  fs.writeFileSync(path.join(dir, ".env"), "OPENAI_API_KEY=sk-or-fixture\nOPENAI_BASE_URL=https://api.openai.com/v1\n");
  process.env.OPENAI_API_KEY = "sk-or-fixture";
  assert.doesNotThrow(() => saveEnv({ dataDir: dir, values: { OPENAGI_COMPUTER_USE: "1" } }), "unrelated settings remain repairable");
  assert.equal(process.env.OPENAGI_COMPUTER_USE, "1");
  assert.throws(() => saveEnv({ dataDir: dir, values: { OPENAGI_PROVIDER: "openai" } }), { code: "PROVIDER_CONFIG_MISMATCH" });
  saveEnv({ dataDir: dir, values: { OPENAI_API_KEY: "sk-or-fixture", OPENAI_BASE_URL: "https://compatible.example/v1", OPENAI_MODEL: "provider/model" } });
  assert.match(fs.readFileSync(path.join(dir, ".env"), "utf8"), /OPENAI_BASE_URL=https:\/\/compatible.example\/v1/);
  assert.equal(process.env.OPENAI_MODEL, "provider/model");
  assert.equal(fs.statSync(path.join(dir, ".env")).mode & 0o777, 0o600);
});

test("explicit compatible endpoints and ordinary OpenAI keys retain their existing path", () => {
  assert.throws(() => validateOpenAIKey("sk-or-fixture", "https://api.openai.com./v1"), { code: "PROVIDER_CONFIG_MISMATCH" });
  assert.doesNotThrow(() => validateOpenAIKey("sk-or-fixture", "https://compatible.example/v1"));
  assert.doesNotThrow(() => validateOpenAIKey("fixture-openai", "https://api.openai.com/v1"));
  assert.match(renderWizard({ existingEnv: {} }), /name="OPENAI_BASE_URL"/);
});

test("custom base URLs with trailing slashes produce routable model and embedding requests", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return { ok: true, json: async () => url.endsWith("/embeddings")
      ? { data: [{ embedding: [1, 0] }] } : { id: "response", output_text: "done", output: [] } };
  };
  globalThis.fetch = fetchImpl;
  const options = { apiKey: "fixture", baseUrl: "https://compatible.example/v1///", fetchImpl };
  const provider = new OpenAIResponsesProvider(options);
  assert.equal((await provider.generate({ input: "hello", instructions: "short", turnContext: "", agent: { name: "Test" } })).text, "done");
  assert.deepEqual(await new OpenAIEmbedder(options).embed("memory"), [1, 0]);
  assert.deepEqual(urls, ["https://compatible.example/v1/responses", "https://compatible.example/v1/embeddings"]);
});

test("region restrictions get an actionable public error without echoing provider secrets", () => {
  for (const message of ["Country, region, or territory not supported", "403 unsupported_country_region_territory", "Region is not supported"]) {
    const result = publicAgentFailure(new Error(`${message}; Bearer private-fixture-value`));
    assert.equal(result.code, "provider-region");
    assert.match(result.error, /provider available in your region/);
    assert.doesNotMatch(JSON.stringify(result), /private-fixture-value|Bearer/);
  }
  const error = new Error("private diagnostic");
  error.code = "PROVIDER_CONFIG_MISMATCH";
  assert.equal(publicAgentFailure(error).code, "provider-config");
});
