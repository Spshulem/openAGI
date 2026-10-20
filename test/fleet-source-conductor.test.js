import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULTS, resolveFleetConfig, uiTargetFor } from "../src/fleet/contracts.js";
import { ASK_CLOSED_SQL, ASK_SQL, findManagerSession, listConductorThreads } from "../src/fleet/sources/conductor.js";
import { classifyThread } from "../src/fleet/classify.js";

const NOW = Date.parse("2026-09-26T08:00:00.000Z");
const MIN = 60_000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
// Conductor's updated_at trigger writes SQLite datetime('now'): UTC without a zone.
const sqliteTime = (msAgo) => iso(msAgo).replace("T", " ").slice(0, 19);

function makeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-conductor-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

// Real column names from conductor.db (subset the source reads).
function createDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE repos (id TEXT PRIMARY KEY, remote_url TEXT, name TEXT, default_branch TEXT DEFAULT 'main');
    CREATE TABLE workspaces (local_id TEXT PRIMARY KEY, repository_id TEXT, directory_name TEXT, active_session_id TEXT,
      branch TEXT, state TEXT DEFAULT 'active', derived_status TEXT DEFAULT 'in-progress', workspace_path TEXT, pr_title TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT DEFAULT 'idle', claude_session_id TEXT, unread_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), model TEXT,
      last_user_message_at TEXT, workspace_id TEXT, is_hidden INTEGER DEFAULT 0, agent_type TEXT, title TEXT DEFAULT 'Untitled');
    CREATE TABLE session_messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT, full_message TEXT, cancelled_at TEXT, model TEXT,
      sdk_message_id TEXT, last_assistant_message_id TEXT, turn_id TEXT, is_resumable_message INTEGER, queue_order INTEGER,
      sender_id TEXT, sender_session_id TEXT, sender_api_key_name TEXT);
    CREATE INDEX idx_session_messages_sent_at ON session_messages(session_id, sent_at);
  `);
  return db;
}

let messageSeq = 0;
function addMessage(db, sessionId, role, content, at, extra = {}) {
  messageSeq += 1;
  db.prepare(`INSERT INTO session_messages (id, session_id, role, content, created_at, sent_at, cancelled_at, sender_session_id, turn_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    `m-${messageSeq}`, sessionId, role, typeof content === "string" ? content : JSON.stringify(content),
    at, at, extra.cancelledAt ?? null, extra.senderSessionId ?? null, extra.turnId ?? null
  );
}

const sdk = {
  text: (sessionId, text, parent = null) => ({
    type: "assistant", uuid: `a-${messageSeq}`, session_id: sessionId, parent_tool_use_id: parent,
    message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }] }
  }),
  tool: (sessionId, name) => ({
    type: "assistant", session_id: sessionId, parent_tool_use_id: null,
    message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "toolu_1", name, input: {} }] }
  }),
  result: (sessionId, text, isError = false) => ({
    type: "result", subtype: "success", session_id: sessionId, is_error: isError, result: text, num_turns: 3, total_cost_usd: 1
  }),
  taskStarted: (sessionId, taskId, description) => ({
    type: "system", subtype: "task_started", session_id: sessionId, task_id: taskId, tool_use_id: `toolu_${taskId}`,
    description, task_type: "local_bash"
  }),
  taskNotification: (sessionId, taskId) => ({
    type: "system", subtype: "task_notification", session_id: sessionId, status: "completed", task_id: taskId
  }),
  error: (content) => ({ type: "error", content })
};

function seed(home) {
  const file = path.join(home, "Library", "Application Support", "com.conductor.app", "conductor.db");
  const db = createDb(file);
  db.exec(`INSERT INTO repos (id, remote_url, name) VALUES ('r1', 'https://github.com/buildbetter-app/buildbetter.git', 'bbapp'),
    ('r2', NULL, 'scratch')`);
  const workspace = db.prepare(`INSERT INTO workspaces (local_id, repository_id, directory_name, active_session_id, branch, state,
    derived_status, workspace_path, pr_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  workspace.run("w-madrid", "r1", "madrid", "s-run", "spencer/madrid", "ready", "in-progress", "/Users/x/Dev/bbapp/.conductor/madrid", "Madrid PR");
  workspace.run("w-sydney", "r1", "sydney", "s-wait", "spencer/sydney", "ready", "in-review", "/Users/x/Dev/bbapp/.conductor/sydney", null);
  workspace.run("w-cairo", "r1", "cairo", "s-idle", "spencer/cairo", "ready", "in-progress", "/Users/x/Dev/bbapp/.conductor/cairo", null);
  workspace.run("w-old", "r1", "archived-one", "s-arch", "spencer/old", "archived", "done", "/Users/x/Dev/bbapp/.conductor/old", null);
  workspace.run("w-remote", "r2", "remote-dev", "mgr-1", "spencer/remote-dev-restore", "ready", "in-progress", "/Users/x/conductor/workspaces/remote-dev-setup/remote-dev", null);

  const session = db.prepare(`INSERT INTO sessions (id, status, claude_session_id, updated_at, created_at, model, last_user_message_at,
    workspace_id, is_hidden, agent_type, title, unread_count) VALUES (?, ?, ?, ?, ?, 'opus-5-5-1m', ?, ?, ?, 'claude', ?, ?)`);
  session.run("s-run", "working", "s-run", sqliteTime(MIN), iso(600 * MIN), iso(10 * MIN), "w-madrid", 0, "Fix uploads", 0);
  session.run("s-wait", "waiting", "claude-wait", sqliteTime(20 * MIN), iso(600 * MIN), iso(40 * MIN), "w-sydney", 0, "Untitled", 1);
  session.run("s-limit", "idle", "s-limit", sqliteTime(30 * MIN), iso(600 * MIN), iso(35 * MIN), "w-sydney", 0, "Limit tab", 0);
  session.run("s-idle", "idle", "s-idle", iso(15 * MIN), iso(600 * MIN), iso(30 * MIN), "w-cairo", 0, "Cairo work", 0);
  session.run("s-err", "error", "s-err", sqliteTime(40 * MIN), iso(600 * MIN), null, "w-cairo", 0, "Broken tab", 0);
  session.run("s-abort", "idle", "s-abort", sqliteTime(45 * MIN), iso(600 * MIN), null, "w-cairo", 0, "Aborted tab", 0);
  session.run("s-self", "working", "s-self", sqliteTime(MIN), iso(600 * MIN), null, "w-madrid", 0, "Supervisor", 0);
  session.run("s-hidden", "idle", "s-hidden", sqliteTime(MIN), iso(600 * MIN), null, "w-madrid", 1, "Hidden", 0);
  session.run("s-arch", "idle", "s-arch", sqliteTime(MIN), iso(600 * MIN), null, "w-old", 0, "Archived", 0);
  session.run("s-stale", "idle", "s-stale", sqliteTime(72 * 60 * MIN), iso(80 * 60 * MIN), null, "w-cairo", 0, "Stale", 0);
  session.run("mgr-1", "idle", "mgr-claude", sqliteTime(72 * 60 * MIN), iso(80 * 60 * MIN), null, "w-remote", 0, "Remote dev setup", 0);

  addMessage(db, "s-run", "user", "keep going", iso(10 * MIN));
  addMessage(db, "s-run", "assistant", sdk.tool("s-run", "Bash"), iso(2 * MIN));

  addMessage(db, "s-wait", "user", "run bb-quick", iso(40 * MIN));
  addMessage(db, "s-wait", "assistant", sdk.taskStarted("s-wait", "done-1", "Lint"), iso(35 * MIN));
  addMessage(db, "s-wait", "assistant", sdk.taskNotification("s-wait", "done-1"), iso(34 * MIN));
  addMessage(db, "s-wait", "assistant", sdk.taskStarted("s-wait", "open-1", "Run bb-quick on fixed candidate"), iso(23 * MIN));
  addMessage(db, "s-wait", "assistant", sdk.text("s-wait", "bb-quick is running."), iso(22 * MIN));
  addMessage(db, "s-wait", "assistant", sdk.result("s-wait", "bb-quick is running."), iso(21 * MIN));

  addMessage(db, "s-limit", "user", "continue", iso(35 * MIN));
  addMessage(db, "s-limit", "assistant", sdk.text("s-limit", "Working on it"), iso(34 * MIN));
  addMessage(db, "s-limit", "assistant", sdk.result("s-limit", "You've hit your session limit · resets 12am (America/Los_Angeles)", true), iso(30 * MIN));

  addMessage(db, "s-idle", "user", "get it green", iso(30 * MIN));
  addMessage(db, "s-idle", "assistant", { type: "system", subtype: "init", session_id: "s-idle" }, iso(29 * MIN));
  addMessage(db, "s-idle", "assistant", sdk.text("s-idle", "CI green on abc1234."), iso(20 * MIN));
  addMessage(db, "s-idle", "assistant", sdk.text("s-idle", "subagent chatter", "toolu_sub"), iso(19 * MIN));
  addMessage(db, "s-idle", "assistant", sdk.result("s-idle", "CI green on abc1234."), iso(18 * MIN));
  addMessage(db, "s-idle", "user", "never sent", iso(17 * MIN), { cancelledAt: iso(17 * MIN) });
  addMessage(db, "s-idle", "user", "peer relay text", iso(16 * MIN), { senderSessionId: "other" });
  addMessage(db, "s-idle", "user", "[OpenAGI supervisor] Ready to merge?", iso(16 * MIN));
  addMessage(db, "s-idle", "assistant", "not json {", iso(16 * MIN));

  addMessage(db, "s-err", "assistant", sdk.error("Claude Code returned an error result: No conversation found with session ID: s-err"), iso(40 * MIN));
  addMessage(db, "s-abort", "assistant", sdk.text("s-abort", "Starting"), iso(46 * MIN));
  addMessage(db, "s-abort", "assistant", sdk.error("aborted by user"), iso(45 * MIN));
  db.close();
  return file;
}

function writePeer(home, entry) {
  const dir = path.join(home, ".claude", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${entry.pid}.json`), JSON.stringify(entry));
}

