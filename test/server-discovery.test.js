import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { advertiseServer, discoveryOrigin, phoneDiscoveryOrigin } from "../src/server-discovery.js";

test("discovery never advertises credentials, local loopback or non-HTTP destinations", () => {
  for (const url of [undefined, "http://127.0.0.1:43210", "https://localhost", "file:///tmp/a", "https://user:password@example.com", "https://example.com?token=fixture", "https://example.com#private"]) {
    assert.equal(discoveryOrigin(url), null);
    advertiseServer({ url, spawnImpl: () => assert.fail("must not spawn") })();
  }
  assert.equal(discoveryOrigin("https://agent.example.com:8443/settings"), "https://agent.example.com:8443");
});

test("native DNS-SD advertises only the configured origin and is withdrawn at shutdown", () => {
  const child = new EventEmitter();
  let killed = false;
  child.kill = () => { killed = true; };
  const stop = advertiseServer({ url: "https://main.example.com:8443", platform: "darwin", name: "Main", spawnImpl: (file, args, options) => {
    assert.equal(file, "/usr/bin/dns-sd");
    assert.deepEqual(args.slice(-4), ["local", "8443", "v=1", "url=https://main.example.com:8443"]);
    assert.equal(options.stdio, "ignore");
    return child;
  } });
  stop();
  assert.equal(killed, true);
});

test("a machine without Avahi continues running", () => {
  const child = new EventEmitter();
  child.kill = () => {};
  const stop = advertiseServer({ url: "https://main.example.com", platform: "linux", spawnImpl: (file) => {
    assert.equal(file, "avahi-publish-service");
    return child;
  } });
  assert.doesNotThrow(() => child.emit("error", new Error("ENOENT")));
  stop();
});

test("saved tailnet IPs become iOS-compatible DNS origins without scanning", async () => {
  const resolved = await phoneDiscoveryOrigin("http://100.64.0.10:43210", { reverseLookup: async (ip) => {
    assert.equal(ip, "100.64.0.10");
    return ["main.tail1234.ts.net."];
  } });
  assert.equal(resolved, "http://main.tail1234.ts.net:43210");
  assert.equal(await phoneDiscoveryOrigin("http://100.64.0.10:43210", { reverseLookup: async () => { throw new Error("offline"); } }), "http://100.64.0.10:43210");
  assert.equal(await phoneDiscoveryOrigin("https://main.example.com", { reverseLookup: () => assert.fail("not a saved tailnet IP") }), "https://main.example.com");
});
