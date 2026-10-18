import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ACTION_LOG_MAX, DAY_MS, diagnose, foldActions } from "../src/fleet/diagnose.js";
import { FleetStore } from "../src/fleet/store.js";
import { FleetSupervisor } from "../src/fleet/supervisor.js";
import { resolveFleetConfig } from "../src/fleet/contracts.js";
import { createDiagnoseModels, diagnoseDue, readDiagnoseInputs } from "../src/fleet/suggestions.js";
import { october13 } from "./fixtures/fleet-diagnose.js";

const NOW = new Date(2026, 9, 13, 20).getTime();
const at = (offset = 0) => new Date(NOW + offset).toISOString();
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-diagnose-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("October 13 fixture: 432 blocked, 89/99 unanswered, 28 relay exit 1, 35 Claude limits", () => {
  const report = diagnose(october13(NOW));
  assert.equal(report.metrics.computerUseBlocked, 432);
  assert.equal(report.metrics.plannedNudges, 540);
  assert.equal(report.metrics.questions.asked, 99);
  assert.equal(report.metrics.questions.closedUnanswered, 89);
  assert.equal(report.metrics.questions.unansweredRate, 89 / 99);
  assert.equal(report.metrics.sendsByRoute["peer-relay"].exit1, 28);
  assert.equal(report.metrics.review.failures, 37);
  assert.equal(report.metrics.review.modelLimitFailures, 35);
  for (const metric of ["questions-unanswered", "send-failure:peer-relay", "review-failures", "review-model-limits"]) assert.ok(report.anomalies.some((a) => a.metric === metric), metric);
});

test("folding update-only rows retains kind, route and original time, and counts once", () => {
  assert.deepEqual(foldActions([{ id: "a", kind: "review", at: at(), status: "planned" }, { op: "update", id: "a", status: "failed" }]), [{ id: "a", kind: "review", at: at(), status: "failed" }]);
  assert.equal(diagnose({ now: NOW, actions: [{ op: "update", id: "orphan", status: "failed" }] }).metrics.plannedNudges, 0);
});

test("computer blocks need two adjacent days above 50%, not two separated days", () => {
  const rows = (day, blocked = 6) => Array.from({ length: 10 }, (_, i) => ({ id: `${day}-${i}`, kind: "nudge", at: at(-day * DAY_MS), route: "computer-use", status: i < blocked ? "blocked" : "sent" }));
  const metric = (actions) => diagnose({ actions, now: NOW }).anomalies.some((a) => a.metric === "computer-use-blocked");
  assert.equal(metric([...rows(0), ...rows(1)]), true);
  assert.equal(metric([...rows(0), ...rows(2)]), false);
  assert.equal(metric([...rows(0, 5), ...rows(1)]), false);
});

test("route failures need ten sends and strictly more than twenty percent", () => {
  const rows = (n, failures) => Array.from({ length: n }, (_, i) => ({ id: String(i), at: at(), kind: "nudge", route: "codex-exec", status: i < failures ? "failed" : "sent" }));
  const anomalous = (rows) => diagnose({ now: NOW, actions: rows }).anomalies.some((a) => a.metric === "send-failure:codex-exec");
  assert.equal(anomalous(rows(9, 9)), false);
  assert.equal(anomalous(rows(10, 2)), false);
  assert.equal(anomalous(rows(10, 3)), true);
});

test("legacy executor delivery rows without kind and CLI done count as send outcomes", () => {
  const actions = Array.from({ length: 10 }, (_, i) => ({ id: `old${i}`, at: at(), route: "codex-exec", status: i < 3 ? "failed" : "done" }));
  actions.push({ id: "click", at: at(), kind: "click", route: "codex-exec", status: "failed" });
  const report = diagnose({ now: NOW, actions });
  assert.equal(report.metrics.sendsByRoute["codex-exec"].attempts, 10);
  assert.equal(report.metrics.sendsByRoute["codex-exec"].failures, 3);
  assert.ok(report.anomalies.some((a) => a.metric === "send-failure:codex-exec"));
});

