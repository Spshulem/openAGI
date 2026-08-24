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
      let urls = (try? FileManager.default.contentsOfDirectory(
        at: directory, includingPropertiesForKeys: nil,
        options: [.skipsHiddenFiles, .skipsPackageDescendants]
      )) ?? []
      for url in urls where url.pathExtension.lowercased() == "app" {
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

  public static func activate(
    bundleIdentifier: String,
    privacy: ComputerCapturePrivacy = .load()
  ) async throws -> ComputerApplicationDescriptor {
    guard valid(bundleIdentifier) else { throw ComputerApplicationError.invalidIdentifier }
    guard privacy.permitsBundle(bundleIdentifier) else { throw ComputerApplicationError.excluded }
    if let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier)
      .first(where: { !$0.isTerminated }) {
      guard running.activate(options: [.activateAllWindows]) else {
        throw ComputerApplicationError.activationFailed
      }
    } else {
      guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier) else {
        throw ComputerApplicationError.unavailable
      }
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
          if let error { continuation.resume(throwing: error) }
          else if app == nil { continuation.resume(throwing: ComputerApplicationError.activationFailed) }
          else { continuation.resume(returning: ()) }
        }
      }
    }
    for _ in 0..<30 {
      if NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleIdentifier,
         let descriptor = list(privacy: privacy).first(where: { $0.bundleIdentifier == bundleIdentifier }) {
        return descriptor
      }
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    throw ComputerApplicationError.activationFailed
  }

  private static func valid(_ value: String) -> Bool {
    value.utf8.count <= 512 && value.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]+$", options: .regularExpression) != nil
  }

  private static func bounded(_ value: String?) -> String? {
    guard let value else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : String(trimmed.prefix(240))
  }
}
