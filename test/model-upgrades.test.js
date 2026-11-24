// The daily model check suggests newer models the owner's keys can reach and
// flags configured models that are gone. It never changes config, and each
// suggestion reaches the owner once.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkModelUpgrades, configuredModels, newestSuccessor, parseModelId, readModelUpgradeCache, suggestModelUpgrades } from "../src/model-upgrades.js";
import { DEFAULT_OPENAI_MODEL, DEFAULT_OPENAI_SMALL_MODEL } from "../src/model-router.js";
import { OpenAIResponsesProvider } from "../src/model-provider.js";
import { CodexCliProvider, codexCliStatus } from "../src/cli-subscription-providers.js";
import { CHATGPT_DEFAULT_MODEL } from "../src/chatgpt-provider.js";

// Shape of the owner's real OpenAI catalog on 2026-11-24 (trimmed).
const OPENAI_IDS = ["gpt-4.1", "gpt-5", "gpt-5-mini", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.5-2026-04-23", "gpt-5.5-pro",
  "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra", "gpt-6-astra-healthcare", "gpt-6-luna", "gpt-6-sol",
  "gpt-6.1-sol", "gpt-6.1-sol-healthcare", "gpt-6.1-terra", "gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.2-sol-healthcare", "o3", "o3-pro"];

test("defaults moved to GPT-6", () => {
  assert.equal(DEFAULT_OPENAI_MODEL, "gpt-6.2-sol");
  assert.equal(DEFAULT_OPENAI_SMALL_MODEL, "gpt-6-luna");
  assert.equal(CHATGPT_DEFAULT_MODEL, "gpt-6.2-sol");
  const prev = process.env.OPENAI_MODEL;
  delete process.env.OPENAI_MODEL;
  try { assert.equal(new OpenAIResponsesProvider({ apiKey: "sk-test" }).model, "gpt-6.2-sol"); }
  finally { if (prev !== undefined) process.env.OPENAI_MODEL = prev; }
  assert.equal(new CodexCliProvider({ bin: "/usr/bin/codex", env: {} }).model, "gpt-6.2-sol");
  assert.equal(codexCliStatus({ env: { PATH: "" }, homeDir: os.tmpdir() }).model, "gpt-6.2-sol");
});

test("parses model ids and ignores specialty builds", () => {
  assert.deepEqual(parseModelId("gpt-6.1-sol").version, [6, 1]);
  assert.equal(parseModelId("gpt-6.1-sol").variant, "sol");
  assert.equal(parseModelId("gpt-5").variant, "");
  assert.equal(parseModelId("gpt-5.5-2026-04-23").snapshot, true);
  assert.equal(parseModelId("gpt-6.2-sol-healthcare"), null);
  assert.equal(parseModelId("gpt-5.5-pro"), null);
  assert.deepEqual(parseModelId("claude-sonnet-4-6").version, [4, 6]);
  assert.deepEqual(parseModelId("claude-opus-4-1-20250805").version, [4, 1]);
  assert.equal(parseModelId("whisper-1"), null);
});

test("successor is the newest same-variant model, never a different tier or specialty build", () => {
  assert.equal(newestSuccessor("gpt-6.1-sol", OPENAI_IDS), "gpt-6.2-sol");
  assert.equal(newestSuccessor("gpt-6.2-sol", OPENAI_IDS), null, "already newest");
  assert.equal(newestSuccessor("gpt-6-luna", OPENAI_IDS), null, "no newer luna (gpt-5.6-luna is older)");
  assert.equal(newestSuccessor("gpt-6-astra", OPENAI_IDS), "gpt-6.2-astra");
  assert.equal(newestSuccessor("gpt-6.1-terra", OPENAI_IDS), null);
  assert.equal(newestSuccessor("gpt-5", OPENAI_IDS), "gpt-6.2-sol", "unvariant gpt-5 maps to sol");
  assert.equal(newestSuccessor("gpt-5.4-mini", OPENAI_IDS), "gpt-6-luna", "size ladder maps to luna");
  assert.equal(newestSuccessor("gpt-5.4", ["gpt-5.5-2026-04-23", "gpt-5.5"]), "gpt-5.5", "undated alias over snapshot");
  assert.equal(newestSuccessor("claude-sonnet-4-6", ["claude-sonnet-4-7", "claude-opus-5-0", "claude-sonnet-4-5"]), "claude-sonnet-4-7");
});

