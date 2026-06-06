import SwiftUI

struct TrayLabel: View {
  @ObservedObject var state: AppState

  var body: some View {
    HStack(spacing: 2) {
      if let nsImage = TrayLabel.menuIcon {
        // NSImage marked isTemplate=true — macOS auto-recolors based on
        // dark/light menu bar tint, matching SF Symbol behavior.
        Image(nsImage: nsImage)
      } else {
        // Fallback only fires if MenuIcon.png is missing from the bundle.
        Image(systemName: "circle.dotted").renderingMode(.template)
      }
      // Tiny status dot to the right when something needs attention.
      switch state.status {
      case .healthy, .unknown:
        EmptyView()
      case .degraded:
        Image(systemName: "exclamationmark.triangle.fill").renderingMode(.template)
      case .down:
        Image(systemName: "xmark.octagon.fill").renderingMode(.template)
      }
    }
  }

  // Loaded once from the bundle; the size has to be set explicitly so the
  // menu bar gives it the standard ~18pt height instead of the source size.
  private static let menuIcon: NSImage? = {
    guard let url = Bundle.main.url(forResource: "MenuIcon", withExtension: "png"),
          let img = NSImage(contentsOf: url) else { return nil }
    img.isTemplate = true
    // Source is auto-cropped during build, so the full box is glyph.
    img.size = NSSize(width: 26, height: 26)
    return img
  }()
}

struct TrayMenu: View {
  @ObservedObject var state: AppState
  // Observe CaptureSettings.shared so the Capture submenu re-renders when
  // `enabled` or `pausedUntil` flips — otherwise after Disable the label
  // stays "Disable capture" until the menu is reopened.
  @ObservedObject var captureSettings: CaptureSettings = CaptureSettings.shared

  var body: some View {
    Group {
      headerSection
      Divider()
      tasksSection
      Divider()
      sessionsSection
      Divider()
      actionsSection
      Divider()
      footerSection
    }
  }

  // Top user tasks, today + this_week pending. "+ Add task" drops the user
  // into chat with a draft message so they can describe the task in natural
  // language and the agent's add_task tool routes it. Top-task entries +
  // "View all" still go to the Tasks tab for the structured view.
  @ViewBuilder private var tasksSection: some View {
    if state.topTasks.isEmpty {
      Text("No pending tasks").disabled(true).font(.caption)
    } else {
      Text("Top tasks").disabled(true).font(.caption)
      ForEach(state.topTasks) { t in
        Button(taskLabel(t)) { state.openDashboard(path: "/?tab=tasks") }
      }
      Button("View all tasks…") { state.openDashboard(path: "/?tab=tasks") }
    }
    Button("+ Add task…") { state.openDashboard(path: "/?tab=chat&compose=add-task") }
  }

  private func taskLabel(_ t: AppState.TaskSummary) -> String {
    let prefix: String = {
      switch t.bucket {
      case "today": return "● "
      case "this_week": return "○ "
      default: return "  "
      }
    }()
    let trim = t.title.count > 60 ? String(t.title.prefix(60)) + "…" : t.title
    return prefix + trim
  }

  // Status header
  private var headerSection: some View {
    Group {
      Text(statusLine).disabled(true)
      if let err = state.lastError {
        Text("⚠ \(err)").disabled(true).foregroundStyle(.red).lineLimit(3)
        Button("Show daemon log…") { revealDaemonLog() }
      }
      // When daemon is down or degraded, the restart action moves up
      // here next to the error so it's discoverable without scrolling.
      if state.status == .down || state.status == .degraded {
        Button(state.status == .down ? "↻ Restart daemon" : "↻ Restart daemon (recover)") {
          DaemonController.shared.restart()
        }
      }
      if state.providerConfigured {
        Text("Model: \(state.providerName)").disabled(true)
      } else {
        Button("Open setup wizard…") { state.openDashboard(path: "/setup") }
      }
      Text("Today: $\(formatUsd(state.spentToday)) / $\(formatUsd(state.spentLimit))")
        .disabled(true)
      Text("Memory · short \(state.memoryShort) · medium \(state.memoryMedium) · long \(state.memoryLong)")
        .disabled(true)
    }
  }

