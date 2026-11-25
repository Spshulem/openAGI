// Progressive preference learning and safe zero-setup defaults for the fleet
// supervisor. Out of the box, zero setup is required and auto-merging is OFF
// (mergePolicy: "manual_confirm"). As clear behavioral streaks emerge (3+
// consecutive routine deferrals, or 5+ consecutive approvals of a low-risk
// slice with 0 vetoes), lightweight inline preference cards offer to update
// the default—never silently enabling destructive actions.

import { randomUUID } from "node:crypto";
import { clampText, redactSecrets } from "./contracts.js";

export const MERGE_POLICIES = Object.freeze(["manual_confirm", "queue_when_green"]);
export const CADENCE_MODES = Object.freeze(["off", "quiet_until_ready", "balanced", "detailed"]);
export const PASEO_PROVIDERS = Object.freeze(["claude", "codex", "antigravity", "auto"]);
export const PASEO_PERMISSION_MODES = Object.freeze(["bypass", "auto", "ask"]);
export const DEFAULT_PASEO_MODELS = Object.freeze({
  claude: "claude-opus-5-5",
  codex: "gpt-6.2-sol",
  antigravity: "gemini-4-carbon-high"
});

export const SAFE_SLICES = Object.freeze({
  in_scope_test_fix: {
    id: "in_scope_test_fix",
    label: "In-scope test & lint fixes",
    pattern: /\b(?:unit tests?|failing tests?|test suite|lint(?:ing)?|typecheck|tsc|vitest|jest|eslint|fix (?:the )?(?:failing )?checks?)\b/i
  },
  pr_review_followup: {
    id: "pr_review_followup",
    label: "PR review comment follow-ups",
    pattern: /\b(?:review comments?|review threads?|unresolved threads?|pr feedback|address (?:the )?nit|reviewer asked)\b/i
  },
  lockfile_rebase: {
    id: "lockfile_rebase",
    label: "Branch rebases & lockfile sync",
    pattern: /\b(?:rebase (?:on|onto) (?:main|master)|branch behind (?:base|main)|package-lock|pnpm-lock|Cargo\.lock|regenerate lockfile)\b/i
  }
});

const RISKY_SLICE_EXCLUSION = /\b(?:prod(?:uction)?|releas(?:e|es|ed|ing)|deploy(?:s|ed|ing|ment)?|delet(?:e|es|ed|ing|ion)|destroy|wipe|drop table|migration|schema|merg(?:e|es|ed|ing)|force[- ]push|rewrite (?:git )?history|billing|secret|credential|auth(?:entication|orization)? token)\b|--admin\b/i;

export const AFFIRMATIVE_ANSWERS = new Set([
  "yes", "approve", "approved", "allow", "allow once", "continue", "keep going", "proceed", "retry", "run", "ok", "okay"
]);

export const DEFERRAL_ANSWERS = new Set([
  "dismiss", "later", "skip", "wait", "not now", "hold", "defer"
]);

const PROMPT_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
const DISMISSAL_PROMPT_STREAK = 3;
const SLICE_GRADUATION_STREAK = 5;
const AUTONOMOUS_LOG_MAX = 50;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function iso(ms) {
  return new Date(typeof ms === "number" ? ms : Date.now()).toISOString();
}

export function defaultPreferences() {
  return {
    autoApprove: true,
    mergePolicy: "manual_confirm",
    cadence: "balanced",
    checkinCooldownMinutes: null,
    checkinFormat: null,
    defaultProvider: "claude",
    defaultPermissionMode: "bypass",
    defaultModels: { ...DEFAULT_PASEO_MODELS },
    autoSlices: Object.fromEntries(Object.keys(SAFE_SLICES).map((key) => [key, "ask"])),
    streaks: {
      dismissals: 0,
      slices: Object.fromEntries(Object.keys(SAFE_SLICES).map((key) => [key, { approvals: 0, vetoes: 0 }]))
    },
    dismissedPrompts: {},
    ciMergeWatchPrompt: null,
    autonomousActions: []
  };
}

