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
    this.dir = options.dir ?? path.join(process.cwd(), ".openagi", "observations");
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
        out = out.filter((o) => (o.ocrText || "").toLowerCase().includes(q) || (o.window || "").toLowerCase().includes(q));
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
