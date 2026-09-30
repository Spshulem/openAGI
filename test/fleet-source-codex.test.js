import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { uiIdentity } from "../src/fleet/ui-delivery.js";
import { clampText, linkUiHosts, resolveFleetConfig, shortHash, uiTargetFor } from "../src/fleet/contracts.js";
import {
  classifyLbError, cleanCodexUserText, listCodexThreads, parseRolloutTail, readCodexLbErrors
} from "../src/fleet/sources/codex.js";

const NOW = Date.parse("2026-09-26T08:00:00.000Z");
const MIN = 60_000;

// Mirrors the real ~/.codex/state_5.sqlite threads columns (verified with
// `.schema threads`), trimmed of indexes and triggers.
const THREADS_SQL = `CREATE TABLE threads (
  id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  source TEXT NOT NULL, model_provider TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL,
  sandbox_policy TEXT NOT NULL, approval_mode TEXT NOT NULL, tokens_used INTEGER NOT NULL DEFAULT 0,
  has_user_event INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER,
  git_sha TEXT, git_branch TEXT, git_origin_url TEXT, cli_version TEXT NOT NULL DEFAULT '',
  first_user_message TEXT NOT NULL DEFAULT '', agent_nickname TEXT, agent_role TEXT,
  memory_mode TEXT NOT NULL DEFAULT 'enabled', model TEXT, reasoning_effort TEXT, agent_path TEXT,
  created_at_ms INTEGER, updated_at_ms INTEGER, thread_source TEXT, preview TEXT NOT NULL DEFAULT '',
  recency_at INTEGER NOT NULL DEFAULT 0, recency_at_ms INTEGER NOT NULL DEFAULT 0,
  history_mode TEXT NOT NULL DEFAULT 'legacy', name TEXT, is_pinned INTEGER NOT NULL DEFAULT 0,
  thread_section_id TEXT, section_position INTEGER, section_entered_at_ms INTEGER, project_id TEXT,
  originator TEXT, daybreak_enabled BOOLEAN)`;

const ATTACHMENTS_SQL = `CREATE TABLE thread_attachments (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, attachment_type TEXT NOT NULL,
  identity_key TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE (thread_id, attachment_type, identity_key))`;

const LOGS_SQL = `CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ts_nanos INTEGER NOT NULL, level TEXT NOT NULL,
  target TEXT NOT NULL, feedback_log_body TEXT, module_path TEXT, file TEXT, line INTEGER, thread_id TEXT,
  process_uuid TEXT, estimated_bytes INTEGER NOT NULL DEFAULT 0)`;

const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const sec = (msAgo) => Math.floor((NOW - msAgo) / 1000);

// Rollout line builders using the real event shapes (fleet-infra.md §2.1 and
// live tails): {timestamp, type, payload}.
const ev = {
  meta: (id, cwd) => ({ timestamp: iso(90 * MIN), type: "session_meta", payload: { id, cwd, source: "vscode", thread_source: "user", originator: "Codex Desktop", model_provider: "codex-lb" } }),
  started: (turn, msAgo) => ({ timestamp: iso(msAgo), type: "event_msg", payload: { type: "task_started", turn_id: turn, started_at: sec(msAgo), model_context_window: 258400 } }),
  user: (text, msAgo) => ({ timestamp: iso(msAgo), type: "event_msg", payload: { type: "user_message", message: text, images: [] } }),
  userItem: (text, msAgo) => ({ timestamp: iso(msAgo), type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", id: "u1", content: [{ type: "text", text }] } } }),
  envContext: (msAgo) => ({ timestamp: iso(msAgo), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/x</cwd>\n</environment_context>" }] } }),
  assistant: (text, msAgo, phase = "commentary") => ({ timestamp: iso(msAgo), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }], phase } }),
  tokens: (msAgo) => ({ timestamp: iso(msAgo), type: "event_msg", payload: { type: "token_count", info: {}, rate_limits: { limit_id: "codex", primary: { used_percent: 89 } } } }),
  complete: (turn, msAgo, last, error) => ({ timestamp: iso(msAgo), type: "event_msg", payload: { type: "task_complete", turn_id: turn, last_agent_message: last, ...(error ? { error } : {}), started_at: sec(msAgo + MIN), completed_at: sec(msAgo), duration_ms: 60000 } }),
  aborted: (turn, msAgo) => ({ timestamp: iso(msAgo), type: "event_msg", payload: { type: "turn_aborted", turn_id: turn, reason: "interrupted", started_at: sec(msAgo + MIN), completed_at: sec(msAgo) } }),
  attachMcp: (url, msAgo) => ({ timestamp: iso(msAgo), type: "event_msg", payload: { type: "item_completed", item: { type: "McpToolCall", server: "codex_app", tool: "attach_artifact", arguments: { artifact_type: "pull_request", url }, status: "completed" } } }),
  attachExec: (url, msAgo) => ({ timestamp: iso(msAgo), type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "c1", input: `const r = await tools.mcp__codex_app__attach_artifact({artifact_type:"pull_request",url:"${url}"});` } }),
  ask: (title, msAgo) => ({ timestamp: iso(msAgo), type: "response_item", payload: { type: "function_call", name: "request_user_input_async", call_id: "q1", arguments: JSON.stringify({ questions: [{ title }] }) } }),
  // Codex Desktop writes this when it reopens a thread; no turn runs.
  settings: (msAgo) => ({ timestamp: iso(msAgo), type: "event_msg", payload: { type: "thread_settings_applied", thread_id: "x", thread_settings: { model: "gpt-6-sol" } } })
};

function makeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-codex-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codexHome = path.join(home, ".codex");
  fs.mkdirSync(path.join(codexHome, "sessions", "2026", "09", "25"), { recursive: true });
  fs.mkdirSync(path.join(codexHome, "thread-writer-locks"), { recursive: true });
  const config = resolveFleetConfig({}, { home, bins: { lsof: "/fake/lsof" } });
  const db = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  db.exec(THREADS_SQL);
  db.exec(ATTACHMENTS_SQL);
  const repoDir = path.join(home, "work", "bbapp");
  fs.mkdirSync(repoDir, { recursive: true });
  return { home, codexHome, config, db, repoDir };
}

