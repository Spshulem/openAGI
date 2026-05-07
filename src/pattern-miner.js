// Pattern miner — scans the observation store's activity stream for
// repeating sequences of app focus, asks the LLM to propose a skill, and
// queues the proposal for user approval in .openagi/skills-suggested/.
//
// Confidence sources (combined into a 0..1 score):
//   - count: how many times the sequence repeats in the lookback window
//   - timeOfDayStability: variance of start-hour across occurrences (small = good)
//   - sequenceRigidity: how often the apps appear in exact order vs. shuffled
//   - lengthBonus: longer sequences score slightly higher
//
// We only emit candidates above a confidence threshold; the LLM gets a final
// gate ("if this isn't actually a routine, say 'pass'") to reject false positives.

import path from "node:path";
import fs from "node:fs";
import { ensureDir, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { createId, nowIso } from "./utils.js";

const DEFAULT_LOOKBACK_DAYS = 14;
const MIN_OCCURRENCES = 3;
const MIN_SEQUENCE_LEN = 3;
const MAX_SEQUENCE_LEN = 6;
const MIN_CONFIDENCE = 0.55;
const SUGGESTED_DIR = "skills-suggested";

export class PatternMiner {
  constructor(options = {}) {
    this.runtime = options.runtime;
    this.dataDir = options.dataDir ?? process.env.OPENAGI_DATA_DIR ?? ".openagi";
    this.lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    this.minOccurrences = options.minOccurrences ?? MIN_OCCURRENCES;
    this.minSequenceLen = options.minSequenceLen ?? MIN_SEQUENCE_LEN;
    this.maxSequenceLen = options.maxSequenceLen ?? MAX_SEQUENCE_LEN;
    this.minConfidence = options.minConfidence ?? MIN_CONFIDENCE;
    this.suggestedDir = path.join(this.dataDir, SUGGESTED_DIR);
    ensureDir(this.suggestedDir);
  }

  /**
   * Run a mining pass: read activity, find sequences, gate via LLM, write
   * candidates to disk. Returns a summary.
   */
  async mine({ now = new Date() } = {}) {
    if (!this.runtime?.observations) return { skipped: true, reason: "no observation store" };
    const since = new Date(now.getTime() - this.lookbackDays * 86400 * 1000).toISOString();
    const rows = await this.runtime.observations.search({ since, limit: 5000 });
    const activity = rows.filter((r) => r.kind === "activity" || r.event === "focus");
    if (activity.length < this.minOccurrences * this.minSequenceLen) {
      return { skipped: true, reason: "insufficient activity" };
    }

    const sequences = mineSequences(activity, {
      minLen: this.minSequenceLen,
      maxLen: this.maxSequenceLen,
      minOccurrences: this.minOccurrences
    });

    const scored = sequences
      .map((seq) => ({ ...seq, confidence: scoreSequence(seq) }))
      .filter((seq) => seq.confidence >= this.minConfidence)
      .sort((a, b) => b.confidence - a.confidence);

    if (scored.length === 0) return { mined: sequences.length, candidates: 0 };

    // Limit how many candidates we ask the LLM about per run.
    const top = scored.slice(0, 5);
    const candidates = [];
    for (const seq of top) {
      // Skip sequences we've already proposed to avoid duplicates.
      if (this.alreadyProposed(seq)) continue;
      const proposal = await this.llmProposal(seq);
      if (!proposal || proposal.pass === true) continue;
      const candidate = this.persistCandidate(seq, proposal);
      candidates.push(candidate);
    }
    return { mined: sequences.length, scored: scored.length, candidates: candidates.length, items: candidates };
  }

  alreadyProposed(seq) {
    try {
      const files = fs.readdirSync(this.suggestedDir);
      const fp = sequenceFingerprint(seq.apps);
      return files.some((f) => {
        try {
          const json = readJsonFile(path.join(this.suggestedDir, f));
          return json?.fingerprint === fp;
        } catch { return false; }
      });
    } catch { return false; }
  }

  async llmProposal(seq) {
    const provider = this.runtime?.agentHost?.modelProvider;
    if (!provider?.isConfigured?.() || provider.constructor.name === "DeterministicModelProvider") {
      // Without an LLM, draft a plain template skill. User can edit on accept.
      return {
        pass: false,
        name: `routine-${seq.apps.map((a) => a.replace(/\W/g, "")).join("-").slice(0, 40).toLowerCase()}`,
        description: `Repeating sequence: ${seq.apps.join(" → ")}`,
        body: `When this routine kicks off, walk through these apps in order:\n${seq.apps.map((a, i) => `${i + 1}. ${a}`).join("\n")}\n\nThis was auto-detected from your activity ${seq.count} times in the last ${this.lookbackDays} days.`,
        scheduleHint: seq.startHour != null ? `daily at ${pad2(seq.startHour)}:00` : null
      };
    }
    const prompt = buildProposalPrompt(seq);
    try {
      const result = await provider.generate({
        input: prompt,
        agent: { id: "pattern-miner", name: "pattern-miner" },
        memoryHits: [],
        messages: [],
        tools: [],
        toolRegistry: null,
        instructions: PROPOSAL_SYSTEM_PROMPT,
        context: {}
      });
      return parseProposal(result.text);
    } catch (error) {
      return null;
    }
  }

  persistCandidate(seq, proposal) {
    const id = createId("sug");
    const candidate = {
      id,
      fingerprint: sequenceFingerprint(seq.apps),
      proposedAt: nowIso(),
      sequence: seq,
      proposal,
      status: "pending"
    };
    writeJsonAtomic(path.join(this.suggestedDir, `${id}.json`), candidate);
    return candidate;
  }

  list() {
    try {
      return fs.readdirSync(this.suggestedDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => readJsonFile(path.join(this.suggestedDir, f), null))
        .filter(Boolean)
        .sort((a, b) => (b.proposedAt ?? "").localeCompare(a.proposedAt ?? ""));
    } catch { return []; }
  }

  /**
   * Accept a candidate by writing it as a real SKILL.md and removing the
   * suggestion. Returns the skill's path.
   */
  accept(id) {
    const file = path.join(this.suggestedDir, `${id}.json`);
    const candidate = readJsonFile(file, null);
    if (!candidate) throw new Error(`Unknown candidate: ${id}`);
    const skillName = sanitizeSkillName(candidate.proposal.name);
    const skillsRoot = path.join(this.dataDir, "skills");
    const skillDir = path.join(skillsRoot, skillName);
    ensureDir(skillDir);
    const md = renderSkillMarkdown(candidate, skillName);
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), md, { mode: 0o600 });
    candidate.status = "accepted";
    candidate.acceptedAt = nowIso();
    writeJsonAtomic(file, candidate);
    if (this.runtime?.skills?.reload) this.runtime.skills.reload();
    return { id, name: skillName, path: path.join(skillDir, "SKILL.md") };
  }

  reject(id, reason = null) {
    const file = path.join(this.suggestedDir, `${id}.json`);
    const candidate = readJsonFile(file, null);
    if (!candidate) return null;
    candidate.status = "rejected";
    candidate.rejectedAt = nowIso();
    if (reason) candidate.rejectReason = reason;
    writeJsonAtomic(file, candidate);
    return candidate;
  }
}

