// Guided setup handoff: scripts/setup-agent.sh + skills/openagi-setup.
//
// Runs the real POSIX script against a throwaway HOME with fake `claude` and
// `codex` binaries that only record how they were launched. Covers: fresh
// install, rerun, a changed skill (no silent overwrite), no agent installed,
// both provider paths, declining, a terminal-less run, a failed download, and
// that no secret ever reaches the prompt, the handoff file, or the output.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(REPO, "scripts", "setup-agent.sh");
const SKILL_DIR = path.join(REPO, "skills", "openagi-setup");
const SKILL_FILES = ["SKILL.md", "adapters/claude-code.md", "adapters/codex.md", "adapters/manual.md"];
const SECRET = "oa-test-secret-4f1c9e7a2b";
const BYPASS_FLAGS = /--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|--full-auto|--yolo|bypassPermissions|--permission-mode/;

function sandbox(t, { agents = ["claude", "codex"] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oa-setup-agent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  fs.mkdirSync(bin); fs.mkdirSync(home);
  for (const name of agents) {
    fs.writeFileSync(path.join(bin, name),
      '#!/bin/sh\n{ printf "agent=%s\\n" "$(basename "$0")"; printf "cwd=%s\\n" "$PWD"; for x in "$@"; do printf "arg=%s\\n" "$x"; done; } >> "$FAKE_LOG"\n',
      { mode: 0o755 });
  }
  const log = path.join(root, "agent.log");
  const run = (args = [], { answers = null, script = SCRIPT, extraEnv = {} } = {}) => {
    const tty = path.join(root, "tty");
    if (answers !== null) fs.writeFileSync(tty, answers);
    const res = spawnSync("sh", [script, ...args], {
      encoding: "utf8",
      env: {
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        FAKE_LOG: log,
        OPENAGI_SETUP_TTY: answers === null ? path.join(root, "no-tty") : tty,
        // Secrets present in the environment must never be forwarded anywhere.
        OPENAGI_AUTH_TOKEN: SECRET,
        ANTHROPIC_API_KEY: `sk-ant-${SECRET}`,
        OPENAI_API_KEY: `sk-${SECRET}`,
        ...extraEnv
      }
    });
    const launches = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
    fs.rmSync(log, { force: true });
    return { ...res, out: `${res.stdout}${res.stderr}`, launches };
  };
  return {
    root, home, run,
    claudeSkill: path.join(home, ".claude", "skills", "openagi-setup"),
    codexSkill: path.join(home, ".codex", "skills", "openagi-setup"),
    handoff: path.join(home, ".openagi-setup", "HANDOFF.md")
  };
}

function assertNoSecret(...texts) {
  for (const text of texts) assert.doesNotMatch(text, new RegExp(SECRET), "a secret leaked");
}

function assertSkillMatchesRepo(dir) {
  for (const f of SKILL_FILES) {
    assert.equal(fs.readFileSync(path.join(dir, f), "utf8"), fs.readFileSync(path.join(SKILL_DIR, f), "utf8"), f);
  }
}

test("fresh install without a terminal installs nothing, launches nothing, prints the manual path", (t) => {
  const s = sandbox(t);
  const r = s.run(["--install-mode", "mac"]);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.launches, "");
  assert.ok(!fs.existsSync(s.claudeSkill) && !fs.existsSync(s.codexSkill), "no skill without an explicit yes");
  assert.match(r.out, /Finish setup by hand/);
  assert.match(r.out, /127\.0\.0\.1:43210\/setup/);
  const handoff = fs.readFileSync(s.handoff, "utf8");
  assert.match(handoff, /Install mode: mac/);
  assert.match(handoff, /OpenAGI\.app\/Contents\/Resources\/openAGI\/bin\/openagi\.js/);
  assertNoSecret(r.out, handoff);
});

