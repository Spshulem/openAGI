import AppKit
import Foundation
import UserNotifications

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  // Singletons accessed directly per-call so non-isolated delegate methods
  // don't have to capture main-actor-isolated stored properties.

  nonisolated func applicationDidFinishLaunching(_ notification: Notification) {
    Task { @MainActor in
      NSApp.setActivationPolicy(.accessory) // No Dock icon, only menubar.

      UNUserNotificationCenter.current().delegate = self
      UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }

      DaemonController.shared.start()
      AppState.shared.startPolling()
      AppState.shared.startSSE()
      UpdateController.shared.start()
    }
  }

  nonisolated func applicationWillTerminate(_ notification: Notification) {
    DaemonController.shared.stop()
  }

  // Tap a notification → open the dashboard, deep-linked when possible.
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let info = response.notification.request.content.userInfo
    let path = info["path"] as? String ?? "/"
    Task { @MainActor in
      AppState.shared.openDashboard(path: path)
      completionHandler()
    }
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound])
  }
}
