import assert from "node:assert/strict";
import test from "node:test";
import { MemorySystem } from "../src/memory-system.js";
import { ToolRegistry, registerCoreTools } from "../src/index.js";

const seed = (memory, scope, content = "Atlas meeting is at three", tags = []) => memory.remember(
  { content, scope, tags, source: "test" }, { tier: "medium", strength: 0.8 }
);

test("specialist query corrections preserve shared facts and supersede only their own facts", () => {
  const memory = new MemorySystem();
  const shared = seed(memory, "main");
  const peer = seed(memory, "specialist:peer");
  const own = seed(memory, "specialist:planner");
  const { item, superseded } = memory.correct({
    scope: "specialist:planner", query: "Atlas meeting", content: "Atlas meeting is at four"
  });
  assert.deepEqual(superseded.map(x => x.id), [own.id]);
  assert.equal(item.scope, "specialist:planner");
  assert.equal(shared.metadata.supersededBy, undefined);
  assert.equal(peer.metadata.supersededBy, undefined);
  assert.ok(memory.retrieve("Atlas meeting", { scope: "main" }).some(x => x.item.id === shared.id));
});

test("shared matches cannot crowd private targets out of query correction ranking", () => {
  const memory = new MemorySystem();
  for (let i = 0; i < 7; i++) seed(memory, "main", `Atlas meeting is at three ${i}`);
  const own = seed(memory, "specialist:planner", "Atlas planning meeting schedule with extra details");
  const { superseded } = memory.correct({
    scope: "specialist:planner", query: "Atlas meeting", content: "Atlas meeting is at four"
  });
  assert.deepEqual(superseded.map(x => x.id), [own.id]);
});

test("explicit IDs cannot cross correction scopes or leak target tags", () => {
  for (const [caller, target] of [["main", "specialist:peer"], ["specialist:planner", "main"], ["specialist:planner", "specialist:peer"]]) {
    const memory = new MemorySystem();
    const stale = seed(memory, target, "Atlas meeting is at three", ["restricted-tag"]);
    const before = JSON.stringify([...memory.items]);
    assert.throws(() => memory.correct({ id: stale.id, scope: caller, content: "Updated fact" }), /scope/i);
    assert.equal(JSON.stringify([...memory.items]), before, "rejected correction has no side effects");
  }
});

test("legacy unscoped facts belong to main for correction writes", () => {
  const memory = new MemorySystem();
  const stale = seed(memory, "main");
  delete stale.scope;
  const privateResult = memory.correct({ scope: "specialist:planner", query: "Atlas meeting", content: "Private schedule" });
  assert.equal(privateResult.superseded.length, 0);
  const sharedResult = memory.correct({ id: stale.id, content: "Atlas meeting moved" });
  assert.deepEqual(sharedResult.superseded.map(x => x.id), [stale.id]);
});

test("correct_memory tool rejects a recalled shared ID without exposing or superseding it", async () => {
  const memory = new MemorySystem();
  const shared = seed(memory, "main");
  const tools = new ToolRegistry();
  registerCoreTools(tools, { memory });
  const recalled = await tools.invoke("recall", { query: "Atlas meeting" }, { agentId: "planner" });
  assert.ok(recalled.result.items.some(x => x.id === shared.id), "shared reads stay available");
  const result = await tools.invoke("correct_memory", { id: shared.id, correction: "Atlas meeting moved" }, { agentId: "planner" });
  assert.equal(result.ok, false);
  assert.equal(shared.metadata.supersededBy, undefined);
  assert.equal(memory.items.size, 1);
});
