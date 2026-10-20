import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { renderWizard } from "../src/setup-wizard.js";
import { createDefaultRuntime, createHostedInterface } from "../src/index.js";
import { LocalModelProvider } from "../src/local-model-provider.js";
import { _resetDataDirCache } from "../src/data-dir.js";
import { createServer } from "node:http";

test("short setup has three steps, one provider at a time, and preserves secrets", () => {
  const html = renderWizard({ existingEnv: { OPENAGI_AUTH_TOKEN: "same-token", OPENAI_API_KEY: "secret-not-rendered", OPENAGI_PROVIDER: "openai" } });
  assert.equal((html.match(/<section data-step=/g) ?? []).length, 3);
  assert.match(html, /value="openai" checked/);
  assert.match(html, /name="OPENAGI_AUTH_TOKEN"[^>]*value="same-token"/);
  assert.match(html, /Saved key/);
  assert.doesNotMatch(html, /secret-not-rendered/);
  assert.match(html, /data-provider="local" disabled hidden/);
  assert.match(html, /data-provider="on-device" disabled hidden/);
  assert.doesNotThrow(() => new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]));
});

test("saved model labels cannot escape setup markup", () => {
  const html = renderWizard({ existingEnv: { OPENAGI_LOCAL_MODEL: '\"><script>bad()</script>', OPENAGI_AUTH_TOKEN: "owner" } });
  assert.doesNotMatch(html, /<script>bad/);
});

async function appFor(t, provider) {
  const keys = ["OPENAGI_DATA_DIR", "OPENAGI_AUTH_TOKEN", "OPENAGI_PROVIDER", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENAGI_LOCAL_MODEL", "OPENAGI_LOCAL_BASE_URL", "OPENAGI_LOCAL_API_KEY"];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-model-setup-"));
  process.env.OPENAGI_DATA_DIR = dir;
  _resetDataDirCache();
  const runtime = createDefaultRuntime({ modelProvider: provider });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, tickerMs: 0, dataDir: dir });
  const address = await app.listen();
  t.after(async () => {
    await app.close();
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    _resetDataDirCache(); fs.rmSync(dir, { recursive: true, force: true });
  });
  const post = async (route, body) => {
    const response = await fetch(address.url + route, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer owner" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { runtime, post, dir, url: address.url };
}

test("configured local loopback models open the dashboard without repeating setup", async t => {
  const { url } = await appFor(t, new LocalModelProvider({ model: "fixture" }));
  process.env.OPENAGI_LOCAL_MODEL = "fixture";
  for (const preference of ["local", "auto"]) {
    process.env.OPENAGI_PROVIDER = preference;
    assert.equal((await (await fetch(url + "/health")).json()).firstRun, false);
    const page = await fetch(url + "/", { redirect: "manual" });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="appNavigation"/);
  }
  process.env.OPENAGI_LOCAL_MODEL = "   ";
  assert.equal((await (await fetch(url + "/health")).json()).firstRun, true);
  const page = await fetch(url + "/", { redirect: "manual" });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get("location"), "/setup");
});

