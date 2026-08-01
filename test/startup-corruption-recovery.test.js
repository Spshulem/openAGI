// test/startup-corruption-recovery.test.js
//
// AVAIL-1: one bad byte permanently killed the always-on assistant, silently.
//
// What actually happened: readJsonFile() did `JSON.parse(fs.readFileSync(p))`
// inside a bare try/catch that only forgave ENOENT. A snapshot truncated by a
// crash (or a power cut mid-write, or a half-synced file) therefore threw out
// of the store constructor → out of the runtime constructor → out of
// startServer. The daemon printed
//
//     error: Expected ',' or '}' after property value in JSON at position 400
//
// with NO FILENAME, and exited 0. scripts/install-launchd.sh sets
// KeepAlive{SuccessfulExit=false}, so launchd read exit 0 as a clean,
// intentional stop and never restarted it: the assistant was permanently and
// silently dead. And the JSONL replay that TaskStore / ComputerUseLog /
// PendingActionStore already implement was unreachable, because the snapshot
// read threw before replay could run.
//
// Four invariants are locked down here:
//   1. an unusable snapshot is quarantined (moved aside, never deleted) and
//      the caller falls through to replay;
//   2. a startup failure that IS unrecoverable exits NON-ZERO so the
//      supervisor restarts instead of treating it as a clean stop;
//   3. every read failure names the file;
//   4. a transient read failure (EMFILE et al.) must NOT quarantine — that
//      would move a perfectly good snapshot aside over a passing fd shortage.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJsonFile, quarantineFile, classifyReadFailure } from "../src/file-utils.js";
import { TaskStore } from "../src/task-store.js";
import { ComputerUseLog } from "../src/computer-use-log.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(REPO, "examples", "hosted-server.js");

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `openagi-avail1-${tag}-`));
}

