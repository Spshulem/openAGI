// The hub owns one queue per shared device conversation. A paired iPhone and
// the owner's Mac send to it at nearly the same moment while a turn runs:
// both must see the same waiting messages in the same order, nothing may run
// before the turn ahead of it, a resend of one id may never queue or run
// twice, and distinct messages may never replace or hide each other. Edits,
// removals and Send Now from one device apply for both, with conflicts
// refused, and the queue survives a hub restart.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { NodeRegistry } from "../src/node-registry.js";

const SESSION = "devices:supervisor:main";
const phone = { id: "mobile:queue-phone", token: "q".repeat(43) };
const glasses = { id: "g2:queue-glasses", token: "h".repeat(43) };
// A node acting for the owner's Mac (a worker forwarding to this main).
const proxy = { id: "mac:queue-proxy", token: "m".repeat(43), proxyToken: "x".repeat(43) };

function gate() {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return { opened, open };
}

function untilAborted(signal, promise) {
  return Promise.race([promise, new Promise((_, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  })]);
}

async function until(check, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met in time");
}

async function frames(response) {
  return (await response.text()).split("\n\n").map((block) => block.trim()).filter(Boolean).map((block) => {
    const lines = block.split("\n");
    return { event: lines.find((l) => l.startsWith("event: "))?.slice(7), data: JSON.parse(lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n") || "null") };
  });
}

// A hub with a model that blocks on "[slow]" until released (or stopped).
async function hub(t, { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-queue-")), keep = false, holdMs } = {}) {
  const nodeRegistry = new NodeRegistry({ dir: path.join(dataDir, "nodes") });
  if (!nodeRegistry.enrollment(phone.id)) nodeRegistry.enroll(phone.id, phone.token, { platform: "mobile", name: "iPhone" });
  if (!nodeRegistry.enrollment(glasses.id)) nodeRegistry.enroll(glasses.id, glasses.token, { platform: "even-g2", name: "G2" });
  if (!nodeRegistry.enrollment(proxy.id) && !fs.existsSync(path.join(dataDir, "proxy-revoked"))) {
    nodeRegistry.enroll(proxy.id, proxy.token, { platform: "macos", name: "Work Mac", ownerProxyToken: proxy.proxyToken });
  }
  const runtime = createDurableRuntime({ dataDir });
  const calls = [];
  const images = [];
  const slow = gate();
  runtime.agentHost.modelProvider = {
    name: "queue-test", model: "test", isConfigured: () => true,
    async generate(request) {
      calls.push(request.input);
      images.push((request.attachments ?? []).map((image) => image.data));
      if (String(request.input).includes("[slow]")) await untilAborted(request.context.signal, slow.opened);
      return { id: `r${calls.length}`, text: `Ack: ${request.input}`, provider: "test", model: "test", toolCalls: [] };
    }
  };
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, authToken: "owner", dataDir, nodeRegistry, tickerMs: 60_000, interruptSettleMs: 300, ...(holdMs ? { queueHoldMs: holdMs } : {}) });
  const { url: base } = await app.listen();
  // Releases any turn still waiting on the model first, unless the test is
  // cutting it off on purpose (a restart).
  const close = async ({ release = true } = {}) => { if (release) slow.open(); await app.close(); };
  t.after(async () => { await close().catch(() => {}); if (!keep) fs.rmSync(dataDir, { recursive: true, force: true }); });
  const auth = (who) => who === "mac" ? { authorization: "Bearer owner" }
    : who === "g2" ? { authorization: `Bearer ${glasses.token}`, "x-openagi-node-id": glasses.id }
    : who === "proxy" ? { authorization: `Bearer ${proxy.proxyToken}`, "x-openagi-node-id": proxy.id }
      : { authorization: `Bearer ${phone.token}`, "x-openagi-node-id": phone.id };
  const json = async (response) => ({ status: response.status, body: await response.json().catch(() => null) });
  const api = {
    base, runtime, calls, images, slow, dataDir, close, nodeRegistry,
    // A streamed send, as each app sends when it believes nothing is running.
    message: (who, body, { stream = true } = {}) => fetch(`${base}/message`, {
      method: "POST", headers: { ...auth(who), "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json" },
      body: JSON.stringify({ thread: "supervisor", ...(who === "mac" ? { from: "mac-supervisor" } : {}), ...body })
    }),
    // A send while the app knows something is running: queued, no stream.
    enqueue: async (who, body) => json(await fetch(`${base}/conversations/supervisor/queue`, {
      method: "POST", headers: { ...auth(who), "content-type": "application/json" },
      body: JSON.stringify({ ...(who === "mac" ? { from: "mac-supervisor" } : {}), ...body })
    })),
    queue: async (who) => json(await fetch(`${base}/conversations/supervisor/queue`, { headers: auth(who) })),
    history: async (who) => json(await fetch(`${base}/conversations/supervisor/messages`, { headers: auth(who) })),
    edit: async (who, id, body) => json(await fetch(`${base}/conversations/supervisor/queue/${id}`, {
      method: "PATCH", headers: { ...auth(who), "content-type": "application/json" }, body: JSON.stringify(body)
    })),
    remove: async (who, id, baseRevision) => json(await fetch(`${base}/conversations/supervisor/queue/${id}${baseRevision ? `?baseRevision=${baseRevision}` : ""}`, {
      method: "DELETE", headers: auth(who)
    })),
    sendNow: async (who, id) => json(await fetch(`${base}/conversations/supervisor/queue/${id}/send-now`, { method: "POST", headers: auth(who) })),
    stored: () => runtime.agentHost.store.getSession(SESSION).messages
      .filter((m) => ["user", "assistant"].includes(m.role)).map((m) => [m.role, m.content, m.metadata?.requestId ?? null])
  };
  return api;
}

const texts = (snapshot) => snapshot.items.map((item) => item.text);

test("an iPhone and a Mac sending at once while a turn runs see one queue, in one order, and nothing runs early", async (t) => {
  const h = await hub(t);
  const running = frames(await h.message("phone", { text: "[slow] long running turn", requestId: "ios-running-0001" }));
  await until(() => h.calls.length === 1);

  // Nearly simultaneous: both devices, both transports.
  const sent = await Promise.all([
    h.enqueue("phone", { text: "[ios-1] phone one", requestId: "ios-tagged-0001" }),
    h.message("mac", { text: "[mac-1] mac one", requestId: "mac-tagged-0001" }),
    h.enqueue("phone", { text: "[ios-2] phone two", requestId: "ios-tagged-0002" }),
    h.enqueue("mac", { text: "[mac-2] mac two", requestId: "mac-tagged-0002" })
  ]);
  const macStream = frames(sent[1]);
  assert.deepEqual([sent[0].status, sent[2].status, sent[3].status], [202, 202, 202]);

  const fromPhone = (await h.queue("phone")).body;
  const fromMac = (await h.queue("mac")).body;
  assert.equal(fromPhone.items.length, 5, "the running turn and all four waiting messages");
  assert.deepEqual(texts(fromPhone), texts(fromMac), "both devices see the same queue in the same order");
  assert.equal(fromPhone.items[0].state, "running");
  assert.deepEqual(fromPhone.items.slice(1).map((i) => i.state), ["queued", "queued", "queued", "queued"]);
  assert.deepEqual(fromPhone.items.slice(1).map((i) => i.source.name).sort(), ["Mac", "Mac", "iPhone", "iPhone"]);
  assert.deepEqual(fromPhone.items.map((i) => i.mine), [true, ...fromPhone.items.slice(1).map((i) => i.source.name === "iPhone")]);
  assert.deepEqual(fromMac.items.map((i) => i.mine), fromPhone.items.map((i) => !i.mine), "each device knows which are its own");
  assert.deepEqual((await h.history("phone")).body.queue.items.map((i) => i.requestId), fromPhone.items.map((i) => i.requestId), "history carries the same queue");
  assert.deepEqual(h.calls, ["[slow] long running turn"], "nothing queued runs before the turn ahead of it");

  h.slow.open();
  await running;
  assert.equal((await macStream).find((f) => f.event === "final").data.reply, "Ack: [mac-1] mac one", "the Mac's streamed send gets its own reply");
  await until(async () => (await h.queue("mac")).body.items.length === 0);
  assert.deepEqual(h.calls, ["[slow] long running turn", ...texts(fromPhone).slice(1)], "they run in the queue's order");
  assert.deepEqual(h.stored().filter(([role]) => role === "user").map(([, text]) => text), texts(fromPhone), "history matches the queue");
});

test("a resend of the same id never queues or runs twice; the same id for different text is refused", async (t) => {
  const h = await hub(t);
  const running = frames(await h.message("mac", { text: "[slow] busy", requestId: "mac-busy-00001" }));
  await until(() => h.calls.length === 1);
  const first = await h.enqueue("phone", { text: "only once", requestId: "ios-retry-00001" });
  const again = await h.enqueue("phone", { text: "only once", requestId: "ios-retry-00001" });
  assert.equal(first.body.duplicate, false);
  assert.equal(again.status, 202);
  assert.equal(again.body.duplicate, true);
  const conflict = await h.enqueue("phone", { text: "something else", requestId: "ios-retry-00001" });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, "request_conflict");
  // The phone lost its response and resends on /message: it follows the queued item.
  const attached = frames(await h.message("phone", { text: "only once", requestId: "ios-retry-00001" }));
  assert.equal((await h.queue("phone")).body.items.filter((i) => i.requestId === "ios-retry-00001").length, 1);
  h.slow.open();
  await running;
  assert.equal((await attached).find((f) => f.event === "final").data.reply, "Ack: only once");
  assert.deepEqual(h.calls, ["[slow] busy", "only once"], "ran once");
  const afterwards = await h.enqueue("phone", { text: "only once", requestId: "ios-retry-00001" });
  assert.equal(afterwards.body.duplicate, true, "a resend after it ran replays, never re-queues");
  assert.equal(afterwards.body.outcome, "complete");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(h.calls, ["[slow] busy", "only once"]);
});

