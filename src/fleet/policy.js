// Pure policy: a classified thread (or the infra snapshot) -> FleetDecisions.
// No I/O. Messages to agents are built only from playbook text plus
// supervisor facts (PR number, head, CI names, counts, ages). Agent text is
// untrusted and may carry instructions, so it never goes into a message
// another agent reads; the owner sees at most a tag-stripped 220-char excerpt.

import { CONDUCTOR_CODEX_ORIGINATOR, DEFAULTS, SUPERVISOR_PREFIX, clampTail, clampText, msSince, parsePrRef, redactSecrets, shortHash, uiTargetFor } from "./contracts.js";
import { deliberateStop } from "./classify.js";
import { renderTemplate } from "./playbooks.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const FAR_RESET_MS = 8 * HOUR;
const UNREACHABLE_ASK_MS = 90 * MIN;
const LONG_DOWN_MS = HOUR;
// LB log rows older than this say nothing about the LB now.
const LB_ERROR_FRESH_MS = 15 * MIN;

const LIMIT_KINDS = new Set(["session-limit", "usage-limit"]);
const BACKOFF_KINDS = new Set(["overloaded", "network"]);
const MANAGER_DOWN_KINDS = new Set(["session-limit", "usage-limit", "model-limit", "logged-out", "disk-full"]);
const RESUME_STATUSES = new Set(["aborted", "stalled", "error"]);
const CI_DONE = new Set(["SUCCESS", "FAILURE", "ERROR"]);
const CI_FAILING = new Set(["FAILURE", "ERROR"]);
const DONE_PR_STATES = new Set(["MERGED", "CLOSED"]);
// Blockers only GitHub (or a later git read) can clear; nudging the agent
// does nothing for them.
const PASSIVE_BLOCKERS = new Set(["CI running", "Codex review not on head", "mergeability unknown", "local git unknown"]);
// "CI running", or a required check still running ("BuildBot3 full run pending").
const ciRunning = (blocker) => blocker === "CI running" || / pending$/.test(blocker);
const passive = (blocker) => PASSIVE_BLOCKERS.has(blocker) || ciRunning(blocker);
const LB_ALARM_KINDS = new Set(["no-accounts", "auth", "connection", "unavailable"]);
const INFRA_NAMES = { bb3: "BuildBot3", lb: "Codex LB" };
const KIND_NAMES = { codex: "Codex", claude: "Claude", conductor: "Conductor" };
// Thread-level and infra-level escalations of one incident share a cooldown.
const ESCALATION_KEYS = { "manager-bb3": "infra:bb3", "manager-lb": "infra:lb" };

const TOPIC_TITLES = {
  approval: "needs an approval. OK?",
  admin: "wants an --admin merge. OK?",
  merge: "wants to merge. OK?",
  production: "wants a prod step. OK?",
  credentials: "needs a login or creds. Do it?",
  money: "wants to spend credits. OK?",
  delete: "wants to delete shared stuff. OK?",
  choice: "needs a pick. Which?",
  decision: "needs your call. Answer?",
  permission: "asks permission. OK?",
  "in-scope": "asks to go ahead. OK?",
  reboot: "wants to reboot shared infra. OK?",
  cancel: "wants to cancel runs. OK?",
  history: "wants to rewrite git history. OK?",
  main: "wants to push to main. OK?",
  database: "wants to change a shared DB. OK?"
};

// ---------------------------------------------------------------------------
// Routes

// delivery: { mode: "cli" | "computer-use" | "computer-use-first", ready,
// detail, apps } (a bare mode string also works). ready === false means the
// last readiness probe failed; null/undefined means not probed, treated as
// ready. apps maps bundleId -> running; false means that app is closed.
export function chooseRoute(thread, mode, delivery = null) {
  if (!thread || thread.archived) return null;
  const ui = deliveryOf(delivery);
  if (ui.mode !== "cli") {
    const target = uiTargetFor(thread);
    // computer-use-first falls back to the CLI while the thread's app is closed.
    const appClosed = ui.mode === "computer-use-first" && target && ui.apps?.[target.bundleId] === false;
    // Typing into the app has no fork risk, so every mode may use it.
    if (target && ui.ready !== false && !appClosed) return "computer-use";
    // Computer-use only: never a CLI, whatever the thread offers.
    if (ui.mode === "computer-use") return null;
  }
  // A Codex thread Conductor started (its own Codex agent) resumed behind
  // Conductor forks it, the same as claude-resume would.
  if (thread.kind === "codex") return thread.writerLocked || !thread.cwd || thread.meta?.originator === CONDUCTOR_CODEX_ORIGINATOR ? null : "codex-exec";
  if (thread.live?.peerName && thread.live?.pid) return "peer-relay";
  // claude -p --resume behind Conductor's back forks the transcript and
  // never shows in its UI, so Conductor-hosted threads never get it.
  const conductorHosted = thread.kind === "conductor" || thread.meta?.conductorHosted === true;
  if (!conductorHosted && mode === "auto" && thread.cwd) return "claude-resume";
  return null;
}

function deliveryOf(delivery) {
  if (typeof delivery === "string") return { mode: delivery, ready: null, detail: null, apps: null };
  return { mode: delivery?.mode ?? "cli", ready: delivery?.ready ?? null, detail: delivery?.detail ?? null, apps: delivery?.apps ?? null };
}

// Computer-use-only mode with an app that could show the thread, but computer
// use is not ready right now: wait for it instead of asking to open the thread.
export function uiWaitReason(thread, delivery) {
  const ui = deliveryOf(delivery);
  if (ui.mode !== "computer-use" || ui.ready !== false || !uiTargetFor(thread)) return null;
  return `computer use not ready${ui.detail ? `: ${ui.detail}` : ""}`;
}

// Either computer-use mode, when a thread the app shows has no route only
// because computer use cannot type now: wait for it (the supervisor tells
// the owner once it has waited a while) instead of calling it offline.
function uiBlockedReason(thread, delivery) {
  const ui = deliveryOf(delivery);
  if (ui.mode === "cli" || ui.ready !== false || !uiTargetFor(thread)) return null;
  return `computer use not ready${ui.detail ? `: ${ui.detail}` : ""}`;
}

// Null while the owner is talking to the manager, while it is mid-turn, or
// while it is down. Callers check managerBusy first to wait instead of asking.
function managerRoute(manager, mode, limits, now, delivery = null) {
  if (!manager) return null;
  if (managerBusy(manager, limits, now)) return null;
  if (managerDown(manager, now)) return null;
  return chooseRoute(manager, mode, delivery);
}

function managerBusy(manager, limits, now) {
  if (!manager) return null;
  const ownerUntil = ownerActiveUntil(manager, limits, now);
  if (ownerUntil) return { reason: "owner active in manager thread", notBefore: ownerUntil };
  if (manager.agentStatus === "running") return { reason: "manager mid-turn", notBefore: null };
  return null;
}

