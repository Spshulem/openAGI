import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AUTO_DISCARDED,
  AUTO_DISMISSED,
  BacklogTriage,
  TRIAGE_VERDICT_SCHEMA,
  canonicalCycle,
  candidateTitle,
  classifyDeterministic,
  jaccard,
  parseJsonArray,
  rankCritical,
  readLatestTriageReport,
  renderTriageMarkdown,
  sampleVerdicts,
  summarizeTriagePass,
  titleTokens,
  undoTriagePass,
  validateVerdict
} from "../src/backlog-triage.js";
import { listAllSuggestions } from "../src/suggestion-feed.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-07-30T12:00:00.000Z");

// ─── fixtures ────────────────────────────────────────────────────────────

function tempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-triage-"));
  fs.mkdirSync(path.join(dir, "proactive", "suggestions"), { recursive: true });
  fs.mkdirSync(path.join(dir, "skills-suggested"), { recursive: true });
  return dir;
}

function writeSuggestion(dir, record) {
  const sub = record.id.startsWith("prop_") ? path.join("proactive", "suggestions") : "skills-suggested";
  fs.writeFileSync(path.join(dir, sub, `${record.id}.json`), JSON.stringify(record, null, 2));
  return record;
}

// Titles that are genuinely DIFFERENT asks. Naming fixtures "Suggestion 1",
// "Suggestion 2" would make every one of them a near-duplicate of the others
// under the supersession rule (the digits are dropped as noise), so a batching
// test would silently be testing dedupe instead.
const WORDS = [
  "invoice", "calendar", "recorder", "stripe", "telemetry", "onboarding", "migration", "webhook",
  "analytics", "dashboard", "branch", "deploy", "backup", "firmware", "latency", "payroll",
  "roadmap", "schema", "tunnel", "upgrade", "vendor", "warehouse", "quota", "yield",
  "zoning", "archive", "budget", "cluster", "dossier", "escrow"
];
// ONE distinguishing word per title. Two words drawn from the same bank is a
// trap: {recorder, schema} and {schema, recorder} are the same token SET, so
// the pair would collapse as duplicates and the test would prove nothing.
function distinctTitle(i) {
  assert.ok(i < WORDS.length, "distinctTitle needs one word per fixture");
  return `Follow up on the ${WORDS[i]} rollout`;
}

function observer(id, overrides = {}) {
  return {
    id,
    proposedAt: new Date(NOW.getTime() - 30 * DAY).toISOString(),
    source: "proactive-observer",
    category: "task",
    // The id survives tokenization (punctuation is stripped, not split), so the
    // default title is unique per fixture rather than a near-duplicate of every
    // other one.
    title: `Follow up on ${id.replace(/[^a-z0-9]/gi, "")}`,
    rationale: "Some reason it was proposed.",
    mcpRegister: null,
    status: "pending",
    ...overrides
  };
}

function mined(id, overrides = {}) {
  return {
    id,
    proposedAt: new Date(NOW.getTime() - 30 * DAY).toISOString(),
    source: "pattern-miner",
    fingerprint: "app.a→app.b→app.a→app.b",
    status: "pending",
    sequence: { count: 12, distinctDays: 6, confidence: 0.95, cadence: { type: "daily" } },
    proposal: { name: `${id}-slug`, description: "Do the thing after the other thing." },
    ...overrides
  };
}

// A DraftStore-shaped stub. Only the members backlog-triage touches: it must
// never reach past this surface, and the test would fail loudly if it did.
function draftStore(items) {
  const map = new Map(items.map((d) => [d.id, { status: "pending", ...d }]));
  return {
    snapshots: 0,
    list({ status = "pending" } = {}) {
      return [...map.values()].filter((d) => (status ? d.status === status : true));
    },
    get(id) { return map.get(id) ?? null; },
    snapshot() { this.snapshots += 1; }
  };
}

/// Stub provider matching the shape backlog-triage requires. `reply` receives
/// the batch items so a test can answer per item.
function stubProvider(reply, { model = "claude-haiku-4-5" } = {}) {
  return {
    calls: [],
    model,
    isConfigured() { return true; },
    resolveModel({ task }) { return task === "sweep" ? model : model; },
    async generate(args) {
      const items = args.input.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
      this.calls.push({ task: args.task, instructions: args.instructions, items });
      return { provider: "stub", model, text: JSON.stringify(reply(items)) };
    }
  };
}

function makeRuntime({ dir, drafts = draftStore([]), provider = null, budget = null, events = [] } = {}) {
  return {
    dataDir: dir,
    drafts,
    tasks: { list: () => [] },
    budget,
    agentHost: { modelProvider: provider },
    events: { emit: (name, payload) => events.push({ name, payload }) },
    _events: events
  };
}

// ─── the verdict schema ──────────────────────────────────────────────────

test("validateVerdict accepts a well-formed verdict and normalizes it", () => {
  const r = validateVerdict({ i: 2, verdict: "keep", confidence: 0.9, reason: "  Still open work on PR #4  ", stillMattersScore: 1.4 }, 5);
  assert.equal(r.ok, true);
  assert.equal(r.value.i, 2);
  assert.equal(r.value.reason, "Still open work on PR #4");
  // Out-of-range scores clamp rather than reject: the verdict is still usable.
  assert.equal(r.value.stillMattersScore, 1);
});

