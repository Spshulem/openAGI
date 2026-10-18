import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { installPortableFetch, portableFetch } from "../src/portable-fetch.js";

const MODULE_URL = new URL("../src/portable-fetch.js", import.meta.url).href;
let sseGate = null;

function handler(req, res) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString();
    switch (req.url) {
      case "/json":
        res.writeHead(200, { "content-type": "application/json", "x-test": "yes" });
        return res.end(JSON.stringify({ ok: true }));
      case "/echo":
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ method: req.method, type: req.headers["content-type"] ?? null, body }));
      case "/sse":
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: one\n\n");
        return sseGate.then(() => res.end("data: two\n\n"));
      case "/drip":
        res.writeHead(200, { "content-type": "text/plain" });
        return res.write("first");
      case "/hang":
        return;
      case "/redirect":
        res.writeHead(302, { location: "/echo" });
        return res.end("moved");
      case "/empty":
        res.writeHead(204);
        return res.end();
      default:
        res.writeHead(404);
        res.end();
    }
  });
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function withServer(fn) {
  const server = http.createServer(handler);
  const base = `http://127.0.0.1:${await listen(server)}`;
  try {
    await fn(base);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("status, headers, url and json body", () =>
  withServer(async (base) => {
    const res = await portableFetch(`${base}/json`);
    assert.ok(res instanceof Response);
    assert.equal(res.status, 200);
    assert.equal(res.ok, true);
    assert.equal(res.headers.get("x-test"), "yes");
    assert.equal(res.url, `${base}/json`);
    assert.equal(res.redirected, false);
    assert.deepEqual(await res.json(), { ok: true });
  }));

test("POST string, Buffer, and URLSearchParams bodies", () =>
  withServer(async (base) => {
    const str = await (await portableFetch(`${base}/echo`, { method: "POST", body: "hello" })).json();
    assert.deepEqual(str, { method: "POST", type: "text/plain;charset=UTF-8", body: "hello" });

    const buf = await (
      await portableFetch(new URL(`${base}/echo`), {
        method: "POST",
        headers: [["content-type", "application/octet-stream"]],
        body: Buffer.from("bytes")
      })
    ).json();
    assert.deepEqual(buf, { method: "POST", type: "application/octet-stream", body: "bytes" });

    const form = await (await portableFetch(new Request(`${base}/echo`, { method: "PUT", body: new URLSearchParams({ a: "1" }) }))).json();
    assert.deepEqual(form, { method: "PUT", type: "application/x-www-form-urlencoded;charset=UTF-8", body: "a=1" });
  }));

test("SSE chunks are readable as they arrive", () =>
  withServer(async (base) => {
    let release;
    sseGate = new Promise((resolve) => (release = resolve));
    const res = await portableFetch(`${base}/sse`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    // The server is still parked on the gate, so this chunk came before "two" was written.
    assert.equal(decoder.decode(first.value), "data: one\n\n");
    release();
    let rest = "";
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest += decoder.decode(r.value);
    assert.equal(rest, "data: two\n\n");
  }));

test("abort before the response rejects with the AbortError", () =>
  withServer(async (base) => {
    const controller = new AbortController();
    const pending = portableFetch(`${base}/hang`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, { name: "AbortError" });
    await assert.rejects(portableFetch(`${base}/json`, { signal: AbortSignal.abort(new Error("custom")) }), { message: "custom" });
  }));

test("abort mid-stream errors the body", () =>
  withServer(async (base) => {
    const controller = new AbortController();
    const res = await portableFetch(`${base}/drip`, { signal: controller.signal });
    const reader = res.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
    controller.abort();
    await assert.rejects(reader.read(), { name: "AbortError" });
  }));

test("302 after POST follows as GET without a body", () =>
  withServer(async (base) => {
    const res = await portableFetch(`${base}/redirect`, { method: "POST", body: "drop me" });
    assert.equal(res.redirected, true);
    assert.equal(res.url, `${base}/echo`);
    assert.deepEqual(await res.json(), { method: "GET", type: null, body: "" });
  }));

test("204 and HEAD have a null body", () =>
  withServer(async (base) => {
    const empty = await portableFetch(`${base}/empty`);
    assert.equal(empty.status, 204);
    assert.equal(empty.body, null);
    const head = await portableFetch(`${base}/json`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body, null);
  }));

test("connection refused rejects with TypeError fetch failed", async () => {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(portableFetch(`http://127.0.0.1:${port}/`), (err) => {
    assert.ok(err instanceof TypeError);
    assert.equal(err.message, "fetch failed");
    assert.equal(err.cause?.code, "ECONNREFUSED");
    return true;
  });
});

test("https with a throwaway self-signed cert", async (t) => {
  // Uses the system openssl CLI (no npm deps); skipped where it is missing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-pfetch-"));
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath,
      "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    return t.skip("openssl not available");
  }
  const cert = fs.readFileSync(certPath);
  const server = https.createServer({ key: fs.readFileSync(keyPath), cert }, handler);
  const port = await listen(server);
  const previousCa = https.globalAgent.options.ca;
  https.globalAgent.options.ca = cert;
  try {
    const res = await portableFetch(`https://127.0.0.1:${port}/json`);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    https.globalAgent.options.ca = previousCa;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("installPortableFetch only replaces fetch without WebAssembly unless forced", () => {
  const original = globalThis.fetch;
  try {
    assert.equal(typeof WebAssembly, "object");
    assert.equal(installPortableFetch(), false);
    assert.equal(globalThis.fetch, original);
    assert.equal(installPortableFetch({ force: true }), true);
    assert.equal(globalThis.fetch, portableFetch);
    assert.equal(installPortableFetch(), true);
  } finally {
    globalThis.fetch = original;
  }
});

test("works under --jitless where the built-in fetch crashes", () =>
  withServer(async (base) => {
    const script = `
      const { installPortableFetch } = await import(${JSON.stringify(MODULE_URL)});
      const installed = installPortableFetch();
      const res = await fetch(${JSON.stringify(`${base}/json`)});
      console.log(JSON.stringify({ wasm: typeof WebAssembly, installed, body: await res.json() }));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ["--jitless", "--input-type=module", "-e", script], {
      cwd: path.dirname(fileURLToPath(import.meta.url))
    });
    assert.deepEqual(JSON.parse(stdout.trim()), { wasm: "undefined", installed: true, body: { ok: true } });
  }));
