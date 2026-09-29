import test from "node:test";
import assert from "node:assert/strict";
import {
  IN_SCOPE_ASK_PATTERNS, OUT_OF_SCOPE_PATTERNS, WAITING_PATTERNS, classifyThread, mergeThreads, prReadiness, threadHealth
} from "../src/fleet/classify.js";
import { DEFAULTS, STATES } from "../src/fleet/contracts.js";

const MIN = 60_000;
const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const HEAD = "a".repeat(40);
const config = { mode: "observe", selfSessionIds: ["self-session"], limits: { ...DEFAULTS } };

function makeThread(overrides = {}) {
  return {
    key: "conductor:s1", kind: "conductor", id: "s1", title: "Fix billing", cwd: "/work/madrid", repo: "acme/app",
    branch: "spencer/fix", workspace: "madrid", claudeSessionId: "c1", agentStatus: "idle",
    lastActivityAt: ago(30 * MIN), lastAgentText: "Pushed the fix.", lastAgentAt: ago(30 * MIN),
    lastUserText: "continue", lastUserAt: ago(60 * MIN), error: null, openTasks: [], prRefs: ["acme/app#6522"],
    live: null, writerLocked: false, archived: false, excluded: null, meta: {}, ...overrides
  };
}

function makePr(overrides = {}) {
  return {
    ref: "acme/app#6522", repo: "acme/app", number: 6522, url: "https://github.com/acme/app/pull/6522", title: "Fix",
    state: "OPEN", isDraft: false, headRef: "spencer/fix", headOid: HEAD, baseRef: "main", mergeState: "CLEAN",
    mergeable: "MERGEABLE", reviewDecision: "APPROVED", ci: { state: "SUCCESS", failing: [], pending: [] },
    unresolvedThreads: 0, codexReview: { reviewedHead: true, sha: "aaaaaaa" }, qa: { required: false, freshOnHead: null, sha: null },
    updatedAt: ago(0), ...overrides
  };
}

const cleanGit = { head: HEAD, branch: "spencer/fix", upstream: "origin/spencer/fix", ahead: 0, remote: "acme/app" };
const classify = (thread, extra = {}) => classifyThread(thread, { pr: makePr(), localGit: cleanGit, infra: null, now: NOW, config, ...extra });

test("mergeThreads folds a Claude transcript into its Conductor session", () => {
  const conductor = makeThread({ prRefs: [], live: null, error: null, lastAgentText: "", cwd: null, branch: null, lastUserAt: ago(50 * MIN) });
  const claude = makeThread({
    key: "claude:c1", kind: "claude", id: "c1", claudeSessionId: "c1", agentStatus: "idle", prRefs: ["acme/app#6522", "acme/app#6500"],
    live: { peerName: "madrid-1a", pid: 42, status: "idle" }, error: { kind: "session-limit", text: "x", resetAt: null },
    lastAgentText: "Pushed.", cwd: "/work/madrid", branch: "spencer/fix", lastUserAt: ago(5 * MIN), lastUserText: "go"
  });
  const other = makeThread({ key: "claude:c9", kind: "claude", id: "c9", claudeSessionId: "c9" });
  const codex = makeThread({ key: "codex:x1", kind: "codex", id: "x1", claudeSessionId: null });
  const merged = mergeThreads({ codex: [codex], claude: [claude, other], conductor: [conductor] });
  assert.deepEqual(merged.map((t) => t.key).sort(), ["claude:c9", "codex:x1", "conductor:s1"]);
  const m = merged.find((t) => t.key === "conductor:s1");
  assert.equal(m.kind, "conductor");
  assert.equal(m.agentStatus, "idle");
  assert.deepEqual(m.prRefs, ["acme/app#6522", "acme/app#6500"]);
  assert.equal(m.live.peerName, "madrid-1a");
  assert.equal(m.error.kind, "session-limit");
  assert.equal(m.lastAgentText, "Pushed.");
  assert.equal(m.cwd, "/work/madrid");
  assert.equal(m.branch, "spencer/fix");
  // The newer owner message wins so the owner-recent guard sees it.
  assert.equal(m.lastUserAt, ago(5 * MIN));
  // Inputs are not mutated.
  assert.deepEqual(conductor.prRefs, []);
});