test("validateVerdict rejects every malformed shape the model could emit", () => {
  const bad = [
    [{ i: 9, verdict: "keep", confidence: 1, reason: "index past the batch" }, "i out of range"],
    [{ i: -1, verdict: "keep", confidence: 1, reason: "negative index" }, "i out of range"],
    [{ i: 1.5, verdict: "keep", confidence: 1, reason: "fractional index" }, "i out of range"],
    [{ i: 0, verdict: "delete", confidence: 1, reason: "not in the enum" }, "bad verdict"],
    [{ i: 0, verdict: "dismiss", confidence: 2, reason: "confidence over one" }, "bad confidence"],
    [{ i: 0, verdict: "dismiss", confidence: "high", reason: "confidence not a number" }, "bad confidence"],
    [{ i: 0, verdict: "dismiss", confidence: 1, reason: "nope" }, "reason too short"],
    [{ i: 0, verdict: "dismiss", confidence: 1 }, "reason too short"],
    [null, "not an object"],
    ["dismiss", "not an object"]
  ];
  for (const [input, expected] of bad) {
    const r = validateVerdict(input, 5);
    assert.equal(r.ok, false, `expected ${JSON.stringify(input)} to be rejected`);
    assert.equal(r.error, expected);
  }
});

test("the schema embedded in the prompt is the one the validator enforces", () => {
  // Prompt and parser drifting apart is the classic structured-output failure.
  // They share one object, so this asserts the contract is single-sourced.
  assert.deepEqual(TRIAGE_VERDICT_SCHEMA.required, ["i", "verdict", "confidence", "reason"]);
  assert.deepEqual(TRIAGE_VERDICT_SCHEMA.properties.verdict.enum, ["dismiss", "keep", "unsure"]);
  for (const verdict of TRIAGE_VERDICT_SCHEMA.properties.verdict.enum) {
    assert.equal(validateVerdict({ i: 0, verdict, confidence: 0.9, reason: "a long enough reason" }, 1).ok, true);
  }
});

test("parseJsonArray survives fences, prose and garbage", () => {
  assert.deepEqual(parseJsonArray('```json\n[{"i":0}]\n```'), [{ i: 0 }]);
  assert.deepEqual(parseJsonArray('Sure! Here you go: [{"i":1}] hope that helps'), [{ i: 1 }]);
  assert.deepEqual(parseJsonArray("not json at all"), []);
  assert.deepEqual(parseJsonArray('[{"i":0},]'), []);
  assert.deepEqual(parseJsonArray('{"i":0}'), []);
  assert.deepEqual(parseJsonArray(null), []);
});

// ─── deterministic rules ─────────────────────────────────────────────────

test("dead-end categories are retired because accepting them does nothing", () => {
  const { resolved, ambiguous } = classifyDeterministic({
    suggestions: [
      observer("prop_1", { category: "automation" }),
      observer("prop_2", { category: "reminder" }),
      observer("prop_3", { category: "task" })
    ],
    now: NOW
  });
  const rules = resolved.map((r) => r.rule);
  assert.deepEqual(rules, ["dead-end-category", "dead-end-category"]);
  assert.equal(ambiguous.length, 1);
  assert.equal(ambiguous[0].id, "prop_3");
  assert.match(resolved[0].reason, /no accept action on the server/);
  assert.equal(resolved[0].evidence.category, "automation");
});

test("an mcp suggestion with nothing to register is a dead end too", () => {
  const { resolved, ambiguous } = classifyDeterministic({
    suggestions: [
      observer("prop_1", { category: "mcp", mcpRegister: null }),
      observer("prop_2", { category: "mcp", mcpRegister: { command: "npx", args: ["x"] } })
    ],
    now: NOW
  });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].rule, "dead-end-mcp");
  assert.equal(ambiguous[0].id, "prop_2");
});

test("the newest of a set of restated observer suggestions survives, older ones cite it", () => {
  const { resolved, ambiguous } = classifyDeterministic({
    suggestions: [
      observer("prop_old", { title: "Run the agent autopilot pulse", proposedAt: new Date(NOW.getTime() - 40 * DAY).toISOString() }),
      observer("prop_new", { title: "Run the next agent autopilot pulse", proposedAt: new Date(NOW.getTime() - 10 * DAY).toISOString() }),
      observer("prop_other", { title: "Reply to the invoice email from Acme", proposedAt: new Date(NOW.getTime() - 20 * DAY).toISOString() })
    ],
    now: NOW
  });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].id, "prop_old");
  assert.equal(resolved[0].rule, "superseded-duplicate");
  assert.equal(resolved[0].evidence.supersededBy, "prop_new");
  assert.ok(resolved[0].evidence.similarity >= 0.65);
  // The survivor and the genuinely different ask both stay in play.
  assert.deepEqual(ambiguous.map((a) => a.id).sort(), ["prop_new", "prop_other"]);
});

test("supersession never crosses categories", () => {
  // "Connect GitHub MCP" as an mcp registration and as a task are different
  // asks with different accept actions, however similar the words are.
  const { resolved } = classifyDeterministic({
    suggestions: [
      observer("prop_a", { title: "Connect GitHub MCP", category: "mcp", mcpRegister: { command: "npx" }, proposedAt: new Date(NOW.getTime() - 40 * DAY).toISOString() }),
      observer("prop_b", { title: "Connect GitHub MCP", category: "task", proposedAt: new Date(NOW.getTime() - 10 * DAY).toISOString() })
    ],
    now: NOW
  });
  assert.equal(resolved.length, 0);
});

