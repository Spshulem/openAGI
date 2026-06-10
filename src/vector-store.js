import path from "node:path";
import { ensureDir, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { cosine } from "./embeddings.js";
import { nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

// Namespaced cosine vector store. File-backed for persistence across restarts.
// Namespaces: "principle" (distilled long-term memory), "specialist" (bounded
// scope text), "memory" (raw items if you opt in).

export class VectorStore {
  constructor(options = {}) {
    this.embedder = options.embedder;
    this.dir = options.dir ?? path.join(resolveDataDir(), "vectors");
    this.path = options.path ?? path.join(this.dir, "store.json");
    ensureDir(this.dir);
    const snap = readJsonFile(this.path, { version: 1, entries: [] });
    this.entries = new Map();
    for (const e of snap.entries ?? []) this.entries.set(this.key(e.namespace, e.id), e);
    this.dim = options.dim ?? this.embedder?.dim ?? 256;
  }

  key(namespace, id) {
    return `${namespace}:${id}`;
  }

  async upsert(namespace, id, text, payload = {}) {
    if (!this.embedder) return null;
    let embedding;
    try {
      embedding = await this.embedder.embed(text);
    } catch (error) {
      // Best-effort — skip on failure rather than blocking the underlying op.
      return { error: error.message };
    }
    const entry = { namespace, id, text: String(text).slice(0, 600), embedding, payload, at: nowIso() };
    this.entries.set(this.key(namespace, id), entry);
    this.persist();
    return entry;
  }

  delete(namespace, id) {
    const key = this.key(namespace, id);
    const had = this.entries.delete(key);
    if (had) this.persist();
    return had;
  }

  async search(namespace, queryText, { limit = 5, minScore = 0.05 } = {}) {
    if (!this.embedder) return [];
    let q;
    try {
      q = await this.embedder.embed(queryText);
    } catch {
      return [];
    }
    const out = [];
    for (const entry of this.entries.values()) {
      if (entry.namespace !== namespace) continue;
      const score = cosine(q, entry.embedding);
      if (score < minScore) continue;
      out.push({ id: entry.id, score, text: entry.text, payload: entry.payload });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  list(namespace) {
    return [...this.entries.values()].filter((e) => e.namespace === namespace).map(({ embedding, ...rest }) => rest);
  }

  persist() {
    writeJsonAtomic(this.path, {
      version: 1,
      updatedAt: nowIso(),
      entries: [...this.entries.values()]
    });
  }
}
