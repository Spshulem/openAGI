// test/telegram-pairing.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { TelegramPairing, CODE_TTL_MS, LOCKOUT_MS } from "../src/telegram-pairing.js";

function pairing() {
  return new TelegramPairing({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "tg-pair-")) });
}

test("a valid code pairs the chat and is single use", () => {
  const p = pairing();
  const t0 = Date.parse("2026-07-06T12:00:00Z");
  const issued = p.generateCode({ now: t0 });
  assert.match(issued.code, /^\d{6}$/);
  assert.equal(issued.expiresAt, new Date(t0 + CODE_TTL_MS).toISOString());
  const r = p.attempt("12345", issued.code, { now: t0 + 1000 });
  assert.equal(r.ok, true);
  assert.equal(p.isAllowed("12345"), true);
  assert.equal(p.isAllowed("99999"), false);
  // single use: the same code cannot pair a second chat
  const r2 = p.attempt("67890", issued.code, { now: t0 + 2000 });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, "no-active-code");
  assert.equal(p.isAllowed("67890"), false);
});

test("an expired code fails", () => {
  const p = pairing();
  const t0 = Date.parse("2026-07-06T12:00:00Z");
  const { code } = p.generateCode({ now: t0 });
  const r = p.attempt("12345", code, { now: t0 + CODE_TTL_MS + 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "expired");
  assert.equal(p.isAllowed("12345"), false);
});

test("the 5th failure locks pairing for 15 minutes, even against the correct code", () => {
  const p = pairing();
  const t0 = Date.parse("2026-07-06T12:00:00Z");
  const { code } = p.generateCode({ now: t0 });
  const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 1; i <= 4; i += 1) {
    const r = p.attempt("12345", wrong, { now: t0 + i });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "invalid");
  }
  const fifth = p.attempt("12345", wrong, { now: t0 + 5 });
  assert.equal(fifth.ok, false);
  assert.equal(fifth.reason, "locked");
  // 6th attempt is rejected even with the CORRECT code
  const sixth = p.attempt("12345", code, { now: t0 + 6 });
  assert.equal(sixth.ok, false);
  assert.equal(sixth.reason, "locked");
  assert.equal(p.isAllowed("12345"), false);
  // after the lockout window a freshly generated code pairs normally
  const t1 = t0 + 5 + LOCKOUT_MS + 1;
  const fresh = p.generateCode({ now: t1 });
  assert.equal(p.attempt("12345", fresh.code, { now: t1 + 1 }).ok, true);
  assert.equal(p.isAllowed("12345"), true);
});

test("the allowlist persists across instances via allowlist.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-pair-"));
  const p1 = new TelegramPairing({ dir });
  const t0 = Date.parse("2026-07-06T12:00:00Z");
  const { code } = p1.generateCode({ now: t0 });
  assert.equal(p1.attempt("777", code, { now: t0 + 1 }).ok, true);
  assert.equal(fs.existsSync(path.join(dir, "allowlist.json")), true);
  const p2 = new TelegramPairing({ dir });
  assert.equal(p2.isAllowed("777"), true);
  assert.deepEqual(p2.allowlist(), ["777"]);
});

test("pairing the same chat twice does not duplicate the allowlist entry", () => {
  const p = pairing();
  const t0 = Date.parse("2026-07-06T12:00:00Z");
  const a = p.generateCode({ now: t0 });
  p.attempt("555", a.code, { now: t0 + 1 });
  const b = p.generateCode({ now: t0 + 2 });
  p.attempt("555", b.code, { now: t0 + 3 });
  assert.deepEqual(p.allowlist(), ["555"]);
});

test("attempts with no open code do not count toward the lockout", () => {
  const p = pairing();
  const t0 = Date.parse("2026-07-06T12:00:00Z");
  for (let i = 0; i < 10; i += 1) {
    assert.equal(p.attempt("666", "000000", { now: t0 + i }).reason, "no-active-code");
  }
  const issued = p.generateCode({ now: t0 + 100 });
  assert.equal(p.attempt("12345", issued.code, { now: t0 + 200 }).ok, true);
});
