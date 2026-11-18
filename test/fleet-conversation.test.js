import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { boundConversation, claudeConversation, codexConversation, readThreadConversation } from "../src/fleet/conversation.js";
import { createFleetRoute } from "../src/fleet/routes.js";

const at = "2026-10-26T10:00:00Z";
const lines = (rows) => rows.map((row) => JSON.stringify({ timestamp: at, ...row })).join("\n");

test("Codex context retains both sides and questions, without injected context or duplicate replies", () => {
  const messages = codexConversation(lines([
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "SYSTEM CONTEXT" }] } },
    { type: "event_msg", payload: { type: "user_message", message: "<environment_context>ignore</environment_context>\n## My request:\nWhy is prep failing?" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "I found the rejected request." }] } },
    { type: "event_msg", payload: { type: "agent_message", message: "I found the rejected request." } },
    { type: "event_msg", payload: { type: "task_complete", last_agent_message: "I found the rejected request." } },
    { type: "response_item", payload: { type: "function_call", name: "request_user_input_async", arguments: JSON.stringify({ questions: [{ title: "Which workspace?", options: ["Production", "Staging"] }] }) } },
    { type: "event_msg", payload: { type: "user_message", message: "Production" } },
  ]));
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "assistant", "user"]);
  assert.equal(messages[0].text, "Why is prep failing?");
  assert.match(messages[2].text, /Which workspace\?\n• Production/);
  assert.ok(!JSON.stringify(messages).includes("SYSTEM CONTEXT"));
});

test("Codex history excludes supervisor and heartbeat prompts in both user event formats", () => {
  const inputs = ["Explain the status", "[OpenAGI supervisor] Continue", "## My request:\n[OpenAGI supervisor] Check again",
    "<heartbeat>Scheduled check</heartbeat>", "<automation_id>scheduled-check</automation_id> Continue", "Show the result"];
  for (const itemFormat of [false, true]) {
    const messages = codexConversation(lines(inputs.map((message) => ({ type: "event_msg", payload: itemFormat
      ? { type: "item_completed", item: { type: "UserMessage", content: [{ type: "Text", text: message }] } }
      : { type: "user_message", message } }))));
    assert.deepEqual(messages.map((m) => m.text), ["Explain the status", "Show the result"]);
  }
});

test("Claude context displays text, excluding thinking, tool results and system injections", () => {
  const messages = claudeConversation(lines([
    { type: "user", message: { content: "Explain this task" } },
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "Here is the context." }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "raw tool output" }] } },
    { type: "user", isMeta: true, message: { content: "system prompt" } },
  ]));
  assert.deepEqual(messages.map((m) => m.text), ["Explain this task", "Here is the context."]);
});

test("Claude context attributes only owner prompts to the user", () => {
  const nonOwnerRows = [
    { isMeta: true },
    { isCompactSummary: true },
    { promptSource: "system" },
    ...["task_notification", "peer", "system", "scheduled"].map((turnOrigin) => ({ turnOrigin })),
    ...["task-notification", "peer"].map((kind) => ({ origin: { kind } })),
  ].map((metadata) => ({ type: "user", message: { content: "Another Claude session sent a message: internal context" }, ...metadata }));
  const messages = claudeConversation(lines([
    { type: "user", promptSource: "typed", origin: { kind: "human" }, message: { content: "What needs review?" } },
    ...nonOwnerRows,
    { type: "user", promptSource: "sdk", message: { content: "[OpenAGI supervisor] Continue the task." } },
    { type: "user", message: { content: "Show me the latest answer." } },
  ]));
  assert.deepEqual(messages.map((m) => m.text), ["What needs review?", "Show me the latest answer."]);
});

test("Claude history includes session-socket replies without exposing other tool inputs", () => {
  const sent = (to, message) => ({ type: "tool_use", name: "SendMessage", input: { to, message } });
  const messages = claudeConversation(lines([
    { type: "user", message: { content: "What is the status?" } },
    { type: "assistant", message: { content: [{ type: "text", text: "Earlier status." }] } },
    { type: "assistant", message: { content: [sent("uds:/tmp/session.sock", "The fix is ready.")] } },
    { type: "assistant", message: { content: [{ type: "text", text: "I'll send the update." }, sent("uds:/tmp/session.sock", "The tests passed.")] } },
    { type: "assistant", message: { content: [sent("another-agent", "Private agent instructions")] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "private command" } }] } },
  ]));
  assert.deepEqual(messages.map((m) => m.text), ["What is the status?", "Earlier status.", "The fix is ready.", "The tests passed."]);
  assert.equal(messages.at(-1).role, "assistant");
});

test("Claude history retains owner-visible question tools and their choices", () => {
  const question = (name) => ({ type: "tool_use", name, input: { questions: [
    { question: "Which implementation?", options: ["A", { label: "B", description: "Alternative" }] },
    { question: "When should it ship?", options: ["Now", "Later"] },
  ] } });
  const messages = claudeConversation(lines([
    { type: "assistant", message: { content: [{ type: "text", text: "Earlier discussion." }] } },
    { type: "assistant", message: { content: [question("AskUserQuestion")] } },
    { type: "assistant", message: { content: [{ type: "text", text: "One more decision." }, question("mcp__conductor__AskUserQuestion")] } },
  ]));
  assert.equal(messages[1].text, "Which implementation?\n• A\n• B\n\nWhen should it ship?\n• Now\n• Later");
  assert.equal(messages[2].text, `One more decision.\n\n${messages[1].text}`);
});

