import fs from "node:fs";
import path from "node:path";
import { McpStdioClient } from "./mcp-client.js";
import { McpHttpClient } from "./mcp-http-client.js";
import { McpOAuthClient } from "./mcp-oauth.js";
import { ensureDir, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";
import { assertSafePublicUrl } from "./url-guard.js";

// Whitelist of executables permitted as the `command` for stdio MCP servers.
// Anything not in this set is rejected at registerServer() — closes the
// "register /bin/sh -c <payload>" RCE path.
const ALLOWED_STDIO_COMMANDS = new Set([
  "npx", "node", "bun", "bunx", "deno",
  "python", "python3", "uv", "uvx",
  "docker"
]);

// MCP tools are exposed to the model as `mcp_<server>_<tool>`, and that name
// must match OpenAI's tool-name rule ^[a-zA-Z0-9_-]+$. BOTH segments can carry
// spaces/punctuation (e.g. a server literally named "BB Staging"), so sanitize
// each — otherwise the whole tools[] array is rejected and every tool-bearing
// call (autopilot, chat, sweeps) fails. The handler dispatches via stored
// server/tool refs, not by parsing this name, so sanitizing is lossless.
const mcpSeg = (s) => String(s).replace(/[^a-zA-Z0-9_]/g, "_");
const mcpToolName = (server, tool) => `mcp_${mcpSeg(server)}_${mcpSeg(tool)}`;
const mcpToolPrefix = (server) => `mcp_${mcpSeg(server)}_`;

export class McpRegistry {
  constructor(options = {}) {
    this.servers = new Map();
    this.clients = new Map();
    this.logDir = options.logDir;
    this.dataDir = options.dataDir ?? (options.logDir ? path.dirname(path.dirname(options.logDir)) : resolveDataDir());
    this.toolRegistry = options.toolRegistry ?? null;
    // Set by hosted-interface so OAuth-required surfaces in the dashboard SSE.
    this.onOauthRequired = options.onOauthRequired ?? null;
    this.connecting = new Map(); // name → Promise (in-flight connect)
    // Allowlist of env-var names the user has opted into via .openagi/.env.
    // Only these can flow into ${VAR} substitutions; references to anything
    // else (AWS_*, GITHUB_TOKEN, etc.) throw at registerServer().
    this.permittedEnvKeys = options.permittedEnvKeys instanceof Set
      ? options.permittedEnvKeys
      : new Set(loadDotenvKeys(this.dataDir));
    // When set, registerServer() persists the current set of registrations
    // back to this path so they survive a daemon restart. loadConfigFile()
    // skips writing (the file is the source of truth, not the destination).
    this.configPath = options.configPath ?? null;
    this._suppressPersist = false;
  }

  /// Allow runtime to whitelist a new env-var name (e.g. when a wizard
  /// step adds STRIPE_MCP_API_KEY to .env mid-session, and a follow-up
  /// registerServer call needs to expand `${STRIPE_MCP_API_KEY}` against it).
  allowEnvKey(name) {
    if (!name) return;
    this.permittedEnvKeys.add(String(name));
  }

  bindToolRegistry(toolRegistry) {
    this.toolRegistry = toolRegistry;
  }

  registerServer(server) {
    if (!server?.name) throw new Error("MCP server requires a name.");
    let transport = server.transport;
    if (!transport) {
      if (server.url) transport = "http";
      else if (server.command) transport = "stdio";
      else transport = "config";
    }

    // stdio command allowlist — must be a known runner.
    if (transport === "stdio") {
      const cmd = server.command;
      if (!cmd) throw new Error("stdio MCP server requires a `command`.");
      const cmdLeaf = String(cmd).trim().split("/").pop();
      if (!ALLOWED_STDIO_COMMANDS.has(cmdLeaf)) {
        throw new Error(
          `stdio command "${cmd}" is not in the allowlist. ` +
          `Permitted: ${[...ALLOWED_STDIO_COMMANDS].join(", ")}.`
        );
      }
    }

    // http URL must be http(s) and not a loopback / link-local / RFC1918 host.
    if (transport === "http") {
      if (!server.url) throw new Error("http MCP server requires a `url`.");
      assertSafeMcpUrl(server.url);
    }

    const allowed = this.permittedEnvKeys;
    const normalized = {
      name: server.name,
      transport,
      // stdio-specific
      command: server.command ?? null,
      // Args go through ${VAR} expansion too — mcp-remote in particular
      // takes "--header statsig-api-key=${STATSIG_API_KEY}" as a CLI arg,
      // not env, so the substitution has to happen here. _persist still
      // writes the un-expanded original so secrets stay in .env.
      args: (server.args ?? []).map((a) => expandValue(a, allowed)),
      env: expandEnv(server.env ?? {}, allowed),
      cwd: server.cwd ?? null,
      // http-specific
      url: server.url ?? null,
      auth: server.auth ?? (server.apiKey ? "bearer" : (server.url ? "oauth" : "none")),
      apiKey: expandValue(server.apiKey ?? null, allowed),
      headers: expandEnv(server.headers ?? {}, allowed),
      scope: server.scope,
      // OAuth pre-registered client (for servers without dynamic registration)
      clientId: expandValue(server.clientId ?? null, allowed),
      clientSecret: expandValue(server.clientSecret ?? null, allowed),
      resourceUrl: server.resourceUrl ?? null,
      // shared
      trustLevel: server.trustLevel ?? "untrusted",
      tools: server.tools ?? [],
      enabled: server.enabled ?? true
    };
    this.servers.set(normalized.name, normalized);
    if (!this._suppressPersist) this._persist(server);
    return normalized;
  }

  /// Save the un-expanded server specs to configPath (if set). We keep the
  /// `${VAR}` indirection so secrets stay in .env, not duplicated into the
  /// JSON. Called automatically from registerServer; no-op if the registry
  /// wasn't constructed with a configPath. Throws on either of:
  ///   - apiKey passed as a literal value (must be `${VAR}` to persist)
  ///   - filesystem write failure
  /// so callers that registered through an HTTP endpoint see a real error
  /// instead of "200 OK but quietly lost on next boot".
  _persist(originalSpec) {
    if (!this.configPath) return;
    // Refuse to write raw bearer tokens to disk. Callers that need a
    // bearer should add the env var via .env + allowEnvKey() and pass
    // the apiKey as `${VAR}`. This catches /mcp/register callers that
    // would otherwise leak an sk_live_… into mcp.json.
    if (originalSpec?.apiKey != null && !looksLikeEnvPlaceholder(originalSpec.apiKey)) {
      throw new Error(
        `MCP server '${originalSpec.name}': refusing to persist a literal apiKey. ` +
        `Pass apiKey: '\${VAR_NAME}' and put the value in .env so it isn't duplicated to mcp.json.`
      );
    }
    const existing = readJsonFile(this.configPath, null) ?? {};
    const servers = existing.servers ?? existing.mcpServers ?? {};
    // Round-trip what the caller passed (with `${VAR}` placeholders intact)
    // so we never write the expanded secret back to disk.
    const spec = {
      ...(originalSpec ?? {}),
      // Drop fields that aren't valid in the file schema.
      name: undefined
    };
    for (const k of Object.keys(spec)) {
      if (spec[k] === undefined) delete spec[k];
    }
    servers[originalSpec.name] = spec;
    const out = existing.mcpServers ? { ...existing, mcpServers: servers } : { ...existing, servers };
    writeJsonAtomic(this.configPath, out);
  }

  loadConfigFile(filePath) {
    if (!filePath) return [];
    const config = readJsonFile(filePath, null);
    if (!config) return [];
    const registered = [];
    const servers = config.servers ?? config.mcpServers ?? {};
    this._suppressPersist = true;
    try {
    for (const [name, spec] of Object.entries(servers)) {
      // Skip comment-only entries (keys like "_comment", "//", "//2").
      if (name.startsWith("_") || name === "//" || /^\/\/\d*$/.test(name)) continue;
      if (typeof spec !== "object" || spec === null) continue;
      registered.push(
        this.registerServer({
          name,
          // stdio
          command: spec.command,
          args: spec.args ?? [],
          env: spec.env ?? {},
          cwd: spec.cwd,
          // http
          url: spec.url,
          auth: spec.auth,
          apiKey: spec.apiKey,
          headers: spec.headers ?? {},
          scope: spec.scope,
          // OAuth pre-registered client (for non-DCR auth servers)
          clientId: spec.clientId,
          clientSecret: spec.clientSecret,
          resourceUrl: spec.resourceUrl,
          // shared
          trustLevel: spec.trustLevel ?? "trusted",
          enabled: spec.enabled ?? true,
          transport: spec.transport
        })
      );
    }
    } finally {
      this._suppressPersist = false;
    }
    return registered;
  }

  listServers() {
    return [...this.servers.values()].map((server) => {
      const client = this.clients.get(server.name);
      return {
        name: server.name,
        trustLevel: server.trustLevel,
        enabled: server.enabled,
        transport: server.transport,
        command: server.command,
        args: server.args,
        url: server.url,
        auth: server.auth,
        tools: client?.tools?.map((tool) => tool.name) ?? server.tools.map((tool) => tool.name ?? tool),
        connected: client?.connected ?? false,
        lastError: client?.lastError ?? null
      };
    });
  }

  listTools() {
    const out = [];
    for (const [name, server] of this.servers) {
      const client = this.clients.get(name);
      const tools = client?.tools ?? server.tools ?? [];
      for (const tool of tools) {
        const rawName = tool.name ?? tool;
        out.push({
          server: name,
          trustLevel: server.trustLevel,
          name: rawName,
          // The name the tool is actually registered + callable under (matches
          // exposeAsTools). Consumers that build allowlists must use this.
          registeredName: mcpToolName(name, rawName),
          description: tool.description ?? "",
          inputSchema: tool.inputSchema ?? null,
          connected: Boolean(client?.connected)
        });
      }
    }
    return out;
  }

  isConnecting(name) {
    return this.connecting.has(name);
  }

  async connect(name, { silent = false } = {}) {
    const inflight = this.connecting.get(name);
    if (inflight) {
      // An interactive (non-silent) in-flight connect serves any caller. A
      // silent in-flight connect serves silent callers. But an interactive
      // caller must NOT be handed a silent attempt (which fails fast without
      // opening a browser) — wait for it, then connect interactively if the
      // silent attempt didn't already get us connected.
      if (!inflight.silent || silent) return inflight.promise;
      return inflight.promise.then(
        (status) => status,
        () => this.connect(name, { silent: false })
      );
    }
    const promise = this.doConnect(name, { silent });
    const entry = { promise, silent };
    this.connecting.set(name, entry);
    // The caller awaits `promise` and handles its rejection; this cleanup chain
    // is separate, so swallow its copy of the rejection to avoid an
    // unhandledRejection when a connect fails (e.g. silent boot reconnect).
    promise.finally(() => {
      if (this.connecting.get(name) === entry) this.connecting.delete(name);
    }).catch(() => {});
    return promise;
  }

  /**
   * Silently obtain a Bearer token for a connected OAuth MCP server, reusing
   * the registry's own OAuth client (or the cached token on disk) — never opens
   * a browser. Returns null when there's no usable token. This is the shared
   * primitive integrations use to call a vendor's REST/GraphQL API with the
   * same login the user already granted to that vendor's MCP server.
   */
  async silentTokenFor(name) {
    let oauth = this.clients.get(name)?.oauth ?? null;
    if (!oauth) {
      const server = this.servers.get(name);
      if (server?.auth !== "oauth" || !server.url) return null;
      oauth = new McpOAuthClient({
        name: server.name,
        resourceUrl: server.resourceUrl ?? deriveResourceUrl(server.url),
        scope: server.scope,
        dataDir: this.dataDir
      });
    }
    try {
      return await oauth.ensureToken({ interactive: false });
    } catch {
      return null;
    }
  }

  /**
   * Sync probe: is there a usable OAuth token cached on disk for this server
   * (so an integration can report itself "configured" without a network call)?
   * Reads the same <dataDir>/mcp/auth/<name>.json the OAuth client writes.
   */
  hasOAuthToken(name) {
    try {
      const cache = readJsonFile(path.join(this.dataDir, "mcp", "auth", `${name}.json`), null);
      if (!cache) return false;
      // Mirror what ensureToken({interactive:false}) can actually do: a
      // refresh_token can always mint a fresh access token silently, but a
      // bare access_token only counts while unexpired (same 30s safety margin
      // as McpOAuthClient.isExpired) — otherwise integrations report
      // "configured", ack webhooks, and then silently fail to authenticate.
      if (cache.refresh_token) return true;
      if (!cache.access_token || !cache.expires_at) return false;
      return Date.now() < cache.expires_at - 30_000;
    } catch {
      return false;
    }
  }

  async doConnect(name, { silent = false } = {}) {
    const server = this.servers.get(name);
    if (!server) throw new Error(`Unknown MCP server: ${name}`);
    if (!server.enabled) throw new Error(`MCP server ${name} is disabled.`);

    let client = this.clients.get(name);
    if (!client) {
      if (server.transport === "stdio") {
        if (!server.command) {
          throw new Error(`MCP server '${name}' is stdio but has no command — set 'command' (and 'args') so it can be spawned.`);
        }
        client = new McpStdioClient({
          name: server.name,
          command: server.command,
          args: server.args,
          env: server.env,
          cwd: server.cwd,
          trustLevel: server.trustLevel,
          logDir: this.logDir
        });
      } else if (server.transport === "http") {
        if (!server.url) throw new Error(`MCP server '${name}' is http but has no url.`);
        let oauth = null;
        let bearerToken = null;
        if (server.auth === "oauth") {
          const onAuthUrl = ({ url }) => {
            if (this.onOauthRequired) this.onOauthRequired({ name: server.name, url });
            // also keep the stderr banner so headless daemons can be unblocked
            const banner = "\n──────────────────────────────────────────────────────────────────\n" +
              `OAuth required for MCP server: ${server.name}\nOpen this URL in a browser to authorize:\n${url}\n` +
              "──────────────────────────────────────────────────────────────────\n";
            try { process.stderr.write(banner); } catch { /* ignore */ }
          };
          oauth = new McpOAuthClient({
            name: server.name,
            resourceUrl: server.resourceUrl ?? deriveResourceUrl(server.url),
            scope: server.scope,
            dataDir: this.dataDir,
            clientId: server.clientId,
            clientSecret: server.clientSecret,
            printAuthUrlFn: onAuthUrl
          });
        } else if (server.auth === "bearer") {
          if (!server.apiKey) throw new Error(`MCP server '${name}' has auth=bearer but no apiKey.`);
          bearerToken = server.apiKey;
        }
        client = new McpHttpClient({
          name: server.name,
          url: server.url,
          headers: server.headers,
          bearerToken,
          oauth,
          trustLevel: server.trustLevel,
          logDir: this.logDir
        });
      } else {
        throw new Error(`MCP server '${name}' has unsupported transport '${server.transport}'. Use 'stdio' (with command) or 'http' (with url).`);
      }
      this.clients.set(name, client);
    }
    // silent → never open a browser for OAuth; fail fast if a token isn't cached.
    await client.connect({ interactive: !silent });
    this.exposeAsTools(server.name);
    return client.status();
  }

  async connectAll({ silent = false } = {}) {
    const targets = [...this.servers].filter(([, server]) => {
      if (!server.enabled) return false;
      if (server.transport === "stdio" && !server.command) return false;
      if (server.transport === "http" && !server.url) return false;
      return server.transport === "stdio" || server.transport === "http";
    });
    const attempt = (name) => this.connect(name, { silent }).then(
      (status) => ({ name, ok: true, status }),
      (error) => ({ name, ok: false, error: error.message, code: error.code ?? null })
    );
    // Silent boot reconnect runs concurrently (no browser, so no popup storm)
    // to pay max-latency, not sum. Interactive connect-all stays sequential so
    // we never open several OAuth browser tabs at once.
    if (silent) return Promise.all(targets.map(([name]) => attempt(name)));
    const results = [];
    for (const [name] of targets) results.push(await attempt(name));
    return results;
  }

  async disconnect(name) {
    const client = this.clients.get(name);
    if (!client) return false;
    client.close();
    this.clients.delete(name);
    if (this.toolRegistry) {
      for (const toolName of [...this.toolRegistry.tools.keys()]) {
        if (toolName.startsWith(mcpToolPrefix(name))) this.toolRegistry.unregister(toolName);
      }
    }
    return true;
  }

  async disconnectAll() {
    for (const name of [...this.clients.keys()]) {
      await this.disconnect(name);
    }
  }

  async callTool(serverName, toolName, args) {
    const client = this.clients.get(serverName);
    if (!client) throw new Error(`MCP server ${serverName} is not connected. Call /mcp/connect first.`);
    return client.callTool(toolName, args);
  }

  exposeAsTools(serverName) {
    if (!this.toolRegistry) return;
    const client = this.clients.get(serverName);
    if (!client) return;
    for (const toolName of [...this.toolRegistry.tools.keys()]) {
      if (toolName.startsWith(mcpToolPrefix(serverName))) this.toolRegistry.unregister(toolName);
    }
    for (const tool of client.tools ?? []) {
      const safeName = mcpToolName(serverName, tool.name);
      this.toolRegistry.register({
        name: safeName,
        description: `[MCP:${serverName}] ${tool.description ?? tool.name}`,
        source: "mcp",
        parameters: tool.inputSchema ?? {
          type: "object",
          properties: {},
          additionalProperties: true
        },
        handler: (args) => client.callTool(tool.name, args ?? {}),
        metadata: { server: serverName, originalName: tool.name }
      });
    }
  }
}

// Resolve "${ENV_VAR}" placeholders so config can reference secrets without
// embedding them in the file. Only env-vars that the user has opted into via
// .openagi/.env are eligible — references to host env vars outside that set
// (e.g. AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN) throw, preventing exfiltration
// through an MCP server's auth header.
function expandValue(value, allowedKeys) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, key) => {
    if (allowedKeys && !allowedKeys.has(key)) {
      throw new Error(
        `${key} is not in the env allowlist. Add it to .openagi/.env to reference it from MCP config.`
      );
    }
    return process.env[key] ?? "";
  });
}

