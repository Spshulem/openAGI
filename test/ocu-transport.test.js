import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { OcuTransport, readOcuPermissions } from "../src/integrations/ocu-transport.js";
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
