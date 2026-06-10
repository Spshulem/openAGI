import path from "node:path";
import { appendJsonLine, ensureDir, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { createId, nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

// Append-only JSONL log + atomic snapshot of recent outcomes.
// Outcome kinds: agent-reply, tool-call, cron-fire, autopilot-fire, sent-message, specialist-action.
// Resolution: each outcome becomes resolved with a qualityScore (0..1) once we can infer how it went.

const SNAPSHOT_LIMIT = 2000; // keep last N resolved + all pending

export class OutcomeStore {
  constructor(options = {}) {
    this.dir = options.dir ?? path.join(resolveDataDir(), "outcomes");
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.snapshotPath = path.join(this.dir, "snapshot.json");
    ensureDir(this.dir);
    const snap = readJsonFile(this.snapshotPath, { version: 1, outcomes: [] });
    this.outcomes = new Map();
    for (const o of snap.outcomes ?? []) this.outcomes.set(o.id, o);
  }

  record(input) {
    const outcome = {
      id: input.id ?? createId("out"),
      kind: input.kind,
      refId: input.refId ?? null,
      signalId: input.signalId ?? null,
      sessionId: input.sessionId ?? null,
      agentId: input.agentId ?? "main",
      channel: input.channel ?? null,
      scrutinyAction: input.scrutinyAction ?? null,
      scrutinyDimensions: input.scrutinyDimensions ?? null,
      toolCalls: input.toolCalls ?? [],
      resolved: false,
      qualityScore: null,
      source: null,
      at: input.at ?? nowIso(),
      resolvedAt: null,
      metadata: input.metadata ?? {}
    };
    this.outcomes.set(outcome.id, outcome);
    appendJsonLine(this.eventsPath, { op: "record", outcome });
    this.persist();
    return outcome;
  }

  resolve(id, qualityScore, source = "system-inferred", note = null) {
    const outcome = this.outcomes.get(id);
    if (!outcome || outcome.resolved) return null;
    outcome.resolved = true;
    outcome.qualityScore = clampScore(qualityScore);
    outcome.source = source;
    outcome.resolvedAt = nowIso();
    if (note) outcome.metadata = { ...outcome.metadata, resolutionNote: note };
    appendJsonLine(this.eventsPath, { op: "resolve", id, qualityScore: outcome.qualityScore, source, at: outcome.resolvedAt });
    if (this.onResolve) this.onResolve(outcome);
    this.persist();
    return outcome;
  }

  pending(maxAgeMs = null) {
    const cutoff = maxAgeMs ? Date.now() - maxAgeMs : null;
    const out = [];
    for (const o of this.outcomes.values()) {
      if (o.resolved) continue;
      if (cutoff && new Date(o.at).getTime() < cutoff) continue;
      out.push(o);
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  recent(limit = 50, kind = null) {
    let list = [...this.outcomes.values()];
    if (kind) list = list.filter((o) => o.kind === kind);
    return list.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }

  byRef(refId) {
    return [...this.outcomes.values()].filter((o) => o.refId === refId);
  }

  bySession(sessionId) {
    return [...this.outcomes.values()].filter((o) => o.sessionId === sessionId);
  }

  bySpecialist(specialistId) {
    return [...this.outcomes.values()].filter((o) => o.metadata?.specialistId === specialistId);
  }

  /// Story 2: outcomes whose metadata.sourceSuggestionId matches. Used
  /// by /proactive/suggestions/:id/outcome to report on "did the thing
  /// the agent proposed actually pan out?"
  bySuggestion(suggestionId) {
    if (!suggestionId) return [];
    return [...this.outcomes.values()].filter((o) => o.metadata?.sourceSuggestionId === suggestionId);
  }

  /// Compact summary of a suggestion's downstream runs. Avg quality
  /// across resolved outcomes; counts by kind. Returns null when the
  /// suggestion has no associated outcomes yet.
  aggregateBySuggestion(suggestionId) {
    const list = this.bySuggestion(suggestionId);
    if (list.length === 0) return null;
    const resolved = list.filter((o) => o.resolved && typeof o.qualityScore === "number");
    const avgQuality = resolved.length === 0 ? null : resolved.reduce((a, b) => a + b.qualityScore, 0) / resolved.length;
    const byKind = {};
    for (const o of list) byKind[o.kind] = (byKind[o.kind] || 0) + 1;
    return {
      total: list.length,
      resolved: resolved.length,
      pending: list.length - resolved.length,
      avgQuality: avgQuality === null ? null : Number(avgQuality.toFixed(3)),
      byKind,
      lastAt: list[list.length - 1]?.at ?? null
    };
  }

  aggregate(windowDays = 7, filter = null) {
    const cutoff = Date.now() - windowDays * 24 * 3600 * 1000;
    const list = [...this.outcomes.values()].filter((o) => {
      if (new Date(o.at).getTime() < cutoff) return false;
      if (filter && !filter(o)) return false;
      return true;
    });
    const resolved = list.filter((o) => o.resolved && typeof o.qualityScore === "number");
    const avgQuality = resolved.length === 0 ? null : resolved.reduce((a, b) => a + b.qualityScore, 0) / resolved.length;
    const byKind = {};
    for (const o of list) byKind[o.kind] = (byKind[o.kind] || 0) + 1;
    return {
      windowDays,
      total: list.length,
      resolved: resolved.length,
      pending: list.length - resolved.length,
      avgQuality: avgQuality === null ? null : Number(avgQuality.toFixed(3)),
      byKind
    };
  }

  /**
   * Heuristic resolution sweep — inspects pending outcomes and tries to score them.
   * - agent-reply with a follow-up user message → score from follow-up tone
   * - sent-message with no reply within 6h → 0.4 (delivered, no engagement)
   * - cron-fire / autopilot-fire with tool calls → 0.7 productive; 'standing by' → 0.5 quiet
   * - anything pending > 24h with no signal → resolve null with source 'timeout'
   */
  resolveSweep({ now = new Date(), agentStore = null, timeoutHours = 24, replyWindowHours = 6 } = {}) {
    const resolutions = [];
    const tNow = now instanceof Date ? now.getTime() : new Date(now).getTime();
    for (const o of this.pending()) {
      const age = tNow - new Date(o.at).getTime();
      let score = null;
      let source = null;
      let note = null;

      if (o.kind === "agent-reply" && agentStore && o.sessionId) {
        const session = agentStore.getSession(o.sessionId);
        const idx = (session.messages ?? []).findIndex((m) => m.metadata?.outcomeId === o.id || m.id === o.refId);
        const followups = idx >= 0 ? session.messages.slice(idx + 1).filter((m) => m.role === "user") : [];
        if (followups.length > 0) {
          score = inferToneScore(followups[0].content);
          source = "user-followup";
          note = `tone of next user message`;
        }
      }

      if (score === null && (o.kind === "cron-fire" || o.kind === "autopilot-fire")) {
        if (Array.isArray(o.toolCalls) && o.toolCalls.length > 0) {
          score = 0.7;
          source = "system-inferred";
          note = `${o.toolCalls.length} tool call(s) executed`;
        } else if (age > 60 * 60 * 1000) {
          score = 0.5;
          source = "system-inferred";
          note = "cron fired, no tool actions";
        }
      }

      if (score === null && o.kind === "sent-message" && age > replyWindowHours * 3600 * 1000) {
        score = 0.4;
        source = "system-inferred";
        note = `no reply within ${replyWindowHours}h`;
      }

      if (score === null && age > timeoutHours * 3600 * 1000) {
        score = null;
        source = "timeout";
        note = `pending > ${timeoutHours}h`;
        // Mark resolved with null score so it stops blocking aggregations
        const outcome = this.outcomes.get(o.id);
        outcome.resolved = true;
        outcome.qualityScore = null;
        outcome.source = source;
        outcome.resolvedAt = nowIso();
        outcome.metadata = { ...outcome.metadata, resolutionNote: note };
        appendJsonLine(this.eventsPath, { op: "resolve", id: o.id, source, at: outcome.resolvedAt, note });
        resolutions.push({ id: o.id, score: null, source });
        continue;
      }

      if (score !== null && source) {
        this.resolve(o.id, score, source, note);
        resolutions.push({ id: o.id, score, source });
      }
    }
    if (resolutions.length > 0) this.persist();
    return resolutions;
  }

  /**
   * Explicit user feedback: rate a specific turn.
   */
  feedback(refId, qualityScore, note = null) {
    const outcomes = this.byRef(refId);
    if (outcomes.length === 0) return null;
    const target = outcomes[outcomes.length - 1]; // latest
    return this.resolve(target.id, qualityScore, "explicit-rating", note);
  }

  persist() {
    // Snapshot keeps all pending + last N resolved.
    const all = [...this.outcomes.values()];
    const pending = all.filter((o) => !o.resolved);
    const resolved = all.filter((o) => o.resolved).sort((a, b) => b.at.localeCompare(a.at)).slice(0, SNAPSHOT_LIMIT);
    writeJsonAtomic(this.snapshotPath, {
      version: 1,
      updatedAt: nowIso(),
      outcomes: [...pending, ...resolved]
    });
    // Drop old resolved from memory
    if (all.length > SNAPSHOT_LIMIT * 1.5) {
      this.outcomes = new Map([...pending, ...resolved].map((o) => [o.id, o]));
    }
  }
}

function clampScore(s) {
  if (s === null || s === undefined) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

const POSITIVE_HINTS = /\b(thanks|thank you|perfect|great|nice|awesome|good|love it|exactly|yes|yep|got it|works|cool)\b/i;
const NEGATIVE_HINTS = /\b(no|wrong|incorrect|bad|nope|stop|cancel|undo|broken|nope|bug|error|fail)\b/i;

function inferToneScore(text) {
  const t = String(text ?? "");
  const positive = POSITIVE_HINTS.test(t);
  const negative = NEGATIVE_HINTS.test(t);
  if (positive && !negative) return 0.85;
  if (negative && !positive) return 0.2;
  if (positive && negative) return 0.5;
  // Neutral follow-up = mild positive; user is continuing the conversation
  return 0.6;
}
