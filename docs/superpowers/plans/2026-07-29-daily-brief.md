# Daily Brief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Quick Ask popover's read-only nudge list with a ranked, inline-actionable daily brief served by a new `GET /brief/today`.

**Architecture:** A pure server-side composer (`src/daily-brief.js`) reads the runtime's stores directly (no HTTP, no LLM), allocates slots per item kind, ranks within each kind using discriminators that kind actually has, and emits declarative actions the Mac client dispatches generically. A new Swift `BriefConsumer`/`BriefSection` renders it in the existing overlay panel.

**Tech Stack:** Node 22 ESM (server, `node --test`), Swift 5.9 / SwiftUI / SPM, macOS 14 deployment target.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-29-daily-brief-design.md`. Read it before starting.
- Composer is a **pure function of runtime stores + a clock**. It makes **no HTTP calls** and **never invokes an LLM**.
- Scores are comparable **only within a kind**. Never sort one global list across kinds.
- `categoryMultipliers()` returns `{}` on a real machine — every lookup MUST default: `multipliers[cat] ?? 1.0`. A `NaN` score is a test failure.
- Muting is read via `suggestionFeedback.isMuted(category)`, never inferred from a `0` multiplier.
- Suggestions with `category === "automation"` are excluded (no server-side accept branch exists).
- Suggestions are read via `listAllSuggestions(runtime, …)` from `src/suggestion-feed.js` — never via `runtime.proactiveObserver` directly (that only sees `prop_` ids).
- Node style: 2-space indent, double quotes, ESM `import`, no semicolon-free style. Match neighbouring files.
- Swift: everything `@MainActor`; new files under `mac/Sources/OpenAGI/Overlay/Brief/`. Do not grow `AppState.swift`.
- Never commit anything under `~/.openagi`.
- Commit messages: plain text only, **no backticks** (the shell strips backticked text via command substitution).

---

### Task 1: Fix the two Swift HTTP bugs

**Files:**
- Modify: `mac/Sources/OpenAGI/AppState.swift:450-468`

**Interfaces:**
- Consumes: nothing.
- Produces: `AppState.get`/`post` that preserve query strings and throw on non-2xx. Task 6 relies on both.

**Context:** `baseURL.appendingPathComponent("/tasks?queue=user")` percent-encodes the `?`, producing `/tasks%3Fqueue=user`, which 404s. `post` ignores the HTTP status entirely, so a 500 decodes to nil and surfaces as "(no reply)".

- [ ] **Step 1: Replace both helpers**

In `mac/Sources/OpenAGI/AppState.swift`, replace the two functions under `// MARK: — HTTP helpers`:

```swift
  // MARK: — HTTP helpers

  /// Build a request URL from a daemon path that MAY carry a query string.
  /// `URL.appendingPathComponent` percent-encodes "?" (so "/tasks?queue=user"
  /// becomes "/tasks%3Fqueue=user" and 404s), which silently emptied every
  /// query-string fetch in this file. Split the query off and let
  /// URLComponents own it.
  nonisolated static func buildURL(base: URL, path: String) -> URL {
    let parts = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
    let rawPath = String(parts.first ?? "")
    var comps = URLComponents(url: base.appendingPathComponent(rawPath), resolvingAgainstBaseURL: false)
    if parts.count > 1, !parts[1].isEmpty { comps?.percentEncodedQuery = String(parts[1]) }
    return comps?.url ?? base.appendingPathComponent(rawPath)
  }

  /// Throw on any non-2xx so callers see a real error instead of decoding
  /// an error body into nil and rendering it as "(no reply)".
  nonisolated static func ensureOK(_ resp: URLResponse, _ data: Data) throws {
    guard let http = resp as? HTTPURLResponse else { return }
    guard (200..<300).contains(http.statusCode) else {
      let snippet = String(data: data.prefix(300), encoding: .utf8) ?? ""
      throw NSError(domain: "OpenAGI", code: http.statusCode, userInfo: [
        NSLocalizedDescriptionKey: "HTTP \(http.statusCode)\(snippet.isEmpty ? "" : ": \(snippet)")"
      ])
    }
  }

  private func get<T: Decodable>(_ path: String) async throws -> T {
    var req = URLRequest(url: Self.buildURL(base: baseURL, path: path))
    if let token = authToken() { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    let (data, resp) = try await URLSession.shared.data(for: req)
    try Self.ensureOK(resp, data)
    return try JSONDecoder().decode(T.self, from: data)
  }

  private func post(_ path: String, body: Data? = nil) async throws -> Data {
    var req = URLRequest(url: Self.buildURL(base: baseURL, path: path))
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    if let token = authToken() { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    if let body = body { req.httpBody = body }
    let (data, resp) = try await URLSession.shared.data(for: req)
    try Self.ensureOK(resp, data)
    return data
  }
```

- [ ] **Step 2: Build**

