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
      CaptureController.shared.start()
      ReplayController.shared.start()

      // Wake observer: the moment macOS resumes from sleep we POST /tick
      // so any cron jobs that were due during the sleep window run within
      // ~1s of wake instead of waiting up to OPENAGI_TICKER_MS for the
      // resumed setInterval to fire.
      NSWorkspace.shared.notificationCenter.addObserver(
        forName: NSWorkspace.didWakeNotification,
        object: nil,
        queue: .main
      ) { _ in
        Task { @MainActor in
          NSLog("OpenAGI: system woke — kicking daemon to run any missed cron jobs")
          await DaemonController.shared.kickTick()
        }
      }
    }
  }

  nonisolated func applicationWillTerminate(_ notification: Notification) {
    Task { @MainActor in
      ReplayController.shared.stop()
      CaptureController.shared.stop()
      _ = await CaptureBridge.flushNow()
      DaemonController.shared.stop()
    }
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