export function normalizePreferences(raw) {
  const base = defaultPreferences();
  if (!isObject(raw)) return base;
  const autoApprove = typeof raw.autoApprove === "boolean" ? raw.autoApprove : base.autoApprove;
  const mergePolicy = MERGE_POLICIES.includes(raw.mergePolicy) ? raw.mergePolicy : base.mergePolicy;
  const cadence = CADENCE_MODES.includes(raw.cadence) ? raw.cadence : base.cadence;
  const rawCooldown = raw.checkinCooldownMinutes;
  const checkinCooldownMinutes = rawCooldown !== null && rawCooldown !== undefined && Number.isFinite(Number(rawCooldown))
    ? Math.max(0, Math.min(1440, Math.round(Number(rawCooldown))))
    : null;
  const checkinFormat = typeof raw.checkinFormat === "string" && raw.checkinFormat.trim()
    ? clampText(redactSecrets(raw.checkinFormat.trim()), 600)
    : null;
  const defaultProvider = PASEO_PROVIDERS.includes(raw.defaultProvider) ? raw.defaultProvider : base.defaultProvider;
  const defaultPermissionMode = PASEO_PERMISSION_MODES.includes(raw.defaultPermissionMode)
    ? raw.defaultPermissionMode
    : base.defaultPermissionMode;
  const defaultModels = { ...base.defaultModels };
  if (isObject(raw.defaultModels)) {
    for (const key of Object.keys(DEFAULT_PASEO_MODELS)) {
      const val = typeof raw.defaultModels[key] === "string" ? raw.defaultModels[key].trim() : "";
      // Never retain deprecated 4.7 as a saved Claude default when 5.5 is the standard.
      if (val && !(key === "claude" && /4[-.]7/.test(val))) {
        defaultModels[key] = clampText(val, 120);
      }
    }
  }
  const autoSlices = { ...base.autoSlices };
  if (isObject(raw.autoSlices)) {
    for (const key of Object.keys(SAFE_SLICES)) {
      if (raw.autoSlices[key] === "auto" || raw.autoSlices[key] === "ask") {
        autoSlices[key] = raw.autoSlices[key];
      }
    }
  }
  const streaks = {
    dismissals: Number.isInteger(raw.streaks?.dismissals) && raw.streaks.dismissals >= 0 ? raw.streaks.dismissals : 0,
    slices: { ...base.streaks.slices }
  };
  if (isObject(raw.streaks?.slices)) {
    for (const key of Object.keys(SAFE_SLICES)) {
      const entry = raw.streaks.slices[key];
      if (isObject(entry)) {
        streaks.slices[key] = {
          approvals: Number.isInteger(entry.approvals) && entry.approvals >= 0 ? entry.approvals : 0,
          vetoes: Number.isInteger(entry.vetoes) && entry.vetoes >= 0 ? entry.vetoes : 0
        };
      }
    }
  }
  const dismissedPrompts = {};
  if (isObject(raw.dismissedPrompts)) {
    for (const [id, at] of Object.entries(raw.dismissedPrompts).slice(0, 32)) {
      if (typeof at === "string" && Number.isFinite(Date.parse(at))) dismissedPrompts[id] = at;
    }
  }
  const ciMergeWatchPrompt = isObject(raw.ciMergeWatchPrompt) && typeof raw.ciMergeWatchPrompt.prRef === "string"
    ? { prRef: raw.ciMergeWatchPrompt.prRef.slice(0, 120), at: clampText(raw.ciMergeWatchPrompt.at, 40) }
    : null;
  const autonomousActions = Array.isArray(raw.autonomousActions)
    ? raw.autonomousActions.filter(isObject).slice(-AUTONOMOUS_LOG_MAX).map((item) => ({
        id: clampText(item.id, 60) || `auto_${randomUUID().slice(0, 8)}`,
        at: clampText(item.at, 40) || iso(Date.now()),
        slice: Object.hasOwn(SAFE_SLICES, item.slice) ? item.slice : null,
        threadKey: typeof item.threadKey === "string" ? item.threadKey.slice(0, 160) : null,
        summary: clampText(redactSecrets(item.summary), 200),
        reverted: item.reverted === true
      }))
    : [];
  return {
    autoApprove,
    mergePolicy,
    cadence,
    checkinCooldownMinutes,
    checkinFormat,
    defaultProvider,
    defaultPermissionMode,
    defaultModels,
    autoSlices,
    streaks,
    dismissedPrompts,
    ciMergeWatchPrompt,
    autonomousActions
  };
}

