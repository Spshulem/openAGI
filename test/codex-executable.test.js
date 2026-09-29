import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import * as codexClient from "../src/codex-app-server-client.js";

test("a pinned executable descriptor survives pathname replacement before spawn", { skip: process.platform !== "linux" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-codex-pin-"));
  const executable = path.join(root, "codex");
  fs.copyFileSync("/usr/bin/true", executable);
  assert.equal(typeof codexClient.pinExecutable, "function");
  const pin = codexClient.pinExecutable(executable);
  try {
    fs.renameSync(executable, path.join(root, "old-codex"));
    fs.copyFileSync("/usr/bin/false", executable);
    const ran = spawnSync(pin.command, [], { stdio: ["ignore", "pipe", "pipe", pin.fd] });
    assert.equal(ran.error, undefined);
    assert.equal(ran.status, 0, "the pinned /usr/bin/true inode, not the replacement, must execute");
  } finally {
    pin.close();
  }
});
