import test from "node:test";
import assert from "node:assert/strict";
import { resolveFleetConfig } from "../src/fleet/contracts.js";
import {
  BB3_PROBE_SCRIPT, checkLb, ownerFromLog, parseBb3Probe, parseTimersDead, probeBuildBot3, readLocalWatchState
} from "../src/fleet/sources/buildbot3.js";

const NOW = Date.parse("2026-09-26T08:30:00Z");

function config(overrides = {}) {
  return resolveFleetConfig({}, {
    home: "/home/fixture",
    bins: { ssh: "/fake/ssh" },
    paths: { lbWatchLog: "/fake/lb-watch.log", bb3WatchState: "/fake/state", bb3WatchGateState: "/fake/gate" },
    ...overrides
  });
}

// Captured from one real read-only probe of BuildBot3 on 2026-09-26 08:30Z.
// Long wrapper command lines are cut at 200 chars and the gate history is
// trimmed to two entries; everything else is verbatim.
const CAPTURED_PROBE = [
  "@@ps",
  " 168945       1    6476 bash -c ~/bin/bb-verify --full --pr 6874 > ~/monrovia-pr6874-full.log 2>&1; echo $? > ~/monrovia-pr6874-full.exit",
  " 168956  168945    6476 python3 /home/dev/bin/bb-verify --full --pr 6874",
  " 407274       1     739 python3 /home/dev/bin/bb-quick --head 1b9f8efadbd17b0e46b09ee42b68824c5b703b78 --base 9b2531de41f95c7971f3130105f1dedef007d414",
  " 407276       1     739 python3 /home/dev/bin/bb-quick --head e688697a66a3c0e4d05124afb35550337cffcd7b --base 1b9f8efadbd17b0e46b09ee42b68824c5b703b78",
  " 579339  579084    9518 python3 /home/dev/bin/bb-verify --full --pr 6758",
  " 579652       1    6142 python3 /home/dev/bin/bb-verify --full --pr 6848",
  " 581841       1    6140 python3 /home/dev/bin/bb-verify --full --pr 6846",
  " 583707       1    6138 python3 /home/dev/bin/bb-verify --full --pr 6711",
  " 865062  864934    9305 bash -c cd ~/buildbetter && ~/bin/bb-verify --full --pr 6470 > ~/bb-verify-6470-c6cbdba0be.log 2>&1; echo \"exit=$?\"; grep -a -E \"Verification evidence|Testing|merge|cache\" ~/bb",
  " 865070  865062    9305 python3 /home/dev/bin/bb-verify --full --pr 6470",
  " 881817  881604     430 bash -c cd ~/buildbetter && git fetch -q /tmp/convert-wip3.bundle HEAD && timeout 2400 ~/bin/bb-quick --head 80ccb2c425b645dc87aaf6de527335aa19e7aaf0 --base c3fc2f675230dddd4d7",
  " 882221  881817     430 timeout 2400 /home/dev/bin/bb-quick --head 80ccb2c425b645dc87aaf6de527335aa19e7aaf0 --base c3fc2f675230dddd4d70f27867931c9c23a62c3b",
  " 882229  882221     430 python3 /home/dev/bin/bb-quick --head 80ccb2c425b645dc87aaf6de527335aa19e7aaf0 --base c3fc2f675230dddd4d70f27867931c9c23a62c3b",
  "1338953       1    3081 bash -c ~/bin/bb-verify --full --pr 6877 > ~/monrovia-pr6877-full.log 2>&1; echo $? > ~/monrovia-pr6877-full.exit",
  "1338956 1338953    3081 python3 /home/dev/bin/bb-verify --full --pr 6877",
  "1338960       1    3081 bash -c ~/bin/bb-verify --full --pr 6878 > ~/monrovia-pr6878-full.log 2>&1; echo $? > ~/monrovia-pr6878-full.exit",
  "1338965 1338960    3081 python3 /home/dev/bin/bb-verify --full --pr 6878",
  "2370000       1    4716 python3 /home/dev/bin/bb-verify --full --pr 6849",
  "2505676       1    2205 python3 /home/dev/bin/bb-verify --full --pr 6847",
  "2505682       1    2205 python3 /home/dev/bin/bb-verify --full --pr 6844",
  "3008811       1    7636 bash -c cd ~/buildbetter && nohup ~/bin/bb-verify --full --pr 6859 > ~/bbverify-6859.log 2>&1 & echo PID=$!",
  "3008819 3008811    7636 python3 /home/dev/bin/bb-verify --full --pr 6859",
  "3062861 3062672    1921 python3 /home/dev/bin/bb-quick --head 9b1db14ab62794060d29e3cb7d97f018287e08a4 --base f3436593f1 --tests",
  "3743085 3742780    4031 python3 /home/dev/bin/bb-verify --full --pr 5312",
  "@@out",
  "168945 /dev/null",
  "168956 /home/dev/monrovia-pr6874-full.log",
  "407274 /home/dev/bbq-pr6851-r5.log",
  "407276 /home/dev/bbq-pr6862-r2.log",
  "579339 pipe:[17307461]",
  "579652 /home/dev/bb-verify-6848-write.log",
  "581841 /home/dev/bb-verify-6846-write.log",
  "583707 /home/dev/bb-verify-6711-write.log",
  "865062 pipe:[18361647]",
  "865070 /home/dev/bb-verify-6470-c6cbdba0be.log",
  "881817 pipe:[64515756]",
  "882221 /tmp/convert-quick-3.log",
  "882229 /tmp/convert-quick-3.log",
  "1338953 /dev/null",
  "1338956 /home/dev/monrovia-pr6877-full.log",
  "1338960 /dev/null",
  "1338965 /home/dev/monrovia-pr6878-full.log",
  "2370000 /home/dev/logs/bb-verify-6849-rerun.log",
  "2505676 /home/dev/bb-verify-6847-write2.log",
  "2505682 /home/dev/bb-verify-6844-write2.log",
  "3008811 pipe:[26380569]",
  "3008819 /home/dev/bbverify-6859.log",
  "3062861 pipe:[57346656]",
  "3743085 pipe:[44174242]",
  "@@quick",
  "1",
  "@@full",
  "9",
  "@@gate",
  "{",
  "  \"state\": \"blocked\",",
  "  \"blockers\": [",
  "    \"slot held by a run going 81 min, past 45\"",
  "  ],",
  "  \"warnings\": [",
  "    \"6 verifier(s) unbounded; is bb-verify-sweep running?\"",
  "  ],",
  "  \"slots_free\": 0,",
  "  \"slots_total\": 4,",
  "  \"memory_gib\": 169.8,",
  "  \"disk_gib\": 644.9,",
  "  \"hours_to_disk_floor\": null,",
  "  \"unbounded_verifiers\": 6,",
  "  \"checked_at\": 1790411311.8818343,",
  "  \"reclaimed\": [],",
  "  \"history\": [",
  "    {",
  "      \"at\": 1790411014.4988406,",
  "      \"disk_gib\": 652.8827743530273",
  "    },",
  "    {",
  "      \"at\": 1790411311.8540635,",
  "      \"disk_gib\": 644.9116630554199",
  "    }",
  "  ]",
  "}",
  "",
  "@@load",
  "438.51 445.15 435.13 259/18097 1356807",
  "@@timers",
  "NEXT                            LEFT LAST                              PASSED UNIT                     ACTIVATES",
  "Sat 2026-09-26 08:30:21 UTC      32s Sat 2026-09-26 08:29:21 UTC      27s ago bb-verify-sweep.timer    bb-verify-sweep.service",
  "Sat 2026-09-26 08:33:08 UTC 3min 18s Sat 2026-09-26 08:28:08 UTC 1min 41s ago bb-gate-watch.timer      bb-gate-watch.service",
  "Sat 2026-09-26 08:35:11 UTC     5min Sat 2026-09-26 08:20:11 UTC     9min ago bb-preview-cap.timer     bb-preview-cap.service",
  "Sat 2026-09-26 08:42:12 UTC    12min Sat 2026-09-26 07:42:12 UTC    47min ago bb-instance-verify.timer bb-instance-verify.service",
  "-                                  - Sat 2026-09-26 01:02:42 UTC            - bb-ci-warm.timer         bb-ci-warm.service",
  "-                                  - Sat 2026-09-26 01:20:09 UTC            - lb-guard.timer           lb-guard.service",
  "-                                  - Sat 2026-09-26 01:20:09 UTC            - lb-health.timer          lb-health.service",
  "",
  "7 timers listed.",
  "@@end",
  ""
].join("\n");

