import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// iMessage bridge (node-side). Turns a Mac into a conversational gateway for a
// remote OpenAGI "main": new INCOMING iMessages are forwarded to the main's
// /message endpoint, and the main's reply is sent back via Messages.app.
//
//   incoming iMessage --> POST <main>/message --> reply --> osascript send back
//
// The Mac holds none of the brain — memory/context/integrations live on the
// main. This node only needs Full Disk Access (read chat.db) and Automation
// permission for Messages (send replies).
//
// Deps are injected (db reader, the CliClient, the send fn) so the relay loop
// is unit-testable without a real chat.db or Messages.app.

const execFileAsync = promisify(execFile);
const DEFAULT_DB = path.join(os.homedir(), "Library", "Messages", "chat.db");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Open chat.db as a strictly READ-ONLY, non-locking reader. This is critical:
// node:sqlite opens read-WRITE by default, and a read-write connection on a
// live WAL database (which Messages.app is constantly writing) attempts WAL
// checkpoints and grabs exclusive locks — which can stall or crash Messages.
// Read-only + query_only guarantees we never write/checkpoint; a short
// busy_timeout means we back off instead of blocking if the writer holds a lock.
async function openChatDbReadOnly(dbPath) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = 1; PRAGMA busy_timeout = 2000;");
  } catch { /* pragmas are best-effort hardening */ }
  return db;
}

export class IMessageBridge {
  constructor(options = {}) {
    this.client = options.client; // CliClient pointed at the main
    this.dbPath = options.dbPath ?? DEFAULT_DB;
    this.statePath = options.statePath ?? path.join(options.dataDir ?? path.join(os.homedir(), ".openagi"), "imessage-bridge.json");
    // "Note to self": also read your OWN texts in your self-thread so you can
    // command the agent by texting yourself. On by default; your handles come
    // from the allowlist. (Resolved lazily at poll time — allowFrom is set below.)
    this.selfChat = options.selfChat ?? true;
    // One reused READ-ONLY connection (opened lazily, kept open across polls) so
    // we don't reopen the 1.5GB chat.db every tick. readNewMessages gets it via
    // `db`; on any read error we drop it so the next poll reopens cleanly.
    this._db = null;
    this.readMessages = options.readMessages ?? (async (sinceRowid) => {
      if (!this._db) this._db = await openChatDbReadOnly(this.dbPath);
      try {
        return await readNewMessages(this.dbPath, sinceRowid, {
          selfHandles: this.selfChat ? [...this.allowFrom] : [],
          db: this._db
        });
      } catch (error) {
        try { this._db?.close(); } catch { /* ignore */ }
        this._db = null; // reopen next tick (e.g. db was vacuumed/replaced)
        throw error;
      }
    });
    this.sendMessage = options.sendMessage ?? sendViaIMessage;
    this.onEvent = options.onEvent ?? (() => {});
    // Texts the bridge itself just sent — so reading the self-thread doesn't
    // echo our own replies back into capture/reply (would otherwise loop).
    this._recentSends = [];

    // Sender allowlist (phone/email handles), lower-cased.
    this.allowFrom = new Set((options.allowFrom ?? []).map((h) => String(h).toLowerCase()));

    // Response policy — WHO/WHAT gets an agent reply:
    //   all     → reply to every incoming message
    //   allow   → reply only to allowlisted senders (default when --allow given)
    //   trigger → reply only when the message contains `trigger` as a whole
    //             word (and, if an allowlist is set, the sender is on it) — a
    //             leading mention is stripped ("Peri what's up" → "what's up").
    //             Everything else is still captured per captureMode, so the
    //             agent silently listens + saves until you invoke it by name.
    //   none    → never reply (capture-only mode)
    this.respondMode = options.respondMode ?? (this.allowFrom.size ? "allow" : "all");
    this.trigger = (options.trigger ?? "").toLowerCase();

    // Capture policy — WHICH incoming messages are saved to the main's memory
    // (ambient awareness, even when not replied to):
    //   none  → save nothing extra (replies still create their own memory)
    //   allow → save messages from allowlisted senders
    //   all   → save every incoming message
    this.captureMode = options.captureMode ?? "none";
  }

