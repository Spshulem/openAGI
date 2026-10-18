import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import worker from "../src/index.js";
import { _setClock, _resetCaches, sealPass } from "../src/relay.js";

const subtle = webcrypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

const BUNDLE = "sh.openagi.OpenAGI";
const DEVICE = "ab".repeat(32);
const START = "cd".repeat(80);
const CHANNEL = "dHN0LTE2LWNoYW5uZWw=";
const THIRTY_DAYS = 30 * 24 * 60 * 60;
const SEALED = "v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBB";

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function privatePem(base64) {
  const kind = ["PRIVATE", "KEY"].join(" ");
  return [`-----BEGIN ${kind}-----`, ...(base64.match(/.{1,64}/g) ?? []), `-----END ${kind}-----`, ""].join("\n");
}

async function makeKeys() {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = Buffer.from(await subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  const pem = privatePem(pkcs8);
  return { pem, publicKey: pair.publicKey };
}

const keys = await makeKeys();
const passKeyRaw = webcrypto.getRandomValues(new Uint8Array(32));

function makeEnv(extra = {}) {
  return {
    BUNDLE_ID: BUNDLE,
    APNS_KEY_P8: keys.pem,
    APNS_KEY_ID: "KEY1234567",
    APNS_TEAM_ID: "TEAM123456",
    PASS_KEY: b64url(passKeyRaw),
    ...extra,
  };
}

// ---- fake fetch ----
let calls;
let responder;
const realFetch = globalThis.fetch;
let nowMs;

beforeEach(() => {
  calls = [];
  responder = defaultResponder;
  nowMs = Date.UTC(2026, 9, 15, 12, 0, 0);
  _setClock(() => nowMs);
  _resetCaches();
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: init && init.body ? JSON.parse(init.body) : undefined });
    return responder(String(url), init);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  _setClock(null);
});

function defaultResponder(url) {
  if (url.includes("api-manage-broadcast")) {
    return new Response(null, { status: 201, headers: { "apns-channel-id": CHANNEL, "apns-request-id": "req-1" } });
  }
  if (url.includes("/4/broadcasts/")) {
    return new Response(null, { status: 200, headers: { "apns-request-id": "bcast-1" } });
  }
  return new Response(null, { status: 200, headers: { "apns-id": "apns-123" } });
}

function req(path, body, { method = "POST", headers = {} } = {}) {
  const init = { method, headers: { "content-type": "application/json", ...headers } };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`https://push.openagi.sh${path}`, init);
}

async function call(path, body, env = makeEnv(), opts) {
  const res = await worker.fetch(req(path, body, opts), env, {});
  return { status: res.status, json: await res.json(), res };
}

async function register(env = makeEnv(), apnsEnv = "sandbox") {
  const r = await call("/v1/register", { deviceToken: DEVICE, startToken: START, env: apnsEnv }, env);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.pass;
}

async function openPassForTest(pass) {
  const [, n, c] = pass.split(".");
  const key = await subtle.importKey("raw", passKeyRaw, "AES-GCM", false, ["decrypt"]);
  const plain = await subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(n, "base64url"), additionalData: enc.encode("openagi-relay-pass:v1") },
    key,
    Buffer.from(c, "base64url"),
  );
  return JSON.parse(dec.decode(plain));
}

async function verifyJwt(authHeader) {
  assert.match(authHeader, /^bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const token = authHeader.slice("bearer ".length);
  const [h, c, s] = token.split(".");
  const sig = Buffer.from(s, "base64url");
  assert.equal(sig.length, 64, "raw r||s signature");
  const ok = await subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    keys.publicKey,
    sig,
    enc.encode(`${h}.${c}`),
  );
  assert.ok(ok, "JWT signature verifies with the public key");
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const claims = JSON.parse(Buffer.from(c, "base64url").toString());
  assert.deepEqual(header, { alg: "ES256", kid: "KEY1234567" });
  assert.equal(claims.iss, "TEAM123456");
  assert.equal(typeof claims.iat, "number");
  return { token, claims };
}

// ---------- register ----------

