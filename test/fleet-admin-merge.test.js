// Admin Merge: the owner's deliberate, separate path that waives only the
// required review through GitHub's own --admin bypass. Every GitHub call is
// a mock; nothing here can reach a real repository.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { FleetSupervisor } from "../src/fleet/supervisor.js";
import { createFleetRoute } from "../src/fleet/routes.js";
import { createFleetCapability } from "../src/fleet/remote.js";
import { isMobileRouteAllowed } from "../src/mobile-node.js";
import { executeAdminMerge, executeSafePrMerge, preflightAdminMerge } from "../src/fleet/intent-resolver.js";
import { registerFleetTools } from "../src/fleet/tools.js";
import { ToolRegistry } from "../src/tool-registry.js";

const REPO = "acme/webapp";
const PR = `${REPO}#42`;
const SHA = "0123456789abcdef0123456789abcdef01234567";
const NEW_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const DENIAL = "GraphQL: Repository rule violations found\n\nYou're not authorized to bypass the required review on this branch. (mergePullRequest)";

// A fake `gh`. view/checks/rules/protection/threads/user/merge are each
// overridable; every call is recorded.
function fakeGh(over = {}) {
  const calls = [];
  const view = {
    state: "OPEN",
    isDraft: false,
    mergeStateStatus: "BLOCKED",
    mergeable: "MERGEABLE",
    reviewDecision: "REVIEW_REQUIRED",
    headRefOid: SHA,
    baseRefName: "main",
    statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
    url: `https://github.com/${REPO}/pull/42`,
    title: "Add widget",
    ...(over.view ?? {})
  };
  const run = async (bin, args) => {
    calls.push([bin, ...args]);
    const [a, b] = args;
    if (a === "pr" && b === "view") return { code: 0, stdout: JSON.stringify(view), stderr: "" };
    if (a === "pr" && b === "checks") {
      return over.checks ?? { code: 0, stdout: JSON.stringify([{ name: "test", state: "SUCCESS", bucket: "pass" }]), stderr: "" };
    }
    if (a === "api" && b === "graphql") {
      return over.threads ?? { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { totalCount: 0, nodes: [] } } } } }), stderr: "" };
    }
    if (a === "api" && b === "user") return { code: 0, stdout: "owner-login\n", stderr: "" };
    const page = Number(/[?&]page=(\d+)/.exec(b ?? "")?.[1] ?? 0);
    if (a === "api" && /\/rules\/branches\//.test(b)) {
      if (over.rulesPage) return { code: 0, stdout: JSON.stringify(over.rulesPage(page)), stderr: "" };
      const rules = over.rules ?? [{ type: "pull_request", parameters: { required_approving_review_count: 1 } }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "test", integration_id: 15368 }] } }, { type: "deletion" }];
      return { code: 0, stdout: JSON.stringify(page === 1 ? rules : []), stderr: "" };
    }
    if (a === "api" && /\/commits\/[0-9a-f]+\/check-runs/.test(b)) {
      const runs = over.checkRuns ?? [{ id: 1, name: "test", status: "completed", conclusion: "success", app: { id: 15368 } }];
      return { code: 0, stdout: JSON.stringify({ total_count: runs.length, check_runs: page === 1 ? runs : [] }), stderr: "" };
    }
    if (a === "api" && /\/pulls\/\d+\/commits/.test(b)) {
      const commits = over.prCommits ?? [{ sha: SHA, commit: { verification: { verified: true, reason: "valid" } } }];
      return { code: 0, stdout: JSON.stringify(page === 1 ? commits : []), stderr: "" };
    }
    if (a === "api" && /\/commits\/[0-9a-f]+\/status/.test(b)) {
      return { code: 0, stdout: JSON.stringify({ state: "success", statuses: page === 1 ? (over.statuses ?? []) : [] }), stderr: "" };
    }
    if (a === "api" && /\/protection$/.test(b)) {
      if (over.protection) return { code: 0, stdout: JSON.stringify(over.protection), stderr: "" };
      return { code: 1, stdout: JSON.stringify({ message: "Branch not protected", status: "404" }), stderr: "gh: Branch not protected (HTTP 404)" };
    }
    if (a === "pr" && b === "merge") {
      if (!args.includes("--admin")) return over.plainMerge ?? { code: 1, stdout: "", stderr: "plain merge not expected" };
      return over.adminMerge ?? { code: 0, stdout: "✓ Squashed and merged pull request #42", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  return { run, calls, merges: () => calls.filter((c) => c[1] === "pr" && c[2] === "merge"), view };
}

const consentFor = (headSha = SHA, extra = {}) => ({ action: "admin_merge", repo: REPO, number: 42, headSha, baseRef: "main", ...extra });

// ─── resolver ────────────────────────────────────────────────────────────

test("Admin Merge preflight is read-only and names exactly the required review as the one waiver", async () => {
  const gh = fakeGh();
  const pre = await preflightAdminMerge({ prRef: PR, run: gh.run });
  assert.equal(pre.ok, true);
  assert.equal(pre.plan.action, "admin_merge");
  assert.equal(pre.plan.repo, REPO);
  assert.equal(pre.plan.number, 42);
  assert.equal(pre.plan.headSha, SHA);
  assert.equal(pre.plan.githubLogin, "owner-login");
  assert.deepEqual(pre.plan.waives.map((w) => w.rule), ["required_review"]);
  assert.match(pre.plan.waives[0].detail, /REVIEW_REQUIRED/);
  assert.ok(pre.plan.stillEnforced.some((line) => /Required checks passing/.test(line)));
  assert.equal(pre.plan.command, `gh pr merge 42 --repo ${REPO} --admin --squash --match-head-commit ${SHA}`);
  assert.equal(gh.merges().length, 0, "preview never merges");
});

test("Admin Merge runs one gh pr merge --admin bound to the consented head and reports GitHub's answer", async () => {
  const gh = fakeGh();
  const out = await executeAdminMerge({ prRef: PR, consent: consentFor(), run: gh.run });
  assert.equal(out.status, "merged");
  assert.equal(out.adminOverride, true);
  assert.deepEqual(out.waived, ["required_review"]);
  assert.equal(out.github.exitCode, 0);
  assert.match(out.github.stdout, /Squashed and merged/);
  assert.deepEqual(gh.merges(), [["gh", "pr", "merge", "42", "--repo", REPO, "--admin", "--squash", "--match-head-commit", SHA]]);
});

test("Admin Merge without exact consent never calls GitHub", async () => {
  for (const consent of [
    null,
    consentFor(SHA, { action: "merge" }),
    consentFor(SHA.slice(0, 7)),
    { ...consentFor(), number: "42" },
    { ...consentFor(), baseRef: undefined }
  ]) {
    const gh = fakeGh();
    const out = await executeAdminMerge({ prRef: PR, consent, run: gh.run });
    assert.equal(out.status, "halted");
    assert.equal(out.reason, "consent_missing");
    assert.equal(gh.calls.length, 0);
  }
  for (const consent of [consentFor(SHA, { repo: "acme/other" }), consentFor(SHA, { number: 43 })]) {
    const gh = fakeGh();
    const out = await executeAdminMerge({ prRef: PR, consent, run: gh.run });
    assert.equal(out.reason, "consent_mismatch");
    assert.equal(gh.calls.length, 0);
  }
});

test("Admin Merge halts on a stale head: consent for an older SHA, or a card pinned to another commit", async () => {
  const moved = fakeGh({ view: { headRefOid: NEW_SHA } });
  const out = await executeAdminMerge({ prRef: PR, consent: consentFor(SHA), run: moved.run });
  assert.equal(out.status, "halted");
  assert.equal(out.reason, "head_changed");
  assert.match(out.detail, /fedcba9.*0123456|moved to fedcba9/);
  assert.equal(moved.merges().length, 0);

  const pinned = fakeGh({ view: { headRefOid: NEW_SHA } });
  const pre = await preflightAdminMerge({ prRef: PR, expectedHeadSha: SHA.slice(0, 7), run: pinned.run });
  assert.equal(pre.reason, "head_changed");
  assert.equal(pinned.merges().length, 0);
});

test("Admin Merge halts when the PR was retargeted to another base after the owner's consent", async () => {
  const gh = fakeGh({ view: { baseRefName: "release" } });
  const out = await executeAdminMerge({ prRef: PR, consent: consentFor(), run: gh.run });
  assert.equal(out.reason, "base_changed");
  assert.match(out.detail, /now targets release.*into main/);
  assert.equal(gh.merges().length, 0);
});

test("Admin Merge verifies every check the branch rules require, on the exact head, failing closed", async () => {
  const securityRule = (extra = {}) => ({ rules: [{ type: "pull_request" }, { type: "required_status_checks", parameters: { required_status_checks: [{ context: "mandatory-security", ...extra }] } }] });
  const cases = [
    // Never reported, even though gh pr checks --required says nothing is required.
    [{ ...securityRule(), checks: { code: 1, stdout: "", stderr: "no required checks reported on the 'feature' branch" } }, /mandatory-security \(never reported\)/],
    // Reported by a different app than the rule names.
    [{ ...securityRule({ integration_id: 99 }), checkRuns: [{ id: 5, name: "mandatory-security", status: "completed", conclusion: "success", app: { id: 7 } }] }, /not reported by the required app/],
    // A commit status cannot prove which app posted it.
    [{ ...securityRule({ integration_id: 99 }), checkRuns: [], statuses: [{ context: "mandatory-security", state: "success" }] }, /not reported by the required app/],
    // The newest run is what counts.
    [{ ...securityRule(), checkRuns: [{ id: 5, name: "mandatory-security", status: "completed", conclusion: "success" }, { id: 9, name: "mandatory-security", status: "completed", conclusion: "failure" }] }, /mandatory-security \(failure\)/],
    [{ ...securityRule(), checkRuns: [], statuses: [{ context: "mandatory-security", state: "pending" }] }, /mandatory-security \(pending\)/],
    // Classic protection contexts count too.
    [{ protection: { required_pull_request_reviews: {}, required_status_checks: { strict: true, contexts: ["ci/legacy"], checks: [] } } }, /ci\/legacy \(never reported\)/]
  ];
  for (const [over, detail] of cases) {
    const gh = fakeGh(over);
    const out = await executeAdminMerge({ prRef: PR, consent: consentFor(), run: gh.run });
    assert.equal(out.reason, "required_checks_not_passing", JSON.stringify(over));
    assert.match(out.detail, detail);
    assert.equal(gh.merges().length, 0);
  }

  // Passing on the head from the right source: allowed.
  const ok = fakeGh({ ...securityRule({ integration_id: 99 }), checkRuns: [{ id: 5, name: "mandatory-security", status: "completed", conclusion: "success", app: { id: 99 } }] });
  assert.equal((await executeAdminMerge({ prRef: PR, consent: consentFor(), run: ok.run })).status, "merged");
  const anySource = fakeGh({ ...securityRule(), checkRuns: [], statuses: [{ context: "mandatory-security", state: "success" }] });
  assert.equal((await executeAdminMerge({ prRef: PR, consent: consentFor(), run: anySource.run })).status, "merged");
  assert.ok(ok.calls.some((c) => c[1] === "api" && c[2].startsWith(`repos/${REPO}/commits/${SHA}/check-runs`)), "checks are read on the consented head");
});

test("Admin Merge never bypasses a signed-commit rule: every PR commit must be verified", async () => {
  const OLD = "1111111111111111111111111111111111111111";
  const unsigned = [{ sha: OLD, commit: { verification: { verified: false, reason: "unsigned" } } }, { sha: SHA, commit: { verification: { verified: true, reason: "valid" } } }];
  const cases = [
    [{ rules: [{ type: "pull_request" }, { type: "required_signatures" }], prCommits: unsigned }, "unsigned_commits", /1111111 \(unsigned\)/],
    [{ protection: { required_pull_request_reviews: {}, required_signatures: { enabled: true } }, prCommits: unsigned }, "unsigned_commits", /lack a verified signature/],
    [{ rules: [{ type: "required_signatures" }], prCommits: [{ sha: OLD, commit: { verification: { verified: true } } }] }, "signatures_unreadable", /does not end at the head/],
    [{ rules: [{ type: "required_signatures" }], prCommits: Array.from({ length: 250 }, (_, i) => ({ sha: i === 249 ? SHA : OLD, commit: { verification: { verified: true } } })) }, "signatures_unreadable", /at most 250 commits/]
  ];
  for (const [over, reason, detail] of cases) {
    const gh = fakeGh(over);
    const out = await executeAdminMerge({ prRef: PR, consent: consentFor(), run: gh.run });
    assert.equal(out.reason, reason);
    assert.match(out.detail, detail);
    assert.equal(gh.merges().length, 0);
  }
  // All verified: allowed. No signature rule: commits are not even read.
  const signed = fakeGh({ rules: [{ type: "pull_request" }, { type: "required_signatures" }] });
  assert.equal((await executeAdminMerge({ prRef: PR, consent: consentFor(), run: signed.run })).status, "merged");
  const none = fakeGh();
  await executeAdminMerge({ prRef: PR, consent: consentFor(), run: none.run });
  assert.equal(none.calls.some((c) => /\/pulls\/\d+\/commits/.test(c[2] ?? "")), false);
});

test("Admin Merge reads every page of branch rules before allowing a bypass", async () => {
  const safePage = Array.from({ length: 100 }, () => ({ type: "deletion" }));
  const gh = fakeGh({ rulesPage: (page) => (page === 1 ? safePage : page === 2 ? [{ type: "pull_request" }, { type: "merge_queue" }] : []) });
  const out = await executeAdminMerge({ prRef: PR, consent: consentFor(), run: gh.run });
  assert.equal(out.reason, "other_rule");
  assert.match(out.detail, /merge_queue/);
  assert.equal(gh.merges().length, 0);

  const endless = fakeGh({ rulesPage: () => safePage });
  const capped = await executeAdminMerge({ prRef: PR, consent: consentFor(), run: endless.run });
  assert.equal(capped.reason, "rules_unreadable");
  assert.equal(endless.merges().length, 0);
});

test("Admin Merge never bypasses failing, pending, or unposted required checks", async () => {
  const cases = [
    [{ view: { statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }] } }, "ci_failed"],
    [{ view: { statusCheckRollup: [{ name: "test", status: "IN_PROGRESS", conclusion: "" }] } }, "ci_pending"],
    [{ checks: { code: 8, stdout: JSON.stringify([{ name: "e2e", state: "EXPECTED", bucket: "pending" }]), stderr: "" } }, "required_checks_not_passing"],
    [{ checks: { code: 1, stdout: JSON.stringify([{ name: "e2e", state: "FAILURE", bucket: "fail" }]), stderr: "" } }, "required_checks_not_passing"]
  ];
  for (const [over, reason] of cases) {
    const gh = fakeGh(over);
    const out = await executeAdminMerge({ prRef: PR, consent: consentFor(), run: gh.run });
    assert.equal(out.status, "halted", reason);
    assert.equal(out.reason, reason);
    assert.equal(gh.merges().length, 0, `${reason}: no merge attempted`);
  }
});

