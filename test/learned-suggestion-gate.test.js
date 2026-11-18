// Optional learned gate for proactive suggestions (OPENAGI_LEARNED_SUGGESTIONS).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProactiveObserver } from "../src/proactive-observer.js";
import { LEARNED_ENV_UNSET, fakeScoringService, withEnv } from "./support/fake-scoring-service.js";

const PROPOSAL = { category: "knowledge", title: "Save the vendor checklist", rationale: "It came up twice today." };

function tempDir(t, prefix = "openagi-learned-gate-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeObserver(t, { modelClient, random } = {}) {
  const dataDir = tempDir(t);
  const runtime = {
    modelClient,
    observations: {
      getRecentContext: async () => ({
        apps: [{ app: "Browser", n: 3 }],
        snippets: [
          { app: "Browser", text: "Vendor checklist: insurance and payment terms." },
          { app: "Mail", text: "Can you send the latest vendor checklist?" }
        ]
      })
    },
    agentHost: { modelProvider: { isConfigured: () => true, generate: async () => ({ text: JSON.stringify(PROPOSAL) }) } },
    tasks: { list: () => [] }
  };
  const observer = new ProactiveObserver({ runtime, dataDir, ...(random ? { random } : {}) });
  return { observer, dataDir };
}

function heldLog(dataDir) {
  const file = path.join(dataDir, "learning", "held-suggestions.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function suggestionScoreCalls(service) {
  return service.calls.filter((call) => call.key === "POST /score/suggestion");
}

test("off: the service is never asked and the suggestion is persisted as before", async (t) => {
  const service = fakeScoringService(tempDir(t));
  const { observer } = makeObserver(t, { modelClient: service.client });
  const result = await withEnv({ ...LEARNED_ENV_UNSET, OPENAGI_LEARNED_SUGGESTIONS: "off" }, () => observer.observe({ force: true }));
  assert.equal(result.suggested, 1);
  assert.equal(Object.hasOwn(result.candidate, "learned"), false);
  assert.equal(service.calls.length, 0);
});

test("shadow (the default): the score is recorded on the suggestion and nothing is held", async (t) => {
  const service = fakeScoringService(tempDir(t), { "POST /score/suggestion": { p_accept: 0.05, version: "v7" } });
  const { observer, dataDir } = makeObserver(t, { modelClient: service.client });
  const result = await withEnv(LEARNED_ENV_UNSET, () => observer.observe({ force: true }));
  assert.equal(result.suggested, 1, "a low score in shadow holds nothing back");
  assert.deepEqual(result.candidate.learned, { pAccept: 0.05, version: "v7", mode: "shadow" });
  const onDisk = JSON.parse(fs.readFileSync(path.join(observer.suggestDir, `${result.candidate.id}.json`), "utf8"));
  assert.deepEqual(onDisk.learned, { pAccept: 0.05, version: "v7", mode: "shadow" });
  assert.deepEqual(suggestionScoreCalls(service)[0].body, { title: PROPOSAL.title, rationale: PROPOSAL.rationale, category: PROPOSAL.category });
  assert.deepEqual(heldLog(dataDir), []);
});

test("live with a usable head: a proposal below the threshold is held and logged without its text", async (t) => {
  const service = fakeScoringService(tempDir(t), { "POST /score/suggestion": { p_accept: 0.1, version: "v7" } });
  const { observer, dataDir } = makeObserver(t, { modelClient: service.client, random: () => 0.5 });
  const now = new Date("2026-03-01T10:00:00Z");
  const result = await withEnv({ ...LEARNED_ENV_UNSET, OPENAGI_LEARNED_SUGGESTIONS: "live" }, () => observer.observe({ force: true, now }));
  assert.deepEqual(result, { skipped: true, reason: "learned gate", pAccept: 0.1 });
  assert.deepEqual(fs.readdirSync(observer.suggestDir), [], "nothing was persisted");
  assert.deepEqual(heldLog(dataDir), [{ at: now.toISOString(), category: "knowledge", pAccept: 0.1, version: "v7" }]);
  const raw = fs.readFileSync(path.join(dataDir, "learning", "held-suggestions.jsonl"), "utf8");
  assert.equal(raw.includes("vendor"), false, "no proposal text in the log");
});

test("live with a usable head: a proposal at or above the threshold goes through with its score", async (t) => {
  const service = fakeScoringService(tempDir(t), { "POST /score/suggestion": { p_accept: 0.3, version: "v7" } });
  const { observer, dataDir } = makeObserver(t, { modelClient: service.client, random: () => 0.99 });
  const result = await withEnv({ ...LEARNED_ENV_UNSET, OPENAGI_LEARNED_SUGGESTIONS: "live" }, () => observer.observe({ force: true }));
  assert.equal(result.suggested, 1);
  assert.deepEqual(result.candidate.learned, { pAccept: 0.3, version: "v7", mode: "live" });
  assert.deepEqual(heldLog(dataDir), []);
});

test("live with an unusable head: nothing is held", async (t) => {
  const health = {
    ok: true, version: "v7", heads: { t2: { labels: 40, auroc: 0.55, usable: false } }, thresholds: { suggestion: 0.3 }
  };
  const service = fakeScoringService(tempDir(t), { "GET /health": health, "POST /score/suggestion": { p_accept: 0.01, version: "v7" } });
  const { observer, dataDir } = makeObserver(t, { modelClient: service.client, random: () => 0.99 });
  const result = await withEnv({ ...LEARNED_ENV_UNSET, OPENAGI_LEARNED_SUGGESTIONS: "live" }, () => observer.observe({ force: true }));
  assert.equal(result.suggested, 1);
  assert.equal(result.candidate.learned.mode, "live");
  assert.equal(result.candidate.learned.explore, undefined);
  assert.deepEqual(heldLog(dataDir), []);
});

test("live: exploration lets one in ten low-scored proposals through, marked explore", async (t) => {
  const service = fakeScoringService(tempDir(t), { "POST /score/suggestion": { p_accept: 0.1, version: "v7" } });
  const { observer, dataDir } = makeObserver(t, { modelClient: service.client, random: () => 0.05 });
  const result = await withEnv({ ...LEARNED_ENV_UNSET, OPENAGI_LEARNED_SUGGESTIONS: "live" }, () => observer.observe({ force: true }));
  assert.equal(result.suggested, 1);
  assert.deepEqual(result.candidate.learned, { pAccept: 0.1, version: "v7", mode: "live", explore: true });
  assert.deepEqual(heldLog(dataDir), []);

  // The exploration share is 0.1: a draw of exactly 0.1 is held.
  const second = makeObserver(t, { modelClient: service.client, random: () => 0.1 });
  const held = await withEnv({ ...LEARNED_ENV_UNSET, OPENAGI_LEARNED_SUGGESTIONS: "live" }, () => second.observer.observe({ force: true }));
  assert.equal(held.reason, "learned gate");
});

test("a missing score (service error) changes nothing, in shadow or live", async (t) => {
  for (const flag of [undefined, "live"]) {
    const service = fakeScoringService(tempDir(t), { "POST /score/suggestion": null });
    const { observer, dataDir } = makeObserver(t, { modelClient: service.client, random: () => 0.5 });
    const result = await withEnv({ ...LEARNED_ENV_UNSET, OPENAGI_LEARNED_SUGGESTIONS: flag }, () => observer.observe({ force: true }));
    assert.equal(result.suggested, 1, `flag ${flag}`);
    assert.equal(Object.hasOwn(result.candidate, "learned"), false);
    assert.equal(suggestionScoreCalls(service).length, 1);
    assert.deepEqual(heldLog(dataDir), []);
  }
});

test("a runtime without a client: nothing is asked and nothing changes", async (t) => {
  const { observer } = makeObserver(t, {});
  const result = await withEnv({ ...LEARNED_ENV_UNSET, OPENAGI_LEARNED_SUGGESTIONS: "live" }, () => observer.observe({ force: true }));
  assert.equal(result.suggested, 1);
  assert.equal(Object.hasOwn(result.candidate, "learned"), false);
});
