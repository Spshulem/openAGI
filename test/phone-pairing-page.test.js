import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderPhonePairingPage, mainPhonePairingUrl } from "../src/phone-pairing-page.js";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { writeNodeConfig } from "../src/cli-client.js";
import { isPublicRoute } from "../src/auth.js";

test("worker handoff strips credentials and opens main's phone page", () => {
  assert.equal(mainPhonePairingUrl("https://owner:secret@main.example/?token=private#old"), "https://main.example/phone-pairing");
  assert.equal(mainPhonePairingUrl("javascript:alert(1)"), null);
  const html = renderPhonePairingPage({ remote: "https://main.example/?token=private" });
  assert.match(html, /href="https:\/\/main.example\/phone-pairing"/);
  assert.match(html, /Older dashboards do not show phone pairing/);
  assert.doesNotMatch(html, /private|id="generate"|<script>/);
});

test("pairing page requires owner auth; a worker never issues a main code", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-phone-page-"));
  const runtime = createDurableRuntime({ dataDir, registerDefaults: false, integrations: false, skills: false, autoConnectMcp: false });
  const app = createHostedInterface(runtime, { dataDir, host: "127.0.0.1", port: 0, tickerMs: 0, authToken: "test-owner", nodeControlEnabled: false });
  const { url } = await app.listen();
  t.after(async () => { await app.close(); runtime.observations?.db?.close(); runtime.vectorStore?.db?.close(); runtime.sessionIndex?.db?.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  assert.equal(isPublicRoute("/phone-pairing"), false);
  assert.equal((await fetch(url + "/phone-pairing")).status, 401);
  const headers = { cookie: "openagi_token=test-owner", accept: "text/html" };
  const page = await fetch(url + "/phone-pairing", { headers });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(await page.text(), /id="generate"/);
  writeNodeConfig({ remote: "https://main.example", token: null }, dataDir);
  const workerPage = await fetch(url + "/phone-pairing", { headers });
  assert.match(await workerPage.text(), /Open phone pairing on main/);
  const denied = await fetch(url + "/nodes/enrollment-code", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ platform: "mobile" }) });
  assert.equal(denied.status, 409);
});

function browser({ response, now = 0 } = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { textContent: "", hidden: true, disabled: false, handlers: {}, addEventListener(event, fn) { this.handlers[event] = fn; } });
    return elements.get(id);
  };
  let request, tick, time = now;
  const context = { document: { getElementById: element }, URL, Date: class extends Date { static now() { return time; } }, location: { origin: "http://main.example" }, navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (url, options) => { request = { url, ...options }; return response; },
    setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => {} };
  const script = renderPhonePairingPage().match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, context);
  return { element, request: () => request, expire: () => { time = 2000; tick(); } };
}

test("explicit click creates a code with the owner session, displays address, and removes expired code", async () => {
  const b = browser({ response: { ok: true, json: async () => ({ code: "123456", publicUrl: "https://main.example", expiresAt: new Date(1000).toISOString() }) } });
  assert.equal(b.request(), undefined, "opening the page must not issue codes");
  await b.element("generate").handlers.click();
  assert.equal(b.request().url, "/nodes/enrollment-code");
  assert.equal(b.request().credentials, "same-origin");
  assert.equal(JSON.parse(b.request().body).platform, "mobile");
  assert.equal(b.element("code").textContent, "123456");
  assert.equal(b.element("server").value, "https://main.example");
  assert.equal(b.element("pairing").hidden, false);
  b.expire();
  assert.equal(b.element("pairing").hidden, true);
  assert.equal(b.element("code").textContent, "");
  assert.match(b.element("status").textContent, /expired/);
});

test("expired session and unreachable loopback are visible and allow retry", async () => {
  for (const [response, message] of [
    [{ ok: false, status: 401, json: async () => ({}) }, /session expired/],
    [{ ok: true, json: async () => ({ code: "123456", publicUrl: "http://127.0.0.1:43210", expiresAt: new Date(1000).toISOString() }) }, /cannot reach/]
  ]) {
    const b = browser({ response });
    await b.element("generate").handlers.click();
    assert.match(b.element("status").textContent, message);
    assert.equal(b.element("generate").disabled, false);
    assert.equal(b.element("pairing").hidden, true);
  }
});
