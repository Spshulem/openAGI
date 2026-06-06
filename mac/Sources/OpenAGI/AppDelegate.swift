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

      LoginItem.registerOnFirstLaunchIfNeeded()

      DaemonController.shared.start()
      AppState.shared.startPolling()
      AppState.shared.startSSE()
      UpdateController.shared.start()
      CaptureController.shared.start()
      ReplayController.shared.start()
      OverlayController.shared.startIfEnabled()
      HotkeyManager.shared.onHotkey = { OverlayController.shared.toggle() }
      HotkeyManager.shared.register()

      // Wake observer: the moment macOS resumes from sleep we (1) probe
      // /health to see if the daemon survived the sleep cycle, restart
      // it if not, and (2) POST /tick so any cron jobs that were due
      // during the sleep window run within ~1s of wake instead of waiting
      // up to OPENAGI_TICKER_MS for the resumed setInterval.
      NSWorkspace.shared.notificationCenter.addObserver(
        forName: NSWorkspace.didWakeNotification,
        object: nil,
        queue: .main
      ) { _ in
        Task { @MainActor in
          NSLog("OpenAGI: system woke — checking daemon health")
          let alive = await DaemonController.shared.probeHealth()
          if !alive {
            NSLog("OpenAGI: daemon didn't survive sleep — restarting")
            DaemonController.shared.restart()
          } else {
            await DaemonController.shared.kickTick()
          }
        }
      }
    }
  }

  nonisolated func applicationWillTerminate(_ notification: Notification) {
    Task { @MainActor in
      ReplayController.shared.stop()
      CaptureController.shared.stop()
      _ = await CaptureBridge.flushNow()
      OverlayController.shared.persistPosition()
      HotkeyManager.shared.unregister()
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
