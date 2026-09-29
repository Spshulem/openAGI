// src/outreach-store.js
import path from "node:path";
import { ensureDir, writeJsonAtomic, readJsonFile } from "./file-utils.js";
import { createId, nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

// Durable, cursor-indexed log of outreach items. Every item gets a monotonic
// `seq` so a consumer can ask "everything after seq N" and never miss one.
// A reopened or reworded item takes a new seq, so it is read again.
//   status: "unseen" | "seen" | "acted" | "dismissed" | "error"

export class OutreachStore {
  constructor({ dir, runtime } = {}) {
    this.dir = dir ?? path.join(resolveDataDir(), "outreach");
    this.runtime = runtime ?? null;
    ensureDir(this.dir);
    this.items = new Map();
    this.nextSeq = 1;
    this._load();
  }

  bindRuntime(runtime) { this.runtime = runtime; }

  append({ type, sourceRef = null, title, summary = "", needsDecision = false, actions = [], dedupeOpen = false, outcomeId = null }) {
    if (dedupeOpen && sourceRef?.id) {
      const existing = [...this.items.values()].find((i) =>
        (i.status === "unseen" || i.status === "seen") &&
        i.sourceRef?.kind === sourceRef.kind &&
        i.sourceRef?.id === sourceRef.id
      );
      if (existing) return existing;
    }
    const item = {
      id: createId("out"),
      seq: this.nextSeq++,
      type,
      sourceRef,
      outcomeId: outcomeId ?? null,
      title: String(title ?? "").trim() || "(untitled)",
      summary: String(summary ?? ""),
      needsDecision: Boolean(needsDecision),
      actions: Array.isArray(actions) ? actions : [],
      status: "unseen",
      decision: null,
      error: null,
      createdAt: nowIso(),
      resolvedAt: null
    };
    this.items.set(item.id, item);
    this.snapshot();
    this.runtime?.events?.emit?.("outreach", item);
    return item;
  }

  get(id) { return this.items.get(id) ?? null; }

  since(cursor = 0) {
    const c = Number(cursor) || 0;
    return [...this.items.values()].filter((i) => i.seq > c).sort((a, b) => a.seq - b.seq);
  }

  list({ status } = {}) {
    const all = [...this.items.values()].sort((a, b) => b.seq - a.seq);
    return status ? all.filter((i) => i.status === status) : all;
  }

  markSeen(ids = []) {
    let changed = false;
    for (const id of ids) {
      const i = this.items.get(id);
      if (i && i.status === "unseen") { i.status = "seen"; changed = true; }
    }
    if (changed) this.snapshot();
  }

  markNudged(ids = [], { now = new Date() } = {}) {
    let changed = false;
    for (const id of ids) {
      const i = this.items.get(id);
      if (i) { i.lastNudgedAt = now.toISOString(); changed = true; }
    }
    if (changed) this.snapshot();
  }

  resolve(id, decision, { status = "acted", error = null } = {}) {
    const i = this.items.get(id);
    if (!i) return null;
    if (i.status === "acted" || i.status === "dismissed") return i;
    i.status = status;
    i.decision = decision ?? null;
    i.error = error;
    i.resolvedAt = nowIso();
    this.snapshot();
    this.runtime?.events?.emit?.("outreach-resolved", i);
    return i;
  }

  // An item its source closed on its own (decision "resolved") comes back
  // when that source reopens. Same id, so G2 (marks keyed by id) does not
  // ping for it again. A new seq and an "outreach" event let the Mac overlay,
  // which dropped it on outreach-resolved and reads past its cursor, add it back.
  reopen(id) {
    const i = this.items.get(id);
    if (!i || i.status !== "dismissed" || i.decision !== "resolved") return null;
    i.status = "seen";
    i.decision = null;
    i.resolvedAt = null;
    i.seq = this.nextSeq++;
    i.refreshedAt = nowIso();
    this.snapshot();
    this.runtime?.events?.emit?.("outreach", i);
    return i;
  }

  // A source that rewords an open item ("4 stuck" -> "5 stuck") updates its
  // text in place: same id and status, so G2 does not ping again. A new seq
  // and an "outreach-updated" event carry the new text to the Mac overlay.
  // Only the fields passed are touched. Every call also marks the item as
  // still current (refreshedAt), saved with the next write.
  update(id, patch = {}) {
    const i = this.items.get(id);
    if (!i || (i.status !== "unseen" && i.status !== "seen")) return null;
    i.refreshedAt = nowIso();
    const next = {};
    if ("title" in patch) next.title = String(patch.title ?? "").trim() || "(untitled)";
    if ("summary" in patch) next.summary = String(patch.summary ?? "");
    if ("actions" in patch) next.actions = Array.isArray(patch.actions) ? patch.actions : [];
    const changed = Object.keys(next).filter((key) => JSON.stringify(i[key]) !== JSON.stringify(next[key]));
    if (!changed.length) return i;
    for (const key of changed) i[key] = next[key];
    i.seq = this.nextSeq++;
    this.snapshot();
    this.runtime?.events?.emit?.("outreach-updated", i);
    return i;
  }

  snapshot() {
    writeJsonAtomic(path.join(this.dir, "snapshot.json"), {
      version: 1,
      writtenAt: nowIso(),
      nextSeq: this.nextSeq,
      items: [...this.items.values()]
    });
  }

  _load() {
    const snap = readJsonFile(path.join(this.dir, "snapshot.json"), null);
    if (!snap) return;
    for (const i of snap.items ?? []) this.items.set(i.id, i);
    this.nextSeq = snap.nextSeq ?? (this.items.size ? Math.max(...[...this.items.values()].map((i) => i.seq)) + 1 : 1);
  }
}
