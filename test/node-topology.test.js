// test/node-topology.test.js
//
// Regression tests for the three defects the user hit on a real paired Mac
// whose main (the Distiller) had been down for two weeks:
//
//   1. GET /nodes replayed the *cached* liveness verdict, so a node last seen
//      on Jul 19 was still reported "online" on Aug 3. Liveness must be
//      recomputed from lastSeenAt at read time, never served from a cache.
//   2. The roster contained only the Mac itself. A node's Nodes view must show
//      the whole topology — the main it is paired to, plus every sibling —
//      and the main's identity was already sitting unused in `cache.self`.
//   3. Every install reported version "0.0.6" because that is what
//      package.json says, while the released tags are at v0.0.10. The view
//      cannot answer "is this node up to date" without a real build identity.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { writeNodeConfig } from "../src/cli-client.js";
import { compareVersions, newestOf, resolveBuildInfo, statusFor, ONLINE_WINDOW_MS } from "../src/node-registry.js";

async function bootApp(dataDir, opts = {}) {
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1", port: 0, tickerMs: 0, dataDir, authToken: opts.authToken ?? null
  });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  return { runtime, app, base };
}

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeCache(dataDir, cache) {
  fs.mkdirSync(path.join(dataDir, "nodes"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "nodes", "cache.json"), JSON.stringify(cache));
}

// A faithful copy of the cache found on the user's Mac: a roster captured on
// Jul 19 in which every listed machine was, at that moment, genuinely online.
// A third machine is added so the "this machine is obviously up" case and the
// "some other machine went dark" case are both covered.
const TWO_WEEKS_AGO = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
const MAC_ID = "mac-1388";
function usersRealCache() {
  return {
    self: { nodeId: "main-6a46", name: "distiller-a270", role: "main", version: "0.0.6", pairedTo: null },
    nodes: [
      {
        nodeId: MAC_ID, name: "Spencers-MacBook-Pro-3.local", role: "node", url: null,
        version: "0.0.6", firstSeenAt: TWO_WEEKS_AGO, lastSeenAt: TWO_WEEKS_AGO, status: "online"
      },
      {
        nodeId: "pi-0002", name: "Old Pi", role: "node", url: null,
        version: "0.0.6", firstSeenAt: TWO_WEEKS_AGO, lastSeenAt: TWO_WEEKS_AGO, status: "online"
      }
    ],
    stale: false,
    cachedAt: TWO_WEEKS_AGO
  };
}

// Pin this install's identity so it matches the cached roster entry for the
// Mac — that is the real situation, and it is what lets the roster recognise
// one of its own rows as "this machine" instead of listing it twice.
function writeIdentity(dataDir, identity) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "identity.json"), JSON.stringify(identity));
}

// ---------------------------------------------------------------------------
// Bug 1 — a cached liveness verdict must never be replayed
// ---------------------------------------------------------------------------

test("GET /nodes never replays a cached \"online\" verdict for a node last seen two weeks ago", async () => {
  const dataDir = tmp("openagi-topo-staleonline-");
  writeNodeConfig({ remote: "http://127.0.0.1:1", token: null }, dataDir); // nothing listens on port 1
  writeIdentity(dataDir, { nodeId: MAC_ID, name: "Spencers-MacBook-Pro-3.local" });
  writeCache(dataDir, usersRealCache());
  const { app, base } = await bootApp(dataDir);
  try {
    const json = await (await fetch(`${base}/nodes`)).json();
    const pi = json.nodes.find((n) => n.name === "Old Pi");
    assert.ok(pi, "the sibling node is still listed from cache");
    assert.notEqual(pi.status, "online", "a heartbeat from 14 days ago is not evidence of being online now");
    assert.equal(pi.status, "offline");
    assert.equal(pi.statusAsOf, TWO_WEEKS_AGO, "the row is dated so the UI can say how old it is");
    assert.equal(pi.statusBasis, "cached", "this verdict is recalled, not measured");
    assert.equal(json.stale, true);

    // This machine is the exception: it is answering the request, so it is
    // online on direct evidence — and it must appear once, not twice.
    const macs = json.nodes.filter((n) => n.name === "Spencers-MacBook-Pro-3.local");
    assert.equal(macs.length, 1, "the cached row for this machine and the live self row are the same machine");
    assert.equal(macs[0].self, true);
    assert.equal(macs[0].status, "online");
  } finally { await app.close(); }
});

