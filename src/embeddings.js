import { tokenize } from "./utils.js";
import { validateOpenAIKey } from "./provider-credentials.js";

// Pluggable embedding interface. Default is a deterministic hash-bag-of-words
// embedder so the runtime works fully offline / open-source. When OPENAI_API_KEY
// is set, OpenAIEmbedder runs against text-embedding-3-small unless explicitly
// disabled with OPENAGI_EMBEDDER=hash.

const HASH_DIM = 256;

export class HashBagEmbedder {
  constructor(options = {}) {
    this.dim = options.dim ?? HASH_DIM;
    this.name = "hash-bag";
  }

  isConfigured() {
    return true;
  }

  async embed(text) {
    const v = new Array(this.dim).fill(0);
    const tokens = tokenize(text);
    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i];
      if (t.length < 2) continue;
      // Whole word
      v[hash32(t) & (this.dim - 1)] += 1;
      // Word bigram for phrase signal
      if (i > 0) {
        const bi = `${tokens[i - 1]}_${t}`;
        v[hash32(bi) & (this.dim - 1)] += 0.5;
      }
      // Character trigrams catch morphological variants ("standup" ~ "standups").
      for (let k = 0; k <= t.length - 3; k += 1) {
        const tri = t.slice(k, k + 3);
        v[hash32(`__${tri}`) & (this.dim - 1)] += 0.3;
      }
    }
    return normalize(v);
  }

  async embedMany(texts) {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

export class OpenAIEmbedder {
  constructor(options = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.model = options.model ?? process.env.OPENAGI_EMBED_MODEL ?? "text-embedding-3-small";
    this.baseUrl = options.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    this.dim = options.dim ?? 1536;
    this.budgetGuard = options.budgetGuard ?? null;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.name = "openai";
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async embed(text) {
    const [vec] = await this.embedMany([text]);
    return vec;
  }

  async embedMany(texts) {
    if (!this.apiKey) throw new Error("OpenAI embedder requires OPENAI_API_KEY.");
    validateOpenAIKey(this.apiKey, this.baseUrl);
    this.budgetGuard?.check();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({ model: this.model, input: texts })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error?.message ?? `OpenAI embeddings failed with ${res.status}`);
      // Approximate budget cost via input tokens (output_tokens unused for embeddings).
      this.budgetGuard?.record({ input_tokens: json.usage?.prompt_tokens ?? 0, output_tokens: 0 }, this.model);
      return json.data.map((d) => d.embedding);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createEmbedder(options = {}) {
  if (process.env.OPENAGI_EMBEDDER === "hash") return new HashBagEmbedder();
  const oai = new OpenAIEmbedder(options);
  if (oai.isConfigured() && options.forceHash !== true) return oai;
  return new HashBagEmbedder();
}

export function cosine(a, b) {
  if (!a || !b) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n === 0) return v;
  return v.map((x) => x / n);
}

function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