function addThread(ctx, spec) {
  const {
    id, lines = null, mtimeAgo = 30 * MIN, updatedAgo = mtimeAgo, cwd = ctx.repoDir, archived = 0,
    threadSource = "user", source = "vscode", branch = "spencer/feature", origin = "git@github.com:buildbetter-app/buildbetter.git",
    name = null, title = "Fix the thing", firstUserMessage = "fix it", originator = null
  } = spec;
  const rollout = path.join(ctx.codexHome, "sessions", "2026", "09", "25", `rollout-2026-09-25T10-00-00-${id}.jsonl`);
  if (lines) {
    fs.writeFileSync(rollout, `${[ev.meta(id, cwd), ...lines].map((line) => JSON.stringify(line)).join("\n")}\n`);
    const at = new Date(NOW - mtimeAgo);
    fs.utimesSync(rollout, at, at);
  }
  ctx.db.prepare(`INSERT INTO threads (id, rollout_path, created_at, updated_at, updated_at_ms, source, model_provider, cwd, title,
    sandbox_policy, approval_mode, archived, git_branch, git_origin_url, first_user_message, model, thread_source, name, originator)
    VALUES (?, ?, ?, ?, ?, ?, 'codex-lb', ?, ?, 'danger-full-access', 'never', ?, ?, ?, ?, 'gpt-6-sol', ?, ?, ?)`)
    .run(id, rollout, sec(5 * 60 * MIN), sec(updatedAgo), NOW - updatedAgo, source, cwd, title, archived, branch, origin,
      firstUserMessage, threadSource, name, originator);
  return rollout;
}

function byId(threads) {
  return Object.fromEntries(threads.map((thread) => [thread.id, thread]));
}

test("a turn killed mid-tool stays stalled when reopening the thread writes settings rows", async (t) => {
  const ctx = makeHome(t);
  // An app-server restart ends the turn with no row; later the owner opens
  // the thread, which bumps the file but runs nothing.
  addThread(ctx, { id: "t-dead", mtimeAgo: MIN, lines: [
    ev.started("h1", 90 * MIN), ev.assistant("I'm checking those write boundaries before changing them.", 70 * MIN),
    ev.attachExec("https://github.com/buildbetter-app/buildbetter/pull/6453", 65 * MIN), ev.tokens(65 * MIN), ev.settings(MIN)
  ] });
  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run: async () => ({ code: 1, stdout: "", stderr: "" }) }));
  assert.equal(map["t-dead"].agentStatus, "stalled");
  assert.equal(map["t-dead"].lastActivityAt, iso(65 * MIN));
});

test("only sidebar threads count as sharing a title", async (t) => {
  const ctx = makeHome(t);
  const lines = [ev.complete("x0", 20 * MIN, "done")];
  addThread(ctx, { id: "t-a", name: "Plan interactive reports migration (4)", lines });
  addThread(ctx, { id: "t-auto", name: "Plan interactive reports migration (4)", source: "exec", lines });
  addThread(ctx, { id: "t-sub", name: "Plan interactive reports migration (4)", source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: "t-a", depth: 1 } } }), lines });
  addThread(ctx, { id: "t-b", name: "Scope native mobile migration", lines });
  addThread(ctx, { id: "t-c", name: "Scope native mobile migration", lines });
  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run: async () => ({ code: 1, stdout: "", stderr: "" }) }));
  assert.notEqual(map["t-a"].meta.codexTitleShared, true, "an exec run and a subagent are not twins");
  assert.equal(map["t-b"].meta.codexTitleShared, true);
});

test("a named thread carries its first-message title, shared when any sidebar thread could show it", async (t) => {
  const ctx = makeHome(t);
  const lines = [ev.complete("x0", 20 * MIN, "done")];
  addThread(ctx, { id: "t-audit", name: "Audit OpenAI model versions", title: "<environment_context>x</environment_context> OpenAI just launched their GPT-6 models so for all of our Luna, Soul, and Terra agents", lines });
  addThread(ctx, { id: "t-intruder", name: "Intruder", title: "continue", lines });
  addThread(ctx, { id: "t-same", name: "Fix uploads", title: "fix  uploads", lines });
  addThread(ctx, { id: "t-unnamed", title: "Plan the billing export", lines });
  // Another thread's name, or another thread's first message, can be the label on screen.
  addThread(ctx, { id: "t-a", name: "Rename bucket", title: "Plan the billing export", lines });
  addThread(ctx, { id: "t-b", name: "Ship reports", title: "Review the pricing page copy", lines });
  addThread(ctx, { id: "t-old", updatedAgo: 60 * 24 * 60 * MIN, name: "Old one", title: "Review the pricing page copy" });
  // Not in the Codex sidebar: never a twin.
  addThread(ctx, { id: "t-c", name: "Draft launch post", title: "Write the changelog entry", lines });
  addThread(ctx, { id: "t-exec", name: "Sweep", title: "Write the changelog entry", source: "exec", lines });
  addThread(ctx, { id: "t-arch", archived: 1, name: "Archived", title: "Write the changelog entry" });
  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run: async () => ({ code: 1, stdout: "", stderr: "" }) }));
  assert.equal(map["t-audit"].meta.firstMessageTitle, "x OpenAI just launched their GPT-6 models so for all of our Luna, Soul, and Terra agents");
  assert.notEqual(map["t-audit"].meta.codexFirstMessageShared, true);
  assert.equal(map["t-intruder"].meta.firstMessageTitle, "continue");
  assert.equal(map["t-same"].meta.firstMessageTitle, null, "same as the name");
  assert.equal(map["t-unnamed"].meta.firstMessageTitle, null, "no name: the title is already the label");
  assert.equal(map["t-a"].meta.codexFirstMessageShared, true, "another thread's name");
  assert.equal(map["t-b"].meta.codexFirstMessageShared, true, "another thread's first message, even outside the lookback");
  assert.notEqual(map["t-c"].meta.codexFirstMessageShared, true);
  const target = uiTargetFor(map["t-a"]);
  assert.equal(target.altTitle, "Plan the billing export");
  assert.equal(target.altTitleShared, true);
  assert.deepEqual(uiIdentity(map["t-a"], target, [map["t-a"]]).altTokens, []);
});