function sections(overrides) {
  const base = {
    ps: [], out: [], quick: ["0"], full: ["0"],
    gate: ['{"state":"ok","blockers":[],"warnings":[],"slots_free":4,"slots_total":4}'],
    load: ["1.00 2.00 3.00 1/100 42"],
    timers: [
      "NEXT                            LEFT LAST                              PASSED UNIT                     ACTIVATES",
      "Sat 2026-09-26 08:40:00 UTC     10min Sat 2026-09-26 08:30:00 UTC     1s ago lb-health.timer          lb-health.service",
      "Sat 2026-09-26 08:40:00 UTC     10min Sat 2026-09-26 08:30:00 UTC     1s ago lb-guard.timer           lb-guard.service",
      "Sat 2026-09-26 08:40:00 UTC     10min Sat 2026-09-26 08:30:00 UTC     1s ago bb-ci-warm.timer         bb-ci-warm.service",
      "",
      "3 timers listed."
    ],
    ...overrides
  };
  return [...Object.entries(base).flatMap(([name, lines]) => [`@@${name}`, ...lines]), "@@end"].join("\n");
}

test("parseBb3Probe reads the captured BuildBot3 probe", () => {
  const bb3 = parseBb3Probe(CAPTURED_PROBE, NOW);
  assert.equal(bb3.reachable, true);
  assert.equal(bb3.checkedAt, "2026-09-26T08:30:00.000Z");
  assert.equal(bb3.error, null);
  assert.deepEqual(bb3.gate, { state: "blocked", reason: "slot held by a run going 81 min, past 45", since: null });
  assert.equal(bb3.fullQueue, 9);
  assert.equal(bb3.quickQueue, 1);
  assert.deepEqual(bb3.load, [438.51, 445.15, 435.13]);
  assert.deepEqual(bb3.timersDead, ["lb-health", "lb-guard", "bb-ci-warm"]);

  // Wrapper shells and timeout(1) collapse into the python process they run.
  assert.equal(bb3.runs.length, 17);
  assert.equal(bb3.runs.filter((run) => run.kind === "full").length, 13);
  assert.equal(bb3.runs.filter((run) => run.kind === "quick").length, 4);
  assert.deepEqual(bb3.runs[0], { pid: 579339, kind: "full", pr: 6758, head: null, ageSec: 9518, owner: null });
  const byPid = new Map(bb3.runs.map((run) => [run.pid, run]));
  assert.deepEqual(byPid.get(168956), { pid: 168956, kind: "full", pr: 6874, head: null, ageSec: 6476, owner: "monrovia" });
  assert.deepEqual(byPid.get(1338965), { pid: 1338965, kind: "full", pr: 6878, head: null, ageSec: 3081, owner: "monrovia" });
  assert.deepEqual(byPid.get(407274), {
    pid: 407274, kind: "quick", pr: 6851, head: "1b9f8efadbd17b0e46b09ee42b68824c5b703b78", ageSec: 739, owner: null
  });
  assert.equal(byPid.get(882229).kind, "quick");
  assert.equal(byPid.get(882229).head, "80ccb2c425b645dc87aaf6de527335aa19e7aaf0");
  assert.equal(byPid.get(865070).pr, 6470);
  assert.equal(byPid.get(865070).owner, null);
  assert.equal(byPid.has(865062), false);
  assert.equal(byPid.has(882221), false);
  const ages = bb3.runs.map((run) => run.ageSec);
  assert.deepEqual(ages, [...ages].sort((a, b) => b - a));
});

