import { listAllSuggestions } from "../suggestion-feed.js";
import { editSimilarity } from "./edit-similarity.js";

// Grades the system's own work by what happened to it afterwards: a draft
// approved untouched, edited, or discarded; a suggestion accepted, rejected
// or left unanswered; a task the agent completed that stayed done or was
// reopened. These grades come from the owner's actions, never from the
// system scoring itself. Every method is best-effort: grading must never
// break the action it observes, so failures are swallowed.

const DAY_MS = 86_400_000;
const DRAFT_IGNORED_DAYS = 14;
const SUGGESTION_STALLED_DAYS = 30;
const TASK_HELD_DAYS = 7;

export const FATES = {
  approved: { score: 1.0, weak: false },
  sent: { score: 1.0, weak: false },
  discarded: { score: 0.0, weak: false },
  "ignored-delivered": { score: 0.2, weak: true },
  "ignored-undelivered": { score: null, weak: false },
  accepted: { score: 0.7, weak: false },
  // A task created automatically from a suggestion: no owner vote yet, so no
  // grade until the task is done (accepted-done) or stalls (accepted-stalled).
  "auto-accepted": { score: null, weak: false },
  "accepted-done": { score: 1.0, weak: false },
  "accepted-stalled": { score: 0.5, weak: false },
  rejected: { score: 0.0, weak: false },
  dismissed: { score: 0.1, weak: false },
  "silence-delivered": { score: 0.2, weak: true },
  "silence-undelivered": { score: null, weak: false },
  held: { score: 0.8, weak: true },
  reopened: { score: 0.1, weak: false },
  "rated-up": { score: 0.9, weak: false },
  "rated-down": { score: 0.15, weak: false }
};

const SUGGESTION_STATUS_FATES = { accepted: "accepted", "auto-accepted": "auto-accepted", rejected: "rejected", dismissed: "dismissed" };
const UPGRADABLE_FATES = new Set(["accepted", "auto-accepted", "accepted-stalled"]);

export function editedDraftScore(similarity) {
  return 0.4 + 0.6 * Math.max(0, Math.min(1, similarity));
}

export class GroundedOutcomes {
  constructor({ runtime } = {}) {
    this.runtime = runtime ?? null;
  }

  get outcomes() {
    return this.runtime?.outcomes ?? null;
  }

  _safe(fn) {
    try {
      if (!this.outcomes) return null;
      return fn();
    } catch {
      return null;
    }
  }

  _ground(outcome, fate, { source, detail = null, score } = {}) {
    if (!outcome) return null;
    const preset = FATES[fate] ?? { score: null, weak: false };
    return this.outcomes.ground(outcome.id, {
      score: score === undefined ? preset.score : score,
      source,
      fate,
      weak: preset.weak,
      detail
    });
  }

  _work(kind, refId, at, signal = null) {
    return this.outcomes.byWorkRef(kind, refId)
      ?? this.outcomes.recordWork({ kind, refId, at, signal });
  }

  // ── drafts ────────────────────────────────────────────────────────────
  onDraftCreated(draft, signal = null) {
    return this._safe(() => this.outcomes.byWorkRef("work-draft", draft.id)
      ?? this.outcomes.recordWork({ kind: "work-draft", refId: draft.id, signal }));
  }

  onDraftResolved(draft, status) {
    return this._safe(() => {
      if (!draft?.id) return null;
      const outcome = this._work("work-draft", draft.id, draft.createdAt);
      if (status === "discarded") return this._ground(outcome, "discarded", { source: "draft" });
      if (status !== "approved" && status !== "sent") return null;
      if (!draft.editedAt) return this._ground(outcome, status === "sent" ? "sent" : "approved", { source: "draft" });
      if (typeof draft.originalBody !== "string") {
        return this._ground(outcome, "approved-edited", { source: "draft", score: 0.7, detail: { similarityUnknown: true } });
      }
      const similarity = editSimilarity(draft.originalBody, draft.body);
      return this._ground(outcome, "approved-edited", {
        source: "draft", score: editedDraftScore(similarity), detail: { similarity: Number(similarity.toFixed(3)) }
      });
    });
  }

  // ── suggestions ───────────────────────────────────────────────────────
  onSuggestionProposed(suggestion) {
    return this._safe(() => {
      const outcome = this.outcomes.byWorkRef("work-suggestion", suggestion.id)
        ?? this.outcomes.recordWork({ kind: "work-suggestion", refId: suggestion.id, at: suggestion.proposedAt });
      return outcome?.id ?? null;
    });
  }

  onSuggestionResolved(suggestion, status) {
    return this._safe(() => {
      if (!suggestion?.id) return null;
      const outcome = this._work("work-suggestion", suggestion.id, suggestion.proposedAt);
      if (status === "auto-dismissed") {
        const fate = this.delivered("suggestion", suggestion.id) ? "silence-delivered" : "silence-undelivered";
        return this._ground(outcome, fate, { source: "suggestion" });
      }
      const fate = SUGGESTION_STATUS_FATES[status];
      if (!fate) return null;
      // Resolved after its task was already done (e.g. graded by backfill):
      // the completion already happened, so grade it as done now.
      if (UPGRADABLE_FATES.has(fate) && this.linkedTask(suggestion.id)?.status === "completed") {
        return this._ground(outcome, "accepted-done", { source: "suggestion" });
      }
      return this._ground(outcome, fate, { source: "suggestion" });
    });
  }

