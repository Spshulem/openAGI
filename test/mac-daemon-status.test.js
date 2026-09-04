import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The menubar app is a SwiftPM executable target with no test target, so the
// only mechanism available for pinning its behaviour from CI is the same one
// test/privacy-copy.test.js uses: assert against the Swift source. Each
// assertion below encodes a defect that shipped, so a future edit that
// reintroduces it fails here instead of in a user's installation.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRAY = "mac/Sources/OpenAGI/TrayController.swift";
const APPSTATE = "mac/Sources/OpenAGI/AppState.swift";
const DAEMON = "mac/Sources/OpenAGI/DaemonController.swift";
const APPDELEGATE = "mac/Sources/OpenAGI/AppDelegate.swift";

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

test("provider setup is unknown until health explicitly reports configuration", () => {
  const appstate = code(APPSTATE);
  assert.match(appstate, /@Published var providerConfigured: Bool\? = nil/);
  assert.match(appstate, /providerConfigured = h\.status\?\.agentHost\?\.providerConfigured\s*\n/);
  assert.match(appstate, /providerSetupStatus == \.needsSetup && !offeredSetupThisLaunch/);
  const tray = code(TRAY);
  assert.match(tray, /switch state\.providerSetupStatus/);
  assert.match(tray, /case \.unknown:\s*Text\("Model setup cannot be checked until the daemon responds"\)/);
  assert.doesNotMatch(tray, /!state\.providerConfigured/);
});

test("health recovery reconciles approvals even when no SSE event is replayed", () => {
  const appstate = code(APPSTATE);
  assert.match(appstate, /let recoveredFromOutage = consecutiveFailures > 0/);
  assert.match(appstate, /if !didInitialBriefRefresh \|\| recoveredFromOutage \{[^}]*scheduleBriefRefresh\(\)[^}]*PendingApprovalConsumer\.shared\.refresh\(\)/);
});

test("daemon logging does not depend on the parent draining a pipe", () => {
  const daemon = code(DAEMON);
  assert.match(daemon, /proc\.standardOutput = logHandle \?\? FileHandle\.nullDevice/);
  assert.match(daemon, /proc\.standardError = logHandle \?\? FileHandle\.nullDevice/);
  assert.doesNotMatch(daemon, /readabilityHandler/);
  assert.match(daemon, /attributes: \[\.posixPermissions: 0o600\]/);
});

