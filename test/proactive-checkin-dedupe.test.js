import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FleetSupervisor } from "../src/fleet/supervisor.js";
import { FleetStore } from "../src/fleet/store.js";

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-checkin-dedupe-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function createMockSharedRuntime() {
  const events = [];
  const store = {
    sessions: new Map(),
    getSession(id) {
      return this.sessions.get(id) ?? null;
    },
    appendMessage(id, msg) {
      let sess = this.sessions.get(id);
      if (!sess) {
        sess = { id, messages: [], metadata: {} };
        this.sessions.set(id, sess);
      }
      const stored = {
        id: msg.id ?? `msg_${sess.messages.length + 1}`,
        role: msg.role,
        content: msg.content ?? msg.text ?? "",
        createdAt: msg.createdAt ?? new Date().toISOString(),
        metadata: msg.metadata ?? {}
      };
      sess.messages.push(stored);
      return sess;
    }
  };
  return {
    events: {
      emit(name, payload) {
        events.push({ name, payload });
      }
    },
    agentHost: { store },
    getSupervisorMessages() {
      return [...(store.getSession("devices:supervisor:main")?.messages ?? [])];
    },
    emittedEvents: events
  };
}

function makePaseoAskThread({
  id,
  title,
  repo,
  prRef = null,
  agentStatus = "idle",
  updatedAt,
  agentText
}) {
  return {
    key: `paseo:srv_local.${id}`,
    kind: "paseo",
    id,
    title,
    workspace: repo.split("/")[1] || id,
    repo,
    branch: `spencer/${id}`,
    agentStatus,
    archived: false,
    excluded: null,
    lastActivityAt: updatedAt,
    lastUserAt: "2026-11-22T17:00:00.000Z",
    lastUserText: "Ship it up to review",
    lastAgentAt: updatedAt,
    lastAgentText: agentText,
    lastAgentFull: agentText,
    prRefs: prRef ? [prRef] : [],
    meta: {
      serverId: "srv_local",
      provider: "codex",
      requiresAttention: agentStatus === "idle",
      attentionReason: agentStatus === "idle" ? "finished" : null,
      historyKnown: true,
      conversation: [
        { role: "user", text: "Ship it up to review", at: "2026-11-22T17:00:00.000Z" },
        { role: "assistant", text: agentText, at: updatedAt }
      ]
    }
  };
}

