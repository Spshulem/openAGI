// OAuth 2.0 client for MCP servers. Implements:
//   - RFC 9728-ish protected-resource discovery (/.well-known/oauth-protected-resource)
//   - RFC 8414 authorization server metadata (/.well-known/oauth-authorization-server)
//   - RFC 7591 dynamic client registration (when registration_endpoint is advertised)
//   - PKCE S256 (RFC 7636)
//   - Authorization code grant with a local 127.0.0.1 callback listener
//   - Refresh token rotation
//   - File-backed token + client cache at <dataDir>/mcp/auth/<key>.json
//
// Designed so a daemon process (no parent terminal) can still complete the
// flow: opens the user's default browser if available, AND always logs the
// authorization URL prominently so the user can click it manually.

import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { ensureDir, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

const DEFAULT_SCOPE = "openid profile email offline_access";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min for the user to click through

export class McpOAuthClient {
  constructor(options = {}) {
    if (!options.resourceUrl) throw new Error("McpOAuthClient requires resourceUrl");
    this.name = options.name ?? "mcp";
    this.resourceUrl = stripTrailingSlash(options.resourceUrl);
    // The scope we'd *prefer*. The scope actually requested is narrowed at
    // discovery time to what the server advertises as supported — servers that
    // advertise none (e.g. Rize) get no scope param at all, instead of a
    // hardcoded set they'd reject with `invalid_scope`. A scope passed
    // explicitly (e.g. from a catalog entry) is treated as authoritative and
    // sent as-is.
    this.preferredScope = options.scope ?? DEFAULT_SCOPE;
    this.scopeExplicit = options.scope != null;
    this.dataDir = options.dataDir ?? resolveDataDir();
    this.cachePath = path.join(this.dataDir, "mcp", "auth", `${this.name}.json`);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.printAuthUrlFn = options.printAuthUrlFn ?? defaultPrintAuthUrl;
    // Optional pre-registered client (for auth servers without dynamic
    // client registration). When set, we skip RFC 7591 entirely.
    this.staticClient = options.clientId
      ? {
          client_id: options.clientId,
          client_secret: options.clientSecret ?? null,
          redirect_uris: options.redirectUris ?? null,
          token_endpoint_auth_method: options.clientSecret ? "client_secret_post" : "none"
        }
      : null;
    ensureDir(path.dirname(this.cachePath));
  }

  loadCache() {
    return readJsonFile(this.cachePath, null);
  }

  saveCache(state) {
    writeJsonAtomic(this.cachePath, { ...state, updatedAt: nowIso() });
  }

  /**
   * Return a valid access token. Uses cached if not expired, refreshes if it
   * has a refresh_token, otherwise runs the full authorization code flow.
   */
  async ensureToken({ interactive = true } = {}) {
    const cache = this.loadCache() ?? {};
    if (cache.access_token && !this.isExpired(cache)) {
      return cache.access_token;
    }
    if (cache.refresh_token && cache.discovery && cache.client) {
      try {
        await this.refresh(cache);
        return this.loadCache().access_token;
      } catch (error) {
        // fall through to full flow
        cache.refresh_token = null;
      }
    }
    // Non-interactive callers (e.g. silent reconnect on daemon boot) must never
    // trigger the browser flow — surface a typed error so the caller can leave
    // the server "idle" with a Connect button instead of popping a window.
    if (!interactive) {
      const err = new Error(`OAuth authorization required for ${this.name}`);
      err.code = "OAUTH_INTERACTIVE_REQUIRED";
      throw err;
    }
    await this.authorize();
    return this.loadCache().access_token;
  }

  isExpired(cache) {
    if (!cache.access_token || !cache.expires_at) return true;
    return Date.now() >= cache.expires_at - 30_000; // 30s safety
  }

  /**
   * Authorization code + PKCE flow. Returns once tokens are saved to cache.
   */
  // Narrow the requested scope to what this server actually supports. RFC 9728
  // (protected resource) and RFC 8414 (auth server) both may advertise
  // `scopes_supported`. We request the intersection of our preferred scopes
  // with what's advertised; if the server advertises nothing, we omit `scope`
  // entirely and let the server apply its own default. Returns null = "omit".
  resolveScope(discovery) {
    if (this.scopeExplicit) return this.preferredScope; // caller forced it
    // Prefer the resource's advertised scopes, but fall through to the auth
    // server's when the resource advertises an EMPTY list (an empty array is
    // not nullish, so a plain `??` would wrongly stop at it).
    const resourceScopes = discovery?.resourceMeta?.scopes_supported;
    const serverScopes = discovery?.serverMeta?.scopes_supported;
    const supported = (Array.isArray(resourceScopes) && resourceScopes.length) ? resourceScopes
      : (Array.isArray(serverScopes) && serverScopes.length) ? serverScopes
      : null;
    if (!supported) return null;
    const want = this.preferredScope.split(/\s+/).filter(Boolean);
    const inter = want.filter((s) => supported.includes(s));
    return inter.length ? inter.join(" ") : null;
  }

  async authorize() {
    const discovery = await this.discover();
    const scope = this.resolveScope(discovery);
    const cache = this.loadCache() ?? {};
    const client = this.staticClient ?? cache.client ?? (await this.registerClient(discovery, scope));

    const codeVerifier = base64url(randomBytes(48));
    const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
    const state = base64url(randomBytes(16));

    // Spin a one-shot loopback listener.
    const { server, port, callback } = await startCallbackServer();
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    const authUrl = new URL(discovery.serverMeta.authorization_endpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", client.client_id);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);
    // Only send `scope` when we have one the server supports — sending an
    // unsupported scope (or a hardcoded default) is what triggers invalid_scope.
    if (scope) authUrl.searchParams.set("scope", scope);
    authUrl.searchParams.set("resource", this.resourceUrl);

    this.printAuthUrlFn({ name: this.name, url: authUrl.toString() });
    openInBrowser(authUrl.toString());

    let codeResult;
    try {
      codeResult = await Promise.race([
        callback,
        new Promise((_, reject) => setTimeout(() => reject(new Error("OAuth callback timed out")), this.timeoutMs))
      ]);
    } finally {
      try { server.close(); } catch { /* ignore */ }
    }
    if (codeResult.state !== state) throw new Error("OAuth state mismatch (CSRF protection)");
    if (!codeResult.code) throw new Error("OAuth callback missing code");

    const tokens = await this.exchangeCode({
      discovery, client,
      code: codeResult.code,
      codeVerifier,
      redirectUri
    });

    this.persistTokens({ tokens, discovery, client });
  }

  /**
   * Trade an authorization code for tokens.
   */
  async exchangeCode({ discovery, client, code, codeVerifier, redirectUri }) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: client.client_id,
      code_verifier: codeVerifier
    });
    if (client.client_secret) body.set("client_secret", client.client_secret);
    const response = await fetch(discovery.serverMeta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString()
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json?.error_description ?? json?.error ?? `token endpoint returned ${response.status}`);
    return json;
  }

  /**
   * Refresh access token using a stored refresh_token.
   */
  async refresh(cache) {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: cache.refresh_token,
      client_id: cache.client.client_id
    });
    if (cache.client.client_secret) body.set("client_secret", cache.client.client_secret);
    const response = await fetch(cache.discovery.serverMeta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString()
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json?.error_description ?? `refresh failed (${response.status})`);
    this.persistTokens({ tokens: json, discovery: cache.discovery, client: cache.client });
  }

  persistTokens({ tokens, discovery, client }) {
    const expires_at = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null;
    this.saveCache({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? this.loadCache()?.refresh_token ?? null,
      token_type: tokens.token_type ?? "Bearer",
      expires_at,
      scope: tokens.scope ?? this.preferredScope,
      discovery,
      client
    });
  }

  /**
   * Discovery — fetch protected resource metadata + authorization server metadata.
   */
  async discover() {
    // 1. Protected resource metadata.
    const prmUrl = `${this.resourceUrl}/.well-known/oauth-protected-resource`;
    let resourceMeta = null;
    try {
      const r = await fetch(prmUrl, { headers: { accept: "application/json" } });
      if (r.ok) resourceMeta = await r.json();
    } catch { /* fall back below */ }

    let authServerUrl;
    if (resourceMeta?.authorization_servers?.length) {
      authServerUrl = stripTrailingSlash(resourceMeta.authorization_servers[0]);
    } else {
      // Fallback: assume same origin uses /oauth, /.well-known on the resource itself.
      authServerUrl = `${this.resourceUrl}/oauth`;
    }

    // 2. Authorization server metadata. Try the canonical RFC 8414 path,
    // then the OIDC path (some servers only expose openid-configuration).
    const candidates = [
      `${authServerUrl}/.well-known/oauth-authorization-server`,
      `${authServerUrl}/.well-known/openid-configuration`
    ];
    let serverMeta = null;
    for (const url of candidates) {
      try {
        const r = await fetch(url, { headers: { accept: "application/json" } });
        if (r.ok) { serverMeta = await r.json(); break; }
      } catch { /* try next */ }
    }
    if (!serverMeta) throw new Error(`OAuth discovery failed for ${authServerUrl}`);
    if (!serverMeta.authorization_endpoint || !serverMeta.token_endpoint) {
      throw new Error(`OAuth metadata missing required endpoints at ${authServerUrl}`);
    }
    return { authServerUrl, resourceMeta, serverMeta };
  }

  /**
   * Dynamic client registration (RFC 7591). Returns the registered client
   * descriptor, including client_id (and client_secret if confidential).
   */
  async registerClient(discovery, scope = null) {
    if (!discovery.serverMeta.registration_endpoint) {
      throw new Error("Authorization server has no registration_endpoint and no static client_id was provided");
    }
    // Only register grant types the server actually supports — Rize, for
    // example, advertises authorization_code only, so registering
    // refresh_token can be rejected.
    const supportedGrants = discovery.serverMeta.grant_types_supported;
    const grant_types = Array.isArray(supportedGrants)
      ? ["authorization_code", "refresh_token"].filter((g) => supportedGrants.includes(g))
      : ["authorization_code", "refresh_token"];
    if (!grant_types.includes("authorization_code")) grant_types.push("authorization_code");
    const body = {
      client_name: "OpenAGI",
      client_uri: "https://github.com/Spshulem/openAGI",
      redirect_uris: redirectUriCandidates(),
      grant_types,
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native"
    };
    // Only advertise a scope at registration if we have a server-supported one.
    if (scope) body.scope = scope;
    const response = await fetch(discovery.serverMeta.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body)
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json?.error_description ?? `client registration failed (${response.status})`);
    if (!json.client_id) throw new Error("Registration response missing client_id");
    return json;
  }
}