test("mined candidates dedupe on the app loop, not on their slug", () => {
  const { resolved, ambiguous } = classifyDeterministic({
    suggestions: [
      mined("sug_short", { fingerprint: "app.a→app.b→app.a→app.b", proposedAt: new Date(NOW.getTime() - 40 * DAY).toISOString() }),
      mined("sug_long", { fingerprint: "app.b→app.a→app.b→app.a→app.b→app.a", proposedAt: new Date(NOW.getTime() - 9 * DAY).toISOString() }),
      mined("sug_diff", { fingerprint: "app.c→app.d", proposedAt: new Date(NOW.getTime() - 20 * DAY).toISOString() })
    ],
    now: NOW
  });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].id, "sug_short");
  assert.equal(resolved[0].evidence.match, "app-cycle");
  assert.equal(resolved[0].evidence.supersededBy, "sug_long");
  assert.deepEqual(ambiguous.map((a) => a.id).sort(), ["sug_diff", "sug_long"]);
});

test("canonicalCycle collapses window length and rotation, and only those", () => {
  assert.equal(canonicalCycle("a→b→a→b"), canonicalCycle("b→a→b→a→b→a"));
  assert.equal(canonicalCycle("a→b→a"), canonicalCycle("a→b"));
  assert.equal(canonicalCycle("a→a→a→b"), canonicalCycle("a→b"));
  assert.notEqual(canonicalCycle("a→b→c"), canonicalCycle("a→c→b"));
  assert.notEqual(canonicalCycle("a→b"), canonicalCycle("a→c"));
  assert.equal(canonicalCycle(""), "");
});

test("items inside the fresh window cost nothing and are left alone", () => {
  const { resolved, keptFresh, ambiguous } = classifyDeterministic({
    suggestions: [
      observer("prop_fresh", { title: "Brand new idea about widgets", proposedAt: new Date(NOW.getTime() - 2 * DAY).toISOString() }),
      observer("prop_stale", { title: "An entirely separate old ask", proposedAt: new Date(NOW.getTime() - 20 * DAY).toISOString() })
    ],
    now: NOW
  });
  assert.equal(resolved.length, 0);
  assert.deepEqual(keptFresh.map((k) => k.id), ["prop_fresh"]);
  assert.deepEqual(ambiguous.map((a) => a.id), ["prop_stale"]);
});

test("weak mined evidence retires on the numbers, and never on age alone", () => {
  const old = new Date(NOW.getTime() - 45 * DAY).toISOString();
  const { resolved, ambiguous } = classifyDeterministic({
    suggestions: [
      mined("sug_weak", { fingerprint: "a→b", proposedAt: old, sequence: { count: 2, distinctDays: 1, confidence: 0.9 } }),
      mined("sug_strong", { fingerprint: "c→d", proposedAt: old, sequence: { count: 30, distinctDays: 9, confidence: 0.99 } })
    ],
    now: NOW
  });
  assert.deepEqual(resolved.map((r) => r.id), ["sug_weak"]);
  assert.equal(resolved[0].rule, "weak-mined-evidence");
  assert.equal(resolved[0].evidence.count, 2);
  // Same age, strong numbers: the rules refuse to decide it, so it goes to the model.
  assert.deepEqual(ambiguous.map((a) => a.id), ["sug_strong"]);
});

test("a weak mined pattern younger than the stale window is never retired by rule", () => {
  const { resolved, ambiguous } = classifyDeterministic({
    suggestions: [mined("sug_weak", { proposedAt: new Date(NOW.getTime() - 10 * DAY).toISOString(), sequence: { count: 1, distinctDays: 1, confidence: 0.2 } })],
    now: NOW
  });
  assert.equal(resolved.length, 0);
  assert.deepEqual(ambiguous.map((a) => a.id), ["sug_weak"]);
});

test("only superseded re-drafts are retired — a completed parent task never justifies it", () => {
  // The trap this guards: for a draft-only task, "completed" means the AGENT
  // finished the draft, not that the user acted on it. 96 of the 97 pending
  // drafts on the real install sit under a completed+archived task.
  const drafts = [
    { id: "draft_a", taskId: "task_1", title: "First attempt", createdAt: new Date(NOW.getTime() - 40 * DAY).toISOString() },
    { id: "draft_b", taskId: "task_1", title: "Second attempt", createdAt: new Date(NOW.getTime() - 30 * DAY).toISOString() },
    { id: "draft_c", taskId: "task_1", title: "Latest", createdAt: new Date(NOW.getTime() - 5 * DAY).toISOString() },
    { id: "draft_solo", taskId: "task_2", title: "Only draft for its task", createdAt: new Date(NOW.getTime() - 60 * DAY).toISOString() }
  ];
  const taskIndex = new Map([["task_2", { id: "task_2", title: "Done and dusted", status: "completed" }]]);
  const { resolved } = classifyDeterministic({ drafts, taskIndex, now: NOW });
  assert.deepEqual(resolved.map((r) => r.id).sort(), ["draft_a", "draft_b"]);
  assert.equal(resolved[0].kind, "draft");
  assert.equal(resolved[0].evidence.supersededBy, "draft_c");
  assert.equal(resolved[0].evidence.draftsForTask, 3);
  // The lone draft under a COMPLETED task is exactly what must survive.
  assert.equal(resolved.some((r) => r.id === "draft_solo"), false);
});

test("every deterministic resolution carries a reason and its evidence", () => {
  const { resolved } = classifyDeterministic({
    suggestions: [
      observer("prop_dead", { category: "automation" }),
      observer("prop_old", { title: "Same words here now", proposedAt: new Date(NOW.getTime() - 40 * DAY).toISOString() }),
      observer("prop_new", { title: "Same words here now", proposedAt: new Date(NOW.getTime() - 8 * DAY).toISOString() }),
      mined("sug_weak", { proposedAt: new Date(NOW.getTime() - 40 * DAY).toISOString(), sequence: { count: 1, distinctDays: 1, confidence: 0.1 } })
    ],
    now: NOW
  });
  assert.equal(resolved.length, 3);
  for (const r of resolved) {
    assert.ok(r.reason.length >= 20, `reason too thin: ${r.reason}`);
    assert.ok(r.evidence && Object.keys(r.evidence).length > 0);
    assert.equal(r.decidedBy, `rule:${r.rule}`);
    assert.equal(r.confidence, 1);
  }
});

