import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { waitForRuntimeHealth } from "../scripts/smoke-runtime.mjs";

async function healthServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}/health`;
}

const runningChild = () => Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });

test("startup can become healthy after more than forty unsuccessful probes", async t => {
  let requests = 0;
  const url = await healthServer(t, (_req, res) => {
    res.writeHead(++requests > 40 ? 200 : 503).end();
  });
  const child = runningChild();
  const result = await waitForRuntimeHealth(child, url, { timeoutMs: 5000, pollIntervalMs: 1 });
  assert.equal(requests, 41);
  assert.equal(result.attempts, 41);
  assert.ok(result.elapsedMs < 5000);
  assert.equal(child.listenerCount("error"), 0);
});

test("unhealthy startup still fails at the deadline with the last probe result", async t => {
  const url = await healthServer(t, (_req, res) => res.writeHead(503).end());
  const child = runningChild();
  await assert.rejects(waitForRuntimeHealth(child, url, { timeoutMs: 500, pollIntervalMs: 5 }),
    /within 500ms \(\d+ probes; last: HTTP 503\)/);
  assert.equal(child.listenerCount("error"), 0);
});

test("a runtime crash fails before the readiness deadline", async t => {
  const url = await healthServer(t, (_req, res) => res.writeHead(503).end());
  const child = spawn(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await assert.rejects(waitForRuntimeHealth(child, url, { timeoutMs: 5000, pollIntervalMs: 5 }), /code: 7/);
});

test("a signal-terminated runtime is not mistaken for a still-starting child", async t => {
  const url = await healthServer(t, (_req, res) => res.writeHead(200).end());
  const child = Object.assign(runningChild(), { signalCode: "SIGTERM" });
  await assert.rejects(waitForRuntimeHealth(child, url), /signal: SIGTERM/);
});

test("a successful probe cannot hide a child exit while the request was in flight", async t => {
  const child = runningChild();
  const url = await healthServer(t, (_req, res) => {
    child.exitCode = 1;
    res.writeHead(200).end();
  });
  await assert.rejects(waitForRuntimeHealth(child, url), /code: 1/);
});

test("a spawn failure is reported without waiting for the startup deadline", async t => {
  const url = await healthServer(t, (_req, res) => res.writeHead(503).end());
  const child = runningChild();
  const result = waitForRuntimeHealth(child, url, { timeoutMs: 5000, pollIntervalMs: 5 });
  child.emit("error", Object.assign(new Error("runtime executable missing"), { code: "ENOENT" }));
  await assert.rejects(result, { code: "ENOENT" });
  assert.equal(child.listenerCount("error"), 0);
});
