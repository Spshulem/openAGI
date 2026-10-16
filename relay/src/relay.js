// OpenAGI push relay core. Stateless: everything it needs per phone lives in
// the sealed "pass" the phone carries. It never sees push content in
// plaintext; "sealed" envelopes are forwarded as opaque strings.
//
// WebCrypto only. No logging of bodies, tokens, or passes.

const MAX_BODY_BYTES = 8 * 1024;
const MAX_SEALED = 3000;
const MAX_PASS = 2000;
const MAX_COLLAPSE_ID_BYTES = 64;
const JWT_TTL_MS = 50 * 60 * 1000;
const PASS_TTL_S = 30 * 24 * 60 * 60;
const MIN_KV_TTL_S = 60;
const PASS_AAD = "openagi-relay-pass:v1";
const DEFAULT_BUNDLE_ID = "sh.openagi.OpenAGI";
const GONE_REASONS = new Set(["BadDeviceToken", "Unregistered", "ChannelNotRegistered"]);
const SEND_TYPES = new Set(["alert", "activity-start", "activity-update", "activity-end"]);
const ENVS = new Set(["sandbox", "production"]);
const HEX_TOKEN = /^[0-9a-fA-F]{32,512}$/;
const SEALED_RE = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const PASS_RE = /^p1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

const enc = new TextEncoder();
const dec = new TextDecoder();

let clock = () => Date.now();
let jwtCache = null; // { id, token, mintedAt }

// Test hooks (not part of the Worker entrypoint).
export function _setClock(fn) {
  clock = fn || (() => Date.now());
}
export function _resetCaches() {
  jwtCache = null;
}

// ---------- helpers ----------

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function b64urlEncode(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  if (typeof str !== "string" || !/^[A-Za-z0-9_-]*$/.test(str)) throw new Error("bad base64url");
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64Decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

async function readJsonBody(request) {
  const len = Number(request.headers.get("content-length"));
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large");
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large");
  let body;
  try {
    body = JSON.parse(dec.decode(buf));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  if (!isPlainObject(body)) throw new HttpError(400, "invalid_json");
  return body;
}

function bundleId(env) {
  return (env && env.BUNDLE_ID) || DEFAULT_BUNDLE_ID;
}

function apnsHost(apnsEnv) {
  return apnsEnv === "production" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
}

function manageHost(apnsEnv) {
  return apnsEnv === "production"
    ? "https://api-manage-broadcast.push.apple.com:2196"
    : "https://api-manage-broadcast.sandbox.push.apple.com:2195";
}

// Accepts epoch seconds (number) or an ISO-8601 string; returns epoch seconds.
function toEpochSeconds(v, field) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  if (typeof v === "string" && v.length <= 40) {
    const ms = Date.parse(v);
    if (Number.isFinite(ms) && ms > 0) return Math.floor(ms / 1000);
  }
  throw new HttpError(400, `invalid_${field}`);
}

async function rateLimit(binding, key) {
  if (!binding || typeof binding.limit !== "function") return true;
  try {
    const res = await binding.limit({ key });
    return !res || res.success !== false;
  } catch {
    return true; // fail open: a limiter outage should not stop pushes
  }
}

async function sha256Hex(str) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(str)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- revocation (optional KV binding REVOKED) ----------

function revokedKey(passHash) {
  return `revoked:${passHash}`;
}

async function assertNotRevoked(env, passHash) {
  const kv = env.REVOKED;
  if (!kv || typeof kv.get !== "function") return;
  let hit = null;
  try {
    hit = await kv.get(revokedKey(passHash));
  } catch {
    return; // fail open: exp still bounds the pass
  }
  if (hit !== null && hit !== undefined) throw new HttpError(400, "pass_revoked");
}

async function revoke(env, passHash, exp) {
  const kv = env.REVOKED;
  if (!kv || typeof kv.put !== "function") return;
  const ttl = Math.max(MIN_KV_TTL_S, Math.ceil(exp - clock() / 1000));
  try {
    await kv.put(revokedKey(passHash), "1", { expirationTtl: ttl });
  } catch {
    // best effort; exp bounds the pass
  }
}

// ---------- pass sealing ----------

async function passKey(env) {
  let raw;
  try {
    raw = b64urlDecode(String(env.PASS_KEY || "").trim().replace(/=+$/, ""));
  } catch {
    raw = null;
  }
  if (!raw || raw.length !== 32) throw new HttpError(500, "misconfigured");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function sealPass(env, payload) {
  const key = await passKey(env);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: enc.encode(PASS_AAD), tagLength: 128 },
    key,
    enc.encode(JSON.stringify(payload)),
  );
  return `p1.${b64urlEncode(nonce)}.${b64urlEncode(ct)}`;
}