test("proactive Supervisor check-ins: silent on unchanged blockers, count/reorder/ID churn; delta-only on new or materially changed blockers", async () => {
  await withTempDir(async (dir) => {
    let nowMs = Date.parse("2026-11-22T18:00:00.000Z");
    const buzzPushes = [];
    const buzzEndpoint = "https://ping.buzzkit.dev/test-device";
    fs.mkdirSync(path.join(dir, "home", ".claude", "buzz"), { recursive: true });
    fs.writeFileSync(path.join(dir, "home", ".claude", "buzz", "endpoint"), `${buzzEndpoint}\n`, { mode: 0o600 });

    const runtime = createMockSharedRuntime();
    let currentThreads = [];
    let currentPrs = new Map();

    const sup = new FleetSupervisor({
      dataDir: dir,
      runtime,
      config: {
        enabled: true,
        mode: "auto",
        proactiveSupervisorChat: true,
        push: "buzzkit",
        paths: {
          home: path.join(dir, "home"),
          buzzEndpointFile: path.join(dir, "home", ".claude", "buzz", "endpoint")
        },
        paseo: { enabled: true, only: true },
        review: { enabled: false }
      },
      deps: {
        now: () => nowMs,
        fetchImpl: async (url, init) => {
          if (String(url) === buzzEndpoint) {
            buzzPushes.push(JSON.parse(init.body));
            return { ok: true, status: 200 };
          }
          throw new Error(`Unexpected fetch: ${url}`);
        },
        listPaseoThreads: async () => currentThreads,
        fetchPrStates: async () => currentPrs
      }
    });

    const blockerA = (at = "2026-11-22T17:58:00.000Z") => makePaseoAskThread({
      id: "sess_alpha",
      title: "buildbetter #10344",
      repo: "buildbetter-app/buildbetter",
      prRef: "buildbetter-app/buildbetter#10344",
      updatedAt: at,
      agentText: "**Blocked on:** your approval to authorize `--admin` merge on PR #10344.\n- authorize --admin merge\n- wait"
    });

    const blockerB = (at = "2026-11-22T17:59:00.000Z") => makePaseoAskThread({
      id: "sess_beta",
      title: "Paseo workspace port choice",
      repo: "buildbetter-app/paseo",
      updatedAt: at,
      agentText: "**Blocked on:** your decision on server port and iOS build.\n- client-only + beta.1\n- port 9803 first"
    });

    // -------------------------------------------------------------------------
    // Phase 1: Initial scan with 2 actionable blockers -> emits 1 message with both,
    // and both stay visible in Needs You.
    // -------------------------------------------------------------------------
    currentThreads = [blockerA(), blockerB()];
    const snap1 = await sup._tick("timer");
    assert.equal(snap1.at, "2026-11-22T18:00:00.000Z");

    let chatMsgs = runtime.getSupervisorMessages();
    assert.equal(chatMsgs.length, 1, "initial scan emits 1 proactive delta message");
    assert.match(chatMsgs[0].content, /10344/);
    assert.match(chatMsgs[0].content, /server port|Paseo/i);
    assert.doesNotMatch(chatMsgs[0].content, /coding sessions are currently running/i, "no noisy aggregate 0-running banner");
    assert.equal(buzzPushes.length, 2, "each initial blocker pushed once");

    const initialOpen = sup.store.openQuestions().filter((q) => q.kind !== "completed");
    assert.equal(initialOpen.length, 2);
    const oldAlphaId = initialOpen.find((q) => q.threadKey === "paseo:srv_local.sess_alpha")?.id;
    assert.ok(oldAlphaId);

    // -------------------------------------------------------------------------
    // Phase 2: Consecutive scans with unchanged blockers -> ZERO duplicate outreach,
    // while internal scanning (`snapshot.at`) and Needs You cards remain intact.
    // -------------------------------------------------------------------------
    for (let i = 1; i <= 3; i += 1) {
      nowMs += 30_000;
      const snapNext = await sup._tick("timer");
      assert.equal(snapNext.at, new Date(nowMs).toISOString(), "internal scan still advances");
    }
    assert.equal(runtime.getSupervisorMessages().length, 1, "consecutive unchanged scans send 0 new chat messages");
    assert.equal(buzzPushes.length, 2, "consecutive unchanged scans send 0 new pushes");
    assert.equal(sup.getState().questions.filter((q) => q.kind !== "completed").length, 2, "both remain visible in Needs You");

    // -------------------------------------------------------------------------
    // Phase 3: Aggregate count changes (running 0 -> 2 -> 0, passive completed cards
    // swelling total open questions, ActiveWork items changing) + reordering +
    // cosmetic review title polish -> ZERO duplicate outreach!
    // -------------------------------------------------------------------------
    // Simulate background review polishing the title/options while preserving askedAs
    sup.store.recordReview(oldAlphaId, {
      title: "buildbetter #10344: authorize admin merge?",
      options: ["authorize --admin merge", "wait"],
      fingerprint: "fp_1",
      reason: "still needs owner merge decision"
    });
    sup.activeWork.trackWork({
      project: "buildbetter",
      repo: "buildbetter-app/buildbetter",
      goal: "Finish release train",
      doneCriteria: "Merged"
    });

    for (let wave = 1; wave <= 3; wave += 1) {
      nowMs += 60_000;
      const passiveCompleted = Array.from({ length: wave * 3 }, (_, idx) => makePaseoAskThread({
        id: `passive_${wave}_${idx}`,
        title: `Completed background check ${wave}-${idx}`,
        repo: "buildbetter-app/buildbetter",
        updatedAt: new Date(nowMs - 1_000).toISOString(),
        agentText: "Finished routine verification cleanly."
      }));
      const runningWorker = makePaseoAskThread({
        id: "worker_running",
        title: "Active coding worker",
        repo: "buildbetter-app/buildbetter",
        agentStatus: wave === 2 ? "idle" : "running",
        updatedAt: new Date(nowMs).toISOString(),
        agentText: "Running tests..."
      });
      // Reverse the order of blockerB and blockerA every scan
      currentThreads = wave % 2 === 1
        ? [blockerB(), blockerA(), runningWorker, ...passiveCompleted]
        : [runningWorker, ...passiveCompleted, blockerA(), blockerB()];
      await sup._tick("timer");
    }

    assert.equal(runtime.getSupervisorMessages().length, 1, "count churn, running churn, review polish, and reordering emit 0 messages");
    assert.equal(buzzPushes.length, 2, "count/reorder churn emits 0 duplicate pushes");
    assert.ok(sup.store.openQuestions().length >= 5, "passive completed items changed total open count without re-pushing");

    // -------------------------------------------------------------------------
    // Phase 4: Question ID churn — blockerA closes transiently, >60m passes (past
    // REOPEN_MS so FleetStore issues a brand-new fq_* ID), and the same blocker returns.
    // Must stay visible in Needs You under the new ID with ZERO new chat/push outreach!
    // -------------------------------------------------------------------------
    nowMs += 60_000;
    currentThreads = [blockerB()]; // blockerA absent on this scan -> resolved
    await sup._tick("timer");
    assert.equal(sup.store.question(oldAlphaId).status, "resolved");

    // Advance 90 minutes (past 60m REOPEN_MS, inside 24h TTL) and bring blockerA back
    nowMs += 90 * 60_000;
    currentThreads = [blockerB(), blockerA("2026-11-22T19:35:00.000Z")];
    await sup._tick("timer");

    const reissuedAlpha = sup.store.openQuestions().find((q) => q.threadKey === "paseo:srv_local.sess_alpha" && q.kind !== "completed");
    assert.ok(reissuedAlpha, "reissued blockerA is open and visible in Needs You");
    assert.notEqual(reissuedAlpha.id, oldAlphaId, "blockerA received a brand-new fq_* question ID");
    assert.equal(runtime.getSupervisorMessages().length, 1, "reissued question ID for same decision sends 0 chat messages");
    assert.equal(buzzPushes.length, 2, "reissued question ID for same decision sends 0 BuzzKit pushes");

    // -------------------------------------------------------------------------
    // Phase 5: One genuinely NEW blocker (blockerC) arrives while blockerA & blockerB
    // remain unanswered -> sends ONLY blockerC (delta), never re-listing A or B!
    // -------------------------------------------------------------------------
    nowMs += 60_000;
    const blockerC = makePaseoAskThread({
      id: "sess_gamma",
      title: "bb-recorder Xcode 27.2 license",
      repo: "buildbetter-app/bb-recorder",
      updatedAt: new Date(nowMs).toISOString(),
      agentText: "**Single owner action:** On BuildBot2, run `sudo xcodebuild -license accept`."
    });
    currentThreads = [blockerA("2026-11-22T19:35:00.000Z"), blockerB(), blockerC];
    await sup._tick("timer");

    chatMsgs = runtime.getSupervisorMessages();
    assert.equal(chatMsgs.length, 2, "genuinely new blocker emits exactly 1 delta message");
    assert.match(chatMsgs[1].content, /one new decision needs you/i);
    assert.doesNotMatch(chatMsgs[1].content, /\bfq_[0-9a-z]+/i, "check-ins never show internal question ids");
    assert.match(chatMsgs[1].content, /xcodebuild -license accept|bb-recorder/i);
    assert.doesNotMatch(chatMsgs[1].content, /10344/, "old unanswered blockerA is NOT re-listed");
    assert.doesNotMatch(chatMsgs[1].content, /server port|Paseo/i, "old unanswered blockerB is NOT re-listed");
    assert.equal(buzzPushes.length, 3, "only the 1 new blocker is pushed");

    // Next scan with A, B, C all still unanswered -> silent!
    nowMs += 60_000;
    await sup._tick("timer");
    assert.equal(runtime.getSupervisorMessages().length, 2);

    // -------------------------------------------------------------------------
    // Phase 6: One existing blocker (blockerB) MATERIALLY changes on its thread ->
    // sends ONLY the updated blockerB delta, never re-listing A or C!
    // -------------------------------------------------------------------------
    nowMs += 60_000;
    const blockerBMutated = makePaseoAskThread({
      id: "sess_beta",
      title: "Paseo workspace port choice",
      repo: "buildbetter-app/paseo",
      updatedAt: new Date(nowMs).toISOString(),
      agentText: "**Blocked on:** production TLS certificate expired on relay; approve rotating cert now?\n- rotate production cert\n- hold"
    });
    currentThreads = [blockerA("2026-11-22T19:35:00.000Z"), blockerBMutated, blockerC];
    await sup._tick("timer");

    chatMsgs = runtime.getSupervisorMessages();
    assert.equal(chatMsgs.length, 3, "materially changed blocker emits exactly 1 delta message");
    assert.match(chatMsgs[2].content, /one decision changed and needs you|\*\*Changed:/i);
    assert.match(chatMsgs[2].content, /TLS certificate|rotate production cert/i);
    assert.doesNotMatch(chatMsgs[2].content, /10344/, "unchanged blockerA excluded from delta");
    assert.doesNotMatch(chatMsgs[2].content, /xcodebuild/i, "unchanged blockerC excluded from delta");

    // Subsequent scan stays silent again
    nowMs += 60_000;
    await sup._tick("timer");
    assert.equal(runtime.getSupervisorMessages().length, 3);
    assert.equal(
      sup.store.openQuestions().filter((q) => q.kind !== "completed").length,
      3,
      "all 3 actionable decisions remain open in Needs You"
    );
  });
});