test("Admin Merge only waives a required review: every other blocker halts with no merge", async () => {
  const cases = [
    [{ view: { reviewDecision: "CHANGES_REQUESTED" } }, "changes_requested"],
    [{ view: { reviewDecision: "APPROVED" } }, "blocked_other"],
    [{ view: { mergeStateStatus: "CLEAN", reviewDecision: "APPROVED" } }, "nothing_to_waive"],
    [{ view: { mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" } }, "merge_conflict"],
    [{ view: { mergeable: "UNKNOWN" } }, "mergeability_unknown"],
    [{ view: { mergeStateStatus: "BEHIND" } }, "behind_base"],
    [{ view: { isDraft: true } }, "draft_pr"],
    [{ view: { state: "CLOSED" } }, "pr_closed"],
    [{ rules: [{ type: "pull_request" }, { type: "merge_queue" }] }, "other_rule"],
    [{ rules: [{ type: "required_deployments", parameters: { required_deployment_environments: ["prod"] } }] }, "other_rule"],
    [{ rules: [{ type: "pull_request", parameters: { allowed_merge_methods: ["rebase"] } }] }, "other_rule"],
    [{ protection: { required_pull_request_reviews: {}, enforce_admins: { enabled: true } } }, "other_rule"],
    [{ protection: { required_pull_request_reviews: {}, restrictions: { users: [], teams: [] } } }, "other_rule"],
    [{
      protection: { required_pull_request_reviews: {}, required_conversation_resolution: { enabled: true } },
      threads: { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { totalCount: 1, nodes: [{ isResolved: false }] } } } } }), stderr: "" }
    }, "unresolved_conversations"]
  ];
  for (const [over, reason] of cases) {
    const gh = fakeGh(over);
    const out = await executeAdminMerge({ prRef: PR, consent: consentFor(), run: gh.run });
    assert.equal(out.reason, reason, JSON.stringify(over));
    assert.equal(gh.merges().length, 0, `${reason}: no merge attempted`);
  }

  // Resolved conversations and classic review-only protection are fine.
  const ok = fakeGh({ protection: { required_pull_request_reviews: {}, required_status_checks: { contexts: ["test"] }, enforce_admins: { enabled: false }, required_conversation_resolution: { enabled: true } } });
  assert.equal((await executeAdminMerge({ prRef: PR, consent: consentFor(), run: ok.run })).status, "merged");
});

