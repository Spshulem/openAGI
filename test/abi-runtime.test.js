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
  // Isolate the observation store to this temp dir — otherwise it shares
  // the real ~/.openagi/observations DB and the test's 12 seeded events get
  // drowned by thousands of unrelated real ones (the mined sequence then
  // never clears the confidence bar).
  const runtime = createDefaultRuntime({
    modelProvider: new DeterministicModelProvider(),
    observationOptions: { dir: path.join(dataDir, "observations") }
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

test("task-store: dependsOn — blocked tasks auto-unblock when all deps complete", async () => {
  const { TaskStore } = await import("../src/task-store.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-deps-"));
  const events = [];
  const store = new TaskStore({
    dataDir: dir,
    runtime: { events: { emit: (name, data) => events.push({ name, data }) } }
  });

  const a = store.add({ title: "Write the spec" });
  const b = store.add({ title: "Ship the code", dependsOn: [a.id] });
  // b is blocked until a completes.
  assert.equal(store.tasks.get(b.id).status, "blocked", "task with unmet dep starts blocked");

  // Completing a should auto-unblock b + fire event.
  store.complete(a.id, "manual");
  assert.equal(store.tasks.get(b.id).status, "pending", "dependent auto-flipped to pending");
  const unblockEvent = events.find((e) => e.name === "task-unblocked");
  assert.ok(unblockEvent, "task-unblocked event fired");
  assert.equal(unblockEvent.data.task.id, b.id);
  assert.equal(unblockEvent.data.completedDepId, a.id);

  // Recent unblocks ring buffer captures it for the daily recap.
  assert.equal(store.recentUnblocks.length, 1);

  // Multi-dep: c needs both a and b. Already a is done, but b still
  // pending → c starts blocked.
  const c = store.add({ title: "Tell the team", dependsOn: [a.id, b.id] });
  assert.equal(store.tasks.get(c.id).status, "blocked");
  // Complete b → c unblocks.
  store.complete(b.id, "manual");
  assert.equal(store.tasks.get(c.id).status, "pending");

  // Missing dep id (task deleted) shouldn't count as unmet.
  const d = store.add({ title: "Standalone", dependsOn: ["task_nonexistent"] });
  assert.equal(store.tasks.get(d.id).status, "pending", "missing dep doesn't block");

  fs.rmSync(dir, { recursive: true });
});

test("task-store: goals as parents — addGoal, linkTaskToGoal, goalProgress rollup", async () => {
  const { TaskStore } = await import("../src/task-store.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-goals-"));
  const store = new TaskStore({ dataDir: dir });

  const goal = store.addGoal({ title: "Ship OpenAGI v0.2", dueDate: "2026-06-30T00:00:00Z" });
  assert.equal(goal.status, "active");
  assert.match(goal.id, /^goal_/);

  // Create 3 tasks under the goal; complete 1.
  const t1 = store.add({ title: "Write docs", parentGoalId: goal.id });
  const t2 = store.add({ title: "Wire UI", parentGoalId: goal.id });
  const t3 = store.add({ title: "Add tests", parentGoalId: goal.id });
  store.complete(t1.id, "manual");

  const progress = store.goalProgress(goal.id);
  assert.equal(progress.total, 3);
  assert.equal(progress.done, 1);
  assert.equal(progress.percent, 33.3);

  // Link an unlinked task afterwards.
  const t4 = store.add({ title: "Cut release" });
  assert.equal(store.tasks.get(t4.id).parentGoalId, null);
  store.linkTaskToGoal(t4.id, goal.id);
  assert.equal(store.tasks.get(t4.id).parentGoalId, goal.id);
  assert.equal(store.goalProgress(goal.id).total, 4);

  // Nested goal rollup: parent goal's progress includes child goal's tasks.
  const childGoal = store.addGoal({ title: "Docs site", parentGoalId: goal.id });
  store.add({ title: "Sub-doc 1", parentGoalId: childGoal.id });
  const sub2 = store.add({ title: "Sub-doc 2", parentGoalId: childGoal.id });
  store.complete(sub2.id, "manual");
  const parentRoll = store.goalProgress(goal.id);
  assert.equal(parentRoll.total, 6, "rollup absorbs sub-goal's 2 tasks");
  assert.equal(parentRoll.done, 2, "1 parent done + 1 sub done");
  assert.equal(parentRoll.hasSubGoals, true);

  // Persistence: re-instantiate, goals + links survive.
  const store2 = new TaskStore({ dataDir: dir });
  assert.equal(store2.getGoal(goal.id).title, "Ship OpenAGI v0.2");
  assert.equal(store2.tasks.get(t1.id).parentGoalId, goal.id);

  // Unlink via goalId=null.
  store2.linkTaskToGoal(t4.id, null);
  assert.equal(store2.tasks.get(t4.id).parentGoalId, null);

  fs.rmSync(dir, { recursive: true });
});

test("daily-recap: groups completed tasks by parent goal when goals exist", async () => {
  const { computeDailyRecap, renderDailyRecapMarkdown } = await import("../src/daily-recap.js");
  const goalA = { id: "goal_a", title: "Ship v0.2" };
  const goalB = { id: "goal_b", title: "Hire" };
  const todayAt = (h) => new Date(`2026-05-13T${String(h).padStart(2, "0")}:00:00Z`).toISOString();
  const fakeRuntime = {
    tasks: {
      list: ({ status }) => status === "completed" ? [
        { id: "t1", title: "Write docs", queue: "user", parentGoalId: "goal_a", updatedAt: todayAt(10) },
        { id: "t2", title: "Interview prep", queue: "user", parentGoalId: "goal_b", updatedAt: todayAt(11) },
        { id: "t3", title: "Quick fix", queue: "user", parentGoalId: null, updatedAt: todayAt(12) },
        { id: "t4", title: "Add tests", queue: "user", parentGoalId: "goal_a", updatedAt: todayAt(13) }
      ] : [],
      getGoal: (id) => ({ goal_a: goalA, goal_b: goalB })[id] ?? null,
      goalProgress: (id) => ({
        goal_a: { goalId: "goal_a", total: 5, done: 2, percent: 40 },
        goal_b: { goalId: "goal_b", total: 4, done: 1, percent: 25 }
      })[id] ?? null
    },
    outcomes: { recent: () => [] },
    pendingActions: { list: () => [] },
    computerUseLog: { listActions: () => [] },
    observations: { _recentCache: null },
    proactiveObserver: { list: () => [] },
    agentHost: { store: { listSessions: () => [] } }
  };
  const recap = computeDailyRecap(fakeRuntime, { date: new Date("2026-05-13T18:00:00Z"), timezone: "UTC" });
  assert.equal(recap.tasksByGoal.goal_a.tasks.length, 2);
  assert.equal(recap.tasksByGoal.goal_b.tasks.length, 1);
  assert.equal(recap.tasksByGoal._unassigned.tasks.length, 1);

  const md = renderDailyRecapMarkdown(recap);
  assert.match(md, /Ship v0\.2.*40%/s);
  assert.match(md, /Hire.*25%/s);
  assert.match(md, /no goal/);
});

test("task-store: month/quarter/year buckets exist, auto-bucket from dueDate, migration rebuckets someday", async () => {
  const { TaskStore, BUCKETS, bucketFromDueDate } = await import("../src/task-store.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-buckets-"));

  assert.deepEqual(BUCKETS, ["today", "this_week", "this_month", "this_quarter", "this_year", "someday", "done"]);

  const now = new Date("2026-05-13T12:00:00Z");
  // Pure helper covers the boundaries.
  assert.equal(bucketFromDueDate(null, now), null);
  assert.equal(bucketFromDueDate("2026-05-13T18:00:00Z", now), "today", "<2 days = today");
  assert.equal(bucketFromDueDate("2026-05-19T12:00:00Z", now), "this_week", "<7 days");
  assert.equal(bucketFromDueDate("2026-06-10T12:00:00Z", now), "this_month", "<35 days");
  assert.equal(bucketFromDueDate("2026-07-15T12:00:00Z", now), "this_quarter", "<95 days");
  assert.equal(bucketFromDueDate("2026-10-15T12:00:00Z", now), "this_year", "<365 days");
  assert.equal(bucketFromDueDate("2028-01-01T12:00:00Z", now), "someday", "beyond a year");

  // Auto-bucket from dueDate on add (no explicit bucket).
  const store = new TaskStore({ dataDir: dir });
  const t = store.add({ title: "Quarterly review", dueDate: "2026-08-01T12:00:00Z" });
  assert.equal(t.bucket, "this_quarter", "auto-bucketed from due date");

  // Migration: write a pre-existing someday task with a due date,
  // then re-instantiate to trigger rebucketFromDueDatesOnce.
  // Use a future date a few months out so the test isn't sensitive to
  // the wall-clock moving day-to-day in CI; this puts us solidly in
  // "this_quarter" territory either way.
  const someYearFromNow = new Date(Date.now() + 60 * 86_400_000).toISOString();
  const old = store.add({ title: "Stuck in someday", bucket: "someday", dueDate: someYearFromNow });
  assert.equal(store.tasks.get(old.id).bucket, "someday", "kept where put initially");
  // Force rebucket as if on next boot.
  const moved = store.rebucketFromDueDatesOnce();
  assert.ok(moved >= 1, "migration moved at least one task");
  const moved_bucket = store.tasks.get(old.id).bucket;
  assert.ok(["this_month", "this_quarter"].includes(moved_bucket), `60-day-out task should rebucket to month or quarter, got ${moved_bucket}`);

  fs.rmSync(dir, { recursive: true });
});

