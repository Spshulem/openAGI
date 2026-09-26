import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDurableRuntime, createHostedInterface, IntegrationRegistry } from "../src/index.js";

const TOKEN = "fixture-owner-token";
const AUTH = { Authorization: "Bearer " + TOKEN, "content-type": "application/json" };

// Implements the agreed FleetSupervisor surface without touching sources,
// the store, or any real agent. Every call lands in `calls`.
function fakeSupervisor() {
  const calls = [];
  const state = {
    mode: "observe",
    enabled: false,
    running: false,
    lastTickAt: null,
    lastError: null,
    snapshot: null,
    questions: [
      { id: "fq_answer", dedupeKey: "k1", kind: "agent-ask", threadKey: "codex:a", prRef: "o/r#1", title: "Merge #1?", body: "", options: ["yes", "no"], status: "open", answer: null, createdAt: "2026-09-26T00:00:00.000Z" },
      { id: "fq_dismiss", dedupeKey: "k2", kind: "model-limit", threadKey: "claude:b", prRef: null, title: "Fable capped. Switch model?", body: "", options: ["switched"], status: "open", answer: null, createdAt: "2026-09-26T00:00:00.000Z" },
      { id: "fq_http", dedupeKey: "k3", kind: "agent-ask", threadKey: "codex:c", prRef: "o/r#3", title: "Ship #3?", body: "", options: ["ship"], status: "open", answer: null, createdAt: "2026-09-26T00:00:00.000Z" }
    ],
    actions: [{ id: "fa_prop", at: "2026-09-26T00:00:00.000Z", threadKey: "codex:a", status: "proposed", message: "go", route: "codex-exec" }]
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
    config: { enabled: false, mode: "observe" },
    start() { calls.push(["start"]); },
    stop() { calls.push(["stop"]); },
    async tick({ reason } = {}) {
      calls.push(["tick", reason]);
      state.lastTickAt = "2026-09-26T01:00:00.000Z";
      state.snapshot = { at: state.lastTickAt, reason, durationMs: 1, mode: state.mode, counts: { threads: 0, inScope: 0, byState: {}, needsYou: open().length, actions: 1 }, threads: [], infra: {}, sourceErrors: {} };
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
      const target = open().find((q) => q.id === id);
      if (!target || (answer !== "dismiss" && !target.options.includes(answer))) return null;
      const question = close(id, { status: answer === "dismiss" ? "dismissed" : "answered", answer });
      return { question, delivery: question.kind === "agent-ask" ? { status: "sent", route: "codex-exec" } : null };
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

async function boot(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-fleet-http-"));
  const fleet = fakeSupervisor();
  const runtime = createDurableRuntime({
    dataDir, registerDefaults: false, integrations: false, skills: false, autoConnectMcp: false,
    fleetSupervisor: fleet
  });
  runtime.integrations = new IntegrationRegistry();
  const app = createHostedInterface(runtime, { dataDir, host: "127.0.0.1", port: 0, authToken: TOKEN, tickerMs: 0, nodeControlEnabled: false });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.close();
  };
  t.after(async () => {
    await close();
    runtime.observations?.db?.close();
    runtime.vectorStore?.db?.close();
    runtime.sessionIndex?.db?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const { url } = await app.listen();
  const json = async (route, body) => {
    const res = await fetch(url + route, { headers: AUTH, method: body ? "POST" : "GET", ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() };
  };
  return { url, runtime, fleet, json, close };
}

test("runtime uses the injected fleet supervisor and the server starts and stops it", async (t) => {
  const { runtime, fleet, close } = await boot(t);
  assert.equal(runtime.fleetSupervisor, fleet);
  assert.deepEqual(fleet.calls.filter(([name]) => name === "start"), [["start"]]);
  await close();
  assert.deepEqual(fleet.calls.filter(([name]) => name === "stop"), [["stop"]]);
});

test("fleet page and API sit behind the owner auth and Origin gates", async (t) => {
  const { url, fleet } = await boot(t);
  assert.equal((await fetch(url + "/fleet")).status, 401);
  assert.equal((await fetch(url + "/fleet/api/state")).status, 401);
  assert.equal((await fetch(url + "/fleet/api/scan", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  const browser = await fetch(url + "/fleet", { headers: { accept: "text/html" } });
  assert.equal(browser.status, 401);
  assert.doesNotMatch(await browser.text(), /Needs you/, "signed-out browsers get the login page, not the fleet page");
  const crossOrigin = await fetch(url + "/fleet/api/scan", { method: "POST", headers: { ...AUTH, Origin: "https://example.com" }, body: "{}" });
  assert.equal(crossOrigin.status, 403);
  const crossMode = await fetch(url + "/fleet/api/mode", { method: "POST", headers: { ...AUTH, Origin: "https://example.com" }, body: JSON.stringify({ mode: "auto" }) });
  assert.equal(crossMode.status, 403);
  assert.deepEqual(fleet.calls.filter(([name]) => name === "tick" || name === "setMode"), []);
});

test("GET /fleet serves the mini app with a nonce'd script and a matching CSP", async (t) => {
  const { url } = await boot(t);
  const res = await fetch(url + "/fleet", { headers: { Authorization: "Bearer " + TOKEN } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const html = await res.text();
  assert.match(html, /Needs you/);
  const nonce = /<script nonce="([^"]+)">/.exec(html)?.[1];
  assert.ok(nonce, "the page script carries the per-response nonce");
  assert.ok(res.headers.get("content-security-policy").includes("'nonce-" + nonce + "'"));
  assert.doesNotMatch(html, /<script>/, "no script tag escapes the nonce");
  assert.doesNotMatch(html, /\son[a-z]+\s*=\s*["']/i, "no inline event handlers under the nonce-only CSP");
});

test("GET /fleet?token= signs the browser in like the dashboard", async (t) => {
  const { url } = await boot(t);
  const res = await fetch(url + "/fleet?token=" + TOKEN);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("set-cookie") ?? "", /openagi_token=/, "phone deep links with ?token= keep working for the page's API calls");
});

test("state, scan, mode, answer, and send go through the JSON API", async (t) => {
  const { json, fleet } = await boot(t);
  const state = await json("/fleet/api/state");
  assert.equal(state.status, 200);
  assert.equal(state.body.mode, "observe");
  assert.equal(state.body.questions.length, 3);

  const scan = await json("/fleet/api/scan", {});
  assert.equal(scan.status, 200);
  assert.equal(scan.body.lastTickAt, "2026-09-26T01:00:00.000Z");
  assert.deepEqual(fleet.calls.filter(([name]) => name === "tick"), [["tick", "manual"]]);

  const mode = await json("/fleet/api/mode", { mode: "propose" });
  assert.equal(mode.status, 200);
  assert.equal(mode.body.mode, "propose");
  assert.equal((await json("/fleet/api/mode", { mode: "yolo" })).status, 400);
  assert.equal((await json("/fleet/api/state")).body.mode, "propose");

  const answered = await json("/fleet/api/questions/fq_http", { answer: "ship" });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.question.answer, "ship");
  assert.equal(answered.body.delivery.status, "sent");
  assert.equal((await json("/fleet/api/questions/fq_http", { answer: "ship" })).status, 404);

  const sent = await json("/fleet/api/actions/fa_prop/send", {});
  assert.equal(sent.status, 200);
  assert.equal(sent.body.action.status, "sent");
  assert.equal((await json("/fleet/api/actions/fa_prop/send", {})).status, 409);
  assert.equal((await json("/fleet/api/nope")).status, 404);
});

test("outreach answers and dismissals on fleet items reach the supervisor", async (t) => {
  const { json, fleet, runtime } = await boot(t);
  const ask = runtime.outreach.append({
    type: "fleet-question", sourceRef: { kind: "fleet", id: "fq_answer" }, title: "Merge #1?", summary: "",
    needsDecision: true, actions: ["yes", "no", "dismiss"], dedupeOpen: true
  });
  const answered = await json("/outreach/" + ask.id + "/act", { action: "yes" });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.item.status, "acted");
  assert.deepEqual(fleet.calls.filter(([name]) => name === "answerQuestion"), [["answerQuestion", "fq_answer", "yes"]]);

  const capped = runtime.outreach.append({
    type: "fleet-question", sourceRef: { kind: "fleet", id: "fq_dismiss" }, title: "Fable capped. Switch model?", summary: "",
    needsDecision: true, actions: ["switched", "dismiss"], dedupeOpen: true
  });
  const dismissed = await json("/outreach/" + capped.id + "/act", { action: "dismiss" });
  assert.equal(dismissed.status, 200);
  assert.equal(dismissed.body.item.status, "dismissed");
  assert.deepEqual(fleet.calls.filter(([name]) => name === "dismissQuestion"), [["dismissQuestion", "fq_dismiss"]]);
  assert.equal((await json("/fleet/api/state")).body.questions.some((q) => q.id === "fq_dismiss"), false);

  // Already answered on /fleet: the outreach copy reports the failure instead of pretending it acted.
  const stale = runtime.outreach.append({
    type: "fleet-question", sourceRef: { kind: "fleet", id: "fq_answer" }, title: "Merge #1?", summary: "",
    needsDecision: true, actions: ["yes", "no", "dismiss"]
  });
  const late = await json("/outreach/" + stale.id + "/act", { action: "yes" });
  assert.equal(late.status, 400);
  assert.equal(late.body.item.status, "error");
});

test("fleet events reach SSE clients", async (t) => {
  const { url, runtime } = await boot(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const res = await fetch(url + "/events", { headers: { Authorization: "Bearer " + TOKEN, accept: "text/event-stream" }, signal: controller.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const waitFor = async (pattern) => {
    const deadline = Date.now() + 5000;
    while (!pattern.test(buffer)) {
      if (Date.now() > deadline) throw new Error("timed out waiting for " + pattern);
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended");
      buffer += decoder.decode(value, { stream: true });
    }
    return buffer.match(pattern);
  };
  await waitFor(/event: hello\n/);
  runtime.events.emit("fleet", { at: "2026-09-26T01:00:00.000Z", reason: "timer", counts: { threads: 4, needsYou: 1 } });
  const match = await waitFor(/event: fleet\ndata: (.+)\n\n/);
  assert.deepEqual(JSON.parse(match[1]), { at: "2026-09-26T01:00:00.000Z", reason: "timer", counts: { threads: 4, needsYou: 1 } });
  controller.abort();
});

test("dashboard header links to the fleet page", async (t) => {
  const previous = process.env.OPENAGI_AUTH_TOKEN;
  process.env.OPENAGI_AUTH_TOKEN = TOKEN;
  t.after(() => { if (previous === undefined) delete process.env.OPENAGI_AUTH_TOKEN; else process.env.OPENAGI_AUTH_TOKEN = previous; });
  const { url } = await boot(t);
  const res = await fetch(url + "/", { headers: { Authorization: "Bearer " + TOKEN, accept: "text/html" } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<a href="\/fleet" class="ui-btn ui-btn-secondary">Fleet<\/a>/);
});
