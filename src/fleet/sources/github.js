// GitHub readiness for the PRs linked to fleet threads, plus the local git
// facts needed to judge "CI green on the exact head". Read-only: every call
// is a gh/git query. Nothing here throws; failures leave refs out of the map
// or return nulls.

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
  " reviewThreads(first:100){totalCount nodes{isResolved isOutdated comments(last:1){nodes{author{login}}}}}",
  " comments(last:30){nodes{author{login} body createdAt}}",
  " files(first:100){nodes{path}} }"
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
function codexReviewFor(comments, headOid) {
  const summary = comments.filter((comment) => String(comment?.body ?? "").includes(CODEX_SUMMARY_MARKER)).at(-1);
  if (!summary) return { reviewedHead: null, sha: null };
  const lines = String(summary.body).split("\n");
  const row = lines.find((line) => /Code Review/i.test(line)) ?? lines.find((line) => /`[0-9a-f]{7,40}`/i.test(line)) ?? "";
  const sha = /`([0-9a-f]{7,40})`/i.exec(row)?.[1]?.toLowerCase() ?? null;
  const onHead = Boolean(sha && /Completed/i.test(row) && String(headOid ?? "").toLowerCase().startsWith(sha));
  return { reviewedHead: onHead, sha };
}

function qaFor(number, headOid, comments, files, prefixes) {
  const required = prefixes ? files.some((file) => prefixes.some((prefix) => file.startsWith(prefix))) : null;
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
    codexReview: codexReviewFor(comments, headOid),
    qa: qaFor(number, headOid, comments, files, uiPrefixesFor(repo, config)),
    updatedAt: node.updatedAt ?? null
  };
}

async function fetchBatch(batch, config, run, out) {
  let result;
  try {
    result = await run(config.bins.gh, ["api", "graphql", "-f", `query=${buildPrQuery(batch)}`], { timeoutMs: GH_TIMEOUT_MS });
  } catch {
    return;
  }
  // gh exits non-zero on partial GraphQL errors (an unknown PR) but still
  // prints the body, so parse stdout regardless of the exit code.
  const data = parseJson(result?.stdout)?.data;
  if (!data || typeof data !== "object") return;
  const aliases = new Map();
  for (const ref of batch) if (!aliases.has(ref.repo)) aliases.set(ref.repo, `r${aliases.size}`);
  for (const ref of batch) {
    const node = data[aliases.get(ref.repo)]?.[`p${ref.number}`];
    if (!node || typeof node !== "object") continue;
    try {
      const pr = normalizePr(ref.repo, node, config);
      out.set(pr.ref, pr);
    } catch {
      // A malformed node leaves this ref unknown for the tick.
    }
  }
}

export async function fetchPrStates(refs, config, { run = runCommand } = {}) {
  const out = new Map();
  const parsed = uniqueRefs(refs);
  for (let index = 0; index < parsed.length; index += BATCH_SIZE) {
    await fetchBatch(parsed.slice(index, index + BATCH_SIZE), config, run, out);
  }
  return out;
}

export async function findPrForBranch(repo, branch, config, { run = runCommand } = {}) {
  const name = String(branch ?? "").trim();
  if (!REPO_PATTERN.test(String(repo ?? "")) || !name || name.startsWith("-") || NON_PR_BRANCHES.has(name)) return null;
  let result;
  try {
    result = await run(config.bins.gh, [
      "pr", "list", "--repo", repo, "--head", name, "--state", "all", "--json", "number,state,updatedAt"
    ], { timeoutMs: GH_TIMEOUT_MS });
  } catch {
    return null;
  }
  const rows = result?.code === 0 ? parseJson(result.stdout) : null;
  if (!Array.isArray(rows)) return null;
  const candidates = rows.filter((row) => Number.isInteger(row?.number));
  if (!candidates.length) return null;
  const newestFirst = (a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0);
  const open = candidates.filter((row) => row.state === "OPEN").sort(newestFirst);
  const pick = open[0] ?? candidates.sort(newestFirst)[0];
  return prRefKey(repo, pick.number);
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

export async function readLocalGit(cwd, config, { run = runCommand } = {}) {
  const empty = { head: null, branch: null, upstream: null, ahead: null, remote: null };
  if (!cwd) return empty;
  // A missing dir, a denied volume, or a non-repo all fail here; skip the rest.
  const head = await gitLine(run, config, cwd, ["rev-parse", "HEAD"]);
  if (!head) return empty;
  const [branch, upstream, remoteUrl] = await Promise.all([
    gitLine(run, config, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitLine(run, config, cwd, ["rev-parse", "--abbrev-ref", "@{u}"]),
    gitLine(run, config, cwd, ["remote", "get-url", "origin"])
  ]);
  const aheadText = upstream ? await gitLine(run, config, cwd, ["rev-list", "--count", "@{u}..HEAD"]) : null;
  const ahead = aheadText !== null && /^\d+$/.test(aheadText) ? Number(aheadText) : null;
  return {
    head,
    branch: branch && branch !== "HEAD" ? branch : null,
    upstream,
    ahead,
    remote: repoFromRemote(remoteUrl)
  };
}
