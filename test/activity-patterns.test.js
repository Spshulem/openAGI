import assert from "node:assert/strict";
import test from "node:test";
import { analyzeActivityPatterns, classifyActivityAction } from "../src/activity-patterns.js";

function activity(at, app, window, sourceMachineId = "work-mac") {
  return { kind: "activity", event: "focus", at, app, window, sourceMachineId };
}

function findPattern(patterns, actionKeys) {
  return patterns.find((pattern) =>
    pattern.actionKeys.length === actionKeys.length &&
    pattern.actionKeys.every((key, index) => key === actionKeys[index])
  );
}

test("repeated two-step sales-call to contract workflow survives a long call", () => {
  const rows = [];
  for (const day of ["2026-07-01", "2026-07-02", "2026-07-03"]) {
    rows.push(
      activity(`${day}T16:00:00Z`, "Zoom", "Acme discovery sales call"),
      // The focus event marks the beginning of the call, so the next direct
      // action can legitimately be well over the old 60-minute cutoff.
      activity(`${day}T17:45:00Z`, "PandaDoc", "Acme MSA contract")
    );
  }

  const patterns = analyzeActivityPatterns(rows, { timeZone: "America/Los_Angeles" });
  const pattern = findPattern(patterns, ["attend-call", "prepare-contract"]);

  assert.ok(pattern, "expected the repeated post-call contract workflow");
  assert.equal(pattern.count, 3);
  assert.equal(pattern.distinctDays, 3);
  assert.equal(pattern.lagStats.transitions[0].medianMinutes, 105);
  assert.equal(pattern.trigger.type, "after_action");
  assert.equal(pattern.trigger.action, "attend-call");
  assert.equal(pattern.actions[0].apps[0], "Zoom");
  assert.equal(pattern.actions[1].apps[0], "PandaDoc");
  assert.ok(pattern.actions[1].windows.includes("Acme MSA contract"));
  assert.ok(pattern.horizons.includes("action"));
  assert.ok(pattern.horizons.includes("day"));
  assert.equal(pattern.confidenceComponents.contextConsistency, 1);
  assert.ok(pattern.confidence > 0.7);
});

test("same-browser Meet to contract to follow-up remains three semantic actions", () => {
  assert.equal(classifyActivityAction({ app: "Google Chrome", window: "Google Meet — Acme discovery call", at: "2026-07-01T16:00:00Z" }).key, "attend-call");
  assert.equal(classifyActivityAction({ app: "Google Chrome", window: "Google Docs — Acme MSA contract", at: "2026-07-01T17:00:00Z" }).key, "prepare-contract");
  assert.equal(classifyActivityAction({ app: "Google Chrome", window: "Gmail — Follow up Acme", at: "2026-07-01T17:10:00Z" }).key, "send-follow-up");

  const rows = [];
  for (const day of ["2026-07-01", "2026-07-02", "2026-07-03"]) {
    rows.push(
      activity(`${day}T16:00:00Z`, "Google Chrome", "Google Meet — Acme discovery call"),
      activity(`${day}T17:00:00Z`, "Google Chrome", "Google Docs — Acme MSA contract"),
      activity(`${day}T17:10:00Z`, "Google Chrome", "Gmail — Follow up Acme")
    );
  }

  const patterns = analyzeActivityPatterns(rows, { timeZone: "America/Los_Angeles" });
  const pattern = findPattern(patterns, ["attend-call", "prepare-contract", "send-follow-up"]);

  assert.ok(pattern, "expected window semantics to preserve a same-app workflow");
  assert.equal(pattern.count, 3, "occurrences are independent, not overlapping windows");
  assert.deepEqual(pattern.apps, ["Google Chrome", "Google Chrome", "Google Chrome"]);
  assert.deepEqual(
    pattern.transitions.map(({ medianMinutes }) => medianMinutes),
    [60, 10]
  );
  assert.ok(pattern.examples.every((example) => example.steps.length === 3));
  assert.ok(pattern.examples.every((example) => example.sharedContext.includes("acme")));
  assert.equal(pattern.trigger.type, "after_action");
  assert.equal(findPattern(patterns, ["attend-call", "prepare-contract"]), undefined, "fully subsumed prefix should not create a duplicate skill");
  assert.equal(findPattern(patterns, ["prepare-contract", "send-follow-up"]), undefined, "fully subsumed suffix should not create a duplicate skill");
});

test("semantic labels do not mistake transcript archives or meeting notes for live calls", () => {
  assert.notEqual(
    classifyActivityAction({ app: "BuildBetter", window: "Browse transcript archive", at: "2026-07-01T16:00:00Z" }).key,
    "attend-call"
  );
  assert.equal(
    classifyActivityAction({ app: "Google Docs", window: "Acme meeting notes", at: "2026-07-01T16:00:00Z" }).key,
    "work-on-document"
  );
});