  /** The task created from a suggestion, if any (newest first). */
  linkedTask(suggestionId) {
    if (!suggestionId) return null;
    const tasks = this.runtime?.tasks?.list?.({ limit: 100000 }) ?? [];
    return tasks.filter((t) => t?.sourceMeta?.suggestionId === suggestionId)
      .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))[0] ?? null;
  }

  onSuggestionTaskCompleted(suggestionId) {
    return this._safe(() => {
      const outcome = this.outcomes.byWorkRef("work-suggestion", suggestionId);
      if (!outcome || !UPGRADABLE_FATES.has(outcome.groundedFate)) return null;
      return this._ground(outcome, "accepted-done", { source: "suggestion" });
    });
  }

  // ── agent-completed tasks ─────────────────────────────────────────────
  onAgentTaskCompleted(task, signal = null) {
    return this._safe(() => this.outcomes.byWorkRef("work-task", task.id)
      ?? this.outcomes.recordWork({ kind: "work-task", refId: task.id, signal, metadata: { byAgent: true } }));
  }

  onTaskReopened(task) {
    return this._safe(() => {
      const outcome = this.outcomes.byWorkRef("work-task", task?.id);
      return outcome ? this._ground(outcome, "reopened", { source: "task" }) : null;
    });
  }

  // ── direct ratings ────────────────────────────────────────────────────
  onRated(outcome, verdict) {
    return this._safe(() => {
      if (!outcome || (verdict !== "up" && verdict !== "down")) return null;
      return this._ground(outcome, verdict === "up" ? "rated-up" : "rated-down", { source: "rating" });
    });
  }

  // ── time-based fates ──────────────────────────────────────────────────
  sweep({ now = new Date() } = {}) {
    const result = { grounded: 0, byFate: {} };
    this._safe(() => {
      const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
      const count = (fate) => { result.grounded += 1; result.byFate[fate] = (result.byFate[fate] ?? 0) + 1; };
      for (const draft of this.runtime?.drafts?.list?.({ status: "pending" }) ?? []) {
        if (t - Date.parse(draft.createdAt) < DRAFT_IGNORED_DAYS * DAY_MS) continue;
        const outcome = this._work("work-draft", draft.id, draft.createdAt);
        if (outcome.groundedFate) continue;
        const fate = this.delivered("draft", draft.id) ? "ignored-delivered" : "ignored-undelivered";
        this._ground(outcome, fate, { source: "draft" });
        count(fate);
      }
      for (const outcome of [...this.outcomes.outcomes.values()]) {
        if (outcome.kind === "work-suggestion" && outcome.groundedFate === "accepted-stalled") {
          // A stalled suggestion whose task got done later, by any route.
          if (this.linkedTask(outcome.refId)?.status === "completed") {
            this._ground(outcome, "accepted-done", { source: "suggestion" });
            count("accepted-done");
          }
        } else if (outcome.kind === "work-suggestion" && (outcome.groundedFate === "accepted" || outcome.groundedFate === "auto-accepted")
            && t - Date.parse(outcome.groundedAt) >= SUGGESTION_STALLED_DAYS * DAY_MS) {
          // Only suggestions that became a task can stall. A skill, an MCP
          // connection or saved knowledge is done when accepted and keeps that grade.
          const task = this.linkedTask(outcome.refId);
          if (!task) continue;
          const fate = task.status === "completed" ? "accepted-done" : "accepted-stalled";
          this._ground(outcome, fate, { source: "suggestion" });
          count(fate);
        } else if (outcome.kind === "work-task" && !outcome.groundedFate) {
          const task = this.runtime?.tasks?.get?.(outcome.refId);
          if (task?.status === "completed" && task.completedAt
              && t - Date.parse(task.completedAt) >= TASK_HELD_DAYS * DAY_MS) {
            this._ground(outcome, "held", { source: "task" });
            count("held");
          }
        }
      }
    });
    return result;
  }

  /**
   * Grade work resolved before grading existed. Dry run unless apply is true.
   * Skips anything that already has a grounded grade, so repeated runs are safe.
   */
  backfill({ apply = false } = {}) {
    const report = { dryRun: !apply, suggestions: { byFate: {} }, drafts: { byFate: {} }, skipped: 0 };
    this._safe(() => {
      const already = (kind, id) => Boolean(this.outcomes.byWorkRef(kind, id)?.groundedFate);
      const bump = (bucket, fate) => { bucket.byFate[fate] = (bucket.byFate[fate] ?? 0) + 1; };
      for (const s of listAllSuggestions(this.runtime, { status: null }) ?? []) {
        if (!s?.id || !s.status || s.status === "pending") continue;
        // An "accepted" status written by automatic task creation is not an owner vote.
        const status = s.status === "accepted" && s.taskAutoCreated ? "auto-accepted" : s.status;
        const fate = status === "auto-dismissed"
          ? (this.delivered("suggestion", s.id) ? "silence-delivered" : "silence-undelivered")
          : SUGGESTION_STATUS_FATES[status];
        if (!fate) continue;
        if (already("work-suggestion", s.id)) { report.skipped += 1; continue; }
        bump(report.suggestions, fate);
        if (apply) this.onSuggestionResolved(s, status);
      }
      for (const d of this.runtime?.drafts?.list?.({ status: null }) ?? []) {
        if (!["approved", "discarded", "sent"].includes(d.status)) continue;
        if (already("work-draft", d.id)) { report.skipped += 1; continue; }
        const fate = d.status === "discarded" ? "discarded" : d.editedAt ? "approved-edited" : d.status;
        bump(report.drafts, fate);
        if (apply) this.onDraftResolved(d, d.status);
      }
    });
    return report;
  }

  delivered(kind, id) {
    try {
      const items = this.runtime?.outreach?.list?.() ?? [];
      return items.some((i) => i?.sourceRef?.kind === kind && i.sourceRef.id === id && i.status !== "unseen");
    } catch {
      return false;
    }
  }
}
