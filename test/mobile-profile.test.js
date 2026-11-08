import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { spawn } from "node:child_process";
import { _resetDataDirCache } from "../src/data-dir.js";
import { createDurableRuntime, createHostedInterface, McpRegistry } from "../src/index.js";
import {
  MOBILE_DISABLED_CRON_JOBS,
  MOBILE_MODEL_TOOLS,
  installMobileSpawnGuard,
  isMobileProfile,
  mobileDisabledCronJobs,
  mobileRefusedUpgrades
} from "../src/mobile-profile.js";

const FIXED_DISABLED = [
  "inbox-sweep", "imessage-extract", "task-activity-scan", "hourly-pattern-mine",
  "nightly-pattern-mine", "ambient-digest", "proactive-observer", "weekly-project-scan",
  "observation-retention", "self-update"
];
const INTEGRATION_JOBS = ["linear-task-sync", "buildbetter-task-sync"];
const ENV_KEYS = ["OPENAGI_PROFILE", "OPENAGI_DATA_DIR", "LINEAR_API_KEY", "BUILDBETTER_API_KEY", "OPENAGI_COMPUTER_USE", "IMESSAGE_ENABLED"];

async function withEnv(values, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  _resetDataDirCache();
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetDataDirCache();
  }
}

// Runtimes open their stores asynchronously, so every temp dir lives until the
// file is done rather than being removed while a store is still opening.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mobile-"));
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
function tempDir(label) {
  return fs.mkdtempSync(path.join(tempRoot, `${label}-`));
}

function jobIds(env) {
  const dir = tempDir("cron");
  return withEnv({ ...env, OPENAGI_DATA_DIR: dir }, () => {
    const runtime = createDurableRuntime({ dataDir: dir });
    return new Set(runtime.cron.listJobs().map((job) => job.id));
  });
}

async function withApp(env, fn) {
  const dir = tempDir("http");
  return withEnv({ ...env, OPENAGI_DATA_DIR: dir }, async () => {
    const runtime = createDurableRuntime({ dataDir: dir });
    const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, tickerMs: 0, dataDir: dir, authToken: null });
    try {
      const listened = await app.listen();
      const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
      return await fn(base, runtime);
    } finally {
      await app.close();
    }
  });
}

test("isMobileProfile matches OPENAGI_PROFILE=mobile, trimmed and case-insensitive", () => {
  assert.equal(isMobileProfile({ OPENAGI_PROFILE: "mobile" }), true);
  assert.equal(isMobileProfile({ OPENAGI_PROFILE: "  MoBiLe " }), true);
  assert.equal(isMobileProfile({ OPENAGI_PROFILE: "desktop" }), false);
  assert.equal(isMobileProfile({}), false);
});

test("disabled job set: fixed list, plus integration jobs until their keys are set", () => {
  assert.deepEqual([...MOBILE_DISABLED_CRON_JOBS].sort(), [...FIXED_DISABLED].sort());
  assert.throws(() => MOBILE_DISABLED_CRON_JOBS.add("daily-plan-morning"), TypeError);
  assert.deepEqual([...mobileDisabledCronJobs({})].sort(), [...FIXED_DISABLED, ...INTEGRATION_JOBS].sort());
  assert.deepEqual([...mobileDisabledCronJobs({ LINEAR_API_KEY: "lin_x", BUILDBETTER_API_KEY: "bb_x" })].sort(), [...FIXED_DISABLED].sort());
  assert.deepEqual(MOBILE_MODEL_TOOLS, ["remember", "recall", "add_task", "list_tasks", "complete_task", "move_task", "schedule_message"]);
  assert.ok(Object.isFrozen(MOBILE_MODEL_TOOLS));
});

test("mobile tools are real core tool names", async () => {
  const dir = tempDir("tools");
  await withEnv({ OPENAGI_DATA_DIR: dir }, () => {
    const runtime = createDurableRuntime({ dataDir: dir });
    for (const name of MOBILE_MODEL_TOOLS) assert.ok(runtime.tools.has(name), `missing tool ${name}`);
  });
});

test("desktop profile registers every default job, including the ones mobile drops", async () => {
  const desktop = await jobIds({});
  for (const id of [...FIXED_DISABLED, ...INTEGRATION_JOBS]) assert.ok(desktop.has(id), `desktop lost ${id}`);
});

test("mobile profile drops exactly the listed jobs and keeps the rest", async () => {
  const desktop = await jobIds({});
  const mobile = await jobIds({ OPENAGI_PROFILE: "mobile" });
  const dropped = [...desktop].filter((id) => !mobile.has(id)).sort();
  assert.deepEqual(dropped, [...FIXED_DISABLED, ...INTEGRATION_JOBS].sort());
  for (const id of ["daily-plan-morning", "daily-recap-evening", "task-reminders", "daily-task-digest", "daily-memory-condense"]) {
    assert.ok(mobile.has(id), `mobile lost ${id}`);
  }
  assert.ok([...mobile].every((id) => desktop.has(id)), "mobile added jobs desktop does not have");
});

