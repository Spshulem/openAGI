// B3: variance guard. The fitter must not auto-apply weight changes fitted
// against near-constant training dimensions.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OutcomeStore } from "../src/outcome-store.js";
import { ScrutinyFitter } from "../src/scrutiny-fitter.js";

const DEFAULT_WEIGHTS = { environment: 0.28, company: 0.26, evidence: 0.24, memory: 0.12, uncertainty: 0.1 };

function makeRuntime(root) {
  return {
    outcomes: new OutcomeStore({ dir: path.join(root, "outcomes") }),
    scrutiny: { judges: { pragmatic: { weights: { ...DEFAULT_WEIGHTS } } } }
  };
}

function seed(runtime, makeDims, count = 50) {
  for (let i = 0; i < count; i += 1) {
    const dims = makeDims(i);
    const o = runtime.outcomes.record({ kind: "agent-reply", scrutinyAction: "act", scrutinyDimensions: dims });
    runtime.outcomes.ground(o.id, { score: dims.evidence, source: "test", fate: "test" });
  }
}

test("variance guard skips auto-apply when 2+ dimensions are near-constant", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-varguard-"));
  const runtime = makeRuntime(root);
  seed(runtime, (i) => ({ environment: 0.5, company: 0.5, evidence: 0.3 + (i % 10) * 0.05, memory: 0.5, uncertainty: 0.5 }));

  const fitter = new ScrutinyFitter({ runtime, dir: path.join(root, "scrutiny"), warmupCycles: 0 });
  const before = { ...runtime.scrutiny.judges.pragmatic.weights };

  const warns = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warns.push(String(msg));
  let result;
  try {
    result = fitter.fit();
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(result.autoApplied, false, "guard must veto auto-apply");
  assert.deepEqual(result.varianceGuard.flatDimensions, ["environment", "company", "memory", "uncertainty"]);
  assert.deepEqual(runtime.scrutiny.judges.pragmatic.weights, before, "live weights untouched");
  assert.equal(fitter.pending.proposals.length, 1, "proposal stays recorded for manual review");
  assert.deepEqual(fitter.pending.proposals[0].varianceGuard.flatDimensions, ["environment", "company", "memory", "uncertainty"]);
  assert.equal(warns.length, 1, "exactly one guard log line");
  assert.ok(warns[0].includes("variance guard"), warns[0]);
  assert.ok(warns[0].includes("environment") && warns[0].includes("uncertainty"), warns[0]);
  fs.rmSync(root, { recursive: true });
});

test("variance guard lets varied dims auto-apply, including with one flat dim", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-varguard2-"));
  const runtime = makeRuntime(root);
  seed(runtime, (i) => ({
    environment: 0.3 + (i % 10) * 0.05,
    company: 0.3 + ((i + 2) % 10) * 0.05,
    evidence: 0.3 + ((i + 4) % 10) * 0.05,
    memory: 0.5,
    uncertainty: 0.3 + ((i + 6) % 10) * 0.05
  }));

  const fitter = new ScrutinyFitter({ runtime, dir: path.join(root, "scrutiny"), warmupCycles: 0 });
  const result = fitter.fit();
  assert.equal(result.autoApplied, true, "one flat dimension must not trip the guard");
  assert.equal(result.varianceGuard, null);
  assert.equal(fitter.pending.proposals.length, 0);
  fs.rmSync(root, { recursive: true });
});