test("owner's live config: suggests gpt-6.2-sol for OPENAI_MODEL and flags a missing model", () => {
  const env = { OPENAI_API_KEY: "sk", OPENAI_MODEL: "gpt-6.1-sol", OPENAI_MODEL_MINI: "gpt-6-luna", OPENAI_MODEL_NANO: "gpt-6.2-luna" };
  const s = suggestModelUpgrades({ configured: configuredModels(env), available: { openai: OPENAI_IDS } });
  assert.deepEqual(s.map((x) => [x.kind, x.key, x.model, x.suggested]), [
    ["upgrade", "OPENAI_MODEL", "gpt-6.1-sol", "gpt-6.2-sol"],
    ["unavailable", "OPENAI_MODEL_NANO", "gpt-6.2-luna", "gpt-6-luna"]
  ]);
  assert.deepEqual(suggestModelUpgrades({ configured: configuredModels(env), available: {} }), [], "catalog not read: say nothing");
  assert.deepEqual(configuredModels({}), [], "no keys, nothing to check");
  assert.equal(configuredModels({ OPENAI_API_KEY: "sk" })[0].model, "gpt-6.2-sol", "unset key checks the default that runs");
});

test("checkModelUpgrades caches, announces each suggestion once, and never edits config", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-model-upg-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const env = { OPENAI_API_KEY: "sk-live", OPENAI_MODEL: "gpt-6.1-sol", ANTHROPIC_API_KEY: "ak", ANTHROPIC_MODEL: "claude-sonnet-4-6" };
  const before = JSON.stringify(env);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    if (url.startsWith("https://api.openai.com/")) return new Response(JSON.stringify({ data: OPENAI_IDS.map((id) => ({ id })) }));
    return new Response("{}", { status: 500 });
  };
  const items = [];
  const outreach = { append: (item) => { items.push(item); return item; } };
  const first = await checkModelUpgrades({ env, dataDir, fetchImpl, outreach });
  assert.equal(calls[0].url, "https://api.openai.com/v1/models");
  assert.equal(calls[0].headers.authorization, "Bearer sk-live");
  assert.equal(calls[1].headers["x-api-key"], "ak");
  assert.deepEqual(first.checked, ["openai"]);
  assert.match(first.errors.anthropic, /HTTP 500/);
  assert.equal(first.suggestions.length, 1);
  assert.match(first.suggestions[0].summary, /OPENAI_MODEL=gpt-6.2-sol/);
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "suggestion");
  assert.match(items[0].title, /gpt-6.2-sol/);
  assert.equal(readModelUpgradeCache(dataDir).suggestions[0].suggested, "gpt-6.2-sol");

  await checkModelUpgrades({ env, dataDir, fetchImpl, outreach });
  assert.equal(items.length, 1, "same suggestion is not re-announced");
  assert.equal(JSON.stringify(env), before, "config untouched");
});

test("review fixes: prefixed catalog ids, Anthropic default + base URL, outreach opt-out", async (t) => {
  // The suggestion is the catalog's own id, not a stripped one.
  assert.equal(newestSuccessor("openai/gpt-6.1-sol", ["openai/gpt-6.1-sol", "openai/gpt-6.2-sol"]), "openai/gpt-6.2-sol");
  const prefixed = suggestModelUpgrades({
    configured: [{ provider: "openai", key: "OPENAI_MODEL_NANO", model: "openai/gpt-6.2-luna" }],
    available: { openai: ["openai/gpt-6-luna", "openai/gpt-6.2-sol"] }
  });
  assert.equal(prefixed[0].suggested, "openai/gpt-6-luna");

  // An Anthropic key with ANTHROPIC_MODEL unset checks the model that runs.
  const anth = configuredModels({ ANTHROPIC_API_KEY: "ak" });
  assert.deepEqual(anth.map((c) => [c.key, c.model, c.explicit]), [["ANTHROPIC_MODEL", "claude-sonnet-4-6", false]]);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-model-upg2-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-6" }, { id: "claude-sonnet-4-7" }] })); };
  const env = { ANTHROPIC_API_KEY: "proxy-key", ANTHROPIC_BASE_URL: "https://proxy.example/v1/" };

  // Outreach off: the check and cache still run, nothing is announced or
  // marked announced.
  const silent = await checkModelUpgrades({ env, dataDir, fetchImpl, outreach: null });
  assert.equal(urls[0], "https://proxy.example/v1/models?limit=1000", "the configured base URL, not api.anthropic.com");
  assert.equal(silent.suggestions[0].suggested, "claude-sonnet-4-7");
  assert.deepEqual(silent.announced, []);
  assert.equal(readModelUpgradeCache(dataDir).suggestions.length, 1);

  // Outreach back on: delivered once.
  const items = [];
  const on = await checkModelUpgrades({ env, dataDir, fetchImpl, outreach: { append: (i) => items.push(i) } });
  assert.equal(items.length, 1);
  assert.equal(on.announced.length, 1);
});

