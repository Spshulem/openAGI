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

test("Claude context displays text, excluding thinking, tool results and system injections", () => {
  const messages = claudeConversation(lines([
    { type: "user", message: { content: "Explain this task" } },
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "Here is the context." }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "raw tool output" }] } },
    { type: "user", isMeta: true, message: { content: "system prompt" } },
  ]));
  assert.deepEqual(messages.map((m) => m.text), ["Explain this task", "Here is the context."]);
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
    const result = await readThreadConversation({ kind: "conductor", id: "chosen" }, { paths: { conductorDb: file } });
    assert.deepEqual(result.messages.map((m) => m.text), ["Explain the task", "The task needs review."]);
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
