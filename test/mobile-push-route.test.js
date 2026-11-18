// test/mobile-push-route.test.js
// POST/DELETE /mobile/push through the real hosted-interface gates: a paired
// phone stores its own push registration, nobody else can, and revoking the
// phone removes it.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDurableRuntime, createHostedInterface, IntegrationRegistry } from "../src/index.js";
import { isMobileRouteAllowed } from "../src/mobile-node.js";
import { openPushEnvelope } from "../src/mobile-push-envelope.js";

const OWNER = "fixture-owner-token";
const KEY = crypto.randomBytes(32).toString("base64url");
const REGISTRATION = { pass: "p1.nonce.ciphertext", key: KEY, env: "sandbox" };

async function boot(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobile-push-"));
  const state = {
    snapshot: { threads: [{ key: "codex:a", title: "Fix login", watch: { group: "working", since: null, waitingOn: null } }] },
    questions: []
  };
  const fleet = { start() {}, stop() {}, getState: () => structuredClone(state) };
  const runtime = createDurableRuntime({
    dataDir, registerDefaults: false, integrations: false, skills: false, autoConnectMcp: false,
    fleetSupervisor: fleet
  });
  runtime.integrations = new IntegrationRegistry();
  const relayed = [];
  let relayReply = () => ({ status: 200, body: { ok: true, apnsId: "a" } });
  const pushFetch = async (url, init) => {
    relayed.push({ url, ...JSON.parse(init.body) });
    const { status, body } = relayReply();
    return { ok: status < 300, status, json: async () => body };
  };
  const app = createHostedInterface(runtime, { dataDir, host: "127.0.0.1", port: 0, authToken: OWNER, tickerMs: 0, nodeControlEnabled: false, pushFetch });
  t.after(async () => {
    await app.close();
    runtime.observations?.db?.close();
    runtime.vectorStore?.db?.close();
    runtime.sessionIndex?.db?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const { url } = await app.listen();

  const pair = async (platform = "mobile") => {
    const issued = await fetch(`${url}/nodes/enrollment-code`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${OWNER}` },
      body: JSON.stringify({ platform })
    });
    assert.equal(issued.status, 200);
    const { code } = await issued.json();
    const nodeId = `${platform}:${crypto.randomUUID()}`;
    const nodeToken = crypto.randomBytes(32).toString("base64url");
    const exchanged = await fetch(`${url}/nodes/enroll/exchange`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, platform, nodeId, nodeToken, name: "Phone" })
    });
    assert.equal(exchanged.status, 200);
    const call = (route, { method = "GET", body, token = nodeToken } = {}) => fetch(url + route, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-openagi-node-id": nodeId },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) })
    });
    return { nodeId, call };
  };
  const pushFile = path.join(dataDir, "nodes", "push.json");
  const records = () => (fs.existsSync(pushFile) ? JSON.parse(fs.readFileSync(pushFile, "utf8")).registrations : []);
  return { url, pair, records, pushFile, relayed, runtime, setRelayReply: (fn) => { relayReply = fn; } };
}

test("the push routes are on the phone allowlist, other methods are not", () => {
  assert.equal(isMobileRouteAllowed("POST", "/mobile/push"), true);
  assert.equal(isMobileRouteAllowed("DELETE", "/mobile/push"), true);
  assert.equal(isMobileRouteAllowed("GET", "/mobile/push"), false);
  assert.equal(isMobileRouteAllowed("PUT", "/mobile/push"), false);
  assert.equal(isMobileRouteAllowed("POST", "/mobile/push/x"), false);
});

test("a paired phone stores, replaces and deletes its own registration (0600)", async (t) => {
  const { pair, records, pushFile } = await boot(t);
  const phone = await pair();
  const res = await phone.call("/mobile/push", { method: "POST", body: REGISTRATION });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, renew: false });
  assert.equal(fs.statSync(pushFile).mode & 0o777, 0o600);
  let saved = records();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].nodeId, phone.nodeId);
  assert.equal(saved[0].pass, REGISTRATION.pass);
  assert.equal(saved[0].key, KEY);
  assert.equal(saved[0].env, "sandbox");
  assert.ok(Date.parse(saved[0].updatedAt));

  const replaced = await phone.call("/mobile/push", { method: "POST", body: { ...REGISTRATION, pass: "p1.second", env: "production" } });
  assert.equal(replaced.status, 200);
  saved = records();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].pass, "p1.second");
  assert.equal(saved[0].env, "production");

  assert.equal(saved[0].activities, true);
  const alertsOnly = await phone.call("/mobile/push", { method: "POST", body: { ...REGISTRATION, pass: "p1.second", env: "production", activities: false } });
  assert.equal(alertsOnly.status, 200);
  assert.equal(records()[0].activities, false);
  assert.equal(records()[0].alerts, true);
  await phone.call("/mobile/push", { method: "POST", body: { ...REGISTRATION, pass: "p1.second", env: "production", activities: false, alerts: false } });
  assert.equal(records()[0].alerts, false);

  const other = await pair();
  await other.call("/mobile/push", { method: "POST", body: REGISTRATION });
  assert.equal(records().length, 2);

  const deleted = await phone.call("/mobile/push", { method: "DELETE" });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { ok: true });
  assert.deepEqual(records().map((r) => r.nodeId), [other.nodeId]);
});

test("bad bodies are refused with 400 and nothing is stored", async (t) => {
  const { pair, records } = await boot(t);
  const phone = await pair();
  const bad = [
    { ...REGISTRATION, pass: "p2.nope" },
    { ...REGISTRATION, pass: `p1.${"x".repeat(2000)}` },
    { ...REGISTRATION, pass: 7 },
    { ...REGISTRATION, key: crypto.randomBytes(31).toString("base64url") },
    { ...REGISTRATION, key: crypto.randomBytes(32).toString("base64") },
    { ...REGISTRATION, key: undefined },
    { ...REGISTRATION, env: "staging" },
    { ...REGISTRATION, activities: "no" },
    { ...REGISTRATION, alerts: 1 },
    [],
    "not json"
  ];
  for (const body of bad) {
    const res = await phone.call("/mobile/push", { method: "POST", body });
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
  }
  const tooBig = await phone.call("/mobile/push", { method: "POST", body: { ...REGISTRATION, junk: "x".repeat(8000) } });
  assert.equal(tooBig.status, 400);
  assert.deepEqual(records(), []);
});

test("only an authenticated phone may register: not the owner, not a wrong token, not a G2", async (t) => {
  const { url, pair, records } = await boot(t);
  const owner = await fetch(`${url}/mobile/push`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OWNER}` },
    body: JSON.stringify(REGISTRATION)
  });
  assert.equal(owner.status, 403);
  const anonymous = await fetch(`${url}/mobile/push`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(REGISTRATION) });
  assert.equal(anonymous.status, 401);
  const phone = await pair();
  const wrong = await phone.call("/mobile/push", { method: "POST", body: REGISTRATION, token: crypto.randomBytes(32).toString("base64url") });
  assert.equal(wrong.status, 401);
  const g2 = await pair("even_g2");
  const fromG2 = await g2.call("/mobile/push", { method: "POST", body: REGISTRATION });
  assert.ok([401, 403].includes(fromG2.status), `G2 got ${fromG2.status}`);
  assert.deepEqual(records(), []);
});

