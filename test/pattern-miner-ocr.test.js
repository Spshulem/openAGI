import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ObservationStore } from "../src/observation-store.js";

let hasSqlite = true;
try { await import("node:sqlite"); } catch { hasSqlite = false; }

function isolatedDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupStore(store, dir) {
  try { store.db?.close?.(); } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
}

async function seedWindow(store) {
  await store.record([
    {
      kind: "activity",
      at: "2026-07-10T09:00:00.000Z",
      app: "Zoom",
      window: "Acme sales call",
      event: "focus"
    },
    {
      kind: "frame",
      at: "2026-07-10T09:00:30.000Z",
      app: "Zoom",
      window: "Acme sales call",
      frameId: "frame-in-window",
      ocrText: "Acme asked for a contract and a pricing follow-up after this sales call."
    },
    {
      kind: "frame-summary",
      at: "2026-07-10T09:04:00.000Z",
      app: "Mail",
      window: "Unrelated",
      frameId: "frame-outside-window",
      ocrText: "This text is outside the requested occurrence window and must not be returned."
    }
  ]);
}

test("searchTextWindow returns normalized frame and activity text on SQLite", { skip: !hasSqlite }, async (t) => {
  const dir = isolatedDir("openagi-text-window-sqlite-");
  const store = new ObservationStore({ dir });
  t.after(() => cleanupStore(store, dir));
  await seedWindow(store);

  const rows = await store.searchTextWindow({
    since: "2026-07-10T08:59:00.000Z",
    until: "2026-07-10T09:02:00.000Z",
    kinds: ["activity", "frame"],
    limit: 10
  });

  assert.deepEqual(rows.map((row) => row.kind), ["activity", "frame"]);
  assert.equal(rows[0].text, "Acme sales call");
  assert.match(rows[1].text, /contract and a pricing follow-up/);
  assert.ok(rows.every((row) => row.ref !== "frame-outside-window"));
});

test("searchTextWindow has matching JSONL fallback behavior", async (t) => {
  const dir = isolatedDir("openagi-text-window-jsonl-");
  const store = new ObservationStore({ dir });
  await store.ready;
  if (!store.fallback) {
    store.db.close();
    store.db = null;
    store.fallback = true;
  }
  t.after(() => cleanupStore(store, dir));
  await seedWindow(store);

  const rows = await store.searchTextWindow({
    since: "2026-07-10T08:59:00.000Z",
    until: "2026-07-10T09:02:00.000Z",
    kinds: ["frame"],
    limit: 10
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "frame");
  assert.equal(rows[0].ref, "frame-in-window");
  assert.match(rows[0].text, /contract and a pricing follow-up/);
});

test("searchTextWindow scopes OCR evidence to the workflow's source machine", { skip: !hasSqlite }, async (t) => {
  const dir = isolatedDir("openagi-text-window-machine-");
  const store = new ObservationStore({ dir });
  t.after(() => cleanupStore(store, dir));
  await store.record([
    {
      kind: "frame",
      at: "2026-07-10T09:00:30.000Z",
      app: "Zoom",
      window: "Acme call",
      frameId: "frame-work",
      sourceMachineId: "work-mac",
      ocrText: "Acme contract terms from the work machine should ground this workflow."
    },
    {
      kind: "frame",
      at: "2026-07-10T09:00:31.000Z",
      app: "Zoom",
      window: "Private call",
      frameId: "frame-home",
      sourceMachineId: "home-mac",
      ocrText: "Unrelated private content from another machine must not cross-ground."
    }
  ]);

  const rows = await store.searchTextWindow({
    since: "2026-07-10T09:00:00.000Z",
    until: "2026-07-10T09:01:00.000Z",
    kinds: ["frame"],
    machine: "work-mac",
    limit: 10
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ref, "frame-work");
  assert.doesNotMatch(rows[0].text, /private content/);
});

test("PatternMiner grounds a sequence with OCR from searchTextWindow", { skip: !hasSqlite }, async (t) => {
  const { PatternMiner } = await import("../src/pattern-miner.js");
  const dir = isolatedDir("openagi-pattern-ocr-");
  const store = new ObservationStore({ dir: path.join(dir, "observations") });
  t.after(() => cleanupStore(store, dir));
  await seedWindow(store);

  const miner = new PatternMiner({
    runtime: { observations: store },
    dataDir: dir
  });
  const snippets = await miner.collectOcrForSequence({
    occurrences: ["2026-07-10T09:00:00.000Z"]
  });

  assert.equal(snippets.length, 1);
  assert.equal(snippets[0].app, "Zoom");
  assert.match(snippets[0].text, /Acme asked for a contract/);
});
