// test/mcp-oauth-scope.test.js
// Regression test for the `invalid_scope` OAuth failure: the client must
// narrow the requested scope to what each server advertises, and omit `scope`
// entirely for servers (like Rize) that advertise none — instead of always
// sending a hardcoded openid/profile/email/offline_access set.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { McpOAuthClient } from "../src/mcp-oauth.js";

const dataDir = path.join(os.tmpdir(), `openagi-oauth-test-${process.pid}`);
const make = (opts = {}) => new McpOAuthClient({ resourceUrl: "https://example.test", dataDir, ...opts });

test("Rize-style server (no scopes advertised) → omit scope entirely", () => {
  const client = make();
  // Real shapes pulled from mcp.rize.io: protected-resource has no
  // scopes_supported; auth-server metadata has no scopes_supported either.
  const discovery = {
    resourceMeta: { resource: "https://mcp.rize.io/mcp", authorization_servers: ["https://mcp.rize.io"] },
    serverMeta: { issuer: "https://mcp.rize.io", grant_types_supported: ["authorization_code"] }
  };
  assert.equal(client.resolveScope(discovery), null);
});

test("BuildBetter-style resource scopes → intersection with preferred (drops extras like service_account)", () => {
  const client = make();
  const discovery = {
    resourceMeta: { scopes_supported: ["openid", "profile", "email", "offline_access", "service_account"] },
    serverMeta: {}
  };
  assert.equal(client.resolveScope(discovery), "openid profile email offline_access");
});

test("auth-server scopes_supported is used when the resource doesn't advertise", () => {
  const client = make();
  const discovery = {
    resourceMeta: {},
    serverMeta: { scopes_supported: ["openid", "email", "read:stuff"] }
  };
  assert.equal(client.resolveScope(discovery), "openid email");
});

test("no overlap between preferred and supported → omit scope", () => {
  const client = make();
  const discovery = { resourceMeta: { scopes_supported: ["read:repo", "write:repo"] }, serverMeta: {} };
  assert.equal(client.resolveScope(discovery), null);
});

test("an explicitly-configured scope is treated as authoritative and sent as-is", () => {
  const client = make({ scope: "custom:scope another" });
  // Even though the server advertises something else, an explicit catalog
  // scope wins (the integration author knows what that server needs).
  const discovery = { resourceMeta: { scopes_supported: ["openid"] }, serverMeta: {} };
  assert.equal(client.resolveScope(discovery), "custom:scope another");
});

test("empty resource scopes_supported array → omit scope", () => {
  const client = make();
  const discovery = { resourceMeta: { scopes_supported: [] }, serverMeta: {} };
  assert.equal(client.resolveScope(discovery), null);
});

test("empty resource scopes_supported falls through to the auth server's scopes (not the empty array)", () => {
  const client = make();
  // resourceMeta advertises an EMPTY list but the auth server advertises real
  // scopes — a naive `??` would keep [] and wrongly omit the scope.
  const discovery = {
    resourceMeta: { scopes_supported: [] },
    serverMeta: { scopes_supported: ["openid", "email"] }
  };
  assert.equal(client.resolveScope(discovery), "openid email");
});
