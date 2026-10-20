import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, resolveFleetConfig } from "../src/fleet/contracts.js";
import { FleetStore } from "../src/fleet/store.js";
import { CODEX_APP_HOLDS, MESSAGE_PREFIX, RELAY_REPLY_NOTE, backgroundRouteFor, buildRelayPrompt, createExecutor, isCodexIdentityBlock, isPresenceBlock, spawnWithTail, summariseRelayFailure } from "../src/fleet/executor.js";
import { DEADLINE_MARGIN_MS, createUiLock } from "../src/fleet/ui-delivery.js";

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
    [{ thread: codexThread(cwd, { meta: { originator: "Codex Desktop" } }), route: "codex-exec" }, /codex-app-owned/],
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

test("a remote caller's deadline bounds non-UI sends: no relay it cannot finish, no background resume after it", async (t) => {
  const { cwd, calls, executor } = setup(t, { results: [{ code: 0, stdout: "DONE\n" }, { code: 0, stdout: "done" }] });
  const peer = claudeThread(cwd, { live: { peerName: "cairo-1f", pid: 4242, status: "idle" } });
  // 30 s left after the trip back: too little for a relay.
  const short = await executor.deliver({ thread: peer, message: "hi", route: "peer-relay", playbook: "owner-answer", deadlineAt: Date.now() + DEADLINE_MARGIN_MS + 30_000 });
  assert.equal(short.status, "blocked");
  assert.equal(short.detail, "no time left in this request to deliver; not sent, retry");
  // Past the deadline: no background resume starts either.
  const late = await executor.deliver({ thread: codexThread(cwd), message: "retry", route: "codex-exec", playbook: "owner-answer", deadlineAt: Date.now() - 1 });
  assert.equal(late.status, "blocked");
  assert.equal(calls.length, 0, "nothing started");
  assert.deepEqual(executor.inFlight(), []);
  // 100 s left: the relay runs, bounded by them less the kill grace.
  const bounded = await executor.deliver({ thread: peer, message: "hi", route: "peer-relay", playbook: "owner-answer", deadlineAt: Date.now() + DEADLINE_MARGIN_MS + 100_000 });
  assert.equal(bounded.status, "sent", bounded.detail);
  assert.ok(calls[0].timeoutMs <= 100_000 - DEFAULTS.uiKillGraceMs && calls[0].timeoutMs > 90_000, String(calls[0].timeoutMs));
  // Before the deadline a background resume starts (its turn is not bounded by it).
  const resumed = await executor.deliver({ thread: codexThread(cwd), message: "retry", route: "codex-exec", playbook: "owner-answer", deadlineAt: Date.now() + DEADLINE_MARGIN_MS + 1_000 });
  assert.equal(resumed.status, "sent");
  assert.equal(calls.length, 2);
  await executor.whenIdle();
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
  // The relay exits once it delivers: the agent is told to answer in its own
  // chat (dakar's three replies went to a closed /tmp/cc-socks socket).
  const expectedPrompt = buildRelayPrompt("cairo-1f", `${MESSAGE_PREFIX}CI finished on abc1234: green.\n${RELAY_REPLY_NOTE}`);
  assert.match(RELAY_REPLY_NOTE, /^Answer in your own chat\b.*not with SendMessage/);
  assert.deepEqual(call.args, [
    "-p", expectedPrompt,
    "--tools", "SendMessage",
    "--strict-mcp-config",
    "--allowedTools", "SendMessage",
    "--permission-mode", "bypassPermissions",
    "--model", "claude-haiku-4-5-20251001"
  ]);
  assert.match(expectedPrompt, /^Use the SendMessage tool to send a message to the peer named "cairo-1f"\./);
  assert.match(expectedPrompt, /Then reply with only the word DONE\.\n\n--- message starts ---\n\[OpenAGI supervisor\] CI finished/);
  assert.match(expectedPrompt, /green\.\nAnswer in your own chat[^\n]*\n--- message ends ---$/);
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

const SEEDED_SECRETS = {
  ANTHROPIC_API_KEY: "sk-ant-seeded",
  OPENAI_API_KEY: "sk-openai-seeded",
  OPENAGI_AUTH_TOKEN: "openagi-seeded",
  OPENAGI_FLEET_MODE: "auto",
  TELEGRAM_BOT_TOKEN: "telegram-seeded",
  TWILIO_AUTH_TOKEN: "twilio-seeded",
  TWILIO_ACCOUNT_SID: "twilio-sid-seeded",
  BUILDBETTER_API_KEY: "bb-seeded",
  BUILDBETTER_URL: "bb-url-seeded",
  GH_TOKEN: "gh-seeded",
  STRIPE_SECRET: "stripe-seeded",
  AWS_SECRET_ACCESS_KEY: "aws-seeded",
  LC_PRIVATE_KEY: "lc-seeded"
};
const SECRET_NAME = /^(?:ANTHROPIC|OPENAI|OPENAGI|TELEGRAM|TWILIO|BUILDBETTER)_|_(?:TOKEN|SECRET|KEY)$/;

function seedEnv(t, values) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("every route gets an allowlisted child env with no daemon secrets", async (t) => {
  seedEnv(t, { ...SEEDED_SECRETS, CODEX_LB_API_KEY: undefined, LC_ALL: "en_US.UTF-8", PATH: "/usr/bin:/bin" });
  const { cwd, calls, executor } = setup(t, { results: [{ code: 0 }, { code: 0, stdout: "DONE" }, { code: 0 }] });
  await executor.deliver({ thread: codexThread(cwd), message: "continue", route: "codex-exec" });
  await executor.deliver({ thread: claudeThread(cwd, { key: "claude:s2", live: { peerName: "cairo-1f", pid: 1, status: "idle" } }), message: "hi", route: "peer-relay" });
  await executor.deliver({ thread: claudeThread(cwd), message: "continue", route: "claude-resume" });
  await executor.whenIdle();
  assert.equal(calls.length, 3);
  const [codex, relay, resume] = calls.map((call) => call.env);
  for (const [name, env] of [["codex-exec", codex], ["peer-relay", relay], ["claude-resume", resume]]) {
    assert.ok(env && typeof env === "object", `${name} passes an explicit env`);
    const leaked = Object.keys(env).filter((key) => SECRET_NAME.test(key) && key !== "CODEX_LB_API_KEY");
    assert.deepEqual(leaked, [], `${name} leaks ${leaked.join(", ")}`);
    for (const value of Object.values(SEEDED_SECRETS)) assert.ok(!JSON.stringify(env).includes(value), `${name} carries ${value}`);
    assert.equal(env.HOME, process.env.HOME);
    assert.equal(env.LC_ALL, "en_US.UTF-8");
    const dirs = env.PATH.split(path.delimiter);
    assert.deepEqual(dirs.slice(0, 2), ["/usr/bin", "/bin"]);
    assert.ok(dirs.includes("/abs"), `${name} PATH includes the configured bin dirs`);
    assert.ok(dirs.includes(path.dirname(process.execPath)), `${name} PATH includes the node dir`);
  }
  assert.equal(codex.CODEX_LB_API_KEY, "lb-secret-123");
  assert.equal("CODEX_LB_API_KEY" in relay, false);
  assert.equal("CODEX_LB_API_KEY" in resume, false);
});

test("codex-exec takes only CODEX_LB_API_KEY from the LB env file", async (t) => {
  seedEnv(t, { CODEX_LB_API_KEY: undefined });
  const { home, cwd, calls, executor } = setup(t, { results: [{ code: 0 }] });
  fs.writeFileSync(path.join(home, ".codex", "codex-lb.env"), "OPENAI_API_KEY=sk-from-file\nCODEX_LB_API_KEY=lb-file\nEXTRA=1\n");
  await executor.deliver({ thread: codexThread(cwd), message: "continue", route: "codex-exec" });
  await executor.whenIdle();
  assert.equal(calls[0].env.CODEX_LB_API_KEY, "lb-file");
  assert.equal("OPENAI_API_KEY" in calls[0].env, false);
  assert.equal("EXTRA" in calls[0].env, false);
});

test("codex-exec falls back to the daemon's own CODEX_LB_API_KEY when the file is missing", async (t) => {
  seedEnv(t, { CODEX_LB_API_KEY: "lb-daemon" });
  const { home, cwd, calls, executor } = setup(t, { results: [{ code: 0 }, { code: 0 }] });
  fs.rmSync(path.join(home, ".codex", "codex-lb.env"));
  await executor.deliver({ thread: codexThread(cwd), message: "continue", route: "codex-exec" });
  await executor.deliver({ thread: claudeThread(cwd), message: "continue", route: "claude-resume" });
  await executor.whenIdle();
  assert.equal(calls[0].env.CODEX_LB_API_KEY, "lb-daemon");
  assert.equal("CODEX_LB_API_KEY" in calls[1].env, false);
});

test("the peer relay can only use SendMessage", async (t) => {
  const { cwd, calls, executor } = setup(t, { results: [{ code: 0, stdout: "DONE" }] });
  await executor.deliver({ thread: claudeThread(cwd, { live: { peerName: "cairo-1f", pid: 1, status: "idle" } }), message: "hi", route: "peer-relay" });
  const args = calls[0].args;
  assert.equal(args[args.indexOf("--tools") + 1], "SendMessage");
  assert.ok(args.includes("--strict-mcp-config"), "no MCP servers load in the relay");
  assert.equal(args[args.indexOf("--allowedTools") + 1], "SendMessage");
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

test("spawnWithTail settles after a timeout even if SIGTERM is ignored or a descendant holds the pipes", async (t) => {
  const within = (promise) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("never settled")), 5000))]);
  const stubborn = await within(spawnWithTail(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { timeoutMs: 100, killGraceMs: 200 }));
  assert.equal(stubborn.timedOut, true);
  const parent = "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }); process.stdout.write(c.pid + '\\n'); setInterval(() => {}, 1000)";
  const held = await within(spawnWithTail(process.execPath, ["-e", parent], { timeoutMs: 300, killGraceMs: 200 }));
  assert.equal(held.timedOut, true);
  const grandchild = Number(held.tail.trim().split("\n")[0]);
  t.after(() => { try { process.kill(grandchild, "SIGKILL"); } catch { /* already gone */ } });
  assert.ok(grandchild > 0);
});

