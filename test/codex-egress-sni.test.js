import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import tls from "node:tls";
import { createCodexEgressBroker } from "../src/codex-egress.js";
import { inspectClientHelloSni } from "../src/codex-tls-sni.js";

test("a CONNECT to an allowlisted host cannot dial before a matching TLS SNI", async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-egress-sni-"));
  const upstream = net.createServer((socket) => { socket.resume(); socket.on("error", () => {}); });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  let dials = 0;
  const broker = createCodexEgressBroker({
    profileDir: profile,
    lookup: async () => [{ address: "1.1.1.1", family: 4 }],
    dial: () => { dials += 1; return net.connect(upstream.address().port, "127.0.0.1"); }
  });
  let secure;
  let raw;
  try {
    await broker.start();
    raw = net.connect(broker.socketPath);
    const tunnel = new Promise((resolve, reject) => {
      raw.once("error", reject);
      raw.once("connect", () => raw.write("CONNECT auth.openai.com:443 HTTP/1.1\r\nHost: auth.openai.com:443\r\n\r\n"));
      raw.once("data", (chunk) => resolve(chunk.toString()));
    });
    assert.match(await tunnel, /^HTTP\/1\.1 200 /);
    secure = tls.connect({ socket: raw, servername: "attacker.example", rejectUnauthorized: false });
    await new Promise((resolve) => {
      secure.once("error", resolve);
      secure.once("close", resolve);
      setTimeout(resolve, 500);
    });
    assert.equal(dials, 0);
  } finally {
    secure?.destroy();
    raw?.destroy();
    await broker.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("TLS SNI matching rejects non-ASCII aliases even if text decoding masks the high bit", async () => {
  let capture;
  let peer;
  const hello = new Promise((resolve) => { capture = resolve; });
  const server = net.createServer((socket) => { peer = socket; socket.once("data", capture); socket.on("error", () => {}); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = tls.connect({ port: server.address().port, servername: "auth.openai.com", rejectUnauthorized: false });
  client.on("error", () => {});
  try {
    const original = await hello;
    const name = Buffer.from("auth.openai.com");
    const at = original.indexOf(name);
    assert.ok(at > 0);
    assert.equal(inspectClientHelloSni(original, "auth.openai.com"), "accepted");
    const hostile = Buffer.from(original);
    hostile[at] |= 0x80;
    assert.equal(inspectClientHelloSni(hostile, "auth.openai.com"), "denied");
  } finally {
    client.destroy();
    peer?.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
