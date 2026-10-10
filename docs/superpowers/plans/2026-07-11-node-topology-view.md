# Node Topology View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Nodes" dashboard tab that shows this machine's own role/pairing status plus a live roster of every known node (online/offline, last-seen), backed by a lightweight heartbeat protocol between paired nodes and their main.

**Architecture:** Every paired installation sends a periodic heartbeat to its main; the main keeps a small file-backed registry. `GET /nodes` has dual behavior — a main serves its registry directly, a paired node proxies the request to its main and caches the result so it can still show something if the main is briefly unreachable. The dashboard's new tab follows the exact pattern of the existing Channels tab.

**Tech Stack:** Node.js ESM (no TypeScript), `node --test` + `node:assert`, plain `fetch` for the proxy call — matches every other module in this repo.

## Global Constraints

- Plain JavaScript ESM only; import paths include the `.js` extension.
- Never mix `??` and `||` without parentheses.
- Test runner is `npm test` (`node --test`); test files live at `test/<name>.test.js`.
- Commit after every green step: conventional-commit style, plain text only, no backticks in commit messages.
- Keep diffs narrow: touch only the lines a task names.
- No new npm dependencies — use `fetch` (global in Node 22) and the existing `file-utils.js` helpers.
- Follow the exact file-backed-store idiom already in this repo (see `src/telegram-pairing.js`): constructor takes `{ dir }`, uses `ensureDir`/`readJsonFile`/`writeJsonAtomic` from `src/file-utils.js`, every method that needs the clock takes an injectable `{ now = Date.now() }` so it's testable as pure logic with no real timers.
- Spec: `docs/superpowers/specs/2026-07-11-node-topology-view-design.md`.

---

### Task 1: Self-identity + Node Registry store

**Files:**
- Create: `src/node-registry.js`
- Test: `test/node-registry.test.js`

**Interfaces:**
- Consumes: `ensureDir(dir)`, `readJsonFile(filePath, fallback)`, `writeJsonAtomic(filePath, value)` from `src/file-utils.js` (exact signatures, already read from the file); `resolveDataDir()` from `src/data-dir.js`.
- Produces (later tasks rely on these exact names/shapes):
  - `export function readOrCreateIdentity(dataDir = resolveDataDir())` → `{ nodeId: string, name: string }`. Persisted at `<dataDir>/identity.json`. `nodeId` is a random id generated once (`crypto.randomUUID()`) and never regenerated once the file exists. `name` defaults to `os.hostname()`.
  - `export const ONLINE_WINDOW_MS = 90_000;` (3× the 30s heartbeat interval Task 3 uses).
  - `export const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;` (30 days).
  - `export class NodeRegistry { constructor({ dir } = {}) }` — `this.dir = dir ?? path.join(resolveDataDir(), "nodes"); this.storePath = path.join(this.dir, "registry.json");`
  - `NodeRegistry.upsert({ nodeId, name, role, url, version }, { now = Date.now() } = {})` → void. Inserts a new entry (`firstSeenAt` = now) or updates an existing one by `nodeId` (`lastSeenAt` = now, all other fields overwritten with the latest values sent).
  - `NodeRegistry.list({ now = Date.now() } = {})` → array of `{ nodeId, name, role, url, version, firstSeenAt, lastSeenAt, status: "online" | "offline" }`, sorted by `name`. `status` is `"online"` iff `now - lastSeenAt <= ONLINE_WINDOW_MS`.
  - `NodeRegistry.prune({ now = Date.now() } = {})` → number of entries removed. Removes any entry whose `lastSeenAt` is older than `PRUNE_AFTER_MS`; called internally at the top of `upsert()` (so the store self-cleans on every write, no separate cron job needed).

- [ ] **Step 1: Write the failing test file.** Create `test/node-registry.test.js` with exactly this content:

```js
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

test("NodeRegistry persists across instances (file-backed)", () => {
  const dir = tmpDir("openagi-nodereg-");
  const now = Date.now();
  new NodeRegistry({ dir }).upsert({ nodeId: "n1", name: "Mac mini", role: "node", url: "http://x", version: "0.0.10" }, { now });
  const reopened = new NodeRegistry({ dir });
  assert.equal(reopened.list({ now }).length, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `node --test test/node-registry.test.js`
Expected: fails to even start — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/node-registry.js'`