test("daily-recap: aggregates completed tasks, skill runs, agent actions for the day", async () => {
  const { computeDailyRecap, renderDailyRecapMarkdown } = await import("../src/daily-recap.js");
  const now = new Date("2026-05-13T18:00:00Z");
  const todayAt = (h, m = 0) => new Date(`2026-05-13T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`).toISOString();
  const yesterdayAt = (h) => new Date(`2026-05-12T${String(h).padStart(2, "0")}:00:00Z`).toISOString();

  const fakeRuntime = {
    tasks: {
      list: ({ status }) => status === "completed" ? [
        { id: "t1", title: "Fix mouse bug", queue: "user", bucket: "today", updatedAt: todayAt(10), completedVia: "manual" },
        { id: "t2", title: "Old task", queue: "user", bucket: "done", updatedAt: yesterdayAt(15), completedVia: "manual" },
        { id: "t3", title: "Agent picked this up", queue: "agent", bucket: "today", updatedAt: todayAt(14), completedVia: "agent" }
      ] : []
    },
    outcomes: {
      recent: (limit, kind) => kind === "skill-run" ? [
        { id: "o1", refId: "morning-brief", at: todayAt(9), qualityScore: 0.8, metadata: { skill: "morning-brief" } },
        { id: "o2", refId: "old-skill", at: yesterdayAt(10), qualityScore: 0.5, metadata: { skill: "old-skill" } }
      ] : []
    },
    pendingActions: {
      list: ({ status }) => status === "approved" ? [
        { id: "p1", toolName: "connect_catalog_mcp", summary: "Connect Linear", decidedAt: todayAt(11), createdAt: todayAt(11) }
      ] : []
    },
    computerUseLog: { listActions: () => [] },
    observations: { _recentCache: null, search: () => [] },
    proactiveObserver: { list: () => [
      { id: "s1", title: "Ship docs site", proposedAt: todayAt(12) },
      { id: "s2", title: "Old idea", proposedAt: yesterdayAt(9) }
    ]},
    agentHost: { store: { listSessions: () => [{ id: "sess1", lastActivityAt: todayAt(13) }] } }
  };

  const recap = computeDailyRecap(fakeRuntime, { date: now, timezone: "UTC" });
  assert.equal(recap.counts.completedTasks, 2, "two completed today (yesterday's filtered out)");
  assert.equal(recap.counts.skillRuns, 1);
  assert.equal(recap.counts.approvedActions, 1);
  assert.equal(recap.completedTasks.find((t) => t.id === "t1").title, "Fix mouse bug");
  assert.ok(recap.themes.includes("Ship docs site"), "today's theme included");
  assert.ok(!recap.themes.includes("Old idea"), "yesterday's theme filtered out");
  assert.equal(recap.sessions.length, 1);

  const md = renderDailyRecapMarkdown(recap);
  assert.match(md, /What you got done/);
  assert.match(md, /Fix mouse bug/);
  assert.match(md, /morning-brief/);
  assert.match(md, /Connect Linear/);
  assert.match(md, /Ship docs site/);

  // dateISO is YYYY-MM-DD for the URL surface.
  assert.match(recap.dateISO, /^\d{4}-\d{2}-\d{2}$/);
});

test("daily-recap: quiet day renders an empty-state line, not a wall of zeros", async () => {
  const { computeDailyRecap, renderDailyRecapMarkdown } = await import("../src/daily-recap.js");
  const recap = computeDailyRecap({
    tasks: { list: () => [] },
    outcomes: { recent: () => [] },
    pendingActions: { list: () => [] },
    computerUseLog: { listActions: () => [] },
    observations: { _recentCache: null },
    proactiveObserver: { list: () => [] },
    agentHost: { store: { listSessions: () => [] } }
  }, { date: new Date("2026-05-13T18:00:00Z"), timezone: "UTC" });
  const md = renderDailyRecapMarkdown(recap);
  assert.match(md, /Nothing logged today/);
  assert.doesNotMatch(md, /0 task/);
});

test("skill-materialize: miner candidate → SKILL.md with sequence + lineage", async () => {
  const { createSkillFromCandidate } = await import("../src/skill-materialize.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-skill-mat-cand-"));
  const bundled = path.join(dir, "bundled");
  const userDir = path.join(dir, "user");
  fs.mkdirSync(bundled, { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  const fakeRuntime = { skills: { dirs: [bundled, userDir], reload: () => {} } };

  const candidate = {
    id: "sug_xyz",
    source: "pattern-miner",
    category: "skill",
    title: "evening-sms-slack-sync",
    fingerprint: "com.apple.mobilesms→com.tinyspeck.slackmacgap",
    sequence: {
      apps: ["com.apple.MobileSMS", "com.tinyspeck.slackmacgap", "com.apple.MobileSMS"],
      count: 10,
      startHour: 21,
      confidence: 1
    },
    proposal: {
      pass: false,
      name: "evening-sms-slack-sync",
      description: "Cross-reference SMS + Slack each evening",
      body: "When this routine kicks off, surface unread Slack DMs + recent SMS threads.",
      scheduleHint: "daily at 21:00"
    }
  };

  const result = createSkillFromCandidate({ runtime: fakeRuntime, candidate });
  assert.equal(result.slug, "evening-sms-slack-sync");
  assert.equal(result.scheduleHint, "daily at 21:00");

  const written = fs.readFileSync(result.path, "utf8");
  assert.match(written, /sourceCandidateId: sug_xyz/, "lineage stamped");
  assert.match(written, /createdBy: pattern-miner/);
  assert.match(written, /observedCount: 10/);
  assert.match(written, /observedConfidence: 1/);
  assert.match(written, /Detected from 10 occurrences around 21:00/, "description includes provenance");
  assert.match(written, /Observed app sequence:/, "appended outline of app sequence");

  // Session miner candidate produces same shape, different createdBy.
  const ses = createSkillFromCandidate({
    runtime: fakeRuntime,
    candidate: { ...candidate, id: "ses_abc", source: "session-miner", proposal: { ...candidate.proposal, name: "weekly-recap" } }
  });
  const sesWritten = fs.readFileSync(ses.path, "utf8");
  assert.match(sesWritten, /createdBy: session-miner/);

  // Refuses without proposal.body.
  assert.throws(() => createSkillFromCandidate({
    runtime: fakeRuntime,
    candidate: { id: "x", proposal: { name: "x" } }
  }), /proposal\.body/);

  fs.rmSync(dir, { recursive: true });
});

test("pattern-miner: high-confidence sequence bypasses the judge's pass=true veto", async () => {
  // Direct unit test of the bypass logic — wire up a fake provider that
  // always says pass: true, plus a sequence at confidence=1, count=10.
  // The candidate should still get persisted and stamped judgeBypass.
  const { PatternMiner } = await import("../src/pattern-miner.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-judge-bypass-"));

  // Stub provider that always says pass=true (judge wants to skip).
  const fakeProvider = {
    isConfigured: () => true,
    generate: async () => ({ text: JSON.stringify({ pass: true, reason: "not interesting" }) })
  };
  // Stub observation-store that returns a 10x repeating sequence.
  const apps = ["com.apple.Slack", "com.linear", "com.github.Desktop"];
  const occurrences = [];
  for (let i = 0; i < 10; i++) {
    for (const app of apps) {
      occurrences.push({
        kind: "activity",
        event: "focus",
        app,
        at: new Date(Date.now() - (10 - i) * 600 * 1000 + apps.indexOf(app) * 30 * 1000).toISOString()
      });
    }
  }
  const fakeObservations = { search: async () => occurrences };
  const fakeRuntime = {
    dataDir: dir,
    observations: fakeObservations,
    agentHost: { modelProvider: fakeProvider },
    events: { emit: () => {} }
  };
  const miner = new PatternMiner({
    runtime: fakeRuntime,
    dataDir: dir,
    minOccurrences: 5,
    minSequenceLen: 3,
    maxSequenceLen: 4,
    minConfidence: 0.7
  });

  const result = await miner.mine({ now: new Date() });
  // Should have persisted at least one candidate despite judge's pass=true.
  assert.ok(result.candidates >= 1, "judge-bypassed candidate should land");
  const persistedFiles = fs.readdirSync(path.join(dir, "skills-suggested"));
  assert.ok(persistedFiles.length >= 1);
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, "skills-suggested", persistedFiles[0]), "utf8"));
  assert.equal(persisted.judgeBypass, true, "stamped judgeBypass: true");
  assert.equal(persisted.proposal.pass, false, "pass overridden");
  assert.ok(persisted.proposal.name, "fallback name filled in");
  assert.ok(persisted.proposal.body, "fallback body filled in");

  fs.rmSync(dir, { recursive: true });
});

