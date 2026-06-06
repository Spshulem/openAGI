// test/url-guard.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSafePublicUrl } from "../src/url-guard.js";

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

test("rejects non-http(s) protocols", () => {
  blocks("file:///etc/passwd");
  blocks("gopher://127.0.0.1/");
});

test("allows public hosts", () => {
  allows("https://example.com/page");
  allows("http://93.184.216.34/");            // a public IPv4
  allows("https://api.exa.ai/search");
});
