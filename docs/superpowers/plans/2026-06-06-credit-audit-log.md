# Credit Usage Audit Log — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A per-call LLM credit (USD) audit log — what cost credits, when, and why (activity/agent/session/tools) — surfaced as a Credits dashboard view (totals + spend chart + audit log) and a `recall_spend` agent tool.

**Architecture:** A focused append-only `CreditLedger` (JSONL, 30-day window). `BudgetGuard` already prices each call; it appends a line item with the context `model-provider` passes. A new endpoint + agent tool + dashboard view read it.

**Tech Stack:** Node 22 ESM, `node:test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-06-credit-audit-log-design.md`

---

# Phase 1 — data + agent (no dashboard UI)

### Task 1: `CreditLedger`

**Files:** Create `src/credit-ledger.js`; create `test/credit-ledger.test.js`.

- [ ] **Step 1: Write the failing test**

```js
// test/credit-ledger.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CreditLedger } from "../src/credit-ledger.js";

function tmpLedger(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
  return new CreditLedger({ storePath: path.join(dir, "ledger.jsonl"), ...opts });
}
const entry = (over = {}) => ({
  model: "claude-opus-4-7", usd: 0.05, channel: "chat", agentId: "main",
  sessionId: "s1", from: "user", tools: ["web_search"],
  tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }, ...over
});

test("records and queries entries newest-first", () => {
  const L = tmpLedger();
  L.record(entry({ usd: 0.01, at: "2026-06-05T10:00:00.000Z" }));
  L.record(entry({ usd: 0.02, at: "2026-06-06T10:00:00.000Z" }));
  const rows = L.query({ days: 30, now: new Date("2026-06-06T12:00:00.000Z") });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].usd, 0.02); // newest first
  assert.equal(rows[0].channel, "chat");
});

test("query window excludes entries older than `days`", () => {
  const L = tmpLedger();
  L.record(entry({ at: "2026-05-01T10:00:00.000Z" })); // ~36 days before now
  L.record(entry({ at: "2026-06-06T10:00:00.000Z" }));
  const rows = L.query({ days: 30, now: new Date("2026-06-06T12:00:00.000Z") });
  assert.equal(rows.length, 1);
});

test("analytics groups by day, model, activity", () => {
  const L = tmpLedger();
  L.record(entry({ usd: 0.10, channel: "autopilot", model: "claude-opus-4-7", at: "2026-06-06T09:00:00.000Z" }));
  L.record(entry({ usd: 0.04, channel: "chat", model: "gpt-5", at: "2026-06-06T10:00:00.000Z" }));
  L.record(entry({ usd: 0.01, channel: "chat", model: "gpt-5", at: "2026-06-05T10:00:00.000Z" }));
  const a = L.analytics({ days: 30, now: new Date("2026-06-06T12:00:00.000Z") });
  assert.equal(a.totalCalls, 3);
  assert.equal(a.totalUsd, 0.15);
  assert.equal(a.byActivity.find((x) => x.activity === "autopilot").usd, 0.10);
  assert.equal(a.byActivity[0].activity, "autopilot"); // sorted by usd desc
  assert.equal(a.byModel.find((x) => x.model === "gpt-5").calls, 2);
  assert.deepEqual(a.byDay.map((d) => d.date), ["2026-06-05", "2026-06-06"]); // chronological
});

test("compacts when the file exceeds the byte threshold, keeping the window", () => {
  const L = tmpLedger({ compactBytes: 1 }); // force compaction every write
  L.record(entry({ at: "2026-05-01T10:00:00.000Z" })); // old
  L.record(entry({ at: "2026-06-06T10:00:00.000Z", now: new Date("2026-06-06T10:00:00.000Z") }));
  // After a compaction triggered with a recent `now`, the 36-day-old row is gone from disk.
  const onDisk = fs.readFileSync(L.storePath, "utf8").split("\n").filter(Boolean);
  assert.equal(onDisk.length, 1);
});

test("tolerates a missing/corrupt file", () => {
  const L = tmpLedger();
  assert.deepEqual(L.query(), []);
  fs.writeFileSync(L.storePath, "not json\n{bad\n");
  assert.deepEqual(L.query(), []);
});
```

- [ ] **Step 2: Run it — verify FAIL**

`node --test test/credit-ledger.test.js` → module not found.

