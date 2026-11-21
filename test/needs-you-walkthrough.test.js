// "Walk me through what needs me": one Needs You card at a time, decisions
// before FYIs, with the position kept on the hub so voice and the typed
// Supervisor chat continue the same card after a dropped voice session.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "../src/tool-registry.js";
import { registerFleetTools } from "../src/fleet/tools.js";
import { Walkthrough } from "../src/fleet/walkthrough.js";

const card = (id, extra = {}) => ({
  id, questionId: id, kind: "agent-ask", headline: `Decide ${id}`, brief: `Brief for ${id}`,
  recommendation: `Recommend ${id}`, options: ["yes", "no"], primaryAction: { label: "Approve" }, ...extra
});
const deck = () => [
  card("q-merge", { kind: "pr-ready", prRef: "Spshulem/openAGI#900", headSha: "abc123" }),
  card("q-done", { kind: "completed", needsYou: false, headline: "Session finished" }),
  { id: "pref:cadence", kind: "preference", headline: "Quiet until ready?" },
  card("q-answer")
];

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "needs-you-walk-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("decisions come first, then FYIs; preference cards are not Needs You items", (t) => {
  const walk = new Walkthrough({ dir: tempDir(t) });
  const first = walk.step("start", deck());
  assert.equal(first.total, 3);
  assert.deepEqual([first.item.cardId, first.item.group], ["q-merge", "decision"]);
  assert.equal(first.item.headSha, "abc123", "exact identity, PR head included");
  assert.equal(first.item.recommendation, "Recommend q-merge");
  assert.deepEqual([walk.step("next", deck()).item.cardId, walk.step("next", deck()).item.cardId], ["q-answer", "q-done"]);
  assert.equal(walk.step("current", deck()).item.group, "fyi");
  assert.equal(walk.step("next", deck()).done, true);
});

test("next, skip, back, revisit, pause and resume keep a stable position", (t) => {
  const walk = new Walkthrough({ dir: tempDir(t) });
  walk.step("start", deck());
  assert.equal(walk.step("skip", deck()).item.cardId, "q-answer");
  assert.equal(walk.step("back", deck()).item.cardId, "q-merge");
  const paused = walk.step("pause", deck());
  assert.equal(paused.paused, true);
  assert.equal(paused.item.cardId, "q-merge", "pause does not move");
  assert.equal(walk.step("current", deck()).item.cardId, "q-merge");
  const resumed = walk.step("resume", deck());
  assert.deepEqual([resumed.paused, resumed.item.cardId], [false, "q-merge"]);
  assert.equal(walk.step("goto", deck(), { cardId: "q-done" }).item.cardId, "q-done");
  assert.match(walk.step("goto", deck(), { cardId: "nope" }).message, /not in this walkthrough/);
  assert.equal(walk.step("end", deck()).ended, true);
  assert.equal(walk.step("next", deck()).active, false, "no walkthrough after end");
});

test("the position survives a dropped voice session: a fresh reader continues at the same card", (t) => {
  const dir = tempDir(t);
  new Walkthrough({ dir }).step("start", deck());
  new Walkthrough({ dir }).step("next", deck());
  // Voice drops; the owner types in the Supervisor chat, which calls the tool anew.
  assert.equal(new Walkthrough({ dir }).step("current", deck()).item.cardId, "q-answer");
});

test("a card resolved elsewhere is reported and passed, never silently swapped", (t) => {
  const walk = new Walkthrough({ dir: tempDir(t) });
  walk.step("start", deck());
  const without = deck().filter((c) => c.id !== "q-merge");
  const now = walk.step("current", without);
  assert.deepEqual(now.resolvedSinceLastStep, ["q-merge"]);
  assert.equal(now.item.cardId, "q-answer");
  // Revisiting a resolved card says so instead of presenting another card.
  const back = walk.step("goto", without, { cardId: "q-merge" });
  assert.equal(back.item, null);
  assert.equal(back.stale.cardId, "q-merge");
});

test("a new decision that arrives mid-walk joins before the FYIs", (t) => {
  const walk = new Walkthrough({ dir: tempDir(t) });
  walk.step("start", deck());
  walk.step("next", deck());
  const later = [...deck(), card("q-new")];
  assert.equal(walk.step("next", later).item.cardId, "q-new");
  assert.equal(walk.step("next", later).item.cardId, "q-done");
});

test("needs_you_walkthrough works through the registry for voice and typed chat alike", async (t) => {
  const dir = tempDir(t);
  const supervisor = { dataDir: dir, getState: () => ({ cards: deck(), questions: [], actions: [], snapshot: { threads: [] } }) };
  const voice = new ToolRegistry();
  registerFleetTools(voice, supervisor);
  assert.equal((await voice.invoke("needs_you_walkthrough", { op: "start" })).result.item.cardId, "q-merge");
  await voice.invoke("needs_you_walkthrough", { op: "next" });
  // A separate registry, as a later text turn would build: same hub, same position.
  const text = new ToolRegistry();
  registerFleetTools(text, supervisor);
  assert.equal((await text.invoke("needs_you_walkthrough", { op: "current" })).result.item.cardId, "q-answer");
  assert.ok(fs.existsSync(path.join(dir, "fleet", "walkthrough.json")));
});
