// With no local scoring service configured the runtime must behave exactly
// as it did before learned scores existed. test/fixtures/learned-scores-inert.json
// is the normalized output of test/support/learned-scores-scenario.js recorded
// on the runtime before this feature; every run without a service must
// reproduce it byte for byte, and must never call the client.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ModelClient } from "../src/learning/model-client.js";
import { runLearnedScoresScenario } from "./support/learned-scores-scenario.js";
import { LEARNED_ENV_UNSET, fakeScoringService, withEnv } from "./support/fake-scoring-service.js";

const GOLDEN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "learned-scores-inert.json");
const GOLDEN_TEXT = fs.readFileSync(GOLDEN_PATH, "utf8");
const CLIENT_METHODS = ["health", "usable", "scoreSuggestion", "scoreTurn", "scoreSignal", "keepScores", "clusterOf", "clusters"];

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A client with no url (the default), whose fetch and scoring methods count calls.
function spiedDisabledClient() {
  const counts = { fetch: 0 };
  const client = new ModelClient({ fetchImpl: async () => { counts.fetch += 1; throw new Error("no service"); } });
  for (const name of CLIENT_METHODS) {
    const original = client[name].bind(client);
    counts[name] = 0;
    client[name] = (...args) => { counts[name] += 1; return original(...args); };
  }
  return { client, counts };
}

// Fields a learned score adds in shadow. Everything else must match the golden.
const LEARNED_KEYS = new Set([
  "learned", "shadowLearnedValue", "learnedMode", "learnedValue", "learnedVersion", "ruleScore",
  "learnedTurn", "learnedPropagation", "keepScore", "keepScoreVersion", "keepScoredAt", "clusterId"
]);
function withoutLearned(value) {
  if (Array.isArray(value)) return value.map(withoutLearned);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !LEARNED_KEYS.has(key)).map(([key, entry]) => [key, withoutLearned(entry)]));
  }
  return value;
}

test("no scoring service: no client calls, and the runtime's output is byte for byte what it was before", async (t) => {
  const dataDir = tempDir(t, "openagi-learned-inert-");
  const { client, counts } = spiedDisabledClient();
  const result = await withEnv(LEARNED_ENV_UNSET, () => runLearnedScoresScenario({ dataDir, runtimeOptions: { modelClient: client } }));
  assert.equal(client.enabled(), false);
  assert.deepEqual(counts, Object.fromEntries([["fetch", 0], ...CLIENT_METHODS.map((name) => [name, 0])]));
  assert.deepEqual(result, JSON.parse(GOLDEN_TEXT));
  assert.equal(`${JSON.stringify(result, null, 2)}\n`, GOLDEN_TEXT);
  assert.equal(fs.existsSync(path.join(dataDir, "learning")), false, "no learning/ files");
});

test("no scoring service: learned flags set to live still change nothing", async (t) => {
  const dataDir = tempDir(t, "openagi-learned-inert-flags-");
  const { client, counts } = spiedDisabledClient();
  const result = await withEnv({
    ...LEARNED_ENV_UNSET,
    OPENAGI_LEARNED_SUGGESTIONS: "live",
    OPENAGI_LEARNED_SCRUTINY: "live",
    OPENAGI_LEARNED_MEMORY: "live",
    OPENAGI_LEARNED_PROPAGATION: "live"
  }, () => runLearnedScoresScenario({ dataDir, runtimeOptions: { modelClient: client } }));
  assert.equal(counts.fetch, 0);
  assert.equal(`${JSON.stringify(result, null, 2)}\n`, GOLDEN_TEXT);
});

test("the runtime's own client is inert when the service variables are unset", async (t) => {
  const dataDir = tempDir(t, "openagi-learned-inert-default-");
  const result = await withEnv(LEARNED_ENV_UNSET, () => runLearnedScoresScenario({ dataDir }));
  assert.equal(`${JSON.stringify(result, null, 2)}\n`, GOLDEN_TEXT);
});

test("shadow: the service is asked and its answers recorded, but every decision matches the run without it", async (t) => {
  const dataDir = tempDir(t, "openagi-learned-shadow-");
  const service = fakeScoringService(tempDir(t, "openagi-learned-token-"));
  const result = await withEnv(LEARNED_ENV_UNSET, () => runLearnedScoresScenario({ dataDir, runtimeOptions: { modelClient: service.client } }));

  const asked = new Set(service.calls.map((call) => call.key));
  for (const key of ["POST /score/suggestion", "POST /score/signal", "POST /score/turn", "POST /memory/keep", "POST /cluster-of"]) {
    assert.ok(asked.has(key), `${key} was requested`);
  }

  const golden = JSON.parse(GOLDEN_TEXT);
  const stripped = withoutLearned(result);
  stripped.files = stripped.files.filter((file) => !file.startsWith("learning/"));
  stripped.memoryEventOps = stripped.memoryEventOps.filter((op) => op !== "keep-score");
  assert.deepEqual(stripped, golden);

  // And the shadow records are really there.
  const turn = result.outcomes.find((o) => o.kind === "agent-reply");
  assert.equal(turn.metadata.learnedMode, "shadow");
  assert.equal(turn.metadata.learnedValue, 0.9);
  assert.equal(turn.metadata.ruleScore, turn.metadata.scrutinyScore);
  assert.deepEqual(turn.metadata.learnedTurn, { pStop: 0.2, pNudge: 0.1, version: "v1" });
  assert.equal(turn.metadata.learnedPropagation.mode, "shadow");
  assert.equal(result.suggestion.learned.mode, "shadow");
  assert.ok(result.memory.some((item) => item.metadata.keepScore === 0.8));
});
