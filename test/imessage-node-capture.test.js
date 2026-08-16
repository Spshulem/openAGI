import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

async function startMain() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-node-capture-"));
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1",
    port: 0,
    tickerMs: 0,
    dataDir,
    authToken: "main-owner-token"
  });
  const address = await app.listen();
  return { dataDir, runtime, app, base: address.url };
}

async function enroll(base, nodeId, nodeToken) {
  const response = await fetch(`${base}/nodes/enroll`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer main-owner-token"
    },
    body: JSON.stringify({ nodeId, nodeToken })
  });
  assert.equal(response.status, 200);
}

function headers(nodeId, token) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    "x-openagi-node-id": nodeId
  };
}

test("scoped iMessage node can capture bounded memory without receiving general memory authority", async () => {
  const { dataDir, runtime, app, base } = await startMain();
  const nodeId = "node-capture-one";
  const nodeToken = Buffer.alloc(32, 1).toString("base64url");
  try {
    await enroll(base, nodeId, nodeToken);
    const captured = await fetch(`${base}/nodes/capture-memory`, {
      method: "POST",
      headers: headers(nodeId, nodeToken),
      body: JSON.stringify({
        content: "A bounded incoming message",
        tags: ["imessage", "trusted-contact"],
        importance: "normal"
      })
    });
    assert.equal(captured.status, 200);
    const snapshot = runtime.memory.snapshot();
    const item = [...snapshot.short, ...snapshot.medium, ...snapshot.long]
      .find((candidate) => candidate.content === "A bounded incoming message");
    assert.ok(item);
    assert.equal(item.source, "imessage-bridge");
    assert.equal(item.scope, "main");
    assert.ok(item.tags.includes("node-capture"));
    assert.equal(item.metadata.nodeId, nodeId);

    const broad = await fetch(`${base}/memory/remember`, {
      method: "POST",
      headers: headers(nodeId, nodeToken),
      body: JSON.stringify({ content: "must not be accepted" })
    });
    assert.equal(broad.status, 401, "scoped credentials never grant the general memory import route");
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("node capture rejects owner tokens, cross-node credentials, oversized data, and extra authority", async () => {
  const { dataDir, app, base } = await startMain();
  const first = { id: "node-capture-first", token: Buffer.alloc(32, 2).toString("base64url") };
  const second = { id: "node-capture-second", token: Buffer.alloc(32, 3).toString("base64url") };
  try {
    await enroll(base, first.id, first.token);
    await enroll(base, second.id, second.token);
    const attempts = [
      fetch(`${base}/nodes/capture-memory`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer main-owner-token" },
        body: JSON.stringify({ content: "owner token is too broad" })
      }),
      fetch(`${base}/nodes/capture-memory`, {
        method: "POST",
        headers: headers(first.id, second.token),
        body: JSON.stringify({ content: "cross-node attempt" })
      }),
      fetch(`${base}/nodes/capture-memory`, {
        method: "POST",
        headers: headers(first.id, first.token),
        body: JSON.stringify({ content: "x".repeat(8 * 1024 + 1) })
      }),
      fetch(`${base}/nodes/capture-memory`, {
        method: "POST",
        headers: headers(first.id, first.token),
        body: JSON.stringify({ content: "bounded", scope: "specialist:anything" })
      }),
      fetch(`${base}/message`, {
        method: "POST",
        headers: headers(first.id, first.token),
        body: JSON.stringify({ text: "x".repeat(64 * 1024 + 1), from: "imessage:test" })
      }),
      fetch(`${base}/message`, {
        method: "POST",
        headers: headers(first.id, first.token),
        body: JSON.stringify({ text: "bounded", from: "imessage:test", metadata: { elevated: true } })
      })
    ];
    const responses = await Promise.all(attempts);
    assert.deepEqual(responses.map((response) => response.status), [401, 401, 400, 400, 400, 400]);
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("scoped node messages cannot address an owner chat or inherit its computer-use lease", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-node-message-binding-"));
  const runtime = createDurableRuntime({ dataDir });
  const received = [];
  const channels = {
    async handleLocalMessage(body) {
      received.push(body);
      return { reply: "ok", session: { id: body.sessionId } };
    },
    start() {},
    stop() {}
  };
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1",
    port: 0,
    tickerMs: 0,
    dataDir,
    authToken: "main-owner-token",
    channels
  });
  const address = await app.listen();
  const nodeId = "node-message-binding";
  const nodeToken = Buffer.alloc(32, 4).toString("base64url");
  const ownerSessionId = "local:owner-chat:main";
  runtime.computerUseLog.startSession({
    goal: "Owner-approved work",
    approvedBy: "user",
    approvalActionId: "act_owner",
    sourceSessionId: ownerSessionId
  });

  try {
    await enroll(address.url, nodeId, nodeToken);
    const adversarial = await fetch(`${address.url}/message`, {
      method: "POST",
      headers: headers(nodeId, nodeToken),
      body: JSON.stringify({
        text: "Try the owner's active session",
        from: "owner-chat",
        sessionId: ownerSessionId
      })
    });
    assert.equal(adversarial.status, 200);
    assert.equal(received.length, 1);
    const bound = received[0];
    assert.equal(bound.channel, "node");
    assert.equal(bound.agentId, "main");
    assert.equal(bound.metadata.sourceNodeId, nodeId);
    assert.match(bound.from, new RegExp(`^node:${nodeId}:`));
    assert.notEqual(bound.from, "owner-chat");
    assert.ok(!bound.from.includes("owner-chat"), "caller-controlled from is only a hashed conversation discriminator");
    assert.notEqual(bound.sessionId, ownerSessionId);
    assert.equal(runtime.computerUseLog.activeSessionFor(bound.sessionId), null,
      "the scoped request must not inherit the owner's approved lease");
    assert.ok(runtime.computerUseLog.activeSessionFor(ownerSessionId),
      "the original owner lease remains bound to its owner chat");

    const sameConversation = await fetch(`${address.url}/message`, {
      method: "POST",
      headers: headers(nodeId, nodeToken),
      body: JSON.stringify({
        text: "Continue the same iMessage conversation",
        from: "owner-chat",
        sessionId: "another-owner-session"
      })
    });
    const otherConversation = await fetch(`${address.url}/message`, {
      method: "POST",
      headers: headers(nodeId, nodeToken),
      body: JSON.stringify({
        text: "A different iMessage conversation",
        from: "imessage:another-conversation"
      })
    });
    assert.equal(sameConversation.status, 200);
    assert.equal(otherConversation.status, 200);
    assert.equal(received[1].sessionId, bound.sessionId,
      "the bridge's from value deterministically continues its node-scoped conversation");
    assert.notEqual(received[2].sessionId, bound.sessionId,
      "different bridge conversations remain separate inside the node namespace");
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
