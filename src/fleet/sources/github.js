// GitHub readiness for the PRs linked to fleet threads, plus the local git
// facts needed to judge "CI green on the exact head". Read-only: every call
// is a gh/git query. Failed branch lookups throw so a confirmed absence is
// never confused with an unavailable GitHub response.

import fs from "node:fs";
import path from "node:path";
import { clampText, parsePrRef, prRefKey, repoFromRemote, runCommand } from "../contracts.js";

const BATCH_SIZE = 20;
const GH_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 10_000;
const CODEX_SUMMARY_MARKER = "<!-- codex-pull-request-review-summary -->";
const QA_EVIDENCE = /PR box `pr(\d+)` on `([0-9a-f]{7,40})`/i;
// A cancelled run is red unless another run of its name replaced it
// (newerCheck): one stopped by hand or by timeout-minutes never finished.
const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const FAILED_STATUSES = new Set(["FAILURE", "ERROR"]);
const PENDING_STATUSES = new Set(["PENDING", "EXPECTED"]);
const NON_PR_BRANCHES = new Set(["HEAD", "main", "master"]);
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// Files under these paths need visual QA on a BuildBot3 preview.
export const DEFAULT_UI_PATH_PREFIXES = Object.freeze({
  "buildbetter-app/buildbetter": Object.freeze([
    "packages/apps/web-app/", "packages/apps/admin-app/", "packages/apps/portal-app/", "packages/apps/portal-embed/",
    "packages/apps/zeroshot-app/", "packages/apps/desktop-app/", "packages/apps/changelog-widget/",
    "packages/apps/feedback-widget/", "packages/apps/keycloak-theme/"
  ])
});

// Checks that must pass on the exact head before a PR is ready. BuildBetter's
// hosted PR verification is paused; its gate is the BuildBot3 full run, which
// posts this commit status.
export const DEFAULT_REQUIRED_CHECKS = Object.freeze({
  "buildbetter-app/buildbetter": Object.freeze([Object.freeze({ name: "BuildBot3 full verification", label: "BuildBot3 full run", how: "bb-verify --full --pr" })])
});

const PR_FRAGMENT = [
  "fragment P on PullRequest { number url title state isDraft headRefName headRefOid baseRefName mergeStateStatus mergeable reviewDecision createdAt updatedAt mergedAt closedAt",
  " commits(last:1){nodes{commit{oid committedDate statusCheckRollup{state contexts(first:100){nodes{__typename",
  " ... on CheckRun{name status conclusion startedAt completedAt detailsUrl} ... on StatusContext{context state createdAt}}}}}}}",
  " reviewThreads(first:100){totalCount pageInfo{hasNextPage} nodes{isResolved isOutdated comments(last:1){nodes{author{login}}}}}",
  " comments(last:30){pageInfo{hasPreviousPage} nodes{author{login} body createdAt}}",
  " files(first:100){pageInfo{hasNextPage} nodes{path}} }"
].join("");

// The rollup reads only its first 100 contexts, so a repo's required checks
// are also looked up by name on the last commit: the commit status directly,
// a check run through its check suites. The batch reads the first 20 suites;
// a gate still missing pages on (gateSuitePages), up to MAX_GATE_SUITES.
const FIRST_GATE_SUITES = 20;
const MORE_GATE_SUITES = 40;
const MAX_GATE_SUITES = 100;

function gateRunSelection(required) {
  return required.map(({ name }, i) => `g${i}: checkRuns(last:1,filterBy:{checkName:${JSON.stringify(name)}}){nodes{__typename name status conclusion startedAt completedAt}}`).join(" ");
}

function gateSelection(required) {
  if (!required.length) return "";
  const statuses = required.map(({ name }, i) => `g${i}: context(name:${JSON.stringify(name)}){__typename context state createdAt}`).join(" ");
  return ` gateCommit: commits(last:1){nodes{commit{oid status{${statuses}} checkSuites(first:${FIRST_GATE_SUITES}){pageInfo{hasNextPage endCursor} nodes{${gateRunSelection(required)}}}}}}`;
}

