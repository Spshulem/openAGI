// Proactive observer — runs every ~10 minutes, looks at what the user has
// been doing (recent apps + OCR snippets + chat sessions), and asks the LLM
// to propose ONE concrete next thing the agent could do for them. Output
// goes to .openagi/proactive/suggestions/ and fires a "proactive-suggestion"
// SSE event so the dashboard + Mac notification surface it.
//
// Different from pattern-miner / session-miner:
//   - Runs at a faster cadence (10 min, not nightly)
//   - Asks for ONE suggestion, not clusters of N
//   - Cross-references the MCP catalog so it can suggest "connect Linear's
//     MCP" not just "build a skill that calls Linear"
//   - Returns category-tagged proposals: skill / mcp / automation / pass

import path from "node:path";
import fs from "node:fs";
import { ensureDir, writeJsonAtomic, readJsonFile } from "./file-utils.js";
import { createId, nowIso } from "./utils.js";
import { matchCatalog } from "./mcp-catalog.js";
import { buildReconciliationCalibration } from "./reconciliation-calibration.js";
import { resolveDataDir } from "./data-dir.js";

const SUGGEST_DIR = "proactive/suggestions";
const DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h — don't repeat the same proposal within a 6h window
const MIN_INTERVAL_MS = 8 * 60 * 1000;        // back off if we just ran (handles overlapping cron + dispatch)
const MIN_SNIPPETS = 2;                       // need real activity, not silence

// Story 10: long-horizon system prompt. Same JSON output schema as the
// default observer, different framing — looking across days, not minutes.
// Emphasizes stalled threads, multi-day projects, follow-ups that have
// gone cold. Surfaced as source: "weekly-observer" via persist().
const LONG_HORIZON_SYSTEM_PROMPT = [
  "You are OpenAGI's long-horizon observer. The user gave you screen-capture access; you can see ~7 days of their app activity and OCR text.",
  "Your job: spot ONE multi-day thread worth surfacing. Stalled work, half-finished projects, follow-ups that went cold, a ticket they opened Tuesday and haven't touched since. Be useful or stay silent.",
  "Output STRICT JSON, one of these shapes:",
  '  {"pass": true, "reason": "<short>"}                                           // nothing multi-day worth surfacing',
  '  {"category": "task", "title": "<short>", "rationale": "<why>", "queue": "user"|"agent", "bucket": "today"|"this_week"|"someday"}    // a follow-up that needs to happen',
  '  {"category": "skill", "title": "<short>", "rationale": "<why>", "draftBody": "<markdown body>"}',
  '  {"category": "knowledge", "title": "<short>", "rationale": "<why>"}',
  "Be specific. Reference the actual thread: the ticket / branch / channel / person you saw recurring.",
  "Don't surface single-occurrence activity — the regular 10-min observer handles that. Only surface things that span at least 2 days or have a stalled-momentum quality."
].join("\n");

const SYSTEM_PROMPT = [
  "You are OpenAGI's proactive observer. The user gave you screen-capture access; you can see what apps they used and what OCR text was on screen in the last ~10 minutes.",
  "Your job: propose ONE concrete next thing the agent could do for them. Be useful or stay silent.",
  "Output STRICT JSON, one of these shapes:",
  '  {"pass": true, "reason": "<short>"}                                           // nothing actionable yet',
  '  {"category": "task", "title": "<short>", "rationale": "<why>", "queue": "user"|"agent", "bucket": "today"|"this_week"|"someday"}    // a clear todo item',
  '  {"category": "skill", "title": "<short>", "rationale": "<why>", "draftBody": "<markdown body>"}',
  '  {"category": "mcp", "title": "Connect <name> MCP", "rationale": "<why>", "mcpId": "<catalog id>"}    // only when MCP is in the candidate list',
  '  {"category": "automation", "title": "<short>", "rationale": "<why>", "steps": ["<action 1>", "<action 2>"]}',
  '  {"category": "knowledge", "title": "<short>", "rationale": "<why>"}',
  "Be specific. Reference actual content (branch names, ticket numbers, channel names) you saw in the OCR snippets. Don't quote them verbatim — refer naturally.",
  "Prefer 'task' for concrete one-off todos (a PR they need to review, an email to send, a ticket to follow up on). Prefer 'skill' for repeatable routines.",
  "Be honest: if the activity is too generic / one-off / mid-task to suggest anything good, just pass."
].join("\n");

