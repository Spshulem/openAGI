import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FleetSupervisor } from "../src/fleet/supervisor.js";
import { DEFAULTS, resolveFleetConfig } from "../src/fleet/contracts.js";
import { registerFleetTools } from "../src/fleet/tools.js";
import { createFleetRoute } from "../src/fleet/routes.js";
import { createFleetCapability, RemoteFleetSupervisor } from "../src/fleet/remote.js";
import { isMobileRouteAllowed } from "../src/mobile-node.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { PendingActionStore } from "../src/pending-actions.js";
import { intentCovers, isSupervisorActionableDirective, ownerIntentText, ownerPrincipal } from "../src/owner-authority.js";
import { deliverPaseo, normalizePaseoImages } from "../src/fleet/paseo-delivery.js";
import { paseoThread } from "../src/fleet/sources/paseo.js";
import {
  callDecisionsEndpoint,
  createDecisionsKeepAliveGate,
  validateDecisionsUrl
} from "../src/fleet/decisions-gate.js";
import { deriveProjectInfo } from "../src/fleet/coordinator.js";
import { buildSupervisorDeck, deriveCardProject } from "../src/fleet/cards.js";
import { PASEO_LABEL_COLORS, inferSessionTheme } from "../src/fleet/themes.js";
import { appendSharedThreadMessages, sharedThreadHistory } from "../src/shared-conversations.js";
import { InMemoryAgentStore } from "../src/agent-store.js";
import { G2Channel } from "../src/integrations/g2-channel.js";
import { NodeRegistry } from "../src/node-registry.js";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

const MIN = 60_000;
const NOW = Date.parse("2026-11-17T18:00:00.000Z");
const ago = (ms) => new Date(NOW - ms).toISOString();

test("validateDecisionsUrl enforces HTTPS (or loopback HTTP) and rejects credentials", () => {
  assert.equal(validateDecisionsUrl("https://api.openai.com/v1/decisions"), "https://api.openai.com/v1/decisions");
  assert.equal(validateDecisionsUrl("http://127.0.0.1:8787/v1/decisions"), "http://127.0.0.1:8787/v1/decisions");
  assert.equal(validateDecisionsUrl("http://api.openai.com/v1/decisions"), null);
  assert.equal(validateDecisionsUrl("https://user:pass@api.openai.com/v1/decisions"), null);
});

test("decisions keep-alive gate suppresses completed chats, escalates owner blockers, keeps unfinished chats alive, and caches", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-decisions-gate-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const decisionCalls = [];
  const decisionsFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    decisionCalls.push({ url, body });
    const answers = body.questions.map((q) => {
      const idxMatch = /^c(\d+)_(keep_alive|needs_owner)$/.exec(q.name);
      const idx = Number(idxMatch[1]);
      const candidate = body.input ? JSON.parse(body.input).candidates[idx] : null;
      if (candidate?.title?.includes("Unfinished")) {
        return { type: "predicate", name: q.name, probability: idxMatch[2] === "keep_alive" ? 0.86 : 0.08 };
      }
      if (candidate?.title?.includes("Blocked")) {
        return { type: "predicate", name: q.name, probability: idxMatch[2] === "needs_owner" ? 0.82 : 0.15 };
      }
      return { type: "predicate", name: q.name, probability: 0.09 };
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: "gpt-6-luna-2026",
        answers,
        usage: { input_tokens: 420, output_tokens: 0, total_tokens: 420 }
      })
    };
  };

  const threads = [
    {
      key: "codex:done1",
      kind: "codex",
      id: "done1",
      title: "Completed cleanup",
      cwd: "/work/a",
      repo: "acme/app",
      branch: null,
      workspace: "app",
      agentStatus: "idle",
      lastActivityAt: ago(45 * MIN),
      lastAgentText: "Cleanup complete and verified.",
      lastAgentAt: ago(45 * MIN),
      lastUserText: "Run cleanup",
      lastUserAt: ago(90 * MIN),
      prRefs: [],
      meta: { source: "cli" }
    },
    {
      key: "codex:unfinished1",
      kind: "codex",
      id: "unfinished1",
      title: "Unfinished migration",
      cwd: "/work/b",
      repo: "acme/app",
      branch: null,
      workspace: "app",
      agentStatus: "idle",
      lastActivityAt: ago(40 * MIN),
      lastAgentText: "Step 1 of 2 is written; test suite still needs to run.",
      lastAgentAt: ago(40 * MIN),
      lastUserText: "Complete both migration steps and run tests",
      lastUserAt: ago(90 * MIN),
      prRefs: [],
      meta: { source: "cli" }
    },
    {
      key: "codex:blocked1",
      kind: "codex",
      id: "blocked1",
      title: "Blocked pricing tier",
      cwd: "/work/c",
      repo: "acme/app",
      branch: null,
      workspace: "app",
      agentStatus: "idle",
      lastActivityAt: ago(50 * MIN),
      lastAgentText: "Waiting on product sign-off between $29 and $49 tier.",
      lastAgentAt: ago(50 * MIN),
      lastUserText: "Prepare pricing tier rollout",
      lastUserAt: ago(100 * MIN),
      prRefs: [],
      meta: { source: "cli" }
    }
  ];

  const delivered = [];
  const config = resolveFleetConfig(
    { OPENAGI_FLEET_STORAGE: "0", OPENAI_API_KEY: "sk-test-decisions-key" },
    { home: dataDir, mode: "auto", limits: { ...DEFAULTS }, managerRef: "none", review: { enabled: false } }
  );
  assert.equal(config.decisions.enabled, true);
  assert.equal(config.decisions.model, "gpt-6-luna");

  let clock = NOW;
  const supervisor = new FleetSupervisor({
    dataDir,
    config,
    deps: {
      now: () => clock,
      decisionsFetch,
      executor: {
        deliver: async (args) => {
          delivered.push(args);
          return { status: "sent", route: args.route, detail: "ok" };
        },
        inFlight: () => [],
        whenIdle: async () => {}
      },
      notifier: { notifyQuestion: async () => ({ outreachId: null, pushed: false }) },
      readLivePeers: () => new Map(),
      listCodexThreads: async () => threads,
      listClaudeThreads: async () => [],
      listConductorThreads: async () => [],
      listAntigravityThreads: async () => [],
      readCodexLbErrors: async () => [],
      findLocalHeavyVerification: async () => [],
      readLocalGit: async () => ({ head: "a".repeat(40), branch: "main", upstream: "origin/main", ahead: 0, remote: "acme/app" }),
      findPrForBranch: async () => null,
      fetchPrStates: async () => new Map(),
      fetchPrStateLite: async () => new Map(),
      probeBuildBot3: async () => ({ reachable: true, checkedAt: ago(0), gate: { state: "ok" }, fullQueue: 0, quickQueue: 0, load: [1, 1, 1], runs: [], timersDead: [], error: null }),
      checkLb: async () => ({ healthy: true, detail: "200", watchLine: null })
    }
  });

  await supervisor.tick({ reason: "test" });
  // All 3 candidates batched into a single `/v1/decisions` HTTP call!
  assert.equal(decisionCalls.length, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].thread.key, "codex:unfinished1");
  assert.match(delivered[0].message, /Supervisor keep-alive check/);

  const openQuestions = supervisor.getState().questions;
  const blockedQuestion = openQuestions.find((q) => q.threadKey === "codex:blocked1");
  assert.ok(blockedQuestion, "blocked thread surfaced to owner");
  assert.ok(!blockedQuestion.options.includes("skip"), "agent-ask never offers 'skip' which would send 'Owner answer: skip'");
  assert.ok(!openQuestions.some((q) => q.threadKey === "codex:done1"), "completed thread stayed quiet");

  // Verify observe mode with OPENAI_API_KEY set never records bogus unjudged planned nudges for completed idle chats!
  supervisor.setMode("observe");
  clock += 5 * MIN;
  await supervisor.tick({ reason: "observe-check" });
  const plannedForDone = supervisor.getState().actions.filter(
    (a) => a.threadKey === "codex:done1" && a.status === "planned"
  );
  assert.equal(plannedForDone.length, 0, "observe mode never records unjudged idle-report placeholders");

  supervisor.setMode("auto");
  // Next tick 20 minutes later: unchanged completed thread hits decisions cache -> 0 new HTTP calls for it!
  clock += 20 * MIN;
  // Unfinished thread already received a nudge without reply so policy holds it; blocked thread has open question; done1 is cached!
  const prevCalls = decisionCalls.length;
  await supervisor.tick({ reason: "second-tick" });
  assert.equal(decisionCalls.length, prevCalls);
});

