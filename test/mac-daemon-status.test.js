import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The menubar app is a SwiftPM executable target with no test target, so the
// only mechanism available for pinning its behaviour from CI is the same one
// test/privacy-copy.test.js uses: assert against the Swift source. Each
// assertion below encodes a defect that actually shipped and bit the user, so
// a future edit that reintroduces it fails here instead of on their machine.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRAY = "mac/Sources/OpenAGI/TrayController.swift";
const APPSTATE = "mac/Sources/OpenAGI/AppState.swift";
const DAEMON = "mac/Sources/OpenAGI/DaemonController.swift";

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

// Strip `//` comments so assertions test the code, not prose about the code.
// (The comments deliberately quote the old broken label to explain the fix.)
function code(rel) {
  return read(rel)
    .split("\n")
    .map((l) => l.replace(/^\s*\/\/.*$/, ""))
    .join("\n");
}

test("tray restart action never labels itself with recovery jargon", () => {
  // Shipped label: `Button(state.status == .down ? "↻ Restart daemon" : "↻ Restart daemon (recover)")`.
  // "(recover)" names an implementation detail — that bouncing a daemon which
  // still answers is how you clear a wedged one — and reads to a user as a
  // warning that something is broken. It was on screen nearly permanently:
  // computeStatus() returns .degraded once spend passes 70% of the daily cap,
  // which for this user is most of every afternoon with a totally healthy
  // daemon. A budget number rendered as a permanent "recover" button.
  const body = code(TRAY);
  for (const m of body.matchAll(/"[^"\n]*[Rr]estart[^"\n]*"/g)) {
    assert.doesNotMatch(
      m[0],
      /recover/i,
      `${TRAY} restart label ${m[0]} still uses "recover" — the daemon is answering ` +
        `/health in that branch, so restarting it is ordinary maintenance, not a rescue.`
    );
  }
});

test("tray tells a wedged daemon apart from a missing one, in both label and status", () => {
  // The user's daemon sat in process state T (stopped by a job-control signal)
  // holding its LISTEN socket on 43210 for 25 hours: process alive, port bound,
  // /health never answering. status == .down covered both that and "the process
  // is gone", but they need different words and different actions — one is a
  // plain start, the other needs the port holder force-quit first.
  const tray = code(TRAY);
  assert.match(
    tray,
    /notResponding/,
    `${TRAY} must render the wedged case (alive, holding the port, not answering) ` +
      `distinctly from a daemon that simply is not running.`
  );
  assert.match(
    tray,
    /notRunning/,
    `${TRAY} must say "start" rather than "restart" when nothing is listening on the port.`
  );
  // "offline" is a lie for a process that is running and holding the port.
  const offlineLine = tray
    .split("\n")
    .find((l) => /daemon offline/.test(l));
  assert.ok(offlineLine, `${TRAY} lost the offline status string entirely`);
  assert.match(
    offlineLine,
    /notResponding|reachability/,
    `${TRAY} still calls every .down state "daemon offline" — a wedged daemon is ` +
      `running, so that word is false exactly when the user most needs the truth.`
  );
});

test("AppState publishes why the daemon is unreachable", () => {
  const body = code(APPSTATE);
  assert.match(
    body,
    /enum DaemonReachability\s*\{[^}]*serving[^}]*notRunning[^}]*notResponding[^}]*\}/,
    `${APPSTATE} must model the three reachability states; status == .down alone ` +
      `cannot distinguish a dead process from a wedged one.`
  );
  assert.match(
    body,
    /@Published var reachability/,
    `${APPSTATE}.reachability must be @Published or the tray will not re-render when it changes.`
  );
  assert.match(
    body,
    /reachability = await DaemonController\.shared\.isPortHeld\(\)/,
    `${APPSTATE} must actually probe the port in the /health failure path — otherwise ` +
      `reachability is a field nothing ever sets.`
  );
  assert.match(
    code(DAEMON),
    /func isPortHeld\(\) async -> Bool/,
    `${DAEMON} must expose the LISTEN-socket probe AppState needs; pidListeningOnPort ` +
      `is a blocking process spawn and pollOnce() is @MainActor.`
  );
});