- [ ] **Step 3: Write the implementation.** Create `/Users/you/Dev/openAGI/src/node-registry.js` with exactly this content:

```js
// src/node-registry.js
// Two small pieces: (1) every installation's own stable identity, generated
// once and persisted regardless of whether it's paired to anything; (2) a
// file-backed registry of *other* nodes, kept by whichever installation is
// acting as a main (i.e. has received at least one heartbeat). A node counts
// "online" if its last heartbeat arrived within ONLINE_WINDOW_MS (3x the 30s
// send interval used by the heartbeat sender in node-heartbeat-sender.js) —
// missing up to 2 heartbeats in a row doesn't flip it offline, only 3+.
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";

export const ONLINE_WINDOW_MS = 90_000;
export const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export function readOrCreateIdentity(dataDir = resolveDataDir()) {
  const filePath = path.join(dataDir, "identity.json");
  const existing = readJsonFile(filePath, null);
  if (existing?.nodeId) return existing;
  const identity = { nodeId: crypto.randomUUID(), name: os.hostname() || "openagi" };
  writeJsonAtomic(filePath, identity);
  return identity;
}

export class NodeRegistry {
  constructor({ dir } = {}) {
    this.dir = dir ?? path.join(resolveDataDir(), "nodes");
    ensureDir(this.dir);
    this.storePath = path.join(this.dir, "registry.json");
  }

  upsert({ nodeId, name, role, url, version }, { now = Date.now() } = {}) {
    this.prune({ now });
    const store = this._read();
    const existing = store.entries[nodeId];
    store.entries[nodeId] = {
      nodeId,
      name,
      role,
      url,
      version,
      firstSeenAt: existing?.firstSeenAt ?? new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString()
    };
    writeJsonAtomic(this.storePath, store);
  }

  list({ now = Date.now() } = {}) {
    const store = this._read();
    return Object.values(store.entries)
      .map((entry) => ({
        ...entry,
        status: (now - new Date(entry.lastSeenAt).getTime()) <= ONLINE_WINDOW_MS ? "online" : "offline"
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  prune({ now = Date.now() } = {}) {
    const store = this._read();
    let removed = 0;
    for (const [nodeId, entry] of Object.entries(store.entries)) {
      if ((now - new Date(entry.lastSeenAt).getTime()) > PRUNE_AFTER_MS) {
        delete store.entries[nodeId];
        removed += 1;
      }
    }
    if (removed > 0) writeJsonAtomic(this.storePath, store);
    return removed;
  }

  _read() {
    return readJsonFile(this.storePath, { version: 1, entries: {} });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass.**

Run: `node --test test/node-registry.test.js`
Expected: `# tests 7`, `# pass 7`, `# fail 0`

- [ ] **Step 5: Run the full suite to confirm no regressions.**

Run: `npm test`
Expected: all pre-existing tests still pass (baseline was 469 passing before this task; this task adds 7 more).

- [ ] **Step 6: Commit.**

```bash
git add src/node-registry.js test/node-registry.test.js
git commit -m "feat(nodes): self-identity + file-backed node registry with online/offline status"
```

---

### Task 2: `GET /nodes` and `POST /nodes/heartbeat` routes

**Files:**
- Modify: `src/hosted-interface.js:1-16` (imports), `:18-33` (construction block), `:288-302` (route block, add after the `/channels` handler)
- Test: `test/node-routes.test.js`

