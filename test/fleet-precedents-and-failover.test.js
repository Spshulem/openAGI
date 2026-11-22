import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  OwnerPrecedentStore,
  checkHardRedLine,
  isSafeReadOnlyCommand
} from "../src/fleet/precedent-memory.js";
import { FleetStore } from "../src/fleet/store.js";
import { paseoThread } from "../src/fleet/sources/paseo.js";
import { failoverPaseoSessionProvider, resolveDefaultPaseoModeId, selectBestPaseoModel } from "../src/fleet/paseo-delivery.js";
import { resolvePaseoAgentConfig } from "../src/fleet/coordinator.js";
import { buildSupervisorDeck } from "../src/fleet/cards.js";
import { FleetSupervisor } from "../src/fleet/supervisor.js";
import { fleetStatus } from "../src/fleet/tools.js";
import { ToolRegistry, registerCoreTools } from "../src/tool-registry.js";
import { SkillRegistry } from "../src/skills.js";

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-audit-fixes-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test("isSafeReadOnlyCommand strictly allows read-only inspections and blocks mutations/secrets", () => {
  assert.equal(isSafeReadOnlyCommand("Run `rg -n \"SupervisorView\" mobile/ios && sed -n '1,40p' README.md`"), true);
  assert.equal(isSafeReadOnlyCommand("git status -sb && echo \"---\" && git log -n 5 --oneline"), true);
  assert.equal(isSafeReadOnlyCommand("gh pr view 332 --json state,statusCheckRollup && gh pr checks 332"), true);

  // Mutations, redirects, subshells, merges, and sensitive files are rejected.
  assert.equal(isSafeReadOnlyCommand("sed -i 's/foo/bar/g' README.md"), false);
  assert.equal(isSafeReadOnlyCommand("gh pr merge 332 --squash"), false);
  assert.equal(isSafeReadOnlyCommand("cat .env.production"), false);
  assert.equal(isSafeReadOnlyCommand("rg foo > /tmp/out.txt"), false);
  assert.equal(isSafeReadOnlyCommand("cat $(whoami)"), false);
  assert.equal(isSafeReadOnlyCommand("rm -rf build"), false);
});

test("checkHardRedLine enforces unconditional firewall on PR merges, prod deploys, external sends, spend, deletes, and SSO", () => {
  assert.equal(checkHardRedLine({ kind: "ready", title: "PR #10291 ready" }).blocked, true);
  assert.equal(checkHardRedLine({ mergeAsk: true, title: "Can I merge this?" }).blocked, true);
  assert.equal(checkHardRedLine({ title: "Should I merge #350 into main now?" }).id, "pr_merge");
  assert.equal(checkHardRedLine({ title: "Deploy to production cluster now?" }).id, "prod_deploy_or_release");
  assert.equal(checkHardRedLine({ title: "Send the follow-up email to Brex customer team?" }).id, "external_customer_or_team_send");
  assert.equal(checkHardRedLine({ title: "Purchase more credits ($50) on OpenAI?" }).id, "paid_spend");
  assert.equal(checkHardRedLine({ title: "Complete Vercel SSO login in browser" }).id, "human_sso_or_2fa");

  // Non-red-line internal engineering checks pass through.
  assert.equal(checkHardRedLine({ kind: "prompt", body: "Run `git status -sb`" }).blocked, false);
});

