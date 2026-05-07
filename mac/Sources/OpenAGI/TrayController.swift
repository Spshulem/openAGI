import SwiftUI

struct TrayLabel: View {
  @ObservedObject var state: AppState

  var body: some View {
    let symbol: String
    switch state.status {
    case .healthy: symbol = "circle.fill"
    case .degraded: symbol = "exclamationmark.triangle.fill"
    case .down: symbol = "xmark.octagon.fill"
    case .unknown: symbol = "circle.dotted"
    }
    return Image(systemName: symbol)
      .renderingMode(.template)
  }
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
      Button("Settings…") { state.openDashboard(path: "/setup") }
    }
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
