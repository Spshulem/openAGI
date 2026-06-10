# Config Location + External Knowledge Sources — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make config/state persist in a stable `~/.openagi` location, then add web-search/page-fetch tools (6 providers) and BuildBetter transcript ingestion.

**Architecture:** Part A introduces one `resolveDataDir()` resolver and routes all cwd-relative `.openagi` paths through it (default `~/.openagi`, `OPENAGI_DATA_DIR` override honored). Part B adds a provider-agnostic `web_search`/`fetch_url` tool pair backed by six adapters, and extends the BuildBetter integration with a `BUILDBETTER_INGEST_MODE` toggle that ingests call transcripts into the observation store (searchable via the existing `recall_activity`).

**Tech Stack:** Node 22 (ESM), `node:test`, built-in `fetch`, better-sqlite3 (observation store), Swift (Mac app).

**Sequencing note:** Part A lands first — the new provider keys in Part B rely on stable storage. Both specs:
- `docs/superpowers/specs/2026-06-02-stable-config-location-design.md`
- `docs/superpowers/specs/2026-06-02-external-knowledge-sources-design.md`

**Spec decisions locked in:** default `~/.openagi` everywhere; unify ALL state via one resolver; NO migration (user re-runs `/setup` once); Mac `.app` also moves to `~/.openagi`.

---

# PART A — Stable config / data location

### Task A1: `resolveDataDir()` resolver

**Files:**
- Create: `src/data-dir.js`
- Test: `test/data-dir.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/data-dir.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { resolveDataDir, _resetDataDirCache } from "../src/data-dir.js";

test("defaults to ~/.openagi when OPENAGI_DATA_DIR is unset", () => {
  const prev = process.env.OPENAGI_DATA_DIR;
  delete process.env.OPENAGI_DATA_DIR;
  _resetDataDirCache();
  assert.equal(resolveDataDir(), path.join(os.homedir(), ".openagi"));
  if (prev !== undefined) process.env.OPENAGI_DATA_DIR = prev;
  _resetDataDirCache();
});

test("honors OPENAGI_DATA_DIR as an absolute path", () => {
  const prev = process.env.OPENAGI_DATA_DIR;
  process.env.OPENAGI_DATA_DIR = "/tmp/openagi-test";
  _resetDataDirCache();
  assert.equal(resolveDataDir(), "/tmp/openagi-test");
  if (prev !== undefined) process.env.OPENAGI_DATA_DIR = prev; else delete process.env.OPENAGI_DATA_DIR;
  _resetDataDirCache();
});

test("resolves a relative OPENAGI_DATA_DIR to absolute", () => {
  const prev = process.env.OPENAGI_DATA_DIR;
  process.env.OPENAGI_DATA_DIR = "rel-data";
  _resetDataDirCache();
  assert.equal(resolveDataDir(), path.resolve("rel-data"));
  if (prev !== undefined) process.env.OPENAGI_DATA_DIR = prev; else delete process.env.OPENAGI_DATA_DIR;
  _resetDataDirCache();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/data-dir.test.js`
Expected: FAIL — `Cannot find module '../src/data-dir.js'`.

- [ ] **Step 3: Write the implementation**

```js
// src/data-dir.js
import os from "node:os";
import path from "node:path";

let cached = null;

// Single source of truth for where OpenAGI keeps config + state.
// Default is an ABSOLUTE ~/.openagi so it never depends on the process's
// current working directory (which differs between `npm run serve`, the
// .app, launchd, and re-clones — the cause of "my keys got wiped").
// OPENAGI_DATA_DIR overrides it (Docker sets /data; the Mac app sets ~/.openagi).
export function resolveDataDir() {
  if (cached) return cached;
  const override = process.env.OPENAGI_DATA_DIR;
  cached = override ? path.resolve(override) : path.join(os.homedir(), ".openagi");
  return cached;
}

// Test seam: drop the memoized value after mutating env in tests.
export function _resetDataDirCache() {
  cached = null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/data-dir.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data-dir.js test/data-dir.test.js
git commit -m "feat: resolveDataDir() — single ~/.openagi data-dir resolver"
```

---

### Task A2: Repoint the env file path + boot loader

**Files:**
- Modify: `src/setup-wizard.js:43-45` (`envFilePath`)
- Modify: `examples/hosted-server.js:5-10` (boot env loading)
- Test: `test/env-persistence.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/env-persistence.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { _resetDataDirCache } from "../src/data-dir.js";
import { envFilePath, saveEnv } from "../src/setup-wizard.js";

test("saveEnv writes under OPENAGI_DATA_DIR and survives a reload", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-env-"));
  const prev = process.env.OPENAGI_DATA_DIR;
  process.env.OPENAGI_DATA_DIR = tmp;
  _resetDataDirCache();

  assert.equal(envFilePath(), path.join(tmp, ".env"));
  saveEnv({ values: { ANTHROPIC_API_KEY: "sk-test-123" } });

  const onDisk = fs.readFileSync(path.join(tmp, ".env"), "utf8");
  assert.match(onDisk, /ANTHROPIC_API_KEY=sk-test-123/);

  if (prev !== undefined) process.env.OPENAGI_DATA_DIR = prev; else delete process.env.OPENAGI_DATA_DIR;
  _resetDataDirCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/env-persistence.test.js`
