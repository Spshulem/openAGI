// iMessage bridge relay: forward incoming → main → reply back, with rowid
// high-water tracking, allowlist, and bootstrap-skips-history. Injects the db
// reader, the main client, and the send fn so no chat.db / Messages.app needed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { IMessageBridge, extractAttributedText } from "../src/integrations/imessage-bridge.js";

function makeBridge({ messages = [], replies = {}, allowFrom = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-imsg-"));
  const sent = [];
  const forwarded = [];
  const client = {
    health: async () => ({ ok: true, json: { ok: true } }),
    chat: async (text, opts) => {
      forwarded.push({ text, from: opts.from });
      const reply = replies[text];
      return reply ? { ok: true, json: { reply } } : { ok: false, status: 500, error: "no reply" };
    }
  };
  const bridge = new IMessageBridge({
    client, allowFrom,
    dataDir: dir,
    readMessages: async (since) => messages.filter((m) => m.rowid > since),
    sendMessage: async (handle, text) => { sent.push({ handle, text }); }
  });
  return { bridge, sent, forwarded, dir };
}

test("first poll bootstraps to the high-water mark without replaying history", async () => {
  const { bridge, sent, forwarded } = makeBridge({
    messages: [{ rowid: 10, handle: "+15551112222", text: "old" }, { rowid: 11, handle: "+15551112222", text: "older" }]
  });
  const r = await bridge.poll();
  assert.equal(r.bootstrapped, true);
  assert.equal(sent.length, 0, "no history replayed");
  assert.equal(forwarded.length, 0);
});

test("relays a new incoming message to the main and texts the reply back", async () => {
  const { bridge, sent, forwarded } = makeBridge({
    messages: [{ rowid: 5, handle: "+15551112222", text: "what's on my calendar?" }],
    replies: { "what's on my calendar?": "You have a 3pm with Acme." }
  });
  await bridge.poll(); // bootstrap (maxRowid=5)
  // a NEW message arrives after the bootstrap mark
  bridge.readMessages = async (since) => [{ rowid: 6, handle: "+15551112222", text: "remind me to call Sam" }].filter((m) => m.rowid > since);
  bridge.client.chat = async (text, opts) => { forwarded.push({ text, from: opts.from }); return { ok: true, json: { reply: "Got it — I'll remind you." } }; };
  const r = await bridge.poll();
  assert.equal(r.replied, 1);
  assert.equal(forwarded[0].from, "imessage:+15551112222", "sender becomes the main session id");
  assert.deepEqual(sent[0], { handle: "+15551112222", text: "Got it — I'll remind you." });
});

test("allowlist drops messages from non-allowed senders", async () => {
  const { bridge, sent } = makeBridge({
    messages: [{ rowid: 1, handle: "+1999", text: "hi" }],
    allowFrom: ["+15551112222"]
  });
  // force past bootstrap with lastRowid already set
  bridge._saveState({ lastRowid: 0, initialized: true });
  bridge.readMessages = async () => [{ rowid: 2, handle: "+1999", text: "spam" }, { rowid: 3, handle: "+15551112222", text: "real" }];
  bridge.client.chat = async () => ({ ok: true, json: { reply: "ok" } });
  const r = await bridge.poll();
  assert.equal(r.skipped, 1, "non-allowed sender skipped");
  assert.equal(r.replied, 1, "allowed sender answered");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].handle, "+15551112222");
});

test("advances the rowid high-water mark even when a send errors", async () => {
  const { bridge, dir } = makeBridge({});
  bridge._saveState({ lastRowid: 100, initialized: true });
  bridge.readMessages = async (since) => [{ rowid: 101, handle: "+1", text: "x" }].filter((m) => m.rowid > since);
  bridge.client.chat = async () => ({ ok: false, status: 500, error: "boom" });
  const r = await bridge.poll();
  assert.equal(r.errors, 1);
  const state = JSON.parse(fs.readFileSync(path.join(dir, "imessage-bridge.json"), "utf8"));
  assert.equal(state.lastRowid, 101, "won't reprocess the same failed message forever");
});