export function buildGateSuitesQuery(repo, oid, after, required) {
  const [owner, name] = repo.split("/");
  return `query { rateLimit{cost remaining} repository(owner:"${owner}",name:"${name}"){ object(oid:${JSON.stringify(oid)}){ ... on Commit { checkSuites(first:${MORE_GATE_SUITES},after:${JSON.stringify(after)}){pageInfo{hasNextPage endCursor} nodes{${gateRunSelection(required)}}} } } } }`;
}

// Pages the head's remaining check suites while a required check is still
// missing, so a check run past the first page is not read as never run.
// Bounded to MAX_GATE_SUITES suites. A failed page marks the lookup unread,
// so a gate still not found is unknown rather than confirmed absent.
async function gateSuitePages(repo, node, config, run) {
  const required = requiredChecksFor(repo, config);
  const gateCommit = node.gateCommit?.nodes?.[0]?.commit;
  const suites = gateCommit?.checkSuites;
  if (!required.length || !suites?.pageInfo?.hasNextPage || !/^[0-9a-f]{40}$/i.test(String(gateCommit.oid ?? ""))) return;
  const gates = () => gatesFor(node.commits?.nodes?.[0]?.commit ?? null, node.headRefOid ?? "", required, gateCommit);
  let page = suites.pageInfo;
  let read = suites.nodes?.length ?? 0;
  gateCommit.suitesUnread = true;
  while (page?.hasNextPage && page.endCursor && read < MAX_GATE_SUITES && gates().some((gate) => gate.state === null)) {
    let result;
    try {
      result = await run(config.bins.gh, ["api", "graphql", "-f", `query=${buildGateSuitesQuery(repo, gateCommit.oid, page.endCursor, required)}`], { timeoutMs: GH_TIMEOUT_MS });
    } catch {
      return;
    }
    const more = parseJson(result?.stdout)?.data?.repository?.object?.checkSuites;
    if (!more || !Array.isArray(more.nodes)) return;
    suites.nodes = [...(suites.nodes ?? []), ...more.nodes];
    read += more.nodes.length;
    page = more.pageInfo;
  }
  gateCommit.suitesUnread = false;
}

// refs: [{repo, number}] already validated by parsePrRef, so owner and name
// only contain [A-Za-z0-9_.-] and are safe inside GraphQL string literals.
export function buildPrQuery(refs, config = null) {
  const byRepo = new Map();
  for (const { repo, number } of refs) {
    if (!byRepo.has(repo)) byRepo.set(repo, []);
    byRepo.get(repo).push(number);
  }
  const repos = [...byRepo].map(([repo, numbers], index) => {
    const [owner, name] = repo.split("/");
    const gates = gateSelection(requiredChecksFor(repo, config));
    const pulls = numbers.map((number) => `p${number}: pullRequest(number:${number}){...P${gates}}`).join(" ");
    return `r${index}: repository(owner:"${owner}",name:"${name}"){ ${pulls} }`;
  });
  return `${PR_FRAGMENT}\nquery { rateLimit{cost remaining}\n${repos.join("\n")} }`;
}

function uniqueRefs(refs) {
  const seen = new Map();
  for (const ref of refs ?? []) {
    const parsed = parsePrRef(ref);
    if (parsed) seen.set(prRefKey(parsed.repo, parsed.number), parsed);
  }
  return [...seen.values()];
}

function parseJson(text) {
  try { return JSON.parse(String(text ?? "")); } catch { return null; }
}

// The aliases a GraphQL field error left null ("r0.p123"; "*" for an
// error with no path). NOT_FOUND ("Could not resolve to a PullRequest") is
// GitHub's answer that the number is no PR; any other error on the alias is
// a resolver that failed, which says nothing about the number.
function failedAliases(body) {
  const failed = new Set();
  for (const error of Array.isArray(body?.errors) ? body.errors : []) {
    if (error?.type === "NOT_FOUND") continue;
    const at = Array.isArray(error?.path) ? error.path : [];
    failed.add(at.length ? at.slice(0, 2).join(".") : "*");
  }
  return failed;
}