test("a background resume still running at the ceiling stays in flight, journaled as left running", async (t) => {
  const { home, cwd, config, store } = setup(t);
  let options = null;
  const run = (cmd, args, opts = {}) => { options = opts; return Promise.resolve({ code: null, timedOut: false, detached: true, error: null, tail: "working" }); };
  const executor = createExecutor({ config, run, store, logDir: path.join(home, "fleet", "logs") });
  const sent = await executor.deliver({ thread: codexThread(cwd), message: "continue", route: "codex-exec", playbook: "resume" });
  assert.equal(options.detach, true);
  assert.equal(await sent.done, true);
  await executor.whenIdle();
  assert.deepEqual(executor.inFlight(), ["codex:t1"], "no second send starts beside the running turn");
  const running = store.action(sent.actionId);
  assert.equal(running.running, true);
  assert.match(running.detail, /left running, not killed/);
  options.onExit({ code: 0, timedOut: false, error: null, tail: "working\nPushed the fix." });
  assert.equal(store.action(sent.actionId).status, "done");
  assert.equal(store.action(sent.actionId).detail, "Pushed the fix.");
  assert.deepEqual(executor.inFlight(), []);
});

// A codex exec or claude resume that never exits (a stalled network read,
// a prompt nobody sees) held its thread "in flight" until the supervisor
// restarted: every resume, CI-done ping and owner answer was refused.
test("a detached turn that never exits stops holding its thread after a second ceiling", async (t) => {
  const { home, cwd, config, store } = setup(t);
  const runs = [];
  const run = (cmd, args, opts = {}) => { runs.push(opts); return Promise.resolve({ code: null, timedOut: false, detached: true, error: null, tail: "working" }); };
  const executor = createExecutor({ config, run, store, logDir: path.join(home, "fleet", "logs"), detachedReleaseMs: 30 });
  const sent = await executor.deliver({ thread: codexThread(cwd), message: "continue", route: "codex-exec", playbook: "resume" });
  await executor.whenIdle();
  assert.deepEqual(executor.inFlight(), ["codex:t1"]);
  assert.match((await executor.deliver({ thread: codexThread(cwd), message: "CI done", route: "codex-exec" })).detail, /^in flight/);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(executor.inFlight(), [], "released, never killed");
  assert.equal(store.action(sent.actionId).running, true);
  assert.match(store.action(sent.actionId).detail, /no longer holds the thread/);
  const next = await executor.deliver({ thread: codexThread(cwd), message: "CI done", route: "codex-exec" });
  assert.equal(next.status, "sent");
  await executor.whenIdle();
  // The old turn ending later leaves the newer send in flight.
  runs[0].onExit({ code: 0, timedOut: false, error: null, tail: "done" });
  assert.equal(store.action(sent.actionId).status, "done");
  assert.deepEqual(executor.inFlight(), ["codex:t1"]);
});

test("a background send reports later whether it reached the agent", async (t) => {
  const failed = setup(t, { results: [{ code: 1, stderr: "error: thread has an active writer" }] });
  const sent = await failed.executor.deliver({ thread: codexThread(failed.cwd), message: "Owner answer: Starter.", route: "codex-exec" });
  assert.equal(sent.status, "sent");
  assert.equal(await sent.done, false);
  // The outcome stays off the JSON the routes return.
  assert.equal(JSON.stringify(sent).includes("done"), false);
  const timedOut = setup(t, { results: [{ code: null, timedOut: true }] });
  assert.equal(await (await timedOut.executor.deliver({ thread: codexThread(timedOut.cwd), message: "hi", route: "codex-exec" })).done, true);
  const okay = setup(t, { results: [{ code: 0, stdout: "done" }] });
  assert.equal(await (await okay.executor.deliver({ thread: codexThread(okay.cwd), message: "hi", route: "codex-exec" })).done, true);
});

test("a background send that fails to run reports it and leaves earlier counted nudges alone", async (t) => {
  const { cwd, store, executor } = setup(t, { results: [{ code: 1, stderr: "boom" }] });
  // An earlier nudge the target already counted; this send (an owner answer
  // or an escalation) recorded none, so its failure must not undo that one.
  store.recordNudge("codex:t1", { playbook: "merge-ready", route: "codex-exec", status: "sent" }, { head: "h", unresolved: 1 });
  const result = await executor.deliver({ thread: codexThread(cwd), message: "Owner answer: Starter.", route: "codex-exec", playbook: "owner-answer" });
  assert.equal(result.status, "sent");
  assert.equal(await result.done, false);
  await executor.whenIdle();
  const ledger = store.ledgerFor("codex:t1");
  assert.equal(ledger.attemptsWithoutProgress, 1);
  assert.equal(ledger.nudges.at(-1).status, "sent");
});

