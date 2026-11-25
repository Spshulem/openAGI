// One GitHub GraphQL budget per account, shared by everything here that
// calls `gh`: the scan's PR pollers, fleet_repo_status, the pre-send PR
// check and the owner's Merge. Once GitHub says the budget is gone (primary
// limit) or to slow down (secondary limit), every caller here waits out the
// same cooldown instead of each finding out by failing again, and a restart
// keeps it (the file). Background pollers also stop early, when the
// remaining budget runs low, so the owner's own actions still have some.
//
// Cooldown signals, best first:
// - a GraphQL response's rateLimit { remaining resetAt } (the fleet queries
//   ask for it; GitHub answers it even when the budget is used up);
// - one `rateLimit` probe right after a throttle error that carried no reset
//   time (cost 1; at most one per cooldown);
// - Retry-After, when the output carries it (secondary limits);
// - otherwise a bounded backoff.
// REST /rate_limit is not used: on 2026-11-22 it showed 2,492 GraphQL points
// left while GraphQL itself answered remaining 0 with a later reset.
import { readJsonFile, writeJsonAtomic } from "../file-utils.js";

const PRIMARY = /API rate limit (?:already )?exceeded|graphql_rate_limit|"type"\s*:\s*"RATE_LIMIT(?:ED)?"/i;
const SECONDARY = /secondary rate limit|abuse detection|triggered an abuse/i;
const RETRY_AFTER = /retry-after:\s*(\d{1,6})/i;
// Background pollers stop at or below this many points left in the window.
export const BACKGROUND_FLOOR = 150;
const RESET_PAD_MS = 5_000;
const PRIMARY_BACKOFF_MS = [5 * 60_000, 10 * 60_000, 30 * 60_000];
const SECONDARY_MIN_MS = 60_000;
const SECONDARY_MAX_MS = 15 * 60_000;
// A reset GitHub reports further out than its one-hour window is not trusted.
const MAX_COOLDOWN_MS = 65 * 60_000;
const PROBE_QUERY = "query={ rateLimit { remaining resetAt } }";
// How much a hold stops: low budget pauses background polling only.
const STRENGTH = { "low-budget": 1, primary: 2, secondary: 2 };
const PROBE_TIMEOUT_MS = 15_000;

// A gh failure's text -> { kind: "primary" | "secondary", retryAfterSec } or null.
export function classifyGithubThrottle(text) {
  const s = String(text ?? "");
  const retryAfterSec = Number(s.match(RETRY_AFTER)?.[1]) || null;
  if (SECONDARY.test(s)) return { kind: "secondary", retryAfterSec };
  if (PRIMARY.test(s)) return { kind: "primary", retryAfterSec };
  return null;
}

// The text of a GraphQL answer's own errors ("type", "code", "message"),
// never its data: a PR body or comment that mentions a rate limit is
// repository content, not GitHub refusing the request.
export function graphqlErrorText(stdout) {
  let body;
  try { body = JSON.parse(String(stdout ?? "")); } catch { return ""; }
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  return errors.map((e) => [e?.type, e?.code, e?.message].filter((v) => typeof v === "string").join(" ")).join("\n");
}

// The rateLimit block a GraphQL answer carries, or null.
export function readRateLimit(stdout) {
  let body;
  try { body = JSON.parse(String(stdout ?? "")); } catch { return null; }
  const rate = body?.data?.rateLimit;
  if (!rate || !Number.isFinite(Number(rate.remaining))) return null;
  const resetAt = Number.isFinite(Date.parse(rate.resetAt ?? "")) ? rate.resetAt : null;
  return { remaining: Number(rate.remaining), resetAt };
}

