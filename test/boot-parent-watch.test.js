// test/boot-parent-watch.test.js
//
// A server started by an agent or terminal that went away kept running the
// fleet scan for days under init. It now stops when its parent changes.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { watchParent } from "../src/boot.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("watchParent fires once when the parent changes", async () => {
  let ppid = 500;
  let fired = 0;
  watchParent(() => { fired += 1; }, { intervalMs: 5, getPpid: () => ppid, env: {} });
  await wait(20);
  assert.equal(fired, 0);
  ppid = 1;
  await wait(20);
  ppid = 2;
  await wait(20);
  assert.equal(fired, 1);
});

test("watchParent leaves launchd/systemd, docker and opted-out servers alone", async () => {
  let fired = 0;
  const onOrphan = () => { fired += 1; };
  for (const start of [1, 0]) {
    let ppid = start;
    watchParent(onOrphan, { intervalMs: 5, getPpid: () => ppid, env: {} });
    ppid = 77;
  }
  let ppid = 500;
  watchParent(onOrphan, { intervalMs: 5, getPpid: () => ppid, env: { OPENAGI_SURVIVE_PARENT: "1" } });
  ppid = 1;
  await wait(30);
  assert.equal(fired, 0);
});

test("watchParent stop cancels the watch", async () => {
  let ppid = 500;
  let fired = 0;
  const stop = watchParent(() => { fired += 1; }, { intervalMs: 5, getPpid: () => ppid, env: {} });
  stop();
  ppid = 1;
  await wait(20);
  assert.equal(fired, 0);
});

test("a real orphaned child sees its parent change", { skip: process.platform === "win32" }, async () => {
  const boot = fileURLToPath(new URL("../src/boot.js", import.meta.url));
  const child = `import { watchParent } from ${JSON.stringify(boot)};
watchParent(() => { console.log("orphaned"); process.exit(0); }, { intervalMs: 20 });
setInterval(() => {}, 1000);`;
  // The middle node starts the watcher, prints its pid, and exits at once.
  const middle = `const { spawn } = require("node:child_process");
const c = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(child)}], { stdio: ["ignore", "inherit", "inherit"] });
console.log(c.pid); setTimeout(() => process.exit(0), 300);`;
  const proc = spawn(process.execPath, ["-e", middle], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  proc.stdout.on("data", (chunk) => { out += chunk; });
  const deadline = Date.now() + 5_000;
  while (!out.includes("orphaned") && Date.now() < deadline) await wait(50);
  const pid = Number(out.split("\n")[0]);
  if (!out.includes("orphaned")) try { process.kill(pid); } catch { /* gone */ }
  assert.match(out, /orphaned/);
});