function checkStamp(node) {
  return Date.parse(node?.startedAt ?? node?.completedAt ?? node?.createdAt ?? "") || 0;
}

// Whether a cancelled run was superseded by another run of its name: it
// started before that run finished (an older run, or a duplicate cancelled
// beside it), or that run is still going. One started after the other run
// finished is a later rerun cancelled or timed out: the latest result. A
// cancelled run with no start time, or beside one with none, is never
// assumed superseded.
function cancelledBefore(cancelled, other) {
  const start = Date.parse(cancelled?.startedAt ?? cancelled?.createdAt ?? "");
  if (!Number.isFinite(start)) return false;
  if (other?.status && other.status !== "COMPLETED") return true;
  const end = Date.parse(other?.completedAt ?? "") || checkStamp(other);
  return Boolean(end) && start <= end;
}

// The newer of two results for one check name. Without both times, the
// result that does not pass wins, so a stale green never masks a red. A
// cancelled run another run of its name superseded (cancelledBefore) never
// replaces that run; a cancellation after it is the newer result.
function newerCheck(best, next) {
  if (!best) return next;
  const cancelled = (node) => node?.conclusion === "CANCELLED";
  if (cancelled(best) !== cancelled(next)) {
    const [gone, other] = cancelled(next) ? [next, best] : [best, next];
    return cancelledBefore(gone, other) ? other : gone;
  }
  const [a, b] = [checkStamp(best), checkStamp(next)];
  if (a && b) return b >= a ? next : best;
  const passes = (node) => checkState(node) === "SUCCESS";
  return passes(next) && !passes(best) ? best : next;
}

// The newest run of each check on the head, or null when the head's CI is
// unknown. replaced: cancelled runs another run of the same name replaced.
function latestChecks(commit, headOid) {
  const rollup = commit?.statusCheckRollup ?? null;
  // A last commit that is not the head means GitHub has not caught up; the
  // head's CI is unknown rather than whatever the older commit reported.
  if (!rollup || (headOid && commit.oid && commit.oid !== headOid)) return null;
  const latest = new Map();
  let replaced = 0;
  for (const node of rollup.contexts?.nodes ?? []) {
    const name = node?.name ?? node?.context;
    if (!name) continue;
    const best = latest.get(name);
    const kept = newerCheck(best, node);
    const dropped = !best ? null : kept === node ? best : node;
    if (dropped?.conclusion === "CANCELLED" && kept?.conclusion !== "CANCELLED") replaced += 1;
    latest.set(name, kept);
  }
  latest.replaced = replaced;
  return latest;
}

function summarizeChecks(commit, headOid) {
  const latest = latestChecks(commit, headOid);
  if (!latest) return { state: null, failing: [], pending: [] };
  const rollup = commit.statusCheckRollup;
  const failing = [];
  const pending = [];
  // When the newest failure finished: a rerun that fails again on the same
  // head is a new result.
  let failedMs = 0;
  for (const [name, node] of latest) {
    if (node.__typename === "StatusContext") {
      if (FAILED_STATUSES.has(node.state)) failing.push(name);
      else if (PENDING_STATUSES.has(node.state)) pending.push(name);
    } else if (node.status && node.status !== "COMPLETED") {
      pending.push(name);
    } else if (FAILED_CONCLUSIONS.has(node.conclusion)) {
      failing.push(name);
    }
    if (failing.at(-1) === name) failedMs = Math.max(failedMs, Date.parse(node.completedAt ?? node.createdAt ?? "") || 0);
  }
  // GitHub's rollup counts a cancelled run as a failure even when a rerun of
  // that check passed. When every context was read and such a replaced run
  // is the only red, the rollup is not red. A cancelled run nothing
  // replaced is in failing, so the rollup stays red.
  let state = rollup.state ?? null;
  const allRead = (rollup.contexts?.nodes?.length ?? 0) < 100;
  if (FAILED_STATUSES.has(state) && !failing.length && latest.replaced && allRead) state = pending.length ? "PENDING" : "SUCCESS";
  return { state, failing, pending, ...(failedMs ? { failedAt: new Date(failedMs).toISOString() } : {}) };
}

