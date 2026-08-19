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
      // Register outreach categories (inline action buttons) up front so any
      // banner that lands carries its buttons. AppDelegate stays the single
      // notification-center delegate; outreach actions are routed through it
      // (see userNotificationCenter(_:didReceive:)) rather than swapping the
      // delegate, so existing path-deeplink handling is preserved.
      NotificationPresenter.shared.registerCategories()
      // Fire-and-forget: requesting notification auth shows a system prompt the
      // user may sit on — don't block daemon/UI startup waiting for their answer.
      Task { _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) }

      LoginItem.registerOnFirstLaunchIfNeeded()
      _ = AppState.sourceMachineId()

      DaemonController.shared.start()
      AppState.shared.startPolling()
      AppState.shared.startSSE()
      UpdateController.shared.start()
      CaptureController.shared.start()
      ReplayController.shared.start()
      OverlayController.shared.startIfEnabled()
      HotkeyManager.shared.onHotkey = { OverlayController.shared.toggle() }
      HotkeyManager.shared.register()

      // Start the durable outreach consumer if a remote main is configured.
      // Backfills from the persisted cursor so nothing queued while the app was
      // closed is lost.
      if !AppState.shared.outreachRemoteURL.isEmpty {
        OutreachConsumer.shared.reconfigure(
          url: AppState.shared.outreachRemoteURL,
          token: AppState.shared.outreachToken)
      }

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
    // Stop the child synchronously while AppKit is still keeping this process
    // alive. Cleanup below crosses an await and is not guaranteed to finish
    // before termination; putting stop() inside that Task orphaned the daemon.
    DaemonController.shared.stopForApplicationTermination()
    Task { @MainActor in
      ReplayController.shared.stop()
      CaptureController.shared.stop()
      // Unpushed observations remain in local SQLite and retry next launch.
      // A quit-time network flush is not reliable here: this Task does not
      // extend process lifetime, and the local daemon has already been stopped.
      OverlayController.shared.persistPosition()
      HotkeyManager.shared.unregister()
    }
  }

  // Tap a notification → open the dashboard, deep-linked when possible.
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    // Outreach notifications carry an "outreachId" and (for buttons) route to
    // the remote main. Handle them first; only fall through to the legacy
    // path-deeplink behavior for non-outreach notifications.
    if NotificationPresenter.isOutreachResponse(response) {
      Task { @MainActor in
        _ = NotificationPresenter.shared.handleAction(response)
        completionHandler()
      }
      return
    }

    // A scheduled Sparkle check for this dockless app uses a Notification
    // Center reminder. Clicking it must foreground Sparkle's update UI, not
    // fall through to the dashboard deep-link path below.
    if UpdateController.isUpdateNotification(response) {
      Task { @MainActor in
        UpdateController.shared.handleUpdateNotificationTap()
        completionHandler()
      }
      return
    }

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
