import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { BuiltinCodingSupervisor, codingArguments, codingChildEnv, trustedWorkspacePaths } from "../src/builtin-coding-supervisor.js";

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

test("empty setup cannot enable and saved folders can be re-enabled without exposing paths", t => {
  const f = fixture(t);
  const saved = f.supervisor.setup().workspaces;
  f.supervisor.configure({ enabled: false });
  const before = fs.readFileSync(f.supervisor.configFile, "utf8");
  assert.throws(() => f.supervisor.configure({ enabled: true, workspaces: [] }), /at least one/);
  assert.equal(fs.readFileSync(f.supervisor.configFile, "utf8"), before);
  const restarted = new BuiltinCodingSupervisor({ dataDir: f.dataDir, findExecutable: () => null });
  const setup = restarted.configure({ enabled: true });
  assert.deepEqual(setup.workspaces, saved);
  assert.ok(setup.providers.every(p => !p.installed));
  assert.equal(JSON.stringify(setup).includes(f.project), false);
  assert.throws(() => restarted.prepare({ provider: "codex", workspaceId: saved[0].id, message: "Test" }), /Install and sign in/);
  restarted.configure({ enabled: false, workspaces: [] });
  assert.throws(() => restarted.configure({ enabled: true }), /at least one/);
  assert.equal(restarted.setup().enabled, false);
  assert.equal(f.launches.length, 0);
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

test("trusted argument vectors: Codex writes with network and no prompts under the owner's config; Claude accepts edits and runs git, gh, node, npm", () => {
  assert.deepEqual(codingArguments("codex", { trusted: true, model: "gpt-5", nativeId }), ["exec", "--json", "--color", "never", "--sandbox", "workspace-write",
    "-c", "sandbox_workspace_write.network_access=true", "-c", 'approval_policy="never"', "--model", "gpt-5", "resume", nativeId, "-"]);
  assert.equal(codingArguments("codex", { trusted: true }).includes("--ignore-user-config"), false);
  assert.ok(codingArguments("codex").includes("--ignore-user-config"), "restricted stays the default");
  assert.deepEqual(codingArguments("codex").slice(4, 7), ["--sandbox", "read-only", "--ignore-user-config"]);
  const claude = codingArguments("claude", { trusted: true });
  assert.deepEqual(claude.slice(4, 8), ["--permission-mode", "acceptEdits", "--allowedTools", "Bash(git:*),Bash(gh:*),Bash(node:*),Bash(npm:*)"]);
  assert.ok(!claude.includes("bypassPermissions"));
  assert.deepEqual(codingArguments("claude").slice(4, 6), ["--permission-mode", "manual"]);
  const env = { HOME: "/h", CLAUDE_CONFIG_DIR: "/h/.claude-alt", CCODEX_HOME: "/h/.ccodex", SSH_AUTH_SOCK: "/tmp/agent.sock", OPENAI_API_KEY: "private" };
  assert.deepEqual(codingChildEnv(env, { trusted: true }), { HOME: "/h", CLAUDE_CONFIG_DIR: "/h/.claude-alt", CCODEX_HOME: "/h/.ccodex", SSH_AUTH_SOCK: "/tmp/agent.sock" });
  assert.deepEqual(codingChildEnv(env), { HOME: "/h" });
});

test("only owner-listed absolute Git folders are trusted, with a 16k brief and a two-hour cap", t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "coding-trusted-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const root = fs.realpathSync(dataDir);
  const trustedDir = path.join(root, "trusted"); fs.mkdirSync(path.join(trustedDir, ".git"), { recursive: true });
  const plainDir = path.join(root, "plain"); fs.mkdirSync(path.join(plainDir, ".git"), { recursive: true });
  const notGit = path.join(root, "loose"); fs.mkdirSync(notGit);
  assert.deepEqual([...trustedWorkspacePaths(`${trustedDir},relative/path,${notGit},${os.homedir()},/`)], [trustedDir]);
  const launches = [];
  const children = [];
  const spawnImpl = (...args) => {
    launches.push(args);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = () => {}; children.push(child); return child;
  };
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  const supervisor = new BuiltinCodingSupervisor({ dataDir, findExecutable: () => "/fixture/provider", spawnImpl, trustedWorkspaces: trustedDir,
    env: { HOME: "/h", SSH_AUTH_SOCK: "/tmp/agent.sock" } });
  t.after(() => { for (const child of children) child.emit("close", 1); supervisor.stop(); });
  const setup = supervisor.configure({ enabled: true, workspaces: [trustedDir, plainDir] });
  assert.deepEqual(setup.workspaces.map((workspace) => workspace.trusted), [true, false]);
  const [trusted, plain] = setup.workspaces;
  const brief = "x".repeat(10_000);
  assert.throws(() => supervisor.prepare({ provider: "codex", workspaceId: plain.id, message: brief }), /1–4000 characters/);
  assert.throws(() => supervisor.prepare({ provider: "codex", workspaceId: trusted.id, message: "y".repeat(16_001) }), /1–16000 characters/);
  globalThis.setTimeout = (fn, ms) => { timers.push(ms); return realSetTimeout(() => {}, 0); };
  try {
    supervisor.start(supervisor.prepare({ provider: "codex", workspaceId: trusted.id, message: brief }));
    supervisor.start(supervisor.prepare({ provider: "claude", workspaceId: plain.id, message: "Inspect" }));
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.ok(launches[0][1].includes("workspace-write"));
  assert.deepEqual(launches[0][2].env, { HOME: "/h", SSH_AUTH_SOCK: "/tmp/agent.sock" });
  assert.ok(launches[1][1].includes("manual"), "an unlisted workspace stays restricted");
  assert.deepEqual(launches[1][2].env, { HOME: "/h" });
  assert.ok(timers.includes(2 * 60 * 60_000), "trusted runs get two hours");
  assert.ok(timers.includes(10 * 60_000), "restricted runs keep ten minutes");
});
