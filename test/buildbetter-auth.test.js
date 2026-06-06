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
    return { me: { person: { first_name: "Spencer", last_name: "Shulem", email: "you@example.com" } } };
  };
  await src.ensureIdentity();
  assert.equal(src.userEmail, "you@example.com");
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

test("authHeaders falls back to a reused OAuth bearer token", async () => {
  const fakeOauth = {
    loadCache: () => ({ access_token: "tok", expires_at: Date.now() + 600_000 }),
    isExpired: () => false,
    refresh: async () => { throw new Error("should not refresh a fresh token"); }
  };
  const src = new BuildBetterTaskSource({ apiKey: null, oauthClient: fakeOauth });
  assert.deepEqual(await src.authHeaders(), { authorization: "Bearer tok" });
});

test("authHeaders returns null with no api key and no OAuth cache", async () => {
  const fakeOauth = { loadCache: () => null, isExpired: () => true, refresh: async () => {} };
  const src = new BuildBetterTaskSource({ apiKey: null, oauthClient: fakeOauth });
  assert.equal(await src.authHeaders(), null);
});

test("_oauthToken silently refreshes an expired token (no browser flow)", async () => {
  let refreshed = false;
  const fakeOauth = {
    loadCache() {
      return refreshed
        ? { access_token: "new", expires_at: Date.now() + 600_000 }
        : { access_token: "old", expires_at: 0, refresh_token: "r", discovery: {}, client: {} };
    },
    isExpired(c) { return (c.expires_at ?? 0) <= Date.now(); },
    refresh: async () => { refreshed = true; }
  };
  const src = new BuildBetterTaskSource({ apiKey: null, oauthClient: fakeOauth });
  assert.equal(await src._oauthToken(), "new");
});

test("_oauthToken never triggers interactive auth when nothing is cached", async () => {
  const fakeOauth = {
    loadCache: () => null,
    isExpired: () => true,
    refresh: async () => { throw new Error("must not refresh"); }
  };
  const src = new BuildBetterTaskSource({ apiKey: null, oauthClient: fakeOauth });
  assert.equal(await src._oauthToken(), null);
});

test("isConfigured is true with only a reused OAuth connection", () => {
  const fakeOauth = { loadCache: () => ({ refresh_token: "r" }), isExpired: () => true };
  const src = new BuildBetterTaskSource({ apiKey: null, oauthClient: fakeOauth });
  assert.equal(src.isConfigured(), true);
});

test("isConfigured is false with neither api key nor OAuth cache", () => {
  const fakeOauth = { loadCache: () => null, isExpired: () => true };
  const src = new BuildBetterTaskSource({ apiKey: null, oauthClient: fakeOauth });
  assert.equal(src.isConfigured(), false);
});
