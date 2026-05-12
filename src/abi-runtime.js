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
import { registerLinearTaskSource } from "./integrations/linear-tasks.js";
import { registerInboxWatcher } from "./integrations/inbox-watcher.js";
import { registerIMessagePoller } from "./integrations/imessage-poller.js";
import { registerBuildBetterTaskSource } from "./integrations/buildbetter-tasks.js";
import { createEmbedder } from "./embeddings.js";
import { McpRegistry } from "./mcp-registry.js";
import { MemoryCondenser } from "./memory-condenser.js";
import { ObservationStore } from "./observation-store.js";
import { OutcomeStore } from "./outcome-store.js";
import { Introspector } from "./introspector.js";
import { PatternMiner } from "./pattern-miner.js";
import { SessionMiner } from "./session-miner.js";
import { ProactiveObserver } from "./proactive-observer.js";
import { TaskStore } from "./task-store.js";
import { PendingActionStore } from "./pending-actions.js";
import { ComputerUseLog } from "./computer-use-log.js";
import { registerComputerUseTools, isComputerUseEnabled } from "./integrations/computer-use.js";
import { SuggestionFeedback } from "./suggestion-feedback.js";
import { ScrutinyFitter } from "./scrutiny-fitter.js";
import { SkillReplay } from "./skill-replay.js";
import { ScrutinyJudge } from "./scrutiny-judge.js";
import { ScrutinyPanel } from "./scrutiny-panel.js";
import { SpecialistRouter } from "./specialist-router.js";
import { TunnelWatcher } from "./tunnel-watcher.js";
import { VectorStore } from "./vector-store.js";
import { VocabularyCurator } from "./vocabulary-curator.js";
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

// Default pulse that actually drains the agent's queue. Without this
// being scheduled by default, the agent queue ("things I committed to
// do for the user") would just sit there waiting. Fires every 30 min,
// queue-first: pull the next task, work it via tools, complete or update.
// Conservative on the empty path so we don't burn LLM cycles inventing
// work. Users who want a different cadence can edit the cron job in
// the dashboard; setting it to disabled turns the autopilot off entirely.
const AGENT_PULSE_PROMPT = `Agent autopilot pulse. Drain your queue.

1. Call \`agent_pick_next\` to get the highest-priority task you've committed to do.
2. If there's a task: work on it. Use tools as needed (\`recall\`, \`run_mcp_tool\`, \`send_message\`, \`schedule_message\`, etc). When the task is done, call \`complete_task\` with the task id. If it's still in progress or needs to be deferred, call \`move_task\` to update its status / bucket / due date.
3. If the queue is empty (\`{task: null}\`): you don't need to invent work. Glance at recent sessions only if something obviously needs a follow-up — otherwise reply "standing by" in one sentence and stop.

The user is not in this conversation — the only output that matters is what you DO via tools, not what you say. Take no action if you have no committed work; do not summarize, do not editorialize.`;

const HARSH_REVIEW_PROMPT = `Weekly harsh review. Be skeptical and direct, not generous.

1. Call \`recall\` for "this week" and surface the most repeated themes.
2. Call \`list_sessions\` and judge: which conversations went somewhere, which fizzled?
3. Look at any specialists you've spawned — are they earning their keep, or should they be retired?
4. Are any scheduled jobs noise (firing without producing useful output)?
5. Did the user push back on or ignore anything you sent?

Output four short bullets:
- KEEP: what worked
- KILL: what to retire / unschedule (use the retire/cancel tools when sure)
- CHANGE: what to recalibrate
- ASK: what you genuinely need the user to clarify

No generalities. Cite specific session ids, job names, specialist ids.`;

function nextSundayEvening() {
  const d = new Date();
  d.setHours(20, 0, 0, 0);
  const daysUntilSunday = (7 - d.getDay()) % 7;
  d.setDate(d.getDate() + (daysUntilSunday === 0 ? 7 : daysUntilSunday));
  return d;
}