test("OwnerPrecedentStore backfills FleetStore history, routes AppFolio to buildbetter-staging MCP, and matches >= 0.85 precedents", async () => {
  await withTempDir(async (dir) => {
    const fleetDir = path.join(dir, "fleet");
    const fleetStore = new FleetStore({ dir: fleetDir });
    const q = fleetStore.upsertQuestion({
      kind: "agent-ask",
      dedupeKey: "ask:vitest-rerun",
      threadKey: "paseo:srv_1.agent_1",
      title: "Flaky CI vitest shard timed out — rerun failed shard?",
      body: "Unit shard 2 timed out transiently with no code diff touching that module. Rerun failed shard?",
      options: ["Rerun shard", "Wait"],
      contextSnapshot: { repo: "buildbetter-app/buildbetter", workspace: "buildbetter" }
    });
    fleetStore.answerQuestion(q.id, "Rerun shard");

    // Merge question must NEVER be backfilled as an autonomous precedent.
    const mergeQ = fleetStore.upsertQuestion({
      kind: "ready",
      dedupeKey: "ready:buildbetter-app/buildbetter#10291",
      threadKey: "paseo:srv_1.agent_2",
      prRef: "buildbetter-app/buildbetter#10291",
      title: "PR #10291 ready to merge",
      body: "All checks passed.",
      options: ["Merge PR", "Skip"]
    });
    fleetStore.answerQuestion(mergeQ.id, "Merge PR");

    const precStore = new OwnerPrecedentStore({ dir: fleetDir });
    const backfilled = precStore.backfillFromFleetStore(fleetStore);
    assert.equal(backfilled, 1);

    // 1. Read-only CodexBash prompt auto-allows deterministically.
    const roEval = await precStore.evaluateCandidate({
      question: {
        kind: "prompt",
        title: "CodexBash permission",
        body: "Run `rg -n \"AppFolio\" src/`",
        options: ["Allow", "Deny"]
      },
      thread: {
        key: "paseo:srv_1.agent_ro",
        meta: { pendingPermission: { command: "rg -n \"AppFolio\" src/" } }
      }
    });
    assert.equal(roEval.matched, true);
    assert.equal(roEval.answer, "Allow");

    // 2. AppFolio Lifecycles report blocked on prod MCP routes to buildbetter-staging MCP.
    const appfolioEval = await precStore.evaluateCandidate({
      thread: {
        key: "paseo:srv_4x2crHynU7yi.349270e1-9d4b-4b2d-ac2d-f03c8153c55e",
        title: "AppFolio Rubric Expectations Review",
        agentStatus: "idle",
        lastAgentText: "Blocked: production BuildBetter MCP workspace returned no result for AppFolio Lifecycles create_report."
      }
    });
    assert.equal(appfolioEval.matched, true);
    assert.equal(appfolioEval.precedentId, "prec_appfolio_staging_mcp");
    assert.match(appfolioEval.directive, /buildbetter-staging/);

    // 3. Semantic precedent match via `/v1/decisions` >= 0.85.
    const semEval = await precStore.evaluateCandidate(
      {
        question: {
          id: "fq_new_flake",
          dedupeKey: "ask:vitest-rerun-2",
          kind: "agent-ask",
          title: "Flaky CI vitest shard timed out on shard 3 — rerun failed shard?",
          body: "Transient timeout on vitest shard 3 with unrelated diff. Should I rerun shard?",
          options: ["Rerun shard", "Wait"],
          contextSnapshot: { repo: "buildbetter-app/buildbetter" }
        }
      },
      {
        decisionsConfig: { apiKey: "test-key", url: "https://api.openai.test/v1/decisions" },
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            answers: [
              { name: "matches_precedent", probability: 0.93 },
              { name: "crosses_red_line", probability: 0.02 }
            ]
          })
        })
      }
    );
    assert.equal(semEval.matched, true);
    assert.equal(semEval.answer, "Rerun shard");
    assert.ok(semEval.confidence >= 0.85);
  });
});

