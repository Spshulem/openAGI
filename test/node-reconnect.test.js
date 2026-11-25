import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NodeRegistry } from "../src/node-registry.js";
import { NodeReconnectManager } from "../src/node-reconnect.js";
import { reconnectWorker, readNodeConfig, writeNodeConfig } from "../src/cli-client.js";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

function registryFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-reconnect-"));
  const registry = new NodeRegistry({ dir });
  registry.enroll("mac-node", "m".repeat(43), { platform: "openagi", name: "Mac mini" });
  registry.enroll("mobile-phone", "p".repeat(43), { platform: "mobile", name: "Owner iPhone" });
  return { dir, registry };
}

test("NodeReconnectManager binds approval and delivery to the exact node", () => {
  const { dir, registry } = registryFixture();
  let now = Date.now();
  const manager = new NodeReconnectManager({ mainNodeId: "main-identity", nodeRegistry: registry, now: () => now });
  try {
    const created = manager.create("mac-node");
    assert.equal(created.ok, true);
    assert.equal(created.created, true);
    assert.equal(manager.listForMobile().length, 1);
    const id = created.request.requestId;

    assert.equal(manager.statusForNode(id, "other-node").code, "forbidden_node");
    assert.equal(manager.approve(id, "mac-node").code, "mobile_approval_required");
    const approved = manager.approve(id, "mobile-phone");
    assert.equal(approved.ok, true);
    assert.equal(approved.request.ownerProxyToken, undefined, "phone response never contains a credential");
    assert.equal(manager.listForMobile().length, 0);
    const resumed = manager.create("mac-node");
    assert.equal(resumed.created, false, "an approved but unacknowledged request is resumable");
    assert.equal(resumed.request.requestId, id);
    assert.equal(resumed.request.status, "approved");

    const delivered = manager.statusForNode(id, "mac-node");
    assert.equal(delivered.ok, true);
    assert.match(delivered.request.ownerProxyToken, /^[A-Za-z0-9_-]{43}$/);
    const proxy = delivered.request.ownerProxyToken;
    assert.equal(registry.authenticateOwnerProxy("mac-node", proxy), true);
    assert.equal(manager.acknowledge(id, "other-node").code, "forbidden_node");
    assert.equal(manager.acknowledge(id, "mac-node").ok, true);
    assert.equal(manager.statusForNode(id, "mac-node").request.ownerProxyToken, undefined);

    registry.revoke("mac-node");
    assert.equal(registry.authenticate("mac-node", "m".repeat(43)), false);
    assert.equal(registry.authenticateOwnerProxy("mac-node", proxy), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reconnect requests expire and cannot be approved or replayed", () => {
  const { dir, registry } = registryFixture();
  let now = Date.now();
  const manager = new NodeReconnectManager({ mainNodeId: "main-identity", nodeRegistry: registry, ttlMs: 30_000, now: () => now });
  try {
    const request = manager.create("mac-node").request;
    now += 31_000;
    assert.equal(manager.listForMobile().length, 0);
    assert.equal(manager.approve(request.requestId, "mobile-phone").code, "request_expired");
    assert.equal(manager.statusForNode(request.requestId, "mac-node").request.status, "expired");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reconnectWorker uses only the saved operational credential and preserves pairing state", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-reconnect-cli-"));
  const nodeId = "mac-node";
  fs.writeFileSync(path.join(dataDir, "identity.json"), JSON.stringify({ nodeId, name: "Mac mini" }));
  writeNodeConfig({ remote: "https://main.example", token: "owner-token-must-not-leave", nodeToken: "m".repeat(43), nodeEnrollmentConfirmed: true }, dataDir);
  const seen = [];
  let statusCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, headers: init.headers });
    if (url.endsWith("/nodes/reconnect/request")) {
      return new Response(JSON.stringify({ requestId: "123e4567-e89b-12d3-a456-426614174000", status: "pending", expiresAt: new Date(Date.now() + 60_000).toISOString() }), { status: 201 });
    }
    if (url.includes("/nodes/reconnect/requests/") && init.method === "GET") {
      statusCalls += 1;
      return new Response(JSON.stringify({ requestId: "123e4567-e89b-12d3-a456-426614174000", status: "approved", ownerProxyToken: "x".repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString() }), { status: 200 });
    }
    if (url.endsWith("/ack")) return new Response(JSON.stringify({ status: "consumed" }), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const result = await reconnectWorker({ dataDir, fetchImpl, pollMs: 1, waitMs: 1_000, restart: false });
    assert.equal(result.ok, true);
    assert.equal(statusCalls, 1);
    assert.equal(seen.every(({ headers }) => !JSON.stringify(headers).includes("owner-token-must-not-leave")), true);
    assert.deepEqual(readNodeConfig(dataDir), {
      remote: "https://main.example",
      token: null,
      nodeToken: "m".repeat(43),
      ownerProxyToken: "x".repeat(43),
      nodeEnrollmentConfirmed: true
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("hosted reconnect routes require the node credential and phone approval", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-reconnect-http-"));
  const nodeRegistry = new NodeRegistry({ dir: path.join(dataDir, "nodes") });
  const runtime = createDurableRuntime({ dataDir, registerDefaults: false, integrations: false, skills: false,
    autoConnectMcp: false, modelProvider: { isConfigured: () => true, generate: async () => ({ text: "ok", provider: "test", model: "test", toolCalls: [] }) } });
  const app = createHostedInterface(runtime, { dataDir, nodeRegistry, host: "127.0.0.1", port: 0,
    tickerMs: 0, authToken: "main-owner", nodeControlEnabled: false });
  const { url } = await app.listen();
  t.after(async () => {
    await app.close();
    runtime.observations?.db?.close();
    runtime.vectorStore?.db?.close();
    runtime.sessionIndex?.db?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  nodeRegistry.enroll("mac-node", "m".repeat(43), { platform: "openagi", name: "Mac mini" });
  nodeRegistry.enroll("other-node", "o".repeat(43), { platform: "openagi", name: "Other Mac" });
  nodeRegistry.enroll("mobile-phone", "p".repeat(43), { platform: "mobile", name: "Owner iPhone" });
  const nodeAuth = { authorization: `Bearer ${"m".repeat(43)}`, "x-openagi-node-id": "mac-node", "content-type": "application/json" };
  const phoneAuth = { authorization: `Bearer ${"p".repeat(43)}`, "x-openagi-node-id": "mobile-phone", "content-type": "application/json" };

  assert.equal((await fetch(`${url}/nodes/reconnect/request`, { method: "POST", headers: nodeAuth, body: "{}" })).status, 201);
  const listed = await fetch(`${url}/nodes/reconnect/requests`, { headers: phoneAuth });
  assert.equal(listed.status, 200);
  const [{ requestId }] = (await listed.json()).requests;
  const approved = await fetch(`${url}/nodes/reconnect/requests/${requestId}/approve`, { method: "POST", headers: phoneAuth, body: "{}" });
  assert.equal(approved.status, 200);
  assert.equal(JSON.stringify(await approved.json()).includes("ownerProxyToken"), false);
  const delivered = await fetch(`${url}/nodes/reconnect/requests/${requestId}`, { headers: nodeAuth });
  const deliveredBody = await delivered.json();
  assert.equal(delivered.status, 200);
  assert.match(deliveredBody.ownerProxyToken, /^[A-Za-z0-9_-]{43}$/);
  const other = await fetch(`${url}/nodes/reconnect/requests/${requestId}`, { headers: { authorization: `Bearer ${"o".repeat(43)}`, "x-openagi-node-id": "other-node" } });
  assert.equal(other.status, 403);
  const ownerCannotApproveList = await fetch(`${url}/nodes/reconnect/requests`, { headers: { authorization: "Bearer main-owner" } });
  assert.equal(ownerCannotApproveList.status, 403);
  const acknowledged = await fetch(`${url}/nodes/reconnect/requests/${requestId}/ack`, { method: "POST", headers: nodeAuth, body: "{}" });
  assert.equal(acknowledged.status, 200);
  assert.equal((await (await fetch(`${url}/nodes/reconnect/requests/${requestId}`, { headers: nodeAuth })).json()).ownerProxyToken, undefined);
});
