// test/node-routes.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { writeNodeConfig } from "../src/cli-client.js";

// dataDir is passed explicitly everywhere below (to createDurableRuntime AND
// to createHostedInterface's options) rather than via process.env +
// resolveDataDir()'s fallback — resolveDataDir() memoizes its first result
// in a module-level cache, so mutating the env var between a "main" and a
// "node" instance in the same test process would make the second instance
// silently resolve to the first instance's directory.
async function bootApp(dataDir, opts = {}) {
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1", port: 0, tickerMs: 0, dataDir, authToken: opts.authToken ?? null
  });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  return { runtime, app, base };
}

// `nodes` is the whole topology, so a main with nothing paired to it has a
// topology of exactly one machine: itself. (It used to be [] — the roster
// listed only *other* machines, which is why a paired node could never see
// the main it was paired to.)
test("GET /nodes on a standalone/main instance returns a self-entry and a roster of just itself", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-nodes-main-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const res = await fetch(`${base}/nodes`);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.self.role, "main");
    assert.ok(json.self.nodeId);
    assert.equal(json.self.pairedTo, null);
    assert.equal(json.nodes.length, 1);
    assert.equal(json.nodes[0].self, true);
    assert.equal(json.nodes[0].nodeId, json.self.nodeId);
    assert.equal(json.stale, false);
  } finally { await app.close(); }
});

test("POST /nodes/heartbeat upserts the sender, then GET /nodes includes it", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-nodes-main2-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const hb = await fetch(`${base}/nodes/heartbeat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: "n1", name: "Mac mini", role: "node", url: "http://100.1.2.3:43210", version: "0.0.10" })
    });
    assert.equal(hb.status, 200);
    const res = await fetch(`${base}/nodes`);
    const json = await res.json();
    const mini = json.nodes.find((n) => n.name === "Mac mini");
    assert.ok(mini, "the heartbeating node joins the topology");
    assert.equal(mini.status, "online");
    assert.equal(mini.self, false);
  } finally { await app.close(); }
});

test("POST /nodes/heartbeat rejects a malformed body", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-nodes-main3-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const res = await fetch(`${base}/nodes/heartbeat`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "no id or role" })
    });
    assert.equal(res.status, 400);
  } finally { await app.close(); }
});

// Code-review finding: only truthiness was checked, not type — a non-string
// name (e.g. an object) was accepted, persisted, and later crashed
// NodeRegistry.list()'s name.localeCompare sort with a TypeError, taking
// down GET /nodes with a 500 for every caller until the poisoned entry aged
// out after PRUNE_AFTER_MS (30 days).
test("POST /nodes/heartbeat rejects non-string fields instead of persisting a poisoned entry", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-nodes-poison-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const res = await fetch(`${base}/nodes/heartbeat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: "n1", name: { evil: true }, role: "node" })
    });
    assert.equal(res.status, 400);
    // GET /nodes must still work afterward — nothing was persisted.
    const getRes = await fetch(`${base}/nodes`);
    assert.equal(getRes.status, 200);
    const json = await getRes.json();
    assert.deepEqual(json.nodes.filter((n) => !n.self), [], "nothing was persisted — only this machine is listed");
  } finally { await app.close(); }
});

