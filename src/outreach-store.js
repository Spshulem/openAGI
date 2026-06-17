// src/outreach-store.js
import path from "node:path";
import { ensureDir, writeJsonAtomic, readJsonFile } from "./file-utils.js";
import { createId, nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

// Durable, cursor-indexed log of outreach items. Every item gets a monotonic
// `seq` so a consumer can ask "everything after seq N" and never miss one.
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

  append({ type, sourceRef = null, title, summary = "", needsDecision = false, actions = [] }) {
    const item = {
      id: createId("out"),
      seq: this.nextSeq++,
      type,
      sourceRef,
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