test("Claude Code path: explicit yes installs the skill and opens claude with paths only", (t) => {
  const s = sandbox(t, { agents: ["claude"] });
  const r = s.run(["--install-mode", "systemd", "--install-dir", "/opt/openagi"], { answers: "y\ny\n" });
  assert.equal(r.status, 0, r.out);
  assertSkillMatchesRepo(s.claudeSkill);
  assert.ok(!fs.existsSync(s.codexSkill));
  const lines = r.launches.trim().split("\n");
  assert.equal(lines[0], "agent=claude");
  assert.equal(lines[1], `cwd=${path.join(s.home, ".openagi-setup")}`, "opens in the handoff folder, not $HOME or the data dir");
  const args = lines.filter((l) => l.startsWith("arg="));
  assert.equal(args.length, 1, "exactly one argument: the prompt");
  assert.match(args[0], new RegExp(`${s.claudeSkill}/SKILL\\.md`));
  assert.match(args[0], /adapters\/claude-code\.md/);
  assert.match(args[0], /HANDOFF\.md/);
  assert.match(args[0], /Never ask me for an API key or token/);
  assert.doesNotMatch(r.launches, BYPASS_FLAGS);
  assertNoSecret(r.out, r.launches, fs.readFileSync(s.handoff, "utf8"));
});

test("Codex path: flags select codex, install to ~/.codex/skills and launch without bypass flags", (t) => {
  const s = sandbox(t);
  const r = s.run(["--agent", "codex", "--launch", "--install-mode", "docker"]);
  assert.equal(r.status, 0, r.out);
  assertSkillMatchesRepo(s.codexSkill);
  assert.ok(!fs.existsSync(s.claudeSkill));
  assert.match(r.launches, /^agent=codex$/m);
  assert.match(r.launches, /adapters\/codex\.md/);
  assert.doesNotMatch(r.launches, BYPASS_FLAGS);
  const handoff = fs.readFileSync(s.handoff, "utf8");
  assert.match(handoff, /docker exec openagi node bin\/openagi\.js/);
  assert.match(handoff, /Do not ask for it/);
  assertNoSecret(r.out, r.launches, handoff);
});

test("CODEX_HOME is respected for the Codex skill location", (t) => {
  const s = sandbox(t);
  const codexHome = path.join(s.root, "codex-home");
  const r = s.run(["--agent", "codex", "--install"], { extraEnv: { CODEX_HOME: codexHome } });
  assert.equal(r.status, 0, r.out);
  assertSkillMatchesRepo(path.join(codexHome, "skills", "openagi-setup"));
  assert.equal(r.launches, "", "--install alone never launches");
});

test("both agents present: choosing both installs two skills and launches neither", (t) => {
  const s = sandbox(t);
  const r = s.run([], { answers: "3\n" });
  assert.equal(r.status, 0, r.out);
  assertSkillMatchesRepo(s.claudeSkill);
  assertSkillMatchesRepo(s.codexSkill);
  assert.equal(r.launches, "");
  assert.match(r.out, /cd .*\.openagi-setup && claude/);
  assert.match(r.out, /cd .*\.openagi-setup && codex/);
});

test("declining (or just pressing Enter) changes nothing", (t) => {
  const s = sandbox(t, { agents: ["claude"] });
  for (const answers of ["n\n", "\n"]) {
    const r = s.run([], { answers });
    assert.equal(r.status, 0, r.out);
    assert.ok(!fs.existsSync(s.claudeSkill), `answer ${JSON.stringify(answers)} must not install`);
    assert.equal(r.launches, "");
    assert.match(r.out, /Finish setup by hand/);
  }
});

test("installing but declining the launch leaves the agent closed with a next step", (t) => {
  const s = sandbox(t, { agents: ["claude"] });
  const r = s.run([], { answers: "y\nn\n" });
  assert.equal(r.status, 0, r.out);
  assertSkillMatchesRepo(s.claudeSkill);
  assert.equal(r.launches, "");
  assert.match(r.out, /cd .*\.openagi-setup && claude/);
});

