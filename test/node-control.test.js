import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createNodeControlWorker, NodeControlBroker, sanitizeNodeCapabilities } from "../src/node-control.js";
import { NodeRegistry } from "../src/node-registry.js";

const capability = () => [{
  id: "computer-use",
  ready: true,
  operations: ["session.start", "session.end", "screenshot", "click", "move", "type", "key", "scroll"],
  checkedAt: new Date().toISOString()
}];

test("capability advertisements discard endpoint, token, and executable fields", () => {
  const out = sanitizeNodeCapabilities([{
    ...capability()[0],
    url: "http://metadata.internal",
    token: "secret",
    command: "rm",
    operations: ["screenshot", "../escape", "click"]
  }]);
  assert.deepEqual(out[0].operations, ["screenshot", "click"]);
  assert.equal("url" in out[0], false);
  assert.equal("token" in out[0], false);
  assert.equal("command" in out[0], false);
});

test("broker dispatches only to the selected ready node and rejects mismatched results", async () => {
  const broker = new NodeControlBroker({ commandTimeoutMs: 1_000 });
  broker.advertise("node-a", capability());
  broker.advertise("node-b", capability());
  assert.equal(broker.resolve("computer-use"), null, "multiple eligible nodes require an explicit selector");
  assert.equal(broker.resolve("computer-use", { nodeId: "node-a" })?.nodeId, "node-a");
  const pending = broker.dispatch("node-a", "computer-use", "screenshot", { leaseId: "l" });
  const command = await broker.poll("node-a", capability(), { timeoutMs: 10 });
  assert.equal(command.nodeId, "node-a");
  assert.equal(await broker.poll("node-b", capability(), { timeoutMs: 1 }), null);
  assert.equal(broker.deliver("node-b", command.id, { result: { stolen: true } }), false);
  assert.equal(broker.deliver("node-a", command.id, { result: { ok: true } }), true);
  assert.deepEqual(await pending, { ok: true });
  assert.equal(broker.deliver("node-a", command.id, { result: { duplicate: true } }), true,
    "a lost result ACK can be retried without replaying the command");
  assert.equal(broker.deliver("node-b", command.id, { result: { duplicate: true } }), false,
    "a settled command remains bound to its original node");
  const rejectedPending = broker.dispatch("node-a", "computer-use", "screenshot", { leaseId: "l" });
  const rejectedCommand = await broker.poll("node-a", capability(), { timeoutMs: 10 });
  assert.equal(broker.deliver("node-a", rejectedCommand.id, {
    error: "node-capability-command-rejected"
  }), true);
  await assert.rejects(rejectedPending, (error) => (
    error.nodeAcknowledged === true && error.nodeSequenceConsumed !== true
  ));
  broker.close();
});

test("broker keeps session revocation available when computer input readiness drops", async () => {
  const broker = new NodeControlBroker({ commandTimeoutMs: 1_000 });
  const blocked = [{
    id: "computer-use",
    ready: false,
    operations: ["session.end", "screenshot"],
    detail: "screen locked"
  }];
  broker.advertise("node-locked", blocked);
  await assert.rejects(
    broker.dispatch("node-locked", "computer-use", "screenshot", {}),
    /not ready/
  );
  const pending = broker.dispatch("node-locked", "computer-use", "session.end", { leaseId: "lease-one" });
  const command = await broker.poll("node-locked", blocked, { timeoutMs: 10 });
  assert.equal(command.operation, "session.end");
  broker.deliver("node-locked", command.id, { result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });
  broker.close();
});

test("broker rejects the oldest command instead of stranding it when a node queue is full", async () => {
  const broker = new NodeControlBroker({ commandTimeoutMs: 60_000 });
  broker.advertise("node-a", capability());
  const outcomes = Array.from({ length: 21 }, (_, index) => (
    broker.dispatch("node-a", "computer-use", "screenshot", { index })
      .then(() => "resolved", (error) => error.message)
  ));
  assert.match(await outcomes[0], /queue is full/);
  broker.close();
  await Promise.all(outcomes);
});

