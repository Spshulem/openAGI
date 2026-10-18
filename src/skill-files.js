import fs from "node:fs";
import path from "node:path";
import { ensureDir, writeTextAtomic } from "./file-utils.js";

// Reading and writing the owner's own skills (<dataDir>/skills/<name>/SKILL.md)
// for the phone app's Skills screen. Bundled example skills are listed but
// read-only; only files under the data dir's skills folder are ever written
// or deleted.

export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_DESCRIPTION = 500;
const MAX_INSTRUCTIONS = 20_000;

export function userSkillsDir(dataDir) {
  return path.join(dataDir, "skills");
}

function skillFile(dataDir, name) {
  return path.join(userSkillsDir(dataDir), name, "SKILL.md");
}

function isUserSkill(dataDir, skill) {
  if (!skill?.dir) return false;
  const root = path.resolve(userSkillsDir(dataDir)) + path.sep;
  return path.resolve(skill.dir).startsWith(root);
}

export function listSkills(registry, dataDir) {
  return [...(registry?.skills?.values?.() ?? [])].map((skill) => ({
    name: skill.name,
    description: skill.description ?? "",
    editable: isUserSkill(dataDir, skill),
    createdBy: skill.createdBy ?? null
  })).sort((a, b) => a.name.localeCompare(b.name));
}

export function readSkill(registry, dataDir, name) {
  const skill = registry?.skills?.get?.(name);
  if (!skill) return null;
  return {
    name: skill.name,
    description: skill.description ?? "",
    instructions: skill.body ?? "",
    editable: isUserSkill(dataDir, skill)
  };
}

// Creates or replaces a skill. An existing file keeps its other frontmatter
// (parameters, lineage, systemPrompt); only the description and body change.
export function writeSkill(dataDir, name, { description = "", instructions = "" } = {}) {
  if (!SKILL_NAME_PATTERN.test(name)) throw Object.assign(new Error("Skill names use lowercase letters, digits and dashes."), { status: 400 });
  const desc = String(description).replace(/[\r\n]+/g, " ").trim();
  const body = String(instructions).trim();
  if (!body) throw Object.assign(new Error("A skill needs instructions."), { status: 400 });
  if (desc.length > MAX_DESCRIPTION || body.length > MAX_INSTRUCTIONS) throw Object.assign(new Error("Skill is too long."), { status: 413 });
  const file = skillFile(dataDir, name);
  let kept = [];
  try {
    const existing = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(file, "utf8"));
    if (existing) kept = existing[1].split(/\r?\n/).filter((line) => !/^\s*(name|description)\s*:/.test(line));
  } catch { /* new skill */ }
  const frontmatter = [`name: ${name}`, `description: ${JSON.stringify(desc)}`, ...kept];
  if (!kept.some((line) => /^\s*createdBy\s*:/.test(line))) frontmatter.push("createdBy: owner");
  ensureDir(path.dirname(file));
  writeTextAtomic(file, `---\n${frontmatter.join("\n")}\n---\n\n${body}\n`, 0o600);
  return file;
}

export function deleteSkill(registry, dataDir, name) {
  const skill = registry?.skills?.get?.(name);
  if (!skill) return false;
  if (!isUserSkill(dataDir, skill)) throw Object.assign(new Error("Built-in skills can't be deleted."), { status: 409 });
  fs.rmSync(skill.dir, { recursive: true, force: true });
  return true;
}
