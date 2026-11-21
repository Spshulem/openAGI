// "Walk me through what needs me": one Needs You card at a time, with a
// position that lives here, not in a model's head. Voice and the typed
// Supervisor chat call the same tool, so a dropped voice session continues
// by text at the same card.
//
// Order: cards that need a decision first, in the deck's own order, then
// FYIs (live cards the deck marks needsYou: false). Preference cards are
// settings suggestions, not Needs You items, and are left out.
//
// Identity: an entry is a card id (the question id). Every answer names the
// card id, question id and PR head SHA, and never silently swaps cards: if
// the card under the cursor was resolved elsewhere, the answer says so and
// moves to the next live card.

import fs from "node:fs";
import path from "node:path";

export const WALKTHROUGH_OPS = Object.freeze(["start", "current", "next", "skip", "back", "goto", "pause", "resume", "end"]);
const CLIP = 600;
const clip = (value, length = CLIP) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, length);

function orderOf(cards) {
  const live = (Array.isArray(cards) ? cards : []).filter((card) => card?.id && card.kind !== "preference");
  const decisions = live.filter((card) => card.needsYou !== false);
  const fyis = live.filter((card) => card.needsYou === false);
  return [
    ...decisions.map((card) => ({ cardId: String(card.id), group: "decision" })),
    ...fyis.map((card) => ({ cardId: String(card.id), group: "fyi" }))
  ];
}

// What the narrator needs about one card: short, and identity first.
function itemOf(card, entry) {
  return {
    cardId: String(card.id),
    questionId: card.questionId ?? String(card.id),
    group: entry.group,
    kind: card.kind ?? null,
    kindLabel: card.kindLabel ?? null,
    headline: clip(card.headline, 200),
    brief: clip(card.brief ?? card.summary, CLIP),
    recommendation: clip(card.recommendation, 300) || null,
    options: Array.isArray(card.options) ? card.options.slice(0, 6).map((option) => clip(option, 80)) : [],
    primaryAction: card.primaryAction?.label ? clip(card.primaryAction.label, 80) : null,
    threadKey: card.threadKey ?? null,
    prRef: card.prRef ?? null,
    headSha: card.headSha ?? null,
    workspace: card.workspace ?? null
  };
}

export class Walkthrough {
  constructor({ dir = null, now = () => Date.now() } = {}) {
    this.file = dir ? path.join(dir, "walkthrough.json") : null;
    this.now = now;
    this.memory = null;
  }

  load() {
    if (!this.file) return this.memory;
    try { return JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { return null; }
  }

  save(state) {
    if (!this.file) { this.memory = state; return; }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, this.file);
  }

  // One step. `cards` is the live deck (supervisor.getState().cards).
  step(op = "current", cards = [], { cardId = null } = {}) {
    if (!WALKTHROUGH_OPS.includes(op)) throw new Error(`Unknown walkthrough step "${clip(op, 40)}".`);
    const byId = new Map((Array.isArray(cards) ? cards : []).filter((card) => card?.id).map((card) => [String(card.id), card]));
    let state = this.load();
    const stamp = new Date(this.now()).toISOString();
    if (op === "start" || !state) {
      if (op !== "start" && op !== "current") return { active: false, message: "No walkthrough is open. Start one first." };
      state = { startedAt: stamp, updatedAt: stamp, order: orderOf(cards), index: 0, paused: false, outcomes: {} };
    }
    if (op === "end") {
      this.save(null);
      return { active: false, ended: true, message: "Walkthrough ended." };
    }

    // Live cards that were added since the walkthrough began join the end of
    // their group, so a new decision is not lost behind FYIs.
    const known = new Set(state.order.map((entry) => entry.cardId));
    for (const entry of orderOf(cards)) {
      if (known.has(entry.cardId)) continue;
      const at = entry.group === "decision" ? state.order.findIndex((e, i) => i > state.index && e.group === "fyi") : -1;
      if (at === -1) state.order.push(entry); else state.order.splice(at, 0, entry);
    }

    const current = state.order[state.index];
    if (op === "pause") state.paused = true;
    else if (op === "resume") state.paused = false;
    else if (op === "next" || op === "skip") {
      if (current) state.outcomes[current.cardId] = op === "skip" ? "skipped" : (state.outcomes[current.cardId] ?? "seen");
      state.index = Math.min(state.index + 1, state.order.length);
      state.paused = false;
    } else if (op === "back") {
      state.index = Math.max(0, state.index - 1);
      state.paused = false;
    } else if (op === "goto") {
      const target = state.order.findIndex((entry) => entry.cardId === String(cardId ?? ""));
      if (target === -1) return { active: true, ...this.view(state, byId, []), message: `Card ${clip(cardId, 80)} is not in this walkthrough.` };
      state.index = target;
      state.paused = false;
    }

    // Never present a card that is no longer live as if it were.
    const resolved = [];
    if (op !== "back" && op !== "goto") {
      while (state.index < state.order.length && !byId.has(state.order[state.index].cardId)) {
        resolved.push(state.order[state.index].cardId);
        state.outcomes[state.order[state.index].cardId] = "resolved";
        state.index += 1;
      }
    }
    state.updatedAt = stamp;
    this.save(state);
    return { active: true, ...this.view(state, byId, resolved) };
  }

  view(state, byId, resolved) {
    const total = state.order.length;
    const entry = state.order[state.index] ?? null;
    const card = entry ? byId.get(entry.cardId) : null;
    const remainingDecisions = state.order.slice(state.index + 1).filter((e) => e.group === "decision" && byId.has(e.cardId)).length;
    return {
      position: entry ? state.index + 1 : total,
      total,
      paused: state.paused === true,
      done: !entry,
      item: card ? itemOf(card, entry) : null,
      ...(entry && !card ? { stale: { cardId: entry.cardId, note: "This card is no longer open." } } : {}),
      ...(resolved.length ? { resolvedSinceLastStep: resolved } : {}),
      remainingDecisions,
      howTo: "Speak this one item only: the headline, a one-sentence brief and the recommendation. Then wait. Act only through fleet_act_card or the matching tool with this exact cardId, read back and confirm as usual, report the actual result, and only then step next."
    };
  }
}
