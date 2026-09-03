import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EVEN_G2_CAPABILITIES,
  EVEN_G2_PLATFORM,
  G2Channel,
  G2ChannelError
} from "../src/integrations/g2-channel.js";
import { NodeEnrollmentCodes } from "../src/node-enrollment.js";
import { NodeRegistry } from "../src/node-registry.js";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { isPublicRoute } from "../src/auth.js";

function wavBase64(seconds = 0.2) {
  const pcmBytes = Math.floor(16_000 * 2 * seconds);
  const wav = Buffer.alloc(44 + pcmBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + pcmBytes, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcmBytes, 40);
  return wav.toString("base64");
}

function makeChannel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-g2-channel-"));
  const nodeRegistry = new NodeRegistry({ dir: path.join(dir, "nodes") });
  const nodeId = crypto.randomUUID();
  nodeRegistry.enroll(nodeId, "n".repeat(43), {
    platform: EVEN_G2_PLATFORM,
    name: "Test G2",
    capabilities: EVEN_G2_CAPABILITIES
  });
  const turns = [];
  const channel = new G2Channel({
    dir: path.join(dir, "g2"),
    nodeRegistry,
    apiKey: "test-openai-key",
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.authorization, "Bearer test-openai-key");
      assert.ok(init.body instanceof FormData);
      return { ok: true, json: async () => ({ text: "What is on my calendar?" }) };
    },
    agentHost: {
      handleMessage: async (input) => {
        turns.push(input);
        return { reply: "You have a planning call at 2 PM.", session: { id: input.sessionId } };
      }
    }
  });
  return { channel, turns, nodeId, nodeRegistry };
}

test("an enrolled G2 node is transiently transcribed into a node-bound chat", async () => {
  const { channel, turns, nodeId } = makeChannel();
  const conversationId = crypto.randomUUID();
  const result = await channel.ask({ audioBase64: wavBase64(), conversationId, sessionId: "owner-session" }, nodeId);

  assert.equal(result.question, "What is on my calendar?");
  assert.equal(result.reply, "You have a planning call at 2 PM.");
  assert.match(result.sessionId, /^node:/);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].channel, "g2");
  assert.match(turns[0].from, new RegExp(`^node:${nodeId}:`));
  assert.equal(turns[0].sessionId, result.sessionId);
  assert.notEqual(turns[0].sessionId, "owner-session");
  assert.equal(turns[0].metadata.sourceNodeId, nodeId);
  assert.equal(turns[0].metadata.audioDurationSeconds, 0.2);
});

test("unregistered nodes, other node platforms, and malformed audio never reach the agent", async () => {
  const { channel, turns, nodeRegistry } = makeChannel();
  await assert.rejects(
    () => channel.ask({ audioBase64: wavBase64(), conversationId: crypto.randomUUID() }, "unknown"),
    (error) => error instanceof G2ChannelError && error.status === 403
  );
  const otherId = crypto.randomUUID();
  nodeRegistry.enroll(otherId, "o".repeat(43), { platform: "openagi" });
  await assert.rejects(
    () => channel.ask({ audioBase64: wavBase64(), conversationId: crypto.randomUUID() }, otherId),
    (error) => error instanceof G2ChannelError && error.code === "forbidden_node"
  );
  const enrolledG2 = makeChannel();
  await assert.rejects(
    () => enrolledG2.channel.ask({ audioBase64: Buffer.from("not wav").toString("base64"), conversationId: crypto.randomUUID() }, enrolledG2.nodeId),
    (error) => error instanceof G2ChannelError && error.code === "invalid_audio"
  );
  assert.equal(turns.length, 0);
});

test("only the one-time node exchange bypasses owner auth", () => {
  assert.equal(isPublicRoute("/nodes/enroll/exchange"), true);
  assert.equal(isPublicRoute("/nodes/enrollment-code"), false);
  assert.equal(isPublicRoute("/nodes/heartbeat"), false);
  assert.equal(isPublicRoute("/nodes/g2/ask"), false);
  assert.equal(isPublicRoute("/nodes"), false);
});

