import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rotateDaemonLog } from "../src/daemon-log.js";
import { loadEnvFile } from "../src/file-utils.js";

test("rotation bounds archive tails and preserves the inherited append descriptor", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-log-"));
  const logPath = path.join(dir, "daemon.log");
  const fd = fs.openSync(logPath, "a", 0o600);
  t.after(() => { fs.closeSync(fd); fs.rmSync(dir, { recursive: true, force: true }); });
  for (let index = 0; index < 5; index++) {
    const text = `old-prefix-${index}-newest-tail`;
    fs.writeSync(fd, text);
    assert.equal(rotateDaemonLog({ logPath, fd, maxBytes: 12 }), true);
    assert.equal(fs.readFileSync(`${logPath}.1`, "utf8"), text.slice(-12));
    assert.equal(fs.statSync(`${logPath}.1`).mode & 0o777, 0o600);
    assert.equal(fs.statSync(logPath).size, 0);
  }
  fs.writeSync(fd, "next");
  assert.equal(fs.readFileSync(logPath, "utf8"), "next", "the inherited fd still appends at the new end");
  assert.equal(rotateDaemonLog({ logPath, fd, maxBytes: 12 }), false);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["daemon.log", "daemon.log.1", "daemon.log.2", "daemon.log.3"]);
});

test("rotation refuses another descriptor or a symlink destination", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-log-guard-"));
  const logPath = path.join(dir, "daemon.log");
  const other = path.join(dir, "other.log");
  fs.writeFileSync(logPath, "preserve log");
  const fd = fs.openSync(other, "a");
  t.after(() => { fs.closeSync(fd); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.writeSync(fd, "preserve other");
  assert.equal(rotateDaemonLog({ logPath, fd, maxBytes: 1 }), false);
  assert.equal(fs.readFileSync(other, "utf8"), "preserve other");
  fs.symlinkSync(other, path.join(dir, "linked.log"));
  assert.equal(rotateDaemonLog({ logPath: path.join(dir, "linked.log"), fd, maxBytes: 1 }), false);
  assert.equal(fs.readFileSync(logPath, "utf8"), "preserve log");
});

test("shadowed environment diagnostics identify keys without exposing values", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-env-shadow-"));
  const key = "OPENAGI_FIXTURE_SHADOW";
  const previous = process.env[key];
  t.after(() => {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  process.env[key] = "parent-value";
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, `${key}=file-value\n`);
  const seen = [];
  loadEnvFile(file, { onShadowed: (...args) => seen.push(args) });
  assert.deepEqual(seen, [[key]]);
  assert.equal(process.env[key], "parent-value");
  fs.writeFileSync(file, `${key}=parent-value\n`);
  loadEnvFile(file, { onShadowed: (...args) => seen.push(args) });
  assert.equal(seen.length, 1, "identical inherited values do not produce warnings");
});
