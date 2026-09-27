import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_PLAYBOOKS_DIR, loadPlaybooks, parsePlaybookText, renderTemplate } from "../src/fleet/playbooks.js";
import { SkillRegistry } from "../src/skills.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = path.join(repoRoot, "examples", "skills", "fleet-supervisor");

const EXPECTED_IDS = [
  "resume", "merge-ready", "ci-finished", "no-local-verify", "in-scope-yes",
  "bb3-slow-agent", "infra-recovered", "manager-bb3", "manager-lb"
];

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("renderTemplate fills placeholders, blanks missing ones, and collapses spaces", () => {
  assert.equal(renderTemplate("#{pr} stuck. {blocker}. Help?", { pr: "6522", blocker: "CI red: verification" }), "#6522 stuck. CI red: verification. Help?");
  assert.equal(renderTemplate("a {missing} b", {}), "a b");
  assert.equal(renderTemplate("line one {x}\n\n\n\nline two", { x: "" }), "line one\n\nline two");
  // Only own properties are placeholders; prototype names never leak in.
  assert.equal(renderTemplate("x{constructor}y{toString}z", {}), "xyz");
  // Values are inserted once; a value that looks like a placeholder is not re-expanded.
  assert.equal(renderTemplate("{a}", { a: "{b}", b: "nope" }), "{b}");
});

test("parsePlaybookText reads flat frontmatter and body", () => {
  const playbook = parsePlaybookText([
    "---",
    "id: merge-ready",
    "cooldown_min: 12",
    "max_attempts: 3",
    "ask: \"#{pr} stuck. {blocker}. Help?\"",
    "---",
    "Ready to merge? {blockers}",
    ""
  ].join("\n"), "fallback");
  assert.deepEqual(playbook, {
    id: "merge-ready", body: "Ready to merge? {blockers}", cooldownMin: 12, maxAttempts: 3, ask: "#{pr} stuck. {blocker}. Help?"
  });
  const bare = parsePlaybookText("Just a body.", "plain");
  assert.equal(bare.id, "plain");
  assert.equal(bare.cooldownMin, null);
  assert.equal(bare.maxAttempts, null);
  assert.equal(bare.ask, "");
  assert.equal(parsePlaybookText("---\nid: empty\n---\n", "x"), null);
});

test("loadPlaybooks lets a user file override the bundled one and never throws", () => {
  const bundled = tmpDir("fleet-pb-bundled-");
  const user = tmpDir("fleet-pb-user-");
  fs.writeFileSync(path.join(bundled, "resume.md"), "---\nid: resume\ncooldown_min: 12\n---\nbundled resume\n");
  fs.writeFileSync(path.join(bundled, "merge-ready.md"), "---\nid: merge-ready\n---\nbundled merge\n");
  fs.writeFileSync(path.join(bundled, "notes.txt"), "ignored");
  fs.writeFileSync(path.join(user, "resume.md"), "---\nid: resume\ncooldown_min: 20\nmax_attempts: 5\n---\nmy resume words\n");
  const playbooks = loadPlaybooks({ bundledDir: bundled, userDir: user });
  assert.deepEqual([...playbooks.keys()].sort(), ["merge-ready", "resume"]);
  assert.equal(playbooks.get("resume").body, "my resume words");
  assert.equal(playbooks.get("resume").cooldownMin, 20);
  assert.equal(playbooks.get("resume").maxAttempts, 5);
  assert.equal(playbooks.get("merge-ready").body, "bundled merge");

  const missing = loadPlaybooks({ bundledDir: path.join(bundled, "nope"), userDir: path.join(user, "nope") });
  assert.equal(missing.size, 0);
});

test("bundled playbooks cover every policy template and render cleanly", () => {
  const playbooks = loadPlaybooks({ bundledDir: BUNDLED_PLAYBOOKS_DIR });
  for (const id of EXPECTED_IDS) {
    const playbook = playbooks.get(id);
    assert.ok(playbook, `missing playbook ${id}`);
    assert.ok(playbook.body.length > 20, `${id} body too short`);
    assert.ok(playbook.cooldownMin > 0, `${id} needs cooldown_min`);
    assert.ok(playbook.maxAttempts > 0, `${id} needs max_attempts`);
    const vars = {
      pr: "6522", prRef: "acme/app#6522", repo: "acme/app", head: "abc1234567", blockers: "CI red: verification",
      blocker: "CI red: verification", ci: "fail (verification)", reset: "Sep 28, 10:00 AM", thread: "madrid",
      label: "madrid #6522", attempts: "3", age: "42", what: "BuildBot3", problems: "gate blocked 40m",
      gate: "blocked", queue: "full 10, quick 1", load: "392/390/380", runs: "#6874 full 139m", timers: "none",
      waiting: "", watch: ""
    };
    const rendered = renderTemplate(playbook.body, vars);
    assert.doesNotMatch(rendered, /\{[A-Za-z_]+\}/, `${id} body has an unknown placeholder`);
    assert.doesNotMatch(renderTemplate(playbook.ask, vars), /\{[A-Za-z_]+\}/, `${id} ask has an unknown placeholder`);
    assert.ok(renderTemplate(playbook.ask, vars).length <= 100, `${id} ask must fit a 100-char title`);
  }
  // Policy says these never ping the owner.
  for (const id of ["no-local-verify", "in-scope-yes", "bb3-slow-agent"]) assert.equal(playbooks.get(id).ask, "");
  assert.match(playbooks.get("merge-ready").ask, /#\{pr\} stuck/);
});

test("fleet-supervisor SKILL.md loads through the skill registry and stays short", () => {
  const registry = new SkillRegistry({ dirs: [path.join(repoRoot, "examples", "skills")] });
  const skill = registry.skills.get("fleet-supervisor");
  assert.ok(skill, "skill did not load");
  assert.ok(skill.description.length > 20 && skill.description.length <= 1024);
  assert.doesNotMatch(skill.description, /\n/);
  const lines = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8").split("\n");
  assert.ok(lines.length <= 120, `SKILL.md is ${lines.length} lines`);
  for (const word of ["observe", "propose", "auto", "codex-exec", "peer-relay", "claude-resume", "manager", "owner"]) {
    assert.match(skill.body, new RegExp(word), `SKILL.md should mention ${word}`);
  }
  // Playbook files are templates, not skills of their own.
  assert.equal(registry.skills.has("merge-ready"), false);
});
