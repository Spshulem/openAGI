import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { CodingSupervisor, registerCodingSupervisorTools, runSupervisorAdapter } from "../src/coding-supervisor.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { PendingActionStore } from "../src/pending-actions.js";
import { OutreachStore } from "../src/outreach-store.js";
import { codingSupervisorUi } from "../src/coding-supervisor-ui.js";

const target = { provider: "codex", sessionId: "session-12345678" };
const baseSession = { ...target, project: "Fixture", status: "working", fingerprint: "a".repeat(64), replyAvailable: true };
function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-coding-test-"));
  let session = { ...baseSession };
  let now = Date.now();
  const sent = [];
  const runtime = { events: new EventEmitter() };
  runtime.outreach = new OutreachStore({ dir: path.join(dataDir, "outreach"), runtime });
  const call = async (req) => {
    if (req.operation === "list") return { sessions: [session] };
    if (req.operation === "inspect") return { turns: [{ role: "assistant", text: "Fixture question?" }] };
    sent.push(req);
    if (options.fail) throw new Error("private error must not escape");
    return { ...target, status: "accepted" };
  };
  const supervisor = new CodingSupervisor({ dataDir, runtime, call, now: () => now });
  t.after(() => { supervisor.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { dataDir, supervisor, runtime, sent, call, update: (patch) => { session = { ...session, ...patch }; }, advance: (ms) => { now += ms; } };
}

test("disabled supervisor does not spawn, persist, or register tools", async (t) => {
  const { dataDir } = fixture(t);
  const supervisor = new CodingSupervisor({ dataDir, backendDir: "" });
  const tools = new ToolRegistry();
  registerCodingSupervisorTools(tools, supervisor);
  supervisor.start();
  assert.equal((await supervisor.list()).configured, false);
  assert.equal(tools.has("reply_to_coding_agent"), false);
  assert.equal(fs.existsSync(supervisor.file), false);
});

test("approval is mandatory, durable, deduplicated, and exact-target bound", async (t) => {
  const f = fixture(t);
  const tools = new ToolRegistry();
  const pending = new PendingActionStore({ dir: path.join(f.dataDir, "pending") });
  tools.bindPendingActions(pending);
  registerCodingSupervisorTools(tools, f.supervisor);
  const args = { ...target, message: "Do the fixture work." };
  const first = await tools.invoke("reply_to_coding_agent", args, { sessionId: "chat-fixture" });
  const second = await tools.invoke("reply_to_coding_agent", args, { sessionId: "chat-fixture" });
  assert.equal(first.result.status, "awaiting_confirmation");
  assert.equal(first.result.actionId, second.result.actionId);
  assert.equal(f.sent.length, 0);
  const saved = new PendingActionStore({ dir: path.join(f.dataDir, "pending") }).get(first.result.actionId);
  assert.equal(saved.args.sessionId, target.sessionId);
  const result = await tools.invoke("reply_to_coding_agent", saved.args, { __confirmed: true });
  assert.equal(result.result.status, "accepted");
  assert.equal(f.sent.length, 1);
  assert.match(saved.summary, /does not approve any later provider permission/);
  assert.equal(fs.statSync(f.supervisor.file).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(f.supervisor.file, "utf8"), /Do the fixture work/);
});

test("missing approval store fails closed", async (t) => {
  const f = fixture(t);
  const tools = new ToolRegistry();
  registerCodingSupervisorTools(tools, f.supervisor);
  const result = await tools.invoke("reply_to_coding_agent", { ...target, message: "Fixture" });
  assert.equal(result.ok, false);
  assert.equal(f.sent.length, 0);
});

test("concurrent delivery and process restart do not replay a reply", async (t) => {
  const f = fixture(t);
  const args = await f.supervisor.prepareReply({ ...target, message: "Fixture" });
  await Promise.all([f.supervisor.reply(args), f.supervisor.reply(args)]);
  const restored = new CodingSupervisor({ dataDir: f.dataDir, call: f.call });
  assert.equal((await restored.reply(args)).status, "accepted");
  assert.equal(f.sent.length, 1);
  await assert.rejects(restored.reply({ ...args, message: "Different" }), /reused/);
});

test("timeouts are unconfirmed, never silently retried", async (t) => {
  const f = fixture(t, { fail: true });
  const args = await f.supervisor.prepareReply({ ...target, message: "Fixture" });
  const receipt = await f.supervisor.reply(args);
  assert.equal(receipt.status, "unconfirmed");
  await f.supervisor.reply(args);
  assert.equal(f.sent.length, 1);
  assert.doesNotMatch(JSON.stringify(receipt), /private error/);
});

test("blocked and unconfirmed receipts fail approval execution instead of scoring success", async (t) => {
  const f = fixture(t);
  const tools = new ToolRegistry();
  registerCodingSupervisorTools(tools, f.supervisor);
  for (const status of ["blocked", "unconfirmed"]) {
    f.supervisor.reply = async () => ({ status, note: `Fixture ${status}` });
    const result = await tools.invoke("reply_to_coding_agent", {}, { __confirmed: true });
    assert.equal(result.ok, false);
    assert.match(result.error, new RegExp(status));
  }
});

test("changed and expired targets cannot execute", async (t) => {
  const f = fixture(t);
  const args = await f.supervisor.prepareReply({ ...target, message: "Fixture" });
  f.update({ fingerprint: "b".repeat(64) });
  await assert.rejects(f.supervisor.reply(args), /target changed/i);
  f.advance(11 * 60_000);
  await assert.rejects(f.supervisor.reply(args), /expired/);
  assert.equal(f.sent.length, 0);
});

test("target prefixes, duplicate targets and unsupported routes fail closed", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.supervisor.inspect({ provider: "shell", sessionId: "../file" }));
  f.update({ replyAvailable: false });
  await assert.rejects(f.supervisor.prepareReply({ ...target, message: "Fixture" }), /owning app/);
  f.supervisor.call = async () => ({ sessions: [baseSession, baseSession] });
  await assert.rejects(f.supervisor.list(), /ambiguous/);
});

