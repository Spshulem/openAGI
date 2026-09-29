import assert from "node:assert/strict";
import nodeTest from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { SecretToolChatGptStore, withKernelLock, runSecretTool, hasUniqueReadOnlyHomeMount, isTrustedLockAnchorAncestor } from "../src/chatgpt-secret-store.js";

const test = process.platform === "linux" ? nodeTest : nodeTest.skip;

test("a root-owned immediate HOME parent cannot mask a renameable higher ancestor", () => {
  const directory = (uid, mode) => ({ uid, mode, isDirectory: () => true });
  const nested = [
    ["/srv/user", directory(1234, 0o700)],
    ["/srv/user/root-owned", directory(0, 0o755)],
    ["/", directory(0, 0o755)]
  ];
  assert.equal(nested.every(([name, stat]) => isTrustedLockAnchorAncestor(name, stat, false)), false);
  assert.equal(isTrustedLockAnchorAncestor("/home", directory(0, 0o755), false), true);
  assert.equal(isTrustedLockAnchorAncestor("/home", directory(65534, 0o755), true), true);
  assert.equal(isTrustedLockAnchorAncestor("/home", directory(65534, 0o755), false), false);
});

test("a hidden read-only /home mount does not authorize a writable overlay", () => {
  const ro = "10 1 0:1 / /home ro,relatime - tmpfs tmpfs ro";
  const rw = "11 1 0:2 / /home rw,relatime - tmpfs tmpfs rw";
  const homeOverlay = "12 1 0:3 / /home/crismote ro,relatime - tmpfs tmpfs ro";
  assert.equal(hasUniqueReadOnlyHomeMount(ro), true);
  assert.equal(hasUniqueReadOnlyHomeMount(rw), false);
  assert.equal(hasUniqueReadOnlyHomeMount(`${ro}\n${rw}`), false);
  assert.equal(hasUniqueReadOnlyHomeMount(`${rw}\n${ro}`), false);
  assert.equal(hasUniqueReadOnlyHomeMount(`${ro}\n${homeOverlay}`, "/home/crismote"), false);
});

test("writable service subtrees do not undermine a read-only HOME anchor", () => {
  const root = "9 1 0:0 / / rw,relatime - tmpfs tmpfs rw";
  const ro = "10 1 0:1 / /home ro,relatime - tmpfs tmpfs ro";
  const data = "11 1 0:2 / /home/crismote/.openagi rw,relatime - tmpfs tmpfs rw";
  const unrelated = "12 1 0:3 / /home/crismote/Documents rw,relatime - tmpfs tmpfs rw";
  assert.equal(hasUniqueReadOnlyHomeMount(`${root}\n${ro}\n${data}`, "/home/crismote"), true);
  assert.equal(hasUniqueReadOnlyHomeMount(`${root}\n${ro}\n${data}\n${unrelated}`, "/home/crismote"), true);
});

test("host-owned credential stays in Secret Service stdin and never in arguments or repo files", async () => {
  const calls = [];
  let secret = null;
  const run = async (args, input) => {
    calls.push({ args, input });
    if (args[0] === "store") { secret = input; return ""; }
    if (args[0] === "lookup") return secret || "";
    if (args[0] === "clear") { secret = null; return ""; }
    throw new Error("unknown command");
  };
  const store = new SecretToolChatGptStore({ run, withLock: async (fn) => fn() });
  const tokens = { accessToken: "fake-access", refreshToken: "fake-refresh", expiresAt: 123456 };
  await store.write(tokens);
  assert.deepEqual(await store.read(), tokens);
  assert.equal(calls[0].args.join(" ").includes("fake-refresh"), false);
  assert.equal(calls[0].input.includes("fake-refresh"), true);
  assert.equal(calls[1].args.join(" ").includes("fake-access"), false);
  await store.clear();
  assert.equal(await store.read(), null);
});

