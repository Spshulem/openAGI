// Fleet supervisor tick: read every source, classify each coding thread,
// decide with policy + playbooks, then act according to the mode.
//   observe  record what it would do ("planned"), send nothing
//   propose  record "proposed" actions the owner can send with one tap
//   auto     deliver templated nudges/escalations, within the limits
// Needs-you questions are raised in every mode. The constructor has no side
// effects; hosted-interface calls start() on listen and stop() on close.

import path from "node:path";
import { readThreadConversation, unavailableConversation } from "./conversation.js";
import os from "node:os";
import { SelfFixHub } from "./remote.js";
import { resolveDataDir } from "../data-dir.js";
import { readNodeConfig } from "../cli-client.js";
import { readOrCreateIdentity } from "../node-registry.js";
import { appendSharedThreadMessages } from "../shared-conversations.js";
import { isSelfThread, CARD_EXCLUSIONS, DEFAULTS, MODES, SUPERVISOR_PREFIX, THREAD_KINDS, UI_APPS, clampTail, clampTailLines, clampText, linkUiHosts, openChatFor, parsePaseoThreadKey, parsePrRef, redactSecrets, resolveFleetConfig, runCommand, shortHash, uiTargetFor } from "./contracts.js";
import { WATCH_GROUPS, classifyThread, liveWatch, mergeThreads, prReadiness, threadHealth, watchOf } from "./classify.js";
import { diagnoseAgentBlocker, estimateExpectedCheckIn } from "./watchdog.js";
import { createExecutor, isPresenceBlock } from "./executor.js";
import { JUDGED_PLAYBOOKS, agentReply, createNudgeJudge } from "./judge.js";
import { createNotifier } from "./notify.js";
import { BUNDLED_PLAYBOOKS_DIR, loadOwnerNotes, loadPlaybooks, renderTemplate, userPlaybooksDir } from "./playbooks.js";
import { agentAskKey, asksToMergePr, chooseRoute, decideInfra, decideThread, dedupeDecisions, infraHealth, ownerLabel, repeatsLastSend } from "./policy.js";
import { createReviewRunner, reviewContext, reviewFingerprint, reviewQuestions } from "./review.js";
import { StorageManager } from "./storage.js";
import { FleetStore } from "./store.js";
import { SuggestionManager, createDiagnoseModels, diagnoseDue, runDiagnosis } from "./suggestions.js";
import { localDay } from "./diagnose.js";
import { buildOwnerDecision, buildSupervisorDeck, computeBlockingImpact, deriveActorLabel, deriveBoardLabels, deriveCardProject, deriveSubchannel, needsOwnerDecision } from "./cards.js";
import { executeSafePrMerge } from "./intent-resolver.js";
import { applyPreferencePatch, classifyQuestionSlice, isSuppressedByQuietCadence, pickAffirmativeOption, recordAutonomousSliceAction, recordPreferenceSignal } from "./preferences.js";
import { batchActCards, inspectRepoStatus, listWorkspaces, readChatTranscript, startPaseoSession } from "./coordinator.js";
import { DEFAULT_DECISIONS_MODEL, DEFAULT_DECISIONS_TIMEOUT_MS, DEFAULT_DECISIONS_URL, createDecisionsKeepAliveGate, evaluateQuestionsRelevanceWithDecisions } from "./decisions-gate.js";
import { buildFleetHierarchy, dispatchManagerGoal, syncThemesToPaseoLabels } from "./themes.js";
import { buildBugDispatchMessage, collectArchiveThreads, mergeThreadsWithArchives, routeCustomerIssue, searchFleet } from "./search.js";
import { DEADLINE_MARGIN_MS, UI_INPUT_LATCH, createAppController, createUiDriver, identityToken, restartMaxMs, uiIdentity } from "./ui-delivery.js";
import { archivePaseoAgent, createPaseoSource, dedupeConsecutiveMessages, hostApi, paseoThread, stripAgentInternalMarkup, unarchivePaseoAgent, withPaseo } from "./sources/paseo.js";
import { failoverPaseoSessionProvider } from "./paseo-delivery.js";
import { applyPaseoSessionSettings, parsePaseoSettingsTarget, readPaseoSessionSettings } from "./paseo-settings.js";
import { OwnerPrecedentStore } from "./precedent-memory.js";
import * as antigravity from "./sources/antigravity.js";
import * as buildbot3 from "./sources/buildbot3.js";
import * as claude from "./sources/claude.js";
import * as codex from "./sources/codex.js";
import * as conductor from "./sources/conductor.js";
import * as github from "./sources/github.js";
import * as processes from "./sources/processes.js";
import { ActiveWorkManager } from "./active-work.js";

const MIN = 60_000;
const SOURCE_TIMEOUT_MS = 90_000;
const GIT_CONCURRENCY = 8;
const MAX_BRANCH_LOOKUPS = 8;
const MAX_NEW_BRANCH_LOOKUPS = 48;
const BRANCH_LOOKUP_CONCURRENCY = 6;
const BRANCH_LOOKUP_TTL_MS = 30 * MIN;
const START_DELAY_MS = 5_000;
// The idle watcher: a scan starts once the owner has been away long enough
// that its sends begin about when typing is allowed, at most once a minute,
// and never earlier than this much idle.
const IDLE_KICK_GAP_MS = 60_000;
const IDLE_KICK_MIN_MS = 30_000;
// Until one has run, an idle-watcher scan is taken to reach its sends this fast.
const IDLE_LEAD_MS = 45_000;
const MUTE_MS = 24 * 60 * MIN;
// Watch groups whose start the scan can read (an ask, a wait, a turn).
const TIMED_WATCH = new Set(["you", "waiting", "working"]);
const SENDING = new Set(["nudge", "escalate-manager"]);
const OPEN_ACTION = new Set(["planned", "proposed"]);
const TRUNK_BRANCHES = new Set(["main", "master", "HEAD", "develop", "staging"]);
const INFRA_KINDS = ["bb3", "lb"];
const BLOCKED_STATES = new Set(["infra-blocked", "waiting-ci"]);
const SETTLED_PR_STATES = new Set(["MERGED", "CLOSED"]);
// A thread naming several PRs is read for this many of its newest, and the
// newest open one is its PR (a merged one never reopens, so it is kept).
const MAX_PR_CANDIDATES = 4;
const MAX_MERGED_KEPT = 2_000;
// The PR state read right before a send, at most.
const PRE_SEND_PR_MS = 10_000;
// Nudges about the thread's PR itself: one whose PR merged or closed is moot.
const PR_PLAYBOOKS = new Set(["merge-ready", "ci-finished"]);
// A stopped or blocked turn's resume goes out whatever its PR says (classify:
// post-merge work may remain), so a settled PR never cancels one, even when
// the judge's words name it ("PR: repo#7489 MERGED" is in its prompt).
const POST_MERGE_PLAYBOOKS = new Set(["resume", "infra-recovered"]);
// Nudges that are about the machine, not the PR: a PR number in their words
// (the judge's "Stop local verification for #123") never makes them stale.
const NOT_ABOUT_PR_PLAYBOOKS = new Set(["no-local-verify"]);
// How long a remembered outage thread hidden by a failed source waits for it.
const RECOVERY_HOLD_MS = 60 * MIN;
// A manager escalation shares one cooldown per incident, whichever thread
// or infra check raised it (same keys decideInfra uses).
const INCIDENT_KEYS = Object.freeze({ "manager-bb3": "infra:bb3", "manager-lb": "infra:lb" });
// A delivered or failed escalation starts the cooldown; a failed route must
// not be retried every tick (same rule as the nudge ledger).
const ESCALATION_STATUSES = new Set(["sent", "failed"]);
// The snapshot row shows the decision that acts when a thread got two.
const DECISION_RANK = Object.freeze({ nudge: 3, "escalate-manager": 3, "ask-user": 2, wait: 1, none: 0 });
// A changed or due question waits this long after the last review (new ones
// never wait); a failed review is not retried sooner than REVIEW_RETRY_MS.
const REVIEW_MIN_GAP_MS = 10 * MIN;
const REVIEW_RETRY_MS = 15 * MIN;
// An unchanged question kept again and again is re-checked at 1x, 2x, then
// at most 4x the review interval.
const REVIEW_BACKOFF_MAX = 2;
// The nudge judge (judge.js): at most this many model calls per tick, this
// many at once. A verdict holds while the chat, playbook and facts are the
// same. A tick whose every call failed pauses the judge a while.
const JUDGE_MAX_PER_TICK = 6;
const JUDGE_CONCURRENCY = 3;
const JUDGE_CACHE_MS = 2 * 60 * MIN;
// Idle dependencies can finish without a new chat message. Reassess them
// periodically instead of treating an old worker report as current for hours.
const IDLE_JUDGE_CACHE_MS = 10 * MIN;
const JUDGE_DOWN_MS = 5 * MIN;
const JUDGE_CALL_MS = 45_000;
// All judge calls in one scan end by then (a call reads in ~10-20 s): each
// call gets only the time left, none starts with less than JUDGE_MIN_CALL_MS
// left, and the rest wait for the next scan, so owner answers and sends are
// not held.
const JUDGE_TICK_MS = 60_000;
const JUDGE_MIN_CALL_MS = 10_000;

function withTimeout(promise, ms, name) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} timed out after ${Math.round(ms / 1000)}s`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      try { results[index] = await fn(items[index], index); } catch { results[index] = null; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// A Conductor chat's own PRs: the ones it created (meta.prCreated, newest
// first), then any a Claude transcript linked (pr-link rows, also created
// there). Only these and the workspace branch's PR are ever its PR: a PR it
// only named, viewed or checked (a stack base, one it reviewed, another
// agent's) never is, nor stands alone as one.
function resolveCreatedPrs(threads) {
  for (const thread of threads) {
    if (thread.kind !== "conductor") continue;
    const created = Array.isArray(thread.meta?.prCreated) ? thread.meta.prCreated.filter((ref) => parsePrRef(ref)) : [];
    thread.createdPrRefs = [...new Set([...created, ...(thread.prRefs ?? [])])];
    thread.prRefs = [...thread.createdPrRefs];
  }
}

// The workspace branch's PR leads a chat's created PRs as a candidate.
function withBranchRef(thread, ref) {
  thread.branchPrRef = ref;
  thread.prRefs = [ref, ...(thread.prRefs ?? []).filter((other) => other !== ref)];
}

// A Conductor chat's PR among its candidates (state: ref -> "OPEN",
// "MERGED", ..., null for no PR, undefined unread): the workspace branch's
// PR while it is open; else the newest open PR the chat created; else the
// newest it created, then the branch PR. An older open PR never beats the
// branch's open one, and a PR the chat did not create is never a candidate.
function pickConductorPr(thread, state) {
  const branch = thread.branchPrRef ?? null;
  const created = thread.createdPrRefs.slice(0, MAX_PR_CANDIDATES);
  const real = (ref) => state(ref) !== null;
  const pick = branch && state(branch) === "OPEN" ? branch
    : created.find((ref) => state(ref) === "OPEN") ?? created.find(real) ?? (branch && real(branch) ? branch : null);
  const rest = [...new Set([...(branch ? [branch] : []), ...thread.createdPrRefs])].filter((ref) => ref !== pick && real(ref));
  thread.prRefs = pick ? [pick, ...rest] : rest;
  // None of them is a PR, and the branch has none: the chat has no PR.
  if (!thread.prRefs.length && thread.branchNoPr) thread.prLookedUp = true;
}

// GitHub unread this scan: the chat keeps the PR the last scan picked, else
// the newest it created, never its branch PR just because it leads (that one
// may have merged long before the chat created a newer one).
function keepConductorPr(thread, previous) {
  const own = [...new Set([...(thread.branchPrRef ? [thread.branchPrRef] : []), ...thread.createdPrRefs])];
  const pick = own.includes(previous) ? previous : (thread.createdPrRefs[0] ?? null);
  if (pick) thread.prRefs = [pick, ...(thread.prRefs ?? []).filter((ref) => ref !== pick)];
}

function emptyBb3() {
  return { reachable: null, checkedAt: null, gate: { state: null, reason: null, since: null }, fullQueue: null, quickQueue: null, load: null, runs: [], timersDead: [], error: null };
}

// Limit and unreachable questions come in bursts (one account cap hits every
// thread at once), so they collapse into one line each. Identical titles
// (the same BuildBot3 problem seen by a thread and by infra) collapse too.
const GROUPED_KINDS = Object.freeze({
  limit: { dedupeKey: "limit:group", options: ["wait", "added"], match: ["wait", "added"], title: (n, reset) => `${n} thread${n === 1 ? "" : "s"} capped. Reset ${reset}. Add acct?`, body: (labels) => `Waiting on reset: ${labels}.` },
  open: { dedupeKey: "open:group", options: ["opened", "skip"], title: (n) => `${n} stuck, can't reach. Open ${n === 1 ? "it" : "them"}?`, body: (labels) => `No live session to message: ${labels}.` },
  // Always one question, even for one thread, so the owner's answer holds
  // while the set of failing threads changes under it.
  deliver: { dedupeKey: "deliver:group", options: ["done", "skip"], match: ["done", "skip"], minSize: 1, title: (n) => `${n} stopped. Nudges can't get through. Nudge ${n === 1 ? "it" : "them"}?`, body: (labels) => `Sends keep failing: ${labels}.` }
});
// A question card item is the agent's own words, read from the card itself:
// the review never closes or rewrites one either.
export const SELF_FINDING_KINDS = new Set(["self-fix", "suggestion", "open", "deliver", "stuck", "paused", "storage", "agent-card", "completed", "session-error"]);
function bypassesBackgroundReview(question) {
  return SELF_FINDING_KINDS.has(question?.kind) || question?.meta?.hasPlanArtifact === "true";
}
// The owner's Scan now reviews at most this many batches (15 questions each).
const FORCED_REVIEW_ROUNDS = 4;
const GROUP_MAX = 50;
// Computer use unable to type this long, with nudges waiting on it: the owner
// hears why once (secure input held by an app, a locked screen), and the
// question closes itself when typing works again.
const PAUSED_ASK_MS = 30 * 60_000;

function pausedDeliveryDecision(delivery, blockedSince, now) {
  const waiting = blockedSince.size;
  const since = waiting ? Math.min(...blockedSince.values()) : null;
  if (!since || now - since < PAUSED_ASK_MS) return null;
  const minutes = Math.round((now - since) / 60_000);
  return {
    threadKey: "infra:computer-use", state: "infra", action: "ask-user", playbook: null, message: null, blockers: [],
    reason: `nudges paused: ${delivery.detail ?? "computer use not ready"}`, route: null, notBefore: null, targetKey: null, progressMark: null,
    question: {
      dedupeKey: "infra:computer-use", kind: "paused", threadKey: null,
      title: "Nudges paused: can't type into apps. Fix it?",
      body: `${delivery.detail ?? "Computer use is not ready"}. ${waiting} threads wait on a nudge, for ${minutes}m.`,
      options: ["fixed", "skip"]
    }
  };
}
// An automatic nudge the judge reads first. A resume after a limit reset or
// an error retry stays mechanical.
function judgeable(decision, thread) {
  if (decision?.action !== "nudge" || !decision.message || (!decision.route && !decision.requiresJudge) || !JUDGED_PLAYBOOKS.has(decision.playbook)) return false;
  if (decision.playbook !== "resume") return true;
  return decision.state !== "infra-blocked" && !thread?.error && thread?.agentStatus !== "error";
}

// Elapsed times ("waiting 34m", "full verify 12m") change every scan by
// themselves; masked, so only a change in the facts reads the chat again
// (the cache still expires after JUDGE_CACHE_MS).
function withoutElapsed(text) {
  return String(text ?? "").replace(/\b((?:waiting|waited|no word in|queued|elapsed|idle|silent|full verify|quick verify)\s+(?:for\s+)?)\d+(?:\.\d+)?\s?(?:ms|s|m|h|d|min|mins|minutes?|hours?|days?)\b/gi, "$1#");
}

// Every fact the judge's prompt shows besides the chat (judge.js prLines and
// buildJudgePrompt): the PR, the supervisor's state, reason and blockers,
// and the planned nudge's reason and words.
function judgeFacts(pr, classified, decision = null) {
  const gates = (pr?.gates ?? []).map((gate) => [gate.label || gate.name, gate.state ?? null]);
  const blockers = (classified?.blockers?.length ? classified.blockers : classified?.readiness?.blockers) ?? [];
  return JSON.stringify([
    pr?.ref ?? null, pr?.headOid ?? null, pr?.state ?? null, Boolean(pr?.isDraft), pr?.ci?.state ?? null, pr?.ci?.failing ?? [], pr?.ci?.pending ?? [],
    gates, pr?.unresolvedThreads ?? null, pr?.reviewDecision ?? null, classified?.state ?? null, withoutElapsed(classified?.reason),
    blockers.map(withoutElapsed), withoutElapsed(decision?.reason), withoutElapsed(decision?.message)
  ]);
}

// Same chat (the agent's last real message and when), same playbook, same
// facts, same earlier nudges: same verdict. Every judged playbook keys on the
// PR facts too, so a CI run that went red is read again. nudges: the earlier
// nudges the prompt shows (nudgeHistory), so a nudge sent since is read again.
export function judgeCacheKey(thread, decision, pr = null, classified = null, nudges = []) {
  const shown = (nudges ?? []).map((nudge) => [nudge.at ?? null, nudge.playbook ?? null, nudge.message ?? null]);
  return [thread.key, replyMark(thread), shortHash(JSON.stringify([thread.lastUserAt, thread.lastUserText, thread.lastActivityAt, thread.meta?.conversation])), decision.playbook, decision.factsKey ?? "", shortHash(judgeFacts(pr, classified, decision)), shortHash(JSON.stringify(shown))].join("|");
}

// Which agent message a verdict was read from.
function replyMark(thread) {
  const reply = agentReply(thread);
  return shortHash(`${reply.at ?? ""}\n${reply.text}`);
}

// The reply and the substantive ask identify a decision. Cosmetic titles
// may change on a reread; body/options change what the owner is approving.
export function judgeAskKey(thread, question = null) {
  const reply = agentReply(thread);
  const normalize = (value) => String(value ?? "").trim().replace(/\s+/g, " ");
  const ask = [normalize(question?.body), (question?.options ?? []).map(normalize).sort()];
  return `${agentAskKey(thread.key, { at: reply.at, text: reply.text })}:${shortHash(JSON.stringify(ask))}`;
}

// A judge question that asks to merge holds like the policy's merge asks.
function asksToMerge(question) {
  return asksToMergePr([question?.title, question?.body, ...(question?.options ?? [])].join(" "));
}

// Asks that stand until settled, not while the thread's state reads a
// certain way: a waiting-ci <-> needs-human flicker leaves them open. A
// policy hold ("main CI red blocks it", "waits on your go": held:) is not
// one: it closes once a scan decides its thread without asking it.
const STANDING_KINDS = new Set(["agent-ask", "ready"]);
const standing = (question) => STANDING_KINDS.has(question.kind) && !String(question.dedupeKey ?? "").startsWith("held:");

// What makes an open PR asked as ready no longer ready, read from the PR
// alone, or null. Only what the PR itself says for certain: CI running again,
// an unread gate or unknown mergeability is no news. A required gate whose
// latest run was cancelled or timed out is red, like a failed one.
const NOT_READY = /^(?:CI red: |\d+ open threads$|changes requested$|merge conflicts$|branch behind base$|draft$)|\S (?:failed|cancelled|timed_out)$/;
function notReadyBlocker(pr) {
  if (pr?.state !== "OPEN") return null;
  return prReadiness(pr, null).blockers.find((blocker) => NOT_READY.test(blocker)) ?? null;
}

// Why an open standing ask no longer needs the owner, or null. The owner's
// answer closes it elsewhere. A ready PR settles when it merges, closes,
// moves past the asked head or stops being ready on it (notReady). An
// agent's ask also settles when its thread is gone or muted, or (unless it
// asks to merge) when the agent spoke since and no longer asks: it withdrew
// or answered it itself.
// prMissing: GitHub answered and has no such PR. notReady: a blocker this
// scan read on the PR (notReadyBlocker).
export function settledAsk(question, { thread = null, pr = null, prMissing = false, threadGone = false, muted = false, notReady = null } = {}) {
  const effectiveAskedAt = Date.parse(
    question.agentAskedAt
    ?? thread?.lastAgentAt
    ?? question.contextSnapshot?.lastAgentAt
    ?? thread?.lastActivityAt
    ?? question.createdAt
    ?? ""
  );
  const askedAt = Number.isFinite(effectiveAskedAt) ? effectiveAskedAt : Date.parse(question.createdAt ?? "");
  if (question.kind === "ready" && prMissing) return "PR not found";
  if (pr && SETTLED_PR_STATES.has(pr.state)) {
    // An ask made after the merge (a release, QA on it) is not about it —
    // unless the ask explicitly treats the PR as still open/unmerged ("PR #283 is up", mergeAsk).
    const settledAt = Date.parse(pr.mergedAt ?? pr.closedAt ?? "");
    const prNum = parsePrRef(pr.ref)?.number;
    const textHay = `${question.title ?? ""} ${question.body ?? ""}`;
    const treatsPrAsOpen = Boolean(
      !/\bmerged\b/i.test(textHay)
      && (
        question.mergeAsk
        || (prNum && new RegExp(`#${prNum}\\b[^.\\n]{0,50}\\b(?:is\\s+(?:up|open|ready)|to\\s+merge|merge\\s+it)`, "i").test(textHay))
      )
    );
    const after = question.kind === "ready"
      || treatsPrAsOpen
      || !Number.isFinite(settledAt)
      || !Number.isFinite(askedAt)
      || settledAt >= askedAt;
    if (after) return `${prNum ? `#${prNum}` : "PR"} ${pr.state === "MERGED" ? "merged" : "closed"}`;
  }
  if (pr?.state === "OPEN" && question.askedHead && pr.headOid && pr.headOid !== question.askedHead) return `PR head moved past ${String(question.askedHead).slice(0, 10)}`;
  if (question.kind === "ready" && notReady) return `PR no longer ready: ${notReady}`;
  if (question.kind !== "agent-ask") return null;
  if (muted) return "muted by owner";
  if (threadGone) return `thread ${thread?.excluded ?? "left the scan"}`;
  const spokeAt = Date.parse(agentReply(thread).at ?? "");
  if (!question.mergeAsk && thread && Number.isFinite(spokeAt) && Number.isFinite(askedAt) && spokeAt > askedAt) return "agent moved on: no longer asks";
  const ownerAt = Date.parse(thread?.lastUserAt ?? "");
  const ownerDirect = Boolean(thread && !String(thread.lastUserText ?? "").startsWith(SUPERVISOR_PREFIX));
  if (!question.mergeAsk && ownerDirect && Number.isFinite(ownerAt) && Number.isFinite(askedAt) && ownerAt > askedAt && thread.agentStatus === "running") {
    return "owner followed up: agent is working";
  }
  return null;
}

// pending: the judge has not read the chat (a failure, the per-scan cap), so
// its open question for this thread stays.
function judgeWait(decision, reason, pending = true) {
  return { ...decision, action: "wait", message: null, route: null, notBefore: null, reason, judgePending: pending };
}

// A resume of a stopped or capped turn goes before merge-ready chatter.
const SEND_FIRST = new Set(["resume", "infra-recovered"]);

// The label single questions use, so a group never names a thread by its
// session id or title (a first prompt, an automation prompt).
// What changes when a thread moves: its newest agent or owner text and state.
function activityMark(thread) {
  return [thread?.lastAgentAt ?? null, thread?.lastUserAt ?? null, thread?.lastActivityAt ?? null, thread?.agentStatus ?? null].join("|");
}

// What a source's own listing says about a thread, before any git, PR or
// screen read adds to it: a proposal made on these facts is only still
// meant while they hold (a deferred thread is not reassessed).
function discoveredFacts(thread) {
  return shortHash(JSON.stringify([activityMark(thread), thread?.prRefs ?? [], thread?.branch ?? null, thread?.lastUserText ?? null]));
}

// The button auto-approve clicks, first match: the narrowest grant that keeps
// the same card from coming back in that chat. Never "Always allow", which
// grants it to every chat for good.
const AUTO_APPROVE_LABELS = ["allow this conversation", "allow for this session", "allow for session", "allow once", "approve once", "approve", "allow", "yes, allow", "yes"];
// Chats approved per scan, and cards in a row per chat (a command can raise
// another right after).
const AUTO_APPROVE_MAX_THREADS = 5;
const AUTO_APPROVE_MAX_CARDS = 3;

export function autoApproveLabel(buttons) {
  const shown = (buttons ?? []).map((label) => ({ label, key: String(label ?? "").trim().toLowerCase() }));
  for (const want of AUTO_APPROVE_LABELS) {
    const hit = shown.find((button) => button.key === want);
    if (hit) return hit.label;
  }
  return null;
}

function threadLabel(thread) {
  if (!thread) return "?";
  const ref = thread.prRefs?.[0] ?? "";
  const pr = Number(/#(\d+)$/.exec(ref)?.[1]);
  return ownerLabel(thread, pr > 0 ? pr : null, parsePrRef(ref)?.repo);
}

function formatReset(iso) {
  const at = Date.parse(iso ?? "");
  if (!Number.isFinite(at)) return "soon";
  return new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function groupQuestions(asks, byKey) {
  const out = [];
  const titles = new Set();
  const groups = { limit: [], open: [], deliver: [] };
  const single = (decision) => ({
    ...decision.question,
    threadKey: String(decision.threadKey ?? "").startsWith("infra:") ? null : (decision.threadKey ?? null),
    prRef: decision.question.prRef ?? (decision.threadKey ? byKey.get(decision.threadKey)?.prRefs?.[0] : null) ?? null,
    playbook: decision.playbook
  });
  for (const decision of asks) {
    const kind = decision.question.kind;
    // Only questions with the group's exact choices merge; a model-limit
    // question ("switched" / "wait") keeps its own wording and buttons.
    const match = GROUPED_KINDS[kind]?.match;
    const sameChoices = !match || JSON.stringify(decision.question.options) === JSON.stringify(match);
    if (groups[kind] && sameChoices) { groups[kind].push(decision); continue; }
    const titleKey = kind === "infra" && !decision.question.options?.includes("retry")
      ? `infra:${decision.question.title}`
      : decision.question.dedupeKey ?? `${decision.threadKey}:${decision.question.title}:${decision.question.body}`;
    if (titles.has(titleKey)) continue;
    titles.add(titleKey);
    out.push(single(decision));
  }
  // The store keeps 50 members per question, so a bigger group splits.
  const chunks = Object.entries(groups).flatMap(([kind, all]) => (all.length <= GROUP_MAX ? [[kind, all, 0]]
    : Array.from({ length: Math.ceil(all.length / GROUP_MAX) }, (_, i) => [kind, all.slice(i * GROUP_MAX, (i + 1) * GROUP_MAX), i])));
  for (const [kind, list, part] of chunks) {
    const spec = GROUPED_KINDS[kind];
    const minSize = spec.minSize ?? 2;
    if (list.length === 1 && minSize > 1 && !list[0].carried) out.push(single(list[0]));
    // Carried members alone (see act) still rewrite their open group, so
    // members reassessed this scan and no longer asked drop out of it.
    if (!list.length || (list.length < minSize && !list.every((decision) => decision.carried))) continue;
    const threads = list.map((decision) => byKey.get(decision.threadKey)).filter(Boolean);
    // A delivery failure names its reason, so the owner knows what to fix.
    const labels = kind === "deliver"
      ? list.map((decision) => (decision.carried ? threadLabel(byKey.get(decision.threadKey)) : `${threadLabel(byKey.get(decision.threadKey))} (${String(decision.reason ?? "").replace(/^can't deliver: /, "")})`)).join(", ")
      : threads.map(threadLabel).join(", ");
    const resets = threads.map((thread) => thread.error?.resetAt).filter(Boolean).sort();
    out.push({
      kind, dedupeKey: part ? `${spec.dedupeKey}:${part + 1}` : spec.dedupeKey, options: spec.options, playbook: null, threadKey: null, prRef: null,
      threadKeys: list.map((decision) => decision.threadKey),
      title: spec.title(list.length, formatReset(resets[0])),
      body: spec.body(labels)
    });
  }
  return out;
}

function incidentKey(action) {
  const key = String(action?.threadKey ?? "");
  if (key.startsWith("infra:")) return key;
  return action?.kind === "escalate-manager" ? (INCIDENT_KEYS[action.playbook] ?? null) : null;
}

function effectiveDecisions(decisions) {
  const out = new Map();
  for (const decision of decisions) {
    const current = out.get(decision.threadKey);
    if (!current || (DECISION_RANK[decision.action] ?? 0) >= (DECISION_RANK[current.action] ?? 0)) out.set(decision.threadKey, decision);
  }
  return out;
}

// A snapshot saved before rows carried health still gives the phone one.
function withHealth(snapshot) {
  if (!Array.isArray(snapshot?.threads) || snapshot.threads.every((row) => row?.health)) return snapshot;
  return { ...snapshot, threads: snapshot.threads.map((row) => (row?.health ? row : { ...row, health: threadHealth(row?.state, row?.error ?? null) })) };
}

// thread key -> when the earliest open question naming it was put to the
// owner (lastAskedAt is refreshed every scan, so it would restart the clock
// after each daemon restart). Only questions the owner can see.
function askTimes(questions) {
  const out = new Map();
  for (const question of questions) {
    for (const key of [question.threadKey, ...(question.threadKeys ?? [])].filter(Boolean)) {
      const at = question.reopenedAt ?? question.createdAt ?? null;
      if (at && !(out.get(key) <= at)) out.set(key, at);
    }
  }
  return out;
}

// The owner's last message in the chat: null when the last user turn is the
// supervisor's own (it arrives as a user turn too) or none was read.
function ownerSpokeAt(thread) {
  return String(thread?.lastUserText ?? "").startsWith(SUPERVISOR_PREFIX) ? null : (thread?.lastUserAt ?? null);
}

const KNOWN_CACHE_MAX = 600;

function setBounded(map, key, value, max = KNOWN_CACHE_MAX) {
  if (!key || !value) return;
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

// Identifies one failure of a session (its error, not the scan time), so a
// failover is attempted once per failure.
function failoverSignature(thread) {
  return shortHash(JSON.stringify([
    String(thread?.error?.kind ?? ""),
    String(thread?.error?.text ?? "").slice(0, 300),
    // When the error message was posted: a new failure is a new message.
    String(thread?.error?.at ?? thread?.lastAgentAt ?? "")
  ]));
}

// A goal the owner snoozed or paused, or whose last batch is done and waits
// for the owner's sign-off, is never restarted automatically: the sign-off
// request is surfaced by Active Work follow-through instead.
function goalAcceptsAutoContinuation(goal, nowMs = Date.now()) {
  if (!goal || goal.outcomeVerified || goal.state === "done" || goal.state === "paused") return false;
  if (goal.state === "snoozed") {
    const until = Date.parse(goal.snoozedUntil ?? "");
    if (!Number.isFinite(until) || until > nowMs) return false;
  }
  if (goal.awaitingFollowup === true) return false;
  if (goal.cursor && Number(goal.cursor.remaining) === 0) return false;
  if (goal.remainingCountSource === "explicit" && goal.remainingCount === 0) return false;
  return true;
}

function buildQuestionContextSnapshot(thread, pr) {
  if (!thread && !pr) return null;
  const rawWorkspace = typeof thread?.workspace === "string" ? thread.workspace.trim() : "";
  const workspace = rawWorkspace && !/^wks_[0-9a-f]+$/i.test(rawWorkspace) ? clampText(rawWorkspace, 80) : null;
  return {
    threadTitle: clampText(redactSecrets(thread?.title ?? ""), 140) || null,
    workspace,
    repo: thread?.repo ?? pr?.repo ?? null,
    branch: thread?.branch ?? pr?.headRef ?? null,
    provider: thread?.meta?.provider ?? thread?.kind ?? null,
    paseoCwd: thread?.meta?.paseoCwd ?? null,
    paseoWorkspaceId: thread?.meta?.workspaceId ?? null,
    paseoHasWorkspaceId: Boolean(thread?.meta && Object.prototype.hasOwnProperty.call(thread.meta, "workspaceId") && thread.meta.workspaceId !== undefined),
    serverId: thread?.meta?.serverId ?? null,
    aliases: Array.isArray(thread?.meta?.aliases) ? thread.meta.aliases.slice(0, 4) : [],
    agentSummary: clampTailLines(redactSecrets(thread?.lastAgentFull || thread?.lastAgentText || ""), 1600) || null,
    lastUserText: clampTailLines(redactSecrets(thread?.lastUserText || ""), 600) || null,
    lastUserAt: thread?.lastUserAt ?? null,
    lastAgentAt: thread?.lastAgentAt ?? null,
    recentMessages: (thread?.meta?.conversation ?? []).slice(-4).map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      text: clampTailLines(redactSecrets(m.text ?? ""), 700),
      at: m.at ?? null
    })),
    pr: pr ? {
      ref: pr.ref,
      url: pr.url,
      number: pr.number,
      title: clampText(redactSecrets(pr.title ?? ""), 180) || null,
      bodySummary: pr.bodySummary ?? null,
      state: pr.state ?? null,
      isDraft: Boolean(pr.isDraft),
      head: String(pr.headOid ?? "").slice(0, 10) || null,
      mergeState: pr.mergeState ?? null,
      ciState: pr.ci?.state ?? null,
      failingChecks: (pr.ci?.failing ?? []).slice(0, 4),
      unresolvedThreads: pr.unresolvedThreads ?? 0,
      additions: Number.isFinite(pr.additions) ? pr.additions : null,
      deletions: Number.isFinite(pr.deletions) ? pr.deletions : null,
      changedFiles: Number.isFinite(pr.changedFiles) ? pr.changedFiles : null,
      files: Array.isArray(pr.files) ? pr.files.slice(0, 12) : [],
      gates: Array.isArray(pr.gates) ? pr.gates.slice(0, 4).map((g) => ({ label: g.label || g.name, state: g.state ?? null })) : [],
      qa: pr.qa ? { required: pr.qa.required ?? null, freshOnHead: pr.qa.freshOnHead ?? null } : null
    } : null
  };
}

// How much of the agent's last message a thread's detail shows.
const DETAIL_EXCERPT_MAX = 12_000;
// Options that only send the owner to the chat: a question with no other is
// answered in the agent's app, never here.
const APP_ONLY_OPTIONS = new Set(["open thread", "opened"]);
// Asks the owner must read in full before any button: a release or deploy,
// a delete, a merge.
const RISKY_ASK = /\b(?:prod(?:uction)?|releas(?:e|es|ed|ing)|deploy(?:s|ed|ing|ment)?|delet(?:e|es|ed|ing|ion)|destroy|wipe|merg(?:e|es|ed|ing)|force[- ]push|rewrite (?:git )?history)\b|--admin\b/i;
const MUTE_HOURS_DEFAULT = 24;
// The asks the owner may answer in their own words: one thread's own
// question, a stuck thread, a ready-to-merge ask. Not a card only the app
// takes, a permission prompt, or a group.
const REPLY_KINDS = new Set(["agent-ask", "stuck", "ready", "completed", "session-error"]);
export const REPLY_MAX = 2000;

// questionView's risky flag: a release, deploy, delete or merge ask.
export function riskyQuestion(question) {
  const text = [question?.title, question?.body, ...(question?.options ?? [])].filter(Boolean).join(" ");
  return Boolean(question?.mergeAsk) || question?.kind === "storage" || (["agent-ask", "agent-card", "ready"].includes(question?.kind) && RISKY_ASK.test(text));
}

export function canReplyTo(question) {
  const isPaseoInline = ["agent-card", "prompt"].includes(question?.kind)
    && (question?.meta?.app === "paseo" || String(question?.threadKey ?? "").startsWith("paseo:"));
  return typeof question?.threadKey === "string" && Boolean(question.threadKey)
    && (REPLY_KINDS.has(question.kind) || isPaseoInline)
    && !((question.threadKeys ?? []).length > 1);
}

// A risky answer or reply is typed into the agent's app as the owner's,
// never relayed or resumed: an agent refused a relayed "yes".
const RISKY_NO_ROUTE = "risky ask: it is only typed into the agent's app, and this Mac cannot type into it; approve it in the chat";
const RISKY_WAITS = "risky ask: it is only typed into the agent's app";
// Whether the Mac can type into this thread's app later (not a CLI-only Mac).
// The chat's last owner message is this same text, sent within the last
// half hour: its time (HH:MM UTC), else null. Short words ("continue",
// "yes") are meant to repeat; only a real prompt counts.
const DUPLICATE_WINDOW_MS = 30 * 60_000;
const DUPLICATE_MIN_CHARS = 60;
// Exact text, outer whitespace aside: case and inner spacing can be the
// whole correction (an identifier, a Python indent).
const sameWords = (value) => String(value ?? "").trim();

function sameRecentOwnerText(thread, text, now) {
  const at = Date.parse(thread?.lastUserAt ?? "");
  if (!Number.isFinite(at) || now - at > DUPLICATE_WINDOW_MS || sameWords(text).length < DUPLICATE_MIN_CHARS) return null;
  if (sameWords(thread.lastUserText) !== sameWords(text)) return null;
  return `${new Date(at).toISOString().slice(11, 16)} UTC`;
}

function typesLater(thread, deliveryState) {
  return Boolean(uiTargetFor(thread)) && ["computer-use", "computer-use-first"].includes(deliveryState?.mode);
}