// MARK: — sequence mining

function mineSequences(activity, { minLen, maxLen, minOccurrences }) {
  // Activity rows in chronological order
  const sorted = activity.slice().sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  // Build a flat array of app names, segmenting by gaps > 60 minutes
  const segments = [];
  let current = [];
  let prevTime = null;
  for (const a of sorted) {
    const t = new Date(a.at).getTime();
    if (prevTime != null && t - prevTime > 60 * 60 * 1000) {
      if (current.length) segments.push(current);
      current = [];
    }
    current.push({ app: a.app ?? "(unknown)", at: a.at });
    prevTime = t;
  }
  if (current.length) segments.push(current);

  // For each window length, count occurrences (de-duplicated app sequences)
  const sequenceMap = new Map();
  for (const seg of segments) {
    for (let len = minLen; len <= maxLen; len += 1) {
      for (let i = 0; i + len <= seg.length; i += 1) {
        const slice = seg.slice(i, i + len);
        // Compress consecutive duplicates so "Linear, Linear, Slack" becomes "Linear, Slack"
        const apps = compressDupes(slice.map((s) => s.app));
        if (apps.length < minLen) continue;
        const key = apps.join("→");
        if (!sequenceMap.has(key)) {
          sequenceMap.set(key, { apps, occurrences: [] });
        }
        sequenceMap.get(key).occurrences.push(slice[0].at);
      }
    }
  }
  const out = [];
  for (const [, info] of sequenceMap) {
    if (info.occurrences.length < minOccurrences) continue;
    const startHours = info.occurrences.map((t) => new Date(t).getHours());
    const meanHour = startHours.reduce((a, b) => a + b, 0) / startHours.length;
    const variance = startHours.reduce((a, h) => a + (h - meanHour) ** 2, 0) / startHours.length;
    out.push({
      apps: info.apps,
      count: info.occurrences.length,
      startHour: Math.round(meanHour),
      hourVariance: variance,
      occurrences: info.occurrences
    });
  }
  return out;
}