test("token helpers behave", () => {
  assert.equal(jaccard(titleTokens("run the agent pulse"), titleTokens("run the next agent pulse")), 3 / 4);
  assert.equal(jaccard(titleTokens(""), titleTokens("anything")), 0);
  assert.equal(jaccard(titleTokens("alpha beta"), titleTokens("gamma delta")), 0);
  // Mined candidates title themselves with a slug; the description wins.
  assert.equal(candidateTitle({ title: "nightly-photo-web-review", proposal: { description: "Review photos then the web. Then stop." } }), "Review photos then the web.");
  assert.equal(candidateTitle({ title: "Triage PR #4437" }), "Triage PR #4437");
});

// ─── the LLM half ────────────────────────────────────────────────────────

test("with no provider the deterministic half still runs and the skip is reported", async () => {
  const dir = tempDataDir();
  writeSuggestion(dir, observer("prop_dead", { category: "automation" }));
  writeSuggestion(dir, observer("prop_open", { title: "Something genuinely ambiguous" }));
  const runtime = makeRuntime({ dir, provider: null });

  const report = await new BacklogTriage({ runtime, dataDir: dir }).run({ now: NOW });
  assert.equal(report.llm.attempted, false);
  assert.equal(report.llm.skipped, "no-provider");
  assert.equal(report.llm.deferred, 1);
  assert.equal(report.applied.suggestions, 1);
  assert.equal(listAllSuggestions(runtime, { status: "pending" }).length, 1);
});

test("a DeterministicModelProvider is treated as no provider at all", async () => {
  const dir = tempDataDir();
  writeSuggestion(dir, observer("prop_open", { title: "Something genuinely ambiguous" }));
  class DeterministicModelProvider {
    isConfigured() { return true; }
    async generate() { throw new Error("must never be called"); }
  }
  const runtime = makeRuntime({ dir, provider: new DeterministicModelProvider() });
  const report = await new BacklogTriage({ runtime, dataDir: dir }).run({ now: NOW });
  assert.equal(report.llm.skipped, "no-provider");
});

test("an exhausted budget skips the model and leaves the rule half applied", async () => {
  const dir = tempDataDir();
  writeSuggestion(dir, observer("prop_dead", { category: "automation" }));
  writeSuggestion(dir, observer("prop_open", { title: "Something genuinely ambiguous" }));
  const provider = stubProvider(() => { throw new Error("must never be called"); });
  const budget = {
    check() { const e = new Error("Daily budget reached"); e.code = "BUDGET_EXCEEDED"; throw e; },
    status() { return { remainingUsd: 0, spentUsd: 10 }; },
    priceFor() { return { in: 1, out: 5 }; }
  };
  const runtime = makeRuntime({ dir, provider, budget });

  const report = await new BacklogTriage({ runtime, dataDir: dir }).run({ now: NOW });
  assert.equal(report.llm.skipped, "budget-exhausted");
  assert.equal(report.llm.deferred, 1);
  assert.equal(provider.calls.length, 0);
  assert.equal(report.applied.suggestions, 1, "the deterministic retirement still landed");
});

test("the pass plans within a share of the remaining budget instead of blowing it", async () => {
  const dir = tempDataDir();
  for (let i = 0; i < 20; i += 1) writeSuggestion(dir, observer(`prop_${i}`, { title: distinctTitle(i) }));
  const provider = stubProvider((items) => items.map((it) => ({ i: it.i, verdict: "unsure", confidence: 0.5, reason: "cannot tell from this" })));
  // Enough left for well under one batch at these prices.
  const budget = { check() {}, status() { return { remainingUsd: 0.00001, spentUsd: 0 }; }, priceFor() { return { in: 3, out: 15 }; } };
  const runtime = makeRuntime({ dir, provider, budget });

  const report = await new BacklogTriage({ runtime, dataDir: dir, batchSize: 5 }).run({ now: NOW });
  assert.equal(provider.calls.length, 0);
  assert.equal(report.llm.stoppedEarly, "budget-plan");
  assert.equal(report.llm.deferred, 20, "nothing judged means everything deferred");
});

test("a provider that throws degrades instead of taking the job down", async () => {
  const dir = tempDataDir();
  for (let i = 0; i < 10; i += 1) writeSuggestion(dir, observer(`prop_${i}`, { title: distinctTitle(i) }));
  const provider = {
    calls: 0,
    isConfigured() { return true; },
    resolveModel() { return "claude-haiku-4-5"; },
    async generate() { this.calls += 1; throw new Error("upstream 503"); }
  };
  const runtime = makeRuntime({ dir, provider });

  const report = await new BacklogTriage({ runtime, dataDir: dir, batchSize: 2 }).run({ now: NOW });
  assert.equal(provider.calls, 1, "stops after the first failure rather than hammering a dead provider");
  assert.equal(report.llm.stoppedEarly, "provider-error");
  assert.ok(report.degraded.some((d) => d.includes("upstream 503")));
  assert.equal(report.llm.deferred, 10);
  assert.equal(report.applied.suggestions, 0);
});

