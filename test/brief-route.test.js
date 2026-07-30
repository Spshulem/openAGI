// test/brief-route.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createDurableRuntime, createHostedInterface } from "../src/index.js";

// dataDir is passed explicitly to BOTH the runtime and the interface:
// resolveDataDir() memoizes its first result, so relying on the env var would
// make a second instance in the same process silently reuse the first's dir.
async function bootApp(dataDir) {
  const runtime = createDurableRuntime({ dataDir });
  const app = createHostedInterface(runtime, { host: "127.0.0.1", port: 0, tickerMs: 0, dataDir, authToken: null });
  const listened = await app.listen();
  return { runtime, app, base: listened.url ?? `http://127.0.0.1:${listened.port}` };
}

test("GET /brief/today returns a well-formed brief on an empty install", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-briefroute-"));
  const { app, base } = await bootApp(dataDir);
  try {
    const res = await fetch(`${base}/brief/today`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(Array.isArray(json.items));
    assert.ok(json.older && typeof json.older.count === "number");
    assert.ok(json.generatedAt);
    assert.equal(json.planCachedAt, null);
    assert.ok(Array.isArray(json.degraded));
  } finally { await app.close(); }
});

test("GET /brief/today surfaces a real task with actionable buttons", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-briefroute2-"));
  const { runtime, app, base } = await bootApp(dataDir);
  try {
    runtime.tasks.add({ queue: "user", title: "Overdue thing", bucket: "today", dueDate: "2026-01-01T00:00:00.000Z" });
    const res = await fetch(`${base}/brief/today`);
    const json = await res.json();
    const item = json.items.find((i) => i.kind === "task");
    assert.ok(item, "the task should appear in the brief");
    assert.equal(item.title, "Overdue thing");
    assert.ok(item.why.includes("overdue"));
    const done = item.actions.find((a) => a.id === "complete");
    assert.ok(done && done.path.startsWith("/tasks/"));
    // The action must actually work when dispatched verbatim.
    const applied = await fetch(`${base}${done.path}`, { method: done.method, headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(applied.status, 200);
  } finally { await app.close(); }
});

test("Snooze actually moves the row (dispatched verbatim, checked on the refetch)", async () => {
  // The measured bug: Snooze PATCHed {bucket:"this_week"} and nothing else,
  // but dueUrgency short-circuits on dueDate and never reaches the bucket. The
  // refetch came back with the identical score, the identical "overdue 211d"
  // label and the identical position. The user taps Snooze and the brief does
  // not move -- the worst possible outcome for a one-tap surface.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-briefsnooze-"));
  const { runtime, app, base } = await bootApp(dataDir);
  try {
    runtime.tasks.add({ queue: "user", title: "Overdue thing", bucket: "today", dueDate: "2026-01-01T00:00:00.000Z" });
    const before = (await (await fetch(`${base}/brief/today`)).json()).items.find((i) => i.kind === "task");
    assert.ok(before && before.why.includes("overdue"), "premise: it starts out overdue");

    const snooze = before.actions.find((a) => a.id === "snooze");
    assert.ok(snooze, "the row offers a Snooze");
    const applied = await fetch(`${base}${snooze.path}`, {
      method: snooze.method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snooze.body ?? {})
    });
    assert.equal(applied.status, 200, "the action must work when dispatched verbatim");

    const after = (await (await fetch(`${base}/brief/today`)).json()).items.find((i) => i.id === before.id);
    if (after) {
      assert.ok(
        after.score < before.score,
        `a snoozed row must be demoted, got ${after.score} vs ${before.score}`
      );
      assert.ok(!after.why.includes("overdue"), `a snoozed row must stop claiming it is overdue, got: ${after.why}`);
      assert.ok(new Date(after.dueAt).getTime() > Date.now(), "the deadline moved into the future");
    }
    // The commitment is pushed, not thrown away: clearing dueDate would lose
    // information the user put there.
    const stored = runtime.tasks.list({ queue: "user", status: "pending" })[0];
    assert.ok(stored.dueDate, "snooze must not clear the due date");
    assert.ok(new Date(stored.dueDate).getTime() > Date.now(), "and it must land in the future");
  } finally { await app.close(); }
});

test("GET /brief/today honours ?limit=", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-briefroute3-"));
  const { runtime, app, base } = await bootApp(dataDir);
  try {
    for (let i = 0; i < 6; i += 1) runtime.tasks.add({ queue: "user", title: `T${i}`, bucket: "today" });
    const res = await fetch(`${base}/brief/today?limit=2`);
    const json = await res.json();
    assert.ok(json.items.length <= 2);
  } finally { await app.close(); }
});

test("the revise action round-trips a long draft without losing a byte", async () => {
  // The failure this test exists to catch: seeding the inline editor from
  // anything shorter than the real body (the row's `why`, a preview, a capped
  // field) and PATCHing that back, which overwrites the draft with a fragment
  // of itself. Everything below is built FROM THE WIRE — no id, path or text is
  // hand-written — so it fails the moment the client would have to guess.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-briefrevise-"));
  const { runtime, app, base } = await bootApp(dataDir);
  try {
    const body = [
      "Hi Adam,",
      "",
      "Three things I promised to follow up on:",
      "",
      ...Array.from({ length: 30 }, (_, i) => `${i + 1}. A paragraph with a "quote", a \\backslash, an emoji 🎯 and a tab\there.`),
      "",
      "Best,",
      "Spencer"
    ].join("\n");
    const created = runtime.drafts.add({ kind: "email", title: "Follow-up to Adam", body, recipient: "adam@example.com" });

    const item = (await (await fetch(`${base}/brief/today`)).json()).items.find((i) => i.kind === "draft");
    assert.ok(item, "the pending draft must appear in the brief");
    const action = item.actions.find((a) => a.style === "revise");
    assert.ok(action, "and must offer the revise action");

    // The seed is the whole draft, not a preview of it.
    assert.equal(item.editValue, body, "the editor seed must equal the stored body exactly");

    // Exactly what BriefSection.submitEdit builds: the action's own body merged
    // with the typed text under the server-named key.
    const typed = `${item.editValue.replace("Three things", "Four things")}\n\nP.S. one more thing.`;
    const payload = { ...(action.body ?? {}), [action.bodyField ?? "body"]: typed };

    const patched = await fetch(`${base}${action.path}`, {
      method: action.method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    assert.equal(patched.status, 200, "the revise action must work when dispatched verbatim");

    const stored = runtime.drafts.get(created.id);
    assert.equal(stored.body, typed, "the stored body must be byte-identical to what was sent");
    assert.ok(stored.body.length > body.length, "the edit grew the draft — nothing was cut off the end");
    assert.equal(stored.body.split("\n").length, body.split("\n").length + 2, "every line survived");
    assert.ok(stored.body.includes("🎯"), "multi-byte characters survived");
    assert.ok(stored.body.includes("Four things"), "and the user's actual edit landed");

    // Refresh: the row is still there, re-seeded from the EDITED text, and the
    // user can now approve what they just wrote.
    const after = (await (await fetch(`${base}/brief/today`)).json()).items.find((i) => i.kind === "draft");
    assert.ok(after, "a revised draft stays in the brief — revising is not resolving");
    assert.equal(after.editValue, typed, "re-opening the editor must show the edited text, not the original");
    const approve = after.actions.find((a) => a.id === "approve");
    const approved = await fetch(`${base}${approve.path}`, { method: approve.method, headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(approved.status, 200);
    assert.equal(runtime.drafts.get(created.id).status, "approved");
    assert.equal(runtime.drafts.get(created.id).body, typed, "approving keeps the revision");
  } finally { await app.close(); }
});