test("the daily job passes no outreach store when outreach is disabled", async (t) => {
  const { createDurableRuntime } = await import("../src/index.js");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-model-upg-rt-"));
  fs.writeFileSync(path.join(dataDir, "outreach.json"), JSON.stringify({ enabled: false }));
  const runtime = createDurableRuntime({ dataDir, registerDefaults: false, integrations: false, skills: false, autoConnectMcp: false });
  t.after(() => {
    for (const store of [runtime?.observations, runtime?.vectorStore, runtime?.sessionIndex]) store?.db?.close?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  assert.equal(runtime.outreachConfig.enabled, false);
  const appended = [];
  runtime.outreach.append = (i) => { appended.push(i); return i; };
  const prev = { k: process.env.OPENAI_API_KEY, f: globalThis.fetch };
  process.env.OPENAI_API_KEY = "sk-test";
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ id: "gpt-6.2-sol" }, { id: "gpt-7-sol" }] }));
  try {
    const result = await runtime.runJobTask({ id: "model-upgrade-check", task: "model-upgrade-check" });
    assert.equal(result.suggestions[0].suggested, "gpt-7-sol");
    assert.deepEqual(appended, [], "nothing announced while outreach is off");
  } finally {
    if (prev.k === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prev.k;
    globalThis.fetch = prev.f;
  }
});

test("review fixes: OpenRouter key never sent to api.openai.com; denied models never suggested", async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return new Response(JSON.stringify({ data: [{ id: "gpt-6.2-sol" }] })); };
  const r = await checkModelUpgrades({ env: { OPENAI_API_KEY: "sk-or-v1-abc", OPENAI_MODEL: "gpt-6.1-sol" }, fetchImpl });
  assert.deepEqual(calls, [], "no request carries the OpenRouter key to OpenAI");
  assert.match(r.errors.openai, /OpenRouter key/);
  await checkModelUpgrades({ env: { OPENAI_API_KEY: "sk-or-v1-abc", OPENAI_BASE_URL: "https://openrouter.ai/api/v1", OPENAI_MODEL: "gpt-6.1-sol" }, fetchImpl });
  assert.deepEqual(calls, ["https://openrouter.ai/api/v1/models"], "a matching base URL is allowed");

  const env = { OPENAI_API_KEY: "sk", OPENAI_MODEL: "gpt-6.1-sol", OPENAI_MODEL_NANO: "gpt-6.2-luna", OPENAGI_MODEL_DENY: "gpt-6.2-sol,gpt-6-luna" };
  const s = suggestModelUpgrades({ configured: configuredModels(env), available: { openai: ["gpt-6.1-sol", "gpt-6.2-sol", "gpt-6-luna"] }, env });
  assert.deepEqual(s.map((x) => [x.kind, x.key, x.suggested]), [["unavailable", "OPENAI_MODEL_NANO", null]],
    "no upgrade to the denied gpt-6.2-sol, no denied replacement");
  assert.equal(newestSuccessor("gpt-6-sol", ["gpt-6.1-sol", "gpt-6.2-sol"], { isDenied: (m) => m === "gpt-6.2-sol" }), "gpt-6.1-sol");
});
