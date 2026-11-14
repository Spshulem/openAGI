import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { FleetSupervisor } from "../src/fleet/supervisor.js";
import { createFleetRoute } from "../src/fleet/routes.js";
import { createFleetCapability, RemoteFleetSupervisor } from "../src/fleet/remote.js";
import { isMobileRouteAllowed } from "../src/mobile-node.js";
import { executeSafePrMerge, matchCardForUtterance } from "../src/fleet/intent-resolver.js";
import { defaultPreferences, recordAutonomousSliceAction, recordPreferenceSignal, buildProgressivePreferenceCards } from "../src/fleet/preferences.js";
import { SuggestionManager } from "../src/fleet/suggestions.js";
import { registerFleetTools } from "../src/fleet/tools.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { PendingActionStore } from "../src/pending-actions.js";
import { executeApprovedAction } from "../src/approval-executor.js";
import { OutreachStore } from "../src/outreach-store.js";

function tempSupervisor({ ghRun = null, executor = null, notifier = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-cards-prefs-"));
  const events = new EventEmitter();
  const emitted = [];
  events.on("fleet", (payload) => emitted.push(payload));
  const supervisor = new FleetSupervisor({
    dataDir: dir,
    runtime: { events },
    deps: {
      ...(ghRun ? { run: ghRun } : {}),
      ...(executor ? { executor } : {}),
      ...(notifier ? { notifier } : {})
    }
  });
  return {
    dir,
    events,
    emitted,
    supervisor,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("default preferences start safely with manual_confirm mergePolicy and zero autoSlices", () => {
  const prefs = defaultPreferences();
  assert.equal(prefs.mergePolicy, "manual_confirm");
  assert.equal(prefs.cadence, "balanced");
  assert.deepEqual(prefs.autoSlices, {
    in_scope_test_fix: "ask",
    pr_review_followup: "ask",
    lockfile_rebase: "ask"
  });
});

test("executeSafePrMerge enforces live preflight and never passes --auto under manual_confirm", async () => {
  const calls = [];
  const makeRun = (prJson) => async (bin, args) => {
    calls.push([bin, ...args]);
    if (args[0] === "pr" && args[1] === "view") {
      return { code: 0, stdout: JSON.stringify(prJson), stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "merge") {
      return { code: 0, stdout: "Merged", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  };

  // 1. CI still running under manual_confirm: watches CI, NEVER runs gh pr merge --auto.
  calls.length = 0;
  const pending = await executeSafePrMerge({
    prRef: "Spshulem/openAGI#284",
    expectedHeadSha: "abc1234567",
    mergePolicy: "manual_confirm",
    run: makeRun({
      state: "OPEN",
      isDraft: false,
      headRefOid: "abc1234567",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [{ name: "iOS mobile", status: "IN_PROGRESS", conclusion: null }]
    })
  });
  assert.equal(pending.status, "watching_ci");
  assert.equal(pending.promptPreference, true);
  assert.equal(calls.some((c) => c.includes("merge")), false, "must not call gh pr merge while CI is pending under manual_confirm");

  // 2. Head SHA drifted since card was created: halts safely!
  calls.length = 0;
  const drifted = await executeSafePrMerge({
    prRef: "Spshulem/openAGI#284",
    expectedHeadSha: "abc1234567",
    mergePolicy: "manual_confirm",
    run: makeRun({
      state: "OPEN",
      isDraft: false,
      headRefOid: "def9876543",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      statusCheckRollup: [{ name: "iOS mobile", status: "COMPLETED", conclusion: "SUCCESS" }]
    })
  });
  assert.equal(drifted.status, "halted");
  assert.equal(drifted.reason, "head_changed");
  assert.equal(calls.some((c) => c.includes("merge")), false);

  // 3. Merge conflict or failing check: halts safely!
  const conflicted = await executeSafePrMerge({
    prRef: "Spshulem/openAGI#284",
    expectedHeadSha: "abc1234567",
    mergePolicy: "manual_confirm",
    run: makeRun({
      state: "OPEN",
      isDraft: false,
      headRefOid: "abc1234567",
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
      statusCheckRollup: []
    })
  });
  assert.equal(conflicted.status, "halted");
  assert.equal(conflicted.reason, "merge_conflict");

  const redCi = await executeSafePrMerge({
    prRef: "Spshulem/openAGI#284",
    expectedHeadSha: "abc1234567",
    mergePolicy: "manual_confirm",
    run: makeRun({
      state: "OPEN",
      isDraft: false,
      headRefOid: "abc1234567",
      mergeable: "MERGEABLE",
      mergeStateStatus: "UNSTABLE",
      statusCheckRollup: [{ name: "Portable runtime", status: "COMPLETED", conclusion: "FAILURE" }]
    })
  });
  assert.equal(redCi.status, "halted");
  assert.equal(redCi.reason, "ci_failed");

  // 4. BLOCKED PR with empty statusCheckRollup (unposted checks or review block) or BEHIND: halts safely!
  calls.length = 0;
  const blockedEmptyRollup = await executeSafePrMerge({
    prRef: "Spshulem/openAGI#284",
    expectedHeadSha: "abc1234567",
    mergePolicy: "manual_confirm",
    run: makeRun({
      state: "OPEN",
      isDraft: false,
      headRefOid: "abc1234567",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: []
    })
  });
  assert.equal(blockedEmptyRollup.status, "halted");
  assert.equal(blockedEmptyRollup.reason, "blocked");
  assert.equal(calls.some((c) => c.includes("merge")), false, "BLOCKED PR with empty rollup must never call gh pr merge");

  const behindBase = await executeSafePrMerge({
    prRef: "Spshulem/openAGI#284",
    expectedHeadSha: "abc1234567",
    mergePolicy: "manual_confirm",
    run: makeRun({
      state: "OPEN",
      isDraft: false,
      headRefOid: "abc1234567",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BEHIND",
      statusCheckRollup: [{ name: "Portable runtime", status: "COMPLETED", conclusion: "SUCCESS" }]
    })
  });
  assert.equal(behindBase.status, "halted");
  assert.equal(behindBase.reason, "behind_base");

  // 5. All checks green, open, non-draft, matching SHA, clean: squash merges AND pins --match-head-commit!
  calls.length = 0;
  const merged = await executeSafePrMerge({
    prRef: "Spshulem/openAGI#284",
    expectedHeadSha: "abc1234567",
    mergePolicy: "manual_confirm",
    run: makeRun({
      state: "OPEN",
      isDraft: false,
      headRefOid: "abc1234567",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      statusCheckRollup: [{ name: "Portable runtime", status: "COMPLETED", conclusion: "SUCCESS" }]
    })
  });
  assert.equal(merged.status, "merged");
  const mergeCall = calls.find((c) => c[1] === "pr" && c[2] === "merge");
  assert.ok(mergeCall);
  assert.ok(mergeCall.includes("--squash") && !mergeCall.includes("--auto"));
  assert.equal(mergeCall[mergeCall.indexOf("--match-head-commit") + 1], "abc1234567");

  // 6. Pending CI under queue_when_green ALSO pins --match-head-commit!
  calls.length = 0;
  const queued = await executeSafePrMerge({
    prRef: "Spshulem/openAGI#284",
    expectedHeadSha: "abc1234567",
    mergePolicy: "queue_when_green",
    run: makeRun({
      state: "OPEN",
      isDraft: false,
      headRefOid: "abc1234567",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      statusCheckRollup: [{ name: "iOS mobile", status: "IN_PROGRESS", conclusion: null }]
    })
  });
  assert.equal(queued.status, "queued_when_green");
  const queueCall = calls.find((c) => c[1] === "pr" && c[2] === "merge");
  assert.ok(queueCall.includes("--auto") && queueCall.includes("--squash"));
  assert.equal(queueCall[queueCall.indexOf("--match-head-commit") + 1], "abc1234567");
});

test("progressive preference cards appear only after streaks and support 1-tap opt-in and veto", () => {
  let prefs = defaultPreferences();
  assert.deepEqual(buildProgressivePreferenceCards(prefs), []);

  // 3 routine dismissals -> offers cadence preference card
  for (let i = 0; i < 3; i += 1) {
    prefs = recordPreferenceSignal(prefs, {
      type: "dismiss",
      question: { id: `q_${i}`, kind: "agent-ask", title: "Run unit tests in scope?", options: ["yes", "no"] }
    });
  }
  const cadenceCards = buildProgressivePreferenceCards(prefs);
  assert.equal(cadenceCards.some((c) => c.id === "pref:cadence:quiet_until_ready"), true);

  // 5 consecutive affirmative approvals on safe routine test-fix slice -> offers slice card, NEVER auto-merge
  for (let i = 0; i < 5; i += 1) {
    prefs = recordPreferenceSignal(prefs, {
      type: "answer",
      answer: "yes",
      question: { id: `qt_${i}`, kind: "agent-ask", title: "Re-run failing unit tests in scope?", body: "Unit test flake in test suite.", options: ["yes", "no"] }
    });
  }
  const sliceCards = buildProgressivePreferenceCards(prefs);
  assert.equal(sliceCards.some((c) => c.id === "pref:slice:in_scope_test_fix"), true);
  assert.equal(prefs.mergePolicy, "manual_confirm");
});

test("supervisor getState builds Duet card deck, emits live fleet events on mutations, and routes through RemoteFleetSupervisor", async () => {
  const { supervisor, emitted, cleanup } = tempSupervisor({
    ghRun: async (_bin, args) => {
      if (args[0] === "pr" && args[1] === "view") {
        return {
          code: 0,
          stdout: JSON.stringify({
            state: "OPEN",
            isDraft: false,
            headRefOid: "sha111",
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            statusCheckRollup: [{ name: "CI", status: "COMPLETED", conclusion: "SUCCESS" }]
          }),
          stderr: ""
        };
      }
      if (args[0] === "pr" && args[1] === "merge") {
        return { code: 0, stdout: "Merged", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    }
  });
  try {
    supervisor.store.recordSnapshot({
      at: "2026-11-14T03:00:00.000Z",
      counts: { threads: 2, inScope: 2 },
      threads: [
        {
          key: "paseo:auth",
          kind: "paseo",
          title: "Fix OAuth refresh race",
          workspace: "openagi",
          repo: "Spshulem/openAGI",
          state: "ready-needs-human",
          health: "yellow",
          pr: { ref: "Spshulem/openAGI#284", state: "OPEN", title: "Fix OAuth refresh race", headOid: "sha111", ci: { state: "SUCCESS", failing: [], pending: [] } }
        },
        {
          key: "codex:runner",
          kind: "codex",
          title: "Refactor cron budget",
          workspace: "amman",
          state: "running",
          health: "green"
        }
      ],
      sourceErrors: {}
    });
    const q = supervisor.store.upsertQuestion({
      dedupeKey: "ready:Spshulem/openAGI#284",
      kind: "ready",
      threadKey: "paseo:auth",
      prRef: "Spshulem/openAGI#284",
      askedHead: "sha111",
      title: "openAGI #284 ready to merge?",
      body: "All checks green on Fix OAuth refresh race.",
      options: ["merged", "hold"]
    });

    const state = supervisor.getState();
    assert.equal(Array.isArray(state.cards), true);
    assert.equal(state.cards.length, 1);
    assert.equal(state.cards[0].id, q.id);
    assert.equal(state.cards[0].primaryAction.op, "merge");
    assert.equal(state.cards[0].primaryAction.label, "Merge PR");
    assert.equal(state.activeSummary.running, 1);
    assert.equal(state.preferences.mergePolicy, "manual_confirm");

    // Natural utterance resolver picks focused or topic-matched card
    const matched = matchCardForUtterance(state.cards, "yeah, go for it on the oauth one");
    assert.equal(matched.id, q.id);

    // Mobile route allowlist covers all 4 new endpoints
    assert.equal(isMobileRouteAllowed("GET", "/fleet/api/search"), true);
    assert.equal(isMobileRouteAllowed("POST", "/fleet/api/preferences"), true);
    assert.equal(isMobileRouteAllowed("POST", "/fleet/api/route"), true);
    assert.equal(isMobileRouteAllowed("POST", `/fleet/api/cards/${q.id}/act`), true);

    // Remote capability + RemoteFleetSupervisor end-to-end actCard & preferences
    const cap = createFleetCapability(supervisor);
    const remoteEvents = new EventEmitter();
    const remoteEmitted = [];
    remoteEvents.on("fleet", (e) => remoteEmitted.push(e));
    const remote = new RemoteFleetSupervisor({
      nodeId: "mac-1",
      runtime: {
        events: remoteEvents,
        nodeCapabilities: {
          dispatch: (_nodeId, _capId, op, payload) => cap.invoke(op, payload)
        }
      }
    });
    await remote.refresh();
    assert.equal(remote.getState().cards.length, 1);

    const acted = await remote.actCard(q.id, { op: "primary" });
    assert.equal(acted.ok, true);
    assert.equal(acted.status, "merged");
    assert.equal(supervisor.getState().cards.length, 0);
    assert.ok(emitted.some((e) => e.reason === "pr-merged"), "local supervisor emits live fleet SSE event immediately");
    assert.ok(remoteEmitted.length >= 2, "remote supervisor emits live fleet SSE event on card mutation");

    // Progressive preference card 1-tap primary action updates preference cleanly
    for (let i = 0; i < 3; i += 1) {
      supervisor.store.savePreferences(recordPreferenceSignal(supervisor.store.preferences(), {
        type: "dismiss",
        question: { id: `qd_${i}`, kind: "agent-ask", title: "Routine lint check?", options: ["yes", "no"] }
      }));
    }
    const prefCard = supervisor.getState().cards.find((c) => c.id === "pref:cadence:quiet_until_ready");
    assert.ok(prefCard);
    const prefActed = await remote.actCard(prefCard.id, { op: "primary" });
    assert.equal(prefActed.ok, true);
    assert.equal(supervisor.getState().preferences.cadence, "quiet_until_ready");

    const route = createFleetRoute({ supervisor });
    const closedRes = await route("POST", `/fleet/api/cards/${q.id}/act`, new URL(`http://localhost/fleet/api/cards/${q.id}/act`), async () => ({ op: "primary" }));
    assert.equal(closedRes.status, 404);
  } finally {
    cleanup();
  }
});

test("automatic routine slices persist answered questions, deduplicate across scans, and respect prior owner dismissals", async () => {
  const { supervisor, cleanup } = tempSupervisor();
  try {
    await supervisor.setMode("auto");
    let prefs = supervisor.store.preferences();
    prefs.autoSlices.in_scope_test_fix = "auto";
    supervisor.store.savePreferences(prefs);

    const deliveries = [];
    supervisor._executor = {
      deliver: async (payload) => {
        deliveries.push(payload);
        return { status: "sent", route: payload.route ?? "codex-exec", detail: "Delivered" };
      }
    };

    const thread = {
      key: "paseo:t-slice",
      kind: "paseo",
      title: "Fix unit tests",
      workspace: "openAGI",
      agentStatus: "idle",
      state: "needs-human",
      route: "paseo-send"
    };
    const byKey = new Map([[thread.key, thread]]);
    const t0 = Date.now() - 10 * 60_000;
    const decision = {
      action: "ask-user",
      threadKey: thread.key,
      playbook: null,
      question: {
        dedupeKey: "ask:paseo:t-slice:msg1",
        kind: "agent-ask",
        threadKey: thread.key,
        title: "Re-run failing unit tests in scope?",
        body: "Unit test flake in test suite.",
        options: ["yes", "no"],
        agentAskedAt: new Date(t0).toISOString()
      }
    };

    // Scan 1: sends once and persists answered question
    await supervisor.act([decision], {
      mode: "auto",
      byKey,
      manager: null,
      started: t0 + 60_000,
      config: supervisor.config,
      items: [{ thread }],
      skipReview: true
    });
    assert.equal(deliveries.length, 1);
    assert.equal(supervisor.store.openQuestions().length, 0);
    const stored = supervisor.store.state.questions.filter((q) => q.dedupeKey === "ask:paseo:t-slice:msg1");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].status, "answered");
    assert.equal(stored[0].answer, "yes");

    // Scan 2 with identical ask: deduplicated, zero duplicate deliveries!
    await supervisor.act([decision], {
      mode: "auto",
      byKey,
      manager: null,
      started: t0 + 5 * 60_000,
      config: supervisor.config,
      items: [{ thread }],
      skipReview: true
    });
    assert.equal(deliveries.length, 1, "second scan must not send duplicate automatic slice answer");

    // Autonomy summary exposes both server and client counter/veto field names
    const autonomy = supervisor.getState().autonomy;
    assert.equal(autonomy.handledToday, 1);
    assert.equal(autonomy.handledCount, 1);
    assert.equal(autonomy.autonomyPercent, 100);
    assert.equal(autonomy.autonomousPercent, 100);
    assert.equal(autonomy.recentActions[0].reverted, false);
    assert.equal(autonomy.recentActions[0].vetoed, false);

    // Owner previously dismissed a question: automatic slice must NOT override dismissal
    const dismissedQ = supervisor.store.upsertQuestion({
      dedupeKey: "ask:codex:t-slice:msg2",
      kind: "agent-ask",
      threadKey: thread.key,
      title: "Run lint suite again?",
      body: "ESLint check failed.",
      options: ["yes", "no"],
      agentAskedAt: new Date(t0 + 6 * 60_000).toISOString()
    });
    supervisor.store.dismissQuestion(dismissedQ.id);

    await supervisor.act([{
      action: "ask-user",
      threadKey: thread.key,
      playbook: null,
      question: {
        dedupeKey: "ask:codex:t-slice:msg2",
        kind: "agent-ask",
        threadKey: thread.key,
        title: "Run lint suite again?",
        body: "ESLint check failed.",
        options: ["yes", "no"],
        agentAskedAt: new Date(t0 + 6 * 60_000).toISOString()
      }
    }], {
      mode: "auto",
      byKey,
      manager: null,
      started: t0 + 7 * 60_000,
      config: supervisor.config,
      items: [{ thread }],
      skipReview: true
    });
    assert.equal(deliveries.length, 1, "must not auto-answer a question the owner already dismissed");

    // Background CLI failure (delivery.done -> false) reopens the question so next scan retries/surfaces it
    let bgAttempt = 0;
    supervisor._executor = {
      deliver: async (payload) => {
        bgAttempt += 1;
        return {
          status: "sent",
          route: payload.route ?? "claude-resume",
          detail: "Spawned background resume",
          done: Promise.resolve(bgAttempt > 1)
        };
      }
    };
    const bgAsk = {
      action: "ask-user",
      threadKey: thread.key,
      playbook: null,
      question: {
        dedupeKey: "ask:paseo:t-slice:bg-fail",
        kind: "agent-ask",
        threadKey: thread.key,
        title: "Re-run vitest suite?",
        body: "Flaky test in suite.",
        options: ["yes", "no"],
        agentAskedAt: new Date(t0 + 8 * 60_000).toISOString()
      }
    };
    await supervisor.act([bgAsk], {
      mode: "auto",
      byKey,
      manager: null,
      started: t0 + 8 * 60_000,
      config: supervisor.config,
      items: [{ thread }],
      skipReview: true
    });
    await new Promise((resolve) => setImmediate(resolve));
    const reopenedBg = supervisor.store.state.questions.find((q) => q.dedupeKey === "ask:paseo:t-slice:bg-fail");
    assert.equal(reopenedBg.status, "open", "failed background delivery must reopen the automatic answer");
    await supervisor.act([bgAsk], {
      mode: "auto",
      byKey,
      manager: null,
      started: t0 + 9 * 60_000,
      config: supervisor.config,
      items: [{ thread }],
      skipReview: true
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bgAttempt, 2, "next scan retries once reopened");
    assert.equal(supervisor.store.state.questions.find((q) => q.dedupeKey === "ask:paseo:t-slice:bg-fail").status, "answered");
  } finally {
    cleanup();
  }
});

test("preference card defer/dismiss keeps current setting, quiet_until_ready suppresses routine notifications, and RemoteFleetSupervisor preserves remote deck/autonomy", async () => {
  const { supervisor, dir, cleanup } = tempSupervisor();
  const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-remote-hub-"));
  try {
    // 1. Trigger slice preference card (5 consecutive approvals) and verify op: "defer" keeps "ask"
    let prefs = supervisor.store.preferences();
    for (let i = 0; i < 5; i += 1) {
      prefs = recordPreferenceSignal(prefs, {
        type: "answer",
        answer: "yes",
        question: { id: `qs_${i}`, kind: "agent-ask", title: "Re-run unit tests?", options: ["yes", "no"] }
      });
    }
    const { prefs: withActions } = recordAutonomousSliceAction(
      recordAutonomousSliceAction(prefs, { slice: "pr_review_followup", threadKey: "codex:a", summary: "Address review nit -> yes" }).prefs,
      { slice: "lockfile_rebase", threadKey: "codex:b", summary: "Rebase onto main -> yes" }
    );
    for (let i = 0; i < 3; i += 1) {
      withActions.streaks.dismissals += 1;
    }
    supervisor.store.savePreferences(withActions);

    const slicePref = supervisor.getState().cards.find((c) => c.id === "pref:slice:in_scope_test_fix");
    assert.ok(slicePref);
    const deferredOutcome = await supervisor.actCard("pref:slice:in_scope_test_fix", { op: "defer" });
    assert.equal(deferredOutcome.ok, true);
    assert.equal(supervisor.store.preferences().autoSlices.in_scope_test_fix, "ask", "deferring preference card must keep ask");
    assert.equal(supervisor.getState().cards.some((c) => c.id === "pref:slice:in_scope_test_fix"), false, "deferred proposal is snoozed");

    // 2. RemoteFleetSupervisor with dataDir (selfFixHub) preserves remote cadence preference card + 2 vetoable actions
    const cap = createFleetCapability(supervisor);
    const remote = new RemoteFleetSupervisor({
      nodeId: "mac-prod",
      dataDir: hubDir,
      runtime: {
        events: new EventEmitter(),
        nodeCapabilities: {
          dispatch: (_nodeId, _capId, op, payload) => cap.invoke(op, payload)
        }
      }
    });
    await remote.refresh();
    remote.selfFixHub.store.upsertQuestion({
      dedupeKey: "self-fix:fx_1",
      kind: "self-fix",
      title: "Approve self-fix PR #301?",
      body: "All checks passed.",
      options: ["Approve", "Request changes"]
    });
    const remoteState = remote.getState();
    assert.equal(remoteState.cards.some((c) => c.id === "pref:cadence:quiet_until_ready"), true, "preserves remote progressive preference card");
    assert.equal(remoteState.cards.some((c) => c.kind === "approval" && c.headline.includes("Approve self-fix")), true, "merges local selfFixHub card");
    assert.equal(remoteState.autonomy.recentActions.filter((a) => a.canVeto).length, 2, "preserves remote vetoable autonomy records");

    // 3. quiet_until_ready suppresses routine idle-report and suggestion notifications while allowing ready PR notifications
    supervisor.updatePreferences({ cadence: "quiet_until_ready" });
    const notified = [];
    supervisor._notifier = {
      notifyQuestion: async (q) => {
        notified.push(q.id);
        return { outreachId: `o_${q.id}`, pushed: false, skipped: null };
      }
    };
    const thread = { key: "codex:quiet", kind: "codex", title: "Quiet session", agentStatus: "idle", state: "idle-no-pr" };
    await supervisor.act([
      {
        action: "ask-user",
        threadKey: thread.key,
        playbook: "idle-report",
        question: {
          dedupeKey: "idle:codex:quiet",
          kind: "stuck",
          playbook: "idle-report",
          threadKey: thread.key,
          title: "Routine idle check-in",
          body: "Agent finished local step.",
          options: ["keep going", "later"]
        }
      },
      {
        action: "ask-user",
        threadKey: thread.key,
        playbook: "pr-ready",
        question: {
          dedupeKey: "ready:Spshulem/openAGI#299",
          kind: "ready",
          threadKey: thread.key,
          prRef: "Spshulem/openAGI#299",
          title: "PR #299 ready to merge",
          body: "Checks green.",
          options: ["merged", "later"]
        }
      }
    ], {
      mode: "propose",
      byKey: new Map([[thread.key, thread]]),
      manager: null,
      started: Date.now(),
      config: supervisor.config,
      items: [{ thread }],
      skipReview: false
    });
    assert.equal(notified.length, 1, "only ready PR should notify under quiet_until_ready");
    assert.equal(supervisor.store.question(notified[0]).kind, "ready");

    let suggestionNotified = 0;
    const suggestionMgr = new SuggestionManager({
      store: supervisor.store,
      config: supervisor.config,
      queueFix: async () => ({ id: "fix_0000000000000001" }),
      notify: async () => { suggestionNotified += 1; return { pushed: false }; },
      models: { explain: async () => ({}), duplicate: async () => false }
    });
    supervisor.store.saveSuggestion({
      id: "sg_quiet_test_0001",
      status: "open",
      area: "judge",
      metric: "judge:wait",
      remedy: "code",
      confidence: 0.6,
      score: 2,
      rootCause: "Minor prompt verbosity",
      proposedFix: "Tighten judge prompt",
      nextAction: "Edit prompt",
      acceptance: "Tests pass",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    await suggestionMgr.refresh();
    assert.equal(suggestionNotified, 0, "quiet_until_ready suppresses suggestion notifications");

    // 4. Switching to quiet_until_ready hides live routine outreach items and switching back to balanced restores them
    const outreach = new OutreachStore({ dir: path.join(dir, "outreach"), runtime: supervisor.runtime });
    supervisor.runtime.outreach = outreach;
    supervisor._notifier = null;
    supervisor.updatePreferences({ cadence: "balanced" });
    const routineQ = supervisor.store.upsertQuestion({
      dedupeKey: "idle:codex:reversible",
      kind: "stuck",
      playbook: "idle-report",
      threadKey: thread.key,
      title: "Reversible routine check-in",
      body: "Waiting on routine step.",
      options: ["keep going", "later"]
    });
    const notifyRes = await supervisor.notifier.notifyQuestion(routineQ);
    assert.ok(notifyRes.outreachId);
    assert.equal(outreach.get(notifyRes.outreachId).status, "unseen");
    supervisor.updatePreferences({ cadence: "quiet_until_ready" });
    assert.equal(outreach.get(notifyRes.outreachId).status, "dismissed");
    assert.equal(outreach.get(notifyRes.outreachId).decision, "resolved");
    supervisor.updatePreferences({ cadence: "balanced" });
    assert.equal(outreach.get(notifyRes.outreachId).status, "seen", "leaving quiet_until_ready restores open routine outreach item");
  } finally {
    fs.rmSync(hubDir, { recursive: true, force: true });
    cleanup();
  }
});

test("fleet_act_card pins the concrete resolved operation in queued approval args so card state drift cannot turn fix_ci into merge", async () => {
  let mergeCalled = false;
  const { supervisor, dir, cleanup } = tempSupervisor({
    ghRun: async (_bin, args) => {
      if (args[0] === "pr" && args[1] === "merge") mergeCalled = true;
      return {
        code: 0,
        stdout: JSON.stringify({
          state: "OPEN",
          isDraft: false,
          headRefOid: "sha777",
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          statusCheckRollup: [{ name: "CI", status: "COMPLETED", conclusion: "SUCCESS" }]
        }),
        stderr: ""
      };
    }
  });
  try {
    const sentMessages = [];
    supervisor.sendOwnerMessage = async (key, text) => {
      sentMessages.push({ key, text });
      return { delivery: { status: "sent", route: "paseo", detail: `Asked ${key} to fix CI.` } };
    };

    // Snapshot 1: PR #285 has failing CI -> primaryAction is fix_ci ("Have agent fix CI")
    supervisor.store.recordSnapshot({
      at: "2026-11-14T06:00:00.000Z",
      counts: { threads: 1, inScope: 1 },
      threads: [{
        key: "paseo:ci-fix",
        kind: "paseo",
        title: "Fix mobile layout",
        repo: "Spshulem/openAGI",
        state: "pr-not-ready",
        health: "red",
        pr: { ref: "Spshulem/openAGI#285", state: "OPEN", head: "sha777", ci: { state: "FAILURE", failing: ["iOS mobile"], pending: [] } }
      }],
      sourceErrors: {}
    });
    const q = supervisor.store.upsertQuestion({
      dedupeKey: "ready:Spshulem/openAGI#285",
      kind: "ready",
      threadKey: "paseo:ci-fix",
      prRef: "Spshulem/openAGI#285",
      askedHead: "sha777",
      title: "PR #285 checks failing",
      body: "iOS mobile check failed.",
      options: ["merged", "later"]
    });
    assert.equal(supervisor.getState().cards[0].primaryAction.op, "fix_ci");

    const pendingActions = new PendingActionStore({ dir: path.join(dir, "pending-actions") });
    const tools = new ToolRegistry();
    tools.bindPendingActions(pendingActions);
    registerFleetTools(tools, supervisor);

    // Queue approval with positional op: "primary" (no owner principal -> awaits confirmation)
    const queued = await tools.invoke("fleet_act_card", { cardId: q.id, op: "primary" }, { sessionId: "s1" });
    assert.equal(queued.ok, true);
    assert.equal(queued.result.status, "awaiting_confirmation");
    assert.match(queued.result.summary, /Have agent fix CI/i);
    const pending = pendingActions.get(queued.result.actionId);
    assert.equal(pending.args.op, "fix_ci", "prepared approval args must pin concrete op fix_ci");

    // Snapshot 2 arrives BEFORE owner approves: CI turns green -> card primaryAction flips to merge!
    supervisor.store.recordSnapshot({
      at: "2026-11-14T06:05:00.000Z",
      counts: { threads: 1, inScope: 1 },
      threads: [{
        key: "paseo:ci-fix",
        kind: "paseo",
        title: "Fix mobile layout",
        repo: "Spshulem/openAGI",
        state: "ready-needs-human",
        health: "yellow",
        pr: { ref: "Spshulem/openAGI#285", state: "OPEN", head: "sha777", ci: { state: "SUCCESS", failing: [], pending: [] } }
      }],
      sourceErrors: {}
    });
    assert.equal(supervisor.getState().cards[0].primaryAction.op, "merge");

    // Confirm the pending approval: must execute fix_ci, NEVER merge!
    const runtime = { pendingActions, tools };
    const executed = await executeApprovedAction(runtime, queued.result.actionId, { decidedBy: "user" });
    assert.equal(executed.status, 200);
    assert.equal(executed.invokeResult.result.kind, "fix_ci");
    assert.equal(mergeCalled, false, "approving fix_ci must never execute gh pr merge");
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].key, "paseo:ci-fix");
  } finally {
    cleanup();
  }
});
