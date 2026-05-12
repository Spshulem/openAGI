import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BudgetGuard,
  HashBagEmbedder,
  MemoryCondenser,
  OutcomeStore,
  ScrutinyFitter,
  ScrutinyPanel,
  SpecialistRouter,
  VectorStore,
  checkAuth,
  cosine,
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

test("agent-pulse cron job is registered by default + idempotent across reloads", () => {
  // The agent queue is useless if nothing drains it. This pins the
  // default "agent-pulse" autopilot job so an upgrade can't quietly
  // drop it (which would leave agent-queue tasks inert forever).
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-pulse-"));
  const first = createDurableRuntime({ dataDir });
  const firstPulse = first.cron.listJobs().filter((job) => job.id === "agent-pulse");
  assert.equal(firstPulse.length, 1, "agent-pulse registered on first start");
  assert.equal(firstPulse[0].task, "autopilot");
  assert.equal(firstPulse[0].enabled, true);
  assert.equal(firstPulse[0].intervalMs, 30 * 60 * 1000, "default cadence 30 min");
  assert.match(firstPulse[0].input?.prompt ?? "", /agent_pick_next/, "prompt tells agent to drain queue");

  // Restart: should still be exactly one (idempotent).
  const second = createDurableRuntime({ dataDir });
  const secondPulse = second.cron.listJobs().filter((job) => job.id === "agent-pulse");
  assert.equal(secondPulse.length, 1, "agent-pulse not duplicated on restart");
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

test("specialist router scores by text and tag overlap, respects threshold", async () => {
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
  const calendar = await router.decide("Can you find time on my calendar for a meeting?", ["message", "calendar"], specialists);
  assert.equal(calendar.route, true);
  assert.equal(calendar.candidate.specialist.id, "s1");

  const irrelevant = await router.decide("What's the weather like?", ["message"], specialists);
  assert.equal(irrelevant.route, false);
});

test("specialist router off mode never routes", async () => {
  const router = new SpecialistRouter({ mode: "off" });
  const decision = await router.decide("anything", [], [{ id: "s", boundedScope: "anything", activationCount: 1, status: "available" }]);
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

test("propagation retirement sweep retires dormant and low-quality specialists", () => {
  const propagation = new PropagationController();
  const result = propagation.propagate({
    signal: { domain: "general", taskType: "test", summary: "test scope", repetition: 0.9 },
    workflow: { id: "w", goal: "test" },
    scrutiny: { reasons: [] }
  });
  assert.equal(result.created, true);
  const sp = result.specialist;

  // Force dormancy: mark lastActivatedAt 90 days ago.
  const longAgo = new Date(Date.now() - 90 * 86400 * 1000).toISOString();
  sp.lastActivatedAt = longAgo;
  const retired = propagation.retirementSweep({ dormancyDays: 30 });
  assert.equal(retired.length, 1);
  assert.equal(retired[0].status, "retired");
  assert.match(retired[0].retirementReason, /dormant/);

  // list() excludes retired by default
  assert.equal(propagation.list().length, 0);
  assert.equal(propagation.list({ includeRetired: true }).length, 1);
});

test("propagation tracks rolling outcome quality and retires bad specialists", () => {
  const propagation = new PropagationController();
  const r = propagation.propagate({
    signal: { domain: "general", taskType: "bad", summary: "bad scope", repetition: 0.9 },
    workflow: { id: "w", goal: "bad" },
    scrutiny: { reasons: [] }
  });
  const sp = r.specialist;
  for (let i = 0; i < 12; i += 1) propagation.recordOutcomeQuality(sp.id, 0.15);
  assert.ok(sp.meanOutcomeQuality < 0.3);
  const retired = propagation.retirementSweep({ dormancyDays: 999, minSamples: 10, qualityFloor: 0.3 });
  assert.equal(retired.length, 1);
  assert.match(retired[0].retirementReason, /quality/);
});

test("recall is scoped per specialist when called with non-main agentId", () => {
  const runtime = createDefaultRuntime();
  runtime.memory.remember(
    { content: "main agent fact", scope: "main", tags: ["fact"], risk: 0.3 },
    {}
  );
  runtime.memory.remember(
    { content: "specialist private note", scope: "specialist:s1", tags: ["fact"], risk: 0.3 },
    {}
  );
  runtime.memory.remember(
    { content: "another specialist's note", scope: "specialist:s2", tags: ["fact"], risk: 0.3 },
    {}
  );
  const mainHits = runtime.memory.retrieve("fact", { scope: "main" });
  const mainContents = mainHits.map((h) => h.item.content);
  assert.ok(mainContents.includes("main agent fact"));
  assert.ok(!mainContents.includes("specialist private note"));

  const s1Hits = runtime.memory.retrieve("fact", { scope: "specialist:s1" });
  const s1Contents = s1Hits.map((h) => h.item.content);
  assert.ok(s1Contents.includes("specialist private note"));
  assert.ok(s1Contents.includes("main agent fact"), "specialists can see main scope");
  assert.ok(!s1Contents.includes("another specialist's note"));
});

test("hash-bag embedder + cosine ranks similar text higher than unrelated", async () => {
  const embedder = new HashBagEmbedder();
  const a = await embedder.embed("schedule a meeting on my calendar tomorrow");
  const b = await embedder.embed("can you put a meeting on my calendar for tomorrow");
  const c = await embedder.embed("the spider has an hourglass on its belly");
  assert.ok(cosine(a, b) > cosine(a, c), "near-paraphrase should outscore unrelated text");
});

test("vector store upserts, persists, and reloads", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-vec-"));
  const embedder = new HashBagEmbedder();
  const first = new VectorStore({ embedder, dir });
  await first.upsert("principle", "p1", "Standups are at 9am Mondays — don't schedule conflicting meetings.");
  await first.upsert("principle", "p2", "Hourglass on a black widow spider is the lethal female.");

  const second = new VectorStore({ embedder, dir });
  const hits = await second.search("principle", "standup time mondays", { limit: 2, minScore: 0 });
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].id, "p1");
});

test("specialist router blends keyword and semantic signals", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-route-"));
  const embedder = new HashBagEmbedder();
  const vs = new VectorStore({ embedder, dir });
  const sp = {
    id: "s1",
    name: "calendar-helper",
    boundedScope: "Schedule meetings, find free time on the calendar, propose times.",
    activationCount: 3,
    lastActivatedAt: new Date().toISOString(),
    metadata: { tags: ["calendar", "meeting"] },
    status: "available"
  };
  await vs.upsert("specialist", sp.id, `${sp.name}\n${sp.boundedScope}`);
  const router = new SpecialistRouter({ vectorStore: vs, threshold: 0.3 });
  const decision = await router.decide(
    "schedule a meeting on my calendar this week",
    ["message", "calendar"],
    [sp]
  );
  assert.equal(decision.route, true, `route should fire; got score=${decision.candidate?.score}, breakdown=${JSON.stringify(decision.candidate?.breakdown)}`);
  assert.ok(decision.candidate.breakdown.semanticScore !== null);
  assert.ok(decision.candidate.breakdown.semanticScore > 0);
});

