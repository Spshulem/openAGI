// test/mobile-fleet-http.test.js
// A paired phone reaches the fleet supervisor's JSON API through the real
// hosted-interface gates (Origin, auth, mobile allowlist) and nothing past it.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDurableRuntime, createHostedInterface, IntegrationRegistry } from "../src/index.js";

const OWNER = "fixture-owner-token";

// Just enough of the FleetSupervisor surface for the routes. Calls land in `calls`.
function fakeSupervisor() {
  const calls = [];
  const state = {
    mode: "observe",
    enabled: true,
    running: false,
    lastTickAt: null,
    lastError: null,
    snapshot: null,
    questions: [
      { id: "fq_answer", kind: "agent-ask", threadKey: "codex:a", prRef: "o/r#1", title: "Merge #1?", body: "", options: ["yes", "no"], status: "open", createdAt: "2026-09-26T00:00:00.000Z" },
      { id: "fq_dismiss", kind: "model-limit", threadKey: "claude:b", prRef: null, title: "Switch model?", body: "", options: ["switched"], status: "open", createdAt: "2026-09-26T00:00:00.000Z" }
    ],
    actions: [{ id: "fa_prop", at: "2026-09-26T00:00:00.000Z", threadKey: "codex:a", status: "proposed", message: "go" }]
  };
  const open = () => state.questions.filter((q) => q.status === "open");
  const close = (id, patch) => {
    const question = open().find((q) => q.id === id);
    if (!question) return null;
    Object.assign(question, patch);
    return { ...question };
  };
  return {
    calls,
    start() {},
    stop() {},
    async tick({ reason } = {}) {
      calls.push(["tick", reason]);
      state.lastTickAt = "2026-09-26T01:00:00.000Z";
      state.snapshot = { at: state.lastTickAt, counts: { threads: 0, inScope: 0, byState: {}, needsYou: open().length, actions: 0 }, threads: [], infra: {}, sourceErrors: {} };
      return state.snapshot;
    },
    getState() { return structuredClone({ ...state, questions: open() }); },
    setMode(mode) {
      calls.push(["setMode", mode]);
      if (!["observe", "propose", "auto"].includes(mode)) return null;
      state.mode = mode;
      return mode;
    },
    async answerQuestion(id, answer) {
      calls.push(["answerQuestion", id, answer]);
      const question = close(id, { status: "answered", answer });
      return question ? { question, delivery: { status: "sent", route: "codex-exec", detail: null } } : null;
    },
    dismissQuestion(id) {
      calls.push(["dismissQuestion", id]);
      return close(id, { status: "dismissed" });
    },
    async sendProposed(id) {
      calls.push(["sendProposed", id]);
      const action = state.actions.find((a) => a.id === id);
      if (!action || action.status !== "proposed") return null;
      action.status = "sent";
      return { action: { ...action }, delivery: { status: "sent" } };
    }
  };
}

