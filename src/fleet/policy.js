// Pure policy: a classified thread (or the infra snapshot) -> FleetDecisions.
// No I/O. Messages to agents are built only from playbook text plus
// supervisor facts (PR number, head, CI names, counts, ages). Agent text is
// untrusted and may carry instructions, so it never goes into a message
// another agent reads; the owner sees at most a tag-stripped 220-char excerpt.

import {
  CARD_STALE_MS, DEFAULTS, SUPERVISOR_PREFIX, clampTail, clampText, codexExecBarred, isMainHealthCheck, kindName, liveCardItems, msSince, parsePrRef,
  redactSecrets, shortHash, uiTargetFor
} from "./contracts.js";
import { blockedOnSection, deliberateStop, ownerStoppedNudge } from "./classify.js";
import { renderTemplate } from "./playbooks.js";
import { requiredChecksFor } from "./sources/github.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const FAR_RESET_MS = 8 * HOUR;
const UNREACHABLE_ASK_MS = 90 * MIN;
const LONG_DOWN_MS = HOUR;
// LB log rows older than this say nothing about the LB now.
const LB_ERROR_FRESH_MS = 15 * MIN;
// The LB watcher writes a line about every half hour; one this recent still
// vouches for the LB.
const LB_WATCH_FRESH_MS = 45 * MIN;

const LIMIT_KINDS = new Set(["session-limit", "usage-limit"]);
const BACKOFF_KINDS = new Set(["overloaded", "network"]);
const MANAGER_DOWN_KINDS = new Set(["session-limit", "usage-limit", "model-limit", "logged-out", "disk-full"]);
const RESUME_STATUSES = new Set(["aborted", "stalled", "error"]);
const CI_DONE = new Set(["SUCCESS", "FAILURE", "ERROR"]);
const CI_FAILING = new Set(["FAILURE", "ERROR"]);
const DONE_PR_STATES = new Set(["MERGED", "CLOSED"]);
// Blockers only GitHub (or a later git read) can clear; nudging the agent
// does nothing for them. "100+ threads, not all read" is the supervisor's own
// read limit, not news for the agent (its merge-ready pass reads them all).
const PASSIVE_BLOCKERS = new Set(["CI running", "Codex review not on head", "mergeability unknown", "local git unknown", "100+ threads, not all read"]);
// "CI running", or a required check still running ("BuildBot3 full run pending").
// A gate GitHub did not finish reading waits for the next read like a running one.
const ciRunning = (blocker) => blocker === "CI running" || / (?:pending|unread)$/.test(blocker);
// The BuildBot3 full run publishes the verification certificate: while that
// run is still pending, its red certificate check is the same wait.
const passiveAmong = (blockers) => (blocker) => PASSIVE_BLOCKERS.has(blocker) || ciRunning(blocker)
  || (blocker === "CI red: verification-certificate" && blockers.some((item) => /^BuildBot3 full run (?:pending|unread)$/.test(item)));
const LB_ALARM_KINDS = new Set(["no-accounts", "auth", "connection", "unavailable"]);
// A single dropped stream or timeout in one chat is routine, not an outage,
// even more so while the LB's own probe says it is healthy. These kinds alarm
// only when corroborated.
const LB_TRANSIENT_KINDS = new Set(["connection", "unavailable"]);
const LB_TRANSIENT_MIN = 3;
const INFRA_NAMES = { bb3: "BuildBot3", lb: "Codex LB" };
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
  // Antigravity takes messages through its own API (agentapi send-message):
  // nothing is typed or forked, the app shows it in the conversation, so
  // every delivery mode may use it.
  if (thread.kind === "antigravity") return "antigravity-send";
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
  // Conductor forks it, the same as claude-resume would; one the Codex app
  // started would be locked out of the app for the whole turn.
  if (thread.kind === "codex") return thread.writerLocked || !thread.cwd || codexExecBarred(thread) ? null : "codex-exec";
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
// options.ownerPush: the owner's Push now, which no pacing wait holds.
export function decideThread(classified, thread, options = {}) {
  const ctx = makeContext(classified, thread, options);
  if (ctx.mutedKeys.has(thread?.key)) return { ...baseDecision(ctx), reason: "muted by owner" };
  // No nudge, resume or stuck question about a thread whose owner just
  // stopped the supervisor's own turn there. An open card is still asked.
  const decision = ownerStoppedNudge(thread) && !ctx.ownerPush
    ? { ...baseDecision(ctx), reason: "owner stopped the supervisor's turn" }
    : resolveIntent(ctx, intentFor(ctx));
  // A Codex card beside the thread's own decision (a resume, a nudge, a
  // question): its question is asked too.
  const card = classified.card ? cardIntent(ctx, classified.card.card) : null;
  return card?.question ? { ...decision, cardQuestion: card.question } : decision;
}

function makeContext(classified, thread, options) {
  const { ledger = null, playbooks = new Map(), config = null, now = Date.now(), pr = null, infra = null, manager = null, escalationLedger = null } = options;
  const mode = options.mode ?? config?.mode ?? "observe";
  const limits = limitsOf(config);
  const delivery = options.delivery ?? config?.delivery ?? null;
  return {
    classified, thread, pr, infra, manager, playbooks, limits, now, mode, escalationLedger, delivery, config,
    // The owner's own Push now (supervisor pushNow): see resolveNudge.
    ownerPush: options.ownerPush === true,
    mutedKeys: keySet(options.mutedKeys),
    ledger: ledger ?? {},
    progressMark: progressMarkFor(classified, thread, ledger),
    facts: factsFor(thread, pr, classified, config)
  };
}

const DAY_MS = 24 * 60 * MIN;
const IDLE_REPORT_DAILY_MAX = 2;

