import test from "node:test";
import assert from "node:assert/strict";
import { createFleetRoute } from "../src/fleet/routes.js";

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
      { id: "fq_open1", dedupeKey: "k1", kind: "agent-ask", threadKey: "codex:a", prRef: "o/r#1", title: "Merge?", body: "", options: ["yes", "no"], status: "open", answer: null, createdAt: "2026-09-26T00:00:00.000Z" }
    ],
    actions: [
      { id: "fa_prop1", status: "proposed", threadKey: "codex:a", message: "go" },
      { id: "fa_sent1", status: "sent", threadKey: "codex:b", message: "go" }
    ]
  };
  return {
    calls,
    state,
    getState() { calls.push(["getState"]); return structuredClone(state); },
    async tick({ reason }) { calls.push(["tick", reason]); state.lastTickAt = "2026-09-26T01:00:00.000Z"; return { at: state.lastTickAt, reason }; },
    setMode(mode) {
      calls.push(["setMode", mode]);
      if (!["observe", "propose", "auto"].includes(mode)) return null;
      state.mode = mode;
      return mode;
    },
    async answerQuestion(id, answer) {
      calls.push(["answerQuestion", id, answer]);
      const question = state.questions.find((q) => q.id === id);
      if (!question) return null;
      state.questions = state.questions.filter((q) => q.id !== id);
      return { question: { ...question, status: "answered", answer }, delivery: { status: "sent" } };
    },
    dismissQuestion(id) {
      calls.push(["dismissQuestion", id]);
      const question = state.questions.find((q) => q.id === id);
      if (!question) return null;
      state.questions = state.questions.filter((q) => q.id !== id);
      return { ...question, status: "dismissed" };
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

const body = (value) => async () => value;
const url = (path) => new URL("http://127.0.0.1" + path);

test("fleet route ignores paths outside /fleet/api", async () => {
  const route = createFleetRoute({ supervisor: fakeSupervisor() });
  assert.equal(await route("GET", "/fleet", url("/fleet"), body({})), null);
  assert.equal(await route("GET", "/fleet/apix", url("/fleet/apix"), body({})), null);
  assert.equal(await route("GET", "/coding-agents", url("/coding-agents"), body({})), null);
});

test("GET /fleet/api/state returns the supervisor state", async () => {
  const supervisor = fakeSupervisor();
  const route = createFleetRoute({ supervisor });
  const result = await route("GET", "/fleet/api/state", url("/fleet/api/state"), body({}));
  assert.equal(result.status, 200);
  assert.equal(result.body.mode, "observe");
  assert.equal(result.body.questions.length, 1);
  assert.equal((await route("POST", "/fleet/api/state", url("/fleet/api/state"), body({}))).status, 405);
});

test("missing supervisor answers 503, not a crash", async () => {
  const route = createFleetRoute({ supervisor: null });
  const result = await route("GET", "/fleet/api/state", url("/fleet/api/state"), body({}));
  assert.equal(result.status, 503);
});

test("POST /fleet/api/scan runs a manual tick and returns state", async () => {
  const supervisor = fakeSupervisor();
  const route = createFleetRoute({ supervisor });
  const result = await route("POST", "/fleet/api/scan", url("/fleet/api/scan"), body({}));
  assert.equal(result.status, 200);
  assert.deepEqual(supervisor.calls.find((c) => c[0] === "tick"), ["tick", "manual"]);
  assert.equal(result.body.lastTickAt, "2026-09-26T01:00:00.000Z");
  assert.equal((await route("GET", "/fleet/api/scan", url("/fleet/api/scan"), body({}))).status, 405);
});

test("scan failure is a 500 with state, never a thrown error", async () => {
  const supervisor = fakeSupervisor();
  supervisor.tick = async () => { throw new Error("boom /Users/secret/path"); };
  const route = createFleetRoute({ supervisor });
  const result = await route("POST", "/fleet/api/scan", url("/fleet/api/scan"), body({}));
  assert.equal(result.status, 500);
  assert.equal(result.body.error, "Scan failed.");
  assert.equal(result.body.state.mode, "observe");
});

test("POST /fleet/api/mode validates the mode", async () => {
  const supervisor = fakeSupervisor();
  const route = createFleetRoute({ supervisor });
  const ok = await route("POST", "/fleet/api/mode", url("/fleet/api/mode"), body({ mode: "propose" }));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.mode, "propose");
  assert.equal((await route("POST", "/fleet/api/mode", url("/fleet/api/mode"), body({ mode: "yolo" }))).status, 400);
  assert.equal((await route("POST", "/fleet/api/mode", url("/fleet/api/mode"), body({}))).status, 400);
  assert.equal((await route("POST", "/fleet/api/mode", url("/fleet/api/mode"), body([]))).status, 400);
  assert.equal((await route("GET", "/fleet/api/mode", url("/fleet/api/mode"), body({}))).status, 405);
});

test("unreadable or oversized bodies are 400", async () => {
  const route = createFleetRoute({ supervisor: fakeSupervisor() });
  const broken = async () => { throw new Error("request body too large"); };
  assert.equal((await route("POST", "/fleet/api/mode", url("/fleet/api/mode"), broken)).status, 400);
  assert.equal((await route("POST", "/fleet/api/questions/fq_open1", url("/fleet/api/questions/fq_open1"), broken)).status, 400);
});

test("POST /fleet/api/questions/<id> answers with one of the options", async () => {
  const supervisor = fakeSupervisor();
  const route = createFleetRoute({ supervisor });
  const path = "/fleet/api/questions/fq_open1";
  assert.equal((await route("POST", path, url(path), body({ answer: "maybe" }))).status, 400);
  assert.equal((await route("POST", path, url(path), body({ answer: 7 }))).status, 400);
  assert.equal((await route("POST", path, url(path), body({}))).status, 400);
  const result = await route("POST", path, url(path), body({ answer: "yes" }));
  assert.equal(result.status, 200);
  assert.equal(result.body.question.answer, "yes");
  assert.equal(result.body.delivery.status, "sent");
  assert.deepEqual(supervisor.calls.find((c) => c[0] === "answerQuestion"), ["answerQuestion", "fq_open1", "yes"]);
  assert.equal(result.body.state.questions.length, 0);
  assert.equal((await route("POST", path, url(path), body({ answer: "yes" }))).status, 404);
});

test("answer 'dismiss' is accepted even when not an option", async () => {
  const supervisor = fakeSupervisor();
  const route = createFleetRoute({ supervisor });
  const path = "/fleet/api/questions/fq_open1";
  const result = await route("POST", path, url(path), body({ answer: "dismiss" }));
  assert.equal(result.status, 200);
  assert.deepEqual(supervisor.calls.find((c) => c[0] === "answerQuestion"), ["answerQuestion", "fq_open1", "dismiss"]);
});

test("{ dismiss: true } dismisses the question", async () => {
  const supervisor = fakeSupervisor();
  const route = createFleetRoute({ supervisor });
  const path = "/fleet/api/questions/fq_open1";
  const result = await route("POST", path, url(path), body({ dismiss: true }));
  assert.equal(result.status, 200);
  assert.equal(result.body.question.status, "dismissed");
  assert.equal(supervisor.calls.some((c) => c[0] === "answerQuestion"), false);
  assert.equal((await route("POST", path, url(path), body({ dismiss: true }))).status, 404);
});

test("answer race: question closed between check and answer is 409", async () => {
  const supervisor = fakeSupervisor();
  supervisor.answerQuestion = async () => null;
  const route = createFleetRoute({ supervisor });
  const path = "/fleet/api/questions/fq_open1";
  assert.equal((await route("POST", path, url(path), body({ answer: "yes" }))).status, 409);
});

test("question and action ids are validated", async () => {
  const supervisor = fakeSupervisor();
  const route = createFleetRoute({ supervisor });
  for (const bad of ["bad.id", "a%2Fb", "x".repeat(81), "%E2%9C%93"]) {
    const qp = "/fleet/api/questions/" + bad;
    assert.equal((await route("POST", qp, url(qp), body({ answer: "yes" }))).status, 400, qp);
    const ap = "/fleet/api/actions/" + bad + "/send";
    assert.equal((await route("POST", ap, url(ap), body({}))).status, 400, ap);
  }
  assert.equal(supervisor.calls.some((c) => c[0] === "answerQuestion" || c[0] === "sendProposed"), false);
  assert.equal((await route("GET", "/fleet/api/questions/fq_open1", url("/fleet/api/questions/fq_open1"), body({}))).status, 405);
});

test("POST /fleet/api/actions/<id>/send sends only proposed actions", async () => {
  const supervisor = fakeSupervisor();
  const route = createFleetRoute({ supervisor });
  const sent = await route("POST", "/fleet/api/actions/fa_prop1/send", url("/fleet/api/actions/fa_prop1/send"), body({}));
  assert.equal(sent.status, 200);
  assert.equal(sent.body.action.status, "sent");
  assert.equal(sent.body.delivery.status, "sent");
  assert.equal(sent.body.state.actions[0].status, "sent");
  assert.equal((await route("POST", "/fleet/api/actions/fa_sent1/send", url("/fleet/api/actions/fa_sent1/send"), body({}))).status, 409);
  assert.equal((await route("POST", "/fleet/api/actions/fa_nope/send", url("/fleet/api/actions/fa_nope/send"), body({}))).status, 404);
  assert.equal((await route("GET", "/fleet/api/actions/fa_prop1/send", url("/fleet/api/actions/fa_prop1/send"), body({}))).status, 405);
});

test("unknown /fleet/api paths are 404", async () => {
  const route = createFleetRoute({ supervisor: fakeSupervisor() });
  assert.equal((await route("GET", "/fleet/api/nope", url("/fleet/api/nope"), body({}))).status, 404);
  assert.equal((await route("POST", "/fleet/api/actions/fa_prop1", url("/fleet/api/actions/fa_prop1"), body({}))).status, 404);
  assert.equal((await route("POST", "/fleet/api/questions/fq_open1/extra", url("/fleet/api/questions/fq_open1/extra"), body({}))).status, 404);
});

test("a supervisor method that throws becomes a 500 JSON body", async () => {
  const supervisor = fakeSupervisor();
  supervisor.sendProposed = async () => { throw new Error("executor exploded"); };
  const route = createFleetRoute({ supervisor });
  const result = await route("POST", "/fleet/api/actions/fa_prop1/send", url("/fleet/api/actions/fa_prop1/send"), body({}));
  assert.equal(result.status, 500);
  assert.equal(typeof result.body.error, "string");
});