test("Admin Merge surfaces GitHub's exact refusal and never retries or falls back", async () => {
  const gh = fakeGh({ adminMerge: { code: 1, stdout: "", stderr: DENIAL } });
  const out = await executeAdminMerge({ prRef: PR, consent: consentFor(), run: gh.run });
  assert.equal(out.status, "halted");
  assert.equal(out.reason, "github_rejected");
  assert.ok(out.detail.includes("You're not authorized to bypass the required review on this branch."), out.detail);
  assert.equal(out.github.exitCode, 1);
  assert.equal(out.github.stderr, DENIAL);
  assert.equal(gh.merges().length, 1, "exactly one attempt");
  assert.equal(gh.calls.some((c) => c.includes("--force") || c.includes("--auto") || (c[1] === "api" && c.includes("--method"))), false, "no force push, auto-merge, or settings write");

  // Unreadable branch protection: the exact GitHub message, no merge.
  const hidden = fakeGh();
  const run = async (bin, args) => (args[0] === "api" && /\/protection$/.test(args[1])
    ? { code: 1, stdout: "", stderr: "gh: Resource not accessible by integration (HTTP 403)" }
    : hidden.run(bin, args));
  const blocked = await executeAdminMerge({ prRef: PR, consent: consentFor(), run });
  assert.equal(blocked.reason, "protection_unreadable");
  assert.match(blocked.detail, /Resource not accessible by integration \(HTTP 403\)/);
  assert.equal(hidden.merges().length, 0);
});

