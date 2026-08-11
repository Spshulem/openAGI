import AppKit
import Foundation
import ScreenCaptureKit
import Vision

// Periodic screen captures via ScreenCaptureKit + on-device OCR via Vision.
// Each captured frame:
//   1. Is OCR'd locally (no network).
//   2. Thumbnail JPEG written to ~/Library/Application Support/OpenAGI/capture/thumbnails/<uid>.jpg
//   3. Metadata + OCR text inserted into CaptureStorage for later push to daemon.
//
// Capture is gated by CaptureSettings.isActiveNow() and the per-frame
// exclusion check (so private windows / banking sites are skipped before
// OCR runs).
//
// EXCLUSIONS ARE PER-WINDOW, NOT PER-FRONTMOST-APP. Checking only the frontmost
// app and then grabbing the display with `excludingWindows: []` is the bug this
// file used to have: 1Password, Messages or a banking tab merely VISIBLE beside
// the focused window was captured and OCR'd every 5 seconds. Every capture path
// here now runs the same CaptureSettings.decideCapture() over the full window
// list — see exclusionDecision(for:) — and honours its .skip verdict, which is
// what fires when the screen cannot be evaluated at all.

struct ScreenContext {
  let app: String
  let window: String?
  let text: String
}

@MainActor
final class ScreenCapturer {
  static let shared = ScreenCapturer()