test("mergeThreads keeps the Conductor error and status when it has its own", () => {
  const conductor = makeThread({ agentStatus: "waiting", error: { kind: "overloaded", text: "529", resetAt: null } });
  const claude = makeThread({ key: "claude:c1", kind: "claude", id: "c1", agentStatus: "idle", error: { kind: "network", text: "x", resetAt: null } });
  const [m] = mergeThreads({ claude: [claude], conductor: [conductor] });
  assert.equal(m.agentStatus, "waiting");
  assert.equal(m.error.kind, "overloaded");
});

test("prReadiness reports exact blocker strings", () => {
  const blockersOf = (prOver, git = cleanGit) => prReadiness(makePr(prOver), git).blockers;
  assert.deepEqual(blockersOf({}), []);
  assert.deepEqual(blockersOf({ ci: { state: "FAILURE", failing: ["verification", "lint"], pending: [] } }), ["CI red: verification, lint"]);
  assert.deepEqual(blockersOf({ ci: { state: "PENDING", failing: [], pending: ["verification"] } }), ["CI running"]);
  assert.deepEqual(blockersOf({ ci: { state: null, failing: [], pending: [] } }), ["no CI on head"]);
  assert.deepEqual(blockersOf({}, { ...cleanGit, ahead: 2, head: "b".repeat(40) }), ["unpushed commits"]);
  assert.deepEqual(blockersOf({}, { ...cleanGit, head: "c".repeat(40) }), ["local head differs"]);
  // A worktree on another branch says nothing about this PR's head.
  assert.deepEqual(blockersOf({}, { ...cleanGit, branch: "other", head: "c".repeat(40), ahead: 3 }), []);
  assert.deepEqual(blockersOf({ unresolvedThreads: 4 }), ["4 open threads"]);
  assert.deepEqual(blockersOf({ mergeState: "DIRTY", mergeable: "CONFLICTING" }), ["merge conflicts"]);
  assert.deepEqual(blockersOf({ codexReview: { reviewedHead: false, sha: "bbbbbbb" } }), ["Codex review not on head"]);
  assert.deepEqual(blockersOf({ codexReview: { reviewedHead: null, sha: null } }), []);
  assert.deepEqual(blockersOf({ qa: { required: true, freshOnHead: false, sha: "old" } }), ["UI QA missing"]);
  assert.deepEqual(blockersOf({ qa: { required: true, freshOnHead: true, sha: "aaaa" } }), []);
  assert.deepEqual(blockersOf({ isDraft: true }), ["draft"]);
});

test("a green, mergeable PR that GitHub reports BEHIND is not ready", () => {
  const behind = prReadiness(makePr({ mergeState: "BEHIND", mergeable: "MERGEABLE" }), cleanGit);
  assert.equal(behind.ready, false);
  assert.equal(behind.onlyHumanLeft, false);
  assert.deepEqual(behind.blockers, ["branch behind base"]);
  assert.equal(classify(makeThread(), { pr: makePr({ mergeState: "BEHIND" }) }).state, "pr-not-ready");
  // A conflict already names the work; behind is not listed twice.
  assert.deepEqual(prReadiness(makePr({ mergeState: "DIRTY", mergeable: "CONFLICTING" }), cleanGit).blockers, ["merge conflicts"]);
});