test("revoking the phone, by itself or by the owner, removes its registration", async (t) => {
  const { url, pair, records } = await boot(t);
  const self = await pair();
  const byOwner = await pair();
  await self.call("/mobile/push", { method: "POST", body: REGISTRATION });
  await byOwner.call("/mobile/push", { method: "POST", body: REGISTRATION });
  assert.equal(records().length, 2);

  const revoked = await self.call("/nodes/revoke", { method: "POST", body: { nodeId: self.nodeId } });
  assert.equal(revoked.status, 200);
  assert.deepEqual(records().map((r) => r.nodeId), [byOwner.nodeId]);

  const ownerRevoke = await fetch(`${url}/nodes/${encodeURIComponent(byOwner.nodeId)}/revoke`, {
    method: "POST", headers: { authorization: `Bearer ${OWNER}` }
  });
  assert.equal(ownerRevoke.status, 200);
  assert.deepEqual(records(), []);
});

test("a registration with an active fleet starts a sealed Live Activity at the relay", async (t) => {
  const { pair, relayed } = await boot(t);
  const phone = await pair();
  await phone.call("/mobile/push", { method: "POST", body: REGISTRATION });
  // The registration schedules one debounced pass.
  for (let i = 0; i < 40 && !relayed.length; i += 1) await new Promise((r) => setTimeout(r, 100));
  assert.equal(relayed.length, 1);
  assert.equal(relayed[0].type, "activity-start");
  assert.equal(relayed[0].pass, REGISTRATION.pass);
  assert.match(relayed[0].url, /\/v1\/send$/);
  const activity = JSON.parse(openPushEnvelope(KEY, "activity", relayed[0].sealed));
  assert.deepEqual(activity.counts, { you: 0, working: 1, waiting: 0, blocked: 0 });
  assert.equal(activity.rows[0].title, "Fix login");
});

test("a pass the relay refused is answered renew: true until the phone brings a new one", async (t) => {
  const { pair, relayed, records, setRelayReply } = await boot(t);
  setRelayReply(() => ({ status: 400, body: { ok: false, error: "pass_expired" } }));
  const phone = await pair();
  await phone.call("/mobile/push", { method: "POST", body: REGISTRATION });
  for (let i = 0; i < 40 && !records()[0]?.renew; i += 1) await new Promise((r) => setTimeout(r, 100));
  assert.equal(relayed.length, 1);
  assert.equal(records()[0].renew, true);
  const again = await phone.call("/mobile/push", { method: "POST", body: REGISTRATION });
  assert.deepEqual(await again.json(), { ok: true, renew: true });
  const fresh = await phone.call("/mobile/push", { method: "POST", body: { ...REGISTRATION, pass: "p1.renewed" } });
  assert.deepEqual(await fresh.json(), { ok: true, renew: false });
  assert.equal(records()[0].renew, false);
});

test("an owner revoke ends the phone's Live Activity before dropping its registration", async (t) => {
  const { url, pair, relayed, records } = await boot(t);
  const phone = await pair();
  await phone.call("/mobile/push", { method: "POST", body: REGISTRATION });
  for (let i = 0; i < 40 && !relayed.length; i += 1) await new Promise((r) => setTimeout(r, 100));
  assert.equal(relayed[0].type, "activity-start");
  const revoked = await fetch(`${url}/nodes/${encodeURIComponent(phone.nodeId)}/revoke`, {
    method: "POST", headers: { authorization: `Bearer ${OWNER}` }
  });
  assert.equal(revoked.status, 200);
  for (let i = 0; i < 40 && relayed.length < 2; i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.equal(relayed[1].type, "activity-end");
  assert.equal(relayed[1].pass, REGISTRATION.pass);
  assert.deepEqual(records(), []);
});