// A limit error stays on the thread until its next turn; once the reset has
// passed it no longer means the manager is down.
function managerDown(manager, now) {
  const kind = manager.error?.kind;
  if (!MANAGER_DOWN_KINDS.has(kind)) return false;
  const resetAt = Date.parse(manager.error?.resetAt ?? "");
  return !(LIMIT_KINDS.has(kind) && Number.isFinite(resetAt) && resetAt <= now);
}

function isManager(ctx) {
  const { manager, thread } = ctx;
  if (!manager || !thread) return false;
  return manager.key === thread.key || (Boolean(thread.meta?.claudeKey) && manager.key === thread.meta.claudeKey);
}

// ---------------------------------------------------------------------------
// Per-thread decisions

// options.escalationLedger: lastEscalation(key) for shared incident keys
// ("infra:bb3", "infra:lb"). options.mutedKeys: thread keys the owner muted.
export function decideThread(classified, thread, options = {}) {
  const ctx = makeContext(classified, thread, options);
  if (ctx.mutedKeys.has(thread?.key)) return { ...baseDecision(ctx), reason: "muted by owner" };
  return resolveIntent(ctx, intentFor(ctx));
}

function makeContext(classified, thread, options) {
  const { ledger = null, playbooks = new Map(), config = null, now = Date.now(), pr = null, infra = null, manager = null, escalationLedger = null } = options;
  const mode = options.mode ?? config?.mode ?? "observe";
  const limits = limitsOf(config);
  const delivery = options.delivery ?? config?.delivery ?? null;
  return {
    classified, thread, pr, infra, manager, playbooks, limits, now, mode, escalationLedger, delivery,
    mutedKeys: keySet(options.mutedKeys),
    ledger: ledger ?? {},
    progressMark: progressMarkFor(classified, thread, ledger),
    facts: factsFor(thread, pr, classified)
  };
}

const DAY_MS = 24 * 60 * MIN;
const IDLE_REPORT_DAILY_MAX = 2;

function intentFor(ctx) {
  const { classified } = ctx;
  switch (classified.state) {
    case "infra-blocked": return infraIntent(ctx);
    case "waiting-ci": return waitingIntent(ctx);
    case "local-verify": return nudge("no-local-verify", "heavy verification on the laptop", { immediate: true });
    case "needs-human": return agentAskIntent(ctx);
    // The manager's asks are about shared infra: the owner answers them.
    case "asked-in-scope": return isManager(ctx) ? agentAskIntent(ctx) : nudge("in-scope-yes", "agent asked to do an in-scope step");
    case "pr-not-ready": return prIntent(ctx);
    case "ready-needs-human": return readyIntent(ctx);
    case "stopped": return nudge("resume", classified.reason);
    // It said it would keep going ("Next: ...", "merging once they pass"),
    // then its turn ended: nothing wakes it but a nudge. A finished report
    // is left alone.
    case "idle-no-pr":
    case "done": return idleIntent(ctx);
    default: return { type: "none", reason: classified.reason };
  }
}

function idleIntent(ctx) {
  const { classified, thread, ledger, limits, now } = ctx;
  if (!classified.idle?.promised) return { type: "none", reason: classified.reason };
  // Fresh stops only: an old thread's last words are history. Measured from
  // the words, not activity (a delivered nudge is activity too).
  const quietMs = msSince(thread.lastAgentAt, now);
  if (quietMs === null || quietMs > limits.idleReportMaxAgeMs) return { type: "none", reason: classified.reason };
  // A daily cap, whatever its progress mark says: a shared checkout's head
  // moves with other agents' commits.
  // Deliveries only: a send blocked while the owner types is no nudge.
  const sentToday = (ledger.nudges ?? []).filter((entry) => entry?.playbook === "idle-report" && entry.status === "sent" && now - Date.parse(entry.at) < DAY_MS).length;
  if (sentToday >= IDLE_REPORT_DAILY_MAX) return { type: "none", reason: `${classified.reason}; idle-report sent ${sentToday} times today` };
  return nudge("idle-report", "said it would keep going, then stopped");
}

function nudge(playbook, reason, extra = {}) {
  return { type: "nudge", playbook, reason, ...extra };
}

function infraIntent(ctx) {
  const { classified, thread, limits, now } = ctx;
  const kind = classified.infraKind;
  const errorAt = latest(thread.lastAgentAt, thread.lastActivityAt);
  if (LIMIT_KINDS.has(kind)) {
    const resetAt = thread.error?.resetAt;
    if (!resetAt || !Number.isFinite(Date.parse(resetAt))) return backoffIntent(ctx, errorAt, kind);
    const resumeAt = addMs(resetAt, limits.sessionLimitGraceMs);
    if (Date.parse(resetAt) - now > FAR_RESET_MS) {
      const who = thread.kind === "codex" ? "Codex" : "Claude";
      return {
        type: "ask", notBefore: resumeAt, reason: `${kind} until ${ctx.facts.reset}`,
        question: question(ctx, `${ctx.facts.label}: ${who} cap. Reset ${ctx.facts.reset}. Add acct?`,
          `${who} ${kind} on ${ctx.facts.label}. Resumes on its own at ${ctx.facts.reset}.`, ["wait", "added"],
          `limit:${thread.key}:${resetAt}`, "limit")
      };
    }
    if (Date.parse(resumeAt) > now) return { type: "wait", notBefore: resumeAt, reason: `${kind} until ${ctx.facts.reset}` };
    return nudge("resume", `${kind} reset passed`, { immediate: true });
  }
  if (kind === "model-limit") {
    const model = modelName(thread);
    return {
      type: "ask", reason: "model limit; continue on the same model fails",
      question: question(ctx, `${ctx.facts.label}: ${model} capped. Switch model?`,
        `${model} limit hit on ${ctx.facts.label}. Resending continue on the same model will fail.`, ["switched", "wait"],
        `limit:${thread.key}:model`, "limit")
    };
  }
  if (BACKOFF_KINDS.has(kind)) return backoffIntent(ctx, errorAt, kind);
  if (kind === "lb" || kind === "bb3") {
    const health = infraHealth(ctx.infra, { config: { limits }, now });
    if (health[kind].up) return nudge("infra-recovered", `${INFRA_NAMES[kind]} is up`, { immediate: true, vars: { what: INFRA_NAMES[kind] } });
    return { type: "wait", reason: `waiting on ${INFRA_NAMES[kind]}` };
  }
  if (kind === "logged-out") {
    const who = thread.kind === "codex" ? "Codex" : "Claude";
    return {
      type: "ask", reason: "logged out",
      question: question(ctx, `${who} logged out. Run /login?`, `${ctx.facts.label} stopped: ${who} is not logged in.`,
        ["retry", "later"], `logged-out:${thread.key}`, "infra")
    };
  }
  if (kind === "disk-full") {
    return {
      type: "ask", reason: "disk full",
      question: question(ctx, "Disk full. Free space?", `${ctx.facts.label} stopped: no space left on device.`,
        ["retry", "later"], `disk-full:${thread.key}`, "infra")
    };
  }
  return { type: "none", reason: classified.reason };
}

