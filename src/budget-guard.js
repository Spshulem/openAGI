import path from "node:path";
import { ensureDir, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";
import { nowIso } from "./utils.js";
import { CreditLedger } from "./credit-ledger.js";

// USD per 1M tokens. Keep specific variants (…-nano, …-mini, …-5.5) listed so
// priceFor's longest-prefix match doesn't bill a nano call at flagship rates.
const DEFAULT_PRICES = {
  "claude-sonnet-4-6": { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-opus-4-7": { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-haiku-4-5": { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  // gpt-5.6 ships as three named variants rather than a size ladder. All three
  // are listed because priceFor falls back to the longest matching PREFIX, and
  // "gpt-5.6-luna" would otherwise silently bill at the "gpt-5" flagship rate —
  // 25x luna's real input price, against a daily cap that silences the agent
  // when it trips.
  "gpt-5.6-luna": { in: 0.2, out: 1.2, cacheRead: 0.02, cacheWrite: 0 },
  // gpt-6 pairs a flagship (astra) with a cheap variant (luna) at 100x apart.
  // Neither key is a prefix of the other, so a dated suffix like
  // "gpt-6-luna-2026-10-01" can only land on its own row. Prompts past 272K
  // input tokens are repriced for the whole request; that multiplier is not
  // published, so it is not modelled here (the per-call input cap in the
  // providers keeps chat turns far below it).
  "gpt-6-astra": { in: 10, out: 50, cacheRead: 1, cacheWrite: 12.5 },
  // gpt-6.1-sol / gpt-6.2-sol (the owner's ceiling): past 272K input tokens the whole
  // request bills at 2x input/cache and 1.5x output; the cap keeps calls under.
  "gpt-6.2-astra": { in: 10, out: 50, cacheRead: 1, cacheWrite: 12.5 },
  "gpt-6.2-sol": { in: 2, out: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "gpt-6.2-luna": { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "gpt-6.1-sol": { in: 2, out: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "gpt-6-luna": { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "gpt-5.6-terra": { in: 2, out: 12, cacheRead: 0.2, cacheWrite: 0 },
  "gpt-5.6-sol": { in: 5, out: 30, cacheRead: 0.5, cacheWrite: 0 },
  "gpt-5.5": { in: 5, out: 30, cacheRead: 0.5, cacheWrite: 0 },
  "gpt-5.4-mini": { in: 0.75, out: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  "gpt-5.4-nano": { in: 0.2, out: 1.25, cacheRead: 0.02, cacheWrite: 0 },
  "gpt-5-mini": { in: 0.25, out: 2, cacheRead: 0.025, cacheWrite: 0 },
  "gpt-5-nano": { in: 0.05, out: 0.4, cacheRead: 0.005, cacheWrite: 0 },
  "gpt-5": { in: 5, out: 15, cacheRead: 0.5, cacheWrite: 0 },
  // Embeddings are the highest-CALL-VOLUME model in a live install (vector
  // store writes), and they match none of the chat prefixes above — so without
  // these they fell through to `default` and billed at $3/1M instead of $0.02,
  // a 150x over-count on the meter that silences the agent when it trips.
  // Output/cache columns are zero because embeddings have neither.
  "text-embedding-3-small": { in: 0.02, out: 0, cacheRead: 0, cacheWrite: 0 },
  "text-embedding-3-large": { in: 0.13, out: 0, cacheRead: 0, cacheWrite: 0 },
  default: { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 }
};

const TIMEZONE_FORMATTERS = new Map();

export function resolveBudgetTimeZone(candidate) {
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.length > 80) return null;
  if (trimmed === "Etc/UTC" || trimmed === "Etc/GMT" || trimmed === "GMT") return "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", {
      timeZone: trimmed,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date(0));
    return trimmed;
  } catch {
    return null;
  }
}

function formatDayInTimeZone(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const zone = resolveBudgetTimeZone(timeZone) ?? "UTC";
  let formatter = TIMEZONE_FORMATTERS.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    TIMEZONE_FORMATTERS.set(zone, formatter);
  }
  return formatter.format(date);
}

export class BudgetGuard {
  constructor(options = {}) {
    this.storePath = options.storePath ?? path.join(resolveDataDir(), "budget", "usage.json");
    this.dailyUsdLimit = options.dailyUsdLimit ?? Number.parseFloat(process.env.OPENAGI_DAILY_USD_LIMIT ?? "10");
    this.prices = { ...DEFAULT_PRICES, ...(options.prices ?? {}) };
    this._now = typeof options.now === "function" ? options.now : () => new Date();
    ensureDir(path.dirname(this.storePath));
    this.state = readJsonFile(this.storePath, { version: 1, days: {} });
    this.ledger = options.ledger ?? new CreditLedger({ storePath: path.join(path.dirname(this.storePath), "ledger.jsonl") });
    this._explicitTimeZone = resolveBudgetTimeZone(options.timeZone)
      ?? resolveBudgetTimeZone(process.env.OPENAGI_TIMEZONE ?? process.env.OPENAGI_TIME_ZONE)
      ?? null;
    this.timeZone = this._explicitTimeZone
      ?? resolveBudgetTimeZone(this.state.timeZone)
      ?? resolveBudgetTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone)
      ?? "UTC";
    this._syncTimeZoneBuckets({ persistIfEmpty: false });
  }

  dayKeyFor(value, timeZone = this.timeZone) {
    return formatDayInTimeZone(value, timeZone);
  }

  todayKey(now = this._now()) {
    return formatDayInTimeZone(now, this.timeZone) ?? new Date().toISOString().slice(0, 10);
  }

  _syncTimeZoneBuckets({ persistIfEmpty = true } = {}) {
    const prevZone = resolveBudgetTimeZone(this.state.daysTimeZone) ?? "UTC";
    if (prevZone === this.timeZone) {
      this.state.daysTimeZone = this.timeZone;
      return false;
    }
    const rows = typeof this.ledger?._readAll === "function"
      ? this.ledger._readAll()
      : (this.ledger?.query?.({ days: 30, now: this._now() }) ?? []);
    if (rows.length > 0) {
      const rebucketed = {};
      let minCoveredKey = null;
      for (const row of rows) {
        if (!row?.at) continue;
        const nextKey = this.dayKeyFor(row.at, this.timeZone);
        const oldKey = this.dayKeyFor(row.at, prevZone);
        if (!nextKey) continue;
        for (const candidateKey of [nextKey, oldKey]) {
          if (candidateKey && (!minCoveredKey || candidateKey < minCoveredKey)) {
            minCoveredKey = candidateKey;
          }
        }
        const day = (rebucketed[nextKey] ??= {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          usd: 0,
          calls: 0
        });
        const tokens = row.tokens ?? {};
        const usd = Number.isFinite(Number(row.usd)) ? Math.max(0, Number(row.usd)) : 0;
        day.input += Number(tokens.input ?? 0) || 0;
        day.output += Number(tokens.output ?? 0) || 0;
        day.cacheRead += Number(tokens.cacheRead ?? 0) || 0;
        day.cacheWrite += Number(tokens.cacheWrite ?? 0) || 0;
        day.usd += usd;
        if (row.channel === "voice") day.voiceUsd = (day.voiceUsd ?? 0) + usd;
        day.calls += 1;
      }
      if (minCoveredKey) {
        this.state.days ??= {};
        for (const existingKey of Object.keys(this.state.days)) {
          if (existingKey >= minCoveredKey) {
            delete this.state.days[existingKey];
          }
        }
        for (const [k, bucket] of Object.entries(rebucketed)) {
          this.state.days[k] = bucket;
        }
      }
    }
    this.state.daysTimeZone = this.timeZone;
    if (persistIfEmpty || rows.length > 0 || Object.keys(this.state.days ?? {}).length > 0) {
      this.persist();
    }
    return true;
  }

  setTimeZone(candidate) {
    const valid = resolveBudgetTimeZone(candidate);
    if (!valid) {
      const err = new Error("Invalid IANA time zone.");
      err.code = "INVALID_BUDGET";
      throw err;
    }
    this.timeZone = valid;
    this.state.timeZone = valid;
    this._syncTimeZoneBuckets({ persistIfEmpty: true });
    this.persist();
    return this.status();
  }

  adoptClientTimeZone(candidate) {
    const valid = resolveBudgetTimeZone(candidate);
    if (!valid) return false;
    if (this._explicitTimeZone) return false;
    if (valid === "UTC" && this.timeZone !== "UTC") return false;
    if (valid === this.timeZone && this.state.timeZone === valid && this.state.daysTimeZone === valid) {
      return false;
    }
    this.timeZone = valid;
    this.state.timeZone = valid;
    this._syncTimeZoneBuckets({ persistIfEmpty: true });
    this.persist();
    return true;
  }

  bonusTodayUsd() {
    const raw = Number(this.state.bonusByDay?.[this.todayKey()] ?? 0);
    return Number.isFinite(raw) && raw > 0 ? Number(raw.toFixed(4)) : 0;
  }

  effectiveDailyLimitUsd() {
    return Number((this.dailyUsdLimit + this.bonusTodayUsd()).toFixed(4));
  }

  setDailyLimit(limitUsd) {
    const parsed = Number(limitUsd);
    if (!Number.isFinite(parsed) || parsed < 0.5 || parsed > 10000) {
      const err = new Error("Daily budget limit must be between $0.50 and $10,000.");
      err.code = "INVALID_BUDGET";
      throw err;
    }
    this.dailyUsdLimit = Number(parsed.toFixed(2));
    return this.status();
  }

  addBonusToday(addUsd) {
    const parsed = Number(addUsd);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 10000) {
      const err = new Error("Added budget must be between $0.01 and $10,000.");
      err.code = "INVALID_BUDGET";
      throw err;
    }
    const today = this.todayKey();
    this.state.bonusByDay ??= {};
    this.state.bonusByDay[today] = Number((this.bonusTodayUsd() + parsed).toFixed(2));
    const keepKeys = new Set(
      Object.keys(this.state.bonusByDay)
        .sort((a, b) => b.localeCompare(a))
        .slice(0, 14)
    );
    keepKeys.add(today);
    for (const key of Object.keys(this.state.bonusByDay)) {
      if (!keepKeys.has(key)) delete this.state.bonusByDay[key];
    }
    this.persist();
    return this.status();
  }

  clearBonusToday() {
    const today = this.todayKey();
    if (this.state.bonusByDay && today in this.state.bonusByDay) {
      delete this.state.bonusByDay[today];
      this.persist();
    }
    return this.status();
  }

  status() {
    const today = this.todayKey();
    const day = this.state.days[today] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, calls: 0 };
    const bonusUsdToday = this.bonusTodayUsd();
    const effectiveLimitUsd = this.effectiveDailyLimitUsd();
    const reservedUsd = Object.values(this.voiceReservationsToday()).reduce((sum, usd) => sum + usd, 0);
    return {
      today,
      timeZone: this.timeZone,
      dailyUsdLimit: this.dailyUsdLimit,
      bonusUsdToday,
      effectiveLimitUsd,
      spentUsd: Number(day.usd.toFixed(4)),
      remainingUsd: Number((effectiveLimitUsd - day.usd).toFixed(4)),
      exceeded: day.usd + reservedUsd >= effectiveLimitUsd,
      calls: day.calls,
      tokens: { input: day.input, output: day.output, cacheRead: day.cacheRead, cacheWrite: day.cacheWrite },
      history: Object.entries(this.state.days)
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 14)
        .map(([date, d]) => ({ date, usd: Number(d.usd.toFixed(4)), calls: d.calls }))
    };
  }

  check(additionalUsd = 0) {
    const today = this.todayKey();
    const day = this.state.days[today] ?? { usd: 0 };
    const reservedUsd = Object.values(this.voiceReservationsToday()).reduce((sum, usd) => sum + usd, 0);
    const effectiveLimit = this.effectiveDailyLimitUsd();
    if (day.usd + reservedUsd + additionalUsd >= effectiveLimit) {
      const error = new Error(
        `Daily budget reached: $${day.usd.toFixed(4)} of $${effectiveLimit.toFixed(2)}. ` +
        `Add budget or raise your daily limit in Settings.`
      );
      error.code = "BUDGET_EXCEEDED";
      throw error;
    }
  }

  record(usage, model, meta = {}) {
    if (!usage) return null;
    const now = meta.now instanceof Date ? meta.now : this._now();
    const today = this.todayKey(now);
    this.state.daysTimeZone = this.timeZone;
    if (!this.state.days[today]) this.state.days[today] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, calls: 0 };

    const tokens = normalizeUsage(usage);
    const usd = this.usdFor(tokens, model);

    const day = this.state.days[today];
    day.input += tokens.input;
    day.output += tokens.output;
    day.cacheRead += tokens.cacheRead;
    day.cacheWrite += tokens.cacheWrite;
    day.usd += usd;
    day.calls += 1;

    try {
      this.ledger?.record({
        at: meta.at ?? now.toISOString(),
        model,
        tokens,
        usd,
        channel: meta.channel ?? null,
        agentId: meta.agentId ?? null,
        sessionId: meta.sessionId ?? null,
        from: meta.from ?? null,
        tools: Array.isArray(meta.tools) ? meta.tools : []
      }, { now });
    } catch { /* ledger is best-effort; never break a reply over it */ }

    this.persist();
    return { added: usd, today: day.usd, limit: this.dailyUsdLimit };
  }

  // A call priced by its caller (realtime voice bills audio tokens, which the
  // table above has no column for). Counts toward the day like any call and
  // writes a ledger row with its channel.
  recordUsd(usd, model, meta = {}) {
    const added = Number.isFinite(Number(usd)) ? Math.max(0, Number(usd)) : 0;
    const now = meta.now instanceof Date ? meta.now : this._now();
    const today = this.todayKey(now);
    this.state.daysTimeZone = this.timeZone;
    if (!this.state.days[today]) this.state.days[today] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, calls: 0 };
    const day = this.state.days[today];
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...(meta.tokens ?? {}) };
    day.input += tokens.input;
    day.output += tokens.output;
    day.cacheRead += tokens.cacheRead;
    day.usd += added;
    if (meta.channel === "voice") day.voiceUsd = (day.voiceUsd ?? 0) + added;
    day.calls += 1;
    try {
      this.ledger?.record({
        at: meta.at ?? now.toISOString(), model, tokens, usd: added,
        channel: meta.channel ?? null, agentId: meta.agentId ?? null, sessionId: meta.sessionId ?? null,
        from: meta.from ?? null, tools: Array.isArray(meta.tools) ? meta.tools : []
      }, { now });
    } catch (error) { if (meta.channel === "voice") throw error; }
    this.persist();
    return { added, today: day.usd, limit: this.dailyUsdLimit };
  }

  // USD one channel spent today (in the guard's configured local day), from the ledger.
  channelUsdToday(channel) {
    const today = this.todayKey();
    try {
      const ledgerUsd = (this.ledger?.query({ days: 2, now: this._now() }) ?? [])
        .filter((row) => row.channel === channel && this.dayKeyFor(row.at) === today)
        .reduce((sum, row) => sum + Number(row.usd ?? 0), 0);
      return channel === "voice" ? Math.max(ledgerUsd, this.state.days[today]?.voiceUsd ?? 0) : ledgerUsd;
    } catch {
      return channel === "voice" ? (this.state.days[today]?.voiceUsd ?? 0) : 0;
    }
  }

  voiceReservationsToday() {
    return { ...(this.state.voiceReservations?.[this.todayKey()] ?? {}) };
  }

  setVoiceReservation(id, usd) {
    const day = this.todayKey();
    this.state.voiceReservations ??= {};
    this.state.voiceReservations[day] ??= {};
    if (usd > 0) this.state.voiceReservations[day][id] = usd;
    else delete this.state.voiceReservations[day][id];
    for (const key of Object.keys(this.state.voiceReservations)) if (key !== day) delete this.state.voiceReservations[key];
    this.persist();
  }

  // Estimated USD for one call's usage, without recording it. Providers use
  // this to total a single agent turn across its tool hops.
  costOf(usage, model) {
    if (!usage) return 0;
    return this.usdFor(normalizeUsage(usage), model);
  }

  // A row with no cache-write rate (cacheWrite 0 or missing, as on the gpt-5
  // rows) bills written tokens as normal input: normalizeUsage has already
  // taken them out of input, so a 0 rate would make them free.
  usdFor(tokens, model) {
    const price = this.priceFor(model);
    const cacheWrite = price.cacheWrite > 0 ? price.cacheWrite : price.in;
    return (tokens.input / 1e6) * price.in +
      (tokens.output / 1e6) * price.out +
      (tokens.cacheRead / 1e6) * price.cacheRead +
      (tokens.cacheWrite / 1e6) * cacheWrite;
  }

  priceFor(model) {
    if (!model) return this.prices.default;
    const exact = this.prices[model];
    if (exact) return exact;
    // Longest matching prefix wins, so "gpt-5.4-nano" resolves to the nano
    // price, not "gpt-5" (flagship). A short prefix like "gpt-5" must never
    // shadow a more specific variant.
    const prefix = Object.keys(this.prices)
      .filter((key) => key !== "default" && model.startsWith(key))
      .sort((a, b) => b.length - a.length)[0];
    return prefix ? this.prices[prefix] : this.prices.default;
  }

  persist() {
    writeJsonAtomic(this.storePath, this.state);
  }
}

// Three usage shapes reach the meter:
//   Anthropic          input_tokens EXCLUDES cache reads/writes, which arrive
//                      as cache_read_input_tokens / cache_creation_input_tokens.
//   OpenAI Responses   input_tokens INCLUDES input_tokens_details.cached_tokens
//                      and .cache_write_tokens.
//   Chat Completions   prompt_tokens INCLUDES prompt_tokens_details.cached_tokens.
// The OpenAI totals are split so cached tokens bill once, at the cached price,
// instead of at the full input price (and again as a cache read).
export function normalizeUsage(usage) {
  const details = usage.input_tokens_details ?? usage.prompt_tokens_details ?? null;
  const output = usage.output_tokens ?? usage.completion_tokens ?? 0;
  if (details || usage.prompt_tokens != null) {
    const total = usage.input_tokens ?? usage.prompt_tokens ?? 0;
    const cacheRead = details?.cached_tokens ?? 0;
    const cacheWrite = details?.cache_write_tokens ?? 0;
    return {
      input: Math.max(0, total - cacheRead - cacheWrite),
      output,
      cacheRead,
      cacheWrite
    };
  }
  return {
    input: usage.input_tokens ?? 0,
    output,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0
  };
}
