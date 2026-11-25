import AppKit
import Foundation
import SupervisorChannelsKit
import UserNotifications

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
  // Singletons accessed directly per-call so non-isolated delegate methods
  // don't have to capture main-actor-isolated stored properties.

  nonisolated func applicationDidFinishLaunching(_ notification: Notification) {
    Task { @MainActor in
      Self.applyActivationPolicy(showsInDock: AppState.shared.showsInDock)
      Self.installMainMenuIfNeeded(target: self)

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

      LegacyLaunchAgentCleanup.run()
      DaemonController.shared.start()
      AppState.shared.startPolling()
      AppState.shared.startSSE()
      UpdateController.shared.start()
      CaptureController.shared.start()
      ReplayController.shared.start()
      OverlayController.shared.startIfEnabled()
      HotkeyManager.shared.onHotkey = { OverlayController.shared.toggle() }
      HotkeyManager.shared.onVoicePressed = { OverlayState.shared.beginVoice(.hotkey) }
      HotkeyManager.shared.onVoiceReleased = { VoiceSession.shared.release(.hotkey) }
      HotkeyManager.shared.register()

      // Support and automated verification need a deterministic way to open
      // the native permission/retention surface in this dockless menu-bar app.
      // `open OpenAGI.app --args --show-permissions` does not change a setting;
      // it only reveals the same panel as the tray-menu item.
      if ProcessInfo.processInfo.arguments.contains("--show-permissions") {
        PrivacyWindowController.shared.show()
      }

      // Local launch intent reveals the same native flow as the menu item,
      // so support can verify the packaged app even when the tray is hidden.
      let args = ProcessInfo.processInfo.arguments
      if args.contains("--connect-phone") {
        PhonePairingWindowController.shared.show(state: AppState.shared)
      }
      if args.contains("--show-supervisor") {
        SupervisorWindowController.shared.show()
      } else if AppState.shared.showsInDock,
                !args.contains("--show-permissions"),
                !args.contains("--connect-phone"),
                !args.contains("--background") {
        SupervisorWindowController.shared.show()
      }

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
      VoiceSession.shared.stop()
    }
  }

  // Finder/Spotlight can reopen a running dockless app even when its menu-bar
  // item is hidden by the notch. Reveal Supervisor Workspace (or Privacy when requested).
  nonisolated func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    Task { @MainActor in
      if ProcessInfo.processInfo.arguments.contains("--show-permissions") {
        PrivacyWindowController.shared.show()
      } else {
        SupervisorWindowController.shared.show()
      }
    }
    return false
  }

  nonisolated func application(_ application: NSApplication, open urls: [URL]) {
    if urls.contains(where: AppLink.opensSupervisor) {
      Task { @MainActor in SupervisorWindowController.shared.show() }
      return
    }
    guard urls.contains(where: AppLink.opensPrivacy) else { return }
    Task { @MainActor in PrivacyWindowController.shared.show() }
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

  nonisolated func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    false
  }

  func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
    let menu = NSMenu(title: "OpenAGI")
    let waitingCount = Self.needsYouWaitingCount
    let needsTitle = waitingCount > 0 ? "Needs You (\(waitingCount))" : "Needs You"
    let items: [(String, Selector)] = [
      ("Open Supervisor Workspace", #selector(openWorkspaceFromMenu)),
      (needsTitle, #selector(openNeedsYouFromMenu)),
      ("Tasks", #selector(openTasksFromMenu)),
      ("Sessions", #selector(openSessionsFromMenu)),
    ]
    for (title, action) in items {
      let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
      item.target = self
      menu.addItem(item)
    }
    menu.addItem(.separator())
    let quickAsk = NSMenuItem(title: "Quick Ask  ⌥Space", action: #selector(toggleQuickAskFromMenu), keyEquivalent: "")
    quickAsk.target = self
    menu.addItem(quickAsk)
    let scan = NSMenuItem(title: "Scan Coding Agents", action: #selector(scanFleetFromMenu), keyEquivalent: "")
    scan.target = self
    menu.addItem(scan)
    return menu
  }

  static func applyActivationPolicy(showsInDock: Bool) {
    guard let app = NSApp else { return }
    app.setActivationPolicy(showsInDock ? .regular : .accessory)
    if showsInDock {
      updateDockBadge(count: needsYouWaitingCount)
    } else {
      app.dockTile.badgeLabel = nil
    }
  }

  /// Needs You's one number, as the workspace sidebar shows it: actionable
  /// decisions plus pending tool approvals, never FYIs or completions.
  static var needsYouWaitingCount: Int {
    SupervisorAttentionCounting.needsYouTotal(
      needsYouFlags: FleetConsumer.shared.questions.map(\.needsYou),
      pendingApprovals: PendingApprovalConsumer.shared.items.count
    )
  }

  static func updateDockBadge(count: Int) {
    guard let app = NSApp else { return }
    app.dockTile.badgeLabel = (AppState.shared.showsInDock && count > 0) ? "\(count)" : nil
  }

  @objc private func openWorkspaceFromMenu() { SupervisorWindowController.shared.show(channel: nil) }
  @objc private func openGeneralFromMenu() { SupervisorWindowController.shared.show(channel: .general) }
  @objc private func openNeedsYouFromMenu() { SupervisorWindowController.shared.show(channel: .needsYou) }
  @objc private func openTasksFromMenu() { SupervisorWindowController.shared.show(channel: .tasks) }
  @objc private func openSessionsFromMenu() { SupervisorWindowController.shared.show(channel: .sessions) }
  @objc private func toggleQuickAskFromMenu() { OverlayController.shared.toggle() }
  @objc private func scanFleetFromMenu() { Task { await FleetConsumer.shared.scan() } }
  @objc private func checkUpdatesFromMenu() { UpdateController.shared.checkForUpdates() }
  @objc private func openPrivacyFromMenu() { PrivacyWindowController.shared.show() }
  @objc private func connectPhoneFromMenu() { PhonePairingWindowController.shared.show(state: AppState.shared) }

  static func installMainMenuIfNeeded(target: AppDelegate) {
    guard let app = NSApp else { return }
    if let existing = app.mainMenu, existing.items.count >= 5 { return }

    let mainMenu = NSMenu()

    let appRoot = NSMenuItem()
    let appMenu = NSMenu(title: "OpenAGI")
    appMenu.addItem(withTitle: "About OpenAGI", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
    let checkUpdates = NSMenuItem(title: "Check for Updates…", action: #selector(checkUpdatesFromMenu), keyEquivalent: "")
    checkUpdates.target = target
    appMenu.addItem(checkUpdates)
    appMenu.addItem(.separator())
    let privacy = NSMenuItem(title: "Permissions & Privacy…", action: #selector(openPrivacyFromMenu), keyEquivalent: ",")
    privacy.target = target
    appMenu.addItem(privacy)
    let pair = NSMenuItem(title: "Connect a Phone…", action: #selector(connectPhoneFromMenu), keyEquivalent: "")
    pair.target = target
    appMenu.addItem(pair)
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Hide OpenAGI", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    let hideOthers = NSMenuItem(title: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
    hideOthers.keyEquivalentModifierMask = [.command, .option]
    appMenu.addItem(hideOthers)
    appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Quit OpenAGI", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appRoot.submenu = appMenu
    mainMenu.addItem(appRoot)

    let fileRoot = NSMenuItem()
    let fileMenu = NSMenu(title: "File")
    let openWs = NSMenuItem(title: "Open Supervisor Workspace", action: #selector(openWorkspaceFromMenu), keyEquivalent: "0")
    openWs.target = target
    fileMenu.addItem(openWs)
    fileMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    fileRoot.submenu = fileMenu
    mainMenu.addItem(fileRoot)

    let editRoot = NSMenuItem()
    let editMenu = NSMenu(title: "Edit")
    editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    let redo = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    redo.keyEquivalentModifierMask = [.command, .shift]
    editMenu.addItem(redo)
    editMenu.addItem(.separator())
    editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editRoot.submenu = editMenu
    mainMenu.addItem(editRoot)

    let viewRoot = NSMenuItem()
    let viewMenu = NSMenu(title: "View")
    let viewChannels: [(String, Selector, String)] = [
      ("General", #selector(openGeneralFromMenu), "1"),
      ("Needs You", #selector(openNeedsYouFromMenu), "2"),
      ("Tasks", #selector(openTasksFromMenu), "3"),
      ("Sessions", #selector(openSessionsFromMenu), "4")
    ]
    for (title, sel, key) in viewChannels {
      let item = NSMenuItem(title: title, action: sel, keyEquivalent: key)
      item.target = target
      viewMenu.addItem(item)
    }
    viewMenu.addItem(.separator())
    let scanItem = NSMenuItem(title: "Scan Coding Agents", action: #selector(scanFleetFromMenu), keyEquivalent: "r")
    scanItem.target = target
    viewMenu.addItem(scanItem)
    let quickAskItem = NSMenuItem(title: "Quick Ask", action: #selector(toggleQuickAskFromMenu), keyEquivalent: "")
    quickAskItem.target = target
    viewMenu.addItem(quickAskItem)
    viewRoot.submenu = viewMenu
    mainMenu.addItem(viewRoot)

    let windowRoot = NSMenuItem()
    let windowMenu = NSMenu(title: "Window")
    windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
    windowMenu.addItem(.separator())
    let bringWs = NSMenuItem(title: "Supervisor Workspace", action: #selector(openWorkspaceFromMenu), keyEquivalent: "")
    bringWs.target = target
    windowMenu.addItem(bringWs)
    windowMenu.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
    windowRoot.submenu = windowMenu
    mainMenu.addItem(windowRoot)

    app.mainMenu = mainMenu
    app.windowsMenu = windowMenu
  }
}
