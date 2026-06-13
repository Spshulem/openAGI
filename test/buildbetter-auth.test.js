// test/buildbetter-auth.test.js
// Covers the two auth improvements:
//   1. Identity is auto-derived from the `me` query (no manual email/name).
//   2. The poller can reuse the BuildBetter MCP OAuth connection (Bearer token,
//      silently refreshed) instead of an API key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BuildBetterTaskSource } from "../src/integrations/buildbetter-tasks.js";

// Isolate from any real BuildBetter env in the host so the OAuth path is
// reachable when we don't pass an API key.
delete process.env.BUILDBETTER_API_KEY;
delete process.env.BUILDBETTER_USER_EMAIL;
delete process.env.BUILDBETTER_USER_NAME;

// — Option 1: identity auto-derivation via `me` —

test("ensureIdentity auto-derives email from the me query", async () => {
  const src = new BuildBetterTaskSource({ apiKey: "k" }); // no email/name given
  src.query = async (q) => {
    assert.match(q, /\bme\b/);
    return { me: { person: { first_name: "Test", last_name: "User", email: "test@example.com" } } };
  };
  await src.ensureIdentity();
  assert.equal(src.userEmail, "test@example.com");
});

test("ensureIdentity falls back to full name when me has no email", async () => {
  const src = new BuildBetterTaskSource({ apiKey: "k" });
  src.query = async () => ({ me: { person: { first_name: "Ada", last_name: "Lovelace", email: null } } });
  await src.ensureIdentity();
  assert.equal(src.userEmail, null);
  assert.equal(src.userName, "Ada Lovelace");
});

test("ensureIdentity is a no-op when identity is already known", async () => {
  const src = new BuildBetterTaskSource({ apiKey: "k", userEmail: "me@x.com" });
  let called = 0;
  src.query = async () => { called += 1; return {}; };
  await src.ensureIdentity();
  assert.equal(called, 0, "must not hit the API when we already know who you are");
});

test("ensureIdentity does not re-query after a null me (org-scoped key)", async () => {
  const src = new BuildBetterTaskSource({ apiKey: "k" });
  let called = 0;
  src.query = async () => { called += 1; return { me: null }; };
  await src.ensureIdentity();
  await src.ensureIdentity();
  assert.equal(called, 1, "asked once, then falls back to env identity without re-asking");
  assert.equal(src.userEmail, null);
});

test("ensureIdentity retries after a thrown (transient) error", async () => {
  const src = new BuildBetterTaskSource({ apiKey: "k" });
  let called = 0;
  src.query = async () => {
    called += 1;
    if (called === 1) throw new Error("network");
    return { me: { person: { first_name: "Grace", last_name: "Hopper", email: "grace@x.com" } } };
  };
  await src.ensureIdentity();
  assert.equal(src.userEmail, null, "first attempt failed → still unresolved");
  await src.ensureIdentity();
  assert.equal(src.userEmail, "grace@x.com", "second attempt succeeds");
  assert.equal(called, 2);
});

// — Option 2: reuse the MCP OAuth connection —

test("authHeaders uses the API key when set", async () => {
  const src = new BuildBetterTaskSource({ apiKey: "secret" });
  assert.deepEqual(await src.authHeaders(), { "X-BuildBetter-Api-Key": "secret" });
});

test("authHeaders falls back to the BuildBetter MCP OAuth token via the registry", async () => {
  let askedFor;
  const mcp = { silentTokenFor: async (name) => { askedFor = name; return "tok"; } };
  const src = new BuildBetterTaskSource({ apiKey: null, runtime: { mcp } });
  assert.deepEqual(await src.authHeaders(), { authorization: "Bearer tok" });
  assert.equal(askedFor, "buildbetter", "reuses the buildbetter MCP server's token");
});

test("authHeaders returns null when the registry has no silent token", async () => {
  const src1 = new BuildBetterTaskSource({ apiKey: null, runtime: { mcp: { silentTokenFor: async () => null } } });
  assert.equal(await src1.authHeaders(), null);
  // ...and when there's no registry at all.
  const src2 = new BuildBetterTaskSource({ apiKey: null, runtime: {} });
  assert.equal(await src2.authHeaders(), null);
});

test("isConfigured is true with only a reused OAuth connection (registry reports a cached token)", () => {
  const src = new BuildBetterTaskSource({ apiKey: null, runtime: { mcp: { hasOAuthToken: () => true } } });
  assert.equal(src.isConfigured(), true);
});

test("isConfigured is false with neither api key nor a cached OAuth token", () => {
  const src = new BuildBetterTaskSource({ apiKey: null, runtime: { mcp: { hasOAuthToken: () => false } } });
  assert.equal(src.isConfigured(), false);
  // No registry at all → also false.
  assert.equal(new BuildBetterTaskSource({ apiKey: null, runtime: {} }).isConfigured(), false);
});
