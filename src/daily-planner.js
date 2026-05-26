// "Here's what I'm going to do today" — the morning counterpart to the
// daily recap. Where the recap looks backward (what got done), the planner
// looks forward: it reads today's calendar, pending + carried-over tasks,
// recent call commitments, and active goals, then proposes a focused plan
// AND what the agent can take off your plate (draft an email, prep a doc,
// schedule a follow-up, set a reminder).
//
// Same shape contract as daily-recap: computeDailyPlan returns structured
// JSON; renderDailyPlanMarkdown turns it into a chat/memory/notification
// string. The synthesis uses the LLM when configured, and falls back to a
// deterministic priority-ordered plan when it isn't, so the morning job
// never silently no-ops.

const PLAN_SYSTEM_PROMPT = [
  "You are the user's chief of staff drafting their day. You receive their calendar, pending tasks (with buckets + due dates), tasks carried over from yesterday, recent commitments made on calls, and active goals.",
  "Produce a SHORT, realistic plan — not a list of everything, the 3-6 things that actually matter today given the calendar's time constraints.",
  "Separate what the USER should focus on from what the AGENT can do for them (draft an email, prepare a doc/outline, schedule a future follow-up, set a reminder, research something). Only propose agent help that's concretely actionable from the given context.",
  "Respect time: if the calendar is packed, the focus list must be shorter. Flag anything time-sensitive (due today, or a commitment with a deadline).",
  "Output STRICT JSON: {\"focus\":[{\"title\":\"...\",\"taskId\":\"<id or null>\",\"why\":\"<short>\"}],\"agentWillDo\":[{\"action\":\"<imperative>\",\"detail\":\"<short>\"}],\"timeSensitive\":[\"<short>\"],\"note\":\"<one-line framing of the day, optional>\"}.",
  "Keep focus ≤6, agentWillDo ≤4. Reference real taskIds when a focus item maps to a given task."
].join("\n");

export async function computeDailyPlan(runtime, { date = new Date(), timezone, useLLM = true } = {}) {
  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { startISO, endISO, label } = localDayBounds(date, tz);

  const calendar = await pullCalendar(runtime, startISO, endISO);
  const tasks = pullPlannableTasks(runtime, startISO);
  const carriedOver = pullCarriedOver(runtime, startISO);
  const commitments = pullCommitments(runtime);
  const goals = pullActiveGoals(runtime);

  const inputs = { date: label, dateISO: startISO.slice(0, 10), timezone: tz, calendar, tasks, carriedOver, commitments, goals };

  const synth = useLLM
    ? await synthesizeWithLLM(runtime, inputs)
    : null;
  const plan = synth ?? deterministicPlan(inputs);

  return {
    ...inputs,
    range: { from: startISO, to: endISO },
    focus: plan.focus,
    agentWillDo: plan.agentWillDo,
    timeSensitive: plan.timeSensitive,
    note: plan.note ?? null,
    synthesized: Boolean(synth),
    counts: {
      events: calendar.length,
      focus: plan.focus.length,
      agentWillDo: plan.agentWillDo.length,
      carriedOver: carriedOver.length
    }
  };
}

export function renderDailyPlanMarkdown(plan) {
  const lines = [`## Your day — ${plan.date}`];
  if (plan.note) lines.push(`_${plan.note}_`);

  if (plan.calendar.length > 0) {
    lines.push("\n### 📅 Schedule");
    for (const e of plan.calendar.slice(0, 8)) {
      const t = e.allDay ? "all day" : new Date(e.start).toISOString().slice(11, 16) + "Z";
      lines.push(`- ${t} — ${e.summary}`);
    }
  }

  if (plan.timeSensitive.length > 0) {
    lines.push("\n### ⚠️ Time-sensitive");
    for (const s of plan.timeSensitive) lines.push(`- ${s}`);
  }

  if (plan.focus.length > 0) {
    lines.push("\n### 🎯 Focus");
    for (const f of plan.focus) lines.push(`- ${f.title}${f.why ? ` — ${f.why}` : ""}`);
  }

  if (plan.agentWillDo.length > 0) {
    lines.push("\n### 🤖 I'll handle");
    for (const a of plan.agentWillDo) lines.push(`- ${a.action}${a.detail ? ` — ${a.detail}` : ""}`);
  }

  if (plan.focus.length === 0 && plan.calendar.length === 0) {
    lines.push("\n_Open day, nothing scheduled and no pending tasks. A good day to get ahead._");
  }
  return lines.join("\n");
}

