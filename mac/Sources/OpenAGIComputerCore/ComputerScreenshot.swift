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

  public init(width: Int, height: Int, bytes: Int, scale: Double,
              offsetX: Double, offsetY: Double, base64: String) {
    self.format = "png"
    self.width = width
    self.height = height
    self.bytes = bytes
    self.scale = scale
    self.offsetX = offsetX
    self.offsetY = offsetY
    self.base64 = base64
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
  /// not enumerate or capture pixels; it only proves the focused window has a
  /// readable owner/title and passes the persisted privacy policy.
  public static func focusedWindowPrivacyReady(
    privacy: ComputerCapturePrivacy = .load()
  ) -> Bool {
    guard privacy.settingsReadable,
          AXIsProcessTrusted(),
          let app = NSWorkspace.shared.frontmostApplication,
          let bundleId = app.bundleIdentifier,
          let title = focusedWindowTitle(processIdentifier: app.processIdentifier) else { return false }
    return privacy.permits(bundleId: bundleId, title: title)
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
          let focusedTitle = focusedWindowTitle(processIdentifier: app.processIdentifier),
          privacy.permits(bundleId: bundleId, title: focusedTitle) else {
      throw ComputerScreenshotError.focusedWindowExcluded
    }

    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    guard let mainDisplay = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) else {
      throw ComputerScreenshotError.focusedWindowUnavailable
    }
    guard let focusedWindowID = focusedWindowID(
      processIdentifier: app.processIdentifier,
      title: focusedTitle
    ), let window = content.windows.first(where: {
      $0.windowID == focusedWindowID
        && $0.isOnScreen
        && $0.owningApplication?.processID == app.processIdentifier
        && $0.title == focusedTitle
        && $0.frame.width >= 32
        && $0.frame.height >= 32
        && mainDisplay.frame.contains(CGPoint(x: $0.frame.midX, y: $0.frame.midY))
    }), privacy.permits(bundleId: window.owningApplication?.bundleIdentifier, title: window.title) else {
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
    let representation = NSBitmapImageRep(cgImage: image)
    guard let png = representation.representation(using: .png, properties: [:]) else {
      throw ComputerScreenshotError.encodingFailed
    }
    guard png.count <= maxPNGBytes else { throw ComputerScreenshotError.imageTooLarge }
    let actualScale = imageToPointScale(imagePixelWidth: image.width,
                                        windowPointWidth: Double(window.frame.width))
    return ComputerScreenshotResult(
      width: image.width,
      height: image.height,
      bytes: png.count,
      scale: actualScale,
      offsetX: Double(window.frame.origin.x),
      offsetY: Double(window.frame.origin.y),
      base64: png.base64EncodedString()
    )
  }

  /// The relay receives coordinates in screenshot pixels and posts events in
  /// global display points. `scale` is therefore points-per-image-pixel; the
  /// global point is `(imageCoordinate + offset / scale) * scale`.
  public static func imageToPointScale(imagePixelWidth: Int, windowPointWidth: Double) -> Double {
    guard imagePixelWidth > 0, windowPointWidth.isFinite, windowPointWidth > 0 else { return 1 }
    return windowPointWidth / Double(imagePixelWidth)
  }

  private static func focusedWindowID(processIdentifier: pid_t,
                                      title: String) -> CGWindowID? {
    guard let rawWindows = CGWindowListCopyWindowInfo(
      [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
    ) as? [[String: Any]] else { return nil }
    for raw in rawWindows {
      guard (raw[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == processIdentifier,
            (raw[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
            raw[kCGWindowName as String] as? String == title,
            let number = raw[kCGWindowNumber as String] as? NSNumber else { continue }
      return CGWindowID(number.uint32Value)
    }
    return nil
  }

  private static func focusedWindowTitle(processIdentifier: pid_t) -> String? {
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
    return value?.isEmpty == false ? value : nil
  }
}