test("many distinct messages from two devices at once are all kept, once each", async (t) => {
  const h = await hub(t);
  const running = frames(await h.message("phone", { text: "[slow] busy", requestId: "ios-busy-000001" }));
  await until(() => h.calls.length === 1);
  const sends = [];
  for (let i = 0; i < 12; i += 1) {
    sends.push(h.enqueue("phone", { text: `phone ${i}`, requestId: `ios-many-${String(i).padStart(5, "0")}` }));
    sends.push(h.enqueue("mac", { text: `mac ${i}`, requestId: `mac-many-${String(i).padStart(5, "0")}` }));
  }
  const results = await Promise.all(sends);
  assert.ok(results.every((r) => r.status === 202));
  const queued = (await h.queue("mac")).body.items.slice(1);
  assert.equal(queued.length, 24);
  assert.equal(new Set(queued.map((i) => i.requestId)).size, 24);
  h.slow.open();
  await running;
  await until(async () => (await h.queue("mac")).body.items.length === 0, 8_000);
  const ran = h.calls.slice(1);
  assert.equal(ran.length, 24);
  assert.deepEqual([...ran].sort(), [...queued.map((i) => i.text)].sort(), "every message ran exactly once");
  assert.deepEqual(ran, queued.map((i) => i.text), "in queue order");
});

