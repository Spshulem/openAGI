#!/usr/bin/env node
// Run on each target OS: prove the downloadable runtime actually serves setup
// and a syntactically valid dashboard, using disposable state and no provider.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import vm from "node:vm";
import assert from "node:assert/strict";

// Cold startup on a hosted runner can exceed ten seconds. Bound elapsed time
// instead of probe count: a fast connection refusal must not exhaust the budget.
export async function waitForRuntimeHealth(child, url, { timeoutMs = 30_000, pollIntervalMs = 250 } = {}) {
  const started = performance.now();
  const deadline = started + timeoutMs;
  let spawnError, attempts = 0, lastProbe = "not attempted";
  const onError = error => { spawnError = error; };
  const checkChild = () => {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Runtime exited before health became ready (code: ${child.exitCode}, signal: ${child.signalCode})`);
    }
  };
  child.on("error", onError);
  try {
    while (performance.now() < deadline) {
      checkChild();
      attempts++;
      let ready = false;
      try {
        const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
        const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(750, remaining)) });
        lastProbe = `HTTP ${response.status}`;
        await response.body?.cancel();
        ready = response.ok;
      } catch (error) {
        lastProbe = error.cause?.code || error.code || error.name;
      }
      checkChild();
      if (ready) return { elapsedMs: Math.round(performance.now() - started), attempts };
      const remaining = deadline - performance.now();
      if (remaining > 0) await delay(Math.min(pollIntervalMs, remaining));
    }
    throw new Error(`Bundled runtime did not become healthy within ${timeoutMs}ms (${attempts} probes; last: ${lastProbe})`);
  } finally {
    child.removeListener("error", onError);
  }
}

async function main() {
  const directory = path.resolve(process.argv[2] || ".");
  const executable = process.argv.includes("--source") ? process.execPath
    : path.join(directory, "node", process.platform === "win32" ? "node.exe" : "node");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-runtime-smoke-"));
  const token = randomBytes(32).toString("hex");
  const port = "43471";
  let logs = "";
  const child = spawn(executable, [path.join(directory, "bin/openagi.js"), "serve"], {
    cwd: directory, env: { ...process.env, OPENAGI_DATA_DIR: dataDir, OPENAGI_AUTH_TOKEN: token, HOST: "127.0.0.1", PORT: port, OPENAGI_DISCOVERY: "0" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let spawnError;
  child.on("error", error => { spawnError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { logs = (logs + chunk.toString()).slice(-12000); });
  try {
    const { elapsedMs, attempts } = await waitForRuntimeHealth(child, `http://127.0.0.1:${port}/health`);
    console.log(`Bundled runtime healthy after ${elapsedMs}ms (${attempts} probes)`);
    const headers = { authorization: "Bearer " + token };
    for (const route of ["/?tab=get-started", "/setup"]) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { headers, signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, 200);
      const html = await response.text();
      const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
      assert.ok(scripts.length);
      for (const [, script] of scripts) new vm.Script(script);
      assert.match(html, route === "/setup" ? /tab=chat&onboarding=1/ : /function renderGettingStarted/);
    }
    console.log("Runtime boot, health, authenticated setup, and guided dashboard passed on " + process.platform + "/" + process.arch);
  } catch (error) {
    console.error(logs.replaceAll(token, "[test-token]"));
    throw error;
  } finally {
    if (child.exitCode === null && child.signalCode === null && !spawnError) {
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(force);
    }
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
