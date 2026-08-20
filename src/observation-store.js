// Local store for ambient observations pushed from the Mac app: window/app
// activity events and OCR-extracted text from screen frames. We use SQLite
// with FTS5 because keyword overlap (the agent's normal recall) is a poor
// fit for searching tens of thousands of small chunks of OCR text per week.
//
// File-backed at <dataDir>/observations/index.db. Schema:
//   activity       — app focus + window title timeline
//   frames         — per-frame metadata (thumbnail lives on the Mac, we keep
//                    only a reference id + summary text)
//   texts(FTS5)    — searchable text for both frames and activity
//
// Retention: caller (autopilot job) prunes old rows by date. We don't enforce
// retention here — that's a privacy decision the user controls in the panel.

import path from "node:path";
import fs from "node:fs";
import { chmodOwnerOnly, ensureDir } from "./file-utils.js";
import { createId, nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

// Cap the `text` returned by search() for long-form transcript rows so a
// single hit can't dump an entire call transcript into a tool result. The
// FTS `snippet` already carries the match context; full text stays in the DB.
const TRANSCRIPT_SEARCH_TEXT_CAP = 1000;
const WINDOW_SEARCH_TEXT_CAP = 2000;
const WINDOW_SEARCH_LIMIT = 100;
const WINDOW_TEXT_KINDS = new Set(["activity", "frame"]);
const SEARCH_KINDS = new Set(["activity", "frame", "transcript"]);

function normalizeSearchKinds(kinds) {
  if (kinds === undefined || kinds === null) return null;
  const values = Array.isArray(kinds) ? kinds : String(kinds).split(",");
  return [...new Set(values
    .map((kind) => kind === "frame-summary" ? "frame" : String(kind ?? "").trim())
    .filter((kind) => SEARCH_KINDS.has(kind)))];
}

function capTranscriptText(row) {
  if (row && row.kind === "transcript" && typeof row.text === "string" && row.text.length > TRANSCRIPT_SEARCH_TEXT_CAP) {
    return { ...row, text: row.text.slice(0, TRANSCRIPT_SEARCH_TEXT_CAP) + "…" };
  }
  return row;
}

function capWindowText(row) {
  if (!row || typeof row.text !== "string" || row.text.length <= WINDOW_SEARCH_TEXT_CAP) return row;
  return { ...row, text: row.text.slice(0, WINDOW_SEARCH_TEXT_CAP) + "…" };
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

// The only options this store accepts. An unknown key is a typo, and a typo
// here is dangerous rather than merely wrong: the option that selects the
// directory is `dir`, so `new ObservationStore({ dataDir })` silently ignored
// the caller's isolation and fell through to resolveDataDir() — the LIVE
// install. That is not hypothetical; a script written to operate on a scratch
// copy deleted 132,334 rows from the real database because of exactly this.
// Fail loudly instead of quietly targeting the user's data.
const OBSERVATION_STORE_OPTIONS = new Set(["dir"]);

export class ObservationStore {
  constructor(options = {}) {
    const unknown = Object.keys(options).filter((k) => !OBSERVATION_STORE_OPTIONS.has(k));
    if (unknown.length > 0) {
      throw new TypeError(
        `ObservationStore: unknown option(s) ${unknown.join(", ")}. ` +
        `Did you mean "dir"? (accepted: ${[...OBSERVATION_STORE_OPTIONS].join(", ")}). ` +
        "An ignored directory option silently targets the live data dir."
      );
    }
    this.dir = options.dir ?? path.join(resolveDataDir(), "observations");
    this.dbPath = path.join(this.dir, "index.db");
    ensureDir(this.dir);
    this.db = null;
    this.fallback = null; // JSONL fallback when node:sqlite isn't available
    this.fallbackPath = path.join(this.dir, "observations.jsonl");
    this.ready = this.init();
  }

  async init() {
    const sqlite = await loadSqlite();
    if (!sqlite) {
      // node:sqlite is available in Node 22.5+. If it's missing we degrade to
      // a JSONL append log so the rest of the system still works (recall is
      // slower, no FTS, but functional).
      this.fallback = true;
      return;
    }
    this.db = new sqlite.DatabaseSync(this.dbPath);
    // node:sqlite creates the file with the process umask (0644). This is the
    // screen-OCR corpus — tighten it now rather than waiting for the next
    // boot's hardenDataDir() pass.
    chmodOwnerOnly(this.dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS activity (
        id INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        app TEXT,
        window TEXT,
        event TEXT,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS activity_at ON activity(at);
      CREATE INDEX IF NOT EXISTS activity_app ON activity(app);

      CREATE TABLE IF NOT EXISTS frames (
        id INTEGER PRIMARY KEY,
        frame_uid TEXT UNIQUE,
        captured_at TEXT NOT NULL,
        app TEXT,
        window TEXT,
        thumbnail_path TEXT,
        confidence REAL
      );
      CREATE INDEX IF NOT EXISTS frames_at ON frames(captured_at);

      CREATE VIRTUAL TABLE IF NOT EXISTS texts USING fts5(
        kind UNINDEXED,
        ref UNINDEXED,
        at UNINDEXED,
        app,
        window,
        text,
        tokenize='porter unicode61'
      );
    `);
    this.migrate();
  }

  migrate() {
    for (const table of ["activity", "frames"]) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      if (!cols.includes("source_machine_id")) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN source_machine_id TEXT`);
      }
    }
  }

  async record(observations, meta = {}) {
    await this.ready;
    if (!Array.isArray(observations)) observations = [observations];
    const batchMachineId = (typeof meta.sourceMachineId === "string" && meta.sourceMachineId) ? meta.sourceMachineId : null;
    if (this.fallback) {
      const lines = observations.map((o) => JSON.stringify({ ...o, sourceMachineId: o.sourceMachineId ?? batchMachineId, ingestedAt: nowIso() }) + "\n").join("");
      fs.appendFileSync(this.fallbackPath, lines);
      return { count: observations.length, mode: "fallback-jsonl" };
    }

    const insertActivity = this.db.prepare(
      `INSERT INTO activity (at, app, window, event, metadata, source_machine_id) VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insertFrame = this.db.prepare(
      `INSERT OR IGNORE INTO frames (frame_uid, captured_at, app, window, thumbnail_path, confidence, source_machine_id) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insertText = this.db.prepare(
      `INSERT INTO texts (kind, ref, at, app, window, text) VALUES (?, ?, ?, ?, ?, ?)`
    );

    let count = 0;
    this.db.exec("BEGIN");
    try {
      for (const o of observations) {
        if (!o || !o.kind) continue;
        const machineId = (typeof o.sourceMachineId === "string" && o.sourceMachineId) ? o.sourceMachineId : batchMachineId;
        if (o.kind === "activity") {
          const inserted = insertActivity.run(o.at ?? nowIso(), o.app ?? null, o.window ?? null, o.event ?? "focus", o.metadata ? JSON.stringify(o.metadata) : null, machineId);
          if (o.window) insertText.run("activity", String(inserted.lastInsertRowid), o.at ?? nowIso(), o.app ?? "", o.window ?? "", o.window);
        } else if (o.kind === "frame" || o.kind === "frame-summary") {
          const uid = o.frameId ? String(o.frameId) : createId("frm");
          insertFrame.run(uid, o.at ?? nowIso(), o.app ?? null, o.window ?? null, o.thumbnail ?? null, typeof o.confidence === "number" ? o.confidence : null, machineId);
          if (o.ocrText) insertText.run("frame", uid, o.at ?? nowIso(), o.app ?? "", o.window ?? "", o.ocrText);
        } else if (o.kind === "transcript") {
          // Long-form text (e.g. a BuildBetter call transcript) recorded so it's
          // searchable via the same FTS path as OCR/activity (and thus recall_activity).
          const ref = o.ref ? String(o.ref) : createId("txt");
          if (o.text) insertText.run("transcript", ref, o.at ?? nowIso(), o.app ?? "", o.window ?? "", o.text);
        }
        count += 1;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { count, mode: "sqlite" };
  }

  async search({ query, since, until, app, machine, kinds, limit = 25 } = {}) {
    await this.ready;
    const normalizedKinds = normalizeSearchKinds(kinds);
    if (normalizedKinds && normalizedKinds.length === 0) return [];
    if (this.fallback) {
      // Naive fallback search through the JSONL log.
      let rows = [];
      try { rows = fs.readFileSync(this.fallbackPath, "utf8").split("\n").filter(Boolean).map(JSON.parse); } catch { return []; }
      let out = rows;
      if (normalizedKinds) {
        out = out.filter((o) => normalizedKinds.includes(o.kind === "frame-summary" ? "frame" : o.kind));
      }
      if (query) {
        const q = query.toLowerCase();
        out = out.filter((o) => (o.ocrText || "").toLowerCase().includes(q) || (o.window || "").toLowerCase().includes(q) || (o.text || "").toLowerCase().includes(q));
      }
      if (app) out = out.filter((o) => o.app === app);
      if (machine) out = out.filter((o) => o.sourceMachineId === machine);
      if (since) out = out.filter((o) => (o.at ?? "") >= since);
      if (until) out = out.filter((o) => (o.at ?? "") <= until);
      return out.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "")).slice(0, limit).map((row) => capTranscriptText({
        ...row,
        kind: row.kind === "frame-summary" ? "frame" : row.kind,
        ...(row.kind === "frame" || row.kind === "frame-summary"
          ? { text: row.text ?? row.ocrText ?? null, ref: row.ref ?? row.frameId ?? null }
          : {})
      }));
    }

    if (query) {
      // FTS5 query — escape doubled-quotes for the MATCH expression
      const escaped = String(query).replace(/"/g, '""');
      const matchExpr = `"${escaped}"`;
      // Activity refs before this store's machine-attribution migration were
      // a stable "App:Window" composite key; rows inserted since are the
      // numeric activity rowid. Match either format so a machine filter
      // doesn't silently lose pre-migration capture history.
      const machineClause = machine
        ? `AND ((kind = 'frame' AND ref IN (SELECT frame_uid FROM frames WHERE source_machine_id = ?))
            OR (kind = 'activity' AND ref IN (
              SELECT CAST(id AS TEXT) FROM activity WHERE source_machine_id = ?
              UNION
              SELECT app || ':' || window FROM activity WHERE source_machine_id = ?
            )))`
        : "";
      const rows = this.db.prepare(
        `SELECT kind, ref, at, app, window, snippet(texts, 5, '<mark>', '</mark>', '…', 16) AS snippet, text
         FROM texts WHERE texts MATCH ?
         ${normalizedKinds ? `AND kind IN (${normalizedKinds.map(() => "?").join(", ")})` : ""}
         ${app ? "AND app = ?" : ""}
         ${since ? "AND at >= ?" : ""}
         ${until ? "AND at <= ?" : ""}
         ${machineClause}
         ORDER BY at DESC LIMIT ?`
      );
      const params = [matchExpr];
      if (normalizedKinds) params.push(...normalizedKinds);
      if (app) params.push(app);
      if (since) params.push(since);
      if (until) params.push(until);
      if (machine) { params.push(machine); params.push(machine); params.push(machine); }
      params.push(limit);
      return rows.all(...params).map(capTranscriptText);
    }
    // No query normally returns recent focus activity for backward
    // compatibility. Computer History explicitly asks for activity + frame,
    // so merge both source streams there; otherwise OCR-backed screen events
    // disappeared from the timeline until the user typed a search.
    if (normalizedKinds?.includes("frame")) {
      const sources = [];
      if (normalizedKinds.includes("activity")) {
        sources.push(`SELECT 'activity' AS kind, CAST(id AS TEXT) AS ref, at,
          app, window, event, source_machine_id AS sourceMachineId, NULL AS text
          FROM activity`);
      }
      sources.push(`SELECT 'frame' AS kind, f.frame_uid AS ref, f.captured_at AS at,
        f.app, f.window, 'screen' AS event, f.source_machine_id AS sourceMachineId,
        NULL AS text
        FROM frames f`);
      const params = [];
      const clauses = ["1=1"];
      if (app) { clauses.push("app = ?"); params.push(app); }
      if (since) { clauses.push("at >= ?"); params.push(since); }
      if (until) { clauses.push("at <= ?"); params.push(until); }
      if (machine) { clauses.push("sourceMachineId = ?"); params.push(machine); }
      params.push(limit);
      return this.db.prepare(
        `SELECT kind, ref, at, app, window, event, sourceMachineId, text
         FROM (${sources.join(" UNION ALL ")})
         WHERE ${clauses.join(" AND ")}
         ORDER BY at DESC LIMIT ?`
      ).all(...params).map(capWindowText);
    }
    if (normalizedKinds && !normalizedKinds.includes("activity")) return [];
    const params = [];
    let where = "1=1";
    if (app) { where += " AND app = ?"; params.push(app); }
    if (since) { where += " AND at >= ?"; params.push(since); }
    if (until) { where += " AND at <= ?"; params.push(until); }
    if (machine) { where += " AND source_machine_id = ?"; params.push(machine); }
    params.push(limit);
    return this.db.prepare(`SELECT 'activity' AS kind, app, window, at, event, source_machine_id AS sourceMachineId FROM activity WHERE ${where} ORDER BY at DESC LIMIT ?`).all(...params);
  }

  // Return text-bearing observation rows inside a time window without changing
  // search()'s long-standing no-query behavior (recent activity only). This is
  // intentionally bounded by both row count and per-row text size because it is
  // used to ground miner prompts with nearby OCR, not to export whole captures.
  //
  // SQLite stores normalized text kinds ("frame" / "activity") in FTS5. The
  // JSONL fallback stores the original observation shape, so normalize
  // frame-summary -> frame and ocrText/window -> text for parity.
  async searchTextWindow({ since, until, kinds = ["frame", "activity"], machine, limit = 25 } = {}) {
    await this.ready;
    const requestedKinds = Array.isArray(kinds) ? kinds : [kinds];
    const normalizedKinds = [...new Set(requestedKinds
      .map((kind) => kind === "frame-summary" ? "frame" : String(kind ?? ""))
      .filter((kind) => WINDOW_TEXT_KINDS.has(kind)))];
    if (normalizedKinds.length === 0) return [];

    const parsedLimit = Number.parseInt(String(limit), 10);
    const boundedLimit = Math.max(1, Math.min(WINDOW_SEARCH_LIMIT, Number.isFinite(parsedLimit) ? parsedLimit : 25));

    if (this.fallback) {
      let observations = [];
      try {
        observations = fs.readFileSync(this.fallbackPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse);
      } catch {
        return [];
      }
      return observations
        .filter((o) => !machine || o.sourceMachineId === machine)
        .map((o) => {
          const kind = o.kind === "frame-summary" ? "frame" : o.kind;
          const at = o.at ?? o.ingestedAt ?? null;
          const text = kind === "frame" ? o.ocrText : kind === "activity" ? o.window : null;
          if (!normalizedKinds.includes(kind) || !at || !text) return null;
          return capWindowText({
            kind,
            ref: kind === "frame" && o.frameId != null ? String(o.frameId) : null,
            at,
            app: o.app ?? null,
            window: o.window ?? null,
            text: String(text)
          });
        })
        .filter(Boolean)
        .filter((row) => !since || row.at >= since)
        .filter((row) => !until || row.at <= until)
        .sort((a, b) => a.at.localeCompare(b.at))
        .slice(0, boundedLimit);
    }

    // The miner asks for frame OCR only. Route that hot path through the
    // indexed frames.captured_at/source_machine_id columns, then join to FTS
    // by frame uid; filtering texts.at directly would scan the UNINDEXED FTS
    // metadata column once per representative action.
    if (normalizedKinds.length === 1 && normalizedKinds[0] === "frame") {
      const frameClauses = ["1=1"];
      const frameParams = [];
      if (since) { frameClauses.push("f.captured_at >= ?"); frameParams.push(since); }
      if (until) { frameClauses.push("f.captured_at <= ?"); frameParams.push(until); }
      if (machine) { frameClauses.push("f.source_machine_id = ?"); frameParams.push(machine); }
      frameParams.push(boundedLimit);
      return this.db.prepare(
        `SELECT 'frame' AS kind, f.frame_uid AS ref, f.captured_at AS at,
                f.app, f.window, t.text
         FROM frames f
         JOIN texts t ON t.kind = 'frame' AND t.ref = f.frame_uid
         WHERE ${frameClauses.join(" AND ")}
         ORDER BY f.captured_at ASC
         LIMIT ?`
      ).all(...frameParams).map(capWindowText);
    }

    const clauses = [`kind IN (${normalizedKinds.map(() => "?").join(", ")})`];
    const params = [...normalizedKinds];
    if (since) { clauses.push("at >= ?"); params.push(since); }
    if (until) { clauses.push("at <= ?"); params.push(until); }
    if (machine) {
      clauses.push(`(
        (kind = 'frame' AND ref IN (SELECT frame_uid FROM frames WHERE source_machine_id = ?))
        OR
        (kind = 'activity' AND ref IN (
          SELECT CAST(id AS TEXT) FROM activity WHERE source_machine_id = ?
          UNION
          SELECT app || ':' || window FROM activity WHERE source_machine_id = ?
        ))
      )`);
      params.push(machine, machine, machine);
    }
    params.push(boundedLimit);
    return this.db.prepare(
      `SELECT kind, ref, at, app, window, text
       FROM texts
       WHERE ${clauses.join(" AND ")}
       ORDER BY at ASC
       LIMIT ?`
    ).all(...params).map(capWindowText);
  }

  async existsRef(ref) {
    await this.ready;
    if (!ref) return false;
    if (this.fallback) {
      try {
        const rows = fs.readFileSync(this.fallbackPath, "utf8").split("\n").filter(Boolean).map(JSON.parse);
        return rows.some((o) => o.kind === "transcript" && o.ref === ref);
      } catch { return false; }
    }
    // `ref` is UNINDEXED in the FTS5 table so this is a small scan; fine for the
    // handful of transcript rows a sync checks. Scoped to kind='transcript' so the
    // dedup check never collides with activity/frame refs.
    const row = this.db.prepare(`SELECT 1 FROM texts WHERE kind = 'transcript' AND ref = ? LIMIT 1`).get(ref);
    return Boolean(row);
  }

  // Build a compact "what was the user just doing" digest the agent host
  // prepends to every chat turn. Returns top apps by focus-count in the
  // window plus a budget-trimmed list of OCR snippets, so the LLM can ground
  // its replies in actual on-screen activity instead of just app names.
  async getRecentContext({ minutes = 10, maxChars = 1500, maxSnippets = 6 } = {}) {
    await this.ready;
    if (this.fallback) return { apps: [], snippets: [], sinceIso: null };
    const sinceIso = new Date(Date.now() - minutes * 60 * 1000).toISOString();

    const apps = this.db.prepare(
      `SELECT app, COUNT(*) AS n FROM activity
       WHERE at >= ? GROUP BY app ORDER BY n DESC LIMIT 5`
    ).all(sinceIso);

    const frames = this.db.prepare(
      `SELECT frame_uid, app, window, captured_at,
         (SELECT text FROM texts WHERE ref = frames.frame_uid AND kind = 'frame') AS text
       FROM frames WHERE captured_at >= ?
       ORDER BY captured_at DESC LIMIT ?`
    ).all(sinceIso, maxSnippets * 3);

    const snippets = [];
    const seenTexts = new Set();
    let charsUsed = 0;
    for (const f of frames) {
      const raw = (f.text || "").trim();
      if (!raw) continue;
      // Per-frame budget so one screenshot can't eat the whole window.
      const perFrame = Math.min(280, maxChars - charsUsed);
      if (perFrame < 80) break;
      const trimmed = raw.replace(/\s+/g, " ").slice(0, perFrame).trim();
      // Dedupe near-identical frames captured back-to-back.
      const dedupeKey = trimmed.slice(0, 120);
      if (seenTexts.has(dedupeKey)) continue;
      seenTexts.add(dedupeKey);
      snippets.push({ app: f.app, window: f.window, at: f.captured_at, text: trimmed });
      charsUsed += trimmed.length;
      if (snippets.length >= maxSnippets) break;
      if (charsUsed >= maxChars) break;
    }
    return { apps, snippets, sinceIso };
  }

  async timelineByHour({ since } = {}) {
    await this.ready;
    if (this.fallback) return [];
    const sinceIso = since ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    return this.db.prepare(
      `SELECT substr(at, 1, 13) AS hour, app, COUNT(*) AS n
       FROM activity WHERE at >= ?
       GROUP BY hour, app ORDER BY hour ASC`
    ).all(sinceIso);
  }

  async stats() {
    await this.ready;
    if (this.fallback) {
      let lines = 0;
      try { lines = fs.readFileSync(this.fallbackPath, "utf8").split("\n").filter(Boolean).length; } catch { /* none */ }
      return { mode: "fallback-jsonl", observations: lines };
    }
    const a = this.db.prepare("SELECT COUNT(*) AS n FROM activity").get();
    const f = this.db.prepare("SELECT COUNT(*) AS n FROM frames").get();
    const t = this.db.prepare("SELECT COUNT(*) AS n FROM texts").get();
    return { mode: "sqlite", activity: a.n, frames: f.n, texts: t.n };
  }

  async prune({ olderThanDays = 90, framesOlderThanDays = 7 } = {}) {
    await this.ready;
    if (this.fallback) return { pruned: 0 };
    const cutoffActivity = new Date(Date.now() - olderThanDays * 86400 * 1000).toISOString();
    const cutoffFrames = new Date(Date.now() - framesOlderThanDays * 86400 * 1000).toISOString();
    const a = this.db.prepare("DELETE FROM activity WHERE at < ?").run(cutoffActivity).changes;
    const f = this.db.prepare("DELETE FROM frames WHERE captured_at < ?").run(cutoffFrames).changes;
    const t = this.db.prepare("DELETE FROM texts WHERE at < ? OR (kind='frame' AND at < ?)").run(cutoffActivity, cutoffFrames).changes;
    return { activity: a, frames: f, texts: t };
  }
}
