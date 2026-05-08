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

const SYSTEM_PROMPT = [
  "You are OpenAGI's proactive observer. The user gave you screen-capture access; you can see what apps they used and what OCR text was on screen in the last ~10 minutes.",
  "Your job: propose ONE concrete next thing the agent could do for them. Be useful or stay silent.",
  "Output STRICT JSON, one of these shapes:",
  '  {"pass": true, "reason": "<short>"}                                           // nothing actionable yet',
  '  {"category": "skill", "title": "<short>", "rationale": "<why>", "draftBody": "<markdown body>"}',
  '  {"category": "mcp", "title": "Connect <name> MCP", "rationale": "<why>", "mcpId": "<catalog id>"}    // only when MCP is in the candidate list',
  '  {"category": "automation", "title": "<short>", "rationale": "<why>", "steps": ["<action 1>", "<action 2>"]}',
  '  {"category": "knowledge", "title": "<short>", "rationale": "<why>"}',
  "Be specific. Reference actual content (branch names, ticket numbers, channel names) you saw in the OCR snippets. Don't quote them verbatim — refer naturally.",
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
  async observe({ now = new Date(), force = false } = {}) {
    if (!force && Date.now() - this.lastRunAt < MIN_INTERVAL_MS) {
      return { skipped: true, reason: "rate-limited" };
    }
    this.lastRunAt = Date.now();

    if (!this.runtime?.observations?.getRecentContext) {
      return { skipped: true, reason: "no observation store" };
    }

    const ctx = await this.runtime.observations.getRecentContext({
      minutes: this.lookbackMinutes,
      maxChars: 2000,
      maxSnippets: 8
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
    try {
      const result = await provider.generate({
        input: prompt,
        agent: { id: "proactive-observer", name: "proactive-observer" },
        memoryHits: [],
        messages: [],
        tools: [],
        toolRegistry: null,
        instructions: SYSTEM_PROMPT,
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
      source: "proactive-observer",
      category: proposal.category,
      title: proposal.title,
      rationale: proposal.rationale,
      mcpId: proposal.mcpId ?? null,
      mcpRegister: proposal.mcpRegister ?? null,
      draftBody: proposal.draftBody ?? null,
      steps: proposal.steps ?? null,
      context: { apps: ctx.apps?.slice(0, 5) ?? [], snippetCount: ctx.snippets?.length ?? 0 },
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
