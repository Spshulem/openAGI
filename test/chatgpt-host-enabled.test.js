import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultRuntime, createHostedInterface } from "../src/index.js";
import { createModelProvider } from "../src/model-provider.js";
import { readChatGptModelSelection, writeChatGptModelSelection } from "../src/chatgpt-model-selection.js";

function requestWithHost(url, { method = "GET", headers = {}, body = "" } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("explicit ChatGPT activation requires owner login and live account model discovery before selection", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-chatgpt-enabled-"));
  let connected = false;
  let catalogue = [];
  let loginStarts = 0;
  const oauth = {
    status: async () => ({ connected }), listModels: async () => catalogue,
    getAccessToken: async () => "synthetic-access",
    getCredentialGeneration: async () => "11111111-1111-4111-8111-111111111111",
    startDeviceLogin: async () => { loginStarts += 1; return {
      loginId: "a".repeat(32), userCode: "SYNTHETIC", verificationUrl: "https://auth.openai.com/codex/device"
    }; }
  };
  const original = process.env.OPENAGI_PROVIDER;
  const originalChatGptEnabled = process.env.OPENAGI_CHATGPT_ENABLED;
  const app = createHostedInterface(createDefaultRuntime({ dataDir }), {
    host: "127.0.0.1", port: 0, dataDir, authToken: "test-owner", chatgptOAuth: oauth,
    chatgptEnabled: true, tickerMs: 0
  });
  const { url } = await app.listen();
  const headers = { authorization: "Bearer test-owner", "content-type": "application/json" };
  const select = () => fetch(`${url}/setup/save`, { method: "POST", headers,
    body: JSON.stringify({ OPENAGI_PROVIDER: "openai-chatgpt", OPENAGI_CHATGPT_ENABLED: "1", OPENAGI_CHATGPT_MODEL: "gpt-5.5" }) });
  try {
    assert.equal((await fetch(`${url}/admin/providers/openai-chatgpt/login`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "device" }) })).status, 401);
    const login = await fetch(`${url}/admin/providers/openai-chatgpt/login`, { method: "POST", headers,
      body: JSON.stringify({ mode: "device" }) });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).userCode, "SYNTHETIC");
    assert.equal(loginStarts, 1);
    assert.equal((await select()).status, 409);
    connected = true;
    assert.equal((await select()).status, 409);
    catalogue = ["gpt-5.5"];
    assert.equal((await select()).status, 200);
    assert.deepEqual(readChatGptModelSelection(dataDir), {
      schema: "openagi.chatgpt-model-selection.v1",
      model: "gpt-5.5",
      credentialGeneration: "11111111-1111-4111-8111-111111111111"
    });
    assert.equal((await (await fetch(`${url}/admin/provider`, { headers })).json()).preference, "openai-chatgpt");
    const revoke = await fetch(`${url}/setup/save`, { method: "POST", headers,
      body: JSON.stringify({ OPENAGI_PROVIDER: "auto", clear: ["OPENAGI_CHATGPT_ENABLED"] }) });
    assert.equal(revoke.status, 200);
    assert.equal(process.env.OPENAGI_CHATGPT_ENABLED, undefined);
    assert.equal(readChatGptModelSelection(dataDir), null);
  } finally {
    await app.close();
    if (original === undefined) delete process.env.OPENAGI_PROVIDER;
    else process.env.OPENAGI_PROVIDER = original;
    if (originalChatGptEnabled === undefined) delete process.env.OPENAGI_CHATGPT_ENABLED;
    else process.env.OPENAGI_CHATGPT_ENABLED = originalChatGptEnabled;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("public ingress cannot discover or select the provisional ChatGPT provider", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-chatgpt-public-selection-"));
  let statusReads = 0;
  let catalogueReads = 0;
  const oauth = {
    status: async () => { statusReads += 1; return { connected: true }; },
    listModels: async () => { catalogueReads += 1; return ["gpt-5.5"]; },
    getAccessToken: async () => "synthetic-access"
  };
  const app = createHostedInterface(createDefaultRuntime({ dataDir, autoConnectMcp: false }), {
    host: "127.0.0.1", port: 0, dataDir, authToken: "owner-test", publicUrl: "https://public.example",
    chatgptEnabled: true, chatgptOAuth: oauth, tickerMs: 0
  });
  const { url } = await app.listen();
  const headers = { authorization: "Bearer owner-test", "content-type": "application/json" };
  const body = JSON.stringify({ preference: "openai-chatgpt", OPENAGI_PROVIDER: "openai-chatgpt", OPENAGI_CHATGPT_MODEL: "gpt-5.5" });
  try {
    const availability = await (await fetch(`${url}/admin/provider`, { headers })).json();
    assert.equal(availability.available["openai-chatgpt"], false);
    assert.equal(statusReads, 0);
    assert.equal(catalogueReads, 0);
    const provider = await fetch(`${url}/admin/provider`, { method: "POST", headers, body });
    assert.equal(provider.status, 403);
    assert.deepEqual(await provider.json(), { error: "owner-loopback-required" });
    const setup = await fetch(`${url}/setup/save`, { method: "POST", headers, body });
    assert.equal(setup.status, 403);
    assert.deepEqual(await setup.json(), { error: "owner-loopback-required" });
    assert.equal(statusReads, 0);
    assert.equal(catalogueReads, 0);
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("an empty public URL option cannot mask a declared public ingress", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-chatgpt-masked-public-ingress-"));
  const originalPublicUrl = process.env.OPENAGI_PUBLIC_URL;
  let statusReads = 0;
  let catalogueReads = 0;
  process.env.OPENAGI_PUBLIC_URL = "https://public.example";
  const oauth = {
    status: async () => { statusReads += 1; return { connected: true }; },
    listModels: async () => { catalogueReads += 1; return ["gpt-5.5"]; },
    getCredentialGeneration: async () => "11111111-1111-4111-8111-111111111111",
    getAccessToken: async () => "synthetic-access"
  };
  const app = createHostedInterface(createDefaultRuntime({ dataDir, autoConnectMcp: false }), {
    host: "127.0.0.1", port: 0, dataDir, authToken: "owner-test", publicUrl: "",
    chatgptEnabled: true, chatgptOAuth: oauth, tickerMs: 0
  });
  const { url } = await app.listen();
  try {
    const response = await fetch(`${url}/admin/provider`, {
      method: "POST",
      headers: { authorization: "Bearer owner-test", "content-type": "application/json" },
      body: JSON.stringify({ preference: "openai-chatgpt" })
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "owner-loopback-required" });
    assert.equal(statusReads, 0);
    assert.equal(catalogueReads, 0);
  } finally {
    await app.close();
    if (originalPublicUrl === undefined) delete process.env.OPENAGI_PUBLIC_URL;
    else process.env.OPENAGI_PUBLIC_URL = originalPublicUrl;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("attested provider dispatches only its exact selected model and rejects overrides", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-chatgpt-attested-provider-"));
  const dispatched = [];
  try {
    writeChatGptModelSelection({
      dataDir, model: "gpt-5.5", credentialGeneration: "11111111-1111-4111-8111-111111111111"
    });
    const selected = createModelProvider({ preferred: "openai-chatgpt", chatgptEnabled: true, dataDir,
      chatgptOAuth: {
        getAccessToken: async () => "synthetic-access",
        getCredentialGeneration: async () => "11111111-1111-4111-8111-111111111111"
      },
      chatgpt: { model: "gpt-5.5", fetchImpl: async (_url, init) => {
        dispatched.push(JSON.parse(init.body).model);
        return new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
          id: "synthetic", status: "completed", model: "gpt-5.5",
          output: [{ type: "message", content: [{ type: "output_text", text: "works" }] }]
        } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
      } }
    });
    assert.equal(selected.isConfigured(), true);
    await assert.rejects(selected.generate({ input: "not owner" }), { code: "CHATGPT_PROVENANCE_DENIED" });
    await assert.rejects(selected.generate({ input: "scheduled", task: "scheduled",
      context: { channel: "local", localOwner: true } }), { code: "CHATGPT_PROVENANCE_DENIED" });
    const owner = { channel: "local", localOwner: true };
    await assert.rejects(selected.generate({ input: "missing host authority", context: owner }), {
      code: "CHATGPT_PROVENANCE_DENIED"
    });
    assert.deepEqual(dispatched, []);
    owner.assertChatGptOwnerAuthority = () => {};
    assert.equal((await selected.generate({ input: "hello", context: owner })).text, "works");
    assert.deepEqual(dispatched, ["gpt-5.5"]);
    await assert.rejects(selected.generate({ input: "hello", model: "unknown", context: owner }), { code: "CHATGPT_MODEL_UNAVAILABLE" });
    assert.deepEqual(dispatched, ["gpt-5.5"]);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("boot-time ChatGPT configuration requires a persisted owner catalogue attestation before dispatch", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-chatgpt-startup-attestation-"));
  let requests = 0;
  try {
    const provider = createModelProvider({ preferred: "openai-chatgpt", chatgptEnabled: true, dataDir,
      chatgptOAuth: { getAccessToken: async () => "synthetic-access", getCredentialGeneration: async () => "epoch-1" },
      chatgpt: { model: "gpt-5.5", fetchImpl: async () => {
        requests += 1;
        throw new Error("the unqualified startup provider must not dispatch");
      } }
    });
    assert.equal(provider.isConfigured(), false);
    await assert.rejects(provider.generate({ input: "must not dispatch", context: { channel: "local", localOwner: true } }), {
      code: "CHATGPT_NOT_QUALIFIED"
    });
    assert.equal(requests, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a changed OAuth credential generation invalidates a persisted model selection before dispatch", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-chatgpt-stale-attestation-"));
  let requests = 0;
  try {
    writeChatGptModelSelection({
      dataDir, model: "gpt-5.5", credentialGeneration: "11111111-1111-4111-8111-111111111111"
    });
    const provider = createModelProvider({ preferred: "openai-chatgpt", chatgptEnabled: true, dataDir,
      chatgptOAuth: {
        getAccessToken: async () => "synthetic-access",
        getCredentialGeneration: async () => "22222222-2222-4222-8222-222222222222"
      },
      chatgpt: { model: "gpt-5.5", fetchImpl: async () => {
        requests += 1;
        throw new Error("the stale selection must not dispatch");
      } }
    });
    assert.equal(provider.isConfigured(), true);
    await assert.rejects(provider.generate({ input: "must not dispatch", context: {
      channel: "local", localOwner: true, assertChatGptOwnerAuthority: () => {}
    } }), {
      code: "CHATGPT_MODEL_SELECTION_STALE"
    });
    assert.equal(requests, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("public ingress cannot access host-owned ChatGPT OAuth administration", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-chatgpt-admin-tunnel-"));
  let statusReads = 0;
  const oauth = {
    status: async () => { statusReads += 1; return { connected: true }; },
    getAccessToken: async () => "synthetic-access"
  };
  const app = createHostedInterface(createDefaultRuntime({ dataDir, autoConnectMcp: false }), {
    host: "127.0.0.1", port: 0, dataDir, authToken: "owner-test", publicUrl: "https://public.example",
    chatgptEnabled: true, chatgptOAuth: oauth, tickerMs: 0
  });
  const { url } = await app.listen();
  try {
    const headers = { authorization: "Bearer owner-test", "x-forwarded-for": "203.0.113.9" };
    const tunneled = await fetch(`${url}/admin/providers/openai-chatgpt/status`, { headers });
    assert.equal(tunneled.status, 403);
    assert.deepEqual(await tunneled.json(), { error: "owner-loopback-required" });
    assert.equal(statusReads, 0);

    const direct = await fetch(`${url}/admin/providers/openai-chatgpt/status`, {
      headers: { authorization: "Bearer owner-test" }
    });
    assert.equal(direct.status, 403);
    assert.deepEqual(await direct.json(), { error: "owner-loopback-required" });
    assert.equal(statusReads, 0);
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("direct-loopback setup test carries owner provenance for the provisional provider", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-chatgpt-setup-test-"));
  let requests = 0;
  writeChatGptModelSelection({
    dataDir, model: "gpt-5.5", credentialGeneration: "11111111-1111-4111-8111-111111111111"
  });
  const modelProvider = createModelProvider({ preferred: "openai-chatgpt", chatgptEnabled: true, dataDir,
    chatgptOAuth: {
      getAccessToken: async () => "synthetic-access",
      getCredentialGeneration: async () => "11111111-1111-4111-8111-111111111111"
    },
    chatgpt: { model: "gpt-5.5", fetchImpl: async () => {
      requests += 1;
      const events = [
        { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "setup works" }] } },
        { type: "response.completed", response: { id: "setup-response", model: "gpt-5.5", status: "completed", output: [] } }
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" }
      });
    } }
  });
  const app = createHostedInterface(createDefaultRuntime({ dataDir, modelProvider, autoConnectMcp: false }), {
    host: "127.0.0.1", port: 0, dataDir, authToken: "owner-test", chatgptEnabled: true, tickerMs: 0
  });
  const { url } = await app.listen();
  try {
    const direct = await fetch(`${url}/setup/test`, { method: "POST", headers: {
      authorization: "Bearer owner-test", "content-type": "application/json"
    }, body: JSON.stringify({ text: "hi" }) });
    assert.equal(direct.status, 200);
    assert.equal((await direct.json()).reply, "setup works");
    assert.equal(requests, 1);

    const tunneled = await fetch(`${url}/setup/test`, { method: "POST", headers: {
      authorization: "Bearer owner-test", "content-type": "application/json", "x-forwarded-for": "203.0.113.9"
    }, body: JSON.stringify({ text: "hi" }) });
    assert.equal(tunneled.status, 500);
    assert.equal(requests, 1);
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("authenticated loopback message reaches the enabled ChatGPT adapter but non-owner messages do not", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-chatgpt-message-"));
  let requests = 0;
  writeChatGptModelSelection({
    dataDir, model: "gpt-5.5", credentialGeneration: "11111111-1111-4111-8111-111111111111"
  });
  const modelProvider = createModelProvider({ preferred: "openai-chatgpt", chatgptEnabled: true, dataDir,
    chatgptOAuth: {
      getAccessToken: async () => "synthetic-access",
      getCredentialGeneration: async () => "11111111-1111-4111-8111-111111111111"
    },
    chatgpt: { model: "gpt-5.5", fetchImpl: async () => {
      requests += 1;
      const frames = [
        { type: "response.output_item.done", item: { type: "message", content: [
          { type: "output_text", text: "synthetic owner reply" }
        ] } },
        { type: "response.completed", response: {
          id: "synthetic", status: "completed", model: "gpt-5.5", output: []
        } }
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
      // The live pilot observed a missing Content-Type; terminal output: []
      // is a separately reproduced local failure shape, not captured live.
      // Only a validated streamed final message may become a hosted reply.
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(frames));
        controller.close();
      } }));
    } }
  });
  const runtime = createDefaultRuntime({ dataDir, modelProvider, autoConnectMcp: false });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, dataDir,
    authToken: "owner-test", tickerMs: 0, chatgptEnabled: true });
  const { url } = await app.listen();
  try {
    const headers = { authorization: "Bearer owner-test", "content-type": "application/json" };
    const originalAuth = process.env.OPENAGI_AUTH_TOKEN;
    let dashboard;
    try {
      process.env.OPENAGI_AUTH_TOKEN = "synthetic-owner-test"; // disable first-run setup redirect
      dashboard = await (await fetch(`${url}/`, { headers })).text();
    } finally {
      if (originalAuth === undefined) delete process.env.OPENAGI_AUTH_TOKEN;
      else process.env.OPENAGI_AUTH_TOKEN = originalAuth;
    }
    assert.ok(dashboard.includes('<option value="openai-chatgpt"'),
      "dashboard switcher must expose the provider");
    const owner = await fetch(`${url}/message`, { method: "POST", headers,
      body: JSON.stringify({ channel: "local", from: "browser", text: "hi" }) });
    assert.equal(owner.status, 200);
    assert.equal((await owner.json()).reply, "synthetic owner reply");
    assert.equal(requests, 1);
    const other = await fetch(`${url}/message`, { method: "POST", headers,
      body: JSON.stringify({ channel: "telegram", from: "remote", text: "hi" }) });
    assert.equal(other.status, 500);
    assert.equal(requests, 1);
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a local tunnel cannot turn an unauthenticated remote request into subscription owner authority", async () => {
  const dataDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "openagi-chatgpt-proxy-"));
  let catalogues = 0;
  let modelRequests = 0;
  const modelProvider = createModelProvider({ preferred: "openai-chatgpt", chatgptEnabled: true,
    chatgptOAuth: { getAccessToken: async () => "synthetic-access", listModels: async () => {
      catalogues += 1;
      return ["gpt-5.5"];
    } },
    chatgpt: { fetchImpl: async () => {
      modelRequests += 1;
      return new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
        status: "completed", model: "gpt-5.5", output: [
          { type: "message", content: [{ type: "output_text", text: "must not send" }] }
        ]
      } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    } }
  });
  const app = createHostedInterface(createDefaultRuntime({ dataDir, modelProvider, autoConnectMcp: false }), {
    host: "127.0.0.1", port: 0, dataDir, authToken: "", chatgptEnabled: true, tickerMs: 0
  });
  let proxy;
  try {
    const { url } = await app.listen();
    proxy = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const upstream = await fetch(`${url}${req.url}`, { method: req.method, body,
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" } });
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "text/plain" });
      res.end(await upstream.text());
    });
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}/message`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "local", from: "remote", text: "hello" })
    });
    assert.equal(response.status, 401);
    assert.equal(catalogues, 0, "remote request must fail before model discovery");
    assert.equal(modelRequests, 0, "remote request must never reach the subscription");
  } finally {
    if (proxy?.listening) await new Promise((resolve) => proxy.close(resolve));
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a public tunnel host cannot complete first-run setup and then gain owner authority", async () => {
  const dataDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "openagi-chatgpt-setup-tunnel-"));
  const previousToken = process.env.OPENAGI_AUTH_TOKEN;
  const previousProvider = process.env.OPENAGI_PROVIDER;
  delete process.env.OPENAGI_AUTH_TOKEN;
  delete process.env.OPENAGI_PROVIDER;
  let catalogues = 0;
  let modelRequests = 0;
  const modelProvider = createModelProvider({ preferred: "openai-chatgpt", chatgptEnabled: true,
    chatgptOAuth: { getAccessToken: async () => "synthetic-access", listModels: async () => {
      catalogues += 1;
      return ["gpt-5.5"];
    } },
    chatgpt: { fetchImpl: async () => {
      modelRequests += 1;
      return new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
        status: "completed", model: "gpt-5.5", output: [
          { type: "message", content: [{ type: "output_text", text: "must not send" }] }
        ]
      } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    } }
  });
  const app = createHostedInterface(createDefaultRuntime({ dataDir, modelProvider, autoConnectMcp: false }), {
    host: "127.0.0.1", port: 0, dataDir, chatgptEnabled: true, tickerMs: 0
  });
  try {
    const { url } = await app.listen();
    const setup = await requestWithHost(`${url}/setup/save`, { method: "POST", headers: {
      "content-type": "application/json", host: "public.example"
    }, body: JSON.stringify({ OPENAGI_AUTH_TOKEN: "tunnel-owner" }) });
    assert.equal(setup.status, 401);
    assert.equal(process.env.OPENAGI_AUTH_TOKEN, undefined);
    const response = await requestWithHost(`${url}/message`, { method: "POST", headers: {
      "content-type": "application/json", authorization: "Bearer tunnel-owner", host: "public.example"
    }, body: JSON.stringify({ channel: "local", from: "remote", text: "hello" }) });
    assert.equal(response.status, 401);
    assert.equal(catalogues, 0, "remote setup/tunnel request must fail before model discovery");
    assert.equal(modelRequests, 0, "remote setup/tunnel request must never reach the subscription");
  } finally {
    await app.close();
    if (previousToken === undefined) delete process.env.OPENAGI_AUTH_TOKEN;
    else process.env.OPENAGI_AUTH_TOKEN = previousToken;
    if (previousProvider === undefined) delete process.env.OPENAGI_PROVIDER;
    else process.env.OPENAGI_PROVIDER = previousProvider;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a non-loopback bind cannot grant owner provenance through a loopback Host", async () => {
  const dataDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "openagi-chatgpt-public-bind-"));
  let modelRequests = 0;
  const modelProvider = createModelProvider({ preferred: "openai-chatgpt", chatgptEnabled: true,
    chatgptOAuth: { getAccessToken: async () => "synthetic-access" },
    chatgpt: { model: "gpt-5.5", fetchImpl: async () => {
      modelRequests += 1;
      return new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
        id: "must-not-dispatch", status: "completed", model: "gpt-5.5", output: []
      } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    } }
  });
  const app = createHostedInterface(createDefaultRuntime({ dataDir, modelProvider, autoConnectMcp: false }), {
    host: "0.0.0.0", port: 0, dataDir, authToken: "owner-test", chatgptEnabled: true, tickerMs: 0
  });
  try {
    const { url } = await app.listen();
    const response = await requestWithHost(`${url}/message`, { method: "POST", headers: {
      "content-type": "application/json", authorization: "Bearer owner-test", host: "127.0.0.1"
    }, body: JSON.stringify({ channel: "local", from: "remote", text: "hello" }) });
    assert.equal(response.status, 500);
    assert.equal(modelRequests, 0, "non-loopback binds must not reach the subscription");
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a declared public ingress cannot forge owner provenance with a loopback Host", async () => {
  const dataDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "openagi-chatgpt-token-tunnel-"));
  let catalogues = 0;
  let modelRequests = 0;
  const modelProvider = createModelProvider({ preferred: "openai-chatgpt", chatgptEnabled: true,
    chatgptOAuth: { getAccessToken: async () => "synthetic-access", listModels: async () => {
      catalogues += 1;
      return ["gpt-5.5"];
    } },
    chatgpt: { fetchImpl: async () => {
      modelRequests += 1;
      return new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
        status: "completed", model: "gpt-5.5", output: [
          { type: "message", content: [{ type: "output_text", text: "must not send" }] }
        ]
      } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    } }
  });
  const app = createHostedInterface(createDefaultRuntime({ dataDir, modelProvider, autoConnectMcp: false }), {
    host: "127.0.0.1", port: 0, dataDir, authToken: "owner-test", publicUrl: "https://public.example",
    chatgptEnabled: true, tickerMs: 0
  });
  try {
    const { url } = await app.listen();
    const response = await requestWithHost(`${url}/message`, { method: "POST", headers: {
      "content-type": "application/json", authorization: "Bearer owner-test", host: "127.0.0.1"
    }, body: JSON.stringify({ channel: "local", from: "remote", text: "hello" }) });
    assert.equal(response.status, 500);
    assert.equal(catalogues, 0, "public-ingress owner-token request must fail before model discovery");
    assert.equal(modelRequests, 0, "public-ingress owner-token request must never reach the subscription");
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a public-ingress transition during token binding blocks the pending owner turn before dispatch", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-chatgpt-topology-race-"));
  const originalPublicUrl = process.env.OPENAGI_PUBLIC_URL;
  let requests = 0;
  let releaseAccessToken;
  const accessTokenPaused = new Promise((resolve) => { releaseAccessToken = resolve; });
  let accessTokenReached;
  const reachedAccessToken = new Promise((resolve) => { accessTokenReached = resolve; });
  writeChatGptModelSelection({
    dataDir, model: "gpt-5.5", credentialGeneration: "11111111-1111-4111-8111-111111111111"
  });
  delete process.env.OPENAGI_PUBLIC_URL;
  const modelProvider = createModelProvider({ preferred: "openai-chatgpt", chatgptEnabled: true, dataDir,
    chatgptOAuth: {
      getCredentialGeneration: async () => "11111111-1111-4111-8111-111111111111",
      getAccessToken: async () => {
        accessTokenReached();
        await accessTokenPaused;
        return "synthetic-access";
      }
    },
    chatgpt: { model: "gpt-5.5", fetchImpl: async () => {
      requests += 1;
      return new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
        id: "must-not-dispatch", status: "completed", model: "gpt-5.5", output: []
      } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    } }
  });
  const app = createHostedInterface(createDefaultRuntime({ dataDir, modelProvider, autoConnectMcp: false }), {
    host: "127.0.0.1", port: 0, dataDir, authToken: "owner-test", chatgptEnabled: true, tickerMs: 0
  });
  try {
    const { url } = await app.listen();
    const pending = fetch(`${url}/message`, { method: "POST", headers: {
      authorization: "Bearer owner-test", "content-type": "application/json"
    }, body: JSON.stringify({ channel: "local", from: "browser", text: "hello" }) });
    await reachedAccessToken;
    process.env.OPENAGI_PUBLIC_URL = "https://public.example";
    releaseAccessToken();
    const response = await pending;
    assert.equal(response.status, 500);
    assert.equal(requests, 0, "a newly public topology must block the pending subscription dispatch");
  } finally {
    await app.close();
    if (originalPublicUrl === undefined) delete process.env.OPENAGI_PUBLIC_URL;
    else process.env.OPENAGI_PUBLIC_URL = originalPublicUrl;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("removing the dashboard token during token binding blocks the pending owner turn before dispatch", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-chatgpt-auth-race-"));
  const originalAuthToken = process.env.OPENAGI_AUTH_TOKEN;
  let requests = 0;
  let releaseAccessToken;
  const accessTokenPaused = new Promise((resolve) => { releaseAccessToken = resolve; });
  let accessTokenReached;
  const reachedAccessToken = new Promise((resolve) => { accessTokenReached = resolve; });
  writeChatGptModelSelection({
    dataDir, model: "gpt-5.5", credentialGeneration: "11111111-1111-4111-8111-111111111111"
  });
  process.env.OPENAGI_AUTH_TOKEN = "owner-test";
  const modelProvider = createModelProvider({ preferred: "openai-chatgpt", chatgptEnabled: true, dataDir,
    chatgptOAuth: {
      getCredentialGeneration: async () => "11111111-1111-4111-8111-111111111111",
      getAccessToken: async () => {
        accessTokenReached();
        await accessTokenPaused;
        return "synthetic-access";
      }
    },
    chatgpt: { model: "gpt-5.5", fetchImpl: async () => {
      requests += 1;
      return new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
        id: "must-not-dispatch", status: "completed", model: "gpt-5.5", output: []
      } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    } }
  });
  const app = createHostedInterface(createDefaultRuntime({ dataDir, modelProvider, autoConnectMcp: false }), {
    host: "127.0.0.1", port: 0, dataDir, chatgptEnabled: true, tickerMs: 0
  });
  try {
    const { url } = await app.listen();
    const pending = fetch(`${url}/message`, { method: "POST", headers: {
      authorization: "Bearer owner-test", "content-type": "application/json"
    }, body: JSON.stringify({ channel: "local", from: "browser", text: "hello" }) });
    await reachedAccessToken;
    delete process.env.OPENAGI_AUTH_TOKEN;
    releaseAccessToken();
    const response = await pending;
    assert.equal(response.status, 500);
    assert.equal(requests, 0, "a missing dashboard token must revoke the pending subscription dispatch");
  } finally {
    await app.close();
    if (originalAuthToken === undefined) delete process.env.OPENAGI_AUTH_TOKEN;
    else process.env.OPENAGI_AUTH_TOKEN = originalAuthToken;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
