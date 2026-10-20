import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FleetStore } from "../src/fleet/store.js";

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-09-26T12:00:00.000Z");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "fleet");
}

function clock(start = T0) {
  let value = start;
  const now = () => value;
  now.advance = (ms) => { value += ms; };
  return now;
}

test("FleetStore requires a dir", () => {
  assert.throws(() => new FleetStore({}), /dir/);
});

test("mode is null until set, rejects unknown modes, and survives reload", (t) => {
  const dir = tempDir(t);
  const store = new FleetStore({ dir });
  assert.equal(store.mode, null);
  assert.equal(new FleetStore({ dir: tempDir(t), defaultMode: "propose" }).mode, "propose");
  assert.equal(store.setMode("yolo"), null);
  assert.equal(store.mode, null);
  assert.equal(store.setMode("auto"), "auto");
  const reloaded = new FleetStore({ dir, defaultMode: "observe" });
  assert.equal(reloaded.mode, "auto");
});

test("state.json is owner-only and holds the snapshot", (t) => {
  const dir = tempDir(t);
  const store = new FleetStore({ dir });
  store.recordSnapshot({ at: "2026-09-26T12:00:00.000Z", threads: [{ key: "codex:a" }] });
  const file = path.join(dir, "state.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const reloaded = new FleetStore({ dir });
  assert.deepEqual(reloaded.snapshot.threads, [{ key: "codex:a" }]);
});

test("a corrupt state file starts empty instead of throwing", (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), "{not json");
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = warn; });
  const store = new FleetStore({ dir });
  assert.equal(store.snapshot, null);
  assert.deepEqual(store.openQuestions(), []);
  store.setMode("observe");
  assert.equal(new FleetStore({ dir }).mode, "observe");
});

test("ledger counts only sent nudges and resets on progress", (t) => {
  const now = clock();
  const store = new FleetStore({ dir: tempDir(t), now });
  const empty = store.ledgerFor("codex:a");
  assert.deepEqual(empty, { nudges: [], lastProgressMark: null, attemptsWithoutProgress: 0, lastNudgeAt: null, undelivered: null });

  const mark = { head: "abc", unresolved: 2 };
  store.recordNudge("codex:a", { at: "2026-09-26T12:00:00.000Z", playbook: "merge-ready", route: "codex-exec", status: "sent", messageHash: "h1" }, mark);
  store.recordNudge("codex:a", { at: "2026-09-26T12:15:00.000Z", playbook: "merge-ready", route: "codex-exec", status: "sent", messageHash: "h2" }, { unresolved: 2, head: "abc" });
  let ledger = store.ledgerFor("codex:a");
  assert.equal(ledger.attemptsWithoutProgress, 2);
  assert.equal(ledger.lastNudgeAt, "2026-09-26T12:15:00.000Z");
  assert.deepEqual(ledger.lastProgressMark, mark);

  // Dry-runs and blocked attempts are history only.
  store.recordNudge("codex:a", { at: "2026-09-26T12:30:00.000Z", playbook: "merge-ready", route: "codex-exec", status: "dry-run", messageHash: "h3" }, mark);
  store.recordNudge("codex:a", { at: "2026-09-26T12:31:00.000Z", playbook: "merge-ready", route: "codex-exec", status: "blocked", messageHash: "h4" }, mark);
  ledger = store.ledgerFor("codex:a");
  assert.equal(ledger.attemptsWithoutProgress, 2);
  assert.equal(ledger.lastNudgeAt, "2026-09-26T12:15:00.000Z");
  assert.equal(ledger.nudges.length, 4);

  // A failed send still starts the cooldown but does not spend the budget.
  store.recordNudge("codex:a", { at: "2026-09-26T12:40:00.000Z", playbook: "merge-ready", route: "codex-exec", status: "failed", messageHash: "h5" }, mark);
  ledger = store.ledgerFor("codex:a");
  assert.equal(ledger.attemptsWithoutProgress, 2);
  assert.equal(ledger.lastNudgeAt, "2026-09-26T12:40:00.000Z");

  // A new head is progress: the count restarts with this nudge.
  store.recordNudge("codex:a", { at: "2026-09-26T13:00:00.000Z", playbook: "merge-ready", route: "codex-exec", status: "sent", messageHash: "h6" }, { head: "def", unresolved: 2 });
  ledger = store.ledgerFor("codex:a");
  assert.equal(ledger.attemptsWithoutProgress, 1);
  assert.deepEqual(ledger.lastProgressMark, { head: "def", unresolved: 2 });

  // The returned ledger is a copy.
  ledger.nudges.length = 0;
  assert.equal(store.ledgerFor("codex:a").nudges.length, 6);
});

test("questions dedupe by key, clamp text, and answer once", (t) => {
  const now = clock();
  const store = new FleetStore({ dir: tempDir(t), now });
  const first = store.upsertQuestion({
    dedupeKey: "model-limit:codex:a", threadKey: "codex:a", prRef: "o/r#5",
    title: `madrid: Fable capped. Switch model? ${"x".repeat(200)}`, body: "b".repeat(400),
    options: ["yes", "no"], playbook: "resume"
  });
  assert.match(first.id, /^fq_/);
  assert.equal(first.status, "open");
  assert.ok(first.title.length <= 100);
  assert.ok(first.body.length <= 220);
  assert.deepEqual(first.options, ["yes", "no"]);

  now.advance(5 * 60 * 1000);
  const again = store.upsertQuestion({ dedupeKey: "model-limit:codex:a", threadKey: "codex:a", title: "madrid: still capped", options: ["yes", "no"] });
  assert.equal(again.id, first.id);
  assert.equal(again.title, "madrid: still capped");
  assert.equal(store.openQuestions().length, 1);

  const answered = store.answerQuestion(first.id, "yes");
  assert.equal(answered.status, "answered");
  assert.equal(answered.answer, "yes");
  assert.equal(store.answerQuestion(first.id, "no"), null);
  assert.equal(store.answerQuestion("fq_missing", "yes"), null);
  assert.deepEqual(store.openQuestions(), []);

  const second = store.upsertQuestion({ dedupeKey: "model-limit:codex:b", title: "capped again" });
  assert.notEqual(second.id, first.id);
  const dismissed = store.dismissQuestion(second.id);
  assert.equal(dismissed.status, "dismissed");
  assert.equal(store.dismissQuestion(second.id), null);
  assert.equal(store.question(first.id).answer, "yes");
});

