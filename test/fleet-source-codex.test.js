import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { uiIdentity } from "../src/fleet/ui-delivery.js";
import { clampText, linkUiHosts, resolveFleetConfig, shortHash, uiTargetFor } from "../src/fleet/contracts.js";
import {
  classifyLbError, cleanCodexUserText, listCodexThreads, parseCardReply, parseRolloutTail, readCodexLbErrors
} from "../src/fleet/sources/codex.js";
import { classifyThread } from "../src/fleet/classify.js";

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

// codex:01a0df66 is the G2 display chat the supervisor opened itself: it got
// 54 blocked "LB is up" nudges and showed in Watching.
test("listCodexThreads excludes the supervisor's own display thread", async (t) => {
  const ctx = makeHome(t);
  const idleLines = [ev.started("x", 30 * MIN), ev.complete("x", 25 * MIN, "Agent Supervisor connected — monitoring Codex and Claude Code.")];
  const display = "You are the Agent Supervisor display. Reply with exactly: Agent Supervisor connected — monitoring Codex and Claude Code.";
  addThread(ctx, { id: "01a0df66-b269-7540-81f5-592808f2e1f1", title: display, firstUserMessage: display, branch: "codex/checkpoint-before-openagi-redesign-20260912", lines: idleLines });
  addThread(ctx, { id: "t-real", name: "Improve Slack huddle detection", lines: idleLines });
  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run: async () => ({ code: 1, stdout: "" }) }));
  assert.equal(map["01a0df66-b269-7540-81f5-592808f2e1f1"].excluded, "self");
  assert.equal(map["t-real"].excluded, null);
});

function addThread(ctx, spec) {
  const {
    id, lines = null, mtimeAgo = 30 * MIN, updatedAgo = mtimeAgo, cwd = ctx.repoDir, archived = 0,
    threadSource = "user", source = "vscode", branch = "spencer/feature", origin = "git@github.com:buildbetter-app/buildbetter.git",
    name = null, title = "Fix the thing", firstUserMessage = "fix it", originator = null, segment = null
  } = spec;
  // segment: a continuation rollout, named <thread id>_<segment id>.
  const rollout = path.join(ctx.codexHome, "sessions", "2026", "09", "25", `rollout-2026-09-25T10-00-00-${id}${segment ? `_${segment}` : ""}.jsonl`);
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
  addThread(ctx, { id: "t-review", name: "Guardian", title: "Write the changelog entry", threadSource: "guardian_review", lines });
  addThread(ctx, { id: "t-beat", title: "Write the changelog entry", firstUserMessage: "<heartbeat> <automation_id>x</automation_id>", lines });
  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run: async () => ({ code: 1, stdout: "", stderr: "" }) }));
  assert.equal(map["t-audit"].meta.firstMessageTitle, "OpenAI just launched their GPT-6 models so for all of our Luna, Soul, and Terra agents");
  assert.notEqual(map["t-audit"].meta.codexFirstMessageShared, true);
  assert.equal(map["t-intruder"].meta.firstMessageTitle, "continue");
  assert.equal(map["t-same"].meta.firstMessageTitle, null, "same as the name");
  assert.equal(map["t-unnamed"].meta.firstMessageTitle, null, "no name: the title is already the label");
  assert.equal(map["t-a"].meta.codexFirstMessageShared, true, "another thread's name");
  assert.equal(map["t-b"].meta.codexFirstMessageShared, true, "another thread's first message, even outside the lookback");
  assert.notEqual(map["t-c"].meta.codexFirstMessageShared, true, "exec, archived, review and heartbeat threads are not in the sidebar");
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
  const long = `token sk-ant-${"a".repeat(26)} ${"x".repeat(2000)}`;
  addThread(ctx, { id: "t-secret", name: `Title ${"y".repeat(300)}`, lines: [
    ev.user(`use CODEX_LB_API_KEY=supersecret please`, 40 * MIN), ev.started("s", 40 * MIN), ev.complete("s", 25 * MIN, long)
  ] });
  const [thread] = await listCodexThreads(ctx.config, { now: NOW, run: async () => ({ code: 1, stdout: "" }) });
  assert.doesNotMatch(thread.lastAgentText, /sk-ant-a/);
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
  retry(13 * MIN, "unexpected status 503 Service Unavailable: Server is draining, url: http://192.0.2.10:2455/backend-api/codex/responses", "th-5");
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