test("an edit on the iPhone shows on the Mac; a stale or concurrent edit is refused; the hold keeps the old text from running", async (t) => {
  const h = await hub(t);
  const running = frames(await h.message("mac", { text: "[slow] busy", requestId: "mac-busy-00002" }));
  await until(() => h.calls.length === 1);
  await h.enqueue("phone", { text: "Tuesday", requestId: "ios-edit-000001" });
  await h.enqueue("mac", { text: "after it", requestId: "mac-after-00001" });
  const seen = (await h.queue("phone")).body.items[1];
  assert.equal(seen.revision, 1);

  // The phone opens its editor: the item is held for it.
  const held = await h.edit("phone", "ios-edit-000001", { hold: true });
  assert.equal(held.body.item.state, "held");
  assert.equal((await h.queue("mac")).body.items[1].heldBy, "iPhone", "the Mac sees who is editing");
  const macTry = await h.edit("mac", "ios-edit-000001", { text: "Thursday", baseRevision: 1, hold: false });
  assert.equal(macTry.status, 409);
  assert.equal(macTry.body.error, "held");
  assert.equal((await h.remove("mac", "ios-edit-000001")).body.error, "held", "nor removed while held");

  // The running turn ends while the editor is open: the queue waits there.
  h.slow.open();
  await running;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(h.calls, ["[slow] busy"], "neither the old text nor the item behind it ran");

  const saved = await h.edit("phone", "ios-edit-000001", { text: "Wednesday", baseRevision: 1, hold: false });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.item.revision, 2);
  await until(() => h.calls.length === 3);
  assert.deepEqual(h.calls, ["[slow] busy", "Wednesday", "after it"]);

  // A stale revision (the Mac saw revision 1) is a conflict, not a silent win.
  const h2 = await hub(t);
  const busy2 = frames(await h2.message("phone", { text: "[slow] busy", requestId: "ios-busy-00003" }));
  await until(() => h2.calls.length === 1);
  await h2.enqueue("mac", { text: "draft", requestId: "mac-draft-00001" });
  assert.equal((await h2.edit("phone", "mac-draft-00001", { text: "phone's version", baseRevision: 1 })).status, 200);
  const stale = await h2.edit("mac", "mac-draft-00001", { text: "mac's version", baseRevision: 1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "conflict");
  assert.equal(stale.body.item.text, "phone's version", "the refusal shows what it is now");
  assert.equal((await h2.edit("mac", "mac-draft-00001", { text: "no revision" })).status, 400);
  h2.slow.open();
  await busy2;
  await until(() => h2.calls.length === 2);
  assert.deepEqual(h2.calls, ["[slow] busy", "phone's version"]);
  assert.equal((await h2.edit("mac", "mac-draft-00001", { text: "late", baseRevision: 2 })).body.error, "already_sent");
});

