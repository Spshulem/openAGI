import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { VocaleoClient, VOCALEO_ENV_KEYS, registerVocaleoTools } from "../src/integrations/vocaleo.js";
import { createVocaleoRoute } from "../src/vocaleo-routes.js";
import { vocaleoUi } from "../src/vocaleo-ui.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { PendingActionStore } from "../src/pending-actions.js";
import { createDurableRuntime, createHostedInterface, IntegrationRegistry } from "../src/index.js";
import { renderWizard } from "../src/setup-wizard.js";

const ownerPhone = "+14155550123";
const account = { account_id: "account_fixture", balance_cents: 1000, price_cents_per_minute: 11,
  max_charge_cents_per_call: 450, pro_price_cents_per_minute: 17, pro_max_charge_cents_per_call: 675,
  payment_url: "https://example.com/payment", number_addon: { active: false, phone_number: null } };
const call = { to_phone_number: "+14155550199", task: "Ask whether a table for two is available tonight.", on_behalf_of: "Alex", idempotency_key: "fixture-attempt-1" };
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });

function fixture(t, { configured = true, fetchImpl } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-vocaleo-test-"));
  const previous = Object.fromEntries(VOCALEO_ENV_KEYS.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const env = configured ? { VOCALEO_API_KEY: "vok_fixture_key" } : {};
  const requests = [];
  const client = new VocaleoClient({ dataDir, env, fetchImpl: async (url, init) => {
    requests.push({ url, ...init });
    if (fetchImpl) return fetchImpl(url, init);
    if (url.endsWith("/v1/accounts")) return response({ phone_number: ownerPhone, expires_in_seconds: 300 }, 202);
    if (url.endsWith("/v1/accounts/verify")) return response({ ...account, api_key: "vok_created_secret" }, 201);
    if (url.endsWith("/v1/account")) return response(account);
    if (url.endsWith("/v1/calls")) return response({ call_id: "call_fixture", status: "queued", held_cents: 450 }, 202);
    return response({ call_id: "call_fixture", status: "completed", outcome: "achieved", summary: "Available.", charged_cents: 11, held_cents: 0 });
  } });
  const runtime = { tools: new ToolRegistry(), pendingActions: new PendingActionStore({ dir: path.join(dataDir, "pending") }) };
  runtime.tools.bindPendingActions(runtime.pendingActions);
  registerVocaleoTools(runtime, client);
  return { dataDir, client, runtime, requests, route: createVocaleoRoute({ runtime, client, dataDir }) };
}

test("optional setup verifies the owner, saves the key privately, enables tools, and disconnects", async t => {
  const { dataDir, client, runtime, requests, route } = fixture(t, { configured: false });
  const post = (action, body) => route("POST", "/integrations/vocaleo/" + action, async () => body);
  assert.equal(runtime.tools.has("vocaleo_start_call"), false);
  const sent = await post("request-code", { phone_number: ownerPhone });
  assert.equal(sent.status, 202);
  assert.equal(requests[0].headers.Authorization, undefined);
  assert.equal(fs.existsSync(path.join(dataDir, ".env")), false);
  const verified = await post("verify", { phone_number: ownerPhone, code: "424242" });
  assert.equal(verified.status, 200);
  assert.equal(requests[1].headers.Authorization, undefined);
  assert.equal(JSON.stringify(verified).includes("vok_created_secret"), false);
  assert.equal(JSON.stringify(verified).includes("424242"), false);
  const file = path.join(dataDir, ".env");
  assert.match(fs.readFileSync(file, "utf8"), /VOCALEO_API_KEY=vok_created_secret/);
  assert.match(fs.readFileSync(file, "utf8"), /VOCALEO_ACCOUNT_ID=account_fixture/);
  assert.equal(fs.readFileSync(file, "utf8").includes("424242"), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(runtime.tools.has("vocaleo_start_call"), true);
  assert.equal(client.status().phone_number, ownerPhone);
  assert.equal((await runtime.tools.invoke("vocaleo_get_account", {})).result.balance_cents, 1000);
  const newRuntime = { tools: new ToolRegistry() };
  registerVocaleoTools(newRuntime, new VocaleoClient({ dataDir, env: { ...client.env } }));
  assert.equal(newRuntime.tools.has("vocaleo_start_call"), true, "saved config works after restart");
  const beforeDisconnect = requests.length;
  assert.equal((await post("disconnect", {})).status, 200);
  assert.equal(requests.length, beforeDisconnect, "disconnect is local; no account closure call");
  assert.equal(runtime.tools.has("vocaleo_start_call"), false);
  assert.equal(client.configured, false);
  assert.equal(fs.readFileSync(file, "utf8").includes("VOCALEO_"), false);
});

test("existing-key setup checks it before saving and clears the previous owner phone", async t => {
  const { route, client, requests } = fixture(t);
  client.env.VOCALEO_PHONE_NUMBER = ownerPhone;
  const result = await route("POST", "/integrations/vocaleo/connect", async () => ({ api_key: "vok_existing" }));
  assert.equal(result.status, 200);
  assert.equal(requests[0].headers.Authorization, "Bearer vok_existing");
  assert.equal(client.env.VOCALEO_API_KEY, "vok_existing");
  assert.equal(client.env.VOCALEO_PHONE_NUMBER, undefined);
  assert.equal(JSON.stringify(result).includes("vok_existing"), false);
});

test("invalid input and upstream errors never save or expose keys/codes", async t => {
  const { route, requests, dataDir } = fixture(t, { configured: false,
    fetchImpl: () => response({ error: { message: "secret vok_reflected 424242" } }, 429, { "retry-after": "45" }) });
  const badPhone = await route("POST", "/integrations/vocaleo/request-code", async () => ({ phone_number: "415 555 0123" }));
  assert.equal(badPhone.status, 400); assert.equal(requests.length, 0);
  const badCode = await route("POST", "/integrations/vocaleo/verify", async () => ({ phone_number: ownerPhone, code: "x" }));
  assert.equal(badCode.status, 400); assert.equal(requests.length, 0);
  const limited = await route("POST", "/integrations/vocaleo/verify", async () => ({ phone_number: ownerPhone, code: "424242" }));
  assert.equal(limited.status, 429); assert.equal(limited.body.retry_after_seconds, 45);
  assert.doesNotMatch(JSON.stringify(limited), /vok_reflected|424242/);
  assert.equal(fs.existsSync(path.join(dataDir, ".env")), false);
  assert.equal((await route("GET", "/integrations/vocaleo/unknown/status", async () => ({}))).status, 404);
});

test("call approval quotes live prices, cannot send early, and preserves request identity", async t => {
  const { runtime, requests } = fixture(t);
  const queued = await runtime.tools.invoke("vocaleo_start_call", call);
  assert.equal(queued.result.status, "awaiting_confirmation");
  assert.equal(requests.filter(r => r.method === "POST").length, 0);
  const action = runtime.pendingActions.get(queued.result.actionId);
  assert.match(action.summary, /11¢\/started min, 450¢/);
  assert.equal(action.args.pro_mode, false);
  assert.doesNotMatch(JSON.stringify(action), /vok_fixture_key/);
  const repeated = await runtime.tools.invoke("vocaleo_start_call", call);
  assert.equal(repeated.result.actionId, action.id);
  const sent = await runtime.tools.invoke(action.toolName, action.args, { __confirmed: true });
  assert.equal(sent.result.call_id, "call_fixture");
  const request = requests.find(r => r.method === "POST");
  assert.equal(request.headers["Idempotency-Key"], call.idempotency_key);
  assert.equal(request.headers.Authorization, "Bearer vok_fixture_key");
  assert.equal(request.redirect, "error");
  assert.deepEqual(JSON.parse(request.body), { to_phone_number: call.to_phone_number, task: call.task, on_behalf_of: "Alex", pro_mode: false });
  const result = await runtime.tools.invoke("vocaleo_get_call", { call_id: sent.result.call_id });
  assert.equal(result.result.outcome, "achieved");
  assert.equal(result.result.charged_cents, 11);
});

test("call execution fails closed without approval infrastructure", async t => {
  const { client } = fixture(t);
  const runtime = { tools: new ToolRegistry() };
  registerVocaleoTools(runtime, client);
  const result = await runtime.tools.invoke("vocaleo_start_call", call);
  assert.equal(result.ok, false); assert.match(result.error, /Approve/);
  assert.equal((await runtime.tools.invoke("vocaleo_start_call", { ...call, __confirmed: true })).ok, false);
});

test("Pro mode uses its own reserve and read-only scrutiny cannot call", async t => {
  const { runtime } = fixture(t);
  const queued = await runtime.tools.invoke("vocaleo_start_call", { ...call, pro_mode: true });
  assert.match(queued.result.summary, /Pro: 17¢\/started min, 675¢/);
  const blocked = await runtime.tools.invoke("vocaleo_start_call", call, { __scrutinyPolicy: "read-only" });
  assert.equal(blocked.ok, false);
});

test("insufficient credit and unsupported numbers cannot create a call", async t => {
  const { runtime, requests } = fixture(t, { fetchImpl: () => response({ ...account, balance_cents: 500 }) });
  assert.equal((await runtime.tools.invoke("vocaleo_start_call", { ...call, pro_mode: true })).ok, false);
  assert.equal((await runtime.tools.invoke("vocaleo_start_call", { ...call, to_phone_number: "+33123456789" })).ok, false);
  assert.equal((await runtime.tools.invoke("vocaleo_start_call", { ...call, pro_mode: "true" })).ok, false);
  assert.equal((await runtime.tools.invoke("vocaleo_get_call", { call_id: "../account" })).ok, false);
  assert.equal((await runtime.tools.invoke("vocaleo_get_call", { call_id: "call_fixture", wait_seconds: 60 })).ok, false);
  assert.equal(requests.some(r => r.method === "POST"), false);
});

test("changed account or price invalidates outstanding approval", async t => {
  let current = { ...account };
  const { runtime, client, requests } = fixture(t, { fetchImpl: () => response(current) });
  const queued = await runtime.tools.invoke("vocaleo_start_call", call);
  const args = runtime.pendingActions.get(queued.result.actionId).args;
  current = { ...account, price_cents_per_minute: 20 };
  assert.equal((await runtime.tools.invoke("vocaleo_start_call", args, { __confirmed: true })).ok, false);
  current = { ...account };
  client.env.VOCALEO_API_KEY = "vok_replaced";
  assert.equal((await runtime.tools.invoke("vocaleo_start_call", args, { __confirmed: true })).ok, false);
  assert.equal(requests.some(r => r.method === "POST"), false);
});

test("uncertain dispatch retries after restart with the same key despite a held reserve", async t => {
  let attempts = 0;
  const { runtime, client, dataDir } = fixture(t, { fetchImpl: (url, init) => {
    if (url.endsWith("/account")) return response({ ...account, balance_cents: attempts ? 0 : 1000 });
    assert.equal(init.headers["Idempotency-Key"], call.idempotency_key);
    attempts++;
    if (attempts === 1) throw new Error("uncertain dispatch");
    return response({ call_id: "call_original", status: "queued" }, 202);
  } });
  const queued = await runtime.tools.invoke("vocaleo_start_call", call);
  const args = runtime.pendingActions.get(queued.result.actionId).args;
  assert.equal((await runtime.tools.invoke("vocaleo_start_call", args, { __confirmed: true })).ok, false);
  assert.equal(fs.statSync(client.attemptPath(call.idempotency_key)).mode & 0o777, 0o600);
  const restarted = new VocaleoClient({ dataDir, env: client.env, fetchImpl: client.fetch });
  registerVocaleoTools(runtime, restarted);
  const retry = await runtime.tools.invoke("vocaleo_start_call", call);
  const retried = await runtime.tools.invoke("vocaleo_start_call", runtime.pendingActions.get(retry.result.actionId).args, { __confirmed: true });
  assert.equal(retried.result.call_id, "call_original");
  assert.equal((await runtime.tools.invoke("vocaleo_start_call", { ...call, task: "Changed task" })).ok, false);
  assert.equal(attempts, 2);
});

test("suspended dedicated number is disclosed before approval", async t => {
  const { runtime } = fixture(t, { fetchImpl: () => response({ ...account, number_addon: { phone_number: ownerPhone, active: false } }) });
  const queued = await runtime.tools.invoke("vocaleo_start_call", call);
  assert.match(queued.result.summary, /Dedicated number inactive; uses shared number/);
});

test("authenticated HTTP setup and approval flow uses the real hosted routes", async t => {
  const { dataDir, client, requests } = fixture(t, { configured: false });
  const runtime = createDurableRuntime({ dataDir, registerDefaults: false, integrations: false, skills: false, agentHost: false, autoConnectMcp: false });
  runtime.integrations = new IntegrationRegistry();
  const app = createHostedInterface(runtime, { dataDir, port: 0, authToken: "fixture-owner-token", tickerMs: 0, nodeControlEnabled: false, vocaleoClient: client });
  t.after(async () => {
    await app.close();
    runtime.observations?.db?.close(); runtime.vectorStore?.db?.close(); runtime.sessionIndex?.db?.close();
  });
  const { url } = await app.listen();
  const headers = { Authorization: "Bearer fixture-owner-token", "content-type": "application/json" };
  const json = async (route, body) => {
    const res = await fetch(url + route, { headers, method: body ? "POST" : "GET", ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() };
  };
  assert.equal((await fetch(url + "/integrations/vocaleo/status")).status, 401);
  assert.equal((await fetch(url + "/integrations/vocaleo/request-code", { method: "POST", headers: { ...headers, Origin: "https://example.com" }, body: JSON.stringify({ phone_number: ownerPhone }) })).status, 403);
  assert.equal(requests.length, 0);
  assert.equal((await json("/integrations/vocaleo/request-code", { phone_number: ownerPhone })).status, 202);
  assert.equal((await json("/integrations/vocaleo/verify", { phone_number: ownerPhone, code: "424242" })).status, 200);
  const queued = await runtime.tools.invoke("vocaleo_start_call", call);
  assert.equal(queued.result.status, "awaiting_confirmation");
  const approved = await json(`/pending-actions/${queued.result.actionId}/approve`, {});
  assert.equal(approved.status, 200);
  assert.equal(approved.body.result.call_id, "call_fixture");
  assert.equal((await json(`/pending-actions/${queued.result.actionId}/approve`, {})).status, 409);
  assert.equal(requests.filter(r => r.url.endsWith("/v1/calls")).length, 1);
  assert.equal((await json("/integrations/vocaleo/disconnect", {})).status, 200);
  assert.equal(runtime.tools.has("vocaleo_start_call"), false);
});

test("setup discovery and browser code render without exposing credentials", () => {
  new vm.Script(vocaleoUi);
  const html = renderWizard({ existingEnv: { VOCALEO_API_KEY: "vok_must_not_render" } });
  assert.match(html, /Integrations → Vocaleo/);
  assert.doesNotMatch(html, /vok_must_not_render/);
});
