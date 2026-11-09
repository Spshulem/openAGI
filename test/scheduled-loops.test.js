// test/scheduled-loops.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeSchedule, parseScheduleDays, scheduledPromptSpec } from "../src/scheduled-prompt.js";
import { CronScheduler } from "../src/cron-scheduler.js";
import { FileBackedCronScheduler } from "../src/file-backed-cron-scheduler.js";
import { ToolRegistry, registerCoreTools } from "../src/tool-registry.js";
import { PendingActionStore } from "../src/pending-actions.js";
import { AbiRuntime } from "../src/abi-runtime.js";
import { AgentHost } from "../src/agent-host.js";
import { ownerPrincipal } from "../src/owner-authority.js";
import { OUTREACH_DEFAULTS } from "../src/outreach-config.js";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

const owner = ownerPrincipal("owner");

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function cronTools(t) {
  const cron = new FileBackedCronScheduler({ storePath: path.join(tempDir(t, "loops-cron-"), "jobs.json") });
  const registry = new ToolRegistry();
  registerCoreTools(registry, { cron });
  return { cron, registry };
}

test("day sets parse and describe in plain words", () => {
  assert.deepEqual(parseScheduleDays("weekdays"), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseScheduleDays("Mon, wed,FRIDAY"), [1, 3, 5]);
  assert.equal(parseScheduleDays("daily"), null);
  assert.equal(parseScheduleDays(undefined), null);
  assert.throws(() => parseScheduleDays("someday"), /days must be/);
  assert.equal(describeSchedule({ dailyAt: "08:00", days: [1, 2, 3, 4, 5] }), "every weekday at 08:00");
  assert.equal(describeSchedule({ dailyAt: "09:30", days: null }), "every day at 09:30");
  assert.equal(describeSchedule({ intervalMs: 3600000, input: {} }), "every 60 minutes");
  assert.throws(() => scheduledPromptSpec({ prompt: "Fixture", intervalSeconds: 600, days: "weekdays" }), /only applies with dailyAt/);
});

test("a weekday schedule skips the weekend", () => {
  const cron = new CronScheduler();
  const friday = new Date(2026, 10, 6, 9, 0, 0); // Fri Nov 6 2026, after 08:00
  const next = cron.computeNextRun({ dailyAt: "08:00", days: [1, 2, 3, 4, 5] }, friday);
  assert.equal(next.getDay(), 1);
  assert.equal(next.getDate(), 9);
  assert.equal(next.getHours(), 8);
  const everyDay = cron.computeNextRun({ dailyAt: "08:00", days: null }, friday);
  assert.equal(everyDay.getDate(), 7);
});

test("only an owner turn marks a schedule as the owner's", () => {
  const args = { prompt: "Check my inbox for invoices", dailyAt: "08:00", days: "weekdays" };
  assert.equal(scheduledPromptSpec(args, { __owner: owner }).input.createdBy, "owner");
  assert.equal(scheduledPromptSpec(args, { from: "telegram:fixture" }).input.createdBy, undefined);
  assert.equal(scheduledPromptSpec(args, { __owner: { kind: "owner", via: "owner" } }).input.createdBy, undefined);
});

test("schedule_message returns the schedule and next run, and the owner can resume a paused copy", async t => {
  const { cron, registry } = cronTools(t);
  const args = { prompt: "Check my inbox for invoices", dailyAt: "08:00", days: "weekdays" };
  const created = await registry.invoke("schedule_message", args, { channel: "local", from: "user", sessionId: "s1", __owner: owner });
  assert.equal(created.ok, true);
  assert.equal(created.result.schedule, "every weekday at 08:00");
  assert.ok(created.result.nextRunLocal);
  assert.deepEqual(cron.listJobs()[0].days, [1, 2, 3, 4, 5]);
  cron.enableJob(created.result.id, false);
  const resumed = await registry.invoke("schedule_message", args, { channel: "local", from: "user", sessionId: "s1", __owner: owner });
  assert.equal(resumed.result.enabled, true);
  assert.match(resumed.result.note, /running again/);
  assert.equal(cron.listJobs().length, 1);
});

