import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { BuiltinCodingSupervisor, codingArguments, codingChildEnv } from "../src/builtin-coding-supervisor.js";

function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "coding-builtin-"));
  const project = path.join(fs.realpathSync(dataDir), "project"); fs.mkdirSync(project); fs.mkdirSync(path.join(project, ".git"));
  const children = [], launches = [];
  const spawnImpl = (...args) => {
    launches.push(args);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = signal => { child.killedWith = signal; if (signal === "SIGKILL") child.emit("close", 137); };
    children.push(child); return child;
  };
  const supervisor = new BuiltinCodingSupervisor({ dataDir, findExecutable: () => "/fixture/provider", spawnImpl, ...options });
  const setup = supervisor.configure({ enabled: true, workspaces: [project] });
  const prepare = message => supervisor.prepare({ provider: "codex", workspaceId: setup.workspaces[0].id, message: message || "Inspect this fixture" });
  t.after(() => { for (const child of children) child.emit("close", 1); supervisor.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { supervisor, dataDir, project, children, launches, prepare };
}
const nativeId = "abcdefab-abcd-abcd-abcd-abcdefabcdef";
function finish(child, text = "Fixture done") {
  child.stdout.write(JSON.stringify({ type: "thread.started", thread_id: nativeId }) + "\n");
  child.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }) + "\n");
  child.stdout.write('{"type":"turn.completed"}\n'); child.emit("close", 0);
}

test("fresh install requires explicit workspace setup and exposes no credentials", t => {
  const f = fixture(t);
  assert.equal(f.supervisor.setup().builtin, true);
  assert.equal(JSON.stringify(f.supervisor.setup()).includes(f.project), false);
  assert.equal(fs.statSync(f.supervisor.configFile).mode & 0o777, 0o600);
  assert.throws(() => f.supervisor.configure({ enabled: true, workspaces: [os.homedir()] }));
  assert.throws(() => f.supervisor.configure({ enabled: true, workspaces: ["relative"] }));
  assert.throws(() => f.supervisor.configure({ enabled: true, workspaces: [f.project, f.project] }), /once/);
  assert.deepEqual(codingChildEnv({ HOME: "/fixture", OPENAI_API_KEY: "private", OPENAGI_AUTH_TOKEN: "private", ANTHROPIC_API_KEY: "private" }), { HOME: "/fixture" });
});

test("fixed provider arguments preserve permission gates and reject injection", () => {
  const codex = codingArguments("codex", { model: "test-model", effort: "high", nativeId });
  assert.equal(codex[codex.indexOf("--sandbox") + 1], "read-only");
  assert.ok(codex.includes("--ignore-user-config"));
  assert.deepEqual(codex.slice(-3), ["resume", nativeId, "-"]);
  const claude = codingArguments("claude");
  assert.ok(claude.includes("manual")); assert.ok(claude.includes('{"disableAllHooks":true}'));
  assert.throws(() => codingArguments("codex", { model: "--dangerously-bypass" }));
  assert.throws(() => codingArguments("codex", { nativeId: "../other" }));
});

test("approved start is durable, bound, single-execution and resumes only its exact provider session", t => {
  const f = fixture(t); const args = f.prepare();
  assert.equal(args.project, f.project, "full workspace identity is visible in approval");
  assert.equal(f.supervisor.start(args).status, "accepted");
  assert.equal(f.launches.length, 1); assert.equal(f.launches[0][2].cwd, f.project);
  assert.equal(f.launches[0][2].shell, undefined);
  assert.equal(f.supervisor.start(args).status, "accepted"); assert.equal(f.launches.length, 1);
  assert.throws(() => f.supervisor.start({ ...args, message: "different instruction" }));
  assert.throws(() => f.supervisor.start(f.prepare("Concurrent work")), /owns/);
  finish(f.children[0]);
  const row = f.supervisor.list().sessions.find(x => x.sessionId === args.sessionId);
  assert.equal(row.status, "idle"); assert.equal(row.replyAvailable, true);
  f.supervisor.reply({ ...row, message: "Inspect again" });
  assert.deepEqual(f.launches[1][1].slice(-3), ["resume", nativeId, "-"]);
  finish(f.children[1]);
});

