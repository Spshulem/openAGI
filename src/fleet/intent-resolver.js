// Safe PR merge preflight + execution, the owner's separate Admin Merge, and
// natural-utterance card matching. Ordinary merge never bypasses anything
// (no --admin): a PR held by its required review halts and offers Admin
// Merge. Enforces the progressive non-auto-merge contract:
//   1. Default mergePolicy is "manual_confirm" (never passes `gh pr merge --auto`
//      unless the owner explicitly switched mergePolicy to "queue_when_green").
//   2. Verifies PR state, draft flag, expected head SHA, merge conflicts, and
//      CI rollup live right before merging.
//   3. Halts immediately on drift, conflict, or red CI so nothing broken merges.

import { clampText, clampTextLines, parsePrRef, redactSecrets, runCommand } from "./contracts.js";
import { requiredChecksFor } from "./sources/github.js";

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const FAILED_STATES = new Set(["FAILURE", "ERROR"]);
const PENDING_STATUSES = new Set(["IN_PROGRESS", "QUEUED", "WAITING", "PENDING", "REQUESTED"]);
const PENDING_STATES = new Set(["PENDING", "EXPECTED"]);
const GREEN_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const GREEN_STATES = new Set(["SUCCESS"]);

function rollupPassesConfiguredGates(rollup, repo, config) {
  const required = requiredChecksFor(repo, config);
  if (!required.length) return true;
  const list = Array.isArray(rollup) ? rollup : [];
  return required.every(({ name }) => {
    const matches = list.filter((item) => item && (item.name === name || item.context === name));
    if (!matches.length) return false;
    return matches.some((item) => {
      const state = String(item.state ?? "").toUpperCase();
      const status = String(item.status ?? "").toUpperCase();
      const conclusion = String(item.conclusion ?? "").toUpperCase();
      if (state) return GREEN_STATES.has(state);
      return status === "COMPLETED" && GREEN_CONCLUSIONS.has(conclusion);
    });
  });
}

async function verifyRequiredBranchChecks(run, ghBin, parsed) {
  const res = await run(
    ghBin,
    ["pr", "checks", String(parsed.number), "--repo", parsed.repo, "--required", "--json", "name,state,bucket"],
    { timeoutMs: 15_000 }
  );
  if (res.code !== 0) {
    const combined = `${res.stderr ?? ""}\n${res.stdout ?? ""}`;
    if (/no required checks/i.test(combined)) return { ok: true };
    return {
      ok: false,
      detail: clampText(redactSecrets(res.stderr || res.stdout || "Required branch checks have not all completed and passed."), 220)
    };
  }
  let checks;
  try {
    checks = JSON.parse(res.stdout || "[]");
  } catch {
    return { ok: false, detail: "Could not parse the required branch checks." };
  }
  if (!Array.isArray(checks)) return { ok: false, detail: "Unexpected required checks payload from GitHub." };
  const incomplete = checks.filter((c) => !["pass", "skipping"].includes(String(c?.bucket ?? "").toLowerCase()));
  if (incomplete.length > 0) {
    const names = incomplete.map((c) => c?.name || "required check").slice(0, 3).join(", ");
    return { ok: false, detail: `Required check(s) not yet passing (${names}).` };
  }
  return { ok: true, checks: checks.map((c) => String(c?.name ?? "")).filter(Boolean) };
}

function summarizeRollup(rollup) {
  const list = Array.isArray(rollup) ? rollup : [];
  const failing = [];
  const pending = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const name = item.name || item.context || "check";
    const status = String(item.status ?? "").toUpperCase();
    const conclusion = String(item.conclusion ?? "").toUpperCase();
    const state = String(item.state ?? "").toUpperCase();
    if (FAILED_CONCLUSIONS.has(conclusion) || FAILED_STATES.has(state)) {
      failing.push(name);
    } else if ((status && status !== "COMPLETED" && PENDING_STATUSES.has(status)) || PENDING_STATES.has(state)) {
      pending.push(name);
    }
  }
  return { failing: [...new Set(failing)], pending: [...new Set(pending)] };
}

