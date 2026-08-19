import AppKit
import CoreGraphics
import Foundation
import Security

enum ScreenRecordingPermissionDecision: Equatable {
  case inactive
  case alreadyGranted
  case previouslyGranted
  case previouslyRequested
  case request
}

/// Pure decision core for identity-aware permission paths. Keeping this free
/// of TCC and UserDefaults makes the cross-launch cases executable in tests.
struct ScreenRecordingPermissionPolicy {
  static func identityAwareDecision(
    captureActive: Bool,
    preflightGranted: Bool,
    identity: String,
    grantedIdentities: Set<String>,
    automaticOnboardingConsumedIdentities: Set<String>
  ) -> ScreenRecordingPermissionDecision {
    if !captureActive { return .inactive }
    if preflightGranted { return .alreadyGranted }
    if grantedIdentities.contains(identity) { return .previouslyGranted }
    if automaticOnboardingConsumedIdentities.contains(identity) { return .previouslyRequested }
    return .request
  }

  static func needsHistoryMigration(
    identity: String,
    storedVersions: [String: Int],
    currentVersion: Int
  ) -> Bool {
    (storedVersions[identity] ?? 0) < currentVersion
  }
}

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
// CGRequestScreenCaptureAccess() is a request, not a status probe. TCC can show
// it whenever macOS considers the current code identity unapproved, including
// briefly during an update relaunch. This type therefore remembers grants by
// the app's stable designated requirement and gives startup a short preflight-
// only grace period before deciding whether a first-use request is appropriate.

@MainActor
final class CapturePermissions: ObservableObject {
  static let shared = CapturePermissions()

  private static let grantedIdentitiesKey = "openagi.screenRecording.grantedIdentities"
  private static let automaticOnboardingConsumedIdentitiesKey = "openagi.screenRecording.automaticOnboardingConsumedIdentities"
  private static let permissionHistoryVersionKey = "openagi.screenRecording.permissionHistoryVersion"
  private static let currentPermissionHistoryVersion = 1
  private static let startupPreflightRetryNanoseconds: [UInt64] = [
    250_000_000,
    500_000_000,
    750_000_000
  ]

  /// Screen Recording (TCC). Read via CGPreflightScreenCaptureAccess() only.
  @Published private(set) var screenRecordingGranted: Bool
  /// Accessibility (TCC). Read via AXIsProcessTrusted() only — never the
  /// prompting AXIsProcessTrustedWithOptions form.
  @Published private(set) var accessibilityGranted: Bool
  /// True once this launch has spent its single deliberate system request.
  @Published private(set) var didRequestScreenRecordingThisLaunch = false
  /// Set when capture stopped itself for a reason the user has to see (so the
  /// privacy panel / tray can say why capture is off instead of dying quietly).
  @Published private(set) var lastCaptureFailure: String?

  /// Invoked when Screen Recording flips absent -> granted while the app is
  /// running, so capture can resume with no relaunch. Wired by CaptureController.
  var onScreenRecordingGranted: (() -> Void)?

  private var watching = false
  private var notifyingGrant = false
  private var automaticRequestTask: Task<Void, Never>?
  private var workspaceObservers: [NSObjectProtocol] = []
  private var appObservers: [NSObjectProtocol] = []
  private var lastActivationRefresh = Date.distantPast
  private let permissionIdentity: String

  private init() {
    permissionIdentity = Self.currentPermissionIdentity()
    // Both of these are non-prompting reads. Safe at init.
    screenRecordingGranted = CGPreflightScreenCaptureAccess()
    accessibilityGranted = AXIsProcessTrusted()
    if screenRecordingGranted { rememberCurrentIdentityGrant() }
  }

  // MARK: — non-prompting state reads