// Delivery that failed only because typing into the app has to wait (a
// strict computer-use Mac that cannot type now, or a typed send held back by
// the owner at the keyboard or a running turn). A CLI fallback's failure is
// not about typing, so it stays the owner's to see.
const TYPING_WAITS = /^(computer use not ready|owner using |turn running|frontmost app changed|secure input|waiting for idle|screen saver on|front app unknown|presence check too slow)/;
// A computer-use send that ends this way stops the tick's other ones.
const UI_STALLED = /^(Open Computer Use timed out|Open Computer Use stopped|delivery timed out)/;
function typingWaits(thread, route, deliveryState, delivery) {
  if (!uiTargetFor(thread)) return false;
  if (!route) return deliveryState?.mode === "computer-use" && deliveryState?.ready === false;
  return route === "computer-use" && TYPING_WAITS.test(String(delivery?.detail ?? ""));
}
// A background (CLI) send of a kept answer reports whether it reached the
// agent later; until then the answer is not sent again.
const QUEUED_SENDING_MS = 15 * 60_000;

// Answers kept while the Mac could not type are dropped after this long; the
// paused-nudge alert has told the owner why by then.
const QUEUED_ANSWER_MS = 24 * 60 * 60_000;

function ownerDelivery(answer) {
  // Options are fixed strings chosen by policy, never agent text.
  return `Owner answer: ${answer}. Continue with that.`;
}

// The owner's own words, typed or spoken: a reply to a question.
function ownerReply(text) {
  return `Owner says: ${text}`;
}

// "retry" on a logged-out / provider-auth / disk-full question means the
// owner fixed it.
const RETRY_DELIVERY = "Owner fixed the blocker (login, provider auth or disk). Retry: continue where you stopped.";
// "added" on an account-cap question means new capacity: resume now.
const ADDED_DELIVERY = "Owner added account capacity. Continue where you stopped.";
const RESTART_REPEAT_MS = 10 * 60_000;
const APP_ACTIONS = new Set(["open", "quit", "restart"]);
// A chat an app quit or restart stopped gets its one resume while the
// record is younger than this.
const APP_RESTART_KEEP_MS = 2 * 60 * MIN;
const APP_RESTARTED_DELIVERY = "The owner restarted {app}, which stopped this chat mid-turn. Continue where you stopped.";
// A permission card read on screen holds until the thread moves past it.
const PROMPT_TTL_MS = 6 * 60 * MIN;
const PROMPT_ACTIVITY_SLACK_MS = 5_000;
// A tick's screen read that found no card waits this long (doubling per
// repeat, up to the max) before the same unmoved thread is read again.
const CARDLESS_READ_MS = 15 * MIN;
const CARDLESS_READ_MAX_MS = 2 * 60 * MIN;
// Open Computer Use unable to read an app (cgWindowNotFound): asked about
// once it failed this often, over this many ticks and this long, with no
// good read since.
const UNREADABLE_MIN_HITS = 3;
const UNREADABLE_MIN_TICKS = 2;
const UNREADABLE_MIN_MS = 10 * MIN;
// Outcomes that prove the app's window was read.
const READ_THE_APP = /^(turn running|draft in composer|could not verify thread|thread changed|permission prompt|text mismatch|composer)/;

export class FleetSupervisor {
  // forceMode pins the mode over the owner's saved choice (the dry-run CLI).
  constructor({ dataDir, runtime = null, config = null, deps = {}, skip = {}, forceMode = null } = {}) {
    this.dataDirOption = dataDir ?? null;
    this.forceMode = MODES.includes(forceMode) ? forceMode : null;
    this.runtime = runtime;
    this.deps = deps ?? {};
    this.skip = { bb3: false, github: false, ...skip };
    this.proactiveSupervisorChat = config?.proactiveSupervisorChat === true;
    this.proactiveRespectQuietHours = config?.proactiveRespectQuietHours === true;
    this.config = config?.paths && config?.limits ? config : resolveFleetConfig(process.env, config ?? {});
    this._store = null;
    this._executor = null;
    this._notifier = null;
    this._playbooks = null;
    this.timer = null;
    this.kickTimer = null;
    this.running = null;
    this.lastTickAt = null;
    this.lastError = null;
    this.lastThreads = new Map();
    this.knownThreads = new Map();
    this.knownRows = new Map();
    this.lastPrs = new Map();
    // threadKey -> scan ordinal. Activity alone must not keep quiet chats
    // outside the scan forever when a fleet is larger than maxThreads.
    this.scopeReadAt = new Map();
    // threadKey -> { classified, pr } and the infra and manager the last scan
    // read: what the owner's Push now decides from (pushNow).
    this.lastItems = new Map();
    this.pushing = new Set();
    this.lastInfra = null;
    this.lastManager = null;
    // key -> { group, since }: when each thread entered its watch group.
    this.watchSince = new Map();
    this.branchLookups = new Map();
    // ref -> last MERGED or CLOSED read, for ticks GitHub cannot answer.
    this.settledPrs = new Map();
    // Refs GitHub reported MERGED: final, so never read again as candidates.
    this.mergedPrs = new Set();
    // Conductor thread key -> the PR the last scan that read GitHub picked.
    this.conductorPicks = new Map();
    this.answering = new Set();
    this._uiDriver = undefined;
    this._uiBlockedSince = null;
    // threadKey -> { text, buttons, stateId, at }: permission cards a send,
    // read or click saw on screen.
    this.prompts = new Map();
    // app -> { since, hits: [{ at, tick }] }: reads Open Computer Use failed.
    this.unreadable = new Map();
    // threadKey -> { mark, at, count }: tick reads that found no card.
    this.cardlessReads = new Map();
    this.tickCount = 0;
    this.lastDelivery = { mode: this.config.delivery ?? "cli", ready: null, detail: null, checkedAt: null };
    this._reviewRunner = null;
    this.lastReview = { at: null, failedAt: null, error: null, ran: null };
    // New questions waiting on the review: hidden from the state the main
    // mirrors until the review has seen them.
    this.awaitingReview = new Set();
    // cache key -> { verdict, at }; see judgeNudges.
    this.judgeCache = new Map();
    this.judgeDownUntil = 0;
    this.judgeError = null;
    // threadKey -> when the judge last read it (a verdict or a failure), so
    // the per-scan cap rotates past threads that keep failing.
    this.judgeTriedAt = new Map();
    // threadKey -> when the owner last answered one of its questions.
    this.ownerAnsweredAt = new Map();
  }

  now() {
    return typeof this.deps.now === "function" ? this.deps.now() : Date.now();
  }

  get dataDir() {
    return this.dataDirOption ?? resolveDataDir();
  }

  // Loaded with the store, which opens on first use.
  get uiBlockedSince() {
    this._uiBlockedSince ??= this.store.uiBlockedSince();
    return this._uiBlockedSince;
  }

  get store() {
    if (!this._store) {
      this._store = new FleetStore({
        dir: path.join(this.dataDir, "fleet"), defaultMode: this.config.mode, limits: this.config.limits, now: () => this.now()
      });
      // Judge asks an older build keyed its own way take today's keys.
      this._store.migrateJudgeAskKeys(agentAskKey);
    }
    return this._store;
  }

  get mode() {
    return this.forceMode ?? this.store.mode ?? this.config.mode;
  }

  // Disk space (storage.js): its scans run on their own timer; the tick only
  // reads free space and the cached plans. deps.storage: test doubles.
  get storage() {
    this._storage ??= new StorageManager({
      config: this.config, dir: path.join(this.store.dir, "storage"), store: this.store, deps: this.deps.storage ?? {},
      getMode: () => this.mode, now: () => this.now(),
      busyCwds: () => [...this.lastThreads.values()].filter((thread) => thread?.agentStatus === "running" && thread.cwd).map((thread) => thread.cwd)
    });
    return this._storage;
  }

  get executor() {
    if (!this._executor) {
      const executor = this.deps.executor ?? createExecutor({
        config: this.config, run: this.deps.run, store: this.store, readLivePeers: this.deps.readLivePeers ?? claude.readLivePeers,
        refreshThread: (thread) => this.refreshThread(thread),
        ui: this.uiDriver, knownThreads: () => [...this.lastThreads.values()]
      });
      // An app send that waited only on the owner's presence arms the idle
      // watcher (idleCheck), from its latest block; everything else is the
      // executor's own. The owner's own message is not kept for a later scan
      // (its caller gets the block), so it arms nothing.
      // (A frozen executor, like the scan CLI's, stays the one that decides.)
      const wrapped = Object.create(executor);
      Object.defineProperty(wrapped, "deliver", {
        enumerable: true, writable: true,
        value: async (args) => {
          const result = await executor.deliver(args);
          if (isPresenceBlock(result) && args?.playbook !== "owner-message") this.idleWorkAt = this.now();
          return result;
        }
      });
      this._executor = wrapped;
    }
    return this._executor;
  }

  // Types into Conductor / the Codex app. An injected executor (tests, the
  // dry-run scan) gets none, so readiness is never probed for it.
  get uiDriver() {
    if (this._uiDriver !== undefined) return this._uiDriver;
    if (this.deps.uiDriver !== undefined) this._uiDriver = this.deps.uiDriver;
    else if (this.deps.executor) this._uiDriver = null;
    else {
      // An orphaned input's pause outlives a restart (see ORPHAN_HOLD_MS).
      UI_INPUT_LATCH.persistTo(path.join(this.store.dir, "ui-input-orphaned.json"));
      this._uiDriver = createUiDriver({
        config: this.config,
        run: this.deps.run ?? runCommand,
        evidenceDir: path.join(this.store.dir, "logs", "ui"),
        activeSessions: () => this.runtime?.computerUseLog?.listSessions?.({ status: "active" }) ?? [],
        now: () => this.now()
      });
    }
    return this._uiDriver;
  }

  // { mode, ready, detail }: ready is null when not probed (cli, or no driver).
  // deadlineAt: a remote caller's. Its probes end before it, and a request
  // with no time left reports computer use not ready (the send waits).
  async probeDelivery({ deadlineAt = null } = {}) {
    if (this.config.paseo?.enabled && this.config.paseo.only) {
      return this.lastDelivery = { mode: "paseo", ready: null, detail: "Paseo native delivery checks each chat before sending", checkedAt: new Date(this.now()).toISOString() };
    }
    const mode = this.config.delivery ?? "cli";
    let state = { mode, ready: null, detail: null };
    const driver = mode === "cli" ? null : this.uiDriver;
    const left = () => (Number.isFinite(deadlineAt) ? deadlineAt - DEADLINE_MARGIN_MS - Date.now() : SOURCE_TIMEOUT_MS);
    if (driver?.readiness) {
      if (left() <= 0) return { mode, ready: false, detail: "no time left in this request" };
      try {
        const result = await withTimeout(Promise.resolve(driver.readiness()), Math.min(SOURCE_TIMEOUT_MS, left()), "computer-use readiness");
        state = { mode, ready: result?.ready === true, detail: result?.ready === true ? null : clampText(result?.detail ?? "not ready", 160) };
        if (state.ready && mode === "computer-use-first" && driver.appRunning) state.apps = await this.probeApps(driver, left);
      } catch (error) {
        state = { mode, ready: false, detail: clampText(`readiness check failed: ${error?.message ?? error}`, 160) };
      }
    }
    this.lastDelivery = { ...state, checkedAt: new Date(this.now()).toISOString() };
    return state;
  }

  // bundleId -> running (true/false), or null when it could not be told.
  async probeApps(driver, left = () => SOURCE_TIMEOUT_MS) {
    const apps = {};
    for (const { bundleId } of Object.values(UI_APPS)) {
      try {
        if (left() <= 0) throw new Error("no time left");
        apps[bundleId] = await withTimeout(Promise.resolve(driver.appRunning(bundleId)), Math.min(SOURCE_TIMEOUT_MS, left()), "app presence");
      } catch {
        apps[bundleId] = null;
      }
    }
    return apps;
  }

  // Why an answer or resume has no route, in the owner's words.
  noRouteDetail(thread, delivery) {
    if (!thread) return "thread not seen since restart: scan first";
    if (delivery?.mode === "computer-use") {
      if (!uiTargetFor(thread)) return "no app shows this thread (terminal session): open it to answer";
      if (delivery.ready === false) return `computer use not ready: ${delivery.detail ?? "check Open Computer Use"}`;
    }
    return "no live route: open the thread to answer";
  }

  // The nudge judge; tests inject a fake one (deps.judge) or its run.
  get nudgeJudge() {
    if (this.deps.judge !== undefined) return this.deps.judge;
    this._nudgeJudge ??= createNudgeJudge({ config: this.config, run: this.deps.judgeRun ?? this.deps.run ?? runCommand });
    return this._nudgeJudge;
  }

  // Lightweight `/v1/decisions` (`gpt-6-luna`) keep-alive gate; 0% codex-lb draw.
  get decisionsGate() {
    if (this.deps.decisionsGate !== undefined) return this.deps.decisionsGate;
    this._decisionsGate ??= createDecisionsKeepAliveGate({
      config: this.config,
      env: this.deps.env ?? {},
      fetchImpl: this.deps.decisionsFetch ?? this.deps.fetchImpl ?? globalThis.fetch,
      now: () => this.now()
    });
    return this._decisionsGate;
  }

  // runModel for the review; tests inject a fake one.
  get reviewRunner() {
    if (this.deps.runModel) return this.deps.runModel;
    this._reviewRunner ??= createReviewRunner({ config: this.config, run: this.deps.run ?? runCommand });
    return this._reviewRunner;
  }

  get notifier() {
    if (this.deps.notifier) return this.deps.notifier;
    // The notifier shares the supervisor's clock, so quiet hours and push
    // caps are judged at the same time the scan runs (and are testable).
    this._notifier ??= createNotifier({ config: this.config, store: this.store, runtime: this.runtime, fetchImpl: this.deps.fetchImpl, now: () => new Date(this.now()) });
    return this._notifier;
  }

  playbooks() {
    // Reloaded each tick so an edited playbook file applies without a restart.
    try {
      this._playbooks = loadPlaybooks({ bundledDir: BUNDLED_PLAYBOOKS_DIR, userDir: userPlaybooksDir(this.dataDir) });
    } catch {
      this._playbooks ??= new Map();
    }
    return this._playbooks;
  }

  get scanIntervalMs() {
    return this.config.paseo?.enabled && this.config.paseo.only ? Math.max(15000, this.config.paseo.pollMs ?? 30000) : this.config.tickMs;
  }

  start() {
    if (!this.config.enabled || this.timer) return false;
    const fire = (reason) => this.tick({ reason }).catch(() => { /* recorded in lastError */ });
    this.timer = setInterval(() => fire("interval"), this.scanIntervalMs);
    this.timer.unref?.();
    this.kickTimer = setTimeout(() => fire("start"), START_DELAY_MS);
    this.kickTimer.unref?.();
    if (!(this.config.paseo?.enabled && this.config.paseo.only) && this.config.idleDrain?.enabled && (this.config.delivery ?? "cli") !== "cli") {
      this.idleTimer = setInterval(() => { this.idleCheck().catch(() => { /* next poll */ }); }, this.config.idleDrain.pollMs ?? 15_000);
      this.idleTimer.unref?.();
    }
    if (this.config.storage?.enabled) this.storage.start();
    return true;
  }