// Identifies whether a question belongs to a safe routine slice. Risky,
// merge, storage, and infra questions NEVER qualify for automatic slices.
export function classifyQuestionSlice(question) {
  if (!isObject(question)) return null;
  if (question.mergeAsk || question.risky) return null;
  if (["ready", "storage", "self-fix", "suggestion", "agent-card"].includes(question.kind)) return null;
  const text = [question.title, question.body, question.askContext].filter(Boolean).join("\n");
  if (!text || RISKY_SLICE_EXCLUSION.test(text)) return null;
  for (const [key, spec] of Object.entries(SAFE_SLICES)) {
    if (spec.pattern.test(text)) return key;
  }
  return null;
}

// Shared policy for "quiet_until_ready" cadence: suppresses routine idle
// check-ins and low-urgency suggestions across the deck, notifications, and
// outreach feeds while letting PR-ready, risky, and blocker items through.
export function isSuppressedByQuietCadence(question, rawPrefs) {
  const cadence = typeof rawPrefs?.cadence === "string" ? rawPrefs.cadence : "balanced";
  if (cadence !== "quiet_until_ready" || !isObject(question)) return false;
  const critical = question.kind === "ready"
    || Boolean(question.mergeAsk)
    || Boolean(question.risky)
    || ["prompt", "infra", "limit", "deliver", "paused", "storage", "self-fix"].includes(question.kind);
  if (critical) return false;
  return question.kind === "suggestion" || question.kind === "idle-report" || question.playbook === "idle-report";
}

// Proactive Supervisor chat cadence filter (stricter than the Needs You deck:
// items stay visible in Needs You, while proactive chat interruptions honor
// "off" completely and restrict "quiet_until_ready" to genuine merge-ready PRs,
// explicit tool permissions, and hard infra/storage blockers).
export function isSuppressedFromProactiveChat(question, rawPrefs) {
  const cadence = typeof rawPrefs?.cadence === "string" ? rawPrefs.cadence : "balanced";
  if (cadence === "off") return true;
  if (isSuppressedByQuietCadence(question, rawPrefs)) return true;
  if (cadence !== "quiet_until_ready" || !isObject(question)) return false;
  const readyOrCritical = question.kind === "ready"
    || Boolean(question.mergeAsk)
    || Boolean(question.risky)
    || ["prompt", "infra", "storage", "self-fix"].includes(question.kind);
  return !readyOrCritical;
}

export function effectiveCheckinCooldownMs(rawPrefs) {
  const cadence = typeof rawPrefs?.cadence === "string" ? rawPrefs.cadence : "balanced";
  if (cadence === "off") return Infinity;
  const explicit = rawPrefs?.checkinCooldownMinutes;
  if (explicit !== null && explicit !== undefined && Number.isFinite(Number(explicit))) {
    return Math.max(0, Math.min(1440, Math.round(Number(explicit)))) * 60_000;
  }
  if (cadence === "quiet_until_ready") return 60 * 60_000;
  if (cadence === "detailed") return 5 * 60_000;
  return 20 * 60_000;
}

