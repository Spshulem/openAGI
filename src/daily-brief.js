// src/daily-brief.js
// Composes the Quick Ask popover's daily brief: a short, ranked, inline-
// actionable list drawn from the plan cache, tasks, suggestions, drafts and
// clarifications.
//
// Two rules drive the whole design:
//
// 1. NO LLM, NO HTTP on this path. GET /plan/daily re-runs the model on every
//    request and BudgetGuard throws at the daily cap, so the brief reads the
//    plan CACHE written by the 08:00 cron and otherwise touches only stores.
//    That also keeps this a pure function of (stores, clock) — directly
//    testable without a server.
//
// 2. SCORES ARE ONLY COMPARABLE WITHIN A KIND. Suggestions carry no dueDate
//    and no priority (measured: 0 of 1092 pending on a real install), so a
//    single due-date-weighted formula scores them all identically and tasks
//    take every slot — the brief silently becomes a task list. Instead we
//    allocate slots per kind and rank inside each kind on evidence that kind
//    actually has.
import fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";
import { listAllSuggestions } from "./suggestion-feed.js";
import { planDateKey } from "./daily-planner.js";

// Bucket order, mirrored from task-store.js. "done" never enters the brief.
const BUCKETS = ["today", "this_week", "this_month", "this_quarter", "this_year", "someday", "done"];
const VALID_CLARIFICATION_ANSWERS = ["yes", "in_progress", "no", "dropped"];
const CLARIFICATION_LABELS = { yes: "Yes", in_progress: "In progress", no: "Not yet", dropped: "Dropped" };
// Suggestion categories the accept route can genuinely act on. Read off the
// POST /proactive/suggestions/:id/(accept|reject|dismiss) handler in
// hosted-interface.js, which branches on candidate.category: "mcp" registers +
// connects the server, "task" materializes a task, "skill" writes a SKILL.md,
// "knowledge" remembers it into the memory store. Everything else falls through
// to a bare commit({}) — status flipped to accepted, nothing created.
//
// This is an ALLOWLIST, and it has to be, because the blocklist it replaces
// (just "automation") FAILED OPEN. Verified live: a suggestion with category
// "reminder" rendered a "Yes" button, was marked accepted on disk, had zero
// side effect, and reported "Suggestion accepted" to the user. Failing open on
// this path means telling someone an action happened when it did not — the one
// thing this brief must never do — and every category added server-side in
// future silently inherits that lie. Failing CLOSED costs a hidden row until
// somebody adds the branch, which is a row we could not have honoured anyway.
//
// So: a category off this list is invisible, exactly like "automation" was.
// Adding an accept branch means adding the category here, in the same commit.
const ACTIONABLE_SUGGESTION_CATEGORIES = new Set(["mcp", "task", "skill", "knowledge"]);

// What accepting a suggestion actually DOES, per category — read straight off
// the accept branches in hosted-interface.js (see ACTIONABLE_SUGGESTION_CATEGORIES
// above for the mapping). A bare "Yes" named the answer, not the consequence:
// for a mined skill candidate "Yes" writes a SKILL.md into the user's skills
// dir, and the row never said so. The user's words on the shipped version were
// "Is that an idea of what actions it wants me to take? It's not very clear
// what it's trying to do." These labels are the answer to that question, and
// they must stay in lockstep with the branch they name — a label that promises
// something the server does not do is the same lie the allowlist exists to
// prevent, just told in the button instead of the row.
const ACCEPT_LABELS = {
  mcp: "Connect it",
  task: "Add as task",
  skill: "Save as skill",
  knowledge: "Remember it"
};

// Statuses the brief treats as open work. MEASURED on the user's install: of 32
// tasks, 16 user tasks are "in_progress" and exactly ONE is "pending" — so
// filtering on status "pending" (which this composer did) hid every single
// thing the user was actually working on and rendered a task-free brief on an
// install with sixteen live commitments.
//
// "blocked" is deliberately absent: task-store sets it for tasks with unmet
// dependencies precisely so the UI does not surface them, and nothing the user
// can tap from a one-row popover would unblock one. "completed"/"cancelled"
// are done.
const ACTIVE_TASK_STATUSES = ["pending", "in_progress"];

// Statuses a draft's GENERATING task can be retired from, i.e. the states in
// which "stop asking" is a thing that can still happen. Deliberately excludes
// both terminal states, for opposite reasons: a "cancelled" task is already
// retired, and a "completed" one must NEVER be flipped to cancelled — that
// would destroy a real outcome the user earned in order to silence a row.
// "blocked" is in, because a blocked agent task is exactly the one the sweep
// parks after three failed attempts and the one most likely to be re-served if
// its blocker ever clears.
const RETIRABLE_TASK_STATUSES = new Set(["pending", "in_progress", "blocked"]);

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/// Slot budget per kind for a given limit. focus is pinned above the rest;
/// the suggestion floor is what guarantees the agent's own findings always
/// get a seat, which is the entire point of the feature.
function slotPlan(limit) {
  return { focus: 1, clarification: 1, draft: 1, task: 2, suggestionFloor: 1, limit };
}