export async function executeSafePrMerge({
  prRef,
  expectedHeadSha = null,
  mergePolicy = "manual_confirm",
  config = null,
  ghBin = "gh",
  run = runCommand
} = {}) {
  const parsed = parsePrRef(prRef);
  if (!parsed || !REPO_PATTERN.test(parsed.repo) || !(parsed.number > 0)) {
    return { status: "halted", reason: "invalid_pr_ref", detail: "Invalid pull request reference." };
  }

  const viewRes = await run(
    ghBin,
    [
      "pr", "view", String(parsed.number),
      "--repo", parsed.repo,
      "--json", "state,isDraft,mergeStateStatus,mergeable,reviewDecision,headRefOid,statusCheckRollup,url"
    ],
    { timeoutMs: 25_000 }
  );

  if (viewRes.code !== 0 || !viewRes.stdout) {
    return {
      status: "halted",
      reason: "github_unreachable",
      detail: clampText(redactSecrets(viewRes.stderr || viewRes.error || "Could not verify PR status on GitHub before merging."), 220)
    };
  }

  let view;
  try {
    view = JSON.parse(viewRes.stdout);
  } catch {
    return { status: "halted", reason: "github_parse_error", detail: "Could not parse GitHub PR status." };
  }

  const state = String(view.state ?? "").toUpperCase();
  if (state === "MERGED") {
    return { status: "already_merged", prRef, url: view.url ?? null, detail: `${prRef} is already merged.` };
  }
  if (state !== "OPEN") {
    return { status: "halted", reason: "pr_closed", prRef, detail: `${prRef} is ${state.toLowerCase() || "closed"}; nothing was merged.` };
  }
  if (view.isDraft === true) {
    return { status: "halted", reason: "draft_pr", prRef, detail: `${prRef} is still a draft PR.` };
  }

  const liveSha = String(view.headRefOid ?? "").trim();
  const pinnedSha = String(expectedHeadSha ?? "").trim();
  if (pinnedSha && liveSha && !liveSha.startsWith(pinnedSha) && !pinnedSha.startsWith(liveSha)) {
    return {
      status: "halted",
      reason: "head_changed",
      prRef,
      headRefOid: liveSha,
      detail: `New commit (${liveSha.slice(0, 7)}) landed on ${prRef} after review. Inspect the updated diff before merging.`
    };
  }

  const mergeState = String(view.mergeStateStatus ?? "").toUpperCase();
  const mergeable = String(view.mergeable ?? "").toUpperCase();
  if (mergeState === "DIRTY" || mergeable === "CONFLICTING") {
    return {
      status: "halted",
      reason: "merge_conflict",
      prRef,
      canFixCi: true,
      detail: `${prRef} has merge conflicts with base. Send back to the coding session to rebase.`
    };
  }

  const { failing, pending } = summarizeRollup(view.statusCheckRollup);
  if (failing.length > 0) {
    return {
      status: "halted",
      reason: "ci_failed",
      prRef,
      canFixCi: true,
      failingChecks: failing.slice(0, 5),
      detail: `CI failed on ${prRef} (${failing.slice(0, 3).join(", ")}). Merge halted safely.`
    };
  }

  const headArgs = liveSha ? ["--match-head-commit", liveSha] : [];

  if (pending.length > 0) {
    if (mergePolicy === "queue_when_green") {
      const queueRes = await run(
        ghBin,
        ["pr", "merge", String(parsed.number), "--repo", parsed.repo, "--auto", "--squash", ...headArgs],
        { timeoutMs: 30_000 }
      );
      if (queueRes.code === 0) {
        return {
          status: "queued_when_green",
          prRef,
          headRefOid: liveSha || null,
          url: view.url ?? null,
          detail: `Queued squash merge for ${prRef} once ${pending.length} running check(s) pass.`
        };
      }
      return {
        status: "halted",
        reason: "gh_queue_failed",
        prRef,
        detail: clampText(redactSecrets(queueRes.stderr || queueRes.stdout || "GitHub refused auto-merge queue on this repo."), 220)
      };
    }
    return {
      status: "watching_ci",
      prRef,
      promptPreference: true,
      pendingChecks: pending.slice(0, 5),
      detail: `CI is still running on ${prRef} (${pending.slice(0, 2).join(", ")}). Auto-merge is off by default—watching CI and will ping you when green.`
    };
  }

  if (mergeState === "BEHIND") {
    return {
      status: "halted",
      reason: "behind_base",
      prRef,
      canFixCi: true,
      detail: `${prRef} is behind the base branch and must be updated before merging.`
    };
  }

  // Ordinary Merge never bypasses anything. A PR held only by its required
  // review halts here and names the separate, owner-only Admin Merge path.
  const reviewDecision = String(view.reviewDecision ?? "").toUpperCase();
  if (mergeState === "BLOCKED" && mergeable === "MERGEABLE" && reviewDecision === "REVIEW_REQUIRED") {
    return {
      status: "halted",
      reason: "review_required",
      prRef,
      headRefOid: liveSha || null,
      adminMergeOffered: true,
      detail: `${prRef} still needs the approving review its branch rules require. Merge never bypasses that; use Admin Merge if you deliberately want to waive the required review.`
    };
  }
  if (mergeState === "BLOCKED" || mergeState === "UNSTABLE" || mergeable === "UNKNOWN") {
    return {
      status: "halted",
      reason: "blocked",
      prRef,
      detail: `${prRef} is blocked by branch protection, unposted checks, or required reviews (${mergeState || mergeable}). Merge halted safely.`
    };
  }

  const mergeRes = await run(
    ghBin,
    ["pr", "merge", String(parsed.number), "--repo", parsed.repo, "--squash", ...headArgs],
    { timeoutMs: 30_000 }
  );
  if (mergeRes.code === 0) {
    return {
      status: "merged",
      prRef,
      headRefOid: liveSha || null,
      url: view.url ?? null,
      detail: `Merged ${prRef} via squash.`
    };
  }

  return {
    status: "halted",
    reason: "gh_merge_failed",
    prRef,
    detail: clampText(redactSecrets(mergeRes.stderr || mergeRes.stdout || "GitHub refused the merge (check branch protection reviews)."), 220)
  };
}