  _loadState() {
    try { return JSON.parse(fs.readFileSync(this.statePath, "utf8")); } catch { return { lastRowid: null }; }
  }
  _saveState(state) {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  }

  onAllowlist(handle) {
    return this.allowFrom.size === 0 || this.allowFrom.has(String(handle).toLowerCase());
  }

  // Decide whether to reply, and return the text to forward (trigger stripped).
  // { respond: bool, forward: string }
  responseFor(handle, text) {
    const allowed = this.allowFrom.size === 0 || this.allowFrom.has(String(handle).toLowerCase());
    if (this.respondMode === "none") return { respond: false };
    if (this.respondMode === "all") return { respond: true, forward: text };
    if (this.respondMode === "allow") return { respond: allowed, forward: text };
    if (this.respondMode === "trigger") {
      if (!allowed || !this.trigger) return { respond: false };
      // Match the trigger as a whole word so "Peri, what's up?" fires but
      // "perimeter" / "period" don't.
      const wordRe = new RegExp(`\\b${escapeRe(this.trigger)}\\b`, "i");
      if (!wordRe.test(text)) return { respond: false };
      // Strip a leading "<trigger>" mention so it isn't echoed back into the
      // prompt ("Peri what's up" → "what's up"); a bare "Peri" forwards as-is.
      const stripped = text.replace(new RegExp(`^\\s*${escapeRe(this.trigger)}\\b[\\s,:!.?]*`, "i"), "").trim();
      return { respond: true, forward: stripped || text };
    }
    return { respond: false };
  }

  shouldCapture(handle) {
    if (this.captureMode === "all") return true;
    if (this.captureMode === "allow") return this.allowFrom.has(String(handle).toLowerCase());
    return false;
  }

  // One pass: for each new incoming message, optionally capture it to the
  // main's memory and optionally reply via the agent. Returns a summary.
  async poll() {
    let state = this._loadState();
    // First run: don't replay history — start from the current high-water mark.
    if (state.lastRowid == null) {
      state = { lastRowid: await this.readMaxRowid(), initialized: true };
      this._saveState(state);
      return { processed: 0, replied: 0, captured: 0, skipped: 0, errors: 0, bootstrapped: true };
    }

    const rows = await this.readMessages(state.lastRowid);
    let processed = 0, replied = 0, captured = 0, skipped = 0, errors = 0, highest = state.lastRowid;
    for (const row of rows) {
      if (row.rowid > highest) highest = row.rowid;
      processed++;
      const text = (row.text ?? "").trim();
      if (!text || !row.handle) { skipped++; continue; }

      // Skip the bridge's OWN replies echoed back via the self-thread, so we
      // never capture or reply to ourselves (would otherwise loop).
      if (row.fromMe && this._recentSends.includes(text)) { skipped++; continue; }

      // 1. Ambient memory capture (independent of replying).
      if (this.shouldCapture(row.handle)) {
        try {
          const cap = await this.client.request("POST", "/memory/remember", {
            content: `iMessage from ${row.handle}: ${text}`,
            tags: ["imessage", row.handle], importance: "normal"
          });
          if (cap.ok) { captured++; this.onEvent({ kind: "captured", handle: row.handle, in: text.slice(0, 80) }); }
        } catch { /* capture is best-effort */ }
      }

      // 2. Reply per the response policy.
      const decision = this.responseFor(row.handle, text);
      if (!decision.respond) { skipped++; continue; }
      try {
        const res = await this.client.chat(decision.forward, { from: `imessage:${row.handle}` });
        const reply = res?.json?.reply;
        if (res?.ok && reply) {
          await this.sendMessage(row.handle, reply);
          // Remember it so the self-thread echo of this reply is ignored next poll.
          this._recentSends.push(reply.trim());
          if (this._recentSends.length > 50) this._recentSends.shift();
          replied++;
          this.onEvent({ kind: "relayed", handle: row.handle, in: text.slice(0, 80), out: reply.slice(0, 80) });
        } else {
          errors++;
          this.onEvent({ kind: "main-error", handle: row.handle, error: res?.error ?? `HTTP ${res?.status}` });
        }
      } catch (error) {
        errors++;
        this.onEvent({ kind: "send-error", handle: row.handle, error: error.message });
      }
    }
    this._saveState({ ...state, lastRowid: highest });
    return { processed, replied, captured, skipped, errors };
  }