test("suggestion-feed: aggregates observer + miner candidates, normalizes shape, resolves to right source", async () => {
  const { listAllSuggestions, findSuggestion, resolveSuggestion } = await import("../src/suggestion-feed.js");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-feed-"));
  const obsDir = path.join(dataDir, "proactive", "suggestions");
  const minedDir = path.join(dataDir, "skills-suggested");
  fs.mkdirSync(obsDir, { recursive: true });
  fs.mkdirSync(minedDir, { recursive: true });

  // Observer-style suggestion (already-normalized envelope).
  fs.writeFileSync(path.join(obsDir, "prop_obs1.json"), JSON.stringify({
    id: "prop_obs1",
    proposedAt: "2026-05-12T10:00:00Z",
    category: "task",
    title: "Reply to Sarah",
    rationale: "Email open in front",
    status: "pending"
  }));
  // Pattern-miner candidate (richer shape — proposal nested, sequence stats).
  fs.writeFileSync(path.join(minedDir, "sug_pm1.json"), JSON.stringify({
    id: "sug_pm1",
    fingerprint: "x->y->z",
    proposedAt: "2026-05-12T11:00:00Z",
    sequence: { apps: ["x", "y", "z"], count: 8, startHour: 9, confidence: 0.95 },
    proposal: { pass: true, name: "morning-triage", description: "Triage standup channels", body: "1. Call recall..." },
    status: "pending"
  }));
  // Session-miner candidate (same dir, different id prefix).
  fs.writeFileSync(path.join(minedDir, "ses_sm1.json"), JSON.stringify({
    id: "ses_sm1",
    proposedAt: "2026-05-12T08:00:00Z",
    proposal: { pass: true, name: "weekly-recap", description: "Summarize the week", body: "..." },
    sequence: { count: 4, confidence: 0.7 },
    status: "pending"
  }));
  // One resolved candidate — should be filtered out when status=pending.
  fs.writeFileSync(path.join(minedDir, "sug_done.json"), JSON.stringify({
    id: "sug_done",
    proposedAt: "2026-05-12T07:00:00Z",
    proposal: { name: "old-thing", body: "..." },
    status: "rejected"
  }));

  const fakeRuntime = {
    dataDir,
    proactiveObserver: { dataDir },
    patternMiner: { dataDir }
  };

  const pending = listAllSuggestions(fakeRuntime, { status: "pending" });
  assert.equal(pending.length, 3, "three pending across all sources");
  const ids = pending.map((s) => s.id);
  assert.ok(ids.includes("prop_obs1") && ids.includes("sug_pm1") && ids.includes("ses_sm1"));
  assert.equal(pending.find((s) => s.id === "prop_obs1").source, "observer");
  assert.equal(pending.find((s) => s.id === "sug_pm1").source, "pattern-miner");
  assert.equal(pending.find((s) => s.id === "ses_sm1").source, "session-miner");

  // Newest first.
  assert.equal(pending[0].id, "sug_pm1", "11:00 proposal sorts before 10:00");

  // Miner candidate normalized: title from proposal.name, draftBody from
  // proposal.body, rationale composed with count + confidence.
  const pm = pending.find((s) => s.id === "sug_pm1");
  assert.equal(pm.title, "morning-triage");
  assert.equal(pm.category, "skill");
  assert.match(pm.draftBody, /Call recall/);
  assert.match(pm.rationale, /8×/);
  assert.match(pm.rationale, /confidence 0\.95/);

  // findSuggestion / resolveSuggestion work across sources.
  assert.equal(findSuggestion(fakeRuntime, "sug_pm1").title, "morning-triage");
  const resolved = resolveSuggestion(fakeRuntime, "sug_pm1", "accepted");
  assert.equal(resolved.status, "accepted");
  // Original file is updated, not a copy.
  const onDisk = JSON.parse(fs.readFileSync(path.join(minedDir, "sug_pm1.json"), "utf8"));
  assert.equal(onDisk.status, "accepted");

  // status=null returns everything (including resolved).
  const all = listAllSuggestions(fakeRuntime, { status: null });
  assert.equal(all.length, 4, "status=null includes resolved");

  fs.rmSync(dataDir, { recursive: true });
});

test("SuggestionFeedback: stats, preferenceSummary, multipliers, mute", async () => {
  const { SuggestionFeedback } = await import("../src/suggestion-feedback.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-feedback-"));
  const now = Date.now();
  const sample = (status, category, daysAgo = 1) => ({
    id: "s" + Math.random(),
    category,
    status,
    proposedAt: new Date(now - daysAgo * 86400000).toISOString()
  });

  // Fake proactiveObserver.list — returns whatever we give it.
  const suggestions = [
    sample("accepted", "task"),
    sample("accepted", "task"),
    sample("accepted", "task"),
    sample("rejected", "task"),
    sample("rejected", "skill"),
    sample("rejected", "skill"),
    sample("rejected", "skill"),
    sample("accepted", "skill"),
    // One outside window — should not count.
    sample("accepted", "task", 60)
  ];
  const fakeRuntime = {
    proactiveObserver: { list: () => suggestions }
  };
  const feedback = new SuggestionFeedback({ runtime: fakeRuntime, dataDir: dir, windowDays: 30 });

  const stats = feedback.computeStats();
  assert.equal(stats.total, 8, "8 in-window resolved");
  assert.equal(stats.byCategory.task.accepted, 3);
  assert.equal(stats.byCategory.task.rejected, 1);
  assert.equal(stats.byCategory.skill.accepted, 1);
  assert.equal(stats.byCategory.skill.rejected, 3);

  const summary = feedback.preferenceSummary();
  assert.ok(summary, "summary not null when n >= 3");
  assert.match(summary, /task: 3\/4 accepted .* propose more/);
  assert.match(summary, /skill: 1\/4 accepted .* propose only when strongly indicated/);

  const mult = feedback.categoryMultipliers();
  assert.ok(mult.task > 1.0, "task category boosted (75% accept rate)");
  assert.ok(mult.skill < 1.0, "skill category dampened (25% accept rate)");

  // Mute → multiplier hard-zero + isMuted true.
  feedback.setMuted("skill", true);
  assert.equal(feedback.isMuted("skill"), true);
  assert.equal(feedback.categoryMultipliers().skill, 0);
  const mutedSummary = feedback.preferenceSummary();
  assert.match(mutedSummary, /muted these categories.*skill/);
  // Unmute.
  feedback.setMuted("skill", false);
  assert.equal(feedback.isMuted("skill"), false);

  // Too few samples → null summary.
  const emptyFeedback = new SuggestionFeedback({
    runtime: { proactiveObserver: { list: () => [sample("accepted", "task")] } },
    dataDir: dir
  });
  assert.equal(emptyFeedback.preferenceSummary(), null, "n=1 < threshold → null");

  fs.rmSync(dir, { recursive: true });
});

