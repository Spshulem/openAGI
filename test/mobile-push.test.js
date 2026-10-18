// test/mobile-push.test.js
// The daemon side of the iOS push pipe: what goes in the sealed activity and
// alert plaintexts, and when each relay send happens (fake clock, fake relay).
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { MobilePush, PUSH_TIMING, alertOptions, buildActivity, buildAlert } from "../src/mobile-push.js";
import { MobilePushStore } from "../src/mobile-push-store.js";
import { openPushEnvelope } from "../src/mobile-push-envelope.js";

const T0 = Date.parse("2026-10-15T12:00:00.000Z");
const SEC = 1000;
const MIN = 60 * SEC;
const NODE = "mobile:phone-1";

const thread = (key, group, extra = {}) => ({ key, title: `T ${key}`, watch: { group, since: null, waitingOn: null, ...extra } });
const question = (id, extra = {}) => ({ id, status: "open", title: `Q ${id}`, body: "", options: ["yes", "no"], threadKey: "codex:a", ...extra });

function harness(t, { threads = [], questions = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openagi-push-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = crypto.randomBytes(32).toString("base64url");
  const store = new MobilePushStore({ dir });
  store.put(NODE, { pass: "p1.pass-one", key, env: "sandbox" });
  const state = { snapshot: { threads }, questions };
  const supervisor = { getState: () => structuredClone(state) };

  let now = T0;
  let seq = 0;
  const pending = new Map();
  const timers = {
    setTimeout(fn, ms) { seq += 1; pending.set(seq, { at: now + ms, fn }); return seq; },
    clearTimeout(id) { pending.delete(id); }
  };

  const sent = [];
  const logs = [];
  let reply = () => ({ ok: true, apnsId: "apns-1" });
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, ...body });
    const r = await reply(body);
    if (r instanceof Error) throw r;
    const status = r.__status ?? 200;
    return { ok: status < 300, status, json: async () => r };
  };
  const events = new EventEmitter();
  const push = new MobilePush({ store, supervisor, events, relayUrl: "https://relay.test/", fetch, now: () => now, timers, log: (line) => logs.push(line) });
  push.start();

  return {
    push, store, state, events, sent, logs, key, dir, pending, fetch,
    // A fresh process on the same push.json, sharing the relay.
    restart(at) {
      now = at;
      push.stop();
      const store2 = new MobilePushStore({ dir });
      const push2 = new MobilePush({ store: store2, supervisor, events, relayUrl: "https://relay.test/", fetch, now: () => now, timers, log: (line) => logs.push(line) });
      push2.start();
      return { push: push2, store: store2 };
    },
    setReply(fn) { reply = fn; },
    get now() { return now; },
    // Move the clock, firing due timers in order and letting each pass finish.
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...pending.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        pending.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await push.flushing;
      }
      now = end;
    },
    open(entry) {
      return JSON.parse(openPushEnvelope(key, entry.type === "alert" ? "alert" : "activity", entry.sealed));
    },
    types() { return sent.map((s) => s.type); }
  };
}

test("activity rows: active groups only, you → working → waiting, newest first, at most 3, capped", () => {
  const state = {
    snapshot: {
      threads: [
        thread("codex:w1", "waiting", { since: "2026-10-15T11:00:00.000Z" }),
        thread("codex:q", "quiet"),
        thread("codex:k1", "working", { since: "2026-10-15T11:10:00.000Z" }),
        thread("codex:k2", "working", { since: "2026-10-15T11:50:00.000Z" }),
        thread("codex:y", "you", { since: "2026-10-15T11:58:00.000Z", waitingOn: "your answer" }),
        thread("codex:k3", "working"),
        { key: "codex:nowatch", title: "x" },
        { key: "codex:long", title: "L".repeat(80), watch: { group: "waiting", since: "nope", waitingOn: "W".repeat(50) } }
      ]
    }
  };
  const activity = buildActivity(state, new Date(T0));
  assert.deepEqual(Object.keys(activity), ["at", "counts", "rows"]);
  assert.equal(activity.at, "2026-10-15T12:00:00.000Z");
  assert.deepEqual(activity.counts, { you: 1, working: 3, waiting: 2 });
  assert.deepEqual(activity.rows.map((r) => r.key), ["codex:y", "codex:k2", "codex:k1"]);
  assert.deepEqual(activity.rows[0], { key: "codex:y", title: "T codex:y", group: "you", waitingOn: "your answer", since: "2026-10-15T11:58:00.000Z" });

  const all = buildActivity({ snapshot: { threads: [state.snapshot.threads[7], thread("codex:w2", "waiting")] } }, new Date(T0));
  const long = all.rows.find((r) => r.key === "codex:long");
  assert.equal(long.title.length, 60);
  assert.ok(long.title.endsWith("…"));
  assert.equal(long.waitingOn.length, 40);
  assert.equal(long.since, null);
  assert.equal(all.rows.find((r) => r.key === "codex:w2").waitingOn, null);

  assert.deepEqual(buildActivity(null, new Date(T0)).counts, { you: 0, working: 0, waiting: 0 });
  assert.deepEqual(buildActivity({ snapshot: null }, new Date(T0)).rows, []);
});

