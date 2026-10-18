import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDurableRuntime } from "../src/abi-runtime.js";
import { createHostedInterface } from "../src/hosted-interface.js";
import { GoogleClient } from "../src/integrations/google.js";
import { HashBagEmbedder } from "../src/embeddings.js";
import { messagingEnv, inbound, encodeInbound, signedHeaders, acceptedResponse } from "./fixtures/partner-messaging.js";
import { MESSAGING_CONFIG_KEYS } from "../src/integrations/messaging-config.js";

test("hosted companion routes enforce owner auth and CSRF while webhooks self-authenticate", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "companion-routes-"));
  const previous = process.env.OPENAGI_AUTH_TOKEN, previousPublicUrl = process.env.OPENAGI_PUBLIC_URL;
  const previousMessaging = Object.fromEntries(MESSAGING_CONFIG_KEYS.map(key => [key, process.env[key]]));
  delete process.env.OPENAGI_PUBLIC_URL;
  process.env.OPENAGI_AUTH_TOKEN = "owner-fixture-token";
  const env = { ...messagingEnv(), SENDBLUE_API_KEY: "fixture-key", SENDBLUE_API_SECRET: "fixture-secret", SENDBLUE_WEBHOOK_SECRET: "fixture-hook", SENDBLUE_FROM_NUMBER: "+15555550100", GOOGLE_CLIENT_ID: "client-fixture", GOOGLE_CLIENT_SECRET: "secret-fixture" };
  const runtime = createDurableRuntime({ dataDir: dir, autoConnectMcp: false, skills: false,
    modelProvider: { isConfigured: () => true, async generate() { return { text: "Partner fixture answer" }; } }, vectorStoreOptions: { embedder: new HashBagEmbedder() } });
  runtime.google = new GoogleClient({ env, fetchImpl: () => { throw Error("no live Google calls"); } });
  let sends = 0;
  const providerSends = [];
  const app = createHostedInterface(runtime, { dataDir: dir, host: "127.0.0.1", port: 0, tickerMs: 0, companionEnv: env,
    messagingFetch: async (url) => { providerSends.push(url); return acceptedResponse(url.includes("linqapp") ? "linq" : url.includes("twilio") ? "twilio" : url.includes("telnyx") ? "telnyx" : "surge"); },
    sendblueFetch: async () => { sends++; return Response.json({ status: "QUEUED", message_handle: "sent-fixture" }); } });
  t.after(async () => {
    await app.close();
    await runtime.sessionIndex?.rebuildPromise;
    runtime.observations?.db?.close(); runtime.vectorStore?.db?.close(); runtime.sessionIndex?.db?.close();
    if (previous === undefined) delete process.env.OPENAGI_AUTH_TOKEN; else process.env.OPENAGI_AUTH_TOKEN = previous;
    if (previousPublicUrl === undefined) delete process.env.OPENAGI_PUBLIC_URL; else process.env.OPENAGI_PUBLIC_URL = previousPublicUrl;
    for (const [key, value] of Object.entries(previousMessaging)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const { url } = await app.listen();
  const owner = { authorization: "Bearer owner-fixture-token", "content-type": "application/json" };
  for (const route of ["/connections", "/connections/config"]) assert.equal((await fetch(url + route, { redirect: "manual" })).status, 401);
  assert.equal((await fetch(url + "/sharing/contacts", { method: "POST", headers: { ...owner, origin: "https://stranger.example" }, body: JSON.stringify({ number: "+15555550101" }) })).status, 403);
  assert.equal((await fetch(url + "/sharing/contacts", { method: "POST", headers: owner, body: JSON.stringify({ number: "+15555550101", name: "Fixture partner" }) })).status, 200);
  const status = await (await fetch(url + "/connections/config", { headers: owner })).json();
  assert.equal(status.sharing.contacts.length, 1);
  assert.equal(JSON.stringify(status).includes("fixture-secret"), false);
  assert.equal((await fetch(url + "/channels/sendblue/webhook", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  const body = { is_outbound: false, from_number: "+15555550101", to_number: "+15555550100", message_handle: "message-fixture", content: "Hi" };
  const response = await fetch(url + "/channels/sendblue/webhook", { method: "POST", headers: { "content-type": "application/json", "sb-signing-secret": "fixture-hook" }, body: JSON.stringify(body) });
  assert.equal(response.status, 200); assert.equal((await response.json()).accepted, true); assert.equal(sends, 1);
  assert.equal(runtime.agentHost.store.listSessions().length, 0);
  for (const provider of ["linq", "twilio", "telnyx", "surge"]) {
    const route = `/channels/${provider}/webhook` + (provider === "twilio" ? "?encoded=%2B%20&extra=a+b" : "");
    const raw = encodeInbound(inbound(provider)), headers = signedHeaders(provider, raw, { url: url + route });
    assert.equal((await fetch(url + route, { method: "POST", headers: { "content-type": headers["content-type"] }, body: raw })).status, 401);
    const received = await fetch(url + route, { method: "POST", headers, body: raw });
    assert.equal(received.status, provider === "twilio" ? 200 : 202);
    if (provider === "twilio") { assert.match(received.headers.get("content-type"), /xml/); assert.equal(await received.text(), "<Response/>"); }
    else assert.equal((await received.json()).queued, true);
    await runtime.channels[provider].drain();
    const duplicate = await fetch(url + route, { method: "POST", headers, body: raw });
    assert.equal(duplicate.status, provider === "twilio" ? 200 : 202);
    assert.equal((await fetch(url + route, { method: "POST", headers, body: encodeInbound(inbound(provider, { text: "tampered" })) })).status, 401);
    assert.equal((await fetch(url + route, { method: "POST", headers: { ...headers, "content-type": "text/plain" }, body: raw })).status, 415);
    if (provider === "twilio") {
      const forged = signedHeaders(provider, raw, { url: "https://forged.example" + route });
      assert.equal((await fetch(url + route, { method: "POST", headers: { ...forged, "x-forwarded-host": "forged.example", "x-forwarded-proto": "https" }, body: raw })).status, 401);
    } else {
      const malformed = Buffer.from("{not-json");
      assert.equal((await fetch(url + route, { method: "POST", headers: signedHeaders(provider, malformed), body: malformed })).status, 400);
      const stale = signedHeaders(provider, raw, { timestamp: String(Math.floor(Date.now() / 1000) - 600) });
      assert.equal((await fetch(url + route, { method: "POST", headers: stale, body: raw })).status, 401);
    }
  }
  assert.equal(providerSends.length, 4);
  assert.equal(runtime.agentHost.store.listSessions().length, 0);
  assert.equal((await fetch(url + "/sharing/retry", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await fetch(url + "/sharing/retry", { method: "POST", headers: { ...owner, origin: "https://stranger.example" }, body: "{}" })).status, 403);
  assert.equal((await fetch(url + "/sharing/retry", { method: "POST", headers: owner, body: "{}" })).status, 200);
  const saved = await fetch(url + "/connections/config", { method: "POST", headers: owner, body: JSON.stringify(messagingEnv()) });
  assert.equal(saved.status, 200);
  const persisted = fs.readFileSync(path.join(dir, ".env"), "utf8");
  for (const key of MESSAGING_CONFIG_KEYS) assert.ok(persisted.includes(key + "="));
  assert.equal(fs.statSync(path.join(dir, ".env")).mode & 0o777, 0o600);
  const refreshed = await (await fetch(url + "/connections/config", { headers: owner })).json();
  assert.equal(refreshed.configured.TWILIO_AUTH_TOKEN, true);
  assert.equal(JSON.stringify(refreshed).includes(env.TWILIO_AUTH_TOKEN), false);
  assert.equal((await fetch(url + "/webhooks/pebble", { method: "POST", body: "unsigned" })).status, 401);
  assert.equal((await fetch(url + "/integrations/google/callback?state=forged&code=fixture")).status, 400);
  assert.equal(runtime.google.flows.size, 0);
  const pageResponse = await fetch(url + "/connections", { headers: owner });
  assert.equal(pageResponse.headers.get("x-frame-options"), "DENY");
  assert.equal(pageResponse.headers.get("x-content-type-options"), "nosniff");
  assert.equal(pageResponse.headers.get("cache-control"), "no-store");
  assert.match(pageResponse.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  const page = await pageResponse.text();
  const nonce = page.match(/<script nonce="([^"]+)"/)[1];
  assert.ok(pageResponse.headers.get("content-security-policy").includes(`script-src 'nonce-${nonce}'`));
  assert.match(page, /Partner messaging/); assert.match(page, /Connect Google/); assert.match(page, /Pebble Index/);
  assert.doesNotThrow(() => new Function(page.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)[1]));
  const tokenPage = await fetch(url + "/connections?token=owner-fixture-token");
  assert.match(tokenPage.headers.get("set-cookie"), /openagi_token=/);
  assert.notEqual((await tokenPage.text()).match(/<script nonce="([^"]+)"/)[1], nonce);
  const connected = await (await fetch(url + "/integrations/status", { headers: owner })).json();
  for (const id of ["google", "sendblue", "linq", "twilio", "telnyx", "surge", "pebble-index"]) assert.equal(connected.integrations.some(item => item.id === id), true);
  delete process.env.OPENAGI_AUTH_TOKEN;
  const localPage = await fetch(url + "/connections");
  assert.equal(localPage.status, 200);
  assert.equal(localPage.headers.get("x-frame-options"), "DENY");
  assert.match(localPage.headers.get("content-security-policy"), /script-src 'nonce-/);
});