test("the saved-provider menu cannot disconnect an Apple Intelligence-only setup", async t => {
  const { url } = await appFor(t);
  process.env.OPENAGI_AUTH_TOKEN = "owner";
  const response = await fetch(url + "/", { headers: { authorization: "Bearer owner" } });
  assert.equal(response.status, 200);
  const html = await response.text();
  const source = html.match(/function renderProviderSwitch\(provider\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(source, "run the provider menu shipped in the dashboard");
  const host = {}, select = {};
  const context = vm.createContext({
    $: id => id === "providerSwitch" ? host : select,
    document: { activeElement: null }, escapeHtml: value => String(value)
  });
  vm.runInContext(source, context);
  context.renderProviderSwitch({ preference: "on-device", model: "Apple Intelligence", available: {} });
  assert.match(host.innerHTML, /<option value="auto" disabled>/);
  assert.match(host.innerHTML, /<option value="on-device" selected>/);
  context.renderProviderSwitch({ preference: "on-device", available: { anthropic: true } });
  assert.match(host.innerHTML, /<option value="auto">/);
  context.renderProviderSwitch({ preference: "local", available: {} });
  assert.match(host.innerHTML, /<option value="auto">/, "local-only Automatic remains available");
});

test("empty credentials and deterministic fallback are rejected before onboarding success", async t => {
  const { post, dir } = await appFor(t);
  assert.equal((await post("/setup/save", { setupModel: true, OPENAGI_PROVIDER: "anthropic", OPENAGI_AUTH_TOKEN: "owner" })).status, 400);
  assert.equal(fs.existsSync(path.join(dir, ".env")), false);
  const test = await post("/setup/test", {});
  assert.equal(test.status, 400);
  assert.equal(test.body.ok, false);
});

test("model verification uses inference alone without agent sessions or tools", async t => {
  let request;
  const provider = new LocalModelProvider({ model: "fixture" });
  provider.generate = async input => { request = input; return { text: "Hello", model: "fixture", provider: "local" }; };
  const { post, runtime } = await appFor(t, provider);
  const result = await post("/setup/test", {});
  assert.equal(result.status, 200);
  assert.equal(result.body.model, "fixture");
  assert.equal(request.toolRegistry, undefined);
  assert.deepEqual(request.tools, []);
  assert.equal(runtime.agentHost.store.listSessions().length, 0);
});

test("a failed provider stays recoverable and cannot report success", async t => {
  const provider = new LocalModelProvider({ model: "fixture" });
  provider.generate = async () => { throw new Error("private provider diagnostics"); };
  const { post } = await appFor(t, provider);
  const result = await post("/setup/test", {});
  assert.equal(result.status, 400);
  assert.equal(result.body.ok, false);
  assert.doesNotMatch(JSON.stringify(result.body), /private provider diagnostics/);
});

test("candidate verification preserves the working model, credentials and dashboard login until save", async t => {
  const working = new LocalModelProvider({ model: "working" });
  const { post, runtime, dir } = await appFor(t, working);
  process.env.OPENAGI_PROVIDER = "local";
  process.env.OPENAGI_LOCAL_MODEL = "working";
  const saved = "OPENAGI_PROVIDER=local\nOPENAGI_LOCAL_MODEL=working\n";
  fs.writeFileSync(path.join(dir, ".env"), saved);
  const fixture = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      const fails = JSON.parse(body).model === "broken";
      res.writeHead(fails ? 503 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(fails ? { error: "fixture unavailable" } : { choices: [{ message: { content: "Hello" } }] }));
    });
  });
  await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => fixture.close(resolve)));
  const candidate = { setupModel: true, OPENAGI_PROVIDER: "local", OPENAGI_LOCAL_MODEL: "broken",
    OPENAGI_LOCAL_BASE_URL: `http://127.0.0.1:${fixture.address().port}/v1`, OPENAGI_AUTH_TOKEN: "owner" };
  assert.equal((await post("/setup/test", candidate)).status, 400);
  assert.equal(runtime.agentHost.modelProvider, working);
  assert.equal(process.env.OPENAGI_LOCAL_MODEL, "working");
  assert.equal(process.env.OPENAGI_AUTH_TOKEN, undefined);
  assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), saved);
  candidate.OPENAGI_LOCAL_MODEL = "candidate";
  const verified = await post("/setup/test", candidate);
  assert.equal(verified.status, 200);
  assert.equal(verified.body.model, "candidate");
  assert.equal(runtime.agentHost.modelProvider, working, "verification alone must not activate the model");
  assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), saved);
  assert.equal((await post("/setup/save", candidate)).status, 200);
  assert.equal(runtime.agentHost.modelProvider.model, "candidate");
  assert.equal(process.env.OPENAGI_AUTH_TOKEN, "owner");
  assert.equal(runtime.agentHost.store.listSessions().length, 0);
});
