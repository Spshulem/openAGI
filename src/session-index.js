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
import { chmodOwnerOnly, ensureDir } from "./file-utils.js";
import { nowIso } from "./utils.js";
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
    try {
      this.db = new sqlite.DatabaseSync(this.dbPath);
      // node:sqlite creates the file with the process umask (0644), and this
      // index holds every message of every session. Tighten it now rather than
      // waiting for the next boot's hardenDataDir() pass.
      chmodOwnerOnly(this.dbPath);
      // Transient lock contention (another process/test holding the same
      // file) must retry internally instead of throwing immediately.
      this.db.exec("PRAGMA busy_timeout = 5000;");
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
    } catch (error) {
      // init() must never reject: some callers (createDefaultRuntime with
      // agentHost:false) never attach a rejection handler to `ready`, so an
      // uncaught failure here becomes an unhandled rejection that permanently
      // disables session search. Degrade to the same JSONL fallback used
      // when node:sqlite itself is unavailable, rather than losing the
      // feature entirely over one transient open/exec failure.
      console.error(`[openagi] session-index: sqlite init failed (${error.message}), falling back to JSONL`);
      this.db = null;
      this.fallback = true;
    }
  }

  async indexMessage(sessionId, agentId, msg, { skipDedupe = false } = {}) {
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
    // skipDedupe (set only by rebuildFromTranscripts' fresh-index bulk walk)
    // is a deliberate escape hatch: that walk only ever runs against an
    // empty index, so no duplicate can exist within it, and the scan is
    // O(N) per call — O(N^2) across a full backfill. On a production
    // install with 100k+ historical messages this turned a bulk backfill
    // into many minutes of the HTTP server being completely unresponsive
    // (single-threaded Node has nothing to yield to once it's CPU-bound
    // inside one transaction). The live incremental path (agent-host's
    // per-turn indexMessage calls) keeps the dedup check.
    if (row.msgId && !skipDedupe) {
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
        .map((r) => ({ sessionId: r.sessionId, ts: r.ts, role: r.role, snippet: capSnippet(r.text) }));
    }
    // FTS5 query — split into terms and phrase-quote each one individually
    // (AND-of-terms), rather than quoting the whole query as one contiguous
    // phrase. A single wrapping quote would force an exact word-order match,
    // missing every message where the same words appear in different order
    // or with other words between them. Per-term quoting still neutralizes
    // any FTS5 special syntax (colons, NEAR, column filters) a token might
    // otherwise be interpreted as.
    const matchExpr = q.split(/\s+/).filter(Boolean)
      .map((term) => `"${term.replace(/"/g, '""')}"`)
      .join(" ");
    const rows = this.db.prepare(
      `SELECT session_id, ts, role, snippet(messages, 5, '<mark>', '</mark>', '…', 12) AS snippet
       FROM messages WHERE messages MATCH ?
       ORDER BY ts DESC LIMIT ?`
    ).all(matchExpr, limit);
    return rows.map((r) => ({ sessionId: r.session_id, ts: r.ts, role: r.role, snippet: capSnippet(r.snippet) }));
  }

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
    // Wrap the whole backfill in one transaction: indexMessage's per-message
    // INSERT auto-commits (fsyncs) individually otherwise, and a production
    // install with a large transcript history (tens of thousands of
    // messages) turned a first-boot backfill into one fsync per message —
    // minutes of downtime on slow storage instead of a couple of seconds.
    const inTransaction = !this.fallback && this.db;
    if (inTransaction) this.db.exec("BEGIN;");
    try {
      for (const meta of agentStore.listSessions()) {
        const session = agentStore.getSession(meta.id);
        if (!session?.messages?.length) continue;
        sessions += 1;
        for (const msg of session.messages) {
          const result = await this.indexMessage(session.id, msg.agentId ?? "main", msg, { skipDedupe: true });
          indexed += result.indexed ?? 0;
        }
      }
      if (inTransaction) this.db.exec("COMMIT;");
    } catch (error) {
      if (inTransaction) this.db.exec("ROLLBACK;");
      throw error;
    }
    return { sessions, indexed };
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
