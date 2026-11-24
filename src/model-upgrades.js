// Daily "is there a newer model?" check.
//
// Reads the models the owner's own keys can reach (OpenAI / Anthropic
// GET /v1/models — free, read-only), compares them with the configured model
// keys, and SUGGESTS:
//   • upgrade     — a newer version of the same line/variant is available
//                   (gpt-6.1-sol → gpt-6.2-sol, claude-sonnet-4-6 → -4-7)
//   • unavailable — the configured model is not in the key's list at all, so
//                   calls to it will fail
// It never edits config. Each suggestion reaches the owner once (outreach),
// and the latest result is cached for the model settings screen.

import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic, readJsonFile } from "./file-utils.js";
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_OPENAI_SMALL_MODEL } from "./model-router.js";

const CACHE_FILE = "model-upgrades.json";

// Specialty / non-chat builds: never suggested, never the basis of a match.
const SPECIALTY = /-(healthcare|pro|codex\b|codex-|realtime|audio|search|transcribe|tts|image|chat-latest|preview|instruct|embedding|moderation|deep-research|computer-use|oss)/;
const SNAPSHOT = /-(\d{4}-\d{2}-\d{2}|\d{8})$/;

// "gpt-6.1-sol" → { line: "gpt", version: [6, 1], variant: "sol" }
// "claude-sonnet-4-6" → { line: "claude", version: [4, 6], variant: "sonnet" }
// Returns null for ids this check does not reason about.
// `raw` keeps the caller's exact spelling (e.g. a provider-prefixed
// "openai/gpt-6.2-sol"); everything else is normalized for comparison only.
export function parseModelId(input) {
  const raw = String(input ?? "").trim();
  const id = raw.toLowerCase().replace(/^(openai|anthropic)\//, "");
  if (!id || SPECIALTY.test(id)) return null;
  const base = id.replace(SNAPSHOT, "");
  let m = base.match(/^gpt-(\d+)(?:\.(\d+))?(?:-([a-z]+))?$/);
  if (m) return { raw, id, base, line: "gpt", version: [Number(m[1]), Number(m[2] ?? 0)], variant: m[3] ?? "", snapshot: base !== id };
  m = base.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/);
  if (m) return { raw, id, base, line: "claude", version: [Number(m[2]), Number(m[3] ?? 0)], variant: m[1], snapshot: base !== id };
  return null;
}

const newer = (a, b) => a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1];

// gpt-5-era ids have no named variant ("gpt-5", "gpt-5.4-mini"); the gpt-6
// line names them (sol = balanced flagship, luna = small). Map across so an
// install still on a size-ladder id hears about its successor.
function variantsFor(variant) {
  if (variant === "") return ["", "sol"];
  if (variant === "mini" || variant === "nano") return [variant, "luna"];
  return [variant];
}

// The newest available model that is the same line and variant as `current`
// and strictly newer. Undated aliases win over dated snapshots of the same
// version. Returns the catalog's own id, so the suggestion is a value that
// endpoint actually serves.
export function newestSuccessor(current, availableIds = []) {
  const cur = parseModelId(current);
  if (!cur) return null;
  const variants = variantsFor(cur.variant);
  let best = null;
  for (const raw of availableIds) {
    const cand = parseModelId(raw);
    if (!cand || cand.line !== cur.line || !variants.includes(cand.variant)) continue;
    if (!newer(cand.version, cur.version)) continue;
    if (!best || newer(cand.version, best.version)
      || (cand.version.join(".") === best.version.join(".") && best.snapshot && !cand.snapshot)) best = cand;
  }
  return best?.raw ?? null;
}

// Which env keys hold a model, and which provider's catalog they are checked
// against. Unset keys fall back to the code default (what actually runs).
export function configuredModels(env = process.env) {
  const out = [];
  const add = (provider, key, fallback = null) => {
    const value = String(env[key] ?? "").trim() || fallback;
    if (value) out.push({ provider, key, model: value, explicit: Boolean(String(env[key] ?? "").trim()) });
  };
  if (env.OPENAI_API_KEY) {
    add("openai", "OPENAI_MODEL", DEFAULT_OPENAI_MODEL);
    add("openai", "OPENAI_MODEL_MINI");
    add("openai", "OPENAI_MODEL_NANO");
    for (const key of Object.keys(env).filter((k) => k.startsWith("OPENAI_MODEL_TASK_")).sort()) add("openai", key);
  }
  if (env.ANTHROPIC_API_KEY) {
    add("anthropic", "ANTHROPIC_MODEL", DEFAULT_ANTHROPIC_MODEL);
    add("anthropic", "ANTHROPIC_MODEL_MINI");
    add("anthropic", "ANTHROPIC_MODEL_NANO");
    for (const key of Object.keys(env).filter((k) => k.startsWith("ANTHROPIC_MODEL_TASK_")).sort()) add("anthropic", key);
  }
  return out;
}

