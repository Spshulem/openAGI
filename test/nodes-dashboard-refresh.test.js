import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The dashboard is an inline browser app emitted by hosted-interface.js. Pin
// the user-visible lifecycle in source so a slow or unreachable main cannot
// silently regress to an empty Nodes pane or an uncontrolled polling loop.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "src/hosted-interface.js"), "utf8");

test("Nodes renders loading and retryable error states around its request", () => {
  const start = source.indexOf("async function renderNodesOnce");
  const end = source.indexOf("async function renderChannels", start);
  assert.ok(start >= 0 && end > start, "Nodes renderer not found");
  const body = source.slice(start, end);

  const loading = body.indexOf("Loading nodes…");
  const request = body.indexOf('fetchJson("/nodes")');
  assert.ok(loading >= 0 && loading < request, "loading state must render before the /nodes request");
  assert.match(body, /catch \(error\)[\s\S]*Couldn't load nodes[\s\S]*id="nodesRetry"/);
  assert.match(body, /nodesRetry[\s\S]*addEventListener\("click", \(\) => renderNodes\(\)\)/);
  assert.match(body, /if \(state\.tab !== "nodes"\) return;/, "late responses must not overwrite another tab");
});

test("Nodes refresh is single-flight and runs every 30 seconds only while visible", () => {
  assert.match(
    source,
    /if \(nodesRenderPromise\) return nodesRenderPromise;/,
    "coincident refresh triggers must share the request already in flight"
  );
  assert.match(source, /document\.addEventListener\("visibilitychange"/);
  assert.match(
    source,
    /if \(state\.tab === "nodes" && !document\.hidden\) \{[\s\S]*setInterval\([\s\S]*30_000/,
    "the 30-second timer must only be created for a visible Nodes tab"
  );
  assert.match(
    source,
    /async function switchTab\(tab\) \{\s*state\.tab = tab;\s*syncNodesAutoRefresh\(\);/,
    "switching away from Nodes must tear down its timer"
  );
});
