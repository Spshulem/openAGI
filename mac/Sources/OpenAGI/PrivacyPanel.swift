import AppKit
import SwiftUI

// Capture privacy panel — opens as a separate window. SwiftUI form bound
// to CaptureSettings. Covers: master toggle, exclusions, retention, disk
// usage, wipe.

@MainActor
final class PrivacyWindowController {
  static let shared = PrivacyWindowController()
  private var window: NSWindow?

  func show() {
    if let win = window {
      win.makeKeyAndOrderFront(nil)
      NSApp.activate(ignoringOtherApps: true)
      return
    }
    let view = PrivacyPanel().frame(minWidth: 520, minHeight: 580)
    let host = NSHostingController(rootView: view)
    let win = NSWindow(contentViewController: host)
    win.title = "OpenAGI · Capture Privacy"
    win.styleMask = [.titled, .closable, .miniaturizable, .resizable]
    win.setContentSize(NSSize(width: 560, height: 620))
    win.center()
    win.isReleasedWhenClosed = false
    self.window = win
    win.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }
}

struct PrivacyPanel: View {
  @ObservedObject private var settings = CaptureSettings.shared
  @State private var stats: (frames: Int, activity: Int, diskBytes: Int) = (0, 0, 0)
  @State private var newBundleId: String = ""
  @State private var newPattern: String = ""
  @State private var statsTimer: Timer?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        header

        section(title: "Status") {
          HStack {
            Toggle("Capture enabled", isOn: $settings.enabled)
              .onChange(of: settings.enabled) { _, _ in CaptureController.shared.apply() }
            Spacer()
            if let until = settings.pausedUntil, Date() < until {
              Text("Paused until \(until.formatted(date: .omitted, time: .shortened))")
                .foregroundColor(.orange).font(.caption)
            }
          }
          HStack(spacing: 8) {
            Button("Pause 1h") { CaptureSettings.shared.pausedUntil = Date(timeIntervalSinceNow: 3600); CaptureController.shared.apply() }
            Button("Pause until tomorrow") { CaptureSettings.shared.pausedUntil = Date(timeIntervalSinceNow: 12 * 3600); CaptureController.shared.apply() }
            if settings.pausedUntil != nil {
              Button("Resume") { CaptureSettings.shared.pausedUntil = nil; CaptureController.shared.apply() }.foregroundColor(.green)
            }
            Spacer()
          }
        }

        section(title: "Frequency") {
          HStack {
            Text("Capture every")
            Slider(value: $settings.captureIntervalSeconds, in: 2...30, step: 1)
            Text("\(Int(settings.captureIntervalSeconds))s").monospacedDigit().frame(width: 40, alignment: .trailing)
          }
        }

        section(title: "Excluded apps") {
          Text("Frames from these app bundles are skipped before OCR runs.").font(.caption).foregroundColor(.secondary)
          ForEach(settings.excludedBundleIds, id: \.self) { id in
            HStack {
              Text(id).monospaced().font(.system(size: 12))
              Spacer()
              Button(role: .destructive) {
                settings.excludedBundleIds.removeAll { $0 == id }
              } label: { Image(systemName: "xmark.circle") }.buttonStyle(.borderless)
            }
          }
          HStack {
            TextField("com.example.SecretApp", text: $newBundleId)
            Button("Add") {
              let trimmed = newBundleId.trimmingCharacters(in: .whitespaces)
              if !trimmed.isEmpty && !settings.excludedBundleIds.contains(trimmed) {
                settings.excludedBundleIds.append(trimmed)
              }
              newBundleId = ""
            }.disabled(newBundleId.isEmpty)
          }
        }

        section(title: "Excluded window-title patterns (regex)") {
          ForEach(settings.excludedWindowPatterns, id: \.self) { pat in
            HStack {
              Text(pat).monospaced().font(.system(size: 12))
              Spacer()
              Button(role: .destructive) {
                settings.excludedWindowPatterns.removeAll { $0 == pat }
              } label: { Image(systemName: "xmark.circle") }.buttonStyle(.borderless)
            }
          }
          HStack {
            TextField("(?i)secret", text: $newPattern)
            Button("Add") {
              let trimmed = newPattern.trimmingCharacters(in: .whitespaces)
              if !trimmed.isEmpty && !settings.excludedWindowPatterns.contains(trimmed) {
                settings.excludedWindowPatterns.append(trimmed)
              }
              newPattern = ""
            }.disabled(newPattern.isEmpty)
          }
        }

        section(title: "Retention") {
          HStack {
            Text("Frames + thumbnails kept for")
            Stepper(value: $settings.frameRetentionDays, in: 1...90) {
              Text("\(settings.frameRetentionDays) days").monospacedDigit()
            }
          }
          HStack {
            Text("OCR text + activity kept for")
            Stepper(value: $settings.textRetentionDays, in: 7...365) {
              Text("\(settings.textRetentionDays) days").monospacedDigit()
            }
          }
        }

        section(title: "Storage") {
          HStack {
            stat("Frames", "\(stats.frames)")
            stat("Activity events", "\(stats.activity)")
            stat("Disk usage", formatBytes(stats.diskBytes))
          }
          HStack {
            Button(role: .destructive) {
              if confirmWipe() {
                CaptureController.shared.wipeAllCapturedData()
                refreshStats()
              }
            } label: { Text("Delete all captured data") }
          }
        }

        Spacer(minLength: 20)
      }
      .padding(20)
    }
    .onAppear { refreshStats(); startTimer() }
    .onDisappear { statsTimer?.invalidate() }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text("Capture privacy").font(.title2).bold()
      Text("Everything stays on this Mac. OCR runs locally via Vision. Excluded apps are never captured. The agent can summarize OCR text but never sends raw frames to any LLM.").font(.caption).foregroundColor(.secondary)
    }
  }

  private func section<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title.uppercased()).font(.caption2).foregroundColor(.secondary).tracking(1)
      content()
        .padding(12)
        .background(Color(NSColor.controlBackgroundColor))
        .cornerRadius(8)
    }
  }

  private func stat(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading) {
      Text(label).font(.caption).foregroundColor(.secondary)
      Text(value).font(.title3).bold().monospacedDigit()
    }.frame(maxWidth: .infinity, alignment: .leading)
  }

  private func formatBytes(_ b: Int) -> String {
    let kb = 1024.0, mb = kb * 1024, gb = mb * 1024
    let v = Double(b)
    if v >= gb { return String(format: "%.2f GB", v / gb) }
    if v >= mb { return String(format: "%.1f MB", v / mb) }
    if v >= kb { return String(format: "%.0f KB", v / kb) }
    return "\(b) B"
  }

  private func refreshStats() {
    stats = CaptureStorage.shared.stats()
  }

  private func startTimer() {
    statsTimer?.invalidate()
    statsTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
      Task { @MainActor in self.refreshStats() }
    }
  }

  private func confirmWipe() -> Bool {
    let alert = NSAlert()
    alert.messageText = "Delete all captured data?"
    alert.informativeText = "Removes all frames, thumbnails, OCR text, and activity events from this Mac. The daemon's pushed copy is not affected — clear that separately if needed."
    alert.alertStyle = .warning
    alert.addButton(withTitle: "Delete")
    alert.addButton(withTitle: "Cancel")
    return alert.runModal() == .alertFirstButtonReturn
  }
}
