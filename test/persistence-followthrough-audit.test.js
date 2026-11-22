import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RemoteFleetSupervisor } from "../src/fleet/remote.js";
import {
  OwnerPrecedentStore,
  isSafeLocalWorktreeCommitCommand,
  isSafeReadOnlyCommand
} from "../src/fleet/precedent-memory.js";
import { blockedOnSection, classifyThread } from "../src/fleet/classify.js";
import { FleetSupervisor, settledAsk } from "../src/fleet/supervisor.js";
import { createPaseoSource } from "../src/fleet/sources/paseo.js";
import { AbiRuntime } from "../src/abi-runtime.js";
import { FileBackedCronScheduler } from "../src/file-backed-cron-scheduler.js";

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-persistence-audit-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test("RemoteFleetSupervisor preserves online HTTP errors and reconciles delivered sends after timeout", async () => {
  await withTempDir(async (dir) => {
    let callNum = 0;
    const runtime = {
      events: { emit() {} },
      nodeCapabilities: {
        async dispatch(_nodeId, _cap, _op, payload) {
          callNum += 1;
          if (payload.path === "/fleet/api/questions/fq_1") {
            return {
              state: { mode: "auto", questions: [], actions: [], settings: {} },
              response: { status: 400, body: { error: "Question already closed." } }
            };
          }
          if (payload.path === "/fleet/api/send") {
            throw new Error("Node command timed out after 300s");
          }
          if (payload.path === "/fleet/api/state") {
            return {
              state: {
                mode: "auto",
                questions: [],
                actions: [
                  {
                    id: "act_verified_123",
                    threadKey: "paseo:srv_mac.375e1a66",
                    playbook: "owner-message",
                    status: "sent",
                    route: "paseo-send",
                    at: new Date().toISOString(),
                    detail: "Paseo message and turn confirmed"
                  }
                ],
                settings: {}
              },
              response: { status: 200, body: { ok: true } }
            };
          }
          throw new Error("unexpected");
        }
      }
    };

    const remote = new RemoteFleetSupervisor({ runtime, nodeId: "spencer-mac", dataDir: dir });

    // 1. Online node returning 400 must surface exact error, never "Fleet computer unavailable".
    await assert.rejects(
      () => remote.answerQuestion("fq_1", "yes"),
      (err) => {
        assert.equal(err.reached, true);
        assert.equal(err.message, "Question already closed.");
        assert.ok(!/unavailable/i.test(err.message));
        return true;
      }
    );

    // 2. Timeout on /fleet/api/send reconciles state.actions instead of falsely claiming agent offline.
    const sendRes = await remote.sendOwnerMessage("paseo:srv_mac.375e1a66", "Submit BB Recorder 0.4.1 for review");
    assert.equal(sendRes.reconciledAfterTimeout, true);
    assert.equal(sendRes.delivery.status, "sent");
    assert.equal(sendRes.delivery.reconciledReceipt, true);
    assert.equal(sendRes.delivery.actionId, "act_verified_123");
    assert.ok(callNum >= 3);
  });
});