test("ordinary Merge never bypasses: REVIEW_REQUIRED halts and offers Admin Merge, GitHub refusals are not retried with --admin", async () => {
  const gh = fakeGh();
  const out = await executeSafePrMerge({ prRef: PR, expectedHeadSha: SHA, run: gh.run });
  assert.equal(out.reason, "review_required");
  assert.equal(out.adminMergeOffered, true);
  assert.equal(gh.merges().length, 0);

  // Clean PR but GitHub refuses the plain merge: halt with its message, no --admin retry.
  const clean = fakeGh({ view: { mergeStateStatus: "CLEAN", reviewDecision: "APPROVED" }, plainMerge: { code: 1, stdout: "", stderr: "base branch policy prohibits the merge" } });
  const refused = await executeSafePrMerge({ prRef: PR, expectedHeadSha: SHA, run: clean.run });
  assert.equal(refused.reason, "gh_merge_failed");
  assert.match(refused.detail, /base branch policy prohibits the merge/);
  assert.equal(clean.merges().length, 1);
  assert.equal(clean.calls.some((c) => c.includes("--admin")), false);
});

// ─── supervisor + route ──────────────────────────────────────────────────

function tempSupervisor(gh, { now = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-admin-merge-"));
  const events = new EventEmitter();
  const delivered = [];
  const supervisor = new FleetSupervisor({
    dataDir: dir,
    runtime: { events },
    deps: { run: gh.run, ...(now ? { now } : {}), executor: { deliver: async (p) => { delivered.push(p); return { status: "sent" }; } } }
  });
  const question = supervisor.store.upsertQuestion({
    dedupeKey: `ready:${PR}`,
    kind: "ready",
    threadKey: "paseo:host1.agent-1",
    prRef: PR,
    askedHead: SHA.slice(0, 7),
    title: "webapp #42 ready to merge",
    body: "Checks passed; waiting on a review.",
    options: ["merged", "later"]
  });
  const route = createFleetRoute({ supervisor });
  const post = (id, body, suffix = "admin-merge") => {
    const p = `/fleet/api/cards/${encodeURIComponent(id)}/${suffix}`;
    return route("POST", p, new URL(`http://localhost${p}`), async () => body);
  };
  return { supervisor, question, post, delivered, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const adminAudit = (supervisor) => supervisor.store.actions(50).filter((a) => a.kind === "pr-admin-merge");

test("owner Admin Merge via the route: preview, confirm the exact consent, audit intent and GitHub result, no deploy", async () => {
  const gh = fakeGh();
  const t = tempSupervisor(gh);
  try {
    const preview = await t.post(t.question.id, { preview: true });
    assert.equal(preview.status, 200);
    const p = preview.body.result;
    assert.equal(p.ok, true);
    assert.equal(p.status, "preview");
    assert.deepEqual(p.plan.waives.map((w) => w.rule), ["required_review"]);
    assert.equal(p.consent.action, "admin_merge");
    assert.equal(p.consent.repo, REPO);
    assert.equal(p.consent.number, 42);
    assert.equal(p.consent.headSha, SHA);
    assert.equal(p.consent.baseRef, "main");
    assert.ok(p.consent.token.length >= 20);
    assert.equal(gh.merges().length, 0);
    assert.equal(adminAudit(t.supervisor).length, 0, "a preview is not an action");

    const done = await t.post(t.question.id, { consent: p.consent });
    assert.equal(done.status, 200);
    const r = done.body.result;
    assert.equal(r.ok, true);
    assert.equal(r.status, "merged");
    assert.equal(r.kind, "admin_merge");
    assert.equal(gh.merges().length, 1);
    assert.deepEqual(gh.merges()[0], ["gh", "pr", "merge", "42", "--repo", REPO, "--admin", "--squash", "--match-head-commit", SHA]);

    const [audit] = adminAudit(t.supervisor);
    assert.equal(audit.id, r.auditId);
    assert.equal(audit.by, "owner");
    assert.equal(audit.status, "done");
    assert.equal(audit.adminMerge.action, "admin_merge");
    assert.equal(audit.adminMerge.repo, REPO);
    assert.equal(audit.adminMerge.number, 42);
    assert.equal(audit.adminMerge.headSha, SHA);
    assert.deepEqual(audit.adminMerge.waives, ["required_review"]);
    assert.ok(audit.adminMerge.previewedAt && audit.adminMerge.confirmedAt);
    assert.equal(audit.adminMerge.result, "merged");
    assert.equal(audit.adminMerge.githubLogin, "owner-login");
    assert.equal(audit.adminMerge.github.exitCode, 0);

    assert.equal(t.supervisor.store.question(t.question.id).status, "resolved");
    assert.equal(t.delivered.length, 0, "Admin Merge never pings a deploy");
  } finally {
    t.cleanup();
  }
});

test("denied Admin Merge: no preview, reused, tampered, or expired consent never reaches GitHub", async () => {
  let clock = Date.parse("2026-11-23T12:00:00Z");
  const gh = fakeGh();
  const t = tempSupervisor(gh, { now: () => clock });
  try {
    // Made-up consent, never previewed.
    let r = (await t.post(t.question.id, { consent: { token: "x".repeat(24), ...consentFor() } })).body.result;
    assert.equal(r.status, "consent_required");

    // Tampered head SHA: refused, and the consent is spent.
    let p = (await t.post(t.question.id, { preview: true })).body.result;
    r = (await t.post(t.question.id, { consent: { ...p.consent, headSha: NEW_SHA } })).body.result;
    assert.equal(r.status, "consent_mismatch");
    r = (await t.post(t.question.id, { consent: p.consent })).body.result;
    assert.equal(r.status, "consent_required", "a consent is single-use even when it did not match");

    // Tampered base branch.
    p = (await t.post(t.question.id, { preview: true })).body.result;
    r = (await t.post(t.question.id, { consent: { ...p.consent, baseRef: "release" } })).body.result;
    assert.equal(r.status, "consent_mismatch");

    // Consent for another card.
    const other = t.supervisor.store.upsertQuestion({ dedupeKey: "ready:acme/webapp#43", kind: "ready", prRef: `${REPO}#43`, title: "other", options: ["merged"] });
    p = (await t.post(t.question.id, { preview: true })).body.result;
    r = (await t.post(other.id, { consent: p.consent })).body.result;
    assert.equal(r.status, "consent_mismatch");

    // Expired.
    p = (await t.post(t.question.id, { preview: true })).body.result;
    clock += 6 * 60_000;
    r = (await t.post(t.question.id, { consent: p.consent })).body.result;
    assert.equal(r.status, "consent_required");

    // Malformed body.
    const bad = await t.post(t.question.id, { consent: { token: "t" } });
    assert.equal(bad.status, 400);

    assert.equal(gh.merges().length, 0);
    assert.equal(adminAudit(t.supervisor).length, 0);
    assert.equal(t.supervisor.store.question(t.question.id).status, "open");
  } finally {
    t.cleanup();
  }
});

test("non-owner paths cannot Admin Merge: direct calls, card actions, agent tools, batch, and paired phones", async () => {
  const gh = fakeGh();
  const t = tempSupervisor(gh);
  try {
    const p = (await t.post(t.question.id, { preview: true })).body.result;
    for (const initiator of [undefined, null, "agent", "supervisor", "phone"]) {
      assert.equal((await t.supervisor.previewAdminMerge(t.question.id, { initiator })).status, "owner_required");
      assert.equal((await t.supervisor.adminMergeCard(t.question.id, { initiator, consent: p.consent })).status, "owner_required");
    }
    assert.equal((await t.supervisor.actCard(t.question.id, { op: "admin_merge" })).status, "owner_required");
    assert.equal((await t.supervisor.actCard(t.question.id, { op: "admin_merge", confirmed: true })).status, "owner_required");
    // The route's own card action path is no way in either.
    const viaAct = await t.post(t.question.id, { op: "admin_merge", confirmed: true }, "act");
    assert.equal(viaAct.body.result.status, "owner_required");

    // Agent tools cannot name it.
    const registry = new ToolRegistry();
    registerFleetTools(registry, t.supervisor);
    for (const name of ["fleet_act_card", "fleet_batch_cards"]) {
      const tool = registry.get(name);
      assert.ok(tool, name);
      assert.equal(tool.parameters.properties.op.enum.includes("admin_merge"), false, name);
    }
    // A paired phone's credential is not allowed on the route.
    assert.equal(isMobileRouteAllowed("POST", `/fleet/api/cards/${t.question.id}/admin-merge`), false);
    assert.equal(isMobileRouteAllowed("POST", `/fleet/api/cards/${t.question.id}/act`), true);

    assert.equal(gh.merges().length, 0);
    assert.equal(adminAudit(t.supervisor).length, 0);

    // The owner's preview from before still works: nothing above spent it.
    const done = (await t.post(t.question.id, { consent: p.consent })).body.result;
    assert.equal(done.status, "merged");
  } finally {
    t.cleanup();
  }
});

test("ordinary Merge card action on a review-blocked PR halts and offers Admin Merge without --admin", async () => {
  const gh = fakeGh();
  const t = tempSupervisor(gh);
  try {
    const r = await t.supervisor.actCard(t.question.id, { op: "merge" });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "review_required");
    assert.equal(r.adminMergeOffered, true);
    assert.equal(gh.merges().length, 0);
    assert.equal(t.supervisor.store.question(t.question.id).status, "open");
  } finally {
    t.cleanup();
  }
});

test("Admin Merge at the stale head or with failing checks halts through the route and is audited as blocked", async () => {
  const gh = fakeGh();
  const t = tempSupervisor(gh);
  try {
    const p = (await t.post(t.question.id, { preview: true })).body.result;
    gh.view.headRefOid = NEW_SHA; // a commit lands between preview and confirm
    const r = (await t.post(t.question.id, { consent: p.consent })).body.result;
    assert.equal(r.status, "halted");
    assert.equal(r.reason, "head_changed");
    assert.equal(gh.merges().length, 0);
    const [audit] = adminAudit(t.supervisor);
    assert.equal(audit.status, "blocked");
    assert.equal(audit.adminMerge.result, "halted");
    assert.equal(audit.adminMerge.resultReason, "head_changed");
    assert.equal(t.supervisor.store.question(t.question.id).status, "open");

    // Preview itself refuses a failing PR: no consent is ever issued.
    gh.view.headRefOid = SHA;
    gh.view.statusCheckRollup = [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }];
    const failing = (await t.post(t.question.id, { preview: true })).body.result;
    assert.equal(failing.ok, false);
    assert.equal(failing.reason, "ci_failed");
    assert.equal(failing.consent, undefined);
  } finally {
    t.cleanup();
  }
});

test("GitHub's Admin Merge refusal is shown verbatim, audited, and leaves the card open", async () => {
  const gh = fakeGh({ adminMerge: { code: 1, stdout: "", stderr: DENIAL } });
  const t = tempSupervisor(gh);
  try {
    const p = (await t.post(t.question.id, { preview: true })).body.result;
    const r = (await t.post(t.question.id, { consent: p.consent })).body.result;
    assert.equal(r.ok, false);
    assert.equal(r.reason, "github_rejected");
    assert.ok(r.detail.includes("You're not authorized to bypass the required review on this branch."));
    assert.equal(r.github.stderr, DENIAL);
    assert.equal(gh.merges().length, 1);
    const [audit] = adminAudit(t.supervisor);
    assert.equal(audit.status, "blocked");
    assert.equal(audit.adminMerge.resultReason, "github_rejected");
    assert.equal(audit.adminMerge.github.stderr, DENIAL);
    assert.equal(t.supervisor.store.question(t.question.id).status, "open");
  } finally {
    t.cleanup();
  }
});

test("a remote fleet computer accepts the owner's admin-merge request path", async () => {
  const seen = [];
  const capability = createFleetCapability({
    getState: () => ({ questions: [], actions: [], cards: [] }),
    previewAdminMerge: async (id, opts) => { seen.push(["preview", id, opts.initiator]); return { ok: false, status: "halted" }; },
    adminMergeCard: async (id, opts) => { seen.push(["confirm", id, opts.initiator]); return { ok: false, status: "halted" }; }
  });
  const res = await capability.invoke("request", { method: "POST", path: "/fleet/api/cards/q1/admin-merge", body: { preview: true } });
  assert.equal(res.response.status, 200);
  assert.deepEqual(seen, [["preview", "q1", "owner"]]);
});

test("the main's remote proxy forwards only the owner's Admin Merge", async () => {
  const { RemoteFleetSupervisor } = await import("../src/fleet/remote.js");
  const sent = [];
  const proxy = Object.create(RemoteFleetSupervisor.prototype);
  proxy.request = async (method, p, body) => { sent.push([method, p, body]); return { result: { ok: true, status: "preview" } }; };
  assert.equal((await proxy.previewAdminMerge("q1", {})).status, "owner_required");
  assert.equal((await proxy.adminMergeCard("q1", { initiator: "agent", consent: consentFor() })).status, "owner_required");
  assert.equal(sent.length, 0);
  assert.equal((await proxy.previewAdminMerge("q1", { initiator: "owner" })).status, "preview");
  await proxy.adminMergeCard("q1", { initiator: "owner", consent: { token: "t", ...consentFor() } });
  assert.deepEqual(sent, [
    ["POST", "/fleet/api/cards/q1/admin-merge", { preview: true }],
    ["POST", "/fleet/api/cards/q1/admin-merge", { consent: { token: "t", ...consentFor() } }]
  ]);
});