Expected: FAIL — `envFilePath()` returns `.openagi/.env` (relative), not `<tmp>/.env`.

- [ ] **Step 3: Repoint `envFilePath`**

In `src/setup-wizard.js`, add the import near the top (after the existing imports):

```js
import { resolveDataDir } from "./data-dir.js";
```

Replace lines 43-45:

```js
export function envFilePath(dataDir) {
  return path.join(dataDir ?? resolveDataDir(), ".env");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/env-persistence.test.js`
Expected: PASS.

- [ ] **Step 5: Fix the boot loader**

In `examples/hosted-server.js`, add the resolver import alongside the existing imports (the file already imports `loadEnvFile` and `path` — do NOT add a second `import path`):
```js
import { resolveDataDir } from "../src/data-dir.js";
```
Then replace the data-dir line + the three `loadEnvFile` calls (lines ~5-10):
```js
const dataDir = resolveDataDir();
loadEnvFile(path.join(dataDir, ".env")); // canonical (loadEnvFile is first-wins)
loadEnvFile(".env");                       // optional local-dev override in cwd
```

(Drop the old `loadEnvFile(".openagi/.env")` line — that relative path is exactly the bug. If `path` is NOT already imported in this file, add `import path from "node:path";` once.)

- [ ] **Step 6: Smoke-test the round-trip manually**

Run:
```bash
OPENAGI_DATA_DIR=/tmp/openagi-smoke node -e "import('./src/setup-wizard.js').then(m=>{m.saveEnv({values:{OPENAI_API_KEY:'sk-smoke'}});console.log('wrote', m.envFilePath())})"
cat /tmp/openagi-smoke/.env
```
Expected: prints `wrote /tmp/openagi-smoke/.env` and the file contains `OPENAI_API_KEY=sk-smoke`.

- [ ] **Step 7: Commit**

```bash
git add src/setup-wizard.js examples/hosted-server.js test/env-persistence.test.js
git commit -m "fix: env file + boot loader use resolveDataDir (stable ~/.openagi)"
```

---

### Task A3: Sweep remaining cwd-relative `.openagi` call sites

**Files (modify — each currently uses `path.join(process.cwd(), ".openagi", …)` or `?? ".openagi"`):**
- `src/observation-store.js:34`
- `src/scrutiny-fitter.js:26`
- `src/file-backed-propagation-controller.js:9`
- `src/outcome-store.js:13`
- `src/tunnel-watcher.js:24`
- `src/session-miner.js:51`
- `src/suggestion-feed.js:163`
- `src/proactive-observer.js:60`
- `src/mcp-oauth.js:30`
- `src/pending-actions.js:18`
- `src/agent-store.js:78`
- `src/clarification-store.js:28`
- `src/channels.js:9,97,203`
- `src/file-backed-cron-scheduler.js:9`
- `src/hosted-interface.js:189,564,647,1215`
- `src/abi-runtime.js:893` (and any sibling `.openagi` defaults)

> Find the full list (do not trust this list to be exhaustive — the codebase may have shifted):
> ```bash
> grep -rn 'process.cwd(), "\.openagi"\|?? "\.openagi"' --include="*.js" src
> ```

- [ ] **Step 1: Enumerate every site**

Run the grep above. Expected: ~35 matches. Keep the output open as your checklist.

- [ ] **Step 2: Apply the transformation, file by file**

For each match, add (once per file, near the top imports):
```js
import { resolveDataDir } from "./data-dir.js";
```
Then rewrite the path fallback. Transformation rule:

- `path.join(process.cwd(), ".openagi", "observations")` → `path.join(resolveDataDir(), "observations")`
- `options.dir ?? path.join(process.cwd(), ".openagi", "X")` → `options.dir ?? path.join(resolveDataDir(), "X")`
- `options.dataDir ?? process.env.OPENAGI_DATA_DIR ?? ".openagi"` → `options.dataDir ?? resolveDataDir()`
- `process.env.OPENAGI_DATA_DIR ?? ".openagi"` → `resolveDataDir()`

Concrete example — `src/observation-store.js:34`:
```js
// before
this.dir = options.dir ?? path.join(process.cwd(), ".openagi", "observations");
// after
this.dir = options.dir ?? path.join(resolveDataDir(), "observations");
```

Concrete example — `src/proactive-observer.js:60`:
```js
// before
this.dataDir = options.dataDir ?? process.env.OPENAGI_DATA_DIR ?? ".openagi";
// after
this.dataDir = options.dataDir ?? resolveDataDir();
```

> Note on `hosted-interface.js`: this file is a Node template-literal-heavy module. Only touch the JS path expressions (lines 189/564/647/1215); do NOT edit text inside the embedded HTML template strings. Per repo memory, unescaped backticks / `${...}` inside that file's template comments crash at runtime — keep edits to plain code lines.

- [ ] **Step 3: Verify nothing relative remains**

