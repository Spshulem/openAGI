// test/mobile-push-envelope.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodePushKey, openPushEnvelope, sealPushEnvelope } from "../src/mobile-push-envelope.js";

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mobile", "fixtures", "push-envelope.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const newKey = () => crypto.randomBytes(32).toString("base64url");

test("the shared fixture decrypts to its plaintext (the Swift side decrypts the same one)", () => {
  assert.equal(openPushEnvelope(fixture.key, fixture.kind, fixture.wire), fixture.plaintext);
});

test("sealing with the fixture's nonce reproduces the fixture's wire string byte for byte", () => {
  const nonce = Buffer.from(fixture.wire.split(".")[1], "base64url");
  assert.equal(sealPushEnvelope(fixture.key, fixture.kind, fixture.plaintext, { nonce }), fixture.wire);
});

test("round trip for both kinds, objects sent as JSON", () => {
  const key = newKey();
  const alert = { questionId: "fq1", title: "Merge?", body: "", options: ["Approve"], threadKey: "codex:abc" };
  const wire = sealPushEnvelope(key, "alert", alert);
  assert.match(wire, /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(JSON.parse(openPushEnvelope(key, "alert", wire)), alert);
  assert.equal(openPushEnvelope(key, "activity", sealPushEnvelope(key, "activity", "héllo ✓")), "héllo ✓");
  // A fresh nonce every time.
  assert.notEqual(sealPushEnvelope(key, "alert", alert), wire);
});

test("the wrong key, the wrong kind, or one flipped byte fails to open", () => {
  const key = newKey();
  const wire = sealPushEnvelope(key, "alert", "{}");
  assert.throws(() => openPushEnvelope(newKey(), "alert", wire));
  assert.throws(() => openPushEnvelope(key, "activity", wire));
  const [v, n, body] = wire.split(".");
  const bytes = Buffer.from(body, "base64url");
  bytes[0] ^= 1;
  assert.throws(() => openPushEnvelope(key, "alert", `${v}.${n}.${bytes.toString("base64url")}`));
  assert.throws(() => openPushEnvelope(key, "alert", `v2.${n}.${body}`));
  assert.throws(() => openPushEnvelope(key, "alert", "v1.only-two"));
  assert.throws(() => sealPushEnvelope(key, "other", "{}"));
});

test("a key is base64url without padding of exactly 32 bytes", () => {
  assert.equal(decodePushKey(fixture.key)?.length, 32);
  assert.equal(decodePushKey(crypto.randomBytes(31).toString("base64url")), null);
  assert.equal(decodePushKey(crypto.randomBytes(33).toString("base64url")), null);
  assert.equal(decodePushKey(`${fixture.key}=`), null);
  // Standard base64 of 32 bytes always carries "=" padding.
  assert.equal(decodePushKey(crypto.randomBytes(32).toString("base64")), null);
  assert.equal(decodePushKey("a+b/".repeat(11)), null);
  assert.equal(decodePushKey(42), null);
});
