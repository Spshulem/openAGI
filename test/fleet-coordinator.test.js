import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FleetSupervisor } from "../src/fleet/supervisor.js";
import { resolveFleetConfig } from "../src/fleet/contracts.js";
import { registerFleetTools } from "../src/fleet/tools.js";
import { createFleetRoute } from "../src/fleet/routes.js";
import { createFleetCapability, RemoteFleetSupervisor } from "../src/fleet/remote.js";
import { isMobileRouteAllowed } from "../src/mobile-node.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { PendingActionStore } from "../src/pending-actions.js";
import { AgentHost } from "../src/agent-host.js";
import { ownerPrincipal } from "../src/owner-authority.js";

function makePaseoMock() {
  const created = [];
  const localAgents = [
    {
      id: "mig-1",
      status: "closed",
      updatedAt: "2026-11-10T10:00:00Z",
      cwd: "/home/dev/paseo/migrated/mac/Users/dev/Dev/recorder-app/.conductor/athens",
      workspaceId: "wks_111111111111",
      title: "Recorder — migrated PR #279",
      provider: "claude"
    },
    {
      id: "agi-1",
      status: "running",
      updatedAt: "2026-11-16T15:00:00Z",
      cwd: "/home/dev/paseo/worktrees/openAGI/amman",
      workspaceId: "amman",
      title: "OpenAGI — supervisor coordinator",
      provider: "codex"
    }
  ];
  const macAgents = [
    {
      id: "rec-live-1",
      status: "idle",
      updatedAt: "2026-11-16T14:30:00Z",
      cwd: "/Users/dev/Dev/recorder-app",
      workspaceId: "recorder-app",
      title: "Recorder — instant dictation stop #427",
      provider: "codex"
    },
    {
      id: "rec-live-2",
      status: "running",
      updatedAt: "2026-11-16T14:45:00Z",
      cwd: "/Users/dev/Dev/recorder-app",
      workspaceId: "recorder-app",
      title: "Recorder — audio pipeline #427",
      provider: "claude"
    },
    {
      id: "rec-sleep-3",
      status: "closed",
      updatedAt: "2026-11-15T18:00:00Z",
      cwd: "/Users/dev/Dev/recorder-app/.conductor/dublin",
      workspaceId: "wks_222222222222",
      title: "Recorder — menu bar polish #426",
      provider: "codex"
    }
  ];

  const makeApi = (serverId, list) => ({
    agents: {
      list: async () => ({
        entries: list.map((agent) => ({ agent })),
        pageInfo: { hasMore: false, nextCursor: null }
      }),
      ref: (id) => {
        const found = list.find((a) => a.id === id) ?? { id, status: "closed", cwd: "/Users/dev/Dev/recorder-app" };
        return {
          id,
          current: () => found,
          refresh: async () => ({ agent: found, project: null }),
          timeline: {
            refetch: async () => ({
              agent: found,
              entries: [
                {
                  timestamp: "2026-11-16T14:00:00Z",
                  item: { type: "user_message", text: "Please finish https://github.com/acme/recorder-app/pull/427" }
                },
                {
                  timestamp: "2026-11-16T14:05:00Z",
                  item: { type: "user_message", text: "[OpenAGI supervisor] Continue" }
                },
                {
                  timestamp: "2026-11-16T14:10:00Z",
                  item: { type: "assistant_message", text: "Implemented instant dictation stop in acme/recorder-app#427 and tests pass." }
                }
              ]
            })
          }
        };
      },
      create: async (opts) => {
        const newAgent = {
          id: `new-${created.length + 1}`,
          status: "running",
          cwd: opts.cwd,
          title: opts.title ?? "New session",
          provider: "codex",
          updatedAt: "2026-11-16T16:00:00Z"
        };
        created.push({ serverId, opts });
        return {
          id: newAgent.id,
          current: () => newAgent
        };
      }
    },
    providers: {
      waitForReady: async () => ({
        entries: [
          {
            provider: "codex",
            status: "ready",
            models: [{ id: "gpt-5.4", isDefault: true }]
          }
        ]
      })
    }
  });

  const localApi = makeApi("srv_linux", localAgents);
  const macApi = makeApi("srv_mac", macAgents);

  const factory = () => ({
    ...localApi,
    connect: async () => {},
    close: async () => {},
    hosts: {
      list: async () => ({
        self: { serverId: "srv_linux", label: "linux-box" },
        hosts: [{ serverId: "srv_mac", label: "workstation-mac", enabled: true, status: "online" }]
      }),
      client: async (sid) => {
        if (sid === "srv_mac") return macApi;
        throw new Error("unknown host");
      }
    }
  });

  return { factory, created };
}

