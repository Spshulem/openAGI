import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDurableRuntime, createHostedInterface, OpenAIResponsesProvider, AnthropicProvider } from "../src/index.js";
import { NodeRegistry } from "../src/node-registry.js";
import { LocalModelProvider } from "../src/local-model-provider.js";
import { OnDeviceModelProvider } from "../src/on-device-provider.js";
import { normalizeMessageImages, imageHistoryPreview, MAX_MESSAGE_IMAGE_BYTES } from "../src/message-attachments.js";
import { publicAgentFailure } from "../src/agent-failure.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPQKHgAAAI8AXnXjkfVAAAAAElFTkSuQmCC";
const image = (extra = {}) => ({ id: randomUUID(), name: "Synthetic image.png", mimeType: "image/png", data: PNG, ...extra });

test("image validation bounds bytes, formats, fields and attachment count before a turn runs", () => {
  assert.equal(normalizeMessageImages([image()])[0].data, PNG);
  assert.throws(() => normalizeMessageImages([image({ url: "http://localhost/private" })]), /inline/);
  assert.throws(() => normalizeMessageImages([image({ data: "not base64" })]), /invalid/);
  assert.throws(() => normalizeMessageImages([image({ mimeType: "image/jpeg" })]), /format/);
  assert.throws(() => normalizeMessageImages(Array.from({ length: 5 }, () => image())), /four/);
  const bytes = Buffer.alloc(1024 * 1024, 0);
  Buffer.from(PNG, "base64").copy(bytes);
  assert.throws(() => normalizeMessageImages(Array.from({ length: 4 }, () => image({ data: bytes.toString("base64") }))), /3 MB/);
  assert.equal(MAX_MESSAGE_IMAGE_BYTES, 3 * 1024 * 1024);
  const secret = image();
  assert.equal(JSON.stringify(imageHistoryPreview([secret])).includes(PNG), false);
});

for (const providerName of ["openai", "anthropic", "local"]) {
  test(`${providerName} sends native image blocks exactly once and retains them across tool hops`, async () => {
    const attachment = image();
    const bodies = [];
    let provider;
    if (providerName === "openai") {
      provider = new OpenAIResponsesProvider({ apiKey: "synthetic-key", model: "synthetic-vision", maxToolHops: 1 });
      provider.postResponses = async body => {
        bodies.push(structuredClone(body));
        return bodies.length === 1
          ? { output: [{ type: "function_call", call_id: "tool1", name: "look", arguments: "{}" }] }
          : { output: [], output_text: "I received the image." };
      };
    } else if (providerName === "anthropic") {
      provider = new AnthropicProvider({ apiKey: "synthetic-key", model: "synthetic-vision", maxToolHops: 1 });
      provider.postMessages = async body => {
        bodies.push(structuredClone(body));
        return { content: bodies.length === 1
          ? [{ type: "tool_use", id: "tool1", name: "look", input: {} }]
          : [{ type: "text", text: "I received the image." }] };
      };
    } else {
      provider = new LocalModelProvider({ model: "synthetic-vision", maxToolHops: 1, fetchImpl: async (_url, options) => {
        bodies.push(JSON.parse(options.body));
        return Response.json({ choices: [{ message: bodies.length === 1
          ? { tool_calls: [{ id: "tool1", function: { name: "look", arguments: "{}" } }] }
          : { content: "I received the image." } }] });
      } });
    }
    const result = await provider.generate({ input: "Inspect this image.", attachments: [attachment],
      messages: [{ role: "user", content: "Inspect this image.", metadata: { attachments: [attachment] } }],
      instructions: "Help with this image.", turnContext: "", agent: { name: "Agent" },
      toolRegistry: { toAnthropicTools: () => [], toOpenAITools: () => [], invoke: async () => ({ ok: true, result: "looked" }) } });
    assert.equal(result.text, "I received the image.");
    assert.equal(bodies.length, 2);
    for (const body of bodies) {
      const serialized = JSON.stringify(body);
      assert.equal(serialized.split(PNG).length - 1, 1, "pixels must reach every hop exactly once");
      assert.ok(serialized.includes(providerName === "openai" ? "input_image" : providerName === "anthropic" ? '"type":"image"' : "image_url"));
    }
  });
}

test("language-only on-device inference explicitly refuses images before calling its model", async () => {
  const provider = new OnDeviceModelProvider({ hub: { available: () => true, request: () => { throw new Error("must not call text-only model"); } } });
  await assert.rejects(provider.generate({ input: "Describe this.", attachments: [image()] }), error => {
    assert.equal(error.code, "IMAGE_INPUT_UNSUPPORTED");
    assert.equal(publicAgentFailure(error).code, "image-input-unsupported");
    assert.match(publicAgentFailure(error).error, /vision-capable/);
    return true;
  });
});

for (const thread of ["agent", "supervisor"]) {
  test(`paired phone ${thread} image goes through HTTP, channel, host and model, then private history`, async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-image-e2e-"));
    const bodies = [];
    const provider = new OpenAIResponsesProvider({ apiKey: "synthetic-key", model: "synthetic-vision" });
    provider.postResponses = async body => {
      bodies.push(structuredClone(body));
      const pixels = body.input.flatMap(item => Array.isArray(item.content) ? item.content : []).find(part => part.type === "input_image");
      assert.equal(pixels?.image_url, `data:image/png;base64,${PNG}`);
      return { output: [], output_text: `Image reached ${thread}.` };
    };
    provider.postResponsesStream = async body => provider.postResponses(body);
    const runtime = createDurableRuntime({ dataDir, modelProvider: provider, registerDefaults: false, integrations: false, skills: false, autoConnectMcp: false });
    const nodeRegistry = new NodeRegistry({ dir: path.join(dataDir, "nodes") });
    const phone = { id: `mobile:${randomUUID()}`, token: "a".repeat(43) };
    nodeRegistry.enroll(phone.id, phone.token, { platform: "mobile", name: "Synthetic phone" });
    const app = createHostedInterface(runtime, { dataDir, host: "127.0.0.1", port: 0, authToken: "synthetic-owner", tickerMs: 0, nodeControlEnabled: false, nodeRegistry });
    t.after(async () => {
      await app.close();
      runtime.observations?.db?.close();
      runtime.vectorStore?.db?.close();
      runtime.sessionIndex?.db?.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    });
    const { url } = await app.listen();
    const headers = { authorization: `Bearer ${phone.token}`, "x-openagi-node-id": phone.id, "content-type": "application/json" };
    const attachment = image();
    const response = await fetch(url + "/message", { method: "POST", headers: { ...headers, accept: "text/event-stream" },
      body: JSON.stringify({ text: "", thread, attachments: [attachment] }) });
    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.match(stream, new RegExp(`Image reached ${thread}`));
    assert.equal(bodies.length, 1);
    const user = runtime.agentHost.store.getSession(`devices:${thread}:main`).messages[0];
    assert.equal(user.metadata.attachments[0].data, PNG, "pixels are retained for model follow-up context");
    const history = await (await fetch(url + `/conversations/${thread}/messages`, { headers })).json();
    assert.equal(history.messages[0].attachments[0].id, attachment.id);
    assert.equal(JSON.stringify(history).includes(PNG), false, "original images stay out of history and SSE payloads");
    assert.equal(stream.includes(PNG), false);
    const rejected = await fetch(url + "/message", { method: "POST", headers,
      body: JSON.stringify({ text: "Invalid", thread, attachments: [image({ data: "invalid" })] }) });
    assert.equal(rejected.status, 400);
    assert.equal(bodies.length, 1, "invalid pixels cannot start another turn");
  });
}