// ─── input gathering ─────────────────────────────────────────────────────

async function pullCalendar(runtime, startISO, endISO) {
  try {
    const tool = runtime?.tools?.get?.("calendar_events_between");
    if (!tool?.handler) return [];
    const events = await tool.handler({ from: startISO, to: endISO });
    return Array.isArray(events) ? events.slice(0, 12) : [];
  } catch {
    return [];
  }
}

// Plannable = pending user tasks in today/this_week buckets, or anything
// overdue/due-today by dueDate. Sorted by (overdue, dueDate, priority).
function pullPlannableTasks(runtime, startISO) {
  if (!runtime?.tasks?.list) return [];
  const startMs = +new Date(startISO);
  const endOfTodayMs = startMs + 86_400_000;
  const candidates = runtime.tasks.list({ status: "pending", limit: 100 })
    .filter((t) => t.queue === "user")
    .filter((t) => ["today", "this_week"].includes(t.bucket) || (t.dueDate && +new Date(t.dueDate) < endOfTodayMs));
  return candidates
    .map((t) => ({
      id: t.id,
      title: t.title,
      bucket: t.bucket,
      priority: t.priority ?? 50,
      dueDate: t.dueDate ?? null,
      overdue: t.dueDate ? +new Date(t.dueDate) < startMs : false,
      parentGoalId: t.parentGoalId ?? null,
      source: t.source ?? null
    }))
    .sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      if (a.dueDate !== b.dueDate) return a.dueDate ? -1 : 1;
      return b.priority - a.priority;
    })
    .slice(0, 25);
}

// Tasks that were in "today" but didn't get completed yesterday — i.e.
// still pending + bucket "today" + created before today's start.
function pullCarriedOver(runtime, startISO) {
  if (!runtime?.tasks?.list) return [];
  const startMs = +new Date(startISO);
  return runtime.tasks.list({ status: "pending", limit: 100 })
    .filter((t) => t.queue === "user" && t.bucket === "today" && +new Date(t.createdAt ?? startISO) < startMs)
    .map((t) => ({ id: t.id, title: t.title, priority: t.priority ?? 50 }))
    .slice(0, 15);
}

// Recent BuildBetter commitments/follow-ups — "you said you'd do X".
function pullCommitments(runtime) {
  if (!runtime?.tasks?.list) return [];
  return runtime.tasks.list({ limit: 200 })
    .filter((t) => t.source === "buildbetter" && t.status === "pending")
    .filter((t) => {
      const types = t.sourceMeta?.extractionTypes ?? [];
      return types.includes("commitment") || types.includes("follow_up") || types.includes("priority");
    })
    .map((t) => ({ id: t.id, title: t.title, callName: t.sourceMeta?.callName ?? null }))
    .slice(0, 12);
}

function pullActiveGoals(runtime) {
  if (!runtime?.tasks?.listGoals) return [];
  return runtime.tasks.listGoals({ status: "active" })
    .map((g) => ({ id: g.id, title: g.title, dueDate: g.dueDate ?? null }))
    .slice(0, 10);
}

// ─── synthesis ───────────────────────────────────────────────────────────

