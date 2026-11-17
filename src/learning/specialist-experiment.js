// Verdicts for the randomized specialist comparison (OPENAGI_ROUTING_MODE=
// experiment). A turn whose message matched a specialist is handed to it at
// random half the time; the turn and the work it produced record the arm.
// Per candidate specialist this compares the mean grounded score of its arm
// with the generalist's on the same kind of message, with a bootstrap
// interval on the difference:
//   earned    the interval lies above 0 (the specialist does better)
//   retire    the interval lies below 0 (the generalist does better)
//   undecided otherwise, or fewer than MIN_PER_ARM graded outcomes in an arm
// Only graded, not-weak outcomes count.

export const MIN_PER_ARM = 20;
export const BOOTSTRAP_RESAMPLES = 2000;
export const INTERVAL_LEVEL = 0.95;

const ARMS = new Set(["specialist", "generalist"]);

/** The candidate specialist and arm an outcome was recorded under, or null. */
export function experimentArmOf(outcome) {
  const meta = outcome?.metadata ?? {};
  const candidateId = meta.routingCandidateId ?? meta.routing?.candidateId ?? null;
  const arm = meta.routingArm ?? meta.routing?.arm ?? null;
  if (typeof candidateId !== "string" || !candidateId || !ARMS.has(arm)) return null;
  return { candidateId, arm };
}

function mean(values) {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
}

// Deterministic per specialist, so a verdict does not flip between runs on
// the same data.
function seedFor(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile bootstrap interval for mean(a) - mean(b). */
export function bootstrapDifference(a, b, { resamples = BOOTSTRAP_RESAMPLES, level = INTERVAL_LEVEL, random = Math.random } = {}) {
  const diffs = new Array(resamples);
  for (let r = 0; r < resamples; r += 1) {
    let sumA = 0;
    for (let i = 0; i < a.length; i += 1) sumA += a[Math.floor(random() * a.length)];
    let sumB = 0;
    for (let i = 0; i < b.length; i += 1) sumB += b[Math.floor(random() * b.length)];
    diffs[r] = sumA / a.length - sumB / b.length;
  }
  diffs.sort((x, y) => x - y);
  const tail = (1 - level) / 2;
  const lo = diffs[Math.max(0, Math.floor(tail * resamples))];
  const hi = diffs[Math.min(resamples - 1, Math.ceil((1 - tail) * resamples) - 1)];
  return [lo, hi];
}

/**
 * Map candidateId -> { verdict, specialist: { n, mean }, generalist: { n, mean }, difference, interval }.
 */
export function specialistExperimentVerdicts(outcomes, { minPerArm = MIN_PER_ARM, resamples = BOOTSTRAP_RESAMPLES } = {}) {
  const byCandidate = new Map();
  for (const outcome of outcomes ?? []) {
    if (typeof outcome?.groundedScore !== "number" || !Number.isFinite(outcome.groundedScore) || outcome.groundedWeak) continue;
    const tag = experimentArmOf(outcome);
    if (!tag) continue;
    if (!byCandidate.has(tag.candidateId)) byCandidate.set(tag.candidateId, { specialist: [], generalist: [] });
    byCandidate.get(tag.candidateId)[tag.arm].push(outcome.groundedScore);
  }
  const verdicts = new Map();
  for (const [candidateId, arms] of byCandidate) {
    const specialistMean = mean(arms.specialist);
    const generalistMean = mean(arms.generalist);
    const result = {
      verdict: "undecided",
      specialist: { n: arms.specialist.length, mean: specialistMean },
      generalist: { n: arms.generalist.length, mean: generalistMean },
      difference: specialistMean !== null && generalistMean !== null ? specialistMean - generalistMean : null,
      interval: null
    };
    if (arms.specialist.length >= minPerArm && arms.generalist.length >= minPerArm) {
      const interval = bootstrapDifference(arms.specialist, arms.generalist, {
        resamples,
        random: mulberry32(seedFor(candidateId))
      });
      result.interval = interval;
      if (interval[0] > 0) result.verdict = "earned";
      else if (interval[1] < 0) result.verdict = "retire";
    }
    verdicts.set(candidateId, result);
  }
  return verdicts;
}
