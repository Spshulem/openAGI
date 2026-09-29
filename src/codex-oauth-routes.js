import { checkAuth } from "./auth.js";

const PREFIX = "/admin/providers/openai-codex";
const MAX_BODY_BYTES = 16 * 1024;

export async function handleCodexOAuthRoute({ req, res, url, provider, authToken }) {
  const pathname = url.pathname;
  if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return false;

  res.setHeader("Cache-Control", "no-store");
  if (typeof authToken !== "string" || !authToken.trim()) {
    sendJson(res, 401, { error: "owner-auth-required" });
    return true;
  }
  if (url.searchParams.has("token")) {
    sendJson(res, 401, { error: "query-token-not-accepted" });
    return true;
  }
  const authUrl = new URL(url);
  authUrl.search = "";
  const auth = checkAuth(req, authUrl, authToken);
  if (!auth.ok) {
    sendJson(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
    return true;
  }
  if (!provider) {
    sendJson(res, 503, { error: "codex-provider-unavailable" });
    return true;
  }

  try {
    if (req.method === "GET" && pathname === `${PREFIX}/status`) {
      sendJson(res, 200, sanitizeStatus(provider.status?.()));
      return true;
    }
    if (req.method === "POST" && pathname === `${PREFIX}/login`) {
      const body = await readJson(req);
      if (!body || body.mode !== "device" || Object.keys(body).some((key) => key !== "mode")) {
        sendJson(res, 400, { error: "invalid-login-mode" });
        return true;
      }
      if (provider.status?.()?.preLoginQualified !== true) {
        sendJson(res, 503, { error: "codex-prelogin-required" });
        return true;
      }
      sendJson(res, 200, sanitizeLogin(await provider.startLogin({ mode: body.mode })));
      return true;
    }
    const cancelMatch = pathname.match(/^\/admin\/providers\/openai-codex\/login\/([^/]+)\/cancel$/);
    if (req.method === "POST" && cancelMatch) {
      const loginId = decodeURIComponent(cancelMatch[1]);
      if (!loginId || loginId.length > 256) {
        sendJson(res, 400, { error: "invalid-login-id" });
        return true;
      }
      sendJson(res, 200, sanitizeLifecycleStatus(await provider.cancelLogin(loginId)));
      return true;
    }
    if (req.method === "POST" && pathname === `${PREFIX}/logout`) {
      sendJson(res, 200, sanitizeLifecycleStatus(await provider.logout()));
      return true;
    }
    if (req.method === "GET" && pathname === `${PREFIX}/models`) {
      const models = await provider.listModels();
      sendJson(res, 200, { models: Array.isArray(models) ? models.slice(0, 500).map(sanitizeModel) : [] });
      return true;
    }
    if (req.method === "GET" && pathname === `${PREFIX}/limits`) {
      sendJson(res, 200, sanitizeLimits(await provider.getLimits()));
      return true;
    }
    if (req.method === "POST" && pathname === `${PREFIX}/qualification/check`) {
      const body = await readJson(req);
      if (!body || Object.keys(body).length !== 0) {
        sendJson(res, 400, { error: "invalid-qualification-request" });
        return true;
      }
      sendJson(res, 200, sanitizeStatus(await provider.inspectReadiness()));
      return true;
    }
    sendJson(res, 404, { error: "not-found" });
    return true;
  } catch (error) {
    const code = String(error?.code ?? "");
    const status = code.includes("INPUT") || code.includes("LOGIN_MODE") || code.includes("LOGIN_EXPIRED") ? 400
      : code.includes("BACKPRESSURE") ? 409
        : 503;
    sendJson(res, status, { error: publicErrorCode(code) });
    return true;
  }
}

function sanitizeStatus(status) {
  const source = status && typeof status === "object" ? status : {};
  const output = {};
  for (const key of ["provider", "readiness", "reason", "capabilityTier", "model", "reasoningEffort", "requestedModel", "observedModel", "loginPending", "version", "lastQualifiedAt", "binarySha256", "fallbackProvider", "fallbackConfigured", "serverRequestsDenied"]) {
    const value = source[key];
    if (["string", "boolean", "number"].includes(typeof value) || value === null) output[key] = value;
  }
  return output;
}

function sanitizeLogin(login) {
  if (login?.type === "chatgptDeviceCode") {
    return {
      type: "chatgptDeviceCode",
      loginId: boundedString(login.loginId, 256),
      userCode: boundedString(login.userCode, 128),
      verificationUrl: safePublicUrl(login.verificationUrl)
    };
  }

  throw Object.assign(new Error("Malformed login response."), { code: "CODEX_PROTOCOL" });
}

function sanitizeLifecycleStatus(result) {
  const status = result?.status;
  if (!["canceled", "cancelled", "logged-out"].includes(status)) {
    throw Object.assign(new Error("Malformed Codex lifecycle response."), { code: "CODEX_PROTOCOL" });
  }
  return { status };
}

function sanitizeModel(model) {
  return {
    id: boundedString(model?.id ?? model?.model, 256),
    displayName: boundedString(model?.displayName ?? model?.id ?? model?.model, 256),
    description: boundedString(model?.description ?? "", 1_000),
    isDefault: model?.isDefault === true,
    supportedReasoningEfforts: Array.isArray(model?.supportedReasoningEfforts)
      ? model.supportedReasoningEfforts.slice(0, 20).map((entry) => boundedString(entry?.reasoningEffort ?? entry?.effort ?? entry, 64))
      : []
  };
}

function sanitizeLimits(value) {
  return { quota: sanitizeQuota(value?.quota) };
}

function sanitizeQuota(quota) {
  if (!quota || typeof quota !== "object" || Array.isArray(quota)) return null;
  const output = {};
  if (typeof quota.ordinaryUsageAllowed === "boolean") output.ordinaryUsageAllowed = quota.ordinaryUsageAllowed;
  if (quota.rateLimits === null) output.rateLimits = null;
  else {
    const snapshot = sanitizeRateLimitSnapshot(quota.rateLimits);
    if (snapshot) output.rateLimits = snapshot;
  }
  if (quota.rateLimitsByLimitId && typeof quota.rateLimitsByLimitId === "object" && !Array.isArray(quota.rateLimitsByLimitId)) {
    const byLimitId = {};
    for (const [rawId, rawSnapshot] of Object.entries(quota.rateLimitsByLimitId).slice(0, 100)) {
      const id = boundedString(rawId, 128);
      const snapshot = sanitizeRateLimitSnapshot(rawSnapshot);
      if (id && !["__proto__", "prototype", "constructor"].includes(id) && snapshot) byLimitId[id] = snapshot;
    }
    output.rateLimitsByLimitId = byLimitId;
  }
  return output;
}

function sanitizeRateLimitSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const output = {};
  for (const key of ["limitId", "limitName", "normalModelSlug", "planType", "rateLimitReachedType"]) {
    if (typeof snapshot[key] === "string") output[key] = boundedString(snapshot[key], 128);
    else if (snapshot[key] === null) output[key] = null;
  }
  if (typeof snapshot.spendControlReached === "boolean" || snapshot.spendControlReached === null) {
    output.spendControlReached = snapshot.spendControlReached;
  }
  for (const key of ["individualLimit", "primary", "secondary"]) {
    if (snapshot[key] === null) output[key] = null;
    else {
      const window = sanitizeRateLimitWindow(snapshot[key]);
      if (window) output[key] = window;
    }
  }
  const credits = sanitizeCreditsSnapshot(snapshot.credits);
  if (credits) output.credits = credits;
  else if (snapshot.credits === null) output.credits = null;
  return output;
}

