import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

public enum ComputerScreenshotError: LocalizedError {
  case screenRecordingRequired
  case consoleSessionRequired
  case screenLocked
  case focusedWindowUnavailable
  case focusedWindowExcluded
  case encodingFailed
  case imageTooLarge

  public var errorDescription: String? {
    switch self {
    case .screenRecordingRequired:
      return "Screen Recording permission is required for computer screenshots"
    case .consoleSessionRequired:
      return "computer screenshots require the active console session"
    case .screenLocked:
      return "computer screenshots are unavailable while the screen is locked"
    case .focusedWindowUnavailable:
      return "the focused window could not be safely identified"
    case .focusedWindowExcluded:
      return "the focused window is excluded by the capture privacy policy"
    case .encodingFailed:
      return "the focused window could not be encoded as PNG"
    case .imageTooLarge:
      return "the encoded screenshot exceeds the safe response limit"
    }
  }
}

public struct ComputerScreenshotResult: Encodable, Equatable {
  public let format: String
  public let width: Int
  public let height: Int
  public let bytes: Int
  public let scale: Double
  public let offsetX: Double
  public let offsetY: Double
  public let base64: String
  public let accessibility: String
  /// Local-only element locators. The node executor strips these before the
  /// state is returned to a model or a remote main.
  public let elements: [ComputerAccessibilityElement]
  /// This identity is consumed only by the local signed input helper. The
  /// daemon strips it before returning the screenshot to a model or main.
  public let focus: ComputerFocusIdentity

  public init(width: Int, height: Int, bytes: Int, scale: Double,
              offsetX: Double, offsetY: Double, base64: String,
              focus: ComputerFocusIdentity, accessibility: String = "",
              elements: [ComputerAccessibilityElement] = []) {
    self.format = "png"
    self.width = width
    self.height = height
    self.bytes = bytes
    self.scale = scale
    self.offsetX = offsetX
    self.offsetY = offsetY
    self.base64 = base64
    self.focus = focus
    self.accessibility = accessibility
    self.elements = elements
  }
}

/// A local-only proof of the exact focused window that produced a screenshot.
/// It is passed back to the signed helper for every subsequent input event so
/// focus changes fail closed instead of directing input into another window.
public struct ComputerFocusIdentity: Codable, Equatable {
  public let windowID: UInt32
  public let processIdentifier: Int32
  public let bundleIdentifier: String
  public let title: String
  public let x: Double
  public let y: Double
  public let width: Double
  public let height: Double

  public init(windowID: UInt32, processIdentifier: Int32,
              bundleIdentifier: String, title: String, frame: CGRect) {
    self.windowID = windowID
    self.processIdentifier = processIdentifier
    self.bundleIdentifier = bundleIdentifier
    self.title = title
    self.x = Double(frame.origin.x)
    self.y = Double(frame.origin.y)
    self.width = Double(frame.width)
    self.height = Double(frame.height)
  }

  public var frame: CGRect {
    CGRect(x: x, y: y, width: width, height: height)
  }
}

/// The public, non-pixel identity needed to prove that a ScreenCaptureKit
/// window is the exact Accessibility-focused window. PID + title alone is not
/// enough: many apps can have multiple documents with the same title.
public struct ComputerWindowIdentity: Equatable {
  public let windowID: CGWindowID?
  public let processIdentifier: pid_t
  public let title: String
  public let frame: CGRect

  public init(windowID: CGWindowID? = nil, processIdentifier: pid_t,
              title: String, frame: CGRect) {
    self.windowID = windowID
    self.processIdentifier = processIdentifier
    self.title = title
    self.frame = frame
  }
}

/// Capture exclusions shared by the signed helper. The helper reads the same
/// persisted settings as ambient capture, then unions them with fail-closed
/// defaults so an absent, truncated, or stale settings file can only increase
/// privacy, never weaken it.
public struct ComputerCapturePrivacy: Equatable {
  public let excludedBundleIds: [String]
  public let excludedWindowPatterns: [String]
  public let settingsReadable: Bool