export function pickAffirmativeOption(options = []) {
  for (const option of Array.isArray(options) ? options : []) {
    if (typeof option === "string" && AFFIRMATIVE_ANSWERS.has(option.trim().toLowerCase())) {
      return option;
    }
  }
  return null;
}

export function recordPreferenceSignal(rawPrefs, { type, question = null, answer = null, prRef = null, now = Date.now() } = {}) {
  const prefs = normalizePreferences(rawPrefs);
  const normalizedAnswer = String(answer ?? "").trim().toLowerCase();
  const isRisky = Boolean(question?.mergeAsk || question?.risky || question?.kind === "ready" || question?.kind === "storage");

  if (type === "ci_merge_attempt" && prRef && prefs.mergePolicy === "manual_confirm") {
    const promptId = "pref:merge:queue_when_green";
    const snoozedAt = Date.parse(prefs.dismissedPrompts[promptId] ?? "");
    if (!Number.isFinite(snoozedAt) || now - snoozedAt >= PROMPT_SNOOZE_MS) {
      prefs.ciMergeWatchPrompt = { prRef: String(prRef).slice(0, 120), at: iso(now) };
    }
    return prefs;
  }

  if (type === "dismiss" || DEFERRAL_ANSWERS.has(normalizedAnswer)) {
    if (!isRisky) prefs.streaks.dismissals += 1;
    return prefs;
  }

  if (type === "answer") {
    prefs.streaks.dismissals = 0;
    const slice = classifyQuestionSlice(question);
    if (slice && AFFIRMATIVE_ANSWERS.has(normalizedAnswer)) {
      const entry = prefs.streaks.slices[slice] ?? { approvals: 0, vetoes: 0 };
      entry.approvals += 1;
      prefs.streaks.slices[slice] = entry;
    } else if (slice && normalizedAnswer && !AFFIRMATIVE_ANSWERS.has(normalizedAnswer)) {
      // A negative answer ("no", "deny", "stop") resets the approval streak.
      const entry = prefs.streaks.slices[slice] ?? { approvals: 0, vetoes: 0 };
      entry.approvals = 0;
      prefs.streaks.slices[slice] = entry;
    }
  }
  return prefs;
}

