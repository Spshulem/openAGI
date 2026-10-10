# Phase E: Reach and Recall (Week 5)

> **Read `00-INDEX.md` first** — its Global Constraints, decision gates, and execution protocol apply to every task below.
>
> **Drift rule:** Tasks in this plan share hot files (collision table in `00-INDEX.md`). If a Before-quote fails to match byte-for-byte and the difference is explained by an EARLIER task in this plan having edited that region (e.g. a new entry appended to `MAP` in `src/outreach-mapper.js`), apply the edit by intent — make the same change relative to the current code — and say so in the commit body. If the drift is NOT explained by an earlier plan task, STOP and report; the repo has moved since 2026-07-05.


---

<!-- verified:E1 status=fixed:2 -->
### Task E1: search_sessions — the agent can search its own past conversations
**Week:** 5 · **Size:** L · **Depends on:** none
**User story:** As Spencer (the openAGI owner), I want the agent to full-text search its own past chat transcripts on demand, so that questions like "what did we decide about X three weeks ago?" are answered from the actual conversation record instead of a lossy memory distillation.
**Why (evidence):** Verified advantage "session-search" (wf-advantages.md): Hermes has an agent-invocable session_search tool (SQLite FTS5 over the full message store), while openAGI's agent has only `recall` (token-overlap over memory items, src/memory-system.js:67-110), `recall_activity` (FTS5 over screen OCR, src/observation-store.js), and the metadata-only `list_sessions` tool (src/tool-registry.js:426) — there is no tool that searches chat-history content. Transcripts exist on disk (per-session JSON under agent-host/sessions, src/agent-store.js:150-178) but are only read by batch/infra paths, never by an agent tool.

**Privacy constraints (binding for every step):** Live transcripts under `~/.openagi` are personal data. No step may read, print, or paste content from `~/.openagi` — only file existence and row counts are permitted for verification. All tests below use synthetic transcripts in `os.tmpdir()` temp dirs, and the search tool caps every snippet at 160 characters so a single tool result cannot dump a long transcript passage into model context.

**One deliberate spec clarification:** the tool must be read-only. In this repo the registry defaults `sideEffects` to TRUE ("a tool must explicitly declare sideEffects: false to count as read-only", src/tool-registry.js:26-31), and scrutiny 'watch' turns hard-block side-effecting tools (src/tool-registry.js:146-151). Therefore the registration MUST include `sideEffects: false` (exactly like `recall` at src/tool-registry.js:234 and `list_sessions` at src/tool-registry.js:427) — omitting the flag would mark it side-effecting and block it on watch turns.

**Acceptance criteria:**
- `node --test test/session-index.test.js` (run from /Users/you/Dev/openAGI) reports fail 0 with 6 tests passing.
- `npm test` (full suite, from /Users/you/Dev/openAGI) reports fail 0.
- `node -e "import('/Users/you/Dev/openAGI/src/index.js').then(m => { const t = new m.ToolRegistry(); m.registerCoreTools(t, {}); const tool = t.get('search_sessions'); console.log(Boolean(tool), tool.sideEffects, tool.needsConfirmation); })"` prints `true false false`.
- A runtime built with `createDefaultRuntime(...)` exposes `runtime.sessionIndex` (a `SessionIndex`), and a chat turn through `agentHost.handleMessage` makes the user and assistant messages findable via `runtime.sessionIndex.search(...)` (proven by test "agent host indexes persisted chat turns; ephemeral turns are excluded").
- On a data dir that already has transcripts but no index DB, boot backfills the index (proven by test "boot backfills an empty index from existing transcripts").
- Every snippet returned by `SessionIndex.search()` is ≤ 160 characters (proven by test "search snippets are capped at 160 chars").
- Optional live smoke check (counts/existence only, AFTER the daemon is restarted on this branch): `ls -la ~/.openagi/agent-host/session-index.db` shows the file exists. Do NOT open or query the live DB contents beyond `SELECT COUNT(*)`; never SELECT text columns.

**Files:**
- Create: src/session-index.js
- Create: test/session-index.test.js
- Modify: src/index.js:31 (add export after the ObservationStore export)
- Modify: src/abi-runtime.js:25 (import), src/abi-runtime.js:152 (construct SessionIndex next to ObservationStore), src/abi-runtime.js:1048-1050 (boot backfill in createDefaultRuntime)
- Modify: src/agent-host.js:64-73 (index the persisted user message), src/agent-host.js:217 (index the persisted assistant message)
- Modify: src/tool-registry.js:436-440 (register search_sessions immediately after list_sessions)
- Test: test/session-index.test.js

**Interfaces:**
- Consumes (existing, copied from source):
  - `src/agent-store.js:171` — `appendMessage(sessionId, message)` (FileBackedAgentStore; returns the session object `{ id, createdAt, updatedAt, messages, metadata }`); `src/agent-store.js:154` — `getSession(sessionId)`; `src/agent-store.js:180` — `listSessions()` returning `[{ id, createdAt, updatedAt, messageCount, lastMessage }]`.
  - Message shape from `normalizeMessage` (src/agent-store.js:213-224): `{ id, role, content, agentId, channel, from, createdAt, metadata }` — `id` defaults to `createId("msg")`, `createdAt` to `nowIso()`.
  - SQLite driver pattern from src/observation-store.js:33-43: `sqlite3Module = await import("node:sqlite")` then `new sqlite.DatabaseSync(this.dbPath)`; JSONL fallback when `node:sqlite` is unavailable. FTS5 via `CREATE VIRTUAL TABLE ... USING fts5(...)` with `tokenize='porter unicode61'` and the `snippet(...)` SQL function (src/observation-store.js:89-98, 170).
  - `resolveDataDir()` (src/data-dir.js:12), `ensureDir(dir)` (src/file-utils.js:4), `nowIso()` (src/utils.js:3).
  - `registry.register(tool)` (src/tool-registry.js:9) and `registry.invoke(name, args, context)` returning `{ ok: true, result }` or `{ ok: false, error }` (src/tool-registry.js:118).
- Produces (new; later tasks may rely on these exact shapes):
  - `class SessionIndex` (src/session-index.js, exported from src/index.js): `new SessionIndex({ dir? })` (default dir `path.join(resolveDataDir(), "agent-host")`, DB file `session-index.db` in that dir); properties `ready` (Promise), `wasMissing` (boolean, computed before DB creation); methods `async indexMessage(sessionId, agentId, msg) -> { indexed: 0|1, mode?, deduped? }`, `async search(query, { limit = 8 } = {}) -> [{ sessionId, ts, role, snippet }]` (snippet ≤ 160 chars, newest first), `async rebuildFromTranscripts(agentStore) -> { sessions, indexed }`, `async stats() -> { mode, messages }`.
  - `runtime.sessionIndex` on `AbiRuntime` (options: `sessionIndex`, `sessionIndexOptions`); `runtime.sessionIndex.rebuildPromise` assigned in `createDefaultRuntime` (awaitable; resolves to the rebuild result or `{ skipped: true, ... }`).
  - Tool `search_sessions` with args `{ query: string, limit?: integer }` returning `{ count, results: [{ sessionId, at, when, role, snippet }] }` where `when` is `ts.slice(0, 16).replace("T", " ")` (e.g. `2026-06-05 09:30`, UTC).

#### Steps

Cycle A — SessionIndex core (index + search round trip)

1. [ ] Create `test/session-index.test.js` with exactly this content (all imports for later cycles included up front; `node --test` does not lint unused imports):

```js
// SessionIndex: FTS5 search over the agent's own chat transcripts, feeding
// the search_sessions tool. All transcripts in this file are SYNTHETIC —
// these tests must never read the live ~/.openagi data dir.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createDefaultRuntime,
  DeterministicModelProvider,
  FileBackedAgentStore,
  SessionIndex
} from "../src/index.js";

test("session index round-trips: indexMessage then search finds the message", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-sessidx-"));
  const index = new SessionIndex({ dir });
  await index.ready;
  await index.indexMessage("local:user:main", "main", {
    id: "msg_test_0001",
    role: "user",
    content: "we decided to use postgres for the billing service",
    createdAt: "2026-06-01T10:00:00.000Z"
  });
  await index.indexMessage("local:user:main", "main", {
    id: "msg_test_0002",
    role: "assistant",
    content: "Noted, postgres it is for billing.",
    createdAt: "2026-06-01T10:00:05.000Z"
  });
  const hits = await index.search("postgres", { limit: 5 });
  assert.ok(hits.length >= 2, `expected two hits, got ${hits.length}`);
  assert.equal(hits[0].sessionId, "local:user:main");
  assert.ok(["user", "assistant"].includes(hits[0].role));
  assert.match(hits[0].snippet, /postgres/i);
  assert.ok(hits[0].ts, "hit carries a timestamp");
  assert.equal(hits[0].ts, "2026-06-01T10:00:05.000Z", "results are newest-first");
});
```

2. [ ] Run it and confirm the exact failure. Command (from /Users/you/Dev/openAGI): `node --test test/session-index.test.js` — expected failure: the file errors at import time with `SyntaxError: The requested module '../src/index.js' does not provide an export named 'SessionIndex'` and the summary reports fail ≥ 1.

3. [ ] Create `src/session-index.js` with exactly this content (mirrors the node:sqlite + FTS5 + JSONL-fallback pattern of src/observation-store.js; no snippet cap yet — Cycle B adds it test-first):

