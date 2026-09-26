// Owner-only persistent state for the fleet supervisor: mode, last snapshot,
// per-thread nudge ledger, needs-you questions, escalations, and the action
// log. One JSON file (0600) plus an append-only actions.jsonl journal.
// Methods never throw on disk errors; the last one is kept in lastWriteError.

import { randomUUID } from "node:crypto";
import path from "node:path";
import { appendJsonLine, ensureDir, readJsonFile, writeJsonAtomic } from "../file-utils.js";
import { DEFAULTS, MODES, clampText, redactSecrets } from "./contracts.js";

const QUESTION_TTL_MS = 24 * 60 * 60 * 1000;
const PUSH_KEEP_MS = 24 * 60 * 60 * 1000;
const NUDGES_KEPT = 20;
const CLOSED_QUESTIONS_KEPT = 200;
const OPTIONS_MAX = 4;
const OPTION_MAX_CHARS = 40;

// Only a delivered nudge spends the no-progress budget. A failed send still
// starts the cooldown so a broken route is not retried every tick; dry-runs,
// proposals, and blocked attempts are history only.
const ATTEMPT_STATUSES = new Set(["sent"]);
const COOLDOWN_STATUSES = new Set(["sent", "failed"]);

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
    pushes: []
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
  return { nudges: [], lastProgressMark: null, attemptsWithoutProgress: 0, lastNudgeAt: null };
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
    this.state.ledger[key] = ledger;
    this._save();
    return structuredClone(ledger);
  }

  // ─── needs-you questions ────────────────────────────────────────────────

  upsertQuestion({ dedupeKey, threadKey = null, prRef = null, title, body = "", options = [], playbook = null } = {}) {
    const now = this.now();
    this._expireQuestions(now);
    const fields = {
      threadKey: threadKey ?? null,
      prRef: prRef ?? null,
      title: clampText(redactSecrets(title), this.limits.titleMax) || "(untitled)",
      body: clampText(redactSecrets(body), this.limits.bodyMax),
      options: normalizeOptions(options),
      playbook: playbook ?? null
    };
    const key = String(dedupeKey ?? "").trim() || `${fields.threadKey ?? "fleet"}:${fields.title}`;
    const existing = this.state.questions.find((q) => q.status === "open" && q.dedupeKey === key);
    if (existing) {
      const changed = Object.keys(fields).some((name) => JSON.stringify(existing[name]) !== JSON.stringify(fields[name]));
      if (changed) {
        Object.assign(existing, fields, { updatedAt: iso(now) });
        this._save();
      }
      return { ...existing };
    }
    const question = {
      id: makeId("fq"),
      dedupeKey: key,
      ...fields,
      status: "open",
      answer: null,
      createdAt: iso(now),
      updatedAt: iso(now),
      answeredAt: null,
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

  dismissQuestion(id) {
    return this._closeQuestion(id, "dismissed", null);
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
    else if (!down && current) delete this.state.infraDown[kind];
    else return this.infraDown(kind);
    this._save();
    return this.infraDown(kind);
  }

  infraDown(kind) {
    return Boolean(this.state.infraDown[kind]);
  }

  infraDownSince(kind) {
    return this.state.infraDown[kind] ?? null;
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

  // ─── internals ──────────────────────────────────────────────────────────

  _findQuestion(id) {
    return this.state.questions.find((q) => q.id === id) ?? null;
  }

  _closeQuestion(id, status, answer) {
    const now = this.now();
    this._expireQuestions(now);
    const question = this._findQuestion(id);
    if (!question || question.status !== "open") return null;
    question.status = status;
    question.answer = answer;
    question.answeredAt = iso(now);
    question.updatedAt = iso(now);
    this._save();
    return { ...question };
  }

  _expireQuestions(now) {
    let changed = false;
    for (const question of this.state.questions) {
      if (question.status !== "open") continue;
      if (now - toMs(question.createdAt, now) < QUESTION_TTL_MS) continue;
      question.status = "expired";
      question.updatedAt = iso(now);
      changed = true;
    }
    if (changed) this._save();
    return changed;
  }

  _pruneQuestions() {
    const closed = this.state.questions.filter((q) => q.status !== "open");
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
      pushes: Array.isArray(raw.pushes) ? raw.pushes.filter((p) => typeof p === "string") : []
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
