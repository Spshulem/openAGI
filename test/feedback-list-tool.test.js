import test from "node:test";
import assert from "node:assert/strict";
import { registerVoiceTools } from "../src/fleet/voice-tools.js";
import { ToolRegistry } from "../src/tool-registry.js";

test("feedback_list shows the owner's feedback, newest first, read-only and filterable by status", async () => {
  const records = [
    { id: "fb_2", at: "2026-11-21T01:48:14.693Z", status: "new", intent: "fix", source: "text", target: { view: "fleet" }, utterance: "Bug: the send to my own session was blocked" },
    { id: "fb_1", at: "2026-11-20T23:08:28.341Z", status: "pr-open", intent: "fix", source: "text", target: { view: "fleet" }, utterance: "x".repeat(400) }
  ];
  const supervisor = { getState: () => ({ questions: [], actions: [], snapshot: null }), feedback: async () => records, recordFeedback: async () => { throw new Error("must not write"); } };
  const registry = new ToolRegistry();
  registerVoiceTools(registry, supervisor);
  assert.equal(registry.get("feedback_list").sideEffects, false);
  const all = await registry.invoke("feedback_list", {});
  assert.equal(all.ok, true);
  assert.deepEqual(all.result.feedback.map((item) => item.id), ["fb_2", "fb_1"]);
  assert.equal(all.result.feedback[1].said.length, 160, "only the first words");
  const open = await registry.invoke("feedback_list", { status: "new" });
  assert.deepEqual(open.result.feedback.map((item) => item.id), ["fb_2"]);
  assert.equal(open.result.total, 1);
});
