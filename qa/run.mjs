import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const capabilities = JSON.parse(fs.readFileSync(path.join(root, "qa/capabilities.json"), "utf8"));
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: npm run qa:capabilities -- [--area sharing|google|pebble|routines|subagents|skills_mcp|web|computer|voice|memory_interfaces]\nRuns isolated offline tests with fake provider transports. Does not connect live accounts or send messages. Results: qa/results/latest.json");
  process.exit(0);
}
if (args.length && (args.length !== 2 || args[0] !== "--area" || !capabilities[args[1]])) throw new Error("Use --help for supported options.");
const selected = args.length ? [[args[1], capabilities[args[1]]]] : Object.entries(capabilities);
const output = path.join(root, "qa/results");
fs.mkdirSync(output, { recursive: true });
const report = { startedAt: new Date().toISOString(), evidence: "offline automated tests with fixture providers", liveAccounts: "NOT_RUN", areas: [] };

for (const [id, area] of selected) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `openagi-qa-${id}-`));
  // Tests must not inherit working credentials or the installed data dir.
  const env = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "SYSTEMROOT"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  Object.assign(env, { OPENAGI_DATA_DIR: dataDir, OPENAGI_TICKER_MS: "0", TELEGRAM_POLLING: "0", IMESSAGE_ENABLED: "0", OPENAGI_IMESSAGE_BRIDGE: "0", OPENAGI_COMPUTER_USE: "0", OPENAGI_VOICE: "0" });
  const started = Date.now();
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1", ...area.tests], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      let log = "";
      child.stdout.on("data", chunk => { log += chunk; });
      child.stderr.on("data", chunk => { log += chunk; });
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal, log }));
    });
    fs.writeFileSync(path.join(output, `${id}.tap`), result.log, { mode: 0o600 });
    const count = label => Number(result.log.match(new RegExp(`^# ${label} (\\d+)$`, "m"))?.[1] ?? 0);
    const row = { id, label: area.label, passed: result.code === 0, tests: count("tests"), failures: count("fail"), skipped: count("skipped"), durationMs: Date.now() - started, log: `${id}.tap`, ...(result.signal ? { signal: result.signal } : {}) };
    report.areas.push(row);
    console.log(`${row.passed ? "PASS" : "FAIL"} ${id}: ${row.tests} tests, ${row.failures} failures, ${row.skipped} skipped (${row.durationMs}ms)`);
    if (!row.passed) console.log(result.log.slice(-6000));
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
}
report.finishedAt = new Date().toISOString();
report.passed = report.areas.every(area => area.passed);
report.tests = report.areas.reduce((sum, area) => sum + area.tests, 0);
fs.writeFileSync(path.join(output, "latest.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(`${report.passed ? "PASS" : "FAIL"}: ${report.tests} automated tests across ${report.areas.length} areas. Live account acceptance: NOT RUN.`);
console.log(path.join(output, "latest.json"));
process.exitCode = report.passed ? 0 : 1;
