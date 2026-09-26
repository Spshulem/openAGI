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

  const second = store.upsertQuestion({ dedupeKey: "model-limit:codex:a", title: "capped again" });
  assert.notEqual(second.id, first.id);
  const dismissed = store.dismissQuestion(second.id);
  assert.equal(dismissed.status, "dismissed");
  assert.equal(store.dismissQuestion(second.id), null);
  assert.equal(store.question(first.id).answer, "yes");
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
