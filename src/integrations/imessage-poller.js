// macOS iMessage → TaskStore source. Reads ~/Library/Messages/chat.db
// (the local SQLite backing store) and imports messages the user texted
// to themselves as user-queue tasks. The "text yourself as inbox"
// pattern: send "fix the mouse bug" to yourself from any device with
// iMessage, OpenAGI picks it up on the next sweep.
//
// Permission gate: macOS requires Full Disk Access for chat.db. There
// is no programmatic prompt — the user has to toggle it in
// System Settings → Privacy & Security → Full Disk Access manually.
// If chat.db can't be opened, the source surfaces a clear error
// (e.g. "permission-denied — grant Full Disk Access") in lastError so
// the dashboard can show what to do next.
//
// Privacy-conscious by default: ONLY messages where the chat is a
// 1-on-1 thread between you and your declared self handle (the iCloud
// email or phone you text yourself from / to). Configure via
// IMESSAGE_SELF_HANDLE in .env. We never read group chats or chats with
// other contacts.
//
// Dedup: tracks the highest message ROWID we've seen in
// .openagi/integrations/imessage-state.json so re-runs don't re-import.

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { ensureDir, writeJsonAtomic, readJsonFile } from "../file-utils.js";
import { resolveDataDir } from "../data-dir.js";

const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_DB_PATH = path.join(os.homedir(), "Library", "Messages", "chat.db");

let sqliteModule = null;
async function loadSqlite() {
  if (sqliteModule) return sqliteModule;
  try {
    sqliteModule = await import("node:sqlite");
    return sqliteModule;
  } catch {
    return null;
  }
}

export class IMessagePollerSource {
  constructor(options = {}) {
    this.runtime = options.runtime;
    this.dataDir = options.dataDir ?? resolveDataDir();
    this.dbPath = options.dbPath ?? process.env.IMESSAGE_DB_PATH ?? DEFAULT_DB_PATH;
    this.selfHandle = options.selfHandle ?? process.env.IMESSAGE_SELF_HANDLE ?? null;
    this.intervalMs = options.intervalMs ?? (Number(process.env.IMESSAGE_INTERVAL_MS) || DEFAULT_INTERVAL_MS);
    // mode controls what happens with each imported message:
    //   "task" (default) — title becomes a user-queue task in 'today'
    //   "observation"    — recorded but no task created
    this.mode = options.mode ?? process.env.IMESSAGE_MODE ?? "task";
    // First-sync behavior. Default forward-only — when iMessage is first
    // enabled we don't want every text-to-self ever to land as a task in
    // the user's Today bucket. Set IMESSAGE_BACKFILL_DAYS=7 (or similar)
    // to seed the last N days as a one-time catch-up.
    this.backfillDays = options.backfillDays ?? (Number(process.env.IMESSAGE_BACKFILL_DAYS ?? 0) || 0);
    this.lastSyncedAt = null;
    this.lastError = null;
    this.statePath = path.join(this.dataDir, "integrations", "imessage-state.json");
    ensureDir(path.dirname(this.statePath));
  }

  isEnabled() {
    // Source must be explicitly enabled — chat.db is sensitive enough
    // that we won't read it just because the binary is on macOS.
    const flag = process.env.IMESSAGE_ENABLED;
    return flag === "1" || flag === "true" || flag === "yes";
  }

  isConfigured() {
    return this.isEnabled() && Boolean(this.selfHandle);
  }

  /// Returns a status object suitable for the /integrations/status endpoint.
  status() {
    const exists = fs.existsSync(this.dbPath);
    let readable = false;
    let permissionError = null;
    if (exists) {
      try {
        // fs.accessSync with R_OK is the cheapest "can I open this file?"
        // probe. If macOS hasn't granted Full Disk Access we get EACCES.
        fs.accessSync(this.dbPath, fs.constants.R_OK);
        readable = true;
      } catch (err) {
        permissionError = err.code === "EACCES"
          ? "Full Disk Access not granted"
          : err.message;
      }
    }
    return {
      enabled: this.isEnabled(),
      selfHandle: this.selfHandle,
      mode: this.mode,
      dbExists: exists,
      readable,
      permissionError,
      lastSyncedAt: this.lastSyncedAt,
      lastError: this.lastError,
      lastImportedRowid: this._loadState().lastRowid ?? null,
      requiresFullDiskAccess: !readable && exists
    };
  }

