import fs from "node:fs";
import path from "node:path";
import { McpStdioClient } from "./mcp-client.js";
import { ensureDir, readJsonFile } from "./file-utils.js";

export class McpRegistry {
  constructor(options = {}) {
    this.servers = new Map();
    this.clients = new Map();
    this.logDir = options.logDir;
    this.toolRegistry = options.toolRegistry ?? null;
  }

  bindToolRegistry(toolRegistry) {
    this.toolRegistry = toolRegistry;
  }

  registerServer(server) {
    if (!server?.name) throw new Error("MCP server requires a name.");
    const normalized = {
      name: server.name,
      command: server.command ?? null,
      args: server.args ?? [],
      env: server.env ?? {},
      cwd: server.cwd ?? null,
      trustLevel: server.trustLevel ?? "untrusted",
      tools: server.tools ?? [],
      enabled: server.enabled ?? true,
      transport: server.transport ?? (server.command ? "stdio" : "config")
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
      registered.push(
        this.registerServer({
          name,
          command: spec.command,
          args: spec.args ?? [],
          env: spec.env ?? {},
          cwd: spec.cwd,
          trustLevel: spec.trustLevel ?? "trusted",
          enabled: spec.enabled ?? true
        })
      );
    }
    return registered;
  }

  listServers() {
    return [...this.servers.values()].map((server) => ({
      name: server.name,
      trustLevel: server.trustLevel,
      enabled: server.enabled,
      transport: server.transport,
      command: server.command,
      args: server.args,
      tools: this.clients.get(server.name)?.tools?.map((tool) => tool.name) ?? server.tools.map((tool) => tool.name ?? tool),
      connected: this.clients.get(server.name)?.connected ?? false,
      lastError: this.clients.get(server.name)?.lastError ?? null
    }));
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

  async connect(name) {
    const server = this.servers.get(name);
    if (!server) throw new Error(`Unknown MCP server: ${name}`);
    if (!server.enabled) throw new Error(`MCP server ${name} is disabled.`);
    if (server.transport !== "stdio") throw new Error(`MCP transport ${server.transport} is not supported yet.`);

    let client = this.clients.get(name);
    if (!client) {
      client = new McpStdioClient({
        name: server.name,
        command: server.command,
        args: server.args,
        env: server.env,
        cwd: server.cwd,
        trustLevel: server.trustLevel,
        logDir: this.logDir
      });
      this.clients.set(name, client);
    }
    await client.connect();
    this.exposeAsTools(server.name);
    return client.status();
  }

  async connectAll() {
    const results = [];
    for (const [name, server] of this.servers) {
      if (!server.enabled || server.transport !== "stdio" || !server.command) continue;
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