- [ ] **Step 3: Implement `src/credit-ledger.js`**

```js
// src/credit-ledger.js
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";

const RETENTION_DAYS = 30;
const COMPACT_BYTES = 4 * 1024 * 1024; // compact when the file grows past ~4MB

// Append-only per-call credit (USD) ledger. record() is O(1) append (it runs in
// the hot path of every LLM call); old entries are filtered out of query()/
// analytics() by the rolling window, and the file is compacted only when it
// grows large. Stores no message content — just cost + attribution.
export class CreditLedger {
  constructor(options = {}) {
    this.storePath = options.storePath ?? path.join(resolveDataDir(), "budget", "ledger.jsonl");
    this.retentionDays = options.retentionDays ?? RETENTION_DAYS;
    this.compactBytes = options.compactBytes ?? COMPACT_BYTES;
    ensureDir(path.dirname(this.storePath));
  }

  _cutoff(days, now) {
    return new Date(now.getTime() - days * 86400 * 1000).toISOString();
  }

  _readAll() {
    let text;
    try { text = fs.readFileSync(this.storePath, "utf8"); } catch { return []; }
    const out = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
    }
    return out;
  }

  record(entry = {}, { now = new Date() } = {}) {
    const row = {
      at: entry.at ?? now.toISOString(),
      model: entry.model ?? null,
      tokens: entry.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      usd: Number(entry.usd ?? 0),
      channel: entry.channel ?? null,
      agentId: entry.agentId ?? null,
      sessionId: entry.sessionId ?? null,
      from: entry.from ?? null,
      tools: Array.isArray(entry.tools) ? entry.tools : []
    };
    fs.appendFileSync(this.storePath, JSON.stringify(row) + "\n");
    this._maybeCompact(now);
    return row;
  }

  _maybeCompact(now) {
    let size = 0;
    try { size = fs.statSync(this.storePath).size; } catch { return; }
    if (size < this.compactBytes) return;
    const cutoff = this._cutoff(this.retentionDays, now);
    const kept = this._readAll().filter((r) => (r.at ?? "") >= cutoff);
    fs.writeFileSync(this.storePath, kept.map((r) => JSON.stringify(r)).join("\n") + (kept.length ? "\n" : ""));
  }

  query({ days = this.retentionDays, now = new Date() } = {}) {
    const cutoff = this._cutoff(days, now);
    return this._readAll()
      .filter((r) => (r.at ?? "") >= cutoff)
      .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  }

  analytics({ days = this.retentionDays, now = new Date() } = {}) {
    const rows = this.query({ days, now });
    const byDay = {}, byModel = {}, byActivity = {};
    let totalUsd = 0, totalCalls = 0;
    for (const r of rows) {
      const day = (r.at ?? "").slice(0, 10);
      const model = r.model ?? "unknown";
      const activity = r.channel ?? "unknown";
      const usd = Number(r.usd ?? 0);
      totalUsd += usd; totalCalls += 1;
      (byDay[day] ??= { date: day, usd: 0, calls: 0 });        byDay[day].usd += usd; byDay[day].calls += 1;
      (byModel[model] ??= { model, usd: 0, calls: 0 });        byModel[model].usd += usd; byModel[model].calls += 1;
      (byActivity[activity] ??= { activity, usd: 0, calls: 0 }); byActivity[activity].usd += usd; byActivity[activity].calls += 1;
    }
    const round = (o) => ({ ...o, usd: Number(o.usd.toFixed(4)) });
    return {
      totalUsd: Number(totalUsd.toFixed(4)),
      totalCalls,
      byDay: Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date)).map(round),
      byModel: Object.values(byModel).sort((a, b) => b.usd - a.usd).map(round),
      byActivity: Object.values(byActivity).sort((a, b) => b.usd - a.usd).map(round)
    };
  }
}
```

- [ ] **Step 4: Run it — verify PASS** (`node --test test/credit-ledger.test.js`), then full suite `node --test`.
- [ ] **Step 5: Commit**