test("worker pins the remote origin, refuses redirects, and sends only generic execution errors", async () => {
  assert.throws(() => createNodeControlWorker({
    remote: "https://user:secret@example.test/path?token=x",
    token: "scoped",
    nodeId: "node-a",
    capabilities: async () => [],
    execute: async () => ({})
  }), /without credentials, path, query, or fragment/);
  assert.throws(() => createNodeControlWorker({
    remote: "http://main.example.test",
    token: "scoped",
    nodeId: "node-a",
    capabilities: async () => [],
    execute: async () => ({})
  }), /requires HTTPS/);
  assert.doesNotThrow(() => createNodeControlWorker({
    remote: "http://relay.example.test",
    token: "scoped",
    nodeId: "node-a",
    capabilities: async () => [],
    execute: async () => ({}),
    allowInsecureRemote: true
  }), "plain HTTP outside loopback requires an explicit encrypted-tunnel assertion");

  let finishResult;
  const resultSent = new Promise((resolve) => { finishResult = resolve; });
  let polls = 0;
  let resultAttempts = 0;
  let executions = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, "manual");
    if (url.endsWith("/nodes/control/result")) {
      resultAttempts += 1;
      if (resultAttempts === 1) throw new Error("response lost after execution");
      finishResult(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    polls += 1;
    if (polls === 1) {
      return new Response(JSON.stringify({
        command: {
          id: "ncmd_one",
          nodeId: "node-a",
          capability: "imessage-search",
          operation: "search",
          payload: { query: "hello" },
          expiresAt: new Date(Date.now() + 5_000).toISOString()
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return await new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("stopped"), { name: "AbortError" })), { once: true });
    });
  };
  const worker = createNodeControlWorker({
    remote: "https://main.example.test",
    token: "scoped",
    nodeId: "node-a",
    capabilities: async () => [{ id: "imessage-search", ready: true, operations: ["search"] }],
    execute: async () => {
      executions += 1;
      throw Object.assign(new Error("private result details must not cross the relay"), {
        nodeSequenceConsumed: true
      });
    },
    fetchImpl,
    pollMs: 50,
    retryMs: 1
  });
  worker.start();
  const sent = await resultSent;
  assert.equal(sent.error, "node-capability-command-failed");
  assert.equal(JSON.stringify(sent).includes("private result details"), false);
  assert.equal(executions, 1, "result delivery retry must not execute the command twice");
  assert.equal(resultAttempts, 2);
  await worker.stop();
});

test("worker keeps polling so session stop can overtake and cancel an in-flight action", async () => {
  const broker = new NodeControlBroker({ commandTimeoutMs: 2_000 });
  const advertised = capability();
  let releaseAction;
  let markActionStarted;
  let markEndStarted;
  const actionStarted = new Promise((resolve) => { markActionStarted = resolve; });
  const endStarted = new Promise((resolve) => { markEndStarted = resolve; });
  const actionGate = new Promise((resolve) => { releaseAction = resolve; });
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith("/nodes/control/poll")) {
      const command = await broker.poll(body.nodeId, body.capabilities, {
        timeoutMs: 50,
        signal: options.signal
      });
      return new Response(JSON.stringify({ command }), { status: 200 });
    }
    const accepted = broker.deliver(body.nodeId, body.commandId, {
      result: body.result,
      error: body.error
    });
    return new Response(JSON.stringify({ ok: accepted }), { status: accepted ? 200 : 409 });
  };
  const worker = createNodeControlWorker({
    remote: "https://main.example.test",
    token: "scoped",
    nodeId: "node-a",
    capabilities: async () => advertised,
    execute: async (command) => {
      if (command.operation === "click") {
        markActionStarted();
        await actionGate;
        return { late: true };
      }
      if (command.operation === "session.end") {
        markEndStarted();
        releaseAction();
        return { ok: true };
      }
      return {};
    },
    fetchImpl,
    pollMs: 50,
    retryMs: 1
  });
  worker.start();
  while (!broker.resolve("computer-use", { nodeId: "node-a" })) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  const pendingAction = broker.dispatch(
    "node-a", "computer-use", "click", {}, { sessionId: "session-one" }
  ).catch((error) => error);
  await actionStarted;
  assert.deepEqual(broker.cancelSession("session-one"), { cancelled: 1, delivered: 1 });
  const cancelled = await pendingAction;
  assert.equal(cancelled.nodeSequenceConsumed, true);

  const pendingEnd = broker.dispatch(
    "node-a", "computer-use", "session.end", {}, { sessionId: "session-one" }
  );
  await endStarted;
  assert.deepEqual(await pendingEnd, { ok: true });
  await worker.stop();
  broker.close();
});

