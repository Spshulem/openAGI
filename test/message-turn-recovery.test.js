// A paired phone loses its /message stream when iOS backgrounds or locks it,
// or the network drops. The turn must keep running on main, the phone must
// be able to see that it is still running, and sending the same turn again
// (same client request id) must never run it twice.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { NodeRegistry } from "../src/node-registry.js";

const SESSION = "devices:agent:main";

async function phoneApp(t, generate, { thread = "agent" } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-turn-recovery-"));
  const nodeRegistry = new NodeRegistry({ dir: path.join(dataDir, "nodes") });
  const phone = { id: "mobile:recovery-phone", token: "r".repeat(43) };
  nodeRegistry.enroll(phone.id, phone.token, { platform: "mobile", name: "iPhone" });
  const runtime = createDurableRuntime({ dataDir });
  const calls = [];
  runtime.agentHost.modelProvider = {
    name: "recovery-provider", model: "test-model", isConfigured: () => true,
    async generate(request) { calls.push(request); return generate(calls.length, request); }
  };
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, authToken: "owner", dataDir, nodeRegistry, tickerMs: 60_000 });
  const { url: base } = await app.listen();
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const auth = { authorization: `Bearer ${phone.token}`, "x-openagi-node-id": phone.id };
  const send = (body, { stream = false, signal } = {}) => fetch(`${base}/message`, {
    method: "POST", signal,
    headers: { ...auth, "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json" },
    body: JSON.stringify({ thread, ...body })
  });
  const history = async (query = "", of = thread) => (await fetch(`${base}/conversations/${of}/messages${query}`, { headers: auth })).json();
  return { runtime, calls, send, history };
}

function gate() {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return { opened, open };
}

async function readUntil(response, event) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes(`event: ${event}\n`)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return { text, reader };
}