  stop() {
    this.stops = (this.stops ?? 0) + 1;
    if (this.timer) clearInterval(this.timer);
    if (this.kickTimer) clearTimeout(this.kickTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.timer = null;
    this.kickTimer = null;
    this.idleTimer = null;
    this._storage?.stop();
  }

  // App sends that waited only because the owner was at the Mac go out soon
  // after they step away, not at the next scheduled scan: one cheap idle
  // read (ioreg) per poll while such sends wait, then one scan, started so
  // its sends begin about when the owner has been away long enough to type.
  // The scan re-decides everything; nothing is replayed from the old one.
  async idleCheck() {
    if (!this.idleWorkAt || this.running || this.idleChecking || this.mode !== "auto") return false;
    const now = this.now();
    // Stale: the next scheduled scan decides again, and re-arms if needed.
    if (now - this.idleWorkAt > 2 * this.config.tickMs) { this.idleWorkAt = null; return false; }
    if (this.lastIdleKickAt && now - this.lastIdleKickAt < IDLE_KICK_GAP_MS) return false;
    const driver = this.uiDriver;
    if (typeof driver?.idleMs !== "function") return false;
    this.idleChecking = true;
    let idle = null;
    try { idle = await driver.idleMs(); } catch { idle = null; } finally { this.idleChecking = false; }
    // Stopped while reading: no scan after shutdown.
    if (!this.idleTimer) return false;
    const ownerIdleMs = { ...DEFAULTS, ...(this.config.limits ?? {}) }.uiOwnerIdleMs;
    const leadMs = Math.max(0, Math.min(Number.isFinite(this.awayLeadMs) ? this.awayLeadMs : IDLE_LEAD_MS, ownerIdleMs - IDLE_KICK_MIN_MS));
    if (!Number.isFinite(idle) || idle < ownerIdleMs - leadMs || this.running) return false;
    this.lastIdleKickAt = now;
    this.idleWorkAt = null;
    this.tick({ reason: "owner-away" }).catch(() => { /* recorded in lastError */ });
    return true;
  }

  // deferUi: a scan that came through the node broker, which stops waiting
  // before a computer-use send would end; its app sends wait for the next
  // scheduled tick (CLI sends and the review still run).
  tick({ reason = "manual", deferUi = false } = {}) {
    // The owner's scan arriving mid-tick gets its own full recheck right
    // after, instead of riding on a scan that did not force the review.
    // Any local request in the queue lets that one type.
    if (this.running && (reason === "owner-scan" || reason === "chat")) {
      this.followUpDefersUi = (this.forcedFollowUp ? this.followUpDefersUi : true) && deferUi;
      this.forcedFollowUp ??= this.running.catch(() => {}).then(() => { this.forcedFollowUp = null; return this.tick({ reason, deferUi: this.followUpDefersUi }); });
      return this.forcedFollowUp;
    }
    // A scheduled scan arriving during an idle-watcher scan (which skips the
    // review) runs after it, so new questions are not held a whole interval.
    // Not after stop(): it would scan (and send) after shutdown.
    if (this.running && reason === "interval" && this.runningReason === "owner-away") {
      const stops = this.stops;
      this.reviewFollowUp ??= this.running.catch(() => {}).then(() => {
        this.reviewFollowUp = null;
        return this.stops === stops ? this.tick({ reason }) : null;
      });
      return this.reviewFollowUp;
    }
    if (this.running) return this.running;
    this.runningReason = reason;
    this.running = this._tick(reason, { deferUi })
      .then((snapshot) => { this.lastError = null; return snapshot; })
      .catch((error) => {
        this.lastError = clampText(error?.message ?? String(error), 300);
        throw error;
      })
      .finally(() => { this.running = null; });
    return this.running;
  }

  emitFleet(reason = "update") {
    try {
      const snap = this.store.snapshot;
      this.runtime?.events?.emit?.("fleet", {
        at: snap?.at ?? new Date(this.now()).toISOString(),
        reason,
        counts: snap?.counts ?? null
      });
    } catch { /* listeners never break a mutation */ }
  }

  getState() {
    const store = this.store;
    const open = store.openQuestions().filter((question) => {
      if (this.awaitingReview.has(question.id)) return false;
      const keys = question.threadKeys ?? (question.threadKey ? [question.threadKey] : []);
      return !keys.length || keys.some((key) => !store.mutedUntil(key));
    });
    // A read can expire a question too (the /fleet page, the main's refresh)
    // while no tick runs.
    this.closeExpired();
    const lastTickIso = this.lastTickAt ?? store.snapshot?.at ?? null;
    const baseTickMs = Number.isFinite(Date.parse(lastTickIso ?? "")) ? Date.parse(lastTickIso) : this.now();
    const nextTickAt = this.config?.enabled ? new Date(baseTickMs + this.scanIntervalMs).toISOString() : null;
    const snapshot = this.liveSnapshot(withHealth(store.snapshot), open, { nextTickAt });
    for (const r of snapshot?.threads ?? []) if (r?.key) setBounded(this.knownRows, r.key, r);
    const rows = new Map([...this.knownRows, ...(snapshot?.threads ?? []).map((row) => [row?.key, row])]);
    const blockingResolver = (threadKey) => this.runtime?.tasks?.blockingImpactFor?.({ threadKey })
      ?? { count: 0, blockingTaskIds: [], blockingTitles: [] };
    const questions = open.map((question) => this.enrichQuestionView(this.questionView(question, rows), rows, blockingResolver));
    const actions = store.actions(50);
    const activityEvents = this.buildActivityEvents({ open, actions, rows, fixes: store.fixes() });
    const baseState = {
      mode: this.mode,
      enabled: Boolean(this.config.enabled),
      running: Boolean(this.running),
      lastTickAt: lastTickIso,
      nextTickAt,
      lastError: this.lastError,
      snapshot,
      questions,
      fixes: store.fixes(),
      // So the owner can reopen a wrong close.
      reviewClosed: store.reviewClosed(),
      actions,
      activityEvents,
      suggestions: store.suggestions(),
      diagnosis: structuredClone(store.state.diagnosis),
      settings: {
        tickMinutes: Math.ceil(this.scanIntervalMs / MIN),
        tickSeconds: this.scanIntervalMs / 1000,
        lookbackHours: this.config.lookbackHours,
        push: this.config.push ?? null,
        relayModel: this.config.relayModel,
        managerRef: this.config.managerRef,
        paseo: { enabled: Boolean(this.config.paseo?.enabled), only: Boolean(this.config.paseo?.only) },
        delivery: this.lastDelivery.mode,
        deliveryReady: this.lastDelivery.ready,
        deliveryDetail: this.lastDelivery.detail,
        review: {
          enabled: Boolean(this.config.review?.enabled),
          // What the review tries first, and the Claude model behind codex.
          provider: this.reviewRunner?.provider ?? this.config.review?.provider ?? null,
          model: this.reviewRunner?.model ?? this.config.review?.model ?? null,
          fallbackModel: this.reviewRunner?.fallbackModel ?? null,
          lastAt: this.lastReview.at ? new Date(this.lastReview.at).toISOString() : null,
          // Which ran last: { provider, model, fallbackReason }.
          lastRun: this.lastReview.ran ?? null,
          lastError: this.lastReview.error
        },
        decisions: {
          enabled: Boolean(this.decisionsGate?.enabled),
          model: this.decisionsGate?.model ?? this.config.decisions?.model ?? null
        }
      }
    };
    const projectAliases = store.projectAliases?.() ?? null;
    const deck = buildSupervisorDeck(baseState, {
      preferences: store.preferences(),
      now: this.now(),
      threadsByKey: new Map([...this.knownThreads, ...this.lastThreads]),
      prsByKey: this.lastPrs,
      knownRows: this.knownRows,
      blockingResolver,
      projectAliases,
      activeGoalResolver: (tKey, prRef) => this.activeWork.findActiveGoalForThread(tKey, prRef)
    });
    const watchdog = this.buildWatchdogSummary(snapshot);
    const precedentsSummary = {
      total: this.precedentMemory.list().length,
      recentApplications: this.precedentMemory.applications(5)
    };
    return { ...baseState, ...deck, watchdog, precedentsSummary };
  }

    buildWatchdogSummary(snapshot) {
      const rows = Array.isArray(snapshot?.threads) ? snapshot.threads : [];
      const tracked = rows.filter((r) => r?.watchdog);
      const overdueItems = tracked
        .filter((r) => r.watchdog.overdue)
        .sort((a, b) => (b.watchdog.silentMinutes ?? 0) - (a.watchdog.silentMinutes ?? 0))
        .slice(0, 25)
        .map((r) => ({
          threadKey: r.key,
          title: r.title ?? r.key,
          project: r.project ?? null,
          status: r.watchdog.status,
          phase: r.watchdog.phase,
          expectedMinutes: r.watchdog.expectedMinutes,
          silentMinutes: r.watchdog.silentMinutes,
          overdueMinutes: r.watchdog.overdueMinutes,
          checkInDueAt: r.watchdog.checkInDueAt,
          diagnosis: r.watchdog.diagnosis ?? null
        }));
      return {
        checkedAt: snapshot?.at ?? new Date(this.now()).toISOString(),
        trackedCount: tracked.length,
        overdueCount: tracked.filter((r) => r.watchdog.overdue).length,
        stuckCount: tracked.filter((r) => r.watchdog.severelyStuck).length,
        items: overdueItems
      };
    }

  enrichQuestionView(questionView, rows, blockingResolver) {
    const key = questionView?.threadKey ?? null;
    const row = key ? rows.get(key) ?? null : null;
    const thread = key ? (this.lastThreads.get(key) ?? this.knownThreads.get(key) ?? null) : null;
    const rawOverride = key ? this.store?.threadAssignment?.(key) ?? null : null;
    const projectAliases = this.store?.projectAliases?.() ?? null;
    const orgOverride = (rawOverride || projectAliases) ? { ...(rawOverride ?? {}), projectAliases } : null;
    const project = deriveCardProject({ project: questionView?.project ?? null, repo: row?.repo ?? thread?.repo ?? null, workspace: row?.workspace ?? thread?.workspace ?? null }, thread ?? row, orgOverride);
    const actorLabel = deriveActorLabel(row, thread);
    const subchannel = deriveSubchannel(row, thread, project);
    const impact = computeBlockingImpact({
      threadKey: key,
      prRef: questionView?.prRef ?? row?.pr?.ref ?? null,
      branch: row?.branch ?? thread?.branch ?? null,
      rowsByKey: rows,
      blockingResolver
    });
    const labels = deriveBoardLabels({
      row,
      thread,
      question: questionView,
      prRef: questionView?.prRef ?? null,
      ciState: row?.pr?.ci?.state ?? null,
      subchannel,
      blockingCount: impact.blockingCount
    });
    return {
      ...questionView,
      actorLabel,
      subchannel,
      labels,
      blockingCount: impact.blockingCount,
      blockingSummary: impact.blockingSummary
    };
  }

  buildActivityEvents({ open = [], actions = [], rows = new Map(), fixes = [] } = {}) {
    const events = [];
    const inferMeta = (threadKey) => {
      const row = threadKey ? (rows.get(threadKey) ?? this.knownRows.get(threadKey) ?? null) : null;
      const thread = threadKey ? (this.lastThreads.get(threadKey) ?? this.knownThreads.get(threadKey) ?? null) : null;
      const project = deriveCardProject({ repo: row?.repo ?? thread?.repo ?? null, workspace: row?.workspace ?? thread?.workspace ?? null }, thread ?? row);
      const subchannel = deriveSubchannel(row, thread, project);
      const actor = deriveActorLabel(row, thread);
      return { row, thread, project, subchannel, actor };
    };

    for (const act of actions.slice(0, 20)) {
      if (!act?.id) continue;
      const { row, project, subchannel, actor } = inferMeta(act.threadKey ?? null);
      const prRef = act.prRef ?? row?.pr?.ref ?? null;
      events.push({
        id: `act:${act.id}`,
        kind: act.kind ?? "action",
        actor: actor || (act.by === "owner" ? "Owner" : "Supervisor"),
        project,
        subchannel,
        title: clampText(redactSecrets(act.playbook ? `${act.kind ?? "action"} · ${act.playbook}` : (act.kind ?? "Supervisor action")), 90),
        detail: clampText(redactSecrets(act.reason || act.detail || act.message || act.status || "Updated"), 180),
        threadKey: act.threadKey ?? null,
        taskId: act.taskId ?? null,
        prRef,
        labels: deriveBoardLabels({ row, prRef, ciState: row?.pr?.ci?.state ?? null, subchannel }),
        at: act.at ?? null
      });
    }

    for (const q of open.slice(0, 12)) {
      const { row, project, subchannel, actor } = inferMeta(q.threadKey ?? null);
      const prRef = q.prRef ?? row?.pr?.ref ?? null;
      events.push({
        id: `q:${q.id}`,
        kind: "held_question",
        actor: actor || "Coding agent",
        project,
        subchannel,
        title: clampText(redactSecrets(q.title || "Needs decision"), 90),
        detail: clampText(redactSecrets(q.body || q.askContext || "Held for owner input"), 180),
        threadKey: q.threadKey ?? null,
        taskId: null,
        prRef,
        labels: deriveBoardLabels({ row, question: q, prRef, subchannel }),
        at: q.agentAskedAt ?? q.updatedAt ?? q.createdAt ?? null
      });
    }

    for (const fix of (fixes ?? []).slice(0, 8)) {
      if (!fix?.id) continue;
      events.push({
        id: `fix:${fix.id}`,
        kind: `fix_${fix.state ?? "queued"}`,
        actor: "Self-fix worker",
        project: "openAGI",
        subchannel: "openagi/self-fix",
        title: clampText(redactSecrets(fix.area ? `Self-fix · ${fix.area}` : "Self-fix"), 90),
        detail: clampText(redactSecrets(fix.summary || fix.reason || fix.state || "Running"), 180),
        threadKey: fix.threadKey ?? null,
        taskId: null,
        prRef: fix.prRef ?? null,
        labels: fix.state ? [`state=${String(fix.state).toLowerCase()}`] : [],
        at: fix.updatedAt ?? fix.createdAt ?? null
      });
    }

    const taskStore = this.runtime?.tasks;
    if (taskStore) {
      for (const unblocked of (taskStore.recentUnblocks ?? []).slice(-6)) {
        const t = unblocked?.task;
        if (!t?.id) continue;
        events.push({
          id: `unblock:${t.id}:${unblocked.at ?? ""}`,
          kind: "task_unblocked",
          actor: t.sourceMeta?.actor || "Task graph",
          project: t.sourceMeta?.project || "general",
          subchannel: t.sourceMeta?.subchannel || null,
          title: clampText(`Unblocked: ${t.title}`, 90),
          detail: "All prerequisite tasks completed; moved to pending.",
          threadKey: t.sourceMeta?.threadKey ?? null,
          taskId: t.id,
          prRef: null,
          labels: Array.isArray(t.tags) ? t.tags.filter((tag) => tag.includes("=")).slice(0, 4) : [],
          at: unblocked.at ?? t.updatedAt ?? null
        });
      }
      const recentTasks = [...(taskStore.tasks?.values?.() ?? [])]
        .filter((t) => t?.sourceMeta?.agentLease?.claimedAt || t?.sourceMeta?.threadKey)
        .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
        .slice(0, 8);
      for (const t of recentTasks) {
        const tKey = t.sourceMeta?.threadKey ?? null;
        const meta = inferMeta(tKey);
        const leasedAt = t.sourceMeta?.agentLease?.claimedAt ?? null;
        events.push({
          id: `task:${t.id}:${t.status}`,
          kind: t.status === "completed" ? "task_completed" : (leasedAt ? "task_claimed" : "task_linked"),
          actor: t.sourceMeta?.actor || meta.actor || "Agent",
          project: t.sourceMeta?.project || meta.project || "general",
          subchannel: t.sourceMeta?.subchannel || meta.subchannel || null,
          title: clampText(`${t.status === "completed" ? "Done" : (leasedAt ? "Claimed" : "Task")}: ${t.title}`, 90),
          detail: t.sourceMeta?.blockedReason || (leasedAt ? "Active agent lease attached to coding thread." : "Linked to coding session."),
          threadKey: tKey,
          taskId: t.id,
          prRef: meta.row?.pr?.ref ?? null,
          labels: Array.isArray(t.tags) ? t.tags.filter((tag) => tag.includes("=")).slice(0, 4) : [],
          at: t.completedAt ?? leasedAt ?? t.updatedAt ?? t.createdAt ?? null
        });
      }
    }

    const deduped = [];
    const seen = new Set();
    for (const ev of events.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")))) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      deduped.push(ev);
      if (deduped.length >= 30) break;
    }
    return deduped;
  }

  // The last scan's rows brought up to now. Watching follows the questions
  // open now: one answered or dismissed since the scan takes its row out of
  // "Waiting on you" at once (codex:01a13388 sat there 3 minutes after its
  // only question was dismissed, until the next scan), and a new one puts
  // it in. Each row also says whether the owner muted it, and what opens it.
  liveSnapshot(snapshot, open, { nextTickAt = null } = {}) {
    if (!Array.isArray(snapshot?.threads)) return snapshot;
    const askedAt = askTimes(open);
    const closedAt = this.store.closedAtByThread();
    const byWatch = Object.fromEntries(WATCH_GROUPS.map((group) => [group, 0]));
    const fallbackNextTick = nextTickAt ?? (this.config?.enabled
      ? new Date((Number.isFinite(Date.parse(this.lastTickAt ?? snapshot?.at ?? "")) ? Date.parse(this.lastTickAt ?? snapshot.at) : this.now()) + this.scanIntervalMs).toISOString()
      : null);
    const threads = snapshot.threads.map((row) => {
      if (!row?.key) return row;
      const muted = this.store.mutedUntil(row.key);
      const watch = liveWatch(row.watch ?? null, { state: row.state, askedAt: askedAt.get(row.key) ?? null, closedAt: closedAt.get(row.key) ?? null, muted });
      if (watch) byWatch[watch.group] = (byWatch[watch.group] ?? 0) + 1;
      // A snapshot saved before rows carried openChat: this process's read.
      const openChat = row.openChat !== undefined ? row.openChat : openChatFor(this.lastThreads.get(row.key));
      const preview = this.lastItems.get(row.key)?.pushPreview;
      const thread = this.lastThreads.get(row.key) ?? this.knownThreads.get(row.key);
      const pending = this.store.openQuestions().some((q) => q.threadKey === row.key || (q.threadKeys ?? []).includes(row.key));
      const canPush = preview?.action === "nudge" && preview.message && !muted && !pending
        && !this.ownerAnswerThreads(Infinity).has(row.key) && !repeatsLastSend(thread, this.store.ledgerFor(row.key), preview.messageHash);
      const actorLabel = row.actorLabel ?? deriveActorLabel(row, thread);
      const rawOverride = this.store?.threadAssignment?.(row.key) ?? null;
      const projectAliases = this.store?.projectAliases?.() ?? null;
      const orgOverride = (rawOverride || projectAliases) ? { ...(rawOverride ?? {}), projectAliases } : null;
      const project = deriveCardProject(
        { repo: row.repo ?? thread?.repo ?? null, workspace: row.workspace ?? thread?.workspace ?? null, project: row.project ?? null, cwd: row.cwd ?? null },
        thread ?? row,
        orgOverride
      );
      const subchannel = (orgOverride?.theme ? null : row.subchannel) ?? deriveSubchannel(row, thread, project, orgOverride);
      const labels = Array.isArray(row.labels) && row.labels.length > 0
        ? row.labels
        : deriveBoardLabels({ row: { ...row, watch }, thread, prRef: row.pr?.ref ?? null, ciState: row.pr?.ci?.state ?? null, subchannel });
      const activeQuietWatch = !muted && (row.live || row.agentStatus === "running" || ["working", "waiting", "push", "you"].includes(watch?.group) || row.pr?.state === "OPEN");
      const linkedTask = this.linkedTaskForThread(row.key);
      const freshWatchdog = thread
        ? estimateExpectedCheckIn(thread, {
            classified: this.lastItems.get(row.key)?.classified ?? { state: row.state },
            pr: this.lastItems.get(row.key)?.pr ?? row.pr ?? null,
            task: linkedTask,
            now: this.now(),
            limits: this.config.limits
          })
        : (row.watchdog ?? null);
      const diagnosis = row.watchdog?.diagnosis ?? (thread ? diagnoseAgentBlocker(thread, { pr: row.pr ?? null, now: this.now(), limits: this.config.limits }) : null);
      const watchdog = freshWatchdog
        ? { ...freshWatchdog, ...(diagnosis ? { diagnosis: { kind: diagnosis.kind, label: diagnosis.snagLabel, resolution: diagnosis.resolution } } : {}) }
        : null;
      const nextCheckAt = activeQuietWatch
        ? (watchdog?.checkInDueAt && Date.parse(watchdog.checkInDueAt) < Date.parse(fallbackNextTick ?? "")
            ? watchdog.checkInDueAt
            : fallbackNextTick)
        : null;
      return { ...row, lastAgentText: redactSecrets(row.lastAgentText), watch, muted, openChat: openChat ?? null,
        project, actorLabel, subchannel, labels, nextCheckAt, ...(watchdog ? { watchdog } : {}),
        pushPreview: canPush ? { action: "nudge", playbook: preview.playbook, reason: preview.reason, message: preview.message } : null, pushing: this.pushing.has(row.key) };
    });
    return { ...snapshot, threads, counts: { ...(snapshot.counts ?? {}), byWatch, needsYou: open.filter((question) => needsOwnerDecision(question)).length } };
  }

  // One open question as the cards show it: when the agent asked (else when
  // the supervisor first put it to the owner), in which chat (label and the
  // link that opens it), whether it is answered here or only in the agent's
  // app, and whether it is a risky ask whose full text comes before any
  // button. A group names each of its chats.
  questionView(question, rows) {
    const chatOf = (key) => {
      const thread = this.lastThreads.get(key) ?? this.knownThreads.get(key);
      const fromThread = (thread ? openChatFor(thread) : rows.get(key)?.openChat) ?? null;
      if (fromThread) return fromThread;
      const parsed = parsePaseoThreadKey(key);
      if (parsed) {
        const snapTitle = question.contextSnapshot?.threadTitle;
        return {
          app: "paseo",
          url: null,
          label: `${snapTitle || "Paseo chat"} (Paseo)`,
          serverId: parsed.serverId,
          agentId: parsed.agentId,
          note: "Open this existing chat on its Paseo host."
        };
      }
      return null;
    };
    const openChat = question.threadKey ? chatOf(question.threadKey) : null;
    const chats = (question.threadKeys ?? []).map((key) => ({ threadKey: key, ...(chatOf(key) ?? { app: null, url: null, label: key, note: null }) }));
    const options = question.options ?? [];
    const isPaseoThread = Boolean(parsePaseoThreadKey(question.threadKey));
    const paseoInlineCard = question.kind === "agent-card"
      && (openChat?.app === "paseo" || question.meta?.app === "paseo" || isPaseoThread);
    const inApp = (question.kind === "agent-card" && !paseoInlineCard)
      || (!isPaseoThread && !options.some((option) => !APP_ONLY_OPTIONS.has(option)));
    return {
      ...question,
      askedAt: question.agentAskedAt ?? question.createdAt ?? null,
      chatLabel: openChat?.label ?? (chats.length ? `${chats[0].label}${chats.length > 1 ? ` +${chats.length - 1} more` : ""}` : null),
      answerIn: inApp ? "agent app" : "here",
      openChat,
      ...(chats.length ? { chats } : {}),
      risky: riskyQuestion(question),
      ...buildOwnerDecision(question, { kind: question.kind }),
      // Takes the owner's own words (POST questions/:id { reply }).
      canReply: canReplyTo(question) || (isPaseoThread && ["agent-card", "prompt"].includes(question.kind))
    };
  }

  setMode(mode) {
    if (!MODES.includes(mode)) return null;
    const saved = this.store.setMode(mode);
    if (mode !== "propose") {
      for (const action of this.store.actions(this.config.limits.maxActionsKept)) {
        if (action.status === "proposed") this.store.updateAction(action.id, { status: "stale", detail: "mode changed" });
      }
    }
    if (mode === "observe") this.selfFixHub.stop("all").catch(() => {});
    this.emitFleet("mode-changed");
    return saved;
  }

  dismissQuestion(id) {
    const question = this.store.question(id);
    if (!question || question.status !== "open") return null;
    if (question.kind === "suggestion") {
      this.respondSuggestion(question.meta?.suggestionId, "Not now").catch(() => {});
      this.emitFleet("question-dismissed");
      return this.store.question(id);
    }
    // A storage ask comes back every tick, and a dismissal holds while it is
    // asked: one dismiss would mute it for good. It counts as Later (24 h).
    if (question.kind === "storage" && (question.options ?? []).includes("Later")) {
      this.resolveOutreach(question, "Later", "acted");
      const closed = this.store.answerQuestion(id, "Later");
      this.emitFleet("question-dismissed");
      return closed;
    }
    this.store.savePreferences(recordPreferenceSignal(this.store.preferences(), { type: "dismiss", question, answer: "dismiss", now: this.now() }));
    if (["completed", "session-error"].includes(question.kind) && question.threadKey) {
      this.store.markCompletionReviewed(
        question.threadKey,
        question.contextSnapshot?.lastAgentAt ?? question.lastAskedAt ?? question.createdAt ?? this.now()
      );
    }
    this.applyOverride(question, "dismiss");
    this.resolveOutreach(question, "dismiss", "dismissed");
    const dismissed = this.store.dismissQuestion(id);
    this.emitFleet("question-dismissed");
    return dismissed;
  }

  // The owner's feedback and the self-fix requests it leads to: stored here,
  // where the runner will work them (voice tools and /fleet/api call these).
  recordFeedback(input) { return this.store.recordFeedback(input); }
  feedback(options) { return this.store.feedback(options); }
  get selfFixHub() {
    this._selfFixHub ??= new SelfFixHub({ store: this.store, runtime: this.runtime, config: this.config });
    return this._selfFixHub;
  }
  queueFix(input) { return this.selfFixHub.queue(input); }
  fixes(options) { return this.store.fixes(options); }
  reviseFix(id, instructions) { return this.selfFixHub.revise(id, instructions); }
  stopFix(id) { return this.selfFixHub.stop(id); }

  suggestions() { return this.store.suggestions(); }

  get suggestionManager() {
    this._suggestionManager ??= new SuggestionManager({ store: this.store, config: this.config,
      queueFix: (input) => this.queueFix(input), now: () => this.now(), notify: (q, options) => this.notifier.notifyQuestion(q, options),
      respondSuggestion: (id, choice, options) => this.respondSuggestion(id, choice, options),
      // Behind an OPENAGI_FLEET_NODE main no coding node is reachable from here: ask instead.
      canAutoFix: () => Boolean(this.selfFixHub.nodeId && this.runtime?.nodeCapabilities?.dispatch),
      models: this.deps.diagnoseModels ?? createDiagnoseModels({ config: this.config, run: this.deps.runCommand, now: () => this.now() }) });
    return this._suggestionManager;
  }

  async respondSuggestion(id, choice, options) {
    const questions = this.store.openQuestions().filter((q) => q.kind === "suggestion" && q.meta?.suggestionId === id);
    const result = await this.suggestionManager.respond(id, choice, options);
    if (result && !result.nonResolving) for (const q of questions) this.resolveOutreach(q, choice, "acted");
    return result;
  }

  diagnose(options = {}) {
    return runDiagnosis({ store: this.store, dataDir: this.dataDir, now: this.now(), storageConfig: this.config.storage, runtime: this.config.selfFix?.runtimeImprovements ? this.runtime : null,
      state: { ...this.store.state, lastError: this.lastError, lastReview: this.lastReview }, options, models: this.suggestionManager });
  }

  async diagnoseTick() {
    const now = this.now();
    const due = diagnoseDue(this.store.state.diagnosis, now, this.config.limits.quietHours);
    if (due.hourly) {
      const report = await this.diagnose({ cheap: true });
      this.store.saveDiagnosis({ hourlyAt: new Date(now).toISOString(), cheap: report });
      this.store.rotateActions();
    }
    if (due.daily) {
      // Mark before the call: model outages never turn into a call every tick.
      this.store.saveDiagnosis({ dailyDay: localDay(now) });
      const report = await this.diagnose({ window: "7d", completeDay: true });
      this.store.saveDiagnosis({ full: report });
      if (this.forceMode !== "observe") await this.suggestionManager.publish(report.suggestions);
    } else if (due.hourly && this.forceMode !== "observe") await this.suggestionManager.refresh();
  }

  // The owner reopens a question the review closed (a wrong call): same
  // record, and its outreach copy comes back. Pinned, so the review keeps
  // it until its ask changes.
  reopenReviewed(id) {
    const question = this.store.reopenReviewed(id);
    if (!question) return null;
    this.reopenOutreach(question);
    this.store.recordAction({
      kind: "review", playbook: "review", threadKey: question.threadKey ?? null, questionId: id, status: "done",
      reason: clampText(`owner reopened: ${question.title}`, 300)
    });
    this.emitFleet("question-reopened");
    return question;
  }

  // The outreach copy (Mac overlay, G2) must not keep asking after the
  // question closed on /fleet or by itself.
  resolveOutreach(question, decision, status) {
    if (!question?.outreachId) return;
    try { this.runtime?.outreach?.resolve?.(question.outreachId, decision, { status }); } catch { /* best-effort */ }
  }

  // An expired question's copy must not keep asking on the Mac or G2.
  closeExpired() {
    for (const question of this.store.takeExpired()) this.resolveOutreach(question, "expired", "dismissed");
  }

  reopenOutreach(question) {
    if (!question?.outreachId) return;
    try { this.runtime?.outreach?.reopen?.(question.outreachId); } catch { /* best-effort */ }
  }

  // startedAt: when the owner's request began (Date.now): an app send counts
  // its time from there, so a remote request ends inside the broker's 5 min.
  // deadlineAt: when a remote caller stops waiting, its queue time included.
  async resumeAll(question, message, settling = [], { restartApps = [], startedAt = Date.now(), deadlineAt = null } = {}) {
    const keys = question.threadKeys ?? (question.threadKey ? [question.threadKey] : []);
    const restarted = await this.restartHosts(keys, restartApps, deadlineAt);
    if (restarted) return restarted;
    let sent = 0;
    let blocked = 0;
    let late = 0;
    const deliveryState = await this.probeDelivery({ deadlineAt });
    // A Conductor session and the Codex thread it hosts are one app
    // conversation: one typed send covers every key that maps to it.
    const typedInto = new Map();
    for (const key of keys) {
      // Read the store each time: a background resume that failed meanwhile
      // took its key back out, so that thread is sent again.
      if (this.store.question(question.id)?.deliveredThreadKeys?.includes(key)) { sent += 1; continue; }
      const thread = this.lastThreads.get(key);
      const route = thread ? chooseRoute(thread, this.mode === "auto" ? "auto" : "propose", deliveryState) : null;
      if (!thread || !route) { blocked += 1; continue; }
      const uiKey = route === "computer-use" ? uiTargetFor(thread)?.targetKey ?? null : null;
      if (uiKey && typedInto.has(uiKey)) {
        if (typedInto.get(uiKey)) { sent += 1; this.store.markQuestionDelivered(question.id, key); } else blocked += 1;
        continue;
      }
      // Past the caller's deadline it reports failure: no member starts then
      // (a relay or background resume would still land, and a retry repeat it).
      if (Number.isFinite(deadlineAt) && Date.now() >= deadlineAt - DEADLINE_MARGIN_MS) { late += 1; continue; }
      const delivery = await this.executor.deliver({ thread, message, route, playbook: "owner-answer", spentMs: Date.now() - startedAt, deadlineAt });
      // A send that fell back to a background route says nothing about the app.
      if ((delivery.route ?? route) === "computer-use") this.noteUiResult(thread, delivery);
      if (uiKey) typedInto.set(uiKey, delivery.status === "sent");
      this.store.recordNudge(thread.key, { playbook: "owner-answer", route: delivery.route ?? route, status: delivery.status === "sent" ? "owner-answer" : delivery.status });
      if (delivery.status === "sent") {
        sent += 1;
        this.store.markQuestionDelivered(question.id, key);
        if (delivery.done) settling.push(delivery.done.then((reached) => (reached ? null : key)));
      }
      else blocked += 1;
    }
    return { status: blocked || late || !sent ? "blocked" : "sent", route: null, detail: `${sent} resumed, ${blocked} not reachable${late ? `, ${late} not sent (out of time)` : ""}; open the thread and retry if needed` };
  }

  // When each nudge first waited on computer use (Auto only: the other modes
  // never send on their own). A thread its source could not show this tick
  // (the scan failed, or hit its cap) keeps its time; one that no longer
  // waits drops it, so the age is always that of a nudge still waiting.
  trackUiBlocked(decisions, { mode, delivery, threads, sourceErrors, started, config, deferred = new Set() }) {
    if (mode !== "auto" || delivery.ready !== false) { this.uiBlockedSince.clear(); this.store.setUiBlockedSince(this.uiBlockedSince); return; }
    const now = new Set(decisions.filter((decision) => decision?.uiBlocked).map((decision) => decision.threadKey));
    const seen = new Set(threads.map((thread) => thread.key));
    const hidden = (key) => {
      // infra:bb3 and infra:lb belong to their probes, not a thread source.
      const [kind, probe] = String(key).split(":");
      if (kind === "infra") return Boolean(sourceErrors[probe]);
      // Rotated out of a capped scan: not reassessed, so still waiting.
      if (deferred.has(key)) return true;
      const capped = threads.filter((thread) => thread.kind === kind && (kind !== "antigravity" || !thread.excluded)).length >= config.limits.maxThreads;
      return !seen.has(key) && (Boolean(sourceErrors[kind]) || capped);
    };
    for (const key of [...this.uiBlockedSince.keys()]) if (!now.has(key) && !hidden(key)) this.uiBlockedSince.delete(key);
    for (const key of now) if (!this.uiBlockedSince.has(key)) this.uiBlockedSince.set(key, started);
    this.store.setUiBlockedSince(this.uiBlockedSince);
  }

  // Owner answers kept while the Mac could not type. Each goes to its agent
  // once a route works, and only while the agent still asks that same thing
  // (this tick asked its dedupeKey): a stale "yes" must never land on a new
  // question. One the owner overtook in the thread is dropped quietly; one
  // older than a day, or whose thread is gone, goes back to the owner.
  async deliverQueuedAnswers({ byKey, started, cappedKinds, asked, decided, sourceUnknown, budget = Infinity, deferUi = false }) {
    // uiStalled: a computer-use send timed out or lost Open Computer Use;
    // the rest of the tick's typing waits (the send loop too).
    const contacted = { threads: new Set(), uiKeys: new Set(), sent: 0, uiStalled: false };
    let tries = 0;
    const queued = this.store.queuedAnswers();
    if (!queued.length) return contacted;
    const deliveryState = await this.probeDelivery();
    for (const question of queued) {
      const pending = question.pendingDelivery;
      const thread = byKey.get(question.threadKey);
      // A background send still settling decides this one.
      if (pending.sendingAt && started - Date.parse(pending.sendingAt) < QUEUED_SENDING_MS) continue;
      // A day without a way to type: back in front of the owner (unless the
      // same ask already is, or its thread is gone and nothing is left to answer).
      if (started - Date.parse(pending.since) > QUEUED_ANSWER_MS) {
        this.store.settleQueuedAnswer(question.id, "dropped");
        if (thread && !this.store.openQuestions().some((q) => q.dedupeKey === question.dedupeKey)) this.store.reopenQuestion(question.id, [], { answer: question.answer, asked: true });
        continue;
      }
      if (contacted.sent >= budget) continue;
      // Only the thread's own source matters here: a git or PR read that
      // failed says nothing about whether the agent can take the answer.
      if (sourceUnknown([question.threadKey])) continue;
      // A full scan leaves threads out; that is not proof this one is gone.
      if (!thread && cappedKinds.has(String(question.threadKey).split(":")[0])) continue;
      if (!thread) { this.store.settleQueuedAnswer(question.id, "dropped"); continue; }
      // Past the scan's thread cap this tick: nothing was decided for it.
      if (!decided.has(thread.key)) continue;
      const ownerSince = Date.parse(thread.lastUserAt ?? "") > Date.parse(question.answeredAt ?? "") && !String(thread.lastUserText ?? "").startsWith(SUPERVISOR_PREFIX);
      // An agent's own question must still stand. A "retry" after the owner
      // fixed a blocker is sent even though the blocker is no longer asked,
      // unless the agent has spoken since (it recovered, or asks something new).
      const agentSince = Date.parse(thread.lastAgentAt ?? "") > Date.parse(question.answeredAt ?? "");
      // The judge does not read a thread whose answer waits (judgeNudges),
      // so its ask is not asked again: it stands until the agent speaks.
      const judgeAsk = question.askedBy === "judge";
      const stale = (question.kind === "agent-ask" || question.kind === "agent-card") && !judgeAsk ? !asked.has(question.dedupeKey) : agentSince;
      if (ownerSince || stale) { this.store.settleQueuedAnswer(question.id, "superseded"); continue; }
      const route = chooseRoute(thread, this.mode === "auto" ? "auto" : "propose", deliveryState);
      if (!route) continue;
      // A risky answer waits for typing, never a relay or resume.
      if (pending.typedOnly && route !== "computer-use") continue;
      if ((contacted.uiStalled || deferUi) && route === "computer-use") continue;
      // Failed tries are bounded too, like the send loop's.
      if (tries >= budget * 2) continue;
      tries += 1;
      const delivery = await this.executor.deliver({ thread, message: pending.message, route, playbook: "owner-answer", ...(pending.typedOnly ? { typedOnly: true } : {}) });
      if ((delivery.route ?? route) === "computer-use") this.noteUiResult(thread, delivery);
      this.store.recordNudge(thread.key, { playbook: "owner-answer", route: delivery.route ?? route, status: delivery.status === "sent" ? "owner-answer" : delivery.status, detail: delivery.detail ?? null });
      if (route === "computer-use" && UI_STALLED.test(String(delivery.detail ?? ""))) contacted.uiStalled = true;
      if (delivery.status !== "sent") continue;
      contacted.sent += 1;
      contacted.threads.add(thread.key);
      const uiKey = uiTargetFor(thread)?.targetKey;
      if (uiKey) contacted.uiKeys.add(uiKey);
      if (!delivery.done) { this.store.settleQueuedAnswer(question.id, "sent"); continue; }
      // A CLI child reports later whether it reached the agent.
      this.store.markQueuedSending(question.id);
      delivery.done
        .then((reached) => (reached ? this.store.settleQueuedAnswer(question.id, "sent") : this.store.markQueuedSending(question.id, null)))
        .catch(() => this.store.markQueuedSending(question.id, null));
    }
    return contacted;
  }

  // Restarts each listed app that shows one of these threads, once per ten
  // minutes (a second answer after a partial send does not restart again).
  // Returns a blocked delivery when it must not or could not restart.
  async restartHosts(keys, restartApps, deadlineAt = null) {
    const threads = keys.map((key) => this.lastThreads.get(key)).filter(Boolean);
    for (const app of restartApps) {
      if (!threads.some((thread) => uiTargetFor(thread)?.app === app)) continue;
      if (this.now() - (this.store.restartedAt(app) ?? -Infinity) < RESTART_REPEAT_MS) continue;
      const name = UI_APPS[app]?.name ?? app;
      // A restart ends every running turn in that app, not just the capped ones.
      const busy = [...this.lastThreads.values()].filter((thread) => !keys.includes(thread.key) && thread.agentStatus === "running" && uiTargetFor(thread)?.app === app);
      if (busy.length) return { status: "blocked", route: null, detail: `${busy.length} chats still running in ${name}; a restart would stop them. Answer again when they finish.` };
      // A restart the remote caller cannot wait out would go on changing the
      // desktop after it gave up: none starts without room to finish.
      if (Number.isFinite(deadlineAt) && Date.now() + restartMaxMs(this.config.limits) > deadlineAt - DEADLINE_MARGIN_MS) {
        return { status: "blocked", route: null, detail: `no time left in this request to restart ${name}; answer again to retry` };
      }
      const result = await this.appRestarter.restart(app);
      this.store.recordAction({ kind: "restart", playbook: "account-switched", threadKey: null, status: result.ok ? "done" : "failed", reason: `restart ${name} after an account switch`, detail: result.detail, at: new Date(this.now()).toISOString() });
      if (!result.ok) return { status: "blocked", route: null, detail: `${result.detail}; answer again to retry` };
      this.store.markRestarted(app, this.now());
    }
    return null;
  }

  get appRestarter() {
    return this.appController;
  }

  // open / quit / restart for Conductor and the Codex app (ui-delivery's
  // createAppController); tests inject one.
  get appController() {
    this._appController ??= this.deps.appController ?? this.deps.appRestarter
      ?? createAppController({ bins: this.config.bins ?? {}, run: this.deps.run ?? runCommand, limits: this.config.limits });
    return this._appController;
  }

  // The chats running in an app right now, read fresh from the sources that
  // can show it (Codex and Conductor). A thread the last scan saw that this
  // read does not list (a full page) keeps its last state. null when a
  // source failed: unknown is not idle.
  // One Conductor chat or Antigravity conversation read again now (a
  // background or agentapi send re-checks it).
  async refreshThread(thread) {
    const config = { ...this.config, mode: this.mode };
    const d = this.deps;
    if (thread?.kind === "antigravity") {
      const read = Promise.resolve().then(() => (d.listAntigravityThreads ?? antigravity.listAntigravityThreads)(config, { now: this.now(), only: [thread.id] }));
      const fresh = await withTimeout(read, SOURCE_TIMEOUT_MS, "antigravity");
      return (fresh ?? []).find((entry) => entry.key === thread.key) ?? null;
    }
    if (thread?.kind !== "conductor") return null;
    let peers = new Map();
    try { peers = (d.readLivePeers ?? claude.readLivePeers)(config) ?? new Map(); } catch { /* peers only label sessions */ }
    const read = Promise.resolve().then(() => (d.listConductorThreads ?? conductor.listConductorThreads)(config, { now: this.now(), peers, only: [thread.id] }));
    const fresh = await withTimeout(read, SOURCE_TIMEOUT_MS, "conductor");
    return (fresh ?? []).find((entry) => entry.key === thread.key) ?? null;
  }

  async liveRunningIn(app) {
    const config = { ...this.config, mode: this.mode };
    const d = this.deps;
    const now = this.now();
    let peers = new Map();
    try { peers = (d.readLivePeers ?? claude.readLivePeers)(config) ?? new Map(); } catch { /* peers only label sessions */ }
    let fresh;
    try {
      const [codexThreads, conductorThreads] = await Promise.all([
        withTimeout(Promise.resolve().then(() => (d.listCodexThreads ?? codex.listCodexThreads)(config, { now, run: d.run ?? runCommand })), SOURCE_TIMEOUT_MS, "codex"),
        withTimeout(Promise.resolve().then(() => (d.listConductorThreads ?? conductor.listConductorThreads)(config, { now, peers })), SOURCE_TIMEOUT_MS, "conductor")
      ]);
      fresh = linkUiHosts(mergeThreads({ codex: codexThreads ?? [], claude: [], conductor: conductorThreads ?? [] }));
    } catch {
      return null;
    }
    const byKey = new Map([...this.lastThreads].filter(([, thread]) => thread?.kind === "codex" || thread?.kind === "conductor"));
    for (const thread of fresh) byKey.set(thread.key, thread);
    return [...byKey.values()].filter((thread) => thread?.agentStatus === "running" && uiTargetFor(thread)?.app === app);
  }

  // The chats a quit or restart would stop, as the owner is asked to approve
  // them: the same live read appAction checks, chats the scan leaves out
  // (no repo, past the cap) included. null when a source failed.
  async runningInApp(app) {
    const live = await this.liveRunningIn(app);
    return live ? live.map((thread) => ({ key: thread.key, name: thread.workspace || thread.title || thread.key })) : null;
  }

  // The owner's open, quit or restart of one app. Quit and restart stop every
  // turn running in it: expectRunning is the chats the owner approved
  // stopping, and any other running chat blocks it. The stopped chats are
  // kept (in the store) and each gets one resume once the app is back.
  async appAction(app, action, { expectRunning = null, deadlineAt = null } = {}) {
    const spec = UI_APPS[app];
    if (!spec || !APP_ACTIONS.has(action)) return { ok: false, app, action, detail: "Use open, quit or restart for conductor or codex." };
    let running = [...this.lastThreads.values()].filter((thread) => thread?.agentStatus === "running" && uiTargetFor(thread)?.app === app);
    if (action !== "open") {
      // The last scan can be minutes old: re-read the app's chats now, so a
      // turn started since then is counted too.
      const live = await this.liveRunningIn(app);
      if (!live) return { ok: false, app, action, running: running.map((thread) => thread.key), detail: `could not read which chats are running in ${spec.name}; a ${action} could stop one. Ask again.` };
      running = live;
      const approved = new Set(Array.isArray(expectRunning) ? expectRunning : []);
      const unapproved = running.filter((thread) => !approved.has(thread.key));
      if (unapproved.length) {
        return { ok: false, app, action, running: running.map((thread) => thread.key),
          detail: `${unapproved.length} more chats running in ${spec.name} than approved (${unapproved.map(threadLabel).join(", ")}); a ${action} would stop them. Ask again.` };
      }
    }
    // A remote caller that would give up mid-restart would leave the desktop changing.
    if (Number.isFinite(deadlineAt) && Date.now() + restartMaxMs(this.config.limits) > deadlineAt - DEADLINE_MARGIN_MS) {
      return { ok: false, app, action, detail: `no time left in this request to ${action} ${spec.name}; ask again` };
    }
    const controller = this.appController;
    if (typeof controller?.[action] !== "function") return { ok: false, app, action, detail: `${action} is not available on this Mac` };
    const result = await controller[action](app);
    const at = this.now();
    this.store.recordAction({ kind: action === "restart" ? "restart" : `${action}-app`, playbook: "owner-app", threadKey: null,
      status: result?.ok ? "done" : "failed", reason: `owner: ${action} ${spec.name}`, detail: clampText(result?.detail ?? "", 200), at: new Date(at).toISOString() });
    if (result?.ok) {
      const stopped = running.map((thread) => thread.key);
      if (action === "restart") {
        this.store.markRestarted(app, at);
        if (stopped.length) this.store.setAppRestart(app, { action, at: new Date(at).toISOString(), threadKeys: stopped, due: true, done: [] });
      } else if (action === "quit" && stopped.length) {
        // Resumed only once the fleet opens the app again.
        this.store.setAppRestart(app, { action, at: new Date(at).toISOString(), threadKeys: stopped, due: false, done: [] });
      } else if (action === "open") {
        const quit = this.store.appRestart(app);
        if (quit && quit.action === "quit" && !quit.due) this.store.setAppRestart(app, { ...quit, due: true, openedAt: new Date(at).toISOString() });
      }
      this.unreadable.delete(app);
    }
    return { ok: Boolean(result?.ok), app, action, detail: result?.detail ?? null, running: running.map((thread) => thread.key) };
  }

  // The thread the owner names, and the app that shows it.
  // threads: every thread known (shared titles); the last scan's by default.
  uiThread(threadKey, thread = null, threads = null) {
    const found = thread ?? this.lastThreads.get(threadKey) ?? null;
    if (!found) return { error: "thread not seen since restart: scan first" };
    const target = uiTargetFor(found);
    if (!target) return { error: "no app shows this thread (terminal session)" };
    const driver = this.uiDriver;
    if (!driver) return { error: "computer use unavailable on this Mac" };
    return { thread: found, target, driver, identity: uiIdentity(found, target, threads ?? [...this.lastThreads.values()]) };
  }

  // What one thread's screen shows: its permission card (buttons, stateId),
  // whether a turn runs, Resume buttons, the transcript's tail. No input.
  // navigate: false reads only a thread already on screen (no deep link).
  async screenThread(threadKey, { deadlineAt = null, thread = null, threads = null, navigate = true } = {}) {
    const found = this.uiThread(threadKey, thread, threads);
    if (found.error) return { status: "blocked", detail: found.error, screen: null };
    if (typeof found.driver.inspect !== "function") return { status: "blocked", detail: "screen reads unavailable on this Mac", screen: null };
    let result;
    try {
      result = await found.driver.inspect({ target: found.target, identity: found.identity, evidenceName: `screen-${found.thread.kind}-${String(found.thread.id).slice(0, 8)}-${this.now()}`, deadlineAt, navigate });
    } catch (error) {
      result = { status: "failed", detail: clampText(redactSecrets(`computer use failed: ${error?.message ?? error}`), 200) };
    }
    this.noteUiResult(found.thread, result);
    return { status: result?.status ?? "failed", detail: result?.detail ?? null, ...(result?.code ? { code: result.code } : {}), screen: result?.screen ?? null };
  }

  // Clicks one button of the thread's permission card (or its one Resume
  // button) by exact label; stateId pins the card the owner saw.
  async clickThread(threadKey, label, { stateId = null, deadlineAt = null, thread = null, auto = false } = {}) {
    const found = this.uiThread(threadKey, thread);
    if (found.error) return { delivery: { status: "blocked", route: null, detail: found.error }, prompt: null };
    if (typeof found.driver.clickLabel !== "function") return { delivery: { status: "blocked", route: null, detail: "clicking unavailable on this Mac" }, prompt: null };
    let result;
    try {
      result = await found.driver.clickLabel({ target: found.target, identity: found.identity, label, stateId, evidenceName: `click-${found.thread.kind}-${String(found.thread.id).slice(0, 8)}-${this.now()}`, deadlineAt });
    } catch (error) {
      result = { status: "failed", detail: clampText(redactSecrets(`computer use failed: ${error?.message ?? error}; nothing confirmed`), 200) };
    }
    this.noteUiResult(found.thread, result);
    this.store.recordAction({ kind: "click", playbook: auto ? "auto-approve" : "owner-click", threadKey: found.thread.key, route: "computer-use", status: result?.status ?? "failed",
      reason: clampText(`${auto ? "auto-approve" : "owner"}: click ${label}`, 300), detail: clampText(result?.detail ?? "", 200), at: new Date(this.now()).toISOString() });
    return { delivery: { status: result?.status ?? "failed", route: "computer-use", detail: result?.detail ?? null, ...(result?.code ? { code: result.code } : {}) }, prompt: result?.prompt ?? null };
  }

  // What an app send, read or click learned: the card it saw (or that none
  // shows now), and whether Open Computer Use could read the app at all.
  noteUiResult(thread, result) {
    const target = uiTargetFor(thread);
    if (!target || !result) return;
    const at = this.now();
    if (result.code === "appUnreadable") {
      const entry = this.unreadable.get(target.app) ?? { since: at, hits: [] };
      entry.hits = [...entry.hits, { at, tick: this.tickCount }].slice(-20);
      this.unreadable.set(target.app, entry);
      return;
    }
    const card = result.prompt ?? result.screen?.prompt ?? null;
    if (["sent", "read"].includes(result.status) || card || READ_THE_APP.test(String(result.detail ?? ""))) this.unreadable.delete(target.app);
    if (card?.stateId && Array.isArray(card.buttons)) this.prompts.set(thread.key, { text: clampText(card.text ?? "", 300), buttons: card.buttons.slice(0, 6), stateId: card.stateId, at });
    else if (["sent", "read"].includes(result.status)) this.prompts.delete(thread.key);
  }

  // Auto-approve (OPENAGI_FLEET_AUTO_APPROVE=codex): Codex can raise approval
  // cards even with full access on. One read of its sidebar finds the chats
  // marked "Awaiting approval"; each is opened (never under the owner) and
  // its card's Allow clicked, before any of them becomes a question.
  async approveCodexCards(inScope, threads, started) {
    const driver = this.uiDriver;
    if (typeof driver?.attention !== "function" || typeof driver?.clickLabel !== "function") return;
    // Only while Auto holds and the thread is not muted, checked again before
    // each read and click: the owner can switch mode or mute mid-pass.
    const allowed = (thread) => this.mode === "auto" && !this.store.mutedKeys().has(thread.key);
    const codex = inScope.filter((thread) => uiTargetFor(thread)?.app === "codex" && !thread.archived && allowed(thread));
    if (!codex.length) return;
    let rows = [];
    try {
      const read = await driver.attention({ target: UI_APPS.codex, evidenceName: `attention-codex-${started}` });
      rows = read?.status === "read" ? read.rows ?? [] : [];
    } catch { /* unread: only cards already seen are approved */ }
    const marked = new Set(rows.map(identityToken).filter(Boolean));
    // A sidebar row is labelled with what Codex shows: the thread's title, or
    // its first message. The names come from uiIdentity, like every other
    // check of what is on screen, so a name another thread can show (a
    // shared title or first message) proves nothing and is skipped. A label
    // still claimed by two threads here binds to neither.
    const all = threads ?? [...this.lastThreads.values()];
    const names = new Map();
    const claims = new Map();
    for (const thread of codex) {
      const identity = uiIdentity(thread, uiTargetFor(thread), all);
      const own = identity.ambiguous ? [] : [...new Set([...(identity.tokens ?? []), ...(identity.altTokens ?? [])])];
      names.set(thread.key, own);
      for (const name of own) claims.set(name, (claims.get(name) ?? 0) + 1);
    }
    const shown = (thread) => names.get(thread.key).some((name) => marked.has(name) && claims.get(name) === 1);
    const waiting = codex.filter((thread) => this.livePrompt(thread) || shown(thread));
    for (const thread of waiting.slice(0, AUTO_APPROVE_MAX_THREADS)) {
      if (!allowed(thread)) continue;
      if (!this.livePrompt(thread)) {
        try { await this.screenThread(thread.key, { thread, threads, navigate: true }); } catch { continue; }
      }
      for (let clicks = 0; clicks < AUTO_APPROVE_MAX_CARDS; clicks += 1) {
        const card = this.livePrompt(thread);
        const label = card ? autoApproveLabel(card.buttons) : null;
        if (!label || !allowed(thread)) break;
        const clicked = await this.clickThread(thread.key, label, { stateId: card.stateId, thread, auto: true });
        if (clicked.delivery.status !== "sent") break;
        if (!clicked.prompt) this.prompts.delete(thread.key);
      }
    }
  }

  // A read of this thread found no card, the thread has not moved since, and
  // its backoff (15 min, doubling to 2 h) has not run out.
  cardlessReadFresh(thread, at = this.now()) {
    const entry = this.cardlessReads.get(thread?.key);
    if (!entry) return false;
    if (entry.mark !== activityMark(thread)) { this.cardlessReads.delete(thread.key); return false; }
    return at - entry.at < Math.min(CARDLESS_READ_MAX_MS, CARDLESS_READ_MS * 2 ** Math.max(0, entry.count - 1));
  }

  // The card a thread is waiting on, while the thread has not moved past it.
  livePrompt(thread) {
    const entry = this.prompts.get(thread?.key);
    if (!entry) return null;
    const activity = Math.max(Date.parse(thread.lastAgentAt ?? "") || 0, Date.parse(thread.lastActivityAt ?? "") || 0);
    if (this.now() - entry.at > PROMPT_TTL_MS || activity > entry.at + PROMPT_ACTIVITY_SLACK_MS) {
      this.prompts.delete(thread.key);
      return null;
    }
    return { text: entry.text, buttons: [...entry.buttons], stateId: entry.stateId };
  }

  // Open Computer Use has failed to read an app for a while: one question,
  // asked every tick it holds, closing itself after a good read.
  unreadableDecisions(started, threads) {
    const out = [];
    for (const [app, entry] of this.unreadable) {
      const ticks = new Set(entry.hits.map((hit) => hit.tick));
      if (entry.hits.length < UNREADABLE_MIN_HITS || ticks.size < UNREADABLE_MIN_TICKS || started - entry.since < UNREADABLE_MIN_MS) continue;
      const name = UI_APPS[app]?.name ?? app;
      const running = threads.filter((thread) => thread?.agentStatus === "running" && uiTargetFor(thread)?.app === app);
      out.push({
        threadKey: `infra:unreadable-${app}`, state: "infra", action: "ask-user", playbook: null, message: null, blockers: [],
        reason: `computer use can't read ${name}`, route: null, notBefore: null, targetKey: null, progressMark: null,
        question: {
          dedupeKey: `infra:unreadable:${app}`, kind: "infra", threadKey: null,
          title: `Computer use can't read ${name}. Restart it?`,
          body: running.length
            ? `Open Computer Use finds no ${name} window, so nothing can be read or typed. Running in ${name}: ${running.map(threadLabel).join(", ")}. A restart stops them; each gets a resume once ${name} is back.`
            : `Open Computer Use finds no ${name} window, so nothing can be read or typed. No chats are running in ${name}.`,
          options: ["restart", "later"],
          meta: { app, runningKeys: running.map((thread) => thread.key) }
        }
      });
    }
    return out;
  }

  // After the owner's restart (or an open that follows the fleet's quit),
  // each chat it stopped gets app-restarted.md once, in any mode, unless the
  // owner wrote to it since or it is running again.
  async resumeAfterRestart({ byKey, started, deferUi = false, sourceUnknown = () => false }) {
    const out = { sent: 0, threads: new Set(), uiKeys: new Set() };
    const records = this.store.appRestarts().filter((record) => record.due);
    if (!records.length) return out;
    const deliveryState = await this.probeDelivery();
    const body = this.playbooks().get("app-restarted")?.body || APP_RESTARTED_DELIVERY;
    for (const { app, ...record } of records) {
      const at = Date.parse(record.at ?? "");
      if (!Number.isFinite(at) || started - at > APP_RESTART_KEEP_MS) { this.store.setAppRestart(app, null); continue; }
      const done = new Set(record.done ?? []);
      // A Conductor session and the Codex thread it hosts are one chat on
      // screen: it gets one resume, and every key showing it is settled.
      const targetOf = (key) => uiTargetFor(byKey.get(key))?.targetKey ?? null;
      const resumed = new Set([...done].map(targetOf).filter(Boolean));
      for (const key of record.threadKeys ?? []) {
        if (done.has(key) || sourceUnknown([key])) continue;
        const thread = byKey.get(key);
        if (resumed.has(targetOf(key))) { done.add(key); continue; }
        const ownerSince = thread && Date.parse(thread.lastUserAt ?? "") > at && !String(thread.lastUserText ?? "").startsWith(SUPERVISOR_PREFIX);
        if (!thread || ownerSince) { done.add(key); continue; }
        if (thread.agentStatus === "running") {
          // Running again only if the agent wrote after the restart. A turn the
          // restart killed still reads "running" for a while (Codex's rollout
          // window, Conductor's hung "working"): wait for it, do not drop it.
          // (Agent text only: a relaunch can touch the rollout file.)
          if ((Date.parse(thread.lastAgentAt ?? "") || 0) > at) done.add(key);
          continue;
        }
        const route = chooseRoute(thread, "auto", deliveryState);
        if (!route || (deferUi && route === "computer-use")) continue;
        const delivery = await this.executor.deliver({ thread, message: renderTemplate(body, { app: UI_APPS[app]?.name ?? app }), route, playbook: "app-restarted" });
        if ((delivery.route ?? route) === "computer-use") this.noteUiResult(thread, delivery);
        this.store.recordNudge(thread.key, { playbook: "app-restarted", route: delivery.route ?? route, status: delivery.status === "sent" ? "owner-answer" : delivery.status });
        if (delivery.status !== "sent") continue;
        done.add(key);
        out.sent += 1;
        out.threads.add(key);
        const uiKey = uiTargetFor(thread)?.targetKey;
        if (uiKey) { out.uiKeys.add(uiKey); resumed.add(uiKey); }
      }
      for (const key of record.threadKeys ?? []) if (resumed.has(targetOf(key))) done.add(key);
      const left = (record.threadKeys ?? []).filter((key) => !done.has(key));
      this.store.setAppRestart(app, left.length ? { ...record, done: [...done] } : null);
    }
    return out;
  }

  async answerQuestion(id, answer, { deadlineAt = null, clarification = null, confirmed = false } = {}) {
    const startedAt = Date.now();
    if (this.answering.has(id)) return null;
    const question = this.store.question(id);
    if (!question || question.status !== "open") return null;
    if (question.kind === "self-fix" && (question.options ?? []).includes(answer)) return this.selfFixHub.answer(id, answer);
    if (answer === "dismiss") return { question: this.dismissQuestion(id), delivery: null };
    // Every surface (page, outreach, future callers) gets the same check:
    // only the fixed options policy offered can reach an agent.
    if (!(question.options ?? []).includes(answer)) return null;
    if (question.kind === "suggestion") {
      const result = await this.respondSuggestion(question.meta?.suggestionId, answer, { clarification });
      return result ? { question: this.store.question(id), delivery: null, fix: result.fix,
        ...(result.nonResolving ? { nonResolving: true, plan: result.plan } : {}) } : null;
    }
    // A question card is answered in the app itself unless Paseo exposed
    // inline choices that can steer the Paseo agent directly.
    const paseoCardAnswer = question.kind === "agent-card"
      && (question.meta?.app === "paseo" || String(question.threadKey ?? "").startsWith("paseo:"))
      && answer !== "open thread";
    if (question.kind === "agent-card" && answer !== "open thread" && !paseoCardAnswer) return null;
    this.answering.add(id);
    if (question.threadKey) this.ownerAnsweredAt.set(question.threadKey, this.now());
    try {
      let delivery = null;
      const settling = [];
      // Completed / session-error review cards: "Got it" / "Mark done" / unconfirmed
      // notification taps ONLY clear the notification in OpenAGI. Archiving the
      // underlying Paseo session requires explicit confirmation (`confirmed: true`).
      if (["completed", "session-error"].includes(question.kind)) {
        if (question.threadKey) {
          this.store.markCompletionReviewed(
            question.threadKey,
            question.contextSnapshot?.lastAgentAt ?? question.lastAskedAt ?? question.createdAt ?? this.now()
          );
        }
        if (confirmed === true && String(answer).toLowerCase() === "archive" && String(question.threadKey ?? "").startsWith("paseo:")) {
          const parsed = parsePaseoThreadKey(question.threadKey);
          if (parsed) {
            try {
              const archRes = await archivePaseoAgent(this.config, parsed.serverId, parsed.agentId, this.deps.paseoFactory);
              delivery = {
                status: "sent",
                route: "paseo-archive",
                detail: archRes?.ok ? "Archived in OpenAGI and Paseo." : `Cleared notification in OpenAGI (${archRes?.detail || "Paseo archive unavailable"}).`
              };
            } catch {
              delivery = { status: "sent", route: "paseo-archive", detail: "Cleared notification in OpenAGI." };
            }
          }
        } else {
          delivery = { status: "sent", route: "openagi-review", detail: "Notification dismissed." };
        }
      }
      // A tap on one of a permission card's buttons clicks that button in
      // the thread (the card the question was raised for: its stateId).
      if (question.kind === "prompt" && question.threadKey && !["later", "opened"].includes(answer)) {
        if (String(question.threadKey).startsWith("paseo:")) {
          const sent = await this.deliverToAsker(question, answer, ownerDelivery(answer), { deadlineAt, startedAt, settling, ownerChoice: answer });
          delivery = sent.delivery;
          if (delivery.status !== "sent") return { question: this.store.question(id), delivery };
        } else {
          const clicked = await this.clickThread(question.threadKey, answer, { stateId: question.meta?.promptStateId ?? null, deadlineAt });
          delivery = clicked.delivery;
          if (delivery.status !== "sent") return { question: this.store.question(id), delivery };
        }
      }
      // "restart" on the can't-read question restarts that app, stopping
      // only the chats the question listed.
      if (question.kind === "infra" && answer === "restart" && question.meta?.app) {
        const result = await this.appAction(question.meta.app, "restart", { expectRunning: question.meta.runningKeys ?? [], deadlineAt });
        delivery = { status: result.ok ? "sent" : "blocked", route: null, detail: result.detail };
        if (!result.ok) return { question: this.store.question(id), delivery };
      }
      // Storage: Delete / Keep / Later / Clean safe now. Deletes run in the
      // background after each pinned item is checked again.
      if (question.kind === "storage") {
        delivery = await this.storage.answer(question, answer);
        if (delivery.status !== "sent") return { question: this.store.question(id), delivery };
      }
      if (question.kind === "limit" && answer === "added") {
        // The owner's own copy of this playbook says what their apps need
        // after an account switch (a restart, a plain "retry").
        const playbook = this.playbooks().get("account-switched");
        delivery = await this.resumeAll(question, playbook?.body || ADDED_DELIVERY, settling, { restartApps: playbook?.restartApps ?? [], startedAt, deadlineAt });
      }
      // An owner answer to the agent's own question, or "retry" after the owner
      // fixed a login/disk/access blocker, is an explicit instruction: every mode.
      const retry = (question.kind === "infra" || question.meta?.wall === "true") && answer === "retry";
      if ((question.kind === "agent-ask" || paseoCardAnswer || retry) && question.threadKey && answer !== "open thread") {
        let deliveredChoice = answer;
        if (paseoCardAnswer && Array.isArray(question.meta?.labels) && question.meta.labels.length > 0) {
          if (question.meta.labels.includes(answer)) {
            deliveredChoice = answer;
          } else {
            const numbered = /^([1-4])\.\s/.exec(String(answer ?? ""));
            const byIndex = numbered ? question.meta.labels[Number(numbered[1]) - 1] : null;
            if (typeof byIndex === "string" && byIndex.trim()) {
              deliveredChoice = byIndex;
            } else {
              const prefix = String(answer ?? "").replace(/…$/, "").trim();
              const matches = prefix ? question.meta.labels.filter((label) => label.startsWith(prefix)) : [];
              if (matches.length === 1) deliveredChoice = matches[0];
            }
          }
        }
        const message = retry ? RETRY_DELIVERY : ownerDelivery(deliveredChoice);
        const sent = await this.deliverToAsker(question, answer, message, { deadlineAt, startedAt, settling, ownerChoice: retry ? null : deliveredChoice });
        if (sent.queued) {
          this.resolveOutreach(question, answer, "acted");
          this.applyOverride(question, answer);
          return { question: sent.queued, delivery: sent.delivery };
        }
        delivery = sent.delivery;
      }
      // A background resume can fail while the others are still sending;
      // the group closes only once every thread has it.
      if (delivery?.status === "sent" && question.kind === "limit" && answer === "added") {
        const stored = this.store.question(id);
        // A tick may have resolved the group mid-send; only an open one counts.
        if (stored?.status === "open" && (stored.threadKeys ?? question.threadKeys ?? []).some((key) => !(stored.deliveredThreadKeys ?? []).includes(key))) {
          delivery = { ...delivery, status: "blocked", detail: "a resume failed before it reached its thread; answer again to retry" };
        }
      }
      // A failed or unreachable delivery remains actionable on every surface.
      if (delivery && delivery.status !== "sent") {
        this.reopenIfUndelivered(id, settling, answer);
        return { question: this.store.question(id), delivery };
      }
      if (answer === "open thread") return { question, delivery: { status: "blocked", route: null, detail: "Answer in the original thread, then scan again." } };
      const answered = this.store.answerQuestion(id, answer);
      this.store.savePreferences(recordPreferenceSignal(this.store.preferences(), { type: "answer", question, answer, now: this.now() }));
      try {
        this.precedentMemory.recordOwnerDecision({
          question,
          answer,
          repo: question.contextSnapshot?.repo ?? null,
          project: question.project ?? question.contextSnapshot?.workspace ?? null,
          at: new Date(this.now()).toISOString()
        });
      } catch { /* precedent learning never blocks owner answer */ }
      this.resolveOutreach(question, answer, "acted");
      this.applyOverride(question, answer);
      this.reopenIfUndelivered(id, settling, answer);
      if (delivery?.status === "sent" && question.threadKey) {
        const targetThread = this.lastThreads.get(question.threadKey) ?? this.knownThreads.get(question.threadKey) ?? null;
        if (targetThread) this.registerFollowThroughWatch(targetThread, answer, { source: "owner-answer", question });
      }
      this.emitFleet("question-answered");
      return { question: answered, delivery };
    } finally {
      this.answering.delete(id);
    }
  }

  // The owner's answer or reply to the one thread that asked. A risky ask
  // goes only typed into its app. When only the typing has to wait (secure
  // input, a locked screen, the owner at the keyboard) the words are kept
  // and sent once the Mac can type, instead of handing the question back:
  // { queued } is the question, closed with them.
  syntheticPaseoThread(threadKey, question = null) {
    if (!this.config.paseo?.enabled) return null;
    const parsed = parsePaseoThreadKey(threadKey);
    if (!parsed) return null;
    const snap = question?.contextSnapshot ?? null;
    return {
      key: threadKey,
      kind: "paseo",
      id: parsed.agentId,
      title: snap?.threadTitle || "Paseo chat",
      workspace: snap?.workspace ?? null,
      repo: snap?.repo ?? null,
      branch: snap?.branch ?? null,
      agentStatus: "idle",
      archived: false,
      excluded: null,
      lastActivityAt: snap?.lastAgentAt ?? question?.createdAt ?? null,
      lastUserAt: snap?.lastUserAt ?? null,
      lastUserText: snap?.lastUserText ?? "",
      lastAgentAt: snap?.lastAgentAt ?? null,
      lastAgentText: (snap?.agentSummary ?? "").slice(-600),
      lastAgentFull: snap?.agentSummary ?? "",
      meta: {
        serverId: parsed.serverId,
        ...(snap?.paseoHasWorkspaceId
          ? { workspaceId: snap.paseoWorkspaceId ?? null }
          : (typeof snap?.paseoWorkspaceId === "string" ? { workspaceId: snap.paseoWorkspaceId } : {})),
        provider: snap?.provider ?? "paseo",
        paseoCwd: snap?.paseoCwd ?? null,
        aliases: Array.isArray(snap?.aliases) ? snap.aliases : [],
        conversation: Array.isArray(snap?.recentMessages) ? snap.recentMessages : []
      }
    };
  }

  async deliverToAsker(question, answer, message, { deadlineAt = null, startedAt = Date.now(), settling = [], queueMax, ownerChoice = null } = {}) {
    const thread = this.lastThreads.get(question.threadKey)
      ?? this.knownThreads.get(question.threadKey)
      ?? this.syntheticPaseoThread(question.threadKey, question);
    const deliveryState = thread ? await this.probeDelivery({ deadlineAt }) : null;
    const risky = riskyQuestion(question);
    const chosen = thread ? chooseRoute(thread, this.mode === "auto" ? "auto" : "propose", deliveryState) : null;
    const route = risky && !["computer-use", "paseo-send"].includes(chosen) ? null : chosen;
    const expectedPermissionId = question?.meta?.paseoPermissionId
      ?? (question?.meta?.app === "paseo" && String(question?.meta?.cardId ?? "").startsWith("permission-") ? question.meta.cardId : null);
    let delivery;
    if (!thread || !route) {
      const detail = !thread || !risky ? this.noRouteDetail(thread, deliveryState)
        : typesLater(thread, deliveryState) ? RISKY_WAITS : RISKY_NO_ROUTE;
      delivery = { status: "blocked", route: null, detail };
    } else {
      delivery = await this.executor.deliver({ thread, message, route, playbook: "owner-answer", spentMs: Date.now() - startedAt, deadlineAt, ownerChoice, expectedPermissionId, ...(risky ? { typedOnly: true } : {}) });
      if ((delivery.route ?? route) === "computer-use") this.noteUiResult(thread, delivery);
      if (delivery.done) settling.push(delivery.done.then((reached) => (reached ? null : thread.key)));
      // Starts the cooldown but does not spend the no-progress nudge budget.
      this.store.recordNudge(thread.key, { playbook: "owner-answer", route: delivery.route ?? route, status: delivery.status === "sent" ? "owner-answer" : delivery.status });
    }
    const waits = typingWaits(thread, route, deliveryState, delivery) || (risky && !route && typesLater(thread, deliveryState));
    if (thread && delivery.status !== "sent" && waits) {
      // A tick may have closed the question meanwhile; only a stored answer is "saved".
      const queued = this.store.queueAnswer(question.id, answer, message, { typedOnly: risky, ...(queueMax ? { messageMax: queueMax } : {}) });
      if (queued) return { queued, delivery: { status: "queued", route: null, detail: `Saved. It goes to the agent once the Mac can type (${delivery.detail}).` } };
    }
    return { delivery };
  }

  // The owner's own words to the agent that asked ("Owner says: ..."), for
  // a question canReplyTo allows. Sent or kept for when the Mac can type
  // closes it; blocked or failed leaves it open. null: closed, or no reply.
  async replyQuestion(id, reply, { deadlineAt = null } = {}) {
    const startedAt = Date.now();
    const text = String(reply ?? "").trim();
    if (!text || text.length > REPLY_MAX || this.answering.has(id)) return null;
    const question = this.store.question(id);
    if (!question || question.status !== "open" || !canReplyTo(question)) return null;
    this.answering.add(id);
    this.ownerAnsweredAt.set(question.threadKey, this.now());
    try {
      const settling = [];
      const message = ownerReply(text);
      const sent = await this.deliverToAsker(question, text, message, { deadlineAt, startedAt, settling, queueMax: message.length });
      // A free reply is no option: no override (a "stop" typed to a stuck
      // thread must not mute it).
      if (sent.queued) {
        this.resolveOutreach(question, "reply", "acted");
        return { question: sent.queued, delivery: sent.delivery };
      }
      if (sent.delivery.status !== "sent") {
        return { question: this.store.question(id), delivery: sent.delivery };
      }
      const answered = this.store.answerQuestion(id, text);
      try {
        this.precedentMemory.recordOwnerDecision({
          question,
          directive: text,
          repo: question.contextSnapshot?.repo ?? null,
          project: question.project ?? question.contextSnapshot?.workspace ?? null,
          at: new Date(this.now()).toISOString()
        });
      } catch { /* precedent learning never blocks owner reply */ }
      this.resolveOutreach(question, "reply", "acted");
      if (question.threadKey) {
        const targetThread = this.lastThreads.get(question.threadKey) ?? this.knownThreads.get(question.threadKey) ?? null;
        if (targetThread) this.registerFollowThroughWatch(targetThread, text, { source: "owner-reply", question });
      }
      // The store keeps the reply clamped; a failed background send reopens
      // the question only while that stored answer stands.
      this.reopenIfUndelivered(id, settling, answered?.answer ?? text);
      return { question: answered ?? this.store.question(id), delivery: sent.delivery };
    } finally {
      this.answering.delete(id);
    }
  }

  // A background resume reports its exit only later, one thread at a time.
  // Attached after the answer was recorded, so even an instant failure finds
  // the final state; a newer, different answer from the owner stands.
  reopenIfUndelivered(id, settling, answer) {
    for (const outcome of settling) {
      outcome
        .then((key) => { if (key) this.store.reopenQuestion(id, [key], { answer }); })
        .catch(() => { /* best-effort */ });
    }
  }

  // The owner's own words to one thread (the supervisor chat's
  // fleet_send_message, after approval). Same delivery as an owner answer:
  // on a computer-use Mac it is typed into the app, never a CLI.
  // queue: a Conductor chat busy with background tasks gets it after them
  // (its Send button) instead of now (⌘↩).
  async sendOwnerMessage(threadKey, message, { deadlineAt = null, queue = false, images = null, recoverDisconnected = true } = {}) {
    const startedAt = Date.now();
    const text = String(message ?? "").trim();
    if (!text) return { delivery: { status: "blocked", route: null, detail: "empty message" } };
    const onThread = (q) => q.threadKey === threadKey || (q.threadKeys ?? []).includes(threadKey);
    const matchingOpen = this.store.openQuestions().find(onThread) ?? null;
    const thread = this.lastThreads.get(threadKey)
      ?? this.knownThreads.get(threadKey)
      ?? this.syntheticPaseoThread(threadKey, matchingOpen);
    const deliveryState = thread ? await this.probeDelivery({ deadlineAt }) : null;
    // A thread with an open risky ask hears the owner only typed into its
    // app, as an answer to that ask would be.
    // A risky answer kept for typing still counts: its question is closed,
    // but the agent has not heard it yet.
    const risky = this.store.openQuestions().some((q) => onThread(q) && riskyQuestion(q))
      || this.store.queuedAnswers().some((q) => onThread(q) && q.pendingDelivery?.typedOnly === true);
    const chosen = thread ? chooseRoute(thread, this.mode === "auto" ? "auto" : "propose", deliveryState) : null;
    const route = risky && !["computer-use", "paseo-send"].includes(chosen) ? null : chosen;
    if (!thread || !route) {
      const detail = !thread || !risky ? this.noRouteDetail(thread, deliveryState)
        : typesLater(thread, deliveryState) ? `${RISKY_WAITS}; send it again once the Mac can type, or approve it in the chat` : RISKY_NO_ROUTE;
      const action = this.store.recordAction({ threadKey, playbook: "owner-message", status: "blocked", route: null, detail });
      return { delivery: { status: "blocked", route: null, detail, actionId: action.id } };
    }
    // Already in the chat: the owner pasted it, or an earlier send that
    // looked lost got through. Sending it again would run it twice.
    const already = sameRecentOwnerText(thread, text, this.now());
    if (already) {
      const detail = `already in this chat as your message at ${already}; not sent again`;
      const action = this.store.recordAction({ threadKey, playbook: "owner-message", status: "blocked", route, detail });
      return { delivery: { status: "blocked", route, detail, actionId: action.id, duplicate: true } };
    }
    // The owner is speaking to this thread: a judged or planned nudge in
    // flight for it is dropped, as for an owner answer.
    this.ownerAnsweredAt.set(thread.key, this.now());
    const delivery = await this.executor.deliver({ thread, message: text, route, playbook: "owner-message", spentMs: Date.now() - startedAt, deadlineAt, queue: queue === true, images, recoverDisconnected, ...(risky ? { typedOnly: true } : {}) });
    if ((delivery.route ?? route) === "computer-use") this.noteUiResult(thread, delivery);
    this.store.recordNudge(thread.key, { playbook: "owner-message", route: delivery.route ?? route, status: delivery.status === "sent" ? "owner-answer" : delivery.status });
    let followThroughWatch = null;
    if (delivery.status === "sent") {
      this.store.markCompletionReviewed(thread.key, this.now());
      for (const q of this.store.openQuestions()) {
        if (["completed", "session-error"].includes(q.kind) && q.threadKey === thread.key) {
          this.store.answerQuestion(q.id, text);
          this.resolveOutreach(q, "reply", "acted");
        }
      }
      followThroughWatch = this.registerFollowThroughWatch(thread, text, { source: "owner-message", question: matchingOpen });
    }
    // A card in the way comes back with the block: the owner can answer it
    // (fleet_click) and send again.
    const card = delivery.status === "sent" ? null : delivery.prompt ?? this.livePrompt(thread);
    // Every owner send leaves a receipt, a refused one too, so "blocked"
    // always says why in the thread's history.
    const actionId = delivery.actionId
      ?? (delivery.status === "sent" ? null : this.store.recordAction({ threadKey, playbook: "owner-message", status: delivery.status ?? "blocked", route: delivery.route ?? route, detail: delivery.detail ?? null })?.id);
    return { delivery: { status: delivery.status, route: delivery.route ?? route, detail: delivery.detail ?? null,
      ...(actionId ? { actionId } : {}),
      ...(delivery.messageId ? { messageId: delivery.messageId } : {}),
      ...(delivery.providerMessageId ? { providerMessageId: delivery.providerMessageId } : {}),
      ...(delivery.turnId ? { turnId: delivery.turnId } : {}),
      ...(delivery.verifiedAt ? { verifiedAt: delivery.verifiedAt } : {}),
      ...(followThroughWatch?.id ? { followThroughWatchId: followThroughWatch.id } : {}),
      ...(delivery.recoveredSession ? { recoveredSession: delivery.recoveredSession } : {}),
      ...(delivery.unconfirmed === true ? { unconfirmed: true } : {}), ...(card ? { prompt: card } : {}) } };
  }

  registerFollowThroughWatch(thread, message, { source = "owner-message", question = null } = {}) {
    if (!thread?.key) return null;
    const activeGoal = this.activeWork.findActiveGoalForThread(thread.key, thread.prRefs?.[0] ?? question?.prRef ?? null);
    const watch = this.store.upsertFollowThroughWatch({
      threadKey: thread.key,
      title: thread.title || thread.workspace || thread.key,
      goalId: activeGoal?.id ?? null,
      directiveSummary: message,
      source,
      sentAt: new Date(this.now()).toISOString(),
      baselineAgentAt: thread.lastAgentAt ?? null,
      baselineActivityAt: thread.lastActivityAt ?? null
    });
    // When running live (`this.timer` active), schedule a quick follow-up scan
    // ~25s later so fast post-directive blockers (like a 38s idle turn) surface
    // immediately without waiting a full 1-5 minute poll cycle.
    if (this.timer) {
      const followTimer = setTimeout(() => {
        if (this.timer) this.tick("follow-through").catch(() => {});
      }, 25_000);
      followTimer.unref?.();
    }
    return watch;
  }

  async postSupervisorChatUpdate(content, { dedupeKey = null, messageId = null, minGapMs = 30 * MIN, metadata = {} } = {}) {
    const cleanContent = clampTailLines(redactSecrets(String(content ?? "").trim()), 1600);
    if (!cleanContent) return { posted: false, reason: "empty" };
    const nowMs = this.now();
    if (dedupeKey) {
      const prev = this.store.lastSupervisorChatNotice(dedupeKey);
      const prevMs = Date.parse(prev?.at ?? "");
      if (Number.isFinite(prevMs) && nowMs - prevMs < minGapMs) {
        return { posted: false, reason: "deduped" };
      }
    }
    const nowIso = new Date(nowMs).toISOString();
    const stableMsgId = typeof messageId === "string" && /^[\w-]{1,200}$/.test(messageId)
      ? messageId
      : (dedupeKey ? `msg_sup_${shortHash(dedupeKey)}` : null);
    const sharedMsgPayload = {
      ...(stableMsgId ? { id: stableMsgId } : {}),
      role: "assistant",
      text: cleanContent,
      at: nowIso
    };

    let deliveredRemote = false;
    let deliveredLocal = false;
    const nodeConfig = this.dataDir ? readNodeConfig(this.dataDir) : null;
    if (nodeConfig?.remote && nodeConfig?.ownerProxyToken) {
      try {
        const identity = readOrCreateIdentity(this.dataDir);
        const fetchFn = this.deps.supervisorChatFetch ?? this.deps.fetchImpl ?? globalThis.fetch;
        if (typeof fetchFn === "function") {
          const endpoint = `${String(nodeConfig.remote).replace(/\/+$/, "")}/conversations/supervisor/append`;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10_000);
          timer.unref?.();
          try {
            const res = await fetchFn(endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${nodeConfig.ownerProxyToken}`,
                "X-OpenAGI-Node-ID": identity.nodeId
              },
              body: JSON.stringify({
                conversationId: "main",
                messages: [sharedMsgPayload]
              }),
              signal: controller.signal
            });
            deliveredRemote = Boolean(res?.ok);
          } finally {
            clearTimeout(timer);
          }
        }
      } catch { /* fallback to local store if remote hub append fails */ }
    }

    const sessionStore = this.runtime?.agentHost?.store;
    if (sessionStore && typeof sessionStore.getSession === "function" && typeof sessionStore.appendMessage === "function") {
      try {
        const appendedRes = appendSharedThreadMessages(sessionStore, "supervisor", {
          conversationId: "main",
          messages: [sharedMsgPayload]
        });
        if ((appendedRes?.appended?.length ?? 0) > 0) {
          this.runtime?.events?.emit?.("conversation.updated", {
            sessionId: "devices:supervisor:main",
            proactive: true,
            at: nowIso,
            ...(Object.keys(metadata).length ? { metadata } : {})
          });
        }
        deliveredLocal = true;
      } catch { /* best-effort */ }
    }

    if (deliveredRemote || deliveredLocal) {
      if (dedupeKey) this.store.recordSupervisorChatNotice(dedupeKey, cleanContent);
      return { posted: true, deliveredRemote, deliveredLocal, messageId: stableMsgId };
    }
    return { posted: false, reason: "no-channel" };
  }

  async reconcileFollowThroughWatches({ byKey, items, started }) {
    const watches = this.store.openFollowThroughWatches();
    if (!watches.length) return [];
    const outcomes = [];
    for (const watch of watches) {
      const sentMs = Date.parse(watch.sentAt ?? "") || started;
      const elapsedMs = Math.max(0, started - sentMs);
      const thread = byKey.get(watch.threadKey) ?? null;
      if (!thread) {
        // A row kept from a source that failed this scan is not a current
        // observation: its pre-send idle state must not settle the watch.
        if (this.lastThreads.has(watch.threadKey)) continue;
        if (elapsedMs > 6 * 60 * MIN) {
          this.store.resolveFollowThroughWatch(watch.id, { outcome: "expired", detail: "session no longer visible in scan" });
        }
        continue;
      }
      const item = items.find((entry) => entry.thread.key === thread.key) ?? null;
      if (thread.agentStatus === "running" || item?.classified?.state === "running") continue;

      const lastAgentMs = Date.parse(thread.lastAgentAt ?? "") || 0;
      const baseAgentMs = Date.parse(watch.baselineAgentAt ?? "") || 0;
      const agentReplied = lastAgentMs > 0 && (baseAgentMs === 0 || lastAgentMs > baseAgentMs);
      const settledWithoutReply = !agentReplied
        && elapsedMs >= 90_000
        && ["idle", "error", "waiting", "stalled", "aborted"].includes(String(thread.agentStatus ?? ""));
      if (!agentReplied && !settledWithoutReply && !thread.error && !thread.meta?.blockedOnOwner) continue;

      const activeGoal = watch.goalId
        ? (this.activeWork.state.items.find((it) => it.id === watch.goalId) ?? null)
        : this.activeWork.findActiveGoalForThread(thread.key, thread.prRefs?.[0] ?? null);
      const openQ = this.store.openQuestions().find((q) => q.threadKey === thread.key && q.status === "open") ?? null;
      const errText = thread.error?.text ?? null;
      const blockedAsk = item?.classified?.state === "needs-human"
        ? (item.classified.ask?.text || item.classified.reason)
        : null;
      const replyExcerpt = clampText(stripAgentInternalMarkup(thread.lastAgentFull || thread.lastAgentText || ""), 320);
      const explicitUnfinished = /\b(?:submission:\s*not\s+started|not\s+submitted|blocked\s+on|single\s+owner\s+action|owner\s+action|requires?\s+sudo|failed)\b/i.test(replyExcerpt);
      const goalUnverified = Boolean(activeGoal && !activeGoal.outcomeVerified);

      const outcomeKind = errText
        ? "error"
        : (blockedAsk || openQ || explicitUnfinished)
          ? "blocked"
          : goalUnverified
            ? "unverified"
            : "completed";

      const detail = errText || blockedAsk || openQ?.title || replyExcerpt || "Turn finished";
      this.store.resolveFollowThroughWatch(watch.id, { outcome: outcomeKind, detail });
      outcomes.push({ watchId: watch.id, threadKey: thread.key, outcome: outcomeKind, detail });

      // Whenever an owner-directed session finishes its turn in an error, owner-blocker,
      // or unverified goal state, report the verified truth back to Supervisor chat immediately.
      if (["error", "blocked", "unverified"].includes(outcomeKind)) {
        const label = clampText(redactSecrets(thread.title || thread.workspace || thread.key), 80);
        const statusHeadline = outcomeKind === "error"
          ? "hit a session error"
          : (outcomeKind === "blocked" ? "stopped on an owner blocker" : "finished its turn without completing the tracked goal");
        const lines = [
          `**Post-send verification — ${label} ${statusHeadline}**`,
          `- **Session:** \`${thread.key}\`${activeGoal ? ` · **Goal:** ${clampText(activeGoal.goal, 120)} (\`outcomeVerified: false\`)` : ""}`,
          `- **What happened:** ${clampText(detail, 280)}`
        ];
        if (openQ?.id) {
          const opts = (openQ.options ?? []).filter((o) => o !== "dismiss").join(" / ");
          lines.push(`- **Action card:** \`${openQ.id}\`${opts ? ` (options: ${opts})` : ""}`);
        }
        await this.postSupervisorChatUpdate(lines.join("\n"), {
          dedupeKey: `ftw:${thread.key}:${shortHash(detail)}`,
          minGapMs: 10 * MIN,
          metadata: { kind: "follow_through_verification", threadKey: thread.key, outcome: outcomeKind, goalId: activeGoal?.id ?? null }
        });
      }
    }
    return outcomes;
  }

  async maybePostProactiveSupervisorDigest({ started }) {
    const enabled = Boolean(this.timer) || this.proactiveSupervisorChat || this.config?.proactiveSupervisorChat === true;
    if (!enabled) return null;
    const quiet = this.config?.notify?.quietHours ?? null;
    if (quiet && Number.isInteger(quiet.start) && Number.isInteger(quiet.end)) {
      const hour = new Date(started).getHours();
      const inQuiet = quiet.start <= quiet.end
        ? (hour >= quiet.start && hour < quiet.end)
        : (hour >= quiet.start || hour < quiet.end);
      if (inQuiet) return null;
    } else if ((this.proactiveRespectQuietHours || this.config?.proactiveRespectQuietHours === true) && this.notifier?.isQuietHours?.(new Date(started))) {
      return null;
    }

    const notifyPrefs = this.store.preferences();
    const openActionable = this.store.openQuestions().filter((q) => {
      if (!q || q.status !== "open" || q.kind === "completed") return false;
      if (this.awaitingReview.has(q.id)) return false;
      if (isSuppressedByQuietCadence(q, notifyPrefs)) return false;
      const keys = q.threadKeys ?? (q.threadKey ? [q.threadKey] : []);
      if (keys.length && keys.every((key) => this.store.mutedUntil(key))) return false;
      return true;
    });

    // Delta-only outreach: already-surfaced unanswered items stay visible in Needs You
    // without ever being re-pushed due to elapsed scans, aggregate count changes,
    // reordering, or question ID churn. Only genuinely new or materially changed
    // actionable decisions emit a delta message.
    const { deltas } = this.store.diffSurfacedDecisions(openActionable, { now: started });
    if (!deltas.length) return { posted: false, reason: "no-delta" };

    const shownDeltas = deltas.slice(0, 5);
    const overflowCount = Math.max(0, deltas.length - shownDeltas.length);
    const lines = [
      deltas.length === 1
        ? (deltas[0].change === "updated"
            ? "**Updated decision needing you:**"
            : "**New decision needing you:**")
        : `**${deltas.length} new/updated decisions needing you:**`
    ];
    for (const { question: q, change } of shownDeltas) {
      const badge = change === "updated" ? "[Updated] " : (deltas.length > 1 ? "[New] " : "");
      const opts = (q.options ?? []).filter((o) => o !== "dismiss").slice(0, 3).join(" / ");
      const contextLine = clampText(redactSecrets(q.reviewBrief?.decision || q.body || ""), 180);
      lines.push(
        `- ${badge}\`${q.id}\` — **${clampText(q.title, 120)}**${opts ? ` *(${opts})*` : ""}${contextLine ? `\n  ${contextLine}` : ""}`
      );
    }
    if (overflowCount > 0) {
      lines.push(`- *(+${overflowCount} more new in Needs You)*`);
    }

    const canonicalPairs = deltas
      .map((d) => [d.decisionKey, d.materialHash])
      .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    const deltaSig = shortHash(JSON.stringify(canonicalPairs));
    const messageId = `msg_sup_delta_${deltaSig}`;

    const res = await this.postSupervisorChatUpdate(lines.join("\n"), {
      dedupeKey: `delta:${deltaSig}`,
      messageId,
      minGapMs: 24 * 60 * MIN,
      metadata: {
        kind: "proactive_supervisor_delta",
        deltaCount: deltas.length,
        decisionKeys: deltas.map((d) => d.decisionKey)
      }
    });
    if (res?.posted) {
      this.store.commitSurfacedDecisions(deltas, { now: started });
    }
    return res;
  }

  // One thread, expanded for the owner: the agent's last message and when,
  // the owner's last word, its PR, what it waits on, the supervisor's next
  // step and why, its open questions, and what opens its chat. Built from
  // the last scan's row (kept across a restart), with this process's own
  // read of the chat when it has one. null: not in the last scan.
  recordDiscoveredThread(thread) {
    if (!thread?.key) return thread;
    const prev = this.knownThreads.get(thread.key) ?? this.lastThreads.get(thread.key) ?? null;
    const archived = typeof thread.archived === "boolean"
      ? thread.archived
      : Boolean(thread.state === "archived" || prev?.archived);
    if (!prev) {
      const normalized = typeof thread.archived === "boolean" ? thread : { ...thread, archived };
      setBounded(this.knownThreads, thread.key, normalized);
      return normalized;
    }
    const mergedPrRefs = [...new Set([...(thread.prRefs ?? []), ...(prev.prRefs ?? [])])];
    const merged = {
      ...prev,
      ...thread,
      archived,
      excluded: prev?.excluded === "self" ? "self" : (thread.excluded ?? prev?.excluded ?? null),
      repo: thread.repo ?? prev.repo ?? null,
      branch: thread.branch ?? prev.branch ?? null,
      prRefs: mergedPrRefs,
      lastAgentText: thread.lastAgentText || prev.lastAgentText || "",
      lastAgentFull: thread.lastAgentFull || prev.lastAgentFull || "",
      meta: {
        ...(prev.meta ?? {}),
        ...(thread.meta ?? {}),
        aliases: [...new Set([...(prev.meta?.aliases ?? []), ...(thread.meta?.aliases ?? [])])],
        conversation: (thread.meta?.conversation?.length ? thread.meta.conversation : prev.meta?.conversation) ?? []
      }
    };
    setBounded(this.knownThreads, thread.key, merged);
    // Live inventory refreshes can arrive through listWorkspaces while the
    // previous tick's snapshot is still in lastThreads. Keep both caches in
    // sync so the next digest does not let the stale tick overwrite fresh
    // running/idle state.
    if (this.lastThreads.has(thread.key)) setBounded(this.lastThreads, thread.key, merged);
    return merged;
  }

  async searchThreads(options = {}) {
    const tmpRoot = os.tmpdir();
    const inTempTestDir = Boolean(this.dataDir && path.resolve(this.dataDir).startsWith(path.resolve(tmpRoot) + path.sep));
    const useDisk = options?.includeDisk === true || (options?.includeDisk !== false && (!inTempTestDir || Boolean(options?.homeDir)));
    let threads = new Map([...this.knownThreads, ...this.lastThreads]);
    if (useDisk && typeof options?.query === "string" && options.query.trim()) {
      const archives = await collectArchiveThreads({
        query: options.query,
        homeDir: options.homeDir ?? os.homedir(),
        includeRemotePaseoHosts: options.includeRemotePaseoHosts ?? Boolean(this.config?.paseo?.enabled)
      });
      for (const arch of archives.values()) {
        this.recordDiscoveredThread(arch);
      }
      threads = mergeThreadsWithArchives(threads, archives);
    }
    return searchFleet(this.getState(), { natural: true, ...options }, threads);
  }

  async listWorkspaces(options = {}) {
    return listWorkspaces(this, { ...options, factory: options.factory ?? this.deps.paseoFactory });
  }

  async readChatTranscript(options = {}) {
    return readChatTranscript(this, { ...options, factory: options.factory ?? this.deps.paseoFactory });
  }

  async inspectRepoStatus(options = {}) {
    return inspectRepoStatus(this, { ...options, factory: options.factory ?? this.deps.paseoFactory });
  }

  async paseoSessionSettings(threadKey, options = {}) {
    const target = parsePaseoSettingsTarget(threadKey);
    if (!target) return { ok: false, status: "wrong-target", detail: "Choose one exact Paseo session." };
    return readPaseoSessionSettings(this.config, {
      ...target,
      factory: options.factory ?? this.deps.paseoFactory
    });
  }

  async updatePaseoSessionSettings(threadKey, body = {}, options = {}) {
    const target = parsePaseoSettingsTarget(threadKey);
    if (!target) return { ok: false, status: "wrong-target", detail: "Choose one exact Paseo session." };
    return applyPaseoSessionSettings(this.config, {
      ...target,
      body,
      factory: options.factory ?? this.deps.paseoFactory
    });
  }

  async startPaseoSession(options = {}) {
    return startPaseoSession(this, { ...options, factory: options.factory ?? this.deps.paseoFactory });
  }

  async claimTask({
    taskId = null,
    title = null,
    description = "",
    workspace = null,
    cwd = null,
    serverId = null,
    provider = null,
    model = null,
    effort = null,
    prompt = null,
    project = null,
    subchannel = null,
    labels = null,
    dependsOn = null,
    priority = 70,
    checkInMinutes = null,
    images = null
  } = {}) {
    const taskStore = this.runtime?.tasks;
    if (!taskStore) throw new Error("Task store is not available.");

    let task = taskId ? taskStore.get(taskId) : null;
    if (taskId && !task) throw new Error("No task with that id.");
    const cleanTitle = String(title ?? task?.title ?? "").trim();
    if (!cleanTitle || cleanTitle.length > 300) {
      throw new Error("Task title must be 1-300 characters.");
    }

    if (!task) {
      task = taskStore.add({
        title: cleanTitle,
        description: String(description ?? "").trim(),
        bucket: "today",
        priority,
        ...(Array.isArray(dependsOn) ? { dependsOn } : {}),
        ...(labels ? { labels } : {}),
        project: project || workspace || null,
        subchannel: subchannel || null
      }, { source: "supervisor", queue: "agent" });
    } else if (task.queue !== "agent" && typeof taskStore.setQueue === "function") {
      task = taskStore.setQueue(task.id, "agent") ?? task;
    }

    const sessionPrompt = String(prompt ?? "").trim()
      || (task.description ? `${task.title}\n\n${task.description}` : task.title);
    const session = await this.startPaseoSession({
      workspace: workspace || project || task.sourceMeta?.project || null,
      cwd: cwd || null,
      serverId: serverId || null,
      title: task.title,
      provider: provider || null,
      model: model || null,
      effort: effort || null,
      ...(images ? { images } : {}),
      prompt: sessionPrompt.slice(0, 4000)
    });

    const nowMs = this.now();
    const leaseMs = Number(taskStore.leaseMs) > 0 ? Number(taskStore.leaseMs) : 30 * MIN;
    const expectedCheckInMin = Number.isFinite(Number(checkInMinutes)) && Number(checkInMinutes) > 0
      ? Math.min(720, Math.max(5, Math.round(Number(checkInMinutes))))
      : 25;
    const prevAttempts = Number(task.sourceMeta?.agentLease?.attempts ?? 0);
    const attempts = Number.isFinite(prevAttempts) ? prevAttempts + 1 : 1;
    const actor = [session.provider || provider, session.model || model]
      .filter((v) => typeof v === "string" && v.trim())
      .join(" · ")
      || "paseo";
    const resolvedProject = project || session.workspace || deriveCardProject({ workspace: session.workspace }, { cwd: session.cwd });

    const updatedTask = taskStore.update(task.id, {
      status: "in_progress",
      ...(labels ? { labels } : {}),
      sourceMeta: {
        ...(task.sourceMeta ?? {}),
        threadKey: session.key,
        project: resolvedProject || null,
        subchannel: subchannel || task.sourceMeta?.subchannel || null,
        actor,
        checkInMinutes: expectedCheckInMin,
        watchdog: {
          expectedMinutes: expectedCheckInMin,
          checkInDueAt: new Date(nowMs + expectedCheckInMin * MIN).toISOString(),
          status: "on_track"
        },
        agentLease: {
          claimedAt: new Date(nowMs).toISOString(),
          expiresAt: new Date(nowMs + leaseMs).toISOString(),
          attempts
        }
      }
    }) ?? task;

    this.store?.recordAction?.({
      kind: "task-claim",
      playbook: "board-claim-task",
      threadKey: session.key,
      taskId: updatedTask.id,
      route: "paseo-create",
      status: "sent",
      by: "owner",
      reason: clampText(`Claimed task "${updatedTask.title}" in ${session.workspace || session.cwd || "Paseo"}`, 240)
    });
    this.emitFleet("task-claimed");
    return { task: updatedTask, session };
  }

  async batchActCards(options = {}) {
    return batchActCards(this, options);
  }

  async getHierarchy(options = {}) {
    return buildFleetHierarchy(this, { ...options, factory: options.factory ?? this.deps.paseoFactory });
  }

  getOrganization() {
    return this.store.organization();
  }

  upsertProject({ name, theme = null, alias = null } = {}) {
    const project = this.store.upsertProject({ name, theme });
    if (typeof alias === "string" && alias.trim()) {
      this.store.setProjectAlias(alias, project.name);
    }
    this.emitFleet("organization-updated");
    return { project, organization: this.store.organization() };
  }

  deleteProject(projectIdOrName) {
    const deleted = this.store.deleteProject(projectIdOrName);
    if (deleted) this.emitFleet("organization-updated");
    return { deleted, organization: this.store.organization() };
  }

  organizeThread(threadKey, { project = null, theme = null } = {}) {
    const assignment = this.store.assignThread(threadKey, { project, theme });
    this.emitFleet("organization-updated");
    return { assignment, organization: this.store.organization() };
  }

  async archiveThread(threadKey, { confirmed = false } = {}) {
    if (confirmed !== true) {
      return { ok: false, status: "confirmation_required", detail: "Confirm archiving this coding chat first." };
    }
    const parsed = parsePaseoThreadKey(threadKey);
    if (!parsed) {
      return { ok: false, status: "blocked", detail: "Only Paseo coding chats support direct session archiving." };
    }
    this.store.markCompletionReviewed(threadKey, this.now());
    let archRes;
    try {
      archRes = await archivePaseoAgent(this.config, parsed.serverId, parsed.agentId, this.deps.paseoFactory);
    } catch {
      return { ok: false, status: "blocked", detail: "Could not reach Paseo host to archive coding chat." };
    }
    if (!archRes?.ok) {
      return { ok: false, status: "blocked", detail: archRes?.detail || "Could not archive coding chat in Paseo." };
    }
    const prev = this.knownThreads.get(threadKey) ?? this.lastThreads.get(threadKey) ?? null;
    if (prev) this.recordDiscoveredThread({ ...prev, archived: true });
    for (const q of this.store.openQuestions()) {
      if (q.threadKey === threadKey) {
        this.store.resolveQuestion(q.id, "session archived by owner");
        this.resolveOutreach(q, "archived", "acted");
      }
    }
    this.emitFleet("thread-archived");
    return { ok: true, status: "archived_session", threadKey, detail: "Archived coding chat in Paseo." };
  }

  async unarchiveThread(threadKey) {
    const parsed = parsePaseoThreadKey(threadKey);
    if (!parsed) {
      return { ok: false, status: "blocked", detail: "Only Paseo coding chats support restoring archived sessions." };
    }
    let restoreRes;
    try {
      restoreRes = await unarchivePaseoAgent(this.config, parsed.serverId, parsed.agentId, this.deps.paseoFactory);
    } catch {
      return { ok: false, status: "blocked", detail: "Could not reach Paseo host to restore coding chat." };
    }
    if (!restoreRes?.ok) {
      return { ok: false, status: "blocked", detail: restoreRes?.detail || "Could not restore coding chat in Paseo." };
    }
    const prev = this.knownThreads.get(threadKey) ?? this.lastThreads.get(threadKey) ?? null;
    if (prev) this.recordDiscoveredThread({ ...prev, archived: false });
    this.emitFleet("thread-unarchived");
    return { ok: true, status: "unarchived_session", threadKey, detail: restoreRes.detail || "Restored coding chat in Paseo." };
  }

  async syncThemes(options = {}) {
    return syncThemesToPaseoLabels(this, { ...options, factory: options.factory ?? this.deps.paseoFactory });
  }

  async dispatchGoal(options = {}) {
    return dispatchManagerGoal(this, {
      ...options,
      factory: options.factory ?? this.deps.paseoFactory,
      decisionsFetch: options.decisionsFetch ?? this.deps.decisionsFetch ?? this.deps.fetchImpl
    });
  }

  get precedentMemory() {
    if (!this._precedentMemory) {
      this._precedentMemory = new OwnerPrecedentStore({
        dir: this.store.dir,
        now: () => this.now()
      });
      try {
        this._precedentMemory.backfillFromFleetStore(this.store);
      } catch { /* best-effort historical backfill */ }
    }
    return this._precedentMemory;
  }

  get activeWork() {
    this._activeWork ??= new ActiveWorkManager({
      dir: this.store.dir,
      store: this.store,
      runtime: this.runtime,
      supervisor: this,
      config: this.config,
      deps: this.deps,
      now: () => this.now()
    });
    return this._activeWork;
  }

  getActiveWork(options = {}) {
    return this.activeWork.getActiveWork(options);
  }

  trackWork(input = {}) {
    const result = this.activeWork.trackWork(input);
    this.emitFleet("active-work-updated");
    return result;
  }

  async verifyGoalProgress(input = {}) {
    const result = await this.activeWork.verifyGoalProgress(input);
    this.emitFleet("active-work-updated");
    return result;
  }

  async switchPaseoProvider(threadKey, { preferredProviders = ["claude", "antigravity"], reason = null } = {}) {
    const cleanKey = typeof threadKey === "string" ? threadKey.trim() : "";
    const parsed = parsePaseoThreadKey(cleanKey);
    if (!parsed) {
      return { ok: false, status: "unsupported", detail: "Only Paseo coding sessions (`paseo:<serverId>.<agentId>`) support automatic provider failover." };
    }
    const matchingOpen = this.store.openQuestions().find((q) => q.threadKey === cleanKey || (q.threadKeys ?? []).includes(cleanKey)) ?? null;
    const thread = this.lastThreads.get(cleanKey)
      ?? this.knownThreads.get(cleanKey)
      ?? this.syntheticPaseoThread(cleanKey, matchingOpen);
    if (!thread) {
      return { ok: false, status: "not_found", detail: "No Paseo session found with that key." };
    }
    const goalContext = this.activeWork.findActiveGoalForThread(cleanKey, thread.prRefs?.[0] ?? null);
    const failoverReason = String(reason || thread.error?.text || "provider usage limit reached").trim();
    let switched;
    try {
      switched = await failoverPaseoSessionProvider({
        config: this.config,
        thread,
        reason: failoverReason,
        goalContext,
        preferredProviders: Array.isArray(preferredProviders) && preferredProviders.length
          ? preferredProviders
          : ["claude", "antigravity"],
        factory: this.deps.paseoFactory,
        permissionMode: this.store.preferences()?.defaultPermissionMode ?? "bypass"
      });
    } catch (err) {
      return { ok: false, status: "failed", detail: clampText(err?.message ?? "Provider failover failed.", 220) };
    }
    if (!switched?.ok || !switched.newKey) {
      return { ok: false, status: "blocked", detail: switched?.detail ?? "No healthy alternate Paseo provider available." };
    }

    const prevAssign = this.store.threadAssignment?.(cleanKey) ?? null;
    if (prevAssign) {
      this.store.assignThread(switched.newKey, prevAssign);
    }
    const reassignedGoalIds = this.activeWork.reassignSessionOwner(cleanKey, switched.newKey, {
      label: switched.title || thread.title || null,
      note: `Switched from ${switched.exhaustedProvider} to ${switched.provider}`
    });

    const resetMs = Date.parse(thread.error?.resetAt ?? "");
    const nowMs = this.now();
    const muteHours = Number.isFinite(resetMs) && resetMs > nowMs
      ? Math.min(72, Math.max(1, Math.ceil((resetMs - nowMs) / (60 * MIN))))
      : 12;
    this.store.markCompletionReviewed(cleanKey, nowMs);
    this.store.mute(cleanKey, nowMs + muteHours * 60 * MIN);
    this.store.recordProviderFailover(cleanKey, { newKey: switched.newKey, failureSig: failoverSignature(thread) });

    for (const q of this.store.openQuestions()) {
      const coversSingle = q.threadKey === cleanKey
        || (Array.isArray(q.threadKeys) && q.threadKeys.length === 1 && q.threadKeys[0] === cleanKey);
      if (coversSingle && ["limit", "session-error", "stuck"].includes(q.kind)) {
        this.store.resolveQuestion(q.id, `provider failover continued in ${switched.newKey} (${switched.provider})`);
        this.resolveOutreach(q, "failover", "acted");
      }
    }

    const action = this.store.recordAction({
      kind: "nudge",
      playbook: "provider-failover",
      threadKey: switched.newKey,
      route: "paseo-create",
      status: "sent",
      reason: clampText(`Switched "${switched.title || cleanKey}" from ${switched.exhaustedProvider} to ${switched.provider} (${failoverReason})`, 240),
      detail: `Continued from ${cleanKey} in ${switched.newKey}`
    });
    this.emitFleet("provider-failover");
    return {
      ok: true,
      status: "switched",
      ...switched,
      reassignedGoalIds,
      actionId: action?.id ?? null,
      detail: `Switched from ${switched.exhaustedProvider} to ${switched.provider} in ${switched.newKey}.`
    };
  }

  async scanActiveWork(options = {}) {
    const pass = await this.activeWork.scanInventory(options);
    this.emitFleet("active-work-scanned");
    return pass;
  }

  async actActiveWork(id, input = {}, sendOptions = {}) {
    const result = await this.activeWork.actOnWork(id, input, sendOptions);
    if (result?.ok) this.emitFleet("active-work-acted");
    return result;
  }

  // Lightweight, event-driven reconciliation of ONLY open questions' watched
  // threads (never scans the full fleet, never spawns codex exec). Uses fast
  // Paseo tail reads + /v1/decisions (gpt-6-luna, output_tokens: 0) when a
  // watched thread has new activity since the question was raised.
  async reconcileOpenQuestions({ force = false, factory = null, decisionsFetch = null } = {}) {
    const now = this.now();
    this.questionRelevanceCache ??= new Map();
    if (!force && this.lastReconcileAt && now - this.lastReconcileAt < 8_000) {
      return { checked: 0, closed: [], skippedThrottle: true };
    }
    this.lastReconcileAt = now;

    const open = this.store.openQuestions().filter((q) => q?.threadKey && !q.pinned && !SELF_FINDING_KINDS.has(q.kind));
    if (open.length === 0) return { checked: 0, closed: [] };

    const paseoKeys = [...new Set(open.map((q) => q.threadKey).filter((k) => String(k).startsWith("paseo:")))];
    const freshByKey = new Map();
    const resolvedFactory = factory ?? this.deps.paseoFactory;

    if (paseoKeys.length > 0 && this.config?.paseo?.enabled) {
      try {
        const probeCfg = {
          ...this.config,
          paseo: { ...this.config.paseo, timeoutMs: Math.min(this.config.paseo.timeoutMs ?? 6_000, 6_000) }
        };
        await withPaseo(probeCfg, async (client, signal) => {
          const directory = await client.hosts.list();
          const apiBySrv = new Map();
          const getApi = (sid) => {
            if (!apiBySrv.has(sid)) apiBySrv.set(sid, hostApi(client, sid, directory));
            return apiBySrv.get(sid);
          };
          await Promise.all(paseoKeys.slice(0, 12).map(async (tKey) => {
            const parsed = parsePaseoThreadKey(tKey);
            if (!parsed) return;
            try {
              const api = await getApi(parsed.serverId);
              const ref = api.agents.ref(parsed.agentId);
              const hist = await ref.timeline.refetch({ direction: "tail", limit: 8 });
              signal.throwIfAborted();
              const agent = hist?.agent ?? ref.current();
              if (!agent) return;
              const fresh = paseoThread(agent, parsed.serverId, Array.isArray(hist?.entries) ? hist.entries : [], true);
              this.recordDiscoveredThread(fresh);
              freshByKey.set(tKey, { agent, thread: fresh });
            } catch { /* ignore single unreachable host/thread */ }
          }));
        }, resolvedFactory);
      } catch { /* Paseo unavailable: fall back to in-memory knownThreads */ }
    }

    const closed = [];
    const candidatesForDecisions = [];

    for (const q of open) {
      const liveEntry = freshByKey.get(q.threadKey);
      const thread = liveEntry?.thread ?? this.lastThreads.get(q.threadKey) ?? this.knownThreads.get(q.threadKey) ?? null;
      if (!thread) continue;

      const askedAtMs = Date.parse(q.agentAskedAt ?? q.createdAt ?? "") || 0;
      const ownerAtMs = Date.parse(thread.lastUserAt ?? "") || 0;
      const agentAtMs = Date.parse(thread.lastAgentAt ?? "") || 0;
      const ownerDirect = !String(thread.lastUserText ?? "").startsWith(SUPERVISOR_PREFIX);

      // 1. Archived session: close immediately.
      if (thread.archived || liveEntry?.agent?.archivedAt) {
        const reason = "session archived";
        this.store.resolveQuestion(q.id, reason);
        this.resolveOutreach(q, "resolved", "dismissed");
        closed.push({ id: q.id, reason });
        continue;
      }

      // 2. Permission / agent-card cleared in Paseo: close immediately.
      if (liveEntry?.agent && (q.kind === "prompt" || q.kind === "agent-card")) {
        const perms = Array.isArray(liveEntry.agent.pendingPermissions) ? liveEntry.agent.pendingPermissions : [];
        const hasPendingCard = Boolean(thread.meta?.pendingCard);
        if (q.kind === "prompt" && perms.length === 0) {
          const reason = "permission prompt already resolved in Paseo";
          this.store.resolveQuestion(q.id, reason);
          this.resolveOutreach(q, "resolved", "dismissed");
          closed.push({ id: q.id, reason });
          continue;
        }
        if (q.kind === "agent-card" && !hasPendingCard && perms.length === 0) {
          const reason = "question card already answered in Paseo";
          this.store.resolveQuestion(q.id, reason);
          this.resolveOutreach(q, "resolved", "dismissed");
          closed.push({ id: q.id, reason });
          continue;
        }
      }

      // 3. Owner directly followed up in chat after the ask and the agent is now actively working on it.
      if (q.kind === "agent-ask" && ownerDirect && askedAtMs > 0 && ownerAtMs > askedAtMs && thread.agentStatus === "running") {
        const reason = "owner followed up directly in chat";
        this.store.resolveQuestion(q.id, reason);
        this.resolveOutreach(q, "resolved", "dismissed");
        closed.push({ id: q.id, reason });
        continue;
      }

      // 4. Thread updated since the ask (owner or agent spoke after askedAt): check semantic relevance via /v1/decisions (gpt-6-luna).
      const hasNewActivity = askedAtMs > 0 && (ownerAtMs > askedAtMs || agentAtMs > askedAtMs);
      if (!hasNewActivity || q.kind === "ready") continue;

      const mark = `${activityMark(thread)}|${q.title ?? ""}|${q.body ?? ""}`;
      if (this.questionRelevanceCache.get(q.id) === mark) continue;

      candidatesForDecisions.push({
        id: q.id,
        question: q,
        mark,
        kind: q.kind,
        askedAt: q.agentAskedAt ?? q.createdAt ?? null,
        title: q.title ?? "",
        body: q.body ?? "",
        threadStatus: thread.agentStatus ?? "idle",
        lastOwnerAt: ownerDirect ? (thread.lastUserAt ?? null) : null,
        lastOwnerText: ownerDirect ? (thread.lastUserText ?? "") : "",
        lastAgentAt: thread.lastAgentAt ?? null,
        lastAgentText: thread.lastAgentFull || thread.lastAgentTail || thread.lastAgentText || "",
        recentMessages: thread.meta?.conversation ?? []
      });
    }

    const decisionsCfg = this.config?.decisions ?? {};
    if (candidatesForDecisions.length > 0 && decisionsCfg.enabled && decisionsCfg.apiKey) {
      const evalRes = await evaluateQuestionsRelevanceWithDecisions({
        items: candidatesForDecisions,
        apiKey: decisionsCfg.apiKey,
        url: decisionsCfg.url || DEFAULT_DECISIONS_URL,
        model: decisionsCfg.model || DEFAULT_DECISIONS_MODEL,
        timeoutMs: Math.min(decisionsCfg.timeoutMs || DEFAULT_DECISIONS_TIMEOUT_MS, 5_000),
        fetchImpl: decisionsFetch ?? this.deps.decisionsFetch ?? this.deps.fetchImpl ?? globalThis.fetch
      });
      if (evalRes.ok) {
        for (const cand of candidatesForDecisions) {
          this.questionRelevanceCache.set(cand.id, cand.mark);
          const pRelevant = evalRes.scores.get(cand.id);
          if (typeof pRelevant === "number" && pRelevant < 0.38) {
            const reason = `auto-closed stale question (p=${pRelevant.toFixed(2)}): thread moved on`;
            this.store.resolveQuestion(cand.id, reason);
            this.resolveOutreach(cand.question, "resolved", "dismissed");
            this.store.recordAction({
              kind: "review",
              playbook: "decisions-reconcile",
              threadKey: cand.question.threadKey,
              questionId: cand.id,
              status: "done",
              reason: clampText(`${reason}: ${cand.title}`, 220)
            });
            closed.push({ id: cand.id, reason, probability: pRelevant });
          }
        }
      }
    }

    if (closed.length > 0) {
      this.emitFleet("questions-reconciled");
    }
    return { checked: open.length, closed };
  }

  updatePreferences(patch = {}) {
    const prev = this.store.preferences();
    const next = applyPreferencePatch(prev, patch, { now: this.now() });
    this.store.savePreferences(next);
    if (next.cadence === "quiet_until_ready") {
      for (const q of this.store.openQuestions()) {
        if (q.outreachId && isSuppressedByQuietCadence(q, next)) {
          this.resolveOutreach(q, "resolved", "dismissed");
        }
      }
    } else if (prev.cadence === "quiet_until_ready") {
      for (const q of this.store.openQuestions()) {
        if (q.outreachId && !isSuppressedByQuietCadence(q, next)) {
          this.reopenOutreach(q);
        }
      }
    }
    this.store.recordAction({
      kind: "preference",
      playbook: "owner-preference",
      threadKey: null,
      status: "done",
      by: "owner",
      reason: clampText(`owner updated preferences: ${patch?.choice || JSON.stringify(Object.keys(patch ?? {}))}`, 200)
    });
    this.emitFleet("preferences-updated");
    return this.getState().preferences;
  }

  async routeIssue({ text, confirmTarget = null, autoSend = false, deadlineAt = null } = {}) {
    if (confirmTarget) {
      const cleanKey = String(confirmTarget).trim();
      const message = String(text ?? "").trim();
      const sent = await this.sendOwnerMessage(cleanKey, message, { deadlineAt });
      this.emitFleet("issue-routed");
      return {
        action: "dispatched",
        dispatched: sent?.delivery?.status === "sent",
        targetKey: cleanKey,
        delivery: sent?.delivery ?? null
      };
    }
    const tmpRoot = os.tmpdir();
    const inTempTestDir = Boolean(this.dataDir && path.resolve(this.dataDir).startsWith(path.resolve(tmpRoot) + path.sep));
    const archives = !inTempTestDir
      ? await collectArchiveThreads({ query: String(text ?? "").slice(0, 300), includeRemotePaseoHosts: Boolean(this.config?.paseo?.enabled) })
      : new Map();
    const routed = await routeCustomerIssue({
      text,
      state: this.getState(),
      cachedThreads: mergeThreadsWithArchives(this.lastThreads, archives, { existingOnly: true }),
      runModel: this.deps.routeModel ?? null
    });
    if (autoSend === true && routed.action === "auto_dispatch" && routed.primary?.key) {
      const sent = await this.sendOwnerMessage(routed.primary.key, routed.suggestedMessage, { deadlineAt });
      this.emitFleet("issue-routed");
      return {
        ...routed,
        dispatched: sent?.delivery?.status === "sent",
        delivery: sent?.delivery ?? null
      };
    }
    return { ...routed, dispatched: false, delivery: null };
  }

  async actCard(cardId, { op = "primary", value = null, confirmed = false, clarification = null, instructions = null, images = null, deadlineAt = null } = {}) {
    const id = String(cardId ?? "").trim();
    if (!id) return null;

    if (op === "veto") {
      const preferences = this.updatePreferences({
        vetoActionId: typeof value === "string" && value.startsWith("auto_") ? value : null,
        vetoSlice: typeof value === "string" && !value.startsWith("auto_") ? value : (id.startsWith("pref:slice:") ? id.slice("pref:slice:".length) : null)
      });
      return { ok: true, kind: "veto", status: "reverted", detail: "Reverted automatic slice back to manual confirmation.", preferences };
    }

    if (id.startsWith("pref:") || op === "preference") {
      const prefCard = (this.getState().cards ?? []).find((c) => c.id === id) ?? null;
      const normOp = String(op ?? "primary").toLowerCase();
      const isDefer = normOp === "defer" || normOp === "dismiss";
      const actionObj = isDefer ? null : (normOp === "secondary" ? prefCard?.secondaryAction : prefCard?.primaryAction);
      const choice = typeof value === "string" && value
        ? value
        : (isDefer
            ? `keep:${id}`
            : (actionObj?.value ?? (normOp === "secondary" ? `keep:${id}` : id.replace(/^pref:/, ""))));
      const preferences = this.updatePreferences({ choice });
      return { ok: true, kind: "preference", status: "updated", detail: choice.startsWith("keep:") ? "Kept current default." : "Updated Supervisor preference.", preferences };
    }

    const currentState = this.getState();
    const card = (currentState.cards ?? []).find((c) => c.id === id || c.questionId === id) ?? null;
    const questionId = card?.questionId ?? id;
    const question = this.store.question(questionId);
    if (!question || question.status !== "open") return null;

    const normalizedOp = String(op ?? "primary").toLowerCase();
    const resolvedAction = normalizedOp === "secondary"
      ? card?.secondaryAction
      : normalizedOp === "primary"
        ? card?.primaryAction
        : (card?.extraActions ?? []).find((a) => a.op === normalizedOp && (value == null || a.value === value)) ?? null;
    const effectiveOp = normalizedOp === "primary" || normalizedOp === "secondary"
      ? (resolvedAction?.op ?? "answer")
      : normalizedOp;
    const effectiveValue = value ?? resolvedAction?.value ?? null;

    if (effectiveOp === "defer" || effectiveOp === "dismiss" || effectiveValue === "dismiss") {
      const dismissed = this.dismissQuestion(question.id);
      return { ok: Boolean(dismissed), kind: "defer", status: "dismissed", message: "Dismissed notification.", question: dismissed, delivery: null };
    }

    if (effectiveOp === "open_chat") {
      return {
        ok: true,
        kind: "open_chat",
        status: "open_chat",
        threadKey: card?.threadKey ?? question.threadKey ?? null,
        message: "Open conversation context."
      };
    }

    if (effectiveOp === "archive_session" || (effectiveOp === "answer" && String(effectiveValue ?? "").toLowerCase() === "archive")) {
      if (confirmed !== true) {
        return {
          ok: false,
          kind: "archive_session",
          status: "confirmation_required",
          message: "Confirm archiving this coding chat first. Tap Dismiss if you only want to clear the notification."
        };
      }
      const targetKey = card?.threadKey ?? question.threadKey ?? null;
      const archOutcome = await this.archiveThread(targetKey, { confirmed: true });
      if (!archOutcome.ok) {
        return {
          ok: false,
          kind: "archive_session",
          status: archOutcome.status ?? "blocked",
          message: archOutcome.detail ?? "Could not archive coding chat."
        };
      }
      if (this.store.question(question.id)?.status === "open") {
        this.store.resolveQuestion(question.id, "session archived by owner");
        this.resolveOutreach(question, "archived", "acted");
      }
      return {
        ok: true,
        kind: "archive_session",
        status: "archived_session",
        threadKey: targetKey,
        message: "Archived coding chat in Paseo.",
        delivery: { status: "sent", route: "paseo-archive", detail: "Archived coding chat in Paseo." }
      };
    }

    if (effectiveOp === "fix_ci") {
      const targetKey = card?.threadKey ?? question.threadKey ?? null;
      if (!targetKey) return { ok: false, kind: "fix_ci", status: "blocked", detail: "No coding session is linked to this PR." };
      const prLabel = card?.prRef ?? question.prRef ?? "the pull request";
      const fixPrompt = `Checks or mergeability failed on ${prLabel}. Please inspect the failing checks or rebase conflicts, fix them in scope, and push an updated commit.`;
      const sent = await this.sendOwnerMessage(targetKey, fixPrompt, { deadlineAt });
      this.emitFleet("card-fix-ci");
      return {
        ok: sent?.delivery?.status === "sent",
        kind: "fix_ci",
        status: sent?.delivery?.status ?? "blocked",
        detail: sent?.delivery?.detail ?? (sent?.delivery?.status === "sent" ? `Asked ${targetKey} to fix ${prLabel}.` : "Could not reach coding session."),
        delivery: sent?.delivery ?? null
      };
    }

    if (effectiveOp === "merge" || effectiveOp === "ship" || effectiveOp === "merge_and_deploy") {
      const prRef = card?.prRef ?? question.prRef ?? effectiveValue;
      const prefs = this.store.preferences();
      const mergeOutcome = await executeSafePrMerge({
        prRef,
        expectedHeadSha: card?.headSha ?? question.askedHead ?? null,
        mergePolicy: prefs.mergePolicy,
        ownerConfirmed: true,
        config: this.config,
        ghBin: this.config.bins?.gh ?? "gh",
        run: this.deps.run ?? runCommand
      });

      if (mergeOutcome.status === "merged" || mergeOutcome.status === "already_merged") {
        const markOption = (question.options ?? []).find((opt) => /^(?:merged|yes|done)$/i.test(opt)) ?? null;
        if (markOption) {
          this.store.answerQuestion(question.id, markOption);
        } else {
          this.store.resolveQuestion(question.id, `merged ${prRef}`);
        }
        this.resolveOutreach(question, "merged", "acted");
        this.store.recordAction({
          kind: "pr-merge",
          playbook: effectiveOp === "merge_and_deploy" ? "owner-merge-deploy" : "owner-merge",
          threadKey: question.threadKey ?? null,
          status: "done",
          by: "owner",
          reason: mergeOutcome.detail
        });
        let deployDelivery = null;
        if (effectiveOp === "merge_and_deploy") {
          const targetKey = card?.threadKey ?? question.threadKey ?? null;
          if (targetKey) {
            const deployPrompt = `Owner merged ${prRef}. Proceed with any post-merge deployment and live smoke verification in scope, and report back once healthy.`;
            const sent = await this.sendOwnerMessage(targetKey, deployPrompt, { deadlineAt });
            deployDelivery = sent?.delivery ?? null;
          }
        }
        this.emitFleet(effectiveOp === "merge_and_deploy" ? "pr-merged-deploy" : "pr-merged");
        const detail = deployDelivery?.status === "sent"
          ? `${mergeOutcome.detail} Notified coding session to run post-merge deploy & verification.`
          : deployDelivery
            ? `${mergeOutcome.detail} (Post-merge session ping blocked: ${deployDelivery.detail ?? "check chat"}.)`
            : mergeOutcome.detail;
        return { ok: true, kind: effectiveOp === "merge_and_deploy" ? "merge_and_deploy" : "merge", ...mergeOutcome, detail, ...(deployDelivery ? { deployDelivery } : {}) };
      }

      if (mergeOutcome.status === "watching_ci") {
        if (mergeOutcome.promptPreference) {
          this.store.savePreferences(recordPreferenceSignal(prefs, { type: "ci_merge_attempt", prRef, now: this.now() }));
        }
        this.dismissQuestion(question.id);
        this.store.recordAction({
          kind: "pr-watch",
          playbook: "owner-merge-watch",
          threadKey: question.threadKey ?? null,
          status: "done",
          by: "owner",
          reason: mergeOutcome.detail
        });
        this.emitFleet("pr-watching-ci");
        return { ok: true, kind: "merge", ...mergeOutcome };
      }

      if (mergeOutcome.status === "queued_when_green") {
        this.dismissQuestion(question.id);
        this.store.recordAction({
          kind: "pr-merge-queued",
          playbook: "owner-merge",
          threadKey: question.threadKey ?? null,
          status: "done",
          by: "owner",
          reason: mergeOutcome.detail
        });
        this.emitFleet("pr-merge-queued");
        return { ok: true, kind: "merge", ...mergeOutcome };
      }

      this.store.recordAction({
        kind: "pr-merge",
        playbook: "owner-merge",
        threadKey: question.threadKey ?? null,
        status: "blocked",
        by: "owner",
        reason: mergeOutcome.detail
      });
      this.emitFleet("pr-merge-halted");
      return { ok: false, kind: "merge", ...mergeOutcome };
    }

    if (question.kind === "self-fix" && effectiveValue === "Request changes" && typeof instructions === "string" && instructions.trim()) {
      const fix = await this.reviseFix(question.meta?.fixId, instructions);
      this.emitFleet("self-fix-revised");
      return fix
        ? { ok: true, kind: "answer", status: "sent", fix, delivery: { status: "sent", detail: "Changes sent to fixer." } }
        : { ok: false, kind: "answer", status: "blocked", detail: "No fix with that id." };
    }

    if (effectiveOp === "reply") {
      const hasImages = Array.isArray(images) && images.length > 0;
      const replyText = String(effectiveValue ?? "").trim() || (hasImages ? "Please inspect the attached image(s)." : "");
      if (!replyText) return { ok: false, kind: "reply", status: "blocked", detail: "Enter a reply to send." };
      if (question.kind === "suggestion" && (question.options ?? []).includes("Answer question")) {
        const result = await this.answerQuestion(question.id, "Answer question", {
          deadlineAt,
          clarification: replyText.slice(0, 2000)
        });
        if (!result) return { ok: false, kind: "reply", status: "closed", detail: "Question already closed." };
        return {
          ok: true,
          kind: "reply",
          status: "done",
          detail: "Clarification saved on suggestion plan.",
          ...result
        };
      }
      if (!hasImages && canReplyTo(question)) {
        const replied = await this.replyQuestion(question.id, replyText, { deadlineAt });
        if (!replied) return { ok: false, kind: "reply", status: "closed", detail: "Question already closed." };
        return {
          ok: !replied.delivery || ["sent", "queued"].includes(replied.delivery.status),
          kind: "reply",
          status: replied.delivery?.status ?? "done",
          detail: replied.delivery?.detail ?? "Delivered reply to coding session.",
          ...replied
        };
      }
      const targetKey = card?.threadKey ?? question.threadKey ?? null;
      if (!targetKey) return { ok: false, kind: "reply", status: "blocked", detail: "No coding session is linked to this card." };
      const sent = await this.sendOwnerMessage(targetKey, replyText, { deadlineAt, ...(hasImages ? { images } : {}) });
      const deliveredOk = sent?.delivery?.status === "sent";
      if (deliveredOk) {
        this.store.answerQuestion(question.id, replyText);
        this.resolveOutreach(question, "reply", "acted");
        this.emitFleet("card-replied");
      }
      return {
        ok: deliveredOk,
        kind: "reply",
        status: sent?.delivery?.status ?? "blocked",
        detail: sent?.delivery?.detail ?? (deliveredOk ? "Delivered reply to coding session." : "Could not deliver reply."),
        delivery: sent?.delivery ?? null
      };
    }

    const answerOption = effectiveValue ?? (question.options ?? []).find((opt) => opt !== "dismiss") ?? null;
    if (!answerOption) return { ok: false, kind: "answer", status: "blocked", detail: "No answer option available." };
    const result = await this.answerQuestion(question.id, answerOption, { deadlineAt, clarification });
    if (!result) return { ok: false, kind: "answer", status: "closed", detail: "Question already closed." };
    return {
      ok: !result.delivery || ["sent", "queued"].includes(result.delivery.status),
      kind: "answer",
      status: result.delivery?.status ?? "done",
      detail: result.delivery?.detail ?? null,
      ...result
    };
  }

  async threadConversation(threadKey) {
    const state = this.getState();
    const matchingQ = state.questions.find((q) => q.threadKey === threadKey || (q.threadKeys ?? []).includes(threadKey)) ?? null;
    const thread = this.lastThreads.get(threadKey)
      ?? this.knownThreads.get(threadKey)
      ?? state.snapshot?.threads?.find((row) => row.key === threadKey)
      ?? this.knownRows.get(threadKey)
      ?? (matchingQ ? this.syntheticPaseoThread(threadKey, matchingQ) ?? {
        key: threadKey,
        kind: String(threadKey ?? "").split(":")[0] || "unknown",
        id: String(threadKey ?? "").split(":").slice(1).join(":"),
        lastUserText: matchingQ.contextSnapshot?.lastUserText ?? "",
        lastUserAt: matchingQ.contextSnapshot?.lastUserAt ?? null,
        lastAgentFull: matchingQ.contextSnapshot?.agentSummary ?? matchingQ.askContext ?? "",
        lastAgentAt: matchingQ.contextSnapshot?.lastAgentAt ?? matchingQ.askedAt ?? null,
        meta: {
          paseoCwd: matchingQ.contextSnapshot?.paseoCwd ?? null,
          aliases: matchingQ.contextSnapshot?.aliases ?? [],
          conversation: matchingQ.contextSnapshot?.recentMessages ?? []
        }
      } : null);
    if (!thread) return null;
    const row = state.snapshot?.threads?.find((r) => r?.key === threadKey) ?? this.knownRows.get(threadKey) ?? null;
    const assistantActor = deriveActorLabel(row, thread);
    const annotate = (conv) => {
      if (!conv || !Array.isArray(conv.messages)) return conv;
      const cleaned = dedupeConsecutiveMessages(conv.messages);
      return {
        ...conv,
        messages: cleaned.map((m) => ({
          ...m,
          text: stripAgentInternalMarkup(m.text),
          actor: m.actor ?? (m.role === "assistant" ? assistantActor : (String(m.text ?? "").startsWith(SUPERVISOR_PREFIX) ? "Supervisor" : "You"))
        }))
      };
    };
    try { return annotate(await readThreadConversation(thread, this.config)); }
    catch { return annotate(unavailableConversation(thread)); }
  }

  threadDetail(threadKey) {
    const state = this.getState();
    const thread = this.lastThreads.get(threadKey) ?? this.knownThreads.get(threadKey) ?? null;
    const matchingQuestions = state.questions.filter((question) => question.threadKey === threadKey || (question.threadKeys ?? []).includes(threadKey));
    const snap = matchingQuestions[0]?.contextSnapshot ?? null;
    const row = (state.snapshot?.threads ?? []).find((entry) => entry?.key === threadKey)
      ?? this.knownRows.get(threadKey)
      ?? (thread ? {
        ...thread,
        state: thread.excluded || thread.agentStatus || "idle",
        health: thread.error ? "red" : (matchingQuestions.length ? "yellow" : "gray"),
        openChat: openChatFor(thread)
      } : null)
      ?? (matchingQuestions.length ? {
        key: threadKey,
        kind: String(threadKey ?? "").split(":")[0] || "paseo",
        title: snap?.threadTitle ?? matchingQuestions[0]?.chatLabel?.replace(/\s*\([^)]*\)$/, "") ?? matchingQuestions[0]?.title ?? null,
        workspace: snap?.workspace ?? null,
        repo: snap?.repo ?? parsePrRef(matchingQuestions[0]?.prRef)?.repo ?? null,
        branch: snap?.branch ?? null,
        agentStatus: "idle",
        live: false,
        state: matchingQuestions[0]?.kind === "ready" ? "ready-needs-human" : "needs-human",
        health: "yellow",
        reason: matchingQuestions[0]?.title ?? null,
        blockers: [],
        error: null,
        lastAgentText: snap?.agentSummary ?? matchingQuestions[0]?.askContext ?? matchingQuestions[0]?.body ?? "",
        lastAgentAt: snap?.lastAgentAt ?? matchingQuestions[0]?.askedAt ?? null,
        lastOwnerAt: snap?.lastUserAt ?? null,
        lastActivityAt: snap?.lastAgentAt ?? matchingQuestions[0]?.askedAt ?? matchingQuestions[0]?.createdAt ?? null,
        pr: snap?.pr ? {
          ref: snap.pr.ref,
          url: snap.pr.url,
          state: snap.pr.state,
          isDraft: Boolean(snap.pr.isDraft),
          title: snap.pr.title,
          bodySummary: snap.pr.bodySummary ?? null,
          additions: snap.pr.additions ?? null,
          deletions: snap.pr.deletions ?? null,
          changedFiles: snap.pr.changedFiles ?? null,
          files: snap.pr.files ?? [],
          ci: snap.pr.ciState ? { state: snap.pr.ciState, failing: snap.pr.failingChecks ?? [], pending: [] } : null,
          unresolvedThreads: snap.pr.unresolvedThreads ?? 0,
          mergeState: snap.pr.mergeState ?? null,
          head: snap.pr.head ?? null
        } : (matchingQuestions[0]?.prRef ? { ref: matchingQuestions[0].prRef, url: null, state: "OPEN" } : null),
        openChat: matchingQuestions[0]?.openChat ?? null
      } : null);
    if (!row) return null;
    const reply = thread
      ? agentReply(thread)
      : { text: row.lastAgentText || snap?.agentSummary || matchingQuestions[0]?.askContext || "", at: row.lastAgentAt ?? snap?.lastAgentAt ?? null };
    const ownerAt = thread ? ownerSpokeAt(thread) : (row.lastOwnerAt ?? snap?.lastUserAt ?? null);
    const ownerText = thread && ownerAt ? (thread.lastUserText ?? "") : (snap?.lastUserText ?? "");
    return {
      key: row.key, kind: row.kind, title: row.title ?? snap?.threadTitle ?? null, workspace: row.workspace ?? snap?.workspace ?? null, repo: row.repo ?? snap?.repo ?? null, branch: row.branch ?? snap?.branch ?? null,
      app: row.app ?? null, agentStatus: row.agentStatus ?? null, live: Boolean(row.live), state: row.state ?? null, health: row.health ?? null,
      reason: row.reason ?? null, blockers: row.blockers ?? [], error: row.error ?? null,
      lastAgentMessage: { text: clampTail(redactSecrets(reply.text), DETAIL_EXCERPT_MAX), at: reply.at ?? null },
      lastOwnerAt: ownerAt,
      lastOwnerMessage: ownerAt && ownerText
        ? { text: clampTail(redactSecrets(ownerText), DETAIL_EXCERPT_MAX), at: ownerAt }
        : null,
      activityTruncated: reply.text.length > DETAIL_EXCERPT_MAX || (ownerAt ? String(ownerText).length > DETAIL_EXCERPT_MAX : false),
      lastActivityAt: row.lastActivityAt ?? null,
      pr: row.pr ?? null,
      watch: row.watch ?? null,
      decision: row.decision ?? null,
      pushPreview: row.pushPreview ?? null,
      pushing: row.pushing === true,
      ...(row.prompt ? { prompt: row.prompt } : {}),
      muted: row.muted ?? null,
      questions: matchingQuestions,
      openChat: row.openChat ?? matchingQuestions[0]?.openChat ?? null,
      scannedAt: state.snapshot?.at ?? null
    };
  }

