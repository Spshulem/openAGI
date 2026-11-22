// #332 review: automatic goal continuations must honor the owner's snooze
// and must not restart a batch that is done and waiting for sign-off.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FleetSupervisor } from "../src/fleet/supervisor.js";

const NOW = Date.parse("2026-11-22T18:00:00.000Z");

function idlePaseoThread() {
  const at = new Date(NOW - 20 * 60_000).toISOString();
  return {
    key: "paseo:srv_local.sess_goal", kind: "paseo", id: "sess_goal", title: "Migration batches",
    workspace: "app", repo: "acme/app", branch: "spencer/migrate", agentStatus: "idle", archived: false, excluded: null,
    lastActivityAt: at, lastUserAt: new Date(NOW - 60 * 60_000).toISOString(), lastUserText: "Migrate all 20 tables in batches",
    lastAgentAt: at, lastAgentText: "Batch done.", lastAgentFull: "Batch done.", prRefs: [],
    meta: { serverId: "srv_local", provider: "codex", requiresAttention: true, attentionReason: "finished", historyKnown: true,
      conversation: [{ role: "user", text: "Migrate all 20 tables in batches", at: new Date(NOW - 60 * 60_000).toISOString() }, { role: "assistant", text: "Batch done.", at }] }
  };
}

async function continuationsFor(t, mutateGoal) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-cont-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const delivered = [];
  const thread = idlePaseoThread();
  const sup = new FleetSupervisor({
    dataDir: dir,
    runtime: { events: { emit() {} } },
    config: { enabled: true, mode: "auto", paseo: { enabled: true, only: true }, review: { enabled: false } },
    deps: {
      now: () => NOW,
      listPaseoThreads: async () => [thread],
      fetchPrStates: async () => new Map(),
      executor: { deliver: async (args) => { delivered.push(args); return { status: "sent", route: args.route, detail: "ok" }; }, inFlight: () => [], whenIdle: async () => {} }
    }
  });
  sup.knownThreads.set(thread.key, thread);
  sup.trackWork({ project: "app", goal: "Migrate all 20 tables", doneCriteria: "All tables migrated and verified", threadKey: thread.key, permittedNudges: "resume_owner" });
  const goal = sup.activeWork.state.items[0];
  mutateGoal(goal);
  sup.activeWork._save?.();
  await sup._tick("timer");
  return delivered.filter((d) => d.playbook === "goal-continuation");
}

test("an unfinished, unsnoozed goal still gets its automatic continuation", async (t) => {
  const sent = await continuationsFor(t, (goal) => { goal.cursor = { remaining: 10 }; });
  assert.equal(sent.length, 1);
});

test("a snoozed goal is not resumed automatically", async (t) => {
  const sent = await continuationsFor(t, (goal) => {
    goal.cursor = { remaining: 10 };
    goal.state = "snoozed";
    goal.snoozedFromState = "active";
    goal.snoozedUntil = new Date(NOW + 12 * 3_600_000).toISOString();
  });
  assert.equal(sent.length, 0);
});

test("a finished batch awaiting owner sign-off is not restarted", async (t) => {
  const zeroCursor = await continuationsFor(t, (goal) => { goal.cursor = { remaining: 0 }; goal.awaitingFollowup = true; });
  assert.equal(zeroCursor.length, 0);
});
