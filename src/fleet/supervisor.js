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
import { CARD_EXCLUSIONS, DEFAULTS, MODES, SUPERVISOR_PREFIX, THREAD_KINDS, UI_APPS, clampTail, clampText, linkUiHosts, openChatFor, parsePrRef, redactSecrets, resolveFleetConfig, runCommand, shortHash, uiTargetFor } from "./contracts.js";
import { WATCH_GROUPS, classifyThread, liveWatch, mergeThreads, prReadiness, threadHealth, watchOf } from "./classify.js";
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
import { DEADLINE_MARGIN_MS, UI_INPUT_LATCH, createAppController, createUiDriver, restartMaxMs, uiIdentity } from "./ui-delivery.js";
import * as antigravity from "./sources/antigravity.js";
import * as buildbot3 from "./sources/buildbot3.js";
import * as claude from "./sources/claude.js";
import * as codex from "./sources/codex.js";
import * as conductor from "./sources/conductor.js";
import * as github from "./sources/github.js";
import * as processes from "./sources/processes.js";

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
  limit: { dedupeKey: "limit:group", options: ["wait", "added"], match: ["wait", "added"], title: (n, reset) => `${n} threads capped. Reset ${reset}. Add acct?`, body: (labels) => `Waiting on reset: ${labels}.` },
  open: { dedupeKey: "open:group", options: ["opened", "skip"], title: (n) => `${n} stuck, can't reach. Open them?`, body: (labels) => `No live session to message: ${labels}.` },
  // Always one question, even for one thread, so the owner's answer holds
  // while the set of failing threads changes under it.
  deliver: { dedupeKey: "deliver:group", options: ["done", "skip"], match: ["done", "skip"], minSize: 1, title: (n) => `${n} stopped. Nudges can't get through. Nudge ${n === 1 ? "it" : "them"}?`, body: (labels) => `Sends keep failing: ${labels}.` }
});
// A question card item is the agent's own words, read from the card itself:
// the review never closes or rewrites one either.
export const SELF_FINDING_KINDS = new Set(["self-fix", "suggestion", "open", "deliver", "stuck", "paused", "storage", "agent-card"]);
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
  if (decision?.action !== "nudge" || !decision.message || !decision.route || !JUDGED_PLAYBOOKS.has(decision.playbook)) return false;
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
  return [thread.key, replyMark(thread), decision.playbook, decision.factsKey ?? "", shortHash(judgeFacts(pr, classified, decision)), shortHash(JSON.stringify(shown))].join("|");
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
  const askedAt = Date.parse(question.agentAskedAt ?? question.createdAt ?? "");
  if (question.kind === "ready" && prMissing) return "PR not found";
  if (pr && SETTLED_PR_STATES.has(pr.state)) {
    // An ask made after the merge (a release, QA on it) is not about it.
    const settledAt = Date.parse(pr.mergedAt ?? pr.closedAt ?? "");
    const after = question.kind === "ready" || !Number.isFinite(settledAt) || !Number.isFinite(askedAt) || settledAt >= askedAt;
    if (after) return `${parsePrRef(pr.ref)?.number ? `#${parsePrRef(pr.ref).number}` : "PR"} ${pr.state === "MERGED" ? "merged" : "closed"}`;
  }
  if (pr?.state === "OPEN" && question.askedHead && pr.headOid && pr.headOid !== question.askedHead) return `PR head moved past ${String(question.askedHead).slice(0, 10)}`;
  if (question.kind === "ready" && notReady) return `PR no longer ready: ${notReady}`;
  if (question.kind !== "agent-ask") return null;
  if (muted) return "muted by owner";
  if (threadGone) return `thread ${thread?.excluded ?? "left the scan"}`;
  const spokeAt = Date.parse(agentReply(thread).at ?? "");
  if (!question.mergeAsk && thread && Number.isFinite(spokeAt) && Number.isFinite(askedAt) && spokeAt > askedAt) return "agent moved on: no longer asks";
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
    threadKey: decision.threadKey.startsWith("infra:") ? null : decision.threadKey,
    prRef: byKey.get(decision.threadKey)?.prRefs?.[0] ?? null,
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
    if (list.length === 1 && minSize > 1) out.push(single(list[0]));
    if (!list.length || list.length < minSize) continue;
    const threads = list.map((decision) => byKey.get(decision.threadKey)).filter(Boolean);
    // A delivery failure names its reason, so the owner knows what to fix.
    const labels = kind === "deliver"
      ? list.map((decision) => `${threadLabel(byKey.get(decision.threadKey))} (${String(decision.reason ?? "").replace(/^can't deliver: /, "")})`).join(", ")
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