test("an edit hold that is not renewed lapses, so a device that went away cannot block the queue", async (t) => {
  const h = await hub(t, { holdMs: 150 });
  const running = frames(await h.message("mac", { text: "[slow] busy", requestId: "mac-busy-00004" }));
  await until(() => h.calls.length === 1);
  await h.enqueue("phone", { text: "held then dropped", requestId: "ios-lapse-00001" });
  await h.edit("phone", "ios-lapse-00001", { hold: true });
  h.slow.open();
  await running;
  await until(() => h.calls.length === 2, 2_000);
  assert.deepEqual(h.calls, ["[slow] busy", "held then dropped"]);
});

test("a removal on the Mac takes the iPhone's message out for both, ends its stream, and a resend never brings it back", async (t) => {
  const h = await hub(t);
  const running = frames(await h.message("mac", { text: "[slow] busy", requestId: "mac-busy-00005" }));
  await until(() => h.calls.length === 1);
  const phoneStream = frames(await h.message("phone", { text: "never mind", requestId: "ios-remove-0001" }));
  await h.enqueue("phone", { text: "keep me", requestId: "ios-keep-000001" });
  await until(async () => (await h.queue("mac")).body.items.length === 3);
  const removed = await h.remove("mac", "ios-remove-0001", 1);
  assert.equal(removed.status, 200);
  assert.deepEqual(texts((await h.queue("phone")).body), ["[slow] busy", "keep me"]);
  const ended = (await phoneStream).find((f) => f.event === "failure");
  assert.equal(ended.data.code, "removed", "the sender hears it was removed");
  const resend = await frames(await h.message("phone", { text: "never mind", requestId: "ios-remove-0001" }));
  assert.equal(resend.find((f) => f.event === "failure").data.code, "removed");
  h.slow.open();
  await running;
  await until(() => h.calls.length === 2);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(h.calls, ["[slow] busy", "keep me"]);
  assert.equal((await h.remove("mac", "ios-keep-000001")).body.error, "already_sent");
});