export function composeBrief(runtime, { now = new Date(), limit = 5, dataDir } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const degraded = [];
  // AbiRuntime does NOT carry a dataDir property, and resolveDataDir() memoizes
  // its first result process-wide — so a caller that knows the right directory
  // (the route does) MUST pass it, or a second differently-configured instance
  // in one process silently reads the first one's files.
  const resolvedDataDir = dataDir ?? runtime?.dataDir ?? resolveDataDir();
  const plan = safely(degraded, "plan", () => readPlanCache(resolvedDataDir, now), null);
  // Focus rows the user cleared TODAY. Deliberately outside safely(): a
  // suppression that cannot be read costs the suppression, not the brief, and
  // reporting "couldn't read today's plan" would be false — the plan itself
  // read fine. Worst case the pinned row comes back and can be dismissed again.
  const dismissedFocus = readFocusDismissals(resolvedDataDir, now);

  const tasks = safely(degraded, "tasks", () => listActiveTasks(runtime), []);
  const drafts = safely(degraded, "drafts", () => runtime.drafts?.list?.({ status: "pending" }) ?? [], []);
  const clarifications = safely(degraded, "clarifications", () => runtime.clarifications?.list?.({ status: "pending" }) ?? [], []);
  const suggestions = safely(degraded, "suggestions", () => listAllSuggestions(runtime, { status: "pending" }) ?? [], []);
  // listAllSuggestions() catches its own readdir errors and returns [], so the
  // safely() boundary above can NEVER see a broken store — an unreadable
  // suggestion queue would otherwise be reported as a healthy empty one. Ask
  // the filesystem directly instead.
  //
  // Probe UNCONDITIONALLY, not just when the list came back empty: the feed
  // walks TWO directories (proactive/suggestions and skills-suggested), so one
  // can be unreadable while the other still returns rows. Gating on an empty
  // list let a half-broken store report as healthy with most of the queue
  // silently missing.
  //
  // Resolve the dirs the way the feed itself does (suggestion-feed.js), not via
  // the caller's dataDir override — AbiRuntime carries no dataDir, so the feed
  // falls back to its sub-stores' own paths and can be reading somewhere else
  // entirely.
  if (!degraded.includes("suggestions") && suggestionStoreUnreadable(suggestionDataDir(runtime, resolvedDataDir))) {
    degraded.push("suggestions");
  }

  const slots = slotPlan(limit);
  const items = [];

  // ── focus (pinned, never scored against anything) ──────────────────────
  const focusItems = buildFocus(plan, tasks, slots.focus, nowMs, runtime, dismissedFocus);
  items.push(...focusItems);
  const pinnedTaskIds = new Set(focusItems.map((f) => f.sourceTaskId).filter(Boolean));

  // ── the ranked kinds ───────────────────────────────────────────────────
  const rankedTasks = tasks
    .filter((t) => t.bucket !== "done" && !pinnedTaskIds.has(t.id))
    .map((t) => buildTask(t, nowMs))
    .sort(byScoreDesc);

  const rankedClarifications = clarifications.map((c) => buildClarification(c, nowMs)).sort(byScoreDesc);
  // The two facts a draft row needs beyond its own record, both about the task
  // that PRODUCED it: is that task still able to produce another (so "stop
  // asking" is offered only when it can do something), and how many drafts it
  // has produced already (so the row can say why this keeps happening).
  const draftTotals = draftCountsByTask(runtime);
  const rankedDrafts = drafts
    .map((d) => buildDraft(d, nowMs, generatorTask(runtime, d), draftTotals.get(d.taskId) ?? 0))
    .sort(byScoreDesc);

  const multipliers = safely(degraded, "preferences", () => runtime.suggestionFeedback?.categoryMultipliers?.() ?? {}, {});
  const isMuted = (c) => {
    try { return runtime.suggestionFeedback?.isMuted?.(c) === true; } catch { return false; }
  };
  const eligibleSuggestions = suggestions.filter(
    (s) => ACTIONABLE_SUGGESTION_CATEGORIES.has(s.category) && !isMuted(s.category)
  );
  const rankedSuggestions = eligibleSuggestions
    .map((s) => buildSuggestion(s, nowMs, multipliers))
    .sort(byScoreDesc);

  // ── slot allocation: fixed budgets, then cascade the remainder ─────────
  const take = (list, n) => list.splice(0, Math.max(0, n));
  const remainingAfter = () => slots.limit - items.length;

  items.push(...take(rankedClarifications, Math.min(slots.clarification, remainingAfter())));
  items.push(...take(rankedDrafts, Math.min(slots.draft, remainingAfter())));

  // Reserve the suggestion floor BEFORE tasks claim what's left, otherwise a
  // pile of overdue tasks squeezes suggestions out entirely. It is held aside
  // rather than pushed here so the rendered array still follows slot rank
  // (focus, clarification, draft, task, suggestion) once tasks cascade below.
  const reserve = rankedSuggestions.length > 0 ? Math.min(slots.suggestionFloor, remainingAfter()) : 0;
  const floorSuggestions = take(rankedSuggestions, reserve);
  const held = floorSuggestions.length;

  // Tasks take their own slot budget first, then the cascade: the spec routes
  // unused slots to task and only then to suggestion, because an overdue task
  // matters more than a pattern-miner candidate. This cannot re-create the
  // "brief silently becomes a task list" regression rule 2 exists to prevent —
  // the floor above is already removed from the pool, so tasks spilling past
  // their budget can shrink the suggestion rows but can never erase them.
  items.push(...take(rankedTasks, Math.max(0, Math.min(slots.task, remainingAfter() - held))));
  items.push(...take(rankedTasks, Math.max(0, remainingAfter() - held)));

  // Suggestions last, in slot order: the guaranteed floor, then whatever slots
  // the other kinds could not fill (a task-free install still gets a full brief
  // instead of one row).
  items.push(...floorSuggestions);
  items.push(...take(rankedSuggestions, remainingAfter()));

  // "N older" is a claim about rows the popover COULD have shown. Counting the
  // whole pending queue advertises depth that does not exist: suggestions
  // outside ACTIONABLE_SUGGESTION_CATEGORIES (no server-side accept branch) and
  // muted ones are filtered out above and can never be rendered, so they are
  // not "older" — they are invisible. Unchanged by the blocklist→allowlist
  // inversion: a newly-hidden category is hidden the same way "automation"
  // already was, and stays out of this count.
  //
  // The leftovers of the four ranked arrays ARE that set, exactly: take()
  // splices what it hands to `items` out of them, and every ineligible row
  // (wrong category, muted, bucket "done", already pinned as focus) was
  // filtered before the arrays were built. Deriving the count from the
  // leftovers rather than re-filtering one kind is what keeps it truthful now
  // that the task pool is no longer empty — the old suggestion-only count said
  // "3 older" on an install with sixteen in-progress tasks it was also hiding.
  const unshown = [...rankedClarifications, ...rankedDrafts, ...rankedTasks, ...rankedSuggestions];
  const olderCount = unshown.length;
  const oldestAt = oldestOf(unshown);

  return {
    items: items.map(stripInternal),
    older: { count: olderCount, oldestAt },
    generatedAt: new Date(nowMs).toISOString(),
    planCachedAt: plan?.cachedAt ?? null,
    degraded
  };
}

// ─── per-kind builders ───────────────────────────────────────────────────

