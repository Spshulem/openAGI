// Shared device threads: every paired phone and G2 talks in one fixed session
// per thread, reads it back through one history projection, and hears about
// new turns on /events. Exercised through the real hosted-interface gates.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { NodeRegistry } from "../src/node-registry.js";
import { FileBackedAgentStore, InMemoryAgentStore } from "../src/agent-store.js";
import { lifelogMoments, observeSharedThreads, sharedThreadHistory } from "../src/shared-conversations.js";

const OWNER = "shared-owner-token";
const PHONE_A = { id: `mobile:${randomUUID()}`, token: "a".repeat(43), name: "Pixel" };
const PHONE_B = { id: `mobile:${randomUUID()}`, token: "b".repeat(43), name: "iPhone" };
const G2 = { id: randomUUID(), token: "g".repeat(43), name: "Glasses" };
const GENERIC = { id: "node-generic", token: "n".repeat(43), name: "Bridge" };

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function boot(t, { generate, proactiveState } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-shared-threads-"));
  if (proactiveState) {
    fs.mkdirSync(path.join(dataDir, "g2-proactive"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "g2-proactive", "state.json"), JSON.stringify(proactiveState));
  }
  const inputs = [];
  const modelProvider = {
    isConfigured: () => true,
    async generate(request) {
      inputs.push(request);
      const text = generate ? await generate(request) : `echo: ${request.input}`;
      return { text, provider: "test", model: "test-model", toolCalls: [] };
    }
  };
  const runtime = createDurableRuntime({ dataDir, modelProvider, registerDefaults: false, integrations: false, skills: false, autoConnectMcp: false });
  const nodeRegistry = new NodeRegistry({ dir: path.join(dataDir, "nodes") });
  nodeRegistry.enroll(PHONE_A.id, PHONE_A.token, { platform: "mobile", name: PHONE_A.name });
  nodeRegistry.enroll(PHONE_B.id, PHONE_B.token, { platform: "mobile", name: PHONE_B.name });
  nodeRegistry.enroll(G2.id, G2.token, { platform: "even_g2", name: G2.name });
  nodeRegistry.enroll(GENERIC.id, GENERIC.token, { platform: "openagi", name: GENERIC.name });
  const app = createHostedInterface(runtime, { dataDir, host: "127.0.0.1", port: 0, authToken: OWNER, tickerMs: 0, nodeControlEnabled: false, nodeRegistry });
  const { url } = await app.listen();
  t.after(async () => {
    await app.close();
    runtime.observations?.db?.close();
    runtime.vectorStore?.db?.close();
    runtime.sessionIndex?.db?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const as = (node, route, { method = "GET", body } = {}) => fetch(url + route, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${node.token}`, "x-openagi-node-id": node.id },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const asOwner = (route) => fetch(url + route, { headers: { authorization: `Bearer ${OWNER}` } });
  return { url, runtime, inputs, as, asOwner, store: runtime.agentHost.store };
}

async function g2Submit(ctx, text, extra = {}) {
  const id = `${Date.now()}_${randomUUID()}`;
  const submitted = await ctx.as(G2, "/nodes/g2/experience", { method: "POST", body: { op: "submit", id, question: { text }, ...extra } });
  assert.equal(submitted.status, 202, await submitted.clone().text());
  for (let i = 0; i < 200; i++) {
    const record = await (await ctx.as(G2, "/nodes/g2/experience", { method: "POST", body: { op: "get", id } })).json();
    if (!["accepted", "working"].includes(record.state)) return record;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("G2 request never finished");
}

test("two phones and a G2 land in the same shared agent session", async (t) => {
  const ctx = await boot(t);
  const first = await ctx.as(PHONE_A, "/message", { method: "POST", body: { text: "from the pixel", thread: "agent" } });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).session.id, "devices:agent:main");
  const second = await ctx.as(PHONE_B, "/message", { method: "POST", body: { text: "from the iphone", thread: "agent", from: "anything", sessionId: "local:user:main" } });
  assert.equal((await second.json()).session.id, "devices:agent:main");
  const g2 = await g2Submit(ctx, "from the glasses", { thread: "agent" });
  assert.equal(g2.state, "completed");
  assert.equal(g2.sessionId, "devices:agent:main");

  const users = ctx.store.getSession("devices:agent:main").messages.filter((m) => m.role === "user");
  assert.deepEqual(users.map((m) => [m.content, m.channel, m.metadata.sourceNodeId, m.metadata.sourceName]), [
    ["from the pixel", "node", PHONE_A.id, "Pixel"],
    ["from the iphone", "node", PHONE_B.id, "iPhone"],
    ["from the glasses", "g2", G2.id, "Glasses"]
  ]);
  // The model sees one conversation: the third turn carries the first two.
  assert.ok(ctx.inputs[2].messages.some((m) => m.content === "from the pixel"));
  // The supervisor thread is its own session, and nothing reached the owner's chat.
  const supervisor = await ctx.as(PHONE_A, "/message", { method: "POST", body: { text: "fleet?", thread: "supervisor" } });
  assert.equal((await supervisor.json()).session.id, "devices:supervisor:main");
  assert.equal(ctx.store.getSession("local:user:main").messages.length, 0);
});

test("without a thread a phone message stays node-scoped exactly as before", async (t) => {
  const ctx = await boot(t);
  const nodeNamespace = createHash("sha256").update(PHONE_A.id, "utf8").digest("base64url");
  const cli = createHash("sha256").update("cli", "utf8").digest("base64url");
  const plain = await (await ctx.as(PHONE_A, "/message", { method: "POST", body: { text: "hi" } })).json();
  assert.equal(plain.session.id, `node:${nodeNamespace}:${cli}:main`);
  const stored = ctx.store.getSession(plain.session.id).messages[0];
  assert.deepEqual(stored.metadata, { sourceNodeId: PHONE_A.id });
  assert.equal(ctx.store.getSession("devices:agent:main").messages.length, 0);
});

test("thread is validated and reserved for paired phones", async (t) => {
  const ctx = await boot(t);
  assert.equal((await ctx.as(PHONE_A, "/message", { method: "POST", body: { text: "x", thread: "owner" } })).status, 400);
  assert.equal((await ctx.as(PHONE_A, "/message", { method: "POST", body: { text: "x", thread: null } })).status, 400);
  assert.equal((await ctx.as(GENERIC, "/message", { method: "POST", body: { text: "x", thread: "agent" } })).status, 403);
  assert.equal(ctx.inputs.length, 0);
});

test("a shared thread never inherits the owner's computer-use lease", async (t) => {
  const ctx = await boot(t);
  ctx.runtime.computerUseLog.startSession({ goal: "Owner-approved work", approvedBy: "user", approvalActionId: "act_owner", sourceSessionId: "local:user:main" });
  const reply = await (await ctx.as(PHONE_A, "/message", { method: "POST", body: { text: "use the owner chat", thread: "agent", sessionId: "local:user:main", from: "user" } })).json();
  assert.equal(reply.session.id, "devices:agent:main");
  assert.equal(ctx.runtime.computerUseLog.activeSessionFor("devices:agent:main"), null);
  assert.ok(ctx.runtime.computerUseLog.activeSessionFor("local:user:main"));
});

test("concurrent sends to one shared thread run one turn at a time", async (t) => {
  const gates = [deferred(), deferred()];
  let active = 0, maxActive = 0, call = 0;
  const ctx = await boot(t, {
    async generate(request) {
      const gate = gates[call++];
      active++; maxActive = Math.max(maxActive, active);
      await gate.promise;
      active--;
      return `reply to ${request.input}`;
    }
  });
  const a = ctx.as(PHONE_A, "/message", { method: "POST", body: { text: "first", thread: "agent" } });
  while (call < 1) await new Promise((r) => setTimeout(r, 5));
  const b = ctx.as(PHONE_B, "/message", { method: "POST", body: { text: "second", thread: "agent" } });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(call, 1, "the second turn waits for the first");
  gates[0].resolve(); gates[1].resolve();
  await Promise.all([a, b]);
  assert.equal(maxActive, 1);
  assert.deepEqual(ctx.store.getSession("devices:agent:main").messages.map((m) => `${m.role}:${m.content}`),
    ["user:first", "assistant:reply to first", "user:second", "assistant:reply to second"]);
});

test("history pages oldest-first with before/limit and projects text only", async (t) => {
  const ctx = await boot(t);
  for (const text of ["one", "two", "three"]) await ctx.as(PHONE_A, "/message", { method: "POST", body: { text, thread: "agent" } });
  ctx.store.appendMessage("devices:agent:main", { role: "tool", content: "secret tool result", channel: "node" });
  const latest = await ctx.as(PHONE_B, "/conversations/agent/messages?limit=4");
  assert.equal(latest.status, 200);
  assert.equal(latest.headers.get("cache-control"), "no-store");
  const page = await latest.json();
  assert.equal(page.thread, "agent");
  assert.deepEqual(page.messages.map((m) => m.text), ["two", "echo: two", "three", "echo: three"]);
  assert.deepEqual(Object.keys(page.messages[0]).sort(), ["at", "id", "role", "sourceName", "sourceNodeId", "text"]);
  assert.equal(page.messages[0].sourceNodeId, PHONE_A.id);
  assert.equal(page.messages[0].sourceName, "Pixel");
  assert.equal(page.messages[1].sourceNodeId, null);
  assert.equal(JSON.stringify(page).includes("secret"), false);
  assert.equal(page.nextBefore, page.messages[0].id);
  const older = await (await ctx.as(PHONE_B, `/conversations/agent/messages?before=${page.nextBefore}&limit=4`)).json();
  assert.deepEqual(older.messages.map((m) => m.text), ["one", "echo: one"]);
  assert.equal(older.nextBefore, null);
  const all = await (await ctx.asOwner("/conversations/agent/messages")).json();
  assert.equal(all.messages.length, 6);
  const empty = await (await ctx.as(PHONE_A, "/conversations/supervisor/messages")).json();
  assert.deepEqual(empty, { thread: "supervisor", messages: [], nextBefore: null });
  for (const query of ["limit=0", "limit=101", "limit=x", "before=../x"]) {
    assert.equal((await ctx.as(PHONE_A, `/conversations/agent/messages?${query}`)).status, 400, query);
  }
  assert.equal((await ctx.as(PHONE_A, "/conversations/agent/messages?before=msg_gone")).status, 404);
});

test("history is for the owner, paired phones and G2s only", async (t) => {
  const ctx = await boot(t);
  assert.equal((await ctx.as(PHONE_A, "/conversations/agent/messages")).status, 200);
  assert.equal((await ctx.as(G2, "/conversations/agent/messages")).status, 200);
  assert.equal((await ctx.asOwner("/conversations/agent/messages")).status, 200);
  assert.equal((await ctx.as(GENERIC, "/conversations/agent/messages")).status, 403);
  const unpaired = { id: `mobile:${randomUUID()}`, token: "u".repeat(43) };
  assert.equal((await ctx.as(unpaired, "/conversations/agent/messages")).status, 401);
  assert.equal((await ctx.as({ ...PHONE_A, token: "z".repeat(43) }, "/conversations/agent/messages")).status, 401);
  assert.equal((await fetch(`${ctx.url}/conversations/agent/messages`)).status, 401);
  // The owner-only session list stays closed to a phone.
  assert.equal((await ctx.as(PHONE_A, "/sessions")).status, 401);
});

test("G2 history reads the shared thread in the same shape", async (t) => {
  const ctx = await boot(t);
  await ctx.as(PHONE_A, "/message", { method: "POST", body: { text: "phone first", thread: "agent" } });
  assert.equal((await g2Submit(ctx, "glasses second", { question: { text: "glasses second", thread: "agent" } })).state, "completed");
  const history = await (await ctx.as(G2, "/nodes/g2/experience", { method: "POST", body: { op: "history", thread: "agent", limit: 3 } })).json();
  assert.deepEqual(Object.keys(history).sort(), ["messages", "nextBefore", "thread"]);
  assert.deepEqual(history.messages.map((m) => [m.role, m.sourceName]), [["assistant", null], ["user", "Glasses"], ["assistant", null]]);
  assert.equal(history.messages[1].text, "glasses second");
  assert.ok(history.nextBefore);
  const bad = await ctx.as(G2, "/nodes/g2/experience", { method: "POST", body: { op: "history", thread: "agent", continuation: "g2:x" } });
  assert.equal(bad.status, 400);
  const badThread = await ctx.as(G2, "/nodes/g2/experience", { method: "POST", body: { op: "history", thread: "owner" } });
  assert.equal(badThread.status, 400);
});

test("G2 submit rejects a thread that conflicts or is combined with a private continuation", async (t) => {
  const ctx = await boot(t);
  const post = (body) => ctx.as(G2, "/nodes/g2/experience", { method: "POST", body: { op: "submit", id: `${Date.now()}_${randomUUID()}`, ...body } });
  assert.equal((await post({ thread: "agent", question: { text: "x", thread: "supervisor" } })).status, 400);
  assert.equal((await post({ question: { text: "x", thread: "owner" } })).status, 400);
  assert.equal((await post({ question: { text: "x", thread: "agent", continuation: "g2:node:x:main" } })).status, 400);
  // Without a thread the private conversation id is still required.
  assert.equal((await post({ question: { text: "x" } })).status, 400);
  assert.equal(ctx.inputs.length, 0);
});

test("conversation.updated reaches /events after each stored message", async (t) => {
  const ctx = await boot(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const events = await fetch(`${ctx.url}/events`, { headers: { authorization: `Bearer ${PHONE_B.token}`, "x-openagi-node-id": PHONE_B.id }, signal: controller.signal });
  assert.equal(events.status, 200);
  const reader = events.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames = [];
  const readUntil = async (count) => {
    while (frames.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        const event = block.split("\n").find((line) => line.startsWith("event: "))?.slice(7);
        const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        if (event === "conversation.updated") frames.push(JSON.parse(data));
      }
    }
  };
  await ctx.as(PHONE_A, "/message", { method: "POST", body: { text: "hello", thread: "agent" } });
  await ctx.as(PHONE_A, "/message", { method: "POST", body: { text: "not shared" } });
  await readUntil(2);
  const stored = ctx.store.getSession("devices:agent:main").messages;
  assert.deepEqual(frames, [
    { thread: "agent", messageId: stored[0].id },
    { thread: "agent", messageId: stored[1].id }
  ]);
});

test("observeSharedThreads ignores other sessions and unwraps cleanly", () => {
  const store = new InMemoryAgentStore();
  const seen = [];
  const unobserve = observeSharedThreads(store, (data) => seen.push(data));
  store.appendMessage("local:user:main", { role: "user", content: "owner" });
  const session = store.appendMessage("devices:supervisor:main", { role: "user", content: "shared" });
  assert.deepEqual(seen, [{ thread: "supervisor", messageId: session.messages[0].id }]);
  unobserve();
  store.appendMessage("devices:supervisor:main", { role: "user", content: "after" });
  assert.equal(seen.length, 1);
  assert.throws(() => sharedThreadHistory(store, "owner"), { status: 400 });
});

test("shared history pages back through messages the store has archived", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-shared-archive-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new FileBackedAgentStore({ dir, ensureDefault: false, maxActiveMessages: 4, retainedMessages: 2 });
  for (let i = 0; i < 11; i++) store.appendMessage("devices:agent:main", { role: i % 2 ? "assistant" : "user", content: `m${i}` });
  assert.equal(store.getSession("devices:agent:main").messages.length < 11, true);
  const texts = [];
  let page = sharedThreadHistory(store, "agent", { limit: 3 });
  texts.unshift(...page.messages.map(m => m.text));
  while (page.nextBefore) {
    page = sharedThreadHistory(store, "agent", { before: page.nextBefore, limit: 3 });
    texts.unshift(...page.messages.map(m => m.text));
  }
  assert.deepEqual(texts, Array.from({ length: 11 }, (_, i) => `m${i}`));
  const all = sharedThreadHistory(store, "agent", { limit: 100 });
  assert.equal(all.messages.length, 11);
  assert.equal(all.nextBefore, null);
  const oldest = sharedThreadHistory(store, "agent", { before: all.messages[1].id, limit: 5 });
  assert.deepEqual(oldest.messages.map(m => m.text), ["m0"]);
});

function proactiveState(now) {
  const key = createHash("sha256").update(G2.id).digest("hex");
  const settings = { enabled: false, categories: [], retentionDays: 30, quietStart: 22, quietEnd: 8, timeZone: "UTC", maxPerHour: 3, supervisorOnly: false };
  const segment = (id, text, at) => ({ id, text, at, endAt: at + 1000, captureSession: "consent:stream", source: "g2", speakerKey: "consent:stream:0", speakerVerified: false });
  return {
    version: 1,
    nodes: {
      [key]: {
        settings, candidates: [], marks: {}, batches: [], consent: null, lastBatchAt: 0,
        segments: [
          segment("seg-old-1", "We decided to ship the widget on Friday.", now - 3 * 3600_000),
          segment("seg-old-2", "Remember to email Dana.", now - 3 * 3600_000 + 2000),
          segment("seg-new-1", "Lunch plans for the offsite.", now - 3600_000)
        ],
        lifelog: { settings: { analysis: false, model: "", maxReviewsPerDay: 12, screenContext: false }, labels: { "consent:stream:0": "Sam" },
          edits: {}, reviews: {}, followups: {}, generation: 0, attempts: 0, day: "", lastAttempt: 0 }
      },
      // A device that is no longer enrolled is never listed.
      [createHash("sha256").update("revoked-g2").digest("hex")]: {
        settings, candidates: [], marks: {}, batches: [], consent: null, lastBatchAt: 0,
        segments: [segment("seg-revoked", "Private words from a revoked device.", now - 60_000)]
      }
    }
  };
}

test("lifelog moments are newest-first across enrolled G2s for the owner and phones", async (t) => {
  const now = Date.now();
  const ctx = await boot(t, { proactiveState: proactiveState(now) });
  const response = await ctx.as(PHONE_A, "/lifelog/moments");
  assert.equal(response.status, 200);
  const { moments } = await response.json();
  assert.deepEqual(moments.map((m) => m.id), ["seg-new-1", "seg-old-1"]);
  assert.deepEqual(Object.keys(moments[0]).sort(), ["at", "deviceName", "endAt", "id", "nodeId", "summary", "title", "transcript"]);
  assert.equal(moments[1].nodeId, G2.id);
  assert.equal(moments[1].deviceName, "Glasses");
  assert.equal(moments[1].at, new Date(now - 3 * 3600_000).toISOString());
  assert.equal(moments[1].transcript, "Sam: We decided to ship the widget on Friday.\nSam: Remember to email Dana.");
  assert.equal(moments[1].summary, null);

  const searched = await (await ctx.asOwner("/lifelog/moments?query=dana")).json();
  assert.deepEqual(searched.moments.map((m) => m.id), ["seg-old-1"]);
  const today = new Date(now - 3600_000).toISOString().slice(0, 10);
  const dated = await (await ctx.as(PHONE_B, `/lifelog/moments?date=${today}&limit=1`)).json();
  assert.equal(dated.moments.length, 1);
  assert.deepEqual((await (await ctx.as(PHONE_A, "/lifelog/moments?date=2001-01-01")).json()).moments, []);
  for (const query of ["date=today", "limit=0", "limit=101", `query=${"q".repeat(201)}`]) {
    assert.equal((await ctx.as(PHONE_A, `/lifelog/moments?${query}`)).status, 400, query);
  }
  assert.equal((await ctx.as(G2, "/lifelog/moments")).status, 401);
  assert.equal((await ctx.as(GENERIC, "/lifelog/moments")).status, 401);
});

test("lifelogMoments reads without creating state for a device that never captured", () => {
  const proactive = { nodes: {}, prune() {} };
  assert.deepEqual(lifelogMoments(proactive, [{ nodeId: "never", name: "G2" }]), { moments: [] });
  assert.deepEqual(proactive.nodes, {});
});

test("search_conversation_lifelog answers in shared threads and nowhere new", async (t) => {
  const now = Date.now();
  const ctx = await boot(t, { proactiveState: proactiveState(now) });
  const tool = ctx.runtime.tools.get("search_conversation_lifelog");
  for (const context of [
    { channel: "node", sessionId: "devices:agent:main" },
    { channel: "node", sessionId: "devices:supervisor:main" },
    { channel: "g2", sourceNodeId: G2.id, sessionId: "devices:agent:main" }
  ]) {
    const result = await tool.handler({ query: "widget" }, context);
    assert.deepEqual(result.moments.map((m) => m.id), ["seg-old-1"], JSON.stringify(context));
  }
  await assert.rejects(async () => tool.handler({ query: "widget" }, { channel: "node", sessionId: "node:abc:def:main" }), /Lifelog recall requires/);
});