test("decisions gate pre-filters wait candidates before codex nudgeJudge runs", async () => {
  const gate = createDecisionsKeepAliveGate({
    config: { decisions: { enabled: true, apiKey: "sk-unit-key", url: "https://api.openai.com/v1/decisions" } },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: "gpt-6-luna",
        answers: [
          { type: "predicate", name: "c0_keep_alive", probability: 0.11 },
          { type: "predicate", name: "c0_needs_owner", probability: 0.04 }
        ],
        usage: { input_tokens: 95, output_tokens: 0 }
      })
    })
  });
  const verdicts = await gate.evaluateBatch([
    {
      thread: { key: "paseo:local.1", title: "Done task", lastAgentText: "All done." },
      decision: { playbook: "idle-report", message: "Continue" },
      pr: null,
      classified: { state: "idle-no-pr" }
    }
  ]);
  assert.equal(verdicts.get("paseo:local.1")?.action, "wait");
  assert.equal(gate.cacheSize(), 1);

  const errRes = await callDecisionsEndpoint({
    input: "test",
    questions: [{ type: "predicate", name: "q", instructions: "test" }],
    apiKey: "sk-secret-value-123456",
    fetchImpl: async () => {
      throw new Error("boom with sk-secret-value-123456");
    }
  });
  assert.equal(errRes.ok, false);
  assert.ok(!errRes.error.includes("sk-secret-value-123456"), "scrubs API key from error output");
});

