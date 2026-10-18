import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateOpenAIKey } from "../src/provider-credentials.js";
import { OpenAIResponsesProvider } from "../src/model-provider.js";
import { publicAgentFailure } from "../src/agent-failure.js";
import { saveEnv, renderWizard } from "../src/setup-wizard.js";

test("known mismatched keys fail before any provider request, including streaming", async () => {
  for (const streaming of [false, true]) {
    let requests = 0;
    const provider = new OpenAIResponsesProvider({ apiKey: "sk-or-fixture", baseUrl: "https://api.openai.com/v1", fetchImpl: async () => { requests += 1; } });
    await assert.rejects(provider.generate({ input: "hi", agent: { name: "Test" }, ...(streaming ? { onTextDelta() {} } : {}) }), { code: "PROVIDER_CONFIG_MISMATCH" });
    assert.equal(requests, 0);
  }
});

test("setup rejects a mismatched key without changing the saved file or live credentials", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-provider-setup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keys = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"];
  const previous = keys.map((key) => process.env[key]);
  t.after(() => keys.forEach((key, i) => previous[i] === undefined ? delete process.env[key] : process.env[key] = previous[i]));
  process.env.OPENAI_API_KEY = "existing-fixture";
  process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
  fs.writeFileSync(path.join(dir, ".env"), "OPENAI_API_KEY=existing-fixture\n");
  assert.throws(() => saveEnv({ dataDir: dir, values: { OPENAI_API_KEY: "sk-or-fixture", OPENAI_BASE_URL: "https://api.openai.com/v1" } }), { code: "PROVIDER_CONFIG_MISMATCH" });
  assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), "OPENAI_API_KEY=existing-fixture\n");
  assert.equal(process.env.OPENAI_API_KEY, "existing-fixture");
  saveEnv({ dataDir: dir, values: { OPENAI_API_KEY: "sk-or-fixture", OPENAI_BASE_URL: "https://compatible.example/v1", OPENAI_MODEL: "provider/model" } });
  assert.match(fs.readFileSync(path.join(dir, ".env"), "utf8"), /OPENAI_BASE_URL=https:\/\/compatible.example\/v1/);
  assert.equal(process.env.OPENAI_MODEL, "provider/model");
  assert.equal(fs.statSync(path.join(dir, ".env")).mode & 0o777, 0o600);
});

test("explicit compatible endpoints and ordinary OpenAI keys retain their existing path", () => {
  assert.doesNotThrow(() => validateOpenAIKey("sk-or-fixture", "https://compatible.example/v1"));
  assert.doesNotThrow(() => validateOpenAIKey("fixture-openai", "https://api.openai.com/v1"));
  assert.match(renderWizard({ existingEnv: {} }), /name="OPENAI_BASE_URL"/);
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