Run: `cd /Users/shooby/Dev/openAGI/mac && swift build -c release --product OpenAGI 2>&1 | tail -5`
Expected: `Build of product 'OpenAGI' complete!`

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/OpenAGI/AppState.swift
git commit -m "fix(mac): preserve query strings in AppState.get and throw on non-2xx"
```

---

### Task 2: Fix the nudge title parse

**Files:**
- Modify: `mac/Sources/OpenAGI/AppState.swift` (the `proactive-suggestion` SSE handler, ~line 328)

**Interfaces:**
- Consumes: nothing. Produces: correct notification titles.

**Context:** `parseSkillCandidate` reads `name`/`description`, but the payload sends `title`/`rationale` (`src/proactive-observer.js:300-306`), so every notification title falls through to the literal `"OpenAGI noticed something"`. The body already reads `rationale` correctly and needs no change.

- [ ] **Step 1: Read the payload's real field**

In the `if event == "proactive-suggestion" {` block, find:

```swift
      let title = "\(prefix): \(parsed.name ?? "OpenAGI noticed something")"
```

Replace with:

```swift
      // The payload sends title/rationale (src/proactive-observer.js:300-306);
      // parseSkillCandidate reads name/description, which are absent here, so
      // this fell through to the placeholder for every suggestion ever sent.
      let suggestionTitle = parseField(data, "title") ?? parsed.name ?? "OpenAGI noticed something"
      let title = "\(prefix): \(suggestionTitle)"
```

- [ ] **Step 2: Build**

Run: `cd /Users/shooby/Dev/openAGI/mac && swift build -c release --product OpenAGI 2>&1 | tail -3`
Expected: `Build of product 'OpenAGI' complete!`

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/OpenAGI/AppState.swift
git commit -m "fix(mac): read suggestion title from the payload field the server actually sends"
```

---

### Task 3: Persist the daily plan to a cache file

**Files:**
- Modify: `src/abi-runtime.js` (`runDailyPlan`, ~line 979)
- Test: `test/daily-brief.test.js` (created in Task 4; this task adds no test of its own — Task 4's composer tests read the artifact this writes)

**Interfaces:**
- Consumes: `computeDailyPlan` from `./daily-planner.js`.
- Produces: `<dataDir>/plan/<dateISO>.json` containing the full plan object. Task 4's `readPlanCache` reads it.

**Context:** `GET /plan/daily` calls the LLM on every request, so the popover can never call it. The 08:00 cron already computes the plan; it just never persists the JSON. The write must go **above** the existing skip guard so a thin day still yields a cache file — on the target machine `counts.focus` is currently 1 and `counts.events` 0, and a future empty day would otherwise leave no artifact at all.

- [ ] **Step 1: Write the cache before the skip guard**

In `src/abi-runtime.js`, in `runDailyPlan`, find:

```js
    const plan = await computeDailyPlan(this, { date: now });
    // Skip a truly empty day rather than firing a hollow notification.
    if (plan.counts.events === 0 && plan.counts.focus === 0) {
      return { skipped: true, reason: "nothing scheduled and no pending tasks" };
    }
```

Replace with:

```js
    const plan = await computeDailyPlan(this, { date: now });
    // Persist BEFORE the skip guard. GET /plan/daily re-runs the LLM on every
    // request, so the Quick Ask brief can never call it — it reads this cache
    // instead. A thin day must still leave an artifact, otherwise the brief
    // has no plan to pin all day. The guard below suppresses only the
    // notification, never the cache write.
    try {
      const { writeJsonAtomic } = await import("./file-utils.js");
      const pathMod = await import("node:path");
      const dir = pathMod.default.join(this.dataDir ?? resolveDataDir(), "plan");
      fsSync.mkdirSync(dir, { recursive: true });
      writeJsonAtomic(pathMod.default.join(dir, `${plan.dateISO}.json`), {
        ...plan,
        cachedAt: new Date().toISOString()
      });
    } catch (error) {
      console.warn(`[openagi] daily plan cache write failed: ${error.message}`);
    }
    // Skip a truly empty day rather than firing a hollow notification.
    if (plan.counts.events === 0 && plan.counts.focus === 0) {
      return { skipped: true, reason: "nothing scheduled and no pending tasks" };
    }
```

- [ ] **Step 2: Ensure `fsSync` and `resolveDataDir` are imported in abi-runtime.js**

Run: `grep -n "^import fsSync\|^import fs\|resolveDataDir" src/abi-runtime.js | head -5`

If `fsSync` is not imported, add `import fsSync from "node:fs";` to the import block at the top. If `resolveDataDir` is not imported, add `import { resolveDataDir } from "./data-dir.js";`. If a differently-named fs import already exists (e.g. `fs`), use that name instead of `fsSync` in Step 1 rather than adding a duplicate import.

- [ ] **Step 3: Verify the whole suite still passes**

Run: `node --test 2>&1 | tail -6`
Expected: `# fail 0`

- [ ] **Step 4: Commit**

```bash
git add src/abi-runtime.js
git commit -m "feat(brief): persist the daily plan to a cache file the brief can read"
```

---

### Task 4: The brief composer

**Files:**
- Create: `src/daily-brief.js`
- Test: `test/daily-brief.test.js`

**Interfaces:**
- Consumes: `listAllSuggestions` from `./suggestion-feed.js`; `runtime.tasks.list`, `runtime.drafts.list`, `runtime.clarifications.list`; `runtime.suggestionFeedback?.isMuted`; the plan cache from Task 3.
- Produces: `composeBrief(runtime, { now, limit }) -> { items, older, generatedAt, planCachedAt, degraded }`. Task 5 serializes it; Task 6 renders it.

**Context:** This is the heart of the feature. Read the spec's Ranking section first. The single most important behaviour: **with 1,000 suggestions and 3 overdue tasks, at least one suggestion must appear.** A naive global sort makes tasks win every slot because 0 of 1,092 real suggestions carry a `dueDate` or `priority`.

- [ ] **Step 1: Write the failing test**

Create `test/daily-brief.test.js`:

```js
// test/daily-brief.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { composeBrief } from "../src/daily-brief.js";

const NOW = new Date("2026-07-29T17:00:00.000Z");

// A runtime stub shaped like the real one: stores expose list(), and
// suggestions come from files that listAllSuggestions() walks. Keeping this a
// plain object (not a real AbiRuntime) is what makes the composer testable —
// it must never reach for HTTP or an LLM.
function makeRuntime({ tasks = [], drafts = [], clarifications = [], suggestions = [], muted = [], plan = null } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-brief-"));
  const sugDir = path.join(dataDir, "proactive", "suggestions");
  const minedDir = path.join(dataDir, "skills-suggested");
  fs.mkdirSync(sugDir, { recursive: true });
  fs.mkdirSync(minedDir, { recursive: true });
  for (const s of suggestions) {
    const dir = s.id.startsWith("prop_") ? sugDir : minedDir;
    fs.writeFileSync(path.join(dir, `${s.id}.json`), JSON.stringify(s));
  }
  if (plan) {
    const planDir = path.join(dataDir, "plan");
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, `${plan.dateISO}.json`), JSON.stringify(plan));
  }
  return {
    dataDir,
    tasks: { list: () => tasks },
    drafts: { list: () => drafts },
    clarifications: { list: () => clarifications },
    suggestionFeedback: {
      isMuted: (c) => muted.includes(c),
      categoryMultipliers: () => ({}) // the real-world value: nothing resolved in-window
    }
  };
}

function task(over = {}) {
  return {
    id: "t1", queue: "user", title: "A task", bucket: "today", priority: 50,
    status: "pending", dueDate: null, createdAt: "2026-07-29T09:00:00.000Z", source: "manual", ...over
  };
}

function minedSuggestion(over = {}) {
  return {
    id: "sug_1", proposedAt: "2026-07-29T10:00:00.000Z", category: "skill",
    title: "Save this workflow", rationale: "seen often", status: "pending", source: "pattern-miner",
    sequence: { confidence: 0.8, count: 9, distinctDays: 4, cadence: { type: "weekly" } }, ...over
  };
}

test("a huge suggestion backlog still yields at least one suggestion alongside overdue tasks", () => {
  // The regression this whole design exists to prevent: suggestions carry no
  // dueDate/priority, so one global sort lets tasks take every slot.
  const suggestions = Array.from({ length: 1000 }, (_, i) =>
    minedSuggestion({ id: `sug_${i}`, sequence: { confidence: 0.6 + (i % 30) / 100, count: i % 12, distinctDays: i % 6, cadence: { type: "irregular" } } })
  );
  const tasks = [
    task({ id: "t1", title: "Overdue A", dueDate: "2026-07-20T00:00:00.000Z" }),
    task({ id: "t2", title: "Overdue B", dueDate: "2026-07-21T00:00:00.000Z" }),
    task({ id: "t3", title: "Overdue C", dueDate: "2026-07-22T00:00:00.000Z" })
  ];
  const brief = composeBrief(makeRuntime({ tasks, suggestions }), { now: NOW, limit: 5 });
  assert.ok(brief.items.some((i) => i.kind === "suggestion"), "at least one suggestion must survive slot allocation");
  assert.ok(brief.items.filter((i) => i.kind === "task").length <= 2, "tasks are capped at their slot count");
  assert.equal(brief.older.count, 1000 - brief.items.filter((i) => i.kind === "suggestion").length);
});

test("empty category multipliers never produce NaN scores", () => {
  // categoryMultipliers() returns {} on a real install (nothing resolved in
  // the 30-day window). Without a ?? 1.0 default every score is NaN and the
  // sort order becomes implementation-defined.
  const brief = composeBrief(makeRuntime({ suggestions: [minedSuggestion()] }), { now: NOW, limit: 5 });
  for (const item of brief.items) {
    assert.ok(Number.isFinite(item.score), `score must be finite, got ${item.score} for ${item.id}`);
  }
});

test("muted categories are excluded", () => {
  const rt = makeRuntime({ suggestions: [minedSuggestion({ id: "sug_1", category: "skill" })], muted: ["skill"] });
  const brief = composeBrief(rt, { now: NOW, limit: 5 });
  assert.equal(brief.items.filter((i) => i.kind === "suggestion").length, 0);
});

test("automation suggestions never appear (no server-side accept branch exists)", () => {
  const rt = makeRuntime({ suggestions: [minedSuggestion({ id: "sug_a", category: "automation" })] });
  const brief = composeBrief(rt, { now: NOW, limit: 5 });
  assert.equal(brief.items.length, 0);
});

test("a plan focus item is pinned first even though it has no due date", () => {
  const plan = {
    dateISO: "2026-07-29", cachedAt: "2026-07-29T15:00:00.000Z",
    focus: [{ title: "Ship the brief", taskId: null, why: "biggest lever today" }], tasks: []
  };
  const tasks = [task({ id: "t1", title: "Overdue", dueDate: "2026-07-01T00:00:00.000Z" })];
  const brief = composeBrief(makeRuntime({ tasks, plan }), { now: NOW, limit: 5 });
  assert.equal(brief.items[0].kind, "focus");
  assert.equal(brief.items[0].title, "Ship the brief");
  assert.equal(brief.planCachedAt, "2026-07-29T15:00:00.000Z");
});

test("a focus item with an unresolvable taskId still renders, with no task actions", () => {
  const plan = {
    dateISO: "2026-07-29", cachedAt: "2026-07-29T15:00:00.000Z",
    focus: [{ title: "Hallucinated", taskId: "t_does_not_exist", why: "x" }], tasks: []
  };
  const brief = composeBrief(makeRuntime({ plan }), { now: NOW, limit: 5 });
  assert.equal(brief.items[0].kind, "focus");
  assert.deepEqual(brief.items[0].actions, []);
});

test("a task that is already the pinned focus does not also occupy a task slot", () => {
  const plan = {
    dateISO: "2026-07-29", cachedAt: "2026-07-29T15:00:00.000Z",
    focus: [{ title: "The one thing", taskId: "t1", why: "overdue" }], tasks: []
  };
  const tasks = [task({ id: "t1", title: "The one thing" }), task({ id: "t2", title: "Other" })];
  const brief = composeBrief(makeRuntime({ tasks, plan }), { now: NOW, limit: 5 });
  assert.equal(brief.items.filter((i) => i.id === "task:t1").length, 0);
  assert.equal(brief.items.filter((i) => i.id === "focus:t1").length, 1);
});

test("miner suggestions rank on their own evidence, strongest first", () => {
  const weak = minedSuggestion({ id: "sug_weak", sequence: { confidence: 0.55, count: 1, distinctDays: 1, cadence: { type: "irregular" } } });
  const strong = minedSuggestion({ id: "sug_strong", sequence: { confidence: 0.95, count: 12, distinctDays: 6, cadence: { type: "weekly" } } });
  const brief = composeBrief(makeRuntime({ suggestions: [weak, strong] }), { now: NOW, limit: 5 });
  const sugs = brief.items.filter((i) => i.kind === "suggestion");
  assert.equal(sugs[0].id, "suggestion:sug_strong");
});

test("overdue tasks outrank not-yet-due ones", () => {
  const tasks = [
    task({ id: "t_soon", title: "Later", bucket: "this_week", dueDate: "2026-08-20T00:00:00.000Z" }),
    task({ id: "t_late", title: "Overdue", dueDate: "2026-07-01T00:00:00.000Z" })
  ];
  const brief = composeBrief(makeRuntime({ tasks }), { now: NOW, limit: 5 });
  const t = brief.items.filter((i) => i.kind === "task");
  assert.equal(t[0].id, "task:t_late");
});

test("a failing source is isolated and named in degraded", () => {
  const rt = makeRuntime({ suggestions: [minedSuggestion()] });
  rt.tasks = { list: () => { throw new Error("boom"); } };
  const brief = composeBrief(rt, { now: NOW, limit: 5 });
  assert.ok(brief.degraded.includes("tasks"));
  assert.ok(brief.items.length > 0, "the brief still renders without the failed source");
});

test("no plan cache is a normal state, not an error", () => {
  const brief = composeBrief(makeRuntime({ tasks: [task()] }), { now: NOW, limit: 5 });
  assert.equal(brief.planCachedAt, null);
  assert.equal(brief.degraded.includes("plan"), false);
  assert.ok(brief.items.length > 0);
});

test("every item carries declarative actions with an absolute daemon path", () => {
  const tasks = [task({ id: "t1" })];
  const brief = composeBrief(makeRuntime({ tasks, suggestions: [minedSuggestion()] }), { now: NOW, limit: 5 });
  for (const item of brief.items) {
    for (const a of item.actions) {
      assert.ok(a.path.startsWith("/"), `action path must be absolute: ${a.path}`);
      assert.ok(["POST", "PATCH", "DELETE"].includes(a.method));
      assert.ok(a.label.length > 0);
    }
  }
});

test("clarifications and drafts get slots and age-based scores", () => {
  const rt = makeRuntime({
    clarifications: [{ id: "c1", question: "Did you finish X?", status: "pending", createdAt: "2026-07-28T17:00:00.000Z", taskId: "t1" }],
    drafts: [{ id: "d1", title: "Reply to Adam", status: "pending", createdAt: "2026-07-27T17:00:00.000Z", kind: "email" }]
  });
  const brief = composeBrief(rt, { now: NOW, limit: 5 });
  assert.ok(brief.items.some((i) => i.kind === "clarification"));
  assert.ok(brief.items.some((i) => i.kind === "draft"));
  const clar = brief.items.find((i) => i.kind === "clarification");
  assert.equal(clar.actions.length, 4, "one button per valid answer");
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --test test/daily-brief.test.js 2>&1 | tail -5`
Expected: FAIL — `Cannot find module '../src/daily-brief.js'`

- [ ] **Step 3: Write the composer**

Create `src/daily-brief.js`:

```js
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
import path from "node:path";
import { readJsonFile } from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";
import { listAllSuggestions } from "./suggestion-feed.js";

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

  const slots = slotPlan(limit);
  const items = [];

  // ── focus (pinned, never scored against anything) ──────────────────────
  const focusItems = buildFocus(plan, tasks, slots.focus);
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
  // pile of overdue tasks squeezes suggestions out entirely.
  const reserve = rankedSuggestions.length > 0 ? Math.min(slots.suggestionFloor, remainingAfter()) : 0;
  items.push(...take(rankedTasks, Math.max(0, Math.min(slots.task, remainingAfter() - reserve))));
  items.push(...take(rankedSuggestions, Math.min(reserve, remainingAfter())));

  // Cascade any still-unused slots: more tasks first, then more suggestions.
  items.push(...take(rankedTasks, remainingAfter()));
  items.push(...take(rankedSuggestions, remainingAfter()));

  const shownSuggestionIds = new Set(items.filter((i) => i.kind === "suggestion").map((i) => i.id));
  const olderCount = suggestions.filter((s) => !shownSuggestionIds.has(`suggestion:${s.id}`)).length;
  const oldestAt = suggestions.length
    ? suggestions.reduce((min, s) => (s.proposedAt && (!min || s.proposedAt < min) ? s.proposedAt : min), null)
    : null;

  return {
    items: items.map(stripInternal),
    older: { count: olderCount, oldestAt },
    generatedAt: new Date(nowMs).toISOString(),
    planCachedAt: plan?.cachedAt ?? null,
    degraded
  };
}

// ─── per-kind builders ───────────────────────────────────────────────────

function buildFocus(plan, tasks, max) {
  const focus = Array.isArray(plan?.focus) ? plan.focus.slice(0, max) : [];
  return focus.map((f) => {
    // The model can emit a taskId that does not exist. Resolve defensively;
    // an unresolvable id yields a readable row with no task actions rather
    // than a broken button.
    const task = f.taskId ? tasks.find((t) => t.id === f.taskId) : null;
    return {
      id: `focus:${f.taskId ?? slug(f.title)}`,
      kind: "focus",
      title: f.title,
      why: f.why || "in today's plan",
      score: 1,
      scoreBreakdown: { pinned: true },
      dueAt: task?.dueDate ?? null,
      source: "daily-plan",
      actions: task ? taskActions(task.id) : [],
      deepLink: "/?tab=today",
      sourceTaskId: task?.id ?? null
    };
  });
}

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
    actions: taskActions(t.id),
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
  return {
    id: `draft:${d.id}`,
    kind: "draft",
    title: d.title || "(untitled draft)",
    why: `draft waiting${d.kind && d.kind !== "other" ? ` · ${d.kind}` : ""}`,
    score,
    scoreBreakdown: { age: score },
    dueAt: null,
    source: "agent",
    actions: [
      { id: "approve", label: "Approve", style: "primary", method: "POST", path: `/drafts/${encodeURIComponent(d.id)}/approve`, body: null },
      { id: "discard", label: "Discard", style: "destructive", method: "POST", path: `/drafts/${encodeURIComponent(d.id)}/discard`, body: null }
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
      const late = Math.max(1, Math.round(-deltaDays));
      return { value: 1.0, label: `overdue ${late}d` };
    }
    if (deltaDays < 1) return { value: 0.85, label: "due today" };
    if (deltaDays <= 3) return { value: 0.6, label: `due in ${Math.ceil(deltaDays)}d` };
  }
  const idx = BUCKETS.indexOf(t.bucket);
  if (idx >= 0) return { value: Math.max(0, 0.5 - 0.1 * idx), label: t.bucket.replace(/_/g, " ") };
  return { value: 0, label: "" };
}

function carriedOver(t, nowMs) {
  if (t.bucket !== "today" || !t.createdAt) return false;
  const startOfToday = new Date(nowMs);
  startOfToday.setUTCHours(0, 0, 0, 0);
  return new Date(t.createdAt).getTime() < startOfToday.getTime();
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

function taskActions(id) {
  return [
    { id: "complete", label: "Done", style: "primary", method: "POST", path: `/tasks/${encodeURIComponent(id)}/complete`, body: null },
    { id: "snooze", label: "Snooze", style: "secondary", method: "PATCH", path: `/tasks/${encodeURIComponent(id)}`, body: { bucket: "this_week" } }
  ];
}

// ─── plumbing ────────────────────────────────────────────────────────────

/// Read the plan artifact the 08:00 cron writes. A missing file is the normal
/// first-run state, NOT a degraded source — the brief simply has nothing to
/// pin and fills every slot from the live stores instead.
function readPlanCache(dataDir, now) {
  const iso = new Date(now).toISOString().slice(0, 10);
  return readJsonFile(path.join(dataDir, "plan", `${iso}.json`), null);
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
```

- [ ] **Step 4: Run the tests until they pass**

Run: `node --test test/daily-brief.test.js 2>&1 | tail -8`
Expected: `# fail 0` with 13 passing tests.

- [ ] **Step 5: Run the whole suite**

Run: `node --test 2>&1 | tail -6`
Expected: `# fail 0`

- [ ] **Step 6: Commit**

```bash
git add src/daily-brief.js test/daily-brief.test.js
git commit -m "feat(brief): slot-allocated, per-kind-ranked daily brief composer"
```

---

### Task 5: The GET /brief/today route

**Files:**
- Modify: `src/hosted-interface.js` (import block near line 24; new route beside the other GET routes, e.g. after the `/nodes` block)
- Test: `test/brief-route.test.js`

**Interfaces:**
- Consumes: `composeBrief` from `./daily-brief.js`.
- Produces: `GET /brief/today?limit=N` returning the composer's object. Task 6 decodes it.

- [ ] **Step 1: Write the failing test**

Create `test/brief-route.test.js`:

```js
// test/brief-route.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

// dataDir is passed explicitly to BOTH the runtime and the interface:
// resolveDataDir() memoizes its first result, so relying on the env var would
// make a second instance in the same process silently reuse the first's dir.
async function bootApp(dataDir) {
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, tickerMs: 0, dataDir, authToken: null });
  const listened = await app.listen();
  return { runtime, app, base: listened.url ?? `http://127.0.0.1:${listened.port}` };
}

test("GET /brief/today returns a well-formed brief on an empty install", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-briefroute-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const res = await fetch(`${base}/brief/today`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(Array.isArray(json.items));
    assert.ok(json.older && typeof json.older.count === "number");
    assert.ok(json.generatedAt);
    assert.equal(json.planCachedAt, null);
    assert.ok(Array.isArray(json.degraded));
  } finally { await app.close(); }
});

