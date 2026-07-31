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

// ── the two discards, dispatched verbatim, checked at the queue ────────────
//
// The user's report: "I hit discard and it keeps coming back. I don't know
// why." Discarding a draft resolves the ARTIFACT and deliberately leaves the
// generating task alone, which task-store reads as "not this one, try again" —
// so the next autopilot pulse drafts it again. Both meanings are now offered,
// and the test that matters is not what the routes return but what the AGENT
// QUEUE does afterwards.

/// Is this task something the autopilot pulse can still pick up? Asserted
/// through the queue's own gate AND through the plain list, so neither a
/// renamed helper nor a changed filter can let this pass silently.
function willRedraft(runtime, taskId) {
  const picked = runtime.tasks.agentPickNext({ sweep: false });
  const listed = runtime.tasks
    .list({ queue: "agent", status: "pending", limit: 200 })
    .some((t) => t.id === taskId);
  return { picked: picked?.id === taskId, listed };
}

function seedDraftedTask(runtime) {
  const task = runtime.tasks.add(
    { title: "Compare Frontier vs SAIL Internet options", bucket: "today", priority: 60 },
    { queue: "agent", source: "proactive-observer" }
  );
  const draft = runtime.drafts.add({
    taskId: task.id, kind: "doc", title: "ISP comparison draft", body: "# Frontier vs Sail\n\nBottom line…"
  });
  return { task, draft };
}

test("plain Discard resolves the draft and leaves the task free to draft again", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-briefdiscard-"));
  const { runtime, app, base } = await bootApp(dataDir);
  try {
    const { task } = seedDraftedTask(runtime);
    const item = (await (await fetch(`${base}/brief/today`)).json()).items.find((i) => i.kind === "draft");
    assert.ok(item, "the pending draft must appear in the brief");
    const discard = item.actions.find((a) => a.id === "discard");
    assert.ok(discard, "Discard stays the common case");

    const res = await fetch(`${base}${discard.path}`, { method: discard.method, headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 200);
    assert.equal(runtime.drafts.get((await res.json()).id).status, "discarded");

    // This is the behaviour, not the bug: a discarded draft means "not this
    // one", and the task may legitimately produce a better one later.
    assert.equal(runtime.tasks.get(task.id).status, "pending");
    const after = willRedraft(runtime, task.id);
    assert.ok(after.picked, "the very next pulse would draft it again");
    assert.ok(after.listed);
  } finally { await app.close(); }
});

test("Stop asking discards the draft AND retires the task, so it can never re-draft", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-briefstop-"));
  const { runtime, app, base } = await bootApp(dataDir);
  try {
    const { task, draft } = seedDraftedTask(runtime);
    const item = (await (await fetch(`${base}/brief/today`)).json()).items.find((i) => i.kind === "draft");
    const stop = item.actions.find((a) => a.id === "stop_asking");
    assert.ok(stop, "a draft with a live generating task must offer the second meaning");
    // Same wire contract as every other action: dispatched verbatim.
    const res = await fetch(`${base}${stop.path}`, { method: stop.method, headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 200);
    const body = await res.json();

    // Both halves reported, separately — the client says "won't ask again" only
    // when the task half actually happened.
    assert.equal(body.discarded, true);
    assert.equal(body.draft.id, draft.id);
    assert.equal(body.draft.status, "discarded");
    assert.ok(body.retired && body.retired.id === task.id, "the response must prove the TASK moved, not just the draft");
    assert.equal(body.retired.status, "cancelled");

    // Audit trail: who, why, when, and what it was before.
    const stored = runtime.tasks.get(task.id);
    assert.equal(stored.status, "cancelled");
    assert.equal(stored.sourceMeta.retired.by, "user");
    assert.equal(stored.sourceMeta.retired.reason, "stop-asking");
    assert.equal(stored.sourceMeta.retired.draftId, draft.id);
    assert.equal(stored.sourceMeta.retired.fromStatus, "pending");
    assert.ok(Date.parse(stored.sourceMeta.retired.at) > 0);
    // …and it is durable, in the same append-only log as every other status
    // change on that task rather than somewhere bespoke.
    const log = fs.readFileSync(path.join(dataDir, "tasks", "agent.jsonl"), "utf8");
    assert.match(log, /"reason":"stop-asking"/);
    // …and recorded as an outcome, the way completing one is.
    const outcome = runtime.outcomes.recent(20, "task-retired").find((o) => o.refId === task.id);
    assert.ok(outcome, "a retirement is a signal about the agent's work, not just a status flip");
    assert.ok(outcome.qualityScore < 0.7, "and it scores below anything the completed path can produce");

    // The point of the whole feature.
    const after = willRedraft(runtime, task.id);
    assert.equal(after.picked, false, "the queue can never hand this task out again");
    assert.equal(after.listed, false);
    // And the row is gone from the brief rather than lingering.
    const items = (await (await fetch(`${base}/brief/today`)).json()).items;
    assert.ok(!items.some((i) => i.id === `draft:${draft.id}`));
  } finally { await app.close(); }
});

