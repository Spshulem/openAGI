import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { OCU_CLOSE_GRACE_MS, OcuTransport, readOcuPermissions } from "../src/integrations/ocu-transport.js";
import { OCU_RELEASE } from "../src/integrations/ocu-release.js";

function fixture({ hang = false, malformed = false, refused = false, responseLine } = {}) {
  const child = new EventEmitter(); let killed = false, spawnArgs, requests = [];
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { killed = true; };
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const request = JSON.parse(String(chunk)); requests.push(request);
    if (request.id && !(hang && request.method === "tools/call")) queueMicrotask(() => {
      if (responseLine) { child.stdout.write(responseLine + "\n"); return; }
      if (malformed) { child.stdout.write("not json\n"); return; }
      const result = request.method === "initialize" ? { serverInfo: { name: "fixture", version: "0.3.3" } }
        : { isError: refused, content: [] };
      child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
    });
    done();
  } });
  const client = new OcuTransport("/native/OpenComputerUse", { timeoutMs: 30,
    spawnImpl: (...args) => { spawnArgs = args; return child; } });
  return { client, requests, get killed() { return killed; }, get spawnArgs() { return spawnArgs; } };
}
test("private MCP uses stdin and does not inherit provider keys or global pointer fallback", async t => {
  const f = fixture(); t.after(() => f.client.close());
  await f.client.call("type_text", { app: "org.test", text: "fixture private text" });
  assert.deepEqual(f.spawnArgs[1], ["mcp"]);
  assert.equal(f.spawnArgs[2].env.OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS, "0");
  assert.equal(f.spawnArgs[2].env.OPEN_COMPUTER_USE_DISABLE_APP_AGENT_PROXY, "1");
  assert.equal(f.spawnArgs[2].env.OPENAI_API_KEY, undefined);
  assert.equal(f.requests.find(r => r.method === "tools/call").params.arguments.text, "fixture private text");
});
test("timeout kills the owned engine and rejects pending work", async () => {
  const f = fixture({ hang: true });
  await assert.rejects(() => f.client.call("type_text", {}), /unconfirmed/);
  assert.equal(f.killed, true); assert.equal(f.client.pending.size, 0);
});
test("abort kills active work without retry", async () => {
  const f = fixture({ hang: true }); const abort = new AbortController();
  await f.client.connect(abort.signal);
  const pending = f.client.call("type_text", {}, abort.signal);
  await Promise.resolve(); abort.abort();
  await assert.rejects(pending, /unconfirmed|abort/i);
  assert.equal(f.killed, true);
});
test("malformed responses and tool refusals are errors", async () => {
  const broken = fixture({ malformed: true });
  await assert.rejects(() => broken.client.call("get_app_state", {}), /unconfirmed/);
  assert.equal(broken.killed, true);
  const refused = fixture({ refused: true });
  try { await assert.rejects(() => refused.client.call("type_text", {}), /could not complete/); }
  finally { refused.client.close(); }
});
test("valid JSON that is not an RPC object cannot crash the daemon", async () => {
  for (const responseLine of ["null", "[]", "42", '"text"', '{"id":1,"result":{}}']) {
    const f = fixture({ responseLine });
    await assert.rejects(() => f.client.call("get_app_state", {}), /unconfirmed/);
    assert.equal(f.killed, true);
  }
});

test("reviewed release pin is exact and version-consistent", () => {
  assert.match(OCU_RELEASE.version, /^\d+\.\d+\.\d+$/);
  assert.equal(OCU_RELEASE.archive, `https://registry.npmjs.org/open-computer-use/-/open-computer-use-${OCU_RELEASE.version}.tgz`);
  assert.equal(Buffer.from(OCU_RELEASE.integrity, "base64").length, 64);
  assert.equal(OCU_RELEASE.license, "MIT");
});

test("permission probes isolate credentials and bound process lifetime too", async () => {
  const output = await readOcuPermissions("/native/OpenComputerUse", (_file, args, options, callback) => {
    assert.deepEqual(args, ["doctor"]);
    assert.equal(options.env.OPEN_COMPUTER_USE_DISABLE_APP_AGENT_PROXY, "1");
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    assert.equal(options.timeout, 3000);
    assert.equal(options.maxBuffer, 16 * 1024);
    callback(null, "Permissions: accessibility=granted, screenRecording=granted");
  });
  assert.match(output, /^Permissions:/);
  await assert.rejects(readOcuPermissions("/native/OpenComputerUse", (_file, _args, _options, callback) => {
    callback(new Error("sensitive provider output"));
  }), error => error.message === "Open Computer Use permission probe failed.");
});

