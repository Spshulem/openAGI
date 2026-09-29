import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultRuntime, createHostedInterface } from "../src/index.js";

test("Saving Codex settings invalidates the cached administrative client", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-codex-admin-cache-"));
  const before = { provider: process.env.OPENAGI_PROVIDER, model: process.env.OPENAGI_CODEX_MODEL };
  process.env.OPENAGI_PROVIDER = "auto";
  process.env.OPENAGI_CODEX_MODEL = "pre-save-model";
  const runtime = createDefaultRuntime({ dataDir, agentHost: false, autoConnectMcp: false });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, dataDir, authToken: "owner", tickerMs: 0 });
  const { url } = await app.listen();
  const headers = { authorization: "Bearer owner" };
  try {
    const status = () => fetch(`${url}/admin/providers/openai-codex/status`, { headers }).then((response) => response.json());
    assert.equal((await status()).model, "pre-save-model");
    const listed = await fetch(`${url}/admin/provider`, { headers });
    assert.equal((await listed.json()).available["openai-codex"], false);
    const save = await fetch(`${url}/setup/save`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ OPENAGI_PROVIDER: "auto", OPENAGI_CODEX_MODEL: "post-save-model" })
    });
    assert.equal(save.status, 200);
    assert.equal((await status()).model, "post-save-model");
  } finally {
    await app.close();
    if (before.provider === undefined) delete process.env.OPENAGI_PROVIDER;
    else process.env.OPENAGI_PROVIDER = before.provider;
    if (before.model === undefined) delete process.env.OPENAGI_CODEX_MODEL;
    else process.env.OPENAGI_CODEX_MODEL = before.model;
  }
});
