import path from "node:path";
import { AgentHost } from "./agent-host.js";
import { FileBackedAgentStore } from "./agent-store.js";
import { CronScheduler, createDailyAdaptationReviewJob } from "./cron-scheduler.js";
import { DirectionalAdaptiveScrutiny } from "./directional-adaptive-scrutiny.js";
import { FileBackedCronScheduler } from "./file-backed-cron-scheduler.js";
import { FileBackedMemorySystem } from "./file-backed-memory-system.js";
import { FileBackedPropagationController } from "./file-backed-propagation-controller.js";
import { createAbiIntegration, IntegrationRegistry } from "./integration-registry.js";
import { fileURLToPath } from "node:url";
import { BudgetGuard } from "./budget-guard.js";
import { registerRizeIntegration } from "./integrations/rize.js";
import { McpRegistry } from "./mcp-registry.js";
import { OutcomeStore } from "./outcome-store.js";
import { ScrutinyPanel } from "./scrutiny-panel.js";
import { SpecialistRouter } from "./specialist-router.js";
import { MemorySystem } from "./memory-system.js";
import { PropagationController } from "./propagation-controller.js";
import { SkillRegistry } from "./skills.js";
import { registerCoreTools, ToolRegistry } from "./tool-registry.js";
import { registerDefaultWorkflows, WorkflowRegistry } from "./workflow-registry.js";
import { createId, nowIso } from "./utils.js";

const AUTOPILOT_DEFAULT_PROMPT = `Autopilot pulse. Look at what's recent — sessions, memory, scheduled jobs, MCP tools you have access to.
Decide if anything needs action right now: a follow-up to send, a memory to record, a schedule to set, a check to run.
- If yes: take the action by calling tools (use \`send_message\` to reach the user, \`schedule_message\` to defer, \`remember\` for facts).
- If nothing needs doing, reply with exactly one short sentence describing what you observed and "standing by".
Do not invent work. Be conservative — fewer actions, higher signal.`;

export class AbiRuntime {
  constructor(options = {}) {
    this.context = {
      name: "OpenAGI ABI",
      goalAlignment: 0.8,
      strategicFit: 0.75,
      policyFit: 0.82,
      environmentalPressure: 0.45,
      internalPressure: 0.55,
      ...(options.context ?? {})
    };
    this.integrations = options.integrations ?? new IntegrationRegistry();
    this.workflows = options.workflows ?? registerDefaultWorkflows(new WorkflowRegistry());
    this.memory = options.memory ?? new MemorySystem(options.memoryOptions);
    this.scrutiny = options.scrutiny ?? (options.scrutinyMode === "single"
      ? new DirectionalAdaptiveScrutiny(options.scrutinyOptions)
      : new ScrutinyPanel(options.scrutinyOptions));
    this.propagation = options.propagation ?? new PropagationController(options.propagationOptions);
    this.cron = options.cron ?? new CronScheduler();
    this.mcp = options.mcp ?? new McpRegistry(options.mcpOptions ?? {});
    this.tools = options.tools ?? new ToolRegistry();
    this.mcp.bindToolRegistry(this.tools);
    this.skills = options.skills ?? null;
    this.budget = options.budget ?? new BudgetGuard(options.budgetOptions ?? {});
    this.outcomes = options.outcomes ?? new OutcomeStore(options.outcomeOptions ?? {});
    this.specialistRouter = options.specialistRouter ?? new SpecialistRouter(options.routerOptions ?? {});
    this.outputs = [];
    this.feedback = [];

    if (options.registerDefaults !== false) {
      this.integrations.register(createAbiIntegration());
      this.cron.addJob(createDailyAdaptationReviewJob());
      registerCoreTools(this.tools, this);
    }

    if (options.skills !== false && !this.skills) {
      const bundled = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "examples", "skills");
      const userDir = options.skillsDir ?? null;
      const dirs = [bundled];
      if (userDir) dirs.push(userDir);
      this.skills = new SkillRegistry({ runtime: this, dirs });
    }