// Strict-shape predicate: the apiKey field is either entirely a `${VAR}`
// placeholder (which expandValue will substitute at register time) or empty.
// Anything else is a literal bearer that we refuse to persist.
function looksLikeEnvPlaceholder(value) {
  if (value == null || value === "") return true;
  if (typeof value !== "string") return false;
  return /^\$\{[A-Z0-9_]+\}$/i.test(value.trim());
}

function expandEnv(obj, allowedKeys) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) out[k] = expandValue(v, allowedKeys);
  return out;
}

// Read keys out of .openagi/.env so registerServer knows what may be expanded.
// We deliberately don't read process.env directly — only what the user has
// explicitly placed in this file is eligible for ${VAR} substitution.
function loadDotenvKeys(dataDir) {
  const file = path.join(dataDir ?? resolveDataDir(), ".env");
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const keys = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

// Reject MCP URLs that point at loopback / link-local / RFC1918 / cloud
// metadata endpoints. Combined with the env-var allowlist this closes the
// SSRF + secret-exfil chain through `/mcp/register`. Delegates to the shared
// url-guard (same guard the fetch_url tool uses).
function assertSafeMcpUrl(value) {
  assertSafePublicUrl(value, "MCP url");
}

// For OAuth discovery, use the MCP endpoint's origin as the resource URL
// (where /.well-known/oauth-protected-resource lives), unless the user
// explicitly overrides it. e.g. https://mcp.example.com/mcp → https://mcp.example.com
function deriveResourceUrl(mcpUrl) {
  try {
    const u = new URL(mcpUrl);
    return u.origin;
  } catch {
    return mcpUrl;
  }
}
