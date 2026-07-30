# Daily Brief — Design

## Problem

The Quick Ask popover (⌥Space) shows a "Nudges" list that cannot be acted on. Each row is a title, a truncated body, an external-link icon that punts to the web dashboard, and an X. There is no way to say yes, no, or "not that — do this instead" without leaving the popover.

Four defects underneath it, each verified against the running daemon on 2026-07-29:

1. **Every nudge carries the same title.** `parseSkillCandidate` reads `name`/`description` (`mac/Sources/OpenAGI/AppState.swift:375-380`) but the `proactive-suggestion` payload sends `title`/`rationale` (`src/proactive-observer.js:300-306`). The title falls through to the literal `"OpenAGI noticed something"` (`AppState.swift:330`). The *body* is fine — `AppState.swift:324` already reads `rationale` — so rows differ below the title but share one meaningless headline.
2. **The X button records nothing.** It runs `app.nudges.removeAll` (`mac/Sources/OpenAGI/Overlay/OverlayView.swift:149-153`) and calls no route. The suggestion stays `pending` server-side forever, keeps counting in the dashboard, and keeps feeding `suggestion-feedback` as unresolved. The user's judgment is silently discarded.
3. **The popover cannot see the queue at all.** `app.nudges` is populated *only* by the live SSE handler (`AppState.swift:328-336`), capped at 20, rendered 4 (`OverlayView.swift:139`). Nothing ever fetches `GET /proactive/suggestions`. Measured: **1,092 pending suggestions**, of which 523 are pattern-miner (`sug_`) and 2 session-miner (`ses_`) — neither source emits `proactive-suggestion`, so they can *never* appear in the popover under any circumstance. The popover shows at most 4 of the ~569 observer suggestions that happened to arrive since app launch.
4. **The tray's task list is dead code.** `AppState.get()` builds URLs with `baseURL.appendingPathComponent(path)` (`AppState.swift:452`), which percent-encodes `?`. Every query-string fetch resolves to `/tasks%3Fqueue=…`, hits the catch-all 404, and decodes to `tasks: nil` because the field is Optional. `topTasks` has always been empty.

## Goal

Replace the nudge list with a **ranked daily brief**: a handful of items, each explaining why it is there, each actionable inline with yes / no / change. The user's framing: *"hey this is what I think is the most important thing for you to work on today."*

## Two measured facts that constrain the design

**The read path cannot use an LLM.** `GET /plan/daily` calls the model on every request (`daily-planner.js:216-270`), and `BudgetGuard.check()` *throws* `BUDGET_EXCEEDED` at the cap (`src/budget-guard.js:56-64`, called from `model-provider.js:82,229`). Daily spend has sat at or near the $10 cap for weeks. A brief that needs a model to render is unavailable most afternoons.

**Ranking every kind on one scale does not work.** Measured against the live store: **0 of 1,092 pending suggestions carry a `dueDate` or a `priority`** — the unified envelope (`suggestion-feed.js:18-24`) has no such fields, and neither do drafts (`draft-store.js:51-64`) or clarifications (`clarification-store.js:61-73`). A single formula weighted on due-date and priority scores all 1,058 non-`automation` suggestions *identically*, so tasks win every slot and the brief silently degenerates into a task list. The design must rank **within** kinds, not across them.

The corollary is that each kind must be ranked by discriminators it actually has. Suggestions do carry rich ones: 523 of them have a `sequence` block with `confidence`, `count`, `distinctDays`, `distinctWeeks`, `cadence.type`, and `weekdayStability` (`suggestion-feed.js:128-147`) — currently unused for ordering anywhere.

## Architecture

Five pieces.

1. **Plan cache** (new). `runDailyPlan` (`abi-runtime.js:979-1024`) already computes the plan at 08:00. It additionally writes the plan JSON to `<dataDir>/plan/<dateISO>.json`. **The write goes above the skip guard** at `abi-runtime.js:982-984`, so a thin day still produces a cache file; the guard continues to suppress only the notification. This is the one place an LLM runs on the brief's behalf — once daily, on an existing schedule.
2. **Brief composer** (new, `src/daily-brief.js`). `composeBrief(runtime, { now, limit })` — a **pure function of the runtime's stores plus a clock**. It reads `runtime.tasks`, `runtime.drafts`, `runtime.clarifications`, `listAllSuggestions(runtime, …)` (`suggestion-feed.js:29`), and the plan-cache file **directly. It makes no HTTP calls** — not even to its own daemon.
3. **`GET /brief/today`** (new route). Serializes the composer's output.
4. **Mac brief section** (new, `mac/Sources/OpenAGI/Overlay/Brief/`). `BriefConsumer.swift` fetches and acts; `BriefSection.swift` renders. Replaces the nudge block in `OverlayView.expandedPanel`.
5. **Revise** (`POST /brief/items/:id/revise`). Phase 4 — see Build phases.

