import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OutcomeStore, isQualityEligibleOutcome, scoreFromToolCalls } from "../src/outcome-store.js";
import { SkillRegistry } from "../src/skills.js";

test("scoreFromToolCalls grades runs by per-call ok flags", () => {
  const cases = [
    [[], 0.5],
    [null, 0.5],
    [undefined, 0.5],
    [[{ name: "remember", ok: true }], 0.7],
    [[{ name: "remember", ok: true }, { name: "recall", ok: true }], 0.7],
    [[{ name: "remember", ok: true }, { name: "recall", ok: false }], 0.45],
    [[{ name: "remember", ok: false }], 0.1],
    [[{ name: "remember", ok: false }, { name: "recall", ok: false }], 0.1]
  ];
  for (const [calls, expected] of cases) {
    assert.equal(scoreFromToolCalls(calls), expected, `toolCalls=${JSON.stringify(calls)}`);
  }
});

test("resolveSweep grades cron/autopilot fires by tool-call results", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-outcome-quality-"));
  const store = new OutcomeStore({ dir });
  const allFailed = store.record({
    kind: "cron-fire",
    sessionId: "s1",
    toolCalls: [{ name: "web_search", ok: false }, { name: "remember", ok: false }]
  });
  const mixed = store.record({
    kind: "autopilot-fire",
    sessionId: "s2",
    toolCalls: [{ name: "web_search", ok: true }, { name: "remember", ok: false }]
  });
  const allOk = store.record({
    kind: "cron-fire",
    sessionId: "s3",
    toolCalls: [{ name: "remember", ok: true }]
  });

  const sweep = store.resolveSweep({ now: new Date(Date.now() + 31 * 60 * 1000) });
  assert.equal(sweep.length, 3);

  const byId = new Map(sweep.map((r) => [r.id, r]));
  assert.equal(byId.get(allFailed.id).score, 0.1, "all-failed fire scores 0.1");
  assert.equal(byId.get(mixed.id).score, 0.45, "mixed fire scores 0.45");
  assert.equal(byId.get(allOk.id).score, 0.7, "all-ok fire scores 0.7");

  for (const o of [allFailed, mixed, allOk]) {
    const resolved = store.recent(10).find((r) => r.id === o.id);
    assert.equal(resolved.resolved, true);
    assert.equal(resolved.source, "system-inferred", "resolution source string is unchanged");
  }
});

test("resolveSweep still scores a quiet old cron fire 0.5", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-outcome-quiet-"));
  const store = new OutcomeStore({ dir });
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const quiet = store.record({ kind: "cron-fire", sessionId: "s1", toolCalls: [], at: twoHoursAgo });

  const sweep = store.resolveSweep();
  assert.equal(sweep.length, 1);
  assert.equal(sweep[0].id, quiet.id);
  assert.equal(sweep[0].score, 0.5);
  assert.equal(sweep[0].source, "system-inferred");
});

test("quality aggregates exclude legacy no-op autopilot pulses without deleting audit history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-outcome-housekeeping-"));
  const store = new OutcomeStore({ dir });
  store.record({ kind: "autopilot-fire", toolCalls: [] });
  store.record({ kind: "autopilot-fire", toolCalls: [{ name: "agent_pick_next", ok: true }] });
  store.record({ kind: "autopilot-fire", toolCalls: [{ name: "add_task", ok: true }] });
  store.record({ kind: "agent-reply", toolCalls: [] });

  const aggregate = store.aggregate(30);
  assert.equal(store.recent(10).length, 4, "audit history stays intact");
  assert.equal(aggregate.total, 2);
  assert.equal(aggregate.excludedHousekeeping, 2);
  assert.equal(isQualityEligibleOutcome({ kind: "autopilot-fire", metadata: { qualityEligible: false }, toolCalls: [{ name: "add_task" }] }), false);
});

