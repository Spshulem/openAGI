// The owner corrects a queued message and sends it now: the running reply is
// interrupted and the correction runs next in the same conversation. Main
// must say truthfully whether the turn stopped, never undo or cut short an
// action already running, and never drop, reorder or double-run a message.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { NodeRegistry } from "../src/node-registry.js";
import { LiveTurns, interruptTurn } from "../src/message-turns.js";

async function app(t, generate, { thread = "supervisor", interruptSettleMs = 300 } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-interrupt-"));
  const nodeRegistry = new NodeRegistry({ dir: path.join(dataDir, "nodes") });
  const phone = { id: "mobile:interrupt-phone", token: "p".repeat(43) };
  const glasses = { id: "g2:interrupt-glasses", token: "g".repeat(43) };
  const bridge = { id: "node:interrupt-bridge", token: "b".repeat(43) };
  nodeRegistry.enroll(phone.id, phone.token, { platform: "mobile", name: "iPhone" });
  nodeRegistry.enroll(glasses.id, glasses.token, { platform: "even-g2", name: "G2" });
  nodeRegistry.enroll(bridge.id, bridge.token, { platform: "imessage", name: "Bridge" });
  const runtime = createDurableRuntime({ dataDir });
  const calls = [];
  runtime.agentHost.modelProvider = {
    name: "interrupt-provider", model: "test-model", isConfigured: () => true,
    async generate(request) { calls.push(request.input); return generate(request, calls.length); }
  };
  const server = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, authToken: "owner", dataDir, nodeRegistry, tickerMs: 60_000, interruptSettleMs });
  const { url: base } = await server.listen();
  t.after(async () => { await server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const as = (who) => who === "owner"
    ? { authorization: "Bearer owner" }
    : { authorization: `Bearer ${who.token}`, "x-openagi-node-id": who.id };
  const send = (body, { stream = true, who = phone } = {}) => fetch(`${base}/message`, {
    method: "POST",
    headers: { ...as(who), "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json" },
    body: JSON.stringify({ thread, ...body })
  });
  const interrupt = async (requestId, { who = phone, of = thread, extra = {} } = {}) => {
    const response = await fetch(`${base}/conversations/${of}/interrupt`, {
      method: "POST", headers: { ...as(who), "content-type": "application/json" },
      body: JSON.stringify({ requestId, ...extra })
    });
    return { status: response.status, body: await response.json() };
  };
  const history = async () => (await fetch(`${base}/conversations/${thread}/messages`, { headers: as(phone) })).json();
  const stored = () => runtime.agentHost.store.getSession(`devices:${thread}:main`).messages
    .filter((m) => ["user", "assistant"].includes(m.role))
    .map((m) => [m.role, m.content, m.metadata?.requestId ?? null]);
  return { runtime, calls, send, interrupt, history, stored, phone, glasses, bridge };
}

function gate() {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return { opened, open };
}

// What a real provider does with the turn's signal: its HTTP call rejects
// with the abort reason the moment the owner interrupts.
function untilAborted(signal, promise) {
  return Promise.race([promise, new Promise((_, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  })]);
}

async function readAll(response) {
  const text = await response.text();
  return text.split("\n\n").map((block) => block.trim()).filter(Boolean).map((block) => {
    const lines = block.split("\n");
    return {
      event: lines.find((line) => line.startsWith("event: "))?.slice(7),
      data: JSON.parse(lines.filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n") || "null")
    };
  });
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

async function until(check, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met in time");
}

const reply = (text) => ({ id: `r_${text}`, text, provider: "test", model: "test-model", toolCalls: [] });
const STOPPED = "Stopped so your next message could go first. Anything already under way may have finished; nothing was undone.";

test("interrupting a running reply stops it, says so, and the correction runs next", async (t) => {
  const never = gate();
  const { calls, send, interrupt, stored } = await app(t, async (request, n) => {
    if (n === 1) { await untilAborted(request.context.signal, never.opened); }
    return reply(`Answer to ${request.input}`);
  });
  const first = await send({ text: "draft the plan for Tuesday", requestId: "turn-first-aaaa" });
  const opened = readUntil(first, "session");
  await opened;
  await until(() => calls.length === 1);

  const result = await interrupt("turn-first-aaaa");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { status: "interrupted", requestId: "turn-first-aaaa" });

  const { reader } = await opened;
  let rest = "";
  for (;;) { const { value, done } = await reader.read(); if (done) break; rest += new TextDecoder().decode(value); }
  assert.match(rest, /event: failure\ndata: .*"code":"stopped"/, "the open stream hears the stop, not a provider fault");

  const next = await readAll(await send({ text: "actually, Wednesday", requestId: "turn-second-aaa" }));
  assert.equal(next.find((f) => f.event === "final").data.reply, "Answer to actually, Wednesday");
  assert.deepEqual(stored(), [
    ["user", "draft the plan for Tuesday", "turn-first-aaaa"],
    ["assistant", STOPPED, "turn-first-aaaa"],
    ["user", "actually, Wednesday", "turn-second-aaa"],
    ["assistant", "Answer to actually, Wednesday", "turn-second-aaa"]
  ]);
  assert.deepEqual(calls, ["draft the plan for Tuesday", "actually, Wednesday"]);
});

test("a tool already running finishes and is not undone; the turn stops after it and the next message waits", async (t) => {
  const tool = gate();
  const effects = [];
  const { calls, send, interrupt, stored } = await app(t, async (request, n) => {
    if (n === 1) {
      request.onProgress?.({ stage: "tool", tool: "send_email", hop: 1 });
      // A tool ignores the signal: it runs to completion.
      await tool.opened;
      effects.push("email sent");
      // The provider loop checks the signal before its next hop or tool.
      request.context.signal.throwIfAborted();
      effects.push("second tool ran");
      return reply("Sent and filed.");
    }
    return reply(`Answer to ${request.input}`);
  });
  const first = await send({ text: "email the team then file it", requestId: "turn-tool-aaaaa" });
  const firstFrames = readAll(first);
  await until(() => calls.length === 1);

  const stopping = await interrupt("turn-tool-aaaaa");
  assert.deepEqual(stopping.body, { status: "stopping", requestId: "turn-tool-aaaaa", tool: "send_email" },
    "main says it is waiting on the running action, not that it stopped");

  // Sent while the old turn is still stopping: it must run after it.
  const second = send({ text: "skip filing", requestId: "turn-tool-bbbbb" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.length, 1, "the correction does not overlap the stopping turn");

  tool.open();
  assert.equal((await firstFrames).find((f) => f.event === "failure").data.code, "stopped");
  assert.equal((await readAll(await second)).find((f) => f.event === "final").data.reply, "Answer to skip filing");
  assert.deepEqual(effects, ["email sent"], "the running action completed; nothing after it ran; nothing was rolled back");

  assert.deepEqual((await interrupt("turn-tool-aaaaa")).body, { status: "interrupted", requestId: "turn-tool-aaaaa" },
    "asking again after it stopped reports the same truth");
  assert.deepEqual(stored().map(([role, , id]) => [role, id]), [
    ["user", "turn-tool-aaaaa"], ["assistant", "turn-tool-aaaaa"],
    ["user", "turn-tool-bbbbb"], ["assistant", "turn-tool-bbbbb"]
  ]);
});

test("a reply that finished first is reported as finished, never as interrupted", async (t) => {
  const { send, interrupt, stored } = await app(t, async () => reply("All done."));
  const frames = await readAll(await send({ text: "quick one", requestId: "turn-done-aaaaa" }));
  assert.equal(frames.find((f) => f.event === "final").data.reply, "All done.");
  assert.deepEqual((await interrupt("turn-done-aaaaa")).body, { status: "finished", outcome: "complete", requestId: "turn-done-aaaaa" });
  assert.deepEqual(stored(), [["user", "quick one", "turn-done-aaaaa"], ["assistant", "All done.", "turn-done-aaaaa"]]);
});

test("a reply that completes while the interrupt is landing keeps its answer", async (t) => {
  // The model's final text is already back when the stop arrives: the
  // turn saves its real reply and the interrupt says it finished.
  const model = gate();
  const { calls, send, interrupt, stored } = await app(t, async () => { await model.opened; return reply("Made it."); });
  const frames = readAll(await send({ text: "race me", requestId: "turn-race-aaaaa" }));
  await until(() => calls.length === 1);
  const pending = interrupt("turn-race-aaaaa");
  model.open();
  const result = (await pending).body;
  const final = (await frames).find((f) => f.event === "final" || f.event === "failure");
  if (result.status === "finished") {
    assert.equal(final.event, "final");
    assert.deepEqual(stored().at(-1), ["assistant", "Made it.", "turn-race-aaaaa"]);
  } else {
    assert.equal(result.status, "interrupted");
    assert.equal(final.data.code, "stopped");
    assert.deepEqual(stored().at(-1), ["assistant", STOPPED, "turn-race-aaaaa"]);
  }
  assert.equal(stored().length, 2, "exactly one outcome is recorded");
});

test("a double tap interrupts once and records one stop", async (t) => {
  const never = gate();
  const { calls, send, interrupt, stored } = await app(t, async (request) => { await untilAborted(request.context.signal, never.opened); return reply("never"); });
  const frames = readAll(await send({ text: "long task", requestId: "turn-twice-aaaa" }));
  await until(() => calls.length === 1);
  const [a, b] = await Promise.all([interrupt("turn-twice-aaaa"), interrupt("turn-twice-aaaa")]);
  assert.equal(a.body.status, "interrupted");
  assert.equal(b.body.status, "interrupted");
  assert.equal((await frames).filter((f) => f.event === "failure").length, 1);
  assert.equal(stored().filter(([role]) => role === "assistant").length, 1);
  assert.equal(calls.length, 1);
});

test("a turn still waiting behind another one is dropped without running, and order holds", async (t) => {
  const first = gate();
  const { calls, send, interrupt, stored } = await app(t, async (request, n) => {
    if (n === 1) await first.opened;
    return reply(`Answer to ${request.input}`);
  }, { interruptSettleMs: 1_000 });
  // Another device's turn is running; this phone's turn waits behind it.
  const running = readAll(await send({ text: "from the Mac", requestId: "turn-mac-aaaaaaa" }, { who: "owner" }));
  await until(() => calls.length === 1);
  const waiting = readAll(await send({ text: "stale question", requestId: "turn-wait-aaaaa" }));
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual((await interrupt("turn-wait-aaaaa")).body, { status: "interrupted", requestId: "turn-wait-aaaaa" });
  assert.equal((await waiting).find((f) => f.event === "failure").data.code, "stopped");
  const correction = readAll(await send({ text: "better question", requestId: "turn-next-aaaaa" }));
  first.open();
  assert.equal((await running).find((f) => f.event === "final").data.reply, "Answer to from the Mac");
  assert.equal((await correction).find((f) => f.event === "final").data.reply, "Answer to better question");
  assert.deepEqual(calls, ["from the Mac", "better question"], "the dropped turn never reached the model");
  // Stored in order once its slot came: the question and its stop.
  assert.deepEqual(stored(), [
    ["user", "from the Mac", "turn-mac-aaaaaaa"], ["assistant", "Answer to from the Mac", "turn-mac-aaaaaaa"],
    ["user", "stale question", "turn-wait-aaaaa"], ["assistant", STOPPED, "turn-wait-aaaaa"],
    ["user", "better question", "turn-next-aaaaa"], ["assistant", "Answer to better question", "turn-next-aaaaa"]
  ]);
  assert.deepEqual((await interrupt("turn-wait-aaaaa")).body, { status: "interrupted", requestId: "turn-wait-aaaaa" });
});

test("a turn stopped before it ran is never run by a resend of its id, even before its records exist", async (t) => {
  const first = gate();
  const { calls, send, interrupt, stored } = await app(t, async (request, n) => {
    if (n === 1) await first.opened;
    return reply(`Answer to ${request.input}`);
  }, { interruptSettleMs: 1_000 });
  const running = readAll(await send({ text: "long one", requestId: "turn-long-aaaaa" }, { who: "owner" }));
  await until(() => calls.length === 1);
  const waiting = readAll(await send({ text: "replaced", requestId: "turn-repl-aaaaa" }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await interrupt("turn-repl-aaaaa")).body.status, "interrupted");
  await waiting;

  // Still behind the first turn, nothing stored for it yet.
  assert.equal(stored().some(([, , id]) => id === "turn-repl-aaaaa"), false);
  assert.deepEqual((await interrupt("turn-repl-aaaaa")).body, { status: "interrupted", requestId: "turn-repl-aaaaa" }, "a second interrupt agrees");
  const resend = await readAll(await send({ text: "replaced", requestId: "turn-repl-aaaaa" }));
  assert.equal(resend.find((f) => f.event === "failure").data.code, "stopped", "a resend replays the stop");

  first.open();
  await running;
  await until(() => stored().some(([, , id]) => id === "turn-repl-aaaaa"));
  assert.deepEqual(calls, ["long one"], "the replaced message never ran");
  assert.equal(stored().filter(([, , id]) => id === "turn-repl-aaaaa").length, 2, "one question, one stop");
});

test("an owner interrupt never cancels the action running now; other aborts still do", async () => {
  const { ToolRegistry } = await import("../src/tool-registry.js");
  const { ownerInterruptReason } = await import("../src/message-turns.js");
  const registry = new ToolRegistry();
  const seen = [];
  const release = gate();
  registry.register({
    name: "type_text", description: "types", parameters: { type: "object", properties: {} },
    async handler(_args, context) {
      const aborted = new Promise((resolve) => context.signal?.addEventListener("abort", () => resolve("aborted"), { once: true }));
      seen.push(await Promise.race([aborted, release.opened.then(() => "finished")]));
      return { ok: true };
    }
  });
  const owner = new AbortController();
  const ownerRun = registry.invoke("type_text", {}, { signal: owner.signal });
  owner.abort(ownerInterruptReason());
  setTimeout(release.open, 30);
  assert.equal((await ownerRun).ok, true);
  assert.deepEqual(seen, ["finished"], "the running action completed despite the owner's stop");
  assert.equal((await registry.invoke("type_text", {}, { signal: owner.signal })).ok, false, "but no new action starts");

  const shutdown = new AbortController();
  const other = registry.invoke("type_text", {}, { signal: shutdown.signal });
  shutdown.abort(new Error("request cancelled"));
  await other;
  assert.equal(seen.at(-1), "aborted", "a cancelled request still reaches the tool");
});

test("a phone whose stream dropped can still interrupt its turn", async (t) => {
  const never = gate();
  const { calls, send, interrupt, history } = await app(t, async (request) => { await untilAborted(request.context.signal, never.opened); return reply("never"); });
  const response = await send({ text: "detach me", requestId: "turn-detach-aaa" });
  const { reader } = await readUntil(response, "session");
  await reader.cancel();
  await until(() => calls.length === 1);
  assert.deepEqual((await history()).inFlight.map((turn) => turn.requestId), ["turn-detach-aaa"]);
  assert.equal((await interrupt("turn-detach-aaa")).body.status, "interrupted");
  await until(async () => (await history()).inFlight.length === 0);
  assert.equal((await history()).messages.at(-1).text, STOPPED);
});

test("unknown turns, bad bodies and other callers are refused plainly", async (t) => {
  const { interrupt, glasses, bridge } = await app(t, async () => reply("ok"));
  assert.deepEqual((await interrupt("turn-never-sent")).body, { status: "not_found", requestId: "turn-never-sent" });
  assert.equal((await interrupt("short")).status, 400);
  assert.equal((await interrupt("turn-extra-aaaa", { extra: { force: true } })).status, 400);
  assert.equal((await interrupt("turn-conv-aaaaa", { extra: { conversationId: "../../owner" } })).status, 400);
  // Neither credential is allowed on this route at all (401 at the auth gate).
  assert.ok([401, 403].includes((await interrupt("turn-g2-aaaaaaa", { who: glasses })).status), "G2 cannot stop replies");
  assert.ok([401, 403].includes((await interrupt("turn-node-aaaaa", { who: bridge })).status), "a relay node cannot stop the owner's chat");
});

test("the owner's Mac names its own turns and can interrupt them", async (t) => {
  const never = gate();
  const { calls, send, interrupt, stored } = await app(t, async (request, n) => {
    if (n === 1) await untilAborted(request.context.signal, never.opened);
    return reply(`Answer to ${request.input}`);
  });
  const frames = readAll(await send({ text: "from the Mac", from: "mac-supervisor", requestId: "mac-turn-aaaaaa" }, { who: "owner" }));
  await until(() => calls.length === 1);
  assert.deepEqual(stored()[0], ["user", "from the Mac", "mac-turn-aaaaaa"], "the user line carries the Mac's turn id");
  assert.deepEqual((await interrupt("mac-turn-aaaaaa", { who: "owner" })).body, { status: "interrupted", requestId: "mac-turn-aaaaaa" });
  assert.equal((await frames).find((f) => f.event === "failure").data.code, "stopped");
  // A repeat of the same Mac turn replays its stop instead of running it again.
  const replay = await readAll(await send({ text: "from the Mac", from: "mac-supervisor", requestId: "mac-turn-aaaaaa" }, { who: "owner" }));
  assert.equal(replay.find((f) => f.event === "failure").data.code, "stopped");
  assert.equal(calls.length, 1);
  // An owner UI's own, differently shaped id is ignored, not refused.
  const loose = await send({ text: "loose id", requestId: "bad id!" }, { who: "owner", stream: false });
  assert.equal(loose.status, 200);
  assert.notEqual(stored().at(-2)[2], "bad id!", "and never becomes a turn id");
});

test("interruptTurn answers without a live registry entry from the stored records", async () => {
  const store = { getSession: () => ({ messages: [
    { role: "user", content: "a", metadata: { requestId: "turn-stored-aa" } },
    { role: "assistant", content: STOPPED, metadata: { requestId: "turn-stored-aa", status: "failed", code: "stopped" } },
    { role: "user", content: "b", metadata: { requestId: "turn-stored-bb" } },
    { role: "assistant", content: "fail", metadata: { requestId: "turn-stored-bb", status: "failed", code: "provider-timeout" } },
    { role: "user", content: "c", metadata: { requestId: "turn-stored-cc" } }
  ] }) };
  const liveTurns = new LiveTurns();
  const ask = (requestId) => interruptTurn({ liveTurns, store, sessionId: "devices:agent:main", requestId });
  assert.deepEqual(await ask("turn-stored-aa"), { status: "interrupted", requestId: "turn-stored-aa" });
  assert.deepEqual(await ask("turn-stored-bb"), { status: "finished", outcome: "failed", requestId: "turn-stored-bb" });
  assert.deepEqual(await ask("turn-stored-cc"), { status: "finished", outcome: "interrupted", requestId: "turn-stored-cc" },
    "a turn lost to a restart was not interrupted by this request");
});
