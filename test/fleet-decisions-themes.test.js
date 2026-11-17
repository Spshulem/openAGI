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
import { intentCovers, ownerIntentText } from "../src/owner-authority.js";
import {
  callDecisionsEndpoint,
  createDecisionsKeepAliveGate,
  validateDecisionsUrl
} from "../src/fleet/decisions-gate.js";
import { deriveProjectInfo } from "../src/fleet/coordinator.js";
import { PASEO_LABEL_COLORS, inferSessionTheme } from "../src/fleet/themes.js";

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
