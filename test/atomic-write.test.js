import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeTextAtomic } from "../src/file-utils.js";

test("atomic writes flush through a writable handle, including on Windows", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-atomic-write-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");
  const open = fs.openSync.bind(fs), sync = fs.fsyncSync.bind(fs);
  const handles = new Map();
  let flushed = 0;
  t.mock.method(fs, "openSync", (target, flags, ...args) => {
    const fd = open(target, flags, ...args);
    handles.set(fd, flags);
    return fd;
  });
  t.mock.method(fs, "fsyncSync", fd => {
    // Simulate Windows rather than relying on POSIX accepting read-only fsync.
    if (handles.get(fd) === "r") throw Object.assign(new Error("read-only flush refused"), { code: "EPERM" });
    flushed++;
    return sync(fd);
  });
  writeTextAtomic(file, "first complete snapshot");
  assert.equal(fs.readFileSync(file, "utf8"), "first complete snapshot");
  writeTextAtomic(file, "updated complete snapshot");
  assert.equal(fs.readFileSync(file, "utf8"), "updated complete snapshot");
  assert.equal(flushed, 2);
});

test("a real flush failure keeps the previously committed snapshot intact", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-atomic-write-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "last good snapshot");
  t.mock.method(fs, "fsyncSync", () => { throw Object.assign(new Error("disk flush failed"), { code: "EIO" }); });
  assert.throws(() => writeTextAtomic(file, "uncommitted snapshot"), { code: "EIO" });
  assert.equal(fs.readFileSync(file, "utf8"), "last good snapshot");
});