test("hierarchy, Paseo label sync, and manager goal dispatch unify multi-host projects, themes, and 0-agent repos", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-themes-manager-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const createdAgents = [];
  const appendedMessages = [];

  const serverAgents = [
    {
      id: "bb-srv-1",
      status: "running",
      updatedAt: "2026-11-17T17:50:00Z",
      cwd: "/home/dev/paseo/worktrees/buildbetter/crm-sync",
      workspaceId: "wks_aaaaaaaaaaaa",
      title: "HubSpot CRM deal pipeline sync",
      provider: "codex"
    }
  ];
  const macAgents = [
    {
      id: "bb-mac-1",
      status: "idle",
      updatedAt: "2026-11-17T17:40:00Z",
      cwd: "/Users/dev/Dev/bbapp",
      workspaceId: "wks_bbbbbbbbbbbb",
      title: "Call recording speaker diarization",
      provider: "claude"
    },
    {
      id: "seo-sleep-1",
      status: "closed",
      updatedAt: "2026-11-16T15:00:00Z",
      cwd: "/Users/dev/Dev/AI-SEO",
      workspaceId: "wks_cccccccccccc",
      title: "Citation audit dashboard",
      provider: "codex"
    }
  ];

  const makeApi = (serverId) => {
    const list = serverId === "srv-box" ? serverAgents : macAgents;
    const projects = serverId === "srv-box"
      ? [
          {
            projectId: "prj_srv_bb",
            projectKey: "remote:github.com/acme/buildbetter",
            projectDisplayName: "buildbetter",
            projectRootPath: "/home/dev/buildbetter",
            projectKind: "git"
          }
        ]
      : [
          {
            projectId: "prj_mac_bb",
            projectKey: "remote:github.com/acme/buildbetter",
            projectDisplayName: "bbapp",
            projectRootPath: "/Users/dev/Dev/bbapp",
            projectKind: "git"
          },
          {
            projectId: "prj_mac_seo",
            projectKey: "remote:github.com/acme/ai-seo",
            projectDisplayName: "AI-SEO",
            projectRootPath: "/Users/dev/Dev/AI-SEO",
            projectKind: "git"
          },
          {
            projectId: "prj_mac_empty",
            projectKey: "remote:github.com/acme/new-service",
            projectDisplayName: "new-service",
            projectRootPath: "/Users/dev/Dev/new-service",
            projectKind: "git"
          }
        ];

    const workspaces = serverId === "srv-box"
      ? [
          {
            id: "wks_aaaaaaaaaaaa",
            projectId: "prj_srv_bb",
            projectDisplayName: "buildbetter",
            projectRootPath: "/home/dev/buildbetter",
            workspaceDirectory: "/home/dev/paseo/worktrees/buildbetter/crm-sync",
            name: "crm-sync",
            projectKind: "git",
            workspaceKind: "worktree",
            labels: ["BuildBetter/Sales & CRM"]
          }
        ]
      : [
          {
            id: "wks_bbbbbbbbbbbb",
            projectId: "prj_mac_bb",
            projectDisplayName: "bbapp",
            projectRootPath: "/Users/dev/Dev/bbapp",
            workspaceDirectory: "/Users/dev/Dev/bbapp",
            name: "bbapp",
            projectKind: "git",
            workspaceKind: "directory",
            labels: []
          },
          {
            id: "wks_cccccccccccc",
            projectId: "prj_mac_seo",
            projectDisplayName: "AI-SEO",
            projectRootPath: "/Users/dev/Dev/AI-SEO",
            workspaceDirectory: "/Users/dev/Dev/AI-SEO",
            name: "AI-SEO",
            projectKind: "git",
            workspaceKind: "directory",
            labels: []
          }
        ];

    return {
      projects: {
        list: async () => ({ projects })
      },
      workspaces: {
        list: async () => ({ entries: workspaces, pageInfo: { hasMore: false, nextCursor: null } })
      },
      agents: {
        list: async () => ({
          entries: list.map((agent) => ({ agent })),
          pageInfo: { hasMore: false, nextCursor: null }
        }),
        ref: (id) => {
          const found = list.find((a) => a.id === id) ?? { id, status: "closed", cwd: "/Users/dev/Dev/AI-SEO" };
          return {
            id,
            current: () => found,
            refresh: async () => ({ agent: found }),
            timeline: {
              refetch: async () => ({
                agent: found,
                entries: id === "seo-sleep-1"
                  ? [
                      {
                        timestamp: "2026-11-16T14:50:00Z",
                        item: { type: "user_message", text: "Build the Steve strictly citation tracker pipeline in AI-SEO" }
                      },
                      {
                        timestamp: "2026-11-16T15:00:00Z",
                        item: { type: "assistant_message", text: "Implemented initial Steve strictly citation parser; ready for phase 2." }
                      }
                    ]
                  : []
              }),
              append: async (item) => {
                appendedMessages.push({ serverId, id, item });
              }
            }
          };
        },
        create: async (opts) => {
          const id = `new-agent-${createdAgents.length + 1}`;
          createdAgents.push({ serverId, id, ...opts });
          return { id };
        }
      },
      dispose: async () => {}
    };
  };

  const paseoFactory = () => ({
    ...makeApi("srv-box"),
    connect: async () => {},
    close: async () => {},
    hosts: {
      list: async () => ({
        self: { serverId: "srv-box", label: "build-server", hostname: "build-server" },
        hosts: [{ serverId: "mac-laptop", label: "dev-macbook", status: "online", enabled: true }]
      }),
      client: async (id) => makeApi(id)
    }
  });

  // Verify `deriveProjectInfo` unifies `bbapp` + `buildbetter` via canonical GitHub repo short name!
  const p1 = deriveProjectInfo({ cwd: "/Users/dev/Dev/bbapp", workspace: "bbapp", repo: "acme/buildbetter" });
  const p2 = deriveProjectInfo({ cwd: "/home/dev/buildbetter", workspace: "buildbetter", repo: "acme/buildbetter" });
  assert.equal(p1.key, "buildbetter");
  assert.equal(p2.key, "buildbetter");

  // Verify `inferSessionTheme` honors Paseo labels and classifies unlabelled sessions.
  assert.equal(
    inferSessionTheme({ paseoLabels: ["BuildBetter/Sales & CRM"], title: "Anything" }, "buildbetter").name,
    "Sales & CRM"
  );
  assert.equal(
    inferSessionTheme({ paseoLabels: [], title: "Call recording speaker diarization" }, "buildbetter").name,
    "Audio, Video & Capture"
  );

  const decisionsFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const parsedInput = JSON.parse(body.input);
    const isStrictlyDirective = /strictly/i.test(parsedInput.owner_directive ?? "");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: "gpt-6-luna",
        answers: body.questions.map((q, idx) => {
          const sess = parsedInput.sessions?.[idx];
          const match = isStrictlyDirective && sess?.key === "paseo:mac-laptop.seo-sleep-1";
          return { type: "predicate", name: q.name, probability: match ? 0.91 : 0.07 };
        }),
        usage: { input_tokens: 310, output_tokens: 0 }
      })
    };
  };

  const sentToExisting = [];
  const config = resolveFleetConfig(
    { OPENAGI_FLEET_STORAGE: "0", OPENAGI_FLEET_PASEO: "1", OPENAI_API_KEY: "sk-test-key" },
    { home: dataDir, mode: "auto", paseo: { enabled: true } }
  );
  const supervisor = new FleetSupervisor({
    dataDir,
    config,
    deps: {
      paseoFactory,
      decisionsFetch,
      executor: {
        deliver: async (args) => {
          sentToExisting.push(args);
          return { status: "sent", route: args.route, detail: "delivered via paseo" };
        },
        inFlight: () => [],
        whenIdle: async () => {}
      }
    }
  });

  // 1. Hierarchy unifies `bbapp` (Mac) + `buildbetter` (Server) into one Project Supervisor with 2 themes, AND discovers 0-agent `new-service`!
  const hierarchy = await supervisor.getHierarchy();
  const bbProject = hierarchy.projects.find((p) => p.id === "buildbetter");
  assert.ok(bbProject, "unified buildbetter project found");
  assert.equal(bbProject.counts.total, 2);
  assert.equal(bbProject.supervisorTitle, "buildbetter Supervisor");
  assert.deepEqual(
    bbProject.themes.map((t) => t.name).sort(),
    ["Audio, Video & Capture", "Sales & CRM"]
  );
  const emptyProject = hierarchy.projects.find((p) => p.id === "new-service");
  assert.ok(emptyProject, "0-agent Paseo project discovered in hierarchy");
  assert.equal(emptyProject.defaultTarget?.cwd, "/Users/dev/Dev/new-service");

  // 2. Sync themes to Paseo labels skips already-labelled `wks_aaaaaaaaaaaa` and labels `wks_bbbbbbbbbbbb` + `wks_cccccccccccc` with valid Paseo colors!
  const syncedLabels = [];
  const syncPreview = await supervisor.syncThemes({ dryRun: true });
  assert.equal(syncPreview.plannedCount, 2);
  const syncApplied = await supervisor.syncThemes({
    setLabelImpl: async (item) => {
      assert.ok(PASEO_LABEL_COLORS.includes(item.color));
      syncedLabels.push(item);
    }
  });
  assert.equal(syncApplied.appliedCount, 2);
  assert.ok(syncedLabels.some((l) => l.workspaceId === "wks_bbbbbbbbbbbb" && l.labelName === "BuildBetter/Audio, Video & Capture"));
  assert.ok(syncedLabels.some((l) => l.workspaceId === "wks_cccccccccccc" && l.labelName === "AI-SEO/Search, SEO & Citations"));

  // 3. Manager Goal Dispatch in AI-SEO: matches sleeping `seo-sleep-1` via Paseo chat transcript + `/v1/decisions` (`p=0.91`)!
  const previewExisting = await supervisor.dispatchGoal({
    project: "AI-SEO",
    goal: "Go work on this Steve strictly citation thing and add phase 2 validation",
    mode: "preview"
  });
  assert.equal(previewExisting.status, "suggest_existing");
  assert.equal(previewExisting.matchedSession.key, "paseo:mac-laptop.seo-sleep-1");
  assert.equal(previewExisting.matchedSession.decisionProbability, 0.91);
  assert.equal(sentToExisting.length, 0, "preview mode never mutates");

  const executedExisting = await supervisor.dispatchGoal({
    project: "AI-SEO",
    goal: "Go work on this Steve strictly citation thing and add phase 2 validation",
    mode: "auto"
  });
  assert.equal(executedExisting.status, "routed_existing");
  assert.equal(sentToExisting.length, 1);
  assert.equal(sentToExisting[0].thread.key, "paseo:mac-laptop.seo-sleep-1");

  // 4. Manager Goal Dispatch when NO existing chat matches (or in a 0-agent project): spawns a fresh Paseo session!
  const startedNew = await supervisor.dispatchGoal({
    project: "new-service",
    goal: "Build Stripe webhook signature verification and unit tests",
    mode: "auto"
  });
  assert.equal(startedNew.status, "started_new");
  assert.equal(createdAgents.length, 1);
  assert.equal(createdAgents[0].serverId, "mac-laptop");
  assert.equal(createdAgents[0].cwd, "/Users/dev/Dev/new-service");

  // 5. Verify HTTP routes, mobile allowlist, RemoteFleetSupervisor proxy, and fleet tools!
  assert.equal(isMobileRouteAllowed("GET", "/fleet/api/hierarchy"), true);
  assert.equal(isMobileRouteAllowed("POST", "/fleet/api/dispatch"), true);
  assert.equal(isMobileRouteAllowed("POST", "/fleet/api/themes/sync"), true);

  const route = createFleetRoute({ supervisor });
  const hRes = await route("GET", "/fleet/api/hierarchy", new URL("http://localhost/fleet/api/hierarchy?project=AI-SEO"), async () => ({}));
  assert.equal(hRes.status, 200);
  assert.equal(hRes.body.projects[0].name, "AI-SEO");

  const capability = createFleetCapability(supervisor);
  const remote = new RemoteFleetSupervisor({
    nodeId: "node-1",
    dataDir,
    runtime: {
      nodeCapabilities: {
        dispatch: async (_nodeId, _cap, op, payload) => capability.invoke(op, payload)
      }
    }
  });
  const remoteHierarchy = await remote.getHierarchy({ project: "buildbetter" });
  assert.equal(remoteHierarchy.projects[0].id, "buildbetter");
  const remoteDispatchPreview = await remote.dispatchGoal({
    project: "AI-SEO",
    goal: "Go work on this Steve strictly citation thing",
    mode: "preview"
  });
  assert.equal(remoteDispatchPreview.status, "suggest_existing");

  // Verify `deriveProjectInfo` handles Conductor v2 worktrees (`/conductor/workspaces/<project>/<city>`)!
  const condV2 = deriveProjectInfo({ cwd: "/Users/dev/conductor/workspaces/AI-SEO/bullard" });
  assert.equal(condV2.name, "AI-SEO");
  assert.equal(condV2.worktree, "bullard");

  // Verify unowned `cwd` is rejected in `dispatchManagerGoal`!
  await assert.rejects(
    () => supervisor.dispatchGoal({ project: "AI-SEO", goal: "Add tests", cwd: "/etc", mode: "force_new" }),
    /does not belong to project/
  );

  // Verify `fleet_dispatch_goal` pins resolved target in `prepareApprovalArgs` & rejects unknown `targetKey`!
  const registry = new ToolRegistry();
  registerFleetTools(registry, supervisor);
  const dispatchTool = registry.get("fleet_dispatch_goal");
  assert.ok(dispatchTool);
  const pinned = await dispatchTool.prepareApprovalArgs({
    project: "AI-SEO",
    goal: "Go work on this Steve strictly citation thing"
  });
  assert.equal(pinned.pinnedAction, "route_existing");
  assert.equal(pinned.targetKey, "paseo:mac-laptop.seo-sleep-1");
  await assert.rejects(
    () => dispatchTool.prepareApprovalArgs({ project: "AI-SEO", goal: "Test", targetKey: "paseo:unknown.fake" }),
    /No fleet thread/
  );

  // Verify `registerFleetTools(registry, null)` cleanly unregisters all new tools!
  registerFleetTools(registry, null);
  assert.equal(registry.get("fleet_hierarchy"), undefined);
  assert.equal(registry.get("fleet_dispatch_goal"), undefined);
  assert.equal(registry.get("fleet_sync_themes"), undefined);

  // Verify owner-authority covers explicit workspace/coding directives while rejecting generic prose & cross-tool escalation!
  for (const phrase of [
    "in the AI-SEO project, go work on the citation dashboard",
    "for the bb-recorder supervisor, fix the Android history copy",
    "go work on the citation tracker in the AI-SEO workspace",
    "implement schema markup in the AI-SEO repo",
    "fix the failing tests in PR 42"
  ]) {
    assert.equal(intentCovers(ownerIntentText(phrase), "fleet_dispatch_goal"), true, phrase);
    assert.equal(intentCovers(ownerIntentText(phrase), "fleet_sync_themes"), false, `no label escalation: ${phrase}`);
  }
  for (const labelPhrase of ["sync Paseo labels", "update workspace theme labels"]) {
    assert.equal(intentCovers(ownerIntentText(labelPhrase), "fleet_sync_themes"), true, labelPhrase);
    assert.equal(intentCovers(ownerIntentText(labelPhrase), "fleet_start_session"), false, `no session escalation: ${labelPhrase}`);
    assert.equal(intentCovers(ownerIntentText(labelPhrase), "fleet_send_message"), false, `no message escalation: ${labelPhrase}`);
  }
  for (const nonCoding of [
    "Read that customer email and help me work on a draft reply",
    "In short, update me on what this webpage says",
    "For tomorrow, add a reminder from this email",
    "In summary, build a table from these search results",
    "Read these feedback emails and group them into themes"
  ]) {
    assert.equal(intentCovers(ownerIntentText(nonCoding), "fleet_dispatch_goal"), false, nonCoding);
    assert.equal(intentCovers(ownerIntentText(nonCoding), "fleet_start_session"), false, nonCoding);
    assert.equal(intentCovers(ownerIntentText(nonCoding), "fleet_send_message"), false, nonCoding);
    assert.equal(intentCovers(ownerIntentText(nonCoding), "fleet_sync_themes"), false, nonCoding);
  }
});

