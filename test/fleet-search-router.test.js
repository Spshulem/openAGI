import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { searchFleet, collectArchiveThreads, mergeThreadsWithArchives, routeCustomerIssue } from "../src/fleet/search.js";
import { RemoteFleetSupervisor } from "../src/fleet/remote.js";
import { FleetSupervisor } from "../src/fleet/supervisor.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { registerFleetTools } from "../src/fleet/tools.js";
import { PendingActionStore } from "../src/pending-actions.js";
import { ownerPrincipal } from "../src/owner-authority.js";

test("searchFleet finds BM25 matches across active snapshot and cached threads past the 60-row shortlist", () => {
  const state = {
    snapshot: {
      at: "2026-11-14T03:00:00.000Z",
      counts: { threads: 75, inScope: 60 },
      threads: [
        {
          key: "paseo:billing-1",
          kind: "paseo",
          title: "Stripe webhook 500 retry handler",
          workspace: "billing-service",
          repo: "acme/billing",
          branch: "fix/stripe-webhook-500",
          state: "running",
          health: "green",
          lastActivityAt: "2026-11-14T02:58:00.000Z",
          lastAgentText: "Added idempotency key check on invoice.payment_failed webhook retries."
        },
        {
          key: "codex:ios-2",
          kind: "codex",
          title: "Supervisor card deck animations",
          workspace: "openagi",
          repo: "Spshulem/openAGI",
          state: "waiting-ci",
          health: "green",
          pr: { ref: "Spshulem/openAGI#284", title: "Claude Duet card deck" },
          lastActivityAt: "2026-11-14T02:50:00.000Z",
          lastAgentText: "Updated SwiftUI card transitions."
        }
      ]
    },
    questions: []
  };

  // Discovered thread #68 that was truncated off the 60-row snapshot shortlist:
  const cachedThreads = new Map([
    [
      "paseo:legacy-export",
      {
        key: "paseo:legacy-export",
        kind: "paseo",
        title: "CSV export UTF-8 BOM encoding",
        workspace: "analytics",
        repo: "acme/analytics",
        branch: "fix/csv-bom",
        agentStatus: "idle",
        lastActivityAt: "2026-11-12T10:00:00.000Z",
        lastAgentText: "Fixed Excel UTF-8 BOM header on customer export downloads."
      }
    ]
  ]);

  const exact = searchFleet(state, { query: "invoice.payment_failed", limit: 10 }, cachedThreads);
  assert.equal(exact.total, 1);
  assert.equal(exact.results[0].key, "paseo:billing-1");
  assert.equal(exact.coverage.threads, 3);

  // Multi-word natural query hits off-shortlist thread #68 via BM25
  const offShortlist = searchFleet(state, { query: "customer CSV export Excel UTF-8 bug", limit: 10, natural: true }, cachedThreads);
  assert.equal(offShortlist.results[0].key, "paseo:legacy-export");
});

test("routeCustomerIssue distinguishes high-confidence active session vs ambiguous candidates vs new repo chat", async () => {
  const state = {
    snapshot: {
      at: "2026-11-14T03:00:00.000Z",
      threads: [
        {
          key: "paseo:billing-webhook",
          kind: "paseo",
          title: "Fix Stripe webhook signature & 500 retry loop",
          workspace: "billing",
          repo: "acme/billing",
          branch: "spencer/stripe-webhook-500",
          state: "running",
          health: "green",
          live: true,
          lastActivityAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          lastAgentText: "Reproduced 500 error on Stripe webhook customer.subscription.updated retries."
        },
        {
          key: "codex:docs",
          kind: "codex",
          title: "Update README installation guide",
          workspace: "docs",
          repo: "acme/docs",
          state: "done",
          health: "green",
          lastActivityAt: "2026-11-10T00:00:00.000Z",
          lastAgentText: "Updated markdown docs."
        }
      ]
    },
    questions: []
  };

  const confident = await routeCustomerIssue({
    state,
    text: "Customer hit a 500 error on Stripe webhook customer.subscription.updated retry loop in acme/billing"
  });
  assert.equal(confident.action, "auto_dispatch");
  assert.ok(confident.confidence >= 0.85, `expected >= 0.85, got ${confident.confidence}`);
  assert.equal(confident.primary.key, "paseo:billing-webhook");
  assert.match(confident.suggestedMessage, /Customer issue reported via Supervisor/);

  const unmatched = await routeCustomerIssue({
    state,
    text: "Android Bluetooth BLE pairing crashes on Pixel 9"
  });
  assert.equal(unmatched.action, "picker");
  assert.equal(unmatched.candidates.length, 0);
  assert.ok(unmatched.fallbackNewChat.label.includes("Start new Paseo"));
});

