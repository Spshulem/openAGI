import test from "node:test";
import assert from "node:assert/strict";
import {
  IN_SCOPE_ASK_PATTERNS, OUT_OF_SCOPE_PATTERNS, WAITING_PATTERNS, WATCH_GROUPS, blockedOnSection, classifyThread, liveWatch, mergeThreads, prReadiness, threadHealth, watchOf
} from "../src/fleet/classify.js";
import { DEFAULTS, STATES, clampTail, clampTailLines } from "../src/fleet/contracts.js";

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
    createdAt: ago(24 * 60 * MIN), updatedAt: ago(0), ...overrides
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

test("mergeThreads folds the Claude report when the Conductor tail kept only a synthetic notice", () => {
  // The Conductor tail's last text is a limit notice: an excerpt, no real report.
  const conductor = makeThread({ claudeSessionId: "c1", lastAgentText: "You've hit your session limit", lastAgentFull: "", lastAgentFullAt: null, lastAgentAt: ago(2 * MIN) });
  const report = "Pushed abc1234.\n\nBlocked on:\n- your call on the schema change";
  const claude = makeThread({
    key: "claude:c1", kind: "claude", id: "c1", claudeSessionId: "c1", lastAgentText: report, lastAgentFull: report,
    lastAgentFullAt: ago(10 * MIN), lastAgentAt: ago(10 * MIN)
  });
  const [m] = mergeThreads({ claude: [claude], conductor: [conductor] });
  assert.equal(m.lastAgentText, "You've hit your session limit");
  assert.equal(m.lastAgentAt, ago(2 * MIN));
  assert.equal(m.lastAgentFull, report);
  assert.equal(m.lastAgentFullAt, ago(10 * MIN));
  // A real Conductor report is kept.
  const own = makeThread({ claudeSessionId: "c1", lastAgentText: "Done.", lastAgentFull: "Done.", lastAgentFullAt: ago(MIN) });
  const [kept] = mergeThreads({ claude: [claude], conductor: [own] });
  assert.equal(kept.lastAgentFull, "Done.");
  assert.equal(kept.lastAgentFullAt, ago(MIN));
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

test("prReadiness gates on the repo's required check, not on hosted CI", () => {
  const gate = (state) => [{ name: "BuildBot3 full verification", label: "BuildBot3 full run", state }];
  const blockersOf = (prOver) => prReadiness(makePr(prOver), cleanGit).blockers;
  // Unrelated green checks are no proof the full run passed.
  assert.deepEqual(blockersOf({ gates: gate(null) }), ["BuildBot3 full run missing"]);
  // A lookup that failed to load is unread, not missing.
  assert.deepEqual(blockersOf({ gates: [{ ...gate(null)[0], unread: true }] }), ["BuildBot3 full run unread"]);
  assert.deepEqual(blockersOf({ gates: gate("FAILURE"), ci: { state: "FAILURE", failing: ["BuildBot3 full verification"], pending: [] } }), ["BuildBot3 full run failed"]);
  assert.deepEqual(blockersOf({ gates: gate("PENDING"), ci: { state: "PENDING", failing: [], pending: ["BuildBot3 full verification"] } }), ["BuildBot3 full run pending"]);
  assert.deepEqual(blockersOf({ gates: gate("SKIPPED") }), ["BuildBot3 full run skipped"]);
  // A green full run with only skipped hosted checks is ready.
  assert.equal(prReadiness(makePr({ gates: gate("SUCCESS") }), cleanGit).ready, true);
  // Other red or running checks still block.
  assert.deepEqual(blockersOf({ gates: gate("SUCCESS"), ci: { state: "FAILURE", failing: ["lint"], pending: [] } }), ["CI red: lint"]);
  assert.deepEqual(blockersOf({ gates: gate("SUCCESS"), ci: { state: "PENDING", failing: [], pending: ["Cursor Bugbot"] } }), ["CI running"]);
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

test("classifyThread: owner to-dos and blockers reach the owner; their negations do not", () => {
  const asks = ["**You must do:** tell me which PR this is.", "I still need your OK on the schema change.", "Pushed. Blocked on: your approval for the deploy."];
  for (const text of asks) assert.equal(classify(makeThread({ lastAgentText: text }), { pr: null }).state, "needs-human", text);
  assert.equal(classify(makeThread({ lastAgentText: "Nothing is blocked on CI; I still need your approval." }), { pr: null }).state, "needs-human", "a cleared blocker beside a real ask");
  assert.equal(classify(makeThread({ lastAgentText: "CI is pending. Blocked on your approval." }), { pr: makePr({ ci: { state: "PENDING", failing: [], pending: ["verify"] } }) }).state, "needs-human", "an owner ask beats a written wait");
  for (const text of ["Report written. Nothing you must do.", "You must do: none.", "**You must do:** nothing.", "Pushed the fix. Blocked on: nothing.", "Nothing here is blocked on your domain decision.", "No longer blocked on your approval."]) {
    assert.notEqual(classify(makeThread({ lastAgentText: text }), { pr: null }).state, "needs-human", text);
  }
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

test("classifyThread: a PR merged or closed after the ask settles it; an ask made after stands", () => {
  const merged = (at) => makePr({ state: "MERGED", mergedAt: at, closedAt: at });
  const ask = (at, text = "Want me to cut the production release?") => makeThread({ lastAgentText: text, lastAgentAt: at });
  assert.equal(classify(ask(ago(30 * MIN)), { pr: merged(ago(10 * MIN)) }).state, "done");
  assert.equal(classify(ask(ago(30 * MIN)), { pr: makePr({ state: "CLOSED", mergedAt: null, closedAt: ago(10 * MIN) }) }).state, "done");
  // An in-scope ask on a merged PR gets no auto-yes either.
  assert.equal(classify(ask(ago(30 * MIN), "Should I push the fix?"), { pr: merged(ago(10 * MIN)) }).state, "done");
  // unified-experience #6914: "merged; cut a staging release and QA it?" came after the merge.
  const after = classify(ask(ago(10 * MIN), "PR #6914 is merged. Should I cut a staging release and QA it there?"), { pr: merged(ago(30 * MIN)) });
  assert.equal(after.state, "needs-human");
  // Unknown ask or merge time: keep asking.
  assert.equal(classify(ask(null), { pr: merged(ago(10 * MIN)) }).state, "needs-human");
  assert.equal(classify(ask(ago(30 * MIN)), { pr: makePr({ state: "MERGED" }) }).state, "needs-human");
  assert.equal(classify(ask(ago(30 * MIN)), { pr: makePr({ mergedAt: null, closedAt: null }) }).state, "needs-human");
});

test("classifyThread: a report's Blocked-on list is settled against the report's own time", () => {
  const merged = makePr({ state: "MERGED", mergedAt: ago(10 * MIN), closedAt: ago(10 * MIN) });
  const report = "Shipped the fix.\n\n**Blocked on:**\n- **Your decision** on cutting the production release";
  // The report, the merge, then a synthetic limit notice that moved lastAgentAt.
  const thread = makeThread({ lastAgentText: "You've hit your session limit", lastAgentAt: ago(5 * MIN), lastAgentFull: report, lastAgentFullAt: ago(30 * MIN) });
  assert.notEqual(classify(thread, { pr: merged }).state, "needs-human");
  // A report written after the merge still asks.
  const later = makeThread({ lastAgentText: report, lastAgentAt: ago(5 * MIN), lastAgentFull: report, lastAgentFullAt: ago(5 * MIN) });
  assert.equal(classify(later, { pr: merged }).state, "needs-human");
});

test("classifyThread: a structured Codex ask is settled by a later merge, not an earlier one", () => {
  const merged = makePr({ state: "MERGED", mergedAt: ago(10 * MIN), closedAt: ago(10 * MIN) });
  const structured = (at, lastAgentAt, text = "Checked the build. Start a huddle and send a screenshot?") => makeThread({
    lastAgentText: text, lastAgentAt, meta: { pendingQuestion: { text: "Start a solo huddle?", options: ["open thread"], at } }
  });
  // bb-recorder #282: asked, repeated in the final message, then merged hours later.
  assert.equal(classify(structured(ago(40 * MIN), ago(30 * MIN)), { pr: merged }).state, "done");
  // The agent's last words came after the merge: they may repeat the ask.
  assert.equal(classify(structured(ago(40 * MIN), ago(5 * MIN)), { pr: merged }).ask?.structured, true);
  assert.equal(classify(structured(ago(5 * MIN), ago(5 * MIN)), { pr: merged }).ask?.structured, true);
  // No ask time of its own: never settled.
  const untimed = makeThread({ lastAgentText: "asked", lastAgentAt: ago(30 * MIN), meta: { pendingQuestion: "Which billing plan?" } });
  assert.equal(classify(untimed, { pr: merged }).ask?.structured, true);
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
    "pr-not-ready": "yellow", "idle-no-pr": "yellow", "ready-needs-human": "yellow", stopped: "yellow",
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

// Review 6: only a PR that existed when the agent asked can settle the ask.
test("classifyThread: a PR opened after the ask does not settle it", () => {
  const done = (createdAt) => makePr({ state: "MERGED", createdAt, mergedAt: ago(10 * MIN), closedAt: ago(10 * MIN) });
  // west-monroe: asked, then #6954 was opened and merged later.
  const ask = makeThread({ lastAgentText: "Want me to list which portals have it installed so you can pick ones to remove?", lastAgentAt: ago(60 * MIN) });
  assert.equal(classify(ask, { pr: done(ago(43 * MIN)) }).state, "needs-human");
  // Unknown open time: not settled either.
  assert.equal(classify(ask, { pr: done(null) }).state, "needs-human");
  assert.equal(classify(ask, { pr: done(ago(90 * MIN)) }).state, "done");
  // A structured ask counts from when it was asked, not from the agent's later words.
  const structured = makeThread({
    lastAgentText: "Still need the portal list.", lastAgentAt: ago(30 * MIN),
    meta: { pendingQuestion: { text: "List the portals?", options: ["open thread"], at: ago(60 * MIN) } }
  });
  assert.equal(classify(structured, { pr: done(ago(45 * MIN)) }).ask?.structured, true);
  assert.equal(classify(structured, { pr: done(ago(90 * MIN)) }).state, "done");
});

// Review 9: several questions, or a login or prod word that is not the step
// asked for, keep the neutral topic.
test("classifyThread: a question list or a passing login/prod word gets the neutral topic", () => {
  const apia = "CI now passes on #6892, so the whole stack is green again.\n\nStill waiting on you:\n"
    + "- Log client IPs on the API and stop MCP taking keys in the URL?\n- Fix the two password bugs?\n"
    + "- #6930 shared views: own data only, or full-org data as today?\n"
    + "- #6930 AI completion in reports: creator only, or other viewers with their own login?\n- Whether to merge #6668.";
  const list = classify(makeThread({ lastAgentText: apia }));
  assert.equal(list.state, "needs-human");
  assert.equal(list.ask.topic, "decision");
  const passing = classify(makeThread({ lastAgentText: "The prod deploy finished; want me to close the ticket?" }));
  assert.equal(passing.state, "needs-human");
  assert.equal(passing.ask.topic, "decision");
  // A follow-on "Or ...?" is the same question, and the step keeps its topic.
  assert.equal(classify(makeThread({ lastAgentText: "Want me to cut the production release? Or hold it for Monday?" })).ask.topic, "production");
  assert.equal(classify(makeThread({ lastAgentText: "It needs your password in the browser. Can you log in?" })).ask.topic, "credentials");
  assert.equal(classify(makeThread({ lastAgentText: "Tests pass, so should I rotate the Stripe secret key in Vercel?" })).ask.topic, "credentials");
});

test("a turn that stopped mid-work is stopped, whatever its PR or last words say", () => {
  // Killed by an app restart: no end row, quiet past the running window.
  const dead = makeThread({ kind: "codex", key: "codex:t5", agentStatus: "stalled", lastAgentText: "I'm checking those write boundaries before changing them." });
  assert.equal(classify(dead, { pr: makePr({ state: "MERGED", mergedAt: ago(10 * 24 * 60 * MIN) }) }).state, "stopped");
  assert.equal(classify(dead, { pr: null }).state, "stopped");
  assert.equal(classify({ ...dead, prRefs: [] }, { pr: null }).state, "stopped");
  // Mid-turn words about waiting are not a wait once the turn is dead.
  assert.equal(classify({ ...dead, lastAgentText: "Waiting for CI to finish on the new head." }).state, "stopped");
  // Interrupted by something else (seven threads at once): stopped.
  const interrupted = makeThread({ agentStatus: "aborted", meta: { abortedAt: ago(20 * MIN) }, lastUserAt: ago(60 * MIN) });
  assert.equal(classify(interrupted).state, "stopped");
  // The owner pressed stop right after writing: not the supervisor's to resume.
  const deliberate = makeThread({ agentStatus: "aborted", meta: { abortedAt: ago(20 * MIN) }, lastUserAt: ago(20 * MIN + 30_000) });
  assert.notEqual(classify(deliberate).state, "stopped");
  // Still running, or asking the owner: not stopped.
  assert.equal(classify(makeThread({ agentStatus: "running" })).state, "running");
  assert.equal(classify({ ...dead, meta: { pendingQuestion: { text: "Pick a price?", options: ["$1", "$2"], at: ago(20 * MIN) } } }).state, "needs-human");
});

// The real 18:17 report from Conductor session d1dbe71a (2,198 chars).
const D1DBE71A_REPORT = [
  "**Not ready to merge.**",
  "",
  "- **PR:** https://github.com/buildbetter-app/remote-dev-setup/pull/1",
  "- **Head:** `1bfd2c83`",
  "- **BuildBot3 run:** none. This repo has no BuildBot3 verification.",
  "",
  "**Correction:** my earlier \"0 open, ready\" was wrong. I had only counted the first 100 of 402 threads. There were 50 unresolved, including 12 P1 and 1 Cursor MEDIUM security finding.",
  "",
  "**Open ≥6/10: 2.** Both need your call.",
  "- **CPU lanes:** `bb-verify` fixes the lane count when a run starts, but the sweep can shrink its CPU share later. Fixing it means pinning lanes to a per-slot share, or having the sweep resize lanes.",
  "- **Cache write default:** PR runs write to the shared cache by default, which is a documented trade-off. Making cross-repository (fork) PRs read-only needs a fork check in `pr_head_and_base`.",
  "",
  "38 threads remain unresolved, 36 of them P2. I replied on both open P1s.",
  "",
  "**Resolved: 12 of 13 P1s plus the security one.**",
  "- **Fixed in code:**",
  "  - `bb-ci-remote` now runs the full lane.",
  "  - `lb-usage-shim` now returns 403 to anyone but loopback and the allow list, and it won't start without one.",
  "- **Already fixed in code:** five (ticket start ticks, pool lock, base-branch check, `bb-edge` exclusion, SSH login errors).",
  "- **Deliberate:** two `bb3-watch` \"go down\" fallbacks, because falling back would bill the ChatGPT login.",
  "- **Bounded:** one memory-reservation race, three 32 GiB slots on about 249 GiB.",
  "",
  "**Blocked on:**",
  "- **Your decision** on the two P1s above.",
  "- **Checks on the new head:** the Cursor router and Security checks are still running. Codex has not reviewed `1bfd2c83`.",
  "- **Another session editing this worktree:** about 20 files have uncommitted edits that aren't mine, including `bb3-doctor`, `bb3-heal`, `bb-quick` and `server.py`. That session needs to push or hand off, or we'll conflict.",
  "- **Deploying the shim:** the shim fix takes effect after `ci-local/install.sh --box` on BuildBot3."
].join("\n");

// The supervisor's own read gaps on that PR.
const gappyPr = () => makePr({ unresolvedThreads: 0, threadsTruncated: true, codexReview: { reviewedHead: false, sha: "bbbbbbb" } });

test("a markdown Blocked-on list naming the owner's decision asks the owner, read from the whole report", () => {
  const thread = makeThread({ lastAgentText: clampTail(D1DBE71A_REPORT, DEFAULTS.excerptMax), lastAgentFull: clampTailLines(D1DBE71A_REPORT, DEFAULTS.fullTextMax) });
  const result = classify(thread, { pr: gappyPr() });
  assert.equal(result.state, "needs-human");
  assert.equal(result.infraKind, null);
  assert.equal(result.ask.blocked, true);
  assert.equal(result.ask.text, "Your decision on the two P1s above");
  // Never a "later" that would be relayed to the agent as the answer.
  assert.deepEqual(result.ask.options, ["open thread"]);
  // The whole report as the short text too: "bb3-watch" names a tool, not a down box.
  assert.equal(classify(makeThread({ lastAgentText: D1DBE71A_REPORT }), { pr: gappyPr() }).state, "needs-human");
  const section = blockedOnSection(D1DBE71A_REPORT);
  assert.deepEqual(section.items.map((item) => item.tag), ["owner", "passive", "other", "other"]);
});

test("the same generic blocker over other choices is a new ask key", () => {
  const report = (p1s) => ["Not ready.", "", "**Open: 2.** Both need your call.", ...p1s.map((p1) => `- ${p1}`), "", "**Blocked on:**", "- **Your decision** on the two P1s above."].join("\n");
  const keyOf = (text) => classify(makeThread({ lastAgentText: text })).ask.key;
  const first = keyOf(report(["P1: migration drops the audit table", "P1: token logged in plaintext"]));
  assert.equal(keyOf(report(["P1: migration drops the audit table", "P1: token logged in plaintext"])), first);
  assert.notEqual(keyOf(report(["P1: cache key collides across forks", "P1: retry loop never backs off"])), first);
  // Other sub-bullet choices under the same owner item are a new ask too.
  const own = (choices) => `**Blocked on:**\n- Your call on the release:\n${choices.map((choice) => `  - ${choice}`).join("\n")}`;
  assert.notEqual(keyOf(own(["Merge now", "Keep it open"])), keyOf(own(["Revert it", "Hold until Monday"])));
});

test("the short Blocked-on form asks; nothing, CI, or a third party's approval does not", () => {
  const ask = classify(makeThread({ lastAgentText: "**Blocked on:**\n- **Your decision** on the two P1s\n- checks on new head are running" }));
  assert.equal(ask.state, "needs-human");
  // A merge call on an open PR is the ready flow's; without a PR it asks.
  assert.equal(classify(makeThread({ lastAgentText: "Pushed. **Blocked on:** your merge decision." })).state, "ready-needs-human");
  assert.equal(classify(makeThread({ lastAgentText: "Pushed. **Blocked on:** your merge decision.", prRefs: [] }), { pr: null }).state, "needs-human");
  assert.equal(classify(makeThread({ lastAgentText: "Blocked on: approval from you." })).state, "needs-human");
  for (const text of ["Done.\n\nBlocked on: nothing", "**Blocked on:** none.", "**Blocked on:** CI", "Blocked on: required reviewer approval from Adam/Nikhil"]) {
    const result = classify(makeThread({ lastAgentText: text }), { pr: makePr({ reviewDecision: "REVIEW_REQUIRED", mergeState: "BLOCKED" }) });
    assert.notEqual(result.state, "needs-human", text);
  }
  assert.equal(blockedOnSection("Blocked on: nothing").items.length, 0);
  assert.equal(blockedOnSection("Blocked on: required reviewer approval from Adam/Nikhil").items[0].tag, "other");
  assert.equal(blockedOnSection("Not blocked."), null);
});

test("the latest Blocked-on section wins over an earlier quoted one", () => {
  const text = "Earlier I wrote:\n\n> **Blocked on:**\n> - **Your decision** on the cache default\n\nYou picked shared writes; that is pushed.\n\n**Blocked on:** nothing";
  assert.equal(blockedOnSection(text).items.length, 0);
  assert.notEqual(classify(makeThread({ lastAgentText: text })).state, "needs-human");
  const reopened = "> Blocked on: nothing\n\nA new question came up.\n\nBlocked on:\n- your decision on the cache default";
  assert.equal(blockedOnSection(reopened).owner.length, 1);
  assert.equal(classify(makeThread({ lastAgentText: reopened })).state, "needs-human");
});

test("an owner Blocked-on item offers the agent's own sub-bullets, then open thread", () => {
  const text = "Ready except one thing.\n\n### Blocked on\n\n- **Your call** on cache writes:\n  - keep shared writes\n  - make fork PRs read-only\n- CI running\n\nI'll wait.";
  const result = classify(makeThread({ lastAgentText: text }));
  assert.equal(result.state, "needs-human");
  assert.deepEqual(result.ask.options, ["keep shared writes", "make fork PRs read-only", "open thread"]);
  // Once the owner replied, the old report asks nothing.
  assert.notEqual(classify(makeThread({ lastAgentText: text, lastUserText: "keep them", lastUserAt: ago(5 * MIN) })).state, "needs-human");
});

test("a card of acknowledgements hides the tail's structured question too", () => {
  // ZeroShot 01a12c44: five "Okay"/"Continue" items, and the tail carries the call.
  const acks = { app: "codex", cardId: "turn-a", count: 2, items: [
    { index: 0, itemId: "call_ok:0", header: null, question: "I will use the existing native QA build.", options: ["Okay"], multiSelect: false, freeText: true, at: ago(5 * MIN) },
    { index: 1, itemId: "call_go:0", header: null, question: "I have enough authorization.", options: ["Continue"], multiSelect: false, freeText: true, at: ago(4 * MIN) }
  ] };
  const thread = makeThread({ kind: "codex", key: "codex:t1", id: "t1", meta: { pendingCard: acks, pendingQuestion: { text: "I will use the existing native QA build.", options: ["Okay"], at: ago(5 * MIN) } } });
  assert.notEqual(classify(thread).state, "needs-human");
});

test("an owner Blocked-on item beats a CI wait the agent wrote, and a merge after it settles it", () => {
  const text = "CI is still running on the new head.\n\nBlocked on:\n- your decision on the cache default";
  assert.equal(classify(makeThread({ lastAgentText: text })).state, "needs-human");
  // Asked 30 min ago; the PR merged 5 min ago.
  const merged = makePr({ state: "MERGED", mergedAt: ago(5 * MIN), closedAt: ago(5 * MIN) });
  assert.notEqual(classify(makeThread({ lastAgentText: "Blocked on:\n- your merge decision" }), { pr: merged }).state, "needs-human");
  assert.notEqual(classify(makeThread({ lastAgentText: text }), { pr: merged }).state, "needs-human");
});

test("watchOf: the owner's view of what each thread is watched for, and since when", () => {
  const classify = (thread, pr = makePr()) => classifyThread(thread, { pr, now: NOW, config });
  // A full BuildBot3 run the agent waits on: waiting, on that run, since the task started.
  const full = { id: "t1", description: "bb-verify --full --pr 6522", kind: "local_bash", startedAt: ago(25 * MIN) };
  const waiting = makeThread({ agentStatus: "waiting", openTasks: [full], meta: { turnStartedAt: ago(40 * MIN) } });
  const w = watchOf(waiting, classify(waiting, makePr({ ci: { state: "PENDING", failing: [], pending: ["verification"] } })), { now: NOW });
  assert.equal(w.group, "waiting");
  assert.equal(w.waitingOn, "BuildBot3 full run");
  assert.equal(w.since, ago(25 * MIN));
  assert.equal(w.waitSince, ago(25 * MIN));
  assert.equal(w.runningSince, ago(40 * MIN));
  // Mid-turn: working since the turn began.
  const running = makeThread({ agentStatus: "running", lastActivityAt: ago(1 * MIN), meta: { turnStartedAt: ago(12 * MIN) } });
  const r = watchOf(running, classify(running), { now: NOW });
  assert.equal(r.group, "working");
  assert.equal(r.since, ago(12 * MIN));
  // A question to the owner outranks the state: waiting on you, since it was asked.
  const asked = watchOf(running, classify(running), { now: NOW, askedAt: ago(7 * MIN) });
  assert.equal(asked.group, "you");
  assert.equal(asked.waitingOn, "your answer");
  assert.equal(asked.since, ago(7 * MIN));
  // An owner ask still held for review (no visible question) is not blamed on the owner.
  assert.equal(watchOf(makeThread(), { state: "needs-human" }, { now: NOW }).group, "push");
  assert.equal(watchOf(makeThread(), { state: "needs-human" }, { now: NOW, askedAt: ago(3 * MIN) }).group, "you");
  // Out of scope is not watched; every group is a known one.
  assert.equal(watchOf(makeThread(), { state: "excluded" }, { now: NOW }), null);
  for (const state of STATES) {
    const watch = watchOf(makeThread(), { state }, { now: NOW });
    if (watch) assert.ok(WATCH_GROUPS.includes(watch.group), state);
  }
});

test("liveWatch: Waiting on you only while a question the owner can see is open", () => {
  // Asked while CI ran: back to waiting on CI, on its own clock, once answered.
  const asked = watchOf(makeThread({ agentStatus: "idle" }), { state: "waiting-ci", wait: { source: "ci", ageMs: 20 * MIN } }, { now: NOW, askedAt: ago(5 * MIN) });
  assert.equal(asked.group, "you");
  assert.deepEqual(asked.otherwise, { group: "waiting", waitingOn: "CI" });
  const answered = liveWatch(asked, { state: "waiting-ci", askedAt: null, closedAt: ago(1 * MIN) });
  assert.equal(answered.group, "waiting");
  assert.equal(answered.waitingOn, "CI");
  assert.equal(answered.since, ago(20 * MIN));
  assert.equal(answered.otherwise, undefined);
  // A needs-human row whose question was dismissed: the supervisor's to push, from the dismissal.
  const ask = watchOf(makeThread(), { state: "needs-human" }, { now: NOW, askedAt: ago(8 * 60 * MIN) });
  const dismissed = liveWatch(ask, { state: "needs-human", askedAt: null, closedAt: ago(2 * MIN) });
  assert.equal(dismissed.group, "push");
  assert.equal(dismissed.since, ago(2 * MIN));
  assert.equal(dismissed.waitingOn, null);
  // A snapshot from before otherwise falls back by state.
  const { otherwise: _drop, ...legacy } = ask;
  assert.equal(liveWatch(legacy, { state: "needs-human" }).group, "push");
  // A question opened since the scan puts the row in, timed by it.
  const quiet = watchOf(makeThread(), { state: "idle-no-pr" }, { now: NOW });
  const now = liveWatch(quiet, { state: "idle-no-pr", askedAt: ago(1 * MIN) });
  assert.equal(now.group, "you");
  assert.equal(now.since, ago(1 * MIN));
  assert.equal(now.otherwise.group, "quiet");
  assert.equal(liveWatch(now, { state: "idle-no-pr" }).group, "quiet");
  // Nothing open and not "you": unchanged; out of scope stays null.
  assert.equal(liveWatch(quiet, { state: "idle-no-pr" }), quiet);
  assert.equal(liveWatch(null, { askedAt: ago(1 * MIN) }), null);
});

test("Paseo native and migration aliases retain self exclusion", () => {
  for (const provider of ["codex", "claude", "conductor", "antigravity"]) {
    const thread = makeThread({ kind: "paseo", id: "agent", key: "paseo:host.agent", meta: { aliases: [`${provider}:self-session`] } });
    assert.equal(classify(thread).reason, "self");
    assert.notEqual(classify({ ...thread, meta: { aliases: [`${provider}:someone-else`] } }).reason, "self");
  }
});
