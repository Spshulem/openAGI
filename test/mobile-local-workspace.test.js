import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDurableRuntime, createHostedInterface, registerCoreTools } from "../src/index.js";
import { NodeRegistry } from "../src/node-registry.js";
import { writeNodeConfig } from "../src/cli-client.js";

test("a phone workspace owns tasks, Today, questions, approvals and history without main", async (t) => {
  const before = process.env.OPENAGI_PROFILE;
  process.env.OPENAGI_PROFILE = "mobile";
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-phone-workspace-"));
  const runtime = createDurableRuntime({ dataDir, registerDefaults: false, integrations: false,
    skills: false, autoConnectMcp: false, modelProvider: {
      isConfigured: () => true,
      generate: async () => ({ text: "Local response", provider: "test", model: "test", toolCalls: [] })
    } });
  registerCoreTools(runtime.tools, runtime);
  const registry = new NodeRegistry({ dir: path.join(dataDir, "nodes") });
  const node = "mobile:local-workspace-test";
  const token = "l".repeat(43);
  registry.enroll(node, token, { platform: "mobile", name: "Local phone" });
  const app = createHostedInterface(runtime, { dataDir, nodeRegistry: registry, host: "127.0.0.1", port: 0,
    tickerMs: 0, authToken: "local-workspace-test-owner", nodeControlEnabled: false });
  t.after(async () => {
    await app.close();
    for (const store of [runtime.observations, runtime.vectorStore, runtime.sessionIndex]) store?.db?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (before === undefined) delete process.env.OPENAGI_PROFILE;
    else process.env.OPENAGI_PROFILE = before;
  });
  const { url } = await app.listen();
  // A migrated worker configuration must not redirect a local workspace to
  // an unreachable server. This is written after listen to avoid a relay.
  writeNodeConfig({ remote: "https://unreachable-main.example", token: null }, dataDir);
  const request = async (route, method = "GET", body) => {
    const response = await fetch(url + route, { method,
      headers: { authorization: `Bearer ${token}`, "x-openagi-node-id": node, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    assert.equal(response.status, 200, `${method} ${route}: ${JSON.stringify(result)}`);
    assert.equal(response.headers.get("x-openagi-data-source"), null, "must not proxy to main");
    return result;
  };
  const task = await request("/tasks", "POST", { title: "Local milk", queue: "user", bucket: "today" });
  assert.equal((await request("/tasks?queue=user")).tasks[0].id, task.id);
  assert.equal((await request("/mobile/summary")).today[0].id, task.id);
  const question = runtime.clarifications.add({ taskId: task.id, question: "Still working?", sources: [] });
  assert.equal((await request("/tasks/clarifications"))[0].id, question.id);
  await request(`/tasks/clarifications/${question.id}/answer`, "POST", { answer: "in_progress" });
  assert.equal((await request("/tasks/clarifications")).length, 0);
  const action = runtime.pendingActions.enqueue({ toolName: "add_task", args: { title: "Approved local task", bucket: "today" },
    summary: "Add the local task", reason: "Synthetic local approval" });
  assert.equal((await request("/pending-actions")).actions[0].id, action.id);
  const approved = await request(`/pending-actions/${action.id}/approve`, "POST", {});
  assert.equal(approved.ok, true);
  assert.ok((await request("/tasks?queue=user")).tasks.some(row => row.title === "Approved local task"));
  const denied = runtime.pendingActions.enqueue({ toolName: "add_task", args: { title: "Do not add" }, summary: "Rejected task" });
  await request(`/pending-actions/${denied.id}/deny`, "POST", { reason: "No" });
  assert.ok(!(await request("/tasks?queue=user")).tasks.some(row => row.title === "Do not add"));
  const turn = await request("/message", "POST", { text: "Hello from my phone", thread: "agent" });
  assert.equal(turn.reply, "Local response");
  const history = await request("/conversations/agent/messages");
  assert.ok(history.messages.some(row => row.text === "Hello from my phone"));
  assert.ok(history.messages.some(row => row.text === "Local response"));
  await request(`/tasks/${task.id}/complete`, "POST", {});
  assert.ok(!(await request("/mobile/summary")).today.some(row => row.id === task.id));
});