// ─── Admin Merge ─────────────────────────────────────────────────────────
// The owner's deliberate, separate path (never reached by ordinary Merge,
// batch actions, or any agent tool). It waives exactly one thing, the
// required approving review, through GitHub's own `gh pr merge --admin`
// bypass, and only where GitHub already lets the authenticated identity do
// that. It never bypasses failing or pending checks, conflicts, drafts, a
// moved head, or any other branch rule. It never edits rules, settings, or
// credentials, never force-pushes, never falls back to anything else, and
// runs only when the owner's consent names the exact repo, PR number, head
// SHA, and action.

export const ADMIN_MERGE_ACTION = "admin_merge";
export const ADMIN_MERGE_WAIVER = "required_review";
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GITHUB_DETAIL_MAX = 600;

// Ruleset rules that a GitHub squash merge cannot break (creation, deletion,
// non_fast_forward, linear history) or that Admin Merge verifies itself
// (status checks; signatures, on every PR commit; the pull_request rule's
// review count is the one waiver, its thread-resolution and merge-method parts
// are checked below). Any other active rule is something --admin could skip,
// so Admin Merge refuses instead.
const RULESET_RULES_SAFE = new Set([
  "creation", "deletion", "non_fast_forward", "required_linear_history",
  "required_signatures", "required_status_checks", "pull_request"
]);
// GitHub's PR commits endpoint lists at most this many commits.
const PR_COMMITS_LISTED_MAX = 250;

function githubMessage(res) {
  const raw = String(res?.stderr || res?.stdout || res?.error || "").trim();
  return clampText(redactSecrets(raw || "GitHub returned no message."), GITHUB_DETAIL_MAX);
}

function halt(reason, prRef, detail, extra = {}) {
  return { ok: false, status: "halted", reason, prRef, detail, ...extra };
}

async function ghApiJson(run, ghBin, endpoint) {
  const res = await run(ghBin, ["api", endpoint], { timeoutMs: 20_000 });
  if (res.code === 0) {
    try {
      return { ok: true, data: JSON.parse(res.stdout || "null") };
    } catch {
      return { ok: false, message: `Could not parse GitHub's reply for ${endpoint}.` };
    }
  }
  const text = `${res.stderr ?? ""}\n${res.stdout ?? ""}`;
  return { ok: false, notProtected: /Branch not protected/i.test(text), message: githubMessage(res) };
}

// Every page of a GitHub list endpoint (pick(data) is that page's items).
// Unreadable, malformed, or longer than MAX_PAGES: not ok, so callers halt.
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
async function ghApiAllPages(run, ghBin, endpoint, pick = (data) => data) {
  const items = [];
  const sep = endpoint.includes("?") ? "&" : "?";
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await ghApiJson(run, ghBin, `${endpoint}${sep}per_page=${PAGE_SIZE}&page=${page}`);
    if (!res.ok) return res;
    const list = pick(res.data);
    if (!Array.isArray(list)) return { ok: false, message: `Unexpected GitHub reply for ${endpoint}.` };
    items.push(...list);
    if (list.length < PAGE_SIZE) return { ok: true, data: items };
  }
  return { ok: false, message: `More than ${PAGE_SIZE * MAX_PAGES} entries on ${endpoint}; not all could be read.` };
}