test("OutcomeStore: bySuggestion + aggregateBySuggestion link runs back to proposal", async () => {
  const { OutcomeStore } = await import("../src/outcome-store.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-outcome-lineage-"));
  const store = new OutcomeStore({ dir });

  // Two outcomes from one suggestion, plus a noise outcome from elsewhere.
  const a = store.record({
    kind: "skill-run",
    refId: "morning-standup",
    metadata: { skill: "morning-standup", sourceSuggestionId: "sug-1" }
  });
  store.resolve(a.id, 0.8, "skill-completed");
  const b = store.record({
    kind: "skill-run",
    refId: "morning-standup",
    metadata: { skill: "morning-standup", sourceSuggestionId: "sug-1" }
  });
  store.resolve(b.id, 0.6, "skill-completed");
  store.record({
    kind: "skill-run",
    refId: "another-skill",
    metadata: { skill: "another-skill", sourceSuggestionId: "different-sug" }
  });

  const linked = store.bySuggestion("sug-1");
  assert.equal(linked.length, 2, "two outcomes carry the suggestion id");

  const summary = store.aggregateBySuggestion("sug-1");
  assert.equal(summary.total, 2);
  assert.equal(summary.resolved, 2);
  assert.equal(summary.pending, 0);
  assert.equal(summary.avgQuality, 0.7, "(0.8 + 0.6) / 2 = 0.7");
  assert.equal(summary.byKind["skill-run"], 2);

  // No outcomes → null (callers can render "not yet observed").
  assert.equal(store.aggregateBySuggestion("never-existed"), null);

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

test("proactive-observer: task proposals materialize into real tasks", async () => {
  const { ProactiveObserver } = await import("../src/proactive-observer.js");
  const { TaskStore } = await import("../src/task-store.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-observer-task-"));
  const tasks = new TaskStore({ dataDir: dir });
  const events = [];

  const runtime = {
    dataDir: dir,
    tasks,
    events: { emit: (name, data) => events.push({ name, data }) },
    mcp: { listServers: () => [] },
    agentHost: {
      store: { listSessions: () => [] },
      modelProvider: {
        isConfigured: () => true,
        generate: async () => ({
          text: JSON.stringify({
            category: "task",
            title: "Review PR #42 before standup",
            rationale: "The PR was open repeatedly and standup is coming up.",
            queue: "agent",
            bucket: "today"
          })
        })
      }
    },
    observations: {
      getRecentContext: async () => ({
        apps: [{ app: "Chrome", n: 4 }],
        snippets: [
          { app: "Chrome", text: "GitHub Pull Request #42" },
          { app: "Calendar", text: "Engineering standup" }
        ]
      })
    }
  };
  tasks.runtime = runtime;

  const observer = new ProactiveObserver({ runtime, dataDir: dir });
  const result = await observer.observe({ force: true, now: new Date("2026-05-26T17:00:00Z") });

  assert.equal(result.suggested, 1);
  assert.equal(result.candidate.status, "accepted");
  assert.equal(result.candidate.taskAutoCreated, true);
  assert.ok(result.candidate.taskId);

  const queued = tasks.list({ queue: "agent", limit: 10 });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].title, "Review PR #42 before standup");
  assert.equal(queued[0].source, "proactive-observer");
  assert.equal(queued[0].sourceMeta.suggestionId, result.candidate.id);
  assert.match(queued[0].description, /Produce a draft only/);
  assert.ok(queued[0].tags.includes("draft-only"));

  assert.equal(observer.list().length, 0, "auto-created task suggestions should not sit pending");
  assert.equal(observer.list({ status: null }).length, 1, "resolved suggestion remains in history");
  assert.ok(events.some((e) => e.name === "task-updated" && e.data.op === "create"));
  assert.ok(events.some((e) => e.name === "task-reminder" && e.data.kind === "created" && e.data.taskId === queued[0].id));
  assert.equal(events.some((e) => e.name === "proactive-suggestion"), false);

  fs.rmSync(dir, { recursive: true });
});

test("proactive-observer: multi-source reconciliation fuses OCR + Rize + BuildBetter evidence", async () => {
  const { ProactiveObserver } = await import("../src/proactive-observer.js");
  const { TaskStore } = await import("../src/task-store.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-reconcile-"));
  const tasks = new TaskStore({ dataDir: dir });

  const shipped = tasks.add({ title: "Ship the Acme proposal" }, { source: "manual", queue: "user" });
  const designing = tasks.add({ title: "Redesign onboarding in Figma" }, { source: "manual", queue: "user" });

  // Capture the prompt the provider receives + the events emitted.
  let seenPrompt = null;
  const events = [];
  const fakeProvider = {
    isConfigured: () => true,
    generate: async ({ input }) => {
      seenPrompt = input;
      return {
        text: JSON.stringify({
          updates: [
            // Corroborated complete: OCR shows the send + Rize logged time.
            { taskId: shipped.id, action: "complete", confidence: 0.9, evidence: "Gmail 'Message sent' + 0.5h in Email", sources: ["ocr", "rize"] },
            // Rize-only 'complete' must be downgraded to in_progress by the guard.
            { taskId: designing.id, action: "complete", confidence: 0.95, evidence: "2.1h in Figma", sources: ["rize"] }
          ]
        })
      };
    }
  };

  const runtime = {
    dataDir: dir,
    tasks,
    events: { emit: (name, data) => events.push({ name, data }) },
    agentHost: { modelProvider: fakeProvider },
    observations: {
      getRecentContext: async () => ({
        apps: [{ app: "com.google.Chrome", n: 8 }],
        snippets: [
          { app: "com.google.Chrome", text: "Gmail — Message sent to acme@example.com" },
          { app: "com.figma", text: "Onboarding v3 — editing" }
        ]
      })
    },
    tools: {
      get: (name) => {
        if (name === "rize_today_summary") {
          return { handler: async () => ({ totalSeconds: 9360, focusSeconds: 7200, categories: [{ name: "Design", totalSeconds: 7560 }, { name: "Email", totalSeconds: 1800 }], projects: [{ name: "Onboarding", totalSeconds: 7560 }] }) };
        }
        if (name === "rize_recent_sessions") {
          return { handler: async () => ([{ title: "Figma onboarding", category: { name: "Design" }, project: { name: "Onboarding" } }]) };
        }
        return undefined;
      }
    }
  };

  const observer = new ProactiveObserver({ runtime, dataDir: dir });

  // gatherReconciliationEvidence pulls all three sources.
  const ev = await observer.gatherReconciliationEvidence({ now: new Date() });
  assert.ok(ev.ocr?.snippets?.length === 2, "OCR gathered");
  assert.ok(ev.rize?.summary?.totalSeconds === 9360, "Rize summary gathered");
  // BuildBetter: add a recent bb-sourced task so source 3 has something.
  tasks.add(
    { title: "Follow up with Dana re pricing", sourceId: "buildbetter:x1", sourceMeta: { callName: "Dana sync", callStartedAt: new Date().toISOString(), extractionTypes: ["follow_up"] } },
    { source: "buildbetter", queue: "user" }
  );
  const ev2 = await observer.gatherReconciliationEvidence({ now: new Date() });
  assert.ok(ev2.buildbetter?.length === 1, "BuildBetter call topics gathered");

  const result = await observer.scanTasksAgainstActivity({ now: new Date() });

  // Prompt carries all three provenance-tagged source blocks.
  assert.match(seenPrompt, /\[ocr\]/);
  assert.match(seenPrompt, /\[rize\]/);
  assert.match(seenPrompt, /Time actually tracked today/);

  // Corroborated task auto-completed with sources annotated.
  assert.equal(tasks.get(shipped.id).status, "completed");
  assert.deepEqual(tasks.get(shipped.id).sourceMeta.autoCompletedSources, ["ocr", "rize"]);

  // Rize-only "complete" was downgraded to in_progress, NOT completed.
  assert.equal(tasks.get(designing.id).status, "in_progress");
  assert.deepEqual(tasks.get(designing.id).sourceMeta.inProgressSources, ["rize"]);

  assert.equal(result.completed, 1);
  assert.equal(result.inProgressed, 1);

  // Events carry sources for the dashboard.
  const completeEvent = events.find((e) => e.name === "task-auto-changed" && e.data.action === "complete");
  assert.deepEqual(completeEvent.data.sources, ["ocr", "rize"]);

  fs.rmSync(dir, { recursive: true });
});