function buildFocus(plan, tasks, max, nowMs, runtime, dismissed = EMPTY_SET) {
  // Dismissals are applied BEFORE the slice, not after. Slicing first and then
  // dropping would spend the single focus slot on a row the user has already
  // cleared and leave the slot empty for the rest of the day — the plan's next
  // focus should take it. (Measured: the real install's plan carries two.)
  const all = Array.isArray(plan?.focus) ? plan.focus : [];
  const focus = all.filter((f) => !dismissed.has(focusKey(f?.title))).slice(0, max);
  const rows = [];
  for (const f of focus) {
    const title = String(f.title ?? "").trim();
    if (!title) continue; // nothing to render and nothing to act on
    const { task, alreadyDone } = resolveFocusTask(f, title, tasks, runtime);
    // The focus row is pinned above everything else, so it must never be a
    // dead slot. A focus whose task is already completed needs nothing from
    // the user — drop it rather than squat the top row until tomorrow's plan.
    if (alreadyDone) continue;
    rows.push({
      id: `focus:${f.taskId ?? slug(title)}`,
      kind: "focus",
      title,
      why: f.why || "in today's plan",
      score: 1,
      scoreBreakdown: { pinned: true },
      dueAt: task?.dueDate ?? null,
      source: "daily-plan",
      // Never zero actions. With a task behind it the row acts on that task —
      // Done and Snooze both resolve it, so it needs nothing more.
      //
      // Without one, the row gets BOTH offers and neither is recommended. See
      // unbackedFocusActions for why there is no advice-vs-work classifier.
      actions: task ? taskActions(task, nowMs) : unbackedFocusActions(title),
      deepLink: "/?tab=today",
      sourceTaskId: task?.id ?? null
    });
  }
  return rows;
}

/// Resolve a plan focus row to something the user can act on. Three cases, all
/// real:
///   - the id names a pending task            → act on that task
///   - the id names an already-completed task → the focus is done (caller drops
///     it); the pending list alone cannot tell this apart from a bad id, which
///     is why the store is consulted directly
///   - the id names nothing, or was never set → fall back to an exact title
///     match against the pending list, so a focus the user has since added as a
///     task binds to it instead of rendering a second, action-less copy
function resolveFocusTask(f, title, tasks, runtime) {
  const pending = f.taskId ? tasks.find((t) => t.id === f.taskId) : null;
  if (pending) return { task: pending, alreadyDone: false };
  if (f.taskId) {
    let stored = null;
    try { stored = runtime?.tasks?.get?.(f.taskId) ?? null; } catch { stored = null; }
    if (stored) {
      if (stored.status === "completed" || stored.bucket === "done") return { task: null, alreadyDone: true };
      return { task: stored, alreadyDone: false };
    }
  }
  const key = titleKey(title);
  const byTitle = key ? tasks.find((t) => titleKey(t.title) === key) : null;
  return { task: byTitle ?? null, alreadyDone: false };
}

/// What to offer on a focus row the plan could not tie to a task.
///
/// There are exactly two things such a row can be, and both are real:
///
///   • WORK the planner named that is not on the list yet — "Ship the brief".
///     "Add to tasks" is the right offer, and it also makes the row resolvable
///     by title on the next brief.
///   • ADVICE about posture — "Keep the day intentionally open — no scheduled
///     meetings, deadlines, or carried-over commitments". Measured on the real
///     install: BOTH of 2026-08-03's focus rows are this shape, taskId null
///     ("Set priorities for the week", "Protect open time for one meaningful
///     work block"). Filing advice as a to-do is nonsense, and the user said so.
///
/// This composer deliberately does NOT try to tell them apart. Every available
/// signal is planner prose, so any classifier here is a regex guessing at
/// intent, and being wrong costs either a lost real task (advice-shaped work
/// filed under "you can't add this") or the exact bug being fixed. Inventing a
/// claim the data does not support is the one thing this file must not do.
///
/// So: offer both, recommend neither. `style: "primary"` is what made "Add to
/// tasks" read as the thing to do; two secondaries say "you decide which of
/// these this is", which is the honest state of the composer's knowledge. The
/// user is the authority on whether "protect open time" belongs on their list.
///
/// The row is PINNED above everything else, so "make it go away" has to exist
/// or it squats the top slot until tomorrow's plan overwrites it. That is the
/// dismiss. It is never the ONLY action, so the "a focus row must never render
/// with zero actions" rule holds.
function unbackedFocusActions(title) {
  return [addTaskAction(title), dismissFocusAction(title)];
}

function addTaskAction(title) {
  return {
    id: "add",
    label: "Add to tasks",
    style: "secondary",
    method: "POST",
    path: "/tasks",
    body: { title, bucket: "today", queue: "user", source: "daily-plan" }
  };
}

/// "Not today", not "Dismiss": the suppression lasts exactly one local day and
/// the label has to say so. Tomorrow's plan is a NEW claim about a new day, and
/// silencing it with yesterday's tap would be its own quiet lie.
///
/// The key travels in the BODY. It is the normalized focus title, whole and
/// untruncated — never `slug()`, which caps at 40 chars and would collide two
/// long pieces of advice into one dismissal — and it is only ever compared as a
/// string INSIDE a per-day file whose name is derived from the clock. No
/// filename is ever built out of planner prose, so there is no traversal sink
/// here to guard.
function dismissFocusAction(title) {
  return {
    id: "dismiss",
    label: "Not today",
    style: "secondary",
    method: "POST",
    path: FOCUS_DISMISS_PATH,
    body: { key: focusKey(title) }
  };
}

const FOCUS_DISMISS_PATH = "/brief/focus/dismiss";
const EMPTY_SET = new Set();

/// The identity of a focus row for suppression purposes. Title-based on
/// purpose: an unbacked focus has no id of its own (taskId is null, which is
/// what makes it unbacked), and the planner re-emits the same sentence across
/// re-runs of the same day's cron. Normalized so a whitespace or case change
/// between the cached plan and a re-plan does not resurrect a dismissed row.
export function focusKey(title) { return titleKey(title); }

function titleKey(s) { return String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase(); }