test("GET /nodes recomputes status even on a FRESH proxy, rather than trusting the upstream verdict", async () => {
  // A compromised or buggy main could assert status:"online" for an entry it
  // last heard from a month ago. We hold the timestamp; we do the arithmetic.
  const mainDir = tmp("openagi-topo-lyingmain-");
  const { app: mainApp, base: mainBase } = await bootApp(mainDir);
  // Backdate the sibling's heartbeat directly in the registry so the roster
  // carries an old lastSeenAt.
  await fetch(`${mainBase}/nodes/heartbeat`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nodeId: "old", name: "Ancient", role: "node", version: "0.0.6" })
  });
  const registryPath = path.join(mainDir, "nodes", "registry.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  registry.entries.old.lastSeenAt = TWO_WEEKS_AGO;
  fs.writeFileSync(registryPath, JSON.stringify(registry));

  const nodeDir = tmp("openagi-topo-lyingmain-node-");
  writeNodeConfig({ remote: mainBase, token: null }, nodeDir);
  const { app: nodeApp, base: nodeBase } = await bootApp(nodeDir);
  try {
    const json = await (await fetch(`${nodeBase}/nodes`)).json();
    assert.equal(json.stale, false, "the main answered, so this is a live roster");
    const ancient = json.nodes.find((n) => n.name === "Ancient");
    assert.ok(ancient);
    assert.equal(ancient.status, "offline", "status comes from lastSeenAt, not from whatever the main claimed");
  } finally { await nodeApp.close(); await mainApp.close(); }
});

// ---------------------------------------------------------------------------
// Bug 2 — the roster must be the whole topology, main included
// ---------------------------------------------------------------------------

test("GET /nodes on a paired node lists the main it is paired to, even from a stale cache", async () => {
  const dataDir = tmp("openagi-topo-mainfromcache-");
  writeNodeConfig({ remote: "http://127.0.0.1:1", token: null }, dataDir);
  writeCache(dataDir, usersRealCache());
  const { app, base } = await bootApp(dataDir);
  try {
    const json = await (await fetch(`${base}/nodes`)).json();
    const main = json.nodes.find((n) => n.role === "main");
    assert.ok(main, "the main must appear in the roster — its identity is in cache.self");
    assert.equal(main.name, "distiller-a270");
    assert.equal(main.status, "unreachable", "we just tried to reach it and failed — say so, don't say offline/online");
    // "unreachable" was measured a moment ago, unlike the rows around it, so
    // the UI must not date it as though it were recalled from the cache.
    assert.equal(main.statusBasis, "measured");
    assert.ok(json.unreachableReason, "the view must be able to explain why it is showing cached data");
  } finally { await app.close(); }
});

test("GET /nodes on a paired node lists the main even when there is no cache at all", async () => {
  const dataDir = tmp("openagi-topo-mainnocache-");
  writeNodeConfig({ remote: "http://127.0.0.1:1", token: null }, dataDir);
  const { app, base } = await bootApp(dataDir);
  try {
    const json = await (await fetch(`${base}/nodes`)).json();
    assert.equal(json.stale, true);
    assert.equal(json.cachedAt, null);
    const main = json.nodes.find((n) => n.role === "main");
    assert.ok(main, "we know the main's URL from pairing even if we've never reached it");
    assert.equal(main.status, "unreachable");
    assert.equal(main.url, "http://127.0.0.1:1");
    assert.ok(json.nodes.some((n) => n.self === true), "this machine is always in its own topology");
  } finally { await app.close(); }
});