test("GET /brief/today surfaces a real task with actionable buttons", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-briefroute2-"));
  const { runtime, app, base } = await bootApp(dataDir);
  try {
    runtime.tasks.add({ queue: "user", title: "Overdue thing", bucket: "today", dueDate: "2026-01-01T00:00:00.000Z" });
    const res = await fetch(`${base}/brief/today`);
    const json = await res.json();
    const item = json.items.find((i) => i.kind === "task");
    assert.ok(item, "the task should appear in the brief");
    assert.equal(item.title, "Overdue thing");
    assert.ok(item.why.includes("overdue"));
    const done = item.actions.find((a) => a.id === "complete");
    assert.ok(done && done.path.startsWith("/tasks/"));
    // The action must actually work when dispatched verbatim.
    const applied = await fetch(`${base}${done.path}`, { method: done.method, headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(applied.status, 200);
  } finally { await app.close(); }
});

test("GET /brief/today honours ?limit=", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-briefroute3-"));
  const { runtime, app, base } = await bootApp(dataDir);
  try {
    for (let i = 0; i < 6; i += 1) runtime.tasks.add({ queue: "user", title: `T${i}`, bucket: "today" });
    const res = await fetch(`${base}/brief/today?limit=2`);
    const json = await res.json();
    assert.ok(json.items.length <= 2);
  } finally { await app.close(); }
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node --test test/brief-route.test.js 2>&1 | tail -6`
Expected: FAIL — 404, so `json.items` is undefined.

- [ ] **Step 3: Add the import**

In `src/hosted-interface.js`, beside the other local imports near line 24, add:

```js
import { composeBrief } from "./daily-brief.js";
```

- [ ] **Step 4: Add the route**

Immediately after the closing brace of the `if (method === "GET" && pathname === "/nodes") { … }` block, add:

```js
      if (method === "GET" && pathname === "/brief/today") {
        const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "5", 10);
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(10, rawLimit)) : 5;
        // Pass the already-resolved dataDir (const at hosted-interface.js:50)
        // rather than letting the composer call the memoizing resolveDataDir().
        return sendJson(res, 200, composeBrief(runtime, { now: new Date(), limit, dataDir }));
      }
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/brief-route.test.js 2>&1 | tail -6`
Expected: `# fail 0`

