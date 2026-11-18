// The owner's feedback on the supervisor ("I don't like that", "fix that"),
// said by voice or typed, and the self-fix requests it can lead to. Records
// only: nothing here runs a fix. The diagnose pass (P4) reads `change`
// feedback as input, and the self-fix runner (P3) picks up queued requests.
// Pure helpers; FleetStore keeps the records.

import { randomUUID } from "node:crypto";
import { clampText, redactSecrets } from "./contracts.js";

export const FEEDBACK_SOURCES = Object.freeze(["mac-voice", "android-voice", "g2-voice", "text", "web"]);
export const FEEDBACK_INTENTS = Object.freeze(["explain", "change", "fix", "create-pr", "spawn-fixer", "dismiss"]);
// new -> triaged -> fix-queued -> pr-open -> merged | declined. Declined can
// end any open record; nothing moves backwards.
export const FEEDBACK_STATUSES = Object.freeze(["new", "triaged", "fix-queued", "pr-open", "merged", "declined"]);
const TERMINAL = new Set(["merged", "declined"]);
// Where a fix may land; one fix at a time per area once the runner exists.
export const FIX_AREAS = Object.freeze(["policy", "classify", "ui-delivery", "judge", "review", "sources", "page", "voice", "self-fix"]);
// queued until the runner (P3) picks a request up; stop marks it abandoned.
export const FIX_STATES = Object.freeze(["queued", "preflight", "brief", "worktree", "coding", "tests", "guard", "pr", "awaiting-review", "fixing-findings", "replay", "owner-ask", "done", "failed", "abandoned"]);
// What the owner is looking at: the on-screen focus a voice client sends.
export const TARGET_FIELDS = Object.freeze(["view", "cardId", "threadKey", "questionId", "actionId", "prRef", "fixId", "suggestionId"]);

export const UTTERANCE_MAX = 1000;
const TEXT_MAX = 2000;
const TITLE_MAX = 100;
const FIELD_MAX = 200;
const EVIDENCE_MAX = 10;
const REVISIONS_KEPT = 10;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const makeId = (prefix) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const text = (value, max) => redactSecrets(clampText(value, max));

// Short strings only, from the fixed field set; anything else is dropped.
export function normalizeTarget(target) {
  if (!isObject(target)) return null;
  const out = {};
  for (const field of TARGET_FIELDS) {
    const value = target[field];
    if (typeof value === "string" && value.trim()) out[field] = clampText(value, FIELD_MAX);
  }
  return Object.keys(out).length ? out : null;
}

export function normalizeFeedback(input = {}, { now = Date.now() } = {}) {
  if (!isObject(input)) throw new Error("Feedback must be an object.");
  const utterance = text(input.utterance, UTTERANCE_MAX);
  if (!utterance) throw new Error("Feedback needs the owner's words.");
  const intent = FEEDBACK_INTENTS.includes(input.intent) ? input.intent : null;
  if (!intent) throw new Error(`Intent must be one of: ${FEEDBACK_INTENTS.join(", ")}.`);
  return {
    id: makeId("fb"),
    at: new Date(now).toISOString(),
    source: FEEDBACK_SOURCES.includes(input.source) ? input.source : "text",
    utterance,
    intent,
    target: normalizeTarget(input.target),
    status: "new",
    suggestionId: null,
    fixId: null
  };
}

// The status change a patch asks for, or an error naming why not.
export function feedbackPatch(record, patch = {}) {
  if (!isObject(patch)) throw new Error("Patch must be an object.");
  const out = {};
  if (patch.status !== undefined) {
    if (!FEEDBACK_STATUSES.includes(patch.status)) throw new Error(`Status must be one of: ${FEEDBACK_STATUSES.join(", ")}.`);
    if (TERMINAL.has(record.status)) throw new Error(`Feedback is already ${record.status}.`);
    const from = FEEDBACK_STATUSES.indexOf(record.status);
    const to = FEEDBACK_STATUSES.indexOf(patch.status);
    if (patch.status !== "declined" && to < from) throw new Error(`Feedback cannot go from ${record.status} back to ${patch.status}.`);
    out.status = patch.status;
  }
  for (const field of ["fixId", "suggestionId"]) {
    if (patch[field] !== undefined) out[field] = typeof patch[field] === "string" && patch[field] ? clampText(patch[field], 80) : null;
  }
  return out;
}

export function normalizeFixRequest(input = {}, { now = Date.now() } = {}) {
  if (!isObject(input)) throw new Error("A fix request must be an object.");
  const title = text(input.title, TITLE_MAX);
  const problem = text(input.problem, TEXT_MAX);
  const acceptance = text(input.acceptance, TEXT_MAX);
  if (!title) throw new Error("A fix needs a title.");
  if (!problem) throw new Error("A fix needs the problem it solves.");
  if (!acceptance) throw new Error("A fix needs an acceptance check.");
  if (!FIX_AREAS.includes(input.area)) throw new Error(`Area must be one of: ${FIX_AREAS.join(", ")}.`);
  const evidence = isObject(input.evidence) ? input.evidence : {};
  const ids = (value) => (Array.isArray(value) ? value : [value]).filter((id) => typeof id === "string" && /^[A-Za-z0-9_:.-]{1,80}$/.test(id)).slice(0, EVIDENCE_MAX);
  const at = new Date(now).toISOString();
  return {
    id: makeId("fix"),
    title,
    problem,
    area: input.area,
    acceptance,
    evidence: {
      feedbackIds: ids(evidence.feedbackIds ?? evidence.feedbackId ?? []),
      suggestionIds: ids(evidence.suggestionIds ?? evidence.suggestionId ?? []),
      actionIds: ids(evidence.actionIds ?? [])
    },
    source: FEEDBACK_SOURCES.includes(input.source) ? input.source : "text",
    state: "queued",
    revisions: [],
    createdAt: at,
    updatedAt: at
  };
}

// One owner change request for a fix (the runner reads it as one more round).
export function fixRevision(record, instructions, { now = Date.now() } = {}) {
  if (record.state === "abandoned") throw new Error("That fix was stopped; start a new one.");
  const words = text(instructions, TEXT_MAX);
  if (!words) throw new Error("Say what to change.");
  const at = new Date(now).toISOString();
  return { revisions: [...(record.revisions ?? []), { at, instructions: words }].slice(-REVISIONS_KEPT), updatedAt: at };
}