test("register creates a channel and returns a pass that round-trips", async () => {
  const pass = await register();
  assert.match(pass, /^p1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.url, `https://api-manage-broadcast.sandbox.push.apple.com:2195/1/apps/${BUNDLE}/channels`);
  assert.equal(c.init.method, "POST");
  assert.deepEqual(c.body, { "message-storage-policy": 1, "push-type": "LiveActivity" });
  await verifyJwt(c.init.headers.authorization);

  const p = await openPassForTest(pass);
  assert.deepEqual(p, { d: DEVICE, s: START, ch: CHANNEL, env: "sandbox", iat: Math.floor(nowMs / 1000), exp: Math.floor(nowMs / 1000) + THIRTY_DAYS });
});

test("register uses the production channel host for env production", async () => {
  const pass = await register(makeEnv(), "production");
  assert.equal(calls[0].url, `https://api-manage-broadcast.push.apple.com:2196/1/apps/${BUNDLE}/channels`);
  assert.equal((await openPassForTest(pass)).env, "production");
});

test("register validates inputs", async () => {
  const cases = [
    [{ deviceToken: "xyz", startToken: START, env: "sandbox" }, "invalid_deviceToken"],
    [{ deviceToken: DEVICE + "a", startToken: START, env: "sandbox" }, "invalid_deviceToken"],
    [{ deviceToken: DEVICE, startToken: 42, env: "sandbox" }, "invalid_startToken"],
    [{ deviceToken: DEVICE, startToken: START, env: "dev" }, "invalid_env"],
    [{ deviceToken: DEVICE, startToken: START }, "invalid_env"],
  ];
  for (const [body, code] of cases) {
    const r = await call("/v1/register", body);
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, { error: code });
  }
  const bad = await call("/v1/register", "{not json");
  assert.deepEqual([bad.status, bad.json], [400, { error: "invalid_json" }]);
  const arr = await call("/v1/register", "[]");
  assert.deepEqual([arr.status, arr.json], [400, { error: "invalid_json" }]);
  assert.equal(calls.length, 0);
});

test("register reports channel creation failures", async () => {
  responder = () => new Response(JSON.stringify({ reason: "BadCertificateEnvironment" }), { status: 403 });
  let r = await call("/v1/register", { deviceToken: DEVICE, startToken: START, env: "sandbox" });
  assert.deepEqual([r.status, r.json], [502, { error: "channel_BadCertificateEnvironment" }]);

  responder = () => new Response(null, { status: 201 }); // no channel id header
  r = await call("/v1/register", { deviceToken: DEVICE, startToken: START, env: "sandbox" });
  assert.deepEqual([r.status, r.json], [502, { error: "channel_create_failed" }]);

  responder = () => {
    throw new TypeError("connect failed");
  };
  r = await call("/v1/register", { deviceToken: DEVICE, startToken: START, env: "sandbox" });
  assert.deepEqual([r.status, r.json], [502, { error: "apns_unreachable" }]);
});

test("register is rate limited per IP when the binding exists", async () => {
  const keysSeen = [];
  const env = makeEnv({
    REGISTER_LIMITER: {
      limit: async ({ key }) => {
        keysSeen.push(key);
        return { success: keysSeen.length <= 1 };
      },
    },
  });
  const headers = { "cf-connecting-ip": "203.0.113.9" };
  const body = { deviceToken: DEVICE, startToken: START, env: "sandbox" };
  assert.equal((await call("/v1/register", body, env, { headers })).status, 200);
  const r = await call("/v1/register", body, env, { headers });
  assert.deepEqual([r.status, r.json], [429, { error: "rate_limited" }]);
  assert.deepEqual(keysSeen, ["register:203.0.113.9", "register:203.0.113.9"]);
});

test("misconfigured secrets fail with 500 misconfigured", async () => {
  const body = { deviceToken: DEVICE, startToken: START, env: "sandbox" };
  let r = await call("/v1/register", body, makeEnv({ PASS_KEY: b64url(new Uint8Array(16)) }));
  assert.deepEqual([r.status, r.json], [500, { error: "misconfigured" }]);
  r = await call("/v1/register", body, makeEnv({ APNS_KEY_P8: "" }));
  assert.deepEqual([r.status, r.json], [500, { error: "misconfigured" }]);
  r = await call("/v1/register", body, makeEnv({ APNS_KEY_P8: privatePem("AAAA") }));
  assert.deepEqual([r.status, r.json], [500, { error: "misconfigured" }]);
  assert.equal(calls.length, 0);
});

