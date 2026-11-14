import test from "node:test";
import assert from "node:assert/strict";
import { createFleetRoute } from "../src/fleet/routes.js";
import { DEADLINE_MARGIN_MS } from "../src/fleet/ui-delivery.js";

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
  assert.deepEqual(supervisor.calls.find((c) => c[0] === "tick"), ["tick", "owner-scan"]);
  assert.equal(result.body.lastTickAt, "2026-09-26T01:00:00.000Z");
  assert.equal((await route("GET", "/fleet/api/scan", url("/fleet/api/scan"), body({}))).status, 405);
});

test("a scan through the broker answers before its deadline, even when the tick it rides runs on", async () => {
  const supervisor = fakeSupervisor();
  let calls = 0;
  supervisor.tick = (opts) => { calls += 1; supervisor.calls.push(["tick", opts.reason, opts.deferUi]); return new Promise(() => {}); };
  const route = createFleetRoute({ supervisor });
  const started = Date.now();
  const result = await route("POST", "/fleet/api/scan", url("/fleet/api/scan"), body({}), { remote: true, deadlineAt: Date.now() + DEADLINE_MARGIN_MS + 50 });
  assert.equal(result.status, 200);
  assert.ok(Date.now() - started < DEADLINE_MARGIN_MS, "answered before the deadline");
  assert.deepEqual(supervisor.calls.find((c) => c[0] === "tick"), ["tick", "owner-scan", true]);
  assert.equal(calls, 1);
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

test("{ reopen: true } reopens a question the review closed", async () => {
  const supervisor = fakeSupervisor();
  supervisor.reopenReviewed = (id) => {
    supervisor.calls.push(["reopenReviewed", id]);
    return id === "fq_closed" ? { id, status: "open", pinned: true } : null;
  };
  const route = createFleetRoute({ supervisor });
  const path = "/fleet/api/questions/fq_closed";
  const result = await route("POST", path, url(path), body({ reopen: true }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.question, { id: "fq_closed", status: "open", pinned: true });
  assert.ok(result.body.state);
  assert.equal(supervisor.calls.some((c) => c[0] === "answerQuestion" || c[0] === "dismissQuestion"), false);
  const other = "/fleet/api/questions/fq_open1";
  assert.equal((await route("POST", other, url(other), body({ reopen: true }))).status, 409);
  delete supervisor.reopenReviewed;
  assert.equal((await route("POST", path, url(path), body({ reopen: true }))).status, 503);
});

test("state carries the supervisor's clears and review notes; a reopen answers with the fresh state", async () => {
  const supervisor = fakeSupervisor();
  const cleared = { id: "fq_closed", dedupeKey: "k2", title: "#7 ready. Merge?", status: "resolved", resolvedBy: "review", reviewCategory: "stale", reviewReason: "merged", answeredAt: "2026-09-26T00:30:00.000Z" };
  Object.assign(supervisor.state.questions[0], { reviewCategory: "live", reviewReason: "the agent waits on you", reviewedAt: "2026-09-26T00:10:00.000Z" });
  supervisor.state.reviewClosed = [cleared];
  supervisor.reopenReviewed = (id) => {
    const question = supervisor.state.reviewClosed.find((q) => q.id === id);
    if (!question) return null;
    supervisor.state.reviewClosed = [];
    const open = { ...question, status: "open", resolvedBy: null, pinned: true };
    supervisor.state.questions.push(open);
    return open;
  };
  const route = createFleetRoute({ supervisor });
  const got = await route("GET", "/fleet/api/state", url("/fleet/api/state"), body({}));
  assert.deepEqual(got.body.reviewClosed, [cleared]);
  assert.equal(got.body.questions[0].reviewReason, "the agent waits on you");
  const path = "/fleet/api/questions/fq_closed";
  const result = await route("POST", path, url(path), body({ reopen: true }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.state.reviewClosed, []);
  assert.deepEqual(result.body.state.questions.map((q) => q.id), ["fq_open1", "fq_closed"]);
  assert.equal((await route("POST", path, url(path), body({ reopen: true }))).status, 409, "reopens once");
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

test("screen, click and app routes validate their input and reach the supervisor", async () => {
  const supervisor = fakeSupervisor();
  supervisor.screenThread = async (key, options) => { supervisor.calls.push(["screenThread", key, options.deadlineAt]); return { status: "read", detail: "read Codex", screen: { prompt: null } }; };
  supervisor.clickThread = async (key, label, options) => { supervisor.calls.push(["clickThread", key, label, options.stateId]); return { delivery: { status: "sent", detail: `clicked ${label}` }, prompt: null }; };
  supervisor.appAction = async (app, action, options) => { supervisor.calls.push(["appAction", app, action, options.expectRunning]); return { ok: true, detail: "restarted Conductor" }; };
  const route = createFleetRoute({ supervisor });
  const post = (path, body) => route("POST", path, null, async () => body);
  const screen = await post("/fleet/api/screen", { threadKey: "codex:t1" });
  assert.equal(screen.status, 200);
  assert.equal(screen.body.status, "read");
  assert.equal((await post("/fleet/api/screen", { threadKey: "../etc" })).status, 400);
  const clicked = await post("/fleet/api/click", { threadKey: "codex:t1", label: "Allow once", stateId: "0123456789abcdef" });
  assert.equal(clicked.body.delivery.status, "sent");
  assert.equal((await post("/fleet/api/click", { threadKey: "codex:t1", label: "" })).status, 400);
  assert.equal((await post("/fleet/api/click", { threadKey: "codex:t1", label: "Allow", stateId: "x" })).status, 400);
  const restarted = await post("/fleet/api/apps/conductor/restart", { expectRunning: ["conductor:s1", "../bad", 7] });
  assert.equal(restarted.status, 200);
  assert.equal(restarted.body.result.ok, true);
  assert.equal((await post("/fleet/api/apps/finder/quit", {})).status, 404);
  assert.equal((await post("/fleet/api/apps/codex/kill", {})).status, 404);
  assert.equal((await route("GET", "/fleet/api/screen", null, async () => ({}))).status, 405);
  supervisor.runningInApp = async (app) => (app === "codex" ? [{ key: "codex:t1", name: "billing" }] : null);
  assert.deepEqual((await route("GET", "/fleet/api/apps/codex/running", null, async () => ({}))).body.running, [{ key: "codex:t1", name: "billing" }]);
  assert.equal((await route("GET", "/fleet/api/apps/conductor/running", null, async () => ({}))).status, 503, "unreadable is not idle");
  assert.equal((await post("/fleet/api/apps/codex/running", {})).status, 405);
  assert.deepEqual(supervisor.calls.filter((call) => call[0] !== "getState"), [
    ["screenThread", "codex:t1", null],
    ["clickThread", "codex:t1", "Allow once", "0123456789abcdef"],
    ["appAction", "conductor", "restart", ["conductor:s1"]]
  ]);
});

test("thread routes: detail, Push now, Mute and Unmute, by a key from the state", async () => {
  const supervisor = fakeSupervisor();
  supervisor.threadDetail = async (key) => { supervisor.calls.push(["threadDetail", key]); return key === "conductor:s-1" ? { key, openChat: { app: "conductor", url: "conductor://workspace?id=w&session=s-1", label: "cairo (Conductor)", note: null } } : null; };
  supervisor.pushNow = async (key, options) => { supervisor.calls.push(["pushNow", key, options.deadlineAt]); return { delivery: { status: "sent", route: "computer-use", detail: "typed" }, action: { id: "fa_1", by: "owner" } }; };
  supervisor.muteThread = async (key, options) => { supervisor.calls.push(["muteThread", key, options.hours]); return { until: "2026-09-27T00:00:00.000Z" }; };
  supervisor.unmuteThread = async (key) => { supervisor.calls.push(["unmuteThread", key]); return { until: null }; };
  const route = createFleetRoute({ supervisor });
  const call = (method, path, value = {}) => route(method, path, url(path), body(value));
  const detail = await call("GET", "/fleet/api/threads/conductor:s-1");
  assert.equal(detail.status, 200);
  assert.equal(detail.body.thread.openChat.url, "conductor://workspace?id=w&session=s-1");
  // The colon may come percent-encoded.
  assert.equal((await call("GET", "/fleet/api/threads/conductor%3As-1")).status, 200);
  assert.equal((await call("GET", "/fleet/api/threads/codex:gone")).status, 404);
  for (const bad of ["nope", "conductor:a%2Fb", "shell:x", "codex:" + "x".repeat(121), "%E0%A4%A"]) {
    assert.equal((await call("GET", "/fleet/api/threads/" + bad)).status, 400, bad);
  }
  assert.equal((await call("POST", "/fleet/api/threads/conductor:s-1")).status, 405);
  const pushed = await call("POST", "/fleet/api/threads/conductor:s-1/push");
  assert.equal(pushed.status, 200);
  assert.equal(pushed.body.delivery.status, "sent");
  assert.equal(pushed.body.action.by, "owner");
  assert.ok(pushed.body.state);
  assert.equal((await call("GET", "/fleet/api/threads/conductor:s-1/push")).status, 405);
  const muted = await call("POST", "/fleet/api/threads/conductor:s-1/mute", { hours: 4 });
  assert.equal(muted.body.muted, "2026-09-27T00:00:00.000Z");
  assert.equal((await call("POST", "/fleet/api/threads/conductor:s-1/mute")).status, 200);
  for (const hours of [0, 1.5, 169, "x"]) assert.equal((await call("POST", "/fleet/api/threads/conductor:s-1/mute", { hours })).status, 400, String(hours));
  const unmuted = await call("POST", "/fleet/api/threads/conductor:s-1/unmute");
  assert.equal(unmuted.body.muted, null);
  assert.equal((await call("POST", "/fleet/api/threads/conductor:s-1/delete")).status, 404);
  assert.deepEqual(supervisor.calls.filter((c) => c[0] !== "getState"), [
    ["threadDetail", "conductor:s-1"], ["threadDetail", "conductor:s-1"], ["threadDetail", "codex:gone"],
    ["pushNow", "conductor:s-1", null], ["muteThread", "conductor:s-1", 4], ["muteThread", "conductor:s-1", undefined], ["unmuteThread", "conductor:s-1"]
  ]);
});

test("POST /fleet/api/send takes keys of every thread kind and refuses others", async () => {
  const supervisor = fakeSupervisor();
  const sent = [];
  supervisor.sendOwnerMessage = async (threadKey, message) => { sent.push([threadKey, message]); return { delivery: { status: "sent" } }; };
  const route = createFleetRoute({ supervisor });
  const send = (threadKey) => route("POST", "/fleet/api/send", url("/fleet/api/send"), body({ threadKey, message: "hi" }));
  for (const key of ["codex:t1", "claude:s1", "conductor:c1", "antigravity:e8b9db19-dae3-4406-84b6-81df9fff3df8"]) {
    assert.equal((await send(key)).status, 200, key);
  }
  for (const key of ["gemini:x", "antigravity:", "antigravity:a/b", "codex"]) assert.equal((await send(key)).status, 400, key);
  assert.equal(sent.length, 4);
  assert.equal(sent[3][0], "antigravity:e8b9db19-dae3-4406-84b6-81df9fff3df8");
});


test("Antigravity detail and owner actions accept raw and encoded thread keys", async () => {
  const supervisor = fakeSupervisor();
  const seen = [];
  supervisor.threadDetail = async (key) => { seen.push(["detail", key]); return { key }; };
  supervisor.pushNow = async (key) => { seen.push(["push", key]); return { delivery: { status: "sent", route: "antigravity-send" } }; };
  supervisor.muteThread = async (key) => { seen.push(["mute", key]); return { until: "2026-10-15T00:00:00Z" }; };
  supervisor.unmuteThread = async (key) => { seen.push(["unmute", key]); return { until: null }; };
  const route = createFleetRoute({ supervisor });
  for (const key of ["antigravity:a1", "antigravity%3Aa1"]) {
    for (const action of ["detail", "push", "mute", "unmute"]) {
      const path = "/fleet/api/threads/" + key + (action === "detail" ? "" : "/" + action);
      assert.equal((await route(action === "detail" ? "GET" : "POST", path, url(path), body({}))).status, 200);
    }
  }
  assert.deepEqual(seen, [...Array(2)].flatMap(() => ["detail", "push", "mute", "unmute"].map((action) => [action, "antigravity:a1"])));
});

// ─── replies ──────────────────────────────────────────────────────────────

function replySupervisor({ canReply = true, delivery = { status: "sent", route: "computer-use" } } = {}) {
  const sup = fakeSupervisor();
  sup.state.questions[0].canReply = canReply;
  sup.replyQuestion = async (id, reply, options) => {
    sup.calls.push(["replyQuestion", id, reply, options]);
    if (!sup.state.questions.some((q) => q.id === id)) return null;
    if (["sent", "queued"].includes(delivery.status)) sup.state.questions = sup.state.questions.filter((q) => q.id !== id);
    return { question: { id, status: ["sent", "queued"].includes(delivery.status) ? "answered" : "open", answer: reply }, delivery };
  };
  return sup;
}

test("POST questions/:id { reply } sends the owner's words and returns the delivery and state", async () => {
  const sup = replySupervisor();
  const route = createFleetRoute({ supervisor: sup });
  const res = await route("POST", "/fleet/api/questions/fq_open1", url("/fleet/api/questions/fq_open1"), body({ reply: "  Wait for review, then merge.  " }));
  assert.equal(res.status, 200);
  assert.deepEqual(sup.calls.find((c) => c[0] === "replyQuestion"), ["replyQuestion", "fq_open1", "Wait for review, then merge.", { deadlineAt: null }]);
  assert.equal(res.body.delivery.status, "sent");
  assert.equal(res.body.question.status, "answered");
  assert.equal(res.body.state.questions.length, 0);
  assert.equal(sup.calls.some((c) => c[0] === "answerQuestion"), false, "a reply is never an option answer");
});

test("a blocked reply comes back 200 with the question still open", async () => {
  const sup = replySupervisor({ delivery: { status: "blocked", route: null, detail: "risky ask: approve it in the chat" } });
  const route = createFleetRoute({ supervisor: sup });
  const res = await route("POST", "/fleet/api/questions/fq_open1", url("/fleet/api/questions/fq_open1"), body({ reply: "yes" }));
  assert.equal(res.status, 200);
  assert.equal(res.body.delivery.status, "blocked");
  assert.equal(res.body.state.questions.length, 1);
});

test("replies are 1-2000 characters, only to open questions that take one", async () => {
  const route = createFleetRoute({ supervisor: replySupervisor() });
  const post = (id, value) => route("POST", "/fleet/api/questions/" + id, url("/fleet/api/questions/" + id), body(value));
  for (const reply of ["", "   ", 7, null, "x".repeat(2001)]) {
    const res = await post("fq_open1", { reply });
    assert.equal(res.status, 400, JSON.stringify(reply));
    assert.match(res.body.error, /1-2000/);
  }
  assert.equal((await post("fq_open1", { reply: "x".repeat(2000) })).status, 200);
  assert.equal((await post("fq_gone", { reply: "hi" })).status, 404);
  const noReply = createFleetRoute({ supervisor: replySupervisor({ canReply: false }) });
  const refused = await noReply("POST", "/fleet/api/questions/fq_open1", url("/fleet/api/questions/fq_open1"), body({ reply: "hi" }));
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /no typed reply/);
  const missing = fakeSupervisor();
  missing.state.questions[0].canReply = true;
  const unavailable = await createFleetRoute({ supervisor: missing })("POST", "/fleet/api/questions/fq_open1", url("/fleet/api/questions/fq_open1"), body({ reply: "hi" }));
  assert.equal(unavailable.status, 503);
});

test("a reply to a question closed mid-request is 409", async () => {
  const sup = replySupervisor();
  sup.replyQuestion = async () => null;
  const res = await createFleetRoute({ supervisor: sup })("POST", "/fleet/api/questions/fq_open1", url("/fleet/api/questions/fq_open1"), body({ reply: "hi" }));
  assert.equal(res.status, 409);
});
