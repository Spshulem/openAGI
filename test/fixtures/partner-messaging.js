import { createHmac, generateKeyPairSync, sign } from "node:crypto";

export const agentNumber = "+15555550100", partnerNumber = "+15555550101";
const keys = generateKeyPairSync("ed25519");
const secret = Buffer.from("fixture-standard-webhook-key-12345");
export function messagingEnv() {
  return {
    LINQ_API_TOKEN: "fixture-linq-token", LINQ_FROM_NUMBER: agentNumber, LINQ_WEBHOOK_SECRET: `whsec_${secret.toString("base64")}`,
    TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`, TWILIO_AUTH_TOKEN: "fixture-twilio-token", TWILIO_FROM_NUMBER: agentNumber,
    TELNYX_API_KEY: "fixture-telnyx-key", TELNYX_FROM_NUMBER: agentNumber, TELNYX_PUBLIC_KEY: keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"), TELNYX_MESSAGING_PROFILE_ID: "profile-fixture",
    SURGE_API_KEY: "fixture-surge-key", SURGE_ACCOUNT_ID: "acct_fixture", SURGE_FROM_NUMBER: agentNumber, SURGE_WEBHOOK_SECRET: `whsec_${secret.toString("base64")}`
  };
}
export function inbound(provider, { number = partnerNumber, line = agentNumber, id = "message-fixture", text = "Hello" } = {}) {
  if (provider === "linq") return { api_version: "v3", webhook_version: "2026-02-03", event_type: "message.received", data: { id, direction: "inbound", chat: { id: "chat-fixture", is_group: false, owner_handle: { handle: line, is_me: true } }, sender_handle: { handle: number, is_me: false }, parts: [{ type: "text", value: text }], service: "iMessage" } };
  if (provider === "twilio") return new URLSearchParams({ AccountSid: `AC${"a".repeat(32)}`, MessageSid: id, From: number, To: line, Body: text, SmsStatus: "received" });
  if (provider === "telnyx") return { data: { event_type: "message.received", id: "event-fixture", payload: { id, direction: "inbound", from: { phone_number: number }, to: [{ phone_number: line }], text, type: "SMS", messaging_profile_id: "profile-fixture" } } };
  return { account_id: "acct_fixture", type: "message.received", data: { id, status: "received", body: text, conversation: { id: "cnv_fixture", contact: { phone_number: number }, phone_number: { number: line } } } };
}
export const encodeInbound = body => Buffer.from(body instanceof URLSearchParams ? body.toString() : JSON.stringify(body));
export function signedHeaders(provider, raw, { env = messagingEnv(), url = "https://fixture.example/channels/twilio/webhook", timestamp = String(Math.floor(Date.now() / 1000)) } = {}) {
  if (provider === "twilio") {
    const params = new URLSearchParams(raw.toString());
    let signed = url;
    for (const key of [...new Set(params.keys())].sort()) for (const value of [...new Set(params.getAll(key))].sort()) signed += key + value;
    return { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": createHmac("sha1", env.TWILIO_AUTH_TOKEN).update(signed).digest("base64") };
  }
  if (provider === "telnyx") return { "content-type": "application/json", "telnyx-timestamp": timestamp, "telnyx-signature-ed25519": sign(null, Buffer.concat([Buffer.from(`${timestamp}|`), raw]), keys.privateKey).toString("base64") };
  return { "content-type": "application/json", "webhook-id": "delivery-fixture", "webhook-timestamp": timestamp, "webhook-signature": `v1,${createHmac("sha256", Buffer.from(env[`${provider.toUpperCase()}_WEBHOOK_SECRET`].slice(6), "base64")).update(`delivery-fixture.${timestamp}.`).update(raw).digest("base64")}` };
}
export const acceptedResponse = provider => Response.json(provider === "linq" ? { message: { id: "accepted-fixture" } } : provider === "twilio" ? { sid: "accepted-fixture", error_code: null } : provider === "telnyx" ? { data: { id: "accepted-fixture" } } : { id: "accepted-fixture" });
