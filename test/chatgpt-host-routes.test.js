import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { handleChatGptHostOAuthRoute } from "../src/chatgpt-host-routes.js";

test("host-owned OAuth admin routes require explicit owner bearer and return only closed status fields", async () => {
  const actions = [];
  const oauth = {
    status: async () => ({ connected: true, refreshToken: "must-not-leak", accountId: "private" }),
    listModels: async () => ["gpt-5.5"],
    startDeviceLogin: async () => {
      actions.push("login");
      return { type: "chatgptDeviceCode", loginId: "a".repeat(32), userCode: "CODE", verificationUrl: "https://auth.openai.com/codex/device", refreshToken: "must-not-leak" };
    },
    pollDeviceLogin: async (id) => { actions.push(id); return { status: "failed", providerState: "upstream_rate_limited", accessToken: "must-not-leak" }; },
    logout: async () => { actions.push("logout"); return { status: "logged-out", refreshToken: "must-not-leak" }; }
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (!(await handleChatGptHostOAuthRoute({ req, res, url, oauth, authToken: "owner-example", allowLogin: true, interactiveOwner: true }))) {
      res.writeHead(404); res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/providers/openai-chatgpt`;
  try {
    assert.equal((await fetch(`${base}/status`)).status, 401);
    assert.equal((await fetch(`${base}/login`, { method: "POST", headers: { Cookie: "openagi_token=owner-example" }, body: JSON.stringify({ mode: "device" }) })).status, 401);
    assert.equal((await fetch(`${base}/status?token=owner-example`, { headers: { authorization: "Bearer owner-example" } })).status, 401);
    assert.deepEqual(actions, []);
    const auth = { authorization: "Bearer owner-example" };
    const status = await (await fetch(`${base}/status`, { headers: auth })).json();
    assert.deepEqual(status, { provider: "openai-chatgpt", connected: true, authMode: "chatgpt" });
    assert.deepEqual(await (await fetch(`${base}/models`, { headers: auth })).json(), { models: ["gpt-5.5"] });
    assert.equal((await fetch(`${base}/models`)).status, 401);
    const login = await (await fetch(`${base}/login`, { method: "POST", headers: auth, body: JSON.stringify({ mode: "device" }) })).json();
    assert.deepEqual(login, { type: "chatgptDeviceCode", loginId: "a".repeat(32), userCode: "CODE", verificationUrl: "https://auth.openai.com/codex/device" });
    assert.deepEqual(await (await fetch(`${base}/login/${"a".repeat(32)}/poll`, { method: "POST", headers: auth })).json(), { status: "failed", providerState: "upstream_rate_limited" });
    assert.deepEqual(await (await fetch(`${base}/logout`, { method: "POST", headers: auth })).json(), { status: "logged-out" });
    assert.deepEqual(actions, ["login", "a".repeat(32), "logout"]);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("host-owned OAuth admin routes reject a bearer lacking server-derived loopback owner authority", async () => {
  let calls = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    await handleChatGptHostOAuthRoute({ req, res, url, authToken: "owner-example", allowLogin: true,
      interactiveOwner: false,
      oauth: { status: async () => { calls += 1; return { connected: true }; } } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/admin/providers/openai-chatgpt/status`, {
      headers: { authorization: "Bearer owner-example" }
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "owner-loopback-required" });
    assert.equal(calls, 0);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("production-default device login refuses before qualification, even for an authenticated owner", async () => {
  let attempts = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    await handleChatGptHostOAuthRoute({ req, res, url, authToken: "owner-example", interactiveOwner: true, oauth: {
      startDeviceLogin: async () => { attempts += 1; throw new Error("must not run"); }
    } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/admin/providers/openai-chatgpt/login`;
    const result = await fetch(url, { method: "POST", headers: { authorization: "Bearer owner-example" }, body: JSON.stringify({ mode: "device" }) });
    assert.equal(result.status, 409);
    assert.deepEqual(await result.json(), { error: "chatgpt-not-qualified" });
    assert.equal(attempts, 0);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("device-login startup failures expose a fixed safe diagnostic state", async () => {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    await handleChatGptHostOAuthRoute({ req, res, url, authToken: "owner-example", allowLogin: true, interactiveOwner: true, oauth: {
      startDeviceLogin: async () => {
        throw Object.assign(new Error("private upstream detail"), { code: "CHATGPT_DEVICE_AUTHORIZATION_REJECTED" });
      }
    } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/admin/providers/openai-chatgpt/login`;
    const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer owner-example" }, body: JSON.stringify({ mode: "device" }) });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.deepEqual(body, { error: "chatgpt-unavailable", providerState: "device_authorization_rejected" });
    assert.equal(JSON.stringify(body).includes("private"), false);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