test("explicit feedback replaces inferred scores and makes aggregate confidence measurable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-outcome-rating-"));
  const store = new OutcomeStore({ dir });
  const inferred = store.record({ kind: "agent-reply", refId: "reply-1" });
  const followedUp = store.record({ kind: "agent-reply", refId: "reply-2" });
  store.resolve(inferred.id, 0.7, "system-inferred", "heuristic");
  store.resolve(followedUp.id, 0.85, "user-followup", "positive follow-up");

  const rated = store.rate(inferred.id, 0.1, "not useful");
  assert.equal(rated.qualityScore, 0.1);
  assert.equal(rated.source, "explicit-rating");
  assert.equal(rated.metadata.resolutionNote, "not useful");

  const aggregate = store.aggregate(30);
  assert.equal(aggregate.explicitRatings, 1);
  assert.equal(aggregate.userFollowups, 1);
  assert.equal(aggregate.inferredScores, 0);
  assert.equal(aggregate.userSignalCoverage, 1);
  assert.equal(aggregate.avgExplicitQuality, 0.1);
  assert.deepEqual(aggregate.bySource, { "explicit-rating": 1, "user-followup": 1 });

  const events = fs.readFileSync(store.eventsPath, "utf8").trim().split("\n").map(JSON.parse);
  const feedback = events.at(-1);
  assert.equal(feedback.op, "feedback");
  assert.equal(feedback.previousSource, "system-inferred");
  assert.doesNotMatch(JSON.stringify(feedback), /not useful/, "feedback receipt excludes note text");

  const restored = new OutcomeStore({ dir });
  assert.equal(restored.outcomes.get(inferred.id).source, "explicit-rating");
  assert.equal(restored.outcomes.get(inferred.id).qualityScore, 0.1);
  fs.rmSync(dir, { recursive: true });
});

test("quality aggregates distinguish terminal timeouts from genuinely pending work", () => {
  const store = new OutcomeStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "openagi-outcome-terminal-")) });
  const now = new Date();
  const timedOut = store.record({ kind: "agent-reply", at: new Date(now.getTime() - 48 * 3600 * 1000).toISOString() });
  store.record({ kind: "agent-reply" });
  store.resolveSweep({ now, timeoutHours: 24 });
  const aggregate = store.aggregate(30);
  assert.equal(store.outcomes.get(timedOut.id).source, "timeout");
  assert.equal(aggregate.total, 2);
  assert.equal(aggregate.resolved, 1);
  assert.equal(aggregate.scored, 0);
  assert.equal(aggregate.timedOut, 1);
  assert.equal(aggregate.pending, 1);
});

test("skill run grades completion by tool-call results; tool-free run keeps 0.7", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-skill-quality-"));
  const skillsRoot = path.join(root, "skills");
  const skillDir = path.join(skillsRoot, "demo");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: demo\ndescription: test skill\n---\nDo the thing: {{input}}\n"
  );

  const outcomes = new OutcomeStore({ dir: path.join(root, "outcomes") });
  let nextToolCalls = [
    { name: "web_search", arguments: {}, result: { ok: false } },
    { name: "remember", arguments: {}, result: { ok: false } }
  ];
  const runtime = {
    outcomes,
    agentHost: {
      modelProvider: {
        generate: async () => ({ text: "done", toolCalls: nextToolCalls })
      }
    }
  };
  const registry = new SkillRegistry({ runtime, dirs: [skillsRoot] });

  const failedRun = await registry.run("demo", { input: "attempt one" });
  assert.equal(failedRun.output, "done");
  const failedOutcome = outcomes.recent(1)[0];
  assert.equal(failedOutcome.kind, "skill-run");
  assert.equal(failedOutcome.resolved, true);
  assert.equal(failedOutcome.qualityScore, 0.1);
  assert.equal(failedOutcome.source, "skill-completed", "source string is unchanged");

  nextToolCalls = [];
  await registry.run("demo", { input: "attempt two" });
  const quietOutcome = outcomes.recent(10).find((o) => o.metadata.input === "attempt two");
  assert.equal(quietOutcome.qualityScore, 0.7);
  assert.equal(quietOutcome.source, "skill-completed");
});