```bash
git add src/credit-ledger.js test/credit-ledger.test.js
git commit -m "feat: CreditLedger — per-call cost line items (30-day JSONL)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `BudgetGuard.record(usage, model, meta)` appends a ledger entry

**Files:** Modify `src/budget-guard.js`; create `test/budget-guard-ledger.test.js`.

- [ ] **Step 1: Write the failing test**

```js
// test/budget-guard-ledger.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BudgetGuard } from "../src/budget-guard.js";
import { CreditLedger } from "../src/credit-ledger.js";

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-"));
  const ledger = new CreditLedger({ storePath: path.join(dir, "ledger.jsonl") });
  const guard = new BudgetGuard({ storePath: path.join(dir, "usage.json"), ledger });
  return { guard, ledger };
}

test("record(meta) writes a ledger entry carrying the context", () => {
  const { guard, ledger } = tmp();
  guard.record({ input_tokens: 1000, output_tokens: 500 }, "claude-opus-4-7", {
    channel: "autopilot", agentId: "main", sessionId: "s9", from: "cron", tools: ["web_search", "add_task"]
  });
  const rows = ledger.query({ days: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, "autopilot");
  assert.deepEqual(rows[0].tools, ["web_search", "add_task"]);
  assert.equal(rows[0].model, "claude-opus-4-7");
  assert.ok(rows[0].usd > 0);
  assert.equal(rows[0].tokens.input, 1000);
});

test("record without meta still aggregates and does not throw (back-compat)", () => {
  const { guard, ledger } = tmp();
  const res = guard.record({ input_tokens: 100, output_tokens: 50 }, "gpt-5");
  assert.ok(res.added > 0);
  // a ledger row is still written, just with null context
  const rows = ledger.query({ days: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, null);
});
```

- [ ] **Step 2: Run — verify FAIL** (`node --test test/budget-guard-ledger.test.js`): `meta` ignored, no ledger.

- [ ] **Step 3: Implement**

In `src/budget-guard.js`:
- Add imports at top: `import { nowIso } from "./utils.js";` and `import { CreditLedger } from "./credit-ledger.js";`
- In the constructor, after `this.state = ...`, add:
  ```js
  this.ledger = options.ledger ?? new CreditLedger({ storePath: path.join(path.dirname(this.storePath), "ledger.jsonl") });
  ```
- Change `record(usage, model)` to `record(usage, model, meta = {})`. After the daily-aggregate block (after `day.calls += 1;` and before `this.persist();`), append the ledger entry (best-effort — never let a ledger failure break the model call):
  ```js
  try {
    this.ledger?.record({
      at: nowIso(),
      model,
      tokens,
      usd,
      channel: meta.channel ?? null,
      agentId: meta.agentId ?? null,
      sessionId: meta.sessionId ?? null,
      from: meta.from ?? null,
      tools: Array.isArray(meta.tools) ? meta.tools : []
    });
  } catch { /* ledger is best-effort; never break a reply over it */ }
  ```

- [ ] **Step 4: Run — verify PASS**, then full suite `node --test`.
- [ ] **Step 5: Commit**

```bash
git add src/budget-guard.js test/budget-guard-ledger.test.js
git commit -m "feat: BudgetGuard.record appends a credit-ledger line item

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `model-provider` threads context + tool names into `record`

**Files:** Modify `src/model-provider.js`.

- [ ] **Step 1:** Both providers call `this.budgetGuard?.record(json.usage, this.model);` (Anthropic ~line 253, OpenAI ~line 146). At each site, `context` and the local `toolCalls` array are in scope. Replace each call with:

```js
      this.budgetGuard?.record(json.usage, this.model, {
        channel: context.channel,
        agentId: context.agentId,
        sessionId: context.sessionId,
        from: context.from,
        tools: toolCalls.map((c) => c.name)
      });
```

Verify at each site that `toolCalls` is the in-scope array of `{ name, ... }` (it is — both providers build it before recording). Use grep to find both: `grep -n "budgetGuard?.record" src/model-provider.js`.

- [ ] **Step 2:** Run the full suite `node --test` → all green (no provider unit test calls the network; existing tests must still pass). Also import-smoke: `node -e "import('./src/model-provider.js').then(()=>console.log('ok'))"`.

- [ ] **Step 3: Commit**

```bash
git add src/model-provider.js
git commit -m "feat: pass activity/agent/session/tools context to budget record

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `GET /budget/ledger` endpoint

**Files:** Modify `src/hosted-interface.js` (routing section only — NOT the renderApp template).

- [ ] **Step 1:** Find the existing budget route: `grep -n 'pathname === "/budget"' src/hosted-interface.js` (around line 340). Immediately after that line, add a sibling route:

```js
      if (method === "GET" && pathname === "/budget/ledger") {
        const ledger = runtime.budget?.ledger;
        if (!ledger) return sendJson(res, 200, { error: "no-ledger" });
        const days = Math.max(1, Math.min(90, Number.parseInt(url.searchParams.get("days") ?? "30", 10) || 30));
        return sendJson(res, 200, { days, entries: ledger.query({ days }), analytics: ledger.analytics({ days }) });
      }
```

Confirm how the existing routes read query params (the file already parses a `url`/`pathname`; match the existing pattern — if it uses `new URL(req.url, base)`, reuse that `url.searchParams`; if query parsing differs, follow the local convention). Do NOT touch any template-literal/renderApp code.

- [ ] **Step 2:** Smoke-test the route wiring with a runtime:
```bash
node -e "import('./src/index.js').then(async ({createDurableRuntime, createHostedInterface})=>{const rt=createDurableRuntime({});const app=createHostedInterface(rt,{host:'127.0.0.1',port:0});const {port}=await app.listen();const r=await fetch('http://127.0.0.1:'+port+'/budget/ledger?days=7');console.log(r.status, JSON.stringify(await r.json()).slice(0,120));process.exit(0)})" 2>&1 | tail -3
```
Expected: `200` with `{days:7,entries:[...],analytics:{...}}` (entries likely empty on a fresh runtime). If auth gates the route, the smoke may 401 — that's fine, it confirms the route exists; note it.

- [ ] **Step 3:** `node --test` → still green. Commit:
```bash
git add src/hosted-interface.js
git commit -m "feat: GET /budget/ledger returns credit entries + analytics

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `recall_spend` agent tool

**Files:** Modify `src/tool-registry.js`; create `test/recall-spend.test.js`.

- [ ] **Step 1: Write the failing test**

```js
// test/recall-spend.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolRegistry, registerCoreTools } from "../src/tool-registry.js";
import { CreditLedger } from "../src/credit-ledger.js";

test("recall_spend summarizes the ledger", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-"));
  const ledger = new CreditLedger({ storePath: path.join(dir, "ledger.jsonl") });
  ledger.record({ usd: 0.10, channel: "autopilot", model: "claude-opus-4-7", tools: ["web_search"] });
  ledger.record({ usd: 0.02, channel: "chat", model: "gpt-5", tools: [] });
  const registry = new ToolRegistry();
  registerCoreTools(registry, { budget: { ledger } });
  const { result } = await registry.invoke("recall_spend", { days: 30 });
  assert.ok(result.totalUsd >= 0.12 - 1e-9);
  assert.equal(result.byActivity[0].activity, "autopilot");
  assert.ok(Array.isArray(result.top));
});
```
(If `registerCoreTools` requires a fuller runtime, pass a minimal stub with just `{ budget: { ledger } }` and whatever else it dereferences at registration time — registration only defines the tool; the handler reads `runtime.budget.ledger` at call time.)

- [ ] **Step 2: Run — verify FAIL** (unknown tool `recall_spend`).

- [ ] **Step 3: Implement** — in `src/tool-registry.js`, inside `registerCoreTools(registry, runtime)`, add:

```js
  registry.register({
    name: "recall_spend",
    description: "Summarize LLM credit (USD) usage: how much has been spent, on what activity/model, and the costliest recent calls. Use to answer questions about cost/credits/budget — e.g. 'why did I spend $4 today?'.",
    parameters: {
      type: "object",
      properties: {
        days: { type: "integer", minimum: 1, maximum: 90, description: "Look-back window in days (default 1 = today)." }
      },
      additionalProperties: false
    },
    handler: async (args) => {
      const ledger = runtime.budget?.ledger;
      if (!ledger) return { error: "no credit ledger available" };
      const days = args.days ?? 1;
      const analytics = ledger.analytics({ days });
      const top = ledger.query({ days })
        .slice()
        .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
        .slice(0, 10)
        .map((r) => ({ at: r.at, model: r.model, activity: r.channel, agentId: r.agentId, usd: Number((r.usd ?? 0).toFixed(4)), tools: r.tools ?? [] }));
      return { days, totalUsd: analytics.totalUsd, calls: analytics.totalCalls, byActivity: analytics.byActivity, byModel: analytics.byModel, top };
    }
  });
```

- [ ] **Step 4: Run — verify PASS**, then full suite `node --test`.
- [ ] **Step 5: Commit**

```bash
git add src/tool-registry.js test/recall-spend.test.js
git commit -m "feat: recall_spend tool — answer credit/cost questions from the ledger

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

# Phase 2 — Credits dashboard view

### Task 6: Evolve the Budget tab into "Credits"

**Files:** Modify `src/hosted-interface.js` (the `renderApp` template + the client-side tab JS).

> ⚠️ **Template-literal trap (repo memory):** `renderApp` is a giant Node template literal that emits the dashboard HTML+JS. Any `${...}` you add that should appear literally in the *client* JS must be written escaped (`\${...}`), and do not introduce stray backticks. Mirror exactly how the existing `renderBudget`/budget tab code is written (find it: `grep -n "budget" src/hosted-interface.js` and read the existing tab's render + fetch code before editing). Build the new view in the SAME style.

- [ ] **Step 1:** Locate the existing Budget tab rendering and its data fetch (it calls `/budget`). Read it fully to learn the established escaping + DOM-building idiom used elsewhere in `renderApp`.

- [ ] **Step 2:** Rename the nav label to **Credits** (the `<button data-tab="budget" ...>Budget</button>` at ~line 1832 → `>Credits<`; keep `data-tab="budget"` to avoid touching the tab-routing JS, OR rename to `credits` consistently in the nav + the client tab switch + the render function — pick one and be consistent).

- [ ] **Step 3:** Extend the tab's render to fetch `/budget/ledger?days=30` and render three blocks, matching the existing dashboard component styling (cards/tokens):
  1. **Header (existing):** today's spend vs cap (keep).
  2. **Grouped totals:** `analytics.byActivity` and `analytics.byModel` as small labeled rows (e.g. "autopilot — $4.10 (12 calls)").
  3. **Spend-over-time chart:** an inline **SVG** bar chart over `analytics.byDay` (last 30). No library — compute bar heights from `usd` relative to the max; render `<rect>`s in a fixed-size `<svg>`. Keep it ~120px tall.
  4. **Audit log:** a scrollable list of `entries` (newest first): `time · model · activity · agent · $X.XXXX · tools`. Cap the rendered rows (e.g. first 200) with a note if truncated.

  Escape all interpolations per the trap above. Reuse the existing fetch helper the dashboard uses for `/budget`.

- [ ] **Step 4: Verify the file still parses / route renders.** Run:
```bash
node -e "import('./src/hosted-interface.js').then(()=>console.log('module ok'))"
node -e "import('./src/index.js').then(async ({createDurableRuntime, createHostedInterface})=>{const rt=createDurableRuntime({});const app=createHostedInterface(rt,{host:'127.0.0.1',port:0});const {port}=await app.listen();const r=await fetch('http://127.0.0.1:'+port+'/');console.log('GET /', r.status);process.exit(0)})" 2>&1 | tail -2
```
Expected: `module ok` and `GET / 200` (or 401 if auth-gated — either confirms `renderApp` didn't crash at runtime, which is the trap this guards against). Run `node --test` → green.

- [ ] **Step 5: Commit**

```bash
git add src/hosted-interface.js
git commit -m "feat: Credits dashboard — totals, spend chart, and per-call audit log

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Docs

**Files:** Modify `README.md`.

- [ ] **Step 1:** Add a short "Credits / cost audit" note: the Credits tab shows today's spend vs cap, totals by activity/model, a 30-day spend chart, and a per-call audit log (what cost credits and why); ask the agent in chat via `recall_spend` ("why did I spend $X today?"); data is a local 30-day ledger at `~/.openagi/budget/ledger.jsonl` (no message content stored).

- [ ] **Step 2: Commit**
```bash
git add README.md
git commit -m "docs: credit usage audit log (Credits tab + recall_spend)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification
- [ ] `node --test` — full suite green (Tasks 1, 2, 5 add real tests).
- [ ] `node -e "import('./src/index.js').then(()=>console.log('ok'))"` — imports clean.
- [ ] `grep -rn "recall_spend" src` — tool registered; `grep -rn "ledger" src/budget-guard.js` — wired.