**Interfaces:**
- Consumes: `NodeRegistry`, `readOrCreateIdentity` from `src/node-registry.js` (Task 1); `readNodeConfig` from `src/cli-client.js` (already exists — reads `<dataDir>/node.json` → `{ remote, token } | null`); `resolveDataDir` from `src/data-dir.js`; `readJsonFile`, `writeJsonAtomic` from `src/file-utils.js`; the existing `sendJson(res, status, body)` helper already defined in `hosted-interface.js` (used by every other route — do not redefine it).
- Produces:
  - `GET /nodes` → `200 { self: { nodeId, name, role: "main"|"node", version, pairedTo: string|null }, nodes: [...], stale: boolean, cachedAt: string|null }`.
  - `POST /nodes/heartbeat` → `200 { ok: true }` on a well-formed body, `400 { error: "..." }` if `nodeId`, `name`, or `role` is missing.
  - Both routes require auth exactly like every other non-public route (they are NOT added to `isPublicRoute` in `src/auth.js` — the pairing token already required for the CLI's own remote calls is what authenticates a heartbeat).

- [ ] **Step 1: Write the failing test file.** Create `/Users/you/Dev/openAGI/test/node-routes.test.js` with exactly this content:

```js
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

test("GET /nodes on a standalone/main instance returns a self-entry and an empty roster", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-nodes-main-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const res = await fetch(`${base}/nodes`);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.self.role, "main");
    assert.ok(json.self.nodeId);
    assert.equal(json.self.pairedTo, null);
    assert.deepEqual(json.nodes, []);
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
    assert.equal(json.nodes.length, 1);
    assert.equal(json.nodes[0].name, "Mac mini");
    assert.equal(json.nodes[0].status, "online");
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

test("GET /nodes on a paired instance proxies to its main and caches the result", async () => {
  const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-nodes-realmain-"));
  const { app: mainApp, base: mainBase } = await bootApp(mainDir);
  await fetch(`${mainBase}/nodes/heartbeat`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nodeId: "other", name: "Distiller", role: "main", url: mainBase, version: "0.0.10" })
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
    assert.equal(json.nodes.length, 1);
    assert.equal(json.nodes[0].name, "Distiller");

    const cached = JSON.parse(fs.readFileSync(path.join(nodeDir, "nodes", "cache.json"), "utf8"));
    assert.ok(cached.cachedAt, "proxy result was cached to disk");
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
    JSON.stringify({ self: { nodeId: "x", name: "y", role: "node", version: "0.0.9", pairedTo: "http://127.0.0.1:1" }, nodes: [{ nodeId: "other", name: "Distiller", role: "main", status: "online" }], cachedAt: new Date(Date.now() - 300000).toISOString() })
  );
  const { app, base } = await bootApp(nodeDir);
  try {
    const res = await fetch(`${base}/nodes`);
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.stale, true);
    assert.ok(json.cachedAt);
    assert.equal(json.nodes[0].name, "Distiller", "served from the stale cache, not empty");
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
    assert.deepEqual(json.nodes, []);
  } finally { await app.close(); }
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `node --test test/node-routes.test.js`
Expected: every test fails with a 404 (`assert.equal(res.status, 200)` gets `404`) since neither route exists yet.

- [ ] **Step 3: Add the imports.** In `/Users/you/Dev/openAGI/src/hosted-interface.js`, find this exact block near the top of the file:

```js
import { ChannelManager } from "./channels.js";
import { inferToneScore } from "./outcome-store.js";
import { isFirstRun, renderWizard, saveEnv } from "./setup-wizard.js";
```

Replace it with:

```js
import { ChannelManager } from "./channels.js";
import { inferToneScore } from "./outcome-store.js";
import { isFirstRun, renderWizard, saveEnv } from "./setup-wizard.js";
import { NodeRegistry, readOrCreateIdentity } from "./node-registry.js";
import { readNodeConfig } from "./cli-client.js";
```

- [ ] **Step 4: Construct the registry.** Find this exact block (right after the `channels` construction):

```js
  let channels =
    options.channels ??
    (runtime.agentHost
      ? new ChannelManager({
          agentHost: runtime.agentHost,
          runtime,
          dir: options.channelsDir,
          telegramToken: options.telegramToken
        })
      : null);
```

Replace it with:

```js
  let channels =
    options.channels ??
    (runtime.agentHost
      ? new ChannelManager({
          agentHost: runtime.agentHost,
          runtime,
          dir: options.channelsDir,
          telegramToken: options.telegramToken
        })
      : null);

  // dataDir is resolved ONCE here and threaded explicitly into both
  // NodeRegistry's dir and the cache path below — NodeRegistry must NOT be
  // allowed to fall back to its own default (which calls resolveDataDir()
  // independently), because resolveDataDir() memoizes its first result for
  // the whole process; two hosted-interface instances in the same test
  // process (a main + a node) would otherwise silently collide on the same
  // directory the first one resolved.
  const dataDir = options.dataDir ?? resolveDataDir();
  const nodeRegistry = options.nodeRegistry ?? new NodeRegistry({ dir: options.nodesDir ?? path.join(dataDir, "nodes") });
  const nodesCachePath = path.join(dataDir, "nodes", "cache.json");
```

- [ ] **Step 5: Add the two routes.** Find this exact block:

```js
      if (method === "GET" && pathname === "/channels") {
```

Insert the following two route handlers immediately BEFORE that line (same indentation level as the surrounding `if` blocks in that function):

```js
      if (method === "POST" && pathname === "/nodes/heartbeat") {
        const body = await readJson(req).catch(() => ({}));
        if (!body.nodeId || !body.name || !body.role) {
          return sendJson(res, 400, { error: "nodeId, name, and role are required" });
        }
        nodeRegistry.upsert({
          nodeId: body.nodeId, name: body.name, role: body.role,
          url: body.url ?? null, version: body.version ?? null
        });
        return sendJson(res, 200, { ok: true });
      }
      if (method === "GET" && pathname === "/nodes") {
        const identity = readOrCreateIdentity(dataDir);
        const pairing = readNodeConfig(dataDir);
        if (!pairing?.remote) {
          return sendJson(res, 200, {
            self: { nodeId: identity.nodeId, name: identity.name, role: "main", version: PACKAGE_VERSION, pairedTo: null },
            nodes: nodeRegistry.list(),
            stale: false,
            cachedAt: null
          });
        }
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 5000);
          let upstream;
          try {
            upstream = await fetch(`${pairing.remote}/nodes`, {
              headers: pairing.token ? { authorization: `Bearer ${pairing.token}` } : {},
              signal: ctrl.signal
            });
          } finally { clearTimeout(timer); }
          if (!upstream.ok) throw new Error(`upstream ${upstream.status}`);
          const upstreamJson = await upstream.json();
          const cached = { ...upstreamJson, cachedAt: new Date().toISOString() };
          writeJsonAtomic(nodesCachePath, cached);
          return sendJson(res, 200, {
            self: { nodeId: identity.nodeId, name: identity.name, role: "node", version: PACKAGE_VERSION, pairedTo: pairing.remote },
            nodes: cached.nodes ?? [],
            stale: false,
            cachedAt: cached.cachedAt
          });
        } catch {
          const cached = readJsonFile(nodesCachePath, null);
          return sendJson(res, 200, {
            self: { nodeId: identity.nodeId, name: identity.name, role: "node", version: PACKAGE_VERSION, pairedTo: pairing.remote },
            nodes: cached?.nodes ?? [],
            stale: true,
            cachedAt: cached?.cachedAt ?? null
          });
        }
      }
      if (method === "GET" && pathname === "/channels") {
```

- [ ] **Step 6: Add the `PACKAGE_VERSION` constant and `writeJsonAtomic`/`readJsonFile` imports.** Find this exact line near the top of the file (the `resolveDataDir` import):

```js
import { resolveDataDir } from "./data-dir.js";
```

Replace it with:

```js
import { resolveDataDir } from "./data-dir.js";
import { readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { createRequire } from "node:module";

const PACKAGE_VERSION = createRequire(import.meta.url)("../package.json").version;
```

- [ ] **Step 7: Run the tests to verify they pass.**

Run: `node --test test/node-routes.test.js`
Expected: `# tests 6`, `# pass 6`, `# fail 0`

- [ ] **Step 8: Run the full suite to confirm no regressions.**

Run: `npm test`
Expected: all prior tests plus these 6 pass; 0 failures.

- [ ] **Step 9: Commit.**

```bash
git add src/hosted-interface.js test/node-routes.test.js
git commit -m "feat(nodes): GET /nodes and POST /nodes/heartbeat - main serves directly, node proxies+caches"
```

---

### Task 3: Heartbeat sender

**Files:**
- Modify: `src/hosted-interface.js:listen()` (add the interval), `close()` (add cleanup)
- Test: `test/node-heartbeat-sender.test.js`

**Interfaces:**
- Consumes: `readNodeConfig(dataDir)` from `src/cli-client.js`; `readOrCreateIdentity(dataDir)` from `src/node-registry.js` (both already wired in Task 2); global `fetch`.
- Produces: `options.heartbeatIntervalMs` (test seam, default `30_000`) and `options.getPublicUrl` are consumed inside the interval callback. No new exported function — this is an internal interval inside `createHostedInterface`, matching the existing ticker's shape exactly so there's one clear place that owns "background timers this server runs."

- [ ] **Step 1: Write the failing test file.** Create `/Users/you/Dev/openAGI/test/node-heartbeat-sender.test.js` with exactly this content:

```js
// test/node-heartbeat-sender.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { writeNodeConfig } from "../src/cli-client.js";

test("a paired instance sends a heartbeat shortly after boot, and the main's registry reflects it", async () => {
  // dataDir is passed explicitly to both createDurableRuntime and
  // createHostedInterface's options (not via process.env.OPENAGI_DATA_DIR) —
  // resolveDataDir() memoizes its first result for the whole test process,
  // so switching the env var between the main and node instances here would
  // make the second instance silently resolve to the first one's directory.
  const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-hb-main-"));
  const mainRuntime = createDurableRuntime({ dataDir: mainDir });
  const mainApp = createHostedInterface(mainRuntime, { host: "127.0.0.1", port: 0, tickerMs: 0, dataDir: mainDir });
  const mainListened = await mainApp.listen();
  const mainBase = mainListened.url;

  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-hb-node-"));
  writeNodeConfig({ remote: mainBase, token: null }, nodeDir);
  const nodeRuntime = createDurableRuntime({ dataDir: nodeDir });
  const nodeApp = createHostedInterface(nodeRuntime, {
    host: "127.0.0.1", port: 0, tickerMs: 0, dataDir: nodeDir, heartbeatIntervalMs: 20
  });
  await nodeApp.listen();

  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const res = await fetch(`${mainBase}/nodes`);
    const json = await res.json();
    assert.equal(json.nodes.length, 1, "the node's heartbeat reached the main");
    assert.equal(json.nodes[0].status, "online");
  } finally {
    await nodeApp.close();
    await mainApp.close();
  }
});

test("a failed heartbeat POST does not crash the sender or the process", async () => {
  const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-hb-fail-"));
  writeNodeConfig({ remote: "http://127.0.0.1:1", token: null }, nodeDir); // nothing listens on port 1
  const runtime = createDurableRuntime({ dataDir: nodeDir });
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1", port: 0, tickerMs: 0, dataDir: nodeDir, heartbeatIntervalMs: 20
  });
  await app.listen();
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    // If the sender threw, this line is never reached — the process test
    // runner would report an uncaught exception for this file.
    assert.ok(true, "still running after a failed heartbeat attempt");
  } finally { await app.close(); }
});

test("an unpaired instance never starts the heartbeat sender", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-hb-unpaired-"));
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, tickerMs: 0, dataDir, heartbeatIntervalMs: 20 });
  await app.listen();
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(app.__heartbeatHandle, undefined, "no heartbeat interval was created for an unpaired instance");
  } finally { await app.close(); }
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `node --test test/node-heartbeat-sender.test.js`
Expected: first test fails — `json.nodes.length` is `0`, not `1` (no heartbeat sender exists yet).

- [ ] **Step 3: Add the interval.** Find this exact block in `listen()`:

```js
    listen() {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          channels?.start();
          if (tickerMs > 0) {
            tickerHandle = setInterval(() => {
              runtime.tick().catch(() => { /* swallow */ });
              try {
                runtime.outcomes?.resolveSweep({ agentStore: runtime.agentHost?.store ?? null });
              } catch { /* swallow */ }
            }, tickerMs);
          }
          const address = server.address();
          const actualPort = typeof address === "object" && address ? address.port : port;
          resolve({ host, port: actualPort, url: `http://${host}:${actualPort}` });
        });
      });
    },
