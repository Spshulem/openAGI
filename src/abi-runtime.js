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
import { registerImessageSearchTool } from "./integrations/imessage-search-tool.js";
import { createEmbedder } from "./embeddings.js";
import { McpRegistry } from "./mcp-registry.js";
import { MemoryCondenser } from "./memory-condenser.js";
import { ObservationStore } from "./observation-store.js";
import { buildAmbientDigest } from "./ambient-digest.js";
import { OutcomeStore } from "./outcome-store.js";
import { SessionIndex } from "./session-index.js";
import { Introspector } from "./introspector.js";
import { PatternMiner } from "./pattern-miner.js";
import { SessionMiner } from "./session-miner.js";
import { IMessageExtractor } from "./imessage-extractor.js";
import { TaskSweep } from "./task-sweep.js";
import { BacklogTriage, summarizeTriagePass } from "./backlog-triage.js";
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
import { ScrutinyPanel } from "./scrutiny-panel.js";
import { SpecialistRouter } from "./specialist-router.js";
import { TunnelWatcher } from "./tunnel-watcher.js";
import { VectorStore } from "./vector-store.js";
import { OutreachStore } from "./outreach-store.js";
import { OutreachMapper } from "./outreach-mapper.js";
import { loadOutreachConfig } from "./outreach-config.js";
import { surfaceStalledTasks } from "./outreach-stalled.js";
import { composeDigest, deliverDigest } from "./outreach-digest.js";
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

