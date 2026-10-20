#!/usr/bin/env node
// Run on each target OS: prove the downloadable runtime actually serves setup
// and a syntactically valid dashboard, using disposable state and no provider.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import vm from "node:vm";
import assert from "node:assert/strict";

const directory = path.resolve(process.argv[2] || ".");
const executable = process.argv.includes("--source") ? process.execPath
  : path.join(directory, "node", process.platform === "win32" ? "node.exe" : "node");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-runtime-smoke-"));
const token = randomBytes(32).toString("hex");
const port = "43471";
let logs = "";
const child = spawn(executable, [path.join(directory, "bin/openagi.js"), "serve"], {
  cwd: directory, env: { ...process.env, OPENAGI_DATA_DIR: dataDir, OPENAGI_AUTH_TOKEN: token, PORT: port },
  stdio: ["ignore", "pipe", "pipe"]
});
let spawnError;
child.on("error", error => { spawnError = error; });
for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { logs = (logs + chunk.toString()).slice(-12000); });
try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error("Runtime exited before health became ready");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(750) });
      if (response.ok) { ready = true; break; }
    } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(ready, "bundled runtime must become healthy");
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
  if (child.exitCode === null && !spawnError) {
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(force);
  }
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
