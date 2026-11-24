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

export class GithubThrottle {
  constructor({ now = () => Date.now(), file = null, floor = BACKGROUND_FLOOR } = {}) {
    this.now = now;
    this.floor = floor;
    this.cooldown = null;
    this.primaryStreak = 0;
    this.secondaryStreak = 0;
    this.inflight = new Map();
    this.configure({ file });
  }

  // Where the cooldown survives a restart. A saved one already over is
  // dropped, unless the hold queued to follow it is still running: that one
  // takes over, exactly as it would have without the restart.
  configure({ file = null } = {}) {
    this.file = file;
    if (!file) return this;
    const saved = readJsonFile(file, null);
    const live = (hold) => Date.parse(hold?.until ?? "") > this.now();
    if (saved && (live(saved) || live(saved.then))) {
      this.cooldown = { ...saved };
      this.current();
    }
    return this;
  }

  current() {
    if (!this.cooldown) return null;
    if (Date.parse(this.cooldown.until) <= this.now()) {
      // A weaker hold that lasts longer takes over when this one ends.
      const then = this.cooldown.then;
      this.cooldown = then && Date.parse(then.until) > this.now() ? { ...then, since: new Date(this.now()).toISOString() } : null;
      this.save();
      return this.cooldown;
    }
    return this.cooldown;
  }

  // The cooldown this caller must respect, or null. A low budget stops only
  // background polling; a used-up budget or a slow-down stops everyone.
  blocking({ background = true } = {}) {
    const cooldown = this.current();
    if (!cooldown) return null;
    if (cooldown.kind === "low-budget" && !background) return null;
    return { ...cooldown, message: this.describe(cooldown) };
  }

  describe(cooldown = this.current()) {
    if (!cooldown) return "";
    const until = hhmm(Date.parse(cooldown.until));
    if (cooldown.kind === "secondary") return `GitHub asked this account to slow down (secondary rate limit); waiting until ${until}.`;
    if (cooldown.kind === "low-budget") return `GitHub GraphQL budget is low (${cooldown.remaining ?? "few"} points left until ${until}); background checks are paused to keep it for your own actions.`;
    return `GitHub's GraphQL rate limit for this account is used up until ${until}${cooldown.resetKnown ? "" : " (estimated; GitHub gave no reset time)"}.`;
  }

  // Reads one gh result: a throttle error starts or extends the cooldown, a
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
    // A fresh window: whatever held polling back is over. Only a response
    // from a later window counts: a delayed answer from the same window
    // (two reads in flight) must not lift a newer cooldown.
    if (remaining > this.floor && this.cooldown && this.cooldown.kind !== "secondary" && this.isNewerWindow(resetAt)) {
      this.cooldown = null;
      this.primaryStreak = 0;
      this.save();
    }
  }

  isNewerWindow(resetAt) {
    const reset = Date.parse(resetAt ?? "");
    if (!Number.isFinite(reset)) return false;
    const held = Date.parse(this.cooldown?.windowResetAt ?? "");
    // A cooldown with no known window (estimated) ends with any window
    // that resets after it began.
    if (!Number.isFinite(held)) return reset > (Date.parse(this.cooldown?.since ?? "") || 0);
    return reset > held + 1000;
  }

  enter(kind, { resetAt = null, retryAfterSec = null, remaining = null } = {}) {
    const now = this.now();
    let until;
    let resetKnown = false;
    if (kind === "secondary") {
      this.secondaryStreak += 1;
      const base = Math.max(SECONDARY_MIN_MS, (retryAfterSec ?? 0) * 1000);
      until = now + Math.min(SECONDARY_MAX_MS, base * 2 ** (this.secondaryStreak - 1));
    } else {
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
    }
    const previous = this.current();
    // Never shorten a stronger hold with a weaker or vaguer one. A stronger
    // observation (the budget is now used up, or GitHub asked to slow down)
    // upgrades a weaker hold (low budget: background only) and keeps the
    // later of the two deadlines, so owner actions stop reaching GitHub too.
    const stronger = previous && STRENGTH[kind] > STRENGTH[previous.kind];
    // A weaker observation never replaces a stronger hold while it lasts
    // (owner actions stay stopped through GitHub's own Retry-After). If it
    // lasts longer, it follows once the stronger hold ends.
    if (previous && STRENGTH[kind] < STRENGTH[previous.kind]) {
      if (until > Date.parse(previous.until) && !(Date.parse(previous.then?.until ?? "") >= until)) {
        previous.then = {
          kind, until: new Date(until).toISOString(), resetKnown, probed: false,
          ...(Number.isFinite(Date.parse(resetAt ?? "")) ? { windowResetAt: new Date(Date.parse(resetAt)).toISOString() } : {}),
          ...(Number.isFinite(remaining) ? { remaining } : {})
        };
        this.save();
      }
      return previous;
    }
    if (previous && Date.parse(previous.until) >= until && !stronger && !(resetKnown && !previous.resetKnown && kind === previous.kind)) return previous;
    if (stronger && Date.parse(previous.until) > until) {
      until = Date.parse(previous.until);
      resetKnown = resetKnown || previous.resetKnown === true;
    }
    this.cooldown = {
      kind,
      until: new Date(until).toISOString(),
      since: previous?.since ?? new Date(now).toISOString(),
      resetKnown,
      ...(kind !== "secondary" && Number.isFinite(Date.parse(resetAt ?? "")) ? { windowResetAt: new Date(Date.parse(resetAt)).toISOString() }
        : stronger && previous.windowResetAt ? { windowResetAt: previous.windowResetAt } : {}),
      probed: previous?.probed === true && !resetKnown,
      ...(Number.isFinite(remaining) ? { remaining } : {}),
      // A hold queued to follow the previous one still follows this one,
      // when it lasts longer: a later observation never drops it.
      ...(previous?.then && Date.parse(previous.then.until) > until ? { then: previous.then } : {})
    };
    this.save();
    return this.cooldown;
  }

  // A used-up budget with no reset time yet asks GitHub for it, once.
  needsProbe() {
    const cooldown = this.current();
    return Boolean(cooldown && cooldown.kind === "primary" && !cooldown.resetKnown && !cooldown.probed);
  }

  async probe(run, ghBin = "gh") {
    if (!this.needsProbe()) return this.current();
    this.cooldown.probed = true;
    this.save();
    try {
      const result = await run(ghBin, ["api", "graphql", "-f", PROBE_QUERY], { timeoutMs: PROBE_TIMEOUT_MS });
      const rate = readRateLimit(result?.stdout);
      if (rate?.resetAt && rate.remaining <= this.floor) {
        this.enter(rate.remaining <= 0 ? "primary" : "low-budget", { resetAt: rate.resetAt, remaining: rate.remaining });
      } else if (rate) {
        // Budget is back (a new window began): nothing to wait for.
        this.noteBudget(rate);
      }
    } catch { /* keep the estimated cooldown */ }
    return this.current();
  }

  save() {
    if (!this.file) return;
    try { writeJsonAtomic(this.file, this.cooldown ?? { until: null }); } catch { /* memory still holds it */ }
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
