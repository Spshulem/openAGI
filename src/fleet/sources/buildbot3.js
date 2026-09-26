// BuildBot3 and codex-lb health for the fleet supervisor. One batch-mode SSH
// probe per tick, made only of reads (ps, ls, cat, readlink, systemctl
// list-timers). Never docker: when Docker wedges, docker calls hang while
// plain reads still answer. Nothing here throws.

import fs from "node:fs";
import { clampText, readTail, redactSecrets, runCommand, toIso } from "../contracts.js";

const PROBE_TIMEOUT_MS = 40_000;
const LB_TIMEOUT_MS = 5_000;
const WATCHED_TIMERS = Object.freeze(["lb-health", "lb-guard", "bb-ci-warm"]);
// "( |$)" keeps bb-verify-sweep and bb-verify-docker.py out of the run list.
const TOOL = /bin\/bb-(quick|verify)(?=\s|$)/;

// "[b]in" stops grep and pgrep from matching this script's own command line.
export const BB3_PROBE_SCRIPT = [
  'echo "@@ps"',
  'ps -eo pid=,ppid=,etimes=,args= | grep -E "[b]in/bb-(quick|verify)( |$)"',
  'echo "@@out"',
  'for p in $(pgrep -f "[b]in/bb-(quick|verify)( |$)"); do echo "$p $(readlink /proc/$p/fd/1 2>/dev/null)"; done',
  'echo "@@quick"',
  'ls "$HOME/.bb-ci/quick/queue" 2>/dev/null | wc -l',
  'echo "@@full"',
  'ls "$HOME/.bb-ci/canonical-verification/queue" 2>/dev/null | wc -l',
  'echo "@@gate"',
  'cat "$HOME/.bb-ci/gate-status.json" 2>/dev/null',
  "echo",
  'echo "@@load"',
  "cat /proc/loadavg",
  'echo "@@timers"',
  "systemctl --user list-timers --all --no-pager 2>&1",
  'echo "@@end"'
].join("\n");

const LOG_NOISE = new Set([
  "bb", "bbq", "bbverify", "bbquick", "verify", "quick", "full", "log", "logs", "exit", "test", "tests",
  "run", "bb3", "ci", "merge", "head", "out", "write", "rerun", "retry", "pr"
]);

function isLogNoise(token) {
  return LOG_NOISE.has(token)
    || /^\d+$/.test(token)
    || /^(pr|r|write|rerun|retry|run|attempt)\d+$/.test(token)
    || (/^[0-9a-f]{7,40}$/.test(token) && /\d/.test(token));
}

function logBase(file) {
  const base = String(file ?? "").split("/").pop();
  return base.endsWith(".log") ? base.slice(0, -4) : null;
}

// Agents name their remote logs after their workspace: "monrovia-pr6874-full.log",
// "bb-verify-6873-sydney.log". What is left after dropping PR numbers, lane
// words, retry counters, and shas is the owner.
export function ownerFromLog(file) {
  const base = logBase(file);
  if (!base) return null;
  const owner = base.toLowerCase().split(/[-_.]+/).filter((token) => token && !isLogNoise(token)).join("-");
  return owner && owner.length <= 40 ? owner : null;
}

function prFromLog(file) {
  const base = logBase(file);
  if (!base) return null;
  const match = /(?:^|[-_.])pr-?(\d{2,6})(?=$|[-_.])/i.exec(base) ?? /(?:^|[-_.])(\d{3,6})(?=$|[-_.])/.exec(base);
  return match ? Number(match[1]) : null;
}

function splitSections(text) {
  const sections = new Map();
  let current = null;
  for (const line of String(text ?? "").split("\n")) {
    const marker = /^@@(\w+)\s*$/.exec(line);
    if (marker) {
      current = marker[1];
      sections.set(current, []);
    } else if (current) {
      sections.get(current).push(line);
    }
  }
  return sections;
}

function parseCount(lines) {
  const text = (lines ?? []).join("\n").trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}

function parseLoad(lines) {
  const values = (lines ?? []).join(" ").trim().split(/\s+/).slice(0, 3).map(Number);
  return values.length === 3 && values.every(Number.isFinite) ? values : null;
}