test("proactive-observer: reconciliation degrades gracefully when Rize + BuildBetter absent", async () => {
  const { ProactiveObserver } = await import("../src/proactive-observer.js");
  const { TaskStore } = await import("../src/task-store.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-reconcile-bare-"));
  const tasks = new TaskStore({ dataDir: dir });
  tasks.add({ title: "Some task" }, { source: "manual", queue: "user" });

  const runtime = {
    dataDir: dir,
    tasks,
    events: { emit: () => {} },
    agentHost: { modelProvider: { isConfigured: () => true, generate: async () => ({ text: JSON.stringify({ updates: [] }) }) } },
    observations: {
      getRecentContext: async () => ({ apps: [], snippets: [{ app: "x", text: "a" }, { app: "x", text: "b" }] })
    },
    tools: { get: () => undefined } // no Rize tools registered
  };
  const observer = new ProactiveObserver({ runtime, dataDir: dir });

  const ev = await observer.gatherReconciliationEvidence({ now: new Date() });
  assert.equal(ev.rize, null, "Rize null when tools absent");
  assert.equal(ev.buildbetter, null, "BuildBetter null when no bb tasks");

  // Scan still runs (OCR alone is enough to not bail).
  const result = await observer.scanTasksAgainstActivity({ now: new Date() });
  assert.equal(result.skipped, undefined);
  assert.equal(result.completed, 0);

  fs.rmSync(dir, { recursive: true });
});

test("clarification-store: ambiguous reconciliation parks a question, answer resolves task + records outcome", async () => {
  const { ClarificationStore } = await import("../src/clarification-store.js");
  const { TaskStore } = await import("../src/task-store.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-clar-"));
  const tasks = new TaskStore({ dataDir: dir });
  const recorded = [];
  const resolved = [];
  const events = [];
  const runtime = {
    tasks,
    events: { emit: (name, data) => events.push({ name, data }) },
    outcomes: {
      record: (o) => { const rec = { id: "out_" + recorded.length, ...o }; recorded.push(rec); return rec; },
      resolve: (id, score, kind) => resolved.push({ id, score, kind })
    }
  };
  const clar = new ClarificationStore({ dir: path.join(dir, "clar"), runtime });

  const t = tasks.add({ title: "Send the Acme proposal" }, { source: "manual", queue: "user" });
  const c = clar.add({
    taskId: t.id,
    question: 'Did you finish "Send the Acme proposal"?',
    context: "Rize logged 40m in Docs, no send detected",
    proposedAction: "complete",
    confidence: 0.55,
    sources: ["rize"]
  });
  assert.match(c.id, /^clar_/);
  assert.equal(c.status, "pending");
  assert.equal(events.find((e) => e.name === "clarification-created")?.data.id, c.id);

  // Dedup: a second add for the same pending task returns the same item.
  const dup = clar.add({ taskId: t.id, question: "again?", proposedAction: "complete" });
  assert.equal(dup.id, c.id, "no duplicate pending clarification per task");
  assert.equal(clar.list({ status: "pending" }).length, 1);

  // Answer "yes" → task completes via user, outcome recorded high.
  const result = clar.answer(c.id, "yes");
  assert.equal(result.task.status, "completed");
  assert.equal(result.task.completedVia, "user");
  assert.equal(clar.get(c.id).status, "answered");
  assert.equal(clar.list({ status: "pending" }).length, 0);
  assert.equal(recorded[0].kind, "clarification-answered");
  assert.equal(resolved[0].score, 0.95, "yes is a strong positive signal");

  // Persistence round-trip.
  const clar2 = new ClarificationStore({ dir: path.join(dir, "clar"), runtime });
  assert.equal(clar2.get(c.id).answer, "yes");

  fs.rmSync(dir, { recursive: true });
});

test("clarification-store: answers map to the right task transitions", async () => {
  const { ClarificationStore } = await import("../src/clarification-store.js");
  const { TaskStore } = await import("../src/task-store.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-clar2-"));
  const tasks = new TaskStore({ dataDir: dir });
  const runtime = { tasks, events: { emit: () => {} } };
  const clar = new ClarificationStore({ dir: path.join(dir, "clar"), runtime });

  const mk = (title) => {
    const t = tasks.add({ title }, { source: "manual", queue: "user" });
    return clar.add({ taskId: t.id, question: "?", proposedAction: "complete", confidence: 0.5, sources: ["ocr"] });
  };

  const inProg = mk("a"); clar.answer(inProg.id, "in_progress");
  assert.equal(tasks.get(inProg.taskId).status, "in_progress");

  const dropped = mk("b"); clar.answer(dropped.id, "dropped");
  assert.equal(tasks.get(dropped.taskId).status, "cancelled");

  const notYet = mk("c"); clar.answer(notYet.id, "no");
  assert.equal(tasks.get(notYet.taskId).status, "pending", "'no' leaves it pending to resurface");

  // Invalid answer rejected; dismiss works.
  const d = mk("d");
  assert.throws(() => clar.answer(d.id, "maybe"), /invalid answer/);
  clar.dismiss(d.id);
  assert.equal(clar.get(d.id).status, "dismissed");

  fs.rmSync(dir, { recursive: true });
});

test("proactive-observer: mid-band complete creates a clarification instead of dropping", async () => {
  const { ProactiveObserver } = await import("../src/proactive-observer.js");
  const { ClarificationStore } = await import("../src/clarification-store.js");
  const { TaskStore } = await import("../src/task-store.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-clar3-"));
  const tasks = new TaskStore({ dataDir: dir });
  const clar = new ClarificationStore({ dir: path.join(dir, "clar"), runtime: { tasks, events: { emit: () => {} } } });
  const t = tasks.add({ title: "Maybe-done task" }, { source: "manual", queue: "user" });

  const runtime = {
    dataDir: dir,
    tasks,
    clarifications: clar,
    events: { emit: () => {} },
    agentHost: {
      modelProvider: {
        isConfigured: () => true,
        // 0.55 confidence complete → mid-band → clarification.
        generate: async () => ({ text: JSON.stringify({ updates: [{ taskId: t.id, action: "complete", confidence: 0.55, evidence: "doc open but no send", sources: ["ocr"] }] }) })
      }
    },
    observations: { getRecentContext: async () => ({ apps: [], snippets: [{ app: "x", text: "a" }, { app: "x", text: "b" }] }) },
    tools: { get: () => undefined }
  };
  clar.bindRuntime(runtime);
  const observer = new ProactiveObserver({ runtime, dataDir: dir });

  const result = await observer.scanTasksAgainstActivity({ now: new Date() });
  assert.equal(result.completed, 0, "not auto-completed in mid-band");
  assert.equal(result.clarified, 1, "parked a clarification");
  assert.equal(tasks.get(t.id).status, "pending", "task untouched until user answers");
  const pending = clar.list({ status: "pending" });
  assert.equal(pending.length, 1);
  assert.match(pending[0].question, /Maybe-done task/);

  fs.rmSync(dir, { recursive: true });
});

test("calendar: ICS parsing — timed, all-day, line folding, and WEEKLY recurrence", async () => {
  const { parseICS, CalendarClient } = await import("../src/integrations/calendar.js");

  // A folded SUMMARY line (continuation begins with a space) + timed event.
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:1",
    "SUMMARY:Acme sync with a very long title that gets ",
    " folded across lines",
    "DTSTART:20260525T160000Z",
    "DTEND:20260525T170000Z",
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:2",
    "SUMMARY:All day offsite",
    "DTSTART;VALUE=DATE:20260525",
    "DTEND;VALUE=DATE:20260526",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:3",
    "SUMMARY:Daily standup",
    "DTSTART:20260101T090000Z",
    "DTEND:20260101T091500Z",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR",
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n");

  const events = parseICS(ics);
  assert.equal(events.length, 3);
  assert.equal(events[0].summary, "Acme sync with a very long title that gets folded across lines");
  assert.equal(events[1].dtstart.allDay, true);
  assert.equal(events[2].rrule.FREQ, "WEEKLY");

  // Use the client to expand events overlapping a single day (Mon 2026-05-25).
  const client = new CalendarClient({
    icsUrl: "https://example.com/cal.ics",
    fetchImpl: async () => ({ ok: true, text: async () => ics })
  });
  assert.equal(client.isConfigured(), true);
  const day = await client.eventsBetween("2026-05-25T00:00:00Z", "2026-05-25T23:59:59Z");
  const summaries = day.map((e) => e.summary);
  assert.ok(summaries.includes("Acme sync with a very long title that gets folded across lines"), "timed event present");
  assert.ok(summaries.includes("All day offsite"), "all-day event present");
  // 2026-05-25 is a Monday → the MO/WE/FR standup should produce an instance.
  assert.ok(summaries.includes("Daily standup"), "weekly recurrence expanded onto Monday");

  // A Tuesday should NOT contain the MO/WE/FR standup.
  const tue = await client.eventsBetween("2026-05-26T00:00:00Z", "2026-05-26T23:59:59Z");
  assert.ok(!tue.map((e) => e.summary).includes("Daily standup"), "no standup on Tuesday");
});