function backoffIntent(ctx, errorAt, kind) {
  const steps = ctx.limits.overloadBackoffMs;
  const attempts = attemptsWithoutProgress(ctx.ledger, ctx.progressMark);
  const delay = steps[Math.min(attempts, steps.length - 1)];
  const resumeAt = addMs(errorAt, delay);
  if (resumeAt && Date.parse(resumeAt) > ctx.now) {
    return { type: "wait", notBefore: resumeAt, reason: `${kind}; backing off ${minutes(delay)}m` };
  }
  return nudge("resume", `${kind}; retry ${attempts + 1}`, { immediate: true });
}

function waitingIntent(ctx) {
  const { classified, pr, limits, thread, now } = ctx;
  const wait = classified.wait ?? {};
  const age = wait.ageMs ?? 0;
  const ci = pr?.ci ?? {};
  // A required check (the BuildBot3 full run) still to come means CI is not done.
  const gates = pr?.gates ?? [];
  const ciDone = pr?.state === "OPEN" && CI_DONE.has(ci.state) && !ci.pending?.length && gates.every((gate) => CI_DONE.has(gate.state));
  // A verify behind a blocked gate or a hung watcher never wakes its agent,
  // and the manager may not get through either: past this long with no word
  // from the agent, it is asked for a status itself.
  const quietMs = msSince(latest(thread.lastAgentAt, thread.lastActivityAt), now);
  const silent = wait.source === "task" && age >= limits.silentTurnMs && quietMs !== null && quietMs >= limits.silentTurnMs;
  if (wait.taskKind === "full" && age >= limits.fullVerifyEscalateMs) {
    // The full BuildBot3 run is the merge gate (hosted CI is paused): a slow
    // one goes to the manager, never a nudge to drop it.
    if (silent) return statusCheck("bb-verify --full", quietMs);
    return escalateIntent(ctx, "bb-verify --full", age);
  }
  if (wait.taskKind === "quick" && age >= limits.quickVerifyEscalateMs) {
    return silent ? statusCheck("bb-quick", quietMs) : escalateIntent(ctx, "bb-quick", age);
  }
  if (wait.source === "task") {
    // Conductor wakes itself when the task ends. Past 45 min the task is a
    // stuck watcher or a long-lived process (a dev server), so treat it as idle.
    if (wait.taskKind || age < limits.waitingTaskMaxMs) return { type: "wait", reason: wait.reason ?? "waiting on a background task" };
    if (ciDone) return nudge("ci-finished", "CI done; task still waiting", { immediate: true });
    const blockers = classified.readiness?.blockers ?? [];
    if (pr?.state === "OPEN" && blockers.length && !blockers.some(ciRunning)) {
      return nudge("merge-ready", `waiting ${minutes(age)}m; not ready: ${blockers.join("; ")}`, { immediate: true });
    }
    if (silent) return statusCheck("a background task", quietMs);
    return { type: "wait", reason: wait.reason ?? "waiting on a background task" };
  }
  // The agent ended its turn to wait and nothing will wake it but us.
  if (ciDone) return nudge("ci-finished", "CI finished on head");
  // A required check that finished without a pass (skipped, neutral) will
  // not change on its own; once hosted CI settles, hand it back.
  const settled = gates.find((gate) => gate.state && gate.state !== "PENDING" && !CI_DONE.has(gate.state));
  const hostedRunning = Boolean(ci.pending?.length) || ci.state === "PENDING" || ci.state === "EXPECTED";
  if (pr?.state === "OPEN" && settled && !hostedRunning) {
    return nudge("merge-ready", `${settled.label || settled.name} ${String(settled.state).toLowerCase()}`);
  }
  const missing = gates.find((gate) => !gate.state);
  if (pr?.state === "OPEN" && (missing || (!gates.length && !ci.state)) && age >= limits.waitingTaskMaxMs) {
    return nudge("merge-ready", `${missing ? `${missing.label || missing.name} missing` : "no CI on head"} after waiting`);
  }
  if (!pr && age >= limits.waitingTaskMaxMs) return nudge("resume", `waited ${minutes(age)}m with nothing visible`);
  // The PR it is tracked by already merged or closed, so the CI it waits on
  // is another PR's (it opened a new one): ask where it is, once the usual
  // idle window passed. Not a note that nothing is left ("Merged. CI runs on
  // main; nothing needed from you").
  const text = String(thread.lastAgentText ?? "");
  if (pr && pr.state !== "OPEN" && age >= limits.idleBeforeNudgeMs && !POST_MERGE_NOTE.test(text)) {
    return statusCheck("CI on a PR this thread does not track", age);
  }
  return { type: "wait", reason: pr ? "CI still running" : wait.reason ?? "waiting" };
}

const POST_MERGE_NOTE = /\bnothing\b[^.?!\n]{0,25}\b(?:from|for) you\b|\bno action (?:needed|required)\b|\bnothing (?:else|more|left)\b/i;

function statusCheck(what, quietMs) {
  const quiet = minutes(quietMs);
  return nudge("status-check", `no word in ${quiet}m while waiting on ${what}`, { immediate: true, vars: { what, quiet } });
}

function escalateIntent(ctx, what, age) {
  const { facts } = ctx;
  const vars = {
    ...bb3Vars(ctx.infra?.bb3, [], ctx.limits),
    problems: `${facts.label} waits on ${what} ${minutes(age)}m`,
    waiting: waitingLine(facts, what, age)
  };
  return { type: "escalate", playbook: "manager-bb3", reason: `${what} ${minutes(age)}m`, vars };
}

function waitingLine(facts, what, age) {
  return `Waiting: ${facts.prRef || "no PR"} head ${facts.head || "?"}, ${what} ${minutes(age)}m (agent ${facts.thread}).`;
}

// The verify wait waitingIntent escalates to the manager, or null.
function escalatedWait(classified, pr, limits) {
  if (classified?.state !== "waiting-ci") return null;
  const wait = classified.wait ?? {};
  const age = wait.ageMs ?? 0;
  if (wait.taskKind === "full" && age >= limits.fullVerifyEscalateMs) return { what: "bb-verify --full", age };
  if (wait.taskKind === "quick" && age >= limits.quickVerifyEscalateMs) return { what: "bb-quick", age };
  return null;
}

