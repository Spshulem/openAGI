import fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

// Story 4: unified read/write surface for proposals coming from three
// independent sources:
//   - proactive-observer  → .openagi/proactive/suggestions/prop_*.json
//   - pattern-miner       → .openagi/skills-suggested/sug_*.json
//   - session-miner       → .openagi/skills-suggested/ses_*.json
//
// Before this module, the dashboard only read the first source — so any
// pattern the miners detected sat invisible in skills-suggested/ forever.
// This aggregator normalizes all three to a common envelope and routes
// writes back to whichever source the id came from.

const ENVELOPE_FIELDS = [
  "id", "proposedAt", "category", "title", "rationale", "status",
  "draftBody", "taskQueue", "taskBucket", "mcpId", "mcpRegister",
  "context", "resolvedAt", "note", "source",
  // Miner-only fields surface as-is so the UI can show count + confidence
  "sequence", "fingerprint", "proposal", "judgeBypass"
];

/// Walk all three source dirs and return suggestions normalized to one
/// shape. `status` filter follows the proactive-observer convention.
/// Sorted newest-first.
export function listAllSuggestions(runtime, { status = "pending" } = {}) {
  const obs = readObserverSuggestions(runtime, status);
  const mined = readMinedCandidates(runtime, status);
  const all = [...obs, ...mined];
  return all.sort((a, b) => (b.proposedAt ?? "").localeCompare(a.proposedAt ?? ""));
}

/// Resolve a suggestion by id from any source. Returns the envelope (or null
/// if no matching id). Caller is expected to dispatch on `source` next.
export function findSuggestion(runtime, id) {
  return listAllSuggestions(runtime, { status: null }).find((s) => s.id === id) ?? null;
}

/// Write status + resolvedAt back to whichever source file owns this id.
/// Returns the updated envelope or null when not found.
export function resolveSuggestion(runtime, id, status, note = null) {
  const file = findSourceFile(runtime, id);
  if (!file) return null;
  const raw = readJsonFile(file, null);
  if (!raw) return null;
  raw.status = status;
  raw.resolvedAt = nowIso();
  if (note) raw.note = note;
  writeJsonAtomic(file, raw);
  return normalize(raw, file);
}

// ─── source-specific reads + path resolution ────────────────────────────

function readObserverSuggestions(runtime, status) {
  const dir = path.join(runtime?.dataDir ?? defaultDataDir(runtime), "proactive", "suggestions");
  return readDirNormalized(dir, status, "observer");
}

function readMinedCandidates(runtime, status) {
  const dir = path.join(runtime?.dataDir ?? defaultDataDir(runtime), "skills-suggested");
  return readDirNormalized(dir, status);
}

function readDirNormalized(dir, status, forceSource = null) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of names) {
    if (!f.endsWith(".json")) continue;
    const raw = readJsonFile(path.join(dir, f), null);
    if (!raw) continue;
    const envelope = normalize(raw, path.join(dir, f), forceSource);
    if (!envelope) continue;
    if (status && envelope.status !== status) continue;
    out.push(envelope);
  }
  return out;
}

// Map any source's candidate JSON onto the common envelope. Returns null
// when the input doesn't look like a valid suggestion (defensive — keeps
// readDirNormalized robust against half-written files).
function normalize(raw, filePath, forceSource = null) {
  if (!raw || !raw.id) return null;
  let source = forceSource;
  if (!source) {
    if (raw.id.startsWith("prop_")) source = "observer";
    else if (raw.id.startsWith("sug_")) source = "pattern-miner";
    else if (raw.id.startsWith("ses_")) source = "session-miner";
    else source = "unknown";
  }
  // Story 10: proactive-observer in long-horizon mode tags its persisted
  // candidate with `source: "weekly-observer"` directly on the record.
  // That overrides our id-prefix guess so the dashboard can distinguish
  // "noticed something just now" from "noticed a multi-day thread."
  if (raw.source === "weekly-observer") source = "weekly-observer";
  if (source === "observer" || source === "weekly-observer") {
    return pickEnvelope({ ...raw, source });
  }
  // Miner candidates: lift proposal.{name, description, body} into the
  // top-level envelope so the existing dashboard cards + accept logic
  // work without special-casing.
  return pickEnvelope({
    id: raw.id,
    proposedAt: raw.proposedAt,
    status: raw.status ?? "pending",
    category: "skill",
    title: raw.proposal?.name ?? "(unnamed pattern)",
    rationale: composeRationale(raw),
    draftBody: raw.proposal?.body ?? null,
    sequence: raw.sequence ?? null,
    fingerprint: raw.fingerprint ?? null,
    proposal: raw.proposal ?? null,
    judgeBypass: raw.judgeBypass ?? false,
    resolvedAt: raw.resolvedAt ?? null,
    source
  });
}

// Mined candidates have a richer "why" we can surface — count, time of day,
// confidence — that's more informative than just the proposal description.
function composeRationale(raw) {
  const parts = [];
  if (raw.proposal?.description) parts.push(raw.proposal.description);
  if (raw.sequence?.count) {
    const hourPart = raw.sequence.startHour != null ? ` around ${pad(raw.sequence.startHour)}:00` : "";
    parts.push(`Observed ${raw.sequence.count}× ${hourPart}`.trim());
  }
  if (typeof raw.sequence?.confidence === "number") {
    parts.push(`confidence ${raw.sequence.confidence.toFixed(2)}`);
  }
  return parts.join(" · ");
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function pickEnvelope(raw) {
  const out = {};
  for (const k of ENVELOPE_FIELDS) if (raw[k] !== undefined) out[k] = raw[k];
  return out;
}

function findSourceFile(runtime, id) {
  const dataDir = runtime?.dataDir ?? defaultDataDir(runtime);
  const candidates = [
    path.join(dataDir, "proactive", "suggestions", `${id}.json`),
    path.join(dataDir, "skills-suggested", `${id}.json`)
  ];
  return candidates.find((f) => fs.existsSync(f)) ?? null;
}

// Used when runtime doesn't expose dataDir directly — falls back to the
// proactive observer's known dataDir (set at construction).
function defaultDataDir(runtime) {
  return runtime?.proactiveObserver?.dataDir ?? runtime?.patternMiner?.dataDir ?? resolveDataDir();
}