test("relay only accepts the exact DONE acknowledgement", async (t) => {
  const { cwd, executor } = setup(t, { results: [{ stdout: "NOT DONE — peer unavailable" }, { stdout: "I could not send it; DONE is required" }] });
  const thread = claudeThread(cwd, { live: { peerName: "cairo-1f", pid: 4242, status: "idle" } });
  for (let i = 0; i < 2; i++) assert.equal((await executor.deliver({ thread, message: "continue", route: "peer-relay" })).status, "failed");
});

test("claude-resume re-reads live peers at send time and never forks a live session", async (t) => {
  const { cwd, config, store, calls, run } = setup(t);
  const live = createExecutor({ config, run, store, readLivePeers: () => new Map([["s1", { peerName: "cairo-1f" }]]) });
  const opened = await live.deliver({ thread: claudeThread(cwd), message: `${MESSAGE_PREFIX}continue`, route: "claude-resume" });
  assert.equal(opened.status, "blocked");
  assert.match(opened.detail, /live session/);
  const broken = createExecutor({ config, run, store, readLivePeers: () => { throw new Error("EACCES"); } });
  assert.equal((await broken.deliver({ thread: claudeThread(cwd), message: `${MESSAGE_PREFIX}continue`, route: "claude-resume" })).status, "blocked");
  assert.equal(calls.length, 0);
  const idle = createExecutor({ config, run, store, readLivePeers: () => new Map() });
  assert.equal((await idle.deliver({ thread: claudeThread(cwd), message: `${MESSAGE_PREFIX}continue`, route: "claude-resume" })).status, "sent");
  await idle.whenIdle();
});

// --- computer-use route (a fake UI driver; nothing touches a real app) -------

const conductorUiThread = (cwd, extra = {}) => ({
  key: "conductor:s1", kind: "conductor", id: "s1", title: "Fix billing", workspace: "madrid", cwd, archived: false, writerLocked: false,
  live: null, agentStatus: "idle",
  meta: { conductorWorkspaceId: "w-madrid", conductorSessionId: "s1", conductorSessionTitle: "Fix billing", conductorWorkspaceSessions: 1 },
  ...extra
});

function uiSetup(t, { results = [], delivery = "computer-use", hold = false, knownThreads = () => [] } = {}) {
  const base = setup(t);
  const config = { ...base.config, delivery };
  const requests = [];
  const releases = [];
  let running = 0;
  let maxRunning = 0;
  const ui = {
    async deliver(request) {
      requests.push(request);
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      try {
        if (hold) await new Promise((resolve) => releases.push(resolve));
        return { status: "sent", detail: "typed into Conductor", evidence: ["/tmp/fa-before.png", "/tmp/fa-after.png"], ...(results.shift() ?? {}) };
      } finally {
        running -= 1;
      }
    }
  };
  // A private lock per test, so tests never wait on each other.
  const executor = createExecutor({ config, run: base.run, store: base.store, logDir: path.join(base.home, "fleet", "logs"), ui, knownThreads, uiLock: createUiLock() });
  return { ...base, config, executor, requests, releases, get maxRunning() { return maxRunning; } };
}

test("computer-use types through the UI driver: one line, no CLI, final result, evidence journaled", async (t) => {
  const { cwd, calls, store, executor, requests } = uiSetup(t);
  const result = await executor.deliver({ thread: conductorUiThread(cwd), message: "Ready to merge?\nCI red: lint.\n\nFix it.", route: "computer-use", playbook: "merge-ready" });
  assert.equal(result.status, "sent");
  assert.equal(result.route, "computer-use");
  assert.equal(result.done, undefined, "a UI send is final: no background child");
  assert.equal(calls.length, 0, "never runs codex or claude");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].text, `${MESSAGE_PREFIX}Ready to merge? CI red: lint. Fix it.`);
  assert.ok(requests[0].spentMs >= 0 && requests[0].spentMs < 1000, "the caller's time, lock wait added");
  // A caller's request time carries through to the driver.
  await executor.deliver({ thread: conductorUiThread(cwd), message: "Second note.", route: "computer-use", playbook: "owner-answer", spentMs: 60_000 });
  assert.ok(requests[1].spentMs >= 60_000);
  assert.equal(requests[1].deadlineAt, null, "a local caller has no broker deadline");
  // A remote caller's broker deadline (its queue time included) reaches the driver.
  const deadlineAt = Date.now() + 100_000;
  await executor.deliver({ thread: conductorUiThread(cwd), message: "Third note.", route: "computer-use", playbook: "owner-message", deadlineAt });
  assert.equal(requests[2].deadlineAt, deadlineAt);
  assert.equal(requests[0].target.deepLink, "conductor://workspace?id=w-madrid&session=s1");
  assert.deepEqual(requests[0].identity.tokens, ["madrid"]);
  assert.equal(requests[0].previousUnconfirmed, false);
  const action = store.action(result.actionId);
  assert.equal(action.status, "sent");
  assert.equal(action.route, "computer-use");
  assert.deepEqual(action.evidence, ["/tmp/fa-before.png", "/tmp/fa-after.png"]);
  assert.deepEqual(executor.inFlight(), []);
});

test("computer-use: a desktop-held Codex writer lock does not block; a running turn and app-less threads do", async (t) => {
  const { cwd, executor, requests } = uiSetup(t);
  const codex = codexThread(cwd, { title: "Fix uploads", writerLocked: true, agentStatus: "idle" });
  assert.equal((await executor.deliver({ thread: codex, message: "continue", route: "computer-use" })).status, "sent");
  assert.equal(requests[0].target.deepLink, "codex://threads/t1");
  const running = await executor.deliver({ thread: { ...codex, agentStatus: "running" }, message: "continue", route: "computer-use" });
  assert.equal(running.status, "blocked");
  assert.match(running.detail, /turn running/);
  const terminal = await executor.deliver({ thread: claudeThread(cwd, { live: { peerName: "cli-1", pid: 9 } }), message: "continue", route: "computer-use" });
  assert.equal(terminal.status, "blocked");
  assert.match(terminal.detail, /no app shows this thread/);
  const prompt = await executor.deliver({ thread: conductorUiThread(cwd, { meta: { ...conductorUiThread(cwd).meta, blockedOnOwner: true } }), message: "continue", route: "computer-use" });
  assert.equal(prompt.status, "blocked");
  assert.equal(requests.length, 1);
});

test("computer-use-only config refuses every CLI route, even from an older proposal", async (t) => {
  const { cwd, calls, executor } = uiSetup(t);
  for (const [thread, route] of [[codexThread(cwd), "codex-exec"], [claudeThread(cwd, { live: { peerName: "cairo-1f", pid: 1 } }), "peer-relay"], [claudeThread(cwd), "claude-resume"]]) {
    const result = await executor.deliver({ thread, message: "continue", route });
    assert.equal(result.status, "blocked");
    assert.match(result.detail, /computer-use delivery only/);
  }
  assert.equal(calls.length, 0);
});

test("computer-use maps blocked and failed results; an unconfirmed send is flagged on the retry", async (t) => {
  const { cwd, store, executor, requests } = uiSetup(t, {
    results: [
      { status: "blocked", detail: "owner using Conductor", evidence: undefined },
      { status: "failed", detail: "unconfirmed: may have been sent; check the thread before retrying", unconfirmed: true, priorCount: 2 },
      { status: "sent", detail: "already in thread (the earlier unconfirmed send landed)" }
    ]
  });
  const thread = conductorUiThread(cwd);
  const blocked = await executor.deliver({ thread, message: "continue", route: "computer-use" });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.detail, "owner using Conductor");
  assert.equal(blocked.actionId, null, "nothing typed: not journaled as an action");
  const failed = await executor.deliver({ thread, message: "continue", route: "computer-use" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.unconfirmed, true);
  assert.equal(store.action(failed.actionId).unconfirmed, true);
  const retried = await executor.deliver({ thread, message: "continue", route: "computer-use" });
  assert.deepEqual(requests[2].previousUnconfirmed, { priorCount: 2 });
  assert.equal(retried.status, "sent");
  assert.equal(store.action(retried.actionId).unconfirmed, false);
  // A different message is not the unconfirmed one.
  await executor.deliver({ thread, message: "something else", route: "computer-use" });
  assert.equal(requests[3].previousUnconfirmed, false);
});

