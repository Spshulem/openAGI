import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveFleetConfig } from "../src/fleet/contracts.js";
import { FleetStore } from "../src/fleet/store.js";
import { createNotifier } from "../src/fleet/notify.js";

const ENDPOINT = "https://ping.buzzkit.dev/secret-device-id-123";
// Local-time constructors keep these tests independent of the machine zone.
const NOON = new Date(2026, 8, 26, 12, 0, 0);
const LATE = new Date(2026, 8, 26, 23, 30, 0);

function setup(t, { push = null, publicUrl = null, now = NOON, endpoint = ENDPOINT, fetchImpl, withOutreach = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-notify-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  if (endpoint) {
    fs.mkdirSync(path.join(home, ".claude", "buzz"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "buzz", "endpoint"), `${endpoint}\n`, { mode: 0o600 });
  }
  const config = resolveFleetConfig({}, { home, push, publicUrl });
  const store = new FleetStore({ dir: path.join(home, "fleet"), now: () => now.getTime() });
  const appended = [];
  const runtime = withOutreach
    ? { outreach: { append: (item) => { appended.push(item); return { id: `out_${appended.length}`, ...item }; } } }
    : {};
  const fetches = [];
  const fetchFake = fetchImpl ?? (async (url, init) => {
    fetches.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  });
  const logs = [];
  const notifier = createNotifier({ config, store, runtime, fetchImpl: fetchFake, now: () => now, log: (...args) => logs.push(args.join(" ")) });
  const question = store.upsertQuestion({
    dedupeKey: "ready:o/r#6522", threadKey: "codex:t1", prRef: "o/r#6522",
    title: "#6522 ready. Merge?", body: "CI green on abc1234. 0 open threads.", options: ["merge", "wait"]
  });
  return { home, config, store, appended, fetches, logs, notifier, question };
}

test("isQuietHours covers 22:00 to 08:00 local", (t) => {
  const { notifier } = setup(t);
  const at = (h, m = 0) => new Date(2026, 8, 26, h, m, 0);
  assert.equal(notifier.isQuietHours(at(22)), true);
  assert.equal(notifier.isQuietHours(at(23, 30)), true);
  assert.equal(notifier.isQuietHours(at(3)), true);
  assert.equal(notifier.isQuietHours(at(7, 59)), true);
  assert.equal(notifier.isQuietHours(at(8)), false);
  assert.equal(notifier.isQuietHours(at(12)), false);
  assert.equal(notifier.isQuietHours(at(21, 59)), false);
});

test("push is off by default; the outreach item is still posted", async (t) => {
  const { appended, fetches, notifier, question, store } = setup(t);
  const result = await notifier.notifyQuestion(question);
  assert.deepEqual(result, { outreachId: "out_1", pushed: false, skipped: "push-off" });
  assert.equal(fetches.length, 0);
  assert.deepEqual(appended, [{
    type: "fleet-question",
    sourceRef: { kind: "fleet", id: question.id },
    title: "#6522 ready. Merge?",
    summary: "CI green on abc1234. 0 open threads.",
    needsDecision: true,
    actions: ["merge", "wait", "dismiss"],
    dedupeOpen: true
  }]);
  assert.equal(store.question(question.id).outreachId, "out_1");

  // A later tick does not post the same question again.
  const again = await notifier.notifyQuestion(question);
  assert.equal(again.outreachId, "out_1");
  assert.equal(appended.length, 1);
});

test("buzzkit push posts once with a deep link and never exposes the endpoint", async (t) => {
  const { fetches, logs, notifier, question, store, home } = setup(t, { push: "buzzkit", publicUrl: "https://mac.tailnet.ts.net:8443/" });
  const result = await notifier.notifyQuestion(question);
  assert.equal(result.pushed, true);
  assert.equal(result.skipped, null);
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, ENDPOINT);
  assert.equal(fetches[0].init.method, "POST");
  assert.equal(fetches[0].init.headers["content-type"], "application/json");
  assert.ok(fetches[0].init.signal);
  assert.deepEqual(fetches[0].body, {
    title: "#6522 ready. Merge?",
    body: "CI green on abc1234. 0 open threads.",
    agent: "openagi-fleet",
    important: true,
    url: `https://mac.tailnet.ts.net:8443/fleet?q=${question.id}`
  });
  assert.equal(store.pushesSince(60 * 60 * 1000, NOON.getTime()), 1);
  assert.ok(store.question(question.id).pushedAt);

  const again = await notifier.notifyQuestion(store.question(question.id));
  assert.equal(again.pushed, false);
  assert.equal(again.skipped, "already-pushed");
  assert.equal(fetches.length, 1);

  const leaks = JSON.stringify([result, again, logs]) + fs.readFileSync(path.join(home, "fleet", "state.json"), "utf8");
  assert.doesNotMatch(leaks, /secret-device-id-123/);
});