export function suggestModelUpgrades({ configured = [], available = {} } = {}) {
  const suggestions = [];
  for (const entry of configured) {
    const ids = available[entry.provider];
    if (!Array.isArray(ids) || ids.length === 0) continue; // catalog not read: say nothing
    const lower = new Set(ids.map((i) => String(i).toLowerCase()));
    const successor = newestSuccessor(entry.model, ids);
    if (successor) {
      suggestions.push({ kind: "upgrade", ...entry, suggested: successor });
    } else if (!lower.has(entry.model.toLowerCase())) {
      const fallback = entry.provider === "openai"
        ? (/(mini|nano|luna)/.test(entry.key + entry.model) ? DEFAULT_OPENAI_SMALL_MODEL : DEFAULT_OPENAI_MODEL)
        : null;
      const served = fallback ? ids.find((i) => parseModelId(i)?.id === fallback) ?? null : null;
      suggestions.push({ kind: "unavailable", ...entry, suggested: served });
    }
  }
  return suggestions;
}

const CATALOGS = {
  openai: { keyEnv: "OPENAI_API_KEY", url: (env) => `${String(env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "")}/models`,
    headers: (key) => ({ authorization: `Bearer ${key}` }) },
  anthropic: { keyEnv: "ANTHROPIC_API_KEY", url: (env) => `${String(env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1").replace(/\/+$/, "")}/models?limit=1000`,
    headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }) }
};

export async function fetchAvailableModels(provider, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const spec = CATALOGS[provider];
  const key = env[spec.keyEnv];
  if (!key) return { ok: false, error: "not configured" };
  try {
    const response = await fetchImpl(spec.url(env), { method: "GET", headers: { accept: "application/json", ...spec.headers(key) }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const json = await response.json();
    const ids = (Array.isArray(json?.data) ? json.data : []).map((m) => m?.id).filter((id) => typeof id === "string");
    return ids.length ? { ok: true, ids } : { ok: false, error: "empty model list" };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 160) };
  }
}

export function readModelUpgradeCache(dataDir) {
  return readJsonFile(path.join(dataDir, CACHE_FILE), null);
}

function describe(s) {
  if (s.kind === "upgrade") {
    return {
      title: `Newer model available: ${s.suggested}`,
      summary: `${s.key} is ${s.model}${s.explicit ? "" : " (default)"}; your ${s.provider === "openai" ? "OpenAI" : "Anthropic"} key can use ${s.suggested}. Set ${s.key}=${s.suggested} (Settings → Models) to upgrade. Nothing changes until you do.`
    };
  }
  return {
    title: `Configured model not available: ${s.model}`,
    summary: `${s.key}=${s.model} is not in the models your ${s.provider === "openai" ? "OpenAI" : "Anthropic"} key can use, so calls to it fail.${s.suggested ? ` Set ${s.key}=${s.suggested} to fix.` : ""}`
  };
}

// Run the check: read catalogs, compute suggestions, cache them, and tell the
// owner about each NEW one once (remembered across runs, even after dismiss).
export async function checkModelUpgrades({ env = process.env, dataDir, fetchImpl = globalThis.fetch, outreach = null, now = new Date() } = {}) {
  const configured = configuredModels(env);
  const providers = [...new Set(configured.map((c) => c.provider))];
  const available = {};
  const errors = {};
  for (const provider of providers) {
    const result = await fetchAvailableModels(provider, { env, fetchImpl });
    if (result.ok) available[provider] = result.ids;
    else errors[provider] = result.error;
  }
  const suggestions = suggestModelUpgrades({ configured, available });
  const previous = dataDir ? readModelUpgradeCache(dataDir) : null;
  const notified = new Set(previous?.notified ?? []);
  const announced = [];
  // outreach is null when the owner turned proactive outreach off: the check
  // and cache still run, nothing is announced, and nothing is marked as
  // announced (so turning outreach back on still delivers it once).
  for (const s of suggestions) {
    if (typeof outreach?.append !== "function") break;
    const ref = `${s.kind}:${s.key}:${s.model}->${s.suggested ?? "none"}`;
    if (notified.has(ref)) continue;
    notified.add(ref);
    const text = describe(s);
    outreach.append({ type: "suggestion", sourceRef: { kind: "model-upgrade", id: ref }, title: text.title, summary: text.summary, dedupeOpen: true });
    announced.push(ref);
  }
  const result = {
    checkedAt: now.toISOString(),
    checked: providers.filter((p) => available[p]),
    errors,
    suggestions: suggestions.map((s) => ({ ...s, ...describe(s) })),
    announced,
    notified: [...notified].slice(-200)
  };
  if (dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    writeJsonAtomic(path.join(dataDir, CACHE_FILE), result);
  }
  return result;
}