function parseGate(lines) {
  let gate = null;
  try { gate = JSON.parse((lines ?? []).join("\n").trim()); } catch { gate = null; }
  if (!gate || typeof gate !== "object") return { state: null, reason: null, since: null };
  const firstText = (list) => (Array.isArray(list) ? list.find((item) => typeof item === "string" && item.trim()) : null) ?? null;
  const reason = firstText(gate.blockers) ?? firstText(gate.warnings);
  return {
    state: typeof gate.state === "string" ? gate.state : null,
    reason: reason ? clampText(reason, 200) : null,
    // gate-status.json has no transition time; probeBuildBot3 carries it across ticks.
    since: null
  };
}

export function parseTimersDead(text) {
  const source = String(text ?? "");
  const lines = source.split("\n");
  // A failed systemctl (no user bus) says nothing about the timers.
  if (!/\btimers? listed\b/i.test(source) && !lines.some((line) => /\.timer\b/.test(line))) return [];
  return WATCHED_TIMERS.filter((name) => {
    const line = lines.find((row) => row.trim().split(/\s+/).includes(`${name}.timer`));
    return !line || /^(-|n\/a)$/.test(line.trim().split(/\s+/)[0]);
  });
}

function parseProcesses(lines) {
  const processes = new Map();
  for (const line of lines ?? []) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match || !TOOL.test(match[4])) continue;
    processes.set(Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]), ageSec: Number(match[3]), args: match[4] });
  }
  return processes;
}

function parseStdoutTargets(lines) {
  const targets = new Map();
  for (const line of lines ?? []) {
    const match = /^\s*(\d+)\s*(.*)$/.exec(line);
    if (match) targets.set(Number(match[1]), match[2].trim());
  }
  return targets;
}

// The bb-quick/bb-verify invocation inside a command line, up to the first
// shell operator, so flags of later commands in a wrapper are ignored.
function invocation(args) {
  const match = TOOL.exec(args);
  if (!match) return null;
  return { tool: match[1], text: args.slice(match.index).split(/[;&|>]/)[0] };
}

function describeRun(leaf, chain, targets) {
  const call = invocation(leaf.args);
  const calls = chain.map((proc) => invocation(proc.args)).filter(Boolean);
  const flag = (pattern) => {
    for (const item of calls) {
      const match = pattern.exec(item.text);
      if (match) return match[1];
    }
    return null;
  };
  const logs = [];
  for (const proc of chain) {
    if (targets.get(proc.pid)) logs.push(targets.get(proc.pid));
    for (const redirect of proc.args.matchAll(/>\s*(\S+\.log)\b/g)) logs.push(redirect[1]);
  }
  const pr = flag(/--pr[=\s]+(\d+)/);
  const head = flag(/--head[=\s]+([0-9a-f]{7,40})\b/i);
  return {
    pid: leaf.pid,
    // bb-verify without --full execs bb-quick.
    kind: call?.tool === "verify" && /\s--full\b/.test(call.text) ? "full" : "quick",
    pr: pr ? Number(pr) : logs.map(prFromLog).find((value) => value !== null) ?? null,
    head: head ? head.toLowerCase() : null,
    ageSec: leaf.ageSec,
    owner: logs.map(ownerFromLog).find(Boolean) ?? null
  };
}

// Wrappers (bash -c, timeout) and the python process they start all match;
// each run is reported once, as the deepest matching process.
function collectRuns(processes, targets) {
  const hasMatchingChild = new Set();
  for (const proc of processes.values()) if (processes.has(proc.ppid)) hasMatchingChild.add(proc.ppid);
  const runs = [];
  for (const leaf of processes.values()) {
    if (hasMatchingChild.has(leaf.pid)) continue;
    const chain = [leaf];
    const seen = new Set([leaf.pid]);
    let parent = processes.get(leaf.ppid);
    while (parent && !seen.has(parent.pid)) {
      chain.push(parent);
      seen.add(parent.pid);
      parent = processes.get(parent.ppid);
    }
    runs.push(describeRun(leaf, chain, targets));
  }
  return runs.sort((a, b) => b.ageSec - a.ageSec || a.pid - b.pid);
}

function emptyBb3(now, error) {
  return {
    reachable: false,
    checkedAt: toIso(now),
    gate: { state: null, reason: null, since: null },
    fullQueue: null,
    quickQueue: null,
    load: null,
    runs: [],
    timersDead: [],
    error
  };
}