test("a question the owner answered or dismissed stays closed for its TTL", (t) => {
  const now = clock();
  const store = new FleetStore({ dir: tempDir(t), now });
  const asked = store.upsertQuestion({ dedupeKey: "ready:o/r#7:abc", title: "#7 ready. Merge?", options: ["merged", "later"] });
  store.answerQuestion(asked.id, "later");

  // The condition still holds next tick: same question back, not reopened.
  now.advance(5 * 60 * 1000);
  const again = store.upsertQuestion({ dedupeKey: "ready:o/r#7:abc", title: "#7 ready. Merge? (new)", options: ["merged", "later"] });
  assert.equal(again.id, asked.id);
  assert.equal(again.suppressed, true);
  assert.equal(again.status, "answered");
  assert.equal(again.title, "#7 ready. Merge?");
  assert.deepEqual(store.openQuestions(), []);
  assert.equal(store.question(asked.id).suppressed, undefined, "the flag is never persisted");

  const other = store.upsertQuestion({ dedupeKey: "logged-out:codex", title: "Codex logged out. Run /login?" });
  store.dismissQuestion(other.id);
  const otherAgain = store.upsertQuestion({ dedupeKey: "logged-out:codex", title: "Codex logged out. Run /login?" });
  assert.equal(otherAgain.id, other.id);
  assert.equal(otherAgain.suppressed, true);

  // A question the supervisor resolved itself comes back when the condition does.
  const resolved = store.upsertQuestion({ dedupeKey: "disk-full", title: "Disk full. Free space?" });
  store.resolveQuestion(resolved.id);
  const reopened = store.upsertQuestion({ dedupeKey: "disk-full", title: "Disk full. Free space?" });
  assert.equal(reopened.status, "open");
  assert.equal(reopened.suppressed, undefined);

  // Past the TTL the owner is asked again.
  now.advance(24 * HOUR);
  const fresh = store.upsertQuestion({ dedupeKey: "ready:o/r#7:abc", title: "#7 ready. Merge?" });
  assert.notEqual(fresh.id, asked.id);
  assert.equal(fresh.status, "open");
  assert.equal(fresh.suppressed, undefined);
});

test("infra-blocked keys persist per kind, dedupe, and clear", (t) => {
  const dir = tempDir(t);
  const store = new FleetStore({ dir });
  assert.deepEqual(store.infraBlocked("lb"), []);
  store.setInfraBlocked("lb", ["codex:a", "codex:b", "codex:a", "", null]);
  assert.deepEqual(store.infraBlocked("lb"), ["codex:a", "codex:b"]);
  assert.deepEqual(store.infraBlocked("bb3"), []);
  const copy = store.infraBlocked("lb");
  copy.push("codex:z");
  assert.deepEqual(new FleetStore({ dir }).infraBlocked("lb"), ["codex:a", "codex:b"]);
  store.setInfraBlocked("lb", []);
  assert.deepEqual(new FleetStore({ dir }).infraBlocked("lb"), []);
});

test("mutedKeys lists only threads still muted", (t) => {
  const now = clock();
  const store = new FleetStore({ dir: tempDir(t), now });
  store.mute("codex:a", T0 + HOUR);
  store.mute("codex:b", T0 + 3 * HOUR);
  assert.deepEqual([...store.mutedKeys()].sort(), ["codex:a", "codex:b"]);
  now.advance(2 * HOUR);
  assert.deepEqual([...store.mutedKeys()], ["codex:b"]);
});

test("question text is redacted before storage", (t) => {
  const store = new FleetStore({ dir: tempDir(t) });
  const question = store.upsertQuestion({ dedupeKey: "k", title: "key sk-ant-abcdefghijklmnop leaked", body: "CODEX_LB_API_KEY=supersecret" });
  assert.doesNotMatch(JSON.stringify(question), /abcdefghijklmnop|supersecret/);
});

test("questions expire after 24 hours, and the same ask stays quiet a day more", (t) => {
  const now = clock();
  const store = new FleetStore({ dir: tempDir(t), now });
  const question = store.upsertQuestion({ dedupeKey: "k", title: "Merge #6522?" });
  now.advance(23 * HOUR);
  assert.equal(store.openQuestions().length, 1);
  now.advance(2 * HOUR);
  assert.deepEqual(store.openQuestions(), []);
  assert.equal(store.question(question.id).status, "expired");
  assert.equal(store.answerQuestion(question.id, "yes"), null);
  const held = store.upsertQuestion({ dedupeKey: "k", title: "Merge #6522?" });
  assert.equal(held.id, question.id);
  assert.equal(held.suppressed, true);
  now.advance(24 * HOUR);
  const fresh = store.upsertQuestion({ dedupeKey: "k", title: "Merge #6522?" });
  assert.notEqual(fresh.id, question.id);
});

// Audit 2026-10-12: questions from Oct 9-11 were still open, refreshed by
// every scan that asked them again.
test("a question asked every tick keeps its id but expires a day after it was first asked", (t) => {
  const now = clock();
  const store = new FleetStore({ dir: tempDir(t), now });
  const first = store.upsertQuestion({ dedupeKey: "ready:o/r#113:abc", title: "#113 ready. Merge?" });
  store.markQuestionNotified(first.id, { outreachId: "out_1" });
  for (let hour = 5; hour <= 20; hour += 5) {
    now.advance(5 * HOUR);
    assert.equal(store.upsertQuestion({ dedupeKey: "ready:o/r#113:abc", title: "#113 ready. Merge?" }).id, first.id);
  }
  assert.equal(store.question(first.id).lastAskedAt, new Date(T0 + 20 * HOUR).toISOString());
  now.advance(3 * HOUR);
  assert.equal(store.openQuestions().length, 1);
  assert.deepEqual(store.takeExpired(), []);
  now.advance(HOUR);
  assert.deepEqual(store.openQuestions(), []);
  assert.equal(store.question(first.id).status, "expired");
  // Handed out once, so the supervisor closes the outreach copy once.
  assert.deepEqual(store.takeExpired().map((q) => [q.id, q.outreachId]), [[first.id, "out_1"]]);
  assert.deepEqual(store.takeExpired(), []);
  // Still asked: quiet for a day after it expired, no new question or push.
  for (let hour = 5; hour < 24; hour += 5) {
    now.advance(5 * HOUR);
    assert.equal(store.upsertQuestion({ dedupeKey: "ready:o/r#113:abc", title: "#113 ready. Merge?" }).suppressed, true);
  }
  assert.deepEqual(store.openQuestions(), []);
  now.advance(5 * HOUR);
  assert.notEqual(store.upsertQuestion({ dedupeKey: "ready:o/r#113:abc", title: "#113 ready. Merge?" }).id, first.id);
});