test("alert plaintext: the Android option filter, caps, and a fallback title", () => {
  assert.deepEqual(alertOptions(["Approve", "dismiss", "Open Thread", " DISMISS ", "Skip", "Later", "More"]), ["Approve", "Skip", "Later"]);
  assert.deepEqual(alertOptions(null), []);
  const alert = buildAlert({ id: "fq1", title: "  ", body: "B".repeat(300), options: ["Approve"], threadKey: "codex:abc" });
  assert.deepEqual(Object.keys(alert), ["questionId", "title", "body", "options", "threadKey"]);
  assert.equal(alert.title, "Needs you");
  assert.equal(alert.body.length, 220);
  assert.equal(buildAlert({ id: "fq2", title: "T".repeat(150) }).title.length, 100);
  assert.equal(buildAlert({ id: "fq3", title: "x" }).threadKey, null);
});

test("a fleet event starts the activity once, 2 s later, with a 30 min stale date", async (t) => {
  const h = harness(t, { threads: [thread("codex:a", "working")] });
  h.events.emit("fleet", {});
  h.events.emit("outreach", {});
  h.events.emit("outreach-resolved", {});
  assert.equal(h.sent.length, 0);
  await h.advance(PUSH_TIMING.debounceMs - 1);
  assert.equal(h.sent.length, 0);
  await h.advance(1);
  assert.deepEqual(h.types(), ["activity-start"]);
  const start = h.sent[0];
  assert.equal(start.url, "https://relay.test/v1/send");
  assert.equal(start.pass, "p1.pass-one");
  assert.equal(start.staleAt, Math.floor((T0 + 2 * SEC + 30 * MIN) / 1000));
  assert.equal(start.priority, undefined);
  assert.deepEqual(h.open(start).counts, { you: 0, working: 1, waiting: 0 });
  // No change, no send.
  h.events.emit("fleet", {});
  await h.advance(5 * SEC);
  assert.equal(h.sent.length, 1);
});

test("nothing active: no activity is started", async (t) => {
  const h = harness(t, { threads: [thread("codex:a", "quiet")] });
  await h.push.flush();
  assert.equal(h.sent.length, 0);
});

test("updates are throttled to one per 20 s; the trailing send carries the latest content", async (t) => {
  const h = harness(t, { threads: [thread("codex:a", "working")] });
  await h.push.flush();
  assert.deepEqual(h.types(), ["activity-start"]);

  h.state.snapshot.threads.push(thread("codex:b", "working"));
  h.events.emit("fleet", {});
  await h.advance(5 * SEC);
  assert.equal(h.sent.length, 1, "inside the 20 s window");
  h.state.snapshot.threads.push(thread("codex:c", "waiting"));
  h.events.emit("fleet", {});
  await h.advance(10 * SEC);
  assert.equal(h.sent.length, 1);
  await h.advance(5 * SEC);
  assert.deepEqual(h.types(), ["activity-start", "activity-update"]);
  const update = h.sent[1];
  assert.equal(h.now - T0, 20 * SEC);
  assert.deepEqual(h.open(update).counts, { you: 0, working: 2, waiting: 1 });
  assert.equal(update.priority, undefined, "you did not rise");
  assert.equal(update.staleAt, Math.floor((T0 + 20 * SEC + 30 * MIN) / 1000));
});

