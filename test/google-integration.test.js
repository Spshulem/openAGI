import test from "node:test";
import assert from "node:assert/strict";
import { GoogleClient, registerGoogleTools, emailRaw, validateWindow } from "../src/integrations/google.js";
import { ToolRegistry } from "../src/tool-registry.js";

const env = () => ({ GOOGLE_CLIENT_ID: "fixture-client", GOOGLE_CLIENT_SECRET: "fixture-secret", GOOGLE_REFRESH_TOKEN: "fixture-refresh" });
test("Google OAuth uses PKCE, expires state, rejects replays and stores only offline credentials", async () => {
  let now = Date.now(), saved;
  const requests = [];
  const client = new GoogleClient({ env: env(), now: () => now, saveCredentials: values => { saved = values; }, fetchImpl: async (url, init) => { requests.push({ url, body: init.body }); return Response.json({ access_token: "fixture-access", refresh_token: "new-fixture-refresh", expires_in: 3600 }); } });
  const { url } = client.begin("http://127.0.0.1:43210/integrations/google/callback");
  const consent = new URL(url), state = consent.searchParams.get("state");
  assert.equal(consent.searchParams.get("code_challenge_method"), "S256");
  assert.equal(consent.searchParams.get("access_type"), "offline");
  await assert.rejects(client.finish({ state: "forged", code: "code" }), /state/);
  assert.deepEqual(await client.finish({ state, code: "fixture-code" }), { connected: true });
  assert.equal(requests[0].body.get("code_verifier").length > 30, true);
  assert.deepEqual(saved, { GOOGLE_REFRESH_TOKEN: "new-fixture-refresh" });
  assert.equal(JSON.stringify(client.status()).includes("fixture"), false);
  await assert.rejects(client.finish({ state, code: "fixture-code" }), /state/);
  const expired = new URL(client.begin("https://agent.example/integrations/google/callback").url).searchParams.get("state");
  now += 600001;
  await assert.rejects(client.finish({ state: expired, code: "fixture-code" }), /expired/);
  assert.throws(() => client.begin("http://agent.example/integrations/google/callback"), /HTTPS/);
});
test("concurrent Google reads share one refresh; writes are never retried", async () => {
  let refreshes = 0, writes = 0;
  const client = new GoogleClient({ env: env(), fetchImpl: async (url, init) => {
    if (String(url).includes("oauth2")) { refreshes++; return Response.json({ access_token: "fixture-access", expires_in: 3600 }); }
    assert.equal(init.headers.authorization, "Bearer fixture-access");
    if (init.method === "POST") { writes++; return new Response("private provider error fixture-secret", { status: 503 }); }
    return Response.json({ messages: [] });
  } });
  await Promise.all([client.request("gmail", "messages"), client.request("gmail", "messages")]);
  assert.equal(refreshes, 1);
  await assert.rejects(client.request("gmail", "messages/send", { method: "POST", body: {} }), error => !error.message.includes("fixture-secret") && /Check Gmail/.test(error.message));
  assert.equal(writes, 1);
});
test("a superseded refresh cannot overwrite a reconnected account or authorize its pending write", async () => {
  let releaseOld, oldStarted, writes = 0;
  const started = new Promise(resolve => { oldStarted = resolve; });
  const oldResponse = new Promise(resolve => { releaseOld = resolve; });
  const settings = env();
  const client = new GoogleClient({ env: settings, saveCredentials() {}, fetchImpl: async (url, init) => {
    if (String(url).includes("oauth2")) {
      if (init.body.get("grant_type") === "refresh_token") { oldStarted(); return oldResponse; }
      return Response.json({ access_token: "new-account-access", refresh_token: "new-account-refresh", expires_in: 3600 });
    }
    writes++;
    assert.equal(init.headers.authorization, "Bearer new-account-access");
    return Response.json({ id: "new-account-message" });
  } });
  const pendingWrite = assert.rejects(client.request("gmail", "messages/send", { method: "POST", body: {} }), /credentials changed/i);
  await started;
  const state = new URL(client.begin("https://fixture.example/integrations/google/callback").url).searchParams.get("state");
  await client.finish({ state, code: "new-account-code" });
  releaseOld(Response.json({ access_token: "old-account-access", expires_in: 3600 }));
  await pendingWrite;
  assert.equal(writes, 0);
  assert.equal(await client.accessToken(), "new-account-access");
  await client.request("gmail", "messages/send", { method: "POST", body: {} });
  assert.equal(writes, 1);
});
test("new credentials start their own refresh and obsolete completion cannot clear it", async () => {
  const releases = [], requests = [], settings = env();
  const client = new GoogleClient({ env: settings, fetchImpl: async (_url, init) => {
    requests.push(init.body.get("refresh_token"));
    return new Promise(resolve => releases.push(resolve));
  } });
  const obsolete = assert.rejects(client.accessToken(), /credentials changed/i);
  settings.GOOGLE_REFRESH_TOKEN = "current-account-refresh";
  const current = client.accessToken();
  releases[0](Response.json({ access_token: "obsolete-access", expires_in: 3600 }));
  await obsolete;
  const alsoCurrent = client.accessToken();
  assert.deepEqual(requests, ["fixture-refresh", "current-account-refresh"]);
  releases[1](Response.json({ access_token: "current-access", expires_in: 3600 }));
  assert.deepEqual(await Promise.all([current, alsoCurrent]), ["current-access", "current-access"]);
});
test("credential invalidation rejects an old refresh even when the same grant is reconnected", async () => {
  const releases = [];
  const client = new GoogleClient({ env: env(), fetchImpl: async () => new Promise(resolve => releases.push(resolve)) });
  const obsolete = assert.rejects(client.accessToken(), /credentials changed/i);
  client.credentialsChanged();
  const current = client.accessToken();
  releases[0](Response.json({ access_token: "obsolete-access", expires_in: 3600 }));
  await obsolete;
  releases[1](Response.json({ access_token: "current-access", expires_in: 3600 }));
  assert.equal(await current, "current-access");
  assert.equal(await client.accessToken(), "current-access");
});
test("email drafts remain drafts, sends queue for approval, and approved sends use exact content", async () => {
  const calls = [], queued = [];
  const registry = new ToolRegistry();
  registry.bindPendingActions({ enqueue(action) { queued.push(action); return { id: "approval-fixture", summary: action.summary }; } });
  registerGoogleTools(registry, { async request(service, resource, options) { calls.push({ service, resource, options }); return { id: "fixture-result", message: { id: "fixture-message" } }; } });
  const args = { to: ["partner@example.com"], subject: "Fixture café", body: "The exact reviewed body." };
  const draft = await registry.invoke("gmail_create_draft", args, { __confirmed: true });
  assert.equal(draft.result.status, "draft"); assert.equal(draft.result.sent, false);
  assert.equal(calls[0].resource, "drafts");
  const pending = await registry.invoke("gmail_send_message", args, {});
  assert.equal(pending.result.status, "awaiting_confirmation"); assert.equal(calls.length, 1);
  assert.deepEqual(queued[0].args, args);
  const sent = await registry.invoke("gmail_send_message", args, { __confirmed: true });
  assert.equal(sent.result.status, "sent"); assert.equal(calls[1].resource, "messages/send");
  const raw = Buffer.from(calls[1].options.body.raw, "base64url").toString();
  assert.match(raw, /To: partner@example.com/);
  assert.match(raw, new RegExp(Buffer.from(args.body).toString("base64").replace(/[+]/g, "\\+")));
  for (const changed of [{ subject: "Title\r\nBcc: stranger@example.com" }, { to: ["friend@example.com\r\nBcc: stranger@example.com"] }]) assert.throws(() => emailRaw({ ...args, ...changed }));
});
test("Gmail search/read decode plain-text MIME and calendar invitations use the approval gate", async () => {
  const registry = new ToolRegistry(), calls = [];
  registry.bindPendingActions({ enqueue(action) { return { id: "fixture", summary: action.summary }; } });
  registerGoogleTools(registry, { async request(service, resource, options) {
    calls.push({ service, resource, options });
    if (resource === "messages") return { messages: [{ id: "abc123" }], nextPageToken: "next-fixture" };
    if (resource.startsWith("messages/")) return { id: "abc123", payload: { mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: Buffer.from("Fixture email text").toString("base64url") } }] } };
    return { id: "event-fixture" };
  } });
  assert.equal((await registry.invoke("gmail_search", { query: "is:unread" })).result.messages[0].id, "abc123");
  assert.equal((await registry.invoke("gmail_read", { messageId: "abc123" })).result.text, "Fixture email text");
  assert.equal((await registry.invoke("gmail_read", { messageId: "../profile" })).ok, false);
  const event = { summary: "Fixture meeting", start: "2026-11-01T09:00:00-08:00", end: "2026-11-01T10:00:00-08:00", attendees: ["partner@example.com"] };
  assert.equal((await registry.invoke("google_calendar_create_event", event)).result.status, "awaiting_confirmation");
  assert.equal(calls.filter(call => call.service === "calendar").length, 0);
  await registry.invoke("google_calendar_create_event", event, { __confirmed: true });
  assert.equal(calls.at(-1).options.query.sendUpdates, "all");
  assert.equal(calls.at(-1).options.body.attendees[0].email, "partner@example.com");
  assert.throws(() => validateWindow("2026-11-01T09:00:00", event.end));
  assert.throws(() => validateWindow(event.end, event.start));
});
