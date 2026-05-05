import { createHash, randomUUID } from "node:crypto";

export function nowIso() {
  return new Date().toISOString();
}

export function createId(prefix = "evt") {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
}

export function tokenize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function tokenOverlapScore(query, target) {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return 0;

  const targetTokens = new Set(tokenize(target));
  let hits = 0;
  for (const token of queryTokens) {
    if (targetTokens.has(token)) hits += 1;
  }

  return hits / queryTokens.size;
}

export function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function summarizeText(value, maxChars = 420) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trim()}...`;
}