function quarantined(dir, base) {
  return fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.corrupt-`));
}

/// Capture console.warn for the duration of fn.
function captureWarn(fn) {
  const orig = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.join(" "));
  try { return { value: fn(), lines }; } finally { console.warn = orig; }
}

// ------------------------------------------------------------------ unit ---

test("readJsonFile: a truncated file is quarantined, named, and non-fatal", () => {
  const dir = tmpDir("trunc");
  const file = path.join(dir, "snapshot.json");
  const bytes = '{"version":1,"tasks":[{"id":"task_1","title":"ship the rel';
  fs.writeFileSync(file, bytes);

  const { value, lines } = captureWarn(() => readJsonFile(file, { version: 1, tasks: [] }));

  // Non-fatal: the caller gets its fallback instead of an exception, which is
  // what lets the existing JSONL replay run.
  assert.deepEqual(value, { version: 1, tasks: [] }, "must fall back, not throw");

  // Quarantined, not deleted: the bytes are preserved for inspection.
  const moved = quarantined(dir, "snapshot.json");
  assert.equal(moved.length, 1, `exactly one quarantine file, got ${JSON.stringify(moved)}`);
  assert.equal(fs.readFileSync(path.join(dir, moved[0]), "utf8"), bytes, "quarantine preserves the exact bytes");
  assert.equal(fs.existsSync(file), false, "the unusable file is moved out of the way");
  assert.match(moved[0], /\.corrupt-\d{4}-\d{2}-\d{2}T/, "quarantine name carries a timestamp");

  // Actionable: the message names the file. "Expected ',' or '}'" alone is not.
  assert.equal(lines.length, 1, `exactly one warning, got ${JSON.stringify(lines)}`);
  assert.ok(lines[0].includes(file), `the warning must name the file, got: ${lines[0]}`);
  assert.ok(lines[0].includes(moved[0]), `the warning must name where it went, got: ${lines[0]}`);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("readJsonFile: a missing file is still a silent fallback, and a good file still parses", () => {
  const dir = tmpDir("ok");
  const missing = path.join(dir, "nope.json");
  const good = path.join(dir, "good.json");
  fs.writeFileSync(good, '{"a":1}\n');

  const miss = captureWarn(() => readJsonFile(missing, { fallback: true }));
  assert.deepEqual(miss.value, { fallback: true });
  assert.deepEqual(miss.lines, [], "a missing file is normal — must not warn");
  assert.equal(quarantined(dir, "nope.json").length, 0, "nothing to quarantine");

  const ok = captureWarn(() => readJsonFile(good, null));
  assert.deepEqual(ok.value, { a: 1 });
  assert.deepEqual(ok.lines, []);
  assert.equal(fs.existsSync(good), true, "a readable file is never touched");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("readJsonFile: an unreadable (chmod 000) file is quarantined, named, and non-fatal", { skip: process.getuid?.() === 0 ? "root can read mode 000" : false }, () => {
  const dir = tmpDir("perm");
  const file = path.join(dir, "snapshot.json");
  fs.writeFileSync(file, '{"version":1,"tasks":[]}\n');
  fs.chmodSync(file, 0o000);

  const { value, lines } = captureWarn(() => readJsonFile(file, null));
  assert.equal(value, null, "must fall back, not throw");
  const moved = quarantined(dir, "snapshot.json");
  assert.equal(moved.length, 1, "an unreadable snapshot is moved aside, not left to be silently overwritten");
  assert.ok(lines[0].includes(file), `the warning must name the file, got: ${lines[0]}`);
  assert.ok(/EACCES|permission/i.test(lines[0]), `the warning must say why, got: ${lines[0]}`);

  fs.chmodSync(path.join(dir, moved[0]), 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readJsonFile: a transient read failure must NOT quarantine and must name the file", () => {
  // EMFILE/EIO/EAGAIN mean "the machine is momentarily unable to read", not
  // "this file is garbage". Moving a good snapshot aside over a passing fd
  // shortage would destroy the very data we are trying to protect. It is
  // rethrown instead so the startup guard exits non-zero and the supervisor
  // retries — which is the correct response to a transient failure.
  assert.equal(classifyReadFailure(Object.assign(new Error("x"), { code: "EMFILE" })), "transient");
  assert.equal(classifyReadFailure(Object.assign(new Error("x"), { code: "EIO" })), "transient");
  assert.equal(classifyReadFailure(Object.assign(new Error("x"), { code: "ENOENT" })), "missing");
  assert.equal(classifyReadFailure(Object.assign(new Error("x"), { code: "EACCES" })), "unreadable");
  assert.equal(classifyReadFailure(new SyntaxError("Unexpected end of JSON input")), "corrupt");
  // An unknown/programming error must never be a reason to move user data.
  assert.equal(classifyReadFailure(new TypeError("bad arg")), "transient");

  // With quarantine disabled a corrupt file throws — and the error names the path.
  const dir = tmpDir("strict");
  const file = path.join(dir, "snapshot.json");
  fs.writeFileSync(file, "{ oops");
  assert.throws(
    () => readJsonFile(file, null, { quarantine: false }),
    (err) => {
      assert.ok(err.message.includes(file), `error must name the file, got: ${err.message}`);
      assert.equal(err.path, file);
      return true;
    }
  );
  assert.equal(fs.existsSync(file), true, "quarantine:false leaves the file alone");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("quarantineFile: never overwrites an existing quarantine", () => {
  const dir = tmpDir("collide");
  const a = path.join(dir, "snapshot.json");
  fs.writeFileSync(a, "first");
  const m1 = quarantineFile(a);
  fs.writeFileSync(a, "second");
  const m2 = quarantineFile(a);
  assert.notEqual(m1, m2, "a second quarantine gets its own name");
  assert.equal(fs.readFileSync(m1, "utf8"), "first", "the first quarantine is not clobbered");
  assert.equal(fs.readFileSync(m2, "utf8"), "second");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------- store recovery ---

test("TaskStore: a snapshot truncated mid-object is survivable and the tasks come back from JSONL", () => {
  const dataDir = tmpDir("taskstore");
  const seed = new TaskStore({ dataDir });
  const a = seed.add({ title: "ship the release", bucket: "today", priority: 90 }, { queue: "user" });
  const b = seed.add({ title: "draft the changelog", bucket: "today", priority: 80 }, { queue: "agent" });
  seed.complete(a.id, "manual");

  const snapPath = path.join(dataDir, "tasks", "snapshot.json");
  const whole = fs.readFileSync(snapPath, "utf8");
  // Truncate mid-object, exactly like a crash between write() and rename().
  fs.writeFileSync(snapPath, whole.slice(0, Math.floor(whole.length * 0.4)));

  const { value: store, lines } = captureWarn(() => new TaskStore({ dataDir }));

  const titles = store.list({ limit: 100 }).map((t) => t.title).sort();
  assert.deepEqual(titles, ["draft the changelog", "ship the release"], "both tasks recovered from the JSONL replay");
  // Replay must reconstruct STATE, not just existence: the completion applied.
  assert.equal(store.get(a.id)?.status, "completed", "the completion event replayed");
  assert.equal(store.get(b.id)?.queue, "agent", "queue attribution survived replay");
  assert.ok(lines.some((l) => l.includes(snapPath)), `the warning must name the snapshot, got: ${JSON.stringify(lines)}`);
  assert.equal(quarantined(path.join(dataDir, "tasks"), "snapshot.json").length, 1, "the corrupt snapshot is preserved");

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("TaskStore: a corrupt JSONL line is skipped and the surrounding events still replay", () => {
  const dataDir = tmpDir("jsonl");
  const seed = new TaskStore({ dataDir });
  seed.add({ title: "first task" }, { queue: "user" });
  seed.add({ title: "second task" }, { queue: "user" });
  seed.add({ title: "third task" }, { queue: "user" });

  // Corrupt the middle line of the log AND destroy the snapshot: the worst
  // realistic case, a crash that truncated a write to both files.
  const logPath = path.join(dataDir, "tasks", "user.jsonl");
  const logLines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  logLines[1] = logLines[1].slice(0, 30); // half an event
  fs.writeFileSync(logPath, logLines.join("\n") + "\n");
  fs.writeFileSync(path.join(dataDir, "tasks", "snapshot.json"), "{ truncated");

  const { value: store } = captureWarn(() => new TaskStore({ dataDir }));
  const titles = store.list({ limit: 100 }).map((t) => t.title).sort();
  assert.deepEqual(titles, ["first task", "third task"], "the good events survive one bad line");

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("ComputerUseLog: a corrupt snapshot falls through to the journal replay", () => {
  const dir = tmpDir("cu");
  const seed = new ComputerUseLog({ dir });
  const session = seed.startSession({ goal: "book the flight", approvedBy: "user" });
  const action = seed.recordAction({ sessionId: session.id, kind: "click", args: { x: 1 }, reasoning: "the button" });
  seed.markActionResult(action.id, { result: "ok" });
  seed.snapshot();
  fs.writeFileSync(path.join(dir, "snapshot.json"), '{"version":1,"sessions":[{"id":"cus_');

  const { value: log } = captureWarn(() => new ComputerUseLog({ dir }));
  assert.equal(log.getSession(session.id)?.goal, "book the flight", "the session replayed from the journal");
  const actions = log.listActions({ sessionId: session.id });
  assert.equal(actions.length, 1, "the action replayed");
  assert.equal(actions[0].status, "executed", "the action RESULT replayed too");

  fs.rmSync(dir, { recursive: true, force: true });
});

// --------------------------------------------------------- daemon (e2e) ---

// Ask the OS for a free port rather than hard-coding one: these tests run in
// parallel with the other daemon-spawning suites and on a developer machine
// that may already be running OpenAGI.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function bootDaemon({ dataDir, port, waitForListen = true }, timeoutMs = 30000) {
  const env = { ...process.env, OPENAGI_DATA_DIR: dataDir, HOST: "127.0.0.1", PORT: String(port) };
  delete env.NODE_TEST_CONTEXT;
  delete env.OPENAGI_AUTH_TOKEN;
  const cwd = fs.existsSync(dataDir) && fs.statSync(dataDir).isDirectory() ? dataDir : REPO;
  const child = spawn(process.execPath, [ENTRY], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      resolve({ ...r, output: out });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ started: false, exitCode: null, timedOut: true });
    }, timeoutMs);
    const poll = setInterval(async () => {
      if (!waitForListen || !/listening at http/.test(out)) return;
      let tasks = null;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/tasks?limit=100`);
        tasks = (await res.json()).tasks;
      } catch { /* report it as null */ }
      child.kill("SIGKILL");
      finish({ started: true, exitCode: null, timedOut: false, tasks });
    }, 150);
    child.on("exit", (code) => {
      if (settled) return;
      finish({ started: false, exitCode: code, timedOut: false });
    });
  });
}

