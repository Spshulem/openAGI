import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OutcomeStore } from "../src/outcome-store.js";
import { JUDGE_CONFIGS } from "../src/scrutiny-panel.js";
import { ScrutinyFitter } from "../src/scrutiny-fitter.js";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-fit-grounded-"));
  const judges = Object.fromEntries(Object.entries(JUDGE_CONFIGS).map(([n, c]) => [n, { weights: { ...c.weights } }]));
  return { root, runtime: { outcomes: new OutcomeStore({ dir: path.join(root, "outcomes") }), scrutiny: { judges } } };
}

function dims(i) {
  const v = (k) => 0.2 + ((i * k) % 10) * 0.06;
  return { environment: v(3), company: v(7), evidence: v(1), memory: v(9), uncertainty: v(11) };
}

test("self-assigned scores alone are not enough to fit", () => {
  const { root, runtime } = setup();
  for (let i = 0; i < 60; i += 1) {
    const o = runtime.outcomes.record({ kind: "agent-reply", scrutinyDimensions: dims(i) });
    runtime.outcomes.resolve(o.id, 0.9, "system-inferred");
  }
  const result = new ScrutinyFitter({ runtime, dir: path.join(root, "scrutiny") }).fit();
  assert.equal(result.skipped, true);
  assert.match(result.reason, /0 grounded outcomes/);
});

test("grounded grades that track evidence push the evidence weight up, capped", () => {
  const { root, runtime } = setup();
  for (let i = 0; i < 60; i += 1) {
    const d = dims(i);
    const o = runtime.outcomes.record({ kind: "agent-reply", scrutinyDimensions: d });
    runtime.outcomes.ground(o.id, { score: d.evidence, fate: "test" });
  }
  const result = new ScrutinyFitter({ runtime, dir: path.join(root, "scrutiny") }).fit();
  const delta = result.proposals.pragmatic.deltas.evidence;
  assert.ok(delta > 0 && delta <= 0.05, `delta ${delta}`);
  assert.equal(result.sampleCount, 60);
});

test("weak grounded grades are not counted", () => {
  const { root, runtime } = setup();
  for (let i = 0; i < 60; i += 1) {
    const o = runtime.outcomes.record({ kind: "agent-reply", scrutinyDimensions: dims(i) });
    runtime.outcomes.ground(o.id, { score: 0.2, fate: "silence-delivered", weak: true });
  }
  assert.equal(new ScrutinyFitter({ runtime, dir: path.join(root, "scrutiny") }).fit().skipped, true);
});

test("opt-in reset restores defaults once and keeps the old weights", () => {
  const { root, runtime } = setup();
  const dir = path.join(root, "scrutiny");
  fs.mkdirSync(dir, { recursive: true });
  const fitted = { ...JUDGE_CONFIGS.pragmatic.weights, evidence: 0.6, environment: 0.1 };
  fs.writeFileSync(path.join(dir, "weights.json"), JSON.stringify({ version: 1, appliedAt: "2026-09-16T00:00:00.000Z", source: "auto-fit", cycle: 9, judges: { pragmatic: fitted } }));
  const previous = process.env.OPENAGI_SCRUTINY_RESET_PRE_GROUNDED;
  process.env.OPENAGI_SCRUTINY_RESET_PRE_GROUNDED = "1";
  try {
    new ScrutinyFitter({ runtime, dir });
    assert.deepEqual(runtime.scrutiny.judges.pragmatic.weights, JUDGE_CONFIGS.pragmatic.weights);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "weights.pre-grounded.json"), "utf8")).judges.pragmatic, fitted);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "weights.json"), "utf8")).source, "reset-pre-grounded");
    runtime.scrutiny.judges.pragmatic.weights = { ...fitted };
    new ScrutinyFitter({ runtime, dir });            // second boot: restores the reset file, no second reset
    assert.deepEqual(runtime.scrutiny.judges.pragmatic.weights, JUDGE_CONFIGS.pragmatic.weights);
  } finally {
    if (previous === undefined) delete process.env.OPENAGI_SCRUTINY_RESET_PRE_GROUNDED;
    else process.env.OPENAGI_SCRUTINY_RESET_PRE_GROUNDED = previous;
  }
});

test("without the flag, fitted weights are left alone", () => {
  const { root, runtime } = setup();
  const dir = path.join(root, "scrutiny");
  fs.mkdirSync(dir, { recursive: true });
  const fitted = { ...JUDGE_CONFIGS.pragmatic.weights, evidence: 0.6 };
  fs.writeFileSync(path.join(dir, "weights.json"), JSON.stringify({ version: 1, appliedAt: "x", source: "auto-fit", judges: { pragmatic: fitted } }));
  delete process.env.OPENAGI_SCRUTINY_RESET_PRE_GROUNDED;
  new ScrutinyFitter({ runtime, dir });
  assert.deepEqual(runtime.scrutiny.judges.pragmatic.weights, fitted);
  assert.equal(fs.existsSync(path.join(dir, "weights.pre-grounded.json")), false);
});