    if (options.integrations !== false) registerRizeIntegration(this);
  }

  processIntegrationEvent(source, payload) {
    const signals = this.integrations.ingest(source, payload);
    return signals.map((signal) => this.processSignal(signal));
  }

  processSignal(signal) {
    const workflow = this.workflows.select(signal);
    const memoryHits = this.memory.retrieve(`${signal.summary} ${signal.content} ${signal.tags?.join(" ") ?? ""}`, {
      limit: 6
    });
    const scrutiny = this.scrutiny.evaluate({
      signal,
      workflow,
      memories: memoryHits,
      context: this.context
    });

    const propagationDecision = this.propagation.shouldPropagate({ signal, scrutiny, memoryHits });
    const propagated =
      propagationDecision.decision && scrutiny.action !== "ignore"
        ? this.propagation.propagate({
            signal,
            workflow,
            scrutiny,
            tools: this.mcp.listTools()
          })
        : { created: false, reason: "not-needed", specialist: null };

    if (propagated.specialist && this.agentHost?.ensureSpecialistAgent) {
      this.agentHost.ensureSpecialistAgent(propagated.specialist, "main");
    }

    const memoryItem = this.memory.remember(
      {
        source: signal.source,
        content: `${signal.summary}\nDecision: ${scrutiny.action}\nReasons: ${scrutiny.reasons.join(" ")}`,
        tags: ["signal", signal.domain, signal.taskType, ...(signal.tags ?? [])],
        novelty: signal.novelty,
        risk: signal.risk,
        repetition: signal.repetition,
        specificity: signal.specificity,
        metadata: {
          signalId: signal.id,
          workflowId: workflow?.id,
          scrutiny: scrutiny.dimensions
        }
      },
      {
        source: "abi-runtime",
        strength: scrutiny.score,
        critical: signal.risk >= 0.85
      }
    );

    const output = {
      id: createId("out"),
      createdAt: nowIso(),
      signal,
      workflow,
      action: scrutiny.action,
      scrutiny,
      memory: memoryItem,
      propagation: propagated,
      customContext: memoryHits.map(({ item, score }) => ({
        id: item.id,
        tier: item.tier,
        score,
        content: item.content
      }))
    };

    this.outputs.push(output);
    this.feedback.push({
      id: createId("fb"),
      outputId: output.id,
      createdAt: nowIso(),
      loop: "outputs-to-integrations",
      summary: `Output ${output.id} fed back into memory tier ${memoryItem.tier}.`
    });

    return output;
  }

  async tick(now = new Date()) {
    this.memory.decay(now);
    return this.cron.runDue(async (job) => {
      if (job.task === "daily-adaptation-review") {
        return this.processSignal({
          id: createId("sig"),
          ...job.input,
          receivedAt: nowIso()
        });
      }
      if (job.task === "prompt") {
        return this.runScheduledPrompt(job);
      }
      if (job.task === "autopilot") {
        return this.runAutopilot(job);
      }
      return { skipped: true, reason: `No handler for task ${job.task}` };
    }, now);
  }

  async runAutopilot(job) {
    if (!this.agentHost) return { skipped: true, reason: "agent-host-disabled" };
    try {
      this.budget.check();
    } catch (error) {
      return { skipped: true, reason: error.message };
    }
    const input = job.input ?? {};
    const sessionId = input.sessionId ?? `autopilot:${job.id}`;
    const prompt = input.prompt ?? AUTOPILOT_DEFAULT_PROMPT;
    const result = await this.agentHost.handleMessage({
      channel: "autopilot",
      from: "autopilot",
      agentId: input.agentId ?? "main",
      sessionId,
      text: prompt,
      metadata: {
        scheduledJobId: job.id,
        scheduledJobName: job.name,
        firedAt: nowIso()
      },
      origin: "autopilot"
    });
    result.autopilot = true;
    return result;
  }

  async runScheduledPrompt(job) {
    if (!this.agentHost) return { skipped: true, reason: "agent-host-disabled" };
    const input = job.input ?? {};
    const result = await this.agentHost.handleMessage({
      channel: input.channel ?? "cron",
      from: input.target ?? "cron",
      agentId: input.agentId ?? "main",
      sessionId: input.sessionId,
      text: input.prompt ?? "(empty scheduled prompt)",
      metadata: { scheduledJobId: job.id, scheduledJobName: job.name },
      origin: "cron"
    });
    if (this.channels && input.channel && input.target) {
      try {
        await this.channels.deliver({
          channel: input.channel,
          target: input.target,
          text: result.reply
        });
        result.delivered = { channel: input.channel, target: input.target };
      } catch (error) {
        result.deliveryError = error.message;
      }
    }
    if (input.oneShot) {
      this.cron.removeJob(job.id);
    }
    return result;
  }

  status() {
    return {
      context: this.context,
      integrations: this.integrations.list(),
      workflows: this.workflows.list().map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        domain: workflow.domain,
        taskType: workflow.taskType
      })),
      memory: {
        short: this.memory.byTier("short").length,
        medium: this.memory.byTier("medium").length,
        long: this.memory.byTier("long").length
      },
      specialists: this.propagation.list().length,
      cron: this.cron.listJobs(),
      outputs: this.outputs.length,
      feedback: this.feedback.length,
      agentHost: this.agentHost
        ? {
            provider: this.agentHost.modelProvider.constructor.name,
            providerConfigured: this.agentHost.modelProvider.isConfigured(),
            agents: this.agentHost.store.listAgents().length,
            sessions: this.agentHost.store.listSessions().length
          }
        : null
    };
  }
}

