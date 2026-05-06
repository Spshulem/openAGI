import { InMemoryAgentStore } from "./agent-store.js";
import { createModelProvider } from "./model-provider.js";
import { createId, nowIso } from "./utils.js";

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
      const decision = this.runtime.specialistRouter.decide(text, tags, specialists);
      routing = decision;
      if (decision.route && decision.candidate) {
        agentId = decision.candidate.specialist.id;
      }
    }

    const agent = this.store.getAgent(agentId);
    const sessionId = this.store.sessionKey({ channel, from, agentId, sessionId: input.sessionId });
    const sessionBefore = this.store.appendMessage(sessionId, {
      role: "user",
      content: text,
      agentId,
      channel,
      from,
      metadata: input.metadata ?? {}
    });

    const signal = this.messageToSignal({ text, channel, from, agent, sessionId, metadata: input.metadata ?? {} });
    const output = this.runtime.processSignal(signal);

    if (output.propagation?.specialist) {
      this.ensureSpecialistAgent(output.propagation.specialist, agentId);
    }

    const toolRegistry = this.runtime.tools;
    const tools = toolRegistry?.toOpenAITools?.() ?? [];

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
      instructions: this.instructionsForAgent(agent, output),
      tools,
      toolRegistry,
      context: {
        channel,
        from,
        target: from,
        agentId,
        sessionId,
        runtime: this.runtime
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

  instructionsForAgent(agent, output) {
    return `${agent.systemPrompt ? `${agent.systemPrompt}\n\n` : ""}You are ${agent.name}, an always-on OpenAGI agent.

Your job is to help through the ABI loop:
1. Apply directional adaptive scrutiny.
2. Use memory deliberately.
3. Propagate bounded specialists only when repeated or novel high-risk work justifies it.

Current decision: ${output.scrutiny.action}
Reasons:
${output.scrutiny.reasons.map((reason) => `- ${reason}`).join("\n")}

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
      provider: this.modelProvider.constructor.name,
      providerConfigured: this.modelProvider.isConfigured(),
      agents: this.store.listAgents(),
      sessions: this.store.listSessions()
    };
  }
}
