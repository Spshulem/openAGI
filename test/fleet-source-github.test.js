import test from "node:test";
import assert from "node:assert/strict";
import { resolveFleetConfig } from "../src/fleet/contracts.js";
import {
  buildPrQuery, DEFAULT_UI_PATH_PREFIXES, fetchPrStates, findPrForBranch, readLocalGit
} from "../src/fleet/sources/github.js";

const BBAPP = "buildbetter-app/buildbetter";
const HEAD_6878 = "95720cc51573f9399855468d0e8eefd858c16fd0";

function config(overrides = {}) {
  return resolveFleetConfig({}, { home: "/home/fixture", bins: { gh: "/fake/gh", git: "/fake/git" }, ...overrides });
}

function codexThread(login = "chatgpt-codex-connector", isResolved = false) {
  return { isResolved, isOutdated: false, comments: { nodes: [{ author: { login } }] } };
}

// Captured from one real `gh api graphql` call on 2026-09-26 (bodies shortened,
// long URLs cut). Note GraphQL author logins carry no "[bot]" suffix.
function capturedResponse() {
  return {
    data: {
      rateLimit: { cost: 2, remaining: 4405 },
      r0: {
        p6878: {
          number: 6878,
          url: "https://github.com/buildbetter-app/buildbetter/pull/6878",
          title: "Connect an integration from the chat that needs it",
          state: "OPEN",
          isDraft: false,
          headRefName: "feature/ai-chat-inline-connect",
          headRefOid: HEAD_6878,
          baseRefName: "feature/ai-chat-credits-fallback-and-rerun",
          mergeStateStatus: "UNSTABLE",
          mergeable: "MERGEABLE",
          reviewDecision: null,
          updatedAt: "2026-09-26T07:44:31Z",
          commits: { nodes: [{ commit: {
            oid: HEAD_6878,
            committedDate: "2026-09-26T07:38:09Z",
            statusCheckRollup: { state: "FAILURE", contexts: { nodes: [
              { __typename: "CheckRun", name: "verification", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-09-26T07:38:29Z", completedAt: "2026-09-26T07:41:01Z", detailsUrl: "https://github.com/buildbetter-app/buildbetter/actions/runs/36227388936/job/108363903613" },
              { __typename: "CheckRun", name: "Cursor Approval Agent: Pull Request Router", status: "COMPLETED", conclusion: "NEUTRAL", startedAt: "2026-09-26T07:38:19Z", completedAt: "2026-09-26T07:38:20Z", detailsUrl: "https://cursor.com/agents/bc-404abe12" },
              { __typename: "CheckRun", name: "Cursor Security Agent: Security Reviewer", status: "COMPLETED", conclusion: "NEUTRAL", startedAt: "2026-09-26T07:38:19Z", completedAt: "2026-09-26T07:38:19Z", detailsUrl: "https://cursor.com/agents/bc-2630fa0b" },
              { __typename: "CheckRun", name: "[code]smith", status: "COMPLETED", conclusion: "SKIPPED", startedAt: "2026-09-26T07:38:19Z", completedAt: "2026-09-26T07:38:19Z", detailsUrl: "https://backend.blacksmith.sh/track/enable-autofix" }
            ] } }
          } }] },
          reviewThreads: { totalCount: 12, nodes: Array.from({ length: 12 }, () => codexThread()) },
          comments: { totalCount: 7, nodes: [
            { author: { login: "assert-app" }, createdAt: "2026-09-26T07:09:33Z", body: "**[Review on Assert →](https://app.assert.dev/review/github/buildbetter-app/buildbetter/6878)**" },
            { author: { login: "Spshulem" }, createdAt: "2026-09-26T07:09:37Z", body: "Push 1: `1336362a18` (M3, stacked on #6877). bb-quick on BuildBot3: compiles in 16.1 min." },
            { author: { login: "chatgpt-codex-connector" }, createdAt: "2026-09-26T07:09:44Z", body: "<!-- codex-pull-request-review-summary -->\n\n## Codex Review Summary\n\nThis comment shows the latest Codex review activity on this pull request.\n\n| Review | Status | Commit | Review trigger |\n| --- | --- | --- | --- |\n| 📝 **Code Review** | ✅ **Completed** <relative-time datetime=\"2026-09-26T07:44:31.171534Z\">2026-09-26T07:44:31.171534Z</relative-time> | `95720cc` | New commits |\n\n<details> <summary>ℹ️ About Codex in GitHub</summary>\n</details>" },
            { author: { login: "cursor" }, createdAt: "2026-09-26T07:09:48Z", body: "<h3>Bugbot couldn't run - usage limit reached</h3>" },
            { author: { login: "github-actions" }, createdAt: "2026-09-26T07:12:25Z", body: "<!-- ci-cost-run:36225923069-attempt:1 -->\n## PR verification runner cost" },
            { author: { login: "Spshulem" }, createdAt: "2026-09-26T07:38:17Z", body: "Push 2: `95720cc515`. Biome formatting only." },
            { author: { login: "github-actions" }, createdAt: "2026-09-26T07:41:30Z", body: "<!-- ci-cost-run:36227388936-attempt:1 -->\n## PR verification runner cost\n\n| 1 | failure | 2m 32s | $0.0203 |" }
          ] },
          files: { totalCount: 14, nodes: [
            { path: "packages/apps/web-app/src/v3/pages/ai-chat/components/chat/ChatActions.tsx" },
            { path: "packages/apps/web-app/src/v3/pages/ai-chat/components/surface/AiChatSurface.tsx" },
            { path: "packages/domain/chat/src/quick-agent.orchestrator.ts" },
            { path: "packages/domain/chat/src/quick-agent.prompts.ts" }
          ] }
        }
      },
      r1: {
        p108: {
          number: 108,
          url: "https://github.com/Spshulem/openAGI/pull/108",
          title: "Release OpenAGI 0.0.26 and G2 0.4.18",
          state: "MERGED",
          isDraft: false,
          headRefName: "codex/release-0.0.26",
          headRefOid: "6b2e7a4cf16d649f73d9e750c2396cbf490628f3",
          baseRefName: "main",
          mergeStateStatus: "UNKNOWN",
          mergeable: "UNKNOWN",
          reviewDecision: null,
          updatedAt: "2026-09-17T02:48:50Z",
          commits: { nodes: [{ commit: {
            oid: "6b2e7a4cf16d649f73d9e750c2396cbf490628f3",
            committedDate: "2026-09-17T02:48:16Z",
            statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [
              { __typename: "CheckRun", name: "verify", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-17T02:48:33Z", completedAt: "2026-09-17T02:50:10Z", detailsUrl: "https://github.com/Spshulem/openAGI/actions/runs/35175804252/job/105057126925" },
              { __typename: "CheckRun", name: "guarded-adapter", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-17T02:48:33Z", completedAt: "2026-09-17T02:48:46Z", detailsUrl: "https://github.com/Spshulem/openAGI/actions/runs/35175804357/job/105057127368" },
              { __typename: "CheckRun", name: "Cursor Bugbot", status: "COMPLETED", conclusion: "NEUTRAL", startedAt: "2026-09-17T02:48:36Z", completedAt: "2026-09-17T02:48:37Z", detailsUrl: "https://cursor.com/docs/bugbot" }
            ] } }
          } }] },
          reviewThreads: { totalCount: 0, nodes: [] },
          comments: { totalCount: 2, nodes: [
            { author: { login: "chatgpt-codex-connector" }, createdAt: "2026-09-17T02:48:33Z", body: "You have reached your Codex usage limits for code reviews." },
            { author: { login: "cursor" }, createdAt: "2026-09-17T02:48:38Z", body: "<h3>Bugbot couldn't run - usage limit reached</h3>" }
          ] },
          files: { totalCount: 65, nodes: [{ path: ".github/workflows/release-mac.yml" }, { path: "src/fleet/contracts.js" }] }
        }
      }
    }
  };
}

function fakeRun(responder) {
  const calls = [];
  const run = async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return responder(cmd, args, options, calls.length);
  };
  return { run, calls };
}