test("a saturated worker reserves a poll for revocation and does not run more ordinary work", async () => {
  const broker = new NodeControlBroker({ commandTimeoutMs: 5_000 });
  const advertised = capability();
  const releases = new Map();
  const started = new Set();
  let sawRevocationsOnly = false;
  let markEndStarted;
  const endStarted = new Promise((resolve) => { markEndStarted = resolve; });

  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith("/nodes/control/poll")) {
      if (body.revocationsOnly === true) sawRevocationsOnly = true;
      const command = await broker.poll(body.nodeId, body.capabilities, {
        timeoutMs: body.timeoutMs,
        revocationsOnly: body.revocationsOnly === true,
        signal: options.signal
      });
      return new Response(JSON.stringify({ command }), { status: 200 });
    }
    const accepted = broker.deliver(body.nodeId, body.commandId, {
      result: body.result,
      error: body.error
    });
    return new Response(JSON.stringify({ ok: accepted }), { status: accepted ? 200 : 409 });
  };

  const worker = createNodeControlWorker({
    remote: "https://main.example.test",
    token: "scoped",
    nodeId: "node-a",
    capabilities: async () => advertised,
    execute: async (command) => {
      if (command.operation === "session.end") {
        markEndStarted();
        releases.get(command.sessionId)?.();
        return { ok: true };
      }
      started.add(command.sessionId);
      await new Promise((resolve) => { releases.set(command.sessionId, resolve); });
      return { ok: true };
    },
    fetchImpl,
    pollMs: 50,
    retryMs: 1
  });
  worker.start();
  while (!broker.resolve("computer-use", { nodeId: "node-a" })) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  const ordinary = Array.from({ length: 16 }, (_, index) => broker.dispatch(
    "node-a",
    "computer-use",
    "click",
    {},
    { sessionId: `session-${index}` }
  ).catch((error) => error));
  while (started.size < 16) await new Promise((resolve) => setTimeout(resolve, 1));

  assert.deepEqual(broker.cancelSession("session-0"), { cancelled: 1, delivered: 1 });
  const pendingEnd = broker.dispatch(
    "node-a",
    "computer-use",
    "session.end",
    {},
    { sessionId: "session-0", timeoutMs: 1_000 }
  );
  await endStarted;
  assert.equal(sawRevocationsOnly, true, "the seventeenth ordinary slot must be reserved for Stop");
  assert.deepEqual(await pendingEnd, { ok: true });

  for (const release of releases.values()) release();
  await Promise.all(ordinary);
  await worker.stop();
  broker.close();
});