export async function openPass(env, pass) {
  if (typeof pass !== "string" || pass.length > MAX_PASS) throw new HttpError(400, "bad_pass");
  const m = PASS_RE.exec(pass);
  if (!m) throw new HttpError(400, "bad_pass");
  const key = await passKey(env);
  let plain;
  try {
    const nonce = b64urlDecode(m[1]);
    const ct = b64urlDecode(m[2]);
    if (nonce.length !== 12 || ct.length < 17) throw new Error("bad sizes");
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: enc.encode(PASS_AAD), tagLength: 128 },
      key,
      ct,
    );
  } catch {
    throw new HttpError(400, "bad_pass");
  }
  let p;
  try {
    p = JSON.parse(dec.decode(plain));
  } catch {
    throw new HttpError(400, "bad_pass");
  }
  if (
    !isPlainObject(p) ||
    typeof p.d !== "string" ||
    !p.d ||
    (p.s !== undefined && (typeof p.s !== "string" || !p.s)) ||
    (p.ch !== undefined && (typeof p.ch !== "string" || !p.ch)) ||
    (p.s === undefined) !== (p.ch === undefined) ||
    !ENVS.has(p.env)
  ) {
    throw new HttpError(400, "bad_pass");
  }
  // Passes minted before exp existed expire 30 days after iat.
  const exp = typeof p.exp === "number" ? p.exp : typeof p.iat === "number" ? p.iat + PASS_TTL_S : NaN;
  if (!Number.isFinite(exp)) throw new HttpError(400, "bad_pass");
  if (clock() / 1000 >= exp) throw new HttpError(400, "pass_expired");
  p.exp = exp;
  return p;
}

// ---------- APNs JWT (ES256) ----------

function pemToPkcs8(pem) {
  const body = String(pem || "")
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  if (!body) throw new HttpError(500, "misconfigured");
  try {
    return b64Decode(body);
  } catch {
    throw new HttpError(500, "misconfigured");
  }
}

async function apnsJwt(env) {
  const keyId = env.APNS_KEY_ID;
  const teamId = env.APNS_TEAM_ID;
  const p8 = env.APNS_KEY_P8;
  if (!keyId || !teamId || !p8) throw new HttpError(500, "misconfigured");
  const id = `${keyId}|${teamId}|${p8}`;
  const now = clock();
  if (jwtCache && jwtCache.id === id && now - jwtCache.mintedAt < JWT_TTL_MS && now >= jwtCache.mintedAt) {
    return jwtCache.token;
  }
  let key;
  try {
    key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(p8), { name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
    ]);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, "misconfigured");
  }
  const header = b64urlEncode(enc.encode(JSON.stringify({ alg: "ES256", kid: keyId })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) })));
  const input = `${header}.${claims}`;
  // WebCrypto ECDSA returns the raw IEEE P1363 r||s (64 bytes), which is
  // exactly the JWS ES256 signature format (no DER conversion needed).
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(input));
  const token = `${input}.${b64urlEncode(sig)}`;
  jwtCache = { id, token, mintedAt: now };
  return token;
}

async function apnsFetch(url, headers, payload, method = "POST") {
  let res;
  try {
    const init = { method, headers };
    if (payload !== undefined) init.body = JSON.stringify(payload);
    res = await fetch(url, init);
  } catch {
    return { network: true };
  }
  let reason = null;
  try {
    const text = await res.text();
    if (text) {
      const j = JSON.parse(text);
      if (j && typeof j.reason === "string") reason = j.reason;
    }
  } catch {
    // non-JSON body; ignore
  }
  return { status: res.status, ok: res.ok, headers: res.headers, reason };
}

