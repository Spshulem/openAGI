import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The macOS app has no Swift test target. Pin the integration contracts that
// previously failed in production at source level, alongside
// test/mac-daemon-status.test.js and test/privacy-copy.test.js.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UPDATE = "mac/Sources/OpenAGI/UpdateController.swift";
const TRAY = "mac/Sources/OpenAGI/TrayController.swift";
const APP = "mac/Sources/OpenAGI/AppDelegate.swift";
const PERMISSIONS = "mac/Sources/OpenAGI/Capture/CapturePermissions.swift";
const CAPTURER = "mac/Sources/OpenAGI/Capture/ScreenCapturer.swift";
const CAPTURE_CONTROLLER = "mac/Sources/OpenAGI/Capture/CaptureController.swift";
const PRIVACY_PANEL = "mac/Sources/OpenAGI/PrivacyPanel.swift";
const INFO = "mac/Resources/Info.plist";

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function stripLineComments(source) {
  return source
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");
}

function code(rel) {
  return stripLineComments(read(rel));
}

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not find source region ${start} ... ${end}`);
  return source.slice(from, to);
}

test("Sparkle preserves preferences and defaults signed nodes to unattended updates", () => {
  const update = code(UPDATE);
  const start = between(update, "func start()", "func setAutomaticallyChecksForUpdates");

  assert.doesNotMatch(
    start,
    /automaticallyChecksForUpdates\s*=/,
    "launch must not overwrite Sparkle's persisted automatic-check preference"
  );
  assert.doesNotMatch(
    start,
    /automaticallyDownloadsUpdates\s*=/,
    "launch must not overwrite Sparkle's persisted automatic-install preference"
  );
  assert.match(update, /updaterDelegate:\s*self/);
  assert.match(update, /userDriverDelegate:\s*self/);

  const tray = code(TRAY);
  assert.match(tray, /Menu\("Updates"\)/);
  assert.match(tray, /Toggle\("Check automatically"/);
  assert.match(tray, /Toggle\("Install and restart automatically"/);
  assert.match(tray, /Button\("Check now…"\)/);
  assert.match(tray, /updates\.installLocationWarning/);
  assert.match(update, /\.applicationDirectory, in: \.allDomainsMask/);
  assert.match(update, /Running outside an Applications folder/);
  assert.doesNotMatch(
    update,
    /URL\(fileURLWithPath:\s*"\/Applications\/OpenAGI\.app"\)/,
    "the public warning must not assume one exact install path or app copy"
  );

  assert.match(
    read(INFO),
    /<key>SUEnableAutomaticChecks<\/key>\s*<true\/>[\s\S]*<key>SUAllowsAutomaticUpdates<\/key>\s*<true\/>[\s\S]*<key>SUAutomaticallyUpdate<\/key>\s*<true\/>/,
    "fresh signed installs must check, download, install, and restart without an attended Mac"
  );
});

test("dockless scheduled updates use one visible reminder and notification taps open Sparkle", () => {
  const update = code(UPDATE);
  assert.match(update, /supportsGentleScheduledUpdateReminders:\s*Bool\s*\{\s*true\s*\}/);
  assert.match(
    update,
    /standardUserDriverShouldHandleShowingScheduledUpdate[\s\S]*?\n\s*true\s*\n\s*\}/,
    "Sparkle must always keep its own alert when Notification Center cannot show one"
  );
  assert.match(update, /guard !state\.userInitiated else \{ return \}/);
  assert.match(update, /UNNotificationRequest\([\s\S]*Self\.notificationIdentifier/);
  assert.match(update, /func handleUpdateNotificationTap\(\)[\s\S]*NSApp\.activate[\s\S]*checkForUpdates\(\)/);

  const app = code(APP);
  const updateRoute = app.indexOf("UpdateController.isUpdateNotification(response)");
  const dashboardRoute = app.indexOf("AppState.shared.openDashboard(path: path)");
  assert.ok(updateRoute >= 0, "AppDelegate must recognize update-notification taps");
  assert.ok(
    dashboardRoute > updateRoute,
    "update taps must be handled before the generic dashboard notification route"
  );
  assert.match(app, /UpdateController\.shared\.handleUpdateNotificationTap\(\)/);
});

test("automatic install opt-in installs and lets termination stop the daemon", () => {
  const update = code(UPDATE);
  const delegate = between(
    update,
    "func updater(\n",
    "private func syncPreferences"
  );
  assert.match(delegate, /guard updater\.automaticallyDownloadsUpdates else \{ return false \}/);
  assert.match(delegate, /immediateInstallHandler\(\)/);
  assert.match(delegate, /return true/);
  assert.doesNotMatch(
    delegate,
    /DaemonController\.shared\.stop\(\)/,
    "the daemon must remain available if Sparkle cannot begin installation; AppDelegate stops it once termination starts"
  );
});

test("Screen Recording prompts once for first use and never requests past a live or remembered grant", () => {
  const permissions = code(PERMISSIONS);
  assert.match(permissions, /func scheduleAutomaticScreenRecordingRequestIfNeeded\(\)/);
  assert.match(permissions, /func requestScreenRecordingForFeatureUseIfNeeded\(\)/);
  assert.match(permissions, /func requestScreenRecordingFromPermissionButton\(\)/);
  assert.match(permissions, /private func requestScreenRecordingOnceThisLaunch\(\)/);
  assert.match(permissions, /SecCodeCopyDesignatedRequirement/);
  assert.match(permissions, /SecRequirementCopyData/);

  // CoreGraphics' prompting API has exactly one implementation site, and that
  // site re-runs the non-prompting preflight immediately before requesting.
  const swiftSources = filesUnder(path.join(root, "mac/Sources"))
    .filter((file) => file.endsWith(".swift"))
    .map((file) => stripLineComments(fs.readFileSync(file, "utf8")))
    .join("\n");
  assert.equal(
    (swiftSources.match(/CGRequestScreenCaptureAccess\(\)/g) ?? []).length,
    1,
    "CGRequestScreenCaptureAccess must have exactly one guarded implementation site"
  );
  const request = between(
    permissions,
    "private func requestScreenRecordingOnceThisLaunch()",
    "private func applyRequestResult"
  );
  assert.ok(
    request.indexOf("refreshScreenRecording()") < request.indexOf("CGRequestScreenCaptureAccess()"),
    "the live preflight must happen at the final request boundary"
  );
  assert.match(request, /didRequestScreenRecordingThisLaunch/);
  assert.ok(
    request.indexOf("CGRequestScreenCaptureAccess()") < request.indexOf("rememberCurrentIdentity"),
    "an identity must be recorded as requested only after CoreGraphics actually ran"
  );

  // An update relaunch gets a short, non-prompting grace window. A grant
  // previously observed for this stable signing identity suppresses automatic
  // requests, as does an automatic request already made for the identity.
  const automatic = between(
    permissions,
    "func scheduleAutomaticScreenRecordingRequestIfNeeded()",
    "func cancelAutomaticScreenRecordingRequest()"
  );
  assert.match(automatic, /Task\.sleep/);
  assert.match(automatic, /refreshScreenRecording\(\)/);
  assert.match(automatic, /requestScreenRecordingRespectingHistory\(\)/);
  assert.match(permissions, /permissionHistoryVersionKey/);
  assert.match(automatic, /needsHistoryMigration\([\s\S]*identity: permissionIdentity/);
  assert.match(
    automatic,
    /isPermissionHistoryMigration[\s\S]*rememberCurrentIdentity\(forKey: Self\.automaticOnboardingConsumedIdentitiesKey\)[\s\S]*return/,
    "the first identity-aware release must migrate an existing capture-enabled install without automatically re-prompting"
  );
  const respectingHistory = between(
    permissions,
    "private func requestScreenRecordingRespectingHistory()",
    "private func requestScreenRecordingOnceThisLaunch()"
  );
  assert.match(respectingHistory, /CaptureSettings\.shared\.isActiveNow\(\)/);
  assert.match(respectingHistory, /grantedIdentitiesKey/);
  assert.match(respectingHistory, /automaticOnboardingConsumedIdentitiesKey/);
  assert.match(respectingHistory, /case \.previouslyGranted/);
  assert.match(respectingHistory, /case \.request:[\s\S]*requestScreenRecordingOnceThisLaunch\(\)/);
  assert.match(permissions, /stringArray\(forKey: key\)/);
  assert.match(permissions, /dictionary\(forKey: Self\.permissionHistoryVersionKey\)/);
  assert.doesNotMatch(permissions, /string\(forKey: Self\.(?:grantedIdentitiesKey|automaticOnboardingConsumedIdentitiesKey)\)/);

  const controller = code(CAPTURE_CONTROLLER);
  assert.ok(
    (controller.match(/cancelAutomaticScreenRecordingRequest\(\)/g) ?? []).length >= 2,
    "stopping, disabling, or pausing capture must cancel a pending onboarding request"
  );

  // Launch follows AppDelegate -> CaptureController.start -> apply ->
  // ScreenCapturer.start. It may schedule the guarded onboarding policy, but
  // no startup call site may invoke CoreGraphics' prompting API directly.
  const appLaunch = between(code(APP), "applicationDidFinishLaunching", "applicationWillTerminate");
  const controllerStart = between(code(CAPTURE_CONTROLLER), "func start()", "func stop()");
  const controllerApply = between(code(CAPTURE_CONTROLLER), "func apply()", "func runRetention()");
  const capturerStart = between(code(CAPTURER), "func start()", "func stop()");
  assert.match(capturerStart, /scheduleAutomaticScreenRecordingRequestIfNeeded\(\)/);
  for (const [name, body] of [
    ["AppDelegate launch", appLaunch],
    ["CaptureController.start", controllerStart],
    ["CaptureController.apply", controllerApply],
    ["ScreenCapturer.start", capturerStart]
  ]) {
    assert.doesNotMatch(
      body,
      /CGRequestScreenCaptureAccess/,
      `${name} must not call the prompting API directly`
    );
  }

  const captureTick = between(code(CAPTURER), "func captureOnce() async", "func captureFocusedText");
  assert.doesNotMatch(
    captureTick,
    /scheduleAutomaticScreenRecordingRequestIfNeeded|requestScreenRecordingForFeatureUseIfNeeded|requestScreenRecordingFromPermissionButton|CGRequestScreenCaptureAccess/,
    "the repeating capture timer must never request permission"
  );

  // Only the literal Request Permission button may bypass remembered history.
  // Enabling capture and Quick Ask use the identity-aware feature path.
  assert.equal((code(TRAY).match(/\.requestScreenRecordingFromPermissionButton\(\)/g) ?? []).length, 1);
  assert.equal(
    ([code(CAPTURE_CONTROLLER), code(CAPTURER)].join("\n")
      .match(/\.requestScreenRecordingForFeatureUseIfNeeded\(\)/g) ?? []).length,
    2
  );
  assert.match(code(CAPTURE_CONTROLLER), /func setEnabledFromExplicitUserAction[\s\S]*requestScreenRecordingForFeatureUseIfNeeded/);
  assert.match(code(PRIVACY_PANEL), /setEnabledFromExplicitUserAction\(\$0\)/);
  assert.match(code(CAPTURER), /func captureFocusedText[\s\S]*requestScreenRecordingForFeatureUseIfNeeded/);
});
