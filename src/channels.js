import { appendJsonLine, ensureDir, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import path from "node:path";
import { nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

export class ChannelManager {
  constructor(options = {}) {
    this.agentHost = options.agentHost;
    this.runtime = options.runtime ?? options.agentHost?.runtime;
    this.dir = options.dir ?? path.join(resolveDataDir(), "channels");
    ensureDir(this.dir);
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.telegram = new TelegramChannel({
      agentHost: this.agentHost,
      dir: path.join(this.dir, "telegram"),
      token: options.telegramToken ?? process.env.TELEGRAM_BOT_TOKEN
    });
    this.sms = new SmsChannel({
      agentHost: this.agentHost,
      dir: path.join(this.dir, "sms"),
      accountSid: options.twilioAccountSid ?? process.env.TWILIO_ACCOUNT_SID,
      authToken: options.twilioAuthToken ?? process.env.TWILIO_AUTH_TOKEN,
      fromNumber: options.twilioFromNumber ?? process.env.TWILIO_FROM_NUMBER
    });
    if (this.runtime) this.runtime.channels = this;
  }

  async handleLocalMessage(body) {
    return this.agentHost.handleMessage({
      channel: body.channel ?? "local",
      from: body.from ?? "user",
      agentId: body.agentId ?? "main",
      sessionId: body.sessionId,
      text: body.text ?? body.message,
      metadata: body.metadata ?? {},
      // Ephemeral turns (setup-wizard test message) leave no trace: no
      // session, no memory write, no outcome — just a model round-trip.
      ephemeral: body.ephemeral === true
    });
  }

  async handleTelegramWebhook(update) {
    return this.telegram.handleUpdate(update);
  }

  async handleSmsMessage(body) {
    return this.agentHost.handleMessage({
      channel: body.channel ?? "sms",
      from: body.from,
      agentId: body.agentId ?? "main",
      sessionId: body.sessionId,
      text: body.text,
      metadata: body.metadata ?? {}
    });
  }

  async deliver({ channel, target, text, sessionId = null, refId = null }) {
    if (!channel || !text) throw new Error("deliver requires channel and text");
    appendJsonLine(this.eventsPath, { at: nowIso(), op: "deliver", channel, target, text: String(text).slice(0, 400) });
    let result;
    if (channel === "telegram") result = await this.telegram.sendMessage(target, text);
    else if (channel === "sms") result = await this.sms.sendSms(target, text);
    else if (channel === "local" || channel === "cron") {
      result = { delivered: false, reason: `channel ${channel} has no outbound transport (read from /sessions or stream /events)` };
    } else {
      throw new Error(`Unknown channel: ${channel}`);
    }
    this.runtime?.outcomes?.record({
      kind: "sent-message",
      refId,
      sessionId,
      channel,
      metadata: { target, length: String(text).length, result }
    });
    return result;
  }

  start() {
    if (process.env.TELEGRAM_POLLING === "1") {
      this.telegram.startPolling();
    }
  }

  stop() {
    this.telegram.stopPolling();
  }

  status() {
    return {
      local: { enabled: true, mode: "http+sse" },
      sms: this.sms.status(),
      telegram: this.telegram.status()
    };
  }
}

export class TelegramChannel {
  constructor(options = {}) {
    this.agentHost = options.agentHost;
    this.token = options.token;
    this.dir = options.dir ?? path.join(resolveDataDir(), "channels", "telegram");
    this.statePath = path.join(this.dir, "state.json");
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.pollTimer = null;
    ensureDir(this.dir);
    this.state = readJsonFile(this.statePath, { offset: 0 });
  }

  status() {
    return {
      configured: Boolean(this.token),
      polling: Boolean(this.pollTimer),
      offset: this.state.offset ?? 0
    };
  }

  async handleUpdate(update) {
    appendJsonLine(this.eventsPath, { at: nowIso(), update });
    const message = update.message ?? update.edited_message;
    const text = message?.text ?? message?.caption;
    const chatId = message?.chat?.id;
    if (!text || !chatId) return { ignored: true };

    const result = await this.agentHost.handleMessage({
      channel: "telegram",
      from: String(chatId),
      agentId: "main",
      text,
      metadata: {
        updateId: update.update_id,
        telegramMessageId: message.message_id,
        username: message.from?.username,
        firstName: message.from?.first_name
      }
    });

    if (this.token) {
      await this.sendMessage(chatId, result.reply);
    }

    return result;
  }

  async sendMessage(chatId, text) {
    if (!this.token) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
    const response = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text).slice(0, 3900)
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body?.description ?? `Telegram send failed with ${response.status}`);
    }
    return body;
  }

  startPolling(intervalMs = Number.parseInt(process.env.TELEGRAM_POLL_INTERVAL_MS ?? "2500", 10)) {
    if (!this.token || this.pollTimer) return;
    const poll = async () => {
      try {
        await this.pollOnce();
      } catch (error) {
        appendJsonLine(this.eventsPath, { at: nowIso(), error: error.message });
      }
    };
    this.pollTimer = setInterval(poll, intervalMs);
    poll();
  }

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async pollOnce() {
    if (!this.token) return { configured: false };
    const url = new URL(`https://api.telegram.org/bot${this.token}/getUpdates`);
    url.searchParams.set("timeout", "1");
    if (this.state.offset) url.searchParams.set("offset", String(this.state.offset));

    const response = await fetch(url);
    const body = await response.json();
    if (!response.ok || !body.ok) {
      throw new Error(body.description ?? `Telegram poll failed with ${response.status}`);
    }

    for (const update of body.result ?? []) {
      await this.handleUpdate(update);
      this.state.offset = Math.max(this.state.offset ?? 0, update.update_id + 1);
      writeJsonAtomic(this.statePath, this.state);
    }

    return { updates: body.result?.length ?? 0 };
  }
}

export class SmsChannel {
  constructor(options = {}) {
    this.agentHost = options.agentHost;
    this.accountSid = options.accountSid;
    this.authToken = options.authToken;
    this.fromNumber = options.fromNumber;
    this.dir = options.dir ?? path.join(resolveDataDir(), "channels", "sms");
    this.eventsPath = path.join(this.dir, "events.jsonl");
    ensureDir(this.dir);
  }

  status() {
    return {
      enabled: true,
      mode: "twilio-webhook",
      outboundConfigured: Boolean(this.accountSid && this.authToken && this.fromNumber),
      fromNumber: this.fromNumber ?? null
    };
  }

  async sendSms(to, body) {
    if (!this.accountSid || !this.authToken || !this.fromNumber) {
      throw new Error("Twilio outbound is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER.");
    }
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");
    const form = new URLSearchParams({
      To: to,
      From: this.fromNumber,
      Body: String(body).slice(0, 1500)
    });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Basic ${auth}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: form.toString()
    });
    const json = await response.json().catch(() => ({}));
    appendJsonLine(this.eventsPath, { at: nowIso(), op: "sendSms", to, ok: response.ok, sid: json.sid, error: json.message });
    if (!response.ok) {
      throw new Error(json.message ?? `Twilio send failed with ${response.status}`);
    }
    return { sid: json.sid, status: json.status, to: json.to, from: json.from };
  }
}
