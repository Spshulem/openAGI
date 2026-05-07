import AppKit
import Foundation
import Sparkle

// Sparkle wrapper. Reads SUFeedURL + SUPublicEDKey from Info.plist.
// Daily background check; user can also trigger from the tray menu.
//
// Sparkle 2 requires a valid EdDSA public key AND a code-signed bundle. Local
// unsigned builds with the placeholder key would cause "The updater failed to
// start" — so we detect that and degrade to a no-op + friendly dialog.

final class UpdateController: NSObject {
  static let shared = UpdateController()

  private let updaterController: SPUStandardUpdaterController
  private(set) var isEnabled: Bool = false

  override init() {
    self.updaterController = SPUStandardUpdaterController(
      startingUpdater: false,
      updaterDelegate: nil,
      userDriverDelegate: nil
    )
    super.init()
  }

  func start() {
    guard isProperlyConfigured() else {
      NSLog("OpenAGI: auto-update disabled — Sparkle key/feed not configured for this build.")
      return
    }
    updaterController.updater.automaticallyChecksForUpdates = true
    updaterController.updater.updateCheckInterval = 60 * 60 * 24 // daily
    updaterController.startUpdater()
    isEnabled = true
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
      alert.informativeText = "This OpenAGI build is unsigned or was built without a Sparkle signing key. To enable auto-updates, generate a Sparkle EdDSA key (see mac/README.md), set SUPublicEDKey in Info.plist, and ship a signed release.\n\nTo update manually: cd ~/Dev/openAGI && git pull && ./scripts/build-mac-app.sh"
      alert.alertStyle = .informational
      alert.addButton(withTitle: "OK")
      alert.runModal()
    }
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
