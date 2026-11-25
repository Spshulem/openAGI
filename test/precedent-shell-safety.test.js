// The precedent engine auto-approves shell permissions it can prove are
// read-only inspection or an isolated feature-worktree commit. Each case
// below is a reviewer's bypass fixture (#332) that must now need the owner.
import assert from "node:assert/strict";
import test from "node:test";
import { OwnerPrecedentStore, isSafeLocalWorktreeCommitCommand, isSafeReadOnlyCommand } from "../src/fleet/precedent-memory.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("read-only rule refuses mutating options, hidden newline commands, and path executables", () => {
  for (const cmd of [
    "sort -o src/index.js README.md",
    "sort -uo out.txt in.txt",
    "sort --output=out.txt in.txt",
    "sort --compress-program=sh big.txt",
    "uniq in.txt out.txt",
    "rg --pre ./evil.sh foo",
    "file -C -m magic",
    "tail -F log.txt",
    "cat README.md\ntouch review-marker",
    "cat README.md\rtouch review-marker",
    "./scripts/cat README.md",
    "/tmp/x/cat README.md",
    "sed -n '1w out.txt' README.md",
    "sed -n '1e touch x' README.md",
    "sed -n -f script.sed README.md",
    "git -C /tmp/other log",
    "git -c core.pager=sh log",
    "git diff --output=patch.txt",
    "git grep -O vim foo",
    "git diff --ext-diff",
    "find . -fprint0 out",
    "echo \\'; touch /tmp/marker; echo \\'",
    "cat a\\;touch b"
  ]) {
    assert.equal(isSafeReadOnlyCommand(cmd), false, cmd);
  }
  for (const cmd of [
    "rg -n \"AppFolio\" src/",
    "sort -u names.txt",
    "uniq -c names.txt",
    "cat README.md && wc -l README.md",
    "sed -n '1,20p' README.md",
    "sed -n -e '/start/,/end/p' notes.md",
    "git log --oneline -5",
    "git diff --stat main",
    "tail -n 50 log.txt",
    "printf 'a\\nb'"
  ]) {
    assert.equal(isSafeReadOnlyCommand(cmd), true, cmd);
  }
});

test("worktree commit rule refuses commits aimed at another repository", () => {
  const thread = { branch: "spencer/feature", cwd: "/work/worktrees/feature" };
  assert.equal(isSafeLocalWorktreeCommitCommand("git -C /tmp/other-repo add . && git -C /tmp/other-repo commit -m update", thread), false);
  assert.equal(isSafeLocalWorktreeCommitCommand("git --git-dir=/tmp/o/.git commit -m x", thread), false);
  assert.equal(isSafeLocalWorktreeCommitCommand("git --work-tree=/tmp/o add .", thread), false);
  assert.equal(isSafeLocalWorktreeCommitCommand("./git add . && ./git commit -m x", thread), false);
  assert.equal(isSafeLocalWorktreeCommitCommand("git add src/a.js && git commit -m \"fix\"", thread), true);
});

test("a truncated or excerpt-only permission command is never approved by rule", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prec-trunc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new OwnerPrecedentStore({ dir });
  const question = { kind: "prompt", title: "Bash permission", body: "Run `cat README.md`", options: ["Allow", "Deny"] };
  const longCat = `cat ${"README.md ".repeat(27)}&& touch /tmp/marker`;
  const truncated = await store.evaluateCandidate({
    question,
    thread: { key: "paseo:s.a", meta: { pendingPermission: { command: longCat.slice(0, 239) + "…", rawCommand: longCat.slice(0, 200), rawCommandTruncated: true } } }
  });
  assert.notEqual(truncated.precedentId, "prec_readonly_bash");
  const bodyOnly = await store.evaluateCandidate({ question, thread: { key: "paseo:s.b", meta: {} } });
  assert.notEqual(bodyOnly.precedentId, "prec_readonly_bash", "the question text is not the command");
  const full = await store.evaluateCandidate({
    question,
    thread: { key: "paseo:s.c", meta: { pendingPermission: { rawCommand: "cat README.md" } } }
  });
  assert.equal(full.matched, true);
  assert.equal(full.precedentId, "prec_readonly_bash");
});