  private func revealDaemonLog() {
    let path = AppState.dataDir().appendingPathComponent("daemon.log")
    NSWorkspace.shared.open([path], withApplicationAt: URL(fileURLWithPath: "/System/Applications/Utilities/Console.app"), configuration: NSWorkspace.OpenConfiguration()) { _, error in
      if error != nil {
        // Fallback: reveal in Finder
        NSWorkspace.shared.activateFileViewerSelecting([path])
      }
    }
  }

  private var statusLine: String {
    switch state.status {
    case .healthy: return "● online"
    case .degraded: return "● needs attention"
    case .down: return "● daemon offline"
    case .unknown: return "● connecting…"
    }
  }

  private func formatUsd(_ v: Double) -> String { String(format: "%.2f", v) }

  // Recent sessions
  @ViewBuilder private var sessionsSection: some View {
    if state.recentSessions.isEmpty {
      Text("No recent sessions").disabled(true)
    } else {
      Text("Recent activity").disabled(true).font(.caption)
      ForEach(state.recentSessions) { s in
        Button(truncate(s.lastMessage, 50)) {
          state.openDashboard(path: "/?session=\(s.sessionId)")
        }
      }
    }
  }

  private func truncate(_ s: String, _ n: Int) -> String {
    s.count > n ? String(s.prefix(n)) + "…" : s
  }

  // Pause / dashboard / audit / settings
  private var actionsSection: some View {
    Group {
      Button(state.paused ? "Resume agent" : "Pause agent") {
        Task { await state.togglePause() }
      }
      Button("Open dashboard…") { state.openDashboard() }
      Button("Open health audit…") { state.openDashboard(path: "/?tab=health") }
      Button("Open activity log…") { state.openDashboard(path: "/?tab=activity") }
      Button("Settings…") { state.openDashboard(path: "/setup") }
      Button("Copy auth token") { copyAuthToken() }

      Divider()
      Menu("Capture") {
        Button(captureLabel()) { CaptureController.shared.toggleEnabled() }
        Button("Pause for 1 hour") { CaptureController.shared.togglePause(durationHours: 1) }
        Button("Pause until tomorrow") { CaptureController.shared.togglePause(durationHours: 12) }
        if CaptureSettings.shared.pausedUntil != nil {
          Button("Resume capture") { CaptureSettings.shared.pausedUntil = nil; CaptureController.shared.apply() }
        }
        Divider()
        Button("Privacy settings…") { PrivacyWindowController.shared.show() }
      }
    }
  }

  private func captureLabel() -> String {
    // Read through the @ObservedObject so SwiftUI knows to rebuild the
    // menu when CaptureSettings.shared.enabled changes. captureSettings
    // and CaptureSettings.shared are the same instance.
    if captureSettings.enabled {
      return "Disable capture"
    }
    return "Resume capture"
  }

  private func copyAuthToken() {
    guard let token = state.authToken(), !token.isEmpty else { return }
    let pb = NSPasteboard.general
    pb.clearContents()
    pb.setString(token, forType: .string)
  }

  // Updates / quit
  private var footerSection: some View {
    Group {
      if !state.findings.isEmpty {
        Text("⚠ \(state.findings.count) finding(s)").disabled(true).font(.caption)
      }
      Text("OpenAGI \(Self.versionString)").disabled(true).font(.caption)
      Button(UpdateController.shared.isEnabled ? "Check for updates…" : "About auto-updates…") {
        UpdateController.shared.checkForUpdates()
      }
      Button("Quick Ask  ⌥Space") { OverlayController.shared.toggle() }
      Toggle("Enable Quick Ask", isOn: Binding(
        get: { OverlayController.isEnabled },
        set: { OverlayController.setEnabled($0) }
      ))
      Toggle("Open at Login", isOn: Binding(
        get: { LoginItem.isEnabled },
        set: { LoginItem.setEnabled($0) }
      ))
      Divider()
      Button("Quit OpenAGI") {
        DaemonController.shared.stop()
        NSApp.terminate(nil)
      }
    }
  }

  // Bundle short version + build number, stamped by build-mac-app.sh.
  // Shown in the menu so it's never ambiguous which build is running
  // (especially useful when alternating between local dev builds and
  // the released .dmg from /Applications).
  private static let versionString: String = {
    let info = Bundle.main.infoDictionary
    let v = (info?["CFBundleShortVersionString"] as? String) ?? "?"
    let b = (info?["CFBundleVersion"] as? String) ?? ""
    return b.isEmpty || b == "__BUILD__" ? "v\(v)" : "v\(v) (\(b))"
  }()
}
