// Sign in with ChatGPT: lets this daemon run model requests on the owner's
// ChatGPT Plus/Pro plan, through OpenAI's plan-usage program for open-source,
// locally hosted apps.
//
// Source of truth (read these before changing anything here):
//   https://developers.openai.com/siwc/token-sharing-open-source
//   https://developers.openai.com/siwc/token-sharing-open-source/sign-in
//   https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
//   https://developers.openai.com/siwc/token-sharing-open-source/token-reference
//   https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
//   https://auth.openai.com/.well-known/openid-configuration
//
// Flow: Authorization Code + PKCE (S256) + OIDC nonce, public client (no
// secret). First sign-in uses client_id=dynamic_agent_client, which registers
// a client for this ChatGPT account; the callback hands back the issued
// client_id (oaiapp_...), which every later sign-in and refresh reuses.
//
// Files under <dataDir> (all 0600):
//   chatgpt-host-id            stable ext_agent_host_id for this daemon
//   chatgpt-auth.json          the token set (deleted on sign-out)
//   chatgpt-registration.json  issued client_id + account identity, no
//                              tokens; kept on sign-out so the next sign-in
//                              reuses the same registered client (docs:
//                              "Retain its account/client mapping")

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonAtomic, writeTextAtomic } from "./file-utils.js";

// ─── Documented constants ────────────────────────────────────────────────
export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
export const CHATGPT_TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
export const CHATGPT_REVOKE_URL = "https://auth.openai.com/api/accounts/oauth/revoke";
export const CHATGPT_JWKS_URL = "https://auth.openai.com/.well-known/jwks.json";
/// The `resource` parameter on authorize, code exchange and refresh, and the
/// access token's `aud`.
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
/// First-time registration entrypoint. Never saved, never used for exchange.
export const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
/// agent_name_hint: "your app's actual name, used consistently".
export const AGENT_NAME_HINT = "OpenAGI";
/// The scope that actually authorizes plan-billed inference.
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const CHATGPT_SCOPES = Object.freeze(["openid", "profile", "email", "offline_access", "resource.invoke", PLAN_SCOPE]);
/// Redirect must be http://127.0.0.1:<port><path>. Docs: only the port may
/// vary between sign-ins; scheme, host and path stay fixed, and "localhost"
/// is not a substitute. The docs' example path is /auth/callback, so that is
/// the default; /auth/chatgpt/callback is also served for callers that pass
/// it explicitly.
export const CHATGPT_CALLBACK_PATH = "/auth/callback";
export const CHATGPT_ALT_CALLBACK_PATH = "/auth/chatgpt/callback";
/// Where the callback sends the browser afterwards when the start request
/// asked for it. Allowlisted (no caller-supplied URLs: no open redirect).
/// "openagi" returns to the native iOS app; "setup" resumes desktop setup.
export const RETURN_TO_TARGETS = Object.freeze({ openagi: "openagi://chatgpt-signed-in", setup: "/setup?provider=chatgpt" });

// ─── Local policy ────────────────────────────────────────────────────────
/// Pending authorization attempts expire (docs' website example uses 10 min).
export const PENDING_TTL_MS = 10 * 60 * 1000;
/// Access tokens last one hour; refresh this long before expiry.
export const REFRESH_SKEW_MS = 2 * 60 * 1000;
const ID_TOKEN_CLOCK_SKEW_S = 5;
const MAX_PENDING = 32;
const JWKS_CACHE_MS = 60 * 60 * 1000;

const AUTH_FILE = "chatgpt-auth.json";
const REGISTRATION_FILE = "chatgpt-registration.json";
const HOST_ID_FILE = "chatgpt-host-id";
const HOST_ID_PATTERN = /^(urn:uuid:[0-9a-f-]{36}|urn:ietf:params:oauth:jwk-thumbprint:[A-Za-z0-9:_-]+|did:key:[A-Za-z0-9]+)$/;

// Refresh-token errors that mean the token set is dead and OAuth must be
// repeated (errors-and-recovery#refresh-errors).
const UNUSABLE_REFRESH_ERRORS = new Set([
  "invalid_grant", "invalid_refresh_token", "token_expired",
  "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"
]);