// MARK: — helpers

function defaultPrintAuthUrl({ name, url }) {
  // Print prominently on stderr so it shows in the daemon log.
  const banner = "\n" +
    "──────────────────────────────────────────────────────────────────\n" +
    `OAuth required for MCP server: ${name}\n` +
    `Open this URL in a browser to authorize:\n${url}\n` +
    "──────────────────────────────────────────────────────────────────\n";
  process.stderr.write(banner);
}

export function openInBrowser(url, { platform = process.platform, env = process.env, spawnFn = spawn } = {}) {
  // Best-effort. On a HEADLESS box (no display) there's no browser to open —
  // and on Linux a missing `xdg-open` previously CRASHED the daemon, because
  // spawn() reports a missing binary via an async 'error' event, not a sync
  // throw, so the try/catch never caught it. Now: skip the spawn when there's
  // no display, and always attach an 'error' handler so a missing/again-failing
  // opener degrades to the printed URL instead of taking down the process.
  // (The auth URL is also surfaced to the dashboard via onAuthUrl → pendingAuthUrl.)
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    return { opened: false, reason: "headless" }; // rely on the printed URL + dashboard
  }
  try {
    const cmd = platform === "darwin" ? "open"
      : platform === "win32" ? "cmd"
      : "xdg-open";
    const args = platform === "win32" ? ["/c", "start", "", url] : [url];
    const child = spawnFn(cmd, args, { detached: true, stdio: "ignore" });
    // CRITICAL: handle the async 'error' event (missing binary etc) so it
    // never bubbles up as an unhandled 'error' and kills the daemon.
    child.on?.("error", () => { /* opener missing/failed — printed URL is the fallback */ });
    child.unref?.();
    return { opened: true };
  } catch {
    return { opened: false, reason: "spawn-threw" };
  }
}

