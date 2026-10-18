import { PartnerTextChannel } from "./partner-text.js";
import { verifyStandardWebhook, verifyTelnyxWebhook, verifyTwilioWebhook } from "./messaging-security.js";

const ignored = reason => ({ ignored: true, reason });
const jsonPost = (url, token, body) => ({ url, method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

export class LinqChannel extends PartnerTextChannel {
  constructor(options) { super({ ...options, provider: "linq" }); this.maxLength = 10000; }
  status() { return { configured: Boolean(this.env.LINQ_API_TOKEN && this.line()), webhookReady: Boolean(this.env.LINQ_WEBHOOK_SECRET), ...this.queueStatus() }; }
  verify(headers, raw) { return verifyStandardWebhook(headers, raw, this.env.LINQ_WEBHOOK_SECRET); }
  normalize(body) {
    const data = body?.data, chat = data?.chat;
    if (body?.api_version !== "v3" || body?.webhook_version !== "2026-02-03" || body?.event_type !== "message.received" || data?.direction !== "inbound" || data?.sender_handle?.is_me !== false) return ignored("not-inbound");
    if (chat?.owner_handle?.handle !== this.line() || chat.owner_handle.is_me !== true) return ignored("wrong-line");
    if (typeof chat.is_group !== "boolean") return ignored("unknown-conversation");
    if (chat.is_group && (typeof chat.id !== "string" || !/^[\w.+:@-]{1,200}$/.test(chat.id))) return ignored("unknown-conversation");
    return { id: data.id, number: data.sender_handle.handle, groupId: chat.is_group ? chat.id : null, text: Array.isArray(data.parts) ? data.parts.filter(p => p.type === "text" && typeof p.value === "string").map(p => p.value).join("\n") : "" };
  }
  async approvedGroup(groupId, sender) {
    if (!this.sharing.canSend(groupId, true, this.provider)) return false;
    const response = await this.fetchImpl(`https://api.linqapp.com/api/partner/v3/chats/${encodeURIComponent(groupId)}`, { headers: { authorization: `Bearer ${this.env.LINQ_API_TOKEN}` }, redirect: "error", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("Could not verify Linq group membership.");
    const chat = await response.json();
    if (chat.id !== groupId || chat.is_group !== true || !Array.isArray(chat.handles)) return false;
    const active = chat.handles.filter(h => !h.left_at && (h.status === undefined || h.status === "active"));
    return active.some(h => h.handle === this.line() && h.is_me === true)
      && (!sender || active.some(h => h.handle === sender && h.is_me !== true))
      && active.length >= 2
      && active.every(h => h.handle === this.line() && h.is_me === true || h.is_me !== true && this.sharing.canSend(h.handle, false, this.provider));
  }
  async authorizeIncoming(message) { return !message.groupId || this.approvedGroup(message.groupId, message.number); }
  async prepareMessage(target, text, options = {}) {
    this.validateMessage(target, text, options);
    if (options.group && !await this.approvedGroup(target, options.sender)) throw new Error("Linq group membership is not approved.");
    this.validateMessage(target, text, options);
    return this.buildRequest(target, text, options);
  }
  buildRequest(target, text, { group = false } = {}) {
    const parts = [{ type: "text", value: text }];
    // /messages automatically chooses a line. /chats pins the dedicated
    // identity and reuses an existing chat with this from/to participant set.
    return jsonPost(`https://api.linqapp.com/api/partner/v3/${group ? `chats/${encodeURIComponent(target)}/messages` : "chats"}`, this.env.LINQ_API_TOKEN, group ? { parts } : { from: this.line(), to: [target], message: { parts } });
  }
  acceptanceId(result) { return result.message?.id; }
}

export class TwilioChannel extends PartnerTextChannel {
  constructor(options) { super({ ...options, provider: "twilio" }); }
  status() { return { configured: Boolean(/^AC[0-9a-f]{32}$/i.test(this.env.TWILIO_ACCOUNT_SID ?? "") && this.env.TWILIO_AUTH_TOKEN && this.line()), webhookReady: Boolean(this.env.TWILIO_AUTH_TOKEN), ...this.queueStatus() }; }
  verify(headers, raw, callbackUrl) { return verifyTwilioWebhook(headers, raw, this.env.TWILIO_AUTH_TOKEN, callbackUrl); }
  normalize(params) {
    // Reject ambiguous duplicate routing/body fields, but still sign all fields.
    for (const key of ["AccountSid", "MessageSid", "From", "To", "Body"]) if (params.getAll(key).length !== 1) return ignored("not-inbound");
    if (params.get("AccountSid") !== this.env.TWILIO_ACCOUNT_SID || params.get("To") !== this.line()) return ignored("wrong-account-or-line");
    if (params.has("MessageStatus") || params.has("SmsStatus") && params.get("SmsStatus") !== "received") return ignored("not-inbound");
    return { id: params.get("MessageSid"), number: params.get("From"), text: params.get("Body") };
  }
  buildRequest(target, text) {
    return { url: `https://api.twilio.com/2010-04-01/Accounts/${this.env.TWILIO_ACCOUNT_SID}/Messages.json`, method: "POST", headers: { authorization: `Basic ${Buffer.from(`${this.env.TWILIO_ACCOUNT_SID}:${this.env.TWILIO_AUTH_TOKEN}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ From: this.line(), To: target, Body: text }).toString() };
  }
  acceptanceId(result) { return result.error_code ? null : result.sid; }
}

export class TelnyxChannel extends PartnerTextChannel {
  constructor(options) { super({ ...options, provider: "telnyx" }); }
  status() { return { configured: Boolean(this.env.TELNYX_API_KEY && this.line()), webhookReady: Boolean(this.env.TELNYX_PUBLIC_KEY), ...this.queueStatus() }; }
  verify(headers, raw) { return verifyTelnyxWebhook(headers, raw, this.env.TELNYX_PUBLIC_KEY); }
  normalize(body) {
    const data = body?.data, payload = data?.payload;
    if (data?.event_type !== "message.received" || payload?.direction !== "inbound") return ignored("not-inbound");
    if (!Array.isArray(payload.to) || payload.to.length !== 1 || payload.to[0]?.phone_number !== this.line() || payload.cc?.length) return ignored("wrong-line-or-group");
    if (this.env.TELNYX_MESSAGING_PROFILE_ID && payload.messaging_profile_id !== this.env.TELNYX_MESSAGING_PROFILE_ID) return ignored("wrong-profile");
    if (!["SMS", "MMS"].includes(payload.type)) return ignored("unsupported-type");
    return { id: payload.id, number: payload.from?.phone_number, text: payload.text };
  }
  buildRequest(target, text) {
    return jsonPost("https://api.telnyx.com/v2/messages", this.env.TELNYX_API_KEY, { from: this.line(), to: target, text, ...(this.env.TELNYX_MESSAGING_PROFILE_ID ? { messaging_profile_id: this.env.TELNYX_MESSAGING_PROFILE_ID } : {}) });
  }
  acceptanceId(result) { return result.data?.id; }
}

export class SurgeChannel extends PartnerTextChannel {
  constructor(options) { super({ ...options, provider: "surge" }); }
  status() { return { configured: Boolean(this.env.SURGE_API_KEY && /^acct_[\w-]+$/.test(this.env.SURGE_ACCOUNT_ID ?? "") && this.line()), webhookReady: Boolean(this.env.SURGE_WEBHOOK_SECRET), ...this.queueStatus() }; }
  verify(headers, raw) { return verifyStandardWebhook(headers, raw, this.env.SURGE_WEBHOOK_SECRET); }
  normalize(body) {
    const data = body?.data;
    if (body?.type !== "message.received" || data?.status !== "received") return ignored("not-inbound");
    if (body.account_id !== this.env.SURGE_ACCOUNT_ID || data.conversation?.phone_number?.number !== this.line()) return ignored("wrong-account-or-line");
    return { id: data.id, number: data.conversation?.contact?.phone_number, text: data.body };
  }
  buildRequest(target, text) { return jsonPost(`https://api.surge.app/accounts/${encodeURIComponent(this.env.SURGE_ACCOUNT_ID)}/messages`, this.env.SURGE_API_KEY, { from: this.line(), to: target, body: text }); }
  acceptanceId(result) { return result.id; }
}

export const TEXT_CHANNELS = { linq: LinqChannel, twilio: TwilioChannel, telnyx: TelnyxChannel, surge: SurgeChannel };