test("scrutiny fitter stages proposals during warmup, auto-applies after", () => {
  const runtime = createDefaultRuntime();
  // Seed 60 synthetic resolved outcomes correlating high evidence with high quality.
  for (let i = 0; i < 60; i += 1) {
    const dims = {
      environment: Math.random(),
      company: Math.random(),
      evidence: 0.3 + Math.random() * 0.7,
      memory: Math.random(),
      uncertainty: Math.random()
    };
    const o = runtime.outcomes.record({ kind: "agent-reply", scrutinyAction: "act", scrutinyDimensions: dims });
    // Quality strongly correlated with evidence
    runtime.outcomes.resolve(o.id, Math.min(1, dims.evidence + 0.05 * Math.random()), "system-inferred");
  }

  const fitter = new ScrutinyFitter({ runtime, dir: fs.mkdtempSync(path.join(os.tmpdir(), "openagi-fit-")), warmupCycles: 1 });
  runtime.scrutinyFitter = fitter;
  const before = { ...runtime.scrutiny.judges.pragmatic.weights };

  const r1 = fitter.fit(); // cycle 1: warmup, stages
  assert.equal(r1.autoApplied, false);
  assert.equal(fitter.pending.proposals.length, 1);

  const r2 = fitter.fit(); // cycle 2: > warmup, auto-applies
  assert.equal(r2.autoApplied, true);
  // Evidence weight should have moved upward (positive correlation with quality)
  assert.ok(runtime.scrutiny.judges.pragmatic.weights.evidence > before.evidence,
    `expected evidence weight to grow, got before=${before.evidence}, after=${runtime.scrutiny.judges.pragmatic.weights.evidence}`);
});

test("scrutiny fitter judge signal averages with correlation deltas", () => {
  const runtime = createDefaultRuntime();
  for (let i = 0; i < 50; i += 1) {
    const dims = { environment: 0.5, company: 0.5, evidence: 0.5, memory: 0.5, uncertainty: 0.5 };
    const o = runtime.outcomes.record({ kind: "agent-reply", scrutinyAction: "act", scrutinyDimensions: dims });
    runtime.outcomes.resolve(o.id, 0.7, "system-inferred");
  }
  const fitter = new ScrutinyFitter({ runtime, dir: fs.mkdtempSync(path.join(os.tmpdir(), "openagi-fit2-")), warmupCycles: 0 });
  runtime.scrutinyFitter = fitter;
  fitter.addJudgeSignal({
    judge: "pragmatic",
    deltas: { environment: 0, company: 0, evidence: 0.05, memory: 0, uncertainty: -0.02 }
  });
  const before = runtime.scrutiny.judges.pragmatic.weights.evidence;
  const r = fitter.fit();
  assert.equal(r.autoApplied, true);
  // Evidence weight should grow because the judge nudged it up.
  assert.ok(runtime.scrutiny.judges.pragmatic.weights.evidence > before);
});

test("retiring a specialist with scoped memory creates a legacy principle in main", async () => {
  const runtime = createDefaultRuntime();
  const r = runtime.propagation.propagate({
    signal: { domain: "general", taskType: "legacy", summary: "to-retire", repetition: 0.9 },
    workflow: { id: "w", goal: "to-retire" },
    scrutiny: { reasons: [] }
  });
  const sp = r.specialist;
  // Seed scoped memory
  for (let i = 0; i < 5; i += 1) {
    runtime.memory.remember(
      { content: `Spec note ${i}: pattern X needs Y`, scope: `specialist:${sp.id}`, tags: ["pattern-x", "legacy"], risk: 0.4, repetition: 0.7, novelty: 0.3 },
      { tier: "medium" }
    );
  }
  runtime.propagation.retire(sp.id, "test");

  const result = await runtime.condenser.condense({
    scope: `specialist:${sp.id}`,
    writeScope: "main",
    originSpecialistId: sp.id
  });
  assert.ok(result.principles >= 1);
  const legacy = runtime.memory.byTier("long").find((m) => m.metadata?.originSpecialistId === sp.id);
  assert.ok(legacy);
  assert.ok(legacy.tags.includes(`legacy:${sp.id}`));
  assert.equal(legacy.scope, "main");
});

test("propagation enforces max depth and breadth for sub-specialists", () => {
  const propagation = new PropagationController({ maxDepth: 2, maxBreadthPerParent: 2 });
  const root = propagation.propagate({
    signal: { domain: "g", taskType: "root", summary: "root", repetition: 0.9 },
    workflow: { id: "w", goal: "root" },
    scrutiny: { reasons: [] }
  });
  // First child OK
  const c1 = propagation.propagate({
    signal: { domain: "g", taskType: "c1", summary: "c1", repetition: 0.9 },
    workflow: { id: "w", goal: "c1" },
    scrutiny: { reasons: [] },
    parentSpecialistId: root.specialist.id
  });
  assert.equal(c1.created, true);
  assert.equal(c1.specialist.depth, 1);
  // Second child OK
  propagation.propagate({
    signal: { domain: "g", taskType: "c2", summary: "c2", repetition: 0.9 },
    workflow: { id: "w", goal: "c2" },
    scrutiny: { reasons: [] },
    parentSpecialistId: root.specialist.id
  });
  // Breadth check via shouldPropagate (third child blocked)
  const blocked = propagation.shouldPropagate({
    signal: { repetition: 0.9, requiresSpecialist: true },
    scrutiny: { dimensions: { repetition: 0.9, risk: 0.5, novelty: 0.5 }, action: "propagate" },
    parentSpecialistId: root.specialist.id
  });
  assert.equal(blocked.decision, false);
  assert.match(blocked.blockedBy, /max-breadth/);

  // Depth check via shouldPropagate from c1's perspective
  const depthBlocked = propagation.shouldPropagate({
    signal: { repetition: 0.9, requiresSpecialist: true },
    scrutiny: { dimensions: { repetition: 0.9, risk: 0.5, novelty: 0.5 }, action: "propagate" },
    parentSpecialistId: c1.specialist.id
  });
  assert.equal(depthBlocked.decision, false);
  assert.match(depthBlocked.blockedBy, /max-depth/);
});

test("vocabulary curator detects merge candidates and applies them", () => {
  const runtime = createDefaultRuntime();
  for (let i = 0; i < 6; i += 1) {
    runtime.memory.remember({ content: `note ${i}`, tags: ["calendar"], risk: 0.3 }, { tier: "short" });
  }
  for (let i = 0; i < 6; i += 1) {
    runtime.memory.remember({ content: `note ${i}`, tags: ["calendars"], risk: 0.3 }, { tier: "short" });
  }
  const merges = runtime.vocabulary.proposeMerges();
  assert.ok(merges.length >= 1, "expected at least one near-synonym merge proposal");
  const applied = runtime.vocabulary.applyMerges(merges);
  assert.ok(applied[0].touched > 0);
});

test("introspector audit returns structural findings", () => {
  const runtime = createDefaultRuntime();
  const audit = runtime.introspector.audit();
  assert.ok(audit.specialists);
  assert.ok(audit.memory);
  assert.ok(audit.cron);
  assert.ok(Array.isArray(audit.findings));
});

