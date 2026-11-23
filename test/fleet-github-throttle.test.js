import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GithubThrottle, classifyGithubThrottle, throttledGh } from "../src/fleet/github-throttle.js";
import { executeSafePrMerge } from "../src/fleet/intent-resolver.js";
import { fetchPrStates, findPrForBranch } from "../src/fleet/sources/github.js";
import { inspectRepoStatus } from "../src/fleet/coordinator.js";

// The errors gh printed on 2026-11-22 while the account's GraphQL budget was
// used up (the user ID here is a placeholder).
const PRIMARY_TEXT = "GraphQL: API rate limit already exceeded for user ID 1234567.";
const PRIMARY_JSON = JSON.stringify({ errors: [{ type: "RATE_LIMIT", code: "graphql_rate_limit", message: "API rate limit already exceeded for user ID 1234567." }] });
const T0 = Date.parse("2026-11-22T20:38:30.000Z");
const RESET = "2026-11-22T21:00:37Z";

function clock(start = T0) {
  const now = { value: start };
  return { now, fn: () => now.value };
}

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gh-throttle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A gh stand-in: answers the rateLimit probe, counts every other call.
function ghStub({ probeRemaining = 0, probeReset = RESET, answer = () => ({ code: 0, stdout: "[]", stderr: "" }) } = {}) {
  const calls = [];
  const run = async (bin, args) => {
    const joined = args.join(" ");
    if (joined.includes("rateLimit { remaining resetAt }")) {
      calls.push("probe");
      return { code: 0, stdout: JSON.stringify({ data: { rateLimit: { remaining: probeRemaining, resetAt: probeReset } } }), stderr: "" };
    }
    calls.push(joined);
    return answer(args);
  };
  return { run, calls };
}

test("primary and secondary limits are told apart from gh's own words", () => {
  assert.deepEqual(classifyGithubThrottle(PRIMARY_TEXT), { kind: "primary", retryAfterSec: null });
  assert.equal(classifyGithubThrottle(`Exit code 1 ${PRIMARY_JSON}`).kind, "primary");
  assert.deepEqual(classifyGithubThrottle("HTTP 403: You have exceeded a secondary rate limit.\nretry-after: 90"), { kind: "secondary", retryAfterSec: 90 });
  assert.equal(classifyGithubThrottle("HTTP 404: Not Found"), null);
  assert.equal(classifyGithubThrottle("could not resolve host"), null);
});

test("a used-up budget probes GitHub once for its reset, then nobody calls until then", async () => {
  const { now, fn } = clock();
  const throttle = new GithubThrottle({ now: fn });
  const gh = ghStub({ answer: () => ({ code: 1, stdout: "", stderr: PRIMARY_TEXT }) });
  const first = await throttledGh(gh.run, "gh", ["pr", "view", "321"], {}, { throttle });
  assert.equal(first.throttled, true);
  assert.equal(throttle.current().kind, "primary");
  assert.equal(throttle.current().resetKnown, true);
  assert.equal(throttle.current().until, new Date(Date.parse(RESET) + 5_000).toISOString());
  // Ten more callers in the window: none reaches GitHub, none probes again.
  for (let i = 0; i < 10; i += 1) {
    const held = await throttledGh(gh.run, "gh", ["pr", "list", String(i)], {}, { throttle });
    assert.equal(held.throttled, true);
    assert.match(held.stderr, /used up until 21:00 UTC/);
  }
  assert.deepEqual(gh.calls, ["pr view 321", "probe"]);
  now.value = Date.parse(RESET) + 6_000;
  await throttledGh(gh.run, "gh", ["pr", "list", "x"], {}, { throttle });
  // After the reset the next call goes through; still refused, it starts a
  // new cooldown with its own single probe.
  assert.deepEqual(gh.calls.slice(2), ["pr list x", "probe"]);
});

test("with no reset time from GitHub the cooldown is an estimate and backs off", async () => {
  const { fn } = clock();
  const throttle = new GithubThrottle({ now: fn });
  const run = async () => ({ code: 1, stdout: "", stderr: PRIMARY_TEXT });
  await throttledGh(run, "gh", ["pr", "view", "1"], {}, { throttle });
  const cooldown = throttle.current();
  assert.equal(cooldown.resetKnown, false);
  assert.equal(Date.parse(cooldown.until) - T0, 5 * 60_000);
  assert.match(throttle.describe(), /estimated/);
});

