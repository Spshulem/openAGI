// Self-update: check + apply against a fake git, covering up-to-date,
// fast-forwardable, diverged, no-upstream, and deps-changed paths.
import assert from "node:assert/strict";
import test from "node:test";
import { checkForUpdate, applyUpdate } from "../src/self-update.js";

// Build a fake `git` runner from a scripted command→output map. Records the
// commands so we can assert what ran (e.g. that a merge happened or didn't).
function fakeGit(responses) {
  const calls = [];
  const run = async (args) => {
    calls.push(args.join(" "));
    const key = args.join(" ");
    for (const [pattern, val] of Object.entries(responses)) {
      if (key.startsWith(pattern)) {
        if (val instanceof Error) throw val;
        return typeof val === "function" ? val() : val;
      }
    }
    throw new Error(`unexpected git: ${key}`);
  };
  return { run, calls };
}

test("checkForUpdate reports behind/available when upstream is ahead", async () => {
  const { run } = fakeGit({
    "rev-parse --abbrev-ref HEAD": "main",
    "rev-parse --short HEAD": "aaaaaaa",
    "rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/main",
    "fetch": "",
    "rev-list --count HEAD..origin/main": "3",
    "rev-list --count origin/main..HEAD": "0",
    "rev-parse --short origin/main": "bbbbbbb"
  });
  const r = await checkForUpdate({ run });
  assert.equal(r.updateAvailable, true);
  assert.equal(r.behind, 3);
  assert.equal(r.canFastForward, true);
  assert.equal(r.latest, "bbbbbbb");
});

test("checkForUpdate: up to date", async () => {
  const { run } = fakeGit({
    "rev-parse --abbrev-ref HEAD": "main",
    "rev-parse --short HEAD": "aaaaaaa",
    "rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/main",
    "fetch": "",
    "rev-list --count HEAD..origin/main": "0",
    "rev-list --count origin/main..HEAD": "0",
    "rev-parse --short origin/main": "aaaaaaa"
  });
  const r = await checkForUpdate({ run });
  assert.equal(r.updateAvailable, false);
});

test("checkForUpdate: no upstream → not available, clear reason", async () => {
  const { run } = fakeGit({
    "rev-parse --abbrev-ref HEAD": "main",
    "rev-parse --short HEAD": "aaaaaaa",
    "rev-parse --abbrev-ref --symbolic-full-name @{u}": new Error("no upstream")
  });
  const r = await checkForUpdate({ run });
  assert.equal(r.updateAvailable, false);
  assert.match(r.reason, /no upstream/);
});

test("applyUpdate fast-forwards and signals what changed (no deps)", async () => {
  const { run, calls } = fakeGit({
    "rev-parse --abbrev-ref HEAD": "main",
    "rev-parse --short HEAD": () => calls.includes("merge --ff-only origin/main") ? "bbbbbbb" : "aaaaaaa",
    "rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/main",
    "fetch": "",
    "rev-list --count HEAD..origin/main": "2",
    "rev-list --count origin/main..HEAD": "0",
    "rev-parse --short origin/main": "bbbbbbb",
    "diff --name-only HEAD origin/main": "src/foo.js\nREADME.md",
    "merge --ff-only origin/main": ""
  });
  let installed = false;
  const r = await applyUpdate({ run, installDeps: async () => { installed = true; } });
  assert.equal(r.updated, true);
  assert.equal(r.to, "bbbbbbb");
  assert.equal(r.depsChanged, false);
  assert.equal(installed, false, "no npm install when package.json didn't change");
  assert.ok(calls.includes("merge --ff-only origin/main"));
});

test("applyUpdate reinstalls deps when package.json changed", async () => {
  const { run } = fakeGit({
    "rev-parse --abbrev-ref HEAD": "main",
    "rev-parse --short HEAD": "ccccccc",
    "rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/main",
    "fetch": "",
    "rev-list --count HEAD..origin/main": "1",
    "rev-list --count origin/main..HEAD": "0",
    "rev-parse --short origin/main": "ddddddd",
    "diff --name-only HEAD origin/main": "package.json\npackage-lock.json\nsrc/x.js",
    "merge --ff-only origin/main": ""
  });
  let installed = false;
  const r = await applyUpdate({ run, installDeps: async () => { installed = true; } });
  assert.equal(r.updated, true);
  assert.equal(r.depsChanged, true);
  assert.equal(installed, true);
});

