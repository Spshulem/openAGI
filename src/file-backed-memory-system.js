import path from "node:path";
import { appendJsonLine, ensureDir, readJsonFile, writeJsonAtomic, writeTextAtomic } from "./file-utils.js";
import { MemorySystem } from "./memory-system.js";
import { nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

export class FileBackedMemorySystem extends MemorySystem {
  constructor(options = {}) {
    super(options);
    this.dir = options.dir ?? path.join(resolveDataDir(), "memory");
    this.snapshotPath = options.snapshotPath ?? path.join(this.dir, "memory-state.json");
    this.eventsPath = options.eventsPath ?? path.join(this.dir, "memory-events.jsonl");
    this.duplicateArchivePath = options.duplicateArchivePath ?? path.join(this.dir, "duplicate-archive.jsonl");
    ensureDir(this.dir);
    if (options.autoLoad !== false) this.load();
  }

  load() {
    const snapshot = readJsonFile(this.snapshotPath, { version: 1, items: [] });
    this.items = new Map();
    for (const item of snapshot.items ?? []) {
      if (!item.id || !item.tier) continue;
      this.items.set(item.id, item);
    }
    return this.snapshot();
  }

  remember(observation, context = {}) {
    const item = super.remember(observation, context);
    this.persist("remember", { item });
    return item;
  }

  reinforce(id, amount = 0.1) {
    const item = super.reinforce(id, amount);
    if (item) this.persist("reinforce", { id, amount, item });
    return item;
  }

  correct(input) {
    // super.correct() routes the new locked item through this.remember()
    // (already persisted); this extra event captures the supersede mutations
    // on the stale items and snapshots them.
    const result = super.correct(input);
    this.persist("correct", {
      correctedId: result.item.id,
      superseded: result.superseded.map((item) => item.id)
    });
    return result;
  }

  decay(now = new Date()) {
    const result = super.decay(now);
    if (result.removed.length > 0 || result.promoted.length > 0 || result.decayed.length > 0 || result.initialized.length > 0) {
      this.persist("decay", {
        removed: result.removed.map((item) => item.id),
        promoted: result.promoted.map((item) => item.id),
        decayed: result.decayed.map((item) => item.id),
        initialized: result.initialized.map((item) => item.id),
        repaired: result.repaired.map((item) => item.id)
      });
    }
    return result;
  }

  consolidateAutomatedDuplicates(options = {}) {
    const result = super.consolidateAutomatedDuplicates({
      ...options,
      // Archive the complete duplicate row before removing it from active
      // recall. If this append fails, MemorySystem leaves the row untouched.
      archive: (entry) => appendJsonLine(this.duplicateArchivePath, {
        version: 1,
        op: "consolidate-exact-duplicate",
        ...entry
      })
    });
    if (result.removed.length > 0) {
      this.persist("consolidate-duplicates", {
        removed: result.removed.map((item) => item.id),
        retained: result.retained.map((item) => item.id),
        archivePath: path.basename(this.duplicateArchivePath)
      });
    }
    return result;
  }

  compactEventLog() {
    writeTextAtomic(this.eventsPath, `${JSON.stringify({
      version: 1,
      compactedAt: nowIso(),
      items: [...this.items.values()]
    })}\n`);
  }

  persist(op, payload) {
    const event = {
      version: 1,
      op,
      at: nowIso(),
      payload
    };
    appendJsonLine(this.eventsPath, event);
    this.saveSnapshot();
  }

  saveSnapshot() {
    writeJsonAtomic(this.snapshotPath, {
      version: 1,
      updatedAt: nowIso(),
      items: [...this.items.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    });
  }
}