test("late output from a killed dispatcher cannot close its replacement", async t => {
  const children = [];
  const client = new OcuTransport("/native/OpenComputerUse", { spawnImpl: () => {
    const f = fixture();
    // Reuse the mock child's protocol implementation, but let this transport
    // own it. The fixture never connects or starts timers of its own.
    const child = f.client.spawn();
    children.push(child);
    return child;
  } });
  t.after(() => client.close());
  await client.connect();
  client.close();
  await client.connect();
  children[0].stdout.write("not json\n");
  children[0].emit("error", new Error("late process error"));
  children[0].stdin.emit("error", new Error("late pipe error"));
  assert.equal(client.proc, children[1]);
  await client.call("get_app_state", {});
});
test("the fleet's app-agent opt-in keeps pointer fallback off and only lifts the proxy block", async t => {
  const child = new EventEmitter(); let spawnArgs;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const request = JSON.parse(String(chunk));
    if (request.id) queueMicrotask(() => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id,
      result: request.method === "initialize" ? { serverInfo: { name: "fixture" } } : { isError: false, content: [] } }) + "\n"));
    done();
  } });
  const client = new OcuTransport("/native/OpenComputerUse", { timeoutMs: 30, appAgentProxy: true, spawnImpl: (...args) => { spawnArgs = args; return child; } });
  t.after(() => client.close());
  await client.call("get_app_state", { app: "com.conductor.app" });
  assert.equal(spawnArgs[2].env.OPEN_COMPUTER_USE_DISABLE_APP_AGENT_PROXY, undefined);
  assert.equal(spawnArgs[2].env.OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS, "0");
  assert.equal(spawnArgs[2].env.OPENAI_API_KEY, undefined);
  await readOcuPermissions("/native/OpenComputerUse", (_file, _args, options, callback) => {
    assert.equal(options.env.OPEN_COMPUTER_USE_DISABLE_APP_AGENT_PROXY, undefined);
    assert.equal(options.timeout, 10_000);
    callback(null, "Permissions: accessibility=granted, screenRecording=granted");
  }, { appAgentProxy: true, timeoutMs: 10_000 });
});

// The fleet's app-agent engine: a fixture that answers only what it is told to.
function agentFixture({ closeGraceMs } = {}) {
  const child = new EventEmitter(); let spawnArgs, kills = 0, stdinEnded = false; const requests = [];
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { kills += 1; };
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const request = JSON.parse(String(chunk)); requests.push(request);
    if (request.method === "initialize") queueMicrotask(() => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { serverInfo: { name: "fixture" } } }) + "\n"));
    done();
  }, final(done) { stdinEnded = true; done(); } });
  const answer = (id) => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: { isError: false, content: [] } }) + "\n");
  const client = new OcuTransport("/native/OpenComputerUse", { timeoutMs: 1000, appAgentProxy: true, agentNamespace: "openagi-fleet",
    ...(closeGraceMs === undefined ? {} : { closeGraceMs }), spawnImpl: (...args) => { spawnArgs = args; return child; } });
  return { client, child, requests, answer, get kills() { return kills; }, get stdinEnded() { return stdinEnded; }, get spawnArgs() { return spawnArgs; } };
}

test("a per-call timeout fails only that call and keeps the app-agent engine running", async t => {
  const f = agentFixture({ closeGraceMs: 0 }); t.after(() => f.client.close());
  const slow = f.client.call("get_app_state", { app: "com.openai.codex" }, undefined, { timeoutMs: 20 });
  await assert.rejects(slow, error => error.message.startsWith("Open Computer Use timed out"));
  assert.equal(f.kills, 0); assert.ok(f.client.proc, "engine still connected");
  // Its late answer is dropped; the next call is answered normally.
  f.answer(f.requests.find(r => r.method === "tools/call").id);
  const next = f.client.call("click", { app: "com.openai.codex" });
  await new Promise(resolve => setImmediate(resolve));
  f.answer(f.requests.filter(r => r.method === "tools/call")[1].id);
  assert.deepEqual(await next, { isError: false, content: [] });
  assert.equal(f.spawnArgs[2].env.OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE, "openagi-fleet");
});