test("prReadiness separates ready, only-human-left, and progress marks", () => {
  const ready = prReadiness(makePr(), cleanGit);
  assert.equal(ready.ready, true);
  assert.equal(ready.onlyHumanLeft, false);
  assert.deepEqual(ready.progressMark, { head: HEAD, unresolved: 0 });

  const human = prReadiness(makePr({ reviewDecision: "REVIEW_REQUIRED", mergeState: "BLOCKED" }), cleanGit);
  assert.equal(human.ready, false);
  assert.equal(human.onlyHumanLeft, true);
  assert.deepEqual(human.blockers, []);

  const red = prReadiness(makePr({ unresolvedThreads: 2, mergeState: "BLOCKED" }), cleanGit);
  assert.equal(red.ready, false);
  assert.equal(red.onlyHumanLeft, false);

  const none = prReadiness(null, cleanGit);
  assert.equal(none.ready, false);
  assert.deepEqual(none.progressMark, { head: HEAD, unresolved: null });
  const merged = prReadiness(makePr({ state: "MERGED" }), cleanGit);
  assert.equal(merged.ready, false);
  assert.deepEqual(merged.blockers, []);
});

test("classifyThread: excluded threads, including the supervisor itself", () => {
  assert.equal(classify(makeThread({ excluded: "automation" })).state, "excluded");
  assert.equal(classify(makeThread({ archived: true })).state, "excluded");
  assert.equal(classify(makeThread({ id: "self-session" })).state, "excluded");
  assert.equal(classify(makeThread({ claudeSessionId: "self-session" })).reason, "self");
  const noRepo = makeThread({ repo: null, branch: null, prRefs: [] });
  assert.equal(classifyThread(noRepo, { pr: null, localGit: null, now: NOW, config }).state, "excluded");
});

test("classifyThread: running beats every other signal", () => {
  const running = makeThread({ agentStatus: "running", error: { kind: "overloaded", text: "529", resetAt: null }, lastAgentText: "Want me to push?" });
  assert.equal(classify(running).state, "running");
  const busyPeer = makeThread({ kind: "claude", key: "claude:c2", live: { peerName: "x", pid: 1, status: "busy" } });
  assert.equal(classify(busyPeer).state, "running");
  const unknownRecent = makeThread({ agentStatus: "unknown", lastActivityAt: ago(2 * MIN) });
  assert.equal(classify(unknownRecent).state, "running");
});

test("classifyThread: infra errors, codex-lb log errors, and BuildBot3-down text", () => {
  const limit = classify(makeThread({ agentStatus: "error", error: { kind: "session-limit", text: "You've hit your session limit", resetAt: ago(-60 * MIN) } }));
  assert.equal(limit.state, "infra-blocked");
  assert.equal(limit.infraKind, "session-limit");
  // "other" errors are not infra: the PR state decides.
  assert.equal(classify(makeThread({ agentStatus: "error", error: { kind: "other", text: "boom", resetAt: null } })).state, "ready-needs-human");
  const codex = makeThread({ key: "codex:x1", kind: "codex", id: "x1", agentStatus: "stalled" });
  const infra = { lb: { healthy: false, recentErrors: [{ kind: "connection", count: 12, lastAt: ago(MIN), threadIds: ["x1"] }] } };
  const lb = classify(codex, { infra });
  assert.equal(lb.state, "infra-blocked");
  assert.equal(lb.infraKind, "lb");
  const bb3 = classify(makeThread({ lastAgentText: "BuildBot3 is unreachable: SSH and ping both time out. I'll retry when it is back." }));
  assert.equal(bb3.state, "infra-blocked");
  assert.equal(bb3.infraKind, "bb3");
});