test("p8 with literal \\n escapes is accepted", async () => {
  const env = makeEnv({ APNS_KEY_P8: keys.pem.replace(/\n/g, "\\n") });
  await register(env);
  await verifyJwt(calls[0].init.headers.authorization);
});

// ---------- send ----------

async function send(body, env = makeEnv()) {
  return call("/v1/send", body, env);
}

test("alert goes to the device token with the exact headers and payload", async () => {
  const pass = await register();
  calls = [];
  const r = await send({ pass, type: "alert", sealed: SEALED, collapseId: "fq123" });
  assert.deepEqual([r.status, r.json], [200, { ok: true, apnsId: "apns-123" }]);
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.url, `https://api.sandbox.push.apple.com/3/device/${DEVICE}`);
  const h = c.init.headers;
  assert.equal(h["apns-topic"], BUNDLE);
  assert.equal(h["apns-push-type"], "alert");
  assert.equal(h["apns-priority"], "10");
  assert.equal(h["apns-collapse-id"], "fq123");
  assert.equal(h["apns-channel-id"], undefined);
  await verifyJwt(h.authorization);
  assert.deepEqual(c.body, {
    aps: {
      alert: { title: "OpenAGI", body: "Supervisor needs you" },
      "mutable-content": 1,
      category: "SUPERVISOR_QUESTION",
      sound: "default",
      "thread-id": "supervisor",
    },
    sealed: SEALED,
  });
});

test("alert without collapseId omits the header; production uses the production host", async () => {
  const pass = await register(makeEnv(), "production");
  calls = [];
  await send({ pass, type: "alert", sealed: SEALED });
  assert.equal(calls[0].url, `https://api.push.apple.com/3/device/${DEVICE}`);
  assert.equal("apns-collapse-id" in calls[0].init.headers, false);
});

test("activity-start goes to the start token with liveactivity topic and payload", async () => {
  const pass = await register();
  calls = [];
  const staleAt = Math.floor(nowMs / 1000) + 1800;
  const r = await send({ pass, type: "activity-start", sealed: SEALED, staleAt });
  assert.deepEqual(r.json, { ok: true, apnsId: "apns-123" });
  const c = calls[0];
  assert.equal(c.url, `https://api.sandbox.push.apple.com/3/device/${START}`);
  const h = c.init.headers;
  assert.equal(h["apns-topic"], `${BUNDLE}.push-type.liveactivity`);
  assert.equal(h["apns-push-type"], "liveactivity");
  assert.equal(h["apns-priority"], "10");
  assert.equal(h["apns-channel-id"], undefined);
  await verifyJwt(h.authorization);
  assert.deepEqual(c.body, {
    aps: {
      timestamp: Math.floor(nowMs / 1000),
      event: "start",
      "content-state": { sealed: SEALED },
      "attributes-type": "SupervisorActivityAttributes",
      attributes: { slot: "fleet" },
      "input-push-channel": CHANNEL,
      alert: { title: "OpenAGI", body: "Tracking your agents" },
      "stale-date": staleAt,
    },
  });
});

test("activity-start without staleAt omits stale-date; ISO staleAt is converted", async () => {
  const pass = await register();
  calls = [];
  await send({ pass, type: "activity-start", sealed: SEALED });
  assert.equal("stale-date" in calls[0].body.aps, false);
  await send({ pass, type: "activity-start", sealed: SEALED, staleAt: "2026-10-15T12:30:00.000Z" });
  assert.equal(calls[1].body.aps["stale-date"], Date.UTC(2026, 9, 15, 12, 30) / 1000);
});

