import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./file-utils.js";
import { scoreFromToolCalls } from "./outcome-store.js";

export class SkillRegistry {
  constructor(options = {}) {
    this.runtime = options.runtime;
    this.dirs = options.dirs ?? [];
    this.skills = new Map();
    if (options.autoLoad !== false) this.reload();
  }

  reload() {
    this.skills.clear();
    for (const dir of this.dirs) this.loadFrom(dir);
    if (this.runtime?.tools) this.exposeAsTools(this.runtime.tools);
    return this.list();
  }

  loadFrom(dir) {
    try {
      ensureDir(dir);
    } catch {
      return;
    }
    for (const entry of safeReadDir(dir)) {
      const skillDir = path.join(dir, entry);
      if (!safeIsDir(skillDir)) continue;
      const skillPath = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillPath)) continue;
      const skill = parseSkill(skillPath, skillDir);
      if (skill) this.skills.set(skill.name, skill);
    }
  }

  list() {
    return [...this.skills.values()].map(({ body, dir, ...rest }) => rest);
  }

  has(name) {
    return this.skills.has(name);
  }

  exposeAsTools(toolRegistry) {
    for (const name of [...toolRegistry.tools.keys()]) {
      if (name.startsWith("skill_")) toolRegistry.unregister(name);
    }
    for (const skill of this.skills.values()) {
      const toolName = `skill_${skill.name.replaceAll("-", "_")}`;
      toolRegistry.register({
        name: toolName,
        description: `Skill: ${skill.description ?? skill.name}`,
        source: "skill",
        parameters: skill.parameters ?? {
          type: "object",
          properties: {
            input: { type: "string", description: "Free-text input for the skill." },
            args: { type: "object", description: "Optional structured arguments.", additionalProperties: true }
          },
          additionalProperties: false
        },
        handler: (args, context) => this.run(skill.name, { input: args.input, args: args.args ?? {} }, context),
        metadata: { skill: skill.name }
      });
    }
  }

  async run(name, { input = "", args = {} } = {}, context = {}) {
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    const rendered = renderTemplate(skill.body, { input, args });
    const provider = this.runtime?.agentHost?.modelProvider;
    if (!provider) throw new Error("No model provider available for skill execution.");
    const agentName = `skill:${skill.name}`;
    const instructions = skill.systemPrompt ||
      `You are executing the "${skill.name}" skill. ${skill.description}\nReturn only the user-visible output. Use tools when helpful.`;
    // Story 2: record outcome lineage for the skill run. If the skill
    // was materialized from a proactive-suggestion, the outcome carries
    // that suggestion id forward so /proactive/suggestions/:id/outcome
    // can later report "this proposal led to N runs at X% quality".
    let outcome = null;
    if (this.runtime?.outcomes?.record) {
      outcome = this.runtime.outcomes.record({
        kind: "skill-run",
        refId: skill.name,
        sessionId: context?.sessionId ?? null,
        agentId: agentName,
        channel: context?.channel ?? null,
        metadata: {
          skill: skill.name,
          sourceSuggestionId: skill.sourceSuggestionId ?? null,
          input: input.slice(0, 200)
        }
      });
    }
    try {
      const result = await provider.generate({
        input: rendered,
        agent: { id: agentName, name: agentName, systemPrompt: skill.systemPrompt ?? "" },
        memoryHits: [],
        messages: [],
        tools: this.runtime.tools?.toOpenAITools?.() ?? [],
        toolRegistry: this.runtime.tools,
        instructions,
        context: { ...context, skill: skill.name }
      });
      // Tool-using skill completions are graded by their per-call results.
      // Text-only completions keep the historical 0.7.
      if (outcome) {
        const calls = (result.toolCalls ?? []).map((c) => ({ name: c.name, ok: c.result?.ok ?? false }));
        const completionScore = calls.length > 0 ? scoreFromToolCalls(calls) : 0.7;
        this.runtime.outcomes.resolve(outcome.id, completionScore, "skill-completed");
      }
      return { skill: skill.name, output: result.text, toolCalls: result.toolCalls ?? [] };
    } catch (error) {
      if (outcome) this.runtime.outcomes.resolve(outcome.id, 0.1, "skill-failed", error.message);
      throw error;
    }
  }
}

function parseSkill(filePath, dir) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/.exec(text);
  if (!match) return null;
  const meta = parseFrontmatter(match[1]);
  const body = match[2].trim();
  if (!meta.name) return null;
  return {
    name: meta.name,
    description: meta.description ?? "",
    systemPrompt: meta.systemPrompt ?? meta["system-prompt"] ?? "",
    parameters: meta.parameters ?? null,
    // Story 2: lineage back to the proactive-suggestion that birthed
    // this skill (set by skill-materialize.js when the user accepts
    // a category=skill proposal). null for hand-authored skills.
    sourceSuggestionId: meta.sourceSuggestionId ?? null,
    createdBy: meta.createdBy ?? null,
    createdAt: meta.createdAt ?? null,
    // Learned workflow metadata remains available after acceptance. Runtime
    // execution is still user-invoked/approval-gated; these fields describe
    // the observed interaction and let UI/future trigger adapters use it
    // without reparsing the source candidate.
    observedTrigger: meta.observedTrigger ?? null,
    observedCadence: meta.observedCadence ?? null,
    observedHorizons: meta.observedHorizons ?? [],
    body,
    dir,
    path: filePath
  };
}

function parseFrontmatter(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else if (value.startsWith("{") || value.startsWith("[")) {
      try {
        value = JSON.parse(value);
      } catch {
        // leave as raw string
      }
    }
    out[key] = value;
  }
  return out;
}

function renderTemplate(template, vars) {
  return String(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, expr) => {
    const path = expr.split(".");
    let cursor = vars;
    for (const segment of path) {
      if (cursor == null) return "";
      cursor = cursor[segment];
    }
    if (cursor == null) return "";
    return typeof cursor === "string" ? cursor : JSON.stringify(cursor);
  });
}

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function safeIsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
