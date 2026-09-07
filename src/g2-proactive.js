import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { resolveDataDir } from "./data-dir.js";
import { readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { lifelogState, lifelogDispatch, pruneLifelog, moments, reviewLifelog } from "./conversation-lifelog.js";

const DAY = 86400_000;
const categories = ["approvals", "tasks", "discoveries", "email", "calendar"];
const defaults = () => ({ enabled: false, categories: [...categories], retentionDays: 1, quietStart: 22, quietEnd: 8, timeZone: "UTC", maxPerHour: 3 });
const hash = text => createHash("sha256").update(text).digest("hex");
const clean = (text, max = 400) => String(text ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, max);
function reject(message, status = 400) { throw Object.assign(new Error(message), { status }); }

// Main-owned, bounded snapshots. No raw audio, model invocation, or execution
// authority. Only explicit task acceptance crosses into the user task queue.
export class G2Proactive {
  constructor({ dir, runtime, now = Date.now } = {}) {
    this.file = path.join(dir ?? path.join(resolveDataDir(), "g2-proactive"), "state.json");
    this.runtime = runtime;
    this.now = now;
    this.reviewing = false; this.closed = false; this.reviewController = null;
    this.nodes = readJsonFile(this.file, { nodes: {} }).nodes;
    this.prune();
  }
  save() { writeJsonAtomic(this.file, { version: 1, nodes: this.nodes }); }
  node(nodeId) {
    const key = hash(nodeId);
    if (!this.nodes[key]) {
      if (Object.keys(this.nodes).length >= 64) reject("Too many proactive devices", 429);
      this.nodes[key] = { settings: defaults(), segments: [], candidates: [], marks: {}, batches: [], consent: null, lastBatchAt: 0 };
    }
    return this.nodes[key];
  }
  prune() {
    let changed = false;
    for (const n of Object.values(this.nodes)) {
      const before = n.segments.length;
      n.segments = n.segments.filter(s => s.at + n.settings.retentionDays * DAY > this.now());
      const ids = new Set(n.segments.map(s => s.id));
      const oldCandidates = n.candidates.length;
      n.candidates = n.candidates.filter(c => ids.has(c.segmentId));
      pruneLifelog(n);
      if (n.consent?.until <= this.now()) { n.consent = null; changed = true; }
      changed ||= before !== n.segments.length || oldCandidates !== n.candidates.length;
    }
    if (changed) this.save();
  }
  dispatch(nodeId, body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) reject("Expected an object");
    this.prune();
    const n = this.node(nodeId);
    if (body.op === "lifelog-task") {
      const s = n.segments.find(s => s.id === body.segmentId);
      if (!s || body.confirm !== true || typeof body.title !== "string" || !body.title.trim() || body.title.length > 180) reject("Confirm a task with current transcript evidence");
      const id = `life-task-${hash(s.id + body.title.trim().toLowerCase()).slice(0, 32)}`;
      const tasks = this.runtime?.tasks; if (!tasks?.add || !tasks?.list) reject("Task store unavailable", 503);
      const existing = tasks.list({ queue: "user", limit: 100000 }).find(t => t.sourceId === id);
      const task = existing || tasks.add({ title: clean(body.title, 180), bucket: "today", sourceId: id,
        sourceMeta: { kind: "lifelog-confirmed", segmentId: s.id }, description: "Confirmed by the owner from a lifelog conversation. Original transcript is subject to deletion and retention." }, { source: "lifelog-confirmed", queue: "user" });
      return { taskId: task.id };
    }
    if (body.op === "lifelog" || (typeof body.op === "string" && body.op.startsWith("lifelog-"))) {
      const result = lifelogDispatch(n, body, this.now());
      if (body.op === "lifelog-settings" || body.op === "lifelog-delete" || body.op === "lifelog-edit") this.reviewController?.abort();
      if (!["lifelog", "lifelog-export"].includes(body.op)) this.save();
      return result;
    }
    switch (body.op) {
      case "settings": return { settings: n.settings, consentActive: Boolean(n.consent) };
      case "configure": {
        const p = body.settings;
        if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).some(k => !Object.keys(defaults()).includes(k))) reject("Unsupported settings");
        const s = { ...n.settings, ...p };
        if (typeof s.enabled !== "boolean" || ![1, 7, 30].includes(s.retentionDays)
          || !Array.isArray(s.categories) || s.categories.length > 5 || s.categories.some(c => !categories.includes(c))
          || ![s.quietStart, s.quietEnd].every(h => Number.isInteger(h) && h >= 0 && h <= 23)
          || !Number.isInteger(s.maxPerHour) || s.maxPerHour < 0 || s.maxPerHour > 10
          || typeof s.timeZone !== "string" || s.timeZone.length > 80) reject("Invalid settings");
        try { new Intl.DateTimeFormat("en", { timeZone: s.timeZone }).format(); } catch { reject("Invalid time zone"); }
        n.settings = s; this.prune(); this.save(); return { settings: s };
      }
      case "consent": {
        if (typeof body.enabled !== "boolean" || (body.enabled && body.recordingConsent !== true)) reject("Explicit recording consent is required");
        if (!body.enabled && body.consentId && body.consentId !== n.consent?.id) return { consent: null };
        n.consent = body.enabled ? { id: randomUUID(), until: this.now() + 4 * 3600_000 } : null;
        this.save(); return { consent: n.consent };
      }
      case "transcripts": return { segments: [...n.segments].reverse(), candidates: n.candidates };
      case "delete-memory": {
        n.consent = null; n.segments = []; n.candidates = []; n.batches = [];
        delete n.lifelog; this.reviewController?.abort();
        this.save(); return { ok: true };
      }
      case "capture": return this.capture(n, body);
      case "feed": return { settings: n.settings, items: this.feed(n), quiet: this.quiet(n) };
      case "seen": case "dismiss": case "snooze": case "notify": case "can-notify": {
        const item = this.feed(n).find(i => i.id === body.id);
        if (!item) reject("Inbox item not available", 404);
        const mark = n.marks[item.id] ?? {};
        if (body.op === "notify" || body.op === "can-notify") {
          const hour = Math.floor(this.now() / 3600_000);
          if (!n.settings.enabled || this.quiet(n) || !item.important || mark.notified || (mark.seen && body.op === "can-notify")
            || (n.hour === hour && n.notifications >= n.settings.maxPerHour) || n.settings.maxPerHour === 0) return { notify: false };
          if (body.op === "can-notify") return { notify: true };
          n.notifications = n.hour === hour ? n.notifications + 1 : 1; n.hour = hour; mark.notified = true;
        } else if (body.op === "seen") mark.seen = true;
        else if (body.op === "dismiss") mark.dismissed = true;
        else mark.snoozedUntil = this.now() + 3600_000;
        n.marks[item.id] = mark;
        // Bound dedup metadata; source feed itself excludes resolved/old items.
        const keys = Object.keys(n.marks); for (const key of keys.slice(0, Math.max(0, keys.length - 1000))) delete n.marks[key];
        this.save(); return { ok: true, notify: body.op === "notify" };
      }
      case "accept-task": {
        if (body.confirm !== true) reject("Confirm this suggested task first");
        const c = n.candidates.find(c => c.id === body.id);
        if (!c) reject("Suggestion expired or deleted", 404);
        const tasks = this.runtime?.tasks;
        if (!tasks?.add || !tasks?.list) reject("User task store unavailable", 503);
        // Recover if task persistence succeeded before our acknowledgement.
        const existing = tasks.list({ queue: "user", limit: 100000 }).find(t => t.sourceId === c.id);
        if (existing) { c.taskId = existing.id; this.save(); return { taskId: existing.id }; }
        if (c.taskId) return { taskId: c.taskId };
        const task = tasks.add({ title: c.title, bucket: "today", sourceId: c.id,
          sourceMeta: { kind: "g2-confirmed-suggestion", speakerVerified: false },
          description: "Explicitly accepted from G2 conversation memory. Speaker identity and due date were not inferred." }, { source: "g2-confirmed", queue: "user" });
        c.taskId = task.id; this.save(); return { taskId: task.id };
      }
      default: reject("Unsupported proactive operation");
    }
  }
  capture(n, body) {
    if (!n.consent || n.consent.id !== body.consentId || n.consent.until <= this.now()) reject("Conversation memory consent is off or expired", 403);
    if (typeof body.batchId !== "string" || !/^[a-zA-Z0-9-]{16,80}$/.test(body.batchId)
      || !Array.isArray(body.texts) || !body.texts.length || body.texts.length > 10
      || body.texts.some(t => typeof t !== "string" || !t.trim() || t.length > 1000)) reject("Invalid transcript batch");
    if (n.batches.includes(body.batchId)) return { saved: 0, duplicate: true };
    if (n.lastBatchAt && this.now() - n.lastBatchAt < 15000) reject("Transcript batches are limited to one per 15 seconds", 429);
    if (n.segments.length + body.texts.length > 20000) reject("Memory full; export or delete older conversations before continuing", 429);
    if (body.segments !== undefined && (!Array.isArray(body.segments) || body.segments.length !== body.texts.length
      || body.segments.some(s => !s || typeof s !== "object" || !Number.isFinite(s.at) || !Number.isFinite(s.endAt)
        || s.endAt < s.at || s.endAt - s.at > 120000 || s.at < this.now() - 300000 || s.endAt > this.now() + 30000
        || typeof s.streamId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(s.streamId)
        || (s.speaker !== null && s.speaker !== undefined && (!Number.isInteger(s.speaker) || s.speaker < 0 || s.speaker > 99))))) reject("Invalid timed transcript segments");
    for (const [index, text] of body.texts.entries()) {
      const meta = body.segments?.[index];
      const segment = { id: randomUUID(), text: clean(text, 1000), at: meta?.at ?? this.now(), endAt: meta?.endAt ?? this.now(),
        captureSession: `${body.consentId}:${meta?.streamId || "buffered"}`, source: "g2",
        speakerKey: meta?.speaker == null ? null : `${body.consentId}:${meta.streamId}:${meta.speaker}`, speakerVerified: false };
      n.segments.push(segment);
      // Evidence, never instructions: conservative first-pass extraction has
      // zero tool access. No claim that the speaker is the owner.
      const match = segment.text.match(/\b(?:I(?:['’]ll| will| need to)|we need to|remember to)\s+([^.!?]{5,180})/i);
      if (!match || n.candidates.length >= 50) continue;
      const title = clean(match[1], 180);
      const id = `g2-task-${hash(`${body.consentId}:${title.toLowerCase()}`).slice(0, 32)}`;
      if (!n.candidates.some(c => c.id === id)) n.candidates.push({ id, segmentId: segment.id, title, evidence: segment.text, at: segment.at, taskId: null });
    }
    n.batches = [...n.batches, body.batchId].slice(-200); n.lastBatchAt = this.now(); this.save();
    return { saved: body.texts.length };
  }
  async reviewPending() {
    if (this.closed || this.reviewing) return;
    this.reviewing = true; this.reviewController = new AbortController();
    const signal = this.reviewController.signal;
    try {
      this.prune();
      for (const n of Object.values(this.nodes)) {
        const before = lifelogState(n).lastAttempt;
        await reviewLifelog(n, { provider: this.runtime?.agentHost?.modelProvider, now: this.now(),
          signal, alive: () => !this.closed && !signal.aborted, save: () => this.save() });
        if (lifelogState(n).lastAttempt !== before || signal.aborted) break;
      }
    } finally {
      let changed = false;
      for (const n of Object.values(this.nodes)) if (n.lifelog?.status === "Reviewing a settled conversation") {
        n.lifelog.status = n.lifelog.settings.analysis ? "Review interrupted; waiting for next sweep" : "Analysis off"; changed = true;
      }
      if (changed) this.save();
      this.reviewing = false; this.reviewController = null;
    }
  }
  close() { this.closed = true; this.reviewController?.abort(); }
  async screenContext(nodeId, id) {
    const n = this.node(nodeId); this.prune();
    if (!lifelogState(n).settings.screenContext) reject("Enable screen context first", 403);
    const state = n.lifelog, generation = state.generation;
    const m = moments(n).find(m => m.id === id); if (!m) reject("Moment expired", 404);
    const rows = await this.runtime?.observations?.searchTextWindow?.({ since: new Date(m.at - 60000).toISOString(), until: new Date(m.endAt + 60000).toISOString(), limit: 10 }) || [];
    this.prune();
    if (n.lifelog !== state || state.generation !== generation || !state.settings.screenContext || !moments(n).some(item => item.id === id)) reject("Screen context consent or moment changed", 403);
    return { items: rows.map(r => ({ at: r.at, app: r.app, text: clean(r.text, 500) })), relation: "nearby-in-time-only" };
  }
  quiet(n) {
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: n.settings.timeZone, hour: "2-digit", hourCycle: "h23" }).format(this.now()));
    const { quietStart: start, quietEnd: end } = n.settings;
    return start === end ? false : start < end ? hour >= start && hour < end : hour >= start || hour < end;
  }
  feed(n) {
    const selected = new Set(n.settings.categories);
    const items = [];
    if (n.settings.enabled) {
      for (const i of (this.runtime?.outreach?.list?.() ?? []).slice(0, 200)) {
        if (!["unseen", "seen"].includes(i.status) || Date.parse(i.createdAt) < this.now() - 7 * DAY) continue;
        const kind = i.sourceRef?.kind === "draft"
          ? this.runtime?.drafts?.get?.(i.sourceRef.id)?.kind ?? "draft"
          : i.sourceRef?.kind;
        const coding = kind === "coding-watch";
        const supervisor = this.runtime?.codingSupervisor;
        if (coding && (!supervisor?.configured || !supervisor.state.watches?.[i.sourceRef.id]
          || i.sourceRef.nodeId !== (supervisor.remoteNodeId || "local"))) continue;
        const category = /email|mail/.test(kind) ? "email" : /calendar/.test(kind) ? "calendar"
          : i.needsDecision ? "approvals" : /task/.test(kind) ? "tasks" : "discoveries";
        if (selected.has(category)) items.push({ id: i.id, title: clean(i.title, 160), summary: clean(i.summary, coding ? 1000 : 400), category,
          important: i.needsDecision === true || coding, at: Date.parse(i.createdAt) || this.now(), action: "review-on-main",
          ...(coding ? { codingTarget: { provider: i.sourceRef.provider, sessionId: i.sourceRef.sessionId } } : {}) });
      }
      if (selected.has("tasks")) for (const t of this.runtime?.tasks?.list?.({ queue: "user", limit: Infinity }) ?? []) {
        const due = Date.parse(t.dueDate);
        if (!["pending", "in_progress", "blocked"].includes(t.status) || !Number.isFinite(due) || due > this.now() + 3600_000 || due < this.now() - 7 * DAY) continue;
        items.push({ id: `due:${t.id}:${t.dueDate}`, title: clean(t.title, 160), summary: `Due ${t.dueDate}`, category: "tasks", important: true, at: due, action: "review-on-main" });
      }
    }
    for (const c of n.candidates) if (!c.taskId) items.push({ id: c.id, title: `Possible task: ${c.title}`, summary: c.evidence, category: "memory", important: n.settings.enabled && selected.has("discoveries"), at: c.at, action: "accept-task", speakerVerified: false });
    if (n.settings.enabled && selected.has("discoveries")) {
      const l = lifelogState(n);
      for (const m of moments(n)) if (m.review?.claims.length) items.push({ id: `moment-${m.id}-${m.review.fingerprint}`,
        title: m.title, summary: m.review.summary, category: "discoveries", important: true, at: m.endAt, action: "review-lifelog", momentId: m.id });
      for (const f of Object.values(l.followups)) if (f.status === "confirmed" && f.dueAt !== null && f.dueAt <= this.now() + 3600000)
        items.push({ id: `${f.id}-${f.updatedAt}`, title: `Follow up: ${f.title}`, summary: "You confirmed this follow-up. Review the original conversation before acting.",
          category: "discoveries", important: true, at: f.dueAt, action: "review-lifelog" });
    }
    return items.filter(i => !n.marks[i.id]?.dismissed && !(n.marks[i.id]?.snoozedUntil > this.now()))
      .map(i => ({ ...i, seen: n.marks[i.id]?.seen === true, notified: n.marks[i.id]?.notified === true })).sort((a, b) => Number(b.important) - Number(a.important) || b.at - a.at).slice(0, 80);
  }
}