test("the reserved revocation lane stays bounded when session end execution blocks", async () => {
  let pollCount = 0;
  let endExecutions = 0;
  const releases = [];
  const fetchImpl = async (url) => {
    if (url.endsWith("/nodes/control/poll")) {
      pollCount += 1;
      return new Response(JSON.stringify({
        command: {
          id: `end-${pollCount}`,
          nodeId: "node-a",
          capability: "computer-use",
          operation: "session.end",
          payload: { leaseId: `lease-${pollCount}` },
          sessionId: `session-${pollCount}`,
          expiresAt: new Date(Date.now() + 10_000).toISOString()
        }
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const worker = createNodeControlWorker({
    remote: "https://main.example.test",
    token: "scoped",
    nodeId: "node-a",
    capabilities: async () => capability(),
    execute: async () => {
      endExecutions += 1;
      await new Promise((resolve) => { releases.push(resolve); });
      return { ok: true };
    },
    fetchImpl,
    pollMs: 10,
    retryMs: 1
  });
  worker.start();
  while (endExecutions < 1) await new Promise((resolve) => setTimeout(resolve, 1));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(endExecutions, 1);
  assert.equal(pollCount, 1, "no second Stop is accepted while the reserved lane is occupied");
  releases[0]();
  while (endExecutions < 2) await new Promise((resolve) => setTimeout(resolve, 1));
  const stopping = worker.stop();
  releases[1]();
  await stopping;
});

test("worker stop remains bounded when a revocation executor ignores cancellation", async () => {
  let started = false;
  let polls = 0;
  const worker = createNodeControlWorker({
    remote: "https://main.example.test",
    token: "scoped",
    nodeId: "node-a",
    capabilities: async () => capability(),
    execute: async () => {
      started = true;
      await new Promise(() => {});
    },
    fetchImpl: async (url) => {
      if (url.endsWith("/nodes/control/poll")) {
        polls += 1;
        return new Response(JSON.stringify({
          command: polls === 1 ? {
            id: "end-stuck",
            nodeId: "node-a",
            capability: "computer-use",
            operation: "session.end",
            payload: { leaseId: "lease-stuck" },
            sessionId: "session-stuck",
            expiresAt: new Date(Date.now() + 10_000).toISOString()
          } : null
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    pollMs: 10,
    retryMs: 1
  });
  worker.start();
  while (!started) await new Promise((resolve) => setTimeout(resolve, 1));
  const before = Date.now();
  await worker.stop();
  assert.ok(Date.now() - before < 1_500, "stop must not wait forever on an uncooperative executor");
});

test("worker stop does not start a new poll after a delayed capability probe settles", async () => {
  let releaseCapabilities;
  let markCapabilitiesStarted;
  const capabilitiesStarted = new Promise((resolve) => { markCapabilitiesStarted = resolve; });
  const capabilitiesGate = new Promise((resolve) => { releaseCapabilities = resolve; });
  let fetchCalls = 0;
  const worker = createNodeControlWorker({
    remote: "https://main.example.test",
    token: "scoped",
    nodeId: "node-a",
    capabilities: async () => {
      markCapabilitiesStarted();
      await capabilitiesGate;
      return capability();
    },
    execute: async () => ({}),
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ command: null }), { status: 200 });
    },
    pollMs: 20_000,
    retryMs: 1
  });
  worker.start();
  await capabilitiesStarted;
  const stopping = worker.stop();
  releaseCapabilities();
  await stopping;
  assert.equal(fetchCalls, 0, "shutdown must not launch a poll after its abort sweep");
});

test("an undelivered revocation survives its caller timeout and stays ahead of ordinary work", async () => {
  const broker = new NodeControlBroker({ commandTimeoutMs: 10 });
  broker.advertise("node-a", capability());
  const ordinary = broker.dispatch(
    "node-a", "computer-use", "click", {}, { timeoutMs: 1_000 }
  ).catch((error) => error);
  await assert.rejects(
    broker.dispatch(
      "node-a", "computer-use", "session.end", { leaseId: "lease-one" }, { timeoutMs: 10 }
    ),
    /timed out/
  );

  const revocation = await broker.poll("node-a", capability(), { timeoutMs: 10 });
  assert.equal(revocation.operation, "session.end", "revocation stays queued and is delivered first");
  assert.equal(broker.deliver("node-a", revocation.id, { result: { ok: true } }), true,
    "a detached revocation result is idempotently acknowledged");
  const next = await broker.poll("node-a", capability(), { timeoutMs: 10 });
  assert.equal(next.operation, "click");
  broker.deliver("node-a", next.id, { result: { ok: true } });
  assert.deepEqual(await ordinary, { ok: true });
  broker.close();
});

test("a delivered revocation is replayed after a lost response until its result is acknowledged", async () => {
  const broker = new NodeControlBroker({ commandTimeoutMs: 10 });
  broker.advertise("node-a", capability());
  const pendingEnd = broker.dispatch(
    "node-a", "computer-use", "session.end", { leaseId: "lease-one" }, { timeoutMs: 10 }
  );
  const firstDelivery = await broker.poll("node-a", capability(), { timeoutMs: 10 });
  assert.equal(firstDelivery.operation, "session.end");
  await assert.rejects(pendingEnd, /timed out/);

  const replay = await broker.poll("node-a", capability(), { timeoutMs: 10 });
  assert.equal(replay.id, firstDelivery.id, "reconnect receives the same idempotent revocation command");
  assert.equal(broker.deliver("node-a", replay.id, { result: { ok: true } }), true);
  assert.equal(await broker.poll("node-a", capability(), { timeoutMs: 10 }), null,
    "the authenticated ACK removes the retained revocation");
  broker.close();
});

test("timed-out queued commands are removed and can never execute later", async () => {
  const broker = new NodeControlBroker({ commandTimeoutMs: 10 });
  broker.advertise("node-a", capability());
  await assert.rejects(
    broker.dispatch("node-a", "computer-use", "click", { leaseId: "l" }),
    /timed out/
  );
  assert.equal(await broker.poll("node-a", capability(), { timeoutMs: 1 }), null);
  broker.close();
});

test("node enrollment stores only a hash and binds authentication to node id", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-node-auth-"));
  const registry = new NodeRegistry({ dir });
  const token = "a".repeat(43);
  assert.deepEqual(registry.enroll("node-a", token), { created: true });
  assert.equal(registry.authenticate("node-a", token), true);
  assert.equal(registry.authenticate("node-b", token), false);
  assert.equal(registry.authenticate("node-a", "wrong"), false);
  assert.deepEqual(registry.enroll("node-a", token), { created: false }, "a lost enrollment response is safe to retry");
  assert.throws(() => registry.enroll("node-a", "b".repeat(43)), /already enrolled/);
  const persisted = fs.readFileSync(path.join(dir, "registry.json"), "utf8");
  assert.equal(persisted.includes(token), false, "scoped node token is hashed at rest");
  assert.equal(registry.revoke("node-a"), true);
  assert.equal(registry.authenticate("node-a", token), false);
  assert.deepEqual(registry.enroll("node-a", "b".repeat(43)), { created: true });
  fs.rmSync(dir, { recursive: true, force: true });
});