/// Load the task pool. Two calls rather than one unfiltered one: task-store's
/// list() filters on an exact status and applies `limit` AFTER sorting, so a
/// single statusless call would spend the same budget on completed/cancelled/
/// blocked rows. Deduped by id because the store is not the only implementation
/// that answers this call — a stub (or a future store) that ignores the filter
/// must not double every row — and re-filtered for the same reason, so a store
/// that hands back terminal tasks cannot slip a completed one into the brief.
function listActiveTasks(runtime) {
  const byId = new Map();
  for (const status of ACTIVE_TASK_STATUSES) {
    const rows = runtime?.tasks?.list?.({ queue: "user", status, limit: 200 }) ?? [];
    for (const t of rows) if (t?.id && !byId.has(t.id)) byId.set(t.id, t);
  }
  return [...byId.values()].filter((t) => ACTIVE_TASK_STATUSES.includes(t.status ?? "pending"));
}

function buildTask(t, nowMs) {
  const due = dueUrgency(t, nowMs);
  const priority = clamp01((Number(t.priority) || 0) / 100);
  const started = t.status === "in_progress" ? 1 : 0;
  // carriedOver is the PENDING task's age signal, and a started task must not
  // collect it on top of `openAge` — that is the same fact counted twice, and
  // it is what let a task started in June outrank a task due today (both are
  // bucket "today", so the started one banked 0.12 + 0.08 against a due-date
  // gap of 0.55 * (0.85 - 0.5) = 0.1925 and won by a nose). Dropping it here
  // keeps the score built out of exactly the facts taskWhy renders, which is
  // why that string drops "carried over" for started rows too.
  const carried = !started && carriedOver(t, nowMs) ? 1 : 0;
  const openMs = taskOpenMs(t, nowMs);
  // How long an already-started task has been open, ramped over two weeks and
  // then SATURATED. What it buys is separation between something picked up this
  // morning and something that has been open since June. What it deliberately
  // does not do is rank the second group against itself: on the real install
  // all sixteen in-progress tasks were created 6-8 weeks ago and every one of
  // them pins this term at 1.0, so the tie falls back to priority and creation
  // order — the task store's own ranking, which is a better answer than
  // "whichever is most abandoned wins". Only meaningful for started work; a
  // pending task's age is already carried by carriedOver.
  const openAge = started ? clamp01(openMs / (14 * DAY_MS)) : 0;
  // The started boost is deliberately small and bounded by 0.12 (half of it at
  // minimum, all of it once fully aged). The ceiling is the whole point:
  // 0.55 * (0.85 - 0.5) = 0.1925 is the gap between "due today" and a bare
  // bucket-"today" task, so 0.12 < 0.1925 means a pending task with a real
  // deadline still outranks the oldest possible in-progress one. That is what
  // stops sixteen in-progress rows from swamping a brief that also has dated
  // work in it. Raising this past 0.1925 (or re-adding `carried` on top of it)
  // silently inverts that, so both are asserted in daily-brief.test.js.
  const startedTerm = started ? 0.5 + 0.5 * openAge : 0;
  const score = clamp01(0.55 * due.value + 0.25 * priority + 0.12 * startedTerm + 0.08 * carried);
  return {
    id: `task:${t.id}`,
    kind: "task",
    title: t.title,
    why: taskWhy(t, due, carried, openMs),
    score,
    scoreBreakdown: { dueUrgency: due.value, priority, carriedOver: carried, started, openAge },
    dueAt: t.dueDate ?? null,
    source: t.source ?? "manual",
    actions: taskActions(t, nowMs),
    deepLink: "/?tab=tasks",
    sourceCreatedAt: t.createdAt ?? null
  };
}

/// The row's one-line justification. "in progress · added 8w ago" and "due
/// today" are different claims about different facts, and the brief used to
/// render the second for both — an in-progress task filed under bucket "today"
/// read as "today", which the user could only take as a deadline.
///
/// For started work the bucket name is dropped: it is where the task was FILED,
/// not a fact about it, and next to an age it reads as a contradiction. A real
/// dueDate still shows, because that is a commitment the user made. "carried
/// over" is dropped too — "added 8w ago" says the same thing with a number.
function taskWhy(t, due, carried, openMs) {
  const parts = [];
  if (t.status === "in_progress") {
    parts.push("in progress");
    if (t.dueDate && due.label) parts.push(due.label);
    const age = ageLabel(openMs);
    if (age) parts.push(`added ${age} ago`);
  } else {
    if (due.label) parts.push(due.label);
    if (carried) parts.push("carried over");
  }
  if (t.source && t.source !== "manual") parts.push(`from ${t.source}`);
  return parts.join(" · ") || "on your list";
}

/// How long the task has existed. createdAt, and ONLY createdAt.
///
/// updatedAt is the obvious choice and it is the wrong one: this install's
/// proactive-observer rewrites `sourceMeta` on every in-progress task each
/// reconciliation pass (measured — 149 of 281 task updates in the live event
/// log patch sourceMeta alone, and all 16 in-progress tasks were stamped within
/// the same second today). So updatedAt tracks the DAEMON, not the user, and a
/// row saying "no update in 6w" would be reporting how long the observer had
/// been quiet while the user read it as how long they had been ignoring it —
/// a sentence that is false in exactly the way this file exists to prevent.
///
/// There is no startedAt on a task record either, so "started 8 weeks ago" is
/// unavailable. createdAt is never rewritten (task-store.update() copies it
/// through untouched), which makes "added 8w ago" the strongest claim actually
/// backed by the data.
function taskOpenMs(t, nowMs) {
  if (!t.createdAt || !Number.isFinite(nowMs)) return 0;
  const ms = new Date(t.createdAt).getTime();
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, nowMs - ms);
}

/// An age in the largest unit that is still true, or null when it is not worth
/// saying. Under a day is noise on something added this morning; weeks beat
/// "55d" for something that has been open since June.
function ageLabel(ms) {
  if (!Number.isFinite(ms) || ms < DAY_MS) return null;
  const days = ms / DAY_MS;
  return days >= 14 ? `${Math.round(days / 7)}w` : `${Math.floor(days)}d`;
}

