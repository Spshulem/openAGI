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
  assert.deepEqual(empty, { nudges: [], lastProgressMark: null, attemptsWithoutProgress: 0, lastNudgeAt: null });

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

test("questions expire after 24 hours", (t) => {
  const now = clock();
  const store = new FleetStore({ dir: tempDir(t), now });
  const question = store.upsertQuestion({ dedupeKey: "k", title: "Merge #6522?" });
  now.advance(23 * HOUR);
  assert.equal(store.openQuestions().length, 1);
  now.advance(2 * HOUR);
  assert.deepEqual(store.openQuestions(), []);
  assert.equal(store.question(question.id).status, "expired");
  assert.equal(store.answerQuestion(question.id, "yes"), null);
  const fresh = store.upsertQuestion({ dedupeKey: "k", title: "Merge #6522?" });
  assert.notEqual(fresh.id, question.id);
});

test("a question asked every tick keeps its id past 24 hours and expires a TTL after the last ask", (t) => {
  const now = clock();
  const store = new FleetStore({ dir: tempDir(t), now });
  const first = store.upsertQuestion({ dedupeKey: "ready:o/r#113:abc", title: "#113 ready. Merge?" });
  store.markQuestionNotified(first.id, { outreachId: "out_1" });
  for (let hour = 5; hour <= 40; hour += 5) {
    now.advance(5 * HOUR);
    assert.equal(store.upsertQuestion({ dedupeKey: "ready:o/r#113:abc", title: "#113 ready. Merge?" }).id, first.id);
  }
  assert.equal(store.question(first.id).lastAskedAt, new Date(T0 + 40 * HOUR).toISOString());
  assert.deepEqual(store.takeExpired(), []);

  now.advance(23 * HOUR);
  assert.equal(store.openQuestions().length, 1);
  now.advance(HOUR);
  assert.deepEqual(store.openQuestions(), []);
  assert.equal(store.question(first.id).status, "expired");
  // Handed out once, so the supervisor closes the outreach copy once.
  assert.deepEqual(store.takeExpired().map((q) => [q.id, q.outreachId]), [[first.id, "out_1"]]);
  assert.deepEqual(store.takeExpired(), []);
  // Asked again after a full TTL of silence: a new question.
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

test("a review close holds while the same ask keeps coming, however long, and never comes back as a blip", (t) => {
  const now = clock();
  const store = new FleetStore({ dir: tempDir(t), now });
  const ask = { dedupeKey: "ready:o/r#7:abc", kind: "ready", title: "#7 ready. Merge?", options: ["merged", "later"] };
  const first = store.upsertQuestion(ask);
  const closed = store.closeByReview(first.id, { category: "stale", reason: "merged in another thread", fingerprint: "f1" });
  assert.equal(closed.status, "resolved");
  assert.equal(closed.resolvedBy, "review");
  assert.equal(closed.resolveReason, "review: stale: merged in another thread");
  assert.equal(closed.reviewFingerprint, "f1");
  // Inside the reopen window and past a day of asking: still the closed record.
  for (let hour = 0; hour < 30; hour += 3) {
    now.advance(3 * HOUR);
    const again = store.upsertQuestion(ask);
    assert.equal(again.suppressed, true);
    assert.equal(again.id, first.id);
  }
  assert.deepEqual(store.openQuestions(), []);
  assert.deepEqual(store.reviewClosed().map((q) => q.id), [first.id], "reopenable while it holds");
  // A day with no ask ends the hold: the next ask is a new question.
  now.advance(25 * HOUR);
  assert.deepEqual(store.reviewClosed(), []);
  const fresh = store.upsertQuestion(ask);
  assert.notEqual(fresh.id, first.id);
  assert.equal(fresh.suppressed, undefined);
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
