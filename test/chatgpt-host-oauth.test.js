import assert from "node:assert/strict";
import test from "node:test";
import { ChatGptHostOAuth } from "../src/chatgpt-host-oauth.js";

const device = { user_code: "CODE-EXAMPLE", device_auth_id: "device-example", interval: 5 };
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

test("host-owned device login obtains a code from the fixed issuer without touching Codex credentials", async () => {
  const requests = [];
  const oauth = new ChatGptHostOAuth({
    store: { read: async () => null, write: async () => { throw new Error("unexpected write"); }, readGeneration: async () => "epoch-0" },
    fetchImpl: async (url, init) => { requests.push({ url, init }); return response(device); }
  });
  const login = await oauth.startDeviceLogin();
  assert.deepEqual(login, {
    type: "chatgptDeviceCode", loginId: login.loginId,
    userCode: "CODE-EXAMPLE", verificationUrl: "https://auth.openai.com/codex/device"
  });
  assert.match(login.loginId, /^[a-f0-9]{32}$/);
  assert.equal(requests[0].url, "https://auth.openai.com/api/accounts/deviceauth/usercode");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.redirect, "error");
  assert.deepEqual(Object.keys(JSON.parse(requests[0].init.body)), ["client_id"]);
  assert.equal(JSON.stringify(login).includes("device-example"), false);
});

test("device login polls at a bounded interval and replaces the grant with a new credential epoch", async () => {
  const requests = [];
  let saved = null;
  let credentialGeneration = "epoch-0";
  let time = 0;
  const replies = [
    response(device), response({}, 403),
    response({ authorization_code: "authorization-example", code_verifier: "verifier-example" }),
    response({ access_token: "access-example", refresh_token: "refresh-example", expires_in: 3600 })
  ];
  const oauth = new ChatGptHostOAuth({
    store: { read: async () => saved, write: async (value) => { saved = value; }, withLock: async (fn) => fn(),
      readGeneration: async () => credentialGeneration,
      bumpGeneration: async () => { credentialGeneration = "epoch-1"; return credentialGeneration; } },
    clock: () => time,
    fetchImpl: async (url, init) => { requests.push({ url, init }); return replies.shift(); }
  });
  const { loginId } = await oauth.startDeviceLogin();
  assert.deepEqual(await oauth.pollDeviceLogin(loginId), { status: "pending" });
  assert.equal(requests.length, 1, "must not poll before the advertised interval");
  time = 5_000;
  assert.deepEqual(await oauth.pollDeviceLogin(loginId), { status: "pending", providerState: "forbidden" });
  time = 10_000;
  assert.deepEqual(await oauth.pollDeviceLogin(loginId), { status: "connected" });
  assert.equal(requests[1].url, "https://auth.openai.com/api/accounts/deviceauth/token");
  assert.equal(requests[3].url, "https://auth.openai.com/oauth/token");
  assert.equal(requests[3].init.redirect, "error");
  assert.equal(new URLSearchParams(requests[3].init.body).get("grant_type"), "authorization_code");
  assert.deepEqual(saved, { accessToken: "access-example", refreshToken: "refresh-example", expiresAt: 3_610_000 });
  assert.equal(await oauth.getCredentialGeneration(), "epoch-1");
  assert.deepEqual(await oauth.pollDeviceLogin(loginId), { status: "connected" });
  assert.equal(requests.length, 4, "must never redeem a device code twice");
});

test("device login treats OAuth 400 authorization_pending as pending instead of failed", async () => {
  const requests = [];
  let time = 0;
  let saved = null;
  let epoch = "epoch-0";
  const replies = [
    response(device),
    response({ error: "authorization_pending" }, 400),
    response({ error: "slow_down" }, 400),
    response({ authorization_code: "authorization-example", code_verifier: "verifier-example" }),
    response({ access_token: "access-example", refresh_token: "refresh-example", expires_in: 3600 })
  ];
  const oauth = new ChatGptHostOAuth({
    store: {
      read: async () => saved,
      write: async (value) => { saved = value; },
      withLock: async (fn) => fn(),
      readGeneration: async () => epoch,
      bumpGeneration: async () => { epoch = "epoch-1"; return epoch; }
    },
    clock: () => time,
    fetchImpl: async (url, init) => { requests.push({ url, init }); return replies.shift(); }
  });
  const { loginId } = await oauth.startDeviceLogin();
  time = 5_000;
  assert.deepEqual(await oauth.pollDeviceLogin(loginId), { status: "pending", providerState: "authorization_pending" });
  time = 10_000;
  assert.deepEqual(await oauth.pollDeviceLogin(loginId), { status: "pending", providerState: "slow_down" });
  time = 20_000;
  assert.deepEqual(await oauth.pollDeviceLogin(loginId), { status: "connected" });
  assert.equal(requests.filter((request) => request.url.endsWith("/deviceauth/token")).length, 3);
  assert.deepEqual(saved, { accessToken: "access-example", refreshToken: "refresh-example", expiresAt: 3_620_000 });
});

