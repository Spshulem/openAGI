import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { attachG2SpeechRelay } from "../src/integrations/g2-speech-relay.js";

const TOKEN = "t".repeat(43);

test("CloseStream summary completes immediately and exposes no provider metadata", { timeout: 3000 }, async t => {
  const f = await fixture(t, socket => {
    socket.on("message", (data, binary) => {
      if (!binary && JSON.parse(data.toString()).type === "CloseStream") {
        socket.send(result("Final question", true));
        socket.send(JSON.stringify({ type: "Metadata", request_id: "private-provider-id", account: "private-account" }));
        // Deliberately do not close: completion must not depend on socket teardown.
      }
    });
  });
  const client = connect(f.origin); t.after(() => client.ws.terminate()); await client.next();
  const closed = once(client.ws, "close");
  client.ws.send(JSON.stringify({ type: "CloseStream" }));
  assert.equal((await client.next()).channel.alternatives[0].transcript, "Final question");
  assert.deepEqual(await client.next(), { type: "SpeechFinished" });
  assert.equal((await closed)[0], 1000);
});
const PROTOCOL = "openagi-g2-speech";

async function fixture(t, onUpstream = () => {}) {
  const provider = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(provider, "listening");
  const server = http.createServer();
  let revoked = false;
  const nodeRegistry = {
    enrollmentForToken: token => token === TOKEN && !revoked ? { nodeId: "node-a", platform: "even_g2" } : token === "o".repeat(43) ? { nodeId: "node-b", platform: "openagi" } : null,
    authenticate: (id, token) => id === "node-a" && token === TOKEN && !revoked,
  };
  const requested = [];
  const channel = { deepgramApiKey: "server-only-deepgram-key" };
  const relay = attachG2SpeechRelay(server, { nodeRegistry, getChannel: () => channel, upstreamFactory: (url, options) => {
    const upstream = new WebSocket(`ws://127.0.0.1:${provider.address().port}`, options);
    requested.push({ url, options, upstream });
    return upstream;
  } });
  const peers = [];
  provider.on("connection", (socket, req) => { peers.push(socket); onUpstream(socket, req); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `ws://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    relay.close(); for (const socket of peers) socket.terminate();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => provider.close(resolve))]);
  });
  return { origin, requested, peers, relay, channel, revoke: () => { revoked = true; } };
}

function connect(origin, query = "?model=nova-3&wakePhrase=Peri") {
  const ws = new WebSocket(`${origin}/nodes/g2/speech${query}`, [PROTOCOL, TOKEN], { origin: "null" });
  const events = []; const waiting = [];
  ws.on("error", () => {});
  ws.on("message", data => { const event = JSON.parse(data.toString()); if (waiting.length) waiting.shift()(event); else events.push(event); });
  const next = () => events.length ? Promise.resolve(events.shift()) : new Promise(resolve => waiting.push(resolve));
  return { ws, next };
}
async function denied(url, protocols, options) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols, options);
    ws.on("error", () => {});
    ws.on("unexpected-response", (_req, response) => { response.resume(); ws.terminate(); resolve(response.statusCode); });
    ws.on("open", () => { ws.terminate(); reject(new Error("Unexpected upgrade")); });
  });
}
const result = (text, final = false) => JSON.stringify({ type: "Results", is_final: final, speech_final: final, start: 0, duration: 0.2, channel: { alternatives: [{ transcript: text }] } });

test("relay streams PCM before Stop, filters metadata, drains final words and keeps the provider key server-side", { timeout: 3000 }, async t => {
  let received;
  const f = await fixture(t, (peer, req) => {
    assert.equal(req.headers.authorization, "Token server-only-deepgram-key");
    peer.on("message", (data, binary) => {
      if (binary) { received = data; peer.send(JSON.stringify({ type: "Metadata", secret: "server-only-deepgram-key" })); peer.send(result("What time")); }
      else if (JSON.parse(data.toString()).type === "CloseStream") { peer.send(result("What time is it?", true)); peer.close(1000); }
    });
  });
  const client = connect(f.origin); t.after(() => client.ws.terminate());
  assert.deepEqual(await client.next(), { type: "Ready", transport: "relay" });
  assert.equal(client.ws.protocol, PROTOCOL);
  const pcm = Buffer.alloc(6400); client.ws.send(pcm);
  assert.equal((await client.next()).channel.alternatives[0].transcript, "What time");
  assert.deepEqual(received, pcm);
  assert.match(f.requested[0].url, /^wss:\/\/api.deepgram.com\/v1\/listen\?/);
  assert.match(f.requested[0].url, /keyterm=Peri/);
  assert.equal(f.requested[0].options.followRedirects, false);
  const closed = once(client.ws, "close");
  client.ws.send(JSON.stringify({ type: "CloseStream" }));
  const final = await client.next(); assert.equal(final.speech_final, true);
  assert.equal(JSON.stringify(final).includes("server-only"), false);
  assert.equal((await closed)[0], 1000);
});

test("relay upgrade rejects unpaired, owner and non-G2 credentials, query tokens and arbitrary destinations", { timeout: 3000 }, async t => {
  const f = await fixture(t);
  const route = `${f.origin}/nodes/g2/speech`;
  assert.equal(await denied(route), 403);
  assert.equal(await denied(route, [PROTOCOL, "x".repeat(43)]), 403);
  assert.equal(await denied(route, [PROTOCOL, "o".repeat(43)]), 403);
  assert.equal(await denied(route, undefined, { headers: { Authorization: "Bearer owner-token" } }), 403);
  assert.equal(await denied(`${route}?token=${TOKEN}`, [PROTOCOL, TOKEN]), 400);
  assert.equal(await denied(`${route}?url=https://attacker.invalid`, [PROTOCOL, TOKEN]), 400);
  assert.equal(await denied(`${route}?model=not-supported`, [PROTOCOL, TOKEN]), 400);
  assert.equal(await denied(`${f.origin}/message`, [PROTOCOL, TOKEN]), 404);
  assert.equal(f.requested.length, 0);
});

test("revocation stops live audio; one node cannot open concurrent streams", { timeout: 3000 }, async t => {
  const f = await fixture(t);
  const client = connect(f.origin); t.after(() => client.ws.terminate()); await client.next();
  assert.equal(await denied(`${f.origin}/nodes/g2/speech`, [PROTOCOL, TOKEN]), 429);
  f.revoke();
  const closed = once(client.ws, "close");
  client.ws.send(Buffer.alloc(640));
  assert.match((await client.next()).message, /revoked/);
  assert.equal((await closed)[0], 1008);
  assert.equal(f.requested.length, 1);
});

test("provider error bodies never leak and invalid PCM never reaches Deepgram", { timeout: 3000 }, async t => {
  const f = await fixture(t);
  const client = connect(f.origin); t.after(() => client.ws.terminate()); await client.next();
  f.peers[0].send(JSON.stringify({ type: "Error", message: "server-only-deepgram-key" }));
  const error = await client.next(); assert.equal(error.type, "Error"); assert.equal(error.message.includes("server-only"), false);
  await once(client.ws, "close");
  const invalid = connect(f.origin); t.after(() => invalid.ws.terminate()); await invalid.next();
  const closed = once(invalid.ws, "close");
  invalid.ws.send(Buffer.alloc(3));
  const pcmError = await invalid.next(); assert.match(pcmError.message, /PCM/); assert.equal(pcmError.code, "invalid_pcm");
  assert.equal((await closed)[0], 1008);
});

test("shutting down the relay closes both sides of an active speech connection", { timeout: 3000 }, async t => {
  const f = await fixture(t);
  const client = connect(f.origin); t.after(() => client.ws.terminate()); await client.next();
  const closed = once(client.ws, "close"); const providerClosed = once(f.peers[0], "close");
  f.relay.close(); await closed; await providerClosed;
});

test("relay distinguishes rate overflow from provider backlog without relaxing either limit", { timeout: 3000 }, async t => {
  const f = await fixture(t);
  const fast = connect(f.origin); t.after(() => fast.ws.terminate()); await fast.next();
  const closed = once(fast.ws, "close");
  fast.ws.send(Buffer.alloc(64000)); fast.ws.send(Buffer.alloc(64000));
  assert.equal((await fast.next()).code, "audio_rate"); await closed;
  const slow = connect(f.origin); t.after(() => slow.ws.terminate()); await slow.next();
  Object.defineProperty(f.requested[1].upstream, "bufferedAmount", { get: () => 64000 });
  slow.ws.send(Buffer.alloc(640)); assert.equal((await slow.next()).code, "upstream_backlog");
});