test("an unconfirmed UI send stays guarded after the executor is recreated", async (t) => {
  const { cwd, store, config, executor } = uiSetup(t, {
    results: [{ status: "failed", detail: "unconfirmed: may have been sent", unconfirmed: true, priorCount: 1 }]
  });
  const thread = conductorUiThread(cwd);
  await executor.deliver({ thread, message: "continue", route: "computer-use" });
  const requests = [];
  const ui = { async deliver(request) { requests.push(request); return { status: "sent", detail: "already in thread" }; } };
  const restarted = createExecutor({ config, run: async () => ({ code: 0 }), store, ui, uiLock: createUiLock() });
  await restarted.deliver({ thread, message: "continue", route: "computer-use" });
  assert.deepEqual(requests[0].previousUnconfirmed, { priorCount: 1 });
  // Once it is confirmed, a later restart no longer carries the guard.
  const again = createExecutor({ config, run: async () => ({ code: 0 }), store, ui, uiLock: createUiLock() });
  await again.deliver({ thread, message: "continue", route: "computer-use" });
  assert.equal(requests[1].previousUnconfirmed, false);
});

test("computer-use runs one app delivery at a time and one per app thread", async (t) => {
  const { cwd, executor, releases, requests } = uiSetup(t, { hold: true });
  const a = executor.deliver({ thread: conductorUiThread(cwd), message: "one", route: "computer-use" });
  const b = executor.deliver({ thread: codexThread(cwd, { title: "Fix uploads" }), message: "two", route: "computer-use" });
  // The Codex thread Conductor hosts reaches the same Conductor tab.
  const hosted = codexThread(cwd, { key: "codex:t9", id: "t9", meta: { originator: "codex_sdk_ts", conductorHost: { workspaceId: "w-madrid", sessionId: "s1", workspace: "madrid", title: "Fix billing", sessionCount: 1 } } });
  const twin = await executor.deliver({ thread: hosted, message: "three", route: "computer-use" });
  assert.equal(twin.status, "blocked");
  assert.match(twin.detail, /in flight/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1, "the second waits for the UI lock");
  releases.shift()();
  assert.equal((await a).status, "sent");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2);
  releases.shift()();
  assert.equal((await b).status, "sent");
});

test("computer-use dry run describes the step without touching the UI; a missing driver blocks", async (t) => {
  const { cwd, executor, requests } = uiSetup(t);
  const dry = await executor.deliver({ thread: conductorUiThread(cwd), message: "continue", route: "computer-use", dryRun: true });
  assert.equal(dry.status, "dry-run");
  assert.equal(dry.detail, "would type into Conductor: madrid");
  assert.equal(requests.length, 0);
  const base = setup(t);
  const bare = createExecutor({ config: { ...base.config, delivery: "computer-use" }, run: base.run, store: base.store, uiLock: createUiLock() });
  const none = await bare.deliver({ thread: conductorUiThread(cwd), message: "continue", route: "computer-use" });
  assert.equal(none.status, "blocked");
  assert.match(none.detail, /computer use unavailable/);
});

test("computer-use passes every known thread so shared titles block as ambiguous", async (t) => {
  const twin = codexThread("/x", { key: "codex:t2", id: "t2", title: "Fix uploads" });
  const { cwd, executor, requests } = uiSetup(t, { knownThreads: () => [twin] });
  await executor.deliver({ thread: codexThread(cwd, { title: "Fix uploads" }), message: "continue", route: "computer-use" });
  assert.equal(requests[0].identity.ambiguous, true);
});

test("a blocked app send carries the permission card and the failure kind back to the supervisor", async (t) => {
  const prompt = { text: "Run npm test?", buttons: ["Allow once", "Deny"], stateId: "0123456789abcdef" };
  const { cwd, executor } = uiSetup(t, { results: [
    { status: "blocked", detail: "permission prompt visible: open it", prompt },
    { status: "blocked", detail: "can't read Conductor", code: "appUnreadable" }
  ] });
  const carded = await executor.deliver({ thread: conductorUiThread(cwd), message: "continue", route: "computer-use" });
  assert.equal(carded.status, "blocked");
  assert.deepEqual(carded.prompt, prompt);
  const unreadable = await executor.deliver({ thread: conductorUiThread(cwd), message: "continue", route: "computer-use" });
  assert.equal(unreadable.code, "appUnreadable");
});

// --- background routes while the owner is at the Mac -------------------------

function fallbackSetup(t, { results = [], routes = ["codex-exec", "peer-relay"], peers = new Map(), relay = [], refresh = async (thread) => thread } = {}) {
  const base = setup(t, { results: relay });
  const config = { ...base.config, delivery: "computer-use", backgroundRoutes: routes };
  const requests = [];
  const ui = {
    async deliver(request) {
      requests.push(request);
      return { status: "sent", detail: "typed", ...(results.shift() ?? {}) };
    }
  };
  const executor = createExecutor({ config, run: base.run, store: base.store, logDir: path.join(base.home, "fleet", "logs"), ui, uiLock: createUiLock(), readLivePeers: () => peers, refreshThread: refresh });
  return { ...base, config, executor, requests };
}

const ownerAtCodex = () => [{ status: "blocked", detail: "owner using Codex", evidence: undefined }];

test("an app send blocked only by the owner's presence goes by an allowed background route", async (t) => {
  withoutLbKey(t);
  const { cwd, calls, store, executor, requests } = fallbackSetup(t, { results: ownerAtCodex() });
  const result = await executor.deliver({ thread: codexThread(cwd, { title: "Fix uploads", agentStatus: "idle" }), message: "continue", route: "computer-use", playbook: "idle-report" });
  assert.equal(result.status, "sent");
  assert.equal(result.route, "codex-exec");
  assert.equal(requests.length, 1, "the app was tried first");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 3), ["exec", "resume", "t1"]);
  await executor.whenIdle();
  const action = store.action(result.actionId);
  assert.equal(action.route, "codex-exec");
  assert.equal(action.fallbackFrom, "owner using Codex");
  // Waiting for idle is the same block.
  const waiting = fallbackSetup(t, { results: [{ status: "blocked", detail: "waiting for idle: Codex must be in front to type" }] });
  assert.equal((await waiting.executor.deliver({ thread: codexThread(waiting.cwd, { title: "Fix uploads" }), message: "continue", route: "computer-use" })).route, "codex-exec");
  await waiting.executor.whenIdle();
});