### Sources (v1)

Local daemon only: cached plan `focus`, tasks, pending suggestions, drafts, clarifications. The Distiller's outreach keeps its existing "Needs you" section untouched. Cross-host merge is out of scope.

## Data shapes

```
// BriefItem — one shape for every source
{
  id: string,               // "<kind>:<sourceId>", e.g. "task:t_abc", "suggestion:sug_123"
  kind: "focus" | "task" | "suggestion" | "draft" | "clarification",
  title: string,
  why: string,              // rationale rendered from scoreBreakdown
  score: number,            // 0..1, comparable ONLY within a kind
  scoreBreakdown: object,   // kind-specific terms, for explainability and tests
  dueAt: ISO8601 | null,
  source: string,           // "linear" | "buildbetter" | "observer" | "pattern-miner" | "manual" | …
  actions: BriefAction[],
  deepLink: string
}

// BriefAction — declarative, so the client renders any source generically
{
  id: string,               // "complete" | "accept" | "reject" | "snooze" | "revise" | "answer:<value>"
  label: string,            // "Done" | "Yes" | "No" | "Snooze" | "Change…"
  style: "primary" | "secondary" | "destructive" | "revise",
  method: "POST" | "PATCH" | "DELETE",
  path: string,             // absolute daemon path, already id-encoded
  body: object | null
}

// GET /brief/today response
{
  items: BriefItem[],       // slot-allocated (see Ranking), then ordered by slot rank
  older: { count: number, oldestAt: ISO8601 | null },
  generatedAt: ISO8601,
  planCachedAt: ISO8601 | null,
  degraded: string[]        // names of sources that failed to load
}
```

`actions` being server-authored is the load-bearing decision. The dashboard hardcodes each section's buttons in HTML (`hosted-interface.js:4364-4368`, `:4388-4396`), which the Mac cannot see. Describing them declaratively means a new source needs no Swift change. It extends the precedent the popover already decodes — `OutreachItem.actions: [String]` (`OutreachModels.swift:8-35`) — by adding method/path/body so the client needs no lookup table.

### Action mapping per kind

| kind | actions |
|---|---|
| `focus` | when `taskId` resolves: Done → `POST /tasks/<id>/complete`, Snooze → `PATCH /tasks/<id>` `{bucket:"this_week"}`; otherwise `deepLink` only |
| `task` | Done → `POST /tasks/<id>/complete`; Snooze → `PATCH /tasks/<id>` `{bucket:"this_week"}` |
| `suggestion` | Yes → `POST /proactive/suggestions/<id>/accept`; No → `POST /proactive/suggestions/<id>/reject` |
| `draft` | Approve → `POST /drafts/<id>/approve`; Discard → `POST /drafts/<id>/discard` |
| `clarification` | one button per allowed answer → `POST /tasks/clarifications/<id>/answer` |

Routes verified: `POST /tasks/:id/complete` (`hosted-interface.js:1090`), `PATCH /tasks/:id` (`:1083`), `POST /proactive/suggestions/:id/(accept|reject|dismiss)` (`:1199`). `Change…` is added to every kind in phase 4 only.

## Ranking

**Slot allocation, then intra-kind ranking.** No score is ever compared across kinds.

Slots for `limit: 5` (the default):

| slot | kind | count |
|---|---|---|
| 1 | `focus` (pinned) | up to 1 |
| 2 | `clarification` | up to 1 |
| 3 | `draft` | up to 1 |
| 4–5 | `task` | up to 2 |
| ≥1 guaranteed | `suggestion` | fills any unused slot, minimum 1 |

Unused slots cascade to `task`, then `suggestion`. The suggestion minimum is a hard floor: the brief must always surface at least one thing the agent noticed, which is the entire point of the feature.

