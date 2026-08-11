// Backlog triage — the cleanup cadence for the suggestion + draft queues.
//
// Pending suggestions and drafts can otherwise accumulate indefinitely: the
// producer queues keep discovering work, while the compact Quick Ask surface
// can show only a handful of rows. Without a retirement cadence, older useful
// items become effectively unreachable behind a growing recent backlog.
//
// Two halves, in that order:
//
//   1. CLEAN UP. A deterministic pre-filter first, then an LLM pass over only
//      what the rules genuinely cannot decide.
//   2. SURFACE WHAT'S LEFT. A ranked "these still matter" shortlist, persisted
//      as a report the dashboard/CLI can read.
//
// ── why a pre-filter at all ──────────────────────────────────────────────
// Sending an unbounded queue to a model every week is both expensive and
// unnecessary: many rows are decidable from evidence already on the record.
// The rules below resolve those for zero tokens, and only the genuinely
// ambiguous remainder — "has this quietly been done?", "does this still
// matter?" — costs anything. Even then the pass is capped (default 200 items)
// so one run has a bounded, predictable cost and the tail drains gradually.
//
// ── why nothing here is destructive ──────────────────────────────────────
// Auto-dismissing something the user still wanted is the worst outcome
// available to this module: it would poison the entire suggestion surface. So:
//
//   • every automated resolution writes WHY (a reason string) and the EVIDENCE
//     it used, plus which rule or model decided it;
//   • resolutions use a DISTINCT status ("auto-dismissed" / "auto-discarded"),
//     never the "dismissed"/"discarded" a human click produces, so the two are
//     always tellable apart on disk and a bad pass can be undone in bulk;
//   • the previous status is recorded on the record itself, so undo needs
//     nothing but the record;
//   • undoTriagePass() reverses a whole pass by id.
//
// Because "auto-dismissed" is not "pending", a resolved item drops out of
// listAllSuggestions({status:"pending"}) — which is what the daily brief and
// the Suggestions tab both read. That is the entire wiring: the cleanup is
// visible everywhere immediately, with no edits to those surfaces. The accept/
// reject routes look items up with `status: null`, so a single auto-dismissed
// item can still be accepted from the dashboard — per-item undo for free.
//
// ── model selection ──────────────────────────────────────────────────────
// No model id appears in this file. Calls go through the same path as every
// other background job (daily-planner.synthesizeWithLLM, task-sweep): the
// runtime's configured provider, with `task: "sweep"`, which ModelRouter
// resolves via TASK_PROFILES.sweep → the "mini" tier → whatever the user set
// (ANTHROPIC_MODEL_MINI, recommended claude-haiku-4-5) and otherwise their base
// model (ANTHROPIC_MODEL, default claude-sonnet-4-6). "sweep" is the right
// profile because it already means exactly this shape of work — "classify +
// dedupe/stale-judge a list" — and reusing it means a user who has already
// tuned their tiers gets that tuning here for free.

