// test/url-guard.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSafePublicUrl, assertHostResolvesPublic } from "../src/url-guard.js";

const blocks = (url) => assert.throws(() => assertSafePublicUrl(url, "fetch_url url"), /not allowed|must be http|Invalid/i, `should block ${url}`);
const allows = (url) => assert.doesNotThrow(() => assertSafePublicUrl(url), `should allow ${url}`);

test("blocks loopback / private / link-local / metadata (plain forms)", () => {
  blocks("http://localhost/");
  blocks("http://127.0.0.1:8080/");
  blocks("http://10.0.0.5/");
  blocks("http://192.168.1.1/");
  blocks("http://172.16.0.1/");
  blocks("http://169.254.169.254/latest/meta-data/");
  blocks("http://[::1]/");
});

test("blocks IPv4-mapped IPv6 addresses (the bypass)", () => {
  // Node normalizes [::ffff:127.0.0.1] → ::ffff:7f00:1 ; both must be blocked.
  blocks("http://[::ffff:127.0.0.1]/");
  blocks("http://[::ffff:7f00:1]/");          // hex form of 127.0.0.1
  blocks("http://[::ffff:10.0.0.1]/");
  blocks("http://[::ffff:a00:1]/");           // hex form of 10.0.0.1
  blocks("http://[::ffff:169.254.169.254]/");
  blocks("http://[::ffff:a9fe:a9fe]/");       // hex form of 169.254.169.254
});

test("blocks the full IPv6 ULA (fc00::/7) and link-local (fe80::/10) ranges", () => {
  blocks("http://[fc00::1]/");   // ULA — was missed (only fd* matched before)
  blocks("http://[fcff::1]/");
  blocks("http://[fd00::1]/");
  blocks("http://[fdab::1]/");
  blocks("http://[fe80::1]/");   // link-local
  blocks("http://[fe81::1]/");   // was missed (only exactly fe80 matched before)
  blocks("http://[febf::1]/");
});

test("rejects non-http(s) protocols", () => {
  blocks("file:///etc/passwd");
  blocks("gopher://127.0.0.1/");
});

test("allows public hosts", () => {
  allows("https://example.com/page");
  allows("http://93.184.216.34/");            // a public IPv4
  allows("https://api.exa.ai/search");
});

// DNS-resolution layer: a public-looking name must be rejected when its
// A/AAAA records land in blocked space (attacker DNS, localtest.me, nip.io).
const fakeLookup = (answers) => async () => answers.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

test("rejects hostnames that resolve to private/loopback/metadata addresses", async () => {
  const cases = [["127.0.0.1"], ["10.1.2.3"], ["169.254.169.254"], ["::1"], ["fd00::1"], ["::ffff:127.0.0.1"], ["93.184.216.34", "192.168.1.1"]];
  for (const answers of cases) {
    await assert.rejects(
      assertHostResolvesPublic("evil.example.com", "fetch_url url", { lookupFn: fakeLookup(answers) }),
      /not allowed/i,
      `should reject resolution to ${answers.join(", ")}`
    );
  }
});

test("accepts hostnames that resolve only to public addresses", async () => {
  await assert.doesNotReject(
    assertHostResolvesPublic("example.com", "fetch_url url", { lookupFn: fakeLookup(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]) })
  );
});

test("rejects hostnames that fail to resolve", async () => {
  const failingLookup = async () => { const e = new Error("getaddrinfo ENOTFOUND"); e.code = "ENOTFOUND"; throw e; };
  await assert.rejects(
    assertHostResolvesPublic("nx.example.invalid", "fetch_url url", { lookupFn: failingLookup }),
    /did not resolve/i
  );
});

test("skips resolution for literal IPs (already string-checked)", async () => {
  const explodingLookup = async () => { throw new Error("lookup should not be called for IP literals"); };
  await assert.doesNotReject(assertHostResolvesPublic("93.184.216.34", "url", { lookupFn: explodingLookup }));
  await assert.doesNotReject(assertHostResolvesPublic("[2606:2800:220:1:248:1893:25c8:1946]", "url", { lookupFn: explodingLookup }));
});