// ---------- routes ----------

async function handleRegister(request, env) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (!(await rateLimit(env.REGISTER_LIMITER, `register:${ip}`))) throw new HttpError(429, "rate_limited");
  const body = await readJsonBody(request);
  const { deviceToken, startToken, env: apnsEnv } = body;
  if (typeof deviceToken !== "string" || !HEX_TOKEN.test(deviceToken) || deviceToken.length % 2) {
    throw new HttpError(400, "invalid_deviceToken");
  }
  const hasStart = startToken !== undefined && startToken !== null;
  if (hasStart && (typeof startToken !== "string" || !HEX_TOKEN.test(startToken) || startToken.length % 2)) {
    throw new HttpError(400, "invalid_startToken");
  }
  if (!ENVS.has(apnsEnv)) throw new HttpError(400, "invalid_env");

  await passKey(env); // fail before touching APNs if misconfigured
  const claims = { d: deviceToken.toLowerCase() };
  if (hasStart) {
    // Live Activity support: one broadcast channel per registration.
    const jwt = await apnsJwt(env);
    const r = await apnsFetch(
      `${manageHost(apnsEnv)}/1/apps/${bundleId(env)}/channels`,
      { authorization: `bearer ${jwt}`, "content-type": "application/json" },
      { "message-storage-policy": 1, "push-type": "LiveActivity" },
    );
    if (r.network) throw new HttpError(502, "apns_unreachable");
    const channelId = r.ok ? r.headers.get("apns-channel-id") : null;
    if (!channelId) throw new HttpError(502, r.reason ? `channel_${r.reason}` : "channel_create_failed");
    claims.s = startToken.toLowerCase();
    claims.ch = channelId;
  }

  const iat = Math.floor(clock() / 1000);
  const pass = await sealPass(env, { ...claims, env: apnsEnv, iat, exp: iat + PASS_TTL_S });
  return json(200, { pass });
}

function validateSend(body) {
  const { type, sealed, collapseId, priority } = body;
  if (!SEND_TYPES.has(type)) throw new HttpError(400, "invalid_type");
  if (typeof sealed !== "string" || sealed.length > MAX_SEALED || !sealed.startsWith("v1.") || !SEALED_RE.test(sealed)) {
    throw new HttpError(400, "invalid_sealed");
  }
  if (collapseId !== undefined && collapseId !== null) {
    if (typeof collapseId !== "string" || !collapseId || enc.encode(collapseId).length > MAX_COLLAPSE_ID_BYTES) {
      throw new HttpError(400, "invalid_collapseId");
    }
  }
  if (priority !== undefined && priority !== null && priority !== 5 && priority !== 10) {
    throw new HttpError(400, "invalid_priority");
  }
  return {
    type,
    sealed,
    collapseId: collapseId || undefined,
    priority: priority || undefined,
    staleAt: toEpochSeconds(body.staleAt, "staleAt"),
    dismissAt: toEpochSeconds(body.dismissAt, "dismissAt"),
  };
}

function buildRequest(env, p, s, nowSec, jwt) {
  const bid = bundleId(env);
  const base = { authorization: `bearer ${jwt}`, "content-type": "application/json" };
  if (s.type === "alert") {
    const headers = { ...base, "apns-topic": bid, "apns-push-type": "alert", "apns-priority": "10" };
    if (s.collapseId) headers["apns-collapse-id"] = s.collapseId;
    return {
      url: `${apnsHost(p.env)}/3/device/${p.d}`,
      headers,
      payload: {
        aps: {
          alert: { title: "OpenAGI", body: "Supervisor needs you" },
          "mutable-content": 1,
          category: "SUPERVISOR_QUESTION",
          sound: "default",
          "thread-id": "supervisor",
        },
        sealed: s.sealed,
      },
    };
  }
  if (s.type === "activity-start") {
    const aps = {
      timestamp: nowSec,
      event: "start",
      "content-state": { sealed: s.sealed },
      "attributes-type": "SupervisorActivityAttributes",
      attributes: { slot: "fleet" },
      "input-push-channel": p.ch,
      alert: { title: "OpenAGI", body: "Tracking your agents" },
    };
    if (s.staleAt !== undefined) aps["stale-date"] = s.staleAt;
    return {
      url: `${apnsHost(p.env)}/3/device/${p.s}`,
      headers: {
        ...base,
        "apns-topic": `${bid}.push-type.liveactivity`,
        "apns-push-type": "liveactivity",
        "apns-priority": "10",
      },
      payload: { aps },
    };
  }
  // activity-update / activity-end: broadcast on the channel.
  const aps = {
    timestamp: nowSec,
    event: s.type === "activity-end" ? "end" : "update",
    "content-state": { sealed: s.sealed },
  };
  if (s.staleAt !== undefined) aps["stale-date"] = s.staleAt;
  if (s.dismissAt !== undefined) aps["dismissal-date"] = s.dismissAt;
  return {
    url: `${apnsHost(p.env)}/4/broadcasts/apps/${bid}`,
    headers: {
      ...base,
      "apns-channel-id": p.ch,
      "apns-push-type": "liveactivity",
      "apns-priority": String(s.priority || 5),
    },
    payload: { aps },
  };
}

