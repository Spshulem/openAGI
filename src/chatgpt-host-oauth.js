import crypto from "node:crypto";

const ISSUER = "https://auth.openai.com";
// Public OAuth client identifier used by the Codex device authorization flow.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CATALOG_URL = "https://chatgpt.com/backend-api/codex/models";

function accountHeader(accessToken) {
  try {
    const claims = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8"));
    const account = claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof account === "string" && /^[\w-]{1,128}$/.test(account)
      ? { "ChatGPT-Account-ID": account } : {};
  } catch { return {}; }
}

function devicePollErrorStatus(value) {
  const code = String(value?.error ?? value?.code ?? value?.error_code ?? "").toLowerCase();
  const message = String(value?.error_description ?? value?.message ?? value?.detail ?? "").toLowerCase();
  const combined = `${code} ${message}`;
  if (combined.includes("authorization_pending") || combined.includes("pending")) return "pending";
  if (combined.includes("slow_down") || combined.includes("slow down")) return "slow_down";
  if (combined.includes("expired")) return "expired";
  if (combined.includes("access_denied") || combined.includes("denied")) return "denied";
  return null;
}

export class ChatGptHostOAuth {
  constructor({ store, fetchImpl = globalThis.fetch, clock = Date.now } = {}) {
    if (!store?.read || !store?.write) throw new TypeError("ChatGPT OAuth requires a private token store.");
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.pending = null;
    this.completedLoginId = null;
    this.refreshPromise = null;
    this.generation = 0;
  }