function agentAskIntent(ctx) {
  const { classified, thread } = ctx;
  const ask = classified.ask ?? {};
  if (thread.meta?.blockedOnOwner === true) {
    // A card the supervisor read on screen: its own buttons are the options,
    // and a tap clicks that button (supervisor.answerQuestion). A new card is
    // a new question (its stateId is in the key).
    const card = thread.meta?.prompt;
    if (Array.isArray(card?.buttons) && card.buttons.length && card.stateId && uiTargetFor(thread)) {
      return {
        type: "ask", reason: "blocked on a permission prompt",
        question: {
          ...question(ctx, `${ctx.facts.label}: waiting on a prompt. Answer?`, `${ctx.facts.label}: ${card.text || ask.text || "Blocked on a permission prompt."}`,
            [...card.buttons.slice(0, 3), "later"], `prompt:${thread.key}:${card.stateId}`, "prompt"),
          meta: { promptStateId: card.stateId }
        }
      };
    }
    // Only a click in the session clears it, so the answer is not relayed.
    return {
      type: "ask", reason: "blocked on a permission prompt",
      question: question(ctx, `${ctx.facts.label}: waiting on a prompt. Open it?`, `${ctx.facts.label}: ${ask.text ?? "Blocked on a permission prompt or dialog."}`,
        ask.options?.length >= 2 ? ask.options.slice(0, 3) : ["opened", "later"], `prompt:${thread.key}`, "prompt")
    };
  }
  const topicTitle = TOPIC_TITLES[ask.topic] ?? "asks you. Answer?";
  const options = ask.structured ? ask.options : ask.options?.length >= 2 ? ask.options.slice(0, 3) : ["yes", "no"];
  const excerpt = ownerExcerpt(ask.text || thread.lastAgentText, ctx.limits.bodyMax);
  // A sealed Codex ask brings its own key: its shown text is a stand-in.
  return {
    type: "ask", reason: `agent asks: ${ask.topic ?? "question"}`,
    question: {
      ...question(ctx, `${ctx.facts.label}: ${topicTitle}`, excerpt, options,
        `ask:${thread.key}:${ask.key ?? shortHash(ask.text ?? "")}`, "agent-ask"),
      // The body is only the ask sentence; the review needs what it is about.
      askContext: clampTail(redactSecrets(thread.lastAgentTail || thread.lastAgentText), ctx.limits.excerptMax),
      agentAskedAt: thread.lastAgentAt ?? null
    }
  };
}

function prIntent(ctx) {
  const { classified, thread } = ctx;
  const blockers = classified.blockers ?? [];
  if (blockers.length && blockers.every(passive)) {
    return { type: "wait", reason: blockers.includes("CI running") ? "CI running on head" : `waiting: ${blockers.join("; ")}` };
  }
  const playbook = RESUME_STATUSES.has(thread.agentStatus) ? "resume" : "merge-ready";
  return nudge(playbook, `not ready: ${blockers.join("; ")}`);
}

function readyIntent(ctx) {
  const { pr, facts } = ctx;
  if (!pr) return { type: "none", reason: ctx.classified.reason };
  const needsApprove = pr.reviewDecision === "REVIEW_REQUIRED";
  const title = needsApprove ? `${facts.label} ready. Needs approve.` : `${facts.label} ready. Merge?`;
  const body = `${facts.prRef} at ${facts.head}: CI green, 0 open threads${needsApprove ? ", review required" : ""}.`;
  return {
    type: "ask", reason: ctx.classified.reason,
    question: question(ctx, title, body, needsApprove ? ["approved", "later"] : ["merged", "later"],
      `ready:${pr.ref}:${facts.head}`, "ready")
  };
}

function resolveIntent(ctx, intent) {
  const base = baseDecision(ctx);
  if (intent.type === "none") return { ...base, reason: intent.reason ?? base.reason };
  if (intent.type === "wait") return { ...base, action: "wait", reason: intent.reason, notBefore: intent.notBefore ?? null };
  if (intent.type === "escalate") return resolveEscalation(ctx, intent, base);
  // The owner typing into this thread outranks anything that touches it.
  const ownerUntil = ownerActiveUntil(ctx.thread, ctx.limits, ctx.now);
  if (ownerUntil) return { ...base, action: "wait", reason: "owner active in thread", notBefore: ownerUntil };
  if (intent.type === "ask") {
    return { ...base, action: "ask-user", reason: intent.reason, question: intent.question, notBefore: intent.notBefore ?? null };
  }
  return resolveNudge(ctx, intent, base);
}

function resolveNudge(ctx, intent, base) {
  const { thread, limits, now, ledger } = ctx;
  const decision = { ...base, playbook: intent.playbook, reason: intent.reason };
  const playbook = ctx.playbooks.get(intent.playbook);
  if (!playbook) return { ...decision, reason: `playbook missing: ${intent.playbook}` };
  if (deliberateStop(thread)) return { ...decision, reason: "owner stopped this turn" };
  if (!intent.immediate) {
    const idleUntil = addMs(latest(thread.lastAgentAt, thread.lastActivityAt), limits.idleBeforeNudgeMs);
    if (idleUntil && Date.parse(idleUntil) > now) return { ...decision, action: "wait", reason: "recently active", notBefore: idleUntil };
  }
  const cooldownMs = playbook.cooldownMin ? playbook.cooldownMin * MIN : limits.nudgeCooldownMs;
  const cooledAt = addMs(ledger.lastNudgeAt, cooldownMs);
  if (cooledAt && Date.parse(cooledAt) > now) return { ...decision, action: "wait", reason: "cooldown", notBefore: cooledAt };
  const undelivered = undeliveredStreak(ledger, thread);
  if (undelivered) {
    // Asked once per failure streak: after the owner's answer it only retries.
    const due = !undelivered.ackedAt && undelivered.count >= UNDELIVERED_ASK_COUNT && now - Date.parse(undelivered.since) >= UNDELIVERED_ASK_MS;
    if (due) return undeliveredDecision(ctx, decision, undelivered);
    const retryAt = addMs(undelivered.lastAt, Math.min(UNDELIVERED_BACKOFF_MS * 2 ** (undelivered.count - 1), UNDELIVERED_BACKOFF_MAX_MS));
    if (retryAt && Date.parse(retryAt) > now) {
      return { ...decision, action: "wait", reason: `can't deliver (${undelivered.reason}); retry after backoff`, notBefore: retryAt };
    }
  }
  const attempts = attemptsWithoutProgress(ledger, ctx.progressMark);
  const maxAttempts = playbook.maxAttempts ?? limits.maxNudgesWithoutProgress;
  const vars = { ...ctx.facts, attempts: String(attempts), ...(intent.vars ?? {}) };
  if (attempts >= maxAttempts) return stuckDecision(ctx, playbook, vars, attempts, decision);
  const route = chooseRoute(thread, ctx.mode, ctx.delivery);
  if (!route) {
    // No route only because computer use cannot type right now (a locked
    // screen, secure input), in either computer-use mode: the supervisor
    // tells the owner why once it has waited a while.
    const ui = deliveryOf(ctx.delivery);
    const uiBlocked = ui.mode !== "cli" && ui.ready === false && Boolean(uiTargetFor(thread));
    const waitUi = uiWaitReason(thread, ctx.delivery);
    if (waitUi) return { ...decision, action: "wait", reason: `${waitUi}; ${decision.reason}`, uiBlocked };
    return { ...unreachableDecision(ctx, decision), uiBlocked };
  }
  return { ...decision, action: "nudge", route, message: renderTemplate(playbook.body, vars) };
}