test("daemon: a corrupt task snapshot must NOT stop it starting, and the tasks must come back", { timeout: 60000 }, async () => {
  const dataDir = tmpDir("boot-corrupt");
  const seed = new TaskStore({ dataDir });
  seed.add({ title: "survive the corruption", bucket: "today", priority: 90 }, { queue: "user" });
  const snapPath = path.join(dataDir, "tasks", "snapshot.json");
  const whole = fs.readFileSync(snapPath, "utf8");
  fs.writeFileSync(snapPath, whole.slice(0, Math.floor(whole.length * 0.4)));

  const port = await freePort();
  const r = await bootDaemon({ dataDir, port });
  assert.equal(r.timedOut, false, `must not hang:\n${r.output}`);
  assert.equal(r.started, true, `a corrupt snapshot must not stop the daemon:\n${r.output}`);
  assert.ok(r.output.includes(snapPath), `the log must name the file:\n${r.output}`);
  assert.deepEqual(
    (r.tasks ?? []).map((t) => t.title),
    ["survive the corruption"],
    `the task must be served from the replayed store:\n${r.output}`
  );

  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("daemon: an unrecoverable startup failure must exit NON-ZERO so launchd restarts it", { timeout: 60000 }, async () => {
  // A data dir that is a regular file cannot be recovered from, at all. The
  // point of this test is the EXIT CODE: launchd's KeepAlive/SuccessfulExit
  // =false treats exit 0 as "it meant to stop" and never restarts, so a boot
  // failure that exits 0 is a permanently dead assistant.
  const parent = tmpDir("boot-fatal");
  const notADir = path.join(parent, "data-is-a-file");
  fs.writeFileSync(notADir, "this is not a directory\n");

  const r = await bootDaemon({ dataDir: notADir, port: await freePort(), waitForListen: false }, 30000);
  assert.equal(r.timedOut, false, `must exit, not hang:\n${r.output}`);
  assert.notEqual(r.exitCode, 0, `exit code must be non-zero, got ${r.exitCode}:\n${r.output}`);
  assert.ok(r.output.includes(notADir), `the failure must name the path:\n${r.output}`);

  fs.rmSync(parent, { recursive: true, force: true });
});