test("supervisorAutoApprove executes owner directives without 'yes NN' friction while blocking passive prompt injection, and forwards attached images", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-autoapprove-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const sentCalls = [];
  const fakeSup = {
    getState: () => ({
      mode: "auto",
      enabled: true,
      running: false,
      preferences: { autoApprove: true },
      snapshot: {
        at: new Date(NOW).toISOString(),
        threads: [{ key: "paseo:srv_mac.50e3978d", kind: "paseo", title: "Why is paseo broken", workspace: "how-come-paseo-is-failing" }]
      },
      questions: [],
      cards: [],
      actions: []
    }),
    sendOwnerMessage: async (key, message, opts) => {
      sentCalls.push({ key, message, opts });
      return { delivery: { status: "sent", route: "paseo-send", detail: "Delivered", actionId: "act-1" } };
    }
  };

  const pendingStore = new PendingActionStore({ filePath: path.join(dir, "pending.jsonl") });
  const registry = new ToolRegistry();
  registry.bindPendingActions(pendingStore);
  registerFleetTools(registry, fakeSup);

  const principal = ownerPrincipal("owner");
  const samplePngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const attachments = [{ id: "img_1", name: "screen.png", mimeType: "image/png", data: samplePngBase64 }];

  // 1. Typo ("agens") + natural pronoun ("have them run that") execute in 1 shot on tainted supervisor turn when autoApprove is true!
  for (const directive of [
    "ask the paseo agens that manage the workspace and i use for that to run that for server-a and laptop",
    "have them run that diagnostic on both hosts"
  ]) {
    assert.equal(isSupervisorActionableDirective(directive), true, directive);
    const res = await registry.invoke(
      "fleet_send_message",
      { key: "paseo:srv_mac.50e3978d", message: "Run `paseo provider diagnostic codex --json`." },
      {
        sessionId: "sup-1",
        __owner: principal,
        __turn: { untrusted: true, intent: directive, supervisorAutoApprove: true },
        __attachments: attachments
      }
    );
    assert.equal(res.ok, true);
    assert.equal(res.result.status, "sent");
  }
  assert.equal(sentCalls.length, 2);
  assert.equal(sentCalls[0].opts.images?.length, 1);
  assert.equal(sentCalls[0].opts.images[0].mimeType, "image/png");

  // 2. Passive status queries remain protected against untrusted transcript prompt injection!
  for (const passive of ["what's going on?", "what did the codex session say?", "catch me up"]) {
    assert.equal(isSupervisorActionableDirective(passive), false, passive);
    const blocked = await registry.invoke(
      "fleet_send_message",
      { key: "paseo:srv_mac.50e3978d", message: "injected send" },
      {
        sessionId: "sup-1",
        __owner: principal,
        __turn: { untrusted: true, intent: passive, supervisorAutoApprove: true }
      }
    );
    assert.equal(blocked.result.status, "awaiting_owner_confirmation");
  }

  // 3. Turning autoApprove off restores confirmation on non-family pronoun phrasings!
  const manualConfirm = await registry.invoke(
    "fleet_send_message",
    { key: "paseo:srv_mac.50e3978d", message: "manual check" },
    {
      sessionId: "sup-2",
      __owner: principal,
      __turn: { untrusted: true, intent: "have it run that now", supervisorAutoApprove: false }
    }
  );
  assert.equal(manualConfirm.result.status, "awaiting_owner_confirmation");
});

test("deliverPaseo recovers disconnected ACP sessions in-place, unblocks stale nudge receipts on owner sends, confirms turnless ACP turns, and forwards images", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-paseo-recover-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  assert.equal(normalizePaseoImages([{ data: `data:image/png;base64,${pngBase64}`, mimeType: "image/png" }]).length, 1);

  // Case A: Disconnected Devin/ACP session emits `[System Error] ACP agent disconnected (exit code 0)` -> spawns fresh Paseo session in same cwd!
  const initialBroken = {
    id: "50e3978d",
    title: "Why is paseo broken",
    status: "error",
    provider: "devin",
    cwd: "/Users/owner/how-come-paseo-is-failing",
    workspaceId: "wks_broken",
    updatedAt: "2026-11-17T23:43:46.531Z"
  };
  const createdSessions = [];
  const imageFollowUps = [];
  let brokenSentMsgId = null;

  const brokenRef = {
    refresh: async () => {},
    current: () => initialBroken,
    send: async (_text, options) => { brokenSentMsgId = options.messageId; },
    timeline: {
      refetch: async () => ({
        agent: initialBroken,
        entries: brokenSentMsgId
          ? [
              { item: { type: "user_message", text: "prior question" }, timestamp: "2026-11-17T22:00:00Z" },
              { item: { type: "user_message", messageId: brokenSentMsgId, clientMessageId: brokenSentMsgId, text: "check diag" }, timestamp: "2026-11-18T00:02:00Z" },
              { item: { type: "assistant_message", text: "[System Error] ACP agent disconnected (exit code 0)" }, timestamp: "2026-11-18T00:02:00Z" }
            ]
          : [{ item: { type: "user_message", text: "prior question" }, timestamp: "2026-11-17T22:00:00Z" }]
      })
    }
  };
  const recoveredRef = {
    send: async (text, options) => { imageFollowUps.push({ text, options }); }
  };
  const factoryA = () => ({
    connect: async () => {},
    close: async () => {},
    hosts: { list: async () => ({ self: { serverId: "srv_mac" }, hosts: [] }) },
    providers: {
      waitForReady: async () => ({
        entries: [{ provider: "codex", status: "ready", models: [{ id: "gpt-5.4", isDefault: true }] }]
      })
    },
    agents: {
      ref: (id) => (id === "new-agent-99" ? recoveredRef : brokenRef),
      create: async (opts) => {
        createdSessions.push(opts);
        return { id: "new-agent-99" };
      }
    }
  });

  const recRes = await deliverPaseo({
    config: { paseo: { enabled: true } },
    thread: paseoThread(initialBroken, "srv_mac"),
    text: "[OpenAGI supervisor] Owner says: Run `paseo provider diagnostic codex --json`.",
    store: { dir },
    actionId: "act-rec",
    base: { messageHash: "owner-h1", playbook: "owner-message" },
    images: [{ data: pngBase64, mimeType: "image/png" }],
    factory: factoryA
  });
  assert.equal(recRes.status, "sent");
  assert.equal(recRes.recoveredSession?.key, "paseo:srv_mac.new-agent-99");
  assert.equal(createdSessions.length, 1);
  assert.equal(createdSessions[0].cwd, "/Users/owner/how-come-paseo-is-failing");
  assert.match(createdSessions[0].prompt, /Why is paseo broken/);
  assert.equal(imageFollowUps.length, 1);
  assert.equal(imageFollowUps[0].options.images.length, 1);

  // Case B: Turnless ACP/Claude provider confirms owner message + clears stale unconfirmed background receipt!
  const turnlessAgent = {
    id: "claude-turnless",
    title: "Claude chat",
    status: "idle",
    provider: "claude",
    cwd: "/workspace/app",
    workspaceId: "wks_claude",
    updatedAt: "2026-11-18T00:00:00Z"
  };
  let lastOwnerMsgId = null;
  let ownerSentCount = 0;
  const turnlessRef = {
    refresh: async () => {},
    current: () => (lastOwnerMsgId ? { ...turnlessAgent, status: "running" } : turnlessAgent),
    send: async (_text, options) => { ownerSentCount += 1; lastOwnerMsgId = options.messageId; },
    timeline: {
      refetch: async () => ({
        agent: lastOwnerMsgId ? { ...turnlessAgent, status: "running" } : turnlessAgent,
        entries: lastOwnerMsgId
          ? [{ item: { type: "user_message", clientMessageId: lastOwnerMsgId, text: "hi" }, timestamp: "2026-11-18T00:01:00Z" }]
          : []
      })
    }
  };
  // Pre-seed a stale pending receipt from an older background nudge
  const deliveriesDir = path.join(dir, "paseo-deliveries");
  fs.mkdirSync(deliveriesDir, { recursive: true });
  const cryptoMod = await import("node:crypto");
  const tThread = paseoThread(turnlessAgent, "srv_local");
  const digest = cryptoMod.createHash("sha256").update(tThread.key).digest("hex");
  fs.writeFileSync(path.join(deliveriesDir, `${digest}.json`), JSON.stringify({
    messageId: "stale-bg-nudge",
    clientMessageId: "stale-bg-nudge",
    messageHash: "old-nudge",
    activityAt: "2026-11-15T00:00:00Z",
    pending: true
  }));

  const turnlessRes = await deliverPaseo({
    config: { paseo: { enabled: true } },
    thread: tThread,
    text: "[OpenAGI supervisor] Owner says: Proceed.",
    store: { dir },
    actionId: "act-turnless",
    base: { messageHash: "owner-h2", playbook: "owner-message" },
    factory: () => ({
      connect: async () => {},
      close: async () => {},
      hosts: { list: async () => ({ self: { serverId: "srv_local" }, hosts: [] }) },
      agents: { ref: () => turnlessRef }
    })
  });
  assert.equal(turnlessRes.status, "sent");
  assert.equal(ownerSentCount, 1);
});

