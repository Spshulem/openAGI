import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { ensureDir, readJsonFile, writeJsonAtomic } from "../file-utils.js";
import { resolveDataDir } from "../data-dir.js";

export function matchesSecret(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string" || !expected) return false;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class SendblueChannel {
  constructor({ sharing, dir = path.join(resolveDataDir(), "channels", "sendblue"), fetchImpl = globalThis.fetch, env = process.env } = {}) {
    this.sharing = sharing;
    this.dir = dir;
    this.fetchImpl = fetchImpl;
    this.env = env;
    this.inflight = new Map();
    ensureDir(dir);
  }
  status() { return { configured: Boolean(this.env.SENDBLUE_API_KEY && this.env.SENDBLUE_API_SECRET && this.env.SENDBLUE_FROM_NUMBER), webhookReady: Boolean(this.env.SENDBLUE_WEBHOOK_SECRET) }; }
  verify(secret) { return matchesSecret(secret, this.env.SENDBLUE_WEBHOOK_SECRET); }

  async handleWebhook(body) {
    if (!body || typeof body !== "object") throw new Error("Expected a Sendblue message.");
    // Delivery receipts and our own outbound echoes must never start turns.
    if (body.is_outbound !== false) return { ignored: true, reason: "not-inbound" };
    if (body.to_number !== this.env.SENDBLUE_FROM_NUMBER) return { ignored: true, reason: "wrong-line" };
    const number = body.from_number, groupId = body.group_id || null;
    if (!this.sharing.canReceive(number, groupId)) return { ignored: true, reason: "not-allowlisted" };
    if (groupId && (!Array.isArray(body.participants) || !body.participants.includes(number)
      || body.participants.some(participant => participant !== this.env.SENDBLUE_FROM_NUMBER && !this.sharing.canSend(participant)))) {
      return { ignored: true, reason: "unapproved-group-member" };
    }
    if (typeof body.content !== "string" || !body.content.trim()) return { ignored: true, reason: "no-text" };
    if (typeof body.message_handle !== "string" || !body.message_handle || body.message_handle.length > 300) throw new Error("Missing message_handle.");
    const key = createHash("sha256").update(`${body.to_number}:${body.message_handle}`).digest("hex");
    if (this.inflight.has(key)) return this.inflight.get(key);
    const work = this.process(key, { number, groupId, text: body.content });
    this.inflight.set(key, work);
    try { return await work; } finally { this.inflight.delete(key); }
  }

  async process(key, message) {
    const receiptPath = path.join(this.dir, `${key}.json`);
    let receipt = readJsonFile(receiptPath, null);
    if (receipt?.accepted) return { duplicate: true, accepted: true };
    if (receipt?.sendStarted) return { accepted: false, requiresReview: true, reason: "send-status-unknown" };
    // Persist the model's answer before delivery: a provider retry after a
    // transport failure retries only the send, never the model/memory turn.
    if (!receipt) {
      const result = await this.sharing.respond(message);
      if (result.ignored) return result;
      receipt = { reply: result.reply, accepted: false };
      writeJsonAtomic(receiptPath, receipt);
    }
    if (!this.sharing.canReceive(message.number, message.groupId)) return { ignored: true, reason: "not-allowlisted" };
    // Local rejection has no ambiguous external effect. Keep the saved reply
    // retryable until all synchronous preflight checks have passed.
    this.validateMessage(message.groupId || message.number, receipt.reply, { group: Boolean(message.groupId) });
    writeJsonAtomic(receiptPath, { ...receipt, sendStarted: true });
    await this.sendMessage(message.groupId || message.number, receipt.reply, { group: Boolean(message.groupId) });
    writeJsonAtomic(receiptPath, { accepted: true, at: new Date().toISOString() });
    return { accepted: true };
  }

  validateMessage(target, text, { group = false } = {}) {
    if (!this.sharing.canSend(target, group)) throw new Error("Recipient is not approved for sharing.");
    if (!this.status().configured) throw new Error("Configure Sendblue API credentials and the agent's number first.");
    if (typeof text !== "string" || !text.trim() || text.length > 16000) throw new Error("Message must be 1–16000 characters.");
  }

  async sendMessage(target, text, { group = false } = {}) {
    this.validateMessage(target, text, { group });
    const response = await this.fetchImpl(`https://api.sendblue.co/api/${group ? "send-group-message" : "send-message"}`, {
      method: "POST", signal: AbortSignal.timeout(30000), redirect: "error",
      headers: { "content-type": "application/json", "sb-api-key-id": this.env.SENDBLUE_API_KEY, "sb-api-secret-key": this.env.SENDBLUE_API_SECRET },
      body: JSON.stringify({ from_number: this.env.SENDBLUE_FROM_NUMBER, content: text, [group ? "group_id" : "number"]: target })
    });
    if (!response.ok) throw new Error(`Sendblue send failed (${response.status}); check the provider dashboard before retrying an ambiguous send.`);
    const result = await response.json();
    if (result.error_code || result.status === "ERROR") throw new Error("Sendblue rejected the message. Check the provider dashboard.");
    // API acceptance is not device delivery; callbacks/provider receipts are
    // needed before claiming that someone received a text.
    return { accepted: true, messageHandle: result.message_handle ?? null };
  }
}
