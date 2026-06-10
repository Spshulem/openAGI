# Credit Usage Audit Log — Design

**Date:** 2026-06-06
**Status:** Approved (brainstorming) — pending implementation plan
**Branch:** `feat/credit-audit-log` (off `feat/external-knowledge-sources`)

## Goal
A per-call audit log of LLM credit (USD) usage so the user can see **what** cost
credits, **when**, and **why** (which activity / agent / session / tools). Today
`BudgetGuard` only stores daily aggregates (`{input, output, cacheRead, cacheWrite,
usd, calls}` per day) — there is no per-call record. This adds the line-item ledger,
a Credits dashboard view with totals + charts, and a `recall_spend` agent tool.

## Decisions (from brainstorming)
- **What to log:** rich per-call context — time, model, tokens, `$`, plus the why
  (channel/activity, agent, session, tools called that turn).
- **Surface:** evolve the existing **Budget** dashboard tab into **Credits**, AND add a
  `recall_spend` agent tool so the user can ask cost questions in chat.
- **Depth:** full analytics — line items + grouped totals + spend-over-time charts.
- **Retention:** rolling **30 days** (capped file).

## Architecture
A focused `CreditLedger` (append-only JSONL) records one entry per priced LLM call.
`BudgetGuard` already prices each call and computes the `$`; it composes the ledger and
appends the line item with the context passed by `model-provider`. The dashboard and a
new agent tool read the ledger. No new process, no external dependency.

```
LLM call → BudgetGuard.record(usage, model, meta)
             ├─ daily aggregate (existing, unchanged)
             └─ CreditLedger.record({ at, model, tokens, usd, ...meta })
GET /budget/ledger?days=30 → { entries, analytics }   → Credits dashboard view
recall_spend tool (chat)   → ledger summary           → "why did I spend $X today?"
```

## Components

### 1. `CreditLedger` — `src/credit-ledger.js` (new)
One responsibility: durable per-call cost line items.
- Storage: JSONL at `path.join(resolveDataDir(), "budget", "ledger.jsonl")`.
- `record(entry)` — appends `{ at: ISO, model, tokens: {input, output, cacheRead,
  cacheWrite}, usd, channel, agentId, sessionId, from, tools: string[] }`. Prunes
  entries older than the retention window on write (rolling 30 days).
- `query({ days = 30 })` — returns entries within the window, newest first.
- `analytics({ days = 30 })` — returns grouped totals:
  - `byDay`: `[{ date, usd, calls }]` (for the spend-over-time chart)
  - `byModel`: `[{ model, usd, calls }]`
  - `byActivity`: `[{ activity, usd, calls }]` (activity = channel, e.g. chat /
    autopilot / cron / overlay / sms)
  - `totalUsd`, `totalCalls` for the window.
- Constructor takes `{ storePath, retentionDays = 30 }` for test injection. Degrades
  safely (missing/corrupt file → empty ledger).

### 2. `BudgetGuard.record(usage, model, meta = {})` — `src/budget-guard.js`
- Pricing + daily-aggregate logic unchanged.
- After computing `usd`, append a ledger entry:
  `this.ledger?.record({ at: nowIso(), model, tokens, usd, channel: meta.channel ?? null,
  agentId: meta.agentId ?? null, sessionId: meta.sessionId ?? null, from: meta.from ??
  null, tools: meta.tools ?? [] })`.
- `meta` is optional → existing callers/tests keep working unchanged.
- BudgetGuard constructs `this.ledger = options.ledger ?? new CreditLedger({ storePath:
  <budgetDir>/ledger.jsonl })`. `status()` gains nothing new (the ledger has its own
  query/analytics); a thin `ledger(opts)` passthrough may be added for the endpoint.

### 3. `model-provider.js` — thread the context (lines ~146 and ~253)
Both `record(json.usage, this.model)` call sites become:
```js
this.budgetGuard?.record(json.usage, this.model, {
  channel: context.channel, agentId: context.agentId,
  sessionId: context.sessionId, from: context.from,
  tools: toolCalls.map((c) => c.name)
});
```
`context` and `toolCalls` are already in scope at both sites.

