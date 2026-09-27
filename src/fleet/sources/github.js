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

const PR_FRAGMENT = [
  "fragment P on PullRequest { number url title state isDraft headRefName headRefOid baseRefName mergeStateStatus mergeable reviewDecision updatedAt",
  " commits(last:1){nodes{commit{oid committedDate statusCheckRollup{state contexts(first:30){nodes{__typename",
  " ... on CheckRun{name status conclusion startedAt completedAt detailsUrl} ... on StatusContext{context state}}}}}}}",
  " reviewThreads(first:100){totalCount pageInfo{hasNextPage} nodes{isResolved isOutdated comments(last:1){nodes{author{login}}}}}",
  " comments(last:30){pageInfo{hasPreviousPage} nodes{author{login} body createdAt}}",
  " files(first:100){pageInfo{hasNextPage} nodes{path}} }"
].join("");

// refs: [{repo, number}] already validated by parsePrRef, so owner and name
// only contain [A-Za-z0-9_.-] and are safe inside GraphQL string literals.
export function buildPrQuery(refs) {
  const byRepo = new Map();
  for (const { repo, number } of refs) {
    if (!byRepo.has(repo)) byRepo.set(repo, []);
    byRepo.get(repo).push(number);
  }
  const repos = [...byRepo].map(([repo, numbers], index) => {
    const [owner, name] = repo.split("/");
    const pulls = numbers.map((number) => `p${number}: pullRequest(number:${number}){...P}`).join(" ");
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

function checkStamp(node) {
  return Date.parse(node?.startedAt ?? node?.completedAt ?? "") || 0;
}

function summarizeChecks(commit, headOid) {
  const rollup = commit?.statusCheckRollup ?? null;
  // A last commit that is not the head means GitHub has not caught up; the
  // head's CI is unknown rather than whatever the older commit reported.
  if (!rollup || (headOid && commit.oid && commit.oid !== headOid)) return { state: null, failing: [], pending: [] };
  const latest = new Map();
  for (const node of rollup.contexts?.nodes ?? []) {
    const name = node?.name ?? node?.context;
    if (!name) continue;
    const previous = latest.get(name);
    if (!previous || checkStamp(node) >= checkStamp(previous)) latest.set(name, node);
  }
  const failing = [];
  const pending = [];
  for (const [name, node] of latest) {
    if (node.__typename === "StatusContext") {
      if (FAILED_STATUSES.has(node.state)) failing.push(name);
      else if (PENDING_STATUSES.has(node.state)) pending.push(name);
    } else if (node.status && node.status !== "COMPLETED") {
      pending.push(name);
    } else if (FAILED_CONCLUSIONS.has(node.conclusion)) {
      failing.push(name);
    }
  }
  return { state: rollup.state ?? null, failing, pending };
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
    unresolvedThreads: (node.reviewThreads?.nodes ?? []).filter((thread) => thread && !thread.isResolved).length,
    // More than 100 threads: unread pages may hold unresolved ones.
    threadsTruncated: node.reviewThreads?.pageInfo?.hasNextPage === true,
    codexReview: codexReviewFor(comments, headOid, node.comments?.pageInfo?.hasPreviousPage === true),
    qa: qaFor(number, headOid, comments, files, uiPrefixesFor(repo, config), node.files?.pageInfo?.hasNextPage === true),
    updatedAt: node.updatedAt ?? null
  };
}

// unread (optional) collects refs GitHub could not answer this call: a
// failed or unparseable batch, or a malformed node. A PR GitHub reports as
// missing is an answer, not unread.
async function fetchBatch(batch, config, run, out, unread) {
  const miss = (refs) => { for (const ref of refs) unread?.add(prRefKey(ref.repo, ref.number)); };
  let result;
  try {
    result = await run(config.bins.gh, ["api", "graphql", "-f", `query=${buildPrQuery(batch)}`], { timeoutMs: GH_TIMEOUT_MS });
  } catch {
    miss(batch);
    return;
  }
  // gh exits non-zero on partial GraphQL errors (an unknown PR) but still
  // prints the body, so parse stdout regardless of the exit code.
  const data = parseJson(result?.stdout)?.data;
  if (!data || typeof data !== "object") {
    miss(batch);
    return;
  }
  const aliases = new Map();
  for (const ref of batch) if (!aliases.has(ref.repo)) aliases.set(ref.repo, `r${aliases.size}`);
  for (const ref of batch) {
    const repoNode = data[aliases.get(ref.repo)];
    // A null repository alias is a partial GraphQL failure, not an answer.
    if (!repoNode || typeof repoNode !== "object") { miss([ref]); continue; }
    const node = repoNode[`p${ref.number}`];
    if (!node || typeof node !== "object") continue;
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
  const [branch, upstream, remoteUrl] = await Promise.all([
    gitLine(run, config, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitLine(run, config, cwd, ["rev-parse", "--abbrev-ref", "@{u}"]),
    gitLine(run, config, cwd, ["remote", "get-url", "origin"])
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
    dirty
  };
}
