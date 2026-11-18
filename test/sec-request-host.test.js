import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { checkRequestHost } from "../src/auth.js";

test("the tokenless Host guard rejects hostname and authority tricks", () => {
  for (const host of [undefined, "", "attacker.example", "localhost.attacker.example", "attacker@localhost",
    "localhost/attacker", "localhost?attacker", "localhost#attacker", " localhost", "localhost:bad", "[::]"]) {
    assert.equal(checkRequestHost({ headers: { host } }, "").ok, false, String(host));
  }
  for (const host of ["localhost:43210", "LOCALHOST:43210", "127.0.0.1:43210", "127.1.2.3:43210", "[::1]:43210"]) {
    assert.equal(checkRequestHost({ headers: { host } }, "").ok, true, host);
  }
});

function request(port, { authority, method = "GET", pathname = "/tasks", token } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: authority };
    if (method === "POST") headers.Origin = `http://${authority}`;
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
}

async function boot(t, authToken = "") {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-host-security-"));
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, tickerMs: 0, dataDir, authToken });
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const { port } = await app.listen();
  runtime.tasks.add({ queue: "user", title: "Private local task", bucket: "today" });
  return port;
}

test("tokenless local APIs reject an attacker Host on reads and same-origin writes", async (t) => {
  const port = await boot(t);
  const read = await request(port, { authority: `attacker.example:${port}` });
  const write = await request(port, { authority: `attacker.example:${port}`, method: "POST" });
  assert.equal(read.status, 403);
  assert.equal(read.body.includes("Private local task"), false);
  assert.equal(write.status, 403);
});

test("first-run setup cannot be opened through an attacker hostname", async (t) => {
  const port = await boot(t);
  const result = await request(port, { authority: `attacker.example:${port}`, pathname: "/setup" });
  assert.equal(result.status, 403);
});

test("normal loopback requests remain available without a token", async (t) => {
  const port = await boot(t);
  for (const authority of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
    const result = await request(port, { authority });
    assert.equal(result.status, 200, authority);
    assert.equal(result.body.includes("Private local task"), true);
  }
});

test("authenticated tailnet and reverse-proxy hostnames keep working", async (t) => {
  const token = "synthetic-owner-token";
  const port = await boot(t, token);
  for (const authority of [`mac.tail1234.ts.net:${port}`, "agent.example.com"]) {
    assert.equal((await request(port, { authority, token })).status, 200);
    assert.equal((await request(port, { authority })).status, 401);
  }
});
