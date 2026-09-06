import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NODE_ENROLLMENT_CODE_TTL_MS,
  NODE_ENROLLMENT_LOCKOUT_MS,
  NodeEnrollmentCodes
} from "../src/node-enrollment.js";

function enrollment() {
  return new NodeEnrollmentCodes({ platforms: ["even_g2"] });
}

test("node enrollment codes are platform-bound, expiring, and single use", () => {
  const codes = enrollment();
  const now = Date.parse("2026-09-02T12:00:00Z");
  const issued = codes.issue("even_g2", { now });
  assert.match(issued.code, /^\d{6}$/);
  assert.equal(codes.consume(issued.code, "unknown", { now: now + 1 }).ok, false);
  assert.deepEqual(codes.consume(issued.code, "even_g2", { now: now + 2 }), {
    ok: true,
    platform: "even_g2"
  });
  assert.equal(codes.consume(issued.code, "even_g2", { now: now + 3 }).reason, "no-active-code");

  const expired = codes.issue("even_g2", { now: now + 4 });
  assert.equal(codes.consume(expired.code, "even_g2", {
    now: now + 4 + NODE_ENROLLMENT_CODE_TTL_MS + 1
  }).reason, "expired");
});

test("node enrollment locks after five incorrect attempts", () => {
  const codes = enrollment();
  const now = Date.parse("2026-09-02T12:00:00Z");
  const issued = codes.issue("even_g2", { now });
  const wrong = issued.code === "000000" ? "111111" : "000000";
  for (let count = 0; count < 4; count += 1) {
    assert.equal(codes.consume(wrong, "even_g2", { now: now + count }).reason, "invalid");
  }
  assert.equal(codes.consume(wrong, "even_g2", { now: now + 4 }).reason, "locked");
  assert.equal(codes.consume(issued.code, "even_g2", { now: now + 5 }).reason, "locked");
  assert.equal(codes.status({ now: now + 5 }).lockedUntil, new Date(now + 4 + NODE_ENROLLMENT_LOCKOUT_MS).toISOString());

  const afterLockout = now + 4 + NODE_ENROLLMENT_LOCKOUT_MS + 1;
  const fresh = codes.issue("even_g2", { now: afterLockout });
  assert.equal(codes.consume(fresh.code, "even_g2", { now: afterLockout + 1 }).ok, true);
});

test("unsupported node platforms cannot issue enrollment codes", () => {
  assert.throws(() => enrollment().issue("computer-use"), /unsupported node platform/);
});