test("closing an app-agent engine ends its input and kills it only after the grace period", async () => {
  assert.equal(OCU_CLOSE_GRACE_MS, 30_000);
  const f = agentFixture({ closeGraceMs: 20 });
  await f.client.connect();
  const pending = f.client.call("get_app_state", {});
  await new Promise(resolve => setImmediate(resolve));
  f.client.close();
  await assert.rejects(pending, /unconfirmed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.stdinEnded, true); assert.equal(f.kills, 0);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.kills, 1);
  // An abort still closes at once (the caller's deadline).
  const g = agentFixture({ closeGraceMs: 20 }); const abort = new AbortController();
  await g.client.connect();
  const aborted = g.client.call("get_app_state", {}, abort.signal);
  await new Promise(resolve => setImmediate(resolve));
  abort.abort();
  await assert.rejects(aborted, /unconfirmed/);
  assert.equal(g.client.proc, null);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(g.kills, 1);
});

test("the namespace reaches the permission probe too", async () => {
  await readOcuPermissions("/native/OpenComputerUse", (_file, _args, options, callback) => {
    assert.equal(options.env.OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE, "openagi-fleet");
    callback(null, "Permissions: accessibility=granted, screenRecording=granted");
  }, { appAgentProxy: true, agentNamespace: "openagi-fleet" });
  await readOcuPermissions("/native/OpenComputerUse", (_file, _args, options, callback) => {
    assert.equal(options.env.OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE, undefined);
    callback(null, "");
  });
});

test("through the app agent, input that times out or is cut off is marked in flight; reads and owned engines are not", async t => {
  const f = agentFixture({ closeGraceMs: 0 }); t.after(() => f.client.close());
  await assert.rejects(f.client.call("get_app_state", {}, undefined, { timeoutMs: 20 }), error => /timed out/.test(error.message) && !error.inFlight);
  for (const name of ["type_text", "press_key", "click"]) {
    await assert.rejects(f.client.call(name, {}, undefined, { timeoutMs: 20 }), error => /timed out/.test(error.message) && error.inFlight === true, name);
  }
  // Cut off by the caller's deadline: the agent's input keeps running.
  const abort = new AbortController();
  const typing = f.client.call("type_text", {}, abort.signal);
  await new Promise(resolve => setImmediate(resolve));
  abort.abort();
  await assert.rejects(typing, error => error.inFlight === true);
  // An owned engine is killed, which cancels its input.
  const owned = fixture({ hang: true });
  await assert.rejects(() => owned.client.call("type_text", {}), error => /unconfirmed/.test(error.message) && !error.inFlight);
});

test("a closed engine with input in flight stays up until that input answers late, then ends as usual", async () => {
  const f = agentFixture({ closeGraceMs: 20 });
  const typing = f.client.call("type_text", { app: "com.openai.codex", text: "hi" }, undefined, { timeoutMs: 20 });
  let error;
  await typing.catch((caught) => { error = caught; });
  assert.equal(error.inFlight, true);
  let outcome = null;
  error.settled.then((value) => { outcome = value; });
  f.client.close();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.stdinEnded, false, "input stays open so the late answer can come");
  assert.equal(f.kills, 0, "never killed while the input may still run");
  assert.equal(outcome, null);
  f.answer(f.requests.find(r => r.params?.name === "type_text").id);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(outcome, { completed: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.stdinEnded, true);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.kills, 1);
});

test("input cut off by close, whose engine then exits, is not proven finished", async () => {
  const f = agentFixture({ closeGraceMs: 20 });
  await f.client.connect();
  const clicking = f.client.call("click", { app: "com.openai.codex", element_index: "3" });
  await new Promise(resolve => setImmediate(resolve));
  f.client.close();
  const error = await clicking.catch((caught) => caught);
  assert.equal(error.inFlight, true);
  f.child.emit("exit", 0);
  assert.deepEqual(await error.settled, { completed: false });
});

test("input still pending when its engine exits is not proven finished, and leaves nothing waiting", async () => {
  const f = agentFixture({ closeGraceMs: 20 });
  await f.client.connect();
  const typing = f.client.call("type_text", { app: "com.openai.codex", text: "hi" });
  await new Promise(resolve => setImmediate(resolve));
  f.child.emit("exit", 0);
  const error = await typing.catch((caught) => caught);
  assert.equal(error.inFlight, true);
  assert.deepEqual(await error.settled, { completed: false });
  assert.equal(f.client.late.size, 0);
});