  // Send the scan's preview verbatim. Only pacing waits are skipped;
  // an unanswered question or a nudge already sent still holds it.
  async pushNow(threadKey, { deadlineAt = null } = {}) {
    const startedAt = Date.now();
    const blocked = (detail) => ({ delivery: { status: "blocked", route: null, detail }, action: null });
    if (this.pushing.has(threadKey)) return blocked("a push to this thread is already being sent");
    this.pushing.add(threadKey);
    try {
      const thread = this.lastThreads.get(threadKey);
      const item = this.lastItems.get(threadKey);
      if (!thread || !item) return blocked("thread not seen since restart: scan first");
      if (this.store.mutedUntil(threadKey)) return blocked("muted: unmute it to push");
      const asking = this.store.openQuestions().find((question) => question.threadKey === threadKey || (question.threadKeys ?? []).includes(threadKey));
      if (asking) return blocked(`waits on your answer first: ${asking.title}`);
      if (this.ownerAnswerThreads(Infinity).has(threadKey)) return blocked("your answer to it is still on its way; it goes first");
      const deliveryState = await this.probeDelivery({ deadlineAt });
      const preview = item.pushPreview;
      const route = chooseRoute(thread, this.mode === "auto" ? "auto" : "propose", deliveryState);
      const decision = preview ? { ...preview, route } : null;
      if (decision?.action !== "nudge" || !decision.message || !route) return blocked(`nothing to push: ${preview?.reason ?? item.classified.reason}`);
      if (repeatsLastSend(thread, this.store.ledgerFor(threadKey), decision.messageHash)) return blocked("this nudge was already sent; waiting for the agent's reply");
      const settled = await this.prSettledBeforeSend(thread, item.pr, decision);
      if (settled) return blocked(`not sent: ${settled}`);
      const currentAsk = this.store.openQuestions().find((question) => question.threadKey === threadKey || (question.threadKeys ?? []).includes(threadKey));
      if (currentAsk) return blocked(`waits on your answer first: ${currentAsk.title}`);
      if (this.store.mutedUntil(threadKey)) return blocked("muted: unmute it to push");
      if (this.ownerAnswerThreads(Infinity).has(threadKey)) return blocked("your answer to it is still on its way; it goes first");
      // The owner is speaking to this thread now: an automatic nudge a scan
      // decided meanwhile is held, as for an owner answer.
      this.ownerAnsweredAt.set(threadKey, this.now());
      const at = new Date(this.now()).toISOString();
      const record = {
        threadKey, targetKey: threadKey, playbook: decision.playbook, route: decision.route, message: decision.message, kind: "nudge", by: "owner",
        reason: clampText(`owner: push now; ${decision.reason}`, 300), progressMark: decision.progressMark ?? null,
        messageHash: decision.messageHash ?? null, factsKey: decision.factsKey ?? null, facts: decision.facts ?? null
      };
      // A planned or proposed copy of the same nudge is this one, sent.
      const existing = this.store.actions(this.config.limits.maxActionsKept).find((action) => OPEN_ACTION.has(action.status) && action.threadKey === threadKey && action.playbook === decision.playbook);
      const delivery = await this.executor.deliver({ thread, message: decision.message, route: decision.route, playbook: decision.playbook, actionId: existing?.id ?? null, spentMs: Date.now() - startedAt, deadlineAt });
      if ((delivery.route ?? decision.route) === "computer-use") this.noteUiResult(thread, delivery);
      const id = existing?.id ?? delivery.actionId ?? null;
      const action = id
        ? this.store.updateAction(id, { ...record, status: delivery.status, detail: delivery.detail ?? null, at })
        : this.store.recordAction({ ...record, status: delivery.status, detail: delivery.detail ?? null, at });
      this.recordSend(record, delivery, at);
      // A card in the way comes back with the block, as for an owner message.
      const card = delivery.status === "sent" ? null : delivery.prompt ?? this.livePrompt(thread);
      return { delivery: { status: delivery.status, route: delivery.route ?? decision.route, detail: delivery.detail ?? null, ...(card ? { prompt: card } : {}) }, action };
    } finally { this.pushing.delete(threadKey); }
  }

