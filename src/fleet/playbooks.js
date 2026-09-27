// Loads the supervisor's message templates from editable Markdown files.
// Each playbook is `playbooks/<id>.md` with flat `key: value` frontmatter
// (id, cooldown_min, max_attempts, ask) and a body with {placeholders}.
// A user copy under <dataDir>/skills/fleet-supervisor/playbooks overrides the
// bundled one, so the owner can change wording without a code change.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUNDLED_PLAYBOOKS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "skills", "fleet-supervisor", "playbooks"
);

export function userPlaybooksDir(dataDir) {
  return path.join(dataDir, "skills", "fleet-supervisor", "playbooks");
}

export function loadPlaybooks({ bundledDir = BUNDLED_PLAYBOOKS_DIR, userDir = null } = {}) {
  const playbooks = new Map();
  // Later dirs win: user files replace bundled ones with the same id.
  for (const dir of [bundledDir, userDir]) {
    if (!dir) continue;
    for (const file of listMarkdown(dir)) {
      const playbook = parsePlaybookText(readText(path.join(dir, file)), path.basename(file, ".md"));
      if (playbook) playbooks.set(playbook.id, playbook);
    }
  }
  return playbooks;
}

export function parsePlaybookText(text, fallbackId = "") {
  const source = String(text ?? "");
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/.exec(source);
  const meta = match ? parseFlatFrontmatter(match[1]) : {};
  const body = (match ? match[2] ?? "" : source).trim();
  const id = String(meta.id ?? fallbackId ?? "").trim();
  if (!id || !body) return null;
  return {
    id,
    body,
    cooldownMin: positiveNumber(meta.cooldown_min),
    maxAttempts: positiveNumber(meta.max_attempts),
    ask: String(meta.ask ?? "").trim()
  };
}

// {name} placeholders only. Missing values render empty; own properties
// only, so "{constructor}" can never pull in a prototype function.
export function renderTemplate(text, vars = {}) {
  return String(text ?? "")
    .replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
      const value = Object.hasOwn(vars, name) ? vars[name] : null;
      return value === null || value === undefined ? "" : String(value);
    })
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseFlatFrontmatter(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf(":");
    if (index <= 0) continue;
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[line.slice(0, index).trim()] = value;
  }
  return out;
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function listMarkdown(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}