test("schedule tools refuse turns that are not the owner's", async t => {
  const { cron, registry } = cronTools(t);
  cron.addJob({ id: "job_fixture", name: "Inbox", task: "prompt", dailyAt: "08:00", input: { prompt: "Fixture", target: "+15550000001" } });
  const relay = { channel: "local", from: "imessage:+15550000002" };
  for (const [name, args] of [["list_cron_jobs", {}], ["cancel_cron_job", { id: "job_fixture" }], ["update_cron_job", { id: "job_fixture", enabled: false }]]) {
    const refused = await registry.invoke(name, args, relay);
    assert.equal(refused.ok, false, name);
    assert.match(refused.error, /Only the owner/);
  }
  assert.equal(cron.listJobs()[0].enabled, true);
  const listed = await registry.invoke("list_cron_jobs", {}, { __owner: owner });
  assert.equal(listed.result[0].schedule, "every day at 08:00");
  const approved = await registry.invoke("list_cron_jobs", {}, { __confirmed: true });
  assert.equal(approved.ok, true);
});

test("update_cron_job pauses, resumes, and edits a schedule", async t => {
  const { cron, registry } = cronTools(t);
  cron.addJob({ id: "job_fixture", name: "Inbox", task: "prompt", dailyAt: "08:00", input: { prompt: "Fixture" } });
  const ctx = { __owner: owner };
  const paused = await registry.invoke("update_cron_job", { id: "job_fixture", enabled: false }, ctx);
  assert.equal(paused.result.enabled, false);
  assert.equal(cron.listJobs()[0].nextRunAt, null);
  const edited = await registry.invoke("update_cron_job", { id: "job_fixture", enabled: true, dailyAt: "07:15", days: "mon,thu", prompt: "New fixture" }, ctx);
  assert.equal(edited.ok, true);
  assert.equal(edited.result.schedule, "every mon, thu at 07:15");
  const job = cron.listJobs()[0];
  assert.equal(job.input.prompt, "New fixture");
  assert.ok([1, 4].includes(new Date(job.nextRunAt).getDay()));
  const bad = await registry.invoke("update_cron_job", { id: "job_fixture", intervalSeconds: 600 }, ctx);
  assert.equal(bad.ok, false);
});

function scheduledRuntime({ deliverResult, fail = false } = {}) {
  const calls = { messages: [], deliveries: [], notices: [] };
  const self = {
    cron: null,
    channels: { async deliver(args) { calls.deliveries.push(args); return deliverResult; } },
    outreach: { append(item) { calls.notices.push(item); return item; } },
    agentHost: { async handleMessage(input, options) {
      calls.messages.push({ input, options });
      if (fail) throw new Error("Fixture provider failure");
      return { reply: "Two invoices found." };
    } }
  };
  self.noticeScheduledRun = AbiRuntime.prototype.noticeScheduledRun;
  self.deliverScheduledResult = AbiRuntime.prototype.deliverScheduledResult;
  return { self, calls };
}