Run:
```bash
grep -rn 'process.cwd(), "\.openagi"\|?? "\.openagi"\|"\.openagi/\.env"' --include="*.js" src examples
```
Expected: no matches (empty output).

- [ ] **Step 4: Run the whole suite**

Run: `node --test`
Expected: all tests pass. If a test hard-coded `.openagi/...` relative paths, update it to set `OPENAGI_DATA_DIR` to a temp dir + `_resetDataDirCache()` (pattern from Task A2).

- [ ] **Step 5: Smoke-test the daemon boots and serves**

Run (foreground, then Ctrl-C):
```bash
OPENAGI_DATA_DIR=/tmp/openagi-smoke node examples/hosted-server.js &
sleep 2 && curl -s 127.0.0.1:43210/health && kill %1
```
Expected: `/health` responds OK; state directories created under `/tmp/openagi-smoke/` (not `./.openagi`).

- [ ] **Step 6: Commit**

```bash
git add -A src examples test
git commit -m "refactor: route all state dirs through resolveDataDir()"
```

---

### Task A4: Mac app uses `~/.openagi`

**Files:**
- Modify: `mac/Sources/OpenAGI/AppState.swift:98-104` (`dataDir()`)

- [ ] **Step 1: Change `dataDir()`**

Replace the body of `nonisolated static func dataDir() -> URL`:

```swift
nonisolated static func dataDir() -> URL {
  let home = FileManager.default.homeDirectoryForCurrentUser
  let dir = home.appendingPathComponent(".openagi", isDirectory: true)
  try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  return dir
}
```

`DaemonController` already sets `env["OPENAGI_DATA_DIR"] = dataDir.path` and `proc.currentDirectoryURL = dataDir` (DaemonController.swift:61-64), so the JS resolver agrees with the app.

- [ ] **Step 2: Build the Mac app**

Run: `cd mac && swift build`
Expected: build succeeds. (If the host has no Swift toolchain, note that and defer the build to a macOS dev machine; the change is a 6-line edit.)

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/OpenAGI/AppState.swift
git commit -m "feat(mac): app data dir -> ~/.openagi (unify with CLI daemon)"
```

> Reminder: no migration by design. Existing `.app` users re-run `/setup` once after this ships; their old `~/Library/Application Support/OpenAGI` data is left in place, not deleted.

---

### Task A5: Docs, install scripts, and `/setup` path display

**Files:**
- Modify: `README.md` (replace `.openagi/.env` references with `~/.openagi/.env`)
- Modify: `scripts/install-launchd.sh`, `scripts/install-systemd.sh` (set `OPENAGI_DATA_DIR=$HOME/.openagi` in the generated unit)
- Modify: `src/setup-wizard.js` (show the resolved path)

- [ ] **Step 1: Update README references**

Run to find them:
```bash
grep -rn '\.openagi/\.env\|\.openagi directory' README.md docs
```
Replace user-facing `.openagi/.env` with `~/.openagi/.env` and note that `OPENAGI_DATA_DIR` overrides it.

- [ ] **Step 2: Pin the data dir in install scripts**

In `scripts/install-launchd.sh` and `scripts/install-systemd.sh`, where the unit/plist environment is written, add `OPENAGI_DATA_DIR` set to `$HOME/.openagi` (launchd: an `EnvironmentVariables` dict entry; systemd: an `Environment=OPENAGI_DATA_DIR=%h/.openagi` line). This makes the location explicit and immune to WorkingDirectory.

- [ ] **Step 3: Show the resolved path in `/setup`**

In `src/setup-wizard.js`, the wizard copy currently interpolates `envFilePath()` (lines ~187 and ~347). Those now resolve to the absolute `~/.openagi/.env` automatically via Task A2 — verify the rendered text reads sensibly (absolute path). No code change needed beyond confirming; if a hardcoded `.openagi/.env` string exists in the copy, replace it with `${escapeHtml(envFilePath())}`.

> Per repo memory: do NOT introduce backticks inside the wizard's embedded `<script>` template, and escape any `${...}` you add inside `renderWizard`/`renderApp` template literals.

- [ ] **Step 4: Commit**

```bash
git add README.md docs scripts/install-launchd.sh scripts/install-systemd.sh src/setup-wizard.js
git commit -m "docs: ~/.openagi as the documented, explicit data location"
```

---

# PART B — External knowledge sources

### Task B1: Observation store gains a `transcript` kind

**Files:**
- Modify: `src/observation-store.js:88-128` (`record`)
- Test: `test/observation-transcript.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/observation-transcript.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ObservationStore } from "../src/observation-store.js";