```

Replace it with:

```js
    listen() {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          channels?.start();
          if (tickerMs > 0) {
            tickerHandle = setInterval(() => {
              runtime.tick().catch(() => { /* swallow */ });
              try {
                runtime.outcomes?.resolveSweep({ agentStore: runtime.agentHost?.store ?? null });
              } catch { /* swallow */ }
            }, tickerMs);
          }
          const pairing = readNodeConfig(dataDir);
          if (pairing?.remote) {
            const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
            let heartbeatFailStreak = 0;
            const sendHeartbeat = async () => {
              try {
                const identity = readOrCreateIdentity(dataDir);
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 5000);
                try {
                  const res = await fetch(`${pairing.remote}/nodes/heartbeat`, {
                    method: "POST",
                    headers: {
                      "content-type": "application/json",
                      ...(pairing.token ? { authorization: `Bearer ${pairing.token}` } : {})
                    },
                    body: JSON.stringify({
                      nodeId: identity.nodeId, name: identity.name, role: "node",
                      url: options.publicUrl ?? process.env.OPENAGI_PUBLIC_URL ?? null,
                      version: PACKAGE_VERSION
                    }),
                    signal: ctrl.signal
                  });
                  if (!res.ok) throw new Error(`heartbeat rejected: ${res.status}`);
                } finally { clearTimeout(timer); }
                if (heartbeatFailStreak > 0) {
                  console.warn("[openagi] heartbeat to main recovered");
                }
                heartbeatFailStreak = 0;
              } catch (error) {
                heartbeatFailStreak += 1;
                if (heartbeatFailStreak === 1) {
                  console.warn(`[openagi] heartbeat to main failing (${error.message}) - will keep retrying`);
                }
              }
            };
            heartbeatHandle = setInterval(() => { sendHeartbeat().catch(() => {}); }, heartbeatIntervalMs);
            sendHeartbeat().catch(() => {});
          }
          const address = server.address();
          const actualPort = typeof address === "object" && address ? address.port : port;
          resolve({ host, port: actualPort, url: `http://${host}:${actualPort}` });
        });
      });
    },
