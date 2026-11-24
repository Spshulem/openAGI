// test/budget-guard-ledger.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BudgetGuard } from "../src/budget-guard.js";
import { CreditLedger } from "../src/credit-ledger.js";

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-"));
  const ledger = new CreditLedger({ storePath: path.join(dir, "ledger.jsonl") });
  const guard = new BudgetGuard({ storePath: path.join(dir, "usage.json"), ledger });
  return { guard, ledger };
}

test("record(meta) writes a ledger entry carrying the context", () => {
  const { guard, ledger } = tmp();
  guard.record({ input_tokens: 1000, output_tokens: 500 }, "claude-opus-4-7", {
    channel: "autopilot", agentId: "main", sessionId: "s9", from: "cron", tools: ["web_search", "add_task"]
  });
  const rows = ledger.query({ days: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, "autopilot");
  assert.deepEqual(rows[0].tools, ["web_search", "add_task"]);
  assert.equal(rows[0].model, "claude-opus-4-7");
  assert.ok(rows[0].usd > 0);
  assert.equal(rows[0].tokens.input, 1000);
});

test("record without meta still aggregates and does not throw (back-compat)", () => {
  const { guard, ledger } = tmp();
  const res = guard.record({ input_tokens: 100, output_tokens: 50 }, "gpt-5");
  assert.ok(res.added > 0);
  const rows = ledger.query({ days: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, null);
});

test("priceFor bills nano/mini variants at their own rate, not flagship (longest-prefix)", () => {
  const g = new BudgetGuard({ storePath: path.join(os.tmpdir(), `bg-${Date.now()}.json`) });
  // gpt-5.4-nano must NOT resolve to gpt-5 ($5/$15) — it's $0.20/$1.25.
  assert.equal(g.priceFor("gpt-5.4-nano").in, 0.2, "nano input price, not flagship");
  assert.equal(g.priceFor("gpt-5.4-nano").out, 1.25);
  assert.equal(g.priceFor("gpt-5-nano").in, 0.05);
  assert.equal(g.priceFor("gpt-5.4-mini").in, 0.75);
  assert.equal(g.priceFor("gpt-5.5").out, 30, "gpt-5.5 output is $30, not gpt-5's $15");
  assert.equal(g.priceFor("gpt-5").in, 5, "flagship still flagship");
  // an unknown future variant matches the longest sensible prefix, not bare gpt-5
  assert.equal(g.priceFor("gpt-5.4-nano-2027").in, 0.2);
});

test("recordUsd writes a caller-priced voice row that counts toward the day and the channel", () => {
  const { guard, ledger } = tmp();
  guard.recordUsd(0.0177, "gpt-realtime-2.1", { channel: "voice", sessionId: "devices:supervisor:main", tokens: { input: 398, output: 86 } });
  guard.record({ input_tokens: 1000, output_tokens: 500 }, "claude-haiku-4-5", { channel: "autopilot" });
  const [row] = ledger.query({ days: 1 }).filter((entry) => entry.channel === "voice");
  assert.equal(row.usd, 0.0177);
  assert.equal(row.tokens.input, 398);
  assert.equal(Number(guard.channelUsdToday("voice").toFixed(4)), 0.0177);
  assert.equal(guard.status().calls, 2);
  assert.ok(guard.status().spentUsd >= 0.0177);
});

test("voice reservations persist independently of reported spend and settle by id", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-budget-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { storePath: path.join(dir, "usage.json") };
  const guard = new BudgetGuard(options);
  guard.setVoiceReservation("session:audio", 0.2);
  guard.setVoiceReservation("session:response", 0.5);
  const reloaded = new BudgetGuard(options);
  assert.deepEqual(reloaded.voiceReservationsToday(), { "session:audio": 0.2, "session:response": 0.5 });
  reloaded.recordUsd(0.03, "gpt-realtime-2.1", { channel: "voice" });
  reloaded.setVoiceReservation("session:response", 0);
  const settled = new BudgetGuard(options);
  assert.deepEqual(settled.voiceReservationsToday(), { "session:audio": 0.2 });
  assert.equal(settled.channelUsdToday("voice"), 0.03);
  assert.equal(settled.status().spentUsd, 0.03);
});

test("voice metering fails closed when the ledger cannot be written", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-ledger-fail-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const guard = new BudgetGuard({ storePath: path.join(dir, "usage.json"), ledger: { record: () => { throw new Error("disk full"); }, query: () => [] } });
  guard.setVoiceReservation("in-flight", 0.5);
  assert.throws(() => guard.recordUsd(0.1, "gpt-realtime-2.1", { channel: "voice" }), /disk full/);
  assert.deepEqual(new BudgetGuard({ storePath: guard.storePath }).voiceReservationsToday(), { "in-flight": 0.5 });
});