  async readMaxRowid() {
    const rows = await this.readMessages(0);
    return rows.reduce((mx, r) => Math.max(mx, r.rowid), 0);
  }

  // Run the poll loop until stop() is called. Default 10s: a read-only reader is
  // gentle, but a longer interval further reduces any chance of contending with
  // Messages, and iMessage commands don't need sub-10s latency.
  start({ intervalMs = 10000 } = {}) {
    this._stopped = false;
    const tick = async () => {
      if (this._stopped) return;
      try { await this.poll(); } catch (error) { this.onEvent({ kind: "poll-error", error: error.message }); }
      if (!this._stopped) this._timer = setTimeout(tick, intervalMs);
    };
    tick();
  }
  stop() {
    this._stopped = true;
    if (this._timer) clearTimeout(this._timer);
    try { this._db?.close(); } catch { /* ignore */ } // release chat.db
    this._db = null;
  }
}

// Read new messages newer than sinceRowid. By default only INCOMING
// (is_from_me = 0), across all conversations. `selfHandles` (your own
// handles — the allowlist) additionally pulls your OWN sent messages in your
// self-thread, so you can text yourself to command the agent ("note to self").
// We never pull your outgoing messages to OTHER people. Returns
// [{ rowid, handle, fromMe, text, appleDate }].
export async function readNewMessages(dbPath, sinceRowid, { selfHandles = [], db: reuseDb = null } = {}) {
  // Reuse a caller-owned read-only connection (the polling bridge does this to
  // avoid reopening chat.db every tick); otherwise open one read-only + close.
  const db = reuseDb ?? await openChatDbReadOnly(dbPath);
  try {
    const self = [...new Set(selfHandles.map((h) => String(h).toLowerCase()))].filter(Boolean);
    // Outgoing messages carry handle_id=0 (no handle row); the recipient lives
    // in the `chat` table. So self-texts ("note to self") are matched by the
    // conversation's chat_identifier, NOT message.handle. We only pull
    // is_from_me=1 when that chat is one of YOUR OWN handles — never your
    // outgoing messages to other people.
    const selfClause = self.length
      ? ` OR (m.is_from_me = 1 AND lower(c.chat_identifier) IN (${self.map(() => "?").join(",")}))`
      : "";
    // CAST date to TEXT: chat.db `date` is nanoseconds since 2001 (~8e17),
    // which overflows a JS number and makes node:sqlite throw. We only need it
    // as a string timestamp anyway. handle = the sender for incoming, or the
    // self chat_identifier for your own self-texts.
    const rows = db.prepare(`
      SELECT m.ROWID AS rowid, m.text AS text, m.attributedBody AS body,
             m.is_from_me AS fromMe, CAST(m.date AS TEXT) AS appleDate,
             COALESCE(h.id, c.chat_identifier) AS handle
      FROM message m
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN chat c ON c.ROWID = cmj.chat_id
      WHERE m.ROWID > ? AND (
        (m.is_from_me = 0 AND h.id IS NOT NULL)${selfClause}
      )
      GROUP BY m.ROWID
      ORDER BY m.ROWID ASC
      LIMIT 200
    `).all(sinceRowid, ...self);
    return rows.map((r) => ({
      rowid: r.rowid,
      handle: r.handle,
      fromMe: r.fromMe === 1,
      appleDate: r.appleDate,
      text: r.text && r.text.trim() ? r.text : extractAttributedText(r.body)
    }));
  } finally {
    if (!reuseDb) db.close(); // never close a connection the caller owns
  }
}