// The status checks the base branch's own rules require: ruleset
// required_status_checks and classic protection, each with the app that must
// post it (null: any source).
function requiredContexts(rules, protection) {
  const found = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (rule?.type !== "required_status_checks") continue;
    for (const c of rule?.parameters?.required_status_checks ?? []) found.push({ context: c?.context, appId: c?.integration_id });
  }
  const classic = protection?.required_status_checks;
  if (classic) {
    const checks = Array.isArray(classic.checks) ? classic.checks : [];
    for (const c of checks) found.push({ context: c?.context, appId: c?.app_id });
    if (!checks.length) for (const context of classic.contexts ?? []) found.push({ context, appId: null });
  }
  const seen = new Map();
  for (const { context, appId } of found) {
    const name = String(context ?? "").trim();
    if (!name) continue;
    const app = Number.isInteger(appId) && appId > 0 ? appId : null;
    seen.set(`${name}\u0000${app ?? "*"}`, { context: name, appId: app });
  }
  return [...seen.values()];
}

// Each required context must have passed on the exact head: its newest check
// run from the required app, or (any-source contexts only) a successful
// commit status. Missing, pending, failing, or unprovable: listed.
async function unmetRequiredContexts(run, ghBin, repo, headSha, required) {
  if (!required.length) return { ok: true, unmet: [] };
  const runs = await ghApiAllPages(run, ghBin, `repos/${repo}/commits/${headSha}/check-runs`, (d) => d?.check_runs);
  if (!runs.ok) return runs;
  const statuses = await ghApiAllPages(run, ghBin, `repos/${repo}/commits/${headSha}/status`, (d) => d?.statuses);
  if (!statuses.ok) return statuses;
  const unmet = [];
  for (const { context, appId } of required) {
    const matching = runs.data.filter((r) => r?.name === context && (appId === null || r?.app?.id === appId));
    if (matching.length) {
      const latest = matching.reduce((a, b) => (Number(b?.id) > Number(a?.id) ? b : a));
      const passed = String(latest?.status ?? "").toLowerCase() === "completed"
        && GREEN_CONCLUSIONS.has(String(latest?.conclusion ?? "").toUpperCase());
      if (!passed) unmet.push(`${context} (${String(latest?.conclusion || latest?.status || "not passing").toLowerCase()})`);
      continue;
    }
    const status = appId === null ? statuses.data.find((st) => st?.context === context) : null;
    if (status) {
      if (String(status.state ?? "").toUpperCase() !== "SUCCESS") unmet.push(`${context} (${String(status.state || "not passing").toLowerCase()})`);
      continue;
    }
    unmet.push(`${context} (${appId === null ? "never reported" : "not reported by the required app"})`);
  }
  return { ok: true, unmet };
}

// Classic branch protection settings --admin would otherwise skip.
function classicProtectionBlockers(protection) {
  const blockers = [];
  if (protection?.enforce_admins?.enabled === true) {
    blockers.push("branch protection applies to administrators too (enforce_admins), so GitHub does not allow an admin bypass here");
  }
  if (protection?.lock_branch?.enabled === true) blockers.push("the base branch is locked (lock_branch)");
  if (protection?.restrictions) blockers.push("pushes to the base branch are restricted to specific people, teams, or apps (restrictions)");
  return blockers;
}

function rulesetBlockers(rules) {
  const blockers = [];
  let threadResolution = false;
  let signatures = false;
  for (const rule of Array.isArray(rules) ? rules : []) {
    const type = String(rule?.type ?? "");
    if (!RULESET_RULES_SAFE.has(type)) {
      blockers.push(`ruleset rule "${type || "unknown"}"`);
      continue;
    }
    if (type === "required_signatures") signatures = true;
    if (type === "pull_request") {
      const params = rule?.parameters ?? {};
      if (params.required_review_thread_resolution === true) threadResolution = true;
      const methods = Array.isArray(params.allowed_merge_methods) ? params.allowed_merge_methods : null;
      if (methods && !methods.map((m) => String(m).toLowerCase()).includes("squash")) {
        blockers.push("ruleset allows only " + methods.join("/") + " merges, not squash");
      }
    }
  }
  return { blockers, threadResolution, signatures };
}

