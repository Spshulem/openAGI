import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BudgetGuard,
  MemoryCondenser,
  OutcomeStore,
  ScrutinyPanel,
  SpecialistRouter,
  checkAuth,
  createDefaultRuntime,
  createDurableRuntime,
  createHostedInterface,
  FileBackedCronScheduler,
  FileBackedMemorySystem,
  FileBackedPropagationController,
  MemorySystem,
  PropagationController,
  ToolRegistry,
  generateToken,
  registerCoreTools,
  verifyTwilioSignature
} from "../src/index.js";

test("runtime processes ABI signal through memory and propagation", () => {
  const runtime = createDefaultRuntime();
  const [output] = runtime.processIntegrationEvent("abi", {
    summary: "Repeated high-risk task should be evaluated for specialization.",
    content: "The system repeatedly re-solves the same task with similar context gathering and similar failure modes.",
    domain: "general",
    taskType: "adaptation-review",
    citations: ["call:a", "call:b", "ticket:c"],
    impact: 0.9,
    externalPressure: 0.78,
    novelty: 0.68,
    repetition: 0.82,
    risk: 0.64,
    specificity: 0.8,
    requiresSpecialist: true
  });

  assert.equal(output.workflow.id, "adaptive-review");
  assert.equal(output.action, "propagate");
  assert.equal(output.memory.tier, "medium");
  assert.equal(output.propagation.reason, "specialist-created");
  assert.equal(runtime.propagation.list().length, 1);
});

test("memory promotes high-risk short-term items during decay", () => {
  const memory = new MemorySystem({
    ttlMs: {
      short: 1,
      medium: 100000,
      long: Number.POSITIVE_INFINITY
    }
  });

  memory.remember(
    {
      content: "High-risk customer commitment should not be forgotten.",
      risk: 0.8,
      novelty: 0.6,
      repetition: 0.3
    },
    {
      tier: "short",
      now: "2026-04-30T00:00:00.000Z"
    }
  );

  const result = memory.decay(new Date("2026-04-30T00:00:01.000Z"));
  assert.equal(result.promoted.length, 1);
  assert.equal(result.promoted[0].tier, "medium");
});

test("propagation reuses existing specialist for same bounded task", () => {
  const propagation = new PropagationController();
  const signal = {
    domain: "general",
    taskType: "adaptation-review",
    summary: "Daily adaptation review",
    repetition: 0.9,
    risk: 0.4,
    novelty: 0.5
  };
  const workflow = { id: "adaptive-review", goal: "Daily adaptation review" };

  const first = propagation.propagate({ signal, workflow, scrutiny: { reasons: ["repeated"] } });
  const second = propagation.propagate({ signal, workflow, scrutiny: { reasons: ["still repeated"] } });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.reason, "existing-specialist-activated");
  assert.equal(propagation.list().length, 1);
  assert.equal(propagation.list()[0].activationCount, 2);
});

test("hosted interface exposes runtime health", async () => {
  const app = createHostedInterface(createDefaultRuntime(), { port: 0 });
  const address = await app.listen();
  try {
    const root = await fetch(`${address.url}/`);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /OpenAGI/);

    const response = await fetch(`${address.url}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.status.integrations[0].name, "abi");

    const messageResponse = await fetch(`${address.url}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: "test",
        text: "Remember this repeated task and decide if it needs a specialist."
      })
    });
    assert.equal(messageResponse.status, 200);
    const messageBody = await messageResponse.json();
    assert.match(messageBody.reply, /[Ss]aved to memory/);
    assert.equal(messageBody.session.messageCount, 2);

    const smsResponse = await fetch(`${address.url}/channels/twilio/webhook`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        From: "+15555550123",
        Body: "Schedule a repeated risky task as a specialist."
      })
    });
    assert.equal(smsResponse.status, 200);
    assert.match(await smsResponse.text(), /<Response><Message>/);
  } finally {
    await app.close();
  }
});