test("no background route unless allowed, safe and the block was only the owner's presence", async (t) => {
  withoutLbKey(t);
  const thread = (cwd, extra = {}) => codexThread(cwd, { title: "Fix uploads", agentStatus: "idle", ...extra });
  const cases = [
    ["not allowed", { routes: [] }, {}],
    ["a draft left in the composer", { results: [{ status: "blocked", detail: "owner using Codex; our text is left as a draft" }] }, {}],
    ["another app send running", { results: [{ status: "blocked", detail: "busy: another app delivery is running; retry" }] }, {}],
    ["writer-locked in the scan", {}, { writerLocked: true }],
    ["started by Conductor", {}, { meta: { originator: "codex_sdk_ts" } }],
    ["started in the Codex app", {}, { meta: { originator: "Codex Desktop" } }],
    ["waiting on a permission prompt", {}, { meta: { blockedOnOwner: true } }]
  ];
  for (const [label, options, extra] of cases) {
    const { cwd, calls, executor } = fallbackSetup(t, { results: ownerAtCodex(), ...options });
    const result = await executor.deliver({ thread: thread(cwd, extra), message: "continue", route: "computer-use" });
    assert.equal(result.status, "blocked", label);
    assert.equal(calls.length, 0, label);
  }
  // A writer lock taken since the scan is read at send time: who holds it
  // decides, so a lock file a crash left behind holds nothing.
  const lockFile = (home) => {
    fs.mkdirSync(path.join(home, ".codex", "thread-writer-locks"), { recursive: true });
    const file = path.join(home, ".codex", "thread-writer-locks", "t1.lock");
    fs.writeFileSync(file, "");
    return file;
  };
  const held = fallbackSetup(t, { results: ownerAtCodex() });
  const file = lockFile(held.home);
  held.calls.length = 0;
  const heldRun = createExecutor({ config: held.config, run: async (cmd, args) => { held.calls.push({ cmd, args }); return { code: 0, stdout: `p${process.pid}\nn${file}\n` }; }, store: held.store, ui: { deliver: async () => ownerAtCodex()[0] }, uiLock: createUiLock() });
  assert.equal((await heldRun.deliver({ thread: thread(held.cwd), message: "continue", route: "computer-use" })).status, "blocked");
  assert.deepEqual(held.calls.map((call) => call.cmd), [held.config.bins.lsof], "only the lock read ran");
  const stale = fallbackSetup(t, { results: ownerAtCodex(), relay: [{ code: 1, stdout: "" }] });
  lockFile(stale.home);
  assert.equal((await stale.executor.deliver({ thread: thread(stale.cwd), message: "continue", route: "computer-use" })).route, "codex-exec");
  assert.deepEqual(stale.calls.map((call) => call.cmd), [stale.config.bins.lsof, "/abs/codex"]);
  await stale.executor.whenIdle();
});

// A Codex app send that cannot prove which thread is open (a title two
// threads share, or the app still on another thread after the id link) may
// go by codex exec, which reaches the thread by its id, when no app holds
// the thread's writer lock.
test("a Codex send the app cannot verify goes by codex exec when no app holds the thread", async (t) => {
  withoutLbKey(t);
  const thread = (cwd, extra = {}) => codexThread(cwd, { id: "01a0df66-b269-7540-81f5-592808f2e1f1", title: "Fix uploads", agentStatus: "idle", ...extra });
  for (const detail of [
    "could not verify thread: \"fix uploads\" is not the open thread",
    "ambiguous: two threads share this title",
    "ambiguous: two threads share this title; a thread with that title is already open"
  ]) {
    const { cwd, calls, store, executor } = fallbackSetup(t, { results: [{ status: "blocked", detail }] });
    const result = await executor.deliver({ thread: thread(cwd), message: "BuildBot3 full run failed", route: "computer-use", playbook: "merge-ready" });
    assert.equal(result.status, "sent", detail);
    assert.equal(result.route, "codex-exec", detail);
    assert.deepEqual(calls.at(-1).args.slice(0, 3), ["exec", "resume", "01a0df66-b269-7540-81f5-592808f2e1f1"], detail);
    await executor.whenIdle();
    assert.equal(store.action(result.actionId).fallbackFrom, detail);
  }
  // A running turn, a send left unconfirmed in the composer, or a Conductor
  // chat (its page names the session by id) gets no exec.
  for (const [label, extra, results] of [
    ["turn running", { agentStatus: "running" }, [{ status: "blocked", detail: "could not verify thread: another thread is open" }]],
    ["unconfirmed", {}, [{ status: "blocked", detail: "could not verify thread: another thread is open", unconfirmed: true }]]
  ]) {
    const { cwd, calls, executor } = fallbackSetup(t, { results });
    const result = await executor.deliver({ thread: thread(cwd, extra), message: "continue", route: "computer-use" });
    assert.equal(result.status, "blocked", label);
    assert.equal(calls.length, 0, label);
  }
  assert.equal(isCodexIdentityBlock({ kind: "conductor" }, { status: "blocked", detail: "could not verify thread: another session is open" }), false);
  assert.equal(isCodexIdentityBlock({ kind: "codex" }, { status: "blocked", detail: "composer not found" }), false);
});

// codex:019fe344 (#5557), as it is: the approved BuildBot3-failure ping was
// blocked ("on top of pr #5544, ..." is not the open thread) while the Codex
// app-server (pid 17768) held the writer lock of this thread and of all 77
// threads it had loaded. Opening a thread by its link loads it, so codex
// exec can never take over here: the block stands, says why, and policy
// asks the owner.
test("019fe344: a Codex send the app cannot verify, on a thread the app holds, stays blocked and says why", async (t) => {
  withoutLbKey(t);
  const id = "019fe344-eb70-7da2-9186-62c55dbd61d2";
  const detail = "could not verify thread: \"on top of pr #5544, i want to build a mo\" is not the open thread";
  const thread = (cwd, extra = {}) => codexThread(cwd, { id, key: `codex:${id}`, title: "On top of PR #5544, I want to build a mock chat experience that we can pace on h", agentStatus: "idle", ...extra });
  // The scan read the lock.
  const scanned = fallbackSetup(t, { results: [{ status: "blocked", detail }] });
  const blocked = await scanned.executor.deliver({ thread: thread(scanned.cwd, { writerLocked: true }), message: "BuildBot3 full run failed", route: "computer-use", playbook: "merge-ready" });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.detail, `${detail}; ${CODEX_APP_HOLDS}`);
  assert.equal(scanned.calls.length, 0, "no codex exec");
  // The lock taken after the scan (the id link loaded the thread): read
  // again at send time, held by a live process.
  const lsofOut = [];
  const lsof = fallbackSetup(t, { results: [{ status: "blocked", detail }], relay: lsofOut });
  const lockFile = path.join(lsof.home, ".codex", "thread-writer-locks", `${id}.lock`);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, "");
  lsofOut.push({ code: 0, stdout: `p${process.pid}\nccodex\nf70\nn${lockFile}\n` });
  const held = await lsof.executor.deliver({ thread: thread(lsof.cwd), message: "BuildBot3 full run failed", route: "computer-use", playbook: "merge-ready" });
  assert.equal(held.status, "blocked");
  assert.equal(held.detail, `${detail}; ${CODEX_APP_HOLDS}`);
  assert.deepEqual(lsof.calls.map((call) => call.args[0]), ["-F"], "only the lock read ran");
});

