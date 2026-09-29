// Owner-only persistent state for the fleet supervisor: mode, last snapshot,
// per-thread nudge ledger, needs-you questions, escalations, and the action
// log. One JSON file (0600) plus an append-only actions.jsonl journal.
// Methods never throw on disk errors; the last one is kept in lastWriteError.

import { randomUUID } from "node:crypto";
import path from "node:path";
import { appendJsonLine, ensureDir, readJsonFile, writeJsonAtomic } from "../file-utils.js";
import { DEFAULTS, MODES, clampTail, clampText, redactSecrets } from "./contracts.js";

const QUESTION_TTL_MS = 24 * 60 * 60 * 1000;
// A question the supervisor closed and that is asked again this soon was a
// blip: the same record comes back instead of a new one.
const REOPEN_MS = 60 * 60 * 1000;
const PUSH_KEEP_MS = 24 * 60 * 60 * 1000;
const NUDGES_KEPT = 20;
const CLOSED_QUESTIONS_KEPT = 200;
const OPTIONS_MAX = 4;
const OPTION_MAX_CHARS = 40;
const INFRA_BLOCKED_KEPT = 200;
// The owner closed these; the same ask stays quiet for a TTL.
const OWNER_CLOSED = new Set(["answered", "dismissed"]);
// A review close is the model's guess, so it holds only this long; then the
// same ask comes back as a new question, reviewed again before it pings.
const REVIEW_HOLD_MS = 6 * 60 * 60 * 1000;
// The agent message an ask came from, for the review.
const ASK_CONTEXT_MAX = 600;

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
const BENIGN_BLOCKS = /^(owner using |turn running|frontmost app changed)/;

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
    infraUp: {},
    pushes: [],
    muted: {}
  };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  return question.status === "dismissed" || question.kind === "agent-ask" || isReviewClosed(question);
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
      messageHash: entry.messageHash ?? null
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
      const prev = ledger.undelivered ?? null;
      ledger.undelivered = { count: (prev?.count ?? 0) + 1, since: prev?.since ?? at, lastAt: at, reason: clampText(detail, 160) || status, ackedAt: prev?.ackedAt ?? null };
    } else if (REACHED_STATUSES.has(status)) {
      ledger.undelivered = null;
    }
    this.state.ledger[key] = ledger;
    this._save();
    return structuredClone(ledger);
  }

  // ─── needs-you questions ────────────────────────────────────────────────

  upsertQuestion({ dedupeKey, kind = null, threadKey = null, threadKeys = null, prRef = null, title, body = "", options = [], playbook = null, askContext = null, agentAskedAt = null } = {}) {
    const now = this.now();
    this._expireQuestions(now);
    // Where an agent's ask came from, as first seen: the thread may move on
    // while the ask stays open.
    const origin = { askContext: clampTail(redactSecrets(askContext), ASK_CONTEXT_MAX) || null, agentAskedAt: agentAskedAt ?? null };
    const fields = {
      threadKey: threadKey ?? null,
      prRef: prRef ?? null,
      title: clampText(redactSecrets(title), this.limits.titleMax) || "(untitled)",
      body: clampText(redactSecrets(body), this.limits.bodyMax),
      options: normalizeOptions(options),
      playbook: playbook ?? null,
      kind: kind ?? null,
      // Grouped questions ("5 threads capped") cover several threads.
      threadKeys: Array.isArray(threadKeys) && threadKeys.length ? threadKeys.slice(0, 50) : null
    };
    const key = String(dedupeKey ?? "").trim() || `${fields.threadKey ?? "fleet"}:${fields.title}`;
    const existing = this.state.questions.find((q) => q.status === "open" && q.dedupeKey === key);
    if (existing) {
      // Still asked, so it has not expired. Not saved on its own: the next
      // write (at least the tick's snapshot) carries it.
      Object.assign(existing, { lastAskedAt: iso(now), expiresAt: iso(now + QUESTION_TTL_MS) });
      if (!existing.askContext && origin.askContext) Object.assign(existing, origin);
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
    const closed = fields.kind === "deliver" ? null : this._ownerClosed(key, now, fields);
    if (closed) {
      if (holdsWhileAsked(closed)) closed.lastAskedAt = iso(now);
      return { ...closed, suppressed: true };
    }
    // Same record, same outreach copy, no second push.
    const resolved = this._recentlyResolved(key, now);
    if (resolved) {
      keepReviewWording(resolved, fields);
      Object.assign(resolved, fields, origin.askContext ? origin : {}, {
        status: "open", answeredAt: null, resolveReason: null, reopenedAt: iso(now), updatedAt: iso(now),
        lastAskedAt: iso(now), expiresAt: iso(now + QUESTION_TTL_MS)
      });
      this._save();
      return { ...resolved, reopened: true };
    }
    const question = {
      id: makeId("fq"),
      dedupeKey: key,
      ...fields,
      ...(origin.askContext ? origin : {}),
      status: "open",
      answer: null,
      createdAt: iso(now),
      updatedAt: iso(now),
      answeredAt: null,
      lastAskedAt: iso(now),
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

  // A background send that never reached the agent puts the owner's answer
  // back in front of them instead of suppressing the question for a day,
  // and a retry sends to those threads again. A different, later answer
  // from the owner is not undone.
  reopenQuestion(id, undeliveredKeys = [], { answer = null } = {}) {
    const question = this._findQuestion(id);
    if (!question || !["open", "answered"].includes(question.status)) return null;
    if (question.status === "answered" && (answer === null || question.answer === answer)) {
      Object.assign(question, { status: "open", answer: null, answeredAt: null, outreachId: null, reopenedAt: null, updatedAt: iso(this.now()) });
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
      reopenedAt: iso(now), updatedAt: iso(now), lastAskedAt: iso(now), expiresAt: iso(now + QUESTION_TTL_MS)
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
  undoAttempt(key) {
    const ledger = this.state.ledger[key];
    if (!ledger || !(ledger.attemptsWithoutProgress > 0)) return null;
    ledger.attemptsWithoutProgress -= 1;
    const last = ledger.nudges.at(-1);
    if (last?.status === "sent") last.status = "failed";
    this._save();
    return structuredClone(ledger);
  }

  // "keep going" on a stuck question gives the thread a fresh nudge budget.
  resetAttempts(key) {
    const ledger = this.state.ledger[key];
    if (!ledger) return null;
    ledger.attemptsWithoutProgress = 0;
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

  // ─── internals ──────────────────────────────────────────────────────────

  _findQuestion(id) {
    return this.state.questions.find((q) => q.id === id) ?? null;
  }

  // An owner close, or a review close of the same ask, still holding it back.
  _ownerClosed(key, now, fields = {}) {
    let latest = null;
    for (const question of this.state.questions) {
      if (question.dedupeKey !== key) continue;
      if (!OWNER_CLOSED.has(question.status) && !(isReviewClosed(question) && !widens(question, fields))) continue;
      if (toMs(question.answeredAt, null) === null || holdEnded(question, now)) continue;
      if (!latest || heldSinceMs(question) > heldSinceMs(latest)) latest = question;
    }
    return latest;
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

  // Only a TTL with no ask expires a question; one still asked every tick
  // keeps its id.
  _expireQuestions(now) {
    let changed = false;
    for (const question of this.state.questions) {
      if (question.status !== "open") continue;
      if (now - lastAskMs(question) < QUESTION_TTL_MS) continue;
      question.status = "expired";
      question.updatedAt = iso(now);
      if (question.outreachId) this.expired.push({ ...question });
      changed = true;
    }
    if (changed) this._save();
    return changed;
  }

  _pruneQuestions() {
    // Least recently asked first, so a close still holding back an ask stays.
    const closed = this.state.questions.filter((q) => q.status !== "open").sort((a, b) => lastAskMs(a) - lastAskMs(b));
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
      infraUp: isObject(raw.infraUp) ? raw.infraUp : {},
      pushes: Array.isArray(raw.pushes) ? raw.pushes.filter((p) => typeof p === "string") : [],
      muted: isObject(raw.muted) ? raw.muted : {}
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
    } catch (error) {
      this.lastWriteError = error?.message ?? String(error);
    }
  }
}