function stuckDecision(ctx, playbook, vars, attempts, decision) {
  if (!playbook.ask) return { ...decision, reason: `stopped after ${attempts} nudges; owner not pinged by policy` };
  const left = ctx.facts.blockers || ctx.classified.reason;
  return {
    ...decision, action: "ask-user", reason: `${attempts} nudges without progress`,
    question: question(ctx, renderTemplate(playbook.ask, vars),
      `${ctx.facts.label}: ${attempts} nudges, no new head, no thread resolved. Left: ${left}.`, ["keep going", "stop"],
      `stuck:${ctx.thread.key}:${playbook.id}:${ctx.progressMark.head ?? "none"}`, "stuck")
  };
}

// Sends that keep failing back off (5, 10, 20, 40, then 60 min), and after
// three over half an hour the owner hears about it once, with the reason.
// Work in the thread since the last failure (the owner nudged it) clears it.
const UNDELIVERED_BACKOFF_MS = 5 * MIN;
const UNDELIVERED_BACKOFF_MAX_MS = 60 * MIN;
const UNDELIVERED_ASK_COUNT = 3;
const UNDELIVERED_ASK_MS = 30 * MIN;

function undeliveredStreak(ledger, thread) {
  const streak = ledger?.undelivered;
  if (!streak?.count || !Number.isFinite(Date.parse(streak.lastAt ?? "")) || !Number.isFinite(Date.parse(streak.since ?? ""))) return null;
  const activity = Date.parse(latest(thread.lastAgentAt, thread.lastActivityAt) ?? "");
  return Number.isFinite(activity) && activity > Date.parse(streak.lastAt) ? null : streak;
}

// What the owner can do about a known failure.
function deliveryHint(reason) {
  const text = String(reason ?? "");
  if (/two threads share this title|two sessions share this title|two workspaces share this name/.test(text)) return " Two chats share its name: rename or archive one.";
  if (/could not verify thread|another (?:thread|session) is open|no session tab open/.test(text)) return " The app would not show this thread.";
  if (/not running/.test(text)) return " Its app is closed.";
  if (/computer use not ready/.test(text)) return " Computer use is not ready on this Mac.";
  return "";
}

function undeliveredDecision(ctx, decision, streak) {
  const minutesStuck = minutes(ctx.now - Date.parse(streak.since));
  return {
    ...decision, action: "ask-user", reason: `can't deliver: ${streak.reason}.${deliveryHint(streak.reason)}`,
    question: question(ctx, `${ctx.facts.label} stopped. Can't nudge it. Nudge it?`,
      `${ctx.facts.label} needs "${decision.playbook}". ${streak.count} sends failed over ${minutesStuck}m: ${streak.reason}.${deliveryHint(streak.reason)}`,
      ["done", "skip"], `deliver:${ctx.thread.key}`, "deliver")
  };
}

function unreachableDecision(ctx, decision) {
  const idle = msSince(latest(ctx.thread.lastAgentAt, ctx.thread.lastActivityAt), ctx.now);
  const threshold = ctx.limits.unreachableAskMs ?? UNREACHABLE_ASK_MS;
  if (idle === null || idle < threshold) return { ...decision, reason: `${decision.reason}; no delivery route` };
  return {
    ...decision, action: "ask-user", reason: "stuck and unreachable",
    question: question(ctx, `${ctx.facts.label} stuck. Can't reach it. Open it?`,
      `${ctx.facts.label} idle ${minutes(idle)}m. ${decision.reason}. No live session to message.`, ["opened", "skip"],
      `open:${ctx.thread.key}`, "open")
  };
}

function resolveEscalation(ctx, intent, base) {
  const { limits, now } = ctx;
  const decision = { ...base, playbook: intent.playbook, reason: intent.reason, targetKey: ctx.manager?.key ?? null };
  const playbook = ctx.playbooks.get(intent.playbook);
  if (!playbook) return { ...decision, reason: `playbook missing: ${intent.playbook}` };
  const cooldownMs = playbook.cooldownMin ? playbook.cooldownMin * MIN : limits.managerEscalationCooldownMs;
  // One incident, one cooldown: the infra-level escalation of the same
  // incident counts, not just this thread's own sends.
  const incidentKey = ESCALATION_KEYS[intent.playbook];
  const lastAt = latest(lastPlaybookAt(ctx.ledger, intent.playbook), incidentKey ? readLedger(ctx.escalationLedger, "lastEscalation", incidentKey) : null);
  const cooledAt = addMs(lastAt, cooldownMs);
  if (cooledAt && Date.parse(cooledAt) > now) return { ...decision, action: "wait", reason: `escalated; ${intent.reason}`, notBefore: cooledAt };
  const busy = managerBusy(ctx.manager, limits, now);
  if (busy) return { ...decision, action: "wait", reason: `${busy.reason}; ${intent.reason}`, notBefore: busy.notBefore };
  const vars = { ...ctx.facts, ...intent.vars };
  const route = managerRoute(ctx.manager, ctx.mode, limits, now, ctx.delivery);
  // A manager that is down stays offline whatever computer use does.
  const waitUi = route || !ctx.manager || managerDown(ctx.manager, now) ? null : uiBlockedReason(ctx.manager, ctx.delivery);
  if (waitUi) return { ...decision, action: "wait", reason: `${waitUi}; ${intent.reason}`, uiBlocked: true };
  if (!route) {
    return {
      ...decision, action: "ask-user",
      question: question(ctx, renderTemplate(playbook.ask, vars), `${vars.problems}. Manager offline.`, ["opened", "later"],
        `manager-offline:${intent.playbook}`, "infra")
    };
  }
  return { ...decision, action: "escalate-manager", route, message: renderTemplate(playbook.body, vars) };
}

function baseDecision(ctx) {
  const { classified, thread } = ctx;
  return {
    threadKey: thread.key, state: classified.state, action: "none", playbook: null, message: null,
    reason: classified.reason, blockers: classified.blockers ?? [], question: null, route: null, notBefore: null,
    targetKey: thread.key, progressMark: ctx.progressMark
  };
}

function ownerActiveUntil(thread, limits, now) {
  if (String(thread.lastUserText ?? "").startsWith(SUPERVISOR_PREFIX)) return null;
  const at = Date.parse(thread.lastUserAt ?? "");
  if (!Number.isFinite(at)) return null;
  const until = at + limits.ownerRecentMs;
  return until > now ? new Date(until).toISOString() : null;
}