test("setup wizard saves env atomically and is detected as first-run before keys exist", async () => {
  const { saveEnv, isFirstRun } = await import("../src/setup-wizard.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-wizard-"));
  // Save without provider key first → still first run
  const savedAnthropic = process.env.ANTHROPIC_API_KEY;
  const savedAuth = process.env.OPENAGI_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAGI_AUTH_TOKEN;
  assert.equal(isFirstRun(), true);

  const result = saveEnv({
    dataDir: dir,
    values: {
      ANTHROPIC_API_KEY: "sk-test-key",
      OPENAGI_AUTH_TOKEN: "abc123",
      OPENAGI_DAILY_USD_LIMIT: 5
    }
  });
  assert.equal(result.keys.includes("ANTHROPIC_API_KEY"), true);
  const written = fs.readFileSync(path.join(dir, ".env"), "utf8");
  assert.match(written, /ANTHROPIC_API_KEY=sk-test-key/);
  assert.match(written, /OPENAGI_AUTH_TOKEN=abc123/);
  assert.equal(process.env.ANTHROPIC_API_KEY, "sk-test-key");
  assert.equal(isFirstRun(), false);

  // Restore env
  if (savedAnthropic) process.env.ANTHROPIC_API_KEY = savedAnthropic;
  else delete process.env.ANTHROPIC_API_KEY;
  if (savedAuth) process.env.OPENAGI_AUTH_TOKEN = savedAuth;
  else delete process.env.OPENAGI_AUTH_TOKEN;
});

test("setup wizard rejects unknown keys (allowlist only)", async () => {
  const { saveEnv } = await import("../src/setup-wizard.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-wizard-allow-"));
  const result = saveEnv({
    dataDir: dir,
    values: {
      ANTHROPIC_API_KEY: "sk-x",
      MALICIOUS_KEY: "trying",
      PATH: "/etc/passwd"
    }
  });
  assert.equal(result.keys.includes("MALICIOUS_KEY"), false);
  assert.equal(result.keys.includes("PATH"), false);
  assert.equal(result.keys.includes("ANTHROPIC_API_KEY"), true);
});

test("tunnel watcher detects new cloudflared URL and persists to .env", async () => {
  const { TunnelWatcher } = await import("../src/index.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-tunnel-"));
  const logPath = path.join(dir, "tunnel.log");
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(logPath, "starting...\n");
  fs.writeFileSync(envPath, "ANTHROPIC_API_KEY=existing\n");

  delete process.env.OPENAGI_PUBLIC_URL;
  const watcher = new TunnelWatcher({ logPath, envPath });
  let captured = null;
  watcher.on("tunnel-url", (e) => { captured = e; });

  // Initial scan with no URL — should emit nothing
  watcher.tickSafe();
  assert.equal(captured, null);

  // Append a quick-tunnel URL
  fs.appendFileSync(logPath, "Your quick Tunnel: https://abc-def-ghi.trycloudflare.com\n");
  watcher.tickSafe();
  assert.ok(captured, "expected tunnel-url event");
  assert.match(captured.url, /trycloudflare\.com/);

  // Verify env file got updated
  const envText = fs.readFileSync(envPath, "utf8");
  assert.match(envText, /OPENAGI_PUBLIC_URL=https:\/\/abc-def-ghi\.trycloudflare\.com/);
  assert.match(envText, /ANTHROPIC_API_KEY=existing/, "should preserve existing keys");
  assert.equal(process.env.OPENAGI_PUBLIC_URL, "https://abc-def-ghi.trycloudflare.com");
});

test("OpenAI provider tool loop never sends previous_response_id (ZDR-safe)", async () => {
  const { OpenAIResponsesProvider } = await import("../src/index.js");
  const provider = new OpenAIResponsesProvider({ apiKey: "test-key", maxToolHops: 3 });

  const sentBodies = [];
  // Stub postResponses with a 2-hop tool conversation
  let hop = 0;
  provider.postResponses = async (body) => {
    sentBodies.push(JSON.parse(JSON.stringify(body)));
    hop += 1;
    if (hop === 1) {
      return {
        id: "resp_1",
        output: [
          { type: "function_call", call_id: "call_a", name: "remember", arguments: '{"content":"x"}' }
        ]
      };
    }
    return { id: "resp_2", output_text: "Done." };
  };

  const fakeRegistry = {
    invoke: async (name) => ({ ok: true, result: { id: "mem_1", tier: "short" } }),
    toOpenAITools: () => [{ type: "function", name: "remember", description: "", parameters: {} }]
  };

  const result = await provider.generate({
    input: "remember x",
    messages: [],
    toolRegistry: fakeRegistry,
    agent: { id: "main", name: "main" }
  });

  assert.equal(result.text, "Done.");
  assert.ok(sentBodies.length >= 2, "expected at least 2 hops");
  for (const body of sentBodies) {
    assert.equal(body.previous_response_id, undefined, "must not use previous_response_id (ZDR breaks it)");
  }
  // Second hop should carry the function_call AND function_call_output items
  const second = sentBodies[1];
  assert.ok(second.input.some((i) => i.type === "function_call" && i.call_id === "call_a"));
  assert.ok(second.input.some((i) => i.type === "function_call_output" && i.call_id === "call_a"));
});

test("createModelProvider respects OPENAGI_PROVIDER preference", async () => {
  const { createModelProvider } = await import("../src/model-provider.js");
  const original = process.env.OPENAGI_PROVIDER;
  const aOriginal = process.env.ANTHROPIC_API_KEY;
  const oOriginal = process.env.OPENAI_API_KEY;
  process.env.ANTHROPIC_API_KEY = "fake-ant";
  process.env.OPENAI_API_KEY = "fake-oai";

  process.env.OPENAGI_PROVIDER = "auto";
  let p = createModelProvider();
  assert.equal(p.constructor.name, "AnthropicProvider");

  process.env.OPENAGI_PROVIDER = "openai";
  p = createModelProvider();
  assert.equal(p.constructor.name, "OpenAIResponsesProvider");

  process.env.OPENAGI_PROVIDER = "anthropic";
  p = createModelProvider();
  assert.equal(p.constructor.name, "AnthropicProvider");

  // Restore
  if (original) process.env.OPENAGI_PROVIDER = original;
  else delete process.env.OPENAGI_PROVIDER;
  if (aOriginal) process.env.ANTHROPIC_API_KEY = aOriginal;
  else delete process.env.ANTHROPIC_API_KEY;
  if (oOriginal) process.env.OPENAI_API_KEY = oOriginal;
  else delete process.env.OPENAI_API_KEY;
});