function buildSuggestion(s, nowMs, multipliers) {
  const seq = s.sequence;
  let score;
  let breakdown;
  if (seq && typeof seq.confidence === "number") {
    const confidence = clamp01(seq.confidence);
    const countRamp = clamp01((Number(seq.count) || 0) / 10);
    const daysRamp = clamp01((Number(seq.distinctDays) || 0) / 5);
    const regular = seq.cadence?.type && seq.cadence.type !== "irregular" ? 1 : 0;
    score = clamp01(0.40 * confidence + 0.30 * countRamp + 0.20 * daysRamp + 0.10 * regular);
    breakdown = { confidence, countRamp, daysRamp, cadenceRegularity: regular };
  } else {
    // Observer candidates carry no frequency evidence — recency is the only
    // honest discriminator, so claim nothing more than that.
    const ageDays = s.proposedAt ? (nowMs - new Date(s.proposedAt).getTime()) / DAY_MS : 14;
    score = clamp01(1 - ageDays / 14);
    breakdown = { recency: score };
  }
  // MUST default to 1.0: categoryMultipliers() only emits keys for categories
  // with >=3 resolutions inside a 30-day window, which on a real install is
  // none of them — it returns {}. Without this, score * undefined === NaN and
  // the sort order becomes implementation-defined.
  const multiplier = Number.isFinite(multipliers?.[s.category]) ? multipliers[s.category] : 1.0;
  breakdown.categoryMultiplier = multiplier;
  return {
    id: `suggestion:${s.id}`,
    kind: "suggestion",
    title: suggestionTitle(s),
    why: suggestionWhy(s, breakdown),
    score: clamp01(score * multiplier),
    scoreBreakdown: breakdown,
    dueAt: null,
    source: s.source ?? "observer",
    actions: [
      {
        id: "accept",
        // Names the consequence, not the answer. The id stays "accept" — the
        // Mac client keys its outcome message off action.id, never the label.
        label: ACCEPT_LABELS[s.category] ?? "Yes",
        style: "primary",
        method: "POST",
        path: `/proactive/suggestions/${encodeURIComponent(s.id)}/accept`,
        body: null
      },
      // "Dismiss", not "No": the pair now reads as verb/verb, and it is what
      // the route does (status → rejected, the row leaves the queue) and what
      // the client already reports back ("Suggestion dismissed").
      { id: "reject", label: "Dismiss", style: "secondary", method: "POST", path: `/proactive/suggestions/${encodeURIComponent(s.id)}/reject`, body: null }
    ],
    deepLink: "/?tab=suggestions",
    sourceCreatedAt: s.proposedAt ?? null
  };
}

/// A sentence the user can read, never a machine slug.
///
/// The bug: mined candidates title themselves with the SLUG of the skill they
/// would create. suggestion-feed.js normalize() lifts `proposal.name` into
/// `title`, and proposal.name is kebab-case by construction — measured on the
/// user's install, 567 of 567 pending mined candidates have a name with no
/// spaces in it. So the popover rendered rows called "return-to-zoom-after-auth"
/// and "post-meeting-buildbetter-staging", which is a filename, not an offer.
///
/// The prose is already on the record and was simply never read: all 567 carry
/// a `proposal.description` — one sentence, 64-186 chars, e.g. "After checking
/// Slack, open Codex briefly to prepare or review work before joining a Zoom
/// call." Observer candidates (prop_*) are the other shape: they already title
/// themselves in prose ("Triage PR #4437 for ob-website SEO changes") and have
/// no proposal at all, so their title is kept verbatim.
function suggestionTitle(s) {
  const described = firstSentence(s.proposal?.description);
  if (described) return described;
  const title = String(s.title ?? "").trim();
  if (title && !looksLikeSlug(title)) return title;
  // No third source. `rationale` looks like one and is not: for a mined
  // candidate suggestion-feed.js composes it FROM the description plus stats,
  // so when the description is missing what is left is
  // "Observed 12× · across 6 days · hourly cadence · confidence 0.99" — a
  // measurement, not a sentence, and worse to read than the id.
  //
  // So: render the slug AS IT IS STORED rather than de-kebabbing it into a
  // sentence we made up. A machine id the user can match against the
  // Suggestions tab is honest; invented prose about what a pattern "means" is
  // exactly the kind of claim this brief must not make.
  return title || "OpenAGI noticed something";
}

/// Kebab/snake machine identifier: lowercase alphanumeric runs joined by - or _,
/// and no whitespace anywhere. Deliberately strict — a real sentence never
/// matches, and a one-word title (no separator) is not treated as a slug because
/// there is nothing to un-mangle and nothing better to show.
function looksLikeSlug(s) {
  return /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(String(s ?? "").trim());
}

/// First sentence of a prose field, so a two-sentence description does not turn
/// a popover row into a paragraph. Falls back to the whole string when there is
/// no terminator (which is every mined description on the real install).
function firstSentence(text) {
  const s = String(text ?? "").trim();
  if (!s) return "";
  const m = s.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (m ? m[0] : s).trim();
}