function sanitizeRateLimitWindow(window) {
  if (!window || typeof window !== "object" || Array.isArray(window)) return null;
  const output = {};
  for (const key of ["usedPercent", "resetsAt", "windowDurationMins"]) {
    if (Number.isFinite(window[key])) output[key] = window[key];
    else if (window[key] === null) output[key] = null;
  }
  return output;
}

function sanitizeCreditsSnapshot(credits) {
  if (!credits || typeof credits !== "object" || Array.isArray(credits)) return null;
  const output = {};
  if (Number.isFinite(credits.balance) || credits.balance === null) output.balance = credits.balance;
  if (typeof credits.hasCredits === "boolean") output.hasCredits = credits.hasCredits;
  if (typeof credits.unlimited === "boolean") output.unlimited = credits.unlimited;
  return output;
}

function safePublicUrl(value) {
  const parsed = new URL(String(value));
  if (parsed.protocol !== "https:" || parsed.hostname !== "auth.openai.com" || parsed.port
    || parsed.username || parsed.password) throw new Error("Untrusted Codex login origin.");
  return parsed.toString();
}

function boundedString(value, max) {
  return String(value ?? "").slice(0, max);
}

function publicErrorCode(code) {
  if (code.includes("INPUT")) return "invalid-request";
  if (code.includes("LOGIN")) return "codex-login-failed";
  if (code.includes("ISOLATION")) return "codex-isolation-failed";
  if (code.includes("PROTOCOL")) return "codex-protocol-unsupported";
  if (code.includes("BACKPRESSURE")) return "codex-busy";
  return "codex-unavailable";
}


async function readJson(req) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
      const error = new Error("Body too large.");
      error.code = "CODEX_INPUT";
      throw error;
    }
  }
  if (!text) return {};
  try { return JSON.parse(text); }
  catch {
    const error = new Error("Invalid JSON.");
    error.code = "CODEX_INPUT";
    throw error;
  }
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders });
  res.end(JSON.stringify(body));
}