function makeConfig(home, overrides = {}) {
  return resolveFleetConfig({}, { home, managerRef: "mgr-1", selfSessionIds: ["s-self"], ...overrides });
}

const byId = (threads) => Object.fromEntries(threads.map((thread) => [thread.id, thread]));

test("a failed message query makes the Conductor source unknown", async (t) => {
  const home = makeHome(t);
  const file = seed(home);
  const db = new DatabaseSync(file);
  db.exec("ALTER TABLE session_messages RENAME COLUMN sender_api_key_name TO older_schema_name");
  db.close();
  await assert.rejects(listConductorThreads(makeConfig(home), { now: NOW, peers: new Map() }), /sender_api_key_name/);
});

test("lists in-scope Conductor sessions with normalized status and context", async (t) => {
  const home = makeHome(t);
  seed(home);
  writePeer(home, { pid: 501, sessionId: "claude-wait", cwd: "/Users/x/Dev/bbapp/.conductor/sydney", name: "sydney-5a", status: "idle", entrypoint: "sdk-ts", updatedAt: NOW });
  const threads = byId(await listConductorThreads(makeConfig(home), { now: NOW, isPidAlive: (pid) => pid === 501 }));

  assert.deepEqual(Object.keys(threads).sort(), ["mgr-1", "s-abort", "s-err", "s-idle", "s-limit", "s-run", "s-self", "s-wait"]);

  const run = threads["s-run"];
  assert.equal(run.key, "conductor:s-run");
  assert.equal(run.kind, "conductor");
  assert.equal(run.agentStatus, "running");
  assert.equal(run.claudeSessionId, "s-run");
  assert.equal(run.workspace, "madrid");
  assert.equal(run.cwd, "/Users/x/Dev/bbapp/.conductor/madrid");
  assert.equal(run.branch, "spencer/madrid");
  // repos.remote_url is null or wrong for some real repos, so repo comes from local git later.
  assert.equal(run.repo, null);
  assert.equal(run.meta.dbRemote, "buildbetter-app/buildbetter");
  assert.equal(run.title, "Fix uploads");
  assert.equal(run.lastUserText, "keep going");
  assert.equal(run.lastUserAt, iso(10 * MIN));
  // The last turn row, not sessions.updated_at.
  assert.equal(run.lastActivityAt, iso(2 * MIN));
  assert.equal(run.excluded, null);
  assert.equal(run.live, null);
  assert.equal(run.meta.derivedStatus, "in-progress");
  assert.equal(run.meta.conductorStatus, "working");

  const wait = threads["s-wait"];
  assert.equal(wait.agentStatus, "waiting");
  assert.equal(wait.claudeSessionId, "claude-wait");
  assert.equal(wait.title, "sydney");
  assert.deepEqual(wait.openTasks, [{ id: "open-1", description: "Run bb-quick on fixed candidate", kind: "local_bash", startedAt: iso(23 * MIN) }]);
  assert.deepEqual(wait.live, { peerName: "sydney-5a", pid: 501, status: "idle" });
  assert.equal(wait.meta.unreadCount, 1);
  assert.equal(wait.lastActivityAt, iso(21 * MIN));

  const limited = threads["s-limit"];
  assert.equal(limited.agentStatus, "error");
  assert.equal(limited.error.kind, "session-limit");
  assert.ok(limited.error.resetAt);
  assert.equal(limited.lastAgentText, "Working on it");

  const idle = threads["s-idle"];
  assert.equal(idle.agentStatus, "idle");
  assert.equal(idle.error, null);
  assert.equal(idle.lastAgentText, "CI green on abc1234.");
  assert.equal(idle.lastAgentAt, iso(20 * MIN));
  assert.equal(idle.lastUserText, "get it green");
  assert.equal(idle.lastUserAt, iso(30 * MIN));
  // The supervisor's message is not the owner's; it is stamped on its own.
  assert.equal(idle.meta.lastSupervisorAt, iso(16 * MIN));
  assert.equal(idle.meta.turnStartedAt, iso(29 * MIN));
  assert.deepEqual(idle.openTasks, []);

  const errored = threads["s-err"];
  assert.equal(errored.agentStatus, "error");
  assert.equal(errored.error.kind, "other");
  assert.match(errored.error.text, /No conversation found/);

  const aborted = threads["s-abort"];
  assert.equal(aborted.agentStatus, "aborted");
  assert.equal(aborted.meta.abortReason, "aborted by user");
  assert.equal(aborted.meta.lastSupervisorAt, null);
  assert.equal(aborted.error, null);

  assert.equal(threads["s-self"].excluded, "self");
  // No turn rows: updated_at stands in. SQLite datetime('now') is UTC even without a zone suffix.
  assert.equal(threads["s-self"].lastActivityAt, iso(MIN));
  // The manager stays visible for escalation even when it is outside the lookback.
  assert.equal(threads["mgr-1"].excluded, "stale");
  assert.equal(threads["mgr-1"].meta.dbRemote, null);
});

test("maxThreads keeps the newest sessions", async (t) => {
  const home = makeHome(t);
  seed(home);
  const threads = await listConductorThreads(makeConfig(home, { managerRef: "none", limits: { maxThreads: 2 } }), { now: NOW, isPidAlive: () => false });
  assert.deepEqual(threads.map((thread) => thread.id), ["s-run", "s-self"]);
});