test("batching sends one call per batch, not one per item, and routes by task", async () => {
  const dir = tempDataDir();
  for (let i = 0; i < 12; i += 1) writeSuggestion(dir, observer(`prop_${i}`, { title: distinctTitle(i) }));
  const provider = stubProvider((items) => items.map((it) => ({ i: it.i, verdict: "unsure", confidence: 0.5, reason: "cannot tell from this" })));
  const runtime = makeRuntime({ dir, provider });

  const report = await new BacklogTriage({ runtime, dataDir: dir, batchSize: 5 }).run({ now: NOW });
  assert.equal(provider.calls.length, 3);
  assert.deepEqual(provider.calls.map((c) => c.items.length), [5, 5, 2]);
  // No hardcoded model id anywhere: the call names a task and lets the
  // router resolve it, the same way daily-planner and task-sweep do.
  assert.deepEqual([...new Set(provider.calls.map((c) => c.task))], ["sweep"]);
  assert.match(provider.calls[0].instructions, /STRICT JSON array/);
  assert.equal(report.llm.model, "claude-haiku-4-5");
  assert.equal(report.llm.itemsSent, 12);
});

test("the cap bounds one pass and defers the rest instead of spending more", async () => {
  const dir = tempDataDir();
  for (let i = 0; i < 30; i += 1) {
    writeSuggestion(dir, observer(`prop_${i}`, {
      title: distinctTitle(i),
      proposedAt: new Date(NOW.getTime() - (10 + i) * DAY).toISOString()
    }));
  }
  const provider = stubProvider((items) => items.map((it) => ({ i: it.i, verdict: "unsure", confidence: 0.5, reason: "cannot tell from this" })));
  const runtime = makeRuntime({ dir, provider });

  const report = await new BacklogTriage({ runtime, dataDir: dir, maxLlmItems: 10, batchSize: 5 }).run({ now: NOW });
  assert.equal(report.llm.itemsSent, 10);
  assert.equal(report.llm.deferred, 20);
  // Oldest first: the tail is what the brief can never surface anyway.
  const sent = provider.calls.flatMap((c) => c.items.map((i) => i.ageDays));
  assert.deepEqual(sent, [...sent].sort((a, b) => b - a));
  assert.equal(sent[0], 39);
});

test("the LLM deadline is measured on the wall clock, not the injected `now`", async () => {
  // Regression: deriving the deadline from `now` meant any pass dated in the
  // past (a test, a catch-up run after a sleep) blew its whole budget of time
  // before making a single call and silently judged nothing.
  const dir = tempDataDir();
  const longAgo = new Date(NOW.getTime() - 400 * DAY);
  for (let i = 0; i < 4; i += 1) {
    writeSuggestion(dir, observer(`prop_${i}`, {
      title: distinctTitle(i),
      proposedAt: new Date(longAgo.getTime() - 30 * DAY).toISOString()
    }));
  }
  const provider = stubProvider((items) => items.map((it) => ({ i: it.i, verdict: "unsure", confidence: 0.5, reason: "cannot tell from this" })));
  const runtime = makeRuntime({ dir, provider });

  const report = await new BacklogTriage({ runtime, dataDir: dir, batchSize: 2 }).run({ now: longAgo });
  assert.equal(provider.calls.length, 2);
  assert.equal(report.llm.stoppedEarly, null);
});

test("the deadline stops the pass between batches and defers the rest", async () => {
  const dir = tempDataDir();
  for (let i = 0; i < 6; i += 1) writeSuggestion(dir, observer(`prop_${i}`, { title: distinctTitle(i) }));
  const provider = stubProvider((items) => items.map((it) => ({ i: it.i, verdict: "unsure", confidence: 0.5, reason: "cannot tell from this" })));
  const runtime = makeRuntime({ dir, provider });

  const report = await new BacklogTriage({ runtime, dataDir: dir, batchSize: 2, deadlineMs: -1 }).run({ now: NOW });
  assert.equal(provider.calls.length, 0);
  assert.equal(report.llm.stoppedEarly, "deadline");
  assert.equal(report.llm.deferred, 6);
});

test("drafts are snapshotted once per pass, not once per draft", async () => {
  const dir = tempDataDir();
  const drafts = draftStore([
    { id: "draft_1", taskId: "task_1", title: "a", createdAt: new Date(NOW.getTime() - 40 * DAY).toISOString() },
    { id: "draft_2", taskId: "task_1", title: "b", createdAt: new Date(NOW.getTime() - 30 * DAY).toISOString() },
    { id: "draft_3", taskId: "task_1", title: "c", createdAt: new Date(NOW.getTime() - 2 * DAY).toISOString() },
    { id: "draft_4", taskId: "task_2", title: "d", createdAt: new Date(NOW.getTime() - 40 * DAY).toISOString() },
    { id: "draft_5", taskId: "task_2", title: "e", createdAt: new Date(NOW.getTime() - 2 * DAY).toISOString() }
  ]);
  const runtime = makeRuntime({ dir, drafts });
  const report = await new BacklogTriage({ runtime, dataDir: dir }).run({ now: NOW });
  assert.equal(report.applied.drafts, 3);
  assert.equal(drafts.snapshots, 1, "DraftStore rewrites the whole file per snapshot");
  assert.deepEqual(drafts.list({ status: "pending" }).map((d) => d.id), ["draft_3", "draft_5"]);
});

