import test from "node:test";
import assert from "node:assert/strict";
import { resolveFleetConfig } from "../src/fleet/contracts.js";
import { findLocalHeavyVerification, matchThreadByCwd, parseEtime } from "../src/fleet/sources/processes.js";

const config = resolveFleetConfig({}, { home: "/home/fixture", bins: { ps: "/fake/ps", lsof: "/fake/lsof" } });

test("parseEtime reads [[dd-]hh:]mm:ss", () => {
  assert.equal(parseEtime("00:44"), 44);
  assert.equal(parseEtime("05:03"), 303);
  assert.equal(parseEtime("02:39:24"), 2 * 3600 + 39 * 60 + 24);
  assert.equal(parseEtime("3-01:00:05"), 3 * 86400 + 3600 + 5);
  assert.equal(parseEtime("  12:00 "), 720);
  assert.equal(parseEtime("garbage"), 0);
  assert.equal(parseEtime(""), 0);
  assert.equal(parseEtime(undefined), 0);
});

// Columns: pid ppid etime command, matching `ps -axo pid=,ppid=,etime=,command=`.
const PS = [
  "    1     0 12-00:00:00 /sbin/launchd",
  "  100     1    10:00 /bin/zsh -c -l setopt NO_EXTENDED_GLOB && eval 'pnpm verify:pr --base abc --head HEAD'",
  "  101   100    09:59 node /Users/me/.local/share/pnpm/pnpm.cjs verify:pr --base abc --head HEAD",
  "  102   101    09:58 node packages/devops/verification/launch.mjs",
  "  200     1    05:00 pnpm exec nx run-many --target=test --all",
  "  300     1    03:00 pnpm run build",
  "  301     1    03:00 pnpm build:docs",
  "  400     1    02:00 docker compose up -d postgres",
  "  401     1    02:00 docker-compose up",
  "  402     1    02:00 pnpm local-stack:up",
  "  500     1    01:30 python3 /Users/me/bin/bb-verify --full --pr 6874",
  "  600     1 02:39:24 timeout 10800 ssh -o BatchMode=yes dev@100.99.3.113 cd ~/buildbetter && ~/bin/bb-verify --full --pr 6758",
  "  601     1 01:00:00 /bin/zsh -c ssh dev@100.99.3.113 'cd ~/buildbetter && pnpm verify:pr'",
  "  602     1    40:00 bb-remote sh pnpm exec nx run-many --target=build",
  "  603     1    40:00 python3 /Users/me/.local/bin/bb-ci-remote.py run verify:pr",
  "  700     1    01:00 grep -E verify:pr|nx run-many",
  "  701     1    30:00 /Users/me/.local/bin/claude -p --resume abc Don't run verify:pr locally",
  "  702     1    30:00 /Users/me/.ccodex/bin/codex exec resume abc --skip-git-repo-check Use bb-quick, not nx run-many",
  "  703     1    30:00 /bin/zsh -c claude -p 'stop running verify:pr'",
  "  800     1    00:10 pnpm verify:pr --help",
  "  900     1    50:00 /usr/bin/vim notes.md"
].join("\n");

function fakeRun({ psOut = PS, lsofOut, psCode = 0 } = {}) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "/fake/ps") return { code: psCode, stdout: psOut, stderr: "", timedOut: false, error: null };
    if (cmd === "/fake/lsof") {
      const pids = args[args.indexOf("-p") + 1].split(",");
      const out = lsofOut ?? pids.map((pid) => `p${pid}\nfcwd\nn/work/ws-${pid}`).join("\n");
      return { code: 1, stdout: `${out}\n`, stderr: "", timedOut: false, error: null };
    }
    return { code: 127, stdout: "", stderr: "", timedOut: false, error: "unexpected" };
  };
  return { run, calls };
}

