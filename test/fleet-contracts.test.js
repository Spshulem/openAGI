import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ROUTES, UI_APPS, clampTail, clampText, isPidAlive, parseDeliveryMode, parseEnvText, parsePrRef, prRefKey, readTail, redactSecrets,
  repoFromRemote, resolveFleetConfig, resolveOcuPath, runCommand, toIso, uiTargetFor
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

test("runCommand settles after a timeout even if SIGTERM is ignored or a descendant holds the pipes", async (t) => {
  const within = (promise) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("never settled")), 5000))]);
  const stubborn = await within(runCommand(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { timeoutMs: 100, killGraceMs: 200 }));
  assert.equal(stubborn.timedOut, true);
  assert.equal(stubborn.code, null);
  const parent = "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }); process.stdout.write(c.pid + '\\n'); setInterval(() => {}, 1000)";
  const held = await within(runCommand(process.execPath, ["-e", parent], { timeoutMs: 300, killGraceMs: 200 }));
  assert.equal(held.timedOut, true);
  const grandchild = Number(held.stdout.trim().split("\n")[0]);
  t.after(() => { try { process.kill(grandchild, "SIGKILL"); } catch { /* already gone */ } });
  assert.ok(grandchild > 0);
});

test("OPENAGI_FLEET_DELIVERY picks cli, computer-use, or computer-use-first; anything else is cli", () => {
  assert.ok(ROUTES.includes("computer-use"));
  assert.equal(resolveFleetConfig({}, { home: "/h" }).delivery, "cli");
  assert.equal(resolveFleetConfig({ OPENAGI_FLEET_DELIVERY: "computer-use" }, { home: "/h" }).delivery, "computer-use");
  assert.equal(resolveFleetConfig({ OPENAGI_FLEET_DELIVERY: " Computer-Use-First " }, { home: "/h" }).delivery, "computer-use-first");
  assert.equal(resolveFleetConfig({ OPENAGI_FLEET_DELIVERY: "ui" }, { home: "/h" }).delivery, "cli");
  assert.equal(resolveFleetConfig({ OPENAGI_FLEET_DELIVERY: "computer-use" }, { home: "/h", delivery: "cli" }).delivery, "cli");
  assert.equal(parseDeliveryMode(undefined), "cli");
  const limits = resolveFleetConfig({}, { home: "/h" }).limits;
  assert.equal(limits.uiOwnerIdleMs, 120_000);
  assert.equal(limits.uiStepTimeoutMs, 10_000);
  assert.equal(limits.uiDeliveryTimeoutMs, 45_000);
});

test("resolveOcuPath: explicit path, else open-computer-use on PATH, preferring the bundled native engine", () => {
  const launcher = "/nvm/lib/node_modules/open-computer-use/bin/open-computer-use";
  const native = "/nvm/lib/node_modules/open-computer-use/dist/Open Computer Use.app/Contents/MacOS/OpenComputerUse";
  const files = new Set(["/nvm/bin/open-computer-use", launcher, native, "/opt/ocu/custom"]);
  const exists = (file) => files.has(file);
  const realpath = (file) => (file === "/nvm/bin/open-computer-use" ? launcher : file);
  const options = { exists, realpath, execPath: "/nowhere/node" };
  assert.equal(resolveOcuPath({ PATH: "/usr/bin:/nvm/bin" }, options), native);
  assert.equal(resolveOcuPath({ PATH: "/usr/bin", OPENAGI_FLEET_OCU_PATH: "/opt/ocu/custom" }, options), "/opt/ocu/custom");
  // An explicit path that does not exist is kept, so readiness names it as missing.
  assert.equal(resolveOcuPath({ OPENAGI_FLEET_OCU_PATH: "/missing/ocu" }, options), "/missing/ocu");
  // A launchd PATH without nvm still finds the engine next to the daemon's node.
  assert.equal(resolveOcuPath({ PATH: "/usr/bin" }, { ...options, execPath: "/nvm/bin/node" }), native);
  assert.equal(resolveOcuPath({ PATH: "/usr/bin" }, options), null);
  // Without the bundled app, the resolved launcher itself.
  files.delete(native);
  assert.equal(resolveOcuPath({ PATH: "/nvm/bin" }, options), launcher);
});

test("uiTargetFor maps threads to the app that shows them, or none", () => {
  const conductor = {
    key: "conductor:s1", kind: "conductor", id: "s1", workspace: "madrid", title: "Fix billing",
    meta: { conductorWorkspaceId: "w 1", conductorSessionId: "s1", conductorSessionTitle: "Fix billing", conductorWorkspaceSessions: 3 }
  };
  const target = uiTargetFor(conductor);
  assert.equal(target.bundleId, UI_APPS.conductor.bundleId);
  assert.equal(target.deepLink, "conductor://workspace?id=w%201&session=s1");
  assert.equal(target.sessionCount, 3);
  assert.equal(uiTargetFor({ ...conductor, meta: {} }), null, "no workspace id: no deep link, no route");
  assert.equal(uiTargetFor({ ...conductor, archived: true }), null);
  const codex = uiTargetFor({ key: "codex:t1", kind: "codex", id: "t1", title: "Fix uploads", meta: { originator: "Codex Desktop" } });
  assert.equal(codex.bundleId, "com.openai.codex");
  assert.equal(codex.deepLink, "codex://threads/t1");
  assert.equal(uiTargetFor({ key: "codex:t2", kind: "codex", id: "t2", meta: { originator: "codex_sdk_ts" } }), null);
  assert.equal(uiTargetFor({ key: "claude:c1", kind: "claude", id: "c1", meta: { entrypoint: "cli" } }), null, "terminal Claude: no app");
  assert.equal(uiTargetFor(null), null);
});