function compressDupes(arr) {
  const out = [];
  let prev = null;
  for (const x of arr) {
    if (x !== prev) out.push(x);
    prev = x;
  }
  return out;
}

function scoreSequence(seq) {
  const countComponent = Math.min(1, seq.count / 8);
  // Variance in hours: 0 = perfect time-of-day stability; 12 = chaotic
  const timeStability = Math.max(0, 1 - seq.hourVariance / 12);
  const lengthBonus = Math.min(0.15, (seq.apps.length - 3) * 0.05);
  return Math.min(1, countComponent * 0.5 + timeStability * 0.4 + lengthBonus);
}

function sequenceFingerprint(apps) {
  return apps.map((a) => String(a).toLowerCase()).join("→");
}

// MARK: — LLM prompting

const PROPOSAL_SYSTEM_PROMPT = `You are auto-detecting routines from a user's observed app-focus sequences.

For each candidate sequence, decide whether it's a real routine the user would want as a runnable skill. Be conservative: it's better to pass than to propose a routine that doesn't actually exist.

Output STRICTLY as JSON, no preamble. Schema:

{
  "pass": false,                          // true = this isn't a real routine; skip it
  "name": "kebab-case-slug",              // short, no spaces
  "description": "1 sentence",
  "body": "Markdown body for the skill, plain prose, no fluff. Tell the agent what the user is doing during this sequence and what would help them complete it (e.g. fetch latest tickets, summarize Slack DMs).",
  "scheduleHint": "daily at 09:00"        // null if no obvious cadence
}

If pass=true, you can omit the other fields.`;

function buildProposalPrompt(seq) {
  return `Sequence: ${seq.apps.join(" → ")}
Occurrences: ${seq.count} times in the last 14 days
Typical start hour: ~${seq.startHour}:00 (variance ${seq.hourVariance.toFixed(1)})

Is this a real routine?`;
}

function parseProposal(text) {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    if (obj.pass === true) return { pass: true };
    if (!obj.name || !obj.body) return null;
    return {
      pass: false,
      name: String(obj.name),
      description: String(obj.description ?? ""),
      body: String(obj.body),
      scheduleHint: obj.scheduleHint ?? null
    };
  } catch { return null; }
}

// MARK: — skill rendering

function sanitizeSkillName(raw) {
  return String(raw ?? "auto-skill")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "auto-skill";
}

function renderSkillMarkdown(candidate, skillName) {
  const { proposal, sequence } = candidate;
  return `---
name: ${skillName}
description: ${proposal.description.replace(/\n/g, " ")}
---

${proposal.body}

---

*Auto-derived from a repeating sequence in your activity log.*
*Sequence: ${sequence.apps.join(" → ")}*
*Observed ${sequence.count} times around ${pad2(sequence.startHour)}:00.*
${proposal.scheduleHint ? `*Suggested schedule: ${proposal.scheduleHint}.*` : ""}
`;
}

function pad2(n) { return String(n).padStart(2, "0"); }