test("a Conductor chat goes by peer relay to its live peer only when that peer is idle now", async (t) => {
  const tab = (cwd) => conductorUiThread(cwd, { claudeSessionId: "cs1", live: { peerName: "old-1", pid: 5, status: "idle" } });
  const atConductor = () => [{ status: "blocked", detail: "owner using Conductor" }];
  const fresh = new Map([["cs1", { peerName: "new-2", pid: 6, status: "idle", waitingFor: null }]]);
  // The re-read chat carries its peer as read now.
  const now = async (thread) => ({ ...thread, live: { peerName: "new-2", pid: 6, status: "idle" } });
  const relayed = fallbackSetup(t, { results: atConductor(), peers: fresh, relay: [{ stdout: "DONE" }], refresh: now });
  const result = await relayed.executor.deliver({ thread: tab(relayed.cwd), message: "continue", route: "computer-use" });
  assert.equal(result.status, "sent");
  assert.equal(result.route, "peer-relay");
  assert.equal(relayed.calls.length, 1);
  assert.match(relayed.calls[0].args[1], /new-2/, "relays to the peer's name now, not the scan's");
  for (const [label, peers, extra] of [
    ["peer busy", new Map([["cs1", { peerName: "new-2", pid: 6, status: "busy" }]]), {}],
    ["peer waiting on a prompt", new Map([["cs1", { peerName: "new-2", pid: 6, status: "idle", waitingFor: "permission" }]]), {}],
    ["peer gone", new Map(), {}],
    ["an open pick in the chat", fresh, { meta: { ...conductorUiThread("x").meta, pendingQuestion: { text: "Which one?" } } }]
  ]) {
    const { cwd, calls, executor } = fallbackSetup(t, { results: atConductor(), peers, refresh: now });
    const blocked = await executor.deliver({ thread: { ...tab(cwd), ...extra }, message: "continue", route: "computer-use" });
    assert.equal(blocked.status, "blocked", label);
    assert.equal(calls.length, 0, label);
  }
  // The chat is read again at send time: a pick, a turn or a message since
  // the scan, or a chat that cannot be read, means no relay.
  for (const [label, refresh] of [
    ["a pick asked since the scan", async (thread) => ({ ...(await now(thread)), meta: { ...thread.meta, pendingQuestion: { text: "Which one?" } } })],
    ["a turn started", async (thread) => ({ ...(await now(thread)), agentStatus: "running" })],
    ["a message since the scan", async (thread) => ({ ...(await now(thread)), lastActivityAt: "2026-10-08T12:05:00Z" })],
    ["its peer busy by the second read", async (thread) => ({ ...thread, live: { peerName: "new-2", pid: 6, status: "busy" } })],
    ["another process by the second read", async (thread) => ({ ...thread, live: { peerName: "new-3", pid: 7, status: "idle" } })],
    ["unreadable", async () => { throw new Error("SQLITE_BUSY"); }],
    ["gone", async () => null]
  ]) {
    const { cwd, calls, executor } = fallbackSetup(t, { results: atConductor(), peers: fresh, refresh });
    const extra = { lastActivityAt: "2026-10-08T12:00:00Z" };
    const blocked = await executor.deliver({ thread: { ...tab(cwd), ...extra }, message: "continue", route: "computer-use" });
    assert.equal(blocked.status, "blocked", label);
    assert.equal(calls.length, 0, label);
  }
});

test("background route helpers: the presence block and the per-thread route", () => {
  assert.equal(isPresenceBlock({ status: "blocked", detail: "owner using Codex" }), true);
  assert.equal(isPresenceBlock({ status: "blocked", detail: "waiting for idle: Conductor must be in front to type" }), true);
  for (const delivery of [{ status: "failed", detail: "owner using Codex" }, { status: "blocked", detail: "owner using Codex; our text is left as a draft" }, { status: "blocked", detail: "frontmost app changed" }, null]) {
    assert.equal(isPresenceBlock(delivery), false, JSON.stringify(delivery));
  }
  const config = { backgroundRoutes: ["codex-exec"] };
  const codex = { kind: "codex", id: "t1", cwd: "/w", meta: {} };
  assert.equal(backgroundRouteFor(codex, config), "codex-exec");
  assert.equal(backgroundRouteFor({ ...codex, cwd: null }, config), null);
  assert.equal(backgroundRouteFor({ ...codex, agentStatus: "running" }, config), null);
  assert.equal(backgroundRouteFor(codex, { backgroundRoutes: ["peer-relay"] }), null);
  assert.equal(backgroundRouteFor({ ...codex, meta: { originator: "Codex Desktop" } }, config), null, "a Codex app thread is only typed into the app");
  const live = { kind: "conductor", id: "s1", meta: {}, live: { peerName: "p", pid: 1, status: "idle" } };
  assert.equal(backgroundRouteFor(live, config), null, "peer-relay not allowed");
  assert.equal(backgroundRouteFor(live, { backgroundRoutes: ["peer-relay"] }), "peer-relay");
  assert.equal(backgroundRouteFor({ ...live, kind: "claude", live: null }, { backgroundRoutes: ["peer-relay", "claude-resume"] }), null, "never claude-resume");
});

test("a remote send near its deadline takes no background route", async (t) => {
  withoutLbKey(t);
  const { cwd, calls, executor } = fallbackSetup(t, { results: ownerAtCodex() });
  const result = await executor.deliver({ thread: codexThread(cwd, { title: "Fix uploads" }), message: "continue", route: "computer-use", deadlineAt: Date.now() + DEADLINE_MARGIN_MS + 5_000 });
  assert.equal(result.status, "blocked");
  assert.equal(result.detail, "owner using Codex");
  assert.equal(calls.length, 0);
});

test("a Conductor chat waiting on background tasks is sent to now (⌘↩) unless the caller queues", async (t) => {
  const { cwd, executor, requests } = uiSetup(t);
  const waiting = conductorUiThread(cwd, { agentStatus: "waiting", openTasks: [{ id: "b1", description: "bb-verify --full" }] });
  await executor.deliver({ thread: waiting, message: "status?", route: "computer-use", playbook: "status-check" });
  assert.equal(requests.at(-1).busy, true);
  assert.equal(requests.at(-1).sendNow, true);
  await executor.deliver({ thread: waiting, message: "after your tasks", route: "computer-use", playbook: "owner-message", queue: true });
  assert.equal(requests.at(-1).sendNow, false);
  await executor.deliver({ thread: conductorUiThread(cwd), message: "idle", route: "computer-use" });
  assert.equal(requests.at(-1).busy, false);
  assert.equal(requests.at(-1).sendNow, false);
});

test("a Codex thread hosted in a busy Conductor chat is sent to now too; a queued send never falls back to a relay", async (t) => {
  const base = setup(t);
  const host = conductorUiThread(base.cwd, { agentStatus: "waiting", openTasks: [{ id: "b1" }] });
  const hosted = { key: "codex:h1", kind: "codex", id: "h1", cwd: base.cwd, archived: false, writerLocked: false, agentStatus: "idle",
    meta: { originator: "codex_sdk_ts", conductorHost: { workspaceId: "w-madrid", sessionId: "s1", workspace: "madrid", title: "Fix billing" } } };
  const requests = [];
  const ui = { async deliver(request) { requests.push(request); return { status: "sent", detail: "typed into Conductor" }; } };
  const executor = createExecutor({ config: { ...base.config, delivery: "computer-use" }, run: base.run, store: base.store, ui, uiLock: createUiLock(), knownThreads: () => [host, hosted] });
  await executor.deliver({ thread: hosted, message: "status?", route: "computer-use" });
  assert.equal(requests.at(-1).sendNow, true, "busy is the Conductor chat it lands in");
  // Owner at the Mac, background routes on, asked to queue: it waits, no relay.
  const peers = new Map([["cs1", { peerName: "p-1", pid: 6, status: "idle", waitingFor: null }]]);
  const blocked = createExecutor({ config: { ...base.config, delivery: "computer-use", backgroundRoutes: ["peer-relay"] }, run: base.run, store: base.store,
    ui: { deliver: async () => ({ status: "blocked", detail: "owner using Conductor" }) }, uiLock: createUiLock(), readLivePeers: () => peers, refreshThread: async () => tab });
  const tab = conductorUiThread(base.cwd, { claudeSessionId: "cs1", agentStatus: "waiting", live: { peerName: "p-1", pid: 6, status: "idle" } });
  const result = await blocked.deliver({ thread: tab, message: "after your tasks", route: "computer-use", queue: true });
  assert.equal(result.status, "blocked");
  assert.equal(base.calls.length, 0, "no relay ran");
});