test("file-backed memory persists across instances", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-memory-"));
  const first = new FileBackedMemorySystem({ dir });
  const item = first.remember({
    content: "Repeated high-risk tasks need bounded specialists and compressed memory.",
    risk: 0.5,
    novelty: 0.7,
    repetition: 0.8,
    tags: ["specialization"]
  });

  const second = new FileBackedMemorySystem({ dir });
  const hits = second.retrieve("repeated high-risk specialists memory");

  assert.equal(second.byTier(item.tier).length, 1);
  assert.equal(hits.length, 1);
  assert.match(hits[0].item.content, /Repeated high-risk/);
});

test("file-backed cron persists jobs and run state", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-cron-"));
  const storePath = path.join(dir, "jobs.json");
  const first = new FileBackedCronScheduler({ storePath });
  first.addJob({
    id: "quick",
    name: "Quick run",
    enabled: true,
    task: "test",
    intervalMs: 1000,
    nextRunAt: "2026-04-30T00:00:00.000Z"
  });

  const second = new FileBackedCronScheduler({ storePath });
  assert.equal(second.listJobs().length, 1);

  const results = await second.runDue(async (job) => ({ task: job.task }), new Date("2026-04-30T00:00:01.000Z"));
  assert.equal(results.length, 1);

  const third = new FileBackedCronScheduler({ storePath });
  assert.equal(third.listJobs()[0].lastRunAt, "2026-04-30T00:00:01.000Z");
});

test("durable runtime reloads memory and does not duplicate default cron", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-runtime-"));
  const first = createDurableRuntime({ dataDir });
  first.processIntegrationEvent("abi", {
    summary: "Repeated task asks for adaptation review.",
    content: "The same high-risk task recurs every day.",
    domain: "general",
    taskType: "adaptation-review",
    repetition: 0.9,
    novelty: 0.6,
    risk: 0.5,
    requiresSpecialist: true
  });

  const second = createDurableRuntime({ dataDir });
  assert.equal(second.memory.byTier("medium").length, 1);
  assert.equal(second.propagation.list().length, 1);
  assert.equal(second.agentHost.store.listAgents().some((agent) => agent.role === "specialist"), true);
  assert.equal(second.cron.listJobs().filter((job) => job.id === "daily-adaptation-review").length, 1);
});

test("core tools registered with runtime", () => {
  const runtime = createDefaultRuntime();
  const names = runtime.tools.list().map((t) => t.name);
  for (const required of ["remember", "recall", "schedule_message", "list_skills", "run_skill", "list_mcp_tools"]) {
    assert.ok(names.includes(required), `missing tool: ${required}`);
  }
});

test("remember tool writes to memory and recall finds it", async () => {
  const runtime = createDefaultRuntime();
  const remember = await runtime.tools.invoke("remember", { content: "The team standup is 9am Mondays.", importance: "high" });
  assert.equal(remember.ok, true);
  const recall = await runtime.tools.invoke("recall", { query: "standup Mondays" });
  assert.equal(recall.ok, true);
  assert.ok(recall.result.count >= 1);
  assert.match(recall.result.items[0].content, /standup/);
});

test("schedule_message creates a prompt-typed cron job", async () => {
  const runtime = createDefaultRuntime();
  const out = await runtime.tools.invoke("schedule_message", {
    prompt: "Hello",
    delaySeconds: 60,
    channel: "local",
    target: "browser"
  }, { channel: "local", from: "browser", agentId: "main", sessionId: "test" });
  assert.equal(out.ok, true);
  const job = runtime.cron.listJobs().find((j) => j.id === out.result.id);
  assert.ok(job);
  assert.equal(job.task, "prompt");
  assert.equal(job.input.prompt, "Hello");
  assert.equal(job.input.channel, "local");
});

test("scheduled prompt fires through agent host and produces a reply", async () => {
  const runtime = createDefaultRuntime();
  await runtime.tools.invoke("schedule_message", {
    prompt: "Reminder fired",
    delaySeconds: 60,
    channel: "local",
    target: "tester"
  }, { channel: "local", from: "tester", agentId: "main", sessionId: null });
  // back-date the job so it is due immediately
  const job = runtime.cron.listJobs().find((j) => j.task === "prompt");
  assert.ok(job);
  job.nextRunAt = new Date(Date.now() - 1000).toISOString();
  const results = await runtime.tick(new Date());
  assert.ok(results.length >= 1, "expected at least one fired job");
  const fired = results.find((r) => r.job.task === "prompt");
  assert.ok(fired);
  assert.ok(fired.result.reply, "scheduled prompt should have a reply");
});

