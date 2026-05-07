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
