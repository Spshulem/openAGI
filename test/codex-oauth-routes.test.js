import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultRuntime, createHostedInterface } from "../src/index.js";

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openagi-codex-routes-"));
}

test("Codex administrative routes require configured owner auth and reject query-token access", async () => {
  const dataDir = tempDataDir();
  const calls = [];
  const codexProvider = {
    status: () => ({ provider: "openai-codex", readiness: "login-required", preLoginQualified: true, fallbackProvider: "openai", fallbackConfigured: true, secret: undefined }),
    async startLogin(options) {
      calls.push(["login", options]);
      return { type: "chatgptDeviceCode", loginId: "login-1", userCode: "ABCD", verificationUrl: "https://auth.openai.com/codex/device" };
    },
    async cancelLogin(loginId) { calls.push(["cancel", loginId]); return { status: "canceled", accessToken: "must-not-leave-server" }; },
    async logout() { calls.push(["logout"]); return { status: "logged-out", refreshToken: "must-not-leave-server" }; },
    async listModels() { return [{ id: "gpt-test", displayName: "GPT Test" }]; },
    async getLimits() {
      return {
        quota: {
          accountId: "must-not-leave-server",
          accessToken: "must-not-leave-server",
          ordinaryUsageAllowed: true,
          rateLimits: {
            planType: "plus",
            primary: { usedPercent: 25, resetsAt: 1234, windowDurationMins: 300 },
            secondary: null,
            credits: { balance: 4.5, hasCredits: true, unlimited: false },
            unknown: { nestedSecret: "must-not-leave-server" }
          },
          rateLimitsByLimitId: {}
        }
      };
    },
    async inspectReadiness() {
      calls.push(["qualification-check"]);
      return {
        provider: "openai-codex",
        readiness: "isolation-failed",
        reason: "effective-feature-disagreement",
        binarySha256: "a".repeat(64)
      };
    }
  };
  const app = createHostedInterface(createDefaultRuntime({ dataDir }), {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    authToken: "owner-secret",
    codexProvider,
    tickerMs: 0
  });
  const { url } = await app.listen();

  try {
    const anonymous = await fetch(`${url}/admin/providers/openai-codex/status`);
    assert.equal(anonymous.status, 401);

    const queryToken = await fetch(`${url}/admin/providers/openai-codex/status?token=owner-secret`, { redirect: "manual" });
    assert.equal(queryToken.status, 401);

    const status = await fetch(`${url}/admin/providers/openai-codex/status`, {
      headers: { authorization: "Bearer owner-secret" }
    });
    assert.equal(status.status, 200);
    assert.equal(status.headers.get("cache-control"), "no-store");
    assert.deepEqual(await status.json(), {
      provider: "openai-codex",
      readiness: "login-required",
      fallbackProvider: "openai",
      fallbackConfigured: true
    });

    const unsafe = await fetch(`${url}/admin/providers/openai-codex/login`, {
      method: "POST",
      headers: { authorization: "Bearer owner-secret", "content-type": "application/json" },
      body: JSON.stringify({ mode: "chatgptAuthTokens", accessToken: "must-not-pass" })
    });
    assert.equal(unsafe.status, 400);
    assert.equal(calls.length, 0);

    const malformed = await fetch(`${url}/admin/providers/openai-codex/login`, {
      method: "POST",
      headers: { authorization: "Bearer owner-secret", "content-type": "application/json" },
      body: "{"
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { error: "invalid-request" });
    assert.equal(calls.length, 0);

    codexProvider.status = () => ({ preLoginQualified: false });
    const blocked = await fetch(`${url}/admin/providers/openai-codex/login`, {
      method: "POST",
      headers: { authorization: "Bearer owner-secret", "content-type": "application/json" },
      body: JSON.stringify({ mode: "device" })
    });
    assert.equal(blocked.status, 503);
    assert.deepEqual(await blocked.json(), { error: "codex-prelogin-required" });
    assert.equal(calls.length, 0);
    codexProvider.status = () => ({ preLoginQualified: true });

    const login = await fetch(`${url}/admin/providers/openai-codex/login`, {
      method: "POST",
      headers: { authorization: "Bearer owner-secret", "content-type": "application/json" },
      body: JSON.stringify({ mode: "device" })
    });
    assert.equal(login.status, 200);
    assert.deepEqual(await login.json(), {
      type: "chatgptDeviceCode",
      loginId: "login-1",
      userCode: "ABCD",
      verificationUrl: "https://auth.openai.com/codex/device"
    });
    assert.deepEqual(calls, [["login", { mode: "device" }]]);

    codexProvider.startLogin = async () => ({
      type: "chatgptDeviceCode", loginId: "login-2", userCode: "ABCD",
      verificationUrl: "https://login.attacker.test/device"
    });
    const phishing = await fetch(`${url}/admin/providers/openai-codex/login`, {
      method: "POST",
      headers: { authorization: "Bearer owner-secret", "content-type": "application/json" },
      body: JSON.stringify({ mode: "device" })
    });
    assert.equal(phishing.status, 503);
    assert.doesNotMatch(JSON.stringify(await phishing.json()), /login\.attacker\.test/);

    const cancel = await fetch(`${url}/admin/providers/openai-codex/login/login-1/cancel`, {
      method: "POST",
      headers: { authorization: "Bearer owner-secret" }
    });
    assert.equal(cancel.status, 200);
    assert.deepEqual(await cancel.json(), { status: "canceled" });

    const logout = await fetch(`${url}/admin/providers/openai-codex/logout`, {
      method: "POST",
      headers: { authorization: "Bearer owner-secret" }
    });
    assert.equal(logout.status, 200);
    assert.deepEqual(await logout.json(), { status: "logged-out" });

    const limits = await fetch(`${url}/admin/providers/openai-codex/limits`, {
      headers: { authorization: "Bearer owner-secret" }
    });
    assert.equal(limits.status, 200);
    assert.deepEqual(await limits.json(), {
      quota: {
        ordinaryUsageAllowed: true,
        rateLimits: {
          planType: "plus",
          primary: { usedPercent: 25, resetsAt: 1234, windowDurationMins: 300 },
          secondary: null,
          credits: { balance: 4.5, hasCredits: true, unlimited: false }
        },
        rateLimitsByLimitId: {}
      }
    });

    const qualification = await fetch(`${url}/admin/providers/openai-codex/qualification/check`, {
      method: "POST",
      headers: { authorization: "Bearer owner-secret", "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(qualification.status, 200);
    assert.deepEqual(await qualification.json(), {
      provider: "openai-codex",
      readiness: "isolation-failed",
      reason: "effective-feature-disagreement",
      binarySha256: "a".repeat(64)
    });
    assert.deepEqual(calls, [
      ["login", { mode: "device" }],
      ["cancel", "login-1"],
      ["logout"],
      ["qualification-check"]
    ]);
  } finally {
    await app.close();
  }
});
