import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultRuntime } from "../src/index.js";

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openagi-provider-swap-"));
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("AgentHost atomically swaps providers while an in-flight turn retains and drains the old provider", async () => {
  const gate = deferred();
  const entered = deferred();
  let oldClosed = 0;
  const oldProvider = {
    providerId: "old",
    model: "old-model",
    isConfigured: () => true,
    async generate() {
      entered.resolve();
      await gate.promise;
      return { id: "old-result", text: "old reply", provider: "old", model: "old-model", toolCalls: [] };
    },
    async close() { oldClosed += 1; }
  };
  const newProvider = {
    providerId: "new",
    model: "new-model",
    isConfigured: () => true,
    async generate() {
      return { id: "new-result", text: "new reply", provider: "new", model: "new-model", toolCalls: [] };
    },
    async close() {}
  };
  const dataDir = tempDataDir();
  const runtime = createDefaultRuntime({ dataDir, modelProvider: oldProvider, autoConnectMcp: false });

  const first = runtime.agentHost.handleMessage({ text: "first", ephemeral: true, routeTo: false });
  await entered.promise;
  const replacing = runtime.agentHost.replaceModelProvider(newProvider);
  assert.equal(runtime.agentHost.modelProvider, newProvider);
  assert.equal(oldClosed, 0);

  gate.resolve();
  const firstResult = await first;
  await replacing;
  assert.equal(firstResult.reply, "old reply");
  assert.equal(oldClosed, 1);

  const secondResult = await runtime.agentHost.handleMessage({ text: "second", ephemeral: true, routeTo: false });
  assert.equal(secondResult.reply, "new reply");
});

test("AgentHost shutdown rejects new turns and closes its provider after active turns drain", async () => {
  const gate = deferred();
  const entered = deferred();
  let closed = 0;
  const provider = {
    providerId: "closable",
    model: "test-model",
    isConfigured: () => true,
    async generate() {
      entered.resolve();
      await gate.promise;
      return { id: "done", text: "done", provider: "closable", model: "test-model", toolCalls: [] };
    },
    async close() { closed += 1; }
  };
  const runtime = createDefaultRuntime({ dataDir: tempDataDir(), modelProvider: provider, autoConnectMcp: false });
  const active = runtime.agentHost.handleMessage({ text: "active", ephemeral: true, routeTo: false });
  await entered.promise;

  const closing = runtime.agentHost.close();
  await assert.rejects(
    runtime.agentHost.handleMessage({ text: "late", ephemeral: true, routeTo: false }),
    (error) => error?.code === "AGENT_HOST_CLOSING"
  );
  assert.equal(closed, 0);
  gate.resolve();
  await active;
  await closing;
  assert.equal(closed, 1);
});

test("set_provider invoked inside a model turn swaps immediately without waiting for its own lease", async () => {
  const dataDir = tempDataDir();
  const previous = process.env.OPENAGI_PROVIDER;
  let runtime;
  let closed = 0;
  const oldProvider = {
    providerId: "old",
    model: "old-model",
    isConfigured: () => true,
    async generate() {
      const changed = await runtime.tools.invoke("set_provider", { preference: "auto" });
      assert.equal(changed.ok, true);
      assert.notEqual(runtime.agentHost.modelProvider, oldProvider);
      assert.equal(closed, 0);
      return { text: "changed", toolCalls: [], provider: "old", model: "old-model" };
    },
    async close() { closed += 1; }
  };
  runtime = createDefaultRuntime({ dataDir, modelProvider: oldProvider, autoConnectMcp: false });
  try {
    const result = await Promise.race([
      runtime.agentHost.handleMessage({ text: "switch", routeTo: false, ephemeral: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("set_provider deadlocked")), 1000))
    ]);
    assert.equal(result.reply, "changed");
    assert.equal(closed, 1);
  } finally {
    if (previous === undefined) delete process.env.OPENAGI_PROVIDER;
    else process.env.OPENAGI_PROVIDER = previous;
  }
});

test("set_provider rejects a direct unqualified Codex request without changing the active provider", async () => {
  const dataDir = tempDataDir();
  const old = process.env.OPENAGI_PROVIDER;
  const active = {
    providerId: "working", model: "working-model", isConfigured: () => true,
    async generate() { return { text: "working", toolCalls: [] }; }, async close() {}
  };
  const runtime = createDefaultRuntime({ dataDir, modelProvider: active, autoConnectMcp: false });
  try {
    const result = await runtime.tools.invoke("set_provider", { preference: "openai-codex" });
    assert.equal(result.ok, false);
    assert.equal(runtime.agentHost.modelProvider, active);
    assert.equal(process.env.OPENAGI_PROVIDER, old);
  } finally {
    if (old === undefined) delete process.env.OPENAGI_PROVIDER;
    else process.env.OPENAGI_PROVIDER = old;
  }
});