test("activity-update broadcasts on the channel with priority 5 by default", async () => {
  const pass = await register();
  calls = [];
  const staleAt = Math.floor(nowMs / 1000) + 1800;
  const r = await send({ pass, type: "activity-update", sealed: SEALED, staleAt });
  assert.deepEqual(r.json, { ok: true, apnsId: "bcast-1" });
  const c = calls[0];
  assert.equal(c.url, `https://api-broadcast.sandbox.push.apple.com/4/broadcasts/apps/${BUNDLE}`);
  const h = c.init.headers;
  assert.equal(h["apns-channel-id"], CHANNEL);
  assert.equal(h["apns-push-type"], "liveactivity");
  assert.equal(h["apns-priority"], "5");
  assert.equal(h["apns-topic"], undefined, "broadcast carries the bundle id in the path");
  assert.equal(h["apns-expiration"], String(Math.floor(nowMs / 1000) + 8 * 60 * 60));
  await verifyJwt(h.authorization);
  assert.deepEqual(c.body, {
    aps: { timestamp: Math.floor(nowMs / 1000), event: "update", "content-state": { sealed: SEALED }, "stale-date": staleAt },
  });
});

test("activity-update honours priority 10", async () => {
  const pass = await register();
  calls = [];
  await send({ pass, type: "activity-update", sealed: SEALED, priority: 10 });
  assert.equal(calls[0].init.headers["apns-priority"], "10");
  const r = await send({ pass, type: "activity-update", sealed: SEALED, priority: 7 });
  assert.deepEqual([r.status, r.json], [400, { ok: false, error: "invalid_priority" }]);
});

test("activity-end broadcasts with event end and dismissal-date", async () => {
  const pass = await register(makeEnv(), "production");
  calls = [];
  const dismissAt = Math.floor(nowMs / 1000) + 900;
  const r = await send({ pass, type: "activity-end", sealed: SEALED, dismissAt });
  assert.equal(r.json.ok, true);
  const c = calls[0];
  assert.equal(c.url, `https://api-broadcast.push.apple.com/4/broadcasts/apps/${BUNDLE}`);
  assert.equal(c.init.headers["apns-channel-id"], CHANNEL);
  assert.equal(c.init.headers["apns-priority"], "5");
  assert.deepEqual(c.body, {
    aps: {
      timestamp: Math.floor(nowMs / 1000),
      event: "end",
      "content-state": { sealed: SEALED },
      "dismissal-date": dismissAt,
    },
  });
});

test("gone mapping: 410, BadDeviceToken, Unregistered, ChannelNotRegistered", async () => {
  const pass = await register();
  const cases = [
    [410, null, "alert"],
    [410, { reason: "Unregistered" }, "activity-start"],
    [400, { reason: "BadDeviceToken" }, "alert"],
    [400, { reason: "Unregistered" }, "alert"],
    [400, { reason: "ChannelNotRegistered" }, "activity-update"],
    [404, { reason: "ChannelNotRegistered" }, "activity-end"],
  ];
  for (const [status, body, type] of cases) {
    responder = () => new Response(body ? JSON.stringify(body) : null, { status });
    const r = await send({ pass, type, sealed: SEALED });
    assert.deepEqual([r.status, r.json], [200, { ok: false, gone: true }], `${status} ${JSON.stringify(body)}`);
  }
});

test("other APNs errors and network failures return ok:false with an error", async () => {
  const pass = await register();
  responder = () => new Response(JSON.stringify({ reason: "PayloadTooLarge" }), { status: 413 });
  let r = await send({ pass, type: "alert", sealed: SEALED });
  assert.deepEqual([r.status, r.json], [502, { ok: false, error: "PayloadTooLarge" }]);
  responder = () => new Response("oops", { status: 500 });
  r = await send({ pass, type: "alert", sealed: SEALED });
  assert.deepEqual([r.status, r.json], [502, { ok: false, error: "apns_500" }]);
  responder = () => {
    throw new TypeError("network");
  };
  r = await send({ pass, type: "alert", sealed: SEALED });
  assert.deepEqual([r.status, r.json], [502, { ok: false, error: "apns_unreachable" }]);
});

