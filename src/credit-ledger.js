// src/credit-ledger.js
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";

const RETENTION_DAYS = 30;
const COMPACT_BYTES = 4 * 1024 * 1024;

// Append-only per-call credit (USD) ledger. record() is O(1) append (it runs in
// the hot path of every LLM call); old entries are filtered out of query()/
// analytics() by the rolling window, and the file is compacted only when it
// grows large. Stores no message content — just cost + attribution.
export class CreditLedger {
  constructor(options = {}) {
    this.storePath = options.storePath ?? path.join(resolveDataDir(), "budget", "ledger.jsonl");
    this.retentionDays = options.retentionDays ?? RETENTION_DAYS;
    this.compactBytes = options.compactBytes ?? COMPACT_BYTES;
    // Next size at which compaction runs. Re-armed above the post-compaction
    // size so a ledger whose retained 30-day window legitimately exceeds
    // compactBytes doesn't read+rewrite the whole file on every append.
    this._nextCompactBytes = this.compactBytes;
    this._lastPruneAt = 0; // epoch ms of the last retention prune (0 → prune on first record)
    ensureDir(path.dirname(this.storePath));
    // The ledger holds attribution (from/sessionId/agentId/tools/spend) — not
    // world-readable. New files are created 0600 (mode on append/write below);
    // tighten an existing file once at startup in case it predates this.
    try { if (fs.existsSync(this.storePath)) fs.chmodSync(this.storePath, 0o600); } catch { /* best effort */ }
  }

  // Calendar-day cutoff (UTC, matching BudgetGuard.todayKey): the start of the
  // day that is (days-1) days before `now`. So days=1 means "today" (since UTC
  // midnight), days=7 means "today + the previous 6 days" — not a rolling N×24h
  // window, which would bleed yesterday's evening spend into a "today" query.
  _cutoff(days, now) {
    const d = new Date(now.getTime());
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - (days - 1));
    return d.toISOString();
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
    fs.appendFileSync(this.storePath, JSON.stringify(row) + "\n", { mode: 0o600 });
    this._maybeMaintain(now);
    return row;
  }

  // Prune to the retention window when the file has grown past the (re-armed)
  // compaction threshold OR at least once a day — so rows older than the window
  // are physically removed even on low-volume installs that never hit the size
  // cap. This enforces the 30-day retention/privacy guarantee on disk, not just
  // at read time. Appending stays O(1); this only does work when size- or
  // time-triggered.
  _maybeMaintain(now) {
    let size = 0;
    try { size = fs.statSync(this.storePath).size; } catch { return; }
    const dueByTime = (now.getTime() - this._lastPruneAt) >= 86400 * 1000;
    if (size < this._nextCompactBytes && !dueByTime) return;
    const cutoff = this._cutoff(this.retentionDays, now);
    const all = this._readAll();
    const kept = all.filter((r) => (r.at ?? "") >= cutoff);
    if (kept.length !== all.length) {
      fs.writeFileSync(this.storePath, kept.map((r) => JSON.stringify(r)).join("\n") + (kept.length ? "\n" : ""), { mode: 0o600 });
    }
    this._lastPruneAt = now.getTime();
    // Re-arm: only size-compact again after the file roughly doubles past the
    // retained size, so a large-but-legitimate window amortizes the rewrite.
    let newSize = 0;
    try { newSize = fs.statSync(this.storePath).size; } catch { /* ignore */ }
    this._nextCompactBytes = Math.max(this.compactBytes, newSize * 2);
  }

  query({ days = this.retentionDays, now = new Date() } = {}) {
    // Clamp to the retention window: the ledger only promises 30 days, and rows
    // older than that may still be on disk (pruning runs lazily on record), so a
    // wider days= must never surface aged-out attribution.
    const window = Math.min(Math.max(1, days), this.retentionDays);
    const cutoff = this._cutoff(window, now);
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
