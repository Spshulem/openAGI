// The setup wizard's connectivity test must leave no trace: no session in
// the dashboard, no auto-detected task, no memory items, no outcome record.
import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultRuntime } from "../src/index.js";
import { ChannelManager } from "../src/channels.js";

test("ephemeral turns leave no session, task, memory, or outcome", async () => {
  const runtime = createDefaultRuntime();
  const memBefore = runtime.memory.items.size;
  const outcomesBefore = runtime.outcomes.recent(100).length;

  const turn = await runtime.agentHost.handleMessage({
    from: "setup",
    text: "remind me to check this works", // would normally auto-create a task
    ephemeral: true
  });

  assert.ok(turn.reply.length > 0, "still produces a reply");
  assert.equal(runtime.agentHost.store.listSessions().length, 0, "no session persisted");
  assert.equal(runtime.tasks.list({ limit: 50 }).length, 0, "no auto-task created");
  assert.equal(runtime.memory.items.size, memBefore, "no memory written (signal or turn)");
  assert.equal(runtime.outcomes.recent(100).length, outcomesBefore, "no outcome recorded");
});

test("normal turns still persist everything", async () => {
  const runtime = createDefaultRuntime();
  await runtime.agentHost.handleMessage({ from: "user", text: "hello there agent" });
  assert.equal(runtime.agentHost.store.listSessions().length, 1);
  assert.ok(runtime.memory.items.size > 0);
});

test("ChannelManager forwards the ephemeral flag", async () => {
  const seen = [];
  const channels = new ChannelManager({ agentHost: { runtime: {}, handleMessage: async (input) => { seen.push(input); return { reply: "ok" }; } } });
  await channels.handleLocalMessage({ text: "hi", ephemeral: true });
  await channels.handleLocalMessage({ text: "hi" });
  assert.equal(seen[0].ephemeral, true);
  assert.equal(seen[1].ephemeral, false);
});