function frames(text) {
  return text.split("\n\n").map((block) => block.trim()).filter(Boolean).map((block) => {
    const lines = block.split("\n");
    return {
      event: lines.find((line) => line.startsWith("event: "))?.slice(7),
      data: JSON.parse(lines.filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n") || "null")
    };
  });
}

async function until(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met in time");
}

const reply = (text) => ({ id: `r_${text}`, text, provider: "test", model: "test-model", toolCalls: [] });

test("a turn whose stream detached finishes on main, shows as in flight, then carries its request id", async (t) => {
  const model = gate();
  const { runtime, send, history } = await phoneApp(t, async () => { await model.opened; return reply("Planned."); });
  const controller = new AbortController();
  const response = await send({ text: "plan my day", requestId: "turn-aaaaaaaa" }, { stream: true, signal: controller.signal });
  const { text } = await readUntil(response, "session");
  assert.ok(frames(text).some((f) => f.event === "session" && f.data.requestId === "turn-aaaaaaaa"), "acceptance names the client's turn");
  controller.abort();

  const running = await history();
  assert.deepEqual(running.messages.map((m) => [m.role, m.text, m.requestId]), [["user", "plan my day", "turn-aaaaaaaa"]]);
  assert.deepEqual(running.inFlight.map((turn) => turn.requestId), ["turn-aaaaaaaa"], "still working, not lost");

  model.open();
  await until(async () => (await history()).messages.length === 2);
  const done = await history();
  assert.deepEqual(done.messages.map((m) => [m.role, m.text, m.requestId]),
    [["user", "plan my day", "turn-aaaaaaaa"], ["assistant", "Planned.", "turn-aaaaaaaa"]]);
  assert.deepEqual(done.inFlight, []);
  assert.equal((await history(`?before=${done.messages[1].id}`)).inFlight, undefined, "an older page says nothing about live turns");
  assert.equal(runtime.agentHost.store.getSession(SESSION).messages.length, 2);
});

test("sending a running turn again follows it to its reply instead of running it twice", async (t) => {
  const model = gate();
  const { runtime, calls, send } = await phoneApp(t, async () => { await model.opened; return reply("Once."); });
  const first = new AbortController();
  await readUntil(await send({ text: "do it once", requestId: "turn-bbbbbbbb" }, { stream: true, signal: first.signal }), "session");
  first.abort();

  const again = await send({ text: "do it once", requestId: "turn-bbbbbbbb" }, { stream: true });
  const attached = readUntil(again, "final");
  const jsonAgain = send({ text: "do it once", requestId: "turn-bbbbbbbb" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  model.open();
  const streamed = frames((await attached).text);
  assert.ok(streamed.some((f) => f.event === "session"), "the attached stream is acknowledged");
  assert.equal(streamed.find((f) => f.event === "final").data.reply, "Once.");
  assert.equal((await (await jsonAgain).json()).reply, "Once.");
  assert.equal(calls.length, 1, "the model ran once");
  assert.equal(runtime.agentHost.store.getSession(SESSION).messages.length, 2, "one user line, one reply");
});

test("sending a finished turn again replays its reply without a second user line", async (t) => {
  const { runtime, calls, send } = await phoneApp(t, async () => reply("Already done."));
  assert.equal((await (await send({ text: "finish", requestId: "turn-cccccccc" })).json()).reply, "Already done.");

  const replay = await (await send({ text: "finish", requestId: "turn-cccccccc" })).json();
  assert.equal(replay.reply, "Already done.");
  assert.equal(replay.replayed, true);
  const streamed = frames((await readUntil(await send({ text: "finish", requestId: "turn-cccccccc" }, { stream: true }), "final")).text);
  assert.equal(streamed.find((f) => f.event === "final").data.reply, "Already done.");
  assert.ok(streamed.some((f) => f.event === "session"));
  assert.equal(calls.length, 1);
  assert.equal(runtime.agentHost.store.getSession(SESSION).messages.length, 2);
});

test("sending a failed turn again replays its failure; an interrupted one fails without rerunning", async (t) => {
  const { runtime, calls, send, history } = await phoneApp(t, async () => { throw Object.assign(new Error("429 rate limit"), { status: 429 }); });
  const failed = await send({ text: "try", requestId: "turn-dddddddd" });
  assert.equal(failed.status, 500);
  const firstCode = (await failed.json()).code;
  const again = await send({ text: "try", requestId: "turn-dddddddd" });
  assert.equal(again.status, 500);
  const replayed = await again.json();
  assert.equal(replayed.code, firstCode, "the stored code, not a reclassification of its text");
  assert.equal(replayed.replayed, true);
  assert.equal(calls.length, 1);
  assert.equal((await history()).messages.at(-1).status, "failed");

  // Main restarted mid-turn: the user line is stored, no reply, nothing live.
  runtime.agentHost.store.appendMessage(SESSION, { role: "user", content: "lost", channel: "node", from: "node:x", metadata: { requestId: "turn-eeeeeeee" } });
  const interrupted = await send({ text: "lost", requestId: "turn-eeeeeeee" });
  assert.equal(interrupted.status, 500);
  assert.equal((await interrupted.json()).code, "interrupted");
  assert.equal(calls.length, 1, "an interrupted turn is never rerun silently");
});

test("request ids are validated, and a send without one keeps the old contract", async (t) => {
  const { calls, send } = await phoneApp(t, async (n) => reply(`Reply ${n}`));
  for (const requestId of ["short", "has space here", "x".repeat(129), 42]) {
    assert.equal((await send({ text: "hi", requestId })).status, 400, `rejects ${JSON.stringify(requestId)}`);
  }
  assert.equal(calls.length, 0);
  assert.equal((await (await send({ text: "same" })).json()).reply, "Reply 1");
  assert.equal((await (await send({ text: "same" })).json()).reply, "Reply 2", "no id: each send is its own turn");
});

// The iPhone's Supervisor chat is the same ChatConversation on thread
// "supervisor", sending exactly these fields (DaemonClient.sendMessageStreaming
// adds the legacy from/sessionId key for older mains). Every recovery step
// must hold on its own session and history route, never the agent thread's.
const SUPERVISOR_SESSION = "devices:supervisor:main";
const supervisorSend = { from: "mobile-supervisor", sessionId: "mobile-supervisor" };

test("supervisor thread: a locked phone's turn keeps running, is listed in flight on its own route, and is followed, not rerun", async (t) => {
  const model = gate();
  const { runtime, calls, send, history } = await phoneApp(t, async () => { await model.opened; return reply("Fleet is green."); }, { thread: "supervisor" });
  const locked = new AbortController();
  const response = await send({ ...supervisorSend, text: "how is the fleet", requestId: "ios-sup-aaaaaaaa" }, { stream: true, signal: locked.signal });
  const { text } = await readUntil(response, "session");
  assert.ok(frames(text).some((f) => f.event === "session" && f.data.id === SUPERVISOR_SESSION && f.data.requestId === "ios-sup-aaaaaaaa"));
  locked.abort();

  const running = await history();
  assert.equal(running.thread, "supervisor");
  assert.deepEqual(running.messages.map((m) => [m.role, m.text, m.requestId]), [["user", "how is the fleet", "ios-sup-aaaaaaaa"]]);
  assert.deepEqual(running.inFlight.map((turn) => turn.requestId), ["ios-sup-aaaaaaaa"]);
  const agent = await history("", "agent");
  assert.deepEqual([agent.messages, agent.inFlight], [[], []], "the agent thread neither shows nor runs the supervisor's turn");

  // A resend with the same id (the phone's once-only retry) follows the run.
  const again = readUntil(await send({ ...supervisorSend, text: "how is the fleet", requestId: "ios-sup-aaaaaaaa" }, { stream: true }), "final");
  await new Promise((resolve) => setTimeout(resolve, 50));
  model.open();
  assert.equal(frames((await again).text).find((f) => f.event === "final").data.reply, "Fleet is green.");

  const done = await history();
  assert.deepEqual(done.messages.map((m) => [m.role, m.text, m.requestId, m.status]),
    [["user", "how is the fleet", "ios-sup-aaaaaaaa", undefined], ["assistant", "Fleet is green.", "ios-sup-aaaaaaaa", undefined]]);
  assert.deepEqual(done.inFlight, []);
  assert.equal(calls.length, 1, "the model ran once");
  assert.equal(runtime.agentHost.store.getSession(SUPERVISOR_SESSION).messages.length, 2, "one user line, one reply");
});

test("supervisor thread: a finished turn replays; failures carry status; a turn lost to a restart is interrupted", async (t) => {
  let fail = false;
  const { runtime, calls, send, history } = await phoneApp(t, async () => {
    if (fail) throw Object.assign(new Error("429 rate limit"), { status: 429 });
    return reply("Done while you were away.");
  }, { thread: "supervisor" });
  assert.equal((await (await send({ ...supervisorSend, text: "merge it", requestId: "ios-sup-bbbbbbbb" })).json()).reply, "Done while you were away.");
  const replay = await (await send({ ...supervisorSend, text: "merge it", requestId: "ios-sup-bbbbbbbb" })).json();
  assert.equal(replay.replayed, true);
  assert.equal(replay.reply, "Done while you were away.");
  assert.equal(calls.length, 1);

  fail = true;
  assert.equal((await send({ ...supervisorSend, text: "rerun ci", requestId: "ios-sup-cccccccc" })).status, 500);
  const failed = (await history()).messages.at(-1);
  assert.deepEqual([failed.role, failed.requestId, failed.status], ["assistant", "ios-sup-cccccccc", "failed"]);

  runtime.agentHost.store.appendMessage(SUPERVISOR_SESSION, { role: "user", content: "lost", channel: "node", from: "node:x", metadata: { thread: "supervisor", requestId: "ios-sup-dddddddd" } });
  const page = await history();
  assert.equal(page.messages.at(-1).requestId, "ios-sup-dddddddd");
  assert.deepEqual(page.inFlight, [], "stored, never answered, nothing running: the phone shows it as interrupted");
  const interrupted = await send({ ...supervisorSend, text: "lost", requestId: "ios-sup-dddddddd" });
  assert.equal((await interrupted.json()).code, "interrupted");
  assert.equal(calls.length, 2, "neither replay nor the interrupted turn reached the model");
  assert.equal((await history("", "agent")).messages.length, 0);
});
