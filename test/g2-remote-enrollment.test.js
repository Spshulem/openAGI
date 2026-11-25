import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { NodeRegistry, readOrCreateIdentity } from "../src/node-registry.js";
import { NodeEnrollmentCodes, DELEGATED_ENROLLMENT_CODE_TTL_MS } from "../src/node-enrollment.js";
import { writeNodeConfig } from "../src/cli-client.js";
import { isMainDataRoute } from "../src/main-data-router.js";
import { EVEN_G2_PLATFORM } from "../src/integrations/g2-channel.js";

const MAIN_OWNER = "headless-main-owner";
const MAC_OWNER = "mac-local-owner";
const MAC_NODE_TOKEN = "w".repeat(43);
const MAC_PROXY_TOKEN = "q".repeat(43);
const PUBLIC_URL = "https://distiller.example.test";

async function boot(t, { authToken, publicUrl = null }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-g2-remote-"));
  const runtime = createDurableRuntime({ dataDir, registerDefaults: false, integrations: false,
    skills: false, autoConnectMcp: false });
  const nodeRegistry = new NodeRegistry({ dir: path.join(dataDir, "nodes") });
  const app = createHostedInterface(runtime, { dataDir, nodeRegistry, host: "127.0.0.1", port: 0,
    tickerMs: 0, authToken, nodeControlEnabled: false, ...(publicUrl ? { publicUrl } : {}) });
  const { url } = await app.listen();
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  t.after(async () => {
    await close();
    runtime.observations?.db?.close();
    runtime.vectorStore?.db?.close();
    runtime.sessionIndex?.db?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { dataDir, nodeRegistry, url, close };
}

// A headless main plus a Mac paired to it the way `openagi pair` does with
// the main owner's pairing token: an operational token and a separate
// owner-proxy grant, both recorded on main.
async function headlessMainWithMac(t, { ownerProxy = true } = {}) {
  const main = await boot(t, { authToken: MAIN_OWNER, publicUrl: PUBLIC_URL });
  const mac = await boot(t, { authToken: MAC_OWNER });
  const macId = readOrCreateIdentity(mac.dataDir).nodeId;
  const enrolled = await fetch(`${main.url}/nodes/enroll`, {
    method: "POST",
    headers: { authorization: `Bearer ${MAIN_OWNER}`, "content-type": "application/json" },
    body: JSON.stringify({ nodeId: macId, nodeToken: MAC_NODE_TOKEN, ...(ownerProxy ? { ownerProxyToken: MAC_PROXY_TOKEN } : {}) })
  });
  assert.equal(enrolled.status, 200);
  writeNodeConfig({ remote: main.url, token: null, nodeToken: MAC_NODE_TOKEN, nodeEnrollmentConfirmed: true,
    ...(ownerProxy ? { ownerProxyToken: MAC_PROXY_TOKEN } : {}) }, mac.dataDir);
  return { main, mac, macId };
}

const requestCodeOnMac = (mac, init = {}) => fetch(`${mac.url}/nodes/g2/enrollment-code`, {
  method: "POST",
  headers: { cookie: `openagi_token=${MAC_OWNER}`, "content-type": "application/json", ...init.headers },
  body: init.body ?? "{}"
});

const glassesExchange = (main, code, nodeId, nodeToken) => fetch(`${main.url}/nodes/enroll/exchange`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: "null" },
  body: JSON.stringify({ code, platform: EVEN_G2_PLATFORM, nodeId, nodeToken, name: "Spencer's G2" })
});

function captureLogs(t) {
  const lines = [];
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const key of Object.keys(original)) console[key] = (...args) => lines.push(args.map(String).join(" "));
  t.after(() => Object.assign(console, original));
  return lines;
}

