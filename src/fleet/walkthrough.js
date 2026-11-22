import path from "node:path";
import { readJsonFile, writeJsonAtomic, ensureDir } from "../file-utils.js";
import { isQuestionLiveForDeck } from "./cards.js";

const VERSION = 1;
const MAX_ITEMS = 40;
const ID_MAX = 160;
const OPS = new Set(["view", "start", "next", "back", "skip", "pause", "resume"]);
const clean = (value, max = 240) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const supportedOptions = options => (Array.isArray(options) ? options : [])
  .filter(value => typeof value === "string" && value && !["dismiss", "answer question", "review plan"].includes(value.toLowerCase()))
  .map(value => clean(value, 60)).slice(0, 4);

export class WalkthroughError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = "WalkthroughError";
    this.code = code;
    this.status = status;
  }
}

function fail(code, status, message) { throw new WalkthroughError(code, status, message); }

function normalizeState(raw) {
  const state = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const ids = Array.isArray(state.itemIds)
    ? [...new Set(state.itemIds.filter(id => typeof id === "string" && id.length > 0 && id.length <= ID_MAX))].slice(0, MAX_ITEMS)
    : [];
  return {
    version: VERSION,
    active: state.active === true,
    paused: state.paused === true,
    itemIds: ids,
    currentId: typeof state.currentId === "string" && state.currentId.length <= ID_MAX ? state.currentId : null,
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : null
  };
}

function cardItem(card) {
  if (!card || typeof card !== "object" || typeof card.id !== "string" || !card.id) return null;
  const title = clean(card.decisionHeadline ?? card.headline ?? card.title ?? "Needs your decision", 180);
  return {
    id: clean(card.id, ID_MAX), kind: "card", title,
    summary: clean(card.decisionFact ?? card.summary ?? card.body ?? "Review this Supervisor card.", 500),
    questionId: typeof card.questionId === "string" ? clean(card.questionId, ID_MAX) : null,
    threadKey: typeof card.threadKey === "string" ? clean(card.threadKey, ID_MAX) : null,
    cardId: clean(card.id, ID_MAX),
    cardKind: typeof card.kind === "string" ? clean(card.kind, 60) : null,
    prRef: typeof card.prRef === "string" ? clean(card.prRef, 100) : null,
    primaryLabel: typeof card.primaryAction?.label === "string" ? clean(card.primaryAction.label, 80) : (typeof card.primaryLabel === "string" ? clean(card.primaryLabel, 80) : null),
    ciState: typeof card.ciState === "string" ? clean(card.ciState, 24) : null,
    pmBrief: typeof card.pmBrief === "string" ? clean(card.pmBrief, 500) : null,
    options: supportedOptions(card.options)
  };
}

function questionItem(question, cards) {
  if (!question || typeof question !== "object" || typeof question.id !== "string" || !question.id) return null;
  if (cards.some(card => card.questionId === question.id)) return null;
  return {
    id: clean(question.id, ID_MAX), kind: "question", title: clean(question.title ?? "Needs your decision", 180),
    summary: clean(question.body ?? question.card ?? "The Supervisor is waiting for your choice.", 500),
    questionId: clean(question.id, ID_MAX),
    threadKey: typeof question.threadKey === "string" ? clean(question.threadKey, ID_MAX) : null,
    cardId: null, cardKind: null, prRef: typeof question.prRef === "string" ? clean(question.prRef, 100) : null,
    options: supportedOptions(question.options)
  };
}