### 4. Endpoint — `src/hosted-interface.js`
`GET /budget/ledger?days=30` → `sendJson(200, { entries, analytics })` from
`runtime.budget.ledger.query(...)` + `.analytics(...)`. Returns `{ error }` when no
budget/ledger is wired.

### 5. `recall_spend` agent tool — `src/tool-registry.js`
- Params: `{ days?: integer (default 1) }`.
- Handler: reads `runtime.budget.ledger.analytics({ days })` + top N costliest entries,
  returns `{ totalUsd, calls, byActivity, byModel, top: [...] }` so the agent can answer
  "what's been costing me credits and why".
- Read-only, no confirmation gate.

### 6. Dashboard: Budget tab → "Credits" — `src/hosted-interface.js`
Evolve the existing `data-tab="budget"` surface (keep today's spend vs cap header), add:
- **Grouped totals:** by activity and by model (e.g. "autopilot $4.10 · chat $1.20").
- **Spend-over-time chart:** lightweight inline **SVG bars** over `byDay` (no charting
  library) — last 30 days.
- **Audit log:** a scrollable list of line items — `time · model · activity · agent ·
  $ · tools`.
- Rename the tab label to "Credits"; keep `data-tab="budget"` (or switch to
  `data-tab="credits"` consistently — pick one and update the nav + the client tab JS).
> ⚠️ This file is template-literal-heavy. Per the repo's known trap, escape any `${...}`
> added inside `renderApp`'s template literal and avoid stray backticks, or the route
> crashes at runtime.

## Data flow & privacy
- The ledger stores: timestamp, model, token counts, `$`, channel/activity, agentId,
  sessionId, from, and tool **names** — **no message content, no secrets**. Local file
  under `~/.openagi/budget/`, pruned to 30 days.
- `analytics`/`query` never leave the machine (local dashboard + local agent tool).

## Error handling
- Missing/corrupt ledger file → treated as empty (record re-creates it). Never throws
  into the model-generate path (record is best-effort; a ledger failure must not break a
  reply — wrap the append in try/catch and swallow, mirroring the existing best-effort
  pattern around budget).
- Endpoint/tool with no budget wired → structured `{ error }`.

## Testing
- **`CreditLedger`** (real unit tests): `record` appends; `query({days})` filters the
  window; `analytics` groups by day/model/activity correctly; 30-day prune drops old
  entries; corrupt-file tolerance.
- **`BudgetGuard.record`**: with `meta`, writes a ledger entry carrying the context;
  without `meta`, still records the aggregate (back-compat).
- **`recall_spend`**: returns a correct summary from a seeded ledger.
- **Endpoint**: `GET /budget/ledger` returns `{ entries, analytics }` (via the existing
  hosted-interface test pattern, if present; else a focused runtime test).
- The dashboard JS (template-literal UI) is not unit-testable here — verified by
  reasoning + manual.

## Out of scope (YAGNI)
- Tracking non-LLM external costs (web-search/MCP provider charges aren't priced by the
  app today). The ledger records the **tool names** invoked in a turn for attribution,
  but not separate $ for them.
- Per-message content logging.
- CSV export / external billing integration.
- Configurable retention UI (30 days is fixed; constructor-overridable).

## Build sequencing (for the plan)
**Phase 1 — data + agent (no `hosted-interface.js` UI):**
1. `CreditLedger` + tests.
2. `BudgetGuard.record(meta)` composes the ledger + test.
3. `model-provider` threads context/tools into `record`.
4. `GET /budget/ledger` endpoint.
5. `recall_spend` tool + test.

**Phase 2 — Credits dashboard view (`hosted-interface.js`):**
6. Evolve the Budget tab into Credits: grouped totals + inline-SVG spend chart + audit
   log line items.
