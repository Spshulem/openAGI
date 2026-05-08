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

  var body: some View {
    Group {
      headerSection
      Divider()
      sessionsSection
      Divider()
      actionsSection
      Divider()
      footerSection
    }
  }

  // Status header
  private var headerSection: some View {
    Group {
      Text(statusLine).disabled(true)
      if let err = state.lastError {
        Text("⚠ \(err)").disabled(true).foregroundStyle(.red).lineLimit(3)
        Button("Show daemon log…") { revealDaemonLog() }
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
    if CaptureSettings.shared.enabled {
      return "Disable capture"
    }
    return "Enable capture (asks for permission)"
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
      Button(UpdateController.shared.isEnabled ? "Check for updates…" : "About auto-updates…") {
        UpdateController.shared.checkForUpdates()
      }
      Divider()
      Button("Quit OpenAGI") {
        DaemonController.shared.stop()
        NSApp.terminate(nil)
      }
    }
  }
}