test("the cooldown survives a restart, and an expired one does not", (t) => {
  const dir = tmp(t);
  const file = path.join(dir, "fleet", "github-throttle.json");
  const { now, fn } = clock();
  const first = new GithubThrottle({ now: fn, file });
  first.enter("primary", { resetAt: RESET });
  const restarted = new GithubThrottle({ now: fn, file });
  assert.equal(restarted.current()?.kind, "primary");
  now.value = Date.parse(RESET) + 60_000;
  assert.equal(new GithubThrottle({ now: fn, file }).current(), null);
});

test("a low budget pauses background polling but not the owner's own actions, and a new window clears it", async () => {
  const { fn } = clock();
  const throttle = new GithubThrottle({ now: fn, floor: 150 });
  const low = JSON.stringify({ data: { rateLimit: { cost: 3, remaining: 90, resetAt: RESET } } });
  await throttledGh(async () => ({ code: 0, stdout: low, stderr: "" }), "gh", ["api", "graphql"], {}, { throttle });
  assert.equal(throttle.current().kind, "low-budget");
  assert.ok(throttle.blocking({ background: true }));
  assert.equal(throttle.blocking({ background: false }), null);
  throttle.noteBudget({ remaining: 4900, resetAt: "2026-11-22T22:00:00Z" });
  assert.equal(throttle.current(), null);
});

test("a secondary limit honours Retry-After (at least a minute) and doubles on repeats", () => {
  const { fn } = clock();
  const throttle = new GithubThrottle({ now: fn });
  throttle.observe({ code: 1, stderr: "You have exceeded a secondary rate limit\nretry-after: 120" });
  assert.equal(Date.parse(throttle.current().until) - T0, 120_000);
  throttle.observe({ code: 1, stderr: "You have exceeded a secondary rate limit" });
  assert.equal(Date.parse(throttle.current().until) - T0, 120_000, "a shorter repeat never shortens the hold");
  throttle.observe({ code: 1, stderr: "You have exceeded a secondary rate limit\nretry-after: 100" });
  assert.equal(Date.parse(throttle.current().until) - T0, 400_000);
});

test("identical reads in flight are shared; a mutation never is", async () => {
  const throttle = new GithubThrottle();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const run = async () => { calls += 1; await gate; return { code: 0, stdout: "[]", stderr: "" }; };
  const reads = [1, 2, 3].map(() => throttledGh(run, "gh", ["pr", "list", "--head", "b"], {}, { throttle }));
  const writes = [1, 2].map(() => throttledGh(run, "gh", ["pr", "merge", "321"], {}, { throttle, coalesce: false }));
  release();
  await Promise.all([...reads, ...writes]);
  assert.equal(calls, 3, "one shared read + two separate merges");
});

test("the scan's PR pollers stop asking while the budget is used up", async () => {
  const throttle = new GithubThrottle();
  throttle.enter("primary", { resetAt: new Date(Date.now() + 30 * 60_000).toISOString() });
  let calls = 0;
  const run = async () => { calls += 1; return { code: 0, stdout: "{}", stderr: "" }; };
  const unread = new Set();
  const config = { bins: { gh: "gh" } };
  const prs = await fetchPrStates(["Spshulem/openAGI#321"], config, { run, unread, throttle });
  assert.equal(prs.size, 0);
  assert.deepEqual([...unread], ["Spshulem/openAGI#321"]);
  await assert.rejects(findPrForBranch("Spshulem/openAGI", "feature-x", config, { run, throttle }), /rate limit for this account is used up/);
  assert.equal(calls, 0);
});

const GREEN_PR = {
  state: "OPEN", isDraft: false, headRefOid: "abc1234567890", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED", statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }], url: "https://github.com/Spshulem/openAGI/pull/321"
};

