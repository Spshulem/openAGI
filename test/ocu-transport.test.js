import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { OcuTransport } from "../src/integrations/ocu-transport.js";

function fixture({ hang = false, malformed = false, refused = false } = {}) {
  const child = new EventEmitter(); let killed = false, spawnArgs, requests = [];
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { killed = true; };
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const request = JSON.parse(String(chunk)); requests.push(request);
    if (request.id && !(hang && request.method === "tools/call")) queueMicrotask(() => {
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