test("an older live approval card survives maxThreads until answered", async (t) => {
  const home = makeHome(t);
  const file = seed(home);
  const db = new DatabaseSync(file);
  db.prepare("UPDATE sessions SET status = 'working' WHERE id = 's-idle'").run();
  addMessage(db, "s-idle", "assistant", {
    type: "assistant", session_id: "s-idle", parent_tool_use_id: null,
    message: { role: "assistant", content: [{ type: "tool_use", id: "older-card", name: "mcp__conductor__AskUserQuestion", input: {
      questions: [{ question: "Which implementation?", options: ["A", "B"] }]
    } }] }
  }, iso(5 * MIN));
  db.close();
  const config = makeConfig(home, { managerRef: "none", limits: { maxThreads: 2 } });
  const read = () => listConductorThreads(config, { now: NOW, peers: new Map() });
  const threads = await read();
  assert.deepEqual(threads.map((thread) => thread.id), ["s-run", "s-self", "s-idle"]);
  assert.equal(threads[2].meta.pendingCard.cardId, "older-card");
  assert.equal(classifyThread(threads[2], { now: NOW, config }).state, "needs-human");
  const managers = await listConductorThreads(makeConfig(home, { managerRef: "s-idle", limits: { maxThreads: 2 } }), { now: NOW, peers: new Map() });
  const manager = managers.find((thread) => thread.id === "s-idle");
  assert.equal(manager.excluded, null, "a live manager card inside lookback is promoted past the cap");
  assert.equal(classifyThread(manager, { now: NOW, config }).state, "needs-human");
  assert.equal(managers.filter((thread) => thread.id === "s-idle").length, 1);

  const answer = new DatabaseSync(file);
  addMessage(answer, "s-idle", "assistant", { type: "user", session_id: "s-idle", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "older-card", content: "A" }
  ] } }, iso(MIN));
  answer.close();
  assert.deepEqual((await read()).map((thread) => thread.id), ["s-run", "s-self"]);
  const explicit = await listConductorThreads(config, { now: NOW, peers: new Map(), only: ["s-idle"] });
  assert.deepEqual(explicit.map((thread) => thread.id), ["s-idle"]);
});

test("overflow acknowledgements do not bypass the catalog cap", async (t) => {
  const home = makeHome(t);
  const file = seed(home);
  const db = new DatabaseSync(file);
  db.prepare("UPDATE sessions SET status = 'working' WHERE id = 's-idle'").run();
  addMessage(db, "s-idle", "assistant", {
    type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "ack-card", name: "AskUserQuestion", input: {
      questions: [{ question: "Continue?", options: ["Okay"] }]
    } }] }
  }, iso(5 * MIN));
  db.close();
  const threads = await listConductorThreads(makeConfig(home, { managerRef: "none", limits: { maxThreads: 2 } }), { now: NOW, peers: new Map() });
  assert.deepEqual(threads.map((thread) => thread.id), ["s-run", "s-self"]);
});

test("a missing database is an empty list; a broken one throws", async (t) => {
  const home = makeHome(t);
  assert.deepEqual(await listConductorThreads(makeConfig(home), { now: NOW }), []);
  const bad = path.join(home, "bad.db");
  fs.writeFileSync(bad, "not a database");
  // Unreadable is unknown, not empty: the supervisor records a source error.
  await assert.rejects(listConductorThreads(makeConfig(home, { paths: { conductorDb: bad } }), { now: NOW }));
  assert.deepEqual(await listConductorThreads(null), []);
});

test("findManagerSession matches id, Claude session id, or workspace name", () => {
  const thread = (id, extra = {}) => ({
    key: `conductor:${id}`, kind: "conductor", id, claudeSessionId: id, workspace: "cairo", live: null,
    lastActivityAt: iso(60 * MIN), ...extra
  });
  const threads = [
    thread("a"),
    thread("b", { claudeSessionId: "claude-b" }),
    thread("r1", { workspace: "remote-dev", lastActivityAt: iso(5 * MIN) }),
    thread("r2", { workspace: "remote-dev", lastActivityAt: iso(50 * MIN), live: { peerName: "remote-dev-d4", pid: 1, status: "idle" } }),
    thread("r3", { workspace: "remote-dev", lastActivityAt: iso(1 * MIN) }),
    { ...thread("00000000-0000-4000-8000-000000000001"), kind: "claude", key: "claude:00000000-0000-4000-8000-000000000001" },
    thread("00000000-0000-4000-8000-000000000001")
  ];
  const find = (managerRef) => findManagerSession(resolveFleetConfig({}, { home: "/h", managerRef }), threads);
  assert.equal(find("a").id, "a");
  assert.equal(find("claude-b").id, "b");
  // A live tab wins over a newer offline one.
  assert.equal(find("remote-dev").id, "r2");
  assert.equal(find("00000000").kind, "conductor");
  assert.equal(find("missing"), null);
  assert.equal(findManagerSession(resolveFleetConfig({}, { home: "/h", managerRef: "" }), threads), null);
  assert.equal(find("0056"), null, "short prefixes never match");
  assert.equal(findManagerSession(null, threads), null);
  assert.equal(findManagerSession(resolveFleetConfig({}, { home: "/h", managerRef: "a" }), null), null);
});

test("open tasks count only while their Claude process is alive and started after them", async (t) => {
  const home = makeHome(t);
  const file = seed(home);
  const db = new DatabaseSync(file);
  // Started before the current process: killed with the old one, never notified.
  addMessage(db, "s-wait", "assistant", sdk.taskStarted("s-wait", "dead-1", "bb-verify --full"), iso(50 * MIN));
  db.close();
  // ps lstart (UTC) says the process restarted 30 min ago.
  writePeer(home, {
    pid: 601, sessionId: "claude-wait", name: "sydney-6a", status: "idle", entrypoint: "sdk-ts", updatedAt: NOW,
    startedAt: NOW - 30 * MIN + 3000, procStart: "Sat Sep 26 07:30:00 2026"
  });
  const live = byId(await listConductorThreads(makeConfig(home), { now: NOW, isPidAlive: (pid) => pid === 601 }));
  assert.deepEqual(live["s-wait"].openTasks.map((task) => task.id), ["open-1"]);

  // No live process: no background task can still be running.
  const dead = byId(await listConductorThreads(makeConfig(home), { now: NOW, isPidAlive: () => false }));
  assert.deepEqual(dead["s-wait"].openTasks, []);
  assert.equal(dead["s-wait"].agentStatus, "waiting");
});