test("calendar: unconfigured client + integration registration is a no-op", async () => {
  const { CalendarClient, registerCalendarIntegration } = await import("../src/integrations/calendar.js");
  const bare = new CalendarClient({ icsUrl: "" });
  assert.equal(bare.isConfigured(), false);

  const registered = [];
  const runtime = { tools: { register: (t) => registered.push(t.name) } };
  const result = registerCalendarIntegration(runtime, { client: bare });
  assert.equal(result.registered, false);
  assert.equal(registered.length, 0, "no tools registered when unconfigured");
});

test("proactive-observer: calendar event feeds reconciliation as a 4th source", async () => {
  const { ProactiveObserver } = await import("../src/proactive-observer.js");
  const { TaskStore } = await import("../src/task-store.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-cal-recon-"));
  const tasks = new TaskStore({ dataDir: dir });

  let seenPrompt = null;
  const now = new Date();
  const earlier = new Date(now.getTime() - 3600_000).toISOString();
  const runtime = {
    dataDir: dir,
    tasks,
    events: { emit: () => {} },
    agentHost: { modelProvider: { isConfigured: () => true, generate: async ({ input }) => { seenPrompt = input; return { text: JSON.stringify({ updates: [] }) }; } } },
    observations: { getRecentContext: async () => ({ apps: [], snippets: [] }) },
    tools: {
      get: (name) => {
        if (name === "calendar_today_events") {
          return { handler: async () => ([{ summary: "Acme sync", start: earlier, end: now.toISOString(), status: "confirmed" }]) };
        }
        return undefined;
      }
    }
  };
  const observer = new ProactiveObserver({ runtime, dataDir: dir });

  const ev = await observer.gatherReconciliationEvidence({ now });
  assert.equal(ev.calendar.length, 1, "occurred event captured");
  assert.equal(ev.calendar[0].summary, "Acme sync");

  // Scan should run on calendar evidence alone (OCR empty) and include the block.
  tasks.add({ title: "Acme sync" }, { source: "manual", queue: "user" });
  await observer.scanTasksAgainstActivity({ now });
  assert.match(seenPrompt, /\[calendar\]/);
  assert.match(seenPrompt, /Acme sync/);

  fs.rmSync(dir, { recursive: true });
});

test("reconciliation-calibration: yes-rate moves the auto-complete threshold per source combo", async () => {
  const { buildReconciliationCalibration, BASE_COMPLETE_THRESHOLD } = await import("../src/reconciliation-calibration.js");

  const mk = (sources, answer) => ({ kind: "clarification-answered", metadata: { proposedAction: "complete", sources, answer } });

  // Combo [ocr,rize]: 8 answers, 7 "yes" → high yes-rate → low threshold.
  // Combo [rize]: 8 answers, 1 "yes" → low yes-rate → high threshold.
  const outcomes = [];
  for (let i = 0; i < 8; i++) outcomes.push(mk(["ocr", "rize"], i < 7 ? "yes" : "no"));
  for (let i = 0; i < 8; i++) outcomes.push(mk(["rize"], i < 1 ? "yes" : "no"));

  const calib = buildReconciliationCalibration(outcomes);

  const trusted = calib.thresholdFor(["rize", "ocr"]); // order-insensitive
  assert.equal(trusted.basis, "combo");
  assert.ok(trusted.threshold <= 0.65, `trusted combo should lower the bar, got ${trusted.threshold}`);

  const flaky = calib.thresholdFor(["rize"]);
  assert.equal(flaky.basis, "combo");
  assert.ok(flaky.threshold >= 0.8, `flaky combo should raise the bar, got ${flaky.threshold}`);

  // Unknown combo with no global data falls back to base.
  const fresh = buildReconciliationCalibration([]);
  assert.equal(fresh.thresholdFor(["calendar"]).threshold, BASE_COMPLETE_THRESHOLD);
  assert.equal(fresh.thresholdFor(["calendar"]).basis, "default");

  // Summary is shaped for the transparency endpoint.
  assert.equal(calib.summary.combos.length, 2);
  assert.ok(calib.summary.combos[0].samples >= calib.summary.combos[1].samples, "sorted by samples desc");
});

test("reconciliation-calibration: a learned-low threshold auto-completes what used to be a clarification", async () => {
  const { ProactiveObserver } = await import("../src/proactive-observer.js");
  const { TaskStore } = await import("../src/task-store.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-calib-scan-"));
  const tasks = new TaskStore({ dataDir: dir });
  const t = tasks.add({ title: "Borderline task" }, { source: "manual", queue: "user" });

  // Outcomes that have taught us [ocr,rize] @ mid-band is almost always "yes".
  const history = [];
  for (let i = 0; i < 8; i++) history.push({ kind: "clarification-answered", metadata: { proposedAction: "complete", sources: ["ocr", "rize"], answer: i < 7 ? "yes" : "no" } });

  let clarifyAdds = 0;
  const runtime = {
    dataDir: dir,
    tasks,
    clarifications: { add: () => { clarifyAdds += 1; return { id: "c1" }; } },
    outcomes: { recent: () => history },
    events: { emit: () => {} },
    agentHost: {
      modelProvider: {
        isConfigured: () => true,
        // 0.62 confidence: BELOW the 0.7 base (would have clarified) but
        // ABOVE the learned ~0.6 bar for [ocr,rize] → should auto-complete.
        generate: async () => ({ text: JSON.stringify({ updates: [{ taskId: t.id, action: "complete", confidence: 0.62, evidence: "PR merged + 1h tracked", sources: ["ocr", "rize"] }] }) })
      }
    },
    observations: { getRecentContext: async () => ({ apps: [], snippets: [{ app: "x", text: "a" }, { app: "x", text: "b" }] }) },
    tools: { get: () => undefined }
  };
  const observer = new ProactiveObserver({ runtime, dataDir: dir });

  const result = await observer.scanTasksAgainstActivity({ now: new Date() });
  assert.equal(result.completed, 1, "learned-low threshold auto-completes the borderline case");
  assert.equal(clarifyAdds, 0, "no clarification needed anymore");
  assert.equal(tasks.get(t.id).status, "completed");
  assert.equal(tasks.get(t.id).sourceMeta.autoCompletedThreshold <= 0.65, true);

  fs.rmSync(dir, { recursive: true });
});

test("daily-planner: deterministic fallback surfaces overdue + focus from tasks (no LLM)", async () => {
  const { computeDailyPlan, renderDailyPlanMarkdown } = await import("../src/daily-planner.js");
  const { TaskStore } = await import("../src/task-store.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-plan-"));
  const tasks = new TaskStore({ dataDir: dir });

  const today = new Date();
  const twoDaysAgo = new Date(today.getTime() - 2 * 86_400_000).toISOString();
  tasks.add({ title: "Overdue thing", bucket: "today", dueDate: twoDaysAgo, priority: 60 }, { source: "manual", queue: "user" });
  tasks.add({ title: "This week thing", bucket: "this_week", priority: 70 }, { source: "manual", queue: "user" });
  tasks.add({ title: "Someday thing", bucket: "someday", priority: 90 }, { source: "manual", queue: "user" });

  const runtime = {
    tasks,
    tools: { get: () => undefined }, // no calendar
    agentHost: { modelProvider: { isConfigured: () => false } } // force deterministic
  };

  const plan = await computeDailyPlan(runtime, { date: today, useLLM: false });
  assert.equal(plan.synthesized, false);
  // Overdue surfaces as time-sensitive.
  assert.ok(plan.timeSensitive.some((s) => /Overdue: Overdue thing/.test(s)));
  // Focus pulls today/this_week, not someday.
  const titles = plan.focus.map((f) => f.title);
  assert.ok(titles.includes("Overdue thing"));
  assert.ok(titles.includes("This week thing"));
  assert.ok(!titles.includes("Someday thing"), "someday excluded from today's focus");
  // No agent suggestions without an LLM.
  assert.equal(plan.agentWillDo.length, 0);

  const md = renderDailyPlanMarkdown(plan);
  assert.match(md, /Your day/);
  assert.match(md, /🎯 Focus/);

  fs.rmSync(dir, { recursive: true });
});