export class ChatGPTAuthError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "ChatGPTAuthError";
    this.code = code;
    Object.assign(this, extra);
  }
}

const SIGNED_OUT_MESSAGE = "ChatGPT sign-in is needed. Sign in with ChatGPT again.";

// ─── Paths and files ─────────────────────────────────────────────────────
export function chatgptAuthPath(dataDir) { return path.join(dataDir, AUTH_FILE); }
function registrationPath(dataDir) { return path.join(dataDir, REGISTRATION_FILE); }
function hostIdPath(dataDir) { return path.join(dataDir, HOST_ID_FILE); }

function requireDataDir(dataDir) {
  if (!dataDir || typeof dataDir !== "string") throw new TypeError("dataDir is required");
  return dataDir;
}

export function readAuthRecord(dataDir) {
  const record = readJsonFile(chatgptAuthPath(requireDataDir(dataDir)), null);
  return record && typeof record === "object" ? record : null;
}

function readRegistration(dataDir) {
  const record = readJsonFile(registrationPath(dataDir), null);
  return record && typeof record.clientId === "string" && record.clientId !== DYNAMIC_CLIENT_ID ? record : null;
}

/// Stable ext_agent_host_id for this daemon, created once before the first
/// sign-in. Uses the documented urn:uuid:<UUIDv4> form.
export function ensureHostId(dataDir) {
  const file = hostIdPath(requireDataDir(dataDir));
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (HOST_ID_PATTERN.test(existing)) return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const hostId = `urn:uuid:${crypto.randomUUID()}`;
  writeTextAtomic(file, `${hostId}\n`, 0o600);
  return hostId;
}

// ─── PKCE / state / nonce ────────────────────────────────────────────────
function randomValue(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function createPkcePair() {
  // 64 random bytes -> 86 base64url chars, inside RFC 7636's 43..128.
  const verifier = randomValue(64);
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

// ─── Pending authorization attempts (memory only) ───────────────────────
const pending = new Map();

function prunePending(now) {
  for (const [state, attempt] of pending) {
    if (attempt.expiresAt <= now) pending.delete(state);
  }
  while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
}

/// Test seam.
export function _resetChatGPTAuthState() {
  pending.clear();
  jwksCache.clear();
  refreshLocks.clear();
}

/// The allowlisted app URL a pending attempt asked to return to, if any.
/// Read before finishSignIn (which consumes the attempt) so a failed sign-in
/// can still hand control back to the app.
export function pendingReturnTo(state) {
  const target = state ? pending.get(state)?.returnTo : null;
  return target ? RETURN_TO_TARGETS[target] ?? null : null;
}

export function validateRedirectUri(redirectUri) {
  let parsed;
  try { parsed = new URL(redirectUri); } catch {
    throw new ChatGPTAuthError("chatgpt-invalid-redirect", "redirectUri is not a valid URL.");
  }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.search || parsed.hash) {
    throw new ChatGPTAuthError(
      "chatgpt-invalid-redirect",
      "redirectUri must be http://127.0.0.1:<port>/<path> (OpenAI only accepts a loopback callback on 127.0.0.1)."
    );
  }
  return parsed.toString();
}

/// Begin a sign-in attempt. Returns the URL to open in the system browser.
/// `newAccount: true` registers a fresh client (another ChatGPT account or
/// workspace) instead of reusing the saved one.
export function startSignIn({ dataDir, redirectUri, newAccount = false, returnTo = null, now = Date.now() } = {}) {
  requireDataDir(dataDir);
  const redirect = validateRedirectUri(redirectUri);
  if (returnTo != null && !Object.hasOwn(RETURN_TO_TARGETS, returnTo)) {
    throw new ChatGPTAuthError("chatgpt-invalid-return-to", `returnTo must be one of: ${Object.keys(RETURN_TO_TARGETS).join(", ")}.`);
  }
  const hostId = ensureHostId(dataDir);
  const registration = newAccount ? null : readRegistration(dataDir);
  const clientId = registration?.clientId ?? DYNAMIC_CLIENT_ID;
  const state = randomValue();
  const nonce = randomValue();
  const { verifier, challenge } = createPkcePair();

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirect,
    scope: CHATGPT_SCOPES.join(" "),
    resource: CHATGPT_RESOURCE,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ext_agent_host_id: hostId
  });
  if (!registration) {
    params.set("agent_name_hint", AGENT_NAME_HINT);
  } else {
    // Reauthorization hints. The ID token hint may be expired; it only
    // identifies the account. Omitted after sign-out (the token is gone).
    const current = readAuthRecord(dataDir);
    if (current?.idToken && current.subject === registration.subject) params.set("id_token_hint", current.idToken);
    if (registration.email) params.set("login_hint", registration.email);
  }

  prunePending(now);
  const expiresAt = now + PENDING_TTL_MS;
  pending.set(state, {
    dataDir,
    redirectUri: redirect,
    codeVerifier: verifier,
    nonce,
    clientId,
    newRegistration: !registration,
    expectedSubject: registration?.subject ?? null,
    hostId,
    returnTo: returnTo ?? null,
    expiresAt
  });
  return { authorizeUrl: `${CHATGPT_AUTHORIZE_URL}?${params.toString()}`, state, expiresAt };
}

