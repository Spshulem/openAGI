import AppKit
import Foundation

// Top-level capture lifecycle. Watches CaptureSettings for changes; toggles
// the screen capturer, activity tracker, and bridge accordingly. Owns a
// retention timer that runs prune() once a day.

@MainActor
final class CaptureController {
  static let shared = CaptureController()

  private var retentionTimer: Timer?
  private var settingsObservation: NSKeyValueObservation?

  func start() {
    // Resume-without-relaunch: when Screen Recording flips from absent to
    // granted (the user finally turned it on in System Settings), re-apply so
    // the capture timer comes back on its own. The detection is an activation
    // notification plus a non-prompting preflight — see CapturePermissions.
    CapturePermissions.shared.onScreenRecordingGranted = { [weak self] in
      NSLog("OpenAGI capture: Screen Recording granted — resuming capture")
      self?.apply()
    }
    apply()
    retentionTimer = Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { [weak self] _ in
      guard let self else { return }
      Task { @MainActor in self.runRetention() }
    }
    runRetention()
  }

  func stop() {
    if #available(macOS 12.3, *) { ScreenCapturer.shared.stop() }
    ActivityTracker.shared.stop()
    CapturePermissions.shared.stopWatchingForGrant()
    CaptureBridge.shared.stop()
    retentionTimer?.invalidate()
    retentionTimer = nil
  }

  /// Read current settings and start/stop subsystems accordingly.
  func apply() {
    let active = CaptureSettings.shared.isActiveNow()
    if active {
      ActivityTracker.shared.start()
      if #available(macOS 12.3, *) { ScreenCapturer.shared.start() }
      CaptureBridge.shared.start()
    } else {
      ActivityTracker.shared.stop()
      if #available(macOS 12.3, *) { ScreenCapturer.shared.stop() }
      // Capture is off by the user's own choice — stop listening for a
      // permission grant we no longer need (nothing to resume).
      CapturePermissions.shared.stopWatchingForGrant()
      // Keep bridge running so already-captured items still flush.
      CaptureBridge.shared.start()
    }
  }

  func runRetention() {
    let frameDays = max(1, CaptureSettings.shared.frameRetentionDays)
    let textDays = max(frameDays, CaptureSettings.shared.textRetentionDays)
    let frameCutoff = Date(timeIntervalSinceNow: -Double(frameDays) * 86400)
    let textCutoff = Date(timeIntervalSinceNow: -Double(textDays) * 86400)
    CaptureStorage.shared.prune(framesOlderThan: frameCutoff, textOlderThan: textCutoff)
  }

  func togglePause(durationHours: Double?) {
    if let hours = durationHours {
      CaptureSettings.shared.pausedUntil = Date(timeIntervalSinceNow: hours * 3600)
    } else if CaptureSettings.shared.pausedUntil != nil {
      CaptureSettings.shared.pausedUntil = nil
    } else {
      CaptureSettings.shared.pausedUntil = Date(timeIntervalSinceNow: 24 * 3600)
    }
    apply()
  }

  func toggleEnabled() {
    CaptureSettings.shared.enabled.toggle()
    apply()
  }

  func wipeAllCapturedData() {
    CaptureStorage.shared.wipeAll()
  }
}