test("zoneless message times read as UTC on a non-UTC machine", async (t) => {
  const tz = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  t.after(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; });
  const home = makeHome(t);
  const file = seed(home);
  const db = new DatabaseSync(file);
  // Older Conductor builds left created_at to datetime('now'): UTC, no zone.
  db.prepare(`INSERT INTO session_messages (id, session_id, role, content, created_at, sent_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("m-tz-user", "s-idle", "user", "one more thing", sqliteTime(5 * MIN), iso(5 * MIN));
  db.prepare(`INSERT INTO session_messages (id, session_id, role, content, created_at, sent_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("m-tz-task", "s-wait", "assistant", JSON.stringify(sdk.taskStarted("s-wait", "tz-1", "bb-quick again")), sqliteTime(4 * MIN), iso(4 * MIN));
  db.close();
  writePeer(home, { pid: 701, sessionId: "claude-wait", name: "sydney-7a", status: "idle", entrypoint: "sdk-ts", updatedAt: NOW });
  const threads = byId(await listConductorThreads(makeConfig(home), { now: NOW, isPidAlive: (pid) => pid === 701 }));
  assert.equal(threads["s-idle"].lastUserAt, iso(5 * MIN));
  assert.equal(threads["s-wait"].openTasks.find((task) => task.id === "tz-1")?.startedAt, iso(4 * MIN));
});

test("a broadcast row or updated_at bump does not make an idle tab look active", async (t) => {
  const home = makeHome(t);
  const file = seed(home);
  const db = new DatabaseSync(file);
  addMessage(db, "s-idle", "assistant", { type: "system", subtype: "commands_changed", session_id: "s-idle" }, iso(2 * MIN));
  db.prepare("UPDATE sessions SET updated_at = ? WHERE id = 's-idle'").run(sqliteTime(2 * MIN));
  db.close();
  const threads = byId(await listConductorThreads(makeConfig(home), { now: NOW, peers: new Map() }));
  assert.equal(threads["s-idle"].lastActivityAt, iso(16 * MIN));
});

test("an aborted session exposes when the owner stopped it", async (t) => {
  const home = makeHome(t);
  seed(home);
  const threads = byId(await listConductorThreads(makeConfig(home), { now: NOW, isPidAlive: () => false }));
  assert.equal(threads["s-abort"].meta.abortedAt, iso(45 * MIN));
  assert.equal(threads["s-idle"].meta.abortedAt, null);
});

test("a working tab silent past silentTurnMs is stalled, or waiting when it owns live tasks", async (t) => {
  const home = makeHome(t);
  const file = seed(home);
  // s-run's last turn row is 2 min before NOW; s-self has no turn rows at all.
  const later = NOW + DEFAULTS.silentTurnMs;
  const threads = byId(await listConductorThreads(makeConfig(home), { now: later - 5 * MIN, peers: new Map() }));
  assert.equal(threads["s-run"].agentStatus, "running");
  const silent = byId(await listConductorThreads(makeConfig(home), { now: later, peers: new Map() }));
  assert.equal(silent["s-run"].agentStatus, "stalled");
  assert.equal(silent["s-run"].meta.conductorStatus, "working");
  assert.equal(silent["s-self"].agentStatus, "running");
  // A background task the live process still owns makes it a wait on that task.
  const db = new DatabaseSync(file);
  addMessage(db, "s-run", "assistant", sdk.taskStarted("s-run", "bbq-1", "Wait for bb-quick"), iso(3 * MIN));
  db.close();
  writePeer(home, { pid: 801, sessionId: "s-run", name: "madrid-8a", status: "idle", entrypoint: "sdk-ts", updatedAt: NOW });
  const tasks = byId(await listConductorThreads(makeConfig(home), { now: later, isPidAlive: (pid) => pid === 801 }));
  assert.equal(tasks["s-run"].agentStatus, "waiting");
  assert.equal(tasks["s-run"].openTasks[0]?.id, "bbq-1");
});

test("a live peer on a permission prompt is waiting on the owner", async (t) => {
  const home = makeHome(t);
  seed(home);
  writePeer(home, { pid: 701, sessionId: "s-run", name: "madrid-7a", status: "waiting", waitingFor: "permission prompt", entrypoint: "sdk-ts", updatedAt: NOW });
  writePeer(home, { pid: 702, sessionId: "s-idle", name: "cairo-7b", status: "idle", entrypoint: "sdk-ts", updatedAt: NOW });
  const threads = byId(await listConductorThreads(makeConfig(home), { now: NOW, isPidAlive: (pid) => pid > 700 }));
  assert.equal(threads["s-run"].agentStatus, "waiting");
  assert.equal(threads["s-run"].meta.blockedOnOwner, true);
  assert.equal(threads["s-run"].meta.waitingFor, "permission prompt");
  assert.equal(threads["s-idle"].agentStatus, "idle");
  assert.equal(threads["s-idle"].meta.blockedOnOwner, false);
});

test("sessions carry the workspace id, tab title, and tab count the app deep link and UI check need", async (t) => {
  const home = makeHome(t);
  seed(home);
  const threads = byId(await listConductorThreads(makeConfig(home), { now: NOW, peers: new Map() }));
  const run = threads["s-run"];
  assert.equal(run.meta.conductorWorkspaceId, "w-madrid");
  assert.equal(run.meta.conductorSessionId, "s-run");
  assert.equal(run.meta.conductorSessionTitle, "Fix uploads");
  // s-self shares the workspace; s-hidden is hidden and does not count.
  assert.equal(run.meta.conductorWorkspaceSessions, 2);
  assert.equal(run.meta.conductorTitleShared, false);
  assert.equal(threads["s-wait"].meta.conductorSessionTitle, null, "Untitled is no title");
  assert.equal(threads["s-idle"].meta.conductorWorkspaceSessions, 4);
  assert.equal(threads["mgr-1"].meta.conductorWorkspaceSessions, 1);
  const target = uiTargetFor(run);
  assert.equal(target.deepLink, "conductor://workspace?id=w-madrid&session=s-run");
  assert.equal(target.title, "Fix uploads");
  assert.equal(target.sessionCount, 2);
});

test("two tabs with one title in a workspace are flagged as shared", async (t) => {
  const home = makeHome(t);
  const file = seed(home);
  const db = new DatabaseSync(file);
  db.prepare("UPDATE sessions SET title = 'Cairo work' WHERE id = 's-err'").run();
  db.close();
  const threads = byId(await listConductorThreads(makeConfig(home), { now: NOW, peers: new Map() }));
  assert.equal(threads["s-idle"].meta.conductorTitleShared, true);
  assert.equal(threads["s-abort"].meta.conductorTitleShared, false);
});

test("a pending AskUserQuestion is the owner's question; its answer clears it", async (t) => {
  const home = makeHome(t);
  const file = seed(home);
  const db = new DatabaseSync(file);
  // Real shape from conductor.db (2026-09-28): the pick is a tool call.
  const ask = (id) => ({
    type: "assistant", session_id: "s-idle", parent_tool_use_id: null,
    message: { role: "assistant", model: "claude-opus-5-5", content: [
      { type: "text", text: "Here is the plan." },
      { type: "tool_use", id, name: "mcp__conductor__AskUserQuestion", input: { questions: [{ header: "Split plan", question: "Split into two PRs. Go?", options: ["Go", { label: "Change it" }] }] } }
    ] }
  });
  // The card blocks the turn: the session reads "working".
  db.prepare("UPDATE sessions SET status = 'working' WHERE id = 's-idle'").run();
  addMessage(db, "s-idle", "assistant", ask("toolu_ask1"), iso(5 * MIN));
  db.close();
  let threads = byId(await listConductorThreads(makeConfig(home), { now: NOW }));
  assert.deepEqual(threads["s-idle"].meta.pendingQuestion, { text: "Split into two PRs. Go? (Go / Change it)", options: [], at: iso(5 * MIN) });

  const again = new DatabaseSync(file);
  addMessage(again, "s-idle", "assistant", { type: "user", session_id: "s-idle", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_ask1", content: "Go" }] } }, iso(3 * MIN));
  again.close();
  threads = byId(await listConductorThreads(makeConfig(home), { now: NOW }));
  assert.equal(threads["s-idle"].meta.pendingQuestion, null);

  // Unanswered, then a new turn starts (brussels #7394): the agent moved on.
  const later = new DatabaseSync(file);
  addMessage(later, "s-idle", "assistant", ask("toolu_ask2"), iso(2 * MIN));
  later.close();
  threads = byId(await listConductorThreads(makeConfig(home), { now: NOW }));
  assert.ok(threads["s-idle"].meta.pendingQuestion, "asked again");
  const moved = new DatabaseSync(file);
  addMessage(moved, "s-idle", "assistant", { type: "system", subtype: "init", session_id: "s-idle" }, iso(1 * MIN));
  moved.close();
  threads = byId(await listConductorThreads(makeConfig(home), { now: NOW }));
  assert.equal(threads["s-idle"].meta.pendingQuestion, null);

  // An idle session's last row is an unanswered ask and no process is alive
  // (600a2afc): the card died with its process, so the session reads stopped.
  const idle = new DatabaseSync(file);
  addMessage(idle, "s-idle", "assistant", ask("toolu_ask3"), iso(0.5 * MIN));
  idle.prepare("UPDATE sessions SET status = 'idle' WHERE id = 's-idle'").run();
  idle.close();
  threads = byId(await listConductorThreads(makeConfig(home), { now: NOW, peers: new Map() }));
  assert.equal(threads["s-idle"].meta.pendingQuestion, null);
  assert.equal(threads["s-idle"].meta.pendingCard, null);
  // A nudge resumes it; no owner card asks for a pick nobody can make.
  assert.equal(classifyThread(threads["s-idle"], { now: NOW, config: makeConfig(home) }).state, "idle-no-pr");
  // A process restarted after the call is not the one that asked.
  const restarted = new Map([["s-idle", { peerName: "cairo", pid: 901, status: "idle", waitingFor: null, startedAt: iso(0.4 * MIN) }]]);
  threads = byId(await listConductorThreads(makeConfig(home), { now: NOW, peers: restarted }));
  assert.equal(threads["s-idle"].meta.pendingCard, null);

  // Older Conductor reports an AskUserQuestion wait as idle: while the
  // process that asked lives, the unanswered call still holds the card.
  writePeer(home, { pid: 901, sessionId: "s-idle", name: "cairo", status: "idle", updatedAt: NOW, startedAt: NOW - 10 * MIN });
  const alive = { now: NOW, isPidAlive: (pid) => pid === 901 };
  threads = byId(await listConductorThreads(makeConfig(home), alive));
  assert.equal(threads["s-idle"].meta.pendingCard?.cardId, "toolu_ask3");
  assert.equal(threads["s-idle"].meta.pendingQuestion?.text, "Split into two PRs. Go? (Go / Change it)");
  assert.equal(classifyThread(threads["s-idle"], { now: NOW, config: makeConfig(home) }).state, "needs-human");
  // Its answer closes it, idle or not.
  const answered = new DatabaseSync(file);
  addMessage(answered, "s-idle", "assistant", { type: "user", session_id: "s-idle", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_ask3", content: "Go" }] } }, iso(0.2 * MIN));
  answered.close();
  threads = byId(await listConductorThreads(makeConfig(home), alive));
  assert.equal(threads["s-idle"].meta.pendingCard, null);
  // An errored session lost its card, whatever its rows say.
  const errored = new DatabaseSync(file);
  addMessage(errored, "s-idle", "assistant", ask("toolu_ask4"), iso(0.1 * MIN));
  errored.prepare("UPDATE sessions SET status = 'error' WHERE id = 's-idle'").run();
  errored.close();
  threads = byId(await listConductorThreads(makeConfig(home), { now: NOW }));
  assert.equal(threads["s-idle"].meta.pendingCard, null);
});

// Real shape (session 587635ca, 2026-10-11 17:46:39): the card blocks the
// tool call, so the session reads "working" and background subagent rows
// keep arriving for 17 minutes, none of them a new turn.
const CARD_TURN = "760c3717-c66f-475f-a149-3784389cafa8";
const cardCall = (id) => ({
  type: "assistant", uuid: "8d52a022", parent_tool_use_id: null, session_id: "s-run",
  message: { role: "assistant", model: "claude-opus-5-5", content: [{
    type: "tool_use", id, name: "mcp__conductor__AskUserQuestion", input: { questions: [
      { header: "End-of-day count", question: "As a rep, I want the end-of-day message to show how many items still need me, so it matches the inbox. Where should that count be built?", multiSelect: false, options: [
        { label: "Chat-analysis worker (Recommended)", description: "Build it where the inbox already runs." },
        { label: "Sales worker + inbox module", description: "Add the inbox module to the sales worker." },
        { label: "Work-queue only", description: "Count only the work queue." }
      ] },
      { header: "Bob's day", question: "What should Bob's end-of-day message cover?", multiSelect: false, options: [
        { label: "Did + doing next (Recommended)", description: "Both halves." },
        { label: "Only what he did", description: "A recap." },
        { label: "Only what's next", description: "A plan." }
      ] }
    ] }
  }] }
});
const subagentRow = (i) => ({ ...sdk.text("s-run", `subagent step ${i}`, "toolu_bg"), parent_tool_use_id: "toolu_bg" });

function seedCard(home, { subagentRows = 60 } = {}) {
  const file = seed(home);
  const db = new DatabaseSync(file);
  addMessage(db, "s-run", "user", "build M3", iso(1.99 * MIN), { turnId: CARD_TURN });
  addMessage(db, "s-run", "assistant", { type: "system", subtype: "init", session_id: "s-run" }, iso(1.98 * MIN), { turnId: CARD_TURN });
  addMessage(db, "s-run", "assistant", sdk.text("s-run", "M3 is built through 3.9. Two questions for you:"), iso(1.97 * MIN), { turnId: CARD_TURN });
  addMessage(db, "s-run", "assistant", cardCall("toolu_card"), iso(1.96 * MIN), { turnId: CARD_TURN });
  for (let i = 0; i < subagentRows; i += 1) addMessage(db, "s-run", "assistant", subagentRow(i), new Date(NOW - 1.9 * MIN + i * 100).toISOString(), { turnId: CARD_TURN });
  db.close();
  return file;
}

test("an open Conductor question card is read item by item while the session works", async (t) => {
  const home = makeHome(t);
  const file = seedCard(home);
  const config = makeConfig(home);
  let threads = byId(await listConductorThreads(config, { now: NOW, peers: new Map() }));
  const thread = threads["s-run"];
  assert.equal(thread.agentStatus, "running");
  const card = thread.meta.pendingCard;
  assert.equal(card.app, "conductor");
  assert.equal(card.cardId, "toolu_card");
  assert.equal(card.at, iso(1.96 * MIN));
  assert.deepEqual(card.items.map((item) => item.header), ["End-of-day count", "Bob's day"]);
  assert.deepEqual(card.items[0].options, ["Chat-analysis worker (Recommended)", "Sales worker + inbox module", "Work-queue only"]);
  assert.deepEqual(card.items[1].options, ["Did + doing next (Recommended)", "Only what he did", "Only what's next"]);
  assert.equal(card.items[1].question, "What should Bob's end-of-day message cover?");
  assert.deepEqual(card.items.map((item) => [item.index, item.freeText, item.multiSelect]), [[0, true, false], [1, true, false]]);
  // Item 0 alone stays the back-compat pendingQuestion.
  assert.match(thread.meta.pendingQuestion.text, /^As a rep.*\(Chat-analysis worker \(Recommended\) \/ Sales worker/);
  assert.doesNotMatch(thread.meta.pendingQuestion.text, /Bob/);
  // A working session with a card waits on the owner, not "running".
  const classified = classifyThread(thread, { now: NOW, config });
  assert.equal(classified.state, "needs-human");
  assert.equal(classified.ask.card.cardId, "toolu_card");

  // The owner's pick lands as the tool_result: the card is gone.
  const db = new DatabaseSync(file);
  addMessage(db, "s-run", "assistant", { type: "user", parent_tool_use_id: null, session_id: "s-run", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_card", content: [{ type: "text", text: "User responses:\n1. put this in a loop (free text)\n2. Did + doing next (Recommended)" }] }] } }, iso(0.1 * MIN), { turnId: CARD_TURN });
  db.close();
  threads = byId(await listConductorThreads(config, { now: NOW, peers: new Map() }));
  assert.equal(threads["s-run"].meta.pendingCard, null);
  assert.equal(threads["s-run"].meta.pendingQuestion, null);
});

test("a card pushed out of the tail by subagent rows is still read, until its answer or a new turn", async (t) => {
  const home = makeHome(t);
  const file = seedCard(home, { subagentRows: 450 });
  const config = makeConfig(home);
  let thread = byId(await listConductorThreads(config, { now: NOW, peers: new Map() }))["s-run"];
  assert.equal(thread.meta.pendingCard?.cardId, "toolu_card");
  assert.equal(thread.meta.pendingCard.items.length, 2);

  // Aborted: the next turn's init closes it, though the tool_result never came.
  let db = new DatabaseSync(file);
  addMessage(db, "s-run", "assistant", { type: "system", subtype: "init", session_id: "s-run" }, iso(0.5 * MIN), { turnId: CARD_TURN });
  for (let i = 0; i < 420; i += 1) addMessage(db, "s-run", "assistant", subagentRow(i), new Date(NOW - 0.4 * MIN + i).toISOString(), { turnId: CARD_TURN });
  db.close();
  thread = byId(await listConductorThreads(config, { now: NOW, peers: new Map() }))["s-run"];
  assert.equal(thread.meta.pendingCard, null);

  // Answered out of the tail.
  const other = makeHome(t);
  const answered = seedCard(other, { subagentRows: 450 });
  db = new DatabaseSync(answered);
  addMessage(db, "s-run", "assistant", { type: "user", parent_tool_use_id: null, session_id: "s-run", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_card", content: "ok" }] } }, iso(1.1 * MIN), { turnId: CARD_TURN });
  for (let i = 0; i < 420; i += 1) addMessage(db, "s-run", "assistant", subagentRow(i), new Date(NOW - MIN + i).toISOString(), { turnId: CARD_TURN });
  db.close();
  thread = byId(await listConductorThreads(makeConfig(other), { now: NOW, peers: new Map() }))["s-run"];
  assert.equal(thread.meta.pendingCard, null);
});

test("the agent's whole last message is kept with its lines; a synthetic limit row is not its reply", async (t) => {
  const home = makeHome(t);
  const file = seed(home);
  const db = new DatabaseSync(file);
  const report = `${"Earlier notes. ".repeat(60)}\n\n**Blocked on:**\n- **Your decision** on the two P1s\n- checks on new head`;
  addMessage(db, "s-idle", "assistant", sdk.text("s-idle", report), iso(15 * MIN));
  const limit = sdk.text("s-idle", "You've hit your session limit · resets 2:30pm");
  limit.message.model = "<synthetic>";
  addMessage(db, "s-idle", "assistant", limit, iso(14 * MIN));
  db.close();
  const thread = byId(await listConductorThreads(makeConfig(home), { now: NOW, peers: new Map() }))["s-idle"];
  assert.match(thread.lastAgentText, /session limit/);
  assert.ok(thread.lastAgentText.length <= DEFAULTS.excerptMax);
  assert.ok(thread.lastAgentFull.length > DEFAULTS.excerptMax);
  assert.ok(thread.lastAgentFull.endsWith("Earlier notes.\n\n**Blocked on:**\n- **Your decision** on the two P1s\n- checks on new head"));
  assert.equal(thread.lastAgentFullAt, iso(15 * MIN));
  assert.equal(thread.lastAgentAt, iso(14 * MIN));
});

test("an answer the agent sent back with SendMessage is read as its reply", async (t) => {
  // dakar, 2026-10-12 15:53:54Z: it answered a supervisor relay with
  // SendMessage to /tmp/cc-socks/48713.sock, which had already closed.
  const home = makeHome(t);
  const file = seed(home);
  const db = new DatabaseSync(file);
  addMessage(db, "s-idle", "assistant", sdk.text("s-idle", "Older status."), iso(30 * MIN));
  const answer = "PR #7317 is ready on our side but not merged; main's red Testing CI is the only blocker.";
  addMessage(db, "s-idle", "assistant", {
    type: "assistant", session_id: "s-idle", parent_tool_use_id: null,
    message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "toolu_send", name: "SendMessage", input: { to: "uds:/tmp/cc-socks/48713.sock", summary: "Reply PR 7317 status", message: answer } }] }
  }, iso(10 * MIN));
  db.close();
  const thread = byId(await listConductorThreads(makeConfig(home), { now: NOW, peers: new Map() }))["s-idle"];
  assert.equal(thread.lastAgentFull, answer);
  assert.equal(thread.lastAgentFullAt, iso(10 * MIN));
  // A preamble in the same message is not the answer it relayed.
  const more = new DatabaseSync(file);
  const later = "Still ready; main's Testing CI went green, so #7317 can merge.";
  addMessage(more, "s-idle", "assistant", {
    type: "assistant", session_id: "s-idle", parent_tool_use_id: null,
    message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "I'll send the status now." },
      { type: "tool_use", id: "toolu_send2", name: "SendMessage", input: { to: "uds:/tmp/cc-socks/48713.sock", summary: "Reply", message: later } }] }
  }, iso(5 * MIN));
  more.close();
  const again = byId(await listConductorThreads(makeConfig(home), { now: NOW, peers: new Map() }))["s-idle"];
  assert.equal(again.lastAgentFull, later);
});

// A subagent's AskUserQuestion (342281f9, 2026-10-07 03:27:31): the card
// shows to the owner like the agent's own.
const subagentAsk = (id) => ({ ...cardCall(id), parent_tool_use_id: "toolu_bg" });
const subagentAnswer = (id) => ({ type: "user", parent_tool_use_id: "toolu_bg", session_id: "s-run", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "User responses:\n1. Yes, merge the whole stack" }] } });

test("a subagent's question card is surfaced until its own answer", async (t) => {
  const home = makeHome(t);
  const file = seedCard(home, { subagentRows: 3 });
  let db = new DatabaseSync(file);
  // The agent's card was answered; then a subagent asks.
  addMessage(db, "s-run", "assistant", { type: "user", parent_tool_use_id: null, session_id: "s-run", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_card", content: "ok" }] } }, iso(1.5 * MIN), { turnId: CARD_TURN });
  addMessage(db, "s-run", "assistant", subagentAsk("toolu_sub"), iso(1.4 * MIN), { turnId: CARD_TURN });
  addMessage(db, "s-run", "assistant", subagentRow(99), iso(1.3 * MIN), { turnId: CARD_TURN });
  db.close();
  const config = makeConfig(home);
  let thread = byId(await listConductorThreads(config, { now: NOW, peers: new Map() }))["s-run"];
  assert.equal(thread.meta.pendingCard?.cardId, "toolu_sub");
  assert.deepEqual(thread.meta.pendingCard.items.map((item) => item.itemId), ["toolu_sub:0", "toolu_sub:1"]);
  assert.equal(classifyThread(thread, { now: NOW, config }).state, "needs-human");
  db = new DatabaseSync(file);
  addMessage(db, "s-run", "assistant", subagentAnswer("toolu_sub"), iso(1.2 * MIN), { turnId: CARD_TURN });
  db.close();
  thread = byId(await listConductorThreads(config, { now: NOW, peers: new Map() }))["s-run"];
  assert.equal(thread.meta.pendingCard, null);
});

test("an error row closes the card, in the tail and out of it", async (t) => {
  // d7757f20: the card, then "Claude Code process exited with code 143".
  const home = makeHome(t);
  const file = seedCard(home, { subagentRows: 3 });
  let db = new DatabaseSync(file);
  addMessage(db, "s-run", "assistant", sdk.error("Claude Code process exited with code 143"), iso(1 * MIN), { turnId: CARD_TURN });
  db.close();
  assert.equal(byId(await listConductorThreads(makeConfig(home), { now: NOW, peers: new Map() }))["s-run"].meta.pendingCard, null);
  // The card out of the tail, its error row too.
  const other = makeHome(t);
  const deep = seedCard(other, { subagentRows: 450 });
  db = new DatabaseSync(deep);
  addMessage(db, "s-run", "assistant", sdk.error("Claude Code process exited with code 143"), iso(1.5 * MIN), { turnId: CARD_TURN });
  for (let i = 0; i < 420; i += 1) addMessage(db, "s-run", "assistant", subagentRow(i), new Date(NOW - 1.4 * MIN + i).toISOString(), { turnId: CARD_TURN });
  db.close();
  assert.equal(byId(await listConductorThreads(makeConfig(other), { now: NOW, peers: new Map() }))["s-run"].meta.pendingCard, null);
});

test("a result row closes a card out of the tail; a subagent card out of the tail is found", async (t) => {
  const home = makeHome(t);
  const file = seedCard(home, { subagentRows: 450 });
  let db = new DatabaseSync(file);
  addMessage(db, "s-run", "assistant", sdk.result("s-run", "Stopped."), iso(1.5 * MIN), { turnId: CARD_TURN });
  for (let i = 0; i < 420; i += 1) addMessage(db, "s-run", "assistant", subagentRow(i), new Date(NOW - 1.4 * MIN + i).toISOString(), { turnId: CARD_TURN });
  db.close();
  assert.equal(byId(await listConductorThreads(makeConfig(home), { now: NOW, peers: new Map() }))["s-run"].meta.pendingCard, null);

  const other = makeHome(t);
  const sub = seedCard(other, { subagentRows: 0 });
  db = new DatabaseSync(sub);
  addMessage(db, "s-run", "assistant", { type: "user", parent_tool_use_id: null, session_id: "s-run", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_card", content: "ok" }] } }, iso(1.95 * MIN), { turnId: CARD_TURN });
  addMessage(db, "s-run", "assistant", subagentAsk("toolu_sub"), iso(1.94 * MIN), { turnId: CARD_TURN });
  for (let i = 0; i < 450; i += 1) addMessage(db, "s-run", "assistant", subagentRow(i), new Date(NOW - 1.9 * MIN + i * 100).toISOString(), { turnId: CARD_TURN });
  db.close();
  assert.equal(byId(await listConductorThreads(makeConfig(other), { now: NOW, peers: new Map() }))["s-run"].meta.pendingCard?.cardId, "toolu_sub");
});

test("a trailing row with no turn_id or an ambient broadcast never hides or drops an open card", async (t) => {
  // The turn's init aged out of the tail; a subagent card is in the tail, the
  // agent's own card is not, and the newest rows are a commands_changed
  // broadcast (its own turn id) and a row with no turn_id at all.
  const home = makeHome(t);
  const file = seedCard(home, { subagentRows: 450 });
  let db = new DatabaseSync(file);
  addMessage(db, "s-run", "assistant", subagentAsk("toolu_sub"), iso(0.2 * MIN), { turnId: CARD_TURN });
  addMessage(db, "s-run", "assistant", { type: "system", subtype: "commands_changed", session_id: "s-run" }, iso(0.15 * MIN), { turnId: "ambient-turn" });
  addMessage(db, "s-run", "assistant", { type: "system", subtype: "commands_changed", session_id: "s-run" }, iso(0.1 * MIN));
  db.close();
  let card = byId(await listConductorThreads(makeConfig(home), { now: NOW, peers: new Map() }))["s-run"].meta.pendingCard;
  assert.deepEqual(card?.items.map((item) => item.itemId), ["toolu_card:0", "toolu_card:1", "toolu_sub:0", "toolu_sub:1"]);

  // An older Conductor with no turn_id column: the tail card stands alone.
  const other = makeHome(t);
  const old = seedCard(other, { subagentRows: 450 });
  db = new DatabaseSync(old);
  addMessage(db, "s-run", "assistant", subagentAsk("toolu_sub"), iso(0.2 * MIN));
  db.exec("ALTER TABLE session_messages DROP COLUMN turn_id");
  db.close();
  card = byId(await listConductorThreads(makeConfig(other), { now: NOW, peers: new Map() }))["s-run"].meta.pendingCard;
  assert.equal(card?.cardId, "toolu_sub");
});

test("rows that only mention AskUserQuestion never hide the real call out of the tail", async (t) => {
  // 221fbf69: subagents read conductor.js and its tests while a card is open.
  const home = makeHome(t);
  const file = seedCard(home, { subagentRows: 0 });
  const db = new DatabaseSync(file);
  const mention = (i) => ({ type: "user", parent_tool_use_id: "toolu_bg", session_id: "s-run", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_read${i}`,
    content: `const call = content.find((block) => /AskUserQuestion$/.test(block.name)); name: "mcp__conductor__AskUserQuestion" ${i}` }] } });
  for (let i = 0; i < 450; i += 1) addMessage(db, "s-run", "assistant", i % 70 === 0 ? mention(i) : subagentRow(i), new Date(NOW - 1.9 * MIN + i * 100).toISOString(), { turnId: CARD_TURN });
  db.close();
  assert.equal(byId(await listConductorThreads(makeConfig(home), { now: NOW, peers: new Map() }))["s-run"].meta.pendingCard?.cardId, "toolu_card");
});

test("the out-of-tail card reads use the turn_id index, never a walk of the session", () => {
  const db = new DatabaseSync(":memory:");
  // conductor.db's real session_messages indexes (2026-10-11 .schema).
  db.exec(`CREATE TABLE session_messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT, full_message TEXT, cancelled_at TEXT, model TEXT, sdk_message_id TEXT, last_assistant_message_id TEXT, turn_id TEXT,
      is_resumable_message INTEGER, queue_order INTEGER, sender_id TEXT, sender_session_id TEXT, sender_api_key_name TEXT, sender_source TEXT);
    CREATE INDEX idx_session_messages_sent_at ON session_messages(session_id, sent_at);
    CREATE INDEX idx_session_messages_cancelled_at ON session_messages(session_id, cancelled_at);
    CREATE INDEX idx_session_messages_turn_id ON session_messages(turn_id);
    CREATE INDEX idx_session_messages_queued_session_id ON session_messages(session_id) WHERE sent_at IS NULL AND cancelled_at IS NULL;
    CREATE INDEX idx_session_messages_sdk_message_id ON session_messages(session_id, sdk_message_id) WHERE sdk_message_id IS NOT NULL;
    CREATE INDEX idx_session_messages_user_turns ON session_messages(session_id, role, turn_id, id, sent_at, cancelled_at) WHERE role = 'user';`);
  for (const [sql, params] of [[ASK_SQL, ["t", "s"]], [ASK_CLOSED_SQL, ["t", "s", "x", "x", 1, "%id%"]]]) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((row) => row.detail).join("\n");
    assert.match(plan, /USING INDEX idx_session_messages_turn_id \(turn_id=\?\)/);
    assert.doesNotMatch(plan, /idx_session_messages_sent_at/);
  }
  db.close();
});

test("a working session's card dies with its process: a peer started after the call, or none once the turn went silent", async (t) => {
  const home = makeHome(t);
  seedCard(home);
  const config = makeConfig(home);
  const later = NOW + DEFAULTS.silentTurnMs;
  // Silent with no process: no card, and the stopped turn reads stalled.
  let threads = byId(await listConductorThreads(config, { now: later, peers: new Map() }));
  assert.equal(threads["s-run"].meta.pendingCard, null);
  assert.equal(threads["s-run"].meta.pendingQuestion, null);
  assert.equal(threads["s-run"].agentStatus, "stalled");
  assert.notEqual(classifyThread(threads["s-run"], { now: later, config }).state, "needs-human");
  // A process restarted after the call is not the one that asked.
  const restarted = new Map([["s-run", { peerName: "madrid", pid: 902, status: "idle", waitingFor: null, startedAt: iso(MIN) }]]);
  threads = byId(await listConductorThreads(config, { now: NOW, peers: restarted }));
  assert.equal(threads["s-run"].meta.pendingCard, null);
  // The process that asked still lives: the card stays however long it waits.
  const asker = new Map([["s-run", { peerName: "madrid", pid: 902, status: "idle", waitingFor: null, startedAt: iso(10 * MIN) }]]);
  threads = byId(await listConductorThreads(config, { now: later, peers: asker }));
  assert.equal(threads["s-run"].meta.pendingCard?.cardId, "toolu_card");
});

// cape-town sat on feature/bob-skills (#6817, merged Sep 27) while its
// subagents opened #7089 (over ssh: "ok https://.../pull/7089"), #7343 and
// #7573 from other branches. What the chat only named, viewed, checked,
// listed or commented on is not its PR: "#7555" it reviewed, #5544 it
// builds on, another agent's #7010.
const BB_PULL = "https://github.com/buildbetter-app/buildbetter/pull";
function seedCapeTown(home, title = "BOB briefs stale data fix") {
  const file = path.join(home, "Library", "Application Support", "com.conductor.app", "conductor.db");
  const db = createDb(file);
  db.exec(`INSERT INTO repos (id, remote_url, name) VALUES ('r1', 'https://github.com/buildbetter-app/buildbetter.git', 'bbapp')`);
  db.prepare(`INSERT INTO workspaces (local_id, repository_id, directory_name, active_session_id, branch, state, derived_status, workspace_path, pr_title)
    VALUES ('w-cape', 'r1', 'cape-town', 's-cape', 'feature/bob-skills', 'ready', 'in-progress', '/Users/x/Dev/bbapp/.conductor/cape-town', 'Back every BOB Loop with a skill BOB owns')`).run();
  db.prepare(`INSERT INTO sessions (id, status, claude_session_id, updated_at, created_at, workspace_id, agent_type, title)
    VALUES ('s-cape', 'idle', 's-cape', ?, ?, 'w-cape', 'claude', ?)`).run(sqliteTime(MIN), iso(600 * MIN), title);
  const call = (id, command, parent = null) => ({ type: "assistant", session_id: "s-cape", parent_tool_use_id: parent,
    message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });
  const result = (id, text, parent = null) => ({ type: "user", session_id: "s-cape", parent_tool_use_id: parent, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
  addMessage(db, "s-cape", "user", `Ship ${BB_PULL}/6817 first, then build on top of #5544`, iso(300 * MIN));
  addMessage(db, "s-cape", "assistant", sdk.text("s-cape", "Merged #6817. Building on top of #5544."), iso(290 * MIN));
  addMessage(db, "s-cape", "assistant", call("toolu_m4", "ssh dev@100.99.3.113 'cd ~/scratch/bob-fresh && gh pr create -R buildbetter-app/buildbetter --draft --base feature/bob-brief-skill'", "toolu_sub1"), iso(200 * MIN));
  addMessage(db, "s-cape", "assistant", result("toolu_m4", `ok ${BB_PULL}/7089\n`, "toolu_sub1"), iso(199 * MIN));
  addMessage(db, "s-cape", "assistant", call("toolu_cm", "gh pr comment 7089 --body-file /tmp/c.md", "toolu_sub1"), iso(198 * MIN));
  addMessage(db, "s-cape", "assistant", result("toolu_cm", `${BB_PULL}/7089#issuecomment-5939150350`, "toolu_sub1"), iso(197 * MIN));
  addMessage(db, "s-cape", "assistant", call("toolu_view", `gh pr view ${BB_PULL}/7010 --json url`), iso(150 * MIN));
  addMessage(db, "s-cape", "assistant", result("toolu_view", `${BB_PULL}/7010`), iso(149 * MIN));
  addMessage(db, "s-cape", "assistant", call("toolu_base", "gh pr view 5544 --json url,state"), iso(140 * MIN));
  addMessage(db, "s-cape", "assistant", result("toolu_base", `{"url":"${BB_PULL}/5544","state":"OPEN"}`), iso(139 * MIN));
  addMessage(db, "s-cape", "assistant", call("toolu_m5", "cd .context/bob-fresh-redraft && gh pr create --repo buildbetter-app/buildbetter --draft", "toolu_sub2"), iso(100 * MIN));
  addMessage(db, "s-cape", "assistant", result("toolu_m5", `${BB_PULL}/7343\n`, "toolu_sub2"), iso(99 * MIN));
  // A listing names many PRs; a subagent reads one it was sent to review.
  addMessage(db, "s-cape", "assistant", call("toolu_list", "gh pr list --repo buildbetter-app/buildbetter"), iso(60 * MIN));
  addMessage(db, "s-cape", "assistant", result("toolu_list", `${BB_PULL}/7001 ${BB_PULL}/7002`), iso(59 * MIN));
  addMessage(db, "s-cape", "assistant", sdk.text("s-cape", "Reviewing #7555 for you.", "toolu_sub3"), iso(40 * MIN));
  addMessage(db, "s-cape", "assistant", call("toolu_fu", "cd /tmp && gh pr create -R buildbetter-app/buildbetter --base main --head chore/bob-spec-followups", "toolu_sub4"), iso(20 * MIN));
  addMessage(db, "s-cape", "assistant", result("toolu_fu", `${BB_PULL}/7573`, "toolu_sub4"), iso(19 * MIN));
  addMessage(db, "s-cape", "user", "[OpenAGI supervisor] Ready to merge? Left on #6817.", iso(10 * MIN));
  addMessage(db, "s-cape", "assistant", sdk.text("s-cape", "No change. #7089's full check and the #7063, #7065 and #7066 rechecks are still running."), iso(5 * MIN));
  db.close();
  return file;
}

test("a session's own PRs are the ones its gh pr create calls made, newest first", async (t) => {
  const home = makeHome(t);
  const file = seedCapeTown(home);
  const config = makeConfig(home);
  const [thread] = await listConductorThreads(config, { now: NOW, peers: new Map() });
  assert.equal(thread.branch, "feature/bob-skills");
  assert.deepEqual(thread.meta.prCreated, ["buildbetter-app/buildbetter#7573", "buildbetter-app/buildbetter#7343", "buildbetter-app/buildbetter#7089"]);
  assert.equal(thread.meta.prMentions, undefined, "a PR it only named, viewed or listed is not its own");
  assert.deepEqual(thread.prRefs, []);
  // The next scan reads only rows sent since, and a new PR leads.
  const db = new DatabaseSync(file);
  addMessage(db, "s-cape", "assistant", { type: "assistant", session_id: "s-cape", parent_tool_use_id: null,
    message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "toolu_new", name: "Bash", input: { command: "gh pr create --fill" } }] } }, iso(2 * MIN));
  addMessage(db, "s-cape", "assistant", { type: "user", session_id: "s-cape", parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_new", content: `${BB_PULL}/7580` }] } }, iso(1.5 * MIN));
  db.close();
  const [again] = await listConductorThreads(config, { now: NOW, peers: new Map() });
  assert.deepEqual(again.meta.prCreated.slice(0, 2), ["buildbetter-app/buildbetter#7580", "buildbetter-app/buildbetter#7573"]);
});

test("a gh pr create on the line after a heredoc body is the chat's PR", async (t) => {
  // madrid wrote its #7586 body with cat <<'EOF' and ran gh pr create on the
  // next line. Read as JSON, that newline is backslash-n with no word
  // boundary before gh: #7586 went unseen and the old #7185 led.
  const home = makeHome(t);
  const file = seedCapeTown(home);
  const db = new DatabaseSync(file);
  const command = "cd /Users/shooby/Dev/bbapp/.worktrees/proposal-expiry && cat > /tmp/proposal-expiry-pr-body.md <<'EOF'\nChat inbox and triage proposals now last 24 hours.\nEOF\ngh pr create --repo buildbetter-app/buildbetter --base main --title \"Proposals last 24 hours\" --body-file /tmp/proposal-expiry-pr-body.md";
  addMessage(db, "s-cape", "assistant", { type: "assistant", session_id: "s-cape", parent_tool_use_id: null,
    message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "toolu_heredoc", name: "Bash", input: { command } }] } }, iso(2 * MIN));
  addMessage(db, "s-cape", "assistant", { type: "user", session_id: "s-cape", parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_heredoc", content: `${BB_PULL}/7586\n` }] } }, iso(1.5 * MIN));
  db.close();
  const [thread] = await listConductorThreads(makeConfig(home), { now: NOW, peers: new Map() });
  assert.equal(thread.meta.prCreated[0], "buildbetter-app/buildbetter#7586");
});

test("a Conductor session opened with the supervisor display prompt is the supervisor's own", async (t) => {
  const home = makeHome(t);
  seedCapeTown(home, "You are the Agent Supervisor display. Reply with exactly: Agent Supervisor connected — monitoring Codex and Claude Code.");
  const [thread] = await listConductorThreads(makeConfig(home), { now: NOW, peers: new Map() });
  assert.equal(thread.excluded, "self");
});

// A long display chat: its opening prompt falls out of the 400-row tail and
// the tail's earliest prompt is an ordinary later one. Still its own.
test("a Conductor display session stays excluded once its opening prompt is out of the tail", async (t) => {
  const home = makeHome(t);
  seedCapeTown(home);
  const db = new DatabaseSync(path.join(home, "Library", "Application Support", "com.conductor.app", "conductor.db"));
  db.prepare("UPDATE session_messages SET content = ? WHERE session_id = 's-cape' AND role = 'user' AND sent_at = ?")
    .run("You are the Agent Supervisor display. Reply with exactly: Agent Supervisor connected — monitoring Codex and Claude Code.", iso(300 * MIN));
  for (let i = 0; i < 420; i += 1) addMessage(db, "s-cape", i % 2 ? "assistant" : "user", i % 2 ? sdk.text("s-cape", `ok ${i}`) : `status ${i}`, new Date(NOW - 4 * MIN + i * 100).toISOString());
  db.close();
  const cache = new Map();
  const [thread] = await listConductorThreads(makeConfig(home), { now: NOW, peers: new Map(), firstPrompts: cache });
  assert.equal(thread.excluded, "self");
  assert.equal(cache.size, 1);
  const [again] = await listConductorThreads(makeConfig(home), { now: NOW, peers: new Map(), firstPrompts: cache });
  assert.equal(again.excluded, "self");
});
