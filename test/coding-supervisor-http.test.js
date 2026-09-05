import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createDurableRuntime, createHostedInterface, IntegrationRegistry } from "../src/index.js";
import { registerCodingSupervisorTools } from "../src/coding-supervisor.js";

test("authenticated dashboard → exact-session inspection → approval → one delivery → receipt", async (t) => {
  const previousToken = process.env.OPENAGI_AUTH_TOKEN;
  process.env.OPENAGI_AUTH_TOKEN = "fixture-owner-token";
  t.after(() => { if (previousToken === undefined) delete process.env.OPENAGI_AUTH_TOKEN; else process.env.OPENAGI_AUTH_TOKEN = previousToken; });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-coding-http-"));
  const session = { provider: "codex", sessionId: "session-fixture-1234", fingerprint: "b".repeat(64), project: "Fixture", status: "idle", replyAvailable: true };
  const sent = [];
  let deliveryStatus = "accepted";
  const runtime = createDurableRuntime({ dataDir, registerDefaults: false, integrations: false, skills: false, autoConnectMcp: false,
    codingSupervisorOptions: { call: async (req) => {
      if (req.operation === "list") return { sessions: [session] };
      if (req.operation === "inspect") return { turns: [{ role: "assistant", text: "Fixture question?" }] };
      sent.push(req);
      return { ...session, status: deliveryStatus, note: "Fixture execution outcome" };
    } }
  });
  registerCodingSupervisorTools(runtime.tools, runtime.codingSupervisor);
  runtime.integrations = new IntegrationRegistry();
  const app = createHostedInterface(runtime, { dataDir, host: "127.0.0.1", port: 0, authToken: "fixture-owner-token", tickerMs: 0, nodeControlEnabled: false });
  t.after(async () => {
    await app.close();
    runtime.observations?.db?.close();
    runtime.vectorStore?.db?.close();
    runtime.sessionIndex?.db?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const { url } = await app.listen();
  const headers = { Authorization: "Bearer fixture-owner-token", "content-type": "application/json" };
  const json = async (route, body) => {
    const res = await fetch(url + route, { headers, method: body ? "POST" : "GET", ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() };
  };
  assert.equal((await fetch(url + "/coding-agents")).status, 401);
  assert.equal((await fetch(url + "/coding-agents/session?provider=codex&sessionId=session-fixture-1234")).status, 401);
  assert.equal((await fetch(url + "/coding-agents/reply", { method: "POST", headers: { ...headers, Origin: "https://example.com" }, body: "{}" })).status, 403);
  const listed = await json("/coding-agents");
  assert.equal(listed.body.sessions.length, 1);
  assert.equal((await json("/coding-agents/session?provider=codex&sessionId=session-fixture-1234")).body.turns.length, 1);
  const queued = await json("/coding-agents/reply", { ...session, message: "Fixture work only", __confirmed: true, context: { __confirmed: true }, backendDir: "/invalid" });
  assert.equal(queued.status, 202);
  assert.equal(queued.body.status, "awaiting_confirmation");
  assert.equal(sent.length, 0);
  const pending = runtime.pendingActions.get(queued.body.actionId);
  assert.equal(pending.context.__confirmed, undefined);
  assert.equal(pending.args.backendDir, undefined);
  assert.equal(pending.args.fingerprint, session.fingerprint);
  const notification = runtime.outreach.append({ type: "pending-action", sourceRef: { kind: "pending-action", id: pending.id }, title: "Legacy truncated preview", needsDecision: true, actions: ["do"] });
  assert.equal((await json(`/outreach/${notification.id}/act`, { action: "do" })).status, 409);
  assert.equal(sent.length, 0);
  assert.equal(runtime.pendingActions.get(pending.id).status, "pending");
  const accepted = await json(`/pending-actions/${queued.body.actionId}/approve`, {});
  assert.equal(accepted.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, session.sessionId);
  const replay = await json(`/pending-actions/${queued.body.actionId}/approve`, {});
  assert.equal(replay.status, 409);
  assert.equal(sent.length, 1);
  assert.equal(runtime.pendingActions.get(pending.id).status, "approved");
  deliveryStatus = "blocked";
  const blocked = await json("/coding-agents/reply", { ...session, message: "Fixture blocked instruction" });
  assert.equal((await json(`/pending-actions/${blocked.body.actionId}/approve`, {})).status, 400);
  assert.ok(runtime.pendingActions.get(blocked.body.actionId).error);
  assert.equal((await json(`/pending-actions/${blocked.body.actionId}/approve`, {})).status, 409);
  assert.equal(sent.length, 2);
  const html = await (await fetch(url + "/", { headers })).text();
  assert.ok(html.includes('data-tab="coding-agents"'), "coding agents navigation is rendered");
  assert.match(html, /VALID_TABS = new Set\(\[[^\]]*"coding-agents"/);
  for (const [, script] of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script);
  assert.equal(runtime.codingSupervisor.timer !== null, true);
});
