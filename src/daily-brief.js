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
import { readJsonFile } from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";
import { listAllSuggestions } from "./suggestion-feed.js";
import { planDateKey } from "./daily-planner.js";

// Bucket order, mirrored from task-store.js. "done" never enters the brief.
const BUCKETS = ["today", "this_week", "this_month", "this_quarter", "this_year", "someday", "done"];
const VALID_CLARIFICATION_ANSWERS = ["yes", "in_progress", "no", "dropped"];
const CLARIFICATION_LABELS = { yes: "Yes", in_progress: "In progress", no: "Not yet", dropped: "Dropped" };
// "automation" suggestions have no accept branch server-side (hosted-interface.js
// falls through to a bare 200), so accepting one does nothing. Hide until handled.
const EXCLUDED_SUGGESTION_CATEGORIES = new Set(["automation"]);

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

  const tasks = safely(degraded, "tasks", () => runtime.tasks?.list?.({ queue: "user", status: "pending", limit: 200 }) ?? [], []);
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
  const focusItems = buildFocus(plan, tasks, slots.focus, nowMs, runtime);
  items.push(...focusItems);
  const pinnedTaskIds = new Set(focusItems.map((f) => f.sourceTaskId).filter(Boolean));

  // ── the ranked kinds ───────────────────────────────────────────────────
  const rankedTasks = tasks
    .filter((t) => t.bucket !== "done" && !pinnedTaskIds.has(t.id))
    .map((t) => buildTask(t, nowMs))
    .sort(byScoreDesc);

  const rankedClarifications = clarifications.map((c) => buildClarification(c, nowMs)).sort(byScoreDesc);
  const rankedDrafts = drafts.map((d) => buildDraft(d, nowMs)).sort(byScoreDesc);

  const multipliers = safely(degraded, "preferences", () => runtime.suggestionFeedback?.categoryMultipliers?.() ?? {}, {});
  const isMuted = (c) => {
    try { return runtime.suggestionFeedback?.isMuted?.(c) === true; } catch { return false; }
  };
  const eligibleSuggestions = suggestions.filter(
    (s) => !EXCLUDED_SUGGESTION_CATEGORIES.has(s.category) && !isMuted(s.category)
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
  // whole pending queue advertises depth that does not exist: excluded
  // ("automation", no server-side accept branch) and muted suggestions are
  // filtered out above and can never be rendered, so they are not "older" —
  // they are invisible. Count against the eligible set only, and derive
  // oldestAt from that same set so the two never disagree.
  const shownSuggestionIds = new Set(items.filter((i) => i.kind === "suggestion").map((i) => i.id));
  const olderSuggestions = eligibleSuggestions.filter((s) => !shownSuggestionIds.has(`suggestion:${s.id}`));
  const olderCount = olderSuggestions.length;
  const oldestAt = olderSuggestions.reduce(
    (min, s) => (s.proposedAt && (!min || s.proposedAt < min) ? s.proposedAt : min),
    null
  );

  return {
    items: items.map(stripInternal),
    older: { count: olderCount, oldestAt },
    generatedAt: new Date(nowMs).toISOString(),
    planCachedAt: plan?.cachedAt ?? null,
    degraded
  };
}

// ─── per-kind builders ───────────────────────────────────────────────────

function buildFocus(plan, tasks, max, nowMs, runtime) {
  const focus = Array.isArray(plan?.focus) ? plan.focus.slice(0, max) : [];
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
      // Never zero actions. With a task behind it the row acts on that task;
      // without one the only honest offer is to put it on the list, which also
      // makes the row resolvable (by title) on the next brief.
      actions: task ? taskActions(task, nowMs) : [addTaskAction(title)],
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

function addTaskAction(title) {
  return {
    id: "add",
    label: "Add to tasks",
    style: "primary",
    method: "POST",
    path: "/tasks",
    body: { title, bucket: "today", queue: "user", source: "daily-plan" }
  };
}

function titleKey(s) { return String(s ?? "").trim().toLowerCase(); }

function buildTask(t, nowMs) {
  const due = dueUrgency(t, nowMs);
  const priority = clamp01((Number(t.priority) || 0) / 100);
  const carried = carriedOver(t, nowMs) ? 1 : 0;
  const score = clamp01(0.55 * due.value + 0.30 * priority + 0.15 * carried);
  return {
    id: `task:${t.id}`,
    kind: "task",
    title: t.title,
    why: [due.label, carried ? "carried over" : null, t.source && t.source !== "manual" ? `from ${t.source}` : null]
      .filter(Boolean).join(" · ") || "on your list",
    score,
    scoreBreakdown: { dueUrgency: due.value, priority, carriedOver: carried },
    dueAt: t.dueDate ?? null,
    source: t.source ?? "manual",
    actions: taskActions(t, nowMs),
    deepLink: "/?tab=tasks"
  };
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
    title: s.title || "OpenAGI noticed something",
    why: suggestionWhy(s, breakdown),
    score: clamp01(score * multiplier),
    scoreBreakdown: breakdown,
    dueAt: null,
    source: s.source ?? "observer",
    actions: [
      { id: "accept", label: "Yes", style: "primary", method: "POST", path: `/proactive/suggestions/${encodeURIComponent(s.id)}/accept`, body: null },
      { id: "reject", label: "No", style: "secondary", method: "POST", path: `/proactive/suggestions/${encodeURIComponent(s.id)}/reject`, body: null }
    ],
    deepLink: "/?tab=suggestions"
  };
}

function buildDraft(d, nowMs) {
  const score = ageScore(d.createdAt, nowMs);
  const ref = encodeURIComponent(d.id);
  // A revise action is only honest when we can hand the client the draft's
  // WHOLE current text (see editValue below). Without it there is nothing safe
  // to seed an editor with, so the row falls back to approve/discard.
  const editable = typeof d.body === "string";
  return {
    id: `draft:${d.id}`,
    kind: "draft",
    title: d.title || "(untitled draft)",
    why: `draft waiting${d.kind && d.kind !== "other" ? ` · ${d.kind}` : ""}`,
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
      { id: "discard", label: "Discard", style: "destructive", method: "POST", path: `/drafts/${ref}/discard`, body: null }
    ],
    deepLink: "/?tab=today"
  };
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
    deepLink: "/?tab=today"
  };
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

function stripInternal(item) {
  const { sourceTaskId, ...rest } = item;
  return rest;
}

function byScoreDesc(a, b) { return b.score - a.score; }
function clamp01(n) { return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; }
function slug(s) { return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "item"; }
