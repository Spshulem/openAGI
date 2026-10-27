import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  linkUiHosts, openChatFor, KIND_NAMES, ROUTES, THREAD_KINDS, THREAD_KIND_PATTERN, UI_APPS, clampTail, clampText, isAckItem, isPidAlive, isSupervisorOwnPrompt, liveCardItems, parseBackgroundRoutes, parseDeliveryMode, parseEnvText, parsePrRef, prRefKey, readTail, redactSecrets,
  ANTIGRAVITY_LS, defaultBinaries, openImmutableDb, isThreadKey, kindName, repoFromRemote, resolveFleetConfig, resolveOcuPath, runCommand, toIso, uiTargetFor
} from "../src/fleet/contracts.js";

test("Antigravity binaries resolve the app shim and both app install locations without PATH", () => {
  const home = "/home/fixture";
  const shim = path.join(home, ".gemini", "antigravity", "bin", "agentapi");
  const userApp = path.join(home, "Applications", "Antigravity.app", "Contents", "Resources", "bin", "language_server");
  const both = defaultBinaries(home, (file) => [shim, ANTIGRAVITY_LS, userApp].includes(file));
  assert.equal(both.agentapi, shim);
  assert.equal(both.antigravityLs, ANTIGRAVITY_LS);
  const bundled = defaultBinaries(home, (file) => file === userApp);
  assert.equal(bundled.agentapi, null);
  assert.equal(bundled.antigravityLs, userApp);
  assert.equal(defaultBinaries(home, () => false).agentapi, null);
});

test("immutable SQLite reads preserve special path characters and create no sidecars", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-contracts-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "space #question?percent%.db");
  const setup = new DatabaseSync(file);
  setup.exec("PRAGMA journal_mode=WAL; CREATE TABLE fixture (value); INSERT INTO fixture VALUES (42)");
  setup.close();
  const db = await openImmutableDb(file);
  assert.ok(db);
  try { assert.equal(db.prepare("SELECT value FROM fixture").get().value, 42); }
  finally { db.close(); }
  assert.equal(fs.existsSync(file + "-wal"), false);
  assert.equal(fs.existsSync(file + "-shm"), false);
});

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

test("the supervisor's own sessions: configured ids and the display prompt", () => {
  const env = { CLAUDE_CODE_SESSION_ID: "self-1", OPENAGI_FLEET_SELF_SESSION_IDS: "01a0df66-b269-7540-81f5-592808f2e1f1, 01a1316f-4fc1-7072-8c53-d96ce5fb8085" };
  assert.deepEqual(resolveFleetConfig(env, { home: "/h" }).selfSessionIds, ["self-1", "01a0df66-b269-7540-81f5-592808f2e1f1", "01a1316f-4fc1-7072-8c53-d96ce5fb8085"]);
  assert.equal(isSupervisorOwnPrompt("You are the Agent Supervisor display. Reply with exactly: Agent Supervisor connected — monitoring C…"), true);
  assert.equal(isSupervisorOwnPrompt("Explain how the Agent Supervisor display works"), false);
  assert.equal(isSupervisorOwnPrompt(null), false);
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
  assert.equal(limits.uiDeliveryTimeoutMs, 205_000);
  assert.equal(limits.uiCleanupMs, 90_000);
  assert.equal(limits.uiLockWaitMs, 0, "busy at once: no room to wait inside the broker ceiling");
  assert.equal(limits.uiNavigateSlowMs, 60_000);
  assert.equal(limits.uiReadTimeoutMs, 45_000);
  assert.equal(limits.uiActivateMs, 3_000);
});