test("HTTP MCP client speaks Streamable HTTP with bearer auth (mocked fetch)", async () => {
  const { McpHttpClient } = await import("../src/index.js");
  const calls = [];
  const responseQueue = [
    // initialize
    { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "sess-123" },
      body: { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", serverInfo: { name: "test" } } } },
    // notifications/initialized → 202
    { status: 202, headers: {}, body: "" },
    // tools/list
    { status: 200, headers: { "content-type": "application/json" },
      body: { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "ping", description: "ping" }] } } }
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    const next = responseQueue.shift();
    return {
      ok: next.status < 400,
      status: next.status,
      statusText: "OK",
      headers: { get: (k) => next.headers[k.toLowerCase()] ?? null },
      json: async () => typeof next.body === "string" ? {} : next.body,
      text: async () => typeof next.body === "string" ? next.body : JSON.stringify(next.body),
      body: { getReader: () => ({ read: async () => ({ done: true, value: null }) }) }
    };
  };
  try {
    const client = new McpHttpClient({
      name: "test",
      url: "https://example.com/mcp",
      bearerToken: "secret-key"
    });
    await client.connect();
    assert.equal(client.connected, true);
    assert.equal(client.tools.length, 1);
    assert.equal(client.tools[0].name, "ping");
    assert.equal(client.sessionId, "sess-123");
    // Verify Authorization header was sent
    assert.equal(calls[0].headers.authorization, "Bearer secret-key");
    // Second + third requests echo the session id captured from initialize
    assert.equal(calls[1].headers["mcp-session-id"], "sess-123");
    assert.equal(calls[2].headers["mcp-session-id"], "sess-123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP MCP client parses SSE response body for matching id", async () => {
  const { McpHttpClient } = await import("../src/index.js");
  const sseBody = [
    'data: {"jsonrpc":"2.0","id":99,"result":{"unrelated":true}}',
    "",
    'data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26"}}',
    "",
    ""
  ].join("\n");
  const encoded = new TextEncoder().encode(sseBody);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: (k) => k === "content-type" ? "text/event-stream" : null },
    json: async () => ({}),
    text: async () => sseBody,
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true, value: null };
            sent = true;
            return { done: false, value: encoded };
          }
        };
      }
    }
  });
  try {
    const client = new McpHttpClient({ name: "sse", url: "https://x.example/mcp" });
    // Bypass the rest of initialize by directly invoking request after stubbing the protocol step
    const result = await client.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    assert.equal(result.protocolVersion, "2025-03-26");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OAuth client discovery falls back to openid-configuration when oauth-authorization-server is missing", async () => {
  const { McpOAuthClient } = await import("../src/index.js");
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const u = String(url);
    if (u.endsWith("/.well-known/oauth-protected-resource")) {
      return { ok: true, json: async () => ({ authorization_servers: ["https://auth.example/realms/x"] }) };
    }
    if (u.endsWith("/.well-known/oauth-authorization-server")) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    if (u.endsWith("/.well-known/openid-configuration")) {
      return { ok: true, json: async () => ({
        authorization_endpoint: "https://auth.example/auth",
        token_endpoint: "https://auth.example/token",
        registration_endpoint: "https://auth.example/register"
      }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-oauth-"));
    const client = new McpOAuthClient({ name: "test-mcp", resourceUrl: "https://mcp.example", dataDir: dir });
    const discovery = await client.discover();
    assert.equal(discovery.serverMeta.token_endpoint, "https://auth.example/token");
    assert.ok(calls.some((c) => c.endsWith("openid-configuration")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("observation store records activity + frames and surfaces stats", async () => {
  const { ObservationStore } = await import("../src/index.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-obs-"));
  const store = new ObservationStore({ dir });
  await store.ready;
  await store.record([
    { kind: "activity", at: "2026-05-08T12:00:00Z", app: "Linear", window: "Linear · Roadmap", event: "focus" },
    { kind: "activity", at: "2026-05-08T12:01:00Z", app: "Slack", window: "Slack · #general", event: "focus" },
    { kind: "frame", at: "2026-05-08T12:00:30Z", app: "Linear", window: "Linear · Roadmap", frameId: "f1", ocrText: "OpenAGI roadmap quarterly review", confidence: 0.9 }
  ]);
  const stats = await store.stats();
  // Either sqlite or fallback-jsonl, both acceptable; in both cases counts > 0.
  if (stats.mode === "sqlite") {
    assert.ok(stats.activity >= 2);
    assert.ok(stats.frames >= 1);
  } else {
    assert.ok(stats.observations >= 3);
  }
});

test("recall_activity tool returns observations matching a query", async () => {
  const runtime = createDefaultRuntime();
  await runtime.observations.ready;
  await runtime.observations.record([
    { kind: "activity", at: "2026-05-08T09:30:00Z", app: "Calendar", window: "Standup · 9am Mondays", event: "focus" },
    { kind: "activity", at: "2026-05-08T10:00:00Z", app: "Linear", window: "Linear · Sprint 7", event: "focus" }
  ]);
  const tool = runtime.tools.get("recall_activity");
  assert.ok(tool, "recall_activity tool should be registered");
  const result = await runtime.tools.invoke("recall_activity", { query: "standup", limit: 5 });
  assert.equal(result.ok, true);
  assert.ok(result.result.count >= 1);
});

test("pattern miner detects repeating sequences and writes a candidate", async () => {
  const { PatternMiner, DeterministicModelProvider } = await import("../src/index.js");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mine-"));
  const runtime = createDefaultRuntime({
    modelProvider: new DeterministicModelProvider()
  });

  const days = ["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04"];
  for (const day of days) {
    await runtime.observations.record([
      { kind: "activity", at: `${day}T09:00:00Z`, app: "Calendar", event: "focus" },
      { kind: "activity", at: `${day}T09:01:00Z`, app: "Linear", event: "focus" },
      { kind: "activity", at: `${day}T09:02:00Z`, app: "Slack", event: "focus" }
    ]);
  }
  const miner = new PatternMiner({ runtime, dataDir, minOccurrences: 3, minConfidence: 0.3 });
  const result = await miner.mine({ now: new Date("2026-05-05T00:00:00Z") });
  assert.ok(result.candidates >= 1, `expected at least one candidate, got ${result.candidates ?? 0} (mined: ${result.mined})`);
  const list = miner.list();
  assert.ok(list.length >= 1);
  assert.ok(list[0].sequence.apps.length >= 3);
});

test("skill replay parses frontmatter steps and validates the action vocabulary", async () => {
  const { parseReplayBlock } = await import("../src/index.js");
  const md = `---
name: morning-brief
description: Open standup tools.
replay:
  - open_app: "Linear"
  - wait: 1.5
  - keyboard_shortcut: "cmd+k"
  - type: "OpenAGI roadmap"
  - press: "Return"
---

Body of the skill goes here.`;
  const steps = parseReplayBlock(md);
  assert.ok(steps);
  assert.equal(steps.length, 5);
  assert.equal(Object.keys(steps[0])[0], "open_app");
  assert.equal(steps[1].wait, 1.5);
  assert.equal(steps[2].keyboard_shortcut, "cmd+k");
});

test("skill replay rejects steps with unknown actions", async () => {
  const { SkillReplay } = await import("../src/index.js");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-replay-"));
  const replay = new SkillReplay({ dataDir });
  // Fake an emitter so it doesn't bail on the missing one.
  replay.bindEvents({ emit: () => {} });
  await assert.rejects(
    () => replay.run({ skill: "fake", steps: [{ rm_rf: "/" }] }),
    /Invalid replay steps/
  );
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

test("TaskStore: add → list → complete → bucket auto-promotes to done", async () => {
  const { TaskStore } = await import("../src/task-store.js");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-"));
  const store = new TaskStore({ dataDir });

  const a = store.add({ title: "Buy milk", priority: 80 });
  const b = store.add({ title: "Ship", bucket: "this_week" }, { queue: "agent" });
  store.add({ title: "Get bread" });

  assert.equal(store.list({ queue: "user" }).length, 2);
  assert.equal(store.list({ queue: "agent" }).length, 1);

  const next = store.agentPickNext();
  assert.equal(next?.id, b.id, "agent_pick_next should pop the agent-queued task");

  store.complete(a.id);
  const completed = store.list({ status: "completed" });
  assert.equal(completed.length, 1);
  assert.equal(completed[0].bucket, "done", "completed tasks auto-move to done bucket");
});

test("TaskStore: replays JSONL on cold start when no snapshot", async () => {
  const { TaskStore } = await import("../src/task-store.js");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-replay-"));
  const a = new TaskStore({ dataDir });
  const t = a.add({ title: "Persistent" });
  assert.ok(a.get(t.id));
  // Wipe the snapshot but keep the JSONL log
  fs.unlinkSync(path.join(dataDir, "tasks", "snapshot.json"));
  const b = new TaskStore({ dataDir });
  assert.ok(b.get(t.id), "task should survive snapshot deletion via JSONL replay");
  assert.equal(b.get(t.id).title, "Persistent");
});

test("detectTaskInChat: explicit prefix + intent forms", async () => {
  const { detectTaskInChat } = await import("../src/task-store.js");
  assert.equal(detectTaskInChat("remind me to buy milk").title, "buy milk");
  assert.equal(detectTaskInChat("todo: ship release").title, "ship release");
  assert.equal(detectTaskInChat("I need to call my mom").title, "call my mom");
  assert.equal(detectTaskInChat("don't forget to email Sarah").title, "email Sarah");
  assert.equal(detectTaskInChat("just thinking out loud"), null);
  assert.equal(detectTaskInChat("hi"), null, "too short");
  assert.equal(detectTaskInChat("I should go"), null, "intent form needs ≥3 words after");
});

test("inbox parseTaskLine: GitHub checkboxes + explicit prefixes", async () => {
  const { parseTaskLine } = await import("../src/integrations/inbox-watcher.js");
  assert.deepEqual(parseTaskLine("- [ ] Buy milk"), { completed: false, title: "Buy milk" });
  assert.deepEqual(parseTaskLine("- [x] Ship"), { completed: true, title: "Ship" });
  assert.deepEqual(parseTaskLine("* [ ] Review PR #42"), { completed: false, title: "Review PR #42" });
  assert.deepEqual(parseTaskLine("TODO: call mom"), { completed: false, title: "call mom" });
  assert.deepEqual(parseTaskLine("REMINDER: take out trash"), { completed: false, title: "take out trash" });
  assert.equal(parseTaskLine("## Heading"), null);
  assert.equal(parseTaskLine("just text"), null);
  assert.equal(parseTaskLine(""), null);
});

function makeMcpRegistryTmpDir(prefix = "openagi-mcp-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, configPath: path.join(dir, "mcp.json") };
}

test("McpRegistry persist: ${VAR} placeholder round-trips, raw key is rejected", async () => {
  const { McpRegistry } = await import("../src/mcp-registry.js");
  const { dir, configPath } = makeMcpRegistryTmpDir();

  const r = new McpRegistry({
    dataDir: dir,
    configPath,
    permittedEnvKeys: new Set(["STRIPE_MCP_API_KEY"])
  });
  process.env.STRIPE_MCP_API_KEY = "sk_test_round_trip";

  // Placeholder form persists with the placeholder text intact.
  r.registerServer({
    name: "stripe",
    url: "https://mcp.stripe.com/",
    transport: "http",
    auth: "bearer",
    apiKey: "${STRIPE_MCP_API_KEY}"
  });
  assert.ok(fs.existsSync(configPath), "mcp.json was written");
  const onDisk = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(onDisk.servers.stripe.apiKey, "${STRIPE_MCP_API_KEY}",
    "placeholder is preserved on disk, never the raw secret");

  // A second registry constructed from the same configPath expands the
  // placeholder against the current env when loadConfigFile runs.
  const r2 = new McpRegistry({
    dataDir: dir,
    configPath,
    permittedEnvKeys: new Set(["STRIPE_MCP_API_KEY"])
  });
  r2.loadConfigFile(configPath);
  assert.equal(r2.servers.get("stripe").apiKey, "sk_test_round_trip",
    "loaded registration expands ${VAR} from process.env");

  // Raw bearer is refused — would otherwise leak into mcp.json.
  assert.throws(
    () => r.registerServer({
      name: "stripe-raw",
      url: "https://mcp.stripe.com/",
      transport: "http",
      auth: "bearer",
      apiKey: "sk_live_real_secret_here"
    }),
    /refusing to persist a literal apiKey/
  );

  fs.rmSync(dir, { recursive: true });
  delete process.env.STRIPE_MCP_API_KEY;
});

test("McpRegistry allowEnvKey extends the in-memory permitted set", async () => {
  const { McpRegistry } = await import("../src/mcp-registry.js");
  const { dir, configPath } = makeMcpRegistryTmpDir();
  const r = new McpRegistry({ dataDir: dir, configPath, permittedEnvKeys: new Set() });

  // Without the env key allowlisted, ${...} expansion throws.
  assert.throws(
    () => r.registerServer({
      name: "ph",
      url: "https://mcp.posthog.com/sse",
      transport: "http",
      auth: "bearer",
      apiKey: "${POSTHOG_MCP_API_KEY}"
    }),
    /not in the env allowlist/
  );

  // After allowEnvKey, the same registration succeeds.
  process.env.POSTHOG_MCP_API_KEY = "phx_test";
  r.allowEnvKey("POSTHOG_MCP_API_KEY");
  const ok = r.registerServer({
    name: "ph",
    url: "https://mcp.posthog.com/sse",
    transport: "http",
    auth: "bearer",
    apiKey: "${POSTHOG_MCP_API_KEY}"
  });
  assert.equal(ok.apiKey, "phx_test");

  fs.rmSync(dir, { recursive: true });
  delete process.env.POSTHOG_MCP_API_KEY;
});

test("ToolRegistry: needsConfirmation gate queues action instead of running", async () => {
  const { ToolRegistry } = await import("../src/tool-registry.js");
  const { PendingActionStore } = await import("../src/pending-actions.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-pending-"));
  const pending = new PendingActionStore({ dir });
  const tools = new ToolRegistry();
  tools.bindPendingActions(pending);

  let ran = 0;
  tools.register({
    name: "do_thing",
    description: "test",
    needsConfirmation: true,
    summarize: (args) => `Do thing with ${args.x}`,
    handler: async (args) => { ran++; return { didIt: args.x }; }
  });

  // Without __confirmed, the call queues instead of running.
  const queued = await tools.invoke("do_thing", { x: 42 }, { sessionId: "s1" });
  assert.equal(ran, 0, "handler did not execute");
  assert.equal(queued.ok, true);
  assert.equal(queued.result.status, "awaiting_confirmation");
  assert.equal(queued.result.summary, "Do thing with 42");

  const list = pending.list({ status: "pending" });
  assert.equal(list.length, 1);
  assert.equal(list[0].toolName, "do_thing");
  assert.equal(list[0].args.x, 42);
  assert.equal(list[0].context.sessionId, "s1");

  // With __confirmed, it bypasses the queue and runs.
  const ok = await tools.invoke("do_thing", { x: 99 }, { __confirmed: true });
  assert.equal(ran, 1);
  assert.deepEqual(ok.result, { didIt: 99 });

  fs.rmSync(dir, { recursive: true });
});

test("PendingActionStore: enqueue + decide + replay across instances", async () => {
  const { PendingActionStore } = await import("../src/pending-actions.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-pending-replay-"));
  const a = new PendingActionStore({ dir });
  const action = a.enqueue({
    toolName: "connect_catalog_mcp",
    args: { catalogId: "stripe", apiKey: "sk_test_x" },
    context: { sessionId: "s1", channel: "local" },
    summary: "Connect MCP: stripe"
  });
  assert.equal(action.status, "pending");
  const decided = a.decide(action.id, { decision: "approve", decidedBy: "user", result: { ok: true } });
  assert.equal(decided.status, "approved");

  // New instance reads journal and recovers the same state.
  const b = new PendingActionStore({ dir });
  const recovered = b.get(action.id);
  assert.equal(recovered.status, "approved");
  assert.equal(recovered.summary, "Connect MCP: stripe");
  assert.equal(recovered.toolName, "connect_catalog_mcp");

  // Re-deciding a decided action is idempotent (returns existing state).
  const noop = b.decide(action.id, { decision: "deny" });
  assert.equal(noop.status, "approved", "second decide does not flip an already-decided action");

  fs.rmSync(dir, { recursive: true });
});

test("skill-materialize: accepted skill suggestion writes SKILL.md with stamped lineage", async () => {
  const { createSkillFromSuggestion, slugify, dedupeSlug } = await import("../src/skill-materialize.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-skill-mat-"));
  const bundled = path.join(dir, "bundled");
  const userDir = path.join(dir, "user");
  fs.mkdirSync(bundled, { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });

  const fakeRuntime = { skills: { dirs: [bundled, userDir], reload: () => {} } };
  const suggestion = {
    id: "sug-abc-123",
    title: "Morning Standup Brief",
    rationale: "User reviews Slack + GitHub every morning at 9am",
    category: "skill",
    draftBody: "Compose a morning standup for the user.\n\n1. Call recall for...\n"
  };
  const result = createSkillFromSuggestion({ runtime: fakeRuntime, suggestion });
  assert.equal(result.slug, "morning-standup-brief");

  const written = fs.readFileSync(result.path, "utf8");
  assert.match(written, /name: morning-standup-brief/);
  assert.match(written, /sourceSuggestionId: sug-abc-123/, "lineage stamped into frontmatter");
  assert.match(written, /createdBy: proactive-observer/);
  assert.match(written, /1\. Call recall for/, "draftBody preserved");

  // Slugify edge cases.
  assert.equal(slugify("Already-kebab-OK"), "already-kebab-ok");
  assert.equal(slugify("emoji 🚀 trimmed"), "emoji-trimmed");
  assert.equal(slugify(""), "untitled-skill");
  assert.equal(slugify(null), "untitled-skill");

  // Dedupe.
  assert.equal(dedupeSlug(userDir, "fresh-name"), "fresh-name");
  assert.equal(dedupeSlug(userDir, "morning-standup-brief"), "morning-standup-brief-2", "existing slug gets -2");

  // Refuse if no draftBody (observer proposed an automation, not a skill).
  assert.throws(() => createSkillFromSuggestion({
    runtime: fakeRuntime,
    suggestion: { id: "x", title: "noop", category: "skill" }
  }), /draftBody/);

  // Refuse if runtime has only bundled (no writable user dir).
  const noUserRuntime = { skills: { dirs: [bundled], reload: () => {} } };
  assert.throws(() => createSkillFromSuggestion({
    runtime: noUserRuntime,
    suggestion: { id: "x", title: "t", category: "skill", draftBody: "b" }
  }), /no user skills directory/);

  fs.rmSync(dir, { recursive: true });
});

test("ComputerUseLog: session lifecycle + action recording with reasoning", async () => {
  const { ComputerUseLog } = await import("../src/computer-use-log.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-cu-"));
  const log = new ComputerUseLog({ dir });

  const session = log.startSession({ goal: "Reply to my last email", approvedBy: "user" });
  assert.equal(session.status, "active");
  assert.equal(session.goal, "Reply to my last email");

  // Recording requires an active session.
  const action = log.recordAction({
    sessionId: session.id,
    kind: "click",
    args: { x: 100, y: 200, button: "left" },
    reasoning: "Clicking the Reply button in the toolbar"
  });
  assert.equal(action.status, "pending");
  assert.equal(action.reasoning, "Clicking the Reply button in the toolbar");
  assert.equal(action.args.x, 100);

  log.markActionResult(action.id, { status: "executed", result: { ok: true } });
  assert.equal(log.listActions({ sessionId: session.id })[0].status, "executed");

  // Cannot record into a closed session.
  log.endSession(session.id, { reason: "test", status: "ended" });
  assert.throws(() => log.recordAction({
    sessionId: session.id,
    kind: "type",
    args: { text: "hi" },
    reasoning: "—"
  }), /not active/);

  // Replay from a fresh instance recovers everything.
  const log2 = new ComputerUseLog({ dir });
  const recovered = log2.getSession(session.id);
  assert.equal(recovered.status, "ended");
  assert.equal(recovered.endReason, "test");
  assert.equal(log2.listActions({ sessionId: session.id }).length, 1);

  fs.rmSync(dir, { recursive: true });
});

test("computer-use: dynamic register + unregister via toggle helpers", async () => {
  const { ToolRegistry } = await import("../src/tool-registry.js");
  const {
    registerComputerUseTools,
    unregisterComputerUseTools,
    COMPUTER_USE_TOOL_NAMES,
    isComputerUseEnabled
  } = await import("../src/integrations/computer-use.js");
  const { ComputerUseLog } = await import("../src/computer-use-log.js");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-cu-toggle-"));
  const registry = new ToolRegistry();
  const fakeRuntime = {
    tools: registry,
    computerUseLog: new ComputerUseLog({ dir }),
    observations: { search: async () => [] }
  };

  // isComputerUseEnabled reads process.env live, not cached.
  const wasSet = process.env.OPENAGI_COMPUTER_USE;
  delete process.env.OPENAGI_COMPUTER_USE;
  assert.equal(isComputerUseEnabled(), false, "off when env not set");
  process.env.OPENAGI_COMPUTER_USE = "1";
  assert.equal(isComputerUseEnabled(), true, "on after env flip");

  // Register adds all tools.
  registerComputerUseTools(registry, fakeRuntime);
  for (const name of COMPUTER_USE_TOOL_NAMES) {
    assert.ok(registry.has(name), `expected ${name} present after register`);
  }

  // Unregister removes exactly those tools.
  const removed = unregisterComputerUseTools(registry);
  assert.equal(removed, COMPUTER_USE_TOOL_NAMES.length, "unregister returns count");
  for (const name of COMPUTER_USE_TOOL_NAMES) {
    assert.equal(registry.has(name), false, `expected ${name} absent after unregister`);
  }

  if (wasSet === undefined) delete process.env.OPENAGI_COMPUTER_USE;
  else process.env.OPENAGI_COMPUTER_USE = wasSet;
  fs.rmSync(dir, { recursive: true });
});

test("saveEnv: clear list removes the key from .env and process.env", async () => {
  const { saveEnv, readExistingEnv } = await import("../src/setup-wizard.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-saveenv-clear-"));

  // Set a key, confirm it lands in .env.
  saveEnv({ dataDir: dir, values: { OPENAGI_COMPUTER_USE: "1" } });
  let text = readExistingEnv(dir);
  assert.match(text, /OPENAGI_COMPUTER_USE=1/, "value written");
  assert.equal(process.env.OPENAGI_COMPUTER_USE, "1");

  // Clear it.
  saveEnv({ dataDir: dir, values: {}, clear: ["OPENAGI_COMPUTER_USE"] });
  text = readExistingEnv(dir);
  assert.doesNotMatch(text, /OPENAGI_COMPUTER_USE=/, "value removed from .env");
  assert.equal(process.env.OPENAGI_COMPUTER_USE, undefined, "value removed from process.env");

  // clear with a non-allowlisted key is a no-op (safe — can't be tricked
  // into deleting arbitrary env vars).
  process.env.AWS_SECRET_KEY = "decoy";
  saveEnv({ dataDir: dir, values: {}, clear: ["AWS_SECRET_KEY"] });
  assert.equal(process.env.AWS_SECRET_KEY, "decoy", "non-allowlisted key not cleared");
  delete process.env.AWS_SECRET_KEY;

  fs.rmSync(dir, { recursive: true });
});

test("computer-use tools register only when OPENAGI_COMPUTER_USE flag is set", async () => {
  const { createDefaultRuntime } = await import("../src/index.js");

  const wasSet = process.env.OPENAGI_COMPUTER_USE;
  delete process.env.OPENAGI_COMPUTER_USE;
  const noFlag = createDefaultRuntime();
  const noFlagNames = noFlag.tools.list().map((t) => t.name);
  assert.equal(noFlagNames.includes("start_computer_use_session"), false, "tools absent by default");

  process.env.OPENAGI_COMPUTER_USE = "1";
  const withFlag = createDefaultRuntime();
  const withFlagNames = withFlag.tools.list().map((t) => t.name);
  for (const name of ["start_computer_use_session", "computer_click", "computer_type", "computer_key", "computer_screenshot", "end_computer_use_session"]) {
    assert.ok(withFlagNames.includes(name), `expected tool ${name} to be registered when flag is on`);
  }
  // start_computer_use_session is gated by needsConfirmation.
  const startTool = withFlag.tools.get("start_computer_use_session");
  assert.equal(startTool.needsConfirmation, true, "session start requires user approval");

  if (wasSet === undefined) delete process.env.OPENAGI_COMPUTER_USE;
  else process.env.OPENAGI_COMPUTER_USE = wasSet;
});

test("register_mcp_server.summarize: stdio call exposes command + args", async () => {
  const { summarizeRegisterMcpServer } = await import("../src/tool-registry.js");
  const summary = summarizeRegisterMcpServer({
    name: "linear-helper",
    transport: "stdio",
    command: "docker",
    args: ["run", "--rm", "-v", "$HOME:/host", "alpine"]
  });
  // The dangerous fields (command, first args) MUST appear in the summary
  // string so a user approving the menu-bar notification can see what
  // they're approving. This is the C1 review finding.
  assert.match(summary, /docker/, "command appears in summary");
  assert.match(summary, /run/, "first arg appears in summary");
  assert.match(summary, /-v/, "second arg appears in summary");
  assert.match(summary, /linear-helper/, "server name appears in summary");
  assert.match(summary, /…|\.\.\./u, "truncation marker when args >3");
});

test("register_mcp_server.summarize: http call exposes URL + auth", async () => {
  const { summarizeRegisterMcpServer } = await import("../src/tool-registry.js");
  const summary = summarizeRegisterMcpServer({
    name: "evil-mcp",
    transport: "http",
    url: "https://attacker.example.com/mcp",
    auth: "bearer"
  });
  assert.match(summary, /attacker\.example\.com/, "URL host appears in summary");
  assert.match(summary, /bearer/, "auth mode appears in summary");
  assert.match(summary, /evil-mcp/, "server name appears in summary");
});

test("register_mcp_server.summarize: short stdio doesn't add ellipsis", async () => {
  const { summarizeRegisterMcpServer } = await import("../src/tool-registry.js");
  const summary = summarizeRegisterMcpServer({
    name: "fs",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"]
  });
  // With ≤3 args the truncation marker should be absent.
  assert.doesNotMatch(summary, /…|\.\.\./u, "no ellipsis when args fit");
  assert.match(summary, /npx/);
  assert.match(summary, /server-filesystem/);
});

test("connect_catalog_mcp.summarize: with apiKey shows prefix to detect substitution", async () => {
  const { ToolRegistry, registerCoreTools } = await import("../src/tool-registry.js");
  const fakeRuntime = {
    memory: { remember: () => ({}), retrieve: () => [] },
    cron: { addJob: () => ({}), listJobs: () => [], removeJob: () => false },
    mcp: { listServers: () => [], listTools: () => [], registerServer: () => ({}), connect: () => Promise.resolve(), disconnect: () => Promise.resolve() },
    channels: { deliver: () => ({}) },
    introspector: { audit: () => ({}) },
    budget: { status: () => ({}) },
    skills: { list: () => [], run: () => ({}) },
    skillReplay: { run: () => ({}) },
    propagation: { retire: () => null },
    observations: { search: async () => [] },
    tasks: { add: () => ({}), list: () => [], complete: () => null, update: () => null, agentPickNext: () => null },
    agentHost: { store: { listSessions: () => [], listAgents: () => [] } }
  };
  const registry = new ToolRegistry();
  registerCoreTools(registry, fakeRuntime);

  const tool = registry.get("connect_catalog_mcp");
  assert.ok(tool.summarize, "connect_catalog_mcp has summarize");

  // Without apiKey — plain summary.
  const noKey = tool.summarize({ catalogId: "stripe" });
  assert.equal(noKey, "Connect MCP: stripe");

  // With apiKey — first 8 chars shown so user can detect a substituted key.
  const withKey = tool.summarize({ catalogId: "stripe", apiKey: "sk_live_realkey123" });
  assert.match(withKey, /sk_live_/, "first 8 chars of key appear in summary");
  assert.doesNotMatch(withKey, /realkey123/, "rest of key is not shown");
});

test("ToolRegistry.invoke: gated tool's summary persists through to pending action", async () => {
  // End-to-end: when the agent invokes register_mcp_server with a hidden
  // docker-run-as-host payload, the queued pending action's summary must
  // contain the dangerous fields — not just the friendly name.
  const { ToolRegistry, registerCoreTools } = await import("../src/tool-registry.js");
  const { PendingActionStore } = await import("../src/pending-actions.js");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-summary-"));
  const pending = new PendingActionStore({ dir: tmp });
  const registry = new ToolRegistry();
  registry.bindPendingActions(pending);

  const fakeRuntime = {
    mcp: { registerServer: () => ({ name: "x", transport: "stdio" }) }
  };
  registerCoreTools(registry, fakeRuntime);

  const result = await registry.invoke("register_mcp_server", {
    name: "innocuous-looking",
    transport: "stdio",
    command: "docker",
    args: ["run", "--rm", "-v", "/:/host", "alpine"]
  }, { sessionId: "test" });

  assert.equal(result.result.status, "awaiting_confirmation");
  const queued = pending.get(result.result.actionId);
  assert.match(queued.summary, /docker/, "queued summary exposes command");
  assert.match(queued.summary, /-v/, "queued summary exposes mount arg");
  fs.rmSync(tmp, { recursive: true });
});

test("approval cards: args render with <details open> by default (C4 regression)", async () => {
  // The dashboard's approval cards used to render <details> closed, so users
  // glancing at the card might approve without seeing the args. This test
  // pins the open-by-default behavior in both the chat-deep-link card and
  // the suggestions-tab card, so they don't quietly drift back to closed.
  const fsLocal = await import("node:fs");
  const src = fsLocal.readFileSync(new URL("../src/hosted-interface.js", import.meta.url), "utf8");

  // Count <details open ...> tags. There should be at least 2 — one for
  // each approval-card surface (renderChatDeepLink + renderSuggestions).
  const openDetails = src.match(/<details\s+open\b/g) ?? [];
  assert.ok(openDetails.length >= 2, `expected ≥2 <details open> in approval cards, got ${openDetails.length}`);

  // No `<details>` for approval args should be missing the open attr.
  // Find approval-context details (the ones immediately followed by an
  // args dump in JSON.stringify(action.args... or a.args).
  const closedNearArgs = src.match(/<details\s+style="[^"]*"><summary[^>]*>(view args|args)<\/summary>[^<]*<pre[^>]*>\$\{escapeHtml\(JSON\.stringify\((action|a)\.args/g) ?? [];
  assert.equal(closedNearArgs.length, 0, "no closed <details> blocks around action.args / a.args");
});

test("IMessagePollerSource: skips when not enabled or self-handle missing", async () => {
  const { IMessagePollerSource } = await import("../src/integrations/imessage-poller.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-im-"));

  // Save and clear env so the constructor doesn't pick up an enabled
  // state from the user's real shell.
  const savedEnabled = process.env.IMESSAGE_ENABLED;
  const savedHandle = process.env.IMESSAGE_SELF_HANDLE;
  delete process.env.IMESSAGE_ENABLED;
  delete process.env.IMESSAGE_SELF_HANDLE;

  const fakeRuntime = { tasks: { add: () => {} } };
  const src = new IMessagePollerSource({ runtime: fakeRuntime, dataDir: tmp });

  let result = await src.sync();
  assert.equal(result.skipped, true, "skips when not enabled");
  assert.match(result.reason, /IMESSAGE_ENABLED/);

  process.env.IMESSAGE_ENABLED = "1";
  result = await src.sync();
  assert.equal(result.skipped, true, "still skips when self-handle missing");
  assert.match(result.reason, /SELF_HANDLE/);

  if (savedEnabled !== undefined) process.env.IMESSAGE_ENABLED = savedEnabled; else delete process.env.IMESSAGE_ENABLED;
  if (savedHandle !== undefined) process.env.IMESSAGE_SELF_HANDLE = savedHandle; else delete process.env.IMESSAGE_SELF_HANDLE;
  fs.rmSync(tmp, { recursive: true });
});

test("IMessagePollerSource: status() reports permission error when chat.db unreadable", async () => {
  const { IMessagePollerSource } = await import("../src/integrations/imessage-poller.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-im2-"));

  // Point at a path that doesn't exist — status() should report dbExists:false.
  const src = new IMessagePollerSource({
    runtime: { tasks: { add: () => {} } },
    dataDir: tmp,
    dbPath: path.join(tmp, "no-such-db.sqlite")
  });
  const s = src.status();
  assert.equal(s.dbExists, false);
  assert.equal(s.readable, false);
  assert.equal(s.requiresFullDiskAccess, false, "no FDA prompt when file simply doesn't exist");

  // Now a real file with no read perms — should set requiresFullDiskAccess.
  const blocked = path.join(tmp, "blocked.sqlite");
  fs.writeFileSync(blocked, "fake");
  fs.chmodSync(blocked, 0o000);
  const src2 = new IMessagePollerSource({
    runtime: { tasks: { add: () => {} } },
    dataDir: tmp,
    dbPath: blocked
  });
  const s2 = src2.status();
  // (On macOS as root or as the file owner, chmod 0 may still allow read —
  // skip the FDA assertion gracefully if we happen to be able to read.)
  if (!s2.readable) {
    assert.equal(s2.dbExists, true);
    assert.equal(s2.requiresFullDiskAccess, true);
    assert.match(s2.permissionError ?? "", /Full Disk Access|EACCES|denied/i);
  }

  fs.chmodSync(blocked, 0o600);
  fs.rmSync(tmp, { recursive: true });
});

