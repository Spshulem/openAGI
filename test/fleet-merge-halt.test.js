import test from "node:test";
import assert from "node:assert/strict";
import { executeSafePrMerge } from "../src/fleet/intent-resolver.js";
import { GithubThrottle } from "../src/fleet/github-throttle.js";

// Incident tw_d9544149a037e8c1, 2026-11-22: #321 merged into main at
// 21:13:31Z; the owner's Merge on #345 two seconds later read
// mergeable/mergeStateStatus UNKNOWN (GitHub recomputing against the new
// base) and was halted as "blocked by branch protection, unposted checks, or
// required reviews (UNKNOWN)". At 21:15Z the same PR was CLEAN and merged.
const HEAD = "8c90051079464a801674d9446116805087c4acdd";
const PR = "Spshulem/openAGI#345";
const base = {
  state: "OPEN", isDraft: false, headRefOid: HEAD, reviewDecision: "",
  statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }], url: "https://github.com/Spshulem/openAGI/pull/345"
};
const UNKNOWN = { ...base, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" };
const CLEAN = { ...base, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" };

// views: what each successive `gh pr view` answers; merge: the merge's answer.
function gh({ views, merge = { code: 0, stdout: "Merged", stderr: "" } }) {
  const calls = [];
  let read = 0;
  const run = async (bin, args) => {
    calls.push(args.join(" "));
    if (args[1] === "view") {
      const v = views[Math.min(read, views.length - 1)];
      read += 1;
      return typeof v === "function" ? v() : { code: 0, stdout: JSON.stringify(v), stderr: "" };
    }
    if (args[1] === "merge") return merge;
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  return { run, calls, views: () => calls.filter((c) => c.startsWith("pr view")).length, merges: () => calls.filter((c) => c.startsWith("pr merge")) };
}

function merge(stub, extra = {}) {
  const slept = [];
  return executeSafePrMerge({
    prRef: PR, expectedHeadSha: HEAD, ownerConfirmed: true, mergePolicy: "manual_confirm",
    run: stub.run, throttle: new GithubThrottle(), sleep: async (ms) => { slept.push(ms); }, ...extra
  }).then((out) => ({ out, slept }));
}

test("UNKNOWN right after another merge is read again, and merges once GitHub settles", async () => {
  const stub = gh({ views: [UNKNOWN, CLEAN] });
  const { out, slept } = await merge(stub);
  assert.equal(out.status, "merged");
  assert.deepEqual(slept, [2_000]);
  assert.equal(stub.views(), 2);
  assert.equal(stub.merges().length, 1);
  assert.match(stub.merges()[0], new RegExp(`--match-head-commit ${HEAD}`));
  assert.doesNotMatch(stub.merges()[0], /--admin/);
});

test("still UNKNOWN after the bounded re-reads is a transient halt, never called branch protection", async () => {
  const stub = gh({ views: [UNKNOWN] });
  const { out, slept } = await merge(stub);
  assert.equal(out.status, "halted");
  assert.equal(out.reason, "mergeability_unknown");
  assert.equal(out.haltClass, "transient");
  assert.equal(out.mergeConfirmed, false);
  assert.deepEqual(slept, [2_000, 4_000]);
  assert.equal(stub.views(), 3);
  assert.deepEqual(stub.merges(), [], "fail closed: no merge on a state the preflight never saw");
  assert.match(out.detail, /^Not merged: Spshulem\/openAGI#345\./);
  assert.match(out.detail, /No branch rule or check failure was reported/);
  assert.doesNotMatch(out.detail, /blocked by branch protection/);
});

test("a re-read that changes the head halts on the new head, not on the old read", async () => {
  const stub = gh({ views: [UNKNOWN, { ...CLEAN, headRefOid: "f".repeat(40) }] });
  const { out } = await merge(stub);
  assert.equal(out.reason, "head_changed");
  assert.deepEqual(stub.merges(), []);
});

test("a confirmed BLOCKED is a policy halt that names what GitHub reported", async () => {
  const stub = gh({ views: [{ ...base, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", reviewDecision: "CHANGES_REQUESTED" }] });
  const { out, slept } = await merge(stub);
  assert.equal(out.reason, "blocked");
  assert.equal(out.haltClass, "policy");
  assert.deepEqual(slept, [], "a decided state is not re-read");
  assert.match(out.detail, /BLOCKED by its branch rules \(review decision: CHANGES_REQUESTED; mergeable: MERGEABLE\)/);
  assert.deepEqual(stub.merges(), []);
});

test("UNSTABLE is its own halt", async () => {
  const stub = gh({ views: [{ ...base, mergeable: "MERGEABLE", mergeStateStatus: "UNSTABLE" }] });
  const { out } = await merge(stub);
  assert.equal(out.reason, "checks_unstable");
  assert.deepEqual(stub.merges(), []);
});

test("a re-read GitHub cannot answer stays an unknown halt, with nothing merged", async () => {
  const stub = gh({ views: [UNKNOWN, () => ({ code: 1, stdout: "", stderr: "HTTP 502" })] });
  const { out } = await merge(stub);
  assert.equal(out.reason, "github_unreachable");
  assert.equal(out.haltClass, "unknown");
  assert.equal(out.mergeConfirmed, false);
  assert.deepEqual(stub.merges(), []);
});

test("a merge gh reports as failed but GitHub shows merged at the reviewed head is reconciled, not retried", async () => {
  const stub = gh({ views: [CLEAN, { ...CLEAN, state: "MERGED" }], merge: { code: 1, stdout: "", stderr: "context deadline exceeded" } });
  const { out } = await merge(stub);
  assert.equal(out.status, "merged");
  assert.equal(out.reconciled, true);
  assert.equal(stub.merges().length, 1);
});

test("a merge GitHub refused, still open, says so and confirms nothing", async () => {
  const stub = gh({ views: [CLEAN, CLEAN], merge: { code: 1, stdout: "", stderr: "GraphQL: Pull request is not mergeable" } });
  const { out } = await merge(stub);
  assert.equal(out.reason, "gh_merge_failed");
  assert.equal(out.haltClass, "refused");
  assert.equal(out.mergeConfirmed, false);
  assert.match(out.detail, /not mergeable/);
  assert.equal(stub.merges().length, 1);
});

test("merged by someone else at another head is not reported as this merge", async () => {
  const stub = gh({ views: [CLEAN, { ...CLEAN, state: "MERGED", headRefOid: "e".repeat(40) }], merge: { code: 1, stdout: "", stderr: "timeout" } });
  const { out } = await merge(stub);
  assert.equal(out.status, "halted");
  assert.equal(out.mergeConfirmed, false);
  assert.match(out.detail, /not the reviewed head/);
});