test("records and searches a transcript observation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-tx-"));
  const store = new ObservationStore({ dir });
  await store.record({
    kind: "transcript",
    at: "2026-06-01T10:00:00.000Z",
    app: "BuildBetter",
    window: "Acme <> Us — Discovery",
    text: "We agreed to send the security questionnaire by Friday.",
    ref: "buildbetter:call:42"
  });
  const results = await store.search({ query: "security questionnaire", limit: 5 });
  assert.equal(results.length, 1);
  assert.match(results[0].text ?? results[0].snippet ?? "", /security questionnaire/);

  // Durable dedup lookup used by the BuildBetter transcript sync.
  assert.equal(await store.existsRef("buildbetter:call:42"), true);
  assert.equal(await store.existsRef("buildbetter:call:999"), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/observation-transcript.test.js`
Expected: FAIL — `record` ignores unknown kinds, so `search` returns 0 rows.

- [ ] **Step 3: Add the `transcript` branch to `record`**

In `src/observation-store.js`, inside the `for (const o of observations)` loop in `record` (after the `frame`/`frame-summary` branch, before `count += 1`), add:

```js
} else if (o.kind === "transcript") {
  // Long-form text (e.g. a BuildBetter call transcript) recorded so it's
  // searchable via the same FTS path as OCR/activity (and thus recall_activity).
  const ref = o.ref ? String(o.ref) : createId("txt");
  if (o.text) insertText.run("transcript", ref, o.at ?? nowIso(), o.app ?? "", o.window ?? "", o.text);
}
```

Note the existing chain uses `if (o.kind === "activity") { … } else if (o.kind === "frame" …) { … }` — append this as a new `else if`. The `insertText` prepared statement is already defined above in `record`.

Also extend the **fallback** (jsonl) path so transcripts are searchable there too. In `record`, the fallback branch writes raw JSON lines, and `search`'s fallback filters on `o.ocrText`/`o.window`. Update the fallback `search` filter (around line 139) to also match transcript text:
```js
out = out.filter((o) => (o.ocrText || "").toLowerCase().includes(q) || (o.window || "").toLowerCase().includes(q) || (o.text || "").toLowerCase().includes(q));
```

Then add an `existsRef(ref)` method (durable dedup for the transcript sync — survives restarts because it queries persisted rows). Add it after `search`:
```js
async existsRef(ref) {
  await this.ready;
  if (!ref) return false;
  if (this.fallback) {
    try {
      const rows = fs.readFileSync(this.fallbackPath, "utf8").split("\n").filter(Boolean).map(JSON.parse);
      return rows.some((o) => o.ref === ref);
    } catch { return false; }
  }
  const row = this.db.prepare(`SELECT 1 FROM texts WHERE ref = ? LIMIT 1`).get(ref);
  return Boolean(row);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/observation-transcript.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/observation-store.js test/observation-transcript.test.js
git commit -m "feat: observation store supports transcript text kind"
```

---

### Task B2: Web-search provider adapters

**Files:**
- Create: `src/integrations/web-search-providers.js`
- Test: `test/web-search-providers.test.js`

Each adapter: `{ name, isConfigured(), async search(query, opts) }` (Firecrawl also `async fetch(url, opts)`). All return `NormalizedResult[]` = `{ title, url, snippet, publishedDate?, content? }`. 15s timeout via `AbortController`.

- [ ] **Step 1: Write the failing test (Exa + Tavily mapping, fetch mocked)**

```js
// test/web-search-providers.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS } from "../src/integrations/web-search-providers.js";

function withMockFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = real; });
}
const jsonResponse = (obj) => ({ ok: true, status: 200, json: async () => obj });

test("exa adapter maps results", async () => {
  const exa = PROVIDERS.find((p) => p.name === "exa");
  await withMockFetch(async (url, init) => {
    assert.equal(url, "https://api.exa.ai/search");
    assert.equal(JSON.parse(init.body).query, "claude api");
    return jsonResponse({ results: [{ title: "Docs", url: "https://x", text: "body", publishedDate: "2026-01-01" }] });
  }, async () => {
    const out = await exa.search("claude api", { numResults: 3, apiKey: "k" });
    assert.equal(out[0].title, "Docs");
    assert.equal(out[0].url, "https://x");
    assert.equal(out[0].content, "body");
  });
});

