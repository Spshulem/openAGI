import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IMessagePollerSource } from "../src/integrations/imessage-poller.js";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imessage-cursor-"));
  const dbPath = path.join(dir, "messages.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE message (guid TEXT, text TEXT, is_from_me INTEGER, date INTEGER, handle_id INTEGER);
    CREATE TABLE handle (id TEXT);
    CREATE TABLE chat (label TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    INSERT INTO handle VALUES ('self@example.invalid'), ('other@example.invalid');
    INSERT INTO chat VALUES ('self'), ('other');
    INSERT INTO chat_handle_join VALUES (1, 1), (2, 2);
  `);
  const imported = [];
  const source = () => {
    const poller = new IMessagePollerSource({ dbPath, dataDir: dir, selfHandle: "self@example.invalid",
      runtime: { tasks: { add: task => imported.push(task.sourceId) } } });
    poller.isEnabled = () => true;
    return poller;
  };
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const add = (id, chat = 1) => {
    const row = db.prepare("INSERT INTO message VALUES (?, ?, 1, 0, ?)").run(`fixture-${id}`, `fixture ${id}`, chat);
    db.prepare("INSERT INTO chat_message_join VALUES (?, ?)").run(chat, Number(row.lastInsertRowid));
  };
  return { source, add, imported };
}

test("consecutive polls and restart retain the initialized cursor without skipping new messages", async t => {
  const f = fixture(t);
  f.add("historical");
  let poller = f.source();
  assert.equal((await poller.sync()).imported, 0, "first enable remains forward-only");
  f.add("first");
  assert.equal((await poller.sync()).imported, 1);
  const state = poller._loadState();
  assert.equal(state.initialized, true);
  assert.ok(state.bootstrappedAt);
  f.add("second");
  assert.equal((await poller.sync()).imported, 1);
  poller = f.source();
  f.add("third");
  f.add("private-other-chat", 2);
  assert.equal((await poller.sync()).imported, 1);
  assert.equal((await poller.sync()).imported, 0);
  assert.deepEqual(f.imported, ["imessage:fixture-first", "imessage:fixture-second", "imessage:fixture-third"]);
});

test("bounded batches drain across polls rather than rebootstrap past remaining messages", async t => {
  const f = fixture(t);
  const poller = f.source();
  await poller.sync();
  for (let i = 0; i < 205; i++) f.add(i);
  assert.equal((await poller.sync()).imported, 200);
  assert.equal((await poller.sync()).imported, 5);
  assert.equal(new Set(f.imported).size, 205);
});

test("legacy successful checkpoints lacking initialized resume their cursor", async t => {
  const f = fixture(t);
  f.add("already-imported");
  const poller = f.source();
  poller._saveState({ lastRowid: 1, lastSyncedAt: "2026-01-01T00:00:00.000Z" });
  f.add("pending");
  assert.equal((await poller.sync()).imported, 1);
  assert.equal(poller._loadState().initialized, true);
  assert.deepEqual(f.imported, ["imessage:fixture-pending"]);
});

test("explicit uninitialized state still bootstraps forward-only", async t => {
  const f = fixture(t);
  f.add("historical");
  const poller = f.source();
  poller._saveState({ initialized: false, lastRowid: 0, lastSyncedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal((await poller.sync()).imported, 0);
  assert.deepEqual(f.imported, []);
});
