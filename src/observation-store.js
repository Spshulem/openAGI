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
import { ensureDir } from "./file-utils.js";
import { createId, nowIso } from "./utils.js";
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

export class ObservationStore {
  constructor(options = {}) {
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
  }

  async record(observations) {
    await this.ready;
    if (!Array.isArray(observations)) observations = [observations];
    if (this.fallback) {
      const lines = observations.map((o) => JSON.stringify({ ...o, ingestedAt: nowIso() }) + "\n").join("");
      fs.appendFileSync(this.fallbackPath, lines);
      return { count: observations.length, mode: "fallback-jsonl" };
    }

    const insertActivity = this.db.prepare(
      `INSERT INTO activity (at, app, window, event, metadata) VALUES (?, ?, ?, ?, ?)`
    );
    const insertFrame = this.db.prepare(
      `INSERT OR IGNORE INTO frames (frame_uid, captured_at, app, window, thumbnail_path, confidence) VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insertText = this.db.prepare(
      `INSERT INTO texts (kind, ref, at, app, window, text) VALUES (?, ?, ?, ?, ?, ?)`
    );

    let count = 0;
    this.db.exec("BEGIN");
    try {
      for (const o of observations) {
        if (!o || !o.kind) continue;
        if (o.kind === "activity") {
          insertActivity.run(o.at ?? nowIso(), o.app ?? null, o.window ?? null, o.event ?? "focus", o.metadata ? JSON.stringify(o.metadata) : null);
          if (o.window) insertText.run("activity", String(o.app ?? "") + ":" + String(o.window ?? ""), o.at ?? nowIso(), o.app ?? "", o.window ?? "", o.window);
        } else if (o.kind === "frame" || o.kind === "frame-summary") {
          const uid = o.frameId ? String(o.frameId) : createId("frm");
          insertFrame.run(uid, o.at ?? nowIso(), o.app ?? null, o.window ?? null, o.thumbnail ?? null, typeof o.confidence === "number" ? o.confidence : null);
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

  async search({ query, since, until, app, limit = 25 } = {}) {
    await this.ready;
    if (this.fallback) {
      // Naive fallback search through the JSONL log.
      let rows = [];
      try { rows = fs.readFileSync(this.fallbackPath, "utf8").split("\n").filter(Boolean).map(JSON.parse); } catch { return []; }
      let out = rows;
      if (query) {
        const q = query.toLowerCase();
        out = out.filter((o) => (o.ocrText || "").toLowerCase().includes(q) || (o.window || "").toLowerCase().includes(q) || (o.text || "").toLowerCase().includes(q));
      }
      if (app) out = out.filter((o) => o.app === app);
      if (since) out = out.filter((o) => (o.at ?? "") >= since);
      if (until) out = out.filter((o) => (o.at ?? "") <= until);
      return out.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "")).slice(0, limit);
    }

    if (query) {
      // FTS5 query — escape doubled-quotes for the MATCH expression
      const escaped = String(query).replace(/"/g, '""');
      const matchExpr = `"${escaped}"`;
      const rows = this.db.prepare(
        `SELECT kind, ref, at, app, window, snippet(texts, 5, '<mark>', '</mark>', '…', 16) AS snippet, text
         FROM texts WHERE texts MATCH ?
         ${app ? "AND app = ?" : ""}
         ${since ? "AND at >= ?" : ""}
         ${until ? "AND at <= ?" : ""}
         ORDER BY at DESC LIMIT ?`
      );
      const params = [matchExpr];
      if (app) params.push(app);
      if (since) params.push(since);
      if (until) params.push(until);
      params.push(limit);
      return rows.all(...params);
    }
    // No query → return recent activity by default.
    const params = [];
    let where = "1=1";
    if (app) { where += " AND app = ?"; params.push(app); }
    if (since) { where += " AND at >= ?"; params.push(since); }
    if (until) { where += " AND at <= ?"; params.push(until); }
    params.push(limit);
    return this.db.prepare(`SELECT 'activity' AS kind, app, window, at, event FROM activity WHERE ${where} ORDER BY at DESC LIMIT ?`).all(...params);
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