export function startCallbackServer() {
  return new Promise((resolve, reject) => {
    let resolveCb, rejectCb;
    const callback = new Promise((res, rej) => { resolveCb = res; rejectCb = rej; });
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, "http://127.0.0.1");
        if (u.pathname !== "/callback") {
          res.writeHead(404);
          res.end();
          return;
        }
        const code = u.searchParams.get("code");
        const state = u.searchParams.get("state");
        const error = u.searchParams.get("error");
        if (error) {
          const desc = u.searchParams.get("error_description") ?? "";
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><meta charset=utf-8><title>OAuth error</title><body style=font-family:system-ui;padding:40px>` +
            `<h2>Authorization failed</h2><p>${escapeHtml(error)}: ${escapeHtml(desc)}</p>` +
            `<p>You can close this window.</p></body>`);
          rejectCb(new Error(`${error}: ${desc}`));
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><meta charset=utf-8><title>OpenAGI</title><body style=font-family:system-ui;padding:40px;background:#0e1411;color:#e8efea>` +
          `<h2 style=color:#6fe1b1>✓ Authorized</h2><p>You can close this tab and return to OpenAGI.</p></body>`);
        resolveCb({ code, state });
      } catch (err) {
        try { res.writeHead(500); res.end(); } catch { /* ignore */ }
        rejectCb(err);
      }
    });
    server.on("error", reject);
    // Default: an OS-assigned random loopback port (fine when the browser and
    // daemon are on the same machine). On a HEADLESS main reached from another
    // device's browser, set OPENAGI_OAUTH_CALLBACK_PORT to a FIXED port and
    // SSH-tunnel it from the browser machine:
    //   ssh -L 8765:127.0.0.1:8765 distiller    # on the laptop
    //   OPENAGI_OAUTH_CALLBACK_PORT=8765         # on the main
    // Then the loopback redirect the browser hits tunnels back to the daemon.
    const fixed = Number.parseInt(process.env.OPENAGI_OAUTH_CALLBACK_PORT ?? "", 10);
    const listenPort = Number.isInteger(fixed) && fixed > 0 ? fixed : 0;
    server.listen(listenPort, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port, callback });
    });
  });
}

function redirectUriCandidates() {
  // We register a generic 127.0.0.1 with a wildcard port. The actual port is
  // chosen at flow time. Many auth servers require the exact URI to be in the
  // registration; for native clients it's common to use a fixed loopback URI
  // OR rely on the auth server treating 127.0.0.1 specially. Since we don't
  // know the port at registration time we register the most common pattern.
  return ["http://127.0.0.1/callback", "http://localhost/callback"];
}

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function stripTrailingSlash(u) {
  return String(u).replace(/\/+$/, "");
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]);
}
