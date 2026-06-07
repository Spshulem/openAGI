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
  private let ocrQueue = DispatchQueue(label: "openagi.capture.ocr")
  private var thumbnailsDir: URL {
    let dir = CaptureSettings.captureDir.appendingPathComponent("thumbnails", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  func start() {
    stop()
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
      let filter = SCContentFilter(display: display, excludingWindows: [])
      let cfg = SCStreamConfiguration()
      cfg.width = display.width
      cfg.height = display.height
      cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
      cfg.queueDepth = 1
      cfg.scalesToFit = true
      cfg.showsCursor = false

      let cgImage = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
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
    }
  }

  // On-demand grab for the floating widget: OCR the current screen (dominated by
  // the frontmost window) and return the text. Honors the same exclusion list as
  // ambient capture, and returns nil when excluded or when capture/permission is
  // unavailable — callers then proceed without screen context.
  func captureFocusedText(excludingWindowNumber: Int? = nil) async -> ScreenContext? {
    if !CaptureSettings.shared.isActiveNow() { return nil }
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
      var excluded: [SCWindow] = []
      if let wn = excludingWindowNumber {
        excluded = content.windows.filter { $0.windowID == CGWindowID(wn) }
      }
      let filter = SCContentFilter(display: display, excludingWindows: excluded)
      let cfg = SCStreamConfiguration()
      cfg.width = display.width
      cfg.height = display.height
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

  private static func runOcr(image: CGImage, completion: @escaping (String, Double) -> Void) {
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