// Progress = a new head, or fewer open review threads, since the last nudge.
// A stopped thread with no PR head to move shows progress by working: the
// agent's words came at least WORKED_MS after the last nudge. worked names
// that nudge, so a new one resets the budget and a quick relapse does not.
const WORKED_MS = 10 * MIN;
function progressMarkFor(classified, thread, ledger) {
  const mark = classified.readiness?.progressMark ?? { head: null, unresolved: null };
  // A promised stop counts the agent's own work since the last nudge too:
  // research has no head to move.
  if (classified.state !== "stopped" && !classified.idle?.promised) return mark;
  const nudgedAt = Date.parse(ledger?.lastNudgeAt ?? "");
  const agentAt = Date.parse(thread.lastAgentAt ?? "");
  const worked = Number.isFinite(nudgedAt) && Number.isFinite(agentAt) && agentAt - nudgedAt >= WORKED_MS
    ? ledger.lastNudgeAt : (ledger?.lastProgressMark?.worked ?? null);
  return { ...mark, worked };
}

function attemptsWithoutProgress(ledger, mark) {
  const last = ledger?.lastProgressMark;
  if (last && mark) {
    const headMoved = Boolean(mark.head) && mark.head !== last.head;
    const resolved = Number.isFinite(mark.unresolved) && Number.isFinite(last.unresolved) && mark.unresolved < last.unresolved;
    const worked = Boolean(mark.worked) && mark.worked !== last.worked;
    if (headMoved || resolved || worked) return 0;
  }
  return Number(ledger?.attemptsWithoutProgress) || 0;
}

function lastPlaybookAt(ledger, playbookId) {
  let at = null;
  for (const entry of ledger?.nudges ?? []) {
    if (entry?.playbook === playbookId && (at === null || Date.parse(entry.at) > Date.parse(at))) at = entry.at;
  }
  return at;
}

// ---------------------------------------------------------------------------
// Infra decisions

// Shared by decideInfra and the supervisor (which records `down` per tick
// with store.setInfraDown so the next tick can see a recovery).
export function infraHealth(infra, { config = null, now = Date.now() } = {}) {
  const limits = limitsOf(config);
  const bb3 = infra?.bb3 ?? null;
  const lb = infra?.lb ?? null;

  const slow = slowRuns(bb3, limits);
  const bb3Problems = [];
  if (bb3?.reachable === false) bb3Problems.push("SSH unreachable");
  const gateMs = msSince(bb3?.gate?.since, now);
  if (bb3?.gate?.state === "blocked" && gateMs !== null && gateMs >= limits.gateBlockedEscalateMs) {
    bb3Problems.push(`gate blocked ${minutes(gateMs)}m${bb3.gate.reason ? ` (${clampText(bb3.gate.reason, 80)})` : ""}`);
  }
  if (slow.full.length) bb3Problems.push(`${slow.full.length} full verify >${minutes(limits.fullVerifyEscalateMs)}m`);
  if (slow.quick.length) bb3Problems.push(`${slow.quick.length} bb-quick >${minutes(limits.quickVerifyEscalateMs)}m`);
  if (bb3?.timersDead?.length) bb3Problems.push(`timers dead: ${bb3.timersDead.map((name) => fact(name, 40)).join(", ")}`);

  // The log window is an hour; only recent rows say the LB is down now.
  const freshMs = limits.lbErrorFreshMs ?? LB_ERROR_FRESH_MS;
  const lbErrors = (lb?.recentErrors ?? []).filter((entry) => LB_ALARM_KINDS.has(entry.kind) && Number(entry.count) > 0
    && isFresh(entry.lastAt, freshMs, now));
  const lbProblems = [];
  if (lb?.healthy === false) lbProblems.push(`LB unhealthy${lb.detail ? ` (${fact(lb.detail, 80)})` : ""}`);
  for (const entry of lbErrors) lbProblems.push(`${Number(entry.count)}x ${entry.kind}`);

  return {
    bb3: {
      down: bb3?.reachable === false || bb3?.gate?.state === "blocked",
      up: bb3?.reachable === true && bb3?.gate?.state !== "blocked",
      problems: bb3Problems,
      slow
    },
    lb: {
      down: lb?.healthy === false || lbErrors.some((entry) => entry.kind !== "auth"),
      up: lb?.healthy === true && lbErrors.length === 0 && lb?.errorsUnknown !== true,
      problems: lbProblems
    }
  };
}

// threads: [{ thread, classified, ledger?, pr? }] from this tick.
// ledger: the FleetStore (lastEscalation(key), infraDown(kind), optional
// infraDownSince(kind)) or plain maps with the same names.
// blockedKeys: { bb3: [], lb: [] } thread keys seen blocked while it was down.
// mutedKeys: thread keys the owner muted; they get no recovery nudge.
export function decideInfra(infra, options = {}) {
  const { ledger = {}, playbooks = new Map(), config = null, now = Date.now(), threads = [], manager = null, blockedKeys = null } = options;
  const mode = options.mode ?? config?.mode ?? "observe";
  const limits = limitsOf(config);
  const delivery = options.delivery ?? config?.delivery ?? null;
  const mutedKeys = keySet(options.mutedKeys);
  const health = infraHealth(infra, { config, now });
  const decisions = [];
  for (const kind of ["bb3", "lb"]) {
    const state = health[kind];
    const key = `infra:${kind}`;
    const wasDown = readLedger(ledger, "infraDown", kind) === true;
    const remembered = keySet(blockedKeys?.[kind]);
    // Remembered threads left after the recovery tick (send cap, cooldown, a
    // failed source) keep getting their resume until it was tried.
    if (state.up && (wasDown || remembered.size)) {
      if (wasDown) decisions.push(infraDecision(key, { reason: `${INFRA_NAMES[kind]} recovered` }));
      decisions.push(...recoveryNudges(kind, { threads, playbooks, config, now, mode, infra, remembered, mutedKeys, delivery }));
      if (wasDown) continue;
    }
    if (!state.problems.length) continue;
    // One failed SSH is often a blip; act when it fails on a second tick.
    const onlySsh = kind === "bb3" && state.problems.length === 1 && infra?.bb3?.reachable === false;
    if (onlySsh && !wasDown) {
      decisions.push(infraDecision(key, { action: "wait", reason: "BuildBot3 SSH failed once", blockers: state.problems }));
      continue;
    }
    decisions.push(escalateInfra(kind, state.problems, { infra, ledger, playbooks, limits, now, manager, mode, threads, delivery }));
    const downSince = readLedger(ledger, "infraDownSince", kind);
    const downMs = msSince(downSince, now);
    if (state.down && downMs !== null && downMs >= LONG_DOWN_MS) {
      // A box that answers but refuses builds (its gate, e.g. low disk) is
      // not down, and a reboot would not fix it: say which it is.
      // Only a probe that got through vouches for the gate's reason; an
      // incomplete one (reachable null) leaves the cause unknown.
      const reachable = infra?.bb3?.reachable;
      const gated = kind === "bb3" && reachable === true && infra?.bb3?.gate?.state === "blocked";
      const title = kind !== "bb3" ? "Codex LB down 1h+. Help?"
        : gated ? `BB3 builds paused 1h+${infra.bb3.gate.reason ? `: ${clampText(infra.bb3.gate.reason, 40)}` : ""}. Fix it?`
        : reachable === false ? "BB3 unreachable 1h+. Reboot box?"
        : "BB3 out 1h+, cause unknown. Check it?";
      decisions.push(infraDecision(key, {
        action: "ask-user", reason: `${INFRA_NAMES[kind]} down ${minutes(downMs)}m`, blockers: state.problems,
        question: clampQuestion({ title, body: `${state.problems.join("; ")}.`, options: ["on it", "later"], dedupeKey: `${key}:long-down`, kind: "infra" }, limits)
      }));
    }
  }
  return decisions;
}