test("readCodexLbErrors counts the fresh window apart from the hour", async (t) => {
  const { config, retry } = makeLogsDb(t);
  retry(50 * MIN, "Connection failed: error sending request retry_delay=5s", "th-1");
  retry(45 * MIN, "Connection failed: error sending request retry_delay=5s", "th-2");
  retry(2 * MIN, "Connection failed: error sending request retry_delay=5s", "th-1");
  const [connection] = await readCodexLbErrors(config, { now: NOW, windowMs: 60 * MIN });
  assert.equal(connection.count, 3);
  assert.deepEqual(connection.threadIds.sort(), ["th-1", "th-2"]);
  assert.equal(connection.freshCount, 1);
  assert.deepEqual(connection.freshThreadIds, ["th-1"]);
  // The fresh window is the lbErrorFreshMs limit.
  const wide = { ...config, limits: { ...config.limits, lbErrorFreshMs: 46 * MIN } };
  const [widened] = await readCodexLbErrors(wide, { now: NOW, windowMs: 60 * MIN });
  assert.equal(widened.freshCount, 2);
  assert.deepEqual(widened.freshThreadIds.sort(), ["th-1", "th-2"]);
  // A row with no readable time counts as fresh, never as recovered.
  const { config: odd, insert } = makeLogsDb(t);
  insert.run("garbage", "WARN", "codex_core::responses_retry", "error=Connection failed: error sending request", "th-3");
  const [unknown] = await readCodexLbErrors(odd, { now: NOW, windowMs: 60 * MIN });
  assert.equal(unknown.freshCount, 1);
  assert.deepEqual(unknown.freshThreadIds, ["th-3"]);
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

// Live 2026-09-30: the app labels a thread by its request, without the
// in-app browser block or files list, markdown rendered; a continuation
// rollout by that segment's first request, which the catalog lacks.
test("first-message labels are read as the app shows them, and a name another thread's label can show is shared", async (t) => {
  const ctx = makeHome(t);
  const lines = [ev.complete("x0", 20 * MIN, "done")];
  const browser = "<in-app-browser-context source=\"ambient-ui-state\">\nThis block is automatically supplied ambient UI state, not part of the user's request.\n# In app browser:\n- Current URL: https://github.com/buildbetter-app/buildbetter/pull/5768\n</in-app-browser-context>";
  addThread(ctx, { id: "t-plain", name: "Ship usage export", title: "this wont impact more users that dont use the success stuff correct?", lines });
  addThread(ctx, { id: "t-foleon", name: "Foleon (2)", title: `${browser}\n\n## My request:\nthis wont impact more users that dont use the success stuff correct?`, lines });
  addThread(ctx, { id: "t-files", name: "Upload transcripts", title: "# Files mentioned by the user:\n\n## shot.png: /tmp/shot.png\n\n## My request:\nI'm pretty sure we don't allow people to upload transcripts", lines });
  addThread(ctx, { id: "t-blocks", name: "Two blocks", title: "<environment_context>\n<cwd>/x</cwd>\n</environment_context>\n<in-app-browser-context source=\"ambient-ui-state\">\nCurrent URL: https://github.com/x\n</in-app-browser-context>\nship the onboarding checklist today", lines });
  addThread(ctx, { id: "t-legacy", name: "Fix CI imports", title: "# Files mentioned by the user:\n\n## a.png: /tmp/a.png\n## My request for Codex:\nplease fix the lint job on main", lines });
  addThread(ctx, { id: "t-md", name: "Posthog scope", title: "[posthog/posthog](https://github.com/posthog/posthog) Let me just scope out **the funnels**", lines });
  addThread(ctx, { id: "t-cont", name: "Build Jev speed demo", title: "Can you pull? I'm trying to do a demo, just pure demo mode", segment: "01a0cc96-8d86-7603-9d51-c26c28e0bfbb", lines });
  // A name that another thread's first message can show instead.
  addThread(ctx, { id: "t-named", name: "Plan the billing export", title: "Draft the rollout", lines });
  addThread(ctx, { id: "t-labels", name: "Rename bucket", title: "Plan the billing export", lines });
  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run: async () => ({ code: 1, stdout: "", stderr: "" }) }));
  assert.equal(map["t-foleon"].meta.firstMessageTitle, "this wont impact more users that dont use the success stuff correct?");
  assert.equal(map["t-plain"].meta.codexFirstMessageShared, true, "the same request with the in-app browser open");
  assert.equal(map["t-files"].meta.firstMessageTitle, "I'm pretty sure we don't allow people to upload transcripts");
  assert.equal(map["t-blocks"].meta.firstMessageTitle, "ship the onboarding checklist today", "every context block is dropped");
  assert.equal(map["t-legacy"].meta.firstMessageTitle, "please fix the lint job on main", "the older 'My request for Codex' header");
  assert.equal(map["t-md"].meta.firstMessageTitle, "posthog/posthog Let me just scope out the funnels");
  assert.equal(map["t-cont"].meta.firstMessageTitle, null, "a continuation segment's label is not in the catalog");
  assert.equal(map["t-named"].meta.codexTitleShared, true);
  assert.equal(uiIdentity(map["t-named"], uiTargetFor(map["t-named"]), [map["t-named"]]).shared, true);
});

// ---------- question cards (thread_history_1.sqlite) ----------

// The real thread_history_1.sqlite tables the card reader uses (verified
// with `.schema`), trimmed of other tables and indexes.
const HISTORY_SQL = `
  CREATE TABLE thread_turns (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL, status TEXT NOT NULL,
    error_json TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER, first_user_item_id TEXT, final_agent_item_id TEXT,
    rollout_byte_offset INTEGER, rollout_end_ordinal INTEGER, rollout_end_byte_offset INTEGER, root_turn_id TEXT, PRIMARY KEY (thread_id, turn_id));
  CREATE TABLE thread_items (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL, item_json TEXT NOT NULL, item_type TEXT NOT NULL DEFAULT '', updated_at_ordinal INTEGER NOT NULL DEFAULT 0,
    started_at_ms INTEGER, completed_at_ms INTEGER, PRIMARY KEY (thread_id, turn_id, item_id));
  CREATE UNIQUE INDEX idx_thread_items_page ON thread_items(thread_id, rollout_ordinal);
  CREATE INDEX idx_thread_items_user_messages ON thread_items(thread_id, rollout_ordinal) WHERE item_type = 'userMessage';
  CREATE TABLE thread_history_projection_state (thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER NOT NULL, next_rollout_ordinal INTEGER NOT NULL);`;

function makeHistory(ctx) {
  const db = new DatabaseSync(path.join(ctx.codexHome, "thread_history_1.sqlite"));
  db.exec(HISTORY_SQL);
  let ordinal = 0;
  const h = {
    db,
    // The projection caught up with the rollout file.
    project: (id, rollout, { offset = fs.statSync(rollout).size, ahead = 0 } = {}) => db.prepare("INSERT INTO thread_history_projection_state VALUES (?, ?, ?)").run(id, offset, ordinal + 1 + ahead),
    turn: (id, turnId) => {
      ordinal += 1;
      db.prepare("INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status) VALUES (?, ?, ?, 'inProgress')").run(id, turnId, ordinal);
    },
    user: (id, turnId, text, msAgo) => {
      ordinal += 1;
      const item = { type: "userMessage", id: `u${ordinal}`, content: [{ type: "text", text, text_elements: [] }] };
      db.prepare("INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type) VALUES (?, ?, ?, ?, ?, ?, 'userMessage')")
        .run(id, turnId, item.id, ordinal, NOW - msAgo, JSON.stringify(item));
    },
    // An async card item, as Codex Desktop records request_user_input_async.
    ask: (id, turnId, callId, questions, msAgo, text = questions.map((q) => q.title).join("\n")) => {
      ordinal += 1;
      const item = { type: "agentMessage", id: callId, text, phase: "final_answer", memoryCitation: null, delivery: "async", questions };
      db.prepare("INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type) VALUES (?, ?, ?, ?, ?, ?, 'agentMessage')")
        .run(id, turnId, callId, ordinal, NOW - msAgo, JSON.stringify(item));
    },
    agent: (id, turnId, text, msAgo) => {
      ordinal += 1;
      const item = { type: "agentMessage", id: `a${ordinal}`, text, phase: "commentary" };
      db.prepare("INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type) VALUES (?, ?, ?, ?, ?, ?, 'agentMessage')")
        .run(id, turnId, item.id, ordinal, NOW - msAgo, JSON.stringify(item));
    }
  };
  return h;
}