test("bad, tampered, foreign and wrong-AAD passes are rejected", async () => {
  const pass = await register();
  calls = [];
  const [, n, c] = pass.split(".");
  const ct = Buffer.from(c, "base64url");
  ct[0] ^= 1;
  const tampered = `p1.${n}.${b64url(ct)}`;
  const otherKeyEnv = makeEnv({ PASS_KEY: b64url(webcrypto.getRandomValues(new Uint8Array(32))) });
  const foreign = await sealPass(otherKeyEnv, { d: DEVICE, s: START, ch: CHANNEL, env: "sandbox", iat: 1 });

  // Same key, but sealed with a different AAD.
  const key = await subtle.importKey("raw", passKeyRaw, "AES-GCM", false, ["encrypt"]);
  const nonce = webcrypto.getRandomValues(new Uint8Array(12));
  const wrongAad = await subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: enc.encode("openagi-push:v1:alert") },
    key,
    enc.encode(JSON.stringify({ d: DEVICE, s: START, ch: CHANNEL, env: "sandbox", iat: 1 })),
  );
  // Same bytes, different spelling: the final character's unused padding
  // bits changed. Ciphertext length is chosen so those bits exist.
  let aliasCt;
  for (let pad = ""; !aliasCt || aliasCt.byteLength % 3 === 0; pad += "x") {
    aliasCt = await subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: enc.encode("openagi-relay-pass:v1") },
      key,
      enc.encode(JSON.stringify({ d: DEVICE, env: "sandbox", iat: Math.floor(nowMs / 1000), pad })),
    );
  }
  const aliasSeg = b64url(new Uint8Array(aliasCt));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = aliasSeg.at(-1);
  const twin = [...alphabet].find(
    (ch) => ch !== last && Buffer.from(aliasSeg.slice(0, -1) + ch, "base64url").equals(Buffer.from(aliasSeg, "base64url")),
  );
  assert.ok(twin, "ciphertext length leaves padding bits");
  const canonical = `p1.${b64url(nonce)}.${aliasSeg}`;
  assert.equal((await send({ pass: canonical, type: "alert", sealed: SEALED })).json.ok, true);
  calls = [];
  const alias = `p1.${b64url(nonce)}.${aliasSeg.slice(0, -1)}${twin}`;
  // Valid seal, invalid contents.
  const badShape = await sealPass(makeEnv(), { d: DEVICE, s: START, ch: CHANNEL, env: "staging", iat: 1 });

  for (const p of [
    undefined,
    "",
    "nope",
    pass.replace(/^p1/, "p2"),
    tampered,
    foreign,
    `p1.${b64url(nonce)}.${b64url(wrongAad)}`,
    `p1.${b64url(new Uint8Array(8))}.${c}`,
    badShape,
    "p1." + "A".repeat(2100) + ".AAAA",
    alias,
  ]) {
    const r = await send({ pass: p, type: "alert", sealed: SEALED });
    assert.deepEqual([r.status, r.json], [400, { ok: false, error: "bad_pass" }], String(p).slice(0, 20));
  }
  assert.equal(calls.length, 0);
});

test("send validation errors", async () => {
  const pass = await register();
  calls = [];
  const cases = [
    [{ type: "push" }, "invalid_type"],
    [{ type: "alert", sealed: undefined }, "invalid_sealed"],
    [{ type: "alert", sealed: "v2.AAAA.BBBB" }, "invalid_sealed"],
    [{ type: "alert", sealed: "v1.AAAA" }, "invalid_sealed"],
    [{ type: "alert", sealed: 'v1.AA"AA.BBBB' }, "invalid_sealed"],
    [{ type: "alert", sealed: "v1.A." + "B".repeat(3000) }, "invalid_sealed"],
    [{ type: "alert", collapseId: "x".repeat(65) }, "invalid_collapseId"],
    [{ type: "alert", collapseId: 5 }, "invalid_collapseId"],
    [{ type: "activity-start", staleAt: "tomorrow" }, "invalid_staleAt"],
    [{ type: "activity-end", dismissAt: -1 }, "invalid_dismissAt"],
    [{ type: "activity-update", priority: "10" }, "invalid_priority"],
  ];
  for (const [extra, code] of cases) {
    const r = await send({ pass, sealed: SEALED, ...extra });
    assert.deepEqual([r.status, r.json], [400, { ok: false, error: code }], JSON.stringify(extra).slice(0, 60));
  }
  // Exactly 3000 chars is allowed.
  const max = "v1.A." + "B".repeat(3000 - 5);
  assert.equal(max.length, 3000);
  const ok = await send({ pass, type: "alert", sealed: max });
  assert.equal(ok.json.ok, true);
  assert.equal(calls.length, 1);
});

