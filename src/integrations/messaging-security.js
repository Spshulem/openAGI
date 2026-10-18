import { createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";

function equal(a, b) {
  return a.length === b.length && timingSafeEqual(a, b);
}
function base64(value) {
  if (typeof value !== "string" || value.length > 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64").replace(/=+$/, "") === value.replace(/=+$/, "") ? bytes : null;
}
function fresh(value, now) {
  return typeof value === "string" && /^\d{1,12}$/.test(value) && Math.abs(now / 1000 - Number(value)) <= 300;
}

// Standard Webhooks: sign the original bytes, including whitespace, after
// the delivery ID and Unix timestamp. Multiple v1 signatures allow rotation.
export function verifyStandardWebhook(headers, raw, secret, now = Date.now()) {
  const id = headers["webhook-id"], timestamp = headers["webhook-timestamp"], signatures = headers["webhook-signature"];
  if (typeof id !== "string" || !id || id.length > 300 || !fresh(timestamp, now) || typeof signatures !== "string" || signatures.length > 4096) return false;
  const key = typeof secret === "string" && secret.startsWith("whsec_") ? base64(secret.slice(6)) : null;
  if (!key?.length) return false;
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(raw).digest();
  return signatures.split(/\s+/).some(part => {
    const [version, encoded] = part.split(",");
    const signature = version === "v1" ? base64(encoded) : null;
    return signature !== null && equal(signature, expected);
  });
}

export function verifyTelnyxWebhook(headers, raw, publicKey, now = Date.now()) {
  const timestamp = headers["telnyx-timestamp"];
  if (!fresh(timestamp, now)) return false;
  const key = base64(publicKey), signature = base64(headers["telnyx-signature-ed25519"]);
  if (key?.length !== 32 || signature?.length !== 64) return false;
  try {
    // RFC 8410 SubjectPublicKeyInfo prefix for a raw Ed25519 public key.
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key]);
    return verify(null, Buffer.concat([Buffer.from(`${timestamp}|`), raw]), createPublicKey({ key: spki, format: "der", type: "spki" }), signature);
  } catch { return false; }
}

// Twilio's documented form algorithm (also exercised with its published
// test vector). Include ALL fields; repeated values are unique and sorted,
// matching the SDK. The caller supplies a trusted origin + untouched req.url,
// never Host or forwarded headers. JSON/bodySHA256 callbacks are unsupported.
export function verifyTwilioWebhook(headers, raw, token, callbackUrl) {
  const signature = base64(headers["x-twilio-signature"]);
  if (!signature || typeof token !== "string" || !token || typeof callbackUrl !== "string") return false;
  const params = new URLSearchParams(raw.toString("utf8"));
  let signed = callbackUrl;
  for (const key of [...new Set(params.keys())].sort()) {
    for (const value of [...new Set(params.getAll(key))].sort()) signed += key + value;
  }
  return equal(signature, createHmac("sha1", token).update(signed).digest());
}
