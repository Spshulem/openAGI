// test/mobile-fixtures-current.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mobile", "fixtures");
const keys = (value) => Object.keys(value).sort();
const loadFixture = (name) => JSON.parse(fs.readFileSync(path.join(fixtures, name), "utf8"));

// Every boot gets its own temp data dir, and every temp data dir gets removed
// in a finally — including on a thrown assertion — so a failing drift check
// doesn't also leave a directory behind in os.tmpdir() on top of the failure
// it's reporting.
async function bootApp(prefix) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, tickerMs: 0, dataDir, authToken: null });
  const listened = await app.listen();
  const base = listened.url ?? `http://127.0.0.1:${listened.port}`;
  return {
    runtime, base,
    cleanup: async () => {
      await app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

// The phone clients decode these files in their own test suites. If the daemon
// changes shape, that must fail here in seconds rather than on a phone weeks
// later. All five fixtures get a drift check, not just the populated summary
// — a fixture nothing re-derives is a fixture that can silently rot.

test("the summary fixture still matches what the daemon produces", async () => {
  const { runtime, base, cleanup } = await bootApp("openagi-fixdrift-summary-populated-");
  try {
    runtime.tasks.add({ queue: "user", title: "Ship the widget", bucket: "today", priority: 80 });
    runtime.pendingActions.enqueue({
      toolName: "send_email",
      args: { to: "team@example.com", subject: "Weekly digest" },
      summary: "Send the weekly digest to the team",
      reason: "Drafted from your Friday routine"
    });
    const live = await (await fetch(`${base}/mobile/summary`)).json();
    const stored = loadFixture("summary-populated.json");
    assert.deepEqual(keys(live), keys(stored));
    assert.deepEqual(keys(live.counts), keys(stored.counts));
    assert.deepEqual(keys(live.today[0]), keys(stored.today[0]));
    // The embedded projection is a THREE-key abbreviation of the full
    // pending-action object, and it is what both native clients decode. Pin it
    // here, or a change to it reaches two apps with nothing in between.
    assert.deepEqual(keys(live.pendingActions[0]), keys(stored.pendingActions[0]));
    assert.deepEqual(keys(stored.pendingActions[0]), ["createdAt", "id", "summary"]);
    assert.deepEqual(keys(live.brief), keys(stored.brief));
  } finally { await cleanup(); }
});

test("the empty-summary fixture still matches what the daemon produces", async () => {
  const { base, cleanup } = await bootApp("openagi-fixdrift-summary-empty-");
  try {
    const live = await (await fetch(`${base}/mobile/summary`)).json();
    const stored = loadFixture("summary-empty.json");
    assert.deepEqual(keys(live), keys(stored));
    assert.deepEqual(keys(live.counts), keys(stored.counts));
    assert.deepEqual(keys(live.brief), keys(stored.brief));
    // Nothing to compare per-item shape against here — both sides' `today`
    // is an empty array by construction (no tasks exist on a fresh daemon).
    assert.deepEqual(live.today, []);
    assert.deepEqual(stored.today, []);
  } finally { await cleanup(); }
});

test("the tasks-list fixture still matches what the daemon produces", async () => {
  const { runtime, base, cleanup } = await bootApp("openagi-fixdrift-tasks-list-");
  try {
    runtime.tasks.add({ queue: "user", title: "Ship the widget", bucket: "today", priority: 80 });
    const live = await (await fetch(`${base}/tasks?queue=user`)).json();
    const stored = loadFixture("tasks-list.json");
    assert.deepEqual(keys(live), keys(stored));
    assert.deepEqual(keys(live.tasks[0]), keys(stored.tasks[0]));
    assert.deepEqual(keys(live.stats), keys(stored.stats));
    assert.deepEqual(keys(live.stats.user), keys(stored.stats.user));
    assert.deepEqual(keys(live.stats.agent), keys(stored.stats.agent));
  } finally { await cleanup(); }
});

test("the pending-actions fixture still matches what the daemon produces", async () => {
  const { runtime, base, cleanup } = await bootApp("openagi-fixdrift-pending-actions-");
  try {
    // Queue one, so the per-item shape is compared rather than two empty
    // arrays. The fixture carries an action for the same reason: the embedded
    // projection in /mobile/summary is what both clients decode.
    runtime.pendingActions.enqueue({
      toolName: "send_email",
      args: { to: "team@example.com", subject: "Weekly digest" },
      summary: "Send the weekly digest to the team",
      reason: "Drafted from your Friday routine"
    });
    const live = await (await fetch(`${base}/pending-actions`)).json();
    const stored = loadFixture("pending-actions.json");
    assert.deepEqual(keys(live), keys(stored));
    assert.deepEqual(keys(live.actions[0]), keys(stored.actions[0]));
  } finally { await cleanup(); }
});

test("the enroll-exchange fixture still matches what the daemon produces", async () => {
  const { base, cleanup } = await bootApp("openagi-fixdrift-enroll-exchange-");
  try {
    const { code } = await (await fetch(`${base}/nodes/enrollment-code`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "mobile" })
    })).json();
    const live = await (await fetch(`${base}/nodes/enroll/exchange`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code, platform: "mobile",
        nodeId: "mobile:drift-check-node",
        // Only ever used against this test's own throwaway in-process daemon,
        // never written to a file — no need for the fixture's synthetic
        // placeholder here, the usual crypto-random token is fine.
        nodeToken: crypto.randomBytes(32).toString("base64url"),
        name: "Drift Check Phone"
      })
    })).json();
    const stored = loadFixture("enroll-exchange.json");
    assert.deepEqual(keys(live), keys(stored));
    assert.deepEqual(keys(live.node), keys(stored.node));
    assert.deepEqual(keys(live.capabilities[0]), keys(stored.capabilities[0]));
  } finally { await cleanup(); }
});