function hhmm(ms) {
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

// Two independent holds, so no order of concurrent answers can weaken one:
// - slow: GitHub asked this account to slow down (secondary limit). It
//   stops every caller until its own time.
// - budget: the GraphQL budget window. "low-budget" pauses background
//   polling only; "primary" (used up) stops everyone. Within a window it
//   only ever upgrades; a later window clears it.
// The effective hold for a caller is whichever of the two applies.
export class GithubThrottle {
  constructor({ now = () => Date.now(), file = null, floor = BACKGROUND_FLOOR } = {}) {
    this.now = now;
    this.floor = floor;
    this.slow = null;
    this.budget = null;
    this.primaryStreak = 0;
    this.secondaryStreak = 0;
    this.inflight = new Map();
    this.configure({ file });
  }

  // Where the holds survive a restart; one already over is dropped. The
  // earlier single-hold file format is read as one slot or the other.
  configure({ file = null } = {}) {
    this.file = file;
    if (!file) return this;
    const saved = readJsonFile(file, null);
    if (saved?.version === 2) {
      this.slow = saved.slow ?? null;
      this.budget = saved.budget ?? null;
    } else if (saved && saved.until) {
      const { then, ...hold } = saved;
      if (hold.kind === "secondary") {
        this.slow = { until: hold.until, since: hold.since ?? null };
        if (then && then.kind !== "secondary") this.budget = then;
      } else {
        this.budget = hold;
      }
    }
    this.expire();
    return this;
  }

  // Drops a hold whose time is over.
  expire() {
    const now = this.now();
    let changed = false;
    if (this.slow && !(Date.parse(this.slow.until) > now)) { this.slow = null; changed = true; }
    if (this.budget && !(Date.parse(this.budget.until) > now)) { this.budget = null; changed = true; }
    if (changed) this.save();
  }

  slowView() {
    return this.slow ? { kind: "secondary", until: this.slow.until, since: this.slow.since ?? null, resetKnown: true } : null;
  }

  // The hold that applies to background polling: the longer-blocking of the
  // two, preferring one that also stops owner actions.
  current() {
    this.expire();
    const slow = this.slowView();
    const budget = this.budget;
    if (!slow) return budget;
    if (!budget) return slow;
    if (budget.kind === "primary" && Date.parse(budget.until) > Date.parse(slow.until)) return budget;
    return slow;
  }

  // The hold this caller must respect, or null. A low budget stops only
  // background polling; a used-up budget or a slow-down stops everyone.
  blocking({ background = true } = {}) {
    this.expire();
    let hold;
    if (background) {
      hold = this.current();
    } else {
      const slow = this.slowView();
      const used = this.budget?.kind === "primary" ? this.budget : null;
      hold = slow && used ? (Date.parse(used.until) > Date.parse(slow.until) ? used : slow) : slow ?? used;
    }
    return hold ? { ...hold, message: this.describe(hold) } : null;
  }

  describe(cooldown = this.current()) {
    if (!cooldown) return "";
    const until = hhmm(Date.parse(cooldown.until));
    if (cooldown.kind === "secondary") return `GitHub asked this account to slow down (secondary rate limit); waiting until ${until}.`;
    if (cooldown.kind === "low-budget") return `GitHub GraphQL budget is low (${cooldown.remaining ?? "few"} points left until ${until}); background checks are paused to keep it for your own actions.`;
    return `GitHub's GraphQL rate limit for this account is used up until ${until}${cooldown.resetKnown ? "" : " (estimated; GitHub gave no reset time)"}.`;
  }

  // Reads one gh result: a throttle error starts or extends a hold, a
  // rateLimit block sets the budget. Returns the throttle seen, or null.
  observe(result) {
    // Only a failed call's own output, or GraphQL's structured errors, can
    // say GitHub refused it. A successful answer's data is never searched.
    // Success is an exit code of 0 with no error; a timeout (code null) or
    // any other result is a failure whose output may name a throttle.
    const failed = Boolean(result?.error) || result?.code !== 0;
    const text = `${failed ? `${result?.stderr ?? ""}\n${result?.error ?? ""}\n` : ""}${graphqlErrorText(result?.stdout)}`;
    const throttled = classifyGithubThrottle(text);
    const rate = readRateLimit(result?.stdout);
    if (throttled) {
      this.enter(throttled.kind, { resetAt: rate?.resetAt ?? null, retryAfterSec: throttled.retryAfterSec, remaining: rate?.remaining ?? 0 });
      return throttled;
    }
    if (rate) this.noteBudget(rate);
    return null;
  }

  noteBudget({ remaining, resetAt }) {
    if (remaining <= this.floor && resetAt) {
      this.enter(remaining <= 0 ? "primary" : "low-budget", { resetAt, remaining });
      return;
    }
    // A fresh window: the budget hold is over. Only a response from a later
    // window counts: a delayed answer from the same window (two reads in
    // flight) must not lift it. GitHub's slow-down is not budget: it stays.
    this.expire();
    if (remaining > this.floor && this.budget && this.isNewerWindow(resetAt)) {
      this.budget = null;
      this.primaryStreak = 0;
      this.save();
    }
  }

  isNewerWindow(resetAt) {
    const reset = Date.parse(resetAt ?? "");
    if (!Number.isFinite(reset)) return false;
    const held = Date.parse(this.budget?.windowResetAt ?? "");
    // A hold with no known window (estimated) ends with any window that
    // resets after it began.
    if (!Number.isFinite(held)) return reset > (Date.parse(this.budget?.since ?? "") || 0);
    return reset > held + 1000;
  }

  enter(kind, { resetAt = null, retryAfterSec = null, remaining = null } = {}) {
    const now = this.now();
    this.expire();
    if (kind === "secondary") {
      this.secondaryStreak += 1;
      const base = Math.max(SECONDARY_MIN_MS, (retryAfterSec ?? 0) * 1000);
      const until = now + Math.min(SECONDARY_MAX_MS, base * 2 ** (this.secondaryStreak - 1));
      // Never shortened by a later, shorter request to slow down.
      if (!this.slow || Date.parse(this.slow.until) < until) {
        this.slow = { until: new Date(until).toISOString(), since: this.slow?.since ?? new Date(now).toISOString() };
        this.save();
      }
      return this.current();
    }
    let until;
    let resetKnown = false;
    const reset = Date.parse(resetAt ?? "");
    if (Number.isFinite(reset) && reset > now && reset - now <= MAX_COOLDOWN_MS) {
      until = reset + RESET_PAD_MS;
      resetKnown = true;
    } else if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
      until = now + Math.min(MAX_COOLDOWN_MS, retryAfterSec * 1000);
      resetKnown = true;
    } else {
      this.primaryStreak += 1;
      until = now + PRIMARY_BACKOFF_MS[Math.min(PRIMARY_BACKOFF_MS.length - 1, this.primaryStreak - 1)];
    }
    const window = Number.isFinite(reset) ? new Date(reset).toISOString() : null;
    const previous = this.budget;
    if (!previous) {
      this.budget = { kind, until: new Date(until).toISOString(), since: new Date(now).toISOString(), resetKnown, ...(window ? { windowResetAt: window } : {}), probed: false, ...(Number.isFinite(remaining) ? { remaining } : {}) };
      this.save();
      return this.current();
    }
    // Within a window the budget hold only upgrades (low → used up), never
    // the other way, and never ends sooner, except that a known reset
    // replaces an estimated one of the same kind.
    const upgraded = STRENGTH[kind] > STRENGTH[previous.kind];
    const keptKind = upgraded ? kind : previous.kind;
    const sharper = resetKnown && !previous.resetKnown && kind === previous.kind;
    const prevUntil = Date.parse(previous.until);
    const nextUntil = sharper ? until : Math.max(prevUntil, until);
    const nextResetKnown = sharper ? true : (resetKnown && until >= prevUntil) || previous.resetKnown === true;
    if (!upgraded && !sharper && nextUntil === prevUntil) return this.current();
    this.budget = {
      ...previous,
      kind: keptKind,
      until: new Date(nextUntil).toISOString(),
      resetKnown: nextResetKnown,
      ...(window ? { windowResetAt: window } : {}),
      probed: previous.probed === true && !nextResetKnown,
      ...(Number.isFinite(remaining) && (upgraded || kind === keptKind) ? { remaining } : {})
    };
    this.save();
    return this.current();
  }

  // A used-up budget with no reset time yet asks GitHub for it, once, and
  // never while GitHub has asked this account to slow down.
  needsProbe() {
    this.expire();
    return Boolean(!this.slow && this.budget && this.budget.kind === "primary" && !this.budget.resetKnown && !this.budget.probed);
  }

  async probe(run, ghBin = "gh") {
    if (!this.needsProbe()) return this.current();
    this.budget.probed = true;
    this.save();
    try {
      const result = await run(ghBin, ["api", "graphql", "-f", PROBE_QUERY], { timeoutMs: PROBE_TIMEOUT_MS });
      // The probe's answer is read like any other when it says something new:
      // a secondary limit with Retry-After is kept, and a rateLimit block
      // sets the budget (a known reset, or a new window). The same "used up"
      // with still no reset is not a second exhaustion: it changes nothing.
      // observe() never probes, and this hold is already marked probed.
      const failed = Boolean(result?.error) || result?.code !== 0;
      const seen = classifyGithubThrottle(`${failed ? `${result?.stderr ?? ""}\n${result?.error ?? ""}\n` : ""}${graphqlErrorText(result?.stdout)}`);
      const sameAgain = seen?.kind === "primary" && !readRateLimit(result?.stdout)?.resetAt && !seen.retryAfterSec;
      if (!sameAgain) this.observe(result);
    } catch { /* keep the estimated hold */ }
    return this.current();
  }

  save() {
    if (!this.file) return;
    try { writeJsonAtomic(this.file, { version: 2, slow: this.slow, budget: this.budget }); } catch { /* memory still holds it */ }
  }
}