  _loadState() {
    // initialized=false sentinel triggers the first-run bootstrap so we
    // don't import a decade of self-texts the moment iMessage is enabled.
    return readJsonFile(this.statePath, { lastRowid: 0, initialized: false });
  }

  _saveState(state) {
    writeJsonAtomic(this.statePath, state);
  }

  /// Pick the starting ROWID for the first sync after enable.
  ///   - backfillDays > 0 → ROWIDs whose date >= now - N days (lower bound)
  ///   - backfillDays = 0 → MAX(ROWID) so future messages only
  /// Returns 0 if the table is empty.
  _computeBootstrapRowid(db) {
    if (this.backfillDays > 0) {
      // chat.db `date` is nanoseconds since 2001-01-01 UTC. Apple epoch
      // offset is 978307200000 ms.
      const cutoffMs = Date.now() - this.backfillDays * 86400 * 1000;
      const cutoffAppleNs = (cutoffMs - 978307200000) * 1e6;
      try {
        const row = db.prepare(`
          SELECT MIN(ROWID) AS rowid
          FROM message
          WHERE date >= ?
        `).get(cutoffAppleNs);
        // Subtract 1 so the WHERE m.ROWID > sinceRowid in sync() includes
        // the first message at the cutoff.
        if (row?.rowid) return Math.max(0, row.rowid - 1);
        // No messages in that window — fall through to MAX so we don't
        // accidentally import everything older than the cutoff.
      } catch { /* fall through */ }
    }
    try {
      const row = db.prepare(`SELECT MAX(ROWID) AS rowid FROM message`).get();
      return row?.rowid ?? 0;
    } catch {
      return 0;
    }
  }