function escalateInfra(kind, problems, { infra, ledger, playbooks, limits, now, manager, mode, threads, delivery = null }) {
  const key = `infra:${kind}`;
  const playbookId = kind === "bb3" ? "manager-bb3" : "manager-lb";
  const base = infraDecision(key, { playbook: playbookId, reason: problems.join("; "), blockers: problems, targetKey: manager?.key ?? null });
  const playbook = playbooks.get(playbookId);
  if (!playbook) return { ...base, reason: `playbook missing: ${playbookId}` };
  const cooldownMs = playbook.cooldownMin ? playbook.cooldownMin * MIN : limits.managerEscalationCooldownMs;
  const cooledAt = addMs(readLedger(ledger, "lastEscalation", key), cooldownMs);
  if (cooledAt && Date.parse(cooledAt) > now) return { ...base, action: "wait", reason: `escalated; ${base.reason}`, notBefore: cooledAt };
  const busy = managerBusy(manager, limits, now);
  if (busy) return { ...base, action: "wait", reason: `${busy.reason}; ${base.reason}`, notBefore: busy.notBefore };
  const vars = kind === "bb3" ? { ...bb3Vars(infra?.bb3, problems, limits), waiting: waitingLines(threads, limits) } : lbVars(infra?.lb, problems);
  const route = managerRoute(manager, mode, limits, now, delivery);
  const waitUi = route || !manager || managerDown(manager, now) ? null : uiBlockedReason(manager, delivery);
  if (waitUi) return { ...base, action: "wait", reason: `${waitUi}; ${base.reason}`, uiBlocked: true };
  if (!route) {
    return {
      ...base, action: "ask-user",
      question: clampQuestion({
        title: renderTemplate(playbook.ask, vars), body: `${INFRA_NAMES[kind]}: ${problems.join("; ")}. Manager offline.`,
        options: ["opened", "later"], dedupeKey: `${key}:manager-offline`, kind: "infra"
      }, limits)
    };
  }
  return { ...base, action: "escalate-manager", route, message: renderTemplate(playbook.body, vars) };
}

// Only one escalation per manager per tick carries the news, so it names
// every thread whose verify wait would have escalated on its own.
function waitingLines(threads, limits) {
  const lines = [];
  for (const item of threads ?? []) {
    const slow = item?.thread && escalatedWait(item.classified, item.pr ?? null, limits);
    if (slow) lines.push(waitingLine(factsFor(item.thread, item.pr ?? null, item.classified), slow.what, slow.age));
  }
  const extra = lines.length > 4 ? ` +${lines.length - 4} more waiting.` : "";
  return `${lines.slice(0, 4).join(" ")}${extra}`;
}

function recoveryNudges(kind, { threads, playbooks, config, now, mode, infra, remembered = new Set(), mutedKeys = new Set(), delivery = null }) {
  const out = [];
  for (const item of threads ?? []) {
    const thread = item?.thread;
    const classified = item?.classified;
    if (!thread || !classified || mutedKeys.has(thread.key)) continue;
    if (!recoverable(kind, classified, remembered.has(thread.key))) continue;
    // A thread still inside a turn or a background wait will notice by itself.
    if (thread.agentStatus === "running" || thread.agentStatus === "waiting") continue;
    const ctx = makeContext(classified, thread, { ledger: item.ledger, playbooks, config, now, pr: item.pr ?? null, mode, infra, delivery });
    const decision = resolveIntent(ctx, nudge("infra-recovered", `${INFRA_NAMES[kind]} is up`, { immediate: true, vars: { what: INFRA_NAMES[kind] } }));
    if (decision.action !== "none") out.push(decision);
  }
  return out;
}

// Blocked on this infra now, or remembered as blocked while it was down (the
// log rows that marked it may have aged out). Remembered threads that now ask
// the owner, wait on the owner, or are done are left alone.
function recoverable(kind, classified, remembered) {
  const { state, infraKind } = classified;
  if ((state === "infra-blocked" || state === "waiting-ci") && infraKind === kind) return true;
  if (!remembered) return false;
  if (state === "pr-not-ready" || state === "idle-no-pr" || state === "stopped") return true;
  return state === "waiting-ci" && !infraKind;
}

function infraDecision(key, patch) {
  return {
    threadKey: key, state: "infra", action: "none", playbook: null, message: null, reason: "", blockers: [],
    question: null, route: null, notBefore: null, targetKey: null, progressMark: null, ...patch
  };
}

function slowRuns(bb3, limits) {
  const runs = Array.isArray(bb3?.runs) ? bb3.runs : [];
  const ageMs = (run) => Number(run?.ageSec) * 1000;
  const oldestFirst = (a, b) => ageMs(b) - ageMs(a);
  return {
    full: runs.filter((run) => run?.kind === "full" && ageMs(run) >= limits.fullVerifyEscalateMs).sort(oldestFirst),
    quick: runs.filter((run) => run?.kind === "quick" && ageMs(run) >= limits.quickVerifyEscalateMs).sort(oldestFirst)
  };
}

function bb3Vars(bb3, problems, limits) {
  const slow = slowRuns(bb3, limits);
  const runs = [...slow.full, ...slow.quick].slice(0, 6).map((run) => {
    const who = run.pr ? `#${Number(run.pr)}` : fact(run.head, 10) || "?";
    const owner = run.owner ? ` (${fact(run.owner, 30)})` : "";
    return `${who} ${run.kind} ${minutes(Number(run.ageSec) * 1000)}m${owner}`;
  });
  const gate = bb3?.gate?.state ? `${fact(bb3.gate.state, 20)}${bb3.gate.reason ? ` (${fact(bb3.gate.reason, 100)})` : ""}` : "unknown";
  const count = (value) => (Number.isFinite(value) ? String(value) : "?");
  return {
    problems: problems.join("; "),
    gate,
    queue: `full ${count(bb3?.fullQueue)}, quick ${count(bb3?.quickQueue)}`,
    load: Array.isArray(bb3?.load) && bb3.load.length ? bb3.load.map((n) => Math.round(Number(n))).join("/") : "?",
    runs: runs.join("; ") || "none",
    timers: (bb3?.timersDead ?? []).map((name) => fact(name, 40)).join(", ") || "none",
    waiting: ""
  };
}

function lbVars(lb, problems) {
  return { problems: problems.join("; "), watch: lb?.watchLine ? `Watch log: ${fact(lb.watchLine, 160)}` : "" };
}