test("findLocalHeavyVerification flags heavy local commands and skips remote or agent lines", async () => {
  const { run, calls } = fakeRun();
  const found = await findLocalHeavyVerification(config, { run });
  const pids = found.map((row) => row.pid).sort((a, b) => a - b);
  assert.deepEqual(pids, [100, 200, 300, 400, 401, 402, 500], "one row per process tree, closest to the agent");

  const verify = found.find((row) => row.pid === 100);
  assert.equal(verify.ageSec, 600);
  assert.equal(verify.cwd, "/work/ws-100");
  assert.match(verify.command, /pnpm verify:pr --base abc/, "command shows the matched part of a long shell wrapper");

  assert.equal(calls[0][0], "/fake/ps");
  assert.deepEqual(calls[0][1], ["-axo", "pid=,ppid=,etime=,command="]);
  const lsofCalls = calls.filter(([cmd]) => cmd === "/fake/lsof");
  assert.equal(lsofCalls.length, 1, "one batched lsof call");
  assert.deepEqual(lsofCalls[0][1].slice(0, 4), ["-a", "-d", "cwd", "-Fn"]);
});

test("findLocalHeavyVerification honours minAgeSec and scrubs secrets", async () => {
  const psOut = [
    "  10     1    00:10 pnpm verify:pr --base a",
    "  11     1    05:00 GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 pnpm verify:pr --base a"
  ].join("\n");
  const { run } = fakeRun({ psOut });
  const found = await findLocalHeavyVerification(config, { run, minAgeSec: 60 });
  assert.deepEqual(found.map((row) => row.pid), [11]);
  assert.doesNotMatch(found[0].command, /ghp_abcdefghijklmnop/);
  const all = await findLocalHeavyVerification(config, { run, minAgeSec: 0 });
  assert.deepEqual(all.map((row) => row.pid).sort(), [10, 11]);
});

test("findLocalHeavyVerification degrades when ps or lsof fail", async () => {
  const failing = async () => ({ code: null, stdout: "", stderr: "", timedOut: false, error: "spawn ENOENT" });
  assert.deepEqual(await findLocalHeavyVerification(config, { run: failing }), []);
  const throwing = async () => { throw new Error("boom"); };
  assert.deepEqual(await findLocalHeavyVerification(config, { run: throwing }), []);

  const { run } = fakeRun({ psOut: "  20     1    05:00 pnpm run build", lsofOut: "" });
  const [row] = await findLocalHeavyVerification(config, { run });
  assert.equal(row.pid, 20);
  assert.equal(row.cwd, null);
});

test("matchThreadByCwd picks the longest path-prefix match", () => {
  const threads = [
    { key: "codex:a", cwd: "/work/bbapp", excluded: null },
    { key: "claude:b", cwd: "/work/bbapp/packages/web", excluded: null },
    { key: "codex:c", cwd: "/work/bb", excluded: null },
    { key: "codex:d", cwd: null, excluded: null }
  ];
  assert.equal(matchThreadByCwd("/work/bbapp/packages/web/src", threads), "claude:b");
  assert.equal(matchThreadByCwd("/work/bbapp/scripts", threads), "codex:a");
  assert.equal(matchThreadByCwd("/work/bbapp", threads), "codex:a");
  assert.equal(matchThreadByCwd("/work/bbapp2", threads), null, "prefix must end on a path boundary");
  assert.equal(matchThreadByCwd(null, threads), null);
  assert.equal(matchThreadByCwd("/elsewhere", threads), null);
  assert.equal(matchThreadByCwd("/work/bbapp/", threads), "codex:a");
});

test("matchThreadByCwd prefers in-scope and recent threads on a tie", () => {
  const threads = [
    { key: "codex:old", cwd: "/work/ws", excluded: null, lastActivityAt: "2026-09-26T01:00:00.000Z" },
    { key: "codex:excluded", cwd: "/work/ws", excluded: "archived", lastActivityAt: "2026-09-26T07:00:00.000Z" },
    { key: "claude:new", cwd: "/work/ws", excluded: null, lastActivityAt: "2026-09-26T06:00:00.000Z" }
  ];
  assert.equal(matchThreadByCwd("/work/ws", threads), "claude:new");
});
