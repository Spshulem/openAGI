import crypto from "node:crypto";

const COOKIE_NAME = "openagi_token";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export function checkAuth(req, url, token) {
  // No token configured => no auth. That is deliberate for the single-user
  // loopback install, and ONLY safe there. What makes it safe is not this
  // function: it is checkBindSafety() below, which refuses to boot at all on a
  // non-loopback bind with no token. Do not weaken that guard on the
  // assumption that this line fails closed — it does not.
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
  //
  // "Public" here waives BOTH the auth gate and the CSRF gate, so a route on
  // this list has to be safe for an anonymous caller by construction — the
  // listing is not the place to relax that. /health earns its slot by serving
  // two different bodies: liveness to anyone, and the full runtime status only
  // to a caller that passes checkAuth. It used to serve the full status to
  // everyone, which published every scheduled job's input (prompt text,
  // message recipients, agent ids) to anything that could reach the port.
  return (
    pathname === "/health" ||
    pathname === "/sign-in" ||
    pathname === "/channels/telegram/webhook" ||
    pathname === "/webhooks/buildbetter"
  );
}

// Block cross-origin browser POSTs against state-changing routes. When
// OPENAGI_AUTH_TOKEN is unset (default for single-user local installs), the
// daemon would otherwise accept any same-machine browser request — including
// one a malicious webpage triggers via fetch(). If the browser sets Origin
// and it doesn't match our own Host, we reject. Non-browser callers (curl,
// native clients, MCP clients) don't set Origin, so this is browser-only
// CSRF defense and doesn't break programmatic use.
export function checkOrigin(req) {
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return { ok: true };
  }
  const origin = req.headers.origin;
  if (!origin) return { ok: true }; // non-browser caller
  let originHost;
  try { originHost = new URL(origin).host; } catch { return { ok: false, reason: "malformed Origin header" }; }
  const host = req.headers.host;
  if (!host) return { ok: false, reason: "missing Host header" };
  if (originHost !== host) {
    return { ok: false, reason: `cross-origin POST blocked (Origin ${originHost} ≠ Host ${host})` };
  }
  return { ok: true };
}

export function verifyTelegramSecret({ headerValue, expected }) {
  if (!expected) return { ok: true, reason: "no telegram secret configured" };
  return safeEqual(headerValue, expected) ? { ok: true } : { ok: false, reason: "telegram secret mismatch" };
}

// Webhook shared-secret check for inbound BuildBetter pings. Unlike the
// telegram check, a MISSING expected secret fails closed — the webhook
// triggers outbound API calls, so we won't accept unauthenticated pings.
// The secret may arrive in the X-BuildBetter-Webhook-Secret header or a
// ?secret= query param (some webhook UIs only allow URL config).
export function verifyBuildBetterWebhook({ headerValue, queryValue, expected }) {
  if (!expected) return { ok: false, reason: "no webhook secret configured" };
  const provided = headerValue ?? queryValue ?? null;
  return safeEqual(provided, expected) ? { ok: true } : { ok: false, reason: "webhook secret mismatch" };
}

export function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

// Is this bind address reachable only from this machine? Everything else —
// 0.0.0.0, ::, a specific LAN address, a hostname we can't classify — is
// treated as exposed. Unknown means exposed on purpose: this feeds a
// fail-closed check, so guessing "probably local" is the wrong direction.
export function isLoopbackHost(host) {
  if (typeof host !== "string") return false;
  let h = host.trim().toLowerCase();
  if (!h) return false;
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1); // [::1]
  if (h.startsWith("::ffff:")) h = h.slice(7);                  // IPv4-mapped
  if (h === "localhost" || h === "::1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return false;
  return octets[0] === 127; // the whole 127.0.0.0/8 loopback block
}

// The bind-time authorization policy, kept next to checkAuth so the two are
// read together.
//
// Serving a non-loopback address with no token publishes the dashboard and the
// entire API — memory, screen-OCR recall, message-derived data, MCP server
// registration — to every device that can route to this host. That is not a
// warning-level mistake, so callers must treat { ok: false } as fatal rather
// than logging it and continuing. Loopback with no token stays allowed: it is
// the single-user local install, and it is reachable only from this machine.
export function checkBindSafety({ host, token } = {}) {
  const hasToken = typeof token === "string" && token.trim().length > 0;
  if (hasToken) return { ok: true, reason: "auth token configured" };
  if (isLoopbackHost(host)) return { ok: true, reason: "loopback bind — reachable only from this machine" };

  const shown = typeof host === "string" && host.trim() ? host.trim() : "(unset)";
  return {
    ok: false,
    reason: `non-loopback bind (${shown}) with no OPENAGI_AUTH_TOKEN`,
    message: [
      `✗ OpenAGI refused to start.`,
      ``,
      `  bind host:          ${shown}   (not loopback)`,
      `  OPENAGI_AUTH_TOKEN: not set`,
      ``,
      `  In this configuration the dashboard and the whole API — memory, screen`,
      `  recall, message history, MCP server registration — would be served to`,
      `  every device that can reach this host, with no credential at all.`,
      ``,
      `  Fix one of these, then start again:`,
      ``,
      `  1. Set a token (recommended). Generate one:`,
      `       openssl rand -hex 32`,
      `     then put it in the environment as OPENAGI_AUTH_TOKEN — export it, add`,
      `     it to <data-dir>/.env, or add it to the "environment:" block of your`,
      `     docker-compose.yml. Clients pass it as "Authorization: Bearer <token>".`,
      ``,
      `  2. Or run \`openagi setup\`, which generates and stores one for you.`,
      ``,
      `  3. Or bind to loopback only, if nothing else needs to reach it:`,
      `       HOST=127.0.0.1        (or: openagi serve --host 127.0.0.1)`,
    ].join("\n"),
  };
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
