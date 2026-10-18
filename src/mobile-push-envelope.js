import crypto from "node:crypto";

// The end-to-end envelope around everything the daemon pushes to a phone
// through the relay (docs/superpowers/specs/2026-10-15-ios-supervisor-push-design.md).
// The relay forwards the wire string untouched and never holds the key: the
// phone generated it and handed it to this daemon over the tailnet only.
//
// Wire string: v1.<base64url(nonce)>.<base64url(ciphertext || tag)>, AES-256-GCM,
// 12-byte nonce, 16-byte tag, AAD "openagi-push:v1:<kind>". The AAD binds the
// kind, so an alert's ciphertext can never be replayed as activity content.
// The Swift side (PushEnvelope) must stay byte-for-byte compatible; the
// shared fixture mobile/fixtures/push-envelope.json pins both.
export const PUSH_ENVELOPE_VERSION = "v1";
export const PUSH_KINDS = Object.freeze(["activity", "alert"]);

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const B64URL = /^[A-Za-z0-9_-]+$/;

// base64url without padding, and canonical: the string must re-encode to
// itself, so two spellings of one key cannot both be accepted.
function decodeB64url(value) {
  if (typeof value !== "string" || !B64URL.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.toString("base64url") === value ? bytes : null;
}

/// The phone's 32-byte key as a Buffer, or null when it is anything else.
export function decodePushKey(value) {
  const bytes = decodeB64url(value);
  return bytes && bytes.length === KEY_BYTES ? bytes : null;
}

function aadFor(kind) {
  if (!PUSH_KINDS.includes(kind)) throw new Error(`unknown push envelope kind: ${kind}`);
  return Buffer.from(`openagi-push:${PUSH_ENVELOPE_VERSION}:${kind}`, "utf8");
}

function keyBytes(key) {
  const bytes = Buffer.isBuffer(key) ? key : decodePushKey(key);
  if (!bytes || bytes.length !== KEY_BYTES) throw new Error("push key must be 32 bytes");
  return bytes;
}

/// Seal a plaintext (a string, or a value sent as JSON) into a wire string.
/// `nonce` is a test seam only; production always draws a fresh one.
export function sealPushEnvelope(key, kind, plaintext, { nonce } = {}) {
  const iv = nonce ?? crypto.randomBytes(NONCE_BYTES);
  if (iv.length !== NONCE_BYTES) throw new Error("push nonce must be 12 bytes");
  const text = typeof plaintext === "string" ? plaintext : JSON.stringify(plaintext);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBytes(key), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadFor(kind));
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${PUSH_ENVELOPE_VERSION}.${iv.toString("base64url")}.${body.toString("base64url")}`;
}

/// Open a wire string back to its UTF-8 plaintext. Throws on any mismatch:
/// wrong key, wrong kind, a tampered byte, or a malformed string.
export function openPushEnvelope(key, kind, wire) {
  const parts = typeof wire === "string" ? wire.split(".") : [];
  if (parts.length !== 3 || parts[0] !== PUSH_ENVELOPE_VERSION) throw new Error("malformed push envelope");
  const iv = decodeB64url(parts[1]);
  const body = decodeB64url(parts[2]);
  if (!iv || iv.length !== NONCE_BYTES || !body || body.length < TAG_BYTES) throw new Error("malformed push envelope");
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBytes(key), iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(aadFor(kind));
  decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
  return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]).toString("utf8");
}