test("daily-planner: LLM synthesis pulls calendar + tasks and returns focus + agent actions", async () => {
  const { computeDailyPlan } = await import("../src/daily-planner.js");
  const { TaskStore } = await import("../src/task-store.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-plan2-"));
  const tasks = new TaskStore({ dataDir: dir });
  const t = tasks.add({ title: "Reply to Acme", bucket: "today", priority: 80 }, { source: "manual", queue: "user" });

  let seenPrompt = null;
  const runtime = {
    tasks,
    tools: {
      get: (name) => name === "calendar_events_between"
        ? { handler: async () => ([{ summary: "Standup", start: new Date().toISOString(), end: new Date().toISOString(), allDay: false }]) }
        : undefined
    },
    agentHost: {
      modelProvider: {
        isConfigured: () => true,
        generate: async ({ input }) => {
          seenPrompt = input;
          return { text: JSON.stringify({
            focus: [{ title: "Reply to Acme", taskId: t.id, why: "promised yesterday" }],
            agentWillDo: [{ action: "Draft the Acme reply", detail: "based on the thread" }],
            timeSensitive: ["Acme reply due today"],
            note: "Light meeting load — good focus day."
          }) };
        }
      }
    }
  };

  const plan = await computeDailyPlan(runtime, { date: new Date(), useLLM: true });
  assert.equal(plan.synthesized, true);
  assert.match(seenPrompt, /Standup/, "calendar fed into prompt");
  assert.match(seenPrompt, /Reply to Acme/, "tasks fed into prompt");
  assert.equal(plan.focus[0].title, "Reply to Acme");
  assert.equal(plan.agentWillDo[0].action, "Draft the Acme reply");
  assert.equal(plan.note, "Light meeting load — good focus day.");
  assert.equal(plan.counts.events, 1);

  fs.rmSync(dir, { recursive: true });
});

test("computer-use: input-synthesis tools refuse honestly (record intent, then throw — no fake success)", async () => {
  const { ToolRegistry } = await import("../src/tool-registry.js");
  const { registerComputerUseTools } = await import("../src/integrations/computer-use.js");
  const { ComputerUseLog } = await import("../src/computer-use-log.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-cu-honest-"));
  const registry = new ToolRegistry();
  const log = new ComputerUseLog({ dir });
  registerComputerUseTools(registry, { tools: registry, computerUseLog: log, observations: { search: async () => [] } });

  // Open a session (this genuinely works).
  const start = await registry.get("start_computer_use_session").handler({ goal: "do a thing" });
  assert.ok(start.sessionId);

  // computer_click must THROW — never report success.
  await assert.rejects(
    () => registry.get("computer_click").handler({ x: 10, y: 20, reasoning: "click the button" }),
    /not available in this build/
  );

  // But the intent must still be recorded to the audit log, marked unavailable.
  const actions = log.listActions({ sessionId: start.sessionId });
  const click = actions.find((a) => a.kind === "click");
  assert.ok(click, "click intent recorded for audit");
  assert.equal(click.status, "unavailable");
  assert.equal(click.args.x, 10);

  // computer_type + computer_key likewise refuse.
  await assert.rejects(() => registry.get("computer_type").handler({ text: "hi", reasoning: "type" }), /not available/);
  await assert.rejects(() => registry.get("computer_key").handler({ chord: "cmd+a", reasoning: "select" }), /not available/);

  // computer_screenshot returns REAL data (no fake-success flag).
  const shot = await registry.get("computer_screenshot").handler({ reasoning: "look" });
  assert.equal(shot.stubbed, undefined, "no 'stubbed' fake-success flag");
  assert.ok("ocrSample" in shot, "returns real OCR readback");

  fs.rmSync(dir, { recursive: true });
});

test("daily-planner: queuePlanActions bridges agentWillDo into draft-only agent-queue tasks", async () => {
  const { queuePlanActions, listQueuedPlanActions } = await import("../src/daily-planner.js");
  const { TaskStore } = await import("../src/task-store.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-plan-action-"));
  const tasks = new TaskStore({ dataDir: dir });
  const runtime = { tasks };

  const plan = {
    dateISO: "2026-05-25",
    agentWillDo: [
      { action: "Draft the Acme follow-up", detail: "based on yesterday's call" },
      { action: "Prepare board deck outline", detail: "" }
    ]
  };

  const queued = queuePlanActions(runtime, plan);
  assert.equal(queued, 2);

  // Landed on the AGENT queue, today bucket, tagged + lineage stamped.
  const agentTasks = tasks.list({ queue: "agent", limit: 50 });
  assert.equal(agentTasks.length, 2);
  const acme = agentTasks.find((t) => t.title === "Draft the Acme follow-up");
  assert.equal(acme.queue, "agent");
  assert.equal(acme.bucket, "today");
  assert.ok(acme.tags.includes("plan-action"));
  assert.equal(acme.sourceMeta.fromPlanDate, "2026-05-25");
  // Draft-only guard is in the description.
  assert.match(acme.description, /DRAFT or prepared artifact only/);
  assert.match(acme.description, /Do NOT send, publish/);
  // agentWillDo items get their queuedTaskId stamped.
  assert.equal(plan.agentWillDo[0].queuedTaskId, acme.id);

  // Re-running the planner the same day does NOT duplicate.
  const again = queuePlanActions(runtime, plan);
  assert.equal(again, 0, "dedup per plan-date + title");
  assert.equal(tasks.list({ queue: "agent", limit: 50 }).length, 2);

  // listQueuedPlanActions reflects live status.
  tasks.complete(acme.id, "agent");
  const reflected = listQueuedPlanActions(runtime, "2026-05-25");
  assert.equal(reflected.length, 2);
  assert.equal(reflected.find((a) => a.id === acme.id).status, "completed");

  // User-queue tasks are untouched by all this.
  assert.equal(tasks.list({ queue: "user", limit: 50 }).length, 0);

  fs.rmSync(dir, { recursive: true });
});

test("daily-planner: read-only compute does NOT queue actions (only the cron path does)", async () => {
  const { computeDailyPlan } = await import("../src/daily-planner.js");
  const { TaskStore } = await import("../src/task-store.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-plan-readonly-"));
  const tasks = new TaskStore({ dataDir: dir });
  const runtime = {
    tasks,
    tools: { get: () => undefined },
    agentHost: { modelProvider: { isConfigured: () => true, generate: async () => ({ text: JSON.stringify({ focus: [], agentWillDo: [{ action: "Draft something", detail: "" }], timeSensitive: [], note: null }) }) } }
  };
  // computeDailyPlan must not create any tasks — it's read-only.
  await computeDailyPlan(runtime, { date: new Date(), useLLM: true });
  assert.equal(tasks.list({ queue: "agent", limit: 50 }).length, 0, "compute alone queues nothing");

  fs.rmSync(dir, { recursive: true });
});

test("draft-store: save → edit → approve lifecycle, with events + persistence", async () => {
  const { DraftStore } = await import("../src/draft-store.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-drafts-"));
  const events = [];
  const runtime = { events: { emit: (name, data) => events.push({ name, data }) } };
  const store = new DraftStore({ dir: path.join(dir, "drafts"), runtime });

  const d = store.add({ title: "Follow-up to Acme", body: "Hi there,\n\nThanks for the call.", kind: "email", recipient: "acme@example.com", taskId: "task_1" });
  assert.match(d.id, /^draft_/);
  assert.equal(d.status, "pending");
  assert.equal(d.kind, "email");
  assert.equal(events.find((e) => e.name === "draft-created")?.data.id, d.id);

  // Unknown kind collapses to "other"; empty body rejected.
  assert.equal(store.add({ title: "x", body: "y", kind: "telepathy" }).kind, "other");
  assert.throws(() => store.add({ title: "x", body: "   " }), /requires a body/);

  // Edit the body before approving.
  const edited = store.edit(d.id, { body: "Hi there,\n\nThanks — sending the contract today." });
  assert.match(edited.body, /sending the contract/);
  assert.ok(edited.editedAt);

  // List shows pending only by default.
  assert.equal(store.list({ status: "pending" }).some((x) => x.id === d.id), true);

  // Approve resolves it (does NOT send — just marks approved).
  const approved = store.approve(d.id);
  assert.equal(approved.status, "approved");
  assert.equal(store.list({ status: "pending" }).some((x) => x.id === d.id), false);
  assert.equal(events.find((e) => e.name === "draft-resolved")?.data.status, "approved");

  // Can't re-resolve an approved draft.
  assert.equal(store.approve(d.id), null);
  assert.equal(store.edit(d.id, { body: "late edit" }), null, "can't edit a resolved draft");

  // Persistence round-trip.
  const store2 = new DraftStore({ dir: path.join(dir, "drafts"), runtime });
  assert.equal(store2.get(d.id).status, "approved");
  assert.match(store2.get(d.id).body, /sending the contract/);

  fs.rmSync(dir, { recursive: true });
});