function ok(stdout) {
  return { code: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), stderr: "", timedOut: false, error: null };
}

test("buildPrQuery batches refs by repository with safe aliases", () => {
  const query = buildPrQuery([
    { repo: BBAPP, number: 6878 }, { repo: "Spshulem/openAGI", number: 108 }, { repo: BBAPP, number: 6849 }
  ]);
  assert.match(query, /r0: repository\(owner:"buildbetter-app",name:"buildbetter"\)\{ p6878: pullRequest\(number:6878\)\{\.\.\.P\} p6849: pullRequest\(number:6849\)\{\.\.\.P\} \}/);
  assert.match(query, /r1: repository\(owner:"Spshulem",name:"openAGI"\)\{ p108: pullRequest\(number:108\)\{\.\.\.P\} \}/);
  assert.match(query, /comments\(last:30\)\{nodes\{author\{login\} body createdAt\}\}/);
  assert.match(query, /files\(first:100\)\{nodes\{path\}\}/);
  assert.match(query, /statusCheckRollup\{state contexts\(first:30\)/);
  assert.match(query, /reviewThreads\(first:100\)/);
});

test("fetchPrStates normalizes the captured GraphQL response", async () => {
  const { run, calls } = fakeRun(() => ok(capturedResponse()));
  const prs = await fetchPrStates([`${BBAPP}#6878`, "Spshulem/openAGI#108"], config(), { run });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "/fake/gh");
  assert.deepEqual(calls[0].args.slice(0, 3), ["api", "graphql", "-f"]);
  assert.match(calls[0].args[3], /^query=/);

  const pr = prs.get(`${BBAPP}#6878`);
  assert.equal(pr.ref, `${BBAPP}#6878`);
  assert.equal(pr.repo, BBAPP);
  assert.equal(pr.number, 6878);
  assert.equal(pr.url, "https://github.com/buildbetter-app/buildbetter/pull/6878");
  assert.equal(pr.state, "OPEN");
  assert.equal(pr.isDraft, false);
  assert.equal(pr.headRef, "feature/ai-chat-inline-connect");
  assert.equal(pr.headOid, HEAD_6878);
  assert.equal(pr.baseRef, "feature/ai-chat-credits-fallback-and-rerun");
  assert.equal(pr.mergeState, "UNSTABLE");
  assert.equal(pr.mergeable, "MERGEABLE");
  assert.equal(pr.reviewDecision, null);
  assert.deepEqual(pr.ci, { state: "FAILURE", failing: ["verification"], pending: [] });
  assert.equal(pr.unresolvedThreads, 12);
  assert.deepEqual(pr.codexReview, { reviewedHead: true, sha: "95720cc" });
  assert.deepEqual(pr.qa, { required: true, freshOnHead: false, sha: null });
  assert.equal(pr.updatedAt, "2026-09-26T07:44:31Z");

  const merged = prs.get("Spshulem/openAGI#108");
  assert.equal(merged.state, "MERGED");
  assert.deepEqual(merged.ci, { state: "SUCCESS", failing: [], pending: [] });
  assert.equal(merged.unresolvedThreads, 0);
  // A usage-limit notice is not a review summary.
  assert.deepEqual(merged.codexReview, { reviewedHead: null, sha: null });
  assert.deepEqual(merged.qa, { required: null, freshOnHead: null, sha: null });
});