test("bodies over 8 KB are rejected with 413", async () => {
  const pass = await register();
  calls = [];
  const big = JSON.stringify({ pass, type: "alert", sealed: SEALED, pad: "x".repeat(8 * 1024) });
  let r = await call("/v1/send", big);
  assert.deepEqual([r.status, r.json], [413, { ok: false, error: "payload_too_large" }]);
  r = await call("/v1/register", JSON.stringify({ pad: "x".repeat(9000) }));
  assert.deepEqual([r.status, r.json], [413, { error: "payload_too_large" }]);
  assert.equal(calls.length, 0);
});

test("send is rate limited per pass when the binding exists, and skipped without it", async () => {
  const pass = await register();
  const seen = [];
  const env = makeEnv({
    SEND_LIMITER: {
      limit: async ({ key }) => {
        seen.push(key);
        return { success: seen.length <= 2 };
      },
    },
  });
  assert.equal((await send({ pass, type: "alert", sealed: SEALED }, env)).json.ok, true);
  assert.equal((await send({ pass, type: "alert", sealed: SEALED }, env)).json.ok, true);
  const r = await send({ pass, type: "alert", sealed: SEALED }, env);
  assert.deepEqual([r.status, r.json], [429, { ok: false, error: "rate_limited" }]);
  assert.equal(new Set(seen).size, 1);
  assert.match(seen[0], /^send:[0-9a-f]{32}$/);
  assert.equal(seen[0].includes(pass), false, "limiter key is a hash, not the pass");
  for (let i = 0; i < 5; i++) assert.equal((await send({ pass, type: "alert", sealed: SEALED })).json.ok, true);
});

test("APNs JWT is cached for 50 minutes then re-minted", async () => {
  const pass = await register();
  const first = await verifyJwt(calls[0].init.headers.authorization);
  nowMs += 49 * 60 * 1000;
  await send({ pass, type: "alert", sealed: SEALED });
  assert.equal(calls[1].init.headers.authorization, `bearer ${first.token}`);
  nowMs += 2 * 60 * 1000; // 51 min after minting
  await send({ pass, type: "alert", sealed: SEALED });
  const third = await verifyJwt(calls[2].init.headers.authorization);
  assert.notEqual(third.token, first.token);
  assert.equal(third.claims.iat, Math.floor(nowMs / 1000));
  await send({ pass, type: "activity-update", sealed: SEALED });
  assert.equal(calls[3].init.headers.authorization, `bearer ${third.token}`);
});

test("routing: 404 for unknown paths, 405 for wrong methods, health check", async () => {
  let r = await call("/v1/nope", {});
  assert.deepEqual([r.status, r.json], [404, { error: "not_found" }]);
  r = await call("/v1/send", undefined, makeEnv(), { method: "GET" });
  assert.deepEqual([r.status, r.json], [405, { error: "method_not_allowed" }]);
  r = await call("/v1/health", undefined, makeEnv(), { method: "GET" });
  assert.deepEqual([r.status, r.json], [200, { ok: true }]);
  assert.equal(r.res.headers.get("content-type").startsWith("application/json"), true);
});

// ---------- amendments: optional startToken, unregister ----------

test("register without startToken creates no channel and the pass has no s/ch", async () => {
  for (const extra of [{}, { startToken: null }]) {
    calls = [];
    const r = await call("/v1/register", { deviceToken: DEVICE, env: "sandbox", ...extra });
    assert.equal(r.status, 200);
    assert.equal(calls.length, 0, "no channel-management call");
    const p = await openPassForTest(r.json.pass);
    assert.deepEqual(p, { d: DEVICE, env: "sandbox", iat: Math.floor(nowMs / 1000), exp: Math.floor(nowMs / 1000) + THIRTY_DAYS });
  }
  const bad = await call("/v1/register", { deviceToken: DEVICE, startToken: "", env: "sandbox" });
  assert.deepEqual([bad.status, bad.json], [400, { error: "invalid_startToken" }]);
});