// The app's reply: every answered item of a card in one tagged list.
const cardReply = (answers) => `<send_user_message_question_reply>\n${JSON.stringify(answers.map(([callId, index, answer]) => ({
  questionItemId: JSON.stringify(["request_user_input_async", callId, index]), question: "q", answer
})))}\n</send_user_message_question_reply>\n`;
// Codex Desktop wraps typed text, the supervisor's too (ZeroShot line 4499).
const wrappedSupervisor = "\n<in-app-browser-context source=\"ambient-ui-state\">\n# In app browser:\n- Current URL: https://github.com/acme/app/pull/7549\n</in-app-browser-context>\n\n## My request:\n[OpenAGI supervisor] continue — get this across the finish line to merge.\n";
const FIVE = ["us-east-1", "us-west-2", "eu-west-1", "Confirm deletion of these five tracked threads", "ap-south-1"];

test("history cards: two calls in one turn, a multi-question call, five options, a reply that skipped an item", async (t) => {
  const ctx = makeHome(t);
  const h = makeHistory(ctx);
  // Running: the agent keeps working while the card is open.
  const rollout = addThread(ctx, { id: "t-card", mtimeAgo: MIN, lines: [ev.started("turn-a", 12 * MIN), ev.assistant("QA running", MIN)] });
  h.turn("t-card", "turn-a");
  h.user("t-card", "turn-a", "get PR #7549 merge ready and fully QA'd", 12 * MIN);
  h.ask("t-card", "turn-a", "call_one", [
    { title: "PR #7549 has no approval yet. Which reviewer should receive the review request?", options: ["Adam", "Nikhil"] },
    { title: "Anything else for the release notes?", options: null }
  ], 10 * MIN);
  h.agent("t-card", "turn-a", "Continuing QA meanwhile.", 9 * MIN);
  // The owner answered the first question and skipped the second (Skip is
  // local only): the reply closes both.
  h.user("t-card", "turn-a", cardReply([["call_one", 0, "Adam"]]), 8 * MIN);
  h.ask("t-card", "turn-a", "call_two", [{ title: "Which region should the QA profile use?", options: FIVE }], 6 * MIN);
  // A supervisor nudge, wrapped by Desktop: never an answer.
  h.turn("t-card", "turn-b");
  h.user("t-card", "turn-b", wrappedSupervisor, 4 * MIN);
  h.project("t-card", rollout);
  h.db.close();

  const thread = byId(await listCodexThreads(ctx.config, { now: NOW, run: async () => ({ code: 1, stdout: "" }) }))["t-card"];
  assert.equal(thread.agentStatus, "running");
  const card = thread.meta.pendingCard;
  assert.equal(card.app, "codex");
  assert.equal(card.cardId, "turn-a");
  assert.equal(card.count, 3);
  assert.deepEqual(card.items.map((item) => [item.index, item.itemId]), [[2, "call_two:0"]]);
  // Five options, the 46-character one whole.
  assert.deepEqual(card.items[0].options, FIVE);
  assert.equal(card.items[0].at, iso(6 * MIN));
  // Running, yet the card is the owner's.
  const classified = classifyThread(thread, { now: NOW, config: ctx.config });
  assert.equal(classified.state, "needs-human");
  assert.equal(classified.ask.card.cardId, "turn-a");
});

test("history cards: a new turn the owner typed closes the card; replies and supervisor turns do not", async (t) => {
  const ctx = makeHome(t);
  const h = makeHistory(ctx);
  const moved = addThread(ctx, { id: "t-moved", lines: [ev.started("x", 30 * MIN), ev.complete("x", 25 * MIN, "ok")] });
  h.turn("t-moved", "turn-a");
  h.user("t-moved", "turn-a", "start", 40 * MIN);
  h.ask("t-moved", "turn-a", "call_x", [{ title: "Use the staging credential?", options: ["Yes", "No"] }], 35 * MIN);
  h.turn("t-moved", "turn-b");
  h.user("t-moved", "turn-b", "\n<in-app-browser-context source=\"ambient-ui-state\">\nctx\n</in-app-browser-context>\n\n## My request:\nforget that, fix the header instead\n", 30 * MIN);
  h.project("t-moved", moved);
  // A card asked by a turn a reply started stays open across a supervisor turn.
  const kept = addThread(ctx, { id: "t-kept", lines: [ev.started("x", 30 * MIN), ev.complete("x", 25 * MIN, "ok")] });
  h.turn("t-kept", "turn-r");
  h.user("t-kept", "turn-r", cardReply([["call_old", 0, "fine"]]), 40 * MIN);
  h.ask("t-kept", "turn-r", "call_y", [{ title: "Which reviewer?", options: ["Adam", "Nikhil"] }], 35 * MIN);
  h.turn("t-kept", "turn-s");
  h.user("t-kept", "turn-s", "[OpenAGI supervisor] continue", 30 * MIN);
  h.project("t-kept", kept);
  h.db.close();
  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run: async () => ({ code: 1, stdout: "" }) }));
  assert.equal(map["t-moved"].meta.pendingCard, null);
  assert.deepEqual(map["t-kept"].meta.pendingCard.items.map((item) => item.itemId), ["call_y:0"]);
});