test("listCodexThreads classifies running, stalled, aborted, error, and idle threads", async (t) => {
  const ctx = makeHome(t);
  addThread(ctx, { id: "t-running", mtimeAgo: 2 * MIN, lines: [
    ev.complete("a0", 30 * MIN, "earlier done"), ev.user("keep going on CI", 10 * MIN), ev.started("a1", 10 * MIN),
    ev.assistant("Checking CI now", 3 * MIN), ev.tokens(2 * MIN)
  ] });
  addThread(ctx, { id: "t-stalled", mtimeAgo: 60 * MIN, lines: [
    ev.started("b1", 90 * MIN), ev.assistant("Working on it", 61 * MIN), ev.tokens(60 * MIN)
  ] });
  addThread(ctx, { id: "t-aborted", mtimeAgo: 40 * MIN, lines: [
    ev.complete("c0", 80 * MIN, "first"), ev.started("c1", 50 * MIN), ev.aborted("c1", 40 * MIN)
  ] });
  addThread(ctx, { id: "t-usage", mtimeAgo: 20 * MIN, lines: [
    ev.started("d1", 21 * MIN),
    ev.complete("d1", 20 * MIN, null, { message: "You’ve hit your usage limit. Try again at Sep 26th, 2026 9:25 AM.", codex_error_info: "usage_limit_exceeded" })
  ] });
  addThread(ctx, { id: "t-lb", mtimeAgo: 20 * MIN, lines: [
    ev.started("e1", 21 * MIN),
    ev.complete("e1", 20 * MIN, null, { message: "unexpected status 503 Service Unavailable: No available accounts. Service is operating in degraded mode", codex_error_info: "other" })
  ] });
  addThread(ctx, { id: "t-net", mtimeAgo: 20 * MIN, lines: [
    ev.started("f1", 21 * MIN),
    ev.complete("f1", 20 * MIN, null, { message: "Connection failed: error sending request", codex_error_info: { http_connection_failed: { http_status_code: null } } })
  ] });
  addThread(ctx, { id: "t-idle", mtimeAgo: 25 * MIN, lines: [
    ev.started("g1", 30 * MIN), ev.assistant("Opened the PR", 26 * MIN, "final_answer"),
    ev.complete("g1", 25 * MIN, "PR is up and CI is running on abc1234.")
  ] });

  const threads = await listCodexThreads(ctx.config, { now: NOW, run: async () => ({ code: 1, stdout: "", stderr: "" }) });
  const map = byId(threads);

  assert.equal(map["t-running"].agentStatus, "running");
  assert.equal(map["t-running"].meta.turnStartedAt, iso(10 * MIN));
  assert.equal(map["t-running"].lastAgentText, "Checking CI now");
  assert.equal(map["t-running"].lastUserText, "keep going on CI");
  assert.equal(map["t-stalled"].agentStatus, "stalled");
  assert.equal(map["t-aborted"].agentStatus, "aborted");
  assert.equal(map["t-aborted"].meta.abortReason, "interrupted");

  const usage = map["t-usage"];
  assert.equal(usage.agentStatus, "error");
  assert.equal(usage.error.kind, "usage-limit");
  assert.ok(usage.error.resetAt, "usage limit carries a reset time");
  assert.match(usage.error.text, /usage limit/);
  assert.equal(map["t-lb"].error.kind, "lb");
  assert.equal(map["t-net"].error.kind, "network");

  const idle = map["t-idle"];
  assert.equal(idle.agentStatus, "idle");
  assert.equal(idle.error, null);
  assert.equal(idle.lastAgentText, "PR is up and CI is running on abc1234.");
  assert.equal(idle.kind, "codex");
  assert.equal(idle.key, "codex:t-idle");
  assert.equal(idle.repo, "buildbetter-app/buildbetter");
  assert.equal(idle.branch, "spencer/feature");
  assert.equal(idle.cwd, ctx.repoDir);
  assert.equal(idle.excluded, null);
  assert.equal(idle.archived, false);
  assert.equal(idle.writerLocked, false);
  assert.equal(idle.live, null);
  assert.deepEqual(idle.openTasks, []);
  assert.equal(idle.meta.model, "gpt-6-sol");
  assert.match(idle.meta.file, /rollout-.*t-idle\.jsonl$/);
  assert.equal(idle.lastActivityAt, new Date(NOW - 25 * MIN).toISOString());
});

test("listCodexThreads collects PR refs newest first from attachments and attach_artifact calls, not browser context", async (t) => {
  const ctx = makeHome(t);
  addThread(ctx, { id: "t-pr", mtimeAgo: 25 * MIN, lines: [
    ev.user("<in-app-browser-context source=\"ambient-ui-state\"> Current URL: https://github.com/buildbetter-app/buildbetter/pull/6001 </in-app-browser-context>\n## My request for Codex:\nplease fix CI", 60 * MIN),
    ev.started("h1", 59 * MIN),
    ev.attachExec("https://github.com/buildbetter-app/buildbetter/pull/6002", 50 * MIN),
    ev.attachMcp("https://github.com/buildbetter-app/buildbetter/pull/6003", 40 * MIN),
    ev.assistant("Also see https://github.com/other/repo/pull/9 for context", 30 * MIN),
    ev.complete("h1", 25 * MIN, "done")
  ] });
  ctx.db.prepare("INSERT INTO thread_attachments VALUES (?, ?, 'pull_request', ?, ?, ?)")
    .run("a1", "t-pr", JSON.stringify(["github.com", "buildbetter-app", "bb-recorder", 283]),
      JSON.stringify({ url: "https://github.com/buildbetter-app/bb-recorder/pull/283", root: null, headBranch: null }), sec(100 * MIN));

  const [thread] = await listCodexThreads(ctx.config, { now: NOW, run: async () => ({ code: 1, stdout: "" }) });
  assert.deepEqual(thread.prRefs, [
    "buildbetter-app/buildbetter#6003",
    "buildbetter-app/buildbetter#6002",
    "buildbetter-app/bb-recorder#283"
  ]);
  assert.equal(thread.lastUserText, "please fix CI");
});

test("listCodexThreads excludes archived, automation, heartbeat, and repo-less threads", async (t) => {
  const ctx = makeHome(t);
  const idleLines = [ev.started("x", 30 * MIN), ev.complete("x", 25 * MIN, "ok")];
  addThread(ctx, { id: "t-archived", archived: 1, lines: idleLines });
  addThread(ctx, { id: "t-automation", threadSource: "automation", lines: idleLines });
  addThread(ctx, { id: "t-guardian", threadSource: null, source: JSON.stringify({ subagent: { other: "guardian" } }), lines: idleLines });
  addThread(ctx, { id: "t-subagent", threadSource: "subagent", lines: idleLines });
  addThread(ctx, { id: "t-heartbeat", lines: [
    ev.user("real ask", 80 * MIN), ev.complete("y0", 70 * MIN, "ok"),
    ev.user("<heartbeat>\n  <automation_id>xtra-storage</automation_id>\n</heartbeat>", 30 * MIN),
    ev.started("y1", 30 * MIN), ev.complete("y1", 25 * MIN, "checked")
  ] });
  addThread(ctx, { id: "t-gone", cwd: path.join(ctx.home, "deleted-worktree"), lines: idleLines });
  addThread(ctx, { id: "t-nogit", branch: null, origin: null, lines: idleLines });
  addThread(ctx, { id: "t-forked", threadSource: "agent_forked_thread", lines: idleLines });
  addThread(ctx, { id: "t-old", updatedAgo: 72 * 60 * MIN, mtimeAgo: 72 * 60 * MIN, lines: idleLines });

  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run: async () => ({ code: 1, stdout: "" }) }));
  assert.equal(map["t-archived"].excluded, "archived");
  assert.equal(map["t-archived"].archived, true);
  assert.equal(map["t-automation"].excluded, "automation");
  assert.equal(map["t-guardian"].excluded, "automation");
  assert.equal(map["t-subagent"].excluded, "automation");
  assert.equal(map["t-heartbeat"].excluded, "automation");
  assert.equal(map["t-heartbeat"].lastUserText, "real ask");
  assert.equal(map["t-heartbeat"].meta.heartbeat, true);
  assert.equal(map["t-automation"].meta.heartbeat, false);
  assert.equal(map["t-gone"].excluded, "no-repo");
  assert.equal(map["t-nogit"].excluded, "no-repo");
  assert.equal(map["t-forked"].excluded, null);
  assert.equal(map["t-old"], undefined, "threads outside the lookback are skipped");
});