  public static let defaultExcludedBundleIds: [String] = [
    "com.1password", "com.agilebits", "com.lastpass.LastPass",
    "com.lastpass.lastpassmacdesktop", "com.bitwarden.desktop", "com.dashlane",
    "org.keepassxc.keepassxc", "org.keepassx.keepassx", "com.keepassium.KeePassium",
    "com.callpod.keeperdesktop", "com.keepersecurity.KeeperDesktop", "me.proton.pass",
    "ch.protonmail.pass", "com.nordsecurity.nordpass", "com.nordpass.macos",
    "in.sinew.Enpass-Desktop", "com.markmcguill.strongbox", "com.outercorner.Secrets",
    "com.roboform.RoboForm", "com.authy.authy-mac", "com.apple.MobileSMS",
    "com.apple.iChat", "org.whispersystems.signal-desktop", "net.whatsapp.WhatsApp",
    "desktop.WhatsApp", "ph.telegra.Telegraph", "org.telegram.desktop",
    "ch.threema.threema-desktop", "com.wire.desktop", "com.apple.keychainaccess",
    "com.apple.Passwords", "com.apple.Passwords-Settings.extension", "com.apple.Wallet",
    "com.apple.SecurityAgent", "com.apple.CryptoTokenKit.CTKPINPad", "com.apple.loginwindow"
  ]

  public static let defaultExcludedWindowPatterns: [String] = [
    "(?i)private browsing", "(?i)\\bprivate window\\b", "(?i)incognito", "(?i)password",
    "(?i)\\bpasskey", "(?i)\\bkeychain\\b", "(?i)2FA",
    "(?i)\\b(otp|verification code)\\b", "(?i)\\bone[- ]time (pass)?code\\b",
    "(?i)\\bauthenticator\\b", "(?i)\\b(seed|recovery) phrase\\b", "(?i)\\bmnemonic\\b",
    "(?i)\\b(api[ _-]?key|secret key|access token)\\b",
    "(?i)\\b(credit card|card number|cvv)\\b", "(?i)\\bonline banking\\b",
    "(?i)\\b(ssn|social security)\\b"
  ]

  public init(excludedBundleIds: [String] = Self.defaultExcludedBundleIds,
              excludedWindowPatterns: [String] = Self.defaultExcludedWindowPatterns,
              settingsReadable: Bool = true) {
    self.excludedBundleIds = Self.union(Self.defaultExcludedBundleIds, excludedBundleIds)
    self.excludedWindowPatterns = Self.union(Self.defaultExcludedWindowPatterns, excludedWindowPatterns)
    self.settingsReadable = settingsReadable
  }