test("restart quarantines unknown process ownership without killing or auto-resuming", t => {
  const f = fixture(t); f.supervisor.start(f.prepare());
  const restarted = new BuiltinCodingSupervisor({ dataDir: f.dataDir, findExecutable: () => "/fixture/provider" });
  assert.equal(restarted.list().sessions[0].status, "interrupted");
  assert.equal(restarted.list().sessions[0].replyAvailable, false);
  assert.throws(() => restarted.start(f.prepare()), /interrupted session/);
  assert.equal(f.children[0].killedWith, undefined);
  const interrupted = restarted.list().sessions[0];
  assert.throws(() => restarted.reconcile(interrupted));
  restarted.reconcile({ ...interrupted, confirmedStopped: true });
  assert.equal(restarted.list().sessions[0].status, "failed");
  assert.equal(restarted.list().sessions[0].replyAvailable, false);
});

test("deadline escalates only the owned process and releases the workspace after confirmed exit", async t => {
  const f = fixture(t, { timeoutMs: 5, killGraceMs: 5 });
  f.supervisor.start(f.prepare());
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.children[0].killedWith, "SIGKILL");
  assert.equal(f.supervisor.children.size, 0);
  assert.equal(f.supervisor.list().sessions[0].status, "failed");
});

test("empty output is failure and split UTF-8 remains intact", t => {
  const f = fixture(t); f.supervisor.start(f.prepare()); finish(f.children[0], "");
  assert.equal(f.supervisor.list().sessions[0].status, "failed");
  const args = f.prepare("UTF-8 fixture"); f.supervisor.start(args);
  f.children[1].stdout.write('null\n42\n[]\nnot json\n');
  const text = Buffer.from(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "café" } }) + '\n{"type":"turn.completed"}\n');
  const cut = text.indexOf(Buffer.from("é")) + 1;
  f.children[1].stdout.write(text.subarray(0, cut)); f.children[1].stdout.write(text.subarray(cut)); f.children[1].emit("close", 0);
  assert.equal(f.supervisor.inspect(args).turns.at(-1).text, "café");
});

test("retention retires only old terminal rows and expired approval replay remains rejected", t => {
  const f = fixture(t); const args = f.prepare(); f.supervisor.start(args); finish(f.children[0]);
  const base = f.supervisor.records.get(args.sessionId);
  base.updatedAt = new Date(Date.now() - 700_000).toISOString();
  for (let i = 1; i < 100; i++) f.supervisor.records.set(`fixture-${i}`, { ...base, id: `fixture-${i}` });
  assert.equal(f.supervisor.start(f.prepare("New run")).status, "accepted");
  assert.equal(f.supervisor.records.size, 100);
  assert.equal(f.supervisor.records.has(args.sessionId), false);
  assert.throws(() => f.supervisor.start({ ...args, preparedAt: Date.now() - 700_000 }), /fresh start approval/);
});

test("permission denial is attention, never silent completion", t => {
  const f = fixture(t); const args = f.prepare(); args.provider = "claude"; f.supervisor.start(args);
  f.children[0].stdout.write(JSON.stringify({ type: "result", session_id: nativeId, result: "Permission required", permission_denials: [{ tool_name: "Write" }] }) + "\n");
  f.children[0].emit("close", 0);
  assert.equal(f.supervisor.list().sessions[0].status, "waiting");
});

test("disable survives restart and stale approvals cannot start work", t => {
  const f = fixture(t); const args = f.prepare(); f.supervisor.configure({ enabled: false });
  assert.throws(() => f.supervisor.start(args), /no longer available/);
  assert.equal(new BuiltinCodingSupervisor({ dataDir: f.dataDir }).setup().enabled, false);
});