test("GET /nodes on a paired node with a reachable main returns the full topology: main + sibling + self", async () => {
  const mainDir = tmp("openagi-topo-full-main-");
  const { app: mainApp, base: mainBase } = await bootApp(mainDir);
  await fetch(`${mainBase}/nodes/heartbeat`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ nodeId: "sibling", name: "Mac mini", role: "node", url: "http://10.0.0.9:43210", version: "0.0.10" })
  });

  const nodeDir = tmp("openagi-topo-full-node-");
  writeNodeConfig({ remote: mainBase, token: null }, nodeDir);
  const { app: nodeApp, base: nodeBase } = await bootApp(nodeDir);
  try {
    const json = await (await fetch(`${nodeBase}/nodes`)).json();
    assert.equal(json.stale, false);
    const byRole = json.nodes.map((n) => `${n.role}:${n.name}`);
    assert.equal(json.nodes.filter((n) => n.role === "main").length, 1, `exactly one main in ${byRole.join(", ")}`);
    assert.ok(json.nodes.some((n) => n.name === "Mac mini"), "siblings are listed");
    assert.ok(json.nodes.some((n) => n.self === true), "this machine is listed and flagged");
    assert.equal(json.nodes.find((n) => n.role === "main").status, "online", "we just talked to it");
    assert.equal(json.nodes.filter((n) => n.self === true).length, 1, "this machine appears exactly once");
  } finally { await nodeApp.close(); await mainApp.close(); }
});

test("GET /nodes on a main includes the main itself in the roster", async () => {
  const dataDir = tmp("openagi-topo-mainself-");
  const { app, base } = await bootApp(dataDir);
  try {
    const json = await (await fetch(`${base}/nodes`)).json();
    const self = json.nodes.find((n) => n.self === true);
    assert.ok(self, "a main with no nodes yet still has a topology of one");
    assert.equal(self.role, "main");
    assert.equal(self.status, "online", "it is answering this very request");
  } finally { await app.close(); }
});

// ---------------------------------------------------------------------------
// Bug 3 — a real build identity, or an honest "unknown"
// ---------------------------------------------------------------------------

test("GET /nodes reports a build identity alongside the package version", async () => {
  const dataDir = tmp("openagi-topo-build-");
  const { app, base } = await bootApp(dataDir);
  try {
    const json = await (await fetch(`${base}/nodes`)).json();
    assert.ok(typeof json.self.version === "string" && json.self.version.length > 0);
    assert.ok(["app-bundle", "git", "env", "unknown"].includes(json.self.buildSource), `got ${json.self.buildSource}`);
    if (json.self.buildSource === "unknown") {
      assert.equal(json.self.build, null, "never invent a build id — null renders as \"unknown\"");
    } else {
      assert.ok(typeof json.self.build === "string" && json.self.build.length > 0);
    }
    const self = json.nodes.find((n) => n.self === true);
    assert.equal(self.build, json.self.build, "the roster row for this machine carries the same build");
  } finally { await app.close(); }
});

