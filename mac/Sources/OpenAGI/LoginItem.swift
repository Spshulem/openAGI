import Foundation
import ServiceManagement

// Manages the macOS "open at login" state via SMAppService (macOS 13+).
// Registration only takes effect when running as a proper signed .app bundle
// (built by scripts/build-mac-app.sh); under a bare `swift build` executable
// the calls compile but may no-op/throw at runtime, which we log and ignore.
enum LoginItem {
  private static let didInitialRegisterKey = "openagi.loginItem.didInitialRegister"

  static var isEnabled: Bool {
    SMAppService.mainApp.status == .enabled
  }

  static func setEnabled(_ enabled: Bool) {
    do {
      if enabled {
        if SMAppService.mainApp.status != .enabled {
          try SMAppService.mainApp.register()
        }
      } else {
        if SMAppService.mainApp.status == .enabled {
          try SMAppService.mainApp.unregister()
        }
      }
    } catch {
      NSLog("OpenAGI: login item \(enabled ? "register" : "unregister") failed: \(error.localizedDescription)")
    }
  }

  // Enable open-at-login ONCE on first launch so it's on by default, but record
  // that we did it — so if the user later turns it off, we never silently turn
  // it back on.
  static func registerOnFirstLaunchIfNeeded() {
    let defaults = UserDefaults.standard
    if defaults.bool(forKey: didInitialRegisterKey) { return }
    setEnabled(true)
    defaults.set(true, forKey: didInitialRegisterKey)
  }
}