async function bootWithPhone(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobile-fleet-"));
  const fleet = fakeSupervisor();
  const runtime = createDurableRuntime({
    dataDir, registerDefaults: false, integrations: false, skills: false, autoConnectMcp: false,
    fleetSupervisor: fleet
  });
  runtime.integrations = new IntegrationRegistry();
  const app = createHostedInterface(runtime, { dataDir, host: "127.0.0.1", port: 0, authToken: OWNER, tickerMs: 0, nodeControlEnabled: false });
  t.after(async () => {
    await app.close();
    runtime.observations?.db?.close();
    runtime.vectorStore?.db?.close();
    runtime.sessionIndex?.db?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const { url } = await app.listen();

  const issued = await fetch(`${url}/nodes/enrollment-code`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OWNER}` },
    body: JSON.stringify({ platform: "mobile" })
  });
  assert.equal(issued.status, 200);
  const { code } = await issued.json();
  const nodeId = `mobile:${crypto.randomUUID()}`;
  const nodeToken = crypto.randomBytes(32).toString("base64url");
  const exchanged = await fetch(`${url}/nodes/enroll/exchange`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, platform: "mobile", nodeId, nodeToken, name: "Pixel" })
  });
  assert.equal(exchanged.status, 200);

  // No Origin header, exactly like the native phone clients.
  const asPhone = (route, { method = "GET", body, headers = {}, token = nodeToken } = {}) => fetch(url + route, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-openagi-node-id": nodeId, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return { url, fleet, asPhone };
}

test("a phone credential reads fleet state and answers, dismisses, switches mode, sends, and scans", async (t) => {
  const { fleet, asPhone } = await bootWithPhone(t);

  const state = await asPhone("/fleet/api/state");
  assert.equal(state.status, 200);
  assert.equal(state.headers.get("cache-control"), "no-store");
  const body = await state.json();
  assert.equal(body.mode, "observe");
  assert.deepEqual(body.questions.map((q) => q.id), ["fq_answer", "fq_dismiss"]);

  const answered = await asPhone("/fleet/api/questions/fq_answer", { method: "POST", body: { answer: "yes" } });
  assert.equal(answered.status, 200);
  const answer = await answered.json();
  assert.equal(answer.question.status, "answered");
  assert.equal(answer.delivery.status, "sent");
  assert.deepEqual(answer.state.questions.map((q) => q.id), ["fq_dismiss"]);

  const dismissed = await asPhone("/fleet/api/questions/fq_dismiss", { method: "POST", body: { dismiss: true } });
  assert.equal(dismissed.status, 200);
  assert.equal((await dismissed.json()).question.status, "dismissed");
  // A question that is no longer open is refused, never answered twice.
  const again = await asPhone("/fleet/api/questions/fq_answer", { method: "POST", body: { answer: "yes" } });
  assert.equal(again.status, 404);

  const mode = await asPhone("/fleet/api/mode", { method: "POST", body: { mode: "propose" } });
  assert.equal(mode.status, 200);
  assert.equal((await mode.json()).mode, "propose");

  const sent = await asPhone("/fleet/api/actions/fa_prop/send", { method: "POST" });
  assert.equal(sent.status, 200);
  assert.equal((await sent.json()).action.status, "sent");
  assert.equal((await asPhone("/fleet/api/actions/fa_prop/send", { method: "POST" })).status, 409);

  const scan = await asPhone("/fleet/api/scan", { method: "POST" });
  assert.equal(scan.status, 200);
  assert.equal((await scan.json()).lastTickAt, "2026-09-26T01:00:00.000Z");

  assert.deepEqual(fleet.calls.map(([name]) => name), ["answerQuestion", "dismissQuestion", "setMode", "sendProposed", "sendProposed", "tick"]);
});

test("the phone credential stops at the fleet JSON API", async (t) => {
  const { fleet, asPhone } = await bootWithPhone(t);
  // The owner's /fleet page is not the phone's, as JSON or as a browser.
  assert.equal((await asPhone("/fleet")).status, 401);
  const html = await asPhone("/fleet", { headers: { accept: "text/html" } });
  assert.equal(html.status, 401);
  assert.doesNotMatch(await html.text(), /Needs you/);
  assert.equal((await asPhone("/fleet/api/unknown")).status, 401);
  assert.equal((await asPhone("/fleet/api/state", { method: "POST", body: {} })).status, 401);
  assert.equal((await asPhone("/outreach/feed")).status, 401);
  assert.equal((await asPhone("/coding-agents")).status, 401);
  // A wrong token for the enrolled node id is not a phone.
  assert.equal((await asPhone("/fleet/api/state", { token: crypto.randomBytes(32).toString("base64url") })).status, 401);
  // A browser page on another origin cannot ride a phone credential.
  const crossOrigin = await asPhone("/fleet/api/mode", { method: "POST", body: { mode: "auto" }, headers: { origin: "https://evil.example" } });
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(fleet.calls, []);
});