- [ ] **Step 6: Run the whole suite**

Run: `node --test 2>&1 | tail -6`
Expected: `# fail 0`

- [ ] **Step 7: Commit**

```bash
git add src/hosted-interface.js test/brief-route.test.js
git commit -m "feat(brief): GET /brief/today serves the ranked brief"
```

---

### Task 6: The Mac brief section

**Files:**
- Create: `mac/Sources/OpenAGI/Overlay/Brief/BriefModels.swift`
- Create: `mac/Sources/OpenAGI/Overlay/Brief/BriefConsumer.swift`
- Create: `mac/Sources/OpenAGI/Overlay/Brief/BriefSection.swift`
- Modify: `mac/Sources/OpenAGI/Overlay/OverlayView.swift`
- Modify: `mac/Sources/OpenAGI/AppState.swift` (delete nudge state)

**Interfaces:**
- Consumes: `GET /brief/today` from Task 5; `AppState.buildURL`/`ensureOK` from Task 1.
- Produces: a rendered, actionable brief section replacing the nudge list.

**Context:** `BriefConsumer` talks to the LOCAL daemon (`http://127.0.0.1:43210`), unlike `OutreachConsumer` which points at the remote Distiller. `AppState.get`/`post` are `private`, so `BriefConsumer` carries its own helpers built on the two `nonisolated static` functions from Task 1.

