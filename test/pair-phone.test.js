// test/pair-phone.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { buildPairingUrl, assertPhoneReachable } from "../src/pair-phone.js";

test("the pairing url carries exactly what the phone needs", () => {
  const url = buildPairingUrl({ baseUrl: "http://mac.tail1234.ts.net:43210", code: "004221", platform: "ios" });
  const parsed = new URL(url);
  assert.equal(parsed.protocol, "openagi:");
  assert.equal(parsed.searchParams.get("url"), "http://mac.tail1234.ts.net:43210");
  assert.equal(parsed.searchParams.get("code"), "004221");
  assert.equal(parsed.searchParams.get("platform"), "ios");
});

test("a trailing slash or path on the daemon url never reaches the phone", () => {
  const url = buildPairingUrl({ baseUrl: "http://mac.ts.net:43210/setup", code: "000001", platform: "android" });
  assert.equal(new URL(url).searchParams.get("url"), "http://mac.ts.net:43210");
});

test("a loopback daemon url is refused with a remediation, not a useless code", () => {
  assert.throws(() => assertPhoneReachable("http://127.0.0.1:43210"), /phone cannot reach 127\.0\.0\.1/);
  assert.throws(() => assertPhoneReachable("http://localhost:43210"), /phone cannot reach/);
  assert.throws(() => assertPhoneReachable("http://[::1]:43210"), /phone cannot reach/);
});

test("tailnet, LAN, and https origins are accepted", () => {
  assert.equal(assertPhoneReachable("http://mac.tail1234.ts.net:43210"), "http://mac.tail1234.ts.net:43210");
  assert.equal(assertPhoneReachable("http://100.101.102.103:43210"), "http://100.101.102.103:43210");
  assert.equal(assertPhoneReachable("http://192.168.1.20:43210"), "http://192.168.1.20:43210");
  assert.equal(assertPhoneReachable("https://openagi.example.com"), "https://openagi.example.com");
});

test("cleartext http to a public host is refused", () => {
  assert.throws(() => assertPhoneReachable("http://openagi.example.com"), /https/);
});

test("the platform must be one the app announces", () => {
  assert.throws(() => buildPairingUrl({ baseUrl: "http://mac.ts.net:43210", code: "000001", platform: "toaster" }),
    /platform must be ios or android/);
});

test("the code must be six digits", () => {
  assert.throws(() => buildPairingUrl({ baseUrl: "http://mac.ts.net:43210", code: "12345", platform: "ios" }),
    /six digits/);
});

test("pair-phone authenticates with the owner token saved by setup", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-pair-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const token = "test-owner-" + Date.now();
  fs.writeFileSync(path.join(dir, ".env"), `OPENAGI_AUTH_TOKEN="${token}"\n`);
  let authorization;
  const server = http.createServer((req, res) => {
    authorization = req.headers.authorization;
    assert.equal(req.url, "/nodes/enrollment-code");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ code: "123456", publicUrl: "https://phone.example.com", expiresAt: "soon" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const env = { ...process.env, OPENAGI_DATA_DIR: dir, OPENAGI_URL: `http://127.0.0.1:${server.address().port}` };
  delete env.OPENAGI_AUTH_TOKEN;
  delete env.OPENAGI_REMOTE;
  const child = spawn(process.execPath, ["bin/openagi.js", "pair-phone"], { env, cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, output);
  assert.equal(authorization, `Bearer ${token}`);
  assert.ok(output.includes("123456"));
  assert.equal(output.includes(token), false, "the owner credential is never printed");
});
