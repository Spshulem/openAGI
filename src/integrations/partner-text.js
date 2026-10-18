import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { ensureDir, readJsonFile, writeJsonAtomic } from "../file-utils.js";
import { resolveDataDir } from "../data-dir.js";
import { isPhoneNumber } from "../partner-sharing.js";

// New providers acknowledge after durable local enqueue, not after the model
// turn. In particular Telnyx requires acknowledgement within two seconds.
// Pending work resumes once at startup, on configuration save or owner retry.
// A write with an unknown outcome is NEVER automatically repeated.
export class PartnerTextChannel {
  constructor({ provider, sharing, dir = path.join(resolveDataDir(), "channels", provider), env = process.env, fetchImpl = globalThis.fetch } = {}) {
    Object.assign(this, { provider, sharing, dir, env, fetchImpl });
    this.pendingDir = path.join(dir, "pending");
    ensureDir(this.pendingDir);
    this.inflight = new Map();
    this.closing = false;
    this.maxLength = 1600;
  }
  line() { return this.env[`${this.provider.toUpperCase()}_FROM_NUMBER`]; }
  pendingKeys() { return fs.readdirSync(this.pendingDir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => name.slice(0, -5)); }
  queueStatus() {
    let failed = 0, requiresReview = 0;
    const keys = this.pendingKeys();
    for (const key of keys) {
      if (readJsonFile(this.receiptPath(key), null)?.sendStarted) requiresReview++;
      else if (readJsonFile(this.pendingPath(key), null)?.failed) failed++;
    }
    return { pending: keys.length, processing: this.inflight.size, failed, requiresReview };
  }
  receiptPath(key) { return path.join(this.dir, `${key}.json`); }
  pendingPath(key) { return path.join(this.pendingDir, `${key}.json`); }
  allowed(message) { return (!message.line || message.line === this.line()) && this.sharing.canReceive(message.number, message.groupId, this.provider); }
  handleWebhook(body) {
    if (this.closing) throw new Error("Messaging is stopping.");
    const message = this.normalize(body);
    if (message.ignored) return message;
    if (!this.allowed(message)) return { ignored: true, reason: "not-allowlisted" };
    if (typeof message.text !== "string" || !message.text.trim()) return { ignored: true, reason: "no-text" };
    if (message.text.length > 16000) throw Object.assign(new Error("Message too large."), { status: 413 });
    if (typeof message.id !== "string" || !message.id || message.id.length > 300) throw Object.assign(new Error("Missing message ID."), { status: 400 });
    const key = createHash("sha256").update(`${this.line()}:${message.id}`).digest("hex");
    const receipt = readJsonFile(this.receiptPath(key), null);
    if (receipt?.accepted || receipt?.ignored) return { duplicate: true, accepted: Boolean(receipt.accepted) };
    if (receipt?.sendStarted) return { accepted: false, requiresReview: true, reason: "send-status-unknown" };
    if (!fs.existsSync(this.pendingPath(key))) writeJsonAtomic(this.pendingPath(key), { message: { ...message, line: this.line(), provider: this.provider, maxReplyLength: this.maxLength } });
    this.schedule(key);
    return { queued: true };
  }
  schedule(key) {
    if (this.inflight.has(key) || this.closing) return;
    const task = new Promise(resolve => setImmediate(resolve)).then(() => this.process(key)).catch(() => {
      // No model text, credentials or provider response is exposed in status.
      try {
        const pending = readJsonFile(this.pendingPath(key), null);
        if (pending) writeJsonAtomic(this.pendingPath(key), { ...pending, failed: true });
      } catch { /* Leave the durable item pending when the disk is unavailable. */ }
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
  }
  start() { this.closing = false; for (const key of this.pendingKeys()) this.schedule(key); }
  async drain() { while (this.inflight.size) await Promise.allSettled([...this.inflight.values()]); }
  async stop() { this.closing = true; await this.drain(); }
  finish(key, receipt) {
    writeJsonAtomic(this.receiptPath(key), receipt);
    fs.rmSync(this.pendingPath(key), { force: true });
  }
  async process(key) {
    let receipt = readJsonFile(this.receiptPath(key), null);
    if (receipt?.accepted || receipt?.ignored) { fs.rmSync(this.pendingPath(key), { force: true }); return; }
    if (receipt?.sendStarted) return;
    const message = readJsonFile(this.pendingPath(key), null)?.message;
    if (!message) return;
    if (!this.allowed(message) || !await this.authorizeIncoming(message)) { this.finish(key, { ignored: true }); return; }
    if (!receipt) {
      const result = await this.sharing.respond(message);
      if (result.ignored) { this.finish(key, { ignored: true }); return; }
      receipt = { reply: result.reply };
      writeJsonAtomic(this.receiptPath(key), receipt);
    }
    if (!this.allowed(message)) { this.finish(key, { ignored: true }); return; }
    // All local validation and read-only group checks precede sendStarted.
    const prepared = await this.prepareMessage(message.groupId || message.number, receipt.reply, { group: Boolean(message.groupId), sender: message.number });
    // An owner can revoke approval while the membership request is in flight.
    if (!this.allowed(message)) { this.finish(key, { ignored: true }); return; }
    writeJsonAtomic(this.receiptPath(key), { ...receipt, sendStarted: true });
    const result = await this.sendPrepared(prepared);
    this.finish(key, { accepted: true, messageId: result.messageId, at: new Date().toISOString() });
  }
  async authorizeIncoming() { return true; }
  validateMessage(target, text, { group = false } = {}) {
    if (!this.sharing.canSend(target, group, this.provider)) throw new Error("Recipient is not approved for sharing.");
    if (!this.status().configured || !isPhoneNumber(this.line())) throw new Error(`Configure ${this.provider} credentials and the agent's E.164 number first.`);
    if (group && this.provider !== "linq") throw new Error("This provider supports one-to-one text only.");
    if (!group && !isPhoneNumber(target)) throw new Error("Use an approved E.164 phone number.");
    if (typeof text !== "string" || !text.trim() || text.length > this.maxLength) throw new Error(`Message must be 1–${this.maxLength} characters.`);
  }
  async prepareMessage(target, text, options = {}) { this.validateMessage(target, text, options); return this.buildRequest(target, text, options); }
  async sendMessage(target, text, options = {}) {
    const prepared = await this.prepareMessage(target, text, options);
    this.validateMessage(target, text, options);
    return this.sendPrepared(prepared);
  }
  async sendPrepared({ url, ...init }) {
    const response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(30000), redirect: "error" });
    if (!response.ok) throw new Error(`${this.provider} send failed (${response.status}); inspect the provider dashboard before retrying.`);
    const id = this.acceptanceId(await response.json());
    if (typeof id !== "string" || !id) throw new Error(`${this.provider} returned no message ID; inspect the provider dashboard before retrying.`);
    return { accepted: true, messageId: id };
  }
}