test("tray restart action never labels itself with recovery jargon", () => {
  // Shipped label: `Button(state.status == .down ? "↻ Restart daemon" : "↻ Restart daemon (recover)")`.
  // "(recover)" names an implementation detail — that bouncing a daemon which
  // still answers is how you clear a wedged one — and reads to a user as a
  // warning that something is broken. It was on screen nearly permanently:
  // computeStatus() returns .degraded once spend passes 70% of the daily cap,
  // which under sustained use can be most of the day with a healthy daemon. A
  // budget number rendered as a permanent "recover" button.
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
  // A daemon can sit in process state T (stopped by a job-control signal) while
  // holding its LISTEN socket indefinitely: process alive, port bound, /health
  // never answering. status == .down covered both that and "the process
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
    /switch await DaemonController\.shared\.listenerOwnership\(\)/,
    `${APPSTATE} must actually classify the listener in the /health failure path — otherwise ` +
      `reachability is a field nothing ever sets.`
  );
  assert.match(
    code(DAEMON),
    /func listenerOwnership\(\) async -> ListenerOwnership/,
    `${DAEMON} must expose the LISTEN-socket classification AppState needs; pidListeningOnPort ` +
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
    /func restart\(force: Bool = false\) -> Bool \{\s*\n\s*lastRestartAt = Date\(\)/,
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

test("a stale crash callback cannot clear a newer daemon process", () => {
  const daemon = code(DAEMON);
  const handler = daemon.indexOf("proc.terminationHandler");
  const launch = daemon.indexOf("try proc.run()", handler);
  assert.ok(handler >= 0 && launch > handler, `${DAEMON} termination handler not found`);
  const body = daemon.slice(handler, launch);
  assert.match(
    body,
    /guard let self, self\.process === p else \{ return \}/,
    "the exit callback must prove its Process is still the controller's current child"
  );
  assert.ok(
    body.indexOf("self.process === p") < body.indexOf("self.process = nil"),
    "process identity must be checked before the shared handle is cleared"
  );
  assert.match(
    body,
    /guard let self, self\.process == nil else \{ return \}[\s\S]*self\.start\(\)/,
    "the delayed crash restart must yield to a manual restart that already started a child"
  );
});

test("Restart daemon replaces an adopted daemon instead of silently doing nothing", () => {
  // start() adopts an already-healthy daemon on 43210 and returns WITHOUT ever
  // setting `process`. That is not an edge case — it is what happens every time
  // the app is relaunched while a previous daemon is still alive and reparented
  // to launchd. With `process` nil, stop() short-circuits on its `guard let proc`,
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

test("Restart daemon is always available as ordinary maintenance", () => {
  // A healthy daemon can still be stale after an app update or configuration
  // change. Hiding restart behind .down/.degraded made the only immediate
  // recovery action disappear in exactly that healthy-but-old state.
  const tray = code(TRAY);
  const start = tray.indexOf("private var actionsSection");
  const end = tray.indexOf("private func captureLabel", start);
  assert.ok(start >= 0 && end > start, `${TRAY} actions section not found`);
  const actions = tray.slice(start, end);
  assert.match(
    actions,
    /Button\(restartLabel\) \{ restartDaemon\(\) \}/,
    `${TRAY} must expose restart even while health is green; stale runtime state ` +
      `does not necessarily make /health fail.`
  );
  assert.equal(
    (tray.match(/Button\(restartLabel\)/g) ?? []).length,
    1,
    `${TRAY} should render one restart action, not duplicate it in status-dependent sections.`
  );
});

test("Restart daemon never terminates a listener managed outside the app", () => {
  const daemon = code(DAEMON);
  const restart = daemon.indexOf("func restart(force: Bool = false) -> Bool");
  const owns = daemon.indexOf("private func ownsDaemon", restart);
  assert.ok(restart >= 0 && owns > restart, `${DAEMON} safe restart region not found`);
  const body = daemon.slice(restart, owns);
  assert.match(body, /if force[\s\S]*pidListeningOnPort\(43210\)[\s\S]*!ownsDaemon/);
  assert.ok(
    body.indexOf("!ownsDaemon") < body.indexOf("stop()"),
    "ownership must be verified before restart signals any listener"
  );
  assert.match(
    daemon,
    /if let stalePid = Self\.pidListeningOnPort\(43210\) \{\s*guard ownsDaemon\(listenerPid: stalePid\) else/,
    "start() must repeat ownership verification after the restart delay to close bind races"
  );
  assert.match(code(TRAY), /guard !DaemonController\.shared\.restart\(force: true\)/);
  assert.match(code(TRAY), /managed outside OpenAGI/);
  assert.match(code(TRAY), /state\.daemonManagedExternally[\s\S]*Daemon managed externally/);
  assert.match(
    code(APPSTATE),
    /@Published var daemonManagedExternally[\s\S]*listenerOwnership\(\) == \.external/,
    "listener ownership must be published by AppState rather than computed during SwiftUI rendering"
  );
  assert.match(
    daemon,
    /func listenerOwnership\(\) async -> ListenerOwnership[\s\S]*DispatchQueue\.global[\s\S]*pidListeningOnPort/,
    "the lsof-backed ownership probe must run off the main thread"
  );
  const restartLabel = code(TRAY).slice(
    code(TRAY).indexOf("private var restartLabel"),
    code(TRAY).indexOf("private var statusLine")
  );
  assert.doesNotMatch(
    restartLabel,
    /DaemonController\.shared/,
    "SwiftUI's restart label must read cached state and never invoke daemon process discovery"
  );
});

test("app launch replaces only a daemon running this bundle's Node binary", () => {
  // A Sparkle update relaunches the native process at the same bundle path but
  // does not automatically terminate an orphaned Node child. Merely checking
  // /health adopted that old runtime, so the new app continued reporting the
  // old version. We must identify ownership from the kernel-reported executable
  // path; command-line text is forgeable, while killing every healthy listener
  // would break the supported `npm run serve` development workflow.
  const daemon = code(DAEMON);
  assert.match(
    daemon,
    /if adoptExisting, isExistingDaemonHealthy\(\) \{[\s\S]*Self\.isBundledDaemon\(listenerPid, currentNodeBinary: nodeBinary\)[\s\S]*healthy external daemon[\s\S]*return/,
    `${DAEMON} must replace a healthy listener only after its executable path ` +
      `matches this app bundle's Node binary, and adopt a healthy external daemon.`
  );
  assert.match(
    daemon,
    /proc_pidpath\(pid,/,
    `${DAEMON} must resolve listener ownership through proc_pidpath rather than ` +
      `trusting process arguments or a self-reported health field.`
  );
  assert.match(
    daemon,
    /textExecutablePath\(for: pid\)[\s\S]*app\.openagi\.daemon\/org\.sparkle-project\.Sparkle\/Installation[\s\S]*OpenAGI\.app\/Contents\/Resources\/node\/bin\/node/,
    `${DAEMON} must recognize the old executable after Sparkle moves its bundle ` +
      `into the installation cache; proc_pidpath returns ENOENT for that live vnode.`
  );
});

test("application termination signals the daemon without racing a quit-time flush", () => {
  // applicationWillTerminate does not extend process lifetime for an un-awaited
  // Task. When stop() lived after CaptureBridge.flushNow(), macOS could tear the
  // app down first and reparent the daemon to launchd, creating the stale runtime
  // that the next app launch adopted.
  const app = code(APPDELEGATE);
  const start = app.indexOf("nonisolated func applicationWillTerminate");
  const end = app.indexOf("nonisolated func userNotificationCenter", start);
  assert.ok(start >= 0 && end > start, `${APPDELEGATE} termination delegate not found`);
  const termination = app.slice(start, end);
  const stop = termination.indexOf("DaemonController.shared.stopForApplicationTermination()");
  const task = termination.indexOf("Task { @MainActor in");
  assert.ok(stop >= 0, `${APPDELEGATE} must stop the daemon during termination`);
  assert.ok(
    stop < task,
    `${APPDELEGATE} must call stop() synchronously before starting cleanup that ` +
      `crosses an await; a stop inside that Task can be abandoned at process exit.`
  );
  assert.doesNotMatch(
    termination,
    /CaptureBridge\.flushNow\(\)/,
    `${APPDELEGATE} must not start an un-awaited local flush after stopping its daemon; ` +
      `unpushed rows are durable and retry on the next launch.`
  );
  const daemon = code(DAEMON);
  const syncStop = daemon.slice(
    daemon.indexOf("func stopForApplicationTermination()"),
    daemon.indexOf("func restart(force:")
  );
  assert.match(syncStop, /proc\.terminate\(\)[\s\S]*while proc\.isRunning[\s\S]*SIGKILL/);
  assert.doesNotMatch(
    code(TRAY),
    /Button\("Quit OpenAGI"\)[\s\S]{0,160}DaemonController\.shared\.stop\(\)/,
    "the tray must let applicationWillTerminate retain the Process handle for synchronous cleanup"
  );
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
