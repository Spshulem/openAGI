// test/heartbeat-identity.test.js
//
// POST /nodes/heartbeat must treat an enrolled node's registry identity
// (name, platform, capabilities) as authoritative over whatever the body
// claims, for EVERY enrolled platform -- not just the Even G2. A node
// enrolled through the bare /nodes/enroll pairing flow (no platform on
// file) has no such registry identity, so it keeps falling back to the
// body's own values, exactly as it always has.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { NodeRegistry } from "../src/node-registry.js";
import { EVEN_G2_PLATFORM } from "../src/integrations/g2-channel.js";
import { MOBILE_PLATFORM } from "../src/mobile-node.js";

async function bootApp(dataDir) {
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1", port: 0, tickerMs: 0, dataDir, authToken: null
  });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  // A second, read-only-in-practice NodeRegistry over the same on-disk store,
  // so tests can inspect exactly what got persisted without going back
  // through GET /nodes (which reshapes/sorts the roster for display).
  const nodeRegistry = new NodeRegistry({ dir: path.join(dataDir, "nodes") });
  return { app, base, nodeRegistry };
}

async function pairPlatform(base, platform, { name } = {}) {
  const issued = await fetch(`${base}/nodes/enrollment-code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform })
  });
  assert.equal(issued.status, 200);
  const { code } = await issued.json();
  const nodeId = `${platform}:${crypto.randomUUID()}`;
  const nodeToken = crypto.randomBytes(32).toString("base64url");
  const exchanged = await fetch(`${base}/nodes/enroll/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, platform, nodeId, nodeToken, ...(name ? { name } : {}) })
  });
  assert.equal(exchanged.status, 200);
  return { nodeId, nodeToken };
}

const pairMobile = (base, opts) => pairPlatform(base, MOBILE_PLATFORM, opts);
const pairG2 = (base, opts) => pairPlatform(base, EVEN_G2_PLATFORM, opts);

