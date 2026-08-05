import AppKit
import CoreGraphics
import Foundation

// Single source of truth for the two TCC permissions ambient capture depends on:
// Screen Recording (ScreenCaptureKit) and Accessibility (window titles).
//
// WHY THE PREFLIGHT EXISTS — DO NOT DELETE IT AS A "REDUNDANT CHECK":
// The ScreenCaptureKit entry points (SCShareableContent.excludingDesktopWindows,
// SCScreenshotManager.captureImage) PROMPT as a side effect when Screen Recording
// has not been granted. So calling one of them to find out whether we are allowed
// to call it IS the bug: a repeating capture timer that "just tries and catches
// the error" re-raises the system dialog
//     "OpenAGI would like to record this computer's screen and audio"
// on every single tick — every 5 seconds, forever — and the catch block never
// learns anything, because the throw looks like any other failure.
// CGPreflightScreenCaptureAccess() is the non-prompting query, and it is the only
// thing in this target allowed to answer that question.
//
// Same shape for Accessibility: AXIsProcessTrusted() is the non-prompting query.
// Its sibling AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt: true])
// DOES prompt and must never be called from a timer or a hot path. This target
// currently never calls it (ActivityTracker.swift:63 and ScreenCapturer's
// frontmostWindowTitle use the safe form) — keep it that way.
//
// The other half of the story: once the user has answered, macOS will not ask
// again. TCC records the decision and every later CGRequestScreenCaptureAccess()
// is a silent no-op. There is therefore no such thing as a "retry the dialog"
// recovery path — the only way back is System Settings, which is why this type
// exposes the state plus a deep link instead of re-asking.

@MainActor
final class CapturePermissions: ObservableObject {
  static let shared = CapturePermissions()

  /// Screen Recording (TCC). Read via CGPreflightScreenCaptureAccess() only.
  @Published private(set) var screenRecordingGranted: Bool
  /// Accessibility (TCC). Read via AXIsProcessTrusted() only — never the
  /// prompting AXIsProcessTrustedWithOptions form.
  @Published private(set) var accessibilityGranted: Bool
  /// True once this launch has spent its single, deliberate system prompt.
  @Published private(set) var didAskScreenRecordingThisLaunch = false
  /// Set when capture stopped itself for a reason the user has to see (so the
  /// privacy panel / tray can say why capture is off instead of dying quietly).
  @Published private(set) var lastCaptureFailure: String?

  /// Invoked when Screen Recording flips absent -> granted while the app is
  /// running, so capture can resume with no relaunch. Wired by CaptureController.
  var onScreenRecordingGranted: (() -> Void)?

  private var watching = false
  private var notifyingGrant = false
  private var workspaceObservers: [NSObjectProtocol] = []
  private var appObservers: [NSObjectProtocol] = []
  private var lastActivationRefresh = Date.distantPast

  private init() {
    // Both of these are non-prompting reads. Safe at init.
    screenRecordingGranted = CGPreflightScreenCaptureAccess()
    accessibilityGranted = AXIsProcessTrusted()
  }

  // MARK: — non-prompting state reads

  /// Non-prompting Screen Recording check. This is THE gate every capture call
  /// site must pass through. CGPreflightScreenCaptureAccess() never shows UI.
  @discardableResult
  func refreshScreenRecording() -> Bool {
    let granted = CGPreflightScreenCaptureAccess()
    let was = screenRecordingGranted
    if granted != was { screenRecordingGranted = granted }
    // The absent -> granted transition fires the resume hook from HERE, not
    // from the caller, so it cannot be missed depending on which observer
    // happened to notice first (activation vs. the privacy panel's refresh).
    if !was && granted { finishGrant() }
    return granted
  }

  /// Non-prompting Accessibility check.
  @discardableResult
  func refreshAccessibility() -> Bool {
    let trusted = AXIsProcessTrusted()
    if trusted != accessibilityGranted { accessibilityGranted = trusted }
    return trusted
  }

  /// Refresh both. Cheap, and — critically — cannot raise a dialog.
  func refresh() {
    refreshScreenRecording()
    refreshAccessibility()
  }

