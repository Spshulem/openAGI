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
  @ObservedObject private var permissions = CapturePermissions.shared
  @State private var stats: (frames: Int, activity: Int, diskBytes: Int) = (0, 0, 0)
  @State private var newBundleId: String = ""
  @State private var newPattern: String = ""
  @State private var statsTimer: Timer?

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        header

        permissionsSection

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
          // decideCapture() runs bundleIdIsExcluded over EVERY window on the
          // display, so this is per-window, not just the front app. What it
          // still cannot do is see a URL: users assume "1Password is excluded"
          // generalizes to "my bank is excluded", and it does not.
          Text("Windows belonging to these apps are cut out of the picture before the screenshot is taken — including when they are only sitting beside what you're working on. Matching ignores case and covers an app's helpers (com.1password also covers com.1password.browser-helper). It is a bundle-ID list, so a website can't be listed here: a banking site in a browser tab is not recognised as one.").font(.caption).foregroundColor(.secondary)
            .fixedSize(horizontal: false, vertical: true)
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
          Text("Matched against every on-screen window's title, always case-insensitively, and a matching window is cut out of the picture. If no window title can be read at all, capture skips that moment and says so rather than capturing something it couldn't check.").font(.caption).foregroundColor(.secondary)
            .fixedSize(horizontal: false, vertical: true)
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

  // macOS permission state. Screen capture is dead without Screen Recording,
  // and macOS will NOT ask again once the user has answered — every later
  // request is a silent no-op — so the only honest UI is: say it's off, say
  // why, and hand the user a link straight to the right Settings pane.
  // Granting there resumes capture on its own (no relaunch): CapturePermissions
  // re-checks with the non-prompting preflight when the app is next activated.
  private var permissionsSection: some View {
    section(title: "macOS permissions") {
      permissionRow(
        name: "Screen Recording",
        granted: permissions.screenRecordingGranted,
        // Do NOT promise automatic resume. The grant is observed by re-running
        // the non-prompting preflight when the app is activated, and macOS does
        // not reliably report a fresh grant to an already-running process — the
        // preflight can keep reading "denied" until relaunch. Telling the user
        // it "resumes automatically" and then leaving capture off is exactly the
        // kind of confident-but-wrong claim this panel exists to eliminate.
        detail: permissions.screenRecordingGranted
          ? "Screen frames + OCR are running."
          : "Screen capture is OFF. macOS won't ask again — turn it on in System Settings, then switch back here. If it still says OFF, quit and reopen OpenAGI.",
        action: { permissions.openScreenRecordingSettings() })

      permissionRow(
        name: "Accessibility",
        granted: permissions.accessibilityGranted,
        // frontmostWindowTitle() is gated on AXIsProcessTrusted(), so without
        // Accessibility the ACTIVITY LOG loses window titles. Capture-time
        // exclusions are unaffected: decideCapture() reads titles from the
        // ScreenCaptureKit window list, and skips the capture outright when no
        // title anywhere is readable. Say which of the two this permission is.
        detail: permissions.accessibilityGranted
          ? "Window titles are recorded alongside app names."
          : "Optional. Without it, activity is recorded with app names but no window titles. Window-title exclusions still apply during capture — those titles come from the window list, not Accessibility.",
        action: { permissions.openAccessibilitySettings() })

      if let failure = permissions.lastCaptureFailure {
        Text("⚠ \(failure)")
          .font(.caption)
          .foregroundColor(.orange)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private func permissionRow(name: String, granted: Bool, detail: String, action: @escaping () -> Void) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        Image(systemName: granted ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
          .foregroundColor(granted ? .green : .orange)
        Text(name).bold()
        Text(granted ? "Granted" : "Not granted")
          .font(.caption)
          .foregroundColor(granted ? .secondary : .orange)
        Spacer()
        Button("Open System Settings…", action: action)
      }
      Text(detail)
        .font(.caption)
        .foregroundColor(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text("Capture privacy").font(.title2).bold()
      // Consent copy. Every sentence here has to survive a reading of the code,
      // because this is what the user weighs before granting Screen Recording.
      // The images/text split is the part people get wrong: CaptureBridge pushes
      // app + window + OCR text and no image bytes, while agent-host.js splices
      // OCR snippets (with window titles) into prompts for the configured model
      // provider — on chat turns AND unattended, from the proactive observer.
      Text("Screenshots are OCR'd on this Mac by Apple's Vision framework. The frames and thumbnails stay here — they are never uploaded and never sent to a model.")
        .font(.caption).foregroundColor(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      Text("The text is different. OCR text and window titles are stored by the daemon, and short excerpts are sent to your model provider — when you ask the agent something, and when its background observers run on their own every few minutes. The exclusion lists below are what keep text out of it.")
        .font(.caption).foregroundColor(.secondary)
        .fixedSize(horizontal: false, vertical: true)
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
    // Non-prompting re-read (CGPreflightScreenCaptureAccess / AXIsProcessTrusted)
    // so the rows update live while the panel is open and the user is toggling
    // switches in System Settings. Never touches a capture API.
    permissions.refresh()
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