test("legacy state.json upgrade seeds surfacedDecisions from already-notified open questions and deduplicates cross-node delta IDs", async () => {
  await withTempDir(async (dir) => {
    const fleetDir = path.join(dir, "fleet");
    fs.mkdirSync(fleetDir, { recursive: true });
    // Simulate pre-fix state.json with 2 already-open notified questions and prior digest notices
    fs.writeFileSync(
      path.join(fleetDir, "state.json"),
      JSON.stringify({
        version: 1,
        mode: "auto",
        questions: [
          {
            id: "fq_legacy_1",
            dedupeKey: "ready:o/r#10",
            kind: "ready",
            prRef: "o/r#10",
            title: "PR #10 ready for merge review",
            body: "CI is green.",
            options: ["Check PR", "skip"],
            status: "open",
            createdAt: "2026-11-22T18:00:00.000Z",
            updatedAt: "2026-11-22T18:00:00.000Z",
            outreachId: "out_legacy_1"
          }
        ],
        supervisorChatNotices: {
          "digest:old": { at: "2026-11-22T18:05:00.000Z", summary: "legacy check-in" }
        }
      }),
      { mode: 0o600 }
    );

    const store = new FleetStore({ dir: fleetDir, now: () => Date.parse("2026-11-22T18:10:00.000Z") });
    const diff = store.diffSurfacedDecisions(store.openQuestions(), { now: Date.parse("2026-11-22T18:10:00.000Z") });
    assert.equal(diff.deltas.length, 0, "pre-existing open questions are seeded on upgrade and not re-pushed");
    assert.equal(diff.unchangedCount, 1);

    // Deterministic messageId prevents duplicate chat rows when two worker nodes post the same delta to shared store
    const sharedRuntime = createMockSharedRuntime();
    const makeNodeSupervisor = (subDir) => new FleetSupervisor({
      dataDir: path.join(dir, subDir),
      runtime: sharedRuntime,
      config: { enabled: true, mode: "auto", proactiveSupervisorChat: true, paseo: { enabled: true, only: true }, review: { enabled: false } },
      deps: {
        now: () => Date.parse("2026-11-22T18:15:00.000Z"),
        listPaseoThreads: async () => [
          makePaseoAskThread({
            id: "sess_shared",
            title: "Shared Paseo Blocker",
            repo: "Spshulem/openAGI",
            updatedAt: "2026-11-22T18:14:00.000Z",
            agentText: "**Blocked on:** your go-ahead to publish release.\n- publish\n- hold"
          })
        ],
        fetchPrStates: async () => new Map()
      }
    });

    const node1 = makeNodeSupervisor("node1");
    const node2 = makeNodeSupervisor("node2");
    await node1._tick("timer");
    await node2._tick("timer");
    assert.equal(
      sharedRuntime.getSupervisorMessages().length,
      1,
      "deterministic delta messageId deduplicates identical delta across two worker nodes"
    );
  });
});