  // MARK: — the one deliberate ask

  /// Show the macOS Screen Recording prompt at most once per app launch.
  ///
  /// Callers must be user-visible, deliberate moments (app launch with capture
  /// enabled, the user turning capture on, the user invoking Quick Ask) — NEVER
  /// the repeating capture timer. The launch-scoped flag is belt-and-braces:
  /// macOS itself only ever shows this dialog once per TCC decision.
  func requestScreenRecordingOnceThisLaunch() {
    if didAskScreenRecordingThisLaunch { return }
    if screenRecordingGranted { return }
    didAskScreenRecordingThisLaunch = true
    // Off the main actor: the call can block while the system dialog is up, and
    // its return value reflects the state at call time, not the user's answer —
    // the real signal is the activation-driven preflight in handleActivation().
    Task.detached(priority: .userInitiated) {
      let granted = CGRequestScreenCaptureAccess()
      await MainActor.run { CapturePermissions.shared.applyRequestResult(granted) }
    }
  }

  private func applyRequestResult(_ granted: Bool) {
    // Trust the preflight over the request's return value; refreshScreenRecording
    // owns the transition -> resume hook.
    if granted { refreshScreenRecording() }
  }

  // MARK: — resume without a restart

  /// Start listening for the user coming back from System Settings.
  ///
  /// Deliberately NOT a poll of the capture API: the only probe that runs is
  /// CGPreflightScreenCaptureAccess(), which cannot prompt. The trigger is app
  /// activation (ours or anyone's) — i.e. it fires when the user switches away
  /// from System Settings, a handful of times an hour, not on a timer.
  /// Observers are torn down the moment permission arrives.
  func beginWatchingForGrant() {
    if watching { return }
    watching = true
    let ws = NSWorkspace.shared.notificationCenter
    workspaceObservers.append(
      ws.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
        guard let self else { return }
        Task { @MainActor in self.handleActivation() }
      })
    appObservers.append(
      NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
        guard let self else { return }
        Task { @MainActor in self.handleActivation() }
      })
  }

  func stopWatchingForGrant() {
    let ws = NSWorkspace.shared.notificationCenter
    for o in workspaceObservers { ws.removeObserver(o) }
    for o in appObservers { NotificationCenter.default.removeObserver(o) }
    workspaceObservers.removeAll()
    appObservers.removeAll()
    watching = false
  }

  private func handleActivation() {
    // Coalesce bursts of app switching; a preflight is cheap but not free.
    let now = Date()
    if now.timeIntervalSince(lastActivationRefresh) < 1.0 { return }
    lastActivationRefresh = now
    // Non-prompting for both permissions; refreshScreenRecording fires the
    // resume hook itself if this is the moment the grant landed.
    refresh()
  }

  private func finishGrant() {
    if notifyingGrant { return }  // no re-entry via apply() -> start() -> refresh()
    notifyingGrant = true
    defer { notifyingGrant = false }
    stopWatchingForGrant()
    lastCaptureFailure = nil
    onScreenRecordingGranted?()
  }

  // MARK: — failure surface

  /// Record why capture shut itself down (visible in the privacy panel / tray).
  func noteCaptureFailure(_ message: String?) {
    if lastCaptureFailure != message { lastCaptureFailure = message }
  }

  // MARK: — the only recovery path macOS offers

  func openScreenRecordingSettings() {
    open("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
  }

  func openAccessibilitySettings() {
    // watchForGrant: false — the watcher only ever resolves a SCREEN RECORDING
    // grant. Arming it from the Accessibility row starts a watcher that can
    // never fire (screen recording may already be granted) and leaks its
    // observers until the app quits.
    open("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
         watchForGrant: false)
  }

  private func open(_ urlString: String, watchForGrant: Bool = true) {
    guard let url = URL(string: urlString) else { return }
    NSWorkspace.shared.open(url)
    // The user is on their way to System Settings — listen for their return so
    // capture can pick the grant up without a relaunch where macOS allows it.
    if watchForGrant { beginWatchingForGrant() }
  }
}
