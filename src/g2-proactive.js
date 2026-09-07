import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { resolveDataDir } from "./data-dir.js";
import { readJsonFile, writeJsonAtomic } from "./file-utils.js";

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
      if (n.consent?.until <= this.now()) { n.consent = null; changed = true; }
      changed ||= before !== n.segments.length || oldCandidates !== n.candidates.length;
    }
    if (changed) this.save();
  }
  dispatch(nodeId, body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) reject("Expected an object");
    this.prune();
    const n = this.node(nodeId);
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
        this.save(); return { ok: true };
      }
      case "capture": return this.capture(n, body);
      case "feed": return { settings: n.settings, items: this.feed(n), quiet: this.quiet(n) };
      case "seen": case "dismiss": case "snooze": case "notify": {
        const item = this.feed(n).find(i => i.id === body.id);
        if (!item) reject("Inbox item not available", 404);
        const mark = n.marks[item.id] ?? {};
        if (body.op === "notify") {
          const hour = Math.floor(this.now() / 3600_000);
          if (!n.settings.enabled || this.quiet(n) || !item.important || mark.notified || mark.seen
            || (n.hour === hour && n.notifications >= n.settings.maxPerHour) || n.settings.maxPerHour === 0) return { notify: false };
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
    if (n.segments.length + body.texts.length > 200) reject("Memory full; delete stored transcripts before continuing", 429);
    for (const text of body.texts) {
      const segment = { id: randomUUID(), text: clean(text, 1000), at: this.now(), speakerVerified: false };
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
        const kind = i.sourceRef?.kind;
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
      if (selected.has("tasks")) for (const t of this.runtime?.tasks?.list?.({ queue: "user", limit: 100 }) ?? []) {
        const due = Date.parse(t.dueDate);
        if (!["pending", "in_progress", "blocked"].includes(t.status) || !Number.isFinite(due) || due > this.now() + 3600_000 || due < this.now() - 7 * DAY) continue;
        items.push({ id: `due:${t.id}:${t.dueDate}`, title: clean(t.title, 160), summary: `Due ${t.dueDate}`, category: "tasks", important: true, at: due, action: "review-on-main" });
      }
    }
    for (const c of n.candidates) if (!c.taskId) items.push({ id: c.id, title: `Possible task: ${c.title}`, summary: c.evidence, category: "memory", important: false, at: c.at, action: "accept-task", speakerVerified: false });
    return items.filter(i => !n.marks[i.id]?.dismissed && !(n.marks[i.id]?.snoozedUntil > this.now()))
      .map(i => ({ ...i, seen: n.marks[i.id]?.seen === true, notified: n.marks[i.id]?.notified === true })).sort((a, b) => Number(b.important) - Number(a.important) || b.at - a.at).slice(0, 80);
  }
}
