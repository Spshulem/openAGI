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
import { ownerLabel } from "../src/fleet/policy.js";
import { paseoThread } from "../src/fleet/sources/paseo.js";
import { buildSupervisorCard } from "../src/fleet/cards.js";

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

test("ordinary merge never bypasses REVIEW_REQUIRED; merge_and_deploy and inline Paseo choice cards", async () => {
  // 1. REVIEW_REQUIRED + green checks: ordinary merge halts and offers Admin Merge; it never runs gh pr merge or --admin
  const calls = [];
  const runReviewProtected = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "pr" && args[1] === "view") {
      return {
        code: 0,
        stdout: JSON.stringify({
          state: "OPEN",
          isDraft: false,
          mergeStateStatus: "BLOCKED",
          mergeable: "MERGEABLE",
          reviewDecision: "REVIEW_REQUIRED",
          headRefOid: "abc9599def",
          statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
          url: "https://github.com/acme/webapp/pull/9599"
        }),
        stderr: ""
      };
    }
    if (args[0] === "pr" && args[1] === "checks" && args.includes("--required")) {
      return {
        code: 0,
        stdout: JSON.stringify([{ name: "test", state: "SUCCESS", bucket: "pass" }]),
        stderr: ""
      };
    }
    if (args[0] === "pr" && args[1] === "merge" && !args.includes("--admin")) {
      return { code: 1, stdout: "", stderr: "X Pull request #9599 is not mergeable: the base branch policy prohibits the merge." };
    }
    if (args[0] === "pr" && args[1] === "merge" && args.includes("--admin")) {
      return { code: 0, stdout: "Merged", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  };

  const halted = await executeSafePrMerge({
    prRef: "acme/webapp#9599",
    expectedHeadSha: "abc9599",
    run: runReviewProtected
  });
  assert.equal(halted.status, "halted");
  assert.equal(halted.reason, "review_required");
  assert.equal(halted.adminMergeOffered, true);
  assert.match(halted.detail, /Admin Merge/);
  assert.equal(calls.length, 1, "only the live read; no merge attempt");

  // A legacy ownerConfirmed flag changes nothing: still no merge, no --admin.
  const legacyFlag = await executeSafePrMerge({
    prRef: "acme/webapp#9599",
    expectedHeadSha: "abc9599",
    ownerConfirmed: true,
    run: runReviewProtected
  });
  assert.equal(legacyFlag.reason, "review_required");
  assert.equal(calls.filter((c) => c.includes("merge")).length, 0);
  assert.equal(calls.some((c) => c.includes("--admin")), false);

  // CHANGES_REQUESTED halts too.
  const changesRequested = await executeSafePrMerge({
    prRef: "acme/webapp#9599",
    run: async () => ({
      code: 0,
      stdout: JSON.stringify({
        state: "OPEN",
        isDraft: false,
        mergeStateStatus: "BLOCKED",
        mergeable: "MERGEABLE",
        reviewDecision: "CHANGES_REQUESTED",
        headRefOid: "abc9599def",
        statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }]
      }),
      stderr: ""
    })
  });
  assert.equal(changesRequested.status, "halted");

  // Missing/expected required check: ordinary merge still never tries --admin.
  let adminAttempted = false;
  const unpostedRequired = await executeSafePrMerge({
    prRef: "acme/webapp#9599",
    run: async (_cmd, args) => {
      if (args[0] === "pr" && args[1] === "view") {
        return {
          code: 0,
          stdout: JSON.stringify({
            state: "OPEN",
            isDraft: false,
            mergeStateStatus: "BLOCKED",
            mergeable: "MERGEABLE",
            reviewDecision: "REVIEW_REQUIRED",
            headRefOid: "abc9599def",
            statusCheckRollup: [{ name: "optional-lint", status: "COMPLETED", conclusion: "SUCCESS" }]
          }),
          stderr: ""
        };
      }
      if (args[0] === "pr" && args[1] === "merge" && !args.includes("--admin")) {
        return { code: 1, stdout: "", stderr: "blocked by branch protection" };
      }
      if (args[0] === "pr" && args[1] === "checks" && args.includes("--required")) {
        return {
          code: 8,
          stdout: JSON.stringify([{ name: "required-e2e", state: "EXPECTED", bucket: "pending" }]),
          stderr: ""
        };
      }
      if (args.includes("--admin")) adminAttempted = true;
      return { code: 0, stdout: "", stderr: "" };
    }
  });
  assert.equal(unpostedRequired.status, "halted");
  assert.equal(adminAttempted, false);

  // 2. merge_and_deploy + Paseo inline choice card delivery on risky production choice
  const delivered = [];
  const runClean = async (_cmd, args) => {
    if (args[0] === "pr" && args[1] === "view") {
      return {
        code: 0,
        stdout: JSON.stringify({
          state: "OPEN",
          isDraft: false,
          mergeStateStatus: "CLEAN",
          mergeable: "MERGEABLE",
          reviewDecision: "APPROVED",
          headRefOid: "abc9599def",
          statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
          url: "https://github.com/acme/webapp/pull/9599"
        }),
        stderr: ""
      };
    }
    if (args[0] === "pr" && args[1] === "merge" && !args.includes("--admin")) return { code: 0, stdout: "Merged", stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  const { supervisor, cleanup } = tempSupervisor({
    ghRun: runClean
  });
  try {
    await supervisor.setMode("auto");
    supervisor._executor = {
      deliver: async (payload) => {
        delivered.push(payload);
        return { status: "sent", route: "paseo-send", detail: "Paseo message and turn confirmed" };
      }
    };
    const paseoRow = {
      key: "paseo:host1.agent-5560",
      kind: "paseo",
      id: "agent-5560",
      title: "Success pages — consolidation #5560",
      workspace: "wks_a508e158846503a9",
      repo: "acme/webapp",
      agentStatus: "running",
      state: "needs-human",
      health: "red",
      requiresAttention: true,
      attentionReason: "async_question",
      pr: { ref: "acme/webapp#9599", state: "OPEN", head: "abc9599def", ci: { state: "SUCCESS", failing: [], pending: [] }, mergeState: "BLOCKED" },
      openChat: { app: "paseo", url: null, label: "Success pages (Paseo)", serverId: "host1", agentId: "agent-5560" },
      meta: { serverId: "host1", workspaceId: "wks_a508e158846503a9", paseoCwd: "/work/repo", updatedAt: "2026-11-14T20:00:00Z" }
    };
    supervisor.lastThreads.set(paseoRow.key, paseoRow);
    supervisor.store.recordSnapshot({
      at: "2026-11-14T20:01:00.000Z",
      counts: { threads: 1, inScope: 1 },
      threads: [paseoRow],
      sourceErrors: {}
    });

    const cardQ = supervisor.store.upsertQuestion({
      dedupeKey: "card:paseo:host1.agent-5560:aq-1",
      kind: "agent-card",
      threadKey: paseoRow.key,
      title: "Success pages: Where should we deploy?",
      body: "1. Staging only 2. Staging, then production",
      options: ["Staging only", "Staging, then production", "open thread"],
      meta: { app: "paseo", cardId: "aq-1" }
    });
    const prQ = supervisor.store.upsertQuestion({
      dedupeKey: "ready:acme/webapp#9599",
      kind: "ready",
      threadKey: paseoRow.key,
      prRef: "acme/webapp#9599",
      askedHead: "abc9599",
      title: "webapp #9599 ready to merge",
      body: "All checks passed.",
      options: ["merged", "later"]
    });

    const state = supervisor.getState();
    const inlineCard = state.cards.find((c) => c.id === cardQ.id);
    assert.equal(inlineCard.answerIn, "here");
    assert.equal(inlineCard.workspace, null, "opaque wks_* workspace ids are hidden");
    assert.equal(inlineCard.primaryAction.op, "answer");
    assert.equal(inlineCard.primaryAction.value, "Staging only");
    assert.equal(inlineCard.secondaryAction.op, "answer");
    assert.equal(inlineCard.secondaryAction.value, "Staging, then production");

    // Clicking secondary option ("Staging, then production", which matches RISKY_ASK) delivers via paseo-send!
    const answered = await supervisor.actCard(cardQ.id, { op: "secondary" });
    assert.equal(answered.ok, true);
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].message, /Staging, then production/);

    // Merge & Deploy card action merges (ordinary, no bypass) AND pings coding session!
    const readyCard = supervisor.getState().cards.find((c) => c.id === prQ.id);
    assert.ok(readyCard.extraActions.some((a) => a.op === "merge_and_deploy"));
    const shipped = await supervisor.actCard(prQ.id, { op: "merge_and_deploy" });
    assert.equal(shipped.ok, true);
    assert.equal(shipped.kind, "merge_and_deploy");
    assert.equal(delivered.length, 2);
    assert.match(delivered[1].message, /post-merge deployment/i);

    // Freeform inline reply on an open Paseo card closes the question and delivers Owner says: ...
    const followupQ = supervisor.store.upsertQuestion({
      dedupeKey: "card:paseo:host1.agent-5560:aq-2",
      kind: "agent-card",
      threadKey: paseoRow.key,
      title: "Success pages: Any extra rollout instructions?",
      body: "1. Default rollout 2. Custom rollout",
      options: ["Default rollout", "Custom rollout", "open thread"],
      meta: { app: "paseo", cardId: "aq-2" }
    });
    const replied = await supervisor.actCard(followupQ.id, {
      op: "reply",
      value: "Roll out to staging first and ping me once smoke checks pass."
    });
    assert.equal(replied.ok, true);
    assert.equal(replied.kind, "reply");
    assert.equal(delivered.length, 3);
    assert.match(delivered[2].message, /Roll out to staging first/);

    // Long (>40 char) Paseo choices sharing a 39-char prefix stay distinct and deliver the full untruncated label
    const longOptA = "Deploy to staging environment first and run full regression suite";
    const longOptB = "Deploy to staging environment first and skip regression suite";
    const longCardQ = supervisor.store.upsertQuestion({
      dedupeKey: "card:paseo:host1.agent-5560:aq-long",
      kind: "agent-card",
      threadKey: paseoRow.key,
      title: "Success pages: Rollout verification mode?",
      body: `1. ${longOptA} 2. ${longOptB}`,
      options: [`1. ${longOptA.slice(0, 36)}…`, `2. ${longOptB.slice(0, 36)}…`, "open thread"],
      meta: { app: "paseo", cardId: "aq-long", labels: [longOptA, longOptB] }
    });
    const longAnswered = await supervisor.actCard(longCardQ.id, { op: "secondary" });
    assert.equal(longAnswered.ok, true);
    assert.equal(delivered.length, 4);
    assert.ok(delivered[3].message.includes(longOptB), `expected full untruncated choice in "${delivered[3].message}"`);

    // Judge-reworded merge ask surfaces Merge PR, draft ask surfaces Mark ready, and wks_* headline uses thread title
    const judgeMergeQ = supervisor.store.upsertQuestion({
      dedupeKey: "ask:judge-merge-9599",
      kind: "agent-ask",
      threadKey: paseoRow.key,
      prRef: "acme/webapp#9599",
      mergeAsk: false,
      title: "webapp #9599: approve and merge?",
      options: ["approve merge", "not now"]
    });
    const draftAskQ = supervisor.store.upsertQuestion({
      dedupeKey: "ask:draft-9793",
      kind: "agent-ask",
      threadKey: paseoRow.key,
      prRef: "acme/webapp#9793",
      mergeAsk: true,
      title: "webapp #9793: mark draft ready to merge?",
      options: ["mark ready", "wait"]
    });
    const wksPromptQ = supervisor.store.upsertQuestion({
      dedupeKey: "prompt:wks-prompt",
      kind: "prompt",
      threadKey: paseoRow.key,
      title: "wks_a508e158846503a9: waiting on a prompt. Open it?",
      options: ["opened", "later"]
    });
    const nextCards = supervisor.getState().cards;
    assert.equal(nextCards.find((c) => c.id === judgeMergeQ.id).primaryAction.op, "merge");
    assert.equal(nextCards.find((c) => c.id === draftAskQ.id).primaryAction.op, "answer");
    assert.equal(nextCards.find((c) => c.id === draftAskQ.id).primaryAction.value, "mark ready");
    assert.match(nextCards.find((c) => c.id === wksPromptQ.id).headline, /^Success pages — consolidation #5560:/);

    // Structured Paseo choice cards mentioning 'Merge PR' in title keep their native choice actions
    const structuredChoiceQ = supervisor.store.upsertQuestion({
      dedupeKey: "card:paseo:host1.agent-5560:aq-choice-merge",
      kind: "agent-card",
      threadKey: paseoRow.key,
      prRef: "acme/webapp#9599",
      title: "Success pages: Merge PR now or deploy to staging first?",
      options: ["Deploy to staging first", "Merge PR now", "open thread"],
      meta: { app: "paseo", cardId: "aq-choice-merge", labels: ["Deploy to staging first", "Merge PR now"] }
    });
    const structuredChoiceCard = supervisor.getState().cards.find((c) => c.id === structuredChoiceQ.id);
    assert.equal(structuredChoiceCard.primaryAction.op, "answer");
    assert.equal(structuredChoiceCard.primaryAction.value, "Deploy to staging first");

    // Non-merge shipping asks ("Deploy the preview build to staging?" with ["ship it", "wait"]) stay answer cards
    const deployShipAskQ = supervisor.store.upsertQuestion({
      dedupeKey: "ask:deploy-preview-9599",
      kind: "agent-ask",
      threadKey: paseoRow.key,
      prRef: "acme/webapp#9599",
      mergeAsk: false,
      title: "Deploy the preview build to staging?",
      options: ["ship it", "wait"]
    });
    const deployShipCard = supervisor.getState().cards.find((c) => c.id === deployShipAskQ.id);
    assert.equal(deployShipCard.primaryAction.op, "answer");
    assert.equal(deployShipCard.primaryAction.value, "ship it");

    // Branch-update asks ("Merge main into this branch before continuing?") stay answer cards
    const branchUpdateAskQ = supervisor.store.upsertQuestion({
      dedupeKey: "ask:branch-update-9599",
      kind: "agent-ask",
      threadKey: paseoRow.key,
      prRef: "acme/webapp#9599",
      mergeAsk: false,
      title: "Merge main into this branch before continuing?",
      options: ["merge", "wait"]
    });
    const branchUpdateCard = supervisor.getState().cards.find((c) => c.id === branchUpdateAskQ.id);
    assert.equal(branchUpdateCard.primaryAction.op, "answer");
    assert.equal(branchUpdateCard.primaryAction.value, "merge");

    // Snapshot-generated draft PR rows preserve isDraft and keep "approve and merge?" as an answer action
    const draftThread = {
      key: "paseo:host1.agent-draft",
      kind: "paseo",
      title: "Draft feature #9801",
      agentStatus: "idle",
      live: true,
      prRefs: ["acme/webapp#9801"],
      meta: { app: "paseo", conversationId: "agent-draft" }
    };
    const draftSnap = supervisor.buildSnapshot({
      reason: "test",
      started: 1000,
      finished: 1050,
      mode: "auto",
      threads: [draftThread],
      inScope: [draftThread],
      items: [{
        thread: draftThread,
        classified: { state: "needs-human", reason: "draft pr", blockers: ["draft"] },
        pr: { ref: "acme/webapp#9801", url: "https://github.com/acme/webapp/pull/9801", state: "OPEN", isDraft: true, title: "Draft PR", ci: { state: "SUCCESS" }, unresolvedThreads: 0, mergeState: "DRAFT", headOid: "deadbeef00" }
      }],
      decisions: [],
      infra: {},
      sourceErrors: {},
      manager: null
    });
    assert.equal(draftSnap.threads[0].pr.isDraft, true);
    supervisor.store.recordSnapshot(draftSnap);
    const snapshotDraftAskQ = supervisor.store.upsertQuestion({
      dedupeKey: "ask:snapshot-draft-9801",
      kind: "agent-ask",
      threadKey: draftThread.key,
      prRef: "acme/webapp#9801",
      mergeAsk: false,
      title: "webapp #9801: approve and merge?",
      options: ["approve merge", "not now"]
    });
    const snapshotDraftCard = supervisor.getState().cards.find((c) => c.id === snapshotDraftAskQ.id);
    assert.equal(snapshotDraftCard.primaryAction.op, "answer");
    assert.equal(snapshotDraftCard.primaryAction.value, "approve merge");
  } finally {
    cleanup();
  }
});