test("ownerFromLog keeps the workspace name and drops PR, lane, and retry noise", () => {
  assert.equal(ownerFromLog("/home/dev/monrovia-pr6874-full.log"), "monrovia");
  assert.equal(ownerFromLog("~/bb-verify-6873-sydney.log"), "sydney");
  assert.equal(ownerFromLog("/home/dev/la-paz-pr6847-full.log"), "la-paz");
  assert.equal(ownerFromLog("/home/dev/bbverify-6859.log"), null);
  assert.equal(ownerFromLog("/home/dev/bbq-pr6851-r5.log"), null);
  assert.equal(ownerFromLog("/home/dev/bb-verify-6470-c6cbdba0be.log"), null);
  assert.equal(ownerFromLog("/home/dev/bb-verify-6847-write2.log"), null);
  assert.equal(ownerFromLog("pipe:[17307461]"), null);
  assert.equal(ownerFromLog("/dev/null"), null);
  assert.equal(ownerFromLog(null), null);
});

test("parseBb3Probe falls back to the wrapper redirect for owner and PR", () => {
  const text = sections({
    ps: [
      "   100     1   2000 bash -c cd ~/buildbetter && timeout 3000 ~/bin/bb-quick --pr 6801 > ~/cairo-pr6801-quick.log 2>&1",
      "   101   100   1990 timeout 3000 /home/dev/bin/bb-quick --pr 6801",
      "   102   101   1990 python3 /home/dev/bin/bb-quick --pr 6801",
      "   200     1    100 python3 /home/dev/bin/bb-verify --pr 6802",
      "   300     1     50 python3 /home/dev/bin/bb-verify-sweep --apply"
    ],
    out: ["100 pipe:[1]", "101 pipe:[1]", "102 pipe:[1]", "200 /home/dev/bb-verify-6802-sydney.log"]
  });
  const bb3 = parseBb3Probe(text, NOW);
  assert.deepEqual(bb3.runs, [
    { pid: 102, kind: "quick", pr: 6801, head: null, ageSec: 1990, owner: "cairo" },
    // bb-verify without --full execs bb-quick.
    { pid: 200, kind: "quick", pr: 6802, head: null, ageSec: 100, owner: "sydney" }
  ]);
  assert.deepEqual(bb3.gate, { state: "ok", reason: null, since: null });
  assert.deepEqual(bb3.timersDead, []);
  assert.deepEqual(bb3.load, [1, 2, 3]);
});