test("isSafeReadOnlyCommand and isSafeLocalWorktreeCommitCommand clear routine permission cards while blocking mutations", () => {
  // Stderr redirections (`2>/dev/null`, `2>&1`) and `|| true`
  assert.equal(
    isSafeReadOnlyCommand("sed -n '1,240p' apps/web/src/foo.tsx 2>/dev/null || true"),
    true
  );
  // Shell variable assignment + gh api GET with `&` inside quoted URL (`fq_0dc0ac5b472a4b6a`)
  assert.equal(
    isSafeReadOnlyCommand('R=buildbetter-app/buildbetter; gh api "repos/$R/commits?path=packages/apps/desktop-app/package.json&sha=main&per_page=5" --jq \'.[]|.sha\''),
    true
  );
  // Read-only `paseo ls` and GitHub API `curl` GET (`fq_d442445377ef4868`, `fq_9788294b540449a4`)
  assert.equal(
    isSafeReadOnlyCommand("paseo ls --json | jq -r '.[] | [.id,.status] | @tsv' | head -80"),
    true
  );
  assert.equal(
    isSafeReadOnlyCommand("curl -L --max-time 15 -sS https://api.github.com/repos/Spshulem/strictly-regent/pulls/2 | head -c 4000"),
    true
  );
  // Non-force feature-branch push (`fq_0e9093dbd6404bb8`) allowed; main push or --force blocked!
  assert.equal(
    isSafeLocalWorktreeCommitCommand("git push -u origin fix/supervisor-composer-return", { branch: "fix/supervisor-composer-return" }),
    true
  );
  assert.equal(
    isSafeLocalWorktreeCommitCommand("git push -u origin main", { branch: "main" }),
    false
  );
  assert.equal(
    isSafeLocalWorktreeCommitCommand("git push --force origin fix/supervisor-composer-return", { branch: "fix/supervisor-composer-return" }),
    false
  );
  // Long untruncated rg command > 240 chars (`fq_d4476da2e1404878`)
  const longRg = `rg -n "useTranscript|SummaryPanel|CallShareTabs|PublicShareView|RecordingHeader" ${"packages/ui/src/components/ ".repeat(10)}apps/web/src`;
  assert.ok(longRg.length > 260);
  assert.equal(isSafeReadOnlyCommand(longRg), true);

  // Still blocks file output redirects, dangerous env vars, and secret files
  assert.equal(isSafeReadOnlyCommand("echo pwned > apps/web/src/foo.tsx"), false);
  assert.equal(isSafeReadOnlyCommand("LD_PRELOAD=/tmp/evil.so ls -la"), false);
  assert.equal(isSafeReadOnlyCommand("cat .env.production"), false);

  // Local feature-worktree git add + git commit (`fq_2c5fcd0d9fbf423c`)
  const commitCmd = 'git status --short && git add apps/web/src/components/call/summary-panel.tsx && git commit -m "Keep public share tabs full-width" && git show --stat --oneline -1';
  assert.equal(
    isSafeLocalWorktreeCommitCommand(commitCmd, {
      branch: "spencer/share-tabs-width",
      meta: { paseoCwd: "/Users/shooby/paseo/worktrees/buildbetter/share-tabs" }
    }),
    true
  );
  // Blocked on main branch or if `git push` / `--no-verify` is included
  assert.equal(
    isSafeLocalWorktreeCommitCommand(commitCmd, { branch: "main", meta: { paseoCwd: "/Users/shooby/Dev/buildbetter" } }),
    false
  );
  assert.equal(
    isSafeLocalWorktreeCommitCommand(`${commitCmd} && git push origin HEAD`, { branch: "spencer/share-tabs-width" }),
    false
  );
});

test("OwnerPrecedentStore skips TestFlight stop-before-submit diversion when activeGoal targets App Review and resolves routine hygiene via /v1/decisions", async () => {
  await withTempDir(async (dir) => {
    const store = new OwnerPrecedentStore({ dir });

    // 1. Active goal is App Store Review submission (`bb-recorder` 0.4.1): must NOT fire `prec_testflight_export_compliance`!
    const diverted = await store.evaluateCandidate({
      thread: {
        key: "paseo:srv_mac.375e1a66",
        agentStatus: "idle",
        lastUserText: "Submit BB Recorder 0.4.1 for Apple App Store Review",
        lastAgentText: "Build 3041 in TestFlight has MISSING_EXPORT_COMPLIANCE."
      },
      activeGoal: {
        id: "tw_fdb06841ca4f415f",
        goal: "Get BB Recorder 0.4.1 submitted for Apple App Store Review (Waiting for Review)",
        doneCriteria: "App Store version 0.4.1 in Waiting for Review"
      }
    });
    assert.equal(diverted.matched, false);

    // 2. Routine flaky CI rerun (`fq_fa1574b769134a09`) auto-resolves via `prec_engineering_hygiene` when /v1/decisions is >= 0.88 confident
    const hygiene = await store.evaluateCandidate(
      {
        question: {
          id: "fq_fa1574b769134a09",
          kind: "agent-ask",
          title: "buildbetter #7644: CI failed on flaky shard. Re-run?",
          body: "Only e2e-shard (3) timed out on a known transient runner flake; all code checks passed.",
          options: ["run CI once more", "later"]
        },
        thread: { key: "paseo:srv_mac.999", repo: "buildbetter-app/buildbetter" }
      },
      {
        env: { OPENAI_API_KEY: "sk-test" },
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          async json() {
            return {
              answers: [
                { name: "opt_0_routine_hygiene", probability: 0.95 },
                { name: "requires_owner_judgment", probability: 0.03 }
              ]
            };
          }
        })
      }
    );
    assert.equal(hygiene.matched, true);
    assert.equal(hygiene.precedentId, "prec_engineering_hygiene");
    assert.equal(hygiene.answer, "run CI once more");

    // 3. Hard Red Lines (PR merge) NEVER auto-resolve even if passed to evaluateCandidate
    const mergeAttempt = await store.evaluateCandidate({
      question: {
        id: "fq_merge_1",
        kind: "ready",
        mergeAsk: true,
        title: "Merge PR #332 into main?",
        options: ["Merge PR", "later"]
      }
    });
    assert.equal(mergeAttempt.matched, false);
    assert.equal(mergeAttempt.hardRedLine?.id, "pr_merge");
  });
});

