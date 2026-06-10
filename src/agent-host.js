import { InMemoryAgentStore } from "./agent-store.js";
import { createModelProvider } from "./model-provider.js";
import { createId, nowIso } from "./utils.js";
import { detectTaskInChat } from "./task-store.js";

export class AgentHost {
  constructor(options = {}) {
    this.runtime = options.runtime;
    if (!this.runtime) throw new Error("AgentHost requires a runtime.");
    this.store = options.store ?? new InMemoryAgentStore(options.storeOptions);
    this.modelProvider = options.modelProvider ?? createModelProvider(options.modelProviderOptions);
  }

  async handleMessage(input) {
    const channel = input.channel ?? "local";
    const from = input.from ?? "user";
    let agentId = input.agentId ?? "main";
    const text = String(input.text ?? input.message ?? "").trim();
    if (!text) throw new Error("Message text is required.");

    // Specialist routing: see if any active specialist's bounded scope matches.
    // The caller can opt out by passing input.routeTo === false (used by sub-agents to avoid loops).
    let routing = null;
    if (input.routeTo !== false && this.runtime.specialistRouter && agentId === "main") {
      const tags = ["message", channel];
      const specialists = this.runtime.propagation?.list?.() ?? [];
      const decision = await this.runtime.specialistRouter.decide(text, tags, specialists);
      routing = decision;
      if (decision.route && decision.candidate) {
        agentId = decision.candidate.specialist.id;
      }
    }

    const agent = this.store.getAgent(agentId);
    const sessionId = this.store.sessionKey({ channel, from, agentId, sessionId: input.sessionId });

    // Auto-task detection — if the user said "remind me to X" / "todo: X" /
    // "I need to X", create a task in the user queue without requiring them
    // to invoke add_task. Best-effort; failures don't block the chat reply.
    if (this.runtime?.tasks?.add && agentId === "main" && channel !== "autopilot") {
      const detected = detectTaskInChat(text);
      if (detected) {
        try {
          this.runtime.tasks.add(
            { title: detected.title, sourceMeta: { sessionId, snippet: text.slice(0, 200), trigger: detected.trigger } },
            { source: "chat", queue: "user" }
          );
        } catch { /* swallow */ }
      }
    }

    const sessionBefore = this.store.appendMessage(sessionId, {
      role: "user",
      content: text,
      agentId,
      channel,
      from,
      metadata: input.metadata ?? {}
    });

    const signal = this.messageToSignal({ text, channel, from, agent, sessionId, metadata: input.metadata ?? {} });
    const isSpecialist = agent.role === "specialist";
    const output = this.runtime.processSignal(signal, {
      scope: isSpecialist ? `specialist:${agent.id}` : "main",
      parentSpecialistId: isSpecialist ? agent.id : null
    });

    if (output.propagation?.specialist) {
      this.ensureSpecialistAgent(output.propagation.specialist, agentId);
    }

    // The scrutiny verdict has consequences, not just prompt flavor:
    //   act       → full tool access
    //   ask       → side-effecting tool calls divert to the approval queue
    //               this turn (the agent is told to clarify first)
    //   watch     → read-only tools only (filtered list + invoke-time gate)
    //   ignore    → no tools; the user still gets a (brief) reply — a direct
    //               human message is never silently dropped
    //   propagate → full access (the specialist spawn already happened above)
    const verdict = output.scrutiny.action;
    const toolPolicy = verdict === "watch" ? "read-only" : verdict === "ask" ? "confirm" : verdict === "ignore" ? "none" : "full";
    const toolRegistry = this.runtime.tools;
    const tools = toolPolicy === "none"
      ? []
      : (toolRegistry?.toOpenAITools?.({ readOnly: toolPolicy === "read-only" }) ?? []);

    // Lava intuition (C2): top principles from the vector store inserted into
    // the prompt as soft hints — distinct from explicit memoryHits.
    let intuitions = [];
    if (this.runtime.vectorStore) {
      try {
        intuitions = await this.runtime.vectorStore.search("principle", text, { limit: 3, minScore: 0.1 });
      } catch { /* best effort */ }
    }

    // Ambient on-screen context: top apps + most recent OCR snippets from
    // the last 10 minutes. Lets the agent ground its replies in what the
    // user is actually doing, not just what they typed. Best-effort —
    // failures fall through silently so chat keeps working without capture.
    let ambientContext = null;
    if (channel !== "autopilot" && channel !== "cron" && this.runtime.observations?.getRecentContext) {
      try {
        ambientContext = await this.runtime.observations.getRecentContext({ minutes: 10, maxChars: 1500, maxSnippets: 6 });
      } catch { /* swallow */ }
    }

    const modelResult = await this.modelProvider.generate({
      input: text,
      agent,
      scrutiny: output.scrutiny,
      memoryHits: output.customContext.map((entry) => ({
        score: entry.score,
        item: {
          id: entry.id,
          tier: entry.tier,
          content: entry.content
        }
      })),
      messages: sessionBefore.messages,
      instructions: this.instructionsForAgent(agent, output, intuitions, ambientContext, input.metadata?.screenContext ?? null),
      tools,
      toolRegistry,
      context: {
        channel,
        from,
        target: from,
        agentId,
        sessionId,
        runtime: this.runtime,
        // Enforced in ToolRegistry.invoke — the filtered tool list above is
        // advisory to the model; this gate is not.
        __scrutinyPolicy: toolPolicy === "read-only" ? "read-only" : toolPolicy === "confirm" ? "confirm" : null,
        __reason: toolPolicy === "confirm" ? `scrutiny verdict 'ask' (score ${output.scrutiny.score.toFixed(2)})` : null
      }
    });

    const outcomeRecord = this.runtime.outcomes?.record({
      kind: input.origin === "autopilot" ? "autopilot-fire" : input.origin === "cron" ? "cron-fire" : "agent-reply",
      refId: null, // patched after we know assistant message id
      signalId: signal.id,
      sessionId,
      agentId,
      channel,
      scrutinyAction: output.scrutiny.action,
      scrutinyDimensions: output.scrutiny.dimensions,
      toolCalls: (modelResult.toolCalls ?? []).map((c) => ({ name: c.name, ok: c.result?.ok ?? false })),
      metadata: {
        specialistId: agent.role === "specialist" ? agent.id : null,
        scrutinyScore: output.scrutiny.score,
        routing: routing ? {
          mode: routing.mode,
          routed: routing.route,
          candidateId: routing.candidate?.specialist?.id ?? null,
          score: routing.candidate?.score ?? null,
          threshold: routing.threshold
        } : null
      }
    }) ?? null;

    const sessionAfter = this.store.appendMessage(sessionId, {
      role: "assistant",
      content: modelResult.text,
      agentId,
      channel,
      from: "openagi",
      metadata: {
        provider: modelResult.provider,
        model: modelResult.model,
        responseId: modelResult.id,
        outputId: output.id,
        outcomeId: outcomeRecord?.id ?? null,
        toolCalls: (modelResult.toolCalls ?? []).map((call) => ({
          name: call.name,
          arguments: call.arguments,
          ok: call.result?.ok ?? false
        }))
      }
    });

    if (outcomeRecord) outcomeRecord.refId = sessionAfter.messages.at(-1)?.id ?? null;

    this.runtime.memory.remember(
      {
        source: "agent-host",
        scope: agent.role === "specialist" ? `specialist:${agent.id}` : "main",
        content: `Session ${sessionId} user asked: ${text}\nAgent replied: ${modelResult.text}`,
        tags: ["agent-turn", channel, agentId],
        novelty: output.scrutiny.dimensions.novelty,
        risk: output.scrutiny.dimensions.risk,
        repetition: output.scrutiny.dimensions.repetition,
        specificity: 0.6,
        metadata: {
          sessionId,
          agentId,
          outputId: output.id
        }
      },
      {
        source: "agent-host",
        strength: output.scrutiny.score
      }
    );

    return {
      id: createId("turn"),
      createdAt: nowIso(),
      agent,
      session: {
        id: sessionAfter.id,
        messageCount: sessionAfter.messages.length
      },
      reply: modelResult.text,
      model: {
        provider: modelResult.provider,
        model: modelResult.model,
        configured: this.modelProvider.isConfigured()
      },
      output
    };
  }

