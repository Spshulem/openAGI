// test/bind-fail-closed.test.js
//
// Regression test for the Linux/Docker install shipping an unauthenticated
// agent on every interface.
//
// What actually happened: Dockerfile sets HOST=0.0.0.0, scripts/install.sh
// generated a compose file with HOST=0.0.0.0 and NO OPENAGI_AUTH_TOKEN, and
// checkAuth() treats an unset token as "auth disabled". src/boot.js only
// printed a warning and started anyway. Booted that way the daemon answered
// GET /memory and GET /mcp with HTTP 200 to anything on the LAN — memory,
// screen-OCR recall, iMessage-derived data, MCP server registration.
//
// The fix is to fail closed: a NON-LOOPBACK bind with no token must refuse to
// start. Loopback with no token stays working — that is the single-user local
// install and breaking it would be a bad trade.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkBindSafety, isLoopbackHost } from "../src/auth.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(REPO, "examples", "hosted-server.js");

// ---------------------------------------------------------------- unit ----

test("isLoopbackHost recognises every spelling of loopback, and nothing else", () => {
  for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]", "::ffff:127.0.0.1", " 127.0.0.1 "]) {
    assert.equal(isLoopbackHost(h), true, `${JSON.stringify(h)} is loopback`);
  }
  for (const h of ["0.0.0.0", "::", "[::]", "192.168.1.10", "10.0.0.64", "0.0.0.0 ", "example.com", "", null, undefined, "128.0.0.1", "1270.0.0.1"]) {
    assert.equal(isLoopbackHost(h), false, `${JSON.stringify(h)} is NOT loopback`);
  }
});

test("checkBindSafety refuses a non-loopback bind with no token, and allows the legitimate cases", () => {
  // The exact configuration the documented Docker install produced.
  const wildcard = checkBindSafety({ host: "0.0.0.0", token: "" });
  assert.equal(wildcard.ok, false, "0.0.0.0 with no token must be refused");
  assert.match(wildcard.message, /OPENAGI_AUTH_TOKEN/, "the message must name the variable to set");
  assert.match(wildcard.message, /127\.0\.0\.1/, "the message must offer the loopback escape hatch");

  // A specific LAN address is exactly as exposed as the wildcard.
  assert.equal(checkBindSafety({ host: "192.168.1.10", token: null }).ok, false, "a LAN IP with no token must be refused");
  assert.equal(checkBindSafety({ host: "::", token: undefined }).ok, false, ":: with no token must be refused");

  // Legitimate: local dev on loopback, no token.
  assert.equal(checkBindSafety({ host: "127.0.0.1", token: "" }).ok, true, "loopback with no token must keep working");
  assert.equal(checkBindSafety({ host: "localhost", token: null }).ok, true, "localhost with no token must keep working");
  assert.equal(checkBindSafety({ host: "::1", token: undefined }).ok, true, "::1 with no token must keep working");

  // Legitimate: exposed, but authenticated.
  assert.equal(checkBindSafety({ host: "0.0.0.0", token: "s3cret" }).ok, true, "0.0.0.0 WITH a token is the supported exposed setup");
  assert.equal(checkBindSafety({ host: "192.168.1.10", token: "s3cret" }).ok, true, "a LAN IP WITH a token is fine");

  // Whitespace-only is not a token.
  assert.equal(checkBindSafety({ host: "0.0.0.0", token: "   " }).ok, false, "a blank token must not count as auth");
});

// --------------------------------------------------------- integration ----

// 43298/43299 are the iMessage and computer-use node service defaults and may
// legitimately be occupied on a developer's machine; ask the OS for a free one.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function bootDaemon({ host, port, token }, timeoutMs = 25000) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-bindtest-"));
  const env = { ...process.env, OPENAGI_DATA_DIR: dataDir, HOST: host, PORT: String(port) };
  // The parent process may legitimately have a token; each case sets its own.
  delete env.OPENAGI_AUTH_TOKEN;
  delete env.NODE_TEST_CONTEXT;
  if (token) env.OPENAGI_AUTH_TOKEN = token;

  const child = spawn(process.execPath, [ENTRY], { cwd: dataDir, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      resolve({ ...result, output: out, dataDir });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ started: false, exitCode: null, timedOut: true });
    }, timeoutMs);
    // "listening" is the daemon's own line; treat it as started.
    const poll = setInterval(() => {
      if (/listening at http/.test(out)) {
        child.kill("SIGKILL");
        finish({ started: true, exitCode: null, timedOut: false });
      }
    }, 100);
    child.on("exit", (code, signal) => {
      if (signal === "SIGKILL" && settled) return;
      finish({ started: false, exitCode: code, timedOut: false });
    });
  });
}

test("a non-loopback bind with no token REFUSES to start with a non-zero exit", { timeout: 40000 }, async () => {
  const r = await bootDaemon({ host: "0.0.0.0", port: await freePort(), token: null });
  assert.equal(r.started, false, `the daemon must not come up:\n${r.output}`);
  assert.equal(r.timedOut, false, `the daemon must exit, not hang:\n${r.output}`);
  assert.notEqual(r.exitCode, 0, `exit code must be non-zero so systemd/docker surface it, got ${r.exitCode}:\n${r.output}`);
  assert.match(r.output, /OPENAGI_AUTH_TOKEN/, "the refusal must be actionable");
  fs.rmSync(r.dataDir, { recursive: true, force: true });
});

test("loopback with no token still starts — the local dev case must not break", { timeout: 40000 }, async () => {
  const r = await bootDaemon({ host: "127.0.0.1", port: await freePort(), token: null });
  assert.equal(r.started, true, `loopback with no token must still boot:\n${r.output}`);
  fs.rmSync(r.dataDir, { recursive: true, force: true });
});

test("a non-loopback bind WITH a token starts — the supported exposed setup", { timeout: 40000 }, async () => {
  const r = await bootDaemon({ host: "0.0.0.0", port: await freePort(), token: "test-token-not-a-real-secret" });
  assert.equal(r.started, true, `0.0.0.0 with a token must boot:\n${r.output}`);
  fs.rmSync(r.dataDir, { recursive: true, force: true });
});