test("draft-store: discard path + save_draft tool produces a reviewable draft (never sends)", async () => {
  const { DraftStore } = await import("../src/draft-store.js");
  const { ToolRegistry, registerCoreTools } = await import("../src/tool-registry.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-drafts2-"));
  const drafts = new DraftStore({ dir: path.join(dir, "drafts"), runtime: { events: { emit: () => {} } } });

  const registry = new ToolRegistry();
  const fakeRuntime = {
    drafts,
    memory: { remember: () => ({}), retrieve: () => [] },
    cron: { addJob: () => ({}), listJobs: () => [], removeJob: () => false },
    mcp: { listServers: () => [], listTools: () => [], registerServer: () => ({}), connect: () => Promise.resolve(), disconnect: () => Promise.resolve() },
    channels: { deliver: () => ({}) },
    introspector: { audit: () => ({}) },
    budget: { status: () => ({}) },
    skills: { list: () => [], run: () => ({}) },
    skillReplay: { run: () => ({}) },
    propagation: { retire: () => null },
    tasks: { add: () => ({}), list: () => [], get: () => null, complete: () => null, update: () => null }
  };
  registerCoreTools(registry, fakeRuntime);

  const saveDraft = registry.get("save_draft");
  assert.ok(saveDraft, "save_draft tool registered");
  const result = await saveDraft.handler({ title: "Board deck outline", body: "1. Metrics\n2. Roadmap", kind: "outline", taskId: "task_9" });
  assert.match(result.draftId, /^draft_/);
  assert.match(result.note, /NOT been sent/i);
  const saved = drafts.get(result.draftId);
  assert.equal(saved.title, "Board deck outline");
  assert.equal(saved.taskId, "task_9");
  assert.equal(saved.status, "pending");

  // Discard works.
  const discarded = drafts.discard(saved.id);
  assert.equal(discarded.status, "discarded");

  fs.rmSync(dir, { recursive: true });
});

test("draft-store: markSent records transport + only from pending/approved", async () => {
  const { DraftStore } = await import("../src/draft-store.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-draft-send-"));
  const events = [];
  const store = new DraftStore({ dir: path.join(dir, "drafts"), runtime: { events: { emit: (n, d) => events.push({ n, d }) } } });

  const d = store.add({ title: "Ping", body: "running late", kind: "message", recipient: "+15551234" });
  const sent = store.markSent(d.id, { channel: "sms", target: "+15551234", result: { delivered: true, sid: "SM123" } });
  assert.equal(sent.status, "sent");
  assert.equal(sent.sentVia.channel, "sms");
  assert.equal(sent.sendResult.sid, "SM123");
  assert.ok(sent.sentAt);
  assert.equal(events.find((e) => e.n === "draft-resolved")?.d.status, "sent");

  // Can't send an already-sent (or discarded) draft.
  assert.equal(store.markSent(d.id, { channel: "sms", target: "x" }), null);
  const d2 = store.add({ title: "x", body: "y" });
  store.discard(d2.id);
  assert.equal(store.markSent(d2.id, { channel: "sms", target: "x" }), null);

  // Sent drafts drop out of the pending list.
  assert.equal(store.list({ status: "pending" }).some((x) => x.id === d.id), false);
  assert.equal(store.list({ status: "sent" }).some((x) => x.id === d.id), true);

  fs.rmSync(dir, { recursive: true });
});

test("drafts: send endpoint routes through a real channel and marks sent only on delivery", async () => {
  const { createHostedInterface } = await import("../src/hosted-interface.js");
  const { DraftStore } = await import("../src/draft-store.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-draft-ep-"));
  const drafts = new DraftStore({ dir: path.join(dir, "drafts"), runtime: { events: { emit: () => {} } } });
  const delivered = [];
  const fakeRuntime = {
    drafts,
    channels: {
      deliver: async ({ channel, target, text }) => {
        delivered.push({ channel, target, text });
        return { delivered: true, sid: "SM_ok" };
      }
    },
    events: { on: () => {}, emit: () => {} }
  };
  const app = createHostedInterface(fakeRuntime, { port: 0 });
  const address = await app.listen();

  const d = drafts.add({ title: "Heads up", body: "on my way", kind: "message", recipient: "+15550000" });

  // Bad channel rejected (email has no transport).
  let resp = await fetch(`${address.url}/drafts/${d.id}/send`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: "email", target: "x@y.com" })
  });
  assert.equal(resp.status, 400);
  assert.equal(drafts.get(d.id).status, "pending", "not sent on bad channel");

  // Real channel delivers + marks sent.
  resp = await fetch(`${address.url}/drafts/${d.id}/send`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: "sms", target: "+15550000" })
  });
  assert.equal(resp.status, 200);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].text, "on my way");
  assert.equal(drafts.get(d.id).status, "sent");

  await app.close();
  fs.rmSync(dir, { recursive: true });
});

test("auth: verifyBuildBetterWebhook fails closed without a secret, matches header or query", async () => {
  const { verifyBuildBetterWebhook } = await import("../src/auth.js");
  // No configured secret → reject (fail closed; this triggers outbound calls).
  assert.equal(verifyBuildBetterWebhook({ headerValue: "x", expected: null }).ok, false);
  // Header match.
  assert.equal(verifyBuildBetterWebhook({ headerValue: "s3cret", expected: "s3cret" }).ok, true);
  // Query-param match (for webhook UIs that only take a URL).
  assert.equal(verifyBuildBetterWebhook({ queryValue: "s3cret", expected: "s3cret" }).ok, true);
  // Mismatch.
  assert.equal(verifyBuildBetterWebhook({ headerValue: "nope", expected: "s3cret" }).ok, false);
});

test("buildbetter: triggerSync coalesces concurrent pings into one in-flight + one trailing run", async () => {
  const { BuildBetterTaskSource } = await import("../src/integrations/buildbetter-tasks.js");
  const src = new BuildBetterTaskSource({ runtime: {}, apiKey: "k", userEmail: "u@x.com" });
  let active = 0, maxActive = 0, runs = 0;
  src.sync = async () => {
    active += 1; maxActive = Math.max(maxActive, active); runs += 1;
    await new Promise((r) => setTimeout(r, 10));
    active -= 1;
    return { created: 0 };
  };
  // Fire 5 pings nearly simultaneously.
  const results = await Promise.all([src.triggerSync(), src.triggerSync(), src.triggerSync(), src.triggerSync(), src.triggerSync()]);
  assert.equal(maxActive, 1, "never more than one sync in flight");
  // First call runs once + at most one trailing run for the burst → 2 syncs total.
  assert.ok(runs <= 2, `coalesced to <=2 syncs, got ${runs}`);
  assert.ok(results.some((r) => r.coalesced), "some pings were coalesced");
});

test("webhooks: /webhooks/buildbetter requires secret, then triggers a sync (202)", async () => {
  const { createHostedInterface } = await import("../src/hosted-interface.js");
  let synced = 0;
  const runtime = {
    buildBetterTaskSource: { isConfigured: () => true, triggerSync: async () => { synced += 1; return { created: 1 }; } },
    events: { on: () => {}, emit: () => {} }
  };
  const app = createHostedInterface(runtime, { port: 0, buildBetterWebhookSecret: "hook-secret" });
  const address = await app.listen();

  // No secret → 401.
  let resp = await fetch(`${address.url}/webhooks/buildbetter`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(resp.status, 401);

  // Correct secret via header → 202 + sync triggered.
  resp = await fetch(`${address.url}/webhooks/buildbetter`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-buildbetter-webhook-secret": "hook-secret" },
    body: JSON.stringify({ event: "call.processed" })
  });
  assert.equal(resp.status, 202);

  // Secret via query param also works.
  resp = await fetch(`${address.url}/webhooks/buildbetter?secret=hook-secret`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(resp.status, 202);

  // Give the fire-and-forget syncs a tick to run.
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(synced >= 1, "sync triggered by webhook");

  await app.close();
});

test("webhooks: /webhooks/buildbetter 503s (not a false 202) when the source is unconfigured", async () => {
  const { createHostedInterface } = await import("../src/hosted-interface.js");
  let synced = 0;
  const runtime = {
    // Source is registered (so a mid-session MCP login works) but has no creds yet.
    buildBetterTaskSource: { isConfigured: () => false, triggerSync: async () => { synced += 1; } },
    events: { on: () => {}, emit: () => {} }
  };
  const app = createHostedInterface(runtime, { port: 0, buildBetterWebhookSecret: "hook-secret" });
  const address = await app.listen();
  const resp = await fetch(`${address.url}/webhooks/buildbetter?secret=hook-secret`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(resp.status, 503, "unconfigured → 503 so BuildBetter retries, not a swallowed 202");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(synced, 0, "no sync attempted while unconfigured");
  await app.close();
});
