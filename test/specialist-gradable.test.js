import assert from "node:assert/strict";
import test from "node:test";
import { PropagationController } from "../src/propagation-controller.js";
import { SpecialistRouter } from "../src/specialist-router.js";

function makeSpecialist(controller, signalExtra = {}) {
  const signal = {
    domain: "sales", taskType: "follow-up", tags: ["message", "sms", "acme"],
    summary: "weekly acme pipeline follow-up email", specialistScope: "weekly acme pipeline follow-up email", ...signalExtra
  };
  return controller.propagate({ signal, workflow: null, scrutiny: { reasons: ["r1", "r2"] }, tools: [] }).specialist;
}

test("specialists carry match metadata and generic tags never count", async () => {
  const sp = makeSpecialist(new PropagationController());
  assert.deepEqual(sp.metadata, { domain: "sales", taskType: "follow-up", tags: ["message", "sms", "acme"] });
  const router = new SpecialistRouter({ mode: "live" });
  const [informativeHit] = await router.search("unrelated words entirely", ["acme"], [sp]);
  assert.ok(informativeHit.breakdown.tagScore > 0, "an informative tag matches");
  const [genericOnly] = await router.search("unrelated words entirely", ["message", "sms"], [sp]);
  assert.equal(genericOnly.breakdown.tagScore, 0, "message/channel tags say nothing");
});

test("a message close to the scope can now be routed", async () => {
  const sp = makeSpecialist(new PropagationController());
  const router = new SpecialistRouter({ mode: "live" });
  const decision = await router.decide("weekly acme pipeline follow-up", ["message", "sms"], [sp]);
  assert.ok(decision.candidate, "candidate found");
  assert.ok(decision.candidate.score >= 0.55, `score ${decision.candidate.score}`);
  assert.equal(decision.route, true);
});

test("the default mode is shadow: matches are reported, turns are not handed over", async () => {
  const sp = makeSpecialist(new PropagationController());
  const previous = process.env.OPENAGI_ROUTING_MODE;
  delete process.env.OPENAGI_ROUTING_MODE;
  try {
    const decision = await new SpecialistRouter().decide("weekly acme pipeline follow-up", ["message"], [sp]);
    assert.equal(decision.mode, "shadow");
    assert.equal(decision.route, false);
    assert.ok(decision.candidate);
  } finally {
    if (previous !== undefined) process.env.OPENAGI_ROUTING_MODE = previous;
  }
});

test("reasons are capped at 20", () => {
  const controller = new PropagationController();
  makeSpecialist(controller);
  for (let i = 0; i < 60; i += 1) makeSpecialist(controller);
  assert.equal(controller.list()[0].reasons.length, 20);
});

test("grounded quality: running mean, and a regrade replaces without double counting", () => {
  const controller = new PropagationController();
  const sp = makeSpecialist(controller);
  controller.recordGroundedQuality(sp.id, 0.2);
  controller.recordGroundedQuality(sp.id, 0.6);
  assert.equal(sp.groundedSamples, 2);
  assert.ok(Math.abs(sp.groundedMean - 0.4) < 1e-9);
  controller.recordGroundedQuality(sp.id, 1.0, 0.2);
  assert.equal(sp.groundedSamples, 2);
  assert.ok(Math.abs(sp.groundedMean - 0.8) < 1e-9);
});

test("retirement uses grounded quality, not the self-assigned score", () => {
  const controller = new PropagationController();
  const bad = makeSpecialist(controller, { domain: "a" });
  const selfScoredOnly = makeSpecialist(controller, { domain: "b" });
  for (let i = 0; i < 10; i += 1) controller.recordGroundedQuality(bad.id, 0.2);
  selfScoredOnly.outcomeSamples = 50;
  selfScoredOnly.meanOutcomeQuality = 0.1;
  const retired = controller.retirementSweep({ now: new Date() });
  assert.deepEqual(retired.map((s) => s.id), [bad.id]);
  assert.match(bad.retirementReason, /grounded mean 0\.20/);
});