/// Finish a sign-in from the callback's query values. Validates state,
/// exchanges the code, verifies the ID token, and stores the token set.
export async function finishSignIn({ dataDir, code, state, clientId: callbackClientId, error, errorDescription, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  requireDataDir(dataDir);
  const attempt = state ? pending.get(state) : null;
  if (!attempt || attempt.dataDir !== dataDir) {
    throw new ChatGPTAuthError("chatgpt-state-mismatch", "This sign-in link is not the one that was started. Start Sign in with ChatGPT again.");
  }
  pending.delete(state); // one-time use, success or failure
  if (attempt.expiresAt <= now) {
    throw new ChatGPTAuthError("chatgpt-state-expired", "This sign-in took too long. Start Sign in with ChatGPT again.");
  }
  if (error) {
    if (error === "access_denied") {
      throw new ChatGPTAuthError("chatgpt-access-denied", "Sign in with ChatGPT was cancelled.");
    }
    throw new ChatGPTAuthError("chatgpt-authorize-error", `ChatGPT sign-in failed: ${errorDescription || error}`);
  }
  if (!code) throw new ChatGPTAuthError("chatgpt-authorize-error", "The callback did not include an authorization code.");

  let issuedClientId;
  if (attempt.newRegistration) {
    if (!callbackClientId || callbackClientId === DYNAMIC_CLIENT_ID) {
      throw new ChatGPTAuthError("chatgpt-registration-incomplete", "ChatGPT did not return a registered client. Start Sign in with ChatGPT again.");
    }
    issuedClientId = callbackClientId;
  } else {
    issuedClientId = attempt.clientId;
    if (callbackClientId && callbackClientId !== issuedClientId) {
      throw new ChatGPTAuthError("chatgpt-client-mismatch", "ChatGPT returned a different client than this account's registration.");
    }
  }

  const response = await fetchImpl(CHATGPT_TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: issuedClientId,
      code,
      code_verifier: attempt.codeVerifier,
      redirect_uri: attempt.redirectUri,
      resource: CHATGPT_RESOURCE
    }).toString()
  });
  const tokens = await response.json().catch(() => ({}));
  if (!response.ok) {
    const oauthError = tokens?.error ?? null;
    throw new ChatGPTAuthError(
      "chatgpt-token-exchange-failed",
      oauthError === "invalid_grant"
        ? "The sign-in code was already used or expired. Start Sign in with ChatGPT again."
        : `ChatGPT token exchange failed (${response.status}${oauthError ? ` ${oauthError}` : ""}).`,
      { status: response.status, oauthError, requestId: requestIdOf(response) }
    );
  }
  if (typeof tokens.access_token !== "string" || typeof tokens.id_token !== "string") {
    throw new ChatGPTAuthError("chatgpt-token-exchange-failed", "ChatGPT's token response was missing a token.");
  }

  const claims = await verifyIdToken(tokens.id_token, { clientId: issuedClientId, nonce: attempt.nonce, fetchImpl, now });
  if (attempt.expectedSubject && claims.sub !== attempt.expectedSubject) {
    throw new ChatGPTAuthError("chatgpt-account-mismatch", "That ChatGPT account is not the one saved here. Sign out first to switch accounts.");
  }

  const scopes = String(tokens.scope ?? "").split(/\s+/).filter(Boolean);
  const record = {
    version: 1,
    issuer: CHATGPT_ISSUER,
    subject: claims.sub,
    clientId: issuedClientId,
    extAgentHostId: attempt.hostId,
    accountEmail: typeof claims.email === "string" ? claims.email : null,
    idToken: tokens.id_token,
    accessToken: tokens.access_token,
    refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : null,
    tokenType: tokens.token_type ?? "Bearer",
    expiresAt: now + expiresInMs(tokens.expires_in),
    earliestRefreshAt: refreshHintMs(tokens.earliest_refresh_at),
    scopes,
    // A valid ID token alone does not authorize plan usage; the granted
    // scopes decide (sign-in#4).
    planScopeGranted: scopes.includes(PLAN_SCOPE),
    savedAt: new Date(now).toISOString()
  };
  writeJsonAtomic(chatgptAuthPath(dataDir), record, 0o600);
  writeJsonAtomic(registrationPath(dataDir), {
    issuer: CHATGPT_ISSUER,
    clientId: issuedClientId,
    subject: claims.sub,
    email: record.accountEmail,
    extAgentHostId: attempt.hostId,
    savedAt: record.savedAt
  }, 0o600);
  return status({ dataDir, now });
}