test("classifyThread surfaces Single owner action sudo blocker as needs-human even with an open PR, and settledAsk closes already-merged PR #283", () => {
  const bbRecorderText = [
    "**Submission: not started.** BuildBot2 Xcode 27.2 license is not accepted.",
    "",
    "**Single owner action:** On BuildBot2, run: `sudo /Applications/Xcode_27.2_RecorderRelease20261113.app/Contents/Developer/usr/bin/xcodebuild -license accept`"
  ].join("\n");

  const section = blockedOnSection(bbRecorderText);
  assert.ok(section);
  assert.equal(section.owner.length, 1);
  assert.match(section.owner[0].text, /sudo .*xcodebuild -license accept/i);

  const classified = classifyThread(
    {
      key: "paseo:srv_mac.375e1a66",
      kind: "paseo",
      title: "BB Recorder 0.4.1 App Store submission",
      agentStatus: "idle",
      lastAgentAt: "2026-11-22T17:11:47Z",
      lastAgentText: bbRecorderText,
      lastAgentFull: bbRecorderText,
      prRefs: ["buildbetter-app/bb-recorder#442"],
      meta: { historyKnown: true }
    },
    {
      pr: {
        ref: "buildbetter-app/bb-recorder#442",
        state: "OPEN",
        isDraft: false,
        mergeState: "CLEAN",
        ci: { state: "FAILURE", failing: ["test"], pending: [] }
      },
      now: Date.parse("2026-11-22T17:12:00Z"),
      config: { selfSessionIds: [] }
    }
  );
  assert.equal(classified.state, "needs-human");
  assert.match(classified.ask?.text ?? "", /BuildBot2.*xcodebuild -license accept/i);

  // Inline `**Exact owner action:**` mid-line (`375e1a66` live phrasing) also classifies as needs-human!
  const inlineExactText = "- Only runner: `buildbot2-recorder-macos` **Exact owner action:** On BuildBot2 as `buildbot2`, clean the stale Xcode processes and complete Xcode 27.2’s interactive first-launch/license setup.";
  const inlineSection = blockedOnSection(inlineExactText);
  assert.ok(inlineSection);
  assert.equal(inlineSection.owner.length, 1);
  assert.match(inlineSection.owner[0].text, /BuildBot2.*Xcode 27\.2/i);

  // Stale migrated ask on openAGI #283 where createdAt > mergedAt because agentAskedAt was null
  const settled = settledAsk(
    {
      id: "fq_06e6d563731d494b",
      kind: "agent-ask",
      title: "openAGI #283: PR #283 is up. Merge it?",
      body: "PR #283 is up and ready for review.",
      agentAskedAt: null,
      createdAt: "2026-11-21T10:00:00Z",
      contextSnapshot: { lastAgentAt: "2026-11-14T06:20:00Z" }
    },
    {
      pr: {
        ref: "Spencerm7/openAGI#283",
        state: "MERGED",
        mergedAt: "2026-11-14T06:25:13Z"
      }
    }
  );
  assert.equal(settled, "#283 merged");

  // Genuine post-merge QA question asked AFTER merge still stands!
  const postMergeQa = settledAsk(
    {
      id: "fq_post_merge",
      kind: "agent-ask",
      title: "Merged #283; run staging smoke QA?",
      body: "PR #283 merged cleanly. Should I run staging QA?",
      agentAskedAt: "2026-11-14T07:00:00Z",
      createdAt: "2026-11-14T07:00:00Z"
    },
    {
      pr: {
        ref: "Spencerm7/openAGI#283",
        state: "MERGED",
        mergedAt: "2026-11-14T06:25:13Z"
      }
    }
  );
  assert.equal(postMergeQa, null);
});