test("fetchPrStates dedupes, skips bad refs, and batches 20 refs per call", async () => {
  const refs = Array.from({ length: 25 }, (_, index) => `${BBAPP}#${7000 + index}`);
  const { run, calls } = fakeRun(() => ok({ data: {} }));
  const prs = await fetchPrStates([...refs, refs[0], "garbage", null], config(), { run });
  assert.equal(prs.size, 0);
  assert.equal(calls.length, 2);
  assert.equal((calls[0].args[3].match(/pullRequest\(/g) ?? []).length, 20);
  assert.equal((calls[1].args[3].match(/pullRequest\(/g) ?? []).length, 5);

  const empty = fakeRun(() => ok({ data: {} }));
  assert.equal((await fetchPrStates([], config(), { run: empty.run })).size, 0);
  assert.equal(empty.calls.length, 0);
});

test("fetchPrStates keeps known PRs when GraphQL reports an unknown ref", async () => {
  const response = capturedResponse();
  response.data.r0.p999999 = null;
  response.errors = [{
    type: "NOT_FOUND", path: ["r0", "p999999"], locations: [{ line: 1, column: 1 }],
    message: "Could not resolve to a PullRequest with the number of 999999."
  }];
  // gh exits 1 on GraphQL errors but still prints the body.
  const { run } = fakeRun(() => ({ ...ok(response), code: 1, stderr: "gh: Could not resolve to a PullRequest" }));
  const prs = await fetchPrStates([`${BBAPP}#6878`, `${BBAPP}#999999`], config(), { run });
  assert.equal(prs.has(`${BBAPP}#6878`), true);
  assert.equal(prs.has(`${BBAPP}#999999`), false);
});

test("fetchPrStates degrades to an empty map on failures", async () => {
  const refs = [`${BBAPP}#6878`];
  for (const result of [
    { code: 1, stdout: "", stderr: "HTTP 502", timedOut: false, error: null },
    { code: 0, stdout: "not json", stderr: "", timedOut: false, error: null },
    { code: null, stdout: "", stderr: "", timedOut: true, error: null },
    { code: null, stdout: "", stderr: "", timedOut: false, error: "spawn gh ENOENT" }
  ]) {
    const prs = await fetchPrStates(refs, config(), { run: async () => result });
    assert.equal(prs.size, 0);
  }
  const prs = await fetchPrStates(refs, config(), { run: async () => { throw new Error("boom"); } });
  assert.equal(prs.size, 0);
});

test("CI summary picks the latest run per check and lists pending checks", async () => {
  const response = capturedResponse();
  const commit = response.data.r0.p6878.commits.nodes[0].commit;
  commit.statusCheckRollup = { state: "PENDING", contexts: { nodes: [
    { __typename: "CheckRun", name: "verification", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-09-26T07:38:29Z", completedAt: "2026-09-26T07:41:01Z" },
    { __typename: "CheckRun", name: "verification", status: "IN_PROGRESS", conclusion: null, startedAt: "2026-09-26T07:50:00Z", completedAt: null },
    { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "TIMED_OUT", startedAt: "2026-09-26T07:38:29Z", completedAt: "2026-09-26T07:48:29Z" },
    { __typename: "StatusContext", context: "ci/legacy", state: "ERROR" },
    { __typename: "StatusContext", context: "ci/pending", state: "PENDING" },
    { __typename: "CheckRun", name: "Cursor Bugbot", status: "COMPLETED", conclusion: "NEUTRAL", startedAt: "2026-09-26T07:38:29Z" }
  ] } };
  const { run } = fakeRun(() => ok(response));
  const pr = (await fetchPrStates([`${BBAPP}#6878`], config(), { run })).get(`${BBAPP}#6878`);
  assert.deepEqual(pr.ci, { state: "PENDING", failing: ["lint", "ci/legacy"], pending: ["verification", "ci/pending"] });
});

test("CI is unknown when the last commit is not the PR head or has no checks", async () => {
  const stale = capturedResponse();
  stale.data.r0.p6878.commits.nodes[0].commit.oid = "1336362a18000000000000000000000000000000";
  let pr = (await fetchPrStates([`${BBAPP}#6878`], config(), { run: fakeRun(() => ok(stale)).run })).get(`${BBAPP}#6878`);
  assert.deepEqual(pr.ci, { state: null, failing: [], pending: [] });

  const none = capturedResponse();
  none.data.r0.p6878.commits.nodes[0].commit.statusCheckRollup = null;
  pr = (await fetchPrStates([`${BBAPP}#6878`], config(), { run: fakeRun(() => ok(none)).run })).get(`${BBAPP}#6878`);
  assert.deepEqual(pr.ci, { state: null, failing: [], pending: [] });
});

test("Codex review on an older commit or still running is not on head", async () => {
  const older = capturedResponse();
  const summary = older.data.r0.p6878.comments.nodes[2];
  summary.body = summary.body.replace("`95720cc`", "`1336362`");
  let pr = (await fetchPrStates([`${BBAPP}#6878`], config(), { run: fakeRun(() => ok(older)).run })).get(`${BBAPP}#6878`);
  assert.deepEqual(pr.codexReview, { reviewedHead: false, sha: "1336362" });

  const running = capturedResponse();
  const body = running.data.r0.p6878.comments.nodes[2];
  body.body = body.body.replace("✅ **Completed**", "👀 **In progress**");
  pr = (await fetchPrStates([`${BBAPP}#6878`], config(), { run: fakeRun(() => ok(running)).run })).get(`${BBAPP}#6878`);
  assert.deepEqual(pr.codexReview, { reviewedHead: false, sha: "95720cc" });
});

test("QA evidence comes from the latest screenshots comment for this PR", async () => {
  const response = capturedResponse();
  const comments = response.data.r0.p6878.comments.nodes;
  comments.push(
    { author: { login: "Spshulem" }, createdAt: "2026-09-26T07:20:00Z", body: "**Screenshots** (PR box `pr6878` on `1336362a18`, staging restore)\n![a](https://raw.githubusercontent.com/x.png)" },
    { author: { login: "Spshulem" }, createdAt: "2026-09-26T07:30:00Z", body: "**Screenshots** (PR box `pr6536` on `95720cc515`)" }
  );
  let pr = (await fetchPrStates([`${BBAPP}#6878`], config(), { run: fakeRun(() => ok(response)).run })).get(`${BBAPP}#6878`);
  assert.deepEqual(pr.qa, { required: true, freshOnHead: false, sha: "1336362a18" });

  comments.push({ author: { login: "Spshulem" }, createdAt: "2026-09-26T07:50:00Z", body: "**Screenshots** (PR box `pr6878` on `95720cc515`)" });
  pr = (await fetchPrStates([`${BBAPP}#6878`], config(), { run: fakeRun(() => ok(response)).run })).get(`${BBAPP}#6878`);
  assert.deepEqual(pr.qa, { required: true, freshOnHead: true, sha: "95720cc515" });
});

test("QA is not required without UI files and uses configured prefixes per repo", async () => {
  const response = capturedResponse();
  response.data.r0.p6878.files.nodes = [{ path: "packages/domain/chat/src/quick-agent.prompts.ts" }];
  let pr = (await fetchPrStates([`${BBAPP}#6878`], config(), { run: fakeRun(() => ok(response)).run })).get(`${BBAPP}#6878`);
  assert.deepEqual(pr.qa, { required: false, freshOnHead: false, sha: null });

  const custom = { ...config(), uiPathPrefixes: { "Spshulem/openAGI": ["src/fleet/"] } };
  const both = [`${BBAPP}#6878`, "Spshulem/openAGI#108"];
  pr = (await fetchPrStates(both, custom, { run: fakeRun(() => ok(capturedResponse())).run })).get("Spshulem/openAGI#108");
  assert.equal(pr.qa.required, true);
  assert.ok(DEFAULT_UI_PATH_PREFIXES[BBAPP].includes("packages/apps/web-app/"));
});

test("findPrForBranch prefers an open PR, then the newest", async () => {
  const rows = [
    { number: 6801, state: "MERGED", updatedAt: "2026-09-26T08:00:00Z" },
    { number: 6878, state: "OPEN", updatedAt: "2026-09-26T07:44:31Z" },
    { number: 6700, state: "CLOSED", updatedAt: "2026-09-20T00:00:00Z" }
  ];
  const { run, calls } = fakeRun(() => ok(rows));
  assert.equal(await findPrForBranch(BBAPP, "feature/ai-chat-inline-connect", config(), { run }), `${BBAPP}#6878`);
  assert.equal(calls[0].cmd, "/fake/gh");
  assert.deepEqual(calls[0].args, [
    "pr", "list", "--repo", BBAPP, "--head", "feature/ai-chat-inline-connect", "--state", "all", "--json", "number,state,updatedAt"
  ]);

  const closedOnly = fakeRun(() => ok([rows[0], rows[2]]));
  assert.equal(await findPrForBranch(BBAPP, "b", config(), { run: closedOnly.run }), `${BBAPP}#6801`);
});

test("findPrForBranch returns null for bad input, no PRs, or failures", async () => {
  const { run, calls } = fakeRun(() => ok([]));
  assert.equal(await findPrForBranch(BBAPP, "feature/x", config(), { run }), null);
  assert.equal(await findPrForBranch("not a repo", "feature/x", config(), { run }), null);
  assert.equal(await findPrForBranch(BBAPP, "HEAD", config(), { run }), null);
  assert.equal(await findPrForBranch(BBAPP, "main", config(), { run }), null);
  assert.equal(await findPrForBranch(BBAPP, "-x", config(), { run }), null);
  assert.equal(await findPrForBranch(BBAPP, "", config(), { run }), null);
  assert.equal(calls.length, 1);
  assert.equal(await findPrForBranch(BBAPP, "b", config(), { run: async () => ({ code: 1, stdout: "", stderr: "x" }) }), null);
  assert.equal(await findPrForBranch(BBAPP, "b", config(), { run: async () => { throw new Error("boom"); } }), null);
});

function gitRunner(table) {
  return fakeRun((cmd, args) => {
    const key = args.slice(2).join(" ");
    return key in table ? ok(`${table[key]}\n`) : { code: 128, stdout: "", stderr: "fatal", timedOut: false, error: null };
  });
}

test("readLocalGit reads head, branch, upstream, ahead, and remote", async () => {
  const { run, calls } = gitRunner({
    "rev-parse HEAD": HEAD_6878,
    "rev-parse --abbrev-ref HEAD": "feature/ai-chat-inline-connect",
    "rev-parse --abbrev-ref @{u}": "origin/feature/ai-chat-inline-connect",
    "rev-list --count @{u}..HEAD": "2",
    "remote get-url origin": "https://github.com/buildbetter-app/buildbetter.git"
  });
  const git = await readLocalGit("/work/tree", config(), { run });
  assert.deepEqual(git, {
    head: HEAD_6878, branch: "feature/ai-chat-inline-connect", upstream: "origin/feature/ai-chat-inline-connect", ahead: 2, remote: BBAPP
  });
  assert.equal(calls[0].cmd, "/fake/git");
  assert.deepEqual(calls[0].args.slice(0, 2), ["-C", "/work/tree"]);
});

test("readLocalGit handles detached heads and missing upstreams", async () => {
  const { run } = gitRunner({
    "rev-parse HEAD": HEAD_6878,
    "rev-parse --abbrev-ref HEAD": "HEAD",
    "remote get-url origin": "git@github.com:Spshulem/openAGI.git"
  });
  assert.deepEqual(await readLocalGit("/work/tree", config(), { run }), {
    head: HEAD_6878, branch: null, upstream: null, ahead: null, remote: "Spshulem/openAGI"
  });
});

test("readLocalGit returns all null for a missing dir or a throwing runner", async () => {
  const empty = { head: null, branch: null, upstream: null, ahead: null, remote: null };
  const { run, calls } = gitRunner({});
  assert.deepEqual(await readLocalGit("/gone", config(), { run }), empty);
  assert.equal(calls.length, 1);
  assert.deepEqual(await readLocalGit(null, config(), { run }), empty);
  assert.deepEqual(await readLocalGit("/x", config(), { run: async () => { throw new Error("EPERM"); } }), empty);
});
