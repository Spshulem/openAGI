// test/observation-recent-context.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ObservationStore } from "../src/observation-store.js";

let hasSqlite = true;
try { await import("node:sqlite"); } catch { hasSqlite = false; }

const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000).toISOString();

test("getRecentContext reads frame OCR text through the stored text row", { skip: !hasSqlite }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-recent-"));
  const store = new ObservationStore({ dir });
  await store.record([
    { kind: "frame", frameId: "f-old", at: minutesAgo(30), app: "Mail", window: "Inbox", ocrText: "too old to show" },
    { kind: "frame", frameId: "f-1", at: minutesAgo(3), app: "Conductor", window: "amman", ocrText: "build passed on main" },
    { kind: "frame", frameId: "f-2", at: minutesAgo(1), app: "Codex", window: "review", ocrText: "two findings left" },
    { kind: "frame", frameId: "f-blank", at: minutesAgo(1), app: "Finder", window: "Downloads" }
  ]);

  const ctx = await store.getRecentContext({ minutes: 10 });
  assert.deepEqual(ctx.snippets.map((s) => s.text).sort(), ["build passed on main", "two findings left"]);
  const rowids = store.db.prepare("SELECT frame_uid, text_rowid FROM frames ORDER BY frame_uid").all();
  assert.equal(rowids.find((r) => r.frame_uid === "f-blank").text_rowid, null);
  assert.ok(rowids.find((r) => r.frame_uid === "f-1").text_rowid > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("opening an older store links existing frames to their OCR text", { skip: !hasSqlite }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-recent-legacy-"));
  const first = new ObservationStore({ dir });
  await first.record([
    { kind: "frame", frameId: "legacy-1", at: minutesAgo(2), app: "Conductor", window: "amman", ocrText: "legacy frame text" },
    { kind: "activity", at: minutesAgo(2), app: "Conductor", window: "amman", event: "focus" }
  ]);
  // Recreate the pre-upgrade shape: no text_rowid column on frames.
  first.db.exec("ALTER TABLE frames DROP COLUMN text_rowid");
  first.db.close();

  const upgraded = new ObservationStore({ dir });
  const ctx = await upgraded.getRecentContext({ minutes: 10 });
  assert.deepEqual(ctx.snippets.map((s) => s.text), ["legacy frame text"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
