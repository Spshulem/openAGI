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
    ensureDir(path.dirname(this.storePath));
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
    fs.appendFileSync(this.storePath, JSON.stringify(row) + "\n");
    this._maybeCompact(now);
    return row;
  }

  _maybeCompact(now) {
    let size = 0;
    try { size = fs.statSync(this.storePath).size; } catch { return; }
    if (size < this._nextCompactBytes) return;
    const cutoff = this._cutoff(this.retentionDays, now);
    const kept = this._readAll().filter((r) => (r.at ?? "") >= cutoff);
    fs.writeFileSync(this.storePath, kept.map((r) => JSON.stringify(r)).join("\n") + (kept.length ? "\n" : ""));
    // Re-arm: only compact again after the file roughly doubles past the
    // retained size, so a large-but-legitimate window amortizes the rewrite
    // instead of compacting on every subsequent append.
    let newSize = 0;
    try { newSize = fs.statSync(this.storePath).size; } catch { /* ignore */ }
    this._nextCompactBytes = Math.max(this.compactBytes, newSize * 2);
  }

  query({ days = this.retentionDays, now = new Date() } = {}) {
    const cutoff = this._cutoff(days, now);
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