test("classifyThread: waiting on CI from a background task or from the agent's last words", () => {
  const task = { id: "t1", description: "Run bb-quick on fixed candidate", kind: "local_bash", startedAt: ago(20 * MIN) };
  const waiting = classify(makeThread({ agentStatus: "waiting", openTasks: [task] }));
  assert.equal(waiting.state, "waiting-ci");
  assert.equal(waiting.wait.source, "task");
  assert.equal(waiting.wait.taskKind, "quick");
  assert.equal(waiting.wait.ageMs, 20 * MIN);
  assert.equal(waiting.infraKind, "bb3");
  const full = classify(makeThread({ agentStatus: "waiting", openTasks: [{ ...task, description: "Wait for bb-verify --full --pr 6874" }] }));
  assert.equal(full.wait.taskKind, "full");
  const text = classify(makeThread({ lastAgentText: "Pushed 211e725. CI is running on 211e7258f4b. I'll report the verdict when it lands." }));
  assert.equal(text.state, "waiting-ci");
  assert.equal(text.wait.source, "text");
});

test("classifyThread: a laptop verify process wins over the wait it causes", () => {
  const infra = { localVerify: [{ pid: 9, command: "pnpm verify:pr", cwd: "/work/madrid/packages/app", ageSec: 300, threadKey: null }] };
  const thread = makeThread({ agentStatus: "waiting", openTasks: [{ id: "t", description: "Run pnpm verify:pr", kind: "local_bash", startedAt: ago(5 * MIN) }] });
  const result = classify(thread, { infra });
  assert.equal(result.state, "local-verify");
  assert.equal(classify(makeThread({ key: "codex:z" }), { infra: { localVerify: [{ pid: 1, command: "nx run-many", cwd: "/elsewhere", ageSec: 90, threadKey: "codex:z" }] } }).state, "local-verify");
  assert.equal(classify(makeThread(), { infra: { localVerify: [{ pid: 1, command: "nx run-many", cwd: "/work/madrid-2", ageSec: 90, threadKey: null }] } }).state, "ready-needs-human");
});

test("classifyThread: out-of-scope asks need a human, in-scope asks do not", () => {
  const cases = [
    ["What I'd like from you: approve #6167 (or have Adam/Nikhil do it).", "needs-human", "approval"],
    ["`--auto` queues it; `--admin` bypasses the policy and merges now. Which?", "needs-human", "admin"],
    ["Staging is green. Want me to cut the production release?", "needs-human", "production"],
    ["It needs your password in the browser. Can you log in?", "needs-human", "credentials"],
    ["Want me to reclaim disk by deleting the other agents' previews?", "needs-human", "delete"],
    ["Which do you want:\n1. Signal sets\n2. Signal groups", "needs-human", "choice"],
    ["Three things need you: screenshots and a call on naming.", "needs-human", "decision"],
    ["Want me to merge main into this and push?", "asked-in-scope", "in-scope"],
    ["Blocker: no tasks box on main's homepage. I'd do this as a follow-up PR after #6549 merges. Say go.", "asked-in-scope", "in-scope"],
    ["Should I open a PR with the fix?", "asked-in-scope", "in-scope"],
    // F8: a recommended option is taken only when it is a routine PR step.
    ["Which do you want:\n1. Execute with plain gh (recommended)\n2. Wait for the fix", "needs-human", "choice"],
    ["Which do you want:\n1. Merge main into the branch (recommended)\n2. Wait for the fix", "asked-in-scope", "in-scope"]
  ];
  for (const [text, state, topic] of cases) {
    const result = classify(makeThread({ lastAgentText: text }));
    assert.equal(result.state, state, text);
    assert.equal(result.ask.topic, topic, text);
  }
  const choice = classify(makeThread({ lastAgentText: "Which do you want:\n1. Signal sets\n2. Signal groups" }));
  assert.deepEqual(choice.ask.options, ["1", "2"]);
  // "Nothing needed from you" is a report, not an ask.
  assert.equal(classify(makeThread({ lastAgentText: "#6522 CI green on ac48a0a859. 0 open threads. You: nothing." })).state, "ready-needs-human");
  // A bare rhetorical question without permission phrasing does not block PR work.
  assert.equal(classify(makeThread({ lastAgentText: "Is 5312 still relevant?" }), { pr: makePr({ unresolvedThreads: 1 }) }).state, "pr-not-ready");
});

