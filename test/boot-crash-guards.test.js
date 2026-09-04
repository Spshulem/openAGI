// test/boot-crash-guards.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createFatalUncaughtExceptionHandler, installCrashGuards } from "../src/boot.js";

// A reauth-needed / unreachable MCP server rejects asynchronously during
// connect (401, OAuth callback timeout, DNS failure). Node 15+ would terminate
// the daemon on that unhandled rejection — crash-looping a recoverable error.
// Those rejections remain non-fatal, while synchronous uncaught exceptions
// terminate so the supervisor can replace a potentially corrupted daemon.
test("installCrashGuards installs distinct rejection and exception policies idempotently", () => {
  const beforeRej = process.listeners("unhandledRejection").length;
  const beforeExc = process.listeners("uncaughtException").length;

  installCrashGuards();
  const rejListeners = process.listeners("unhandledRejection");
  const excListeners = process.listeners("uncaughtException");
  assert.equal(rejListeners.length, beforeRej + 1, "adds one unhandledRejection listener");
  assert.equal(excListeners.length, beforeExc + 1, "adds one uncaughtException listener");

  // Idempotent: a second call must not stack more listeners.
  installCrashGuards();
  assert.equal(process.listeners("unhandledRejection").length, beforeRej + 1, "idempotent (rejection)");
  assert.equal(process.listeners("uncaughtException").length, beforeExc + 1, "idempotent (exception)");

  // Rejections must log and NOT rethrow — an MCP 401 / OAuth timeout is not fatal.
  const ourRej = rejListeners[rejListeners.length - 1];
  const ourExc = excListeners[excListeners.length - 1];
  const origErr = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(" "));
  try {
    assert.doesNotThrow(() => ourRej(new Error("HTTP 401 from buildbetter staging: invalid_token")));
    // A non-Error reason (e.g. a rejected string) must also be handled.
    assert.doesNotThrow(() => ourRej("bare string rejection"));
  } finally {
    console.error = origErr;
  }
  assert.ok(logged.some((l) => l.includes("401")), "logged the 401 rejection");
  assert.ok(logged.some((l) => l.includes("bare string rejection")), "logged a non-Error reason");

  // Clean up the listeners we added so they don't leak into the test runner.
  process.removeListener("unhandledRejection", ourRej);
  process.removeListener("uncaughtException", ourExc);
});

test("fatal exception handler emits one bounded line and exits non-zero", () => {
  const written = [];
  const exits = [];
  const handler = createFatalUncaughtExceptionHandler({
    write: (line) => written.push(line),
    exit: (code) => exits.push(code)
  });

  handler(new Error(`first line\n${"x".repeat(2_000)}`));
  handler(new Error("second exception while exiting"));

  assert.deepEqual(exits, [1, 1]);
  assert.equal(written.length, 1, "nested fatal errors do not recurse through logging");
  assert.match(written[0], /^\[openagi\] fatal uncaught exception .*Error: first line x+/);
  assert.equal(written[0].split("\n").length, 2, "embedded newlines are flattened");
  assert.ok(written[0].length < 1_200, "fatal diagnostic is bounded");
  assert.doesNotMatch(written[0], /\bat\s+/, "V8 stack formatting is never requested");
});

test("an installed handler terminates a child daemon process on an uncaught exception", () => {
  const bootUrl = new URL("../src/boot.js", import.meta.url).href;
  const script = `
    import { installCrashGuards } from ${JSON.stringify(bootUrl)};
    installCrashGuards();
    setImmediate(() => { throw new Error("child-fatal-marker"); });
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    timeout: 5_000
  });

  assert.equal(child.status, 1);
  assert.equal(child.signal, null);
  assert.match(child.stderr, /fatal uncaught exception/);
  assert.match(child.stderr, /child-fatal-marker/);
});