test("paseoThread detects [System Error] usage-limit on running sessions and switchPaseoProvider fails over Codex -> Claude with ActiveWork handoff", async () => {
  const runningQuotaAgent = {
    id: "ea506dbc-3866-41ec-9319-ea45facb91c0",
    title: "Bob unified chat experience",
    status: "running",
    provider: "codex/gpt-5.4",
    cwd: "/home/dev/buildbetter",
    createdAt: "2026-11-22T01:00:00.000Z",
    updatedAt: "2026-11-22T03:00:00.000Z"
  };
  const entries = [
    {
      timestamp: "2026-11-22T02:58:00.000Z",
      item: { type: "user_message", text: "Unify the Bob chat composer across web and desktop." }
    },
    {
      timestamp: "2026-11-22T03:00:00.000Z",
      item: {
        type: "assistant_message",
        text: "[System Error] You've hit your usage limit. Upgrade to Pro or try again at Nov 24th, 2026 9:14 AM."
      }
    }
  ];

  const mapped = paseoThread(runningQuotaAgent, "srv_bb3", entries, true);
  assert.equal(mapped.agentStatus, "error");
  assert.equal(mapped.error?.kind, "usage-limit");

  let createdSpec = null;
  const fakeFactory = () => ({
    connect: async () => {},
    close: async () => {},
    hosts: { list: async () => ({ self: { serverId: "srv_bb3" }, hosts: [] }) },
    agents: {
      ref: () => ({
        refresh: async () => {},
        current: () => runningQuotaAgent,
        timeline: { refetch: async () => ({ entries }) }
      }),
      create: async (spec) => {
        createdSpec = spec;
        return { id: "claude-continuation-999" };
      }
    },
    providers: {
      waitForReady: async () => ({
        entries: [
          { provider: "codex", status: "ready", models: [{ id: "gpt-5.4", isDefault: true }] },
          { provider: "claude", status: "ready", models: [{ id: "claude-opus-4-6", isDefault: true }] },
          { provider: "antigravity", status: "ready", models: [{ id: "gemini-4-pro", isDefault: true }] }
        ]
      })
    }
  });

  // Direct unit check on failoverPaseoSessionProvider.
  const direct = await failoverPaseoSessionProvider({
    config: { paseo: { enabled: true, url: "ws://127.0.0.1:6767/ws" } },
    thread: mapped,
    reason: mapped.error.text,
    goalContext: { goal: "Ship Bob unified chat experience", doneCriteria: "PR green and verified" },
    factory: fakeFactory
  });
  assert.equal(direct.ok, true);
  assert.equal(direct.provider, "claude/claude-opus-4-6");
  assert.equal(direct.newKey, "paseo:srv_bb3.claude-continuation-999");
  assert.equal(createdSpec.cwd, "/home/dev/buildbetter");
  assert.equal(createdSpec.config.modeId, "bypassPermissions");
  assert.match(createdSpec.prompt, /Ship Bob unified chat experience/);

  // Full FleetSupervisor switchPaseoProvider check with ActiveWork ownership transfer.
  await withTempDir(async (dir) => {
    const sup = new FleetSupervisor({
      dataDir: dir,
      config: { enabled: false, mode: "auto", paseo: { enabled: true, only: true } },
      deps: { paseoFactory: fakeFactory },
      skip: { bb3: true, github: true }
    });
    sup.knownThreads.set(mapped.key, mapped);
    const tracked = sup.trackWork({
      project: "BuildBetter",
      theme: "Bob",
      goal: "Ship Bob unified chat experience",
      doneCriteria: "PR open and CI green",
      threadKey: mapped.key
    });
    const switched = await sup.switchPaseoProvider(mapped.key, { reason: mapped.error.text });
    assert.equal(switched.ok, true);
    assert.equal(switched.newKey, "paseo:srv_bb3.claude-continuation-999");
    assert.deepEqual(switched.reassignedGoalIds, [tracked.item.id]);
    const refreshedGoal = sup.activeWork.findActiveGoalForThread("paseo:srv_bb3.claude-continuation-999");
    assert.equal(refreshedGoal?.id, tracked.item.id);
  });
});

test("buildSupervisorDeck and fleetStatus exclude Got-it completion noise from Needs You and preserve full 4-part decision context", () => {
  const prKey = "buildbetter-app/buildbetter#6634";
  const threadKey = "paseo:srv_bb3.redesign_6634";
  const option1 = "1. Keep the workflow in control: skip deleting legacy project views until migration banner ships across all workspaces";
  const option2 = "2. Clean cutover now: remove the legacy project sidebar routes and redirect saved bookmarks directly to the new Projects v2 board";

  const baseState = {
    mode: "auto",
    enabled: true,
    running: false,
    lastTickAt: "2026-11-22T04:00:00.000Z",
    snapshot: {
      at: "2026-11-22T04:00:00.000Z",
      durationMs: 1200,
      counts: { threads: 2, needsYou: 1 },
      threads: [
        { key: threadKey, title: "Finish Redesign Projects UI", state: "waiting-user", pr: { ref: prKey, state: "OPEN", ci: { state: "SUCCESS" } } },
        { key: "paseo:srv_bb3.finished_1", title: "Analytics check", state: "done" }
      ]
    },
    questions: [
      {
        id: "fq_real_6634",
        kind: "agent-card",
        status: "open",
        threadKey,
        prRef: prKey,
        title: "Choose Projects v2 migration cutover behavior",
        body: `How should we handle legacy saved project views in #6634?\nChoices:\n${option1}\n${option2}`,
        options: ["Option 1", "Option 2"],
        createdAt: "2026-11-22T03:50:00.000Z",
        reviewReason: "The full verification run and certificate passed; waiting on owner product call.",
        reviewBrief: {
          whatChanged: "The full verification run and certificate passed with zero regressions."
        }
      },
      {
        id: "fq_done_noise",
        kind: "completed",
        status: "open",
        threadKey: "paseo:srv_bb3.finished_1",
        title: "Analytics check: finished",
        body: "Completed the daily check.",
        options: ["Got it"],
        createdAt: "2026-11-22T03:55:00.000Z"
      }
    ],
    actions: []
  };

  const prsByKey = new Map([
    [
      prKey,
      {
        ref: prKey,
        number: 6634,
        title: "Redesign Projects v2 navigation & saved views",
        state: "OPEN",
        ci: { state: "SUCCESS" },
        body: "## User story\nAs a workspace admin managing dozens of customer projects, I want unified saved views and instant filtering so nothing falls through the cracks.\n\n## Summary\nRebuilds the Projects v2 header, filter bar, and bookmark router."
      }
    ]
  ]);

  const deck = buildSupervisorDeck(baseState, {
    prsByKey,
    threadsByKey: new Map([[threadKey, { key: threadKey, title: "Finish Redesign Projects UI", repo: "buildbetter-app/buildbetter" }]]),
    activeGoalResolver: (tKey) => (tKey === threadKey ? { goal: "Ship Projects v2 UI redesign (#6634)" } : null)
  });

  // Only the real decision card has needsYou !== false; the completed card has needsYou === false.
  const realCard = deck.cards.find((c) => c.questionId === "fq_real_6634");
  const doneCard = deck.cards.find((c) => c.questionId === "fq_done_noise");
  assert.ok(realCard);
  assert.equal(realCard.needsYou, true);
  assert.equal(doneCard?.needsYou, false);

  // 1. User Story preserved in brief.context
  assert.match(realCard.brief.context, /As a workspace admin managing dozens of customer projects/i);
  // 2. What Is Done preserves actual PR summary instead of overwriting with process-only review text
  assert.match(realCard.brief.whatChanged, /Rebuilds the Projects v2 header|Redesign Projects v2/i);
  // 3. Decision Needed preserves BOTH full options without truncating at 260 chars!
  assert.match(realCard.brief.decision, /1\. Keep the workflow in control/);
  assert.match(realCard.brief.decision, /2\. Clean cutover now: remove the legacy project sidebar routes/);

  // fleetStatus filters out NeedsYou === false completion receipts from both questions and cards.
  const status = fleetStatus({
    getState: () => ({ ...baseState, ...deck })
  });
  assert.equal(status.questions.length, 1);
  assert.equal(status.questions[0].id, "fq_real_6634");
  assert.equal(status.cards.length, 1);
  assert.equal(status.cards[0].id, realCard.id);
  assert.equal(status.completedNoticesCount, 1);
});