// Signed-commit rules: every commit on the PR must carry a signature GitHub
// verified (GitHub signing the squash commit does not satisfy the rule).
// Unreadable, more than GitHub lists, or not ending at the head: not ok.
async function unverifiedCommits(run, ghBin, parsed, headSha) {
  const commits = await ghApiAllPages(run, ghBin, `repos/${parsed.repo}/pulls/${parsed.number}/commits`);
  if (!commits.ok) return commits;
  if (commits.data.length >= PR_COMMITS_LISTED_MAX) return { ok: false, message: `GitHub lists at most ${PR_COMMITS_LISTED_MAX} commits per PR, so not every signature could be read.` };
  if (String(commits.data.at(-1)?.sha ?? "").toLowerCase() !== headSha) return { ok: false, message: "The PR's commit list does not end at the head being merged." };
  const unverified = commits.data
    .filter((c) => c?.commit?.verification?.verified !== true)
    .map((c) => `${String(c?.sha ?? "").slice(0, 7)} (${c?.commit?.verification?.reason ?? "unsigned"})`);
  return { ok: true, unverified };
}

// Classic protection settings the REST protection response leaves out
// (required deployments), read from the branch's own protection rule.
async function classicGraphqlSettings(run, ghBin, parsed, base) {
  const [owner, name] = parsed.repo.split("/");
  const query = "query($owner:String!,$name:String!,$ref:String!){repository(owner:$owner,name:$name){ref(qualifiedName:$ref){branchProtectionRule{requiresDeployments requiredDeploymentEnvironments}}}}";
  const res = await run(
    ghBin,
    ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `ref=refs/heads/${base}`],
    { timeoutMs: 20_000 }
  );
  if (res.code !== 0) return { ok: false, message: githubMessage(res) };
  try {
    const repo = JSON.parse(res.stdout || "{}")?.data?.repository;
    if (!repo || !repo.ref) return { ok: false, message: `GitHub did not return the ${base} branch.` };
    const rule = repo.ref.branchProtectionRule;
    if (!rule) return { ok: false, message: `GitHub returned no protection rule for ${base}, though branch protection is on.` };
    return { ok: true, requiresDeployments: rule.requiresDeployments === true, environments: Array.isArray(rule.requiredDeploymentEnvironments) ? rule.requiredDeploymentEnvironments : [] };
  } catch {
    return { ok: false, message: "Could not parse the branch protection rule." };
  }
}