test("parseTimersDead flags missing timers and dash or n/a NEXT columns", () => {
  const listing = [
    "NEXT                            LEFT LAST                              PASSED UNIT                     ACTIVATES",
    "Sat 2026-09-26 08:40:00 UTC     10min Sat 2026-09-26 08:30:00 UTC     1s ago lb-health.timer          lb-health.service",
    "n/a                              n/a n/a                                  n/a bb-ci-warm.timer         bb-ci-warm.service",
    "",
    "2 timers listed."
  ].join("\n");
  assert.deepEqual(parseTimersDead(listing), ["lb-guard", "bb-ci-warm"]);
  // A failed systemctl says nothing about the timers.
  assert.deepEqual(parseTimersDead("Failed to connect to bus: No medium found"), []);
  assert.deepEqual(parseTimersDead(""), []);
});

test("parseBb3Probe degrades on garbage and bad gate JSON", () => {
  const garbage = parseBb3Probe("Connection closed by remote host", NOW);
  assert.equal(garbage.reachable, false);
  assert.match(garbage.error, /markers/);
  assert.deepEqual(garbage.gate, { state: null, reason: null, since: null });
  assert.equal(garbage.fullQueue, null);
  assert.equal(garbage.quickQueue, null);
  assert.equal(garbage.load, null);
  assert.deepEqual(garbage.runs, []);
  assert.deepEqual(garbage.timersDead, []);

  const badGate = parseBb3Probe(sections({ gate: ["{not json"], quick: ["x"], load: [""] }), NOW);
  assert.equal(badGate.reachable, true);
  assert.deepEqual(badGate.gate, { state: null, reason: null, since: null });
  assert.equal(badGate.quickQueue, null);
  assert.equal(badGate.load, null);
  assert.equal(parseBb3Probe(undefined, NOW).reachable, false);
});

test("gate reason prefers blockers, then warnings", () => {
  const warn = parseBb3Probe(sections({ gate: ['{"state":"warn","blockers":[],"warnings":["all 4 slots busy"]}'] }), NOW);
  assert.deepEqual(warn.gate, { state: "warn", reason: "all 4 slots busy", since: null });
});

test("the probe script is read-only and never touches docker", () => {
  assert.doesNotMatch(BB3_PROBE_SCRIPT, /docker/i);
  assert.doesNotMatch(BB3_PROBE_SCRIPT, /\b(rm|kill|pkill|systemctl\s+--user\s+(start|stop|restart|enable))\b/);
  for (const marker of ["@@ps", "@@out", "@@quick", "@@full", "@@gate", "@@load", "@@timers", "@@end"]) {
    assert.ok(BB3_PROBE_SCRIPT.includes(`echo "${marker}"`), marker);
  }
});

test("probeBuildBot3 runs one batch-mode ssh and parses it", async () => {
  const calls = [];
  const run = async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { code: 0, stdout: CAPTURED_PROBE, stderr: "", timedOut: false, error: null };
  };
  const bb3 = await probeBuildBot3(config(), { run, now: NOW });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "/fake/ssh");
  assert.deepEqual(calls[0].args, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "dev@100.99.3.113", BB3_PROBE_SCRIPT]);
  assert.equal(calls[0].options.timeoutMs, 40000);
  assert.equal(bb3.reachable, true);
  assert.equal(bb3.gate.state, "blocked");
  assert.equal(bb3.runs.length, 17);
});