test("editable skills (read_skill, update_skill, create_skill overwrite) and goal continuation tools work end-to-end", async () => {
  await withTempDir(async (dir) => {
    const skillsDir = path.join(dir, "skills");
    const skillRegistry = new SkillRegistry({ dirs: [skillsDir] });
    const sup = new FleetSupervisor({
      dataDir: dir,
      config: { enabled: false, mode: "auto", paseo: { enabled: false } },
      skip: { bb3: true, github: true }
    });
    const runtime = {
      dataDir: dir,
      skills: skillRegistry,
      fleetSupervisor: sup
    };
    const registry = new ToolRegistry();
    registerCoreTools(registry, runtime);

    const createTool = registry.tools.get("create_skill");
    const readTool = registry.tools.get("read_skill");
    const updateTool = registry.tools.get("update_skill");
    const upsertGoal = registry.tools.get("upsert_goal");
    const verifyGoal = registry.tools.get("verify_goal_progress");

    assert.ok(createTool && readTool && updateTool && upsertGoal && verifyGoal);

    await createTool.handler({
      name: "aiseo-daily",
      description: "Daily AI SEO check-in skill.",
      instructions: "# AI SEO\nStep 1: Check rankings."
    });

    const initialRead = await readTool.handler({ name: "aiseo-daily" });
    assert.match(initialRead.instructions, /Step 1: Check rankings/);
    assert.equal(initialRead.editable, true);

    await updateTool.handler({
      name: "aiseo-daily",
      instructions: `${initialRead.instructions}\n\n## Learned Rule\nAlways check comparison page indexing too.`
    });

    const updatedRead = await readTool.handler({ name: "aiseo-daily" });
    assert.match(updatedRead.instructions, /Step 1: Check rankings/);
    assert.match(updatedRead.instructions, /Always check comparison page indexing too/);

    // create_skill with overwrite: true updates in place without creating -2
    const overwritten = await createTool.handler({
      name: "aiseo-daily",
      description: "Daily AI SEO check-in skill v2.",
      instructions: "# AI SEO v2\nCheck rankings + comparison pages + YouTube cadence.",
      overwrite: true
    });
    assert.equal(overwritten.name, "aiseo-daily");
    assert.equal(overwritten.updated, true);

    // Goal upsert + batch cursor verification
    const createdGoal = await upsertGoal.handler({
      project: "BuildBetter",
      theme: "QA",
      goal: "Verify all 20 staging QA issues",
      doneCriteria: "All 20 QA issues triaged with remaining === 0",
      cursor: {
        total: 20,
        processed: 10,
        remaining: 10
      }
    });
    assert.equal(createdGoal.ok, true);
    assert.equal(createdGoal.activeWorkItem.state, "blocked");
    assert.equal(createdGoal.activeWorkItem.cursor.remaining, 10);

    const midCheck = await verifyGoal.handler({
      id: createdGoal.activeWorkItem.id,
      cursor: { total: 20, processed: 10, remaining: 10 },
      evidenceSummary: "Finished first 10 issues."
    });
    assert.equal(midCheck.accomplished, false);

    const finalCheck = await verifyGoal.handler({
      id: createdGoal.activeWorkItem.id,
      cursor: { total: 20, processed: 20, remaining: 0 },
      ownerConfirmedDone: true,
      evidenceSummary: "All 20 issues triaged and verified."
    });
    assert.equal(finalCheck.accomplished, true);
    assert.equal(finalCheck.item.outcomeVerified, true);
  });
});