async function handleSend(request, env) {
  const body = await readJsonBody(request);
  const p = await openPass(env, body.pass);
  const passHash = await sha256Hex(body.pass);
  await assertNotRevoked(env, passHash);
  if (!(await rateLimit(env.SEND_LIMITER, `send:${passHash.slice(0, 32)}`))) {
    throw new HttpError(429, "rate_limited");
  }
  const s = validateSend(body);
  if (s.type !== "alert" && !p.ch) throw new HttpError(400, "no_live_activity");
  const jwt = await apnsJwt(env);
  const req = buildRequest(env, p, s, Math.floor(clock() / 1000), jwt);
  const r = await apnsFetch(req.url, req.headers, req.payload);
  if (r.network) return json(502, { ok: false, error: "apns_unreachable" });
  if (r.ok) {
    const apnsId =
      r.headers.get("apns-id") || r.headers.get("apns-request-id") || r.headers.get("apns-unique-id") || null;
    return json(200, { ok: true, apnsId });
  }
  if (r.status === 410 || (r.reason && GONE_REASONS.has(r.reason))) {
    return json(200, { ok: false, gone: true });
  }
  return json(502, { ok: false, error: r.reason || `apns_${r.status}` });
}

async function handleUnregister(request, env) {
  const body = await readJsonBody(request);
  const p = await openPass(env, body.pass);
  const passHash = await sha256Hex(body.pass);
  await assertNotRevoked(env, passHash);
  if (!(await rateLimit(env.SEND_LIMITER, `send:${passHash.slice(0, 32)}`))) {
    throw new HttpError(429, "rate_limited");
  }
  if (!p.ch) {
    await revoke(env, passHash, p.exp);
    return json(200, { ok: true });
  }
  const jwt = await apnsJwt(env);
  const r = await apnsFetch(
    `${manageHost(p.env)}/1/apps/${bundleId(env)}/channels`,
    { authorization: `bearer ${jwt}`, "apns-channel-id": p.ch },
    undefined,
    "DELETE",
  );
  if (r.network) return json(502, { ok: false, error: "apns_unreachable" });
  // Already gone counts as done.
  if (r.ok || r.status === 404 || r.status === 410 || r.reason === "ChannelNotRegistered") {
    // Revoke only once the channel is gone, so a failed delete can be retried.
    await revoke(env, passHash, p.exp);
    return json(200, { ok: true });
  }
  return json(502, { ok: false, error: r.reason || `apns_${r.status}` });
}

export async function handle(request, env = {}) {
  const url = new URL(request.url);
  const routes = {
    "/v1/register": handleRegister,
    "/v1/send": handleSend,
    "/v1/unregister": handleUnregister,
  };
  try {
    if (url.pathname === "/v1/health" && request.method === "GET") return json(200, { ok: true });
    const route = routes[url.pathname];
    if (!route) return json(404, { error: "not_found" });
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    return await route(request, env);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    const code = e instanceof HttpError ? e.code : "internal";
    return url.pathname === "/v1/send" || url.pathname === "/v1/unregister" ? json(status, { ok: false, error: code }) : json(status, { error: code });
  }
}
