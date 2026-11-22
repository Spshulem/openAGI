// Adaptive check-in timer and deterministic stuck/blocker diagnosis for
// coding sessions and active tasks. Pure: no I/O, never echoes untrusted
// transcript text into prompts sent to other agents.

import { DEFAULTS, SUPERVISOR_PREFIX, clampText, msSince, redactSecrets } from "./contracts.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

export const DEFAULT_LIVE_STALL_MS = 2 * HOUR;
export const DEFAULT_SNAG_MAX_AGE_MS = 24 * HOUR;

const LONG_HORIZON_WORK_RE = /\b(?:train(?:ing)?|fine[- ]?tun\w*|benchmark\w*|eval(?:uation)?|overnight|soak|full[- ]?suite|notari[sz]\w*|archive)\b/i;

const CLEAN_COMPLETION_RE = /\b(?:all (?:\d+ )?(?:tests?|checks?|suites?) pass(?:ed|ing)?|nothing (?:else |more |left )?(?:is )?(?:needed|required|to do)|ready for (?:your )?review|merged cleanly|shipped and verified|completed successfully)\b/i;

const HUMAN_AUTH_WALL_RE = new RegExp([
  String.raw`\btailscale ssh requires an additional check\b`,
  String.raw`\bto authenticate,\s*visit:\s*https?:\/\/`,
  String.raw`\b(?:requires?|waiting (?:on|for)|blocked (?:by|on))\s+(?:an?\s+|your\s+)?(?:interactive\s+|browser\s+|manual\s+|2fa\s+|two[- ]factor\s+|sso\s+)?(?:log[- ]?in|sign[- ]?in|authentication|re-?authentication|2fa|two[- ]factor)\b`,
  String.raw`\b(?:captcha|verify you are human|cloudflare turnstile|recaptcha|hcaptcha)\b`,
  String.raw`\b(?:apple id|app store connect|testflight|developer portal)\s+(?:log[- ]?in|sign[- ]?in|2fa|authentication|credentials?)\b`,
  String.raw`\bmissing\s+(?:production|prod|live|stripe|aws|gcp|cloudflare|twilio|slack|github|openai|anthropic)\s+(?:api[- ]?)?(?:secret|key|token|credentials?)\b`
].join("|"), "i");

const ACCESS_CLAIM_RE = /\b(?:i\s+(?:do not|don['’]?t|cannot|can['’]?t)\s+have\s+(?:write\s+)?(?:access|permissions?|credentials?)|lack(?:ing)?\s+(?:access|permissions?|credentials?)|blocked\s+(?:by|on)\s+(?:missing\s+)?(?:access|permissions?|credentials?|auth(?:entication)?))\b/i;
const EXTERNAL_HUMAN_GATE_NOUN_RE = /\b(?:prod(?:uction)?|secret|api[- ]?key|token|account|portal|dashboard|billing|stripe|tailscale|cloudflare|app store|testflight|1password|keychain|sudo|admin|oauth)\b/i;