test("McpRegistry: stdio args get ${VAR} expansion (statsig mcp-remote bridge)", async () => {
  const { McpRegistry } = await import("../src/mcp-registry.js");
  const fs = await import("node:fs");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-mcp-args-"));
  const r = new McpRegistry({
    dataDir: tmpDir,
    configPath: path.join(tmpDir, "mcp.json"),
    permittedEnvKeys: new Set(["STATSIG_API_KEY"])
  });
  process.env.STATSIG_API_KEY = "secret-statsig-key";

  const reg = r.registerServer({
    name: "statsig",
    transport: "stdio",
    command: "npx",
    args: ["-y", "mcp-remote", "https://api.statsig.com/v1/mcp", "--header", "statsig-api-key=${STATSIG_API_KEY}"]
  });

  // Expanded form is what gets handed to the spawn — secret resolved.
  assert.deepEqual(reg.args, ["-y", "mcp-remote", "https://api.statsig.com/v1/mcp", "--header", "statsig-api-key=secret-statsig-key"]);

  // Persisted form keeps the placeholder so the secret never lands on disk.
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, "mcp.json"), "utf8"));
  assert.equal(onDisk.servers.statsig.args[4], "statsig-api-key=${STATSIG_API_KEY}");

  fs.rmSync(tmpDir, { recursive: true });
  delete process.env.STATSIG_API_KEY;
});

test("McpRegistry persist surfaces filesystem errors instead of swallowing", async () => {
  const { McpRegistry } = await import("../src/mcp-registry.js");
  // Point configPath at a file under a path that can't exist (component
  // already exists as a regular file). writeJsonAtomic's mkdirSync will
  // throw, which we expect to propagate.
  const { dir } = makeMcpRegistryTmpDir();
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "i am a file, not a directory");
  const configPath = path.join(blocker, "subdir", "mcp.json");

  const r = new McpRegistry({ dataDir: dir, configPath, permittedEnvKeys: new Set() });
  assert.throws(
    () => r.registerServer({
      name: "stdio-fs",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    })
  );

  fs.rmSync(dir, { recursive: true });
});
