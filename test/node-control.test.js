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
    execute: async () => { executions += 1; throw new Error("private result details must not cross the relay"); },
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