test("repeats, judge waits/failures, flicker, titles, escalation and spend thresholds", () => {
  const rows = [];
  for (let i = 0; i < 10; i += 1) rows.push({ id: `j${i}`, kind: "judge", at: at(), status: "done", verdict: i < 8 ? "wait" : "send" });
  for (let i = 0; i < 3; i += 1) rows.push({ id: `jf${i}`, kind: "judge", at: at(), status: "failed" });
  for (let i = 0; i < 6; i += 1) rows.push({ id: `n${i}`, kind: "nudge", threadKey: "t", playbook: "resume", progressMark: "head1", at: at(), status: "sent", detail: "Two threads share this title" });
  rows.push({ id: "e", kind: "escalate-manager", at: at(), status: "failed" });
  const report = diagnose({ now: NOW, actions: rows, questions: [{ reopenHistory: Array(6).fill(at()) }], budget: [{ at: at(), channel: "voice", usd: 3 }, ...Array.from({ length: 7 }, (_, i) => ({ at: at(-(i + 1) * DAY_MS), channel: "voice", usd: 1 }))] });
  for (const metric of ["repeat-nudge", "judge-wait", "judge-failures", "question-flicker", "shared-title", "escalation-success", "spend:voice"]) assert.ok(report.anomalies.some((a) => a.metric === metric), metric);
  assert.equal(diagnose({ now: NOW, actions: rows.map((r, i) => ({ ...r, progressMark: String(i) })) }).metrics.repeats.length, 0);
});

test("unsent escalation plans are not failed attempts", () => {
  const rows = ["planned", "proposed", "stale", "dry-run"].map((status, i) => ({ id: `e${i}`, kind: "escalate-manager", at: at(), status }));
  const report = diagnose({ now: NOW, actions: rows });
  assert.equal(report.metrics.escalation.attempts, 0);
  assert.ok(!report.anomalies.some((a) => a.metric === "escalation-success"));
  const tried = diagnose({ now: NOW, actions: [...rows, { id: "ef", kind: "escalate-manager", at: at(), status: "failed" }] });
  assert.equal(tried.metrics.escalation.attempts, 1);
  assert.ok(tried.anomalies.some((a) => a.metric === "escalation-success"));
});

test("07:30 daily diagnosis checks the complete local day and its prior seven spend days", async (t) => {
  const dataDir = temp(t);
  const now = new Date(2026, 9, 14, 7, 31).getTime();
  const yesterday = new Date(2026, 9, 13, 15).toISOString();
  const config = resolveFleetConfig({}, { home: dataDir, selfFix: { mode: "off" }, limits: { quietHours: { start: 22, end: 7 } } });
  const supervisor = new FleetSupervisor({ dataDir, config, deps: { now: () => now } });
  for (const [kind, count] of [["judge", 3], ["review", 8], ["classify", 6]]) {
    for (let i = 0; i < count; i += 1) supervisor.store.recordAction({ kind, at: yesterday, status: "failed",
      reason: kind === "review" ? "usage limit" : kind === "classify" ? "Two threads share this title" : "failed" });
  }
  for (let i = 0; i < 6; i += 1) {
    supervisor.store.upsertQuestion({ dedupeKey: `flicker-${i}`, title: "Ask", kind: "test" });
    supervisor.store.state.questions.at(-1).reopenHistory = [yesterday];
  }
  const budget = [{ at: yesterday, channel: "voice", usd: 10 }];
  for (let i = 1; i <= 7; i += 1) budget.push({ at: new Date(2026, 9, 13 - i, 0, 1).toISOString(), channel: "voice", usd: 1 });
  // Today's partial spending must not enter yesterday's baseline or total.
  budget.push({ at: new Date(now).toISOString(), channel: "voice", usd: 100 });
  fs.mkdirSync(path.join(dataDir, "budget"));
  fs.writeFileSync(path.join(dataDir, "budget", "ledger.jsonl"), budget.map((row) => JSON.stringify(row)).join("\n"));
  await supervisor.diagnoseTick();
  const report = supervisor.store.state.diagnosis.full;
  assert.equal(report.metrics.day, "2026-10-13");
  assert.equal(report.metrics.review.failures, 8);
  assert.equal(report.metrics.judge.failures, 3);
  assert.equal(report.metrics.sharedTitles, 6);
  assert.equal(report.metrics.questions.reopens, 6);
  assert.deepEqual(report.metrics.spend.voice, { today: 10, median: 1 });
  for (const metric of ["judge-failures", "review-failures", "review-model-limits", "shared-title", "question-flicker", "spend:voice"]) {
    assert.ok(report.anomalies.some((a) => a.metric === metric), metric);
  }
  const manual = await supervisor.diagnose();
  assert.equal(manual.metrics.day, "2026-10-14");
  assert.equal(manual.metrics.review.failures, 0);
  assert.equal(manual.metrics.spend.voice.today, 100);
});