async function unresolvedReviewThreads(run, ghBin, parsed) {
  const [owner, name] = parsed.repo.split("/");
  const query = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){totalCount nodes{isResolved}}}}}";
  const res = await run(
    ghBin,
    ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${parsed.number}`],
    { timeoutMs: 20_000 }
  );
  if (res.code !== 0) return { ok: false, message: githubMessage(res) };
  try {
    const threads = JSON.parse(res.stdout || "{}")?.data?.repository?.pullRequest?.reviewThreads;
    const nodes = Array.isArray(threads?.nodes) ? threads.nodes : null;
    if (!nodes || !(threads.totalCount <= nodes.length)) return { ok: false, message: "Could not read every review thread." };
    return { ok: true, unresolved: nodes.filter((n) => n?.isResolved !== true).length };
  } catch {
    return { ok: false, message: "Could not parse review threads." };
  }
}

// Live, read-only check of everything Admin Merge requires. Returns
// { ok: true, plan } naming exactly what would be waived, or a halt.
export async function preflightAdminMerge({
  prRef,
  expectedHeadSha = null,
  config = null,
  ghBin = "gh",
  run = runCommand
} = {}) {
  const parsed = parsePrRef(prRef);
  if (!parsed || !REPO_PATTERN.test(parsed.repo) || !(parsed.number > 0)) {
    return halt("invalid_pr_ref", prRef ?? null, "Invalid pull request reference.");
  }
  const ref = `${parsed.repo}#${parsed.number}`;

  const viewRes = await run(
    ghBin,
    [
      "pr", "view", String(parsed.number),
      "--repo", parsed.repo,
      "--json", "state,isDraft,mergeStateStatus,mergeable,reviewDecision,headRefOid,baseRefName,statusCheckRollup,url,title"
    ],
    { timeoutMs: 25_000 }
  );
  if (viewRes.code !== 0 || !viewRes.stdout) {
    return halt("github_unreachable", ref, `Could not read ${ref} on GitHub: ${githubMessage(viewRes)}`);
  }
  let view;
  try {
    view = JSON.parse(viewRes.stdout);
  } catch {
    return halt("github_parse_error", ref, "Could not parse GitHub PR status.");
  }

  const state = String(view.state ?? "").toUpperCase();
  if (state === "MERGED") return { ok: false, status: "already_merged", reason: "already_merged", prRef: ref, url: view.url ?? null, detail: `${ref} is already merged.` };
  if (state !== "OPEN") return halt("pr_closed", ref, `${ref} is ${state.toLowerCase() || "closed"}; nothing was merged.`);
  if (view.isDraft === true) return halt("draft_pr", ref, `${ref} is still a draft PR.`);

  const liveSha = String(view.headRefOid ?? "").trim().toLowerCase();
  if (!FULL_SHA.test(liveSha)) return halt("head_unknown", ref, `GitHub did not report a head commit for ${ref}.`);
  const pinned = String(expectedHeadSha ?? "").trim().toLowerCase();
  if (pinned && (pinned.length < 7 || !liveSha.startsWith(pinned))) {
    return halt("head_changed", ref, `New commit (${liveSha.slice(0, 7)}) landed on ${ref} after review. Inspect the updated diff first.`, { headRefOid: liveSha });
  }

  const mergeState = String(view.mergeStateStatus ?? "").toUpperCase();
  const mergeable = String(view.mergeable ?? "").toUpperCase();
  if (mergeState === "DIRTY" || mergeable === "CONFLICTING") {
    return halt("merge_conflict", ref, `${ref} has merge conflicts with its base. Admin Merge never bypasses conflicts.`, { canFixCi: true });
  }
  if (mergeable !== "MERGEABLE") {
    return halt("mergeability_unknown", ref, `GitHub has not finished checking whether ${ref} can merge (${mergeable || "unknown"}). Try again in a moment.`);
  }
  if (mergeState === "BEHIND") {
    return halt("behind_base", ref, `${ref} is behind its base branch and must be updated first. Admin Merge never bypasses that.`, { canFixCi: true });
  }

  const { failing, pending } = summarizeRollup(view.statusCheckRollup);
  if (failing.length > 0) {
    return halt("ci_failed", ref, `Checks are failing on ${ref} (${failing.slice(0, 3).join(", ")}). Admin Merge never bypasses failing checks.`, { canFixCi: true, failingChecks: failing.slice(0, 5) });
  }
  if (pending.length > 0) {
    return halt("ci_pending", ref, `Checks are still running on ${ref} (${pending.slice(0, 3).join(", ")}). Admin Merge never bypasses pending checks.`, { pendingChecks: pending.slice(0, 5) });
  }
  if (!rollupPassesConfiguredGates(view.statusCheckRollup, parsed.repo, config)) {
    return halt("checks_not_green", ref, `A check Supervisor requires for ${parsed.repo} has not passed on ${ref}.`);
  }

  const reviewDecision = String(view.reviewDecision ?? "").toUpperCase();
  if (mergeState !== "BLOCKED") {
    const plainMergeable = mergeState === "CLEAN" || mergeState === "HAS_HOOKS";
    return halt("nothing_to_waive", ref, `${ref} is not held by a required review (GitHub merge state: ${mergeState || "unknown"}).${plainMergeable ? " Use ordinary Merge." : " Admin Merge waives nothing else."}`);
  }
  if (reviewDecision === "CHANGES_REQUESTED") {
    return halt("changes_requested", ref, `A reviewer requested changes on ${ref}. Admin Merge only waives a missing required review, not requested changes.`);
  }
  if (reviewDecision !== "REVIEW_REQUIRED") {
    return halt("blocked_other", ref, `${ref} is blocked by something other than a required review (review decision: ${reviewDecision || "none"}). Admin Merge only waives a required review.`);
  }

  const required = await verifyRequiredBranchChecks(run, ghBin, parsed);
  if (!required.ok) return halt("required_checks_not_passing", ref, `${required.detail} Admin Merge never bypasses required checks.`);

  const base = String(view.baseRefName ?? "").trim();
  if (!base) return halt("base_unknown", ref, `GitHub did not report the base branch of ${ref}.`);

  const rules = await ghApiAllPages(run, ghBin, `repos/${parsed.repo}/rules/branches/${encodeURIComponent(base)}`);
  if (!rules.ok) return halt("rules_unreadable", ref, `Could not read the rules on ${base}, so Admin Merge cannot confirm only the required review would be waived. GitHub said: ${rules.message}`);
  const ruleset = rulesetBlockers(rules.data);

  const protection = await ghApiJson(run, ghBin, `repos/${parsed.repo}/branches/${encodeURIComponent(base)}/protection`);
  if (!protection.ok && !protection.notProtected) {
    return halt("protection_unreadable", ref, `Could not read branch protection on ${base}, so Admin Merge cannot confirm only the required review would be waived. GitHub said: ${protection.message}`);
  }
  const classic = protection.ok ? protection.data : null;
  const blockers = [...ruleset.blockers, ...classicProtectionBlockers(classic)];
  if (classic) {
    const extra = await classicGraphqlSettings(run, ghBin, parsed, base);
    if (!extra.ok) return halt("protection_unreadable", ref, `Could not read every branch protection setting on ${base}, so Admin Merge cannot confirm only the required review would be waived. GitHub said: ${extra.message}`);
    if (extra.requiresDeployments) {
      blockers.push(`branch protection requires successful deployments${extra.environments.length ? ` (${extra.environments.slice(0, 3).join(", ")})` : ""} (requiresDeployments)`);
    }
  }
  if (blockers.length > 0) {
    return halt("other_rule", ref, `Admin Merge only waives the required review, but ${base} also has: ${blockers.join("; ")}. Supervisor will not bypass that or change any rule.`, { otherRules: blockers });
  }
  const requiredByRules = requiredContexts(rules.data, classic);
  const contexts = await unmetRequiredContexts(run, ghBin, parsed.repo, liveSha, requiredByRules);
  if (!contexts.ok) return halt("checks_unreadable", ref, `Could not read the checks on ${liveSha.slice(0, 7)}, so Admin Merge cannot confirm every required check passed. GitHub said: ${contexts.message}`);
  if (contexts.unmet.length > 0) {
    return halt("required_checks_not_passing", ref, `${base} requires check(s) that have not passed on ${liveSha.slice(0, 7)}: ${contexts.unmet.slice(0, 5).join(", ")}. Admin Merge never bypasses required checks.`);
  }
  if (ruleset.signatures || classic?.required_signatures?.enabled === true) {
    const signed = await unverifiedCommits(run, ghBin, parsed, liveSha);
    if (!signed.ok) return halt("signatures_unreadable", ref, `${base} requires signed commits and Admin Merge could not confirm every commit on ${ref} is. ${signed.message}`);
    if (signed.unverified.length > 0) {
      return halt("unsigned_commits", ref, `${base} requires signed commits, and ${signed.unverified.length} commit(s) on ${ref} lack a verified signature: ${signed.unverified.slice(0, 5).join(", ")}. Admin Merge never bypasses that.`);
    }
  }
  if (ruleset.threadResolution || classic?.required_conversation_resolution?.enabled === true) {
    const threads = await unresolvedReviewThreads(run, ghBin, parsed);
    if (!threads.ok) return halt("threads_unreadable", ref, `${base} requires resolved conversations and Admin Merge could not confirm they are. GitHub said: ${threads.message}`);
    if (threads.unresolved > 0) {
      return halt("unresolved_conversations", ref, `${ref} has ${threads.unresolved} unresolved review conversation(s) and ${base} requires them resolved. Admin Merge never bypasses that.`);
    }
  }

  const who = await run(ghBin, ["api", "user", "--jq", ".login"], { timeoutMs: 15_000 });
  const githubLogin = who.code === 0 ? String(who.stdout ?? "").trim().slice(0, 100) || null : null;

  const checks = [...new Set([...requiredByRules.map((c) => c.context), ...(Array.isArray(required.checks) ? required.checks : [])])];
  return {
    ok: true,
    status: "ready",
    prRef: ref,
    plan: {
      action: ADMIN_MERGE_ACTION,
      repo: parsed.repo,
      number: parsed.number,
      prRef: ref,
      title: typeof view.title === "string" ? clampText(view.title, 200) : null,
      url: view.url ?? null,
      headSha: liveSha,
      baseRef: base,
      method: "squash",
      githubLogin,
      waives: [{
        rule: ADMIN_MERGE_WAIVER,
        label: "Required approving review",
        detail: `GitHub reports ${ref} as REVIEW_REQUIRED: ${base} requires an approving review this PR does not have.`
      }],
      stillEnforced: [
        checks.length ? `Required checks passing on ${liveSha.slice(0, 7)} (${checks.slice(0, 5).join(", ")})` : `No required checks on ${base}; every reported check is passing`,
        "No merge conflicts; not behind base",
        `Merges only if the head is still ${liveSha.slice(0, 7)}`,
        "Every other branch rule"
      ],
      command: `gh pr merge ${parsed.number} --repo ${parsed.repo} --admin --squash --match-head-commit ${liveSha}`
    }
  };
}