`focus` is **pinned above the ranked list, never scored against it.** A plan focus item is `{title, taskId, why}` only (`daily-planner.js:262-268`) — it has no due date, priority, or bucket, so any shared formula would sink the LLM's top pick to the bottom. When `focus.taskId` is null or names a task id that does not exist (the model can hallucinate ids), the item still renders with `deepLink` only and no task actions.

### Per-kind scoring

**task** — `0.55·dueUrgency + 0.30·(priority/100) + 0.15·carriedOver`

```
dueUrgency = overdue        ? 1.0
           : dueToday       ? 0.85
           : dueWithin3d    ? 0.6
           : bucketIndex>=0 ? max(0, 0.5 - 0.1 · bucketIndex)
           : 0
```
`bucketIndex` is the position in `BUCKETS` (`task-store.js:24`); bucket `done` is excluded from the brief entirely. `carriedOver` is 1.0 when bucket is `today` and `createdAt` precedes today, matching `pullCarriedOver` (`daily-planner.js:185-192`). `overdue` is already computed at `daily-planner.js:170` and preserved on the cached plan at `plan.tasks[].overdue` via the `...inputs` spread (`daily-planner.js:41`), so the composer reads it rather than recomputing.

**suggestion (miner, has `sequence`)** — `0.40·confidence + 0.30·countRamp + 0.20·distinctDaysRamp + 0.10·cadenceRegularity`

```
confidence         = sequence.confidence            // already 0..1, floor 0.55
countRamp          = min(1, sequence.count / 10)
distinctDaysRamp   = min(1, sequence.distinctDays / 5)
cadenceRegularity  = sequence.cadence?.type && type !== "irregular" ? 1 : 0
```

**suggestion (observer, no `sequence`)** — `recency` alone: `max(0, 1 - ageDays/14)`. Observer candidates carry no frequency evidence, so a freshly-noticed one outranks a stale one and nothing else is claimed.

**draft / clarification** — `min(1, ageHours / 48)`, matching the "still waiting" rule (`outreach-digest.js:8`). Both are decision-blocked by definition, so age is the honest discriminator.

### Category preference

Applied to **suggestions only** (the only kind with a suggestion `category`):

```
score = score · (multipliers[envelope.category] ?? 1.0)
```

The `?? 1.0` default is mandatory, not defensive: `categoryMultipliers()` (`suggestion-feedback.js:101-116`) only emits keys for categories with ≥3 *resolved* suggestions in a 30-day window. Verified live — `GET /proactive/preferences` returns `"multipliers": {}` and `"total": 0`, because 0 suggestions have been resolved in-window. Without the default, `score · undefined` is `NaN` and the sort order becomes implementation-defined.

Muting is a **separate** check — `suggestionFeedback.isMuted(category)` (`suggestion-feedback.js:121-124`) — because an absent key and a muted key are indistinguishable in the returned object.

`trackRecord` is **not in v1.** `outcomeStore.aggregate(windowDays, filter)` (`outcome-store.js:119`) has no per-source dimension; the record's `source` field (`:37`) is resolution provenance (`"system-inferred"`), not `"linear"`/`"buildbetter"`. It cannot be computed as such and is a follow-up.

`why` is rendered from the dominant terms of `scoreBreakdown` — e.g. `"overdue 3d · from your call w/ Adam"`, `"seen 9× across 4 days · weekly cadence"`. Every row explains itself.

### Deduplication

The same work can surface as a plan `focus` item, a task, and a draft. Items are keyed by resolved source id (`focus.taskId` → `task:<id>`). A task that is already the pinned `focus` item is dropped from the task slots; it never appears twice. Where a draft and a task collide, both are kept — they are different decisions (review the text vs finish the work) with non-contradictory actions.

## Client behavior

**Refresh model** (pinned, since three different precedents exist in-tree): fetch `GET /brief/today` on `onExpand()`, and on the SSE events `proactive-suggestion`, `task-updated`, and `draft-created`. **No timer.** After a successful action, optimistically remove the row, then refetch once. On failure, restore the row and surface the server's message. Buttons are disabled while their request is in flight — `accept` is not idempotent (`dedupeSlug` writes `slug-2`, `slug-3`, `skill-materialize.js:170-179`).

