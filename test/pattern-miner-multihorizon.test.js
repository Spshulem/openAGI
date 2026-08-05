import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PatternMiner } from "../src/pattern-miner.js";
import { SkillRegistry } from "../src/skills.js";

test("PatternMiner proposes an event-triggered sales-call to contract workflow and dedupes hourly rescans", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-multihorizon-mine-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const rows = [];
  for (const [day, account] of [
    ["2026-02-23", "Acme"],
    ["2026-03-02", "Globex"],
    ["2026-03-09", "Initech"]
  ]) {
    rows.push(
      { kind: "activity", event: "focus", at: `${day}T17:00:00.000Z`, app: "Google Chrome", window: `Google Meet — ${account} discovery call` },
      { kind: "activity", event: "focus", at: `${day}T18:45:00.000Z`, app: "Google Chrome", window: `PandaDoc — ${account} contract` }
    );
  }
  let requestedLimit = null;
  const events = [];
  const runtime = {
    observations: {
      search: async ({ limit }) => {
        requestedLimit = limit;
        return rows;
      }
    },
    events: { emit: (name, payload) => events.push({ name, payload }) }
  };
  const miner = new PatternMiner({ runtime, dataDir, timeZone: "America/Los_Angeles" });

  const first = await miner.mine({ now: new Date("2026-03-10T12:00:00.000Z"), mode: "continuous", maxCandidates: 2 });
  assert.ok(first.candidates >= 1);
  assert.equal(requestedLimit, 50_000, "full multi-week lookback must not stop at the old 5,000-row cap");
  const candidate = miner.list().find((item) =>
    item.sequence?.actionKeys?.join("→") === "attend-call→prepare-contract"
  );
  assert.ok(candidate, "two-step semantic workflow should become a candidate");
  assert.deepEqual(candidate.sequence.horizons, ["action", "day", "week"]);
  assert.equal(candidate.sequence.cadence.type, "weekly");
  assert.equal(candidate.proposal.triggerHint.type, "after_action");
  assert.equal(candidate.proposal.triggerHint.action, "attend-call");
  assert.equal(candidate.proposal.scheduleHint, null, "post-call behavior must not become an arbitrary daily cron");
  assert.ok(events.some((event) => event.name === "skill-candidate" && event.payload.id === candidate.id));

  const second = await miner.mine({ now: new Date("2026-03-10T13:00:00.000Z"), mode: "continuous", maxCandidates: 2 });
  assert.equal(second.candidates, 0, "the next hourly scan must not duplicate the same workflow");
  assert.equal(miner.list().filter((item) => item.fingerprint === candidate.fingerprint).length, 1);

  // New evidence refreshes the deterministic trigger and clears any stale
  // clock hint left by an older proposal shape.
  const candidateFile = path.join(dataDir, "skills-suggested", `${candidate.id}.json`);
  const stale = JSON.parse(fs.readFileSync(candidateFile, "utf8"));
  stale.proposal.triggerHint = { type: "schedule", cadence: "daily", startHour: 9 };
  stale.proposal.scheduleHint = "daily at 09:00";
  fs.writeFileSync(candidateFile, JSON.stringify(stale, null, 2));
  rows.push(
    { kind: "activity", event: "focus", at: "2026-03-16T16:00:00.000Z", app: "Google Chrome", window: "Google Meet — Umbrella discovery call" },
    { kind: "activity", event: "focus", at: "2026-03-16T17:45:00.000Z", app: "Google Chrome", window: "PandaDoc — Umbrella contract" }
  );
  const third = await miner.mine({ now: new Date("2026-03-17T12:00:00.000Z"), mode: "continuous", maxCandidates: 2 });
  assert.equal(third.candidates, 0);
  assert.ok(third.updated >= 1);
  const refreshed = miner.list().find((item) => item.id === candidate.id);
  assert.equal(refreshed.sequence.count, 4);
  assert.ok(refreshed.sequence.examples.every((example) => example.startedAt >= "2026-03-02"), "OCR examples should favor recent retained frames");
  assert.equal(refreshed.proposal.triggerHint.type, "after_action");
  assert.equal(refreshed.proposal.scheduleHint, null);

  const accepted = miner.accept(candidate.id);
  const skill = fs.readFileSync(accepted.path, "utf8");
  assert.match(skill, /Workflow: Work in a call or meeting → Work on a contract or proposal/);
  assert.match(skill, /observedTrigger: \{"type":"after_action"/);
  const loaded = new SkillRegistry({ dirs: [path.join(dataDir, "skills")] }).list().find((item) => item.name === accepted.name);
  assert.equal(loaded.observedTrigger.type, "after_action");
  assert.ok(loaded.observedHorizons.includes("week"));
});