test("probeBuildBot3 reports unreachable hosts without throwing", async () => {
  const refused = await probeBuildBot3(config(), {
    now: NOW,
    run: async () => ({ code: 255, stdout: "", stderr: "ssh: connect to host 100.99.3.113 port 22: Operation timed out\n", timedOut: false, error: null })
  });
  assert.equal(refused.reachable, false);
  assert.match(refused.error, /Operation timed out/);
  assert.equal(refused.checkedAt, "2026-09-26T08:30:00.000Z");
  assert.deepEqual(refused.runs, []);

  const hung = await probeBuildBot3(config(), { now: NOW, run: async () => ({ code: null, stdout: "", stderr: "", timedOut: true, error: null }) });
  assert.equal(hung.reachable, false);
  assert.match(hung.error, /timed out/);

  const thrown = await probeBuildBot3(config(), { now: NOW, run: async () => { throw new Error("spawn ENOENT"); } });
  assert.equal(thrown.reachable, false);
  assert.match(thrown.error, /ENOENT/);
});

test("probeBuildBot3 carries the gate since time while the state holds", async () => {
  const run = async () => ({ code: 0, stdout: CAPTURED_PROBE, stderr: "", timedOut: false, error: null });
  const first = await probeBuildBot3(config(), { run, now: NOW });
  assert.equal(first.gate.since, null);
  const second = await probeBuildBot3(config(), { run, now: NOW + 300_000, previous: first });
  assert.equal(second.gate.since, "2026-09-26T08:30:00.000Z");
  const third = await probeBuildBot3(config(), { run, now: NOW + 600_000, previous: second });
  assert.equal(third.gate.since, "2026-09-26T08:30:00.000Z");

  const okRun = async () => ({ code: 0, stdout: sections({}), stderr: "", timedOut: false, error: null });
  const changed = await probeBuildBot3(config(), { run: okRun, now: NOW + 900_000, previous: third });
  assert.equal(changed.gate.state, "ok");
  assert.equal(changed.gate.since, "2026-09-26T08:45:00.000Z");
});

function fakeResponse(status, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), text: async () => "" };
}

test("checkLb reports health from /health and the last lb-watch line", async () => {
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push(url);
    assert.ok(init.signal);
    return fakeResponse(200, { "x-app-version": "1.24.0" });
  };
  const readFile = (file) => {
    assert.equal(file, "/fake/lb-watch.log");
    return "2026-09-26T07:35:53Z healthy=no old\n2026-09-26T08:05:54Z healthy=no 93 req since start, v1.24.0, problems: report is 406 min old; lb-health timer dead?\n";
  };
  const lb = await checkLb(config({ lbUrl: "http://100.99.3.113:2455/" }), { fetchImpl, readFile, now: NOW });
  assert.deepEqual(urls, ["http://100.99.3.113:2455/health"]);
  assert.equal(lb.healthy, true);
  assert.equal(lb.detail, "200 v1.24.0");
  assert.equal(lb.watchLine, "2026-09-26T08:05:54Z healthy=no 93 req since start, v1.24.0, problems: report is 406 min old; lb-health timer dead?");
});

test("checkLb marks errors, bad statuses, and timeouts unhealthy", async () => {
  const readFile = () => { throw new Error("ENOENT"); };
  const bad = await checkLb(config(), { fetchImpl: async () => fakeResponse(503), readFile, now: NOW });
  assert.equal(bad.healthy, false);
  assert.equal(bad.detail, "HTTP 503");
  assert.equal(bad.watchLine, null);

  const down = await checkLb(config(), { fetchImpl: async () => { throw new TypeError("fetch failed"); }, readFile, now: NOW });
  assert.equal(down.healthy, false);
  assert.match(down.detail, /unreachable: fetch failed/);

  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")));
  });
  const slow = await checkLb(config(), { fetchImpl: hang, readFile: () => "", now: NOW, timeoutMs: 20 });
  assert.equal(slow.healthy, false);
  assert.match(slow.detail, /timed out/);
  assert.equal(slow.watchLine, null);
});

test("readLocalWatchState reads the Mac watch files", () => {
  const files = { "/fake/state": "up\n", "/fake/gate": "blocked\n" };
  const readFile = (file) => {
    if (!(file in files)) throw new Error("ENOENT");
    return files[file];
  };
  assert.deepEqual(readLocalWatchState(config(), { readFile }), { bb3State: "up", gateState: "blocked" });
  delete files["/fake/gate"];
  files["/fake/state"] = "  \n";
  assert.deepEqual(readLocalWatchState(config(), { readFile }), { bb3State: null, gateState: null });
});