  // The owner's Mute: no nudge or question for the thread until then
  // (policy's "muted by owner"); its open asks close on the next scan.
  muteThread(threadKey, { hours = MUTE_HOURS_DEFAULT } = {}) {
    const until = this.store.mute(threadKey, this.now() + hours * 60 * MIN);
    this.store.recordAction({ kind: "mute", playbook: "owner-mute", threadKey, status: "done", reason: `owner: mute for ${hours} h`, by: "owner" });
    this.emitFleet("thread-muted");
    return { until };
  }

  unmuteThread(threadKey) {
    const was = this.store.unmute(threadKey);
    if (was) this.store.recordAction({ kind: "unmute", playbook: "owner-mute", threadKey, status: "done", reason: "owner: unmute", by: "owner" });
    this.emitFleet("thread-unmuted");
    return { until: null };
  }

  applyOverride(question, answer) {
    const keys = question.threadKeys ?? (question.threadKey ? [question.threadKey] : []);
    for (const key of keys) {
      if (question.kind === "stuck" && answer === "keep going") this.store.resetAttempts(key);
      if (question.kind === "deliver") this.store.ackUndelivered(key);
      if ((question.kind === "stuck" && answer === "stop") || (question.kind === "open" && answer === "skip")) {
        this.store.mute(key, this.now() + MUTE_MS);
      }
    }
  }