test("Send Now on the Mac moves the iPhone's message first and stops the iPhone's running turn", async (t) => {
  const h = await hub(t);
  const running = frames(await h.message("phone", { text: "[slow] phone's long turn", requestId: "ios-long-000001" }));
  await until(() => h.calls.length === 1);
  await h.enqueue("mac", { text: "mac first", requestId: "mac-first-00001" });
  await h.enqueue("phone", { text: "correction", requestId: "ios-corr-000001" });
  await h.enqueue("mac", { text: "mac last", requestId: "mac-last-000001" });
  const now = await h.sendNow("mac", "ios-corr-000001");
  assert.equal(now.status, 200);
  assert.equal(now.body.status, "interrupted", "the running turn really stopped");
  assert.equal(now.body.interrupted, "ios-long-000001");
  assert.equal((await running).find((f) => f.event === "failure").data.code, "stopped");
  await until(() => h.calls.length === 4);
  assert.deepEqual(h.calls, ["[slow] phone's long turn", "correction", "mac first", "mac last"]);
  const sendAgain = await h.sendNow("phone", "ios-corr-000001");
  assert.equal(sendAgain.body.error, "already_sent");
});

test("waiting messages survive a hub restart and run afterwards; the one that was running is not rerun", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-queue-restart-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const first = await hub(t, { dataDir, keep: true });
  const cut = new AbortController();
  const running = fetch(`${first.base}/message`, {
    method: "POST", signal: cut.signal,
    headers: { authorization: `Bearer ${phone.token}`, "x-openagi-node-id": phone.id, "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ thread: "supervisor", text: "[slow] cut off by a restart", requestId: "ios-cut-0000001" })
  }).then((r) => r.text()).catch(() => null);
  await until(() => first.calls.length === 1);
  await first.enqueue("phone", { text: "phone after restart", requestId: "ios-survive-001" });
  await first.enqueue("mac", { text: "mac after restart", requestId: "mac-survive-001" });
  cut.abort();
  await running;
  // The hub stops while that turn is still mid-model: it never finishes.
  await first.close({ release: false });

  const second = await hub(t, { dataDir, keep: true });
  await until(() => second.calls.length === 2);
  assert.deepEqual(second.calls, ["phone after restart", "mac after restart"], "queued work ran in order; the cut-off turn did not rerun");
  const replies = second.stored().filter(([role]) => role === "assistant").map(([, text]) => text);
  assert.ok(replies.includes("Ack: phone after restart") && replies.includes("Ack: mac after restart"));
  assert.equal((await second.queue("mac")).body.items.length, 0);
});

test("only paired phones and the owner may use the queue", async (t) => {
  const h = await hub(t);
  assert.ok([401, 403].includes((await h.queue("g2")).status));
  assert.ok([401, 403].includes((await h.enqueue("g2", { text: "x", requestId: "g2-try-0000001" })).status));
  assert.equal((await h.enqueue("phone", { text: "no id" })).status, 400);
  assert.equal((await h.edit("phone", "ios-unknown-001", { text: "x", baseRevision: 1 })).body.error, "already_sent");
});

test("every queue change tells connected devices to reload", async (t) => {
  const h = await hub(t);
  const controller = new AbortController();
  const events = await fetch(`${h.base}/events`, { headers: { authorization: "Bearer owner" }, signal: controller.signal });
  const reader = events.body.getReader();
  let seen = "";
  const reading = (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; seen += new TextDecoder().decode(value); } })().catch(() => {});
  const running = frames(await h.message("phone", { text: "[slow] busy", requestId: "ios-busy-00009" }));
  await until(() => h.calls.length === 1);
  await h.enqueue("phone", { text: "notify", requestId: "ios-notify-0001" });
  await until(() => /event: conversation\.updated\ndata: \{[^\n]*"queueRevision"/.test(seen));
  controller.abort();
  await reading;
  h.slow.open();
  await running;
});

test("a long queued message comes back whole, so editing it never cuts it short", async (t) => {
  const h = await hub(t);
  const running = frames(await h.message("mac", { text: "[slow] busy", requestId: "mac-busy-00010" }));
  await until(() => h.calls.length === 1);
  const long = "x".repeat(20_000) + " the end";
  await h.enqueue("phone", { text: long, requestId: "ios-long-text-01" });
  const item = (await h.queue("mac")).body.items[1];
  assert.equal(item.text.length, long.length, "the full text, not a 16,000-character preview");
  assert.equal((await h.edit("mac", "ios-long-text-01", { text: item.text + "!", baseRevision: item.revision })).status, 200);
  h.slow.open();
  await running;
  await until(() => h.calls.length === 2);
  assert.equal(h.calls[1], long + "!");
});

