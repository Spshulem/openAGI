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

export class BudgetGuard {
  constructor(options = {}) {
    this.storePath = options.storePath ?? path.join(resolveDataDir(), "budget", "usage.json");
    this.dailyUsdLimit = options.dailyUsdLimit ?? Number.parseFloat(process.env.OPENAGI_DAILY_USD_LIMIT ?? "10");
    this.prices = { ...DEFAULT_PRICES, ...(options.prices ?? {}) };
    ensureDir(path.dirname(this.storePath));
    this.state = readJsonFile(this.storePath, { version: 1, days: {} });
    this.ledger = options.ledger ?? new CreditLedger({ storePath: path.join(path.dirname(this.storePath), "ledger.jsonl") });
  }

  todayKey() {
    return new Date().toISOString().slice(0, 10);
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
    const today = this.todayKey();
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
        at: nowIso(),
        model,
        tokens,
        usd,
        channel: meta.channel ?? null,
        agentId: meta.agentId ?? null,
        sessionId: meta.sessionId ?? null,
        from: meta.from ?? null,
        tools: Array.isArray(meta.tools) ? meta.tools : []
      });
    } catch { /* ledger is best-effort; never break a reply over it */ }

    this.persist();
    return { added: usd, today: day.usd, limit: this.dailyUsdLimit };
  }

  // A call priced by its caller (realtime voice bills audio tokens, which the
  // table above has no column for). Counts toward the day like any call and
  // writes a ledger row with its channel.
  recordUsd(usd, model, meta = {}) {
    const added = Number.isFinite(Number(usd)) ? Math.max(0, Number(usd)) : 0;
    const today = this.todayKey();
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
        at: nowIso(), model, tokens, usd: added,
        channel: meta.channel ?? null, agentId: meta.agentId ?? null, sessionId: meta.sessionId ?? null,
        from: meta.from ?? null, tools: Array.isArray(meta.tools) ? meta.tools : []
      });
    } catch (error) { if (meta.channel === "voice") throw error; }
    this.persist();
    return { added, today: day.usd, limit: this.dailyUsdLimit };
  }

  // USD one channel spent today (UTC day, as todayKey), from the ledger.
  channelUsdToday(channel) {
    try {
      const ledgerUsd = (this.ledger?.query({ days: 1 }) ?? []).filter((row) => row.channel === channel).reduce((sum, row) => sum + Number(row.usd ?? 0), 0);
      return channel === "voice" ? Math.max(ledgerUsd, this.state.days[this.todayKey()]?.voiceUsd ?? 0) : ledgerUsd;
    } catch {
      return channel === "voice" ? (this.state.days[this.todayKey()]?.voiceUsd ?? 0) : 0;
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