function expiresInMs(value) {
  const seconds = Number(value);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000;
}

// TODO(chatgpt-earliest-refresh-at): the token response includes
// earliest_refresh_at, but the docs do not say whether it is seconds or an ISO
// time, or whether refreshing before it fails. Stored for diagnostics only;
// refresh timing ignores it.
function refreshHintMs(value) {
  if (value == null) return null;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function requestIdOf(response) {
  return response?.headers?.get?.("openai-request-id") ?? response?.headers?.get?.("x-request-id") ?? null;
}

// ─── ID token verification (RS256 against OpenAI's JWKS) ────────────────
const jwksCache = new Map();

async function loadJwks(fetchImpl, { force = false, now = Date.now() } = {}) {
  const cached = jwksCache.get(fetchImpl);
  if (!force && cached && now - cached.fetchedAt < JWKS_CACHE_MS) return cached.keys;
  const response = await fetchImpl(CHATGPT_JWKS_URL, { headers: { accept: "application/json" } });
  if (!response.ok) throw new ChatGPTAuthError("chatgpt-id-token-invalid", `Could not load OpenAI signing keys (${response.status}).`);
  const json = await response.json();
  const keys = Array.isArray(json?.keys) ? json.keys : [];
  jwksCache.set(fetchImpl, { keys, fetchedAt: now });
  return keys;
}

function decodeSegment(segment) {
  try { return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")); } catch { return null; }
}

export async function verifyIdToken(idToken, { clientId, nonce, fetchImpl = globalThis.fetch, now = Date.now() }) {
  const invalid = (why) => new ChatGPTAuthError("chatgpt-id-token-invalid", `ChatGPT's ID token was rejected: ${why}.`);
  const parts = String(idToken).split(".");
  if (parts.length !== 3) throw invalid("malformed");
  const header = decodeSegment(parts[0]);
  const claims = decodeSegment(parts[1]);
  if (!header || !claims) throw invalid("malformed");
  // Discovery: id_token_signing_alg_values_supported = ["RS256"].
  if (header.alg !== "RS256") throw invalid(`unsupported alg ${header.alg}`);

  let keys = await loadJwks(fetchImpl, { now });
  let jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) {
    // Unfamiliar kid: refresh keys once (keys rotate).
    keys = await loadJwks(fetchImpl, { force: true, now });
    jwk = keys.find((key) => key.kid === header.kid);
  }
  if (!jwk) throw invalid("unknown signing key");
  let publicKey;
  try { publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" }); } catch { throw invalid("unusable signing key"); }
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2], "base64url");
  if (!crypto.verify("RSA-SHA256", signed, publicKey, signature)) throw invalid("bad signature");

  const nowS = Math.floor(now / 1000);
  if (claims.iss !== CHATGPT_ISSUER) throw invalid("wrong issuer");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(clientId)) throw invalid("wrong audience");
  if (!Number.isFinite(claims.exp) || claims.exp + ID_TOKEN_CLOCK_SKEW_S < nowS) throw invalid("expired");
  if (!Number.isFinite(claims.iat)) throw invalid("missing iat");
  if (claims.nonce !== nonce) throw invalid("nonce mismatch");
  if (typeof claims.sub !== "string" || !claims.sub) throw invalid("missing subject");
  return claims;
}

