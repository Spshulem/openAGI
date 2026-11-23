// "Walk me through what needs me" by voice or the typed Supervisor chat
// drives the hub's one Needs You cursor (SupervisorWalkthrough), the same
// one /fleet/api/walkthrough gives the phone and glasses. A dropped voice
// session continues by text at the same card.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "../src/tool-registry.js";
import { registerFleetTools } from "../src/fleet/tools.js";
import { SupervisorWalkthrough } from "../src/fleet/walkthrough.js";

const card = (id, extra = {}) => ({ id, questionId: `q-${id}`, kind: "agent-ask", headline: `Decide ${id}`, primaryAction: { label: "Approve" }, ...extra });
const state = () => ({ cards: [card("a"), card("b"), card("c")], questions: [], actions: [], snapshot: { threads: [] } });

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "needs-you-walk-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const supervisor = { dataDir, getState: () => state() };
  const tools = () => { const registry = new ToolRegistry(); registerFleetTools(registry, supervisor); return registry; };
  return { dataDir, supervisor, tools };
}
const step = async (registry, args) => (await registry.invoke("needs_you_walkthrough", args)).result;

test("voice and the typed chat share the hub's cursor with the phone and glasses", async (t) => {
  const { dataDir, tools } = setup(t);
  const voice = tools();
  assert.equal((await step(voice, { op: "start" })).current.id, "a");
  assert.equal((await step(voice, { op: "next", cardId: "a" })).current.id, "b");
  // Voice drops; a later typed turn builds its own registry: same position.
  assert.equal((await step(tools(), { op: "view" })).current.id, "b");
  // The phone and G2 read the same durable cursor through the route's class.
  assert.equal(new SupervisorWalkthrough({ dataDir }).read(state()).currentId, "b");
  assert.ok(fs.existsSync(path.join(dataDir, "fleet", "walkthrough.json")));
});

test("a step names the card it is about and is refused if the cursor moved", async (t) => {
  const { dataDir, tools } = setup(t);
  const voice = tools();
  await step(voice, { op: "start" });
  // Someone taps Next on the phone meanwhile.
  new SupervisorWalkthrough({ dataDir }).mutate("next", "a", state());
  const refused = await step(voice, { op: "next", cardId: "a" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "walkthrough_changed");
  assert.equal((await step(voice, { op: "view" })).current.id, "b", "nothing moved past the card the owner was not shown");
});

test("pause holds the position; next is refused until resume", async (t) => {
  const { tools } = setup(t);
  const voice = tools();
  await step(voice, { op: "start" });
  assert.equal((await step(voice, { op: "pause" })).paused, true);
  assert.equal((await step(voice, { op: "next", cardId: "a" })).code, "walkthrough_paused");
  const resumed = await step(voice, { op: "resume" });
  assert.deepEqual([resumed.paused, resumed.current.id], [false, "a"]);
  assert.equal((await step(voice, { op: "back", cardId: "a" })).current.id, "a", "back at the first item stays put");
});

test("each walkthrough item is decision-ready: goal, evidence, choices and recommendation from the card", async (t) => {
  const { walkthroughItems } = await import("../src/fleet/walkthrough.js");
  const { voiceInstructions } = await import("../src/voice/instructions.js");
  const [item] = walkthroughItems({ cards: [card("pr", {
    decisionHeadline: "Merge PR #482?",
    recommendation: "Merge: CI is green and the change is covered by tests.",
    brief: { context: "Stop emailing customers about cards that would clear on a retry.", currentState: "CI passed, 214 tests.",
             whatChanged: "Retries a declined card once after 30 seconds.", decision: "Merge PR #482 into main?" },
    primaryAction: { label: "Merge" }, secondaryAction: { label: "Not yet" }, options: ["Not yet", "Add a test first"]
  })], questions: [], snapshot: { threads: [] } });
  assert.equal(item.goal, "Stop emailing customers about cards that would clear on a retry.");
  assert.equal(item.evidence, "CI passed, 214 tests. Retries a declined card once after 30 seconds.");
  assert.equal(item.decision, "Merge PR #482 into main?");
  assert.equal(item.recommendation, "Merge: CI is green and the change is covered by tests.");
  assert.deepEqual(item.choices, ["Merge", "Not yet", "Add a test first"], "deduplicated, in the card's order");

  const [bare] = walkthroughItems({ cards: [card("bare")], questions: [], snapshot: { threads: [] } });
  assert.equal(bare.goal, null, "a missing beat stays missing rather than invented");
  assert.deepEqual(bare.choices, ["Approve"]);
  assert.match(voiceInstructions(), /goal.*evidence.*choices.*recommendation/s);
  assert.match(voiceInstructions(), /leave it out rather than guess/);
});