async function enrollGeneric(base, nodeId) {
  const nodeToken = crypto.randomBytes(32).toString("base64url");
  const res = await fetch(`${base}/nodes/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nodeId, nodeToken })
  });
  assert.equal(res.status, 200);
  return { nodeId, nodeToken };
}

function sendHeartbeat(base, { nodeId, nodeToken, headerNodeId } = {}, body) {
  return fetch(`${base}/nodes/heartbeat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${nodeToken}`,
      "x-openagi-node-id": headerNodeId ?? nodeId
    },
    body: JSON.stringify(body)
  });
}

test("an enrolled mobile node heartbeats with no name and the roster gets its enrolled identity", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-hbid-mobile-noname-"));
  const { app, base, nodeRegistry } = await bootApp(dataDir);
  try {
    const { nodeId, nodeToken } = await pairMobile(base, { name: "Sean's iPhone" });
    const expectedCapabilities = nodeRegistry.enrollment(nodeId).capabilities;

    const res = await sendHeartbeat(base, { nodeId, nodeToken }, { nodeId, role: "node" });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(json.capabilities, expectedCapabilities);

    const [entry] = nodeRegistry.list();
    assert.equal(entry.name, "Sean's iPhone");
    assert.equal(entry.platform, MOBILE_PLATFORM);
    assert.deepEqual(entry.capabilities, expectedCapabilities);
  } finally { await app.close(); }
});

test("an enrolled mobile node cannot rename itself or inject capabilities via the heartbeat body", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-hbid-mobile-spoof-"));
  const { app, base, nodeRegistry } = await bootApp(dataDir);
  try {
    const { nodeId, nodeToken } = await pairMobile(base, { name: "Sean's iPhone" });
    const expectedCapabilities = nodeRegistry.enrollment(nodeId).capabilities;

    const res = await sendHeartbeat(base, { nodeId, nodeToken }, {
      nodeId,
      role: "node",
      name: "Someone Else's Phone",
      capabilities: [{ id: "root-shell", ready: true, operations: ["exec"] }]
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.capabilities.some((c) => c.id === "root-shell"), false);
    assert.deepEqual(json.capabilities, expectedCapabilities);

    const [entry] = nodeRegistry.list();
    assert.equal(entry.name, "Sean's iPhone");
    assert.equal(entry.platform, MOBILE_PLATFORM);
    assert.deepEqual(entry.capabilities, expectedCapabilities);
  } finally { await app.close(); }
});

test("an enrolled G2 node's heartbeat is unaffected: registry-sourced name, platform and capabilities, unchanged response shape", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-hbid-g2-"));
  const { app, base, nodeRegistry } = await bootApp(dataDir);
  try {
    const { nodeId, nodeToken } = await pairG2(base, { name: "My Glasses" });
    const res = await sendHeartbeat(base, { nodeId, nodeToken }, {
      nodeId,
      name: "Untrusted rename",
      role: "node",
      capabilities: [{ id: "computer-use", ready: true, operations: ["click"] }]
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(Object.keys(json).sort(), ["capabilities", "ok"]);
    assert.equal(json.ok, true);
    assert.deepEqual(json.capabilities.map((c) => c.id), ["g2-voice-input", "g2-text-display"]);

    const [entry] = nodeRegistry.list();
    assert.equal(entry.name, "My Glasses");
    assert.equal(entry.platform, EVEN_G2_PLATFORM);
    assert.deepEqual(entry.capabilities.map((c) => c.id), ["g2-voice-input", "g2-text-display"]);
  } finally { await app.close(); }
});

test("a plain (platform-less) node's heartbeat still uses body-sourced name, null platform, and sanitized body capabilities", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-hbid-generic-"));
  const { app, base, nodeRegistry } = await bootApp(dataDir);
  try {
    const generic = await enrollGeneric(base, "node-a");
    const res = await sendHeartbeat(base, generic, {
      nodeId: generic.nodeId,
      name: "Mac mini",
      role: "node",
      capabilities: [{ id: "computer-use", ready: true, operations: ["screenshot"] }, "not-an-object"]
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(json.capabilities.map((c) => c.id), ["computer-use"]);

    const [entry] = nodeRegistry.list();
    assert.equal(entry.name, "Mac mini");
    assert.equal(entry.platform, null);
    assert.deepEqual(entry.capabilities.map((c) => c.id), ["computer-use"]);
  } finally { await app.close(); }
});

test("a plain (platform-less) node must still supply a name", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-hbid-generic-noname-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const generic = await enrollGeneric(base, "node-a");
    const res = await sendHeartbeat(base, generic, { nodeId: generic.nodeId, role: "node" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "nodeId and name are required and must be non-empty strings");
  } finally { await app.close(); }
});

test("a heartbeat whose body nodeId does not match the scoped credential still 403s", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-hbid-mismatch-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const generic = await enrollGeneric(base, "node-a");
    const res = await sendHeartbeat(base, generic, { nodeId: "node-b", name: "X", role: "node" });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "nodeId does not match scoped credential");
  } finally { await app.close(); }
});

test("a heartbeat with a missing or wrong role still 400s with the existing message", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-hbid-role-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const generic = await enrollGeneric(base, "node-a");

    const missingRole = await sendHeartbeat(base, generic, { nodeId: generic.nodeId, name: "Node A" });
    assert.equal(missingRole.status, 400);
    assert.equal((await missingRole.json()).error, 'role must be "node"');

    const wrongRole = await sendHeartbeat(base, generic, { nodeId: generic.nodeId, name: "Node A", role: "main" });
    assert.equal(wrongRole.status, 400);
    assert.equal((await wrongRole.json()).error, 'role must be "node"');
  } finally { await app.close(); }
});

test("a name that is present but not a non-empty string still 400s, even for a node already enrolled with a name", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-hbid-badname-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const generic = await enrollGeneric(base, "node-a");
    const emptyName = await sendHeartbeat(base, generic, { nodeId: generic.nodeId, name: "", role: "node" });
    assert.equal(emptyName.status, 400);
    assert.equal((await emptyName.json()).error, "nodeId and name are required and must be non-empty strings");

    const numericName = await sendHeartbeat(base, generic, { nodeId: generic.nodeId, name: 42, role: "node" });
    assert.equal(numericName.status, 400);
    assert.equal((await numericName.json()).error, "nodeId and name are required and must be non-empty strings");

    // The enrollment already has a name on file, so the body could have
    // omitted "name" entirely and succeeded -- but since it sent one, that
    // value still has to pass validation like any other.
    const phone = await pairMobile(base, { name: "Real Phone" });
    const badNameFromEnrolled = await sendHeartbeat(base, phone, { nodeId: phone.nodeId, name: "", role: "node" });
    assert.equal(badNameFromEnrolled.status, 400);
    assert.equal((await badNameFromEnrolled.json()).error, "nodeId and name are required and must be non-empty strings");
  } finally { await app.close(); }
});