test("classifyThread: an ask the owner already answered is stale", () => {
  const thread = makeThread({ lastAgentText: "Want me to cut the production release?", lastAgentAt: ago(20 * MIN), lastUserAt: ago(15 * MIN) });
  assert.equal(classify(thread).state, "ready-needs-human");
});

test("classifyThread: PR states after the thread goes idle", () => {
  const notReady = classify(makeThread(), { pr: makePr({ ci: { state: "FAILURE", failing: ["verification"], pending: [] }, unresolvedThreads: 3 }) });
  assert.equal(notReady.state, "pr-not-ready");
  assert.deepEqual(notReady.blockers, ["CI red: verification", "3 open threads"]);
  assert.equal(classify(makeThread(), { pr: makePr({ reviewDecision: "REVIEW_REQUIRED", mergeState: "BLOCKED" }) }).state, "ready-needs-human");
  assert.equal(classify(makeThread()).state, "ready-needs-human");
  assert.equal(classify(makeThread(), { pr: makePr({ state: "MERGED" }) }).state, "done");
  assert.equal(classify(makeThread({ prRefs: [] }), { pr: null }).state, "idle-no-pr");
});

test("exported pattern lists match the owner's real phrases", () => {
  const any = (list, text) => list.some((entry) => (entry.pattern ?? entry).test(text));
  assert.ok(any(WAITING_PATTERNS, "hosted CI is pending with one watcher running"));
  assert.ok(any(WAITING_PATTERNS, "Verifier 25 is running on the final head; I'll retake the screenshot when it lands."));
  assert.ok(any(WAITING_PATTERNS, "Waiting on the testing deploy before cutting staging."));
  assert.ok(!any(WAITING_PATTERNS, "All green. Merged and deployed."));
  assert.ok(any(IN_SCOPE_ASK_PATTERNS, "Want me to do it on this branch right now?"));
  assert.ok(any(IN_SCOPE_ASK_PATTERNS, "May I stop my own preview?"));
  assert.ok(!any(IN_SCOPE_ASK_PATTERNS, "Pushed and resolved all threads."));
  assert.ok(OUT_OF_SCOPE_PATTERNS.every((entry) => typeof entry.topic === "string" && entry.pattern instanceof RegExp));
});

// F8: only routine PR steps get an automatic yes. Everything else asks the owner.
test("classifyThread: risky asks need a human even without an old out-of-scope word", () => {
  const cases = [
    ["Should I run it against the production database now?", "production"],
    ["Want me to force-push over origin/main?", "history"],
    ["Do you want me to drop the prod users table and reseed it?", "production"],
    ["Should I rotate the Stripe secret key in Vercel?", "credentials"],
    ["Should I push this straight to main?", "main"],
    ["Want me to run the migration on prod?", "production"],
    ["Should I git reset --hard to origin?", "history"],
    ["Should I run the migration against the shared staging DB?", "database"],
    ["Want me to truncate the events table?", "database"],
    ["Should I cancel the queued runs?", "cancel"],
    ["Should I restart the docker daemon on BuildBot3? It will drop every running preview.", "reboot"],
    ["Want me to cancel runs #6522 and #6530 and reboot BuildBot3?", null],
    // Not a known risk, and not a routine PR step either: the owner decides.
    ["Should I email the customer about the outage?", "permission"],
    ["Want me to do it on this branch right now?", "permission"],
    // One routine ask does not carry a second, unlisted one.
    ["Want me to push the fix? Also, should I email the customer?", "permission"],
    // A bare "Proceed?" after a recap names no step.
    ["Pushed the fix. Proceed?", "permission"]
  ];
  for (const [text, topic] of cases) {
    const result = classify(makeThread({ lastAgentText: text }));
    assert.equal(result.state, "needs-human", text);
    if (topic) assert.equal(result.ask.topic, topic, text);
  }
});