function nextSundayMorning(hour = 5) {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  const daysUntilSunday = (7 - d.getDay()) % 7;
  d.setDate(d.getDate() + (daysUntilSunday === 0 ? 7 : daysUntilSunday));
  return d;
}

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
    // Pending-action queue: tools flagged needsConfirmation route through
    // here so the user can approve/deny before the agent's intent runs.
    this.pendingActions = options.pendingActions ?? new PendingActionStore({
      dir: options.dataDir ? path.join(options.dataDir, "pending-actions") : undefined,
      ...(options.pendingActionStoreOptions ?? {})
    });
    this.tools.bindPendingActions(this.pendingActions);
    // Computer-use log is always allocated so the dashboard can render the
    // log surface even when the feature is off (showing zero sessions).
    // The actual tools only register when OPENAGI_COMPUTER_USE=1.
    this.computerUseLog = options.computerUseLog ?? new ComputerUseLog({
      dir: options.dataDir ? path.join(options.dataDir, "computer-use") : undefined
    });
    this.skills = options.skills ?? null;
    this.budget = options.budget ?? new BudgetGuard(options.budgetOptions ?? {});
    this.outcomes = options.outcomes ?? new OutcomeStore(options.outcomeOptions ?? {});
    this.observations = options.observations ?? new ObservationStore(options.observationOptions ?? {});
    // When an outcome resolves, push the quality into the matching specialist's running mean.
    this.outcomes.onResolve = (outcome) => {
      const specialistId = outcome.metadata?.specialistId;
      if (specialistId && typeof outcome.qualityScore === "number") {
        this.propagation.recordOutcomeQuality?.(specialistId, outcome.qualityScore);
      }
    };
    this.embedder = options.embedder ?? createEmbedder({ budgetGuard: this.budget, ...(options.embedderOptions ?? {}) });
    this.vectorStore = options.vectorStore ?? new VectorStore({ embedder: this.embedder, ...(options.vectorStoreOptions ?? {}) });
    if (typeof this.propagation.bindVectorStore === "function") this.propagation.bindVectorStore(this.vectorStore);
    this.specialistRouter = options.specialistRouter ?? new SpecialistRouter({ vectorStore: this.vectorStore, ...(options.routerOptions ?? {}) });
    this.condenser = options.condenser ?? new MemoryCondenser({ runtime: this, ...(options.condenserOptions ?? {}) });
    this.scrutinyFitter = options.scrutinyFitter ?? new ScrutinyFitter({ runtime: this, ...(options.scrutinyFitterOptions ?? {}) });
    this.scrutinyJudge = options.scrutinyJudge ?? new ScrutinyJudge({ runtime: this, ...(options.scrutinyJudgeOptions ?? {}) });
    this.vocabulary = options.vocabulary ?? new VocabularyCurator({ runtime: this, ...(options.vocabularyOptions ?? {}) });
    this.introspector = options.introspector ?? new Introspector({ runtime: this });
    this.tunnelWatcher = options.tunnelWatcher ?? new TunnelWatcher(options.tunnelWatcherOptions ?? {});
    this.patternMiner = options.patternMiner ?? new PatternMiner({ runtime: this, dataDir: options.dataDir, ...(options.patternMinerOptions ?? {}) });
    this.sessionMiner = options.sessionMiner ?? new SessionMiner({ runtime: this, dataDir: options.dataDir, ...(options.sessionMinerOptions ?? {}) });
    this.proactiveObserver = options.proactiveObserver ?? new ProactiveObserver({ runtime: this, dataDir: options.dataDir, ...(options.proactiveObserverOptions ?? {}) });
    // Story 3: closes the suggestion → outcome → next-suggestion loop.
    // Reads resolved suggestion history + user mute preferences, feeds
    // a compact summary into the observer's system prompt each pass.
    this.suggestionFeedback = options.suggestionFeedback ?? new SuggestionFeedback({ runtime: this, dataDir: options.dataDir });
    this.tasks = options.tasks ?? new TaskStore({ runtime: this, dataDir: options.dataDir, ...(options.taskStoreOptions ?? {}) });
    this.skillReplay = options.skillReplay ?? new SkillReplay({ runtime: this, dataDir: options.dataDir, ...(options.skillReplayOptions ?? {}) });
    this.outputs = [];
    this.feedback = [];

    if (options.registerDefaults !== false) {
      this.integrations.register(createAbiIntegration());
      this.cron.addJob(createDailyAdaptationReviewJob());
      this.cron.addJob({
        id: "daily-memory-condense",
        name: "Daily memory condensation",
        enabled: true,
        task: "condense",
        dailyAt: "03:30"
      });
      this.cron.addJob({
        id: "agent-pulse",
        name: "Agent autopilot — drain agent queue every 30 min",
        enabled: true,
        task: "autopilot",
        intervalMs: 30 * 60 * 1000,
        input: {
          agentId: "main",
          prompt: AGENT_PULSE_PROMPT
        }
      });
      this.cron.addJob({
        id: "weekly-harsh-review",
        name: "Weekly harsh review",
        enabled: true,
        task: "autopilot",
        intervalMs: 7 * 24 * 60 * 60 * 1000,
        nextRunAt: nextSundayEvening().toISOString(),
        input: {
          agentId: "main",
          prompt: HARSH_REVIEW_PROMPT
        }
      });
      this.cron.addJob({
        id: "daily-retirement-sweep",
        name: "Daily specialist retirement sweep",
        enabled: true,
        task: "retirement-sweep",
        dailyAt: "04:00"
      });
      this.cron.addJob({
        id: "weekly-scrutiny-fit",
        name: "Weekly scrutiny weight fit",
        enabled: true,
        task: "scrutiny-fit",
        intervalMs: 7 * 24 * 60 * 60 * 1000,
        nextRunAt: nextSundayMorning().toISOString()
      });
      this.cron.addJob({
        id: "weekly-scrutiny-judge",
        name: "Weekly LLM judge of scrutiny calibration",
        enabled: true,
        task: "scrutiny-judge",
        intervalMs: 7 * 24 * 60 * 60 * 1000,
        nextRunAt: nextSundayMorning(2).toISOString()
      });
      this.cron.addJob({
        id: "nightly-pattern-mine",
        name: "Nightly activity pattern miner",
        enabled: true,
        task: "pattern-mine",
        dailyAt: "02:30"
      });
      this.cron.addJob({
        id: "nightly-session-mine",
        name: "Nightly chat-session skill miner",
        enabled: true,
        task: "session-mine",
        dailyAt: "03:30"
      });
      // Lighter hourly pass so new patterns surface within ~hour of forming
      // rather than waiting until the nightly run.
      this.cron.addJob({
        id: "hourly-session-mine",
        name: "Hourly chat-session skill miner",
        enabled: true,
        task: "session-mine",
        intervalMs: 60 * 60 * 1000
      });
      // Proactive observer — fast cadence so the agent reacts within
      // minutes when it sees something worth saying.
      this.cron.addJob({
        id: "proactive-observer",
        name: "Proactive observer (continuous skill/MCP suggester)",
        enabled: true,
        task: "proactive-observe",
        intervalMs: 10 * 60 * 1000
      });
      // Morning task digest — local 8am, fires a notification with the
      // pending today bucket so the user starts the day knowing what's
      // queued. Skipped silently if there are zero pending tasks.
      this.cron.addJob({
        id: "daily-task-digest",
        name: "Daily morning task digest",
        enabled: true,
        task: "task-digest",
        dailyAt: "08:00"
      });
      // Due-date reminders — every 15 min, check if any task crossed its
      // dueDate since the last check. Fires a 'task-reminder' event the
      // SSE relay + Mac notify pipeline picks up.
      this.cron.addJob({
        id: "task-reminders",
        name: "Due-date reminders for user tasks",
        enabled: true,
        task: "task-reminders",
        intervalMs: 15 * 60 * 1000
      });
      // Observation-driven task lifecycle — every 15 min, scan recent
      // OCR against pending tasks and auto-complete / mark in-progress
      // when there's strong evidence. Conservative thresholds; the user
      // can always revert via the dashboard.
      this.cron.addJob({
        id: "task-activity-scan",
        name: "Auto-detect task completion / progress from screen",
        enabled: true,
        task: "task-activity-scan",
        intervalMs: 15 * 60 * 1000
      });
      registerCoreTools(this.tools, this);
      // Computer-use tools register only when explicitly opted-in via env
      // (OPENAGI_COMPUTER_USE=1). Default install doesn't expose them so
      // an LLM can't accidentally try to drive the user's screen. The
      // dashboard's toggle can flip this at runtime without a restart;
      // see /computer-use/toggle in hosted-interface.js.
      if (isComputerUseEnabled()) {
        registerComputerUseTools(this.tools, this);
      }
    }

    if (options.skills !== false && !this.skills) {
      const bundled = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "examples", "skills");
      const userDir = options.skillsDir ?? null;
      const dirs = [bundled];
      if (userDir) dirs.push(userDir);
      this.skills = new SkillRegistry({ runtime: this, dirs });
    }

    if (options.integrations !== false) {
      registerRizeIntegration(this);
      // Linear is env-gated — silently no-ops if LINEAR_API_KEY isn't set.
      registerLinearTaskSource(this);
      // BuildBetter is env-gated too. Needs BUILDBETTER_API_KEY plus either
      // BUILDBETTER_USER_EMAIL or BUILDBETTER_USER_NAME so it knows which
      // attendee's action items to pull.
      registerBuildBetterTaskSource(this);
      // Inbox watcher always runs — it just polls a local dir; if nothing's
      // dropped in there it returns { processed: 0 } and moves on. Sources
      // like reMarkable / Obsidian / Bear can sync into .openagi/inbox/.
      registerInboxWatcher(this);
      // iMessage chat.db poller. Off by default — requires explicit
      // IMESSAGE_ENABLED=1 + a self-handle, and macOS Full Disk Access.
      // The source attaches to runtime even when disabled so the dashboard
      // can render the toggle + permission status.
      registerIMessagePoller(this);
    }
  }

  processIntegrationEvent(source, payload) {
    const signals = this.integrations.ingest(source, payload);
    return signals.map((signal) => this.processSignal(signal));
  }

  processSignal(signal, options = {}) {
    const workflow = this.workflows.select(signal);
    const memoryHits = this.memory.retrieve(`${signal.summary} ${signal.content} ${signal.tags?.join(" ") ?? ""}`, {
      limit: 6,
      scope: options.scope
    });
    const scrutiny = this.scrutiny.evaluate({
      signal,
      workflow,
      memories: memoryHits,
      context: this.context
    });

    const parentSpecialistId = options.parentSpecialistId ?? null;
    const propagationDecision = this.propagation.shouldPropagate({ signal, scrutiny, memoryHits, parentSpecialistId });
    const propagated =
      propagationDecision.decision && scrutiny.action !== "ignore"
        ? this.propagation.propagate({
            signal,
            workflow,
            scrutiny,
            tools: this.mcp.listTools(),
            parentSpecialistId
          })
        : { created: false, reason: propagationDecision.blockedBy ?? "not-needed", specialist: null };

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

    // If any due jobs are >5min overdue, this tick is catching up after
    // a sleep / suspended-process window. Emit a 'cron-catchup' event so
    // the dashboard can show a "✓ Caught up N missed jobs" toast and the
    // user can see the system is doing the right thing rather than
    // wondering why scheduled prompts didn't fire on time.
    const due = this.cron.dueJobs(now);
    const overdue = due.filter((j) => {
      const next = new Date(j.nextRunAt).getTime();
      return next > 0 && (now.getTime() - next) > 5 * 60 * 1000;
    });
    if (overdue.length > 0) {
      this.events?.emit?.("cron-catchup", {
        at: nowIso(),
        count: overdue.length,
        jobs: overdue.map((j) => ({ id: j.id, name: j.name, lateBySeconds: Math.round((now.getTime() - new Date(j.nextRunAt).getTime()) / 1000) }))
      });
    }

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
      if (job.task === "condense") {
        return this.condenser.condense({ now });
      }
      if (job.task === "retirement-sweep") {
        const retired = this.propagation.retirementSweep?.() ?? [];
        // C3: cross-generation inheritance — distill each retired specialist's
        // scoped memory into a legacy principle that lives in main long-tier.
        const legacies = [];
        for (const sp of retired) {
          try {
            const result = await this.condenser.condense({
              scope: `specialist:${sp.id}`,
              writeScope: "main",
              originSpecialistId: sp.id
            });
            legacies.push({ specialistId: sp.id, principles: result.principles ?? 0 });
          } catch { /* skip */ }
        }
        return { retired: retired.map((s) => ({ id: s.id, name: s.name, reason: s.retirementReason })), legacies };
      }
      if (job.task === "scrutiny-fit") {
        return this.scrutinyFitter.fit({ now });
      }
      if (job.task === "scrutiny-judge") {
        return this.scrutinyJudge.judge();
      }
      if (job.task === "pattern-mine") {
        const result = await this.patternMiner.mine({ now });
        this.events?.emit?.("miner-result", { source: "pattern-miner", at: nowIso(), ...result });
        return result;
      }
      if (job.task === "session-mine") {
        const result = await this.sessionMiner.mine({ now });
        this.events?.emit?.("miner-result", { source: "session-miner", at: nowIso(), ...result });
        return result;
      }
      if (job.task === "proactive-observe") {
        const result = await this.proactiveObserver.observe({ now });
        this.events?.emit?.("miner-result", { source: "proactive-observer", at: nowIso(), ...result });
        return result;
      }
      if (job.task === "linear-task-sync") {
        if (!this.linearTaskSource?.sync) return { skipped: true, reason: "no linear source" };
        return this.linearTaskSource.sync({ now });
      }
      if (job.task === "buildbetter-task-sync") {
        if (!this.buildBetterTaskSource?.sync) return { skipped: true, reason: "no buildbetter source" };
        return this.buildBetterTaskSource.sync({ now });
      }
      if (job.task === "inbox-sweep") {
        if (!this.inboxWatcher?.sweep) return { skipped: true, reason: "no inbox watcher" };
        return this.inboxWatcher.sweep();
      }
      if (job.task === "imessage-sync") {
        if (!this.imessagePoller?.sync) return { skipped: true, reason: "no imessage poller" };
        return this.imessagePoller.sync({ now });
      }
      if (job.task === "task-digest") {
        return this.runTaskDigest({ now });
      }
      if (job.task === "task-reminders") {
        return this.runTaskReminders({ now });
      }
      if (job.task === "task-activity-scan") {
        if (!this.proactiveObserver?.scanTasksAgainstActivity) return { skipped: true, reason: "no observer" };
        const result = await this.proactiveObserver.scanTasksAgainstActivity({ now });
        this.events?.emit?.("miner-result", { source: "task-activity-scan", at: nowIso(), ...result });
        return result;
      }
      return { skipped: true, reason: `No handler for task ${job.task}` };
    }, now);
  }

  // Morning digest: roll up pending today-bucket user tasks into one
  // notification. Skipped silently when there's nothing pending.
  runTaskDigest({ now = new Date() } = {}) {
    if (!this.tasks?.list) return { skipped: true, reason: "no task store" };
    const todayPending = this.tasks.list({ queue: "user", bucket: "today", status: "pending", limit: 12 });
    if (todayPending.length === 0) return { skipped: true, reason: "no pending tasks today" };
    const titles = todayPending.slice(0, 6).map((t) => t.title);
    const more = todayPending.length > 6 ? ` (+${todayPending.length - 6} more)` : "";
    this.events?.emit?.("task-reminder", {
      kind: "digest",
      at: nowIso(),
      count: todayPending.length,
      title: `${todayPending.length} task${todayPending.length === 1 ? "" : "s"} for today`,
      body: titles.join(" · ") + more
    });
    return { fired: 1, count: todayPending.length };
  }

  // Due-date reminders: tasks whose dueDate just crossed (since the last
  // tick) get a reminder. Uses sourceMeta.lastReminderAt to avoid spamming
  // the same task every 15 min.
  runTaskReminders({ now = new Date() } = {}) {
    if (!this.tasks?.list) return { skipped: true, reason: "no task store" };
    const cutoffMs = now.getTime();
    const reminderWindowMs = 6 * 60 * 60 * 1000; // don't re-remind within 6h
    let fired = 0;
    for (const t of this.tasks.list({ status: "pending", limit: 200 })) {
      if (!t.dueDate) continue;
      const dueMs = Date.parse(t.dueDate);
      if (!Number.isFinite(dueMs)) continue;
      if (dueMs > cutoffMs) continue; // not yet due
      const lastReminded = t.sourceMeta?.lastReminderAt ? Date.parse(t.sourceMeta.lastReminderAt) : 0;
      if (Number.isFinite(lastReminded) && cutoffMs - lastReminded < reminderWindowMs) continue;
      this.events?.emit?.("task-reminder", {
        kind: "due",
        at: nowIso(),
        taskId: t.id,
        title: `Due: ${t.title}`,
        body: t.description ? t.description.slice(0, 200) : "",
        dueDate: t.dueDate
      });
      this.tasks.update(t.id, {
        sourceMeta: { ...(t.sourceMeta ?? {}), lastReminderAt: nowIso() }
      });
      fired += 1;
    }
    return { fired };
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
  // Note: we used to register a placeholder "openagi-mcp" entry here listing
  // memory-search / create-specialist / publish-output. Those are now real
  // tools in the internal ToolRegistry, so the placeholder is redundant and
  // produced "transport config not supported" when users tried to connect it.
  // Real MCP servers come from .openagi/mcp.json or POST /mcp/register.
  return runtime;
}

export function createDurableRuntime(options = {}) {
  const dataDir = options.dataDir ?? path.join(process.cwd(), ".openagi");
  const mcpLogDir = path.join(dataDir, "mcp", "logs");
  const runtime = createDefaultRuntime({
    ...options,
    skillsDir: options.skillsDir ?? path.join(dataDir, "skills"),
    mcpOptions: {
      logDir: mcpLogDir,
      dataDir,
      configPath: options.mcpConfigPath ?? path.join(dataDir, "mcp.json"),
      ...(options.mcpOptions ?? {})
    },
    budgetOptions: { storePath: path.join(dataDir, "budget", "usage.json"), ...(options.budgetOptions ?? {}) },
    outcomeOptions: { dir: path.join(dataDir, "outcomes"), ...(options.outcomeOptions ?? {}) },
    observationOptions: { dir: path.join(dataDir, "observations"), ...(options.observationOptions ?? {}) },
    vectorStoreOptions: { dir: path.join(dataDir, "vectors"), ...(options.vectorStoreOptions ?? {}) },
    tunnelWatcherOptions: { dataDir, ...(options.tunnelWatcherOptions ?? {}) },
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