test("listCodexThreads marks writer locks held by a live pid", async (t) => {
  const ctx = makeHome(t);
  const idleLines = [ev.started("x", 30 * MIN), ev.complete("x", 25 * MIN, "ok")];
  addThread(ctx, { id: "t-held", lines: idleLines });
  addThread(ctx, { id: "t-stale", lines: idleLines });
  addThread(ctx, { id: "t-dead", lines: idleLines });
  addThread(ctx, { id: "t-free", lines: idleLines });
  const lockDir = path.join(ctx.codexHome, "thread-writer-locks");
  for (const id of ["t-held", "t-stale", "t-dead"]) fs.writeFileSync(path.join(lockDir, `${id}.lock`), "");
  fs.writeFileSync(path.join(lockDir, ".coordination.lock"), "");

  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, args]);
    return {
      code: 1,
      stdout: `p8070\nf25\nn${path.join(lockDir, "t-held.lock")}\np9999\nf7\nn${path.join(lockDir, "t-dead.lock")}\n`,
      stderr: ""
    };
  };
  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run, isPidAlive: (pid) => pid === 8070 }));
  assert.equal(map["t-held"].writerLocked, true);
  assert.equal(map["t-stale"].writerLocked, false, "a lock file nobody holds is stale");
  assert.equal(map["t-dead"].writerLocked, false, "a holder pid that is gone does not lock");
  assert.equal(map["t-free"].writerLocked, false);
  assert.equal(calls.length, 1, "one lsof call covers every lock file");
  assert.equal(calls[0][0], "/fake/lsof");
  assert.ok(!calls[0][1].some((arg) => arg.includes(".coordination.lock")));
});

test("listCodexThreads treats locks as held when lsof cannot answer", async (t) => {
  const ctx = makeHome(t);
  addThread(ctx, { id: "t-held", lines: [ev.complete("x", 25 * MIN, "ok")] });
  fs.writeFileSync(path.join(ctx.codexHome, "thread-writer-locks", "t-held.lock"), "");
  const run = async () => ({ code: null, stdout: "", stderr: "", error: "spawn ENOENT" });
  const [thread] = await listCodexThreads(ctx.config, { now: NOW, run });
  assert.equal(thread.writerLocked, true);
});

test("listCodexThreads redacts and clamps untrusted text", async (t) => {
  const ctx = makeHome(t);
  const long = `token sk-ant-abcdefghijklmnopqrstuvwxyz ${"x".repeat(2000)}`;
  addThread(ctx, { id: "t-secret", name: `Title ${"y".repeat(300)}`, lines: [
    ev.user(`use CODEX_LB_API_KEY=supersecret please`, 40 * MIN), ev.started("s", 40 * MIN), ev.complete("s", 25 * MIN, long)
  ] });
  const [thread] = await listCodexThreads(ctx.config, { now: NOW, run: async () => ({ code: 1, stdout: "" }) });
  assert.doesNotMatch(thread.lastAgentText, /abcdefghijklmnop/);
  assert.ok(thread.lastAgentText.length <= ctx.config.limits.excerptMax);
  assert.doesNotMatch(thread.lastUserText, /supersecret/);
  assert.ok(thread.title.length <= ctx.config.limits.titleMax);
});

test("listCodexThreads ignores supervisor nudges and injected context when tracking the owner's last message", async (t) => {
  const ctx = makeHome(t);
  addThread(ctx, { id: "t-nudged", lines: [
    ev.user("owner asked for a fix", 90 * MIN), ev.complete("n0", 80 * MIN, "ok"),
    ev.userItem("[OpenAGI supervisor] Ready to merge? If not, get it ready.", 20 * MIN),
    ev.started("n1", 20 * MIN), ev.envContext(20 * MIN), ev.complete("n1", 15 * MIN, "working")
  ] });
  const [thread] = await listCodexThreads(ctx.config, { now: NOW, run: async () => ({ code: 1, stdout: "" }) });
  assert.equal(thread.lastUserText, "owner asked for a fix");
  assert.equal(thread.lastUserAt, iso(90 * MIN));
  assert.equal(thread.meta.lastSupervisorAt, iso(20 * MIN));
});

test("listCodexThreads returns [] without a state database and throws when it is broken", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-codex-empty-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = resolveFleetConfig({}, { home });
  assert.deepEqual(await listCodexThreads(config, { now: NOW }), []);
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(path.join(home, ".codex", "state_5.sqlite"), "not a database");
  // Unreadable is unknown, not empty: the supervisor records a source error.
  await assert.rejects(listCodexThreads(config, { now: NOW }));
});

test("listCodexThreads reports unknown when the rollout file is gone", async (t) => {
  const ctx = makeHome(t);
  addThread(ctx, { id: "t-missing", lines: null });
  const [thread] = await listCodexThreads(ctx.config, { now: NOW, run: async () => ({ code: 1, stdout: "" }) });
  assert.equal(thread.agentStatus, "unknown");
  assert.equal(thread.excluded, null);
});

test("parseRolloutTail tracks a pending structured question until the owner replies", () => {
  const text = (rows) => rows.map((row) => JSON.stringify(row)).join("\n");
  const pending = parseRolloutTail(text([ev.started("q", 10 * MIN), ev.ask("Reuse the branch?", 9 * MIN), ev.complete("q", 8 * MIN, "asked")]));
  assert.deepEqual(pending.pendingQuestion, { text: "Reuse the branch?", options: ["open thread"], at: iso(9 * MIN) });
  const answered = parseRolloutTail(text([
    ev.ask("Reuse the branch?", 9 * MIN),
    ev.user("<send_user_message_question_reply> [{\"answer\":\"Reuse the branch (recommended)\"}]", 5 * MIN)
  ]));
  assert.equal(answered.pendingQuestion, null);
  assert.equal(parseRolloutTail("").lifecycle, null);
  assert.equal(parseRolloutTail("{bad json\n").lifecycle, null);
});