// One check's result: SUCCESS, FAILURE, PENDING, another conclusion
// (SKIPPED, NEUTRAL), or null when it never ran on the head.
function checkState(node) {
  if (!node) return null;
  if (node.__typename === "StatusContext") {
    if (FAILED_STATUSES.has(node.state)) return "FAILURE";
    if (PENDING_STATUSES.has(node.state)) return "PENDING";
    return node.state ?? null;
  }
  if (node.status && node.status !== "COMPLETED") return "PENDING";
  if (FAILED_CONCLUSIONS.has(node.conclusion)) return "FAILURE";
  return node.conclusion ?? null;
}

export function requiredChecksFor(repo, config) {
  const list = config?.requiredChecks?.[repo] ?? DEFAULT_REQUIRED_CHECKS[repo] ?? [];
  return list.map((check) => typeof check === "string" ? { name: check, label: check } : { name: check?.name, label: check?.label || check?.name, how: check?.how })
    .filter((check) => check.name);
}

// The repo's required checks on the exact head: [{name, label, how?, state}].
// how, when set, is the command that produces the check. gateCommit holds
// the by-name lookups (gateSelection); the newest of those and the rollup's
// entry wins.
function gatesFor(commit, headOid, required, gateCommit) {
  if (!required.length) return [];
  const latest = latestChecks(commit, headOid);
  const direct = gateCommit && (!headOid || gateCommit.oid === headOid) ? gateCommit : null;
  return required.map(({ name, label, how }, i) => {
    const found = [latest?.get(name), direct?.status?.[`g${i}`],
      ...(direct?.checkSuites?.nodes ?? []).flatMap((suite) => suite?.[`g${i}`]?.nodes ?? [])]
      .filter((node) => node && (node.name ?? node.context) === name);
    const node = found.reduce(newerCheck, null);
    const state = checkState(node);
    // A suite page that failed to load: not found is unknown, not missing.
    const unread = state === null && direct?.suitesUnread === true;
    return { name, label, ...(typeof how === "string" && how ? { how } : {}), state, ...(unread ? { unread: true } : {}) };
  });
}

// The Codex bot keeps one summary comment per PR and edits it in place:
// "| 📝 **Code Review** | ✅ **Completed** <time> | `95720cc` | New commits |".
function codexReviewFor(comments, headOid, commentsTruncated = false) {
  const summary = comments.filter((comment) => String(comment?.body ?? "").includes(CODEX_SUMMARY_MARKER)).at(-1);
  // The bot edits its original summary in place. If that comment fell off
  // the last page, its absence is not evidence that the head was reviewed.
  if (!summary) return { reviewedHead: commentsTruncated ? false : null, sha: null };
  const lines = String(summary.body).split("\n");
  const row = lines.find((line) => /Code Review/i.test(line)) ?? lines.find((line) => /`[0-9a-f]{7,40}`/i.test(line)) ?? "";
  const sha = /`([0-9a-f]{7,40})`/i.exec(row)?.[1]?.toLowerCase() ?? null;
  const onHead = Boolean(sha && /Completed/i.test(row) && String(headOid ?? "").toLowerCase().startsWith(sha));
  return { reviewedHead: onHead, sha };
}

function qaFor(number, headOid, comments, files, prefixes, filesTruncated = false) {
  // A file list cut at 100 can hide a UI path, so a truncated list never waives QA.
  const required = prefixes ? (filesTruncated || files.some((file) => prefixes.some((prefix) => file.startsWith(prefix)))) : null;
  let sha = null;
  for (const comment of comments) {
    const body = String(comment?.body ?? "");
    if (!body.includes("**Screenshots**")) continue;
    const match = QA_EVIDENCE.exec(body);
    if (match && Number(match[1]) === number) sha = match[2].toLowerCase();
  }
  const freshOnHead = sha ? String(headOid ?? "").toLowerCase().startsWith(sha) : required === null ? null : false;
  return { required, freshOnHead, sha };
}