- [ ] **Step 1: Create the wire models**

Create `mac/Sources/OpenAGI/Overlay/Brief/BriefModels.swift`:

```swift
import Foundation

// Wire shapes for GET /brief/today. Actions are DECLARATIVE — the server
// sends method+path+body so the client can dispatch any item kind without a
// per-kind lookup table, and a new server-side source needs no Swift change.

struct BriefAction: Decodable, Equatable, Identifiable {
  let id: String
  let label: String
  let style: String     // primary | secondary | destructive | revise
  let method: String    // POST | PATCH | DELETE
  let path: String
  let body: [String: AnyCodable]?
}

struct BriefItem: Decodable, Equatable, Identifiable {
  let id: String
  let kind: String      // focus | task | suggestion | draft | clarification
  let title: String
  let why: String
  let score: Double
  let dueAt: String?
  let source: String
  let actions: [BriefAction]
  let deepLink: String

  // Decode defensively: a slightly newer or older daemon must never break the
  // popover. Only id/kind/title are required.
  enum CodingKeys: String, CodingKey { case id, kind, title, why, score, dueAt, source, actions, deepLink }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "task"
    title = try c.decodeIfPresent(String.self, forKey: .title) ?? "(untitled)"
    why = try c.decodeIfPresent(String.self, forKey: .why) ?? ""
    score = try c.decodeIfPresent(Double.self, forKey: .score) ?? 0
    dueAt = try c.decodeIfPresent(String.self, forKey: .dueAt)
    source = try c.decodeIfPresent(String.self, forKey: .source) ?? "unknown"
    actions = try c.decodeIfPresent([BriefAction].self, forKey: .actions) ?? []
    deepLink = try c.decodeIfPresent(String.self, forKey: .deepLink) ?? "/"
  }
}

struct BriefOlder: Decodable, Equatable {
  let count: Int
  let oldestAt: String?
}

struct BriefResponse: Decodable, Equatable {
  let items: [BriefItem]
  let older: BriefOlder
  let generatedAt: String?
  let planCachedAt: String?
  let degraded: [String]

  enum CodingKeys: String, CodingKey { case items, older, generatedAt, planCachedAt, degraded }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    items = try c.decodeIfPresent([BriefItem].self, forKey: .items) ?? []
    older = try c.decodeIfPresent(BriefOlder.self, forKey: .older) ?? BriefOlder(count: 0, oldestAt: nil)
    generatedAt = try c.decodeIfPresent(String.self, forKey: .generatedAt)
    planCachedAt = try c.decodeIfPresent(String.self, forKey: .planCachedAt)
    degraded = try c.decodeIfPresent([String].self, forKey: .degraded) ?? []
  }
}

/// Minimal JSON value box so an action's `body` can round-trip back out to the
/// daemon verbatim without the client needing to know its schema.
struct AnyCodable: Codable, Equatable {
  let value: Any

  init(_ value: Any) { self.value = value }

  init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if let v = try? c.decode(Bool.self) { value = v }
    else if let v = try? c.decode(Int.self) { value = v }
    else if let v = try? c.decode(Double.self) { value = v }
    else if let v = try? c.decode(String.self) { value = v }
    else if let v = try? c.decode([String: AnyCodable].self) { value = v.mapValues { $0.value } }
    else if let v = try? c.decode([AnyCodable].self) { value = v.map { $0.value } }
    else { value = NSNull() }
  }

  func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch value {
    case let v as Bool: try c.encode(v)
    case let v as Int: try c.encode(v)
    case let v as Double: try c.encode(v)
    case let v as String: try c.encode(v)
    default: try c.encodeNil()
    }
  }

  static func == (a: AnyCodable, b: AnyCodable) -> Bool { "\(a.value)" == "\(b.value)" }
}
```

