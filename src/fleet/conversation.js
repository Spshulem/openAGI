// Owner-only context for a thread already present in the fleet. Reads stay
// bounded and use source paths/IDs from the scan, never from the caller.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { SUPERVISOR_PREFIX, openReadOnlyDb, parseJsonLines, readTail, redactSecrets, toIso } from "./contracts.js";
import { cleanCodexUserText, userInputKind } from "./sources/codex.js";
import { isOwnerText } from "./sources/claude.js";

const READ_BYTES = 1024 * 1024;
const MAX_MESSAGES = 80;
const MAX_TEXT = 16_000;
const MAX_TOTAL = 120_000;

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => ["text", "Text", "output_text"].includes(part?.type) && typeof part.text === "string")
    .map((part) => part.text).join("\n");
}

function questionText(input) {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  return questions.filter((q) => q && typeof (q.question ?? q.title) === "string").map((q) => [q.question ?? q.title,
    ...(Array.isArray(q.options) ? q.options : []).map((o) => typeof o === "string" ? o : o?.label)
      .filter((label) => typeof label === "string" && label.trim()).map((label) => `• ${label}`)]
    .join("\n")).join("\n\n");
}

function claudeQuestionText(content) {
  return (Array.isArray(content) ? content : []).filter((block) => block?.type === "tool_use" && /(?:^|__)AskUserQuestion$/.test(block.name ?? ""))
    .map((block) => questionText(block.input)).filter(Boolean).join("\n\n");
}

function claudeAssistantText(content) {
  const blocks = Array.isArray(content) ? content : [];
  // Only a reply sent to a session socket is owner-visible. Other tool
  // inputs, including messages to subagents, stay out of the conversation.
  const relayed = blocks.find((block) => block?.type === "tool_use" && block.name === "SendMessage" && /^uds:/.test(String(block.input?.to ?? ""))
    && typeof block.input?.message === "string")?.input.message.trim();
  return [relayed || textOf(content), claudeQuestionText(content)].filter(Boolean).join("\n\n");
}

function append(messages, role, text, at) {
  if (typeof text !== "string" || !text.trim()) return;
  const clean = redactSecrets(text).trim();
  const previous = messages.at(-1);
  // A rollout records a reply as a response item, an agent event, and a
  // task_complete. Do not display that same reply three times.
  if (previous?.role === role && previous.text === clean) return;
  messages.push({ role, text: clean, at: toIso(at) });
}

function appendCodexUser(messages, text, at) {
  if (["owner", "reply"].includes(userInputKind(text))) append(messages, "user", cleanCodexUserText(text), at);
}

export function codexConversation(text) {
  const messages = [];
  for (const row of parseJsonLines(text)) {
    const p = row.payload ?? {};
    if (row.type === "event_msg") {
      if (p.type === "user_message") appendCodexUser(messages, p.message, row.timestamp);
      else if (p.type === "agent_message" && p.delivery !== "async") append(messages, "assistant", p.message, row.timestamp);
      else if (p.type === "task_complete") append(messages, "assistant", p.last_agent_message, row.timestamp);
      else if (p.type === "item_completed") {
        const item = p.item ?? {};
        if (item.type === "AgentMessage" && item.delivery !== "async") append(messages, "assistant", textOf(item.content), row.timestamp);
        else if (item.type === "UserMessage") appendCodexUser(messages, textOf(item.content), row.timestamp);
      }
    } else if (row.type === "response_item") {
      // User response_items are injected system/environment context.
      if (p.type === "message" && p.role === "assistant") append(messages, "assistant", textOf(p.content), row.timestamp);
      else if (p.type === "function_call" && /(?:^|__)request_user_input(?:_async)?$/.test(p.name ?? "")) {
        try {
          const args = typeof p.arguments === "string" ? JSON.parse(p.arguments) : p.arguments;
          append(messages, "assistant", questionText(args), row.timestamp);
        } catch { /* Incomplete tool arguments are not a message. */ }
      }
    }
  }
  return messages;
}

export function claudeConversation(text) {
  const messages = [];
  for (const row of parseJsonLines(text)) {
    if (row.type === "assistant") append(messages, "assistant", claudeAssistantText(row.message?.content), row.timestamp);
    else if (row.type === "user" && !row.isMeta && !row.isCompactSummary) {
      const text = textOf(row.message?.content).trim();
      if (text && isOwnerText(row, text)) append(messages, "user", text, row.timestamp);
    }
  }
  return messages;
}

export function boundConversation(messages, truncated = false, unavailableReason = null) {
  const selected = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0 && selected.length < MAX_MESSAGES; i--) {
    const message = messages[i];
    const text = message.text.slice(0, MAX_TEXT);
    if (total + text.length > MAX_TOTAL) { truncated = true; break; }
    total += text.length;
    if (text.length < message.text.length) truncated = true;
    selected.unshift({ ...message, text,
      id: createHash("sha256").update(`${i}\0${message.role}\0${message.at}\0${text}`).digest("hex").slice(0, 24) });
  }
  return { messages: selected, truncated: truncated || selected.length < messages.length, unavailableReason };
}

function lastExchange(thread, reason) {
  const messages = [];
  append(messages, "user", thread.lastUserText, thread.lastUserAt);
  append(messages, "assistant", thread.lastAgentFull || thread.lastAgentText, thread.lastAgentFullAt || thread.lastAgentAt);
  return boundConversation(messages, true, reason);
}

export async function readThreadConversation(thread, config) {
  if (["codex", "claude"].includes(thread.kind) && thread.meta?.file) {
    const file = thread.meta.file;
    const text = readTail(file, READ_BYTES);
    const messages = thread.kind === "codex" ? codexConversation(text) : claudeConversation(text);
    if (messages.length) return boundConversation(messages, fs.statSync(file).size > READ_BYTES);
  } else if (thread.kind === "conductor") {
    const db = await openReadOnlyDb(config.paths.conductorDb);
    if (db) {
      try {
        const rows = db.prepare(`SELECT role, content, created_at, sent_at, cancelled_at, sender_session_id, sender_api_key_name
          FROM session_messages WHERE session_id = ? ORDER BY sent_at DESC, rowid DESC LIMIT 1000`).all(thread.id).reverse();
        const messages = [];
        for (const row of rows) {
          if (row.cancelled_at) continue;
          const at = row.sent_at ?? row.created_at;
          if (row.role === "user" && !row.sender_session_id && !row.sender_api_key_name) {
            const text = String(row.content ?? "").trim();
            if (!text.startsWith(SUPERVISOR_PREFIX)) append(messages, "user", text, at);
          }
          else if (row.role === "assistant") {
            try {
              const event = JSON.parse(row.content);
              if (event.type === "assistant") append(messages, "assistant", event.parent_tool_use_id
                ? claudeQuestionText(event.message?.content) : claudeAssistantText(event.message?.content), at);
            } catch { /* Tool and partial stream rows are not messages. */ }
          }
        }
        if (messages.length) return boundConversation(messages, rows.length === 1000);
      } finally { db.close(); }
    }
  }
  return lastExchange(thread, "This host can only provide the latest exchange for this thread.");
}

export function unavailableConversation(thread) {
  return lastExchange(thread, "The conversation history couldn’t be read on the connected host. Showing the last exchange from its scan.");
}
