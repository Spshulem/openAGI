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
import { defaultPreferences, recordPreferenceSignal, buildProgressivePreferenceCards } from "../src/fleet/preferences.js";

function tempSupervisor({ ghRun = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-cards-prefs-"));
  const events = new EventEmitter();
  const emitted = [];
  events.on("fleet", (payload) => emitted.push(payload));
  const supervisor = new FleetSupervisor({
    dir,
    runtime: { events },
    deps: {
      ...(ghRun ? { run: ghRun } : {})
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

  // 4. All checks green, open, non-draft, matching SHA, clean: squash merges cleanly!
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
  assert.ok(calls.some((c) => c[1] === "pr" && c[2] === "merge" && c.includes("--squash") && !c.includes("--auto")));
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