test("reconcileOpenQuestions closes stale cards deterministically and via /v1/decisions without full fleet scans", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-reconcile-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  let decisionsCalls = 0;
  const fakeDecisionsFetch = async (_url, init) => {
    decisionsCalls += 1;
    const body = JSON.parse(init.body);
    const parsedInput = JSON.parse(body.input);
    const answers = parsedInput.watched_questions.map((wq, idx) => ({
      name: `q${idx}_still_relevant`,
      probability: wq.question_title.includes("milan") ? 0.12 : 0.88
    }));
    return {
      ok: true,
      status: 200,
      json: async () => ({ answers, usage: { input_tokens: 180, output_tokens: 0 } })
    };
  };

  const fakePaseoFactory = () => ({
    connect: async () => {},
    close: async () => {},
    hosts: { list: async () => ({ self: { serverId: "srv_bb3" }, hosts: [] }) },
    agents: {
      ref: (id) => ({
        current: () => null,
        timeline: {
          refetch: async () => {
            if (id === "ag_running") {
              return {
                agent: { id, title: "Active follow-up", status: "running", updatedAt: "2026-11-18T00:05:00Z" },
                entries: [
                  { item: { type: "assistant_message", text: "Should we use approach A or B?" }, timestamp: "2026-11-18T00:00:00Z" },
                  { item: { type: "user_message", text: "Use approach A and ship it" }, timestamp: "2026-11-18T00:04:00Z" }
                ]
              };
            }
            if (id === "ag_milan") {
              return {
                agent: { id, title: "milan workspace", status: "idle", updatedAt: "2026-11-18T00:06:00Z" },
                entries: [
                  { item: { type: "user_message", text: "Already handled the docs cleanup, skip the old changes" }, timestamp: "2026-11-18T00:05:30Z" },
                  { item: { type: "assistant_message", text: "Got it, docs cleanup is complete and verified." }, timestamp: "2026-11-18T00:06:00Z" }
                ]
              };
            }
            return {
              agent: { id, title: "Still waiting", status: "idle", updatedAt: "2026-11-18T00:05:00Z" },
              entries: [
                { item: { type: "assistant_message", text: "Still waiting on production hotfix approval for #9958." }, timestamp: "2026-11-18T00:05:00Z" }
              ]
            };
          }
        }
      })
    }
  });

  const sup = new FleetSupervisor({
    dataDir: tmpDir,
    config: {
      enabled: true,
      mode: "auto",
      paseo: { enabled: true, url: "ws://127.0.0.1:6767/ws" },
      decisions: { enabled: true, apiKey: "sk-test-reconcile" }
    },
    deps: {
      now: () => Date.parse("2026-11-18T00:10:00Z"),
      paseoFactory: fakePaseoFactory,
      decisionsFetch: fakeDecisionsFetch
    }
  });

  const qRunning = sup.store.upsertQuestion({
    dedupeKey: "ask:running-1",
    kind: "agent-ask",
    threadKey: "paseo:srv_bb3.ag_running",
    agentAskedAt: "2026-11-18T00:00:00Z",
    title: "Pick approach A or B?",
    options: ["A", "B"]
  });
  const qMilan = sup.store.upsertQuestion({
    dedupeKey: "ask:milan-1",
    kind: "agent-ask",
    mergeAsk: true,
    threadKey: "paseo:srv_bb3.ag_milan",
    agentAskedAt: "2026-11-18T00:00:00Z",
    title: "milan workspace: decide docs and merge cleanup?",
    options: ["approve", "skip"]
  });
  const qLive = sup.store.upsertQuestion({
    dedupeKey: "ask:live-1",
    kind: "agent-ask",
    mergeAsk: true,
    threadKey: "paseo:srv_bb3.ag_live",
    agentAskedAt: "2026-11-18T00:00:00Z",
    title: "Ship production hotfix #9958?",
    options: ["ship", "wait"]
  });

  const route = createFleetRoute({ supervisor: sup });
  assert.equal(isMobileRouteAllowed("POST", "/fleet/api/reconcile"), true);
  const res = await route("POST", "/fleet/api/reconcile", new URL("http://localhost/fleet/api/reconcile"), async () => ({ force: true }));
  assert.equal(res.status, 200);
  assert.equal(decisionsCalls, 1);

  // qRunning closed deterministically (owner replied directly + agent running), qMilan closed by /v1/decisions (p=0.12), qLive kept (p=0.88)!
  assert.equal(sup.store.question(qRunning.id).status, "resolved");
  assert.equal(sup.store.question(qMilan.id).status, "resolved");
  assert.equal(sup.store.question(qLive.id).status, "open");

  // Second call with unchanged thread state hits questionRelevanceCache -> 0 additional /v1/decisions calls!
  await sup.reconcileOpenQuestions({ force: true });
  assert.equal(decisionsCalls, 1);
});