test("three Mondays infer a weekly 09:00 cadence in the requested timezone across DST", () => {
  const occurrences = [
    ["2026-02-23T17:00:00Z", "2026-02-23T17:30:00Z"], // 09:00 PST
    ["2026-03-02T17:00:00Z", "2026-03-02T17:30:00Z"], // 09:00 PST
    ["2026-03-09T16:00:00Z", "2026-03-09T16:30:00Z"]  // 09:00 PDT
  ];
  const rows = occurrences.flatMap(([callAt, contractAt]) => [
    activity(callAt, "Zoom", "Acme weekly sales call"),
    activity(contractAt, "PandaDoc", "Acme MSA contract")
  ]);

  const patterns = analyzeActivityPatterns(rows, { timeZone: "America/Los_Angeles" });
  const pattern = findPattern(patterns, ["attend-call", "prepare-contract"]);

  assert.ok(pattern);
  assert.equal(pattern.distinctDays, 3);
  assert.equal(pattern.distinctWeeks, 3);
  assert.equal(pattern.cadence.type, "weekly");
  assert.equal(pattern.cadence.weekday, "Monday");
  assert.equal(pattern.cadence.startHour, 9);
  assert.equal(pattern.cadence.timeZone, "America/Los_Angeles");
  assert.ok(pattern.horizons.includes("week"));
  assert.equal(pattern.trigger.type, "after_action", "a sequential workflow stays event-driven even when its cadence is weekly");
});

test("machine streams never interleave, but completed occurrences aggregate afterward", () => {
  const interleavedOnly = [];
  for (const day of ["2026-07-01", "2026-07-02", "2026-07-03"]) {
    interleavedOnly.push(
      activity(`${day}T16:00:00Z`, "Zoom", "Acme sales call", "calls-mac"),
      activity(`${day}T16:30:00Z`, "PandaDoc", "Acme contract", "contracts-mac")
    );
  }
  assert.equal(
    findPattern(analyzeActivityPatterns(interleavedOnly), ["attend-call", "prepare-contract"]),
    undefined,
    "events from different machines must not invent a transition"
  );

  const completePerMachine = [
    activity("2026-07-01T16:00:00Z", "Zoom", "Acme sales call", "mac-a"),
    activity("2026-07-01T16:30:00Z", "PandaDoc", "Acme contract", "mac-a"),
    activity("2026-07-02T16:00:00Z", "Google Meet", "Globex sales call", "mac-b"),
    activity("2026-07-02T16:30:00Z", "DocuSign", "Globex contract", "mac-b")
  ];
  const aggregated = findPattern(
    analyzeActivityPatterns(completePerMachine, { minOccurrences: 2, timeZone: "UTC" }),
    ["attend-call", "prepare-contract"]
  );

  assert.ok(aggregated);
  assert.equal(aggregated.count, 2);
  assert.deepEqual(new Set(aggregated.examples.map((example) => example.machineId)), new Set(["mac-a", "mac-b"]));
});

test("every ordered workflow stays action-triggered even when it repeats daily", () => {
  const rows = [];
  for (const day of ["2026-07-01", "2026-07-02", "2026-07-03"]) {
    rows.push(
      activity(`${day}T16:00:00Z`, "PandaDoc", "Acme contract"),
      activity(`${day}T16:20:00Z`, "Gmail", "Compose Acme follow-up")
    );
  }
  const pattern = findPattern(analyzeActivityPatterns(rows, { timeZone: "UTC" }), ["prepare-contract", "send-follow-up"]);
  assert.ok(pattern);
  assert.equal(pattern.cadence.type, "daily");
  assert.equal(pattern.trigger.type, "after_action");
  assert.equal(pattern.trigger.action, "prepare-contract");
});

test("sparse dates stay irregular and a mismatched causal continuation is rejected", () => {
  const sparse = ["2026-01-01", "2026-02-11", "2026-03-23"].flatMap((day) => [
    activity(`${day}T16:00:00Z`, "PandaDoc", "Acme contract"),
    activity(`${day}T16:20:00Z`, "Gmail", "Compose Acme follow-up")
  ]);
  const sparsePattern = findPattern(analyzeActivityPatterns(sparse, { timeZone: "UTC" }), ["prepare-contract", "send-follow-up"]);
  assert.ok(sparsePattern);
  assert.equal(sparsePattern.cadence.type, "irregular");

  const mismatch = [];
  for (const day of ["2026-07-01", "2026-07-02", "2026-07-03"]) {
    mismatch.push(
      activity(`${day}T16:00:00Z`, "Zoom", "Acme sales call"),
      activity(`${day}T16:30:00Z`, "PandaDoc", "Acme contract"),
      activity(`${day}T16:40:00Z`, "Gmail", "Compose Globex follow-up")
    );
  }
  assert.equal(
    findPattern(analyzeActivityPatterns(mismatch, { timeZone: "UTC" }), ["attend-call", "prepare-contract", "send-follow-up"]),
    undefined
  );
});