// How much of the agent's last message a thread's detail shows.
const DETAIL_EXCERPT_MAX = 1200;
// Options that only send the owner to the chat: a question with no other is
// answered in the agent's app, never here.
const APP_ONLY_OPTIONS = new Set(["open thread", "opened"]);
// Asks the owner must read in full before any button: a release or deploy,
// a delete, a merge.
const RISKY_ASK = /\b(?:prod(?:uction)?|releas(?:e|es|ed|ing)|deploy(?:s|ed|ing|ment)?|delet(?:e|es|ed|ing|ion)|destroy|wipe|merg(?:e|es|ed|ing)|force[- ]push|rewrite (?:git )?history)\b|--admin\b/i;
const MUTE_HOURS_DEFAULT = 24;

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

// "retry" on a logged-out / disk-full question means the owner fixed it.
const RETRY_DELIVERY = "Owner fixed the blocker (login or disk). Retry: continue where you stopped.";
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
    this.lastPrs = new Map();
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

  // runModel for the review; tests inject a fake one.
  get reviewRunner() {
    if (this.deps.runModel) return this.deps.runModel;
    this._reviewRunner ??= createReviewRunner({ config: this.config, run: this.deps.run ?? runCommand });
    return this._reviewRunner;
  }

  get notifier() {
    if (this.deps.notifier) return this.deps.notifier;
    this._notifier ??= createNotifier({ config: this.config, store: this.store, runtime: this.runtime, fetchImpl: this.deps.fetchImpl });
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

  start() {
    if (!this.config.enabled || this.timer) return false;
    const fire = (reason) => this.tick({ reason }).catch(() => { /* recorded in lastError */ });
    this.timer = setInterval(() => fire("interval"), this.config.tickMs);
    this.timer.unref?.();
    this.kickTimer = setTimeout(() => fire("start"), START_DELAY_MS);
    this.kickTimer.unref?.();
    if (this.config.idleDrain?.enabled && (this.config.delivery ?? "cli") !== "cli") {
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
    const snapshot = this.liveSnapshot(withHealth(store.snapshot), open);
    const rows = new Map((snapshot?.threads ?? []).map((row) => [row?.key, row]));
    const questions = open.map((question) => this.questionView(question, rows));
    return {
      mode: this.mode,
      enabled: Boolean(this.config.enabled),
      running: Boolean(this.running),
      lastTickAt: this.lastTickAt ?? store.snapshot?.at ?? null,
      lastError: this.lastError,
      snapshot,
      questions,
      fixes: store.fixes(),
      // So the owner can reopen a wrong close.
      reviewClosed: store.reviewClosed(),
      actions: store.actions(50),
      suggestions: store.suggestions(),
      diagnosis: structuredClone(store.state.diagnosis),
      settings: {
        tickMinutes: Math.round(this.config.tickMs / MIN),
        lookbackHours: this.config.lookbackHours,
        push: this.config.push ?? null,
        relayModel: this.config.relayModel,
        managerRef: this.config.managerRef,
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
        }
      }
    };
  }

  // The last scan's rows brought up to now. Watching follows the questions
  // open now: one answered or dismissed since the scan takes its row out of
  // "Waiting on you" at once (codex:01a13388 sat there 3 minutes after its
  // only question was dismissed, until the next scan), and a new one puts
  // it in. Each row also says whether the owner muted it, and what opens it.
  liveSnapshot(snapshot, open) {
    if (!Array.isArray(snapshot?.threads)) return snapshot;
    const askedAt = askTimes(open);
    const closedAt = this.store.closedAtByThread();
    const byWatch = Object.fromEntries(WATCH_GROUPS.map((group) => [group, 0]));
    const threads = snapshot.threads.map((row) => {
      if (!row?.key) return row;
      const muted = this.store.mutedUntil(row.key);
      const watch = liveWatch(row.watch ?? null, { state: row.state, askedAt: askedAt.get(row.key) ?? null, closedAt: closedAt.get(row.key) ?? null, muted });
      if (watch) byWatch[watch.group] = (byWatch[watch.group] ?? 0) + 1;
      // A snapshot saved before rows carried openChat: this process's read.
      const openChat = row.openChat !== undefined ? row.openChat : openChatFor(this.lastThreads.get(row.key));
      const preview = this.lastItems.get(row.key)?.pushPreview;
      const thread = this.lastThreads.get(row.key);
      const pending = this.store.openQuestions().some((q) => q.threadKey === row.key || (q.threadKeys ?? []).includes(row.key));
      const canPush = preview?.action === "nudge" && preview.message && !muted && !pending
        && !this.ownerAnswerThreads(Infinity).has(row.key) && !repeatsLastSend(thread, this.store.ledgerFor(row.key), preview.messageHash);
      return { ...row, lastAgentText: redactSecrets(row.lastAgentText), watch, muted, openChat: openChat ?? null,
        pushPreview: canPush ? { action: "nudge", playbook: preview.playbook, reason: preview.reason, message: preview.message } : null, pushing: this.pushing.has(row.key) };
    });
    return { ...snapshot, threads, counts: { ...(snapshot.counts ?? {}), byWatch, needsYou: open.length } };
  }

  // One open question as the cards show it: when the agent asked (else when
  // the supervisor first put it to the owner), in which chat (label and the
  // link that opens it), whether it is answered here or only in the agent's
  // app, and whether it is a risky ask whose full text comes before any
  // button. A group names each of its chats.
  questionView(question, rows) {
    const chatOf = (key) => {
      const thread = this.lastThreads.get(key);
      return (thread ? openChatFor(thread) : rows.get(key)?.openChat) ?? null;
    };
    const openChat = question.threadKey ? chatOf(question.threadKey) : null;
    const chats = (question.threadKeys ?? []).map((key) => ({ threadKey: key, ...(chatOf(key) ?? { app: null, url: null, label: key, note: null }) }));
    const options = question.options ?? [];
    const inApp = question.kind === "agent-card" || !options.some((option) => !APP_ONLY_OPTIONS.has(option));
    const text = [question.title, question.body, ...options].filter(Boolean).join(" ");
    return {
      ...question,
      askedAt: question.agentAskedAt ?? question.createdAt ?? null,
      chatLabel: openChat?.label ?? (chats.length ? `${chats[0].label}${chats.length > 1 ? ` +${chats.length - 1} more` : ""}` : null),
      answerIn: inApp ? "agent app" : "here",
      openChat,
      ...(chats.length ? { chats } : {}),
      risky: Boolean(question.mergeAsk) || question.kind === "storage" || (["agent-ask", "agent-card", "ready"].includes(question.kind) && RISKY_ASK.test(text))
    };
  }

  setMode(mode) {
    if (!MODES.includes(mode)) return null;
    if (mode !== "propose") {
      for (const action of this.store.actions(this.config.limits.maxActionsKept)) {
        if (action.status === "proposed") this.store.updateAction(action.id, { status: "stale", detail: "mode changed" });
      }
    }
    if (mode === "observe") this.selfFixHub.stop("all").catch(() => {});
    return this.store.setMode(mode);
  }

  dismissQuestion(id) {
    const question = this.store.question(id);
    if (!question || question.status !== "open") return null;
    if (question.kind === "suggestion") {
      this.respondSuggestion(question.meta?.suggestionId, "Not now").catch(() => {});
      return this.store.question(id);
    }
    // A storage ask comes back every tick, and a dismissal holds while it is
    // asked: one dismiss would mute it for good. It counts as Later (24 h).
    if (question.kind === "storage" && (question.options ?? []).includes("Later")) {
      this.resolveOutreach(question, "Later", "acted");
      return this.store.answerQuestion(id, "Later");
    }
    this.applyOverride(question, "dismiss");
    this.resolveOutreach(question, "dismiss", "dismissed");
    return this.store.dismissQuestion(id);
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
  trackUiBlocked(decisions, { mode, delivery, threads, sourceErrors, started, config }) {
    if (mode !== "auto" || delivery.ready !== false) { this.uiBlockedSince.clear(); this.store.setUiBlockedSince(this.uiBlockedSince); return; }
    const now = new Set(decisions.filter((decision) => decision?.uiBlocked).map((decision) => decision.threadKey));
    const seen = new Set(threads.map((thread) => thread.key));
    const hidden = (key) => {
      // infra:bb3 and infra:lb belong to their probes, not a thread source.
      const [kind, probe] = String(key).split(":");
      if (kind === "infra") return Boolean(sourceErrors[probe]);
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
      if ((contacted.uiStalled || deferUi) && route === "computer-use") continue;
      // Failed tries are bounded too, like the send loop's.
      if (tries >= budget * 2) continue;
      tries += 1;
      const delivery = await this.executor.deliver({ thread, message: pending.message, route, playbook: "owner-answer" });
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
  async clickThread(threadKey, label, { stateId = null, deadlineAt = null, thread = null } = {}) {
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
    this.store.recordAction({ kind: "click", playbook: "owner-click", threadKey: found.thread.key, route: "computer-use", status: result?.status ?? "failed",
      reason: clampText(`owner: click ${label}`, 300), detail: clampText(result?.detail ?? "", 200), at: new Date(this.now()).toISOString() });
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

  async answerQuestion(id, answer, { deadlineAt = null, clarification = null } = {}) {
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
    // A question card is answered in the app itself. Until the supervisor
    // can click it there, "open thread" is the only answer and it relays
    // nothing; anything else is refused.
    if (question.kind === "agent-card" && answer !== "open thread") return null;
    this.answering.add(id);
    if (question.threadKey) this.ownerAnsweredAt.set(question.threadKey, this.now());
    try {
      let delivery = null;
      const settling = [];
      // A tap on one of a permission card's buttons clicks that button in
      // the thread (the card the question was raised for: its stateId).
      if (question.kind === "prompt" && question.threadKey && !["later", "opened"].includes(answer)) {
        const clicked = await this.clickThread(question.threadKey, answer, { stateId: question.meta?.promptStateId ?? null, deadlineAt });
        delivery = clicked.delivery;
        if (delivery.status !== "sent") return { question: this.store.question(id), delivery };
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
      // fixed a login/disk blocker, is an explicit instruction: every mode.
      const retry = question.kind === "infra" && answer === "retry";
      if ((question.kind === "agent-ask" || retry) && question.threadKey && answer !== "open thread") {
        const thread = this.lastThreads.get(question.threadKey);
        const deliveryState = thread ? await this.probeDelivery({ deadlineAt }) : null;
        const route = thread ? chooseRoute(thread, this.mode === "auto" ? "auto" : "propose", deliveryState) : null;
        const message = retry ? RETRY_DELIVERY : ownerDelivery(answer);
        if (!thread || !route) {
          delivery = { status: "blocked", route: null, detail: this.noRouteDetail(thread, deliveryState) };
        } else {
          delivery = await this.executor.deliver({ thread, message, route, playbook: "owner-answer", spentMs: Date.now() - startedAt, deadlineAt });
          if ((delivery.route ?? route) === "computer-use") this.noteUiResult(thread, delivery);
          if (delivery.done) settling.push(delivery.done.then((reached) => (reached ? null : thread.key)));
          // Starts the cooldown but does not spend the no-progress nudge budget.
          this.store.recordNudge(thread.key, { playbook: "owner-answer", route: delivery.route ?? route, status: delivery.status === "sent" ? "owner-answer" : delivery.status });
        }
        // The owner decided; only the typing has to wait (secure input, a
        // locked screen, the owner at the keyboard). Keep the answer and send
        // it once the Mac can type, instead of handing the question back.
        if (thread && delivery.status !== "sent" && answer !== "open thread" && typingWaits(thread, route, deliveryState, delivery)) {
          // A tick may have closed the question meanwhile; only a stored answer is "saved".
          const queued = this.store.queueAnswer(id, answer, message);
          if (queued) {
            this.resolveOutreach(question, answer, "acted");
            this.applyOverride(question, answer);
            return { question: queued, delivery: { status: "queued", route: null, detail: `Saved. It goes to the agent once the Mac can type (${delivery.detail}).` } };
          }
        }
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
      this.resolveOutreach(question, answer, "acted");
      this.applyOverride(question, answer);
      this.reopenIfUndelivered(id, settling, answer);
      return { question: answered, delivery };
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
  async sendOwnerMessage(threadKey, message, { deadlineAt = null, queue = false } = {}) {
    const startedAt = Date.now();
    const text = String(message ?? "").trim();
    if (!text) return { delivery: { status: "blocked", route: null, detail: "empty message" } };
    const thread = this.lastThreads.get(threadKey);
    const deliveryState = thread ? await this.probeDelivery({ deadlineAt }) : null;
    const route = thread ? chooseRoute(thread, this.mode === "auto" ? "auto" : "propose", deliveryState) : null;
    if (!thread || !route) return { delivery: { status: "blocked", route: null, detail: this.noRouteDetail(thread, deliveryState) } };
    // The owner is speaking to this thread: a judged or planned nudge in
    // flight for it is dropped, as for an owner answer.
    this.ownerAnsweredAt.set(thread.key, this.now());
    const delivery = await this.executor.deliver({ thread, message: text, route, playbook: "owner-message", spentMs: Date.now() - startedAt, deadlineAt, queue: queue === true });
    if ((delivery.route ?? route) === "computer-use") this.noteUiResult(thread, delivery);
    this.store.recordNudge(thread.key, { playbook: "owner-message", route: delivery.route ?? route, status: delivery.status === "sent" ? "owner-answer" : delivery.status });
    // A card in the way comes back with the block: the owner can answer it
    // (fleet_click) and send again.
    const card = delivery.status === "sent" ? null : delivery.prompt ?? this.livePrompt(thread);
    return { delivery: { status: delivery.status, route: delivery.route ?? route, detail: delivery.detail ?? null, ...(card ? { prompt: card } : {}) } };
  }

  // One thread, expanded for the owner: the agent's last message and when,
  // the owner's last word, its PR, what it waits on, the supervisor's next
  // step and why, its open questions, and what opens its chat. Built from
  // the last scan's row (kept across a restart), with this process's own
  // read of the chat when it has one. null: not in the last scan.
  async threadConversation(threadKey) {
    const thread = this.lastThreads.get(threadKey)
      ?? this.getState().snapshot?.threads?.find((row) => row.key === threadKey);
    if (!thread) return null;
    try { return await readThreadConversation(thread, this.config); }
    catch { return unavailableConversation(thread); }
  }

  threadDetail(threadKey) {
    const state = this.getState();
    const row = (state.snapshot?.threads ?? []).find((entry) => entry?.key === threadKey);
    if (!row) return null;
    const thread = this.lastThreads.get(threadKey) ?? null;
    const reply = thread ? agentReply(thread) : { text: row.lastAgentText ?? "", at: row.lastAgentAt ?? null };
    return {
      key: row.key, kind: row.kind, title: row.title ?? null, workspace: row.workspace ?? null, repo: row.repo ?? null, branch: row.branch ?? null,
      app: row.app ?? null, agentStatus: row.agentStatus ?? null, live: Boolean(row.live), state: row.state ?? null, health: row.health ?? null,
      reason: row.reason ?? null, blockers: row.blockers ?? [], error: row.error ?? null,
      lastAgentMessage: { text: clampTail(redactSecrets(reply.text), DETAIL_EXCERPT_MAX), at: reply.at ?? null },
      lastOwnerAt: thread ? ownerSpokeAt(thread) : (row.lastOwnerAt ?? null),
      lastActivityAt: row.lastActivityAt ?? null,
      pr: row.pr ?? null,
      watch: row.watch ?? null,
      decision: row.decision ?? null,
      pushPreview: row.pushPreview ?? null,
      pushing: row.pushing === true,
      ...(row.prompt ? { prompt: row.prompt } : {}),
      muted: row.muted ?? null,
      questions: state.questions.filter((question) => question.threadKey === threadKey || (question.threadKeys ?? []).includes(threadKey)),
      openChat: row.openChat ?? null,
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
    return { until };
  }

  unmuteThread(threadKey) {
    const was = this.store.unmute(threadKey);
    if (was) this.store.recordAction({ kind: "unmute", playbook: "owner-mute", threadKey, status: "done", reason: "owner: unmute", by: "owner" });
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
    const settled = action.kind === "nudge" ? await this.prSettledBeforeSend(thread, this.lastPrs.get(action.threadKey) ?? null, action) : null;
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

    let peers = new Map();
    try { peers = (d.readLivePeers ?? claude.readLivePeers)(config) ?? new Map(); } catch (error) { sourceErrors.peers = clampText(error?.message, 200); }

    // The Codex keys whose open card this tick's scan settled (see act).
    const cardScanned = new Set();
    const storageOn = Boolean(this.config.storage?.enabled);
    const [codexThreads, claudeThreads, conductorThreads, antigravityThreads, lbErrors, localVerify, bb3, lb] = await Promise.all([
      guard("codex", () => (d.listCodexThreads ?? codex.listCodexThreads)(config, { now: started, run, cardScanned }), []),
      guard("claude", () => (d.listClaudeThreads ?? claude.listClaudeThreads)(config, { now: started, peers }), []),
      guard("conductor", () => (d.listConductorThreads ?? conductor.listConductorThreads)(config, { now: started, peers }), []),
      guard("antigravity", () => (d.listAntigravityThreads ?? antigravity.listAntigravityThreads)(config, { now: started, run, fetchImpl: d.fetchImpl }), []),
      guard("lbErrors", () => (d.readCodexLbErrors ?? codex.readCodexLbErrors)(config, { now: started }), []),
      guard("processes", () => (d.findLocalHeavyVerification ?? processes.findLocalHeavyVerification)(config, { run }), []),
      this.skip.bb3 ? null : guard("bb3", () => (d.probeBuildBot3 ?? buildbot3.probeBuildBot3)(config, { run, now: started, previous: previous?.infra?.bb3 ?? null }), null),
      guard("lb", () => (d.checkLb ?? buildbot3.checkLb)(config, { fetchImpl: d.fetchImpl, now: started }), null),
      // Free space only (statfs); a failed read keeps the last one.
      storageOn ? guard("storage", () => this.storage.refreshVolumes(), null) : null
    ]);

    // Conductor-hosted Codex threads learn which Conductor session shows them.
    const threads = linkUiHosts(mergeThreads({ codex: codexThreads ?? [], claude: claudeThreads ?? [], conductor: conductorThreads ?? [], antigravity: antigravityThreads ?? [] }));
    const ownPaths = this.store.fixes().map((fix) => fix.worktree).filter(Boolean);
    const selfIds = new Set(config.selfSessionIds);
    for (const thread of threads) {
      if (selfIds.has(thread.id) || selfIds.has(thread.claudeSessionId) || thread.branch?.startsWith("selffix/")
          || ownPaths.some((cwd) => thread.cwd === cwd || thread.cwd?.startsWith(cwd + path.sep))
          || thread.cwd?.startsWith(path.join(this.config.paths.home ?? os.homedir(), "Dev/openagi-fixes") + path.sep)) thread.excluded = "self";
    }
    const manager = (d.findManagerSession ?? conductor.findManagerSession)(config, threads) ?? null;
    const hasCard = (thread) => thread.meta?.pendingCard?.items?.length > 0;
    const ranked = threads
      .filter((thread) => !thread.excluded)
      .sort((a, b) => String(b.lastActivityAt ?? "").localeCompare(String(a.lastActivityAt ?? "")));
    // An older thread past the cap still has its open card asked: the Codex
    // source kept it for that card alone.
    const inScope = [...ranked.slice(0, config.limits.maxThreads), ...ranked.slice(config.limits.maxThreads).filter(hasCard)];
    // An automation or no-repo thread's open question card still needs the
    // owner. It is decided (asked) with the rest, but never read for git or
    // PRs, and classify gives it nothing to nudge.
    const carded = threads.filter((thread) => CARD_EXCLUSIONS.has(thread.excluded) && hasCard(thread));

    const localGit = await this.readGit(inScope, config, run, sourceErrors);
    resolveCreatedPrs(inScope);
    await this.resolvePrRefs(inScope, localGit, config, run, sourceErrors);
    await this.preferOpenPrs(inScope, config, run);
    const unreadPrs = new Set();
    // An open question's PR is read too, even once its thread moved to
    // another PR or left the scan: its merge settles the question.
    const askedPrs = this.store.openQuestions().map((question) => question.prRef);
    const prs = this.withSettledPrs(await this.fetchPrs(inScope, config, run, sourceErrors, unreadPrs, askedPrs), unreadPrs);

    const infra = {
      bb3: bb3 ?? { ...emptyBb3(), error: this.skip.bb3 ? "skipped" : (sourceErrors.bb3 ?? null) },
      lb: { healthy: lb?.healthy ?? null, detail: lb?.detail ?? null, watchLine: lb?.watchLine ?? null, recentErrors: lbErrors ?? [], errorsUnknown: Boolean(sourceErrors.lbErrors) },
      localVerify: (localVerify ?? []).map((row) => ({ ...row, threadKey: processes.matchThreadByCwd(row.cwd, inScope) }))
    };

    const playbooks = this.playbooks();
    const store = this.store;
    const mutedKeys = store.mutedKeys();
    // Computer-use readiness, once per tick; the driver re-checks at each send.
    const delivery = await this.probeDelivery();
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
        decision = decideThread(classified, thread, { ledger: store.ledgerFor(thread.key), escalationLedger: store, mutedKeys, playbooks, config, now: started, pr, mode, infra, manager, delivery });
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
    this.trackUiBlocked([...items.map((item) => item.decision), ...infraDecisions, ...queuedWaits], { mode: this.mode, delivery, threads, sourceErrors, started, config });
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
    this.lastThreads = byKey;
    // Each thread's PR as this scan read it, for a proposal sent later.
    this.lastPrs = new Map(items.filter((item) => item.pr).map((item) => [item.thread.key, item.pr]));
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
    // A source that returned a full page may have evicted older live threads,
    // so a missing thread of that kind is not proof it is gone.
    const cappedKinds = new Set(THREAD_KINDS.filter((kind) => threads.filter((thread) => thread.kind === kind && (kind !== "antigravity" || !thread.excluded)).length >= config.limits.maxThreads));
    // A failed disk read, or an SD card mounted but unreadable, is unknown.
    const storageUnknown = storageOn && (Boolean(sourceErrors.storage) || this.storage.sdUnknown);
    const attempted = await this.act(decisions, { mode, byKey, manager, started, config, items, prs, unreadPrs, unknownKinds, cappedKinds, cardScanned, deferUi, skipReview: reason === "owner-away", storageUnknown });
    this.trackInfraBlocked(health, items, blockedKeys, { recovering: infraDecisions, attempted, unknownKinds, mode, now: started });

    const finished = this.now();
    const snapshot = this.buildSnapshot({ reason, started, finished, mode, threads, inScope, items, decisions, infra, sourceErrors, manager, delivery, storage: storageOn ? this.storage.summary() : null });
    store.recordSnapshot(snapshot);
    this.lastTickAt = snapshot.at;
    try { await this.diagnoseTick(); } catch (error) {
      store.saveDiagnosis({ error: clampText(redactSecrets(error?.message), 200) });
    }
    try { this.runtime?.events?.emit?.("fleet", { at: snapshot.at, reason, counts: snapshot.counts }); } catch { /* listeners never break a tick */ }
    return snapshot;
  }

  // The judge reads the chat before an automatic nudge goes out: send its
  // message, wait, or ask the owner. Only in Auto, only for the playbooks
  // in JUDGED_PLAYBOOKS, and never for a limit or error resume (those stay
  // mechanical). A failure waits, never a blind send. Item decisions are
  // replaced in place.
  async judgeNudges(items, { started }) {
    const judge = this.nudgeJudge;
    if (!judge?.enabled || typeof judge.judge !== "function" || this.mode !== "auto") return;
    for (const [key, entry] of this.judgeCache) if (started - entry.at >= JUDGE_CACHE_MS) this.judgeCache.delete(key);
    for (const [key, at] of this.judgeTriedAt) if (started - at >= JUDGE_CACHE_MS) this.judgeTriedAt.delete(key);
    // Only answers given since this scan began count (ownerAnswerThreads).
    for (const [key, at] of this.ownerAnsweredAt) if (at < started) this.ownerAnsweredAt.delete(key);
    // A thread the owner answered, or whose answer waits to be typed or is
    // being sent, gets no automatic nudge: the answer goes first
    // (deliverQueuedAnswers), never a playbook nudge beside or over it.
    const answering = this.ownerAnswerThreads(started);
    const history = this.nudgeHistory(new Set(items.filter((item) => judgeable(item.decision, item.thread)).map((item) => item.thread.key)));
    const due = [];
    for (const item of items) {
      const { decision, thread } = item;
      if (!judgeable(decision, thread)) continue;
      if (answering.has(thread.key)) { item.decision = judgeWait(decision, "owner answer goes first; no nudge"); continue; }
      if (decision.notBefore && Date.parse(decision.notBefore) > started) continue;
      const key = judgeCacheKey(thread, decision, item.pr, item.classified, history.get(thread.key) ?? []);
      const cached = this.judgeCache.get(key);
      if (cached) item.decision = this.applyJudgeVerdict(item, cached.verdict);
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
      const left = JUDGE_TICK_MS - (this.now() - judgeStart);
      if (left < JUDGE_MIN_CALL_MS) return { later: true };
      const capMs = Math.min(JUDGE_CALL_MS, left);
      try {
        const verdict = await withTimeout(Promise.resolve(judge.judge({
          thread: item.thread, decision: item.decision, classified: item.classified, pr: item.pr, nudges: history.get(item.thread.key) ?? [], now: started, timeoutMs: capMs
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
  trackInfraBlocked(health, items, previous, { recovering = [], attempted = new Set(), unknownKinds = new Set(), mode = "observe", now = this.now() } = {}) {
    for (const kind of INFRA_KINDS) {
      if (health[kind].down) {
        const current = items
          .filter(({ classified }) => classified.infraKind === kind && BLOCKED_STATES.has(classified.state))
          .map(({ thread }) => thread.key);
        this.store.setInfraBlocked(kind, [...previous[kind], ...current]);
      } else if (health[kind].up) {
        // A resume the judge has not read yet (its cap, a failure) is still due.
        const pending = new Set(recovering
          .filter((decision) => !decision.threadKey.startsWith("infra:") && !attempted.has(decision.threadKey)
            && ((decision.action === "nudge" && decision.route) || (decision.judgePending && decision.playbook === "infra-recovered")) && mode === "auto")
          .map((decision) => decision.threadKey));
        const upAt = Date.parse(this.store.infraUpSince(kind) ?? "");
        const holdHidden = Number.isFinite(upAt) && now - upAt < RECOVERY_HOLD_MS;
        this.store.setInfraBlocked(kind, previous[kind].filter((key) => pending.has(key) || (holdHidden && unknownKinds.has(key.split(":")[0]))));
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

  async resolvePrRefs(inScope, localGit, config, run, sourceErrors) {
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
    // Counted by checkout root, so chats in two of its subfolders share it.
    const checkoutOf = (thread) => (thread.cwd ? localGit.get(thread.cwd)?.root ?? path.resolve(thread.cwd) : null);
    const perCheckout = new Map();
    for (const thread of inScope) {
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
    if (!since && !about) return null;
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

  async act(decisions, { mode, byKey, manager, started, config, items = [], prs = new Map(), unreadPrs = new Set(), unknownKinds = new Set(), cappedKinds = new Set(), cardScanned = new Set(), deferUi = false, skipReview = false, storageUnknown = false }) {
    const store = this.store;
    const fromFailedSource = (keys) => keys.some((key) => unknownKinds.has(String(key ?? "").split(":")[0]));
    // A thread whose git read or PR fetch failed this tick is unknown too: its
    // PR question must not close now and come back as a new push next tick.
    const gitUnknown = new Set(items.filter((item) => item.gitUnreadable || item.prUnreadable).map(({ thread }) => thread.key));
    const unknown = (keys) => fromFailedSource(keys) || keys.some((key) => gitUnknown.has(key));
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

    // A Codex question card is asked beside the thread's own decision.
    const asks = decisions.flatMap((decision) => [
      ...(decision.action === "ask-user" && decision.question ? [decision] : []),
      ...(decision.cardQuestion ? [{ ...decision, action: "ask-user", question: decision.cardQuestion, playbook: null }] : [])
    ]);
    // One the last review could not settle yet is still new.
    const shownBefore = new Set(store.openQuestions().map((question) => question.id).filter((id) => !this.awaitingReview.has(id)));
    const toNotify = [];
    for (const fields of groupQuestions(asks, byKey)) {
      // Rebuilt without a failed source's threads, a group would drop them,
      // or shrink to one thread and ask it twice; the open group stays as it
      // is until that source reads again.
      const spec = unknownKinds.size ? GROUPED_KINDS[fields.kind] : null;
      const covers = (q) => (fields.threadKeys ? true : (q.threadKeys ?? []).includes(fields.threadKey));
      const sameChoices = spec && (fields.threadKeys || JSON.stringify(fields.options) === JSON.stringify(spec.options));
      const open = sameChoices ? store.openQuestions().find((q) => q.dedupeKey === spec.dedupeKey && covers(q)) : null;
      if (open && fromFailedSource(open.threadKeys ?? [])) { asked.add(open.dedupeKey); continue; }
      if (fields.kind === "agent-ask" && prUnknown.has(fields.threadKey) && store.resolvedOnly(fields.dedupeKey)) continue;
      // The head it is asked at: a move past it settles the ask (settledAsk).
      const question = store.upsertQuestion({ ...fields, askedHead: fields.prRef ? prs.get(fields.prRef)?.headOid ?? null : null });
      asked.add(question.dedupeKey);
      // The owner already answered or dismissed this one; stay quiet.
      if (question.suppressed) continue;
      toNotify.push({ id: question.id, reopened: Boolean(question.reopened) });
    }
    // The supervisor reviews its own list before a new question reaches the
    // owner, so junk never pings; the main does not see it before then either.
    this.awaitingReview = this.config.review?.enabled ? new Set(toNotify.map(({ id }) => id).filter((id) => !shownBefore.has(id))) : new Set();
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
    for (const { id, reopened } of toNotify) {
      const question = store.question(id);
      if (question?.status !== "open" || this.awaitingReview.has(id)) continue;
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
    const judgeOn = Boolean(this.nudgeJudge?.enabled) && typeof this.nudgeJudge?.judge === "function";
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
        ...(decision.messageHash ? { messageHash: decision.messageHash, factsKey: decision.factsKey ?? null, facts: decision.facts ?? null } : {})
      };
      const existing = openActions.find((action) => action.threadKey === record.threadKey && action.playbook === record.playbook);
      if (existing) seenActions.add(existing.id);

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
      if (judgeOn && !decision.judged && judgeable(decision, target)) {
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
        if (decision.route === "computer-use" && UI_STALLED.test(String(delivery.detail ?? ""))) uiStalled = true;
        if (!existing && !delivery.actionId) store.recordAction({ ...record, status: delivery.status, detail: delivery.detail, at });
        else if (delivery.actionId) store.updateAction(delivery.actionId, { reason: record.reason, message: record.message, threadKey: record.threadKey, targetKey });
        this.recordSend(record, delivery, sentAt);
      } finally { this.pushing.delete(decision.threadKey); }
    }

    // A planned/proposed action the policy no longer wants is stale.
    // (Storage records its own plans; they are not tick decisions.)
    for (const action of openActions) {
      if (action.kind !== "storage" && !seenActions.has(action.id) && !unknown([action.threadKey])) store.updateAction(action.id, { status: "stale" });
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
    const open = store.openQuestions().filter((question) => asked.has(question.dedupeKey) && !SELF_FINDING_KINDS.has(question.kind));
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
      const kept = store.recordReview(question.id, { title: verdict.title ?? null, options, fingerprint, reason: verdict.reason, category: "live" });
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

  buildSnapshot({ reason, started, finished, mode, threads, inScope, items, decisions, infra, sourceErrors, manager, delivery = null, storage = null }) {
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
          ? { ref: pr.ref, url: pr.url, state: pr.state, title: clampText(pr.title, 100), ci: pr.ci, unresolvedThreads: pr.unresolvedThreads, mergeState: pr.mergeState, head: String(pr.headOid ?? "").slice(0, 10) }
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
        // What opens this exact chat (contracts openChatFor).
        openChat: openChatFor(thread),
        watch
      };
    });
    for (const key of this.watchSince.keys()) if (!seen.has(key)) this.watchSince.delete(key);
    const infraDecisions = decisions.filter((decision) => decision.threadKey.startsWith("infra:"))
      .map((decision) => ({ key: decision.threadKey, action: decision.action, reason: clampText(decision.reason, 200), notBefore: decision.notBefore ?? null }));
    const sources = Object.fromEntries(THREAD_KINDS.map((kind) => [kind, 0]));
    for (const thread of threads) sources[thread.kind] = (sources[thread.kind] ?? 0) + 1;
    return {
      at: new Date(finished).toISOString(),
      reason,
      durationMs: finished - started,
      mode,
      counts: {
        threads: threads.length,
        inScope: inScope.length,
        sources,
        byState,
        byWatch,
        // Only questions the owner can see (getState hides ones held for review).
        needsYou: this.store.openQuestions().filter((q) => !this.awaitingReview.has(q.id)).length,
        actions: decisions.filter((decision) => SENDING.has(decision.action)).length
      },
      manager: manager ? { key: manager.key, title: clampText(manager.title, 80), live: Boolean(manager.live), agentStatus: manager.agentStatus, error: manager.error?.kind ?? null } : null,
      threads: rows,
      infra,
      infraDecisions,
      storage,
      sourceErrors
    };
  }
}