```

- [ ] **Step 4: Declare `heartbeatHandle` and expose it for the test seam, and clean it up on close.** Find this exact line (near the top of `createHostedInterface`, where `tickerHandle` is declared — search for `let tickerHandle`):

```js
  let tickerHandle = null;
```

Replace it with:

```js
  let tickerHandle = null;
  let heartbeatHandle = null;
```

Then find this exact block in `close()`:

```js
    close() {
      return new Promise((resolve, reject) => {
        if (tickerHandle) clearInterval(tickerHandle);
```

Replace it with:

```js
    close() {
      return new Promise((resolve, reject) => {
        if (tickerHandle) clearInterval(tickerHandle);
        if (heartbeatHandle) clearInterval(heartbeatHandle);
```

Finally, find the object literal returned by `createHostedInterface` (search for `__setChannels(c) { channels = c; },`) and add a getter right after it so the test can observe whether the interval was created:

```js
    __setChannels(c) { channels = c; },
```

Replace it with:

```js
    __setChannels(c) { channels = c; },
    get __heartbeatHandle() { return heartbeatHandle ?? undefined; },
```

- [ ] **Step 5: Run the tests to verify they pass.**

Run: `node --test test/node-heartbeat-sender.test.js`
Expected: `# tests 3`, `# pass 3`, `# fail 0`

- [ ] **Step 6: Run the full suite to confirm no regressions.**

Run: `npm test`
Expected: all prior tests plus these 3 pass; 0 failures.

- [ ] **Step 7: Commit.**

```bash
git add src/hosted-interface.js test/node-heartbeat-sender.test.js
git commit -m "feat(nodes): periodic heartbeat sender for paired installations"
```

---

### Task 4: Dashboard "Nodes" tab

**Files:**
- Modify: `src/hosted-interface.js` (nav button, `VALID_TABS`, `switchTab`, new `renderNodes` function)

**Interfaces:**
- Consumes: `GET /nodes` (Task 2's exact response shape); the existing client-side `fetchJson(path)` helper (already defined, do not redefine); the existing `escapeHtml` helper used by every other render function (grep confirms it exists — reuse it, do not reimplement).
- Produces: `async function renderNodes()`, following the exact structural pattern of `renderChannels()` (a `main.innerHTML = \`...\`` template).

- [ ] **Step 1: Add the nav button.** Find this exact line:

```html
            <button data-tab="agents" title="Specialists the propagation controller has spawned for repeated tasks.">Agents</button>
```

Replace it with:

```html
            <button data-tab="agents" title="Specialists the propagation controller has spawned for repeated tasks.">Agents</button>
            <button data-tab="nodes" title="Which machines are paired, which one is main, and who's online right now.">Nodes</button>
```

- [ ] **Step 2: Add "nodes" to `VALID_TABS`.** Find this exact line:

```js
const VALID_TABS = new Set(["chat","tasks","memory","cron","skills","mcp","integrations","agents","channels","budget","outcomes","scrutiny","health","activity","suggestions","computer-use","today"]);
```

Replace it with:

```js
const VALID_TABS = new Set(["chat","tasks","memory","cron","skills","mcp","integrations","agents","nodes","channels","budget","outcomes","scrutiny","health","activity","suggestions","computer-use","today"]);
```

- [ ] **Step 3: Add the `switchTab` branch.** Find this exact block:

```js
  } else if (tab === "channels") {
    showSidebar(false);
    await renderChannels();
```

Replace it with:

```js
  } else if (tab === "nodes") {
    showSidebar(false);
    await renderNodes();
  } else if (tab === "channels") {
    showSidebar(false);
    await renderChannels();
```

- [ ] **Step 4: Write `renderNodes`.** Find this exact function (`renderChannels`, so the new function lands right next to the one it mirrors):

```js
async function renderChannels() {
```

Insert the following function immediately BEFORE that line:

```js
async function renderNodes() {
  const data = await fetchJson("/nodes");
  const roleLabel = data.self.role === "main" ? "Main" : "Node";
  const pairedLine = data.self.role === "node"
    ? `<div class="desc">Paired to: <code>${escapeHtml(data.self.pairedTo)}</code></div>`
    : `<div class="desc">This machine is a main — other nodes heartbeat to it.</div>`;
  const staleBanner = data.stale
    ? `<div class="card" style="border-color:var(--warn,#c8963e);"><div class="name warn">Showing cached topology${data.cachedAt ? ` as of ${escapeHtml(new Date(data.cachedAt).toLocaleTimeString())}` : ""}</div><div class="desc">Could not reach the main just now — this is the last known roster.</div></div>`
    : "";
  const rows = data.nodes.length > 0
    ? data.nodes.map((n) => `
        <tr>
          <td>${escapeHtml(n.name)}</td>
          <td>${escapeHtml(n.role)}</td>
          <td><span class="${n.status === "online" ? "name" : "name warn"}">${n.status}</span></td>
          <td>${escapeHtml(new Date(n.lastSeenAt).toLocaleString())}</td>
          <td>${escapeHtml(n.version ?? "")}</td>
        </tr>`).join("")
    : `<tr><td colspan="5" class="desc">No other nodes have checked in yet.</td></tr>`;
  main.innerHTML = `
    <div class="pane">
      <h2>Nodes</h2>
      <div class="card">
        <div class="name">${escapeHtml(data.self.name)} (this machine) — ${roleLabel}</div>
        ${pairedLine}
        <div class="desc">Version: ${escapeHtml(data.self.version ?? "unknown")}</div>
      </div>
      ${staleBanner}
      <table class="grid" style="margin-top:12px; width:100%;">
        <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Last seen</th><th>Version</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}
```

- [ ] **Step 5: Run the full suite to confirm no regressions.** (There is no dedicated browser-JS test harness in this repo for render functions — `renderChannels` itself has none either, so `renderNodes` matches existing convention. Verification here is the full backend suite plus the manual check in Step 6.)

Run: `npm test`
Expected: all tests pass, same count as after Task 3 (this task adds no new `.test.js` file).

- [ ] **Step 6: Manual verification.** Start the daemon locally (`node examples/hosted-server.js` or however this repo's dev server is normally started — check `package.json`'s `scripts` for the exact command), open the dashboard in a browser, click "Nodes" in the nav, and confirm: the self-card shows this machine's name/role, the table renders (empty state if unpaired with nothing checked in), and no console errors appear. If this machine is paired via `node.json` to a running main, confirm the roster populates and matches what `curl <main>/nodes` returns directly.

- [ ] **Step 7: Commit.**

```bash
git add src/hosted-interface.js
git commit -m "feat(nodes): Nodes dashboard tab - self status + node roster"
```

---

## Post-implementation (not a task — do this after all 4 tasks are committed)

Per the design's out-of-scope note, this plan does not touch the Mac app's Swift code or the `daemonBaseURL` capture-destination gap — those remain separate, already-known follow-ups. Once all 4 tasks are green:
1. Push to `main`.
2. Pull + restart on the Distiller (`git pull --ff-only`, then the service restart procedure already established: `systemctl --user restart openagi.service`), verify `GET /nodes` there directly.
3. Update this Mac's own local install the same way, verify the Nodes tab in the browser dashboard shows the Distiller as a paired node (or vice versa, depending on which is main), each showing the other's status as online.
