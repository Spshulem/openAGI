import AppKit
import Foundation

public enum ComputerApplicationError: LocalizedError {
  case invalidIdentifier
  case excluded
  case unavailable
  case activationFailed

  public var errorDescription: String? {
    switch self {
    case .invalidIdentifier: return "the application bundle identifier is malformed"
    case .excluded: return "the application is excluded by Capture privacy settings"
    case .unavailable: return "the requested application is not installed"
    case .activationFailed: return "the requested application could not be activated"
    }
  }
}

public struct ComputerApplicationDescriptor: Codable, Equatable {
  public let bundleIdentifier: String
  public let name: String
  public let running: Bool
}

public enum ComputerApplications {
  public static func list(privacy: ComputerCapturePrivacy = .load()) -> [ComputerApplicationDescriptor] {
    var applications: [String: ComputerApplicationDescriptor] = [:]
    for app in NSWorkspace.shared.runningApplications {
      guard let identifier = app.bundleIdentifier,
            valid(identifier), privacy.permitsBundle(identifier),
            let name = bounded(app.localizedName) else { continue }
      applications[identifier] = ComputerApplicationDescriptor(
        bundleIdentifier: identifier, name: name, running: !app.isTerminated
      )
    }
    let home = FileManager.default.homeDirectoryForCurrentUser
    let directories = [
      URL(fileURLWithPath: "/Applications"),
      URL(fileURLWithPath: "/System/Applications"),
      URL(fileURLWithPath: "/System/Applications/Utilities"),
      home.appendingPathComponent("Applications")
    ]
    for directory in directories {
      for url in discoverApplicationURLs(in: directory) {
        guard let bundle = Bundle(url: url), let identifier = bundle.bundleIdentifier,
              valid(identifier), privacy.permitsBundle(identifier),
              let name = bounded(bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
                ?? bundle.object(forInfoDictionaryKey: "CFBundleName") as? String
                ?? url.deletingPathExtension().lastPathComponent) else { continue }
        applications[identifier] = applications[identifier]
          ?? ComputerApplicationDescriptor(bundleIdentifier: identifier, name: name, running: false)
      }
    }
    return applications.values.sorted {
      if $0.running != $1.running { return $0.running && !$1.running }
      return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
    }.prefix(300).map { $0 }
  }

  /// Application folders commonly contain vendor subdirectories. Walk them
  /// with explicit bounds while treating every package and symlink as a leaf,
  /// so discovery cannot escape a configured root or descend into app bundles.
  static func discoverApplicationURLs(in directory: URL, maxEntries: Int = 4_000) -> [URL] {
    guard maxEntries > 0 else { return [] }
    let keys: [URLResourceKey] = [.isDirectoryKey, .isPackageKey, .isSymbolicLinkKey]
    guard let enumerator = FileManager.default.enumerator(
      at: directory,
      includingPropertiesForKeys: keys,
      options: [.skipsHiddenFiles, .skipsPackageDescendants],
      errorHandler: { _, _ in true }
    ) else { return [] }
    var applications: [URL] = []
    var visited = 0
    for case let url as URL in enumerator {
      visited += 1
      if visited > maxEntries { break }
      let values = try? url.resourceValues(forKeys: Set(keys))
      if values?.isSymbolicLink == true {
        enumerator.skipDescendants()
        continue
      }
      if url.pathExtension.lowercased() == "app" {
        applications.append(url)
        enumerator.skipDescendants()
      } else if values?.isPackage == true {
        enumerator.skipDescendants()
      }
    }
    return applications
  }

  public static func activate(
    bundleIdentifier: String,
    privacy: ComputerCapturePrivacy = .load()
  ) async throws -> ComputerApplicationDescriptor {
    guard valid(bundleIdentifier) else { throw ComputerApplicationError.invalidIdentifier }
    guard privacy.permitsBundle(bundleIdentifier) else { throw ComputerApplicationError.excluded }
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier) else {
      throw ComputerApplicationError.unavailable
    }

    // `NSRunningApplication.activate` can legitimately return false for an
    // already-running app that has no active window (TextEdit after its last
    // document closes is a common example). Treat it as the fast path, not the
    // only launch path. `openApplication` is the same generic LaunchServices
    // route used by Finder/open(1); with `activates = true` it can create the
    // app's normal initial window and bring it forward.
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier)
      .first(where: { !$0.isTerminated })
    if running?.activate(options: [.activateAllWindows]) != true {
      try await openApplication(at: url)
    }

    // LaunchServices may acknowledge activation before macOS completes the
    // foreground transition (especially when Notification Center or an
    // always-on-top panel is yielding focus). Keep the helper bounded, but
    // allow enough time for that asynchronous transition instead of aborting a
    // valid session at the old three-second boundary.
    for attempt in 0..<80 {
      if activationIsReady(
           targetBundleIdentifier: bundleIdentifier,
           frontmostBundleIdentifier: NSWorkspace.shared.frontmostApplication?.bundleIdentifier,
           hasCapturableWindow: ComputerScreenshot.focusedWindowPrivacyReady(privacy: privacy)
         ),
         let descriptor = list(privacy: privacy).first(where: { $0.bundleIdentifier == bundleIdentifier }) {
        return descriptor
      }
      // An app may accept the fast-path activation but still have no window to
      // raise. Retry once through LaunchServices before declaring the request
      // failed; never spin up a second process because LaunchServices resolves
      // the existing bundle instance.
      if attempt == 9 { try await openApplication(at: url) }
      if attempt == 39 {
        _ = NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier)
          .first(where: { !$0.isTerminated })?
          .activate(options: [.activateAllWindows])
      }
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    throw ComputerApplicationError.activationFailed
  }

  static func activationIsReady(
    targetBundleIdentifier: String,
    frontmostBundleIdentifier: String?,
    hasCapturableWindow: Bool
  ) -> Bool {
    frontmostBundleIdentifier == targetBundleIdentifier && hasCapturableWindow
  }

  private static func openApplication(at url: URL) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      let configuration = NSWorkspace.OpenConfiguration()
      configuration.activates = true
      NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
        if let error { continuation.resume(throwing: error) }
        else if let app {
          // The open completion only promises that LaunchServices resolved the
          // application. Ask the returned process to foreground as well; this
          // closes the gap for already-running, windowless applications.
          _ = app.activate(options: [.activateAllWindows])
          continuation.resume(returning: ())
        } else { continuation.resume(throwing: ComputerApplicationError.activationFailed) }
      }
    }
  }

  private static func valid(_ value: String) -> Bool {
    value.utf8.count <= 512 && value.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]+$", options: .regularExpression) != nil
  }

  static func bounded(_ value: String?) -> String? {
    guard let value else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    guard trimmed.utf8.count > 240 else { return trimmed }
    var result = ""
    var byteCount = 0
    for character in trimmed {
      let bytes = String(character).utf8.count
      if byteCount + bytes > 240 { break }
      result.append(character)
      byteCount += bytes
    }
    return result.isEmpty ? nil : result
  }
}
