import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { G2Channel } from "../src/integrations/g2-channel.js";
import { InMemoryAgentStore } from "../src/agent-store.js";
import { NodeRegistry } from "../src/node-registry.js";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { isPublicRoute } from "../src/auth.js";

test("experience requires live G2 credentials even without owner auth", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "g2-experience-"));
  const nodeRegistry = new NodeRegistry({ dir: path.join(dataDir, "nodes") });
  const id = randomUUID(), token = "g".repeat(43), other = randomUUID();
  nodeRegistry.enroll(id, token, { platform: "even_g2" });
  nodeRegistry.enroll(other, "n".repeat(43), { platform: "openagi" });
  let turns = 0;
  const channel = new G2Channel({ dir: path.join(dataDir, "g2"), nodeRegistry, apiKey: "", deepgramApiKey: "",
    agentHost: { handleMessage: async input => { turns++; return { reply: "hi", session: { id: input.sessionId } }; }, store: new InMemoryAgentStore() } });
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { dataDir, port: 0, authToken: "", nodeRegistry,
    channels: { g2: channel, start() {}, stop() {}, status: () => ({}) } });
  const { url } = await app.listen();
  t.after(async () => { await app.close(); await runtime.observations?.close?.(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const post = (body, headers = {}) => fetch(`${url}/nodes/g2/experience`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal(isPublicRoute("/nodes/g2/experience"), false);
  assert.equal((await post({ op: "capabilities" })).status, 401);
  assert.equal((await post({ op: "capabilities" }, { authorization: "Bearer owner" })).status, 401);
  assert.equal((await post({ op: "capabilities" }, { authorization: `Bearer ${"n".repeat(43)}`, "x-openagi-node-id": other })).status, 403);
  const headers = { authorization: `Bearer ${token}`, origin: "null" };
  const ready = await post({ op: "capabilities" }, headers);
  assert.equal(ready.status, 200); assert.equal(ready.headers.get("access-control-allow-origin"), "*");
  assert.equal((await ready.json()).protocol, 1); assert.equal(turns, 0);
  assert.equal((await post({ op: "capabilities", nodeId: other }, headers)).status, 400);
  assert.ok([401, 403].includes((await post({ op: "capabilities" }, { ...headers, "x-openagi-node-id": other })).status));
  assert.equal((await fetch(`${url}/nodes/g2/experience`, { method: "OPTIONS" })).status, 204);
  assert.equal((await post({ op: "history" }, headers)).status, 200); assert.equal(turns, 0);
  const requestId = `${Date.now()}_${randomUUID()}`;
  const body = { op: "submit", id: requestId, question: { text: "hello", conversationId: randomUUID() } };
  assert.equal((await post(body, headers)).status, 202);
  assert.equal((await post(body, headers)).status, 202); assert.equal(turns, 1);
  assert.equal((await (await post({ op: "get", id: requestId }, headers)).json()).state, "completed");
  nodeRegistry.revoke(id);
  assert.ok([401, 403].includes((await post({ op: "get", id: requestId }, headers)).status));
});

test("history continues legacy sessions exactly and redacts private metadata", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "g2-history-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new InMemoryAgentStore(), inputs = [];
  const channel = new G2Channel({ dir, nodeRegistry: { enrollment: () => ({ platform: "even_g2" }) },
    agentHost: { store, handleMessage: async input => { inputs.push(input); store.appendMessage(input.sessionId, { ...input, role: "user", content: input.text }); return { reply: "reply", session: { id: input.sessionId } }; } } });
  const legacyId = channel.sessionIdFor("node-a", "old-conversation");
  store.appendMessage(legacyId, { role: "user", channel: "g2", content: "old question", metadata: { sourceNodeId: "node-a", secret: "private" } });
  store.appendMessage(legacyId, { role: "tool", content: "secret arguments" });
  store.appendMessage("owner-session", { role: "user", content: "private owner" });
  const history = channel.history("node-a"); assert.equal(history.conversations.length, 1);
  const continuation = history.conversations[0].continuation;
  const read = channel.history("node-a", { continuation });
  assert.equal(read.messages.length, 1); assert.equal(JSON.stringify(read).includes("private"), false);
  await channel.ask({ text: "follow-up", conversationId: randomUUID() }, "node-a", { continuation });
  assert.equal(inputs[0].sessionId, legacyId);
  assert.throws(() => channel.sessionIdFor("node-b", "new", continuation), { status: 403 });
  assert.throws(() => channel.sessionIdFor("node-a", "new", "g2:owner-session"), { status: 403 });
});

test("bounded session listing selects newest conversations before applying its limit", () => {
  const store = new InMemoryAgentStore();
  for (let i = 0; i < 5; i++) store.sessions.set(`g2-test-${i}`, { id: `g2-test-${i}`, updatedAt: `2026-09-0${i + 1}`, messages: [] });
  assert.deepEqual(store.listSessions({ prefix: "g2-test-", limit: 2 }).map(s => s.id), ["g2-test-4", "g2-test-3"]);
});

test("damaged recovery storage does not prevent main startup or erase receipts", async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "g2-storage-fault-"));
  const receipts = path.join(dataDir, "g2-requests"); fs.mkdirSync(receipts);
  const file = path.join(receipts, `${"a".repeat(64)}.json`); fs.writeFileSync(file, "not json");
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { dataDir, port: 0, authToken: "",
    channels: { g2: {}, start() {}, stop() {}, status: () => ({}) } });
  t.after(async () => { await app.close(); await runtime.observations?.close?.(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const { url } = await app.listen();
  assert.equal((await fetch(url)).status, 200);
  assert.equal(fs.readFileSync(file, "utf8"), "not json");
});
