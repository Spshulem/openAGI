import AppKit
import Combine
import Foundation
// Sparkle's Objective-C user-driver protocol predates Swift concurrency even
// though its callbacks are documented and delivered on the main thread.
@preconcurrency import Sparkle
import UserNotifications

// Sparkle wrapper. Reads SUFeedURL + SUPublicEDKey from Info.plist.
// Daily background check; user can also trigger from the tray menu.
//
// Sparkle 2 requires a valid EdDSA public key AND a code-signed bundle. Local
// unsigned builds with the placeholder key would cause "The updater failed to
// start" — so we detect that and degrade to a no-op + friendly dialog.

@MainActor
final class UpdateController: NSObject, ObservableObject, SPUUpdaterDelegate, SPUStandardUserDriverDelegate {
  static let shared = UpdateController()

  nonisolated static let notificationIdentifier = "app.openagi.update.available"
  nonisolated private static let notificationMarker = "openagiUpdateAvailable"

  // Both delegates are weakly held by Sparkle, so the process-lifetime shared
  // instance owns the controller and remains its delegate. Lazy construction
  // is required because the delegate is `self`.
  private lazy var updaterController = SPUStandardUpdaterController(
      startingUpdater: false,
      updaterDelegate: self,
      userDriverDelegate: self
  )

  @Published private(set) var isEnabled = false
  @Published private(set) var automaticallyChecksForUpdates = false
  @Published private(set) var automaticallyInstallsAndRestarts = false
  @Published private(set) var allowsAutomaticInstall = false
  @Published private(set) var installLocationWarning: String?

  func start() {
    guard isProperlyConfigured() else {
      NSLog("OpenAGI: auto-update disabled — Sparkle key/feed not configured for this build.")
      return
    }
    updaterController.startUpdater()
    isEnabled = true
    syncPreferences()
    updateInstallLocationWarning()
  }

  // Sparkle persists both settings in the host bundle's defaults. These
  // setters run only in direct response to the tray toggles; start() merely
  // reads the saved values and therefore never erases a user's choice.
  func setAutomaticallyChecksForUpdates(_ enabled: Bool) {
    guard isEnabled else { return }
    updaterController.updater.automaticallyChecksForUpdates = enabled
    syncPreferences()
  }

  func setAutomaticallyInstallsAndRestarts(_ enabled: Bool) {
    guard isEnabled, updaterController.updater.allowsAutomaticUpdates else { return }
    updaterController.updater.automaticallyDownloadsUpdates = enabled
    syncPreferences()
  }

  func checkForUpdates() {
    if isEnabled {
      updaterController.checkForUpdates(nil)
      return
    }
    // Friendly no-op for local / unsigned builds.
    DispatchQueue.main.async {
      let alert = NSAlert()
      alert.messageText = "Auto-updates aren't enabled in this build"
      alert.informativeText = "This OpenAGI build is unsigned or was built without a Sparkle signing key. To enable auto-updates, generate a Sparkle EdDSA key (see mac/README.md), set SUPublicEDKey in Info.plist, and ship a signed release.\n\nTo update a source build, pull its repository checkout and rerun scripts/build-mac-app.sh from that checkout."
      alert.alertStyle = .informational
      alert.addButton(withTitle: "OK")
      alert.runModal()
    }
  }

  /// A notification click is an explicit request to see Sparkle's update UI.
  /// Accessory apps have no Dock presence to foreground, so activate first and
  /// then ask Sparkle to bring (or recreate) the update alert into focus.
  func handleUpdateNotificationTap() {
    clearUpdateNotification()
    NSApp.activate(ignoringOtherApps: true)
    checkForUpdates()
  }

  nonisolated static func isUpdateNotification(_ response: UNNotificationResponse) -> Bool {
    let request = response.notification.request
    return request.identifier == notificationIdentifier
      || (request.content.userInfo[notificationMarker] as? Bool == true)
  }

  // MARK: - SPUStandardUserDriverDelegate

  /// Sparkle otherwise warns that a scheduled alert for this dockless app can
  /// appear behind every other window, which is exactly how an update goes
  /// unnoticed for days.
  var supportsGentleScheduledUpdateReminders: Bool { true }

  func standardUserDriverShouldHandleShowingScheduledUpdate(
    _ update: SUAppcastItem,
    andInImmediateFocus immediateFocus: Bool
  ) -> Bool {
    // Always retain Sparkle's own alert as the fail-safe. The notification in
    // the next delegate callback is supplemental: when alerts are denied the
    // update window may still be behind another app, but it is never removed.
    true
  }