const LOCAL_PERMISSION_SNAG_RE = /\b(?:i\s+(?:do not|don['’]?t)\s+have\s+(?:write\s+)?(?:access|permission)|permission denied|operation not permitted|\beacces\b|\beperm\b|read[- ]only file system|blocked by (?:a |the )?(?:sandbox|hook|guard)|outside (?:your |the )?(?:workspace|allowed|sandbox))\b/i;

const CI_OR_BUILD_SNAG_RE = /\b(?:ci|checks?|unit tests?|integration tests?|test suite|xcodebuild|swift build|swift test|npm test|build|compile|typecheck|lint)\b[^.!?\n]{0,50}\b(?:failed|is failing|are failing|is red|timed out|errored|broken)\b/i;
const CI_FIXED_RE = /\b(?:fixed|resolved|cleared)\s+(?:the\s+)?(?:failing|red|broken)\b|\b(?:now|all)\s+(?:green|passing|passes|succeeded)\b/i;

const ENV_OR_TOOL_SNAG_RE = new RegExp([
  String.raw`\b(?:couldn['’]?t|could not|unable to|failed to)\s+(?:get past|complete|finish|run|execute|connect|reach|resolve|build|compile|install|push|rebase|start)\b`,
  String.raw`\b(?:hit a wall|stuck (?:on|at)|cannot get past|can['’]?t get past)\b`,
  String.raw`\b(?:database is locked|err_sqlite_error|err_module_not_found|cannot find package|address already in use|eaddrinuse|merge conflicts?|command failed|api error:\s*[45]\d\d)\b`
].join("|"), "i");

export function formatDurationCompact(ms) {
  const mins = Math.max(1, Math.round(Number(ms || 0) / MIN));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 && hours < 10 ? `${hours}h ${rem}m` : `${hours}h`;
}

function stripMarkdown(raw) {
  return String(raw ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function closingStatements(raw) {
  const cleaned = String(raw ?? "")
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/[\u2018\u2019]/g, "'");
  return cleaned
    .split(/(?<=[^\d\s][.?!])\s+|\n+/)
    .map((line) => line.replace(/^[-*>#\d.)\s]+|\*\*|__|`/g, "").trim())
    .filter((line) => line && !/^\|/.test(line))
    .slice(-5);
}

function agentSpokeLastForWatchdog(thread) {
  const agentAt = Date.parse(thread?.lastAgentAt ?? "");
  const userAt = Date.parse(thread?.lastUserAt ?? "");
  if (!Number.isFinite(agentAt) || !Number.isFinite(userAt)) return true;
  if (String(thread?.lastUserText ?? "").startsWith(SUPERVISOR_PREFIX)) return true;
  return agentAt >= userAt;
}

/**
 * Latest real progress on a linked task. Deliberately not `updatedAt`: the
 * watchdog persists its own bookkeeping through TaskStore.update(), which
 * bumps updatedAt, so anchoring on it would reset the check-in timer on
 * every scan and an overdue session could never become stuck.
 */
function taskProgressAt(task) {
  if (!task) return null;
  const meta = task.sourceMeta ?? {};
  return [
    task.createdAt,
    task.reopenedAt,
    task.completedAt,
    Array.isArray(task.statusHistory) ? task.statusHistory.at(-1)?.at : null,
    meta.agentLease?.claimedAt,
    meta.awaitingReview?.since
  ]
    .filter((iso) => Number.isFinite(Date.parse(iso ?? "")))
    .sort()
    .at(-1) ?? null;
}

/**
 * Estimates how long Supervisor should wait before checking in on an active
 * coding session or linked task, and whether that check-in window has elapsed.
 */
export function estimateExpectedCheckIn(thread, { classified = null, pr = null, task = null, now = Date.now(), limits = DEFAULTS } = {}) {
  if (!thread || thread.archived || thread.excluded) return null;
  const state = classified?.state ?? null;
  const status = thread.agentStatus ?? "idle";
  const explicitMinutes = Number(
    task?.sourceMeta?.checkInMinutes
    ?? task?.sourceMeta?.watchdog?.expectedMinutes
    ?? thread?.meta?.checkInMinutes
  );

  let expectedMinutes = null;
  let phase = null;

  if (Number.isFinite(explicitMinutes) && explicitMinutes > 0) {
    expectedMinutes = Math.min(720, Math.max(5, Math.round(explicitMinutes)));
    phase = "configured";
  } else if (status === "stalled" || state === "stopped") {
    expectedMinutes = Math.max(10, Math.round((limits.idleBeforeNudgeMs ?? 15 * MIN) / MIN));
    phase = "stalled";
  } else if (status === "running" || state === "running") {
    const contextText = `${thread.title ?? ""} ${thread.lastUserText ?? ""}`;
    expectedMinutes = LONG_HORIZON_WORK_RE.test(contextText) ? 45 : 25;
    phase = "running";
  } else if (state === "waiting-ci" || status === "waiting") {
    const taskKind = classified?.wait?.taskKind ?? null;
    expectedMinutes = taskKind === "full" ? 45 : taskKind === "quick" ? 15 : 30;
    phase = "waiting-ci";
  } else if (state === "pr-not-ready" && pr?.state === "OPEN") {
    expectedMinutes = 20;
    phase = "pr-fixup";
  } else if (task && task.status === "in_progress") {
    expectedMinutes = 45;
    phase = "active-task";
  } else if (classified?.snag) {
    expectedMinutes = 15;
    phase = "snag-recovery";
  }

  if (expectedMinutes === null) return null;

  const anchorIso = [thread.lastActivityAt, thread.lastAgentAt, thread.lastUserAt, taskProgressAt(task)]
    .filter((iso) => Number.isFinite(Date.parse(iso ?? "")))
    .sort()
    .at(-1) ?? null;
  const anchorMs = anchorIso ? Date.parse(anchorIso) : now;
  const elapsedMs = Math.max(0, now - anchorMs);
  const dueMs = anchorMs + expectedMinutes * MIN;
  const overdue = now >= dueMs;
  const silentMinutes = Math.round(elapsedMs / MIN);
  const overdueMinutes = overdue ? Math.max(0, Math.round((now - dueMs) / MIN)) : 0;
  const severelyStuck = overdue && elapsedMs >= (limits.liveServerStallMs ?? DEFAULT_LIVE_STALL_MS);

  return {
    phase,
    expectedMinutes,
    silentMinutes,
    anchorAt: new Date(anchorMs).toISOString(),
    checkInDueAt: new Date(dueMs).toISOString(),
    overdue,
    overdueMinutes,
    severelyStuck,
    status: overdue ? (severelyStuck ? "stuck" : "overdue") : "on_track"
  };
}

/**
 * Diagnoses silent hung turns (e.g. Antigravity / Paseo stuck 2-16h) and
 * declarative walls/snags where an agent stopped without asking a `?` question.
 */
export function diagnoseAgentBlocker(thread, { pr = null, now = Date.now(), limits = DEFAULTS } = {}) {
  if (!thread || thread.archived || thread.excluded) return null;

  const latestAt = [thread.lastActivityAt, thread.lastAgentAt, thread.lastUserAt]
    .filter((iso) => Number.isFinite(Date.parse(iso ?? "")))
    .sort()
    .at(-1) ?? null;
  const quietMs = msSince(latestAt, now);

  // 1. Silent hung turn (e.g. Antigravity or Paseo stuck mid-run or not_fully_idle for hours).
  if (thread.meta?.silentStuck === true) {
    const duration = formatDurationCompact(quietMs ?? (limits.liveServerStallMs ?? DEFAULT_LIVE_STALL_MS));
    return {
      kind: "silent-turn",
      subkind: thread.meta?.notFullyIdle ? "silent-background-work" : "silent-running-turn",
      resolution: "auto-nudge",
      playbook: "status-check",
      snagLabel: `silent ${duration} with no progress`,
      summary: `No agent step or reply for ${duration} while session remained marked busy.`,
      silentMinutes: Math.max(1, Math.round((quietMs ?? 0) / MIN))
    };
  }

  // Only inspect declarative snags on idle threads where the agent spoke last.
  if (thread.agentStatus !== "idle" || !agentSpokeLastForWatchdog(thread)) return null;
  const maxAgeMs = limits.snagMaxAgeMs ?? DEFAULT_SNAG_MAX_AGE_MS;
  const agentAgeMs = msSince(thread.lastAgentAt ?? thread.lastActivityAt, now);
  if (agentAgeMs !== null && agentAgeMs > maxAgeMs) return null;

  // If an open PR already has tracked readiness blockers, let pr-not-ready drive it.
  if (pr?.state === "OPEN") return null;

  const tailSource = thread.lastAgentTail || thread.lastAgentText || thread.lastAgentFull || "";
  if (!tailSource.trim()) return null;

  const closing = closingStatements(tailSource);
  if (!closing.length) return null;
  // Explicit questions are handled by detectAsk in classify.js.
  if (closing.some((line) => /\?\s*$/.test(line))) return null;

  const closingJoined = closing.join(" ");
  if (CLEAN_COMPLETION_RE.test(closingJoined) && !HUMAN_AUTH_WALL_RE.test(closingJoined) && !ENV_OR_TOOL_SNAG_RE.test(closingJoined)) {
    return null;
  }

  // 2. Genuine human-only credential / login / 2FA / external access gate.
  const authLine = closing.find((line) => HUMAN_AUTH_WALL_RE.test(line))
    ?? closing.find((line) => ACCESS_CLAIM_RE.test(line) && EXTERNAL_HUMAN_GATE_NOUN_RE.test(line));
  if (authLine) {
    return {
      kind: "owner-wall",
      subkind: "credentials-or-access",
      resolution: "ask-owner",
      topic: "credentials",
      snagLabel: "login or access wall",
      summary: clampText(redactSecrets(stripMarkdown(authLine)), 220),
      options: ["retry", "later"]
    };
  }

  // 3. Agent-solvable snag: local permission/path/sandbox snag, CI/test failure, or tool/env wall.
  const permSnagLine = closing.find((line) => LOCAL_PERMISSION_SNAG_RE.test(line));
  if (permSnagLine) {
    return {
      kind: "agent-snag",
      subkind: "permission-or-sandbox-snag",
      resolution: "auto-nudge",
      playbook: "unblock-snag",
      snagLabel: "local permission or path snag",
      summary: clampText(redactSecrets(stripMarkdown(permSnagLine)), 220)
    };
  }

  const ciSnagLine = !CI_FIXED_RE.test(closingJoined)
    ? closing.find((line) => CI_OR_BUILD_SNAG_RE.test(line))
    : null;
  if (ciSnagLine) {
    return {
      kind: "agent-snag",
      subkind: "ci-or-test-snag",
      resolution: "auto-nudge",
      playbook: "unblock-snag",
      snagLabel: "CI or test failure",
      summary: clampText(redactSecrets(stripMarkdown(ciSnagLine)), 220)
    };
  }

  const envSnagLine = closing.find((line) => ENV_OR_TOOL_SNAG_RE.test(line));
  if (envSnagLine) {
    return {
      kind: "agent-snag",
      subkind: "env-or-tool-snag",
      resolution: "auto-nudge",
      playbook: "unblock-snag",
      snagLabel: "tool or environment snag",
      summary: clampText(redactSecrets(stripMarkdown(envSnagLine)), 220)
    };
  }

  return null;
}