test("kernel lock serializes independent holders and releases after a process is killed", async () => {
  const dir = fs.mkdtempSync(path.join(os.homedir(), ".openagi-flock-test-"));
  const lock = path.join(dir, "private", "lock");
  const anchor = os.userInfo().homedir;
  let releaseFirst;
  let enterFirst;
  const entered = new Promise((resolve) => { enterFirst = resolve; });
  const first = withKernelLock(async () => { enterFirst(); await new Promise((resolve) => { releaseFirst = resolve; }); }, lock);
  try {
    await entered;
    let secondEntered = false;
    const second = withKernelLock(async () => { secondEntered = true; }, lock);
    assert.notEqual(spawnSync("/usr/bin/flock", ["-n", anchor, "/usr/bin/true"]).status, 0);
    releaseFirst();
    await Promise.all([first, second]);
    assert.equal(secondEntered, true);
    const child = spawn(process.execPath, ["--input-type=module", "-e",
      `import { withKernelLock } from ${JSON.stringify(new URL("../src/chatgpt-secret-store.js", import.meta.url).href)};
       await withKernelLock(async () => { process.stdout.write('READY\\n'); await new Promise(() => {}); }, ${JSON.stringify(lock)});`
    ], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise((resolve, reject) => {
      child.stdout.once("data", (chunk) => chunk.toString().includes("READY") ? resolve() : reject(new Error("lock not held")));
      child.once("error", reject);
    });
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("close", resolve));
    assert.equal(await withKernelLock(async () => "recovered", lock), "recovered");
  } finally {
    releaseFirst?.();
    await first;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("revocation generation survives token logout in a separate Secret Service item", async () => {
  const items = new Map();
  const run = async (args, input) => {
    const key = args.at(-1);
    if (args[0] === "lookup") return items.get(key) ?? "";
    if (args[0] === "store") { items.set(key, input); return ""; }
    if (args[0] === "clear") { items.delete(key); return ""; }
  };
  const store = new SecretToolChatGptStore({ run, withLock: async (fn) => fn() });
  await store.write({ accessToken: "fake", refreshToken: "fake", expiresAt: 10 });
  assert.equal(await store.readGeneration(), null);
  const generation = await store.bumpGeneration();
  await store.clear();
  assert.equal(await store.read(), null);
  assert.equal(await store.readGeneration(), generation);
  assert.match(generation, /^[a-f0-9-]{36}$/);
});

test("a pre-existing owner directory with permissive mode is tightened before locking", async () => {
  const dir = fs.mkdtempSync(path.join(os.homedir(), ".openagi-flock-mode-"));
  const privateDir = path.join(dir, "private");
  fs.mkdirSync(privateDir, { mode: 0o755 });
  try {
    assert.equal(await withKernelLock(async () => "ok", path.join(privateDir, "lock")), "ok");
    assert.equal(fs.statSync(privateDir).mode & 0o777, 0o700);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("default OAuth lock lives under the core service writable data root, not read-only XDG state", async () => {
  const home = fs.mkdtempSync(path.join(os.homedir(), ".openagi-flock-service-"));
  const data = path.join(home, ".openagi");
  const legacy = path.join(home, ".local", "state", "openagi");
  fs.mkdirSync(data, { mode: 0o700 });
  fs.mkdirSync(legacy, { recursive: true, mode: 0o700 });
  fs.chmodSync(legacy, 0o500);
  const script = `import { withKernelLock } from ${JSON.stringify(new URL("../src/chatgpt-secret-store.js", import.meta.url).href)};
    await withKernelLock(async () => { process.stdout.write('LOCKED\\n'); });`;
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        env: { PATH: "/usr/bin:/bin", HOME: home }, stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "LOCKED\n");
    const lock = path.join(data, "chatgpt-host-oauth", "chatgpt-oauth.lock");
    assert.equal(fs.statSync(lock).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(lock)).mode & 0o777, 0o700);
    assert.equal(fs.existsSync(path.join(legacy, "chatgpt-oauth.lock")), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("kernel lock uses its opened descriptor even when the process cwd is read-only", () => {
  const dir = fs.mkdtempSync(path.join(os.homedir(), ".openagi-flock-cwd-"));
  const cwd = path.join(dir, "read-only-cwd");
  fs.mkdirSync(cwd, { mode: 0o500 });
  const lock = path.join(dir, "private", "lock");
  try {
    const script = `import { withKernelLock } from ${JSON.stringify(new URL("../src/chatgpt-secret-store.js", import.meta.url).href)};
      await withKernelLock(async () => { process.stdout.write('LOCKED\\n'); }, ${JSON.stringify(lock)});`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd, encoding: "utf8", timeout: 5000, env: { PATH: "/usr/bin:/bin", HOME: os.homedir() }
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.equal(result.stdout, "LOCKED\n");
    assert.equal(fs.existsSync(path.join(cwd, "3")), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("no independent helper can release the lock while an OAuth critical section is running", async () => {
  const dir = fs.mkdtempSync(path.join(os.homedir(), ".openagi-flock-holder-"));
  const lock = path.join(dir, "private", "lock");
  const script = `import { withKernelLock } from ${JSON.stringify(new URL("../src/chatgpt-secret-store.js", import.meta.url).href)};
    await withKernelLock(async () => { process.stdout.write('LOCKED\\n'); await new Promise((resolve) => process.stdin.once('data', resolve)); }, ${JSON.stringify(lock)});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`lock acknowledgement timed out: ${stderr}`)), 3000);
      child.stdout.once("data", (chunk) => {
        clearTimeout(timeout);
        chunk.toString().includes("LOCKED") ? resolve() : reject(new Error("missing lock acknowledgement"));
      });
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("close", () => { clearTimeout(timeout); reject(new Error(`holder exited before entry: ${stderr}`)); });
    });
    const children = fs.readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8").trim();
    assert.equal(children, "", "an orphanable shell must not own the lock after entry");
  } finally {
    child.kill("SIGKILL");
    await closed;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("kernel lock rejects a world-writable ancestor of its private directory", async () => {
  const root = fs.mkdtempSync(path.join(os.homedir(), ".openagi-flock-ancestor-"));
  const data = path.join(root, ".openagi");
  const lockDir = path.join(data, "chatgpt-host-oauth");
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(data, 0o777);
  let entered = false;
  try {
    await assert.rejects(withKernelLock(async () => { entered = true; }, path.join(lockDir, "lock")), /Unsafe ChatGPT credential lock data directory/);
    assert.equal(entered, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("kernel lock refuses a symlinked data root before entering the critical section", async () => {
  const home = fs.mkdtempSync(path.join(os.homedir(), ".openagi-flock-symlink-"));
  const actual = path.join(home, "actual-data");
  fs.mkdirSync(path.join(actual, "chatgpt-host-oauth"), { recursive: true, mode: 0o700 });
  fs.symlinkSync(actual, path.join(home, ".openagi"));
  let entered = false;
  try {
    await assert.rejects(withKernelLock(async () => { entered = true; },
      path.join(home, ".openagi", "chatgpt-host-oauth", "lock")), /Unsafe ChatGPT credential lock data directory/);
    assert.equal(entered, false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("independent processes in different working directories contend for the same lock inode", async () => {
  const dir = fs.mkdtempSync(path.join(os.homedir(), ".openagi-flock-cross-cwd-"));
  const lock = path.join(dir, "private", "lock");
  const anchor = os.userInfo().homedir;
  const cwdA = path.join(dir, "a");
  const cwdB = path.join(dir, "b");
  fs.mkdirSync(cwdA);
  fs.mkdirSync(cwdB);
  const script = `import { withKernelLock } from ${JSON.stringify(new URL("../src/chatgpt-secret-store.js", import.meta.url).href)};
    process.stdout.write('WAITING\\n');
    await withKernelLock(async () => { process.stdout.write('LOCKED\\n'); await new Promise((resolve) => process.stdin.once('data', resolve)); }, ${JSON.stringify(lock)});`;
  const children = [];
  const launch = (cwd) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd, stdio: ["pipe", "pipe", "pipe"]
    });
    const closed = new Promise((resolve) => child.once("close", resolve));
    children.push({ child, closed });
    let output = "";
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => { output += chunk; });
    const waitFor = (text) => new Promise((resolve, reject) => {
      if (output.includes(text)) return resolve();
      const timer = setTimeout(() => { child.stdout.off("data", onData); reject(new Error(`missing ${text}: ${stderr}`)); }, 3000);
      const onData = () => { if (output.includes(text)) { clearTimeout(timer); child.stdout.off("data", onData); resolve(); } };
      child.stdout.on("data", onData);
    });
    return { child, waitFor, output: () => output };
  };
  try {
    const first = launch(cwdA);
    await first.waitFor("LOCKED");
    assert.notEqual(spawnSync("/usr/bin/flock", ["-n", anchor, "/usr/bin/true"]).status, 0);
    const second = launch(cwdB);
    await second.waitFor("WAITING");
    // Observe the second process's waiter on this inode in /proc/locks;
    // merely seeing its child PID does not prove flock attempted acquisition.
    const deadline = Date.now() + 3000;
    const inode = fs.statSync(anchor, { bigint: true }).ino;
    while (true) {
      const children = fs.readFileSync(`/proc/${second.child.pid}/task/${second.child.pid}/children`, "utf8").trim().split(/\s+/);
      const blocked = fs.readFileSync("/proc/locks", "utf8").split("\n").some((line) =>
        line.includes("-> FLOCK") && line.includes(`:${inode} `) && children.some((pid) => line.split(/\s+/).includes(pid)));
      if (blocked) break;
      if (second.output().includes("LOCKED") || Date.now() >= deadline) {
        throw new Error("second process did not contend for the lock");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(second.output().includes("LOCKED"), false);
    first.child.stdin.write("release\n");
    await second.waitFor("LOCKED");
  } finally {
    await Promise.all(children.map(async ({ child, closed }) => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("kernel lock rejects a private data root when a different user could replace its parent", async () => {
  const base = fs.mkdtempSync(path.join(os.homedir(), ".openagi-flock-parent-"));
  const project = path.join(base, "project");
  const dataRoot = path.join(project, ".openagi");
  const lockDir = path.join(dataRoot, "chatgpt-host-oauth");
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(project, 0o777);
  let entered = false;
  try {
    await assert.rejects(withKernelLock(async () => { entered = true; }, path.join(lockDir, "lock")),
      /Unsafe ChatGPT credential lock ancestor/);
    assert.equal(entered, false);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("same-UID replacement of the data root cannot split an active credential lock", async () => {
  const base = fs.mkdtempSync(path.join(os.homedir(), ".openagi-flock-replace-"));
  const dataRoot = path.join(base, ".openagi");
  const lock = path.join(dataRoot, "chatgpt-host-oauth", "lock");
  let releaseFirst;
  let signalFirst;
  const firstEntered = new Promise((resolve) => { signalFirst = resolve; });
  let firstActive = false;
  let secondEntered = false;
  let secondCompleted = false;
  const first = withKernelLock(async () => {
    firstActive = true;
    signalFirst();
    await new Promise((resolve) => { releaseFirst = resolve; });
    firstActive = false;
  }, lock);
  let second;
  try {
    await firstEntered;
    fs.renameSync(dataRoot, `${dataRoot}-old`);
    fs.mkdirSync(dataRoot, { mode: 0o700 });
    second = withKernelLock(async () => { secondEntered = firstActive; secondCompleted = true; }, lock);
    const inode = fs.statSync(os.userInfo().homedir, { bigint: true }).ino;
    const deadline = Date.now() + 3000;
    let sawBlocked = false;
    while (true) {
      const children = fs.readFileSync(`/proc/${process.pid}/task/${process.pid}/children`, "utf8").trim().split(/\s+/);
      const blocked = fs.readFileSync("/proc/locks", "utf8").split("\n").some((line) =>
        line.includes("-> FLOCK") && line.includes(`:${inode} `) && children.some((pid) => line.split(/\s+/).includes(pid)));
      if (blocked) { sawBlocked = true; break; }
      if (secondEntered || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(sawBlocked, true, "the second holder must wait on the stable inode");
    assert.equal(secondEntered, false, "a renamed data directory must not admit a second holder");
  } finally {
    releaseFirst?.();
    await Promise.allSettled([first, second].filter(Boolean));
    fs.rmSync(base, { recursive: true, force: true });
  }
  assert.equal(secondEntered, false);
  assert.equal(secondCompleted, true);
});

test("a failed lookup is not interpreted as missing credentials", async () => {
  await assert.rejects(runSecretTool(["-e", "process.stderr.write('service error'); process.exit(1)"], undefined,
    { binary: process.execPath, timeoutMs: 500 }), /Secret Service unavailable/);
});

test("a no-match lookup with no diagnostic is an absent credential, not a service failure", async () => {
  const result = await runSecretTool(["-e", "process.exit(1)"], undefined,
    { binary: process.execPath, timeoutMs: 500, lookup: true });
  assert.equal(result, "");
});

test("a hung credential helper is killed within a finite bound", async () => {
  const started = Date.now();
  await assert.rejects(runSecretTool(["-e", "setTimeout(() => {}, 10000)"], undefined,
    { binary: process.execPath, timeoutMs: 100 }), /Secret Service unavailable/);
  assert.ok(Date.now() - started < 2500);
});