test("history cards: an automation thread's card is read; acknowledgements and asks with no questions are items too", async (t) => {
  const ctx = makeHome(t);
  const h = makeHistory(ctx);
  const auto = addThread(ctx, { id: "t-auto", threadSource: "automation", lines: [ev.started("x", 30 * MIN), ev.complete("x", 25 * MIN, "ok")] });
  h.turn("t-auto", "turn-a");
  h.user("t-auto", "turn-a", "Run the SkillRank twice-daily gate.", 40 * MIN);
  h.ask("t-auto", "turn-a", "call_del", [{ title: "May I permanently delete the tracked SkillRank posts?", options: ["Confirm qualifying tracked deletions", "Leave posts live"] }], 35 * MIN);
  h.project("t-auto", auto);
  const acks = addThread(ctx, { id: "t-acks", lines: [ev.started("x", 30 * MIN), ev.complete("x", 25 * MIN, "ok")] });
  h.turn("t-acks", "turn-a");
  h.user("t-acks", "turn-a", "QA it", 40 * MIN);
  h.ask("t-acks", "turn-a", "call_ok", [{ title: "I will use the existing native QA build.", options: ["Okay"] }], 35 * MIN);
  h.ask("t-acks", "turn-a", "call_cont", [{ title: "I have enough authorization for the scoped QA work.", options: ["Continue"] }], 34 * MIN);
  h.project("t-acks", acks);
  const bare = addThread(ctx, { id: "t-bare", lines: [ev.started("x", 30 * MIN), ev.complete("x", 25 * MIN, "ok")] });
  h.turn("t-bare", "turn-a");
  h.user("t-bare", "turn-a", "verify staging", 40 * MIN);
  h.ask("t-bare", "turn-a", "call_signin", [], 35 * MIN, "The local Staging token has expired. Please sign back into ZeroShot Staging.");
  h.project("t-bare", bare);
  h.db.close();
  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run: async () => ({ code: 1, stdout: "" }) }));
  assert.equal(map["t-auto"].excluded, "automation");
  assert.deepEqual(map["t-auto"].meta.pendingCard.items[0].options, ["Confirm qualifying tracked deletions", "Leave posts live"]);
  assert.equal(classifyThread(map["t-auto"], { now: NOW, config: ctx.config }).state, "needs-human");
  // Acknowledgements are read but ask nothing.
  assert.equal(map["t-acks"].meta.pendingCard.items.length, 2);
  assert.notEqual(classifyThread(map["t-acks"], { now: NOW, config: ctx.config }).state, "needs-human");
  assert.deepEqual(map["t-bare"].meta.pendingCard.items.map((item) => [item.itemId, item.question, item.options.length]),
    [["call_signin:0", "The local Staging token has expired. Please sign back into ZeroShot Staging.", 0]]);
});

test("cards fall back to the rollout tail without a projection or a readable history", async (t) => {
  const ctx = makeHome(t);
  const h = makeHistory(ctx);
  const cardItem = (callId, title, options, msAgo) => ({ timestamp: iso(msAgo), type: "event_msg", payload: { type: "item_completed", turn_id: "turn-a", item: {
    type: "AgentMessage", id: callId, content: [{ type: "Text", text: `${title}\n- ${options.join("\n- ")}` }], phase: "final_answer", delivery: "async", questions: [{ title, options }]
  } } });
  const call = (callId, title, options, msAgo) => ({ timestamp: iso(msAgo), type: "response_item", payload: {
    type: "function_call", name: "request_user_input_async", call_id: callId, arguments: JSON.stringify({ questions: [{ title, options }] }),
    internal_chat_message_metadata_passthrough: { turn_id: "turn-a" }
  } });
  const lines = [
    { timestamp: iso(20 * MIN), type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } },
    ev.userItem("check the build", 20 * MIN),
    call("call_q", "Should I keep the cache warm?", ["Keep it", "Drop it"], 15 * MIN),
    cardItem("call_q", "Should I keep the cache warm?", ["Keep it", "Drop it"], 15 * MIN),
    ev.assistant("Still building.", 14 * MIN),
    ev.user(wrappedSupervisor, 10 * MIN),
    ev.assistant("Build passed; waiting on your pick.", 5 * MIN)
  ];
  // No projection row: this thread's index cannot say.
  addThread(ctx, { id: "t-tail", lines });
  h.db.close();
  let thread = byId(await listCodexThreads(ctx.config, { now: NOW, run: async () => ({ code: 1, stdout: "" }) }))["t-tail"];
  assert.deepEqual(thread.meta.pendingCard.items.map((item) => [item.itemId, item.options]), [["call_q:0", ["Keep it", "Drop it"]]]);
  assert.equal(thread.meta.pendingCard.cardId, "turn-a");
  // The supervisor's wrapped "continue" neither answered nor counts as the owner.
  assert.equal(thread.meta.pendingQuestion?.text, "Should I keep the cache warm?");
  assert.equal(thread.lastUserText, "check the build");
  assert.ok(thread.meta.lastSupervisorAt);
  // The card's own text never stands in for the agent's words.
  assert.equal(thread.lastAgentText, "Build passed; waiting on your pick.");

  // An unreadable history file: every card comes from the tails.
  fs.writeFileSync(path.join(ctx.codexHome, "thread_history_1.sqlite"), "not a database");
  thread = byId(await listCodexThreads(ctx.config, { now: NOW, run: async () => ({ code: 1, stdout: "" }) }))["t-tail"];
  assert.equal(thread.meta.pendingCard.items[0].itemId, "call_q:0");

  // The tail reads the reply the same way: named items only.
  const answered = parseRolloutTail([...lines, ev.userItem(cardReply([["call_q", 0, "Keep it"]]), 2 * MIN)].map((line) => JSON.stringify(line)).join("\n"));
  assert.equal(answered.cardReplies[0].ids.has("call_q:0"), true);
  assert.equal(answered.pendingQuestion, null);
  assert.equal(answered.lastUser.text, "Answered a question card.");
});

test("parseCardReply reads only a message that is the tagged list", () => {
  assert.deepEqual(parseCardReply(cardReply([["call_a", 0, "x"], ["call_b", 1, "y"]])), ["call_a:0", "call_b:1"]);
  assert.equal(parseCardReply(`please see ${cardReply([["call_a", 0, "x"]])}`), null);
  assert.equal(parseCardReply("continue"), null);
  assert.deepEqual(parseCardReply("<send_user_message_question_reply>oops</send_user_message_question_reply>"), []);
});

// Tail rows of an async card: the call, then the card item (newer rollouts).
const tailCall = (callId, title, options, msAgo, turnId = "turn-a") => ({ timestamp: iso(msAgo), type: "response_item", payload: {
  type: "function_call", name: "request_user_input_async", call_id: callId, arguments: JSON.stringify({ questions: [{ title, options }] }),
  internal_chat_message_metadata_passthrough: { turn_id: turnId }
} });
const tailCardItem = (callId, title, options, msAgo, turnId = "turn-a") => ({ timestamp: iso(msAgo), type: "event_msg", payload: { type: "item_completed", turn_id: turnId, item: {
  type: "AgentMessage", id: callId, content: [{ type: "Text", text: `${title}\n- ${options.join("\n- ")}` }], phase: "final_answer", delivery: "async", questions: [{ title, options }]
} } });
const turnStart = (turnId, msAgo) => ({ timestamp: iso(msAgo), type: "event_msg", payload: { type: "task_started", turn_id: turnId } });
const noLocks = async () => ({ code: 1, stdout: "" });
const SEGMENT = "01a09c1f-5462-7000-8000-000000000001";

