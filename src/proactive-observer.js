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
    this.dataDir = options.dataDir ?? process.env.OPENAGI_DATA_DIR ?? ".openagi";
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
    writeJsonAtomic(path.join(this.suggestDir, `${id}.json`), candidate);
    this.runtime?.events?.emit?.("proactive-suggestion", {
      id,
      category: candidate.category,
      title: candidate.title,
      rationale: candidate.rationale,
      mcpId: candidate.mcpId
    });
    return { suggested: 1, candidate };
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
  "You review a list of the user's pending tasks against what was recently on their screen.",
  "For each task, decide if there's STRONG evidence in the OCR snippets that it just got done, or that the user is actively working on it.",
  "Output STRICT JSON: {\"updates\": [{\"taskId\": \"...\", \"action\": \"complete\"|\"in_progress\", \"confidence\": 0-1, \"evidence\": \"<short>\"}]} — empty updates array is fine.",
  "Be conservative. 'complete' requires explicit evidence (PR merged, ticket closed, message sent). 'in_progress' requires the user actively working on it (editor open, commits being made, in a related call).",
  "Don't propose updates without specific OCR text supporting them — quote a fragment in the evidence field."
].join("\n");

ProactiveObserver.prototype.scanTasksAgainstActivity = async function ({ now = new Date() } = {}) {
  if (!this.runtime?.tasks?.list) return { skipped: true, reason: "no task store" };
  if (!this.runtime?.observations?.getRecentContext) return { skipped: true, reason: "no observation store" };

  const ctx = await this.runtime.observations.getRecentContext({
    minutes: 30,
    maxChars: 2400,
    maxSnippets: 10
  });
  if ((ctx.snippets?.length ?? 0) < 2) {
    return { skipped: true, reason: "insufficient activity" };
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

  const prompt = [
    "Pending tasks:",
    ...candidates.map((t) => `  - id=${t.id} · "${t.title}"${t.description ? ` (${t.description.slice(0, 120)})` : ""}`),
    "",
    "Recent on-screen activity (apps + OCR snippets):",
    ...(ctx.apps ?? []).slice(0, 5).map((a) => `  - app: ${a.app} (${a.n} focus events)`),
    ...(ctx.snippets ?? []).slice(0, 10).map((s) => `  - [${s.app}] ${s.text}`),
    "",
    "Which tasks just got done or are actively being worked on?"
  ].join("\n");

  let raw;
  try {
    const result = await provider.generate({
      input: prompt,
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
  const applied = [];

  for (const u of updates) {
    if (!u?.taskId) continue;
    const task = this.runtime.tasks.get(u.taskId);
    if (!task || task.status === "completed") continue;
    const confidence = Number(u.confidence ?? 0);

    if (u.action === "complete" && confidence >= 0.7) {
      this.runtime.tasks.complete(task.id, "observed");
      // Annotate with evidence so the user can sanity-check.
      this.runtime.tasks.update(task.id, {
        sourceMeta: {
          ...(task.sourceMeta ?? {}),
          autoCompletedEvidence: u.evidence,
          autoCompletedConfidence: confidence
        }
      });
      this.runtime?.events?.emit?.("task-auto-changed", {
        action: "complete",
        taskId: task.id,
        title: task.title,
        evidence: u.evidence,
        confidence
      });
      completed += 1;
      applied.push({ id: task.id, action: "complete" });
    } else if (u.action === "in_progress" && confidence >= 0.5 && task.status !== "in_progress") {
      this.runtime.tasks.update(task.id, {
        status: "in_progress",
        sourceMeta: {
          ...(task.sourceMeta ?? {}),
          inProgressEvidence: u.evidence,
          inProgressConfidence: confidence
        }
      });
      this.runtime?.events?.emit?.("task-auto-changed", {
        action: "in_progress",
        taskId: task.id,
        title: task.title,
        evidence: u.evidence,
        confidence
      });
      inProgressed += 1;
      applied.push({ id: task.id, action: "in_progress" });
    }
  }

  return { scanned: candidates.length, completed, inProgressed, applied };
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
