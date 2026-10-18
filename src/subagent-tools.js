import { randomUUID } from "node:crypto";

const active = new WeakMap();
export function registerSubagentTools(registry, runtime) {
  registry.register({ name: "run_subagent", sideEffects: true,
    description: "Delegate one bounded research/analysis task and wait for its result. The child can use only selected read-only tools, cannot send messages or create more agents, and shares the daily model budget. Use schedule_message to repeat a routine that calls this tool.",
    parameters: { type: "object", properties: {
      task: { type: "string", description: "The complete bounded task, including relevant context." },
      tools: { type: "array", items: { type: "string" }, description: "Exact read-only tool names; defaults to recall, web_search and fetch_url when available." }
    }, required: ["task"], additionalProperties: false },
    handler: async (args, context) => {
      if (context.__subagentDepth) throw new Error("Subagents cannot create more subagents.");
      if (typeof args.task !== "string" || !args.task.trim() || args.task.length > 4000) throw new Error("Task must be 1–4000 characters.");
      if (!runtime.agentHost) throw new Error("Agent host is not available.");
      const running = active.get(runtime) ?? new Set();
      if (running.size >= 3) throw new Error("Three subagents are already running. Wait for one to finish.");
      const requested = args.tools ?? ["recall", "web_search", "fetch_url"].filter(name => registry.has(name));
      if (!Array.isArray(requested) || requested.length > 20 || requested.some(name => typeof name !== "string" || !registry.has(name) || registry.get(name).sideEffects)) throw new Error("Select up to 20 existing read-only tools.");
      if (Array.isArray(context.__allowedTools) && requested.some(name => !context.__allowedTools.includes(name))) throw new Error("A subagent cannot exceed its parent's tool scope.");
      const id = `delegate-${randomUUID()}`;
      active.set(runtime, running);
      running.add(id);
      try {
        runtime.agentHost.store.createAgent({ id, name: "Research subagent", role: "specialist",
          systemPrompt: "Complete only the supplied task. Use the allowed read-only tools. Return findings with evidence and uncertainties; never claim to have changed external state.",
          metadata: { specialist: { allowedTools: requested } } });
        const result = await runtime.agentHost.handleMessage({ text: args.task, agentId: id, sessionId: id, channel: "subagent", from: "main", routeTo: false }, {
          signal: context.signal, toolAllowlist: requested, subagentDepth: 1
        });
        return { agentId: id, sessionId: result.session?.id ?? id, reply: result.reply };
      } finally { running.delete(id); }
    }
  });
}