// ─── Access token + refresh ──────────────────────────────────────────────
const refreshLocks = new Map();

/// Current access token, refreshed when within REFRESH_SKEW_MS of expiry.
/// `forceRefresh` (after a 401) refreshes unless another caller already
/// replaced `staleToken`. Refreshes are serialized per data dir because the
/// refresh token rotates.
export async function getAccessToken({ dataDir, fetchImpl = globalThis.fetch, now, forceRefresh = false, staleToken = null } = {}) {
  requireDataDir(dataDir);
  const clock = () => (typeof now === "function" ? now() : now ?? Date.now());
  const record = readAuthRecord(dataDir);
  if (!record?.accessToken) throw new ChatGPTAuthError("chatgpt-signed-out", SIGNED_OUT_MESSAGE);
  if (!forceRefresh && record.expiresAt - REFRESH_SKEW_MS > clock()) return record.accessToken;

  const prior = refreshLocks.get(dataDir) ?? Promise.resolve();
  const run = prior.catch(() => {}).then(async () => {
    const latest = readAuthRecord(dataDir);
    if (!latest?.accessToken) throw new ChatGPTAuthError("chatgpt-signed-out", SIGNED_OUT_MESSAGE);
    const stale = forceRefresh ? (staleToken ?? record.accessToken) : null;
    // Someone refreshed while we waited.
    if (forceRefresh && latest.accessToken !== stale && latest.expiresAt > clock()) return latest.accessToken;
    if (!forceRefresh && latest.expiresAt - REFRESH_SKEW_MS > clock()) return latest.accessToken;
    return refreshTokens({ dataDir, record: latest, fetchImpl, now: clock() });
  });
  refreshLocks.set(dataDir, run);
  try {
    return await run;
  } finally {
    if (refreshLocks.get(dataDir) === run) refreshLocks.delete(dataDir);
  }
}

async function refreshTokens({ dataDir, record, fetchImpl, now }) {
  if (!record.refreshToken || !record.clientId) {
    clearTokens(dataDir);
    throw new ChatGPTAuthError("chatgpt-signed-out", SIGNED_OUT_MESSAGE);
  }
  const response = await fetchImpl(CHATGPT_TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    // Omit scope to retain the grant (profiles-and-sessions#refreshing-tokens).
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: record.clientId,
      refresh_token: record.refreshToken,
      resource: CHATGPT_RESOURCE
    }).toString()
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const oauthError = typeof json?.error === "string" ? json.error : json?.error?.code ?? null;
    if (UNUSABLE_REFRESH_ERRORS.has(oauthError)) {
      clearTokens(dataDir);
      throw new ChatGPTAuthError("chatgpt-signed-out", SIGNED_OUT_MESSAGE, { status: response.status, oauthError });
    }
    if (oauthError === "invalid_client") {
      throw new ChatGPTAuthError("chatgpt-invalid-client", "ChatGPT rejected this app's client registration. Sign out and sign in again.", { status: response.status, oauthError });
    }
    // Temporary failure: keep credentials (errors-and-recovery#disconnection).
    throw new ChatGPTAuthError("chatgpt-refresh-failed", `Could not renew the ChatGPT sign-in (${response.status}). Try again shortly.`, { status: response.status, oauthError, requestId: requestIdOf(response) });
  }
  if (typeof json.access_token !== "string") {
    throw new ChatGPTAuthError("chatgpt-refresh-failed", "ChatGPT's refresh response was missing a token.");
  }
  // Replace access token, expiry, scopes and the rotating refresh token
  // together.
  const scopes = json.scope ? String(json.scope).split(/\s+/).filter(Boolean) : record.scopes ?? [];
  const next = {
    ...record,
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : record.refreshToken,
    tokenType: json.token_type ?? record.tokenType ?? "Bearer",
    expiresAt: now + expiresInMs(json.expires_in),
    earliestRefreshAt: refreshHintMs(json.earliest_refresh_at),
    scopes,
    planScopeGranted: scopes.includes(PLAN_SCOPE),
    savedAt: new Date(now).toISOString()
  };
  writeJsonAtomic(chatgptAuthPath(dataDir), next, 0o600);
  return next.accessToken;
}