test("a scheduled run says when it fired and passes the owner's schedule flag", async () => {
  const { self, calls } = scheduledRuntime({ deliverResult: { ok: true } });
  const job = { id: "job_a", name: "Inbox sweep", task: "prompt", dailyAt: "08:00", days: [1, 2, 3, 4, 5],
    input: { prompt: "Check my inbox", channel: "telegram", target: "123", createdBy: "owner" } };
  const result = await AbiRuntime.prototype.runScheduledPrompt.call(self, job);
  const { input, options } = calls.messages[0];
  assert.match(input.text, /^\[Scheduled run "Inbox sweep", every weekday at 08:00\. Now: /);
  assert.match(input.text, /Check my inbox$/);
  assert.equal(options.ownerSchedule, true);
  assert.deepEqual(result.delivered, { channel: "telegram", target: "123" });
  assert.equal(calls.notices.length, 0);

  const { self: other, calls: otherCalls } = scheduledRuntime({ deliverResult: { ok: true } });
  await AbiRuntime.prototype.runScheduledPrompt.call(other, { ...job, input: { ...job.input, createdBy: undefined } });
  assert.equal(otherCalls.messages[0].options.ownerSchedule, false);
});

test("a result with no outbound transport is not reported as delivered and reaches the feed", async () => {
  const { self, calls } = scheduledRuntime({ deliverResult: { delivered: false, reason: "channel local has no outbound transport" } });
  const job = { id: "job_b", name: "Inbox sweep", task: "prompt", dailyAt: "08:00", input: { prompt: "Check", channel: "local", target: "imessage:+15550000001" } };
  const result = await AbiRuntime.prototype.runScheduledPrompt.call(self, job);
  assert.equal(result.delivered, undefined);
  assert.match(result.deliveryError, /no outbound transport/);
  assert.equal(calls.notices.length, 1);
  assert.equal(calls.notices[0].summary, "Two invoices found.");
  assert.deepEqual(calls.notices[0].sourceRef, { kind: "cron", id: "job_b" });
});

test("a failed scheduled run tells the owner and still fails the job", async () => {
  const { self, calls } = scheduledRuntime({ fail: true });
  const job = { id: "job_c", name: "Inbox sweep", task: "prompt", dailyAt: "08:00", input: { prompt: "Check", channel: "telegram", target: "123" } };
  await assert.rejects(AbiRuntime.prototype.runScheduledPrompt.call(self, job), /Fixture provider failure/);
  assert.match(calls.notices[0].summary, /Scheduled run failed: Fixture provider failure/);
});

test("an approved card from a scheduled run resumes the run and delivers its report", async () => {
  const { self, calls } = scheduledRuntime({ deliverResult: { ok: true } });
  self.cron = { listJobs: () => [{ id: "job_d", name: "Inbox sweep", input: { prompt: "Check", channel: "telegram", target: "123", createdBy: "owner" } }] };
  const action = { id: "act_1", summary: "Run the triage skill", context: { sessionId: "s-cron", scheduledJobId: "job_d", channel: "telegram", from: "123" } };
  await AbiRuntime.prototype.resumeScheduledRun.call(self, action, { ok: true, result: { triaged: 2 } });
  const { input, options } = calls.messages[0];
  assert.equal(input.sessionId, "s-cron");
  assert.equal(input.origin, "cron");
  assert.match(input.text, /owner approved "Run the triage skill"\. It ran\. Result: \{"triaged":2\}/);
  assert.equal(options.ownerSchedule, true);
  assert.deepEqual(calls.deliveries[0], { channel: "telegram", target: "123", text: "Two invoices found." });
});

test("a queued card keeps the scheduled job it came from", t => {
  const store = new PendingActionStore({ dir: tempDir(t, "loops-pending-") });
  const action = store.enqueue({ toolName: "run_skill", args: { name: "triage" }, summary: "Run triage",
    context: { sessionId: "s1", origin: "cron", scheduledJobId: "job_e", scheduledJobName: "Inbox sweep" } });
  assert.equal(action.context.scheduledJobId, "job_e");
  assert.equal(action.context.scheduledJobName, "Inbox sweep");
});

test("an owner's schedule runs without the scrutiny throttle; gated tools still queue", async () => {
  const registry = new ToolRegistry();
  registry.register({ name: "read_thing", sideEffects: false, description: "r", parameters: { type: "object", properties: {} }, handler: async () => ({}) });
  registry.register({ name: "run_thing", description: "w", parameters: { type: "object", properties: {} }, handler: async () => ({}) });
  const captured = {};
  const host = new AgentHost({
    runtime: {
      tools: registry,
      memory: { remember: () => ({ id: "m1" }) },
      outcomes: null,
      processSignal: () => ({ id: "out_1", scrutiny: { action: "watch", score: 0.3, reasons: [], dimensions: {} }, customContext: [], propagation: { created: false } })
    },
    modelProvider: { isConfigured: () => true, model: "stub", generate: async (args) => {
      captured.tools = args.tools.map((tool) => tool.name);
      captured.context = args.context;
      return { text: "ok", provider: "stub", model: "stub", id: "r1", toolCalls: [] };
    } }
  });
  await host.handleMessage({ text: "Check my inbox", channel: "cron", from: "cron", origin: "cron" }, { ownerSchedule: true });
  assert.deepEqual(captured.tools.sort(), ["read_thing", "run_thing"]);
  assert.equal(captured.context.__scrutinyPolicy, null);
  assert.equal(captured.context.__owner, undefined);
  await host.handleMessage({ text: "Check my inbox", channel: "cron", from: "cron", origin: "cron" });
  assert.deepEqual(captured.tools, ["read_thing"]);
});

test("a skipped spring-forward day does not shift the next run's hour", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const cron = new CronScheduler();
    const friday = new Date(2026, 2, 6, 10, 0, 0); // Fri Mar 6; Sun Mar 8 has no 02:30
    const next = cron.computeNextRun({ dailyAt: "02:30", days: [1, 2, 3, 4, 5] }, friday);
    assert.equal(next.getDate(), 9);
    assert.equal(next.getHours(), 2);
    assert.equal(next.getMinutes(), 30);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("a one-shot run's approval resumes with the run's own access after the job is gone", async () => {
  const { self, calls } = scheduledRuntime({ deliverResult: { ok: true } });
  self.cron = { listJobs: () => [] };
  const action = { id: "act_2", summary: "Run the triage skill",
    context: { sessionId: "s-once", scheduledJobId: "job_gone", scheduledJobName: "Once", channel: "telegram", from: "123", agentId: "main", ownerSchedule: true } };
  await AbiRuntime.prototype.resumeScheduledRun.call(self, action, { ok: true, result: null });
  assert.equal(calls.messages[0].options.ownerSchedule, true);
  assert.equal(calls.messages[0].input.agentId, "main");
  assert.match(calls.messages[0].input.text, /Scheduled run "Once" update/);
});

test("an owner's scheduled run records its access on the cards it raises", t => {
  const store = new PendingActionStore({ dir: tempDir(t, "loops-pending-owner-") });
  const action = store.enqueue({ toolName: "run_skill", args: { name: "triage" }, summary: "Run triage",
    context: { sessionId: "s1", origin: "cron", scheduledJobId: "job_f", ownerSchedule: true } });
  assert.equal(action.context.ownerSchedule, true);
  const other = store.enqueue({ toolName: "run_skill", args: { name: "other" }, summary: "Run other",
    context: { sessionId: "s2", origin: "cron", scheduledJobId: "job_g", ownerSchedule: "yes" } });
  assert.equal(other.context.ownerSchedule, undefined);
});

test("scheduled-run notices roll into the digest", () => {
  assert.ok(OUTREACH_DEFAULTS.digestTypes.includes("scheduled-run"));
});

test("POST /cron marks dashboard-shaped schedules as the owner's", async t => {
  const dataDir = tempDir(t, "loops-route-");
  const prevToken = process.env.OPENAGI_AUTH_TOKEN;
  process.env.OPENAGI_AUTH_TOKEN = "test-token-abc";
  const app = createHostedInterface(createDurableRuntime({ dataDir }), { host: "127.0.0.1", port: 0, channelsDir: path.join(dataDir, "channels") });
  const { url } = await app.listen();
  try {
    const post = (body) => fetch(`${url}/cron`, {
      method: "POST",
      headers: { authorization: "Bearer test-token-abc", "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const res = await post({ name: "Inbox", task: "prompt", dailyAt: "08:00", days: "weekdays",
      input: { prompt: "Check my inbox", channel: "local", target: null, createdBy: "someone" } });
    const job = await res.json();
    assert.equal(res.status, 200);
    assert.equal(job.input.createdBy, "owner");
    assert.equal(job.input.oneShot, false);
    assert.deepEqual(job.days, [1, 2, 3, 4, 5]);
    const once = await (await post({ name: "Once", prompt: "Ping", delaySeconds: 60 })).json();
    assert.equal(once.input.oneShot, true);
    assert.equal(once.input.createdBy, "owner");
    assert.equal((await post({ name: "Bad", prompt: "x", dailyAt: "08:00", days: "someday" })).status, 400);
  } finally {
    await app.close();
    if (prevToken === undefined) delete process.env.OPENAGI_AUTH_TOKEN;
    else process.env.OPENAGI_AUTH_TOKEN = prevToken;
  }
});
