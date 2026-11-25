import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskStore } from "../src/task-store.js";
import { FleetSupervisor } from "../src/fleet/supervisor.js";
import { resolveFleetConfig } from "../src/fleet/contracts.js";
import { createFleetRoute } from "../src/fleet/routes.js";
import { createFleetCapability } from "../src/fleet/remote.js";
import { isMobileRouteAllowed } from "../src/mobile-node.js";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeMockPaseoFactory() {
  const created = [];
  const agentsList = [
    {
      id: "agi-existing",
      status: "running",
      updatedAt: "2026-11-19T12:00:00.000Z",
      cwd: "/home/dev/paseo/worktrees/openAGI/amman",
      workspaceId: "amman",
      title: "OpenAGI — existing",
      provider: "codex"
    }
  ];
  const makeApi = (serverId) => ({
    agents: {
      list: async () => ({
        entries: agentsList.map((agent) => ({ agent })),
        pageInfo: { hasMore: false, nextCursor: null }
      }),
      ref: (id) => ({
        id,
        current: () => ({ id, status: "running", cwd: "/home/dev/paseo/worktrees/openAGI/amman" }),
        refresh: async () => ({ agent: { id, status: "running" }, project: null }),
        timeline: { refetch: async () => ({ agent: { id }, entries: [] }) }
      }),
      create: async (opts) => {
        const agent = {
          id: `board-${created.length + 1}`,
          status: "running",
          cwd: opts.cwd,
          title: opts.title ?? "Board task",
          provider: "codex",
          model: opts.config?.model ?? "gpt-5.4",
          updatedAt: "2026-11-19T12:05:00.000Z"
        };
        created.push({ serverId, opts, agent });
        return { id: agent.id, current: () => agent };
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
  const localApi = makeApi("srv_local");
  const factory = () => ({
    ...localApi,
    connect: async () => {},
    close: async () => {},
    hosts: {
      list: async () => ({ self: { serverId: "srv_local", label: "buildbot3" }, hosts: [] }),
      client: async () => { throw new Error("unknown host"); }
    }
  });
  return { factory, created };
}

test("TaskStore preserves top-level keys while storing Board sourceMeta, key=value labels, and blocking impact", (t) => {
  const dir = makeTempDir("openagi-board-tasks-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const store = new TaskStore({ dataDir: dir });
  const plain = store.add({ title: "Plain task", bucket: "today" });
  assert.equal(plain.sourceMeta, null);
  assert.deepEqual(Object.keys(plain).sort(), [
    "bucket", "category", "completedAt", "completedVia", "createdAt", "dependsOn",
    "description", "dueDate", "id", "parentGoalId", "priority", "queue",
    "scheduledFor", "source", "sourceId", "sourceMeta", "sourceUrl", "status", "tags", "title", "updatedAt"
  ]);

  const root = store.add({
    title: "Fix Board Inspector",
    project: "openAGI",
    subchannel: "mac",
    threadKey: "paseo:srv_local:agi-existing",
    actor: "codex · gpt-5.4",
    labels: { kind: "bug", step: "review" }
  }, { queue: "agent", source: "supervisor" });

  assert.equal(root.sourceMeta.threadKey, "paseo:srv_local:agi-existing");
  assert.equal(root.sourceMeta.project, "openAGI");
  assert.equal(root.sourceMeta.subchannel, "mac");
  assert.deepEqual(root.tags, ["kind=bug", "step=review"]);

  const child = store.add({
    title: "Cut release v0.0.78",
    dependsOn: [root.id],
    labels: ["kind=release"]
  }, { queue: "user" });
  const grandChild = store.add({
    title: "Cut iOS build 2134",
    dependsOn: [child.id]
  }, { queue: "user" });

  assert.equal(child.status, "blocked");
  assert.equal(grandChild.status, "blocked");

  const impact = store.blockingImpactFor({ threadKey: "paseo:srv_local:agi-existing" });
  assert.equal(impact.count, 2);
  assert.deepEqual(impact.blockingTaskIds.sort(), [child.id, grandChild.id].sort());

  store.update(root.id, { labels: { step: "done" } });
  assert.deepEqual(store.get(root.id).tags, ["kind=bug", "step=done"]);

  store.complete(root.id);
  assert.equal(store.get(child.id).status, "pending");
  assert.equal(store.get(grandChild.id).status, "blocked");
  assert.equal(store.recentUnblocks.length, 1);
});

test("FleetSupervisor exposes nextTickAt, quiet nextCheckAt, blockingCount, activityEvents, and POST /fleet/api/tasks/claim", async (t) => {
  const dir = makeTempDir("openagi-board-fleet-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const nowMs = Date.parse("2026-11-19T15:00:00.000Z");
  const tasks = new TaskStore({ dataDir: dir, clock: () => nowMs });
  const mockPaseo = makeMockPaseoFactory();
  const config = resolveFleetConfig({}, {
    enabled: true,
    tickMs: 180_000,
    paseo: { enabled: true, only: true }
  });
  const supervisor = new FleetSupervisor({
    dataDir: dir,
    config,
    runtime: { tasks, events: { emit() {} } },
    deps: {
      now: () => nowMs,
      paseoFactory: mockPaseo.factory
    }
  });

  // Seed a watched snapshot row & linked downstream tasks.
  supervisor.store.recordSnapshot({
    at: "2026-11-19T14:59:00.000Z",
    mode: "propose",
    counts: { threads: 1, eligible: 1, inScope: 1, deferred: 0 },
    threads: [
      {
        key: "paseo:srv_local:agi-existing",
        kind: "paseo",
        title: "OpenAGI — board work",
        workspace: "openAGI",
        repo: "Spshulem/openAGI",
        branch: "spencer/board",
        provider: "codex",
        model: "gpt-5.4",
        cwd: "/home/dev/paseo/worktrees/openAGI/amman",
        agentStatus: "running",
        state: "running",
        health: "green",
        live: true,
        watch: { group: "working", label: "Working" },
        pr: { ref: "Spshulem/openAGI#309", state: "OPEN", ci: { state: "SUCCESS" } },
        openChat: { app: "paseo", label: "Open in Paseo", serverId: "srv_local", agentId: "agi-existing" }
      }
    ]
  });
  supervisor.store.upsertQuestion({
    dedupeKey: "ask-board-1",
    kind: "agent-ask",
    threadKey: "paseo:srv_local:agi-existing",
    prRef: "Spshulem/openAGI#309",
    title: "Approve migration?",
    body: "Should we run the board migration?",
    options: ["yes", "no"]
  });

  const existingTask = tasks.add({
    title: "Implement Inspector Drawer",
    threadKey: "paseo:srv_local:agi-existing",
    project: "openAGI",
    subchannel: "mac",
    labels: { kind: "feature" }
  }, { queue: "agent" });
  tasks.add({
    title: "Deploy notarized 0.0.78",
    dependsOn: [existingTask.id]
  }, { queue: "user" });

  const state = supervisor.getState();
  assert.ok(state.nextTickAt);
  const row = state.snapshot.threads[0];
  assert.equal(row.actorLabel, "codex · gpt-5.4 via Paseo");
  assert.equal(row.subchannel, "openagi/amman");
  assert.ok(row.nextCheckAt);
  assert.ok(row.labels.includes("state=waiting"));
  assert.ok(row.labels.includes("pr=#309"));
  assert.ok(row.labels.includes("ci=passing"));
  assert.ok(row.labels.includes("area=amman"));

  assert.equal(state.cards[0].blockingCount, 1);
  assert.match(state.cards[0].blockingSummary, /Deploy notarized 0\.0\.78/);
  assert.ok(Array.isArray(state.activityEvents) && state.activityEvents.length >= 1);

  const route = createFleetRoute({ supervisor });
  const claimRes = await route(
    "POST",
    "/fleet/api/tasks/claim",
    new URL("http://127.0.0.1/fleet/api/tasks/claim"),
    async () => ({
      title: "Build iOS Board Sheet",
      project: "openAGI",
      subchannel: "ios",
      workspace: "openAGI",
      cwd: "/home/dev/paseo/worktrees/openAGI/amman",
      labels: ["kind=feature", "step=build"]
    })
  );

  assert.equal(claimRes.status, 200);
  assert.equal(claimRes.body.task.queue, "agent");
  assert.equal(claimRes.body.task.status, "in_progress");
  assert.equal(claimRes.body.task.sourceMeta.threadKey, claimRes.body.session.key);
  assert.ok(claimRes.body.task.sourceMeta.agentLease.expiresAt);
  assert.equal(claimRes.body.task.sourceMeta.subchannel, "ios");
  assert.deepEqual(claimRes.body.task.tags, ["kind=feature", "step=build"]);
  assert.equal(mockPaseo.created.length, 1);

  assert.equal(isMobileRouteAllowed("POST", "/fleet/api/tasks/claim"), true);
  const cap = createFleetCapability(supervisor);
  const capRes = await cap.invoke("request", {
    method: "POST",
    path: "/fleet/api/tasks/claim",
    body: {
      taskId: existingTask.id,
      cwd: "/home/dev/paseo/worktrees/openAGI/amman"
    }
  });
  assert.equal(capRes.response.status, 200);
  assert.equal(capRes.response.body.task.status, "in_progress");
});

test("Watch CI on a pending PR card dismisses it from the active deck", async (t) => {
  const dir = makeTempDir("openagi-board-watchci-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const nowMs = Date.parse("2026-11-19T12:00:00.000Z");
  const supervisor = new FleetSupervisor({
    dataDir: dir,
    config: resolveFleetConfig({}, { enabled: true, mode: "propose", tickMs: 120_000 }),
    deps: {
      now: () => nowMs,
      run: async (_bin, args) => {
        if (args[0] === "pr" && args[1] === "view") {
          return {
            ok: true,
            code: 0,
            stdout: JSON.stringify({
              number: 10221,
              state: "OPEN",
              isDraft: false,
              mergeable: "MERGEABLE",
              mergeStateStatus: "BLOCKED",
              headRefOid: "abc1234",
              statusCheckRollup: [{ name: "CI", status: "IN_PROGRESS", conclusion: "" }]
            }),
            stderr: ""
          };
        }
        return { ok: true, code: 0, stdout: "", stderr: "" };
      }
    }
  });

  supervisor.store.recordSnapshot({
    at: "2026-11-19T12:00:00.000Z",
    mode: "propose",
    counts: { threads: 1, eligible: 1, inScope: 1, deferred: 0 },
    threads: [{
      key: "paseo:srv_local:agi-ci",
      kind: "paseo",
      title: "Promote durable webhooks",
      workspace: "buildbetter",
      repo: "buildbetter-app/buildbetter",
      state: "waiting",
      health: "needs_human",
      pr: { ref: "buildbetter-app/buildbetter#10221", state: "OPEN", ci: { state: "PENDING" } }
    }]
  });

  const q = supervisor.store.upsertQuestion({
    dedupeKey: "pr-pending:10221",
    threadKey: "paseo:srv_local:agi-ci",
    prRef: "buildbetter-app/buildbetter#10221",
    kind: "ci_pending",
    title: "Checks running on #10221",
    body: "Checks are still running on #10221. Tap Watch CI or wait before merging.",
    options: ["Watch CI", "Later"]
  });

  const before = supervisor.getState();
  assert.equal(before.cards.some((c) => c.questionId === q.id), true);

  const outcome = await supervisor.actCard(q.id, { op: "merge", value: "buildbetter-app/buildbetter#10221" });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, "watching_ci");

  const after = supervisor.getState();
  assert.equal(after.cards.some((c) => c.questionId === q.id), false);
});

test("POST /nodes/enroll/prompt triggers Mac pairing event with rate-limit, CSRF check, and no secret leak", async (t) => {
  const dir = makeTempDir("openagi-pair-prompt-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const runtime = createDurableRuntime({ dataDir: dir });
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1",
    port: 0,
    tickerMs: 0,
    dataDir: dir,
    authToken: "owner-secret-token-for-prompt-test"
  });
  const listened = await app.listen();
  t.after(() => app.close());

  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  const received = [];
  runtime.events.on("pair-phone-requested", (evt) => received.push(evt));

  // Cross-origin browser request must still be rejected.
  const badOrigin = await fetch(`${base}/nodes/enroll/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ deviceName: "Evil" })
  });
  assert.equal(badOrigin.status, 403);
  assert.equal(received.length, 0);

  // Native app request succeeds without auth, leaks zero secrets, emits SSE event.
  const okRes = await fetch(`${base}/nodes/enroll/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceName: "Peri" })
  });
  assert.equal(okRes.status, 200);
  const okBody = await okRes.json();
  assert.deepEqual(okBody, { ok: true, prompted: true });
  assert.equal(received.length, 1);
  assert.equal(received[0].deviceName, "Peri");

  // Immediate repeat is rate-limited.
  const limited = await fetch(`${base}/nodes/enroll/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceName: "Peri" })
  });
  assert.equal(limited.status, 429);
});