test("skills loader exposes bundled skills as tools", () => {
  const runtime = createDefaultRuntime();
  assert.ok(runtime.skills, "runtime.skills should exist");
  const names = runtime.skills.list().map((s) => s.name);
  assert.ok(names.includes("recap"), "expected 'recap' skill bundled");
  const toolNames = runtime.tools.list().map((t) => t.name);
  assert.ok(toolNames.some((n) => n.startsWith("skill_")), "expected at least one skill_* tool");
});

test("budget guard records anthropic usage and computes USD", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-budget-"));
  const guard = new BudgetGuard({ storePath: path.join(dir, "usage.json"), dailyUsdLimit: 100 });
  guard.record({ input_tokens: 1_000_000, output_tokens: 500_000 }, "claude-sonnet-4-6");
  const snap = guard.status();
  // 1M input @ $3 + 0.5M output @ $15 = $3 + $7.50 = $10.50
  assert.ok(Math.abs(snap.spentUsd - 10.5) < 0.001, `expected ~10.5 got ${snap.spentUsd}`);
  assert.equal(snap.calls, 1);
});

test("budget guard throws when daily limit exceeded", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-budget-"));
  const guard = new BudgetGuard({ storePath: path.join(dir, "usage.json"), dailyUsdLimit: 1 });
  guard.record({ input_tokens: 1_000_000, output_tokens: 0 }, "claude-sonnet-4-6"); // $3 spend
  assert.throws(() => guard.check(), /Daily budget reached/);
});

test("autopilot task type fires through agent host", async () => {
  const runtime = createDefaultRuntime();
  runtime.cron.addJob({
    id: "auto-test",
    name: "auto",
    enabled: true,
    task: "autopilot",
    intervalMs: 60000,
    nextRunAt: new Date(Date.now() - 1000).toISOString(),
    input: { agentId: "main" }
  });
  const results = await runtime.tick(new Date());
  const fired = results.find((r) => r.job.task === "autopilot");
  assert.ok(fired);
  assert.ok(fired.result.reply, "autopilot should produce a reply");
  assert.equal(fired.result.autopilot, true);
});

test("send_message tool exists in registry", () => {
  const runtime = createDefaultRuntime();
  assert.ok(runtime.tools.has("send_message"));
});

test("Rize integration registers tools when API key is set", async () => {
  const { RizeClient, registerRizeIntegration } = await import("../src/index.js");
  const runtime = createDefaultRuntime();
  const beforeCount = runtime.tools.list().length;
  // No key → no tools
  const noop = registerRizeIntegration(runtime, { client: new RizeClient({ apiKey: null }) });
  assert.equal(noop.registered, false);
  assert.equal(runtime.tools.list().length, beforeCount);
  // With key → 3 tools
  const result = registerRizeIntegration(runtime, { client: new RizeClient({ apiKey: "TEST_KEY" }) });
  assert.equal(result.registered, true);
  for (const t of ["rize_query", "rize_today_summary", "rize_recent_sessions"]) {
    assert.ok(runtime.tools.has(t), `expected tool ${t}`);
  }
});

test("auth disabled when no token configured", () => {
  const url = new URL("http://x/");
  const result = checkAuth({ headers: {} }, url, null);
  assert.equal(result.ok, true);
  assert.match(result.reason, /auth disabled/);
});

test("auth accepts header bearer, query token, and cookie", () => {
  const token = generateToken(16);
  // header
  const a = checkAuth({ headers: { authorization: `Bearer ${token}` } }, new URL("http://x/"), token);
  assert.equal(a.ok, true);
  // query
  const b = checkAuth({ headers: {} }, new URL(`http://x/?token=${token}`), token);
  assert.equal(b.ok, true);
  assert.equal(b.setCookie, true);
  // cookie
  const c = checkAuth({ headers: { cookie: `openagi_token=${token}` } }, new URL("http://x/"), token);
  assert.equal(c.ok, true);
  // wrong
  const d = checkAuth({ headers: { authorization: "Bearer wrong" } }, new URL("http://x/"), token);
  assert.equal(d.ok, false);
});