function buildDraft(d, nowMs, generator, draftsFromTask) {
  const score = ageScore(d.createdAt, nowMs);
  const ref = encodeURIComponent(d.id);
  // A revise action is only honest when we can hand the client the draft's
  // WHOLE current text (see editValue below). Without it there is nothing safe
  // to seed an editor with, so the row falls back to approve/discard.
  const editable = typeof d.body === "string";
  // "Stop asking" is only offered when there is something for it to stop. A
  // draft with no taskId has no generator, and a generator in a terminal state
  // cannot re-draft — in both cases the button would be a promise the server
  // has to refuse, and the honest version of that is no button.
  const stoppable = Boolean(generator) && RETIRABLE_TASK_STATUSES.has(generator.status ?? "pending");
  return {
    id: `draft:${d.id}`,
    kind: "draft",
    title: d.title || "(untitled draft)",
    why: draftWhy(d, draftsFromTask),
    score,
    scoreBreakdown: { age: score },
    dueAt: null,
    source: "agent",
    // The draft body, VERBATIM and never truncated — the seed for the inline
    // editor behind the "revise" action.
    //
    // It has to be shipped, and it has to be whole. `title` is a subject line
    // and `why` is a summary ("draft waiting · email"); neither is the text
    // being edited, and PATCHing either one back would overwrite the draft with
    // a fragment of itself. There is deliberately no length cap here: a capped
    // body is indistinguishable on the wire from a genuinely short one, so the
    // client would submit the cap and destroy everything past it.
    //
    // Why the composer sends it instead of the client fetching it: there is no
    // GET /drafts/:id route (hosted-interface.js exposes the /drafts LIST plus
    // PATCH/approve/discard on an id), so a client would have to pull every
    // pending draft and match by id — an extra request that can fail, on a path
    // where failing open means seeding an editor with the wrong text. The
    // composer already holds the full record from drafts.list(), so this costs
    // nothing and cannot disagree with the row it is attached to.
    ...(editable ? { editValue: d.body } : {}),
    actions: [
      // Revise comes FIRST, ahead of Approve: "change this" is the decision the
      // user makes before "yes", and it is the one this brief never offered.
      // style "revise" is the client's signal NOT to dispatch on tap — it opens
      // an inline field and dispatches on submit, with the typed text merged in
      // under `bodyField`.
      ...(editable
        ? [{ id: "revise", label: "Edit", style: "revise", method: "PATCH", path: `/drafts/${ref}`, body: null, bodyField: "body" }]
        : []),
      { id: "approve", label: "Approve", style: "primary", method: "POST", path: `/drafts/${ref}/approve`, body: null },
      // Two different decisions, and conflating them is the bug this pair
      // exists to fix. Discard resolves THIS ARTIFACT and deliberately leaves
      // the task alone — task-store treats a discarded draft as "not this one,
      // try again" (OPEN_DRAFT_STATUSES), which is a real and often correct
      // outcome. It is also why the user's discards kept coming back: measured
      // on their install, 69 of 97 pending drafts belong to a task that already
      // had one and a single task had produced four.
      { id: "discard", label: "Discard", style: "destructive", method: "POST", path: `/drafts/${ref}/discard`, body: null },
      // …and the other half, said out loud. style "retire" is a NEW style: it
      // asks the client to render this apart from the tap-happy row, and an
      // older client that has never heard of it falls back to its default
      // (secondary) — a plainer button that still works, never a missing one.
      ...(stoppable
        ? [{ id: "stop_asking", label: "Stop asking", style: "retire", method: "POST", path: `/drafts/${ref}/stop-asking`, body: null }]
        : [])
    ],
    deepLink: "/?tab=today",
    sourceCreatedAt: d.createdAt ?? null
  };
}

/// The draft row's one-line justification.
///
/// The count is the answer to the user's own question — "I hit discard and it
/// keeps coming back. I don't know why." — so it is stated in the row rather
/// than left for them to infer from a button. It counts EVERY draft the task
/// has produced, resolved ones included, because the discarded ones are the
/// whole story; a count of just the pending ones would say "1" on the task that
/// has been drafted four times.
function draftWhy(d, draftsFromTask) {
  const parts = ["draft waiting"];
  if (d.kind && d.kind !== "other") parts.push(d.kind);
  if (Number.isFinite(draftsFromTask) && draftsFromTask > 1) parts.push(`${draftsFromTask} drafts from this task`);
  return parts.join(" · ");
}

/// The task that produced this draft, or null. Never throws: a draft row is
/// still worth showing when the task store cannot answer, it just loses the
/// "stop asking" offer — which is the correct degradation, since without the
/// task we cannot know whether there is anything to retire.
function generatorTask(runtime, draft) {
  if (!draft?.taskId) return null;
  try { return runtime?.tasks?.get?.(draft.taskId) ?? null; } catch { return null; }
}

/// taskId → how many drafts that task has produced, in any status.
///
/// Enrichment ONLY, which is why it swallows its own failure instead of going
/// through safely(): `degraded` is a claim that a source could not be read, and
/// the pending-draft list this brief is actually built from was already read
/// successfully by the time this runs. Losing the count costs a clause in one
/// row; reporting "couldn't read drafts" next to four drafts we are rendering
/// would be the louder lie.
function draftCountsByTask(runtime) {
  const counts = new Map();
  try {
    for (const d of runtime?.drafts?.list?.({ status: null }) ?? []) {
      if (!d?.taskId) continue;
      counts.set(d.taskId, (counts.get(d.taskId) ?? 0) + 1);
    }
  } catch { /* enrichment only — see above */ }
  return counts;
}

function buildClarification(c, nowMs) {
  const score = ageScore(c.createdAt, nowMs);
  return {
    id: `clarification:${c.id}`,
    kind: "clarification",
    title: c.question || "Did you finish this?",
    why: "needs your call",
    score,
    scoreBreakdown: { age: score },
    dueAt: null,
    source: "agent",
    actions: VALID_CLARIFICATION_ANSWERS.map((a) => ({
      id: `answer:${a}`,
      label: CLARIFICATION_LABELS[a],
      style: a === "yes" ? "primary" : a === "dropped" ? "destructive" : "secondary",
      method: "POST",
      path: `/tasks/clarifications/${encodeURIComponent(c.id)}/answer`,
      body: { answer: a }
    })),
    deepLink: "/?tab=today",
    sourceCreatedAt: c.createdAt ?? null
  };
}

/// The earliest timestamp among a set of rows, or null. Parses rather than
/// comparing ISO strings lexicographically: task createdAt, draft createdAt and
/// suggestion proposedAt are written by different stores and a single one of
/// them carrying an offset (+00:00 rather than Z) would silently sort wrong.
function oldestOf(items) {
  let bestAt = null;
  let bestMs = Infinity;
  for (const item of items) {
    const at = item?.sourceCreatedAt;
    if (!at) continue;
    const ms = new Date(at).getTime();
    if (!Number.isFinite(ms) || ms >= bestMs) continue;
    bestMs = ms;
    bestAt = at;
  }
  return bestAt;
}

// ─── scoring helpers ─────────────────────────────────────────────────────

function dueUrgency(t, nowMs) {
  if (t.dueDate) {
    const dueMs = new Date(t.dueDate).getTime();
    const deltaDays = (dueMs - nowMs) / DAY_MS;
    if (deltaDays < 0) {
      // Score saturates at 1.0 for anything overdue — but the LABEL is a
      // factual claim, and rounding sub-day lateness up to a whole day said
      // "overdue 1d" about a task that missed its 4pm deadline two hours ago.
      // Say the true unit instead; the score is untouched.
      return { value: 1.0, label: `overdue ${lateLabel(nowMs - dueMs)}` };
    }
    if (deltaDays < 1) return { value: 0.85, label: "due today" };
    if (deltaDays <= 3) return { value: 0.6, label: `due in ${Math.ceil(deltaDays)}d` };
  }
  const idx = BUCKETS.indexOf(t.bucket);
  if (idx >= 0) return { value: Math.max(0, 0.5 - 0.1 * idx), label: t.bucket.replace(/_/g, " ") };
  return { value: 0, label: "" };
}