test("unified supervisor sync: POST /conversations/supervisor/append deduplicates and allows mobile proxy", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "unified-sync-append-"));
  const runtime = createDurableRuntime({ dataDir });
  const store = new InMemoryAgentStore();
  runtime.agentHost = { store, handleMessage: async () => ({ reply: "ok", session: { id: "devices:supervisor:main" } }) };
  const app = createHostedInterface(runtime, { dataDir, port: 0, authToken: "" });
  t.after(async () => { await app.close(); await runtime.observations?.close?.(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const { url } = await app.listen();

  assert.equal(isMobileRouteAllowed("POST", "/conversations/supervisor/append"), true);
  assert.equal(isMobileRouteAllowed("POST", "/pending-actions/dismiss-all"), true);
  assert.equal(isMobileRouteAllowed("POST", "/conversations/agent/messages"), false);

  const first = await fetch(`${url}/conversations/supervisor/append`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceName: "Paseo",
      messages: [
        { id: "paseo_u1", role: "user", text: "What needs attention?" },
        { id: "paseo_a1", role: "assistant", text: "PR #9958 is green." }
      ]
    })
  });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.appended.length, 2);

  // Repeating same IDs is idempotent and does not duplicate messages
  const replay = await fetch(`${url}/conversations/supervisor/append`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sourceName: "Paseo",
      messages: [
        { id: "paseo_u1", role: "user", text: "What needs attention?" },
        { id: "paseo_a1", role: "assistant", text: "PR #9958 is green." }
      ]
    })
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).appended.length, 0);
  const hist = sharedThreadHistory(store, "supervisor");
  assert.deepEqual(hist.messages.map((m) => m.id), ["paseo_u1", "paseo_a1"]);
});

test("pending-actions: default 2h chat TTL, overlay surface filter, and dismiss-all cleanup", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "unified-pending-cleanup-"));
  let fakeNow = Date.parse("2026-11-18T00:00:00.000Z");
  const pendingActions = new PendingActionStore({ dir: path.join(dataDir, "pending-actions"), now: () => fakeNow });
  const oldChat = pendingActions.enqueue({
    toolName: "fleet_send",
    args: { text: "old" },
    context: { sessionId: "devices:agent:main" },
    summary: "Old chat confirm",
    mode: "chat",
    announce: false
  });
  assert.equal(oldChat.expiresAt, "2026-11-18T02:00:00.000Z");

  // Manually backdate raisedAt/createdAt on oldChat to simulate legacy >2h pre-fix record without expiration
  oldChat.createdAt = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  oldChat.raisedAt = oldChat.createdAt;
  oldChat.expiresAt = null;
  const recentQueue = pendingActions.enqueue({
    toolName: "computer_click",
    args: {},
    context: { sessionId: "devices:agent:main" },
    summary: "Real computer click",
    mode: "queue",
    announce: false
  });

  const runtime = createDurableRuntime({ dataDir });
  runtime.pendingActions = pendingActions;
  const app = createHostedInterface(runtime, { dataDir, port: 0, authToken: "" });
  t.after(async () => { await app.close(); await runtime.observations?.close?.(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const { url } = await app.listen();

  const overlayList = await (await fetch(`${url}/pending-actions?status=pending&surface=overlay`)).json();
  assert.deepEqual(overlayList.actions.map((a) => a.id), [recentQueue.id]);

  const dismissRes = await fetch(`${url}/pending-actions/dismiss-all`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "chat", olderThanMs: 2 * 60 * 60 * 1000 })
  });
  assert.equal(dismissRes.status, 200);
  const dismissBody = await dismissRes.json();
  assert.equal(dismissBody.dismissedCount, 1);
  assert.equal(pendingActions.get(oldChat.id).status, "denied");
  assert.equal(pendingActions.get(recentQueue.id).status, "pending");
});

test("calm overlap detection warns only when >=2 running sessions share a cwd on one host and never warns on multi_host", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "unified-calm-overlaps-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const macAgents = [
    { id: "a1", title: "Idle 1", cwd: "/Users/dev/Dev/app", status: "idle", updatedAt: "2026-11-18T00:00:00Z" },
    { id: "a2", title: "Idle 2", cwd: "/Users/dev/Dev/app", status: "idle", updatedAt: "2026-11-18T00:01:00Z" },
    { id: "a3", title: "Run 1", cwd: "/Users/dev/Dev/api", status: "running", updatedAt: "2026-11-18T00:02:00Z" },
    { id: "a4", title: "Run 2", cwd: "/Users/dev/Dev/api", status: "running", updatedAt: "2026-11-18T00:03:00Z" }
  ];
  const bb3Agents = [
    { id: "b1", title: "Remote running", cwd: "/home/dev/Dev/app", status: "running", updatedAt: "2026-11-18T00:03:00Z" }
  ];
  const makeApi = (serverId) => {
    const list = serverId === "srv_mac" ? macAgents : bb3Agents;
    return {
      projects: { list: async () => ({ projects: [] }) },
      workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }) },
      agents: {
        list: async () => ({
          entries: list.map((agent) => ({ agent })),
          pageInfo: { hasMore: false, nextCursor: null }
        }),
        ref: (id) => {
          const found = list.find((a) => a.id === id) ?? { id, status: "closed", cwd: "/Users/dev/Dev/app" };
          return {
            id,
            current: () => found,
            refresh: async () => ({ agent: found }),
            timeline: { refetch: async () => ({ agent: found, entries: [] }), append: async () => {} }
          };
        }
      },
      dispose: async () => {}
    };
  };
  const paseoFactory = () => ({
    ...makeApi("srv_mac"),
    connect: async () => {},
    close: async () => {},
    hosts: {
      list: async () => ({
        self: { serverId: "srv_mac", label: "MacBook", hostname: "macbook" },
        hosts: [{ serverId: "srv_bb3", label: "BuildBot3", status: "online", enabled: true }]
      }),
      client: async (id) => makeApi(id)
    }
  });
  const sup = new FleetSupervisor({
    dataDir,
    config: resolveFleetConfig({ OPENAGI_FLEET_PASEO: "1" }, { enabled: true, mode: "propose", paseo: { enabled: true }, review: { enabled: false }, storage: { enabled: false } }),
    deps: { paseoFactory }
  });
  const res = await sup.listWorkspaces();
  const appWs = res.workspaces.find((w) => w.id === "app");
  const apiWs = res.workspaces.find((w) => w.id === "api");
  assert.ok(appWs && apiWs, "expected app and api workspaces");
  assert.equal(appWs.overlaps.length, 0, "no warning for idle sessions or multi_host");
  assert.equal(apiWs.overlaps.length, 1);
  assert.equal(apiWs.overlaps[0].kind, "concurrent_cwd");
  assert.match(apiWs.overlaps[0].detail, /2 running chats are editing api simultaneously/);
});

test("SupervisorCard.project is populated and G2 even-ai-native receives recent supervisor context", async (t) => {
  const deck = buildSupervisorDeck({
    snapshot: {
      threads: [{ key: "paseo:bb.1", title: "Fix export", repo: "buildbetter-app/buildbetter", state: "needs-human" }]
    },
    questions: [{ id: "q_proj", status: "open", title: "Merge #9958?", body: "CI green", options: ["yes", "no"], threadKey: "paseo:bb.1" }]
  });
  assert.equal(deck.cards[0].project, "buildbetter");
  assert.equal(deriveCardProject({ workspace: "/Users/dev/openAGI" }), "openAGI");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unified-g2-sup-ctx-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new InMemoryAgentStore();
  appendSharedThreadMessages(store, "supervisor", {
    messages: [{ role: "user", text: "Deploy bb-recorder v2.14" }, { role: "assistant", text: "Notarized and ready." }]
  });
  const nodeRegistry = new NodeRegistry({ dir: path.join(dir, "nodes") });
  nodeRegistry.enroll("g2-node-1", "g".repeat(43), { platform: "even_g2", name: "Glasses" });
  const captured = [];
  const channel = new G2Channel({
    dir: path.join(dir, "g2"),
    nodeRegistry,
    agentHost: {
      store,
      handleMessage: async (input, options) => {
        captured.push({ input, options });
        return { reply: "Yes, v2.14 is ready.", session: { id: input.sessionId } };
      }
    }
  });
  await channel.ask({ text: "Status of recorder?", conversationId: "even-ai-native" }, "g2-node-1");
  assert.equal(captured.length, 1);
  assert.match(captured[0].options.extraTurnContext ?? "", /Deploy bb-recorder v2\.14/);
});