test("history cards: a lagging or overrun projection leaves the card to the tail; a segment is read under its own id", async (t) => {
  const ctx = makeHome(t);
  const h = makeHistory(ctx);
  const ask = "App Privacy is blocked by web sign-in. Please sign into that Safari tab with an Admin account.";
  // A rollout far past its projection (01a08c47: 88.9 MB of 747 MB indexed).
  const pad = ev.assistant("x".repeat(100_000), 40 * MIN);
  const tail = [pad, turnStart("turn-a", 20 * MIN), ev.userItem("ship the app", 20 * MIN), tailCall("call_sign", ask, [], 10 * MIN), tailCardItem("call_sign", ask, [], 10 * MIN)];
  const lagging = addThread(ctx, { id: "t-lag", lines: tail });
  h.turn("t-lag", "turn-old");
  h.user("t-lag", "turn-old", "older work", 60 * MIN);
  h.project("t-lag", lagging, { offset: 2_000 });
  // A projection past the end of the file (01a07d07: 1.2 GB on a 391 MB file).
  const overrun = addThread(ctx, { id: "t-over", lines: tail });
  h.project("t-over", overrun, { offset: fs.statSync(overrun).size + 1_000_000 });
  // A continuation segment: the thread's own projection stopped with the
  // older file, the segment's own is current and holds the ask.
  const segment = addThread(ctx, { id: "t-seg", segment: SEGMENT, lines: [pad, turnStart("turn-s", 20 * MIN), ev.assistant("Working.", 5 * MIN)] });
  h.project("t-seg", segment, { offset: 3_000 });
  h.turn(SEGMENT, "turn-s");
  h.user(SEGMENT, "turn-s", "check the app privacy page", 20 * MIN);
  h.ask(SEGMENT, "turn-s", "call_seg", [{ title: "Which Apple team should own it?", options: ["BuildBetter", "Personal"] }], 10 * MIN);
  h.project(SEGMENT, segment);
  h.db.close();
  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run: noLocks }));
  assert.deepEqual(map["t-lag"].meta.pendingCard?.items.map((item) => item.question), [ask]);
  assert.deepEqual(map["t-over"].meta.pendingCard?.items.map((item) => item.question), [ask]);
  assert.deepEqual(map["t-seg"].meta.pendingCard?.items.map((item) => item.itemId), ["call_seg:0"]);
});

test("history cards: a reply or an ask the projection has not reached yet is read from the tail", async (t) => {
  const ctx = makeHome(t);
  const h = makeHistory(ctx);
  const asked = [turnStart("turn-a", 30 * MIN), ev.userItem("QA it", 30 * MIN), tailCall("call_q", "Keep the cache warm?", ["Keep it", "Drop it"], 20 * MIN), tailCardItem("call_q", "Keep the cache warm?", ["Keep it", "Drop it"], 20 * MIN)];
  // Answered a moment ago: the reply is in the rollout, a few bytes past the projection.
  const answered = addThread(ctx, { id: "t-answered", lines: asked });
  const indexedAt = fs.statSync(answered).size;
  fs.appendFileSync(answered, `${JSON.stringify(ev.userItem(cardReply([["call_q", 0, "Keep it"]]), MIN))}\n`);
  // Unrelated agent rows past the projection leave the history card standing.
  const working = addThread(ctx, { id: "t-working", lines: asked });
  const workingAt = fs.statSync(working).size;
  fs.appendFileSync(working, `${JSON.stringify(ev.assistant("Still checking.", MIN))}\n`);
  for (const [id, rollout, offset] of [["t-answered", answered, indexedAt], ["t-working", working, workingAt]]) {
    h.turn(id, "turn-a");
    h.user(id, "turn-a", "QA it", 30 * MIN);
    h.ask(id, "turn-a", "call_q", [{ title: "Keep the cache warm? (indexed)", options: ["Keep it", "Drop it"] }], 20 * MIN);
    h.project(id, rollout, { offset });
  }
  h.db.close();
  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run: noLocks }));
  assert.equal(map["t-answered"].meta.pendingCard, null);
  assert.equal(map["t-working"].meta.pendingCard?.items[0].question, "Keep the cache warm? (indexed)");
});

test("tail cards: an owner's new turn closes them, a steer inside the ask's turn does not", async (t) => {
  const ctx = makeHome(t);
  const asked = [turnStart("turn-a", 30 * MIN), ev.userItem("QA it", 30 * MIN), tailCall("call_q", "Keep the cache warm?", ["Keep it", "Drop it"], 20 * MIN), tailCardItem("call_q", "Keep the cache warm?", ["Keep it", "Drop it"], 20 * MIN)];
  addThread(ctx, { id: "t-steer", lines: [...asked, { ...ev.userItem("also check the logs", 10 * MIN), payload: { type: "item_completed", turn_id: "turn-a", item: { type: "UserMessage", id: "u2", content: [{ type: "text", text: "also check the logs" }] } } }] });
  addThread(ctx, { id: "t-new", lines: [...asked, turnStart("turn-b", 10 * MIN), { timestamp: iso(10 * MIN), type: "event_msg", payload: { type: "item_completed", turn_id: "turn-b", item: { type: "UserMessage", id: "u3", content: [{ type: "text", text: "forget that, fix the header" }] } } }] });
  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run: noLocks }));
  assert.deepEqual(map["t-steer"].meta.pendingCard?.items.map((item) => item.itemId), ["call_q:0"]);
  assert.equal(map["t-new"].meta.pendingCard, null);
});

test("tail cards: an owner message with no turn id after the ask's turn ended closes them", async (t) => {
  // Older rollouts write the owner's words as a user_message event, no turn id.
  const ctx = makeHome(t);
  const asked = [turnStart("turn-a", 30 * MIN), ev.user("QA it", 30 * MIN), tailCall("call_q", "Keep the cache warm?", ["Keep it", "Drop it"], 20 * MIN), tailCardItem("call_q", "Keep the cache warm?", ["Keep it", "Drop it"], 20 * MIN)];
  addThread(ctx, { id: "t-steer-old", lines: [...asked, ev.user("also check the logs", 15 * MIN)] });
  addThread(ctx, { id: "t-moved-on", lines: [...asked, ev.complete("turn-a", 15 * MIN, "Waiting on your pick."), ev.user("forget that, fix the header", 10 * MIN)] });
  addThread(ctx, { id: "t-aborted", lines: [...asked, ev.aborted("turn-a", 15 * MIN), ev.user("forget that, fix the header", 10 * MIN)] });
  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run: noLocks }));
  assert.deepEqual(map["t-steer-old"].meta.pendingCard?.items.map((item) => item.itemId), ["call_q:0"]);
  assert.equal(map["t-moved-on"].meta.pendingCard, null);
  assert.equal(map["t-aborted"].meta.pendingCard, null);
});