test("auto-restart can retry for the whole outage instead of firing at most once", () => {
  // Shipped gate: `if consecutiveFailures == 3, Date().timeIntervalSince(lastAutoRestartAt) > 60`.
  // consecutiveFailures only resets on a SUCCESSFUL /health, so during an outage
  // it climbs 1,2,3,4,… monotonically and `== 3` can match at most once. If that
  // one instant landed inside the 60s throttle window the recovery path never
  // ran again, no matter how long the daemon stayed down — while its own comment
  // claimed "one auto-restart per minute".
  const lines = code(APPSTATE).split("\n");
  const idx = lines.findIndex((l) => /DaemonController\.shared\.restart\(/.test(l));
  assert.ok(idx > 0, `${APPSTATE} no longer auto-restarts the daemon at all`);
  const guard = lines.slice(Math.max(0, idx - 10), idx).join("\n");
  assert.match(
    guard,
    /consecutiveFailures >= 3/,
    `${APPSTATE} auto-restart guard must use >= so the 60s throttle means "at most ` +
      `once a minute while down", not "at most once ever":\n${guard}`
  );
  assert.doesNotMatch(
    guard,
    /consecutiveFailures == 3/,
    `${APPSTATE} auto-restart guard is an edge trigger again — it can only ever fire ` +
      `on the single poll where the counter equals 3:\n${guard}`
  );
});

test("auto-restart cannot stomp a restart the user just asked for", () => {
  // With the >= fix the auto path retries every minute, so it has to share a
  // clock with the manual one. Otherwise a user pressing "Restart daemon" gets
  // their booting daemon SIGKILLed ~15s in by the poller, forever.
  const appstate = code(APPSTATE);
  const daemon = code(DAEMON);
  assert.match(
    daemon,
    /private\(set\) var lastRestartAt/,
    `${DAEMON} must stamp every restart() — manual and automatic — on one shared clock.`
  );
  assert.match(
    daemon,
    /func restart\(force: Bool = false\) \{\s*\n\s*lastRestartAt = Date\(\)/,
    `${DAEMON}.restart() must record the stamp itself, so a tray-initiated restart counts.`
  );
  assert.match(
    appstate,
    /timeIntervalSince\(DaemonController\.shared\.lastRestartAt\)/,
    `${APPSTATE} auto-restart throttle must read DaemonController's shared stamp; a ` +
      `throttle private to AppState never sees the user's manual restart and races it.`
  );
  assert.doesNotMatch(
    appstate,
    /lastAutoRestartAt/,
    `${APPSTATE} still keeps a private auto-restart-only clock — that is the throttle ` +
      `a manual restart is invisible to.`
  );
});

test("Restart daemon replaces an adopted daemon instead of silently doing nothing", () => {
  // start() adopts an already-healthy daemon on 43210 and returns WITHOUT ever
  // setting `process`. That is not an edge case — it is what happens every time
  // the app is relaunched while a previous daemon is still alive, and the user's
  // daemon is in exactly that state right now (reparented to PPID 1, no app
  // running). With `process` nil, stop() short-circuits on its `guard let proc`,
  // so restart() is a no-op stop followed by a start() that adopts the very same
  // daemon again — the menu item does nothing whatsoever. Relabelling a button
  // that does nothing only makes the lie easier to read.
  //
  // Forcing is opt-in per call site, not the default, on purpose: AppDelegate
  // restarts on wake-from-sleep off a single 2s probe, and a daemon that is
  // merely slow to answer right after wake should be adopted once it comes back,
  // not killed and respawned.
  const daemon = code(DAEMON);
  assert.match(
    daemon,
    /func restart\(force: Bool = false\)/,
    `${DAEMON}.restart() needs a force flag; without one "Restart daemon" cannot ` +
      `replace a daemon the app adopted rather than spawned.`
  );
  assert.match(
    daemon,
    /start\(adoptExisting: !force\)/,
    `${DAEMON}.restart(force:) must suppress the adopt branch on the way back up, ` +
      `or start() re-adopts the daemon it was asked to replace.`
  );
  assert.match(
    daemon,
    /if adoptExisting, isExistingDaemonHealthy\(\)/,
    `${DAEMON}.start() must honour adoptExisting — that early return is the no-op.`
  );
  for (const [rel, why] of [
    [TRAY, "the tray button says it will restart the daemon"],
    [APPSTATE, "auto-recovery has 3 failed health polls of evidence, not a single probe"]
  ]) {
    assert.match(
      code(rel),
      /DaemonController\.shared\.restart\(force: true\)/,
      `${rel} must force the restart — ${why}.`
    );
  }
});

test("the /health poll times out well inside the poll interval", () => {
  // A wedged-but-listening daemon still completes the TCP handshake out of the
  // kernel accept queue and then never answers. With URLSession's 60s default
  // the tray kept showing the last good status ("● online") for a full minute
  // after the daemon stopped serving anything, and the 5s timer stacked another
  // dozen doomed requests behind it. A wedged daemon reported as healthy is the
  // worst state this surface can be in.
  const body = code(APPSTATE);
  const interval = body.match(/withTimeInterval:\s*([\d.]+),\s*repeats:\s*true/);
  assert.ok(interval, `${APPSTATE} poll timer interval not found`);
  const health = body.match(/get\("\/health",\s*timeout:\s*([\d.]+)\)/);
  assert.ok(
    health,
    `${APPSTATE} must pass an explicit timeout to the /health fetch — URLSession's ` +
      `default is 60s, so a wedged daemon reads as healthy for a full minute.`
  );
  assert.ok(
    Number(health[1]) < Number(interval[1]),
    `${APPSTATE} /health timeout (${health[1]}s) must be under the poll interval ` +
      `(${interval[1]}s) so a wedge surfaces on the next tick instead of stacking requests.`
  );
});