test("twilio signature passes for valid HMAC and fails for tampered body", async () => {
  const crypto = await import("node:crypto");
  const authToken = "twilio_test_secret";
  const fullUrl = "https://example.com/channels/twilio/webhook";
  const params = { From: "+15555550123", Body: "hi", MessageSid: "SM1" };
  const sortedKeys = Object.keys(params).sort();
  const data = fullUrl + sortedKeys.map((k) => k + params[k]).join("");
  const sig = crypto.createHmac("sha1", authToken).update(data).digest("base64");

  const ok = verifyTwilioSignature({ authToken, fullUrl, params, signature: sig });
  assert.equal(ok.ok, true);

  const bad = verifyTwilioSignature({ authToken, fullUrl, params: { ...params, Body: "tampered" }, signature: sig });
  assert.equal(bad.ok, false);
});

test("outcome store records, resolves, aggregates, and reloads", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-outcome-"));
  const first = new OutcomeStore({ dir });
  const a = first.record({ kind: "agent-reply", sessionId: "s1", channel: "local", scrutinyAction: "act" });
  const b = first.record({ kind: "cron-fire", sessionId: "s2", toolCalls: [{ name: "remember", ok: true }] });
  assert.equal(first.pending().length, 2);

  first.resolve(a.id, 0.85, "user-followup");
  const sweep = first.resolveSweep();
  assert.ok(sweep.length >= 1, "cron-fire with tool calls should resolve via sweep");

  const agg = first.aggregate(30);
  assert.equal(agg.total, 2);
  assert.ok(agg.avgQuality > 0.5);

  // Reload from disk
  const second = new OutcomeStore({ dir });
  assert.equal(second.recent().length, 2);
});

test("outcome store explicit feedback resolves an outcome", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-outcome-fb-"));
  const store = new OutcomeStore({ dir });
  const o = store.record({ kind: "agent-reply", refId: "msg_42", sessionId: "s1" });
  const result = store.feedback("msg_42", 0.95, "great answer");
  assert.ok(result);
  assert.equal(result.id, o.id);
  assert.equal(result.qualityScore, 0.95);
  assert.equal(result.source, "explicit-rating");
});

test("agent turn writes an outcome record into runtime.outcomes", async () => {
  const runtime = createDefaultRuntime();
  await runtime.agentHost.handleMessage({ channel: "local", from: "test", text: "hi" });
  const recent = runtime.outcomes.recent(5);
  assert.ok(recent.length >= 1);
  assert.equal(recent[0].kind, "agent-reply");
  assert.equal(recent[0].channel, "local");
});

test("specialist router scores by text and tag overlap, respects threshold", () => {
  const router = new SpecialistRouter({ threshold: 0.4 });
  const specialists = [
    {
      id: "s1",
      name: "calendar-helper",
      boundedScope: "Schedule meetings and check calendar availability for the user.",
      activationCount: 3,
      lastActivatedAt: new Date().toISOString(),
      metadata: { tags: ["calendar", "meeting"] },
      status: "available"
    },
    {
      id: "s2",
      name: "code-reviewer",
      boundedScope: "Review pull requests and suggest improvements.",
      activationCount: 5,
      lastActivatedAt: new Date().toISOString(),
      metadata: { tags: ["code", "review"] },
      status: "available"
    }
  ];
  const calendar = router.decide("Can you find time on my calendar for a meeting?", ["message", "calendar"], specialists);
  assert.equal(calendar.route, true);
  assert.equal(calendar.candidate.specialist.id, "s1");

  const irrelevant = router.decide("What's the weather like?", ["message"], specialists);
  assert.equal(irrelevant.route, false);
});

test("specialist router off mode never routes", () => {
  const router = new SpecialistRouter({ mode: "off" });
  const decision = router.decide("anything", [], [{ id: "s", boundedScope: "anything", activationCount: 1, status: "available" }]);
  assert.equal(decision.route, false);
});