  messageToSignal({ text, channel, from, agent, sessionId, metadata }) {
    const lower = text.toLowerCase();
    const asksToRemember = /\bremember\b|\bsave\b|\bdon't forget\b/.test(lower);
    const asksToSchedule = /\bevery\b|\bdaily\b|\bweekly\b|\btomorrow\b|\bremind\b|\bschedule\b/.test(lower);
    const asksToSpecialize = /\bagent\b|\bspecialist\b|\bsub-?agent\b|\bdo this often\b|\bautomate\b/.test(lower);
    const risk = /\bdelete\b|\bdeploy\b|\bpayment\b|\bproduction\b|\blegal\b|\bmedical\b|\bsecurity\b/.test(lower) ? 0.75 : 0.35;
    const repetition = asksToSchedule || asksToSpecialize ? 0.82 : 0.35;
    const novelty = asksToRemember || asksToSpecialize ? 0.65 : 0.4;

    return {
      id: createId("sig"),
      source: channel,
      type: "message",
      domain: "general",
      taskType: asksToSpecialize ? "specialization-candidate" : "adaptation-review",
      summary: text.slice(0, 240),
      content: text,
      citations: [`session:${sessionId}`, `agent:${agent.id}`, `from:${from}`],
      tags: ["message", channel, agent.id],
      urgency: metadata.urgent ? 0.85 : 0.45,
      impact: asksToRemember || asksToSpecialize ? 0.72 : 0.55,
      externalPressure: 0.55,
      internalPressure: asksToSchedule ? 0.7 : 0.5,
      novelty,
      repetition,
      risk,
      ambiguity: 0.35,
      confidence: 0.7,
      specificity: 0.65,
      conflict: 0,
      goalAlignment: 0.75,
      strategicFit: 0.7,
      requiresSpecialist: asksToSpecialize || asksToSchedule,
      receivedAt: nowIso(),
      metadata
    };
  }