test("expired questions saved with an outreach copy are handed out again after a reload", (t) => {
  const dir = tempDir(t);
  const now = clock();
  const store = new FleetStore({ dir, now });
  const question = store.upsertQuestion({ dedupeKey: "k", title: "Merge?" });
  store.markQuestionNotified(question.id, { outreachId: "out_9" });
  store.upsertQuestion({ dedupeKey: "other", title: "Other?" });
  now.advance(25 * HOUR);
  store.openQuestions();
  const reloaded = new FleetStore({ dir, now });
  assert.deepEqual(reloaded.takeExpired().map((q) => q.outreachId), ["out_9"]);
});

test("a dismissal or an answer to the agent's ask holds while the same ask keeps coming, and lapses after a TTL with no ask", (t) => {
  const now = clock();
  const store = new FleetStore({ dir: tempDir(t), now });
  const dismissed = store.upsertQuestion({ dedupeKey: "ready:o/r#7:abc", title: "#7 ready. Merge?", options: ["merged", "later"], kind: "ready" });
  store.dismissQuestion(dismissed.id);
  const relayed = store.upsertQuestion({ dedupeKey: "ask:codex:t1:abc", title: "t1: asks you. Answer?", options: ["yes", "no"], kind: "agent-ask" });
  store.answerQuestion(relayed.id, "yes");
  for (let hour = 12; hour <= 72; hour += 12) {
    now.advance(12 * HOUR);
    for (const [key, closed] of [["ready:o/r#7:abc", dismissed], ["ask:codex:t1:abc", relayed]]) {
      const again = store.upsertQuestion({ dedupeKey: key, title: closed.title, kind: closed.kind });
      assert.equal(again.id, closed.id, `${key} still suppressed at ${hour}h`);
      assert.equal(again.suppressed, true);
    }
  }
  assert.deepEqual(store.openQuestions(), []);
  now.advance(24 * HOUR);
  const fresh = store.upsertQuestion({ dedupeKey: "ready:o/r#7:abc", title: "#7 ready. Merge?", kind: "ready" });
  assert.notEqual(fresh.id, dismissed.id);
  assert.equal(fresh.status, "open");
  assert.notEqual(store.upsertQuestion({ dedupeKey: "ask:codex:t1:abc", title: "t1: asks you. Answer?", kind: "agent-ask" }).id, relayed.id);
});

test("an answer that leaves the condition to the owner holds only a TTL from the answer, even while still asked", (t) => {
  const now = clock();
  const store = new FleetStore({ dir: tempDir(t), now });
  const cases = [
    ["ready:o/r#7:abc", "ready", ["merged", "later"], "later"],
    ["stuck:codex:t1:resume:abc", "stuck", ["keep going", "stop"], "keep going"],
    ["open:codex:t2", "open", ["opened", "skip"], "opened"],
    ["logged-out:codex:t3", "infra", ["retry", "later"], "retry"]
  ];
  const answered = cases.map(([dedupeKey, kind, options, answer]) => {
    const question = store.upsertQuestion({ dedupeKey, kind, options, title: `${kind}?` });
    store.answerQuestion(question.id, answer);
    return question;
  });
  const ask = () => cases.map(([dedupeKey, kind, options]) => store.upsertQuestion({ dedupeKey, kind, options, title: `${kind}?` }));
  for (let minutes = 0; minutes < 24 * 60 - 10; minutes += 10) {
    now.advance(10 * 60 * 1000);
    assert.ok(ask().every((q, index) => q.suppressed && q.id === answered[index].id), `held at ${minutes + 10}m`);
  }
  now.advance(10 * 60 * 1000);
  const back = ask();
  back.forEach((q, index) => {
    assert.notEqual(q.id, answered[index].id, `${cases[index][3]} asks again`);
    assert.equal(q.status, "open");
    assert.equal(q.suppressed, undefined);
  });
});

test("pruning closed questions keeps an owner close that is still being asked", (t) => {
  const now = clock();
  const store = new FleetStore({ dir: tempDir(t), now });
  const asked = store.upsertQuestion({ dedupeKey: "ready:o/r#7:abc", title: "#7 ready. Merge?" });
  store.dismissQuestion(asked.id);
  for (let n = 0; n < 201; n += 1) {
    now.advance(60 * 1000);
    store.upsertQuestion({ dedupeKey: "ready:o/r#7:abc", title: "#7 ready. Merge?" });
    store.resolveQuestion(store.upsertQuestion({ dedupeKey: `k${n}`, title: `Q${n}?` }).id);
  }
  assert.equal(store.upsertQuestion({ dedupeKey: "ready:o/r#7:abc", title: "#7 ready. Merge?" }).id, asked.id);
});

test("a resolved question asked again within an hour reopens the same record", (t) => {
  const now = clock();
  const store = new FleetStore({ dir: tempDir(t), now });
  const first = store.upsertQuestion({ dedupeKey: "open:group", title: "2 stuck, can't reach. Open them?" });
  store.markQuestionNotified(first.id, { outreachId: "out_1", pushedAt: T0 });
  const resolved = store.resolveQuestion(first.id, "wait: recently active");
  assert.equal(resolved.resolveReason, "wait: recently active");

  now.advance(30 * 60 * 1000);
  const back = store.upsertQuestion({ dedupeKey: "open:group", title: "3 stuck, can't reach. Open them?" });
  assert.equal(back.id, first.id);
  assert.equal(back.reopened, true);
  assert.equal(back.status, "open");
  assert.equal(back.title, "3 stuck, can't reach. Open them?");
  assert.equal(back.outreachId, "out_1");
  assert.equal(back.pushedAt, new Date(T0).toISOString());
  assert.equal(back.resolveReason, null);
  assert.equal(back.reopenedAt, new Date(T0 + 30 * 60 * 1000).toISOString());
  assert.equal(store.question(first.id).reopened, undefined, "the flag is never persisted");
  assert.deepEqual(store.openQuestions().map((q) => q.id), [first.id]);

  // Gone for over an hour: a new question.
  store.resolveQuestion(first.id);
  now.advance(61 * 60 * 1000);
  const later = store.upsertQuestion({ dedupeKey: "open:group", title: "2 stuck, can't reach. Open them?" });
  assert.notEqual(later.id, first.id);
  assert.equal(later.outreachId, null);
  assert.equal(later.reopened, undefined);
});

test("markQuestionNotified records outreach id and push time", (t) => {
  const store = new FleetStore({ dir: tempDir(t) });
  const question = store.upsertQuestion({ dedupeKey: "k", title: "Merge?" });
  assert.equal(question.outreachId, null);
  store.markQuestionNotified(question.id, { outreachId: "out_1", pushedAt: "2026-09-26T12:00:00.000Z" });
  const stored = store.question(question.id);
  assert.equal(stored.outreachId, "out_1");
  assert.equal(stored.pushedAt, "2026-09-26T12:00:00.000Z");
  assert.equal(store.upsertQuestion({ dedupeKey: "k", title: "Merge?" }).outreachId, "out_1");
});

