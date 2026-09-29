import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexEgressBroker } from "../src/codex-egress.js";

function connectFrame(socketPath, frame) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let response = "";
    socket.setTimeout(2_000, () => socket.destroy(new Error("proxy response timed out")));
    socket.on("connect", () => socket.write(frame));
    socket.on("data", (chunk) => { response += chunk.toString("utf8"); if (response.includes("\r\n\r\n")) socket.end(); });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

test("Codex egress broker denies localhost, API-key origins and non-CONNECT requests", async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-egress-"));
  const broker = createCodexEgressBroker({ profileDir: profile });
  try {
    await broker.start();
    assert.equal(fs.statSync(broker.socketPath).mode & 0o777, 0o600);
    for (const frame of [
      "CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
      "CONNECT auth.openai.com:80 HTTP/1.1\r\nHost: auth.openai.com\r\n\r\n",
      "CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com\r\n\r\n",
      "GET http://auth.openai.com/ HTTP/1.1\r\n\r\n",
      "CONNECT chatgpt.com:443 HTTP/1.1\r\nProxy-Authorization: secret\r\n\r\n"
    ]) {
      assert.match(await connectFrame(broker.socketPath, frame), /^HTTP\/1\.1 403 /);
    }
  } finally {
    await broker.close();
  }
  assert.equal(fs.existsSync(broker.socketPath), false);
});

test("Codex egress broker rejects a private address returned by DNS for an allowlisted hostname", async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-egress-"));
  let dials = 0;
  const broker = createCodexEgressBroker({
    profileDir: profile,
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    dial: () => { dials += 1; throw new Error("must not dial"); }
  });
  try {
    await broker.start();
    const response = await connectFrame(broker.socketPath, "CONNECT auth.openai.com:443 HTTP/1.1\r\nHost: auth.openai.com:443\r\n\r\n");
    assert.match(response, /^HTTP\/1\.1 403 /);
    assert.equal(dials, 0);
  } finally {
    await broker.close();
  }
});

test("closing the broker during listen settles startup and removes the socket", async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-egress-race-"));
  const broker = createCodexEgressBroker({ profileDir: profile });
  const startup = broker.start();
  try {
    await broker.close();
    await Promise.allSettled([startup]);
    assert.equal(fs.existsSync(broker.socketPath), false);
  } finally {
    await broker.close();
  }
});

test("closing a saturated broker drains connections refused at the cap", async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-egress-cap-"));
  const broker = createCodexEgressBroker({ profileDir: profile });
  const clients = [];
  let closing;
  try {
    await broker.start();
    for (let index = 0; index < 9; index++) {
      const socket = net.connect(broker.socketPath);
      clients.push(socket);
      socket.on("error", () => {});
      socket.pause();
      await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    closing = broker.close();
    const settled = await Promise.race([
      closing.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 200))
    ]);
    assert.equal(settled, true, "a capped-out peer must not hold broker shutdown open");
    assert.equal(fs.existsSync(broker.socketPath), false);
  } finally {
    for (const socket of clients) socket.destroy();
    await (closing ?? broker.close());
  }
});