test("device polling reports only an allowlisted non-secret pending reason", async () => {
  let time = 0;
  const oauth = new ChatGptHostOAuth({
    store: {
      read: async () => null,
      write: async () => { throw new Error("unexpected write"); },
      readGeneration: async () => "epoch-0"
    },
    clock: () => time,
    fetchImpl: async (url) => url.endsWith("/usercode")
      ? response(device)
      : response({ error: "authorization_pending", error_description: "secret sentinel must not escape" }, 400)
  });
  const { loginId } = await oauth.startDeviceLogin();
  time = 5_000;
  const result = await oauth.pollDeviceLogin(loginId);
  assert.deepEqual(result, { status: "pending", providerState: "authorization_pending" });
  assert.equal(JSON.stringify(result).includes("sentinel"), false);
});

test("device polling exposes a generic non-secret state for an unclassified forbidden reply", async () => {
  let time = 0;
  const oauth = new ChatGptHostOAuth({
    store: {
      read: async () => null,
      write: async () => { throw new Error("unexpected write"); },
      readGeneration: async () => "epoch-0"
    },
    clock: () => time,
    fetchImpl: async (url) => url.endsWith("/usercode")
      ? response(device)
      : response({ error: "private upstream detail" }, 403)
  });
  const { loginId } = await oauth.startDeviceLogin();
  time = 5_000;
  const result = await oauth.pollDeviceLogin(loginId);
  assert.deepEqual(result, { status: "pending", providerState: "forbidden" });
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("device polling exposes an allowlisted non-secret terminal reason for an upstream rate limit", async () => {
  let time = 0;
  const oauth = new ChatGptHostOAuth({
    clock: () => time,
    store: { read: async () => null, write: async () => { throw new Error("unexpected write"); }, readGeneration: async () => "epoch-0" },
    fetchImpl: async (url) => url.endsWith("/usercode") ? response(device) : response({}, 429)
  });
  const { loginId } = await oauth.startDeviceLogin();
  time = 5_000;
  assert.deepEqual(await oauth.pollDeviceLogin(loginId), { status: "failed", providerState: "upstream_rate_limited" });
});

test("device polling classifies a redirect-blocked transport without exposing the upstream error", async () => {
  let time = 0;
  const oauth = new ChatGptHostOAuth({
    clock: () => time,
    store: { read: async () => null, write: async () => { throw new Error("unexpected write"); }, readGeneration: async () => "epoch-0" },
    fetchImpl: async (url) => url.endsWith("/usercode") ? response(device) : Promise.reject(new TypeError("fetch failed", { cause: new Error("unexpected redirect") }))
  });
  const { loginId } = await oauth.startDeviceLogin();
  time = 5_000;
  const result = await oauth.pollDeviceLogin(loginId);
  assert.deepEqual(result, { status: "failed", providerState: "transport_redirect" });
  assert.equal(JSON.stringify(result).includes("unexpected"), false);
});

test("device polling reports a closed token-exchange rejection after device authorization", async () => {
  let time = 0;
  const oauth = new ChatGptHostOAuth({
    clock: () => time,
    store: { read: async () => null, write: async () => { throw new Error("unexpected write"); }, readGeneration: async () => "epoch-0" },
    fetchImpl: async (url) => {
      if (url.endsWith("/usercode")) return response(device);
      if (url.endsWith("/deviceauth/token")) return response({ authorization_code: "authorization-example", code_verifier: "verifier-example" });
      return response({ error: "private upstream detail" }, 401);
    }
  });
  const { loginId } = await oauth.startDeviceLogin();
  time = 5_000;
  const result = await oauth.pollDeviceLogin(loginId);
  assert.deepEqual(result, { status: "failed", providerState: "token_exchange_rejected" });
  assert.equal(JSON.stringify(result).includes("private"), false);
});

test("expiring tokens refresh once under concurrent callers and never disclose the refresh token", async () => {
  let saved = { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 80_000 };
  const requests = [];
  const store = {
    read: async () => saved,
    write: async (value) => { saved = value; },
    withLock: async (fn) => fn()
  };
  const oauth = new ChatGptHostOAuth({
    store, clock: () => 20_000,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return response({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    }
  });
  assert.deepEqual(await Promise.all([oauth.getAccessToken(), oauth.getAccessToken()]), ["new-access", "new-access"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://auth.openai.com/oauth/token");
  assert.equal(requests[0].init.redirect, "error");
  assert.equal(new URLSearchParams(requests[0].init.body).get("grant_type"), "refresh_token");
  assert.deepEqual(saved, { accessToken: "new-access", refreshToken: "new-refresh", expiresAt: 3_620_000 });
  assert.deepEqual(await oauth.status(), { provider: "openai-chatgpt", authMode: "chatgpt", connected: true });
});

test("a terminal refresh rejection quarantines the grant without replay on the next turn", async () => {
  let saved = { accessToken: "expired-access", refreshToken: "rejected-refresh", expiresAt: 0 };
  let attempts = 0;
  const oauth = new ChatGptHostOAuth({
    store: {
      read: async () => saved,
      write: async (value) => { saved = value; },
      withLock: async (fn) => fn()
    },
    fetchImpl: async () => { attempts += 1; return response({ error: "invalid_grant" }, 400); }
  });
  await assert.rejects(oauth.getAccessToken(), { code: "CHATGPT_REFRESH_FAILED" });
  assert.equal(saved.refreshRejected, true);
  assert.equal((await oauth.status()).connected, false);
  await assert.rejects(oauth.getAccessToken(), { code: "CHATGPT_LOGIN_REQUIRED" });
  assert.equal(attempts, 1);
});

test("logout clears only host-owned credentials and cancels a pending device login", async () => {
  let saved = { accessToken: "fake", refreshToken: "fake-refresh", expiresAt: 1_000_000 };
  const store = {
    read: async () => saved,
    write: async (value) => { saved = value; },
    clear: async () => { saved = null; },
    readGeneration: async () => "epoch-0",
    bumpGeneration: async () => "epoch-1",
    withLock: async (fn) => fn()
  };
  const oauth = new ChatGptHostOAuth({ store, fetchImpl: async () => response(device) });
  const { loginId } = await oauth.startDeviceLogin();
  assert.deepEqual(await oauth.logout(), { status: "logged-out" });
  assert.equal(saved, null);
  await assert.rejects(oauth.pollDeviceLogin(loginId), { code: "CHATGPT_LOGIN_EXPIRED" });
  assert.deepEqual(await oauth.status(), { provider: "openai-chatgpt", authMode: "chatgpt", connected: false });
});

test("oversized OAuth response is cancelled before buffering its remainder", async () => {
  let cancelled = false;
  let controller;
  const body = new ReadableStream({
    start(value) { controller = value; value.enqueue(Buffer.alloc(17 * 1024, 120)); },
    cancel() { cancelled = true; }
  });
  const timer = setTimeout(() => { if (!cancelled) controller.close(); }, 50);
  try {
    const oauth = new ChatGptHostOAuth({
      store: { read: async () => null, write: async () => {}, readGeneration: async () => "epoch-0" },
      fetchImpl: async () => new Response(body, { status: 200 })
    });
    await assert.rejects(oauth.startDeviceLogin(), { code: "CHATGPT_DEVICE_AUTHORIZATION_PROTOCOL" });
    assert.equal(cancelled, true);
  } finally { clearTimeout(timer); }
});

test("logout by another process revokes a pending device login before it can persist credentials", async () => {
  let epoch = "epoch-0";
  let saved = null;
  let time = 0;
  const store = {
    read: async () => saved,
    write: async (value) => { saved = value; },
    clear: async () => { saved = null; },
    readGeneration: async () => epoch,
    bumpGeneration: async () => { epoch = "epoch-1"; },
    withLock: async (fn) => fn()
  };
  const first = new ChatGptHostOAuth({
    store, clock: () => time,
    fetchImpl: async (url) => url.endsWith("/usercode") ? response(device)
      : url.endsWith("/deviceauth/token") ? response({ authorization_code: "fake-code", code_verifier: "fake-verifier" })
        : response({ access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 3600 })
  });
  const second = new ChatGptHostOAuth({ store, fetchImpl: async () => { throw new Error("unexpected network"); } });
  const { loginId } = await first.startDeviceLogin();
  await second.logout();
  time = 5_000;
  await assert.rejects(first.pollDeviceLogin(loginId), { code: "CHATGPT_LOGIN_EXPIRED" });
  assert.equal(saved, null);
});