- [ ] **Step 2: Create the consumer**

Create `mac/Sources/OpenAGI/Overlay/Brief/BriefConsumer.swift`:

```swift
import Foundation

// Fetches GET /brief/today from the LOCAL daemon and dispatches an item's
// declarative actions back to it.
//
// Refresh model (pinned deliberately — three different precedents exist in
// this codebase): fetch on panel expand and on the SSE events that can change
// the brief. No timer. After a successful action the row is removed
// optimistically and a single refetch reconciles; on failure the row is
// restored and the server's message is surfaced.
@MainActor
final class BriefConsumer: ObservableObject {
  static let shared = BriefConsumer()

  @Published private(set) var items: [BriefItem] = []
  @Published private(set) var olderCount: Int = 0
  @Published private(set) var isLoading = false
  @Published private(set) var lastError: String? = nil
  /// Action ids currently in flight, keyed by item id. `accept` is NOT
  /// idempotent server-side (skill materialization dedupes into slug-2,
  /// slug-3), so a double tap must be impossible.
  @Published private(set) var inFlight: Set<String> = []

  private var baseURL: URL { AppState.shared.baseURL }
  private func token() -> String? { AppState.shared.authToken() }

  func refresh() async {
    isLoading = true
    defer { isLoading = false }
    do {
      var req = URLRequest(url: AppState.buildURL(base: baseURL, path: "/brief/today?limit=5"))
      req.timeoutInterval = 6
      if let t = token() { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
      let (data, resp) = try await URLSession.shared.data(for: req)
      try AppState.ensureOK(resp, data)
      let decoded = try JSONDecoder().decode(BriefResponse.self, from: data)
      items = decoded.items
      olderCount = decoded.older.count
      lastError = nil
    } catch {
      lastError = error.localizedDescription
    }
  }

  func act(_ item: BriefItem, _ action: BriefAction) async {
    guard !inFlight.contains(item.id) else { return }
    inFlight.insert(item.id)
    defer { inFlight.remove(item.id) }

    let snapshot = items
    items.removeAll { $0.id == item.id }   // optimistic

    do {
      var req = URLRequest(url: AppState.buildURL(base: baseURL, path: action.path))
      req.httpMethod = action.method
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.timeoutInterval = 10
      if let t = token() { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
      if let body = action.body {
        req.httpBody = try JSONSerialization.data(withJSONObject: body.mapValues { $0.value })
      } else if action.method != "DELETE" {
        req.httpBody = "{}".data(using: .utf8)
      }
      let (data, resp) = try await URLSession.shared.data(for: req)
      try AppState.ensureOK(resp, data)
      lastError = outcomeMessage(data)
      await refresh()
    } catch {
      items = snapshot            // restore — the decision was not recorded
      lastError = error.localizedDescription
    }
  }

  /// POST /proactive/suggestions/:id/accept returns POLYMORPHIC 200s: success
  /// shapes carry taskId / registered / skillSlug, but FAILURES also come back
  /// as 200 with a *Error field. Reporting a flat "Accepted" would lie, so
  /// read the body and say what actually happened.
  private func outcomeMessage(_ data: Data) -> String? {
    guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    for key in ["taskCreateError", "skillCreateError", "registerError", "error"] {
      if let msg = obj[key] as? String, !msg.isEmpty { return "Failed: \(msg)" }
    }
    if obj["taskId"] is String { return "Task added" }
    if let mcp = obj["registered"] as? String { return "Connected \(mcp)" }
    if let slug = obj["skillSlug"] as? String { return "Skill created: \(slug)" }
    return nil
  }
}
```