// Best-effort text out of the NSAttributedString typedstream blob Messages
// stores in `attributedBody`. Byte-walk (no fragile control-char regex): find
// the "NSString" class marker, skip the short length-prefix of control bytes
// (and a leading '+'), then collect UTF-8 until the 0x86/0x84 end marker.
// Not a full typedstream parser — pragmatic, handles the common case.
export function extractAttributedText(body) {
  if (!body) return "";
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const marker = buf.indexOf(Buffer.from("NSString", "ascii"));
  if (marker === -1) return "";
  let i = marker + "NSString".length;
  while (i < buf.length && (buf[i] < 0x20 || buf[i] === 0x2b)) i++; // skip ctrl bytes + leading '+'
  const start = i;
  while (i < buf.length && buf[i] !== 0x86 && buf[i] !== 0x84) i++;
  // Trim any trailing control bytes that slipped in.
  let end = i;
  while (end > start && buf[end - 1] < 0x20) end--;
  return buf.slice(start, end).toString("utf8").trim();
}

// Search the iMessage history (both directions). Filters: text `query`
// (substring, case-insensitive), `handle` (sender/recipient), `days` (lookback).
// Returns newest-first [{ rowid, handle, fromMe, text, date }]. This is what an
// "ask questions about my iMessages" capability calls. chat.db `date` is
// nanoseconds since the 2001-01-01 Apple epoch.
const APPLE_EPOCH_MS = 978307200000; // 2001-01-01 UTC in unix ms
export async function searchMessages(dbPath = DEFAULT_DB, { query = "", handle = null, days = null, limit = 50 } = {}) {
  const db = await openChatDbReadOnly(dbPath);
  try {
    const where = ["(m.text IS NOT NULL OR m.attributedBody IS NOT NULL)"];
    const params = [];
    if (handle) { where.push("h.id LIKE ?"); params.push(`%${handle}%`); }
    if (days) {
      const cutoffNs = String(BigInt(Math.floor((Date.now() - days * 86400000 - APPLE_EPOCH_MS))) * 1000000n);
      where.push("CAST(m.date AS TEXT) > ?"); params.push(cutoffNs);
    }
    // Pull a window newest-first, then filter text in JS (covers attributedBody).
    const rows = db.prepare(`
      SELECT m.ROWID AS rowid, m.text AS text, m.attributedBody AS body,
             m.is_from_me AS fromMe, CAST(m.date AS TEXT) AS dateNs, h.id AS handle
      FROM message m
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE ${where.join(" AND ")}
      ORDER BY m.ROWID DESC
      LIMIT 2000
    `).all(...params);
    const q = query.trim().toLowerCase();
    const out = [];
    for (const r of rows) {
      const text = r.text && r.text.trim() ? r.text : extractAttributedText(r.body);
      if (!text) continue;
      if (q && !text.toLowerCase().includes(q)) continue;
      const ns = r.dateNs ? Number(BigInt(r.dateNs) / 1000000n) + APPLE_EPOCH_MS : null;
      out.push({ rowid: r.rowid, handle: r.handle, fromMe: r.fromMe === 1, text, date: ns ? new Date(ns).toISOString() : null });
      if (out.length >= limit) break;
    }
    return out;
  } finally {
    db.close();
  }
}

// Send a message back over iMessage via AppleScript. Requires Automation
// permission for Messages granted to the controlling process.
export async function sendViaIMessage(handle, text, { run = execFileAsync } = {}) {
  const script = `
    on run {targetHandle, msgText}
      tell application "Messages"
        set svc to 1st account whose service type = iMessage
        set theBuddy to participant targetHandle of svc
        send msgText to theBuddy
      end tell
    end run`;
  await run("osascript", ["-e", script, handle, text], { timeout: 15000 });
}
