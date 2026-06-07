import path from "node:path";
import { ensureDir, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { resolveDataDir } from "./data-dir.js";
import { nowIso } from "./utils.js";
import { CreditLedger } from "./credit-ledger.js";

const DEFAULT_PRICES = {
  "claude-sonnet-4-6": { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-opus-4-7": { in: 15, out: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-haiku-4-5": { in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "gpt-5": { in: 5, out: 15, cacheRead: 0.5, cacheWrite: 0 },
  "gpt-5-mini": { in: 0.25, out: 2, cacheRead: 0.025, cacheWrite: 0 },
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

  status() {
    const today = this.todayKey();
    const day = this.state.days[today] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0, calls: 0 };
    return {
      today,
      dailyUsdLimit: this.dailyUsdLimit,
      spentUsd: Number(day.usd.toFixed(4)),
      remainingUsd: Number((this.dailyUsdLimit - day.usd).toFixed(4)),
      calls: day.calls,
      tokens: { input: day.input, output: day.output, cacheRead: day.cacheRead, cacheWrite: day.cacheWrite },
      history: Object.entries(this.state.days)
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 14)
        .map(([date, d]) => ({ date, usd: Number(d.usd.toFixed(4)), calls: d.calls }))
    };
  }

  check() {
    const today = this.todayKey();
    const day = this.state.days[today] ?? { usd: 0 };
    if (day.usd >= this.dailyUsdLimit) {
      const error = new Error(
        `Daily budget reached: $${day.usd.toFixed(4)} of $${this.dailyUsdLimit.toFixed(2)}. ` +
        `Raise OPENAGI_DAILY_USD_LIMIT or wait until tomorrow.`
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
    const price = this.priceFor(model);
    const usd =
      (tokens.input / 1e6) * price.in +
      (tokens.output / 1e6) * price.out +
      (tokens.cacheRead / 1e6) * price.cacheRead +
      (tokens.cacheWrite / 1e6) * price.cacheWrite;

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

  priceFor(model) {
    if (!model) return this.prices.default;
    const exact = this.prices[model];
    if (exact) return exact;
    const prefix = Object.keys(this.prices).find((key) => model.startsWith(key));
    return prefix ? this.prices[prefix] : this.prices.default;
  }

  persist() {
    writeJsonAtomic(this.storePath, this.state);
  }
}

function normalizeUsage(usage) {
  return {
    input: usage.input_tokens ?? usage.prompt_tokens ?? 0,
    output: usage.output_tokens ?? usage.completion_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0
  };
}