test("classifyThread: routine PR steps on the allowlist are in scope", () => {
  const cases = [
    "Want me to run bb-quick on BuildBot3 for this PR?",
    "Should I push the branch?",
    "Want me to resolve the 3 open review threads?",
    "Should I rebase onto main?",
    "Want me to rerun the failed CI job?",
    "Should I update the PR description?",
    "Want me to retake the screenshots on the BuildBot3 preview?",
    "Want me to start my own BuildBot3 preview?",
    "Should I clean up my worktree?",
    "Let me know if you want me to push the branch.",
    "Next: merge main into the branch and push. Proceed?"
  ];
  for (const text of cases) {
    const result = classify(makeThread({ lastAgentText: text }));
    assert.equal(result.state, "asked-in-scope", text);
  }
  // A recommended option is taken only when that option is itself routine.
  const routine = classify(makeThread({ lastAgentText: "Which do you want:\n1. Rerun CI on the head (recommended)\n2. Wait" }));
  assert.equal(routine.state, "asked-in-scope");
  const unknown = classify(makeThread({ lastAgentText: "Which do you want:\n1. Execute with plain gh (recommended)\n2. Wait for the fix" }));
  assert.equal(unknown.state, "needs-human");
  assert.equal(unknown.ask.topic, "choice");
});

// F16: a live session stuck on a permission prompt is the owner's, not ours.
test("classifyThread: a session blocked on a permission prompt needs the owner", () => {
  const expected = { topic: "approval", text: "Blocked on a permission prompt or dialog.", options: ["opened", "later"] };
  const prompt = makeThread({
    kind: "claude", key: "claude:c7", agentStatus: "waiting", live: { peerName: "p", pid: 7, status: "waiting" },
    meta: { blockedOnOwner: true, waitingFor: "permission prompt" }, lastAgentText: "Want me to push the branch?"
  });
  const result = classify(prompt, { pr: makePr({ ci: { state: "FAILURE", failing: ["verification"], pending: [] } }) });
  assert.equal(result.state, "needs-human");
  assert.deepEqual(result.ask, expected);
  // It beats a background-task wait too.
  const task = { id: "t1", description: "Run bb-quick", kind: "local_bash", startedAt: ago(20 * MIN) };
  assert.equal(classify({ ...prompt, openTasks: [task] }).state, "needs-human");
  // Only the source's flag counts.
  assert.equal(classify({ ...prompt, meta: { waitingFor: "permission prompt" } }).state, "waiting-ci");
});

test("PR review comments on #112: truncated threads, requested changes, and short PR merges", () => {
  const truncated = prReadiness(makePr({ unresolvedThreads: 0, threadsTruncated: true }), cleanGit);
  assert.ok(truncated.blockers.includes("100+ threads, not all read"), "unread thread pages are never treated as resolved");
  const changes = prReadiness(makePr({ reviewDecision: "CHANGES_REQUESTED" }), cleanGit);
  assert.ok(changes.blockers.includes("changes requested"));
  assert.equal(changes.onlyHumanLeft, false);
  const asked = classify(makeThread({ lastAgentText: "CI is green. Should I merge #42?" }));
  assert.equal(asked.state, "needs-human", "a merge of any PR number is the owner's call");
});

test("PR #112 round 2: structured Codex questions, earlier force-push context, unknown mergeability", () => {
  const structured = classify(makeThread({ lastAgentText: "asked", meta: { pendingQuestion: "Which billing plan should the migration target?" } }));
  assert.equal(structured.state, "needs-human");
  assert.match(structured.ask.text, /billing plan/);
  const forcePush = classify(makeThread({ lastAgentText: "I can force-push the rewritten branch. Tests pass. Should I push?" }));
  assert.equal(forcePush.state, "needs-human", "a force-push named earlier keeps the push ask with the owner");
  const unknown = prReadiness(makePr({ mergeable: "UNKNOWN", mergeState: "UNKNOWN" }), cleanGit);
  assert.ok(unknown.blockers.includes("mergeability unknown"));
  assert.equal(unknown.ready, false);
});