test("only a confident, well-reasoned dismiss retires anything", async () => {
  const dir = tempDataDir();
  writeSuggestion(dir, observer("prop_sure", { title: "Alpha ask about the first topic" }));
  writeSuggestion(dir, observer("prop_hedged", { title: "Beta ask about the second topic" }));
  writeSuggestion(dir, observer("prop_keep", { title: "Gamma ask about the third topic" }));
  const byTitle = (items, word) => items.find((i) => i.title.startsWith(word)).i;
  const provider = stubProvider((items) => [
    { i: byTitle(items, "Alpha"), verdict: "dismiss", confidence: 0.95, reason: "The PR it refers to was merged weeks ago." },
    { i: byTitle(items, "Beta"), verdict: "dismiss", confidence: 0.4, reason: "Might be done, but I honestly cannot tell." },
    { i: byTitle(items, "Gamma"), verdict: "keep", confidence: 0.9, stillMattersScore: 0.8, reason: "Still names an unshipped branch." }
  ]);
  const runtime = makeRuntime({ dir, provider });

  const report = await new BacklogTriage({ runtime, dataDir: dir }).run({ now: NOW });
  assert.equal(report.llm.verdicts.dismiss, 1);
  assert.equal(report.llm.verdicts.lowConfidence, 1);
  assert.equal(report.llm.verdicts.keep, 1);
  assert.equal(report.applied.suggestions, 1);

  const pending = listAllSuggestions(runtime, { status: "pending" }).map((s) => s.id).sort();
  assert.deepEqual(pending, ["prop_hedged", "prop_keep"], "a hedged dismiss leaves the item in the queue");
});

test("malformed verdicts are counted and resolve nothing", async () => {
  const dir = tempDataDir();
  writeSuggestion(dir, observer("prop_a", { title: "Alpha ask about the first topic" }));
  writeSuggestion(dir, observer("prop_b", { title: "Beta ask about the second topic" }));
  const provider = stubProvider(() => [
    { i: 99, verdict: "dismiss", confidence: 1, reason: "a hallucinated index that must not map onto anything" },
    { i: 0, verdict: "obliterate", confidence: 1, reason: "a verdict that is not in the enum" },
    { i: 1, verdict: "dismiss", confidence: 1, reason: "no" }
  ]);
  const runtime = makeRuntime({ dir, provider });

  const report = await new BacklogTriage({ runtime, dataDir: dir }).run({ now: NOW });
  assert.equal(report.llm.verdicts.invalid, 3);
  assert.equal(report.applied.suggestions, 0);
  assert.equal(listAllSuggestions(runtime, { status: "pending" }).length, 2);
});

test("a rule-side keep is never overturned by the model — rules run first and win", async () => {
  const dir = tempDataDir();
  // Fresh: resolved as keptFresh, so it is never in the batch at all.
  writeSuggestion(dir, observer("prop_fresh", { title: "Brand new ask", proposedAt: new Date(NOW.getTime() - 1 * DAY).toISOString() }));
  const provider = stubProvider((items) => items.map((it) => ({ i: it.i, verdict: "dismiss", confidence: 1, reason: "would retire everything given the chance" })));
  const runtime = makeRuntime({ dir, provider });

  const report = await new BacklogTriage({ runtime, dataDir: dir }).run({ now: NOW });
  assert.equal(provider.calls.length, 0);
  assert.equal(report.llm.skipped, "no-candidates");
  assert.equal(listAllSuggestions(runtime, { status: "pending" }).length, 1);
});

// ─── writes, reversibility, safety ───────────────────────────────────────

test("an automated resolution is distinguishable from a human one and records why", async () => {
  const dir = tempDataDir();
  writeSuggestion(dir, observer("prop_dead", { category: "automation" }));
  const runtime = makeRuntime({ dir });

  const report = await new BacklogTriage({ runtime, dataDir: dir }).run({ now: NOW });
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "proactive", "suggestions", "prop_dead.json"), "utf8"));

  assert.equal(raw.status, AUTO_DISMISSED);
  assert.notEqual(raw.status, "dismissed", "must not collide with the status a human click writes");
  assert.equal(raw.autoTriage.passId, report.passId);
  assert.equal(raw.autoTriage.previousStatus, "pending");
  assert.equal(raw.autoTriage.decidedBy, "rule:dead-end-category");
  assert.ok(raw.autoTriage.reason.length > 20);
  assert.ok(raw.autoTriage.evidence.category);
  // The reason also lands in `note`, which suggestion-feed already carries into
  // the envelope, so the surfaces show WHY without any change to them.
  assert.equal(raw.note, raw.autoTriage.reason);
});

test("undoTriagePass restores every record the pass touched", async () => {
  const dir = tempDataDir();
  writeSuggestion(dir, observer("prop_dead", { category: "automation" }));
  writeSuggestion(dir, observer("prop_old", { title: "Same words repeated", proposedAt: new Date(NOW.getTime() - 40 * DAY).toISOString() }));
  writeSuggestion(dir, observer("prop_new", { title: "Same words repeated", proposedAt: new Date(NOW.getTime() - 9 * DAY).toISOString() }));
  const drafts = draftStore([
    { id: "draft_old", taskId: "task_1", title: "First", createdAt: new Date(NOW.getTime() - 30 * DAY).toISOString() },
    { id: "draft_new", taskId: "task_1", title: "Latest", createdAt: new Date(NOW.getTime() - 3 * DAY).toISOString() }
  ]);
  const runtime = makeRuntime({ dir, drafts });

  const report = await new BacklogTriage({ runtime, dataDir: dir }).run({ now: NOW });
  assert.equal(report.applied.suggestions, 2);
  assert.equal(report.applied.drafts, 1);
  assert.equal(drafts.get("draft_old").status, AUTO_DISCARDED);
  assert.equal(listAllSuggestions(runtime, { status: "pending" }).length, 1);

  const undone = undoTriagePass(runtime, report.passId, { dataDir: dir });
  assert.equal(undone.ok, true);
  assert.equal(undone.restored, 3);
  assert.equal(listAllSuggestions(runtime, { status: "pending" }).length, 3);
  assert.equal(drafts.get("draft_old").status, "pending");
  assert.equal(drafts.get("draft_old").autoTriage, undefined);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "proactive", "suggestions", "prop_dead.json"), "utf8"));
  assert.equal(raw.status, "pending");
  assert.equal(raw.autoTriage, undefined);
  assert.equal(raw.resolvedAt, null);
});

