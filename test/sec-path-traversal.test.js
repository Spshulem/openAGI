// test/sec-path-traversal.test.js
//
// SEC-3. Four sinks all did `path.join(<dir>, `${idFromUrl}.json`)` with the id
// taken from a route whose regex was `[^/]+`. `url.pathname` keeps percent
// encoding, so `..%2F..%2F..%2Fvictim` matches `[^/]+`, the handler decodes it,
// and the join walks out of the directory:
//
//   hosted-interface  POST /mcp/clear-auth/<name>          → unlinkSync
//   suggestion-feed   POST /proactive/suggestions/<id>/…   → read + rewrite + echo back
//   backlog-triage    retireSuggestion(dir, {id})          → read + rewrite
//   pattern-miner     accept(id) / reject(id)              → read + rewrite
//
// Each test plants a victim .json OUTSIDE the intended directory and asserts it
// is still there, byte for byte, afterwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { safeJoin, safeJoinOrNull, assertContained, isSafeSegment, LABEL_SEGMENT } from "../src/path-guard.js";
import { resolveSuggestion } from "../src/suggestion-feed.js";
import { BacklogTriage } from "../src/backlog-triage.js";
import { PatternMiner } from "../src/pattern-miner.js";

function sandbox(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sec3-${name}-`));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  return { root, dataDir };
}

// Shaped so that EVERY sink would happily act on it if the traversal landed:
// status "pending" is what backlog-triage and suggestion-feed require before
// they rewrite, and proposal.name/body is what pattern-miner.accept needs.
const VICTIM = JSON.stringify(
  { id: "victim", status: "pending", proposal: { name: "pwned", body: "x" }, secret: "do-not-touch" },
  null,
  2
);

/// Every shape the brief asked to be attacked. All of them decode (or already
/// are) a separator, a parent hop, or an absolute path.
const TRAVERSAL_IDS = [
  "../../../victim",
  "..%2F..%2F..%2Fvictim",          // encoded once — arrives decoded via the route
  "..%252F..%252Fvictim",           // double-encoded
  "%2e%2e%2f%2e%2e%2fvictim",       // encoded dots + slash
  "....//....//victim",
  "..\\..\\victim",                 // backslash separator
  "/etc/passwd",                    // absolute
  "．．/．．/victim", // FULLWIDTH FULL STOP lookalikes
  "․․/victim",            // ONE DOT LEADER lookalikes
  "..",
  ".",
  "victim\0.json"                   // NUL truncation
];

// ── the guard itself ────────────────────────────────────────────────────────

test("SEC-3 path-guard: allowlist rejects every traversal shape, accepts real ids", () => {
  for (const bad of TRAVERSAL_IDS) {
    assert.equal(isSafeSegment(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
  for (const good of ["sug_014d98236ec446d2", "prop_00956a388c8b46e9", "ses_8a22530e51eb4f65", "latest"]) {
    assert.equal(isSafeSegment(good), true, `should accept ${good}`);
  }
  // Spaces only where a user-chosen label is expected (MCP server names).
  assert.equal(isSafeSegment("buildbetter staging"), false);
  assert.equal(isSafeSegment("buildbetter staging", LABEL_SEGMENT), true);
  assert.equal(isSafeSegment("..%2Fx", LABEL_SEGMENT), false);
});

test("SEC-3 path-guard: containment uses a trailing separator, so a sibling directory sharing a prefix is rejected", () => {
  const base = path.join(os.tmpdir(), "sec3-contain", "auth");
  // A bare startsWith(base) would accept this — the sibling shares the prefix.
  assert.throws(
    () => assertContained(base, path.join(os.tmpdir(), "sec3-contain", "auth-evil", "x.json")),
    /escapes its directory/
  );
  assert.doesNotThrow(() => assertContained(base, path.join(base, "x.json")));
});

test("SEC-3 path-guard: safeJoin never returns a path outside the base", () => {
  const base = path.join(os.tmpdir(), "sec3-join", "auth");
  for (const bad of TRAVERSAL_IDS) {
    assert.equal(safeJoinOrNull(base, bad), null, `safeJoin must refuse ${JSON.stringify(bad)}`);
    // Composing `${id}.json` must never produce something outside the base
    // either — ".."+".json" is the harmless literal file "...json", not a hop.
    const composed = safeJoinOrNull(base, `${bad}.json`);
    if (composed !== null) assert.doesNotThrow(() => assertContained(base, composed));
  }
  assert.equal(safeJoin(base, "sug_abc.json"), path.join(base, "sug_abc.json"));
});

// ── sink 1: hosted-interface POST /mcp/clear-auth/<name> → unlinkSync ───────

test("SEC-3 hosted-interface: POST /mcp/clear-auth cannot unlink a .json outside <dataDir>/mcp/auth", async () => {
  const { root, dataDir } = sandbox("clearauth");
  const victim = path.join(root, "victim.json");
  fs.writeFileSync(victim, VICTIM);
  fs.mkdirSync(path.join(dataDir, "mcp", "auth"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "mcp", "auth", "real.json"), JSON.stringify({ access_token: "x" }));

  const prevData = process.env.OPENAGI_DATA_DIR;
  const prevToken = process.env.OPENAGI_AUTH_TOKEN;
  process.env.OPENAGI_DATA_DIR = dataDir;
  process.env.OPENAGI_AUTH_TOKEN = "";
  const { _resetDataDirCache } = await import("../src/data-dir.js");
  _resetDataDirCache();
  const { createDurableRuntime, createHostedInterface } = await import("../src/index.js");

  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, dataDir });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  try {
    // Every encoding of "../../../victim" the route regex still matches,
    // because url.pathname does not decode %2F.
    const probes = [
      "..%2F..%2F..%2Fvictim",
      "%2e%2e%2f%2e%2e%2f%2e%2e%2fvictim",
      "..%252F..%252F..%252Fvictim",       // double-encoded
      "%2E%2E/%2E%2E/%2E%2E/victim",
      "....%2F%2F....%2F%2F....%2F%2Fvictim",
      "..%5C..%5C..%5Cvictim",             // backslash
      "%2Fetc%2Fpasswd",                   // absolute
      "%EF%BC%8E%EF%BC%8E%2F%EF%BC%8E%EF%BC%8E%2Fvictim", // fullwidth dot lookalikes
      "..%00%2F..%2Fvictim",               // NUL truncation
      "auth-evil%2Fvictim"                 // sibling dir sharing the prefix
    ];
    for (const probe of probes) {
      const res = await fetch(`${base}/mcp/clear-auth/${probe}`, { method: "POST" });
      assert.notEqual(res.status, 200, `traversal name must not be accepted: ${probe}`);
      assert.equal(fs.existsSync(victim), true, `victim .json was unlinked via ${probe}`);
    }
    assert.equal(fs.readFileSync(victim, "utf8"), VICTIM);

    // The legitimate case still works, including a server name with a space.
    const ok = await fetch(`${base}/mcp/clear-auth/real`, { method: "POST" });
    assert.equal(ok.status, 200);
    assert.equal(fs.existsSync(path.join(dataDir, "mcp", "auth", "real.json")), false);

    fs.writeFileSync(path.join(dataDir, "mcp", "auth", "buildbetter staging.json"), "{}");
    const spaced = await fetch(`${base}/mcp/clear-auth/${encodeURIComponent("buildbetter staging")}`, { method: "POST" });
    assert.equal(spaced.status, 200, "server names with spaces must keep working");
    assert.equal(fs.existsSync(path.join(dataDir, "mcp", "auth", "buildbetter staging.json")), false);
  } finally {
    await app.close?.();
    if (prevData === undefined) delete process.env.OPENAGI_DATA_DIR; else process.env.OPENAGI_DATA_DIR = prevData;
    if (prevToken === undefined) delete process.env.OPENAGI_AUTH_TOKEN; else process.env.OPENAGI_AUTH_TOKEN = prevToken;
    _resetDataDirCache();
  }
});

test("SEC-3 hosted-interface: POST /proactive/suggestions/<id>/reject cannot rewrite a file outside the queue", async () => {
  const { root, dataDir } = sandbox("suggroute");
  fs.mkdirSync(path.join(dataDir, "proactive", "suggestions"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "skills-suggested"), { recursive: true });
  const victim = path.join(root, "victim.json");
  fs.writeFileSync(victim, VICTIM);

  const prevData = process.env.OPENAGI_DATA_DIR;
  const prevToken = process.env.OPENAGI_AUTH_TOKEN;
  process.env.OPENAGI_DATA_DIR = dataDir;
  process.env.OPENAGI_AUTH_TOKEN = "";
  const { _resetDataDirCache } = await import("../src/data-dir.js");
  _resetDataDirCache();
  const { createDurableRuntime, createHostedInterface } = await import("../src/index.js");
  const app = createHostedInterface(createDurableRuntime({ dataDir }), { host: "127.0.0.1", port: 0, dataDir });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  try {
    for (const probe of ["..%2F..%2F..%2Fvictim", "%2e%2e%2f%2e%2e%2f%2e%2e%2fvictim", "..%252F..%252Fvictim"]) {
      const res = await fetch(`${base}/proactive/suggestions/${probe}/reject`, { method: "POST" });
      assert.equal(res.status, 404, `traversal id must 404, got ${res.status} for ${probe}`);
    }
    assert.equal(fs.readFileSync(victim, "utf8"), VICTIM, "victim file was rewritten through the HTTP route");
  } finally {
    await app.close?.();
    if (prevData === undefined) delete process.env.OPENAGI_DATA_DIR; else process.env.OPENAGI_DATA_DIR = prevData;
    if (prevToken === undefined) delete process.env.OPENAGI_AUTH_TOKEN; else process.env.OPENAGI_AUTH_TOKEN = prevToken;
    _resetDataDirCache();
  }
});

// ── sink 2: suggestion-feed resolveSuggestion ──────────────────────────────

test("SEC-3 suggestion-feed: resolveSuggestion cannot read or rewrite a .json outside the suggestion dirs", () => {
  const { root, dataDir } = sandbox("feed");
  fs.mkdirSync(path.join(dataDir, "proactive", "suggestions"), { recursive: true });
  fs.mkdirSync(path.join(dataDir, "skills-suggested"), { recursive: true });
  const victim = path.join(root, "victim.json");
  fs.writeFileSync(victim, VICTIM);

  for (const id of ["../../../victim", "../../victim"]) {
    const out = resolveSuggestion({ dataDir }, id, "accepted", "pwned");
    assert.equal(out, null, `resolveSuggestion must refuse ${id}`);
  }
  assert.equal(fs.readFileSync(victim, "utf8"), VICTIM, "victim file was rewritten");

  // Legitimate ids still resolve and still round-trip.
  const good = path.join(dataDir, "proactive", "suggestions", "prop_abc123.json");
  fs.writeFileSync(good, JSON.stringify({ id: "prop_abc123", status: "pending", title: "t" }));
  const ok = resolveSuggestion({ dataDir }, "prop_abc123", "accepted", "note");
  assert.equal(ok?.status, "accepted");
  assert.equal(JSON.parse(fs.readFileSync(good, "utf8")).status, "accepted");
});

// ── sink 3: backlog-triage retireSuggestion ────────────────────────────────

test("SEC-3 backlog-triage: retireSuggestion cannot rewrite a .json outside the suggestion dirs", () => {
  const { root, dataDir } = sandbox("triage");
  fs.mkdirSync(path.join(dataDir, "proactive", "suggestions"), { recursive: true });
  const victim = path.join(root, "victim.json");
  fs.writeFileSync(victim, VICTIM);

  const triage = new BacklogTriage({ runtime: {}, dataDir });
  const degraded = [];
  const wrote = triage.retireSuggestion(
    dataDir,
    { id: "../../../victim", rule: "x", decidedBy: "model", reason: "pwned" },
    "pass_1",
    degraded
  );
  assert.equal(wrote, false, "traversal id must not be retired");
  assert.equal(fs.readFileSync(victim, "utf8"), VICTIM, "victim file was rewritten");
});

// ── sink 4: pattern-miner accept / reject ──────────────────────────────────

test("SEC-3 pattern-miner: accept/reject cannot touch a .json outside skills-suggested", () => {
  const { root, dataDir } = sandbox("miner");
  const victim = path.join(root, "victim.json");
  fs.writeFileSync(victim, VICTIM);

  const miner = new PatternMiner({ dataDir });
  assert.throws(() => miner.accept("../../victim"), /Unknown candidate/);
  assert.equal(miner.reject("../../victim", "pwned"), null);
  assert.equal(fs.readFileSync(victim, "utf8"), VICTIM, "victim file was rewritten");
  assert.equal(fs.existsSync(path.join(dataDir, "skills", "pwned")), false, "a skill was materialized from an out-of-tree file");

  // Legitimate candidate still round-trips through reject().
  fs.writeFileSync(
    path.join(dataDir, "skills-suggested", "sug_abc123.json"),
    JSON.stringify({ id: "sug_abc123", status: "pending", proposal: { name: "x", body: "y" } })
  );
  assert.equal(miner.reject("sug_abc123", "nope")?.status, "rejected");
});