test("listCodexThreads keeps a structured question's text and options", async (t) => {
  const ctx = makeHome(t);
  const ask = ev.ask("unused", 9 * MIN);
  ask.payload.arguments = JSON.stringify({ questions: [{ title: "Which plan?", options: [{ label: "Starter" }, { label: "Business annual (recommended)" }] }] });
  addThread(ctx, { id: "t-ask", lines: [ev.started("q", 10 * MIN), ask, ev.complete("q", 8 * MIN, "asked")] });
  addThread(ctx, { id: "t-free", lines: [ev.started("q", 10 * MIN), ev.ask("Reuse the branch?", 9 * MIN), ev.complete("q", 8 * MIN, "asked")] });
  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run: async () => ({ code: 1, stdout: "" }) }));
  assert.deepEqual(map["t-ask"].meta.pendingQuestion, { text: "Which plan?", options: ["Starter", "Business annual (recommended)"], at: iso(9 * MIN) });
  assert.deepEqual(map["t-free"].meta.pendingQuestion, { text: "Reuse the branch?", options: ["open thread"], at: iso(9 * MIN) });
});

test("cleanCodexUserText strips Codex Desktop wrappers", () => {
  assert.equal(cleanCodexUserText("<environment_context>\n<cwd>/x</cwd>\n</environment_context>"), "");
  assert.equal(cleanCodexUserText("# Files mentioned by the user:\n\n## a.png: /tmp/a.png\n## My request for Codex:\nship it"), "ship it");
  assert.equal(cleanCodexUserText("just text"), "just text");
});

function makeLogsDb(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-codex-logs-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".codex"));
  const db = new DatabaseSync(path.join(home, ".codex", "logs_2.sqlite"));
  db.exec(LOGS_SQL);
  const insert = db.prepare("INSERT INTO logs (ts, ts_nanos, level, target, feedback_log_body, thread_id) VALUES (?, 0, ?, ?, ?, ?)");
  const retry = (msAgo, error, threadId) => insert.run(sec(msAgo), "WARN", "codex_core::responses_retry",
    `session_loop{thread_id=${threadId}}: stream connection failed; waiting to retry turn_id=t error=${error}`, threadId);
  return { config: resolveFleetConfig({}, { home }), retry, insert };
}

test("readCodexLbErrors groups responses_retry rows by kind inside the window", async (t) => {
  const { config, retry, insert } = makeLogsDb(t);
  retry(5 * MIN, "Connection failed: error sending request retry_delay=5s", "th-1");
  retry(4 * MIN, "Connection failed: error sending request retry_delay=10s", "th-1");
  retry(3 * MIN, "stream disconnected before completion: failed to send websocket request: Connection closed normally", "th-2");
  retry(10 * MIN, "stream disconnected before completion: No available accounts. Service is operating in degraded mode: all upstream accounts are unavailable", "th-3");
  retry(12 * MIN, "unexpected status 401 Unauthorized: Incorrect API key provided: sk-svcac***fvMA", "th-4");
  retry(13 * MIN, "unexpected status 503 Service Unavailable: Server is draining, url: http://100.99.3.113:2455/backend-api/codex/responses", "th-5");
  retry(14 * MIN, "You've hit your usage limit. Try again at 9:25 AM.", "th-6");
  retry(15 * MIN, "something odd happened", null);
  retry(3 * 60 * MIN, "Connection failed: error sending request retry_delay=60s", "th-old");
  insert.run(sec(MIN), "WARN", "codex_features", "error=Connection failed", "th-9");

  const groups = await readCodexLbErrors(config, { now: NOW, windowMs: 60 * MIN });
  const map = Object.fromEntries(groups.map((group) => [group.kind, group]));
  assert.equal(map.connection.count, 3);
  assert.deepEqual(map.connection.threadIds.sort(), ["th-1", "th-2"]);
  assert.equal(map.connection.lastAt, new Date(sec(3 * MIN) * 1000).toISOString());
  assert.equal(map["no-accounts"].count, 1);
  assert.equal(map.auth.count, 1);
  assert.equal(map.unavailable.count, 1);
  assert.equal(map["usage-limit"].count, 1);
  assert.equal(map.other.count, 1);
  assert.deepEqual(map.other.threadIds, []);
  assert.equal(groups[0].kind, "connection", "largest group first");
  assert.ok(!JSON.stringify(groups).includes("sk-svcac"));
});

test("readCodexLbErrors degrades to [] without a log database", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-codex-nolog-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.deepEqual(await readCodexLbErrors(resolveFleetConfig({}, { home }), { now: NOW }), []);
});

test("classifyLbError maps real retry strings to kinds", () => {
  assert.equal(classifyLbError("error=stream disconnected before completion: Incorrect API key provided: sk-x"), "auth");
  assert.equal(classifyLbError("Missing environment variable: `CODEX_LB_API_KEY`."), "auth");
  assert.equal(classifyLbError("error=request timed out"), "connection");
  assert.equal(classifyLbError("error=unexpected status 502 Bad Gateway: Previous response owner account is unavailable"), "unavailable");
  assert.equal(classifyLbError("error=Transport error: timeout"), "connection");
});

function attach(ctx, threadId, number, { at, headBranch = null, repo = "buildbetter-app/buildbetter" }) {
  const [owner, name] = repo.split("/");
  ctx.db.prepare("INSERT INTO thread_attachments VALUES (?, ?, 'pull_request', ?, ?, ?)")
    .run(`${threadId}-${number}`, threadId, JSON.stringify(["github.com", owner, name, number]),
      JSON.stringify({ url: `https://github.com/${repo}/pull/${number}`, root: null, headBranch }), at);
}