test("alert-only pass: alerts work, activity-* return 400 no_live_activity", async () => {
  const r0 = await call("/v1/register", { deviceToken: DEVICE, env: "production" });
  const pass = r0.json.pass;
  const a = await send({ pass, type: "alert", sealed: SEALED });
  assert.deepEqual(a.json, { ok: true, apnsId: "apns-123" });
  assert.equal(calls[0].url, `https://api.push.apple.com/3/device/${DEVICE}`);
  for (const type of ["activity-start", "activity-update", "activity-end"]) {
    const r = await send({ pass, type, sealed: SEALED });
    assert.deepEqual([r.status, r.json], [400, { ok: false, error: "no_live_activity" }]);
  }
  assert.equal(calls.length, 1);
});

test("a pass with only one of s/ch is rejected", async () => {
  const half = await sealPass(makeEnv(), { d: DEVICE, s: START, env: "sandbox", iat: 1 });
  const r = await send({ pass: half, type: "alert", sealed: SEALED });
  assert.deepEqual([r.status, r.json], [400, { ok: false, error: "bad_pass" }]);
});

test("unregister deletes the channel on the right host with apns-channel-id", async () => {
  for (const [apnsEnv, host] of [
    ["sandbox", "https://api-manage-broadcast.sandbox.push.apple.com:2195"],
    ["production", "https://api-manage-broadcast.push.apple.com:2196"],
  ]) {
    const pass = await register(makeEnv(), apnsEnv);
    calls = [];
    const r = await call("/v1/unregister", { pass });
    assert.deepEqual([r.status, r.json], [200, { ok: true }]);
    assert.equal(calls.length, 1);
    const c = calls[0];
    assert.equal(c.url, `${host}/1/apps/${BUNDLE}/channels`);
    assert.equal(c.init.method, "DELETE");
    assert.equal(c.init.headers["apns-channel-id"], CHANNEL);
    assert.equal(c.init.body, undefined);
    await verifyJwt(c.init.headers.authorization);
  }
});

test("unregister treats an already-gone channel as ok and reports other failures", async () => {
  const pass = await register();
  for (const [status, body] of [
    [404, null],
    [410, null],
    [400, { reason: "ChannelNotRegistered" }],
  ]) {
    responder = () => new Response(body ? JSON.stringify(body) : null, { status });
    const r = await call("/v1/unregister", { pass });
    assert.deepEqual([r.status, r.json], [200, { ok: true }], String(status));
  }
  responder = () => new Response(JSON.stringify({ reason: "InternalServerError" }), { status: 500 });
  let r = await call("/v1/unregister", { pass });
  assert.deepEqual([r.status, r.json], [502, { ok: false, error: "InternalServerError" }]);
  responder = () => {
    throw new TypeError("blocked port");
  };
  r = await call("/v1/unregister", { pass });
  assert.deepEqual([r.status, r.json], [502, { ok: false, error: "apns_unreachable" }]);
});

test("unregister with an alert-only pass is ok without calling APNs; bad pass is 400", async () => {
  const r0 = await call("/v1/register", { deviceToken: DEVICE, env: "sandbox" });
  calls = [];
  const r = await call("/v1/unregister", { pass: r0.json.pass });
  assert.deepEqual([r.status, r.json], [200, { ok: true }]);
  assert.equal(calls.length, 0);
  const bad = await call("/v1/unregister", { pass: "p1.AAAA.BBBB" });
  assert.deepEqual([bad.status, bad.json], [400, { ok: false, error: "bad_pass" }]);
  const get = await call("/v1/unregister", undefined, makeEnv(), { method: "GET" });
  assert.equal(get.status, 405);
});

// ---------- round 2: pass expiry and revocation ----------

function fakeKv() {
  const store = new Map();
  const puts = [];
  return {
    store,
    puts,
    async get(k) {
      return store.has(k) ? store.get(k) : null;
    },
    async put(k, v, opts) {
      puts.push({ k, v, opts });
      store.set(k, v);
    },
  };
}

async function sha256HexForTest(str) {
  const d = new Uint8Array(await subtle.digest("SHA-256", enc.encode(str)));
  return Buffer.from(d).toString("hex");
}