// Called whenever the tokens go away (sign-out, or a refresh the server
// refused), so the daemon can stop using the ChatGPT provider.
const signedOutListeners = new Set();
export function onChatGPTSignedOut(listener) {
  signedOutListeners.add(listener);
  return () => signedOutListeners.delete(listener);
}

function clearTokens(dataDir) {
  fs.rmSync(chatgptAuthPath(dataDir), { force: true });
  for (const listener of signedOutListeners) {
    try { listener(dataDir); } catch { /* a listener can't block sign-out */ }
  }
}

// ─── Sign-out and status ─────────────────────────────────────────────────
/// Revoke the refresh token (best effort), then delete the local token set.
/// The registration (issued client_id, account identity) and host id stay,
/// so the next sign-in reuses the same registered client.
export async function signOut({ dataDir, fetchImpl = globalThis.fetch } = {}) {
  requireDataDir(dataDir);
  const record = readAuthRecord(dataDir);
  let revoked = false;
  if (record?.refreshToken && record.clientId) {
    try {
      const response = await fetchImpl(CHATGPT_REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: record.refreshToken,
          token_type_hint: "refresh_token",
          client_id: record.clientId
        }).toString()
      });
      // An empty 200 is success, including for an already-invalid token.
      revoked = response.ok;
    } catch {
      revoked = false;
    }
  }
  clearTokens(dataDir);
  return {
    signedOut: true,
    revoked,
    ...(record && !revoked
      ? { note: "Signed out here, but ChatGPT did not confirm it. You can disconnect OpenAGI in ChatGPT Settings." }
      : {})
  };
}

/// Safe to return to any authenticated caller: never includes tokens.
export function status({ dataDir, now = Date.now() } = {}) {
  requireDataDir(dataDir);
  const record = readAuthRecord(dataDir);
  const signedIn = Boolean(record?.accessToken && (record.refreshToken || record.expiresAt > now));
  return {
    signedIn,
    email: signedIn ? record.accountEmail ?? null : null,
    expiresAt: signedIn ? record.expiresAt ?? null : null,
    planEnabled: signedIn ? record.planScopeGranted === true : false
  };
}

/// Synchronous check for provider selection: signed in with plan usage.
export function isPlanUsable(dataDir) {
  if (!dataDir) return false;
  try {
    const record = readAuthRecord(dataDir);
    return Boolean(record?.accessToken && record.planScopeGranted === true && (record.refreshToken || record.expiresAt > Date.now()));
  } catch {
    return false;
  }
}