import fs from "node:fs";
import path from "node:path";
import { ensureDir, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";
import { createId, nowIso } from "./utils.js";
import { listAllSuggestions } from "./suggestion-feed.js";
import { safeJoinOrNull } from "./path-guard.js";

/// Status written to a suggestion this module retires. Deliberately NOT
/// "dismissed" — that is what a human pressing Dismiss produces, and the two
/// must never be confusable, either for the user reading the record or for a
/// bulk undo trying to work out what it is allowed to touch.
export const AUTO_DISMISSED = "auto-dismissed";
/// Same idea for drafts. DraftStore's own statuses are pending/approved/
/// discarded/sent.
export const AUTO_DISCARDED = "auto-discarded";

/// Suggestion categories whose accept button actually does something. Read off
/// the POST /proactive/suggestions/:id/accept branches in hosted-interface.js:
/// "mcp" registers a server, "task" materializes a task, "skill" writes a
/// SKILL.md, "knowledge" writes a memory. Anything else falls through to a bare
/// commit({}) — the status flips to accepted and NOTHING is created.
///
/// This is the same allowlist daily-brief.js keeps, for the same reason, and it
/// must stay in step with it. Retiring an item off this list is the safest
/// automated action in the whole module: the user could not have acted on it
/// even if they had wanted to. Measured: 34 pending "automation" suggestions.
const ACTIONABLE_CATEGORIES = new Set(["mcp", "task", "skill", "knowledge"]);

const DAY_MS = 24 * 60 * 60 * 1000;

// Tunables. Every one is env-overridable because the right answer depends on
// how big the backlog got before anyone noticed.
const DEFAULTS = {
  // Younger than this and we do not spend a token on it: it is still inside the
  // window where the brief surfaces it on its own, so the user has genuinely
  // not had a chance to answer yet. Measured: 288 of 1,134.
  freshDays: 7,
  // Below this age nothing is ever auto-retired by the weak-evidence rule.
  staleDays: 30,
  // Title-token Jaccard at which two observer suggestions are treated as the
  // same ask. Tuned against the real queue: 0.65 collapses "Run the agent
  // autopilot pulse" into "Run the next agent autopilot pulse" and leaves
  // genuinely different asks alone.
  duplicateThreshold: 0.65,
  // Hard ceiling on how many items one pass may send to the model. This is the
  // cost lever: the tail drains over successive weeks instead of in one bill.
  maxLlmItems: 200,
  batchSize: 25,
  // A model verdict below this confidence never retires anything.
  minDismissConfidence: 0.7,
  // Belt-and-braces ceiling on total automated resolutions in one pass, so a
  // pathological run (bad prompt, model regression) cannot empty the queue.
  maxResolutions: 400,
  // Wall clock for the LLM phase. The cron job timeout is 10 min and on timeout
  // the handler is ABANDONED, not cancelled — which would lose the report
  // entirely. Stop early, write what we have.
  deadlineMs: 7 * 60 * 1000,
  // Share of the remaining daily budget one pass is allowed to plan to spend.
  budgetFraction: 0.25
};

function envNumber(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

// ─── the machine-checkable verdict schema ────────────────────────────────

/// The contract for one model verdict. This object is BOTH the thing embedded
/// in the prompt and the thing validateVerdict() enforces, so the instructions
/// and the parser cannot drift apart — the failure mode where a prompt asks for
/// one shape and the code quietly accepts another.
///
/// Deliberately flat and small: every field is machine-checkable, none of it is
/// prose the code has to interpret. `reason` is prose, but it is never parsed —
/// it is written verbatim onto the record as the human-readable WHY.
export const TRIAGE_VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["i", "verdict", "confidence", "reason"],
  properties: {
    i: { type: "integer", minimum: 0, description: "index of the item in this batch" },
    verdict: { enum: ["dismiss", "keep", "unsure"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string", minLength: 8, maxLength: 240 },
    stillMattersScore: { type: "number", minimum: 0, maximum: 1, description: "for keep: how important, 1 = do this now" }
  }
};

/// Validate one raw verdict against TRIAGE_VERDICT_SCHEMA. Returns
/// { ok: true, value } or { ok: false, error }. Anything that fails is dropped
/// and counted — a malformed verdict resolves nothing, which is the safe
/// direction. `batchLength` bounds `i` so a hallucinated index cannot be
/// mapped onto some other user's suggestion.
export function validateVerdict(raw, batchLength) {
  if (!raw || typeof raw !== "object") return { ok: false, error: "not an object" };
  if (!Number.isInteger(raw.i) || raw.i < 0 || raw.i >= batchLength) return { ok: false, error: "i out of range" };
  if (!["dismiss", "keep", "unsure"].includes(raw.verdict)) return { ok: false, error: "bad verdict" };
  const confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return { ok: false, error: "bad confidence" };
  const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
  if (reason.length < 8) return { ok: false, error: "reason too short" };
  const rawScore = Number(raw.stillMattersScore);
  const stillMattersScore = Number.isFinite(rawScore) ? Math.min(1, Math.max(0, rawScore)) : null;
  return { ok: true, value: { i: raw.i, verdict: raw.verdict, confidence, reason: reason.slice(0, 240), stillMattersScore } };
}

const SYSTEM_PROMPT = [
  "You are triaging a personal AI assistant's backlog of suggestions it made to its owner and never got an answer to. Every item below has been sitting unanswered for at least a week.",
  "Rules cannot answer two questions, which is why you are here:",
  "  (a) has this probably already been done, or stopped being relevant, since it was proposed?",
  "  (b) does it still deserve the owner's attention at all?",
  "",
  "For EACH item return exactly one verdict object:",
  '  "dismiss" — you would bet the owner no longer needs this: it reads as already handled, one-off noise, or tied to a moment that has passed.',
  '  "keep"    — this still matters. Set stillMattersScore (0-1) for how much: 1 = they should do this now, 0.2 = worth keeping but not urgent.',
  '  "unsure"  — you cannot tell from what you were given.',
  "",
  "BIAS TOWARD unsure AND keep. A wrong dismiss silently deletes something the owner wanted and destroys their trust in this whole surface. An unsure costs nothing — the item simply stays in the queue for a human.",
  "Never dismiss on age alone: age is already why the item is in front of you. Dismiss on what the item SAYS.",
  "`reason` must name the specific evidence you used, in one short sentence. Not \"no longer relevant\" — say why.",
  "",
  `Return a STRICT JSON array, one object per input item, each matching this schema: ${JSON.stringify(TRIAGE_VERDICT_SCHEMA)}`,
  "No prose, no markdown fences, no commentary. Echo each item's `i` exactly."
].join("\n");

// ─── the job ─────────────────────────────────────────────────────────────

export class BacklogTriage {
  constructor({ runtime, dataDir, ...options } = {}) {
    this.runtime = runtime ?? null;
    this.dataDir = dataDir ?? null;
    this.options = {
      freshDays: envNumber("OPENAGI_BACKLOG_TRIAGE_FRESH_DAYS", DEFAULTS.freshDays),
      staleDays: envNumber("OPENAGI_BACKLOG_TRIAGE_STALE_DAYS", DEFAULTS.staleDays),
      duplicateThreshold: DEFAULTS.duplicateThreshold,
      maxLlmItems: envNumber("OPENAGI_BACKLOG_TRIAGE_MAX_LLM", DEFAULTS.maxLlmItems),
      batchSize: envNumber("OPENAGI_BACKLOG_TRIAGE_BATCH", DEFAULTS.batchSize),
      minDismissConfidence: DEFAULTS.minDismissConfidence,
      maxResolutions: envNumber("OPENAGI_BACKLOG_TRIAGE_MAX_RESOLUTIONS", DEFAULTS.maxResolutions),
      deadlineMs: DEFAULTS.deadlineMs,
      budgetFraction: DEFAULTS.budgetFraction,
      ...options
    };
  }

  /// Resolve the data dir the same way suggestion-feed.js does. AbiRuntime does
  /// NOT carry a dataDir property, so an explicit option or the sub-stores'
  /// own paths are the only reliable sources — resolveDataDir() memoizes
  /// process-wide and would hand back the wrong install in a test.
  resolveDir() {
    return this.dataDir
      ?? this.runtime?.dataDir
      ?? this.runtime?.proactiveObserver?.dataDir
      ?? this.runtime?.patternMiner?.dataDir
      ?? resolveDataDir();
  }

  /// One cleanup pass. NEVER throws — a cron handler that throws every hour is
  /// a crash loop, and this job in particular must not be able to take the
  /// scheduler down. Everything that can fail is caught and reported as a
  /// `degraded` entry so a bad pass is legible instead of silent.
  ///
  /// dryRun: compute and report everything, write nothing.
  /// useLLM: false runs the deterministic half only (also what happens when no
  ///         provider is configured or the budget is spent).
  async run({ now = new Date(), dryRun = false, useLLM = true } = {}) {
    const startedAt = now instanceof Date ? now : new Date(now);
    const passId = createId("triage");
    const degraded = [];
    const report = emptyReport(passId, startedAt, dryRun);

    const dir = safely(degraded, "dataDir", () => this.resolveDir(), null);
    if (!dir) {
      report.finishedAt = nowIso();
      report.degraded = degraded;
      return report;
    }

    // ── gather ───────────────────────────────────────────────────────────
    const suggestions = safely(degraded, "suggestions",
      () => listAllSuggestions(this.runtime, { status: "pending" }) ?? [], []);
    const drafts = safely(degraded, "drafts",
      () => this.runtime?.drafts?.list?.({ status: "pending" }) ?? [], []);
    const taskIndex = safely(degraded, "tasks", () => indexTasks(this.runtime), new Map());

    report.scanned = { suggestions: suggestions.length, drafts: drafts.length };

    // ── phase 1: deterministic ───────────────────────────────────────────
    const plan = classifyDeterministic({
      suggestions,
      drafts,
      taskIndex,
      now: startedAt,
      freshDays: this.options.freshDays,
      staleDays: this.options.staleDays,
      duplicateThreshold: this.options.duplicateThreshold
    });

    report.prefilter = {
      resolved: plan.resolved.length,
      keptFresh: plan.keptFresh.length,
      ambiguous: plan.ambiguous.length,
      byRule: countBy(plan.resolved, (r) => r.rule)
    };

    // ── phase 2: the part rules cannot do ────────────────────────────────
    let llmResolutions = [];
    let llmKeeps = [];
    let llmDeferrals = [];
    if (!useLLM) {
      report.llm.skipped = "disabled";
    } else if (plan.ambiguous.length === 0) {
      report.llm.skipped = "no-candidates";
    } else {
      const outcome = await this.judge(plan.ambiguous, { passId, degraded });
      Object.assign(report.llm, outcome.stats);
      llmResolutions = outcome.resolutions;
      llmKeeps = outcome.keeps;
      llmDeferrals = outcome.deferrals;
    }

    // ── phase 3: apply, under a hard ceiling ─────────────────────────────
    const allResolutions = [...plan.resolved, ...llmResolutions];
    const capped = allResolutions.length > this.options.maxResolutions;
    const toApply = capped ? allResolutions.slice(0, this.options.maxResolutions) : allResolutions;

    const applied = { suggestions: 0, drafts: 0, keepsAnnotated: 0, deferralsAnnotated: 0, failed: 0 };
    if (!dryRun) {
      for (const r of toApply) {
        const ok = r.kind === "draft"
          ? this.retireDraft(r, passId, degraded)
          : this.retireSuggestion(dir, r, passId, degraded);
        if (!ok) { applied.failed += 1; continue; }
        if (r.kind === "draft") applied.drafts += 1; else applied.suggestions += 1;
        // The undo ledger. Only records that were ACTUALLY written go in here,
        // so a replay can never try to restore something this pass did not
        // touch. Kept on the report because the report is the durable artifact
        // — undo needs no other index.
        report._resolvedIds.push({ id: r.id, kind: r.kind, rule: r.rule });
      }
      // One snapshot for every draft this pass touched, not one each.
      if (applied.drafts > 0) safely(degraded, "draft-snapshot", () => this.runtime?.drafts?.snapshot?.(), null);
      // Keeps are annotated, never resolved: additive metadata on a record that
      // stays pending. Only model-judged keeps get written — a deterministic
      // "it's only 3 days old" keep is not a judgement worth persisting, and
      // writing 288 files a week for it would be pure churn.
      for (const k of llmKeeps) {
        if (this.annotateKeep(dir, k, passId, degraded)) applied.keepsAnnotated += 1;
      }
      // An "unsure" or low-confidence dismissal is still a completed model
      // judgement. Record that fact without changing status so the next
      // bounded pass advances to untouched rows rather than spending its cap
      // on the same oldest uncertainty forever.
      for (const d of llmDeferrals) {
        if (this.annotateDeferral(dir, d, passId, degraded)) applied.deferralsAnnotated += 1;
      }
    }
    report.applied = { ...applied, cappedAt: capped ? this.options.maxResolutions : null, wouldApply: allResolutions.length };

    // ── phase 4: the second half of the question ─────────────────────────
    report.critical = rankCritical(llmKeeps, 10);
    report.samples = sampleVerdicts(allResolutions, llmKeeps, 10);
    report.finishedAt = nowIso();
    report.degraded = degraded;

    if (!dryRun) safely(degraded, "persist", () => this.persist(dir, report), null);
    // Even the notification is best-effort. A subscriber that throws must not
    // be able to lose a pass whose writes have already landed.
    safely(degraded, "emit", () => this.runtime?.events?.emit?.("backlog-triage", summarizeTriagePass(report)), null);
    return report;
  }

  // ── the LLM half ───────────────────────────────────────────────────────

  /// Judge the ambiguous set in batches. Returns resolutions, ranked keeps,
  /// non-resolving deferrals, and stats.
  /// Any failure degrades to "we judged fewer than we wanted" — never a throw.
  async judge(candidates, { passId, degraded }) {
    // Wall clock, deliberately NOT the caller's `now`. `now` is a LOGICAL clock
    // — it is what ages are measured against and tests inject it freely — and
    // deriving a real-time deadline from it means a pass dated in the past
    // times out before it makes a single call.
    const phaseStartedMs = Date.now();
    const stats = {
      attempted: true, skipped: null, model: null, batches: 0, itemsSent: 0, itemsJudged: 0,
      deferred: 0, verdicts: { dismiss: 0, keep: 0, unsure: 0, invalid: 0, duplicate: 0, missing: 0, lowConfidence: 0 },
      estimated: { inputTokens: 0, outputTokens: 0, usd: 0 },
      actual: null, stoppedEarly: null
    };
    const resolutions = [];
    const keeps = [];
    const deferrals = [];

    const provider = this.runtime?.agentHost?.modelProvider;
    // Same gate every other LLM path in this repo uses (daily-planner,
    // task-sweep): a DeterministicModelProvider reports isConfigured() === true
    // but cannot judge anything, so it must be excluded by name.
    if (!provider?.isConfigured?.() || provider.constructor?.name === "DeterministicModelProvider") {
      stats.attempted = false;
      stats.skipped = "no-provider";
      stats.deferred = candidates.length;
      return { resolutions, keeps, deferrals, stats };
    }

    // BudgetGuard, up front: if today's cap is already spent there is no point
    // building a prompt. The deterministic half has already run and its result
    // stands — this is the "degrade safely" path, not an error.
    const budget = this.runtime?.budget ?? null;
    try {
      budget?.check?.();
    } catch (error) {
      stats.attempted = false;
      stats.skipped = error?.code === "BUDGET_EXCEEDED" ? "budget-exhausted" : "budget-unavailable";
      stats.deferred = candidates.length;
      return { resolutions, keeps, deferrals, stats };
    }

    stats.model = safely(degraded, "resolveModel",
      () => provider.resolveModel?.({ task: "sweep" }) ?? provider.model ?? null, null);

    // Untouched first, then oldest within each group. Keeps stay pending by
    // design, so a simple oldest-first sort selected them again on every run
    // and could permanently starve the untouched tail behind a 200-item cap.
    // Previously judged rows remain eligible for later reconsideration, but
    // only after every never-judged row has had a turn. Among reviewed rows,
    // least-recently reviewed goes first so reconsideration rotates too.
    const ordered = [...candidates].sort((a, b) => {
      const reviewed = Number(Boolean(a.priorModelReviewAt)) - Number(Boolean(b.priorModelReviewAt));
      if (reviewed) return reviewed;
      if (a.priorModelReviewAt && b.priorModelReviewAt) {
        const aReviewedAt = Date.parse(a.priorModelReviewAt);
        const bReviewedAt = Date.parse(b.priorModelReviewAt);
        const reviewOrder = (Number.isFinite(aReviewedAt) ? aReviewedAt : 0)
          - (Number.isFinite(bReviewedAt) ? bReviewedAt : 0);
        if (reviewOrder) return reviewOrder;
      }
      return b.ageDays - a.ageDays;
    });
    const sendable = ordered.slice(0, this.options.maxLlmItems);
    stats.deferred = ordered.length - sendable.length;

    const batches = chunk(sendable, this.options.batchSize);
    // Estimate BEFORE spending, using the same price table BudgetGuard bills
    // with, and trim the plan to the share of today's remaining budget this job
    // is allowed. Cost control that is checked, not hoped for.
    const prompts = batches.map((b) => renderBatchPrompt(b));
    const estimates = batches.map((b, i) => estimateBatchCost(budget, stats.model, prompts[i], b.length));
    const affordable = trimToBudget(budget, estimates, this.options.budgetFraction);
    if (affordable < batches.length) stats.stoppedEarly = "budget-plan";

    const spentBefore = safely(degraded, "budgetStatus", () => budget?.status?.()?.spentUsd ?? null, null);
    const deadline = phaseStartedMs + this.options.deadlineMs;

    for (let b = 0; b < affordable; b += 1) {
      if (Date.now() > deadline) { stats.stoppedEarly = "deadline"; break; }
      try {
        budget?.check?.();
      } catch {
        stats.stoppedEarly = "budget-exhausted";
        break;
      }
      const batch = batches[b];
      let text;
      try {
        const result = await provider.generate({
          input: prompts[b],
          // No model id here by design — `task` routes through ModelRouter so
          // this job inherits the user's tier configuration like every other.
          task: "sweep",
          instructions: SYSTEM_PROMPT,
          agent: { id: "backlog-triage", name: "backlog-triage" },
          memoryHits: [], messages: [], tools: [], toolRegistry: null, context: {}
        });
        text = result?.text ?? "";
        if (result?.model) stats.model = result.model;
      } catch (error) {
        // One bad batch must not abort the pass — but a provider that is down
        // will fail every batch, so stop rather than hammer it.
        degraded.push(`llm-batch-${b}: ${String(error?.message ?? error).slice(0, 120)}`);
        stats.stoppedEarly = "provider-error";
        break;
      }
      stats.batches += 1;
      stats.itemsSent += batch.length;
      stats.estimated.inputTokens += estimates[b].inputTokens;
      stats.estimated.outputTokens += estimates[b].outputTokens;
      stats.estimated.usd += estimates[b].usd;

      const seenIndexes = new Set();
      for (const raw of parseJsonArray(text)) {
        const checked = validateVerdict(raw, batch.length);
        if (!checked.ok) { stats.verdicts.invalid += 1; continue; }
        const v = checked.value;
        if (seenIndexes.has(v.i)) {
          stats.verdicts.duplicate += 1;
          continue;
        }
        seenIndexes.add(v.i);
        stats.itemsJudged += 1;
        const item = batch[v.i];
        if (v.verdict === "dismiss") {
          // The one place a model gets to retire something. Three gates: an
          // explicit dismiss, real confidence, and a reason long enough to be
          // an actual explanation (enforced by validateVerdict). Anything less
          // leaves the item pending — counted separately so a pass where the
          // model is hedging everything is visible rather than looking quiet.
          if (v.confidence < this.options.minDismissConfidence) {
            stats.verdicts.lowConfidence += 1;
            deferrals.push({
              ...item,
              verdict: "defer",
              modelVerdict: "dismiss",
              decidedBy: `llm:${stats.model ?? "unknown"}`,
              confidence: v.confidence,
              reason: v.reason
            });
            continue;
          }
          stats.verdicts.dismiss += 1;
          resolutions.push({
            ...item,
            rule: "llm-judged",
            decidedBy: `llm:${stats.model ?? "unknown"}`,
            confidence: v.confidence,
            reason: v.reason,
            evidence: { ...item.evidence, judgedFrom: item.summary }
          });
        } else if (v.verdict === "keep") {
          stats.verdicts.keep += 1;
          keeps.push({
            ...item,
            decidedBy: `llm:${stats.model ?? "unknown"}`,
            confidence: v.confidence,
            reason: v.reason,
            stillMattersScore: v.stillMattersScore ?? 0.5
          });
        } else {
          stats.verdicts.unsure += 1;
          deferrals.push({
            ...item,
            verdict: "unsure",
            modelVerdict: "unsure",
            decidedBy: `llm:${stats.model ?? "unknown"}`,
            confidence: v.confidence,
            reason: v.reason
          });
        }
      }

      // A model can return valid JSON that omits rows, repeats one index, or
      // contains no usable verdicts at all. Do not call those rows judged, and
      // do not let the same oldest malformed batch starve the untouched tail
      // forever. Record a non-resolving scheduling attempt so the next bounded
      // pass rotates onward; the item remains pending and fully actionable.
      for (let i = 0; i < batch.length; i += 1) {
        if (seenIndexes.has(i)) continue;
        stats.verdicts.missing += 1;
        const item = batch[i];
        deferrals.push({
          ...item,
          verdict: "unsure",
          modelVerdict: "missing",
          decidedBy: `llm:${stats.model ?? "unknown"}`,
          confidence: 0,
          reason: "The model returned no valid verdict for this item; it remains pending and will rotate behind untouched work."
        });
      }
    }

    const spentAfter = safely(degraded, "budgetStatus", () => budget?.status?.()?.spentUsd ?? null, null);
    if (spentBefore !== null && spentAfter !== null) {
      stats.actual = { usd: Number((spentAfter - spentBefore).toFixed(6)) };
    }
    stats.estimated.usd = Number(stats.estimated.usd.toFixed(6));
    // Everything the pass did not actually judge is deferred, whether it was
    // over the cap, in a batch that never ran, or omitted from a malformed
    // response. `itemsSent` remains a cost/accounting fact; it is not proof the
    // model returned one unique valid verdict per row.
    stats.deferred = ordered.length - stats.itemsJudged;
    return { resolutions, keeps, deferrals, stats };
  }

  // ── writes (all reversible, all evidenced) ─────────────────────────────

  /// Retire one suggestion. Writes the distinct status, the human-readable
  /// reason into `note` (which suggestion-feed.js already carries into the
  /// envelope, so the dashboard shows it), and the full audit block.
  retireSuggestion(dir, resolution, passId, degraded) {
    const file = suggestionFile(dir, resolution.id);
    if (!file) { degraded.push(`missing-file:${resolution.id}`); return false; }
    try {
      const raw = readJsonFile(file, null);
      if (!raw) return false;
      // Someone resolved it between the scan and now. Their answer wins.
      if (raw.status !== "pending") return false;
      raw.autoTriage = auditBlock(resolution, passId, raw.status);
      raw.status = AUTO_DISMISSED;
      raw.resolvedAt = nowIso();
      raw.note = resolution.reason;
      writeJsonAtomic(file, raw);
      return true;
    } catch (error) {
      degraded.push(`write:${resolution.id}: ${String(error?.message ?? error).slice(0, 80)}`);
      return false;
    }
  }

  /// Annotate a keep. Additive only — status stays "pending", so the item
  /// remains in every surface that reads the queue. This is what makes the
  /// ranking durable between passes and what a future brief change would read.
  annotateKeep(dir, keep, passId, degraded) {
    return this.annotatePending(dir, { ...keep, verdict: "keep", modelVerdict: "keep" }, passId, degraded, "annotate");
  }

  /// Record a completed judgement that deliberately left the row pending.
  /// This is scheduling metadata, not a resolution: the status and every
  /// user-facing action remain unchanged.
  annotateDeferral(dir, deferral, passId, degraded) {
    return this.annotatePending(dir, deferral, passId, degraded, "annotate-defer");
  }

  annotatePending(dir, judgement, passId, degraded, errorPrefix) {
    const file = suggestionFile(dir, judgement.id);
    if (!file) return false;
    try {
      const raw = readJsonFile(file, null);
      if (!raw || raw.status !== "pending") return false;
      raw.autoTriage = {
        passId, at: nowIso(), verdict: judgement.verdict,
        modelVerdict: judgement.modelVerdict,
        decidedBy: judgement.decidedBy, reason: judgement.reason,
        confidence: judgement.confidence,
        stillMattersScore: judgement.stillMattersScore ?? null,
        evidence: judgement.evidence ?? null
      };
      writeJsonAtomic(file, raw);
      return true;
    } catch (error) {
      degraded.push(`${errorPrefix}:${judgement.id}: ${String(error?.message ?? error).slice(0, 80)}`);
      return false;
    }
  }

  /// Retire one draft.
  ///
  /// DraftStore exposes discard() — which writes the same "discarded" a human
  /// click writes — and no way to set anything else. This module is not allowed
  /// to edit draft-store.js, and using discard() would make an automated
  /// retirement indistinguishable from a human one, which is exactly what
  /// requirement 4 forbids. So it writes the distinct status onto the live
  /// record and persists through the store's own public snapshot(), which is
  /// how DraftStore itself saves every mutation.
  ///
  /// Consequences, all deliberate: list({status:"pending"}) stops returning it
  /// (so it leaves the brief), and approve()/discard()/markSent() all refuse it
  /// (they require status "pending"), so a stale auto-discarded draft cannot be
  /// approved by accident. Undo puts it straight back.
  /// Note the deliberate absence of a snapshot() call: DraftStore snapshots the
  /// WHOLE store on every mutation, so persisting per draft would rewrite a
  /// 300KB file once per retirement. run() flushes once at the end instead.
  retireDraft(resolution, passId, degraded) {
    const store = this.runtime?.drafts;
    const draft = store?.get?.(resolution.id);
    if (!draft) { degraded.push(`missing-draft:${resolution.id}`); return false; }
    if (draft.status !== "pending") return false;
    try {
      draft.autoTriage = auditBlock(resolution, passId, draft.status);
      draft.status = AUTO_DISCARDED;
      draft.reviewedAt = nowIso();
      this.runtime?.events?.emit?.("draft-resolved", { draft, status: AUTO_DISCARDED });
      return true;
    } catch (error) {
      degraded.push(`draft-write:${resolution.id}: ${String(error?.message ?? error).slice(0, 80)}`);
      return false;
    }
  }

  persist(dir, report) {
    const base = path.join(dir, "backlog-triage");
    ensureDir(base);
    writeJsonAtomic(path.join(base, `${report.passId}.json`), report);
    writeJsonAtomic(path.join(base, "latest.json"), report);
  }
}

// ─── deterministic classification ────────────────────────────────────────

/// The whole rule engine, as a pure function of (records, clock). Exported so
/// the tests — and a human sanity-checking a pass — can run it without a
/// runtime, a provider or a filesystem.
///
/// Returns { resolved, keptFresh, ambiguous }. `resolved` items each carry the
/// rule that decided them, a reason sentence, and the evidence behind it.
export function classifyDeterministic({
  suggestions = [], drafts = [], taskIndex = new Map(), now = new Date(),
  freshDays = DEFAULTS.freshDays, staleDays = DEFAULTS.staleDays,
  duplicateThreshold = DEFAULTS.duplicateThreshold
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const resolved = [];
  const keptFresh = [];
  const ambiguous = [];

  // R1 / R2 — dead ends. Accepting these does nothing at all, so retiring them
  // cannot cost the user anything they could have had.
  const alive = [];
  for (const s of suggestions) {
    const category = s.category ?? "skill";
    if (!ACTIONABLE_CATEGORIES.has(category)) {
      resolved.push(makeResolution(s, nowMs, "dead-end-category",
        `Category "${category}" has no accept action on the server, so this could never have been acted on.`,
        { category, actionable: [...ACTIONABLE_CATEGORIES] }));
      continue;
    }
    if (category === "mcp" && !s.mcpRegister) {
      resolved.push(makeResolution(s, nowMs, "dead-end-mcp",
        "MCP suggestion carries no server registration, so accepting it would register nothing.",
        { category, mcpRegister: null }));
      continue;
    }
    alive.push(s);
  }

  // R3 — supersession. Two shapes, because the two sources identify themselves
  // differently and using one key for both is what makes dedupe either too
  // loose or too tight:
  //
  //   • mined candidates carry a `fingerprint` — the literal app sequence.
  //     Reduce it to its canonical cycle (drop consecutive repeats, take the
  //     minimal repeating period, rotate to a stable start) so the same loop
  //     observed over a 4-app window and a 6-app window collapses. Measured:
  //     567 mined candidates → 484 distinct loops.
  //   • observer candidates title themselves in prose, so compare title token
  //     sets. Measured at 0.65: 172 of 567 collapse, and spot-checking the
  //     collapses shows genuine restatements ("Run the agent autopilot pulse"
  //     vs "Run the next agent autopilot pulse"), not different asks.
  //
  // Newest wins in both cases, and the survivor's id goes in the evidence, so
  // "why did this vanish" always has an answer that points at a live record.
  const byRecency = [...alive].sort(byNewestFirst);
  const fingerprinted = [];
  const prose = [];
  for (const s of byRecency) (s.fingerprint ? fingerprinted : prose).push(s);

  const survivors = [];
  const seenCycles = new Map();
  for (const s of fingerprinted) {
    const key = canonicalCycle(s.fingerprint);
    const winner = seenCycles.get(key);
    if (winner) {
      resolved.push(makeResolution(s, nowMs, "superseded-duplicate",
        `The same repeated app loop was proposed again more recently (${winner.id}), so this older copy is redundant.`,
        { supersededBy: winner.id, supersededByProposedAt: winner.proposedAt ?? null, cycle: key, match: "app-cycle" }));
      continue;
    }
    seenCycles.set(key, s);
    survivors.push(s);
  }

  const kept = [];
  for (const s of prose) {
    const tokens = titleTokens(candidateTitle(s));
    let winner = null;
    let score = 0;
    if (tokens.size > 0) {
      for (const other of kept) {
        if ((other.s.category ?? "skill") !== (s.category ?? "skill")) continue;
        const j = jaccard(tokens, other.tokens);
        if (j >= duplicateThreshold && j > score) { winner = other.s; score = j; }
      }
    }
    if (winner) {
      resolved.push(makeResolution(s, nowMs, "superseded-duplicate",
        `A newer suggestion says the same thing (${winner.id}), so this older wording is redundant.`,
        { supersededBy: winner.id, supersededByTitle: candidateTitle(winner), similarity: Number(score.toFixed(2)), match: "title-tokens" }));
      continue;
    }
    kept.push({ s, tokens });
    survivors.push(s);
  }

  // R4 / R5 — route what survived.
  for (const s of survivors) {
    const ageDays = ageInDays(s.proposedAt, nowMs);
    if (ageDays < freshDays) {
      // Still inside the window where the brief surfaces it on its own. The
      // user has not ignored it yet; they have not been asked yet.
      keptFresh.push({ id: s.id, ageDays });
      continue;
    }
    const seq = s.sequence;
    if (seq && ageDays >= staleDays && weakEvidence(seq)) {
      resolved.push(makeResolution(s, nowMs, "weak-mined-evidence",
        `Mined pattern never recurred: seen ${seq.count ?? 0}× across ${seq.distinctDays ?? 0} day(s), confidence ${fmt(seq.confidence)}.`,
        { count: seq.count ?? null, distinctDays: seq.distinctDays ?? null, confidence: seq.confidence ?? null, ageDays: round1(ageDays) }));
      continue;
    }
    ambiguous.push(toCandidate(s, ageDays));
  }

  // Drafts. ONE rule, and only one, because the obvious second one is a trap:
  // 96 of the 97 pending drafts belong to a task whose final status was
  // "completed", but for a draft-only task "completed" means "the draft is
  // ready for review" — the completion is the agent finishing the draft, NOT
  // the user acting on it. Auto-discarding on that signal would delete exactly
  // the artifacts the user is supposed to read. So the parent task's state is
  // recorded as context and never used to retire anything.
  //
  // What IS safe: a task with several pending drafts has been re-drafted, and
  // only the newest is the current answer. Measured: 97 pending drafts over 52
  // tasks — 45 superseded copies, worst offender re-drafted 7 times.
  const draftsByTask = new Map();
  for (const d of drafts) {
    if (!d?.taskId) continue;
    if (!draftsByTask.has(d.taskId)) draftsByTask.set(d.taskId, []);
    draftsByTask.get(d.taskId).push(d);
  }
  for (const [taskId, group] of draftsByTask) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
    const winner = sorted[0];
    for (const d of sorted.slice(1)) {
      resolved.push({
        kind: "draft",
        id: d.id,
        title: d.title ?? "(untitled draft)",
        category: d.kind ?? "other",
        source: "agent",
        proposedAt: d.createdAt ?? null,
        ageDays: round1(ageInDays(d.createdAt, nowMs)),
        rule: "superseded-redraft",
        decidedBy: "rule:superseded-redraft",
        confidence: 1,
        reason: `The agent re-drafted this ${group.length}× for the same task; the newest draft (${winner.id}) is the current one.`,
        evidence: {
          taskId,
          taskTitle: taskIndex.get(taskId)?.title ?? null,
          taskStatus: taskIndex.get(taskId)?.status ?? "archived-or-unknown",
          supersededBy: winner.id,
          supersededByCreatedAt: winner.createdAt ?? null,
          draftsForTask: group.length
        },
        summary: d.title ?? ""
      });
    }
  }

  return { resolved, keptFresh, ambiguous };
}

function makeResolution(s, nowMs, rule, reason, evidence) {
  const ageDays = ageInDays(s.proposedAt, nowMs);
  return {
    kind: "suggestion",
    id: s.id,
    title: candidateTitle(s),
    category: s.category ?? "skill",
    source: s.source ?? "unknown",
    proposedAt: s.proposedAt ?? null,
    ageDays: round1(ageDays),
    rule,
    decidedBy: `rule:${rule}`,
    confidence: 1,
    reason,
    evidence: { ...evidence, ageDays: round1(ageDays) },
    summary: candidateTitle(s)
  };
}

/// The compact shape sent to the model — deliberately NOT the whole record.
/// A mined candidate's `proposal.body` is a whole SKILL.md and an observer
/// rationale can run to a paragraph; sending either would multiply the token
/// bill for judgement the model does not need to make this call.
function toCandidate(s, ageDays) {
  const seq = s.sequence;
  const priorModelReviewAt = String(s.autoTriage?.decidedBy ?? "").startsWith("llm:")
    ? s.autoTriage?.at ?? null
    : null;
  return {
    kind: "suggestion",
    id: s.id,
    title: candidateTitle(s),
    category: s.category ?? "skill",
    source: s.source ?? "unknown",
    proposedAt: s.proposedAt ?? null,
    ageDays: round1(ageDays),
    priorModelReviewAt,
    summary: firstSentence(s.rationale ?? s.proposal?.description ?? "").slice(0, 220),
    evidence: seq
      ? { count: seq.count ?? null, distinctDays: seq.distinctDays ?? null, confidence: seq.confidence ?? null, cadence: seq.cadence?.type ?? null }
      : {}
  };
}

/// Weak enough that the miner's own numbers say the pattern never established
/// itself. Note what this rule is NOT: an age rule. Age only decides whether it
/// is even eligible — the retirement is justified by the evidence being thin.
///
/// Confidence alone is not sufficient because miners often report uniformly
/// high confidence. Count and distinct-day floors supply independent evidence
/// that a pattern never established itself.
function weakEvidence(seq) {
  const confidence = Number(seq.confidence);
  const count = Number(seq.count);
  const days = Number(seq.distinctDays);
  return (Number.isFinite(confidence) && confidence < 0.5)
    || (Number.isFinite(count) && count < 3)
    || (Number.isFinite(days) && days < 2);
}

// ─── ranking the survivors ───────────────────────────────────────────────

/// Rank the still-relevant survivors for the compact review surface.
///
/// Only model-judged keeps can be ranked, and that is the honest boundary: a
/// deterministic keep means "too new to judge", not "important". Items the pass
/// never reached are reported as a count, not smuggled into the list.
export function rankCritical(keeps, limit = 10) {
  return [...keeps]
    .sort((a, b) => (b.stillMattersScore - a.stillMattersScore)
      || (b.confidence - a.confidence)
      || (b.ageDays - a.ageDays))
    .slice(0, limit)
    .map((k) => ({
      id: k.id,
      kind: k.kind,
      title: k.title,
      category: k.category,
      score: Number(k.stillMattersScore.toFixed(2)),
      ageDays: k.ageDays,
      why: k.reason,
      decidedBy: k.decidedBy,
      // Every row is a live pending record, so the existing routes act on it.
      acceptPath: `/proactive/suggestions/${encodeURIComponent(k.id)}/accept`
    }));
}

/// A human-checkable slice of what a pass decided: a spread across rules rather
/// than the first ten of one kind, because the point is to let someone judge
/// the JUDGEMENT, and ten copies of "superseded-duplicate" prove nothing.
export function sampleVerdicts(resolutions, keeps, limit = 10) {
  const byRule = new Map();
  for (const r of resolutions) {
    if (!byRule.has(r.rule)) byRule.set(r.rule, []);
    byRule.get(r.rule).push(r);
  }
  if (keeps.length) byRule.set("keep", keeps.map((k) => ({ ...k, rule: "keep" })));
  // Oldest first inside each rule. The samples exist to be argued with, and the
  // decisions worth arguing about are the ones on items that have been sitting
  // longest — a spread that shows only this morning's duplicates proves the
  // rule fired, not that it fired correctly.
  for (const bucket of byRule.values()) bucket.sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0));

  const out = [];
  const rules = [...byRule.keys()];
  let round = 0;
  while (out.length < limit && rules.some((r) => (byRule.get(r) ?? []).length > round)) {
    for (const rule of rules) {
      const bucket = byRule.get(rule) ?? [];
      if (bucket.length <= round || out.length >= limit) continue;
      const v = bucket[round];
      out.push({
        id: v.id,
        kind: v.kind,
        verdict: rule === "keep" ? "keep" : "auto-dismiss",
        rule,
        decidedBy: v.decidedBy,
        title: String(v.title ?? "").slice(0, 90),
        ageDays: v.ageDays,
        reason: v.reason,
        evidence: v.evidence ?? null
      });
    }
    round += 1;
  }
  return out;
}

// ─── undo ────────────────────────────────────────────────────────────────

/// Reverse a whole pass. `passId` may be "latest".
///
/// This is the promise that makes the automation acceptable at all: if a pass
/// judges badly, one call puts every record back exactly as it was, because
/// each one carries its own previousStatus. Records a human has touched since
/// (status no longer matches what the pass wrote) are left alone and reported —
/// undo must never overwrite a real decision with an old one.
export function undoTriagePass(runtime, passId = "latest", { dataDir } = {}) {
  const dir = dataDir
    ?? runtime?.dataDir
    ?? runtime?.proactiveObserver?.dataDir
    ?? runtime?.patternMiner?.dataDir
    ?? resolveDataDir();
  // SEC-3 audit: `passId` is the other path.join(dir, userInput) in this file.
  // It has no HTTP route today, but it is a caller-supplied file stem, so it
  // gets the same segment allowlist + containment assertion.
  const file = safeJoinOrNull(path.join(dir, "backlog-triage"), `${passId === "latest" ? "latest" : passId}.json`);
  if (!file) return { ok: false, error: `invalid pass id: ${String(passId).slice(0, 64)}` };
  const report = readJsonFile(file, null);
  if (!report) return { ok: false, error: `no triage report at ${file}` };

  const result = { ok: true, passId: report.passId, restored: 0, skipped: 0, notFound: 0, drafts: 0 };
  let draftsTouched = false;

  for (const sample of report._resolvedIds ?? []) {
    if (sample.kind === "draft") {
      const d = runtime?.drafts?.get?.(sample.id);
      if (!d) { result.notFound += 1; continue; }
      if (d.status !== AUTO_DISCARDED || d.autoTriage?.passId !== report.passId) { result.skipped += 1; continue; }
      d.status = d.autoTriage.previousStatus ?? "pending";
      d.reviewedAt = null;
      delete d.autoTriage;
      draftsTouched = true;
      result.drafts += 1;
      result.restored += 1;
      continue;
    }
    const f = suggestionFile(dir, sample.id);
    if (!f) { result.notFound += 1; continue; }
    const raw = readJsonFile(f, null);
    if (!raw) { result.notFound += 1; continue; }
    if (raw.status !== AUTO_DISMISSED || raw.autoTriage?.passId !== report.passId) { result.skipped += 1; continue; }
    raw.status = raw.autoTriage.previousStatus ?? "pending";
    raw.resolvedAt = null;
    raw.note = null;
    delete raw.autoTriage;
    writeJsonAtomic(f, raw);
    result.restored += 1;
  }
  if (draftsTouched) runtime?.drafts?.snapshot?.();
  return result;
}

export function readLatestTriageReport(runtime, { dataDir } = {}) {
  const dir = dataDir
    ?? runtime?.dataDir
    ?? runtime?.proactiveObserver?.dataDir
    ?? runtime?.patternMiner?.dataDir
    ?? resolveDataDir();
  return readJsonFile(path.join(dir, "backlog-triage", "latest.json"), null);
}

/// Human-readable pass summary — what the dashboard, the CLI, or a chat reply
/// renders. This is the deliverable for "what are the still most critical most
/// important ones for me to do?".
export function renderTriageMarkdown(report) {
  if (!report) return "_No backlog triage has run yet._";
  const lines = [`## Backlog triage — ${String(report.startedAt ?? "").slice(0, 10)}`];
  if (report.dryRun) lines.push("_Dry run — nothing was changed._");
  lines.push(`Scanned ${report.scanned.suggestions} pending suggestions and ${report.scanned.drafts} pending drafts.`);

  const p = report.prefilter;
  const retired = report.dryRun ? report.applied.wouldApply : report.applied.suggestions + report.applied.drafts;
  lines.push("", "### Cleaned up");
  lines.push(`- ${retired} ${report.dryRun ? "would be retired" : "retired"} (${p.resolved} by rule, ${report.llm.verdicts.dismiss} judged by the model)`);
  for (const [rule, n] of Object.entries(p.byRule ?? {})) lines.push(`  - ${rule}: ${n}`);
  lines.push(`- ${p.keptFresh} left alone (newer than the triage window)`);
  if (report.llm.skipped) lines.push(`- Model pass skipped: ${report.llm.skipped} — ${report.llm.deferred} items still waiting`);
  else lines.push(`- Model judged ${report.llm.itemsJudged ?? report.llm.itemsSent} of ${report.llm.itemsSent} sent in ${report.llm.batches} batch(es); ${report.llm.deferred} deferred to the next pass`);

  if (report.critical.length > 0) {
    lines.push("", "### Still matters most");
    for (const c of report.critical) lines.push(`- **${c.title}** (${c.score.toFixed(2)}, ${Math.round(c.ageDays)}d old) — ${c.why}`);
  } else {
    lines.push("", "_Nothing was judged important enough to promote this pass._");
  }
  lines.push("", `_Undo: openagi triage undo ${report.passId}_`);
  return lines.join("\n");
}

// ─── prompt + cost ───────────────────────────────────────────────────────

export function renderBatchPrompt(batch) {
  return [
    "Triage these backlog items. Return one verdict object per item.",
    "",
    ...batch.map((c, i) => JSON.stringify({
      i,
      kind: c.category,
      title: c.title,
      why: c.summary,
      ageDays: Math.round(c.ageDays),
      evidence: c.evidence
    })),
    "",
    `${batch.length} items. Return a JSON array of exactly ${batch.length} verdicts.`
  ].join("\n");
}

/// Cost estimate for one batch, priced with the SAME table BudgetGuard bills
/// with (priceFor is public), so the number in the report and the number that
/// lands on the credit ledger come from one source.
///
/// Token counts are ~chars/4 — an estimate, and reported as one. The provider
/// records the real usage into BudgetGuard when the call actually happens, and
/// `actual.usd` in the report is the measured delta.
export function estimateBatchCost(budget, model, prompt, batchLength) {
  const inputTokens = Math.ceil((prompt.length + SYSTEM_PROMPT.length) / 4);
  // ~40 tokens of JSON per verdict.
  const outputTokens = batchLength * 40;
  const price = budget?.priceFor?.(model) ?? { in: 3, out: 15 };
  const usd = (inputTokens / 1e6) * price.in + (outputTokens / 1e6) * price.out;
  return { inputTokens, outputTokens, usd };
}

/// How many of the planned batches today's remaining budget can carry, at the
/// share this job is allowed. Returns the batch count to actually run.
function trimToBudget(budget, estimates, fraction) {
  const remaining = budget?.status?.()?.remainingUsd;
  if (!Number.isFinite(remaining)) return estimates.length;
  const allowance = Math.max(0, remaining) * fraction;
  let spend = 0;
  for (let i = 0; i < estimates.length; i += 1) {
    spend += estimates[i].usd;
    if (spend > allowance) return i;
  }
  return estimates.length;
}

// ─── small helpers ───────────────────────────────────────────────────────

function emptyReport(passId, startedAt, dryRun) {
  return {
    version: 1,
    passId,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    dryRun,
    scanned: { suggestions: 0, drafts: 0 },
    prefilter: { resolved: 0, keptFresh: 0, ambiguous: 0, byRule: {} },
    llm: {
      attempted: false, skipped: null, model: null, batches: 0, itemsSent: 0, itemsJudged: 0,
      deferred: 0, verdicts: { dismiss: 0, keep: 0, unsure: 0, invalid: 0, duplicate: 0, missing: 0, lowConfidence: 0 },
      estimated: { inputTokens: 0, outputTokens: 0, usd: 0 }, actual: null, stoppedEarly: null
    },
    applied: { suggestions: 0, drafts: 0, keepsAnnotated: 0, deferralsAnnotated: 0, failed: 0, cappedAt: null, wouldApply: 0 },
    critical: [],
    samples: [],
    _resolvedIds: [],
    degraded: []
  };
}

/// Small, loggable shape of a pass. The full report carries every sample and
/// the undo ledger, which is far too big to store in a cron fire record or push
/// down an SSE channel — this is what those get.
export function summarizeTriagePass(report) {
  return {
    at: nowIso(),
    passId: report.passId,
    dryRun: report.dryRun,
    scanned: report.scanned,
    retired: report.applied.suggestions + report.applied.drafts,
    byRule: report.prefilter.byRule,
    modelJudged: report.llm.itemsJudged ?? report.llm.itemsSent,
    deferred: report.llm.deferred,
    critical: report.critical.length,
    degraded: report.degraded
  };
}

function auditBlock(resolution, passId, previousStatus) {
  return {
    passId,
    at: nowIso(),
    verdict: "auto-dismiss",
    rule: resolution.rule,
    decidedBy: resolution.decidedBy,
    reason: resolution.reason,
    evidence: resolution.evidence ?? null,
    confidence: resolution.confidence ?? null,
    previousStatus
  };
}

function suggestionFile(dataDir, id) {
  // Mirrors suggestion-feed.js findSourceFile. Not imported because that helper
  // is private to that module and this one needs the PATH (to write the audit
  // block atomically in one pass), not just a status flip.
  // SEC-3: ids reaching here come from model verdicts and from the same
  // percent-encoded routes suggestion-feed serves, so the segment is validated
  // and the resolved path is asserted to stay inside the intended directory
  // before any read/write. Same guard, same reasons — see path-guard.js.
  const candidates = [
    safeJoinOrNull(path.join(dataDir, "proactive", "suggestions"), `${id}.json`),
    safeJoinOrNull(path.join(dataDir, "skills-suggested"), `${id}.json`)
  ].filter(Boolean);
  return candidates.find((f) => fs.existsSync(f)) ?? null;
}

function indexTasks(runtime) {
  const map = new Map();
  for (const t of runtime?.tasks?.list?.({ limit: 2000 }) ?? []) map.set(t.id, t);
  return map;
}

/// Prose title for a candidate. Mined candidates title themselves with the SLUG
/// of the skill they would create, so prefer the description sentence — the
/// same choice daily-brief.js makes, for the same reason.
export function candidateTitle(s) {
  const described = firstSentence(s?.proposal?.description ?? "");
  if (described) return described;
  const title = String(s?.title ?? "").trim();
  return title || s?.id || "(untitled)";
}

const STOPWORDS = new Set(("the a an and or of to for in on at it is with your you this that from by as be after " +
  "before when while into out up down over under again then once here there all any both each few more most other " +
  "some such no nor not only own same so than too very can will just should now do does did doing have has had " +
  "having i me my we our us they them their he she his her its").split(" "));

export function titleTokens(title) {
  return new Set(
    String(title ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((t) => t.length > 2 && !STOPWORDS.has(t))
  );
}

export function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  if (inter === 0) return 0;
  return inter / (a.size + b.size - inter);
}

/// Canonical identity of a mined app loop.
///
/// The miner emits the same alternation at several window lengths, so
/// "zoom→wow→zoom→wow" and "wow→zoom→wow→zoom→wow→zoom" are one workflow
/// described twice. Collapse consecutive repeats, drop the trailing element
/// that just closes the loop, reduce to the minimal repeating period, then
/// rotate to the lexicographically smallest start so rotations agree.
export function canonicalCycle(fingerprint) {
  const parts = String(fingerprint ?? "").split("→").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return String(fingerprint ?? "");
  const deduped = [];
  for (const p of parts) if (deduped[deduped.length - 1] !== p) deduped.push(p);
  while (deduped.length > 1 && deduped[deduped.length - 1] === deduped[0]) deduped.pop();
  const period = minimalPeriod(deduped);
  let best = null;
  for (let i = 0; i < period.length; i += 1) {
    const rotation = period.slice(i).concat(period.slice(0, i)).join("→");
    if (best === null || rotation < best) best = rotation;
  }
  return best ?? String(fingerprint ?? "");
}

function minimalPeriod(seq) {
  const n = seq.length;
  for (let p = 1; p <= n / 2; p += 1) {
    if (n % p !== 0) continue;
    let ok = true;
    for (let i = 0; i < n; i += 1) if (seq[i] !== seq[i % p]) { ok = false; break; }
    if (ok) return seq.slice(0, p);
  }
  return seq;
}

function byNewestFirst(a, b) {
  const cmp = String(b.proposedAt ?? "").localeCompare(String(a.proposedAt ?? ""));
  return cmp !== 0 ? cmp : String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

function ageInDays(iso, nowMs) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (nowMs - t) / DAY_MS);
}

function firstSentence(text) {
  const s = String(text ?? "").trim();
  if (!s) return "";
  const m = s.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (m ? m[0] : s).trim();
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function countBy(items, keyFn) {
  const out = {};
  for (const item of items) {
    const k = keyFn(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/// Extract the JSON array from a model reply. Tolerates fences and leading
/// prose; returns [] rather than throwing, because a garbled reply must cost a
/// batch, never the pass.
export function parseJsonArray(text) {
  const s = String(text ?? "");
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safely(degraded, label, fn, fallback) {
  try {
    return fn();
  } catch (error) {
    degraded.push(`${label}: ${String(error?.message ?? error).slice(0, 120)}`);
    return fallback;
  }
}

function round1(n) {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

function fmt(n) {
  return Number.isFinite(Number(n)) ? Number(n).toFixed(2) : "n/a";
}