test("applyUpdate refuses to update a diverged checkout (won't clobber local commits)", async () => {
  const { run, calls } = fakeGit({
    "rev-parse --abbrev-ref HEAD": "main",
    "rev-parse --short HEAD": "aaaaaaa",
    "rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/main",
    "fetch": "",
    "rev-list --count HEAD..origin/main": "2",
    "rev-list --count origin/main..HEAD": "1",   // local is ahead → diverged
    "merge-base HEAD origin/main": "c0mm0n",      // shared ancestor → real local commits
    "rev-parse --short origin/main": "bbbbbbb"
  });
  const r = await applyUpdate({ run, installDeps: async () => {} });
  assert.equal(r.updated, false);
  assert.match(r.reason, /diverg|fast-forward/i);
  assert.ok(!calls.includes("merge --ff-only origin/main"), "must not merge a diverged checkout");
  assert.ok(!calls.some((c) => c.startsWith("reset --hard")), "must not hard-reset a checkout with real local commits");
});

test("applyUpdate recovers from an upstream history rewrite (unrelated + clean tree → hard reset)", async () => {
  let resetTo = null, installed = false;
  const { run, calls } = fakeGit({
    "rev-parse --abbrev-ref HEAD": "main",
    "rev-parse --short HEAD": "0ldhash",
    "rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/main",
    "fetch": "",
    "rev-list --count HEAD..origin/main": "300",  // looks fully behind...
    "rev-list --count origin/main..HEAD": "295",  // ...AND ahead (unrelated histories)
    "merge-base HEAD origin/main": new Error("no merge base"), // ← no shared ancestor
    "rev-parse --short origin/main": "newhash",
    "status --porcelain": "",                      // clean working tree
    "reset --hard origin/main": () => { resetTo = "origin/main"; return ""; }
  });
  const r = await applyUpdate({ run, installDeps: async () => { installed = true; } });
  assert.equal(r.updated, true);
  assert.equal(r.recovered, true, "flagged as a rewrite recovery");
  assert.equal(resetTo, "origin/main", "hard-reset onto upstream");
  assert.ok(installed, "deps reinstalled after recovery");
  assert.ok(!calls.includes("merge --ff-only origin/main"), "recovers via reset, not merge");
});

test("applyUpdate will NOT hard-reset a rewrite if the tree is dirty (protects local edits)", async () => {
  const { run, calls } = fakeGit({
    "rev-parse --abbrev-ref HEAD": "main",
    "rev-parse --short HEAD": "0ldhash",
    "rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/main",
    "fetch": "",
    "rev-list --count HEAD..origin/main": "300",
    "rev-list --count origin/main..HEAD": "295",
    "merge-base HEAD origin/main": new Error("no merge base"),
    "rev-parse --short origin/main": "newhash",
    "status --porcelain": " M src/foo.js"           // uncommitted local change
  });
  const r = await applyUpdate({ run, installDeps: async () => {} });
  assert.equal(r.updated, false);
  assert.match(r.reason, /dirty|resolve manually/i);
  assert.ok(!calls.some((c) => c.startsWith("reset --hard")), "never hard-reset a dirty tree");
});

test("applyUpdate: already up to date is a clean no-op", async () => {
  const { run } = fakeGit({
    "rev-parse --abbrev-ref HEAD": "main",
    "rev-parse --short HEAD": "aaaaaaa",
    "rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/main",
    "fetch": "",
    "rev-list --count HEAD..origin/main": "0",
    "rev-list --count origin/main..HEAD": "0",
    "rev-parse --short origin/main": "aaaaaaa"
  });
  const r = await applyUpdate({ run, installDeps: async () => {} });
  assert.equal(r.updated, false);
  assert.match(r.reason, /up to date/i);
});