  public static var settingsURL: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("OpenAGI/capture/settings.json")
  }

  public static func load(from url: URL = settingsURL) -> ComputerCapturePrivacy {
    guard FileManager.default.fileExists(atPath: url.path) else {
      return ComputerCapturePrivacy()
    }
    guard let data = readSettingsData(from: url),
          let object = try? JSONSerialization.jsonObject(with: data),
          let dictionary = object as? [String: Any],
          dictionary["excludedBundleIds"].map({ $0 is [String] }) ?? true,
          dictionary["excludedWindowPatterns"].map({ $0 is [String] }) ?? true else {
      return ComputerCapturePrivacy(settingsReadable: false)
    }
    let bundleIds = dictionary["excludedBundleIds"] as? [String] ?? []
    let patterns = dictionary["excludedWindowPatterns"] as? [String] ?? []
    guard bundleIds.count <= 256, patterns.count <= 256,
          bundleIds.allSatisfy({ $0.utf8.count <= 512 }),
          patterns.allSatisfy({ $0.utf8.count <= 512 }) else {
      return ComputerCapturePrivacy(settingsReadable: false)
    }
    return ComputerCapturePrivacy(excludedBundleIds: bundleIds,
                                  excludedWindowPatterns: patterns)
  }

  public func permits(bundleId: String?, title: String?) -> Bool {
    let bundle = Self.normalized(bundleId)
    let windowTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    // A missing identity or title cannot be checked against the persisted
    // policy. Treat it as private rather than silently capturing it.
    guard settingsReadable,
          !bundle.isEmpty, bundle.utf8.count <= 512,
          !windowTitle.isEmpty, windowTitle.utf8.count <= 1_024 else { return false }
    if excludedBundleIds.contains(where: {
      let excluded = Self.normalized($0)
      return !excluded.isEmpty && (bundle == excluded || bundle.hasPrefix(excluded + "."))
    }) { return false }
    let titleRange = NSRange(location: 0, length: windowTitle.utf16.count)
    for rawPattern in excludedWindowPatterns {
      let pattern = rawPattern.trimmingCharacters(in: .whitespacesAndNewlines)
      if pattern.isEmpty { continue }
      if let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) {
        if regex.firstMatch(in: windowTitle, range: titleRange) != nil { return false }
      } else if windowTitle.range(of: pattern, options: [.caseInsensitive]) != nil {
        // A malformed user regex remains an exclusion via literal matching.
        return false
      }
    }
    return true
  }

  public func permitsBundle(_ bundleId: String?) -> Bool {
    let bundle = Self.normalized(bundleId)
    guard settingsReadable, !bundle.isEmpty, bundle.utf8.count <= 512 else { return false }
    return !excludedBundleIds.contains(where: {
      let excluded = Self.normalized($0)
      return !excluded.isEmpty && (bundle == excluded || bundle.hasPrefix(excluded + "."))
    })
  }

  private static func union(_ defaults: [String], _ persisted: [String]) -> [String] {
    var seen = Set<String>()
    return (defaults + persisted).filter {
      let key = normalized($0)
      return !key.isEmpty && seen.insert(key).inserted
    }
  }

  private static func readSettingsData(from url: URL) -> Data? {
    guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
    defer { try? handle.close() }
    guard let data = try? handle.read(upToCount: 1024 * 1024 + 1),
          data.count <= 1024 * 1024 else { return nil }
    return data
  }

  private static func normalized(_ value: String?) -> String {
    (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }
}

public enum ComputerScreenshot {
  public static let maximumPixelDimension = 1_280
  public static let maximumPNGBytes = 8 * 1024 * 1024

  /// Non-prompting readiness probe used by the helper status response. It does
  /// not capture pixels; it proves the focused AX window maps uniquely to one
  /// on-screen CoreGraphics window and passes the persisted privacy policy.
  public static func focusedWindowPrivacyReady(
    privacy: ComputerCapturePrivacy = .load()
  ) -> Bool {
    guard privacy.settingsReadable,
          AXIsProcessTrusted(),
          let app = NSWorkspace.shared.frontmostApplication,
          let bundleId = app.bundleIdentifier,
          let focused = focusedWindowIdentity(processIdentifier: app.processIdentifier),
          privacy.permits(bundleId: bundleId, title: focused.title) else { return false }
    return exactFocusedWindowID(
      focused: focused,
      candidates: windowListIdentities(processIdentifier: app.processIdentifier)
    ) != nil
  }

