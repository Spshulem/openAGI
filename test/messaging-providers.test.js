import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { PartnerSharing } from "../src/partner-sharing.js";
import { TEXT_CHANNELS } from "../src/integrations/messaging.js";
import { verifyTwilioWebhook } from "../src/integrations/messaging-security.js";
import { messagingEnv, inbound, encodeInbound, signedHeaders, acceptedResponse, agentNumber, partnerNumber } from "./fixtures/partner-messaging.js";

function fixture(t, provider, { generate, fetchImpl } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `messaging-${provider}-`));
  const env = messagingEnv(), sends = [];
  let turns = 0;
  const sharing = new PartnerSharing({ dir: path.join(dir, "sharing"), modelProvider: { async generate(args) {
    turns++;
    assert.equal(args.context.channel, provider);
    assert.deepEqual(args.tools.map(tool => tool.name).sort(), ["recall", "remember"]);
    assert.equal(args.context.runtime, undefined);
    return generate ? generate(args) : { text: "Fixture answer" };
  } } });
  sharing.addContact({ number: partnerNumber });
  const channel = new TEXT_CHANNELS[provider]({ sharing, dir: path.join(dir, provider), env, fetchImpl: fetchImpl ?? (async (url, init) => { sends.push({ url, ...init }); return acceptedResponse(provider); }) });
  t.after(async () => { await channel.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { channel, sharing, env, sends, get turns() { return turns; } };
}

for (const provider of Object.keys(TEXT_CHANNELS)) {
  test(`${provider}: signatures authenticate original bytes and fail closed`, t => {
    const f = fixture(t, provider), raw = encodeInbound(inbound(provider));
    const headers = signedHeaders(provider, raw);
    assert.equal(f.channel.verify(headers, raw, "https://fixture.example/channels/twilio/webhook"), true);
    assert.equal(f.channel.verify(headers, Buffer.concat([raw, Buffer.from(" ")]), "https://fixture.example/channels/twilio/webhook"), false);
    assert.equal(f.channel.verify({}, raw, "https://fixture.example/channels/twilio/webhook"), false);
    assert.equal(f.channel.verify(headers, encodeInbound(inbound(provider, { text: "tampered" })), "https://fixture.example/channels/twilio/webhook"), false);
    if (provider !== "twilio") {
      for (const offset of [-301, 301]) assert.equal(f.channel.verify(signedHeaders(provider, raw, { timestamp: String(Math.floor(Date.now() / 1000) + offset) }), raw), false);
      const field = provider === "telnyx" ? "TELNYX_PUBLIC_KEY" : `${provider.toUpperCase()}_WEBHOOK_SECRET`;
      f.env[field] = "malformed";
      assert.equal(f.channel.verify(headers, raw), false);
    } else assert.equal(f.channel.verify(headers, raw, "https://forged.example/channels/twilio/webhook"), false);
    assert.equal(f.turns, 0); assert.equal(f.sends.length, 0);
  });
  test(`${provider}: unknown senders, wrong lines and non-text never run a model`, async t => {
    const f = fixture(t, provider);
    for (const options of [{ number: "+15555550999" }, { line: "+15555550999" }, { text: "" }]) assert.equal(f.channel.handleWebhook(inbound(provider, options)).ignored, true);
    const body = inbound(provider);
    if (provider === "linq") body.data.direction = "outbound";
    if (provider === "twilio") body.set("SmsStatus", "delivered");
    if (provider === "telnyx") body.data.event_type = "message.finalized";
    if (provider === "surge") body.type = "message.delivered";
    assert.equal(f.channel.handleWebhook(body).ignored, true);
    await f.channel.drain();
    assert.equal(f.turns, 0); assert.equal(f.sends.length, 0);
  });
  test(`${provider}: durable enqueue acknowledges before model work, dedupes and sends on the pinned line`, async t => {
    const f = fixture(t, provider), body = inbound(provider);
    assert.equal(f.channel.handleWebhook(body).queued, true);
    assert.equal(f.channel.handleWebhook(body).queued, true);
    assert.equal(f.turns, 0); assert.equal(f.channel.pendingKeys().length, 1);
    await f.channel.drain();
    assert.equal(f.turns, 1); assert.equal(f.sends.length, 1);
    assert.equal(f.channel.status().pending, 0);
    const receipt = JSON.parse(fs.readFileSync(path.join(f.channel.dir, fs.readdirSync(f.channel.dir).find(name => name.endsWith(".json")))));
    assert.equal(receipt.accepted, true);
    assert.equal(receipt.messageId, "accepted-fixture");
    assert.equal(receipt.sendStarted, undefined);
    const request = f.sends[0];
    const sent = provider === "twilio" ? Object.fromEntries(new URLSearchParams(request.body)) : JSON.parse(request.body);
    assert.equal(sent[provider === "twilio" ? "From" : "from"], agentNumber);
    assert.deepEqual(sent[provider === "twilio" ? "To" : "to"], provider === "linq" ? [partnerNumber] : partnerNumber);
    assert.equal(request.redirect, "error");
    assert.equal(provider === "twilio" ? sent.Body : provider === "linq" ? sent.message.parts[0].value : provider === "telnyx" ? sent.text : sent.body, "Fixture answer");
    assert.equal(request.method, "POST");
    const expectedHost = { linq: "api.linqapp.com", twilio: "api.twilio.com", telnyx: "api.telnyx.com", surge: "api.surge.app" }[provider];
    assert.equal(new URL(request.url).hostname, expectedHost);
    assert.equal(new URL(request.url).pathname, { linq: "/api/partner/v3/chats", twilio: `/2010-04-01/Accounts/${f.env.TWILIO_ACCOUNT_SID}/Messages.json`, telnyx: "/v2/messages", surge: "/accounts/acct_fixture/messages" }[provider]);
    const restarted = new TEXT_CHANNELS[provider]({ sharing: f.sharing, env: f.env, dir: f.channel.dir, fetchImpl: () => { throw Error("must not resend"); } });
    assert.equal(restarted.handleWebhook(body).duplicate, true);
    assert.equal(restarted.handleWebhook(body).delivered, undefined);
  });
  test(`${provider}: pending inbound survives a stop before model work`, async t => {
    const f = fixture(t, provider);
    f.channel.schedule = () => {}; // Simulate a process ending after the durable write.
    f.channel.handleWebhook(inbound(provider));
    const restarted = new TEXT_CHANNELS[provider]({ sharing: f.sharing, env: f.env, dir: f.channel.dir, fetchImpl: f.channel.fetchImpl });
    restarted.start(); await restarted.drain();
    assert.equal(f.turns, 1); assert.equal(f.sends.length, 1); assert.equal(restarted.status().pending, 0);
  });
  test(`${provider}: uncertain external sends remain held across retries and restart`, async t => {
    let requests = 0;
    const f = fixture(t, provider, { fetchImpl: async () => { requests++; throw Error("connection lost after write"); } });
    f.channel.handleWebhook(inbound(provider)); await f.channel.drain();
    assert.equal(f.channel.status().requiresReview, 1);
    assert.equal(f.channel.handleWebhook(inbound(provider)).requiresReview, true);
    const restarted = new TEXT_CHANNELS[provider]({ sharing: f.sharing, env: f.env, dir: f.channel.dir, fetchImpl: f.channel.fetchImpl });
    restarted.start(); await restarted.drain();
    assert.equal(requests, 1); assert.equal(f.turns, 1);
  });
  test(`${provider}: revocation during a model turn prevents its reply`, async t => {
    let release, ready;
    const started = new Promise(resolve => { ready = resolve; });
    const hold = new Promise(resolve => { release = resolve; });
    const f = fixture(t, provider, { generate: async () => { ready(); await hold; return { text: "answer" }; } });
    f.channel.handleWebhook(inbound(provider)); await started;
    f.sharing.revoke({ number: partnerNumber }); release(); await f.channel.drain();
    assert.equal(f.sends.length, 0); assert.equal(f.channel.status().pending, 0);
  });
  test(`${provider}: outbound tools cannot contact an unapproved person or unsupported group`, async t => {
    const f = fixture(t, provider);
    await assert.rejects(f.channel.sendMessage("+15555550999", "private"), /not approved/);
    if (provider !== "linq") await assert.rejects(f.channel.sendMessage("group-fixture", "private", { group: true }));
    assert.equal(f.sends.length, 0);
  });
}

test("Twilio validates the published signature vector, unknown fields and repeated form values", () => {
  // https://github.com/twilio/twilio-node/blob/main/spec/validation.spec.js
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const raw = Buffer.from(new URLSearchParams({ CallSid: "CA1234567890ABCDE", Caller: "+14158675309", Digits: "1234", From: "+14158675309", To: "+18005551212" }).toString());
  assert.equal(verifyTwilioWebhook({ "x-twilio-signature": "RSOYDt4T1cUTdK1PDd93/VVr8B8=" }, raw, "12345", url), true);
  assert.equal(verifyTwilioWebhook({ "x-twilio-signature": "IK+Dwps556ElfBT0I3Rgjkr1wJU=" }, Buffer.from("Sid=CA123&SidAccount=AC123&Digits=5678&Digits=1234&Digits=1234"), "12345", url), true);
  const duplicate = Buffer.from("Body=hi&Extra=b&Extra=a&Extra=a");
  const signature = createHmac("sha1", "fixture-token").update(url + "BodyhiExtraaExtrab").digest("base64");
  assert.equal(verifyTwilioWebhook({ "x-twilio-signature": signature }, duplicate, "fixture-token", url), true);
  assert.equal(verifyTwilioWebhook({ "x-twilio-signature": signature }, Buffer.from("Body=hi&Extra=b"), "fixture-token", url), false);
});

test("Standard Webhooks accepts a rotating key signature and rejects changed delivery IDs", t => {
  const f = fixture(t, "surge"), raw = encodeInbound(inbound("surge")), headers = signedHeaders("surge", raw);
  assert.equal(f.channel.verify({ ...headers, "webhook-signature": `v2,ignored v1,${Buffer.alloc(32).toString("base64")} ${headers["webhook-signature"]}` }, raw), true);
  assert.equal(f.channel.verify({ ...headers, "webhook-id": "changed" }, raw), false);
});

test("missing credentials keep the saved reply retryable; validation never marks an ambiguous send", async t => {
  const f = fixture(t, "twilio");
  delete f.env.TWILIO_AUTH_TOKEN;
  f.channel.handleWebhook(inbound("twilio")); await f.channel.drain();
  assert.equal(f.channel.status().failed, 1); assert.equal(f.channel.status().requiresReview, 0);
  assert.equal(f.turns, 1); assert.equal(f.sends.length, 0);
  f.env.TWILIO_AUTH_TOKEN = "repaired-fixture-token";
  f.channel.start(); await f.channel.drain();
  assert.equal(f.turns, 1); assert.equal(f.sends.length, 1); assert.equal(f.channel.status().pending, 0);
});

test("oversized replies are visible as failed before an HTTP send", async t => {
  const f = fixture(t, "twilio", { generate: async () => ({ text: "x".repeat(1601) }) });
  f.channel.handleWebhook(inbound("twilio")); await f.channel.drain();
  f.channel.start(); await f.channel.drain();
  assert.equal(f.turns, 1); assert.equal(f.sends.length, 0); assert.equal(f.channel.status().failed, 1); assert.equal(f.channel.status().requiresReview, 0);
});

test("Linq groups require a provider-specific approval and all current participants", async t => {
  const members = [{ handle: agentNumber, is_me: true, status: "active" }, { handle: partnerNumber, is_me: false, status: "active" }];
  let sends = 0;
  const f = fixture(t, "linq", { fetchImpl: async (url, init) => {
    if (init.method === "POST") { sends++; assert.match(url, /chats\/chat-fixture\/messages$/); return acceptedResponse("linq", { group: true }); }
    return Response.json({ id: "chat-fixture", is_group: true, handles: members });
  } });
  const body = inbound("linq"); body.data.chat.is_group = true;
  f.sharing.addGroup({ groupId: "chat-fixture" });
  assert.equal(f.channel.handleWebhook(body).ignored, true);
  f.sharing.addGroup({ groupId: "chat-fixture", provider: "linq" });
  members.push({ handle: "+15555550999", is_me: false, status: "active" });
  f.channel.handleWebhook(body); await f.channel.drain();
  assert.equal(f.turns, 0); assert.equal(sends, 0);
  members[2].status = "removed";
  body.data.id = "approved-message";
  f.channel.handleWebhook(body); await f.channel.drain();
  assert.equal(f.turns, 1); assert.equal(sends, 1);
  assert.equal(f.channel.status().pending, 0);
  assert.equal(f.channel.status().requiresReview, 0);
  members[2].status = "active";
  await assert.rejects(f.channel.sendMessage("chat-fixture", "private", { group: true }), /membership/);
  assert.equal(sends, 1);
});

test("Linq rechecks group membership after the model, before sending any facts", async t => {
  let reads = 0, sends = 0;
  const members = [{ handle: agentNumber, is_me: true }, { handle: partnerNumber, is_me: false }];
  const f = fixture(t, "linq", { generate: async () => {
    members.push({ handle: "+15555550999", is_me: false }); return { text: "Group-only fact" };
  }, fetchImpl: async (_url, init) => {
    if (init.method === "POST") { sends++; return acceptedResponse("linq", { group: true }); }
    reads++; return Response.json({ id: "chat-fixture", is_group: true, handles: members });
  } });
  f.sharing.addGroup({ groupId: "chat-fixture", provider: "linq" });
  const body = inbound("linq"); body.data.chat.is_group = true;
  f.channel.handleWebhook(body); await f.channel.drain();
  assert.equal(reads, 2); assert.equal(f.turns, 1); assert.equal(sends, 0); assert.equal(f.channel.status().failed, 1);
});

test("Telnyx and Surge reject a different account/profile and multi-recipient payloads", t => {
  const telnyx = fixture(t, "telnyx"), surge = fixture(t, "surge");
  const body = inbound("telnyx"); body.data.payload.messaging_profile_id = "wrong-profile";
  assert.equal(telnyx.channel.handleWebhook(body).ignored, true);
  body.data.payload.messaging_profile_id = "profile-fixture";
  body.data.payload.to.push({ phone_number: "+15555550999" });
  assert.equal(telnyx.channel.handleWebhook(body).ignored, true);
  const other = inbound("surge"); other.account_id = "acct_other";
  assert.equal(surge.channel.handleWebhook(other).ignored, true);
  assert.equal(telnyx.turns + surge.turns, 0);
});