test("an update is priority 10 only when the you count rose", async (t) => {
  const h = harness(t, { threads: [thread("codex:a", "working")] });
  await h.push.flush();
  h.state.snapshot.threads[0].watch.group = "you";
  await h.advance(30 * SEC);
  await h.push.flush();
  assert.equal(h.sent[1].type, "activity-update");
  assert.equal(h.sent[1].priority, 10);
  h.state.snapshot.threads[0].watch.group = "working";
  await h.advance(30 * SEC);
  await h.push.flush();
  assert.equal(h.sent[2].type, "activity-update");
  assert.equal(h.sent[2].priority, undefined);
});

test("two idle minutes end the activity with a 15 min dismissal; activity again starts a new one", async (t) => {
  const h = harness(t, { threads: [thread("codex:a", "working")] });
  await h.push.flush();
  h.state.snapshot.threads = [];
  await h.advance(30 * SEC);
  await h.push.flush();
  assert.deepEqual(h.types(), ["activity-start", "activity-update"], "the zero counts are shown first");
  const idleAt = h.now;
  await h.advance(2 * MIN - 1);
  assert.equal(h.sent.length, 2);
  await h.advance(1);
  assert.deepEqual(h.types(), ["activity-start", "activity-update", "activity-end"]);
  const end = h.sent[2];
  assert.equal(end.dismissAt, Math.floor((idleAt + 2 * MIN + 15 * MIN) / 1000));
  assert.deepEqual(h.open(end).counts, { you: 0, working: 0, waiting: 0 });

  h.state.snapshot.threads = [thread("codex:b", "you")];
  await h.push.flush();
  assert.equal(h.sent[3].type, "activity-start");
});

test("activity coming back inside the idle window cancels the end", async (t) => {
  const h = harness(t, { threads: [thread("codex:a", "working")] });
  await h.push.flush();
  h.state.snapshot.threads = [];
  await h.advance(30 * SEC);
  await h.push.flush();
  h.state.snapshot.threads = [thread("codex:a", "working")];
  await h.advance(30 * SEC);
  await h.push.flush();
  await h.advance(5 * MIN);
  assert.deepEqual(h.types(), ["activity-start", "activity-update", "activity-update"]);
});

test("after 7.5 h live the activity is ended and started again", async (t) => {
  const h = harness(t, { threads: [thread("codex:a", "working")] });
  await h.push.flush();
  await h.advance(7.5 * 60 * MIN - 1);
  assert.equal(h.sent.length, 1);
  await h.advance(1);
  assert.deepEqual(h.types(), ["activity-start", "activity-end", "activity-start"]);
  assert.equal(h.sent[1].dismissAt, Math.floor(h.now / 1000));
});

test("each open question alerts once, collapse id = question id, at most 5 per pass", async (t) => {
  const qs = Array.from({ length: 7 }, (_, i) => question(`fq${i}`));
  qs.push(question("fq0"));
  const h = harness(t, { questions: qs });
  await h.push.flush();
  const alerts = h.sent.filter((s) => s.type === "alert");
  assert.deepEqual(alerts.map((a) => a.collapseId), ["fq0", "fq1", "fq2", "fq3", "fq4"]);
  assert.deepEqual(h.open(alerts[0]), { questionId: "fq0", title: "Q fq0", body: "", options: ["yes", "no"], threadKey: "codex:a" });
  await h.push.flush();
  assert.deepEqual(h.sent.filter((s) => s.type === "alert").map((a) => a.collapseId).slice(5), ["fq5", "fq6"]);
  await h.push.flush();
  assert.equal(h.sent.filter((s) => s.type === "alert").length, 7);
});

test("notified ids survive a restart and are pruned to open questions", async (t) => {
  const h = harness(t, { questions: [question("fq_a"), question("fq_b")] });
  await h.push.flush();
  assert.equal(h.sent.length, 2);
  assert.deepEqual(new MobilePushStore({ dir: h.dir }).get(NODE).notified, ["fq_a", "fq_b"]);

  // A new process on the same file does not re-alert.
  const sent = [];
  const again = new MobilePush({
    store: new MobilePushStore({ dir: h.dir }),
    supervisor: { getState: () => structuredClone(h.state) },
    fetch: async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ ok: true }) }; },
    now: () => T0,
    timers: { setTimeout: () => 0, clearTimeout() {} },
    log() {}
  });
  await again.flush();
  assert.equal(sent.length, 0);

  h.state.questions = [question("fq_b")];
  await h.push.flush();
  assert.deepEqual(h.store.get(NODE).notified, ["fq_b"]);
  // Reopened: a fresh alert.
  h.state.questions = [question("fq_a"), question("fq_b")];
  await h.push.flush();
  assert.deepEqual(h.sent.map((s) => s.collapseId), ["fq_a", "fq_b", "fq_a"]);
});