  /// Capture only the Accessibility-focused window of the frontmost app. This
  /// deliberately has no display-level fallback: if focus, ownership, title,
  /// or exclusion evaluation is ambiguous, no pixels leave the helper.
  public static func captureFrontmostWindow(
    privacy: ComputerCapturePrivacy = .load(),
    maxPixelDimension: Int = maximumPixelDimension,
    maxPNGBytes: Int = maximumPNGBytes
  ) async throws -> ComputerScreenshotResult {
    guard ComputerInput.screenRecordingGranted else {
      throw ComputerScreenshotError.screenRecordingRequired
    }
    guard ComputerInput.consoleSessionActive else {
      throw ComputerScreenshotError.consoleSessionRequired
    }
    guard !ComputerInput.screenLocked else { throw ComputerScreenshotError.screenLocked }
    guard maxPixelDimension > 0, maxPixelDimension <= maximumPixelDimension,
          maxPNGBytes > 0, maxPNGBytes <= maximumPNGBytes else {
      throw ComputerScreenshotError.imageTooLarge
    }
    guard privacy.settingsReadable,
          let app = NSWorkspace.shared.frontmostApplication,
          let bundleId = app.bundleIdentifier,
          let focused = focusedWindowIdentity(processIdentifier: app.processIdentifier) else {
      throw ComputerScreenshotError.focusedWindowUnavailable
    }
    guard privacy.permits(bundleId: bundleId, title: focused.title) else {
      throw ComputerScreenshotError.focusedWindowExcluded
    }

    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    guard let mainDisplay = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) else {
      throw ComputerScreenshotError.focusedWindowUnavailable
    }
    guard let focusedWindowID = exactFocusedWindowID(
      focused: focused,
      candidates: windowListIdentities(processIdentifier: app.processIdentifier)
    ), let window = content.windows.first(where: {
      $0.windowID == focusedWindowID
        && $0.isOnScreen
        && $0.owningApplication?.processID == app.processIdentifier
        && $0.title == focused.title
        && framesReferToSameWindow($0.frame, focused.frame)
        && $0.frame.width >= 32
        && $0.frame.height >= 32
        && mainDisplay.frame.contains(CGPoint(x: $0.frame.midX, y: $0.frame.midY))
    }), privacy.permits(bundleId: window.owningApplication?.bundleIdentifier, title: window.title) else {
      throw ComputerScreenshotError.focusedWindowUnavailable
    }

    // Focus can move while ScreenCaptureKit enumerates. Re-read the AX-focused
    // element immediately before pixel capture and fail closed on any change.
    guard focusStillMatches(
      processIdentifier: app.processIdentifier,
      title: focused.title,
      frame: focused.frame,
      windowID: focusedWindowID
    ) else {
      throw ComputerScreenshotError.focusedWindowUnavailable
    }

    let filter = SCContentFilter(desktopIndependentWindow: window)
    let nativeScale = max(1, Double(filter.pointPixelScale))
    let nativeWidth = max(1, Double(window.frame.width) * nativeScale)
    let nativeHeight = max(1, Double(window.frame.height) * nativeScale)
    let requestedScale = min(1, Double(maxPixelDimension) / max(nativeWidth, nativeHeight))
    let width = max(1, Int((nativeWidth * requestedScale).rounded(.down)))
    let height = max(1, Int((nativeHeight * requestedScale).rounded(.down)))