test("resolveOcuPath: explicit path, else open-computer-use on PATH, preferring the bundled native engine", () => {
  const launcher = "/nvm/lib/node_modules/open-computer-use/bin/open-computer-use";
  const native = "/nvm/lib/node_modules/open-computer-use/dist/Open Computer Use.app/Contents/MacOS/OpenComputerUse";
  const files = new Set(["/nvm/bin/open-computer-use", launcher, native, "/opt/ocu/custom"]);
  const exists = (file) => files.has(file);
  const realpath = (file) => (file === "/nvm/bin/open-computer-use" ? launcher : file);
  const options = { exists, realpath, execPath: "/nowhere/node", home: "/nohome", readdir: () => [] };
  assert.equal(resolveOcuPath({ PATH: "/usr/bin:/nvm/bin" }, options), native);
  assert.equal(resolveOcuPath({ PATH: "/usr/bin", OPENAGI_FLEET_OCU_PATH: "/opt/ocu/custom" }, options), "/opt/ocu/custom");
  // An explicit path that does not exist is kept, so readiness names it as missing.
  assert.equal(resolveOcuPath({ OPENAGI_FLEET_OCU_PATH: "/missing/ocu" }, options), "/missing/ocu");
  // A launchd PATH without nvm still finds the engine next to the daemon's node.
  assert.equal(resolveOcuPath({ PATH: "/usr/bin" }, { ...options, execPath: "/nvm/bin/node" }), native);
  assert.equal(resolveOcuPath({ PATH: "/usr/bin" }, options), null);
  // Started by the app with its own node and a bare PATH (after a reboot):
  // the newest nvm node's install is found.
  const nvmFiles = new Set(["/h/.nvm/versions/node/v22.21.1/bin/open-computer-use", "/h/.nvm/versions/node/v9.0.0/bin/open-computer-use"]);
  const viaNvm = { exists: (file) => nvmFiles.has(file), realpath: (file) => file, execPath: "/Applications/OpenAGI.app/node/bin/node", home: "/h", readdir: () => ["v9.0.0", "v22.21.1", ".cache"] };
  assert.equal(resolveOcuPath({ PATH: "/usr/bin:/bin" }, viaNvm), "/h/.nvm/versions/node/v22.21.1/bin/open-computer-use");
  assert.equal(resolveOcuPath({ PATH: "/usr/bin:/bin" }, { ...viaNvm, readdir: () => { throw new Error("ENOENT"); } }), null);
  // The configured home is the one searched, not the process user's.
  const configHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ocu-home-")));
  const installed = path.join(configHome, ".nvm", "versions", "node", "v22.0.0", "bin", "open-computer-use");
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, "");
  try {
    assert.equal(resolveOcuPath({ PATH: "/usr/bin" }, { home: configHome, execPath: "/nowhere/node" }), installed);
  } finally {
    fs.rmSync(configHome, { recursive: true, force: true });
  }
  // pnpm's generated launcher is never picked.
  assert.equal(resolveOcuPath({ PATH: "/usr/bin" }, { ...viaNvm, readdir: () => [], exists: (file) => file === "/h/Library/pnpm/open-computer-use" }), null);
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

test("background routes are off unless listed, and never include claude-resume; the idle watcher is on unless turned off", () => {
  assert.deepEqual(parseBackgroundRoutes("codex-exec, peer-relay claude-resume bogus codex-exec"), ["codex-exec", "peer-relay"]);
  assert.deepEqual(parseBackgroundRoutes(""), []);
  assert.deepEqual(parseBackgroundRoutes("off"), []);
  const plain = resolveFleetConfig({}, { home: "/home/fixture" });
  assert.deepEqual(plain.backgroundRoutes, []);
  assert.deepEqual(plain.idleDrain, { enabled: true, pollMs: 15_000 });
  const set = resolveFleetConfig({ OPENAGI_FLEET_BACKGROUND_ROUTES: "codex-exec", OPENAGI_FLEET_IDLE_DRAIN: "0", OPENAGI_FLEET_IDLE_POLL_MS: "5000" }, { home: "/home/fixture" });
  assert.deepEqual(set.backgroundRoutes, ["codex-exec"]);
  assert.deepEqual(set.idleDrain, { enabled: false, pollMs: 5000 });
  assert.deepEqual(resolveFleetConfig({}, { home: "/home/fixture", backgroundRoutes: ["claude-resume", "peer-relay"] }).backgroundRoutes, ["peer-relay"]);
});

test("a card item that says it needs nothing, or only acknowledges, asks nothing", () => {
  const item = (question, options = []) => ({ question, options });
  // 019fe344: a card with no choices that says it needs nothing.
  assert.equal(isAckItem(item("I'm recovering the staged candidate; no input is needed from you right now.")), true);
  assert.equal(isAckItem(item("Nothing is needed from you.")), true);
  assert.equal(isAckItem(item("I will use the native build.", ["Okay"])), true);
  assert.equal(isAckItem(item("I will use the native build.", ["Continue (Recommended)"])), true);
  assert.equal(isAckItem(item("I will use the native build.", ["Okay (recommended)"])), true);
  assert.equal(isAckItem(item("Ship it?", ["Ship it (Recommended)"])), false);
  assert.equal(isAckItem(item("Please sign back into ZeroShot Staging.")), false);
  assert.equal(isAckItem(item("No input needed? Pick a region.", ["us-east-1", "eu-west-1"])), false);
  assert.deepEqual(liveCardItems({ app: "codex", items: [item("no action needed"), { ...item("Sign in?"), at: null }] }).map((entry) => entry.question), ["Sign in?"]);
});

test("openChatFor: the link that opens exactly that chat, or a label that says where it is", () => {
  // Two chats in one workspace named remote-dev: the tab title tells them apart.
  const conductor = (session, tab) => ({
    key: `conductor:${session}`, kind: "conductor", id: session, title: tab, workspace: "remote-dev", cwd: "/ws/remote-dev",
    meta: { conductorWorkspaceId: "w1", conductorSessionId: session, conductorSessionTitle: tab, conductorWorkspaceSessions: 2 }
  });
  const a = openChatFor(conductor("d1dbe71a", "Codex LB Transcript open"));
  const b = openChatFor(conductor("0056f770", "Remote dev setup"));
  assert.deepEqual(a, { app: "conductor", url: "conductor://workspace?id=w1&session=d1dbe71a", label: "remote-dev · Codex LB Transcript open (Conductor)", note: null });
  assert.equal(b.label, "remote-dev · Remote dev setup (Conductor)");
  assert.notEqual(a.url, b.url);
  // A tab titled like its workspace is not named twice.
  assert.equal(openChatFor(conductor("s9", "Remote-Dev")).label, "remote-dev (Conductor)");
  // Codex: the thread's id link, the one computer-use sends use.
  const codex = { key: "codex:019f", kind: "codex", id: "019f", title: "Download Amex Statements", cwd: "/w/bb", meta: {} };
  assert.deepEqual(openChatFor(codex), { app: "codex", url: "codex://threads/019f", label: "Download Amex Statements (Codex)", note: null });
  assert.equal(openChatFor({ ...codex, archived: true }).url, null);
  assert.match(openChatFor({ ...codex, archived: true }).note, /unarchive/);
  // A Codex thread Conductor runs opens through its Conductor tab.
  const hosted = { ...codex, key: "codex:c1", id: "c1", meta: { originator: "codex_sdk_ts" } };
  const host = { ...conductor("s2", "Ship it"), claudeSessionId: "c1" };
  const [linked] = linkUiHosts([hosted, host]);
  assert.equal(openChatFor(linked).url, "conductor://workspace?id=w1&session=s2");
  assert.equal(openChatFor(linked).app, "conductor");
  // With no Conductor tab showing it: no guessed link, its app named.
  assert.equal(openChatFor(hosted).url, null);
  assert.equal(openChatFor(hosted).app, "conductor");
  const named = openChatFor({ ...hosted, cwd: "/work/remote-dev" });
  assert.match(named.label, /remote-dev/);
  assert.match(named.note, /remote-dev/);
  // A Claude Code terminal session: no app link opens it.
  const claude = openChatFor({ key: "claude:x", kind: "claude", id: "x", title: "fix auth", workspace: null, cwd: "/Users/me/Dev/api", meta: {} });
  assert.equal(claude.url, null);
  assert.equal(claude.app, "claude");
  assert.equal(claude.label, "api · fix auth (Claude Code)");
  assert.match(claude.note, /terminal/);
  assert.equal(openChatFor(null), null);
});

test("thread keys come from the one kind list, Antigravity included", () => {
  assert.deepEqual(THREAD_KINDS, ["codex", "claude", "conductor", "antigravity", "copilot"]);
  assert.equal(THREAD_KIND_PATTERN, "codex|claude|conductor|antigravity|copilot");
  for (const key of ["codex:019f-a", "claude:abc", "conductor:c.1", "antigravity:e8b9db19-dae3-4406-84b6-81df9fff3df8", "copilot:04e05df2-8aaa-4736-beba-1595044e2ed9"]) assert.equal(isThreadKey(key), true, key);
  for (const key of ["gemini:x", "antigravity:", "antigravity:a b", "xantigravity:1", "codex:a/b", null, 7]) assert.equal(isThreadKey(key), false, String(key));
  for (const kind of THREAD_KINDS) assert.ok(KIND_NAMES[kind], kind);
  assert.equal(kindName("antigravity"), "Antigravity");
  assert.equal(kindName("copilot"), "Copilot");
  assert.equal(kindName("other"), "Agent");
});


test("Antigravity openChatFor names the workspace and conversation without a guessed link", () => {
  const thread = { key: "antigravity:a1", kind: "antigravity", id: "a1", workspace: "api", title: "Fix auth", cwd: "/work/api" };
  const chat = openChatFor(thread);
  assert.equal(chat.app, "antigravity");
  assert.equal(chat.url, null);
  assert.equal(chat.label, "api · Fix auth (Antigravity)");
  assert.match(chat.note, /open it in Antigravity/);
  assert.equal(openChatFor({ ...thread, workspace: null }).label, chat.label);
  assert.equal(openChatFor({ ...thread, title: "API" }).label, "api (Antigravity)");
  assert.equal(openChatFor({ ...thread, workspace: null, cwd: null, title: null }).label, "untitled conversation (Antigravity)");
});