test("GET /nodes marks which nodes are behind the newest version it can see", async () => {
  const dataDir = tmp("openagi-topo-behind-");
  const { app, base } = await bootApp(dataDir);
  try {
    await fetch(`${base}/nodes/heartbeat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: "old", name: "Old box", role: "node", version: "9.0.6", build: "abc1234", buildSource: "git" })
    });
    await fetch(`${base}/nodes/heartbeat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: "new", name: "New box", role: "node", version: "9.0.10", build: "def5678", buildSource: "git" })
    });
    const json = await (await fetch(`${base}/nodes`)).json();
    // 9.x deliberately: newestVersion considers this install's OWN version too,
    // so versions near the real package version made this test fail on every
    // release (it was pinned to 0.0.10 and broke the moment 0.0.11 shipped).
    // The property under test is numeric vs lexicographic ordering, which these
    // still exercise — lexicographically "9.0.6" sorts ABOVE "9.0.10".
    assert.equal(json.newestVersion, "9.0.10", "9.0.10 > 9.0.6 numerically, not lexicographically");
    assert.equal(json.nodes.find((n) => n.name === "Old box").behind, true);
    assert.equal(json.nodes.find((n) => n.name === "New box").behind, false);
    assert.equal(json.nodes.find((n) => n.name === "Old box").build, "abc1234", "the build a node reports is stored and shown");
    assert.ok(json.updateCommand, "the view tells the user how to update a node that is behind");
  } finally { await app.close(); }
});