test("conversation payloads have a bounded recent window and explicit truncation", () => {
  const messages = Array.from({ length: 100 }, (_, i) => ({ role: "user", text: `Message ${i}`, at }));
  const bounded = boundConversation(messages);
  assert.equal(bounded.messages.length, 80);
  assert.equal(bounded.messages[0].text, "Message 20");
  assert.equal(new Set(bounded.messages.map((m) => m.id)).size, 80);
  assert.equal(bounded.truncated, true);
  const long = boundConversation(messages.map((m) => ({ ...m, text: "x".repeat(20_000) })));
  assert.ok(JSON.stringify(long).length < 130_000);
  assert.equal(long.truncated, true);
});

test("conversation text uses the fleet's existing secret redaction", () => {
  const token = "ghp_" + "a".repeat(40);
  const messages = codexConversation(lines([{ type: "event_msg", payload: { type: "agent_message", message: `Use ${token}` } }]));
  assert.ok(!JSON.stringify(messages).includes(token));
});

test("Conductor history is scoped to one session and excludes canceled/forwarded prompts", async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); } catch { t.skip("node:sqlite unavailable"); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-conductor-context-"));
  const file = path.join(dir, "conductor.db");
  const db = new DatabaseSync(file);
  try {
    db.exec("CREATE TABLE session_messages (session_id TEXT, role TEXT, content TEXT, created_at TEXT, sent_at TEXT, cancelled_at TEXT, sender_session_id TEXT, sender_api_key_name TEXT)");
    const insert = db.prepare("INSERT INTO session_messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run("chosen", "user", "Explain the task", at, at, null, null, null);
    insert.run("chosen", "assistant", JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "The task needs review." }] } }), at, at, null, null, null);
    insert.run("other", "user", "Another thread", at, at, null, null, null);
    insert.run("chosen", "user", "Canceled prompt", at, at, at, null, null);
    insert.run("chosen", "user", "Forwarded prompt", at, at, null, "other", null);
    insert.run("chosen", "user", "  [OpenAGI supervisor] Continue the task", at, at, null, null, null);
    const result = await readThreadConversation({ kind: "conductor", id: "chosen" }, { paths: { conductorDb: file } });
    assert.deepEqual(result.messages.map((m) => m.text), ["Explain the task", "The task needs review."]);
    assert.equal(result.unavailableReason, null);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Conductor history retains session-socket replies after earlier messages", async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import("node:sqlite")); } catch { t.skip("node:sqlite unavailable"); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-conductor-relay-context-"));
  const file = path.join(dir, "conductor.db");
  const db = new DatabaseSync(file);
  try {
    db.exec("CREATE TABLE session_messages (session_id TEXT, role TEXT, content TEXT, created_at TEXT, sent_at TEXT, cancelled_at TEXT, sender_session_id TEXT, sender_api_key_name TEXT)");
    const insert = db.prepare("INSERT INTO session_messages VALUES (?, 'assistant', ?, ?, ?, NULL, NULL, NULL)");
    const add = (content, parent = null) => insert.run("chosen", JSON.stringify({ type: "assistant", parent_tool_use_id: parent, message: { content } }), at, at);
    const sent = (to, message) => ({ type: "tool_use", name: "SendMessage", input: { to, message } });
    add([{ type: "text", text: "Earlier status." }]);
    add([sent("uds:/tmp/session.sock", "The fix is ready.")]);
    add([{ type: "text", text: "I'll send the update." }, sent("uds:/tmp/session.sock", "The tests passed.")]);
    add([sent("another-agent", "Private agent instructions")]);
    add([sent("uds:/tmp/session.sock", "Nested agent reply")], "parent-tool");
    const question = { type: "tool_use", name: "mcp__conductor__AskUserQuestion", input: { questions: [{ question: "Ship it?", options: ["Ship", { label: "Hold" }] }] } };
    add([question]);
    add([{ type: "text", text: "Private nested discussion" }, { ...question, input: { questions: [{ question: "Which branch?", options: ["Main", "Feature"] }] } }], "parent-tool");
    const result = await readThreadConversation({ kind: "conductor", id: "chosen" }, { paths: { conductorDb: file } });
    assert.deepEqual(result.messages.map((m) => m.text), ["Earlier status.", "The fix is ready.", "The tests passed.", "Ship it?\n• Ship\n• Hold", "Which branch?\n• Main\n• Feature"]);
    assert.ok(result.messages.every((m) => m.role === "assistant"));
    assert.equal(result.unavailableReason, null);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a scanned Codex rollout supplies a readable exchange without changing its file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-context-"));
  try {
    const file = path.join(dir, "thread.jsonl");
    const content = lines([
      { type: "event_msg", payload: { type: "user_message", message: "What is blocked?" } },
      { type: "event_msg", payload: { type: "agent_message", message: "The review needs a decision." } },
    ]);
    fs.writeFileSync(file, content);
    const result = await readThreadConversation({ kind: "codex", meta: { file } }, {});
    assert.deepEqual(result.messages.map((m) => m.role), ["user", "assistant"]);
    assert.equal(result.unavailableReason, null);
    assert.equal(fs.readFileSync(file, "utf8"), content);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("detail reads history only after resolving an existing scanned thread", async () => {
  const reads = [];
  const route = createFleetRoute({ supervisor: {
    threadDetail: (key) => key === "codex:known" ? { key } : null,
    threadConversation: (key) => { reads.push(key); return boundConversation([{ role: "user", text: "Context", at }]); },
  } });
  const request = (key) => route("GET", `/fleet/api/threads/${key}`, new URL(`http://localhost/fleet/api/threads/${key}`), async () => ({}));
  const detail = await request("codex:known");
  assert.equal(detail.body.thread.conversation.messages[0].text, "Context");
  assert.equal((await request("codex:unknown")).status, 404);
  assert.equal((await request("codex:..%2Fother")).status, 400);
  assert.deepEqual(reads, ["codex:known"]);
});
