// test/pair-phone.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPairingUrl, assertPhoneReachable } from "../src/pair-phone.js";

test("the pairing url carries exactly what the phone needs", () => {
  const url = buildPairingUrl({ baseUrl: "http://mac.tail1234.ts.net:43210", code: "004221", platform: "ios" });
  const parsed = new URL(url);
  assert.equal(parsed.protocol, "openagi:");
  assert.equal(parsed.searchParams.get("url"), "http://mac.tail1234.ts.net:43210");
  assert.equal(parsed.searchParams.get("code"), "004221");
  assert.equal(parsed.searchParams.get("platform"), "ios");
});

test("a trailing slash or path on the daemon url never reaches the phone", () => {
  const url = buildPairingUrl({ baseUrl: "http://mac.ts.net:43210/setup", code: "000001", platform: "android" });
  assert.equal(new URL(url).searchParams.get("url"), "http://mac.ts.net:43210");
});

test("a loopback daemon url is refused with a remediation, not a useless code", () => {
  assert.throws(() => assertPhoneReachable("http://127.0.0.1:43210"), /phone cannot reach 127\.0\.0\.1/);
  assert.throws(() => assertPhoneReachable("http://localhost:43210"), /phone cannot reach/);
  assert.throws(() => assertPhoneReachable("http://[::1]:43210"), /phone cannot reach/);
});

test("tailnet, LAN, and https origins are accepted", () => {
  assert.equal(assertPhoneReachable("http://mac.tail1234.ts.net:43210"), "http://mac.tail1234.ts.net:43210");
  assert.equal(assertPhoneReachable("http://100.101.102.103:43210"), "http://100.101.102.103:43210");
  assert.equal(assertPhoneReachable("http://192.168.1.20:43210"), "http://192.168.1.20:43210");
  assert.equal(assertPhoneReachable("https://openagi.example.com"), "https://openagi.example.com");
});

test("cleartext http to a public host is refused", () => {
  assert.throws(() => assertPhoneReachable("http://openagi.example.com"), /https/);
});

test("the platform must be one the app announces", () => {
  assert.throws(() => buildPairingUrl({ baseUrl: "http://mac.ts.net:43210", code: "000001", platform: "toaster" }),
    /platform must be ios or android/);
});

test("the code must be six digits", () => {
  assert.throws(() => buildPairingUrl({ baseUrl: "http://mac.ts.net:43210", code: "12345", platform: "ios" }),
    /six digits/);
});
