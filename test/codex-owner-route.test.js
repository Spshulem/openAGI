import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultRuntime, createHostedInterface } from "../src/index.js";
import { CodexOAuthProvider } from "../src/codex-oauth-provider.js";

test("authenticated loopback owner messages can reach Codex but a spoofed channel cannot", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-codex-owner-route-"));
  let turns = 0;
  const modelProvider = new CodexOAuthProvider({
    client: {
      status: () => ({ readiness: "chat-ready" }),
      async runChatTurn() {
        turns += 1;
        return { turnId: `turn-${turns}`, text: "fake owner response", usage: {} };
      },
      async close() {}
    }
  });
  const runtime = createDefaultRuntime({ dataDir, modelProvider, autoConnectMcp: false });
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1", port: 0, dataDir, authToken: "owner-only", tickerMs: 0
  });
  const { url } = await app.listen();
  try {
    const headers = { authorization: "Bearer owner-only", "content-type": "application/json" };
    const owner = await fetch(`${url}/message`, {
      method: "POST", headers,
      body: JSON.stringify({ channel: "local", from: "browser", text: "hello" })
    });
    assert.equal(owner.status, 200);
    assert.equal((await owner.json()).reply, "fake owner response");
    assert.equal(turns, 1);

    const external = await fetch(`${url}/message`, {
      method: "POST", headers,
      body: JSON.stringify({ channel: "telegram", from: "remote", text: "hello" })
    });
    assert.equal(external.status, 500);
    assert.equal(turns, 1);
  } finally {
    await app.close();
  }
});