function uiPrefixesFor(repo, config) {
  return config?.uiPathPrefixes?.[repo] ?? DEFAULT_UI_PATH_PREFIXES[repo] ?? null;
}

export function normalizePr(repo, node, config) {
  const number = Number(node.number);
  const headOid = node.headRefOid ?? "";
  const comments = node.comments?.nodes ?? [];
  const files = (node.files?.nodes ?? []).map((file) => String(file?.path ?? "")).filter(Boolean);
  return {
    ref: prRefKey(repo, number),
    repo,
    number,
    url: node.url ?? `https://github.com/${repo}/pull/${number}`,
    title: clampText(node.title, 200),
    state: node.state ?? null,
    isDraft: Boolean(node.isDraft),
    headRef: node.headRefName ?? "",
    headOid,
    baseRef: node.baseRefName ?? "",
    mergeState: node.mergeStateStatus ?? null,
    mergeable: node.mergeable ?? null,
    reviewDecision: node.reviewDecision ?? null,
    ci: summarizeChecks(node.commits?.nodes?.[0]?.commit ?? null, headOid),
    gates: gatesFor(node.commits?.nodes?.[0]?.commit ?? null, headOid, requiredChecksFor(repo, config), node.gateCommit?.nodes?.[0]?.commit ?? null),
    unresolvedThreads: (node.reviewThreads?.nodes ?? []).filter((thread) => thread && !thread.isResolved).length,
    // More than 100 threads: unread pages may hold unresolved ones.
    threadsTruncated: node.reviewThreads?.pageInfo?.hasNextPage === true,
    codexReview: codexReviewFor(comments, headOid, node.comments?.pageInfo?.hasPreviousPage === true),
    qa: qaFor(number, headOid, comments, files, uiPrefixesFor(repo, config), node.files?.pageInfo?.hasNextPage === true),
    // Only a PR that existed when the agent asked can have answered the ask.
    createdAt: node.createdAt ?? null,
    updatedAt: node.updatedAt ?? null,
    // When a merged or closed PR settled; an agent ask older than this is answered.
    mergedAt: node.mergedAt ?? null,
    closedAt: node.closedAt ?? null
  };
}

// unread (optional) collects refs GitHub could not answer this call: a
// failed or unparseable batch, or a malformed node. A PR GitHub reports as
// missing is an answer, not unread.
async function fetchBatch(batch, config, run, out, unread) {
  const miss = (refs) => { for (const ref of refs) unread?.add(prRefKey(ref.repo, ref.number)); };
  let result;
  try {
    result = await run(config.bins.gh, ["api", "graphql", "-f", `query=${buildPrQuery(batch, config)}`], { timeoutMs: GH_TIMEOUT_MS });
  } catch {
    miss(batch);
    return;
  }
  // gh exits non-zero on partial GraphQL errors (an unknown PR) but still
  // prints the body, so parse stdout regardless of the exit code.
  const body = parseJson(result?.stdout);
  const data = body?.data;
  if (!data || typeof data !== "object") {
    miss(batch);
    return;
  }
  const failed = failedAliases(body);
  const aliases = new Map();
  for (const ref of batch) if (!aliases.has(ref.repo)) aliases.set(ref.repo, `r${aliases.size}`);
  for (const ref of batch) {
    const repoNode = data[aliases.get(ref.repo)];
    // A null repository alias is a partial GraphQL failure, not an answer.
    if (!repoNode || typeof repoNode !== "object") { miss([ref]); continue; }
    const node = repoNode[`p${ref.number}`];
    // Null with a resolver error on it is unread; else GitHub has no such PR.
    if (!node || typeof node !== "object") {
      if (failed.has("*") || failed.has(`${aliases.get(ref.repo)}.p${ref.number}`)) miss([ref]);
      continue;
    }
    // A failed suite page leaves the gate as read from the batch.
    try { await gateSuitePages(ref.repo, node, config, run); } catch { /* keep the batch read */ }
    try {
      const pr = normalizePr(ref.repo, node, config);
      out.set(pr.ref, pr);
    } catch {
      // A malformed node leaves this ref unknown for the tick.
      miss([ref]);
    }
  }
}