async function synthesizeWithLLM(runtime, inputs) {
  const provider = runtime?.agentHost?.modelProvider;
  if (!provider?.isConfigured?.() || provider.constructor.name === "DeterministicModelProvider") return null;

  const prompt = [
    `Planning ${inputs.date} (${inputs.timezone}).`,
    "",
    "Calendar today:",
    ...(inputs.calendar.length ? inputs.calendar.map((e) => `  - ${e.allDay ? "all day" : new Date(e.start).toISOString().slice(11, 16) + "Z"} ${e.summary}`) : ["  (nothing scheduled)"]),
    "",
    "Pending tasks (bucket · priority · due):",
    ...(inputs.tasks.length ? inputs.tasks.map((t) => `  - id=${t.id} "${t.title}" [${t.bucket}·p${t.priority}${t.dueDate ? `·due ${t.dueDate.slice(0, 10)}` : ""}${t.overdue ? "·OVERDUE" : ""}]`) : ["  (none)"]),
    "",
    "Carried over from yesterday (didn't finish):",
    ...(inputs.carriedOver.length ? inputs.carriedOver.map((t) => `  - id=${t.id} "${t.title}"`) : ["  (none)"]),
    "",
    "Recent commitments made on calls:",
    ...(inputs.commitments.length ? inputs.commitments.map((t) => `  - id=${t.id} "${t.title}"${t.callName ? ` (${t.callName})` : ""}`) : ["  (none)"]),
    "",
    "Active goals:",
    ...(inputs.goals.length ? inputs.goals.map((g) => `  - ${g.title}${g.dueDate ? ` (due ${g.dueDate.slice(0, 10)})` : ""}`) : ["  (none)"]),
    "",
    "Draft today's plan."
  ].join("\n");

  let raw;
  try {
    const result = await provider.generate({
      input: prompt,
      agent: { id: "daily-planner", name: "daily-planner" },
      memoryHits: [], messages: [], tools: [], toolRegistry: null,
      instructions: PLAN_SYSTEM_PROMPT,
      context: {}
    });
    raw = result.text ?? "";
  } catch {
    return null;
  }

  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return {
      focus: sanitizeList(parsed.focus, ["title", "taskId", "why"]).slice(0, 6),
      agentWillDo: sanitizeList(parsed.agentWillDo, ["action", "detail"]).slice(0, 4),
      timeSensitive: Array.isArray(parsed.timeSensitive) ? parsed.timeSensitive.filter((s) => typeof s === "string").slice(0, 6) : [],
      note: typeof parsed.note === "string" ? parsed.note : null
    };
  } catch {
    return null;
  }
}

function sanitizeList(arr, keys) {
  if (!Array.isArray(arr)) return [];
  return arr.map((item) => {
    const out = {};
    for (const k of keys) out[k] = typeof item?.[k] === "string" ? item[k] : (k === "taskId" ? (item?.[k] ?? null) : "");
    return out;
  }).filter((o) => o[keys[0]]); // drop entries missing the primary field
}

// No-LLM fallback: focus = top plannable tasks; surface overdue/due-today
// as time-sensitive; no agent suggestions (we won't invent work without a
// model to reason about it).
function deterministicPlan(inputs) {
  const timeSensitive = inputs.tasks
    .filter((t) => t.overdue || (t.dueDate && t.dueDate.slice(0, 10) === inputs.dateISO))
    .map((t) => `${t.overdue ? "Overdue: " : "Due today: "}${t.title}`)
    .slice(0, 6);
  const focus = inputs.tasks.slice(0, 5).map((t) => ({
    title: t.title,
    taskId: t.id,
    why: t.overdue ? "overdue" : t.bucket === "today" ? "in today" : "this week"
  }));
  return { focus, agentWillDo: [], timeSensitive, note: null };
}

// ─── shared day-bounds (kept identical to daily-recap) ────────────────────

function localDayBounds(date, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const year = parts.find((p) => p.type === "year").value;
  const month = parts.find((p) => p.type === "month").value;
  const day = parts.find((p) => p.type === "day").value;
  const startLocal = new Date(`${year}-${month}-${day}T00:00:00`);
  const offsetMin = startLocal.getTimezoneOffset();
  const startUtc = new Date(startLocal.getTime() - offsetMin * 60_000);
  const endUtc = new Date(startUtc.getTime() + 86_400_000);
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "long", month: "long", day: "numeric"
  }).format(startUtc);
  return { startISO: startUtc.toISOString(), endISO: endUtc.toISOString(), label };
}