test("Merge during a cooldown sends nothing to GitHub and says when to try", async () => {
  const { fn } = clock();
  const throttle = new GithubThrottle({ now: fn });
  throttle.enter("primary", { resetAt: RESET });
  const gh = ghStub();
  const out = await executeSafePrMerge({ prRef: "Spshulem/openAGI#321", expectedHeadSha: "abc1234", ownerConfirmed: true, run: gh.run, throttle });
  assert.equal(out.status, "halted");
  assert.equal(out.reason, "github_rate_limited");
  assert.equal(out.mergeConfirmed, false);
  assert.equal(out.retryAt, new Date(Date.parse(RESET) + 5_000).toISOString());
  assert.match(out.detail, /^Not merged: Spshulem\/openAGI#321\./);
  assert.match(out.detail, /Nothing was sent to GitHub/);
  assert.match(out.detail, /re-checks the PR/);
  assert.deepEqual(gh.calls, []);
});

test("a throttled preflight sends no merge; a throttled merge is not retried, not overridden, and not confirmed", async () => {
  const { now, fn } = clock();
  const throttle = new GithubThrottle({ now: fn });
  const preflight = ghStub({ answer: () => ({ code: 1, stdout: "", stderr: PRIMARY_TEXT }) });
  const halted = await executeSafePrMerge({ prRef: "Spshulem/openAGI#321", ownerConfirmed: true, run: preflight.run, throttle });
  assert.equal(halted.reason, "github_rate_limited");
  assert.match(halted.detail, /refused the pre-merge check, so no merge was sent/);
  assert.equal(preflight.calls.some((c) => c.startsWith("pr merge")), false);

  // Window over: the owner taps Merge again. The preflight runs fresh; the
  // merge itself is refused for the limit.
  now.value = Date.parse(RESET) + 10_000;
  const merging = ghStub({
    answer: (args) => args[1] === "view"
      ? { code: 0, stdout: JSON.stringify({ ...GREEN_PR, mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }), stderr: "" }
      : { code: 1, stdout: "", stderr: PRIMARY_TEXT }
  });
  const refused = await executeSafePrMerge({ prRef: "Spshulem/openAGI#321", expectedHeadSha: "abc1234", ownerConfirmed: true, run: merging.run, throttle });
  assert.equal(refused.reason, "github_rate_limited");
  assert.equal(refused.mergeConfirmed, false);
  assert.match(refused.detail, /refused the merge request itself; no merge is confirmed/);
  const merges = merging.calls.filter((c) => c.startsWith("pr merge"));
  assert.equal(merges.length, 1, "no second merge and no --admin override after a throttle");
  assert.match(merges[0], /--match-head-commit abc1234567890/);
  assert.equal(merging.calls.some((c) => c.startsWith("pr checks")), false);
});

test("after the cooldown a merge still runs the full preflight and pins the exact head", async () => {
  const { now, fn } = clock();
  const throttle = new GithubThrottle({ now: fn });
  throttle.enter("primary", { resetAt: RESET });
  now.value = Date.parse(RESET) + 10_000;
  const gh = ghStub({ answer: (args) => args[1] === "view" ? { code: 0, stdout: JSON.stringify(GREEN_PR), stderr: "" } : { code: 0, stdout: "Merged", stderr: "" } });
  const out = await executeSafePrMerge({ prRef: "Spshulem/openAGI#321", expectedHeadSha: "abc1234", ownerConfirmed: true, run: gh.run, throttle });
  assert.equal(out.status, "merged");
  assert.ok(gh.calls[0].startsWith("pr view 321"));
  assert.match(gh.calls[1], /^pr merge 321 .*--match-head-commit abc1234567890/);
});

test("repo status during a cooldown says it is GitHub's limit, not the fleet computer", async () => {
  const throttle = new GithubThrottle();
  throttle.enter("primary", { resetAt: new Date(Date.now() + 20 * 60_000).toISOString() });
  let calls = 0;
  const supervisor = { githubThrottle: throttle, config: { bins: { gh: "gh" } }, knownThreads: new Map(), lastThreads: new Map() };
  await assert.rejects(
    inspectRepoStatus(supervisor, { repo: "Spshulem/openAGI", run: async () => { calls += 1; return { code: 0, stdout: "[]" }; } }),
    /GitHub not queried: .*used up until .* not the fleet computer being offline/
  );
  assert.equal(calls, 0);
});

// #351 review (Codex P2): two reads in flight; a delayed answer from the same
// window must not lift the cooldown a newer answer set.
test("a delayed same-window response never lifts a newer cooldown; a later window does", () => {
  const { fn } = clock();
  const throttle = new GithubThrottle({ now: fn, floor: 150 });
  const answer = (remaining, resetAt) => ({ code: 0, stdout: JSON.stringify({ data: { rateLimit: { remaining, resetAt } } }) });
  throttle.observe(answer(0, RESET));
  assert.equal(throttle.current()?.kind, "primary");
  throttle.observe(answer(200, RESET));
  assert.equal(throttle.current()?.kind, "primary", "still held: same window");
  throttle.observe(answer(4900, "2026-11-22T22:00:37Z"));
  assert.equal(throttle.current(), null, "a new window lifts it");
});
