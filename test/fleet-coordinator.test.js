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
  assert.ok(recWs.overlaps.some((o) => o.kind === "concurrent_cwd"), "detects 2 loaded sessions sharing /Users/dev/Dev/recorder-app");

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
});
