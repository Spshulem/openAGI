import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultRuntime, createHostedInterface } from "../src/index.js";

test("hosted interface keeps an unconnected ChatGPT route out of provider selection", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-chatgpt-route-"));
  let connected = false;
  const oauth = {
    status: async () => ({ connected }),
    getAccessToken: async () => { throw new Error("no credential in this test"); }
  };
  const original = process.env.OPENAGI_PROVIDER;
  const app = createHostedInterface(createDefaultRuntime({ dataDir }), {
    host: "127.0.0.1", port: 0, dataDir, authToken: "test-owner", chatgptOAuth: oauth, tickerMs: 0
  });
  const { url } = await app.listen();
  try {
    const auth = { authorization: "Bearer test-owner", "content-type": "application/json" };
    const status = await fetch(`${url}/admin/providers/openai-chatgpt/status`, { headers: auth });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).connected, false);
    const denied = await fetch(`${url}/admin/provider`, { method: "POST", headers: auth, body: JSON.stringify({ preference: "openai-chatgpt" }) });
    assert.equal(denied.status, 409);
    connected = true;
    const selected = await fetch(`${url}/admin/provider`, { method: "POST", headers: auth, body: JSON.stringify({ preference: "openai-chatgpt" }) });
    assert.equal(selected.status, 409, "OAuth status alone must not qualify production inference");
    assert.deepEqual(await selected.json(), { error: "chatgpt-not-qualified" });
    const details = await (await fetch(`${url}/admin/provider`, { headers: auth })).json();
    assert.equal(details.preference, original ?? "auto");
    assert.equal(details.available["openai-chatgpt"], false);
    const setup = await fetch(`${url}/setup/save`, { method: "POST", headers: auth,
      body: JSON.stringify({ OPENAGI_PROVIDER: "openai-chatgpt" }) });
    assert.equal(setup.status, 409);
    assert.equal(process.env.OPENAGI_PROVIDER, original);
  } finally {
    await app.close();
    if (original === undefined) delete process.env.OPENAGI_PROVIDER;
    else process.env.OPENAGI_PROVIDER = original;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("ordinary provider status remains available when the optional Secret Service is locked", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-chatgpt-locked-"));
  const app = createHostedInterface(createDefaultRuntime({ dataDir }), {
    host: "127.0.0.1", port: 0, dataDir, authToken: "test-owner", tickerMs: 0,
    chatgptOAuth: { status: async () => { throw new Error("keyring locked"); } }
  });
  const { url } = await app.listen();
  try {
    const result = await fetch(`${url}/admin/provider`, { headers: { authorization: "Bearer test-owner" } });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).available["openai-chatgpt"], false);
  } finally {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