/// How late is late, in the largest unit that is still true.
function lateLabel(lateMs) {
  const ms = Math.max(0, lateMs);
  if (ms < HOUR_MS) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < DAY_MS) return `${Math.max(1, Math.round(ms / HOUR_MS))}h`;
  return `${Math.max(1, Math.round(ms / DAY_MS))}d`;
}

/// "carried over" is rendered verbatim in the item's `why` string, so it has to
/// be true. It used to compare against setUTCHours(0,0,0,0) — the UTC day, not
/// the user's — which is the same class of bug readPlanCache had: west of UTC
/// the two disagree for the tail of every local day, so a task created at 5pm
/// PT was reported as carried over from yesterday the moment it was typed.
/// Comparing local day KEYS (the same ones the plan artifact is named for)
/// keeps this honest and keeps it consistent with the rest of the file.
function carriedOver(t, nowMs) {
  if (t.bucket !== "today" || !t.createdAt) return false;
  const createdKey = localDayKey(new Date(t.createdAt).getTime());
  const todayKey = localDayKey(nowMs);
  if (!createdKey || !todayKey) return false;
  return createdKey < todayKey;
}

/// Local calendar day (YYYY-MM-DD) for an instant, or null when the instant is
/// not a real one — planDateKey throws on an Invalid Date and the clock here is
/// caller-supplied, so this stays a total function.
function localDayKey(ms) {
  if (!Number.isFinite(ms)) return null;
  try { return planDateKey(new Date(ms)); } catch { return null; }
}

/// Drafts and clarifications are decision-blocked by definition, so how long
/// they have been waiting is the honest discriminator. Saturates at 48h, the
/// same "still waiting" threshold outreach-digest uses.
function ageScore(createdAt, nowMs) {
  if (!createdAt) return 0.5;
  return clamp01((nowMs - new Date(createdAt).getTime()) / (48 * HOUR_MS));
}

function suggestionWhy(s, breakdown) {
  const seq = s.sequence;
  if (seq) {
    const parts = [];
    if (seq.count) parts.push(`seen ${seq.count}x`);
    if (seq.distinctDays > 1) parts.push(`across ${seq.distinctDays} days`);
    if (seq.cadence?.type && seq.cadence.type !== "irregular") parts.push(`${seq.cadence.type} cadence`);
    if (parts.length) return parts.join(" · ");
  }
  return s.rationale ? String(s.rationale).slice(0, 120) : "noticed on screen";
}

function taskActions(t, nowMs) {
  const id = t.id;
  const until = snoozeUntil(t, nowMs);
  // dueDate is OMITTED rather than sent as null when it cannot be computed:
  // task-store.update treats an explicit null as "clear the due date", which
  // would destroy a real commitment on a broken clock.
  const snoozeBody = until ? { bucket: "this_week", dueDate: until } : { bucket: "this_week" };
  return [
    { id: "complete", label: "Done", style: "primary", method: "POST", path: `/tasks/${encodeURIComponent(id)}/complete`, body: null },
    {
      id: "snooze",
      label: "Snooze",
      style: "secondary",
      method: "PATCH",
      path: `/tasks/${encodeURIComponent(id)}`,
      body: snoozeBody
    }
  ];
}

/// Snooze has to actually move the row. dueUrgency short-circuits on dueDate
/// and never reaches the bucket, so the old bucket-only PATCH left an overdue
/// task at the identical score, the identical "overdue Nd" label and the
/// identical position — the user tapped Snooze and the brief came back
/// unchanged. So push the DEADLINE, not just the bucket.
///
/// Pushed, never cleared: a due date is a real commitment the user made and
/// dropping it to silence a row would throw that away. The new deadline is the
/// end of the next local day ("get it done tomorrow"), measured from whichever
/// is later — now or the existing due date — so snoozing can only ever move a
/// deadline outward, never pull a future one in.
function snoozeUntil(t, nowMs) {
  if (!Number.isFinite(nowMs)) return null;
  const dueMs = t.dueDate ? new Date(t.dueDate).getTime() : NaN;
  const from = Number.isFinite(dueMs) ? Math.max(dueMs, nowMs) : nowMs;
  const until = endOfNextLocalDay(from);
  return Number.isFinite(until) ? new Date(until).toISOString() : null;
}

/// Local midnight opening the day that contains `ms`. planDateKey renders the
/// user's calendar day; a date-time string with no offset is defined to be
/// LOCAL, so this round-trips to that day's midnight without hand-rolled
/// offset arithmetic (and without the UTC-day bug this file has been bitten by
/// twice — see readPlanCache and carriedOver).
function startOfLocalDay(ms) {
  const key = localDayKey(ms);
  if (!key) return ms;
  const parsed = new Date(`${key}T00:00:00`).getTime();
  return Number.isFinite(parsed) ? parsed : ms;
}

/// The instant that closes the NEXT local day. Hopping 36h and re-keying rather
/// than adding 24h keeps this on the right calendar day across DST boundaries,
/// where a local day is 23 or 25 hours long.
function endOfNextLocalDay(ms) {
  const tomorrow = startOfLocalDay(startOfLocalDay(ms) + 36 * HOUR_MS);
  return startOfLocalDay(tomorrow + 36 * HOUR_MS);
}

// ─── plumbing ────────────────────────────────────────────────────────────

/// Read the plan artifact the 08:00 cron writes. A missing file is the normal
/// first-run state, NOT a degraded source — the brief simply has nothing to
/// pin and fills every slot from the live stores instead.
function readPlanCache(dataDir, now) {
  // planDateKey, not toISOString().slice(0,10) — the artifact is named for the
  // user's LOCAL day, and west of UTC the UTC date rolls over while it is still
  // today locally (17:00 in America/Los_Angeles). Keying this off UTC made the
  // evening brief silently drop its focus row every day. See planDateKey.
  const iso = planDateKey(now);
  return readJsonFile(path.join(dataDir, "plan", `${iso}.json`), null);
}