test("actions are journaled, updated, listed newest first, and capped", (t) => {
  const dir = tempDir(t);
  const store = new FleetStore({ dir, limits: { maxActionsKept: 3 } });
  const first = store.recordAction({ threadKey: "codex:a", route: "codex-exec", playbook: "resume", messageHash: "h", status: "sent" });
  assert.match(first.id, /^fa_/);
  assert.ok(first.at);
  const updated = store.updateAction(first.id, { status: "done", detail: "ok" });
  assert.equal(updated.status, "done");
  assert.equal(store.action(first.id).detail, "ok");
  assert.equal(store.updateAction("fa_missing", { status: "done" }), null);
  for (const n of [2, 3, 4]) store.recordAction({ threadKey: `codex:${n}`, status: "proposed" });
  const listed = store.actions();
  assert.equal(listed.length, 3);
  assert.equal(listed[0].threadKey, "codex:4");
  assert.equal(store.actions(1).length, 1);

  const journal = fs.readFileSync(path.join(dir, "actions.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(journal.length, 5);
  assert.equal(journal[0].op, "record");
  assert.equal(journal[1].op, "update");
  assert.equal(journal[1].id, first.id);
  assert.equal(fs.statSync(path.join(dir, "actions.jsonl")).mode & 0o777, 0o600);
});

test("escalations, infra-down flags, and pushes persist", (t) => {
  const dir = tempDir(t);
  const now = clock();
  const store = new FleetStore({ dir, now });
  assert.equal(store.lastEscalation("infra:bb3"), null);
  store.recordEscalation("infra:bb3", "2026-09-26T11:00:00.000Z");
  assert.equal(store.lastEscalation("infra:bb3"), "2026-09-26T11:00:00.000Z");

  assert.equal(store.infraDown("lb"), false);
  store.setInfraDown("lb", true);
  assert.equal(store.infraDown("lb"), true);
  assert.equal(store.infraDownSince("lb"), new Date(T0).toISOString());

  store.recordPush(new Date(T0 - 2 * HOUR).toISOString());
  store.recordPush(new Date(T0 - 30 * 60 * 1000).toISOString());
  store.recordPush(T0);
  assert.equal(store.pushesSince(HOUR, T0), 2);
  assert.equal(store.pushesSince(3 * HOUR), 3);

  const reloaded = new FleetStore({ dir, now });
  assert.equal(reloaded.lastEscalation("infra:bb3"), "2026-09-26T11:00:00.000Z");
  assert.equal(reloaded.infraDown("lb"), true);
  assert.equal(reloaded.pushesSince(HOUR), 2);
  reloaded.setInfraDown("lb", false);
  assert.equal(reloaded.infraDown("lb"), false);
  assert.equal(reloaded.infraDownSince("lb"), null);
});

// ─── the supervisor's review of its own list ───────────────────────────────

test("a review close holds while the same ask keeps coming for six hours, and never comes back as a blip", (t) => {
  const now = clock();
  const store = new FleetStore({ dir: tempDir(t), now });
  const ask = { dedupeKey: "ready:o/r#7:abc", kind: "ready", title: "#7 ready. Merge?", options: ["merged", "later"] };
  const first = store.upsertQuestion(ask);
  const closed = store.closeByReview(first.id, { category: "stale", reason: "merged in another thread", fingerprint: "f1" });
  assert.equal(closed.status, "resolved");
  assert.equal(closed.resolvedBy, "review");
  assert.equal(closed.resolveReason, "review: stale: merged in another thread");
  assert.equal(closed.reviewFingerprint, "f1");
  // Inside the reopen window and for hours of asking: still the closed record.
  for (let hour = 0; hour < 5; hour += 1) {
    now.advance(HOUR);
    const again = store.upsertQuestion(ask);
    assert.equal(again.suppressed, true);
    assert.equal(again.id, first.id);
  }
  assert.deepEqual(store.openQuestions(), []);
  assert.deepEqual(store.reviewClosed().map((q) => q.id), [first.id], "reopenable while it holds");
  // A model's guess is checked again: six hours after the close, the same
  // ask is a new question (the supervisor reviews it before it pings).
  now.advance(HOUR);
  const recheck = store.upsertQuestion(ask);
  assert.notEqual(recheck.id, first.id);
  assert.equal(recheck.suppressed, undefined);
  assert.equal(recheck.reopened, undefined);
  assert.deepEqual(store.reviewClosed(), [], "its ask is open again");
  // Closed again: the Cleared list shows one row per ask, the newest.
  store.closeByReview(recheck.id, { category: "stale", reason: "still merged" });
  assert.deepEqual(store.reviewClosed().map((q) => q.id), [recheck.id]);
  // A day with no ask drops it from the list.
  now.advance(25 * HOUR);
  assert.deepEqual(store.reviewClosed(), []);
  const fresh = store.upsertQuestion(ask);
  assert.notEqual(fresh.id, recheck.id);
});

test("every held review close is listed for Reopen, past the old limit of 20", (t) => {
  const store = new FleetStore({ dir: tempDir(t), now: clock() });
  for (let i = 0; i < 30; i += 1) {
    const q = store.upsertQuestion({ dedupeKey: `ask:codex:t${i}:h`, kind: "agent-ask", threadKey: `codex:t${i}`, title: `Merge ${i}?`, options: ["yes", "no"] });
    store.closeByReview(q.id, { category: "junk", reason: "status line" });
  }
  assert.equal(store.reviewClosed().length, 30);
});

test("only the supervisor's own resolve counts as resolvedOnly, not a review close", (t) => {
  const now = clock();
  const store = new FleetStore({ dir: tempDir(t), now });
  const ask = { dedupeKey: "ask:codex:a:h", kind: "agent-ask", threadKey: "codex:a", title: "Merge?", options: ["yes", "no"] };
  const first = store.upsertQuestion(ask);
  assert.equal(store.resolvedOnly(ask.dedupeKey), false, "open");
  store.resolveQuestion(first.id, "pr merged");
  assert.equal(store.resolvedOnly(ask.dedupeKey), true);
  now.advance(2 * HOUR);
  const second = store.upsertQuestion(ask);
  store.closeByReview(second.id, { category: "stale", reason: "optional offer" });
  // The review close is left to upsertQuestion, which keeps its ask time fresh.
  assert.equal(store.resolvedOnly(ask.dedupeKey), false);
  now.advance(HOUR);
  assert.equal(store.upsertQuestion(ask).suppressed, true);
  assert.equal(store.question(second.id).lastAskedAt, new Date(T0 + 3 * HOUR).toISOString());
});

test("an agent's ask keeps the message it came from; a re-raised one takes the new one", (t) => {
  const now = clock();
  const store = new FleetStore({ dir: tempDir(t), now });
  const ask = (context, at) => ({
    dedupeKey: "ask:codex:a:h", kind: "agent-ask", threadKey: "codex:a", title: "remote-dev: asks you. Answer?", body: "Want me to make that edit?",
    options: ["yes", "no"], askContext: context, agentAskedAt: at
  });
  const fixtureToken = "sk-ant-" + "a".repeat(64);
  const first = store.upsertQuestion(ask(`${"x".repeat(900)} Edit the pr-verification skill (token ${fixtureToken}). Want me to make that edit?`, "2026-09-26T11:50:00.000Z"));
  assert.equal(first.askContext.length, 600);
  assert.match(first.askContext, /Want me to make that edit\?$/);
  assert.ok(!first.askContext.includes(fixtureToken));
  assert.equal(first.agentAskedAt, "2026-09-26T11:50:00.000Z");
  // The thread moved on while the ask stays open: the first context stands.
  now.advance(10 * 60 * 1000);
  const again = store.upsertQuestion(ask("Disk is at 91%; the app reconnected.", "2026-09-26T12:05:00.000Z"));
  assert.equal(again.id, first.id);
  assert.equal(again.agentAskedAt, "2026-09-26T11:50:00.000Z");
  // Closed and asked again: the new sighting is the context.
  store.resolveQuestion(first.id, "moved on");
  now.advance(10 * 60 * 1000);
  const back = store.upsertQuestion(ask("New run. Want me to make that edit?", "2026-09-26T12:15:00.000Z"));
  assert.equal(back.id, first.id);
  assert.equal(back.reopened, true);
  assert.equal(back.askContext, "New run. Want me to make that edit?");
  assert.equal(back.agentAskedAt, "2026-09-26T12:15:00.000Z");
  // Other kinds carry none.
  assert.equal(store.upsertQuestion({ dedupeKey: "ready:x", kind: "ready", title: "#7 ready. Merge?", options: ["merged", "later"] }).askContext, undefined);
});

test("a review kept with nothing changed counts a streak; a change resets it", (t) => {
  const store = new FleetStore({ dir: tempDir(t), now: clock() });
  const q = store.upsertQuestion({ dedupeKey: "k", kind: "agent-ask", title: "Merge?", options: ["yes", "no"] });
  assert.equal(store.recordReview(q.id, { fingerprint: "f1" }).reviewStreak, 0);
  assert.equal(store.recordReview(q.id, { fingerprint: "f1" }).reviewStreak, 1);
  assert.equal(store.recordReview(q.id, { fingerprint: "f1" }).reviewStreak, 2);
  assert.equal(store.recordReview(q.id, { fingerprint: "f2" }).reviewStreak, 0);
});

test("a review-closed group that covers another thread is a new question, not the old one revived", (t) => {
  const now = clock();
  const store = new FleetStore({ dir: tempDir(t), now });
  const group = (keys) => ({ dedupeKey: "open:group", kind: "open", threadKeys: keys, title: `${keys.length} stuck, can't reach. Open them?`, options: ["opened", "skip"] });
  const first = store.upsertQuestion(group(["codex:a", "codex:b"]));
  store.closeByReview(first.id, { category: "done-elsewhere", reason: "another thread took both over" });
  now.advance(10 * 60 * 1000);
  assert.equal(store.upsertQuestion(group(["codex:a"])).suppressed, true, "a smaller group is the same ask");
  assert.deepEqual(store.reviewClosed().map((q) => q.id), [first.id]);
  const wider = store.upsertQuestion(group(["codex:a", "codex:c"]));
  assert.notEqual(wider.id, first.id);
  assert.equal(wider.reopened, undefined);
  assert.equal(store.question(first.id).status, "resolved");
  // Its ask is open again, so the page does not offer a Reopen that fails.
  assert.deepEqual(store.reviewClosed(), []);
  assert.equal(store.reopenReviewed(first.id), null);
});

test("a review rewrite survives the same ask and yields to a reworded one", (t) => {
  const now = clock();
  const store = new FleetStore({ dir: tempDir(t), now });
  const ask = { dedupeKey: "ask:codex:a:h1", kind: "agent-ask", threadKey: "codex:a", title: "madrid: needs your call. Answer?", body: "Merge or wait?", options: ["yes", "no"] };
  const first = store.upsertQuestion(ask);
  const kept = store.recordReview(first.id, { title: "bb #6899: merge now?", options: ["merge now", "wait"], fingerprint: "f1", reason: "waits on the owner", category: "live" });
  assert.equal(kept.title, "bb #6899: merge now?");
  assert.deepEqual(kept.options, ["merge now", "wait"]);
  assert.deepEqual(kept.askedAs, { title: ask.title, options: ["yes", "no"] });
  assert.equal(kept.reviewReason, "waits on the owner");
  assert.equal(kept.reviewedAt, new Date(T0).toISOString());

  now.advance(5 * 60 * 1000);
  const again = store.upsertQuestion(ask);
  assert.equal(again.id, first.id);
  assert.equal(again.title, "bb #6899: merge now?");
  assert.deepEqual(again.options, ["merge now", "wait"]);
  // A second review keeps the policy's wording underneath.
  store.recordReview(first.id, { title: "bb #6899: merge with --admin?", fingerprint: "f2" });
  assert.deepEqual(store.question(first.id).askedAs, { title: ask.title, options: ["yes", "no"] });

  // The policy words it differently: its words show until the next review.
  const reworded = store.upsertQuestion({ ...ask, title: "madrid: wants to merge. OK?" });
  assert.equal(reworded.id, first.id);
  assert.equal(reworded.title, "madrid: wants to merge. OK?");
  assert.deepEqual(reworded.options, ["yes", "no"]);
  assert.equal(reworded.askedAs, null);
  assert.equal(store.recordReview("fq_missing", { title: "x" }), null);
});

test("a pinned question survives a review close; only a review close reopens, as the same record", (t) => {
  const now = clock();
  const store = new FleetStore({ dir: tempDir(t), now });
  const ask = { dedupeKey: "ask:codex:a:h1", kind: "agent-ask", threadKey: "codex:a", title: "Merge?", options: ["yes", "no"] };
  const first = store.upsertQuestion(ask);
  store.markQuestionNotified(first.id, { outreachId: "out_1" });
  assert.equal(store.reopenReviewed(first.id), null, "an open question is not reopened");
  store.closeByReview(first.id, { category: "junk", reason: "status line" });
  assert.deepEqual(store.reviewClosed().map((q) => q.id), [first.id]);

  now.advance(60 * 1000);
  const back = store.reopenReviewed(first.id);
  assert.equal(back.id, first.id);
  assert.equal(back.status, "open");
  assert.equal(back.pinned, true);
  assert.equal(back.resolvedBy, null);
  assert.equal(back.outreachId, "out_1");
  assert.equal(back.reopenedAt, new Date(T0 + 60 * 1000).toISOString());
  assert.equal(store.closeByReview(first.id, { category: "stale" }), null, "pinned");
  assert.equal(store.question(first.id).status, "open");
  assert.deepEqual(store.reviewClosed(), []);

  // An owner dismissal is not a review close.
  store.dismissQuestion(first.id);
  assert.equal(store.reopenReviewed(first.id), null);
});

test("a review close is not reopened over a newer open copy of the same ask", (t) => {
  const now = clock();
  const store = new FleetStore({ dir: tempDir(t), now });
  const ask = { dedupeKey: "k", title: "Merge?", options: ["yes", "no"] };
  const first = store.upsertQuestion(ask);
  store.closeByReview(first.id, { category: "stale" });
  now.advance(26 * HOUR);
  const fresh = store.upsertQuestion(ask);
  assert.notEqual(fresh.id, first.id);
  assert.equal(store.reopenReviewed(first.id), null);
});

test("an owner close covers the threads it named: a group with other members is a new question", (t) => {
  const now = clock();
  const store = new FleetStore({ dir: tempDir(t), now });
  const group = (keys) => ({ dedupeKey: "open:group", kind: "open", threadKeys: keys, title: `${keys.length} stuck, can't reach. Open them?`, options: ["opened", "skip"] });
  const first = store.upsertQuestion(group(["codex:a", "codex:b"]));
  store.answerQuestion(first.id, "skip");
  now.advance(10 * 60 * 1000);
  assert.equal(store.upsertQuestion(group(["codex:a"])).suppressed, true, "a smaller group is covered");
  const shifted = store.upsertQuestion(group(["codex:c"]));
  assert.equal(shifted.suppressed, undefined);
  assert.notEqual(shifted.id, first.id);
});

test("app restart records, the last restart time and question meta survive a reload", (t) => {
  const dir = tempDir(t);
  const now = clock();
  const store = new FleetStore({ dir, now });
  store.setAppRestart("conductor", { action: "restart", at: new Date(T0).toISOString(), threadKeys: ["conductor:s1"], due: true, done: [] });
  store.markRestarted("conductor", T0);
  const question = store.upsertQuestion({ dedupeKey: "infra:unreadable:conductor", kind: "infra", title: "Restart?", options: ["restart", "later"],
    meta: { app: "conductor", runningKeys: ["conductor:s1", 7], ignored: { nested: true } } });
  assert.deepEqual(question.meta, { app: "conductor", runningKeys: ["conductor:s1"] });
  const reloaded = new FleetStore({ dir, now });
  assert.deepEqual(reloaded.appRestart("conductor").threadKeys, ["conductor:s1"]);
  assert.deepEqual(reloaded.appRestarts().map((record) => record.app), ["conductor"]);
  assert.equal(reloaded.restartedAt("conductor"), T0);
  assert.deepEqual(reloaded.question(question.id).meta, { app: "conductor", runningKeys: ["conductor:s1"] });
  reloaded.setAppRestart("conductor", null);
  assert.equal(new FleetStore({ dir, now }).appRestart("conductor"), null);
});

test("a card item keeps its raw labels, a long body, and a dismissal holds its later re-ask", (t) => {
  const now = clock();
  const store = new FleetStore({ dir: tempDir(t), now });
  const labels = ["us-east-1", "us-west-2", "eu-west-1", "Confirm deletion of these five tracked threads", "ap-south-1"];
  const body = `${"Which region should the QA profile use? ".repeat(8)}1. us-east-1`;
  const base = store.upsertQuestion({ dedupeKey: "card:codex:t1:turn-a:0", kind: "agent-card", threadKey: "codex:t1", title: "t1: region (1/1)", body, options: ["open thread"], meta: { labels, freeText: "1" } });
  assert.deepEqual(base.meta.labels, labels);
  assert.equal(base.body.length, body.length);
  store.dismissQuestion(base.id);
  // Asked every tick until the item turns a day old, then under its late key.
  now.advance(23 * HOUR);
  assert.equal(store.upsertQuestion({ dedupeKey: "card:codex:t1:turn-a:0", kind: "agent-card", threadKey: "codex:t1", title: "t1: region (1/1)", body, options: ["open thread"] }).suppressed, true);
  now.advance(HOUR);
  const late = store.upsertQuestion({ dedupeKey: "card:codex:t1:turn-a:0:late", baseKey: "card:codex:t1:turn-a:0", kind: "agent-card", threadKey: "codex:t1", title: "Still open: t1: region (1/1)", body, options: ["open thread"] });
  assert.equal(late.suppressed, true);
  assert.equal(store.openQuestions().length, 0);
  // Never dismissed: the late ask is a new question.
  const other = store.upsertQuestion({ dedupeKey: "card:codex:t1:turn-b:0:late", baseKey: "card:codex:t1:turn-b:0", kind: "agent-card", threadKey: "codex:t1", title: "Still open", body: "q", options: ["open thread"] });
  assert.equal(other.suppressed, undefined);
  assert.equal(other.status, "open");
});

test("a nudge keeps when its send started, its message hash and the facts it was about", (t) => {
  const store = new FleetStore({ dir: tempDir(t), now: clock() });
  store.recordNudge("codex:a", {
    at: "2026-09-26T12:00:02.000Z", sentAt: "2026-09-26T12:00:00.000Z", playbook: "merge-ready", route: "codex-exec", status: "sent",
    messageHash: "abc", factsKey: "k1", facts: ["head 1234567890", "lint failing", ...Array.from({ length: 10 }, (_, i) => `f${i}`)]
  });
  store.recordNudge("codex:a", { at: "2026-09-26T12:20:00.000Z", playbook: "resume", status: "sent" });
  const [first, second] = store.ledgerFor("codex:a").nudges;
  assert.equal(first.sentAt, "2026-09-26T12:00:00.000Z");
  assert.equal(first.messageHash, "abc");
  assert.equal(first.factsKey, "k1");
  assert.equal(first.facts.length, 8);
  assert.deepEqual(first.facts.slice(0, 2), ["head 1234567890", "lint failing"]);
  assert.equal(second.sentAt, undefined);
  assert.equal(second.factsKey, undefined);
});

test("an 'open thread' tap on a card holds while the card is still asked, past the TTL", (t) => {
  const now = clock();
  const store = new FleetStore({ dir: tempDir(t), now });
  const ask = () => store.upsertQuestion({ dedupeKey: "card:codex:t1:call_x:0", kind: "agent-card", threadKey: "codex:t1", title: "t1: sign in", body: "Please sign in.", options: ["open thread"] });
  store.answerQuestion(ask().id, "open thread");
  // Asked every tick for two days: the owner is not pinged again.
  for (let hour = 0; hour < 48; hour += 1) {
    now.advance(HOUR);
    assert.equal(ask().suppressed, true);
  }
});

// Audit 2026-10-12: the live list still held "4 stopped. Nudges can't get
// through" from 2026-10-09T07:34Z, its expiry pushed back by every scan.
test("an open question saved by an older build expires a day after it was created", (t) => {
  const dir = tempDir(t);
  const now = Date.parse("2026-10-13T04:53:00.000Z");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({
    version: 1,
    questions: [
      { id: "fq_6516028b7a83443b", dedupeKey: "deliver:group", kind: "deliver", threadKeys: ["codex:a", "codex:b"], title: "4 stopped. Nudges can't get through. Nudge them?", options: ["nudge", "skip"],
        status: "open", createdAt: "2026-10-09T07:34:05.695Z", updatedAt: "2026-10-13T04:48:00.000Z", lastAskedAt: "2026-10-13T04:48:00.000Z", expiresAt: "2026-10-14T04:48:00.000Z", outreachId: "out_old" },
      { id: "fq_a9b2b47748584a67", dedupeKey: "ask:conductor:ad4e780b:f72523c2360d0211", kind: "agent-ask", threadKey: "conductor:ad4e780b", title: "buildbetter #7633: merge once checks pass?", options: ["yes", "no"],
        status: "open", createdAt: "2026-10-13T04:48:37.020Z", updatedAt: "2026-10-13T04:48:37.020Z", lastAskedAt: "2026-10-13T04:48:37.020Z", expiresAt: "2026-10-14T04:48:37.020Z" }
    ]
  }));
  const store = new FleetStore({ dir, now: () => now });
  assert.deepEqual(store.openQuestions().map((q) => q.id), ["fq_a9b2b47748584a67"]);
  assert.equal(store.question("fq_6516028b7a83443b").status, "expired");
  assert.deepEqual(store.takeExpired().map((q) => [q.id, q.outreachId]), [["fq_6516028b7a83443b", "out_old"]]);
});

// Audit 2026-10-12: #7352 asked "admin merge ok?" at 15:07:54Z and again in
// a new message at 17:25:12Z; each message became its own question.
test("a newer ask from the same agent takes its open question in place", (t) => {
  const now = clock(Date.parse("2026-10-12T16:47:33.000Z"));
  const store = new FleetStore({ dir: tempDir(t), now });
  const base = { kind: "agent-ask", threadKey: "conductor:9953b207", prRef: "buildbetter-app/buildbetter#7352", options: ["yes", "no"], mergeAsk: true };
  const first = store.upsertQuestion({ ...base, dedupeKey: "ask:conductor:9953b207:aaaa", title: "buildbetter #7352: wants an --admin merge. OK?", agentAskedAt: "2026-10-12T15:07:54.712Z", askContext: "Merging still needs your explicit go" });
  store.markQuestionNotified(first.id, { outreachId: "out_1", pushedAt: new Date(now()).toISOString() });
  store.recordReview(first.id, { title: "buildbetter #7352: admin merge ok?", fingerprint: "f1", reason: "still open" });
  now.advance(HOUR);
  const again = store.upsertQuestion({ ...base, dedupeKey: "ask:conductor:9953b207:bbbb", title: "buildbetter #7352: needs your call. Answer?", agentAskedAt: "2026-10-12T17:25:12.159Z", askContext: "Merges: need your explicit go." });
  assert.equal(again.id, first.id);
  assert.equal(again.superseded, true);
  const stored = store.question(first.id);
  assert.deepEqual([stored.dedupeKey, stored.agentAskedAt, stored.title, stored.outreachId, stored.reviewedAt, stored.createdAt],
    ["ask:conductor:9953b207:bbbb", "2026-10-12T17:25:12.159Z", "buildbetter #7352: needs your call. Answer?", "out_1", null, first.createdAt]);
  assert.equal(store.openQuestions().length, 1);
  // An older message, or another thread, never takes it over.
  assert.notEqual(store.upsertQuestion({ ...base, dedupeKey: "ask:conductor:9953b207:cccc", title: "old", agentAskedAt: "2026-10-12T15:00:00.000Z" }).id, first.id);
  assert.notEqual(store.upsertQuestion({ ...base, threadKey: "conductor:other", dedupeKey: "ask:conductor:other:dddd", title: "other", agentAskedAt: "2026-10-12T18:00:00.000Z" }).id, first.id);
});

// A long Conductor chat that opens several PRs: its merge ask about a new PR
// is not a restatement of the old PR's, so it is pushed and gets its own day.
test("a merge ask about another PR in the same thread gets its own day and push", (t) => {
  const now = clock(Date.parse("2026-10-12T04:00:00.000Z"));
  const store = new FleetStore({ dir: tempDir(t), now });
  const base = { kind: "agent-ask", threadKey: "conductor:cape", options: ["yes", "no"], mergeAsk: true, askContext: "Merging needs your go." };
  const first = store.upsertQuestion({ ...base, prRef: "buildbetter-app/buildbetter#7063", dedupeKey: "ask:conductor:cape:aaaa", title: "buildbetter #7063: merge it?", agentAskedAt: "2026-10-12T03:59:00.000Z" });
  store.markQuestionNotified(first.id, { outreachId: "out_1", pushedAt: new Date(now()).toISOString() });
  now.advance(23 * HOUR);
  const next = store.upsertQuestion({ ...base, prRef: "buildbetter-app/buildbetter#7089", dedupeKey: "ask:conductor:cape:bbbb", title: "buildbetter #7089: merge it?", agentAskedAt: "2026-10-13T02:59:00.000Z" });
  assert.equal(next.id, first.id);
  assert.equal(next.pushedAt, null, "the new PR's ask is pushed");
  now.advance(2 * HOUR);
  assert.deepEqual(store.openQuestions().map((q) => q.id), [first.id], "not expired on the old PR's day");
  // The same PR asked again keeps its push and its day.
  store.markQuestionNotified(first.id, { outreachId: "out_2", pushedAt: new Date(now()).toISOString() });
  now.advance(HOUR);
  const same = store.upsertQuestion({ ...base, prRef: "buildbetter-app/buildbetter#7089", dedupeKey: "ask:conductor:cape:cccc", title: "buildbetter #7089: ready, merge?", agentAskedAt: "2026-10-13T06:00:00.000Z" });
  assert.ok(same.pushedAt);
});

// An owner answer whose background send failed near the end of the
// question's day is put back with a day of its own, not expired at once.
test("a question reopened after a failed answer delivery gets a fresh day", (t) => {
  const now = clock();
  const store = new FleetStore({ dir: tempDir(t), now });
  const q = store.upsertQuestion({ dedupeKey: "ask:conductor:x:aaaa", kind: "agent-ask", threadKey: "conductor:x", title: "Ship it?", options: ["yes", "no"], agentAskedAt: new Date(T0 - 1000).toISOString() });
  now.advance(23 * HOUR + 50 * 60 * 1000);
  store.queueAnswer(q.id, "yes", "Yes, ship it.");
  now.advance(20 * 60 * 1000);
  const back = store.reopenQuestion(q.id, ["conductor:x"], { answer: "yes" });
  assert.equal(back.status, "open");
  assert.deepEqual(store.openQuestions().map((one) => one.id), [q.id], "still open after the old day ended");
  now.advance(23 * HOUR);
  assert.deepEqual(store.openQuestions().map((one) => one.id), [q.id]);
});

// milan 1941cea4 asked "who gets the free Coda token?" at 04:38Z. A new
// decision from the same agent 23 h later took that open question over with
// its push spent and its day nearly gone: it expired an hour later, never
// pushed, then stayed quiet a day.
test("a different ask that supersedes an open one gets its own day and push", (t) => {
  const now = clock(Date.parse("2026-10-12T04:38:00.000Z"));
  const store = new FleetStore({ dir: tempDir(t), now });
  const base = { kind: "agent-ask", threadKey: "conductor:1941cea4", options: ["yes", "no"], askContext: "Blocked on: your call." };
  const coda = store.upsertQuestion({ ...base, dedupeKey: "ask:conductor:1941cea4:aaaa", title: "milan: who gets the free Coda token?", body: "Who gets the free Coda token?", agentAskedAt: "2026-10-12T04:37:40.000Z" });
  store.markQuestionNotified(coda.id, { outreachId: "out_1", pushedAt: new Date(now()).toISOString() });
  now.advance(23 * HOUR);
  const deploy = store.upsertQuestion({ ...base, dedupeKey: "ask:conductor:1941cea4:bbbb", title: "milan: approve production deploy?", body: "Approve the production deploy?", agentAskedAt: "2026-10-13T03:37:00.000Z" });
  assert.equal(deploy.id, coda.id);
  assert.equal(deploy.superseded, true);
  assert.equal(deploy.pushedAt, null, "the new decision is pushed");
  now.advance(2 * HOUR);
  assert.deepEqual(store.openQuestions().map((q) => q.id), [coda.id], "not expired on the old ask's day");
  now.advance(22 * HOUR);
  assert.deepEqual(store.openQuestions(), []);
  // The same question restated (the same ask) keeps its push and its day.
  const later = clock(Date.parse("2026-10-12T04:38:00.000Z"));
  const again = new FleetStore({ dir: tempDir(t), now: later });
  const first = again.upsertQuestion({ ...base, dedupeKey: "ask:conductor:1941cea4:cccc", title: "milan: who gets the free Coda token?", body: "Who gets the free Coda token?", agentAskedAt: "2026-10-12T04:37:40.000Z" });
  again.markQuestionNotified(first.id, { outreachId: "out_2", pushedAt: new Date(later()).toISOString() });
  later.advance(23 * HOUR);
  const restated = again.upsertQuestion({ ...base, dedupeKey: "ask:conductor:1941cea4:dddd", title: "milan: who gets the free Coda token?", body: "Who gets the free Coda token?", agentAskedAt: "2026-10-13T03:37:00.000Z" });
  assert.equal(restated.id, first.id);
  assert.ok(restated.pushedAt);
  later.advance(2 * HOUR);
  assert.deepEqual(again.openQuestions(), []);
});

// Titles are generic per topic: two different prod approvals on one PR both
// read "wants a prod step. OK?". The second is a new decision for the owner.
test("a different ask under the same generic title still gets its own push and day", (t) => {
  const now = clock(Date.parse("2026-10-12T04:38:00.000Z"));
  const store = new FleetStore({ dir: tempDir(t), now });
  const base = { kind: "agent-ask", threadKey: "conductor:1941cea4", prRef: "buildbetter-app/buildbetter#7087", options: ["yes", "no"], title: "milan wants a prod step. OK?", askContext: "Blocked on: your call." };
  const one = store.upsertQuestion({ ...base, dedupeKey: "ask:conductor:1941cea4:eeee", body: "Approve the production DB migration?", agentAskedAt: "2026-10-12T04:37:40.000Z" });
  store.markQuestionNotified(one.id, { outreachId: "out_3", pushedAt: new Date(now()).toISOString() });
  now.advance(20 * HOUR);
  const two = store.upsertQuestion({ ...base, dedupeKey: "ask:conductor:1941cea4:ffff", body: "Approve the production deploy of the web app?", agentAskedAt: "2026-10-13T00:37:00.000Z" });
  assert.equal(two.id, one.id);
  assert.equal(two.pushedAt, null, "pushed anew");
  now.advance(10 * HOUR);
  assert.deepEqual(store.openQuestions().map((q) => q.id), [one.id], "its own day, not the old one's");
});

test("unchanged answered and dismissed judge asks survive the reply-key upgrade", (t) => {
  for (const close of ["answer", "dismiss"]) {
    const now = clock();
    const dir = tempDir(t);
    const store = new FleetStore({ dir, now });
    const base = { kind: "agent-ask", askedBy: "judge", threadKey: "codex:t", title: "Merge?", body: "CI is green.", options: ["yes", "no"], agentAskedAt: new Date(now()).toISOString() };
    const replyKey = "ask:codex:t:aaaaaaaaaaaaaaaa";
    const first = store.upsertQuestion({ ...base, dedupeKey: replyKey });
    if (close === "answer") store.answerQuestion(first.id, "no");
    else store.dismissQuestion(first.id);
    const reloaded = new FleetStore({ dir, now });
    const unchanged = reloaded.upsertQuestion({ ...base, dedupeKey: `${replyKey}:bbbbbbbbbbbbbbbb` });
    assert.equal(unchanged.id, first.id);
    assert.equal(unchanged.suppressed, true, close);
    const changed = reloaded.upsertQuestion({ ...base, body: "CI is failing. Bypass it?", dedupeKey: `${replyKey}:cccccccccccccccc` });
    assert.notEqual(changed.id, first.id);
    assert.equal(changed.status, "open");
  }
});