test("extractAttributedText pulls text from an attributedBody blob", () => {
  // Minimal synthetic typedstream: ...NSString <ctrl> + <text> 0x86...
  const text = "hello from imessage";
  const blob = Buffer.concat([
    Buffer.from("streamtyped...NSString", "binary"),
    Buffer.from([0x01, 0x2b]),
    Buffer.from(text, "utf8"),
    Buffer.from([0x86, 0x84])
  ]);
  assert.equal(extractAttributedText(blob), text);
});

test("extractAttributedText returns empty for a body with no NSString marker", () => {
  assert.equal(extractAttributedText(Buffer.from("garbage")), "");
  assert.equal(extractAttributedText(null), "");
});

// ── response policies + memory capture ──────────────────────────────────────

function policyBridge(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-imsg-pol-"));
  const sent = [], forwarded = [], remembered = [];
  const client = {
    chat: async (text, o) => { forwarded.push({ text, from: o.from }); return { ok: true, json: { reply: "ok-reply" } }; },
    request: async (m, route, body) => { if (route === "/memory/remember") remembered.push(body); return { ok: true }; }
  };
  const bridge = new IMessageBridge({
    client, dataDir: dir,
    readMessages: async () => [],
    sendMessage: async (h, t) => sent.push({ h, t }),
    ...opts
  });
  bridge._saveState({ lastRowid: 0, initialized: true });
  return { bridge, sent, forwarded, remembered };
}

test("respond=all replies to everyone; respond=none never replies", async () => {
  let b = policyBridge({ respondMode: "all" });
  b.bridge.readMessages = async () => [{ rowid: 1, handle: "+1999", text: "hi" }];
  assert.equal((await b.bridge.poll()).replied, 1);

  b = policyBridge({ respondMode: "none" });
  b.bridge.readMessages = async () => [{ rowid: 1, handle: "+1999", text: "hi" }];
  const r = await b.bridge.poll();
  assert.equal(r.replied, 0);
  assert.equal(b.sent.length, 0);
});

test("respond=trigger only replies on the trigger word, stripped before forwarding", async () => {
  const b = policyBridge({ respondMode: "trigger", trigger: "peri", allowFrom: ["+15551112222"] });
  b.bridge.readMessages = async () => [
    { rowid: 1, handle: "+15551112222", text: "just chatting, no trigger" },
    { rowid: 2, handle: "+15551112222", text: "Peri, what's the weather?" }
  ];
  const r = await b.bridge.poll();
  assert.equal(r.replied, 1, "only the triggered message");
  assert.equal(b.forwarded.length, 1);
  assert.equal(b.forwarded[0].text, "what's the weather?", "trigger prefix stripped");
});

test("capture=all saves every incoming message to memory, even unreplied", async () => {
  const b = policyBridge({ respondMode: "none", captureMode: "all" });
  b.bridge.readMessages = async () => [
    { rowid: 1, handle: "+1888", text: "remember the milk" },
    { rowid: 2, handle: "+1777", text: "and eggs" }
  ];
  const r = await b.bridge.poll();
  assert.equal(r.captured, 2);
  assert.equal(r.replied, 0, "capture-only: no replies");
  assert.match(b.remembered[0].content, /iMessage from \+1888: remember the milk/);
  assert.ok(b.remembered[0].tags.includes("imessage"));
});

test("capture=allow only saves allowlisted senders", async () => {
  const b = policyBridge({ respondMode: "all", captureMode: "allow", allowFrom: ["+15551112222"] });
  b.bridge.readMessages = async () => [
    { rowid: 1, handle: "+1999", text: "stranger" },
    { rowid: 2, handle: "+15551112222", text: "trusted" }
  ];
  const r = await b.bridge.poll();
  assert.equal(r.captured, 1);
  assert.match(b.remembered[0].content, /trusted/);
});