test("a paired Mac requests a main-issued G2 code; glasses enroll on main and stay connected without the Mac", async (t) => {
  const { main, mac, macId } = await headlessMainWithMac(t);
  const logs = captureLogs(t);

  const page = await fetch(`${mac.url}/g2/connect`, { headers: { cookie: `openagi_token=${MAC_OWNER}` } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, new RegExp(`Target main:</b> <code>${main.url.replace(/[.]/g, "\\.")}</code>`));
  assert.match(html, /fetch\('\/nodes\/g2\/enrollment-code'/);

  const before = Date.now();
  const response = await requestCodeOnMac(mac);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-openagi-data-source"), "main");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const issued = await response.json();
  assert.match(issued.code, /^\d{6}$/);
  assert.equal(issued.platform, EVEN_G2_PLATFORM);
  assert.equal(issued.publicUrl, PUBLIC_URL, "the card points the glasses at main, not the Mac");
  const ttl = Date.parse(issued.expiresAt) - before;
  assert.ok(ttl > DELEGATED_ENROLLMENT_CODE_TTL_MS - 5_000 && ttl <= DELEGATED_ENROLLMENT_CODE_TTL_MS + 5_000);

  const glassesId = randomUUID();
  const glassesToken = "g".repeat(43);
  const exchanged = await glassesExchange(main, issued.code, glassesId, glassesToken);
  assert.equal(exchanged.status, 200);
  const enrollment = main.nodeRegistry.enrollment(glassesId);
  assert.equal(enrollment.platform, EVEN_G2_PLATFORM);
  assert.equal(enrollment.enrolledVia, macId, "main records which paired computer requested the code");
  assert.equal(mac.nodeRegistry.isEnrolled(glassesId), false, "nothing is enrolled on the Mac");

  assert.equal((await glassesExchange(main, issued.code, randomUUID(), "h".repeat(43))).status, 401,
    "the code is single-use");
  assert.equal(logs.some((line) => line.includes(issued.code)), false, "the code never reaches logs");

  await mac.close();
  const heartbeat = await fetch(`${main.url}/nodes/heartbeat`, {
    method: "POST",
    headers: { authorization: `Bearer ${glassesToken}`, "x-openagi-node-id": glassesId,
      "content-type": "application/json", origin: "null" },
    body: JSON.stringify({ nodeId: glassesId, role: "node" })
  });
  assert.equal(heartbeat.status, 200, "glasses keep talking to main with the Mac gone");
  const roster = main.nodeRegistry.list().find((entry) => entry.nodeId === glassesId);
  assert.equal(roster.status, "online");
});

test("main refuses G2 codes to a paired computer without the owner's grant, and to other credentials", async (t) => {
  const { main, mac, macId } = await headlessMainWithMac(t, { ownerProxy: false });
  const refused = await requestCodeOnMac(mac);
  assert.equal(refused.status, 403);
  const body = await refused.json();
  assert.equal(body.error, "main_not_authorized");
  assert.match(body.message, /has not authorized this computer/);
  assert.match(body.message, new RegExp(`openagi pair ${main.url.replace(/[.]/g, "\\.")}`));

  const direct = (headers) => fetch(`${main.url}/nodes/g2/enrollment-code`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}"
  });
  assert.equal((await direct({ authorization: `Bearer ${MAC_NODE_TOKEN}`, "x-openagi-node-id": macId })).status, 401,
    "node pairing alone is not permission");
  const phoneId = `mobile:${randomUUID()}`;
  const phoneToken = "p".repeat(43);
  main.nodeRegistry.enroll(phoneId, phoneToken, { platform: "mobile", name: "Phone" });
  assert.equal((await direct({ authorization: `Bearer ${phoneToken}`, "x-openagi-node-id": phoneId })).status, 401);
  assert.equal((await direct({})).status, 401);
  assert.equal((await direct({ authorization: `Bearer ${MAIN_OWNER}` })).status, 200, "the main owner may still issue directly");
});

