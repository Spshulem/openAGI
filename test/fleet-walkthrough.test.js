import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SupervisorWalkthrough, walkthroughItems } from "../src/fleet/walkthrough.js";

function state() {
  return {
    cards: [{ id: "card-1", kind: "pr_ready", headline: "Review PR one", decisionFact: "CI is green", questionId: "q-1", threadKey: "codex:one", prRef: "acme/api#1", ciState: "passing", primaryAction: { label: "Merge PR" } },
      { id: "card-2", kind: "blocked", headline: "Agent is blocked", decisionFact: "Needs a choice", threadKey: "claude:two" }],
    questions: [{ id: "q-1", title: "Duplicate card question", body: "Should not appear twice", threadKey: "codex:one" },
      { id: "q-3", title: "Choose a route", body: "The agent is waiting", threadKey: "codex:three" }]
  };
}

test("walkthrough builds stable card/question identities without duplicates", () => {
  const items = walkthroughItems(state());
  assert.deepEqual(items.map(item => item.id), ["card-1", "card-2", "q-3"]);
  assert.equal(items[0].questionId, "q-1");
  assert.equal(items[1].cardId, "card-2");
  assert.equal(items[0].primaryLabel, "Merge PR");
  assert.equal(items[0].prRef, "acme/api#1");
  assert.equal(items[0].ciState, "passing");
});

test("walkthrough persists start, next, skip, back and pause/resume cursor", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-walkthrough-"));
  const walkthrough = new SupervisorWalkthrough({ dataDir: dir, now: () => 1_700_000_000_000 });
  assert.equal(walkthrough.mutate("start", undefined, state()).currentId, "card-1");
  assert.equal(walkthrough.mutate("next", "card-1", state()).currentId, "card-2");
  assert.equal(walkthrough.mutate("skip", "card-2", state()).currentId, "q-3");
  assert.equal(walkthrough.mutate("back", "q-3", state()).currentId, "card-2");
  assert.equal(walkthrough.mutate("pause", "card-2", state()).paused, true);
  assert.throws(() => walkthrough.mutate("next", "card-2", state()), /Resume/);
  assert.equal(walkthrough.mutate("resume", "card-2", state()).paused, false);
  const restored = new SupervisorWalkthrough({ dataDir: dir });
  assert.equal(restored.read(state()).currentId, "card-2");
});

test("walkthrough refuses stale card identity before navigation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-walkthrough-"));
  const walkthrough = new SupervisorWalkthrough({ dataDir: dir });
  walkthrough.mutate("start", undefined, state());
  assert.throws(() => walkthrough.mutate("next", "card-2", state()), /changed/);
});

test("walkthrough instances share the durable cursor and omit resolved cards/questions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-walkthrough-shared-"));
  const supervisorState = {
    cards: [
      { id: "resolved-card", needsYou: false, questionId: "resolved-q", title: "Done", summary: "Already handled" },
      { id: "live-card", needsYou: true, questionId: "live-q", title: "Review", summary: "Needs you" }
    ],
    questions: [
      { id: "resolved-q", title: "Resolved", body: "Already handled" },
      { id: "live-q", title: "Live", body: "Needs you" }
    ]
  };
  const first = new SupervisorWalkthrough({ dataDir: dir });
  const second = new SupervisorWalkthrough({ dataDir: dir });
  assert.deepEqual(walkthroughItems(supervisorState).map(item => item.id), ["live-card"]);
  assert.equal(first.mutate("start", undefined, supervisorState).currentId, "live-card");
  assert.equal(second.read(supervisorState).currentId, "live-card");
});

test("walkthrough omits questions whose deck predicates are no longer live", () => {
  const supervisorState = {
    cards: [],
    preferences: { cadence: "quiet_until_ready" },
    snapshot: { threads: [
      { key: "codex:merged", pr: { ref: "acme/api#1", state: "MERGED" } },
      { key: "codex:running", agentStatus: "running", lastAgentAt: "2026-01-01T00:05:00Z" }
    ] },
    questions: [
      { id: "merged", status: "open", kind: "ready", prRef: "acme/api#1", threadKey: "codex:merged", title: "Merge?", options: ["Merge"] },
      { id: "quiet", status: "open", kind: "idle-report", threadKey: "codex:idle", title: "Still waiting?", options: ["Continue"] },
      { id: "superseded", status: "open", kind: "agent-ask", threadKey: "codex:running", createdAt: "2026-01-01T00:00:00Z", title: "Old ask", options: ["Retry"] },
      { id: "live", status: "open", kind: "prompt", title: "Choose", options: ["Answer question", "Review plan", "Yes"] }
    ]
  };
  const items = walkthroughItems(supervisorState);
  assert.deepEqual(items.map(item => item.id), ["live"]);
  assert.deepEqual(items[0].options, ["Yes"]);
});