export function createDefaultRuntime(options = {}) {
  const runtime = new AbiRuntime(options);
  if (options.agentHost !== false) {
    runtime.agentHost =
      options.agentHostInstance ??
      new AgentHost({
        runtime,
        store: options.agentStore,
        storeOptions: options.agentStoreOptions,
        modelProvider: options.modelProvider,
        modelProviderOptions: { ...(options.modelProviderOptions ?? {}), budgetGuard: runtime.budget }
      });
  }
  runtime.mcp.registerServer({
    name: "openagi-mcp",
    trustLevel: "trusted",
    tools: [
      { name: "memory-search", description: "Search persistent ABI memory." },
      { name: "create-specialist", description: "Create or update a bounded specialist." },
      { name: "publish-output", description: "Publish an ABI output or report." }
    ]
  });
  return runtime;
}

export function createDurableRuntime(options = {}) {
  const dataDir = options.dataDir ?? path.join(process.cwd(), ".openagi");
  const mcpLogDir = path.join(dataDir, "mcp", "logs");
  const runtime = createDefaultRuntime({
    ...options,
    skillsDir: options.skillsDir ?? path.join(dataDir, "skills"),
    mcpOptions: { logDir: mcpLogDir, ...(options.mcpOptions ?? {}) },
    budgetOptions: { storePath: path.join(dataDir, "budget", "usage.json"), ...(options.budgetOptions ?? {}) },
    outcomeOptions: { dir: path.join(dataDir, "outcomes"), ...(options.outcomeOptions ?? {}) },
    memory: options.memory ?? new FileBackedMemorySystem({ ...(options.memoryOptions ?? {}), dir: path.join(dataDir, "memory") }),
    cron: options.cron ?? new FileBackedCronScheduler({ storePath: path.join(dataDir, "cron", "jobs.json") }),
    propagation:
      options.propagation ??
      new FileBackedPropagationController({
        ...(options.propagationOptions ?? {}),
        storePath: path.join(dataDir, "agents", "specialists.json"),
        workspaceRoot: path.join(dataDir, "agents", "workspaces")
      }),
    agentStore:
      options.agentStore ??
      new FileBackedAgentStore({
        ...(options.agentStoreOptions ?? {}),
        dir: path.join(dataDir, "agent-host")
      })
  });
  const mcpConfigPath = options.mcpConfigPath ?? path.join(dataDir, "mcp.json");
  runtime.mcp.loadConfigFile(mcpConfigPath);
  return runtime;
}