test("gone deletes the registration; nothing more is sent to it", async (t) => {
  const h = harness(t, { threads: [thread("codex:a", "working")], questions: [question("fq1")] });
  h.setReply(() => ({ ok: false, gone: true, __status: 410 }));
  await h.push.flush();
  assert.deepEqual(h.types(), ["alert"]);
  assert.equal(h.store.get(NODE), null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.dir, "push.json"), "utf8")).registrations.length, 0);
  await h.push.flush();
  assert.equal(h.sent.length, 1);
});

test("a network error keeps the registration, logs once, and retries on the next change", async (t) => {
  const h = harness(t, { threads: [thread("codex:a", "working")], questions: [question("fq1")] });
  h.setReply(() => new Error("connect ECONNREFUSED"));
  await h.push.flush();
  await h.push.flush();
  assert.ok(h.store.get(NODE));
  assert.deepEqual(h.store.get(NODE).notified, []);
  assert.equal(h.logs.filter((l) => l.includes("ECONNREFUSED")).length, 1);
  assert.ok(h.logs.every((l) => !l.includes("p1.pass-one") && !l.includes(h.key)));

  h.setReply(() => ({ ok: true, apnsId: "x" }));
  await h.push.flush();
  assert.deepEqual(h.types().slice(-2), ["alert", "activity-start"]);
  assert.deepEqual(h.store.get(NODE).notified, ["fq1"]);
});

test("a relay error reply keeps the registration and is retried", async (t) => {
  const h = harness(t, { threads: [thread("codex:a", "working")] });
  h.setReply(() => ({ ok: false, error: "rate_limited", __status: 429 }));
  await h.push.flush();
  assert.ok(h.store.get(NODE));
  assert.ok(h.logs.some((l) => l.includes("rate_limited")));
  h.setReply(() => ({ ok: true }));
  await h.push.flush();
  assert.deepEqual(h.types(), ["activity-start", "activity-start"]);
});

test("a supervisor that throws never escapes into the caller", async (t) => {
  const h = harness(t);
  h.push.supervisor = { getState() { throw new Error("boom"); } };
  await h.push.flush();
  h.events.emit("fleet", {});
  await h.advance(5 * SEC);
  assert.equal(h.sent.length, 0);
  assert.equal(h.logs.filter((l) => l.includes("boom")).length, 1);
});

test("a re-registration is a fresh activity", async (t) => {
  const h = harness(t, { threads: [thread("codex:a", "working")] });
  await h.push.flush();
  h.store.put(NODE, { pass: "p1.pass-two", key: h.key, env: "sandbox" });
  h.push.registrationChanged(NODE);
  await h.advance(PUSH_TIMING.debounceMs);
  assert.deepEqual(h.types(), ["activity-start", "activity-start"]);
  assert.equal(h.sent[1].pass, "p1.pass-two");
});

test("stop drops the listeners and timers", async (t) => {
  const h = harness(t, { threads: [thread("codex:a", "working")] });
  await h.push.flush();
  assert.equal(h.pending.size, 1, "the restart wake");
  h.push.stop();
  assert.equal(h.pending.size, 0);
  h.events.emit("fleet", {});
  assert.equal(h.pending.size, 0);
  assert.equal(h.events.listenerCount("fleet"), 0);
});

test("a daemon restart updates the activity it started instead of starting a second one", async (t) => {
  const h = harness(t, { threads: [thread("codex:a", "working")] });
  await h.push.flush();
  assert.deepEqual(h.store.get(NODE).activity, { startedAt: new Date(T0).toISOString() });

  const after = h.restart(T0 + 10 * MIN);
  await after.push.flush();
  assert.deepEqual(h.types(), ["activity-start", "activity-update"]);
  assert.equal(h.sent[1].priority, undefined);
  assert.deepEqual(h.open(h.sent[1]).counts, { you: 0, working: 1, waiting: 0 });
  await after.push.flush();
  assert.equal(h.sent.length, 2, "unchanged content is not resent");
});