test("listWorkspaces, readChatTranscript, inspectRepoStatus, startPaseoSession, and batchActCards coordinate across hosts", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-coordinator-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const mock = makePaseoMock();
  const mergedPrs = [];

  const runMock = async (bin, args) => {
    const joined = args.join(" ");
    if (joined.includes("pr list") && joined.includes("--state open")) {
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            number: 427,
            title: "feat: instant dictation stop",
            headRefName: "spencer/dictation-stop",
            baseRefName: "main",
            isDraft: false,
            mergeStateStatus: "CLEAN",
            reviewDecision: "APPROVED",
            statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
            updatedAt: "2026-11-16T14:50:00Z",
            url: "https://github.com/acme/recorder-app/pull/427"
          },
          {
            number: 426,
            title: "fix: menu bar icon contrast",
            headRefName: "dev/menubar",
            baseRefName: "main",
            isDraft: false,
            mergeStateStatus: "CLEAN",
            reviewDecision: null,
            statusCheckRollup: [{ name: "test", status: "COMPLETED", conclusion: "FAILURE" }],
            updatedAt: "2026-11-15T18:00:00Z",
            url: "https://github.com/acme/recorder-app/pull/426"
          }
        ]),
        stderr: ""
      };
    }
    if (joined.includes("pr list") && joined.includes("--state merged")) {
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            number: 279,
            title: "feat: conversation map",
            headRefName: "dev/conv-map",
            mergedAt: "2026-11-10T09:00:00Z",
            url: "https://github.com/acme/recorder-app/pull/279"
          }
        ]),
        stderr: ""
      };
    }
    if (joined.includes("release list")) {
      return {
        code: 0,
        stdout: JSON.stringify([
          { tagName: "v1.8.2", name: "v1.8.2", publishedAt: "2026-11-08T12:00:00Z", isDraft: false, isPrerelease: false }
        ]),
        stderr: ""
      };
    }
    if (joined.includes("pr view") && joined.includes("427")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          state: "OPEN",
          isDraft: false,
          headRefOid: "abc1234567",
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          reviewDecision: "APPROVED",
          statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }]
        }),
        stderr: ""
      };
    }
    if (joined.includes("pr merge")) {
      mergedPrs.push(joined);
      return { code: 0, stdout: "Merged", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "unhandled" };
  };

  const sup = new FleetSupervisor({
    dataDir: dir,
    config: resolveFleetConfig({}, {
      enabled: true,
      mode: "propose",
      paseo: { enabled: true },
      review: { enabled: false },
      storage: { enabled: false }
    }),
    deps: {
      paseoFactory: mock.factory,
      run: runMock
    }
  });

  // 1. listWorkspaces groups migrated + remote worktrees into canonical projects & prefers live non-migrated root
  const wsRes = await sup.listWorkspaces({ query: "recorder-app" });
  assert.equal(wsRes.workspaces.length, 1);
  const recWs = wsRes.workspaces[0];
  assert.equal(recWs.id, "recorder-app");
  assert.equal(recWs.counts.total, 4);
  assert.equal(recWs.counts.running, 1);
  assert.equal(recWs.counts.idle, 1);
  assert.equal(recWs.counts.sleeping, 2);
  assert.deepEqual(recWs.defaultTarget, {
    serverId: "srv_mac",
    hostLabel: "workstation-mac",
    cwd: "/Users/dev/Dev/recorder-app"
  });
  assert.equal(recWs.overlaps.some((o) => o.kind === "concurrent_cwd"), false, "does not warn for 1 running + 1 idle session in /Users/dev/Dev/recorder-app");

  // 2. readChatTranscript reads sleeping Paseo chat timeline & caches PR refs
  const transcript = await sup.readChatTranscript({ key: "paseo:srv_mac.rec-live-1", limit: 10 });
  assert.equal(transcript.title, "Recorder — instant dictation stop #427");
  assert.deepEqual(transcript.prRefs, ["acme/recorder-app#427"]);
  assert.deepEqual(transcript.messages.map((m) => m.role), ["user", "supervisor", "assistant"]);

  // 3. inspectRepoStatus resolves acme/recorder-app from workspace name and cross-references fleet sessions
  const repoStatus = await sup.inspectRepoStatus({ workspace: "recorder-app" });
  assert.equal(repoStatus.repo, "acme/recorder-app");
  assert.equal(repoStatus.summary.openCount, 2);
  assert.equal(repoStatus.summary.greenReadyCount, 1);
  assert.equal(repoStatus.summary.ciFailingCount, 1);
  const pr427 = repoStatus.openPrs.find((p) => p.number === 427);
  assert.equal(pr427.linkedSessions.length, 1);
  assert.equal(pr427.linkedSessions[0].key, "paseo:srv_mac.rec-live-1");
  assert.equal(pr427.orphaned, false);
  const pr426 = repoStatus.openPrs.find((p) => p.number === 426);
  assert.equal(pr426.orphaned, true, "#426 has no loaded active session");
  assert.equal(repoStatus.recentlyMerged[0].number, 279);
  assert.equal(repoStatus.releases[0].tag, "v1.8.2");

  // 4. startPaseoSession automatically targets srv_mac:/Users/dev/Dev/recorder-app with ready codex/gpt-5.4
  const started = await sup.startPaseoSession({
    workspace: "recorder-app",
    title: "Recorder v1.8.3 release prep",
    prompt: "Verify #427 and #426 status and prepare v1.8.3 changelog."
  });
  assert.equal(started.status, "started");
  assert.equal(started.serverId, "srv_mac");
  assert.equal(started.cwd, "/Users/dev/Dev/recorder-app");
  assert.equal(started.provider, "codex/gpt-5.4");
  assert.equal(started.key, "paseo:srv_mac.new-1");
  assert.equal(mock.created.length, 1);
  assert.ok(sup.threadDetail("paseo:srv_mac.new-1"), "newly started session is immediately addressable by fleet tools");

  // 5. batchActCards merges green PR cards and defers routine questions safely
  sup.store.upsertQuestion({
    dedupeKey: "ready:427",
    kind: "ready",
    threadKey: "paseo:srv_mac.rec-live-1",
    prRef: "acme/recorder-app#427",
    askedHead: "abc1234567",
    title: "recorder-app #427 ready to merge",
    body: "CI green",
    options: ["merged", "later"],
    contextSnapshot: {
      pr: { ref: "acme/recorder-app#427", state: "OPEN", ciState: "SUCCESS", mergeState: "CLEAN", head: "abc1234567" }
    }
  });
  sup.store.upsertQuestion({
    dedupeKey: "ask:q1",
    kind: "agent-ask",
    threadKey: "paseo:srv_linux.agi-1",
    title: "Keep current polling interval?",
    body: "Choose interval",
    options: ["Yes", "No"]
  });

  const batchMerge = await sup.batchActCards({ op: "merge_green" });
  assert.equal(batchMerge.ok, true);
  assert.equal(batchMerge.total, 1);
  assert.equal(batchMerge.succeeded, 1);
  assert.equal(mergedPrs.length, 1);

  const batchDefer = await sup.batchActCards({ op: "defer", filter: "questions" });
  assert.equal(batchDefer.ok, true);
  assert.equal(batchDefer.total, 1);
  assert.equal(sup.getState().cards.length, 0);

  // 6. HTTP routes & mobile allowlist
  assert.equal(isMobileRouteAllowed("GET", "/fleet/api/workspaces"), true);
  assert.equal(isMobileRouteAllowed("GET", "/fleet/api/repo-status"), true);
  assert.equal(isMobileRouteAllowed("POST", "/fleet/api/sessions/start"), true);
  assert.equal(isMobileRouteAllowed("POST", "/fleet/api/cards/batch"), true);

  const route = createFleetRoute({ supervisor: sup });
  const wsHttp = await route("GET", "/fleet/api/workspaces", new URL("http://localhost/fleet/api/workspaces?query=openAGI"), async () => ({}));
  assert.equal(wsHttp.status, 200);
  assert.equal(wsHttp.body.workspaces[0].id, "openagi");

  const repoHttp = await route("GET", "/fleet/api/repo-status", new URL("http://localhost/fleet/api/repo-status?repo=acme/recorder-app"), async () => ({}));
  assert.equal(repoHttp.status, 200);
  assert.equal(repoHttp.body.repo, "acme/recorder-app");

  // 7. Tainted owner turn executes fleet_start_session without 'Say yes NN' when owner asks to coordinate
  const pending = new PendingActionStore({ dir: path.join(dir, "pending") });
  const tools = new ToolRegistry();
  tools.bindPendingActions(pending);
  registerFleetTools(tools, sup);

  const ownerCtx = {
    sessionId: "shared:supervisor:main",
    channel: "local",
    from: "user",
    __owner: ownerPrincipal("owner"),
    __turn: {
      untrusted: true,
      intent: "can you cordinate with the recorder-app workspace chats and start a new session to cut the release?"
    }
  };
  await tools.invoke("fleet_workspaces", { query: "recorder-app" }, ownerCtx);
  const startInvoke = await tools.invoke("fleet_start_session", {
    workspace: "recorder-app",
    prompt: "Coordinate final release smoke check."
  }, ownerCtx);
  assert.equal(startInvoke.ok, true);
  assert.equal(startInvoke.result.status, "started", "runs immediately without awaiting_owner_confirmation");
});

