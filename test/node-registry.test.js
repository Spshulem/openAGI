// test/node-registry.test.js
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NodeRegistry,
  readOrCreateIdentity,
  ONLINE_WINDOW_MS,
  PRUNE_AFTER_MS
} from "../src/node-registry.js";

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("readOrCreateIdentity creates once and is stable across calls", () => {
  const dataDir = tmpDir("openagi-identity-");
  const first = readOrCreateIdentity(dataDir);
  assert.ok(first.nodeId, "nodeId is generated");
  assert.ok(first.name, "name defaults to something non-empty");
  const second = readOrCreateIdentity(dataDir);
  assert.deepEqual(second, first, "second call returns the same identity, not a new one");
});

test("NodeRegistry.upsert inserts a new entry with firstSeenAt and lastSeenAt equal", () => {
  const dir = tmpDir("openagi-nodereg-");
  const registry = new NodeRegistry({ dir });
  const now = Date.now();
  registry.upsert({ nodeId: "n1", name: "Mac mini", role: "node", url: "http://100.1.2.3:43210", version: "0.0.10" }, { now });
  const [entry] = registry.list({ now });
  assert.equal(entry.nodeId, "n1");
  assert.equal(entry.name, "Mac mini");
  assert.equal(entry.firstSeenAt, entry.lastSeenAt);
  assert.equal(entry.status, "online");
});

test("NodeRegistry.upsert updates an existing entry's lastSeenAt and fields without changing firstSeenAt", () => {
  const dir = tmpDir("openagi-nodereg-");
  const registry = new NodeRegistry({ dir });
  const t0 = Date.now();
  registry.upsert({ nodeId: "n1", name: "Mac mini", role: "node", url: "http://old", version: "0.0.9" }, { now: t0 });
  const t1 = t0 + 5000;
  registry.upsert({ nodeId: "n1", name: "Mac mini", role: "node", url: "http://new", version: "0.0.10" }, { now: t1 });
  const [entry] = registry.list({ now: t1 });
  assert.equal(entry.firstSeenAt, new Date(t0).toISOString());
  assert.equal(entry.lastSeenAt, new Date(t1).toISOString());
  assert.equal(entry.url, "http://new");
  assert.equal(entry.version, "0.0.10");
});

test("NodeRegistry.list marks an entry offline once ONLINE_WINDOW_MS has elapsed since lastSeenAt", () => {
  const dir = tmpDir("openagi-nodereg-");
  const registry = new NodeRegistry({ dir });
  const t0 = Date.now();
  registry.upsert({ nodeId: "n1", name: "Mac mini", role: "node", url: "http://x", version: "0.0.10" }, { now: t0 });
  const stillOnline = registry.list({ now: t0 + ONLINE_WINDOW_MS })[0];
  assert.equal(stillOnline.status, "online", "exactly at the window boundary is still online");
  const offline = registry.list({ now: t0 + ONLINE_WINDOW_MS + 1 })[0];
  assert.equal(offline.status, "offline");
});

test("NodeRegistry.list sorts entries by name", () => {
  const dir = tmpDir("openagi-nodereg-");
  const registry = new NodeRegistry({ dir });
  const now = Date.now();
  registry.upsert({ nodeId: "n2", name: "Zeta", role: "node", url: "http://z", version: "1" }, { now });
  registry.upsert({ nodeId: "n1", name: "Alpha", role: "node", url: "http://a", version: "1" }, { now });
  const names = registry.list({ now }).map((e) => e.name);
  assert.deepEqual(names, ["Alpha", "Zeta"]);
});

test("NodeRegistry.prune removes entries not seen in over PRUNE_AFTER_MS, and upsert prunes automatically", () => {
  const dir = tmpDir("openagi-nodereg-");
  const registry = new NodeRegistry({ dir });
  const t0 = Date.now();
  registry.upsert({ nodeId: "stale", name: "Old Node", role: "node", url: "http://old", version: "1" }, { now: t0 });
  const tLater = t0 + PRUNE_AFTER_MS + 1;
  const removed = registry.prune({ now: tLater });
  assert.equal(removed, 1);
  assert.equal(registry.list({ now: tLater }).length, 0);

  // upsert() prunes internally before writing the new entry.
  const registry2 = new NodeRegistry({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "openagi-nodereg-")) });
  registry2.upsert({ nodeId: "stale2", name: "Old", role: "node", url: "http://old", version: "1" }, { now: t0 });
  registry2.upsert({ nodeId: "fresh", name: "New", role: "node", url: "http://new", version: "1" }, { now: tLater });
  const remaining = registry2.list({ now: tLater }).map((e) => e.nodeId);
  assert.deepEqual(remaining, ["fresh"], "the stale entry was pruned by the second upsert, not just the fresh one added");
});

test("liveness pruning preserves the scoped credential a sleeping node needs to return", () => {
  const dir = tmpDir("openagi-nodereg-sleep-");
  const registry = new NodeRegistry({ dir });
  const token = "a".repeat(43);
  const t0 = Date.now();
  registry.enroll("sleeping", token, { now: t0 });
  registry.upsert({ nodeId: "sleeping", name: "Sleeping node", role: "node", version: "1" }, { now: t0 });

  const returnedAt = t0 + PRUNE_AFTER_MS + 1;
  assert.equal(registry.prune({ now: returnedAt }), 1);
  assert.equal(registry.list({ now: returnedAt }).length, 0);
  assert.equal(registry.authenticate("sleeping", token), true, "staleness is not credential revocation");

  registry.upsert({ nodeId: "sleeping", name: "Sleeping node", role: "node", version: "1" }, { now: returnedAt });
  assert.equal(registry.authenticate("sleeping", token), true);
  assert.equal(registry.list({ now: returnedAt }).length, 1);
});

test("NodeRegistry persists across instances (file-backed)", () => {
  const dir = tmpDir("openagi-nodereg-");
  const now = Date.now();
  new NodeRegistry({ dir }).upsert({ nodeId: "n1", name: "Mac mini", role: "node", url: "http://x", version: "0.0.10" }, { now });
  const reopened = new NodeRegistry({ dir });
  assert.equal(reopened.list({ now }).length, 1);
});
