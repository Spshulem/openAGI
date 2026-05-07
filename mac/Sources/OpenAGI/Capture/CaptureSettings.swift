import Foundation

// Persistent capture settings — written to ~/Library/Application Support/OpenAGI/capture/settings.json.
// Loaded at app start; mutated from the SwiftUI privacy panel and the tray menu.

@MainActor
final class CaptureSettings: ObservableObject {
  static let shared = CaptureSettings()

  @Published var enabled: Bool {
    didSet { persist() }
  }
  @Published var pausedUntil: Date? {
    didSet { persist() }
  }
  @Published var captureIntervalSeconds: Double {
    didSet { persist() }
  }
  @Published var excludedBundleIds: [String] {
    didSet { persist() }
  }
  @Published var excludedWindowPatterns: [String] {
    didSet { persist() }
  }
  @Published var frameRetentionDays: Int {
    didSet { persist() }
  }
  @Published var textRetentionDays: Int {
    didSet { persist() }
  }
  @Published var maxDiskBytes: Int {
    didSet { persist() }
  }

  // Pure file-system path — no main-actor isolation needed.
  nonisolated static var captureDir: URL {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
    let dir = support.appendingPathComponent("OpenAGI/capture", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  private static var settingsPath: URL {
    captureDir.appendingPathComponent("settings.json")
  }

  private init() {
    let defaults: [String: Any] = [
      "enabled": false,                 // off by default — user opts in
      "captureIntervalSeconds": 5.0,
      "excludedBundleIds": [
        "com.1password.1password",
        "com.1password.1password7",
        "com.agilebits.onepassword7",
        "com.agilebits.onepassword4",
        "com.lastpass.LastPass",
        "com.bitwarden.desktop",
        "com.apple.Wallet",
        "com.apple.Passwords"
      ],
      "excludedWindowPatterns": [
        "(?i)private browsing",
        "(?i)incognito",
        "(?i)password",
        "(?i)2FA",
        "(?i)\\b(otp|verification code)\\b"
      ],
      "frameRetentionDays": 7,
      "textRetentionDays": 90,
      "maxDiskBytes": 5 * 1024 * 1024 * 1024  // 5 GB
    ]
    let loaded = (try? JSONSerialization.jsonObject(with: Data(contentsOf: Self.settingsPath)) as? [String: Any]) ?? defaults
    self.enabled = (loaded["enabled"] as? Bool) ?? false
    if let s = loaded["pausedUntil"] as? String, let d = ISO8601DateFormatter().date(from: s) {
      self.pausedUntil = d
    } else {
      self.pausedUntil = nil
    }
    self.captureIntervalSeconds = (loaded["captureIntervalSeconds"] as? Double) ?? 5.0
    self.excludedBundleIds = (loaded["excludedBundleIds"] as? [String]) ?? (defaults["excludedBundleIds"] as? [String]) ?? []
    self.excludedWindowPatterns = (loaded["excludedWindowPatterns"] as? [String]) ?? (defaults["excludedWindowPatterns"] as? [String]) ?? []
    self.frameRetentionDays = (loaded["frameRetentionDays"] as? Int) ?? 7
    self.textRetentionDays = (loaded["textRetentionDays"] as? Int) ?? 90
    self.maxDiskBytes = (loaded["maxDiskBytes"] as? Int) ?? (5 * 1024 * 1024 * 1024)
  }

  func isActiveNow() -> Bool {
    if !enabled { return false }
    if let until = pausedUntil, Date() < until { return false }
    return true
  }

  func isExcluded(bundleId: String?, windowTitle: String?) -> Bool {
    if let bid = bundleId, excludedBundleIds.contains(bid) { return true }
    if let wt = windowTitle {
      for pat in excludedWindowPatterns {
        if (try? NSRegularExpression(pattern: pat))?.firstMatch(in: wt, range: NSRange(location: 0, length: wt.utf16.count)) != nil {
          return true
        }
      }
    }
    return false
  }

  private func persist() {
    var payload: [String: Any] = [
      "enabled": enabled,
      "captureIntervalSeconds": captureIntervalSeconds,
      "excludedBundleIds": excludedBundleIds,
      "excludedWindowPatterns": excludedWindowPatterns,
      "frameRetentionDays": frameRetentionDays,
      "textRetentionDays": textRetentionDays,
      "maxDiskBytes": maxDiskBytes
    ]
    if let until = pausedUntil { payload["pausedUntil"] = ISO8601DateFormatter().string(from: until) }
    let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
    if let data = data { try? data.write(to: Self.settingsPath, options: [.atomic]) }
  }
}