test("resolvePaseoAgentConfig & selectBestPaseoModel pick Opus 5.5 (never stale 4.7) and default to bypassPermissions / full-access", async () => {
  const claudeEntry = {
    provider: "claude",
    status: "ready",
    defaultModeId: "auto",
    modes: [
      { id: "plan", label: "Plan Mode" },
      { id: "default", label: "Always Ask" },
      { id: "auto", label: "Auto mode" },
      { id: "bypassPermissions", label: "Bypass" }
    ],
    models: [
      { id: "claude-opus-5-5", label: "Opus 5.5", isDefault: false },
      { id: "claude-opus-5", label: "Opus 5", isDefault: false },
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5", isDefault: false },
      // Simulate older Claude CLI marking 4.7 as isDefault: true
      { id: "claude-opus-4-7[1m]", label: "Opus 4.7 1M", isDefault: true }
    ]
  };
  const codexEntry = {
    provider: "codex",
    status: "ready",
    defaultModeId: "auto-review",
    modes: [
      { id: "auto", label: "Default" },
      { id: "full-access", label: "Full Access" }
    ],
    models: [
      { id: "gpt-6.2-sol", label: "GPT-6.2 Sol", isDefault: false },
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", isDefault: true }
    ]
  };

  const usage = new Map([
    ["claude/claude-opus-5-5", 73],
    ["claude-opus-5-5", 73],
    ["claude/claude-opus-4-7[1m]", 2],
    ["codex/gpt-6.2-sol", 105]
  ]);

  const bestClaude = selectBestPaseoModel(claudeEntry, { usageCounts: usage });
  assert.equal(bestClaude.id, "claude-opus-5-5");
  assert.equal(resolveDefaultPaseoModeId(claudeEntry), "bypassPermissions");
  assert.equal(resolveDefaultPaseoModeId(codexEntry), "full-access");
  assert.equal(resolveDefaultPaseoModeId(claudeEntry, { explicitModeId: "default" }), "default");

  const mockApi = {
    providers: {
      waitForReady: async () => ({ entries: [codexEntry, claudeEntry] })
    },
    agents: {
      list: async () => ({
        entries: Array.from({ length: 10 }, () => ({ agent: { provider: "claude", model: "claude-opus-5-5" } }))
      })
    }
  };

  // Default call with zero args: picks claude/claude-opus-5-5 + bypassPermissions!
  const defaultCfg = await resolvePaseoAgentConfig(mockApi, "/home/dev/buildbetter");
  assert.equal(defaultCfg.provider, "claude/claude-opus-5-5");
  assert.equal(defaultCfg.model, "claude-opus-5-5");
  assert.equal(defaultCfg.modeId, "bypassPermissions");

  // Explicit codex provider: picks gpt-6.2-sol + full-access!
  const codexCfg = await resolvePaseoAgentConfig(mockApi, "/home/dev/buildbetter", { provider: "codex" });
  assert.equal(codexCfg.provider, "codex/gpt-6.2-sol");
  assert.equal(codexCfg.model, "gpt-6.2-sol");
  assert.equal(codexCfg.modeId, "full-access");

  // Fuzzy "opus" query: picks claude-opus-5-5 (never 4.7) + bypassPermissions!
  const fuzzyOpusCfg = await resolvePaseoAgentConfig(mockApi, "/home/dev/buildbetter", { model: "opus" });
  assert.equal(fuzzyOpusCfg.model, "claude-opus-5-5");
  assert.equal(fuzzyOpusCfg.modeId, "bypassPermissions");
});
