import crypto from "node:crypto";

const COOKIE_NAME = "openagi_token";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export function checkAuth(req, url, token) {
  if (!token) return { ok: true, reason: "auth disabled (OPENAGI_AUTH_TOKEN unset)" };

  const header = req.headers.authorization;
  if (header) {
    const parts = header.split(" ");
    if (parts[0] === "Bearer" && safeEqual(parts[1], token)) {
      return { ok: true };
    }
  }

  const queryToken = url.searchParams.get("token");
  if (queryToken && safeEqual(queryToken, token)) {
    return { ok: true, setCookie: true };
  }

  const cookieToken = parseCookie(req.headers.cookie)[COOKIE_NAME];
  if (cookieToken && safeEqual(cookieToken, token)) {
    return { ok: true };
  }

  return { ok: false, reason: "missing or invalid bearer token" };
}

export function buildSetCookie(token) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Strict`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`;
}

export function isPublicRoute(pathname) {
  // Webhooks self-authenticate; /health stays open as a liveness check.
  // /sign-in is the path you use to GET auth — must be reachable unauthenticated.
  return (
    pathname === "/health" ||
    pathname === "/sign-in" ||
    pathname === "/channels/twilio/webhook" ||
    pathname === "/channels/telegram/webhook"
  );
}

export function verifyTwilioSignature({ authToken, fullUrl, params, signature }) {
  if (!authToken) return { ok: true, reason: "no twilio auth token configured" };
  if (!signature) return { ok: false, reason: "missing X-Twilio-Signature" };
  const sortedKeys = Object.keys(params).sort();
  const data = fullUrl + sortedKeys.map((k) => k + params[k]).join("");
  const expected = crypto.createHmac("sha1", authToken).update(data).digest("base64");
  return safeEqual(expected, signature) ? { ok: true } : { ok: false, reason: "twilio signature mismatch" };
}

export function verifyTelegramSecret({ headerValue, expected }) {
  if (!expected) return { ok: true, reason: "no telegram secret configured" };
  return safeEqual(headerValue, expected) ? { ok: true } : { ok: false, reason: "telegram secret mismatch" };
}

export function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function parseCookie(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
