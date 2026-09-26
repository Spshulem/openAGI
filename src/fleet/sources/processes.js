// Detects heavy verification running on the laptop (full builds, local
// verify:pr, docker stacks). Policy says those belong on BuildBot3. Read-only:
// one `ps` snapshot plus one batched `lsof` for working directories. Never
// kills or signals anything.

import path from "node:path";
import { clampText, redactSecrets, runCommand } from "../contracts.js";

const HEAVY_PATTERNS = [
  /\bverify:pr\b/,
  /packages\/devops\/verification\/(?:launch|execute|pr-verification)\.mjs/,
  /\bnx\s+run-many\b/,
  /\bpnpm\s+(?:run\s+)?build(?=\s|$|["'])/,
  /\bdocker\s+compose\s+up\b/,
  /\bdocker-compose\s+up\b/,
  /\blocal-stack:up\b/,
  /\bbb-verify\b/
];

// Work shipped to BuildBot3 is fine.
const REMOTE_PATTERN = /\bbb-remote\b|\bbb-ci-remote\b/;

// Agent CLIs and text tools carry these words in prompts or search patterns
// without running anything heavy.
const IGNORED_BINARIES = new Set([
  "grep", "egrep", "rg", "ps", "pgrep", "lsof", "ssh", "claude", "codex", "gh", "git",
  "tail", "head", "less", "cat", "sed", "awk", "vim", "nvim"
]);
const AGENT_CLI_PATTERN = /\b(?:claude|codex)\s+(?:-p\b|exec\b|--resume\b|resume\b)/;

const DEFAULT_MIN_AGE_SEC = 60;
const COMMAND_MAX = 240;

// ps etime is "[[dd-]hh:]mm:ss". Unparseable input is 0 seconds.
export function parseEtime(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(text ?? "").trim());
  if (!match) return 0;
  const [, days, hours, minutes, seconds] = match;
  return Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
}

function parsePsLine(line) {
  const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
  if (!match) return null;
  return { pid: Number(match[1]), ppid: Number(match[2]), ageSec: parseEtime(match[3]), command: match[4] };
}

function heavyMatchIndex(command) {
  if (command.includes("ssh ") || REMOTE_PATTERN.test(command) || AGENT_CLI_PATTERN.test(command)) return -1;
  const binary = path.basename(command.split(/\s+/)[0] ?? "").toLowerCase();
  if (IGNORED_BINARIES.has(binary)) return -1;
  for (const pattern of HEAVY_PATTERNS) {
    const match = pattern.exec(command);
    if (match) return match.index;
  }
  return -1;
}

// Shell wrappers put the real command at the end of a long line, so show
// the text around the match instead of the head of the line.
function commandSnippet(command, index) {
  const start = index > 60 ? index - 40 : 0;
  const snippet = `${start > 0 ? "…" : ""}${command.slice(start)}`;
  return clampText(redactSecrets(snippet), COMMAND_MAX);
}

// One row per process tree: a match whose ancestor also matched is part of
// the same run, and the ancestor is the one the agent launched.
function rootMatches(matches, byPid) {
  const matched = new Set(matches.map((row) => row.pid));
  return matches.filter((row) => {
    const seen = new Set();
    let parent = byPid.get(row.ppid);
    while (parent && !seen.has(parent.pid)) {
      if (matched.has(parent.pid)) return false;
      seen.add(parent.pid);
      parent = byPid.get(parent.ppid);
    }
    return true;
  });
}

function parseLsofCwds(text) {
  const cwds = new Map();
  let pid = null;
  for (const line of String(text ?? "").split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && Number.isFinite(pid)) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

async function readCwds(config, pids, run) {
  if (pids.length === 0) return new Map();
  try {
    const result = await run(config.bins.lsof, ["-a", "-d", "cwd", "-Fn", "-p", pids.join(",")], { timeoutMs: 10_000 });
    return parseLsofCwds(result?.stdout);
  } catch {
    return new Map();
  }
}

export async function findLocalHeavyVerification(config, options = {}) {
  const run = options.run ?? runCommand;
  const minAgeSec = options.minAgeSec ?? DEFAULT_MIN_AGE_SEC;
  try {
    const result = await run(config.bins.ps, ["-axo", "pid=,ppid=,etime=,command="], { timeoutMs: 10_000 });
    if (!result || result.error || result.code !== 0) return [];
    const rows = String(result.stdout ?? "").split("\n").map(parsePsLine).filter(Boolean);
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    const matches = [];
    for (const row of rows) {
      if (row.pid === process.pid) continue;
      const index = heavyMatchIndex(row.command);
      if (index >= 0) matches.push({ ...row, index });
    }
    const roots = rootMatches(matches, byPid).filter((row) => row.ageSec >= minAgeSec);
    const cwds = await readCwds(config, roots.map((row) => row.pid), run);
    return roots.map((row) => ({
      pid: row.pid,
      command: commandSnippet(row.command, row.index),
      cwd: cwds.get(row.pid) ?? null,
      ageSec: row.ageSec
    }));
  } catch {
    return [];
  }
}

function isUnder(cwd, root) {
  return cwd === root || cwd.startsWith(`${root}/`);
}

// Longest thread.cwd that contains cwd on a path boundary. Ties prefer
// in-scope threads, then the most recently active one.
export function matchThreadByCwd(cwd, threads) {
  if (!cwd || !Array.isArray(threads)) return null;
  const target = cwd.length > 1 ? cwd.replace(/\/+$/, "") : cwd;
  let best = null;
  for (const thread of threads) {
    const root = thread?.cwd ? thread.cwd.replace(/\/+$/, "") : "";
    if (!root || !isUnder(target, root)) continue;
    if (!best || isBetterMatch(thread, root, best)) best = { thread, root };
  }
  return best ? best.thread.key : null;
}

function isBetterMatch(thread, root, best) {
  if (root.length !== best.root.length) return root.length > best.root.length;
  const inScope = !thread.excluded;
  const bestInScope = !best.thread.excluded;
  if (inScope !== bestInScope) return inScope;
  return String(thread.lastActivityAt ?? "") > String(best.thread.lastActivityAt ?? "");
}
