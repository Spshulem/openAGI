import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveFleetConfig } from "../src/fleet/contracts.js";
import { findManagerSession, listConductorThreads } from "../src/fleet/sources/conductor.js";

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
  db.prepare(`INSERT INTO session_messages (id, session_id, role, content, created_at, sent_at, cancelled_at, sender_session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    `m-${messageSeq}`, sessionId, role, typeof content === "string" ? content : JSON.stringify(content),
    at, at, extra.cancelledAt ?? null, extra.senderSessionId ?? null
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
  // SQLite datetime('now') is UTC even without a zone suffix.
  assert.equal(run.lastActivityAt, iso(MIN));
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
  assert.equal(wait.lastActivityAt, iso(20 * MIN));

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
  assert.equal(idle.meta.turnStartedAt, iso(29 * MIN));
  assert.deepEqual(idle.openTasks, []);

  const errored = threads["s-err"];
  assert.equal(errored.agentStatus, "error");
  assert.equal(errored.error.kind, "other");
  assert.match(errored.error.text, /No conversation found/);

  const aborted = threads["s-abort"];
  assert.equal(aborted.agentStatus, "aborted");
  assert.equal(aborted.meta.abortReason, "aborted by user");
  assert.equal(aborted.error, null);

  assert.equal(threads["s-self"].excluded, "self");
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

test("missing database degrades to an empty list", async (t) => {
  const home = makeHome(t);
  assert.deepEqual(await listConductorThreads(makeConfig(home), { now: NOW }), []);
  const bad = path.join(home, "bad.db");
  fs.writeFileSync(bad, "not a database");
  assert.deepEqual(await listConductorThreads(makeConfig(home, { paths: { conductorDb: bad } }), { now: NOW }), []);
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
    { ...thread("0056f770-e054-484b-a712-4cc036dacf6f"), kind: "claude", key: "claude:0056f770-e054-484b-a712-4cc036dacf6f" },
    thread("0056f770-e054-484b-a712-4cc036dacf6f")
  ];
  const find = (managerRef) => findManagerSession(resolveFleetConfig({}, { home: "/h", managerRef }), threads);
  assert.equal(find("a").id, "a");
  assert.equal(find("claude-b").id, "b");
  // A live tab wins over a newer offline one.
  assert.equal(find("remote-dev").id, "r2");
  assert.equal(find("0056f770").kind, "conductor");
  assert.equal(find("missing"), null);
  assert.equal(findManagerSession(resolveFleetConfig({}, { home: "/h", managerRef: "" }), threads), null);
  assert.equal(find("0056"), null, "short prefixes never match");
  assert.equal(findManagerSession(null, threads), null);
  assert.equal(findManagerSession(resolveFleetConfig({}, { home: "/h", managerRef: "a" }), null), null);
});
