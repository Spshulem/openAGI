import path from "node:path";
import { ensureDir, writeJsonAtomic, readJsonFile } from "./file-utils.js";
import { createId, nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

// The "ask me when you can't decide" queue — the trust valve for the
// living todo. When task reconciliation (proactive-observer) lands in the
// ambiguous confidence band — too uncertain to auto-complete, too strong
// to silently drop — it parks a clarification here instead of guessing.
//
// The user answers in one tap ("yes, done" / "still working" / "no" /
// "dropped"); the answer resolves the underlying task AND is recorded as
// an outcome so future reconciliation can calibrate. This lets the
// auto-complete path stay aggressive without being wrong, because the
// gray area becomes a question rather than a bad guess.
//
// Schema for a clarification:
//   { id, taskId, question, context, proposedAction, confidence, sources[],
//     status: "pending"|"answered"|"dismissed", answer?, answeredAt?,
//     createdAt }
//
// Low volume → full snapshot on every mutation (same durability posture
// as TaskStore after its add/update snapshot fix).

const VALID_ANSWERS = ["yes", "in_progress", "no", "dropped"];

export class ClarificationStore {
  constructor({ dir, runtime } = {}) {
    this.dir = dir ?? path.join(resolveDataDir(), "clarifications");
    this.runtime = runtime ?? null;
    ensureDir(this.dir);
    this.items = new Map();
    this._load();
  }

  bindRuntime(runtime) {
    this.runtime = runtime;
  }

  list({ status = "pending" } = {}) {
    const all = [...this.items.values()];
    const filtered = status ? all.filter((c) => c.status === status) : all;
    return filtered.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
  }

  get(id) {
    return this.items.get(id) ?? null;
  }

  pendingForTask(taskId) {
    return [...this.items.values()].find((c) => c.taskId === taskId && c.status === "pending") ?? null;
  }

  /// Park a question about a task. Deduped: if a pending clarification for
  /// the same task already exists, returns it untouched rather than
  /// stacking duplicates (the observer re-runs frequently).
  add({ taskId, question, context, proposedAction, confidence, sources }) {
    if (!taskId) throw new Error("clarification requires a taskId");
    const existing = this.pendingForTask(taskId);
    if (existing) return existing;
    const item = {
      id: createId("clar"),
      taskId,
      question: String(question ?? "").trim() || "Did you finish this?",
      context: context ?? "",
      proposedAction: proposedAction === "in_progress" ? "in_progress" : "complete",
      confidence: Number.isFinite(confidence) ? Number(confidence) : null,
      sources: Array.isArray(sources) ? sources.filter((s) => typeof s === "string") : [],
      status: "pending",
      answer: null,
      answeredAt: null,
      createdAt: nowIso()
    };
    this.items.set(item.id, item);
    this.snapshot();
    this.runtime?.events?.emit?.("clarification-created", item);
    return item;
  }

  /// Answer a clarification. Resolves the underlying task per the answer
  /// and records an outcome for confidence calibration. Returns
  /// { clarification, task } or null when the clarification is unknown.
  answer(id, rawAnswer) {
    const item = this.items.get(id);
    if (!item || item.status !== "pending") return null;
    const answer = VALID_ANSWERS.includes(rawAnswer) ? rawAnswer : null;
    if (!answer) throw new Error(`invalid answer: ${rawAnswer} (expected one of ${VALID_ANSWERS.join(", ")})`);

    item.status = "answered";
    item.answer = answer;
    item.answeredAt = nowIso();

    let task = null;
    const tasks = this.runtime?.tasks;
    if (tasks?.get?.(item.taskId)) {
      if (answer === "yes") {
        // User-confirmed completion is the strongest possible signal.
        task = tasks.complete(item.taskId, "user");
      } else if (answer === "in_progress") {
        task = tasks.update(item.taskId, { status: "in_progress" });
      } else if (answer === "dropped") {
        task = tasks.update(item.taskId, { status: "cancelled", bucket: "done" });
      } else if (answer === "no") {
        // Not done and still wanted — leave it pending so it resurfaces.
        task = tasks.get(item.taskId);
      }
    }

    // Record an outcome so reconciliation can calibrate: a "yes" means our
    // proposed auto-complete WOULD have been right; "no" means we were
    // about to be wrong. Lets the confidence-band tuning learn over time.
    if (this.runtime?.outcomes?.record) {
      const score = answer === "yes" ? 0.95 : answer === "in_progress" ? 0.6 : answer === "dropped" ? 0.3 : 0.05;
      const outcome = this.runtime.outcomes.record({
        kind: "clarification-answered",
        refId: item.id,
        metadata: {
          taskId: item.taskId,
          proposedAction: item.proposedAction,
          proposedConfidence: item.confidence,
          sources: item.sources,
          answer
        }
      });
      this.runtime.outcomes.resolve?.(outcome.id, score, "clarification-answered");
    }

    this.snapshot();
    this.runtime?.events?.emit?.("clarification-resolved", { clarification: item, answer, task });
    return { clarification: item, task };
  }

  dismiss(id) {
    const item = this.items.get(id);
    if (!item || item.status !== "pending") return null;
    item.status = "dismissed";
    item.answeredAt = nowIso();
    this.snapshot();
    this.runtime?.events?.emit?.("clarification-resolved", { clarification: item, answer: null, task: null });
    return item;
  }

  snapshot() {
    writeJsonAtomic(path.join(this.dir, "snapshot.json"), {
      version: 1,
      writtenAt: nowIso(),
      items: [...this.items.values()]
    });
  }

  _load() {
    const snap = readJsonFile(path.join(this.dir, "snapshot.json"), null);
    if (!snap) return;
    for (const c of snap.items ?? []) this.items.set(c.id, c);
  }
}