test("listCodexThreads ranks the newest attached PR first and owner links last", async (t) => {
  const ctx = makeHome(t);
  const idle = (turn) => [ev.started(turn, 30 * MIN), ev.complete(turn, 25 * MIN, "ok")];
  addThread(ctx, { id: "t-own", branch: "feature/jiminny-import-guardrails", lines: [
    ev.userItem("<in-app-browser-context> Current URL: https://github.com/buildbetter-app/buildbetter/pull/6500 </in-app-browser-context>\n## My request for Codex:\nfix the import", 60 * MIN),
    ev.user("also see https://github.com/buildbetter-app/buildbetter/pull/6376", 40 * MIN),
    ...idle("o1")
  ] });
  attach(ctx, "t-own", 6630, { at: sec(300 * MIN), headBranch: "feature/jiminny-import-guardrails" });
  attach(ctx, "t-own", 6100, { at: sec(200 * MIN), headBranch: "bugfix/other" });
  attach(ctx, "t-own", 6200, { at: sec(250 * MIN) });

  // Three PRs attached in the same second, the lowest number inserted first.
  addThread(ctx, { id: "t-tie", lines: idle("t1") });
  for (const number of [4811, 6237, 6453]) attach(ctx, "t-tie", number, { at: sec(100 * MIN) });

  // Same second: the thread's own branch, then an unknown head, then another head.
  addThread(ctx, { id: "t-same", branch: "feature/own", lines: idle("s1") });
  attach(ctx, "t-same", 7003, { at: sec(100 * MIN), headBranch: "feature/other" });
  attach(ctx, "t-same", 7002, { at: sec(100 * MIN) });
  attach(ctx, "t-same", 7001, { at: sec(100 * MIN), headBranch: "feature/own" });

  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run: async () => ({ code: 1, stdout: "" }) }));
  assert.deepEqual(map["t-own"].prRefs, [
    "buildbetter-app/buildbetter#6100",
    "buildbetter-app/buildbetter#6200",
    "buildbetter-app/buildbetter#6630",
    "buildbetter-app/buildbetter#6376"
  ], "newest attachment first whatever its head; owner link last; no browser-context URL");
  assert.deepEqual(map["t-tie"].prRefs, [
    "buildbetter-app/buildbetter#6453",
    "buildbetter-app/buildbetter#6237",
    "buildbetter-app/buildbetter#4811"
  ]);
  assert.deepEqual(map["t-same"].prRefs, [
    "buildbetter-app/buildbetter#7001",
    "buildbetter-app/buildbetter#7002",
    "buildbetter-app/buildbetter#7003"
  ]);
});

test("a thread that moved past its branch's merged PR is about the newest attachment (#5442 -> #6453)", async (t) => {
  const ctx = makeHome(t);
  addThread(ctx, { id: "t-moved", branch: "feature/interactive-reports-consolidation", lines: [
    ev.started("m1", 30 * MIN), ev.ask("Set the credit price?", 26 * MIN), ev.complete("m1", 25 * MIN, "asked")
  ] });
  attach(ctx, "t-moved", 5442, { at: sec(14 * 24 * 60 * MIN), headBranch: "feature/interactive-reports-consolidation" });
  attach(ctx, "t-moved", 6625, { at: sec(12 * 24 * 60 * MIN) });
  for (const number of [4811, 6237, 6453]) attach(ctx, "t-moved", number, { at: sec(10 * 24 * 60 * MIN) });
  const [thread] = await listCodexThreads(ctx.config, { now: NOW, run: async () => ({ code: 1, stdout: "" }) });
  assert.equal(thread.prRefs[0], "buildbetter-app/buildbetter#6453");
  assert.equal(thread.prRefs.at(-1), "buildbetter-app/buildbetter#5442");
});

test("listCodexThreads dates activity from the last turn row, not settings writes", async (t) => {
  const ctx = makeHome(t);
  addThread(ctx, { id: "t-dormant", mtimeAgo: 5 * MIN, lines: [
    ev.started("d1", 27 * 24 * 60 * MIN + MIN), ev.complete("d1", 27 * 24 * 60 * MIN, "done"), ev.settings(5 * MIN)
  ] });
  addThread(ctx, { id: "t-reopened", mtimeAgo: 5 * MIN, lines: [
    ev.started("r1", 3 * 60 * MIN + MIN), ev.complete("r1", 3 * 60 * MIN, "done"), ev.settings(5 * MIN)
  ] });
  // A rollout with no turn row in its tail falls back to the file and catalog times.
  addThread(ctx, { id: "t-bare", mtimeAgo: 7 * MIN, updatedAgo: 9 * MIN, lines: [ev.settings(7 * MIN)] });

  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run: async () => ({ code: 1, stdout: "" }) }));
  assert.equal(map["t-dormant"], undefined, "a thread whose last turn was 27 days ago is outside the lookback");
  assert.equal(map["t-reopened"].lastActivityAt, iso(3 * 60 * MIN));
  assert.equal(map["t-reopened"].agentStatus, "idle");
  assert.equal(map["t-bare"].lastActivityAt, iso(7 * MIN));
});

test("listCodexThreads reads past excluded rows until it has maxThreads in-scope threads", async (t) => {
  const ctx = makeHome(t);
  // maxThreads 2 reads pages of 10 rows.
  const config = resolveFleetConfig({}, { home: ctx.home, bins: { lsof: "/fake/lsof" }, limits: { maxThreads: 2 } });
  const idleLines = [ev.started("x", 45 * MIN), ev.complete("x", 40 * MIN, "ok")];
  // Newer guardian reviews, all in one second so a page boundary splits the tie.
  for (let i = 0; i < 12; i += 1) addThread(ctx, { id: `t-guardian-${String(i).padStart(2, "0")}`, threadSource: "guardian_review", updatedAgo: 2 * MIN });
  // A settings-only reopen: a recent catalog row whose last turn is outside the lookback.
  addThread(ctx, { id: "t-dormant", mtimeAgo: 3 * MIN, lines: [
    ev.started("d1", 27 * 24 * 60 * MIN + MIN), ev.complete("d1", 27 * 24 * 60 * MIN, "done"), ev.settings(3 * MIN)
  ] });
  addThread(ctx, { id: "t-real-1", updatedAgo: 40 * MIN, mtimeAgo: 40 * MIN, lines: idleLines });
  addThread(ctx, { id: "t-real-2", updatedAgo: 50 * MIN, mtimeAgo: 50 * MIN, lines: idleLines });
  addThread(ctx, { id: "t-real-3", updatedAgo: 60 * MIN, mtimeAgo: 60 * MIN, lines: idleLines });

  const threads = await listCodexThreads(config, { now: NOW, run: async () => ({ code: 1, stdout: "" }) });
  assert.deepEqual(threads.filter((thread) => !thread.excluded).map((thread) => thread.id), ["t-real-1", "t-real-2"]);
  assert.equal(new Set(threads.map((thread) => thread.id)).size, threads.length, "no row is read twice across pages");
  assert.equal(threads.some((thread) => thread.id === "t-dormant"), false);
});

test("listCodexThreads exposes when an aborted turn was stopped", async (t) => {
  const ctx = makeHome(t);
  addThread(ctx, { id: "t-stopped", mtimeAgo: MIN, lines: [
    ev.user("rebase onto main", 30 * MIN + 29_000), ev.started("s1", 30 * MIN + 28_000), ev.aborted("s1", 30 * MIN), ev.settings(MIN)
  ] });
  addThread(ctx, { id: "t-done", lines: [ev.started("x", 30 * MIN), ev.complete("x", 25 * MIN, "ok")] });
  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run: async () => ({ code: 1, stdout: "" }) }));
  assert.equal(map["t-stopped"].agentStatus, "aborted");
  assert.equal(map["t-stopped"].meta.abortedAt, iso(30 * MIN));
  assert.equal(map["t-stopped"].lastActivityAt, iso(30 * MIN));
  assert.equal(map["t-stopped"].lastUserAt, iso(30 * MIN + 29_000));
  assert.equal(map["t-done"].meta.abortedAt, null);
});