test("history cards: a steer in the ask's own turn keeps the card; a reply closes items asked before it", async (t) => {
  const ctx = makeHome(t);
  const h = makeHistory(ctx);
  const rollout = addThread(ctx, { id: "t-hs", lines: [turnStart("turn-a", 30 * MIN), ev.assistant("QA running", MIN)] });
  h.turn("t-hs", "turn-a");
  h.user("t-hs", "turn-a", "QA it", 30 * MIN);
  h.ask("t-hs", "turn-a", "call_a", [{ title: "Keep the cache warm?", options: ["Keep it", "Drop it"] }], 20 * MIN);
  h.user("t-hs", "turn-a", "also check the logs", 10 * MIN);
  h.project("t-hs", rollout);
  // ZeroShot 01a126e5: the reply names call_60cdf103 only; call_5401b520,
  // asked earlier in the same card, was skipped.
  const skipped = addThread(ctx, { id: "t-skip", lines: [turnStart("turn-z", 30 * MIN), ev.assistant("Working", MIN)] });
  h.turn("t-skip", "turn-z");
  h.user("t-skip", "turn-z", "triage the inbox", 3 * 60 * MIN);
  h.ask("t-skip", "turn-z", "call_5401b520", [{ title: "ignore", options: ["Ignore", "Keep"] }], 140 * MIN);
  h.ask("t-skip", "turn-z", "call_60cdf103", [{ title: "Approve the fix?", options: ["Yes", "No"] }], 20 * MIN);
  h.user("t-skip", "turn-z", cardReply([["call_60cdf103", 0, "Yes"]]), 10 * MIN);
  h.project("t-skip", skipped);
  h.db.close();
  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run: noLocks }));
  assert.deepEqual(map["t-hs"].meta.pendingCard?.items.map((item) => item.itemId), ["call_a:0"]);
  assert.equal(map["t-skip"].meta.pendingCard, null);
});

test("history cards: the ask scan stops two days back and a bounded number of items back", async (t) => {
  const ctx = makeHome(t);
  const h = makeHistory(ctx);
  // No owner turn read: the scan would start at the thread's first item.
  const old = addThread(ctx, { id: "t-old", lines: [turnStart("turn-a", 30 * MIN), ev.assistant("Working", MIN)] });
  h.turn("t-old", "turn-a");
  h.ask("t-old", "turn-a", "call_old", [{ title: "Rotate the key?", options: ["Yes", "No"] }], 50 * 60 * MIN);
  h.project("t-old", old);
  const far = addThread(ctx, { id: "t-far", lines: [turnStart("turn-a", 30 * MIN), ev.assistant("Working", MIN)] });
  h.turn("t-far", "turn-a");
  h.ask("t-far", "turn-a", "call_far", [{ title: "Rotate the key?", options: ["Yes", "No"] }], 60 * MIN);
  // Thousands of items came after it.
  h.project("t-far", far, { ahead: 5_000 });
  h.db.close();
  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run: noLocks }));
  assert.equal(map["t-old"].meta.pendingCard, null);
  assert.equal(map["t-far"].meta.pendingCard, null);
});

test("tail cards: a card is never the agent's last words, in either rollout format", async (t) => {
  const ctx = makeHome(t);
  addThread(ctx, { id: "t-last", lines: [turnStart("turn-a", 30 * MIN), ev.assistant("Build passed.", 20 * MIN),
    tailCall("call_p", "Should I push the fix?", ["Push", "Hold"], 10 * MIN), tailCardItem("call_p", "Should I push the fix?", ["Push", "Hold"], 10 * MIN)] });
  // Older rollouts (019fe344) write the card as an async agent_message event.
  addThread(ctx, { id: "t-older", lines: [turnStart("turn-a", 30 * MIN), ev.assistant("Build passed.", 20 * MIN),
    tailCall("call_o", "Should I push the fix?", ["Push", "Hold"], 10 * MIN),
    { timestamp: iso(10 * MIN), type: "event_msg", payload: { type: "agent_message", message: "Should I push the fix?\n- Push\n- Continue", phase: "final_answer", delivery: "async", questions: [{ title: "Should I push the fix?", options: ["Push", "Hold"] }] } }] });
  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run: noLocks }));
  for (const id of ["t-last", "t-older"]) {
    assert.equal(map[id].lastAgentText, "Build passed.");
    assert.equal(map[id].lastAgentAt, iso(20 * MIN));
    assert.equal(map[id].meta.pendingCard.items.length, 1);
  }
});

test("carded automation and no-repo threads on pages past the in-scope stop are still read", async (t) => {
  const ctx = makeHome(t);
  const h = makeHistory(ctx);
  // maxThreads 2 reads pages of 10 rows: the first page fills the cap.
  const config = { ...ctx.config, limits: { ...ctx.config.limits, maxThreads: 2 } };
  for (let i = 0; i < 12; i += 1) addThread(ctx, { id: `t-${String(i).padStart(2, "0")}`, mtimeAgo: 10 * MIN, lines: [ev.complete("x", 10 * MIN, "done")] });
  const lines = [turnStart("turn-a", 100 * MIN), ev.assistant("Waiting on you.", 90 * MIN)];
  for (const [id, spec] of [["t-auto", { threadSource: "automation" }], ["t-norepo", { cwd: path.join(ctx.home, "gone") }], ["t-quiet", { threadSource: "automation" }]]) {
    const rollout = addThread(ctx, { id, mtimeAgo: 90 * MIN, lines, ...spec });
    h.turn(id, "turn-a");
    if (id !== "t-quiet") h.ask(id, "turn-a", `call_${id}`, [{ title: "May I delete the posts?", options: ["Confirm", "Leave"] }], 90 * MIN);
    h.project(id, rollout);
  }
  h.db.close();
  const map = byId(await listCodexThreads(config, { now: NOW, run: noLocks }));
  assert.equal(map["t-auto"]?.meta.pendingCard?.items[0].itemId, "call_t-auto:0");
  assert.equal(map["t-norepo"]?.excluded, "no-repo");
  assert.equal(map["t-norepo"].meta.pendingCard?.items[0].itemId, "call_t-norepo:0");
  assert.equal(map["t-quiet"], undefined, "a thread with no card past the stop is not built");
});

