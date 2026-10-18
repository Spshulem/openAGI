import assert from "node:assert/strict";
import test from "node:test";
import { FallbackDateTimeFormat, installIntlFallback } from "../src/intl-fallback.js";

// Compared against real ICU output in the process's own zone, for the exact
// option shapes the daemon uses (daily-planner, activity-patterns, g2-proactive).
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const at = new Date("2026-10-15T14:05:09Z");
const SHAPES = [
  ["en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }],
  ["en-US", { weekday: "long", month: "long", day: "numeric" }],
  ["en-GB", { hour: "2-digit", hourCycle: "h23" }]
];

for (const [locale, options] of SHAPES) {
  test(`format matches ICU for ${locale} ${JSON.stringify(options)}`, () => {
    const real = new Intl.DateTimeFormat(locale, { timeZone: zone, ...options }).format(at);
    const fallback = new FallbackDateTimeFormat(locale, { timeZone: zone, ...options }).format(at);
    assert.equal(fallback, real);
  });
}

test("formatToParts yields the typed fields the planner reads", () => {
  const options = { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" };
  const pick = (parts) => Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  assert.deepEqual(pick(new FallbackDateTimeFormat("en-CA", options).formatToParts(at)), pick(new Intl.DateTimeFormat("en-CA", options).formatToParts(at)));
  const weekly = { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  assert.deepEqual(pick(new FallbackDateTimeFormat("en-US", weekly).formatToParts(at)), pick(new Intl.DateTimeFormat("en-US", weekly).formatToParts(at)));
});

test("UTC renders in UTC; callable without new; resolvedOptions reports the zone", () => {
  assert.equal(FallbackDateTimeFormat("en-CA", { timeZone: "UTC", hour: "2-digit", hourCycle: "h23" }).format(at), "14");
  process.env.OPENAGI_TIME_ZONE = "America/Los_Angeles";
  try {
    assert.equal(FallbackDateTimeFormat().resolvedOptions().timeZone, "America/Los_Angeles");
  } finally {
    delete process.env.OPENAGI_TIME_ZONE;
  }
});

test("install is a no-op when Intl exists", () => {
  assert.equal(installIntlFallback(), false);
});
