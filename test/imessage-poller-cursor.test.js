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
    CREATE TABLE message (guid TEXT, text TEXT, is_from_me INTEGER, date INTEGER, handle_id INTEGER, attributedBody BLOB);
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
    const row = db.prepare("INSERT INTO message (guid, text, is_from_me, date, handle_id) VALUES (?, ?, 1, 0, ?)").run(`fixture-${id}`, `fixture ${id}`, chat);
    db.prepare("INSERT INTO chat_message_join VALUES (?, ?)").run(chat, Number(row.lastInsertRowid));
  };
  return { source, add, imported, db };
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

test("poller connection rejects writes while reading a live WAL database", async t => {
  const f = fixture(t);
  const poller = f.source();
  const writer = new DatabaseSync(poller.dbPath);
  t.after(() => writer.close());
  writer.exec("PRAGMA journal_mode = WAL;");
  const prepare = DatabaseSync.prototype.prepare;
  let writeRejected = false;
  let inspected = false;
  const mock = t.mock.method(DatabaseSync.prototype, "prepare", function (...args) {
    if (!inspected) {
      inspected = true;
      try { this.exec("CREATE TABLE unexpected_write (value TEXT)"); }
      catch (error) { writeRejected = /readonly|read-only/i.test(error.message); }
    }
    return prepare.apply(this, args);
  });
  const result = await poller.sync();
  mock.mock.restore();
  assert.equal(result.imported, 0);
  assert.equal(inspected, true);
  assert.equal(writeRejected, true, "the importer must not hold write authority over Messages");
  f.add("wal-message");
  assert.equal((await poller.sync()).imported, 1, "reads include new WAL messages");
});

test("database removed between existence check and open is never recreated", async t => {
  const f = fixture(t);
  const poller = f.source();
  const exists = fs.existsSync;
  const mock = t.mock.method(fs, "existsSync", function (target) {
    if (target === poller.dbPath) {
      fs.unlinkSync(target);
      return true;
    }
    return exists(target);
  });
  const result = await poller.sync();
  mock.mock.restore();
  assert.equal(result.skipped, true);
  assert.equal(fs.existsSync(poller.dbPath), false, "read path must never create a replacement database");
});

function attributedBody(text) {
  const bytes = Buffer.from(text, "utf8");
  const length = Buffer.alloc(3);
  length[0] = 0x81;
  length.writeUInt16LE(bytes.length, 1);
  return Buffer.concat([Buffer.from("streamtyped...NSString"), Buffer.from([1, 0x94, 0x84, 1, 0x2b]), length, bytes, Buffer.from([0x86])]);
}

test("modern attributed-only self messages import across batches and restart; other chats stay excluded", async t => {
  const f = fixture(t);
  let poller = f.source();
  f.add("history");
  f.db.prepare("UPDATE message SET text = NULL, attributedBody = ?").run(attributedBody("historical"));
  assert.equal((await poller.sync()).imported, 0);
  for (let i = 0; i < 205; i++) {
    f.add(i);
    f.db.prepare("UPDATE message SET text = NULL, attributedBody = ? WHERE guid = ?").run(attributedBody("fixture café 📝 " + i), `fixture-${i}`);
  }
  f.add("other", 2);
  f.db.prepare("UPDATE message SET text = NULL, attributedBody = ? WHERE guid = ?").run(attributedBody("excluded"), "fixture-other");
  assert.equal((await poller.sync()).imported, 200);
  poller = f.source();
  assert.equal((await poller.sync()).imported, 5);
  assert.equal((await poller.sync()).imported, 0);
  assert.equal(new Set(f.imported).size, 205);
  assert.ok(!f.imported.includes("imessage:fixture-other"));
});

test("plain text takes precedence; blank text falls back; unreadable bodies do not block later messages", async t => {
  const f = fixture(t);
  const tasks = [];
  const poller = f.source();
  poller.runtime.tasks.add = task => tasks.push(task);
  await poller.sync();
  for (const [id, text, body] of [
    ["plain", "plain wins", attributedBody("ignored")],
    ["blank", "  ", attributedBody("café 📝")],
    ["truncated", null, Buffer.from("NSString+\x81", "binary")],
    ["attachment", null, attributedBody("\uFFFC")],
    ["after", null, attributedBody("after malformed")]
  ]) {
    f.add(id);
    f.db.prepare("UPDATE message SET text = ?, attributedBody = ? WHERE guid = ?").run(text, body, `fixture-${id}`);
  }
  assert.equal((await poller.sync()).imported, 3);
  assert.deepEqual(tasks.map(x => x.title), ["plain wins", "café 📝", "after malformed"]);
  assert.equal((await poller.sync()).imported, 0);
});