test("the 7.5 h restart counts from the persisted start, across a daemon restart", async (t) => {
  const h = harness(t, { threads: [thread("codex:a", "working")] });
  await h.push.flush();
  const after = h.restart(T0 + 7.5 * 60 * MIN);
  await after.push.flush();
  assert.deepEqual(h.types(), ["activity-start", "activity-end", "activity-start"]);
  assert.deepEqual(after.store.get(NODE).activity, { startedAt: new Date(T0 + 7.5 * 60 * MIN).toISOString() });
});

test("an idle end clears the persisted activity, so a restart starts afresh", async (t) => {
  const h = harness(t, { threads: [thread("codex:a", "working")] });
  await h.push.flush();
  h.state.snapshot.threads = [];
  await h.advance(30 * SEC);
  await h.push.flush();
  await h.advance(2 * MIN);
  assert.equal(h.sent.at(-1).type, "activity-end");
  assert.equal(h.store.get(NODE).activity, null);
  h.state.snapshot.threads = [thread("codex:a", "working")];
  const after = h.restart(T0 + 10 * MIN);
  await after.push.flush();
  assert.equal(h.sent.at(-1).type, "activity-start");
});

test("re-POSTing the same pass keeps the activity and notified ids; a new pass resets the activity only", async (t) => {
  const h = harness(t, { threads: [thread("codex:a", "working")], questions: [question("fq1")] });
  await h.push.flush();
  assert.deepEqual(h.types(), ["alert", "activity-start"]);

  h.store.put(NODE, { pass: "p1.pass-one", key: h.key, env: "sandbox" });
  h.push.registrationChanged(NODE);
  await h.advance(PUSH_TIMING.debounceMs);
  assert.deepEqual(h.types(), ["alert", "activity-start"], "no second start, no second alert");
  assert.deepEqual(h.store.get(NODE).activity, { startedAt: new Date(T0).toISOString() });
  assert.deepEqual(h.store.get(NODE).notified, ["fq1"]);

  h.store.put(NODE, { pass: "p1.pass-two", key: h.key, env: "sandbox" });
  assert.equal(h.store.get(NODE).activity, null);
  assert.deepEqual(h.store.get(NODE).notified, ["fq1"]);
  h.push.registrationChanged(NODE);
  await h.advance(PUSH_TIMING.debounceMs);
  assert.deepEqual(h.types(), ["alert", "activity-start", "activity-start"]);
  assert.equal(h.sent[2].pass, "p1.pass-two");
});

test("activities: false gets alerts and never an activity send", async (t) => {
  const h = harness(t, { threads: [thread("codex:a", "you")], questions: [question("fq1")] });
  h.store.put(NODE, { pass: "p1.pass-one", key: h.key, env: "sandbox", activities: false });
  await h.push.flush();
  await h.advance(8 * 60 * MIN);
  await h.push.flush();
  assert.deepEqual(h.types(), ["alert"]);
  assert.equal(h.store.get(NODE).activity, null);
});

test("a relay no_live_activity makes that pass alerts-only until a new pass", async (t) => {
  const h = harness(t, { threads: [thread("codex:a", "working")] });
  h.setReply((body) => (body.type.startsWith("activity-") ? { ok: false, error: "no_live_activity", __status: 400 } : { ok: true }));
  await h.push.flush();
  assert.equal(h.store.get(NODE).noLiveActivity, true);
  h.state.questions = [question("fq1")];
  h.state.snapshot.threads.push(thread("codex:b", "you"));
  await h.push.flush();
  assert.deepEqual(h.types(), ["activity-start", "alert"]);

  // The phone's routine re-POST of the same pass does not undo it.
  h.store.put(NODE, { pass: "p1.pass-one", key: h.key, env: "sandbox" });
  await h.push.flush();
  assert.deepEqual(h.types(), ["activity-start", "alert"]);
  assert.equal(new MobilePushStore({ dir: h.dir }).get(NODE).noLiveActivity, true);

  h.setReply(() => ({ ok: true }));
  h.store.put(NODE, { pass: "p1.pass-two", key: h.key, env: "sandbox" });
  await h.push.flush();
  assert.deepEqual(h.types(), ["activity-start", "alert", "activity-start"]);
});

