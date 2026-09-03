import { appendJsonLine, ensureDir, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import path from "node:path";
import { nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";
import { TelegramPairing } from "./telegram-pairing.js";
import { G2Channel } from "./integrations/g2-channel.js";

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
    this.g2 = options.g2 ?? new G2Channel({
      agentHost: this.agentHost,
      nodeRegistry: options.nodeRegistry,
      dir: path.join(this.dir, "g2")
    });
    if (this.runtime) this.runtime.channels = this;
  }

  async handleLocalMessage(body, options = {}) {
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
    }, {
      // Transport-owned callback. It is deliberately not read from `body`:
      // callers of the public HTTP API must not be able to inject executable
      // values into the host. The streamed /message transport uses this to
      // keep a slow tool-using turn visibly alive.
      onProgress: options.onProgress,
      onTextDelta: options.onTextDelta
    });
  }

  async handleTelegramWebhook(update) {
    return this.telegram.handleUpdate(update);
  }

  async deliver({ channel, target, text, sessionId = null, refId = null }) {
    if (!channel || !text) throw new Error("deliver requires channel and text");
    appendJsonLine(this.eventsPath, { at: nowIso(), op: "deliver", channel, target, text: String(text).slice(0, 400) });
    let result;
    if (channel === "telegram") result = await this.telegram.sendMessage(target, text);
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
      telegram: this.telegram.status(),
      g2: this.g2.status()
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
    // Pairing security: only chats that completed "/pair <code>" may talk to
    // the agent or receive outreach. Injectable for tests.
    this.pairing = options.pairing ?? new TelegramPairing({ dir: this.dir });
  }

  status() {
    return {
      configured: Boolean(this.token),
      polling: Boolean(this.pollTimer),
      offset: this.state.offset ?? 0,
      pairing: this.pairing.status()
    };
  }

  async handleUpdate(update) {
    appendJsonLine(this.eventsPath, { at: nowIso(), update });
    const message = update.message ?? update.edited_message;
    const text = message?.text ?? message?.caption;
    const chatId = message?.chat?.id;
    if (!text || !chatId) return { ignored: true };

    // Pairing handshake: "/pair 123456" from any chat. On success the chat id
    // is persisted to allowlist.json and confirmed; failures are logged but
    // NEVER replied to, so a probing stranger learns nothing.
    const pairMatch = /^\/pair\s+(\d{6})\s*$/.exec(text.trim());
    if (pairMatch) {
      const outcome = this.pairing.attempt(String(chatId), pairMatch[1]);
      appendJsonLine(this.eventsPath, {
        at: nowIso(),
        op: "pair-attempt",
        chatId: String(chatId),
        ok: outcome.ok,
        reason: outcome.reason ?? null
      });
      if (outcome.ok && this.token) {
        await this.sendMessage(chatId, "Paired. This chat now receives OpenAGI messages.");
      }
      return { paired: outcome.ok, reason: outcome.reason ?? null };
    }

    // Allowlist gate: every non-/pair message from an unpaired chat is
    // dropped silently — no agent turn, no reply (replying would confirm the
    // bot is live to whoever found it).
    if (!this.pairing.isAllowed(String(chatId))) {
      appendJsonLine(this.eventsPath, { at: nowIso(), op: "ignored-unpaired", chatId: String(chatId) });
      return { ignored: true, reason: "not-allowlisted" };
    }

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
