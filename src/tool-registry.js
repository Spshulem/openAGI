import { createId, nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

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
      // When true, invoke() queues a pending-action and returns
      // {status:"awaiting_confirmation"} instead of running. The action is
      // surfaced in the dashboard for the user to approve/deny.
      needsConfirmation: Boolean(tool.needsConfirmation),
      // Short human-readable summary used in the approval UI when the args
      // alone don't describe the action well. Optional fn(args) -> string.
      summarize: typeof tool.summarize === "function" ? tool.summarize : null,
      // Whether invoking this tool changes state anywhere (memory, tasks,
      // cron, outbound messages, external services). Defaults to TRUE — a
      // tool must explicitly declare sideEffects: false to count as
      // read-only. Scrutiny verdicts gate on this: 'watch' turns allow only
      // read-only tools; 'ask' turns divert side-effecting calls to the
      // approval queue.
      sideEffects: tool.sideEffects !== false,
      metadata: tool.metadata ?? {}
    };
    this.tools.set(normalized.name, normalized);
    return normalized;
  }

  bindPendingActions(pendingActions) {
    this.pendingActions = pendingActions;
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

  list({ readOnly = false } = {}) {
    const all = [...this.tools.values()].map(({ handler, ...rest }) => rest);
    return readOnly ? all.filter((tool) => !tool.sideEffects) : all;
  }

  toOpenAITools(options = {}) {
    return this.list(options).map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }));
  }

  toAnthropicTools(options = {}) {
    return this.list(options).map((tool) => ({
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
    // Scrutiny 'watch' policy: read-only turns hard-block side-effecting
    // tools (defense in depth — the filtered tool list is advisory to the
    // model, this gate is not).
    if (context?.__scrutinyPolicy === "read-only" && tool.sideEffects) {
      return {
        ok: false,
        error: `Tool ${name} is blocked this turn: scrutiny verdict 'watch' permits read-only tools only.`
      };
    }
    // Confirmation gate. When set, divert the call into the pending-action
    // queue UNLESS context.__confirmed is true (which the approve endpoint
    // sets after a human OKs the action). Scrutiny 'ask' turns extend this
    // to EVERY side-effecting tool, not just the always-gated ones.
    const scrutinyConfirm = context?.__scrutinyPolicy === "confirm" && tool.sideEffects;
    if ((tool.needsConfirmation || scrutinyConfirm) && !context?.__confirmed && this.pendingActions) {
      const summary = tool.summarize ? safeSummarize(tool.summarize, args) : `Run ${name}`;
      const action = this.pendingActions.enqueue({
        toolName: name,
        args,
        context,
        summary,
        reason: context.__reason ?? null
      });
      return {
        ok: true,
        result: {
          status: "awaiting_confirmation",
          actionId: action.id,
          summary: action.summary,
          message: `Queued for human approval. Visit the dashboard's Approvals tab (or run /pending-actions) to approve or deny.`
        }
      };
    }
    try {
      const result = await tool.handler(args ?? {}, context);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: error.message ?? String(error) };
    }
  }
}

function safeSummarize(fn, args) {
  try { return String(fn(args ?? {})).slice(0, 240); } catch { return null; }
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
      const scope = context.agentId && context.agentId !== "main" ? `specialist:${context.agentId}` : "main";
      const item = runtime.memory.remember(
        {
          source: context.channel ?? "tool",
          scope,
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
    sideEffects: false,
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
    handler: async (args, context) => {
      const scope = context?.agentId && context.agentId !== "main" ? `specialist:${context.agentId}` : null;
      const hits = runtime.memory.retrieve(String(args.query ?? ""), { limit: args.limit ?? 5, scope });
      return {
        count: hits.length,
        items: hits.map(({ item, score }) => ({
          id: item.id,
          tier: item.tier,
          score: Number(score.toFixed(3)),
          tags: item.tags,
          content: item.content,
          kind: item.kind ?? "raw",
          // Confidence signals: fidelity ("specific" = precise, trust details),
          // strength (decays unless reinforced), locked (a user correction).
          fidelity: item.fidelity ?? "normal",
          strength: Number((item.strength ?? 0).toFixed(2)),
          locked: Boolean(item.locked)
        }))
      };
    }
  });

  registry.register({
    name: "correct_memory",
    description: "Replace a stored memory that turned out to be WRONG. Hides the stale version from all future recall and locks in the corrected fact so the mistake never repeats. Use when the user corrects something previously stored or stated (a time, name, decision, preference) — do NOT just call remember with a second conflicting fact.",
    parameters: {
      type: "object",
      properties: {
        correction: { type: "string", description: "The corrected fact, stated fully and standalone (e.g. 'The Acme review meeting is at 4pm, not 3pm')." },
        query: { type: "string", description: "What the stale memory was about — used to find it (e.g. 'Acme review meeting time')." },
        id: { type: "string", description: "Exact memory id to supersede, when known (from a recall result). Takes precedence over query." },
        tags: { type: "array", items: { type: "string" }, description: "Optional extra tags for the correction." }
      },
      required: ["correction"],
      additionalProperties: false
    },
    handler: async (args, context) => {
      if (!runtime.memory?.correct) return { error: "memory system does not support corrections" };
      const scope = context?.agentId && context.agentId !== "main" ? `specialist:${context.agentId}` : "main";
      const result = runtime.memory.correct({
        id: args.id ?? null,
        query: args.query ?? null,
        content: String(args.correction ?? "").trim(),
        tags: args.tags ?? [],
        scope,
        source: "correct-memory-tool",
        metadata: { agentId: context.agentId, sessionId: context.sessionId }
      });
      return {
        id: result.item.id,
        tier: result.item.tier,
        content: result.item.content,
        supersededCount: result.superseded.length,
        superseded: result.superseded.map((item) => ({ id: item.id, content: item.content.slice(0, 120) }))
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
    name: "recall_activity",
    sideEffects: false,
    description: "Search the user's ambient capture log (window titles + app focus events + OCR text from screen frames). Use this when the user asks about what they were doing at a specific time, or to ground 'where did I leave off' questions. Returns rows with timestamp, app, window, and matching snippet.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search across OCR text and window titles. Empty returns recent activity." },
        since: { type: "string", description: "ISO 8601 lower bound (inclusive)." },
        until: { type: "string", description: "ISO 8601 upper bound (inclusive)." },
        app: { type: "string", description: "Filter to a specific app (e.g. 'com.apple.Safari' or 'Linear')." },
        limit: { type: "integer", minimum: 1, maximum: 200 }
      },
      additionalProperties: false
    },
    handler: async (args) => {
      if (!runtime.observations) return { error: "no observation store" };
      const results = await runtime.observations.search({
        query: args.query ?? null,
        since: args.since ?? null,
        until: args.until ?? null,
        app: args.app ?? null,
        limit: args.limit ?? 25
      });
      return { count: results.length, results };
    }
  });

  registry.register({
    name: "recall_spend",
    sideEffects: false,
    description: "Summarize LLM credit (USD) usage: how much has been spent, on what activity/model, and the costliest recent calls. Use to answer questions about cost/credits/budget — e.g. 'why did I spend $4 today?'.",
    parameters: {
      type: "object",
      properties: {
        days: { type: "integer", minimum: 1, maximum: 30, description: "Look-back window in days (default 1 = today; the local ledger retains 30 days)." }
      },
      additionalProperties: false
    },
    handler: async (args) => {
      const ledger = runtime.budget?.ledger;
      if (!ledger) return { error: "no credit ledger available" };
      // Clamp to the retained window so the reported `days` matches the data.
      const days = Math.min(args.days ?? 1, ledger.retentionDays ?? 30);
      const analytics = ledger.analytics({ days });
      const top = ledger.query({ days })
        .slice()
        .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
        .slice(0, 10)
        .map((r) => ({ at: r.at, model: r.model, activity: r.channel, agentId: r.agentId, usd: Number((r.usd ?? 0).toFixed(4)), tools: r.tools ?? [] }));
      return { days, totalUsd: analytics.totalUsd, calls: analytics.totalCalls, byActivity: analytics.byActivity, byModel: analytics.byModel, top };
    }
  });

  registry.register({
    name: "list_sessions",
    sideEffects: false,
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
    sideEffects: false,
    description: "List the skills (named prompts) available to this agent.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const skills = runtime.skills?.list?.() ?? [];
      return { count: skills.length, items: skills.map((s) => ({ name: s.name, description: s.description })) };
    }
  });

  registry.register({
    name: "replay_skill",
    description: "Trigger a skill's structured replay steps (open_app, keyboard_shortcut, type, applescript, etc.) on the user's Mac. Use only for skills with a `replay:` block in their SKILL.md. Set dryRun:true to log actions without executing — recommended for first-time use.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name." },
        dryRun: { type: "boolean", description: "Log what would happen without doing it." }
      },
      required: ["name"],
      additionalProperties: false
    },
    handler: async (args) => {
      if (!runtime.skillReplay) throw new Error("Skill replay not available.");
      return runtime.skillReplay.run({ skill: args.name, dryRun: args.dryRun ?? false });
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
    sideEffects: false,
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

  // ─── Admin tools — let the agent manage its own setup ───────────────────

  registry.register({
    name: "register_mcp_server",
    description: "Add a new MCP server to the registry. Three transport+auth shapes: stdio (spawn a local process), http+bearer (URL with static API key), http+oauth (URL with browser-based OAuth). After registering, the user typically needs to call connect_mcp_server. THIS REQUIRES USER APPROVAL — registering an MCP can mean spawning an arbitrary process or contacting an arbitrary host. Prefer connect_catalog_mcp when the server is already in the curated catalog.",
    needsConfirmation: true,
    // Summary is what shows in the menu-bar notification and dashboard
    // approval card header. Critically include the fields that determine
    // whether the action is dangerous: the stdio command + first few args,
    // or the http URL. Hiding these in the args details would let a prompt-
    // injected agent slip a malicious `docker run -v $HOME:/host …` past a
    // user who only glances at the notification.
    summarize: (args) => summarizeRegisterMcpServer(args),
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Unique server name." },
        transport: { type: "string", enum: ["stdio", "http"], description: "stdio or http." },
        // stdio
        command: { type: "string", description: "stdio: command to spawn (e.g. 'npx')." },
        args: { type: "array", items: { type: "string" }, description: "stdio: command arguments." },
        // http
        url: { type: "string", description: "http: MCP endpoint URL." },
        auth: { type: "string", enum: ["none", "bearer", "oauth"], description: "http: auth mode." },
        apiKey: { type: "string", description: "http+bearer: API key. Use ${ENV_VAR} for env var expansion." },
        clientId: { type: "string", description: "http+oauth: pre-registered client ID for servers without dynamic registration." },
        scope: { type: "string", description: "http+oauth: requested scopes." },
        trustLevel: { type: "string", enum: ["trusted", "untrusted"], description: "Default trusted." }
      },
      required: ["name"],
      additionalProperties: false
    },
    handler: async (args) => {
      if (!runtime.mcp?.registerServer) throw new Error("MCP registry not available.");
      const server = runtime.mcp.registerServer({
        name: args.name,
        transport: args.transport,
        command: args.command,
        args: args.args ?? [],
        url: args.url,
        auth: args.auth,
        apiKey: args.apiKey,
        clientId: args.clientId,
        scope: args.scope,
        trustLevel: args.trustLevel ?? "trusted"
      });
      return { name: server.name, transport: server.transport, auth: server.auth };
    }
  });

  registry.register({
    name: "connect_mcp_server",
    description: "Spawn / connect to a registered MCP server and discover its tools. For OAuth servers, this triggers the browser-based auth flow; the user will need to complete it in their browser. Returns immediately; check list_mcp_tools afterward to see what's available.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Registered server name." } },
      required: ["name"],
      additionalProperties: false
    },
    handler: async (args) => {
      if (!runtime.mcp?.connect) throw new Error("MCP registry not available.");
      // Fire and forget — OAuth can take minutes.
      runtime.mcp.connect(args.name).catch(() => { /* surfaced via SSE */ });
      return { name: args.name, status: "connecting", note: "If this server uses OAuth, an auth URL will appear in the dashboard's MCP tab." };
    }
  });

  registry.register({
    name: "disconnect_mcp_server",
    description: "Close the connection to an MCP server (kills the stdio child or drops the HTTP session).",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false
    },
    handler: async (args) => {
      if (!runtime.mcp?.disconnect) throw new Error("MCP registry not available.");
      const ok = await runtime.mcp.disconnect(args.name);
      return { name: args.name, disconnected: ok };
    }
  });

  registry.register({
    name: "list_cron_jobs",
    sideEffects: false,
    description: "List all scheduled jobs (prompt schedules, autopilot pulses, system tasks).",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => runtime.cron.listJobs()
  });

  registry.register({
    name: "cancel_cron_job",
    description: "Remove a scheduled cron job by id. Use list_cron_jobs first to find the id.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false
    },
    handler: async (args) => ({ id: args.id, removed: runtime.cron.removeJob(args.id) })
  });

  registry.register({
    name: "get_audit",
    sideEffects: false,
    description: "Get a structural health snapshot of the runtime: specialist counts, memory tier saturation, outcome quality (7d/30d), upcoming cron jobs, MCP servers, and any actionable findings (warn/err severity). Use this when the user asks 'how are you doing' or 'what's wrong'.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => runtime.introspector?.audit() ?? { error: "no introspector" }
  });

  registry.register({
    name: "get_budget",
    sideEffects: false,
    description: "Get today's LLM spend, daily limit, calls, and token counts. Returns 14 days of history.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => runtime.budget?.status?.() ?? { error: "no budget" }
  });

  registry.register({
    name: "set_provider",
    description: "Switch the primary model provider live. 'auto' picks whichever has a key (Anthropic preferred), 'anthropic' forces Claude, 'openai' forces ChatGPT/GPT-5. Use this if the user wants to switch models mid-conversation or you detect repeated failures with the current one.",
    parameters: {
      type: "object",
      properties: {
        preference: { type: "string", enum: ["auto", "anthropic", "openai"] }
      },
      required: ["preference"],
      additionalProperties: false
    },
    handler: async (args) => {
      process.env.OPENAGI_PROVIDER = args.preference;
      const { createModelProvider } = await import("./model-provider.js");
      if (runtime.agentHost) {
        runtime.agentHost.modelProvider = createModelProvider({ budgetGuard: runtime.budget });
      }
      // Persist
      try {
        const { saveEnv } = await import("./setup-wizard.js");
        saveEnv({ values: { OPENAGI_PROVIDER: args.preference } });
      } catch { /* ignore */ }
      return {
        preference: args.preference,
        current: runtime.agentHost?.modelProvider?.constructor?.name,
        model: runtime.agentHost?.modelProvider?.model
      };
    }
  });

  // ─── Tasks (user todo list + agent queue) ──────────────────────────────

  registry.register({
    name: "add_task",
    description: "Add a task to the user's todo list (default) or the agent's own queue. Use queue='agent' when YOU are committing to do this task yourself; use queue='user' when the human should do it. Buckets: today, this_week, this_month, this_quarter, this_year, someday, done — pick the one matching the realistic horizon.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title (max 200 chars)." },
        description: { type: "string", description: "Optional longer description / notes." },
        queue: { type: "string", enum: ["user", "agent"], description: "Default 'user'. Use 'agent' to enqueue work for yourself." },
        bucket: { type: "string", enum: ["today", "this_week", "this_month", "this_quarter", "this_year", "someday", "done"], description: "Default 'today'." },
        priority: { type: "integer", minimum: 0, maximum: 100, description: "0-100, higher is more urgent. Default 50." },
        category: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        dueDate: { type: "string", description: "ISO 8601 due date (optional)." },
        sourceMeta: { type: "object", description: "Where this task came from — e.g. {sessionId, snippet}." },
        parentGoalId: { type: "string", description: "Optional — link the task to a parent goal. Use list_goals first to find the right id." },
        dependsOn: { type: "array", items: { type: "string" }, description: "Optional — task ids that must complete before this one is actionable. Task starts in 'blocked' status until all deps complete, then auto-flips to 'pending' and the daily recap surfaces it as 'Unblocked'." }
      },
      required: ["title"],
      additionalProperties: false
    },
    handler: async (args, context) => {
      if (!runtime.tasks?.add) throw new Error("task store not available");
      const queue = args.queue === "agent" ? "agent" : "user";
      const sourceMeta = args.sourceMeta ?? (context.sessionId ? { sessionId: context.sessionId } : null);
      const task = runtime.tasks.add({ ...args, sourceMeta }, { source: "agent", queue });
      return { id: task.id, queue: task.queue, bucket: task.bucket, title: task.title };
    }
  });

  registry.register({
    name: "list_tasks",
    sideEffects: false,
    description: "List tasks. Filter by queue (user/agent), bucket (today / this_week / this_month / this_quarter / this_year / someday / done), or status (pending/in_progress/blocked/completed/cancelled).",
    parameters: {
      type: "object",
      properties: {
        queue: { type: "string", enum: ["user", "agent"] },
        bucket: { type: "string", enum: ["today", "this_week", "this_month", "this_quarter", "this_year", "someday", "done"] },
        status: { type: "string", enum: ["pending", "in_progress", "blocked", "completed", "cancelled"] },
        limit: { type: "integer", minimum: 1, maximum: 200 }
      },
      additionalProperties: false
    },
    handler: async (args) => {
      if (!runtime.tasks?.list) return { error: "task store not available" };
      const tasks = runtime.tasks.list(args);
      return { count: tasks.length, tasks };
    }
  });

  registry.register({
    name: "complete_task",
    description: "Mark a task as completed. Moves it to the 'done' bucket.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        completedVia: { type: "string", description: "Why/how it was completed (e.g. 'manual', 'observed-rize-activity', 'linear-webhook')." }
      },
      required: ["id"],
      additionalProperties: false
    },
    handler: async (args) => {
      const task = runtime.tasks.complete(args.id, args.completedVia ?? "agent");
      return task ? { id: task.id, status: task.status } : { error: "unknown task" };
    }
  });

  registry.register({
    name: "move_task",
    description: "Update a task — change bucket, priority, status, due date, etc. without completing it.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        bucket: { type: "string", enum: ["today", "this_week", "this_month", "this_quarter", "this_year", "someday", "done"] },
        priority: { type: "integer", minimum: 0, maximum: 100 },
        status: { type: "string", enum: ["pending", "in_progress", "blocked", "completed", "cancelled"] },
        dueDate: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        tags: { type: "array", items: { type: "string" } }
      },
      required: ["id"],
      additionalProperties: false
    },
    handler: async (args) => {
      const { id, ...patch } = args;
      const task = runtime.tasks.update(id, patch);
      return task ? task : { error: "unknown task" };
    }
  });

  registry.register({
    name: "add_goal",
    description: "Create a Goal that tasks can be grouped under for rollup tracking. Goals have a title, optional description, optional dueDate, and optional parentGoalId (goals can nest, e.g. a quarter goal contains monthly goals).",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        dueDate: { type: "string", description: "ISO 8601 date." },
        parentGoalId: { type: "string", description: "Optional — links this goal under a parent goal for nested rollups." }
      },
      required: ["title"],
      additionalProperties: false
    },
    handler: async (args) => runtime.tasks.addGoal(args)
  });

  registry.register({
    name: "list_goals",
    sideEffects: false,
    description: "List goals with optional status filter. Use to see what longer-term threads exist before adding more tasks — a task linked to an existing goal is more useful than a free-floating one.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "completed", "cancelled", "deferred"] },
        includeProgress: { type: "boolean", description: "If true, include rollup {done, total, percent} per goal. Default false for cheaper calls." }
      },
      additionalProperties: false
    },
    handler: async (args) => {
      const goals = runtime.tasks.listGoals({ status: args.status });
      if (args.includeProgress) {
        return goals.map((g) => ({ ...g, progress: runtime.tasks.goalProgress(g.id) }));
      }
      return goals;
    }
  });

  registry.register({
    name: "link_task_to_goal",
    description: "Link an existing task to a goal so it counts toward that goal's rollup progress. Pass goalId=null to unlink. Use after creating a related task without specifying parentGoalId at creation time.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        goalId: { type: "string", description: "Goal id to link to. null to unlink." }
      },
      required: ["taskId"],
      additionalProperties: false
    },
    handler: async (args) => runtime.tasks.linkTaskToGoal(args.taskId, args.goalId)
  });

  registry.register({
    name: "agent_pick_next",
    description: "Pop the next task from the agent's own queue. Returns the highest-priority pending task in the agent queue, or null if the queue is empty.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const task = runtime.tasks.agentPickNext?.() ?? null;
      return task ? { task } : { task: null, reason: "agent queue empty" };
    }
  });

  registry.register({
    name: "daily_recap",
    sideEffects: false,
    description: "Answer 'what did I get done today?' Returns a structured summary of completed tasks, skills run, agent actions approved, time tracked, and themes. Pass a date (YYYY-MM-DD) to recap a specific day; defaults to today in the user's local timezone. format='markdown' returns a human-readable chat reply; format='json' returns the raw structure for further processing.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD. Defaults to today (user's local timezone)." },
        format: { type: "string", enum: ["markdown", "json"], description: "Output format. Default 'markdown'." }
      },
      additionalProperties: false
    },
    handler: async (args) => {
      const { computeDailyRecap, renderDailyRecapMarkdown } = await import("./daily-recap.js");
      const date = args.date ? new Date(args.date + "T12:00:00") : new Date();
      const recap = computeDailyRecap(runtime, { date });
      if (args.format === "json") return recap;
      return { markdown: renderDailyRecapMarkdown(recap), counts: recap.counts };
    }
  });

  registry.register({
    name: "daily_plan",
    sideEffects: false,
    description: "Answer 'what should I do today?' Returns a forward-looking plan synthesized from the user's calendar, pending + carried-over tasks, recent call commitments, and active goals: a focus list, what the agent can take off their plate, and time-sensitive items. Pass a date (YYYY-MM-DD) to plan a specific day; defaults to today. format='markdown' for a chat reply, 'json' for the raw structure.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD. Defaults to today (user's local timezone)." },
        format: { type: "string", enum: ["markdown", "json"], description: "Output format. Default 'markdown'." }
      },
      additionalProperties: false
    },
    handler: async (args) => {
      const { computeDailyPlan, renderDailyPlanMarkdown } = await import("./daily-planner.js");
      const date = args.date ? new Date(args.date + "T12:00:00") : new Date();
      const plan = await computeDailyPlan(runtime, { date });
      if (args.format === "json") return plan;
      return { markdown: renderDailyPlanMarkdown(plan), counts: plan.counts };
    }
  });

  registry.register({
    name: "save_draft",
    description: "Save a draft artifact (email, message, doc, outline, reply) for the user to review — instead of sending or publishing it. THIS IS HOW YOU COMPLETE DRAFT-ONLY WORK: produce the content, save it here, and the user reviews/approves/edits it later. Never send, publish, or schedule the content yourself; saving a draft does NOT send it. Link it to the originating task via taskId.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short label for the draft, e.g. 'Follow-up to Acme re pricing'." },
        body: { type: "string", description: "The full draft content." },
        kind: { type: "string", enum: ["email", "message", "doc", "outline", "reply", "other"], description: "What kind of artifact this is." },
        recipient: { type: "string", description: "Intended recipient, if applicable (display only — nothing is sent)." },
        taskId: { type: "string", description: "The task this draft fulfills, if any." }
      },
      required: ["title", "body"],
      additionalProperties: false
    },
    handler: async (args) => {
      if (!runtime.drafts?.add) throw new Error("no draft store available");
      const draft = runtime.drafts.add(args);
      return { draftId: draft.id, status: draft.status, note: "Draft saved for review. It has NOT been sent — the user will review and approve it." };
    }
  });

  // ─── Catalog-aware integration tools (require user approval) ───────────

  registry.register({
    name: "list_mcp_catalog",
    sideEffects: false,
    description: "List the MCP servers in OpenAGI's curated catalog — names, descriptions, auth mode (api-key vs oauth), availability (available vs coming-soon), and required env-var name for bearer-auth entries. Use BEFORE connect_catalog_mcp to confirm an entry exists and learn what credentials it needs.",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", description: "Optional filter: project-management, analytics, developer-tools, crm, design-docs, communication, calls-meetings, filesystem." },
        availableOnly: { type: "boolean", description: "If true, only return entries with status='available' (skip OAuth-pending ones)." }
      },
      additionalProperties: false
    },
    handler: async (args) => {
      const { MCP_CATALOG } = await import("./mcp-catalog.js");
      let entries = MCP_CATALOG;
      if (args.category) entries = entries.filter((e) => e.category === args.category);
      if (args.availableOnly) entries = entries.filter((e) => e.status === "available" && Boolean(e.register));
      const registered = new Set((runtime.mcp?.listServers?.() ?? []).map((s) => s.name?.toLowerCase()));
      return {
        count: entries.length,
        entries: entries.map((e) => ({
          id: e.id,
          name: e.name,
          description: e.description,
          category: e.category,
          authType: e.authType,
          status: e.status,
          apiKeyEnvVar: e.apiKeyEnvVar ?? null,
          apiKeyHelp: e.apiKeyHelp ?? null,
          alreadyRegistered: registered.has(e.id),
          connectable: e.status === "available" && Boolean(e.register)
        }))
      };
    }
  });

  registry.register({
    name: "connect_catalog_mcp",
    description: "One-click register an MCP server from the curated catalog by id. For bearer-auth entries (Stripe, PostHog, etc.), pass the user's API key via apiKey — it'll be persisted to .env under the entry's declared env var, then the MCP is registered with `${VAR}` indirection. For OAuth entries (Linear, Notion, GitHub), no key is needed; the OAuth handshake will surface in the dashboard's MCP tab. THIS REQUIRES USER APPROVAL — you'll get back {status:'awaiting_confirmation'} and the user must approve via the dashboard before the registration actually runs.",
    parameters: {
      type: "object",
      properties: {
        catalogId: { type: "string", description: "Catalog entry id (see list_mcp_catalog)." },
        apiKey: { type: "string", description: "Required for bearer-auth entries when their env var isn't already populated. Never invent — only pass a key the user has explicitly given you." }
      },
      required: ["catalogId"],
      additionalProperties: false
    },
    needsConfirmation: true,
    // When apiKey is supplied, include a short prefix in the summary so
    // the user can sanity-check that the agent is forwarding *their* key
    // and not a substituted attacker key from prompt injection. Full key
    // still appears in the args details for users who want to verify.
    summarize: (args) => {
      let label = `Connect MCP: ${args.catalogId}`;
      if (args.apiKey) {
        const prefix = String(args.apiKey).slice(0, 8);
        label += ` (with key starting "${prefix}…")`;
      }
      return label;
    },
    handler: async (args) => {
      const { MCP_CATALOG } = await import("./mcp-catalog.js");
      const entry = MCP_CATALOG.find((e) => e.id === args.catalogId);
      if (!entry) throw new Error(`Catalog entry '${args.catalogId}' not found. Use list_mcp_catalog to see what's available.`);
      if (!entry.register) throw new Error(`Catalog entry '${entry.id}' has no register info (likely status=coming-soon).`);
      if (entry.register.auth === "bearer" && entry.apiKeyEnvVar) {
        const incoming = typeof args.apiKey === "string" ? args.apiKey.trim() : "";
        const existing = process.env[entry.apiKeyEnvVar] ?? "";
        if (incoming) {
          const { saveEnv } = await import("./setup-wizard.js");
          const dataDir = resolveDataDir();
          saveEnv({ dataDir, values: { [entry.apiKeyEnvVar]: incoming } });
        } else if (!existing) {
          throw new Error(`Catalog entry '${entry.id}' uses ${entry.apiKeyEnvVar} which isn't set. Ask the user for their key, then call this tool again with apiKey set.`);
        }
        runtime.mcp.allowEnvKey?.(entry.apiKeyEnvVar);
      }
      const spec = { name: entry.id, ...entry.register };
      if (entry.register.auth === "bearer" && entry.apiKeyEnvVar) {
        spec.apiKey = `\${${entry.apiKeyEnvVar}}`;
      }
      const server = runtime.mcp.registerServer(spec);
      if (runtime.mcp?.connect) runtime.mcp.connect(server.name).catch(() => { /* OAuth surfaces via SSE */ });
      return {
        name: server.name,
        transport: server.transport,
        note: entry.register.auth === "oauth"
          ? "OAuth handshake initiated — user should complete it in the dashboard's MCP tab."
          : "Registered. Use list_mcp_tools to see what's available."
      };
    }
  });

  registry.register({
    name: "restart_daemon",
    description: "Bounce the OpenAGI process so .env changes (new credentials, providers, etc) take effect. Existing integration constructors only re-read env at boot, so this is required after save_integration_credentials or a credentials change. THIS REQUIRES USER APPROVAL — restart drops in-flight chat connections briefly. Use sparingly; only when an integration won't work otherwise.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why a restart is needed — surfaced in the approval UI so the user understands the trigger." }
      },
      additionalProperties: false
    },
    needsConfirmation: true,
    summarize: (args) => args.reason ? `Restart daemon (reason: ${args.reason})` : "Restart daemon",
    handler: async () => {
      // Same pattern as /control/restart — schedule exit so the response can flush.
      setTimeout(() => process.exit(0), 200);
      return { restarting: true };
    }
  });

  registry.register({
    name: "retire_specialist",
    description: "Retire a propagated specialist by id. Use this when the user explicitly says a specialist isn't useful, or when get_audit shows a low-quality specialist.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        reason: { type: "string", description: "Short reason logged with the retirement." }
      },
      required: ["id"],
      additionalProperties: false
    },
    handler: async (args) => {
      const sp = runtime.propagation?.retire?.(args.id, args.reason ?? "agent-initiated");
      if (!sp) return { error: "unknown specialist" };
      return { id: sp.id, status: sp.status, reason: sp.retirementReason };
    }
  });

  return registry;
}

// Builds the human-readable summary shown on register_mcp_server approval
// cards. Always includes the fields that determine whether the call is
// dangerous (stdio command + first 3 args, or http URL + auth mode) so the
// user can't approve a hidden `docker run -v /:/host` based on the name
// alone. Exported for testing.
export function summarizeRegisterMcpServer(args = {}) {
  const transport = args.transport ?? (args.url ? "http" : args.command ? "stdio" : "config");
  const name = args.name ?? "(unnamed)";
  if (transport === "stdio") {
    const cmd = args.command ?? "?";
    const firstArgs = (args.args ?? []).slice(0, 3).join(" ");
    const more = (args.args?.length ?? 0) > 3 ? " …" : "";
    return `Register stdio MCP '${name}' → ${cmd} ${firstArgs}${more}`.trim();
  }
  if (transport === "http") {
    const auth = args.auth ?? (args.apiKey ? "bearer" : "oauth");
    return `Register http MCP '${name}' → ${args.url ?? "(no url)"} (auth=${auth})`;
  }
  return `Register MCP '${name}' (${transport})`;
}