test("undo works from the latest pointer and refuses records a human touched since", async () => {
  const dir = tempDataDir();
  writeSuggestion(dir, observer("prop_a", { category: "automation" }));
  writeSuggestion(dir, observer("prop_b", { category: "automation" }));
  const runtime = makeRuntime({ dir });
  await new BacklogTriage({ runtime, dataDir: dir }).run({ now: NOW });

  // The user went and accepted one of the auto-dismissed rows from the
  // dashboard (the accept route looks items up with status: null, so this is a
  // real thing that happens). Undo must not stamp "pending" back over it.
  const file = path.join(dir, "proactive", "suggestions", "prop_b.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.status = "accepted";
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));

  const undone = undoTriagePass(runtime, "latest", { dataDir: dir });
  assert.equal(undone.restored, 1);
  assert.equal(undone.skipped, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).status, "accepted");
});

test("undo reports missing work rather than throwing", () => {
  const dir = tempDataDir();
  const result = undoTriagePass(makeRuntime({ dir }), "triage_nope", { dataDir: dir });
  assert.equal(result.ok, false);
  assert.match(result.error, /no triage report/);
});

test("a dry run reports the full plan and changes nothing", async () => {
  const dir = tempDataDir();
  writeSuggestion(dir, observer("prop_dead", { category: "automation" }));
  const drafts = draftStore([
    { id: "draft_old", taskId: "task_1", title: "First", createdAt: new Date(NOW.getTime() - 30 * DAY).toISOString() },
    { id: "draft_new", taskId: "task_1", title: "Latest", createdAt: new Date(NOW.getTime() - 3 * DAY).toISOString() }
  ]);
  const runtime = makeRuntime({ dir, drafts });

  const report = await new BacklogTriage({ runtime, dataDir: dir }).run({ now: NOW, dryRun: true });
  assert.equal(report.applied.wouldApply, 2);
  assert.equal(report.applied.suggestions, 0);
  assert.equal(report.applied.drafts, 0);
  assert.equal(drafts.get("draft_old").status, "pending");
  assert.equal(drafts.snapshots, 0);
  assert.equal(listAllSuggestions(runtime, { status: "pending" }).length, 1);
  assert.equal(fs.existsSync(path.join(dir, "backlog-triage", "latest.json")), false);
});

test("the resolution ceiling bounds the blast radius of one bad pass", async () => {
  const dir = tempDataDir();
  for (let i = 0; i < 12; i += 1) writeSuggestion(dir, observer(`prop_${i}`, { category: "automation" }));
  const runtime = makeRuntime({ dir });

  const report = await new BacklogTriage({ runtime, dataDir: dir, maxResolutions: 5 }).run({ now: NOW });
  assert.equal(report.prefilter.resolved, 12);
  assert.equal(report.applied.cappedAt, 5);
  assert.equal(report.applied.suggestions, 5);
  assert.equal(listAllSuggestions(runtime, { status: "pending" }).length, 7);
});

test("a record resolved between scan and write is left alone", async () => {
  const dir = tempDataDir();
  writeSuggestion(dir, observer("prop_dead", { category: "automation", status: "accepted" }));
  const runtime = makeRuntime({ dir });
  // listAllSuggestions filters on status, so force the resolution path directly.
  const triage = new BacklogTriage({ runtime, dataDir: dir });
  const wrote = triage.retireSuggestion(dir, { id: "prop_dead", rule: "dead-end-category", decidedBy: "rule:x", reason: "long enough reason here", evidence: {} }, "pass_1", []);
  assert.equal(wrote, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "proactive", "suggestions", "prop_dead.json"), "utf8")).status, "accepted");
});

test("an unreadable store degrades the report instead of throwing", async () => {
  const runtime = {
    dataDir: "/definitely/not/a/real/path",
    drafts: { list() { throw new Error("draft store on fire"); } },
    tasks: { list() { throw new Error("task store on fire"); } },
    agentHost: { modelProvider: null },
    events: { emit() {} }
  };
  const report = await new BacklogTriage({ runtime, dataDir: "/definitely/not/a/real/path" }).run({ now: NOW });
  assert.ok(report.degraded.some((d) => d.startsWith("drafts:")));
  assert.ok(report.degraded.some((d) => d.startsWith("tasks:")));
  assert.equal(report.scanned.suggestions, 0);
});

test("a broken event bus cannot lose a pass whose writes already landed", async () => {
  const dir = tempDataDir();
  writeSuggestion(dir, observer("prop_dead", { category: "automation" }));
  const runtime = makeRuntime({ dir });
  runtime.events = { emit() { throw new Error("bus exploded"); } };

  const report = await new BacklogTriage({ runtime, dataDir: dir }).run({ now: NOW });
  assert.equal(report.applied.suggestions, 1);
  assert.ok(report.degraded.some((d) => d.includes("bus exploded")));
  assert.ok(readLatestTriageReport(runtime, { dataDir: dir }), "the report is still on disk for undo");
});

// ─── reporting ───────────────────────────────────────────────────────────

test("the pass persists a report the dashboard can read back", async () => {
  const dir = tempDataDir();
  writeSuggestion(dir, observer("prop_dead", { category: "automation" }));
  const runtime = makeRuntime({ dir });

  const report = await new BacklogTriage({ runtime, dataDir: dir }).run({ now: NOW });
  const latest = readLatestTriageReport(runtime, { dataDir: dir });
  assert.equal(latest.passId, report.passId);
  assert.ok(fs.existsSync(path.join(dir, "backlog-triage", `${report.passId}.json`)));
  assert.match(renderTriageMarkdown(latest), /Backlog triage/);
  assert.match(renderTriageMarkdown(null), /No backlog triage/);
});