// Code-review finding: role had no allow-list, so any holder of the shared
// pairing token could register itself as a fake "main" in another install's
// roster, displayed with no indication it's unverified. Only the instance
// itself synthesizes its own role:"main" self-entry — nothing should ever
// be able to claim that via a heartbeat.
test("POST /nodes/heartbeat rejects a claimed role other than \"node\"", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-nodes-fakemain-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const res = await fetch(`${base}/nodes/heartbeat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: "n1", name: "Impersonator", role: "main" })
    });
    assert.equal(res.status, 400);
  } finally { await app.close(); }
});

test("GET /nodes on a paired instance proxies to its main and caches the result", async () => {
  const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-nodes-realmain-"));
  const { app: mainApp, base: mainBase } = await bootApp(mainDir);
  // role is "node" — only a node ever heartbeats to a main; a main never
  // claims role "main" via heartbeat (that's synthesized as the self-entry).
  await fetch(`${mainBase}/nodes/heartbeat`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nodeId: "other", name: "Mac mini", role: "node", url: mainBase, version: "0.0.10" })
  });

  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-nodes-selfnode-"));
  writeNodeConfig({ remote: mainBase, token: null }, nodeDir);
  const { app: nodeApp, base: nodeBase } = await bootApp(nodeDir);
  try {
    const res = await fetch(`${nodeBase}/nodes`);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.self.role, "node");
    assert.equal(json.self.pairedTo, mainBase);
    assert.equal(json.stale, false);
    assert.ok(json.nodes.some((n) => n.name === "Mac mini"));
    assert.ok(json.nodes.some((n) => n.role === "main"), "the main it proxied is part of the topology");

    const cached = JSON.parse(fs.readFileSync(path.join(nodeDir, "nodes", "cache.json"), "utf8"));
    assert.ok(cached.cachedAt, "proxy result was cached to disk");
  } finally {
    await nodeApp.close();
    await mainApp.close();
  }
});

// Code-review finding: a successfully-fetched upstream roster was discarded
// (the whole request failed) if the local cache write threw — e.g. a full
// disk — even though the fresh data was already in hand and just needed to
// be returned. Caching must be best-effort, never block a successful response.
test("GET /nodes on a paired instance still returns the fresh roster even if writing the local cache fails", async () => {
  const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-nodes-cachefail-main-"));
  const { app: mainApp, base: mainBase } = await bootApp(mainDir);
  await fetch(`${mainBase}/nodes/heartbeat`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nodeId: "other", name: "Mac mini", role: "node", url: mainBase, version: "0.0.10" })
  });

  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-nodes-cachefail-node-"));
  writeNodeConfig({ remote: mainBase, token: null }, nodeDir);
  // Make cache.json itself a directory (not the "nodes" parent — NodeRegistry
  // shares that same parent dir for its own registry.json and must still be
  // able to construct). writeJsonAtomic's rename-into-place then fails
  // specifically for the cache write, without breaking anything else.
  fs.mkdirSync(path.join(nodeDir, "nodes", "cache.json"), { recursive: true });
  const { app: nodeApp, base: nodeBase } = await bootApp(nodeDir);
  try {
    const res = await fetch(`${nodeBase}/nodes`);
    const json = await res.json();
    assert.equal(res.status, 200, "a cache-write failure must not turn a successful fetch into an error response");
    assert.equal(json.stale, false, "the roster is fresh, not a fallback — the cache write failing doesn't make it stale");
    assert.ok(json.nodes.some((n) => n.name === "Mac mini"));
  } finally {
    await nodeApp.close();
    await mainApp.close();
  }
});

test("GET /nodes on a paired instance falls back to the cache, marked stale, when the main is unreachable", async () => {
  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-nodes-staletest-"));
  writeNodeConfig({ remote: "http://127.0.0.1:1", token: null }, nodeDir); // port 1: nothing listens there
  fs.mkdirSync(path.join(nodeDir, "nodes"), { recursive: true });
  fs.writeFileSync(
    path.join(nodeDir, "nodes", "cache.json"),
    JSON.stringify({ self: { nodeId: "other", name: "Distiller", role: "main", version: "0.0.9", pairedTo: null }, nodes: [{ nodeId: "sib", name: "Mac mini", role: "node", version: "0.0.9", lastSeenAt: new Date(Date.now() - 300000).toISOString(), status: "online" }], cachedAt: new Date(Date.now() - 300000).toISOString() })
  );
  const { app, base } = await bootApp(nodeDir);
  try {
    const res = await fetch(`${base}/nodes`);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.stale, true);
    assert.ok(json.cachedAt);
    assert.equal(json.nodes[0].name, "Distiller", "served from the stale cache, not empty");
    assert.ok(json.nodes.some((n) => n.name === "Mac mini"), "cached siblings are kept too");
  } finally { await app.close(); }
});

test("GET /nodes on a paired instance with no cache yet returns an empty-but-valid shape, not an error", async () => {
  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-nodes-nocache-"));
  writeNodeConfig({ remote: "http://127.0.0.1:1", token: null }, nodeDir);
  const { app, base } = await bootApp(nodeDir);
  try {
    const res = await fetch(`${base}/nodes`);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.stale, true);
    assert.equal(json.cachedAt, null);
    // Never reached, nothing cached — but pairing still tells us a main
    // exists and that this machine is here, so the view is never blank.
    assert.deepEqual(
      json.nodes.map((n) => [n.role, n.status]),
      [["main", "unreachable"], ["node", "online"]]
    );
  } finally { await app.close(); }
});