export const githubThrottle = new GithubThrottle();

// Runs one gh call under the shared budget. While a cooldown holds it,
// GitHub is not called: the result is a failure whose text says why and
// until when (throttled: true), so every caller's existing "GitHub could not
// answer" path handles it. coalesce: an identical read already in flight is
// shared, not repeated (never for a mutation such as a merge).
export async function throttledGh(run, ghBin, args, options = {}, { throttle = githubThrottle, background = true, coalesce = true } = {}) {
  const held = throttle.blocking({ background });
  if (held) return { code: 1, stdout: "", stderr: held.message, throttled: true, cooldown: held };
  const key = coalesce ? `${ghBin}\u0000${args.join("\u0000")}` : null;
  if (key && throttle.inflight.has(key)) return throttle.inflight.get(key);
  const call = (async () => {
    const result = await run(ghBin, args, options);
    const seen = throttle.observe(result);
    if (seen && throttle.needsProbe()) await throttle.probe(run, ghBin);
    return seen ? { ...result, throttled: true, cooldown: throttle.blocking({ background: false }) } : result;
  })();
  if (key) {
    throttle.inflight.set(key, call);
    call.finally(() => throttle.inflight.delete(key)).catch(() => {});
  }
  return call;
}

// One throttle per fleet data directory: the live supervisor, its tools and
// its merges share it; each test's temp directory gets its own.
const SHARED = new Map();
export function throttleFor(file) {
  if (!file) return githubThrottle;
  if (!SHARED.has(file)) SHARED.set(file, new GithubThrottle({ file }));
  return SHARED.get(file);
}