export class ProactiveObserver {
  constructor(options = {}) {
    this.runtime = options.runtime;
    this.dataDir = options.dataDir ?? resolveDataDir();
    this.suggestDir = path.join(this.dataDir, SUGGEST_DIR);
    this.lookbackMinutes = options.lookbackMinutes ?? 15;
    this.lastRunAt = 0;
    ensureDir(this.suggestDir);
  }

  /**
   * Run one observer pass. Returns { suggested, skipped, reason } summary.
   */
  async observe({ now = new Date(), force = false, mode = "default" } = {}) {
    if (!force && Date.now() - this.lastRunAt < MIN_INTERVAL_MS) {
      return { skipped: true, reason: "rate-limited" };
    }
    this.lastRunAt = Date.now();

    if (!this.runtime?.observations?.getRecentContext) {
      return { skipped: true, reason: "no observation store" };
    }

    // Story 10: mid-horizon mode looks back 7 days and emphasizes
    // multi-day project threads + stalled work, rather than the
    // 15-minute "what's happening right now" pass.
    const isLongHorizon = mode === "long-horizon";
    const lookbackMinutes = isLongHorizon ? 7 * 24 * 60 : this.lookbackMinutes;
    const maxSnippets = isLongHorizon ? 20 : 8;
    const maxChars = isLongHorizon ? 5000 : 2000;
    const ctx = await this.runtime.observations.getRecentContext({
      minutes: lookbackMinutes,
      maxChars,
      maxSnippets
    });

    if ((ctx.snippets?.length ?? 0) < MIN_SNIPPETS) {
      return { skipped: true, reason: "insufficient activity (capture off or idle)" };
    }

    // What MCPs is the user already connected to? Don't suggest those.
    const registered = new Set();
    for (const s of this.runtime.mcp?.listServers?.() ?? []) {
      registered.add((s.name ?? "").toLowerCase());
      if (s.connected) registered.add(s.name);
    }

    // Cross-reference the catalog. If something fires, the LLM proposal can
    // pick it up and use it as a real suggestion.
    const candidates = matchCatalog(ctx.apps ?? [], ctx.snippets ?? [], registered);

    // Provide one chat-session breadcrumb so the observer can also propose
    // skills based on recurring chat asks (not just screen activity).
    const recentSession = this.recentSessionExcerpt();

    const provider = this.runtime.agentHost?.modelProvider;
    if (!provider?.isConfigured?.() || provider.constructor.name === "DeterministicModelProvider") {
      // No real LLM — fall back to the cheapest signal we have: if the
      // catalog matched something, propose that without LLM rationale.
      if (candidates.length > 0) {
        const c = candidates[0];
        return this.persist({
          source: "proactive-observer",
          category: "mcp",
          title: `Connect the ${c.entry.name} MCP`,
          rationale: `Detected ${c.trigger}. ${c.entry.description}`,
          mcpId: c.entry.id,
          mcpRegister: c.entry.register,
          context: ctx,
          status: "pending"
        });
      }
      return { skipped: true, reason: "no LLM provider + nothing in catalog matched" };
    }

    const prompt = this.buildPrompt(ctx, candidates, recentSession);
    let raw;
    // Story 3: prepend the user's recent preference signal to the system
    // prompt so the observer learns from accept/reject history instead
    // of proposing the same shape of thing repeatedly. Null when there
    // aren't enough samples yet (first ~3 interactions teach nothing).
    const preferenceLine = this.runtime?.suggestionFeedback?.preferenceSummary?.() ?? null;
    // Story 9: prepend the last 3 daily retros + last 2 weekly retros
    // from long-tier memory so the observer sees beyond the 15-minute
    // OCR window — multi-day narrative context for "is this part of a
    // larger thread?" reasoning.
    const retroBlock = composeRetroContext(this.runtime);
    let instructions = isLongHorizon ? LONG_HORIZON_SYSTEM_PROMPT : SYSTEM_PROMPT;
    if (retroBlock) instructions += "\n\n" + retroBlock;
    if (preferenceLine) instructions += "\n\n" + preferenceLine;

    try {
      const result = await provider.generate({
        input: prompt,
        task: "observer",
        agent: { id: "proactive-observer", name: "proactive-observer" },
        memoryHits: [],
        messages: [],
        tools: [],
        toolRegistry: null,
        instructions,
        context: {}
      });
      raw = result.text ?? "";
    } catch (err) {
      return { skipped: true, reason: `llm error: ${err.message ?? String(err)}` };
    }

    const proposal = parseProposal(raw);
    if (!proposal || proposal.pass === true) {
      return { skipped: true, reason: proposal?.reason ?? "no proposal" };
    }
    // Story 3: respect user-muted categories absolutely — even if the
    // observer's LLM proposes one, we silently drop it rather than
    // surface a card the user said they didn't want.
    if (proposal.category && this.runtime?.suggestionFeedback?.isMuted?.(proposal.category)) {
      return { skipped: true, reason: `category '${proposal.category}' is muted by user preference` };
    }

    if (this.alreadyProposedRecently(proposal, now)) {
      return { skipped: true, reason: "duplicate of recent proposal" };
    }

    // If the LLM proposed an MCP but didn't reference a catalog id, decline.
    // Forces concrete suggestions; avoids hallucinated "Connect FooBar MCP".
    if (proposal.category === "mcp") {
      const matchedCatalog = candidates.find((c) => c.entry.id === proposal.mcpId);
      if (!matchedCatalog) {
        return { skipped: true, reason: "MCP not in catalog" };
      }
      proposal.mcpRegister = matchedCatalog.entry.register;
    }

    return this.persist({
      source: isLongHorizon ? "weekly-observer" : "proactive-observer",
      category: proposal.category,
      title: proposal.title,
      rationale: proposal.rationale,
      mcpId: proposal.mcpId ?? null,
      mcpRegister: proposal.mcpRegister ?? null,
      draftBody: proposal.draftBody ?? null,
      steps: proposal.steps ?? null,
      taskQueue: proposal.queue ?? "user",
      taskBucket: proposal.bucket ?? "today",
      context: { apps: ctx.apps?.slice(0, 5) ?? [], snippetCount: ctx.snippets?.length ?? 0, mode },
      status: "pending"
    });
  }