test("a gone Live Activity channel makes the pass alerts-only; only an alert's gone deletes", async (t) => {
  const h = harness(t, { threads: [thread("codex:a", "working")] });
  h.setReply((body) => (body.type.startsWith("activity-") ? { ok: false, gone: true, __status: 410 } : { ok: true }));
  await h.push.flush();
  const record = h.store.get(NODE);
  assert.ok(record, "the registration is kept");
  assert.equal(record.noLiveActivity, true);
  assert.equal(record.activity, null);
  h.state.questions = [question("fq1")];
  h.state.snapshot.threads.push(thread("codex:b", "you"));
  await h.push.flush();
  assert.deepEqual(h.types(), ["activity-start", "alert"]);
});

test("a start answered after the phone re-registered does not attach to the new pass", async (t) => {
  const h = harness(t, { threads: [thread("codex:a", "working")] });
  h.setReply((body) => {
    if (body.type === "activity-start" && body.pass === "p1.pass-one") h.store.put(NODE, { pass: "p1.pass-two", key: h.key, env: "sandbox" });
    return { ok: true };
  });
  await h.push.flush();
  assert.equal(h.store.get(NODE).pass, "p1.pass-two");
  assert.equal(h.store.get(NODE).activity, null);
  await h.push.flush();
  assert.deepEqual(h.sent.map((s) => `${s.type} ${s.pass}`), ["activity-start p1.pass-one", "activity-start p1.pass-two"]);
  assert.deepEqual(h.store.get(NODE).activity, { startedAt: new Date(T0).toISOString() });
});

test("a refused pass (bad, expired, revoked) is marked renew and nothing more is sent with it", async (t) => {
  for (const error of ["bad_pass", "pass_expired", "pass_revoked"]) {
    const h = harness(t, { threads: [thread("codex:a", "working")], questions: [question("fq1"), question("fq2")] });
    h.setReply(() => ({ ok: false, error, __status: 400 }));
    await h.push.flush();
    assert.deepEqual(h.types(), ["alert"], error);
    assert.equal(new MobilePushStore({ dir: h.dir }).get(NODE).renew, true);
    await h.push.flush();
    assert.equal(h.sent.length, 1, "no further sends with that pass");

    h.setReply(() => ({ ok: true }));
    h.store.put(NODE, { pass: "p1.pass-one", key: h.key, env: "sandbox" });
    assert.equal(h.store.get(NODE).renew, true, "the same pass stays marked");
    await h.push.flush();
    assert.equal(h.sent.length, 1);
    h.store.put(NODE, { pass: "p1.pass-two", key: h.key, env: "sandbox" });
    assert.equal(h.store.get(NODE).renew, false);
    await h.push.flush();
    assert.deepEqual(h.types(), ["alert", "alert", "alert", "activity-start"]);
  }
});

test("alerts: false sends no alerts and marks nothing notified; turning it on alerts", async (t) => {
  const h = harness(t, { questions: [question("fq1")] });
  h.store.put(NODE, { pass: "p1.pass-one", key: h.key, env: "sandbox", alerts: false });
  await h.push.flush();
  assert.equal(h.sent.length, 0);
  assert.deepEqual(h.store.get(NODE).notified, []);
  h.store.put(NODE, { pass: "p1.pass-one", key: h.key, env: "sandbox", alerts: true });
  await h.push.flush();
  assert.deepEqual(h.sent.map((s) => s.collapseId), ["fq1"]);
});

test("a gone for an old pass does not delete the phone's new registration", async (t) => {
  const h = harness(t, { questions: [question("fq1")] });
  h.setReply((body) => {
    if (body.pass === "p1.pass-one") {
      h.store.put(NODE, { pass: "p1.pass-two", key: h.key, env: "sandbox" });
      return { ok: false, gone: true, __status: 410 };
    }
    return { ok: true };
  });
  await h.push.flush();
  assert.equal(h.store.get(NODE)?.pass, "p1.pass-two");
  await h.push.flush();
  assert.deepEqual(h.sent.map((s) => `${s.type} ${s.pass}`), ["alert p1.pass-one", "alert p1.pass-two"]);
});

test("questions over the per-pass cap go out on a follow-up pass 30 s later", async (t) => {
  const h = harness(t, { questions: Array.from({ length: 7 }, (_, i) => question(`fq${i}`)) });
  await h.push.flush();
  assert.equal(h.sent.length, 5);
  await h.advance(30 * SEC - 1);
  assert.equal(h.sent.length, 5);
  await h.advance(1);
  assert.deepEqual(h.sent.map((s) => s.collapseId).slice(5), ["fq5", "fq6"]);
  assert.equal(h.pending.size, 0, "no backlog, no follow-up");
  h.push.stop();
});