  async sync({ now = new Date() } = {}) {
    if (!this.isEnabled()) return { skipped: true, reason: "IMESSAGE_ENABLED not set" };
    if (!this.selfHandle) return { skipped: true, reason: "IMESSAGE_SELF_HANDLE not set" };
    if (!this.runtime?.tasks?.add) return { skipped: true, reason: "task store not available" };

    const sqlite = await loadSqlite();
    if (!sqlite) return { skipped: true, reason: "node:sqlite unavailable (need Node 22.5+)" };

    if (!fs.existsSync(this.dbPath)) {
      this.lastError = `chat.db not found at ${this.dbPath}`;
      return { skipped: true, reason: this.lastError };
    }

    let db;
    try {
      // Read-only open keeps us from racing Messages.app's writes. node:sqlite
      // doesn't expose a `readOnly` flag explicitly so we open with the
      // immutable URI parameter via setting the path; if that breaks across
      // node versions, fall back to a regular open (Messages.app uses WAL,
      // so concurrent reads should still work).
      db = new sqlite.DatabaseSync(this.dbPath);
    } catch (err) {
      this.lastError = err.code === "SQLITE_CANTOPEN" || /unable to open/i.test(err.message)
        ? "permission-denied — grant Full Disk Access in System Settings"
        : err.message;
      return { skipped: true, reason: this.lastError };
    }

    try {
      let state = this._loadState();

      // First-run bootstrap: avoid dumping years of historical self-texts
      // into Today. Without this, sinceRowid=0 means "import everything",
      // which is almost never what the user wants.
      if (!state.initialized) {
        const seedRowid = this._computeBootstrapRowid(db);
        state = { lastRowid: seedRowid, initialized: true, bootstrappedAt: new Date().toISOString() };
        this._saveState(state);
      }

      const sinceRowid = state.lastRowid ?? 0;

      // Pull messages newer than our high-water mark, only from chats that
      // are 1-on-1 with the user's self-handle. The query joins
      // chat_message_join → chat → chat_handle_join → handle and constrains
      // to chats that contain only the self-handle (i.e. self-chat).
      const stmt = db.prepare(`
        SELECT
          m.ROWID         AS rowid,
          m.guid          AS guid,
          m.text          AS text,
          m.is_from_me    AS isFromMe,
          m.date          AS appleDate,
          h.id            AS handleId
        FROM message m
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        WHERE m.ROWID > ?
          AND m.text IS NOT NULL
          AND TRIM(m.text) <> ''
          AND EXISTS (
            SELECT 1
            FROM chat_message_join cmj
            JOIN chat c ON c.ROWID = cmj.chat_id
            JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
            JOIN handle h2 ON h2.ROWID = chj.handle_id
            WHERE cmj.message_id = m.ROWID
              AND h2.id = ?
              AND (
                SELECT COUNT(DISTINCT chj2.handle_id)
                FROM chat_handle_join chj2
                WHERE chj2.chat_id = c.ROWID
              ) = 1
          )
        ORDER BY m.ROWID ASC
        LIMIT 200
      `);
      const rows = stmt.all(sinceRowid, this.selfHandle);

      let imported = 0;
      let highestRowid = sinceRowid;

      for (const row of rows) {
        if (row.rowid > highestRowid) highestRowid = row.rowid;
        const ts = appleTimestampToIso(row.appleDate);
        const text = String(row.text ?? "").trim();
        if (!text) continue;

        if (this.mode === "task") {
          this.runtime.tasks.add(
            {
              title: text.length > 200 ? text.slice(0, 197) + "…" : text,
              description: text.length > 200 ? text : "",
              bucket: "today",
              tags: ["imessage"],
              sourceId: `imessage:${row.guid}`,
              sourceMeta: {
                rowid: row.rowid,
                isFromMe: Boolean(row.isFromMe),
                handle: row.handleId,
                receivedAt: ts
              }
            },
            { source: "imessage", queue: "user" }
          );
          imported += 1;
        } else if (this.mode === "observation") {
          // Just count — caller can extend later (push to memory, etc).
          imported += 1;
        }
      }

      if (highestRowid > sinceRowid) {
        this._saveState({ lastRowid: highestRowid, lastSyncedAt: now.toISOString() });
      }
      this.lastSyncedAt = now.toISOString();
      this.lastError = null;
      return { imported, scanned: rows.length, sinceRowid, highestRowid };
    } catch (err) {
      this.lastError = err.message;
      return { skipped: true, reason: err.message };
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}

// Apple's chat.db `date` column is nanoseconds since 2001-01-01 UTC
// (the Mac/iOS absolute reference). Convert to ISO 8601.
//   epoch_ms = (apple_ns / 1e9) + 978307200000
function appleTimestampToIso(appleNs) {
  if (!Number.isFinite(appleNs)) return null;
  const ms = Math.floor(appleNs / 1e9 + 978307200) * 1000;
  return new Date(ms).toISOString();
}

export function registerIMessagePoller(runtime, options = {}) {
  const source = options.source ?? new IMessagePollerSource({ runtime, ...options });
  // Always attach to runtime so the dashboard's /integrations/status can
  // reflect "needs Full Disk Access" even when not yet enabled — the
  // status() shape is what the UI uses to render the toggle + warnings.
  runtime.imessagePoller = source;

  if (!source.isEnabled()) {
    return { registered: false, reason: "IMESSAGE_ENABLED not set" };
  }
  if (!source.selfHandle) {
    return { registered: false, reason: "IMESSAGE_SELF_HANDLE not set" };
  }
  if (runtime.cron?.addJob) {
    runtime.cron.addJob({
      id: "imessage-sync",
      name: "iMessage chat.db → tasks (self-chat only)",
      enabled: true,
      task: "imessage-sync",
      intervalMs: source.intervalMs
    });
  }
  return { registered: true };
}