// Runs the owner's Admin Merge. consent must be the exact
// { action: "admin_merge", repo, number, headSha, baseRef } the owner confirmed; the
// full preflight runs again live first. One `gh pr merge --admin` call, no
// retry or fallback. GitHub's own answer is returned verbatim (redacted).
export async function executeAdminMerge({
  prRef,
  consent = null,
  expectedHeadSha = null,
  config = null,
  ghBin = "gh",
  run = runCommand
} = {}) {
  const parsed = parsePrRef(prRef);
  if (!parsed) return halt("invalid_pr_ref", prRef ?? null, "Invalid pull request reference.");
  const ref = `${parsed.repo}#${parsed.number}`;
  const consentSha = String(consent?.headSha ?? "").trim().toLowerCase();
  if (!consent || consent.action !== ADMIN_MERGE_ACTION || typeof consent.repo !== "string"
      || !Number.isInteger(consent.number) || !FULL_SHA.test(consentSha)
      || typeof consent.baseRef !== "string" || !consent.baseRef) {
    return halt("consent_missing", ref, "Admin Merge needs the owner's explicit consent naming the action, repo, PR number, full head SHA, and base branch.");
  }
  if (consent.repo.toLowerCase() !== parsed.repo.toLowerCase() || consent.number !== parsed.number) {
    return halt("consent_mismatch", ref, `The Admin Merge consent was for ${consent.repo}#${consent.number}, not ${ref}. Nothing was merged.`);
  }

  const preflight = await preflightAdminMerge({ prRef: ref, expectedHeadSha, config, ghBin, run });
  if (!preflight.ok) return preflight;
  const { plan } = preflight;
  if (plan.baseRef !== consent.baseRef) {
    return halt("base_changed", ref, `${ref} now targets ${plan.baseRef}, but you confirmed Admin Merge into ${consent.baseRef}. Nothing was merged; preview again.`, { baseRef: plan.baseRef });
  }
  if (plan.headSha !== consentSha) {
    return halt("head_changed", ref, `${ref} moved to ${plan.headSha.slice(0, 7)} after you confirmed Admin Merge for ${consentSha.slice(0, 7)}. Nothing was merged; review the new commit and confirm again.`, { headRefOid: plan.headSha });
  }

  const res = await run(
    ghBin,
    ["pr", "merge", String(parsed.number), "--repo", parsed.repo, "--admin", "--squash", "--match-head-commit", consentSha],
    { timeoutMs: 30_000 }
  );
  const github = {
    exitCode: typeof res.code === "number" ? res.code : null,
    stdout: clampTextLines(redactSecrets(String(res.stdout ?? "")), GITHUB_DETAIL_MAX),
    stderr: clampTextLines(redactSecrets(String(res.stderr ?? res.error ?? "")), GITHUB_DETAIL_MAX)
  };
  if (res.code === 0) {
    return {
      ok: true,
      status: "merged",
      prRef: ref,
      headRefOid: consentSha,
      url: plan.url,
      adminOverride: true,
      waived: [ADMIN_MERGE_WAIVER],
      githubLogin: plan.githubLogin,
      plan,
      github,
      detail: `Admin merged ${ref} at ${consentSha.slice(0, 7)} via squash, waiving only the required review.`
    };
  }
  return halt("github_rejected", ref, `GitHub rejected the Admin Merge of ${ref}: ${githubMessage(res)}`, { plan, github, githubLogin: plan.githubLogin });
}