test("natural assent ('yeah, go for it') executes fleet_act_card on an owner turn even after untrusted fleet_search", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-natural-intent-"));
  try {
    let answered = null;
    const supervisor = new FleetSupervisor({ dir });
    supervisor.store.recordSnapshot({
      at: "2026-11-14T03:00:00.000Z",
      counts: { threads: 1, inScope: 1 },
      threads: [{ key: "paseo:1", kind: "paseo", title: "Auth refactor", workspace: "openagi", state: "needs-human", health: "red" }],
      sourceErrors: {}
    });
    const q = supervisor.store.upsertQuestion({
      dedupeKey: "ask:paseo:1",
      kind: "agent-ask",
      threadKey: "paseo:1",
      title: "Switch refresh token TTL to 30d?",
      body: "Ready to update token TTL.",
      options: ["yes", "no"]
    });
    supervisor.answerQuestion = async (id, option) => {
      answered = [id, option];
      return { question: { id, status: "answered", answer: option }, delivery: { status: "sent", route: "paseo" } };
    };

    const tools = new ToolRegistry();
    tools.bindPendingActions(new PendingActionStore({ dir }));
    registerFleetTools(tools, supervisor);

    const context = {
      sessionId: "devices:supervisor:main",
      __owner: ownerPrincipal("phone", "iphone-1"),
      __turn: { untrusted: false, intent: "yeah, go for it" }
    };

    // Reading fleet_search marks turn.untrusted = true
    const searchRes = await tools.invoke("fleet_search", { query: "Auth" }, context);
    assert.equal(searchRes.ok, true);
    assert.equal(context.__turn.untrusted, true);

    // Owner said "yeah, go for it" -> intentCovers("yeah, go for it", "fleet_act_card") is true -> executes WITHOUT "Say 'yes 74'"!
    const actRes = await tools.invoke("fleet_act_card", { cardId: q.id, op: "primary" }, context);
    assert.equal(actRes.ok, true);
    assert.notEqual(actRes.result?.status, "awaiting_owner_confirmation");
    assert.deepEqual(answered, [q.id, "yes"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fleet search avoids ICU property escapes so nodejs-mobile (--without-intl) parses cleanly", () => {
  for (const file of ["search.js", "cards.js", "preferences.js", "intent-resolver.js"]) {
    const source = fs.readFileSync(new URL(`../src/fleet/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\\[pP]\{/, `${file} must not use Unicode property escapes unsupported on nodejs-mobile`);
  }
  const hits = searchFleet(
    {
      snapshot: {
        threads: [
          { key: "paseo:auth-sso", title: "Cafe SSO callback redirect fix", repo: "acme/auth", state: "running" }
        ]
      }
    },
    { query: "Café sso callback" }
  );
  assert.ok(hits.results.length >= 1);
  assert.equal(hits.results[0].key, "paseo:auth-sso");
});

test("collectArchiveThreads searches Antigravity FTS5 + brain docs and links native conversationId to Paseo chat", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-archive-search-"));
  try {
    const paseoAgentsDir = path.join(fakeHome, ".paseo", "agents", "revops");
    fs.mkdirSync(paseoAgentsDir, { recursive: true });
    fs.writeFileSync(path.join(fakeHome, ".paseo", "server-id"), "srv_mac1\n");
    fs.writeFileSync(
      path.join(paseoAgentsDir, "81c55047-2f5d-4ac8-b5fa-e297caabd56c.json"),
      JSON.stringify({
        id: "81c55047-2f5d-4ac8-b5fa-e297caabd56c",
        provider: "antigravity",
        cwd: "/Users/shooby/Dev/revops",
        title: "Data Room And Metrics Dashboard Setup",
        status: "idle",
        updatedAt: "2026-11-13T03:44:07.116Z",
        labels: { handoff_source: "7a962056-4c27-48e0-82f4-c22ee00ff45b" }
      })
    );

    const agCliDir = path.join(fakeHome, ".gemini", "antigravity-cli");
    fs.mkdirSync(agCliDir, { recursive: true });
    const db = new DatabaseSync(path.join(agCliDir, "conversation_summaries.db"));
    db.exec(`
      CREATE VIRTUAL TABLE conversations_fts USING fts5(
        conversation_id UNINDEXED,
        title,
        workspace,
        last_modified_time UNINDEXED,
        user_body,
        agent_body
      );
    `);
    db.prepare(
      "INSERT INTO conversations_fts (conversation_id, title, workspace, last_modified_time, user_body, agent_body) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      "7a962056-4c27-48e0-82f4-c22ee00ff45b",
      "",
      "file:///Users/shooby/Dev/bbapp",
      "2026-11-13T03:40:00.000Z",
      "build out the growth section inside buildbetter",
      "Implemented the BuildBetter Growth operating workspace gated behind growth_workspace with Ghost, Ordinal, PEEC, YouTube, and Puzzle integrations."
    );
    db.prepare(
      "INSERT INTO conversations_fts (conversation_id, title, workspace, last_modified_time, user_body, agent_body) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      "11111111-2222-3333-4444-555555555555",
      "Unrelated Antigravity Chat",
      "file:///Users/shooby/Dev/other",
      "2026-11-14T01:00:00.000Z",
      "fix button padding",
      "Updated CSS padding on settings header."
    );
    db.close();

    const query = "which chat, i believe it was an antigravity chat, built the buildbetter growth section";
    const archives = await collectArchiveThreads({ query, homeDir: fakeHome });
    const merged = mergeThreadsWithArchives(new Map(), archives);
    const res = searchFleet({ snapshot: { threads: [] } }, { query, natural: true, limit: 10 }, merged);

    assert.ok(res.results.length >= 1, "expected FTS5 archive hit for BuildBetter Growth chat");
    assert.equal(res.results[0].key, "paseo:srv_mac1.81c55047-2f5d-4ac8-b5fa-e297caabd56c");
    assert.equal(res.results[0].title, "Data Room And Metrics Dashboard Setup");
    assert.equal(res.results[0].openChat?.app, "paseo");
    assert.equal(res.results[0].openChat?.agentId, "81c55047-2f5d-4ac8-b5fa-e297caabd56c");
    assert.match(res.results[0].snippet, /Growth/i);
    assert.ok(!res.results.some((r) => r.key.includes("11111111-2222")), "must not match unrelated chat solely on provider word");
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("RemoteFleetSupervisor falls back on legacy 0.0.72 nodes for actCard (Later/answer) and fans out searchThreads across peer fleet nodes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-remote-legacy-"));
  try {
    const dismissed = [];
    let macOpenQuestions = [
      { id: "q_legacy_1", status: "open", kind: "agent-ask", threadKey: "paseo:mac.a1", title: "Allow expiring public links?", options: ["Allow expiring public links", "Require signed-in access", "dismiss"] }
    ];
    const runtime = {
      events: { emit() {} },
      nodeCapabilities: {
        list(cap) {
          if (cap !== "fleet-supervisor") return [];
          return [
            { nodeId: "node-bb3" },
            { nodeId: "node-mac-0072" }
          ];
        },
        async dispatch(nodeId, _cap, _op, payload) {
          if (nodeId === "node-bb3") {
            if (payload.path.startsWith("/fleet/api/cards/")) {
              return {
                response: { status: 404, body: { error: "Unknown fleet route." } },
                state: { mode: "auto", questions: macOpenQuestions, actions: [], snapshot: { threads: [] } }
              };
            }
            if (payload.path === `/fleet/api/questions/q_legacy_1` && payload.body?.dismiss) {
              dismissed.push("q_legacy_1");
              macOpenQuestions = [];
              return {
                response: { status: 200, body: { question: { id: "q_legacy_1", status: "dismissed" } } },
                state: { mode: "auto", questions: [], actions: [], snapshot: { threads: [] } }
              };
            }
            if (payload.path === "/fleet/api/search") {
              return {
                response: { status: 200, body: { query: payload.body?.query, results: [{ key: "paseo:bb3.seo1", title: "SEO audit", state: "idle", snippet: "seo content" }], total: 1 } },
                state: { mode: "auto", questions: macOpenQuestions, actions: [], snapshot: { threads: [] } }
              };
            }
            return {
              response: { status: 200, body: {} },
              state: { mode: "auto", questions: macOpenQuestions, actions: [], snapshot: { threads: [] } }
            };
          }
          if (nodeId === "node-mac-0072") {
            if (payload.path === "/fleet/api/search") {
              throw new Error("Unsupported fleet request");
            }
            if (payload.path === "/fleet/api/state") {
              return {
                response: { status: 200, body: {} },
                state: {
                  mode: "observe",
                  questions: [],
                  actions: [],
                  snapshot: {
                    threads: [
                      {
                        key: "paseo:mac.growth1",
                        title: "BuildBetter Growth Workspace",
                        repo: "buildbetter",
                        state: "idle",
                        lastAgentText: "Shipped BuildBetter Growth operating workspace behind growth_workspace."
                      }
                    ]
                  }
                }
              };
            }
          }
          throw new Error("Unexpected dispatch");
        }
      }
    };

    const remote = new RemoteFleetSupervisor({ runtime, nodeId: "node-bb3", dataDir: dir });
    await remote.refresh();
    const deferRes = await remote.actCard("q_legacy_1", { op: "defer" });
    assert.equal(deferRes?.ok, true);
    assert.deepEqual(dismissed, ["q_legacy_1"]);

    const searchRes = await remote.searchThreads({ query: "buildbetter growth workspace", limit: 1 });
    assert.equal(searchRes.results.length, 1);
    assert.equal(searchRes.results[0].key, "paseo:mac.growth1", "expected higher-scoring peer Mac hit to beat primary with limit: 1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("SSH archive command is shell-safe, artifacts retain late matches past 6KB, existingOnly omits archive-only targets, and thrown Unsupported fleet request falls back", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-archive-codex-"));
  try {
    const brainDir = path.join(dir, ".gemini", "antigravity-cli", "brain", "cid_late_match_01");
    fs.mkdirSync(brainDir, { recursive: true });
    const padding = "filler line without target terms.\n".repeat(260); // > 8KB
    fs.writeFileSync(
      path.join(brainDir, "walkthrough.md"),
      `${padding}\nImplemented xylophone_telemetry_pipeline in revops.\n`,
      "utf8"
    );

    const paseoDir = path.join(dir, ".paseo");
    fs.mkdirSync(paseoDir, { recursive: true });
    fs.writeFileSync(
      path.join(paseoDir, "hosts.json"),
      JSON.stringify([{ serverId: "srv_remote_test", label: "Remote Mac", connection: "ssh://spencer-mac", enabled: true }]),
      "utf8"
    );

    let capturedRemoteCmd = null;
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const realExecFile = promisify(execFile);

    const archives = await collectArchiveThreads({
      query: "xylophone_telemetry_pipeline",
      homeDir: dir,
      includeRemotePaseoHosts: true,
      execFileImpl: async (_bin, args) => {
        // Simulate OpenSSH concatenating remote command after host and passing to /bin/sh -c
        capturedRemoteCmd = args.at(-1);
        return await realExecFile("/bin/sh", ["-c", capturedRemoteCmd], {
          env: { ...process.env, HOME: dir },
          timeout: 4000
        });
      }
    });

    assert.ok(capturedRemoteCmd && capturedRemoteCmd.startsWith("python3 -c "), "expected single shell-safe python3 bootstrap command");
    assert.ok(archives.has("antigravity:cid_late_match_01"));

    const liveMap = new Map([
      ["paseo:srv_local.live1", { key: "paseo:srv_local.live1", title: "Live chat", state: "running", live: true, lastAgentText: "working" }]
    ]);
    const dispatchMerged = mergeThreadsWithArchives(liveMap, archives, { existingOnly: true });
    assert.equal(dispatchMerged.has("antigravity:cid_late_match_01"), false, "existingOnly must exclude archive-only non-dispatchable threads");

    const fullMerged = mergeThreadsWithArchives(liveMap, archives);
    const found = searchFleet({ snapshot: { threads: [] } }, { query: "xylophone_telemetry_pipeline", natural: true }, fullMerged);
    assert.equal(found.results[0]?.key, "antigravity:cid_late_match_01");

    // Verify RemoteFleetSupervisor handles thrown 'Unsupported fleet request' (where reached=false, status=null)
    const answered = [];
    const runtime = {
      nodeCapabilities: {
        list: () => [{ nodeId: "legacy-0072" }],
        async dispatch(_nodeId, _cap, _op, payload) {
          if (payload.path.startsWith("/fleet/api/cards/") || payload.path === "/fleet/api/search") {
            throw new Error("Unsupported fleet request");
          }
          if (payload.path === "/fleet/api/questions/q_thrown_1") {
            answered.push(payload.body);
            return {
              response: { status: 200, body: { question: { id: "q_thrown_1", status: "answered" }, delivery: { status: "sent" } } },
              state: { mode: "observe", questions: [], actions: [], snapshot: { threads: [{ key: "paseo:mac.a1", title: "Expiring links", state: "idle", lastAgentText: "Allow expiring public links?" }] } }
            };
          }
          return {
            response: { status: 200, body: {} },
            state: {
              mode: "observe",
              questions: [{ id: "q_thrown_1", kind: "agent-ask", title: "Allow expiring links?", threadKey: "paseo:mac.a1", options: ["allow", "deny"] }],
              actions: [],
              snapshot: { threads: [{ key: "paseo:mac.a1", title: "Expiring links", state: "idle", lastAgentText: "Allow expiring public links?" }] }
            }
          };
        }
      }
    };
    const remote = new RemoteFleetSupervisor({ runtime, nodeId: "legacy-0072", dataDir: dir });
    const actRes = await remote.actCard("q_thrown_1", { op: "answer", value: "allow" });
    assert.equal(actRes?.ok, true);
    assert.deepEqual(answered, [{ answer: "allow" }]);
    assert.equal(remote.getState().lastError ?? null, null);

    const fallbackSearch = await remote.searchThreads({ query: "expiring public links" });
    assert.equal(fallbackSearch.results[0]?.key, "paseo:mac.a1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("collectArchiveThreads indexes linked Claude JSONL transcripts, migration.source-agent-id, PR refs, and 2-term natural queries", async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-claude-archive-"));
  try {
    const paseoAgentsDir = path.join(fakeHome, ".paseo", "agents", "bb3");
    fs.mkdirSync(paseoAgentsDir, { recursive: true });
    fs.writeFileSync(path.join(fakeHome, ".paseo", "server-id"), "srv_bb3\n");

    // 1. Migrated Antigravity -> Claude session in Paseo ("Growth workspace build — Data Room & Metrics (Antigravity)")
    const growthCwd = "/home/dev/paseo/migrated/mac/Users/shooby/Dev/revops";
    const growthSlug = "-home-dev-paseo-migrated-mac-Users-shooby-Dev-revops";
    const growthClaudeDir = path.join(fakeHome, ".claude", "projects", growthSlug);
    fs.mkdirSync(growthClaudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(paseoAgentsDir, "98ae7f6f-c6aa-4c78-88ee-7be9aaf51b26.json"),
      JSON.stringify({
        id: "98ae7f6f-c6aa-4c78-88ee-7be9aaf51b26",
        provider: "claude",
        cwd: growthCwd,
        title: "Growth workspace build — Data Room & Metrics (Antigravity)",
        status: "idle",
        updatedAt: "2026-11-14T04:00:00.000Z",
        labels: { "migration.source-agent-id": "81c55047-2f5d-4ac8-b5fa-e297caabd56c" },
        persistence: { sessionId: "b0f5cf2b-07e5-4af1-b2f1-5c97164e85b4" }
      })
    );
    fs.writeFileSync(
      path.join(growthClaudeDir, "b0f5cf2b-07e5-4af1-b2f1-5c97164e85b4.jsonl"),
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "Build out the BuildBetter growth section with Data Room and Metrics." } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Shipped the BuildBetter Growth section behind growth_workspace flag." }] } })
      ].join("\n") + "\n"
    );

    // 2. ChatGPT login session whose PR #9885 is recorded in the tail of its linked Claude transcript
    const loginCwd = "/home/dev/paseo/migrated/mac/Users/shooby/Dev/bbapp/.conductor/bilbao";
    const loginSlug = "-home-dev-paseo-migrated-mac-Users-shooby-Dev-bbapp--conductor-bilbao";
    const loginClaudeDir = path.join(fakeHome, ".claude", "projects", loginSlug);
    fs.mkdirSync(loginClaudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(paseoAgentsDir, "ccb8d08f-8a42-44e9-88b9-8140a6188137.json"),
      JSON.stringify({
        id: "ccb8d08f-8a42-44e9-88b9-8140a6188137",
        provider: "claude",
        cwd: loginCwd,
        title: "ChatGPT Credits Login Options",
        status: "idle",
        updatedAt: "2026-11-14T06:00:00.000Z",
        persistence: { sessionId: "e204e9e9-269f-42f6-aba2-c8fd367f8f0e" }
      })
    );
    const middlePadding = JSON.stringify({ type: "assistant", message: { role: "assistant", content: "working... ".repeat(400) } });
    fs.writeFileSync(
      path.join(loginClaudeDir, "e204e9e9-269f-42f6-aba2-c8fd367f8f0e.jsonl"),
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "Implement ChatGPT login options." } }),
        ...Array.from({ length: 40 }, () => middlePadding),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Opened https://github.com/buildbetter-app/buildbetter/pull/9044 first, then shipped https://github.com/buildbetter-app/buildbetter/pull/9885 for ChatGPT login." } })
      ].join("\n") + "\n"
    );

    // Query 1: full natural sentence for growth section
    const q1 = "which chat, i believe it was an antigravity chat, built the buildbetter growth section";
    const arch1 = await collectArchiveThreads({ query: q1, homeDir: fakeHome });
    const merged1 = mergeThreadsWithArchives(new Map(), arch1);
    const res1 = searchFleet({ snapshot: { threads: [] } }, { query: q1, natural: true, limit: 10 }, merged1);
    assert.ok(res1.results.length >= 1);
    assert.equal(res1.results[0].key, "paseo:srv_bb3.98ae7f6f-c6aa-4c78-88ee-7be9aaf51b26");

    // Also test 2-word natural query ("growth section") when title only has "Growth" and transcript has "section"
    const resShort = searchFleet({ snapshot: { threads: [] } }, { query: "growth section", natural: true, limit: 10 }, merged1);
    assert.equal(resShort.results[0]?.key, "paseo:srv_bb3.98ae7f6f-c6aa-4c78-88ee-7be9aaf51b26");

    // Query 2: ChatGPT login -> merges extracted PR #9885 onto live Paseo thread that had prRefs: []
    const q2 = "what about the one that shipped chatgpt login";
    const liveMap = new Map([
      ["paseo:srv_bb3.ccb8d08f-8a42-44e9-88b9-8140a6188137", {
        key: "paseo:srv_bb3.ccb8d08f-8a42-44e9-88b9-8140a6188137",
        kind: "paseo",
        title: "ChatGPT Credits Login Options",
        prRefs: [],
        lastAgentText: "Done."
      }]
    ]);
    const arch2 = await collectArchiveThreads({ query: q2, homeDir: fakeHome });
    const merged2 = mergeThreadsWithArchives(liveMap, arch2);
    const res2 = searchFleet({ snapshot: { threads: [] } }, { query: q2, natural: true, limit: 10 }, merged2);
    assert.ok(res2.results.length >= 1);
    assert.equal(res2.results[0].key, "paseo:srv_bb3.ccb8d08f-8a42-44e9-88b9-8140a6188137");
    assert.equal(res2.results[0].prRef, "buildbetter-app/buildbetter#9885");
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});