  /// Non-prompting Screen Recording check. This is THE gate every capture call
  /// site must pass through. CGPreflightScreenCaptureAccess() never shows UI.
  @discardableResult
  func refreshScreenRecording() -> Bool {
    let granted = CGPreflightScreenCaptureAccess()
    let was = screenRecordingGranted
    if granted != was { screenRecordingGranted = granted }
    if granted { rememberCurrentIdentityGrant() }
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

  // MARK: — deliberate requests

  /// Schedule the one automatic first-use request allowed for this code
  /// identity. The capture lifecycle calls this only when capture is enabled
  /// and the initial non-prompting preflight returned false.
  ///
  /// The delayed checks cover the launch/update window where TCC can briefly
  /// return false for an unchanged signed app. If this identity was ever
  /// observed as granted, or has already received its automatic request, we
  /// surface recovery controls instead of asking again.
  func scheduleAutomaticScreenRecordingRequestIfNeeded() {
    guard automaticRequestTask == nil, !didRequestScreenRecordingThisLaunch else { return }
    // Releases before this policy did not persist permission history. If an
    // existing capture-enabled install upgrades while TCC is temporarily
    // returning false, there is no honest way to distinguish a prior grant
    // from a prior denial. Migrate it without automatically prompting; the
    // labelled Request Permission control remains available. Fresh installs
    // start with capture disabled, and their explicit enable action marks the
    // policy current before requesting first-use access.
    let isPermissionHistoryMigration = ScreenRecordingPermissionPolicy.needsHistoryMigration(
      identity: permissionIdentity,
      storedVersions: permissionHistoryVersions(),
      currentVersion: Self.currentPermissionHistoryVersion)
    markPermissionHistoryCurrent()
    automaticRequestTask = Task { @MainActor [weak self] in
      guard let self else { return }
      for delay in Self.startupPreflightRetryNanoseconds {
        try? await Task.sleep(nanoseconds: delay)
        if Task.isCancelled { return }
        if self.refreshScreenRecording() { return }
      }

      if isPermissionHistoryMigration {
        self.rememberCurrentIdentity(forKey: Self.automaticOnboardingConsumedIdentitiesKey)
        self.noteCaptureFailure(
          "Screen Recording was configured before this update but macOS is not reporting access — capture is off. Use Request Permission or open System Settings if it does not recover.")
        self.automaticRequestTask = nil
        return
      }
      self.requestScreenRecordingRespectingHistory()
    }
  }

  /// Cancel onboarding while it is still in the non-prompting grace period.
  /// Once CoreGraphics is already presenting its system UI it cannot be
  /// recalled, so every inactive capture path calls this before that boundary.
  func cancelAutomaticScreenRecordingRequest() {
    automaticRequestTask?.cancel()
    automaticRequestTask = nil
  }

  /// Feature use (enabling capture or Quick Ask) may request first-use access,
  /// but it must not bypass a remembered grant during a transient false
  /// preflight. Only the literal Request Permission button does that.
  func requestScreenRecordingForFeatureUseIfNeeded() {
    cancelAutomaticScreenRecordingRequest()
    markPermissionHistoryCurrent()
    requestScreenRecordingRespectingHistory()
  }

  /// The explicitly labelled permission button is the user's deliberate retry
  /// after the status UI explains that macOS is not reporting access.
  func requestScreenRecordingFromPermissionButton() {
    cancelAutomaticScreenRecordingRequest()
    markPermissionHistoryCurrent()
    requestScreenRecordingOnceThisLaunch()
  }

  private func requestScreenRecordingRespectingHistory() {
    let decision = ScreenRecordingPermissionPolicy.identityAwareDecision(
      captureActive: CaptureSettings.shared.isActiveNow(),
      preflightGranted: refreshScreenRecording(),
      identity: permissionIdentity,
      grantedIdentities: rememberedIdentities(forKey: Self.grantedIdentitiesKey),
      automaticOnboardingConsumedIdentities: rememberedIdentities(
        forKey: Self.automaticOnboardingConsumedIdentitiesKey))
    switch decision {
    case .inactive, .alreadyGranted, .previouslyRequested:
      return
    case .previouslyGranted:
      noteCaptureFailure(
        "Screen Recording was previously granted but macOS is not reporting it — capture is off. Use Request Permission or open System Settings if it does not recover.")
    case .request:
      requestScreenRecordingOnceThisLaunch()
    }
  }

  /// The only implementation site allowed to call CoreGraphics' prompting
  /// API. Both automatic onboarding and explicit actions converge here.
  private func requestScreenRecordingOnceThisLaunch() {
    if didRequestScreenRecordingThisLaunch { return }
    if refreshScreenRecording() { return }
    didRequestScreenRecordingThisLaunch = true
    // Off the main actor: the call can block while the system dialog is up, and
    // its return value reflects the state at call time, not the user's answer —
    // the real signal is the activation-driven preflight in handleActivation().
    Task.detached(priority: .userInitiated) {
      let granted = CGRequestScreenCaptureAccess()
      await MainActor.run {
        let permissions = CapturePermissions.shared
        // Persist only after the request API really ran. Marking it before the
        // detached task starts could suppress onboarding forever if the app
        // quits in that small scheduling window.
        permissions.rememberCurrentIdentity(forKey: Self.automaticOnboardingConsumedIdentitiesKey)
        permissions.applyRequestResult(granted)
      }
    }
  }

  private func applyRequestResult(_ granted: Bool) {
    // Trust the preflight over the request's return value; refreshScreenRecording
    // owns the transition -> resume hook.
    if granted { refreshScreenRecording() }
  }

  private func rememberCurrentIdentityGrant() {
    markPermissionHistoryCurrent()
    rememberCurrentIdentity(forKey: Self.grantedIdentitiesKey)
  }

  private func markPermissionHistoryCurrent() {
    var versions = permissionHistoryVersions()
    versions[permissionIdentity] = Self.currentPermissionHistoryVersion
    UserDefaults.standard.set(versions, forKey: Self.permissionHistoryVersionKey)
  }

  private func permissionHistoryVersions() -> [String: Int] {
    let raw = UserDefaults.standard.dictionary(forKey: Self.permissionHistoryVersionKey) ?? [:]
    return raw.reduce(into: [:]) { result, pair in
      if let number = pair.value as? NSNumber { result[pair.key] = number.intValue }
    }
  }

  private func rememberedIdentities(forKey key: String) -> Set<String> {
    Set(UserDefaults.standard.stringArray(forKey: key) ?? [])
  }

  private func rememberCurrentIdentity(forKey key: String) {
    var identities = rememberedIdentities(forKey: key)
    guard identities.insert(permissionIdentity).inserted else { return }
    UserDefaults.standard.set(identities.sorted(), forKey: key)
  }

  /// TCC continuity follows a code signature's designated requirement, not an
  /// app version, path, display name, or machine name. Its binary form is a
  /// stable opaque identifier across correctly signed updates.
  private static func currentPermissionIdentity() -> String {
    var dynamicCode: SecCode?
    var staticCode: SecStaticCode?
    var requirement: SecRequirement?
    var requirementData: CFData?
    if SecCodeCopySelf([], &dynamicCode) == errSecSuccess,
       let dynamicCode,
       SecCodeCopyStaticCode(dynamicCode, [], &staticCode) == errSecSuccess,
       let staticCode,
       SecCodeCopyDesignatedRequirement(staticCode, [], &requirement) == errSecSuccess,
       let requirement,
       SecRequirementCopyData(requirement, [], &requirementData) == errSecSuccess,
       let requirementData {
      return (requirementData as Data).base64EncodedString()
    }

    // Unsigned local builds have no designated requirement. Keep their
    // automatic-request bookkeeping scoped to this bundle and install path;
    // release builds always take the signed branch above.
    let bundle = Bundle.main
    let bundleId = bundle.bundleIdentifier ?? "unknown-bundle"
    let path = bundle.bundleURL.resolvingSymlinksInPath().standardizedFileURL.path
    return "unsigned:\(bundleId):\(path)"
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
    cancelAutomaticScreenRecordingRequest()
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

  /// Accessibility has its own explicit prompt API. Keep it behind a literal
  /// user action just like Screen Recording so ordinary status refreshes never
  /// produce recurring system prompts.
  func requestAccessibilityFromPermissionButton() {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    let options = [key: true] as CFDictionary
    accessibilityGranted = AXIsProcessTrustedWithOptions(options)
  }

  /// macOS exposes no request API for Full Disk Access. The only honest
  /// recovery path is the system pane where the user can enable the signed app.
  func openFullDiskAccessSettings() {
    open("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
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
