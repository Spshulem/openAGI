// test/outreach-config.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOutreachConfig, OUTREACH_DEFAULTS } from "../src/outreach-config.js";

test("defaults are returned when config is empty", () => {
  const c = normalizeOutreachConfig({}, {});
  assert.equal(c.enabled, true);
  assert.equal(c.destination, "mac");
  assert.equal(c.cadenceHours, 3);
  assert.deepEqual(c.quietHours, { start: "22:00", end: "08:00" });
  assert.equal(c.stalledDays, 3);
  assert.ok(c.liveTypes.includes("stalled-task"));
  assert.ok(c.digestTypes.includes("draft"));
});

test("file values override defaults; env overrides file", () => {
  const c = normalizeOutreachConfig(
    { cadenceHours: 6, stalledDays: 7 },
    { OPENAGI_OUTREACH_CADENCE_HOURS: "2" }
  );
  assert.equal(c.cadenceHours, 2);   // env wins
  assert.equal(c.stalledDays, 7);    // file wins over default
});

test("quietHours window check handles overnight wrap", () => {
  const c = normalizeOutreachConfig({}, {});
  assert.equal(c.inQuietHours(new Date("2026-06-16T23:30:00")), true);
  assert.equal(c.inQuietHours(new Date("2026-06-16T07:00:00")), true);
  assert.equal(c.inQuietHours(new Date("2026-06-16T12:00:00")), false);
});