test("tavily adapter maps results", async () => {
  const tav = PROVIDERS.find((p) => p.name === "tavily");
  await withMockFetch(async (url) => {
    assert.equal(url, "https://api.tavily.com/search");
    return jsonResponse({ results: [{ title: "T", url: "https://t", content: "snip" }] });
  }, async () => {
    const out = await tav.search("q", { apiKey: "k" });
    assert.equal(out[0].snippet, "snip");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/web-search-providers.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the adapters**

```js
// src/integrations/web-search-providers.js
// Provider adapters for web_search/fetch_url. Each adapter is independent and
// env-gated. Responses are mapped to a NormalizedResult:
//   { title, url, snippet, publishedDate?, content? }

const TIMEOUT_MS = 15_000;

async function postJson(url, { headers = {}, body, apiKey } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, { headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const str = (v) => (typeof v === "string" ? v : "");

export const exa = {
  name: "exa",
  isConfigured: () => Boolean(process.env.EXA_API_KEY),
  async search(query, opts = {}) {
    const apiKey = opts.apiKey ?? process.env.EXA_API_KEY;
    const data = await postJson("https://api.exa.ai/search", {
      headers: { "x-api-key": apiKey },
      body: { query, numResults: opts.numResults ?? 5, contents: { text: true } }
    });
    return (data.results ?? []).map((r) => ({
      title: str(r.title), url: str(r.url), snippet: str(r.text).slice(0, 400),
      publishedDate: r.publishedDate ?? undefined, content: r.text ?? undefined
    }));
  }
};

export const tavily = {
  name: "tavily",
  isConfigured: () => Boolean(process.env.TAVILY_API_KEY),
  async search(query, opts = {}) {
    const apiKey = opts.apiKey ?? process.env.TAVILY_API_KEY;
    const data = await postJson("https://api.tavily.com/search", {
      headers: { authorization: `Bearer ${apiKey}` },
      body: { query, max_results: opts.numResults ?? 5, search_depth: "basic", include_answer: false }
    });
    return (data.results ?? []).map((r) => ({
      title: str(r.title), url: str(r.url), snippet: str(r.content).slice(0, 400),
      publishedDate: r.published_date ?? undefined, content: r.raw_content ?? undefined
    }));
  }
};

export const firecrawl = {
  name: "firecrawl",
  isConfigured: () => Boolean(process.env.FIRECRAWL_API_KEY),
  async search(query, opts = {}) {
    const apiKey = opts.apiKey ?? process.env.FIRECRAWL_API_KEY;
    const data = await postJson("https://api.firecrawl.dev/v2/search", {
      headers: { authorization: `Bearer ${apiKey}` },
      body: { query, limit: opts.numResults ?? 5 }
    });
    // v2 returns { data: { web: [...] } } or { data: [...] } depending on sources.
    const rows = Array.isArray(data.data) ? data.data : (data.data?.web ?? []);
    return rows.map((r) => ({
      title: str(r.title), url: str(r.url),
      snippet: str(r.description || r.snippet).slice(0, 400),
      content: r.markdown ?? undefined
    }));
  },
  async fetch(url, opts = {}) {
    const apiKey = opts.apiKey ?? process.env.FIRECRAWL_API_KEY;
    const data = await postJson("https://api.firecrawl.dev/v2/scrape", {
      headers: { authorization: `Bearer ${apiKey}` },
      body: { url, formats: ["markdown"] }
    });
    return str(data.data?.markdown);
  }
};

export const brave = {
  name: "brave",
  isConfigured: () => Boolean(process.env.BRAVE_API_KEY),
  async search(query, opts = {}) {
    const apiKey = opts.apiKey ?? process.env.BRAVE_API_KEY;
    const count = opts.numResults ?? 5;
    const data = await getJson(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
      { headers: { accept: "application/json", "x-subscription-token": apiKey } }
    );
    return (data.web?.results ?? []).map((r) => ({
      title: str(r.title), url: str(r.url), snippet: str(r.description).slice(0, 400),
      publishedDate: r.age ?? undefined
    }));
  }
};

export const perplexity = {
  name: "perplexity",
  isConfigured: () => Boolean(process.env.PERPLEXITY_API_KEY),
  async search(query, opts = {}) {
    const apiKey = opts.apiKey ?? process.env.PERPLEXITY_API_KEY;
    const data = await postJson("https://api.perplexity.ai/chat/completions", {
      headers: { authorization: `Bearer ${apiKey}` },
      body: { model: "sonar", messages: [{ role: "user", content: query }] }
    });
    const answer = str(data.choices?.[0]?.message?.content);
    const citations = Array.isArray(data.citations) ? data.citations : [];
    const out = [];
    if (answer) out.push({ title: "Perplexity answer", url: citations[0] ?? "", snippet: answer.slice(0, 400), content: answer });
    for (const c of citations) out.push({ title: c, url: c, snippet: "" });
    return out.slice(0, (opts.numResults ?? 5) + 1);
  }
};

export const serpapi = {
  name: "serpapi",
  isConfigured: () => Boolean(process.env.SERPAPI_API_KEY) || Boolean(process.env.GOOGLE_API_KEY && process.env.GOOGLE_CSE_ID),
  async search(query, opts = {}) {
    const num = opts.numResults ?? 5;
    if (process.env.SERPAPI_API_KEY || opts.apiKey) {
      const key = opts.apiKey ?? process.env.SERPAPI_API_KEY;
      const data = await getJson(
        `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&num=${num}&api_key=${encodeURIComponent(key)}`
      );
      return (data.organic_results ?? []).map((r) => ({
        title: str(r.title), url: str(r.link), snippet: str(r.snippet).slice(0, 400),
        publishedDate: r.date ?? undefined
      }));
    }
    // Google Programmable Search fallback.
    const data = await getJson(
      `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(process.env.GOOGLE_API_KEY)}&cx=${encodeURIComponent(process.env.GOOGLE_CSE_ID)}&q=${encodeURIComponent(query)}&num=${num}`
    );
    return (data.items ?? []).map((r) => ({
      title: str(r.title), url: str(r.link), snippet: str(r.snippet).slice(0, 400)
    }));
  }
};

// Default priority order (spec): exa -> tavily -> brave -> serpapi -> firecrawl -> perplexity.
export const PROVIDERS = [exa, tavily, brave, serpapi, firecrawl, perplexity];
export const PROVIDER_BY_NAME = Object.fromEntries(PROVIDERS.map((p) => [p.name, p]));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/web-search-providers.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/integrations/web-search-providers.js test/web-search-providers.test.js
git commit -m "feat: six web-search provider adapters with normalized results"
```

---

### Task B3: `web_search` + `fetch_url` tools + wiring

**Files:**
- Create: `src/integrations/web-search.js`
- Modify: `src/abi-runtime.js` (register inside the `options.integrations !== false` block, ~line 363)
- Test: `test/web-search-tools.test.js`

- [ ] **Step 1: Write the failing test (provider resolution + fallback)**

```js
// test/web-search-tools.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../src/tool-registry.js";
import { registerWebSearchTools } from "../src/integrations/web-search.js";

function fakeProvider(name, behavior) {
  return { name, isConfigured: () => true, search: behavior };
}

test("web_search uses explicit provider and normalizes", async () => {
  const tools = new ToolRegistry();
  registerWebSearchTools({ tools }, {
    providers: [fakeProvider("exa", async () => [{ title: "A", url: "u", snippet: "s" }])]
  });
  const { result } = await tools.invoke("web_search", { query: "hi", provider: "exa" });
  assert.equal(result.provider, "exa");
  assert.equal(result.results[0].title, "A");
});

test("web_search falls back to the next configured provider on error", async () => {
  const tools = new ToolRegistry();
  registerWebSearchTools({ tools }, {
    providers: [
      fakeProvider("exa", async () => { throw new Error("boom"); }),
      fakeProvider("tavily", async () => [{ title: "B", url: "u", snippet: "s" }])
    ]
  });
  const { result } = await tools.invoke("web_search", { query: "hi" });
  assert.equal(result.provider, "tavily");
  assert.equal(result.results[0].title, "B");
});

test("web_search returns a clear error when nothing is configured", async () => {
  const tools = new ToolRegistry();
  registerWebSearchTools({ tools }, {
    providers: [{ name: "exa", isConfigured: () => false, search: async () => [] }]
  });
  const { result } = await tools.invoke("web_search", { query: "hi" });
  assert.match(result.error, /no web search provider/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/web-search-tools.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tools**

```js
// src/integrations/web-search.js
import { PROVIDERS, PROVIDER_BY_NAME, firecrawl } from "./web-search-providers.js";

const PROVIDER_NAMES = PROVIDERS.map((p) => p.name);

// opts.providers is a test seam; production uses the real PROVIDERS list.
export function registerWebSearchTools(runtime, opts = {}) {
  const providers = opts.providers ?? PROVIDERS;
  const byName = opts.providers
    ? Object.fromEntries(opts.providers.map((p) => [p.name, p]))
    : PROVIDER_BY_NAME;

  runtime.tools.register({
    name: "web_search",
    description: "Search the live web. Returns a list of results (title, url, snippet, and often page content). Picks a configured provider automatically; pass `provider` to force one.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        provider: { type: "string", enum: PROVIDER_NAMES, description: "Force a specific provider. Omit to auto-select." },
        num_results: { type: "integer", minimum: 1, maximum: 20, description: "Max results (default 5)." },
        recency: { type: "string", enum: ["day", "week", "month", "year"], description: "Optional recency hint." }
      },
      required: ["query"],
      additionalProperties: false
    },
    handler: async (args) => {
      const numResults = args.num_results ?? 5;
      // Resolution order: explicit arg -> WEB_SEARCH_PROVIDER -> priority list.
      let order = [];
      if (args.provider) {
        const p = byName[args.provider];
        if (!p) return { error: `Unknown provider: ${args.provider}` };
        if (!p.isConfigured()) return { error: `Provider ${args.provider} is not configured (missing API key).` };
        order = [p];
      } else {
        const envDefault = process.env.WEB_SEARCH_PROVIDER && byName[process.env.WEB_SEARCH_PROVIDER];
        const configured = providers.filter((p) => p.isConfigured());
        order = envDefault && envDefault.isConfigured() ? [envDefault, ...configured.filter((p) => p !== envDefault)] : configured;
      }
      if (order.length === 0) return { error: "No web search provider configured. Set EXA_API_KEY, TAVILY_API_KEY, BRAVE_API_KEY, SERPAPI_API_KEY, FIRECRAWL_API_KEY, or PERPLEXITY_API_KEY in ~/.openagi/.env." };

      const errors = [];
      for (const p of order) {
        try {
          const results = await p.search(args.query, { numResults, recency: args.recency });
          return { provider: p.name, count: results.length, results };
        } catch (err) {
          errors.push(`${p.name}: ${err.message}`);
        }
      }
      return { error: `All providers failed. ${errors.join("; ")}` };
    }
  });

  runtime.tools.register({
    name: "fetch_url",
    description: "Fetch the contents of a web page as markdown/text. Uses Firecrawl when configured, otherwise a plain fetch.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch." },
        format: { type: "string", enum: ["markdown", "text"], description: "Output format (default markdown)." }
      },
      required: ["url"],
      additionalProperties: false
    },
    handler: async (args) => {
      const format = args.format ?? "markdown";
      if (firecrawl.isConfigured()) {
        try {
          const content = await firecrawl.fetch(args.url);
          if (content) return { url: args.url, format: "markdown", content };
        } catch (err) {
          // fall through to plain fetch
        }
      }
      try {
        const res = await fetch(args.url, { headers: { "user-agent": "OpenAGI/1.0" } });
        if (!res.ok) return { error: `${args.url} -> ${res.status}` };
        const html = await res.text();
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        return { url: args.url, format: "text", content: text.slice(0, 20_000) };
      } catch (err) {
        return { error: `fetch_url failed: ${err.message}` };
      }
    }
  });

  return { registered: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/web-search-tools.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into the runtime**

In `src/abi-runtime.js`, add the import near the other integration imports (~line 16):
```js
import { registerWebSearchTools } from "./integrations/web-search.js";
```
Inside the `if (options.integrations !== false) {` block (the block that calls `registerRizeIntegration(this)` etc., ~line 363), add:
```js
// Web search tools (web_search / fetch_url). Always registered; web_search
// returns a clear "no provider configured" error until a key is set.
registerWebSearchTools(this);
```

- [ ] **Step 6: Run the full suite**

Run: `node --test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/integrations/web-search.js src/abi-runtime.js test/web-search-tools.test.js
git commit -m "feat: web_search + fetch_url tools with provider override and fallback"
```

---

### Task B4: BuildBetter transcript ingestion + mode toggle

**Files:**
- Modify: `src/integrations/buildbetter-tasks.js`
- Test: `test/buildbetter-transcripts.test.js`

- [ ] **Step 1: Probe the live transcript schema (investigation step)**

Use the connected BuildBetter MCP to confirm how a transcript is returned, so the GraphQL is correct rather than guessed:
```
Call MCP tool: mcp__claude_ai_BuildBetter__get-call-transcript  (or list-types / find-fields)
for one recent interview id.
```
Record: the exact field path that yields transcript text (e.g. `interview.transcript`, or a `transcript`/`utterance` relation with `speaker` + `text` rows). Use that in Step 3's query. Expected outcome: you can name the field that returns the spoken text.

- [ ] **Step 2: Write the failing test (mode gating + dedup, query mocked)**

```js
// test/buildbetter-transcripts.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { BuildBetterTaskSource } from "../src/integrations/buildbetter-tasks.js";

function fakeObservations() {
  const rows = [];
  return {
    record: async (o) => { rows.push(o); return { count: 1 }; },
    search: async () => rows,
    existsRef: async (ref) => rows.some((o) => o.ref === ref),
    _rows: rows
  };
}

test("syncTranscripts records one transcript per call and dedupes", async () => {
  const observations = fakeObservations();
  const src = new BuildBetterTaskSource({
    apiKey: "k", userEmail: "me@x.com",
    runtime: { observations }
  });
  // Stub the two network calls.
  src.getRecentCalls = async () => [{ id: 7, name: "Acme Discovery", started_at: "2026-06-01T10:00:00Z" }];
  src.getTranscript = async (callId) => `Transcript for ${callId}: ship it by Friday.`;

  const first = await src.syncTranscripts({ now: new Date("2026-06-02T00:00:00Z") });
  assert.equal(first.created, 1);
  assert.equal(observations._rows[0].kind, "transcript");
  assert.equal(observations._rows[0].ref, "buildbetter:call:7");

  // Second run: same call already recorded -> no new row.
  const second = await src.syncTranscripts({ now: new Date("2026-06-02T00:05:00Z") });
  assert.equal(second.created, 0);
});

test("ingestMode defaults to signals", () => {
  const prev = process.env.BUILDBETTER_INGEST_MODE;
  delete process.env.BUILDBETTER_INGEST_MODE;
  const src = new BuildBetterTaskSource({ apiKey: "k", userEmail: "me@x.com" });
  assert.equal(src.ingestMode, "signals");
  if (prev !== undefined) process.env.BUILDBETTER_INGEST_MODE = prev;
});
```

- [ ] **Step 3: Implement transcript sync + mode**

In `src/integrations/buildbetter-tasks.js`:

(a) In the constructor, add:
```js
const mode = (options.ingestMode ?? process.env.BUILDBETTER_INGEST_MODE ?? "signals").toLowerCase();
this.ingestMode = ["signals", "transcripts", "both"].includes(mode) ? mode : "signals";
```

(b) Add a `getTranscript` method (use the field confirmed in Step 1; the shape below assembles speaker-tagged lines — adapt to the real relation name):
```js
async getTranscript(callId) {
  const query = `
    query Transcript($id: bigint!) {
      interview_by_pk(id: $id) {
        id
        transcript { speaker text start_ts }
      }
    }
  `;
  const data = await this.query(query, { id: Number(callId) });
  const rows = data?.interview_by_pk?.transcript ?? [];
  if (!rows.length) return "";
  return rows.map((u) => `${u.speaker ? u.speaker + ": " : ""}${u.text ?? ""}`.trim()).filter(Boolean).join("\n");
}
```

(c) Add `syncTranscripts`:
```js
async syncTranscripts({ now = new Date() } = {}) {
  if (!this.apiKey) return { skipped: true, reason: "BUILDBETTER_API_KEY not set" };
  if (!this.runtime?.observations?.record) return { skipped: true, reason: "no observation store" };

  const sinceIso = new Date(now.getTime() - LOOKBACK_DAYS * 86400 * 1000).toISOString();
  let calls;
  try {
    calls = await this.getRecentCalls(sinceIso);
  } catch (err) {
    return { skipped: true, reason: `recent calls: ${err.message}` };
  }

  let created = 0;
  for (const call of calls) {
    const ref = `buildbetter:call:${call.id}`;
    // Durable dedup: already-recorded transcripts are skipped even across
    // daemon restarts (existsRef queries persisted rows, not in-memory state).
    if (await this.runtime.observations.existsRef(ref)) continue;
    let text;
    try {
      text = await this.getTranscript(call.id);
    } catch (err) {
      continue; // skip this call; try again next sweep
    }
    if (!text) continue;
    await this.runtime.observations.record({
      kind: "transcript",
      at: call.started_at ?? now.toISOString(),
      app: "BuildBetter",
      window: call.name ?? "Call",
      text,
      ref
    });
    created += 1;
  }
  return { scanned: calls.length, created };
}
```

(d) Make the single cron entry mode-aware. Rename the existing `sync` body to `syncSignals` and add a dispatcher `sync` that runs the right pass(es):
```js
async sync({ now = new Date() } = {}) {
  const out = {};
  if (this.ingestMode === "signals" || this.ingestMode === "both") {
    out.signals = await this.syncSignals({ now });
  }
  if (this.ingestMode === "transcripts" || this.ingestMode === "both") {
    out.transcripts = await this.syncTranscripts({ now });
  }
  return out;
}
```
> Rename the current `async sync({ now } = {})` (lines ~117-179) to `async syncSignals(...)` verbatim — its body is unchanged. The new `sync` above replaces the cron entry point, so `abi-runtime.js:553` (`this.buildBetterTaskSource.sync({ now })`) keeps working with no change.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/buildbetter-transcripts.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full suite (guard the signals path didn't regress)**

Run: `node --test`
Expected: all pass, including any existing BuildBetter task tests.

- [ ] **Step 6: Commit**

```bash
git add src/integrations/buildbetter-tasks.js test/buildbetter-transcripts.test.js
git commit -m "feat: BuildBetter transcript ingestion via BUILDBETTER_INGEST_MODE"
```

---

### Task B5: Config surface for the new keys

**Files:**
- Modify: `src/setup-wizard.js:12-30` (`WIZARD_FIELDS`)
- Modify: `README.md` and/or `.env.example` (document the new vars)

- [ ] **Step 1: Add the new env vars to the allowlist**

In `src/setup-wizard.js`, extend the `WIZARD_FIELDS` array (before the MCP spread) with:
```js
  "EXA_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_API_KEY", "BRAVE_API_KEY",
  "PERPLEXITY_API_KEY", "SERPAPI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_CSE_ID",
  "WEB_SEARCH_PROVIDER",
  "BUILDBETTER_INGEST_MODE",
```
This lets `/setup/save` persist them (the merge logic and `0600` write already handle any allowlisted key).

- [ ] **Step 2: Document the vars**

Add a "Web search" section to the README (and `.env.example` if present) listing the six keys, the optional `WEB_SEARCH_PROVIDER` (one of `exa|tavily|firecrawl|brave|perplexity|serpapi`), and `BUILDBETTER_INGEST_MODE` (`signals|transcripts|both`, default `signals`). Note that web search degrades gracefully: no key → `web_search` returns a clear error, `fetch_url` still works via plain fetch.

- [ ] **Step 3: (Optional) add a wizard UI step**

If you want the keys editable in the `/setup` browser flow (not just via `.env`), add input fields in the relevant `renderWizard` step. Per repo memory: do NOT use backticks inside the wizard's embedded `<script>` template literal, and escape any `${...}` you add inside the template. If short on time, skip — the allowlist (Step 1) already makes the keys persistable, and they can be set in `~/.openagi/.env` directly.

- [ ] **Step 4: Run the full suite + smoke test**

Run: `node --test`
Expected: all pass.

Smoke: with `OPENAGI_DATA_DIR=/tmp/openagi-smoke` set, run `/setup/save` (or `saveEnv`) with an `EXA_API_KEY` and confirm it lands in `/tmp/openagi-smoke/.env`.

- [ ] **Step 5: Commit**

```bash
git add src/setup-wizard.js README.md
git commit -m "feat: persist web-search + BUILDBETTER_INGEST_MODE keys via setup allowlist"
```

---

## Final verification

- [ ] Run `node --test` — entire suite green.
- [ ] `grep -rn 'process.cwd(), "\.openagi"\|?? "\.openagi"' --include="*.js" src examples` — empty.
- [ ] Boot with `OPENAGI_DATA_DIR=/tmp/openagi-final node examples/hosted-server.js`, hit `/health`, confirm state lands under `/tmp/openagi-final/`.
- [ ] `web_search` with no keys returns the "no provider configured" error; with `EXA_API_KEY` set, returns live results.
- [ ] `BUILDBETTER_INGEST_MODE=transcripts` records transcripts; `recall_activity` with a query from a recent call returns them.
```
