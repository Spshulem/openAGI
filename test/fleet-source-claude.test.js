import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveFleetConfig } from "../src/fleet/contracts.js";
import { listClaudeThreads, readLivePeers } from "../src/fleet/sources/claude.js";

const NOW = Date.parse("2026-09-26T08:00:00.000Z");
const MIN = 60_000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

function makeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-claude-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function makeConfig(home, overrides = {}) {
  return resolveFleetConfig({}, { home, ...overrides });
}

// Row builders mirror real ~/.claude/projects transcript entries.
function rowsFor(id, cwd, { entrypoint = "cli", branch = "spencer/feature", sidechain = false } = {}) {
  let seq = 0;
  const base = (extra) => ({
    parentUuid: null, isSidechain: sidechain, userType: "external", entrypoint, cwd, sessionId: id,
    version: "2.1.280", gitBranch: branch, uuid: `u-${seq += 1}`, ...extra
  });
  const assistant = (content, at, stop) => base({
    type: "assistant", timestamp: at,
    message: { id: `m-${seq}`, model: "claude-opus-5-5", role: "assistant", type: "message", stop_reason: stop, content }
  });
  return {
    prompt: (text, at, extra = {}) => base({
      type: "user", timestamp: at, promptSource: "typed", origin: { kind: "human" },
      message: { role: "user", content: text }, ...extra
    }),
    text: (text, at, stop = "end_turn") => assistant([{ type: "text", text }], at, stop),
    tool: (name, toolId, input, at) => assistant([{ type: "tool_use", id: toolId, name, input }], at, "tool_use"),
    result: (toolId, text, at, toolUseResult) => base({
      type: "user", timestamp: at, sourceToolAssistantUUID: "a", toolUseResult,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: text }] }
    }),
    apiError: (text, at, error = "rate_limit", status = 429) => base({
      type: "assistant", timestamp: at, isApiErrorMessage: true, error, apiErrorStatus: status,
      message: { id: `m-${seq}`, model: "<synthetic>", role: "assistant", stop_reason: "stop_sequence", content: [{ type: "text", text }] }
    }),
    sysApiError: (formatted, at) => base({
      type: "system", subtype: "api_error", level: "error", timestamp: at,
      error: { message: formatted, formatted, status: 529 }, retryInMs: 1000, retryAttempt: 1, maxRetries: 10
    }),
    stopHook: (at) => base({ type: "system", subtype: "stop_hook_summary", timestamp: at }),
    taskNotification: (taskId, at) => base({
      type: "user", timestamp: at, promptSource: "system", turnOrigin: "task_notification", origin: { kind: "task-notification" },
      message: { role: "user", content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>completed</status>\n</task-notification>` }
    }),
    peer: (text, at) => base({
      type: "user", timestamp: at, promptSource: "system", turnOrigin: "peer",
      origin: { kind: "peer", name: "remote-dev-d4", body: text },
      message: { role: "user", content: `Another Claude session sent a message:\n${text}` }
    }),
    meta: (text, at) => base({ type: "user", timestamp: at, isMeta: true, message: { role: "user", content: text } }),
    prLink: (repo, number, at) => ({
      type: "pr-link", sessionId: id, prNumber: number, prUrl: `https://github.com/${repo}/pull/${number}`, prRepository: repo, timestamp: at
    }),
    aiTitle: (title) => ({ type: "ai-title", aiTitle: title, sessionId: id }),
    customTitle: (title) => ({ type: "custom-title", customTitle: title, sessionId: id }),
    // Five finished exchanges so a thread clears the "too-short" filter.
    history: (startAgoMs) => {
      const out = [];
      for (let i = 0; i < 5; i += 1) {
        out.push(base({
          type: "user", timestamp: iso(startAgoMs - i * 2000), promptSource: "typed", origin: { kind: "human" },
          message: { role: "user", content: `step ${i}` }
        }));
        out.push(assistant([{ type: "text", text: `did step ${i}` }], iso(startAgoMs - i * 2000 - 1000), "end_turn"));
      }
      return out;
    }
  };
}

