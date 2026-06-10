# External Knowledge Sources — Design

**Date:** 2026-06-02
**Status:** Approved (brainstorming) — pending implementation plan
**Scope:** Two independent features in one spec:
1. Web search + page-fetch tools backed by a multi-provider abstraction.
2. BuildBetter transcript ingestion (alongside the existing action-item "signals" ingestion).

These give the agent live web grounding (parity with competitors' web search) and let it
ground answers in the user's actual call transcripts, not just extracted action items.

---

## Feature 1 — Web search + page fetch

### Goal
The agent can search the live web and fetch page contents through a single, provider-agnostic
tool surface, with any of six providers wired in and pluggable by which API keys are set.

### Module & wiring
- New module: `src/integrations/web-search.js`, exporting `registerWebSearchTools(runtime)`.
- Called from `src/abi-runtime.js` alongside the other `register*` integrations (same pattern as
  `registerComputerUseTools(runtime)`). Registers tools via `runtime.tools.register(...)`.

### Provider abstraction
Each provider is a small adapter with a uniform interface:

```
{
  name: string,
  isConfigured(): boolean,          // true when its API key env var(s) are present
  async search(query, opts): NormalizedResult[],
  async fetch?(url, opts): string,  // optional; only Firecrawl implements rich fetch
}
```

`NormalizedResult` shape (provider responses are mapped into this):

```
{ title: string, url: string, snippet: string, publishedDate?: string, content?: string }
```

Shared adapter rules:
- One `fetch()` call per request (POST or GET per provider), 15s timeout (`AbortController`).
- On non-2xx or network/timeout error, throw a typed error; the tool layer catches and either
  falls back or returns a structured `{ error }`.
- Never throw raw secrets into error messages.

### The six adapters

| Provider    | Endpoint                                         | Auth header                    | Key env var(s)                        | Notes |
|-------------|--------------------------------------------------|--------------------------------|---------------------------------------|-------|
| exa         | `POST https://api.exa.ai/search`                 | `x-api-key`                    | `EXA_API_KEY`                         | body `{ query, numResults, contents: { text: true } }` |
| tavily      | `POST https://api.tavily.com/search`             | `Authorization: Bearer`        | `TAVILY_API_KEY`                      | body `{ query, max_results, search_depth, include_answer }` |
| firecrawl   | `POST https://api.firecrawl.dev/v2/search`       | `Authorization: Bearer`        | `FIRECRAWL_API_KEY`                   | also implements `fetch()` via `/v2/scrape` (markdown) |
| brave       | `GET https://api.search.brave.com/res/v1/web/search?q=` | `X-Subscription-Token`  | `BRAVE_API_KEY`                       | results under `web.results[]` |
| perplexity  | `POST https://api.perplexity.ai/chat/completions`| `Authorization: Bearer`        | `PERPLEXITY_API_KEY`                  | answer API (model `sonar`); map answer + `citations[]` into results |
| serpapi     | `GET https://serpapi.com/search.json?engine=google&q=` | query param `api_key`    | `SERPAPI_API_KEY`                     | Google SERP. Alt: Google CSE if `GOOGLE_API_KEY`+`GOOGLE_CSE_ID` set |

> Exact request/response field names are confirmed against each provider's current docs during
> implementation; the table is the contract, adapters absorb per-provider quirks.

### Tools the agent sees
Both tools are **read-only → no confirmation gate** (`needsConfirmation: false`).

1. **`web_search`**
   - Params: `{ query: string, provider?: enum(exa|tavily|firecrawl|brave|perplexity|serpapi),
     num_results?: int (default 5), recency?: enum(day|week|month|year) }`
   - Provider resolution order:
     1. explicit `provider` arg (if that adapter is configured; else error)
     2. `WEB_SEARCH_PROVIDER` env default (if configured)
     3. first configured adapter in the default priority order
   - **Default priority order:** `exa → tavily → brave → serpapi → firecrawl → perplexity`
     (configurable later; documented as the built-in default).
   - **Fallback:** if the chosen provider throws, try the next configured adapter in priority
     order. If all fail (or none configured), return `{ error }` with a clear message.
   - Returns: `{ provider, results: NormalizedResult[] }`.

2. **`fetch_url`**
   - Params: `{ url: string, format?: enum(markdown|text) (default markdown) }`
   - Uses Firecrawl `/v2/scrape` when `FIRECRAWL_API_KEY` is set (best markdown);
     otherwise a plain `fetch` + minimal HTML→text fallback, so it works with **zero keys**.
   - Returns: `{ url, format, content }` or `{ error }`.

### Config surface
New env vars, surfaced in `setup-wizard.js`, README, and `.env` example:
- `EXA_API_KEY`, `TAVILY_API_KEY`, `FIRECRAWL_API_KEY`, `BRAVE_API_KEY`,
  `PERPLEXITY_API_KEY`, `SERPAPI_API_KEY` (and optional `GOOGLE_API_KEY` + `GOOGLE_CSE_ID`)
- `WEB_SEARCH_PROVIDER` — optional default provider override.

If **no** provider key is set, `web_search` registers but returns a structured "no web search
provider configured" error when called (consistent with how other env-gated features degrade).
`fetch_url` still works keyless via the plain-fetch fallback.

---

## Feature 2 — BuildBetter transcripts vs signals

### Goal
Let the user choose whether the BuildBetter integration ingests **action-item signals**
(today's behavior), **full transcripts** (searchable context), or **both**.

### Config toggle
New env var **`BUILDBETTER_INGEST_MODE`**:
- `signals` (**default** — preserves today's exact behavior; no change unless opted in)
- `transcripts`
- `both`

Parsed in `BuildBetterTaskSource` (`src/integrations/buildbetter-tasks.js`). Unknown/empty →
`signals`.

### Behavior by mode
- **signals** → unchanged: `getRecentCalls()` → `getActionItems()` → `runtime.tasks.add(...)`.
- **transcripts** → new `syncTranscripts()`:
  1. Reuse `getRecentCalls(sinceIso)` (existing attended-call filter by email/name).
  2. For each call, fetch its transcript via a new GraphQL query.
  3. Record into the observation store as a new **`transcript`** text kind:
     `{ kind: "transcript", at: call.started_at, app: "BuildBetter",
        window: call.name, text: <transcript text>, ref: "buildbetter:call:<id>" }`
  4. **Dedup** by `ref` — skip calls already recorded (check existing texts for that ref, or
     track a synced-call set / `lastTranscriptSyncedAt`).
  5. Because transcripts live in the observation store, **`recall_activity` searches them for
     free** — no new search tool needed.
- **both** → run signals sync and transcript sync in the same pass.

### Dependencies this creates
1. **`observation-store.js` `record()` gains a `transcript` kind.** It currently handles only
   `activity` and `frame`/`frame-summary`. Add a branch that inserts into the `texts` FTS table
   with `kind = "transcript"`, `ref = <call ref>`, `at`, `app`, `window`, `text`. This is the
   single targeted change to the store; it keeps transcripts searchable via the existing
   `search()` / `recall_activity` path.
2. **Exact BuildBetter transcript GraphQL field is not yet in the codebase.** The BuildBetter MCP
   (`get-call-transcript`, etc.) confirms transcripts are available. During implementation, probe
   the live BuildBetter schema (via the connected MCP) to nail the exact query — whether it's an
   `interview.transcript` field or a separate utterances/segments table — before finalizing
   `syncTranscripts()`.

### Polling
Reuse the existing coalesced 15-min sync. `registerBuildBetterTaskSource` already adds the
`buildbetter-task-sync` cron job and the `triggerSync()` coalescing path. Extend the single sync
pass to do signals and/or transcripts based on `BUILDBETTER_INGEST_MODE` (one job, mode-gated),
rather than adding a second job.

### Registration gating
`isConfigured()` stays `apiKey && (userEmail || userName)`. The mode only selects *what* is
synced; an unconfigured BuildBetter integration still no-ops.

---

## Testing

- **Web search adapters:** unit test each adapter with a mocked `fetch` — assert request shape
  (URL, headers, body) and response→`NormalizedResult` mapping.
- **`web_search` tool:** provider resolution (explicit arg / env default / priority order),
  fallback-on-error across configured providers, and the "no provider configured" path.
- **`fetch_url`:** Firecrawl path vs keyless plain-fetch fallback (both mocked).
- **BuildBetter transcripts:** `syncTranscripts()` with a mocked `query()` and an in-memory
  observation store (same isolation approach as the pattern-miner test); assert dedup by `ref`
  and that mode gating runs the right sync(s).
- **observation-store:** `record()` accepts and stores the new `transcript` kind; `search()`
  returns it.

## Out of scope (YAGNI)
- No per-provider result re-ranking or merging across providers (single provider per call +
  fallback only).
- No transcript summarization/embedding beyond FTS (the store's existing search is enough).
- No UI beyond the existing dashboard/recall surfaces.
- No new mobile/overlay work (tracked separately).

## Build sequencing (for the plan)
1. Web search provider abstraction + `web_search`/`fetch_url` tools + tests + config surface.
2. observation-store `transcript` kind + test.
3. BuildBetter `BUILDBETTER_INGEST_MODE` + `syncTranscripts()` + tests + config surface
   (depends on step 2; probe live schema first).