test("fleet image endpoints accept >32KB image payloads and paired Mac proxy records sourceName Mac", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "unified-fleet-img-"));
  const runtime = createDurableRuntime({ dataDir });
  const store = new InMemoryAgentStore();
  runtime.agentHost = {
    store,
    handleMessage: async (input) => {
      store.appendMessage(input.sessionId, {
        role: "user",
        content: input.text,
        metadata: input.metadata
      });
      return { reply: "ok", session: { id: input.sessionId } };
    }
  };
  const calls = [];
  runtime.fleetSupervisor = {
    start: () => {},
    stop: () => {},
    getState: () => ({ mode: "propose", enabled: true, questions: [], cards: [], snapshot: { threads: [] } }),
    sendOwnerMessage: async (threadKey, message, opts = {}) => {
      calls.push({ kind: "send", threadKey, message, imageCount: opts.images?.length ?? 0 });
      return { delivery: { status: "sent", attachedImages: opts.images?.length ?? 0 } };
    },
    actCard: async (cardId, opts = {}) => {
      calls.push({ kind: "act", cardId, op: opts.op, value: opts.value, imageCount: opts.images?.length ?? 0 });
      return { ok: true, kind: "reply", status: "sent" };
    }
  };
  const nodeRegistry = new NodeRegistry({ dir: path.join(dataDir, "nodes") });
  nodeRegistry.enroll("mac-worker-1", "w".repeat(43), { ownerProxyToken: "p".repeat(43) });
  const app = createHostedInterface(runtime, { dataDir, port: 0, authToken: "", nodeRegistry });
  t.after(async () => { await app.close(); await runtime.observations?.close?.(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const { url } = await app.listen();

  // >32KB base64 image must pass both /fleet/api/send and /fleet/api/cards/:id/act (previously failed 8KB cap)
  const bigBase64 = Buffer.alloc(24 * 1024, 0xaa).toString("base64");
  const bigImg = { id: "img_big", name: "CleanShot.png", mimeType: "image/jpeg", data: bigBase64 };
  const sendRes = await fetch(`${url}/fleet/api/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadKey: "paseo:srv_1.ag_1", images: [bigImg] })
  });
  assert.equal(sendRes.status, 200);
  const sendBody = await sendRes.json();
  assert.equal(sendBody.delivery.status, "sent");
  assert.equal(calls[0].kind, "send");
  assert.equal(calls[0].message, "Please inspect the attached image(s).");
  assert.equal(calls[0].imageCount, 1);

  const actRes = await fetch(`${url}/fleet/api/cards/q_1/act`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ op: "reply", value: "See screenshot", images: [bigImg] })
  });
  assert.equal(actRes.status, 200);
  assert.equal(calls[1].kind, "act");
  assert.equal(calls[1].imageCount, 1);

  // Paired Mac owner-proxy POST /message defaults sourceName to "Mac" instead of "Phone"
  const proxyMsg = await fetch(`${url}/message`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${"p".repeat(43)}`,
      "x-openagi-node-id": "mac-worker-1"
    },
    body: JSON.stringify({ text: "hello from mac", thread: "supervisor", from: "mac-supervisor" })
  });
  assert.equal(proxyMsg.status, 200);
  const hist = sharedThreadHistory(store, "supervisor");
  assert.equal(hist.messages.at(-1).sourceName, "Mac");
});

test("OpenAGI-native project/theme organization works without Paseo, preserves paseoCwd project names, and exposes routes", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-native-org-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const config = resolveFleetConfig({}, { dataDir: dir, paseo: { enabled: false } });
  const fakeTaskStore = {
    list: () => [{
      id: "task-mkt-1",
      title: "Draft launch post",
      status: "pending",
      sourceMeta: { project: "Marketing", subchannel: "Marketing/Launch" }
    }]
  };
  const sup = new FleetSupervisor({ config, dataDir: dir, runtime: { tasks: fakeTaskStore } });

  // Seed a Paseo thread (whose cwd is null and real path is in meta.paseoCwd)
  // plus a standalone Codex thread with no Paseo setup at all.
  const bilbaoThread = {
    key: "paseo:srv_1.ag_bilbao",
    kind: "paseo",
    title: "Audio capture refactor",
    cwd: null,
    workspace: "bilbao",
    repo: null,
    agentStatus: "running",
    meta: { paseoCwd: "/home/dev/paseo/worktrees/bb-recorder/bilbao", provider: "codex" }
  };
  const codexThread = {
    key: "codex:local-1",
    kind: "codex",
    title: "Improve homepage SEO citations",
    cwd: "/Users/me/Dev/website-app",
    workspace: "website-app",
    repo: null,
    agentStatus: "idle",
    meta: { provider: "codex" }
  };
  sup.lastThreads.set(bilbaoThread.key, bilbaoThread);
  sup.lastThreads.set(codexThread.key, codexThread);
  sup.store.recordSnapshot({
    at: "2026-11-20T01:00:00Z",
    threads: [
      { key: bilbaoThread.key, title: bilbaoThread.title, workspace: "bilbao", state: "running" },
      { key: codexThread.key, title: codexThread.title, workspace: "website-app", cwd: codexThread.cwd, state: "idle" }
    ]
  });

  // 1. liveSnapshot must include derived `project` on every thread row AND map
  //    worktree `bilbao` under `bb-recorder` (with subchannel `bb-recorder/bilbao`)!
  const snapState = sup.getState();
  const bilbaoRow = snapState.snapshot.threads.find((r) => r.key === bilbaoThread.key);
  assert.equal(bilbaoRow.project, "bb-recorder");
  assert.equal(bilbaoRow.subchannel, "bb-recorder/bilbao");

  // 2. Routes + mobile allowlist for OpenAGI-side project/theme management
  const route = createFleetRoute({ supervisor: sup });
  assert.equal(isMobileRouteAllowed("GET", "/fleet/api/projects"), true);
  assert.equal(isMobileRouteAllowed("POST", "/fleet/api/projects"), true);
  assert.equal(isMobileRouteAllowed("DELETE", "/fleet/api/projects/marketing"), true);
  assert.equal(isMobileRouteAllowed("POST", "/fleet/api/threads/codex:local-1/organize"), true);

  const createRes = await route("POST", "/fleet/api/projects", new URL("http://localhost/fleet/api/projects"), async () => ({
    name: "Growth",
    theme: "SEO"
  }));
  assert.equal(createRes.status, 200);
  assert.equal(createRes.body.project.id, "growth");
  assert.equal(createRes.body.project.themes[0].name, "SEO");

  // 3. Reassign a standalone Codex thread into OpenAGI Project/Theme ("Growth" / "SEO")
  const assignRes = await route(
    "POST",
    "/fleet/api/threads/codex:local-1/organize",
    new URL("http://localhost/fleet/api/threads/codex:local-1/organize"),
    async () => ({ project: "Growth", theme: "SEO" })
  );
  assert.equal(assignRes.status, 200);

  // liveSnapshot now reflects the OpenAGI-side override!
  const updatedState = sup.getState();
  const updatedCodex = updatedState.snapshot.threads.find((r) => r.key === codexThread.key);
  assert.equal(updatedCodex.project, "Growth");
  assert.equal(updatedCodex.subchannel, "growth/seo");

  // 4. buildFleetHierarchy works cleanly with paseo.enabled=false and includes:
  //    - bb-recorder (from paseoCwd)
  //    - Growth / SEO (OpenAGI custom project + reassigned Codex thread)
  //    - Marketing / Launch (from OpenAGI task metadata)
  const hierarchy = await sup.getHierarchy({ limit: 40 });
  const names = hierarchy.projects.map((p) => p.name);
  assert.ok(names.includes("bb-recorder"), `expected bb-recorder in ${names}`);
  assert.ok(names.includes("Growth"), `expected Growth in ${names}`);
  assert.ok(names.includes("Marketing"), `expected Marketing in ${names}`);
  const growthProj = hierarchy.projects.find((p) => p.name === "Growth");
  const seoTheme = growthProj.themes.find((th) => th.name === "SEO");
  assert.ok(seoTheme, "Growth project should include OpenAGI SEO theme");
  assert.equal(seoTheme.source, "openagi");
  assert.ok(seoTheme.sessions.some((s) => s.key === codexThread.key));

  // Delete custom project works cleanly
  const delRes = await route("DELETE", "/fleet/api/projects/growth", new URL("http://localhost/fleet/api/projects/growth"), async () => ({}));
  assert.equal(delRes.status, 200);
  assert.equal(delRes.body.deleted, true);
});