test("AgentHost executes multi-code ('yes 60, yes 19, yes 78') and 'yes all' confirmations in one turn", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-multicode-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const codes = [60, 19, 78, 41, 52];
  const pending = new PendingActionStore({ dir, randomInt: () => codes.shift() ?? 88 });
  const tools = new ToolRegistry();
  tools.bindPendingActions(pending);

  const sent = [];
  tools.register({
    name: "fleet_send_message",
    needsConfirmation: true,
    summarize: (args) => `Send to ${args.key}`,
    handler: async (args) => {
      sent.push(args.key);
      return { status: "sent", key: args.key };
    }
  });

  let seenTurnContexts = [];
  const runtime = {
    tools,
    pendingActions: pending,
    processSignal: () => ({ id: "out-1", scrutiny: { action: "act", score: 0.5, dimensions: {}, reasons: [] }, customContext: [] })
  };
  const modelProvider = {
    isConfigured: () => true,
    generate: async ({ turnContext }) => {
      seenTurnContexts.push(turnContext);
      return { id: "resp-1", provider: "openai", model: "test", text: "Confirmed all three actions.", toolCalls: [] };
    }
  };
  const host = new AgentHost({ runtime, modelProvider });
  const sessionId = "shared:supervisor:main";
  const principal = ownerPrincipal("owner");

  // Enqueue 3 chat-mode pending actions (codes 60, 19, 78) as if raised on a passive turn
  const passiveCtx = {
    sessionId,
    channel: "local",
    from: "user",
    __owner: principal,
    __turn: { untrusted: true, intent: "what's the latest?" }
  };
  const a1 = await tools.invoke("fleet_send_message", { key: "paseo:1" }, passiveCtx);
  const a2 = await tools.invoke("fleet_send_message", { key: "paseo:2" }, passiveCtx);
  const a3 = await tools.invoke("fleet_send_message", { key: "paseo:3" }, passiveCtx);
  assert.deepEqual([a1.result.code, a2.result.code, a3.result.code], ["60", "19", "78"]);
  assert.equal(sent.length, 0);

  await host.handleMessage(
    { sessionId, channel: "local", from: "user", text: "yes 60, yes 19, yes 78" },
    { principal }
  );
  assert.deepEqual(sent, ["paseo:1", "paseo:2", "paseo:3"]);
  assert.match(seenTurnContexts.at(-1), /"codes":\["60","19","78"\]/);

  // Test 'yes all' batch confirmation for remaining chat candidates in the same session
  const b1 = await tools.invoke("fleet_send_message", { key: "paseo:4" }, passiveCtx);
  const b2 = await tools.invoke("fleet_send_message", { key: "paseo:5" }, passiveCtx);
  assert.equal(b1.result.status, "awaiting_owner_confirmation");
  assert.equal(b2.result.status, "awaiting_owner_confirmation");

  await host.handleMessage(
    { sessionId, channel: "local", from: "user", text: "yes all" },
    { principal }
  );
  assert.deepEqual(sent, ["paseo:1", "paseo:2", "paseo:3", "paseo:4", "paseo:5"]);

  // 'yes both' refuses when 3 actions are pending, and succeeds when exactly 2 are pending
  await tools.invoke("fleet_send_message", { key: "paseo:6" }, passiveCtx);
  await tools.invoke("fleet_send_message", { key: "paseo:7" }, passiveCtx);
  await tools.invoke("fleet_send_message", { key: "paseo:8" }, passiveCtx);
  await host.handleMessage(
    { sessionId, channel: "local", from: "user", text: "yes both" },
    { principal }
  );
  assert.equal(sent.length, 5, "'yes both' must not approve 3 pending actions");
  assert.match(seenTurnContexts.at(-1), /expected 2 pending actions, found 3/);
});