// B3 (docs/scope/abi-completion.md:116-127): the harsh review runs under a
// raised scrutiny act threshold (0.68 -> 0.85) so the agent must clear a
// much higher bar before acting unprompted during its own self-review turn.
const HARSH_REVIEW_SCRUTINY_OVERRIDES = { act: 0.85 };

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
    // FTS5 index over the agent's own chat transcripts, so search_sessions can
    // answer "what did we decide about X?" from the raw conversation record.
    // Lives next to the transcripts at <dataDir>/agent-host/session-index.db.
    this.sessionIndex = options.sessionIndex ?? new SessionIndex({
      dir: options.dataDir ? path.join(options.dataDir, "agent-host") : undefined,
      ...(options.sessionIndexOptions ?? {})
    });
    // When an outcome resolves, push the quality into the matching specialist's running mean.
    this.outcomes.onResolve = (outcome) => {
      const specialistId = outcome.metadata?.specialistId;
      if (specialistId && typeof outcome.qualityScore === "number") {
        this.propagation.recordOutcomeQuality?.(specialistId, outcome.qualityScore);
      }
    };
    this.outcomes.onFeedback = (outcome, previous) => {
      const specialistId = outcome.metadata?.specialistId;
      if (specialistId && typeof outcome.qualityScore === "number") {
        this.propagation.replaceOutcomeQuality?.(specialistId, previous?.previousQualityScore, outcome.qualityScore);
      }
    };
    this.embedder = options.embedder ?? createEmbedder({ budgetGuard: this.budget, ...(options.embedderOptions ?? {}) });
    this.vectorStore = options.vectorStore ?? new VectorStore({ embedder: this.embedder, ...(options.vectorStoreOptions ?? {}) });
    if (typeof this.propagation.bindVectorStore === "function") this.propagation.bindVectorStore(this.vectorStore);
    if (typeof this.memory.bindVectorStore === "function") this.memory.bindVectorStore(this.vectorStore);
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
    this.introspector = options.introspector ?? new Introspector({ runtime: this });
    this.tunnelWatcher = options.tunnelWatcher ?? new TunnelWatcher(options.tunnelWatcherOptions ?? {});
    this.patternMiner = options.patternMiner ?? new PatternMiner({ runtime: this, dataDir: options.dataDir, ...(options.patternMinerOptions ?? {}) });
    this.sessionMiner = options.sessionMiner ?? new SessionMiner({ runtime: this, dataDir: options.dataDir, ...(options.sessionMinerOptions ?? {}) });
    this.imessageExtractor = options.imessageExtractor ?? new IMessageExtractor({ runtime: this, dataDir: options.dataDir });
    this.proactiveObserver = options.proactiveObserver ?? new ProactiveObserver({ runtime: this, dataDir: options.dataDir, ...(options.proactiveObserverOptions ?? {}) });
    // Story 3: closes the suggestion → outcome → next-suggestion loop.
    // Reads resolved suggestion history + user mute preferences, feeds
    // a compact summary into the observer's system prompt each pass.
    this.suggestionFeedback = options.suggestionFeedback ?? new SuggestionFeedback({ runtime: this, dataDir: options.dataDir });
    this.tasks = options.tasks ?? new TaskStore({ runtime: this, dataDir: options.dataDir, ...(options.taskStoreOptions ?? {}) });
    // Periodic task-list hygiene: dedupe, re-home to the right queue, cancel
    // stale auto-extracted items, archive old terminal tasks.
    this.taskSweep = options.taskSweep ?? new TaskSweep({ runtime: this });
    // Weekly backlog cleanup: retires suggestions/drafts that rules or a cheap
    // model pass can show are dead, and reports what still matters. See
    // backlog-triage.js — every resolution is evidenced and reversible.
    this.backlogTriage = options.backlogTriage ?? new BacklogTriage({
      runtime: this,
      dataDir: options.dataDir,
      ...(options.backlogTriageOptions ?? {})
    });
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
    // Proactive outreach: store + mapper that turn existing runtime events
    // (drafts, suggestions, pending actions, clarifications) into a single
    // outreach feed. The event bus is late-bound by hosted-interface.js (this
    // runtime never assigns this.events in the constructor — it's defined non-
    // enumerably later), so the mapper is created here but only attaches once
    // events exist: guarded below, and re-attached via bindOutreachEvents().
    this.outreachConfig = loadOutreachConfig(options.dataDir);
    this.outreach = options.outreach ?? new OutreachStore({
      dir: options.dataDir ? path.join(options.dataDir, "outreach") : undefined,
      runtime: this
    });
    if (this.outreachConfig.enabled) {
      this.outreachMapper = new OutreachMapper({ store: this.outreach, events: this.events });
      if (this.events) this.outreachMapper.attach();
    }
    this.skillReplay = options.skillReplay ?? new SkillReplay({ runtime: this, dataDir: options.dataDir, ...(options.skillReplayOptions ?? {}) });
    this.outputs = [];
    this.feedback = [];
    // Overlap guard state for tick(): the hosted-interface ticker fires
    // every 10s without awaiting, so a slow tick must cause later fires
    // to skip instead of stacking concurrent runs of the same jobs.
    this._tickInFlight = false;
    this._tickSkips = 0;

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
      // Cadence is env-tunable: autopilot pulses carry a large prompt, so on a
      // metered model the interval is the single biggest cost lever. Default
      // 30 min; set OPENAGI_AUTOPILOT_INTERVAL_MIN to slow it (e.g. 120 = 2h).
      const autopilotMin = Number(process.env.OPENAGI_AUTOPILOT_INTERVAL_MIN) || 30;
      this.cron.addJob({
        id: "agent-pulse",
        name: `Agent autopilot — drain agent queue every ${autopilotMin} min`,
        enabled: true,
        task: "autopilot",
        intervalMs: autopilotMin * 60 * 1000,
        input: {
          agentId: "main",
          prompt: AGENT_PULSE_PROMPT,
          // Only fire (spend a base-model call) when there's queued agent work.
          requireQueuedWork: true
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
          prompt: HARSH_REVIEW_PROMPT,
          scrutinyOverrides: HARSH_REVIEW_SCRUTINY_OVERRIDES
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
      // Ambient capture is the only store in the system with unbounded growth:
      // observation-store.js documented "caller (autopilot job) prunes old rows
      // by date" and no such caller was ever registered, so a live install
      // reached 1.26 GiB of screen OCR. 05:15 is deliberately AFTER the 02:30
      // nightly miner (which reads a 28-day window) and off every other slot, so
      // retention never shares a tick with another job.
      this.cron.addJob({
        id: "observation-retention",
        name: "Daily observation retention — prune expired capture, reclaim disk",
        enabled: true,
        task: "observation-retention",
        dailyAt: "05:15"
      });
      this.cron.addJob({
        id: "weekly-scrutiny-fit",
        name: "Weekly scrutiny weight fit",
        enabled: true,
        task: "scrutiny-fit",
        intervalMs: 7 * 24 * 60 * 60 * 1000,
        nextRunAt: nextSundayMorning().toISOString()
      });
      const existingNightlyPatternJob = this.cron.listJobs().find((job) => job.id === "nightly-pattern-mine") ?? null;
      const existingHourlyPatternJob = this.cron.listJobs().find((job) => job.id === "hourly-pattern-mine") ?? null;
      this.cron.addJob({
        id: "nightly-pattern-mine",
        name: "Nightly deep activity workflow miner",
        enabled: true,
        task: "pattern-mine",
        dailyAt: "02:30",
        input: { maxCandidates: 5, mode: "deep" }
      });
      // Fast workflow-learning pass. The ambient digest above is deliberately
      // only a cheap app-count heartbeat; it does not preserve action order.
      // Run the semantic/action sequence miner separately every hour so a
      // newly repeated workflow can surface while it is still useful, while
      // retaining the nightly pass for day/week recalculation. A new job id
      // is intentional: FileBackedCronScheduler preserves existing jobs, so
      // deployed installs pick this cadence up without rewriting the user's
      // enabled/disabled choice for the nightly job.
      const configuredPatternMineMin = Number(process.env.OPENAGI_PATTERN_MINE_INTERVAL_MIN);
      const patternMineMin = Number.isFinite(configuredPatternMineMin) && configuredPatternMineMin >= 15
        ? configuredPatternMineMin
        : 60;
      this.cron.addJob({
        id: "hourly-pattern-mine",
        name: `Continuous activity workflow miner every ${patternMineMin} min`,
        // A deployed user who disabled the old miner likely did so for
        // privacy/cost reasons. Carry that preference into the new faster job
        // instead of silently re-enabling observation mining.
        enabled: existingNightlyPatternJob ? existingNightlyPatternJob.enabled !== false : true,
        task: "pattern-mine",
        intervalMs: patternMineMin * 60 * 1000,
        input: { maxCandidates: 2, mode: "continuous" }
      });
      // Once the new job exists, an explicit env setting is authoritative on
      // later boots. Preserve dashboard/manual edits when the env is absent.
      if (existingHourlyPatternJob && process.env.OPENAGI_PATTERN_MINE_INTERVAL_MIN && existingHourlyPatternJob.intervalMs !== patternMineMin * 60 * 1000) {
        this.cron.updateJob("hourly-pattern-mine", {
          name: `Continuous activity workflow miner every ${patternMineMin} min`,
          intervalMs: patternMineMin * 60 * 1000,
          input: { maxCandidates: 2, mode: "continuous" }
        });
      }
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
      // Proactive iMessage extraction: scan newly-captured texts for follow-ups,
      // events, and links. Cheap (early-returns when no new messages; nano tier
      // otherwise). Tunable via OPENAGI_IMESSAGE_EXTRACT_MIN (default 15 min).
      const extractMin = Number(process.env.OPENAGI_IMESSAGE_EXTRACT_MIN) || 15;
      this.cron.addJob({
        id: "imessage-extract",
        name: `iMessage extraction — surface follow-ups/events/links every ${extractMin} min`,
        enabled: true,
        task: "imessage-extract",
        intervalMs: extractMin * 60 * 1000
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
      // Task-list hygiene — dedupe, re-home to the right queue (agent vs
      // user), cancel stale auto-extracted items, archive old terminal
      // tasks. Tunable via OPENAGI_TASK_SWEEP_MIN (default 60 min).
      const sweepMin = Number(process.env.OPENAGI_TASK_SWEEP_MIN) || 60;
      this.cron.addJob({
        id: "task-sweep",
        name: `Task-list hygiene — dedupe / re-home / archive every ${sweepMin} min`,
        enabled: true,
        task: "task-sweep",
        intervalMs: sweepMin * 60 * 1000
      });
      // Daily deterministic cleanup drains legacy duplicate/dead suggestions
      // in bounded reversible passes. BacklogTriage caps and budget-bounds the
      // daily LLM judgement phase so a legacy queue drains without an
      // unbounded spend. 05:45 stays clear of observation retention
      // and the nightly miners, then lands before the morning plan reads the
      // review queue.
      const existingBacklogTriageJob = this.cron.listJobs().find((job) => job.id === "backlog-triage") ?? null;
      this.cron.addJob({
        id: "backlog-triage",
        name: "Daily backlog hygiene — retire duplicates and review relevance",
        enabled: true,
        task: "backlog-triage",
        dailyAt: "05:45"
      });
      // FileBackedCronScheduler preserves existing rows. Upgrade the old
      // weekly default without changing a user's enabled/disabled choice.
      if (existingBacklogTriageJob?.intervalMs === 7 * 24 * 60 * 60 * 1000) {
        this.cron.updateJob("backlog-triage", {
          name: "Daily backlog hygiene — retire duplicates and review relevance",
          intervalMs: null,
          dailyAt: "05:45",
          ...(existingBacklogTriageJob.enabled ? {} : { nextRunAt: null })
        });
      }
      this.cron.addJob({
        id: "outreach-digest",
        name: `Outreach digest every ${this.outreachConfig.cadenceHours}h`,
        enabled: this.outreachConfig.enabled,
        task: "outreach-digest",
        intervalMs: this.outreachConfig.cadenceHours * 60 * 60 * 1000
      });
      // G1: hourly rollup of the ambient observation stream into ONE ABI
      // signal (see runAmbientDigest). Deterministic, no LLM, and quiet when
      // idle — buildAmbientDigest returns null when the window has no
      // activity rows, so an idle machine produces no signal and no memory
      // write.
      this.cron.addJob({
        id: "ambient-digest",
        name: "Hourly ambient observation digest",
        enabled: true,
        task: "ambient-digest",
        intervalMs: 60 * 60 * 1000
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
      // search_imessages — only when an iMessage node (a Mac running
      // `openagi imessage-server`) is configured via OPENAGI_IMESSAGE_NODE.
      registerImessageSearchTool(this);
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
      context: this.context,
      overrides: signal.scrutinyOverrides ?? {}
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
    // Skip, don't stack: if a previous tick is still awaiting (slow LLM call
    // inside a cron job), this fire returns immediately. Log once per skip
    // streak so a wedged tick is visible without spamming a line every 10s.
    if (this._tickInFlight) {
      this._tickSkips += 1;
      if (this._tickSkips === 1) {
        console.warn("[openagi] cron tick still in flight — skipping overlapping tick(s) until it finishes");
      }
      return [];
    }
    this._tickInFlight = true;
    try {
      return await this._tickOnce(now);
    } finally {
      this._tickInFlight = false;
      this._tickSkips = 0;
    }
  }

  async _tickOnce(now = new Date()) {
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

    return this.cron.runDue((job) => this.runJobTask(job, now), now, {
      onTimeout: (job, timeoutMs) => {
        this.events?.emit?.("cron-job-timeout", {
          at: nowIso(),
          jobId: job.id,
          jobName: job.name,
          timeoutMs
        });
      },
      onBudgetExceeded: (job, budgetMs) => {
        // The fire ran out of wall clock before reaching this job. It stays
        // due and runs on the next tick — say so rather than let the schedule
        // quietly slip.
        this.events?.emit?.("cron-tick-budget", {
          at: nowIso(),
          deferredJobId: job.id,
          deferredJobName: job.name,
          budgetMs
        });
      }
    });
  }

  // The single dispatch table for a cron job's task. Shared by the tick
  // (_tickOnce) and by a user-initiated run (POST /cron/:id/run). It used to
  // live inline in the runDue callback, which meant the manual route had no
  // access to it: that route special-cased task==="autopilot" and sent
  // EVERYTHING else to runScheduledPrompt(), so "Run now" on backlog-triage
  // fired an agent chat turn with the text "(empty scheduled prompt)" and
  // never called backlogTriage.run(). One table, both callers.
  async runJobTask(job, now = new Date()) {
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
    if (job.task === "observation-retention") {
      const { pruneObservations } = await import("./observation-retention.js");
      // job.input is the override surface: { dryRun }, { policy }, { reclaim }.
      // Spread after `now` so a job row can pin a clock in a test but the
      // scheduled row (input {}) uses the tick's clock.
      const result = await pruneObservations(this.observations, {
        now,
        logger: (line) => console.log(`[openagi] ${line}`),
        // Whole-file VACUUM is synchronous in node:sqlite. On a mature capture
        // database it can block /health long enough for the Mac supervisor to
        // restart the daemon, after which catch-up retries the same job and
        // creates a permanent restart loop. Scheduled retention still deletes
        // expired rows (SQLite reuses those pages); explicit maintenance can
        // request full/incremental compaction through job.input or the admin
        // retention route where the user can see the operation in progress.
        reclaim: "none",
        ...(job.input ?? {})
      });
      this.events?.emit?.("observation-retention", {
        at: nowIso(),
        applied: result.applied,
        deleted: result.deleted,
        cutoffs: result.cutoffs,
        bytesAfter: result.footprint?.bytes ?? null,
        reclaimedBytes: result.reclaim?.reclaimedBytes ?? 0
      });
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
    if (job.task === "pattern-mine") {
      const result = await this.patternMiner.mine({ now, ...(job.input ?? {}) });
      this.events?.emit?.("miner-result", { source: "pattern-miner", at: nowIso(), ...result });
      return result;
    }
    if (job.task === "session-mine") {
      const result = await this.sessionMiner.mine({ now });
      this.events?.emit?.("miner-result", { source: "session-miner", at: nowIso(), ...result });
      return result;
    }
    if (job.task === "imessage-extract") {
      const result = await this.imessageExtractor.extract();
      this.events?.emit?.("miner-result", { source: "imessage-extractor", at: nowIso(), ...result });
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
    if (job.task === "task-sweep") {
      const result = await this.taskSweep.sweep({ now });
      if (this.outreachConfig?.enabled && Array.isArray(result.flaggedTasks)) {
        surfaceStalledTasks(this.outreach, result.flaggedTasks);
      }
      this.events?.emit?.("miner-result", { source: "task-sweep", at: nowIso(), ...result });
      return result;
    }
    if (job.task === "backlog-triage") {
      // run() is written never to throw — everything that can fail lands in
      // result.degraded — so this handler needs no try/catch of its own and a
      // bad pass can never turn the scheduler into a crash loop.
      // Input spreads FIRST so the dashboard can set { dryRun: true } or
      // { useLLM: false } on the job — but never `now`, which is the
      // scheduler's to supply.
      const result = await this.backlogTriage.run({ ...(job.input ?? {}), now });
      const summary = summarizeTriagePass(result);
      this.events?.emit?.("miner-result", { source: "backlog-triage", at: nowIso(), ...summary });
      return summary;
    }
    if (job.task === "outreach-digest") {
      return this.runOutreachDigest({ now });
    }
    if (job.task === "ambient-digest") {
      return this.runAmbientDigest({ now });
    }
    return { skipped: true, reason: `No handler for task ${job.task}` };
  }

  // Late-bind the event bus to the outreach mapper. hosted-interface.js owns
  // the bus and calls this (like pendingActions.bindEvents) once it exists, so
  // the mapper can subscribe even though it was constructed before the bus.
  bindOutreachEvents(events) {
    if (!this.outreachConfig?.enabled || !events) return;
    if (!this.outreachMapper) {
      this.outreachMapper = new OutreachMapper({ store: this.outreach, events });
    } else {
      this.outreachMapper.events = events;
    }
    this.outreachMapper.attach();
  }

  async runOutreachDigest({ now = new Date() } = {}) {
    if (!this.outreachConfig?.enabled) return { skipped: true, reason: "outreach disabled" };
    const item = composeDigest(this.outreach, this.outreachConfig, { now });
    if (!item) return { ok: true, empty: true };
    // Destination routing: "mac" keeps the status quo (the item is already in
    // the outreach store, which the Mac app consumes); "telegram"/"both" also
    // push the digest text to every allowlisted chat, falling back to
    // mac-only with a logged warning when telegram isn't ready. this.channels
    // is assigned by ChannelManager's constructor (src/channels.js) when the
    // hosted interface builds it.
    const delivery = await deliverDigest(item, {
      destination: this.outreachConfig.destination,
      telegram: this.channels?.telegram ?? null
    });
    return { ok: true, digestId: item.id, title: item.title, delivery };
  }

  // G1 fix: the core severed hop. Roll the last hour of ambient observations
  // into ONE deterministic ABI signal (no LLM) so the capture stream flows
  // through Signals→Scrutiny→Memory instead of sitting inert in the side
  // SQLite store. Axes are measured, not template constants: repetition
  // grows with how often this domain's digest recurred in the last 7 days,
  // novelty is its complement. Expected steady state: scrutiny verdicts stay
  // mid-band (watch/ask) and the digest absorbs into tiered memory — only an
  // ignore verdict skips memory. Act/propagate emerges from repetition alone
  // (propagate needs pressure >= 0.72, i.e. ~11 same-domain digests in 7d).
  async runAmbientDigest({ now = new Date() } = {}) {
    const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
    const digest = await buildAmbientDigest({
      observations: this.observations,
      sinceMs: nowMs - 60 * 60 * 1000,
      nowMs
    });
    if (!digest) return { skipped: true, reason: "no activity in window" };
    const rawRepetition = Math.min(1, this.countAmbientMemories(digest.domain, nowMs) / 14);
    const repetition = Number(rawRepetition.toFixed(3));
    const novelty = Number((1 - rawRepetition).toFixed(3));
    const outputs = this.processIntegrationEvent("abi", {
      source: "ambient-digest",
      type: "ambient-capture",
      domain: digest.domain,
      taskType: "ambient-capture",
      summary: digest.summary,
      content: digest.summary,
      tags: ["ambient", "digest"],
      urgency: 0.2,
      impact: 0.4,
      novelty,
      repetition,
      risk: 0.1,
      confidence: 0.7,
      specificity: 0.6,
      metadata: { stats: digest.stats }
    });
    const output = outputs[0] ?? null;
    return { fired: 1, domain: digest.domain, action: output ? output.action : null, repetition };
  }

  // Repetition denominator for ambient digests: memory items prior digests
  // left behind for this domain in the last 7 days. Chosen over the outcome
  // store because processSignal writes a memory item tagged with the signal's
  // domain + taskType but records nothing in the OutcomeStore — memory is the
  // only durable trace prior digests leave, and iterating the in-RAM items
  // Map (present on MemorySystem and FileBackedMemorySystem alike) is
  // O(items) with zero I/O.
  countAmbientMemories(domain, nowMs) {
    if (!this.memory?.items) return 0;
    const since = nowMs - 7 * 24 * 60 * 60 * 1000;
    let count = 0;
    for (const item of this.memory.items.values()) {
      if (!Array.isArray(item.tags)) continue;
      if (!item.tags.includes("ambient-capture") || !item.tags.includes(domain)) continue;
      const createdMs = new Date(item.createdAt).getTime();
      if (Number.isFinite(createdMs) && createdMs >= since) count += 1;
    }
    return count;
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
    // Persist BEFORE the skip guard. GET /plan/daily re-runs the LLM on every
    // request, so the Quick Ask brief can never call it — it reads this cache
    // instead. A thin day must still leave an artifact, otherwise the brief
    // has no plan to pin all day. The guard below suppresses only the
    // notification, never the cache write.
    try {
      const { writeJsonAtomic } = await import("./file-utils.js");
      // AbiRuntime carries no dataDir property of its own — resolveDataDir()
      // is the single source of truth for where state lives, and it is what
      // the reader resolves to as well (hosted-interface.js resolves it once
      // and threads it into composeBrief). Resolving it here rather than
      // reading some per-instance field is what keeps writer and reader
      // pointed at the same directory. writeJsonAtomic creates the parent
      // directory itself, so there is no mkdir to do first.
      const dir = path.join(resolveDataDir(), "plan");
      writeJsonAtomic(path.join(dir, `${plan.dateISO}.json`), {
        ...plan,
        cachedAt: new Date().toISOString()
      });
    } catch (error) {
      console.warn(`[openagi] daily plan cache write failed: ${error.message}`);
    }
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
    // Cheap gate (no tokens): a queue-draining pulse must NOT spend a base-model
    // call when there's nothing committed to do. Jobs opt in via
    // input.requireQueuedWork; scheduled review prompts (weekly-harsh-review)
    // leave it off and run unconditionally. This is the "react only to new work"
    // rule — the agent wakes only when agentPickNext has a real task.
    if (job.input?.requireQueuedWork && !this.tasks?.agentPickNext?.()) {
      return { skipped: true, reason: "no queued agent work" };
    }
    try {
      this.budget.check();
    } catch (error) {
      return { skipped: true, reason: error.message };
    }
    const input = job.input ?? {};
    const sessionId = input.sessionId ?? `autopilot:${job.id}`;
    const prompt = input.prompt ?? AUTOPILOT_DEFAULT_PROMPT;
    // B3: the harsh review runs under a raised act threshold. Cron stores
    // persisted before this field existed keep their old saved input
    // (CronScheduler.addJob returns the existing row), so fall back by job
    // id — an already-deployed weekly-harsh-review still gets the bar.
    const scrutinyOverrides = input.scrutinyOverrides
      ?? (job.id === "weekly-harsh-review" ? HARSH_REVIEW_SCRUTINY_OVERRIDES : null);
    const result = await this.agentHost.handleMessage({
      channel: "autopilot",
      from: "autopilot",
      agentId: input.agentId ?? "main",
      sessionId,
      text: prompt,
      scrutinyOverrides,
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

  reconcilePrincipleVectors() {
    if (!this.vectorStore || !this.memory?.items) return { checked: 0, removed: 0 };
    const entries = this.vectorStore.list("principle");
    let removed = 0;
    for (const entry of entries) {
      const item = this.memory.items.get(entry.id);
      if (!item || item.metadata?.supersededBy) {
        this.vectorStore.delete("principle", entry.id);
        removed += 1;
      }
    }
    if (removed > 0) {
      console.log(`[openagi] principle-vector reconcile: removed ${removed} of ${entries.length} vectors (orphaned or superseded)`);
    }
    return { checked: entries.length, removed };
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
  // First boot / backfill: when the session index is empty (missing DB, or a
  // DB file created empty), seed it from the transcripts already on disk.
  // Non-blocking and best-effort so a large history can't hold up startup;
  // indexMessage dedupes by message id, so overlap with live appends during
  // the walk is safe. The promise is kept on the index so tests can await it.
  if (runtime.agentHost && runtime.sessionIndex) {
    runtime.sessionIndex.rebuildPromise = Promise.resolve()
      .then(async () => {
        const s = await runtime.sessionIndex.stats();
        if (s.messages > 0) return { skipped: true, reason: "index already populated" };
        return runtime.sessionIndex.rebuildFromTranscripts(runtime.agentHost.store);
      })
      .catch(() => {});
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
  runtime.reconcilePrincipleVectors();
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
