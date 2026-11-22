import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SupervisorWalkthrough, walkthroughItems } from "../src/fleet/walkthrough.js";

function state() {
  return {
    cards: [{ id: "card-1", kind: "pr_ready", headline: "Review PR one", decisionFact: "CI is green", questionId: "q-1", threadKey: "codex:one" },
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