test("review regressions: batch filter preserves op, strict batch validation, STARTUP_FAILURE CI, host/cwd safety, and remote transcript route", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-coord-reg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const mock = makePaseoMock();
  // Seed workspace catalog with a migrated worktree path on srv_mac to verify live root score wins
  const baseFactory = mock.factory;
  const factoryWithCatalog = () => {
    const client = baseFactory();
    const origHostClient = client.hosts.client;
    client.hosts.client = async (sid) => {
      const api = await origHostClient(sid);
      return {
        ...api,
        workspaces: {
          list: async () => ({
            entries: [
              {
                id: "ws-mig",
                directory: "/home/dev/paseo/migrated/mac/Users/dev/Dev/recorder-app/.conductor/old",
                name: "old",
                archivedAt: null
              }
            ]
          })
        }
      };
    };
    return client;
  };

  let mergeCalls = 0;
  const sup = new FleetSupervisor({
    dataDir: dir,
    config: resolveFleetConfig({}, {
      enabled: true,
      mode: "propose",
      paseo: { enabled: true },
      review: { enabled: false },
      storage: { enabled: false }
    }),
    deps: {
      paseoFactory: factoryWithCatalog,
      run: async (_bin, args) => {
        const joined = args.join(" ");
        if (joined.includes("pr list") && joined.includes("--state open")) {
          return {
            code: 0,
            stdout: JSON.stringify([
              {
                number: 500,
                title: "chore: startup failure check",
                headRefName: "dev/startup-fail",
                baseRefName: "main",
                isDraft: false,
                mergeStateStatus: "CLEAN",
                reviewDecision: "APPROVED",
                statusCheckRollup: [{ name: "runner-boot", status: "COMPLETED", conclusion: "STARTUP_FAILURE" }],
                updatedAt: "2026-11-16T16:00:00Z",
                url: "https://github.com/acme/recorder-app/pull/500"
              }
            ]),
            stderr: ""
          };
        }
        if (joined.includes("pr list") && joined.includes("--state merged")) {
          return { code: 0, stdout: "[]", stderr: "" };
        }
        if (joined.includes("release list")) {
          return { code: 0, stdout: "[]", stderr: "" };
        }
        if (joined.includes("pr merge")) {
          mergeCalls += 1;
          return { code: 0, stdout: "Merged", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "" };
      }
    }
  });

  // 1. STARTUP_FAILURE is classified as FAILURE, never greenReadyCount
  const repoStatus = await sup.inspectRepoStatus({ repo: "acme/recorder-app" });
  assert.equal(repoStatus.openPrs[0].ciState, "FAILURE");
  assert.deepEqual(repoStatus.openPrs[0].failingChecks, ["runner-boot"]);
  assert.equal(repoStatus.summary.greenReadyCount, 0);

  // 2. Live root directory score beats lower-scoring catalog migrated directory on srv_mac
  const ws = await sup.listWorkspaces({ query: "recorder-app" });
  const macHost = ws.workspaces[0].hosts.find((h) => h.serverId === "srv_mac");
  assert.equal(macHost.preferredCwd, "/Users/dev/Dev/recorder-app");

  // 3. Explicit serverId without workspace directory on that host fails closed instead of borrowing srv_mac's path
  await assert.rejects(
    sup.startPaseoSession({
      workspace: "openAGI",
      serverId: "srv_mac",
      prompt: "Should fail closed"
    }),
    /no known directory on Paseo host "srv_mac"/
  );

  // 4. Cwd-only start resolves owning host when known, and rejects unknown paths instead of picking workspaces[0]
  const cwdStarted = await sup.startPaseoSession({
    cwd: "/Users/dev/Dev/recorder-app",
    prompt: "Run in known Mac cwd"
  });
  assert.equal(cwdStarted.serverId, "srv_mac");
  assert.equal(cwdStarted.cwd, "/Users/dev/Dev/recorder-app");

  await assert.rejects(
    sup.startPaseoSession({
      cwd: "/nonexistent/unknown/repo",
      prompt: "Must not guess host"
    }),
    /Could not determine which Paseo host owns directory/
  );

  // 5. op: "defer" with filter: "green_prs" defers without merging; malformed/unscoped HTTP batch requests return 400
  sup.store.upsertQuestion({
    dedupeKey: "ready:427",
    kind: "ready",
    threadKey: "paseo:srv_mac.rec-live-1",
    prRef: "acme/recorder-app#427",
    askedHead: "abc1234567",
    title: "recorder-app #427 ready to merge",
    body: "CI green",
    options: ["merged", "later"],
    contextSnapshot: {
      pr: { ref: "acme/recorder-app#427", state: "OPEN", ciState: "SUCCESS", mergeState: "CLEAN", head: "abc1234567" }
    }
  });

  const route = createFleetRoute({ supervisor: sup });
  assert.equal((await route("POST", "/fleet/api/cards/batch", new URL("http://localhost/fleet/api/cards/batch"), async () => null)).status, 400);
  assert.equal((await route("POST", "/fleet/api/cards/batch", new URL("http://localhost/fleet/api/cards/batch"), async () => ({}))).status, 400);
  assert.equal((await route("POST", "/fleet/api/cards/batch", new URL("http://localhost/fleet/api/cards/batch"), async () => ({ op: "defer" }))).status, 400);
  assert.equal(sup.getState().cards.length, 1, "malformed/unscoped batch calls leave cards untouched");

  const deferGreen = await sup.batchActCards({ op: "defer", filter: "green_prs" });
  assert.equal(deferGreen.ok, true);
  assert.equal(deferGreen.op, "defer");
  assert.equal(deferGreen.succeeded, 1);
  assert.equal(mergeCalls, 0, "defer with filter green_prs must never execute merge");

  // 6. RemoteFleetSupervisor proxies readChatTranscript over /fleet/api/threads/:key/transcript to read sleeping Paseo timelines
  assert.equal(isMobileRouteAllowed("GET", "/fleet/api/threads/paseo%3Asrv_mac.rec-sleep-3/transcript"), true);
  const cap = createFleetCapability(sup);
  const remoteRuntime = {
    nodeCapabilities: {
      list: () => [{ nodeId: "mac-node" }],
      dispatch: async (_nodeId, _capId, op, payload) => cap.invoke(op, payload)
    }
  };
  const remoteSup = new RemoteFleetSupervisor({ runtime: remoteRuntime, nodeId: "mac-node", dataDir: path.join(dir, "remote") });
  const remoteTranscript = await remoteSup.readChatTranscript({ key: "paseo:srv_mac.rec-sleep-3", limit: 5 });
  assert.equal(remoteTranscript.key, "paseo:srv_mac.rec-sleep-3");
  assert.equal(remoteTranscript.messages.length, 3);
  assert.match(remoteTranscript.messages.at(-1).text, /acme\/recorder-app#427/);

  // 7. RemoteFleetSupervisor.batchActCards processes locally owned selfFixHub cards alongside remote cards
  const remoteQ = sup.store.upsertQuestion({
    dedupeKey: "ask:remote-1",
    kind: "decision",
    threadKey: "paseo:srv_mac.rec-live-1",
    title: "Remote question",
    body: "Pick remote option?",
    options: ["Option A", "later"]
  });
  const localQ1 = remoteSup.selfFixHub.store.upsertQuestion({
    dedupeKey: "self-fix:1",
    kind: "suggestion",
    title: "Local self-fix 1",
    body: "Apply local fix 1?",
    options: ["Fix it", "dismiss"]
  });
  const localQ2 = remoteSup.selfFixHub.store.upsertQuestion({
    dedupeKey: "self-fix:2",
    kind: "suggestion",
    title: "Local self-fix 2",
    body: "Apply local fix 2?",
    options: ["Fix it", "dismiss"]
  });
  await remoteSup.refresh();
  assert.equal(remoteSup.getState().cards.length, 3);

  const explicitLocalBatch = await remoteSup.batchActCards({ op: "defer", cardIds: [localQ1.id] });
  assert.equal(explicitLocalBatch.ok, true);
  assert.equal(explicitLocalBatch.total, 1);
  assert.equal(explicitLocalBatch.succeeded, 1);
  assert.equal(remoteSup.selfFixHub.store.question(localQ1.id).status, "dismissed");

  const combinedFilterBatch = await remoteSup.batchActCards({ op: "defer", filter: "questions" });
  assert.equal(combinedFilterBatch.ok, true);
  assert.equal(combinedFilterBatch.total, 2);
  assert.equal(combinedFilterBatch.succeeded, 2);
  assert.equal(sup.store.question(remoteQ.id).status, "dismissed");
  assert.equal(remoteSup.selfFixHub.store.question(localQ2.id).status, "dismissed");
  assert.equal(remoteSup.getState().cards.length, 0);
});

test("Round 2 review regressions: migrated alias dedupe and local git origin host verification", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-coord-r2-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sharedName = "shared-checkout";
  const sameLocalPath = path.join(dir, sharedName);
  fs.mkdirSync(sameLocalPath, { recursive: true });

  let localGitProbes = 0;
  const aliasFactory = () => {
    const selfAgents = [
      {
        id: "paseo-mig-1",
        title: "Migrated session",
        cwd: "/home/dev/Dev/alpha-service",
        status: "idle",
        provider: "codex",
        persistence: { sessionId: "legacy-codex-1" },
        updatedAt: "2026-11-16T16:10:00Z"
      }
    ];
    const remoteAgents = [
      {
        id: "remote-shared-1",
        title: "Remote session with colliding path",
        cwd: sameLocalPath,
        status: "idle",
        provider: "claude",
        updatedAt: "2026-11-16T16:12:00Z"
      }
    ];
    const makeApi = (agents) => ({
      agents: {
        list: async () => ({ entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false } }),
        ref: (id) => ({
          timeline: {
            refetch: async () => ({ agent: agents.find((a) => a.id === id), entries: [] })
          }
        })
      }
    });
    return {
      connect: async () => {},
      close: async () => {},
      ...makeApi(selfAgents),
      hosts: {
        list: async () => ({
          self: { serverId: "srv_self", label: "linux-box" },
          hosts: [{ serverId: "srv_remote", label: "remote-mac", enabled: true, status: "online" }]
        }),
        client: (id) => (id === "srv_remote" ? makeApi(remoteAgents) : makeApi(selfAgents))
      }
    };
  };

  const sup = new FleetSupervisor({
    dataDir: dir,
    config: resolveFleetConfig({}, {
      enabled: true,
      mode: "propose",
      paseo: { enabled: true },
      review: { enabled: false },
      storage: { enabled: false }
    }),
    deps: {
      paseoFactory: aliasFactory,
      run: async (bin, args) => {
        const joined = `${bin} ${args.join(" ")}`;
        if (bin === "git" && args.includes("get-url")) {
          localGitProbes += 1;
          return { code: 0, stdout: "https://github.com/wrong-local-owner/shared-checkout.git\n", stderr: "" };
        }
        if (joined.includes("search repos shared-checkout")) {
          return {
            code: 0,
            stdout: JSON.stringify([{ fullName: "remote-org/shared-checkout", updatedAt: "2026-11-16T16:00:00Z" }]),
            stderr: ""
          };
        }
        if (joined.includes("pr list --repo remote-org/shared-checkout --state open")) {
          return { code: 0, stdout: "[]", stderr: "" };
        }
        if (joined.includes("pr list --repo acme/alpha-service --state open")) {
          return {
            code: 0,
            stdout: JSON.stringify([
              {
                number: 77,
                title: "feat: alpha",
                headRefName: "feat/alpha-77",
                baseRefName: "main",
                isDraft: false,
                mergeStateStatus: "CLEAN",
                reviewDecision: "APPROVED",
                statusCheckRollup: [],
                updatedAt: "2026-11-16T16:05:00Z",
                url: "https://github.com/acme/alpha-service/pull/77"
              }
            ]),
            stderr: ""
          };
        }
        if (joined.includes("--state merged") || joined.includes("release list")) {
          return { code: 0, stdout: "[]", stderr: "" };
        }
        return { code: 1, stdout: "", stderr: "" };
      }
    }
  });

  // Seed legacy migrated row alongside Paseo replacement
  sup.lastThreads.set("codex:legacy-codex-1", {
    key: "codex:legacy-codex-1",
    kind: "codex",
    title: "Migrated session",
    cwd: "/home/dev/Dev/alpha-service",
    repo: "acme/alpha-service",
    branch: "feat/alpha-77",
    prRefs: ["acme/alpha-service#77"],
    agentStatus: "idle",
    excluded: "paseo-migrated",
    lastActivityAt: "2026-11-16T16:09:00Z"
  });

  const ws = await sup.listWorkspaces({ query: "alpha-service" });
  assert.equal(ws.workspaces.length, 1);
  assert.equal(ws.workspaces[0].counts.total, 1, "migrated legacy row collapsed into Paseo session");
  assert.equal(ws.workspaces[0].hosts.length, 1, "no false local+Paseo multi-host count");
  assert.equal(ws.workspaces[0].overlaps.length, 0, "no false same_pr or multi_host overlap warning");

  const alphaRepo = await sup.inspectRepoStatus({ workspace: "alpha-service" });
  assert.equal(alphaRepo.repo, "acme/alpha-service");
  assert.equal(alphaRepo.openPrs[0].linkedSessions.length, 1, "linkedSessions collapses migrated alias");
  assert.equal(alphaRepo.openPrs[0].overlapping, false);

  // Discover remote session into knownThreads via listWorkspaces, then verify inspectRepoStatus skips local git probe
  await sup.listWorkspaces({ query: sharedName });
  const sharedStatus = await sup.inspectRepoStatus({ workspace: sharedName });
  assert.equal(localGitProbes, 0, "must never run local git remote probe for remote Paseo host path");
  assert.equal(sharedStatus.repo, "remote-org/shared-checkout");

  // Round 3:
  // 1) Branch-only session without repo identity must NOT link to another repo's PR on the same branch name
  sup.lastThreads.set("claude:unrelated-branch", {
    key: "claude:unrelated-branch",
    kind: "claude",
    title: "Unrelated local feature",
    cwd: null,
    repo: null,
    branch: "feat/alpha-77",
    prRefs: [],
    agentStatus: "running",
    lastActivityAt: "2026-11-16T16:15:00Z"
  });
  const alphaAfterUnrelated = await sup.inspectRepoStatus({ repo: "acme/alpha-service" });
  assert.equal(alphaAfterUnrelated.openPrs[0].linkedSessions.length, 1, "unrelated branch without repo must not link");
  assert.equal(alphaAfterUnrelated.openPrs[0].overlapping, false);

  // 2) Archive search record (state: 'archived', agentStatus: 'closed', no archived boolean) is normalized
  sup.recordDiscoveredThread({
    key: "paseo:srv_remote.arch-only-99",
    kind: "paseo",
    title: "Old archived chat",
    agentStatus: "closed",
    state: "archived",
    meta: { serverId: "srv_remote", paseoCwd: "/Users/dev/Dev/retired-project", provider: "claude" }
  });
  const defaultRetired = await sup.listWorkspaces({ query: "retired-project" });
  assert.equal(defaultRetired.workspaces.length, 0, "archived search row hidden when includeArchived is false");
  const withArchivedRetired = await sup.listWorkspaces({ query: "retired-project", includeArchived: true });
  assert.equal(withArchivedRetired.workspaces.length, 1);
  assert.equal(withArchivedRetired.workspaces[0].recentChats[0].state, "archived");
  assert.equal(withArchivedRetired.workspaces[0].recentChats[0].wakeable, false);

  // 3) RemoteFleetSupervisor.actCard / batchActCards resolves multi-option self-fix secondaryAction ('Request changes') instead of dismissing
  const cap = createFleetCapability(sup);
  const remoteSup = new RemoteFleetSupervisor({
    runtime: {
      nodeCapabilities: {
        list: () => [{ nodeId: "n1" }],
        dispatch: async (_nodeId, _capId, op, payload) => cap.invoke(op, payload)
      }
    },
    nodeId: "n1",
    dataDir: path.join(dir, "remote-r3")
  });
  let answeredChoice = null;
  remoteSup.selfFixHub.answer = async (id, answer) => {
    answeredChoice = { id, answer };
    remoteSup.selfFixHub.store.answerQuestion(id, answer);
    return { question: remoteSup.selfFixHub.store.question(id), delivery: { status: "sent" } };
  };
  const reviewQ = remoteSup.selfFixHub.store.upsertQuestion({
    dedupeKey: "self-fix:review-pr",
    kind: "decision",
    title: "Self-fix PR ready",
    body: "Review self-fix PR?",
    options: ["Review PR", "Request changes", "Close PR"]
  });
  await remoteSup.refresh();
  const secBatch = await remoteSup.batchActCards({ op: "secondary", cardIds: [reviewQ.id] });
  assert.equal(secBatch.ok, true);
  assert.equal(secBatch.succeeded, 1);
  assert.deepEqual(answeredChoice, { id: reviewQ.id, answer: "Request changes" });
  assert.equal(remoteSup.selfFixHub.store.question(reviewQ.id).status, "answered");

  // Round 4:
  // 1) fleet_batch_cards pins target cardIds/actions at approval preparation time so cards added later are untouched
  const approvedQ = sup.store.upsertQuestion({
    dedupeKey: "batch-pin:1",
    kind: "decision",
    title: "Card present at approval prep",
    body: "Approve first?",
    options: ["Yes", "later"]
  });
  const registry = new ToolRegistry();
  const pending = new PendingActionStore({ dir: path.join(dir, "pending-r4") });
  registry.bindPendingActions(pending);
  registerFleetTools(registry, sup);

  const queued = await registry.invoke("fleet_batch_cards", { op: "defer", filter: "all" }, { sessionId: "pin-test" });
  assert.equal(queued.result.status, "awaiting_confirmation");

  const lateArrivalQ = sup.store.upsertQuestion({
    dedupeKey: "batch-pin:2",
    kind: "decision",
    title: "Card arrived after approval prep",
    body: "Should NOT be touched!",
    options: ["Yes", "later"]
  });

  const action = pending.get(queued.result.actionId);
  const executed = await registry.invoke(action.toolName, action.args, { ...action.context, __confirmed: true });
  assert.equal(executed.result.total, 1);
  assert.equal(sup.store.question(approvedQ.id).status, "dismissed");
  assert.equal(sup.store.question(lateArrivalQ.id).status, "open", "newly arrived card must remain open");

  // 2) Connected live peer object on idle/waiting/error Claude/Conductor sessions does not override explicit status
  sup.lastThreads.set("claude:peer-idle", {
    key: "claude:peer-idle",
    kind: "claude",
    title: "Idle Claude with peer",
    cwd: "/home/dev/Dev/peer-proj",
    agentStatus: "idle",
    live: { peerName: "peer-1", pid: 4001, status: "idle" }
  });
  sup.lastThreads.set("claude:peer-waiting", {
    key: "claude:peer-waiting",
    kind: "claude",
    title: "Waiting Claude with peer",
    cwd: "/home/dev/Dev/peer-proj",
    agentStatus: "waiting",
    live: { peerName: "peer-2", pid: 4002, status: "idle" }
  });
  sup.lastThreads.set("conductor:peer-err", {
    key: "conductor:peer-err",
    kind: "conductor",
    title: "Errored Conductor with peer",
    cwd: "/home/dev/Dev/peer-proj",
    agentStatus: "error",
    error: { kind: "other", text: "failed" },
    live: { peerName: "peer-3", pid: 4003, status: "idle" }
  });
  sup.lastThreads.set("claude:peer-busy", {
    key: "claude:peer-busy",
    kind: "claude",
    title: "Busy Claude with peer",
    cwd: "/home/dev/Dev/peer-proj",
    agentStatus: "idle",
    live: { peerName: "peer-4", pid: 4004, status: "busy" }
  });
  const peerWs = await sup.listWorkspaces({ query: "peer-proj" });
  const byKeyState = new Map(peerWs.workspaces[0].recentChats.map((s) => [s.key, s.state]));
  assert.equal(byKeyState.get("claude:peer-idle"), "idle");
  assert.equal(byKeyState.get("claude:peer-waiting"), "waiting");
  assert.equal(byKeyState.get("conductor:peer-err"), "error");
  assert.equal(byKeyState.get("claude:peer-busy"), "running");

  // 3) startPaseoSession({ cwd }) prefers exact directory match across hosts over ancestor match, and rejects ambiguous multi-host exact matches
  const createdOnHost = [];
  const exactVsAncestorFactory = () => {
    const selfAgents = [
      { id: "s1", title: "Root repo", cwd: "/home/dev/nested-repo", status: "running", provider: "codex", updatedAt: "2026-11-16T16:20:00Z" },
      { id: "s2", title: "Dup dir", cwd: "/home/dev/dup-repo", status: "idle", provider: "codex", updatedAt: "2026-11-16T16:20:00Z" }
    ];
    const remoteAgents = [
      { id: "r1", title: "Subpackage", cwd: "/home/dev/nested-repo/new", status: "idle", provider: "codex", updatedAt: "2026-11-16T16:10:00Z" },
      { id: "r2", title: "Dup dir", cwd: "/home/dev/dup-repo", status: "idle", provider: "codex", updatedAt: "2026-11-16T16:20:00Z" }
    ];
    const makeApi = (hostId, agents) => ({
      providers: {
        waitForReady: async () => ({ entries: [{ provider: "codex", status: "ready", models: [{ id: "gpt-5", isDefault: true }] }] })
      },
      agents: {
        list: async () => ({ entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false } }),
        create: async (req) => {
          createdOnHost.push({ hostId, cwd: req.cwd });
          return { id: "new-agt", current: () => ({ id: "new-agt", status: "running", cwd: req.cwd, title: "New", provider: "codex" }) };
        }
      }
    });
    return {
      connect: async () => {},
      close: async () => {},
      ...makeApi("srv_self", selfAgents),
      hosts: {
        list: async () => ({
          self: { serverId: "srv_self", label: "linux-box" },
          hosts: [{ serverId: "srv_remote", label: "remote-mac", enabled: true, status: "online" }]
        }),
        client: (id) => (id === "srv_remote" ? makeApi("srv_remote", remoteAgents) : makeApi("srv_self", selfAgents))
      }
    };
  };

  const startedExact = await sup.startPaseoSession({
    cwd: "/home/dev/nested-repo/new",
    prompt: "Must pick srv_remote exact match over srv_self ancestor",
    factory: exactVsAncestorFactory
  });
  assert.equal(startedExact.serverId, "srv_remote");
  assert.deepEqual(createdOnHost, [{ hostId: "srv_remote", cwd: "/home/dev/nested-repo/new" }]);

  await assert.rejects(
    sup.startPaseoSession({
      cwd: "/home/dev/dup-repo",
      prompt: "Must fail closed when both hosts share exact path",
      factory: exactVsAncestorFactory
    }),
    /exists on multiple Paseo hosts/
  );
});