test("send now or queue is read at send time; a queued Conductor send goes by the app or not at all", async (t) => {
  const { cwd, base } = (() => { const b = setup(t); return { cwd: b.cwd, base: b }; })();
  const requests = [];
  const ui = { async deliver(request) { requests.push(request); return { status: "sent", detail: "typed into Conductor" }; } };
  const stale = conductorUiThread(cwd, { agentStatus: "idle", openTasks: [] });
  const executor = createExecutor({ config: { ...base.config, delivery: "computer-use" }, run: base.run, store: base.store, ui, uiLock: createUiLock(),
    refreshThread: async () => ({ ...stale, agentStatus: "waiting", openTasks: [{ id: "b9" }] }) });
  await executor.deliver({ thread: stale, message: "status?", route: "computer-use" });
  assert.equal(requests.at(-1).sendNow, true, "a task started after the scan");
  const cli = createExecutor({ config: base.config, run: base.run, store: base.store, ui, uiLock: createUiLock() });
  const relay = await cli.deliver({ thread: conductorUiThread(cwd, { live: { peerName: "p", pid: 1, status: "idle" } }), message: "later", route: "peer-relay", queue: true });
  assert.equal(relay.status, "blocked");
  assert.match(relay.detail, /queue needs the Conductor app/);
  assert.equal(base.calls.length, 0);
});

test("queue is Conductor's: a Codex thread asked to queue still falls back while the owner is at the Mac", async (t) => {
  withoutLbKey(t);
  const { cwd, calls, executor } = fallbackSetup(t, { results: ownerAtCodex() });
  const result = await executor.deliver({ thread: codexThread(cwd, { title: "Fix uploads" }), message: "continue", route: "computer-use", queue: true });
  assert.equal(result.route, "codex-exec");
  assert.equal(calls.length, 1);
  await executor.whenIdle();
});

test("spawnWithTail with detach leaves a turn running past the ceiling and reports its end later", async () => {
  // Codex 019fe344: the codex-exec route hit its 2 h ceiling at 21:08Z and
  // killed a live turn. A detached child is never killed.
  let exited = null;
  const ended = new Promise((resolve) => { exited = resolve; });
  const script = "process.stdout.write('working\\n'); setTimeout(() => process.stdout.write('pushed the fix\\n'), 400)";
  const result = await spawnWithTail(process.execPath, ["-e", script], { timeoutMs: 100, killGraceMs: 50, detach: true, onExit: exited });
  assert.equal(result.detached, true);
  assert.equal(result.timedOut, false);
  const late = await ended;
  assert.equal(late.code, 0, "the turn ran to its end");
  assert.match(late.tail, /pushed the fix/);
});

function antigravitySetup(t, { results = [], fresh = undefined, server = undefined, delivery = undefined, backgroundRoutes = undefined, refresh = null, binary = "shim" } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-exec-ag-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const agentapi = path.join(home, "agentapi");
  const antigravityLs = path.join(home, "language_server");
  if (binary === "shim") fs.writeFileSync(agentapi, "#!/bin/sh\nexec /Applications/Antigravity.app/Contents/Resources/bin/language_server agentapi \"$@\"\n");
  if (["shim", "bundled"].includes(binary)) fs.writeFileSync(antigravityLs, "fixture");
  const config = resolveFleetConfig({}, { home, bins: { agentapi, antigravityLs }, ...(delivery ? { delivery } : {}), ...(backgroundRoutes ? { backgroundRoutes } : {}) });
  const store = new FleetStore({ dir: path.join(home, "fleet") });
  const calls = [];
  const run = (cmd, args, options = {}) => {
    calls.push({ cmd, args, env: options.env, timeoutMs: options.timeoutMs });
    return Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: false, error: null, ...(results.shift() ?? {}) });
  };
  const ls = server === undefined ? { pid: 9, address: "127.0.0.1:50489" } : server;
  if (ls) Object.defineProperty(ls, "csrfToken", { value: "csrf-secret-77", enumerable: false });
  const refreshed = [];
  const executor = createExecutor({
    config, run, store,
    refreshThread: async (thread) => { refreshed.push(thread.key); return refresh ? refresh(thread) : fresh === undefined ? thread : fresh; },
    findLanguageServer: async () => ls
  });
  return { home, config, store, calls, executor, refreshed };
}

function antigravityThread(extra = {}) {
  return {
    key: "antigravity:e8b9db19", kind: "antigravity", id: "e8b9db19", cwd: null, archived: false, writerLocked: false, live: null,
    agentStatus: "error", lastUserAt: "2026-10-14T06:11:16.121Z", meta: { projectId: "proj-1" }, ...extra
  };
}

test("Antigravity delivery falls back to bundled agentapi and blocks missing or relative binaries", async (t) => {
  const bundled = antigravitySetup(t, { binary: "bundled" });
  assert.equal((await bundled.executor.deliver({ thread: antigravityThread(), message: "continue", route: "antigravity-send" })).status, "sent");
  assert.equal(bundled.calls[0].cmd, bundled.config.bins.antigravityLs);
  assert.deepEqual(bundled.calls[0].args.slice(0, 2), ["agentapi", "send-message"]);
  for (const relative of [false, true]) {
    const missing = antigravitySetup(t, { binary: "missing" });
    if (relative) Object.assign(missing.config.bins, { agentapi: "agentapi", antigravityLs: "language_server" });
    const result = await missing.executor.deliver({ thread: antigravityThread(), message: "continue", route: "antigravity-send" });
    assert.equal(result.status, "blocked");
    assert.match(result.detail, /delivery unavailable.*\/Applications.*~\/Applications/);
    assert.equal(missing.calls.length, 0);
  }
});

test("Antigravity cancels stale resumes and proposed nudges after agent activity", async (t) => {
  const scanned = antigravityThread({ lastAgentAt: "2026-10-14T06:00:00.000Z", lastActivityAt: "2026-10-14T06:10:00.000Z", meta: { stepCount: 10 } });
  for (const playbook of ["resume", "nudge"]) {
    for (const change of [
      { lastAgentAt: "2026-10-14T06:20:00.000Z" },
      { lastActivityAt: "2026-10-14T06:20:00.000Z" },
      { meta: { stepCount: 11 } }
    ]) {
      const setup = antigravitySetup(t, { fresh: { ...scanned, agentStatus: "idle", ...change } });
      const result = await setup.executor.deliver({ thread: scanned, message: "continue", route: "antigravity-send", playbook });
      assert.equal(result.status, "blocked");
      assert.match(result.detail, /agent replied or did new work/);
      assert.equal(setup.calls.length, 0);
    }
  }
});

test("Antigravity resumes only while the original error still stands", async (t) => {
  const thread = antigravityThread({ error: { kind: "usage-limit", text: "quota spent" } });
  for (const error of [null, { kind: "network", text: "offline" }, { kind: "usage-limit", text: "different limit" }, thread.error]) {
    const setup = antigravitySetup(t, { fresh: { ...thread, error } });
    const result = await setup.executor.deliver({ thread, message: "continue", route: "antigravity-send", playbook: "resume" });
    assert.equal(result.status, error === thread.error ? "sent" : "blocked");
    if (error !== thread.error) assert.match(result.detail, /original error no longer stands/);
    assert.equal(setup.calls.length, error === thread.error ? 1 : 0);
  }
});