test("cards on automation and no-repo threads survive the cap; guardian reviews are never read for one", async (t) => {
  const ctx = makeHome(t);
  const config = { ...ctx.config, limits: { ...ctx.config.limits, maxThreads: 2 } };
  const card = (callId) => [turnStart("turn-a", 100 * MIN), tailCall(callId, "May I delete the posts?", ["Confirm", "Leave"], 90 * MIN)];
  for (const id of ["t-1", "t-2", "t-3"]) addThread(ctx, { id, mtimeAgo: 10 * MIN, lines: [ev.complete("x", 10 * MIN, "done")] });
  // Older than every in-scope thread.
  addThread(ctx, { id: "t-auto", threadSource: "automation", mtimeAgo: 90 * MIN, lines: card("call_auto") });
  addThread(ctx, { id: "t-norepo", cwd: path.join(ctx.home, "gone"), mtimeAgo: 90 * MIN, lines: card("call_norepo") });
  addThread(ctx, { id: "t-guard", threadSource: "guardian_review", mtimeAgo: 90 * MIN, lines: card("call_guard") });
  const map = byId(await listCodexThreads(config, { now: NOW, run: noLocks, history: null }));
  assert.ok(map["t-auto"], "carded automation thread kept");
  assert.ok(map["t-norepo"], "carded no-repo thread kept");
  assert.equal(map["t-norepo"].excluded, "no-repo");
  assert.equal(classifyThread(map["t-norepo"], { now: NOW, config }).state, "needs-human");
  const all = byId(await listCodexThreads(ctx.config, { now: NOW, run: noLocks, history: null }));
  assert.equal(all["t-guard"].excluded, "automation");
  assert.equal(all["t-guard"].meta.pendingCard, null);
  assert.equal(all["t-auto"].meta.pendingCard.items[0].itemId, "call_auto:0");
});

test("cards are found every page past the in-scope stop, down to the lookback, and the final page is not read twice", async (t) => {
  const ctx = makeHome(t);
  const h = makeHistory(ctx);
  // maxThreads 2 reads pages of 10 rows: the first page fills the cap and
  // three more full pages of in-scope rows sit between it and the cards.
  const config = { ...ctx.config, limits: { ...ctx.config.limits, maxThreads: 2 } };
  for (let i = 0; i < 40; i += 1) addThread(ctx, { id: `t-${String(i).padStart(2, "0")}`, mtimeAgo: (10 + i) * MIN, lines: [ev.complete("x", (10 + i) * MIN, "done")] });
  const lines = [turnStart("turn-a", 100 * MIN), ev.assistant("Waiting on you.", 90 * MIN)];
  for (const [id, spec] of [["t-auto", { threadSource: "automation" }], ["t-repo", {}]]) {
    const rollout = addThread(ctx, { id, mtimeAgo: 90 * MIN, lines, ...spec });
    h.turn(id, "turn-a");
    h.ask(id, "turn-a", `call_${id}`, [{ title: "May I delete the posts?", options: ["Confirm", "Leave"] }], 90 * MIN);
    h.project(id, rollout);
  }
  h.db.close();
  const threads = await listCodexThreads(config, { now: NOW, run: noLocks });
  const map = byId(threads);
  assert.equal(map["t-auto"]?.meta.pendingCard?.items[0].itemId, "call_t-auto:0");
  assert.equal(map["t-repo"]?.excluded, null);
  assert.equal(map["t-repo"].meta.pendingCard?.items[0].itemId, "call_t-repo:0");
  assert.equal(threads.filter((thread) => thread.id === "t-repo").length, 1);
});

test("an in-scope thread with an open card survives the cap", async (t) => {
  const ctx = makeHome(t);
  const config = { ...ctx.config, limits: { ...ctx.config.limits, maxThreads: 2 } };
  for (const id of ["t-1", "t-2", "t-3"]) addThread(ctx, { id, mtimeAgo: 10 * MIN, lines: [ev.complete("x", 10 * MIN, "done")] });
  addThread(ctx, { id: "t-carded", mtimeAgo: 90 * MIN, lines: [turnStart("turn-a", 100 * MIN), tailCall("call_q", "Which region?", ["us-east-1", "eu-west-1"], 90 * MIN)] });
  addThread(ctx, { id: "t-plain", mtimeAgo: 90 * MIN, lines: [ev.complete("x", 90 * MIN, "done")] });
  const map = byId(await listCodexThreads(config, { now: NOW, run: noLocks, history: null }));
  assert.equal(map["t-carded"]?.excluded, null);
  assert.equal(map["t-carded"].meta.pendingCard?.items[0].itemId, "call_q:0");
  assert.equal(map["t-plain"], undefined, "an in-scope thread with no card is still capped");
  assert.equal(map["t-1"], undefined);
});

test("the card scan past the in-scope stop reports which threads it settled", async (t) => {
  const ctx = makeHome(t);
  const h = makeHistory(ctx);
  const config = { ...ctx.config, limits: { ...ctx.config.limits, maxThreads: 2 } };
  for (let i = 0; i < 10; i += 1) addThread(ctx, { id: `t-${String(i).padStart(2, "0")}`, mtimeAgo: (10 + i) * MIN, lines: [ev.complete("x", (10 + i) * MIN, "done")] });
  const lines = [turnStart("turn-a", 100 * MIN), ev.assistant("Waiting on you.", 90 * MIN)];
  // t-open still asks; t-answered's card was answered in the app; the
  // history index never projected t-unindexed, so its card is unknown.
  for (const id of ["t-open", "t-answered", "t-unindexed"]) {
    const rollout = addThread(ctx, { id, mtimeAgo: 90 * MIN, lines, threadSource: "automation" });
    if (id === "t-unindexed") continue;
    h.turn(id, "turn-a");
    h.ask(id, "turn-a", `call_${id}`, [{ title: "May I delete the posts?", options: ["Confirm", "Leave"] }], 90 * MIN);
    if (id === "t-answered") h.user(id, "turn-a", cardReply([[`call_${id}`, 0, "Leave"]]), 80 * MIN);
    h.project(id, rollout);
  }
  h.db.close();
  const cardScanned = new Set();
  const map = byId(await listCodexThreads(config, { now: NOW, run: noLocks, cardScanned }));
  assert.equal(map["t-open"]?.meta.pendingCard?.items[0].itemId, "call_t-open:0");
  assert.equal(map["t-answered"], undefined);
  assert.ok(cardScanned.has("codex:t-open"));
  assert.ok(cardScanned.has("codex:t-answered"), "no card open: a card question on it may close");
  assert.ok(!cardScanned.has("codex:t-unindexed"), "a card the index cannot read stays unknown");
  assert.ok(cardScanned.has("codex:t-00"), "rows read before the stop are settled too");
});