test("retiring is reversible, and the undo keeps the audit trail", async () => {
  // Retirement is allowed to be one tap precisely because nothing is destroyed.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-briefunretire-"));
  const { runtime, app, base } = await bootApp(dataDir);
  try {
    const { task, draft } = seedDraftedTask(runtime);
    await fetch(`${base}/drafts/${draft.id}/stop-asking`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(runtime.tasks.get(task.id).status, "cancelled");

    const res = await fetch(`${base}/tasks/${task.id}/unretire`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 200);
    const back = await res.json();
    // "pending", not the status it was stopped from: un-retiring means "you may
    // work this again", and pending is the only status the agent queue serves.
    assert.equal(back.status, "pending");
    assert.equal(back.sourceMeta.retired, undefined, "`retired` must mean 'is retired right now'");
    assert.equal(back.sourceMeta.retiredHistory.length, 1, "…and the record survives the undo");
    assert.equal(back.sourceMeta.retiredHistory[0].reason, "stop-asking");
    assert.ok(Date.parse(back.sourceMeta.retiredHistory[0].revertedAt) > 0);
    assert.ok(willRedraft(runtime, task.id).picked, "genuinely back in the queue, not just un-flagged");

    // Nothing to undo twice.
    const again = await fetch(`${base}/tasks/${task.id}/unretire`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(again.status, 409);
  } finally { await app.close(); }
});

test("Stop asking on a draft with no generating task discards it and says so", async () => {
  // The composer does not offer the button in this case, so this is the race:
  // the task went away between the fetch and the tap. The draft half must still
  // happen, and the response must not let the client claim a task was retired.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-briefstoporphan-"));
  const { runtime, app, base } = await bootApp(dataDir);
  try {
    const draft = runtime.drafts.add({ kind: "doc", title: "Orphan draft", body: "no task behind me" });
    const res = await fetch(`${base}/drafts/${draft.id}/stop-asking`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.discarded, true);
    assert.equal(runtime.drafts.get(draft.id).status, "discarded");
    assert.equal(body.retired, null, "nothing was retired, and the wire must say so");
    assert.equal(body.retireSkipped, "no-generating-task");
  } finally { await app.close(); }
});

test("Stop asking twice is safe: the second call still reports the task as retired", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-briefstoptwice-"));
  const { runtime, app, base } = await bootApp(dataDir);
  try {
    const { task, draft } = seedDraftedTask(runtime);
    await fetch(`${base}/drafts/${draft.id}/stop-asking`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const res = await fetch(`${base}/drafts/${draft.id}/stop-asking`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 200);
    const body = await res.json();
    // The draft was already resolved by the first call…
    assert.equal(body.discarded, false);
    // …but the END STATE is what the user asked for, so "won't ask again" is
    // still the true thing to report.
    assert.equal(body.retireSkipped, "already-retired");
    assert.ok(body.retired && body.retired.id === task.id);
    assert.equal(runtime.tasks.get(task.id).status, "cancelled");
  } finally { await app.close(); }
});

test("a completed task is never retired by a stop-asking on its draft", async () => {
  // Flipping completed -> cancelled would erase a real outcome to silence a row.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-briefstopdone-"));
  const { runtime, app, base } = await bootApp(dataDir);
  try {
    const { task, draft } = seedDraftedTask(runtime);
    runtime.tasks.complete(task.id, "manual");
    const res = await fetch(`${base}/drafts/${draft.id}/stop-asking`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const body = await res.json();
    assert.equal(body.discarded, true);
    assert.equal(body.retired, null);
    assert.equal(body.retireSkipped, "not-retirable:completed");
    const stored = runtime.tasks.get(task.id);
    assert.equal(stored.status, "completed", "the completion stands");
    assert.equal(stored.completedAt !== null, true);
  } finally { await app.close(); }
});