export function parseBb3Probe(text, now = Date.now()) {
  const sections = splitSections(text);
  if (!sections.has("ps")) return emptyBb3(now, "probe output missing markers");
  return {
    reachable: true,
    checkedAt: toIso(now),
    gate: parseGate(sections.get("gate")),
    fullQueue: parseCount(sections.get("full")),
    quickQueue: parseCount(sections.get("quick")),
    load: parseLoad(sections.get("load")),
    runs: collectRuns(parseProcesses(sections.get("ps")), parseStdoutTargets(sections.get("out"))),
    timersDead: parseTimersDead((sections.get("timers") ?? []).join("\n")),
    error: sections.has("end") ? null : "probe output incomplete"
  };
}

function sshError(result) {
  const stderrLine = String(result?.stderr ?? "").split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
  const text = result?.error || stderrLine || `ssh exited ${result?.code ?? "?"}`;
  return clampText(redactSecrets(text), 200);
}

// The gate file has no "since"; keep the first time this state was seen.
function withGateSince(bb3, previous) {
  if (!bb3.gate.state || !previous) return bb3;
  const prior = previous.gate ?? {};
  const since = prior.state === bb3.gate.state ? (prior.since ?? previous.checkedAt ?? null) : bb3.checkedAt;
  return { ...bb3, gate: { ...bb3.gate, since } };
}

export async function probeBuildBot3(config, { run = runCommand, now = Date.now(), previous = null } = {}) {
  let result;
  try {
    result = await run(config.bins.ssh, [
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", config.bb3Host, BB3_PROBE_SCRIPT
    ], { timeoutMs: PROBE_TIMEOUT_MS });
  } catch (error) {
    return emptyBb3(now, clampText(`ssh failed: ${error?.message ?? error}`, 200));
  }
  if (result?.timedOut) return emptyBb3(now, "ssh probe timed out");
  const parsed = parseBb3Probe(result?.stdout, now);
  if (!parsed.reachable) return emptyBb3(now, result?.code === 0 ? parsed.error : sshError(result));
  return withGateSince(parsed, previous);
}

function lastWatchLine(config, readFile) {
  try {
    const lines = String(readFile(config.paths.lbWatchLog) ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
    return lines.length ? clampText(redactSecrets(lines.at(-1)), 300) : null;
  } catch {
    return null;
  }
}

function fetchFailure(error, aborted, timeoutMs) {
  if (aborted) return `timed out after ${timeoutMs} ms`;
  const cause = error?.cause?.code ?? error?.cause?.message ?? null;
  return clampText(`unreachable: ${error?.message ?? error}${cause ? ` (${cause})` : ""}`, 200);
}

export async function checkLb(config, {
  fetchImpl = globalThis.fetch, now = Date.now(), readFile = (file) => readTail(file, 16 * 1024), timeoutMs = LB_TIMEOUT_MS
} = {}) {
  const url = `${String(config.lbUrl ?? "").replace(/\/+$/, "")}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timed out")), timeoutMs);
  let healthy;
  let detail;
  try {
    const response = await fetchImpl(url, { method: "GET", signal: controller.signal });
    const version = response.headers?.get?.("x-app-version");
    healthy = Boolean(response.ok);
    detail = response.ok ? `${response.status}${version ? ` v${clampText(version, 20)}` : ""}` : `HTTP ${response.status}`;
    try { await response.text?.(); } catch { /* body is not needed */ }
  } catch (error) {
    healthy = false;
    detail = fetchFailure(error, controller.signal.aborted, timeoutMs);
  } finally {
    clearTimeout(timer);
  }
  return { healthy, detail, watchLine: lastWatchLine(config, readFile), checkedAt: toIso(now) };
}

function firstLine(readFile, file) {
  try {
    const line = String(readFile(file) ?? "").trim().split("\n")[0].trim();
    return line ? clampText(line, 40) : null;
  } catch {
    return null;
  }
}

// ~/.bb3-watch-state is "up"|"down"; ~/.bb3-watch-gate-state is "ok"|"warn"|"blocked".
export function readLocalWatchState(config, { readFile = (file) => fs.readFileSync(file, "utf8") } = {}) {
  return {
    bb3State: firstLine(readFile, config.paths.bb3WatchState),
    gateState: firstLine(readFile, config.paths.bb3WatchGateState)
  };
}