test("a bounded tail without its history index leaves older cards unknown", async (t) => {
  const ctx = makeHome(t);
  addThread(ctx, { id: "t-long", mtimeAgo: 5 * MIN, lines: [turnStart("turn-a", 30 * MIN),
    tailCall("old-card", "Which implementation?", ["A", "B"], 20 * MIN),
    ...Array.from({ length: 80 }, () => ev.tokens(5 * MIN))] });
  addThread(ctx, { id: "t-short", mtimeAgo: 10 * MIN, lines: [ev.complete("done", 10 * MIN, "Finished.")] });
  const cardScanned = new Set();
  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run: noLocks, history: null, tailBytes: 1024, cardScanned }));
  assert.equal(map["t-long"].meta.pendingCard, null, "the older card is outside the read tail");
  assert.equal(cardScanned.has("codex:t-long"), false, "absence from an incomplete read must not close a known question");
  assert.equal(cardScanned.has("codex:t-short"), true, "a complete rollout can establish no open card");
});

test("history cards: supervisor rows filling the newest user rows never hide an older open ask", async (t) => {
  const ctx = makeHome(t);
  const h = makeHistory(ctx);
  const rollout = addThread(ctx, { id: "t-busy", lines: [turnStart("turn-a", 300 * MIN), ev.assistant("Working", MIN)] });
  h.turn("t-busy", "turn-a");
  h.user("t-busy", "turn-a", "ship it", 300 * MIN);
  h.ask("t-busy", "turn-a", "call_done", [{ title: "Use staging?", options: ["Yes", "No"] }], 290 * MIN);
  h.user("t-busy", "turn-a", cardReply([["call_done", 0, "Yes"]]), 285 * MIN);
  h.ask("t-busy", "turn-a", "call_open", [{ title: "Which reviewer?", options: ["Adam", "Nikhil"] }], 280 * MIN);
  // Sixty supervisor turns since: none closes the ask, none is the owner's.
  for (let i = 0; i < 60; i += 1) {
    h.turn("t-busy", `turn-s${i}`);
    h.user("t-busy", `turn-s${i}`, "[OpenAGI supervisor] continue", (270 - i * 4) * MIN);
  }
  h.project("t-busy", rollout);
  h.db.close();
  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run: noLocks }));
  // The answered ask stays closed: its reply is read across the scan too.
  assert.deepEqual(map["t-busy"].meta.pendingCard?.items.map((item) => item.itemId), ["call_open:0"]);
});

test("history cards: an ask left open across a supervisor turn stays on the card beside a newer turn's", async (t) => {
  const ctx = makeHome(t);
  const h = makeHistory(ctx);
  for (const id of ["t-both", "t-later-answered"]) {
    const rollout = addThread(ctx, { id, lines: [turnStart("turn-s", 20 * MIN), ev.assistant("Working", MIN)] });
    h.turn(id, "turn-a");
    h.user(id, "turn-a", "QA it", 40 * MIN);
    h.ask(id, "turn-a", "call_a", [{ title: "Keep the cache warm?", options: ["Keep it", "Drop it"] }], 35 * MIN);
    h.turn(id, "turn-s");
    h.user(id, "turn-s", "[OpenAGI supervisor] continue", 20 * MIN);
    h.ask(id, "turn-s", "call_b", [{ title: "Which region?", options: ["us-east-1", "eu-west-1"] }], 15 * MIN);
    if (id === "t-later-answered") h.user(id, "turn-s", cardReply([["call_b", 0, "us-east-1"]]), 10 * MIN);
    h.project(id, rollout);
  }
  h.db.close();
  const map = byId(await listCodexThreads(ctx.config, { now: NOW, run: noLocks }));
  const both = map["t-both"].meta.pendingCard;
  assert.equal(both.cardId, "turn-s");
  assert.deepEqual(both.items.map((item) => item.itemId), ["call_a:0", "call_b:0"]);
  // Answering the newer turn's card leaves the older turn's ask open.
  assert.deepEqual(map["t-later-answered"].meta.pendingCard?.items.map((item) => item.itemId), ["call_a:0"]);
});

test("cards past the in-scope stop are read from the rollout tail when the history index cannot say", async (t) => {
  for (const withHistory of [false, true]) {
    const ctx = makeHome(t);
    // With an index that never projected t-auto, or with none at all.
    if (withHistory) makeHistory(ctx).db.close();
    const config = { ...ctx.config, limits: { ...ctx.config.limits, maxThreads: 2 } };
    for (let i = 0; i < 12; i += 1) addThread(ctx, { id: `t-${String(i).padStart(2, "0")}`, mtimeAgo: 10 * MIN, lines: [ev.complete("x", 10 * MIN, "done")] });
    addThread(ctx, { id: "t-auto", threadSource: "automation", mtimeAgo: 90 * MIN, lines: [turnStart("turn-a", 100 * MIN),
      tailCall("call_auto", "May I delete the posts?", ["Confirm", "Leave"], 90 * MIN), tailCardItem("call_auto", "May I delete the posts?", ["Confirm", "Leave"], 90 * MIN)] });
    addThread(ctx, { id: "t-quiet", threadSource: "automation", mtimeAgo: 90 * MIN, lines: [turnStart("turn-a", 100 * MIN), ev.assistant("Done.", 90 * MIN)] });
    const cardScanned = new Set();
    const map = byId(await listCodexThreads(config, { now: NOW, run: noLocks, cardScanned }));
    assert.equal(map["t-auto"]?.meta.pendingCard?.items[0].itemId, "call_auto:0", `history: ${withHistory}`);
    assert.equal(map["t-quiet"], undefined);
    // A tail read never settles a card the index could not.
    assert.ok(!cardScanned.has("codex:t-auto"));
  }
});