test("structured questions preserve string and labeled options", () => {
  for (const options of [["Starter", "Business annual (recommended)"], [{ label: "Starter", description: "Basic" }, { label: "Business annual (recommended)" }]]) {
    const row = { type: "response_item", payload: { type: "function_call", name: "request_user_input_async", arguments: JSON.stringify({ questions: [{ title: "Which plan?", options }] }) } };
    assert.deepEqual(parseRolloutTail(JSON.stringify(row)).pendingQuestion, { text: "Which plan?", options: ["Starter", "Business annual (recommended)"], at: null });
  }
});

test("readCodexLbErrors: no log db is empty, an unreadable one throws", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-codex-logs-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".codex"));
  const config = resolveFleetConfig({}, { home });
  assert.deepEqual(await readCodexLbErrors(config, { now: NOW }), []);
  fs.writeFileSync(path.join(home, ".codex", "logs_2.sqlite"), "not a database, just bytes ".repeat(100));
  await assert.rejects(readCodexLbErrors(config, { now: NOW }));
});

test("listCodexThreads exposes the originator; Conductor-hosted threads type into Conductor, others into the Codex app", async (t) => {
  const ctx = makeHome(t);
  const idleLines = [ev.started("x", 30 * MIN), ev.complete("x", 25 * MIN, "ok")];
  addThread(ctx, { id: "t-desktop", lines: idleLines, name: "Fix uploads", originator: "Codex Desktop" });
  addThread(ctx, { id: "t-hosted", lines: idleLines, originator: "codex_sdk_ts" });
  addThread(ctx, { id: "t-orphan", lines: idleLines, originator: "codex_sdk_ts" });
  const run = async () => ({ code: 1, stdout: "", stderr: "" });
  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run }));
  assert.equal(map["t-desktop"].meta.originator, "Codex Desktop");
  assert.equal(map["t-hosted"].meta.originator, "codex_sdk_ts");

  const desktop = uiTargetFor(map["t-desktop"]);
  assert.equal(desktop.bundleId, "com.openai.codex");
  assert.equal(desktop.deepLink, "codex://threads/t-desktop");
  assert.doesNotMatch(desktop.deepLink, /prompt=/, "never pre-fills the composer");
  // Conductor-hosted Codex: no Conductor row, no app route.
  assert.equal(uiTargetFor(map["t-hosted"]), null);

  const host = {
    key: "conductor:s-host", kind: "conductor", id: "s-host", claudeSessionId: "t-hosted", workspace: "madrid", title: "Fix billing", archived: false,
    meta: { conductorWorkspaceId: "w-madrid", conductorSessionId: "s-host", conductorSessionTitle: "Fix billing", conductorWorkspaceSessions: 1 }
  };
  const linked = byId(linkUiHosts([map["t-hosted"], map["t-orphan"], map["t-desktop"], host]));
  const hosted = uiTargetFor(linked["t-hosted"]);
  assert.equal(hosted.bundleId, "com.conductor.app");
  assert.equal(hosted.deepLink, "conductor://workspace?id=w-madrid&session=s-host");
  assert.equal(hosted.targetKey, uiTargetFor(host).targetKey, "same app thread as the Conductor row");
  assert.equal(uiTargetFor(linked["t-orphan"]), null);
  assert.equal(linked["t-desktop"], map["t-desktop"], "other threads pass through untouched");
  assert.equal(map["t-hosted"].meta.conductorHost, undefined, "inputs are not mutated");
});

test("listCodexThreads flags a title shared with any unarchived Codex thread, even one outside the scan", async (t) => {
  const ctx = makeHome(t);
  const idleLines = [ev.started("x", 30 * MIN), ev.complete("x", 25 * MIN, "ok")];
  addThread(ctx, { id: "t-recent", lines: idleLines, name: "Fix uploads" });
  addThread(ctx, { id: "t-unique", lines: idleLines, name: "Ship billing" });
  // Weeks old, so outside the lookback, but still open in the Codex app.
  addThread(ctx, { id: "t-old", updatedAgo: 60 * 24 * 60 * MIN, name: "Fix uploads" });
  // Archived and Conductor-hosted copies are not in the Codex sidebar.
  addThread(ctx, { id: "t-archived", archived: 1, name: "Ship billing" });
  addThread(ctx, { id: "t-hosted-copy", originator: "codex_sdk_ts", name: "Ship billing" });
  const run = async () => ({ code: 1, stdout: "", stderr: "" });
  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run }));
  assert.equal(map["t-old"], undefined);
  assert.equal(uiTargetFor(map["t-recent"]).titleShared, true);
  assert.equal(uiTargetFor(map["t-unique"]).titleShared, false);
  const identity = uiIdentity(map["t-recent"], uiTargetFor(map["t-recent"]), Object.values(map));
  assert.equal(identity.ambiguous, true);
  assert.match(identity.reason, /share this title/);
});

// Bug 5: scheduled sweeps quote other chats' asks; they are not work threads.
test("listCodexThreads excludes codex exec sweeps and chat-checker runs as automation", async (t) => {
  const ctx = makeHome(t);
  const idleLines = [ev.started("x", 30 * MIN), ev.complete("x", 25 * MIN, "| chat | state |\n| Citations | Out of credits: answer with credits |")];
  const checker = "Current local time: 2026-09-28 07:00:02 PDT. Do not retry a chat before its visible reset time.\nYou are checking the user's existing agent chats after usage resets.";
  addThread(ctx, { id: "t-exec", source: "exec", title: "Current local time: 2026-09-28 07:00:02 PDT.", firstUserMessage: "Run one sweep.", lines: idleLines });
  addThread(ctx, { id: "t-checker", title: checker, firstUserMessage: checker, lines: idleLines });
  addThread(ctx, { id: "t-real", name: "Improve Slack huddle detection", lines: idleLines });
  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run: async () => ({ code: 1, stdout: "" }) }));
  assert.equal(map["t-exec"].excluded, "automation");
  assert.equal(map["t-checker"].excluded, "automation");
  assert.equal(map["t-real"].excluded, null);
  assert.equal(map["t-real"].meta.catalogName, "Improve Slack huddle detection");
  assert.equal(map["t-checker"].meta.catalogName, null);
});