test("mobile profile keeps integration sync jobs once their keys are configured", async () => {
  const mobile = await jobIds({ OPENAGI_PROFILE: "mobile", LINEAR_API_KEY: "lin_x", BUILDBETTER_API_KEY: "bb_x" });
  for (const id of INTEGRATION_JOBS) assert.ok(mobile.has(id), `missing ${id}`);
  for (const id of FIXED_DISABLED) assert.ok(!mobile.has(id), `kept ${id}`);
});

test("mobile profile turns off a persisted copy of a dropped job", async () => {
  const dir = tempDir("persisted");
  await withEnv({ OPENAGI_DATA_DIR: dir }, () => { createDurableRuntime({ dataDir: dir }); });
  await withEnv({ OPENAGI_DATA_DIR: dir, OPENAGI_PROFILE: "mobile" }, () => {
    const runtime = createDurableRuntime({ dataDir: dir });
    const job = runtime.cron.listJobs().find((row) => row.id === "proactive-observer");
    assert.equal(job?.enabled, false);
    assert.equal(runtime.cron.listJobs().find((row) => row.id === "daily-plan-morning")?.enabled, true);
    // The filter is gone after construction: user schedules still register.
    assert.equal(runtime.cron.addJob({ id: "proactive-observer-user", task: "prompt", intervalMs: 600_000 }).id, "proactive-observer-user");
  });
});

test("computer-use and coding routes are refused under mobile, served on desktop", async () => {
  await withApp({ OPENAGI_PROFILE: "mobile" }, async (base) => {
    for (const [method, route] of [["GET", "/computer-use/log"], ["POST", "/computer-use/toggle"], ["GET", "/coding-agents"], ["POST", "/control/update"]]) {
      const res = await fetch(`${base}${route}`, {
        method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined
      });
      assert.equal(res.status, 409, `${method} ${route}`);
      const body = await res.json();
      assert.equal(body.error, "not_available_on_phone");
      assert.match(body.message, /not available on phone/);
    }
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });
  await withApp({}, async (base) => {
    const res = await fetch(`${base}/computer-use/log`);
    assert.notEqual(res.status, 409);
  });
});

test("MCP stdio registration is refused under mobile; http still registers", async () => {
  const dir = tempDir("mcp");
  await withEnv({ OPENAGI_PROFILE: "mobile", OPENAGI_DATA_DIR: dir }, () => {
    const registry = new McpRegistry({ dataDir: dir, permittedEnvKeys: new Set() });
    assert.throws(() => registry.registerServer({ name: "fs", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] }),
      /stdio MCP servers are not available on phone/);
    assert.equal(registry.registerServer({ name: "remote", url: "https://mcp.example.com/mcp" }).transport, "http");
  });
  await withEnv({ OPENAGI_DATA_DIR: dir }, () => {
    const registry = new McpRegistry({ dataDir: dir, permittedEnvKeys: new Set() });
    assert.equal(registry.registerServer({ name: "fs", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] }).transport, "stdio");
  });
  await withApp({ OPENAGI_PROFILE: "mobile" }, async (base) => {
    const res = await fetch(`${base}/mcp/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "fs", transport: "stdio", command: "npx", args: ["-y", "pkg"] })
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /not available on phone/);
  });
});

test("mobile runtime does not register coding supervisor or iMessage poller", async () => {
  const dir = tempDir("tools");
  await withEnv({ OPENAGI_PROFILE: "mobile", OPENAGI_DATA_DIR: dir, OPENAGI_COMPUTER_USE: "1" }, () => {
    const runtime = createDurableRuntime({ dataDir: dir });
    assert.equal(runtime.imessagePoller, undefined);
    assert.equal(runtime.tools.has("start_computer_use_session"), false);
    assert.equal(runtime.tools.has("list_coding_agents"), false);
    assert.equal(runtime.tools.has("start_coding_agent"), false);
  });
});

test("voice and G2 speech upgrades are refused with 404 under mobile", () => {
  const entries = mobileRefusedUpgrades();
  assert.deepEqual(entries.map((entry) => entry.path), ["/nodes/voice", "/nodes/g2/speech"]);
  let written = "";
  entries[0].upgrade({}, { end: (text) => { written = text; } });
  assert.match(written, /^HTTP\/1\.1 404/);
});

// Last: the guard is process-wide and permanent.
test("spawn guard refuses every child_process launcher, including ESM named imports", () => {
  assert.equal(installMobileSpawnGuard(), true);
  assert.throws(() => spawn(process.execPath, ["-v"]), (error) => error.code === "OPENAGI_MOBILE_NO_SPAWN" && /not available on phone/.test(error.message));
  assert.equal(installMobileSpawnGuard(), false);
});