test("G2 HTTP enrollment uses bounded node authority and revocation", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-g2-routes-"));
  const nodeRegistry = new NodeRegistry({ dir: path.join(dataDir, "nodes") });
  const nodeEnrollment = new NodeEnrollmentCodes({ platforms: [EVEN_G2_PLATFORM] });
  const turns = [];
  const channel = new G2Channel({
    dir: path.join(dataDir, "channels", "g2"),
    nodeRegistry,
    apiKey: "test-openai-key",
    fetchImpl: async () => ({ ok: true, json: async () => ({ text: "Hello OpenAGI" }) }),
    agentHost: {
      handleMessage: async (input) => {
        turns.push(input);
        return { reply: "Hello G2", session: { id: input.sessionId } };
      }
    }
  });
  const channels = {
    g2: channel,
    status: () => ({ local: { enabled: true }, g2: channel.status() }),
    start() {},
    stop() {}
  };
  const previousToken = process.env.OPENAGI_AUTH_TOKEN;
  process.env.OPENAGI_AUTH_TOKEN = "admin-only-token";
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    channels,
    nodeRegistry,
    nodeEnrollment
  });
  let listening = false;
  try {
    const { url } = await app.listen();
    listening = true;
    const denied = await fetch(`${url}/nodes/enrollment-code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: EVEN_G2_PLATFORM })
    });
    assert.equal(denied.status, 401);

    const issuedResponse = await fetch(`${url}/nodes/enrollment-code`, {
      method: "POST",
      headers: { authorization: "Bearer admin-only-token", "content-type": "application/json" },
      body: JSON.stringify({ platform: EVEN_G2_PLATFORM })
    });
    const issued = await issuedResponse.json();
    assert.match(issued.code, /^\d{6}$/);

    const preflight = await fetch(`${url}/nodes/g2/ask`, { method: "OPTIONS", headers: { origin: "null" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    assert.match(preflight.headers.get("access-control-allow-headers"), /X-OpenAGI-Node-ID/i);

    const nodeId = crypto.randomUUID();
    const exchange = await fetch(`${url}/nodes/enroll/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "null" },
      body: JSON.stringify({ code: issued.code, platform: EVEN_G2_PLATFORM, nodeId, name: "Route G2" })
    });
    assert.equal(exchange.status, 200);
    const enrolled = await exchange.json();
    assert.equal(enrolled.node.id, nodeId);
    assert.equal(enrolled.node.platform, EVEN_G2_PLATFORM);
    assert.equal(nodeRegistry.authenticate(nodeId, enrolled.nodeToken), true);
    assert.equal(fs.readFileSync(nodeRegistry.storePath, "utf8").includes(enrolled.nodeToken), false);

    const nodeHeaders = {
      authorization: `Bearer ${enrolled.nodeToken}`,
      "x-openagi-node-id": nodeId,
      "content-type": "application/json",
      origin: "null"
    };
    const heartbeat = await fetch(`${url}/nodes/heartbeat`, {
      method: "POST",
      headers: nodeHeaders,
      body: JSON.stringify({
        nodeId,
        name: "Untrusted rename",
        role: "node",
        capabilities: [{ id: "computer-use", ready: true, operations: ["click"] }]
      })
    });
    assert.equal(heartbeat.status, 200);
    const heartbeatCapabilities = (await heartbeat.json()).capabilities;
    assert.deepEqual(heartbeatCapabilities.map((capability) => capability.id), ["g2-voice-input", "g2-text-display"]);
    assert.equal(heartbeatCapabilities.some((capability) => capability.id === "computer-use"), false);
    const [rosterNode] = nodeRegistry.list();
    assert.equal(rosterNode.name, "Route G2");
    assert.equal(rosterNode.platform, EVEN_G2_PLATFORM);
    assert.deepEqual(rosterNode.capabilities.map((capability) => capability.id), ["g2-voice-input", "g2-text-display"]);

    const wrongNode = await fetch(`${url}/nodes/g2/ask`, {
      method: "POST",
      headers: { ...nodeHeaders, "x-openagi-node-id": crypto.randomUUID() },
      body: JSON.stringify({ audioBase64: wavBase64(), conversationId: crypto.randomUUID() })
    });
    assert.ok([401, 403].includes(wrongNode.status));

    for (const [route, body] of [
      ["/message", { text: "bypass", from: "g2" }],
      ["/nodes/control/poll", { nodeId, capabilities: EVEN_G2_CAPABILITIES, timeoutMs: 1 }],
      ["/nodes/capture-memory", { content: "bypass" }]
    ]) {
      const response = await fetch(`${url}${route}`, {
        method: "POST",
        headers: nodeHeaders,
        body: JSON.stringify(body)
      });
      assert.ok([401, 403].includes(response.status), `${route} stays outside G2 authority`);
    }

    const asked = await fetch(`${url}/nodes/g2/ask`, {
      method: "POST",
      headers: nodeHeaders,
      body: JSON.stringify({ audioBase64: wavBase64(), conversationId: crypto.randomUUID() })
    });
    assert.equal(asked.status, 200);
    assert.equal((await asked.json()).reply, "Hello G2");
    assert.equal(turns.length, 1);
    assert.equal(turns[0].metadata.sourceNodeId, nodeId);

    const revoked = await fetch(`${url}/nodes/revoke`, {
      method: "POST",
      headers: nodeHeaders,
      body: JSON.stringify({ nodeId })
    });
    assert.equal(revoked.status, 200);
    const afterRevoke = await fetch(`${url}/nodes/g2/ask`, {
      method: "POST",
      headers: nodeHeaders,
      body: JSON.stringify({ audioBase64: wavBase64(), conversationId: crypto.randomUUID() })
    });
    assert.ok([401, 403].includes(afterRevoke.status));
  } finally {
    if (listening) await app.close();
    if (previousToken === undefined) delete process.env.OPENAGI_AUTH_TOKEN;
    else process.env.OPENAGI_AUTH_TOKEN = previousToken;
  }
});