test("attention transitions survive restarts, deduplicate, and resolve when recovered", async (t) => {
  const f = fixture(t);
  f.update({ status: "waiting" });
  await f.supervisor.refresh();
  assert.equal(f.runtime.outreach.list().length, 0, "initial scan must not flood notifications");
  f.update({ status: "working" });
  await f.supervisor.refresh();
  f.update({ status: "waiting" });
  await f.supervisor.refresh();
  await f.supervisor.refresh();
  assert.equal(f.runtime.outreach.list().length, 1);
  assert.equal(f.runtime.outreach.list()[0].status, "unseen");
  const restored = new CodingSupervisor({ dataDir: f.dataDir, call: f.call, runtime: f.runtime });
  await restored.refresh();
  assert.equal(f.runtime.outreach.list().length, 1);
  f.update({ status: "idle" });
  await restored.refresh();
  assert.equal(f.runtime.outreach.list()[0].status, "acted");
});

test("refresh failures preserve last snapshot but explicitly mark it stale", async (t) => {
  const f = fixture(t);
  await f.supervisor.refresh();
  f.supervisor.call = async () => { throw new Error("private-path-and-token"); };
  const snapshot = await f.supervisor.refresh();
  assert.equal(snapshot.sessions.length, 1);
  assert.match(snapshot.error, /stale/);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-path-and-token/);
});

test("overlapping reads share one child; stopping aborts outstanding work", async (t) => {
  const f = fixture(t);
  let calls = 0;
  f.supervisor.call = (_req, { signal }) => new Promise((_resolve, reject) => {
    calls++;
    signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
  });
  const a = f.supervisor.list();
  const b = f.supervisor.refresh();
  const assertion = assert.rejects(a, /cancelled/);
  f.supervisor.stop();
  await assertion;
  await b;
  assert.equal(calls, 1);
  assert.equal(f.supervisor.controllers.size, 0);
});

test("adapter rejects relative paths and cancels before spawning", async () => {
  await assert.rejects(runSupervisorAdapter({ operation: "list" }, { backendDir: "." }), /absolute/);
  await assert.rejects(runSupervisorAdapter({ operation: "list" }, { backendDir: "/unused", signal: AbortSignal.abort() }), /cancelled/);
});

test("dashboard script parses and keeps transcript and session values out of HTML", () => {
  new vm.Script(codingSupervisorUi);
  assert.doesNotMatch(codingSupervisorUi, /innerHTML\s*=.*(session\.|turn\.)/);
  assert.match(codingSupervisorUi, /textContent = turn.role/);
  assert.match(codingSupervisorUi, /Open approval/);
});