**Disposition of the existing nudge machinery**, per artifact:
- **Keep** the SSE `proactive-suggestion` handler for the *native notification* only, and fix its title parse (`name` → `title`).
- **Delete** `@Published var nudges` (`AppState.swift:29`), `struct Nudge` (`:68-73`), and the nudge block in `OverlayView.expandedPanel` (`:136-156`).
- **Redefine** `pillBadgeCount` (`OverlayView.swift:45`) as `brief.items.count + outreach.items.count`.
- **Replace** the `.onChange` entry `app.nudges.count` (`OverlayView.swift:39`) with the brief's published count, per Constraint 1.

**The `older` disclosure** renders `older.count` and is **not clickable in v1** — it opens nothing. It exists to tell the truth about queue depth. A triage surface is a separate spec.

## Error handling

- **Per-source isolation.** Each source loads independently; a failure names that source in `degraded[]` and the brief renders without it.
- **No plan cache** (first run of the day): `planCachedAt` is null, no `focus` slot is filled, and the remaining kinds fill all five slots. This is a normal state, not degraded.
- **Action failures are surfaced, not swallowed.** `POST /proactive/suggestions/:id/accept` returns **polymorphic 200s** — success shapes at `hosted-interface.js:1220` (`{registered}`), `:1233` (`{taskId}`), `:1249-1251` (`{skillSlug}`), and *error* shapes also as 200s at `:1222`, `:1232`, `:1260` (`registerError` / `taskCreateError` / `skillCreateError`). The client must read the body and report what happened ("Task added", "MCP connected", "Couldn't create skill: …"), never a flat "Accepted ✓".
- **`AppState.post()` ignores HTTP status entirely** (`AppState.swift:459-467`), so a 500 decodes to nil and surfaces as "(no reply)". It must check `HTTPURLResponse.statusCode` and throw on non-2xx **before** any button is wired to it.
- **`category: "automation"` has no accept branch.** The mcp (`:1214`), task (`:1229`), and skill (`:1241`) branches all miss and it falls through to `return sendJson(res, 200, candidate)` (`:1263`) — accepting one does nothing. 34 are pending. The composer excludes `automation` until a handler exists.
- **Non-idempotent accept.** Status is written at `:1208`, before materialization at `:1245-1247` (skill) and `:1231` (task), so a failure leaves an accepted suggestion with no artifact. In-flight button disabling is the v1 mitigation.

## Testing

`src/daily-brief.js` carries the behavioral coverage, as a pure function over fixture stores:

- Slot allocation: with 1,000 suggestions and 3 overdue tasks, **at least one suggestion is present** — the regression that motivated the design.
- Empty multipliers (`{}`) produce finite scores, never `NaN`; `isMuted` category is excluded.
- `focus` renders pinned and first even when its `taskId` is null or unresolvable.
- Dedupe: a task that is the pinned focus does not also occupy a task slot.
- `automation` suggestions never appear.
- Miner ranking: higher `confidence`/`count`/`distinctDays` outranks lower; observer suggestions rank by recency.
- Per-source failure yields `degraded[]` and a non-empty brief.
- Missing plan cache yields `planCachedAt: null` without error.
- `GET /brief/today`: shape, `limit`, `older.count`, auth gate.

**Swift side has no test infrastructure** — `mac/Package.swift` declares one `.executableTarget` and no `.testTarget`. Rather than stand one up for two bug fixes, the URL builder is extracted into a free function and the fixes are verified by written manual repro (confirm `/tasks?queue=user` populates `topTasks`; confirm a 500 surfaces as an error, not "(no reply)"). Adding a Swift test target is noted as follow-up work, not smuggled into this spec.

## Build phases

The review of this design flagged its original single-unit scope as too large. Four independently shippable units, in order:

- **Phase 0 — Bug fixes.** `AppState.get()` query preservation, `AppState.post()` non-2xx throw, `name`→`title` parse. No new surface; fixes the dead tray task list immediately. Ships alone.
- **Phase 1 — Plan cache + `GET /brief/today`.** Composer, slot allocation, per-kind ranking, dedupe, `older`, `degraded`. Entirely server-side, entirely testable, zero Swift.
- **Phase 2 — Mac brief section.** `BriefConsumer`/`BriefSection`, declarative action dispatch, refresh model, nudge removal.
- **Phase 3 — Revise ("Change…").** Deferred deliberately: it is the only LLM path, the only new mutation-adjacent surface, and the only one carrying a security invariant.