  async sendProposed(actionId, { deadlineAt = null } = {}) {
    if (this.mode !== "propose") return null;
    const action = this.store.action(actionId);
    if (!action || action.status !== "proposed") return null;
    const thread = this.lastThreads.get(action.targetKey);
    if (!thread) {
      const updated = this.store.updateAction(actionId, { status: "blocked", detail: "thread not seen in the last scan" });
      return { action: updated, delivery: { status: "blocked", route: action.route, detail: updated?.detail ?? null } };
    }
    // The thread moved on since this was proposed (a deferred thread's
    // proposal outlives the scan that made it): its message is stale.
    const facts = this.lastThreadFacts?.get(action.threadKey);
    const movedOn = action.threadFacts && facts && facts !== action.threadFacts ? "the thread moved on since the proposal" : null;
    // The owner muted it or it left supervision since: nothing goes in.
    const excluded = this.lastThreads.get(action.threadKey)?.excluded ?? null;
    const unjudged = action.requiresJudge && !action.judged ? "not judged yet" : null;
    const held = this.store.mutedUntil(action.threadKey) || this.store.mutedUntil(action.targetKey) ? "muted by owner"
      : excluded ? `thread ${excluded}` : unjudged;
    const settled = held ?? movedOn ?? (action.kind === "nudge" ? await this.prSettledBeforeSend(thread, this.lastPrs.get(action.threadKey) ?? null, action) : null);
    if (settled) {
      const updated = this.store.updateAction(actionId, { status: "stale", detail: `not sent: ${settled}` });
      return { action: updated, delivery: { status: "blocked", route: action.route, detail: updated?.detail ?? null } };
    }
    const sentAt = new Date(this.now()).toISOString();
    const delivery = await this.executor.deliver({ thread, message: action.message, route: action.route, playbook: action.playbook, actionId, deadlineAt });
    if ((delivery.route ?? action.route) === "computer-use") this.noteUiResult(thread, delivery);
    this.recordSend(action, delivery, sentAt);
    return { action: this.store.action(actionId), delivery };
  }

  // sentAt: when the send started. A reply can land before delivery returns.
  recordSend(action, delivery, sentAt = null) {
    const at = new Date(this.now()).toISOString();
    const incident = incidentKey(action);
    if (incident && ESCALATION_STATUSES.has(delivery.status)) this.store.recordEscalation(incident, at);
    if (String(action.threadKey ?? "").startsWith("infra:")) return;
    // An escalation went to the manager, not this thread: history only, so it
    // spends neither the thread's nudge budget nor its cooldown.
    const status = action.kind === "escalate-manager" && delivery.status === "sent" ? "escalated" : delivery.status;
    const thread = this.lastThreads.get(action.threadKey);
    const threadActivityAt = thread ? (thread.lastAgentAt && Date.parse(thread.lastAgentAt) > Date.parse(thread.lastActivityAt ?? "") ? thread.lastAgentAt : thread.lastActivityAt) : null;
    // The route that actually ran: a presence-blocked app send may have gone
    // by a background route instead.
    // The policy's hash and facts, so the next decision can tell a repeat.
    const said = { sentAt, messageHash: action.messageHash ?? null, factsKey: action.factsKey ?? null, facts: action.facts ?? null };
    const recorded = this.store.recordNudge(action.threadKey, { at, playbook: action.playbook, route: delivery.route ?? action.route, status, detail: delivery.detail ?? null, threadActivityAt, ...said }, action.progressMark);
    // A counted nudge whose background child never reached the agent gives
    // back that one attempt, and its entry (with its message hash) is failed.
    // Owner answers and escalations counted none.
    if (status === "sent" && delivery.done) {
      const entry = recorded?.nudges.at(-1) ?? null;
      const sent = entry ? { at: entry.at, messageHash: entry.messageHash } : null;
      delivery.done.then((reached) => { if (!reached) this.store.undoAttempt(action.threadKey, sent); }).catch(() => { /* best-effort */ });
    }
  }

  async _tick(reason, { deferUi = false } = {}) {
    const started = this.now();
    this.tickCount += 1;
    // The owner asked for this scan ("Scan now", the chat): recheck every
    // open question, not only the new, changed or due ones.
    this.forceReview = reason === "owner-scan" || reason === "chat";
    const mode = this.mode;
    const run = this.deps.run ?? runCommand;
    const d = this.deps;
    if (!this.forceMode) await this.selfFixHub.sync().catch(() => {});
    const config = { ...this.config, mode, selfSessionIds: [...this.config.selfSessionIds, ...this.store.selfSessions()] };
    const sourceErrors = {};
    const previous = this.store.snapshot;
    const guard = (name, fn, fallback) => withTimeout(Promise.resolve().then(fn), SOURCE_TIMEOUT_MS, name)
      .catch((error) => {
        sourceErrors[name] = clampText(error?.message ?? String(error), 200);
        return fallback;
      });

    const paseoOnly = config.paseo?.enabled && config.paseo.only;
    let peers = new Map();
    try { if (!paseoOnly) peers = (d.readLivePeers ?? claude.readLivePeers)(config) ?? new Map(); } catch (error) { sourceErrors.peers = clampText(error?.message, 200); }

    // The Codex keys whose open card this tick's scan settled (see act).
    const cardScanned = new Set();
    const storageOn = Boolean(this.config.storage?.enabled);
    const [codexThreads, claudeThreads, conductorThreads, antigravityThreads, paseoThreads, lbErrors, localVerify, bb3, lb] = await Promise.all([
      paseoOnly ? [] : guard("codex", () => (d.listCodexThreads ?? codex.listCodexThreads)(config, { now: started, run, cardScanned }), []),
      paseoOnly ? [] : guard("claude", () => (d.listClaudeThreads ?? claude.listClaudeThreads)(config, { now: started, peers }), []),
      paseoOnly ? [] : guard("conductor", () => (d.listConductorThreads ?? conductor.listConductorThreads)(config, { now: started, peers }), []),
      paseoOnly ? [] : guard("antigravity", () => (d.listAntigravityThreads ?? antigravity.listAntigravityThreads)(config, { now: started, run, fetchImpl: d.fetchImpl }), []),
      guard("paseo", () => (d.listPaseoThreads ?? (this.paseoSource ??= createPaseoSource({ factory: d.paseoFactory })))(config), []),
      paseoOnly ? [] : guard("lbErrors", () => (d.readCodexLbErrors ?? codex.readCodexLbErrors)(config, { now: started }), []),
      paseoOnly ? [] : guard("processes", () => (d.findLocalHeavyVerification ?? processes.findLocalHeavyVerification)(config, { run }), []),
      paseoOnly || this.skip.bb3 ? null : guard("bb3", () => (d.probeBuildBot3 ?? buildbot3.probeBuildBot3)(config, { run, now: started, previous: previous?.infra?.bb3 ?? null }), null),
      paseoOnly ? null : guard("lb", () => (d.checkLb ?? buildbot3.checkLb)(config, { fetchImpl: d.fetchImpl, now: started }), null),
      // Free space only (statfs); a failed read keeps the last one.
      storageOn ? guard("storage", () => this.storage.refreshVolumes(), null) : null
    ]);

    // Conductor-hosted Codex threads learn which Conductor session shows them.
    const unknownPrefixes = Array.isArray(paseoThreads?.unknownThreadPrefixes) ? paseoThreads.unknownThreadPrefixes : [];
    const isUnknownPrefixKey = (key) => unknownPrefixes.some((prefix) => String(key ?? "").startsWith(prefix));
    const threads = linkUiHosts(mergeThreads({ codex: codexThreads ?? [], claude: claudeThreads ?? [], conductor: conductorThreads ?? [], antigravity: antigravityThreads ?? [], paseo: paseoThreads ?? [] }));
    const threadFacts = new Map(threads.map((thread) => [thread.key, discoveredFacts(thread)]));
    if (config.paseo?.enabled && config.paseo.only) for (const t of threads) if (t.kind !== "paseo") t.excluded = "paseo-migrated";
    // With migration discovery unavailable, legacy identities are not safe to resume.
    if (config.paseo?.enabled && sourceErrors.paseo) {
      for (const thread of threads) if (thread.kind !== "paseo") thread.excluded = "paseo-discovery-unavailable";
    }
    const ownPaths = this.store.fixes().map((fix) => fix.worktree).filter(Boolean);
    for (const thread of threads) {
      if (isSelfThread(thread, config) || thread.branch?.startsWith("selffix/")
          || ownPaths.some((cwd) => thread.cwd === cwd || thread.cwd?.startsWith(cwd + path.sep))
          || thread.cwd?.startsWith(path.join(this.config.paths.home ?? os.homedir(), "Dev/openagi-fixes") + path.sep)) thread.excluded = "self";
    }
    // Auto-link unassigned explicit ActiveWork goals to matching live coding sessions
    // so `resume_owner` goals do not sit stranded with `owner.threadKey: null`.
    try { this.activeWork.autoBindUnassignedGoals(threads); } catch { /* best-effort */ }
    const manager = paseoOnly ? null : (d.findManagerSession ?? conductor.findManagerSession)(config, threads) ?? null;
    const hasCard = (thread) => thread.meta?.pendingCard?.items?.length > 0;
    const ranked = threads
      .filter((thread) => !thread.excluded)
      .sort((a, b) => String(b.lastActivityAt ?? "").localeCompare(String(a.lastActivityAt ?? "")));
    // An older thread past the cap still has its open card asked: the Codex
    // source kept it for that card alone.
    const selected = this.selectScanScope(ranked, threads, sourceErrors, unknownPrefixes);
    const selectedKeys = new Set(selected.map((thread) => thread.key));
    const inScope = [...selected, ...ranked.filter((thread) => !selectedKeys.has(thread.key) && hasCard(thread))];
    // Every thread this scan reads counts as scanned, card overflow too, so
    // a carded thread never also wins a quiet thread's rotation slot.
    for (const thread of inScope) this.scopeReadAt.set(thread.key, this.tickCount);
    // Eligible threads this capped scan did not read: their conditions were
    // not reassessed, so nothing they hold (a group seat, a proposal, a
    // remembered outage, a blocked-UI clock) is cleared on their account.
    const scopeKeys = new Set(inScope.map((thread) => thread.key));
    const deferred = new Set(ranked.filter((thread) => !scopeKeys.has(thread.key)).map((thread) => thread.key));
    // An automation or no-repo thread's open question card still needs the
    // owner. It is decided (asked) with the rest, but never read for git or
    // PRs, and classify gives it nothing to nudge.
    const carded = threads.filter((thread) => CARD_EXCLUSIONS.has(thread.excluded) && hasCard(thread));

    const localGit = await this.readGit(inScope, config, run, sourceErrors);
    resolveCreatedPrs(inScope);
    await this.resolvePrRefs(inScope, localGit, config, run, sourceErrors, ranked);
    await this.preferOpenPrs(inScope, config, run);
    const unreadPrs = new Set();
    // An open question's PR and any ActiveWork PR are read too, even once
    // their thread moved to another PR or left the scan: a merge settles them.
    const askedPrs = [
      ...this.store.openQuestions().map((question) => question.prRef),
      ...(this.activeWork.getActiveWork({ limit: 60 })?.items ?? []).map((item) => item?.prRef)
    ];
    const prs = this.withSettledPrs(await this.fetchPrs(inScope, config, run, sourceErrors, unreadPrs, askedPrs), unreadPrs);

    const infra = {
      bb3: bb3 ?? { ...emptyBb3(), error: paseoOnly || this.skip.bb3 ? "skipped" : (sourceErrors.bb3 ?? null) },
      lb: { healthy: lb?.healthy ?? null, detail: lb?.detail ?? null, watchLine: lb?.watchLine ?? null, recentErrors: lbErrors ?? [], errorsUnknown: paseoOnly || Boolean(sourceErrors.lbErrors) },
      localVerify: (localVerify ?? []).map((row) => ({ ...row, threadKey: processes.matchThreadByCwd(row.cwd, inScope) }))
    };

    const playbooks = this.playbooks();
    const store = this.store;
    const mutedKeys = store.mutedKeys();
    // Computer-use readiness, once per tick; the driver re-checks at each send.
    const delivery = await this.probeDelivery();
    if (!deferUi && this.mode === "auto" && delivery.ready === true && config.autoApprove?.includes("codex")) {
      try { await this.approveCodexCards(inScope, threads, started); } catch { /* best-effort: cards left are asked about below */ }
    }
    // One thread waiting on a permission card whose buttons are not known
    // yet gets one screen read per tick, so its question offers them.
    // Never in Observe (it drives nothing); in Propose only a thread already
    // on screen is read (no deep link moves the app). A read that found no
    // card is not repeated until the thread moves, then with backoff.
    if (!deferUi && this.mode !== "observe" && delivery.ready === true && typeof this.uiDriver?.inspect === "function") {
      const waiting = inScope.find((thread) => thread.meta?.blockedOnOwner === true && !mutedKeys.has(thread.key) && uiTargetFor(thread)
        && !this.livePrompt(thread) && !this.cardlessReadFresh(thread, started));
      if (waiting) {
        try { await this.screenThread(waiting.key, { thread: waiting, threads, navigate: this.mode === "auto" }); } catch { /* a read is best-effort */ }
        if (this.livePrompt(waiting)) this.cardlessReads.delete(waiting.key);
        else {
          const last = this.cardlessReads.get(waiting.key);
          const mark = activityMark(waiting);
          this.cardlessReads.set(waiting.key, { mark, at: started, count: last?.mark === mark ? last.count + 1 : 1 });
        }
      }
    }
    // A card seen on screen: the thread waits on the owner, and its buttons
    // become the question's options (policy agentAskIntent).
    for (const thread of inScope) {
      const card = this.livePrompt(thread);
      if (card) thread.meta = { ...thread.meta, blockedOnOwner: true, prompt: card };
    }
    const items = [];
    for (const thread of [...inScope, ...carded]) {
      const pr = prs.get(thread.prRefs?.[0]) ?? null;
      // No result for a worktree means git timed out or threw: unknown, not clean.
      // An excluded thread (only asked about its card) was never read.
      const git = localGit.get(thread.cwd) ?? (thread.cwd && !thread.excluded ? { unreadable: true } : null);
      const gitUnreadable = Boolean(git?.unreadable);
      // A linked PR GitHub could not answer (gh failed or timed out) is unknown, not gone.
      const prUnreadable = !pr && unreadPrs.has(thread.prRefs?.[0]);
      let classified;
      try {
        classified = classifyThread(thread, { pr, localGit: git, infra, now: started, config });
      } catch (error) {
        classified = { state: "idle-no-pr", reason: `classify failed: ${clampText(error?.message, 80)}`, blockers: [], readiness: null };
      }
      let decision;
      if (mutedKeys.has(thread.key)) {
        decision = { threadKey: thread.key, state: classified.state, action: "none", playbook: null, message: null, reason: "muted by owner", blockers: [], question: null, route: null, notBefore: store.mutedUntil(thread.key), targetKey: thread.key, progressMark: null };
      } else {
        decision = decideThread(classified, thread, { ledger: store.ledgerFor(thread.key), escalationLedger: store, mutedKeys, playbooks, config, now: started, pr, mode, infra, manager, delivery, contextualIdleReview: this.nudgeJudge?.enabled === true || (this.decisionsGate?.enabled === true && mode !== "observe") });
      }
      items.push({ thread, classified, pr, ledger: store.ledgerFor(thread.key), decision, gitUnreadable, prUnreadable });
    }
    const byItem = new Map(items.map(({ thread }) => [thread.key, thread]));
    const blockedKeys = { bb3: this.rememberedBlocked("bb3", byItem), lb: this.rememberedBlocked("lb", byItem) };
    const infraDecisions = decideInfra(infra, { ledger: store, playbooks, config, now: started, threads: items, manager, mode, blockedKeys, mutedKeys, delivery });
    // Automatic nudges are read by the judge before they go out (Auto only),
    // an infra recovery's resume too. It replaces its thread's own nudge
    // (dedupeDecisions keeps it first anyway); beside an ask or a wait it is
    // read as a decision of its own.
    const itemOf = new Map(items.map((item) => [item.thread.key, item]));
    const recoveries = [];
    const replaced = new Set();
    for (const [index, decision] of infraDecisions.entries()) {
      const item = decision.action === "nudge" ? itemOf.get(decision.threadKey) : null;
      if (!item) continue;
      const own = item.decision.action === "nudge" && !replaced.has(item);
      if (own) { item.decision = decision; replaced.add(item); }
      recoveries.push({ index, item: own ? item : { ...item, decision }, extra: !own });
    }
    await this.judgeNudges([...items, ...recoveries.filter(({ extra }) => extra).map(({ item }) => item)], { started });
    for (const { index, item } of recoveries) infraDecisions[index] = item.decision;
    // How long a nudge has waited on computer use, for telling the owner.
    // The live mode: the owner may have left Auto while this tick scanned.
    const queuedWaits = this.store.queuedAnswers().map((question) => ({ threadKey: question.threadKey, uiBlocked: true }));
    this.trackUiBlocked([...items.map((item) => item.decision), ...infraDecisions, ...queuedWaits], { mode: this.mode, delivery, threads, sourceErrors, started, config, deferred });
    const paused = pausedDeliveryDecision(delivery, this.uiBlockedSince, started);
    if (paused) infraDecisions.push(paused);
    infraDecisions.push(...this.unreadableDecisions(started, threads));
    // Asked again every tick from the stored plans, so they stay open.
    if (storageOn) infraDecisions.push(...this.storage.decisions());
    const health = infraHealth(infra, { config, now: started });
    if (bb3) store.setInfraDown("bb3", health.bb3.down);
    if (lb) store.setInfraDown("lb", health.lb.down);

    // A muted thread keeps only its "muted by owner" line: nothing that
    // infra recovery or any other path decided for it may send or ask.
    const decisions = dedupeDecisions([...infraDecisions, ...items.map((item) => item.decision)])
      .filter((decision) => !mutedKeys.has(decision.threadKey) || decision.action === "none");
    const byKey = new Map(threads.map((thread) => [thread.key, thread]));
    if (manager) byKey.set(manager.key, manager);
    const mergedLastThreads = new Map(byKey);
    for (const [key, prev] of this.lastThreads) {
      if (prev?.kind && (sourceErrors[prev.kind] || isUnknownPrefixKey(key)) && !mergedLastThreads.has(key)) mergedLastThreads.set(key, prev);
    }
    this.lastThreads = mergedLastThreads;
    for (const [key, thread] of mergedLastThreads) setBounded(this.knownThreads, key, thread);
    this.lastThreadFacts = threadFacts;
    // Each thread's PR as this scan read it, for a proposal sent later.
    // A deferred thread keeps the last read, for its proposal still open.
    const nextPrs = new Map([
      ...[...this.lastPrs].filter(([key]) => deferred.has(key) || isUnknownPrefixKey(key) || (this.lastThreads.get(key)?.kind && sourceErrors[this.lastThreads.get(key).kind])),
      ...items.filter((item) => item.pr).map((item) => [item.thread.key, item.pr])
    ]);
    for (const [ref, pr] of prs) if (ref && pr) nextPrs.set(ref, pr);
    this.lastPrs = nextPrs;
    const decisionFor = effectiveDecisions(decisions);
    this.lastItems = new Map(items.map((item) => {
      const current = decisionFor.get(item.thread.key);
      const pushPreview = current?.action === "nudge" ? current : decideThread(item.classified, item.thread, {
        ledger: store.ledgerFor(item.thread.key), escalationLedger: store, playbooks: this.playbooks(), config,
        now: started, pr: item.pr, mode: mode === "auto" ? "auto" : "propose", infra, manager, delivery, ownerPush: true
      });
      return [item.thread.key, { classified: item.classified, pr: item.pr, pushPreview }];
    }));
    this.lastInfra = infra;
    this.lastManager = manager;

    // A thread source that failed this tick is unknown, not empty: its
    // actions and questions wait for a tick that can see it.
    const unknownKinds = new Set(THREAD_KINDS.filter((kind) => sourceErrors[kind]));
    if (config.paseo?.enabled && sourceErrors.paseo) for (const kind of THREAD_KINDS) unknownKinds.add(kind);
    // A source that returned a full page may have evicted older live threads,
    // so a missing thread of that kind is not proof it is gone.
    const cappedKinds = new Set(THREAD_KINDS.filter((kind) => threads.filter((thread) => thread.kind === kind && (kind !== "antigravity" || !thread.excluded)).length >= config.limits.maxThreads));
    // A failed disk read, or an SD card mounted but unreadable, is unknown.
    const storageUnknown = storageOn && (Boolean(sourceErrors.storage) || this.storage.sdUnknown);
    const attempted = await this.act(decisions, { mode, byKey, manager, started, config, items, prs, unreadPrs, unknownKinds, unknownPrefixes, cappedKinds, cardScanned, deferUi, skipReview: reason === "owner-away", storageUnknown, deferred, threadFacts });
    this.trackInfraBlocked(health, items, blockedKeys, { recovering: infraDecisions, attempted, unknownKinds, unknownPrefixes, mode, now: started, deferred });

    const finished = this.now();
    const snapshot = this.buildSnapshot({ reason, started, finished, mode, threads, inScope, items, decisions, infra, sourceErrors, unknownPrefixes, manager, delivery, storage: storageOn ? this.storage.summary() : null, previous });
    store.recordSnapshot(snapshot);
    this.lastTickAt = snapshot.at;
    try {
      await this.reconcileFollowThroughWatches({ byKey, items, started });
      await this.maybePostProactiveSupervisorDigest({
        snapshot,
        started,
        autoResolvedSummaries: this._lastTickAutoResolved ?? []
      });
    } catch { /* proactive supervisor chat bridge never breaks a tick */ }
    try { await this.diagnoseTick(); } catch (error) {
      store.saveDiagnosis({ error: clampText(redactSecrets(error?.message), 200) });
    }
    try { this.runtime?.events?.emit?.("fleet", { at: snapshot.at, reason, counts: snapshot.counts }); } catch { /* listeners never break a tick */ }
    return snapshot;
  }

  // Keep a quarter of the slots for the most recently active conversations;
  // rotate the rest through the least recently scanned. A busy top page can
  // no longer starve older work. Selection changes no eligibility or send
  // policy, and permission cards still bypass the cap in _tick, which
  // stamps every thread read in scopeReadAt.
  selectScanScope(ranked, threads, sourceErrors, unknownPrefixes = []) {
    const present = new Set(threads.map((thread) => thread.key));
    for (const key of this.scopeReadAt.keys()) {
      if (!present.has(key) && !sourceErrors[key.split(":", 1)[0]] && !unknownPrefixes.some((p) => key.startsWith(p))) this.scopeReadAt.delete(key);
    }
    const limit = this.config.limits.maxThreads;
    const recent = ranked.slice(0, Math.floor(limit / 4));
    const recentKeys = new Set(recent.map((thread) => thread.key));
    // Stable sort preserves newest-first order among never-scanned or
    // equally recent rows, including the first scan after a restart.
    const rotated = ranked.filter((thread) => !recentKeys.has(thread.key))
      .sort((a, b) => (this.scopeReadAt.get(a.key) ?? 0) - (this.scopeReadAt.get(b.key) ?? 0));
    const selected = [...recent, ...rotated.slice(0, limit - recent.length)];
    // Display order stays newest first even when selection rotates.
    const keys = new Set(selected.map((thread) => thread.key));
    return ranked.filter((thread) => keys.has(thread.key));
  }

  // The judge reads the chat before an automatic nudge goes out: send its
  // message, wait, or ask the owner. Only in Auto, only for the playbooks
  // in JUDGED_PLAYBOOKS, and never for a limit or error resume (those stay
  // mechanical). A failure waits, never a blind send. Item decisions are
  // replaced in place.
  async judgeNudges(items, { started }) {
    const judge = this.nudgeJudge;
    const judgeEnabled = Boolean(judge?.enabled) && typeof judge?.judge === "function";
    const gate = this.decisionsGate;
    const gateEnabled = Boolean(gate?.enabled) && typeof gate?.evaluateBatch === "function";
    if ((!judgeEnabled && !gateEnabled) || this.mode === "observe") return;
    for (const [key, entry] of this.judgeCache) if (started - entry.at >= JUDGE_CACHE_MS) this.judgeCache.delete(key);
    for (const [key, at] of this.judgeTriedAt) if (started - at >= JUDGE_CACHE_MS) this.judgeTriedAt.delete(key);
    // Only answers given since this scan began count (ownerAnswerThreads).
    for (const [key, at] of this.ownerAnsweredAt) if (at < started) this.ownerAnsweredAt.delete(key);
    // A thread the owner answered, or whose answer waits to be typed or is
    // being sent, gets no automatic nudge: the answer goes first
    // (deliverQueuedAnswers), never a playbook nudge beside or over it.
    const answering = this.ownerAnswerThreads(started);
    if (gateEnabled) {
      const gateCandidates = [];
      for (const item of items) {
        if (!judgeable(item.decision, item.thread)) continue;
        if (answering.has(item.thread.key)) {
          item.decision = judgeWait(item.decision, "owner answer goes first; no nudge");
          continue;
        }
        if (item.decision.notBefore && Date.parse(item.decision.notBefore) > started) continue;
        gateCandidates.push(item);
      }
      if (gateCandidates.length > 0) {
        const gateVerdicts = await gate.evaluateBatch(gateCandidates, { started });
        const answeredAfterGate = this.ownerAnswerThreads(started);
        for (const item of gateCandidates) {
          const gv = gateVerdicts.get(item.thread.key);
          if (!gv) continue;
          if (answeredAfterGate.has(item.thread.key)) {
            item.decision = judgeWait(item.decision, "owner answered meanwhile; no nudge");
            continue;
          }
          if (gv.action === "error") {
            if (!gv.cached) {
              this.store.recordAction({
                kind: "decisions",
                threadKey: item.thread.key,
                playbook: item.decision.playbook,
                verdict: "failed",
                status: "failed",
                reason: `decisions gate unavailable: ${gv.error}`
              });
            }
            if (!judgeEnabled) {
              item.decision = judgeWait(item.decision, `decisions gate unavailable: ${gv.error}`);
            }
            continue;
          }
          if (gv.action === "wait") {
            if (!gv.cached) {
              this.store.recordAction({
                kind: "decisions",
                threadKey: item.thread.key,
                playbook: item.decision.playbook,
                verdict: "wait",
                status: "done",
                reason: gv.reason
              });
            }
            item.decision = judgeWait(item.decision, `decisions: ${gv.reason}`, false);
            continue;
          }
          if (!judgeEnabled && gv.action === "ask-owner") {
            if (!gv.cached) {
              this.store.recordAction({
                kind: "decisions",
                threadKey: item.thread.key,
                playbook: item.decision.playbook,
                verdict: "ask-owner",
                status: "done",
                reason: gv.reason
              });
            }
            const reply = agentReply(item.thread);
            item.decision = this.applyJudgeVerdict(item, {
              action: "ask-owner",
              reason: gv.reason,
              question: {
                title: "Needs your decision",
                body: clampText(redactSecrets(reply.text || item.decision.reason || "Session is blocked on an owner decision."), 220),
                options: ["continue", "open thread"]
              }
            });
            continue;
          }
          if (!judgeEnabled && gv.action === "send") {
            if (!gv.cached) {
              this.store.recordAction({
                kind: "decisions",
                threadKey: item.thread.key,
                playbook: item.decision.playbook,
                verdict: "send",
                status: "done",
                reason: gv.reason
              });
            }
            const keepAliveMessage = item.decision.requiresJudge && !item.decision.deferredRouteDecision
              ? "Supervisor keep-alive check: unfinished in-scope work remains in this session. Continue and verify the remaining in-scope steps now (do not merge, deploy, release, delete data, or spend without explicit owner approval). If blocked on the owner, stop and state the exact decision needed in one line."
              : item.decision.message;
            item.decision = this.applyJudgeVerdict(item, {
              action: "send",
              message: keepAliveMessage,
              reason: gv.reason
            });
          }
        }
      }
    }
    if (!judgeEnabled) return;
    const history = this.nudgeHistory(new Set(items.filter((item) => judgeable(item.decision, item.thread)).map((item) => item.thread.key)));
    const due = [];
    for (const item of items) {
      const { decision, thread } = item;
      if (!judgeable(decision, thread)) continue;
      if (answering.has(thread.key)) { item.decision = judgeWait(decision, "owner answer goes first; no nudge"); continue; }
      if (decision.notBefore && Date.parse(decision.notBefore) > started) continue;
      const key = judgeCacheKey(thread, decision, item.pr, item.classified, history.get(thread.key) ?? []);
      const cached = this.judgeCache.get(key);
      if (cached && started - cached.at < (decision.requiresJudge ? IDLE_JUDGE_CACHE_MS : JUDGE_CACHE_MS)) item.decision = this.applyJudgeVerdict(item, cached.verdict);
      else due.push({ item, key });
    }
    if (!due.length) return;
    if (this.judgeDownUntil > this.now()) {
      for (const { item } of due) item.decision = judgeWait(item.decision, `judge unavailable: ${this.judgeError ?? "paused"}`);
      return;
    }
    // Resumes first, then the thread nudged or judged longest ago (the send
    // order), so threads the judge keeps failing on cannot hold the cap.
    const lastTried = ({ item }) => Math.max(Date.parse(item.ledger?.nudges?.at(-1)?.at ?? "") || 0, this.judgeTriedAt.get(item.thread.key) ?? 0);
    due.sort((a, b) => (a.item.decision.playbook === "resume" ? 0 : 1) - (b.item.decision.playbook === "resume" ? 0 : 1) || lastTried(a) - lastTried(b));
    const now = due.slice(0, JUDGE_MAX_PER_TICK);
    for (const { item } of due.slice(JUDGE_MAX_PER_TICK)) item.decision = judgeWait(item.decision, "judge: read next scan (per-scan cap)");
    const judgeStart = this.now();
    // A call the judge's own timeout would end is a failure; one the scan's
    // time left ends sooner is only read next scan.
    const fullMs = Math.min(JUDGE_CALL_MS, this.config.judge?.timeoutMs ?? JUDGE_CALL_MS);
    const results = await mapLimit(now, JUDGE_CONCURRENCY, async ({ item }) => {
      let conversation;
      try { conversation = await readThreadConversation(item.thread, this.config); }
      catch { return { error: "conversation unavailable" }; }
      const left = JUDGE_TICK_MS - (this.now() - judgeStart);
      if (left < JUDGE_MIN_CALL_MS) return { later: true };
      const capMs = Math.min(JUDGE_CALL_MS, left);
      try {
        const verdict = await withTimeout(Promise.resolve(judge.judge({
          conversation, thread: item.thread, decision: item.decision, classified: item.classified, pr: item.pr, nudges: history.get(item.thread.key) ?? [], now: started, timeoutMs: capMs
        })), capMs, "judge");
        return { verdict };
      } catch (error) {
        const message = error?.message ?? String(error);
        if (capMs < fullMs && /timed out/i.test(message)) return { later: true };
        return { error: clampText(redactSecrets(message), 120) || "failed" };
      }
    });
    // The owner may have answered while the calls ran: that answer wins over
    // a verdict read from the chat before it.
    const answeredMeanwhile = this.ownerAnswerThreads(started);
    let failed = 0;
    let ran = 0;
    now.forEach(({ item, key }, index) => {
      const result = results[index] ?? { error: "failed" };
      const { decision, thread } = item;
      if (result.later) { item.decision = judgeWait(decision, "judge: read next scan (time cap)"); return; }
      ran += 1;
      this.judgeTriedAt.set(thread.key, started);
      if (result.error) {
        failed += 1;
        this.judgeError = result.error;
        this.store.recordAction({ kind: "judge", threadKey: thread.key, playbook: decision.playbook, verdict: "failed", status: "failed", reason: `judge unavailable: ${result.error}` });
        item.decision = judgeWait(decision, `judge unavailable: ${result.error}`);
        return;
      }
      if (answeredMeanwhile.has(thread.key)) { item.decision = judgeWait(decision, "owner answered meanwhile; no nudge"); return; }
      const { verdict } = result;
      this.judgeCache.set(key, { verdict, at: started });
      const said = verdict.action === "send" ? { message: verdict.message } : verdict.action === "ask-owner" ? { message: verdict.question.title } : {};
      this.store.recordAction({ kind: "judge", threadKey: thread.key, playbook: decision.playbook, verdict: verdict.action, status: "done", reason: verdict.reason, ...said });
      item.decision = this.applyJudgeVerdict(item, verdict);
    });
    // Only calls that ran count: one the time cap cut off is no failure.
    // The pause runs from when the failures finished, not the scan's start.
    if (ran && failed === ran) this.judgeDownUntil = this.now() + JUDGE_DOWN_MS;
    else if (ran) this.judgeError = null;
  }