// A sibling's `url` is self-reported in its heartbeat. Building
// "openagi update --remote <that url> --token <your token>" out of it would
// turn a compromised node into a token-harvesting prompt for the operator.
test("GET /nodes never builds a --remote update command out of a node-reported address", async () => {
  const dataDir = tmp("openagi-topo-updatecmd-");
  const { app, base } = await bootApp(dataDir);
  try {
    await fetch(`${base}/nodes/heartbeat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: "evil", name: "Totally Legit", role: "node", url: "http://attacker.example", version: "0.0.1" })
    });
    const json = await (await fetch(`${base}/nodes`)).json();
    const evil = json.nodes.find((n) => n.name === "Totally Legit");
    assert.equal(evil.behind, true, "it is genuinely behind — the row still says so");
    assert.equal(evil.updateCommand, null, "but no command is built from its self-reported address");
    for (const n of json.nodes) {
      assert.ok(
        !(n.updateCommand ?? "").includes("attacker.example"),
        "no row may embed a node-reported address in a command"
      );
    }
  } finally { await app.close(); }
});

test("GET /nodes may target the main it is paired to, because that address is local config", async () => {
  const dataDir = tmp("openagi-topo-mainremote-");
  writeNodeConfig({ remote: "http://127.0.0.1:1", token: null }, dataDir);
  const { app, base } = await bootApp(dataDir);
  try {
    const json = await (await fetch(`${base}/nodes`)).json();
    const main = json.nodes.find((n) => n.role === "main");
    assert.equal(main.updateCommand, "openagi update --remote http://127.0.0.1:1");
    assert.equal(json.nodes.find((n) => n.self).updateCommand, "openagi update");
  } finally { await app.close(); }
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("statusFor computes liveness from a timestamp and admits when it cannot", () => {
  const now = Date.now();
  assert.equal(statusFor(new Date(now - 1000).toISOString(), now), "online");
  assert.equal(statusFor(new Date(now - ONLINE_WINDOW_MS - 1).toISOString(), now), "offline");
  assert.equal(statusFor(null, now), "unknown");
  assert.equal(statusFor("not-a-date", now), "unknown");
});

test("compareVersions orders release numbers numerically, and refuses to guess", () => {
  assert.equal(compareVersions("0.0.10", "0.0.6"), 1, "0.0.10 is newer than 0.0.6");
  assert.equal(compareVersions("0.0.6", "0.0.10"), -1);
  assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("0.1.0", "0.0.99"), 1);
  assert.equal(compareVersions("banana", "0.0.1"), null);
  assert.equal(compareVersions(null, "0.0.1"), null);
  assert.equal(newestOf(["0.0.6", "0.0.10", null, "banana"]), "0.0.10");
  assert.equal(newestOf([null, undefined]), null);
});

test("resolveBuildInfo reads a stamped app bundle Info.plist", () => {
  const bundle = tmp("openagi-topo-bundle-");
  const srcDir = path.join(bundle, "OpenAGI.app", "Contents", "Resources", "openAGI", "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(bundle, "OpenAGI.app", "Contents", "Info.plist"), [
    "<plist><dict>",
    "<key>CFBundleShortVersionString</key><string>0.0.10</string>",
    "<key>CFBundleVersion</key><string>2608031530</string>",
    "</dict></plist>"
  ].join("\n"));
  const info = resolveBuildInfo({ packageVersion: "0.0.6", moduleDir: srcDir, env: {}, cache: false });
  assert.equal(info.buildSource, "app-bundle");
  assert.equal(info.version, "0.0.10", "the bundle is stamped from the git tag; package.json has drifted");
  assert.equal(info.build, "2608031530");
});

test("resolveBuildInfo refuses an unstamped bundle rather than reporting __VERSION__", () => {
  const bundle = tmp("openagi-topo-unstamped-");
  const srcDir = path.join(bundle, "OpenAGI.app", "Contents", "Resources", "openAGI", "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(bundle, "OpenAGI.app", "Contents", "Info.plist"),
    "<plist><dict><key>CFBundleShortVersionString</key><string>__VERSION__</string>"
    + "<key>CFBundleVersion</key><string>__BUILD__</string></dict></plist>");
  const info = resolveBuildInfo({ packageVersion: "0.0.6", moduleDir: srcDir, env: {}, cache: false });
  assert.notEqual(info.version, "__VERSION__");
  assert.notEqual(info.build, "__BUILD__");
});

test("resolveBuildInfo reads the git SHA of a checkout, including a detached HEAD", () => {
  const repo = tmp("openagi-topo-git-");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".git", "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(repo, ".git", "refs", "heads", "main"), "266fed4a1b2c3d4e5f60718293a4b5c6d7e8f900\n");
  const info = resolveBuildInfo({ packageVersion: "0.0.6", moduleDir: path.join(repo, "src"), env: {}, cache: false });
  assert.equal(info.buildSource, "git");
  assert.equal(info.build, "266fed4");
  assert.equal(info.version, "0.0.6", "no tag is readable without shelling out — report the package version honestly");

  fs.writeFileSync(path.join(repo, ".git", "HEAD"), `${"a".repeat(7)}${"b".repeat(33)}\n`);
  const detached = resolveBuildInfo({ packageVersion: "0.0.6", moduleDir: path.join(repo, "src"), env: {}, cache: false });
  assert.equal(detached.build, "aaaaaaa");
});

test("resolveBuildInfo falls back to a packed ref, then to an honest unknown", () => {
  const repo = tmp("openagi-topo-packed-");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(repo, ".git", "packed-refs"),
    "# pack-refs with: peeled fully-peeled sorted\n0123456789abcdef0123456789abcdef01234567 refs/heads/main\n");
  assert.equal(resolveBuildInfo({ packageVersion: "0.0.6", moduleDir: path.join(repo, "src"), env: {}, cache: false }).build, "0123456");

  const bare = tmp("openagi-topo-bare-");
  fs.mkdirSync(path.join(bare, "src"), { recursive: true });
  const unknown = resolveBuildInfo({ packageVersion: "0.0.6", moduleDir: path.join(bare, "src"), env: {}, cache: false });
  assert.equal(unknown.buildSource, "unknown");
  assert.equal(unknown.build, null, "an unknown build is null, never a guess");
  assert.equal(unknown.version, "0.0.6");
});

test("resolveBuildInfo lets a container/CI build stamp itself via the environment", () => {
  const bare = tmp("openagi-topo-env-");
  fs.mkdirSync(path.join(bare, "src"), { recursive: true });
  const info = resolveBuildInfo({
    packageVersion: "0.0.6", moduleDir: path.join(bare, "src"),
    env: { OPENAGI_VERSION: "0.0.11", OPENAGI_BUILD: "ci-9f8e7d6" }, cache: false
  });
  assert.equal(info.buildSource, "env");
  assert.equal(info.version, "0.0.11");
  assert.equal(info.build, "ci-9f8e7d6");
});