test("a ciphertext structured-question title is replaced by the agent's words or a neutral line", async (t) => {
  const sealed = "gAAAAABqujkpRnnobDR_oyUGwgwolJFyyBdBHiotOEYKl36AQL4v-F48lnbJYWpMIJtvJ10DiQAS-pd8-cHA-mRJlrFUc54UcgVsoceW9MzzUOBh==";
  const text = (rows) => rows.map((row) => JSON.stringify(row)).join("\n");
  const bare = parseRolloutTail(text([ev.started("q", 10 * MIN), ev.ask(sealed, 9 * MIN)]));
  assert.equal(bare.pendingQuestion.text, "Codex asked in the app");
  assert.deepEqual(bare.pendingQuestion.options, ["open thread"]);

  const ctx = makeHome(t);
  const intro = `${"Checked the review notes. ".repeat(12)}Should I keep this as a report or fix it?`;
  addThread(ctx, { id: "t-sealed", lines: [ev.started("q", 10 * MIN), ev.assistant(intro, 9.5 * MIN), ev.ask(sealed, 9 * MIN), ev.complete("q", 8 * MIN, "asked")] });
  const [thread] = await listCodexThreads(ctx.config, { now: NOW, run: async () => ({ code: 1, stdout: "" }) });
  const pending = thread.meta.pendingQuestion;
  assert.doesNotMatch(pending.text, /gAAAAA/);
  // The stand-in keeps the end of the message, where the ask is.
  assert.match(pending.text, /Should I keep this as a report or fix it\?$/);
  assert.ok(pending.text.length <= ctx.config.limits.bodyMax);
});

const SEALED_TITLE = "gAAAAABqujkpRnnobDR_oyUGwgwolJFyyBdBHiotOEYKl36AQL4v-F48lnbJYWpMIJtvJ10DiQAS-pd8-cHA-mRJlrFUc54UcgVsoceW9MzzUOBh==";
const rollout = (rows) => rows.map((row) => JSON.stringify(row)).join("\n");

// Review 4/13: a sealed ask the agent talked past, or ended its turn on, is
// dropped unless the words standing in for it ask something.
test("a sealed ask the agent moved past is dropped unless its stand-in asks", () => {
  const status = "The type correction is committed as 6e94628a14. The functional regressions remain passing evidence.";
  const before = [ev.started("q", 30 * MIN), ev.assistant(status, 29 * MIN), ev.ask(SEALED_TITLE, 28 * MIN)];
  // #6896: a status line, the sealed ask, more work, then the handoff.
  const movedOn = parseRolloutTail(rollout([...before,
    ev.assistant("No additional user input is needed for the remaining checks.", 27 * MIN), ev.complete("q", 10 * MIN, "PR #6896 is code-complete and CI-green.")]));
  assert.equal(movedOn.pendingQuestion, null);
  // Ending the turn on it drops it too.
  assert.equal(parseRolloutTail(rollout([...before, ev.complete("q", 27 * MIN, null)])).pendingQuestion, null);
  // Nothing after it yet: it stays.
  assert.equal(parseRolloutTail(rollout(before)).pendingQuestion?.sealed, true);
  // The words before it ask something: it outlives more output and the turn end.
  const asking = parseRolloutTail(rollout([
    ev.started("q", 30 * MIN), ev.assistant(`${status} Should I keep this as a report or fix it?`, 29 * MIN), ev.ask(SEALED_TITLE, 28 * MIN),
    ev.assistant("I'll hold here for your answer.", 27 * MIN), ev.complete("q", 26 * MIN, "I'll hold here for your answer.")
  ]));
  assert.match(asking.pendingQuestion?.text ?? "", /Should I keep this as a report or fix it\?$/);
  // A readable structured ask is not dropped this way.
  const plain = parseRolloutTail(rollout([
    ev.started("q", 30 * MIN), ev.assistant(status, 29 * MIN), ev.ask("Reuse the branch?", 28 * MIN),
    ev.assistant("Carrying on with the checks.", 27 * MIN), ev.complete("q", 26 * MIN, "done")
  ]));
  assert.equal(plain.pendingQuestion?.text, "Reuse the branch?");
});

// Review 7: a sealed ask keeps the key its raw title gave it before it had a
// stand-in, so the owner's dismissal still matches; readable asks get none.
test("a sealed ask is keyed on its raw title, not on the stand-in text", async (t) => {
  const ctx = makeHome(t);
  const lines = (intro) => [ev.started("q", 10 * MIN), ev.assistant(intro, 9.5 * MIN), ev.ask(SEALED_TITLE, 9 * MIN), ev.complete("q", 8 * MIN, intro)];
  addThread(ctx, { id: "t-a", lines: lines("Checked the notes. Should I fix it?") });
  addThread(ctx, { id: "t-b", lines: lines("Other words this time. Want me to fix it?") });
  addThread(ctx, { id: "t-plain", lines: [ev.started("q", 10 * MIN), ev.ask("Reuse the branch?", 9 * MIN), ev.complete("q", 8 * MIN, "asked")] });
  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run: async () => ({ code: 1, stdout: "" }) }));
  const legacy = shortHash(clampText(SEALED_TITLE, ctx.config.limits.bodyMax));
  assert.notEqual(map["t-a"].meta.pendingQuestion.text, map["t-b"].meta.pendingQuestion.text);
  assert.equal(map["t-a"].meta.pendingQuestion.key, legacy);
  assert.equal(map["t-b"].meta.pendingQuestion.key, legacy);
  assert.equal(map["t-plain"].meta.pendingQuestion.key, undefined);
});

// Review 17: a title is ciphertext only with real base64 traits.
test("ciphertext titles need base64 traits; long slash paths stay readable", () => {
  const asked = (title) => parseRolloutTail(JSON.stringify(ev.ask(title, 5 * MIN))).pendingQuestion;
  const bytes = (n) => Buffer.from(Array.from({ length: n }, (_, index) => (index * 37 + 11) % 256));
  const long = bytes(160).toString("base64");
  const padded = bytes(73).toString("base64").replace(/\//g, "_");
  assert.ok(long.length >= 200 && long.includes("/"));
  assert.ok(padded.length < 200 && padded.endsWith("=="));
  for (const title of [SEALED_TITLE, long, padded]) assert.equal(asked(title).sealed, true, title);
  const readable = [
    "/Volumes/Xtra/codex-worktrees/f808/bbapp/packages/apps/web-app/src/components/reports/detail-view",
    "spencer/fleet-question-freshness-and-owner-labels-for-glasses-and-phone-follow-up-work",
    "keep_the_legacy_report_generator_running_until_the_new_pipeline_has_been_verified_on_staging"
  ];
  for (const title of readable) {
    assert.ok(title.length >= 80, title);
    assert.equal(asked(title).text, title);
    assert.equal(asked(title).sealed, undefined, title);
  }
});