  // Threads with an owner answer that waits to be typed, is being sent, or
  // came in since `since` (or is being answered right now).
  ownerAnswerThreads(since) {
    const keys = new Set(this.store.queuedAnswers().map((question) => question.threadKey));
    for (const id of this.answering) {
      const threadKey = this.store.question(id)?.threadKey;
      if (threadKey) keys.add(threadKey);
    }
    for (const [key, at] of this.ownerAnsweredAt) if (at >= since) keys.add(key);
    return keys;
  }

  // A verdict turned into the thread's decision.
  applyJudgeVerdict(item, verdict) {
    const { decision, thread } = item;
    if (verdict.action === "wait") return judgeWait(decision, `judge: ${verdict.reason}`, false);
    if (verdict.action === "send") {
      // Establish unfinished work before surfacing an unavailable route.
      if (decision.deferredRouteDecision) return { ...decision.deferredRouteDecision, judged: true, reason: `${decision.deferredRouteDecision.reason}; judge: ${verdict.reason}` };
      const messageHash = shortHash(verdict.message);
      // The same words as the last send, with no reply since, is noise.
      const repeat = repeatsLastSend(thread, item.ledger, messageHash);
      if (repeat) return judgeWait(decision, `judge: same message sent at ${repeat.clock}; no reply since`, false);
      // judged: read in this scan, so act() may send it in Auto.
      return { ...decision, message: verdict.message, messageHash, judged: true, reason: `${decision.reason}; judge: ${verdict.reason}` };
    }
    const reply = agentReply(thread);
    const pr = Number(/#(\d+)$/.exec(thread.prRefs?.[0] ?? "")?.[1]);
    const label = ownerLabel(thread, pr > 0 ? pr : null, parsePrRef(thread.prRefs?.[0] ?? "")?.repo);
    const limits = this.config.limits ?? DEFAULTS;
    return {
      ...decision, action: "ask-user", message: null, route: null, reason: `judge: ${verdict.reason}`,
      question: {
        title: clampText(`${label}: ${verdict.question.title}`, limits.titleMax),
        body: verdict.question.body || clampText(verdict.reason, limits.bodyMax),
        options: verdict.question.options,
        dedupeKey: judgeAskKey(thread, verdict.question),
        kind: "agent-ask",
        mergeAsk: asksToMerge(verdict.question),
        askedBy: "judge",
        askContext: clampTail(redactSecrets(reply.text), limits.excerptMax),
        agentAskedAt: reply.at ?? null
      }
    };
  }

  // threadKey -> the last few nudges sent to it, newest last.
  nudgeHistory(keys) {
    const out = new Map();
    for (const action of this.store.actions(this.config.limits.maxActionsKept)) {
      if (action.kind !== "nudge" || action.status !== "sent" || !keys.has(action.threadKey)) continue;
      const list = out.get(action.threadKey) ?? [];
      if (list.length < 3) list.unshift({ playbook: action.playbook, at: action.at, message: action.message });
      out.set(action.threadKey, list);
    }
    return out;
  }

  // Remembered outage threads, minus any that moved on by themselves after
  // the infra came back (owner or agent active since): a late resume is stale.
  rememberedBlocked(kind, byItem) {
    const keys = this.store.infraBlocked(kind);
    const upAt = this.store.infraDown(kind) ? NaN : Date.parse(this.store.infraUpSince(kind) ?? "");
    if (!Number.isFinite(upAt)) return keys;
    const activeSince = (at) => Date.parse(at ?? "") > upAt;
    return keys.filter((key) => {
      const thread = byItem.get(key);
      return !thread || !(activeSince(thread.lastUserAt) || activeSince(thread.lastAgentAt));
    });
  }

  // While an outage lasts, remember every thread blocked on it; once it is up,
  // policy resumes them (it reads blockedKeys). Only a resume the send cap
  // held back is retried next tick; a wait means the owner or a recent nudge
  // already has the thread. A thread hidden by a failed source waits up to
  // RECOVERY_HOLD_MS for that source.
  trackInfraBlocked(health, items, previous, { recovering = [], attempted = new Set(), unknownKinds = new Set(), unknownPrefixes = [], mode = "observe", now = this.now(), deferred = new Set() } = {}) {
    for (const kind of INFRA_KINDS) {
      if (health[kind].down) {
        const current = items
          .filter(({ classified }) => classified.infraKind === kind && BLOCKED_STATES.has(classified.state))
          .map(({ thread }) => thread.key);
        this.store.setInfraBlocked(kind, [...previous[kind], ...current]);
      } else if (health[kind].up) {
        // A resume the judge has not read yet (its cap, a failure) is still due.
        const pending = new Set(recovering
          .filter((decision) => !String(decision.threadKey ?? "").startsWith("infra:") && !attempted.has(decision.threadKey)
            && ((decision.action === "nudge" && decision.route) || (decision.judgePending && decision.playbook === "infra-recovered")) && mode === "auto")
          .map((decision) => decision.threadKey));
        const upAt = Date.parse(this.store.infraUpSince(kind) ?? "");
        const holdHidden = Number.isFinite(upAt) && now - upAt < RECOVERY_HOLD_MS;
        // A thread a capped scan deferred gets its resume once it is read.
        this.store.setInfraBlocked(kind, previous[kind].filter((key) => pending.has(key) || deferred.has(key) || (holdHidden && (unknownKinds.has(key.split(":")[0]) || unknownPrefixes.some((p) => key.startsWith(p))))));
      }
    }
  }

  async readGit(inScope, config, run, sourceErrors) {
    const cwds = [...new Set(inScope.map((thread) => thread.cwd).filter(Boolean))];
    const read = this.deps.readLocalGit ?? github.readLocalGit;
    const results = new Map();
    // Latest activity per worktree: new agent work invalidates its cached
    // untracked scan. Worktrees out of scope drop out of the cache.
    const activity = new Map();
    for (const thread of inScope) {
      if (thread.cwd && String(thread.lastActivityAt ?? "") > String(activity.get(thread.cwd) ?? "")) activity.set(thread.cwd, thread.lastActivityAt);
    }
    this.untrackedCache ??= new Map();
    for (const cwd of this.untrackedCache.keys()) if (!cwds.includes(cwd)) this.untrackedCache.delete(cwd);
    const now = this.now();
    try {
      const values = await withTimeout(mapLimit(cwds, GIT_CONCURRENCY, (cwd) => read(cwd, config, {
        run, cache: this.untrackedCache, activityAt: activity.get(cwd) ?? null, now
      })), SOURCE_TIMEOUT_MS, "git");
      cwds.forEach((cwd, index) => { if (values[index]) results.set(cwd, values[index]); });
    } catch (error) {
      sourceErrors.git = clampText(error?.message, 200);
    }
    for (const thread of inScope) {
      const git = results.get(thread.cwd);
      if (!git) continue;
      thread.repo ??= git.remote ?? null;
      if (!thread.branch && git.branch && git.branch !== "HEAD") thread.branch = git.branch;
    }
    return results;
  }

  // eligible: every discovered thread the scan could read, deferred ones too.
  async resolvePrRefs(inScope, localGit, config, run, sourceErrors, eligible = inScope) {
    if (this.skip.github) return;
    const find = this.deps.findPrForBranch ?? github.findPrForBranch;
    const now = this.now();
    // prLookedUp: this thread's PR is known to be none (nothing to look up,
    // or GitHub answered no PR). Policy judges no-PR threads only then.
    // A Conductor chat's created PRs may all be done: its workspace
    // branch's PR joins them as a candidate (pickConductorPr). Whether
    // that branch has none is noted (branchNoPr) for when none of the
    // created ones is a PR either.
    const noPr = (thread) => {
      if (thread.prRefs?.length) thread.branchNoPr = true;
      else thread.prLookedUp = true;
    };
    // A branch never looked up since start (all of them on the first scan
    // after a restart) has its own budget, so a restart is not two scans of
    // threads with no PR (a93b6870's #7621, 01a0f89f's #7163 on the 10-12
    // replay). Refreshes of a known branch share the smaller one.
    const spent = { first: 0, refresh: 0 };
    const lastAt = (thread) => this.branchLookups.get(`${thread.repo}:${thread.branch}`)?.at ?? -Infinity;
    const hasRefs = (thread) => (thread.prRefs?.length ? 1 : 0);
    // Unseen branches precede expired negative results, then oldest first;
    // a thread with no PR at all before a chat whose created PRs stand in.
    const candidates = [...inScope].sort((a, b) => lastAt(a) - lastAt(b) || hasRefs(a) - hasRefs(b));
    // A checkout several chats work in (one main clone, not a worktree each)
    // has one branch at a time, and every chat there records it: its PR is
    // none of theirs in particular. 21 Codex chats in one clone were all told
    // to finish its open PR. Such a chat's PR is only one it linked itself.
    // Counted by checkout root, so chats in two of its subfolders share it,
    // and over every eligible chat: one a capped scan deferred still shares
    // it. Its git was not read this scan, so the root last read for its
    // folder stands in; never a containing folder's root (a nested worktree
    // is its own checkout).
    this.gitRoots ??= new Map();
    const eligibleKeys = new Set([...inScope, ...eligible].map((thread) => thread.key));
    for (const key of this.gitRoots.keys()) if (!eligibleKeys.has(key)) this.gitRoots.delete(key);
    for (const thread of inScope) {
      const root = thread.cwd ? localGit.get(thread.cwd)?.root : null;
      if (root) this.gitRoots.set(thread.key, { cwd: thread.cwd, root });
    }
    const scopeKeys = new Set(inScope.map((thread) => thread.key));
    const checkoutOf = (thread) => {
      if (!thread.cwd) return null;
      const known = scopeKeys.has(thread.key) ? null : this.gitRoots.get(thread.key);
      return localGit.get(thread.cwd)?.root ?? (known?.cwd === thread.cwd ? known.root : null) ?? path.resolve(thread.cwd);
    };
    const perCheckout = new Map();
    for (const thread of new Set([...inScope, ...eligible])) {
      const checkout = checkoutOf(thread);
      if (checkout) perCheckout.set(checkout, (perCheckout.get(checkout) ?? 0) + 1);
    }
    const jobs = new Map();
    for (const thread of candidates) {
      if (thread.prRefs?.length && thread.kind !== "conductor") continue;
      // No branch, or a trunk one: no PR to find. A missing repo (git could
      // not be read) leaves it unknown.
      if (!thread.branch || TRUNK_BRANCHES.has(thread.branch)) { noPr(thread); continue; }
      if (!thread.repo) continue;
      if (thread.kind !== "conductor" && perCheckout.get(checkoutOf(thread)) > 1) continue;
      const cacheKey = `${thread.repo}:${thread.branch}`;
      // The local head tells a reused branch's new work from its old closed
      // PR, so a new head is a new lookup.
      const git = localGit.get(thread.cwd);
      const head = git?.branch === thread.branch ? (git.head ?? null) : null;
      const cached = this.branchLookups.get(cacheKey);
      const fresh = cached && now - cached.at < BRANCH_LOOKUP_TTL_MS;
      const kind = cached ? "refresh" : "first";
      const spentOut = spent[kind] >= (cached ? MAX_BRANCH_LOOKUPS : MAX_NEW_BRANCH_LOOKUPS);
      // An unknown head (git failed) keeps the cached answer, and so does a
      // thread past this tick's lookup budget: the last answer beats none.
      if (fresh && (head === null || cached.head === head || spentOut)) {
        if (cached.ref) withBranchRef(thread, cached.ref);
        // No PR for this same head only (both unknown counts as the same):
        // a git failure after a known head, or a spent budget with a newer
        // head, leaves the answer unknown.
        else if (cached.head === head) noPr(thread);
        continue;
      }
      // Another thread on the same branch and head already asks.
      const lookupKey = `${cacheKey}\n${head ?? ""}`;
      if (jobs.has(lookupKey)) { jobs.get(lookupKey).threads.push(thread); continue; }
      if (spentOut) {
        // An expired PR still beats none; an expired "no PR" is unknown.
        if (cached?.ref) withBranchRef(thread, cached.ref);
        continue;
      }
      spent[kind] += 1;
      jobs.set(lookupKey, { repo: thread.repo, branch: thread.branch, head, cwd: head ? thread.cwd : null, cacheKey, cached, threads: [thread] });
    }
    const list = [...jobs.values()];
    await mapLimit(list, BRANCH_LOOKUP_CONCURRENCY, async (job) => {
      try {
        job.ref = (await withTimeout(Promise.resolve(find(job.repo, job.branch, config, { run, head: job.head, cwd: job.cwd })), 20_000, "pr lookup")) ?? null;
        job.ok = true;
      } catch (error) {
        job.error = error;
      }
    });
    for (const job of list) {
      if (job.ok) this.branchLookups.set(job.cacheKey, { ref: job.ref, at: now, head: job.head });
      else sourceErrors.prLookup = clampText(job.error?.message, 200);
      const ref = job.ok ? job.ref : job.cached?.ref;
      for (const thread of job.threads) {
        if (ref) withBranchRef(thread, ref);
        else if (job.ok) noPr(thread);
      }
    }
  }

  // A thread linking several PRs is about the newest open one: a merged PR
  // it linked before is done. Each thread's newest MAX_PR_CANDIDATES are
  // read for state only; a number GitHub says is no PR is dropped. With
  // nothing open, or GitHub unreadable, the newest stays first. A Conductor
  // chat that created a PR is read even for one (pickConductorPr): its
  // branch PR may lead, or the one it created may be no PR. GitHub
  // unreadable, it keeps the last pick (keepConductorPr).
  async preferOpenPrs(inScope, config, run) {
    if (this.skip.github) return;
    const conductorOwn = (thread) => thread.kind === "conductor" && (thread.createdPrRefs?.length ?? 0) > 0;
    const several = inScope.filter((thread) => conductorOwn(thread) || (thread.prRefs?.length ?? 0) > 1);
    const candidatesOf = (thread) => (conductorOwn(thread) ? [thread.branchPrRef, ...thread.createdPrRefs.slice(0, MAX_PR_CANDIDATES)] : [...thread.prRefs.slice(0, MAX_PR_CANDIDATES), thread.branchPrRef]);
    const wanted = [...new Set(several.flatMap(candidatesOf))]
      .filter((ref) => parsePrRef(ref) && !this.mergedPrs.has(ref));
    let states = new Map();
    if (wanted.length) {
      try {
        const fetch = this.deps.fetchPrStateLite ?? github.fetchPrStateLite;
        states = (await withTimeout(Promise.resolve(fetch(wanted, config, { run })), SOURCE_TIMEOUT_MS, "github")) ?? new Map();
      } catch {
        for (const thread of several) if (conductorOwn(thread)) keepConductorPr(thread, this.conductorPicks.get(thread.key));
        return;
      }
    }
    const picks = new Map();
    for (const [ref, pr] of states) if (pr?.state === "MERGED") this.mergedPrs.add(ref);
    if (this.mergedPrs.size > MAX_MERGED_KEPT) this.mergedPrs = new Set([...this.mergedPrs].slice(-MAX_MERGED_KEPT / 2));
    for (const thread of several) {
      const candidates = [...new Set([...thread.prRefs.slice(0, MAX_PR_CANDIDATES), thread.branchPrRef].filter(Boolean))];
      const state = (ref) => (this.mergedPrs.has(ref) ? "MERGED" : states.has(ref) ? (states.get(ref)?.state ?? null) : undefined);
      if (conductorOwn(thread)) {
        pickConductorPr(thread, state);
        if (thread.prRefs[0]) picks.set(thread.key, thread.prRefs[0]);
        continue;
      }
      const open = candidates.find((ref) => state(ref) === "OPEN");
      // null: GitHub answered that the number is no PR.
      const kept = thread.prRefs.filter((ref) => state(ref) !== null);
      thread.prRefs = open ? [open, ...kept.filter((ref) => ref !== open)] : kept;
    }
    this.conductorPicks = picks;
  }

  // The thread's PR read again right before a nudge: one merged or closed
  // since the scan cancels it (monrovia was told #7589 was not ready 2 s
  // after it merged), and so does a nudge about a PR already settled
  // (madrid heard about #7586's BuildBot3 run 76 min after it merged).
  // Null to send; an unreadable PR sends as the scan decided.
  async prSettledBeforeSend(thread, pr, decision) {
    const ref = pr?.ref ?? thread?.prRefs?.[0] ?? null;
    const parsed = parsePrRef(ref);
    if (!parsed || this.skip.github || POST_MERGE_PLAYBOOKS.has(decision.playbook)) return null;
    let fresh;
    try {
      const fetch = this.deps.fetchPrStateLite ?? github.fetchPrStateLite;
      fresh = (await withTimeout(Promise.resolve(fetch([ref], this.config, { run: this.deps.run ?? runCommand })), PRE_SEND_PR_MS, "github"))?.get(ref);
    } catch {
      return null;
    }
    if (!SETTLED_PR_STATES.has(fresh?.state)) return null;
    const since = !SETTLED_PR_STATES.has(pr?.state);
    const about = PR_PLAYBOOKS.has(decision.playbook)
      || (!NOT_ABOUT_PR_PLAYBOOKS.has(decision.playbook) && new RegExp(`#${parsed.number}\\b`).test(String(decision.message ?? "")));
    const reviewedPostMerge = decision.playbook === "idle-report" && decision.requiresJudge === true
      && decision.judged === true && pr?.state === "MERGED" && fresh.state === "MERGED";
    if (!since && (!about || reviewedPostMerge)) return null;
    return `#${parsed.number} ${fresh.state.toLowerCase()}${since ? " since the scan" : ""}`;
  }

  async fetchPrs(inScope, config, run, sourceErrors, unread = new Set(), extraRefs = []) {
    if (this.skip.github) return new Map();
    const refs = [...new Set([...inScope.map((thread) => thread.prRefs?.[0]), ...extraRefs].filter((ref) => parsePrRef(ref)))];
    if (!refs.length) return new Map();
    try {
      const fetch = this.deps.fetchPrStates ?? github.fetchPrStates;
      return (await withTimeout(Promise.resolve(fetch(refs, config, { run, unread })), SOURCE_TIMEOUT_MS, "github")) ?? new Map();
    } catch (error) {
      sourceErrors.github = clampText(error?.message, 200);
      for (const ref of refs) unread.add(ref);
      return new Map();
    }
  }

  // MERGED and CLOSED are final. A ref GitHub could not answer this tick
  // keeps its last settled read, so an ask its merge settled is not raised
  // again as a new question. Only refs linked this tick stay remembered.
  withSettledPrs(prs, unread) {
    const out = new Map(prs);
    const kept = new Map();
    for (const [ref, pr] of prs) if (SETTLED_PR_STATES.has(pr?.state)) kept.set(ref, pr);
    for (const ref of unread) {
      const last = this.settledPrs.get(ref);
      if (!last) continue;
      kept.set(ref, last);
      out.set(ref, last);
    }
    this.settledPrs = kept;
    return out;
  }

  async act(decisions, { mode, byKey, manager, started, config, items = [], prs = new Map(), unreadPrs = new Set(), unknownKinds = new Set(), unknownPrefixes = [], cappedKinds = new Set(), cardScanned = new Set(), deferUi = false, skipReview = false, storageUnknown = false, deferred = new Set(), threadFacts = new Map() }) {
    const store = this.store;
    const fromFailedSource = (keys) => keys.some((key) => unknownKinds.has(String(key ?? "").split(":")[0]) || unknownPrefixes.some((prefix) => String(key ?? "").startsWith(prefix)));
    // A thread whose git read or PR fetch failed this tick is unknown too: its
    // PR question must not close now and come back as a new push next tick.
    const gitUnknown = new Set(items.filter((item) => item.gitUnreadable || item.prUnreadable).map(({ thread }) => thread.key));
    const historyUnknown = new Set([...byKey.values()].filter((thread) => thread?.excluded === "history-unavailable").map((thread) => thread.key));
    // A thread a capped scan deferred or whose history read is still pending was not reassessed either.
    const unknown = (keys) => fromFailedSource(keys) || keys.some((key) => gitUnknown.has(key) || historyUnknown.has(key) || deferred.has(key));
    // With no settled read remembered (a fresh start), an unread PR cannot
    // tell a merge that settled an ask from a live one: an ask the
    // supervisor already closed waits for GitHub instead of coming back.
    const prUnknown = new Set(items.filter((item) => item.prUnreadable).map(({ thread }) => thread.key));
    const at = new Date(started).toISOString();
    const asked = new Set();
    const openActions = store.actions(config.limits.maxActionsKept).filter((action) => OPEN_ACTION.has(action.status));
    const seenActions = new Set();
    let sends = 0;
    // Threads a send was tried for this tick, whatever the outcome.
    const attempted = new Set();
    // One app thread can back two fleet threads (a Conductor session and the
    // Codex thread it hosts): type into it at most once per tick.
    const typedInto = new Set();
    const autoAnsweredThreads = new Set();

    // Auto-failover quota-exhausted or logged-out Paseo sessions onto a ready
    // alternate provider (Claude / Antigravity) in the exact same workspace cwd.
    const failedOverKeys = new Set();
    if (this.mode === "auto") {
      let failoversThisTick = 0;
      for (const { thread, classified } of items) {
        if (failoversThisTick >= 2) break;
        if (!thread?.key || thread.kind !== "paseo" || thread.excluded || thread.archived) continue;
        if (store.mutedUntil(thread.key)) continue;
        if (classified?.state !== "infra-blocked") continue;
        if (!["usage-limit", "session-limit", "model-limit", "logged-out"].includes(String(classified?.infraKind ?? ""))) continue;
        const resetAtMs = Date.parse(thread.error?.resetAt ?? "");
        if (Number.isFinite(resetAtMs) && resetAtMs > started && resetAtMs - started <= 20 * MIN) continue;
        // Already handed off for this same failure: the replacement owns the
        // work now, even after the old session's mute expires.
        if (store.providerFailoverFor(thread.key)?.failureSig === failoverSignature(thread)) continue;
        const switched = await this.switchPaseoProvider(thread.key, {
          reason: classified.reason || thread.error?.text || "usage limit reached"
        });
        if (switched?.ok) {
          failoversThisTick += 1;
          sends += 1;
          failedOverKeys.add(thread.key);
          autoAnsweredThreads.add(thread.key);
        }
      }
    }

    // A Codex question card is asked beside the thread's own decision.
    const asks = decisions
      .filter((decision) => !failedOverKeys.has(decision.threadKey))
      .flatMap((decision) => [
        ...(decision.action === "ask-user" && decision.question ? [decision] : []),
        ...(decision.cardQuestion ? [{ ...decision, action: "ask-user", question: decision.cardQuestion, playbook: null }] : [])
      ]);
    // Surface unreviewed session completions and errors ("a chat isn't done
    // until marked done or archived") whenever Paseo flags requiresAttention
    // ("finished" / "error") or completionCards is explicitly enabled.
    const askedThreadKeys = new Set([
      ...failedOverKeys,
      ...asks.flatMap((a) => [a.threadKey, ...(a.question?.threadKeys ?? [])]).filter(Boolean)
    ]);
    for (const { thread, classified, pr: itemPr } of items) {
      if (!thread?.key || thread.excluded || thread.archived) continue;
      if (askedThreadKeys.has(thread.key) || store.mutedUntil(thread.key)) continue;
      if (!classified || classified.state === "running" || classified.state === "waiting-ci") continue;

      const activeGoal = this.activeWork.findActiveGoalForThread(thread.key, thread.prRefs?.[0] ?? null);
      const attnReason = thread.meta?.requiresAttention === true ? String(thread.meta?.attentionReason ?? "") : "";
      const isErr = attnReason === "error" || Boolean(thread.error);

      // Historical owner precedent recovery nudges (e.g. AppFolio -> buildbetter-staging MCP,
      // TestFlight MISSING_EXPORT_COMPLIANCE, transient stream disconnect).
      if (
        this.mode === "auto"
        && !decisions.some((d) => d.threadKey === thread.key && SENDING.has(d.action))
      ) {
        const ledger = store.ledgerFor(thread.key);
        const lastNudgeMs = Date.parse(ledger.nudges.at(-1)?.at ?? "") || 0;
        const cooldownOk = started - lastNudgeMs >= config.limits.nudgeCooldownMs
          && (ledger.nudgesSinceProgress ?? 0) < config.limits.maxNudgesWithoutProgress;
        const route = cooldownOk ? chooseRoute(thread, "auto", this.lastDelivery) : null;
        if (route) {
          const precNudge = await this.precedentMemory.evaluateCandidate(
            { thread, pr: itemPr, classified, activeGoal },
            { decisionsConfig: this.config.decisions, env: this.deps.env ?? process.env, fetchImpl: this.deps.decisionsFetch ?? this.deps.fetchImpl }
          );
          if (precNudge?.matched && precNudge.action === "nudge" && precNudge.directive) {
            decisions.push({
              threadKey: thread.key,
              state: classified.state,
              action: "nudge",
              playbook: `precedent:${precNudge.precedentId}`,
              route,
              judged: true,
              reason: precNudge.summary,
              message: precNudge.directive,
              precedentMeta: {
                precedentId: precNudge.precedentId,
                summary: precNudge.summary,
                confidence: precNudge.confidence,
                source: precNudge.source
              }
            });
            askedThreadKeys.add(thread.key);
            continue;
          }
        }
      }

      // Suppress premature "finished / Got it" completion receipts while an ActiveWork
      // goal for this session is still unverified, and resume if permittedNudges === "resume_owner".
      if (!isErr && activeGoal && !activeGoal.outcomeVerified) {
        if (
          this.mode === "auto"
          && activeGoal.permittedNudges === "resume_owner"
          && goalAcceptsAutoContinuation(activeGoal, started)
          && ["idle-no-pr", "done"].includes(classified.state)
          && !decisions.some((d) => d.threadKey === thread.key && SENDING.has(d.action))
        ) {
          const ledger = store.ledgerFor(thread.key);
          const lastNudgeMs = Date.parse(ledger.nudges.at(-1)?.at ?? "") || 0;
          const cooldownOk = started - lastNudgeMs >= config.limits.nudgeCooldownMs
            && (ledger.nudgesSinceProgress ?? 0) < config.limits.maxNudgesWithoutProgress;
          const route = cooldownOk ? chooseRoute(thread, "auto", this.lastDelivery) : null;
          if (route) {
            const cursorNote = activeGoal.cursor?.remaining != null
              ? ` (${activeGoal.cursor.remaining} remaining)`
              : (Number.isInteger(activeGoal.remainingCount) && activeGoal.remainingCount > 0 ? ` (${activeGoal.remainingCount} remaining)` : "");
            decisions.push({
              threadKey: thread.key,
              state: classified.state,
              action: "nudge",
              playbook: "goal-continuation",
              route,
              judged: true,
              reason: `active goal unverified${cursorNote}: ${clampText(activeGoal.goal, 120)}`,
              message: `Active goal continuation${cursorNote}: "${clampText(activeGoal.goal, 260)}". Definition of Done: "${clampText(activeGoal.doneCriteria || "Verify all in-scope items are complete", 260)}". Continue the next batch or remaining verification steps until Done Criteria is met (do not merge PRs, deploy to production, send external customer messages, or spend money without owner approval). If blocked on the owner, state the exact decision needed.`
            });
          }
        }
        continue;
      }

      const isPaseoAttention = attnReason === "finished" || attnReason === "error";
      const isConfiguredCompletion = this.config?.completionCards === true
        && ["idle-no-pr", "done"].includes(classified.state)
        && Boolean(thread.lastAgentAt && (!thread.lastUserAt || Date.parse(thread.lastAgentAt) >= Date.parse(thread.lastUserAt)));
      if (!isPaseoAttention && !isConfiguredCompletion) continue;
      const bodySource = stripAgentInternalMarkup(thread.error?.text || thread.lastAgentFull || thread.lastAgentText || "");
      if (!bodySource) continue;
      const stampIso = thread.lastAgentAt || thread.lastActivityAt || null;
      const stampMs = Date.parse(stampIso ?? "") || 0;
      const reviewedMs = store.reviewedCompletionAt(thread.key);
      if (reviewedMs > 0 && stampMs > 0 && reviewedMs >= stampMs - 500) continue;
      const qKind = isErr ? "session-error" : "completed";
      const label = clampText(redactSecrets(thread.title || thread.workspace || thread.key), 72);
      asks.push({
        threadKey: thread.key,
        action: "ask-user",
        playbook: null,
        question: {
          kind: qKind,
          dedupeKey: `${qKind}:${thread.key}:${stampIso || "latest"}`,
          threadKey: thread.key,
          prRef: thread.prRefs?.[0] ?? null,
          title: isErr ? `${label}: session hit an error` : `${label}: finished`,
          body: clampTailLines(redactSecrets(bodySource), 900),
          options: ["Got it"],
          ...(thread.meta?.hasPlanArtifact ? { meta: { hasPlanArtifact: "true" } } : {})
        }
      });
      askedThreadKeys.add(thread.key);
    }

    // Surface green non-draft ready/orphan PRs tracked in ActiveWork into Needs You
    // even when their original coding thread aged out of the 32-thread shortlist.
    try {
      const awItems = this.activeWork.getActiveWork({ limit: 60 })?.items ?? [];
      const coveredPrRefs = new Set(
        asks
          .map((a) => String(a.question?.prRef ?? "").toLowerCase())
          .filter(Boolean)
      );
      for (const aw of awItems) {
        if (!["ready_pr", "orphan_pr"].includes(aw?.followThroughState ?? aw?.category) || !aw?.prRef) continue;
        const lowerRef = String(aw.prRef).toLowerCase();
        if (coveredPrRefs.has(lowerRef)) continue;
        const livePr = prs.get(aw.prRef) ?? this.lastPrs.get(aw.prRef) ?? null;
        const prState = livePr?.state ?? aw.prState;
        const isDraft = livePr?.isDraft ?? aw.prIsDraft ?? aw.isDraft ?? false;
        const ciState = livePr?.ci?.state ?? aw.prCiState ?? aw.ciState;
        if (prState !== "OPEN" || isDraft || ciState !== "SUCCESS") continue;
        const parsedPr = parsePrRef(aw.prRef);
        if (!parsedPr) continue;
        asks.push({
          threadKey: aw.owner?.threadKey ?? null,
          action: "ask-user",
          playbook: null,
          question: {
            kind: "ready",
            dedupeKey: `ready:${aw.prRef}`,
            threadKey: aw.owner?.threadKey ?? null,
            prRef: aw.prRef,
            project: aw.project ?? null,
            title: `PR #${parsedPr.number} ready for merge review: ${clampText(redactSecrets(livePr?.title || aw.goal || aw.prRef), 100)}`,
            body: clampText(
              redactSecrets(
                `CI is green on ${aw.prRef}${aw.goal ? ` (Goal: ${aw.goal})` : ""}. Spencer reviews every merge — inspect the PR diff and merge when satisfied.`
              ),
              600
            ),
            options: ["Check PR", "skip"]
          }
        });
        coveredPrRefs.add(lowerRef);
      }
    } catch { /* ActiveWork ready-PR surfacing is best-effort */ }
    // One the last review could not settle yet is still new.
    const shownBefore = new Set(store.openQuestions().map((question) => question.id).filter((id) => !this.awaitingReview.has(id)));
    const toNotify = [];
    this._lastTickAutoResolved = [];
    // A grouped question's member that a capped scan deferred keeps its seat
    // until it is read again: the group is rebuilt with it, not without it.
    const decidedKeys = new Set(decisions.map((decision) => decision.threadKey));
    const carried = new Map();
    for (const question of deferred.size ? store.openQuestions() : []) {
      const kind = Object.keys(GROUPED_KINDS).find((name) => String(question.dedupeKey ?? "").replace(/:\d+$/, "") === GROUPED_KINDS[name].dedupeKey);
      if (!kind || question.threadKey) continue;
      for (const key of question.threadKeys ?? []) {
        if (deferred.has(key) && !decidedKeys.has(key)) carried.set(key, { threadKey: key, action: "ask-user", playbook: null, carried: true, question: { kind, options: GROUPED_KINDS[kind].options } });
      }
    }
    for (const fields of groupQuestions([...asks, ...carried.values()], byKey)) {
      // Rebuilt without a failed source's threads, a group would drop them,
      // or shrink to one thread and ask it twice; the open group stays as it
      // is until that source reads again.
      const spec = (unknownKinds.size || unknownPrefixes.length) ? GROUPED_KINDS[fields.kind] : null;
      const covers = (q) => (fields.threadKeys ? true : (q.threadKeys ?? []).includes(fields.threadKey));
      const sameChoices = spec && (fields.threadKeys || JSON.stringify(fields.options) === JSON.stringify(spec.options));
      const open = sameChoices ? store.openQuestions().find((q) => String(q.dedupeKey ?? "").replace(/:\d+$/, "") === spec.dedupeKey && covers(q)) : null;
      if (open && fromFailedSource(open.threadKeys ?? [])) { asked.add(open.dedupeKey); continue; }
      if (fields.kind === "agent-ask" && prUnknown.has(fields.threadKey) && store.resolvedOnly(fields.dedupeKey)) continue;
      // The head it is asked at: a move past it settles the ask (settledAsk).
      const askThread = fields.threadKey ? (byKey.get(fields.threadKey) ?? this.knownThreads.get(fields.threadKey) ?? null) : null;
      const askPrRef = fields.prRef ?? askThread?.prRefs?.[0] ?? null;
      const matchesAskPr = (candidate) => Boolean(candidate && (!askPrRef || !candidate.ref || candidate.ref === askPrRef));
      const itemPr = items.find((item) => (askPrRef && item?.pr?.ref === askPrRef) || (!askPrRef && fields.threadKey && item?.thread?.key === fields.threadKey))?.pr ?? null;
      const lastThreadPr = fields.threadKey ? this.lastPrs.get(fields.threadKey) : null;
      const askPr = (askPrRef ? prs.get(askPrRef) : null) ?? (matchesAskPr(itemPr) ? itemPr : null) ?? (matchesAskPr(lastThreadPr) ? lastThreadPr : null) ?? null;
      const contextSnapshot = buildQuestionContextSnapshot(askThread, askPr);
      const question = store.upsertQuestion({ ...fields, askedHead: askPr?.headOid ?? (fields.prRef ? prs.get(fields.prRef)?.headOid ?? null : null), contextSnapshot });
      asked.add(question.dedupeKey);
      // The owner (or an earlier automatic slice) already answered or dismissed this one; stay quiet.
      if (question.suppressed) continue;
      // Progressive preference slices: ONLY when the owner explicitly made a
      // safe routine slice automatic (never merges or risky asks) and mode is auto.
      if (this.mode === "auto" && fields.kind === "agent-ask" && fields.threadKey && !fields.mergeAsk && !store.mutedUntil(fields.threadKey)) {
        const slice = classifyQuestionSlice(fields);
        const prefs = store.preferences();
        const autoChoice = slice && prefs.autoSlices?.[slice] === "auto" ? pickAffirmativeOption(fields.options) : null;
        const targetThread = autoChoice ? byKey.get(fields.threadKey) : null;
        const route = targetThread ? chooseRoute(targetThread, "auto", this.lastDelivery) : null;
        const uiKey = route === "computer-use" && targetThread ? uiTargetFor(targetThread)?.targetKey ?? null : null;
        if (autoChoice && targetThread && route && sends < config.limits.maxSendsPerTick && !(deferUi && route === "computer-use") && !(uiKey && typedInto.has(uiKey))) {
          const delivery = await this.executor.deliver({ thread: targetThread, message: ownerDelivery(autoChoice), route, playbook: "owner-answer" });
          if (delivery.status === "sent") {
            sends += 1;
            attempted.add(targetThread.key);
            autoAnsweredThreads.add(targetThread.key);
            if (uiKey) typedInto.add(uiKey);
            store.answerQuestion(question.id, autoChoice);
            this.resolveOutreach(question, autoChoice, "acted");
            store.recordNudge(targetThread.key, { playbook: "owner-answer", route: delivery.route ?? route, status: "owner-answer" });
            const { prefs: updatedPrefs, record: autoRecord } = recordAutonomousSliceAction(prefs, {
              slice,
              threadKey: targetThread.key,
              summary: clampText(`${fields.title} -> ${autoChoice}`, 160),
              now: started
            });
            store.savePreferences(updatedPrefs);
            const actionRecord = store.recordAction({
              kind: "nudge",
              playbook: `auto-slice:${slice}`,
              threadKey: targetThread.key,
              route: delivery.route ?? route,
              status: "sent",
              reason: clampText(`autonomous preference (${slice}): ${fields.title}`, 240),
              at
            });
            if (delivery.done) {
              this.reopenIfUndelivered(
                question.id,
                [delivery.done.then((reached) => {
                  if (reached) return null;
                  const latestPrefs = store.preferences();
                  const entry = latestPrefs.autonomousActions.find((a) => a.id === autoRecord.id);
                  if (entry) {
                    entry.reverted = true;
                    store.savePreferences(latestPrefs);
                  }
                  if (actionRecord?.id) {
                    store.updateAction(actionRecord.id, { status: "failed", detail: "background delivery failed" });
                  }
                  return targetThread.key;
                })],
                autoChoice
              );
            }
            continue;
          }
        }
      }
      // Historical Owner-Decision Precedent Engine: auto-resolve read-only permissions
      // (`prec_readonly_bash`) and high-confidence (`>= 0.85`) historical owner precedents
      // without ever crossing Hard Red Lines (merges, prod deploys, external sends, spend, deletes, SSO).
      if (
        this.mode === "auto"
        && ["prompt", "agent-ask", "agent-card"].includes(fields.kind)
        && fields.threadKey
        && !fields.mergeAsk
        && !store.mutedUntil(fields.threadKey)
        && sends < config.limits.maxSendsPerTick
      ) {
        const askActiveGoal = this.activeWork.findActiveGoalForThread(fields.threadKey, askPrRef);
        const precMatch = await this.precedentMemory.evaluateCandidate(
          { question, thread: askThread, pr: askPr, activeGoal: askActiveGoal },
          {
            decisionsConfig: this.config.decisions,
            env: this.deps.env ?? process.env,
            fetchImpl: this.deps.decisionsFetch ?? this.deps.fetchImpl
          }
        );
        if (precMatch?.matched && precMatch.action === "answer" && precMatch.answer) {
          const targetThread = byKey.get(fields.threadKey) ?? askThread;
          const route = targetThread ? chooseRoute(targetThread, "auto", this.lastDelivery) : null;
          const uiKey = route === "computer-use" && targetThread ? uiTargetFor(targetThread)?.targetKey ?? null : null;
          if (targetThread && route && !(deferUi && route === "computer-use") && !(uiKey && typedInto.has(uiKey))) {
            const msg = fields.kind === "prompt" ? precMatch.answer : ownerDelivery(precMatch.answer);
            const sent = await this.deliverToAsker(question, precMatch.answer, msg, {
              startedAt: started,
              ownerChoice: precMatch.answer
            });
            if (sent?.delivery?.status === "sent") {
              sends += 1;
              attempted.add(targetThread.key);
              autoAnsweredThreads.add(targetThread.key);
              this._lastTickAutoResolved.push(clampText(precMatch.summary, 110));
              if (uiKey) typedInto.add(uiKey);
              store.answerQuestion(question.id, precMatch.answer);
              this.resolveOutreach(question, precMatch.answer, "acted");
              this.precedentMemory.recordApplication({
                precedentId: precMatch.precedentId,
                threadKey: targetThread.key,
                summary: precMatch.summary,
                confidence: precMatch.confidence,
                source: precMatch.source
              });
              store.recordAction({
                kind: "nudge",
                playbook: `precedent:${precMatch.precedentId}`,
                threadKey: targetThread.key,
                route: sent.delivery.route ?? route,
                status: "sent",
                reason: clampText(precMatch.summary, 240),
                at
              });
              continue;
            }
          }
        }
      }
      toNotify.push({ id: question.id, reopened: Boolean(question.reopened) });
    }
    // Rebuilt with its carried members, a group can need fewer chunks: an
    // older chunk not asked again whose members all sit in a chunk of the
    // same kind asked now, or were read and cleared, is superseded, so no
    // thread is in two open groups (and resumed twice).
    if (carried.size) {
      const kindOf = (question) => (question.threadKey ? null : Object.keys(GROUPED_KINDS).find((name) => String(question.dedupeKey ?? "").replace(/:\d+$/, "") === GROUPED_KINDS[name].dedupeKey));
      const regrouped = new Map();
      for (const question of store.openQuestions()) {
        const kind = kindOf(question);
        if (!kind || !asked.has(question.dedupeKey)) continue;
        for (const key of question.threadKeys ?? []) regrouped.set(`${kind}|${key}`, true);
      }
      for (const question of store.openQuestions()) {
        const kind = kindOf(question);
        if (!kind || asked.has(question.dedupeKey) || !question.threadKeys?.length) continue;
        if (!question.threadKeys.some((key) => regrouped.has(`${kind}|${key}`))) continue;
        if (!question.threadKeys.every((key) => regrouped.has(`${kind}|${key}`) || !unknown([key]))) continue;
        store.resolveQuestion(question.id, "regrouped: its threads moved to another group");
        this.resolveOutreach(question, "resolved", "dismissed");
      }
    }
    // The supervisor reviews its own list before a new question reaches the
    // owner, so junk never pings; the main does not see it before then either.
    this.awaitingReview = this.config.review?.enabled
      ? new Set(toNotify.map(({ id }) => id).filter((id) => !shownBefore.has(id) && !bypassesBackgroundReview(store.question(id))))
      : new Set();
    let unsettled = new Set();
    try {
      // A scan the idle watcher started is for sends: the review waits for
      // the next scheduled one, and new questions stay held until then.
      unsettled = skipReview ? new Set(this.awaitingReview) : await this.reviewOpenQuestions({ asked, byKey, items });
    } finally {
      // A new one the review did not get to (the batch cap, a deferred
      // close) waits for the next review; a failed review lets all out.
      this.awaitingReview = new Set([...this.awaitingReview].filter((id) => unsettled.has(id)));
    }
    const notifyPrefs = store.preferences();
    for (const { id, reopened } of toNotify) {
      const question = store.question(id);
      if (question?.status !== "open" || this.awaitingReview.has(id)) continue;
      if (isSuppressedByQuietCadence(question, notifyPrefs)) continue;
      const keys = question.threadKeys ?? (question.threadKey ? [question.threadKey] : []);
      if (keys.length && keys.every((key) => store.mutedUntil(key))) continue;
      // A blip closed it: its own outreach copy comes back, not a new one.
      if (reopened) this.reopenOutreach(question);
      try { await this.notifier.notifyQuestion(question); } catch { /* notification is best-effort */ }
    }

    // How long an idle-watcher scan takes to reach its sends: the watcher
    // starts the next one that much before the owner is away long enough.
    if (skipReview) this.awayLeadMs = this.now() - started;
    // A thread that just got the owner's answer gets no automatic nudge too.
    const answeredNow = await this.deliverQueuedAnswers({
      byKey, started, cappedKinds, asked, sourceUnknown: fromFailedSource, budget: config.limits.maxSendsPerTick, deferUi,
      decided: new Set(items.map((item) => item.thread.key))
    });
    // Kept answers share the tick's send budget, and their app conversations
    // (a Conductor tab and the Codex thread it hosts) get nothing else now.
    sends += answeredNow.sent;
    for (const key of answeredNow.uiKeys) typedInto.add(key);
    // Chats an app restart stopped get their one resume, and nothing else now.
    const restartedNow = await this.resumeAfterRestart({ byKey, started, deferUi, sourceUnknown: fromFailedSource });
    sends += restartedNow.sent;
    for (const key of restartedNow.uiKeys) typedInto.add(key);
    for (const key of restartedNow.threads) answeredNow.threads.add(key);
    for (const key of autoAnsweredThreads) answeredNow.threads.add(key);

    // Resumes first, then the thread tried longest ago, so a few threads that
    // cannot be reached never hold every slot while a stopped one waits.
    const lastTried = (decision) => Date.parse(store.ledgerFor(decision.threadKey).nudges.at(-1)?.at ?? "") || 0;
    const sendOrder = decisions
      .map((decision, index) => ({ decision, index, first: SEND_FIRST.has(decision.playbook) ? 0 : 1, tried: lastTried(decision) }))
      .sort((a, b) => a.first - b.first || a.tried - b.tried || a.index - b.index)
      .map(({ decision }) => decision);
    // Only a send that got past the app's checks spends a slot; blocked tries
    // are cheap but still bounded.
    let tries = 0;
    // A computer-use send that timed out or lost Open Computer Use leaves
    // the app agent busy or restarting: the rest of the tick's typing waits.
    let uiStalled = answeredNow.uiStalled === true;
    const judgeOn = (Boolean(this.nudgeJudge?.enabled) && typeof this.nudgeJudge?.judge === "function")
      || (Boolean(this.decisionsGate?.enabled) && typeof this.decisionsGate?.evaluateBatch === "function");
    for (const decision of sendOrder) {
      if (!SENDING.has(decision.action) || !decision.message) continue;
      if (decision.notBefore && Date.parse(decision.notBefore) > started) continue;
      if (answeredNow.threads.has(decision.threadKey)) continue;
      const targetKey = decision.action === "escalate-manager" ? (decision.targetKey ?? manager?.key ?? null) : decision.threadKey;
      const target = targetKey ? byKey.get(targetKey) : null;
      const record = {
        threadKey: decision.threadKey, targetKey, playbook: decision.playbook, route: decision.route,
        head: items.find((item) => item.thread.key === decision.threadKey)?.pr?.headOid ?? null,
        message: decision.message, reason: decision.reason, progressMark: decision.progressMark ?? null, kind: decision.action,
        threadFacts: threadFacts.get(decision.threadKey) ?? null,
        ...(decision.judged ? { judged: true } : {}),
        ...(decision.requiresJudge ? { requiresJudge: true } : {}),
        ...(decision.messageHash ? { messageHash: decision.messageHash, factsKey: decision.factsKey ?? null, facts: decision.facts ?? null } : {})
      };
      const existing = openActions.find((action) => action.threadKey === record.threadKey && action.playbook === record.playbook);
      if (existing) seenActions.add(existing.id);

      // Contextual idle-review placeholders must never be recorded as planned/proposed
      // or sent without an explicit judge/decisions verdict in the current scan.
      if (decision.requiresJudge && !decision.judged) {
        decision.reason = `${decision.reason}; held: not judged this scan`;
        continue;
      }

      // The live mode, not the tick's: the owner may have left Auto mid-scan.
      const liveMode = this.mode;
      if (liveMode !== "auto" || !target || !decision.route) {
        const status = liveMode === "propose" && target && decision.route ? "proposed" : "planned";
        if (existing) store.updateAction(existing.id, { ...record, status, at });
        else store.recordAction({ ...record, status, at });
        continue;
      }
      if (sends >= config.limits.maxSendsPerTick || tries >= config.limits.maxSendsPerTick * 2) {
        decision.reason = `${decision.reason}; deferred: send cap`;
        continue;
      }
      if (uiStalled && decision.route === "computer-use") {
        decision.reason = `${decision.reason}; deferred: Open Computer Use stalled`;
        continue;
      }
      if (deferUi && decision.route === "computer-use") {
        decision.reason = `${decision.reason}; deferred: remote scan`;
        continue;
      }
      // The judge reads every automatic nudge first: one this scan did not
      // judge (the owner switched to Auto after judgeNudges ran) waits for
      // the next scan instead of going out unread.
      if (!decision.judged && (decision.requiresJudge || (judgeOn && judgeable(decision, target)))) {
        decision.reason = `${decision.reason}; held: not judged this scan`;
        continue;
      }
      const uiKey = decision.route === "computer-use" ? uiTargetFor(target)?.targetKey ?? null : null;
      if (uiKey && typedInto.has(uiKey)) continue;
      if (decision.action === "nudge") {
        const item = items.find((entry) => entry.thread.key === decision.threadKey);
        const settled = await this.prSettledBeforeSend(item?.thread ?? target, item?.pr ?? null, decision);
        if (settled) {
          const detail = `not sent: ${settled}`;
          if (existing) store.updateAction(existing.id, { ...record, status: "stale", detail, at });
          else store.recordAction({ ...record, status: "stale", detail, at });
          continue;
        }
      }
      // An owner answer that started after the judge read (during the
      // review, the notifications, the kept answers, an earlier send or the
      // PR read just above) goes first: checked again right before each send.
      if (decision.action === "nudge" && target?.meta?.paseoClosed) {
        decision.reason = `${decision.reason}; held: Paseo session sleeping`;
        continue;
      }
      if (decision.action === "nudge" && (this.pushing.has(decision.threadKey) || this.ownerAnswerThreads(started).has(decision.threadKey))) {
        decision.reason = `${decision.reason}; held: owner answered`;
        continue;
      }
      if (store.mutedUntil(decision.threadKey) || store.mutedUntil(targetKey)) {
        decision.reason = `${decision.reason}; held: muted by owner`;
        continue;
      }
      if (decision.action === "nudge" && repeatsLastSend(target, store.ledgerFor(decision.threadKey), decision.messageHash)) continue;
      if (uiKey) typedInto.add(uiKey);
      tries += 1;
      attempted.add(decision.threadKey);
      const sentAt = new Date(this.now()).toISOString();
      this.pushing.add(decision.threadKey);
      try {
        const delivery = await this.executor.deliver({ thread: target, message: decision.message, route: decision.route, playbook: decision.playbook, actionId: existing?.id ?? null });
        if ((delivery.route ?? decision.route) === "computer-use") this.noteUiResult(target, delivery);
        if (delivery.status !== "blocked") sends += 1;
        if (delivery.status === "sent" && decision.precedentMeta) {
          this.precedentMemory.recordApplication({
            ...decision.precedentMeta,
            threadKey: decision.threadKey
          });
        }
        if (decision.route === "computer-use" && UI_STALLED.test(String(delivery.detail ?? ""))) uiStalled = true;
        if (!existing && !delivery.actionId) store.recordAction({ ...record, status: delivery.status, detail: delivery.detail, at });
        else if (delivery.actionId) store.updateAction(delivery.actionId, { reason: record.reason, message: record.message, threadKey: record.threadKey, targetKey });
        this.recordSend(record, delivery, sentAt);
      } finally { this.pushing.delete(decision.threadKey); }
    }

    // A planned/proposed action the policy no longer wants is stale.
    // (Storage records its own plans; they are not tick decisions.)
    // A deferred thread's stands only while what discovery shows of it is
    // what the action was made on: one that moved on is stale too.
    // Owner policy applies to it as it would on a read: a mute ends it.
    const movedOn = (action) => deferred.has(action.threadKey) && (threadFacts.get(action.threadKey) !== action.threadFacts
      || Boolean(store.mutedUntil(action.threadKey) || (action.targetKey && store.mutedUntil(action.targetKey))));
    for (const action of openActions) {
      if (action.kind !== "storage" && !seenActions.has(action.id) && (!unknown([action.threadKey]) || movedOn(action))) store.updateAction(action.id, { status: "stale" });
    }
    // A question whose condition is gone closes itself once its thread was
    // decided again this tick without asking. An agent's own ask and a
    // ready PR stand until settled (settledAsk), whatever the state reads.
    for (const question of store.openQuestions()) {
      if (asked.has(question.dedupeKey)) continue;
      if (unknown(question.threadKeys ?? [question.threadKey])) continue;
      // A failed disk read is unknown: its questions wait for a good one.
      if (storageUnknown && String(question.dedupeKey ?? "").startsWith("infra:storage:")) continue;
      const decided = question.threadKey ? decisions.find((decision) => decision.threadKey === question.threadKey) : null;
      // The judge has not read this chat again yet: whether the agent still
      // asks is unknown, so its question stands.
      if (decided?.judgePending && question.askedBy === "judge") continue;
      const supervisorOwned = !question.threadKey && /^(infra:|limit:group|open:group|deliver:group)/.test(String(question.dedupeKey ?? ""));
      // Its thread left the scan (aged out of the lookback) or is now out of
      // scope, while its source read fine: nothing is left to answer. A
      // source that hit its cap only proves absence for excluded threads,
      // and for a card its complete card scan settled (no card open now).
      const known = question.threadKey ? byKey.get(question.threadKey) : null;
      const cardSettled = question.kind === "agent-card" && cardScanned.has(question.threadKey);
      const evictable = cappedKinds.has(String(question.threadKey ?? "").split(":")[0]) && !cardSettled;
      const threadGone = Boolean(question.threadKey) && (known ? Boolean(known.excluded) : !evictable);
      // A group member a capped scan left out may still be failing.
      if (!question.threadKey && (question.threadKeys ?? []).some((member) => !byKey.has(member) && cappedKinds.has(String(member).split(":")[0]))) continue;
      if (standing(question)) {
        const ref = question.prRef ?? known?.prRefs?.[0] ?? null;
        const prMissing = Boolean(parsePrRef(ref)) && !this.skip.github && !prs.has(ref) && !unreadPrs.has(ref);
        // A PR this scan could not read keeps its last settled read only.
        const notReady = unreadPrs.has(ref) ? null : notReadyBlocker(prs.get(ref));
        const reason = settledAsk(question, { thread: known, pr: prs.get(ref), prMissing, threadGone, muted: decided?.reason === "muted by owner", notReady });
        if (reason) {
          store.resolveQuestion(question.id, reason);
          this.resolveOutreach(question, "resolved", "dismissed");
        }
        continue;
      }
      if (decided || supervisorOwned || threadGone) {
        const reason = decided ? `${decided.state}: ${decided.reason}` : threadGone ? `thread ${known?.excluded ?? "left the scan"}` : "no longer asked";
        store.resolveQuestion(question.id, reason);
        this.resolveOutreach(question, "resolved", "dismissed");
      }
    }
    this.closeExpired();
    return attempted;
  }

  // The supervisor manages its own needs-you list: one batched model call
  // judges which open questions still need the owner (see review.js). It
  // runs in every mode because it only edits the supervisor's own records
  // and outreach copies, never a thread. A failure fails open: the
  // questions go out as they would have without it. Returns the ids of
  // questions never reviewed that this review did not settle either.
  async reviewOpenQuestions({ asked, byKey, items = [] }) {
    const unsettled = new Set();
    const review = this.config.review;
    if (!review?.enabled) return unsettled;
    const store = this.store;
    const now = this.now();
    // Only questions asked this tick; the rest close or wait for their source.
    // The supervisor's own findings (it can't reach a thread, nudges made no
    // progress) are facts, not guesses about an agent: the review never
    // clears those.
    const open = store.openQuestions().filter((question) => (asked.has(question.dedupeKey) || standing(question)) && !SELF_FINDING_KINDS.has(question.kind));
    if (!open.length) return unsettled;
    if (this.lastReview.failedAt && now - this.lastReview.failedAt < REVIEW_RETRY_MS) return unsettled;
    const prs = new Map(items.filter((item) => item.pr?.ref).map((item) => [item.pr.ref, item.pr]));
    const states = new Map(items.map((item) => [item.thread.key, item.classified]));
    const scope = { threads: byKey, prs, states, limits: this.config.limits };
    const fingerprints = new Map(open.map((question) => [question.id, reviewFingerprint(question, scope)]));
    const unreviewed = (question) => !question.reviewedAt;
    const changed = (question) => Boolean(question.reviewedAt) && question.reviewFingerprint !== fingerprints.get(question.id);
    const backoff = (question) => 2 ** Math.min(question.reviewStreak ?? 0, REVIEW_BACKOFF_MAX);
    const due = (question) => now - Date.parse(question.reviewedAt ?? "") >= review.intervalMs * backoff(question);
    const forced = this.forceReview === true;
    const pending = forced ? open : open.filter((question) => unreviewed(question) || changed(question) || due(question));
    if (!pending.length) return unsettled;
    // Only a new question skips the gap, so a backlog past the batch cap
    // does not call the model every tick.
    if (!forced && !pending.some(unreviewed) && now - (this.lastReview.at ?? 0) < REVIEW_MIN_GAP_MS) return unsettled;
    // New, then changed, then the longest since its review: the batch cap
    // drops the tail, and the next review starts there.
    const rank = (question) => (unreviewed(question) ? 0 : changed(question) ? 1 : 2);
    const ordered = [...pending].sort((a, b) => rank(a) - rank(b) || String(a.reviewedAt ?? "").localeCompare(String(b.reviewedAt ?? "")));
    const others = open.filter((question) => !pending.includes(question));
    // One model call holds up to a batch; the owner's own scan keeps going
    // until every open question was rechecked (bounded).
    const settled = new Set();
    let remaining = ordered;
    for (let round = 0; remaining.length && round < (forced ? FORCED_REVIEW_ROUNDS : 1); round += 1) {
      let verdicts;
      try {
        const rest = [...others, ...ordered.filter((question) => !remaining.includes(question))];
        verdicts = await reviewQuestions({ questions: remaining, others: rest, contextFor: (question) => reviewContext(question, scope), runModel: this.reviewRunner, now, ownerNotes: loadOwnerNotes(this.dataDir) });
      } catch (error) {
        const detail = clampText(redactSecrets(error?.message ?? String(error)), 200);
        this.lastReview = { ...this.lastReview, failedAt: now, error: detail, ran: this.reviewRunner?.lastRun ?? null };
        store.recordAction({ kind: "review", playbook: "review", threadKey: null, status: "failed", reason: "review failed; questions go out unreviewed", detail });
        break;
      }
      this.lastReview = { at: now, failedAt: null, error: null, ran: this.reviewRunner?.lastRun ?? null };
      this.applyReview(verdicts, fingerprints);
      const answered = new Set(verdicts.map((verdict) => verdict.id));
      for (const verdict of verdicts) if (!verdict.deferred) settled.add(verdict.id);
      const next = remaining.filter((question) => !answered.has(question.id));
      if (next.length === remaining.length) break;
      remaining = next;
    }
    // A failed review lets every new question out, as before.
    if (this.lastReview.failedAt === now) return unsettled;
    for (const question of pending) if (unreviewed(question) && !settled.has(question.id)) unsettled.add(question.id);
    return unsettled;
  }

  applyReview(verdicts, fingerprints) {
    const store = this.store;
    const decisions = [];
    let deferred = 0;
    for (const verdict of verdicts) {
      // The owner may have answered or dismissed it while the model ran, or
      // be answering it now: the answer wins.
      const question = store.question(verdict.id);
      if (question?.status !== "open" || this.answering.has(verdict.id)) continue;
      // Over the close cap: left as it was for the next review.
      if (verdict.deferred) { deferred += 1; continue; }
      const fingerprint = fingerprints.get(question.id) ?? null;
      if (verdict.decision === "close") {
        const closed = store.closeByReview(question.id, { category: verdict.category, reason: verdict.reason, fingerprint, duplicateOf: verdict.duplicateOf ?? null });
        if (closed) {
          this.resolveOutreach(question, "resolved", "dismissed");
          store.recordAction({
            kind: "review", playbook: "review", threadKey: question.threadKey ?? null, questionId: question.id, status: "done",
            reason: clampText(`closed ${verdict.category}: ${question.title}. ${verdict.reason}`, 300)
          });
          decisions.push({ id: question.id, decision: "close", category: verdict.category, reason: verdict.reason, duplicateOf: verdict.duplicateOf ?? null });
          continue;
        }
      }
      // Only an agent's own question takes new choices: the others carry
      // meaning the supervisor acts on ("merged", "keep going", "added").
      const options = question.kind === "agent-ask" ? verdict.options ?? null : null;
      const kept = store.recordReview(question.id, {
        title: verdict.title ?? null,
        options,
        fingerprint,
        reason: verdict.reason,
        category: "live",
        brief: verdict.brief ?? null,
        recommendation: verdict.recommendation ?? null,
        suggestedReplies: verdict.suggestedReplies ?? null
      });
      decisions.push({ id: question.id, decision: "keep", category: "live", reason: verdict.reason, title: kept?.title ?? question.title });
    }
    const closed = decisions.filter((decision) => decision.decision === "close").length;
    store.recordAction({
      kind: "review", playbook: "review", threadKey: null, status: "done",
      reason: `reviewed ${decisions.length}: ${closed} closed, ${decisions.length - closed} kept${deferred ? `, ${deferred} closes deferred` : ""}`, decisions
    });
  }

  // The group's start holds while the thread stays in it: the earliest of
  // what this scan can tell and what earlier scans saw. A new group starts
  // from this scan's guess, or now. Push, blocked and quiet have no clock of
  // their own (the guess is the thread's last activity): a move into one
  // that this process saw happen starts at the move.
  trackWatch(key, watch, now) {
    if (!watch) { this.watchSince.delete(key); return null; }
    const prev = this.watchSince.get(key);
    const guess = Date.parse(watch.since ?? "");
    let since = Number.isFinite(guess) && guess <= now ? guess : now;
    // A timed group's own clock is exact (the ask, the task, the turn): a new
    // question, run or turn in the same group restarts it.
    const exact = TIMED_WATCH.has(watch.group) && Number.isFinite(guess) && guess <= now;
    if (prev && prev.group !== watch.group && !TIMED_WATCH.has(watch.group)) since = now;
    if (prev?.group === watch.group && !exact) since = Math.min(prev.since, since);
    this.watchSince.set(key, { group: watch.group, since });
    return { ...watch, since: new Date(since).toISOString() };
  }

  linkedTaskForThread(threadKey) {
    if (!threadKey || !this.runtime?.tasks?.tasks) return null;
    for (const task of this.runtime.tasks.tasks.values()) {
      if (task?.sourceMeta?.threadKey === threadKey && task.status !== "completed" && task.status !== "cancelled") {
        return task;
      }
    }
    return null;
  }

  syncTaskWatchdogs(items, now) {
    const taskStore = this.runtime?.tasks;
    if (!taskStore?.tasks || typeof taskStore.update !== "function") return;
    for (const { thread, classified, pr } of items) {
      const task = this.linkedTaskForThread(thread.key);
      if (!task) continue;
      const checkIn = estimateExpectedCheckIn(thread, { classified, pr, task, now, limits: this.config.limits });
      if (!checkIn) continue;
      const diag = classified.snag ?? diagnoseAgentBlocker(thread, { pr, now, limits: this.config.limits });
      const prevWatchdog = task.sourceMeta?.watchdog ?? null;
      const nextStatus = checkIn.status;
      const diagKind = diag?.kind ?? null;
      if (prevWatchdog?.status === nextStatus && prevWatchdog?.diagnosisKind === diagKind && prevWatchdog?.checkInDueAt === checkIn.checkInDueAt) {
        continue;
      }
      const nextMeta = {
        ...(task.sourceMeta ?? {}),
        ...(diag ? { blockedReason: `${diag.snagLabel}: ${diag.summary}`.slice(0, 240) } : {}),
        ...(checkIn.severelyStuck && !task.sourceMeta?.stalledSince ? { stalledSince: checkIn.anchorAt } : {}),
        watchdog: {
          expectedMinutes: checkIn.expectedMinutes,
          silentMinutes: checkIn.silentMinutes,
          checkInDueAt: checkIn.checkInDueAt,
          overdue: checkIn.overdue,
          overdueMinutes: checkIn.overdueMinutes,
          status: nextStatus,
          ...(diagKind ? { diagnosisKind: diagKind, diagnosisLabel: diag.snagLabel } : {})
        }
      };
      try { taskStore.update(task.id, { sourceMeta: nextMeta }); } catch { /* best-effort task sync */ }
    }
  }

  buildSnapshot({ reason, started, finished, mode, threads, inScope, items, decisions, infra, sourceErrors, unknownPrefixes = [], manager, delivery = null, storage = null, previous = null }) {
    this.syncTaskWatchdogs(items, finished);
    const byState = {};
    const byWatch = Object.fromEntries(WATCH_GROUPS.map((group) => [group, 0]));
    const decisionFor = effectiveDecisions(decisions);
    // Only questions the owner can see (getState hides ones held for review).
    const askedAt = askTimes(this.store.openQuestions().filter((q) => !this.awaitingReview.has(q.id)));
    const seen = new Set();
    const rows = items.map(({ thread, classified, pr }) => {
      byState[classified.state] = (byState[classified.state] ?? 0) + 1;
      const decision = decisionFor.get(thread.key) ?? null;
      // The wait age was measured when the scan classified, at its start.
      const watch = this.trackWatch(thread.key, watchOf(thread, classified, { now: started, askedAt: askedAt.get(thread.key) ?? null }), finished);
      if (watch) { byWatch[watch.group] = (byWatch[watch.group] ?? 0) + 1; seen.add(thread.key); }
      const linkedTask = this.linkedTaskForThread(thread.key);
      const checkIn = estimateExpectedCheckIn(thread, { classified, pr, task: linkedTask, now: finished, limits: this.config.limits });
      const diag = classified.snag ?? diagnoseAgentBlocker(thread, { pr, now: finished, limits: this.config.limits });
      const watchdog = checkIn
        ? { ...checkIn, ...(diag ? { diagnosis: { kind: diag.kind, label: diag.snagLabel, resolution: diag.resolution } } : {}) }
        : null;
      return {
        key: thread.key,
        kind: thread.kind,
        title: clampText(thread.title, 100),
        workspace: thread.workspace ?? null,
        repo: thread.repo ?? null,
        branch: thread.branch ?? null,
        agentStatus: thread.agentStatus,
        state: classified.state,
        health: threadHealth(classified.state, thread.error ?? null),
        reason: clampText(classified.reason, 160),
        blockers: (classified.blockers ?? []).slice(0, 6),
        pr: pr
          ? {
              ref: pr.ref,
              url: pr.url,
              state: pr.state,
              isDraft: Boolean(pr.isDraft),
              title: clampText(pr.title, 100),
              bodySummary: pr.bodySummary ?? null,
              additions: pr.additions ?? null,
              deletions: pr.deletions ?? null,
              changedFiles: pr.changedFiles ?? null,
              files: Array.isArray(pr.files) ? pr.files.slice(0, 12) : [],
              gates: Array.isArray(pr.gates) ? pr.gates.slice(0, 4).map((g) => ({ label: g.label || g.name, state: g.state ?? null })) : [],
              qa: pr.qa ? { required: pr.qa.required ?? null, freshOnHead: pr.qa.freshOnHead ?? null } : null,
              ci: pr.ci,
              unresolvedThreads: pr.unresolvedThreads,
              mergeState: pr.mergeState,
              head: String(pr.headOid ?? "").slice(0, 10)
            }
          : (thread.prRefs?.[0] ? { ref: thread.prRefs[0], url: null, state: null } : null),
        lastActivityAt: thread.lastActivityAt ?? null,
        lastAgentText: clampTail(redactSecrets(thread.lastAgentText), 600),
        error: thread.error ? { kind: thread.error.kind, resetAt: thread.error.resetAt ?? null } : null,
        live: Boolean(thread.live),
        // The app that shows it (fleet_app pins the chats an app action stops)
        // and the permission card it waits on (fleet_click's labels).
        app: uiTargetFor(thread)?.app ?? null,
        ...(thread.meta?.prompt ? { prompt: { text: clampText(thread.meta.prompt.text, 300), buttons: thread.meta.prompt.buttons, stateId: thread.meta.prompt.stateId } } : {}),
        route: chooseRoute(thread, mode, delivery),
        // message: the words a nudge or escalation would send (playbook text
        // and facts, or the judge's), what the owner's Push now sends.
        decision: decision ? { action: decision.action, playbook: decision.playbook, reason: clampText(decision.reason, 160), notBefore: decision.notBefore ?? null, message: SENDING.has(decision.action) && decision.message ? clampText(decision.message, 500) : null } : null,
        lastAgentAt: thread.lastAgentAt ?? null,
        lastOwnerAt: ownerSpokeAt(thread),
        requiresAttention: Boolean(thread.meta?.requiresAttention),
        attentionReason: thread.meta?.attentionReason ?? null,
        // What opens this exact chat (contracts openChatFor).
        openChat: openChatFor(thread),
        ...(watchdog ? { watchdog } : {}),
        watch
      };
    });
    const rowKeys = new Set(rows.map((r) => r.key));
    let carriedCount = 0;
    if (Array.isArray(previous?.threads) && (Object.keys(sourceErrors ?? {}).length > 0 || unknownPrefixes.length > 0)) {
      for (const prevRow of previous.threads) {
        const isUnknownHostRow = unknownPrefixes.some((p) => String(prevRow?.key ?? "").startsWith(p));
        if (!prevRow?.key || !prevRow.kind || (!sourceErrors[prevRow.kind] && !isUnknownHostRow) || rowKeys.has(prevRow.key)) continue;
        rowKeys.add(prevRow.key);
        rows.push(prevRow);
        carriedCount += 1;
        if (prevRow.state) byState[prevRow.state] = (byState[prevRow.state] ?? 0) + 1;
        if (prevRow.watch?.group) {
          byWatch[prevRow.watch.group] = (byWatch[prevRow.watch.group] ?? 0) + 1;
          seen.add(prevRow.key);
        }
      }
    }
    for (const r of rows) setBounded(this.knownRows, r.key, r);
    for (const key of this.watchSince.keys()) if (!seen.has(key)) this.watchSince.delete(key);
    const infraDecisions = decisions.filter((decision) => String(decision.threadKey ?? "").startsWith("infra:"))
      .map((decision) => ({ key: decision.threadKey, action: decision.action, reason: clampText(decision.reason, 200), notBefore: decision.notBefore ?? null }));
    const sources = Object.fromEntries(THREAD_KINDS.map((kind) => [kind, 0]));
    for (const thread of threads) sources[thread.kind] = (sources[thread.kind] ?? 0) + 1;
    if (carriedCount > 0 && previous?.counts?.sources) {
      for (const kind of THREAD_KINDS) {
        if (sourceErrors?.[kind] && sources[kind] === 0 && Number.isFinite(previous.counts.sources[kind])) {
          sources[kind] = previous.counts.sources[kind];
        }
      }
    }
    const eligibleCount = threads.filter((thread) => !thread.excluded).length + carriedCount;
    const inScopeCount = inScope.length + carriedCount;
    const totalThreads = carriedCount > 0
      ? Math.max(threads.length + carriedCount, Object.values(sources).reduce((s, n) => s + (n || 0), 0))
      : threads.length;
    return {
      at: new Date(finished).toISOString(),
      reason,
      durationMs: finished - started,
      mode,
      counts: {
        threads: totalThreads,
        eligible: eligibleCount,
        inScope: inScopeCount,
        deferred: Math.max(0, eligibleCount - inScopeCount),
        sources,
        byState,
        byWatch,
        // Only genuine owner decisions count toward Needs You (excludes completion "Got it" receipts).
        needsYou: this.store.openQuestions().filter((q) => !this.awaitingReview.has(q.id) && needsOwnerDecision(q)).length,
        actions: decisions.filter((decision) => SENDING.has(decision.action)).length
      },
      manager: manager ? { key: manager.key, title: clampText(manager.title, 80), live: Boolean(manager.live), agentStatus: manager.agentStatus, error: manager.error?.kind ?? null } : null,
      threads: rows,
      infra,
      infraDecisions,
      storage,
      paseo: this.config.paseo?.enabled ? { discovered: threads.filter(t => t.kind === "paseo").length, historyPending: threads.filter(t => t.kind === "paseo" && t.excluded === "history-unavailable").length, deliveryReady: null } : null,
      sourceErrors
    };
  }
}
