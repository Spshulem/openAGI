import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveFleetConfig } from "../src/fleet/contracts.js";
import { FleetStore } from "../src/fleet/store.js";
import { MESSAGE_PREFIX, buildRelayPrompt, createExecutor, spawnWithTail, summariseRelayFailure } from "../src/fleet/executor.js";

function setup(t, { results = [], hold = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-exec-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cwd = path.join(home, "repo");
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(path.join(home, ".codex", "codex-lb.env"), "export CODEX_LB_API_KEY='lb-secret-123'\n", { mode: 0o600 });
  const config = resolveFleetConfig({}, {
    home,
    bins: { codex: "/abs/codex", claude: "/abs/claude" },
    paths: { relayCwd: path.join(home, "relay") }
  });
  const store = new FleetStore({ dir: path.join(home, "fleet") });
  const calls = [];
  const releases = [];
  const run = (cmd, args, options = {}) => {
    calls.push({ cmd, args, cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs });
    const result = { code: 0, stdout: "", stderr: "", timedOut: false, error: null, ...(results.shift() ?? {}) };
    if (!hold) return Promise.resolve(result);
    return new Promise((resolve) => releases.push(() => resolve(result)));
  };
  const executor = createExecutor({ config, run, store, logDir: path.join(home, "fleet", "logs") });
  return { home, cwd, config, store, calls, run, releases, executor };
}

function codexThread(cwd, extra = {}) {
  return { key: "codex:t1", kind: "codex", id: "t1", cwd, archived: false, writerLocked: false, live: null, meta: {}, ...extra };
}

function claudeThread(cwd, extra = {}) {
  return { key: "claude:s1", kind: "claude", id: "s1", claudeSessionId: "s1", cwd, archived: false, writerLocked: false, live: null, meta: {}, ...extra };
}

function withoutLbKey(t) {
  const saved = process.env.CODEX_LB_API_KEY;
  delete process.env.CODEX_LB_API_KEY;
  t.after(() => {
    if (saved === undefined) delete process.env.CODEX_LB_API_KEY;
    else process.env.CODEX_LB_API_KEY = saved;
  });
}

test("codex-exec resumes in the thread cwd with the LB key only in the child env", async (t) => {
  withoutLbKey(t);
  const { cwd, calls, store, executor } = setup(t, { results: [{ code: 0, stdout: "working\ntokens used\n75,159\nPushed the fix." }] });
  const result = await executor.deliver({ thread: codexThread(cwd), message: "Ready to merge? CI red: lint.", route: "codex-exec", playbook: "merge-ready" });
  assert.equal(result.status, "sent");
  assert.equal(result.route, "codex-exec");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "/abs/codex");
  assert.deepEqual(calls[0].args, ["exec", "resume", "t1", "--skip-git-repo-check", `${MESSAGE_PREFIX}Ready to merge? CI red: lint.`]);
  assert.equal(calls[0].cwd, cwd);
  assert.equal(calls[0].env.CODEX_LB_API_KEY, "lb-secret-123");
  assert.equal(process.env.CODEX_LB_API_KEY, undefined);

  await executor.whenIdle();
  assert.deepEqual(executor.inFlight(), []);
  const action = store.action(result.actionId);
  assert.equal(action.status, "done");
  assert.equal(action.threadKey, "codex:t1");
  assert.equal(action.playbook, "merge-ready");
  assert.match(action.messageHash, /^[0-9a-f]{16}$/);
  assert.equal(action.detail, "Pushed the fix.");
  assert.ok(fs.existsSync(action.logFile));
  const everything = JSON.stringify(result) + JSON.stringify(store.actions()) + fs.readFileSync(path.join(store.dir, "state.json"), "utf8");
  assert.doesNotMatch(everything, /lb-secret-123/);
});

test("a failed codex resume is recorded with a readable reason", async (t) => {
  const { cwd, store, executor } = setup(t, {
    results: [{ code: 1, stderr: "Error: thread/resume: thread/resume failed: thread t1 already has an active writer (code -32600)" }]
  });
  const result = await executor.deliver({ thread: codexThread(cwd), message: "continue", route: "codex-exec" });
  assert.equal(result.status, "sent");
  await executor.whenIdle();
  const action = store.action(result.actionId);
  assert.equal(action.status, "failed");
  assert.match(action.detail, /writer-locked/);
});

test("a thread already in flight is blocked, then released after completion", async (t) => {
  const { cwd, calls, releases, executor } = setup(t, { hold: true });
  const first = await executor.deliver({ thread: codexThread(cwd), message: "continue", route: "codex-exec" });
  assert.equal(first.status, "sent");
  assert.deepEqual(executor.inFlight(), ["codex:t1"]);
  const second = await executor.deliver({ thread: codexThread(cwd), message: "continue", route: "codex-exec" });
  assert.equal(second.status, "blocked");
  assert.match(second.detail, /in flight/);
  assert.equal(calls.length, 1);
  releases.shift()();
  await executor.whenIdle();
  assert.deepEqual(executor.inFlight(), []);
});