  instructionsForAgent(agent, output, intuitions = [], ambientContext = null, screenContext = null) {
    const intuitionBlock = intuitions.length > 0
      ? `\nIntuitions (distilled long-term principles, may apply):\n${intuitions.map((i) => `- (${i.score.toFixed(2)}) ${i.text}`).join("\n")}\n`
      : "";

    let ambientBlock = "";
    if (ambientContext && (ambientContext.apps?.length || ambientContext.snippets?.length)) {
      const lines = ["", "Recent on-screen activity (last ~10 minutes — opt-in screen capture, on-device OCR):"];
      if (ambientContext.apps?.length) {
        lines.push(`Active apps: ${ambientContext.apps.map((a) => `${a.app} (${a.n})`).join(", ")}`);
      }
      if (ambientContext.snippets?.length) {
        lines.push("Recent screen snippets:");
        for (const s of ambientContext.snippets) {
          const stamp = (s.at || "").slice(11, 16); // HH:MM
          const where = s.window ? `${s.app} · ${s.window}` : s.app;
          lines.push(`- [${stamp} ${where}] ${s.text}`);
        }
      }
      lines.push("Use this to ground your reply in what the user is actually doing. Don't quote the snippets back verbatim — refer to them naturally if relevant.");
      ambientBlock = lines.join("\n") + "\n";
    }

    const screenBlock = formatScreenContextBlock(screenContext);

    return `${agent.systemPrompt ? `${agent.systemPrompt}\n\n` : ""}You are ${agent.name}, an always-on OpenAGI agent.

Your job is to help through the ABI loop:
1. Apply directional adaptive scrutiny.
2. Use memory deliberately. When the user CORRECTS something you previously stored or said (a time, a name, a decision, a preference), call correct_memory with the corrected fact — never just remember a second conflicting version.
3. Propagate bounded specialists only when repeated or novel high-risk work justifies it.

Current decision: ${output.scrutiny.action}
${verdictGuidance(output.scrutiny.action)}Reasons:
${output.scrutiny.reasons.map((reason) => `- ${reason}`).join("\n")}
${intuitionBlock}${ambientBlock}${screenBlock}
Answer the user plainly. If a specialist was created, mention its name and scope.`;
  }