function writeTranscript(home, cwd, id, rows, mtimeMs) {
  const slug = cwd ? cwd.replace(/[/.]/g, "-") : "-nocwd";
  const dir = path.join(home, ".claude", "projects", slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

function writePeer(home, entry) {
  const dir = path.join(home, ".claude", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${entry.pid}.json`), JSON.stringify({
    kind: "interactive", peerProtocol: 1, messagingSocketPath: `/tmp/cc-socks/${entry.pid}.sock`, ...entry
  }));
}

const byId = (threads) => Object.fromEntries(threads.map((thread) => [thread.id, thread]));

test("idle thread carries PR links, title, texts, and git context", async (t) => {
  const home = makeHome(t);
  const cwd = "/Users/x/Dev/bbapp";
  const r = rowsFor("idle-1", cwd);
  const file = writeTranscript(home, cwd, "idle-1", [
    r.customTitle("Fix the upload link"),
    ...r.history(60 * MIN),
    r.prLink("buildbetter-app/buildbetter", 6800, iso(40 * MIN)),
    r.prompt("merge main and get CI green", iso(30 * MIN)),
    r.tool("Bash", "t1", { command: "git merge origin/main" }, iso(29 * MIN)),
    r.result("t1", "merged", iso(29 * MIN)),
    r.prLink("buildbetter-app/buildbetter", 6868, iso(28 * MIN)),
    r.text("CI is green on abc1234. PR is ready.", iso(27 * MIN)),
    r.stopHook(iso(27 * MIN)),
    r.aiTitle("Upload link fix")
  ], NOW - 27 * MIN);

  const [thread] = await listClaudeThreads(makeConfig(home), { now: NOW, isPidAlive: () => false });
  assert.equal(thread.key, "claude:idle-1");
  assert.equal(thread.kind, "claude");
  assert.equal(thread.claudeSessionId, "idle-1");
  assert.equal(thread.agentStatus, "idle");
  assert.equal(thread.title, "Fix the upload link");
  assert.equal(thread.cwd, cwd);
  assert.equal(thread.branch, "spencer/feature");
  assert.equal(thread.repo, "buildbetter-app/buildbetter");
  assert.deepEqual(thread.prRefs, ["buildbetter-app/buildbetter#6868", "buildbetter-app/buildbetter#6800"]);
  assert.equal(thread.lastAgentText, "CI is green on abc1234. PR is ready.");
  assert.equal(thread.lastAgentAt, iso(27 * MIN));
  assert.equal(thread.lastUserText, "merge main and get CI green");
  assert.equal(thread.lastUserAt, iso(30 * MIN));
  assert.equal(thread.lastActivityAt, iso(27 * MIN));
  assert.equal(thread.error, null);
  assert.deepEqual(thread.openTasks, []);
  assert.equal(thread.live, null);
  assert.equal(thread.writerLocked, false);
  assert.equal(thread.archived, false);
  assert.equal(thread.excluded, null);
  assert.equal(thread.workspace, null);
  assert.equal(thread.meta.file, file);
  assert.equal(thread.meta.model, "claude-opus-5-5");
  assert.equal(thread.meta.conductorHosted, false);
  assert.equal(thread.meta.turnStartedAt, iso(30 * MIN));
});

test("unfinished turns are running when recent and stalled when quiet", async (t) => {
  const home = makeHome(t);
  const cwd = "/Users/x/Dev/repo";
  for (const [id, agoMs] of [["run-1", 2 * MIN], ["stall-1", 40 * MIN]]) {
    const r = rowsFor(id, cwd);
    writeTranscript(home, cwd, id, [
      ...r.history(90 * MIN),
      r.prompt("keep going", iso(agoMs + MIN)),
      r.tool("Bash", "t1", { command: "gh pr checks 1 --watch" }, iso(agoMs))
    ], NOW - agoMs);
  }
  const threads = byId(await listClaudeThreads(makeConfig(home), { now: NOW, isPidAlive: () => false }));
  assert.equal(threads["run-1"].agentStatus, "running");
  assert.equal(threads["stall-1"].agentStatus, "stalled");
});

test("a busy live peer counts as running even when the file is quiet", async (t) => {
  const home = makeHome(t);
  const cwd = "/Users/x/Dev/repo";
  const r = rowsFor("busy-1", cwd);
  writeTranscript(home, cwd, "busy-1", [
    ...r.history(90 * MIN),
    r.prompt("watch CI", iso(41 * MIN)),
    r.tool("Bash", "t1", { command: "gh pr checks 1 --watch" }, iso(40 * MIN))
  ], NOW - 40 * MIN);
  writePeer(home, { pid: 4242, sessionId: "busy-1", cwd, name: "repo-4a", status: "busy", entrypoint: "cli", updatedAt: NOW });
  const [thread] = await listClaudeThreads(makeConfig(home), { now: NOW, isPidAlive: (pid) => pid === 4242 });
  assert.equal(thread.agentStatus, "running");
  assert.deepEqual(thread.live, { peerName: "repo-4a", pid: 4242, status: "busy" });
});

test("API error turns classify the infra error and reset time", async (t) => {
  const home = makeHome(t);
  const cwd = "/Users/x/Dev/repo";
  const r = rowsFor("limit-1", cwd);
  writeTranscript(home, cwd, "limit-1", [
    ...r.history(90 * MIN),
    r.prompt("continue", iso(20 * MIN)),
    r.apiError("You've hit your session limit · resets 12am (America/Los_Angeles)", iso(20 * MIN))
  ], NOW - 20 * MIN);
  const r2 = rowsFor("over-1", cwd);
  writeTranscript(home, cwd, "over-1", [
    ...r2.history(90 * MIN),
    r2.prompt("continue", iso(20 * MIN)),
    r2.apiError("API Error: 529 Overloaded. This is a server-side issue", iso(20 * MIN), "server_error", 529)
  ], NOW - 20 * MIN);

  const threads = byId(await listClaudeThreads(makeConfig(home), { now: NOW, isPidAlive: () => false }));
  const limited = threads["limit-1"];
  assert.equal(limited.agentStatus, "error");
  assert.equal(limited.error.kind, "session-limit");
  assert.ok(limited.error.resetAt, "reset time parsed");
  assert.match(limited.error.text, /session limit/);
  // The synthetic error text is not real agent output.
  assert.equal(limited.lastAgentText, "did step 4");
  assert.equal(threads["over-1"].error.kind, "overloaded");
});

test("a successful reply after an API error clears the error", async (t) => {
  const home = makeHome(t);
  const cwd = "/Users/x/Dev/repo";
  const r = rowsFor("recovered-1", cwd);
  writeTranscript(home, cwd, "recovered-1", [
    ...r.history(90 * MIN),
    r.apiError("API Error: 529 Overloaded", iso(30 * MIN), "server_error", 529),
    r.prompt("continue", iso(25 * MIN)),
    r.text("Back on it. Done.", iso(24 * MIN))
  ], NOW - 24 * MIN);
  const [thread] = await listClaudeThreads(makeConfig(home), { now: NOW, isPidAlive: () => false });
  assert.equal(thread.agentStatus, "idle");
  assert.equal(thread.error, null);
});

test("a stalled turn keeps the last retrying API error", async (t) => {
  const home = makeHome(t);
  const cwd = "/Users/x/Dev/repo";
  const r = rowsFor("retry-1", cwd);
  writeTranscript(home, cwd, "retry-1", [
    ...r.history(90 * MIN),
    r.prompt("continue", iso(40 * MIN)),
    r.sysApiError("Connection dropped (ECONNRESET)", iso(39 * MIN))
  ], NOW - 39 * MIN);
  const [thread] = await listClaudeThreads(makeConfig(home), { now: NOW, isPidAlive: () => false });
  assert.equal(thread.agentStatus, "stalled");
  assert.equal(thread.error.kind, "network");
});

test("an interrupted turn is aborted", async (t) => {
  const home = makeHome(t);
  const cwd = "/Users/x/Dev/repo";
  const r = rowsFor("abort-1", cwd);
  writeTranscript(home, cwd, "abort-1", [
    ...r.history(90 * MIN),
    r.prompt("run the tests", iso(30 * MIN)),
    r.tool("Bash", "t1", { command: "npm test" }, iso(29 * MIN)),
    r.prompt("[Request interrupted by user for tool use]", iso(28 * MIN), { origin: undefined })
  ], NOW - 28 * MIN);
  const [thread] = await listClaudeThreads(makeConfig(home), { now: NOW, isPidAlive: () => false });
  assert.equal(thread.agentStatus, "aborted");
  assert.equal(thread.meta.abortReason, "interrupted");
  assert.equal(thread.lastUserText, "run the tests");
});

test("an ended turn with an open background task on a live peer is waiting", async (t) => {
  const home = makeHome(t);
  const cwd = "/Users/x/Dev/repo";
  const r = rowsFor("wait-1", cwd);
  const rows = [
    ...r.history(90 * MIN),
    r.prompt("run bb-quick", iso(30 * MIN)),
    r.tool("Bash", "t1", { command: "bb-quick", description: "Run bb-quick on candidate", run_in_background: true }, iso(29 * MIN)),
    r.result("t1", "Command running in background with ID: bg1.", iso(29 * MIN), { backgroundTaskId: "bg1" }),
    r.tool("Bash", "t2", { command: "sleep 1", description: "Short wait", run_in_background: true }, iso(28 * MIN)),
    r.result("t2", "Command running in background with ID: bg2.", iso(28 * MIN), { backgroundTaskId: "bg2" }),
    r.text("bb-quick is running; I will report when it finishes.", iso(27 * MIN)),
    r.taskNotification("bg2", iso(26 * MIN)),
    r.text("Short wait done; bb-quick still running.", iso(25 * MIN))
  ];
  writeTranscript(home, cwd, "wait-1", rows, NOW - 25 * MIN);
  writePeer(home, { pid: 77, sessionId: "wait-1", cwd, name: "repo-77", status: "idle", entrypoint: "cli", updatedAt: NOW });

  const [live] = await listClaudeThreads(makeConfig(home), { now: NOW, isPidAlive: (pid) => pid === 77 });
  assert.equal(live.agentStatus, "waiting");
  assert.deepEqual(live.openTasks, [{ id: "bg1", description: "Run bb-quick on candidate", kind: "local_bash", startedAt: iso(29 * MIN) }]);
  // The task notification is not the owner typing.
  assert.equal(live.lastUserText, "run bb-quick");

  const [dead] = await listClaudeThreads(makeConfig(home), { now: NOW, isPidAlive: () => false });
  assert.equal(dead.agentStatus, "idle");
  assert.deepEqual(dead.openTasks, []);
});

test("queued notifications and TaskStop close background tasks", async (t) => {
  const home = makeHome(t);
  const cwd = "/Users/x/Dev/repo";
  const r = rowsFor("closed-1", cwd);
  const started = (n, at) => [
    r.tool("Bash", `t${n}`, { command: "x", description: `task ${n}`, run_in_background: true }, at),
    r.result(`t${n}`, `Command running in background with ID: bg${n}.`, at, { backgroundTaskId: `bg${n}` })
  ];
  const notice = (n) => `<task-notification>\n<task-id>bg${n}</task-id>\n<status>completed</status>\n</task-notification>`;
  writeTranscript(home, cwd, "closed-1", [
    ...r.history(90 * MIN),
    r.prompt("run the checks", iso(40 * MIN)),
    ...started(1, iso(39 * MIN)),
    ...started(2, iso(38 * MIN)),
    ...started(3, iso(37 * MIN)),
    ...started(4, iso(36 * MIN)),
    { type: "queue-operation", operation: "enqueue", timestamp: iso(35 * MIN), sessionId: "closed-1", content: notice(1) },
    { type: "attachment", timestamp: iso(34 * MIN), sessionId: "closed-1", cwd, attachment: { type: "queued_command", prompt: notice(2), commandMode: "task-notification" } },
    r.tool("TaskStop", "t9", { task_id: "bg3" }, iso(33 * MIN)),
    r.result("t9", "stopped", iso(33 * MIN)),
    r.text("Checks kicked off.", iso(32 * MIN))
  ], NOW - 32 * MIN);
  writePeer(home, { pid: 88, sessionId: "closed-1", cwd, name: "repo-88", status: "idle", entrypoint: "cli", updatedAt: NOW });
  const [thread] = await listClaudeThreads(makeConfig(home), { now: NOW, isPidAlive: (pid) => pid === 88 });
  assert.deepEqual(thread.openTasks.map((task) => task.id), ["bg4"]);
  assert.equal(thread.agentStatus, "waiting");
});

test("peer, meta, and command rows are not owner text", async (t) => {
  const home = makeHome(t);
  const cwd = "/Users/x/Dev/repo";
  const r = rowsFor("peer-1", cwd);
  writeTranscript(home, cwd, "peer-1", [
    ...r.history(90 * MIN),
    r.prompt("ship it", iso(50 * MIN)),
    r.text("Shipped.", iso(49 * MIN)),
    r.peer("BuildBot3 is back up", iso(20 * MIN)),
    r.meta("<local-command-caveat>Caveat: generated</local-command-caveat>", iso(19 * MIN)),
    r.prompt("<command-name>/login</command-name>", iso(18 * MIN)),
    r.text("Retrying bb-quick.", iso(17 * MIN)),
    r.prompt("[OpenAGI supervisor] Ready to merge?", iso(16 * MIN), { promptSource: "sdk", origin: undefined }),
    r.text("Not yet.", iso(15 * MIN))
  ], NOW - 15 * MIN);
  const [thread] = await listClaudeThreads(makeConfig(home), { now: NOW, isPidAlive: () => false });
  assert.equal(thread.lastUserText, "ship it");
  assert.equal(thread.lastUserAt, iso(50 * MIN));
  assert.equal(thread.lastAgentText, "Not yet.");
  assert.equal(thread.meta.turnStartedAt, iso(16 * MIN));
});

test("exclusions: sidechain, relay, tmp, self, too-short, no-repo", async (t) => {
  const home = makeHome(t);
  const repo = "/Users/x/Dev/repo";
  const config = makeConfig(home, { selfSessionIds: ["self-1"] });
  const cases = [
    ["side-1", repo, { sidechain: true }],
    ["relay-1", config.paths.relayCwd, {}],
    ["tmp-1", "/private/tmp/scratch", {}],
    ["self-1", repo, {}],
    ["nobranch-1", "/Users/x/notes", { branch: "" }]
  ];
  for (const [id, cwd, options] of cases) {
    const r = rowsFor(id, cwd, options);
    writeTranscript(home, cwd, id, [...r.history(30 * MIN)], NOW - 20 * MIN);
  }
  const short = rowsFor("short-1", repo);
  writeTranscript(home, repo, "short-1", [short.prompt("hi", iso(21 * MIN)), short.text("hello", iso(20 * MIN))], NOW - 20 * MIN);
  const noCwd = rowsFor("nocwd-1", undefined);
  writeTranscript(home, null, "nocwd-1", [...noCwd.history(30 * MIN)], NOW - 20 * MIN);

  const threads = byId(await listClaudeThreads(config, { now: NOW, isPidAlive: () => false }));
  assert.equal(threads["side-1"].excluded, "sidechain");
  assert.equal(threads["relay-1"].excluded, "relay");
  assert.equal(threads["tmp-1"].excluded, "tmp");
  assert.equal(threads["self-1"].excluded, "self");
  assert.equal(threads["short-1"].excluded, "too-short");
  assert.equal(threads["nobranch-1"].excluded, "no-repo");
  assert.equal(threads["nocwd-1"].excluded, "no-repo");
});

test("Conductor-hosted transcripts are flagged", async (t) => {
  const home = makeHome(t);
  for (const [id, cwd, entrypoint] of [
    ["c-1", "/Users/x/conductor/workspaces/openAGI/amman", "cli"],
    ["c-2", "/Users/x/Dev/bbapp/.conductor/madrid", "cli"],
    ["c-3", "/Volumes/Xtra/codex-worktrees/ab12/bbapp", "sdk-ts"],
    ["c-4", "/Users/x/Dev/repo", "cli"]
  ]) {
    const r = rowsFor(id, cwd, { entrypoint });
    writeTranscript(home, cwd, id, r.history(30 * MIN), NOW - 20 * MIN);
  }
  const threads = byId(await listClaudeThreads(makeConfig(home), { now: NOW, isPidAlive: () => false }));
  assert.equal(threads["c-1"].meta.conductorHosted, true);
  assert.equal(threads["c-2"].meta.conductorHosted, true);
  assert.equal(threads["c-3"].meta.conductorHosted, true);
  assert.equal(threads["c-3"].meta.entrypoint, "sdk-ts");
  assert.equal(threads["c-4"].meta.conductorHosted, false);
});

test("lookback and maxThreads keep only the newest recent transcripts", async (t) => {
  const home = makeHome(t);
  const cwd = "/Users/x/Dev/repo";
  const ages = { "new-1": 5 * MIN, "new-2": 10 * MIN, "new-3": 15 * MIN, "old-1": 50 * 60 * MIN };
  for (const [id, ago] of Object.entries(ages)) {
    const r = rowsFor(id, cwd);
    writeTranscript(home, cwd, id, r.history(ago + 20 * MIN), NOW - ago);
  }
  const all = await listClaudeThreads(makeConfig(home), { now: NOW, isPidAlive: () => false });
  assert.deepEqual(all.map((thread) => thread.id), ["new-1", "new-2", "new-3"]);
  const capped = await listClaudeThreads(makeConfig(home, { limits: { maxThreads: 2 } }), { now: NOW, isPidAlive: () => false });
  assert.deepEqual(capped.map((thread) => thread.id), ["new-1", "new-2"]);
});

test("only the tail is read and agent text is redacted and clamped", async (t) => {
  const home = makeHome(t);
  const cwd = "/Users/x/Dev/repo";
  const r = rowsFor("tail-1", cwd);
  const secret = "sk-ant-abcdefghijklmnopqrstuv";
  writeTranscript(home, cwd, "tail-1", [
    r.prLink("o/old", 1, iso(80 * MIN)),
    r.prompt("x".repeat(20_000), iso(79 * MIN)),
    ...r.history(60 * MIN),
    r.text(`token ${secret} ${"y".repeat(2000)}`, iso(20 * MIN))
  ], NOW - 20 * MIN);
  const [thread] = await listClaudeThreads(makeConfig(home), { now: NOW, isPidAlive: () => false, tailBytes: 8 * 1024 });
  assert.deepEqual(thread.prRefs, []);
  assert.doesNotMatch(thread.lastAgentText, /abcdefghijklmnop/);
  assert.ok(thread.lastAgentText.length <= 600);
});

test("missing or corrupt data degrades instead of throwing", async (t) => {
  const home = makeHome(t);
  assert.deepEqual(await listClaudeThreads(makeConfig(home), { now: NOW }), []);
  const cwd = "/Users/x/Dev/repo";
  const r = rowsFor("corrupt-1", cwd);
  const file = writeTranscript(home, cwd, "corrupt-1", r.history(30 * MIN), NOW - 20 * MIN);
  fs.appendFileSync(file, "{not json\n");
  fs.utimesSync(file, (NOW - 20 * MIN) / 1000, (NOW - 20 * MIN) / 1000);
  const [thread] = await listClaudeThreads(makeConfig(home), { now: NOW, isPidAlive: () => false });
  assert.equal(thread.agentStatus, "idle");
  assert.deepEqual(await listClaudeThreads(null), []);
});

test("readLivePeers keeps alive pids, skips key files, newest entry wins", (t) => {
  const home = makeHome(t);
  writePeer(home, { pid: 10, sessionId: "s-1", cwd: "/a", name: "a-10", status: "idle", entrypoint: "sdk-ts", updatedAt: 100 });
  writePeer(home, { pid: 11, sessionId: "s-1", cwd: "/a", name: "a-11", status: "busy", entrypoint: "sdk-ts", updatedAt: 200 });
  writePeer(home, { pid: 12, sessionId: "s-2", cwd: "/b", name: "b-12", status: "idle", entrypoint: "cli", updatedAt: 100 });
  writePeer(home, { pid: 13, sessionId: "s-3", cwd: "/c", name: "c-13", status: "waiting", entrypoint: "cli", waitingFor: "permission prompt", updatedAt: 100 });
  const dir = path.join(home, ".claude", "sessions");
  fs.writeFileSync(path.join(dir, "14.json"), "{broken");
  fs.writeFileSync(path.join(dir, "10.abcdef123456.key"), "SECRET");

  const peers = readLivePeers(makeConfig(home), { isPidAlive: (pid) => pid !== 12 });
  assert.deepEqual([...peers.keys()].sort(), ["s-1", "s-3"]);
  assert.deepEqual(peers.get("s-1"), { peerName: "a-11", pid: 11, status: "busy", cwd: "/a", entrypoint: "sdk-ts", waitingFor: null });
  assert.equal(peers.get("s-3").waitingFor, "permission prompt");
  assert.equal(readLivePeers(makeConfig(makeHome(t))).size, 0);
});
