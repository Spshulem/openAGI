// test/telegram-channel-gate.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { ChannelManager, TelegramChannel } from "../src/channels.js";
import { verifyTelegramSecret } from "../src/auth.js";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

function makeChannel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-chan-"));
  const handled = [];
  const sends = [];
  const channel = new TelegramChannel({
    token: "123:ABC",
    dir,
    agentHost: {
      handleMessage: async (input) => {
        handled.push(input);
        return { reply: "agent reply", session: { id: "s1" } };
      }
    }
  });
  channel.sendMessage = async (chatId, text) => {
    sends.push({ chatId, text });
    return { ok: true };
  };
  return { channel, handled, sends, dir };
}

let nextUpdateId = 1;
function update(chatId, text) {
  return {
    update_id: nextUpdateId++,
    message: { message_id: 10, chat: { id: chatId }, from: { username: "u", first_name: "U" }, text }
  };
}

test("messages from non-allowlisted chats are ignored with no reply and no agent turn", async () => {
  const { channel, handled, sends } = makeChannel();
  const result = await channel.handleUpdate(update(555, "hello"));
  assert.equal(result.ignored, true);
  assert.equal(result.reason, "not-allowlisted");
  assert.equal(handled.length, 0);
  assert.equal(sends.length, 0);
});

test("a failed /pair gets no reply (unknown senders learn nothing)", async () => {
  const { channel, handled, sends } = makeChannel();
  const { code } = channel.pairing.generateCode();
  const wrong = code === "000000" ? "111111" : "000000";
  const r = await channel.handleUpdate(update(555, "/pair " + wrong));
  assert.equal(r.paired, false);
  assert.equal(sends.length, 0);
  assert.equal(handled.length, 0);
  assert.equal(channel.pairing.isAllowed("555"), false);
});

test("/pair with a valid code allowlists the chat, confirms, and opens the channel", async () => {
  const { channel, handled, sends } = makeChannel();
  const { code } = channel.pairing.generateCode();
  const r = await channel.handleUpdate(update(555, "/pair " + code));
  assert.equal(r.paired, true);
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /Paired/);
  assert.equal(channel.pairing.isAllowed("555"), true);
  // now a normal message flows to the agent and the reply is sent back
  const r2 = await channel.handleUpdate(update(555, "hello"));
  assert.equal(r2.reply, "agent reply");
  assert.equal(handled.length, 1);
  assert.equal(handled[0].channel, "telegram");
  assert.equal(handled[0].from, "555");
  assert.equal(sends.length, 2);
});

test("GET /channels/telegram/pairing-code is auth-gated and issues a 6-digit code", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-route-"));
  const prevToken = process.env.OPENAGI_AUTH_TOKEN;
  process.env.OPENAGI_AUTH_TOKEN = "test-token-abc";
  try {
    const runtime = createDurableRuntime({ dataDir });
    const app = createHostedInterface(runtime, {
      host: "127.0.0.1",
      port: 0,
      channelsDir: path.join(dataDir, "channels")
    });
    const { url } = await app.listen();
    const denied = await fetch(`${url}/channels/telegram/pairing-code`);
    assert.equal(denied.status, 401);
    const res = await fetch(`${url}/channels/telegram/pairing-code`, {
      headers: { authorization: "Bearer test-token-abc" }
    });
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.match(json.code, /^\d{6}$/);
    assert.ok(json.expiresAt);
    await app.close();
  } finally {
    if (prevToken === undefined) delete process.env.OPENAGI_AUTH_TOKEN;
    else process.env.OPENAGI_AUTH_TOKEN = prevToken;
  }
});

test("a retried update id runs one agent turn", async () => {
  const { channel, handled } = makeChannel();
  const { code } = channel.pairing.generateCode();
  await channel.handleUpdate(update(555, "/pair " + code));
  const first = update(555, "hello");
  await channel.handleUpdate(first);
  const retry = await channel.handleUpdate(first);
  assert.equal(retry.reason, "duplicate-update");
  assert.equal(handled.length, 1);
});

test("the webhook secret check fails closed when no secret is configured", () => {
  assert.equal(verifyTelegramSecret({ headerValue: undefined, expected: null }).ok, false);
  assert.equal(verifyTelegramSecret({ headerValue: "anything", expected: "" }).ok, false);
  assert.equal(verifyTelegramSecret({ headerValue: "s3cret", expected: "s3cret" }).ok, true);
  assert.equal(verifyTelegramSecret({ headerValue: "wrong", expected: "s3cret" }).ok, false);
});

test("deliver refuses Telegram chats that never paired", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-deliver-"));
  const manager = new ChannelManager({ dir, telegramToken: "123:ABC", agentHost: { handleMessage: async () => ({}) } });
  const sends = [];
  manager.telegram.sendMessage = async (chatId, text) => { sends.push({ chatId, text }); return { ok: true }; };
  await assert.rejects(manager.deliver({ channel: "telegram", target: "777", text: "hi" }), /not paired/);
  assert.equal(sends.length, 0);
  const { code } = manager.telegram.pairing.generateCode();
  manager.telegram.pairing.attempt("777", code);
  await manager.deliver({ channel: "telegram", target: "777", text: "hi" });
  assert.deepEqual(sends, [{ chatId: "777", text: "hi" }]);
});

async function withWebhookApp(secret, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-hook-"));
  const prevToken = process.env.OPENAGI_AUTH_TOKEN;
  const prevSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  process.env.OPENAGI_AUTH_TOKEN = "test-token-abc";
  if (secret === null) delete process.env.TELEGRAM_WEBHOOK_SECRET;
  else process.env.TELEGRAM_WEBHOOK_SECRET = secret;
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, channelsDir: path.join(dataDir, "channels") });
  const { url } = await app.listen();
  try {
    await fn(url);
  } finally {
    await app.close();
    if (prevToken === undefined) delete process.env.OPENAGI_AUTH_TOKEN;
    else process.env.OPENAGI_AUTH_TOKEN = prevToken;
    if (prevSecret === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
    else process.env.TELEGRAM_WEBHOOK_SECRET = prevSecret;
  }
}

test("POST /channels/telegram/webhook is refused without a configured secret", async () => {
  await withWebhookApp(null, async (url) => {
    const res = await fetch(`${url}/channels/telegram/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update(555, "hello"))
    });
    assert.equal(res.status, 401);
  });
});

test("POST /channels/telegram/webhook acknowledges without echoing the turn", async () => {
  await withWebhookApp("hook-secret", async (url) => {
    const res = await fetch(`${url}/channels/telegram/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "hook-secret" },
      body: JSON.stringify(update(555, "/pair 000000"))
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});