### Phase 3 design (for completeness, not for this plan)

`POST /brief/items/:id/revise` `{text}` must **not** route through `channels.handleLocalMessage` (`src/channels.js:22-34`) — that is the full agent with the entire tool registry, free to send, create, and mutate mid-turn, and it returns free-text with no schema.

Instead: a direct `modelProvider.generate` call with **no tools**, mirroring `synthesizeWithLLM` (`daily-planner.js:240-252`) — a system prompt with a strict JSON contract, brace-scrape + `JSON.parse`, null on parse failure.

**Hard invariant:** the model returns `title`, `summary`, and `intent` **only**. The server re-derives `actions` from the fixed per-kind allowlist above. A model must never be able to emit a `method`+`path`+`body` that the client would fire against the authenticated daemon. This is a security boundary and needs a test asserting model-supplied `actions` are discarded.

At the budget cap, return `503 {error:"budget-exceeded"}`; the row's yes/no stay functional.

## Out of scope (explicitly)

- **Email.** No email integration exists. `integrations/inbox-watcher.js` is a markdown checkbox parser for `<dataDir>/inbox/` — no Gmail, IMAP, or Superhuman anywhere. The brief draws only on wired sources: calls (BuildBetter), calendar, tasks, Linear, iMessage, screen observations. Nothing in the brief may imply inbox access.
- **Cross-host merge.** Nudges are local; "Needs you" is the Distiller (`outreachRemoteURL`). `/proactive/*` and `/tasks` do not proxy — `GET /nodes` is the only route that does (`hosted-interface.js:332-377`).
- **Backlog triage and expiry.** The 1,092 collapse behind `▾ N older`; no sweep, no retention policy, no triage UI here.
- **Panel shell rewrite.** No outer `ScrollView` exists, so content past `visibleFrame.height - 24` becomes unreachable rather than scrollable; width 320 is duplicated (`OverlayView.swift:159`, `OverlayController.swift:13`); the resize trigger is a 7-property allowlist (`:35-41`). The brief renders ≤5 rows where 10 render today, so v1 fits. Any unbounded list requires this work first.
- **Streaming.** `POST /message` is a single buffered round-trip (`hosted-interface.js:413`); `/events` carries no tokens.

## Known limitation: the brief will start thin

Measured on this machine: **0 pending user-queue tasks** (all 3 are agent-queue), **0 calendar events** (`CALENDAR_ICS_URL` is unset), 0 carried-over, 0 BuildBetter commitments pending. `GET /plan/daily` currently returns exactly 1 focus item.

So on day one the brief will be mostly suggestions — which is precisely why the guaranteed suggestion slot exists. Populating the task side (Linear sync, BuildBetter commitments, calendar) is a **separate, higher-leverage change** that this design deliberately does not bundle. The brief is built to be useful with `planCachedAt: null` and an empty task store, and to get better automatically as those sources fill.

## Constraints the implementation must respect

1. Any new height-affecting `@Published` must be added to the `.onChange` allowlist (`OverlayView.swift:35-41`), and the resize must stay deferred one runloop turn so `host.fittingSize` is read post-layout.
2. The panel must remain `.nonactivatingPanel` + `LSUIElement` + `.accessory`; never call `NSApp.activate(ignoringOtherApps:)`. `canBecomeKey` must stay overridden or no text field is typable.
3. Everything Mac-side is `@MainActor`; SSE delegates are the only `nonisolated` classes and must hop via `Task { @MainActor in … }`.
4. `AppState.swift` is 501 lines carrying six unrelated jobs. The brief goes in new files under `Overlay/Brief/`; `AppState` gains only the phase-0 fixes and loses the nudge state.
5. `AppState.get`/`post` are `private`. Either raise them to internal or give `BriefConsumer` its own helpers — do not duplicate the query-encoding bug.
6. macOS 14 deployment target, SPM only. No macOS 15+ APIs without `#available`.
7. Suggestion ids span three prefixes — `prop_` (observer), `sug_` (pattern-miner), `ses_` (session-miner). `suggestion-feed.js:29` unifies them; `proactiveObserver.resolve` reads `<dataDir>/proactive/suggestions/<id>.json` directly (`proactive-observer.js:326-335`) and so can only ever resolve `prop_`. The composer must go through the unified feed, never the observer directly.