test("reopened owner holds exclude sends while the hold was lifted", (t) => {
  let clock = new Date(2026, 9, 13, 10).getTime();
  const store = new FleetStore({ dir: path.join(temp(t), "fleet"), now: () => clock });
  const hold = { dedupeKey: "held:t:h", threadKey: "t", title: "Owner hold", kind: "owner-hold" };
  const question = store.upsertQuestion(hold);
  const action = (id) => store.recordAction({ id, kind: "nudge", threadKey: "t", status: "sent" });
  clock += 45 * 60_000;
  store.resolveQuestion(question.id);
  clock += 15 * 60_000;
  action("lifted");
  clock += 30 * 60_000;
  const reopened = store.upsertQuestion(hold);
  assert.equal(reopened.id, question.id);
  assert.ok(reopened.reopenedAt);
  assert.equal(diagnose({ now: clock, cheap: true, actions: store.actions(), questions: store.state.questions }).metrics.ownerHoldViolations, 0);
  action("reopened-hold");
  clock += 10 * 60_000;
  store.resolveQuestion(question.id);
  action("resolved");
  const report = diagnose({ now: clock, cheap: true, actions: store.actions(), questions: store.state.questions });
  assert.deepEqual(report.anomalies.find((a) => a.metric === "owner-hold").evidenceActionIds, ["reopened-hold"]);
  const live = { ...store.state.questions[0], reopenedAt: null, liveSince: reopened.reopenedAt };
  assert.equal(diagnose({ now: clock, actions: store.actions(), questions: [live] }).metrics.ownerHoldViolations, 1);
});

test("hourly checks storage and actual sends inside owner holds; owner answers are exempt", () => {
  const actions = [
    { id: "send", at: at(-1000), kind: "nudge", status: "sent", threadKey: "t" },
    { id: "legacy", at: at(-1000), route: "codex-exec", status: "done", threadKey: "t" },
    { id: "owner", at: at(-1000), route: "codex-exec", playbook: "owner-message", status: "done", threadKey: "t" },
    { id: "answer", at: at(-1000), kind: "owner-answer", status: "owner-answer", threadKey: "t" },
    { id: "blocked", at: at(-1000), kind: "nudge", status: "blocked", threadKey: "t" }
  ];
  const report = diagnose({ now: NOW, cheap: true, actions, questions: [{ dedupeKey: "held:t:h", threadKey: "t", status: "open", createdAt: at(-5000) }], storage: { freeBytes: 4 * 1024 ** 3, actionsBytes: ACTION_LOG_MAX + 1, tmpFiles: [{ size: 0, mtimeMs: NOW - 3600001 }, { size: 1, mtimeMs: 0 }] } });
  assert.equal(report.metrics.ownerHoldViolations, 2);
  assert.equal(report.anomalies.find((a) => a.metric === "owner-hold").severity, "high");
  assert.equal(report.anomalies.length, 4);
  assert.equal(diagnose({ now: NOW, actions, questions: [{ dedupeKey: "held:t:h", threadKey: "t", createdAt: at(-5000), answeredAt: at(-2000), status: "answered" }] }).metrics.ownerHoldViolations, 0);
});

test("repeated change feedback groups a stable target regardless of key order/view", () => {
  const feedback = [
    { id: "1", at: at(), intent: "change", status: "new", utterance: "Too many asks", target: { view: "one", threadKey: "t", actionId: "a" } },
    { id: "2", at: at(), intent: "change", status: "triaged", utterance: "Again too many", target: { actionId: "a", threadKey: "t", view: "two" } }
  ];
  const report = diagnose({ now: NOW, feedback });
  assert.equal(report.anomalies.length, 1);
  assert.deepEqual(report.anomalies[0].feedbackIds, ["1", "2"]);
  assert.equal(diagnose({ now: NOW, feedback: [...feedback.slice(0, 1), { ...feedback[1], status: "fix-queued" }] }).anomalies.length, 0);
});