test("legacy Skills acceptance handles session-miner candidates that have no activity sequence", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-session-candidate-accept-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const suggestedDir = path.join(dataDir, "skills-suggested");
  fs.mkdirSync(suggestedDir, { recursive: true });
  const candidate = {
    id: "ses_repeat",
    source: "session-miner",
    proposedAt: new Date().toISOString(),
    fingerprint: "weekly report",
    cluster: { count: 3, keywords: ["weekly", "report"], samples: [] },
    proposal: {
      name: "weekly-report",
      description: "Prepare the recurring weekly report",
      body: "Prepare the weekly report from the latest project evidence.",
      scheduleHint: null
    },
    status: "pending"
  };
  fs.writeFileSync(path.join(suggestedDir, `${candidate.id}.json`), JSON.stringify(candidate));
  const miner = new PatternMiner({ runtime: {}, dataDir });

  const accepted = miner.accept(candidate.id);
  const skill = fs.readFileSync(accepted.path, "utf8");
  assert.match(skill, /recurring request in your chat history \(3 occurrences\)/);
  assert.match(skill, /Prepare the weekly report/);
});

test("proposal budget caps model calls even when the judge passes on every pattern", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-pattern-proposal-cap-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const rows = [];
  for (const day of ["2026-07-01", "2026-07-02", "2026-07-03"]) {
    rows.push(
      { kind: "activity", event: "focus", at: `${day}T16:00:00Z`, app: "Zoom", window: "Acme sales call", sourceMachineId: "sales" },
      { kind: "activity", event: "focus", at: `${day}T16:30:00Z`, app: "PandaDoc", window: "Acme contract", sourceMachineId: "sales" },
      { kind: "activity", event: "focus", at: `${day}T18:00:00Z`, app: "Calendar", window: "Product agenda", sourceMachineId: "product" },
      { kind: "activity", event: "focus", at: `${day}T18:10:00Z`, app: "Linear", window: "Product task", sourceMachineId: "product" }
    );
  }
  let calls = 0;
  const provider = {
    isConfigured: () => true,
    generate: async () => {
      calls += 1;
      return { text: JSON.stringify({ pass: true, reason: "skip" }) };
    }
  };
  const miner = new PatternMiner({
    dataDir,
    runtime: {
      observations: { search: async () => rows },
      agentHost: { modelProvider: provider }
    }
  });

  const result = await miner.mine({ now: new Date("2026-07-04T00:00:00Z"), maxCandidates: 1 });
  assert.equal(result.candidates, 0);
  assert.equal(result.proposalAttempts, 1);
  assert.equal(calls, 1);

  // The next pass may judge the next unseen workflow, but once both have
  // recently been dismissed, hourly scans make no repeat model calls.
  await miner.mine({ now: new Date("2026-07-04T01:00:00Z"), maxCandidates: 1 });
  assert.equal(calls, 2);
  const quiet = await miner.mine({ now: new Date("2026-07-04T02:00:00Z"), maxCandidates: 1 });
  assert.equal(quiet.proposalAttempts, 0);
  assert.equal(calls, 2);
});

test("semantic dedupe does not conflate distinct same-browser workflows", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-semantic-dedupe-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const miner = new PatternMiner({ runtime: {}, dataDir });
  const base = {
    apps: ["Google Chrome", "Google Chrome"],
    count: 3,
    confidence: 0.8,
    occurrences: [],
    horizons: ["action", "day"]
  };
  miner.persistCandidate(
    { ...base, fingerprint: "actions:attend-call→prepare-contract", actionKeys: ["attend-call", "prepare-contract"] },
    { name: "post-call-contract", body: "x", description: "x", scheduleHint: null }
  );

  assert.equal(miner.alreadyProposed({
    ...base,
    fingerprint: "actions:prepare-contract→send-follow-up",
    actionKeys: ["prepare-contract", "send-follow-up"]
  }), false);
});