test("a phone unpaired while its message waits never runs it", async (t) => {
  const h = await hub(t);
  const running = frames(await h.message("mac", { text: "[slow] busy", requestId: "mac-busy-00011" }));
  await until(() => h.calls.length === 1);
  const waiting = frames(await h.message("phone", { text: "from a phone about to be unpaired", requestId: "ios-unpair-0001" }));
  await until(async () => (await h.queue("mac")).body.items.length === 2);
  h.nodeRegistry.revoke(phone.id);
  h.slow.open();
  await running;
  const ended = (await waiting).find((f) => f.event === "failure");
  assert.equal(ended.data.code, "sender-unpaired");
  assert.deepEqual(h.calls, ["[slow] busy"], "it never reached the model");
  // Re-pair for later tests in this file that share the phone id.
  h.nodeRegistry.enroll(phone.id, phone.token, { platform: "mobile", name: "iPhone" });
});

test("an owner proxy revoked across a restart does not get its waiting messages run with owner authority", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-queue-proxy-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const first = await hub(t, { dataDir, keep: true });
  const cut = new AbortController();
  const running = fetch(`${first.base}/message`, {
    method: "POST", signal: cut.signal,
    headers: { authorization: "Bearer owner", "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ thread: "supervisor", from: "mac-supervisor", text: "[slow] busy", requestId: "mac-busy-00012" })
  }).then((r) => r.text()).catch(() => null);
  await until(() => first.calls.length === 1);
  const queued = await first.enqueue("proxy", { text: "proxy command", requestId: "mac-proxy-00001" });
  assert.equal(queued.status, 202);
  await first.enqueue("mac", { text: "owner command", requestId: "mac-owner-00001" });
  first.nodeRegistry.revoke(proxy.id);
  fs.writeFileSync(path.join(dataDir, "proxy-revoked"), "1");
  cut.abort();
  await running;
  await first.close({ release: false });

  const second = await hub(t, { dataDir, keep: true });
  await until(() => second.calls.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(second.calls, ["owner command"], "only the owner's own message ran");
  assert.equal(second.stored().some(([, text]) => text === "proxy command"), false);
});

test("a message dispatched while a turn without a requestId still runs is not lost to a restart", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-queue-legacy-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const first = await hub(t, { dataDir, keep: true });
  // An older client (or a G2 turn) sends without a requestId: it runs
  // outside the queue, and the next named message waits behind it.
  const cut = new AbortController();
  const legacy = fetch(`${first.base}/message`, {
    method: "POST", signal: cut.signal,
    headers: { authorization: "Bearer owner", "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ thread: "supervisor", text: "[slow] legacy turn" })
  }).then((r) => r.text()).catch(() => null);
  await until(() => first.calls.length === 1);
  await first.enqueue("phone", { text: "waiting behind it", requestId: "ios-behind-0001" });
  assert.equal((await first.queue("mac")).body.items[0].state, "running", "dispatched, but still waiting in AgentHost");
  cut.abort();
  await legacy;
  await first.close({ release: false });

  const second = await hub(t, { dataDir, keep: true });
  await until(() => second.calls.length === 1);
  assert.deepEqual(second.calls, ["waiting behind it"], "it never began, so it runs after the restart");
});

test("a phone unpaired while its dispatched message waits behind a turn without a requestId never runs it", async (t) => {
  const h = await hub(t);
  // A turn the queue does not hold (an older client, or a G2 turn): the
  // queue dispatches the phone's message at once, and it waits in
  // AgentHost's session order. Its authority is checked when it starts.
  const legacy = frames(await h.message("mac", { text: "[slow] legacy turn" }));
  await until(() => h.calls.length === 1);
  const waiting = frames(await h.message("phone", { text: "from a phone unpaired while it waits", requestId: "ios-unpair-0002" }));
  await until(async () => (await h.queue("mac")).body.items[0]?.state === "running");
  h.nodeRegistry.revoke(phone.id);
  h.slow.open();
  await legacy;
  const ended = (await waiting).find((f) => f.event === "failure");
  assert.equal(ended?.data.code, "sender-unpaired");
  assert.deepEqual(h.calls, ["[slow] legacy turn"], "it never reached the model");
  assert.equal(h.stored().some(([, text]) => text === "from a phone unpaired while it waits"), false);
  h.nodeRegistry.enroll(phone.id, phone.token, { platform: "mobile", name: "iPhone" });
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPQKHgAAAI8AXnXjkfVAAAAAElFTkSuQmCC";

test("Send anyway from the Mac stops the iPhone's reply midstream and goes next; pending messages keep their order", async (t) => {
  const h = await hub(t);
  const running = frames(await h.message("phone", { text: "[slow] phone's long reply", requestId: "ios-midstream-01" }));
  await until(() => h.calls.length === 1);
  await h.enqueue("phone", { text: "pending one", requestId: "ios-pending-0001" });
  await h.enqueue("mac", { text: "pending two", requestId: "mac-pending-0001" });
  const anyway = await h.enqueue("mac", { text: "Send anyway: stop and do this", requestId: "mac-anyway-0001", next: true });
  assert.equal(anyway.status, 202);
  assert.equal(anyway.body.sendNow.status, "interrupted", "the running reply really stopped");
  assert.equal(anyway.body.sendNow.interrupted, "ios-midstream-01");
  assert.deepEqual(anyway.body.queue.items.map((i) => i.text).slice(0, 3), ["Send anyway: stop and do this", "pending one", "pending two"]);
  assert.equal((await running).find((f) => f.event === "failure").data.code, "stopped");
  await until(() => h.calls.length === 4);
  assert.deepEqual(h.calls, ["[slow] phone's long reply", "Send anyway: stop and do this", "pending one", "pending two"]);
  // A retry of the same Send anyway (a lost answer) queues and runs nothing twice.
  const again = await h.enqueue("mac", { text: "Send anyway: stop and do this", requestId: "mac-anyway-0001", next: true });
  assert.equal(again.body.duplicate, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(h.calls.length, 4);
  assert.equal((await h.enqueue("mac", { text: "x", requestId: "mac-badnext-001", next: "yes" })).status, 400);
});

test("Send anyway when nothing is running just sends; the stopped reply's late output never reaches the next message", async (t) => {
  const h = await hub(t);
  const idle = await h.enqueue("phone", { text: "nothing was running", requestId: "ios-idle-000001", next: true });
  assert.equal(idle.status, 202);
  await until(() => h.calls.length === 1);

  // A provider that still emits text after it was told to stop.
  h.runtime.agentHost.modelProvider = {
    name: "late", model: "late", isConfigured: () => true,
    async generate(request) {
      h.calls.push(request.input);
      if (String(request.input).includes("[slow]")) {
        try { await untilAborted(request.context.signal, new Promise(() => {})); }
        catch (error) { request.onTextDelta?.({ text: "LATE TEXT FROM THE STOPPED REPLY" }); throw error; }
      }
      request.onTextDelta?.({ text: `streamed ${request.input}` });
      return { id: "x", text: `Ack: ${request.input}`, provider: "t", model: "t", toolCalls: [] };
    }
  };
  const old = frames(await h.message("mac", { text: "[slow] to be stopped", requestId: "mac-stale-00001" }));
  await until(() => h.calls.length === 2);
  const nextStream = frames(await h.message("phone", { text: "the correction", requestId: "ios-fence-00001" }));
  assert.equal((await h.sendNow("phone", "ios-fence-00001")).body.status, "interrupted");
  const next = await nextStream;
  assert.equal(next.find((f) => f.event === "final").data.reply, "Ack: the correction");
  assert.ok(!JSON.stringify(next).includes("LATE TEXT"), "no stale text in the next message's stream");
  await old;
  assert.ok(!h.stored().some(([, text]) => text.includes("LATE TEXT")), "nor in history");
});

test("a message is acknowledged only once it is saved: if the hub can't save it, it is not queued", async (t) => {
  const h = await hub(t);
  const running = frames(await h.message("mac", { text: "[slow] busy", requestId: "mac-busy-00013" }));
  await until(() => h.calls.length === 1);
  const dir = path.join(h.dataDir, "conversation-queues");
  fs.chmodSync(dir, 0o500);
  t.after(() => { try { fs.chmodSync(dir, 0o700); } catch { /* already removed */ } });
  const refused = await h.enqueue("phone", { text: "cannot be saved", requestId: "ios-nosave-0001" });
  fs.chmodSync(dir, 0o700);
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error, "queue_unavailable");
  assert.deepEqual((await h.queue("mac")).body.items.map((i) => i.text), ["[slow] busy"], "no copy kept to run unannounced");
  const retried = await h.enqueue("phone", { text: "cannot be saved", requestId: "ios-nosave-0001" });
  assert.equal(retried.status, 202, "the same message can be sent again once saving works");
  h.slow.open();
  await running;
  await until(() => h.calls.length === 2);
  assert.deepEqual(h.calls, ["[slow] busy", "cannot be saved"]);
});

test("a queued message's images survive a hub restart and reach the model", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-queue-images-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const first = await hub(t, { dataDir, keep: true });
  const cut = new AbortController();
  const running = fetch(`${first.base}/message`, {
    method: "POST", signal: cut.signal,
    headers: { authorization: "Bearer owner", "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ thread: "supervisor", from: "mac-supervisor", text: "[slow] busy", requestId: "mac-busy-00014" })
  }).then((r) => r.text()).catch(() => null);
  await until(() => first.calls.length === 1);
  const queued = await first.enqueue("phone", { text: "what is in this picture", requestId: "ios-image-00001",
    attachments: [{ name: "Synthetic.png", mimeType: "image/png", data: PNG }] });
  assert.equal(queued.status, 202);
  assert.equal(queued.body.queue.items[1].attachmentCount, 1);
  cut.abort();
  await running;
  await first.close({ release: false });

  const second = await hub(t, { dataDir, keep: true });
  await until(() => second.calls.length === 1);
  assert.equal(second.calls[0], "what is in this picture");
  assert.deepEqual(second.images[0], [PNG], "the picture itself, not a preview");
});

test("a message stopped while dispatched behind a turn without a requestId stays stopped across a restart", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-queue-unstarted-stop-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const first = await hub(t, { dataDir, keep: true });
  const cut = new AbortController();
  const legacy = fetch(`${first.base}/message`, {
    method: "POST", signal: cut.signal,
    headers: { authorization: "Bearer owner", "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ thread: "supervisor", text: "[slow] legacy turn" })
  }).then((r) => r.text()).catch(() => null);
  await until(() => first.calls.length === 1);
  await first.enqueue("phone", { text: "stop me before I start", requestId: "ios-stopwait-001" });
  assert.equal((await first.queue("mac")).body.items[0].state, "running", "dispatched, still waiting in AgentHost");
  const stop = await fetch(`${first.base}/conversations/supervisor/interrupt`, {
    method: "POST", headers: { authorization: "Bearer owner", "content-type": "application/json" },
    body: JSON.stringify({ requestId: "ios-stopwait-001" })
  });
  assert.equal((await stop.json()).status, "interrupted");
  assert.deepEqual((await first.queue("mac")).body.ended.map((e) => [e.requestId, e.outcome]), [["ios-stopwait-001", "stopped"]]);
  cut.abort();
  await legacy;
  await first.close({ release: false });

  const second = await hub(t, { dataDir, keep: true });
  const resend = await frames(await second.message("phone", { text: "stop me before I start", requestId: "ios-stopwait-001" }));
  assert.equal(resend.find((f) => f.event === "failure").data.code, "stopped");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(second.calls, [], "the stopped message never ran");
});

test("a removal on one device is visible to a device that lost its stream, through the queue's ended list", async (t) => {
  const h = await hub(t);
  const running = frames(await h.message("mac", { text: "[slow] busy", requestId: "mac-busy-00015" }));
  await until(() => h.calls.length === 1);
  await h.enqueue("phone", { text: "will be removed", requestId: "ios-gone-000002" });
  await h.remove("mac", "ios-gone-000002");
  const history = (await h.history("phone")).body;
  assert.deepEqual(history.queue.ended.map((e) => [e.requestId, e.outcome]), [["ios-gone-000002", "removed"]]);
  assert.match(history.queue.ended[0].message, /Removed from the queue by Mac/);
  h.slow.open();
  await running;
});
