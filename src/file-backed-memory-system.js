import path from "node:path";
import { appendJsonLine, ensureDir, readJsonFile, writeJsonAtomic, writeTextAtomic } from "./file-utils.js";
import { MemorySystem } from "./memory-system.js";
import { nowIso } from "./utils.js";

export class FileBackedMemorySystem extends MemorySystem {
  constructor(options = {}) {
    super(options);
    this.dir = options.dir ?? path.join(process.cwd(), ".openagi", "memory");
    this.snapshotPath = options.snapshotPath ?? path.join(this.dir, "memory-state.json");
    this.eventsPath = options.eventsPath ?? path.join(this.dir, "memory-events.jsonl");
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

  decay(now = new Date()) {
    const result = super.decay(now);
    if (result.removed.length > 0 || result.promoted.length > 0) {
      this.persist("decay", {
        removed: result.removed.map((item) => item.id),
        promoted: result.promoted.map((item) => item.id)
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
