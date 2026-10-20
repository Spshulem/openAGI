import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { NodeRegistry } from "../src/node-registry.js";
import { writeNodeConfig } from "../src/cli-client.js";
import { isMainDataRoute, routeMainData } from "../src/main-data-router.js";

const PHONE = { id: `mobile:${randomUUID()}`, token: "p".repeat(43) };
const WORKER = { id: "test-worker", token: "w".repeat(43) };
const OWNER = "test-owner";
const auth = (node) => ({ authorization: `Bearer ${node.token}`, "x-openagi-node-id": node.id });

async function boot(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-main-router-"));
  const runtime = createDurableRuntime({ dataDir, registerDefaults: false, integrations: false,
    skills: false, autoConnectMcp: false, modelProvider: {
      isConfigured: () => true,
      generate: async () => ({ text: "Main's reply", provider: "test", model: "test", toolCalls: [] })
    } });
  const nodeRegistry = new NodeRegistry({ dir: path.join(dataDir, "nodes") });
  const app = createHostedInterface(runtime, { dataDir, nodeRegistry, host: "127.0.0.1", port: 0,
    tickerMs: 0, authToken: OWNER, nodeControlEnabled: false });
  const { url } = await app.listen();
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  t.after(async () => {
    await close();
    runtime.observations?.db?.close();
    runtime.vectorStore?.db?.close();
    runtime.sessionIndex?.db?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { dataDir, runtime, nodeRegistry, app, url, close };
}

async function pair(t) {
  const main = await boot(t);
  const worker = await boot(t);
  main.nodeRegistry.enroll(PHONE.id, PHONE.token, { platform: "mobile", name: "Test phone" });
  main.nodeRegistry.enroll(WORKER.id, WORKER.token, { platform: "openagi", name: "Test worker" });
  // Configure after listen so this fixture doesn't start background relay jobs.
  writeNodeConfig({ remote: main.url, token: null }, worker.dataDir);
  const request = (route, init = {}, node = PHONE) => fetch(worker.url + route, {
    ...init, headers: { "content-type": "application/json", ...auth(node), ...init.headers }
  });
  return { main, worker, request };
}

test("a main-enrolled phone sees main's Today, Tasks, Inbox and history through a worker", async (t) => {
  const { main, worker, request } = await pair(t);
  const task = main.runtime.tasks.add({ queue: "user", title: "Main task", bucket: "today" });
  worker.runtime.tasks.add({ queue: "user", title: "Decoy worker task", bucket: "today" });
  main.runtime.pendingActions.enqueue({ toolName: "test-action", summary: "Main approval" });
  main.runtime.agentHost.store.appendMessage("devices:agent:main", { role: "assistant", content: "Main history" });
  const summary = await request("/mobile/summary");
  assert.equal(summary.status, 200);
  assert.equal(summary.headers.get("x-openagi-data-source"), "main");
  const body = await summary.json();
  assert.deepEqual(body.today.map((row) => row.title), ["Main task"]);
  assert.equal(body.pendingActions[0].summary, "Main approval");
  assert.deepEqual((await (await request("/tasks?queue=user")).json()).tasks.map((row) => row.title), ["Main task"]);
  assert.equal((await (await request("/pending-actions")).json()).actions[0].summary, "Main approval");
  const history = await (await request("/conversations/agent/messages")).json();
  assert.equal(history.messages[0].text, "Main history");
  const unchanged = await request("/mobile/summary", { headers: { "if-none-match": summary.headers.get("etag") } });
  assert.equal(unchanged.status, 304);
  assert.equal((await request(`/tasks/${task.id}/complete`, { method: "POST", body: "{}" })).status, 200);
  assert.equal((await (await request("/mobile/summary")).json()).counts.today, 0);
  assert.equal(worker.runtime.tasks.list({ queue: "user" })[0].title, "Decoy worker task");
  assert.equal(worker.nodeRegistry.enrollment(PHONE.id), null, "phone never needs a second worker enrollment");
});

test("main-issued enrollment exchanges, heartbeats and revokes through the worker", async (t) => {
  const { main, worker } = await pair(t);
  const issued = await fetch(main.url + "/nodes/enrollment-code", { method: "POST",
    headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json" }, body: '{"platform":"mobile"}' });
  assert.equal(issued.status, 200);
  const { code } = await issued.json();
  const phone = { id: `mobile:${randomUUID()}`, token: "n".repeat(43) };
  const exchange = await fetch(worker.url + "/nodes/enroll/exchange", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ code,
      platform: "mobile", nodeId: phone.id, nodeToken: phone.token, name: "New test phone" }) });
  assert.equal(exchange.status, 200);
  const heartbeat = await fetch(worker.url + "/nodes/heartbeat", { method: "POST",
    headers: { "content-type": "application/json", ...auth(phone) }, body: JSON.stringify({ nodeId: phone.id, role: "node" }) });
  assert.equal(heartbeat.status, 200);
  const revoke = await fetch(worker.url + "/nodes/revoke", { method: "POST",
    headers: { "content-type": "application/json", ...auth(phone) }, body: JSON.stringify({ nodeId: phone.id }) });
  assert.equal(revoke.status, 200);
  assert.equal(main.nodeRegistry.authenticate(phone.id, phone.token), false);
});

test("worker-only enrollment reports a main access error without revoking or returning local data", async (t) => {
  const { worker, request } = await pair(t);
  const local = { id: `mobile:${randomUUID()}`, token: "l".repeat(43) };
  worker.nodeRegistry.enroll(local.id, local.token, { platform: "mobile" });
  const response = await request("/mobile/summary", {}, local);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, "main-pairing-required");
  assert.equal(worker.nodeRegistry.authenticate(local.id, local.token), true);
});

