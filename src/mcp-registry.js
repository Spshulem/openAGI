import fs from "node:fs";
import path from "node:path";
import { McpStdioClient } from "./mcp-client.js";
import { McpHttpClient } from "./mcp-http-client.js";
import { McpOAuthClient } from "./mcp-oauth.js";
import { ensureDir, readJsonFile } from "./file-utils.js";

export class McpRegistry {
  constructor(options = {}) {
    this.servers = new Map();
    this.clients = new Map();
    this.logDir = options.logDir;
    this.dataDir = options.dataDir ?? (options.logDir ? path.dirname(path.dirname(options.logDir)) : ".openagi");
    this.toolRegistry = options.toolRegistry ?? null;
    // Set by hosted-interface so OAuth-required surfaces in the dashboard SSE.
    this.onOauthRequired = options.onOauthRequired ?? null;
    this.connecting = new Map(); // name → Promise (in-flight connect)
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
    const normalized = {
      name: server.name,
      transport,
      // stdio-specific
      command: server.command ?? null,
      args: server.args ?? [],
      env: expandEnv(server.env ?? {}),
      cwd: server.cwd ?? null,
      // http-specific
      url: server.url ?? null,
      auth: server.auth ?? (server.apiKey ? "bearer" : (server.url ? "oauth" : "none")),
      apiKey: expandValue(server.apiKey ?? null),
      headers: expandEnv(server.headers ?? {}),
      scope: server.scope,
      // shared
      trustLevel: server.trustLevel ?? "untrusted",
      tools: server.tools ?? [],
      enabled: server.enabled ?? true
    };
    this.servers.set(normalized.name, normalized);
    return normalized;
  }

  loadConfigFile(filePath) {
    if (!filePath) return [];
    const config = readJsonFile(filePath, null);
    if (!config) return [];
    const registered = [];
    const servers = config.servers ?? config.mcpServers ?? {};
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
          // shared
          trustLevel: spec.trustLevel ?? "trusted",
          enabled: spec.enabled ?? true,
          transport: spec.transport
        })
      );
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
        out.push({
          server: name,
          trustLevel: server.trustLevel,
          name: tool.name ?? tool,
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

  async connect(name) {
    if (this.connecting.has(name)) return this.connecting.get(name);
    const promise = this.doConnect(name);
    this.connecting.set(name, promise);
    promise.finally(() => this.connecting.delete(name));
    return promise;
  }

  async doConnect(name) {
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
            resourceUrl: deriveResourceUrl(server.url),
            scope: server.scope,
            dataDir: this.dataDir,
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
    await client.connect();
    this.exposeAsTools(server.name);
    return client.status();
  }

  async connectAll() {
    const results = [];
    for (const [name, server] of this.servers) {
      if (!server.enabled) continue;
      if (server.transport === "stdio" && !server.command) continue;
      if (server.transport === "http" && !server.url) continue;
      if (server.transport !== "stdio" && server.transport !== "http") continue;
      try {
        const status = await this.connect(name);
        results.push({ name, ok: true, status });
      } catch (error) {
        results.push({ name, ok: false, error: error.message });
      }
    }
    return results;
  }

  async disconnect(name) {
    const client = this.clients.get(name);
    if (!client) return false;
    client.close();
    this.clients.delete(name);
    if (this.toolRegistry) {
      for (const toolName of [...this.toolRegistry.tools.keys()]) {
        if (toolName.startsWith(`mcp_${name}_`)) this.toolRegistry.unregister(toolName);
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
      if (toolName.startsWith(`mcp_${serverName}_`)) this.toolRegistry.unregister(toolName);
    }
    for (const tool of client.tools ?? []) {
      const safeName = `mcp_${serverName}_${String(tool.name).replace(/[^a-zA-Z0-9_]/g, "_")}`;
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
// embedding them in the file. Bare strings pass through unchanged.
function expandValue(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, key) => process.env[key] ?? "");
}

function expandEnv(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) out[k] = expandValue(v);
  return out;
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
