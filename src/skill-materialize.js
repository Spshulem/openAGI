import fs from "node:fs";
import path from "node:path";
import { ensureDir, writeTextAtomic } from "./file-utils.js";

// Turn an accepted "skill" proactive-suggestion into a durable SKILL.md
// file under the user's skills directory. Pure function from suggestion
// + runtime → { slug, path }; the caller is expected to runtime.skills
// .reload() afterward so the new skill shows up immediately.
//
// Why a separate module: keeps hosted-interface.js focused on the HTTP
// surface, and makes the slug/dedupe/frontmatter logic individually
// testable.

export function createSkillFromSuggestion({ runtime, suggestion }) {
  if (!suggestion?.title) throw new Error("suggestion has no title");
  if (!suggestion?.draftBody) throw new Error("suggestion has no draftBody — observer must have proposed an automation, not a skill");

  const userDir = pickUserSkillsDir(runtime);
  if (!userDir) throw new Error("no user skills directory available (runtime not durable?)");
  ensureDir(userDir);

  const slug = dedupeSlug(userDir, slugify(suggestion.title));
  const skillDir = path.join(userDir, slug);
  ensureDir(skillDir);
  const skillPath = path.join(skillDir, "SKILL.md");

  const description = (suggestion.rationale ?? suggestion.title ?? "").slice(0, 1024);
  const body = String(suggestion.draftBody ?? "").trim();
  const frontmatter = [
    "---",
    `name: ${slug}`,
    `description: ${jsonInlineString(description)}`,
    suggestion.id ? `sourceSuggestionId: ${suggestion.id}` : null,
    `createdAt: ${new Date().toISOString()}`,
    "createdBy: proactive-observer",
    "---",
    ""
  ].filter(Boolean).join("\n");

  writeTextAtomic(skillPath, frontmatter + body + "\n");
  return { slug, path: skillPath };
}

// runtime.skills.dirs is [bundled, userDir?] — bundled is read-only
// (lives under examples/skills in the install), so writes always go to
// the SECOND dir if present. If only bundled is configured, return null.
export function pickUserSkillsDir(runtime) {
  const dirs = runtime?.skills?.dirs ?? [];
  if (dirs.length < 2) return null;
  return dirs[dirs.length - 1];
}

// Conservative slug: lowercase, alnum + hyphen, collapsed, trimmed.
// Cap at 48 chars so directory names stay readable on macOS Finder.
export function slugify(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "untitled-skill";
}

// If `<userDir>/<slug>/` exists, try `<slug>-2`, `<slug>-3`, … until free.
export function dedupeSlug(userDir, slug) {
  let candidate = slug;
  let n = 2;
  while (fs.existsSync(path.join(userDir, candidate))) {
    candidate = `${slug}-${n++}`;
    if (n > 100) throw new Error(`could not dedupe slug after 100 attempts: ${slug}`);
  }
  return candidate;
}

// agentskills.io spec allows up to 1024 chars for description; we
// inline-quote it to handle commas, colons, special chars cleanly.
function jsonInlineString(s) {
  const escaped = String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ")
    .trim();
  return `"${escaped}"`;
}
