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

export class IMessageBridge {
  constructor(options = {}) {
    this.client = options.client; // CliClient pointed at the main
    this.dbPath = options.dbPath ?? DEFAULT_DB;
    this.statePath = options.statePath ?? path.join(options.dataDir ?? path.join(os.homedir(), ".openagi"), "imessage-bridge.json");
    this.readMessages = options.readMessages ?? ((sinceRowid) => readNewMessages(this.dbPath, sinceRowid));
    this.sendMessage = options.sendMessage ?? sendViaIMessage;
    this.onEvent = options.onEvent ?? (() => {});

    // Sender allowlist (phone/email handles), lower-cased.
    this.allowFrom = new Set((options.allowFrom ?? []).map((h) => String(h).toLowerCase()));

    // Response policy — WHO/WHAT gets an agent reply:
    //   all     → reply to every incoming message
    //   allow   → reply only to allowlisted senders (default when --allow given)
    //   trigger → reply only when the message contains `trigger` (and, if an
    //             allowlist is set, the sender is on it) — the trigger word is
    //             stripped before forwarding ("Peri what's up" → "what's up")
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
      const lower = text.toLowerCase();
      const at = lower.indexOf(this.trigger);
      if (at === -1) return { respond: false };
      // Strip a leading "<trigger>[,:]" prefix; otherwise forward as-is.
      const stripped = text.replace(new RegExp(`^\\s*${escapeRe(this.trigger)}[\\s,:]+`, "i"), "").trim();
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

  // Run the poll loop until stop() is called.
  start({ intervalMs = 2000 } = {}) {
    this._stopped = false;
    const tick = async () => {
      if (this._stopped) return;
      try { await this.poll(); } catch (error) { this.onEvent({ kind: "poll-error", error: error.message }); }
      if (!this._stopped) this._timer = setTimeout(tick, intervalMs);
    };
    tick();
  }
  stop() { this._stopped = true; if (this._timer) clearTimeout(this._timer); }
}

// Read new INCOMING messages (is_from_me = 0) newer than sinceRowid, across all
// conversations. Returns [{ rowid, handle, text, appleDate }]. Pulls text from
// the `text` column, falling back to a best-effort decode of attributedBody
// (modern macOS often stores the body there, leaving `text` NULL).
export async function readNewMessages(dbPath, sinceRowid) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    // CAST date to TEXT: chat.db `date` is nanoseconds since 2001 (~8e17),
    // which overflows a JS number and makes node:sqlite throw. We only need it
    // as a string timestamp anyway.
    const rows = db.prepare(`
      SELECT m.ROWID AS rowid, m.text AS text, m.attributedBody AS body,
             CAST(m.date AS TEXT) AS appleDate, h.id AS handle
      FROM message m
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.ROWID > ? AND m.is_from_me = 0 AND h.id IS NOT NULL
      ORDER BY m.ROWID ASC
      LIMIT 200
    `).all(sinceRowid);
    return rows.map((r) => ({
      rowid: r.rowid,
      handle: r.handle,
      appleDate: r.appleDate,
      text: r.text && r.text.trim() ? r.text : extractAttributedText(r.body)
    }));
  } finally {
    db.close();
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
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
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