// Keep one sending decision per thread per tick (infra recovery and the
// thread's own decision can both pick the same nudge), and one escalation
// per manager and playbook (the infra incident and every slow thread can all
// escalate the same jam). Earlier entries win; infra decisions come first.
export function dedupeDecisions(decisions) {
  const sent = new Set();
  const escalated = new Set();
  return (decisions ?? []).filter((decision) => {
    if (decision?.action === "escalate-manager") {
      const key = `${decision.targetKey ?? ""}\u0000${decision.playbook ?? ""}`;
      if (escalated.has(key)) return false;
      escalated.add(key);
      return true;
    }
    if (decision?.action !== "nudge") return true;
    if (sent.has(decision.threadKey)) return false;
    sent.add(decision.threadKey);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Facts and text helpers

function factsFor(thread, pr, classified) {
  const blockers = (classified.blockers?.length ? classified.blockers : classified.readiness?.blockers) ?? [];
  const prRef = pr?.ref ?? thread.prRefs?.[0] ?? "";
  const prNumber = pr?.number ?? Number(/#(\d+)$/.exec(prRef)?.[1]);
  const knownPr = Number.isFinite(prNumber) && prNumber > 0 ? prNumber : null;
  // A PR done before the agent last spoke is old work on a reused branch
  // (kingston's disk-full asks titled "ads #2", merged weeks earlier), so
  // the label names the place instead.
  const pastPr = prDoneBefore(pr, latest(thread.lastAgentAt, thread.meta?.pendingQuestion?.at));
  return {
    pr: knownPr ? String(knownPr) : "",
    prRef: fact(prRef, 80),
    repo: fact(pr?.repo ?? thread.repo, 80),
    head: shortSha(pr?.headOid),
    ci: ciSummary(pr),
    blockers: blockers.map((blocker) => fact(blocker, 80)).join("; "),
    blocker: fact(blockers[0], 80),
    mergeGate: gateFact(pr),
    thread: agentLabel(thread),
    label: pastPr ? ownerLabel(thread, null, null) : ownerLabel(thread, knownPr, pr?.repo ?? parsePrRef(prRef)?.repo),
    reset: formatTime(thread.error?.resetAt)
  };
}

function prDoneBefore(pr, at) {
  if (!pr || !DONE_PR_STATES.has(pr.state)) return false;
  const doneAt = Date.parse(pr.mergedAt ?? pr.closedAt ?? "");
  return Number.isFinite(doneAt) && doneAt < Date.parse(at ?? "");
}

// What a PR must show green on its head: the repo's required checks (the
// BuildBot3 full run for BuildBetter), else hosted CI.
function gateFact(pr) {
  const gates = (pr?.gates ?? []).filter((gate) => gate?.label || gate?.name);
  if (!gates.length) return "green hosted CI";
  const names = gates.map((gate) => `${gate.label || gate.name}${gate.how ? ` (${gate.how})` : ""}`);
  return fact(`a green ${names.join(" and ")}`, 160);
}

// Safe for agent-bound text: one line, no markup characters, bounded.
function fact(value, max = 120) {
  return String(value ?? "").replace(/[\u0000-\u001f<>`]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function agentLabel(thread) {
  const raw = thread.workspace || `${thread.kind} ${String(thread.id ?? "").slice(0, 8)}`;
  return String(raw).replace(/[^\w .:#-]+/g, "").slice(0, 40);
}

// Repo and PR name the work; else the folder, else the Codex app's name.
// Never a thread title: a Claude one can be the owner's last message, a
// Codex one an automation prompt. Never a session id either.
export function ownerLabel(thread, prNumber, repo) {
  const repoName = fact(String(repo ?? "").split("/").pop(), 30);
  if (prNumber && repoName) return `${repoName} #${prNumber}`;
  const place = fact(thread.workspace || String(thread.cwd ?? "").replace(/\/+$/, "").split("/").pop(), 30)
    || (thread.kind === "codex" ? fact(stripTags(thread.meta?.catalogName), 30) : "");
  if (prNumber) return place ? `${place} #${prNumber}` : `#${prNumber}`;
  return place || `${KIND_NAMES[thread.kind] ?? "Agent"} chat`;
}

function ciSummary(pr) {
  if (!pr) return "unknown";
  const ci = pr.ci ?? {};
  if (CI_FAILING.has(ci.state) || ci.failing?.length) {
    const names = (ci.failing ?? []).slice(0, 5).map((name) => fact(name, 60)).filter(Boolean).join(", ");
    return `fail (${names || "see checks"})`;
  }
  if (ci.state === "SUCCESS") return "pass";
  if (ci.state === "PENDING" || ci.state === "EXPECTED") return "running";
  return "no checks";
}

function modelName(thread) {
  const fromError = /reached your ([A-Za-z][\w.-]{0,20}) limit/i.exec(String(thread.error?.text ?? ""))?.[1];
  return fact(fromError || thread.meta?.model || "Model", 30);
}

function ownerExcerpt(text, max) {
  return clampText(stripTags(redactSecrets(text)), max);
}

function stripTags(text) {
  return String(text ?? "").replace(/<[^>]{0,200}>/g, " ");
}

function question(ctx, title, body, options, dedupeKey, kind) {
  return clampQuestion({ title, body, options, dedupeKey, kind }, ctx.limits);
}

function clampQuestion(q, limits) {
  return {
    title: clampText(q.title, limits.titleMax),
    body: clampText(q.body, limits.bodyMax),
    options: q.options.map((option) => clampText(option, 40)),
    dedupeKey: q.dedupeKey,
    kind: q.kind
  };
}

function shortSha(sha) {
  return /^[0-9a-f]{7,40}$/i.test(String(sha ?? "")) ? String(sha).slice(0, 10) : "";
}

function formatTime(iso) {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return "";
  return new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function minutes(ms) {
  return Math.round(Number(ms) / MIN);
}

function limitsOf(config) {
  return { ...DEFAULTS, ...(config?.limits ?? {}) };
}

function addMs(iso, ms) {
  const at = Date.parse(iso ?? "");
  return Number.isFinite(at) && Number.isFinite(ms) ? new Date(at + ms).toISOString() : null;
}

function latest(...values) {
  let best = null;
  for (const value of values) {
    const at = Date.parse(value ?? "");
    if (Number.isFinite(at) && (best === null || at > Date.parse(best))) best = value;
  }
  return best;
}

function isFresh(iso, maxAgeMs, now) {
  // A row with no time cannot be aged out, so it still counts.
  const at = Date.parse(iso ?? "");
  return !Number.isFinite(at) || now - at <= maxAgeMs;
}

function keySet(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value);
  if (typeof value?.has === "function") return value;
  return new Set();
}

function readLedger(ledger, name, key) {
  const source = ledger?.[name];
  if (typeof source === "function") {
    try { return source.call(ledger, key); } catch { return null; }
  }
  return source?.[key] ?? null;
}