test("preconditions block delivery without running anything", async (t) => {
  const { cwd, calls, store, executor } = setup(t);
  const cases = [
    [{ thread: codexThread(cwd, { archived: true }), route: "codex-exec" }, /archived/],
    [{ thread: codexThread(cwd, { writerLocked: true }), route: "codex-exec" }, /writer-locked/],
    [{ thread: codexThread(path.join(cwd, "gone")), route: "codex-exec" }, /cwd missing/],
    [{ thread: codexThread(null), route: "codex-exec" }, /cwd missing/],
    [{ thread: claudeThread(cwd), route: "peer-relay" }, /no live peer/],
    [{ thread: { ...claudeThread(cwd), key: "conductor:c1", kind: "conductor" }, route: "claude-resume" }, /conductor/],
    [{ thread: claudeThread(cwd, { meta: { conductorHosted: true } }), route: "claude-resume" }, /conductor/],
    [{ thread: claudeThread(cwd, { live: { peerName: "cairo-1f", pid: 1, status: "idle" } }), route: "claude-resume" }, /live/],
    [{ thread: claudeThread(cwd), route: "codex-exec" }, /codex thread/],
    [{ thread: codexThread(cwd), route: null }, /no delivery route/],
    [{ thread: codexThread(cwd), route: "codex-exec", message: "   " }, /empty message/]
  ];
  for (const [input, pattern] of cases) {
    const result = await executor.deliver({ message: "continue", ...input });
    assert.equal(result.status, "blocked", `expected blocked for ${pattern}`);
    assert.match(result.detail, pattern);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(store.actions(), []);
});

test("the supervisor never delivers to its own session", async (t) => {
  const { cwd, calls, config, store } = setup(t);
  const selfConfig = { ...config, selfSessionIds: ["s1"] };
  const executor = createExecutor({ config: selfConfig, run: async () => { calls.push(1); return { code: 0 }; }, store });
  const result = await executor.deliver({ thread: claudeThread(cwd, { live: { peerName: "me", pid: 1, status: "idle" } }), message: "hi", route: "peer-relay" });
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /own session/);
  assert.equal(calls.length, 0);
});

test("dry-run checks preconditions but never calls run", async (t) => {
  const { cwd, calls, store, executor } = setup(t);
  const ok = await executor.deliver({ thread: codexThread(cwd), message: "continue", route: "codex-exec", dryRun: true });
  assert.equal(ok.status, "dry-run");
  assert.match(ok.detail, /codex exec resume t1/);
  const relay = await executor.deliver({ thread: claudeThread(cwd, { live: { peerName: "cairo-1f", pid: 1, status: "idle" } }), message: "hi", route: "peer-relay", dryRun: true });
  assert.equal(relay.status, "dry-run");
  const blocked = await executor.deliver({ thread: codexThread(cwd, { writerLocked: true }), message: "continue", route: "codex-exec", dryRun: true });
  assert.equal(blocked.status, "blocked");
  assert.equal(calls.length, 0);
  assert.deepEqual(executor.inFlight(), []);
  assert.deepEqual(store.actions(), []);
});

test("peer-relay mirrors the g2 relay contract and succeeds on DONE", async (t) => {
  const { cwd, config, calls, store, executor } = setup(t, { results: [{ code: 0, stdout: "DONE\n" }] });
  const thread = claudeThread(cwd, { live: { peerName: "cairo-1f", pid: 4242, status: "idle" } });
  const result = await executor.deliver({ thread, message: "CI finished on abc1234: green.", route: "peer-relay", playbook: "ci-finished" });
  assert.equal(result.status, "sent");
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.cmd, "/abs/claude");
  assert.equal(call.cwd, config.paths.relayCwd);
  assert.ok(fs.statSync(config.paths.relayCwd).isDirectory());
  assert.equal(call.timeoutMs, 180_000);
  const expectedPrompt = buildRelayPrompt("cairo-1f", `${MESSAGE_PREFIX}CI finished on abc1234: green.`);
  assert.deepEqual(call.args, [
    "-p", expectedPrompt,
    "--allowedTools", "SendMessage",
    "--permission-mode", "bypassPermissions",
    "--model", "claude-haiku-4-5-20251001"
  ]);
  assert.match(expectedPrompt, /^Use the SendMessage tool to send a message to the peer named "cairo-1f"\./);
  assert.match(expectedPrompt, /Then reply with only the word DONE\.\n\n--- message starts ---\n\[OpenAGI supervisor\] CI finished/);
  assert.match(expectedPrompt, /\n--- message ends ---$/);
  assert.equal(call.env?.CODEX_LB_API_KEY, undefined);
  assert.deepEqual(executor.inFlight(), []);
  const action = store.action(result.actionId);
  assert.equal(action.status, "sent");
  assert.equal(action.route, "peer-relay");
});