test("rich decision context survives rotation via contextSnapshot, deduplicates timeline, marks CI failures, and preserves warm rows on transient source error", async () => {
  const { supervisor, cleanup } = tempSupervisor();
  try {
    const richThread = {
      key: "paseo:srv_4x2crHynU7yi.2ba43988-ba6b-4f7d-b8df-a8feb2378572",
      kind: "paseo",
      title: "Fix mobile auth token refresh & drawer",
      workspace: "amman",
      repo: "buildbetter-app/buildbetter",
      branch: "spencer/mobile-auth-9869",
      agentStatus: "idle",
      live: true,
      lastAgentText: "Implemented token refresh retry, added unit tests, and verified drawer state.",
      prRefs: ["buildbetter-app/buildbetter#9869"],
      meta: {
        app: "paseo",
        serverId: "srv_4x2crHynU7yi",
        conversationId: "2ba43988-ba6b-4f7d-b8df-a8feb2378572",
        conversation: [
          { role: "user", text: "Ship the mobile auth token refresh fix", at: "2026-11-15T08:00:00Z" },
          { role: "assistant", text: "Implemented token refresh retry, added unit tests, and verified drawer state.", at: "2026-11-15T08:15:00Z" }
        ]
      }
    };
    const richPr = {
      ref: "buildbetter-app/buildbetter#9869",
      url: "https://github.com/buildbetter-app/buildbetter/pull/9869",
      state: "OPEN",
      isDraft: false,
      title: "fix(auth): retry expired mobile session tokens cleanly",
      bodySummary: "Fixes silent token expiry on resume and adds regression coverage for the mobile drawer.",
      additions: 142,
      deletions: 38,
      changedFiles: 4,
      files: ["src/auth/refresh.ts", "src/ui/Drawer.tsx", "src/auth/refresh.test.ts", "src/api/client.ts"],
      gates: [{ label: "UI QA", state: "missing" }],
      qa: { required: true, freshOnHead: false },
      ci: { state: "SUCCESS" },
      unresolvedThreads: 0,
      mergeState: "CLEAN",
      headOid: "76e835bf61"
    };

    const warmSnap = supervisor.buildSnapshot({
      reason: "test",
      started: 1000,
      finished: 1050,
      mode: "propose",
      threads: [richThread],
      inScope: [richThread],
      items: [{
        thread: richThread,
        classified: { state: "ready-to-merge", reason: "PR green, review required", blockers: ["review-required"] },
        pr: richPr
      }],
      decisions: [],
      infra: {},
      sourceErrors: {},
      manager: null
    });
    supervisor.store.recordSnapshot(warmSnap);
    supervisor.lastThreads = new Map([[richThread.key, richThread]]);

    await supervisor.act([
      {
        action: "ask-user",
        threadKey: richThread.key,
        playbook: "merge-ready",
        reason: "not ready: UI QA missing",
        question: {
          dedupeKey: "ready:buildbetter-app/buildbetter#9869",
          kind: "ready",
          threadKey: richThread.key,
          prRef: richPr.ref,
          title: "buildbetter #9869 ready. Needs approve.",
          body: "buildbetter-app/buildbetter#9869 at 76e835bf61: CI green, 0 open threads, review required.",
          options: ["approved", "later"]
        }
      }
    ], {
      mode: "propose",
      byKey: new Map([[richThread.key, richThread]]),
      manager: null,
      started: 1000,
      config: supervisor.config,
      items: [{ thread: richThread, classified: { state: "ready-to-merge" }, pr: richPr }],
      skipReview: false
    });
    // Record two identical done decisions to verify timeline deduplication
    supervisor.store.recordAction({
      threadKey: richThread.key,
      action: "nudge",
      playbook: "merge-ready",
      reason: "not ready: UI QA missing",
      status: "done"
    });
    supervisor.store.recordAction({
      threadKey: richThread.key,
      action: "nudge",
      playbook: "merge-ready",
      reason: "not ready: UI QA missing",
      status: "done"
    });

    const cardLive = supervisor.getState().cards.find((c) => c.prRef === richPr.ref);
    assert.ok(cardLive);
    assert.match(cardLive.headline, /#9869 · fix\(auth\): retry expired mobile session tokens cleanly/);
    assert.equal(cardLive.sessionTitle, "Fix mobile auth token refresh & drawer");
    assert.match(cardLive.agentSummary, /Implemented token refresh retry/);
    assert.equal(cardLive.prContext?.additions, 142);
    assert.equal(cardLive.prContext?.deletions, 38);
    assert.equal(cardLive.prContext?.changedFiles, 4);
    assert.match(cardLive.prContext?.bodySummary ?? "", /Fixes silent token expiry/);
    assert.equal(cardLive.recentMessages?.length, 2);
    assert.equal(cardLive.openChat?.serverId, "srv_4x2crHynU7yi");
    assert.equal(cardLive.openChat?.agentId, "2ba43988-ba6b-4f7d-b8df-a8feb2378572");
    const agentRes = cardLive.resources.find((r) => r.kind === "conversation");
    assert.equal(agentRes?.serverId, "srv_4x2crHynU7yi");
    assert.equal(agentRes?.agentId, "2ba43988-ba6b-4f7d-b8df-a8feb2378572");
    const mergeReadyEntries = cardLive.timeline.filter((t) => t.label.includes("Playbook: merge-ready") && t.detail === "not ready: UI QA missing");
    assert.equal(mergeReadyEntries.length, 1, "duplicate timeline rows must be collapsed");

    // Simulate transient Paseo timeout on next scan: warm rows are carried forward instead of wiping to 0
    const transientErrSnap = supervisor.buildSnapshot({
      reason: "test-timeout",
      started: 2000,
      finished: 2050,
      mode: "propose",
      threads: [],
      inScope: [],
      items: [],
      decisions: [],
      infra: {},
      sourceErrors: { paseo: "Paseo request timed out." },
      manager: null,
      previous: warmSnap
    });
    assert.equal(transientErrSnap.threads.length, 1, "warm Paseo row preserved on transient source error");
    assert.equal(transientErrSnap.counts.inScope, 1);

    // Even if snapshot threads and in-memory maps are completely empty (e.g., cold restart before scan),
    // question.contextSnapshot preserves rich PR context, sessionTitle, recentMessages, and threadDetail/threadConversation!
    supervisor.lastThreads.clear();
    supervisor.knownThreads.clear();
    supervisor.knownRows.clear();
    supervisor.store.recordSnapshot({
      at: new Date().toISOString(),
      reason: "empty",
      durationMs: 5,
      mode: "propose",
      counts: { threads: 0, eligible: 0, inScope: 0, deferred: 0, sources: {}, byState: {}, byWatch: {}, needsYou: 1, actions: 0 },
      threads: [],
      infra: {},
      infraDecisions: [],
      sourceErrors: {}
    });

    const cardAfterRestart = supervisor.getState().cards.find((c) => c.prRef === richPr.ref);
    assert.ok(cardAfterRestart);
    assert.equal(cardAfterRestart.sessionTitle, "Fix mobile auth token refresh & drawer");
    assert.equal(cardAfterRestart.prContext?.additions, 142);
    assert.match(cardAfterRestart.prContext?.bodySummary ?? "", /Fixes silent token expiry/);
    assert.equal(cardAfterRestart.recentMessages?.length, 2);

    const fallbackDetail = supervisor.threadDetail(richThread.key);
    assert.ok(fallbackDetail, "threadDetail falls back to saved contextSnapshot instead of returning null/404");
    assert.equal(fallbackDetail.title, "Fix mobile auth token refresh & drawer");
    assert.match(fallbackDetail.lastAgentMessage?.text ?? "", /Implemented token refresh retry/);
    const fallbackConvo = await supervisor.threadConversation(richThread.key);
    assert.ok(fallbackConvo, "threadConversation falls back to saved contextSnapshot messages");
    assert.equal(fallbackConvo.messages.length, 2);
    assert.equal(supervisor.threadDetail("codex:nonexistent-xyz"), null, "genuinely unknown thread still returns null");

    // Failing CI PR gets kind === "ci_failed" ("CI Failed") instead of "merge_ready"
    const redRow = {
      key: "paseo:srv_4x2crHynU7yi.red1",
      kind: "paseo",
      title: "Fix flaky webhook test",
      pr: { ref: "buildbetter-app/buildbetter#9899", url: "https://github.com/buildbetter-app/buildbetter/pull/9899", state: "OPEN", ci: { state: "FAILURE" }, mergeState: "BLOCKED" }
    };
    supervisor.store.recordSnapshot({
      at: new Date().toISOString(),
      reason: "red",
      durationMs: 5,
      mode: "propose",
      counts: { threads: 1, eligible: 1, inScope: 1, deferred: 0, sources: {}, byState: {}, byWatch: {}, needsYou: 2, actions: 0 },
      threads: [redRow],
      infra: {},
      infraDecisions: [],
      sourceErrors: {}
    });
    const redQ = supervisor.store.upsertQuestion({
      dedupeKey: "stuck:red-9899",
      kind: "stuck",
      threadKey: redRow.key,
      prRef: "buildbetter-app/buildbetter#9899",
      title: "buildbetter #9899 CI failed",
      options: ["fix ci", "later"]
    });
    const redCard = supervisor.getState().cards.find((c) => c.id === redQ.id);
    assert.equal(redCard.kind, "ci_failed");
    assert.equal(redCard.kindLabel, "CI Failed");

    // When a session moves to PR #20 while an earlier question for PR #10 remains open,
    // card metadata stays bound to PR #10 instead of mixing PR #20's head/title.
    const movedKey = "paseo:srv_4x2crHynU7yi.multi-pr";
    const pr10 = { ref: "buildbetter-app/buildbetter#10", url: "https://github.com/buildbetter-app/buildbetter/pull/10", number: 10, title: "PR Ten Auth", bodySummary: "PR 10 summary", headOid: "1010101010abcdef", state: "OPEN", ci: { state: "SUCCESS" }, additions: 10, deletions: 2, changedFiles: 1 };
    const pr20 = { ref: "buildbetter-app/buildbetter#20", url: "https://github.com/buildbetter-app/buildbetter/pull/20", number: 20, title: "PR Twenty Billing", bodySummary: "PR 20 summary", headOid: "2020202020abcdef", state: "OPEN", ci: { state: "PENDING" }, additions: 99, deletions: 12, changedFiles: 5 };
    supervisor.lastPrs = new Map([[movedKey, pr20], [pr10.ref, pr10], [pr20.ref, pr20]]);
    supervisor.store.recordSnapshot({
      at: new Date().toISOString(),
      reason: "moved-pr",
      durationMs: 5,
      mode: "propose",
      counts: { threads: 1, eligible: 1, inScope: 1, deferred: 0, sources: {}, byState: {}, byWatch: {}, needsYou: 1, actions: 0 },
      threads: [{ key: movedKey, kind: "paseo", title: "Multi PR Session", pr: { ref: pr20.ref, title: pr20.title, head: "2020202020", ci: { state: "PENDING" } } }],
      infra: {},
      infraDecisions: [],
      sourceErrors: {}
    });
    const q10 = supervisor.store.upsertQuestion({
      dedupeKey: "ready:pr10",
      kind: "ready",
      threadKey: movedKey,
      prRef: pr10.ref,
      title: "buildbetter #10 ready",
      options: ["approved", "later"],
      askedHead: pr10.headOid
    });
    const card10 = supervisor.getState().cards.find((c) => c.id === q10.id);
    assert.equal(card10.prRef, pr10.ref);
    assert.equal(card10.prContext?.title, "PR Ten Auth");
    assert.equal(card10.headSha, "1010101010");
    assert.equal(card10.ciState, "SUCCESS");

    // Superseding an agent-ask with a thin snapshot preserves saved PR & conversation context,
    // and syntheticPaseoThread restores workspaceId for saved-question delivery preflight.
    const supKey = "paseo:srv_4x2crHynU7yi.sup1";
    supervisor.store.upsertQuestion({
      dedupeKey: "ask:sup:1",
      kind: "agent-ask",
      threadKey: supKey,
      prRef: pr10.ref,
      title: "Ship PR #10?",
      body: "Ready to ship?",
      options: ["yes", "no"],
      askContext: "Ready to ship PR #10?",
      agentAskedAt: "2026-11-15T08:00:00.000Z",
      contextSnapshot: {
        threadTitle: "Saved Session",
        paseoCwd: "/workspace/bb",
        paseoWorkspaceId: "wks_saved123",
        paseoHasWorkspaceId: true,
        recentMessages: [{ role: "assistant", text: "Earlier turn", at: "2026-11-15T08:00:00Z" }],
        pr: { ref: pr10.ref, title: "PR Ten Auth", bodySummary: "Rich body", additions: 10, deletions: 2, changedFiles: 1 }
      }
    });
    const sup2 = supervisor.store.upsertQuestion({
      dedupeKey: "ask:sup:2",
      kind: "agent-ask",
      threadKey: supKey,
      prRef: pr10.ref,
      title: "Ship PR #10 now?",
      body: "Updated question?",
      options: ["yes", "no"],
      agentAskedAt: "2026-11-15T08:05:00.000Z",
      contextSnapshot: {
        threadTitle: "Saved Session",
        paseoCwd: "/workspace/bb",
        recentMessages: [],
        pr: null
      }
    });
    assert.equal(sup2.contextSnapshot?.pr?.bodySummary, "Rich body", "thin supersede preserves saved PR context");
    assert.equal(sup2.contextSnapshot?.recentMessages?.length, 1, "thin supersede preserves saved recentMessages");
    supervisor.config.paseo = { enabled: true };
    const synth = supervisor.syntheticPaseoThread(supKey, sup2);
    assert.equal(synth.meta.workspaceId, "wks_saved123", "synthetic Paseo thread restores workspaceId for delivery preflight");

    // PR #291 follow-up: Paseo threads without PR keep distinct title in ownerLabel & buildSupervisorCard,
    // and non-draft PRs mentioning "draft" in feature names ("draft editor fixes") keep Merge PR action.
    const paseoNoPr = paseoThread(
      {
        id: "ag-billing-1",
        workspaceId: "wks_8899aabbccdd",
        title: "Billing webhook retries",
        cwd: "/Users/shooby/Dev/billing-service",
        status: "waiting",
        pendingPermissions: [{ id: "perm1" }],
        updatedAt: "2026-11-15T10:00:00.000Z"
      },
      "srv_mac"
    );
    assert.equal(paseoNoPr.workspace, null, "opaque wks_* workspaceId is stripped");
    assert.equal(ownerLabel(paseoNoPr, null, null), "Billing webhook retries", "ownerLabel uses Paseo chat title instead of generic Paseo chat");

    const genericTitlePaseo = paseoThread(
      {
        id: "ag-generic-1",
        workspaceId: "wks_8899aabbccdd",
        title: "Paseo chat",
        cwd: "/Users/shooby/Dev/billing-service",
        status: "waiting",
        updatedAt: "2026-11-15T10:00:00.000Z"
      },
      "srv_mac"
    );
    assert.equal(ownerLabel(genericTitlePaseo, null, null), "billing-service", "generic Paseo chat title falls back to paseoCwd folder");

    const healedGenericCard = buildSupervisorCard(
      {
        id: "q_paseo_generic_prefix",
        status: "open",
        kind: "prompt",
        threadKey: paseoNoPr.key,
        title: "Paseo chat: waiting on a prompt. Open it?",
        options: ["opened", "later"]
      },
      { threadsByKey: new Map([[paseoNoPr.key, paseoNoPr]]) }
    );
    assert.equal(healedGenericCard.headline, "Billing webhook retries: waiting on a prompt. Open it?");

    const nonDraftFeatureRow = {
      key: "paseo:srv_mac.draft-editor",
      kind: "paseo",
      title: "Draft editor fixes",
      pr: {
        ref: "acme/webapp#9910",
        state: "OPEN",
        isDraft: false,
        ci: { state: "SUCCESS", failing: [], pending: [] },
        mergeState: "CLEAN"
      }
    };
    const draftFeatureMergeCard = buildSupervisorCard(
      {
        id: "q_draft_editor_merge",
        status: "open",
        kind: "agent-ask",
        threadKey: nonDraftFeatureRow.key,
        prRef: "acme/webapp#9910",
        mergeAsk: true,
        title: "Merge the draft editor fixes PR?",
        options: ["merge", "wait"]
      },
      { rowsByKey: new Map([[nonDraftFeatureRow.key, nonDraftFeatureRow]]) }
    );
    assert.equal(draftFeatureMergeCard.kind, "merge_ready");
    assert.equal(draftFeatureMergeCard.primaryAction.op, "merge", "non-draft PR whose feature name contains 'draft' must keep Merge PR action");

    const convertToDraftCard = buildSupervisorCard(
      {
        id: "q_convert_to_draft",
        status: "open",
        kind: "agent-ask",
        threadKey: nonDraftFeatureRow.key,
        prRef: "acme/webapp#9910",
        mergeAsk: true,
        title: "Convert PR back to draft while staging bakes?",
        options: ["convert to draft", "wait"]
      },
      { rowsByKey: new Map([[nonDraftFeatureRow.key, nonDraftFeatureRow]]) }
    );
    assert.equal(convertToDraftCard.primaryAction.op, "answer", "explicit draft-status request stays an answer action");

    // Ready-for-review descriptive prose on non-draft PR keeps Merge PR action
    const descriptiveReadyCard = buildSupervisorCard(
      {
        id: "q_desc_ready_review",
        status: "open",
        kind: "agent-ask",
        threadKey: nonDraftFeatureRow.key,
        prRef: "acme/webapp#9910",
        mergeAsk: true,
        title: "Approve and merge PR #9910?",
        body: "The implementation is ready for review. All CI checks passed.",
        options: ["merge", "later"]
      },
      { rowsByKey: new Map([[nonDraftFeatureRow.key, nonDraftFeatureRow]]) }
    );
    assert.equal(descriptiveReadyCard.kind, "merge_ready");
    assert.equal(descriptiveReadyCard.primaryAction.op, "merge", "descriptive 'ready for review' prose must not suppress Merge PR");

    // <system_instruction> titles are sanitized across ownerLabel, card sessionTitle, openChat, resources, and activeSummary,
    // and "<repo> #<num> ready. Merge?" headlines upgrade to "#<num> · <prTitle>"
    const sysPromptPaseo = paseoThread(
      {
        id: "ag-sys-1",
        workspaceId: "san-jose",
        title: "<system_instruction> You are working inside Conductor, a Mac app that runs parallel coding agents",
        cwd: "/Users/shooby/.conductor/san-jose",
        status: "idle",
        updatedAt: "2026-11-15T11:00:00.000Z"
      },
      "srv_bb3"
    );
    assert.equal(ownerLabel(sysPromptPaseo, null, null), "san-jose", "ownerLabel strips <system_instruction> prompt text");

    const readyDotMergeCard = buildSupervisorCard(
      {
        id: "q_ready_dot_merge",
        status: "open",
        kind: "ready",
        threadKey: sysPromptPaseo.key,
        prRef: "acme/ai-seo#12",
        title: "AI-SEO #12 ready. Merge?",
        body: "acme/ai-seo#12 at a1b2c3d: CI pass.",
        options: ["merged", "later"]
      },
      {
        rowsByKey: new Map([[sysPromptPaseo.key, {
          key: sysPromptPaseo.key,
          kind: "paseo",
          title: sysPromptPaseo.title,
          workspace: "san-jose",
          pr: {
            ref: "acme/ai-seo#12",
            state: "OPEN",
            isDraft: false,
            title: "Add discovery-gap dashboard",
            bodySummary: "Adds /growth/discovery gap analysis.",
            ci: { state: "SUCCESS", failing: [], pending: [] },
            mergeState: "CLEAN"
          },
          openChat: { app: "paseo", label: `${sysPromptPaseo.title} (Paseo)`, serverId: "srv_bb3", agentId: "ag-sys-1" }
        }]])
      }
    );
    assert.equal(readyDotMergeCard.headline, "#12 · Add discovery-gap dashboard");
    assert.equal(readyDotMergeCard.sessionTitle, "san-jose");
    assert.ok(!String(readyDotMergeCard.openChat?.label ?? "").includes("system_instruction"));
    assert.equal(readyDotMergeCard.resources[0]?.label, "san-jose");

    // Multi-part decision ask with fragmentary question.body preserves full agentSummary choices and strips dead file:// attachments
    const multiPartThread = {
      key: "paseo:srv_bb3.yt-seo",
      kind: "paseo",
      title: "YouTube SEO",
      lastAgentFull: [
        "Before I start executing, confirm two choices:",
        "1. LinkedIn: (a) ship the 3 founder posts as drafted, or (b) hold until Tuesday?",
        "2. SEO batch: OK to build these 6?",
        "- Competitor comparison matrix",
        "- Pricing teardown guide"
      ].join("\n"),
      meta: {
        conversation: [
          { role: "user", text: "![Image](file:///tmp/paseo-attachments-qGRFiR/shot1.png)", at: "2026-11-15T09:00:00Z" },
          { role: "user", text: "Plan the LinkedIn & SEO rollout.", at: "2026-11-15T09:01:00Z" },
          { role: "assistant", text: "1. LinkedIn: (a) ship, (b) hold?\n2. SEO batch: OK to build these 6?", at: "2026-11-15T09:02:00Z" }
        ]
      }
    };
    const multiPartCard = buildSupervisorCard(
      {
        id: "q_multi_part",
        status: "open",
        kind: "agent-ask",
        threadKey: multiPartThread.key,
        title: "YouTube SEO: LinkedIn plan & SEO batch OK?",
        body: "2. SEO batch: OK to build these 6?",
        options: ["open thread", "later"]
      },
      { threadsByKey: new Map([[multiPartThread.key, multiPartThread]]) }
    );
    assert.match(multiPartCard.summary, /1\. LinkedIn:/, "summary preserves item 1 when question.body only captured trailing item 2");
    assert.match(multiPartCard.summary, /Competitor comparison matrix/, "summary preserves bullet details from agentSummary");
    assert.equal(multiPartCard.recentMessages.length, 2, "dead file:// image-only message is stripped from recentMessages");
    assert.ok(multiPartCard.recentMessages.every((m) => !m.text.includes("file:///tmp/")));

    // Leading short question followed by 1KB+ of implementation details preserves the actual question in summary
    const leadingAskThread = {
      key: "paseo:srv_bb3.prod-mig",
      kind: "paseo",
      title: "Production DB Migration",
      lastAgentFull: `Should I deploy the production migration?\n\nImplementation notes:\n${"Added backfill batching and zero-downtime index creation.\n".repeat(24)}`
    };
    const leadingAskCard = buildSupervisorCard(
      {
        id: "q_leading_ask",
        status: "open",
        kind: "agent-ask",
        threadKey: leadingAskThread.key,
        title: "Production DB Migration: wants a prod step. OK?",
        body: "Should I deploy the production migration?",
        options: ["approve", "later"]
      },
      { threadsByKey: new Map([[leadingAskThread.key, leadingAskThread]]) }
    );
    assert.match(leadingAskCard.summary, /Should I deploy the production migration\?/, "summary must anchor around question.body rather than taking only the tail");

    // Executive decision briefs, suggested quick replies, Paseo pendingPermissions (question & tool),
    // stale merged PR suppression on non-merge asks, UUID prefix cleanup, and inline reply resolution
    const { deliverPaseo } = await import("../src/fleet/paseo-delivery.js");
    const { reviewQuestions } = await import("../src/fleet/review.js");

    const verdicts = await reviewQuestions({
      questions: [
        {
          id: "fq_exec_1",
          kind: "ready",
          threadKey: "paseo:srv_bb3.cal1",
          prRef: "buildbetter-app/buildbetter#9637",
          title: "buildbetter #9637 ready. Needs approve.",
          body: "buildbetter-app/buildbetter#9637 at 63c2acf6bf: CI pass.",
          options: ["approved", "later"],
          createdAt: "2026-11-16T01:00:00.000Z"
        }
      ],
      runModel: async () => ({
        reviews: [
          {
            id: "fq_exec_1",
            decision: "keep",
            category: "live",
            reason: "PR #9637 is OPEN at head 63c2acf6bf.",
            briefContext: "Fixing duplicate SQS deliveries during long attendee CRM backfills.",
            briefSummary: "- Renews SQS visibility to 60s every 10s while backfill runs.\n- 2/2 real-SQS tests and BuildBot3 full run passed; no DB migration.",
            briefDecision: "Merge PR #9637 now, or reply if you also want historical DLQ messages replayed.",
            recommendation: "Safe to merge — full verification and SQS tests green with 0 open threads.",
            suggestedReplies: ["Merge looks good — also plan a dry-run DLQ check", "Hold until staging smoke finishes"]
          }
        ]
      })
    });
    assert.equal(verdicts[0]?.brief?.context, "Fixing duplicate SQS deliveries during long attendee CRM backfills.");
    assert.equal(verdicts[0]?.recommendation, "Safe to merge — full verification and SQS tests green with 0 open threads.");
    assert.deepEqual(verdicts[0]?.suggestedReplies, ["Merge looks good — also plan a dry-run DLQ check", "Hold until staging smoke finishes"]);

    const storedExecQ = supervisor.store.upsertQuestion({
      dedupeKey: "ready:exec:9637",
      kind: "ready",
      threadKey: "paseo:srv_bb3.cal1",
      prRef: "buildbetter-app/buildbetter#9637",
      title: "buildbetter #9637 ready. Needs approve.",
      body: "buildbetter-app/buildbetter#9637 at 63c2acf6bf: CI pass.",
      options: ["approved", "later"]
    });
    supervisor.store.recordReview(storedExecQ.id, {
      fingerprint: "fp_exec_1",
      reason: verdicts[0].reason,
      category: "live",
      brief: verdicts[0].brief,
      recommendation: verdicts[0].recommendation,
      suggestedReplies: verdicts[0].suggestedReplies
    });
    const execCard = buildSupervisorCard(supervisor.store.question(storedExecQ.id), {
      prsByKey: new Map([["buildbetter-app/buildbetter#9637", {
        ref: "buildbetter-app/buildbetter#9637",
        state: "OPEN",
        isDraft: false,
        title: "fix(calendar-worker): renew visibility during attendee CRM backfills",
        ci: { state: "SUCCESS", failing: [], pending: [] },
        mergeState: "CLEAN"
      }]])
    });
    assert.equal(execCard.brief?.context, "Fixing duplicate SQS deliveries during long attendee CRM backfills.");
    assert.match(execCard.brief?.whatChanged ?? "", /Renews SQS visibility/);
    assert.match(execCard.brief?.decision ?? "", /Merge PR #9637 now/);
    assert.equal(execCard.recommendation, "Safe to merge — full verification and SQS tests green with 0 open threads.", "recommendation uses human review advice rather than internal audit reason");
    assert.ok(!String(execCard.recommendation ?? "").includes("63c2acf6bf"), "internal SHA audit reason stays out of card.recommendation");
    assert.deepEqual(execCard.suggestedReplies, ["Merge looks good — also plan a dry-run DLQ check", "Hold until staging smoke finishes"]);

    // Paseo pendingPermissions kind === "question" (request_user_input_async) extracts actual question & answers directly via respondToPermissionAndWait,
    // while stale MERGED PR on non-merge question is hidden and UUID prefix is cleaned
    const permissionQuestionAgent = {
      id: "8bcede90-cd9f-4360-bd66-8a354fd50213",
      workspaceId: "7e19bf86-e489-4c3f-94b6-a3f9d9a33bdd",
      title: "7e19bf86-e489-4c3f-94b6-a3f9d9a33bdd",
      cwd: "/workspace/bb",
      status: "idle",
      updatedAt: "2026-11-16T02:30:00.000Z",
      pendingPermissions: [
        {
          id: "permission-call_stuck_card_1",
          provider: "codex",
          name: "request_user_input_async",
          kind: "question",
          title: "Question",
          input: {
            questions: [
              {
                id: "0",
                header: "Question 1",
                question: "What page URL is showing this stuck card, and is it staging or production?",
                options: [],
                isOther: true
              }
            ]
          }
        }
      ]
    };
    const permThread = paseoThread(permissionQuestionAgent, "srv_bb3", [
      { item: { type: "assistant_message", text: "Sibling PR https://github.com/buildbetter-app/buildbetter/pull/9698 already merged." }, timestamp: "2026-11-16T02:29:00.000Z" }
    ]);
    assert.equal(permThread.meta.blockedOnOwner, false, "question-kind pendingPermission surfaces as pendingCard rather than opaque blockedOnOwner prompt");
    assert.match(permThread.meta.pendingCard?.items?.[0]?.question ?? "", /What page URL is showing this stuck card/);

    supervisor.lastThreads.set(permThread.key, permThread);
    const stuckCardQ = supervisor.store.upsertQuestion({
      dedupeKey: `card:${permThread.key}:permission-call_stuck_card_1`,
      kind: "agent-card",
      threadKey: permThread.key,
      prRef: "buildbetter-app/buildbetter#9698",
      title: "7e19bf86-e489-4c3f-94b6-a3f9d9: What page URL is showing this stuck card?",
      card: "What page URL is showing this stuck card, and is it staging or production?",
      options: ["open thread"]
    });
    const stuckDeckCard = buildSupervisorCard(supervisor.questionView(stuckCardQ, new Map()), {
      threadsByKey: new Map([[permThread.key, permThread]]),
      prsByKey: new Map([["buildbetter-app/buildbetter#9698", {
        ref: "buildbetter-app/buildbetter#9698",
        state: "MERGED",
        title: "Continue onboarding in native Bob",
        bodySummary: "Old 99-file merged PR body that should not clutter a new unrelated question."
      }]])
    });
    assert.equal(stuckDeckCard.prContext, null, "settled MERGED PR is hidden on non-merge question cards");
    assert.equal(stuckDeckCard.sessionTitle, null, "settled MERGED PR title must not leak into sessionTitle");
    assert.ok(!stuckDeckCard.headline.includes("Continue onboarding"), "settled MERGED PR title must not leak into headline");
    assert.equal(stuckDeckCard.answerIn, "here", "Paseo question cards are answerable inline in Supervisor");
    assert.ok(!stuckDeckCard.headline.startsWith("7e19bf86-"), "opaque UUID prefix is stripped even without fallback session title");

    let capturedPermissionResponse = null;
    const permDelivery = await deliverPaseo({
      config: { paseo: { enabled: true, url: "ws://127.0.0.1:6767/ws" } },
      thread: permThread,
      text: "Owner says: Staging — https://staging.buildbetter.ai/home",
      store: supervisor.store,
      actionId: "act_perm_q1",
      base: { playbook: "owner-message", messageHash: "h1" },
      factory: () => ({
        connect: async () => {},
        close: async () => {},
        hosts: { list: async () => ({ self: { serverId: "srv_bb3" }, hosts: [] }) },
        respondToPermissionAndWait: async (agentId, reqId, resp) => {
          capturedPermissionResponse = { agentId, reqId, resp };
        },
        agents: {
          ref: () => ({
            refresh: async () => {},
            current: () => permissionQuestionAgent
          })
        }
      })
    });
    assert.equal(permDelivery.status, "sent");
    assert.deepEqual(capturedPermissionResponse, {
      agentId: "8bcede90-cd9f-4360-bd66-8a354fd50213",
      reqId: "permission-call_stuck_card_1",
      resp: {
        behavior: "allow",
        updatedInput: {
          answers: {
            "Question 1": "Staging — https://staging.buildbetter.ai/home"
          }
        }
      }
    });

    // Inline reply on an agent-card via actCard closes the question immediately on delivery
    supervisor._executor = {
      deliver: async () => ({ status: "sent", route: "paseo-send", detail: "Answered Paseo question directly" })
    };
    const inlineReplyRes = await supervisor.actCard(stuckCardQ.id, { op: "reply", value: "Staging — /home" });
    assert.equal(inlineReplyRes?.ok, true);
    assert.equal(supervisor.store.question(stuckCardQ.id)?.status, "answered", "inline reply on Paseo agent-card resolves question immediately");

    // Prose action-item asks with "tell me which to approve" (no question mark) classify as needs-human
    const { classifyThread: classifyForProse } = await import("../src/fleet/classify.js");
    const proseClassified = classifyForProse({
      key: "paseo:srv_bb3.prose-ask",
      kind: "paseo",
      id: "prose-ask",
      agentStatus: "idle",
      lastUserAt: "2026-11-15T08:00:00Z",
      lastAgentAt: "2026-11-15T08:05:00Z",
      lastAgentText: "To put it live:\n1. Review the seven articles on the preview and tell me which to approve.\n2. Upgrade your personal Vercel team to Pro.",
      lastAgentFull: "To put it live:\n1. Review the seven articles on the preview and tell me which to approve.\n2. Upgrade your personal Vercel team to Pro."
    });
    assert.equal(proseClassified.state, "needs-human");

    // 5. PR #296 review regressions:
    // (a) Owner Allow tap on Paseo permission card unwraps `Owner answer: Allow. Continue with that.` into behavior: "allow"
    const toolPermAgent = {
      id: "agent-tool-perm-1",
      cwd: "/workspace/bb",
      status: "idle",
      updatedAt: "2026-11-16T03:00:00.000Z",
      pendingPermissions: [
        {
          id: "perm_tool_1",
          kind: "tool",
          name: "bash",
          actions: [
            { id: "act_allow", label: "Allow", behavior: "allow" },
            { id: "act_deny", label: "Deny", behavior: "deny" }
          ]
        }
      ]
    };
    const toolPermThread = paseoThread(toolPermAgent, "srv_bb3", []);
    let toolPermCaptured = null;
    const allowRes = await deliverPaseo({
      config: { paseo: { enabled: true, url: "ws://127.0.0.1:6767/ws" } },
      thread: toolPermThread,
      text: "[OpenAGI supervisor] Owner answer: Allow. Continue with that.",
      store: supervisor.store,
      actionId: "act_tool_allow",
      base: { playbook: "owner-answer", messageHash: "h_allow" },
      expectedPermissionId: "perm_tool_1",
      factory: () => ({
        connect: async () => {},
        close: async () => {},
        hosts: { list: async () => ({ self: { serverId: "srv_bb3" }, hosts: [] }) },
        respondToPermissionAndWait: async (agentId, reqId, resp) => {
          toolPermCaptured = { agentId, reqId, resp };
        },
        agents: { ref: () => ({ refresh: async () => {}, current: () => toolPermAgent }) }
      })
    });
    assert.equal(allowRes.status, "sent");
    assert.deepEqual(toolPermCaptured, {
      agentId: "agent-tool-perm-1",
      reqId: "perm_tool_1",
      resp: { behavior: "allow", selectedActionId: "act_allow" }
    });

    // (b) Mismatched expectedPermissionId blocks instead of approving a replaced permission
    const replacedRes = await deliverPaseo({
      config: { paseo: { enabled: true, url: "ws://127.0.0.1:6767/ws" } },
      thread: toolPermThread,
      text: "[OpenAGI supervisor] Owner answer: Allow. Continue with that.",
      store: supervisor.store,
      actionId: "act_tool_stale",
      base: { playbook: "owner-answer", messageHash: "h_stale" },
      expectedPermissionId: "perm_old_gone",
      factory: () => ({
        connect: async () => {},
        close: async () => {},
        hosts: { list: async () => ({ self: { serverId: "srv_bb3" }, hosts: [] }) },
        respondToPermissionAndWait: async () => { throw new Error("must not approve mismatched permission"); },
        agents: { ref: () => ({ refresh: async () => {}, current: () => toolPermAgent }) }
      })
    });
    assert.equal(replacedRes.status, "blocked");
    assert.match(replacedRes.detail, /permission changed/i);

    // (c) Consecutive question permissions reusing question id "0" get distinct itemIds
    const secondPermThread = paseoThread({
      ...permissionQuestionAgent,
      pendingPermissions: [{
        ...permissionQuestionAgent.pendingPermissions[0],
        id: "permission-call_stuck_card_2",
        input: { questions: [{ id: "0", header: "Question 1", question: "Which user email hit the issue?", options: [] }] }
      }]
    }, "srv_bb3", []);
    assert.notEqual(
      permThread.meta.pendingCard.items[0].itemId,
      secondPermThread.meta.pendingCard.items[0].itemId,
      "consecutive permissions reusing sub-question id '0' must have distinct itemIds"
    );

    // (d) Multi-question permission rejects single unnumbered answer instead of fabricating Question 2, and accepts numbered answers
    const multiQAgent = {
      id: "agent-multi-q",
      cwd: "/workspace/bb",
      status: "idle",
      updatedAt: "2026-11-16T03:10:00.000Z",
      pendingPermissions: [{
        id: "perm_multi_1",
        kind: "question",
        name: "request_user_input_async",
        input: {
          questions: [
            { id: "0", header: "Question 1", question: "Staging or production?" },
            { id: "1", header: "Question 2", question: "Should we backfill existing rows?" }
          ]
        }
      }]
    };
    const multiQThread = paseoThread(multiQAgent, "srv_bb3", []);
    const partialMulti = await deliverPaseo({
      config: { paseo: { enabled: true, url: "ws://127.0.0.1:6767/ws" } },
      thread: multiQThread,
      text: "Owner says: Staging only",
      store: supervisor.store,
      actionId: "act_multi_partial",
      base: { playbook: "owner-answer", messageHash: "h_mp" },
      expectedPermissionId: "perm_multi_1",
      factory: () => ({
        connect: async () => {},
        close: async () => {},
        hosts: { list: async () => ({ self: { serverId: "srv_bb3" }, hosts: [] }) },
        respondToPermissionAndWait: async () => { throw new Error("must not resolve partial multi-question"); },
        agents: { ref: () => ({ refresh: async () => {}, current: () => multiQAgent }) }
      })
    });
    assert.equal(partialMulti.status, "blocked");
    assert.match(partialMulti.detail, /2 questions/i);

    let multiCaptured = null;
    const fullMulti = await deliverPaseo({
      config: { paseo: { enabled: true, url: "ws://127.0.0.1:6767/ws" } },
      thread: multiQThread,
      text: "Owner says: 1: Staging\n2: Yes, backfill last 7 days",
      store: supervisor.store,
      actionId: "act_multi_full",
      base: { playbook: "owner-answer", messageHash: "h_mf" },
      expectedPermissionId: "perm_multi_1",
      factory: () => ({
        connect: async () => {},
        close: async () => {},
        hosts: { list: async () => ({ self: { serverId: "srv_bb3" }, hosts: [] }) },
        respondToPermissionAndWait: async (_aid, reqId, resp) => { multiCaptured = { reqId, resp }; },
        agents: { ref: () => ({ refresh: async () => {}, current: () => multiQAgent }) }
      })
    });
    assert.equal(fullMulti.status, "sent");
    assert.deepEqual(multiCaptured?.resp?.updatedInput?.answers, {
      "Question 1": "Staging",
      "Question 2": "Yes, backfill last 7 days"
    });

    // (e) _supersedeAgentAsk clears stale reviewBrief when a newer agent ask replaces an open ask
    const ask1 = supervisor.store.upsertQuestion({
      dedupeKey: "ask:paseo:srv_bb3.sup1:t1",
      kind: "agent-ask",
      threadKey: "paseo:srv_bb3.sup1",
      title: "Run staging tests?",
      body: "Should I run the staging suite?",
      askContext: "Should I run the staging suite?",
      agentAskedAt: "2026-11-16T01:00:00.000Z",
      options: ["yes", "no"]
    });
    supervisor.store.recordReview(ask1.id, {
      fingerprint: "fp_sup_1",
      reason: "Staging tests are safe.",
      category: "live",
      brief: { context: "Staging check", whatChanged: "Nothing destructive", decision: "Run staging tests?" },
      recommendation: "Safe to proceed.",
      suggestedReplies: ["Yes, run staging tests"]
    });
    const ask2 = supervisor.store.upsertQuestion({
      dedupeKey: "ask:paseo:srv_bb3.sup1:t2",
      kind: "agent-ask",
      threadKey: "paseo:srv_bb3.sup1",
      title: "Delete production archive table?",
      body: "Confirm dropping legacy_archive in production?",
      askContext: "Confirm dropping legacy_archive in production?",
      agentAskedAt: "2026-11-16T02:00:00.000Z",
      options: ["yes", "no"]
    });
    assert.equal(ask2.id, ask1.id, "superseded ask reuses record id");
    assert.equal(supervisor.store.question(ask2.id).reviewBrief, null, "superseded ask clears stale reviewBrief");
    const supersededCard = buildSupervisorCard(supervisor.questionView(supervisor.store.question(ask2.id), new Map()));
    assert.notEqual(supersededCard.recommendation, "Safe to proceed.");
    assert.match(supersededCard.brief.decision, /legacy_archive/i);

    // (f) Suggestion and self-fix cards without a replyable threadKey report canReply: false and suggestedReplies: []
    const suggestionQ = supervisor.store.upsertQuestion({
      dedupeKey: "suggestion:sg_no_reply",
      kind: "suggestion",
      title: "Tighten judge timeout",
      body: "Proposed prompt improvement.",
      options: ["Approve", "Dismiss"]
    });
    const suggestionCard = buildSupervisorCard(supervisor.questionView(suggestionQ, new Map()));
    assert.equal(suggestionCard.canReply, false);
    assert.deepEqual(suggestionCard.suggestedReplies, []);

    // (g) Truncated 40+ char Paseo permission action label matches original action and approves instead of denying
    const longActionAgent = {
      id: "agent-long-perm",
      cwd: "/workspace/bb",
      status: "idle",
      updatedAt: "2026-11-16T03:20:00.000Z",
      pendingPermissions: [{
        id: "perm_long_1",
        kind: "tool",
        name: "bash",
        actions: [
          { id: "act_allow_session", label: "Allow this command for the rest of this session", behavior: "allow" },
          { id: "act_deny_session", label: "Deny this command", behavior: "deny" }
        ]
      }]
    };
    const longActionThread = paseoThread(longActionAgent, "srv_bb3", []);
    const truncatedLabel = longActionThread.meta.pendingPermission.actions[0].label;
    assert.ok(truncatedLabel.length <= 40);
    let longCaptured = null;
    const longRes = await deliverPaseo({
      config: { paseo: { enabled: true, url: "ws://127.0.0.1:6767/ws" } },
      thread: longActionThread,
      text: `[OpenAGI supervisor] Owner answer: ${truncatedLabel}. Continue with that.`,
      store: supervisor.store,
      actionId: "act_long_allow",
      base: { playbook: "owner-answer", messageHash: "h_long" },
      ownerChoice: truncatedLabel,
      expectedPermissionId: "perm_long_1",
      factory: () => ({
        connect: async () => {},
        close: async () => {},
        hosts: { list: async () => ({ self: { serverId: "srv_bb3" }, hosts: [] }) },
        respondToPermissionAndWait: async (_aid, reqId, resp) => { longCaptured = { reqId, resp }; },
        agents: { ref: () => ({ refresh: async () => {}, current: () => longActionAgent }) }
      })
    });
    assert.equal(longRes.status, "sent");
    assert.deepEqual(longCaptured, {
      reqId: "perm_long_1",
      resp: { behavior: "allow", selectedActionId: "act_allow_session" }
    });

    // (h) Live CI failure overrides cached green review recommendation
    const ciRegressedCard = buildSupervisorCard(supervisor.store.question(storedExecQ.id), {
      prsByKey: new Map([["buildbetter-app/buildbetter#9637", {
        ref: "buildbetter-app/buildbetter#9637",
        state: "OPEN",
        isDraft: false,
        title: "fix(calendar-worker): renew visibility during attendee CRM backfills",
        ci: { state: "FAILURE", failing: ["unit-tests"], pending: [] },
        mergeState: "CLEAN"
      }]])
    });
    assert.equal(ciRegressedCard.kind, "ci_failed");
    assert.match(ciRegressedCard.recommendation, /CI failed/i);

    // (i) Separate pending question permissions stay scoped to one permission request per card
    const twoPermsThread = paseoThread({
      ...permissionQuestionAgent,
      pendingPermissions: [
        { id: "perm_sep_1", kind: "question", input: { questions: [{ id: "0", header: "Question 1", question: "First request?" }] } },
        { id: "perm_sep_2", kind: "question", input: { questions: [{ id: "0", header: "Question 1", question: "Second request?" }] } }
      ]
    }, "srv_bb3", []);
    assert.equal(twoPermsThread.meta.pendingCard.requestId, "perm_sep_1");
    assert.equal(twoPermsThread.meta.pendingCard.items.length, 1);

    // (j) defaultPaths finds Linux ~/.config/codex-lb/env when ~/.codex/codex-lb.env is absent, and generic ": Question 1" headline expands to the actual ask
    const { defaultPaths } = await import("../src/fleet/contracts.js");
    const fakeLinuxHome = fs.mkdtempSync(path.join(os.tmpdir(), "fake-linux-home-"));
    try {
      assert.equal(defaultPaths(fakeLinuxHome).codexLbEnvFile, path.join(fakeLinuxHome, ".codex", "codex-lb.env"));
      fs.mkdirSync(path.join(fakeLinuxHome, ".config", "codex-lb"), { recursive: true });
      fs.writeFileSync(path.join(fakeLinuxHome, ".config", "codex-lb", "env"), "CODEX_LB_API_KEY=linux-key\n");
      assert.equal(defaultPaths(fakeLinuxHome).codexLbEnvFile, path.join(fakeLinuxHome, ".config", "codex-lb", "env"));
    } finally {
      fs.rmSync(fakeLinuxHome, { recursive: true, force: true });
    }
    const genericQ1Card = buildSupervisorCard({
      id: "fq_q1_head",
      kind: "agent-card",
      status: "open",
      threadKey: "paseo:srv_bb3.cli",
      title: "BuildBetter CLI: Question 1",
      card: "Should we deploy v1.2 (e.g. staging first) before fresh-signup check? You will need to open its verification email.",
      options: ["open thread"]
    });
    assert.match(genericQ1Card.headline, /Should we deploy v1\.2 \(e\.g\. staging first\)/);
    assert.ok(!genericQ1Card.headline.endsWith("Question 1"));
  } finally {
    cleanup();
  }
});