export async function fetchPrStates(refs, config, { run = runCommand, unread = null } = {}) {
  const out = new Map();
  const parsed = uniqueRefs(refs);
  for (let index = 0; index < parsed.length; index += BATCH_SIZE) {
    await fetchBatch(parsed.slice(index, index + BATCH_SIZE), config, run, out, unread);
  }
  return out;
}

const LITE_BATCH_SIZE = 50;

export function buildPrStateQuery(refs) {
  const byRepo = new Map();
  for (const { repo, number } of refs) {
    if (!byRepo.has(repo)) byRepo.set(repo, []);
    byRepo.get(repo).push(number);
  }
  const repos = [...byRepo].map(([repo, numbers], index) => {
    const [owner, name] = repo.split("/");
    const pulls = numbers.map((number) => `p${number}: pullRequest(number:${number}){number state mergedAt closedAt updatedAt}`).join(" ");
    return `r${index}: repository(owner:"${owner}",name:"${name}"){ ${pulls} }`;
  });
  return `query { rateLimit{cost remaining}\n${repos.join("\n")} }`;
}

// Just each PR's state, for choosing among a thread's PRs and for the
// check right before a send. ref -> { state, mergedAt, closedAt, updatedAt },
// or null when GitHub answered that the number is no PR (an issue, or a
// "#123" that never was one). A ref GitHub could not answer is left out and
// added to unread.
export async function fetchPrStateLite(refs, config, { run = runCommand, unread = null } = {}) {
  const out = new Map();
  const parsed = uniqueRefs(refs);
  for (let index = 0; index < parsed.length; index += LITE_BATCH_SIZE) {
    const batch = parsed.slice(index, index + LITE_BATCH_SIZE);
    const miss = (list) => { for (const ref of list) unread?.add(prRefKey(ref.repo, ref.number)); };
    let result;
    try {
      result = await run(config.bins.gh, ["api", "graphql", "-f", `query=${buildPrStateQuery(batch)}`], { timeoutMs: GH_TIMEOUT_MS });
    } catch {
      miss(batch);
      continue;
    }
    // A number that is no PR fails only its own alias: gh exits non-zero
    // but still prints the rest.
    const body = parseJson(result?.stdout);
    const data = body?.data;
    if (!data || typeof data !== "object") {
      miss(batch);
      continue;
    }
    const failed = failedAliases(body);
    const aliases = new Map();
    for (const ref of batch) if (!aliases.has(ref.repo)) aliases.set(ref.repo, `r${aliases.size}`);
    for (const ref of batch) {
      const repoNode = data[aliases.get(ref.repo)];
      if (!repoNode || typeof repoNode !== "object") { miss([ref]); continue; }
      const node = repoNode[`p${ref.number}`];
      const key = prRefKey(ref.repo, ref.number);
      // Null is no PR only when GitHub said so (NOT_FOUND) or gave no error
      // on it; a resolver that failed leaves it unread.
      if (!node || typeof node !== "object") {
        if (failed.has("*") || failed.has(`${aliases.get(ref.repo)}.p${ref.number}`)) miss([ref]);
        else out.set(key, null);
        continue;
      }
      out.set(key, { state: node.state ?? null, mergedAt: node.mergedAt ?? null, closedAt: node.closedAt ?? null, updatedAt: node.updatedAt ?? null });
    }
  }
  return out;
}

// Exit 0: the local head is inside the PR (later commits came from GitHub).
// Exit 1: the local head has work the PR lacks. Anything else is unknown.
async function headInPr(run, config, cwd, head, prHead) {
  try {
    const result = await run(config.bins.git, ["-C", cwd, "merge-base", "--is-ancestor", head, prHead], {
      timeoutMs: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }
    });
    if (result?.code === 0) return true;
    return result?.code === 1 ? false : null;
  } catch {
    return null;
  }
}

