// Owner-only persistent state for the fleet supervisor: mode, last snapshot,
// per-thread nudge ledger, needs-you questions, escalations, and the action
// log. One JSON file (0600) plus an append-only actions.jsonl journal.
// Methods never throw on disk errors; the last one is kept in lastWriteError.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appendJsonLine, ensureDir, readJsonFile, writeJsonAtomic, writeTextAtomic } from "../file-utils.js";
import { REMEDIES, suggestionPlan } from "./remedies.js";
import { DEFAULTS, MODES, clampTail, clampText, redactSecrets } from "./contracts.js";
import { feedbackPatch, fixRevision, normalizeFeedback, normalizeFixRequest } from "./feedback.js";
import { ACTION_LOG_MAX, DAY_MS, foldActions } from "./diagnose.js";

// A question lives this long from when it was first put to the owner, asked
// again or not; then it expires, and the same ask stays quiet as long again.
const QUESTION_TTL_MS = 24 * 60 * 60 * 1000;
// A question the supervisor closed and that is asked again this soon was a
// blip: the same record comes back instead of a new one.
const REOPEN_MS = 60 * 60 * 1000;
const PUSH_KEEP_MS = 24 * 60 * 60 * 1000;
const NUDGES_KEPT = 20;
const FACTS_KEPT = 8;
const CLOSED_QUESTIONS_KEPT = 200;
const OPTIONS_MAX = 4;
const OPTION_MAX_CHARS = 40;
const INFRA_BLOCKED_KEPT = 200;
const FEEDBACK_KEPT = 500;
const FIXES_KEPT = 100;
const SELF_SESSIONS_KEPT = 50;
// The owner closed these; the same ask stays quiet for a TTL.
const OWNER_CLOSED = new Set(["answered", "dismissed"]);
// A review close is the model's guess, so it holds only this long; then the
// same ask comes back as a new question, reviewed again before it pings.
const REVIEW_HOLD_MS = 6 * 60 * 60 * 1000;
// The agent message an ask came from, for the review.
const ASK_CONTEXT_MAX = 600;
// An agent's own question: one it wrote, or an item of its question card.
const AGENT_KINDS = new Set(["agent-ask", "agent-card"]);

// Only a delivered nudge spends the no-progress budget. A failed send still
// starts the cooldown so a broken route is not retried every tick; dry-runs,
// proposals, and blocked attempts are history only.
const ATTEMPT_STATUSES = new Set(["sent"]);
const COOLDOWN_STATUSES = new Set(["sent", "failed", "owner-answer"]);
// A send that never reached the thread, for backoff and for telling the
// owner. The owner at the keyboard, or a turn still running, is not the
// route failing: those wait for the next tick and leave the streak alone.
const UNDELIVERED_STATUSES = new Set(["blocked", "failed"]);
const REACHED_STATUSES = new Set(["sent", "owner-answer", "escalated"]);
// The owner being active is no failure. A presence probe that keeps failing
// ("front app unknown", "presence check too slow") is: it builds the streak
// so the owner hears why nothing lands.
const BENIGN_BLOCKS = /^(owner using |turn running|frontmost app changed|waiting for idle|screen saver on)/;