test("peer-relay failures map to named reasons", async (t) => {
  const { cwd, store, executor } = setup(t, {
    results: [
      { code: 0, stdout: "I could not find a peer by that name." },
      { code: 1, stderr: "You've hit your usage limit" },
      { code: 0, stdout: "Sent it." },
      { code: null, timedOut: true },
      { code: null, error: "spawn /abs/claude ENOENT" }
    ]
  });
  const thread = claudeThread(cwd, { live: { peerName: "cairo-1f", pid: 4242, status: "idle" } });
  const send = () => executor.deliver({ thread, message: "hi", route: "peer-relay" });
  const notFound = await send();
  assert.equal(notFound.status, "failed");
  assert.match(notFound.detail, /peer was not found/);
  const usage = await send();
  assert.match(usage.detail, /out of usage credits/);
  const unconfirmed = await send();
  assert.match(unconfirmed.detail, /did not confirm delivery: Sent it\./);
  const timedOut = await send();
  assert.match(timedOut.detail, /timed out/);
  const missing = await send();
  assert.match(missing.detail, /ENOENT/);
  assert.equal(store.actions().filter((a) => a.status === "failed").length, 5);
  assert.equal(summariseRelayFailure("trust this folder?", "/relay"), "the relay directory is not trusted; run claude once in /relay and accept the prompt");
});

test("claude-resume runs claude -p --resume in the thread cwd without the LB key", async (t) => {
  withoutLbKey(t);
  const { cwd, calls, store, executor } = setup(t, { results: [{ code: 0, stdout: "Waiting for CI." }] });
  const result = await executor.deliver({ thread: claudeThread(cwd), message: `${MESSAGE_PREFIX}continue`, route: "claude-resume" });
  assert.equal(result.status, "sent");
  assert.deepEqual(calls[0].args, ["-p", "--resume", "s1", "--permission-mode", "bypassPermissions", `${MESSAGE_PREFIX}continue`]);
  assert.equal(calls[0].cmd, "/abs/claude");
  assert.equal(calls[0].cwd, cwd);
  assert.equal(calls[0].env?.CODEX_LB_API_KEY, undefined);
  await executor.whenIdle();
  assert.equal(store.action(result.actionId).status, "done");
});

test("an existing proposed action is updated instead of duplicated", async (t) => {
  const { cwd, store, executor } = setup(t, { results: [{ code: 0, stdout: "DONE" }] });
  const proposed = store.recordAction({ threadKey: "claude:s1", route: "peer-relay", status: "proposed" });
  const thread = claudeThread(cwd, { live: { peerName: "cairo-1f", pid: 4242, status: "idle" } });
  const result = await executor.deliver({ thread, message: "hi", route: "peer-relay", actionId: proposed.id });
  assert.equal(result.actionId, proposed.id);
  assert.equal(store.actions().length, 1);
  assert.equal(store.action(proposed.id).status, "sent");
  const blocked = await executor.deliver({ thread: codexThread(cwd, { archived: true }), message: "x", route: "codex-exec", actionId: proposed.id });
  assert.equal(blocked.status, "blocked");
  assert.equal(store.action(proposed.id).status, "blocked");
});

test("a throwing runner becomes a failed result, not an exception", async (t) => {
  const { cwd, config, store } = setup(t);
  const executor = createExecutor({ config, store, run: () => { throw new Error("boom"); } });
  const thread = claudeThread(cwd, { live: { peerName: "cairo-1f", pid: 4242, status: "idle" } });
  const relay = await executor.deliver({ thread, message: "hi", route: "peer-relay" });
  assert.equal(relay.status, "failed");
  const codex = await executor.deliver({ thread: codexThread(cwd), message: "hi", route: "codex-exec" });
  assert.equal(codex.status, "sent");
  await executor.whenIdle();
  assert.equal(store.action(codex.actionId).status, "failed");
  assert.deepEqual(executor.inFlight(), []);
});

test("spawnWithTail keeps only the output tail and never throws", async () => {
  const ok = await spawnWithTail(process.execPath, ["-e", "process.stdout.write('x'.repeat(200000) + '\\nlast line')"]);
  assert.equal(ok.code, 0);
  assert.ok(ok.tail.length <= 64 * 1024);
  assert.match(ok.tail, /last line$/);
  const missing = await spawnWithTail("/definitely/not/a/binary", []);
  assert.ok(missing.error);
  const slow = await spawnWithTail(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 100 });
  assert.equal(slow.timedOut, true);
});