  func standardUserDriverWillHandleShowingUpdate(
    _ handleShowingUpdate: Bool,
    forUpdate update: SUAppcastItem,
    state: SPUUserUpdateState
  ) {
    // This banner is a gentle, visible companion to Sparkle's scheduled alert.
    // Manual checks already foreground Sparkle and do not need another banner.
    guard !state.userInitiated else { return }
    postUpdateNotification(version: update.displayVersionString)
  }

  func standardUserDriverDidReceiveUserAttention(forUpdate update: SUAppcastItem) {
    clearUpdateNotification()
  }

  func standardUserDriverWillFinishUpdateSession() {
    clearUpdateNotification()
  }

  // MARK: - SPUUpdaterDelegate

  /// Sparkle's automatic mode normally waits for the host app to quit before
  /// installing. A login-item menubar app may run for weeks, so opting in must
  /// mean what the tray says: install now and let Sparkle relaunch the app.
  /// AppDelegate synchronously stops the daemon once termination actually
  /// begins; stopping it here would leave the live app daemonless if Sparkle's
  /// authorization or installation subsequently failed.
  func updater(
    _ updater: SPUUpdater,
    willInstallUpdateOnQuit item: SUAppcastItem,
    immediateInstallationBlock immediateInstallHandler: @escaping () -> Void
  ) -> Bool {
    guard updater.automaticallyDownloadsUpdates else { return false }
    immediateInstallHandler()
    return true
  }

  private func syncPreferences() {
    let updater = updaterController.updater
    automaticallyChecksForUpdates = updater.automaticallyChecksForUpdates
    automaticallyInstallsAndRestarts = updater.automaticallyDownloadsUpdates
    allowsAutomaticInstall = updater.allowsAutomaticUpdates
  }

  private func updateInstallLocationWarning() {
    let running = Bundle.main.bundleURL.resolvingSymlinksInPath().standardizedFileURL.path
    let applicationRoots = FileManager.default
      .urls(for: .applicationDirectory, in: .allDomainsMask)
      .map { $0.resolvingSymlinksInPath().standardizedFileURL.path }
    let isInApplicationsDirectory = applicationRoots.contains { root in
      running == root || running.hasPrefix(root.hasSuffix("/") ? root : root + "/")
    }
    installLocationWarning = isInApplicationsDirectory
      ? nil
      : "⚠ Running outside an Applications folder — updates apply only to this copy; other copies update separately."
  }

  private func postUpdateNotification(version: String) {
    let content = UNMutableNotificationContent()
    content.title = "OpenAGI update available"
    content.body = "Version \(version) is ready. Click to review and install."
    content.sound = .default
    content.userInfo = [Self.notificationMarker: true]
    let request = UNNotificationRequest(
      identifier: Self.notificationIdentifier,
      content: content,
      trigger: nil)
    UNUserNotificationCenter.current().add(request) { error in
      if let error {
        NSLog("OpenAGI: could not show update notification: \(error.localizedDescription)")
      }
    }
  }

  private func clearUpdateNotification() {
    let center = UNUserNotificationCenter.current()
    center.removeDeliveredNotifications(withIdentifiers: [Self.notificationIdentifier])
    center.removePendingNotificationRequests(withIdentifiers: [Self.notificationIdentifier])
  }

  /// Sparkle is enabled only when the Info.plist values are real and the bundle is signed.
  private func isProperlyConfigured() -> Bool {
    let info = Bundle.main.infoDictionary ?? [:]
    let key = info["SUPublicEDKey"] as? String ?? ""
    let feed = info["SUFeedURL"] as? String ?? ""
    if key.isEmpty || key.contains("__") { return false }
    if feed.isEmpty || feed.contains("__") { return false }
    return isCodeSigned()
  }

  private func isCodeSigned() -> Bool {
    let url = Bundle.main.bundleURL as CFURL
    var staticCode: SecStaticCode?
    guard SecStaticCodeCreateWithPath(url, [], &staticCode) == errSecSuccess,
          let code = staticCode else { return false }
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString("anchor apple generic" as CFString, [], &requirement) == errSecSuccess,
          let req = requirement else { return false }
    return SecStaticCodeCheckValidity(code, [], req) == errSecSuccess
  }
}