function emptyState() {
  return {
    version: 1,
    mode: null,
    snapshot: null,
    ledger: {},
    questions: [],
    actions: [],
    escalations: {},
    infraDown: {},
    infraBlocked: {},
    uiBlockedSince: {},
    infraUp: {},
    pushes: [],
    muted: {},
    appRestarts: {},
    restartedAt: {},
    feedback: [],
    fixes: [],
    suggestions: [],
    diagnosis: {},
    fixLocks: {},
    fixCommands: {},
    selfSessions: []
  };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Short metadata plus a bounded, typed improvement plan; no arbitrary objects.
function questionMeta(meta) {
  if (!isObject(meta)) return null;
  const out = {};
  for (const [key, value] of Object.entries(meta).slice(0, 8)) {
    if (typeof value === "string") out[key] = value.slice(0, 120);
    else if (Array.isArray(value)) out[key] = value.filter((item) => typeof item === "string").slice(0, 20).map((item) => item.slice(0, 200));
  }
  if (isObject(meta.plan) && REMEDIES.includes(meta.plan.remedy)) {
    out.plan = suggestionPlan({ remedy: meta.plan.remedy,
      nextAction: redactSecrets(clampText(meta.plan.nextAction, 2000)),
      acceptance: redactSecrets(clampText(meta.plan.acceptance, 2000)) });
  }
  return Object.keys(out).length ? out : null;
}

function makeId(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function toMs(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

// When the question was last asked (records saved before lastAskedAt used
// createdAt), or closed if that came later.
function lastAskMs(question) {
  return Math.max(toMs(question.lastAskedAt ?? question.createdAt, 0), toMs(question.answeredAt, 0));
}

// The supervisor's review closed it (stale, junk, a duplicate).
function isReviewClosed(question) {
  return question.status === "resolved" && question.resolvedBy === "review";
}

// A dismissal holds while the same ask keeps coming, and so does an answer
// relayed to the agent's own question: its words stay up until it replies.
// A review close holds the same way, up to REVIEW_HOLD_MS. Other answers
// ("later", "keep going", "opened", "retry") leave the condition to the
// owner, so the ask returns a TTL after the answer.
function holdsWhileAsked(question) {
  return question.status === "dismissed" || AGENT_KINDS.has(question.kind) || isReviewClosed(question);
}

// A group the review closed that now covers another thread is a new ask.
function widens(question, fields) {
  const covered = question.threadKeys ?? (question.threadKey ? [question.threadKey] : []);
  return (fields.threadKeys ?? []).some((key) => !covered.includes(key));
}

// The review's wording stands while the policy asks the same way (askedAs
// is the policy's wording under the rewrite); a reworded ask shows the
// policy's words until the next review.
function keepReviewWording(question, fields) {
  if (!question.askedAs) return;
  const same = question.askedAs.title === fields.title && JSON.stringify(question.askedAs.options ?? []) === JSON.stringify(fields.options);
  if (same) Object.assign(fields, { title: question.title, options: question.options });
  else fields.askedAs = null;
}

// When the question was put to the owner (a reopen by the owner, or an
// answer handed back, puts it again): its expiry runs from here.
function liveSinceMs(question) {
  return toMs(question.liveSince ?? question.createdAt, 0);
}

// Start of an owner close's TTL.
function heldSinceMs(question) {
  return holdsWhileAsked(question) ? lastAskMs(question) : toMs(question.answeredAt, 0);
}

function holdEnded(question, now) {
  if (isReviewClosed(question)) return now - toMs(question.answeredAt, 0) >= REVIEW_HOLD_MS;
  return now - heldSinceMs(question) >= QUESTION_TTL_MS;
}

// Progress marks come from different producers; compare them key-order-free.
function markKey(mark) {
  if (mark === null || mark === undefined) return "null";
  if (!isObject(mark)) return JSON.stringify(mark);
  return JSON.stringify(Object.keys(mark).sort().map((key) => [key, mark[key]]));
}

function normalizeOptions(options) {
  const out = [];
  for (const option of Array.isArray(options) ? options : []) {
    const text = clampText(option, OPTION_MAX_CHARS);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= OPTIONS_MAX) break;
  }
  return out;
}

function emptyLedger() {
  return { nudges: [], lastProgressMark: null, attemptsWithoutProgress: 0, lastNudgeAt: null, undelivered: null };
}

export class FleetStore {
  constructor({ dir, defaultMode = null, limits = {}, now = () => Date.now() } = {}) {
    if (!dir) throw new TypeError("FleetStore needs a dir");
    this.dir = dir;
    this.statePath = path.join(dir, "state.json");
    this.journalPath = path.join(dir, "actions.jsonl");
    this.defaultMode = MODES.includes(defaultMode) ? defaultMode : null;
    this.limits = { ...DEFAULTS, ...limits };
    this.now = now;
    this.lastWriteError = null;
    this.state = this._load();
    // Expired questions whose outreach copy the supervisor still has to
    // close; after a restart that includes older ones (closing is idempotent).
    this.expired = this.state.questions.filter((q) => q.status === "expired" && q.outreachId).map((q) => ({ ...q }));
  }

  // ─── mode and snapshot ──────────────────────────────────────────────────

  // null until the owner picks a mode, so the env/config default still wins.
  get mode() {
    return this.state.mode ?? this.defaultMode;
  }

  setMode(mode) {
    if (!MODES.includes(mode)) return null;
    this.state.mode = mode;
    this._save();
    return mode;
  }

  recordSnapshot(snapshot) {
    this.state.snapshot = snapshot ?? null;
    this._save();
    return this.state.snapshot;
  }

  get snapshot() {
    return this.state.snapshot;
  }

  // ─── nudge ledger ───────────────────────────────────────────────────────

  ledgerFor(key) {
    const ledger = this.state.ledger[key];
    return ledger ? structuredClone(ledger) : emptyLedger();
  }

  // The owner answered or dismissed the can't-deliver question for this
  // thread: it is not asked about again for this failure streak.
  ackUndelivered(key) {
    const ledger = this.state.ledger[key];
    if (!ledger?.undelivered) return;
    ledger.undelivered.ackedAt = iso(this.now());
    this._save();
  }

  recordNudge(key, entry = {}, progressMark) {
    if (!key) return null;
    const ledger = this.state.ledger[key] ?? emptyLedger();
    const status = entry.status ?? "sent";
    const at = iso(toMs(entry.at, this.now()));
    ledger.nudges.push({
      at,
      playbook: entry.playbook ?? null,
      route: entry.route ?? null,
      status,
      messageHash: entry.messageHash ?? null,
      // When the send started, and the facts the nudge was about.
      ...(entry.sentAt ? { sentAt: iso(toMs(entry.sentAt, toMs(at, this.now()))) } : {}),
      ...(entry.factsKey ? { factsKey: String(entry.factsKey), facts: (Array.isArray(entry.facts) ? entry.facts : []).slice(0, FACTS_KEPT).map((item) => clampText(item, 80)) } : {})
    });
    if (ledger.nudges.length > NUDGES_KEPT) ledger.nudges.splice(0, ledger.nudges.length - NUDGES_KEPT);
    if (progressMark !== undefined && markKey(progressMark) !== markKey(ledger.lastProgressMark)) {
      ledger.attemptsWithoutProgress = 0;
      ledger.lastProgressMark = progressMark ?? null;
    }
    if (ATTEMPT_STATUSES.has(status)) ledger.attemptsWithoutProgress += 1;
    if (COOLDOWN_STATUSES.has(status)) ledger.lastNudgeAt = at;
    const detail = String(entry.detail ?? "");
    if (UNDELIVERED_STATUSES.has(status) && !BENIGN_BLOCKS.test(detail)) {
      // The thread worked since the last failure: this is a new incident,
      // and an answer to the old one does not cover it.
      const workedSince = toMs(entry.threadActivityAt, null);
      const ended = ledger.undelivered && workedSince !== null && workedSince > toMs(ledger.undelivered.lastAt, 0);
      const prev = ended ? null : (ledger.undelivered ?? null);
      ledger.undelivered = { count: (prev?.count ?? 0) + 1, since: prev?.since ?? at, lastAt: at, reason: clampText(detail, 160) || status, ackedAt: prev?.ackedAt ?? null };
    } else if (REACHED_STATUSES.has(status)) {
      ledger.undelivered = null;
    }
    this.state.ledger[key] = ledger;
    this._save();
    return structuredClone(ledger);
  }

  // ─── needs-you questions ────────────────────────────────────────────────

  // meta: small facts the supervisor acts on when the owner answers (a
  // permission card's stateId, an app and the chats running in it).
  // baseKey: an owner close of that ask holds this one too (a card item
  // asked once more under a new key).
  // askedHead: the PR head the ask was made at (a move past it settles it).
  // An agent's own ask (agent-ask) also carries mergeAsk (it asks to merge,
  // so it holds until answered or merged) and askedBy ("judge" when the
  // judge raised it, which reads the chat only before a nudge).
  upsertQuestion({ dedupeKey, kind = null, threadKey = null, threadKeys = null, prRef = null, title, body = "", options = [], playbook = null, askContext = null, agentAskedAt = null, meta = null, baseKey = null, askedHead = null, mergeAsk = false, askedBy = null, card = null } = {}) {
    const now = this.now();
    this._expireQuestions(now);
    // Where an agent's ask came from, as first seen: the thread may move on
    // while the ask stays open.
    const origin = { askContext: clampTail(redactSecrets(askContext), ASK_CONTEXT_MAX) || null, agentAskedAt: agentAskedAt ?? null };
    const fields = {
      ...(card ? { card: clampText(redactSecrets(card), this.limits.cardBodyMax) } : {}),
      threadKey: threadKey ?? null,
      prRef: prRef ?? null,
      title: clampText(redactSecrets(title), this.limits.titleMax) || "(untitled)",
      // A card item's body is its whole question and its choices.
      body: clampText(redactSecrets(body), kind === "agent-card" ? this.limits.cardBodyMax : this.limits.bodyMax),
      options: normalizeOptions(options),
      playbook: playbook ?? null,
      kind: kind ?? null,
      // Grouped questions ("5 threads capped") cover several threads.
      threadKeys: Array.isArray(threadKeys) && threadKeys.length ? threadKeys.slice(0, 50) : null,
      ...(questionMeta(meta) ? { meta: questionMeta(meta) } : {}),
      ...(kind === "agent-ask" ? { mergeAsk: Boolean(mergeAsk), askedBy: askedBy ?? null } : {})
    };
    const head = typeof askedHead === "string" && askedHead ? askedHead : null;
    const key = String(dedupeKey ?? "").trim() || `${fields.threadKey ?? "fleet"}:${fields.title}`;
    if (!this.state.questions.some((q) => q.status === "open" && q.dedupeKey === key)) this._adoptLegacyAsk(key, fields, origin);
    const existing = this.state.questions.find((q) => q.status === "open" && q.dedupeKey === key);
    if (existing) {
      // Not saved on its own: the next write (at least the tick's snapshot)
      // carries it.
      // scanAskedAt: only a scan asking it sets this (a reopen does not).
      // Asking again does not push its expiry back (liveSinceMs).
      Object.assign(existing, { lastAskedAt: iso(now), scanAskedAt: iso(now) });
      if (!existing.askContext && origin.askContext) Object.assign(existing, origin);
      // Asked again at a new head: the ask stands at that head.
      if (head) existing.askedHead = head;
      keepReviewWording(existing, fields);
      const changed = Object.keys(fields).some((name) => JSON.stringify(existing[name]) !== JSON.stringify(fields[name]));
      if (changed) {
        Object.assign(existing, fields, { updatedAt: iso(now) });
        this._save();
      }
      return { ...existing };
    }
    // An answer, dismissal or review close holds (see holdsWhileAsked), so
    // the next tick neither reopens it with a new id nor pushes the phone again.
    // A delivery-failure answer holds on each thread's failure streak (see
    // ackUndelivered), so the group question itself never holds: a thread
    // that starts failing later is asked about, one already answered is not.
    const closed = fields.kind === "deliver" ? null : this._ownerClosed(key, now, fields) ?? (baseKey ? this._ownerClosed(String(baseKey), now, fields) : null);
    if (closed) {
      if (holdsWhileAsked(closed)) closed.lastAskedAt = iso(now);
      return { ...closed, suppressed: true };
    }
    // It expired while still asked: quiet for a TTL, then asked anew.
    const expired = this._expiredHold(key, now, fields);
    if (expired) {
      expired.lastAskedAt = iso(now);
      return { ...expired, suppressed: true };
    }
    // The agent asks again in a newer message while its last ask is still
    // open: one question per agent, so the open one takes the new ask in
    // place (same id, same outreach copy, no second push).
    const superseded = this._supersedeAgentAsk(key, fields, origin, head, now);
    if (superseded) return superseded;
    // Same record, same outreach copy, no second push.
    const resolved = this._recentlyResolved(key, now);
    if (resolved) {
      keepReviewWording(resolved, fields);
      Object.assign(resolved, fields, origin.askContext ? origin : {}, {
        status: "open", answeredAt: null, resolveReason: null, reopenedAt: iso(now), updatedAt: iso(now),
        reopenHistory: [...(resolved.reopenHistory ?? []), iso(now)].filter((at) => now - Date.parse(at) <= 7 * DAY_MS),
        lastAskedAt: iso(now), scanAskedAt: iso(now), expiresAt: iso(liveSinceMs(resolved) + QUESTION_TTL_MS)
      });
      this._save();
      return { ...resolved, reopened: true };
    }
    const question = {
      id: makeId("fq"),
      dedupeKey: key,
      ...fields,
      ...(origin.askContext ? origin : {}),
      ...(head ? { askedHead: head } : {}),
      status: "open",
      answer: null,
      createdAt: iso(now),
      updatedAt: iso(now),
      answeredAt: null,
      lastAskedAt: iso(now),
      scanAskedAt: iso(now),
      expiresAt: iso(now + QUESTION_TTL_MS),
      outreachId: null,
      pushedAt: null
    };
    this.state.questions.push(question);
    this._pruneQuestions();
    this._save();
    return { ...question };
  }

  answerQuestion(id, answer) {
    const text = clampText(answer, this.limits.bodyMax);
    if (!text) return null;
    return this._closeQuestion(id, "answered", text);
  }

  markQuestionDelivered(id, threadKey) {
    const question = this.state.questions.find((q) => q.id === id && q.status === "open");
    if (!question) return;
    question.deliveredThreadKeys = [...new Set([...(question.deliveredThreadKeys ?? []), threadKey])];
    this._save();
  }

  dismissQuestion(id) {
    return this._closeQuestion(id, "dismissed", null);
  }

  // The owner answered, but the answer could not be typed yet: the question
  // is answered (off the owner's list) and its message waits to be sent.
  queueAnswer(id, answer, message) {
    const text = clampText(answer, this.limits.bodyMax);
    if (!text) return null;
    return this._closeQuestion(id, "answered", text, { pendingDelivery: { message: clampText(message, this.limits.bodyMax), since: iso(this.now()) } });
  }

  queuedAnswers() {
    return this.state.questions.filter((q) => q.status === "answered" && q.pendingDelivery).map((q) => ({ ...q }));
  }

  // A background send of a kept answer is in flight (at), or failed (null).
  markQueuedSending(id, at = iso(this.now())) {
    const question = this._findQuestion(id);
    if (!question?.pendingDelivery) return null;
    if (at) question.pendingDelivery.sendingAt = at;
    else delete question.pendingDelivery.sendingAt;
    this._save();
    return { ...question };
  }

  // sent, superseded (the owner typed in the thread since, or the agent no
  // longer asks it), or dropped.
  settleQueuedAnswer(id, outcome) {
    const question = this._findQuestion(id);
    if (!question?.pendingDelivery) return null;
    delete question.pendingDelivery;
    question.deliveredAnswer = outcome;
    question.updatedAt = iso(this.now());
    this._save();
    return { ...question };
  }

  // A background send that never reached the agent puts the owner's answer
  // back in front of them instead of suppressing the question for a day,
  // and a retry sends to those threads again. A different, later answer
  // from the owner is not undone.
  reopenQuestion(id, undeliveredKeys = [], { answer = null, asked = false } = {}) {
    const question = this._findQuestion(id);
    if (!question || !["open", "answered"].includes(question.status)) return null;
    if (question.status === "answered" && (answer === null || question.answer === answer)) {
      // Put back with a fresh day, so an answer that failed near the end of
      // the old one does not expire on the next read.
      Object.assign(question, { status: "open", answer: null, answeredAt: null, outreachId: null, reopenedAt: null, updatedAt: iso(this.now()), liveSince: iso(this.now()), expiresAt: iso(this.now() + QUESTION_TTL_MS) });
      if (asked) question.lastAskedAt = iso(this.now());
    }
    if (question.deliveredThreadKeys) question.deliveredThreadKeys = question.deliveredThreadKeys.filter((key) => !undeliveredKeys.includes(key));
    this._save();
    return { ...question };
  }

  // The supervisor closes a question itself once the condition behind it is gone.
  resolveQuestion(id, reason = null) {
    return this._closeQuestion(id, "resolved", null, { resolveReason: clampText(reason, 160) || null });
  }

  // The review kept an open question. A rewrite changes the same record
  // (same dedupeKey), so its outreach copy updates in place; askedAs keeps
  // the policy's wording so the next tick's ask does not undo it.
  recordReview(id, { title = null, options = null, fingerprint = null, reason = null, category = null } = {}) {
    const question = this._findQuestion(id);
    if (!question || question.status !== "open") return null;
    const now = iso(this.now());
    const nextTitle = clampText(redactSecrets(title), this.limits.titleMax);
    const nextOptions = normalizeOptions(options);
    const retitled = Boolean(nextTitle) && nextTitle !== question.title;
    const reoptioned = nextOptions.length > 0 && JSON.stringify(nextOptions) !== JSON.stringify(question.options);
    if (retitled || reoptioned) {
      question.askedAs ??= { title: question.title, options: [...(question.options ?? [])] };
      if (retitled) question.title = nextTitle;
      if (reoptioned) question.options = nextOptions;
      question.updatedAt = now;
    }
    // Kept again with nothing changed: the supervisor checks it less often.
    const streak = fingerprint && fingerprint === question.reviewFingerprint ? (question.reviewStreak ?? 0) + 1 : 0;
    Object.assign(question, {
      reviewedAt: now, reviewFingerprint: fingerprint, reviewReason: clampText(reason, 160) || null, reviewCategory: category ?? null,
      reviewStreak: streak
    });
    this._save();
    return { ...question };
  }

  // The review closed it. It holds like a dismissal while the same ask keeps
  // coming (up to REVIEW_HOLD_MS), and the reopen window never revives it.
  // A pinned one stays.
  closeByReview(id, { category = "stale", reason = null, fingerprint = null, duplicateOf = null } = {}) {
    const question = this._findQuestion(id);
    if (!question || question.pinned) return null;
    const why = clampText(reason, 160) || null;
    return this._closeQuestion(id, "resolved", null, {
      resolvedBy: "review",
      resolveReason: clampText(`review: ${category}: ${why ?? "no longer needs you"}`, 160),
      reviewedAt: iso(this.now()), reviewFingerprint: fingerprint, reviewReason: why, reviewCategory: category,
      duplicateOf: duplicateOf ?? null
    });
  }

  // The owner brings back a question the review closed: same record, same
  // id and outreach copy. Pinned, so the review keeps it until its ask changes.
  reopenReviewed(id) {
    const now = this.now();
    const question = this._findQuestion(id);
    if (!question || !isReviewClosed(question)) return null;
    // A new copy of the same ask is already open (the hold ran out).
    if (this.state.questions.some((q) => q.status === "open" && q.dedupeKey === question.dedupeKey)) return null;
    Object.assign(question, {
      status: "open", answeredAt: null, resolvedBy: null, resolveReason: null, duplicateOf: null, pinned: true,
      reopenedAt: iso(now), updatedAt: iso(now), lastAskedAt: iso(now), liveSince: iso(now), expiresAt: iso(now + QUESTION_TTL_MS)
    });
    this._save();
    return { ...question };
  }

  // Every review close asked in the last day, newest first and one per ask,
  // so the owner can reopen any wrong one. One whose ask is open again (a
  // widened group, a hold that ran out) is left out: it cannot be reopened.
  reviewClosed() {
    const since = this.now() - QUESTION_TTL_MS;
    const openKeys = new Set(this.state.questions.filter((q) => q.status === "open").map((q) => q.dedupeKey));
    const seen = new Set();
    return this.state.questions
      .filter((q) => isReviewClosed(q) && lastAskMs(q) > since && !openKeys.has(q.dedupeKey))
      .sort((a, b) => toMs(b.answeredAt, 0) - toMs(a.answeredAt, 0))
      .filter((q) => !seen.has(q.dedupeKey) && seen.add(q.dedupeKey))
      .map((q) => ({ ...q }));
  }

  // Expired questions not yet handed out; each is returned once.
  takeExpired() {
    return this.expired.splice(0);
  }

  // Records how the notifier reached the owner so a later tick neither
  // re-posts the outreach item nor re-pushes the phone.
  markQuestionNotified(id, { outreachId, pushedAt } = {}) {
    const question = this._findQuestion(id);
    if (!question) return null;
    if (outreachId) question.outreachId = outreachId;
    if (pushedAt) question.pushedAt = iso(toMs(pushedAt, this.now()));
    this._save();
    return { ...question };
  }

  // The supervisor closed this question itself (a merge settled it) and no
  // copy of it is open. A latest close by the review is left to
  // upsertQuestion, which holds it and keeps its ask time fresh.
  resolvedOnly(dedupeKey) {
    const same = this.state.questions.filter((q) => q.dedupeKey === dedupeKey);
    if (same.some((q) => q.status === "open")) return false;
    const latest = same.filter((q) => q.status === "resolved").sort((a, b) => toMs(b.answeredAt, 0) - toMs(a.answeredAt, 0))[0];
    return Boolean(latest) && !isReviewClosed(latest);
  }

  openQuestions() {
    this._expireQuestions(this.now());
    return this.state.questions
      .filter((q) => q.status === "open")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((q) => ({ ...q }));
  }

  question(id) {
    this._expireQuestions(this.now());
    const question = this._findQuestion(id);
    return question ? { ...question } : null;
  }

  // ─── action log ─────────────────────────────────────────────────────────

  recordAction(action = {}) {
    const now = this.now();
    const record = {
      ...action,
      id: action.id ?? makeId("fa"),
      at: action.at ?? iso(now),
      status: action.status ?? "proposed"
    };
    this.state.actions.push(record);
    const max = this.limits.maxActionsKept;
    if (this.state.actions.length > max) this.state.actions.splice(0, this.state.actions.length - max);
    this._journal({ op: "record", ...record });
    this._save();
    return { ...record };
  }

  updateAction(id, patch = {}) {
    const action = this.state.actions.find((a) => a.id === id);
    if (!action) return null;
    const { id: _ignored, ...rest } = patch ?? {};
    const updatedAt = iso(this.now());
    Object.assign(action, rest, { updatedAt });
    this._journal({ op: "update", id, ...rest, updatedAt });
    this._save();
    return { ...action };
  }

  action(id) {
    const action = this.state.actions.find((a) => a.id === id);
    return action ? { ...action } : null;
  }

  actions(limit = 50) {
    return this.state.actions.slice(-Math.max(0, limit)).reverse().map((a) => ({ ...a }));
  }

  actionHistory() {
    let rows = [];
    try {
      rows = fs.readFileSync(this.journalPath, "utf8").split(/\r?\n/).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    return foldActions([...this.state.actions, ...rows]).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }

  // Keep complete folded records, newest first in priority, in a bounded log.
  rotateActions() {
    try {
      if (fs.statSync(this.journalPath).size <= ACTION_LOG_MAX) return false;
      const folded = this.actionHistory().sort((a, b) => Date.parse(a.updatedAt ?? a.at) - Date.parse(b.updatedAt ?? b.at));
      const tail = [];
      let bytes = 0;
      for (const action of folded.reverse()) {
        const line = JSON.stringify({ op: "record", ...action }) + "\n";
        const size = Buffer.byteLength(line);
        if (bytes + size > ACTION_LOG_MAX * 0.8) break;
        tail.push(line); bytes += size;
      }
      writeTextAtomic(this.journalPath, tail.reverse().join(""));
      return true;
    } catch (error) {
      if (error.code !== "ENOENT") this.lastWriteError = error?.message ?? String(error);
      return false;
    }
  }

  suggestions() { return structuredClone(this.state.suggestions); }

  saveSuggestion(record) {
    const at = this.state.suggestions.findIndex((s) => s.id === record.id);
    if (at < 0) this.state.suggestions.push(structuredClone(record));
    else this.state.suggestions[at] = structuredClone(record);
    this._save();
    return structuredClone(record);
  }

  saveDiagnosis(patch) {
    Object.assign(this.state.diagnosis, patch);
    this._save();
  }

  // ─── infra escalations and outages ──────────────────────────────────────

  recordEscalation(key, at) {
    this.state.escalations[key] = iso(toMs(at, this.now()));
    this._save();
    return this.state.escalations[key];
  }

  lastEscalation(key) {
    return this.state.escalations[key] ?? null;
  }

  setInfraDown(kind, down) {
    const current = this.state.infraDown[kind] ?? null;
    if (down && !current) this.state.infraDown[kind] = iso(this.now());
    else if (!down && current) {
      delete this.state.infraDown[kind];
      this.state.infraUp[kind] = iso(this.now());
    } else return this.infraDown(kind);
    this._save();
    return this.infraDown(kind);
  }

  infraDown(kind) {
    return Boolean(this.state.infraDown[kind]);
  }

  infraDownSince(kind) {
    return this.state.infraDown[kind] ?? null;
  }

  // When the last outage of this kind ended.
  infraUpSince(kind) {
    return this.state.infraUp[kind] ?? null;
  }

  // Threads seen blocked on an outage, so the recovery tick can resume them
  // even after the error rows that flagged them have aged out.
  setInfraBlocked(kind, keys) {
    const list = [...new Set((Array.isArray(keys) ? keys : []).filter((key) => typeof key === "string" && key))].slice(-INFRA_BLOCKED_KEPT);
    const current = this.state.infraBlocked[kind] ?? [];
    if (JSON.stringify(current) === JSON.stringify(list)) return this.infraBlocked(kind);
    if (list.length) this.state.infraBlocked[kind] = list;
    else delete this.state.infraBlocked[kind];
    this._save();
    return this.infraBlocked(kind);
  }

  infraBlocked(kind) {
    const list = this.state.infraBlocked[kind];
    return Array.isArray(list) ? [...list] : [];
  }

  // When each nudge first waited on computer use (thread key -> ISO time),
  // kept across restarts so the paused-nudge alert's clock does not reset.
  uiBlockedSince() {
    return new Map(Object.entries(this.state.uiBlockedSince ?? {}).map(([key, at]) => [key, toMs(at, null)]).filter(([, ms]) => ms !== null));
  }

  setUiBlockedSince(map) {
    const next = Object.fromEntries([...map].slice(0, INFRA_BLOCKED_KEPT).map(([key, ms]) => [key, iso(ms)]));
    if (JSON.stringify(next) === JSON.stringify(this.state.uiBlockedSince ?? {})) return;
    this.state.uiBlockedSince = next;
    this._save();
  }

  // ─── app restarts ───────────────────────────────────────────────────────

  // The chats an app quit or restart stopped (app -> { action, at, threadKeys,
  // due, done }), kept across a daemon restart so each still gets its one
  // resume once the app is back.
  appRestart(app) {
    const record = this.state.appRestarts?.[app];
    return isObject(record) ? structuredClone(record) : null;
  }

  appRestarts() {
    return Object.entries(this.state.appRestarts ?? {}).filter(([, record]) => isObject(record)).map(([app, record]) => ({ app, ...structuredClone(record) }));
  }

  setAppRestart(app, record) {
    this.state.appRestarts ??= {};
    if (record) this.state.appRestarts[app] = { ...record, threadKeys: (record.threadKeys ?? []).slice(0, 50), done: (record.done ?? []).slice(0, 50) };
    else delete this.state.appRestarts[app];
    this._save();
  }

  // When the fleet last restarted an app (ms), so a second answer does not
  // restart it again within minutes, a daemon restart included.
  restartedAt(app) {
    return toMs(this.state.restartedAt?.[app], null);
  }

  markRestarted(app, at = this.now()) {
    this.state.restartedAt ??= {};
    this.state.restartedAt[app] = iso(toMs(at, this.now()));
    this._save();
  }

  // ─── phone pushes (times only; never the endpoint) ──────────────────────

  recordPush(at) {
    const now = this.now();
    this.state.pushes.push(iso(toMs(at, now)));
    this.state.pushes = this.state.pushes.filter((p) => toMs(p, 0) >= now - PUSH_KEEP_MS);
    this._save();
  }

  pushesSince(ms, now = this.now()) {
    const since = toMs(now, this.now()) - ms;
    return this.state.pushes.filter((p) => toMs(p, 0) >= since).length;
  }

  // ─── owner overrides ────────────────────────────────────────────────────

  // A counted send that failed in the background gives its attempt back.
  // sent: that send's entry ({ at, messageHash }), else the newest one. Its
  // words never reached the agent, so it is failed whatever the budget says:
  // a "sent" hash would refuse the next identical nudge as a repeat.
  undoAttempt(key, sent = null) {
    const ledger = this.state.ledger[key];
    if (!ledger) return null;
    const entry = sent
      ? ledger.nudges.findLast((nudge) => nudge.status === "sent" && nudge.at === sent.at && nudge.messageHash === (sent.messageHash ?? null))
      : ledger.nudges.at(-1);
    const failed = entry?.status === "sent";
    if (failed) entry.status = "failed";
    if (!failed && !(ledger.attemptsWithoutProgress > 0)) return null;
    if (ledger.attemptsWithoutProgress > 0) ledger.attemptsWithoutProgress -= 1;
    this._save();
    return structuredClone(ledger);
  }

  // "keep going" on a stuck question gives the thread a fresh nudge budget.
  resetAttempts(key) {
    const ledger = this.state.ledger[key];
    if (!ledger) return null;
    ledger.attemptsWithoutProgress = 0;
    // Lifts the policy's hold on an answered nudge (resolveNudge).
    ledger.keepGoingAt = iso(this.now());
    this._save();
    return structuredClone(ledger);
  }

  // "stop" / "skip" silences a thread until the given time.
  mute(key, until) {
    if (!key) return null;
    this.state.muted[key] = iso(toMs(until, this.now()));
    this._save();
    return this.state.muted[key];
  }

  mutedUntil(key) {
    const until = this.state.muted[key];
    return until && toMs(until, 0) > this.now() ? until : null;
  }

  mutedKeys() {
    return new Set(Object.keys(this.state.muted).filter((key) => this.mutedUntil(key)));
  }

  // ─── owner feedback and self-fix requests ───────────────────────────────

  // Throws on bad input (the caller's words go back to the owner); a disk
  // error is kept in lastWriteError like every other write.
  recordFeedback(input) {
    const record = normalizeFeedback(input, { now: this.now() });
    this.state.feedback.push(record);
    if (this.state.feedback.length > FEEDBACK_KEPT) this.state.feedback.splice(0, this.state.feedback.length - FEEDBACK_KEPT);
    this._save();
    return { ...record };
  }

  // Newest first.
  feedback({ status = null, limit = 50 } = {}) {
    return this.state.feedback.filter((record) => !status || record.status === status)
      .slice(-Math.max(0, limit)).reverse().map((record) => structuredClone(record));
  }

  updateFeedback(id, patch) {
    const record = this.state.feedback.find((item) => item.id === id);
    if (!record) return null;
    Object.assign(record, feedbackPatch(record, patch));
    this._save();
    return structuredClone(record);
  }

  // Feedback cited by a repair moves to fix-queued.
  queueFix(input) {
    const fix = normalizeFixRequest(input, { now: this.now() });
    this.state.fixes.push(fix);
    if (this.state.fixes.length > FIXES_KEPT) this.state.fixes.splice(0, this.state.fixes.length - FIXES_KEPT);
    for (const id of fix.evidence.feedbackIds) {
      const record = this.state.feedback.find((item) => item.id === id);
      if (record && ["new", "triaged"].includes(record.status)) Object.assign(record, { status: "fix-queued", fixId: fix.id });
    }
    this._save();
    return structuredClone(fix);
  }

  importFix(input) {
    if (!input?.id) return this.queueFix(input);
    if (!/^fix_[a-f0-9]{16}$/.test(input.id)) throw new Error("Invalid fix id.");
    const existing = this.fix(input.id);
    if (existing) return existing;
    const fix = normalizeFixRequest(input, { now: this.now() });
    fix.id = input.id;
    this.state.fixes.push(fix);
    this._save();
    return structuredClone(fix);
  }

  updateFix(id, patch) {
    const fix = this.state.fixes.find((item) => item.id === id);
    if (!fix) return null;
    const next = structuredClone(patch);
    delete next.id;
    Object.assign(fix, next, { updatedAt: iso(this.now()) });
    for (const feedbackId of fix.evidence.feedbackIds) {
      const record = this.state.feedback.find((item) => item.id === feedbackId);
      const status = fix.outcome ?? (fix.prUrl ? "pr-open" : null);
      if (record && status && !["merged", "declined"].includes(record.status)) Object.assign(record, { status });
    }
    this._save();
    return structuredClone(fix);
  }

  fixCommands() { return structuredClone(this.state.fixCommands); }

  queueFixCommand(key, command) {
    this.state.fixCommands[key] = structuredClone(command);
    this._save();
  }

  clearFixCommand(key) { delete this.state.fixCommands[key]; this._save(); }

  acquireFixLock(id, area) {
    if (Object.values(this.state.fixLocks).some((owner) => owner !== id)) return false;
    this.state.fixLocks[area] = id;
    this._save();
    return !this.lastWriteError;
  }

  releaseFixLock(id) {
    for (const [area, owner] of Object.entries(this.state.fixLocks)) if (owner === id) delete this.state.fixLocks[area];
    this._save();
  }

  fixes({ state = null } = {}) {
    return this.state.fixes.filter((fix) => !state || fix.state === state).slice().reverse().map((fix) => structuredClone(fix));
  }

  fix(id) {
    const fix = this.state.fixes.find((item) => item.id === id);
    return fix ? structuredClone(fix) : null;
  }

  reviseFix(id, instructions) {
    const fix = this.state.fixes.find((item) => item.id === id);
    if (!fix) return null;
    Object.assign(fix, fixRevision(fix, instructions, { now: this.now() }));
    this._save();
    return structuredClone(fix);
  }

  // "all" stops every fix not already stopped, except open PRs awaiting the owner. Returns the fixes it stopped.
  stopFix(id) {
    const at = iso(this.now());
    const stopped = this.state.fixes.filter((fix) => (id === "all" ? fix.state !== "owner-ask" : fix.id === id) && !["abandoned", "done", "failed"].includes(fix.state));
    for (const fix of stopped) Object.assign(fix, { state: "abandoned", stoppedAt: at, updatedAt: at });
    if (stopped.length) this._save();
    return stopped.map((fix) => structuredClone(fix));
  }

  // Codex session ids of the supervisor's own fixers, so it never nudges them.
  selfSessions() {
    return this.state.selfSessions.map((session) => session.id);
  }

  addSelfSession(id, fixId = null) {
    if (typeof id !== "string" || !id.trim() || this.state.selfSessions.some((session) => session.id === id)) return false;
    this.state.selfSessions.push({ id: id.slice(0, 200), fixId: typeof fixId === "string" ? fixId.slice(0, 80) : null, at: iso(this.now()) });
    if (this.state.selfSessions.length > SELF_SESSIONS_KEPT) this.state.selfSessions.splice(0, this.state.selfSessions.length - SELF_SESSIONS_KEPT);
    this._save();
    return true;
  }

  // The owner's Unmute: the thread is watched and nudged again.
  unmute(key) {
    if (!key || !Object.hasOwn(this.state.muted, key)) return false;
    delete this.state.muted[key];
    this._save();
    return true;
  }

  // thread key -> when its latest closed question closed (answered,
  // dismissed, resolved or expired), for the group its row falls back to.
  closedAtByThread() {
    const out = new Map();
    for (const question of this.state.questions) {
      if (question.status === "open") continue;
      const at = question.answeredAt ?? question.expiredAt ?? null;
      if (!Number.isFinite(toMs(at, NaN))) continue;
      for (const key of [question.threadKey, ...(question.threadKeys ?? [])].filter(Boolean)) {
        if (!out.has(key) || toMs(out.get(key), 0) < toMs(at, 0)) out.set(key, at);
      }
    }
    return out;
  }

  // ─── internals ──────────────────────────────────────────────────────────

  _findQuestion(id) {
    return this.state.questions.find((q) => q.id === id) ?? null;
  }

  // An owner close, or a review close of the same ask, still holding it back.
  _ownerClosed(key, now, fields = {}) {
    let latest = null;
    for (const question of this.state.questions) {
      if (question.dedupeKey !== key) continue;
      // A close covers the threads it named: a group that now names others
      // (widened, or members shifted in) is a new question.
      if (!(OWNER_CLOSED.has(question.status) || isReviewClosed(question)) || widens(question, fields)) continue;
      if (toMs(question.answeredAt, null) === null || holdEnded(question, now)) continue;
      if (!latest || heldSinceMs(question) > heldSinceMs(latest)) latest = question;
    }
    return latest;
  }

  // The latest expiry of this ask, while it still holds the ask back.
  _expiredHold(key, now, fields = {}) {
    let latest = null;
    for (const question of this.state.questions) {
      if (question.dedupeKey !== key || question.status !== "expired" || widens(question, fields)) continue;
      const expiredAt = toMs(question.expiredAt ?? question.updatedAt, null);
      if (expiredAt === null || now - expiredAt >= QUESTION_TTL_MS) continue;
      if (!latest || expiredAt > toMs(latest.expiredAt ?? latest.updatedAt, 0)) latest = question;
    }
    return latest;
  }

  // An open agent ask on the same thread from an older agent message takes
  // this newer ask in place. Its review and wording start over. The same
  // question restated (both ask to merge, or the same words, about the same
  // PR) keeps its push and its expiry; a different one is put to the owner
  // anew, with its own day and push (milan: a new decision 23 h into an old
  // ask would expire an hour later, never pushed, then stay quiet a day).
  _supersedeAgentAsk(key, fields, origin, head, now) {
    if (fields.kind !== "agent-ask" || !fields.threadKey) return null;
    const askedAt = toMs(origin.agentAskedAt, null);
    if (askedAt === null) return null;
    const older = this.state.questions.find((q) => q.status === "open" && q.kind === "agent-ask" && q.threadKey === fields.threadKey
      && toMs(q.agentAskedAt, null) !== null && toMs(q.agentAskedAt, 0) < askedAt);
    if (!older) return null;
    const norm = (text) => String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    // A merge ask about another PR is a new question, whatever its words.
    const samePr = !older.prRef || !fields.prRef || older.prRef === fields.prRef;
    // Titles are generic per topic ("wants a prod step. OK?" for every prod
    // approval), so only the ask itself counts: the same body, or both merge
    // asks about the same PR. The title decides only when neither has a body.
    const body = norm(fields.body);
    const restated = samePr && ((older.mergeAsk && fields.mergeAsk)
      || (body ? norm(older.body) === body : !norm(older.body) && norm(older.title) === norm(fields.title)));
    Object.assign(older, fields, origin, {
      dedupeKey: key, askedAs: null, pinned: false, reviewedAt: null, reviewFingerprint: null, reviewReason: null, reviewCategory: null, reviewStreak: 0,
      supersededAt: iso(now), updatedAt: iso(now), lastAskedAt: iso(now), scanAskedAt: iso(now), ...(head ? { askedHead: head } : {}),
      ...(restated ? {} : { liveSince: iso(now), expiresAt: iso(now + QUESTION_TTL_MS), pushedAt: null })
    });
    this._save();
    return { ...older, superseded: true };
  }

  // Judge asks a build before 2026-10-12 saved under the judge's own key
  // (judge:<thread>:<hash>, no askedBy) take the key a scan now gives the
  // same ask (keyFor: policy's agentAskKey, on the agent message it came
  // from) and say the judge asked them. Else an answer kept for typing is
  // dropped as superseded on the first scan: the judge does not read a
  // thread whose answer waits, so nothing asks that key again.
  migrateJudgeAskKeys(keyFor) {
    const openKeys = new Set(this.state.questions.filter((q) => q.status === "open").map((q) => q.dedupeKey));
    let changed = false;
    for (const question of this.state.questions) {
      const key = String(question.dedupeKey ?? "");
      if (question.kind !== "agent-ask" || !question.threadKey || !key.startsWith(`judge:${question.threadKey}:`)) continue;
      if (!question.askedBy) {
        question.askedBy = "judge";
        changed = true;
      }
      if (!Number.isFinite(Date.parse(question.agentAskedAt ?? ""))) continue;
      const next = keyFor(question.threadKey, { at: question.agentAskedAt });
      // Never a second open question under one key.
      if (!next || (question.status === "open" && openKeys.has(next))) continue;
      if (question.status === "open") openKeys.add(next);
      question.dedupeKey = next;
      changed = true;
    }
    if (changed) this._save();
    return changed;
  }

  // An agent ask a build before 2026-10-12 saved under its wording's key
  // (ask:<thread>:<text hash>) is the same ask as one asked now about the
  // same agent message: it takes the new key, whatever its status, so an
  // open one is not asked twice, an answered or dismissed one holds, and an
  // answer kept for typing is not dropped as superseded. Records saved since
  // carry mergeAsk; a structured ask's key (its own id) never changed.
  _adoptLegacyAsk(key, fields, origin) {
    if (fields.kind !== "agent-ask" || !fields.threadKey) return;
    const askedAt = toMs(origin.agentAskedAt, null);
    if (askedAt === null) return;
    let latest = null;
    for (const question of this.state.questions) {
      if (question.kind !== "agent-ask" || question.threadKey !== fields.threadKey || Object.hasOwn(question, "mergeAsk")) continue;
      if (question.dedupeKey === key || !String(question.dedupeKey ?? "").startsWith(`ask:${fields.threadKey}:`)) continue;
      if (toMs(question.agentAskedAt, null) !== askedAt) continue;
      if (!latest || toMs(question.updatedAt, 0) > toMs(latest.updatedAt, 0)) latest = question;
    }
    if (!latest) return;
    latest.dedupeKey = key;
    this._save();
  }

  _recentlyResolved(key, now) {
    let latest = null;
    for (const question of this.state.questions) {
      // A review close is never a blip.
      if (question.dedupeKey !== key || question.status !== "resolved" || isReviewClosed(question)) continue;
      const closedAt = toMs(question.answeredAt, null);
      if (closedAt === null || now - closedAt >= REOPEN_MS) continue;
      if (!latest || closedAt > toMs(latest.answeredAt, 0)) latest = question;
    }
    return latest;
  }

  _closeQuestion(id, status, answer, extra = {}) {
    const now = this.now();
    this._expireQuestions(now);
    const question = this._findQuestion(id);
    if (!question || question.status !== "open") return null;
    question.status = status;
    question.answer = answer;
    question.answeredAt = iso(now);
    question.updatedAt = iso(now);
    Object.assign(question, extra);
    this._save();
    return { ...question };
  }

  // A question expires a TTL after it was put to the owner, still asked or
  // not: an ask nobody answered in a day leaves the list (see _expiredHold).
  _expireQuestions(now) {
    let changed = false;
    for (const question of this.state.questions) {
      if (question.status !== "open") continue;
      if (now - liveSinceMs(question) < QUESTION_TTL_MS) continue;
      question.status = "expired";
      question.expiredAt = iso(now);
      question.updatedAt = iso(now);
      if (question.outreachId) this.expired.push({ ...question });
      changed = true;
    }
    if (changed) this._save();
    return changed;
  }

  _pruneQuestions() {
    // Least recently asked first, so a close still holding back an ask stays.
    // An answer still waiting to be typed is the only copy: never pruned.
    const closed = this.state.questions.filter((q) => q.status !== "open" && !q.pendingDelivery).sort((a, b) => lastAskMs(a) - lastAskMs(b));
    if (closed.length <= CLOSED_QUESTIONS_KEPT) return;
    const drop = new Set(closed.slice(0, closed.length - CLOSED_QUESTIONS_KEPT));
    this.state.questions = this.state.questions.filter((q) => !drop.has(q));
  }

  _load() {
    const base = emptyState();
    let raw = null;
    try {
      ensureDir(this.dir);
      // An unusable file is quarantined by readJsonFile and we start empty.
      raw = readJsonFile(this.statePath, null);
    } catch (error) {
      this.lastWriteError = error?.message ?? String(error);
    }
    if (!isObject(raw)) return base;
    return {
      ...base,
      mode: MODES.includes(raw.mode) ? raw.mode : null,
      snapshot: raw.snapshot ?? null,
      ledger: isObject(raw.ledger) ? raw.ledger : {},
      questions: Array.isArray(raw.questions) ? raw.questions.filter(isObject) : [],
      actions: Array.isArray(raw.actions) ? raw.actions.filter(isObject) : [],
      escalations: isObject(raw.escalations) ? raw.escalations : {},
      infraDown: isObject(raw.infraDown) ? raw.infraDown : {},
      infraBlocked: isObject(raw.infraBlocked) ? raw.infraBlocked : {},
      uiBlockedSince: isObject(raw.uiBlockedSince) ? raw.uiBlockedSince : {},
      infraUp: isObject(raw.infraUp) ? raw.infraUp : {},
      pushes: Array.isArray(raw.pushes) ? raw.pushes.filter((p) => typeof p === "string") : [],
      muted: isObject(raw.muted) ? raw.muted : {},
      appRestarts: isObject(raw.appRestarts) ? raw.appRestarts : {},
      restartedAt: isObject(raw.restartedAt) ? raw.restartedAt : {},
      feedback: Array.isArray(raw.feedback) ? raw.feedback.filter(isObject) : [],
      fixCommands: isObject(raw.fixCommands) ? raw.fixCommands : {},
      fixLocks: isObject(raw.fixLocks) ? raw.fixLocks : {},
      fixes: Array.isArray(raw.fixes) ? raw.fixes.filter(isObject) : [],
      suggestions: Array.isArray(raw.suggestions) ? raw.suggestions.filter(isObject) : [],
      diagnosis: isObject(raw.diagnosis) ? raw.diagnosis : {},
      selfSessions: Array.isArray(raw.selfSessions) ? raw.selfSessions.filter((s) => isObject(s) && typeof s.id === "string") : []
    };
  }

  _save() {
    try {
      writeJsonAtomic(this.statePath, this.state);
      this.lastWriteError = null;
    } catch (error) {
      this.lastWriteError = error?.message ?? String(error);
    }
  }

  _journal(entry) {
    try {
      appendJsonLine(this.journalPath, entry);
      this.rotateActions();
    } catch (error) {
      this.lastWriteError = error?.message ?? String(error);
    }
  }
}
