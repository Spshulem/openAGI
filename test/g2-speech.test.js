import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { G2Channel } from "../src/integrations/g2-channel.js";
import { NodeRegistry } from "../src/node-registry.js";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { isPublicRoute } from "../src/auth.js";

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "g2-speech-test-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const nodeRegistry = new NodeRegistry({ dir: path.join(dataDir, "nodes") });
  const nodeId = crypto.randomUUID();
  const token = "t".repeat(43);
  nodeRegistry.enroll(nodeId, token, { platform: "even_g2", name: "Speech test" });
  const requests = [];
  const channel = new G2Channel({
    dir: path.join(dataDir, "g2"), nodeRegistry, deepgramApiKey: "server-only-secret",
    agentHost: { handleMessage: async () => { throw new Error("Speech must not start agent work"); } },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, json: async () => ({ access_token: "temporary-voice-token", expires_in: 30 }) };
    }
  });
  return { channel, dataDir, nodeRegistry, nodeId, token, requests };
}

test("speech broker returns only short-lived grants, validates models and bounds reconnects", async t => {
  const { channel, nodeId, requests } = fixture(t);
  assert.deepEqual(await channel.speechToken({ model: "nova-3" }, nodeId), { accessToken: "temporary-voice-token", expiresIn: 30, model: "nova-3" });
  assert.equal(requests[0].url, "https://api.deepgram.com/v1/auth/grant");
  assert.equal(requests[0].init.redirect, "error");
  assert.equal(requests[0].init.headers.authorization, "Token server-only-secret");
  assert.deepEqual(JSON.parse(requests[0].init.body), { ttl_seconds: 30 });
  await assert.rejects(channel.speechToken({ model: "attacker-model" }, nodeId), { code: "invalid_speech_model" });
  await assert.rejects(channel.speechToken({}, "unknown-node"), { code: "forbidden_node" });
  for (let i = 0; i < 5; i++) await channel.speechToken({ model: "nova-2" }, nodeId);
  await assert.rejects(channel.speechToken({}, nodeId), { code: "speech_rate_limit" });
  assert.equal(requests.length, 6);
});

test("speech provider errors and missing configuration never leak the key", async t => {
  const { channel, nodeId } = fixture(t);
  channel.fetchImpl = async () => ({ ok: false, json: async () => ({ err_msg: "server-only-secret" }) });
  await assert.rejects(channel.speechToken({}, nodeId), error => error.status === 502 && !error.message.includes("server-only-secret"));
  channel.deepgramApiKey = null;
  await assert.rejects(channel.speechToken({}, nodeId), { code: "live_speech_not_configured" });
});

test("speech grants are G2 scoped even without owner auth; CORS and token-only connections work", async t => {
  const { channel, dataDir, nodeRegistry, nodeId, token, requests } = fixture(t);
  const previous = process.env.OPENAGI_AUTH_TOKEN;
  delete process.env.OPENAGI_AUTH_TOKEN;
  const runtime = createDurableRuntime({ dataDir });
  const channels = { g2: channel, status: () => ({}), start() {}, stop() {} };
  const app = createHostedInterface(runtime, { dataDir, nodeRegistry, channels, host: "127.0.0.1", port: 0 });
  try {
    const { url } = await app.listen();
    const route = `${url}/nodes/g2/speech-token`;
    assert.equal(isPublicRoute("/nodes/g2/speech-token"), false);
    const request = headers => fetch(route, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ model: "nova-3" }) });
    assert.ok([401, 403].includes((await request({})).status));
    assert.ok([401, 403].includes((await request({ authorization: "Bearer owner-token" })).status));
    assert.ok([401, 403].includes((await request({ authorization: `Bearer ${token}`, "x-openagi-node-id": "wrong" })).status));
    const other = crypto.randomUUID(); nodeRegistry.enroll(other, "o".repeat(43), { platform: "openagi" });
    assert.equal((await request({ authorization: `Bearer ${"o".repeat(43)}`, "x-openagi-node-id": other })).status, 403);
    assert.equal(requests.length, 0);
    const headers = { authorization: `Bearer ${token}`, origin: "null" };
    const response = await request(headers);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal((await response.json()).accessToken, "temporary-voice-token");
    assert.equal((await fetch(route, { method: "OPTIONS", headers: { origin: "null" } })).status, 204);
    assert.equal((await fetch(route, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ model: "nova-3", key: "no" }) })).status, 400);
    nodeRegistry.revoke(nodeId);
    assert.ok([401, 403].includes((await request(headers)).status));
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.OPENAGI_AUTH_TOKEN; else process.env.OPENAGI_AUTH_TOKEN = previous;
  }
});