```js
// SQLite FTS5 index over the agent's own chat transcripts so the agent can
// search its past conversations on demand (the search_sessions tool). Memory
// distillation is lossy by design; the raw transcript is ground truth for
// "what did we decide about X three weeks ago?".
//
// File-backed at <dataDir>/agent-host/session-index.db — next to the per-
// session transcript JSON files it indexes (agent-store.js). Same node:sqlite
// + FTS5 pattern (and JSONL fallback) as observation-store.js. Schema:
//   messages(FTS5) — one row per persisted chat message
//
// Rows are append-only here; the transcripts on disk remain the source of
// truth. Deleting the DB is always safe — boot detects an empty index and
// backfills from transcripts (see rebuildFromTranscripts + createDefaultRuntime).

import path from "node:path";
import fs from "node:fs";
import { ensureDir } from "./file-utils.js";
import { nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

let sqlite3Module = null;
async function loadSqlite() {
  if (sqlite3Module) return sqlite3Module;
  try {
    sqlite3Module = await import("node:sqlite");
    return sqlite3Module;
  } catch {
    sqlite3Module = null;
    return null;
  }
}

export class SessionIndex {
  constructor(options = {}) {
    this.dir = options.dir ?? path.join(resolveDataDir(), "agent-host");
    this.dbPath = path.join(this.dir, "session-index.db");
    ensureDir(this.dir);
    // Recorded BEFORE the DB file is created, so callers can tell a first
    // boot (no index yet) from a normal one. Boot backfill itself gates on
    // "index is empty" (createDefaultRuntime), which also covers a DB file
    // that exists but was created empty.
    this.wasMissing = !fs.existsSync(this.dbPath) && !fs.existsSync(path.join(this.dir, "session-index.jsonl"));
    this.db = null;
    this.fallback = null; // JSONL fallback when node:sqlite isn't available
    this.fallbackPath = path.join(this.dir, "session-index.jsonl");
    this.ready = this.init();
  }

  async init() {
    const sqlite = await loadSqlite();
    if (!sqlite) {
      // node:sqlite is available in Node 22.5+. If it's missing we degrade to
      // a JSONL append log so search still works (slower, no FTS ranking).
      this.fallback = true;
      return;
    }
    this.db = new sqlite.DatabaseSync(this.dbPath);
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(
        msg_id UNINDEXED,
        session_id UNINDEXED,
        agent_id UNINDEXED,
        ts UNINDEXED,
        role UNINDEXED,
        text,
        tokenize='porter unicode61'
      );
    `);
  }

  async indexMessage(sessionId, agentId, msg) {
    await this.ready;
    if (!msg || typeof msg.content !== "string" || !msg.content.trim()) return { indexed: 0 };
    const row = {
      msgId: msg.id ?? null,
      sessionId: String(sessionId ?? ""),
      agentId: String(agentId ?? ""),
      ts: msg.createdAt ?? nowIso(),
      role: msg.role ?? "user",
      text: msg.content
    };
    if (this.fallback) {
      fs.appendFileSync(this.fallbackPath, JSON.stringify(row) + "\n");
      return { indexed: 1, mode: "fallback-jsonl" };
    }
    // Dedupe by message id so a boot-time backfill racing live appends can't
    // double-index a row. msg_id is UNINDEXED in the FTS5 table so this is a
    // scan — the same trade-off observation-store makes for transcript refs.
    if (row.msgId) {
      const existing = this.db.prepare(`SELECT 1 FROM messages WHERE msg_id = ? LIMIT 1`).get(row.msgId);
      if (existing) return { indexed: 0, deduped: true };
    }
    this.db.prepare(
      `INSERT INTO messages (msg_id, session_id, agent_id, ts, role, text) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(row.msgId, row.sessionId, row.agentId, row.ts, row.role, row.text);
    return { indexed: 1, mode: "sqlite" };
  }

  async search(query, { limit = 8 } = {}) {
    await this.ready;
    const q = String(query ?? "").trim();
    if (!q) return [];
    if (this.fallback) {
      // Naive fallback search through the JSONL log.
      let rows = [];
      try { rows = fs.readFileSync(this.fallbackPath, "utf8").split("\n").filter(Boolean).map(JSON.parse); } catch { return []; }
      const needle = q.toLowerCase();
      return rows
        .filter((r) => (r.text || "").toLowerCase().includes(needle))
        .sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? ""))
        .slice(0, limit)
        .map((r) => ({ sessionId: r.sessionId, ts: r.ts, role: r.role, snippet: r.text }));
    }
    // FTS5 query — escape doubled-quotes for the MATCH expression
    const escaped = q.replace(/"/g, '""');
    const matchExpr = `"${escaped}"`;
    const rows = this.db.prepare(
      `SELECT session_id, ts, role, snippet(messages, 5, '<mark>', '</mark>', '…', 12) AS snippet
       FROM messages WHERE messages MATCH ?
       ORDER BY ts DESC LIMIT ?`
    ).all(matchExpr, limit);
    return rows.map((r) => ({ sessionId: r.session_id, ts: r.ts, role: r.role, snippet: r.snippet }));
  }

  async stats() {
    await this.ready;
    if (this.fallback) {
      let lines = 0;
      try { lines = fs.readFileSync(this.fallbackPath, "utf8").split("\n").filter(Boolean).length; } catch { /* none */ }
      return { mode: "fallback-jsonl", messages: lines };
    }
    const m = this.db.prepare("SELECT COUNT(*) AS n FROM messages").get();
    return { mode: "sqlite", messages: m.n };
  }
}
```

4. [ ] Export it. In `src/index.js`, replace this exact line (currently line 31):

```js
export { ObservationStore } from "./observation-store.js";
```

with:

```js
export { ObservationStore } from "./observation-store.js";
export { SessionIndex } from "./session-index.js";
```

5. [ ] Run `node --test test/session-index.test.js` — expect the round-trip test to pass and the summary to report fail 0 (wording varies by Node version: `ℹ fail 0` or `# fail 0`).

6. [ ] Run the full suite: `npm test` (from /Users/you/Dev/openAGI) — expect fail 0.

7. [ ] Commit: `git add src/session-index.js src/index.js test/session-index.test.js && git commit -m "feat(session-index): FTS5 index over chat transcripts with indexMessage and search"`

Cycle B — snippet cap (privacy)

8. [ ] Append this test to the end of `test/session-index.test.js`:

```js
test("search snippets are capped at 160 chars", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-sessidx-cap-"));
  const index = new SessionIndex({ dir });
  await index.ready;
  // Long tokens so even the 12-token FTS snippet window exceeds 160 chars.
  const filler = Array(40).fill("abcdefghijklmnopqrstuvwxyzabcd").join(" ");
  await index.indexMessage("local:user:main", "main", {
    id: "msg_test_cap",
    role: "user",
    content: `zanzibarmigration ${filler}`,
    createdAt: "2026-06-02T09:00:00.000Z"
  });
  const hits = await index.search("zanzibarmigration", { limit: 3 });
  assert.ok(hits.length >= 1, "expected a hit");
  assert.ok(hits[0].snippet.length <= 160, `snippet must be capped at 160 chars, got ${hits[0].snippet.length}`);
});
```

9. [ ] Run `node --test test/session-index.test.js` — expected failure: `AssertionError` with message starting `snippet must be capped at 160 chars, got` (a number well above 160 in both sqlite and fallback modes).

10. [ ] Implement the cap in `src/session-index.js` with three narrow edits. Edit 1 — replace:

```js
import { resolveDataDir } from "./data-dir.js";

let sqlite3Module = null;
```

with:

```js
import { resolveDataDir } from "./data-dir.js";

// Cap snippets returned by search() so a single hit can't dump a long
// personal transcript passage into a tool result — transcripts are the most
// sensitive store the agent can read. Full text stays in the DB. Same intent
// as TRANSCRIPT_SEARCH_TEXT_CAP in observation-store.js, tighter bound.
const SNIPPET_CAP = 160;

function capSnippet(text) {
  const s = String(text ?? "");
  return s.length > SNIPPET_CAP ? s.slice(0, SNIPPET_CAP - 1) + "…" : s;
}

let sqlite3Module = null;
```

Edit 2 — replace:

```js
        .map((r) => ({ sessionId: r.sessionId, ts: r.ts, role: r.role, snippet: r.text }));
```

with:

```js
        .map((r) => ({ sessionId: r.sessionId, ts: r.ts, role: r.role, snippet: capSnippet(r.text) }));
```

Edit 3 — replace:

```js
    return rows.map((r) => ({ sessionId: r.session_id, ts: r.ts, role: r.role, snippet: r.snippet }));
```

with:

```js
    return rows.map((r) => ({ sessionId: r.session_id, ts: r.ts, role: r.role, snippet: capSnippet(r.snippet) }));
```

11. [ ] Run `node --test test/session-index.test.js` — expect 2 tests passing, fail 0. Then run `npm test` — expect fail 0.

12. [ ] Commit: `git add src/session-index.js test/session-index.test.js && git commit -m "feat(session-index): cap search snippets at 160 chars for tool-result privacy"`

Cycle C — rebuildFromTranscripts (first-boot backfill)

13. [ ] Append this test to the end of `test/session-index.test.js` (seeds a synthetic FileBackedAgentStore transcript dir, then backfills a fresh index from it):

```js
test("rebuildFromTranscripts backfills a fresh index from seeded transcripts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-sessidx-rebuild-"));
  const store = new FileBackedAgentStore({ dir: path.join(dir, "agent-host") });
  store.appendMessage("local:user:main", {
    role: "user",
    content: "let's standardize on the kumquat naming convention",
    agentId: "main",
    channel: "local",
    from: "user",
    createdAt: "2026-06-03T08:00:00.000Z"
  });
  store.appendMessage("telegram:42:main", {
    role: "assistant",
    content: "Reminder: kumquat convention applies to new modules only.",
    agentId: "main",
    channel: "telegram",
    from: "openagi",
    createdAt: "2026-06-04T08:00:00.000Z"
  });

  const index = new SessionIndex({ dir: path.join(dir, "agent-host") });
  assert.equal(index.wasMissing, true, "fresh dir means the DB is reported missing");
  const result = await index.rebuildFromTranscripts(store);
  assert.equal(result.sessions, 2);
  assert.equal(result.indexed, 2);
  const hits = await index.search("kumquat", { limit: 5 });
  assert.equal(hits.length, 2);
  assert.ok(hits.some((h) => h.sessionId === "telegram:42:main"));
  assert.ok(hits.some((h) => h.sessionId === "local:user:main"));
});
```

14. [ ] Run `node --test test/session-index.test.js` — expected failure: `TypeError: index.rebuildFromTranscripts is not a function`.

15. [ ] Add the method to `src/session-index.js`. Replace:

```js
  async stats() {
    await this.ready;
```

with:

```js
  // First-boot / backfill: walk every session transcript in the agent store
  // and index each message. createDefaultRuntime invokes this at boot when
  // the index is empty (covers both a missing DB and one created empty).
  // indexMessage dedupes by message id, so re-running or overlapping with
  // live appends is safe. Reads only local transcript files the store owns.
  async rebuildFromTranscripts(agentStore) {
    await this.ready;
    if (!agentStore?.listSessions) return { sessions: 0, indexed: 0 };
    let sessions = 0;
    let indexed = 0;
    for (const meta of agentStore.listSessions()) {
      const session = agentStore.getSession(meta.id);
      if (!session?.messages?.length) continue;
      sessions += 1;
      for (const msg of session.messages) {
        const result = await this.indexMessage(session.id, msg.agentId ?? "main", msg);
        indexed += result.indexed ?? 0;
      }
    }
    return { sessions, indexed };
  }

  async stats() {
    await this.ready;
```

16. [ ] Run `node --test test/session-index.test.js` — expect 3 tests passing, fail 0. Then `npm test` — expect fail 0.

17. [ ] Commit: `git add src/session-index.js test/session-index.test.js && git commit -m "feat(session-index): rebuildFromTranscripts backfill from on-disk session transcripts"`

Cycle D — runtime wiring: construct at boot, backfill when empty, index every persisted turn

18. [ ] Append these two tests to the end of `test/session-index.test.js`:

```js
test("agent host indexes persisted chat turns; ephemeral turns are excluded", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-sessidx-host-"));
  const runtime = createDefaultRuntime({
    modelProvider: new DeterministicModelProvider(),
    dataDir: dir,
    sessionIndexOptions: { dir: path.join(dir, "agent-host") },
    observationOptions: { dir: path.join(dir, "observations") },
    outcomeOptions: { dir: path.join(dir, "outcomes") }
  });
  assert.ok(runtime.sessionIndex, "runtime should construct a SessionIndex");

  await runtime.agentHost.handleMessage({ channel: "local", from: "user", text: "please review the xylophone budget line" });
  await runtime.agentHost.handleMessage({ channel: "local", from: "setup", text: "ephemeral xylograph check", ephemeral: true });

  const hits = await runtime.sessionIndex.search("xylophone", { limit: 5 });
  assert.ok(hits.length >= 1, "persisted user turn should be indexed");
  assert.ok(hits.some((h) => h.role === "user"));

  const ghost = await runtime.sessionIndex.search("xylograph", { limit: 5 });
  assert.equal(ghost.length, 0, "ephemeral turns must not be indexed");
});

test("boot backfills an empty index from existing transcripts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-sessidx-boot-"));
  const store = new FileBackedAgentStore({ dir: path.join(dir, "agent-host") });
  store.appendMessage("local:user:main", {
    role: "user",
    content: "archive the pelican dashboard next sprint",
    agentId: "main",
    channel: "local",
    from: "user",
    createdAt: "2026-06-06T08:00:00.000Z"
  });

  const runtime = createDefaultRuntime({
    modelProvider: new DeterministicModelProvider(),
    dataDir: dir,
    agentStore: store,
    observationOptions: { dir: path.join(dir, "observations") },
    outcomeOptions: { dir: path.join(dir, "outcomes") }
  });
  assert.ok(runtime.sessionIndex.rebuildPromise, "boot should schedule a backfill");
  await runtime.sessionIndex.rebuildPromise;
  const hits = await runtime.sessionIndex.search("pelican", { limit: 5 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, "local:user:main");
});
```

19. [ ] Run `node --test test/session-index.test.js` — expected failures: `AssertionError ... runtime should construct a SessionIndex` and `TypeError: Cannot read properties of undefined (reading 'rebuildPromise')` (runtime.sessionIndex is undefined before wiring).

20. [ ] Wire the runtime in `src/abi-runtime.js` with three edits. Edit 1 (import) — replace:

```js
import { OutcomeStore } from "./outcome-store.js";
```

with:

```js
import { OutcomeStore } from "./outcome-store.js";
import { SessionIndex } from "./session-index.js";
```

Edit 2 (construct next to ObservationStore, dataDir-scoped like PendingActionStore at lines 138-141) — replace:

```js
    this.observations = options.observations ?? new ObservationStore(options.observationOptions ?? {});
```

with:

```js
    this.observations = options.observations ?? new ObservationStore(options.observationOptions ?? {});
    // FTS5 index over the agent's own chat transcripts, so search_sessions can
    // answer "what did we decide about X?" from the raw conversation record.
    // Lives next to the transcripts at <dataDir>/agent-host/session-index.db.
    this.sessionIndex = options.sessionIndex ?? new SessionIndex({
      dir: options.dataDir ? path.join(options.dataDir, "agent-host") : undefined,
      ...(options.sessionIndexOptions ?? {})
    });
```

Edit 3 (boot backfill in createDefaultRuntime; same non-blocking best-effort spirit as the mcp.connectAll boot reconnect at src/abi-runtime.js:1102-1104) — replace:

```js
        modelProviderOptions: { ...(options.modelProviderOptions ?? {}), budgetGuard: runtime.budget }
      });
  }
```

with:

```js
        modelProviderOptions: { ...(options.modelProviderOptions ?? {}), budgetGuard: runtime.budget }
      });
  }
  // First boot / backfill: when the session index is empty (missing DB, or a
  // DB file created empty), seed it from the transcripts already on disk.
  // Non-blocking and best-effort so a large history can't hold up startup;
  // indexMessage dedupes by message id, so overlap with live appends during
  // the walk is safe. The promise is kept on the index so tests can await it.
  if (runtime.agentHost && runtime.sessionIndex) {
    runtime.sessionIndex.rebuildPromise = Promise.resolve()
      .then(async () => {
        const s = await runtime.sessionIndex.stats();
        if (s.messages > 0) return { skipped: true, reason: "index already populated" };
        return runtime.sessionIndex.rebuildFromTranscripts(runtime.agentHost.store);
      })
      .catch(() => {});
  }
```

21. [ ] Hook the single message-append choke point. Every persisted message in the system flows through `AgentHost.handleMessage` (chat, channels, scheduled prompts via runScheduledPrompt, autopilot via runAutopilot — all call handleMessage, which is the only caller of `store.appendMessage` in src/), so the hook is its two append sites in `src/agent-host.js`. Edit 1 — replace:

```js
    const sessionBefore = ephemeral
      ? { id: sessionId, messages: [{ role: "user", content: text }] }
      : this.store.appendMessage(sessionId, {
          role: "user",
          content: text,
          agentId,
          channel,
          from,
          metadata: input.metadata ?? {}
        });
```

with:

```js
    const sessionBefore = ephemeral
      ? { id: sessionId, messages: [{ role: "user", content: text }] }
      : this.store.appendMessage(sessionId, {
          role: "user",
          content: text,
          agentId,
          channel,
          from,
          metadata: input.metadata ?? {}
        });

    // Incremental session indexing (search_sessions): every persisted message
    // is added to the FTS index as it lands. Best-effort — an indexing failure
    // must never block a chat reply. Ephemeral turns leave no trace anywhere,
    // including here.
    if (!ephemeral && this.runtime.sessionIndex) {
      this.runtime.sessionIndex.indexMessage(sessionId, agentId, sessionBefore.messages.at(-1)).catch(() => {});
    }
```

Edit 2 — replace:

```js
    if (outcomeRecord) outcomeRecord.refId = sessionAfter.messages.at(-1)?.id ?? null;
```

with:

```js
    if (outcomeRecord) outcomeRecord.refId = sessionAfter.messages.at(-1)?.id ?? null;

    if (!ephemeral && this.runtime.sessionIndex) {
      this.runtime.sessionIndex.indexMessage(sessionId, agentId, sessionAfter.messages.at(-1)).catch(() => {});
    }
```

22. [ ] Run `node --test test/session-index.test.js` — expect 5 tests passing, fail 0.

23. [ ] Run `npm test` — expect fail 0 (pay attention to test/ephemeral-turn.test.js: it must still pass, proving ephemeral turns stay trace-free).

24. [ ] Commit: `git add src/abi-runtime.js src/agent-host.js test/session-index.test.js && git commit -m "feat(runtime): construct session index at boot, backfill empty index, index turns in agent-host"`

Cycle E — the search_sessions tool

25. [ ] Append this test to the end of `test/session-index.test.js`:

```js
test("search_sessions tool is registered read-only and returns formatted results", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-sessidx-tool-"));
  const runtime = createDefaultRuntime({
    modelProvider: new DeterministicModelProvider(),
    dataDir: dir,
    observationOptions: { dir: path.join(dir, "observations") },
    outcomeOptions: { dir: path.join(dir, "outcomes") }
  });
  const tool = runtime.tools.get("search_sessions");
  assert.ok(tool, "search_sessions tool should be registered");
  assert.equal(tool.sideEffects, false, "search_sessions must be read-only");
  assert.equal(tool.needsConfirmation, false);

  await runtime.sessionIndex.indexMessage("local:user:main", "main", {
    id: "msg_tool_0001",
    role: "user",
    content: "the quarterly flamingo report is due friday",
    createdAt: "2026-06-05T09:30:00.000Z"
  });

  const result = await runtime.tools.invoke("search_sessions", { query: "flamingo", limit: 5 });
  assert.equal(result.ok, true);
  assert.ok(result.result.count >= 1);
  const hit = result.result.results[0];
  assert.equal(hit.sessionId, "local:user:main");
  assert.match(hit.when, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, "human-readable timestamp");
  assert.equal(hit.role, "user");
  assert.ok(hit.snippet.length <= 160);
});
```

26. [ ] Run `node --test test/session-index.test.js` — expected failure: `AssertionError ... search_sessions tool should be registered`.

27. [ ] Register the tool in `src/tool-registry.js`, directly after the `list_sessions` registration (same shape/description style as `recall_activity` at line 371 and `list_sessions` at line 425). Replace:

```js
    handler: async (args) => {
      const sessions = runtime.agentHost?.store.listSessions() ?? [];
      return sessions.slice(0, args.limit ?? 10);
    }
  });
```

with:

```js
    handler: async (args) => {
      const sessions = runtime.agentHost?.store.listSessions() ?? [];
      return sessions.slice(0, args.limit ?? 10);
    }
  });

  registry.register({
    name: "search_sessions",
    sideEffects: false,
    description: "Full-text search your own past conversations (chat transcripts across all sessions and channels). Use when the user asks what was said, decided, or promised earlier — e.g. 'what did we decide about X last week?'. Returns matching messages with session id, timestamp (UTC), role, and a short snippet; use list_sessions for session metadata. The raw transcript is ground truth — prefer this over recall when the user references a specific past exchange.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search across past conversation messages." },
        limit: { type: "integer", minimum: 1, maximum: 25, description: "Maximum results to return (default 8)." }
      },
      required: ["query"],
      additionalProperties: false
    },
    handler: async (args) => {
      if (!runtime.sessionIndex) return { error: "no session index" };
      const results = await runtime.sessionIndex.search(String(args.query ?? ""), { limit: args.limit ?? 8 });
      return {
        count: results.length,
        results: results.map((r) => ({
          sessionId: r.sessionId,
          at: r.ts,
          when: String(r.ts ?? "").slice(0, 16).replace("T", " "),
          role: r.role,
          snippet: r.snippet
        }))
      };
    }
  });
```

28. [ ] Run `node --test test/session-index.test.js` — expect 6 tests passing, fail 0.

29. [ ] Run `npm test` — expect fail 0 (test/verdict-consequences.test.js asserts sideEffects flags on specific named core tools, and test/tool-registry-cap.test.js builds its own registries of synthetic tools — neither asserts a total core-tool count, so the added registration cannot break them).

30. [ ] Verify the acceptance-criteria one-liner prints `true false false`: `node -e "import('/Users/you/Dev/openAGI/src/index.js').then(m => { const t = new m.ToolRegistry(); m.registerCoreTools(t, {}); const tool = t.get('search_sessions'); console.log(Boolean(tool), tool.sideEffects, tool.needsConfirmation); })"`

31. [ ] Commit: `git add src/tool-registry.js test/session-index.test.js && git commit -m "feat(tools): search_sessions read-only tool over past conversations"`

---

<!-- verified:E2 status=fixed:2 -->
### Task E2a: Telegram pairing state machine (one-time code, expiry, lockout, persisted allowlist)
**Week:** 5 · **Size:** M · **Depends on:** none
**User story:** As Spencer (the openAGI owner), I want a pairing security layer for Telegram — a short-lived one-time code that only I can see, which allowlists exactly the chats I pair — so that a stranger who finds my bot can never talk to my agent or receive my data.
**Why (evidence):** The verified "channel-breadth" advantage (wf-advantages.md, verdict: confirmed) states openAGI's `src/channels.js` has "only Telegram and Twilio SMS classes with no pairing/allowlist" while hermes has real DM pairing (one-time codes, expiry, rate limits, lockout, 0600 file perms). Concretely, `TelegramChannel.handleUpdate` (src/channels.js:117-142) forwards **any** chat's message straight into `agentHost.handleMessage` and replies to it, and the webhook route is public with a secret check that passes open when no secret is configured (src/auth.js:45, src/auth.js:83-86). This task builds the pairing state machine as a standalone, fully unit-testable module; Task E2b wires it into the channel.
**Acceptance criteria:**
- `node --test test/telegram-pairing.test.js` passes: valid code pairs; code is single-use; expired code (>10 min) fails with reason `expired`; the 5th failed attempt returns reason `locked` and the 6th attempt is rejected **even with the correct code**; after the 15-minute lockout a fresh code pairs; the allowlist survives re-instantiation from `allowlist.json`.
- `allowlist.json` is written with mode 0600 (this is automatic: `writeJsonAtomic` defaults to `mode = 0o600`, src/file-utils.js:26).
- `npm test` passes with no regressions.
**Files:**
- Create: src/telegram-pairing.js
- Test: test/telegram-pairing.test.js
**Interfaces:**
- Consumes (existing, copied from source):
  - `export function ensureDir(dir)` (src/file-utils.js:4)
  - `export function readJsonFile(filePath, fallback = null)` (src/file-utils.js:17)
  - `export function writeJsonAtomic(filePath, value, mode = 0o600)` (src/file-utils.js:26)
  - `export function resolveDataDir()` (src/data-dir.js:12)
  - `crypto.randomInt(min, max)` and `crypto.timingSafeEqual(a, b)` from `node:crypto`
- Produces (new, later tasks rely on these):
  - `class TelegramPairing` with constructor `new TelegramPairing({ dir })` (dir defaults to `<dataDir>/channels/telegram`)
  - `generateCode({ now = Date.now() } = {})` → `{ code: string /* 6 digits */, expiresAt: string /* ISO */ }`
  - `attempt(chatId, code, { now = Date.now() } = {})` → `{ ok: true }` on success; `{ ok: false, reason: "locked" | "no-active-code" | "expired" | "invalid" }` on failure
  - `isAllowed(chatId)` → `boolean`
  - `allowlist()` → `string[]` of chat ids
  - `status()` → `{ pairedChats: number, codeActive: boolean, lockedUntil: string | null }`
  - Exported constants: `CODE_TTL_MS` (600000), `MAX_ATTEMPTS` (5), `LOCKOUT_MS` (900000)
  - On-disk format of `<dir>/allowlist.json`: `{ "version": 1, "chats": [{ "chatId": "12345", "pairedAt": "<ISO>" }] }`

Steps:

1. [ ] Write the failing test file. Create `test/telegram-pairing.test.js` with exactly this content:

```js
// test/telegram-pairing.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { TelegramPairing, CODE_TTL_MS, LOCKOUT_MS } from "../src/telegram-pairing.js";

function pairing() {
  return new TelegramPairing({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "tg-pair-")) });
}

test("a valid code pairs the chat and is single use", () => {
  const p = pairing();
  const t0 = Date.parse("2026-07-06T12:00:00Z");
  const issued = p.generateCode({ now: t0 });
  assert.match(issued.code, /^\d{6}$/);
  assert.equal(issued.expiresAt, new Date(t0 + CODE_TTL_MS).toISOString());
  const r = p.attempt("12345", issued.code, { now: t0 + 1000 });
  assert.equal(r.ok, true);
  assert.equal(p.isAllowed("12345"), true);
  assert.equal(p.isAllowed("99999"), false);
  // single use: the same code cannot pair a second chat
  const r2 = p.attempt("67890", issued.code, { now: t0 + 2000 });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, "no-active-code");
  assert.equal(p.isAllowed("67890"), false);
});

test("an expired code fails", () => {
  const p = pairing();
  const t0 = Date.parse("2026-07-06T12:00:00Z");
  const { code } = p.generateCode({ now: t0 });
  const r = p.attempt("12345", code, { now: t0 + CODE_TTL_MS + 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "expired");
  assert.equal(p.isAllowed("12345"), false);
});

test("the 5th failure locks pairing for 15 minutes, even against the correct code", () => {
  const p = pairing();
  const t0 = Date.parse("2026-07-06T12:00:00Z");
  const { code } = p.generateCode({ now: t0 });
  const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 1; i <= 4; i += 1) {
    const r = p.attempt("12345", wrong, { now: t0 + i });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "invalid");
  }
  const fifth = p.attempt("12345", wrong, { now: t0 + 5 });
  assert.equal(fifth.ok, false);
  assert.equal(fifth.reason, "locked");
  // 6th attempt is rejected even with the CORRECT code
  const sixth = p.attempt("12345", code, { now: t0 + 6 });
  assert.equal(sixth.ok, false);
  assert.equal(sixth.reason, "locked");
  assert.equal(p.isAllowed("12345"), false);
  // after the lockout window a freshly generated code pairs normally
  const t1 = t0 + 5 + LOCKOUT_MS + 1;
  const fresh = p.generateCode({ now: t1 });
  assert.equal(p.attempt("12345", fresh.code, { now: t1 + 1 }).ok, true);
  assert.equal(p.isAllowed("12345"), true);
});

test("the allowlist persists across instances via allowlist.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-pair-"));
  const p1 = new TelegramPairing({ dir });
  const t0 = Date.parse("2026-07-06T12:00:00Z");
  const { code } = p1.generateCode({ now: t0 });
  assert.equal(p1.attempt("777", code, { now: t0 + 1 }).ok, true);
  assert.equal(fs.existsSync(path.join(dir, "allowlist.json")), true);
  const p2 = new TelegramPairing({ dir });
  assert.equal(p2.isAllowed("777"), true);
  assert.deepEqual(p2.allowlist(), ["777"]);
});

test("pairing the same chat twice does not duplicate the allowlist entry", () => {
  const p = pairing();
  const t0 = Date.parse("2026-07-06T12:00:00Z");
  const a = p.generateCode({ now: t0 });
  p.attempt("555", a.code, { now: t0 + 1 });
  const b = p.generateCode({ now: t0 + 2 });
  p.attempt("555", b.code, { now: t0 + 3 });
  assert.deepEqual(p.allowlist(), ["555"]);
});
```

2. [ ] Run it and confirm the expected failure: `node --test test/telegram-pairing.test.js` — expect the file to fail to load with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/you/Dev/openAGI/src/telegram-pairing.js'` (node reports the file itself as 1 failing test — `# tests 1`, `# fail 1` — and exits non-zero).

3. [ ] Create `src/telegram-pairing.js` with exactly this content:

```js
// src/telegram-pairing.js
// Pairing security for the Telegram channel: a one-time 6-digit code
// (node:crypto randomInt) valid 10 minutes and single use; 5 failed attempts
// trigger a 15-minute lockout; a successful "/pair <code>" persists the chat
// id into <dir>/allowlist.json (0600 via writeJsonAtomic's default mode).
// Every method takes an injectable now (epoch ms) so the state machine is
// testable as pure logic — no timers, no network, no Telegram API.
import path from "node:path";
import crypto from "node:crypto";
import { ensureDir, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";

export const CODE_TTL_MS = 10 * 60 * 1000;   // a code is valid for 10 minutes
export const MAX_ATTEMPTS = 5;                // failures before lockout engages
export const LOCKOUT_MS = 15 * 60 * 1000;     // lockout duration

function codesEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export class TelegramPairing {
  constructor({ dir } = {}) {
    this.dir = dir ?? path.join(resolveDataDir(), "channels", "telegram");
    ensureDir(this.dir);
    this.allowlistPath = path.join(this.dir, "allowlist.json");
    this.active = null;       // { code, createdAt } — at most one live code
    this.failedAttempts = 0;
    this.lockedUntil = 0;     // epoch ms; attempts before this are rejected
  }

  // Issue a fresh one-time code, invalidating any previous one. Does NOT
  // clear an active lockout — generating codes never resets the guess budget.
  generateCode({ now = Date.now() } = {}) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    this.active = { code, createdAt: now };
    this.failedAttempts = 0;
    return { code, expiresAt: new Date(now + CODE_TTL_MS).toISOString() };
  }

  // One pairing attempt from a chat. Persists the chat id on success.
  attempt(chatId, code, { now = Date.now() } = {}) {
    if (now < this.lockedUntil) return { ok: false, reason: "locked" };
    if (!this.active) return this._fail(now, "no-active-code");
    if (now - this.active.createdAt > CODE_TTL_MS) {
      this.active = null;
      return this._fail(now, "expired");
    }
    if (!codesEqual(code, this.active.code)) return this._fail(now, "invalid");
    this.active = null; // single use
    this.failedAttempts = 0;
    this._persist(String(chatId), now);
    return { ok: true };
  }

  isAllowed(chatId) {
    return this._read().chats.some((c) => c.chatId === String(chatId));
  }

  allowlist() {
    return this._read().chats.map((c) => c.chatId);
  }

  status() {
    return {
      pairedChats: this.allowlist().length,
      codeActive: Boolean(this.active),
      lockedUntil: this.lockedUntil > Date.now() ? new Date(this.lockedUntil).toISOString() : null
    };
  }

  _fail(now, reason) {
    this.failedAttempts += 1;
    if (this.failedAttempts >= MAX_ATTEMPTS) {
      this.lockedUntil = now + LOCKOUT_MS;
      this.failedAttempts = 0;
      this.active = null; // burn the code on lockout
      return { ok: false, reason: "locked" };
    }
    return { ok: false, reason };
  }

  _read() {
    return readJsonFile(this.allowlistPath, { version: 1, chats: [] });
  }

  _persist(chatId, now) {
    const data = this._read();
    if (data.chats.some((c) => c.chatId === chatId)) return;
    data.chats.push({ chatId, pairedAt: new Date(now).toISOString() });
    writeJsonAtomic(this.allowlistPath, data);
  }
}
```

4. [ ] Run the test again: `node --test test/telegram-pairing.test.js` — expect `# pass 5`, `# fail 0`, exit code 0.
5. [ ] Run the full suite: `npm test` — expect `# fail 0` and exit code 0.
6. [ ] Commit: `git add src/telegram-pairing.js test/telegram-pairing.test.js && git commit -m "feat(telegram): pairing state machine - one-time 6-digit code, 10-min expiry, single use, 5-attempt lockout, persisted allowlist"`

---

### Task E2b: Gate TelegramChannel on the allowlist, add /pair handling and the auth-gated pairing-code endpoint
**Week:** 5 · **Size:** M · **Depends on:** E2a
**User story:** As Spencer, I want my Telegram bot to ignore everyone except chats I have explicitly paired, and I want a one-command way to fetch a pairing code, so that pairing from my phone takes under a minute and strangers get silence.
**Why (evidence):** `TelegramChannel.handleUpdate` (src/channels.js:117-142) currently runs **every** incoming update through `agentHost.handleMessage` and replies to any chat id; `/channels/telegram/webhook` is a public route (src/auth.js:45) whose secret check passes open when `TELEGRAM_WEBHOOK_SECRET` is unset (src/auth.js:83-86 returns `{ ok: true }` on no expected secret), and polling mode (`TELEGRAM_POLLING=1`, src/channels.js:79-81) ingests from anyone who discovers the bot. The wf-advantages.md "channel-breadth" entry (confirmed) names "no pairing/allowlist" as the specific defect versus hermes's gateway pairing.
**Acceptance criteria:**
- `node --test test/telegram-channel-gate.test.js` passes: a message from a non-allowlisted chat returns `{ ignored: true, reason: "not-allowlisted" }`, never reaches `agentHost.handleMessage`, and no reply is sent; a failed `/pair` gets no reply; a valid `/pair <code>` persists the chat and sends a confirmation, after which normal messages flow.
- `curl` of `GET /channels/telegram/pairing-code` without auth returns 401 when `OPENAGI_AUTH_TOKEN` is set; with a valid Bearer token it returns `{ "code": "NNNNNN", "expiresAt": "<ISO>" }` and the daemon log (stdout) contains the line `[openagi] telegram pairing code NNNNNN ...`.
- `npm test` passes with no regressions.
**Files:**
- Modify: src/channels.js:1 (imports), src/channels.js:98-107 (TelegramChannel constructor), src/channels.js:109-115 (status), src/channels.js:117-142 (handleUpdate)
- Modify: src/hosted-interface.js:291 (insert route before the /tools route)
- Test: test/telegram-channel-gate.test.js
**Interfaces:**
- Consumes:
  - `TelegramPairing` from Task E2a (`generateCode`, `attempt`, `isAllowed`, `status`)
  - `async sendMessage(chatId, text)` (src/channels.js:144 — existing Telegram send path, stubbed per-instance in tests)
  - `async handleMessage(input)` on `agentHost` (called as in src/channels.js:124-135)
  - `appendJsonLine(filePath, value, mode = 0o600)` (src/file-utils.js:43)
  - The hosted interface's global auth gate: any pathname **not** listed in `isPublicRoute` (src/auth.js:38-48) passes through `checkAuth` (src/hosted-interface.js:152-170) — the new route relies on this, so it must NOT be added to `isPublicRoute`.
  - `createDurableRuntime` / `createHostedInterface` from src/index.js and the `channelsDir` option (src/hosted-interface.js:33) for the HTTP test.
- Produces:
  - `TelegramChannel.pairing` — a `TelegramPairing` instance (injectable via `options.pairing`)
  - `handleUpdate` new return shapes: `{ paired: boolean, reason: string | null }` for `/pair` messages; `{ ignored: true, reason: "not-allowlisted" }` for unpaired chats
  - `TelegramChannel.status()` gains `pairing: { pairedChats, codeActive, lockedUntil }`
  - `GET /channels/telegram/pairing-code` (auth-gated) → 200 `{ code, expiresAt }`, or 503 `{ error: "agent-host-disabled" }` when channels are absent

Steps:

1. [ ] Write the failing test file. Create `test/telegram-channel-gate.test.js` with exactly this content:

```js
// test/telegram-channel-gate.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { TelegramChannel } from "../src/channels.js";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

function makeChannel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-chan-"));
  const handled = [];
  const sends = [];
  const channel = new TelegramChannel({
    token: "123:ABC",
    dir,
    agentHost: {
      handleMessage: async (input) => {
        handled.push(input);
        return { reply: "agent reply", session: { id: "s1" } };
      }
    }
  });
  channel.sendMessage = async (chatId, text) => {
    sends.push({ chatId, text });
    return { ok: true };
  };
  return { channel, handled, sends, dir };
}

function update(chatId, text) {
  return {
    update_id: 1,
    message: { message_id: 10, chat: { id: chatId }, from: { username: "u", first_name: "U" }, text }
  };
}

test("messages from non-allowlisted chats are ignored with no reply and no agent turn", async () => {
  const { channel, handled, sends } = makeChannel();
  const result = await channel.handleUpdate(update(555, "hello"));
  assert.equal(result.ignored, true);
  assert.equal(result.reason, "not-allowlisted");
  assert.equal(handled.length, 0);
  assert.equal(sends.length, 0);
});

test("a failed /pair gets no reply (unknown senders learn nothing)", async () => {
  const { channel, handled, sends } = makeChannel();
  const { code } = channel.pairing.generateCode();
  const wrong = code === "000000" ? "111111" : "000000";
  const r = await channel.handleUpdate(update(555, "/pair " + wrong));
  assert.equal(r.paired, false);
  assert.equal(sends.length, 0);
  assert.equal(handled.length, 0);
  assert.equal(channel.pairing.isAllowed("555"), false);
});

test("/pair with a valid code allowlists the chat, confirms, and opens the channel", async () => {
  const { channel, handled, sends } = makeChannel();
  const { code } = channel.pairing.generateCode();
  const r = await channel.handleUpdate(update(555, "/pair " + code));
  assert.equal(r.paired, true);
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /Paired/);
  assert.equal(channel.pairing.isAllowed("555"), true);
  // now a normal message flows to the agent and the reply is sent back
  const r2 = await channel.handleUpdate(update(555, "hello"));
  assert.equal(r2.reply, "agent reply");
  assert.equal(handled.length, 1);
  assert.equal(handled[0].channel, "telegram");
  assert.equal(handled[0].from, "555");
  assert.equal(sends.length, 2);
});

test("GET /channels/telegram/pairing-code is auth-gated and issues a 6-digit code", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-route-"));
  const prevToken = process.env.OPENAGI_AUTH_TOKEN;
  process.env.OPENAGI_AUTH_TOKEN = "test-token-abc";
  try {
    const runtime = createDurableRuntime({ dataDir });
    const app = createHostedInterface(runtime, {
      host: "127.0.0.1",
      port: 0,
      channelsDir: path.join(dataDir, "channels")
    });
    const { url } = await app.listen();
    const denied = await fetch(`${url}/channels/telegram/pairing-code`);
    assert.equal(denied.status, 401);
    const res = await fetch(`${url}/channels/telegram/pairing-code`, {
      headers: { authorization: "Bearer test-token-abc" }
    });
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.match(json.code, /^\d{6}$/);
    assert.ok(json.expiresAt);
    await app.close();
  } finally {
    if (prevToken === undefined) delete process.env.OPENAGI_AUTH_TOKEN;
    else process.env.OPENAGI_AUTH_TOKEN = prevToken;
  }
});
```

2. [ ] Run it and confirm the expected failures: `node --test test/telegram-channel-gate.test.js` — expect test 1 to fail on `assert.equal(result.ignored, true)` with expected `true`, actual `undefined` (handleUpdate currently forwards to the agent, so `result.ignored` is undefined), tests 2-3 to fail with `TypeError: Cannot read properties of undefined (reading 'generateCode')` (no `channel.pairing` yet), and test 4 to fail with `404 !== 200` (route not found; the 401 assertion already passes because the auth gate is global).

3. [ ] Wire pairing into `src/channels.js`. Three narrow edits plus one function replacement.

Edit 1 — add the import. Before (src/channels.js:4):
```js
import { resolveDataDir } from "./data-dir.js";
```
After:
```js
import { resolveDataDir } from "./data-dir.js";
import { TelegramPairing } from "./telegram-pairing.js";
```

Edit 2 — construct the pairing machine. Before (src/channels.js:106, inside the `TelegramChannel` constructor):
```js
    this.state = readJsonFile(this.statePath, { offset: 0 });
  }
```
After:
```js
    this.state = readJsonFile(this.statePath, { offset: 0 });
    // Pairing security: only chats that completed "/pair <code>" may talk to
    // the agent or receive outreach. Injectable for tests.
    this.pairing = options.pairing ?? new TelegramPairing({ dir: this.dir });
  }
```

Edit 3 — surface pairing in status. Before (src/channels.js:109-115):
```js
  status() {
    return {
      configured: Boolean(this.token),
      polling: Boolean(this.pollTimer),
      offset: this.state.offset ?? 0
    };
  }
```
After:
```js
  status() {
    return {
      configured: Boolean(this.token),
      polling: Boolean(this.pollTimer),
      offset: this.state.offset ?? 0,
      pairing: this.pairing.status()
    };
  }
```

Edit 4 — replace `handleUpdate` in full. Before (src/channels.js:117-142):
```js
  async handleUpdate(update) {
    appendJsonLine(this.eventsPath, { at: nowIso(), update });
    const message = update.message ?? update.edited_message;
    const text = message?.text ?? message?.caption;
    const chatId = message?.chat?.id;
    if (!text || !chatId) return { ignored: true };

    const result = await this.agentHost.handleMessage({
      channel: "telegram",
      from: String(chatId),
      agentId: "main",
      text,
      metadata: {
        updateId: update.update_id,
        telegramMessageId: message.message_id,
        username: message.from?.username,
        firstName: message.from?.first_name
      }
    });

    if (this.token) {
      await this.sendMessage(chatId, result.reply);
    }

    return result;
  }
```
After:
```js
  async handleUpdate(update) {
    appendJsonLine(this.eventsPath, { at: nowIso(), update });
    const message = update.message ?? update.edited_message;
    const text = message?.text ?? message?.caption;
    const chatId = message?.chat?.id;
    if (!text || !chatId) return { ignored: true };

    // Pairing handshake: "/pair 123456" from any chat. On success the chat id
    // is persisted to allowlist.json and confirmed; failures are logged but
    // NEVER replied to, so a probing stranger learns nothing.
    const pairMatch = /^\/pair\s+(\d{6})\s*$/.exec(text.trim());
    if (pairMatch) {
      const outcome = this.pairing.attempt(String(chatId), pairMatch[1]);
      appendJsonLine(this.eventsPath, {
        at: nowIso(),
        op: "pair-attempt",
        chatId: String(chatId),
        ok: outcome.ok,
        reason: outcome.reason ?? null
      });
      if (outcome.ok && this.token) {
        await this.sendMessage(chatId, "Paired. This chat now receives OpenAGI messages.");
      }
      return { paired: outcome.ok, reason: outcome.reason ?? null };
    }

    // Allowlist gate: every non-/pair message from an unpaired chat is
    // dropped silently — no agent turn, no reply (replying would confirm the
    // bot is live to whoever found it).
    if (!this.pairing.isAllowed(String(chatId))) {
      appendJsonLine(this.eventsPath, { at: nowIso(), op: "ignored-unpaired", chatId: String(chatId) });
      return { ignored: true, reason: "not-allowlisted" };
    }

    const result = await this.agentHost.handleMessage({
      channel: "telegram",
      from: String(chatId),
      agentId: "main",
      text,
      metadata: {
        updateId: update.update_id,
        telegramMessageId: message.message_id,
        username: message.from?.username,
        firstName: message.from?.first_name
      }
    });

    if (this.token) {
      await this.sendMessage(chatId, result.reply);
    }

    return result;
  }
```

4. [ ] Add the pairing-code route to `src/hosted-interface.js`. This route must NOT be added to `isPublicRoute` in src/auth.js — that is what makes it auth-gated (the global `checkAuth` gate at src/hosted-interface.js:152-170 covers every non-public path). Before (src/hosted-interface.js:291):
```js
      if (method === "GET" && pathname === "/tools") return sendJson(res, 200, runtime.tools.list());
```
After:
```js
      if (method === "GET" && pathname === "/channels/telegram/pairing-code") {
        // Auth-gated like every non-public route (isPublicRoute does not list
        // it, so the global checkAuth gate above already ran). Issues a fresh
        // one-time code and prints it to the daemon log too, so a headless
        // install can pair straight from daemon.log/journald.
        if (!channels?.telegram?.pairing) return sendJson(res, 503, { error: "agent-host-disabled" });
        const issued = channels.telegram.pairing.generateCode();
        console.log(`[openagi] telegram pairing code ${issued.code} (valid 10 min, single use) — send "/pair ${issued.code}" to the bot`);
        return sendJson(res, 200, issued);
      }
      if (method === "GET" && pathname === "/tools") return sendJson(res, 200, runtime.tools.list());
```

5. [ ] Run the new tests: `node --test test/telegram-channel-gate.test.js` — expect `# pass 4`, `# fail 0`.
6. [ ] Run the full suite: `npm test` — expect `# fail 0`, exit code 0. (Existing suites never call `handleUpdate`/`handleTelegramWebhook` — verified by grep — so the new gate cannot regress them; `test/ephemeral-turn.test.js` uses `handleLocalMessage`, which is untouched.)
7. [ ] Commit: `git add src/channels.js src/hosted-interface.js test/telegram-channel-gate.test.js && git commit -m "feat(telegram): allowlist gate on incoming chats, /pair handshake, auth-gated pairing-code endpoint"`

---

### Task E2c: Route the outreach digest to Telegram (destination telegram/both) with mac-only fallback
**Week:** 5 · **Size:** M · **Depends on:** E2a, E2b
**User story:** As Spencer, I want the outreach digest delivered to my paired Telegram chats when I set destination to telegram or both, so that proactive outreach reaches my phone instead of dying when the laptop lid closes.
**Why (evidence):** wf-advantages.md "channel-breadth" (confirmed): "Proactive outreach is delivered only through the hosted interface's /outreach feed + SSE consumed by the Mac app ... never through messaging channels", and "Mac-notification-only outreach dies the moment the laptop lid closes." Today `runOutreachDigest` (src/abi-runtime.js:748-752) only appends a digest item to the store; the config's `destination: "mac"` field (src/outreach-config.js:8) is dead — nothing reads it.
**Acceptance criteria:**
- `node --test test/outreach-config.test.js` passes: file sets `destination`, `OPENAGI_OUTREACH_DESTINATION` env overrides it, invalid values fall back to `"mac"`.
- `node --test test/outreach-digest-telegram.test.js` passes: destination `telegram` and `both` send the digest text to every allowlisted chat via a stubbed channel; destination `mac` never touches telegram; missing token or empty allowlist falls back to mac-only with exactly one logged warning; one failed send does not stop the others; the runtime-level integration test shows `runOutreachDigest` driving the whole path from an `outreach.json` file.
- `node --test test/outreach-endpoints.test.js` passes, including the new assertion that `GET /outreach/config` reports `destination`.
- `npm test` passes with no regressions.
**Files:**
- Modify: src/outreach-config.js:28-30 (env override block)
- Modify: src/outreach-digest.js:24 (append deliverDigest at end of file)
- Modify: src/abi-runtime.js:50 (import), src/abi-runtime.js:748-752 (runOutreachDigest)
- Modify: src/hosted-interface.js:668-673 (GET /outreach/config)
- Test: test/outreach-digest-telegram.test.js (new), test/outreach-config.test.js (append one test), test/outreach-endpoints.test.js (append one test)
**Interfaces:**
- Consumes:
  - `export function composeDigest(store, config, { now = new Date() } = {})` (src/outreach-digest.js:6) — returns the appended digest item `{ id, type: "digest", title, summary, ... }` or `null`
  - `export function normalizeOutreachConfig(fileCfg = {}, env = process.env)` (src/outreach-config.js:23) and `OUTREACH_DEFAULTS.destination === "mac"` (src/outreach-config.js:8)
  - `async sendMessage(chatId, text)` on `TelegramChannel` (src/channels.js:144) and `pairing.allowlist()` / `this.token` from E2a/E2b
  - `this.channels` on the runtime — assigned by `ChannelManager`'s constructor (`if (this.runtime) this.runtime.channels = this;`, src/channels.js:25) when `createHostedInterface` builds it
  - The cron dispatcher already awaits handlers (`return this.cron.runDue(async (job) => { ... })`, src/abi-runtime.js:605), so making `runOutreachDigest` async is safe; its only caller is src/abi-runtime.js:729.
- Produces:
  - `export async function deliverDigest(item, { destination = "mac", telegram = null, log = (m) => console.warn(m) } = {})` in src/outreach-digest.js → returns `{ destination, telegram: { attempted: false } }` for mac; `{ destination, telegram: { attempted: false, fallback: "mac", reason } }` on fallback; `{ destination, telegram: { attempted: true, sent: string[], failed: [{ chatId, error }] } }` after sending
  - `runOutreachDigest` becomes `async` and returns `{ ok: true, digestId, title, delivery }` (or `{ ok: true, empty: true }` / `{ skipped: true, reason }` as before)
  - `normalizeOutreachConfig` result gains a validated `destination` ("mac" | "telegram" | "both"), env-overridable via `OPENAGI_OUTREACH_DESTINATION`
  - `GET /outreach/config` response gains `destination`

Steps:

1. [ ] Append this test to the end of `test/outreach-config.test.js` (after the existing last test, which ends at line 37):

```js
test("destination: file sets it, env overrides, invalid values fall back to mac", () => {
  assert.equal(normalizeOutreachConfig({ destination: "telegram" }, {}).destination, "telegram");
  assert.equal(
    normalizeOutreachConfig({ destination: "telegram" }, { OPENAGI_OUTREACH_DESTINATION: "both" }).destination,
    "both"
  );
  assert.equal(normalizeOutreachConfig({ destination: "carrier-pigeon" }, {}).destination, "mac");
  assert.equal(normalizeOutreachConfig({}, { OPENAGI_OUTREACH_DESTINATION: "nope" }).destination, "mac");
});
```

2. [ ] Run it: `node --test test/outreach-config.test.js` — expect the new test to fail on the second assertion with `Expected values to be strictly equal: 'telegram' !== 'both'` (env override not implemented yet; the fourth assertion would also fail: `'carrier-pigeon' !== 'mac'`).

3. [ ] Implement the config change. In `src/outreach-config.js`, before (lines 28-30):
```js
  const stalled = Number(env.OPENAGI_OUTREACH_STALLED_DAYS);
  if (Number.isFinite(stalled) && stalled > 0) merged.stalledDays = stalled;
  if (env.OPENAGI_OUTREACH_DISABLED === "1") merged.enabled = false;
```
After:
```js
  const stalled = Number(env.OPENAGI_OUTREACH_STALLED_DAYS);
  if (Number.isFinite(stalled) && stalled > 0) merged.stalledDays = stalled;
  if (env.OPENAGI_OUTREACH_DISABLED === "1") merged.enabled = false;
  // Digest destination: where the outreach digest is delivered. "mac" keeps
  // the status quo (store + Mac app SSE); "telegram" also pushes to every
  // paired chat; "both" does both. Anything else falls back to "mac".
  const dest = env.OPENAGI_OUTREACH_DESTINATION;
  if (dest === "mac" || dest === "telegram" || dest === "both") merged.destination = dest;
  if (!["mac", "telegram", "both"].includes(merged.destination)) merged.destination = "mac";
```

4. [ ] Run it: `node --test test/outreach-config.test.js` — expect `# pass 5`, `# fail 0`.

5. [ ] Write the failing delivery tests. Create `test/outreach-digest-telegram.test.js` with exactly this content:

```js
// test/outreach-digest-telegram.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { deliverDigest } from "../src/outreach-digest.js";
import { createDurableRuntime } from "../src/index.js";

function stubTelegram({ chats = ["111", "222"], failFor = [] } = {}) {
  const sent = [];
  return {
    sent,
    token: "123:ABC",
    pairing: { allowlist: () => chats },
    async sendMessage(chatId, text) {
      if (failFor.includes(chatId)) throw new Error("boom");
      sent.push({ chatId, text });
      return { ok: true };
    }
  };
}

const item = { id: "out_1", title: "Your queue: 2 drafts", summary: "• d1\n• d2" };

test("destination telegram sends the digest to every allowlisted chat", async () => {
  const tg = stubTelegram();
  const result = await deliverDigest(item, { destination: "telegram", telegram: tg, log: () => {} });
  assert.deepEqual(tg.sent.map((s) => s.chatId), ["111", "222"]);
  assert.match(tg.sent[0].text, /Your queue: 2 drafts/);
  assert.match(tg.sent[0].text, /• d1/);
  assert.equal(result.telegram.attempted, true);
  assert.deepEqual(result.telegram.sent, ["111", "222"]);
});

test("destination both also sends via telegram", async () => {
  const tg = stubTelegram();
  const result = await deliverDigest(item, { destination: "both", telegram: tg, log: () => {} });
  assert.equal(result.telegram.attempted, true);
  assert.equal(tg.sent.length, 2);
});

test("destination mac never touches telegram", async () => {
  const tg = stubTelegram();
  const result = await deliverDigest(item, { destination: "mac", telegram: tg, log: () => {} });
  assert.equal(tg.sent.length, 0);
  assert.equal(result.telegram.attempted, false);
});

test("falls back to mac-only with a warning when TELEGRAM_BOT_TOKEN is unset", async () => {
  const warnings = [];
  const result = await deliverDigest(item, {
    destination: "telegram",
    telegram: { token: undefined },
    log: (m) => warnings.push(m)
  });
  assert.equal(result.telegram.attempted, false);
  assert.equal(result.telegram.fallback, "mac");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /TELEGRAM_BOT_TOKEN/);
});

test("falls back to mac-only with a warning when no telegram channel exists at all", async () => {
  const warnings = [];
  const result = await deliverDigest(item, { destination: "telegram", telegram: null, log: (m) => warnings.push(m) });
  assert.equal(result.telegram.attempted, false);
  assert.equal(warnings.length, 1);
});

test("falls back to mac-only with a warning when the allowlist is empty", async () => {
  const warnings = [];
  const tg = stubTelegram({ chats: [] });
  const result = await deliverDigest(item, { destination: "telegram", telegram: tg, log: (m) => warnings.push(m) });
  assert.equal(result.telegram.attempted, false);
  assert.equal(result.telegram.fallback, "mac");
  assert.match(warnings[0], /allowlist/);
});

test("a failed send to one chat does not stop the others", async () => {
  const tg = stubTelegram({ chats: ["111", "222"], failFor: ["111"] });
  const warnings = [];
  const result = await deliverDigest(item, { destination: "telegram", telegram: tg, log: (m) => warnings.push(m) });
  assert.deepEqual(result.telegram.sent, ["222"]);
  assert.equal(result.telegram.failed.length, 1);
  assert.equal(result.telegram.failed[0].chatId, "111");
});

test("runOutreachDigest routes to telegram end-to-end from outreach.json destination", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "out-tg-"));
  fs.writeFileSync(path.join(dataDir, "outreach.json"), JSON.stringify({ destination: "telegram" }));
  const runtime = createDurableRuntime({ dataDir });
  runtime.outreach.append({ type: "draft", title: "d1" });
  const tg = stubTelegram({ chats: ["999"] });
  runtime.channels = { telegram: tg };
  const result = await runtime.runOutreachDigest({ now: new Date("2026-07-06T12:00:00") });
  assert.equal(result.ok, true);
  assert.ok(result.digestId);
  assert.deepEqual(result.delivery.telegram.sent, ["999"]);
  assert.match(tg.sent[0].text, /1 draft/);
});
```

6. [ ] Run it and confirm the expected failure: `node --test test/outreach-digest-telegram.test.js` — expect the file to fail to load with `SyntaxError: The requested module '../src/outreach-digest.js' does not provide an export named 'deliverDigest'`.

7. [ ] Implement `deliverDigest`. Append to the end of `src/outreach-digest.js` (after the closing `}` of `composeDigest`, line 24):

```js

// Deliver a composed digest according to the configured destination.
// "mac" is a no-op here: the digest item is already in the outreach store,
// which the Mac app consumes over /outreach/feed + SSE. "telegram"/"both"
// additionally push the digest text to every allowlisted chat. When telegram
// is not ready (no token, no channel, or nothing paired) we fall back to
// mac-only and emit exactly one warning via log().
export async function deliverDigest(item, { destination = "mac", telegram = null, log = (m) => console.warn(m) } = {}) {
  const wantsTelegram = destination === "telegram" || destination === "both";
  if (!wantsTelegram) return { destination, telegram: { attempted: false } };

  const configured = Boolean(telegram?.token);
  const chats = configured ? (telegram.pairing?.allowlist?.() ?? []) : [];
  if (!configured || chats.length === 0) {
    const reason = configured
      ? "telegram allowlist is empty (pair a chat first)"
      : "TELEGRAM_BOT_TOKEN is unset";
    log(`[openagi] outreach digest destination "${destination}" fell back to mac-only: ${reason}`);
    return { destination, telegram: { attempted: false, fallback: "mac", reason } };
  }

  const text = `${item.title}\n\n${item.summary}`;
  const sent = [];
  const failed = [];
  for (const chatId of chats) {
    try {
      await telegram.sendMessage(chatId, text);
      sent.push(chatId);
    } catch (error) {
      failed.push({ chatId, error: error.message });
      log(`[openagi] outreach digest telegram send to chat ${chatId} failed: ${error.message}`);
    }
  }
  return { destination, telegram: { attempted: true, sent, failed } };
}
```

8. [ ] Wire it into the runtime. In `src/abi-runtime.js`, before (line 50):
```js
import { composeDigest } from "./outreach-digest.js";
```
After:
```js
import { composeDigest, deliverDigest } from "./outreach-digest.js";
```
And replace `runOutreachDigest` in full. Before (src/abi-runtime.js:748-752):
```js
  runOutreachDigest({ now = new Date() } = {}) {
    if (!this.outreachConfig?.enabled) return { skipped: true, reason: "outreach disabled" };
    const item = composeDigest(this.outreach, this.outreachConfig, { now });
    return item ? { ok: true, digestId: item.id, title: item.title } : { ok: true, empty: true };
  }
```
After:
```js
  async runOutreachDigest({ now = new Date() } = {}) {
    if (!this.outreachConfig?.enabled) return { skipped: true, reason: "outreach disabled" };
    const item = composeDigest(this.outreach, this.outreachConfig, { now });
    if (!item) return { ok: true, empty: true };
    // Destination routing: "mac" keeps the status quo (the item is already in
    // the outreach store, which the Mac app consumes); "telegram"/"both" also
    // push the digest text to every allowlisted chat, falling back to
    // mac-only with a logged warning when telegram isn't ready. this.channels
    // is assigned by ChannelManager's constructor (src/channels.js) when the
    // hosted interface builds it.
    const delivery = await deliverDigest(item, {
      destination: this.outreachConfig.destination,
      telegram: this.channels?.telegram ?? null
    });
    return { ok: true, digestId: item.id, title: item.title, delivery };
  }
```

9. [ ] Run the delivery tests: `node --test test/outreach-digest-telegram.test.js` — expect `# pass 8`, `# fail 0`.

10. [ ] Expose `destination` in the config endpoint (TDD). Append this test to the end of `test/outreach-endpoints.test.js` (after the last test, line 118):

```js

test("GET /outreach/config includes the destination", async () => {
  const { app, base } = await bootApp();
  const res = await fetch(`${base}/outreach/config`);
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.destination, "mac");
  await app.close?.();
});
```
Run `node --test test/outreach-endpoints.test.js` — expect the new test to fail with `Expected values to be strictly equal: undefined !== 'mac'`. Then in `src/hosted-interface.js`, before (lines 668-673):
```js
      if (method === "GET" && pathname === "/outreach/config") {
        const c = runtime.outreachConfig;
        return sendJson(res, 200, c
          ? { enabled: c.enabled, cadenceHours: c.cadenceHours, quietHours: c.quietHours, stalledDays: c.stalledDays }
          : { enabled: false });
      }
```
After:
```js
      if (method === "GET" && pathname === "/outreach/config") {
        const c = runtime.outreachConfig;
        return sendJson(res, 200, c
          ? { enabled: c.enabled, destination: c.destination, cadenceHours: c.cadenceHours, quietHours: c.quietHours, stalledDays: c.stalledDays }
          : { enabled: false });
      }
```
Re-run `node --test test/outreach-endpoints.test.js` — expect `# fail 0`.

11. [ ] Run the full suite: `npm test` — expect `# fail 0`, exit code 0. (Note: the only caller of `runOutreachDigest` is the cron dispatcher at src/abi-runtime.js:729 inside an async `runDue` handler, so the sync-to-async change is safe; existing tests never call it directly — verified by grep.)
12. [ ] Commit: `git add src/outreach-config.js src/outreach-digest.js src/abi-runtime.js src/hosted-interface.js test/outreach-digest-telegram.test.js test/outreach-config.test.js test/outreach-endpoints.test.js && git commit -m "feat(outreach): route digest to telegram destination (telegram/both) with mac-only fallback and warning"`

---

### Task E2d: Manual end-to-end verification — pair a real phone and receive a real digest
**Week:** 5 · **Size:** S · **Depends on:** E2b, E2c
**User story:** As Spencer, I want to prove the whole chain on my actual phone — bot created, chat paired, stranger ignored, digest delivered — so that outreach off the Mac is verified working, not just unit-tested.
**Why (evidence):** wf-advantages.md "channel-breadth": on the live install "no TELEGRAM_*/TWILIO_* env keys" exist and "the channels store is effectively dormant". Unit tests stub the network; only a live run proves the Telegram API calls, the webhook/polling ingest, and the cadence cron actually deliver.
**Acceptance criteria:** Every checkbox below observed by the human operator (this task changes no code; it may add env/config values to the live `~/.openagi/.env` and `~/.openagi/outreach.json`). Steps only ever check live-data **counts and key names**, never content.

Manual checklist (performed by the user; the executor's job is to present this list and the exact commands, not to run the daemon):

1. [ ] **Create the bot.** In Telegram, message @BotFather → `/newbot` → pick a name and a unique username ending in `bot`. Copy the HTTP API token BotFather prints (format `123456789:AA...`).
2. [ ] **Configure env.** Add to `~/.openagi/.env` (do not overwrite other keys — append two lines):
   `TELEGRAM_BOT_TOKEN=<token from BotFather>`
   `TELEGRAM_POLLING=1`
   (Polling avoids needing a public webhook URL; `ChannelManager.start()` starts polling when `TELEGRAM_POLLING=1`, src/channels.js:78-82.)
3. [ ] **Restart the daemon** the way this install normally runs it (Mac app DaemonController restart, or the user's own `openagi serve` invocation). Verify channel status: `curl -s -H "Authorization: Bearer $OPENAGI_AUTH_TOKEN" http://127.0.0.1:43210/channels | jq '.telegram'` → expect `"configured": true, "polling": true` and a `pairing` object with `"pairedChats": 0`.
4. [ ] **Get a pairing code.** `curl -s -H "Authorization: Bearer $OPENAGI_AUTH_TOKEN" http://127.0.0.1:43210/channels/telegram/pairing-code | jq .` → expect `{ "code": "NNNNNN", "expiresAt": ... }`. The same code also appears in the daemon log as `[openagi] telegram pairing code NNNNNN ...`.
5. [ ] **Negative check first (unpaired = silence).** From the phone, open the bot chat, tap Start, send `hello`. Expect NO reply. Verify the drop was recorded by count only: `grep -c ignored-unpaired ~/.openagi/channels/telegram/events.jsonl` → a number ≥ 1.
6. [ ] **Pair.** Within 10 minutes of step 4, send `/pair NNNNNN` from the phone. Expect the reply `Paired. This chat now receives OpenAGI messages.` Verify by keys/counts only: `jq '.chats | length' ~/.openagi/channels/telegram/allowlist.json` → `1`.
7. [ ] **Chat flows.** Send `What can you do?` from the phone → expect a real agent reply in Telegram.
8. [ ] **Lockout sanity (optional).** From a second Telegram account, send `/pair 000000` six times → every attempt is silent; the paired chat still works.
9. [ ] **Point the digest at Telegram.** Create or edit `~/.openagi/outreach.json` so it contains `{ "destination": "telegram" }` (or `"both"` to keep Mac notifications too). Temporarily speed up the cadence: add `OPENAGI_OUTREACH_CADENCE_HOURS=0.25` to `~/.openagi/.env`, then remove the persisted digest job so it is re-registered with the new interval on next boot: `curl -s -X DELETE -H "Authorization: Bearer $OPENAGI_AUTH_TOKEN" http://127.0.0.1:43210/cron/outreach-digest`, then restart the daemon. (`FileBackedCronScheduler.addJob` keeps an existing job unless deleted, src/cron-scheduler.js:10-11, so the delete + restart is required for the interval change to take.)
10. [ ] **Seed digestible content.** In the dashboard chat (http://127.0.0.1:43210), ask the agent to draft something (e.g. "Draft a short reply to the last BuildBetter thread — do not send it"). A `draft` lands in the outreach feed via the mapper; drafts are a digest type (`digestTypes: ["draft", "suggestion"]`, src/outreach-config.js:13).
11. [ ] **Receive the digest.** Outside quiet hours (default 22:00-08:00), within ~15 minutes expect a Telegram message starting `Your queue: ...` listing the draft. If instead the daemon log shows `[openagi] outreach digest ... fell back to mac-only: ...`, the reason string says exactly what to fix (token unset or allowlist empty).
12. [ ] **Lid-closed proof.** Quit the Mac app (daemon must keep running — if the daemon runs on the remote Distiller main, this is automatic), repeat steps 10-11: the digest still arrives on the phone.
13. [ ] **Restore cadence.** Remove `OPENAGI_OUTREACH_CADENCE_HOURS=0.25` from `~/.openagi/.env`, `curl -s -X DELETE -H "Authorization: Bearer $OPENAGI_AUTH_TOKEN" http://127.0.0.1:43210/cron/outreach-digest`, restart the daemon (the default 3h job re-registers itself, src/abi-runtime.js:420-426). Keep `destination` as preferred.

---

<!-- verified:E3 status=fixed:4 -->
### Task E3: Put replay_skill behind the confirmation gate

**Week:** 5 · **Size:** M · **Depends on:** none
**User story:** As Spencer (the openAGI owner), I want any `replay_skill` invocation (AppleScript/keyboard control of my Mac) to require my explicit approval before it executes, so that a prompt-injected or mistaken agent turn can never drive my machine without me clicking Approve.
**Why (evidence):** The Hermes "injection-hardening" comparison (docs/superpowers/plans/2026-07-05-openagi-gap-remediation/evidence/hermes-advantages.md) verified that openAGI's confirmation gate is real and code-enforced — `needsConfirmation` tools are intercepted at src/tool-registry.js:157 and diverted into the file-backed `PendingActionStore`, and scrutiny verdicts gate `sideEffects` tools at src/agent-host.js:87-100 — but `replay_skill` (src/tool-registry.js:453-469) declares neither flag. Nuance verified by reading the code: `sideEffects` defaults to **true** when unspecified (src/tool-registry.js:31), so `replay_skill` is already blocked on `watch`/`ask` verdict turns; the enforced escape is on ordinary `act` verdict turns (the common case), where only `needsConfirmation` gates a tool — and `replay_skill` lacks it. Additionally, the pending-actions store has never held a live item, so this task also proves the full invoke → persist → approve → execute round-trip with an integration test.
**Acceptance criteria:**
- `node --test test/replay-skill-gate.test.js` passes (3 tests) after the change and fails before it.
- `runtime.tools.get("replay_skill").needsConfirmation === true` and `.sideEffects === true` on a default runtime.
- Invoking `replay_skill` without `__confirmed` returns `{status: "awaiting_confirmation"}`, writes an `enqueue` line to `<dataDir>/pending-actions/journal.jsonl`, and does NOT call `runtime.skillReplay.run`.
- `POST /pending-actions/:id/approve` on that action executes the (stubbed) replayer exactly once and persists `status: "approved"` plus the handler result on the action record; `POST /pending-actions/:id/deny` never executes it.
- `npm test` passes with no regressions.
- `docs/superpowers/plans/2026-07-05-openagi-gap-remediation/tool-gate-audit.md` exists, listing every registered tool whose handler writes/sends but lacks explicit gate flags — with zero code changes beyond `replay_skill`.
**Files:**
- Modify: src/tool-registry.js:453 (the `replay_skill` registration inside `registerCoreTools`)
- Test: test/replay-skill-gate.test.js (create)
- Create: docs/superpowers/plans/2026-07-05-openagi-gap-remediation/tool-gate-audit.md (report only)
**Interfaces:**
- Consumes (existing, verified in source — do not change any of these):
  - `ToolRegistry.register(tool)` normalization: `needsConfirmation: Boolean(tool.needsConfirmation)`, `sideEffects: tool.sideEffects !== false`, `summarize: typeof tool.summarize === "function" ? tool.summarize : null` (src/tool-registry.js:12-33)
  - `ToolRegistry.invoke(name, args, context = {})` confirmation gate: `if ((tool.needsConfirmation || scrutinyConfirm) && !context?.__confirmed && this.pendingActions)` → `this.pendingActions.enqueue({ toolName, args, context, summary, reason })` → returns `{ ok: true, result: { status: "awaiting_confirmation", actionId, summary, message } }` (src/tool-registry.js:156-175)
  - `PendingActionStore` — `enqueue(...)`, `decide(id, { decision, decidedBy, result, error })`, `get(id)`, `list({ status })`; JSONL journal at `<dir>/journal.jsonl` (src/pending-actions.js:33-82)
  - `POST /pending-actions/:id/approve` — re-invokes `runtime.tools.invoke(action.toolName, action.args, { ...action.context, __confirmed: true })` then `runtime.pendingActions.decide(...)` (src/hosted-interface.js:703-721); `POST /pending-actions/:id/deny` (src/hosted-interface.js:722-734); `GET /pending-actions?status=pending` (src/hosted-interface.js:653-658)
  - `SkillReplay.run({ skill, steps, dryRun = false, confirm = "first-run", timeoutMs })` — the real replayer the tool handler calls via `runtime.skillReplay.run({ skill: args.name, dryRun: args.dryRun ?? false })` (src/skill-replay.js:58, src/tool-registry.js:465-468); the test stubs this by assigning `runtime.skillReplay = { run: async (...) => ... }` **after** `createHostedInterface` (the tool handler reads `runtime.skillReplay` at call time, and the real one must exist at boot because hosted-interface.js:72 calls `runtime.skillReplay.bindEvents(events)` on whatever is present then — a bare stub there would crash boot)
  - `createDurableRuntime({ dataDir })` and `createHostedInterface(runtime, { host, port: 0 })` with `await app.listen()` → `{ host, port, url }` and `await app.close()` (src/index.js:1,47; src/hosted-interface.js:1402-1430) — same harness as test/outreach-endpoints.test.js:9-17
  - outreach-mapper's existing `"pending-action"` MAP entry (src/outreach-mapper.js:23-30) turns the `pending-action` event emitted by `PendingActionStore.enqueue` (src/pending-actions.js:60-66) into a durable outreach item — no changes needed there; the test asserts the store side only.
- Produces: `replay_skill` tool registration now carries `needsConfirmation: true`, `sideEffects: true`, and a `summarize(args)` function returning a string beginning `Replay skill '<name>' on the Mac`. No other signature changes. Later tasks may rely on `replay_skill` calls returning `{status: "awaiting_confirmation", actionId}` on unconfirmed turns.

**Steps**

1. [ ] Write the failing test. Create `test/replay-skill-gate.test.js` with exactly this content:

```js
// test/replay-skill-gate.test.js
// E3: replay_skill (AppleScript/keyboard control of the Mac) must sit behind
// the pending-actions confirmation gate, and the gate must round-trip:
// invoke -> pending action persisted -> approve via endpoint -> handler runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

function makeRuntime() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-gate-"));
  process.env.OPENAGI_AUTH_TOKEN = ""; // local, no auth for the test
  const runtime = createDurableRuntime({ dataDir });
  return { runtime, dataDir };
}

async function bootApp() {
  const { runtime, dataDir } = makeRuntime();
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0 });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  // Stub the Mac-side replayer AFTER boot (the real one must exist at boot
  // for bindEvents); the tool handler reads runtime.skillReplay at call time.
  const replayCalls = [];
  runtime.skillReplay = {
    run: async ({ skill, dryRun }) => {
      replayCalls.push({ skill, dryRun });
      return { jobId: "rep_test", skill, dryRun: Boolean(dryRun), status: "completed" };
    }
  };
  return { runtime, app, base, dataDir, replayCalls };
}

test("replay_skill is registered with needsConfirmation, sideEffects, and a summarize fn", () => {
  const { runtime } = makeRuntime();
  const tool = runtime.tools.get("replay_skill");
  assert.ok(tool, "replay_skill must be registered");
  assert.equal(tool.needsConfirmation, true, "replay_skill must be confirmation-gated");
  assert.equal(tool.sideEffects, true, "replay_skill controls the Mac - side-effecting");
  assert.equal(typeof tool.summarize, "function", "approval cards need a human summary");
  assert.match(tool.summarize({ name: "morning-brief" }), /Replay skill 'morning-brief' on the Mac/);
});

test("gated replay_skill round-trips: invoke -> persisted pending action -> approve endpoint -> stub executes -> result recorded", async () => {
  const { runtime, app, base, dataDir, replayCalls } = await bootApp();

  const diverted = await runtime.tools.invoke(
    "replay_skill",
    { name: "morning-brief" },
    { sessionId: "s1", agentId: "main", channel: "local" }
  );
  assert.equal(diverted.ok, true);
  assert.equal(diverted.result.status, "awaiting_confirmation", "call must divert, not run");
  assert.equal(replayCalls.length, 0, "handler must NOT run before approval");
  const actionId = diverted.result.actionId;

  // Durably persisted (JSONL journal), not just in memory.
  const journal = fs.readFileSync(path.join(dataDir, "pending-actions", "journal.jsonl"), "utf8");
  assert.match(journal, new RegExp(actionId), "enqueue must be journaled to disk");

  // Visible on the existing pending list endpoint.
  const listJson = await (await fetch(`${base}/pending-actions?status=pending`)).json();
  assert.ok(
    listJson.actions.some((a) => a.id === actionId && a.toolName === "replay_skill"),
    "pending action must be listed"
  );

  // Approve via the existing endpoint -> handler executes exactly once.
  const approveRes = await fetch(`${base}/pending-actions/${actionId}/approve`, { method: "POST" });
  const approveJson = await approveRes.json();
  assert.equal(approveRes.status, 200);
  assert.equal(approveJson.ok, true);
  assert.deepEqual(replayCalls, [{ skill: "morning-brief", dryRun: false }], "stubbed replayer runs once on approve");

  // Outcome recorded on the action record.
  const action = runtime.pendingActions.get(actionId);
  assert.equal(action.status, "approved");
  assert.equal(action.result.jobId, "rep_test");
  assert.equal(action.error, null);

  // Journal now also carries the decide entry.
  const journalAfter = fs.readFileSync(path.join(dataDir, "pending-actions", "journal.jsonl"), "utf8");
  assert.match(journalAfter, /"op":"decide"/);
  await app.close?.();
});

test("denied replay_skill never executes", async () => {
  const { runtime, app, base, replayCalls } = await bootApp();
  const diverted = await runtime.tools.invoke("replay_skill", { name: "morning-brief" }, { channel: "local" });
  assert.equal(diverted.result.status, "awaiting_confirmation");
  const denyRes = await fetch(`${base}/pending-actions/${diverted.result.actionId}/deny`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "not now" })
  });
  assert.equal(denyRes.status, 200);
  assert.equal(replayCalls.length, 0, "denied action must never run the handler");
  assert.equal(runtime.pendingActions.get(diverted.result.actionId).status, "denied");
  await app.close?.();
});
```

2. [ ] Run the new test and confirm it fails for the right reason:

```
cd /Users/you/Dev/openAGI && node --test test/replay-skill-gate.test.js
```

Expected failure: test 1 fails with `AssertionError` — `replay_skill must be confirmation-gated` (actual `false`, expected `true`); test 2 fails with `AssertionError` on `call must divert, not run` (actual `diverted.result.status` is `"completed"` from the stub, expected `"awaiting_confirmation"`). Test 3 fails similarly. If instead you see `Cannot find module`, fix the import path before proceeding — do not change assertions.

3. [ ] Minimal implementation. In `/Users/you/Dev/openAGI/src/tool-registry.js`, edit the `replay_skill` registration (currently at lines 453-455). Before (quote exactly — this is the real current code):

```js
  registry.register({
    name: "replay_skill",
    description: "Trigger a skill's structured replay steps (open_app, keyboard_shortcut, type, applescript, etc.) on the user's Mac. Use only for skills with a `replay:` block in their SKILL.md. Set dryRun:true to log actions without executing — recommended for first-time use.",
```

After:

```js
  registry.register({
    name: "replay_skill",
    // Drives the user's Mac (AppleScript / keyboard / app control) — always
    // route through the pending-actions approval queue, same as
    // register_mcp_server and restart_daemon. sideEffects is the default but
    // is declared explicitly so an audit of gate flags reads unambiguously.
    needsConfirmation: true,
    sideEffects: true,
    summarize: (args) =>
      `Replay skill '${args.name}' on the Mac${args.dryRun ? " (dry run — logs only)" : " (AppleScript/keyboard control)"}`,
    description: "Trigger a skill's structured replay steps (open_app, keyboard_shortcut, type, applescript, etc.) on the user's Mac. Use only for skills with a `replay:` block in their SKILL.md. Set dryRun:true to log actions without executing — recommended for first-time use. THIS REQUIRES USER APPROVAL — calls return {status:'awaiting_confirmation'} and run only after the user approves via the dashboard's Approvals tab.",
```

Do not touch the `parameters`, `handler`, or anything else in this registration, and do not touch any other tool in the file.

4. [ ] Run the new test again and confirm all three pass:

```
cd /Users/you/Dev/openAGI && node --test test/replay-skill-gate.test.js
```

Expected output ends with `# pass 3` / `# fail 0`.

5. [ ] Run the full suite and confirm no regressions:

```
cd /Users/you/Dev/openAGI && npm test
```

Expected: `# fail 0`. Pay attention to `test/verdict-consequences.test.js` and `test/tool-registry-cap.test.js` — both exercise `ToolRegistry` and must still pass (neither asserts anything about `replay_skill`'s flags, so they will).

6. [ ] Commit the gate change:

```
cd /Users/you/Dev/openAGI && git add src/tool-registry.js test/replay-skill-gate.test.js && git commit -m "fix(tools): gate replay_skill behind the pending-actions confirmation queue"
```

7. [ ] Audit-and-report step — **NO code changes in this step, report only.** Enumerate every registered tool whose handler performs writes/sends/executes but lacks explicit gate flags. Registration sites to cover (all of them):

```
cd /Users/you/Dev/openAGI && grep -n "registry.register({" src/tool-registry.js
grep -rn "\.register({" src/integrations/*.js
grep -rn "needsConfirmation" src/*.js src/integrations/*.js
grep -rn "sideEffects" src/*.js src/integrations/*.js
grep -rniE "send|deliver|write|create|save|schedule|applescript|osascript|exec|post|remove|delete|restart" src/tool-registry.js src/integrations/*.js
```

For each tool found, read its handler and classify: does it mutate state or send anything (memory writes, task/cron mutations, outbound messages, env/file writes, process control, external API calls)? Record whether `sideEffects` is explicit (`true`/`false`) or defaulted (absent → `true` per src/tool-registry.js:31), and whether `needsConfirmation` is set. Remember MCP tools (source `"mcp"`, registered by src/mcp-registry.js) all default to side-effecting with no confirmation — note that as a single row/class, do not enumerate individual MCP tools.

8. [ ] Write the report to `/Users/you/Dev/openAGI/docs/superpowers/plans/2026-07-05-openagi-gap-remediation/tool-gate-audit.md` with exactly this structure (fill the table from step 7's findings; the rows shown are known-correct seed examples — verify and keep them, then add the rest):

```markdown
# Tool confirmation-gate audit — 2026-07-05 (Task E3)

Scope: every tool registered in src/tool-registry.js and src/integrations/*.js
(plus MCP-sourced tools as a class). A tool is "gated" only if it sets
needsConfirmation: true (intercepted at src/tool-registry.js:157). sideEffects
defaults to TRUE when absent (src/tool-registry.js:31), so unflagged tools are
already blocked on watch/ask verdict turns — the exposure is act-verdict turns,
where only needsConfirmation gates execution.

This is a REPORT for Spencer to review. No flags were changed by this audit;
the only code change in Task E3 was replay_skill (now gated).

| Tool | Registered at | Writes/sends what | sideEffects | needsConfirmation | Suggested |
|---|---|---|---|---|---|
| replay_skill | src/tool-registry.js:453 | AppleScript/keyboard control of the Mac | true (explicit, E3) | true (E3) | done |
| send_message | src/tool-registry.js:352 | outbound SMS/Telegram/local delivery | true (default) | false | consider gating |
| restart_daemon | src/tool-registry.js:988 | kills the daemon process | true (default) | true | ok |
| register_mcp_server | src/tool-registry.js:522 | spawns arbitrary process / contacts arbitrary host | true (default) | true | ok |
| connect_catalog_mcp | src/tool-registry.js:930 | persists API keys to .env, registers MCP | true (default) | true | ok |
| ... (complete from the step-7 grep results) | | | | | |
| MCP tools (all, source "mcp") | src/mcp-registry.js | arbitrary per-server actions | true (default) | false | per-server policy (future task) |

## Notes
- <anything ambiguous you found, one bullet per item>
```

Do NOT add `needsConfirmation` or `sideEffects` to any tool other than `replay_skill`, do not "fix" anything the audit surfaces, and do not edit any file other than this report — findings are for Spencer to prioritize.

9. [ ] Commit the report:

```
cd /Users/you/Dev/openAGI && git add docs/superpowers/plans/2026-07-05-openagi-gap-remediation/tool-gate-audit.md && git commit -m "docs(security): tool confirmation-gate audit report for E3 review"
```
