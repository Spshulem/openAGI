import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { _resetDataDirCache } from "../src/data-dir.js";
import { createDurableRuntime } from "../src/index.js";
import {
  MIRROR_MAX_BYTES,
  MirrorError,
  buildMirrorSnapshot,
  importMirrorSnapshot,
  importOfflineWork,
  listOfflineWork,
  markOfflineWorkSent,
  validateOfflineWork
} from "../src/mirror.js";

const AGENT = "devices:agent:main";
const SUPERVISOR = "devices:supervisor:main";
const ENV_KEYS = ["OPENAGI_PROFILE", "OPENAGI_DATA_DIR", "OPENAGI_AGENT_NAME"];

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mirror-"));
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

function makeRuntime(label, env = {}) {
  const dir = fs.mkdtempSync(path.join(tempRoot, `${label}-`));
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, { OPENAGI_DATA_DIR: dir, ...env });
  _resetDataDirCache();
  try {
    return { dir, runtime: createDurableRuntime({ dataDir: dir, autoConnectMcp: false }) };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetDataDirCache();
  }
}

// Stores open asynchronously; let them settle before the temp root goes away.
async function settle(...runtimes) {
  for (const runtime of runtimes) {
    await runtime.sessionIndex?.ready?.catch?.(() => {});
    await runtime.sessionIndex?.rebuildPromise;
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function writeSkill(dir, name, body = "Say hello to {{input}}.") {
  fs.mkdirSync(path.join(dir, "skills", name), { recursive: true });
  fs.writeFileSync(path.join(dir, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`);
}

function threadIds(runtime, sessionId) {
  return runtime.agentHost.store.getSession(sessionId).messages.map((m) => m.id);
}

function seedMac() {
  const mac = makeRuntime("mac");
  const { runtime, dir } = mac;
  const store = runtime.agentHost.store;
  store.appendMessage(AGENT, { role: "user", content: "What is on today?", channel: "node", metadata: { sourceNodeId: "g2-1", authority: { owner: true } } });
  store.appendMessage(AGENT, { role: "assistant", content: "Ship the mirror.", from: "openagi",
    metadata: { provider: "openai", toolCalls: [{ name: "computer_type", arguments: { text: { redacted: true } } }], ownerTurn: { untrusted: false } } });
  store.appendMessage(SUPERVISOR, { role: "user", content: "Status of the fleet?" });
  runtime.memory.remember({ content: "Owner prefers tea in the afternoon", tags: ["preference"], source: "user" }, { tier: "long" });
  runtime.memory.remember({ content: "Deploy key is sk-ant-api03-" + "x".repeat(32), tags: ["ops"], source: "user" }, { tier: "medium" });
  runtime.memory.remember({ content: "Bank PIN 9911", tags: ["secret"], source: "user" }, { tier: "long" });
  const open = runtime.tasks.add({ title: "Ship mirror" }, { source: "manual", queue: "user" });
  const done = runtime.tasks.add({ title: "Old finished task" }, { source: "manual", queue: "user" });
  runtime.tasks.complete(done.id);
  fs.writeFileSync(path.join(dir, "persona.md"), "# Halley\nName: Halley\nYou are Halley, a calm assistant.\n");
  writeSkill(dir, "greet");
  runtime.skills.reload();
  // Secrets that must never leave the Mac.
  fs.writeFileSync(path.join(dir, ".env"), "OPENAI_API_KEY=sk-envsecretvalue0000000\n");
  fs.writeFileSync(path.join(dir, "chatgpt-auth.json"), JSON.stringify({ access_token: "chatgpt-token-SHOULD-NOT-LEAK" }));
  return { ...mac, openTaskId: open.id, doneTaskId: done.id };
}

test("mirror round trip: snapshot, phone import, offline work back to the Mac", async () => {
  const mac = seedMac();
  const phone = makeRuntime("phone", { OPENAGI_PROFILE: "mobile" });
  await settle(mac.runtime, phone.runtime);
  writeSkill(phone.dir, "local-only");
  phone.runtime.skills.reload();

  // ── Snapshot: native shapes, open tasks only, no secrets.
  const snap1 = buildMirrorSnapshot(mac.runtime, { dataDir: mac.dir });
  assert.equal(snap1.version, 1);
  assert.match(snap1.source.cursor, /^[0-9a-f]{32}$/);
  assert.deepEqual(snap1.threads.agent.map((m) => m.content), ["What is on today?", "Ship the mirror."]);
  assert.equal(snap1.threads.supervisor.length, 1);
  assert.deepEqual(snap1.tasks.map((t) => t.id), [mac.openTaskId]);
  assert.deepEqual(snap1.skills.map((s) => s.name), ["greet"]);
  assert.match(snap1.persona, /Halley/);
  const json = JSON.stringify(snap1);
  for (const leaked of ["sk-envsecretvalue", "chatgpt-token-SHOULD-NOT-LEAK", "sk-ant-api03", "Bank PIN", "toolCalls", "authority", "ownerTurn"]) {
    assert.ok(!json.includes(leaked), `snapshot leaked ${leaked}`);
  }
  assert.ok(snap1.memories.some((m) => m.content.includes("[REDACTED]")));
  assert.equal(snap1.threads.agent[0].metadata.sourceNodeId, "g2-1");

  // ── Phone import: the phone runtime sees everything.
  const first = importMirrorSnapshot(phone.runtime, snap1, { dataDir: phone.dir });
  assert.deepEqual(first.threads, { agent: 2, supervisor: 1 });
  assert.deepEqual(threadIds(phone.runtime, AGENT), snap1.threads.agent.map((m) => m.id));
  assert.ok(phone.runtime.memory.retrieve("tea afternoon").some((hit) => hit.item.content.includes("tea")));
  assert.ok(phone.runtime.tasks.get(mac.openTaskId));
  assert.equal(phone.runtime.tasks.get(mac.doneTaskId), null);
  assert.equal(phone.runtime.agentHost.store.getAgent("main").name, "Halley");
  assert.ok(phone.runtime.skills.has("greet"));
  assert.ok(phone.runtime.skills.has("local-only"), "phone-made skills are kept");
  const state = JSON.parse(fs.readFileSync(path.join(phone.dir, "mirror", "state.json"), "utf8"));
  assert.equal(state.cursor, snap1.source.cursor);
  assert.deepEqual(state.baseline.taskIds, [mac.openTaskId]);

  // Idempotent.
  const memoryCount = phone.runtime.memory.items.size;
  importMirrorSnapshot(phone.runtime, snap1, { dataDir: phone.dir });
  assert.deepEqual(threadIds(phone.runtime, AGENT), snap1.threads.agent.map((m) => m.id));
  assert.equal(phone.runtime.memory.items.size, memoryCount);
  assert.equal(phone.runtime.tasks.tasks.size, 1);
  assert.deepEqual(listOfflineWork(phone.runtime, { dataDir: phone.dir }).tasks, []);

  // ── Phone works offline.
  const pstore = phone.runtime.agentHost.store;
  pstore.appendMessage(AGENT, { role: "user", content: "Offline question", channel: "local", metadata: { authority: { owner: true } } });
  pstore.appendMessage(AGENT, { role: "assistant", content: "Offline answer", from: "openagi", metadata: { toolCalls: [] } });
  const offlineTask = phone.runtime.tasks.add({ title: "Offline task" }, { source: "chat", queue: "user" });
  const offlineMemory = phone.runtime.memory.remember({ content: "Learned while offline", tags: ["note"], source: "user" }, { tier: "medium" });

  const work = listOfflineWork(phone.runtime, { dataDir: phone.dir });
  const stateNow = JSON.parse(fs.readFileSync(path.join(phone.dir, "mirror", "state.json"), "utf8"));
  assert.equal(work.since, stateNow.importedAt);
  assert.deepEqual(work.messages.agent.map((m) => m.content), ["Offline question", "Offline answer"]);
  assert.deepEqual(work.messages.supervisor, []);
  assert.deepEqual(work.tasks.map((t) => t.id), [offlineTask.id]);
  assert.deepEqual(work.memories.map((m) => m.id), [offlineMemory.id]);
  assert.equal(work.truncated, false);
  assert.ok(!JSON.stringify(work).includes("authority"));

  // ── Mac appends with the origin tag.
  const macMessagesBefore = threadIds(mac.runtime, AGENT).length;
  const imported = importOfflineWork(mac.runtime, work, { dataDir: mac.dir, fromNodeId: "phone-1" });
  assert.deepEqual(imported.added, { messages: 2, tasks: 1, memories: 1 });
  const macThread = mac.runtime.agentHost.store.getSession(AGENT).messages;
  assert.equal(macThread.length, macMessagesBefore + 2);
  for (const m of macThread.slice(-2)) {
    assert.equal(m.metadata.origin, "phone-offline");
    assert.equal(m.metadata.fromNodeId, "phone-1");
    assert.equal(m.metadata.authority, undefined);
  }
  assert.equal(macThread.at(-2).metadata.sourceNodeId, "phone-1");
  const macTask = [...mac.runtime.tasks.tasks.values()].find((t) => t.sourceMeta?.originId === offlineTask.id);
  assert.equal(macTask.title, "Offline task");
  assert.equal(macTask.sourceMeta.origin, "phone-offline");
  const macMemory = mac.runtime.memory.items.get(offlineMemory.id);
  assert.equal(macMemory.metadata.origin, "phone-offline");
  assert.match(macMemory.content, /Learned while offline/);

  // Retry is a no-op and never edits existing items.
  const macTaskCount = mac.runtime.tasks.tasks.size;
  const macMemoryCount = mac.runtime.memory.items.size;
  const retry = importOfflineWork(mac.runtime, work, { dataDir: mac.dir, fromNodeId: "phone-1" });
  assert.deepEqual(retry.added, { messages: 0, tasks: 0, memories: 0 });
  assert.deepEqual(retry.skipped, { messages: 2, tasks: 1, memories: 1 });
  assert.equal(threadIds(mac.runtime, AGENT).length, macMessagesBefore + 2);
  assert.equal(mac.runtime.tasks.tasks.size, macTaskCount);
  assert.equal(mac.runtime.memory.items.size, macMemoryCount);

  // A stale snapshot before the send is acknowledged keeps unsent work.
  const kept = importMirrorSnapshot(phone.runtime, snap1, { dataDir: phone.dir });
  assert.deepEqual(kept.kept, { messages: 2, tasks: 1, memories: 1 });
  assert.deepEqual(listOfflineWork(phone.runtime, { dataDir: phone.dir }).tasks.map((t) => t.id), [offlineTask.id]);

  // Marking sent empties the list.
  assert.equal(markOfflineWorkSent(phone.runtime, { dataDir: phone.dir, work }).marked, 4);
  const empty = listOfflineWork(phone.runtime, { dataDir: phone.dir });
  assert.deepEqual([empty.messages.agent, empty.messages.supervisor, empty.tasks, empty.memories], [[], [], [], []]);

  // ── A newer snapshot: offline items come back once, under the Mac's ids.
  writeSkill(mac.dir, "plan");
  fs.rmSync(path.join(mac.dir, "skills", "greet"), { recursive: true });
  fs.writeFileSync(path.join(mac.dir, "persona.md"), "# Nova\nName: Nova\nYou are Nova.\n");
  const snap2 = buildMirrorSnapshot(mac.runtime, { dataDir: mac.dir });
  assert.notEqual(snap2.source.cursor, snap1.source.cursor);
  importMirrorSnapshot(phone.runtime, snap2, { dataDir: phone.dir });
  const phoneThread = pstore.getSession(AGENT).messages;
  assert.deepEqual(phoneThread.map((m) => m.id), snap2.threads.agent.map((m) => m.id));
  assert.equal(phoneThread.filter((m) => m.content === "Offline question").length, 1);
  const offlineTitles = [...phone.runtime.tasks.tasks.values()].filter((t) => t.title === "Offline task");
  assert.deepEqual(offlineTitles.map((t) => t.id), [macTask.id]);
  assert.equal([...phone.runtime.memory.items.values()].filter((m) => m.content.includes("Learned while offline")).length, 1);
  assert.equal(phone.runtime.agentHost.store.getAgent("main").name, "Nova");
  assert.ok(phone.runtime.skills.has("plan"));
  assert.ok(!phone.runtime.skills.has("greet"), "a skill removed on the Mac leaves the mirror");
  assert.ok(phone.runtime.skills.has("local-only"));
  const after2 = listOfflineWork(phone.runtime, { dataDir: phone.dir });
  assert.deepEqual([after2.messages.agent, after2.tasks, after2.memories], [[], [], []]);
  await settle(mac.runtime, phone.runtime);
});

test("offline photo pixels survive acknowledged upload and the replacement snapshot", async () => {
  const mac = makeRuntime("photo-main"), phone = makeRuntime("photo-phone", { OPENAGI_PROFILE: "mobile" });
  await settle(mac.runtime, phone.runtime);
  importMirrorSnapshot(phone.runtime, buildMirrorSnapshot(mac.runtime, { dataDir: mac.dir }), { dataDir: phone.dir });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPQKHgAAAI8AXnXjkfVAAAAAElFTkSuQmCC", "base64");
  const data = Buffer.concat([png, Buffer.alloc(64 * 1024)]).toString("base64");
  const attachment = { id: "synthetic-photo", name: "Synthetic.png", mimeType: "image/png", data };
  const original = phone.runtime.agentHost.store.appendMessage(AGENT, { role: "user", content: "Describe the synthetic photo",
    metadata: { attachments: [attachment], authority: { owner: true }, ownerTurn: { untrusted: false } } }).messages.at(-1);
  const work = listOfflineWork(phone.runtime, { dataDir: phone.dir });
  assert.equal(work.version, 2, "Legacy version-1 servers must refuse the page before acknowledging its images");
  assert.deepEqual(work.messages.agent[0].attachments, [attachment]);
  assert.equal(work.messages.agent[0].metadata.authority, undefined);
  assert.equal(work.messages.agent[0].metadata.ownerTurn, undefined);
  assert.equal(importOfflineWork(mac.runtime, work, { dataDir: mac.dir, fromNodeId: "synthetic-phone" }).added.messages, 1);
  markOfflineWorkSent(phone.runtime, { dataDir: phone.dir, work });
  const snapshot = buildMirrorSnapshot(mac.runtime, { dataDir: mac.dir });
  assert.equal(snapshot.version, 2);
  importMirrorSnapshot(phone.runtime, snapshot, { dataDir: phone.dir });
  for (const runtime of [mac.runtime, phone.runtime]) {
    const message = runtime.agentHost.store.getSession(AGENT).messages.find(m => m.id === original.id);
    assert.deepEqual(message.metadata.attachments, [attachment]);
    assert.equal(message.metadata.authority, undefined);
  }
  assert.equal(importOfflineWork(mac.runtime, work, { dataDir: mac.dir, fromNodeId: "synthetic-phone" }).added.messages, 0);
  for (const invalid of [
    { ...work, version: 1 },
    { ...work, messages: { agent: [{ ...work.messages.agent[0], attachments: [{ ...attachment, data: "invalid" }] }] } },
    { ...work, messages: { agent: [{ ...work.messages.agent[0], role: "assistant" }] } }
  ]) {
    assert.throws(() => validateOfflineWork(invalid), error => error.code === "invalid_mirror");
  }
});

test("imports reject malformed, oversized and unknown-version input", async () => {
  const mac = seedMac();
  const phone = makeRuntime("phone-reject");
  await settle(mac.runtime, phone.runtime);
  const snap = buildMirrorSnapshot(mac.runtime, { dataDir: mac.dir });
  const rejects = (input, code) => assert.throws(
    () => importMirrorSnapshot(phone.runtime, input, { dataDir: phone.dir }),
    (error) => error instanceof MirrorError && error.code === code
  );

  rejects(null, "invalid_mirror");
  rejects([], "invalid_mirror");
  rejects({ ...snap, version: 3 }, "unsupported_version");
  rejects({ ...snap, extra: true }, "invalid_mirror");
  rejects({ ...snap, persona: "x".repeat(64 * 1024 + 1) }, "invalid_mirror");
  rejects({ ...snap, skills: [{ name: "../evil", content: "x" }] }, "invalid_mirror");
  rejects({ ...snap, threads: { agent: [{ id: "../x", role: "user", content: "hi" }], supervisor: [] } }, "invalid_mirror");
  rejects({ ...snap, threads: { agent: [{ id: "m1", role: "tool", content: "hi" }], supervisor: [] } }, "invalid_mirror");
  rejects({ ...snap, memories: [{ id: "m1", tier: "forever", content: "x" }] }, "invalid_mirror");
  rejects({ ...snap, tasks: [{ id: "t1", queue: "user", title: "" }] }, "invalid_mirror");
  const big = Array.from({ length: 90 }, (_, i) => ({ id: `m${i}`, role: "user", content: "y".repeat(60 * 1024) }));
  rejects({ ...snap, threads: { agent: big, supervisor: [] } }, "mirror_too_large");
  assert.ok(JSON.stringify({ big }).length > MIRROR_MAX_BYTES);
  // Nothing was written by a rejected import.
  assert.equal(fs.existsSync(path.join(phone.dir, "mirror", "state.json")), false);

  const work = { version: 1, since: null, messages: { agent: [], supervisor: [] }, tasks: [], memories: [] };
  const rejectsWork = (input, options, code) => assert.throws(
    () => importOfflineWork(mac.runtime, input, { dataDir: mac.dir, ...options }),
    (error) => error instanceof MirrorError && error.code === code
  );
  rejectsWork(work, {}, "invalid_mirror");
  rejectsWork(work, { fromNodeId: "bad id with spaces" }, "invalid_mirror");
  rejectsWork({ ...work, version: 0 }, { fromNodeId: "phone-1" }, "unsupported_version");
  rejectsWork({ ...work, edits: [] }, { fromNodeId: "phone-1" }, "invalid_mirror");
  rejectsWork({ ...work, tasks: Array.from({ length: 501 }, (_, i) => ({ id: `t${i}`, queue: "user", title: "x" })) }, { fromNodeId: "phone-1" }, "mirror_too_large");
  assert.deepEqual(importOfflineWork(mac.runtime, work, { dataDir: mac.dir, fromNodeId: "phone-1" }).added, { messages: 0, tasks: 0, memories: 0 });
  await settle(mac.runtime, phone.runtime);
});
