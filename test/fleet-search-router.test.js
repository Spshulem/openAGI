import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { searchFleet, routeCustomerIssue } from "../src/fleet/search.js";
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