  recentSessionExcerpt() {
    const store = this.runtime?.agentHost?.store;
    if (!store?.listSessions) return null;
    const sessions = store.listSessions().slice(0, 1);
    if (sessions.length === 0) return null;
    const full = store.getSession(sessions[0].id) ?? sessions[0];
    const userMessages = (full.messages ?? [])
      .filter((m) => m.role === "user" && typeof m.content === "string")
      .slice(-3)
      .map((m) => m.content.slice(0, 150));
    return userMessages.length > 0 ? userMessages : null;
  }

  buildPrompt(ctx, candidates, recentSession) {
    const lines = [
      `What I observed in the last ${this.lookbackMinutes} minutes:`,
      "",
      "Top apps:",
      ...(ctx.apps ?? []).slice(0, 5).map((a) => `  - ${a.app} (${a.n} focus events)`),
      "",
      "Recent OCR snippets:",
      ...(ctx.snippets ?? []).slice(0, 8).map((s) => `  - [${s.app}] ${s.text}`)
    ];
    if (candidates.length > 0) {
      lines.push("", "MCP servers from the catalog that match this activity (use these for category=mcp suggestions, never invent ids):");
      for (const c of candidates) {
        lines.push(`  - id=${c.entry.id} · ${c.entry.name} · trigger: ${c.trigger}`);
        lines.push(`    "${c.entry.description}"`);
      }
    }
    // Existing tasks so the LLM doesn't propose duplicates.
    const recentTasks = (this.runtime?.tasks?.list?.({ status: "pending", limit: 12 }) ?? [])
      .map((t) => `  - [${t.queue}/${t.bucket}] ${t.title}`);
    if (recentTasks.length > 0) {
      lines.push("", "User's existing pending tasks (don't re-propose these):", ...recentTasks);
    }
    if (recentSession) {
      lines.push("", "Recent things the user typed in chat:");
      for (const m of recentSession) lines.push(`  - "${m}"`);
    }
    lines.push("", "Propose ONE concrete next thing — or pass.");
    return lines.join("\n");
  }