// Resolves which SupervisorCard a natural-language reply targets:
//   - Semantic override if the utterance names a PR number (#281) or repo/workspace
//   - Else the focused card above the composer
//   - Else the top card in the deck
export function matchCardForUtterance(cards = [], text = "", focusedCardId = null) {
  if (!Array.isArray(cards) || cards.length === 0) return null;
  const lower = String(text ?? "").toLowerCase();

  const prMatch = /(?:#|pr\s+)(\d+)\b/i.exec(lower);
  if (prMatch) {
    const num = Number(prMatch[1]);
    const byPr = cards.find((c) => c.prNumber === num || String(c.prRef ?? "").endsWith(`#${num}`));
    if (byPr) return byPr;
  }

  const words = lower.split(/[^a-z0-9_-]+/).filter((w) => w.length >= 3);
  if (words.length > 0) {
    let best = null;
    let bestHits = 0;
    for (const card of cards) {
      const targetText = [card.repo, card.workspace, card.branch, card.headline]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const hits = words.filter((w) => !["the", "one", "that", "this", "for", "and", "yes", "yeah", "merge", "ship", "approve"].includes(w) && targetText.includes(w)).length;
      if (hits > bestHits) {
        bestHits = hits;
        best = card;
      }
    }
    if (best && bestHits >= 1) return best;
  }

  if (focusedCardId) {
    const focused = cards.find((c) => c.id === focusedCardId || c.questionId === focusedCardId);
    if (focused) return focused;
  }
  return cards[0];
}