test("a revoked Mac loses the grant; an offline main gives a clear error", async (t) => {
  const { main, mac, macId } = await headlessMainWithMac(t);
  assert.equal((await requestCodeOnMac(mac)).status, 200);
  const revoked = await fetch(`${main.url}/nodes/${encodeURIComponent(macId)}/revoke`, {
    method: "POST", headers: { authorization: `Bearer ${MAIN_OWNER}` }
  });
  assert.equal(revoked.status, 200);
  const afterRevoke = await requestCodeOnMac(mac);
  assert.equal(afterRevoke.status, 403);
  assert.equal((await afterRevoke.json()).error, "main_not_authorized");

  await main.close();
  const offline = await requestCodeOnMac(mac);
  assert.equal(offline.status, 502);
  const body = await offline.json();
  assert.equal(body.error, "main_offline");
  assert.match(body.message, /Couldn't reach your main at http:\/\/127\.0\.0\.1:\d+/);
  assert.match(body.message, /No code was created/);
});

test("main without an HTTPS public URL refuses to issue a card the glasses could not use", async (t) => {
  const main = await boot(t, { authToken: MAIN_OWNER });
  const response = await fetch(`${main.url}/nodes/g2/enrollment-code`, {
    method: "POST", headers: { authorization: `Bearer ${MAIN_OWNER}`, "content-type": "application/json" }, body: "{}"
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "main_public_url_required");
  const extra = await fetch(`${main.url}/nodes/g2/enrollment-code`, {
    method: "POST", headers: { authorization: `Bearer ${MAIN_OWNER}`, "content-type": "application/json" },
    body: JSON.stringify({ platform: "mobile" })
  });
  assert.equal(extra.status, 400, "the route is scoped to G2 and takes no platform");
});

test("the main keeps its local pairing page and does not log locally issued codes", async (t) => {
  const main = await boot(t, { authToken: MAIN_OWNER, publicUrl: PUBLIC_URL });
  const page = await (await fetch(`${main.url}/g2/connect`, { headers: { authorization: `Bearer ${MAIN_OWNER}` } })).text();
  assert.match(page, /Target main:<\/b> this computer/);
  assert.match(page, /fetch\('\/nodes\/enrollment-code'/);
  assert.match(page, /id="generate-native"/);
  const logs = captureLogs(t);
  const issued = await (await fetch(`${main.url}/nodes/enrollment-code`, {
    method: "POST", headers: { authorization: `Bearer ${MAIN_OWNER}`, "content-type": "application/json" },
    body: JSON.stringify({ platform: EVEN_G2_PLATFORM })
  })).json();
  assert.match(issued.code, /^\d{6}$/);
  assert.equal(logs.some((line) => line.includes(issued.code)), false);
});

test("delegated codes are short-lived and remember who asked", () => {
  const codes = new NodeEnrollmentCodes({ platforms: [EVEN_G2_PLATFORM] });
  const issued = codes.issue(EVEN_G2_PLATFORM, { now: 0, ttlMs: DELEGATED_ENROLLMENT_CODE_TTL_MS, issuedVia: "mac-1" });
  assert.equal(issued.expiresAt, new Date(DELEGATED_ENROLLMENT_CODE_TTL_MS).toISOString());
  assert.equal(codes.consume(issued.code, EVEN_G2_PLATFORM, { now: DELEGATED_ENROLLMENT_CODE_TTL_MS + 1 }).reason, "expired");
  const fresh = codes.issue(EVEN_G2_PLATFORM, { now: 0, ttlMs: DELEGATED_ENROLLMENT_CODE_TTL_MS, issuedVia: "mac-1" });
  assert.deepEqual(codes.consume(fresh.code, EVEN_G2_PLATFORM, { now: 1 }), { ok: true, platform: EVEN_G2_PLATFORM, issuedVia: "mac-1" });
  assert.equal(isMainDataRoute("POST", "/nodes/g2/enrollment-code"), true);
  assert.equal(isMainDataRoute("POST", "/nodes/enrollment-code"), false);
});