  async startDeviceLogin() {
    if (this.pending) throw Object.assign(new Error("Device login already pending."), { code: "CHATGPT_LOGIN_PENDING" });
    if (!this.store.readGeneration) throw Object.assign(new Error("Credential generation unavailable."), { code: "CHATGPT_STORE_UNAVAILABLE" });
    let persistedGeneration;
    try { persistedGeneration = await this.store.readGeneration(); }
    catch { throw Object.assign(new Error("Credential generation unavailable."), { code: "CHATGPT_STORE_UNAVAILABLE" }); }
    let response;
    try {
      response = await this.fetchImpl(`${ISSUER}/api/accounts/deviceauth/usercode`, {
        method: "POST", redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: CLIENT_ID }),
        signal: AbortSignal.timeout(15_000)
      });
    } catch {
      throw Object.assign(new Error("Device login transport unavailable."), { code: "CHATGPT_DEVICE_AUTHORIZATION_TRANSPORT" });
    }
    if (!response.ok) throw Object.assign(new Error("Device login is unavailable."), { code: "CHATGPT_DEVICE_AUTHORIZATION_REJECTED" });
    let data;
    try { data = await readBoundedJson(response); }
    catch { throw Object.assign(new Error("Invalid device login response."), { code: "CHATGPT_DEVICE_AUTHORIZATION_PROTOCOL" }); }
    if (typeof data?.user_code !== "string" || !data.user_code || typeof data?.device_auth_id !== "string" || !data.device_auth_id) {
      throw Object.assign(new Error("Invalid device login response."), { code: "CHATGPT_PROTOCOL" });
    }
    const loginId = crypto.randomBytes(16).toString("hex");
    this.pending = {
      loginId, generation: this.generation, persistedGeneration, userCode: data.user_code, deviceAuthId: data.device_auth_id,
      expiresAt: this.clock() + 15 * 60_000,
      nextPollAt: this.clock() + Math.max(3, Number(data.interval) || 5) * 1_000,
      intervalMs: Math.max(3, Number(data.interval) || 5) * 1_000,
      polling: false
    };
    return {
      type: "chatgptDeviceCode", loginId, userCode: data.user_code,
      verificationUrl: `${ISSUER}/codex/device`
    };
  }

  async pollDeviceLogin(loginId) {
    if (!this.pending && loginId === this.completedLoginId) return { status: "connected" };
    const pending = this.pending;
    if (!pending || loginId !== pending.loginId) throw Object.assign(new Error("Unknown login."), { code: "CHATGPT_LOGIN_EXPIRED" });
    if (this.clock() >= pending.expiresAt) {
      this.pending = null;
      throw Object.assign(new Error("Device login expired."), { code: "CHATGPT_LOGIN_EXPIRED" });
    }
    if (pending.polling || this.clock() < pending.nextPollAt) return { status: "pending" };
    pending.polling = true;
    pending.nextPollAt = this.clock() + pending.intervalMs;
    try {
      let reply;
      try {
        reply = await this.fetchImpl(`${ISSUER}/api/accounts/deviceauth/token`, {
          method: "POST", redirect: "error",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ device_auth_id: pending.deviceAuthId, user_code: pending.userCode }),
          signal: AbortSignal.timeout(15_000)
        });
      } catch (error) {
        const detail = String(error?.cause?.message ?? error?.message ?? "").toLowerCase();
        return { status: "failed", providerState: detail.includes("redirect") ? "transport_redirect" : "transport_failed" };
      }
      if (reply.status === 403 || reply.status === 404 || reply.status === 400) {
        // The upstream body may explain the state, but may also contain
        // account-specific detail. Return only a fixed safe enum.
        const body = await readBoundedJson(reply).catch(() => null);
        const status = devicePollErrorStatus(body);
        if (status === "pending") return { status: "pending", providerState: "authorization_pending" };
        if (status === "slow_down") {
          pending.intervalMs += 5_000;
          pending.nextPollAt = this.clock() + pending.intervalMs;
          return { status: "pending", providerState: "slow_down" };
        }
        if (status === "expired") {
          this.pending = null;
          throw Object.assign(new Error("Device login expired."), { code: "CHATGPT_LOGIN_EXPIRED" });
        }
        if (status === "denied") {
          throw Object.assign(new Error("Device authorization denied."), { code: "CHATGPT_LOGIN_FAILED" });
        }
        if (reply.status === 403) return { status: "pending", providerState: "forbidden" };
        if (reply.status === 404) return { status: "pending", providerState: "not_found" };
      }
      if (!reply.ok) {
        const providerState = reply.status === 401 ? "upstream_unauthorized"
          : reply.status === 429 ? "upstream_rate_limited" : "upstream_unexpected";
        return { status: "failed", providerState };
      }
      let code;
      try {
        code = await readBoundedJson(reply);
      } catch {
        return { status: "failed", providerState: "device_authorization_protocol" };
      }
      if (typeof code.authorization_code !== "string" || typeof code.code_verifier !== "string") {
        return { status: "failed", providerState: "device_authorization_protocol" };
      }
      let tokenReply;
      try {
        tokenReply = await this.fetchImpl(`${ISSUER}/oauth/token`, {
          method: "POST", redirect: "error",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code", code: code.authorization_code,
            redirect_uri: `${ISSUER}/deviceauth/callback`, client_id: CLIENT_ID,
            code_verifier: code.code_verifier
          }).toString(),
          signal: AbortSignal.timeout(15_000)
        });
      } catch {
        return { status: "failed", providerState: "token_exchange_transport" };
      }
      if (!tokenReply.ok) return { status: "failed", providerState: "token_exchange_rejected" };
      let token;
      try {
        token = await readBoundedJson(tokenReply);
      } catch {
        return { status: "failed", providerState: "token_exchange_protocol" };
      }
      if (typeof token.access_token !== "string" || !token.access_token || typeof token.refresh_token !== "string" || !token.refresh_token) {
        return { status: "failed", providerState: "token_exchange_protocol" };
      }
      const ttl = Number(token.expires_in);
      if (!this.store.withLock || !this.store.bumpGeneration) {
        throw Object.assign(new Error("Credential lock unavailable."), { code: "CHATGPT_STORE_UNAVAILABLE" });
      }
      await this.store.withLock(async () => {
        if (this.generation !== pending.generation || this.pending !== pending
          || (await this.store.readGeneration()) !== pending.persistedGeneration) {
          throw Object.assign(new Error("Device login canceled."), { code: "CHATGPT_LOGIN_EXPIRED" });
        }
        // New grants revoke in-flight turns even if the user reconnects the
        // same account; bump before writing so a failed write cannot preserve
        // the old authority epoch.
        await this.store.bumpGeneration();
        await this.store.write({
          accessToken: token.access_token, refreshToken: token.refresh_token,
          expiresAt: this.clock() + (Number.isFinite(ttl) && ttl > 0 ? ttl : 3600) * 1000
        });
      });
      this.pending = null;
      this.completedLoginId = loginId;
      return { status: "connected" };
    } finally {
      pending.polling = false;
    }
  }

  async status() {
    const token = await this.store.read();
    return { provider: "openai-chatgpt", authMode: "chatgpt", connected: Boolean(token?.refreshToken && !token.refreshRejected) };
  }

  async listModels() {
    const accessToken = await this.getAccessToken();
    for (const version of ["99.0.0", "0.0.0"]) {
      const reply = await this.fetchImpl(`${CATALOG_URL}?client_version=${version}`, {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${accessToken}`, ...accountHeader(accessToken) }
      });
      if (reply.status === 401 || reply.status === 403) {
        throw Object.assign(new Error("ChatGPT account catalogue rejected the session."), { code: "CHATGPT_CATALOG_UNAVAILABLE" });
      }
      if (!reply.ok) continue;
      // Account catalogues contain large per-model metadata: even a nine-model
      // local Codex cache can exceed 256 KiB. Bound the reply independently of
      // the small OAuth token/device responses.
      const data = await readBoundedJson(reply, 2 * 1024 * 1024);
      if (!Array.isArray(data?.models)) continue;
      const models = data.models
        .filter((entry) => entry && typeof entry.slug === "string"
          && /^[a-zA-Z0-9_.-]{1,100}$/.test(entry.slug)
          && !["hide", "hidden"].includes(String(entry.visibility ?? "").toLowerCase()))
        .sort((a, b) => (Number.isFinite(a.priority) ? a.priority : 10_000)
          - (Number.isFinite(b.priority) ? b.priority : 10_000))
        .map((entry) => entry.slug);
      if (models.length) return [...new Set(models)];
    }
    throw Object.assign(new Error("ChatGPT account catalogue is unavailable."), { code: "CHATGPT_CATALOG_UNAVAILABLE" });
  }

  async getCredentialGeneration() {
    if (!this.store.readGeneration) throw Object.assign(new Error("Credential generation unavailable."), { code: "CHATGPT_STORE_UNAVAILABLE" });
    return this.store.readGeneration();
  }

  async logout() {
    this.generation += 1;
    this.pending = null;
    this.completedLoginId = null;
    if (!this.store.withLock || !this.store.clear || !this.store.bumpGeneration) {
      throw Object.assign(new Error("Credential store unavailable."), { code: "CHATGPT_STORE_UNAVAILABLE" });
    }
    await this.store.withLock(async () => {
      await this.store.bumpGeneration();
      await this.store.clear();
    });
    return { status: "logged-out" };
  }

  async getAccessToken() {
    const token = await this.store.read();
    if (!token?.refreshToken || token.refreshRejected) throw Object.assign(new Error("ChatGPT login required."), { code: "CHATGPT_LOGIN_REQUIRED" });
    if (token.accessToken && token.expiresAt > this.clock() + 120_000) return token.accessToken;
    if (!this.store.withLock) throw Object.assign(new Error("Credential lock unavailable."), { code: "CHATGPT_STORE_UNAVAILABLE" });
    if (!this.refreshPromise) {
      this.refreshPromise = this.store.withLock(async () => {
        const current = await this.store.read();
        if (!current?.refreshToken || current.refreshRejected) throw Object.assign(new Error("ChatGPT login required."), { code: "CHATGPT_LOGIN_REQUIRED" });
        if (current.accessToken && current.expiresAt > this.clock() + 120_000) return current.accessToken;
        const reply = await this.fetchImpl(`${ISSUER}/oauth/token`, {
          method: "POST", redirect: "error",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: CLIENT_ID }).toString(),
          signal: AbortSignal.timeout(15_000)
        });
        if ([400, 401, 403].includes(reply.status)) {
          // Persist the rejection under the refresh lock: another process must
          // not keep replaying a revoked/invalid grant on subsequent turns.
          await this.store.write({ ...current, refreshRejected: true });
        }
        if (!reply.ok) throw Object.assign(new Error("ChatGPT token refresh failed."), { code: "CHATGPT_REFRESH_FAILED" });
        const updated = await readBoundedJson(reply);
        if (typeof updated.access_token !== "string" || !updated.access_token) {
          throw Object.assign(new Error("Invalid token response."), { code: "CHATGPT_PROTOCOL" });
        }
        const ttl = Number(updated.expires_in);
        await this.store.write({
          accessToken: updated.access_token,
          refreshToken: typeof updated.refresh_token === "string" && updated.refresh_token ? updated.refresh_token : current.refreshToken,
          expiresAt: this.clock() + (Number.isFinite(ttl) && ttl > 0 ? ttl : 3600) * 1000
        });
        return updated.access_token;
      }).finally(() => { this.refreshPromise = null; });
    }
    return this.refreshPromise;
  }
}

async function readBoundedJson(reply, limit = 16 * 1024) {
  if (!reply.body?.getReader) throw Object.assign(new Error("Missing OAuth response."), { code: "CHATGPT_PROTOCOL" });
  const reader = reply.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw Object.assign(new Error("OAuth response too large."), { code: "CHATGPT_PROTOCOL" });
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")); }
  catch { throw Object.assign(new Error("Invalid OAuth response."), { code: "CHATGPT_PROTOCOL" }); }
}