- [ ] **Step 3: Expose what the consumer needs on AppState**

`BriefConsumer` reads `AppState.shared.baseURL` and `authToken()`. Run:

`grep -n "var baseURL\|func authToken" mac/Sources/OpenAGI/AppState.swift`

If either is `private`, remove the `private` keyword (leave everything else alone). Do NOT make `get`/`post` public — `BriefConsumer` deliberately owns its own requests.

- [ ] **Step 4: Create the view**

Create `mac/Sources/OpenAGI/Overlay/Brief/BriefSection.swift`:

```swift
import SwiftUI

// Renders the ranked brief. Every button comes from the server's declarative
// `actions`, so this view has no per-kind switch and needs no change when a
// new source is added server-side.
struct BriefSection: View {
  @ObservedObject var brief = BriefConsumer.shared

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        Text("TODAY").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
        if !brief.items.isEmpty {
          Text("\(brief.items.count) things").font(.system(size: 10)).foregroundStyle(.tertiary)
        }
        Spacer()
        if brief.isLoading { ProgressView().controlSize(.small) }
      }

      if brief.items.isEmpty && !brief.isLoading {
        Text("Nothing needs you right now.").font(.system(size: 11)).foregroundStyle(.tertiary)
      }

      ForEach(brief.items) { item in
        row(item)
      }

      if let err = brief.lastError {
        Text(err).font(.system(size: 10))
          .foregroundStyle(err.hasPrefix("Failed") ? .red : .secondary)
          .lineLimit(2)
      }

      if brief.olderCount > 0 {
        Text("▾ \(brief.olderCount) older").font(.system(size: 10)).foregroundStyle(.tertiary)
      }
    }
  }

  @ViewBuilder private func row(_ item: BriefItem) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(alignment: .top, spacing: 5) {
        Text(icon(item.kind)).font(.system(size: 11))
        Text(item.title).font(.system(size: 12, weight: .semibold)).lineLimit(2)
      }
      if !item.why.isEmpty {
        Text(item.why).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(2)
      }
      if !item.actions.isEmpty {
        HStack(spacing: 6) {
          ForEach(item.actions) { action in
            Button(action.label) { Task { await brief.act(item, action) } }
              .buttonStyle(.borderless)
              .font(.system(size: 11))
              .foregroundStyle(tint(action.style))
              .disabled(brief.inFlight.contains(item.id))
          }
        }
      }
    }
  }

  private func icon(_ kind: String) -> String {
    switch kind {
    case "focus": return "🎯"
    case "task": return "✓"
    case "suggestion": return "💡"
    case "draft": return "📝"
    case "clarification": return "❓"
    default: return "•"
    }
  }

  private func tint(_ style: String) -> Color {
    switch style {
    case "primary": return .blue
    case "destructive": return .red
    default: return .secondary
    }
  }
}
```

