import AppKit
import Foundation

// Lightweight activity stream — NSWorkspace app activations + periodic
// frontmost window-title polls via Accessibility API. No screen recording,
// no keystroke access; only the same data shown in Mission Control.

@MainActor
final class ActivityTracker {
  static let shared = ActivityTracker()

  private var observer: NSObjectProtocol?
  private var pollTimer: Timer?
  private var lastApp: String?
  private var lastWindow: String?

  func start() {
    if observer != nil { return }
    let center = NSWorkspace.shared.notificationCenter
    observer = center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
      guard let self else { return }
      let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
      Task { @MainActor in self.handleAppFocus(bundleId: app?.bundleIdentifier, name: app?.localizedName) }
    }
    pollTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.pollFrontmostWindow() }
    }
    pollFrontmostWindow()
  }

  func stop() {
    if let observer { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
    observer = nil
    pollTimer?.invalidate()
    pollTimer = nil
  }

  private func handleAppFocus(bundleId: String?, name: String?) {
    guard CaptureSettings.shared.isActiveNow() else { return }
    let app = bundleId ?? name ?? "(unknown)"
    let title = frontmostWindowTitle()
    if CaptureSettings.shared.isExcluded(bundleId: bundleId, windowTitle: title) {
      lastApp = app
      lastWindow = nil
      return
    }
    if app == lastApp && title == lastWindow { return }
    lastApp = app
    lastWindow = title
    CaptureStorage.shared.recordActivity(at: Date(), app: app, window: title, event: "focus")
  }

  private func pollFrontmostWindow() {
    guard CaptureSettings.shared.isActiveNow() else { return }
    let app = NSWorkspace.shared.frontmostApplication
    handleAppFocus(bundleId: app?.bundleIdentifier, name: app?.localizedName)
  }

  // Read the active window's title via Accessibility. Returns nil when
  // permission isn't granted (graceful degradation — we just record app focus).
  private func frontmostWindowTitle() -> String? {
    guard AXIsProcessTrusted() else { return nil }
    let frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    if frontPid == 0 { return nil }
    let appElement = AXUIElementCreateApplication(frontPid)
    var window: AnyObject?
    if AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &window) == .success,
       let win = window {
      var title: AnyObject?
      if AXUIElementCopyAttributeValue(win as! AXUIElement, kAXTitleAttribute as CFString, &title) == .success {
        return title as? String
      }
    }
    return nil
  }
}
