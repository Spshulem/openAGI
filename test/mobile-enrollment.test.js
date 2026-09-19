// test/mobile-enrollment.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

async function bootApp(dataDir) {
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, tickerMs: 0, dataDir, authToken: null });
  const listened = await app.listen();
  return { runtime, app, base: listened.url ?? `http://127.0.0.1:${listened.port}` };
}

const token = () => crypto.randomBytes(32).toString("base64url");

async function pairPhone(base, { name = "Sean's iPhone" } = {}) {
  const issued = await fetch(`${base}/nodes/enrollment-code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "mobile" })
  });
  assert.equal(issued.status, 200);
  const { code } = await issued.json();
  const nodeId = `mobile:${crypto.randomUUID()}`;
  const nodeToken = token();
  const exchanged = await fetch(`${base}/nodes/enroll/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, platform: "mobile", nodeId, nodeToken, name })
  });
  return { exchanged, nodeId, nodeToken };
}

test("a phone can get a code and exchange it for a mobile-scoped credential", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobenroll-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const { exchanged, nodeId } = await pairPhone(base);
    assert.equal(exchanged.status, 200);
    const json = await exchanged.json();
    assert.equal(json.node.id, nodeId);
    assert.equal(json.node.platform, "mobile");
    assert.equal(json.node.name, "Sean's iPhone");
    assert.ok(json.node.enrolledAt);
    assert.deepEqual(json.capabilities, ["mobile-task-client", "mobile-approval-client", "mobile-chat-client"]);
  } finally { await app.close(); }
});

test("the issued code is single use and platform-bound", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobenroll2-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const issued = await fetch(`${base}/nodes/enrollment-code`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "mobile" })
    });
    const { code } = await issued.json();
    // A G2 client cannot spend a code minted for a phone.
    const wrongPlatform = await fetch(`${base}/nodes/enroll/exchange`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, platform: "even_g2", nodeId: "g2:1", nodeToken: token() })
    });
    assert.equal(wrongPlatform.status, 401);
    const first = await fetch(`${base}/nodes/enroll/exchange`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, platform: "mobile", nodeId: `mobile:${crypto.randomUUID()}`, nodeToken: token() })
    });
    assert.equal(first.status, 200);
    const replay = await fetch(`${base}/nodes/enroll/exchange`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, platform: "mobile", nodeId: `mobile:${crypto.randomUUID()}`, nodeToken: token() })
    });
    assert.equal(replay.status, 401);
  } finally { await app.close(); }
});

test("an unknown platform is still rejected", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobenroll3-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const res = await fetch(`${base}/nodes/enrollment-code`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "toaster" })
    });
    assert.equal(res.status, 400);
  } finally { await app.close(); }
});

test("the phone credential opens allowlisted routes and nothing else", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobenroll4-"));
  const runtimeDir = dataDir;
  const runtime = createDurableRuntime({ dataDir: runtimeDir });
  const app = createHostedInterface(runtime, {
    host: "127.0.0.1", port: 0, tickerMs: 0, dataDir: runtimeDir, authToken: "owner-token"
  });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  try {
    const issued = await fetch(`${base}/nodes/enrollment-code`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer owner-token" },
      body: JSON.stringify({ platform: "mobile" })
    });
    const { code } = await issued.json();
    const nodeId = `mobile:${crypto.randomUUID()}`;
    const nodeToken = token();
    const exchanged = await fetch(`${base}/nodes/enroll/exchange`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, platform: "mobile", nodeId, nodeToken, name: "Pixel" })
    });
    assert.equal(exchanged.status, 200);

    const asPhone = (pathname, init = {}) => fetch(`${base}${pathname}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${nodeToken}`,
        "x-openagi-node-id": nodeId,
        ...(init.headers ?? {})
      }
    });

    assert.equal((await asPhone("/tasks")).status, 200);
    assert.equal((await asPhone("/pending-actions")).status, 200);
    assert.equal((await asPhone("/brief/today")).status, 200);
    // Refused: outside the allowlist, even with a valid phone credential.
    assert.equal((await asPhone("/memory")).status, 401);
    assert.equal((await asPhone("/skills")).status, 401);
    assert.equal((await asPhone("/computer-use/log")).status, 401);
    assert.equal((await asPhone("/control/restart", { method: "POST", body: "{}" })).status, 401);
    assert.equal((await asPhone("/nodes/g2/ask", { method: "POST", body: "{}" })).status, 401);
  } finally { await app.close(); }
});