test("daily local 07:30 defers through quiet hours; hourly and persisted daily markers", () => {
  const time = (h, m = 0) => new Date(2026, 9, 13, h, m).getTime();
  assert.equal(diagnoseDue({}, time(7, 29), { start: 22, end: 7 }).daily, false);
  assert.equal(diagnoseDue({}, time(7, 30), { start: 22, end: 7 }).daily, true);
  assert.equal(diagnoseDue({}, time(7, 30), { start: 22, end: 8 }).daily, false);
  assert.equal(diagnoseDue({}, time(8), { start: 22, end: 8 }).daily, true);
  assert.equal(diagnoseDue({ dailyDay: "2026-10-13", hourlyAt: new Date(time(8)).toISOString() }, time(8, 5)).daily, false);
  assert.equal(diagnoseDue({ hourlyAt: new Date(time(8)).toISOString() }, time(8, 5)).hourly, false);
});

test("storage reader and rotation use the temporary dataDir, retaining folded records", (t) => {
  const dataDir = temp(t);
  const store = new FleetStore({ dir: path.join(dataDir, "fleet"), now: () => NOW });
  const rows = Array.from({ length: 160 }, (_, i) => ({ id: `a${i}`, at: at(-i), kind: "nudge", status: "planned", detail: "x".repeat(33000) }));
  rows.push({ op: "update", id: "a0", status: "failed" });
  fs.writeFileSync(store.journalPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  fs.writeFileSync(path.join(store.dir, "old.tmp"), "");
  fs.utimesSync(path.join(store.dir, "old.tmp"), new Date(NOW - DAY_MS), new Date(NOW - DAY_MS));
  const input = readDiagnoseInputs({ store, dataDir, now: NOW });
  assert.ok(input.storage.actionsBytes > ACTION_LOG_MAX);
  assert.equal(input.storage.tmpFiles.length, 1);
  assert.equal(store.rotateActions(), true);
  assert.ok(fs.statSync(store.journalPath).size < ACTION_LOG_MAX);
  const reloaded = new FleetStore({ dir: store.dir });
  const action = reloaded.actionHistory().find((a) => a.id === "a0");
  assert.equal(action.kind, "nudge"); assert.equal(action.status, "failed");
  assert.equal(new Set(reloaded.actionHistory().map((a) => a.id)).size, reloaded.actionHistory().length);
});

test("a journal update can recover its missing record fields from the state tail", (t) => {
  const store = new FleetStore({ dir: path.join(temp(t), "fleet"), now: () => NOW });
  const record = store.recordAction({ kind: "nudge", route: "computer-use", status: "planned" });
  fs.writeFileSync(store.journalPath, JSON.stringify({ op: "update", id: record.id, status: "failed" }) + "\n");
  const [folded] = store.actionHistory();
  assert.equal(folded.kind, "nudge"); assert.equal(folded.route, "computer-use"); assert.equal(folded.status, "failed");
});

test("supervisor daily diagnosis is once across reloads, hourly checks persist, on-demand is read-only", async (t) => {
  const dataDir = temp(t);
  let calls = 0;
  const deps = { now: () => NOW, diagnoseModels: { explain: async ({ anomalies }) => { calls += 1; return { anomalyId: anomalies.find((a) => a.area === "review").id, area: "review", remedy: "setup", nextAction: "Review provider limits before retrying", rootCause: "Limits", proposedFix: "Use available review model", acceptance: "Reviews complete", confidence: 0.7, minutesSavedPerDay: 5, evidenceActionIds: [] }; }, duplicate: async () => false }, notifier: { notifyQuestion: async () => ({ pushed: false }) } };
  const config = resolveFleetConfig({}, { home: dataDir, selfFix: { mode: "propose" } });
  const supervisor = new FleetSupervisor({ dataDir, config, deps });
  for (const row of october13(NOW - DAY_MS).actions.filter((a) => a.kind === "review")) supervisor.store.recordAction(row);
  await supervisor.diagnoseTick();
  assert.equal(calls, 1); assert.equal(supervisor.suggestions().length, 1);
  assert.equal(supervisor.store.openQuestions()[0].kind, "suggestion");
  const reload = new FleetSupervisor({ dataDir, config, deps });
  await reload.diagnoseTick(); assert.equal(calls, 1);
  const before = fs.readFileSync(supervisor.store.statePath, "utf8");
  await supervisor.diagnose();
  assert.equal(fs.readFileSync(supervisor.store.statePath, "utf8"), before);
  assert.equal(calls, 2);
});

test("diagnose models share the locked-down judge, exact models, schemas and fail-closed probe", async (t) => {
  const home = temp(t);
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(path.join(home, ".codex/config.toml"), 'model_provider = "lb"\n[model_providers.lb]\nbase_url = "http://example.invalid"\nwire_api = "responses"\nenv_key = "CODEX_LB_API_KEY"\n');
  const calls = [];
  const run = async (_bin, args, options) => {
    if (args[0] === "features") return { code: 0, stdout: "shell_tool stable false\napps stable false" };
    if (args[0] === "mcp") return { code: 0, stdout: "[]" };
    calls.push(args);
    assert.equal(args[args.indexOf("-s") + 1], "read-only");
    assert.notEqual(options.env.HOME, home);
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    assert.equal(options.env.HOST_BRIDGE_TOKEN, undefined);
    assert.ok(args.includes("--output-schema"));
    if (args[args.indexOf("-m") + 1] === "gpt-6.1-sol") {
      const schema = JSON.parse(fs.readFileSync(args[args.indexOf("--output-schema") + 1], "utf8"));
      assert.ok(schema.required.includes("anomalyId"));
      assert.match(args.at(-1), /exact anomalyId/);
    }
    const out = args[args.indexOf("-m") + 1] === "gpt-6-luna" ? { duplicate: false } : { anomalyId: "anomaly-0", area: "review", remedy: "setup", nextAction: "Review provider limits before retrying", rootCause: "Limits", proposedFix: "Retry review", acceptance: "Passes", confidence: 0.8, minutesSavedPerDay: 2, evidenceActionIds: [] };
    fs.writeFileSync(args[args.indexOf("-o") + 1], JSON.stringify(out));
    return { code: 0, stdout: "" };
  };
  const config = resolveFleetConfig({}, { home, bins: { codex: "/bin/fake-codex" } });
  const models = createDiagnoseModels({ config, run, now: () => NOW, env: { PATH: process.env.PATH, HOME: home, OPENAI_API_KEY: "not-for-child", HOST_BRIDGE_TOKEN: "not-for-child" } });
  await models.explain({ anomalies: [{ metric: "review-failures" }] });
  assert.equal(await models.duplicate({ candidate: {} }), false);
  assert.deepEqual(calls.map((a) => a[a.indexOf("-m") + 1]), ["gpt-6.1-sol", "gpt-6-luna"]);
  const unsafe = createDiagnoseModels({ config, run: async () => ({ code: 0, stdout: "shell_tool stable true" }) });
  await assert.rejects(unsafe.explain({}), /lockdown failed/);
});

test("blocked-day evidence stays inside the selected window", () => {
  const actions = [2, 3].map((day) => ({ id: `old-${day}`, at: at(-day * DAY_MS), kind: "nudge", route: "computer-use", status: "blocked" }));
  const daily = diagnose({ now: NOW, actions });
  assert.equal(daily.metrics.plannedNudges, 0);
  assert.deepEqual(daily.metrics.blockedByDay, {});
  assert.equal(daily.anomalies.some((a) => a.metric === "computer-use-blocked"), false);
  const weekly = diagnose({ now: NOW, actions, window: "7d" });
  assert.deepEqual(weekly.anomalies.find((a) => a.metric === "computer-use-blocked").evidenceActionIds, ["old-2", "old-3"]);
});

test("storage diagnosis uses default and configured policy thresholds", async (t) => {
  const storage = { freeBytes: 20 * 1024 ** 3 };
  const low = (value) => diagnose({ now: NOW, cheap: true, storage: value }).anomalies.some((a) => a.metric === "storage-free");
  assert.equal(low(storage), true);
  assert.equal(low({ ...storage, lowGb: 10 }), false);
  assert.equal(low({ ...storage, lowGb: 20 }), false);
  assert.equal(low({ ...storage, lowGb: 30 }), true);
  const dataDir = temp(t);
  const config = resolveFleetConfig({}, { home: dataDir, storage: { lowGb: 42 } });
  const supervisor = new FleetSupervisor({ dataDir, config, deps: { now: () => NOW } });
  const report = await supervisor.diagnose({ cheap: true });
  assert.equal(report.metrics.storage.lowGb, 42);
  assert.equal(report.anomalies.some((a) => a.metric === "storage-free"), report.metrics.storage.freeBytes < 42 * 1024 ** 3);
});

test("action history keeps the latest failures after the in-state tail fills", (t) => {
  const store = new FleetStore({ dir: path.join(temp(t), "fleet"), now: () => NOW, limits: { maxActionsKept: 3 } });
  for (let i = 0; i < 30; i += 1) store.recordAction({ id: `a${i}`, at: at(-30000 + i * 1000), kind: "nudge", route: "peer-relay", status: "failed" });
  store.updateAction("a29", { detail: "latest failure" });
  const actions = store.actionHistory();
  assert.deepEqual(actions.map((a) => a.id), Array.from({ length: 30 }, (_, i) => `a${i}`));
  assert.equal(actions.at(-1).detail, "latest failure");
  const anomaly = diagnose({ now: NOW, actions }).anomalies.find((a) => a.metric === "send-failure:peer-relay");
  assert.deepEqual(anomaly.evidenceActionIds, Array.from({ length: 20 }, (_, i) => `a${i + 10}`));
  assert.deepEqual(anomaly.evidenceActionIds.slice(-5), ["a25", "a26", "a27", "a28", "a29"]);
});

test("cached hourly diagnoses are exposed through state and survive reload", async (t) => {
  const dataDir = temp(t);
  const config = resolveFleetConfig({}, { home: dataDir, selfFix: { mode: "off" } });
  const deps = { now: () => new Date(2026, 9, 13, 6).getTime() };
  const supervisor = new FleetSupervisor({ dataDir, config, deps });
  supervisor.store.recordAction({ kind: "nudge", ownerHold: true, status: "sent" });
  await supervisor.diagnoseTick();
  const cached = supervisor.getState().diagnosis;
  assert.equal(cached.cheap.anomalies.find((a) => a.metric === "owner-hold").severity, "high");
  cached.cheap.anomalies.length = 0;
  assert.ok(supervisor.getState().diagnosis.cheap.anomalies.length);
  const reloaded = new FleetSupervisor({ dataDir, config, deps });
  assert.deepEqual(reloaded.getState().diagnosis, supervisor.getState().diagnosis);
});

test("occasional spend without a positive median is not a spike", () => {
  const budget = [0, 1, 3, 5].map((day) => ({ at: at(-day * DAY_MS), channel: "voice", usd: 1 }));
  const report = diagnose({ now: NOW, budget });
  assert.equal(report.metrics.spend.voice.median, 0);
  assert.equal(report.anomalies.some((a) => a.metric === "spend:voice"), false);
  assert.equal(diagnose({ now: NOW, budget: [budget[0]] }).anomalies.length, 0);
  budget.push({ at: at(-2 * DAY_MS), channel: "voice", usd: 1 });
  assert.equal(diagnose({ now: NOW, budget }).anomalies.length, 0);
  budget[0].usd = 3;
  assert.ok(diagnose({ now: NOW, budget }).anomalies.some((a) => a.metric === "spend:voice"));
});

test("event rates use each metric's actual lookback", () => {
  const questions = Array.from({ length: 7 }, (_, i) => ({ createdAt: at(-i * DAY_MS), status: "resolved" }));
  const actions = Array.from({ length: 7 }, (_, i) => ({ id: `judge-${i}`, at: at(-i * DAY_MS), kind: "judge", status: "done", verdict: "wait" }));
  actions.push(...Array.from({ length: 5 }, (_, i) => ({ id: `review-${i}`, at: at(), kind: "review", status: "failed" })));
  const feedback = Array.from({ length: 7 }, (_, i) => ({ id: `f${i}`, at: at(-i * DAY_MS), intent: "change", status: "new", target: { threadKey: "t" } }));
  for (const window of ["24h", "7d"]) {
    const report = diagnose({ now: NOW, window, questions, actions, feedback });
    for (const metric of ["questions-unanswered", "judge-wait", 'feedback:[["threadKey","t"]]']) {
      assert.equal(report.anomalies.find((a) => a.metric === metric).eventsPerDay, 1, `${window} ${metric}`);
    }
    assert.equal(report.anomalies.find((a) => a.metric === "review-failures").eventsPerDay, 5);
  }
});
