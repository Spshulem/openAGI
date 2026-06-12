import path from "node:path";
import { resolveDataDir } from "./data-dir.js";
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
import { registerCalendarIntegration } from "./integrations/calendar.js";
import { registerWebSearchTools } from "./integrations/web-search.js";
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
import { ClarificationStore } from "./clarification-store.js";
import { DraftStore } from "./draft-store.js";
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
import { applyPersona } from "./persona.js";
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
   - DRAFT-ONLY tasks (tagged \`plan-action\`, or whose description says "produce a draft only"): prepare the artifact and leave it for the user — write the draft into your reply and/or save it, but do NOT send, publish, or schedule anything externally. Mark \`complete_task\` once the draft is ready for review.
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
    this.scrutinyFitter = options.scrutinyFitter ?? new ScrutinyFitter({
      runtime: this,
      // Root persisted weights under the runtime's data dir (not the global
      // resolveDataDir default), so a custom createDurableRuntime({dataDir})
      // keeps its calibration with the rest of its state.
      dir: options.dataDir ? path.join(options.dataDir, "scrutiny") : undefined,
      ...(options.scrutinyFitterOptions ?? {})
    });
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
    // The "ask me" queue: ambiguous task-reconciliation outcomes become
    // questions instead of bad guesses. dataDir-scoped like other stores.
    this.clarifications = options.clarifications ?? new ClarificationStore({
      runtime: this,
      dir: options.dataDir ? `${options.dataDir}/clarifications` : undefined
    });
    // Where the agent's draft-only work lands for human review.
    this.drafts = options.drafts ?? new DraftStore({
      runtime: this,
      dir: options.dataDir ? `${options.dataDir}/drafts` : undefined
    });
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
      // Opt-in self-update: when OPENAGI_AUTO_UPDATE is truthy, the daemon
      // checks its git checkout daily and fast-forwards + restarts if a newer
      // version is available. Off by default — registered disabled so it's
      // visible in the dashboard and can be toggled without an env change.
      this.cron.addJob({
        id: "self-update",
        name: "Self-update (fast-forward + restart when a new version ships)",
        enabled: /^(1|true|yes|on)$/i.test(process.env.OPENAGI_AUTO_UPDATE ?? ""),
        task: "self-update",
        dailyAt: process.env.OPENAGI_AUTO_UPDATE_AT ?? "04:30"
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
      // Story 7: evening recap. Fires at 18:00 local, builds the daily
      // recap, fires a "daily-recap" event so the Mac app can show a
      // notification that taps into chat with the recap pre-loaded.
      this.cron.addJob({
        id: "daily-recap-evening",
        name: "Daily evening recap — what did you get done today",
        enabled: true,
        task: "daily-recap",
        dailyAt: "18:00"
      });
      // Morning counterpart: "here's what I'm going to do today + what I
      // can help with." Reads calendar, pending/carried-over tasks, call
      // commitments, and goals; fires a "daily-plan" event for the Mac app.
      this.cron.addJob({
        id: "daily-plan-morning",
        name: "Daily morning plan — what you're going to do today",
        enabled: true,
        task: "daily-plan",
        dailyAt: "08:00"
      });
      // Story 9: Sunday rollup. Pulls the last 7 daily retros from
      // long-tier memory and condenses into one "week of <date>"
      // entry the observer can lean on for multi-week narrative.
      this.cron.addJob({
        id: "weekly-retrospective",
        name: "Weekly retrospective — roll up 7 daily retros",
        enabled: true,
        task: "weekly-retrospective",
        intervalMs: 7 * 24 * 60 * 60 * 1000,
        nextRunAt: nextSundayEvening().toISOString(),
        input: { agentId: "main" }
      });
      // Story 10: mid-horizon observer. Daily at 17:30 (right before
      // the evening recap so its proposals appear in today's themes).
      // Different prompt + 7-day lookback; output tagged
      // source: "weekly-observer" so the dashboard can distinguish.
      this.cron.addJob({
        id: "weekly-project-scan",
        name: "Mid-horizon observer — 7-day project threads",
        enabled: true,
        task: "weekly-project-scan",
        dailyAt: "17:30"
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
      // Calendar via secret ICS feed — env-gated on CALENDAR_ICS_URL.
      // Feeds reconciliation ("did the meeting happen?") + daily planner.
      registerCalendarIntegration(this);
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
      // Web search tools (web_search / fetch_url). Always registered; web_search
      // returns a clear "no provider configured" error until a key is set.
      registerWebSearchTools(this);
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

    // Two reasons a signal is NOT committed to memory:
    //   - an 'ignore' verdict (forgetting low-signal noise is the point) —
    //     audit-logged via the signal-ignored event;
    //   - an ephemeral turn (setup-wizard connectivity test) — a round-trip
    //     check, not lived experience.
    let memoryItem = null;
    if (scrutiny.action === "ignore") {
      this.events?.emit?.("signal-ignored", {
        at: nowIso(),
        signalId: signal.id,
        source: signal.source,
        summary: signal.summary,
        score: scrutiny.score
      });
    } else if (!options.ephemeral) {
      memoryItem = this.memory.remember(
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
    }

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

    // Ephemeral turns (setup-wizard connectivity test) leave NO trace — that
    // includes the in-memory outputs/feedback logs the dashboard reads, not
    // just durable memory. Skip recording them.
    if (!options.ephemeral) {
      this.outputs.push(output);
      this.feedback.push({
        id: createId("fb"),
        outputId: output.id,
        createdAt: nowIso(),
        loop: "outputs-to-integrations",
        summary: memoryItem
          ? `Output ${output.id} fed back into memory tier ${memoryItem.tier}.`
          : `Output ${output.id} not committed to memory (ignored).`
      });
    }

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
      if (job.task === "self-update") {
        const { applyUpdate } = await import("./self-update.js");
        const result = await applyUpdate();
        if (result.updated) {
          this.events?.emit?.("self-update", { at: nowIso(), from: result.from, to: result.to });
          // Respawn with the new code (systemd Restart=always / launchd
          // KeepAlive / Mac DaemonController bring it back). Defer so the
          // tick result can flush first.
          setTimeout(() => process.exit(0), 500);
        }
        return result;
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
      if (job.task === "daily-recap") {
        return this.runDailyRecap({ now });
      }
      if (job.task === "daily-plan") {
        return this.runDailyPlan({ now });
      }
      if (job.task === "weekly-retrospective") {
        return this.runWeeklyRetrospective({ now });
      }
      if (job.task === "weekly-project-scan") {
        if (!this.proactiveObserver?.observe) return { skipped: true, reason: "no observer" };
        const result = await this.proactiveObserver.observe({ now, mode: "long-horizon", force: true });
        this.events?.emit?.("miner-result", { source: "weekly-observer", at: nowIso(), ...result });
        return result;
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

  // Story 7: evening recap. Builds the daily recap, persists a short
  // summary to long-tier memory, fires a notification the Mac app
  // surfaces. Skipped silently if nothing happened today (the recap
  // would be empty).
  async runDailyRecap({ now = new Date() } = {}) {
    const { computeDailyRecap, renderDailyRecapMarkdown } = await import("./daily-recap.js");
    const recap = computeDailyRecap(this, { date: now });
    const total = (recap.counts.completedTasks ?? 0)
      + (recap.counts.skillRuns ?? 0)
      + (recap.counts.approvedActions ?? 0);
    if (total === 0 && (!recap.activity || (recap.activity.hoursTracked ?? 0) < 0.5)) {
      return { skipped: true, reason: "no meaningful activity today" };
    }
    const markdown = renderDailyRecapMarkdown(recap);
    // Persist to memory so tomorrow's observer has historical context.
    try {
      this.memory?.remember?.(
        {
          source: "daily-recap",
          scope: "main",
          content: markdown,
          tags: ["retro", "daily", `day-${recap.date.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`],
          kind: "daily-retrospective",
          risk: 0.5,
          repetition: 0.3,
          novelty: 0.6
        },
        { source: "daily-recap", strength: 0.7 }
      );
    } catch { /* memory write is best-effort */ }
    // Fire a notification. Mac app's notification routing already
    // handles "daily-recap" → land in chat with the recap pre-loaded.
    const headline = [
      recap.counts.completedTasks ? `${recap.counts.completedTasks} task${recap.counts.completedTasks === 1 ? "" : "s"}` : null,
      recap.counts.skillRuns ? `${recap.counts.skillRuns} skill run${recap.counts.skillRuns === 1 ? "" : "s"}` : null,
      recap.activity?.hoursTracked ? `${recap.activity.hoursTracked}h tracked` : null
    ].filter(Boolean).join(" · ");
    this.events?.emit?.("daily-recap", {
      kind: "evening",
      at: nowIso(),
      date: recap.dateISO,
      dateLabel: recap.date,
      title: `Today's recap · ${recap.date}`,
      body: headline || "Quiet day. Tap to see anyway.",
      markdown
    });
    return { fired: 1, date: recap.date, counts: recap.counts };
  }

  async runDailyPlan({ now = new Date() } = {}) {
    const { computeDailyPlan, renderDailyPlanMarkdown, queuePlanActions } = await import("./daily-planner.js");
    const plan = await computeDailyPlan(this, { date: now });
    // Skip a truly empty day rather than firing a hollow notification.
    if (plan.counts.events === 0 && plan.counts.focus === 0) {
      return { skipped: true, reason: "nothing scheduled and no pending tasks" };
    }
    // Plan → action: queue the agent's "I'll handle" items as draft-only
    // agent-queue tasks. The 30-min autopilot pulse drains them into drafts
    // for review; nothing outbound happens without approval. Only the cron
    // path queues — the read-only tool/endpoint never mutates as a side
    // effect.
    const queuedActions = queuePlanActions(this, plan);
    const markdown = renderDailyPlanMarkdown(plan);
    // Persist so the evening recap + observer can compare plan vs actual.
    try {
      this.memory?.remember?.(
        {
          source: "daily-plan",
          scope: "main",
          content: markdown,
          tags: ["plan", "daily", `day-${plan.dateISO}`],
          kind: "daily-plan",
          risk: 0.4,
          repetition: 0.3,
          novelty: 0.6
        },
        { source: "daily-plan", strength: 0.6 }
      );
    } catch { /* best-effort */ }
    const headline = [
      plan.counts.events ? `${plan.counts.events} event${plan.counts.events === 1 ? "" : "s"}` : null,
      plan.counts.focus ? `${plan.counts.focus} focus` : null,
      plan.counts.agentWillDo ? `${plan.counts.agentWillDo} I'll handle` : null
    ].filter(Boolean).join(" · ");
    this.events?.emit?.("daily-plan", {
      kind: "morning",
      at: nowIso(),
      date: plan.dateISO,
      dateLabel: plan.date,
      title: `Your day · ${plan.date}`,
      body: headline || "Open day.",
      markdown
    });
    return { fired: 1, date: plan.date, queuedActions, counts: plan.counts };
  }

  // Story 9: weekly rollup. Pulls daily retros from memory written by
  // runDailyRecap, condenses into one "week of X" entry. Without this,
  // the observer would see at most yesterday's daily — with it, the
  // observer has a continuous multi-week narrative.
  runWeeklyRetrospective({ now = new Date() } = {}) {
    if (!this.memory?.retrieve || !this.memory?.remember) {
      return { skipped: true, reason: "no memory system" };
    }
    const since = new Date(now.getTime() - 7 * 86_400_000);
    // Pull recent daily-retros via tag-based retrieval. The recall
    // memory layer does fuzzy retrieval — we accept whatever comes
    // back tagged with "retro" + "daily" since the last 7 days.
    const hits = this.memory.retrieve("daily retrospective recap", { limit: 14 });
    const daily = hits
      .map((h) => h.item ?? h)
      .filter((m) => Array.isArray(m.tags) && m.tags.includes("daily") && m.tags.includes("retro"))
      .filter((m) => new Date(m.metadata?.recordedAt ?? m.createdAt ?? 0) >= since)
      .slice(0, 7);
    if (daily.length === 0) return { skipped: true, reason: "no daily retros in last week" };
    const summary = [
      `## Week of ${now.toISOString().slice(0, 10)} (rolled up from ${daily.length} daily retros)`,
      "",
      ...daily.map((m, i) => {
        const head = (m.content ?? "").split("\n")[0] ?? "";
        return `- Day ${i + 1}: ${head.replace(/^##\s*/, "").slice(0, 200)}`;
      })
    ].join("\n");
    this.memory.remember(
      {
        source: "weekly-retrospective",
        scope: "main",
        content: summary,
        tags: ["retro", "weekly", `week-of-${now.toISOString().slice(0, 10)}`],
        kind: "weekly-retrospective",
        risk: 0.5,
        repetition: 0.3,
        novelty: 0.6
      },
      { source: "weekly-retrospective", strength: 0.75 }
    );
    return { fired: 1, daysCovered: daily.length };
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
  const dataDir = options.dataDir ?? resolveDataDir();
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
  // Apply persona.md (if present) to the main agent — name + system prompt.
  // Re-applied every boot so editing the file + restarting updates the agent.
  applyPersona(runtime, dataDir);
  // Reconnect previously-authorized MCP servers on boot, silently — servers
  // with a cached OAuth token / bearer key / stdio command come back "live"
  // instead of showing "idle" until someone clicks Connect. Never opens a
  // browser: OAuth servers without a usable token just stay idle. Non-blocking
  // and best-effort so a slow/dead server can't hold up startup.
  if (options.autoConnectMcp !== false && runtime.mcp?.connectAll) {
    Promise.resolve().then(() => runtime.mcp.connectAll({ silent: true })).catch(() => {});
  }
  return runtime;
}