  ensureSpecialistAgent(specialist, parentId) {
    const allowedToolList = (specialist.allowedTools ?? []).join(", ") || "all available tools";
    return this.store.ensureAgent({
      id: specialist.id,
      name: specialist.name,
      role: "specialist",
      parentId,
      scope: specialist.boundedScope,
      systemPrompt: `You are ${specialist.name}, a propagated specialist agent.

**Bounded scope:** ${specialist.boundedScope}
**Parent goal:** ${specialist.parentGoal}
**Success metric:** ${specialist.successMetric}
**Tools you can call:** ${allowedToolList}

Stay inside the bounded scope. If the user's request falls outside it, say so and recommend they go back to the main agent. Be concise — your job is to do this one thing well, repeatedly.`,
      metadata: { specialist }
    });
  }

  status() {
    return {
      provider: friendlyProviderLabel(this.modelProvider),
      providerConfigured: this.modelProvider.isConfigured(),
      providerModel: this.modelProvider.model ?? null,
      agents: this.store.listAgents(),
      sessions: this.store.listSessions()
    };
  }
}

// What each scrutiny verdict means for THIS turn — matches the enforcement
// in agent-host.handleMessage / ToolRegistry.invoke, so the model's
// expectations line up with what will actually happen to its tool calls.
function verdictGuidance(action) {
  if (action === "ask") {
    return "This turn: clarify before acting. Ask ONE focused clarifying question. Any side-effecting tool you call now will be queued for the user's approval instead of executing immediately — prefer to ask first, act next turn.\n";
  }
  if (action === "watch") {
    return "This turn: observation mode. Only read-only tools are available; side-effecting calls will be rejected. Answer from what you can read and note what you'd do once confidence is higher.\n";
  }
  if (action === "ignore") {
    return "This turn: low-signal. No tools are available. Reply briefly and move on.\n";
  }
  return "";
}

// Format the fresh focused-window context the floating widget attaches to a
// message (metadata.screenContext = { app, window, text }) into a labeled
// prompt block. Returns "" when absent/empty. Pure + exported for testing.
export function formatScreenContextBlock(screenContext) {
  if (!screenContext || typeof screenContext.text !== "string" || !screenContext.text.trim()) return "";
  const where = screenContext.window
    ? `${screenContext.app || "?"} · ${screenContext.window}`
    : (screenContext.app || "active window");
  const body = screenContext.text.slice(0, 4000);
  return `\nActive window the user is looking at right now (${where}):\n${body}\nGround your answer in this if it's relevant; don't quote it back verbatim.\n`;
}

// Maps a provider class to a short user-facing label. Avoids leaking
// "AnthropicProvider" / "OpenAIResponsesProvider" class names into the
// dashboard header.
function friendlyProviderLabel(provider) {
  if (!provider) return "—";
  const cls = provider.constructor?.name ?? "";
  if (cls === "AnthropicProvider") return "Anthropic";
  if (cls === "OpenAIResponsesProvider") return "OpenAI";
  if (cls === "DeterministicModelProvider") return provider.name ?? "deterministic";
  return cls.replace(/Provider$/, "") || "—";
}
