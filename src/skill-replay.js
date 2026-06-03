// Skill replay — parses a structured action list out of a SKILL.md
// (under a `replay:` YAML key in frontmatter or after a `---` separator)
// and routes it to the Mac app for execution. Mac picks up the request
// via SSE and runs the action vocabulary; results post back to
// POST /skills/replay-result/<jobId>.

import path from "node:path";
import fs from "node:fs";
import { ensureDir, readJsonFile, writeJsonAtomic } from "./file-utils.js";
import { createId, nowIso } from "./utils.js";
import { resolveDataDir } from "./data-dir.js";

const ALLOWED_ACTIONS = new Set([
  "open_app",
  "wait",
  "keyboard_shortcut",
  "type",
  "press",
  "applescript",
  "shortcut",
  "say",
  "browser",
  "comment"
]);

export class SkillReplay {
  constructor(options = {}) {
    this.runtime = options.runtime;
    this.dataDir = options.dataDir ?? resolveDataDir();
    this.replayDir = path.join(this.dataDir, "replay");
    ensureDir(this.replayDir);
    this.events = options.events ?? null; // EventEmitter from hosted-interface
    this.pendingResults = new Map(); // jobId → { resolve, reject, timeout }
  }

  bindEvents(emitter) {
    this.events = emitter;
  }

  /**
   * Read a skill's replay steps. Returns parsed actions or null if the skill
   * has no replay block (i.e. it's a prompt-style skill).
   */
  loadReplaySteps(skillName) {
    const skillDir = path.join(this.dataDir, "skills", skillName);
    const file = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, "utf8");
    return parseReplayBlock(text);
  }

  /**
   * Trigger a replay. Returns a promise that resolves with the Mac-side
   * execution result, or rejects on timeout.
   *
   *   await replay.run({ skill: "morning-brief", dryRun: false })
   */
  async run({ skill, steps, dryRun = false, confirm = "first-run", timeoutMs = 5 * 60 * 1000 } = {}) {
    if (!steps && skill) steps = this.loadReplaySteps(skill);
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error(`Skill '${skill ?? "(none)"}' has no replay steps to run.`);
    }
    const validation = validateSteps(steps);
    if (!validation.ok) throw new Error(`Invalid replay steps: ${validation.errors.join("; ")}`);

    if (!this.events) throw new Error("Replay needs the SSE events emitter; bind it from hosted-interface.");

    const jobId = createId("rep");
    const job = {
      id: jobId,
      skill: skill ?? null,
      steps,
      dryRun,
      confirm,
      createdAt: nowIso(),
      status: "queued"
    };
    writeJsonAtomic(path.join(this.replayDir, `${jobId}.json`), job);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResults.delete(jobId);
        reject(new Error(`Replay timed out after ${timeoutMs}ms (no Mac client response)`));
      }, timeoutMs);
      this.pendingResults.set(jobId, { resolve, reject, timer });
      this.events.emit("replay", { op: "request", jobId, skill: skill ?? null, steps, dryRun, confirm });
    });
  }

  /**
   * Called from POST /skills/replay-result/:jobId once the Mac side finishes.
   */
  resolveJob(jobId, result) {
    const file = path.join(this.replayDir, `${jobId}.json`);
    const existing = readJsonFile(file, null);
    if (!existing) return null;
    existing.status = result?.error ? "error" : (result?.dryRun ? "dry-run-complete" : "completed");
    existing.result = result;
    existing.resolvedAt = nowIso();
    writeJsonAtomic(file, existing);
    const pending = this.pendingResults.get(jobId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingResults.delete(jobId);
      if (result?.error) pending.reject(new Error(result.error));
      else pending.resolve(result);
    }
    // Outcome feedback for the propagation layer.
    if (this.runtime?.outcomes && existing.skill) {
      const outcome = this.runtime.outcomes.record({
        kind: "skill-replay",
        refId: jobId,
        metadata: { skill: existing.skill, dryRun: existing.dryRun }
      });
      this.runtime.outcomes.resolve(outcome.id, result?.error ? 0.0 : (result?.dryRun ? 0.5 : 0.9), "system-inferred");
    }
    return existing;
  }

  list({ status = null, limit = 50 } = {}) {
    try {
      let entries = fs.readdirSync(this.replayDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => readJsonFile(path.join(this.replayDir, f), null))
        .filter(Boolean);
      if (status) entries = entries.filter((j) => j.status === status);
      return entries.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")).slice(0, limit);
    } catch { return []; }
  }
}

// MARK: — frontmatter parsing

/**
 * Extract a list of action steps from a SKILL.md. Looks for, in order:
 *   1. `replay:` key in YAML frontmatter (between `---` markers) with a list
 *   2. A fenced ```yaml (or ```replay) code block with a top-level `steps:` list
 * Returns null if no replay is defined (the skill is prompt-style only).
 */
export function parseReplayBlock(text) {
  if (!text) return null;

  // 1) frontmatter
  const fm = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (fm) {
    const block = fm[1];
    const idx = block.search(/^replay\s*:/m);
    if (idx >= 0) {
      // very small YAML-list parser — supports:
      //   replay:
      //     - open_app: "Linear"
      //     - wait: 1.5
      //     - keyboard_shortcut: "cmd+k"
      const rest = block.slice(idx);
      return parseYamlList(rest);
    }
  }

  // 2) fenced code block
  const fence = /```(?:yaml|replay)\s*\n([\s\S]*?)```/m.exec(text);
  if (fence) {
    return parseYamlList(`replay:\n${fence[1].split("\n").map((l) => "  " + l).join("\n")}`);
  }

  return null;
}

function parseYamlList(blockText) {
  const lines = blockText.split(/\r?\n/);
  const steps = [];
  for (const raw of lines) {
    const line = raw;
    const trimmed = line.trim();
    if (!trimmed || trimmed === "replay:") continue;
    if (!line.startsWith(" ")) break; // out of replay block
    if (!trimmed.startsWith("-")) continue;
    const inner = trimmed.replace(/^-\s*/, "");
    const colon = inner.indexOf(":");
    if (colon < 0) continue;
    const key = inner.slice(0, colon).trim();
    let value = inner.slice(colon + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else if (!isNaN(Number(value))) {
      value = Number(value);
    }
    steps.push({ [key]: value });
  }
  return steps.length ? steps : null;
}

function validateSteps(steps) {
  const errors = [];
  steps.forEach((step, i) => {
    if (typeof step !== "object" || step === null) {
      errors.push(`step ${i}: must be an object`);
      return;
    }
    const keys = Object.keys(step);
    if (keys.length !== 1) {
      errors.push(`step ${i}: must have exactly one action key, got ${keys.length}`);
      return;
    }
    if (!ALLOWED_ACTIONS.has(keys[0])) {
      errors.push(`step ${i}: unknown action '${keys[0]}' (allowed: ${[...ALLOWED_ACTIONS].join(", ")})`);
    }
  });
  return { ok: errors.length === 0, errors };
}