function intentFor(ctx) {
  const { classified } = ctx;
  switch (classified.state) {
    case "infra-blocked": return infraIntent(ctx);
    case "waiting-ci": return waitingIntent(ctx);
    case "local-verify": return nudge("no-local-verify", "heavy verification on the laptop", { immediate: true, vars: localVerifyVars(classified.localVerify) });
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

// The agent whose account hit a cap or logged out: Conductor chats run Claude.
function agentName(thread) {
  return thread.kind === "conductor" ? "Claude" : kindName(thread.kind);
}

// Which process the laptop check saw, so the agent can look at that one.
function localVerifyVars(proc) {
  const pid = Number(proc?.pid);
  const ageSec = Number(proc?.ageSec);
  return { pid: Number.isInteger(pid) && pid > 0 ? String(pid) : "?", age: Number.isFinite(ageSec) ? String(Math.round(ageSec / 60)) : "?" };
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
      const who = agentName(thread);
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
    const who = agentName(thread);
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

// The repo's merge gate is the BuildBot3 full run itself: a required check
// named for it, or one produced by bb-verify --full. Another required check
// (deploy, lint) leaves hosted CI as the gate for a slow full run.
const FULL_RUN_CHECK = "BuildBot3 full verification";
const FULL_RUN_HOW = /\bbb-verify\b.*--full\b/;

function isFullRunGate(gate) {
  return gate?.name === FULL_RUN_CHECK || FULL_RUN_HOW.test(String(gate?.how ?? ""));
}

function fullRunGated(pr, thread, config) {
  const repo = pr?.repo ?? thread?.repo ?? null;
  const gates = pr?.gates?.length ? pr.gates : repo ? requiredChecksFor(repo, config) : [];
  return gates.some(isFullRunGate);
}

// The full-run gate already finished on the head: a slow full run is over,
// whatever the task says. Another gate finishing proves nothing about it.
function fullRunGateDone(pr) {
  return (pr?.gates ?? []).some((gate) => isFullRunGate(gate) && CI_DONE.has(gate.state));
}

function ciFailing(pr) {
  return Boolean(pr) && (CI_FAILING.has(pr.ci?.state) || Boolean(pr.ci?.failing?.length));
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
    // Where the full BuildBot3 run is the merge gate, a slow one goes to the
    // manager, never a nudge to drop it. Elsewhere hosted CI is the gate: a
    // full run only reproduces a hosted CI failure.
    if (!fullRunGated(pr, thread, ctx.config) && !ciFailing(pr)) return nudge("bb3-slow-agent", `full verify ${minutes(age)}m; hosted CI not failing`, { immediate: true, vars: { age: minutes(age) } });
    // The gate already reported on an open PR: the task outlived it. Not
    // slow, so no manager; once CI is done the agent hears it.
    if (pr?.state === "OPEN" && fullRunGateDone(pr)) {
      if (ciDone) return nudge("ci-finished", "CI done; task still waiting", { immediate: true });
      if (!silent) return { type: "wait", reason: "full-run gate done; hosted CI still running" };
    }
    if (silent) return statusCheck("bb-verify --full", quietMs);
    const slowMs = slowFullWait(age, pr, ctx.infra?.bb3, limits);
    if (slowMs !== null) return escalateIntent(ctx, "bb-verify --full", slowMs);
  }
  if (wait.taskKind === "quick" && age >= limits.quickVerifyEscalateMs) {
    // The full-run gate already reported on the head: the bb-quick wait
    // outlived it (#7352 drew three manager alerts after its full run
    // passed). Not BuildBot3 being slow, so not the manager's.
    if (pr?.state === "OPEN" && fullRunGateDone(pr)) {
      if (ciDone) return nudge("ci-finished", "CI done; task still waiting", { immediate: true });
      return silent ? statusCheck("bb-quick", quietMs) : { type: "wait", reason: "full-run gate done; bb-quick task still open" };
    }
    return silent ? statusCheck("bb-quick", quietMs) : escalateIntent(ctx, "bb-quick", age);
  }
  if (wait.source === "task") {
    // Conductor wakes itself when the task ends. Past 45 min the task is a
    // stuck watcher or a long-lived process (a dev server), so treat it as idle.
    if (wait.taskKind || age < limits.waitingTaskMaxMs) return { type: "wait", reason: wait.reason ?? "waiting on a background task" };
    if (ciDone) return nudge("ci-finished", "CI done; task still waiting", { immediate: true });
    const blockers = classified.readiness?.blockers ?? [];
    // An agent that spoke within the idle window, or whose last words are
    // about other PRs, is not stuck behind its task: a loop wakes it
    // (cape-town merging #7063, #7091 and #7089 spoke seconds before the
    // scan, 247 min into the wait). A merge-ready nudge would talk over
    // that work, about a side PR it is not on.
    const awake = quietMs !== null && quietMs < limits.idleBeforeNudgeMs;
    const named = [...String(thread.lastAgentText ?? "").matchAll(/#(\d+)\b/g)].map((match) => Number(match[1]));
    const elsewhere = Number.isInteger(pr?.number) && named.length > 0 && !named.includes(pr.number);
    if (pr?.state === "OPEN" && blockers.length && !awake && !elsewhere && !blockers.some(ciRunning) && !blockers.every(passiveAmong(blockers))) {
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
  const missing = gates.find((gate) => !gate.state && !gate.unread);
  if (pr?.state === "OPEN" && (missing || (!gates.length && !ci.state)) && age >= limits.waitingTaskMaxMs) {
    return nudge("merge-ready", `${missing ? `${missing.label || missing.name} missing` : "no CI on head"} after waiting`);
  }
  // Nothing visible only once the PR is known to be none: a branch not yet
  // looked up (past the lookup budget, a failed read) or a PR not read is
  // unknown, and the agent may well be on it (01a0f89f on #7163).
  const prNone = !thread.prRefs?.length && (!thread.branch || thread.prLookedUp === true);
  if (!pr && prNone && age >= limits.waitingTaskMaxMs) return nudge("resume", `waited ${minutes(age)}m with nothing visible`);
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
function escalatedWait(classified, pr, limits, bb3, thread = null, config = null) {
  if (classified?.state !== "waiting-ci") return null;
  const wait = classified.wait ?? {};
  const age = wait.ageMs ?? 0;
  // Only a full run the merge needs (or that reproduces a hosted CI failure),
  // not over yet, and slow by BuildBot3's own clock.
  const counts = wait.taskKind === "full" && !fullRunGateDone(pr) && (fullRunGated(pr, thread, config) || ciFailing(pr));
  const slowMs = counts ? slowFullWait(age, pr, bb3, limits) : null;
  if (slowMs !== null) return { what: "bb-verify --full", age: slowMs };
  // A bb-quick wait that outlived the full-run gate is not BuildBot3's.
  const quickCounts = !(pr?.state === "OPEN" && fullRunGateDone(pr));
  if (wait.taskKind === "quick" && age >= limits.quickVerifyEscalateMs && quickCounts) return { what: "bb-quick", age };
  return null;
}

// One owner question per card, so an agent that re-asks the same thing
// (six "May I create the fixture?" items in one turn) pings once. It shows
// the newest item (a Conductor card: its first) and counts the rest. The
// card is answered in the app: until the supervisor can click it, "open
// thread" is the only answer and the choices are listed in the body. Keyed
// by the oldest open item's id: a reply closes it (and the items asked
// before it), so a later ask is a new question; a re-ask is not. A Codex
// card open past a day is asked once more (a new key), then its items are
// dropped (liveCardItems).
function cardIntent(ctx, card) {
  const { thread, now, limits } = ctx;
  const items = liveCardItems(card, now);
  if (!items.length) return { type: "none", reason: "question card: nothing left to ask" };
  const oldest = items[0];
  const item = card.app === "codex" ? items.at(-1) : items[0];
  const late = card.app === "codex" && now - Date.parse(oldest.at ?? "") >= CARD_STALE_MS;
  const head = clampText(item.header || item.question, 50);
  const choices = item.options.map((label, i) => `${i + 1}. ${label}`).join(" ");
  const extra = item.multiSelect ? " Pick any." : "";
  const others = items.filter((other) => other !== item).map((other) => clampText(other.header || other.question, 60));
  const also = others.length ? `Also open: ${others.join(" | ")}` : "";
  const body = [item.question, choices, item.freeText ? `Or your own answer.${extra}` : extra.trim(), also].filter(Boolean).join(" ");
  const key = `card:${thread.key}:${oldest.itemId}`;
  const count = items.length > 1 ? ` (${items.length} open)` : "";
  const question = {
    ...clampQuestion({ title: `${late ? "Still open: " : ""}${ctx.facts.label}: ${head}${count}`, body: stripTags(redactSecrets(body)), options: ["open thread"], dedupeKey: late ? `${key}:late` : key, kind: "agent-card" }, { ...limits, bodyMax: limits.cardBodyMax }),
    // The raw labels, for answering in the app later; never sent to an agent.
    meta: {
      app: card.app, cardId: String(card.cardId), itemId: String(item.itemId), itemIds: items.map((open) => String(open.itemId)),
      count: String(items.length), freeText: item.freeText ? "1" : "0", multiSelect: item.multiSelect ? "1" : "0", labels: [...item.options]
    },
    ...(late ? { baseKey: key } : {}),
    agentAskedAt: item.at ?? null
  };
  return { type: "ask", reason: "agent asks: question card", question, card: true };
}

// Asks to merge hold until the owner answers or the PR merges, whatever the
// agent says meanwhile ("Merges: need your explicit go." reads as a decision).
const MERGE_TOPICS = new Set(["admin", "merge"]);
const MERGE_WORDS = /\bmerg/i;
// Merge words that ask nothing about merging the PR: a merge conflict, a
// merge base or commit, merging main (or the base) into the branch.
const NOT_MERGE_ASK = new RegExp([
  String.raw`\bmerg\w*[\s-]+(?:conflicts?|base|commits?)\b`,
  String.raw`\bmerg\w*\s+(?:in\s+)?(?:the\s+)?(?:latest\s+)?(?:origin\/|upstream\/)?(?:main|master|develop|upstream|base(?:\s+branch)?)\b`,
  String.raw`\bmerg\w*\s+[^.?!\n]{0,40}?\binto\s+(?:this|the|my|our|your|its)?\s*(?:feature\s+|PR\s+)?branch\b`
].join("|"), "gi");

// An ask for the owner's go to merge the PR, not any mention of merging
// ("How should I resolve the merge conflict?" moves on once resolved).
export function asksToMergePr(text) {
  return MERGE_WORDS.test(String(text ?? "").replace(NOT_MERGE_ASK, " "));
}

// An agent's own ask, keyed on its thread and the agent message it came from
// (when it was written), never on its wording: a reread or a reworded judge
// question for the same ask stays one question. A structured ask brings its
// own id; with no time known, the ask's text stands in.
export function agentAskKey(threadKey, { id = null, at = null, text = "" } = {}) {
  const atMs = Date.parse(at ?? "");
  const which = id ?? (Number.isFinite(atMs) ? shortHash(`at:${new Date(atMs).toISOString()}`) : shortHash(String(text ?? "")));
  return `ask:${threadKey}:${which}`;
}

function agentAskIntent(ctx) {
  const { classified, thread } = ctx;
  const ask = classified.ask ?? {};
  if (ask.card) return cardIntent(ctx, ask.card);
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
  // A "Blocked on:" ask brings its own answers ("open thread" at least).
  const options = ask.structured || ask.blocked ? ask.options : ask.options?.length >= 2 ? ask.options.slice(0, 3) : ["yes", "no"];
  // A "Blocked on:" item that points at a list ("the two P1s above") shows it.
  const excerpt = ownerExcerpt(ask.context ? `${ask.text}: ${ask.context}` : ask.text || thread.lastAgentText, ctx.limits.bodyMax);
  // A sealed Codex ask brings its own key: its shown text is a stand-in.
  return {
    type: "ask", reason: `agent asks: ${ask.topic ?? "question"}`,
    question: {
      ...question(ctx, `${ctx.facts.label}: ${topicTitle}`, excerpt, options,
        agentAskKey(thread.key, { id: ask.key ?? null, at: thread.lastAgentAt, text: ask.text ?? "" }), "agent-ask"),
      mergeAsk: MERGE_TOPICS.has(ask.topic) || asksToMergePr(ask.text),
      // The body is only the ask sentence; the review needs what it is about.
      askContext: clampTail(redactSecrets(thread.lastAgentTail || thread.lastAgentText), ctx.limits.excerptMax),
      agentAskedAt: thread.lastAgentAt ?? null
    }
  };
}

function prIntent(ctx) {
  const { classified, thread } = ctx;
  const blockers = classified.blockers ?? [];
  if (blockers.length && blockers.every(passiveAmong(blockers))) {
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
  // Typing in the composer does not answer a card: it is asked whatever the owner does.
  if (intent.type === "ask" && intent.card) return { ...base, action: "ask-user", reason: intent.reason, question: intent.question, notBefore: null };
  // The owner typing into this thread outranks anything that touches it.
  const ownerUntil = ctx.ownerPush ? null : ownerActiveUntil(ctx.thread, ctx.limits, ctx.now);
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
  if (ctx.ownerPush) return pushedNudge(ctx, intent, decision, playbook);
  if (deliberateStop(thread)) return { ...decision, reason: "owner stopped this turn" };
  const drivenUntil = ownerDrivenUntil(ctx);
  if (drivenUntil) return { ...decision, action: "wait", reason: "owner is driving this thread", notBefore: drivenUntil };
  const cooldownMs = playbook.cooldownMin ? playbook.cooldownMin * MIN : limits.nudgeCooldownMs;
  const attempts = attemptsWithoutProgress(ledger, ctx.progressMark);
  const maxAttempts = playbook.maxAttempts ?? limits.maxNudgesWithoutProgress;
  const vars = { ...ctx.facts, attempts: String(attempts), ...(intent.vars ?? {}) };
  // A wait on the agent's answer (or on a reply to the same words) lasts
  // the playbook's whole budget at most; then the owner hears it once.
  const holdMs = Math.max(cooldownMs * maxAttempts, REPLY_HOLD_MIN_MS);
  const heldOut = (entry) => now - Date.parse(sentAtOf(entry) ?? "") >= holdMs;
  const reply = replyCheck(ctx, intent.playbook);
  // The owner's "keep going" after that nudge lifts the hold on its answer.
  const lifted = Date.parse(ledger?.keepGoingAt ?? "") > Date.parse(sentAtOf(reply.last ?? lastSent(ledger, intent.playbook)) ?? "");
  const hold = REPLY_AWARE.has(intent.playbook) && !lifted ? ownerHold(ctx, Boolean(reply.wait)) : null;
  if (hold) return ownerHoldDecision(ctx, decision, hold);
  if (reply.wait && !lifted) {
    if (attempts >= maxAttempts || heldOut(reply.last)) return stuckDecision(ctx, playbook, vars, attempts, decision, `answered the ${clock(sentAtOf(reply.last))} nudge; nothing new since`);
    return { ...decision, action: "wait", reason: reply.wait };
  }
  // The same PR, head and blockers as this playbook's last nudge, with no
  // reply since, is the same nudge whatever its words (dakar got nine
  // merge-ready nudges on one head): wait, then the owner hears it once.
  const prior = REPLY_AWARE.has(intent.playbook) && !lifted ? lastSent(ledger, intent.playbook) : null;
  if (prior && Array.isArray(prior.facts) && sameBlockerSet(prior.facts, reply.facts) && !repliedAfter(thread, prior)) {
    const why = `same PR, head and blockers as the ${clock(sentAtOf(prior))} nudge; no reply since`;
    if (heldOut(prior)) return stuckDecision(ctx, playbook, vars, attempts, decision, why);
    return { ...decision, action: "wait", reason: why };
  }
  if (!intent.immediate) {
    const idleUntil = addMs(latest(thread.lastAgentAt, thread.lastActivityAt), limits.idleBeforeNudgeMs);
    if (idleUntil && Date.parse(idleUntil) > now) return { ...decision, action: "wait", reason: "recently active", notBefore: idleUntil };
  }
  const cooledAt = addMs(ledger.lastNudgeAt, cooldownMs);
  if (cooledAt && Date.parse(cooledAt) > now) return { ...decision, action: "wait", reason: "cooldown", notBefore: cooledAt };
  const undelivered = undeliveredStreak(ledger, thread);
  if (undelivered) {
    // Asked once per failure streak: after the owner's answer it only retries.
    if (undeliveredAskDue(ctx, undelivered)) return undeliveredDecision(ctx, decision, undelivered);
    const retryAt = addMs(undelivered.lastAt, Math.min(UNDELIVERED_BACKOFF_MS * 2 ** (undelivered.count - 1), UNDELIVERED_BACKOFF_MAX_MS));
    if (retryAt && Date.parse(retryAt) > now) {
      return { ...decision, action: "wait", reason: `can't deliver (${undelivered.reason}); retry after backoff`, notBefore: retryAt };
    }
  }
  if (attempts >= maxAttempts) return stuckDecision(ctx, playbook, vars, attempts, decision);
  const route = chooseRoute(thread, ctx.mode, ctx.delivery);
  if (!route) {
    // No route only because computer use cannot type right now (a locked
    // screen, secure input), in either computer-use mode: the supervisor
    // tells the owner why once it has waited a while.
    const ui = deliveryOf(ctx.delivery);
    const uiBlocked = ui.mode !== "cli" && ui.ready === false && Boolean(uiTargetFor(thread));
    // computer-use-first too for a thread no CLI may reach (the Codex app's).
    const waitUi = uiWaitReason(thread, ctx.delivery) ?? (codexExecBarred(thread) ? uiBlockedReason(thread, ctx.delivery) : null);
    if (waitUi) return { ...decision, action: "wait", reason: `${waitUi}; ${decision.reason}`, uiBlocked };
    return { ...unreachableDecision(ctx, decision), uiBlocked };
  }
  const message = `${reply.prefix}${renderTemplate(playbook.body, vars)}`;
  const messageHash = shortHash(message);
  // The same words twice in a row, with no reply between, is noise.
  const repeat = REPEAT_GUARDED(intent.playbook) ? lastReached(ledger) : null;
  if (repeat?.messageHash === messageHash && !repliedAfter(thread, repeat)) {
    const why = `same message sent at ${clock(sentAtOf(repeat))}; no reply since`;
    if (heldOut(repeat)) return stuckDecision(ctx, playbook, vars, attempts, decision, why);
    return { ...decision, action: "wait", reason: why };
  }
  return { ...decision, action: "nudge", route, message, messageHash, factsKey: reply.factsKey, facts: reply.facts };
}

// The owner's Push now: the playbook's words go out now. The waits that only
// pace automatic nudges (the owner's own recent words or stop, a reply hold,
// idle, cooldown, a failing route's backoff, the attempt budget, a repeat)
// are the owner's to skip; an ask, a wait on CI or an outage still decides
// before this (resolveIntent), and a thread with no route stays unsent.
function pushedNudge(ctx, intent, decision, playbook) {
  const route = chooseRoute(ctx.thread, ctx.mode, ctx.delivery);
  if (!route) return { ...decision, reason: uiWaitReason(ctx.thread, ctx.delivery) ?? uiBlockedReason(ctx.thread, ctx.delivery) ?? "no delivery route" };
  const vars = { ...ctx.facts, attempts: String(attemptsWithoutProgress(ctx.ledger, ctx.progressMark)), ...(intent.vars ?? {}) };
  const reply = replyCheck(ctx, intent.playbook);
  const message = `${reply.prefix}${renderTemplate(playbook.body, vars)}`;
  return { ...decision, action: "nudge", route, message, messageHash: shortHash(message), factsKey: reply.factsKey, facts: reply.facts };
}

// Nudges that report on the PR. Resume, status checks and limit retries
// are never held back by an earlier answer.
const REPLY_AWARE = new Set(["merge-ready", "ci-finished"]);
const REPEAT_GUARDED = (playbook) => playbook !== "resume" && playbook !== "status-check";
const FACTS_KEPT = 8;
const REPLY_HOLD_MIN_MS = HOUR;

// The agent ended a real turn after the last nudge of this playbook. Same
// facts: its answer stands, so wait. New facts: lead with what changed.
function replyCheck(ctx, playbookId) {
  const none = { wait: null, prefix: "", factsKey: null, facts: null };
  if (!REPLY_AWARE.has(playbookId)) return none;
  const facts = nudgeFacts(ctx);
  const factsKey = shortHash(facts.join("\n"));
  const out = { ...none, factsKey, facts };
  const last = lastSent(ctx.ledger, playbookId);
  if (!last || !repliedAfter(ctx.thread, last)) return out;
  if (last.factsKey === factsKey) return { ...out, last, wait: `agent answered the ${clock(sentAtOf(last))} nudge; nothing new` };
  // A nudge from before facts were kept: nothing to compare, so no prefix.
  if (!Array.isArray(last.facts)) return out;
  const added = facts.filter((item) => !last.facts.includes(item));
  const cleared = last.facts.filter((item) => !facts.includes(item));
  const parts = [added.length ? `new: ${added.join(", ")}` : "", cleared.length ? `cleared: ${cleared.join(", ")}` : ""].filter(Boolean);
  return { ...out, prefix: `Since your ${clock(replyAt(ctx.thread))} reply: ${parts.join("; ") || "facts changed"}. ` };
}

// What the agent can act on: blockers it can clear, failing checks, the head.
function nudgeFacts(ctx) {
  const { classified, pr } = ctx;
  const blockers = (classified.blockers?.length ? classified.blockers : classified.readiness?.blockers) ?? [];
  const failing = (pr?.ci?.failing ?? []).map((name) => fact(name, 60)).filter(Boolean);
  const out = blockers.filter((blocker) => !passiveAmong(blockers)(blocker) && !(failing.length && /^CI red:/.test(blocker))).map((blocker) => fact(blocker, 80));
  for (const name of failing) out.push(`${name} failing`);
  // A rerun that fails again on the same head is news, even within a minute;
  // main's health check failing again on its own schedule is not.
  const failedAt = Date.parse(pr?.ci?.failedAt ?? "");
  const ownFailure = (pr?.ci?.failing ?? []).some((name) => !isMainHealthCheck(name));
  if (failing.length && ownFailure && Number.isFinite(failedAt)) out.push(`checks failed at ${new Date(failedAt).toISOString().slice(11, 19)}Z`);
  // The head always counts: a push is news however many checks fail.
  const head = shortSha(pr?.headOid);
  const kept = [...new Set(out)].sort().slice(0, head ? FACTS_KEPT - 1 : FACTS_KEPT);
  return head ? [...kept, `head ${head}`].sort() : kept;
}

// Two nudges' facts name the same head and blockers (a rerun's time aside).
const RERUN_FACT = /^checks failed at /;
function sameBlockerSet(a, b) {
  const set = (facts) => JSON.stringify((facts ?? []).filter((item) => !RERUN_FACT.test(item)).sort());
  return Array.isArray(b) && set(a) === set(b);
}

// A blocker shared with every PR: main's own health check red here. A
// required gate is named by its label, any other red check by "CI red:".
function sharedBlocker(blocker, pr) {
  const text = String(blocker ?? "");
  const gates = pr?.gates ?? [];
  const gate = gates.find((item) => text.startsWith(`${item.label || item.name} `));
  if (gate) return isMainHealthCheck(gate.name) || isMainHealthCheck(gate.label);
  if (!text.startsWith("CI red: ")) return false;
  const gateNames = new Set(gates.map((item) => item.name));
  const failing = (pr?.ci?.failing ?? []).filter((name) => !gateNames.has(name));
  return failing.length > 0 && failing.every(isMainHealthCheck);
}

// "Blocked on: your go", "--admin merge", "ready to merge": the owner's step.
const OWNER_GO = /\byour go\b|--admin\b|\badmin[- ]merg\w*|\bready to merge\b/i;

// A PR no nudge moves: every blocker the agent could clear is shared infra
// (main red), or the agent answered the last nudge and says it waits on the
// owner (their go, the merge, an admin merge). One owner question then,
// keyed on the PR, its head and that blocker set; no nudge until one changes.
function ownerHold(ctx, answered) {
  const { pr, thread, classified } = ctx;
  if (pr?.state !== "OPEN") return null;
  const blockers = (classified.blockers?.length ? classified.blockers : classified.readiness?.blockers) ?? [];
  const active = blockers.filter((blocker) => !passiveAmong(blockers)(blocker));
  const key = shortHash([pr.ref ?? "", pr.headOid ?? "", ...[...active].sort()].join("\n"));
  // Checks still running may add work of its own: wait for them first.
  const running = blockers.some(ciRunning) || Boolean(pr.ci?.pending?.length);
  if (active.length && active.every((blocker) => sharedBlocker(blocker, pr))) return { kind: running ? "wait" : "shared", blockers: active, key };
  if (!answered) return null;
  const section = blockedOnSection(thread.lastAgentFull || thread.lastAgentText || "");
  const onOwner = (section?.items ?? []).some((item) => item.tag === "owner" || OWNER_GO.test(item.text));
  return onOwner ? { kind: "owner", blockers: active, key } : null;
}

function ownerHoldDecision(ctx, decision, hold) {
  const { facts, thread } = ctx;
  const left = hold.blockers.map((blocker) => fact(blocker, 80)).join("; ");
  const says = blockedOnLine(thread);
  const agent = says ? ` Agent: blocked on ${says}.` : "";
  const dedupeKey = `held:${thread.key}:${hold.key}`;
  if (hold.kind === "wait") return { ...decision, action: "wait", reason: `only shared blockers left (${left}); checks still running` };
  if (hold.kind === "shared") {
    return {
      ...decision, action: "ask-user", reason: `only shared blockers left: ${left}`,
      question: question(ctx, `${facts.label}: main CI red blocks it. Help?`,
        `${facts.prRef} at ${facts.head}: only ${left} left. Main's own health is red for every PR; nudging the agent can't clear it.${agent}`,
        ["on it", "later"], dedupeKey, "ready")
    };
  }
  return {
    ...decision, action: "ask-user", reason: `agent answered; waits on the owner${says ? `: ${says}` : ""}`,
    question: {
      ...question(ctx, `${facts.label}: waits on your go. OK?`, `${facts.prRef} at ${facts.head}: the agent answered and waits on you.${agent} Left: ${left || "nothing"}.`,
        ["go ahead", "wait"], dedupeKey, "agent-ask"),
      askContext: clampTail(redactSecrets(thread.lastAgentTail || thread.lastAgentText), ctx.limits.excerptMax),
      agentAskedAt: thread.lastAgentAt ?? null
    }
  };
}

function lastSent(ledger, playbookId) {
  return (ledger?.nudges ?? []).filter((entry) => entry?.playbook === playbookId && entry.status === "sent").at(-1) ?? null;
}

// The newest nudge or owner answer that reached the thread.
function lastReached(ledger) {
  return (ledger?.nudges ?? []).filter((entry) => entry?.status === "sent" || entry?.status === "owner-answer").at(-1) ?? null;
}

// When the send started: the ledger's own time is written after delivery,
// which can be after a reply that came at once.
function sentAtOf(entry) {
  return entry?.sentAt ?? entry?.at ?? null;
}

// The agent's last real message (never a synthetic limit notice or an error).
function replyAt(thread) {
  return thread.lastAgentFullAt !== undefined ? thread.lastAgentFullAt : thread.lastAgentAt;
}

function repliedAfter(thread, entry) {
  if (thread.agentStatus === "running") return false;
  const reply = Date.parse(replyAt(thread) ?? "");
  const sent = Date.parse(sentAtOf(entry) ?? "");
  return Number.isFinite(reply) && Number.isFinite(sent) && reply > sent;
}

// The judge's message, same words as the last one that reached the thread
// with no reply since: the entry it repeats, else null.
export function repeatsLastSend(thread, ledger, messageHash) {
  const repeat = lastReached(ledger);
  if (!repeat || repeat.messageHash !== messageHash || repliedAfter(thread, repeat)) return null;
  return { ...repeat, clock: clock(sentAtOf(repeat)) };
}

// "18:17", local time.
function clock(iso) {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return "?";
  return new Date(at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

// held: why the supervisor stopped waiting on the agent ("answered the
// 03:20 nudge; nothing new since"), when that, not the attempts, ended it.
// The agent's own "Blocked on:" items are quoted, so the owner sees what it
// says it waits on.
function stuckDecision(ctx, playbook, vars, attempts, decision, held = null) {
  if (!playbook.ask) return { ...decision, reason: `${held ?? `stopped after ${attempts} nudges`}; owner not pinged by policy` };
  const left = ctx.facts.blockers || ctx.classified.reason;
  const says = blockedOnLine(ctx.thread);
  const what = held ? `agent ${held}` : `${attempts} nudges, no new head, no thread resolved`;
  return {
    ...decision, action: "ask-user", reason: held ? `agent ${held}` : `${attempts} nudges without progress`,
    question: question(ctx, renderTemplate(playbook.ask, vars),
      `${ctx.facts.label}: ${what}.${says ? ` Agent: blocked on ${says}.` : ""} Left: ${left}.`, ["keep going", "stop"],
      `stuck:${ctx.thread.key}:${playbook.id}:${ctx.progressMark.head ?? "none"}`, "stuck")
  };
}

// The agent's "Blocked on:" items, for the owner (redacted, tag-free, short).
function blockedOnLine(thread) {
  const section = blockedOnSection(thread.lastAgentFull || thread.lastAgentText || "");
  const items = (section?.items ?? []).map((item) => item.text.replace(/[.;,\s]+$/, "")).filter(Boolean);
  return items.length ? ownerExcerpt(items.join("; "), 120) : "";
}

// Sends that keep failing back off (5, 10, 20, 40, then 60 min), and after
// three over half an hour the owner hears about it once, with the reason.
// Work in the thread since the last failure (the owner nudged it) clears it.
const UNDELIVERED_BACKOFF_MS = 5 * MIN;
const UNDELIVERED_BACKOFF_MAX_MS = 60 * MIN;
const UNDELIVERED_ASK_COUNT = 3;
const UNDELIVERED_ASK_MS = 30 * MIN;
// A Codex app that cannot show which thread is open fails the same way on
// every retry, and the Codex app's writer lock leaves no other route: the
// owner hears it on the second failure.
const CODEX_IDENTITY_BLOCK = /^(?:could not verify thread|ambiguous: two threads share this title)/;
const IDENTITY_ASK_COUNT = 2;
function undeliveredAskDue(ctx, streak) {
  if (streak.ackedAt) return false;
  if (ctx.thread.kind === "codex" && CODEX_IDENTITY_BLOCK.test(String(streak.reason ?? ""))) return streak.count >= IDENTITY_ASK_COUNT;
  return streak.count >= UNDELIVERED_ASK_COUNT && ctx.now - Date.parse(streak.since) >= UNDELIVERED_ASK_MS;
}

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
  if (/codex exec cannot reach it/.test(text)) return " Codex has it open under a title the supervisor cannot match: send it there yourself.";
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

// The owner wrote in a thread after the supervisor had nudged it, and not
// just "continue": they took it over, often for something other than its PR.
// Their conversation outranks the supervisor's agenda for a while. A fresh
// task the owner starts (no nudge before it) is still followed through.
// Every thread nudge waits it out: a resume, the laptop-verify guard and "CI
// done" too (the audit found five sends inside the hold, the closest 15 min
// after the owner's word). Only the owner's own "continue" lifts it.
const CARRY_ON = /^(continue|keep going|go( on| ahead)?|yes|yep|ok(ay)?|proceed|do it|finish( it| up)?|merge( it)?|ship it|get (it|this) (merged|done|across the finish line))\b[\s.!]*$/i;
function ownerDrivenUntil(ctx) {
  const { thread, limits, now, ledger } = ctx;
  const text = String(thread.lastUserText ?? "").trim();
  if (text.startsWith(SUPERVISOR_PREFIX) || CARRY_ON.test(text)) return null;
  const at = Date.parse(thread.lastUserAt ?? "");
  if (!Number.isFinite(at)) return null;
  if (!(lastNudgeStart(ledger) < at)) return null;
  const until = at + limits.ownerDrivenMs;
  return until > now ? new Date(until).toISOString() : null;
}

// When the last nudge (or owner answer) set out, not when its delivery
// returned: an owner reply can land in between.
const NUDGE_STATUSES = new Set(["sent", "failed", "owner-answer"]);
function lastNudgeStart(ledger) {
  const last = [...(ledger?.nudges ?? [])].reverse().find((entry) => NUDGE_STATUSES.has(entry?.status));
  return Date.parse(sentAtOf(last) ?? ledger?.lastNudgeAt ?? "");
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
// Transient kinds, taken together, need several hits or more than one thread
// inside the fresh window, unless the LB's own probe already says it is
// unhealthy. While the LB's watcher vouches for it (a fresh line that reads
// healthy with no failed requests) they never alarm: the 00:30Z "3x
// connection" alarm's own watch line read "healthy=yes ... problems: none".
// no-accounts and auth are never noise.
function transientCorroborated(entries, probe, vouched, limits) {
  if (vouched) return false;
  if (probe === false) return true;
  // An entry without fresh counts (an older reader) counts its hour.
  const count = entries.reduce((sum, entry) => sum + Number(entry.freshCount ?? entry.count), 0);
  const threads = new Set(entries.flatMap((entry) => entry.freshThreadIds ?? entry.threadIds ?? []));
  return count >= (limits.lbTransientErrorMin ?? LB_TRANSIENT_MIN) || threads.size >= 2;
}

// The LB watcher's last line ("<iso> healthy=yes 280 req ..., problems:
// none"), written in the last LB_WATCH_FRESH_MS, says the LB was fine when
// it was written: that time, or null.
function watchHealthyAt(lb, now, limits) {
  const match = /^(\S+)\s+healthy=(yes|no)\b.*?\bproblems:\s*(.*)$/.exec(String(lb?.watchLine ?? "").trim());
  const at = Date.parse(match?.[1] ?? "");
  if (!match || !Number.isFinite(at) || Math.abs(now - at) > (limits.lbWatchFreshMs ?? LB_WATCH_FRESH_MS)) return null;
  return match[2] === "yes" && /^none\b/i.test(match[3].trim()) ? at : null;
}

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
  if (slow.full.length) bb3Problems.push(`${slow.full.length} full verify >${minutes(fullRunSlow(limits))}m`);
  if (slow.quick.length) bb3Problems.push(`${slow.quick.length} bb-quick >${minutes(limits.quickVerifyEscalateMs)}m`);
  if (bb3?.timersDead?.length) bb3Problems.push(`timers dead: ${bb3.timersDead.map((name) => fact(name, 40)).join(", ")}`);

  // The supervisor's own /health probe timing out while the watcher vouches
  // for the LB is the probe's problem, not the LB's (five "LB unhealthy
  // (timed out after 5000 ms)" alarms beside "healthy=yes ... problems:
  // none"): unknown, never an outage.
  // The log window is an hour; only recent rows say the LB is down now.
  const freshMs = limits.lbErrorFreshMs ?? LB_ERROR_FRESH_MS;
  const freshErrors = (lb?.recentErrors ?? []).filter((entry) => LB_ALARM_KINDS.has(entry.kind) && Number(entry.count) > 0
    && isFresh(entry.lastAt, freshMs, now));
  const transient = freshErrors.filter((entry) => LB_TRANSIENT_KINDS.has(entry.kind));
  // The line vouches only for what came before it: corroborated errors
  // since it was written (or with no time) are news it cannot answer, and
  // then a probe timing out counts too.
  const watchAt = watchHealthyAt(lb, now, limits);
  const sinceWatch = transient.filter((entry) => !(Date.parse(entry.lastAt ?? "") <= watchAt));
  const vouched = watchAt !== null && !transientCorroborated(sinceWatch, null, false, limits);
  const probe = lb?.healthy === false && vouched && /^timed out\b/.test(String(lb?.detail ?? "")) ? null : (lb?.healthy ?? null);
  const keepTransient = transientCorroborated(transient, probe, vouched, limits);
  const lbErrors = freshErrors.filter((entry) => keepTransient || !LB_TRANSIENT_KINDS.has(entry.kind));
  const lbProblems = [];
  if (probe === false) lbProblems.push(`LB unhealthy${lb.detail ? ` (${fact(lb.detail, 80)})` : ""}`);
  for (const entry of lbErrors) lbProblems.push(`${Number(entry.count)}x ${entry.kind}`);

  return {
    bb3: {
      down: bb3?.reachable === false || bb3?.gate?.state === "blocked",
      up: bb3?.reachable === true && bb3?.gate?.state !== "blocked",
      problems: bb3Problems,
      slow
    },
    lb: {
      down: probe === false || lbErrors.some((entry) => entry.kind !== "auth"),
      up: probe === true && lbErrors.length === 0 && lb?.errorsUnknown !== true,
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
    decisions.push(escalateInfra(kind, state.problems, { infra, ledger, playbooks, limits, now, manager, mode, threads, delivery, config }));
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

function escalateInfra(kind, problems, { infra, ledger, playbooks, limits, now, manager, mode, threads, delivery = null, config = null }) {
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
  const vars = kind === "bb3" ? { ...bb3Vars(infra?.bb3, problems, limits), waiting: waitingLines(threads, limits, infra?.bb3, config) } : lbVars(infra?.lb, problems);
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
function waitingLines(threads, limits, bb3, config = null) {
  const lines = [];
  for (const item of threads ?? []) {
    const slow = item?.thread && escalatedWait(item.classified, item.pr ?? null, limits, bb3, item.thread, config);
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

const fullRunSlow = (limits) => limits.fullRunSlowMs ?? 75 * MIN;
// Queued runs are waiting their turn, not slow.
const slowFullRun = (run, limits) => run?.kind === "full" && !run.queued && Number(run.ageSec) * 1000 >= fullRunSlow(limits);

function slowRuns(bb3, limits) {
  const runs = Array.isArray(bb3?.runs) ? bb3.runs : [];
  const ageMs = (run) => Number(run?.ageSec) * 1000;
  const oldestFirst = (a, b) => ageMs(b) - ageMs(a);
  return {
    full: runs.filter((run) => slowFullRun(run, limits)).sort(oldestFirst),
    quick: runs.filter((run) => run?.kind === "quick" && ageMs(run) >= limits.quickVerifyEscalateMs).sort(oldestFirst)
  };
}

// How long a thread's full verify has waited, once that is long enough to
// escalate, else null. Its BuildBot3 run, found by PR, is judged as slowRuns
// judges it (an admitted one outranks a queued retry); with no run found, the
// background task's age against fullVerifyEscalateMs stands. One still queued
// past fullRunSlowMs means the slots are not turning over.
function slowFullWait(age, pr, bb3, limits) {
  if (age < limits.fullVerifyEscalateMs) return null;
  const number = Number(pr?.number);
  const runs = number && Array.isArray(bb3?.runs) ? bb3.runs.filter((run) => run?.kind === "full" && Number(run.pr) === number) : [];
  const run = runs.find((item) => !item.queued) ?? runs[0];
  if (!run) return age;
  if (run.queued) return age >= fullRunSlow(limits) ? age : null;
  return slowFullRun(run, limits) ? Number(run.ageSec) * 1000 : null;
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
  const out = [];
  for (const decision of decisions ?? []) {
    if (decision?.action === "escalate-manager") {
      const key = `${decision.targetKey ?? ""}\u0000${decision.playbook ?? ""}`;
      if (!escalated.has(key)) out.push(decision);
      // A dropped duplicate escalation still asks its card.
      else if (decision.cardQuestion) out.push({ ...decision, action: "none", message: null, route: null });
      escalated.add(key);
    } else if (decision?.action !== "nudge" || !sent.has(decision.threadKey)) {
      if (decision?.action === "nudge") sent.add(decision.threadKey);
      out.push(decision);
    } else if (decision.cardQuestion) {
      // A dropped duplicate nudge still asks its card.
      out.push({ ...decision, action: "none", message: null, route: null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Facts and text helpers

function factsFor(thread, pr, classified, config = null) {
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
    mergeGate: gateFact(pr, pr?.repo ?? thread.repo, config),
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
// BuildBot3 full run for BuildBetter), else hosted CI. Without a PR read,
// the repo's configured checks stand in.
function gateFact(pr, repo = null, config = null) {
  const gates = (pr?.gates ?? (repo ? requiredChecksFor(repo, config) : [])).filter((gate) => gate?.label || gate?.name);
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
  return place || `${kindName(thread.kind)} chat`;
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