test("stop clears a pending backlog follow-up", async (t) => {
  const h = harness(t, { questions: Array.from({ length: 6 }, (_, i) => question(`fq${i}`)) });
  await h.push.flush();
  assert.equal(h.pending.size, 1);
  h.push.stop();
  assert.equal(h.pending.size, 0);
});

test("over 200 open questions never re-alert an old one", async (t) => {
  const qs = Array.from({ length: 210 }, (_, i) => question(`fq${i}`));
  const h = harness(t, { questions: qs });
  for (let i = 0; i < 45; i++) await h.push.flush();
  const ids = h.sent.filter((s) => s.type === "alert").map((a) => a.collapseId);
  assert.equal(ids.length, 210);
  assert.equal(new Set(ids).size, 210);
  assert.equal(h.store.get(NODE).notified.length, 210);
});

test("rate-limited alerts retry without another fleet event", async (t) => {
  const h = harness(t, { questions: [question("fq_a"), question("fq_b")] });
  t.after(() => h.push.stop());
  let limited = true;
  h.setReply((body) => body.type === "alert" && body.collapseId === "fq_b" && limited
    ? { __status: 429, ok: false, error: "rate_limited" } : { ok: true });
  await h.push.flush();
  assert.deepEqual(h.store.get(NODE).notified, ["fq_a"]);
  limited = false;
  await h.advance(30 * SEC);
  assert.deepEqual(h.store.get(NODE).notified, ["fq_a", "fq_b"]);
});

test("a failed idle end retries without another fleet event", async (t) => {
  const h = harness(t, { threads: [thread("codex:a", "working")] });
  t.after(() => h.push.stop());
  await h.push.flush();
  h.state.snapshot.threads = [];
  await h.advance(30 * SEC);
  await h.push.flush();
  let down = true;
  h.setReply((body) => body.type === "activity-end" && down
    ? { __status: 502, ok: false, error: "apns_unreachable" } : { ok: true });
  await h.advance(2 * MIN);
  const ends = () => h.types().filter((type) => type === "activity-end").length;
  assert.equal(ends(), 1);
  down = false;
  await h.advance(30 * SEC);
  assert.equal(ends(), 2);
  assert.equal(h.store.get(NODE).activity, null);
});

test("forgetting a phone invalidates alerts and starts already awaiting the relay", async (t) => {
  for (const type of ["alert", "activity-start"]) {
    await t.test(type, async (t) => {
      const h = harness(t, { threads: [thread("codex:a", "working")],
        questions: type === "alert" ? [question("fq1"), question("fq2")] : [] });
      t.after(() => h.push.stop());
      const entered = Promise.withResolvers();
      const reply = Promise.withResolvers();
      h.setReply((body) => {
        if (body.type !== type) return { ok: true };
        entered.resolve();
        return reply.promise;
      });
      const flushing = h.push.flush();
      await entered.promise;
      h.push.forget(NODE);
      h.store.remove(NODE);
      // Even a same-pass re-registration cannot revive the old batch.
      h.store.put(NODE, { pass: "p1.pass-one", key: h.key, env: "sandbox" });
      reply.resolve({ ok: true });
      await flushing;
      assert.deepEqual(h.types(), [type]);
      assert.equal(h.push.live.has(NODE), false);
      assert.equal(h.store.get(NODE).activity, null);
      assert.deepEqual(h.store.get(NODE).notified, []);
    });
  }
});

test("forgetting during a restart end prevents a replacement Live Activity", async (t) => {
  const h = harness(t, { threads: [thread("codex:a", "working")] });
  t.after(() => h.push.stop());
  await h.push.flush();
  const entered = Promise.withResolvers();
  const reply = Promise.withResolvers();
  h.setReply(() => { entered.resolve(); return reply.promise; });
  const advancing = h.advance(PUSH_TIMING.restartAfterMs);
  await entered.promise;
  h.push.forget(NODE);
  h.store.remove(NODE);
  reply.resolve({ ok: true });
  await advancing;
  assert.deepEqual(h.types(), ["activity-start", "activity-end"]);
  assert.equal(h.push.live.has(NODE), false);
});
