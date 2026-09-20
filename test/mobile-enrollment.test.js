// test/mobile-enrollment.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { writeNodeConfig } from "../src/cli-client.js";
import { EVEN_G2_CAPABILITIES, EVEN_G2_PLATFORM } from "../src/integrations/g2-channel.js";

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

// ---------------------------------------------------------------------------
// G2 invariance. A shipped wearable depends on these bytes, so they are pinned
// here as assertions rather than asserted in a report. Every string below is
// the pre-generalisation text, copied character for character.
// ---------------------------------------------------------------------------

test("the remote 409 keeps the G2's original wording and gives the phone its own", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobenroll5-"));
  // The node config is written AFTER listen on purpose: the handler re-reads it
  // from disk per request, while the heartbeat sender is only started for a
  // remote that was already configured at listen. This exercises the 409
  // without booting a satellite that would dial a nonexistent main.
  const { app, base } = await bootApp(dataDir);
  writeNodeConfig({ remote: "https://main.example", token: null }, dataDir);
  try {
    const askFor = async (platform) => {
      const res = await fetch(`${base}/nodes/enrollment-code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform })
      });
      return { status: res.status, body: await res.json() };
    };

    const g2 = await askFor(EVEN_G2_PLATFORM);
    assert.equal(g2.status, 409);
    assert.equal(g2.body.error, "Even G2 nodes must be enrolled on the main OpenAGI");

    const phone = await askFor("mobile");
    assert.equal(phone.status, 409);
    assert.equal(phone.body.error, "phones must be enrolled on the main OpenAGI");

    // Only a mobile caller gets the new sentence. An unknown platform is not
    // MOBILE_PLATFORM, so it keeps the G2 text it returned before phones.
    const unknown = await askFor("toaster");
    assert.equal(unknown.status, 409);
    assert.equal(unknown.body.error, "Even G2 nodes must be enrolled on the main OpenAGI");
  } finally { await app.close(); }
});

test("the G2 exchange payload is unchanged field for field", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobenroll6-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const issued = await fetch(`${base}/nodes/enrollment-code`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: EVEN_G2_PLATFORM })
    });
    assert.equal(issued.status, 200);
    const { code } = await issued.json();
    const nodeId = `g2:${crypto.randomUUID()}`;
    const nodeToken = token();
    const exchanged = await fetch(`${base}/nodes/enroll/exchange`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, platform: EVEN_G2_PLATFORM, nodeId, nodeToken, name: "My Glasses" })
    });
    assert.equal(exchanged.status, 200);
    const json = await exchanged.json();
    assert.equal(json.node.id, nodeId);
    assert.equal(json.node.name, "My Glasses");
    assert.equal(json.node.platform, "even_g2");
    assert.ok(json.node.enrolledAt);
    assert.equal(json.nodeToken, nodeToken);
    assert.deepEqual(json.capabilities, EVEN_G2_CAPABILITIES);
    // The G2 response carries exactly these keys, and no phone-shaped extras.
    assert.deepEqual(Object.keys(json).sort(), ["capabilities", "node", "nodeToken"]);
    assert.deepEqual(Object.keys(json.node).sort(), ["enrolledAt", "id", "name", "platform"]);
  } finally { await app.close(); }
});

test("a nameless G2 exchange still falls back to the G2's own default name", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobenroll7-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const issued = await fetch(`${base}/nodes/enrollment-code`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: EVEN_G2_PLATFORM })
    });
    const { code } = await issued.json();
    const exchanged = await fetch(`${base}/nodes/enroll/exchange`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, platform: EVEN_G2_PLATFORM, nodeId: `g2:${crypto.randomUUID()}`, nodeToken: token() })
    });
    assert.equal(exchanged.status, 200);
    const json = await exchanged.json();
    // boundedG2NodeName's fallback, not boundedMobileNodeName's "Phone".
    assert.equal(json.node.name, "Even G2");
  } finally { await app.close(); }
});

test("transcriptionConfigured stays on the G2 code response and off the phone's", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobenroll8-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const codeFor = async (platform) => {
      const res = await fetch(`${base}/nodes/enrollment-code`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform })
      });
      assert.equal(res.status, 200);
      return await res.json();
    };

    const g2 = await codeFor(EVEN_G2_PLATFORM);
    assert.equal(Object.hasOwn(g2, "transcriptionConfigured"), true);
    assert.equal(typeof g2.transcriptionConfigured, "boolean");

    const phone = await codeFor("mobile");
    assert.equal(Object.hasOwn(phone, "transcriptionConfigured"), false);

    // publicUrl is on both: the pair-phone CLI reads it off the phone's.
    assert.equal(Object.hasOwn(g2, "publicUrl"), true);
    assert.equal(Object.hasOwn(phone, "publicUrl"), true);
    assert.match(g2.code, /^\d{6}$/);
    assert.match(phone.code, /^\d{6}$/);
  } finally { await app.close(); }
});
