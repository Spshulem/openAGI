// Session miner — scans recent chat sessions for repeating user intents and
// proposes a skill that automates the recurring task. Companion to
// pattern-miner.js (which mines OS activity); this one mines conversations.
//
// Approach:
//   1. Pull the last N user messages across all sessions
//   2. Cluster by lightweight intent fingerprint (lowercased keyword bag,
//      stop-words removed). N≥3 in a cluster = recurring intent.
//   3. Ask the LLM to propose a skill that automates the recurring intent.
//      The LLM gets a "pass" escape hatch for false positives.
//   4. Persist into the same skills-suggested/ store as pattern-miner so the
//      dashboard's existing Skills tab picks them up.
//
// Candidate proposals fire the runtime "skill-candidate" event, which the
// hosted-interface relays over SSE so the Mac app can show a notification.

import path from "node:path";
import fs from "node:fs";
import { ensureDir, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { createId, nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

const DEFAULT_LOOKBACK_DAYS = 21;
const MIN_OCCURRENCES = 2;
const MIN_KEYWORDS = 2;
const MAX_USER_MESSAGES = 800;
const SUGGESTED_DIR = "skills-suggested";
const JACCARD_OVERLAP_THRESHOLD = 0.5;

const STOP_WORDS = new Set([
  "a","an","and","the","is","are","was","were","be","been","being","of","to","in","on","at",
  "for","with","by","from","as","that","this","these","those","it","its","i","you","me","my",
  "we","our","they","them","their","he","she","his","her","do","does","did","done","have",
  "has","had","will","would","should","could","can","may","might","must","shall","ought",
  "if","then","else","when","while","because","so","but","or","not","no","yes","what","which",
  "who","whom","where","why","how","just","please","thanks","hi","hello","hey","ok","okay"
]);

const PROPOSAL_SYSTEM_PROMPT = [
  "You review a recurring user request and decide whether it should become a saved skill.",
  "A skill is a repeatable routine OpenAGI can run on the user's behalf.",
  "Output STRICT JSON with one of these shapes:",
  '  {"pass": true, "reason": "<short>"}                     // not actually a routine',
  '  {"name":"<short-kebab>","description":"<one line>","body":"<markdown body>","scheduleHint":"<optional cron-ish hint or null>"}',
  "Skills should be concrete and useful. Reject one-off questions, vague chitchat, debugging help.",
  "Accept only if you see a clear repeatable task the user keeps asking for."
].join("\n");

export class SessionMiner {
  constructor(options = {}) {
    this.runtime = options.runtime;
    this.dataDir = options.dataDir ?? resolveDataDir();
    this.lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    this.minOccurrences = options.minOccurrences ?? MIN_OCCURRENCES;
    this.suggestedDir = path.join(this.dataDir, SUGGESTED_DIR);
    ensureDir(this.suggestedDir);
  }

  async mine({ now = new Date() } = {}) {
    const store = this.runtime?.agentHost?.store;
    if (!store?.listSessions) return { skipped: true, reason: "no agent store" };

    const sinceMs = now.getTime() - this.lookbackDays * 86400 * 1000;
    const sessions = store.listSessions().filter((s) => {
      const t = Date.parse(s.updatedAt ?? s.lastMessageAt ?? s.createdAt ?? "");
      return Number.isFinite(t) ? t >= sinceMs : true;
    });

    const userMessages = [];
    for (const sess of sessions) {
      const full = store.getSession(sess.id) ?? sess;
      for (const msg of full.messages ?? []) {
        if (msg.role !== "user" || typeof msg.content !== "string") continue;
        const text = msg.content.trim();
        if (text.length < 8 || text.length > 1500) continue;
        userMessages.push({ sessionId: sess.id, text, at: msg.at ?? full.updatedAt });
        if (userMessages.length >= MAX_USER_MESSAGES) break;
      }
      if (userMessages.length >= MAX_USER_MESSAGES) break;
    }

    if (userMessages.length < this.minOccurrences) {
      return { skipped: true, reason: "insufficient user messages" };
    }

    const clusters = clusterByKeywords(userMessages, this.minOccurrences);
    if (clusters.length === 0) return { mined: userMessages.length, candidates: 0 };

    const top = clusters.slice(0, 4);
    const candidates = [];
    for (const cluster of top) {
      if (this.alreadyProposed(cluster)) continue;
      const proposal = await this.llmProposal(cluster);
      if (!proposal || proposal.pass === true) continue;
      const candidate = this.persistCandidate(cluster, proposal);
      candidates.push(candidate);
      this.runtime?.events?.emit?.("skill-candidate", {
        source: "session-miner",
        id: candidate.id,
        name: proposal.name,
        description: proposal.description,
        occurrences: cluster.count
      });
    }
    return { mined: userMessages.length, clusters: clusters.length, candidates: candidates.length };
  }

  alreadyProposed(cluster) {
    try {
      const files = fs.readdirSync(this.suggestedDir);
      const fp = cluster.fingerprint;
      return files.some((f) => {
        try { return readJsonFile(path.join(this.suggestedDir, f))?.fingerprint === fp; }
        catch { return false; }
      });
    } catch { return false; }
  }

  async llmProposal(cluster) {
    const provider = this.runtime?.agentHost?.modelProvider;
    if (!provider?.isConfigured?.() || provider.constructor.name === "DeterministicModelProvider") {
      return {
        pass: false,
        name: `recurring-${cluster.keywords.slice(0, 3).join("-")}`.replace(/[^a-z0-9-]/gi, "-").slice(0, 40).toLowerCase(),
        description: `Recurring request involving: ${cluster.keywords.slice(0, 5).join(", ")}`,
        body: `You've asked something like this ${cluster.count} times in the last ${this.lookbackDays} days. Examples:\n${cluster.samples.map((s) => `- "${s.text}"`).join("\n")}\n\nThis skill is a placeholder — edit it to describe the routine you'd like OpenAGI to run.`,
        scheduleHint: null
      };
    }

    const prompt = buildProposalPrompt(cluster, this.lookbackDays);
    try {
      const result = await provider.generate({
        input: prompt,
        agent: { id: "session-miner", name: "session-miner" },
        memoryHits: [],
        messages: [],
        tools: [],
        toolRegistry: null,
        instructions: PROPOSAL_SYSTEM_PROMPT,
        context: {}
      });
      return parseProposal(result.text);
    } catch { return null; }
  }

  persistCandidate(cluster, proposal) {
    const id = createId("ses");
    const candidate = {
      id,
      source: "session-miner",
      fingerprint: cluster.fingerprint,
      proposedAt: nowIso(),
      cluster: { keywords: cluster.keywords, count: cluster.count, samples: cluster.samples },
      proposal,
      status: "pending"
    };
    writeJsonAtomic(path.join(this.suggestedDir, `${id}.json`), candidate);
    return candidate;
  }
}

// Cluster messages by Jaccard similarity of their keyword sets. Two messages
// land in the same cluster when their token sets overlap by ≥50% — looser
// than the prior exact-fingerprint match, so paraphrased restatements of
// the same intent ("fix dashboard 500" / "dashboard error 500" / "the
// dashboard is broken with a 500") cluster together.
function clusterByKeywords(messages, minCount) {
  const clusters = [];
  for (const msg of messages) {
    const tokens = tokenize(msg.text);
    if (tokens.length < MIN_KEYWORDS) continue;
    const tokenSet = new Set(tokens);
    let best = null;
    let bestScore = 0;
    for (const cluster of clusters) {
      const score = jaccardSimilarity(tokenSet, cluster.keywordSet);
      if (score >= JACCARD_OVERLAP_THRESHOLD && score > bestScore) {
        best = cluster;
        bestScore = score;
      }
    }
    if (best) {
      best.count += 1;
      if (best.samples.length < 3) best.samples.push({ sessionId: msg.sessionId, text: msg.text, at: msg.at });
      for (const t of tokens) {
        best.keywordSet.add(t);
        best.keywordCounts.set(t, (best.keywordCounts.get(t) ?? 0) + 1);
      }
    } else {
      clusters.push({
        keywordSet: tokenSet,
        keywordCounts: new Map(tokens.map((t) => [t, 1])),
        count: 1,
        samples: [{ sessionId: msg.sessionId, text: msg.text, at: msg.at }]
      });
    }
  }
  // Recompute each cluster's representative keywords (top-6 most common)
  // so the LLM proposal sees the dominant terms, not whatever the first
  // message happened to use.
  for (const c of clusters) {
    const sorted = [...c.keywordCounts.entries()].sort((a, b) => b[1] - a[1]);
    c.keywords = sorted.slice(0, 6).map(([k]) => k);
    c.fingerprint = c.keywords.slice().sort().join(" ");
  }
  return clusters
    .filter((c) => c.count >= minCount)
    .sort((a, b) => b.count - a.count);
}

function jaccardSimilarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function tokenize(text) {
  const words = text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];
  const seen = new Set();
  const out = [];
  for (const w of words) {
    if (STOP_WORDS.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 6) break;
  }
  return out;
}

function buildProposalPrompt(cluster, lookbackDays) {
  return [
    `The user has asked similar things ${cluster.count} times in the last ${lookbackDays} days.`,
    `Common keywords: ${cluster.keywords.join(", ")}`,
    "",
    "Examples of what they wrote:",
    ...cluster.samples.map((s, i) => `${i + 1}. "${s.text}"`),
    "",
    "If this is a one-off or chitchat, return {\"pass\": true, \"reason\": \"...\"}.",
    "Otherwise propose a skill (JSON) that automates the recurring intent."
  ].join("\n");
}

function parseProposal(text) {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); }
  catch { return null; }
}