test("createPaseoSource degrades gracefully when a remote peer host is offline instead of aborting local discovery", async () => {
  const source = createPaseoSource({
    factory: () => ({
      async connect() {},
      async close() {},
      hosts: {
        async list() {
          return {
            self: { serverId: "srv_local" },
            hosts: [{ serverId: "srv_remote", enabled: true, status: "offline" }]
          };
        },
        client() {
          throw new Error("Paseo host unavailable");
        }
      },
      agents: {
        async list() {
          return {
            entries: [
              {
                agent: {
                  id: "ag_1",
                  title: "Local Paseo Session",
                  status: "running",
                  activeTurn: true,
                  updatedAt: "2026-11-22T17:30:00Z",
                  pendingPermissions: [
                    {
                      id: "perm_1",
                      kind: "tool",
                      name: "CodexBash",
                      input: { command: `rg -n "needle" ${"packages/foo/ ".repeat(25)}` },
                      actions: [{ id: "allow", label: "Allow", behavior: "allow" }]
                    }
                  ]
                }
              }
            ],
            pageInfo: { hasMore: false }
          };
        }
      }
    })
  });

  const rows = await source({
    paseo: {
      enabled: true,
      url: "ws://127.0.0.1:6767/ws",
      serverIds: ["srv_remote"]
    }
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, "paseo:srv_local.ag_1");
  assert.ok(rows[0].meta.pendingPermission.rawCommand.length > 260);
  assert.deepEqual(rows.unknownThreadPrefixes, ["paseo:srv_remote."]);
});

test("FleetSupervisor post-delivery followThroughWatch posts verified blocker to devices:supervisor:main and auto-binds unassigned ActiveWork", async () => {
  await withTempDir(async (dir) => {
    const appendedMessages = [];
    const mockRuntime = {
      events: { emit() {} },
      agentHost: {
        store: {
          sessions: new Map(),
          getSession(id) {
            return this.sessions.get(id) ?? null;
          },
          createSession(s) {
            const entry = { id: s.id, messages: [], metadata: s.metadata ?? {} };
            this.sessions.set(s.id, entry);
            return entry;
          },
          appendMessage(id, msg) {
            let sess = this.sessions.get(id);
            if (!sess) {
              sess = { id, messages: [], metadata: {} };
              this.sessions.set(id, sess);
            }
            const stored = { id: `msg_${sess.messages.length + 1}`, createdAt: msg.createdAt ?? new Date().toISOString(), ...msg };
            sess.messages.push(stored);
            appendedMessages.push({ sessionId: id, ...stored });
            return sess;
          }
        }
      }
    };

    let currentAgentText = "Ready to check build.";
    let currentAgentAt = "2026-11-22T17:10:00Z";
    let currentStatus = "idle";
    const deliveredMessages = [];

    const sup = new FleetSupervisor({
      dataDir: dir,
      runtime: mockRuntime,
      env: {
        OPENAGI_FLEET_ENABLED: "1",
        OPENAGI_FLEET_MODE: "auto",
        OPENAGI_PASEO_ONLY: "1",
        OPENAGI_FLEET_REVIEW: "0"
      },
      deps: {
        now: () => Date.parse("2026-11-22T17:12:00Z"),
        listPaseoThreads: async () => [
          {
            key: "paseo:srv_mac.375e1a66",
            kind: "paseo",
            id: "375e1a66",
            title: "BB Recorder 0.4.1 App Store submission",
            workspace: "bb-recorder",
            repo: "buildbetter-app/bb-recorder",
            branch: "release/0.4.1",
            agentStatus: currentStatus,
            archived: false,
            excluded: null,
            lastActivityAt: currentAgentAt,
            lastUserAt: "2026-11-22T17:11:09Z",
            lastUserText: "Submit BB Recorder 0.4.1 for review",
            lastAgentAt: currentAgentAt,
            lastAgentText: currentAgentText,
            lastAgentFull: currentAgentText,
            prRefs: [],
            meta: { serverId: "srv_mac", provider: "codex", historyKnown: true, conversation: [] }
          }
        ],
        fetchPrs: async () => new Map(),
        executor: {
          async deliver({ thread, message }) {
            deliveredMessages.push({ key: thread.key, message });
            return {
              status: "sent",
              route: "paseo-send",
              actionId: "act_send_1",
              messageId: "msg_corr_1",
              turnId: "turn_corr_1",
              verifiedAt: "2026-11-22T17:11:09Z",
              detail: "Paseo message and turn confirmed"
            };
          }
        }
      }
    });

    // Track an UNASSIGNED ActiveWork goal for BB Recorder App Store submission
    const tracked = sup.activeWork.trackWork({
      project: "bb-recorder",
      repo: "buildbetter-app/bb-recorder",
      goal: "Submit BB Recorder 0.4.1 for App Store Review",
      doneCriteria: "App Store version 0.4.1 in Waiting for Review",
      permittedNudges: "resume_owner"
    });
    assert.equal(tracked.item.owner.threadKey, null);

    // Initial tick discovers session and auto-binds unassigned goal!
    await sup._tick("test");
    const rebound = sup.activeWork.state.items.find((it) => it.id === tracked.item.id);
    assert.equal(rebound.owner.threadKey, "paseo:srv_mac.375e1a66");

    // Owner sends directive; watch is registered
    const sent = await sup.sendOwnerMessage("paseo:srv_mac.375e1a66", "Submit 0.4.1 to App Review now");
    assert.equal(sent.delivery.status, "sent");
    assert.equal(sent.delivery.messageId, "msg_corr_1");
    assert.ok(sent.delivery.followThroughWatchId);
    assert.equal(sup.store.openFollowThroughWatches().length, 1);

    // 38 seconds later, session goes idle reporting Submission: not started + Single owner action
    currentAgentAt = "2026-11-22T17:11:47Z";
    currentAgentText = "**Submission: not started.**\n\n**Single owner action:** On BuildBot2, run: `sudo xcodebuild -license accept`";
    await sup._tick("follow-through");

    assert.equal(sup.store.openFollowThroughWatches().length, 0);
    assert.ok(appendedMessages.length >= 1);
    assert.equal(appendedMessages[0].sessionId, "devices:supervisor:main");
    assert.match(appendedMessages[0].content, /Post-send verification/i);
    assert.match(appendedMessages[0].content, /Submission: not started|xcodebuild -license accept/i);
  });
});

test("AbiRuntime upgrades legacy persisted agent-pulse cron prompt on boot", async () => {
  await withTempDir(async (dir) => {
    const cronFile = path.join(dir, "jobs.json");
    const cron1 = new FileBackedCronScheduler({ filePath: cronFile });
    cron1.addJob({
      id: "agent-pulse",
      name: "Legacy pulse",
      enabled: true,
      task: "autopilot",
      intervalMs: 30 * 60 * 1000,
      input: {
        agentId: "main",
        prompt: "If the queue is empty ({task: null}): reply 'standing by'."
      }
    });

    const cron2 = new FileBackedCronScheduler({ filePath: cronFile });
    const runtime = new AbiRuntime({ cron: cron2, dataDir: dir });
    const upgraded = runtime.cron.jobs.get("agent-pulse");
    assert.ok(upgraded);
    assert.match(upgraded.input.prompt, /verify_goal_progress/);
  });
});