test("the pass emits one summary event, small enough to log", async () => {
  const dir = tempDataDir();
  writeSuggestion(dir, observer("prop_dead", { category: "automation" }));
  const events = [];
  const runtime = makeRuntime({ dir, events });

  const report = await new BacklogTriage({ runtime, dataDir: dir }).run({ now: NOW });
  const emitted = events.filter((e) => e.name === "backlog-triage");
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].payload.passId, report.passId);
  assert.equal(emitted[0].payload.retired, 1);
  assert.equal(emitted[0].payload.samples, undefined, "samples stay in the report, not the event");
  assert.ok(JSON.stringify(emitted[0].payload).length < 800);
});

test("critical ranking orders by how much it still matters, and only from judged keeps", () => {
  const ranked = rankCritical([
    { id: "a", kind: "suggestion", title: "Low", category: "task", stillMattersScore: 0.2, confidence: 0.9, ageDays: 40, reason: "minor", decidedBy: "llm:x" },
    { id: "b", kind: "suggestion", title: "High", category: "task", stillMattersScore: 0.9, confidence: 0.9, ageDays: 12, reason: "blocking", decidedBy: "llm:x" },
    { id: "c", kind: "suggestion", title: "Mid", category: "task", stillMattersScore: 0.5, confidence: 0.9, ageDays: 30, reason: "worth it", decidedBy: "llm:x" }
  ], 2);
  assert.deepEqual(ranked.map((r) => r.id), ["b", "c"]);
  assert.equal(ranked[0].acceptPath, "/proactive/suggestions/b/accept");
  assert.deepEqual(rankCritical([], 5), []);
});

test("samples spread across rules, oldest first, so the judgement can be argued with", () => {
  const resolutions = [
    { id: "r1", kind: "suggestion", rule: "dead-end-category", decidedBy: "rule:a", title: "x", ageDays: 5, reason: "r", evidence: {} },
    { id: "r2", kind: "suggestion", rule: "dead-end-category", decidedBy: "rule:a", title: "x", ageDays: 50, reason: "r", evidence: {} },
    { id: "r3", kind: "suggestion", rule: "superseded-duplicate", decidedBy: "rule:b", title: "x", ageDays: 20, reason: "r", evidence: {} }
  ];
  const samples = sampleVerdicts(resolutions, [
    { id: "k1", kind: "suggestion", title: "keep me", ageDays: 9, reason: "still open", decidedBy: "llm:x" }
  ], 4);
  assert.deepEqual(samples.map((s) => s.id), ["r2", "r3", "k1", "r1"]);
  assert.equal(samples[2].verdict, "keep");
  assert.equal(samples[0].verdict, "auto-dismiss");
});

test("summarizeTriagePass is small and carries the counts that matter", async () => {
  const dir = tempDataDir();
  writeSuggestion(dir, observer("prop_dead", { category: "automation" }));
  const runtime = makeRuntime({ dir });
  const report = await new BacklogTriage({ runtime, dataDir: dir }).run({ now: NOW });
  const summary = summarizeTriagePass(report);
  assert.equal(summary.passId, report.passId);
  assert.deepEqual(summary.byRule, { "dead-end-category": 1 });
  assert.equal(summary.retired, 1);
});

// ─── wiring ──────────────────────────────────────────────────────────────

test("the runtime registers the triage job weekly, on a Sunday morning", async () => {
  const { createDurableRuntime } = await import("../src/abi-runtime.js");
  const runtime = createDurableRuntime({ dataDir: tempDataDir(), autoConnectMcp: false });
  const job = runtime.cron.listJobs().find((j) => j.id === "backlog-triage");
  assert.ok(job, "backlog-triage job is registered");
  assert.equal(job.task, "backlog-triage");
  assert.equal(job.enabled, true);
  assert.equal(job.intervalMs, 7 * 24 * 60 * 60 * 1000);
  const next = new Date(job.nextRunAt);
  assert.equal(next.getDay(), 0, "fires on a Sunday");
  assert.equal(next.getHours(), 5);
  assert.equal(next.getMinutes(), 15);
  assert.ok(runtime.backlogTriage instanceof BacklogTriage);
});

test("the cron handler runs the pass and returns the small summary", async () => {
  const { createDurableRuntime } = await import("../src/abi-runtime.js");
  const dir = tempDataDir();
  writeSuggestion(dir, observer("prop_dead", { category: "automation" }));
  const runtime = createDurableRuntime({ dataDir: dir, autoConnectMcp: false });
  // Only the job under test may fire — everything else in the default schedule
  // would spend real time (and, with a provider configured, real money).
  for (const job of runtime.cron.listJobs()) {
    runtime.cron.updateJob(job.id, job.id === "backlog-triage"
      ? { enabled: true, nextRunAt: new Date(Date.now() - 1000).toISOString() }
      : { enabled: false });
  }

  const fires = await runtime._tickOnce(new Date());
  assert.deepEqual(fires.map((f) => f.job.id), ["backlog-triage"]);
  const result = fires[0].result;
  assert.ok(result.passId, "summary carries the pass id");
  assert.equal(result.samples, undefined, "the full report stays on disk, not in the fire record");
  assert.equal(result.retired, 1);
  // And the pass really wrote through: the dead-end row is out of the queue.
  assert.equal(listAllSuggestions(runtime, { status: "pending" }).length, 0);
  assert.equal(listAllSuggestions(runtime, { status: AUTO_DISMISSED }).length, 1);
});
