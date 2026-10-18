import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { _resetDataDirCache } from "../src/data-dir.js";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";
import { isMobileRouteAllowed } from "../src/mobile-node.js";

const ENV_KEYS = ["OPENAGI_DATA_DIR", "OPENAGI_PROVIDER", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_MODEL", "OPENAI_MODEL", "OPENAGI_PROFILE"];

async function withApp(t) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-ws-"));
  process.env.OPENAGI_DATA_DIR = dir;
  _resetDataDirCache();
  const runtime = createDurableRuntime({ dataDir: dir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, tickerMs: 0, dataDir: dir, authToken: "owner" });
  const listened = await app.listen();
  t.after(async () => {
    await app.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    _resetDataDirCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  const call = async (method, route, body) => {
    const res = await fetch(base + route, {
      method,
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { dir, runtime, call };
}

test("model settings: keys are saved to .env, applied live, and never returned", async (t) => {
  const { dir, runtime, call } = await withApp(t);
  const before = await call("GET", "/settings/models");
  assert.equal(before.status, 200);
  assert.equal(before.body.providers.anthropic.configured, false);

  const saved = await call("POST", "/settings/models", { anthropicKey: "sk-ant-test-123", preference: "anthropic", anthropicModel: "claude-test" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.providers.anthropic.configured, true);
  assert.equal(saved.body.preference, "anthropic");
  assert.equal(saved.body.active.provider, "anthropic");
  assert.equal(saved.body.active.model, "claude-test");
  assert.doesNotMatch(JSON.stringify(saved.body), /sk-ant-test-123/);
  assert.match(fs.readFileSync(path.join(dir, ".env"), "utf8"), /ANTHROPIC_API_KEY=sk-ant-test-123/);
  assert.equal(runtime.agentHost.modelProvider.constructor.name, "AnthropicProvider");

  const cleared = await call("POST", "/settings/models", { clear: ["anthropicKey"], preference: "auto" });
  assert.equal(cleared.body.providers.anthropic.configured, false);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, ".env"), "utf8"), /ANTHROPIC_API_KEY/);

  assert.equal((await call("POST", "/settings/models", { preference: "gemini" })).status, 400);
  // The on-device model only exists inside the phone app.
  assert.equal((await call("POST", "/settings/models", { preference: "on-device" })).status, 400);
  assert.equal((await call("POST", "/settings/models", { openaiKey: "has space" })).status, 400);
});

test("workspace: persona read and replace", async (t) => {
  const { call } = await withApp(t);
  const put = await call("PUT", "/workspace/persona", { markdown: "# Pip\n\nName: Pip\n\nKeep answers short." });
  assert.equal(put.status, 200);
  assert.equal(put.body.name, "Pip");
  const got = await call("GET", "/workspace/persona");
  assert.match(got.body.markdown, /Keep answers short/);
  assert.equal(got.body.name, "Pip");
  assert.equal((await call("PUT", "/workspace/persona", { markdown: "  " })).status, 400);
});

test("workspace: skills create, read, edit, delete; built-ins are read-only", async (t) => {
  const { dir, call } = await withApp(t);
  const created = await call("PUT", "/workspace/skills/grocery-list", { description: "Build a grocery list", instructions: "List what to buy for: {{input}}" });
  assert.equal(created.status, 200);
  assert.equal(created.body.editable, true);
  assert.ok(fs.existsSync(path.join(dir, "skills", "grocery-list", "SKILL.md")));

  const list = await call("GET", "/workspace/skills");
  assert.ok(list.body.skills.some((skill) => skill.name === "grocery-list" && skill.editable));

  const edited = await call("PUT", "/workspace/skills/grocery-list", { description: "Groceries", instructions: "New body" });
  assert.equal(edited.body.description, "Groceries");
  assert.equal((await call("GET", "/workspace/skills/grocery-list")).body.instructions, "New body");

  const builtIn = list.body.skills.find((skill) => !skill.editable);
  if (builtIn) {
    assert.equal((await call("PUT", `/workspace/skills/${builtIn.name}`, { instructions: "x" })).status, 409);
    assert.equal((await call("DELETE", `/workspace/skills/${builtIn.name}`)).status, 409);
  }
  assert.equal((await call("PUT", "/workspace/skills/grocery-list", { instructions: "" })).status, 400);
  assert.equal((await call("DELETE", "/workspace/skills/grocery-list")).status, 200);
  assert.equal((await call("GET", "/workspace/skills/grocery-list")).status, 404);
});

test("workspace: scheduled jobs list and toggle", async (t) => {
  const { call } = await withApp(t);
  const jobs = await call("GET", "/workspace/jobs");
  const job = jobs.body.jobs.find((entry) => entry.id === "daily-plan-morning");
  assert.ok(job);
  const off = await call("POST", "/workspace/jobs/daily-plan-morning", { enabled: false });
  assert.deepEqual(off.body, { id: "daily-plan-morning", enabled: false });
  // Turning it back on schedules the next run; it must not fire right away.
  const on = await call("POST", "/workspace/jobs/daily-plan-morning", { enabled: true });
  assert.equal(on.body.enabled, true);
  const rescheduled = (await call("GET", "/workspace/jobs")).body.jobs.find((entry) => entry.id === "daily-plan-morning");
  assert.ok(new Date(rescheduled.nextRunAt).getTime() > Date.now());
  await call("POST", "/workspace/jobs/daily-plan-morning", { enabled: false });
  assert.equal((await call("GET", "/workspace/jobs")).body.jobs.find((entry) => entry.id === "daily-plan-morning").enabled, false);
  assert.equal((await call("POST", "/workspace/jobs/nope", { enabled: true })).status, 404);
  assert.equal((await call("POST", "/workspace/jobs/daily-plan-morning", {})).status, 400);
});

test("a phone node may reach the workspace and model settings routes, nothing broader", () => {
  for (const [method, route] of [
    ["GET", "/settings/models"], ["POST", "/settings/models"], ["POST", "/settings/models/test"],
    ["GET", "/workspace/persona"], ["PUT", "/workspace/persona"], ["GET", "/workspace/skills"],
    ["GET", "/workspace/skills/grocery-list"], ["PUT", "/workspace/skills/grocery-list"], ["DELETE", "/workspace/skills/grocery-list"],
    ["GET", "/workspace/jobs"], ["POST", "/workspace/jobs/daily-plan-morning"]
  ]) assert.equal(isMobileRouteAllowed(method, route), true, `${method} ${route}`);
  for (const [method, route] of [
    ["POST", "/setup/save"], ["POST", "/admin/provider"], ["PUT", "/workspace/skills/../etc"],
    ["PUT", "/workspace/skills/UPPER"], ["DELETE", "/workspace/jobs/x"], ["POST", "/cron"]
  ]) assert.equal(isMobileRouteAllowed(method, route), false, `${method} ${route}`);
});

test("offline copy over HTTP: Mac snapshot imports on the phone; offline work flows back once", async (t) => {
  const mac = await withApp(t);
  await mac.call("PUT", "/workspace/persona", { markdown: "# Pip\n\nName: Pip" });
  const snapshot = await mac.call("GET", "/mobile/mirror");
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.version, 1);

  const phone = await withApp(t);
  const imported = await phone.call("POST", "/mirror/import", snapshot.body);
  assert.equal(imported.status, 200);
  assert.match((await phone.call("GET", "/workspace/persona")).body.markdown, /Pip/);

  const offline = await phone.call("GET", "/mirror/offline");
  assert.equal(offline.status, 200);
  const sent = await mac.call("POST", "/mobile/offline-import", offline.body);
  assert.equal(sent.status, 200);
  assert.equal((await phone.call("POST", "/mirror/offline/sent", offline.body)).status, 200);

  assert.equal((await phone.call("POST", "/mirror/import", { version: 99 })).status, 400);
});

test("phone node: offline copy and ChatGPT routes allowed; phone-side import stays owner-only", () => {
  for (const [method, route] of [["GET", "/mobile/mirror"], ["POST", "/mobile/offline-import"], ["POST", "/auth/chatgpt/start"], ["GET", "/auth/chatgpt/status"], ["POST", "/auth/chatgpt/signout"]]) {
    assert.equal(isMobileRouteAllowed(method, route), true, `${method} ${route}`);
  }
  for (const [method, route] of [["POST", "/mirror/import"], ["GET", "/mirror/offline"], ["POST", "/mirror/offline/sent"]]) {
    assert.equal(isMobileRouteAllowed(method, route), false, `${method} ${route}`);
  }
});