    let configuration = SCStreamConfiguration()
    configuration.width = width
    configuration.height = height
    configuration.queueDepth = 1
    configuration.scalesToFit = true
    configuration.showsCursor = false
    configuration.ignoreShadowsSingleWindow = true
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter,
                                                            configuration: configuration)
    // Capture is asynchronous. Re-check after pixels arrive too, and discard
    // them if focus changed while ScreenCaptureKit was working.
    guard focusStillMatches(
      processIdentifier: app.processIdentifier,
      title: focused.title,
      frame: focused.frame,
      windowID: focusedWindowID
    ) else {
      throw ComputerScreenshotError.focusedWindowUnavailable
    }
    let representation = NSBitmapImageRep(cgImage: image)
    guard let png = representation.representation(using: .png, properties: [:]) else {
      throw ComputerScreenshotError.encodingFailed
    }
    guard png.count <= maxPNGBytes else { throw ComputerScreenshotError.imageTooLarge }
    let actualScale = imageToPointScale(imagePixelWidth: image.width,
                                        windowPointWidth: Double(window.frame.width))
    let focus = ComputerFocusIdentity(
      windowID: focusedWindowID,
      processIdentifier: app.processIdentifier,
      bundleIdentifier: bundleId,
      title: focused.title,
      frame: focused.frame
    )
    let accessibility = try ComputerAccessibility.capture(focus: focus)
    return ComputerScreenshotResult(
      width: image.width,
      height: image.height,
      bytes: png.count,
      scale: actualScale,
      offsetX: Double(window.frame.origin.x),
      offsetY: Double(window.frame.origin.y),
      base64: png.base64EncodedString(),
      focus: focus,
      accessibility: accessibility.text,
      elements: accessibility.elements
    )
  }

  /// The relay receives coordinates in screenshot pixels and posts events in
  /// global display points. `scale` is therefore points-per-image-pixel; the
  /// global point is `(imageCoordinate + offset / scale) * scale`.
  public static func imageToPointScale(imagePixelWidth: Int, windowPointWidth: Double) -> Double {
    guard imagePixelWidth > 0, windowPointWidth.isFinite, windowPointWidth > 0 else { return 1 }
    return windowPointWidth / Double(imagePixelWidth)
  }

  /// Resolve one—and only one—window number from the AX focused identity. This
  /// is public for deterministic safety tests; production candidates still
  /// come only from the local CoreGraphics window list.
  public static func exactFocusedWindowID(
    focused: ComputerWindowIdentity,
    candidates: [ComputerWindowIdentity]
  ) -> CGWindowID? {
    let matches = candidates.filter {
      $0.windowID != nil
        && $0.processIdentifier == focused.processIdentifier
        && $0.title == focused.title
        && framesReferToSameWindow($0.frame, focused.frame)
    }
    return matches.count == 1 ? matches[0].windowID : nil
  }

  public static func framesReferToSameWindow(
    _ lhs: CGRect,
    _ rhs: CGRect,
    tolerance: CGFloat = 2
  ) -> Bool {
    guard tolerance >= 0,
          [lhs.origin.x, lhs.origin.y, lhs.width, lhs.height,
           rhs.origin.x, rhs.origin.y, rhs.width, rhs.height].allSatisfy({ $0.isFinite }) else {
      return false
    }
    return abs(lhs.origin.x - rhs.origin.x) <= tolerance
      && abs(lhs.origin.y - rhs.origin.y) <= tolerance
      && abs(lhs.width - rhs.width) <= tolerance
      && abs(lhs.height - rhs.height) <= tolerance
  }

  /// Pure focus comparison used by both the live helper and deterministic
  /// safety tests. The current window must still be the exact captured window
  /// and must still pass the latest privacy exclusions.
  public static func focusIdentityMatches(
    expected: ComputerFocusIdentity,
    frontmostProcessIdentifier: pid_t?,
    frontmostBundleIdentifier: String?,
    focused: ComputerWindowIdentity?,
    candidates: [ComputerWindowIdentity],
    privacy: ComputerCapturePrivacy
  ) -> Bool {
    guard expected.windowID > 0,
          expected.processIdentifier > 0,
          expected.title.utf8.count <= 1_024,
          expected.bundleIdentifier.utf8.count <= 512,
          expected.width >= 32, expected.height >= 32,
          [expected.x, expected.y, expected.width, expected.height].allSatisfy({ $0.isFinite }),
          frontmostProcessIdentifier == expected.processIdentifier,
          frontmostBundleIdentifier == expected.bundleIdentifier,
          let focused,
          focused.processIdentifier == expected.processIdentifier,
          focused.title == expected.title,
          framesReferToSameWindow(focused.frame, expected.frame),
          privacy.permits(bundleId: frontmostBundleIdentifier, title: focused.title) else {
      return false
    }
    return exactFocusedWindowID(focused: focused, candidates: candidates) == expected.windowID
  }

  /// Re-read the frontmost app, AX focus, window list, and privacy policy
  /// immediately before a physical event.
  public static func focusStillMatches(
    _ expected: ComputerFocusIdentity,
    privacy: ComputerCapturePrivacy = .load()
  ) -> Bool {
    let app = NSWorkspace.shared.frontmostApplication
    let pid = app?.processIdentifier
    return focusIdentityMatches(
      expected: expected,
      frontmostProcessIdentifier: pid,
      frontmostBundleIdentifier: app?.bundleIdentifier,
      focused: pid.map({ focusedWindowIdentity(processIdentifier: $0) }) ?? nil,
      candidates: pid.map({ windowListIdentities(processIdentifier: $0) }) ?? [],
      privacy: privacy
    )
  }

  private static func windowListIdentities(
    processIdentifier: pid_t
  ) -> [ComputerWindowIdentity] {
    guard let rawWindows = CGWindowListCopyWindowInfo(
      [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
    ) as? [[String: Any]] else { return [] }
    return rawWindows.compactMap { raw in
      guard (raw[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == processIdentifier,
            (raw[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
            let title = (raw[kCGWindowName as String] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
            !title.isEmpty,
            let number = raw[kCGWindowNumber as String] as? NSNumber,
            let bounds = raw[kCGWindowBounds as String] as? [String: Any],
            let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return nil }
      return ComputerWindowIdentity(
        windowID: CGWindowID(number.uint32Value),
        processIdentifier: processIdentifier,
        title: title,
        frame: frame
      )
    }
  }

  private static func focusedWindowIdentity(
    processIdentifier: pid_t
  ) -> ComputerWindowIdentity? {
    guard AXIsProcessTrusted() else { return nil }
    let application = AXUIElementCreateApplication(processIdentifier)
    var focusedWindow: AnyObject?
    guard AXUIElementCopyAttributeValue(application,
                                        kAXFocusedWindowAttribute as CFString,
                                        &focusedWindow) == .success,
          let focusedWindow else { return nil }
    var title: AnyObject?
    guard AXUIElementCopyAttributeValue(focusedWindow as! AXUIElement,
                                        kAXTitleAttribute as CFString,
                                        &title) == .success else { return nil }
    let value = (title as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let value, !value.isEmpty,
          let position = pointAttribute(focusedWindow as! AXUIElement,
                                        attribute: kAXPositionAttribute as CFString),
          let size = sizeAttribute(focusedWindow as! AXUIElement,
                                   attribute: kAXSizeAttribute as CFString),
          size.width > 0, size.height > 0 else { return nil }
    return ComputerWindowIdentity(
      processIdentifier: processIdentifier,
      title: value,
      frame: CGRect(origin: position, size: size)
    )
  }

  private static func focusStillMatches(
    processIdentifier: pid_t,
    title: String,
    frame: CGRect,
    windowID: CGWindowID
  ) -> Bool {
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == processIdentifier,
          let focused = focusedWindowIdentity(processIdentifier: processIdentifier),
          focused.title == title,
          framesReferToSameWindow(focused.frame, frame) else { return false }
    return exactFocusedWindowID(
      focused: focused,
      candidates: windowListIdentities(processIdentifier: processIdentifier)
    ) == windowID
  }

  private static func pointAttribute(
    _ element: AXUIElement,
    attribute: CFString
  ) -> CGPoint? {
    var raw: AnyObject?
    guard AXUIElementCopyAttributeValue(element, attribute, &raw) == .success,
          let raw,
          CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(raw as! AXValue, .cgPoint, &point) ? point : nil
  }

  private static func sizeAttribute(
    _ element: AXUIElement,
    attribute: CFString
  ) -> CGSize? {
    var raw: AnyObject?
    guard AXUIElementCopyAttributeValue(element, attribute, &raw) == .success,
          let raw,
          CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    var size = CGSize.zero
    return AXValueGetValue(raw as! AXValue, .cgSize, &size) ? size : nil
  }
}
