import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { NodeRegistry } from "../src/node-registry.js";
import { isMobileRouteAllowed } from "../src/mobile-node.js";

test("a phone configures, syncs and removes a fixed task source without exposing keys", async (t) => {
  const saved = process.env.LINEAR_API_KEY;
  delete process.env.LINEAR_API_KEY;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-integration-settings-"));
  const runtime = createDurableRuntime({ dataDir: dir, registerDefaults: false, integrations: false, skills: false, autoConnectMcp: false });
  let fail = false;
  runtime.linearTaskSource = {
    isConfigured: () => Boolean(process.env.LINEAR_API_KEY),
    async sync() {
      if (fail) throw new Error(`must never expose ${process.env.LINEAR_API_KEY}`);
      runtime.tasks.add({ title: "Synthetic imported issue", queue: "user", bucket: "today" });
      return { created: 1, updated: 0, completed: 0 };
    }
  };
  const nodeRegistry = new NodeRegistry({ dir: path.join(dir, "nodes") });
  nodeRegistry.enroll("mobile:settings", "p".repeat(43), { platform: "mobile", name: "Test phone" });
  const app = createHostedInterface(runtime, { dataDir: dir, nodeRegistry, host: "127.0.0.1", port: 0,
    tickerMs: 0, authToken: "owner", nodeControlEnabled: false });
  const { url } = await app.listen();
  t.after(async () => {
    await app.close();
    runtime.observations?.db?.close(); runtime.vectorStore?.db?.close(); runtime.sessionIndex?.db?.close();
    if (saved === undefined) delete process.env.LINEAR_API_KEY; else process.env.LINEAR_API_KEY = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const call = async (method, route, body) => {
    const response = await fetch(url + route, { method,
      headers: { "content-type": "application/json", authorization: `Bearer ${"p".repeat(43)}`, "x-openagi-node-id": "mobile:settings" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const route = "/workspace/integrations/linear";
  assert.equal((await call("PUT", route, { apiKey: "test-integration-key", OPENAGI_PROVIDER: "cloud" })).status, 400);
  assert.equal((await call("PUT", route, { apiKey: "newline\nkey" })).status, 400);
  const result = await call("PUT", route, { apiKey: "test-integration-key" });
  assert.equal(result.status, 200);
  assert.equal(result.body.integrations[0].configured, true);
  assert.doesNotMatch(JSON.stringify(result.body), /test-integration-key/);
  assert.equal(runtime.cron.jobs.get("linear-task-sync").enabled, true, "configuration installs phone's skipped job without a restart");
  assert.equal(fs.statSync(path.join(dir, ".env")).mode & 0o777, 0o600);
  assert.equal((await call("POST", route + "/sync", {})).body.created, 1);
  assert.equal(runtime.tasks.list({ queue: "user" })[0].title, "Synthetic imported issue");
  fail = true;
  const failure = await call("POST", route + "/sync", {});
  assert.equal(failure.body.ok, false);
  assert.doesNotMatch(JSON.stringify(failure.body), /test-integration-key/);
  assert.equal((await call("DELETE", route)).body.integrations[0].apiKeySaved, false);
  assert.equal(runtime.cron.jobs.get("linear-task-sync").enabled, false);
  assert.equal(runtime.tasks.list({ queue: "user" }).length, 1, "removing a key preserves imported tasks");
  assert.equal(isMobileRouteAllowed("PUT", "/workspace/integrations/arbitrary"), false);
  assert.equal(isMobileRouteAllowed("POST", "/integrations/connect-mcp"), false);
});