test("no coding agent on PATH: manual path, exit 0, no agent folders created", (t) => {
  const s = sandbox(t, { agents: [] });
  const r = s.run([], { answers: "y\ny\n" });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /No Claude Code or Codex CLI found/);
  assert.match(r.out, /adapters\/manual\.md/);
  assert.ok(!fs.existsSync(path.join(s.home, ".claude")) && !fs.existsSync(path.join(s.home, ".codex")));
  assert.ok(fs.existsSync(path.join(s.home, ".openagi-setup", "skill", "adapters", "manual.md")));
});

test("asking for a missing agent by name falls back to manual instead of failing", (t) => {
  const s = sandbox(t, { agents: ["codex"] });
  const r = s.run(["--agent", "claude", "--launch"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Claude Code \(claude\) isn't on PATH/);
  assert.equal(r.launches, "");
  assert.ok(!fs.existsSync(s.claudeSkill));
});

test("rerun is idempotent: an identical skill is reported current and left untouched", (t) => {
  const s = sandbox(t);
  assert.equal(s.run(["--agent", "claude", "--install"]).status, 0);
  const stamp = new Date("2020-01-01T00:00:00Z");
  fs.utimesSync(path.join(s.claudeSkill, "SKILL.md"), stamp, stamp);
  const r = s.run(["--agent", "claude", "--install"]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /already installed and current \(v\d+\.\d+\.\d+\)/);
  assert.equal(fs.statSync(path.join(s.claudeSkill, "SKILL.md")).mtime.getTime(), stamp.getTime(), "not rewritten");
  assert.deepEqual(fs.readdirSync(path.dirname(s.claudeSkill)), ["openagi-setup"], "no backup for an identical skill");
});

test("a different existing skill is never overwritten silently; --force keeps a backup", (t) => {
  const s = sandbox(t);
  fs.mkdirSync(path.join(s.claudeSkill, "adapters"), { recursive: true });
  const custom = "---\nname: openagi-setup\nmetadata:\n  version: 0.9.0\n---\nmy edits\n";
  fs.writeFileSync(path.join(s.claudeSkill, "SKILL.md"), custom);

  const noTty = s.run(["--agent", "claude", "--install"]);
  assert.equal(noTty.status, 0, noTty.out);
  assert.match(noTty.out, /v0\.9\.0; this one is v1\.0\.0/);
  assert.match(noTty.out, /Left it unchanged/);
  assert.equal(fs.readFileSync(path.join(s.claudeSkill, "SKILL.md"), "utf8"), custom);

  const declined = s.run(["--agent", "claude", "--install"], { answers: "n\n" });
  assert.match(declined.out, /Left it unchanged/);
  assert.equal(fs.readFileSync(path.join(s.claudeSkill, "SKILL.md"), "utf8"), custom);

  const forced = s.run(["--agent", "claude", "--install", "--force"]);
  assert.equal(forced.status, 0, forced.out);
  assertSkillMatchesRepo(s.claudeSkill);
  const backups = fs.readdirSync(path.dirname(s.claudeSkill)).filter((n) => n.startsWith("openagi-setup.bak-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(s.claudeSkill), backups[0], "SKILL.md"), "utf8"), custom);
});

test("standalone script with no reachable skill source degrades to the browser path", (t) => {
  const s = sandbox(t);
  const lone = path.join(s.root, "lone");
  fs.mkdirSync(lone);
  fs.copyFileSync(SCRIPT, path.join(lone, "setup-agent.sh"));
  const r = s.run(["--agent", "claude", "--launch"], {
    script: path.join(lone, "setup-agent.sh"),
    extraEnv: { OPENAGI_SKILL_BASE_URL: "https://127.0.0.1:9/skills/openagi-setup" }
  });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Guided setup files are unavailable/);
  assert.match(r.out, /127\.0\.0\.1:43210\/setup/);
  assert.equal(r.launches, "");
  assert.ok(!fs.existsSync(s.claudeSkill));
});

test("OPENAGI_NONINTERACTIVE=1 never prompts even when a terminal is available", (t) => {
  const s = sandbox(t);
  const r = s.run([], { answers: "1\ny\n", extraEnv: { OPENAGI_NONINTERACTIVE: "1" } });
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /Use which agent\?/);
  assert.equal(r.launches, "");
  assert.ok(!fs.existsSync(s.claudeSkill));
});

// --- the skill content itself ------------------------------------------------

test("skill files are versioned, discoverable, and carry the safety rules", () => {
  const skill = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
  const front = /^---\n([\s\S]*?)\n---\n/.exec(skill);
  assert.ok(front, "SKILL.md needs YAML frontmatter");
  assert.match(front[1], /^name: openagi-setup$/m);
  assert.match(front[1], /^description: .{40,}/m);
  const version = /^\s+version: (\d+\.\d+\.\d+)$/m.exec(front[1])?.[1];
  assert.ok(version, "frontmatter metadata.version must be semver");
  assert.ok(skill.includes(`Skill version: ${version}`), "body version must match frontmatter");
  for (const step of ["Prerequisites", "Sign in through the local CLI", "Configure", "Smoke test", "Recovery"]) {
    assert.ok(skill.includes(step), `SKILL.md missing section: ${step}`);
  }
  assert.match(skill, /openagi-setup-ok/);
  assert.match(skill, /provider use claude-cli/);
  assert.match(skill, /provider use codex-cli/);
  for (const f of SKILL_FILES) assert.ok(fs.existsSync(path.join(SKILL_DIR, f)), f);
});

test("skill files contain no credentials and only mention bypass flags to forbid them", () => {
  for (const f of SKILL_FILES) {
    const text = fs.readFileSync(path.join(SKILL_DIR, f), "utf8");
    assert.doesNotMatch(text, /sk-(ant-)?[A-Za-z0-9_-]{16,}|\b[a-f0-9]{48,}\b|ghp_[A-Za-z0-9]{20,}|token=[A-Za-z0-9]/, `${f} looks like it holds a credential`);
    for (const line of text.split("\n").filter((l) => BYPASS_FLAGS.test(l))) {
      assert.match(line, /\b(not|Never|never|Do not|don't)\b/, `${f}: bypass flag mentioned without a prohibition: ${line}`);
    }
  }
});

test("install.sh offers the handoff only as an opt-in and never auto-approves", () => {
  const install = fs.readFileSync(path.join(REPO, "scripts", "install.sh"), "utf8");
  const call = install.indexOf("\noffer_agent_setup\n");
  assert.ok(call > install.indexOf("# --- main ---"), "the offer runs after the install itself");
  assert.ok(call > install.lastIndexOf("esac"), "the offer runs after the summary (sign-in URL) is printed");
  const fn = /offer_agent_setup\(\) \{([\s\S]*?)\n\}/.exec(install)?.[1] ?? "";
  assert.match(fn, /OPENAGI_AGENT_SETUP:-ask/);
  assert.match(fn, /setup-agent\.sh/);
  assert.match(fn, /\|\| true/, "a failed handoff must never fail the install");
  assert.doesNotMatch(fn, /--install(?![-\w])|--launch|--force|--yes/, "the installer must not pre-answer the opt-in");
  assert.doesNotMatch(fn, /AUTH_TOKEN/, "no token goes to the handoff");
  assert.match(fn, /--proto '=https'/);
});

test("the manual path tells the person how to come back later", (t) => {
  const s = sandbox(t, { agents: [] });
  const local = s.run([]);
  assert.match(local.out, new RegExp(`sh ${SCRIPT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const downloaded = s.run(["--from-download"]);
  assert.match(downloaded.out, /curl -fsSL https:\/\/raw\.githubusercontent\.com\/Spshulem\/openAGI\/main\/scripts\/setup-agent\.sh -o setup-agent\.sh && sh setup-agent\.sh/);
});
