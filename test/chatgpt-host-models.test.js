import assert from "node:assert/strict";
import test from "node:test";
import { ChatGptHostOAuth } from "../src/chatgpt-host-oauth.js";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { "content-type": "application/json" } });

test("ChatGPT models come from the current account catalogue, not a public-API or offline fallback", async () => {
  const requests = [];
  const oauth = new ChatGptHostOAuth({
    store: { read: async () => ({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: Date.now() + 3600_000 }), write: async () => {} },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return url.includes("99.0.0") ? json({ models: [
        { slug: "gpt-6-sol", visibility: "list", priority: 2, supported_in_api: false },
        { slug: "hidden-model", visibility: "hide", priority: 1 },
        { slug: "gpt-5.5", visibility: "list", priority: 0 }
      ] }) : json({ models: [{ slug: "legacy" }] });
    }
  });
  assert.deepEqual(await oauth.listModels(), ["gpt-5.5", "gpt-6-sol"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://chatgpt.com/backend-api/codex/models?client_version=99.0.0");
  assert.equal(requests[0].init.headers.authorization, "Bearer synthetic-access");
  assert.equal(requests[0].init.redirect, "error");
});

test("empty newest catalogue tries the legacy version, but empty account catalogue fails closed", async () => {
  let calls = 0;
  const oauth = new ChatGptHostOAuth({
    store: { read: async () => ({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: Date.now() + 3600_000 }), write: async () => {} },
    fetchImpl: async () => { calls += 1; return json({ models: calls === 2 ? [{ slug: "gpt-5.5" }] : [] }); }
  });
  assert.deepEqual(await oauth.listModels(), ["gpt-5.5"]);
  assert.equal(calls, 2);
  await assert.rejects(oauth.listModels(), { code: "CHATGPT_CATALOG_UNAVAILABLE" });
});

test("account catalogues larger than 256 KiB can be parsed without accepting unbounded responses", async () => {
  const store = { read: async () => ({ accessToken: "synthetic-access", refreshToken: "synthetic-refresh",
    expiresAt: Date.now() + 3600_000 }), write: async () => {} };
  const oauth = new ChatGptHostOAuth({ store, fetchImpl: async () => json({ models: [
    { slug: "gpt-5.5", visibility: "list", description: "x".repeat(350_000) }
  ] }) });
  assert.deepEqual(await oauth.listModels(), ["gpt-5.5"]);
  let cancelled = false;
  const tooLarge = new ChatGptHostOAuth({ store, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; }
  }), { headers: { "content-type": "application/json" } }) });
  await assert.rejects(tooLarge.listModels(), { code: "CHATGPT_PROTOCOL" });
  assert.equal(cancelled, true);
});
