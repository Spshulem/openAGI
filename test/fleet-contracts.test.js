import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clampTail, clampText, isPidAlive, parseEnvText, parsePrRef, prRefKey, readTail, redactSecrets, repoFromRemote,
  resolveFleetConfig, runCommand, toIso
} from "../src/fleet/contracts.js";

test("resolveFleetConfig defaults to observe and disabled", () => {
  const config = resolveFleetConfig({}, { home: "/home/fixture" });
  assert.equal(config.mode, "observe");
  assert.equal(config.enabled, false);
  assert.equal(config.push, null);
  assert.equal(config.paths.codexHome, "/home/fixture/.codex");
  assert.equal(config.limits.maxSendsPerTick, 4);
});

test("resolveFleetConfig reads env and lets overrides win", () => {
  const env = { OPENAGI_FLEET_SUPERVISOR: "1", OPENAGI_FLEET_MODE: "auto", OPENAGI_FLEET_PUSH: "buzzkit", CLAUDE_CODE_SESSION_ID: "self-1" };
  const config = resolveFleetConfig(env, { home: "/h", mode: "propose" });
  assert.equal(config.enabled, true);
  assert.equal(config.mode, "propose");
  assert.equal(config.push, "buzzkit");
  assert.deepEqual(config.selfSessionIds, ["self-1"]);
  assert.equal(resolveFleetConfig({ OPENAGI_FLEET_MODE: "yolo" }, { home: "/h" }).mode, "observe");
});

test("text helpers clamp, redact, and parse refs", () => {
  assert.equal(clampText("a   b\n c", 100), "a b c");
  assert.equal(clampText("abcdefghij", 5), "abcd…");
  assert.equal(clampTail("long preamble. Want me to merge?", 18), "…Want me to merge?");
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(0), false);
  const redacted = redactSecrets("key sk-ant-abcdefghijklmnop and CODEX_LB_API_KEY=supersecret and https://ping.buzzkit.dev/abc123/x");
  assert.doesNotMatch(redacted, /abcdefghijklmnop|supersecret|abc123/);
  assert.match(redacted, /CODEX_LB_API_KEY=\[redacted\]/);
  assert.deepEqual(parsePrRef("buildbetter-app/buildbetter#6878"), { repo: "buildbetter-app/buildbetter", number: 6878 });
  assert.equal(parsePrRef("nope"), null);
  assert.equal(prRefKey("o/r", 5), "o/r#5");
  assert.equal(repoFromRemote("git@github.com:Spshulem/openAGI.git"), "Spshulem/openAGI");
  assert.equal(repoFromRemote("https://github.com/buildbetter-app/buildbetter"), "buildbetter-app/buildbetter");
  assert.equal(toIso(1790000000), new Date(1790000000 * 1000).toISOString());
  assert.equal(toIso("garbage"), null);
});

test("parseEnvText reads export lines without touching process.env", () => {
  const parsed = parseEnvText("# c\nexport CODEX_LB_API_KEY='abc'\nOTHER=1\n");
  assert.deepEqual(parsed, { CODEX_LB_API_KEY: "abc", OTHER: "1" });
  assert.equal(process.env.CODEX_LB_API_KEY === "abc", false);
});

test("readTail drops the partial first line", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-contracts-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "t.jsonl");
  fs.writeFileSync(file, `${"x".repeat(50)}\n{"a":1}\n{"b":2}\n`);
  assert.equal(readTail(file, 16), '{"b":2}\n');
  assert.equal(readTail(path.join(dir, "missing"), 16), "");
});

test("runCommand never throws and reports timeouts", async () => {
  const ok = await runCommand(process.execPath, ["-e", "process.stdout.write('hi')"]);
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout, "hi");
  const missing = await runCommand("/definitely/not/a/binary", []);
  assert.ok(missing.error);
  const slow = await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 100 });
  assert.equal(slow.timedOut, true);
});