test("scrutiny panel produces three verdicts and a consensus action", () => {
  const panel = new ScrutinyPanel();
  // Strong signal — at minimum the panel should converge on act or propagate (no 'ask').
  const easy = panel.evaluate({
    signal: { impact: 0.85, risk: 0.2, novelty: 0.4, repetition: 0.3, specificity: 0.85, citations: ["a", "b", "c"], confidence: 0.85, urgency: 0.6 },
    workflow: { id: "w", name: "demo", goal: "demo" },
    memories: [{ score: 0.8 }],
    context: { name: "test" }
  });
  assert.ok(["act", "propagate"].includes(easy.action), `expected act/propagate, got ${easy.action}`);
  assert.ok(["unanimous", "majority"].includes(easy.agreement));
  assert.ok(easy.judges.cautious && easy.judges.pragmatic && easy.judges.aggressive);
});

test("scrutiny panel personalities polarize on the same mid-strength signal", () => {
  const panel = new ScrutinyPanel();
  // Mid-strength: between ask and act thresholds for at least one judge.
  // Aggressive (act=0.58) should push toward act, cautious (act=0.78) hedges to ask.
  const sig = {
    impact: 0.7, urgency: 0.6, externalPressure: 0.6,
    risk: 0.35, novelty: 0.5, repetition: 0.45,
    specificity: 0.5, confidence: 0.5, ambiguity: 0.45,
    citations: ["a"], goalAlignment: 0.7, strategicFit: 0.65, policyFit: 0.7, internalPressure: 0.55
  };
  const v = panel.evaluate({ signal: sig, workflow: { id: "w", name: "demo", goal: "demo" }, memories: [], context: { name: "test" } });
  const distinctActions = new Set([v.judges.cautious.action, v.judges.pragmatic.action, v.judges.aggressive.action]);
  assert.ok(distinctActions.size >= 2, `expected at least two distinct actions across judges, got ${[...distinctActions].join(",")}`);
});

test("high-danger memory items resist compression and rank higher on tag-matched recall", () => {
  const memory = new MemorySystem();
  memory.remember(
    {
      content: "An hourglass shape on a black widow spider's belly is the lethal female. Stay away.",
      risk: 0.9,
      specificity: 0.9,
      tags: ["spider", "danger"]
    },
    { tier: "long" }
  );
  memory.remember(
    {
      content: "Spiders can be scary but most are harmless.",
      risk: 0.2,
      specificity: 0.3,
      tags: ["spider"]
    },
    { tier: "long" }
  );
  const hits = memory.retrieve("spider in basement", { tags: ["spider", "danger"] });
  // Danger boost should rank the specific lethal item first.
  assert.match(hits[0].item.content, /hourglass/i);
});

test("memory condenser groups items by tag overlap and writes a principle to long-tier", async () => {
  const runtime = createDefaultRuntime();
  const tags = ["work", "standup"];
  for (let i = 0; i < 4; i += 1) {
    runtime.memory.remember(
      { content: `Standup notes ${i}: discussed sprint progress.`, tags, risk: 0.3, repetition: 0.6, novelty: 0.4 },
      { tier: "medium" }
    );
  }
  const before = runtime.memory.byTier("long").length;
  const result = await runtime.condenser.condense();
  assert.ok(result.principles >= 1, `expected at least one principle, got ${result.principles}`);
  const after = runtime.memory.byTier("long");
  assert.ok(after.length > before);
  const principle = after.find((m) => m.kind === "principle");
  assert.ok(principle);
  assert.ok(principle.metadata.sources.length >= 3);
  assert.ok(principle.metadata.quarantineUntil);
});

test("file-backed propagation persists specialist workspaces", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-agents-"));
  const storePath = path.join(dir, "specialists.json");
  const workspaceRoot = path.join(dir, "workspaces");
  const first = new FileBackedPropagationController({ storePath, workspaceRoot });
  const result = first.propagate({
    signal: {
      domain: "general",
      taskType: "adaptation-review",
      summary: "Daily adaptation review",
      repetition: 0.9
    },
    workflow: { id: "adaptive-review", goal: "Daily review" },
    scrutiny: { reasons: ["repeated"] },
    tools: [{ name: "query-recordings" }]
  });

  assert.equal(result.created, true);
  assert.ok(fs.existsSync(path.join(result.specialist.workspaceDir, "AGENTS.md")));

  const second = new FileBackedPropagationController({ storePath, workspaceRoot });
  assert.equal(second.list().length, 1);
  assert.equal(second.list()[0].name, "general-adaptation-review-specialist");
});
