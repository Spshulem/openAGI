import { createId, nowIso } from "./utils.js";

export class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(tool) {
    if (!tool?.name) throw new Error("Tool requires a name.");
    if (typeof tool.handler !== "function") throw new Error(`Tool ${tool.name} requires a handler.`);
    const normalized = {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.parameters ?? { type: "object", properties: {}, additionalProperties: false },
      source: tool.source ?? "internal",
      handler: tool.handler,
      metadata: tool.metadata ?? {}
    };
    this.tools.set(normalized.name, normalized);
    return normalized;
  }

  unregister(name) {
    return this.tools.delete(name);
  }

  has(name) {
    return this.tools.has(name);
  }

  get(name) {
    return this.tools.get(name);
  }

  list() {
    return [...this.tools.values()].map(({ handler, ...rest }) => rest);
  }

  toOpenAITools() {
    return this.list().map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }));
  }

  toAnthropicTools() {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters
    }));
  }

  async invoke(name, args, context = {}) {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, error: `Unknown tool: ${name}` };
    }
    try {
      const result = await tool.handler(args ?? {}, context);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: error.message ?? String(error) };
    }
  }
}

export function registerCoreTools(registry, runtime) {
  registry.register({
    name: "remember",
    description: "Save a piece of information to long-lived memory so it can be recalled in future turns. Use when the user says 'remember', 'save', or shares a durable fact.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "The information to remember, in plain prose." },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for retrieval."
        },
        importance: {
          type: "string",
          enum: ["low", "normal", "high"],
          description: "Higher importance items resist decay and may promote to long-term memory."
        }
      },
      required: ["content"],
      additionalProperties: false
    },
    handler: async (args, context) => {
      const importance = args.importance ?? "normal";
      const risk = importance === "high" ? 0.8 : importance === "low" ? 0.2 : 0.45;
      const item = runtime.memory.remember(
        {
          source: context.channel ?? "tool",
          content: String(args.content ?? "").trim(),
          tags: ["tool:remember", ...(args.tags ?? [])],
          risk,
          repetition: 0.4,
          novelty: 0.55,
          metadata: { agentId: context.agentId, sessionId: context.sessionId }
        },
        { source: "remember-tool", strength: importance === "high" ? 0.85 : 0.6 }
      );
      return { id: item.id, tier: item.tier, content: item.content };
    }
  });

  registry.register({
    name: "recall",
    description: "Search memory for items related to a query. Returns the most relevant items across short, medium, and long-term memory.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query." },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Maximum results to return." }
      },
      required: ["query"],
      additionalProperties: false
    },
    handler: async (args) => {
      const hits = runtime.memory.retrieve(String(args.query ?? ""), { limit: args.limit ?? 5 });
      return {
        count: hits.length,
        items: hits.map(({ item, score }) => ({
          id: item.id,
          tier: item.tier,
          score: Number(score.toFixed(3)),
          tags: item.tags,
          content: item.content
        }))
      };
    }
  });

  registry.register({
    name: "schedule_message",
    description: "Schedule a future prompt that will be run through this agent. When fired, the result is delivered back to the originating channel (or a target you specify). Use for reminders, recurring check-ins, or scheduled work.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The prompt the agent should run when this fires." },
        delaySeconds: { type: "integer", minimum: 30, description: "One-shot: fire this many seconds from now." },
        intervalSeconds: { type: "integer", minimum: 30, description: "Recurring: fire every N seconds." },
        dailyAt: { type: "string", description: "Recurring HH:MM (24h) daily fire time, e.g. '09:00'." },
        channel: { type: "string", description: "Channel to deliver to: local, sms, telegram. Defaults to the originating channel." },
        target: { type: "string", description: "Channel target (phone number, chat id, etc). Defaults to the originating sender." },
        name: { type: "string", description: "Optional human-readable name." }
      },
      required: ["prompt"],
      additionalProperties: false
    },
    handler: async (args, context) => {
      if (!runtime.cron) throw new Error("Cron scheduler is not available.");
      const job = {
        id: args.id ?? createId("job"),
        name: args.name ?? `prompt-${nowIso()}`,
        enabled: true,
        task: "prompt",
        replace: true,
        input: {
          prompt: String(args.prompt ?? "").trim(),
          channel: args.channel ?? context.channel ?? "local",
          target: args.target ?? context.from ?? context.target ?? null,
          agentId: context.agentId ?? "main",
          sessionId: context.sessionId,
          oneShot: Boolean(args.delaySeconds && !args.intervalSeconds && !args.dailyAt)
        }
      };
      if (args.delaySeconds) {
        job.intervalMs = args.delaySeconds * 1000;
        job.nextRunAt = new Date(Date.now() + args.delaySeconds * 1000).toISOString();
      } else if (args.intervalSeconds) {
        job.intervalMs = args.intervalSeconds * 1000;
      } else if (args.dailyAt) {
        job.dailyAt = args.dailyAt;
      } else {
        throw new Error("Provide one of delaySeconds, intervalSeconds, or dailyAt.");
      }
      const created = runtime.cron.addJob(job);
      return { id: created.id, name: created.name, nextRunAt: created.nextRunAt, task: created.task };
    }
  });

  registry.register({
    name: "send_message",
    description: "Proactively send a message to a user via a channel (sms, telegram, or local). Use during autopilot pulses or when you decide to reach out unprompted. Returns delivery status.",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string", enum: ["sms", "telegram", "local"], description: "Channel to deliver via." },
        target: { type: "string", description: "Channel target — phone number for SMS, chat id for Telegram." },
        text: { type: "string", description: "Message body. Keep it short and useful." }
      },
      required: ["channel", "target", "text"],
      additionalProperties: false
    },
    handler: async (args) => {
      if (!runtime.channels?.deliver) throw new Error("Channels are not bound to runtime.");
      return runtime.channels.deliver({ channel: args.channel, target: args.target, text: args.text });
    }
  });

  registry.register({
    name: "list_sessions",
    description: "List recent conversations across channels.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50 }
      },
      additionalProperties: false
    },
    handler: async (args) => {
      const sessions = runtime.agentHost?.store.listSessions() ?? [];
      return sessions.slice(0, args.limit ?? 10);
    }
  });

  registry.register({
    name: "list_skills",
    description: "List the skills (named prompts) available to this agent.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const skills = runtime.skills?.list?.() ?? [];
      return { count: skills.length, items: skills.map((s) => ({ name: s.name, description: s.description })) };
    }
  });

  registry.register({
    name: "run_skill",
    description: "Run a named skill with the given input. Returns the skill's output.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name (see list_skills)." },
        input: { type: "string", description: "Free-text input the skill should operate on." },
        args: { type: "object", description: "Optional structured arguments the skill expects.", additionalProperties: true }
      },
      required: ["name"],
      additionalProperties: false
    },
    handler: async (args, context) => {
      if (!runtime.skills) throw new Error("Skills are not configured.");
      return runtime.skills.run(args.name, { input: args.input, args: args.args ?? {} }, context);
    }
  });

  registry.register({
    name: "list_mcp_tools",
    description: "List tools exposed by connected MCP servers.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const tools = runtime.mcp?.listTools?.() ?? [];
      return { count: tools.length, items: tools };
    }
  });

  registry.register({
    name: "run_mcp_tool",
    description: "Invoke a tool on a connected MCP server.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "MCP server name." },
        tool: { type: "string", description: "Tool name (must exist on that server)." },
        args: { type: "object", description: "Arguments to pass to the tool.", additionalProperties: true }
      },
      required: ["server", "tool"],
      additionalProperties: false
    },
    handler: async (args) => {
      if (!runtime.mcp?.callTool) throw new Error("MCP execution is not available.");
      return runtime.mcp.callTool(args.server, args.tool, args.args ?? {});
    }
  });

  return registry;
}