- [ ] **Step 5: Swap the section into OverlayView**

In `mac/Sources/OpenAGI/Overlay/OverlayView.swift`:

1. Add `@ObservedObject var brief = BriefConsumer.shared` beside the other `@ObservedObject` properties at the top of the struct.
2. Replace the entire `if !app.nudges.isEmpty { … }` block (the one ending just before the closing `}` of `expandedPanel`'s `VStack`) with:

```swift
      if !brief.items.isEmpty || brief.isLoading {
        Divider()
        BriefSection()
      }
```

3. Change `pillBadgeCount` to:

```swift
  private var pillBadgeCount: Int { brief.items.count + outreach.items.count }
```

4. In the `.onChange` chain, replace `.onChange(of: app.nudges.count) { _, _ in onContentChange() }` with:

```swift
    .onChange(of: brief.items.count) { _, _ in onContentChange() }
```

(The panel is sized manually — anything that changes height MUST be in this allowlist or the panel keeps a stale frame and clips.)

5. In `onExpand`, trigger a fetch. Find where `expandedPanel` sets focus:

```swift
    .onAppear { fieldFocused = true }
```

Replace with:

```swift
    .onAppear { fieldFocused = true; Task { await brief.refresh() } }
```

- [ ] **Step 6: Delete the nudge state**

In `mac/Sources/OpenAGI/AppState.swift`:
1. Delete `@Published var nudges: [Nudge] = []` (~line 29).
2. Delete `struct Nudge: Identifiable, Equatable { … }` (~lines 68-73).
3. In the `proactive-suggestion` SSE handler, delete the five lines that build and insert the nudge (from `let nudge = Nudge(` through the `if nudges.count > 20 { … }` line). **Keep the `notify(...)` call above them** — the native notification stays.
4. Add a fetch so the brief updates live. At the end of that same `if event == "proactive-suggestion" {` block, add:

```swift
      Task { await BriefConsumer.shared.refresh() }
```

5. Do the same in the handlers for `task-updated` and `draft-created` if they exist; if they do not, skip — the expand-time fetch covers it.

- [ ] **Step 7: Build**

Run: `cd /Users/shooby/Dev/openAGI/mac && swift build -c release --product OpenAGI 2>&1 | tail -20`
Expected: `Build of product 'OpenAGI' complete!`

Fix any compile errors before continuing. Do NOT proceed with a failing build.

- [ ] **Step 8: Full server suite still green**

Run: `cd /Users/shooby/Dev/openAGI && node --test 2>&1 | tail -6`
Expected: `# fail 0`

- [ ] **Step 9: Commit**

```bash
git add mac/Sources/OpenAGI/Overlay/Brief mac/Sources/OpenAGI/Overlay/OverlayView.swift mac/Sources/OpenAGI/AppState.swift
git commit -m "feat(brief): ranked, inline-actionable brief section in the Quick Ask popover"
```

---

### Task 7: End-to-end verification against the live daemon

**Files:** none modified — this task only runs and reports.

**Context:** The developer's own daemon is running from the built app bundle. Verify the real thing, not just tests.

- [ ] **Step 1: Confirm the route answers on the live daemon**

The running daemon serves the OLD code until it is restarted, so first check the source-level server directly by booting a scratch instance:

```bash
cd /Users/shooby/Dev/openAGI
OPENAGI_DATA_DIR=$(mktemp -d) PORT=43299 node examples/hosted-server.js &
sleep 3
curl -s "http://127.0.0.1:43299/brief/today" | head -c 800
kill %1
```

Expected: a JSON object with `items`, `older`, `generatedAt`, `planCachedAt`, `degraded`.

- [ ] **Step 2: Verify against the developer's REAL data**

```bash
cd /Users/shooby/Dev/openAGI
TOKEN=$(grep '^OPENAGI_AUTH_TOKEN=' ~/.openagi/.env | cut -d= -f2)
OPENAGI_DATA_DIR="$HOME/.openagi" PORT=43299 OPENAGI_AUTH_TOKEN="$TOKEN" node examples/hosted-server.js > /tmp/brief-verify.log 2>&1 &
sleep 6
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:43299/brief/today" | python3 -m json.tool | head -60
kill %1
```

Expected, given the measured state of that install (1,092 pending suggestions, 0 pending user-queue tasks):
- `items` contains **at least one `kind: "suggestion"`** — this is the whole point of slot allocation.
- Every `score` is a finite number, never `null` or `NaN`.
- No item has `kind: "suggestion"` with an `automation` category.
- `older.count` is in the high hundreds.
- Suggestion `why` strings read like `seen 9x · across 4 days · weekly cadence`, not the placeholder.

Record the actual output in the final report. If any expectation fails, fix it before proceeding.

- [ ] **Step 3: Rebuild the app bundle**

```bash
cd /Users/shooby/Dev/openAGI
SIGN_IDENTITY="OpenAGI Local Signing" npm run build-mac-app 2>&1 | tail -6
```

Expected: `▶ Done. /Users/shooby/Dev/openAGI/build/OpenAGI.app`

- [ ] **Step 4: Report, do not restart**

Do NOT kill or relaunch the user's running OpenAGI.app — that is the user's call. Report that the bundle is rebuilt and needs a quit/reopen to take effect.

---

## Notes for the executor

- If a step's code does not apply cleanly because the surrounding source has drifted, adapt it to the real code rather than forcing a match — but preserve the *intent* and the comments explaining why.
- If you discover the plan is wrong about the code, stop and report rather than silently improvising a different design.
- Do not touch any file under `~/.openagi` except by reading it.
- Other uncommitted work by a separate session may exist in this working tree (`src/pattern-miner.js`, `src/skills.js`, `src/observation-store.js`, `src/abi-runtime.js`, and others). **Only `git add` the exact files each task names.** Never `git add -A`, never `git commit -a`.
