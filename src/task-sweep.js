// Task-list hygiene sweep.
//
// Auto-extracted tasks (iMessage follow-ups, observer suggestions) pile up:
// near-duplicates, items already handled, and things filed in the wrong queue
// (the extractor defaults everything to the user queue, but many "reply to X"
// items are things Peri can do itself). Left alone the list becomes noise and
// the morning digest / autopilot pickup lose signal.
//
// This runs periodically and:
//   1. Dedupes — rule-based, deterministic. Within each queue, near-identical
//      titles collapse to the highest-priority/earliest one; the rest are
//      cancelled. No model cost.
//   2. Re-homes + judges — a CHEAP "sweep" tier (mini) pass classifies each
//      remaining active task: which queue it belongs in (agent vs user),
//      whether an agent task should be acted on or only drafted, and whether
//      it's stale/obsolete. Stale AUTO-sourced tasks are cancelled; stale
//      manual/external (Linear, BuildBetter) tasks are only flagged for review
//      so we never silently drop something the user filed by hand.
//   3. Archives — terminal tasks (completed/cancelled) older than the archive
//      window are removed from the active store. The append-only JSONL event
//      log still retains them for history.
//
// Agent-queue convention (matches the autopilot prompt): a task tagged
// `plan-action` is DRAFT-ONLY — autopilot prepares the artifact but never sends
// externally. Untagged agent tasks are safe to fully execute.

import { nowIso } from "./utils.js";

// Sources we created automatically — safe to auto-cancel when stale. Anything
// else (manual, linear, buildbetter) is the user's; we only flag those.
const AUTO_SOURCES = new Set(["imessage", "observer", "proactive", "proactive-observer", "inbox"]);
const ACTIVE = new Set(["pending", "in_progress", "blocked"]);
const ARCHIVE_DAYS_DEFAULT = 14;

const SYSTEM_PROMPT = [
  "You are tidying an AI assistant's task list. \"Peri\" is the assistant; \"Spencer\" is the human owner.",
  "You receive a JSON array of tasks: [{i, queue, source, title}].",
  "For EACH task return an object {i, queue, action, stale} and nothing else:",
  '- queue: "agent" if Peri can do it itself (reply to a text, look something up, remember a fact,',
  '  draft/introduce, summarize); "user" if only Spencer can (in-person actions, personal decisions,',
  "  anything needing his own judgment or accounts).",
  '- action: only for queue "agent". "draft" if completing it SENDS something externally (a text, email,',
  '  Slack/DM) — Peri should prepare but not send. "act" if it is safe to just do (lookups, remembering,',
  '  internal notes). Use null for queue "user".',
  "- stale: true if the task is obsolete, already handled, superseded by a newer one, or a near-duplicate",
  "  of another in the list; otherwise false.",
  "Return STRICT JSON array only — one object per input task, echoing the same i. No prose."
].join("\n");

export class TaskSweep {
  constructor({ runtime, archiveDays } = {}) {
    this.runtime = runtime;
    this.archiveDays = Number(archiveDays ?? process.env.OPENAGI_TASK_ARCHIVE_DAYS) || ARCHIVE_DAYS_DEFAULT;
  }

  async sweep({ now = new Date() } = {}) {
    const tasks = this.runtime?.tasks;
    if (!tasks?.list) return { skipped: true, reason: "no task store" };

    const summary = { deduped: 0, requeued: 0, cancelledStale: 0, retagged: 0, flagged: 0, archived: 0, considered: 0 };

    // 1) Rule-based dedup within each queue.
    const active = tasks.list({ limit: 1000 }).filter((t) => ACTIVE.has(t.status));
    summary.considered = active.length;
    for (const queue of ["user", "agent"]) {
      const groups = new Map();
      for (const t of active.filter((t) => t.queue === queue)) {
        const key = normalizeTitle(t.title);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(t);
      }
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        group.sort((a, b) => (b.priority - a.priority) || (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
        for (const dup of group.slice(1)) {
          tasks.update(dup.id, { status: "cancelled" });
          summary.deduped++;
        }
      }
    }

    // 2) Cheap LLM pass: re-home, action-tag, stale-judge what's left.
    const remaining = tasks.list({ limit: 1000 }).filter((t) => ACTIVE.has(t.status));
    const provider = this.runtime?.agentHost?.modelProvider;
    const haveLLM = provider?.isConfigured?.() && provider.constructor.name !== "DeterministicModelProvider";
    if (haveLLM && remaining.length) {
      try {
        const input = remaining.map((t, i) => ({ i, queue: t.queue, source: t.source, title: t.title }));
        const result = await provider.generate({
          input: JSON.stringify(input),
          task: "sweep",
          instructions: SYSTEM_PROMPT,
          agent: { id: "task-sweep", name: "task-sweep" },
          memoryHits: [], messages: [], tools: [], toolRegistry: null, context: {}
        });
        for (const v of safeJsonArray(result?.text)) {
          const t = remaining[v?.i];
          if (!t) continue;
          // Stale → cancel auto-sourced; flag everything else for review.
          if (v.stale === true) {
            if (AUTO_SOURCES.has(t.source)) { tasks.update(t.id, { status: "cancelled" }); summary.cancelledStale++; continue; }
            if (addTag(tasks, t, "review")) summary.flagged++;
          }
          const targetQueue = v.queue === "agent" || v.queue === "user" ? v.queue : t.queue;
          if (targetQueue !== t.queue && tasks.setQueue) { tasks.setQueue(t.id, targetQueue); summary.requeued++; }
          // Agent tasks: draft-only (external send) carry `plan-action`; safe ones don't.
          if (targetQueue === "agent") {
            const changed = v.action === "draft" ? addTag(tasks, t, "plan-action") : removeTag(tasks, t, "plan-action");
            if (changed) summary.retagged++;
          }
        }
      } catch { /* hygiene is best-effort; dedup + archive still applied */ }
    }

    // 3) Archive terminal tasks older than the window.
    const cutoff = now.getTime() - this.archiveDays * 86_400_000;
    for (const t of tasks.list({ limit: 2000 })) {
      if (t.status !== "completed" && t.status !== "cancelled") continue;
      const ts = Date.parse(t.completedAt || t.updatedAt || t.createdAt || "");
      if (Number.isFinite(ts) && ts < cutoff && tasks.remove) { tasks.remove(t.id); summary.archived++; }
    }

    summary.at = nowIso();
    return summary;
  }
}

// Collapse a title to a comparison key: lowercase, drop punctuation, squash
// whitespace. Catches "Reply on Slack" / "Reply on Slack." / "reply on  slack".
function normalizeTitle(title) {
  return String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function addTag(tasks, task, tag) {
  const tagsArr = Array.isArray(task.tags) ? task.tags : [];
  if (tagsArr.includes(tag)) return false;
  tasks.update(task.id, { tags: [...tagsArr, tag] });
  return true;
}

function removeTag(tasks, task, tag) {
  const tagsArr = Array.isArray(task.tags) ? task.tags : [];
  if (!tagsArr.includes(tag)) return false;
  tasks.update(task.id, { tags: tagsArr.filter((x) => x !== tag) });
  return true;
}

function safeJsonArray(text) {
  if (!text) return [];
  const m = String(text).match(/\[[\s\S]*\]/);
  try { const v = JSON.parse(m ? m[0] : text); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