test("outstanding voice holds reduce the shared budget for text and embedding callers", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-shared-budget-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { storePath: path.join(dir, "usage.json"), dailyUsdLimit: 1 };
  const guard = new BudgetGuard(options);
  guard.recordUsd(0.25, "text-model");
  guard.setVoiceReservation("audio", 0.25);
  guard.setVoiceReservation("response", 0.5);
  assert.throws(() => guard.check(), { code: "BUDGET_EXCEEDED" });
  assert.throws(() => new BudgetGuard(options).check(), { code: "BUDGET_EXCEEDED" });
  guard.setVoiceReservation("response", 0);
  assert.doesNotThrow(() => guard.check());
  assert.doesNotThrow(() => guard.check(0.49));
  assert.throws(() => guard.check(0.5), { code: "BUDGET_EXCEEDED" });
  guard.setVoiceReservation("audio", 0);
  assert.doesNotThrow(() => guard.check(0.5));
});

test("daily budget resets on local midnight and rebuckets legacy UTC late-night spend from ledger", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-local-day-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const storePath = path.join(dir, "usage.json");
  const ledger = new CreditLedger({ storePath: path.join(dir, "ledger.jsonl") });

  // Simulate legacy v0.0.83 UTC Linux server (`distiller`) on Friday Nov 20 at 11:33 PM PST
  // (`2026-11-21T07:33:56Z`), which previously bucketed Friday night's $10.05 spend into `"2026-11-21"`.
  const fridayNightUtc = new Date("2026-11-21T07:33:56.000Z");
  const legacyUtcGuard = new BudgetGuard({
    storePath,
    ledger,
    dailyUsdLimit: 10,
    timeZone: "UTC",
    now: () => fridayNightUtc
  });
  legacyUtcGuard.recordUsd(10.05, "gpt-6.2-sol", { channel: "chat", now: fridayNightUtc });
  assert.equal(legacyUtcGuard.status().today, "2026-11-21");
  assert.equal(legacyUtcGuard.status().exceeded, true);

  // Simulate legacy usage.json having no `daysTimeZone` field yet
  const rawLegacy = JSON.parse(fs.readFileSync(storePath, "utf8"));
  delete rawLegacy.daysTimeZone;
  delete rawLegacy.timeZone;
  fs.writeFileSync(storePath, JSON.stringify(rawLegacy));

  // Next morning: Saturday Nov 21 at 8:08 AM PST (`2026-11-21T16:08:53Z`).
  const saturdayMorningUtc = new Date("2026-11-21T16:08:53.000Z");
  const serverGuard = new BudgetGuard({
    storePath,
    ledger,
    dailyUsdLimit: 10,
    now: () => saturdayMorningUtc
  });
  // Override explicit/OS timezone to simulate a UTC Linux host before client sync
  serverGuard._explicitTimeZone = null;
  serverGuard.timeZone = "UTC";
  serverGuard.state.daysTimeZone = "UTC";
  assert.equal(serverGuard.status().exceeded, true, "before adopting owner's timezone, UTC day is still 2026-11-21");

  // Paired iPhone/Mac sends `X-OpenAGI-Timezone: America/Los_Angeles`
  const adopted = serverGuard.adoptClientTimeZone("America/Los_Angeles");
  assert.equal(adopted, true);

  const status = serverGuard.status();
  assert.equal(status.timeZone, "America/Los_Angeles");
  assert.equal(status.today, "2026-11-21");
  assert.equal(status.spentUsd, 0, "Friday 11:33 PM PST spend rebuckets to 2026-11-20, leaving Saturday at $0");
  assert.equal(status.remainingUsd, 10);
  assert.equal(status.exceeded, false);
  assert.doesNotThrow(() => serverGuard.check());
  assert.equal(
    status.history.find((h) => h.date === "2026-11-20")?.usd,
    10.05,
    "Friday local day retains the $10.05 spend in history"
  );

  // Headless UTC node hint must never clobber an already-adopted local timezone
  assert.equal(serverGuard.adoptClientTimeZone("UTC"), false);
  assert.equal(serverGuard.adoptClientTimeZone("Etc/UTC"), false);
  assert.equal(serverGuard.status().timeZone, "America/Los_Angeles");
});