// ─── HTTP routes ─────────────────────────────────────────────────────────
function defaultRedirectUri(req) {
  // The callback has to reach this daemon from a browser on the same machine,
  // so it is always 127.0.0.1 on the port this request came in on.
  let port = req?.socket?.localPort;
  if (!port) {
    const hostHeader = String(req?.headers?.host ?? "");
    const match = /:(\d+)$/.exec(hostHeader);
    port = match ? Number(match[1]) : 80;
  }
  return `http://127.0.0.1:${port}${CHATGPT_CALLBACK_PATH}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c]);
}

function sendCallbackPage(res, statusCode, message) {
  const body = "<!doctype html><html><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    "<title>OpenAGI - Sign in with ChatGPT</title>" +
    "<style>body{font:16px -apple-system,system-ui,sans-serif;display:flex;min-height:90vh;" +
    "align-items:center;justify-content:center;margin:0;padding:24px;text-align:center}</style>" +
    "</head><body><p>" + escapeHtml(message) + "</p></body></html>";
  res.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    // The callback URL carries the authorization code.
    "referrer-policy": "no-referrer"
  });
  res.end(body);
}

// Hand control back to the app, or commit a local page before resuming setup.
// No template literals here on purpose.
function sendAppRedirect(res, location) {
  const safe = escapeHtml(location);
  const body = "<!doctype html><html><head><meta charset=\"utf-8\">" +
    "<meta http-equiv=\"refresh\" content=\"0;url=" + safe + "\">" +
    "<title>OpenAGI - Sign in with ChatGPT</title></head><body>" +
    "<p><a href=\"" + safe + "\">Return to OpenAGI</a></p>" +
    "<script>window.location.replace(" + JSON.stringify(location).replace(/</g, "\\u003c") + ");</script>" +
    "</body></html>";
  // Commit the local page before returning to setup so a Strict dashboard
  // cookie can accompany that new same-origin navigation after OAuth.
  const localPage = location.startsWith("/");
  res.writeHead(localPage ? 200 : 302, {
    ...(localPage ? {} : { location }),
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer"
  });
  res.end(body);
}

function errorBody(error) {
  return { error: error?.code ?? "chatgpt-error", message: error?.message ?? String(error) };
}

/// Mounts the Sign in with ChatGPT routes. Returns true when it handled the
/// request. The callback route must be reachable without the owner token
/// (the browser carries none); it is protected by the one-time state value.
export async function handleChatGPTAuthRoute({ method, pathname, url, req, res, dataDir, sendJson, readJson, onSignedIn, fetchImpl = globalThis.fetch } = {}) {
  if (method === "POST" && pathname === "/auth/chatgpt/start") {
    let body = {};
    try { body = (await readJson(req)) ?? {}; } catch { body = {}; }
    try {
      const redirectUri = typeof body.redirectUri === "string" && body.redirectUri ? body.redirectUri : defaultRedirectUri(req);
      const returnTo = typeof body.returnTo === "string" && body.returnTo ? body.returnTo : null;
      const { authorizeUrl, expiresAt } = startSignIn({ dataDir, redirectUri, newAccount: body.newAccount === true, returnTo });
      sendJson(res, 200, { authorizeUrl, redirectUri: validateRedirectUri(redirectUri), expiresAt });
    } catch (error) {
      sendJson(res, error instanceof ChatGPTAuthError ? 400 : 500, errorBody(error));
    }
    return true;
  }

  if (method === "GET" && (pathname === CHATGPT_CALLBACK_PATH || pathname === CHATGPT_ALT_CALLBACK_PATH)) {
    const params = url instanceof URL ? url.searchParams : new URL(String(url ?? req?.url ?? ""), "http://127.0.0.1").searchParams;
    const appReturn = pendingReturnTo(params.get("state"));
    try {
      const result = await finishSignIn({
        dataDir,
        code: params.get("code"),
        state: params.get("state"),
        clientId: params.get("client_id"),
        error: params.get("error"),
        errorDescription: params.get("error_description"),
        fetchImpl
      });
      try { await onSignedIn?.(result); } catch { /* the sign-in itself succeeded */ }
      if (appReturn) {
        sendAppRedirect(res, appReturn);
        return true;
      }
      sendCallbackPage(res, 200, result.planEnabled
        ? "Signed in. You can close this window."
        : "Signed in, but ChatGPT plan use was not allowed. Sign in again and allow it, or add an API key. You can close this window.");
    } catch (error) {
      if (appReturn) {
        sendAppRedirect(res, appReturn + (appReturn.includes("?") ? "&" : "?") + "error=" + encodeURIComponent(error?.code ?? "chatgpt-error"));
        return true;
      }
      sendCallbackPage(res, 400, `Sign-in failed. ${error?.message ?? "Try again."}`);
    }
    return true;
  }

  if (method === "POST" && pathname === "/auth/chatgpt/signout") {
    try {
      sendJson(res, 200, await signOut({ dataDir, fetchImpl }));
    } catch (error) {
      sendJson(res, 500, errorBody(error));
    }
    return true;
  }

  if (method === "GET" && pathname === "/auth/chatgpt/status") {
    try {
      sendJson(res, 200, status({ dataDir }));
    } catch (error) {
      sendJson(res, 500, errorBody(error));
    }
    return true;
  }

  return false;
}