test("local git that could not be read blocks readiness", () => {
  const unreadable = { head: null, branch: null, upstream: null, ahead: null, remote: null, unreadable: true };
  const readiness = prReadiness(makePr(), unreadable);
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.blockers, ["local git unknown"]);
  // No worktree read at all (no cwd) keeps the GitHub-only answer.
  assert.equal(prReadiness(makePr(), null).ready, true);
  const classified = classifyThread(makeThread(), { pr: makePr(), localGit: unreadable, now: NOW, config });
  assert.equal(classified.state, "pr-not-ready");
  assert.deepEqual(classified.blockers, ["local git unknown"]);
});

test("matching PR head proves pushed commits even when upstream is main", () => {
  const readiness = prReadiness(makePr(), { ...cleanGit, upstream: "origin/main", ahead: 12 });
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.blockers, []);
});

test("threadHealth maps every state to one colour", () => {
  const expected = {
    running: "green", "waiting-ci": "green", "local-verify": "green", "asked-in-scope": "green", done: "green",
    "pr-not-ready": "yellow", "idle-no-pr": "yellow", "ready-needs-human": "yellow",
    "needs-human": "red", "infra-blocked": "red",
    excluded: "gray"
  };
  // A new state must pick a colour here, not fall through to gray unnoticed.
  assert.deepEqual(Object.keys(expected).sort(), [...STATES].sort());
  for (const [state, health] of Object.entries(expected)) assert.equal(threadHealth(state, null), health, state);
  assert.equal(threadHealth("something-new", null), "gray");
  assert.equal(threadHealth(undefined), "gray");
});

test("threadHealth turns an errored thread red unless it is running again", () => {
  const error = { kind: "usage-limit", resetAt: null };
  for (const state of ["waiting-ci", "done", "idle-no-pr", "pr-not-ready", "ready-needs-human", "needs-human"]) {
    assert.equal(threadHealth(state, error), "red", state);
  }
  // Any non-null error counts, even one with no known kind.
  assert.equal(threadHealth("idle-no-pr", {}), "red");
  assert.equal(threadHealth("running", error), "green");
  assert.equal(threadHealth("excluded", error), "gray");
});

// Bug 5: the topic comes from the ask, not from a risky word in the recap.
test("classifyThread: a risky word outside the ask keeps the owner but not the topic", () => {
  // The real zurich #3 close: a cost bullet, then a merge offer.
  const zurich = "- **Older articles:** our 300+ existing unlinked posts would now be blocked if we tried to republish them. "
    + "Adding links to them is optional, and costs roughly $0.50–1 per post in Claude usage. "
    + "The SEObot comparison is logged in the decision log as D-37, with a check-in on about Oct 28. "
    + "The code is pushed as PR #3: https://github.com/Spshulem/AI-SEO/pull/3. I haven't merged it; say the word and I will.";
  const offer = classify(makeThread({ lastAgentText: zurich }));
  assert.equal(offer.state, "needs-human");
  assert.equal(offer.ask.topic, "decision");
  // A force-push named earlier still keeps a push ask with the owner.
  const push = classify(makeThread({ lastAgentText: "I can force-push the rewritten branch. Tests pass. Should I push?" }));
  assert.equal(push.state, "needs-human");
  assert.equal(push.ask.topic, "decision");
  // A bare ask takes its topic from the sentence before it.
  assert.equal(classify(makeThread({ lastAgentText: "Backfilling the old posts costs about $150 in Claude usage. Want me to?" })).ask.topic, "money");
  assert.equal(classify(makeThread({ lastAgentText: "Should I spend $150 of credits on the backfill?" })).ask.topic, "money");
});
