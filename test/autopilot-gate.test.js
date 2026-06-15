// Autopilot must not spend a base-model call when there's no committed agent
// work. The queue-draining pulse opts in via input.requireQueuedWork; scheduled
// review prompts leave it off and run unconditionally.
import test from "node:test";
import assert from "node:assert/strict";
import { AbiRuntime } from "../src/abi-runtime.js";

const runAutopilot = AbiRuntime.prototype.runAutopilot;

function ctx({ next }) {
  const state = { called: false };
  const self = {
    agentHost: { handleMessage: async () => { state.called = true; return { reply: "worked" }; } },
    budget: { check() {} },
    tasks: { agentPickNext: () => next }
  };
  return { self, state };
}

test("gated pulse skips with NO model call when the agent queue is empty", async () => {
  const { self, state } = ctx({ next: null });
  const r = await runAutopilot.call(self, { id: "agent-pulse", input: { requireQueuedWork: true, prompt: "x" } });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, "no queued agent work");
  assert.equal(state.called, false, "model must NOT be invoked on an empty queue");
});

test("gated pulse runs when there IS queued agent work", async () => {
  const { self, state } = ctx({ next: { id: "task_1", title: "do the thing" } });
  const r = await runAutopilot.call(self, { id: "agent-pulse", input: { requireQueuedWork: true, prompt: "x" } });
  assert.equal(state.called, true);
  assert.equal(r.autopilot, true);
});

test("un-gated autopilot (scheduled review) runs unconditionally", async () => {
  const { self, state } = ctx({ next: null });
  await runAutopilot.call(self, { id: "weekly-harsh-review", input: { prompt: "review" } });
  assert.equal(state.called, true, "review prompt without requireQueuedWork still runs");
});