export async function findPrForBranch(repo, branch, config, { run = runCommand, head = null, cwd = null } = {}) {
  const name = String(branch ?? "").trim();
  if (!REPO_PATTERN.test(String(repo ?? "")) || !name || name.startsWith("-") || NON_PR_BRANCHES.has(name)) return null;
  let result;
  try {
    result = await run(config.bins.gh, [
      "pr", "list", "--repo", repo, "--head", name, "--state", "all", "--json", "number,state,updatedAt,headRefOid"
    ], { timeoutMs: GH_TIMEOUT_MS });
  } catch (error) {
    throw new Error(`PR branch lookup unavailable: ${error?.message ?? error}`);
  }
  const rows = result?.code === 0 ? parseJson(result.stdout) : null;
  if (!Array.isArray(rows)) throw new Error("PR branch lookup unavailable");
  const candidates = rows.filter((row) => Number.isInteger(row?.number));
  if (!candidates.length) return null;
  const newestFirst = (a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0);
  const open = candidates.filter((row) => row.state === "OPEN").sort(newestFirst);
  if (open[0]) return prRefKey(repo, open[0].number);
  // A reused branch name: a closed PR counts only if the local head has no
  // work beyond it, or the new work would read as already done. Unknown
  // ancestry keeps the PR.
  for (const row of candidates.sort(newestFirst)) {
    if (!head || !row.headRefOid || row.headRefOid === head) return prRefKey(repo, row.number);
    if (cwd && (await headInPr(run, config, cwd, head, row.headRefOid)) !== false) return prRefKey(repo, row.number);
  }
  return null;
}

async function gitLine(run, config, cwd, args) {
  try {
    const result = await run(config.bins.git, ["-C", cwd, ...args], {
      timeoutMs: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }
    });
    if (result?.code !== 0) return null;
    return String(result.stdout ?? "").trim().split("\n")[0].trim() || null;
  } catch {
    return null;
  }
}

async function gitDirty(run, config, cwd) {
  try {
    const result = await run(config.bins.git, ["-C", cwd, "status", "--porcelain", "--untracked-files=normal"], {
      timeoutMs: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }
    });
    return result?.code === 0 ? Boolean(String(result.stdout ?? "").trim()) : null;
  } catch {
    return null;
  }
}

// A .git at or above dir means a failed read is git not answering, not
// "no repo here".
function insideRepo(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    for (let current = path.resolve(dir); ; current = path.dirname(current)) {
      if (fs.existsSync(path.join(current, ".git"))) return true;
      if (path.dirname(current) === current) return false;
    }
  } catch {
    return false;
  }
}

export async function readLocalGit(cwd, config, { run = runCommand } = {}) {
  const empty = { head: null, branch: null, upstream: null, ahead: null, remote: null, dirty: null };
  if (!cwd) return empty;
  // A missing dir, a denied volume, or a non-repo all fail here; skip the rest.
  // Inside a repo the failure is unknown local state, which blocks readiness.
  const head = await gitLine(run, config, cwd, ["rev-parse", "HEAD"]);
  if (!head) return insideRepo(cwd) ? { ...empty, unreadable: true } : empty;
  const [branch, upstream, remoteUrl, root] = await Promise.all([
    gitLine(run, config, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitLine(run, config, cwd, ["rev-parse", "--abbrev-ref", "@{u}"]),
    gitLine(run, config, cwd, ["remote", "get-url", "origin"]),
    gitLine(run, config, cwd, ["rev-parse", "--show-toplevel"])
  ]);
  const aheadText = upstream ? await gitLine(run, config, cwd, ["rev-list", "--count", "@{u}..HEAD"]) : null;
  const ahead = aheadText !== null && /^\d+$/.test(aheadText) ? Number(aheadText) : null;
  const dirty = await gitDirty(run, config, cwd);
  return {
    head,
    branch: branch && branch !== "HEAD" ? branch : null,
    upstream,
    ahead,
    remote: repoFromRemote(remoteUrl),
    dirty,
    // The checkout's root: chats in two of its subfolders share one branch.
    root: root || null
  };
}