test("pass expires 30 days after iat with 400 pass_expired", async () => {
  const pass = await register();
  nowMs += (THIRTY_DAYS - 1) * 1000;
  assert.equal((await send({ pass, type: "alert", sealed: SEALED })).json.ok, true);
  nowMs += 1000;
  for (const path of ["/v1/send", "/v1/unregister"]) {
    const r = await call(path, { pass, type: "alert", sealed: SEALED });
    assert.deepEqual([r.status, r.json], [400, { ok: false, error: "pass_expired" }], path);
  }
});

test("legacy pass without exp expires at iat + 30 days; non-numeric times are bad_pass", async () => {
  const iat = Math.floor(nowMs / 1000) - THIRTY_DAYS;
  const legacy = await sealPass(makeEnv(), { d: DEVICE, env: "sandbox", iat });
  let r = await send({ pass: legacy, type: "alert", sealed: SEALED });
  assert.deepEqual([r.status, r.json], [400, { ok: false, error: "pass_expired" }]);
  const fresh = await sealPass(makeEnv(), { d: DEVICE, env: "sandbox", iat: iat + 10 });
  assert.equal((await send({ pass: fresh, type: "alert", sealed: SEALED })).json.ok, true);
  const noTimes = await sealPass(makeEnv(), { d: DEVICE, env: "sandbox" });
  r = await send({ pass: noTimes, type: "alert", sealed: SEALED });
  assert.deepEqual([r.status, r.json], [400, { ok: false, error: "bad_pass" }]);
});

test("unregister revokes the pass in KV with TTL = remaining life", async () => {
  const kv = fakeKv();
  const env = makeEnv({ REVOKED: kv });
  const pass = await register(env);
  nowMs += 10 * 24 * 60 * 60 * 1000; // 10 days later
  const r = await call("/v1/unregister", { pass }, env);
  assert.deepEqual([r.status, r.json], [200, { ok: true }]);
  assert.equal(kv.puts.length, 1);
  assert.equal(kv.puts[0].k, `revoked:${await sha256HexForTest(pass)}`);
  assert.equal(kv.puts[0].k.includes(pass), false);
  assert.deepEqual(kv.puts[0].opts, { expirationTtl: 20 * 24 * 60 * 60 });

  calls = [];
  for (const path of ["/v1/send", "/v1/unregister"]) {
    const x = await call(path, { pass, type: "alert", sealed: SEALED }, env);
    assert.deepEqual([x.status, x.json], [400, { ok: false, error: "pass_revoked" }], path);
  }
  assert.equal(calls.length, 0);
  // Without the binding, the same pass still works (exp bounds it).
  assert.equal((await send({ pass, type: "alert", sealed: SEALED })).json.ok, true);
});

test("revocation TTL is at least 60 s; alert-only passes are revoked too", async () => {
  const kv = fakeKv();
  const env = makeEnv({ REVOKED: kv });
  const r0 = await call("/v1/register", { deviceToken: DEVICE, env: "sandbox" }, env);
  nowMs += (THIRTY_DAYS - 5) * 1000;
  const r = await call("/v1/unregister", { pass: r0.json.pass }, env);
  assert.deepEqual(r.json, { ok: true });
  assert.deepEqual(kv.puts[0].opts, { expirationTtl: 60 });
});

test("failed channel delete does not revoke, so it can be retried", async () => {
  const kv = fakeKv();
  const env = makeEnv({ REVOKED: kv });
  const pass = await register(env);
  responder = () => new Response(JSON.stringify({ reason: "InternalServerError" }), { status: 500 });
  const r = await call("/v1/unregister", { pass }, env);
  assert.equal(r.status, 502);
  assert.equal(kv.puts.length, 0);
  responder = defaultResponder;
  assert.deepEqual((await call("/v1/unregister", { pass }, env)).json, { ok: true });
  assert.equal(kv.puts.length, 1);
});

test("KV errors fail open", async () => {
  const pass = await register();
  const env = makeEnv({
    REVOKED: {
      async get() {
        throw new Error("kv down");
      },
      async put() {
        throw new Error("kv down");
      },
    },
  });
  assert.equal((await send({ pass, type: "alert", sealed: SEALED }, env)).json.ok, true);
  assert.deepEqual((await call("/v1/unregister", { pass }, env)).json, { ok: true });
});