test("completion & Proceed plan cards, oai-mem-citation cleanup, and junk-folder project aliasing", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-completion-ux-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  let archivedIds = [];
  const fakePaseoFactory = () => ({
    connect: async () => {},
    close: async () => {},
    hosts: { list: async () => ({ self: { serverId: "srv_bb3" }, hosts: [] }) },
    agents: {
      list: async () => ({
        entries: [
          {
            agent: {
              id: "plan-agent-1",
              title: "Supervisor roadmap & audit",
              provider: "antigravity",
              status: "idle",
              cwd: "/home/dev/paseo/worktrees/openAGI/amman",
              workspaceId: "wks_f7143ae5747f958b",
              requiresAttention: false,
              lastUserMessageAt: "2026-11-20T03:56:00Z",
              updatedAt: "2026-11-20T04:03:20Z"
            }
          },
          {
            agent: {
              id: "done-agent-2",
              title: "SEO skills audit",
              provider: "codex",
              status: "idle",
              cwd: "/Volumes/Xtra/codex-worktrees/6baf",
              workspaceId: "wks_6ff24b2c6fd8058f",
              labels: { "migration.originalCwd": "/Users/owner/Dev/webapp-client", theme: "seo" },
              requiresAttention: true,
              attentionReason: "finished",
              lastUserMessageAt: "2026-11-20T03:49:00Z",
              updatedAt: "2026-11-20T03:52:26Z"
            }
          },
          {
            agent: {
              id: "err-agent-3",
              title: "YouTube content strategy",
              provider: "claude",
              status: "idle",
              cwd: "/home/dev/.paseo/imported-history",
              workspaceId: "wks_b382aa8ff3a3a9bf",
              labels: { theme: "marketing" },
              requiresAttention: true,
              attentionReason: "error",
              lastUserMessageAt: "2026-11-20T02:00:00Z",
              updatedAt: "2026-11-20T02:05:00Z"
            }
          }
        ],
        pageInfo: { hasMore: false, nextCursor: null }
      }),
      ref: (id) => ({
        archive: async () => { archivedIds.push(id); },
        timeline: {
          refetch: async () => {
            if (id === "plan-agent-1") {
              const longAudit = Array.from({ length: 12 }, (_, i) => `Section ${i + 1}: Verified subsystem health and metrics across nodes.`).join("\n\n");
              return {
                agent: {
                  id,
                  title: "Supervisor roadmap & audit",
                  provider: "antigravity",
                  status: "idle",
                  cwd: "/home/dev/paseo/worktrees/openAGI/amman",
                  workspaceId: "wks_f7143ae5747f958b",
                  updatedAt: "2026-11-20T04:03:20Z"
                },
                entries: [
                  { timestamp: "2026-11-20T03:56:00Z", item: { type: "user_message", text: "What's left to build?" } },
                  { timestamp: "2026-11-20T04:02:59Z", item: { type: "tool_call", name: "write_file", detail: { input: { Path: "/home/dev/.gemini/antigravity-cli/brain/abc-123/roadmap_plan.md" } } } },
                  { timestamp: "2026-11-20T04:03:20Z", item: { type: "assistant_message", text: `${longAudit}\n\nHit **Proceed** on the plan and I'll build v0.0.82.` } }
                ]
              };
            }
            if (id === "done-agent-2") {
              return {
                agent: {
                  id,
                  title: "SEO skills audit",
                  provider: "codex",
                  status: "idle",
                  cwd: "/Volumes/Xtra/codex-worktrees/6baf",
                  workspaceId: "wks_6ff24b2c6fd8058f",
                  labels: { "migration.originalCwd": "/Users/owner/Dev/webapp-client", theme: "seo" },
                  requiresAttention: true,
                  attentionReason: "finished",
                  updatedAt: "2026-11-20T03:52:26Z"
                },
                entries: [
                  { timestamp: "2026-11-20T03:49:00Z", item: { type: "user_message", text: "Check phone/SMS links" } },
                  { timestamp: "2026-11-20T03:52:25Z", item: { type: "assistant_message", text: "Added call and SMS links throughout the footer.\n<oai-mem-citation> <citation_entries> rollout_summaries/secret.md </citation_entries> </oai-mem-citation>" } },
                  { timestamp: "2026-11-20T03:52:26Z", item: { type: "assistant_message", text: "Added call and SMS links throughout the footer.\n<oai-mem-citation> <citation_entries> rollout_summaries/secret.md </citation_entries> </oai-mem-citation>" } }
                ]
              };
            }
            return {
              agent: {
                id,
                title: "YouTube content strategy",
                provider: "claude",
                status: "idle",
                cwd: "/home/dev/.paseo/imported-history",
                workspaceId: "wks_b382aa8ff3a3a9bf",
                labels: { theme: "marketing" },
                requiresAttention: true,
                attentionReason: "error",
                updatedAt: "2026-11-20T02:05:00Z"
              },
              entries: [
                { timestamp: "2026-11-20T02:00:00Z", item: { type: "user_message", text: "Generate outline" } },
                { timestamp: "2026-11-20T02:05:00Z", item: { type: "error", message: "API Error 400: unknown model provider" } }
              ]
            };
          }
        }
      })
    }
  });

  const sup = new FleetSupervisor({
    dataDir: tmpDir,
    config: {
      enabled: true,
      mode: "observe",
      paseo: { enabled: true, only: true, url: "ws://127.0.0.1:6767/ws", projectsDir: false }
    },
    deps: {
      now: () => Date.parse("2026-11-20T04:05:00Z"),
      paseoFactory: fakePaseoFactory
    }
  });

  await sup.tick();
  const state = sup.getState();

  // 1. Plan Ready / Proceed card surfaced for Antigravity brain plan artifact!
  const planCard = state.cards.find((c) => c.threadKey === "paseo:srv_bb3.plan-agent-1");
  assert.ok(planCard, "expected Plan Ready card for plan-agent-1");
  assert.equal(planCard.kindLabel, "Plan Ready");
  assert.equal(planCard.primaryAction.label, "Proceed");
  assert.equal(planCard.project, "openAGI");

  // 2. Finished session surfaced as "Finished · Review" (NOT dropped as idle-no-pr!),
  //    junk hash folder "6baf" ignored in favor of migration.originalCwd ("webapp-client"),
  //    and <oai-mem-citation> + duplicate messages stripped!
  const doneCard = state.cards.find((c) => c.threadKey === "paseo:srv_bb3.done-agent-2");
  assert.ok(doneCard, "expected Finished · Review card for done-agent-2");
  assert.equal(doneCard.kind, "completed");
  assert.equal(doneCard.kindLabel, "Finished · Review");
  assert.equal(doneCard.project, "webapp-client");
  assert.ok(!String(doneCard.agentSummary ?? "").includes("oai-mem-citation"), "oai-mem-citation must be stripped");
  assert.equal(doneCard.recentMessages.filter((m) => m.role === "assistant").length, 1, "consecutive duplicate assistant messages must be deduplicated");

  // 3. Error session surfaced as "Session Error" and "imported-history" ignored in favor of theme ("marketing")!
  const errCard = state.cards.find((c) => c.threadKey === "paseo:srv_bb3.err-agent-3");
  assert.ok(errCard, "expected Session Error card for err-agent-3");
  assert.equal(errCard.kindLabel, "Session Error");
  assert.equal(errCard.project, "marketing");

  // 4. Aliasing "webapp-client" -> "MainProduct" updates card & thread project everywhere
  sup.upsertProject({ name: "MainProduct", alias: "webapp-client" });
  const aliasedState = sup.getState();
  assert.equal(aliasedState.cards.find((c) => c.id === doneCard.id).project, "MainProduct");
  assert.equal(aliasedState.snapshot.threads.find((r) => r.key === "paseo:srv_bb3.done-agent-2").project, "MainProduct");

  // 5. Clicking "Archive" on doneCard archives in Paseo AND marks completion reviewed across future ticks!
  const actRes = await sup.actCard(doneCard.id, { op: "answer", value: "Archive" });
  assert.equal(actRes.ok, true);
  assert.deepEqual(archivedIds, ["done-agent-2"]);
  await sup.tick();
  assert.equal(sup.getState().cards.find((c) => c.threadKey === "paseo:srv_bb3.done-agent-2"), undefined, "reviewed completion stays closed on next scan");
});
