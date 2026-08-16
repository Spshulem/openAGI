import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FileBackedAgentStore } from "../src/agent-store.js";

function tempStoreDir(prefix) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), "agent-host");
}

function writeLegacySession(storeDir, session) {
  const sessionsDir = path.join(storeDir, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const filePath = path.join(sessionsDir, `${session.id}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(session, null, 2)}\n`);
  return filePath;
}

test("legacy computer_type transcript arguments are atomically redacted on load and stay redacted after restart", () => {
  const storeDir = tempStoreDir("openagi-agent-store-migrate-");
  const sensitiveText = "synthetic passphrase 🔒";
  const unrelatedText = "ordinary task text remains searchable";
  const session = {
    id: "local_user_main",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:01:00.000Z",
    messages: [{
      id: "msg_legacy",
      role: "assistant",
      content: "Completed.",
      metadata: {
        toolCalls: [
          {
            name: "computer_type",
            arguments: { text: sensitiveText, target: "focused-field", intervalMs: 12 },
            ok: true
          },
          {
            name: "add_task",
            arguments: { text: unrelatedText, priority: "high" },
            ok: true
          },
          {
            name: "computer_click",
            arguments: { x: 40, y: 80 },
            ok: true
          }
        ]
      }
    }],
    metadata: { keep: "session-metadata" }
  };
  const filePath = writeLegacySession(storeDir, session);

  const firstStore = new FileBackedAgentStore({ dir: storeDir, ensureDefault: false });
  assert.equal(
    fs.readFileSync(filePath, "utf8").includes(sensitiveText),
    false,
    "startup migration removes legacy typed text before any chat is opened or listed"
  );
  const firstLoad = firstStore.getSession(session.id);
  const calls = firstLoad.messages[0].metadata.toolCalls;
  assert.deepEqual(calls[0].arguments.text, {
    redacted: true,
    characterCount: [...sensitiveText].length,
    byteCount: Buffer.byteLength(sensitiveText, "utf8")
  });
  assert.equal(calls[0].arguments.target, "focused-field");
  assert.equal(calls[0].arguments.intervalMs, 12);
  assert.equal(calls[1].arguments.text, unrelatedText);
  assert.deepEqual(calls[2].arguments, { x: 40, y: 80 });
  assert.equal(firstLoad.metadata.keep, "session-metadata");

  const migratedText = fs.readFileSync(filePath, "utf8");
  assert.equal(migratedText.includes(sensitiveText), false, "the durable session must not retain typed text");
  assert.equal(migratedText.includes(unrelatedText), true, "unrelated tool arguments must be preserved");
  assert.equal(
    fs.readdirSync(path.dirname(filePath)).some((entry) => entry.endsWith(".tmp")),
    false,
    "atomic replacement must not leave a temporary file"
  );

  const secondStore = new FileBackedAgentStore({ dir: storeDir, ensureDefault: false });
  const secondLoad = secondStore.getSession(session.id);
  assert.deepEqual(secondLoad, firstLoad, "a restart must keep the migration idempotent");
  assert.equal(fs.readFileSync(filePath, "utf8"), migratedText, "an already-redacted restart must not rewrite content");
});

test("session listing and direct saves scrub legacy string/args shapes without changing unrelated calls", () => {
  const storeDir = tempStoreDir("openagi-agent-store-list-migrate-");
  const stringSensitive = "synthetic unicode 密碼";
  const argsSensitive = "synthetic legacy args value";
  const unrelatedText = "non-sensitive tool payload";
  const session = {
    id: "overlay_user_main",
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:01:00.000Z",
    messages: [{
      id: "msg_string_shape",
      role: "assistant",
      content: "Done.",
      metadata: {
        toolCalls: [
          {
            name: "computer_type",
            arguments: JSON.stringify({ text: stringSensitive, target: "editor" }),
            ok: true
          },
          {
            name: "computer_type",
            args: { text: argsSensitive, target: "legacy-editor" },
            ok: true
          },
          {
            name: "send_message",
            arguments: { text: unrelatedText, channel: "local" },
            ok: true
          }
        ]
      }
    }],
    metadata: {}
  };
  const filePath = writeLegacySession(storeDir, session);

  const store = new FileBackedAgentStore({ dir: storeDir, ensureDefault: false });
  assert.equal(store.listSessions().length, 1, "listing alone should migrate legacy durable sessions");
  let durable = JSON.parse(fs.readFileSync(filePath, "utf8"));
  let calls = durable.messages[0].metadata.toolCalls;
  assert.deepEqual(calls[0].arguments.text, {
    redacted: true,
    characterCount: [...stringSensitive].length,
    byteCount: Buffer.byteLength(stringSensitive, "utf8")
  });
  assert.equal(calls[0].arguments.target, "editor");
  assert.deepEqual(calls[1].args.text, {
    redacted: true,
    characterCount: [...argsSensitive].length,
    byteCount: Buffer.byteLength(argsSensitive, "utf8")
  });
  assert.equal(calls[1].args.target, "legacy-editor");
  assert.equal(calls[2].arguments.text, unrelatedText);
  assert.equal(fs.readFileSync(filePath, "utf8").includes(stringSensitive), false);
  assert.equal(fs.readFileSync(filePath, "utf8").includes(argsSensitive), false);

  const directSensitive = "synthetic direct-save value";
  calls.push({ name: "computer_type", arguments: { text: directSensitive, target: "field" }, ok: true });
  store.saveSession(durable);
  durable = JSON.parse(fs.readFileSync(filePath, "utf8"));
  calls = durable.messages[0].metadata.toolCalls;
  assert.equal(JSON.stringify(durable).includes(directSensitive), false, "the file store must enforce redaction on new saves too");
  assert.deepEqual(calls.at(-1).arguments.text, {
    redacted: true,
    characterCount: [...directSensitive].length,
    byteCount: Buffer.byteLength(directSensitive, "utf8")
  });
  assert.equal(calls.at(-1).arguments.target, "field");
  assert.equal(calls[2].arguments.text, unrelatedText);
});