test("antigravity-send runs agentapi send-message with the server address and token in the child env only", async (t) => {
  const { calls, config, store, executor, refreshed } = antigravitySetup(t, { results: [{ stdout: '{"response":{"sendMessage":{"recipientId":"e8b9db19"}}}\n' }] });
  const result = await executor.deliver({ thread: antigravityThread(), message: "The quota reset; continue.", route: "antigravity-send", playbook: "resume" });
  assert.equal(result.status, "sent");
  assert.equal(result.route, "antigravity-send");
  assert.deepEqual(refreshed, ["antigravity:e8b9db19"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, config.bins.agentapi);
  assert.deepEqual(calls[0].args, ["send-message", "--title", "OpenAGI supervisor", "e8b9db19", `${MESSAGE_PREFIX}The quota reset; continue.`]);
  assert.equal(calls[0].env.ANTIGRAVITY_LS_ADDRESS, "127.0.0.1:50489");
  assert.equal(calls[0].env.ANTIGRAVITY_CSRF_TOKEN, "csrf-secret-77");
  assert.equal(calls[0].env.ANTIGRAVITY_PROJECT_ID, "proj-1");
  assert.equal(process.env.ANTIGRAVITY_CSRF_TOKEN, undefined);
  const action = store.action(result.actionId);
  assert.equal(action.status, "sent");
  assert.equal(action.route, "antigravity-send");
  const everything = JSON.stringify(result) + JSON.stringify(store.actions()) + fs.readFileSync(path.join(store.dir, "state.json"), "utf8");
  assert.doesNotMatch(everything, /csrf-secret-77/);
  assert.deepEqual(executor.inFlight(), []);
});

test("antigravity-send re-reads the conversation and leaves a busy one alone", async (t) => {
  const cases = [
    [{ agentStatus: "running" }, /turn running/],
    [{ agentStatus: "waiting", meta: { blockedOnOwner: true } }, /approval in Antigravity/],
    [{ agentStatus: "idle", lastUserAt: "2026-10-14T07:00:00.000Z" }, /owner wrote/],
    [null, /read the conversation again/]
  ];
  for (const [change, reason] of cases) {
    const fresh = change ? antigravityThread(change) : null;
    const { calls, executor } = antigravitySetup(t, { fresh });
    const result = await executor.deliver({ thread: antigravityThread(), message: "continue", route: "antigravity-send" });
    assert.equal(result.status, "blocked", String(reason));
    assert.match(result.detail, reason);
    assert.equal(calls.length, 0);
  }
  // The scan's own reading is checked before anything is read again.
  const { calls, executor, refreshed } = antigravitySetup(t);
  assert.match((await executor.deliver({ thread: antigravityThread({ agentStatus: "running" }), message: "x", route: "antigravity-send" })).detail, /turn running/);
  assert.match((await executor.deliver({ thread: { ...antigravityThread(), kind: "claude" }, message: "x", route: "antigravity-send" })).detail, /needs an Antigravity conversation/);
  assert.deepEqual([calls.length, refreshed.length], [0, 0]);
});

test("antigravity-send without a running app, or with agentapi failing, says why", async (t) => {
  const off = antigravitySetup(t, { server: null });
  const blocked = await off.executor.deliver({ thread: antigravityThread(), message: "continue", route: "antigravity-send" });
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.detail, /Antigravity is not running/);
  assert.equal(off.calls.length, 0);
  const failing = antigravitySetup(t, { results: [{ code: 0, stdout: '{"error":"ANTIGRAVITY_LS_ADDRESS is not set"}' }] });
  const failed = await failing.executor.deliver({ thread: antigravityThread(), message: "continue", route: "antigravity-send" });
  assert.equal(failed.status, "failed");
  assert.match(failed.detail, /agentapi failed: ANTIGRAVITY_LS_ADDRESS is not set/);
});

test("antigravity-send works on a computer-use-only Mac and dry-runs without running", async (t) => {
  const { calls, executor } = antigravitySetup(t, { delivery: "computer-use", backgroundRoutes: ["antigravity-send"], results: [{ stdout: '{"response":{"sendMessage":{}}}' }] });
  const dry = await executor.deliver({ thread: antigravityThread(), message: "continue", route: "antigravity-send", dryRun: true });
  assert.equal(dry.status, "dry-run");
  assert.match(dry.detail, /agentapi send-message e8b9db19/);
  assert.equal(calls.length, 0);
  assert.equal((await executor.deliver({ thread: antigravityThread(), message: "continue", route: "antigravity-send" })).status, "sent");
});


test("Antigravity reserves the thread before refreshing and releases every blocked send", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const setup = antigravitySetup(t, { refresh: async (thread) => { await gate; return thread; } });
  const request = { thread: antigravityThread(), message: "resume", route: "antigravity-send" };
  const first = setup.executor.deliver(request);
  assert.deepEqual(setup.executor.inFlight(), [request.thread.key]);
  const second = await setup.executor.deliver(request);
  assert.match(second.detail, /in flight/);
  release();
  assert.equal((await first).status, "sent");
  assert.equal(setup.calls.length, 1);
  assert.deepEqual(setup.executor.inFlight(), []);
  const blocked = antigravitySetup(t, { fresh: null });
  await blocked.executor.deliver(request);
  assert.deepEqual(blocked.executor.inFlight(), []);
});

test("Antigravity busy metadata blocks both scan and fresh delivery regardless of displayed status", async (t) => {
  for (const meta of [{ runStatus: "CASCADE_RUN_STATUS_RUNNING" }, { runStatus: "BUSY" }, { notFullyIdle: true }]) {
    const thread = antigravityThread({ agentStatus: "stalled", meta });
    const scan = antigravitySetup(t);
    assert.match((await scan.executor.deliver({ thread, message: "resume", route: "antigravity-send" })).detail, /turn running/);
    const fresh = antigravitySetup(t, { fresh: thread });
    assert.match((await fresh.executor.deliver({ thread: antigravityThread(), message: "resume", route: "antigravity-send" })).detail, /turn running/);
    assert.equal(scan.calls.length + fresh.calls.length, 0);
  }
});

test("Antigravity requires an explicit background allowance in computer-use modes", async (t) => {
  for (const delivery of ["computer-use", "computer-use-first"]) {
    const setup = antigravitySetup(t, { delivery });
    assert.match((await setup.executor.deliver({ thread: antigravityThread(), message: "resume", route: "antigravity-send" })).detail, /background delivery is not allowed/);
    assert.equal(setup.calls.length, 0);
  }
});

test("agentapi timeout stays unconfirmed across retries and executor restart", async (t) => {
  const setup = antigravitySetup(t, { results: [{ timedOut: true }] });
  const request = { thread: antigravityThread(), message: "resume", route: "antigravity-send" };
  const first = await setup.executor.deliver(request);
  assert.equal(first.status, "blocked");
  assert.equal(first.unconfirmed, true);
  assert.equal(setup.store.action(first.actionId).unconfirmed, true);
  assert.match((await setup.executor.deliver(request)).detail, /unconfirmed/);
  const restarted = createExecutor({ config: setup.config, store: setup.store, run: () => { throw new Error("must not send again"); }, refreshThread: async () => request.thread });
  assert.match((await restarted.deliver(request)).detail, /unconfirmed/);
  assert.equal(setup.calls.length, 1);
  const confirmed = createExecutor({ config: setup.config, store: setup.store, run: () => { throw new Error("must not send again"); }, refreshThread: async () => ({ ...request.thread, meta: { lastSupervisorAt: new Date(Date.now() + 1000).toISOString() } }) });
  assert.equal((await confirmed.deliver(request)).status, "sent");
});

test("agentapi accepts exit zero without depending on one JSON success shape", async (t) => {
  for (const stdout of ["", "Message delivered", '{"ok":true}']) {
    const setup = antigravitySetup(t, { results: [{ stdout }] });
    assert.equal((await setup.executor.deliver({ thread: antigravityThread(), message: "resume", route: "antigravity-send" })).status, "sent");
  }
});