/** Build one bounded, stable Needs You list from the Supervisor's current cards. */
export function walkthroughItems(supervisorState) {
  const rawCards = Array.isArray(supervisorState?.cards) ? supervisorState.cards : [];
  const blockedQuestionIds = new Set(rawCards
    .filter(card => card && typeof card === "object" && card.needsYou === false)
    .map(card => card.questionId)
    .filter(id => typeof id === "string" && id));
  const cards = rawCards.filter(card => card?.needsYou !== false).map(cardItem).filter(Boolean);
  const rows = new Map((supervisorState?.snapshot?.threads ?? []).filter(row => row?.key).map(row => [row.key, row]));
  const preferences = supervisorState?.preferences ?? supervisorState?.snapshot?.preferences ?? null;
  const questions = (Array.isArray(supervisorState?.questions) ? supervisorState.questions : [])
    .filter(question => !blockedQuestionIds.has(question?.id))
    .filter(question => {
      if (!question || typeof question !== "object") return false;
      // Older Supervisor snapshots omitted status; treat those as open while
      // applying the same settled, superseded, and quiet-cadence predicates.
      const liveQuestion = question.status == null ? { ...question, status: "open" } : question;
      return isQuestionLiveForDeck(liveQuestion, question.threadKey ? rows.get(question.threadKey) : null, preferences);
    })
    .map(q => questionItem(q, cards)).filter(Boolean);
  return [...cards, ...questions].slice(0, MAX_ITEMS);
}

export class SupervisorWalkthrough {
  constructor({ dataDir, file, now = () => Date.now() } = {}) {
    this.file = file ?? path.join(dataDir ?? process.cwd(), "fleet", "walkthrough.json");
    this.now = now;
    this.state = normalizeState(readJsonFile(this.file, {}));
  }

  save() {
    ensureDir(path.dirname(this.file));
    writeJsonAtomic(this.file, this.state);
  }

  reload() {
    this.state = normalizeState(readJsonFile(this.file, {}));
  }

  read(supervisorState) {
    // Fleet routes and G2 proactive dispatch each own a handler instance, but
    // the cursor is one durable main-owned state. Reload before every read so
    // a mutation from another surface is visible immediately.
    this.reload();
    const items = walkthroughItems(supervisorState);
    const live = new Set(items.map(item => item.id));
    this.state.itemIds = this.state.itemIds.filter(id => live.has(id));
    if (!this.state.active || !this.state.itemIds.length) {
      this.state.currentId = null;
    } else if (!this.state.currentId || !live.has(this.state.currentId)) {
      this.state.currentId = this.state.itemIds[0];
    }
    const current = items.find(item => item.id === this.state.currentId) ?? null;
    return { ...this.state, total: this.state.itemIds.length, current, items: this.state.itemIds.map(id => items.find(item => item.id === id)).filter(Boolean) };
  }

  mutate(operation, expectedId, supervisorState) {
    const op = typeof operation === "string" ? operation : "view";
    if (!OPS.has(op)) fail("invalid_walkthrough_operation", 400, "Choose view, start, next, back, skip, pause or resume.");
    const before = this.read(supervisorState);
    if (expectedId !== undefined && (typeof expectedId !== "string" || expectedId.length > ID_MAX)) fail("invalid_walkthrough_item", 400, "The walkthrough item identity is invalid.");
    if (expectedId && before.currentId && expectedId !== before.currentId) fail("walkthrough_changed", 409, "The Supervisor card changed. Refresh Needs You before continuing.");
    if (op === "start") {
      this.state.active = true; this.state.paused = false;
      this.state.itemIds = walkthroughItems(supervisorState).map(item => item.id).slice(0, MAX_ITEMS);
      this.state.currentId = this.state.itemIds[0] ?? null;
    } else if (op === "pause") {
      if (!this.state.active) fail("walkthrough_not_active", 409, "Start the Needs You walkthrough first.");
      this.state.paused = true;
    } else if (op === "resume") {
      if (!this.state.active) fail("walkthrough_not_active", 409, "Start the Needs You walkthrough first.");
      this.state.paused = false;
    } else if (["next", "skip", "back"].includes(op)) {
      if (!this.state.active) fail("walkthrough_not_active", 409, "Start the Needs You walkthrough first.");
      if (this.state.paused) fail("walkthrough_paused", 409, "Resume the Needs You walkthrough first.");
      const index = Math.max(0, this.state.itemIds.indexOf(this.state.currentId));
      const delta = op === "back" ? -1 : 1;
      this.state.currentId = this.state.itemIds[Math.min(this.state.itemIds.length - 1, Math.max(0, index + delta))] ?? null;
    }
    this.state.updatedAt = new Date(this.now()).toISOString();
    this.save();
    return this.read(supervisorState);
  }
}