/// Where a day's focus dismissals live: plan/dismissed/YYYY-MM-DD.json.
///
/// A SUBDIRECTORY of the plan cache, not a sibling of the artifacts. Nothing in
/// the tree scans plan/*.json today, but "the plan cache dir contains plan
/// artifacts" is a property worth keeping true — a sidecar named
/// 2026-08-03.dismissed.json sitting next to 2026-08-03.json is one careless
/// glob away from being read as a plan.
///
/// Named for the LOCAL day, the same key the artifact it suppresses rows from
/// is named for (planDateKey). That is what makes the suppression expire on its
/// own: tomorrow reads a different file, which does not exist, so tomorrow's
/// plan is judged on its own terms with no cleanup job and no TTL to get wrong.
///
/// Returns null when the clock is not a real instant — planDateKey throws on an
/// Invalid Date, and every caller here is on a caller-supplied clock.
function focusDismissalPath(dataDir, now) {
  let iso;
  try { iso = planDateKey(now); } catch { return null; }
  return path.join(dataDir, "plan", "dismissed", `${iso}.json`);
}

/// Today's dismissed focus keys. Total function: a missing file is the normal
/// state (nothing dismissed yet) and a corrupt one is not worth failing a whole
/// brief over — both yield "nothing suppressed", which errs toward SHOWING the
/// row. That is the safe direction: a row that comes back can be dismissed
/// again, whereas a read error that hid rows would silently shrink the brief.
function readFocusDismissals(dataDir, now) {
  const file = focusDismissalPath(dataDir, now);
  return file ? new Set(readDismissedKeys(file)) : EMPTY_SET;
}

/// The keys in one day-record, or [] if it cannot be read for ANY reason.
///
/// Deliberately swallows rather than quarantining: readJsonFile's default would
/// RENAME an unparseable file aside, and this one is a suppression list the
/// user built by tapping — moving it is a bigger intervention than the problem.
/// Left in place, the next dismissal simply overwrites it with a good record,
/// so the file self-heals and the only cost is that already-dismissed rows come
/// back once.
function readDismissedKeys(file) {
  let record = null;
  try { record = readJsonFile(file, null, { quarantine: false }); } catch { return []; }
  const keys = Array.isArray(record?.focus) ? record.focus : [];
  return keys.filter((k) => typeof k === "string" && k.length > 0);
}

/// Record "not today" for one focus row. Called by POST /brief/focus/dismiss.
///
/// Append-only within the day and idempotent: re-dismissing an already-listed
/// key rewrites the same list rather than duplicating it, so a double tap (or a
/// retry after a dropped response) cannot corrupt the record.
///
/// The write is READ-MODIFY-WRITE on one small file rather than an append log,
/// because the reader has to answer "is this key suppressed" on every brief and
/// a set is the shape that question wants. writeJsonAtomic renames into place,
/// so a crash mid-write leaves the previous day-record intact rather than a
/// half-file that would read as "nothing dismissed".
export function dismissFocus(runtime, { key, now = new Date(), dataDir } = {}) {
  const focus = focusKey(key);
  // A blank key would match no row and suppress nothing, so recording it is
  // pure noise in a file the user cannot see. Say no instead of writing a
  // no-op and reporting success.
  if (!focus) return { ok: false, error: "missing key" };

  const resolvedDataDir = dataDir ?? runtime?.dataDir ?? resolveDataDir();
  const file = focusDismissalPath(resolvedDataDir, now);
  if (!file) return { ok: false, error: "bad clock" };

  const prior = readDismissedKeys(file);
  const next = prior.includes(focus) ? prior : [...prior, focus];
  const record = { date: path.basename(file, ".json"), focus: next, updatedAt: new Date().toISOString() };
  try {
    writeJsonAtomic(file, record);
  } catch (error) {
    // The caller reports this to the user. A dismissal that silently failed to
    // persist is the "I hit discard and it keeps coming back" bug again.
    return { ok: false, error: error.message };
  }
  return { ok: true, date: record.date, key: focus, dismissed: next };
}

/// Can the suggestion store be read at all? Distinguishes "nothing pending"
/// (healthy) from "cannot look" (degraded), which listAllSuggestions() itself
/// collapses into one empty array.
///
/// A dataDir we cannot list means the install's storage is gone or locked —
/// every source is suspect, so the suggestion queue is certainly not honestly
/// empty. Missing SUBdirectories are different: proactive/suggestions/ and
/// skills-suggested/ are created lazily on first write, so their absence on a
/// readable dataDir is a first-run install with a genuinely empty queue and
/// must not be flagged. A subdir that exists but will not list (permissions,
/// bad mount) is the real broken case.
/// Resolve the directory the suggestion feed ACTUALLY reads, mirroring
/// suggestion-feed.js's own fallback chain. AbiRuntime carries no `dataDir`, so
/// in the daemon the feed resolves through its sub-stores — probing the
/// caller's dataDir instead would happily report a healthy store while the feed
/// was reading a broken one somewhere else.
function suggestionDataDir(runtime, fallback) {
  return runtime?.dataDir
    ?? runtime?.proactiveObserver?.dataDir
    ?? runtime?.patternMiner?.dataDir
    ?? fallback;
}

function suggestionStoreUnreadable(dataDir) {
  if (!dataDir || !canList(dataDir)) return true;
  const dirs = [path.join(dataDir, "proactive", "suggestions"), path.join(dataDir, "skills-suggested")];
  return dirs.some((dir) => fs.existsSync(dir) && !canList(dir));
}

function canList(dir) {
  try {
    fs.readdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/// Run a source loader with its own failure boundary so one broken store
/// never blanks the whole brief.
function safely(degraded, name, fn, fallback) {
  try {
    return fn();
  } catch {
    if (name !== "plan") degraded.push(name);
    return fallback;
  }
}

/// Composer bookkeeping never reaches the wire. sourceTaskId resolves the focus
/// row to a task; sourceCreatedAt feeds older.oldestAt across kinds.
function stripInternal(item) {
  const { sourceTaskId, sourceCreatedAt, ...rest } = item;
  return rest;
}

function byScoreDesc(a, b) { return b.score - a.score; }
function clamp01(n) { return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; }
function slug(s) { return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "item"; }
