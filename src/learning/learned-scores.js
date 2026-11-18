import { learnedMode } from "./model-client.js";

// Optional learned scores from a local scoring service (model-client.js).
// Each use has its own flag. With no service configured every flag reads
// "off" and the runtime behaves exactly as it does without this feature.
// With a service, a use runs in shadow unless its flag says otherwise: the
// score is computed and recorded (ids, scores, versions, timestamps) and
// changes nothing. Only a flag of exactly "live" lets a score act, and only
// while the service reports the head behind it as usable.
export const LEARNED_FLAGS = Object.freeze({
  suggestions: "OPENAGI_LEARNED_SUGGESTIONS",
  scrutiny: "OPENAGI_LEARNED_SCRUTINY",
  memory: "OPENAGI_LEARNED_MEMORY",
  propagation: "OPENAGI_LEARNED_PROPAGATION"
});

// Head names as the service reports them in /health.
export const LEARNED_HEADS = Object.freeze({
  suggestion: "t2",
  value: "value",
  keep: "keep"
});

/** "off" | "shadow" | "live" for one learned use. */
export function learnedModeFor(use, client) {
  return learnedMode(process.env[LEARNED_FLAGS[use]], client);
}

/**
 * Merge fields into an outcome's metadata after it was recorded (a score that
 * arrived later) and persist the store. Does nothing when the outcome is no
 * longer the one the store holds, or there is nothing to add.
 */
export function patchOutcomeMetadata(outcomes, outcome, patch) {
  try {
    if (!outcome?.id || !patch || Object.keys(patch).length === 0) return false;
    if (outcomes?.outcomes?.get?.(outcome.id) !== outcome) return false;
    outcome.metadata = { ...(outcome.metadata ?? {}), ...patch };
    outcomes.persist?.();
    return true;
  } catch {
    return false;
  }
}

export function isProbability(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