export function recordAutonomousSliceAction(rawPrefs, { slice, threadKey = null, summary = "", now = Date.now() } = {}) {
  const prefs = normalizePreferences(rawPrefs);
  const record = {
    id: `auto_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    at: iso(now),
    slice: Object.hasOwn(SAFE_SLICES, slice) ? slice : null,
    threadKey: threadKey ? String(threadKey).slice(0, 160) : null,
    summary: clampText(redactSecrets(summary), 200) || (SAFE_SLICES[slice]?.label ?? "Routine decision"),
    reverted: false
  };
  prefs.autonomousActions.push(record);
  if (prefs.autonomousActions.length > AUTONOMOUS_LOG_MAX) {
    prefs.autonomousActions.splice(0, prefs.autonomousActions.length - AUTONOMOUS_LOG_MAX);
  }
  return { prefs, record };
}

// Applies a progressive preference card decision or direct settings patch.
export function applyPreferencePatch(rawPrefs, patch = {}, { now = Date.now() } = {}) {
  const prefs = normalizePreferences(rawPrefs);
  if (!isObject(patch)) return prefs;

  // Choice shorthand from progressive preference cards:
  //   "cadence:quiet_until_ready" | "slice:in_scope_test_fix:auto" |
  //   "mergePolicy:queue_when_green" | "keep:<promptId>"
  if (typeof patch.choice === "string") {
    const choice = patch.choice.trim();
    if (choice.startsWith("keep:")) {
      const promptId = choice.slice("keep:".length);
      if (promptId) prefs.dismissedPrompts[promptId] = iso(now);
      if (promptId === "pref:cadence:quiet_until_ready") prefs.streaks.dismissals = 0;
      if (promptId === "pref:merge:queue_when_green") prefs.ciMergeWatchPrompt = null;
      if (promptId.startsWith("pref:slice:")) {
        const slice = promptId.slice("pref:slice:".length);
        if (prefs.streaks.slices[slice]) prefs.streaks.slices[slice].approvals = 0;
      }
      return prefs;
    }
    if (choice.startsWith("cadence:")) {
      const next = choice.slice("cadence:".length);
      if (CADENCE_MODES.includes(next)) {
        prefs.cadence = next;
        prefs.streaks.dismissals = 0;
      }
      return prefs;
    }
    if (choice.startsWith("slice:")) {
      const [, slice, mode] = choice.split(":");
      if (Object.hasOwn(SAFE_SLICES, slice) && (mode === "auto" || mode === "ask")) {
        prefs.autoSlices[slice] = mode;
      }
      return prefs;
    }
    if (choice.startsWith("mergePolicy:")) {
      const next = choice.slice("mergePolicy:".length);
      if (MERGE_POLICIES.includes(next)) {
        prefs.mergePolicy = next;
        prefs.ciMergeWatchPrompt = null;
      }
      return prefs;
    }
  }

  if (typeof patch.autoApprove === "boolean") {
    prefs.autoApprove = patch.autoApprove;
  }
  if (patch.choice === "auto_approve_on") {
    prefs.autoApprove = true;
  } else if (patch.choice === "auto_approve_off") {
    prefs.autoApprove = false;
  }
  if (MERGE_POLICIES.includes(patch.mergePolicy)) {
    prefs.mergePolicy = patch.mergePolicy;
    prefs.ciMergeWatchPrompt = null;
  }
  if (CADENCE_MODES.includes(patch.cadence)) {
    prefs.cadence = patch.cadence;
    prefs.streaks.dismissals = 0;
  }
  if (patch.checkinCooldownMinutes === null) {
    prefs.checkinCooldownMinutes = null;
  } else if (patch.checkinCooldownMinutes !== undefined && Number.isFinite(Number(patch.checkinCooldownMinutes))) {
    prefs.checkinCooldownMinutes = Math.max(0, Math.min(1440, Math.round(Number(patch.checkinCooldownMinutes))));
  }
  if (patch.checkinFormat === null || patch.checkinFormat === "") {
    prefs.checkinFormat = null;
  } else if (typeof patch.checkinFormat === "string" && patch.checkinFormat.trim()) {
    prefs.checkinFormat = clampText(redactSecrets(patch.checkinFormat.trim()), 600);
  }
  if (PASEO_PROVIDERS.includes(patch.defaultProvider)) {
    prefs.defaultProvider = patch.defaultProvider;
  }
  if (PASEO_PERMISSION_MODES.includes(patch.defaultPermissionMode)) {
    prefs.defaultPermissionMode = patch.defaultPermissionMode;
  }
  if (typeof patch.defaultModel === "string" && patch.defaultModel.trim()) {
    const m = clampText(patch.defaultModel.trim(), 120);
    if (/claude|opus|sonnet|haiku/i.test(m)) prefs.defaultModels.claude = m;
    else if (/gemini|carbon|argon/i.test(m)) prefs.defaultModels.antigravity = m;
    else prefs.defaultModels.codex = m;
  }
  if (isObject(patch.defaultModels)) {
    for (const key of Object.keys(DEFAULT_PASEO_MODELS)) {
      if (typeof patch.defaultModels[key] === "string" && patch.defaultModels[key].trim()) {
        prefs.defaultModels[key] = clampText(patch.defaultModels[key].trim(), 120);
      }
    }
  }
  if (isObject(patch.autoSlices)) {
    for (const [slice, mode] of Object.entries(patch.autoSlices)) {
      if (Object.hasOwn(SAFE_SLICES, slice) && (mode === "auto" || mode === "ask")) {
        prefs.autoSlices[slice] = mode;
      }
    }
  }
  if (typeof patch.vetoActionId === "string" || typeof patch.vetoSlice === "string") {
    return vetoAutonomousAction(prefs, { actionId: patch.vetoActionId, slice: patch.vetoSlice, now });
  }
  return prefs;
}

// One-tap "Don't do that" veto: reverts the slice back to "ask", increments
// its veto counter so it is not re-suggested automatically, and marks the
// action reverted.
export function vetoAutonomousAction(rawPrefs, { actionId = null, slice = null, now = Date.now() } = {}) {
  const prefs = normalizePreferences(rawPrefs);
  let targetSlice = slice && Object.hasOwn(SAFE_SLICES, slice) ? slice : null;
  if (actionId) {
    const match = prefs.autonomousActions.find((item) => item.id === actionId);
    if (match) {
      match.reverted = true;
      targetSlice ??= match.slice;
    }
  } else if (!targetSlice) {
    const latest = [...prefs.autonomousActions].reverse().find((item) => !item.reverted && item.slice);
    if (latest) {
      latest.reverted = true;
      targetSlice = latest.slice;
    }
  }
  if (targetSlice && Object.hasOwn(SAFE_SLICES, targetSlice)) {
    prefs.autoSlices[targetSlice] = "ask";
    prefs.streaks.slices[targetSlice] = {
      approvals: 0,
      vetoes: (prefs.streaks.slices[targetSlice]?.vetoes ?? 0) + 1
    };
    prefs.dismissedPrompts[`pref:slice:${targetSlice}`] = iso(now);
  }
  return prefs;
}

function isSnoozed(prefs, promptId, now) {
  const at = Date.parse(prefs.dismissedPrompts?.[promptId] ?? "");
  return Number.isFinite(at) && now - at < PROMPT_SNOOZE_MS;
}

export function buildProgressivePreferenceCards(rawPrefs, { now = Date.now() } = {}) {
  const prefs = normalizePreferences(rawPrefs);
  const cards = [];

  const cadenceId = "pref:cadence:quiet_until_ready";
  if (prefs.cadence === "balanced" && prefs.streaks.dismissals >= DISMISSAL_PROMPT_STREAK && !isSnoozed(prefs, cadenceId, now)) {
    cards.push({
      id: cadenceId,
      questionId: null,
      kind: "preference",
      kindLabel: "Preference",
      headline: "Ping less often?",
      summary: `You deferred ${prefs.streaks.dismissals} routine updates in a row. Switch default cadence to Quiet until PR ready so Supervisor only interrupts on blockers and merge-ready PRs?`,
      recommendation: "Zero-setup default is Balanced. You can change this back anytime.",
      brief: {
        context: `${prefs.streaks.dismissals} routine updates deferred in a row`,
        whatChanged: "Switch default cadence to Quiet until PR ready so Supervisor only interrupts on blockers and merge-ready PRs.",
        decision: "Choose whether to switch cadence to Quiet until ready or keep Balanced."
      },
      suggestedReplies: [],
      canReply: false,
      threadKey: null,
      threadKeys: [],
      repo: null,
      branch: null,
      workspace: null,
      prRef: null,
      prUrl: null,
      prNumber: null,
      headSha: null,
      ciState: null,
      mergeState: null,
      noticedAt: iso(now),
      answerIn: "here",
      risky: false,
      options: ["Quiet until ready", "Keep current"],
      primaryAction: { op: "preference", label: "Quiet until ready", value: "cadence:quiet_until_ready", destructive: false },
      secondaryAction: { op: "preference", label: "Keep current", value: `keep:${cadenceId}`, destructive: false },
      timeline: [
        { at: iso(now), label: "Pattern noticed", detail: `${prefs.streaks.dismissals} consecutive routine asks deferred` }
      ],
      resources: [],
      openChat: null
    });
  }

  for (const [slice, spec] of Object.entries(SAFE_SLICES)) {
    const promptId = `pref:slice:${slice}`;
    const streak = prefs.streaks.slices[slice] ?? { approvals: 0, vetoes: 0 };
    if (prefs.autoSlices[slice] === "ask"
        && streak.approvals >= SLICE_GRADUATION_STREAK
        && (streak.vetoes ?? 0) === 0
        && !isSnoozed(prefs, promptId, now)) {
      cards.push({
        id: promptId,
        questionId: null,
        kind: "preference",
        kindLabel: "Preference",
        headline: `Make "${spec.label}" automatic?`,
        summary: `You approved ${streak.approvals} in a row with 0 overrides. Want Supervisor to handle ${spec.label.toLowerCase()} automatically? PR merging remains manual-confirm.`,
        recommendation: "Safe routine slice only. Auto-merge stays off.",
        brief: {
          context: `${streak.approvals} consecutive approvals with 0 overrides`,
          whatChanged: `Supervisor can handle ${spec.label.toLowerCase()} automatically while keeping PR merges manual-confirm.`,
          decision: `Make "${spec.label}" automatic or keep asking each time?`
        },
        suggestedReplies: [],
        canReply: false,
        threadKey: null,
        threadKeys: [],
        repo: null,
        branch: null,
        workspace: null,
        prRef: null,
        prUrl: null,
        prNumber: null,
        headSha: null,
        ciState: null,
        mergeState: null,
        noticedAt: iso(now),
        answerIn: "here",
        risky: false,
        options: ["Make default", "Keep asking"],
        primaryAction: { op: "preference", label: "Make default", value: `slice:${slice}:auto`, destructive: false },
        secondaryAction: { op: "preference", label: "Keep asking", value: `keep:${promptId}`, destructive: false },
        timeline: [
          { at: iso(now), label: "Consistent approvals", detail: `${streak.approvals} consecutive approvals · 0 overrides` }
        ],
        resources: [],
        openChat: null
      });
    }
  }

  const mergePromptId = "pref:merge:queue_when_green";
  if (prefs.mergePolicy === "manual_confirm" && prefs.ciMergeWatchPrompt?.prRef && !isSnoozed(prefs, mergePromptId, now)) {
    cards.push({
      id: mergePromptId,
      questionId: null,
      kind: "preference",
      kindLabel: "Preference",
      headline: "Keep manual merge after CI finishes?",
      summary: `CI was still running on ${prefs.ciMergeWatchPrompt.prRef} when you tapped Merge. By default, Supervisor never auto-merges—it watches CI and pings you when green.`,
      recommendation: "Recommended: Keep manual confirm so new commits or flaky checks never merge unattended.",
      brief: {
        context: `Merge requested while CI was running on ${prefs.ciMergeWatchPrompt.prRef}`,
        whatChanged: "By default, Supervisor watches CI and pings you when green instead of merging unattended.",
        decision: "Keep manual merge confirmation or queue merge automatically after your tap?"
      },
      suggestedReplies: [],
      canReply: false,
      threadKey: null,
      threadKeys: [],
      repo: null,
      branch: null,
      workspace: null,
      prRef: prefs.ciMergeWatchPrompt.prRef,
      prUrl: null,
      prNumber: null,
      headSha: null,
      ciState: "PENDING",
      mergeState: null,
      noticedAt: prefs.ciMergeWatchPrompt.at || iso(now),
      answerIn: "here",
      risky: false,
      options: ["Keep manual confirm", "Queue merge after my tap"],
      primaryAction: { op: "preference", label: "Keep manual confirm", value: `keep:${mergePromptId}`, destructive: false },
      secondaryAction: { op: "preference", label: "Queue after my tap", value: "mergePolicy:queue_when_green", destructive: false },
      timeline: [
        { at: prefs.ciMergeWatchPrompt.at || iso(now), label: "Merge requested during CI", detail: `${prefs.ciMergeWatchPrompt.prRef} checks still running` }
      ],
      resources: [],
      openChat: null
    });
  }

  return cards;
}