test("no url is sent without a public url", async (t) => {
  const { fetches, notifier, question } = setup(t, { push: "buzzkit" });
  await notifier.notifyQuestion(question);
  assert.equal("url" in fetches[0].body, false);
});

test("quiet hours hold the push but not the outreach item", async (t) => {
  const { appended, fetches, notifier, question } = setup(t, { push: "buzzkit", now: LATE });
  const result = await notifier.notifyQuestion(question);
  assert.equal(result.pushed, false);
  assert.equal(result.skipped, "quiet-hours");
  assert.equal(fetches.length, 0);
  assert.equal(appended.length, 1);
});

test("the hourly cap stops the fourth push", async (t) => {
  const { fetches, notifier, store } = setup(t, { push: "buzzkit" });
  const results = [];
  for (const n of [1, 2, 3, 4]) {
    const question = store.upsertQuestion({ dedupeKey: `k${n}`, title: `Question ${n}?` });
    results.push(await notifier.notifyQuestion(question));
  }
  assert.deepEqual(results.map((r) => r.pushed), [true, true, true, false]);
  assert.equal(results[3].skipped, "hourly-cap");
  assert.equal(fetches.length, 3);
});

test("push failures degrade without throwing or logging the endpoint", async (t) => {
  const failing = async (url) => { throw new TypeError(`fetch failed for ${url}`); };
  const { logs, notifier, question, store } = setup(t, { push: "buzzkit", fetchImpl: failing });
  const result = await notifier.notifyQuestion(question);
  assert.equal(result.pushed, false);
  assert.equal(result.skipped, "push-failed");
  assert.equal(store.pushesSince(60 * 60 * 1000), 0);
  assert.ok(logs.length >= 1);
  assert.doesNotMatch(JSON.stringify([result, logs]), /secret-device-id-123|buzzkit\.dev/);

  const rejected = setup(t, { push: "buzzkit", fetchImpl: async () => ({ ok: false, status: 500 }) });
  const second = await rejected.notifier.notifyQuestion(rejected.question);
  assert.equal(second.skipped, "push-failed");
  assert.doesNotMatch(JSON.stringify([second, rejected.logs]), /secret-device-id-123/);
});

test("a missing or malformed endpoint file skips the push", async (t) => {
  const missing = setup(t, { push: "buzzkit", endpoint: null });
  assert.equal((await missing.notifier.notifyQuestion(missing.question)).skipped, "no-endpoint");
  const malformed = setup(t, { push: "buzzkit", endpoint: "not a url" });
  assert.equal((await malformed.notifier.notifyQuestion(malformed.question)).skipped, "no-endpoint");
  assert.equal(missing.fetches.length + malformed.fetches.length, 0);
});

test("no outreach store and closed questions degrade quietly", async (t) => {
  const { notifier, question, store, appended } = setup(t, { withOutreach: false });
  const result = await notifier.notifyQuestion(question);
  assert.equal(result.outreachId, null);
  assert.equal(appended.length, 0);

  store.answerQuestion(question.id, "merge");
  const closed = await notifier.notifyQuestion(question);
  assert.deepEqual(closed, { outreachId: null, pushed: false, skipped: "closed" });
  assert.deepEqual(await notifier.notifyQuestion(null), { outreachId: null, pushed: false, skipped: "no-question" });

  const throwing = createNotifier({
    config: resolveFleetConfig({}, { home: os.tmpdir() }),
    store: null,
    runtime: { outreach: { append: () => { throw new Error("disk full"); } } },
    now: () => NOON
  });
  const survived = await throwing.notifyQuestion({ id: "fq_x", title: "t", body: "", options: [] });
  assert.equal(survived.outreachId, null);
});