test("routing preserves main's scopes and worker's origin gate", async (t) => {
  const { request } = await pair(t);
  assert.equal((await request("/pending-actions", {}, WORKER)).status, 502);
  assert.equal((await request("/conversations/agent/messages", {}, WORKER)).status, 502);
  assert.equal((await request("/settings/models", {}, WORKER)).status, 502);
  assert.equal((await request("/mobile/summary", {}, { id: PHONE.id, token: "wrong" })).status, 502);
  assert.equal((await request("/mobile/summary", {}, { id: PHONE.id, token: "" })).status, 401);
  const blocked = await request("/tasks", { method: "POST", headers: { origin: "https://other.example" },
    body: '{"title":"Must not be created"}' });
  assert.equal(blocked.status, 403);
});

async function server(t, handler) {
  const app = http.createServer(handler);
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { app.closeAllConnections(); app.close(resolve); }));
  return { app, url: `http://127.0.0.1:${app.address().port}` };
}

test("main outage never substitutes worker data", async (t) => {
  const { main, request } = await pair(t);
  await main.close();
  const response = await request("/tasks");
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, "main-unavailable");
});

test("forwarding is pinned, does not follow redirects and detects worker loops", async (t) => {
  const redirect = await server(t, (_req, res) => {
    res.writeHead(302, { location: "http://127.0.0.1:1", "set-cookie": "private=secret" }); res.end();
  });
  const proxy = await server(t, (req, res) => routeMainData(req, res, new URL(req.url, "http://worker"), {
    pairing: { remote: redirect.url }, ownerAuthenticated: false
  }));
  const response = await fetch(proxy.url + "/tasks", { headers: auth(PHONE) });
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal((await fetch(proxy.url + "/tasks", { headers: { ...auth(PHONE), "x-openagi-main-hop": "1" } })).status, 508);
  assert.equal((await fetch(proxy.url + "/tasks")).status, 401);
});

test("SSE stays open across idle periods and sends main's events", async (t) => {
  const main = await server(t, (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${PHONE.token}`);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": connected\n\n");
    const timer = setTimeout(() => res.end("data: main event\n\n"), 100);
    res.on("close", () => clearTimeout(timer));
  });
  const proxy = await server(t, (req, res) => routeMainData(req, res, new URL(req.url, "http://worker"), {
    pairing: { remote: main.url }, ownerAuthenticated: false, timeoutMs: 30
  }));
  const response = await fetch(proxy.url + "/events", { headers: auth(PHONE) });
  assert.match(await response.text(), /data: main event/);
});

test("local owner token is never forwarded as main authority", async (t) => {
  const main = await server(t, (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${WORKER.token}`);
    assert.equal(req.headers["x-openagi-node-id"], WORKER.id);
    assert.equal(req.url, "/tasks?queue=user", "local query tokens must not leave the worker");
    res.end("{}");
  });
  const proxy = await server(t, (req, res) => routeMainData(req, res, new URL(req.url, "http://worker"), {
    pairing: { remote: main.url, nodeToken: WORKER.token, nodeEnrollmentConfirmed: true },
    identity: { nodeId: WORKER.id }, ownerAuthenticated: true
  }));
  assert.equal((await fetch(proxy.url + `/tasks?queue=user&token=${OWNER}`, { headers: { authorization: `Bearer ${OWNER}` } })).status, 200);
});

test("only shared workspace routes forward, with their allowed methods", () => {
  for (const route of ["/tasks", "/mobile/summary", "/workspace/persona", "/settings/models", "/lifelog/moments"]) {
    assert.equal(isMainDataRoute("GET", route), true, route);
  }
  for (const route of ["/fleet/api/state", "/nodes", "/nodes/control/poll", "/control/restart", "/tasks/a/b", "/tasks/../control/restart"]) {
    assert.equal(isMainDataRoute("GET", route), false, route);
  }
  assert.equal(isMainDataRoute("DELETE", "/message"), false);
  assert.equal(isMainDataRoute("POST", "/brief/focus/dismiss"), true);
});