  alreadyProposedRecently(proposal, now = new Date()) {
    try {
      const sinceMs = now.getTime() - DEDUPE_WINDOW_MS;
      const files = fs.readdirSync(this.suggestDir);
      for (const f of files) {
        const json = readJsonFile(path.join(this.suggestDir, f), null);
        if (!json) continue;
        const ts = Date.parse(json.proposedAt ?? "");
        if (!Number.isFinite(ts) || ts < sinceMs) continue;
        if (proposal.category === "mcp" && json.mcpId === proposal.mcpId) return true;
        if (proposal.title && json.title === proposal.title) return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  persist(record) {
    const id = createId("prop");
    const candidate = {
      id,
      proposedAt: nowIso(),
      ...record
    };
    // Proposal-first: task suggestions surface as suggestion cards (notification
    // + Suggestions tab) for the user to accept, like every other category —
    // accepting materializes the task (hosted-interface accept endpoint).
    // OPENAGI_AUTO_TASKS=1 restores the old behavior of silently creating the
    // task the moment the observer proposes it.
    const autoCreate = process.env.OPENAGI_AUTO_TASKS === "1";
    const task = autoCreate ? materializeTaskFromSuggestion(this.runtime, candidate) : null;
    if (task) {
      candidate.status = "accepted";
      candidate.resolvedAt = nowIso();
      candidate.taskId = task.id;
      candidate.taskAutoCreated = true;
      candidate.note = "Auto-created task from proactive observer (OPENAGI_AUTO_TASKS=1).";
    }
    writeJsonAtomic(path.join(this.suggestDir, `${id}.json`), candidate);
    if (task) {
      this.runtime?.events?.emit?.("task-reminder", {
        kind: "created",
        at: nowIso(),
        taskId: task.id,
        queue: task.queue,
        bucket: task.bucket,
        title: `Task added: ${task.title}`,
        body: task.description ? task.description.slice(0, 200) : ""
      });
    } else {
      this.runtime?.events?.emit?.("proactive-suggestion", {
        id,
        category: candidate.category,
        title: candidate.title,
        rationale: candidate.rationale,
        mcpId: candidate.mcpId
      });
    }
    return { suggested: 1, candidate };
  }

  materializeTaskSuggestion(candidate) {
    return materializeTaskFromSuggestion(this.runtime, candidate);
  }

  list({ status = "pending" } = {}) {
    try {
      return fs.readdirSync(this.suggestDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => readJsonFile(path.join(this.suggestDir, f), null))
        .filter(Boolean)
        .filter((c) => !status || c.status === status)
        .sort((a, b) => (b.proposedAt ?? "").localeCompare(a.proposedAt ?? ""));
    } catch { return []; }
  }

  resolve(id, status, note = null) {
    const file = path.join(this.suggestDir, `${id}.json`);
    const candidate = readJsonFile(file, null);
    if (!candidate) return null;
    candidate.status = status;
    candidate.resolvedAt = nowIso();
    if (note) candidate.note = note;
    writeJsonAtomic(file, candidate);
    return candidate;
  }
}

// Scan recent activity against pending tasks and decide whether any
// should be auto-completed (e.g. user shipped the PR they had as a
// task) or moved to in_progress (e.g. user is actively on the ticket).
//
// Conservative thresholds — auto-complete only at high confidence,
// move-to-in-progress at medium. Everything is logged via task-updated
// SSE events so the user sees what we did and can revert.
const TASK_SCAN_SYSTEM_PROMPT = [
  "You review the user's pending tasks against multiple EVIDENCE SOURCES, each tagged with a provenance label:",
  "  [ocr] — what was recently on their screen (apps + OCR text).",
  "  [rize] — time actually tracked today: categories, projects, and session titles. Tells you WHERE they spent time.",
  "  [buildbetter] — recent call topics, for context on whether a task is still live or was superseded.",
  "  [calendar] — scheduled events that already occurred today; a meeting that happened corroborates a 'meet/sync/call X' task.",
  "For each task, decide if there's STRONG evidence it just got done ('complete'), or that the user is actively working on it ('in_progress').",
  "Weigh CORROBORATION: when two or more independent sources point the same way (e.g. [ocr] shows a merged PR AND [rize] logged 2h in the matching project), be more confident. When sources disagree or only one weak signal exists, stay conservative and lower confidence.",
  "Output STRICT JSON: {\"updates\": [{\"taskId\": \"...\", \"action\": \"complete\"|\"in_progress\", \"confidence\": 0-1, \"evidence\": \"<short>\", \"sources\": [\"ocr\"|\"rize\"|\"buildbetter\"|\"calendar\"]}]} — empty updates array is fine.",
  "'complete' requires explicit evidence (PR merged, ticket closed, message sent). 'in_progress' requires active work (editor open, commits being made, in a related call, or significant tracked time in a matching project).",
  "Never propose an update without citing specific evidence — quote a fragment and list which source(s) support it in the 'sources' array. Time tracked alone ([rize] only) is 'in_progress' at most, not 'complete'."
].join("\n");

// Assemble a multi-source evidence bundle for task reconciliation. Each
// source is gathered independently and try/caught so one failing or
// unconfigured source can't sink the whole scan. Returns
// { ocr, rize, buildbetter } where any field may be null when that
// source is unavailable.
//
// Why multiple sources: a single signal (screen OCR) is noisy — you might
// have a doc open without finishing it. Corroboration across "what was on
// screen" (OCR), "where you actually spent time" (Rize), and "what you
// discussed on calls" (BuildBetter) lets the model auto-complete with far
// higher confidence, and lets it stay conservative when sources disagree.
ProactiveObserver.prototype.gatherReconciliationEvidence = async function ({ now = new Date() } = {}) {
  const evidence = { ocr: null, rize: null, buildbetter: null, calendar: null };

  // Source 1: on-screen activity (OCR) — the original signal.
  try {
    if (this.runtime?.observations?.getRecentContext) {
      evidence.ocr = await this.runtime.observations.getRecentContext({
        minutes: 30,
        maxChars: 2400,
        maxSnippets: 10
      });
    }
  } catch {
    /* one bad source shouldn't sink the scan */
  }

  // Source 2: Rize time-tracking. We invoke the already-registered tools
  // rather than importing RizeClient — so this is a clean no-op when
  // RIZE_API_KEY isn't set (the tools simply aren't on the registry).
  try {
    const summaryTool = this.runtime?.tools?.get?.("rize_today_summary");
    const sessionsTool = this.runtime?.tools?.get?.("rize_recent_sessions");
    if (summaryTool?.handler || sessionsTool?.handler) {
      const [summary, sessions] = await Promise.all([
        summaryTool?.handler ? summaryTool.handler({}).catch(() => null) : null,
        sessionsTool?.handler ? sessionsTool.handler({ limit: 12 }).catch(() => null) : null
      ]);
      if (summary || (Array.isArray(sessions) && sessions.length)) {
        evidence.rize = { summary: summary ?? null, sessions: Array.isArray(sessions) ? sessions : [] };
      }
    }
  } catch {
    /* ignore */
  }

  // Source 3: recent BuildBetter call topics, read off already-synced
  // BuildBetter-sourced tasks (cheap — no extra API call). Gives the model
  // context on what was discussed on calls in the last few days, so it can
  // tell whether a task is still live, was superseded, or was mentioned as
  // already handled. (Transcript-level "I confirmed I sent it" matching is
  // a richer follow-up that needs a BuildBetter transcript query.)
  try {
    const sinceMs = now.getTime() - 3 * 86_400_000;
    const bb = (this.runtime?.tasks?.list?.({ limit: 200 }) ?? [])
      .filter((t) => t.source === "buildbetter")
      .filter((t) => Date.parse(t.sourceMeta?.callStartedAt ?? t.createdAt ?? 0) >= sinceMs)
      .slice(0, 12)
      .map((t) => ({
        summary: t.title,
        callName: t.sourceMeta?.callName ?? null,
        at: t.sourceMeta?.callStartedAt ?? t.createdAt,
        types: t.sourceMeta?.extractionTypes ?? []
      }));
    if (bb.length) evidence.buildbetter = bb;
  } catch {
    /* ignore */
  }

  // Source 4: today's calendar. A scheduled event that occurred is strong
  // corroboration that a "meet/sync/call X" task happened. No-op when
  // CALENDAR_ICS_URL isn't set (tool absent).
  try {
    const calTool = this.runtime?.tools?.get?.("calendar_today_events");
    if (calTool?.handler) {
      const events = await calTool.handler({}).catch(() => null);
      if (Array.isArray(events) && events.length) {
        // Only events that have already started by `now` count as "occurred".
        const nowMs = now.getTime();
        evidence.calendar = events
          .filter((e) => +new Date(e.start) <= nowMs)
          .slice(0, 12)
          .map((e) => ({ summary: e.summary, start: e.start, end: e.end, status: e.status }));
        if (!evidence.calendar.length) evidence.calendar = null;
      }
    }
  } catch {
    /* ignore */
  }

  return evidence;
};

// Render a Rize summary's seconds into a compact human string for the prompt.
function rizeMinutes(seconds) {
  const m = Math.round((Number(seconds) || 0) / 60);
  if (m >= 60) return `${(m / 60).toFixed(1)}h`;
  return `${m}m`;
}

ProactiveObserver.prototype.scanTasksAgainstActivity = async function ({ now = new Date() } = {}) {
  if (!this.runtime?.tasks?.list) return { skipped: true, reason: "no task store" };

  const evidence = await this.gatherReconciliationEvidence({ now });
  const ocr = evidence.ocr ?? { apps: [], snippets: [] };

  // Bail only when EVERY source is empty — any of Rize / BuildBetter /
  // calendar may carry evidence even on a day with thin on-screen OCR.
  const ocrThin = (ocr.snippets?.length ?? 0) < 2;
  if (ocrThin && !evidence.rize && !evidence.buildbetter && !evidence.calendar) {
    return { skipped: true, reason: "insufficient activity across all sources" };
  }

  const candidates = this.runtime.tasks
    .list({ status: "pending", limit: 30 })
    .filter((t) => t.queue === "user");
  if (candidates.length === 0) return { skipped: true, reason: "no pending user tasks" };

  const provider = this.runtime.agentHost?.modelProvider;
  if (!provider?.isConfigured?.() || provider.constructor.name === "DeterministicModelProvider") {
    // Without an LLM we can't reliably decide. Skip rather than hallucinate.
    return { skipped: true, reason: "no LLM provider for task scan" };
  }

  const promptLines = [
    "Pending tasks:",
    ...candidates.map((t) => `  - id=${t.id} · "${t.title}"${t.description ? ` (${t.description.slice(0, 120)})` : ""}`),
    "",
    "=== EVIDENCE SOURCES ===",
    "",
    "[ocr] Recent on-screen activity (apps + OCR snippets):"
  ];
  promptLines.push(...(ocr.apps ?? []).slice(0, 5).map((a) => `  - app: ${a.app} (${a.n} focus events)`));
  promptLines.push(...(ocr.snippets ?? []).slice(0, 10).map((s) => `  - [${s.app}] ${s.text}`));
  if (ocrThin) promptLines.push("  (little on-screen activity captured)");

  promptLines.push("");
  if (evidence.rize) {
    const s = evidence.rize.summary;
    promptLines.push("[rize] Time actually tracked today (where the user spent time):");
    if (s) {
      promptLines.push(`  - total ${rizeMinutes(s.totalSeconds)}, focus ${rizeMinutes(s.focusSeconds)}`);
      for (const c of (s.categories ?? []).slice(0, 6)) promptLines.push(`  - category: ${c.name} (${rizeMinutes(c.totalSeconds)})`);
      for (const p of (s.projects ?? []).slice(0, 6)) promptLines.push(`  - project: ${p.name} (${rizeMinutes(p.totalSeconds)})`);
    }
    for (const sess of (evidence.rize.sessions ?? []).slice(0, 8)) {
      const tag = [sess.category?.name, sess.project?.name].filter(Boolean).join("/");
      promptLines.push(`  - session: ${sess.title ?? "(untitled)"}${tag ? ` [${tag}]` : ""}`);
    }
  } else {
    promptLines.push("[rize] (not configured or no tracked time)");
  }

  promptLines.push("");
  if (evidence.buildbetter) {
    promptLines.push("[buildbetter] Recent call topics (context — was this discussed / superseded?):");
    for (const ex of evidence.buildbetter) {
      promptLines.push(`  - "${ex.summary}"${ex.callName ? ` (call: ${ex.callName})` : ""}${ex.types?.length ? ` [${ex.types.join(",")}]` : ""}`);
    }
  } else {
    promptLines.push("[buildbetter] (no recent call topics)");
  }

  promptLines.push("");
  if (evidence.calendar) {
    promptLines.push("[calendar] Scheduled events that already occurred today (a meeting that happened corroborates a 'meet/sync/call' task):");
    for (const e of evidence.calendar) {
      const when = e.start ? new Date(e.start).toISOString().slice(11, 16) + "Z" : "";
      promptLines.push(`  - ${when} "${e.summary}"${e.status && e.status !== "confirmed" ? ` [${e.status}]` : ""}`);
    }
  } else {
    promptLines.push("[calendar] (no calendar feed or no events yet today)");
  }

  promptLines.push("");
  promptLines.push("Which tasks just got done or are actively being worked on? Weigh corroborating sources together.");
  const prompt = promptLines.join("\n");

  let raw;
  try {
    const result = await provider.generate({
      input: prompt,
      task: "observer",
      agent: { id: "task-scanner", name: "task-scanner" },
      memoryHits: [],
      messages: [],
      tools: [],
      toolRegistry: null,
      instructions: TASK_SCAN_SYSTEM_PROMPT,
      context: {}
    });
    raw = result.text ?? "";
  } catch (err) {
    return { skipped: true, reason: `llm error: ${err.message ?? String(err)}` };
  }

  let parsed;
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("no json");
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { skipped: true, reason: "could not parse llm output" };
  }

  const updates = Array.isArray(parsed?.updates) ? parsed.updates : [];
  let completed = 0;
  let inProgressed = 0;
  let clarified = 0;
  const applied = [];

  // Self-tuning: build the auto-complete threshold table from how the user
  // answered past clarifications. A source-combo we've been consistently
  // right about gets a lower bar (auto-complete sooner, ask less).
  const calibration = buildReconciliationCalibration(
    this.runtime?.outcomes?.recent?.(200, "clarification-answered") ?? []
  );

  for (const u of updates) {
    if (!u?.taskId) continue;
    const task = this.runtime.tasks.get(u.taskId);
    if (!task || task.status === "completed") continue;
    const confidence = Number(u.confidence ?? 0);
    const sources = Array.isArray(u.sources) ? u.sources.filter((s) => typeof s === "string") : [];
    const completeThreshold = calibration.thresholdFor(sources).threshold;

    // Defensive guard mirroring the system prompt: tracked time alone
    // (only [rize] cited) is never enough to mark something DONE — at most
    // it's in-progress. Downgrade a rize-only "complete" to in_progress.
    let action = u.action;
    if (action === "complete" && sources.length === 1 && sources[0] === "rize") {
      action = "in_progress";
    }

    if (action === "complete" && confidence >= completeThreshold) {
      this.runtime.tasks.complete(task.id, "observed");
      // Annotate with evidence + corroborating sources so the user can
      // sanity-check WHY it was auto-completed.
      this.runtime.tasks.update(task.id, {
        sourceMeta: {
          ...(task.sourceMeta ?? {}),
          autoCompletedEvidence: u.evidence,
          autoCompletedConfidence: confidence,
          autoCompletedSources: sources,
          autoCompletedThreshold: completeThreshold
        }
      });
      this.runtime?.events?.emit?.("task-auto-changed", {
        action: "complete",
        taskId: task.id,
        title: task.title,
        evidence: u.evidence,
        confidence,
        sources
      });
      completed += 1;
      applied.push({ id: task.id, action: "complete", sources });
    } else if (action === "in_progress" && confidence >= 0.5 && task.status !== "in_progress") {
      this.runtime.tasks.update(task.id, {
        status: "in_progress",
        sourceMeta: {
          ...(task.sourceMeta ?? {}),
          inProgressEvidence: u.evidence,
          inProgressConfidence: confidence,
          inProgressSources: sources
        }
      });
      this.runtime?.events?.emit?.("task-auto-changed", {
        action: "in_progress",
        taskId: task.id,
        title: task.title,
        evidence: u.evidence,
        confidence,
        sources
      });
      inProgressed += 1;
      applied.push({ id: task.id, action: "in_progress", sources });
    } else if (action === "complete" && confidence >= 0.4 && this.runtime?.clarifications?.add) {
      // The ambiguous band: there's real signal it's done, but not enough
      // to flip it without risking a wrong auto-complete. Rather than
      // silently dropping it (the old behavior), park a question — the
      // user answers in one tap and that answer trains future confidence.
      const c = this.runtime.clarifications.add({
        taskId: task.id,
        question: `Did you finish "${task.title}"?`,
        context: u.evidence ?? "",
        proposedAction: "complete",
        confidence,
        sources
      });
      if (c) {
        clarified += 1;
        applied.push({ id: task.id, action: "clarify", sources });
      }
    }
  }

  return { scanned: candidates.length, completed, inProgressed, clarified, applied };
};

function parseProposal(text) {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    if (obj.pass === true) return { pass: true, reason: obj.reason ?? null };
    if (!obj.category || !obj.title) return null;
    return obj;
  } catch { return null; }
}

// Story 9: build the retro context block prepended to the observer's
// system prompt. Pulls the most recent daily + weekly retros from
// long-tier memory and renders them compactly so the LLM can spot
// "this is a follow-up to Tuesday" without having to call recall.
function composeRetroContext(runtime) {
  const mem = runtime?.memory;
  if (!mem?.byTier) return null;
  const longTier = mem.byTier("long") ?? [];
  const dailies = longTier
    .filter((m) => Array.isArray(m.tags) && m.tags.includes("retro") && m.tags.includes("daily"))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
    .slice(0, 3);
  const weeklies = longTier
    .filter((m) => Array.isArray(m.tags) && m.tags.includes("retro") && m.tags.includes("weekly"))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
    .slice(0, 2);
  if (dailies.length === 0 && weeklies.length === 0) return null;
  const lines = ["Recent retros (use these to spot multi-day threads):"];
  for (const w of weeklies) {
    const head = (w.content ?? "").split("\n")[0] ?? "";
    lines.push(`[week] ${head.replace(/^##\s*/, "").slice(0, 200)}`);
  }
  for (const d of dailies) {
    const head = (d.content ?? "").split("\n")[0] ?? "";
    lines.push(`[day] ${head.replace(/^##\s*/, "").slice(0, 200)}`);
  }
  return lines.join("\n");
}

// Create (or return the existing) task for a task-category suggestion.
// Shared by the observer's OPENAGI_AUTO_TASKS=1 path and the dashboard's
// accept endpoint, so both produce identical tasks (same dedup by
// suggestionId, same draft-only guardrails for agent-queue tasks).
export function materializeTaskFromSuggestion(runtime, candidate) {
  if (candidate?.category !== "task") return null;
  if (!candidate.title || !runtime?.tasks?.add) return null;
  const queue = candidate.taskQueue === "agent" ? "agent" : "user";
  try {
    const existing = runtime.tasks.list?.({ limit: 500 }) ?? [];
    const duplicate = existing.find((t) => t.sourceMeta?.suggestionId === candidate.id);
    if (duplicate) return duplicate;

    const descriptionParts = [];
    if (candidate.rationale) descriptionParts.push(candidate.rationale);
    if (queue === "agent") {
      descriptionParts.push(
        "Produce a draft only. Do NOT send, publish, schedule externally, or take any irreversible action without user approval.",
        "Leave the result for the user to review."
      );
    }

    return runtime.tasks.add(
      {
        title: candidate.title,
        description: descriptionParts.join("\n\n").trim(),
        bucket: candidate.taskBucket ?? "today",
        priority: queue === "agent" ? 60 : 50,
        tags: queue === "agent" ? ["observer-proposed", "draft-only"] : ["observer-proposed"],
        sourceMeta: {
          suggestionId: candidate.id,
          observedApps: candidate.context?.apps ?? null,
          source: candidate.source ?? "proactive-observer"
        }
      },
      { source: candidate.source ?? "proactive-observer", queue }
    );
  } catch {
    return null;
  }
}
