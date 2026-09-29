import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultRuntime, createHostedInterface } from "../src/index.js";

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openagi-hosted-provider-lifecycle-"));
}

test("hosted interface shutdown drains and closes the active model provider", async () => {
  let closed = 0;
  const dataDir = tempDataDir();
  const provider = {
    providerId: "lifecycle-test",
    model: "test-model",
    isConfigured: () => true,
    async generate() {
      return { id: "unused", text: "unused", provider: "lifecycle-test", model: "test-model", toolCalls: [] };
    },
    async close() { closed += 1; }
  };
  const runtime = createDefaultRuntime({ dataDir, modelProvider: provider, autoConnectMcp: false });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, dataDir, tickerMs: 0 });

  await app.listen();
  await app.close();
  assert.equal(closed, 1);
});

test("Codex admin status never reuses a provider retired through set_provider", async () => {
  const dataDir = tempDataDir();
  const previous = process.env.OPENAGI_PROVIDER;
  let closes = 0;
  const provider = {
    providerId: "openai-codex", model: "gpt-test",
    isConfigured: () => true,
    status: () => ({ provider: "openai-codex", readiness: "retired-instance" }),
    async generate() { return { text: "not used", provider: "openai-codex", model: "gpt-test", toolCalls: [] }; },
    async close() { closes += 1; }
  };
  const runtime = createDefaultRuntime({ dataDir, modelProvider: provider, autoConnectMcp: false });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, dataDir, authToken: "owner", tickerMs: 0 });
  const { url } = await app.listen();
  const getStatus = async () => {
    const response = await fetch(`${url}/admin/providers/openai-codex/status`, { headers: { authorization: "Bearer owner" } });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    assert.equal((await getStatus()).readiness, "retired-instance");
    assert.equal((await runtime.tools.invoke("set_provider", { preference: "auto" })).ok, true);
    assert.equal(closes, 1);
    assert.notEqual((await getStatus()).readiness, "retired-instance");
  } finally {
    if (previous === undefined) delete process.env.OPENAGI_PROVIDER;
    else process.env.OPENAGI_PROVIDER = previous;
    await app.close();
  }
});

test("Selecting an unqualified Codex provider leaves the working default unchanged", async () => {
  const dataDir = tempDataDir();
  const priorPreference = process.env.OPENAGI_PROVIDER;
  const priorHash = process.env.OPENAGI_CODEX_SHA256;
  delete process.env.OPENAGI_CODEX_SHA256;
  const active = {
    providerId: "working", model: "test-model", isConfigured: () => true,
    async generate() { return { text: "working", toolCalls: [] }; }, async close() {}
  };
  const runtime = createDefaultRuntime({ dataDir, modelProvider: active, autoConnectMcp: false });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, dataDir, authToken: "owner", tickerMs: 0 });
  const { url } = await app.listen();
  try {
    const response = await fetch(`${url}/admin/provider`, {
      method: "POST", headers: { authorization: "Bearer owner", "content-type": "application/json" },
      body: JSON.stringify({ preference: "openai-codex" })
    });
    assert.equal(response.status, 409);
    assert.equal(runtime.agentHost.modelProvider, active);
    assert.equal(process.env.OPENAGI_PROVIDER, priorPreference);
  } finally {
    if (priorPreference === undefined) delete process.env.OPENAGI_PROVIDER;
    else process.env.OPENAGI_PROVIDER = priorPreference;
    if (priorHash === undefined) delete process.env.OPENAGI_CODEX_SHA256;
    else process.env.OPENAGI_CODEX_SHA256 = priorHash;
    await app.close();
  }
});

test("Setup cannot persist an unqualified Codex provider as the default", async () => {
  const dataDir = tempDataDir();
  const priorPreference = process.env.OPENAGI_PROVIDER;
  const active = {
    providerId: "working", model: "test-model", isConfigured: () => true,
    async generate() { return { text: "working", toolCalls: [] }; }, async close() {}
  };
  const runtime = createDefaultRuntime({ dataDir, modelProvider: active, autoConnectMcp: false });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, dataDir, authToken: "owner", tickerMs: 0 });
  const { url } = await app.listen();
  try {
    const response = await fetch(`${url}/setup/save`, {
      method: "POST", headers: { authorization: "Bearer owner", "content-type": "application/json" },
      body: JSON.stringify({ OPENAGI_PROVIDER: "openai-codex", OPENAGI_CODEX_MODEL: "gpt-test" })
    });
    assert.equal(response.status, 409);
    assert.equal(runtime.agentHost.modelProvider, active);
    assert.equal(process.env.OPENAGI_PROVIDER, priorPreference);
    assert.equal(fs.existsSync(path.join(dataDir, ".env")), false);
  } finally {
    if (priorPreference === undefined) delete process.env.OPENAGI_PROVIDER;
    else process.env.OPENAGI_PROVIDER = priorPreference;
    await app.close();
  }
});