  private var timer: Timer?
  private var capturing = false
  /// Consecutive SCK failures while the preflight still claims we're granted.
  /// Bounds the damage if TCC state and the capture daemon ever disagree —
  /// we shut the timer down instead of retrying (and possibly re-prompting)
  /// forever. Reset on every success.
  private var consecutiveFailures = 0
  private static let maxConsecutiveFailures = 3
  /// Last fail-closed skip reason, so the log records a change of state rather
  /// than the same line every 5 seconds.
  private var lastSkipReason: String?
  private let ocrQueue = DispatchQueue(label: "openagi.capture.ocr")
  private var thumbnailsDir: URL {
    let dir = CaptureSettings.captureDir.appendingPathComponent("thumbnails", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  func start() {
    stop()
    // PERMISSION GATE — see CapturePermissions for the full why. Short version:
    // SCShareableContent / SCScreenshotManager PROMPT when Screen Recording is
    // missing, so we must never reach them to discover that it's missing.
    // CGPreflightScreenCaptureAccess() (via refreshScreenRecording) is the
    // non-prompting question; it is the only correct way to ask.
    guard CapturePermissions.shared.refreshScreenRecording() else {
      // No permission: schedule NOTHING. A timer that ticks into an early
      // return is the same bug with the dialog hidden — it burns a wakeup every
      // N seconds and buries the reason capture is dead. Give startup a bounded
      // series of non-prompting preflight retries, then request only for a code
      // identity that has never been granted or automatically asked before.
      CapturePermissions.shared.noteCaptureFailure(
        "Screen Recording permission is not granted — screen capture is off.")
      CapturePermissions.shared.scheduleAutomaticScreenRecordingRequestIfNeeded()
      CapturePermissions.shared.beginWatchingForGrant()
      NSLog("OpenAGI capture: Screen Recording not granted — capture timer not scheduled")
      return
    }
    // The gate above is also where an absent -> granted transition is noticed,
    // and that fires the resume hook, which re-enters start() through
    // CaptureController.apply(). Drop whatever that nested call scheduled so
    // exactly one capture timer survives (two would double the capture rate).
    stop()
    CapturePermissions.shared.noteCaptureFailure(nil)
    consecutiveFailures = 0
    let interval = max(2.0, CaptureSettings.shared.captureIntervalSeconds)
    timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
      guard let self else { return }
      Task { @MainActor in await self.captureOnce() }
    }
  }

  func stop() {
    timer?.invalidate()
    timer = nil
  }

  func captureOnce() async {
    if !CaptureSettings.shared.isActiveNow() { return }
    // Re-gate on every tick with the non-prompting preflight: the user can
    // revoke Screen Recording in System Settings while we're running, and a
    // re-signed build silently invalidates an existing grant. If it's gone,
    // tear the timer down rather than calling SCShareableContent — that call
    // would re-raise the system dialog on this tick and every tick after it.
    guard CapturePermissions.shared.refreshScreenRecording() else {
      stop()
      CapturePermissions.shared.noteCaptureFailure(
        "Screen Recording permission is not granted — screen capture is off.")
      CapturePermissions.shared.beginWatchingForGrant()
      NSLog("OpenAGI capture: Screen Recording revoked — capture timer stopped")
      return
    }
    if capturing { return }
    capturing = true
    defer { capturing = false }

    let app = NSWorkspace.shared.frontmostApplication
    let bundleId = app?.bundleIdentifier
    let appName = app?.localizedName ?? bundleId ?? "(unknown)"
    let windowTitle = Self.frontmostWindowTitle()

    if CaptureSettings.shared.isExcluded(bundleId: bundleId, windowTitle: windowTitle) {
      return
    }

    do {
      // Capture the main display only. Multi-display support could iterate
      // over availableContent.displays.
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
      guard let display = content.displays.first else { return }
      // Per-window exclusions for the WHOLE display — not just the frontmost
      // app. Anything the user excluded that happens to be visible beside the
      // focused window is kept out of the pixels before OCR ever sees them,
      // and an unevaluable screen skips the tick entirely.
      let excludedWindows: [SCWindow]
      switch Self.exclusionDecision(for: content) {
      case .skip(let reason):
        noteExclusionSkip(reason)
        return
      case .capture(let ids):
        let idSet = Set(ids)
        excludedWindows = content.windows.filter { idSet.contains(UInt32($0.windowID)) }
      }
      lastSkipReason = nil
      let filter = SCContentFilter(display: display, excludingWindows: excludedWindows)
      let cfg = SCStreamConfiguration()
      cfg.width = display.width
      cfg.height = display.height
      cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
      cfg.queueDepth = 1
      cfg.scalesToFit = true
      cfg.showsCursor = false

      let cgImage = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
      consecutiveFailures = 0
      CapturePermissions.shared.noteCaptureFailure(nil)
      let uid = UUID().uuidString
      let nsImage = NSImage(cgImage: cgImage, size: .zero)

      // Thumbnail (640px wide max, JPEG 50%) — best-effort.
      let thumbPath = thumbnailsDir.appendingPathComponent("\(uid).jpg").path
      _ = saveThumbnail(image: nsImage, to: thumbPath, maxWidth: 640, quality: 0.5)

      // OCR off the main thread.
      ocrQueue.async {
        Self.runOcr(image: cgImage) { text, confidence in
          CaptureStorage.shared.recordFrame(
            uid: uid,
            capturedAt: Date(),
            app: appName,
            window: windowTitle,
            thumbnailPath: thumbPath,
            ocrText: text,
            confidence: confidence
          )
        }
      }
    } catch {
      NSLog("OpenAGI capture: \(error.localizedDescription)")
      // The preflight said we were granted, yet ScreenCaptureKit refused. That
      // can mean TCC and the capture daemon disagree (classic after a re-sign,
      // where the grant is invalidated under a running process). Don't retry
      // forever — every attempt is a chance for the system dialog to reappear.
      consecutiveFailures += 1
      if consecutiveFailures >= Self.maxConsecutiveFailures {
        stop()
        CapturePermissions.shared.noteCaptureFailure(
          "Screen capture failed \(consecutiveFailures)× in a row (\(error.localizedDescription)). Capture stopped. Check Screen Recording in System Settings, then relaunch OpenAGI if it stays off.")
        CapturePermissions.shared.beginWatchingForGrant()
        NSLog("OpenAGI capture: stopping timer after \(consecutiveFailures) consecutive failures")
      }
    }
  }

  // On-demand grab for the floating widget: OCR the current screen (dominated by
  // the frontmost window) and return the text. Honors the same exclusion list as
  // ambient capture, and returns nil when excluded or when capture/permission is
  // unavailable — callers then proceed without screen context.
  func captureFocusedText(excludingWindowNumber: Int? = nil) async -> ScreenContext? {
    if !CaptureSettings.shared.isActiveNow() { return nil }
    // Same non-prompting gate as the ambient path. This IS a deliberate,
    // user-initiated moment (they just pressed Quick Ask), so it may spend the
    // launch's one system prompt — but it must not call into ScreenCaptureKit
    // to find that out, and it returns nil rather than blocking on an answer.
    guard CapturePermissions.shared.refreshScreenRecording() else {
      CapturePermissions.shared.noteCaptureFailure(
        "Screen Recording permission is not granted — screen capture is off.")
      CapturePermissions.shared.requestScreenRecordingForFeatureUseIfNeeded()
      CapturePermissions.shared.beginWatchingForGrant()
      return nil
    }
    let app = NSWorkspace.shared.frontmostApplication
    let bundleId = app?.bundleIdentifier
    let appName = app?.localizedName ?? bundleId ?? "(unknown)"
    let windowTitle = Self.frontmostWindowTitle()

    if CaptureSettings.shared.isExcluded(bundleId: bundleId, windowTitle: windowTitle) {
      return nil
    }

    do {
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
      // Pick the display the frontmost window is actually on — on multi-monitor
      // setups the focused window may not be on the primary display, and grabbing
      // displays.first would OCR the wrong monitor. Match the front app's
      // on-screen window (preferring the AX focused-window title, else its
      // largest window) and use the display containing that window's center.
      let frontPid = app?.processIdentifier
      let appWindows = content.windows.filter { $0.owningApplication?.processID == frontPid && $0.isOnScreen }
      let frontWindow = appWindows.first { ($0.title ?? "") == (windowTitle ?? "") && !(windowTitle ?? "").isEmpty }
        ?? appWindows.max { ($0.frame.width * $0.frame.height) < ($1.frame.width * $1.frame.height) }
      let display = frontWindow.flatMap { w in
        content.displays.first { $0.frame.contains(CGPoint(x: w.frame.midX, y: w.frame.midY)) }
      } ?? content.displays.first
      guard let display else { return nil }
      let filter: SCContentFilter
      let cfg = SCStreamConfiguration()
      if let frontWindow {
        // We matched the focused window: capture JUST that window. A
        // display-level grab would OCR every other (non-excluded) window
        // sharing the monitor — side-by-side Mail/Slack/docs text — and
        // attribute it to the focused app, misgrounding the answer.
        //
        // Still run the shared policy over that one window: the frontmost
        // pre-check above uses the Accessibility title, which is nil when
        // Accessibility is off, and ScreenCaptureKit may know a title (or an
        // owning app) that AX did not. Excluded or unevaluable -> no context.
        switch Self.exclusionDecision(for: [frontWindow]) {
        case .skip:
          return nil
        case .capture(let ids):
          if ids.contains(UInt32(frontWindow.windowID)) { return nil }
        }
        filter = SCContentFilter(desktopIndependentWindow: frontWindow)
        let scale = CGFloat(filter.pointPixelScale)
        cfg.width = max(1, Int(frontWindow.frame.width * scale))
        cfg.height = max(1, Int(frontWindow.frame.height * scale))
      } else {
        // No window match — fall back to the whole display, minus the overlay
        // and any window belonging to an excluded app/title, so OCR never
        // reads e.g. 1Password sitting beside the focused app on the display
        // (the frontmost-only privacy check above doesn't cover other windows).
        // Same decision procedure as the ambient path, by construction.
        let overlayIDs = excludingWindowNumber.map { [UInt32(CGWindowID($0))] } ?? []
        let excluded: [SCWindow]
        switch Self.exclusionDecision(for: content, alwaysExclude: overlayIDs) {
        case .skip:
          return nil
        case .capture(let ids):
          let idSet = Set(ids)
          excluded = content.windows.filter { idSet.contains(UInt32($0.windowID)) }
        }
        filter = SCContentFilter(display: display, excludingWindows: excluded)
        cfg.width = display.width
        cfg.height = display.height
      }
      cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
      cfg.queueDepth = 1
      cfg.scalesToFit = true
      cfg.showsCursor = false

      let cgImage = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
      let text: String = await withCheckedContinuation { cont in
        ocrQueue.async {
          Self.runOcr(image: cgImage) { ocrText, _ in cont.resume(returning: ocrText) }
        }
      }
      let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
      if trimmed.isEmpty { return ScreenContext(app: appName, window: windowTitle, text: "") }
      return ScreenContext(app: appName, window: windowTitle, text: String(trimmed.prefix(8000)))
    } catch {
      NSLog("OpenAGI overlay capture: \(error.localizedDescription)")
      return nil
    }
  }

  // MARK: — the one place a window list becomes an exclusion decision

  /// Adapter: ScreenCaptureKit's window list -> CaptureSettings.decideCapture().
  /// Every capture path in this file goes through here, so the ambient timer and
  /// Quick Ask cannot disagree about what is private. Them each carrying their
  /// own copy of the check is precisely how the ambient path ended up grabbing
  /// the display with `excludingWindows: []`.
  private static func exclusionDecision(for content: SCShareableContent,
                                        alwaysExclude: [UInt32] = []) -> CaptureDecision {
    exclusionDecision(for: content.windows, alwaysExclude: alwaysExclude)
  }

  private static func exclusionDecision(for windows: [SCWindow],
                                        alwaysExclude: [UInt32] = []) -> CaptureDecision {
    let infos = windows.map { w in
      CaptureWindowInfo(windowID: UInt32(w.windowID),
                        bundleId: w.owningApplication?.bundleIdentifier,
                        title: w.title,
                        isOnScreen: w.isOnScreen)
    }
    return CaptureSettings.shared.captureDecision(windows: infos, alwaysExcludeWindowIDs: alwaysExclude)
  }

  /// A fail-closed skip is not an error — the timer keeps running so capture
  /// resumes by itself once the screen is evaluable again — but it must not be
  /// silent, or capture looks broken for a reason nobody can see. Surfaced in
  /// the privacy panel / tray via lastCaptureFailure; logged once per change.
  private func noteExclusionSkip(_ reason: String) {
    let message = "Screen capture skipped: \(reason)."
    if lastSkipReason != reason {
      lastSkipReason = reason
      NSLog("OpenAGI capture: \(message)")
    }
    CapturePermissions.shared.noteCaptureFailure(message)
  }

  // nonisolated: OCR deliberately runs on ocrQueue, off the main actor —
  // it touches no actor state (Vision request + completion callback only).
  nonisolated private static func runOcr(image: CGImage, completion: @escaping (String, Double) -> Void) {
    let req = VNRecognizeTextRequest { request, error in
      let observations = request.results as? [VNRecognizedTextObservation] ?? []
      var pieces: [String] = []
      var confSum = 0.0
      var n = 0
      for o in observations {
        if let cand = o.topCandidates(1).first {
          pieces.append(cand.string)
          confSum += Double(cand.confidence)
          n += 1
        }
      }
      let text = pieces.joined(separator: "\n")
      let avg = n > 0 ? confSum / Double(n) : 0
      completion(text, avg)
    }
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do { try handler.perform([req]) } catch { completion("", 0) }
  }

  private func saveThumbnail(image: NSImage, to path: String, maxWidth: CGFloat, quality: Double) -> Bool {
    guard let tiff = image.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff) else { return false }
    let size = rep.size
    let scale = min(1, maxWidth / size.width)
    let newSize = NSSize(width: size.width * scale, height: size.height * scale)

    let resized = NSImage(size: newSize)
    resized.lockFocus()
    image.draw(in: NSRect(origin: .zero, size: newSize), from: .zero, operation: .copy, fraction: 1.0)
    resized.unlockFocus()

    guard let resizedTiff = resized.tiffRepresentation,
          let resizedRep = NSBitmapImageRep(data: resizedTiff) else { return false }
    guard let data = resizedRep.representation(using: .jpeg, properties: [.compressionFactor: quality]) else { return false }
    return (try? data.write(to: URL(fileURLWithPath: path))) != nil
  }

  static func frontmostWindowTitle() -> String? {
    guard AXIsProcessTrusted() else { return nil }
    let frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    if frontPid == 0 { return nil }
    let appElement = AXUIElementCreateApplication(frontPid)
    var window: AnyObject?
    if AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &window) == .success,
       let win = window {
      var title: AnyObject?
      if AXUIElementCopyAttributeValue(win as! AXUIElement, kAXTitleAttribute as CFString, &title) == .success {
        return title as? String
      }
    }
    return nil
  }
}
